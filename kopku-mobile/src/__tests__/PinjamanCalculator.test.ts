import { hitungJadwalAngsuran, hitungDenda, hitungTotalBarisCustom, validasiJadwalCustom } from '@/accounting/PinjamanCalculator';
import { sum } from '@/utils/money';

describe('PinjamanCalculator (PRD §11-12 - metode jasa configurable)', () => {
  const jumlahPinjaman = 1_200_000;
  const tenor = 12;
  const persentase = 2; // 2% per periode

  test.each([
    ['FLAT', 'FLAT' as const],
    ['MENURUN', 'MENURUN' as const],
    ['EFEKTIF', 'EFEKTIF' as const],
  ])(
    'metode %s: total pokok seluruh angsuran HARUS PERSIS SAMA dengan jumlah pinjaman (tidak boleh selisih akibat pembulatan)',
    (_name, metode) => {
      const jadwal = hitungJadwalAngsuran({ jumlahPinjaman, tenor, persentaseJasaPerPeriode: persentase, metode });
      const totalPokok = sum(jadwal.map((r) => r.pokok));
      expect(totalPokok).toBe(jumlahPinjaman);
      expect(jadwal.length).toBe(tenor);
    }
  );

  test('metode FLAT: jasa sama tiap periode (dihitung dari pokok awal)', () => {
    const jadwal = hitungJadwalAngsuran({ jumlahPinjaman, tenor, persentaseJasaPerPeriode: persentase, metode: 'FLAT' });
    const jasaValues = new Set(jadwal.map((r) => r.jasa));
    expect(jasaValues.size).toBe(1); // semua jasa harus identik
    expect(jadwal[0].jasa).toBe(24000); // 2% dari 1.200.000
  });

  test('metode MENURUN: jasa mengecil tiap periode berikutnya', () => {
    const jadwal = hitungJadwalAngsuran({ jumlahPinjaman, tenor, persentaseJasaPerPeriode: persentase, metode: 'MENURUN' });
    for (let i = 1; i < jadwal.length; i++) {
      expect(jadwal[i].jasa).toBeLessThanOrEqual(jadwal[i - 1].jasa);
    }
  });

  test('metode EFEKTIF: total angsuran (pokok+jasa) relatif tetap tiap periode (anuitas)', () => {
    const jadwal = hitungJadwalAngsuran({ jumlahPinjaman, tenor, persentaseJasaPerPeriode: persentase, metode: 'EFEKTIF' });
    const totals = jadwal.slice(0, -1).map((r) => r.total); // baris terakhir bisa beda krn koreksi pembulatan
    const max = Math.max(...totals);
    const min = Math.min(...totals);
    expect(max - min).toBeLessThanOrEqual(2); // toleransi pembulatan Rupiah
  });

  test('metode CUSTOM mengembalikan array kosong (diisi manual di UI)', () => {
    const jadwal = hitungJadwalAngsuran({ jumlahPinjaman, tenor, persentaseJasaPerPeriode: persentase, metode: 'CUSTOM' });
    expect(jadwal).toEqual([]);
  });

  test('tenor <= 0 harus reject', () => {
    expect(() =>
      hitungJadwalAngsuran({ jumlahPinjaman, tenor: 0, persentaseJasaPerPeriode: persentase, metode: 'FLAT' })
    ).toThrow();
  });

  test('jumlah pinjaman <= 0 harus reject', () => {
    expect(() =>
      hitungJadwalAngsuran({ jumlahPinjaman: 0, tenor, persentaseJasaPerPeriode: persentase, metode: 'FLAT' })
    ).toThrow();
  });
});

describe('hitungDenda (PRD §15 - denda configurable, tidak hard-code)', () => {
  test('tidak aktif -> selalu 0', () => {
    expect(hitungDenda({ aktif: false, nilai: 5000, sisaTagihan: 100000, hariTerlambat: 10 })).toBe(0);
  });

  test('belum terlambat -> 0', () => {
    expect(hitungDenda({ aktif: true, tipe: 'PER_HARI', nilai: 5000, sisaTagihan: 100000, hariTerlambat: 0 })).toBe(0);
  });

  test('tipe PER_HARI menghitung nilai x hari terlambat', () => {
    expect(hitungDenda({ aktif: true, tipe: 'PER_HARI', nilai: 5000, sisaTagihan: 100000, hariTerlambat: 3 })).toBe(15000);
  });

  test('tipe PERSENTASE menghitung dari sisa tagihan', () => {
    expect(hitungDenda({ aktif: true, tipe: 'PERSENTASE', nilai: 2, sisaTagihan: 100000, hariTerlambat: 1 })).toBe(2000);
  });

  test('tipe NOMINAL selalu nilai tetap', () => {
    expect(hitungDenda({ aktif: true, tipe: 'NOMINAL', nilai: 10000, sisaTagihan: 100000, hariTerlambat: 5 })).toBe(10000);
  });
});

