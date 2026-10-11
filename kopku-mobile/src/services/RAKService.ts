import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { Rupiah } from '@/utils/money';

/**
 * RAK — Rekening Antar Kantor (Phase 18 §3, permintaan pengguna). Menu
 * Transaksi -> Pengeluaran, tepat di atas Investasi. Dana KELUAR dari
 * kas/bank koperasi ke unit/kantor lain, dicatat sebagai ASET
 * (penempatan/piutang antar kantor, akun 1-1800) — BUKAN beban, sama
 * persis pola InvestasiService.catatInvestasi (koperasi tetap punya
 * klaim atas dana yang dikirim). `jenisRak` murni kategorisasi
 * pelaporan — dua-duanya sama-sama DEBIT akun RAK/KREDIT Kas-Bank
 * secara akuntansi (app ini tidak punya master data "kantor/unit" lain
 * untuk membangun buku besar antar-kantor timbal-balik sungguhan).
 */

export type JenisRAK = 'PENYALURAN_DANA' | 'SETORAN_DANA';

/**
 * Update pasca-Phase 18/19 (permintaan pengguna §C.4): jenis RAK yang
 * masih boleh dipilih untuk transaksi BARU — HANYA
 * `PENYALURAN_DANA`. `SETORAN_DANA` DIHAPUS dari pilihan transaksi
 * baru (bukan dari CHECK constraint/database — baris histori lama
 * `SETORAN_DANA` TETAP valid & TETAP terbaca lewat `JenisRAK` di atas,
 * pola yang SAMA PERSIS dengan `InvestasiService.JenisInvestasiInput`
 * vs `JenisInvestasi`, Phase 18 §2).
 */
export type JenisRAKInput = 'PENYALURAN_DANA';

/**
 * Update pasca-update-6-perbaikan (permintaan pengguna §1): label
 * `PENYALURAN_DANA` diganti dari "Penyaluran Dana ke Unit/Kantor"
 * menjadi "Penyaluran Dana ke Unit dan Kantor Cabang" — HANYA teks
 * tampilan yang berubah. Kode/enum internal (`'PENYALURAN_DANA'`)
 * TIDAK berubah sama sekali, jadi histori transaksi lama (yang
 * merujuk kode ini, bukan labelnya) otomatis ikut menampilkan label
 * baru tanpa migration apa pun — konsisten dengan pola app ini
 * (label selalu di-lookup dari kode saat ditampilkan, tidak pernah
 * disimpan sebagai string bebas di baris transaksi).
 */
export const JENIS_RAK_LABEL: Record<JenisRAK, string> = {
  PENYALURAN_DANA: 'Penyaluran Dana ke Unit dan Kantor Cabang',
  SETORAN_DANA: 'Setoran Dana ke Unit/Kantor Pusat',
};

export type JenisAlokasiRAKU = 'MODAL_TETAP' | 'MODAL_TAMBAHAN' | 'OPERASIONAL';

/**
 * RC-S53 Fase 9 (RAKU) — jenis alokasi divalidasi di SERVICE, bukan
 * hanya di dropdown. Dropdown hanya membatasi apa yang mudah dipilih;
 * service yang menentukan apa yang boleh tersimpan.
 */
export const JENIS_ALOKASI_RAKU: readonly JenisAlokasiRAKU[] = [
  'MODAL_TETAP',
  'MODAL_TAMBAHAN',
  'OPERASIONAL',
];

