/**
 * BUNGA HARIAN SIMPANAN SUKARELA — MESIN HITUNG MURNI.
 * ============================================================
 * Definisi yang disepakati (keputusan pengguna):
 *
 *   bunga hari d = saldo AKHIR HARI d × tarif tahunan ÷ 365
 *   bunga bulan  = Σ bunga hari d, untuk SELURUH hari kalender bulan itu
 *                  (tanggal 1 s.d. hari terakhir, termasuk hari terakhir)
 *
 *   - Transaksi berlaku mulai TANGGAL transaksinya: saldo akhir hari d
 *     sudah memuat semua mutasi bertanggal <= d. Saldo sebelum dan
 *     sesudah transaksi tidak pernah tercampur dalam satu hari.
 *   - Basis 365 hari selalu (juga di tahun kabisat), sesuai rumus saldo
 *     harian Juklat SOM 2025 hlm. 7 & 31.
 *   - Saldo nol/negatif tidak berbunga pada hari itu.
 *   - Rupiah utuh: Σ bunga harian dibulatkan KE BAWAH sekali per anggota
 *     per bulan (koperasi tidak pernah membayar lebih dari tarif).
 *
 * Catatan acuan: contoh Lampiran 10 Juklat (rekening Tn. Edi, Des 2022)
 * tidak menghitung hari terakhir bulan (2+7+13+8 = 30 hari, Rp11.013,70).
 * Mesin ini menghitung seluruh 31 hari (Rp11.309) — contoh lampiran
 * diperlakukan sebagai ilustrasi, sesuai keputusan pengguna.
 *
 * Modul ini TIDAK menulis apa pun; pencatatan ada di BungaSukarelaService.
 */

export interface MutasiSukarela {
  /** 'YYYY-MM-DD'. Mutasi di luar bulan yang dihitung diabaikan. */
  tanggal: string;
  /** Setor/kredit positif, tarik/debit negatif. */
  delta: number;
}

export interface RuasSaldo {
  /** Tanggal pertama & terakhir ruas (inklusif). */
  dari: string;
  sampai: string;
  hari: number;
  /** Saldo akhir hari sepanjang ruas. */
  saldo: number;
}

export interface InputBungaHarian {
  /** 'YYYY-MM'. */
  periode: string;
  /** Saldo pada akhir hari terakhir bulan sebelumnya. */
  saldoAwal: number;
  mutasi: readonly MutasiSukarela[];
  tarifPersenTahun: number;
  /** Opsional: hitung hanya s.d. tanggal ini (perkiraan bunga berjalan). */
  sampaiTanggal?: string;
}

export interface HasilBungaHarian {
  jumlahHari: number;
  /** Σ (saldo berbunga × 1 hari) — dasar audit; bunga = saldoHari × tarif ÷ 365. */
  saldoHari: number;
  saldoAkhir: number;
  bungaTepat: number;
  bunga: number;
  ruas: RuasSaldo[];
}

export const BASIS_HARI_SETAHUN = 365;

/** Batas imbalan simpanan menurut Juklat SOM 2025 hlm. 7 (persen per tahun). */
export const BATAS_TARIF_BUNGA_SIMPANAN_PERSEN = 9;

export function jumlahHariBulan(periode: string): number {
  const [y, m] = periode.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function akhirBulan(periode: string): string {
  return `${periode}-${String(jumlahHariBulan(periode)).padStart(2, '0')}`;
}

export function bulanBerikut(periode: string): string {
  const [y, m] = periode.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function bulanSebelum(periode: string): string {
  const [y, m] = periode.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Bunga satu hari (pecahan rupiah) — untuk tampilan "bunga hari ini". */
export function bungaSatuHari(saldoAkhirHari: number, tarifPersenTahun: number): number {
  return saldoAkhirHari > 0 ? (saldoAkhirHari * tarifPersenTahun) / 100 / BASIS_HARI_SETAHUN : 0;
}

export function hitungBungaHarian(input: InputBungaHarian): HasilBungaHarian {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periode)) throw new Error('Periode bunga harus berformat YYYY-MM.');
  if (!Number.isFinite(input.tarifPersenTahun) || input.tarifPersenTahun < 0) throw new Error('Tarif bunga tidak valid.');
  const nHariBulan = jumlahHariBulan(input.periode);
  const batas =
    input.sampaiTanggal && input.sampaiTanggal.startsWith(input.periode)
      ? Math.min(nHariBulan, Number(input.sampaiTanggal.slice(8, 10)))
      : input.sampaiTanggal && input.sampaiTanggal < `${input.periode}-01`
        ? 0
        : nHariBulan;

  // Mutasi per tanggal (hari ke-n). Urutan dalam satu hari tidak
  // berpengaruh karena yang dipakai saldo AKHIR hari.
  const perHari = new Array<number>(nHariBulan + 1).fill(0);
  for (const m of input.mutasi) {
    if (!m.tanggal.startsWith(input.periode)) continue;
    perHari[Number(m.tanggal.slice(8, 10))] += m.delta;
  }

  const ruas: RuasSaldo[] = [];
  let saldo = input.saldoAwal;
  let saldoHari = 0;
  for (let d = 1; d <= batas; d++) {
    saldo += perHari[d];
    const berbunga = saldo > 0 ? saldo : 0;
    saldoHari += berbunga;
    const tgl = `${input.periode}-${String(d).padStart(2, '0')}`;
    const akhir = ruas[ruas.length - 1];
    if (akhir && akhir.saldo === saldo) {
      akhir.sampai = tgl;
      akhir.hari += 1;
    } else {
      ruas.push({ dari: tgl, sampai: tgl, hari: 1, saldo });
    }
  }
  const bungaTepat = (saldoHari * input.tarifPersenTahun) / 100 / BASIS_HARI_SETAHUN;
  // Toleransi kecil terhadap galat floating point (mis. 1.499,9999999).
  const bunga = Math.max(0, Math.floor(bungaTepat + 1e-6));
  return { jumlahHari: batas, saldoHari, saldoAkhir: saldo, bungaTepat, bunga, ruas };
}
