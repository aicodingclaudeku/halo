import * as SQLite from 'expo-sqlite';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { isNonAccrual, alasanNonAccrual } from '@/accounting/NonAccrualPolicy';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermissionAtauSystemTrigger } from '@/services/PermissionService';
import { getKlasifikasiPinjamanAktif, Kolektibilitas } from '@/services/LoanImpairmentService';
import { getNonAccrualMinHariTunggakan } from '@/services/AccountingPolicyService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { toPeriode, tanggalAkhirPeriode, isValidPeriode } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni, toTanggalLokal } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * PHASE 2 — Akrual Jasa/Bunga Pinjaman (permintaan pengguna, "PHASE 2 —
 * INTEREST/JASA ACCOUNTING ENGINE").
 *
 * Model:
 *  - `angsuran_jadwal.jasa` TETAP berarti jasa/bunga KONTRAKTUAL pada
 *    jadwal (FLAT/MENURUN/EFEKTIF/CUSTOM — PinjamanCalculator TIDAK
 *    disentuh sama sekali) — TIDAK LAGI otomatis dianggap pendapatan
 *    akuntansi.
 *  - Pendapatan akuntansi HANYA diakui lewat `pinjaman_akuntansi_jasa`
 *    (dibuat Phase 1), SATU baris per (pinjaman, periode akuntansi),
 *    berisi jumlah jasa kontraktual yang JATUH TEMPO pada periode itu
 *    SAJA (bukan proyeksi masa depan) — pola & anti-duplikasi (2 lapis:
 *    cek existence + UNIQUE constraint database) meniru PERSIS
 *    PenyusutanService.ts (prosesPenyusutanAset/jalankanPenyusutanPeriode).
 *  - Jurnal akrual: Dr Piutang Jasa Pinjaman (1-1205) / Cr Pendapatan
 *    Jasa Pinjaman (4-1000) — transactionType `AKRUAL_JASA_PINJAMAN`,
 *    TERPISAH dari `ANGSURAN_JASA` (dipakai porsi jasa yang belum
 *    pernah diakru, dibayar langsung — lihat §5/§6 & PinjamanService).
 *  - Non-accrual: pinjaman berkolektibilitas MENCAPAI boundary yang
 *    dikonfigurasi (default 'DIRAGUKAN' — lihat
 *    AccountingPolicyService.getNonAccrualMinKolektibilitas) TIDAK
 *    diakrualkan untuk periode tersebut. PHASE 2 KOREKSI (permintaan
 *    pengguna): boundary ini ADALAH KEBIJAKAN AKUNTANSI KOPERASI yang
 *    dapat dikonfigurasi admin, BUKAN aturan baku SAK EP yang
 *    di-hardcode di modul ini — SAK EP tidak secara eksplisit
 *    menetapkan kategori kolektibilitas mana yang jadi titik
 *    non-accrual. Reuse mesin klasifikasi existing
 *    (LoanImpairmentService.getKlasifikasiPinjamanAktif, TIDAK
 *    diubah) — TIDAK ada threshold hari baru yang dikarang di sini.
 */

export interface AkrualJasaRow {
  id: string;
  pinjamanId: string;
  nomorPinjaman: string;
  periode: string;
  jumlahJasa: Rupiah;
  journalId: string;
  nomorJurnal: string | null;
}

export type StatusAkrualJasa = 'SUDAH_DIAKUI' | 'TIDAK_ADA_JASA' | 'NON_ACCRUAL' | 'SIAP_DIAKUI';

export interface StatusAkrualJasaItem {
  pinjamanId: string;
  nomorPinjaman: string;
  namaAnggota: string;
  jasaPeriodeIni: Rupiah;
  kolektibilitas: Kolektibilitas;
  status: StatusAkrualJasa;
}

/** Kategori kolektibilitas yang MENGHENTIKAN akrual jasa baru (non-accrual) — reuse mesin klasifikasi existing, bukan threshold baru. */
const KOLEKTIBILITAS_NON_ACCRUAL: Kolektibilitas[] = ['DIRAGUKAN', 'MACET'];

/**
 * FINAL FIX AKRUAL (permintaan pengguna BUG 1/2/3/8) — komponen
 * pengakuan jasa untuk SATU (pinjaman, periode akuntansi) pada SATU
 * tanggal laporan. SATU-SATUNYA tempat "berapa jasa yang masih boleh
 * diakui" dihitung — dipakai bersama oleh getStatusAkrualJasaPeriode()
 * (tampilan/batch runner) dan prosesAkrualJasaPinjaman() (posting
 * jurnal), supaya angka yang DITAMPILKAN dan angka yang DIJURNAL tidak
 * pernah bisa berbeda.
 *
 * PERUBAHAN INTI vs versi sebelumnya: eligibility TIDAK LAGI ditentukan
 * oleh perbandingan periode YYYY-MM. Periode tetap dipakai untuk
 * GROUPING & IDEMPOTENCY (satu baris pinjaman_akuntansi_jasa per
 * pinjaman+periode), tetapi baris jadwal hanya ikut dihitung kalau
 *
 *     tanggal_jatuh_tempo <= tanggalLaporan
 *
 * secara TANGGAL PENUH. Jadi jatuh tempo 2026-09-25 TIDAK eligible pada
 * tanggal laporan 2026-09-10 walaupun periodenya sama-sama '2026-09'.
 *
 * REKONSILIASI ANTI-DOUBLE-RECOGNITION (BUG 8) — `jasa_terbayar` pada
 * baris jadwal mencakup TIGA hal yang berbeda perlakuan akuntansinya:
 *  1. porsi yang dipakai melunasi Piutang Jasa yang SUDAH diakru
 *     (tercatat sebagai `kas_diterima` di baris pinjaman_akuntansi_jasa
 *     periode ini) — BUKAN pengakuan pendapatan baru;
 *  2. porsi yang kasnya diterima SEBELUM jatuh tempo dan masih
 *     mengendap di Pendapatan Diterima Dimuka (`jasa_dimuka`, migration
 *     v48) — BELUM jadi pendapatan;
 *  3. sisanya = porsi yang memang sudah diakui LANGSUNG sebagai
 *     Pendapatan Jasa saat pembayaran (jatuh tempo sudah lewat tapi
 *     batch akrual belum sempat jalan).
 * Hanya (3) yang mengurangi jatah akrual, karena hanya (3) yang sudah
 * menjadi pendapatan. Rumusnya murni turunan dari data yang SUDAH ADA —
 * tidak ada angka yang dikarang.
 */