export interface RAKInput {
  jenisRak: JenisRAKInput;
  /**
   * RC-S64: OPSIONAL bila `unitUsahaId` diisi. Untuk transaksi RAKU baru,
   * nama unit TIDAK lagi diketik pengguna — ia DITURUNKAN oleh service dari
   * `koperasi_unit_usaha.nama_usaha`. Field ini dipertahankan agar pemanggil
   * lama (histori teks bebas, tanpa master) tidak putus.
   */
  namaUnit?: string;
  /**
   * Fase 9 — referensi ke master `koperasi_unit_usaha`. OPSIONAL agar
   * pemanggil lama tidak putus; bila diisi, unitnya WAJIB ada dan
   * berstatus AKTIF.
   */
  unitUsahaId?: string;
  /** Fase 9 — jenis alokasi RAKU. Opsional untuk kompatibilitas mundur. */
  jenisAlokasi?: JenisAlokasiRAKU;
  jumlah: Rupiah;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

/** Audit trail RAK (permintaan pengguna §9 — Aktivitas Log): "Tarik Dana RAK" adalah salah satu aktivitas yang WAJIB tercatat. Pola sama dengan RATService/KasBankService.writeAuditLog. */
async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: 'CREATE' | 'UPDATE' | 'REVERSE',
  entityId: string,
  dataSesudah?: Record<string, unknown>
) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'rak_transaksi',
    entityId,
    dataSesudah ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

// ------------------------------------------------------------------
// RC-S54 T14 — KEBIJAKAN #19 (POLICY-A/B/C/D) — SATU SUMBER KELAYAKAN
// ------------------------------------------------------------------
//
// POLICY-A  Tarik Dana RAK = peristiwa baru di periode BERJALAN. Periode
//           transaksi ASAL yang CLOSED tidak menolak (jurnal asal tidak
//           disentuh, periode asal tidak dibuka). Yang menolak hanya
//           periode TANGGAL PEMBALIK (hari ini) yang CLOSED.
// POLICY-B  Tanggal RAK > hari ini ditolak saat catat & edit; Tarik Dana /
//           edit atas RAK asal bertanggal masa depan juga ditolak — jurnal
//           pembalik (selalu bertanggal hari ini) tidak boleh mendahului
//           jurnal asal. `AccountingEngine.reverseJournal` TIDAK diubah.
// POLICY-C  Hanya pembalikan PENUH. Penarikan sebagian = scope terpisah.
// POLICY-D  Status tetap AKTIF/DIBATALKAN. Semantik dibedakan lewat alasan,
//           audit trail, baris pengganti (`reversal_of_id`), dan relasi jurnal.

export type KodeKelayakanTarikDanaRAK =
  | 'BOLEH'
  | 'SUDAH_DIBATALKAN'
  | 'TANPA_JURNAL'
  | 'TANGGAL_MASA_DEPAN'
  | 'PERIODE_PEMBALIK_CLOSED';

export interface KelayakanTarikDanaRAK {
  readonly kode: KodeKelayakanTarikDanaRAK;
  readonly alasan: string | null;
}

/** Pesan tanggal masa depan — satu rumusan untuk catat, edit, dan Tarik Dana. */
function pesanTanggalMasaDepan(tanggal: string, hariIni: string, konteks: string): string {
  return `Tanggal RAK ${tanggal} setelah hari ini (${hariIni}). ${konteks}`;
}

/** POLICY-B: tolak tanggal RAK baru/hasil edit yang melewati hari ini (tanggal lokal). */
function assertTanggalRakTidakMasaDepan(tanggal: string): void {
  const hariIni = getTanggalLokalHariIni();
  if (tanggal > hariIni) {
    throw new Error(pesanTanggalMasaDepan(tanggal, hariIni, 'RAK tidak dapat dicatat bertanggal masa depan.'));
  }
}

/**
 * Status periode akuntansi yang MENAMPUNG tanggal pembalik (hari ini).
 * Read-only: tidak membuat periode. Periode yang belum ada dianggap OPEN
 * — `createJournal` akan membuatnya OPEN saat pembalik dicatat.
 */
