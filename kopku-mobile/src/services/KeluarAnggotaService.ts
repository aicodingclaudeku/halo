import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * ============================================================
 * KELUAR ANGGOTA — ALUR PERSETUJUAN (Fase 8)
 * ============================================================
 *
 * HUBUNGANNYA DENGAN `SimpananService.keluarAnggota()` YANG LAMA.
 * Alur lama membayar SEKETIKA: begitu dipanggil, seluruh simpanan
 * dikembalikan dan status anggota langsung KELUAR — tanpa pengajuan,
 * tanpa persetujuan, tanpa memperhitungkan pinjaman yang masih
 * berjalan. Alur itu TIDAK diubah dan TIDAK dihapus; ia tetap sah untuk
 * koperasi yang memang tidak memakai persetujuan.
 *
 * KEDUANYA TIDAK DAPAT MEMBAYAR DUA KALI, dan itu bukan kebetulan:
 * keduanya menolak anggota yang statusnya sudah KELUAR. Siapa pun yang
 * berjalan lebih dulu menutup pintu bagi yang lain. Ditambah indeks unik
 * parsial `uq_keluar_anggota_hidup`, satu anggota hanya bisa punya satu
 * pengajuan hidup.
 *
 * SNAPSHOT SALDO. Seluruh angka dihitung dari data aktual SAAT
 * PENGAJUAN dibuat, lalu disimpan. Pembayaran memverifikasi ulang bahwa
 * angkanya belum berubah — kalau berubah, pembayaran DITOLAK dan
 * pengajuan harus disegarkan. Membayar angka yang berbeda dari yang
 * disetujui pengurus adalah hal yang tidak boleh terjadi diam-diam.
 */

export type AlasanKeluar = 'MENGUNDURKAN_DIRI' | 'DIBERHENTIKAN' | 'MENINGGAL' | 'LAINNYA';
export type StatusPengajuanKeluar = 'DIAJUKAN' | 'DISETUJUI' | 'DIBAYAR' | 'DITOLAK';

export const ALASAN_KELUAR: readonly AlasanKeluar[] = [
  'MENGUNDURKAN_DIRI',
  'DIBERHENTIKAN',
  'MENINGGAL',
  'LAINNYA',
];

export interface PerhitunganKeluarAnggota {
  readonly saldoSimpananPokok: Rupiah;
  readonly saldoSimpananWajib: Rupiah;
  readonly saldoSimpananSukarela: Rupiah;
  readonly shuHakAnggota: Rupiah;
  readonly totalHak: Rupiah;
  readonly saldoPinjaman: Rupiah;
  readonly kewajibanLain: Rupiah;
  readonly totalPengurang: Rupiah;
  readonly nilaiPengembalian: Rupiah;
  /** `true` bila pengurang menghabiskan seluruh hak. */
  readonly tidakAdaPengembalian: boolean;
}

export interface KeluarAnggotaRow extends PerhitunganKeluarAnggota {
  readonly id: string;
  readonly anggotaId: string;
  readonly namaAnggota: string;
  readonly alasanKeluar: AlasanKeluar;
  readonly tanggalPengajuan: string;
  readonly tanggalEfektifKeluar: string;
  readonly statusPengajuan: StatusPengajuanKeluar;
  readonly sumberPembayaran: 'KAS' | 'BANK' | null;
  readonly diajukanOleh: string;
  readonly disetujuiOleh: string | null;
  readonly tanggalPersetujuan: string | null;
  readonly tanggalPembayaran: string | null;
  readonly journalId: string | null;
  readonly keterangan: string | null;
}

