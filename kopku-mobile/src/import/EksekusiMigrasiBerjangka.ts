import type * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';
import { newId, nextSequence } from '@/utils/id';
import { requirePermission } from '@/services/PermissionService';
import { checkAnggotaAktif } from '@/validators/BusinessRuleEngine';
import {
  TenorSimpananBerjangka,
  hitungTanggalJatuhTempo,
  isTenorSimpananBerjangkaValid,
} from '@/accounting/SimpananBerjangkaTenor';
import { buatJadwalBungaSimpananBerjangka } from '@/accounting/SimpananBerjangkaBunga';
import { alasanKebijakanTidakLayak, snapshotDariKebijakan } from '@/accounting/SimpananBerjangkaKebijakanProduk';
import { getKebijakanProdukUntukTanggalPadaDb } from '@/services/SimpananBerjangkaKebijakanProdukService';
import { normalisasiSukuBunga } from '@/services/SimpananBerjangkaService';
import { PREFIX_CONFIG_MIGRASI_BERJANGKA } from '@/services/SimpananBerjangkaLifecycleService';

/**
 * RC-S133.4.6 — MIGRASI SALDO AWAL SIMPANAN BERJANGKA (TANPA JURNAL KAS).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI (uji setara RC-S133.4.5)
 * ============================================================
 * Pada pilihan "Saldo lama koperasi", sheet "4. Simpanan Berjangka"
 * masih memanggil `setorSimpananBerjangka()`, yang MENJURNAL
 *
 *     Debit  Kas/Bank                 sebesar nominal
 *     Kredit Simpanan Berjangka
 *
 * pada tanggal penempatan lama. Uji dua jalur (transaksi biasa vs import)
 * membuktikan dua akibatnya:
 *   1. KAS FIKTIF sebesar nominal berjangka — uangnya sudah lama diterima
 *      dan sudah ada di saldo awal Kas. "Saldo Awal Belum Sesuai" (3-5000)
 *      tidak pernah kembali Rp0.
 *   2. Catch-up bunga mengakru & memindahkan ULANG bunga periode sebelum
 *      cut-off, padahal bunga itu sudah dibukukan pembukuan lama dan sudah
 *      masuk saldo Simpanan Sukarela di sheet 2. Beban bunga dan saldo
 *      sukarela anggota menjadi ganda.
 *
 * Kesalahan ini sekelas dengan pencairan ulang pinjaman (RC-S102), kas
 * fiktif simpanan (RC-S103), dan pembelian ulang aset (RC-S107).
 *
 * ============================================================
 * YANG DILAKUKAN DI SINI
 * ============================================================
 *  - Kontrak ditulis ke buku pembantu `simpanan_berjangka` dengan
 *    `journal_id` NULL — TIDAK ADA jurnal kas. Sisi buku besarnya (2-1210)
 *    diisi lewat Saldo Awal Akun otomatis (pos SIMPANAN_BERJANGKA).
 *  - Snapshot kebijakan produk diambil PERSIS seperti penempatan biasa.
 *    Bila belum ada kebijakan yang berlaku pada tanggal penempatan lama
 *    (koperasi biasanya baru menetapkan kebijakan saat mulai memakai
 *    aplikasi), dipakai kebijakan yang berlaku pada tanggal cut-off.
 *  - Periode bunga yang BERAKHIR SEBELUM cut-off dicatat di
 *    `simpanan_berjangka_bunga` dengan `journal_id` NULL, dan kontraknya
 *    diberi penanda `app_config` (PREFIX_CONFIG_MIGRASI_BERJANGKA + id =
 *    tanggal cut-off). Periode tanpa jurnal sebelum cut-off pada kontrak
 *    bertanda berarti "sudah diakru dan sudah dipindahkan ke Simpanan
 *    Sukarela di pembukuan lama" (lihat `getStatusTransferBungaPadaDb`).
 *    Mesin akrual melewati nomor periode yang sudah punya baris, sehingga
 *    bunganya tidak diakui dua kali; periode yang berakhir PADA/SETELAH
 *    cut-off tetap diakru & dipindahkan aplikasi seperti biasa.
 *
 * ASUMSI (ditulis juga di template): bunga periode sebelum cut-off sudah
 * dikreditkan ke Simpanan Sukarela anggota dan termasuk saldo sukarela
 * di sheet 2 — sesuai kebijakan produk KOPKU (bunga ke Simpanan
 * Sukarela). Kontrak yang SUDAH jatuh tempo sebelum cut-off ditolak:
 * itu bukan lagi simpanan berjangka yang berjalan.
 */

export interface BarisMigrasiBerjangka {
  anggotaId: string;
  tanggal: string;
  nominal: Rupiah;
  tenorBulan: number;
  sukuBungaPerTahun: number | null;
  sumberDana: 'KAS' | 'BANK';
  keterangan?: string;
  createdBy: string;
  tanggalCutOff: string;
}

export interface HasilMigrasiBerjangka {
  id: string;
  nomorTransaksi: string;
  tanggalJatuhTempo: string;
  /** Banyaknya periode bunga sebelum cut-off yang dicatat tanpa jurnal. */
  periodeBungaSebelumCutOff: number;
  /** Total bunga periode sebelum cut-off (sudah ada di saldo sukarela). */
  bungaSebelumCutOff: Rupiah;
}

export const PESAN_BERJANGKA_SUDAH_JATUH_TEMPO =
  'Simpanan berjangka ini sudah jatuh tempo sebelum tanggal cut-off, jadi bukan simpanan berjangka yang masih berjalan. ' +
  'Selesaikan dulu di pembukuan lama (cairkan/perpanjang), lalu masukkan saldonya sebagai simpanan sukarela atau penempatan baru.';