/**
 * BUG-09 — PINJAMAN MANA YANG PERLU DIPROSES MESIN JASA.
 *
 * ROOT CAUSE yang diperbaiki: seluruh penemuan pinjaman dulu memakai
 * `p.status = 'AKTIF'` saja. Setelah pelunasan, pinjaman berstatus
 * LUNAS dan TIDAK PERNAH diproses lagi — padahal jadwalnya masih
 * menyimpan `jasa_dimuka > 0`, yaitu kas jasa masa depan yang sudah
 * diterima tetapi belum menjadi pendapatan. Akibatnya saldo
 * "Pendapatan Diterima Dimuka" (2-1300) mengendap PERMANEN dan tidak
 * pernah bisa direkonsiliasi.
 *
 * Kriteria yang benar bukan status pinjaman, melainkan: masih adakah
 * pekerjaan akuntansi yang tersisa?
 *   - pinjaman AKTIF        -> masih bisa menghasilkan akrual baru; ATAU
 *   - ada `jasa_dimuka > 0` -> masih ada deferred income yang harus dilepas,
 *                              apa pun status pinjamannya.
 *
 * Pinjaman DIAJUKAN/DITOLAK (belum cair) sengaja TIDAK ikut: jadwalnya
 * memang ada tetapi belum ada akad yang berjalan, dan `jasa_dimuka`-nya
 * pasti 0 karena belum pernah ada kas masuk.
 */
export const SQL_PINJAMAN_PERLU_PROSES_JASA = `(
  p.status = 'AKTIF'
  OR EXISTS (
    SELECT 1 FROM angsuran_jadwal ajd
    WHERE ajd.pinjaman_id = p.id AND ajd.jasa_dimuka > 0
  )
)`;

export interface KomponenAkrualPeriode {
  /** SUM(jasa) baris jadwal periode ini yang tanggal jatuh temponya SUDAH <= tanggalLaporan. */
  jasaKontraktualEligible: Rupiah;
  /** SUM(jasa_terbayar) atas baris yang sama. */
  jasaTerbayarEligible: Rupiah;
  /** SUM(jasa_dimuka) atas baris yang sama — kas sudah diterima, masih di Pendapatan Diterima Dimuka. */
  jasaDimukaEligible: Rupiah;
  /** `pendapatan_akuntansi` baris JASA_AKRUAL periode ini (0 kalau belum pernah diakru). */
  sudahDiakru: Rupiah;
  /** `kas_diterima` baris JASA_AKRUAL periode ini. */
  kasDiterimaAkrual: Rupiah;
  /** Porsi jasa periode ini yang sudah diakui LANGSUNG sebagai Pendapatan Jasa lewat pembayaran. */
  diakuiLangsungLewatPembayaran: Rupiah;
  /** Jasa periode ini yang MASIH boleh diakui sebagai pendapatan sekarang. */
  sisaJasa: Rupiah;
  /** Porsi `sisaJasa` yang kasnya SUDAH diterima dimuka (Dr Pendapatan Diterima Dimuka, bukan Dr Piutang Jasa). */
  porsiDariDimuka: Rupiah;
  /** Porsi `sisaJasa` yang kasnya BELUM diterima (Dr Piutang Jasa). */
  porsiKePiutangJasa: Rupiah;
  /** Total jasa kontraktual periode ini TERMASUK yang belum jatuh tempo — hanya untuk pesan/diagnostik. */
  jasaKontraktualSeluruhPeriode: Rupiah;
  /** Baris jadwal eligible (id) — dipakai untuk mengosongkan `jasa_dimuka` setelah diakui. */
  jadwalIdEligible: string[];
  adaBarisAkrual: boolean;
}

export async function hitungKomponenAkrualPeriode(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  periode: string,
  tanggalLaporan: string
): Promise<KomponenAkrualPeriode> {
  const semuaBaris = await db.getAllAsync<any>(
    // BUG-08/BUG-12: jadwal obsolete TIDAK BOLEH menghasilkan akrual.
    // Jadwal lama yang sudah digantikan akad ulang (DIRESTRUKTURISASI)
    // atau dihapusbukukan (DIHAPUSBUKU) bukan lagi hak tagih koperasi,
    // jadi jasanya bukan pendapatan yang boleh diakui.
    `SELECT aj.id, aj.jasa, aj.jasa_terbayar, aj.jasa_dimuka, aj.tanggal_jatuh_tempo
     FROM angsuran_jadwal aj
     WHERE aj.pinjaman_id = ? AND substr(aj.tanggal_jatuh_tempo,1,7) = ?
       AND ${sqlJadwalBukanObsolete('aj')}
     ORDER BY aj.nomor_angsuran ASC`,
    pinjamanId,
    periode
  );
  // Eligibility BERBASIS TANGGAL PENUH (BUG 1) — bukan YYYY-MM.
  const eligible = semuaBaris.filter((r) => r.tanggal_jatuh_tempo <= tanggalLaporan);

  const jasaKontraktualSeluruhPeriode = semuaBaris.reduce((s, r) => s + (r.jasa ?? 0), 0);
  const jasaKontraktualEligible = eligible.reduce((s, r) => s + (r.jasa ?? 0), 0);
  const jasaTerbayarEligible = eligible.reduce((s, r) => s + (r.jasa_terbayar ?? 0), 0);
  const jasaDimukaEligible = eligible.reduce((s, r) => s + (r.jasa_dimuka ?? 0), 0);

  const barisAkrual = await db.getFirstAsync<{ pendapatan_akuntansi: number; kas_diterima: number }>(
    `SELECT pendapatan_akuntansi, kas_diterima FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND periode_akuntansi = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI'`,
    pinjamanId,
    periode
  );
  const sudahDiakru = barisAkrual?.pendapatan_akuntansi ?? 0;
  const kasDiterimaAkrual = barisAkrual?.kas_diterima ?? 0;

  const diakuiLangsungLewatPembayaran = Math.max(0, jasaTerbayarEligible - jasaDimukaEligible - kasDiterimaAkrual);
  const sisaJasa = Math.max(0, jasaKontraktualEligible - sudahDiakru - diakuiLangsungLewatPembayaran);
  // Porsi yang kasnya sudah diterima dimuka dilepas dari liabilitas
  // lebih dulu; hanya kelebihannya yang menjadi Piutang Jasa baru.
  const porsiDariDimuka = Math.min(sisaJasa, jasaDimukaEligible);
  const porsiKePiutangJasa = sisaJasa - porsiDariDimuka;

  return {
    jasaKontraktualEligible,
    jasaTerbayarEligible,
    jasaDimukaEligible,
    sudahDiakru,
    kasDiterimaAkrual,
    diakuiLangsungLewatPembayaran,
    sisaJasa,
    porsiDariDimuka,
    porsiKePiutangJasa,
    jasaKontraktualSeluruhPeriode,
    jadwalIdEligible: eligible.map((r) => r.id as string),
    adaBarisAkrual: !!barisAkrual,
  };
}

