import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkAnggotaAktif } from '@/validators/BusinessRuleEngine';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import {
  TenorSimpananBerjangka,
  hitungTanggalJatuhTempo,
  isTenorSimpananBerjangkaValid,
} from '@/accounting/SimpananBerjangkaTenor';
import {
  alasanKebijakanTidakLayak,
  snapshotDariKebijakan,
  StatusPolicyKontrak,
} from '@/accounting/SimpananBerjangkaKebijakanProduk';
import { getKebijakanProdukUntukTanggalPadaDb } from '@/services/SimpananBerjangkaKebijakanProdukService';

/**
 * ============================================================
 * SIMPANAN BERJANGKA (DEPOSITO ANGGOTA)
 * ============================================================
 *
 * RUANG LINGKUP FASE INI — dinyatakan terus terang di muka:
 *
 *   PRINCIPAL LIABILITY  + CONTRACT RATE METADATA + MATURITY
 *
 * Yang DIKERJAKAN:
 *   - pengakuan awal: Dr Kas/Bank, Cr 2-1210 sebesar POKOK saja
 *   - penyimpanan syarat kontrak: tenor, suku bunga, tanggal jatuh tempo
 *   - subledger `simpanan_berjangka` sebagai sumber kebenaran kontrak
 *
 * AKRUAL BUNGA, JATUH TEMPO & PENCAIRAN ada di
 * `SimpananBerjangkaLifecycleService.ts` — bukan di sini. Bunga
 * memakai SIMPLE INTEREST kontraktual (Dr 5-1955 / Cr 2-1710), BUKAN
 * mesin EIR pinjaman: EIR mengukur ASET pada biaya perolehan
 * diamortisasi termasuk biaya transaksi, sedangkan simpanan berjangka
 * adalah KEWAJIBAN berbunga kontraktual sederhana.
 *
 * KENAPA BUNGA TIDAK BOLEH MASUK PENGAKUAN AWAL (anti double-counting):
 *   Cr 2-1210 sebesar (pokok + bunga) akan mengakui kewajiban bunga
 *   yang BELUM terjadi — bunga baru menjadi kewajiban seiring waktu
 *   berjalan (earned), bukan pada detik penempatan. Mencatatnya di muka
 *   menggelembungkan liabilitas dan, saat mesin akrual nanti dibuat,
 *   akan langsung menjadi double-count. Karena itu kredit awal SELALU
 *   PERSIS `nominal` pokok.
 */

export type StatusSimpananBerjangka = 'AKTIF' | 'JATUH_TEMPO' | 'DICAIRKAN' | 'DIBATALKAN';

/** transaction_type untuk mapping COA & klasifikasi arus kas. */
export const TRANSAKSI_SIMPANAN_BERJANGKA = 'SIMPANAN_BERJANGKA';

export interface SetorSimpananBerjangkaInput {
  anggotaId: string;
  nominal: Rupiah;
  /** 'YYYY-MM-DD' — tanggal penempatan, sekaligus tanggal mulai kontrak. */
  tanggal: string;
  tenorBulan: TenorSimpananBerjangka;
  /**
   * Suku bunga KONTRAKTUAL per tahun dalam persen (mis. 8.5 = 8,5%/tahun).
   * OPSIONAL — `undefined`/`null` berarti tanpa bunga (0).
   */
  sukuBungaPerTahun?: number | null;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  idempotencyKey?: string;
  createdBy: string;
}

export interface SimpananBerjangkaRow {
  id: string;
  anggotaId: string;
  nomorTransaksi: string;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  nominal: Rupiah;
  tenorBulan: number;
  sukuBungaPerTahun: number;
  status: StatusSimpananBerjangka;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
  keterangan: string | null;
  journalId: string | null;
  createdAt: string;
  /** Bunga yang SUDAH diakru (Dr Beban / Cr Utang Bunga). */
  bungaTerakru: Rupiah;
  /** Bunga yang sudah benar-benar dibayarkan saat pencairan. */
  bungaDibayar: Rupiah;
  tanggalPencairan: string | null;
  journalPencairanId: string | null;
  // RC-S128 — snapshot kebijakan produk (null untuk kontrak legacy).
  // Opsional di TIPE supaya objek lama tetap kompatibel; `mapRow` selalu mengisinya.
  statusPolicy?: StatusPolicyKontrak;
  policyId?: string | null;
  policyVersi?: string | null;
  /** Sama dengan `sukuBungaPerTahun` — rate kontrak yang tersimpan sejak penempatan. */
  rateKontrak?: number;
  autoRenewal?: boolean | null;
  bungaPascaAktif?: boolean | null;
  ratePascaJatuhTempo?: number | null;
  bungaDikreditkanKe?: string | null;
  pascaMulaiEfektif?: string | null;
}

