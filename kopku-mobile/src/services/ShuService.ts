import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { getLabaRugi, getInformasiShuRAT } from '@/reports/FinancialReports';
import { jasaDataAwalDalamPeriode } from '@/services/PartisipasiDataAwalService';
import {
  hitungRingkasanSHU,
  validasiTotalPersentase,
  KonfigurasiPersentaseSHU,
  RingkasanSHU,
} from '@/accounting/ShuCalculator';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah, percentageOf } from '@/utils/money';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { tentukanSnapshotBasisJasaModal } from '@/services/KebijakanBasisJasaModalService';

/**
 * Service SHU (Sisa Hasil Usaha) — mengelola siklus hidup 3 status
 * (PRD §29, sesuai CHECK constraint kolom shu_konfigurasi.status):
 *   DRAFT     -> konfigurasi persentase tersimpan, belum dihitung.
 *   DIHITUNG  -> sudah dihitung (total_shu & shu_anggota terisi),
 *                masih bisa dihitung ULANG dengan konfirmasi (§11).
 *   DIBAGIKAN -> sudah diposting ke jurnal & ditambahkan ke simpanan
 *                sukarela tiap anggota — final, tidak bisa diulang.
 */

export class ShuSudahDihitungError extends Error {
  constructor(tahunBuku: number) {
    super(
      `SHU tahun buku ${tahunBuku} sudah pernah dihitung sebelumnya. ` +
        `Menghitung ulang akan mengganti seluruh angka sebelumnya. Konfirmasi diperlukan.`
    );
    this.name = 'ShuSudahDihitungError';
  }
}

export class ShuSudahDibagikanError extends Error {
  constructor(tahunBuku: number) {
    super(`SHU tahun buku ${tahunBuku} sudah dibagikan dan tidak bisa dihitung ulang.`);
    this.name = 'ShuSudahDibagikanError';
  }
}

/**
 * Pastikan account_mapping untuk distribusi SHU tersedia. Perlu
 * self-heal (bukan hanya seed sekali di SetupService) supaya koperasi
 * yang sudah setup SEBELUM modul SHU ini ada tetap bisa memakainya
 * tanpa perlu setup ulang dari nol.
 *
 * Audit ulang §4/§9 (permintaan pengguna): 6 dana (Pendidikan/Sosial/
 * Pengurus/Pengawas/Karyawan/Pembangunan Daerah Kerja) SEKARANG
 * masing-masing punya role & akun LIABILITAS sendiri (2-1800..2-1850)
 * — fungsi `bagikanSHU` di bawah TIDAK LAGI meresolusi/memakai role
 * gabungan lama `KREDIT_DANA_LAINNYA` (-> 3-3000 Ekuitas Lainnya) untuk
 * memposting dana-dana ini. Role tersebut TETAP di-self-heal di sini
 * (TIDAK dihapus dari daftar mapping) karena dipakai ulang oleh fitur
 * LAIN yang di luar scope audit ini (KasBankService.tambahRekeningBank/
 * catatSaldoAwalKas, AsetService — saldo awal rekening bank/kas/aset ke
 * "Ekuitas Lainnya") — menghapusnya akan membuat fitur tersebut gagal.
 */
async function pastikanMappingShu(db: SQLite.SQLiteDatabase): Promise<void> {
  const existing = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM account_mapping WHERE transaction_type = 'SHU_DISTRIBUSI'`
  );
  if ((existing?.cnt ?? 0) >= 10) return;

  const mapping: { role: string; kode: string }[] = [
    { role: 'DEBIT_SHU_BERJALAN', kode: '3-4000' },
    { role: 'KREDIT_CADANGAN', kode: '3-2000' },
    // Audit ulang §13/§14 (permintaan pengguna): Cadangan Risiko —
    // akun EKUITAS terpisah dari Cadangan (Umum, role di atas).
    { role: 'KREDIT_CADANGAN_RISIKO', kode: '3-2100' },
    // Dipertahankan untuk KasBankService/AsetService (lihat komentar di
    // atas) — TIDAK dipakai lagi oleh distribusi SHU di bawah.
    { role: 'KREDIT_DANA_LAINNYA', kode: '3-3000' },
    { role: 'KREDIT_DANA_PENDIDIKAN', kode: '2-1800' },
    { role: 'KREDIT_DANA_SOSIAL', kode: '2-1810' },
    { role: 'KREDIT_DANA_PENGURUS', kode: '2-1820' },
    { role: 'KREDIT_DANA_PENGAWAS', kode: '2-1830' },
    { role: 'KREDIT_DANA_KARYAWAN', kode: '2-1840' },
    { role: 'KREDIT_DANA_PEMBANGUNAN_DAERAH_KERJA', kode: '2-1850' },
  ];

  for (const m of mapping) {
    const already = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM account_mapping WHERE transaction_type = 'SHU_DISTRIBUSI' AND role = ?`,
      m.role
    );
    if (already) continue;

    const account = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, m.kode);
    if (!account) {
      throw new Error(
        `Akun dengan kode ${m.kode} tidak ditemukan — dibutuhkan untuk distribusi SHU. ` +
          `Periksa Chart of Accounts di Pengaturan.`
      );
    }
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      newId(),
      'SHU_DISTRIBUSI',
      m.role,
      account.id
    );
  }
}