/** Status akrual seluruh pinjaman AKTIF untuk satu periode — dasar layar & batch runner. */
export async function getStatusAkrualJasaPeriode(
  periode: string,
  opts: { tanggalLaporan?: string } = {}
): Promise<StatusAkrualJasaItem[]> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const db = await getDb();
  const tanggalLaporan = opts.tanggalLaporan ?? getTanggalLokalHariIni();

  const pinjamanRows = await db.getAllAsync<any>(
    `SELECT p.id, p.nomor_pinjaman, a.nama_lengkap
     FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
     WHERE ${SQL_PINJAMAN_PERLU_PROSES_JASA}
     ORDER BY p.nomor_pinjaman ASC`
  );

  const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan, statusAnggota: 'SEMUA' });
  const kolektMap = new Map(klasifikasi.map((k) => [k.pinjamanId, k.kolektibilitas]));
  // SESI 2 §J — keputusan non-accrual berbasis HARI TUNGGAKAN lewat
  // policy terpusat, bukan lagi turunan kategori kolektibilitas.
  const hariMap = new Map(klasifikasi.map((k) => [k.pinjamanId, k.hariTunggakan]));
  const ambangHariNonAccrual = await getNonAccrualMinHariTunggakan();

  const result: StatusAkrualJasaItem[] = [];
  for (const p of pinjamanRows) {
    // FINAL FIX AKRUAL: sisa jasa dihitung lewat helper BERSAMA yang
    // dipakai prosesAkrualJasaPinjaman — eligibility berbasis TANGGAL
    // jatuh tempo (bukan YYYY-MM), sudah bersih dari porsi yang pernah
    // diakui lewat pembayaran maupun lewat akrual sebelumnya.
    const komponen = await hitungKomponenAkrualPeriode(db, p.id, periode, tanggalLaporan);
    const jasaPeriodeIni = komponen.sisaJasa;
    const kolektibilitas: Kolektibilitas = kolektMap.get(p.id) ?? 'LANCAR';

    let status: StatusAkrualJasa;
    // "SUDAH_DIAKUI" hanya kalau memang tidak ada sisa lagi. Kalau
    // baris akrual periode ini sudah ada TAPI ada baris jadwal lain di
    // periode yang sama yang BARU jatuh tempo belakangan (tenor
    // mingguan/harian), sisanya masih boleh ditambahkan — lihat
    // mekanisme top-up di prosesAkrualJasaPinjaman.
    if (komponen.adaBarisAkrual && jasaPeriodeIni <= 0) status = 'SUDAH_DIAKUI';
    else if (jasaPeriodeIni <= 0) status = 'TIDAK_ADA_JASA';
    else if (isNonAccrual(hariMap.get(p.id) ?? 0, ambangHariNonAccrual)) status = 'NON_ACCRUAL';
    else status = 'SIAP_DIAKUI';

    result.push({
      pinjamanId: p.id,
      nomorPinjaman: p.nomor_pinjaman,
      namaAnggota: p.nama_lengkap,
      jasaPeriodeIni,
      kolektibilitas,
      status,
    });
  }
  return result;
}

function mapAkrualRow(r: any): AkrualJasaRow {
  return {
    id: r.id,
    pinjamanId: r.pinjaman_id,
    nomorPinjaman: r.nomor_pinjaman,
    periode: r.periode_akuntansi,
    jumlahJasa: r.pendapatan_akuntansi,
    journalId: r.journal_id,
    nomorJurnal: r.nomor_jurnal ?? null,
  };
}

/**
 * Proses akrual jasa SATU pinjaman untuk SATU periode. Idempoten
 * (pola PERSIS `prosesPenyusutanAset`): kalau (pinjaman_id, periode,
 * 'JASA_AKRUAL') sudah ada, return baris existing (bukan bikin baru,
 * bukan error) — RUN 2 pada requirement §3 TIDAK membuat jurnal lagi.
 */