/**
 * Normalisasi & validasi suku bunga opsional.
 *
 * Menolak NaN/Infinity secara EKSPLISIT: keduanya bertipe `number` di
 * TypeScript, jadi tipe saja tidak menghalanginya, dan `NaN >= 0`
 * bernilai false sehingga sebuah pemeriksaan `< 0` saja akan
 * meloloskannya lewat jalur yang salah. Nilai seperti itu akan
 * tersimpan sebagai REAL rusak di database dan meracuni perhitungan
 * bunga apa pun di kemudian hari.
 */
export function normalisasiSukuBunga(nilai: number | null | undefined): number {
  if (nilai === null || nilai === undefined) return 0;
  if (typeof nilai !== 'number' || !Number.isFinite(nilai)) {
    throw new Error('Suku bunga tidak valid. Isi angka, atau kosongkan bila tanpa bunga.');
  }
  if (nilai < 0) {
    throw new Error('Suku bunga tidak boleh negatif.');
  }
  return nilai;
}

/**
 * Setor / penempatan simpanan berjangka.
 *
 * JURNAL (satu-satunya jurnal yang dihasilkan modul ini):
 *   Dr  Kas / Bank                          nominal
 *   Cr  2-1210 Simpanan Anggota (Berjangka) nominal
 *
 * Seluruh langkah berjalan dalam SATU transaksi: bila mapping 2-1210
 * hilang, periode tertutup, anggota nonaktif, atau insert subledger
 * gagal, TIDAK ADA jurnal maupun baris subledger yang tertinggal.
 */