export async function getStatusPeriodePembalikRAK(db: SQLite.SQLiteDatabase): Promise<'OPEN' | 'CLOSED'> {
  const r = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period WHERE ? BETWEEN periode_mulai AND periode_selesai
      ORDER BY periode_mulai DESC LIMIT 1`,
    getTanggalLokalHariIni()
  );
  return r?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/**
 * Kelayakan Tarik Dana RAK (dan edit, yang memakai pembalikan yang sama).
 * Fungsi murni — dipakai `batalkanInternal`, `listRAK` (RAKListScreen), dan
 * `HistoryTransaksiService`, sehingga ketiga jalur memberi keputusan identik.
 * Periode ASAL sengaja tidak menjadi masukan (POLICY-A).
 */
export function kelayakanTarikDanaRAK(
  row: { status: string; journalId: string | null; tanggal: string; nomorRak: string },
  hariIni: string,
  statusPeriodePembalik: 'OPEN' | 'CLOSED'
): KelayakanTarikDanaRAK {
  if (row.status === 'DIBATALKAN') {
    return { kode: 'SUDAH_DIBATALKAN', alasan: 'Transaksi RAK ini sudah dibatalkan.' };
  }
  if (!row.journalId) {
    return { kode: 'TANPA_JURNAL', alasan: 'Transaksi RAK ini tidak mempunyai jurnal terkait.' };
  }
  if (hariIni < row.tanggal) {
    return {
      kode: 'TANGGAL_MASA_DEPAN',
      alasan: pesanTanggalMasaDepan(
        row.tanggal,
        hariIni,
        `Tarik Dana RAK/koreksi atas ${row.nomorRak} baru dapat dilakukan mulai tanggal transaksi asal, agar jurnal pembalik tidak mendahului jurnal asal.`
      ),
    };
  }
  if (statusPeriodePembalik === 'CLOSED') {
    return {
      kode: 'PERIODE_PEMBALIK_CLOSED',
      alasan: `Periode akuntansi tanggal pembalik (hari ini, ${hariIni}) sudah ditutup (CLOSED). Tarik Dana RAK tidak dapat dicatat.`,
    };
  }
  return { kode: 'BOLEH', alasan: null };
}

async function validasiInput(input: Pick<RAKInput, 'namaUnit' | 'jumlah' | 'jenisRak' | 'unitUsahaId'>) {
  // RC-S64: identitas unit boleh datang dari salah satu dari dua jalur —
  // `unitUsahaId` (jalur baru, satu-satunya yang dipakai form) atau
  // `namaUnit` teks bebas (jalur lama, dipertahankan untuk kompatibilitas).
  // Yang dilarang adalah keduanya kosong.
  if (!input.unitUsahaId && !(input.namaUnit ?? '').trim()) {
    // Pesan sengaja tetap menyebut "nama unit": jalur teks bebas lama masih
    // sah bila tidak ada `unitUsahaId`, dan kontrak pesan itu sudah dikunci
    // test RAKService yang ada. RC-S64 hanya menambahkan jalur master.
    throw new Error('Unit usaha tujuan wajib dipilih, atau nama unit/kantor tujuan wajib diisi.');
  }
  if (!Number.isFinite(input.jumlah) || input.jumlah <= 0) {
    throw new Error('Nominal RAK harus lebih dari 0.');
  }
  // §C.4: pertahanan berlapis — kalaupun 'SETORAN_DANA' entah
  // bagaimana terkirim (lewat any/bypass UI), tetap ditolak di sini,
  // bukan cuma disembunyikan dari picker.
  if ((input.jenisRak as string) === 'SETORAN_DANA') {
    throw new Error('Jenis RAK "Setoran Dana ke Unit/Kantor Pusat" sudah tidak dapat dipilih untuk transaksi baru. Gunakan "Penyaluran Dana ke Unit dan Kantor Cabang".');
  }
}

/**
 * VALIDASI RAKU DI SERVICE (Fase 9).
 *
 * Dropdown UI hanya membatasi apa yang mudah dipilih; yang menentukan apa
 * yang boleh TERSIMPAN adalah pemeriksaan di sini. RC-S54 T13 (#19):
 * dipindah ke helper agar `editRAK` memakai validasi yang SAMA — sebelumnya
 * edit melewati validasi ini sekaligus membuang kedua kolom RAKU.
 */
async function validasiRaku(
  db: SQLite.SQLiteDatabase,
  input: Pick<RAKInput, 'unitUsahaId' | 'jenisAlokasi'>,
  opsi: { excludeRakId?: string } = {}
): Promise<{ nama_usaha: string } | null> {
  if (input.jenisAlokasi !== undefined && !JENIS_ALOKASI_RAKU.includes(input.jenisAlokasi)) {
    throw new Error(`Jenis alokasi RAKU tidak dikenali: ${String(input.jenisAlokasi)}.`);
  }
  if (input.unitUsahaId === undefined) return null;

  const unit = await db.getFirstAsync<{ id: string; status: string; nama_usaha: string }>(
    `SELECT id, status, nama_usaha FROM koperasi_unit_usaha WHERE id = ?`,
    input.unitUsahaId
  );
  if (!unit) throw new Error('Unit usaha tidak ditemukan.');
  if (unit.status !== 'AKTIF') {
    // Histori RAKU yang menunjuk unit nonaktif TETAP terbaca; yang
    // ditolak hanya transaksi BARU ke unit yang sudah ditutup.
    throw new Error(`Unit usaha "${unit.nama_usaha}" berstatus NONAKTIF dan tidak dapat menerima alokasi baru.`);
  }

  await assertModalTetapBelumAda(db, {
    unitUsahaId: input.unitUsahaId,
    jenisAlokasi: input.jenisAlokasi,
    namaUnit: unit.nama_usaha,
    excludeRakId: opsi.excludeRakId,
  });

  return unit;
}

/**
 * ============================================================
 * RC-S64 — INVARIAN: SATU MODAL TETAP AKTIF PER UNIT USAHA
 * ============================================================
 *
 * Modal Tetap adalah penyertaan modal awal koperasi ke sebuah unit usaha.
 * Secara konsep ia terjadi SEKALI; penambahan berikutnya adalah MODAL
 * TAMBAHAN, dan biaya jalan adalah OPERASIONAL. Karena itu hanya
 * MODAL_TETAP yang dibatasi di sini — dua jenis lainnya TIDAK disentuh.
 *
 * KENAPA DI SERVICE, BUKAN HANYA DI UI. Form hanya membatasi apa yang
 * mudah dipilih. Yang menentukan apa yang boleh TERSIMPAN adalah
 * pemeriksaan ini, dan ia berjalan di dalam transaksi yang sama dengan
 * INSERT-nya — jadi dipanggil langsung dari service pun tetap terjaga.
 *
 * YANG DIHITUNG SEBAGAI "SUDAH ADA" (§6 dan §8):
 *   - hanya baris ber-`status = 'AKTIF'`. Baris `DIBATALKAN` TIDAK
 *     mengunci slot — termasuk baris lama yang dibatalkan oleh mekanisme
 *     reversal/edit yang sudah ada. Historinya tetap utuh, tidak dihapus.
 *   - `excludeRakId` mengeluarkan transaksi yang SEDANG diedit dari
 *     perhitungan. Tanpa ini, edit nominal Modal Tetap milik unit yang
 *     sama akan menuduh transaksi itu menduplikasi dirinya sendiri.
 *     Catatan urutan: `editRAK` memanggil validasi SEBELUM
 *     `batalkanInternal`, jadi baris lama memang masih AKTIF saat
 *     diperiksa — pengecualian ini wajib, bukan kenyamanan.
 */
export async function assertModalTetapBelumAda(
  db: SQLite.SQLiteDatabase,
  params: {
    unitUsahaId: string | null | undefined;
    jenisAlokasi: JenisAlokasiRAKU | undefined;
    namaUnit?: string;
    excludeRakId?: string;
  }
): Promise<void> {
  if (params.jenisAlokasi !== 'MODAL_TETAP') return;
  if (!params.unitUsahaId) return;

  const existing = await db.getFirstAsync<{ id: string; nomor_rak: string; jumlah: number }>(
    `SELECT id, nomor_rak, jumlah FROM rak_transaksi
      WHERE unit_usaha_id = ?
        AND jenis_alokasi = 'MODAL_TETAP'
        AND status = 'AKTIF'
        AND (? IS NULL OR id <> ?)
      ORDER BY tanggal ASC, id ASC
      LIMIT 1`,
    params.unitUsahaId,
    params.excludeRakId ?? null,
    params.excludeRakId ?? null
  );
  if (!existing) return;

  const nama = params.namaUnit ?? 'unit usaha ini';
  throw new Error(
    `Modal Tetap untuk Unit Usaha "${nama}" sudah pernah dialokasikan (${existing.nomor_rak}, ` +
      `${formatRupiahPesan(existing.jumlah)}). Satu Unit Usaha hanya dapat memiliki satu input Modal Tetap aktif. ` +
      `Gunakan Modal Tambahan bila diperlukan alokasi tambahan.`
  );
}

function formatRupiahPesan(n: number): string {
  return `Rp${n.toLocaleString('id-ID')}`;
}

/**
 * RC-S64 — status Modal Tetap sebuah unit, untuk ditampilkan di form
 * SEBELUM pengguna menekan simpan. Read-only; bukan penjaga kebenaran
 * (penjaganya `assertModalTetapBelumAda` di dalam transaksi).
 */
export async function getStatusModalTetapUnit(
  unitUsahaId: string
): Promise<{ sudahAda: boolean; jumlah: Rupiah | null; nomorRak: string | null }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ nomor_rak: string; jumlah: number }>(
    `SELECT nomor_rak, jumlah FROM rak_transaksi
      WHERE unit_usaha_id = ? AND jenis_alokasi = 'MODAL_TETAP' AND status = 'AKTIF'
      ORDER BY tanggal ASC, id ASC LIMIT 1`,
    unitUsahaId
  );
  return row
    ? { sudahAda: true, jumlah: row.jumlah, nomorRak: row.nomor_rak }
    : { sudahAda: false, jumlah: null, nomorRak: null };
}

/** Catat RAK baru: DEBIT Rekening Antar Kantor (1-1800), KREDIT Kas/Bank. */
export async function catatRAK(input: RAKInput): Promise<{ id: string; nomorRak: string; journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'rak', 'create');
    await validasiInput(input);
    assertTanggalRakTidakMasaDepan(input.tanggal);

    const unitMaster = await validasiRaku(db, input);
    /*
     * RC-S64 §10 — NAMA UNIT DITURUNKAN, BUKAN DIPERCAYA.
     * Bila `unitUsahaId` diisi, `nama_unit` diambil dari
     * `koperasi_unit_usaha.nama_usaha`, apa pun yang dikirim pemanggil.
     * Itu membuat kombinasi mustahil seperti (unit_usaha_id = A,
     * nama_unit = "Unit B") tidak dapat tersimpan — termasuk ketika
     * service dipanggil langsung tanpa melewati form.
     * Tanpa `unitUsahaId`, jalur teks bebas lama tetap berlaku.
     */
    const namaUnitTersimpan = unitMaster ? unitMaster.nama_usaha : (input.namaUnit ?? '').trim();

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.jumlah,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const rakAccountId = await resolveAccountId(db, 'RAK', 'DEBIT_ASET');

    const year = new Date(input.tanggal).getFullYear();
    const nomorRak = await nextSequence(db, 'RAK', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'RAK',
      nomorReferensi: nomorRak,
      deskripsi: input.keterangan || `RAK - ${JENIS_RAK_LABEL[input.jenisRak]} ke ${namaUnitTersimpan} - ${nomorRak}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: rakAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO rak_transaksi
        (id, nomor_rak, jenis_rak, nama_unit, unit_usaha_id, jenis_alokasi, jumlah, tanggal,
         sumber_dana, bank_account_id,
         keterangan, status, journal_id, reversal_of_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      nomorRak,
      input.jenisRak,
      namaUnitTersimpan,
      input.unitUsahaId ?? null,
      input.jenisAlokasi ?? null,
      input.jumlah,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      input.keterangan ?? null,
      'AKTIF',
      journalId,
      null,
      input.createdBy,
      now,
      now
    );

    await writeAuditLog(db, input.createdBy, 'CREATE', id, { nomorRak, namaUnit: namaUnitTersimpan, jumlah: input.jumlah });

    return { id, nomorRak, journalId };
  });
}