/** Simpan/ubah konfigurasi persentase SHU untuk satu tahun buku (status -> DRAFT). */
export async function simpanKonfigurasiShu(
  actingUserId: string,
  tahunBuku: number,
  config: KonfigurasiPersentaseSHU
): Promise<{ id: string }> {
  validasiTotalPersentase(config);

  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'shu', 'create');
    const existing = await db.getFirstAsync<{ id: string; status: string }>(
      `SELECT id, status FROM shu_konfigurasi WHERE tahun_buku = ?`,
      tahunBuku
    );
    if (existing?.status === 'DIBAGIKAN') {
      throw new ShuSudahDibagikanError(tahunBuku);
    }

    const now = new Date().toISOString();
    if (existing) {
      // Ubah konfigurasi mereset ke DRAFT — perhitungan sebelumnya (jika
      // ada) jadi tidak berlaku lagi sampai dihitung ulang.
      await db.runAsync(
        `UPDATE shu_konfigurasi SET
           persen_cadangan = ?, persen_jasa_modal = ?, persen_jasa_usaha = ?,
           persen_pendidikan = ?, persen_sosial = ?, persen_pengurus = ?,
           persen_pengawas = ?, persen_karyawan = ?, persen_pembangunan_daerah_kerja = ?,
           persen_cadangan_risiko = ?,
           status = 'DRAFT', total_shu = NULL,
           updated_at = ?
         WHERE id = ?`,
        config.persenCadangan,
        config.persenJasaModal,
        config.persenJasaUsaha,
        config.persenPendidikan,
        config.persenSosial,
        config.persenPengurus,
        config.persenPengawas,
        config.persenKaryawan,
        config.persenPembangunanDaerahKerja,
        config.persenCadanganRisiko,
        now,
        existing.id
      );
      await db.runAsync(`DELETE FROM shu_anggota WHERE shu_konfigurasi_id = ?`, existing.id);
      return { id: existing.id };
    }

    const id = newId();
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha,
         persen_pendidikan, persen_sosial, persen_pengurus, persen_pengawas,
         persen_karyawan, persen_pembangunan_daerah_kerja, persen_cadangan_risiko,
         status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?,?)`,
      id,
      tahunBuku,
      config.persenCadangan,
      config.persenJasaModal,
      config.persenJasaUsaha,
      config.persenPendidikan,
      config.persenSosial,
      config.persenPengurus,
      config.persenPengawas,
      config.persenKaryawan,
      config.persenPembangunanDaerahKerja,
      config.persenCadanganRisiko,
      now,
      now
    );
    return { id };
  });
}

/**
 * Ambil basis perhitungan SHU per anggota aktif (PRD: "Perhitungan SHU
 * berdasarkan data transaksi anggota"):
 *  - basisSimpanan: total simpanan s.d. akhir periode tahun buku,
 *    dijumlahkan langsung dari simpanan_transaksi. Simpanan POKOK + WAJIB
 *    selalu; SUKARELA (termasuk bunga yang sudah dikreditkan) hanya bila
 *    SNAPSHOT kebijakan "Simpanan Sukarela sebagai Basis Jasa Modal SHU"
 *    tahun buku ini ON (`tentukanSnapshotBasisJasaModal`, v78). Juklat SOM
 *    2025 (hlm. 28 & 32) membatasi balas jasa modal pada pokok dan wajib.
 *  - basisPartisipasiUsaha: total porsi jasa pinjaman yang DIBAYAR
 *    anggota selama periode tahun buku, dari angsuran_pembayaran,
 *    DITAMBAH jasa yang dibayar sebelum cut-off data awal (RC-S133.4.3,
 *    PartisipasiDataAwalService).
 * Keduanya query agregat langsung ke tabel transaksi — bukan data rekaan.
 */
/** Diekspor untuk pengujian integrasi basis jasa modal (perilaku tidak berubah). */
export async function getBasisAnggotaSHU(
  db: SQLite.SQLiteDatabase,
  periodeMulai: string,
  periodeSelesai: string,
  sukarelaIkutBasis: boolean
): Promise<{ anggotaId: string; namaAnggota: string; nomorAnggota: string; basisSimpanan: Rupiah; basisPartisipasiUsaha: Rupiah }[]> {
  const filterJenis = sukarelaIkutBasis ? '' : `AND jenis IN ('POKOK','WAJIB')`;
  const anggotaRows = await db.getAllAsync<{ id: string; nama_lengkap: string; nomor_anggota: string }>(
    `SELECT id, nama_lengkap, nomor_anggota FROM anggota WHERE status = 'AKTIF' ORDER BY nama_lengkap ASC`
  );

  // BUG FIX (Prioritas 3/E — sama seperti SimpananService.getSaldoSimpanan):
  // exclude juga baris ASLI yang sudah dikoreksi (bukan cuma baris
  // koreksinya sendiri) supaya basis SHU tidak ikut menghitung setoran
  // yang sebenarnya sudah dibatalkan/dikoreksi lewat reversal jurnal.
  const simpananRows = await db.getAllAsync<{ anggota_id: string; total: number }>(
    `SELECT anggota_id,
            COALESCE(SUM(CASE WHEN tipe = 'SETOR' THEN nominal WHEN tipe = 'TARIK' THEN -nominal ELSE 0 END), 0) as total
     FROM simpanan_transaksi
     WHERE reversal_of_id IS NULL
       AND id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)
       AND tanggal <= ?
       ${filterJenis}
     GROUP BY anggota_id`,
    periodeSelesai
  );
  const simpananByAnggota = new Map(simpananRows.map((r) => [r.anggota_id, r.total]));

  const partisipasiRows = await db.getAllAsync<{ anggota_id: string; total: number }>(
    `SELECT p.anggota_id, COALESCE(SUM(ap.porsi_jasa), 0) as total
     FROM angsuran_pembayaran ap
     JOIN pinjaman p ON p.id = ap.pinjaman_id
     WHERE ap.tanggal BETWEEN ? AND ?
     GROUP BY p.anggota_id`,
    periodeMulai,
    periodeSelesai
  );
  const partisipasiByAnggota = new Map(partisipasiRows.map((r) => [r.anggota_id, r.total]));
  // RC-S133.4.3 — jasa yang sudah dibayar SEBELUM cut-off data awal
  // (sheet "6. Jasa Dibayar"). Angsuran sebelum cut-off tidak pernah
  // tercatat di angsuran_pembayaran (import jalur saldo lama), jadi
  // tanpa ini jasa Jan–cut-off hilang dari dasar SHU jasa usaha.
  for (const [anggotaId, jasa] of await jasaDataAwalDalamPeriode(db, periodeMulai, periodeSelesai)) {
    partisipasiByAnggota.set(anggotaId, (partisipasiByAnggota.get(anggotaId) ?? 0) + jasa);
  }

  return anggotaRows.map((a) => ({
    anggotaId: a.id,
    namaAnggota: a.nama_lengkap,
    nomorAnggota: a.nomor_anggota,
    basisSimpanan: simpananByAnggota.get(a.id) ?? 0,
    basisPartisipasiUsaha: partisipasiByAnggota.get(a.id) ?? 0,
  }));
}

export interface HitungShuResult {
  shuKonfigurasiId: string;
  ringkasan: RingkasanSHU;
}

/**
 * Hitung SHU untuk satu tahun buku.
 *
 * Audit ulang (permintaan pengguna, request baru §1/§2/§3): SEKARANG
 * menghitung DUA angka SHU sekaligus dari SATU pemanggilan, keduanya
 * dari accounting engine yang sama (§3 — tidak ada transaksi/jurnal
 * baru dibuat untuk ini):
 *  - `total_shu` (TIDAK DIUBAH maknanya) = SHU Laporan Keuangan, basis
 *    AKRUAL, dari getLabaRugi() — dipakai laporan keuangan resmi
 *    (Laba Rugi/SHU, Posisi Keuangan, Perubahan Ekuitas, Arus Kas,
 *    CALK). TIDAK PERNAH diubah oleh keputusan RAT apa pun setelah ini
 *    (§11 — "Jangan mengubah nilai SHU laporan keuangan setelah RAT").
 *  - `shu_informasi_rat` (BARU) = Informasi SHU RAT, basis KAS/realisasi,
 *    dari getInformasiShuRAT() — MURNI informasi tambahan untuk
 *    membantu RAT memutuskan, BUKAN pengganti laporan keuangan (§2).
 *
 * Preview distribusi (shu_anggota) di bawah ini MASIH dihitung dari
 * `total_shu` (akrual) — ini HANYA pratinjau/referensi ("kalau
 * memakai SHU Laporan Keuangan, distribusinya begini"), BUKAN
 * distribusi final. Distribusi FINAL yang benar-benar dijurnal saat
 * `bagikanSHU()` HARUS berasal dari `shu_disahkan_rat` (diisi lewat
 * `sahkanShuRAT()` di bawah, SETELAH RAT memutuskan) — `sahkanShuRAT()`
 * akan MENGHITUNG ULANG & MENIMPA shu_anggota dengan basis yang benar
 * sebelum SHU boleh dibagikan (§4/§5/§6).
 *
 * Validasi (fase ini): jika tahun buku ini SUDAH pernah dihitung
 * sebelumnya (status DIHITUNG atau setelahnya), fungsi ini REJECT
 * kecuali `konfirmasiUlang: true` dikirim eksplisit oleh caller (UI
 * menampilkan dialog konfirmasi terlebih dahulu). Jika sudah
 * DIBAGIKAN, selalu REJECT.
 */
export async function hitungSHU(
  tahunBuku: number,
  createdBy: string,
  konfirmasiUlang = false
): Promise<HitungShuResult> {
  return withTransaction(async (db) => {
    await requirePermission(db, createdBy, 'shu', 'create');
    const konfigurasi = await db.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE tahun_buku = ?`, tahunBuku);
    if (!konfigurasi) {
      throw new Error(`Konfigurasi persentase SHU untuk tahun buku ${tahunBuku} belum disimpan.`);
    }
    if (konfigurasi.status === 'DIBAGIKAN') {
      throw new ShuSudahDibagikanError(tahunBuku);
    }
    if (konfigurasi.status !== 'DRAFT' && !konfirmasiUlang) {
      throw new ShuSudahDihitungError(tahunBuku);
    }

    const periode = await db.getFirstAsync<{ periode_mulai: string; periode_selesai: string }>(
      `SELECT periode_mulai, periode_selesai FROM accounting_period WHERE tahun_buku = ?`,
      tahunBuku
    );
    if (!periode) {
      throw new Error(`Periode akuntansi untuk tahun buku ${tahunBuku} belum ada.`);
    }

    const labaRugi = await getLabaRugi(db, periode.periode_mulai, periode.periode_selesai);
    const totalSHU = labaRugi.hasilUsaha;
    // Audit ulang §1/§2: Informasi SHU RAT (basis kas) dihitung dari
    // jurnal yang SAMA (bukan transaksi baru) — lihat komentar
    // panjang `getInformasiShuRAT` di FinancialReports.ts.
    const informasiRat = await getInformasiShuRAT(db, periode.periode_mulai, periode.periode_selesai);

    const basisAnggota = await getBasisAnggotaSHU(
      db,
      periode.periode_mulai,
      periode.periode_selesai,
      await tentukanSnapshotBasisJasaModal(db, konfigurasi)
    );

    const config: KonfigurasiPersentaseSHU = {
      persenCadangan: konfigurasi.persen_cadangan,
      persenJasaModal: konfigurasi.persen_jasa_modal,
      persenJasaUsaha: konfigurasi.persen_jasa_usaha,
      persenPendidikan: konfigurasi.persen_pendidikan,
      persenSosial: konfigurasi.persen_sosial,
      persenPengurus: konfigurasi.persen_pengurus,
      persenPengawas: konfigurasi.persen_pengawas,
      persenKaryawan: konfigurasi.persen_karyawan,
      persenPembangunanDaerahKerja: konfigurasi.persen_pembangunan_daerah_kerja,
      persenCadanganRisiko: konfigurasi.persen_cadangan_risiko,
    };

    const ringkasan = hitungRingkasanSHU(
      totalSHU,
      config,
      basisAnggota.map((b) => ({
        anggotaId: b.anggotaId,
        basisSimpanan: b.basisSimpanan,
        basisPartisipasiUsaha: b.basisPartisipasiUsaha,
      }))
    );

    // Ganti seluruh hasil perhitungan sebelumnya (jika hitung ulang).
    await db.runAsync(`DELETE FROM shu_anggota WHERE shu_konfigurasi_id = ?`, konfigurasi.id);
    for (const a of ringkasan.anggota) {
      await db.runAsync(
        `INSERT INTO shu_anggota
          (id, shu_konfigurasi_id, anggota_id, basis_simpanan, basis_partisipasi_usaha, jasa_modal, jasa_usaha, total_shu_anggota)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(),
        konfigurasi.id,
        a.anggotaId,
        a.basisSimpanan,
        a.basisPartisipasiUsaha,
        a.jasaModal,
        a.jasaUsaha,
        a.totalShuAnggota
      );
    }

    // Audit ulang §1/§7: hitung ulang (konfirmasiUlang) SEKARANG me-
    // reset seluruh field turunan RAT (diajukan/disahkan/rat_id/
    // catatan) — kalau konfigurasi/basis berubah & dihitung ulang,
    // pengajuan/pengesahan RAT SEBELUMNYA (kalau ada, dari siklus lama)
    // sudah tidak relevan lagi dan HARUS diajukan/disahkan ulang,
    // bukan diam-diam dipertahankan mengacu ke angka lama. Ini TIDAK
    // mungkin terjadi untuk status DIBAGIKAN (sudah ditolak di atas).
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE shu_konfigurasi SET
         total_shu = ?, shu_informasi_rat = ?,
         shu_diajukan_rat = NULL, shu_disahkan_rat = NULL, rat_id = NULL, catatan_keputusan_rat = NULL,
         status = 'DIHITUNG', updated_at = ?
       WHERE id = ?`,
      totalSHU,
      informasiRat.shuInformasiRat,
      now,
      konfigurasi.id
    );

    return { shuKonfigurasiId: konfigurasi.id, ringkasan };
  });
}