export async function prosesAkrualJasaPinjaman(params: {
  pinjamanId: string;
  periode: string;
  createdBy: string;
  tanggalLaporan?: string;
  /**
   * BUG P0-8 — HANYA boleh `true` dari trigger lifecycle internal yang
   * trusted (lihat `jalankanAkrualJasaOtomatisJikaPerlu`), pola PERSIS
   * `systemTrigger` di PenyusutanService.prosesPenyusutanAset. Default
   * `false`/tidak diisi = perilaku manual sebelumnya (requirePermission
   * RBAC penuh) — tidak ada perubahan untuk pemanggilan UI manual.
   */
  systemTrigger?: boolean;
}): Promise<{ dibuat: boolean; row: AkrualJasaRow | null; dilewati?: string }> {
  if (!isValidPeriode(params.periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');

  return withTransaction(async (db) => {
    await requirePermissionAtauSystemTrigger(db, params.createdBy, 'pinjaman', 'edit', params.systemTrigger ?? false);

    const existing = await db.getFirstAsync<any>(
      `SELECT paj.*, j.nomor_jurnal, p.nomor_pinjaman
       FROM pinjaman_akuntansi_jasa paj
       LEFT JOIN journal j ON j.id = paj.journal_id
       JOIN pinjaman p ON p.id = paj.pinjaman_id
       WHERE paj.pinjaman_id = ? AND paj.periode_akuntansi = ? AND paj.tipe_pengakuan = 'JASA_AKRUAL'`,
      params.pinjamanId,
      params.periode
    );

    const pinjaman = await db.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = ?`, params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    // BUG-09: pinjaman non-AKTIF TETAP diproses SELAMA masih ada
    // deferred income yang harus dilepas. Pelunasan mengubah status
    // menjadi LUNAS, tetapi kas jasa masa depan yang sudah diterima
    // (`jasa_dimuka`) baru boleh diakui sebagai pendapatan ketika
    // periode jasanya benar-benar berjalan. Menolak memproses pinjaman
    // LUNAS = liabilitas 2-1300 mengendap selamanya.
    if (pinjaman.status !== 'AKTIF') {
      const deferred = await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(jasa_dimuka), 0) as total FROM angsuran_jadwal WHERE pinjaman_id = ?`,
        params.pinjamanId
      );
      if ((deferred?.total ?? 0) <= 0) {
        return {
          dibuat: false,
          row: null,
          dilewati: `Pinjaman berstatus "${pinjaman.status}" dan tidak memiliki pendapatan diterima dimuka yang tersisa — tidak diakrualkan.`,
        };
      }
    }

    // §4/BUG 1/BUG 3: jasa masa depan TIDAK BOLEH diakui. Guard periode
    // di bawah cuma jalan pintas murah untuk kasus periode yang JELAS
    // masih di depan; penentu sesungguhnya adalah filter TANGGAL di
    // hitungKomponenAkrualPeriode (tanggal_jatuh_tempo <= tanggalLaporan).
    const tanggalLaporan = params.tanggalLaporan ?? getTanggalLokalHariIni();
    const periodeSaatIni = toPeriode(tanggalLaporan);
    if (params.periode > periodeSaatIni) {
      return {
        dibuat: false,
        row: null,
        dilewati: `Periode ${params.periode} belum berjalan (tanggal laporan ${tanggalLaporan}) — jasa masa depan tidak boleh diakui.`,
      };
    }

    // §7/§9/§11: HANYA jasa kontraktual yang benar-benar jatuh tempo
    // pada periode ini (dari angsuran_jadwal yang SUDAH ADA, dibuat
    // PinjamanCalculator saat pengajuan — metode FLAT/MENURUN/EFEKTIF/
    // CUSTOM tidak dibedakan di sini, semuanya sudah tercermin di
    // kolom `jasa` masing-masing baris jadwal). Kalau ada >1 baris
    // jadwal jatuh tempo di periode yang sama (tenor mingguan/harian),
    // dijumlahkan jadi SATU baris akrual (unique constraint Phase 1
    // adalah per pinjaman+periode+tipe, bukan per jadwal).
    const komponen = await hitungKomponenAkrualPeriode(db, params.pinjamanId, params.periode, tanggalLaporan);
    // BUGFIX P0-1/P0-2/P0-3 (double recognition): `jasa` pada tiap
    // baris jadwal adalah jasa KONTRAKTUAL PENUH periode itu — kalau
    // anggota SUDAH membayar sebagian/seluruhnya SEBELUM batch akrual
    // ini dijalankan (lihat bayarAngsuran §"jasaBelumDiakru", yang
    // mengakui Cr Pendapatan Jasa LANGSUNG dan menambah
    // `angsuran_jadwal.jasa_terbayar` TANPA membuat baris
    // `pinjaman_akuntansi_jasa`), porsi itu SUDAH menjadi pendapatan.
    // Kalau akrual di sini tetap memakai `jasa` mentah (bukan
    // `jasa - jasa_terbayar`), porsi yang sudah dibayar/diakui itu
    // akan diakui KEDUA KALINYA lewat jurnal akrual — itulah bug
    // double recognition. `jasa_terbayar` adalah satu-satunya sumber
    // data yang mencerminkan "berapa dari jasa kontraktual periode
    // ini yang SUDAH pernah diakui sebagai pendapatan" pada titik ini
    // (belum ada baris pinjaman_akuntansi_jasa untuk periode ini —
    // sudah dipastikan oleh cek `existing` di atas), jadi menguranginya
    // di sini AMAN dan TIDAK mengarang angka baru.
    const totalJasa = komponen.sisaJasa;
    if (totalJasa <= 0) {
      let alasan: string;
      if (komponen.jasaKontraktualEligible <= 0) {
        alasan =
          komponen.jasaKontraktualSeluruhPeriode > 0
            ? `Belum ada angsuran periode ${params.periode} yang jatuh tempo per ${tanggalLaporan} — jasa masa depan tidak diakui.`
            : 'Tidak ada jasa kontraktual jatuh tempo pada periode ini.';
      } else if (komponen.adaBarisAkrual) {
        alasan = 'Periode ini sudah diakru sebelumnya — tidak ada sisa jasa yang perlu diakui.';
      } else {
        alasan =
          'Jasa kontraktual periode ini sudah dibayar/diakui penuh sebelum akrual dijalankan — tidak ada tambahan pendapatan yang perlu diakru.';
      }
      return { dibuat: false, row: existing ? mapAkrualRow(existing) : null, dilewati: alasan };
    }

    // Non-accrual: reuse mesin klasifikasi existing (TIDAK membuat
    // threshold hari baru) DAN boundary yang DAPAT DIKONFIGURASI
    // (default 'DIRAGUKAN' — PHASE 2 KOREKSI: ini kebijakan koperasi,
    // bukan aturan baku SAK EP yang di-hardcode, lihat
    // AccountingPolicyService.getNonAccrualMinKolektibilitas).
    const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan, statusAnggota: 'SEMUA' });
    const info = klasifikasi.find((k) => k.pinjamanId === params.pinjamanId);
    const hariTunggakan = info?.hariTunggakan ?? 0;
    const ambangHariNonAccrual = await getNonAccrualMinHariTunggakan();
    if (isNonAccrual(hariTunggakan, ambangHariNonAccrual)) {
      return {
        dibuat: false,
        row: null,
        dilewati: alasanNonAccrual(hariTunggakan, ambangHariNonAccrual),
      };
    }

    // §19: carrying amount berjalan (Piutang Jasa outstanding sebelum
    // baris ini) — dipakai reconciliation helper di bawah, disimpan di
    // baris supaya bisa diaudit tanpa query agregat ulang tiap saat.
    const saldoAwal = await hitungOutstandingPiutangJasa(db, params.pinjamanId);

    const pendapatanJasaAccountId = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN');

    // BUG 7 — jurnal pengakuan bisa punya DUA sisi debit yang berbeda:
    //  - porsi yang kasnya BELUM diterima  -> Dr Piutang Jasa (1-1205)
    //  - porsi yang kasnya SUDAH diterima dimuka -> Dr Pendapatan
    //    Diterima Dimuka (2-1300), melepas liabilitas yang dibentuk
    //    bayarAngsuran() saat pembayaran mendahului jatuh tempo.
    // Kredit selalu SATU akun Pendapatan Jasa (4-1000) — tidak ada akun
    // pendapatan kedua yang dikarang.
    const lines: { accountId: string; debit: number; kredit: number }[] = [];
    if (komponen.porsiKePiutangJasa > 0) {
      const piutangJasaAccountId = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA');
      lines.push({ accountId: piutangJasaAccountId, debit: komponen.porsiKePiutangJasa, kredit: 0 });
    }
    if (komponen.porsiDariDimuka > 0) {
      const dimukaAccountId = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA');
      lines.push({ accountId: dimukaAccountId, debit: komponen.porsiDariDimuka, kredit: 0 });
    }
    lines.push({ accountId: pendapatanJasaAccountId, debit: 0, kredit: totalJasa });

    // Tanggal jurnal: akhir periode akuntansi, TAPI tidak pernah
    // melewati tanggal laporan — kalau periode berjalan baru sebagian
    // (mis. akrual mingguan pada 2026-09-10), jurnal tidak boleh
    // bertanggal masa depan.
    const akhirPeriode = tanggalAkhirPeriode(params.periode);
    const tanggalJurnal = akhirPeriode <= tanggalLaporan ? akhirPeriode : tanggalLaporan;
    const year = new Date(tanggalJurnal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'AKR', year);

    const { journalId, nomorJurnal } = await createJournal(db, {
      tanggal: tanggalJurnal,
      sumberTransaksi: 'AKRUAL_JASA_PINJAMAN',
      sumberId: pinjaman.id,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Akrual jasa pinjaman ${pinjaman.nomor_pinjaman} periode ${params.periode} - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines,
    });

    const now = new Date().toISOString();

    // BUG 7: porsi yang tadinya duduk di Pendapatan Diterima Dimuka
    // sekarang SUDAH diakui — kosongkan subledger-nya supaya tidak
    // pernah diakui dua kali (FIFO per baris jadwal eligible).
    if (komponen.porsiDariDimuka > 0) {
      let sisaDimuka = komponen.porsiDariDimuka;
      for (const jadwalId of komponen.jadwalIdEligible) {
        if (sisaDimuka <= 0) break;
        const baris = await db.getFirstAsync<{ jasa_dimuka: number }>(
          `SELECT jasa_dimuka FROM angsuran_jadwal WHERE id = ?`,
          jadwalId
        );
        const nilai = baris?.jasa_dimuka ?? 0;
        if (nilai <= 0) continue;
        const dipakai = Math.min(sisaDimuka, nilai);
        await db.runAsync(`UPDATE angsuran_jadwal SET jasa_dimuka = ? WHERE id = ?`, nilai - dipakai, jadwalId);
        sisaDimuka -= dipakai;
      }
    }

    if (existing) {
      // TOP-UP (BUG 1, tenor MINGGU/HARI): baris akrual periode ini
      // SUDAH ada, tapi ada baris jadwal LAIN di periode yang sama yang
      // baru jatuh tempo belakangan. UNIQUE(pinjaman, periode, tipe)
      // TIDAK diubah — nilai baris existing yang ditambah, dengan
      // jurnal tambahan sendiri (GL tetap benar, audit trail tetap ada
      // lewat journal.sumber_id + deskripsi periode). Bukan mekanisme
      // akuntansi baru: rumus & akun PERSIS sama dengan akrual pertama.
      const pendapatanBaru = existing.pendapatan_akuntansi + totalJasa;
      const kasBaru = existing.kas_diterima + komponen.porsiDariDimuka;
      await db.runAsync(
        `UPDATE pinjaman_akuntansi_jasa
         SET pendapatan_akuntansi = ?, kas_diterima = ?, saldo_akhir_carrying = ?, updated_at = ?
         WHERE id = ?`,
        pendapatanBaru,
        kasBaru,
        existing.saldo_awal_carrying + pendapatanBaru - kasBaru - (existing.writeoff_amount ?? 0),
        now,
        existing.id
      );
      return {
        dibuat: true,
        row: {
          id: existing.id,
          pinjamanId: params.pinjamanId,
          nomorPinjaman: pinjaman.nomor_pinjaman,
          periode: params.periode,
          jumlahJasa: totalJasa,
          journalId,
          nomorJurnal,
        },
      };
    }

    const id = newId();
    const jadwalId = komponen.jadwalIdEligible.length === 1 ? komponen.jadwalIdEligible[0] : null;
    // §3: idempotency_key eksplisit (selain UNIQUE constraint komposit
    // Phase 1) — dipakai sebagai lapis kedua yang independen dari nama
    // kolom komposit, kalau suatu saat schema berubah.
    const idempotencyKey = `${params.pinjamanId}:${params.periode}:JASA_AKRUAL`;

    // Lapis 2 anti-duplikasi: UNIQUE(pinjaman_id, periode_akuntansi,
    // tipe_pengakuan) & UNIQUE(idempotency_key) di level database
    // (schema.ts) — kalau ada race condition, INSERT ini gagal &
    // SELURUH transaksi (termasuk jurnal di atas) rollback otomatis
    // (§18: journal tanpa accounting record TIDAK PERNAH terjadi).
    //
    // `kas_diterima` langsung diisi porsi yang kasnya sudah diterima
    // dimuka — pendapatan diakui DAN kasnya sudah masuk, jadi TIDAK ADA
    // Piutang Jasa yang terbentuk untuk porsi itu (outstanding =
    // pendapatan_akuntansi - kas_diterima tetap rekonsiliasi dengan GL).
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
         pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
         journal_id, idempotency_key, created_by, created_at, updated_at)
       VALUES (?,?,?,?,'JASA_AKRUAL',?,?,?,0,?,'DIAKUI',?,?,?,?,?)`,
      id,
      params.pinjamanId,
      jadwalId,
      params.periode,
      saldoAwal,
      totalJasa,
      komponen.porsiDariDimuka,
      saldoAwal + totalJasa - komponen.porsiDariDimuka,
      journalId,
      idempotencyKey,
      params.createdBy,
      now,
      now
    );

    return {
      dibuat: true,
      row: {
        id,
        pinjamanId: params.pinjamanId,
        nomorPinjaman: pinjaman.nomor_pinjaman,
        periode: params.periode,
        jumlahJasa: totalJasa,
        journalId,
        nomorJurnal,
      },
    };
  });
}

export interface HasilBatchAkrualJasa {
  periode: string;
  diproses: AkrualJasaRow[];
  dilewati: { pinjamanId: string; nomorPinjaman: string; alasan: string }[];
}

/**
 * Jalankan akrual jasa untuk SEMUA pinjaman AKTIF pada satu periode.
 * Tiap pinjaman diproses independen (try/catch per-pinjaman, pola
 * PERSIS `jalankanPenyusutanPeriode`) supaya satu pinjaman bermasalah
 * tidak menggagalkan pinjaman lain dalam batch yang sama. Dipicu
 * manual dari UI (app offline-first, bukan cron) — TIDAK ada layar
 * baru dibuat pada Phase 2 ini (§21), fungsi ini disiapkan untuk
 * dipanggil layar/scheduler-like trigger pada phase berikutnya.
 */
export async function jalankanAkrualJasaPeriode(
  periode: string,
  createdBy: string,
  opts: { tanggalLaporan?: string; systemTrigger?: boolean } = {}
): Promise<HasilBatchAkrualJasa> {
  if (!isValidPeriode(periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');
  const status = await getStatusAkrualJasaPeriode(periode, opts);
  const diproses: AkrualJasaRow[] = [];
  const dilewati: { pinjamanId: string; nomorPinjaman: string; alasan: string }[] = [];

  for (const item of status) {
    if (item.status === 'SUDAH_DIAKUI') {
      dilewati.push({ pinjamanId: item.pinjamanId, nomorPinjaman: item.nomorPinjaman, alasan: 'Periode ini sudah diakru sebelumnya.' });
      continue;
    }
    if (item.status === 'TIDAK_ADA_JASA') {
      dilewati.push({ pinjamanId: item.pinjamanId, nomorPinjaman: item.nomorPinjaman, alasan: 'Tidak ada jasa kontraktual jatuh tempo pada periode ini.' });
      continue;
    }
    if (item.status === 'NON_ACCRUAL') {
      dilewati.push({
        pinjamanId: item.pinjamanId,
        nomorPinjaman: item.nomorPinjaman,
        alasan: `Non-accrual — kolektibilitas ${item.kolektibilitas}.`,
      });
      continue;
    }
    try {
      const hasil = await prosesAkrualJasaPinjaman({
        pinjamanId: item.pinjamanId,
        periode,
        createdBy,
        tanggalLaporan: opts.tanggalLaporan,
        systemTrigger: opts.systemTrigger,
      });
      if (hasil.dibuat && hasil.row) diproses.push(hasil.row);
      else dilewati.push({ pinjamanId: item.pinjamanId, nomorPinjaman: item.nomorPinjaman, alasan: hasil.dilewati ?? 'Tidak diproses.' });
    } catch (e) {
      dilewati.push({
        pinjamanId: item.pinjamanId,
        nomorPinjaman: item.nomorPinjaman,
        alasan: e instanceof Error ? e.message : 'Gagal memproses.',
      });
    }
  }

  return { periode, diproses, dilewati };
}

export interface HasilAkrualJasaOtomatis {
  dijalankan: boolean;
  /** Periode (YYYY-MM) yang diproses batch ini, urut ASCENDING — kosong kalau tidak ada periode yang perlu dikejar. */
  periodeDiproses: string[];
  hasil: HasilBatchAkrualJasa[];
  error?: string;
}

/**
 * BUG P0-8 — trigger OTOMATIS akrual jasa, pola PERSIS
 * `jalankanPenyusutanOtomatisJikaPerlu` (PenyusutanService.ts):
 * dipanggil dari lifecycle bootstrap aplikasi (`app/index.tsx`, saat
 * phase berubah jadi READY — login/unlock/kembali dari
 * background/restore), BUKAN dari React render, BUKAN polling, BUKAN
 * cron sungguhan (app offline-first).
 *
 * SAMA dengan trigger penyusutan (yang sejak perbaikan penyusutan
 * retroaktif juga mengejar SELURUH periode yang sudah jatuh tempo,
 * bukan hanya bulan berjalan): akrual jasa WAJIB bisa mengejar periode
 * yang terlewat (§8 permintaan pengguna — "Oktober tidak dibuka,
 * November baru dibuka -> proses harus mampu mengejar periode yang
 * sudah memenuhi syarat"). Bedanya hanya pada CARA menemukan periode:
 * penyusutan menurunkannya dari tanggal perolehan + masa manfaat tiap
 * aset, sedangkan akrual jasa TIDAK bisa memakai loop buta dari suatu
 * tanggal awal (bisa sangat panjang/mahal untuk koperasi lama), jadi
 * memakai query LANGSUNG ke `angsuran_jadwal` untuk menemukan periode
 * mana saja (dari SEMUA pinjaman AKTIF) yang:
 *  1. jasa kontraktualnya sudah/pernah jatuh tempo (<= periode saat
 *     ini — TIDAK PERNAH periode masa depan, sama seperti guard di
 *     `prosesAkrualJasaPinjaman`), DAN
 *  2. BELUM ada baris `pinjaman_akuntansi_jasa` (tipe JASA_AKRUAL)
 *     untuk (pinjaman, periode) itu.
 * Himpunan periode hasil query itu lalu diproses satu-satu (ASCENDING,
 * periode lama duluan) lewat `jalankanAkrualJasaPeriode()` yang SAMA
 * PERSIS dipakai batch manual — TIDAK ADA engine/rumus baru di sini.
 *
 * IDEMPOTENT (§7 test wajib): dipanggil dua kali berturut-turut TIDAK
 * membuat jurnal kedua — panggilan kedua, query di atas akan
 * mengembalikan himpunan periode KOSONG (semua sudah punya baris
 * `pinjaman_akuntansi_jasa`), jadi tidak ada apa pun yang diproses
 * ulang. Non-accrual (P0-9) & double-recognition (P0-1..P0-3) tetap
 * dihormati karena diproses lewat `jalankanAkrualJasaPeriode` yang
 * sama, TIDAK ada jalur pintas di sini.
 *
 * `systemTrigger: true` HANYA di titik pemanggilan INI (satu-satunya
 * trusted lifecycle path) — pola & alasan SAMA PERSIS dengan
 * `requirePermissionAtauSystemTrigger` di PenyusutanService: user yang
 * sedang login tetap harus ada & aktif (audit trail `created_by`
 * valid), tapi automatic period maintenance ini tidak boleh gagal
 * senyap hanya karena role user yang kebetulan login belum diberi izin
 * eksplisit `pinjaman`/`edit`.
 *
 * TIDAK PERNAH melempar error ke pemanggil (§ sama seperti penyusutan)
 * — kegagalan proses otomatis TIDAK BOLEH memblokir login/pemakaian
 * aplikasi; kegagalan dilaporkan lewat field `error`, bukan exception.
 *
 * `tanggalSekarang` opsional (default `getWaktuSekarang()` — jam aplikasi, lihat RC-S94) — semata untuk
 * injeksi tanggal di test, pola yang sama dipakai `tanggalLaporan` di
 * seluruh file ini.
 */
export async function jalankanAkrualJasaOtomatisJikaPerlu(
  createdBy: string,
  // RC-S94 — default = JAM APLIKASI (`getWaktuSekarang`), BUKAN `new Date()`.
  // Dengan `new Date()`, fungsi ini — yang dipanggil StartupTasks TANPA
  // argumen — mengabaikan Mode Pengujian Waktu: setelah developer
  // melompatkan "hari ini", periode yang sudah jatuh tempo menurut jam
  // simulasi tidak pernah diproses (mis. jasa diterima di muka tidak
  // pernah pindah ke Laporan Hasil Usaha). Saat mode pengujian MATI,
  // `getWaktuSekarang()` PERSIS `new Date()`, jadi perilaku produksi tidak
  // berubah. Tanggal eksplisit dari pemanggil (test) tetap dihormati.
  tanggalSekarang: Date = getWaktuSekarang()
): Promise<HasilAkrualJasaOtomatis> {
  const tanggalLaporan = toTanggalLokal(tanggalSekarang);
  try {
    const db = await getDb();
    // Himpunan periode (bukan pinjaman) yang MASIH punya minimal satu
    // pinjaman AKTIF dengan jasa kontraktual jatuh tempo (<= periode
    // saat ini) yang belum diakru — dedup lewat DISTINCT supaya satu
    // periode hanya diproses SEKALI oleh `jalankanAkrualJasaPeriode`
    // (yang sudah menangani SEMUA pinjaman AKTIF untuk periode itu).
    //
    // BUG 2: filter eligibility memakai TANGGAL JATUH TEMPO PENUH
    // (`aj.tanggal_jatuh_tempo <= tanggalLaporan`), BUKAN perbandingan
    // YYYY-MM. Jadi kalau aplikasi dibuka 2026-10-10, angsuran yang
    // jatuh tempo 2026-10-25 TIDAK ikut diproses walaupun periodenya
    // ('2026-10') sudah berjalan.
    //
    // Rumus sisa di klausa WHERE adalah versi SQL dari
    // hitungKomponenAkrualPeriode (satu-satunya sumber kebenaran di
    // TypeScript) — dipakai HANYA untuk menyaring kandidat periode
    // supaya tidak melooping seluruh sejarah koperasi setiap kali
    // aplikasi dibuka. Keputusan akhir "diakru atau tidak" tetap ada di
    // prosesAkrualJasaPinjaman, jadi kalau rumus penyaring ini terlalu
    // longgar pun tidak pernah menghasilkan jurnal ganda.
    const rows = await db.getAllAsync<{ periode: string }>(
      `SELECT e.periode as periode
       FROM (
         SELECT aj.pinjaman_id AS pid,
                substr(aj.tanggal_jatuh_tempo,1,7) AS periode,
                SUM(aj.jasa) AS jasa_eligible,
                SUM(aj.jasa_terbayar) AS jasa_terbayar,
                SUM(aj.jasa_dimuka) AS jasa_dimuka
         FROM angsuran_jadwal aj
         JOIN pinjaman p ON p.id = aj.pinjaman_id
         WHERE ${SQL_PINJAMAN_PERLU_PROSES_JASA}
           AND aj.jasa > 0
           AND aj.tanggal_jatuh_tempo <= ?
           AND ${sqlJadwalBukanObsolete('aj')}
         GROUP BY aj.pinjaman_id, substr(aj.tanggal_jatuh_tempo,1,7)
       ) e
       LEFT JOIN pinjaman_akuntansi_jasa paj
         ON paj.pinjaman_id = e.pid
        AND paj.periode_akuntansi = e.periode
        AND paj.tipe_pengakuan = 'JASA_AKRUAL'
        AND paj.status = 'DIAKUI'
       WHERE (
         e.jasa_eligible
         - COALESCE(paj.pendapatan_akuntansi, 0)
         - CASE
             WHEN (e.jasa_terbayar - e.jasa_dimuka - COALESCE(paj.kas_diterima, 0)) > 0
             THEN (e.jasa_terbayar - e.jasa_dimuka - COALESCE(paj.kas_diterima, 0))
             ELSE 0
           END
       ) > 0
       GROUP BY e.periode
       ORDER BY e.periode ASC`,
      tanggalLaporan
    );
    const periodeDiproses = rows.map((r) => r.periode);
    const hasil: HasilBatchAkrualJasa[] = [];
    for (const periode of periodeDiproses) {
      hasil.push(await jalankanAkrualJasaPeriode(periode, createdBy, { tanggalLaporan, systemTrigger: true }));
    }
    return { dijalankan: true, periodeDiproses, hasil };
  } catch (e) {
    return {
      dijalankan: false,
      periodeDiproses: [],
      hasil: [],
      error: e instanceof Error ? e.message : 'Gagal menjalankan akrual jasa otomatis.',
    };
  }
}

/**
 * §19/PHASE 3 §D RECONCILIATION: Piutang Jasa GL (saldo akun 1-1205
 * milik SATU pinjaman) = jasa yang sudah diakui - jasa yang sudah
 * dibayar - jasa yang di-write-off - jasa yang dibatalkan. Dihitung
 * LANGSUNG dari `pinjaman_akuntansi_jasa` (bukan dari `total
 * contractual future interest` pada angsuran_jadwal) — baris
 * berstatus 'DIBATALKAN' otomatis tidak ikut (SUM hanya baris
 * 'DIAKUI'). `writeoff_amount` (PHASE 3, migration v45) DIPISAHKAN
 * dari `kas_diterima` — write-off BUKAN penerimaan kas.
 */
export async function hitungOutstandingPiutangJasa(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  periode?: string
): Promise<Rupiah> {
  const row = periode
    ? await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(pendapatan_akuntansi - kas_diterima - writeoff_amount), 0) as total
         FROM pinjaman_akuntansi_jasa
         WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI' AND periode_akuntansi = ?`,
        pinjamanId,
        periode
      )
    : await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(pendapatan_akuntansi - kas_diterima - writeoff_amount), 0) as total
         FROM pinjaman_akuntansi_jasa
         WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI'`,
        pinjamanId
      );
  return Math.max(0, row?.total ?? 0);
}