export interface RAKListItem {
  id: string;
  nomorRak: string;
  jenisRak: JenisRAK;
  namaUnit: string;
  jumlah: Rupiah;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
  keterangan: string | null;
  status: 'AKTIF' | 'DIBATALKAN';
  journalId: string | null;
  reversalOfId: string | null;
  createdAt: string;
  /** RC-S54 T13: kolom RAKU (v62) — sebelumnya tidak dibaca, sehingga layar edit tidak dapat mempertahankannya. */
  unitUsahaId: string | null;
  jenisAlokasi: JenisAlokasiRAKU | null;
  /** RC-S54 T13: jurnal pembalik (dari `journal.reversed_by_id`), null bila belum ditarik. */
  reversalJournalId: string | null;
  /** RC-S54 T13: alasan Tarik Dana RAK dari audit trail — `keterangan` asal tidak lagi ditimpa. */
  alasanTarikDana: string | null;
  /** RC-S54 T14: kelayakan Tarik Dana/edit — keputusan yang sama dengan service & History. */
  tarikDana: KelayakanTarikDanaRAK;
  /**
   * RC-S54 T14 — POLICY-D: semantik baris DIBATALKAN tanpa status baru.
   * `KOREKSI_EDIT` bila ada baris pengganti (`reversal_of_id` menunjuk baris
   * ini), selain itu `TARIK_DANA`; null untuk baris AKTIF.
   */
  jenisPenutupan: 'TARIK_DANA' | 'KOREKSI_EDIT' | null;
  digantikanOlehId: string | null;
}