// ============================================================
// PENETAPAN SHU DALAM RAT (audit ulang, permintaan pengguna, request
// baru §4/§5/§6/§7): alur keputusan —
//   Informasi SHU RAT (dihitung di hitungSHU di atas)
//         -> ajukanShuKeRAT()   (status DIHITUNG -> DIAJUKAN_RAT)
//         -> sahkanShuRAT()     (status DIAJUKAN_RAT -> DISAHKAN_RAT)
//         -> bagikanSHU()       (status DISAHKAN_RAT -> DIBAGIKAN)
// RAT SELALU jadi titik keputusan — SHU yang benar-benar dibagikan
// TIDAK PERNAH otomatis mengambil SHU akrual maupun SHU kas penuh,
// HARUS lewat `shu_disahkan_rat` yang diisi di sini.
// ============================================================

export class ShuBelumDihitungError extends Error {
  constructor(tahunBuku: number) {
    super(`SHU tahun buku ${tahunBuku} belum dihitung. Hitung SHU terlebih dahulu.`);
    this.name = 'ShuBelumDihitungError';
  }
}

/**
 * Ajukan nominal SHU ke RAT untuk diputuskan (status DIHITUNG/
 * DIAJUKAN_RAT -> DIAJUKAN_RAT). Nominal yang diajukan BOLEH berbeda
 * dari `shu_informasi_rat` (kas) maupun `total_shu` (akrual) — admin
 * bebas mengusulkan angka berdasarkan pertimbangannya sendiri, tapi
 * TIDAK BOLEH melebihi SHU Laporan Keuangan (akrual) — batas atas
 * mutlak, karena koperasi tidak mungkin mengajukan pembagian melebihi
 * SHU yang benar-benar dihasilkan menurut laporan keuangan resmi (§11).
 *
 * Mengajukan ULANG (dari status DIAJUKAN_RAT) diperbolehkan SELAMA
 * belum disahkan — mengganti nominal yang diajukan sebelumnya, BUKAN
 * menambah baris baru (satu SHU per tahun buku, pola sama seperti
 * `shu_konfigurasi` itu sendiri).
 */