export interface AlokasiPembayaranJasa {
  /** Porsi pembayaran yang mengurangi Piutang Jasa yang SUDAH diakru (Dr Kas / Cr Piutang Jasa). */
  jasaSudahDiakru: Rupiah;
  /** Porsi pembayaran untuk jasa yang BELUM pernah diakru (Dr Kas / Cr Pendapatan Jasa langsung, seperti sebelum Phase 2 — mis. bayar sebelum batch akrual bulan berjalan dijalankan). */
  jasaBelumDiakru: Rupiah;
}

/**
 * §5/§6: bagi porsi jasa yang dibayar menjadi bagian yang SUDAH
 * pernah diakui sebagai Piutang Jasa vs bagian yang belum (mis. jika
 * proses akrual bulanan belum sempat dijalankan sebelum anggota
 * membayar — "payment sebelum accrual" tetap mungkin karena akrual
 * dipicu manual/batch, bukan instan). TIDAK PERNAH mengurangi Piutang
 * Jasa untuk jumlah lebih besar dari yang benar-benar outstanding di
 * `pinjaman_akuntansi_jasa` (§6: no negative receivable).
 */
export async function alokasikanPembayaranJasa(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  porsiJasa: Rupiah,
  /**
   * FINAL FIX AKRUAL: kalau diisi, Piutang Jasa yang boleh dikurangi
   * DIBATASI pada periode akuntansi milik angsuran yang sedang dibayar
   * (dipakai `bayarAngsuran`, yang memang membayar SATU baris jadwal).
   * Tanpa ini, pembayaran angsuran ke-3 bisa mengurangi Piutang Jasa
   * periode 1 sementara `jasa_terbayar` yang bertambah adalah milik
   * periode 3 — akibatnya pendapatan periode 3 ikut tersaring dari
   * akrual dan tidak pernah diakui. `lunasiPinjaman` SENGAJA tidak
   * mengisi ini (melunasi SELURUH periode sekaligus, alokasi
   * lintas-periode memang benar di sana).
   */
  periode?: string
): Promise<AlokasiPembayaranJasa> {
  if (porsiJasa <= 0) return { jasaSudahDiakru: 0, jasaBelumDiakru: 0 };
  const outstanding = await hitungOutstandingPiutangJasa(db, pinjamanId, periode);
  const jasaSudahDiakru = Math.min(porsiJasa, outstanding);
  const jasaBelumDiakru = porsiJasa - jasaSudahDiakru;
  return { jasaSudahDiakru, jasaBelumDiakru };
}