function saldoSimpanan(db: SQLite.SQLiteDatabase, anggotaId: string, jenis: string) {
  // Pembalik (KOREKSI/reversal) dikeluarkan dengan pola yang sama
  // dipakai ShuService: baris yang sudah dibalik tidak ikut dihitung.
  return db
    .getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(CASE WHEN tipe = 'SETOR' THEN nominal
                                WHEN tipe = 'TARIK' THEN -nominal
                                ELSE 0 END), 0) s
         FROM simpanan_transaksi
        WHERE anggota_id = ? AND jenis = ?
          AND id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)`,
      anggotaId,
      jenis
    )
    .then((r) => r?.s ?? 0);
}

/**
 * SHU YANG SUDAH MENJADI HAK TETAPI BELUM MASUK SALDO.
 *
 * Ini titik paling mudah salah di seluruh fitur ini. Pembagian SHU
 * (`ShuService`) MEMBUAT baris `simpanan_transaksi` SETOR SUKARELA per
 * anggota — artinya SHU yang sudah berstatus DIBAGIKAN SUDAH TERHITUNG
 * di dalam saldo simpanan sukarela. Menambahkannya lagi di sini akan
 * membayar anggota dua kali.
 *
 * Yang benar-benar merupakan hak namun BELUM ada di saldo adalah SHU
 * yang sudah DISAHKAN_RAT tetapi belum dibagikan. Hanya itu yang
 * dihitung. SHU berstatus DRAFT/DIHITUNG/DIAJUKAN_RAT belum menjadi hak
 * siapa pun dan sengaja tidak ikut.
 */
async function shuHakBelumDibagikan(
  db: SQLite.SQLiteDatabase,
  anggotaId: string
): Promise<Rupiah> {
  const r = await db.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(sa.total_shu_anggota), 0) s
       FROM shu_anggota sa
       JOIN shu_konfigurasi sk ON sk.id = sa.shu_konfigurasi_id
      WHERE sa.anggota_id = ? AND sk.status = 'DISAHKAN_RAT'`,
    anggotaId
  );
  return r?.s ?? 0;
}

/**
 * Outstanding pinjaman — SISA POKOK yang belum terbayar, bukan pokok
 * kontrak dan bukan total pembayaran historis.
 */
async function outstandingPinjaman(
  db: SQLite.SQLiteDatabase,
  anggotaId: string
): Promise<Rupiah> {
  const r = await db.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(j.pokok - j.pokok_terbayar), 0) s
       FROM angsuran_jadwal j
       JOIN pinjaman p ON p.id = j.pinjaman_id
      WHERE p.anggota_id = ? AND p.status IN ('AKTIF','MACET')`,
    anggotaId
  );
  const sisa = r?.s ?? 0;
  return sisa > 0 ? sisa : 0;
}

/**
 * Hitung seluruh angka dari DATA AKTUAL. Tidak ada satu pun nominal
 * yang boleh diketik pengguna.
 */
export async function hitungPerhitunganKeluar(
  db: SQLite.SQLiteDatabase,
  anggotaId: string
): Promise<PerhitunganKeluarAnggota> {
  const [pokok, wajib, sukarela] = await Promise.all([
    saldoSimpanan(db, anggotaId, 'POKOK'),
    saldoSimpanan(db, anggotaId, 'WAJIB'),
    saldoSimpanan(db, anggotaId, 'SUKARELA'),
  ]);
  const shu = await shuHakBelumDibagikan(db, anggotaId);
  const pinjaman = await outstandingPinjaman(db, anggotaId);

  // `kewajiban_lain` sengaja 0: tidak ada satu pun tabel di skema ini
  // yang mencatat kewajiban anggota di luar pinjaman. Mengarang
  // sumbernya akan menghasilkan pengurang yang tidak dapat ditelusuri.
  const kewajibanLain = 0;

  const totalHak = pokok + wajib + sukarela + shu;
  const totalPengurang = pinjaman + kewajibanLain;
  const pengembalian = totalHak - totalPengurang;

  return {
    saldoSimpananPokok: pokok,
    saldoSimpananWajib: wajib,
    saldoSimpananSukarela: sukarela,
    shuHakAnggota: shu,
    totalHak,
    saldoPinjaman: pinjaman,
    kewajibanLain,
    totalPengurang,
    // Tidak pernah negatif. Bila pengurang melebihi hak, pengembaliannya
    // nol dan sisa utangnya TETAP tercatat sebagai piutang — bukan
    // dihapus diam-diam lewat angka negatif.
    nilaiPengembalian: pengembalian > 0 ? pengembalian : 0,
    tidakAdaPengembalian: pengembalian <= 0,
  };
}

function petakan(r: Record<string, unknown>): KeluarAnggotaRow {
  const n = (k: string): number => (r[k] as number) ?? 0;
  return {
    id: r.id as string,
    anggotaId: r.anggota_id as string,
    namaAnggota: (r.nama_anggota as string) ?? '',
    alasanKeluar: r.alasan_keluar as AlasanKeluar,
    tanggalPengajuan: r.tanggal_pengajuan as string,
    tanggalEfektifKeluar: r.tanggal_efektif_keluar as string,
    saldoSimpananPokok: n('saldo_simpanan_pokok'),
    saldoSimpananWajib: n('saldo_simpanan_wajib'),
    saldoSimpananSukarela: n('saldo_simpanan_sukarela'),
    shuHakAnggota: n('shu_hak_anggota'),
    totalHak: n('total_hak'),
    saldoPinjaman: n('saldo_pinjaman'),
    kewajibanLain: n('kewajiban_lain'),
    totalPengurang: n('total_pengurang'),
    nilaiPengembalian: n('nilai_pengembalian'),
    tidakAdaPengembalian: n('nilai_pengembalian') === 0,
    statusPengajuan: r.status_pengajuan as StatusPengajuanKeluar,
    sumberPembayaran: (r.sumber_pembayaran as 'KAS' | 'BANK' | null) ?? null,
    diajukanOleh: r.diajukan_oleh as string,
    disetujuiOleh: (r.disetujui_oleh as string | null) ?? null,
    tanggalPersetujuan: (r.tanggal_persetujuan as string | null) ?? null,
    tanggalPembayaran: (r.tanggal_pembayaran as string | null) ?? null,
    journalId: (r.journal_id as string | null) ?? null,
    keterangan: (r.keterangan as string | null) ?? null,
  };
}

async function ambil(db: SQLite.SQLiteDatabase, id: string): Promise<KeluarAnggotaRow> {
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT k.*, a.nama_lengkap AS nama_anggota FROM keluar_anggota k
       JOIN anggota a ON a.id = k.anggota_id WHERE k.id = ?`,
    id
  );
  if (!r) throw new Error('Pengajuan keluar anggota tidak ditemukan.');
  return petakan(r);
}