function rowToItem(r: any, statusPeriodePembalik: 'OPEN' | 'CLOSED', hariIni: string): RAKListItem {
  return {
    id: r.id,
    nomorRak: r.nomor_rak,
    jenisRak: r.jenis_rak,
    namaUnit: r.nama_unit,
    jumlah: r.jumlah,
    tanggal: r.tanggal,
    sumberDana: r.sumber_dana,
    bankAccountId: r.bank_account_id,
    keterangan: r.keterangan,
    status: r.status,
    journalId: r.journal_id,
    reversalOfId: r.reversal_of_id,
    createdAt: r.created_at,
    unitUsahaId: r.unit_usaha_id ?? null,
    jenisAlokasi: r.jenis_alokasi ?? null,
    reversalJournalId: r.reversal_journal_id ?? null,
    alasanTarikDana: alasanDariAudit(r.audit_reverse ?? null),
    jenisPenutupan: r.status !== 'DIBATALKAN' ? null : r.pengganti_id ? 'KOREKSI_EDIT' : 'TARIK_DANA',
    digantikanOlehId: r.pengganti_id ?? null,
    tarikDana: kelayakanTarikDanaRAK(
      { status: r.status, journalId: r.journal_id, tanggal: r.tanggal, nomorRak: r.nomor_rak },
      hariIni,
      statusPeriodePembalik
    ),
  };
}