/**
 * Terapkan pengurangan `kas_diterima` ke baris `pinjaman_akuntansi_jasa`
 * yang masih outstanding, FIFO berdasarkan periode (paling lama
 * dilunasi duluan) — dipanggil SETELAH jurnal pembayaran diposting,
 * di DALAM transaction yang sama dengan pembayaran (PinjamanService),
 * BUKAN transaction terpisah (§18: satu transaction boundary).
 * Tidak pernah membuat kas_diterima > pendapatan_akuntansi pada satu
 * baris (dibatasi Math.min per baris).
 */
export async function terapkanPembayaranKePiutangJasa(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  jumlah: Rupiah,
  /** Lihat `alokasikanPembayaranJasa` — harus diisi dengan nilai yang SAMA supaya alokasi & penerapannya konsisten. */
  periode?: string
): Promise<void> {
  if (jumlah <= 0) return;
  let sisa = jumlah;
  const rows = await db.getAllAsync<any>(
    `SELECT id, pendapatan_akuntansi, kas_diterima, saldo_awal_carrying
     FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI'
       AND kas_diterima < pendapatan_akuntansi
       AND (? IS NULL OR periode_akuntansi = ?)
     ORDER BY periode_akuntansi ASC`,
    pinjamanId,
    periode ?? null,
    periode ?? null
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    if (sisa <= 0) break;
    const outstandingBaris = row.pendapatan_akuntansi - row.kas_diterima;
    const bayarBaris = Math.min(sisa, outstandingBaris);
    if (bayarBaris <= 0) continue;
    const kasDiterimaBaru = row.kas_diterima + bayarBaris;
    await db.runAsync(
      `UPDATE pinjaman_akuntansi_jasa
       SET kas_diterima = ?, saldo_akhir_carrying = ?, updated_at = ?
       WHERE id = ?`,
      kasDiterimaBaru,
      row.saldo_awal_carrying + row.pendapatan_akuntansi - kasDiterimaBaru,
      now,
      row.id
    );
    sisa -= bayarBaris;
  }
}

