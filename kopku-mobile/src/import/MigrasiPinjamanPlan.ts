import { Rupiah } from '@/utils/money';
import type { SatuanTenor } from '@/accounting/PinjamanCalculator';
import { hitungJadwalAngsuran } from '@/accounting/PinjamanCalculator';
import { calculateInstallmentDate } from '@/accounting/InstallmentDate';

/**
 * RC-S102 — MIGRASI SALDO AWAL PINJAMAN BERJALAN (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Import Data Awal (RC-S96) memasukkan pinjaman historis dengan
 * memanggil `ajukanPinjaman()` -> `cairkanPinjaman()` -> `bayarAngsuran()`.
 * Akibatnya SELURUH pokok pinjaman lama DICAIRKAN ULANG hari ini:
 *
 *   1. `cairkanPinjaman()` menjurnal KREDIT Kas/Bank sebesar pokok penuh,
 *      sehingga kas koperasi HARI INI berkurang untuk uang yang
 *      sebenarnya sudah keluar bertahun-tahun lalu;
 *   2. pemeriksaan `checkLiquiditasPencairan()` + `checkSaldoAkunCukup()`
 *      dijalankan terhadap saldo kas SEKARANG, sehingga koperasi dengan
 *      kas kecil tetapi portofolio pinjaman besar TIDAK BISA migrasi
 *      sama sekali — kegagalan yang benar untuk pencairan baru, tetapi
 *      salah untuk data historis;
 *   3. `bayarAngsuran()` menjurnal penerimaan kas & mengakui pendapatan
 *      jasa ULANG untuk angsuran yang pembayarannya sudah dibukukan di
 *      sistem lama — pendapatan dan kas ganda.
 *
 * ============================================================
 * PEMISAHAN YANG BENAR: BUKU PEMBANTU vs BUKU BESAR
 * ============================================================
 * Migrasi pinjaman berjalan TIDAK menjurnal apa pun. Ia hanya membangun
 * BUKU PEMBANTU pinjaman — baris `pinjaman` dan `angsuran_jadwal` yang
 * mencerminkan POSISI PADA TANGGAL CUT-OFF.
 *
 * Sisi BUKU BESAR-nya (Piutang Pinjaman Anggota pada tanggal cut-off)
 * dimasukkan lewat mekanisme SALDO AWAL yang SUDAH ADA di aplikasi ini
 * (`saldo_awal_akun` + `postingSaldoAwal`), yang:
 *   - memvalidasi persamaan akuntansi PENUH pada tanggal cut-off
 *     (Aset + Beban = Liabilitas + Ekuitas + Pendapatan, lihat
 *     `getValidasiSaldoAwal`), sehingga akun lawannya adalah SELURUH
 *     pos neraca yang direkonsiliasi — bukan satu akun penampung;
 *   - karena itu TIDAK memerlukan akun kliring, dan secara struktural
 *     TIDAK MUNGKIN memakai Cadangan Umum sebagai pengganti kas;
 *   - memposting SATU jurnal saldo awal yang seimbang.
 *
 * Konsekuensi yang disengaja: kas/bank hari ini TIDAK pernah berkurang
 * karena migrasi, dan tidak ada pendapatan historis yang diakui ulang.
 *
 * `rekonsiliasiPiutang()` di bawah menjaga agar kedua sisi tidak
 * divergen: jumlah sisa pokok buku pembantu WAJIB sama dengan saldo awal
 * akun Piutang Pinjaman Anggota.
 *
 * ============================================================
 * TIDAK MENGARANG RIWAYAT
 * ============================================================
 * Angsuran yang sudah dibayar SEBELUM cut-off TIDAK dibuatkan baris
 * jadwal maupun baris pembayaran. Yang dibangun hanya angsuran yang
 * MASIH TERSISA. Alasannya: aplikasi tidak punya data kapan dan berapa
 * tiap angsuran lama dibayar, dan membuat baris "LUNAS" beserta
 * pembayarannya berarti mengarang tanggal, nominal, dan jurnalnya.
 *
 * Modul ini MURNI (tanpa import database/native) supaya seluruh aturan
 * pembagian pokok, penentuan tunggakan, dan penjaga validasinya dapat
 * diuji langsung.
 */

// ===========================================================================
// MASUKAN
// ===========================================================================

/**
 * Satu pinjaman berjalan yang dimigrasikan. Angka yang OTORITATIF adalah
 * `sisaPokok` — bukan `jumlahPinjamanAsli` — karena itulah yang harus
 * cocok dengan saldo awal akun Piutang Pinjaman Anggota.
 */
