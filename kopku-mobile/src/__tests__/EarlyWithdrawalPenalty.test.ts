import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, ACC, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-02 §D/§R — PENALTI. */

const hitung = (k: Partial<KebijakanEarlyWithdrawal>) =>
  calculateEarlyWithdrawalSettlement({
    pokok: POKOK,
    tanggalMulai: PLACEMENT,
    tanggalJatuhTempo: JATUH_TEMPO,
    tanggalPencairan: TANGGAL_TARIK,
    tenorBulan: TENOR,
    rateKontrak: RATE_KONTRAK,
    bungaAkrual: BUNGA_EARNED_3_PERIODE,
    kebijakan: { ...KEBIJAKAN_NETRAL, ...k } as KebijakanEarlyWithdrawal,
  });

const denganPenalti = (k: Partial<KebijakanEarlyWithdrawal>) =>
  hitung({ akunPenaltiId: ACC.pendapatanDenda, ...k });

describe('EW-02 §D — setiap bentuk penalti didukung tanpa mengasumsikan basis', () => {
  it('nominal tetap', () => {
    const h = denganPenalti({ jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 250_000 });
    expect(h.penalti).toBe(250_000);
  });

  it('persentase dari POKOK', () => {
    // Penalti 480.000 melebihi bunga yang tersedia (360.000), jadi
    // kebijakan HARUS membebankannya ke pokok — kalau tidak, mesin
    // menolak. Itu perilaku yang benar dan diuji terpisah di bawah.
    const h = denganPenalti({
      jenisPenalti: 'PERSENTASE', nilaiPenalti: 2, basisPenalti: 'POKOK',
      perlakuanPokok: 'DIKURANGI_PENALTI',
    });
    expect(h.penalti).toBe(480_000);
  });

  it('persentase dari BUNGA BRUTO', () => {
    const h = denganPenalti({
      jenisPenalti: 'PERSENTASE', nilaiPenalti: 25, basisPenalti: 'BUNGA_BRUTO',
    });
    expect(h.penalti).toBe(90_000); // 25% x 360.000
  });

  it('persentase dari TOTAL SEBELUM PENALTI (pokok + bunga setelah forfeiture)', () => {
    const h = denganPenalti({
      jenisPenalti: 'PERSENTASE', nilaiPenalti: 1, basisPenalti: 'TOTAL_SEBELUM_PENALTI',
    });
    expect(h.penalti).toBe(243_600); // 1% x (24.000.000 + 360.000)
  });

  it('basis berbeda menghasilkan angka berbeda — basis benar-benar dipakai', () => {
    const a = denganPenalti({
      jenisPenalti: 'PERSENTASE', nilaiPenalti: 2, basisPenalti: 'POKOK',
      perlakuanPokok: 'DIKURANGI_PENALTI',
    });
    const b = denganPenalti({
      jenisPenalti: 'PERSENTASE', nilaiPenalti: 2, basisPenalti: 'BUNGA_BRUTO',
      perlakuanPokok: 'DIKURANGI_PENALTI',
    });
    expect(a.penalti).toBe(480_000);
    expect(b.penalti).toBe(7_200);
    expect(a.penalti).not.toBe(b.penalti);
  });

  it('penalti yang melebihi bunga TIDAK boleh dibebankan ke bunga — ditolak', () => {
    expect(() =>
      denganPenalti({
        jenisPenalti: 'PERSENTASE', nilaiPenalti: 2, basisPenalti: 'POKOK',
        perlakuanPokok: 'PENUH',
      })
    ).toThrow(/melebihi bunga yang tersedia/);
  });
});

describe('EW-02 §R — penalti dihitung SEKALI dan tidak memotong dua kali', () => {
  it('dipotong dari POKOK: bunga tidak ikut berkurang', () => {
    const h = denganPenalti({
      jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 500_000,
      perlakuanPokok: 'DIKURANGI_PENALTI',
    });
    expect(h.penyesuaianPokok).toBe(500_000);
    expect(h.penyesuaianBunga).toBe(0);
    expect(h.pokokDibayar).toBe(POKOK - 500_000);
    expect(h.bungaDibayar).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.totalPayout).toBe(POKOK + BUNGA_EARNED_3_PERIODE - 500_000);
  });

  it('dipotong dari BUNGA: pokok utuh', () => {
    const h = denganPenalti({
      jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 100_000, perlakuanPokok: 'PENUH',
    });
    expect(h.penyesuaianPokok).toBe(0);
    expect(h.penyesuaianBunga).toBe(100_000);
    expect(h.pokokDibayar).toBe(POKOK);
    expect(h.bungaDibayar).toBe(BUNGA_EARNED_3_PERIODE - 100_000);
  });

  it('jumlah potongan SELALU sama dengan penalti + biaya — tidak lebih', () => {
    for (const perlakuan of ['PENUH', 'DIKURANGI_PENALTI'] as const) {
      const h = denganPenalti({
        jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 300_000, perlakuanPokok: perlakuan,
      });
      expect(h.penyesuaianPokok + h.penyesuaianBunga).toBe(h.penalti + h.biayaAdmin);
      expect(h.penalti).toBe(300_000);
    }
  });

  it('efek kas persis: pengurangan payout = besarnya penalti', () => {
    const tanpa = hitung({});
    const dengan = denganPenalti({
      jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 200_000, perlakuanPokok: 'DIKURANGI_PENALTI',
    });
    expect(tanpa.totalPayout - dengan.totalPayout).toBe(200_000);
  });

  it('§D — penalti TIDAK menghilangkan pokok bila kebijakan tidak menyatakannya', () => {
    const h = denganPenalti({
      jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 100_000, perlakuanPokok: 'PENUH',
    });
    expect(h.pokokDibayar).toBe(POKOK);
    expect(h.pokokBruto).toBe(POKOK);
  });
});