export async function setorSimpananBerjangka(input: SetorSimpananBerjangkaInput) {
  // Validasi bentuk input dilakukan SEBELUM transaksi dibuka — murni
  // pemeriksaan nilai, tidak butuh database.
  if (!isTenorSimpananBerjangkaValid(input.tenorBulan)) {
    throw new Error(
      `Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${input.tenorBulan}.`
    );
  }
  if (!Number.isInteger(input.nominal) || input.nominal <= 0) {
    throw new Error('Nominal simpanan berjangka harus bilangan bulat Rupiah lebih besar dari 0.');
  }
  const sukuBunga = normalisasiSukuBunga(input.sukuBungaPerTahun);
  // Dihitung dengan aritmetika bulan KALENDER, bukan tenor x 30 hari.
  const tanggalJatuhTempo = hitungTanggalJatuhTempo(input.tanggal, input.tenorBulan);

  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await pastikanAnggotaAktif(db, input.anggotaId);

    // IDEMPOTENCY — dicek di dalam transaksi, dan diperkuat unique index
    // parsial `idx_simpanan_berjangka_idempotency` di database sehingga
    // dua submit yang benar-benar bersamaan pun tidak bisa lolos berdua.
    // Identitas TIDAK diturunkan dari nominal+tanggal: dua penempatan
    // sah dengan nominal & tanggal sama harus tetap boleh dicatat.
    if (input.idempotencyKey) {
      const sudahAda = await db.getFirstAsync<{ id: string; nomor_transaksi: string; journal_id: string | null }>(
        `SELECT id, nomor_transaksi, journal_id FROM simpanan_berjangka WHERE idempotency_key = ?`,
        input.idempotencyKey
      );
      if (sudahAda) {
        // Kembalikan hasil yang SAMA, bukan melempar error: pemanggil
        // yang mengulang karena timeout jaringan harus melihat
        // keberhasilan yang sama, bukan kegagalan palsu.
        return {
          id: sudahAda.id,
          nomorTransaksi: sudahAda.nomor_transaksi,
          journalId: sudahAda.journal_id,
          tanggalJatuhTempo,
          duplikat: true as const,
        };
      }
    }

    // BANK wajib punya rekening — `resolveKasBankAccountId` melempar
    // bila `bankAccountId` kosong. TIDAK ADA jalur yang diam-diam
    // jatuh ke Kas.
    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    // TANPA fallback: mapping hilang -> MissingAccountMappingError.
    const simpananBerjangkaAccountId = await resolveAccountId(
      db,
      TRANSAKSI_SIMPANAN_BERJANGKA,
      'KREDIT_DEFAULT'
    );

    // RC-S128 — kebijakan produk yang BERLAKU pada tanggal penempatan
    // wajib ada dan lengkap; snapshot-nya disalin ke kontrak sehingga
    // perubahan kebijakan di kemudian hari tidak mengubah kontrak ini.
    const kebijakan = await getKebijakanProdukUntukTanggalPadaDb(db, input.tanggal);
    const tidakLayak = alasanKebijakanTidakLayak(kebijakan);
    if (tidakLayak) throw new Error(tidakLayak);
    const snap = snapshotDariKebijakan(kebijakan!);

    const tahun = parseInt(input.tanggal.slice(0, 4), 10);
    const nomorTransaksi = await nextSequence(db, 'SPB', tahun);

    // `createJournal` menegakkan guard periode tertutup, keseimbangan
    // debit=kredit, dan invarian Rupiah bulat — modul ini tidak
    // menduplikasi satu pun aturan itu.
    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: TRANSAKSI_SIMPANAN_BERJANGKA,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Setoran simpanan berjangka ${input.tenorBulan} bulan - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.nominal, kredit: 0 },
        // POKOK SAJA — bunga TIDAK ikut diakui di sini (lihat catatan
        // anti double-counting di kepala file).
        { accountId: simpananBerjangkaAccountId, debit: 0, kredit: input.nominal },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO simpanan_berjangka
        (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal,
         tenor_bulan, suku_bunga, status, sumber_dana, bank_account_id, keterangan,
         journal_id, idempotency_key, created_by, created_at, updated_at,
         policy_id, policy_versi, policy_auto_renewal, policy_bunga_pasca_aktif, policy_rate_pasca_jatuh_tempo,
         policy_basis_rate, policy_metode_periode, policy_bunga_dikreditkan_ke, policy_kapitalisasi_bunga,
         policy_pokok_tetap, status_policy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'POLICY_SNAPSHOT')`,
      id,
      input.anggotaId,
      nomorTransaksi,
      input.tanggal,
      tanggalJatuhTempo,
      input.nominal,
      input.tenorBulan,
      sukuBunga,
      'AKTIF' satisfies StatusSimpananBerjangka,
      input.sumberDana,
      input.bankAccountId ?? null,
      input.keterangan ?? null,
      journalId,
      input.idempotencyKey ?? null,
      input.createdBy,
      now,
      now,
      snap.policyId,
      snap.policyVersi,
      snap.autoRenewal ? 1 : 0,
      snap.bungaPascaAktif ? 1 : 0,
      snap.ratePascaJatuhTempo,
      snap.basisRate,
      snap.metodePeriode,
      snap.bungaDikreditkanKe,
      0,
      1
    );

    return { id, nomorTransaksi, journalId, tanggalJatuhTempo, policyVersi: snap.policyVersi, duplikat: false as const };
  });
}

/**
 * Guard anggota aktif — memakai aturan bisnis yang SUDAH ADA
 * (`checkAnggotaAktif`), bukan definisi "aktif" versi modul ini.
 */
async function pastikanAnggotaAktif(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<void> {
  const anggota = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM anggota WHERE id = ?`,
    anggotaId
  );
  if (!anggota) throw new Error('Anggota tidak ditemukan.');
  const cek = checkAnggotaAktif(anggota.status);
  if (!cek.valid) throw new Error(cek.reason);
}

function mapRow(r: any): SimpananBerjangkaRow {
  return {
    id: r.id,
    anggotaId: r.anggota_id,
    nomorTransaksi: r.nomor_transaksi,
    tanggalMulai: r.tanggal_mulai,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
    nominal: r.nominal,
    tenorBulan: r.tenor_bulan,
    sukuBungaPerTahun: r.suku_bunga,
    status: r.status,
    sumberDana: r.sumber_dana,
    bankAccountId: r.bank_account_id,
    keterangan: r.keterangan,
    journalId: r.journal_id,
    createdAt: r.created_at,
    bungaTerakru: r.bunga_terakru ?? 0,
    bungaDibayar: r.bunga_dibayar ?? 0,
    tanggalPencairan: r.tanggal_pencairan ?? null,
    journalPencairanId: r.journal_pencairan_id ?? null,
    statusPolicy: r.status_policy ?? 'LEGACY_POLICY_REVIEW_REQUIRED',
    policyId: r.policy_id ?? null,
    policyVersi: r.policy_versi ?? null,
    rateKontrak: r.suku_bunga,
    autoRenewal: r.policy_auto_renewal == null ? null : r.policy_auto_renewal === 1,
    bungaPascaAktif: r.policy_bunga_pasca_aktif == null ? null : r.policy_bunga_pasca_aktif === 1,
    ratePascaJatuhTempo: r.policy_rate_pasca_jatuh_tempo ?? null,
    bungaDikreditkanKe: r.policy_bunga_dikreditkan_ke ?? null,
    pascaMulaiEfektif: r.policy_pasca_mulai_efektif ?? null,
  };
}