describe('hitungTotalBarisCustom (fase 9 §6 - jadwal angsuran CUSTOM)', () => {
  test('total setiap baris = pokok + jasa, dihitung otomatis', () => {
    const hasil = hitungTotalBarisCustom([
      { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 500000, jasa: 20000 },
      { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 500000, jasa: 15000 },
    ]);
    expect(hasil[0].total).toBe(520000);
    expect(hasil[1].total).toBe(515000);
  });

  test('baris dengan jasa 0 tetap menghasilkan total = pokok saja', () => {
    const hasil = hitungTotalBarisCustom([{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 300000, jasa: 0 }]);
    expect(hasil[0].total).toBe(300000);
  });

  test('array kosong menghasilkan array kosong tanpa error', () => {
    expect(hitungTotalBarisCustom([])).toEqual([]);
  });
});

describe('validasiJadwalCustom (fase 9 §7-9 - validasi jadwal angsuran CUSTOM)', () => {
  const jumlahPinjaman = 1_000_000;
  const tanggalPinjaman = '2026-01-01';

  const jadwalValid = [
    { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 500000, jasa: 20000 },
    { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 500000, jasa: 15000 },
  ];

  test('jadwal valid: total pokok tepat sama dengan pokok pinjaman -> diterima', () => {
    const hasil = validasiJadwalCustom(jadwalValid, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(true);
    expect(hasil.errors).toEqual([]);
    expect(hasil.totalPokok).toBe(1_000_000);
    expect(hasil.totalJasa).toBe(35000);
    expect(hasil.totalAngsuran).toBe(1_035_000);
    expect(hasil.jumlahPeriode).toBe(2);
  });

  test('total pokok KURANG dari pokok pinjaman -> ditolak (fase 9 §7)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 900000, jasa: 0 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('harus PERSIS SAMA'))).toBe(true);
  });

  test('total pokok LEBIH dari pokok pinjaman -> ditolak (fase 9 §7)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_100_000, jasa: 0 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('harus PERSIS SAMA'))).toBe(true);
  });

  test('pokok negatif ditolak (fase 9 §8)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: -100000, jasa: 0 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('pokok tidak boleh negatif'))).toBe(true);
  });

  test('bunga negatif ditolak (fase 9 §8)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: -5000 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('bunga tidak boleh negatif'))).toBe(true);
  });

  test('baris dengan pokok=0 DAN jasa=0 ditolak (periode kosong tidak berguna)', () => {
    const jadwal = [
      { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 1_000_000, jasa: 0 },
      { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 0, jasa: 0 },
    ];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('tidak boleh 0'))).toBe(true);
  });

  test('tanggal jatuh tempo tidak valid (format salah) ditolak (fase 9 §9)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: 'tanggal-ngawur', pokok: 1_000_000, jasa: 0 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('tidak valid'))).toBe(true);
  });

  test('tanggal jatuh tempo TIDAK urut naik antar periode ditolak (fase 9 §9)', () => {
    const jadwal = [
      { nomorAngsuran: 1, tanggalJatuhTempo: '2026-03-01', pokok: 500000, jasa: 0 },
      { nomorAngsuran: 2, tanggalJatuhTempo: '2026-02-01', pokok: 500000, jasa: 0 }, // mundur
    ];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('harus setelah periode sebelumnya'))).toBe(true);
  });

  test('tanggal periode pertama sebelum/sama dengan tanggal pinjaman ditolak (fase 9 §9)', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-01-01', pokok: 1_000_000, jasa: 0 }]; // = tanggalPinjaman
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
  });

  test('nomor angsuran tidak berurutan (lompat/duplikat) ditolak', () => {
    const jadwal = [
      { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 500000, jasa: 0 },
      { nomorAngsuran: 3, tanggalJatuhTempo: '2026-03-01', pokok: 500000, jasa: 0 }, // lompat dari 1 ke 3
    ];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('berurutan'))).toBe(true);
  });

  test('jadwal kosong (0 periode) ditolak', () => {
    const hasil = validasiJadwalCustom([], jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('minimal harus punya 1 periode'))).toBe(true);
  });

  test('jadwal dengan 1 periode tunggal (pelunasan sekali bayar) diterima jika pokok pas', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: '2026-06-01', pokok: 1_000_000, jasa: 50000 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(true);
  });

  test('banyak error dilaporkan sekaligus, bukan berhenti di error pertama', () => {
    const jadwal = [{ nomorAngsuran: 1, tanggalJatuhTempo: 'invalid', pokok: -100, jasa: -50 }];
    const hasil = validasiJadwalCustom(jadwal, jumlahPinjaman, tanggalPinjaman);
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.length).toBeGreaterThan(1);
  });
});
