import Decimal from 'decimal.js';
import { roundToRupiah, formatRupiah, Rupiah, sum } from '@/utils/money';

export type MetodeJasa = 'FLAT' | 'EFEKTIF' | 'MENURUN' | 'CUSTOM';
export type SatuanTenor = 'HARI' | 'MINGGU' | 'BULAN';

export interface AngsuranRow {
  nomorAngsuran: number;
  pokok: Rupiah;
  jasa: Rupiah;
  total: Rupiah;
}

export interface HitungAngsuranInput {
  jumlahPinjaman: Rupiah;
  tenor: number;
  persentaseJasaPerPeriode: number; // dalam persen, per periode tenor (bukan per tahun)
  metode: MetodeJasa;
}

/**
 * Menghasilkan rincian pokok+jasa per angsuran sesuai metode yang dipilih
 * admin (PRD §11: "Admin dapat memilih metode. Jangan hard-code satu metode.")
 *
 * FLAT     : jasa dihitung dari pokok awal, sama tiap periode.
 * MENURUN  : jasa dihitung dari sisa pokok tiap periode (menurun tiap periode).
 * EFEKTIF  : angsuran total tetap (mirip anuitas), pokok & jasa proporsi berubah.
 * CUSTOM   : tidak dihitung otomatis — dikembalikan array kosong, form input
 *            manual per baris disediakan di UI (Pengaturan > Pinjaman > Custom).
 */
export function hitungJadwalAngsuran(input: HitungAngsuranInput): AngsuranRow[] {
  const { jumlahPinjaman, tenor, persentaseJasaPerPeriode, metode } = input;

  if (tenor <= 0) throw new Error('Tenor harus lebih besar dari 0.');
  if (jumlahPinjaman <= 0) throw new Error('Jumlah pinjaman harus lebih besar dari 0.');

  switch (metode) {
    case 'FLAT':
      return hitungFlat(jumlahPinjaman, tenor, persentaseJasaPerPeriode);
    case 'MENURUN':
      return hitungMenurun(jumlahPinjaman, tenor, persentaseJasaPerPeriode);
    case 'EFEKTIF':
      return hitungEfektif(jumlahPinjaman, tenor, persentaseJasaPerPeriode);
    case 'CUSTOM':
      return [];
    default:
      throw new Error(`Metode jasa tidak dikenal: ${metode}`);
  }
}

function hitungFlat(pokokPinjaman: Rupiah, tenor: number, persenPerPeriode: number): AngsuranRow[] {
  const pokokPerPeriode = new Decimal(pokokPinjaman).div(tenor);
  const jasaPerPeriode = new Decimal(pokokPinjaman).mul(persenPerPeriode).div(100);

  return distributeWithRoundingFix(
    tenor,
    pokokPinjaman,
    Array.from({ length: tenor }, () => roundToRupiah(pokokPerPeriode)),
    Array.from({ length: tenor }, () => roundToRupiah(jasaPerPeriode))
  );
}

function hitungMenurun(pokokPinjaman: Rupiah, tenor: number, persenPerPeriode: number): AngsuranRow[] {
  const pokokPerPeriode = new Decimal(pokokPinjaman).div(tenor);
  let sisaPokok = new Decimal(pokokPinjaman);
  const pokokArr: Rupiah[] = [];
  const jasaArr: Rupiah[] = [];

  for (let i = 0; i < tenor; i++) {
    const jasa = sisaPokok.mul(persenPerPeriode).div(100);
    pokokArr.push(roundToRupiah(pokokPerPeriode));
    jasaArr.push(roundToRupiah(jasa));
    sisaPokok = sisaPokok.minus(pokokPerPeriode);
  }

  return distributeWithRoundingFix(tenor, pokokPinjaman, pokokArr, jasaArr);
}