/**
 * HISTORI kontrak simpanan berjangka.
 *
 * Dibaca dari SUBLEDGER, bukan direkonstruksi dari jurnal. Jurnal hanya
 * tahu "Kas naik, liabilitas naik" — ia tidak menyimpan tenor, rate,
 * jatuh tempo, atau status kontrak. Subledger inilah yang otoritatif
 * untuk syarat kontrak.
 */
export async function listSimpananBerjangka(anggotaId?: string): Promise<SimpananBerjangkaRow[]> {
  const db = await getDb();
  const rows = anggotaId
    ? await db.getAllAsync<any>(
        `SELECT * FROM simpanan_berjangka WHERE anggota_id = ? ORDER BY tanggal_mulai DESC, created_at DESC`,
        anggotaId
      )
    : await db.getAllAsync<any>(
        `SELECT * FROM simpanan_berjangka ORDER BY tanggal_mulai DESC, created_at DESC`
      );
  return rows.map(mapRow);
}

/**
 * RC-S129 — baris DAFTAR kontrak: baris subledger yang sama persis
 * (`mapRow`) ditambah identitas anggota untuk ditampilkan & dicari di
 * layar daftar. Hanya membaca; tidak ada angka yang dihitung di sini.
 */
export interface SimpananBerjangkaDaftarRow extends SimpananBerjangkaRow {
  namaAnggota: string | null;
  nomorAnggota: string | null;
}

/**
 * RC-S129 — daftar kontrak beserta nama & nomor anggota (LEFT JOIN, jadi
 * kontrak tetap tampil walau data anggotanya tidak ditemukan). Urutan sama
 * dengan `listSimpananBerjangka`. Pencarian & filter dilakukan di
 * `utils/daftarSimpananBerjangka.ts` atas hasil ini.
 */
export async function listSimpananBerjangkaDaftar(anggotaId?: string): Promise<SimpananBerjangkaDaftarRow[]> {
  const db = await getDb();
  const kolom = `SELECT sb.*, a.nama_lengkap AS anggota_nama, a.nomor_anggota AS anggota_nomor
       FROM simpanan_berjangka sb LEFT JOIN anggota a ON a.id = sb.anggota_id`;
  const urut = `ORDER BY sb.tanggal_mulai DESC, sb.created_at DESC`;
  const rows = anggotaId
    ? await db.getAllAsync<any>(`${kolom} WHERE sb.anggota_id = ? ${urut}`, anggotaId)
    : await db.getAllAsync<any>(`${kolom} ${urut}`);
  return rows.map((r) => ({ ...mapRow(r), namaAnggota: r.anggota_nama ?? null, nomorAnggota: r.anggota_nomor ?? null }));
}

/**
 * STATUS KONTRAK YANG MASIH DAPAT DIPROSES (RC-S53 §E).
 *
 * BUKAN aturan baru. Ini konstanta yang mengangkat aturan yang SUDAH
 * dipakai `getRingkasanSimpananBerjangkaAnggota()` dan
 * `getTotalSimpananBerjangka()` menjadi satu nama, supaya kandidat
 * anggota di picker dan angka ringkasan mustahil memakai definisi
 * "eligible" yang berbeda. DICAIRKAN & DIBATALKAN sengaja di luar:
 * kontraknya sudah selesai.
 */
export const STATUS_BERJANGKA_DAPAT_DIPROSES: readonly StatusSimpananBerjangka[] = [
  'AKTIF',
  'JATUH_TEMPO',
];

export interface AnggotaBerjangkaCandidate {
  readonly id: string;
  readonly nomorAnggota: string;
  readonly namaLengkap: string;
  readonly nik: string | null;
  readonly status: string;
  /** Banyaknya kontrak yang masih dapat diproses milik anggota ini. */
  readonly jumlahKontrak: number;
}