/**
 * PHASE 2 KOREKSI (permintaan pengguna §2): catat fee integral yang
 * dibukukan ke Pendapatan Diterima Dimuka saat pencairan (BELUM
 * diakui sebagai pendapatan — lihat PinjamanService.cairkanPinjaman)
 * supaya statusnya EKSPLISIT dapat dilacak sampai Phase EIR
 * membangun amortisasi sesungguhnya. Ini BUKAN jurnal amortisasi —
 * TIDAK ADA rate EIR dihitung, TIDAK memakai rate kontrak sebagai
 * EIR, TIDAK ada pengakuan pendapatan apa pun di sini. Murni
 * pencatatan schedule/status supaya saldo fee integral tidak hilang:
 *  - `saldo_akhir_carrying` baris ini = initial carrying amount fee,
 *    siap dipakai Phase EIR sebagai titik awal amortisasi.
 *  - `kas_diterima` = jumlah fee (kas SUDAH diterima/dinetkan saat
 *    pencairan, dicatat di sini untuk cash flow, BUKAN pendapatan).
 *  - `fee_lifecycle_status` = 'DEFERRED_PENDING_EIR' (migration v44).
 * Dipanggil di DALAM transaction yang sama dengan pencairan (§18: satu
 * transaction boundary, journal & accounting record tidak pernah
 * terpisah).
 */