function alasanDariAudit(json: string | null): string | null {
  if (!json) return null;
  try {
    const v = (JSON.parse(json) as { alasan?: unknown }).alasan;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Baris RAK + jurnal pembalik + alasan Tarik Dana terakhir (read-only join). */
const SQL_RAK = `SELECT r.*,
       j.reversed_by_id AS reversal_journal_id,
       (SELECT x.id FROM rak_transaksi x WHERE x.reversal_of_id = r.id ORDER BY x.created_at LIMIT 1) AS pengganti_id,
       (SELECT a.data_sesudah FROM audit_log a
          WHERE a.entity = 'rak_transaksi' AND a.entity_id = r.id AND a.action = 'REVERSE'
          ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS audit_reverse
  FROM rak_transaksi r
  LEFT JOIN journal j ON j.id = r.journal_id`;

/** Daftar RAK (riwayat & export), diurutkan terbaru dulu. */
export async function listRAK(): Promise<RAKListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`${SQL_RAK} ORDER BY r.tanggal DESC, r.created_at DESC`);
  const periode = await getStatusPeriodePembalikRAK(db);
  const hariIni = getTanggalLokalHariIni();
  return rows.map((r) => rowToItem(r, periode, hariIni));
}

/** Detail satu RAK. */
export async function getRAKDetail(id: string): Promise<RAKListItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`${SQL_RAK} WHERE r.id = ?`, id);
  return row ? rowToItem(row, await getStatusPeriodePembalikRAK(db), getTanggalLokalHariIni()) : null;
}