function hitungEfektif(pokokPinjaman: Rupiah, tenor: number, persenPerPeriode: number): AngsuranRow[] {
  // Anuitas: angsuran tetap = P * i / (1 - (1+i)^-n)
  const i = new Decimal(persenPerPeriode).div(100);
  const P = new Decimal(pokokPinjaman);
  const n = tenor;

  let angsuranTetap: Decimal;
  if (i.isZero()) {
    angsuranTetap = P.div(n);
  } else {
    const factor = new Decimal(1).plus(i).pow(-n);
    angsuranTetap = P.mul(i).div(new Decimal(1).minus(factor));
  }

  let sisaPokok = P;
  const pokokArr: Rupiah[] = [];
  const jasaArr: Rupiah[] = [];

  for (let k = 0; k < n; k++) {
    const jasa = sisaPokok.mul(i);
    const pokok = angsuranTetap.minus(jasa);
    pokokArr.push(roundToRupiah(pokok));
    jasaArr.push(roundToRupiah(jasa));
    sisaPokok = sisaPokok.minus(pokok);
  }

  return distributeWithRoundingFix(tenor, pokokPinjaman, pokokArr, jasaArr);
}

/**
 * Karena pembulatan tiap periode, total pokok bisa selisih 1-beberapa Rupiah
 * dari jumlah pinjaman asli. Selisih dikoreksi di ANGSURAN TERAKHIR supaya
 * total pokok seluruh angsuran = jumlah pinjaman persis (wajib untuk validasi
 * PRD §43: tidak boleh ada selisih debit/kredit di jurnal pelunasan).
 */
function distributeWithRoundingFix(
  tenor: number,
  jumlahPinjaman: Rupiah,
  pokokArr: Rupiah[],
  jasaArr: Rupiah[]
): AngsuranRow[] {
  const totalPokokTerhitung = sum(pokokArr);
  const selisih = jumlahPinjaman - totalPokokTerhitung;
  if (selisih !== 0) {
    pokokArr[tenor - 1] += selisih;
  }

  return pokokArr.map((pokok, idx) => ({
    nomorAngsuran: idx + 1,
    pokok,
    jasa: jasaArr[idx],
    total: pokok + jasaArr[idx],
  }));
}

/** Denda (PRD §15) — mendukung beberapa tipe, tidak hard-code. */
export type DendaTipe = 'NOMINAL' | 'PERSENTASE' | 'PER_HARI' | 'PER_PERIODE' | 'CUSTOM';

export function hitungDenda(params: {
  aktif: boolean;
  tipe?: DendaTipe;
  nilai: number;          // nominal tetap ATAU persentase, tergantung tipe
  sisaTagihan: Rupiah;     // pokok+jasa yang belum dibayar pada angsuran ini
  hariTerlambat: number;
}): Rupiah {
  if (!params.aktif || params.hariTerlambat <= 0) return 0;

  switch (params.tipe) {
    case 'NOMINAL':
      return roundToRupiah(params.nilai);
    case 'PERSENTASE':
      return roundToRupiah(new Decimal(params.sisaTagihan).mul(params.nilai).div(100));
    case 'PER_HARI':
      return roundToRupiah(new Decimal(params.nilai).mul(params.hariTerlambat));
    case 'PER_PERIODE':
      return roundToRupiah(params.nilai); // 1x per periode terlambat, dihitung saat generate
    case 'CUSTOM':
      return 0; // nilai custom diinput manual oleh admin di form pembayaran
    default:
      return 0;
  }
}

// ============================================================
// JADWAL ANGSURAN CUSTOM (fase 9) — pokok & bunga tiap periode
// ditentukan manual oleh admin, bukan dihitung dari rumus FLAT/
// EFEKTIF/MENURUN. Logika di bawah ini MURNI (tanpa I/O), dipisahkan
// dari PinjamanService.ts supaya testable — pola yang sama dengan
// ShuCalculator.ts/BackupValidator.ts.
// ============================================================

export interface BarisAngsuranCustomInput {
  nomorAngsuran: number;
  tanggalJatuhTempo: string; // ISO date (YYYY-MM-DD)
  pokok: Rupiah;
  jasa: Rupiah; // bunga periode ini
}