export async function catatFeeIntegralPendingEir(
  db: SQLite.SQLiteDatabase,
  params: { pinjamanId: string; tanggal: string; jumlahFee: Rupiah; journalId: string; createdBy: string }
): Promise<void> {
  if (params.jumlahFee <= 0) return;
  const periode = toPeriode(params.tanggal);
  const id = newId();
  const now = new Date().toISOString();
  // Satu pinjaman hanya bisa dicairkan sekali (checkBelumDicairkan di
  // PinjamanService menolak pencairan ganda), jadi key ini aman unik
  // secara global — konsisten dengan idempotency_key JASA_AKRUAL.
  const idempotencyKey = `${params.pinjamanId}:FEE_INTEGRAL_AMORTISASI:pencairan`;

  await db.runAsync(
    `INSERT INTO pinjaman_akuntansi_jasa
      (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
       pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
       fee_lifecycle_status, journal_id, idempotency_key, created_by, created_at, updated_at)
     VALUES (?,?,?,?, 'FEE_INTEGRAL_AMORTISASI', 0, 0, ?, 0, ?, 'DIAKUI', 'DEFERRED_PENDING_EIR', ?, ?, ?, ?, ?)`,
    id,
    params.pinjamanId,
    null,
    periode,
    params.jumlahFee,
    params.jumlahFee,
    params.journalId,
    idempotencyKey,
    params.createdBy,
    now,
    now
  );
}

/**
 * Total fee integral yang masih DEFERRED_PENDING_EIR untuk satu
 * pinjaman (belum diamortisasi/diakui) — dipakai reconciliation &
 * Phase EIR berikutnya sebagai starting point.
 */
export async function hitungFeeIntegralPendingEir(db: SQLite.SQLiteDatabase, pinjamanId: string): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(saldo_akhir_carrying), 0) as total
     FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI' AND fee_lifecycle_status = 'DEFERRED_PENDING_EIR'`,
    pinjamanId
  );
  return row?.total ?? 0;
}

/**
 * PHASE 3 (§D/§F, permintaan pengguna): terapkan pengurangan
 * `writeoff_amount` ke baris `pinjaman_akuntansi_jasa` yang masih
 * outstanding, FIFO berdasarkan periode — pola SAMA PERSIS dengan
 * `terapkanPembayaranKePiutangJasa`, TAPI mengurangi `writeoff_amount`
 * (bukan `kas_diterima`, tidak ada kas yang diterima). Dipanggil DI
 * DALAM transaction yang sama dengan jurnal write-off
 * (PinjamanService.hapusPiutangPinjaman), setelah journal diposting —
 * §G: satu transaction boundary, journal & accounting record/status
 * loan/installment semuanya rollback bersama kalau ada yang gagal.
 */
export async function terapkanWriteOffKePiutangJasa(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  jumlah: Rupiah
): Promise<void> {
  if (jumlah <= 0) return;
  let sisa = jumlah;
  const rows = await db.getAllAsync<any>(
    `SELECT id, pendapatan_akuntansi, kas_diterima, writeoff_amount, saldo_awal_carrying
     FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI'
       AND (kas_diterima + writeoff_amount) < pendapatan_akuntansi
     ORDER BY periode_akuntansi ASC`,
    pinjamanId
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    if (sisa <= 0) break;
    const outstandingBaris = row.pendapatan_akuntansi - row.kas_diterima - row.writeoff_amount;
    const writeOffBaris = Math.min(sisa, outstandingBaris);
    if (writeOffBaris <= 0) continue;
    const writeoffAmountBaru = row.writeoff_amount + writeOffBaris;
    await db.runAsync(
      `UPDATE pinjaman_akuntansi_jasa
       SET writeoff_amount = ?, saldo_akhir_carrying = ?, updated_at = ?
       WHERE id = ?`,
      writeoffAmountBaru,
      row.saldo_awal_carrying + row.pendapatan_akuntansi - row.kas_diterima - writeoffAmountBaru,
      now,
      row.id
    );
    sisa -= writeOffBaris;
  }
}

/**
 * PHASE 3 (§B, permintaan pengguna): saldo Piutang Pinjaman (pokok)
 * yang SUNGGUHAN tercatat di GL untuk SATU pinjaman spesifik —
 * dihitung dari jurnal (journal_entry) yang benar-benar terposting,
 * BUKAN dari `SUM(total - pokok_terbayar - jasa_terbayar)` (bug
 * lama). Akun Piutang Pinjaman (1-1200) dipakai BERSAMA oleh banyak
 * pinjaman (dan tabel legacy `pinjaman_koperasi`, lihat catatan di
 * defaultCOA.ts), jadi tidak bisa langsung baca saldo akun agregat —
 * di-scope per pinjaman lewat `journal.sumber_id = pinjamanId`
 * (SEMUA jurnal pinjaman ini — PENCAIRAN_PINJAMAN, ANGSURAN_POKOK
 * dari bayarAngsuran/lunasiPinjaman — konsisten set sumber_id ke
 * pinjaman.id, lihat PinjamanService.ts) DIGABUNG dengan
 * `account_id = piutangPokokAccountId` (otomatis mengecualikan
 * jurnal AKRUAL_JASA_PINJAMAN milik pinjaman yang sama karena
 * account_id-nya berbeda, 1-1205 bukan 1-1200). HANYA jurnal
 * berstatus POSTED yang dihitung.
 */
export async function hitungSaldoPiutangPokokGL(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  piutangPokokAccountId: string
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(je.debit - je.kredit), 0) as total
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
    pinjamanId,
    piutangPokokAccountId
  );
  return Math.max(0, row?.total ?? 0);
}

/**
 * PHASE 3 (§E, permintaan pengguna): saldo Penyisihan Piutang Tak
 * Tertagih (1-1210) yang TERSEDIA saat ini — akun KONTRA aset
 * (normal balance KREDIT), dipakai PORTOFOLIO-WIDE (bukan per
 * pinjaman, sesuai desain LoanImpairmentService existing yang TIDAK
 * disentuh Phase 3), jadi TIDAK di-scope per sumber_id — murni saldo
 * GL akun ini secara keseluruhan, hanya jurnal POSTED.
 */
export async function hitungSaldoPenyisihanGL(db: SQLite.SQLiteDatabase, penyisihanAccountId: string): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as total
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status = 'POSTED'`,
    penyisihanAccountId
  );
  return Math.max(0, row?.total ?? 0);
}