async function batalkanInternal(
  db: SQLite.SQLiteDatabase,
  id: string,
  userId: string,
  alasan: string
): Promise<RAKListItem> {
  const original = await db.getFirstAsync<any>(`SELECT * FROM rak_transaksi WHERE id = ?`, id);
  if (!original) throw new Error('Transaksi RAK tidak ditemukan.');

  // RC-S54 T14: satu keputusan kelayakan (POLICY-A/B) — sama dengan RAKList &
  // History. Seluruh penolakan terjadi SEBELUM penulisan apa pun.
  const hariIni = getTanggalLokalHariIni();
  const kelayakan = kelayakanTarikDanaRAK(
    { status: original.status, journalId: original.journal_id, tanggal: original.tanggal, nomorRak: original.nomor_rak },
    hariIni,
    await getStatusPeriodePembalikRAK(db)
  );
  if (kelayakan.kode !== 'BOLEH') throw new Error(kelayakan.alasan ?? 'Tarik Dana RAK tidak diizinkan.');

  // RAK yang sudah menerima Pengembalian RAKU (jurnal asli
  // POSTED — bukan jurnal pembalik — ber-sumber_id RAK ini) tidak boleh dibalik penuh / diedit: pembalik
  // penuh akan mengkredit 1-1800 melebihi saldonya (saldo negatif, kas
  // terhitung dua kali). Batalkan pengembalian terlebih dahulu.
  const pengembalian = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal
      WHERE sumber_id = ? AND status = 'POSTED' AND reversal_of_id IS NULL
        AND sumber_transaksi IN ('RAK_PENGEMBALIAN_KAS','RAK_PENGEMBALIAN_BANK')`,
    id
  );
  if ((pengembalian?.n ?? 0) > 0) {
    throw new Error(
      `RAK ${original.nomor_rak} sudah memiliki pengembalian dari unit usaha. Batalkan pengembalian tersebut terlebih dahulu.`
    );
  }

  // POLICY-A: jurnal pembalik masuk periode HARI INI (`reverseJournal`).
  // Periode ASAL yang CLOSED tidak dibuka dan tidak ditulis; `createJournal`
  // tetap menjadi penjaga terakhir bila periode hari ini CLOSED.
  const { journalId: reversalJournalId } = await reverseJournal(db, original.journal_id, userId, alasan);

  // `keterangan` asal TIDAK ditimpa (RC-S54 T13): alasan tersimpan di
  // audit trail dan di deskripsi jurnal pembalik.
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE rak_transaksi SET status = 'DIBATALKAN', updated_at = ? WHERE id = ? AND status = 'AKTIF'`,
    now,
    id
  );

  // Permintaan pengguna §3/§9: aksi ini SEKARANG bernama "Tarik Dana
  // RAK" di UI (HistoryTransaksiDetailScreen/RAKListScreen) — dicatat
  // di Aktivitas Log dengan action 'REVERSE' (konsisten dengan pola
  // reversal transaksi lain), bukan action baru "TARIK_DANA_RAK",
  // supaya AKSI_LABEL di AuditLogService tetap satu kosakata konsisten
  // untuk semua jenis reversal transaksi di seluruh app.
  await writeAuditLog(db, userId, 'REVERSE', id, {
    alasan,
    nomorRak: original.nomor_rak,
    jumlah: original.jumlah,
    statusSebelum: original.status,
    statusSesudah: 'DIBATALKAN',
    journalAsalId: original.journal_id,
    reversalJournalId,
    tanggalReversal: hariIni,
    keteranganAsal: original.keterangan ?? null,
  });
  const updated = await db.getFirstAsync<any>(`${SQL_RAK} WHERE r.id = ?`, id);
  return rowToItem(updated, await getStatusPeriodePembalikRAK(db), hariIni);
}