// ===========================================================================
// PENGAJUAN
// ===========================================================================

export interface AjukanKeluarInput {
  anggotaId: string;
  alasanKeluar: AlasanKeluar;
  tanggalPengajuan: string;
  tanggalEfektifKeluar: string;
  keterangan?: string;
  createdBy: string;
}

export async function ajukanKeluarAnggota(input: AjukanKeluarInput): Promise<KeluarAnggotaRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'anggota', 'edit');

    const anggota = await db.getFirstAsync<{ nama_lengkap: string; status: string }>(
      `SELECT nama_lengkap, status FROM anggota WHERE id = ?`,
      input.anggotaId
    );
    if (!anggota) throw new Error('Anggota tidak ditemukan.');
    if (anggota.status === 'KELUAR') throw new Error('Anggota ini sudah berstatus Keluar.');

    if (input.tanggalEfektifKeluar < input.tanggalPengajuan) {
      throw new Error('Tanggal efektif keluar tidak boleh mendahului tanggal pengajuan.');
    }

    const hidup = await db.getFirstAsync<{ id: string; status_pengajuan: string }>(
      `SELECT id, status_pengajuan FROM keluar_anggota
        WHERE anggota_id = ? AND status_pengajuan IN ('DIAJUKAN','DISETUJUI','DIBAYAR')`,
      input.anggotaId
    );
    if (hidup) {
      throw new Error(
        `Anggota ini sudah memiliki pengajuan keluar berstatus ${hidup.status_pengajuan}.`
      );
    }

    const hitung = await hitungPerhitunganKeluar(db, input.anggotaId);
    const tahun = parseInt(input.tanggalPengajuan.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'KLA', tahun);
    const id = `kla-${nomor}`;
    const now = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO keluar_anggota
        (id, anggota_id, alasan_keluar, tanggal_pengajuan, tanggal_efektif_keluar,
         saldo_simpanan_pokok, saldo_simpanan_wajib, saldo_simpanan_sukarela, shu_hak_anggota,
         total_hak, saldo_pinjaman, kewajiban_lain, total_pengurang, nilai_pengembalian,
         status_pengajuan, diajukan_oleh, keterangan, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DIAJUKAN',?,?,?,?)`,
      id,
      input.anggotaId,
      input.alasanKeluar,
      input.tanggalPengajuan,
      input.tanggalEfektifKeluar,
      hitung.saldoSimpananPokok,
      hitung.saldoSimpananWajib,
      hitung.saldoSimpananSukarela,
      hitung.shuHakAnggota,
      hitung.totalHak,
      hitung.saldoPinjaman,
      hitung.kewajibanLain,
      hitung.totalPengurang,
      hitung.nilaiPengembalian,
      input.createdBy,
      input.keterangan ?? null,
      now,
      now
    );

    return ambil(db, id);
  });
}

// ===========================================================================
// PERSETUJUAN / PENOLAKAN
// ===========================================================================