export interface BarisMigrasiPinjaman {
  /** Nomor baris pada berkas sumber — untuk pesan galat yang bisa ditindaklanjuti. */
  baris: number;
  /** Kode anggota pada berkas sumber. */
  kodeAnggota: string;
  /**
   * Nomor pinjaman dari pembukuan LAMA. WAJIB dan harus unik: nilai ini
   * dipakai sebagai `pinjaman.nomor_pinjaman`, yang UNIQUE di skema —
   * sehingga import ulang ditolak oleh database, bukan oleh logika
   * aplikasi yang bisa terlewat. Sekaligus membuat koperasi bisa
   * mencocokkan hasil migrasi dengan buku lamanya.
   */
  nomorPinjamanAsli: string;
  /** Tanggal akad historis (harus < cut-off). */
  tanggalAkad: string;
  /** Pokok awal menurut akad — hanya untuk rujukan & penyusunan jadwal. */
  jumlahPinjamanAsli: Rupiah;
  /** SISA POKOK pada tanggal cut-off — angka yang otoritatif. */
  sisaPokok: Rupiah;
  /** Banyaknya angsuran yang MASIH TERSISA pada cut-off. */
  angsuranTersisa: number;
  satuanTenor: SatuanTenor;
  metodeJasa: 'FLAT' | 'MENURUN' | 'EFEKTIF' | 'CUSTOM';
  persentaseJasa: number;
  /** Tunggakan pokok pada cut-off (opsional). Harus <= sisaPokok. */
  tunggakanPokok?: Rupiah;
  /**
   * Piutang jasa pada cut-off (opsional). HANYA diisi bila koperasi
   * memang mengakui jasa secara akrual di pembukuan lamanya; bila tidak,
   * biarkan kosong. Nilainya TIDAK dijurnal oleh migrasi — ia hanya
   * ikut dalam rekonsiliasi terhadap saldo awal akun Piutang Jasa.
   */
  piutangJasa?: Rupiah;
  /** Status pinjaman pada cut-off; default AKTIF. */
  status?: StatusMigrasiPinjaman;
  /**
   * RC-S133.4.5 — TENOR AKAD (jumlah angsuran seluruhnya). Bila ada,
   * jadwal dibangun ULANG dari akad dengan kalkulator yang sama dengan
   * pinjaman baru (lihat `susunJadwalMigrasi`): nomor angsuran, tanggal
   * jatuh tempo, pokok, dan jasa sama persis dengan pinjaman yang
   * diinput lewat menu Pinjaman.
   */
  tenorAsli?: number;
}

/**
 * Status yang boleh dipakai baris migrasi. `LUNAS` sengaja TIDAK
 * termasuk: pinjaman yang sudah lunas sebelum cut-off tidak punya sisa
 * pokok, jadi tidak ada yang perlu dimigrasikan — memasukkannya hanya
 * menambah data mati. `DIAJUKAN`/`DISETUJUI`/`DITOLAK` juga tidak:
 * ketiganya belum/tidak pernah dicairkan, jadi bukan pinjaman berjalan.
 */
export type StatusMigrasiPinjaman = 'AKTIF' | 'MACET';

export const STATUS_MIGRASI_DIIZINKAN: readonly StatusMigrasiPinjaman[] = ['AKTIF', 'MACET'];

export interface KonteksMigrasi {
  /**
   * TANGGAL CUT-OFF PEMBUKUAN. Seluruh pinjaman dengan tanggal akad
   * SEBELUM tanggal ini masuk jalur migrasi; yang pada/­setelahnya adalah
   * pencairan baru dan WAJIB melalui jalur normal beserta seluruh
   * pemeriksaan kelayakan, likuiditas, dan saldo rekeningnya.
   */
  tanggalCutOff: string;
}

// ===========================================================================
// VALIDASI — SEBELUM ADA SATU BARIS PUN DITULIS
// ===========================================================================

export type KodeGalatMigrasi =
  | 'CUTOFF_TIDAK_VALID'
  | 'TANGGAL_AKAD_TIDAK_VALID'
  | 'AKAD_SETELAH_CUTOFF'
  | 'NOMOR_ASLI_KOSONG'
  | 'NOMOR_ASLI_GANDA'
  | 'SISA_POKOK_TIDAK_VALID'
  | 'SISA_POKOK_MELEBIHI_POKOK_ASLI'
  | 'ANGSURAN_TERSISA_TIDAK_VALID'
  | 'ANGSURAN_TERSISA_MELEBIHI_TENOR'
  | 'TUNGGAKAN_MELEBIHI_SISA_POKOK'
  | 'PIUTANG_JASA_NEGATIF'
  | 'STATUS_TIDAK_DIIZINKAN';