/**
 * KANDIDAT ANGGOTA UNTUK MODE BERJANGKA (RC-S53 §E).
 *
 * BUG YANG DIPERBAIKI. `TarikSimpananFormScreen` memanggil
 * `AnggotaPicker` dengan `onlyWithSaldoSukarela={jenis === 'SUKARELA'}`.
 * Pada mode BERJANGKA nilainya `false`, sehingga picker jatuh ke cabang
 * `listAnggota({ status: 'AKTIF' })` — SELURUH anggota aktif muncul,
 * termasuk yang tidak pernah punya simpanan berjangka. Penyaringannya
 * baru terjadi SETELAH anggota dipilih, lewat daftar kontrak yang
 * kosong. Itu terlambat: pengguna sudah menempuh satu langkah yang
 * memang tidak punya kelanjutan.
 *
 * Penyaringan dilakukan di SQL, bukan di UI, dengan alasan yang sama
 * seperti `listAnggotaSaldoSukarelaTersedia()`: penyaringan di UI hanya
 * menyembunyikan baris dari halaman pertama, sementara `LIMIT` sudah
 * terlanjur dihitung dari himpunan yang salah.
 *
 * `GROUP BY a.id` memastikan anggota dengan DUA kontrak eligible tetap
 * muncul SATU KALI — masalah klasik JOIN satu-ke-banyak.
 */