export async function setujuiKeluarAnggota(
  id: string,
  disetujuiOleh: string,
  tanggal: string
): Promise<KeluarAnggotaRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, disetujuiOleh, 'anggota', 'approve');
    const row = await ambil(db, id);
    if (row.statusPengajuan !== 'DIAJUKAN') {
      throw new Error(`Hanya pengajuan berstatus DIAJUKAN yang dapat disetujui (saat ini ${row.statusPengajuan}).`);
    }
    await db.runAsync(
      `UPDATE keluar_anggota SET status_pengajuan = 'DISETUJUI', disetujui_oleh = ?,
              tanggal_persetujuan = ?, updated_at = ? WHERE id = ?`,
      disetujuiOleh,
      tanggal,
      new Date().toISOString(),
      id
    );
    return ambil(db, id);
  });
}

export async function tolakKeluarAnggota(
  id: string,
  ditolakOleh: string,
  alasan?: string
): Promise<KeluarAnggotaRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, ditolakOleh, 'anggota', 'approve');
    const row = await ambil(db, id);
    if (row.statusPengajuan === 'DIBAYAR') {
      throw new Error('Pengajuan yang sudah dibayar tidak dapat ditolak.');
    }
    // RC-S76 — KEPUTUSAN KEBIJAKAN: persetujuan bersifat FINAL.
    //
    // Sebelumnya hanya DIBAYAR yang diblokir, sehingga pengajuan yang
    // SUDAH DISETUJUI masih dapat ditolak. Itu membuat DISETUJUI bukan
    // titik keputusan melainkan keadaan sementara: seseorang dapat
    // membatalkan persetujuan orang lain tanpa jejak selain berubahnya
    // satu kolom status, sementara UI sejak RC-S75 sudah menyebut
    // DISETUJUI sebagai "Siap Dibayar".
    //
    // Sekarang penolakan hanya sah SEBELUM persetujuan. Pembatalan
    // persetujuan sengaja TIDAK disediakan lewat state DITOLAK dan
    // TIDAK diganti state baru — keduanya akan mengubah arti data
    // historis yang sudah tersimpan.
    if (row.statusPengajuan === 'DISETUJUI') {
      throw new Error('Pengajuan yang sudah disetujui tidak dapat ditolak.');
    }
    // DITOLAK tetap idempotent: mengulang penolakan bukan perubahan
    // keadaan, jadi tidak perlu dianggap kesalahan (perilaku existing).
    if (row.statusPengajuan === 'DITOLAK') return row;
    await db.runAsync(
      `UPDATE keluar_anggota SET status_pengajuan = 'DITOLAK', disetujui_oleh = ?,
              keterangan = COALESCE(?, keterangan), updated_at = ? WHERE id = ?`,
      ditolakOleh,
      alasan ?? null,
      new Date().toISOString(),
      id
    );
    return ambil(db, id);
  });
}

// ===========================================================================
// PEMBAYARAN
// ===========================================================================

export interface BayarKeluarAnggotaInput {
  id: string;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  createdBy: string;
}

/**
 * PEMBAYARAN — satu transaksi, seluruhnya atau tidak sama sekali.
 *
 * Jurnalnya DIRINCI PER AKUN, bukan satu angka gabungan, sehingga tiap
 * baris dapat direkonsiliasi terhadap subledger asalnya:
 *
 *   Dr Simpanan Pokok        sebesar saldo pokok
 *   Dr Simpanan Wajib        sebesar saldo wajib
 *   Dr Simpanan Sukarela     sebesar saldo sukarela
 *     Cr Piutang Pinjaman    sebesar outstanding (bila ada)
 *     Cr Kas/Bank            sebesar nilai pengembalian
 *
 * Pelunasan pinjaman lewat kompensasi hak anggota TIDAK menghapus
 * piutang diam-diam: ia mengkredit akun piutang sebesar outstanding,
 * jadi buku besar tetap menunjukkan dari mana pelunasannya datang.
 */