export async function ajukanShuKeRAT(
  actingUserId: string,
  tahunBuku: number,
  nominalDiajukan: Rupiah
): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'shu', 'create');
    const konfigurasi = await db.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE tahun_buku = ?`, tahunBuku);
    if (!konfigurasi) throw new Error(`Konfigurasi SHU untuk tahun buku ${tahunBuku} belum ada.`);
    if (konfigurasi.status === 'DIBAGIKAN') throw new ShuSudahDibagikanError(tahunBuku);
    if (konfigurasi.status !== 'DIHITUNG' && konfigurasi.status !== 'DIAJUKAN_RAT') {
      throw new ShuBelumDihitungError(tahunBuku);
    }
    if (!Number.isFinite(nominalDiajukan) || nominalDiajukan <= 0) {
      throw new Error('Nominal yang diajukan ke RAT harus lebih dari 0.');
    }
    if (nominalDiajukan > (konfigurasi.total_shu ?? 0)) {
      throw new Error(
        `Nominal yang diajukan (Rp${nominalDiajukan.toLocaleString('id-ID')}) tidak boleh melebihi SHU Laporan ` +
          `Keuangan (Rp${(konfigurasi.total_shu ?? 0).toLocaleString('id-ID')}).`
      );
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE shu_konfigurasi SET shu_diajukan_rat = ?, status = 'DIAJUKAN_RAT', updated_at = ? WHERE id = ?`,
      nominalDiajukan,
      now,
      konfigurasi.id
    );
  });
}

export interface SahkanShuRATInput {
  tahunBuku: number;
  nominalDisahkan: Rupiah;
  catatan?: string;
  actingUserId: string;
}

/**
 * Sahkan nominal SHU final hasil keputusan RAT (status DIAJUKAN_RAT/
 * DISAHKAN_RAT -> DISAHKAN_RAT). SATU-SATUNYA cara mengisi
 * `shu_disahkan_rat` — nilai inilah yang dipakai `bagikanSHU()` di
 * bawah, BUKAN total_shu (akrual) atau shu_informasi_rat (kas) secara
 * langsung (§5/§6).
 *
 * Distribusi per-anggota (`shu_anggota`) DIHITUNG ULANG di sini
 * memakai `nominalDisahkan` sebagai basis (rumus/persentase distribusi
 * di ShuCalculator.ts TIDAK diubah sama sekali — §6: "yang berubah
 * hanya sumber nilai totalnya") — MENIMPA hasil preview akrual dari
 * `hitungSHU()`, supaya breakdown per-komponen & per-anggota yang
 * ditampilkan SELALU konsisten dengan apa yang akan benar-benar
 * dijurnal saat dibagikan.
 *
 * Data RAT (tabel `rat`, RATService.ts existing — TIDAK dibuat tabel
 * baru, §8/§12) WAJIB sudah ada & tanggal pelaksanaannya sudah lewat/
 * sama dengan hari ini — gerbang yang SAMA dengan yang sebelumnya ada
 * di `bagikanSHU()` (dipindah ke sini karena di sinilah titik
 * "pengesahan" yang sesungguhnya sekarang berada; `bagikanSHU()`
 * tetap menjaga gerbang status DISAHKAN_RAT sebagai lapis pertahanan
 * kedua).
 */