/** Validasi murni — dipisah agar bisa diuji tanpa database. */
export function periksaBarisMigrasiBerjangka(r: {
  tanggal: string;
  nominal: Rupiah;
  tenorBulan: number;
  tanggalCutOff: string;
}): string | null {
  if (!isTenorSimpananBerjangkaValid(r.tenorBulan)) {
    return `Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${r.tenorBulan}.`;
  }
  if (!Number.isInteger(r.nominal) || r.nominal <= 0) {
    return 'Nominal simpanan berjangka harus bilangan bulat Rupiah lebih besar dari 0.';
  }
  if (!(r.tanggal < r.tanggalCutOff)) {
    return 'Tanggal penempatan harus sebelum tanggal cut-off untuk jalur saldo awal.';
  }
  if (hitungTanggalJatuhTempo(r.tanggal, r.tenorBulan as TenorSimpananBerjangka) < r.tanggalCutOff) {
    return PESAN_BERJANGKA_SUDAH_JATUH_TEMPO;
  }
  return null;
}

async function tulisMigrasiBerjangka(
  db: SQLite.SQLiteDatabase,
  input: BarisMigrasiBerjangka
): Promise<HasilMigrasiBerjangka> {
  await requirePermission(db, input.createdBy, 'simpanan', 'create');
  const galat = periksaBarisMigrasiBerjangka(input);
  if (galat) throw new Error(galat);
  const sukuBunga = normalisasiSukuBunga(input.sukuBungaPerTahun);

  const anggota = await db.getFirstAsync<{ status: string }>(`SELECT status FROM anggota WHERE id = ?`, input.anggotaId);
  if (!anggota) throw new Error('Anggota tidak ditemukan.');
  const cek = checkAnggotaAktif(anggota.status);
  if (!cek.valid) throw new Error(cek.reason);

  const kebijakan =
    (await getKebijakanProdukUntukTanggalPadaDb(db, input.tanggal)) ??
    (await getKebijakanProdukUntukTanggalPadaDb(db, input.tanggalCutOff));
  const tidakLayak = alasanKebijakanTidakLayak(kebijakan);
  if (tidakLayak) throw new Error(tidakLayak);
  const snap = snapshotDariKebijakan(kebijakan!);

  const tenor = input.tenorBulan as TenorSimpananBerjangka;
  const tanggalJatuhTempo = hitungTanggalJatuhTempo(input.tanggal, tenor);
  const tahun = parseInt(input.tanggal.slice(0, 4), 10);
  const nomorTransaksi = await nextSequence(db, 'SPB', tahun);
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
    tenor,
    sukuBunga,
    'AKTIF',
    input.sumberDana,
    null,
    input.keterangan?.trim() || 'Saldo awal simpanan berjangka (import Excel)',
    null,
    null,
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

  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `${PREFIX_CONFIG_MIGRASI_BERJANGKA}${id}`,
    input.tanggalCutOff,
    now
  );

  // Periode bunga yang berakhir SEBELUM cut-off: sudah diakru & sudah
  // dikreditkan ke sukarela di pembukuan lama. Dicatat tanpa jurnal.
  let jumlah = 0;
  let total = 0;
  if (sukuBunga > 0) {
    for (const p of buatJadwalBungaSimpananBerjangka(input.nominal, sukuBunga, tenor, input.tanggal)) {
      if (p.tanggalAkhirPeriode >= input.tanggalCutOff || p.bunga <= 0) continue;
      await db.runAsync(
        `INSERT INTO simpanan_berjangka_bunga
          (id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, journal_id, created_by, created_at,
           jenis_periode, rate_persen)
         VALUES (?,?,?,?,?,NULL,?,?,'KONTRAK',?)`,
        newId(),
        id,
        p.nomorPeriode,
        p.tanggalAkhirPeriode,
        p.bunga,
        input.createdBy,
        now,
        sukuBunga
      );
      jumlah += 1;
      total += p.bunga;
    }
    if (total > 0) {
      await db.runAsync(`UPDATE simpanan_berjangka SET bunga_terakru = ?, updated_at = ? WHERE id = ?`, total, now, id);
    }
  }

  return { id, nomorTransaksi, tanggalJatuhTempo, periodeBungaSebelumCutOff: jumlah, bungaSebelumCutOff: total };
}

/** Satu baris = satu transaksi database (pola sama dengan migrasi simpanan). */
export async function jalankanMigrasiBerjangka(
  db: SQLite.SQLiteDatabase,
  input: BarisMigrasiBerjangka
): Promise<HasilMigrasiBerjangka> {
  let hasil: HasilMigrasiBerjangka | null = null;
  await db.withTransactionAsync(async () => {
    hasil = await tulisMigrasiBerjangka(db, input);
  });
  return hasil as unknown as HasilMigrasiBerjangka;
}

export const KETERBATASAN_SALDO_AWAL_BERJANGKA: readonly string[] = [
  'Simpanan berjangka lama dicatat TANPA jurnal kas; saldo awal akun Simpanan Berjangka diisi otomatis sebesar total nominalnya.',
  'Bunga simpanan berjangka untuk periode yang berakhir sebelum cut-off dianggap SUDAH dikreditkan ke Simpanan Sukarela di pembukuan lama (sudah termasuk saldo sukarela di sheet 2) dan tidak diakru ulang. Bunga periode berikutnya diakru aplikasi seperti biasa.',
];