export async function bayarKeluarAnggota(
  input: BayarKeluarAnggotaInput
): Promise<{ journalId: string; nilaiPengembalian: Rupiah }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await requirePermission(db, input.createdBy, 'anggota', 'edit');

    const row = await ambil(db, input.id);
    if (row.statusPengajuan === 'DIBAYAR') {
      throw new Error('Pengajuan ini sudah dibayar. Pembayaran kedua ditolak.');
    }
    if (row.statusPengajuan !== 'DISETUJUI') {
      throw new Error(
        `Pembayaran hanya dapat dilakukan setelah pengajuan DISETUJUI (saat ini ${row.statusPengajuan}).`
      );
    }

    const anggota = await db.getFirstAsync<{ nama_lengkap: string; status: string }>(
      `SELECT nama_lengkap, status FROM anggota WHERE id = ?`,
      row.anggotaId
    );
    if (!anggota) throw new Error('Anggota tidak ditemukan.');
    if (anggota.status === 'KELUAR') {
      // Jalur lama `SimpananService.keluarAnggota()` sudah membayar.
      throw new Error('Anggota ini sudah berstatus Keluar — pembayaran ganda ditolak.');
    }

    // VERIFIKASI ULANG: angka yang dibayar harus SAMA dengan angka yang
    // disetujui. Kalau saldo bergerak setelah persetujuan, pembayaran
    // ditolak dan pengajuan harus diajukan ulang.
    const kini = await hitungPerhitunganKeluar(db, row.anggotaId);
    if (
      kini.totalHak !== row.totalHak ||
      kini.totalPengurang !== row.totalPengurang ||
      kini.nilaiPengembalian !== row.nilaiPengembalian
    ) {
      throw new Error(
        'Saldo anggota berubah setelah pengajuan disetujui. Ajukan ulang agar nominal yang disetujui sama dengan yang dibayarkan.'
      );
    }

    /**
     * SHU YANG BELUM DIBAGIKAN TIDAK DAPAT DIBAYARKAN DI SINI.
     *
     * SHU berstatus DISAHKAN_RAT memang sudah menjadi hak anggota,
     * tetapi BELUM pernah dibukukan sebagai kewajiban koperasi — tidak
     * ada saldo akun mana pun yang dapat didebit untuk membayarnya.
     * Membayarnya lewat kas tanpa sisi debit yang sah berarti mengarang
     * akun, dan itu keputusan kebijakan + COA yang belum diberikan.
     *
     * Jadi angkanya tetap DITAMPILKAN sebagai hak (transparan bagi
     * pengurus), tetapi pembayaran ditolak sampai SHU-nya dibagikan
     * lewat jalur `ShuService` yang memang membukukannya.
     */
    if (row.shuHakAnggota > 0) {
      throw new Error(
        `Anggota ini masih memiliki SHU ${row.shuHakAnggota} yang sudah disahkan RAT tetapi belum dibagikan. ` +
          'Bagikan SHU terlebih dahulu lewat menu SHU agar tercatat sebagai kewajiban, baru proses pembayaran keluar anggota.'
      );
    }

    const lines: { accountId: string; debit: number; kredit: number }[] = [];
    if (row.saldoSimpananPokok > 0) {
      lines.push({
        accountId: await resolveAccountId(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT'),
        debit: row.saldoSimpananPokok,
        kredit: 0,
      });
    }
    if (row.saldoSimpananWajib > 0) {
      lines.push({
        accountId: await resolveAccountId(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT'),
        debit: row.saldoSimpananWajib,
        kredit: 0,
      });
    }
    if (row.saldoSimpananSukarela > 0) {
      lines.push({
        accountId: await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT'),
        debit: row.saldoSimpananSukarela,
        kredit: 0,
      });
    }
    /**
     * KOMPENSASI PINJAMAN DIBATASI OLEH HAK YANG TERSEDIA.
     *
     * Hak anggota yang benar-benar punya sisi debit di jurnal ini adalah
     * saldo simpanan. Mengkredit piutang melebihi itu menghasilkan
     * jurnal yang tidak seimbang — dan memaksanya seimbang berarti
     * menghapus sebagian piutang tanpa dasar.
     *
     * Jadi yang dikompensasi hanya sebesar hak yang ada. SISA PINJAMAN
     * TETAP MENJADI PIUTANG dan tetap tertagih; keluarnya anggota tidak
     * menghapus utangnya. Penghapusan piutang punya jalurnya sendiri
     * (`hapusPiutangPinjaman`, dengan syarat RAT) dan tidak boleh
     * terjadi diam-diam di sini.
     */
    const hakSimpanan =
      row.saldoSimpananPokok + row.saldoSimpananWajib + row.saldoSimpananSukarela;
    const pinjamanDikompensasi = Math.min(row.saldoPinjaman, hakSimpanan);
    if (pinjamanDikompensasi > 0) {
      lines.push({
        accountId: await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG'),
        debit: 0,
        kredit: pinjamanDikompensasi,
      });
    }

    let kasBankAccountId: string | null = null;
    if (row.nilaiPengembalian > 0) {
      kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
      const cek = await checkSaldoAkunCukup(db, {
        accountId: kasBankAccountId,
        namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
        nominalKeluar: row.nilaiPengembalian,
      });
      if (!cek.valid) throw new Error(cek.reason);
      lines.push({ accountId: kasBankAccountId, debit: 0, kredit: row.nilaiPengembalian });
    }

    if (lines.length === 0) {
      throw new Error('Tidak ada nilai yang dapat dijurnal untuk pengajuan ini.');
    }

    const tahun = parseInt(input.tanggal.slice(0, 4), 10);
    const nomor = await nextSequence(db, 'KLA-BYR', tahun);
    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'KELUAR_ANGGOTA',
      sumberId: row.id,
      nomorReferensi: nomor,
      deskripsi: `Penyelesaian hak anggota keluar: ${anggota.nama_lengkap} - ${nomor}`,
      createdBy: input.createdBy,
      lines,
    });

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE keluar_anggota
          SET status_pengajuan = 'DIBAYAR', sumber_pembayaran = ?, bank_account_id = ?,
              dibayar_oleh = ?, tanggal_pembayaran = ?, journal_id = ?, updated_at = ?
        WHERE id = ?`,
      input.sumberDana,
      input.bankAccountId ?? null,
      input.createdBy,
      input.tanggal,
      journalId,
      now,
      row.id
    );

    // Status anggota berubah HANYA di sini — bukan saat diajukan, dan
    // bukan saat disetujui. Anggota baru benar-benar keluar setelah
    // haknya diselesaikan.
    await db.runAsync(
      `UPDATE anggota SET status = 'KELUAR', updated_at = ? WHERE id = ?`,
      now,
      row.anggotaId
    );

    return { journalId, nilaiPengembalian: row.nilaiPengembalian };
  });
}

export async function getKeluarAnggota(id: string): Promise<KeluarAnggotaRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT k.*, a.nama_lengkap AS nama_anggota FROM keluar_anggota k
       JOIN anggota a ON a.id = k.anggota_id WHERE k.id = ?`,
    id
  );
  return r ? petakan(r) : null;
}