export async function listAnggotaDenganBerjangkaEligible(opts: {
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * RC-S118.1: ambil SELURUH kandidat tanpa LIMIT/OFFSET sama sekali.
   * Dipakai picker anggota, yang harus memperlihatkan jumlah anggota
   * yang SEBENARNYA — bukan halaman pertama. Penyaringan kelayakan di
   * query TIDAK berubah; yang hilang hanya batas halamannya. Pemanggil
   * lain yang tidak mengisi opsi ini tetap ber-pagination seperti semula.
   */
  semuaData?: boolean;
} = {}): Promise<AnggotaBerjangkaCandidate[]> {
  const db = await getDb();
  const filters: string[] = [`a.status = 'AKTIF'`];
  const params: (string | number)[] = [];
  if (opts.search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ? OR a.nik LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  /*
   * RC-S118.1: yang ikut `semuaData` HANYA klausa paginasi. INNER JOIN
   * ke `simpanan_berjangka` beserta filter statusnya tetap — daftar ini
   * memang hanya boleh berisi anggota yang punya kontrak berjangka yang
   * masih dapat diproses.
   */
  const paginasi = opts.semuaData ? '' : 'LIMIT ? OFFSET ?';
  const paramPaginasi = opts.semuaData ? [] : [opts.limit ?? 30, opts.offset ?? 0];
  // Placeholder dibangun dari panjang konstanta, bukan ditulis tangan:
  // menambah status baru kelak tidak boleh menyisakan '?' yang tertinggal.
  const statusPlaceholder = STATUS_BERJANGKA_DAPAT_DIPROSES.map(() => '?').join(',');

  const rows = await db.getAllAsync<any>(
    `SELECT a.id, a.nomor_anggota, a.nama_lengkap, a.nik, a.status,
            COUNT(sb.id) as jumlah_kontrak
     FROM anggota a
     INNER JOIN simpanan_berjangka sb
             ON sb.anggota_id = a.id
            AND sb.status IN (${statusPlaceholder})
     ${where}
     GROUP BY a.id, a.nomor_anggota, a.nama_lengkap, a.nik, a.status
     ORDER BY a.nama_lengkap ASC
     ${paginasi}`,
    ...STATUS_BERJANGKA_DAPAT_DIPROSES,
    ...params,
    ...paramPaginasi
  );

  return rows.map((r) => ({
    id: r.id,
    nomorAnggota: r.nomor_anggota,
    namaLengkap: r.nama_lengkap,
    nik: r.nik ?? null,
    status: r.status,
    jumlahKontrak: r.jumlah_kontrak,
  }));
}

export async function getSimpananBerjangka(id: string): Promise<SimpananBerjangkaRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM simpanan_berjangka WHERE id = ?`, id);
  return row ? mapRow(row) : null;
}

export interface RingkasanSimpananBerjangka {
  /** Saldo POKOK kontrak yang masih berjalan — TIDAK termasuk bunga. */
  saldoPokok: Rupiah;
  jumlahKontrakAktif: number;
  /** 'YYYY-MM-DD' jatuh tempo terdekat di antara kontrak aktif, atau null. */
  jatuhTempoTerdekat: string | null;
  /**
   * §34 — bunga yang SUDAH diakru untuk kontrak yang masih berjalan.
   * Terpisah dari `saldoPokok` dan TIDAK PERNAH ditambahkan ke dalamnya:
   * pokok duduk di 2-1210, bunga di 2-1710. Menjumlahkannya di layar
   * akan membuat angka yang ditampilkan tidak lagi cocok dengan akun
   * mana pun di buku besar.
   */
  bungaTerakru: Rupiah;
  /**
   * Rentang suku bunga kontrak aktif, mis. "6%" atau "6% - 12%".
   * null bila seluruh kontrak aktif tanpa bunga.
   */
  rentangSukuBunga: string | null;
}

/**
 * Ringkasan untuk layar Detail Anggota.
 *
 * Hanya kontrak berstatus AKTIF yang dihitung: DICAIRKAN sudah
 * dikembalikan ke anggota, DIBATALKAN tidak pernah berlaku. Nilai yang
 * dijumlahkan adalah POKOK — konsisten dengan yang benar-benar duduk di
 * GL 2-1210, sehingga saldo di layar ini selalu bisa direkonsiliasi
 * dengan buku besar.
 */
export async function getRingkasanSimpananBerjangka(
  anggotaId: string
): Promise<RingkasanSimpananBerjangka> {
  const db = await getDb();
  // Status AKTIF dan JATUH_TEMPO sama-sama masih menjadi kewajiban
  // koperasi (belum dibayarkan), jadi keduanya ikut — konsisten dengan
  // basis rekonsiliasi GL 2-1210 / 2-1710.
  const row = await db.getFirstAsync<{
    total: number;
    jumlah: number;
    terdekat: string | null;
    bunga: number;
    rateMin: number | null;
    rateMax: number | null;
  }>(
    `SELECT COALESCE(SUM(nominal), 0) as total,
            COUNT(*) as jumlah,
            MIN(tanggal_jatuh_tempo) as terdekat,
            COALESCE(SUM(bunga_terakru), 0) as bunga,
            MIN(suku_bunga) as rateMin,
            MAX(suku_bunga) as rateMax
     FROM simpanan_berjangka
     WHERE anggota_id = ? AND status IN ('AKTIF','JATUH_TEMPO')`,
    anggotaId
  );

  const rateMin = row?.rateMin ?? 0;
  const rateMax = row?.rateMax ?? 0;
  const rentangSukuBunga =
    !row || row.jumlah === 0 || rateMax === 0
      ? null
      : rateMin === rateMax
        ? `${rateMax}%`
        : `${rateMin}% - ${rateMax}%`;

  return {
    saldoPokok: row?.total ?? 0,
    jumlahKontrakAktif: row?.jumlah ?? 0,
    jatuhTempoTerdekat: row?.terdekat ?? null,
    bungaTerakru: row?.bunga ?? 0,
    rentangSukuBunga,
  };
}

/** Total pokok simpanan berjangka aktif seluruh anggota (untuk rekonsiliasi). */
export async function getTotalPokokSimpananBerjangkaPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nominal), 0) as total FROM simpanan_berjangka WHERE status IN ('AKTIF','JATUH_TEMPO')`
  );
  return row?.total ?? 0;
}

/**
 * Pesan penolakan tunggal untuk upaya mencairkan simpanan berjangka
 * lewat jalur simpanan sukarela. Diekspor supaya UI dan service memakai
 * kalimat yang sama persis.
 */
export const PESAN_TOLAK_PENCAIRAN_LEWAT_SUKARELA =
  'Simpanan berjangka hanya dapat dicairkan melalui proses pencairan simpanan berjangka.';

/**
 * PENCAIRAN dipindah ke `SimpananBerjangkaLifecycleService.ts`
 * (`cairkanSimpananBerjangka`) bersama akrual bunga & jatuh tempo,
 * karena ketiganya adalah satu rangkaian lifecycle yang saling
 * bergantung: pencairan WAJIB menyelesaikan akrual lebih dulu di dalam
 * transaksi yang sama. Modul ini tetap fokus pada penempatan &
 * pembacaan kontrak.
 */