export async function sahkanShuRAT(input: SahkanShuRATInput): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'shu', 'approve');
    const konfigurasi = await db.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE tahun_buku = ?`, input.tahunBuku);
    if (!konfigurasi) throw new Error(`Konfigurasi SHU untuk tahun buku ${input.tahunBuku} belum ada.`);
    if (konfigurasi.status === 'DIBAGIKAN') throw new ShuSudahDibagikanError(input.tahunBuku);
    if (konfigurasi.status !== 'DIAJUKAN_RAT' && konfigurasi.status !== 'DISAHKAN_RAT') {
      throw new Error(`SHU tahun buku ${input.tahunBuku} belum diajukan ke RAT. Ajukan terlebih dahulu sebelum disahkan.`);
    }
    if (!Number.isFinite(input.nominalDisahkan) || input.nominalDisahkan <= 0) {
      throw new Error('Nominal yang disahkan RAT harus lebih dari 0.');
    }
    // §11: SHU disahkan RAT tidak boleh melebihi nilai yang diajukan
    // (RAT bisa menyahkan LEBIH KECIL atau SAMA DENGAN yang diajukan,
    // tidak boleh lebih besar dari yang sudah diusulkan/dianalisis).
    if (input.nominalDisahkan > (konfigurasi.shu_diajukan_rat ?? 0)) {
      throw new Error(
        `Nominal yang disahkan (Rp${input.nominalDisahkan.toLocaleString('id-ID')}) tidak boleh melebihi nominal ` +
          `yang diajukan ke RAT (Rp${(konfigurasi.shu_diajukan_rat ?? 0).toLocaleString('id-ID')}).`
      );
    }

    const rat = await db.getFirstAsync<{ id: string; tanggal_rat: string }>(
      `SELECT id, tanggal_rat FROM rat WHERE tahun_buku = ?`,
      input.tahunBuku
    );
    if (!rat || !rat.tanggal_rat) {
      throw new Error('SHU baru dapat disahkan setelah RAT dilaksanakan. Lengkapi data RAT (Pelaksanaan RAT) terlebih dahulu.');
    }
    const hariIni = getTanggalLokalHariIni();
    if (hariIni < rat.tanggal_rat) {
      throw new Error(`SHU dapat disahkan mulai setelah RAT dilaksanakan pada ${formatTanggalIndonesia(rat.tanggal_rat)}.`);
    }

    const periode = await db.getFirstAsync<{ periode_mulai: string; periode_selesai: string }>(
      `SELECT periode_mulai, periode_selesai FROM accounting_period WHERE tahun_buku = ?`,
      input.tahunBuku
    );
    if (!periode) throw new Error(`Periode akuntansi untuk tahun buku ${input.tahunBuku} belum ada.`);

    const basisAnggota = await getBasisAnggotaSHU(
      db,
      periode.periode_mulai,
      periode.periode_selesai,
      await tentukanSnapshotBasisJasaModal(db, konfigurasi)
    );
    const config: KonfigurasiPersentaseSHU = {
      persenCadangan: konfigurasi.persen_cadangan,
      persenJasaModal: konfigurasi.persen_jasa_modal,
      persenJasaUsaha: konfigurasi.persen_jasa_usaha,
      persenPendidikan: konfigurasi.persen_pendidikan,
      persenSosial: konfigurasi.persen_sosial,
      persenPengurus: konfigurasi.persen_pengurus,
      persenPengawas: konfigurasi.persen_pengawas,
      persenKaryawan: konfigurasi.persen_karyawan,
      persenPembangunanDaerahKerja: konfigurasi.persen_pembangunan_daerah_kerja,
      persenCadanganRisiko: konfigurasi.persen_cadangan_risiko,
    };

    // Rumus/persentase distribusi (hitungRingkasanSHU) TIDAK diubah —
    // hanya sumber totalnya yang sekarang shu_disahkan_rat (§6).
    const ringkasan = hitungRingkasanSHU(
      input.nominalDisahkan,
      config,
      basisAnggota.map((b) => ({
        anggotaId: b.anggotaId,
        basisSimpanan: b.basisSimpanan,
        basisPartisipasiUsaha: b.basisPartisipasiUsaha,
      }))
    );

    await db.runAsync(`DELETE FROM shu_anggota WHERE shu_konfigurasi_id = ?`, konfigurasi.id);
    for (const a of ringkasan.anggota) {
      await db.runAsync(
        `INSERT INTO shu_anggota
          (id, shu_konfigurasi_id, anggota_id, basis_simpanan, basis_partisipasi_usaha, jasa_modal, jasa_usaha, total_shu_anggota)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(),
        konfigurasi.id,
        a.anggotaId,
        a.basisSimpanan,
        a.basisPartisipasiUsaha,
        a.jasaModal,
        a.jasaUsaha,
        a.totalShuAnggota
      );
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE shu_konfigurasi SET
         shu_disahkan_rat = ?, rat_id = ?, catatan_keputusan_rat = ?, status = 'DISAHKAN_RAT', updated_at = ?
       WHERE id = ?`,
      input.nominalDisahkan,
      rat.id,
      input.catatan?.trim() || null,
      now,
      konfigurasi.id
    );
  });
}

/**
 * Bagikan SHU yang sudah disahkan RAT (status DISAHKAN_RAT -> DIBAGIKAN):
 *  - Posting SATU jurnal konsolidasi lewat AccountingEngine (pakai
 *    accounting engine yang sudah tersedia, bukan bikin engine baru):
 *      DEBIT  SHU Tahun Berjalan          (SHU DISAHKAN RAT — audit
 *                                          ulang, permintaan pengguna
 *                                          request baru §5/§6: BUKAN
 *                                          lagi total_shu/akrual atau
 *                                          shu_informasi_rat/kas.
 *                                          Lihat `shu_disahkan_rat`,
 *                                          diisi lewat `sahkanShuRAT()`
 *                                          di atas — SATU-SATUNYA
 *                                          sumber nominal di sini)
 *      KREDIT Cadangan (3-2000)           (residual — lihat komentar
 *                                          `cadanganNominal` di bawah)
 *      KREDIT Dana Pendidikan (2-1800)    (LIABILITAS)
 *      KREDIT Dana Sosial (2-1810)        (LIABILITAS)
 *      KREDIT Dana Pengurus (2-1820)      (LIABILITAS)
 *      KREDIT Dana Pengawas (2-1830)      (LIABILITAS)
 *      KREDIT Dana Karyawan (2-1840)      (LIABILITAS)
 *      KREDIT Dana Pembangunan Daerah Kerja (2-1850) (LIABILITAS)
 *      KREDIT Simpanan Sukarela           (total porsi seluruh anggota)
 *    Audit ulang §4/§9 (permintaan pengguna): 6 dana di atas TIDAK LAGI
 *    dilebur ke 3-3000 Ekuitas Lainnya lewat role gabungan
 *    "KREDIT_DANA_LAINNYA" — masing-masing sekarang punya akun
 *    LIABILITAS sendiri. Tidak ada lagi komponen "Lainnya" di jurnal
 *    distribusi SHU (role "KREDIT_DANA_LAINNYA" itu sendiri MASIH ADA
 *    di account_mapping — dipakai fitur lain di luar modul SHU, lihat
 *    komentar `pastikanMappingShu` di atas — hanya SUDAH TIDAK dipakai
 *    oleh fungsi ini).
 *  - Membuat baris simpanan_transaksi (SETOR, SUKARELA) per anggota
 *    sebesar total_shu_anggota masing-masing, mereferensikan jurnal
 *    konsolidasi yang sama — supaya otomatis muncul di saldo & histori
 *    simpanan anggota (repository yang sudah ada, tidak diubah).
 */
export async function bagikanSHU(tahunBuku: number, createdBy: string): Promise<{ journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, createdBy, 'shu', 'approve');
    await pastikanMappingShu(db);

    const konfigurasi = await db.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE tahun_buku = ?`, tahunBuku);
    if (!konfigurasi) throw new Error(`Konfigurasi SHU untuk tahun buku ${tahunBuku} belum ada.`);
    if (konfigurasi.status === 'DIBAGIKAN') throw new ShuSudahDibagikanError(tahunBuku);
    // Audit ulang §5/§6/§7 (permintaan pengguna, request baru): gerbang
    // UTAMA sekarang status DISAHKAN_RAT (bukan lagi DIHITUNG) — "SHU
    // belum disahkan dalam RAT" adalah alasan eksplisit yang diminta
    // (§7) kalau tombol/pemanggilan ini ditolak.
    if (konfigurasi.status !== 'DISAHKAN_RAT') {
      throw new Error(`SHU belum disahkan dalam RAT.`);
    }
    if (!Number.isFinite(konfigurasi.shu_disahkan_rat) || konfigurasi.shu_disahkan_rat <= 0) {
      throw new Error(
        `SHU tahun buku ${tahunBuku} belum memiliki nominal disahkan RAT yang valid — sahkan ulang lewat RAT.`
      );
    }
    // Lapis pertahanan kedua (defense in depth) — gerbang tanggal RAT
    // yang SAMA sudah ditegakkan di `sahkanShuRAT()` sebelum status
    // bisa mencapai DISAHKAN_RAT, tapi dicek ulang di sini supaya
    // fungsi ini tetap aman dipanggil mandiri/langsung.
    //
    // Tanggal dibandingkan sebagai STRING ISO (YYYY-MM-DD) — pola yang
    // SAMA dipakai di seluruh app ini (PeriodCloseService, RATService,
    // dst.) — perbandingan string kalender murni ini SENGAJA dipakai
    // supaya tidak ada pergeseran tanggal akibat konversi timezone
    // (UTC mentah dari `Date` object bisa membuat "hari ini" versi
    // lokal Indonesia jadi salah kalau dibandingkan sebagai instant/
    // epoch — dengan string YYYY-MM-DD, "hari ini" & "tanggal RAT"
    // selalu dibandingkan sebagai tanggal kalender murni, konsisten
    // dengan bagaimana `tanggal_rat`/`tanggal` disimpan di seluruh
    // tabel app ini).
    const rat = await db.getFirstAsync<{ id: string; tanggal_rat: string }>(
      `SELECT id, tanggal_rat FROM rat WHERE tahun_buku = ?`,
      tahunBuku
    );
    if (!rat || !rat.tanggal_rat) {
      throw new Error('SHU baru dapat dibagikan setelah RAT dilaksanakan.');
    }
    const hariIni = getTanggalLokalHariIni();
    if (hariIni < rat.tanggal_rat) {
      throw new Error(`SHU dapat dibagikan mulai setelah RAT dilaksanakan pada ${formatTanggalIndonesia(rat.tanggal_rat)}.`);
    }

    const anggotaRows = await db.getAllAsync<{ anggota_id: string; total_shu_anggota: number }>(
      `SELECT anggota_id, total_shu_anggota FROM shu_anggota WHERE shu_konfigurasi_id = ? AND total_shu_anggota != 0`,
      konfigurasi.id
    );

    const totalPorsiAnggota = anggotaRows.reduce((acc, r) => acc + r.total_shu_anggota, 0);

    // Audit ulang §4/§7/§9 (permintaan pengguna), diperbarui lagi di
    // audit ulang request baru §5/§6: 6 pool dana dihitung dari
    // persentase EXISTING (persen_pendidikan, dst. — TIDAK DIUBAH) DAN
    // dari `shu_disahkan_rat` (BUKAN lagi total_shu/akrual) memakai
    // fungsi pembulatan yang SAMA (`percentageOf`) dengan
    // ShuCalculator.ts, supaya nominal yang dijurnal di sini PERSIS
    // konsisten dengan breakdown yang dihitung ulang di `sahkanShuRAT()`
    // di atas. Cadangan dihitung sebagai RESIDUAL (SHU disahkan RAT
    // dikurangi seluruh porsi anggota & 6 dana di atas) — pola yang
    // SAMA dengan `hitungRingkasanSHU()` (selisih pembulatan & sisa
    // pool jasa modal/usaha yang tidak terbagi ke anggota otomatis ikut
    // terserap ke sini, TANPA komponen "Lainnya"). `persen_cadangan`
    // itu sendiri TIDAK dipakai untuk menghitung ulang di sini secara
    // independen — nominalnya SELALU mengikuti residual supaya total
    // debit = total kredit persis, sama seperti saat disahkan.
    const shuDisahkan = konfigurasi.shu_disahkan_rat;
    const pendidikanNominal = percentageOf(shuDisahkan, konfigurasi.persen_pendidikan);
    const sosialNominal = percentageOf(shuDisahkan, konfigurasi.persen_sosial);
    const pengurusNominal = percentageOf(shuDisahkan, konfigurasi.persen_pengurus);
    const pengawasNominal = percentageOf(shuDisahkan, konfigurasi.persen_pengawas);
    const karyawanNominal = percentageOf(shuDisahkan, konfigurasi.persen_karyawan);
    const pembangunanDaerahKerjaNominal = percentageOf(shuDisahkan, konfigurasi.persen_pembangunan_daerah_kerja);
    // Audit ulang §13/§14/§15/§16 (permintaan pengguna): Cadangan
    // Risiko — pool NOMINAL TETAP (persentase × SHU disahkan), SAMA
    // seperti 6 dana di atas — BEDA dari Cadangan (Umum) yang tetap
    // satu-satunya penyerap residual. `konfigurasi.persen_cadangan_risiko`
    // default 0 untuk konfigurasi lama (kolom di-ADD via migration v30
    // dengan DEFAULT 0), jadi baris jurnalnya otomatis tidak muncul
    // (nominal 0) untuk SHU yang sudah dihitung sebelum fitur ini ada.
    const cadanganRisikoNominal = percentageOf(shuDisahkan, konfigurasi.persen_cadangan_risiko ?? 0);
    const cadanganNominal =
      shuDisahkan -
      totalPorsiAnggota -
      cadanganRisikoNominal -
      pendidikanNominal -
      sosialNominal -
      pengurusNominal -
      pengawasNominal -
      karyawanNominal -
      pembangunanDaerahKerjaNominal;

    if (cadanganNominal < 0) {
      throw new Error(
        `Perhitungan distribusi SHU tahun buku ${tahunBuku} menghasilkan nominal Cadangan Umum negatif (${cadanganNominal}). ` +
          `Sahkan ulang SHU RAT dengan nominal yang sesuai sebelum membagikan.`
      );
    }

    const shuBerjalanAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'DEBIT_SHU_BERJALAN');
    const cadanganAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_CADANGAN');
    const cadanganRisikoAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_CADANGAN_RISIKO');
    const pendidikanAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_PENDIDIKAN');
    const sosialAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_SOSIAL');
    const pengurusAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_PENGURUS');
    const pengawasAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_PENGAWAS');
    const karyawanAccountId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_KARYAWAN');
    const pembangunanDaerahKerjaAccountId = await resolveAccountId(
      db,
      'SHU_DISTRIBUSI',
      'KREDIT_DANA_PEMBANGUNAN_DAERAH_KERJA'
    );
    const simpananSukarelaAccountId = await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT');

    const tanggal = getTanggalLokalHariIni();
    const nomorReferensi = await nextSequence(db, 'SHU', tahunBuku);

    const lines: { accountId: string; debit: number; kredit: number }[] = [
      // Audit ulang §5/§6 (permintaan pengguna, request baru): DEBIT
      // SHU Tahun Berjalan sekarang sebesar SHU DISAHKAN RAT
      // (`shuDisahkan`), BUKAN total_shu (akrual) lagi.
      { accountId: shuBerjalanAccountId, debit: shuDisahkan, kredit: 0 },
    ];
    if (cadanganNominal !== 0) lines.push({ accountId: cadanganAccountId, debit: 0, kredit: cadanganNominal });
    if (cadanganRisikoNominal !== 0)
      lines.push({ accountId: cadanganRisikoAccountId, debit: 0, kredit: cadanganRisikoNominal });
    if (pendidikanNominal !== 0) lines.push({ accountId: pendidikanAccountId, debit: 0, kredit: pendidikanNominal });
    if (sosialNominal !== 0) lines.push({ accountId: sosialAccountId, debit: 0, kredit: sosialNominal });
    if (pengurusNominal !== 0) lines.push({ accountId: pengurusAccountId, debit: 0, kredit: pengurusNominal });
    if (pengawasNominal !== 0) lines.push({ accountId: pengawasAccountId, debit: 0, kredit: pengawasNominal });
    if (karyawanNominal !== 0) lines.push({ accountId: karyawanAccountId, debit: 0, kredit: karyawanNominal });
    if (pembangunanDaerahKerjaNominal !== 0)
      lines.push({ accountId: pembangunanDaerahKerjaAccountId, debit: 0, kredit: pembangunanDaerahKerjaNominal });
    if (totalPorsiAnggota !== 0) lines.push({ accountId: simpananSukarelaAccountId, debit: 0, kredit: totalPorsiAnggota });

    const { journalId } = await createJournal(db, {
      tanggal,
      sumberTransaksi: 'SHU_DISTRIBUSI',
      sumberId: konfigurasi.id,
      nomorReferensi,
      deskripsi: `Distribusi SHU tahun buku ${tahunBuku} - ${nomorReferensi}`,
      createdBy,
      lines,
    });

    for (const row of anggotaRows) {
      const idTrx = newId();
      const nomorTransaksi = await nextSequence(db, `SHU-ANGGOTA`, tahunBuku);
      await db.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, keterangan, journal_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        idTrx,
        row.anggota_id,
        'SUKARELA',
        'SETOR',
        tanggal,
        row.total_shu_anggota,
        'KAS',
        nomorTransaksi,
        `SHU tahun buku ${tahunBuku}`,
        journalId,
        createdBy,
        new Date().toISOString()
      );
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE shu_konfigurasi SET status = 'DIBAGIKAN', journal_id = ?, updated_at = ? WHERE id = ?`,
      journalId,
      now,
      konfigurasi.id
    );

    return { journalId };
  });
}

/**
 * Hapus konfigurasi SHU (Phase 17 §F). HANYA diizinkan untuk status
 * DRAFT atau DIHITUNG — SHU yang sudah DIBAGIKAN sudah menghasilkan
 * jurnal final & baris simpanan_transaksi per anggota (lihat
 * `bagikanSHU`), jadi tidak boleh dihapus lewat sini sama sekali
 * supaya ledger tidak jadi tidak seimbang/orphan. `shu_anggota` ikut
 * terhapus otomatis lewat ON DELETE CASCADE di schema.
 */
export async function hapusKonfigurasiShu(actingUserId: string, tahunBuku: number): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'shu', 'edit'); // hapus dianggap setara edit-destruktif (pola sama dengan deleteAnggota)
    const konfigurasi = await db.getFirstAsync<{ id: string; status: string }>(
      `SELECT id, status FROM shu_konfigurasi WHERE tahun_buku = ?`,
      tahunBuku
    );
    if (!konfigurasi) throw new Error(`Konfigurasi SHU untuk tahun buku ${tahunBuku} tidak ditemukan.`);
    if (konfigurasi.status === 'DIBAGIKAN') {
      throw new Error(
        `SHU tahun buku ${tahunBuku} sudah dibagikan dan sudah menghasilkan jurnal final — tidak dapat dihapus.`
      );
    }
    await db.runAsync(`DELETE FROM shu_konfigurasi WHERE id = ?`, konfigurasi.id);
  });
}

// ============================================================
// FUNGSI BACA — riwayat, detail, daftar anggota (PRD §29)
// ============================================================

export interface ShuKonfigurasiRow {
  id: string;
  tahunBuku: number;
  persenCadangan: number;
  persenJasaModal: number;
  persenJasaUsaha: number;
  persenPendidikan: number;
  persenSosial: number;
  persenPengurus: number;
  persenPengawas: number;
  persenKaryawan: number;
  persenPembangunanDaerahKerja: number;
  /** Audit ulang §13/§16: komponen distribusi baru — "Cadangan Risiko". Default 0 untuk konfigurasi lama. */
  persenCadanganRisiko: number;
  /** SHU Laporan Keuangan (basis AKRUAL, dari getLabaRugi) — TIDAK PERNAH diubah oleh keputusan RAT apa pun. */
  totalShu: Rupiah | null;
  /** Audit ulang (permintaan pengguna, request baru §1/§2): Informasi SHU RAT (basis KAS/realisasi) — murni informasi, BUKAN pengganti totalShu. Null untuk baris lama sebelum fitur ini ada. */
  shuInformasiRat: Rupiah | null;
  /** Audit ulang §4: nominal yang diajukan ke RAT untuk diputuskan. Null sebelum diajukan. */
  shuDiajukanRat: Rupiah | null;
  /** Audit ulang §5/§6: nominal FINAL disahkan RAT — SATU-SATUNYA basis distribusi & jurnal pembagian. Null sebelum disahkan. */
  shuDisahkanRat: Rupiah | null;
  /** Audit ulang §8: id baris `rat` (RATService) yang menyahkan nominal di atas. */
  ratId: string | null;
  /** Audit ulang §4: catatan keputusan RAT (opsional). */
  catatanKeputusanRat: string | null;
  status: 'DRAFT' | 'DIHITUNG' | 'DIAJUKAN_RAT' | 'DISAHKAN_RAT' | 'DIBAGIKAN';
}

function rowToShuKonfigurasi(r: any): ShuKonfigurasiRow {
  return {
    id: r.id,
    tahunBuku: r.tahun_buku,
    persenCadangan: r.persen_cadangan,
    persenJasaModal: r.persen_jasa_modal,
    persenJasaUsaha: r.persen_jasa_usaha,
    persenPendidikan: r.persen_pendidikan,
    persenSosial: r.persen_sosial,
    persenPengurus: r.persen_pengurus,
    persenPengawas: r.persen_pengawas,
    persenKaryawan: r.persen_karyawan ?? 0,
    persenPembangunanDaerahKerja: r.persen_pembangunan_daerah_kerja ?? 0,
    persenCadanganRisiko: r.persen_cadangan_risiko ?? 0,
    totalShu: r.total_shu,
    shuInformasiRat: r.shu_informasi_rat ?? null,
    shuDiajukanRat: r.shu_diajukan_rat ?? null,
    shuDisahkanRat: r.shu_disahkan_rat ?? null,
    ratId: r.rat_id ?? null,
    catatanKeputusanRat: r.catatan_keputusan_rat ?? null,
    status: r.status,
  };
}

/** Riwayat SHU seluruh tahun buku. */
export async function getRiwayatSHU(): Promise<ShuKonfigurasiRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM shu_konfigurasi ORDER BY tahun_buku DESC`);
  return rows.map(rowToShuKonfigurasi);
}