export interface GalatMigrasi {
  baris: number;
  kode: KodeGalatMigrasi;
  pesan: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Periksa SELURUH baris sebelum eksekusi. Mengembalikan daftar galat
 * (bukan melempar pada galat pertama) supaya pengguna dapat memperbaiki
 * seluruh berkas dalam satu putaran, bukan satu baris per percobaan.
 */
export function validasiMigrasiPinjaman(
  baris: BarisMigrasiPinjaman[],
  konteks: KonteksMigrasi
): GalatMigrasi[] {
  const galat: GalatMigrasi[] = [];
  if (!ISO.test(konteks.tanggalCutOff)) {
    galat.push({
      baris: 0,
      kode: 'CUTOFF_TIDAK_VALID',
      pesan: 'Tanggal cut-off pembukuan harus berformat YYYY-MM-DD.',
    });
    // Tanpa cut-off yang sah, pemeriksaan per baris tidak bermakna.
    return galat;
  }

  const nomorTerlihat = new Map<string, number>();
  for (const r of baris) {
    const nomor = (r.nomorPinjamanAsli ?? '').trim();
    if (nomor === '') {
      galat.push({
        baris: r.baris,
        kode: 'NOMOR_ASLI_KOSONG',
        pesan: 'Nomor pinjaman dari pembukuan lama wajib diisi — dipakai agar import ulang tidak menggandakan data.',
      });
    } else {
      const kunci = nomor.toUpperCase();
      const sebelumnya = nomorTerlihat.get(kunci);
      if (sebelumnya !== undefined) {
        galat.push({
          baris: r.baris,
          kode: 'NOMOR_ASLI_GANDA',
          pesan: `Nomor pinjaman "${nomor}" dipakai dua kali (juga di baris ${sebelumnya}).`,
        });
      } else {
        nomorTerlihat.set(kunci, r.baris);
      }
    }

    if (!ISO.test(r.tanggalAkad)) {
      galat.push({
        baris: r.baris,
        kode: 'TANGGAL_AKAD_TIDAK_VALID',
        pesan: 'Tanggal akad harus berformat YYYY-MM-DD.',
      });
    } else if (r.tanggalAkad >= konteks.tanggalCutOff) {
      galat.push({
        baris: r.baris,
        kode: 'AKAD_SETELAH_CUTOFF',
        pesan:
          `Tanggal akad ${r.tanggalAkad} tidak sebelum cut-off ${konteks.tanggalCutOff}. ` +
          `Pinjaman pada/setelah cut-off adalah pencairan baru dan harus dicairkan lewat menu Pinjaman, ` +
          `agar pemeriksaan kelayakan dan likuiditasnya tetap berjalan.`,
      });
    }

    if (!Number.isInteger(r.sisaPokok) || r.sisaPokok <= 0) {
      galat.push({
        baris: r.baris,
        kode: 'SISA_POKOK_TIDAK_VALID',
        pesan: 'Sisa pokok pada cut-off harus bilangan bulat lebih besar dari 0.',
      });
    } else if (Number.isFinite(r.jumlahPinjamanAsli) && r.sisaPokok > r.jumlahPinjamanAsli) {
      galat.push({
        baris: r.baris,
        kode: 'SISA_POKOK_MELEBIHI_POKOK_ASLI',
        pesan: `Sisa pokok (${r.sisaPokok}) tidak boleh melebihi pokok akad (${r.jumlahPinjamanAsli}).`,
      });
    }

    if (!Number.isInteger(r.angsuranTersisa) || r.angsuranTersisa <= 0) {
      galat.push({
        baris: r.baris,
        kode: 'ANGSURAN_TERSISA_TIDAK_VALID',
        pesan: 'Jumlah angsuran yang masih tersisa harus bilangan bulat lebih besar dari 0.',
      });
    }

    if (r.tenorAsli !== undefined && Number.isInteger(r.tenorAsli) && Number.isInteger(r.angsuranTersisa) && r.angsuranTersisa > r.tenorAsli) {
      galat.push({
        baris: r.baris,
        kode: 'ANGSURAN_TERSISA_MELEBIHI_TENOR',
        pesan: `Angsuran tersisa (${r.angsuranTersisa}) tidak boleh melebihi tenor akad (${r.tenorAsli}).`,
      });
    }

    if (r.tunggakanPokok !== undefined) {
      if (r.tunggakanPokok < 0 || r.tunggakanPokok > r.sisaPokok) {
        galat.push({
          baris: r.baris,
          kode: 'TUNGGAKAN_MELEBIHI_SISA_POKOK',
          pesan: `Tunggakan pokok (${r.tunggakanPokok}) harus antara 0 dan sisa pokok (${r.sisaPokok}).`,
        });
      }
    }

    if (r.piutangJasa !== undefined && r.piutangJasa < 0) {
      galat.push({
        baris: r.baris,
        kode: 'PIUTANG_JASA_NEGATIF',
        pesan: 'Piutang jasa tidak boleh negatif.',
      });
    }

    const status = r.status ?? 'AKTIF';
    if (!STATUS_MIGRASI_DIIZINKAN.includes(status)) {
      galat.push({
        baris: r.baris,
        kode: 'STATUS_TIDAK_DIIZINKAN',
        pesan: `Status "${status}" tidak dapat dimigrasikan. Gunakan ${STATUS_MIGRASI_DIIZINKAN.join(' atau ')}.`,
      });
    }
  }
  return galat;
}

// ===========================================================================
// PENYUSUNAN JADWAL SISA
// ===========================================================================

export interface BarisJadwalMigrasi {
  nomorAngsuran: number;
  tanggalJatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  /** TERLAMBAT bila jatuh tempo sudah lewat cut-off; selain itu BELUM_BAYAR. LUNAS = angsuran yang sudah dibayar sebelum cut-off (RC-S133.4.5). */
  status: 'BELUM_BAYAR' | 'TERLAMBAT' | 'LUNAS';
  /** RC-S133.4.5 — jasa angsuran LUNAS yang dibayar SEBELUM jatuh temponya (jatuh tempo >= cut-off): Pendapatan Diterima Dimuka. */
  jasaDimuka?: Rupiah;
}

/**
 * Bagi sisa pokok ke angsuran yang tersisa.
 *
 * Pembagian rata dengan SELISIH PEMBULATAN ditaruh di angsuran TERAKHIR,
 * supaya jumlah seluruh baris pokok SAMA PERSIS dengan `sisaPokok` —
 * invarian yang wajib, karena angka itulah yang direkonsiliasi ke saldo
 * awal akun Piutang Pinjaman Anggota. Kalau selisih pembulatan
 * dibiarkan, buku pembantu dan buku besar akan selisih beberapa rupiah
 * dan rekonsiliasinya gagal selamanya.
 */
export function bagiPokokSisa(sisaPokok: Rupiah, angsuranTersisa: number): Rupiah[] {
  if (angsuranTersisa <= 0) return [];
  const dasar = Math.floor(sisaPokok / angsuranTersisa);
  const hasil = new Array<number>(angsuranTersisa).fill(dasar);
  hasil[angsuranTersisa - 1] = sisaPokok - dasar * (angsuranTersisa - 1);
  return hasil;
}

/**
 * Pokok DAN jasa untuk angsuran yang masih tersisa.
 *
 * ============================================================
 * KOREKSI RC-S105 — DILAPORKAN PENGGUNA, TERBUKTI SALAH BESAR
 * ============================================================
 * Versi RC-S102 menghitung jasa flat sebagai
 *
 *     (sisaPokok x persen / 100) / angsuranTersisa
 *
 * dengan alasan yang ditulis di komentar: "untuk metode flat besarnya
 * memang proporsional terhadap pokok yang masih berjalan". Alasan itu
 * KELIRU — yang proporsional terhadap sisa pokok adalah metode MENURUN;
 * justru DEFINISI metode FLAT adalah jasa dihitung dari POKOK AKAD dan
 * SAMA setiap periode (lihat `hitungFlat` di PinjamanCalculator.ts,
 * yang sudah benar sejak awal untuk pinjaman baru).
 *
 * Akibatnya jasa pada jadwal hasil migrasi jauh terlalu kecil. Pada
 * pinjaman Rp12.000.000, tenor 12, flat 1,5% per bulan dengan 3
 * angsuran sudah dibayar:
 *
 *     seharusnya  Rp180.000 per angsuran  (total sisa Rp1.620.000)
 *     versi lama  Rp 15.000 per angsuran  (total sisa Rp  135.000)
 *
 * yaitu 12 kali lebih kecil — dan makin panjang tenornya makin jauh
 * melesetnya, karena kesalahannya berlipat pada pembagian tenor.
 *
 * ============================================================
 * MENURUN & EFEKTIF: TERNYATA DAPAT DIHITUNG
 * ============================================================
 * Komentar lama juga menyatakan keduanya "memerlukan sisa tenor asli
 * dan riwayat pembayaran yang tidak dimiliki aplikasi". Itu pun tidak
 * benar:
 *   - MENURUN: jasa periode k = pokok terutang pada periode k x persen.
 *     Pokok terutang pada cut-off ADALAH `sisaPokok`, dan sisa
 *     periodenya `angsuranTersisa`. Riwayat lama tidak diperlukan.
 *   - EFEKTIF: sisa jadwal sebuah anuitas adalah anuitas atas saldo
 *     yang tersisa untuk sisa periodenya — persis masukan yang sudah
 *     kita punya.
 * Keduanya sekarang dihitung dengan memanggil `hitungJadwalAngsuran()`
 * yang SAMA dengan pinjaman baru (bukan rumus kedua yang ditulis ulang
 * di sini), sehingga jadwal hasil migrasi dan jadwal pinjaman baru
 * mustahil memakai aturan yang berbeda.
 *
 * CUSTOM tetap 0 — jadwalnya memang diisi manual per baris, tidak ada
 * rumus yang bisa dipakai, dan menebak berarti mengarang kewajiban
 * anggota. Ini dinyatakan di `KETERBATASAN_MIGRASI`.
 *
 * Pokok tetap dijamin berjumlah PERSIS `sisaPokok` untuk seluruh metode
 * (lihat `bagiPokokSisa` dan `distributeWithRoundingFix`), karena
 * itulah yang direkonsiliasi ke saldo awal akun Piutang.
 */
export function pokokJasaAngsuranSisa(input: {
  metodeJasa: BarisMigrasiPinjaman['metodeJasa'];
  /** Pokok menurut AKAD — dasar jasa untuk metode FLAT. */
  jumlahPinjamanAsli: Rupiah;
  sisaPokok: Rupiah;
  angsuranTersisa: number;
  persentaseJasa: number;
}): { pokok: Rupiah[]; jasa: Rupiah[] } {
  const { metodeJasa, jumlahPinjamanAsli, sisaPokok, angsuranTersisa, persentaseJasa } = input;
  if (angsuranTersisa <= 0) return { pokok: [], jasa: [] };

  const persenSah = Number.isFinite(persentaseJasa) && persentaseJasa > 0 ? persentaseJasa : 0;

  if (metodeJasa === 'MENURUN' || metodeJasa === 'EFEKTIF') {
    if (persenSah === 0) {
      return { pokok: bagiPokokSisa(sisaPokok, angsuranTersisa), jasa: new Array(angsuranTersisa).fill(0) };
    }
    const baris = hitungJadwalAngsuran({
      jumlahPinjaman: sisaPokok,
      tenor: angsuranTersisa,
      persentaseJasaPerPeriode: persenSah,
      metode: metodeJasa,
    });
    return { pokok: baris.map((b) => b.pokok), jasa: baris.map((b) => b.jasa) };
  }

  const pokok = bagiPokokSisa(sisaPokok, angsuranTersisa);
  if (metodeJasa !== 'FLAT' || persenSah === 0) {
    return { pokok, jasa: new Array(angsuranTersisa).fill(0) };
  }
  // FLAT: dari pokok AKAD, sama tiap periode — sama persis dengan
  // `hitungFlat()` pada jadwal pinjaman baru.
  const jasaPerPeriode = Math.round((jumlahPinjamanAsli * persenSah) / 100);
  return { pokok, jasa: new Array(angsuranTersisa).fill(jasaPerPeriode) };
}

/** Maju satu periode dari sebuah tanggal ISO, sesuai satuan tenor. */
export function majuPeriode(iso: string, satuan: SatuanTenor, langkah: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dasar = new Date(Date.UTC(y, m - 1, d));
  if (satuan === 'BULAN') {
    const targetBulan = dasar.getUTCMonth() + langkah;
    const hasil = new Date(Date.UTC(dasar.getUTCFullYear(), targetBulan, 1));
    // Pertahankan tanggal, tapi jangan melewati akhir bulan (31 Jan + 1
    // bulan = 28/29 Feb, bukan 3 Maret) — pola yang sama dipakai
    // InstallmentDate untuk jadwal normal.
    const akhirBulan = new Date(Date.UTC(hasil.getUTCFullYear(), hasil.getUTCMonth() + 1, 0)).getUTCDate();
    hasil.setUTCDate(Math.min(d, akhirBulan));
    return hasil.toISOString().slice(0, 10);
  }
  const hari = satuan === 'MINGGU' ? 7 * langkah : langkah;
  dasar.setUTCDate(dasar.getUTCDate() + hari);
  return dasar.toISOString().slice(0, 10);
}

/**
 * Susun jadwal angsuran yang MASIH TERSISA.
 *
 * Nomor angsuran dilanjutkan dari posisi terakhir bila diketahui
 * (`nomorAngsuranTerakhirTerbayar`), supaya nomor pada buku pembantu
 * cocok dengan buku lama koperasi. Jatuh tempo pertama adalah satu
 * periode SETELAH cut-off, kecuali ada tunggakan — angsuran tertunggak
 * diberi jatuh tempo SEBELUM cut-off dan berstatus TERLAMBAT, sehingga
 * aging dan kolektibilitas terbaca benar sejak hari pertama.
 */
export function susunJadwalSisa(input: {
  /**
   * KOREKSI RC-S105 — WAJIB. Dasar jasa metode FLAT adalah pokok AKAD,
   * bukan sisa pokok; tanpa nilai ini jasa flat mustahil benar.
   */
  jumlahPinjamanAsli: Rupiah;
  sisaPokok: Rupiah;
  angsuranTersisa: number;
  tunggakanPokok?: Rupiah;
  satuanTenor: SatuanTenor;
  metodeJasa: BarisMigrasiPinjaman['metodeJasa'];
  persentaseJasa: number;
  tanggalCutOff: string;
  nomorAngsuranMulai?: number;
}): BarisJadwalMigrasi[] {
  const { pokok: pokokPerAngsuran, jasa: jasaPerAngsuran } = pokokJasaAngsuranSisa({
    metodeJasa: input.metodeJasa,
    jumlahPinjamanAsli: input.jumlahPinjamanAsli,
    sisaPokok: input.sisaPokok,
    angsuranTersisa: input.angsuranTersisa,
    persentaseJasa: input.persentaseJasa,
  });
  const mulai = input.nomorAngsuranMulai ?? 1;

  // Banyaknya angsuran yang dianggap TERTUNGGAK: angsuran-angsuran
  // pertama dari sisa, sampai akumulasi pokoknya menutupi tunggakan.
  const tunggakan = input.tunggakanPokok ?? 0;
  let terkumpul = 0;
  let jumlahTertunggak = 0;
  if (tunggakan > 0) {
    for (const p of pokokPerAngsuran) {
      if (terkumpul >= tunggakan) break;
      terkumpul += p;
      jumlahTertunggak += 1;
    }
  }

  return pokokPerAngsuran.map((pokok, i) => {
    const tertunggak = i < jumlahTertunggak;
    // Tertunggak -> jatuh tempo di masa lalu (dihitung mundur dari
    // cut-off); belum jatuh tempo -> maju dari cut-off.
    const tanggalJatuhTempo = tertunggak
      ? majuPeriode(input.tanggalCutOff, input.satuanTenor, -(jumlahTertunggak - i))
      : majuPeriode(input.tanggalCutOff, input.satuanTenor, i - jumlahTertunggak + 1);
    return {
      nomorAngsuran: mulai + i,
      tanggalJatuhTempo,
      pokok,
      jasa: jasaPerAngsuran[i] ?? 0,
      status: tertunggak ? 'TERLAMBAT' : 'BELUM_BAYAR',
    };
  });
}

// ===========================================================================
// REKONSILIASI KE BUKU BESAR
// ===========================================================================

/**
 * RC-S133.4.5 — JADWAL MIGRASI DARI AKAD (mode RIWAYAT).
 *
 * Masalah jadwal lama (`susunJadwalSisa`): jatuh tempo dihitung dari
 * TANGGAL CUT-OFF (mis. setiap tanggal 29), bukan dari tanggal akad;
 * angsuran yang menunggak diberi tanggal mundur dari cut-off dan
 * jumlahnya bisa lebih satu karena pembulatan; pokok per angsuran
 * dibagi ulang dari sisa sehingga berbeda Rp1 dari kartu angsuran
 * anggota. Hasilnya tunggakan, kolektibilitas, denda, dan pengingat
 * tidak sama dengan pinjaman yang diinput biasa.
 *
 * Sekarang, bila tenor akad diketahui, jadwal LENGKAP dibangun dengan
 * `hitungJadwalAngsuran` + `calculateInstallmentDate` — PERSIS seperti
 * `ajukanPinjaman` — lalu:
 *  - angsuran ke-1..N (N = tenor − angsuran tersisa) = LUNAS. Jasanya
 *    yang jatuh tempo pada/setelah cut-off (dibayar di muka) dicatat
 *    `jasa_dimuka`, sama seperti `bayarAngsuran` sebelum jatuh tempo;
 *  - sisanya BELUM_BAYAR dengan tanggal jatuh tempo ASLI. Tunggakan
 *    terbaca otomatis dari tanggal (yang sudah lewat & belum dibayar),
 *    sama seperti pinjaman biasa — kolom Tunggakan Pokok tidak lagi
 *    menentukan apa pun, hanya dicocokkan.
 *
 * Bila sisa pokok di berkas BERBEDA dari sisa menurut jadwal akad
 * (pembukuan lama mencatat pembayaran tidak penuh, restrukturisasi,
 * dsb.), pinjaman itu tidak lagi mengikuti jadwal akadnya: jadwal sisa
 * disusun dari cut-off memakai sisa pokok & Tunggakan Pokok berkas
 * (perilaku lama `susunJadwalSisa`, mode SISA). Begitu pula tanpa tenor
 * akad atau metode CUSTOM (mode LAMA).
 */
export interface HasilJadwalMigrasi {
  mode: 'RIWAYAT' | 'SISA' | 'LAMA';
  baris: BarisJadwalMigrasi[];
  /** Tenor yang disimpan pada pinjaman (tenor akad untuk RIWAYAT/SISA). */
  tenor: number;
  /** Pokok tertunggak per cut-off menurut tanggal jatuh tempo. */
  tunggakanPokok: Rupiah;
}

export function susunJadwalMigrasi(input: {
  tanggalAkad: string;
  jumlahPinjamanAsli: Rupiah;
  tenorAsli?: number;
  sisaPokok: Rupiah;
  angsuranTersisa: number;
  tunggakanPokok?: Rupiah;
  satuanTenor: SatuanTenor;
  metodeJasa: BarisMigrasiPinjaman['metodeJasa'];
  persentaseJasa: number;
  tanggalCutOff: string;
}): HasilJadwalMigrasi {
  const tenor = input.tenorAsli;
  const bisaRiwayat =
    tenor !== undefined &&
    Number.isInteger(tenor) &&
    tenor >= input.angsuranTersisa &&
    input.angsuranTersisa > 0 &&
    input.metodeJasa !== 'CUSTOM' &&
    ISO.test(input.tanggalAkad);
  if (!bisaRiwayat) {
    const baris = susunJadwalSisa(input);
    return {
      mode: 'LAMA',
      baris,
      tenor: input.angsuranTersisa,
      tunggakanPokok: baris.filter((b) => b.status === 'TERLAMBAT').reduce((t, b) => t + b.pokok, 0),
    };
  }
  const t = tenor as number;
  const persenSah = Number.isFinite(input.persentaseJasa) && input.persentaseJasa > 0 ? input.persentaseJasa : 0;
  const penuh = hitungJadwalAngsuran({
    jumlahPinjaman: input.jumlahPinjamanAsli,
    tenor: t,
    persentaseJasaPerPeriode: persenSah,
    metode: input.metodeJasa,
  });
  const dibayar = t - input.angsuranTersisa;
  const sisaMenurutAkad = penuh.slice(dibayar).reduce((s, b) => s + b.pokok, 0);
  if (sisaMenurutAkad !== input.sisaPokok) {
    const baris = susunJadwalSisa(input);
    return {
      mode: 'SISA',
      baris,
      tenor: input.angsuranTersisa,
      tunggakanPokok: baris.filter((b) => b.status === 'TERLAMBAT').reduce((t, b) => t + b.pokok, 0),
    };
  }
  const mode = 'RIWAYAT' as const;
  const pokokSisa = penuh.slice(dibayar).map((b) => b.pokok);
  const jasaSisa = penuh.slice(dibayar).map((b) => b.jasa);
  const baris: BarisJadwalMigrasi[] = [];
  for (let i = 0; i < t; i++) {
    const nomor = i + 1;
    const tanggalJatuhTempo = calculateInstallmentDate(input.tanggalAkad, nomor, input.satuanTenor);
    if (i < dibayar) {
      const b = penuh[i];
      baris.push({
        nomorAngsuran: nomor,
        tanggalJatuhTempo,
        pokok: b.pokok,
        jasa: b.jasa,
        status: 'LUNAS',
        jasaDimuka: tanggalJatuhTempo >= input.tanggalCutOff ? b.jasa : 0,
      });
    } else {
      baris.push({
        nomorAngsuran: nomor,
        tanggalJatuhTempo,
        pokok: pokokSisa[i - dibayar],
        jasa: jasaSisa[i - dibayar] ?? 0,
        status: 'BELUM_BAYAR',
      });
    }
  }
  const tunggakanPokok = baris
    .filter((b) => b.status === 'BELUM_BAYAR' && b.tanggalJatuhTempo < input.tanggalCutOff)
    .reduce((s, b) => s + b.pokok, 0);
  return { mode, baris, tenor: t, tunggakanPokok };
}

/**
 * RC-S133.4.5 — alokasi Piutang Jasa per pinjaman ke angsuran yang belum
 * dibayar (FIFO, angsuran tertua dulu) — dipakai untuk mendaftarkan
 * piutang jasa hasil migrasi per periode, supaya akrual otomatis TIDAK
 * mengakui ulang jasa yang sudah ada di saldo awal (bug jasa ganda), dan
 * pembayaran angsuran itu kelak mengurangi Piutang Jasa, bukan
 * menambah pendapatan lagi.
 */
export function alokasiPiutangJasaMigrasi(
  baris: BarisJadwalMigrasi[],
  piutangJasa: Rupiah
): { periode: string; nomorAngsuran: number; jumlah: Rupiah }[] {
  const hasil: { periode: string; nomorAngsuran: number; jumlah: Rupiah }[] = [];
  let sisa = Math.max(0, Math.round(piutangJasa || 0));
  for (const b of baris) {
    if (sisa <= 0) break;
    if (b.status === 'LUNAS' || b.jasa <= 0) continue;
    const ambil = Math.min(sisa, b.jasa);
    const periode = b.tanggalJatuhTempo.slice(0, 7);
    const ada = hasil.find((h) => h.periode === periode);
    if (ada) ada.jumlah += ambil;
    else hasil.push({ periode, nomorAngsuran: b.nomorAngsuran, jumlah: ambil });
    sisa -= ambil;
  }
  return hasil;
}

export interface RekonsiliasiPiutang {
  /** Jumlah sisa pokok seluruh pinjaman hasil migrasi (buku pembantu). */
  totalSisaPokokBukuPembantu: Rupiah;
  /** Saldo awal akun Piutang Pinjaman Anggota (buku besar); null bila belum diisi. */
  saldoAwalPiutangPokok: Rupiah | null;
  selisihPokok: Rupiah | null;
  /** Jumlah piutang jasa yang dilaporkan baris migrasi. */
  totalPiutangJasaBukuPembantu: Rupiah;
  saldoAwalPiutangJasa: Rupiah | null;
  selisihJasa: Rupiah | null;
  cocok: boolean;
  pesan: string[];
}

/**
 * Bandingkan buku pembantu hasil migrasi dengan saldo awal buku besar.
 *
 * Inilah penjaga agar tidak terjadi penghitungan ganda maupun kurang
 * catat: `postingSaldoAwal()` sudah menjamin JURNALNYA seimbang, tetapi
 * tidak tahu apa pun tentang rincian per anggota. Kalau kedua sisi tidak
 * sama, laporan piutang per anggota dan neraca akan bercerita berbeda —
 * dan itu harus terlihat, bukan diam-diam dibiarkan.
 *
 * Saldo awal yang BELUM diisi dikembalikan `null` (bukan 0) dan dilaporkan
 * sebagai langkah yang belum dikerjakan, bukan sebagai selisih.
 */
export function rekonsiliasiPiutang(input: {
  totalSisaPokokBukuPembantu: Rupiah;
  saldoAwalPiutangPokok: Rupiah | null;
  totalPiutangJasaBukuPembantu: Rupiah;
  saldoAwalPiutangJasa: Rupiah | null;
}): RekonsiliasiPiutang {
  const pesan: string[] = [];
  const selisihPokok =
    input.saldoAwalPiutangPokok === null
      ? null
      : input.totalSisaPokokBukuPembantu - input.saldoAwalPiutangPokok;
  const selisihJasa =
    input.saldoAwalPiutangJasa === null
      ? null
      : input.totalPiutangJasaBukuPembantu - input.saldoAwalPiutangJasa;

  if (input.saldoAwalPiutangPokok === null) {
    pesan.push(
      'Saldo awal akun Piutang Pinjaman Anggota belum diisi. Isi lewat Saldo Awal Akun sebesar ' +
        `${input.totalSisaPokokBukuPembantu}, lalu posting saldo awal agar buku besar cocok dengan rincian per anggota.`
    );
  } else if (selisihPokok !== 0) {
    pesan.push(
      `Selisih piutang pokok ${selisihPokok}: rincian per anggota ${input.totalSisaPokokBukuPembantu} ` +
        `vs saldo awal buku besar ${input.saldoAwalPiutangPokok}. Perbaiki salah satunya sebelum laporan dipakai.`
    );
  }

  // RC-S133.4.5 — saldo awal Piutang Jasa ada, tetapi tidak satu pun
  // pinjaman membawa rincian Piutang Jasa: piutang itu tidak akan pernah
  // tertagih lewat angsuran (yatim) dan akrual otomatis akan mengakui
  // jasa tunggakan sekali lagi.
  if (input.totalPiutangJasaBukuPembantu === 0 && (input.saldoAwalPiutangJasa ?? 0) > 0) {
    pesan.push(
      `Saldo awal Piutang Jasa Pinjaman Rp${(input.saldoAwalPiutangJasa as number).toLocaleString('id-ID')} tidak punya rincian per pinjaman. ` +
        'Isi kolom Piutang Jasa pada sheet Pinjaman (per pinjaman) lalu impor ulang, atau hapus saldo awal itu bila pembukuan lama tidak mengakui jasa secara akrual.'
    );
  }

  if (input.totalPiutangJasaBukuPembantu > 0) {
    if (input.saldoAwalPiutangJasa === null) {
      pesan.push(
        'Baris migrasi melaporkan piutang jasa, tetapi saldo awal akun Piutang Jasa Pinjaman belum diisi.'
      );
    } else if (selisihJasa !== 0) {
      pesan.push(
        `Selisih piutang jasa ${selisihJasa}: rincian ${input.totalPiutangJasaBukuPembantu} ` +
          `vs saldo awal ${input.saldoAwalPiutangJasa}.`
      );
    }
  }

  return {
    totalSisaPokokBukuPembantu: input.totalSisaPokokBukuPembantu,
    saldoAwalPiutangPokok: input.saldoAwalPiutangPokok,
    selisihPokok,
    totalPiutangJasaBukuPembantu: input.totalPiutangJasaBukuPembantu,
    saldoAwalPiutangJasa: input.saldoAwalPiutangJasa,
    selisihJasa,
    cocok: pesan.length === 0,
    pesan,
  };
}

// ===========================================================================
// PENANDA & KETERBATASAN
// ===========================================================================

/**
 * Penanda pada `pinjaman.keterangan`. Dipakai laporan/manusia untuk
 * mengenali baris hasil migrasi, dan oleh eksekutor untuk menolak
 * migrasi ulang atas nomor yang sama. TIDAK memakai kolom baru: nomor
 * pinjaman yang UNIQUE sudah menjadi penjaga duplikasi yang sebenarnya
 * (lihat `BarisMigrasiPinjaman.nomorPinjamanAsli`).
 */
export const PENANDA_MIGRASI = 'MIGRASI SALDO AWAL';

export function keteranganMigrasi(tanggalCutOff: string, catatan?: string): string {
  const dasar = `${PENANDA_MIGRASI} per ${tanggalCutOff}. Pokok tidak dicairkan lewat kas — sisi buku besar lewat Saldo Awal Akun.`;
  return catatan ? `${dasar} ${catatan}` : dasar;
}

export function adalahPinjamanMigrasi(keterangan: string | null | undefined): boolean {
  return typeof keterangan === 'string' && keterangan.startsWith(PENANDA_MIGRASI);
}

export const KETERBATASAN_MIGRASI: string[] = [
  'Riwayat angsuran sebelum cut-off TIDAK dibuat: aplikasi tidak memiliki tanggal & nominal tiap pembayaran lama, dan membuatnya berarti mengarang data. Yang dibangun hanya angsuran yang masih tersisa.',
  'Jasa angsuran sisa dihitung untuk metode FLAT (dari pokok akad, sama tiap periode), MENURUN, dan EFEKTIF — memakai kalkulator yang sama dengan pinjaman baru. Hanya metode CUSTOM yang diisi 0, karena jadwalnya memang disusun manual per baris; isi lewat Akad Ulang bila diperlukan.',
  'Migrasi TIDAK menjurnal apa pun. Sisi buku besar (Piutang Pinjaman Anggota, dan Piutang Jasa bila ada) WAJIB diisi lewat Saldo Awal Akun lalu diposting, agar neraca pada cut-off seimbang.',
  'Pinjaman yang sudah lunas sebelum cut-off tidak dimigrasikan karena tidak punya sisa pokok.',
];