/**
 * Batalkan/hapus RAK (§10 — "jangan DELETE mentah untuk transaksi yang
 * sudah menghasilkan jurnal"): reversal jurnal + status DIBATALKAN,
 * baris asli TETAP ADA untuk audit trail (bukan dihapus fisik).
 */
export async function batalkanRAK(id: string, userId: string, alasan: string): Promise<RAKListItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'rak', 'edit');
    if (!alasan.trim()) throw new Error('Alasan pembatalan wajib diisi.');
    return batalkanInternal(db, id, userId, alasan);
  });
}

/**
 * Edit RAK yang masih AKTIF (§9 — "koreksi lewat mekanisme aman, bukan
 * UPDATE jurnal lama sembarangan"): jurnal & baris LAMA dibatalkan
 * (reversal, tetap tersimpan untuk audit), lalu baris & jurnal BARU
 * dibuat dari data hasil edit — ditaut lewat `reversalOfId` supaya
 * riwayat tetap bisa ditelusuri dari versi lama ke versi baru.
 */
export async function editRAK(id: string, userId: string, input: Omit<RAKInput, 'createdBy'>): Promise<{ id: string; nomorRak: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'rak', 'edit');
    await validasiInput(input);
    assertTanggalRakTidakMasaDepan(input.tanggal);
    // RC-S64 §7 — transaksi yang SEDANG diedit dikecualikan dari invarian
    // Modal Tetap. Urutannya penting: validasi berjalan sebelum
    // `batalkanInternal`, jadi baris lama masih AKTIF di sini.
    const unitMaster = await validasiRaku(db, input, { excludeRakId: id });
    const namaUnitTersimpan = unitMaster ? unitMaster.nama_usaha : (input.namaUnit ?? '').trim();

    await batalkanInternal(db, id, userId, `Dikoreksi (diedit) - digantikan oleh transaksi RAK baru.`);

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.jumlah,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const rakAccountId = await resolveAccountId(db, 'RAK', 'DEBIT_ASET');
    const year = new Date(input.tanggal).getFullYear();
    const nomorRak = await nextSequence(db, 'RAK', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'RAK',
      nomorReferensi: nomorRak,
      deskripsi: input.keterangan || `RAK - ${JENIS_RAK_LABEL[input.jenisRak]} ke ${namaUnitTersimpan} (koreksi) - ${nomorRak}`,
      createdBy: userId,
      lines: [
        { accountId: rakAccountId, debit: input.jumlah, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.jumlah },
      ],
    });

    const newRowId = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO rak_transaksi
        (id, nomor_rak, jenis_rak, nama_unit, unit_usaha_id, jenis_alokasi, jumlah, tanggal, sumber_dana, bank_account_id,
         keterangan, status, journal_id, reversal_of_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newRowId,
      nomorRak,
      input.jenisRak,
      namaUnitTersimpan,
      // RC-S54 T13: kolom RAKU ikut tersimpan pada baris hasil edit.
      input.unitUsahaId ?? null,
      input.jenisAlokasi ?? null,
      input.jumlah,
      input.tanggal,
      input.sumberDana,
      input.bankAccountId ?? null,
      input.keterangan ?? null,
      'AKTIF',
      journalId,
      id,
      userId,
      now,
      now
    );

    await writeAuditLog(db, userId, 'UPDATE', newRowId, { nomorRak, namaUnit: namaUnitTersimpan, jumlah: input.jumlah, reversalOfId: id });

    return { id: newRowId, nomorRak };
  });
}