export interface BarisAngsuranCustomHasil extends BarisAngsuranCustomInput {
  total: Rupiah; // pokok + jasa — dihitung otomatis (fase 9 §6)
}

/** Total angsuran tiap periode dihitung otomatis dari pokok+jasa (fase 9 §6). */
export function hitungTotalBarisCustom(baris: BarisAngsuranCustomInput[]): BarisAngsuranCustomHasil[] {
  return baris.map((b) => ({ ...b, total: b.pokok + b.jasa }));
}

export interface RingkasanJadwalCustom {
  jumlahPeriode: number;
  totalPokok: Rupiah;
  totalJasa: Rupiah;
  totalAngsuran: Rupiah;
}

export interface ValidasiJadwalCustomResult extends RingkasanJadwalCustom {
  valid: boolean;
  errors: string[];
}

/**
 * Validasi jadwal angsuran custom sebelum disimpan (fase 9 §7-9):
 *  - total pokok seluruh periode HARUS PERSIS SAMA dengan pokok pinjaman
 *  - nominal pokok/jasa tidak boleh negatif, dan tidak boleh sebaris
 *    dengan total 0 (periode kosong tidak berguna)
 *  - tanggal jatuh tempo harus valid & urut naik (tiap periode setelah
 *    periode sebelumnya, dan periode pertama setelah tanggal pinjaman)
 *  - nomor angsuran harus 1..N berurutan tanpa lompat/duplikat
 */
export function validasiJadwalCustom(
  baris: BarisAngsuranCustomInput[],
  jumlahPinjaman: Rupiah,
  tanggalPinjaman: string
): ValidasiJadwalCustomResult {
  const errors: string[] = [];

  if (baris.length === 0) {
    errors.push('Jadwal angsuran custom minimal harus punya 1 periode.');
  }

  baris.forEach((b, idx) => {
    if (b.nomorAngsuran !== idx + 1) {
      errors.push(`Nomor angsuran harus berurutan 1..N tanpa lompat — ditemukan urutan tidak sesuai di posisi ${idx + 1}.`);
    }
    if (b.pokok < 0) errors.push(`Periode ${b.nomorAngsuran}: pokok tidak boleh negatif.`);
    if (b.jasa < 0) errors.push(`Periode ${b.nomorAngsuran}: bunga tidak boleh negatif.`);
    if (b.pokok === 0 && b.jasa === 0) errors.push(`Periode ${b.nomorAngsuran}: total angsuran tidak boleh 0.`);

    if (!b.tanggalJatuhTempo || isNaN(new Date(b.tanggalJatuhTempo).getTime())) {
      errors.push(`Periode ${b.nomorAngsuran}: tanggal jatuh tempo tidak valid.`);
    }
  });

  let tanggalSebelumnya = tanggalPinjaman;
  for (const b of baris) {
    if (b.tanggalJatuhTempo && !isNaN(new Date(b.tanggalJatuhTempo).getTime())) {
      if (b.tanggalJatuhTempo <= tanggalSebelumnya) {
        errors.push(
          `Periode ${b.nomorAngsuran}: tanggal jatuh tempo (${b.tanggalJatuhTempo}) harus setelah periode sebelumnya (${tanggalSebelumnya}).`
        );
      }
      tanggalSebelumnya = b.tanggalJatuhTempo;
    }
  }

  const totalPokok = sum(baris.map((b) => b.pokok));
  const totalJasa = sum(baris.map((b) => b.jasa));

  if (totalPokok !== jumlahPinjaman) {
    errors.push(
      `Total pokok seluruh periode (${formatRupiah(totalPokok)}) harus PERSIS SAMA dengan jumlah pinjaman (${formatRupiah(jumlahPinjaman)}).`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    jumlahPeriode: baris.length,
    totalPokok,
    totalJasa,
    totalAngsuran: totalPokok + totalJasa,
  };
}