export async function getShuKonfigurasiByTahun(tahunBuku: number): Promise<ShuKonfigurasiRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE tahun_buku = ?`, tahunBuku);
  return row ? rowToShuKonfigurasi(row) : null;
}

export interface ShuAnggotaRow {
  id: string;
  anggotaId: string;
  namaAnggota: string;
  nomorAnggota: string;
  basisSimpanan: Rupiah;
  basisPartisipasiUsaha: Rupiah;
  jasaModal: Rupiah;
  jasaUsaha: Rupiah;
  totalShuAnggota: Rupiah;
}

/** Daftar anggota + nominal SHU masing-masing. */
export async function getShuAnggotaList(shuKonfigurasiId: string): Promise<ShuAnggotaRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT sa.*, a.nama_lengkap, a.nomor_anggota
     FROM shu_anggota sa
     JOIN anggota a ON a.id = sa.anggota_id
     WHERE sa.shu_konfigurasi_id = ?
     ORDER BY sa.total_shu_anggota DESC`,
    shuKonfigurasiId
  );
  return rows.map((r) => ({
    id: r.id,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    nomorAnggota: r.nomor_anggota,
    basisSimpanan: r.basis_simpanan,
    basisPartisipasiUsaha: r.basis_partisipasi_usaha,
    jasaModal: r.jasa_modal,
    jasaUsaha: r.jasa_usaha,
    totalShuAnggota: r.total_shu_anggota,
  }));
}

/** Detail perhitungan SHU satu anggota. */
export async function getShuAnggotaDetail(
  shuKonfigurasiId: string,
  anggotaId: string
): Promise<ShuAnggotaRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT sa.*, a.nama_lengkap, a.nomor_anggota
     FROM shu_anggota sa
     JOIN anggota a ON a.id = sa.anggota_id
     WHERE sa.shu_konfigurasi_id = ? AND sa.anggota_id = ?`,
    shuKonfigurasiId,
    anggotaId
  );
  if (!row) return null;
  return {
    id: row.id,
    anggotaId: row.anggota_id,
    namaAnggota: row.nama_lengkap,
    nomorAnggota: row.nomor_anggota,
    basisSimpanan: row.basis_simpanan,
    basisPartisipasiUsaha: row.basis_partisipasi_usaha,
    jasaModal: row.jasa_modal,
    jasaUsaha: row.jasa_usaha,
    totalShuAnggota: row.total_shu_anggota,
  };
}