export async function listKeluarAnggota(
  status?: StatusPengajuanKeluar
): Promise<KeluarAnggotaRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT k.*, a.nama_lengkap AS nama_anggota FROM keluar_anggota k
       JOIN anggota a ON a.id = k.anggota_id
     ${status ? 'WHERE k.status_pengajuan = ?' : ''}
     ORDER BY k.tanggal_pengajuan DESC`,
    ...(status ? [status] : [])
  );
  return rows.map(petakan);
}

/**
 * Satu pengajuan untuk layar Detail Pengajuan — READ-ONLY.
 *
 * `listKeluarAnggota()` sudah membawa hampir seluruh field yang
 * dibutuhkan detail, jadi fungsi ini TIDAK menghitung ulang apa pun:
 * ia membaca baris yang sama lewat `petakan()` yang sama, dan hanya
 * MENAMBAH `nomorAnggota` — satu-satunya field yang diminta layar
 * detail tetapi tidak ada di read-model daftar.
 *
 * Alternatifnya (menambahkan `nomor_anggota` ke `listKeluarAnggota`)
 * akan membebani setiap baris daftar dengan kolom yang tidak
 * dirender daftar.
 *
 * MURNI SELECT: tanpa transaction write, tanpa jurnal, tanpa
 * perubahan status. `null` bila id tidak ada — pemanggil menampilkan
 * empty state, bukan melempar.
 */
export interface KeluarAnggotaDetail extends KeluarAnggotaRow {
  readonly nomorAnggota: string | null;
}

export async function getKeluarAnggotaDetailById(
  id: string
): Promise<KeluarAnggotaDetail | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT k.*, a.nama_lengkap AS nama_anggota, a.nomor_anggota AS nomor_anggota
       FROM keluar_anggota k
       JOIN anggota a ON a.id = k.anggota_id
      WHERE k.id = ?`,
    id
  );
  if (!r) return null;
  return { ...petakan(r), nomorAnggota: (r.nomor_anggota as string | null) ?? null };
}

/** Pratinjau perhitungan tanpa membuat pengajuan — untuk form. */
export async function previewKeluarAnggota(anggotaId: string): Promise<PerhitunganKeluarAnggota> {
  const db = await getDb();
  return hitungPerhitunganKeluar(db, anggotaId);
}
