import {
  checkSaldoCukup,
  checkLiquiditySufficient,
  checkTidakNegatif,
  checkAnggotaAktif,
  checkKepemilikanSimpananPokokWajib,
  checkSaldoSimpananMinimum,
  checkLimitPinjaman,
  checkLimitOutstanding,
  checkBatasTunggakan,
  checkBelumDicairkan,
  checkPembayaranTidakMelebihiOutstanding,
  validateAll,
} from '@/validators/BusinessRuleEngine';

describe('BusinessRuleEngine (Phase 3) — murni, tanpa I/O', () => {
  describe('checkSaldoCukup', () => {
    test('valid kalau saldo >= nominal', () => {
      expect(checkSaldoCukup({ saldoTersedia: 100, nominalKeluar: 100 }).valid).toBe(true);
    });
    test('tidak valid kalau saldo < nominal', () => {
      const r = checkSaldoCukup({ saldoTersedia: 50, nominalKeluar: 100, namaRekening: 'Kas' });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/Kas/);
    });
  });

  describe('checkLiquiditySufficient — skenario persis dari spesifikasi', () => {
    test('Kas 5jt + Bank 3jt - Reserve 2jt = available 6jt, pinjaman 10jt → DITOLAK', () => {
      const r = checkLiquiditySufficient({
        kas: 5_000_000,
        bank: 3_000_000,
        reservedLiquidity: 2_000_000,
        minimumCashReserve: 0,
        pendingDisbursement: 0,
        jumlahDiajukan: 10_000_000,
      });
      expect(r.availableLiquidity).toBe(6_000_000);
      expect(r.valid).toBe(false);
    });

    test('pinjaman <= available → DITERIMA', () => {
      const r = checkLiquiditySufficient({
        kas: 5_000_000,
        bank: 3_000_000,
        reservedLiquidity: 2_000_000,
        minimumCashReserve: 0,
        pendingDisbursement: 0,
        jumlahDiajukan: 6_000_000,
      });
      expect(r.valid).toBe(true);
    });

    test('minimumCashReserve & pendingDisbursement ikut mengurangi available', () => {
      const r = checkLiquiditySufficient({
        kas: 10_000_000,
        bank: 0,
        reservedLiquidity: 0,
        minimumCashReserve: 2_000_000,
        pendingDisbursement: 3_000_000,
        jumlahDiajukan: 6_000_000,
      });
      expect(r.availableLiquidity).toBe(5_000_000);
      expect(r.valid).toBe(false);
    });
  });

  describe('checkTidakNegatif', () => {
    test('valid kalau saldo sesudah >= 0', () => {
      expect(checkTidakNegatif({ saldoSaatIni: 100, perubahan: -100 }).valid).toBe(true);
    });
    test('tidak valid kalau saldo sesudah < 0 dan overdraft tidak diizinkan', () => {
      expect(checkTidakNegatif({ saldoSaatIni: 100, perubahan: -150 }).valid).toBe(false);
    });
    test('valid kalau saldo sesudah < 0 TAPI overdraft diizinkan', () => {
      expect(checkTidakNegatif({ saldoSaatIni: 100, perubahan: -150, izinkanOverdraft: true }).valid).toBe(true);
    });
  });

  describe('checkAnggotaAktif', () => {
    test('AKTIF valid', () => expect(checkAnggotaAktif('AKTIF').valid).toBe(true));
    test.each(['TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'])('%s tidak valid', (status) => {
      expect(checkAnggotaAktif(status).valid).toBe(false);
    });
  });

  describe('checkKepemilikanSimpananPokokWajib (Bagian D permintaan pengguna)', () => {
    test('punya pokok + wajib (keduanya > 0) -> lolos', () => {
      expect(checkKepemilikanSimpananPokokWajib(100_000, 50_000).valid).toBe(true);
    });
    test('tidak punya pokok (0) -> ditolak dengan pesan jelas menyebut Simpanan Pokok', () => {
      const hasil = checkKepemilikanSimpananPokokWajib(0, 50_000);
      expect(hasil.valid).toBe(false);
      expect(hasil.reason).toMatch(/Simpanan Pokok/);
      expect(hasil.reason).not.toMatch(/Simpanan Wajib/);
    });
    test('tidak punya wajib (0) -> ditolak dengan pesan jelas menyebut Simpanan Wajib', () => {
      const hasil = checkKepemilikanSimpananPokokWajib(100_000, 0);
      expect(hasil.valid).toBe(false);
      expect(hasil.reason).toMatch(/Simpanan Wajib/);
      expect(hasil.reason).not.toMatch(/Simpanan Pokok/);
    });
    test('tidak punya keduanya -> ditolak dengan KEDUA alasan ditampilkan', () => {
      const hasil = checkKepemilikanSimpananPokokWajib(0, 0);
      expect(hasil.valid).toBe(false);
      expect(hasil.reason).toMatch(/Simpanan Pokok/);
      expect(hasil.reason).toMatch(/Simpanan Wajib/);
    });
    test('saldo negatif diperlakukan sama seperti 0 (tetap ditolak)', () => {
      expect(checkKepemilikanSimpananPokokWajib(-1, 50_000).valid).toBe(false);
    });
  });

  describe('checkSaldoSimpananMinimum', () => {
    test('minimum 0 (default) selalu valid', () => {
      expect(checkSaldoSimpananMinimum(0, 0).valid).toBe(true);
    });
    test('saldo cukup → valid', () => {
      expect(checkSaldoSimpananMinimum(500_000, 100_000).valid).toBe(true);
    });
    test('saldo kurang → tidak valid', () => {
      expect(checkSaldoSimpananMinimum(50_000, 100_000).valid).toBe(false);
    });
  });

  describe('checkLimitPinjaman', () => {
    test('limit 0 (default) selalu valid', () => {
      expect(checkLimitPinjaman(999_999_999, 0).valid).toBe(true);
    });
    test('melebihi limit → tidak valid', () => {
      expect(checkLimitPinjaman(20_000_000, 10_000_000).valid).toBe(false);
    });
  });

  describe('checkLimitOutstanding', () => {
    test('limit 0 selalu valid', () => {
      expect(checkLimitOutstanding(50_000_000, 10_000_000, 0).valid).toBe(true);
    });
    test('outstanding + baru melebihi limit → tidak valid', () => {
      const r = checkLimitOutstanding(8_000_000, 5_000_000, 10_000_000);
      expect(r.valid).toBe(false);
    });
    test('outstanding + baru pas di limit → valid', () => {
      expect(checkLimitOutstanding(5_000_000, 5_000_000, 10_000_000).valid).toBe(true);
    });
  });

  describe('checkBatasTunggakan', () => {
    test('kedua limit 0 → selalu valid', () => {
      const r = checkBatasTunggakan({
        jumlahTunggakanAktif: 99,
        hariTerlambatMaksimum: 999,
        limitJumlahTunggakan: 0,
        limitHariTerlambat: 0,
      });
      expect(r.valid).toBe(true);
    });
    test('jumlah tunggakan >= limit → tidak valid', () => {
      const r = checkBatasTunggakan({
        jumlahTunggakanAktif: 3,
        hariTerlambatMaksimum: 0,
        limitJumlahTunggakan: 3,
        limitHariTerlambat: 0,
      });
      expect(r.valid).toBe(false);
    });
    test('hari terlambat melebihi limit → tidak valid', () => {
      const r = checkBatasTunggakan({
        jumlahTunggakanAktif: 0,
        hariTerlambatMaksimum: 45,
        limitJumlahTunggakan: 0,
        limitHariTerlambat: 30,
      });
      expect(r.valid).toBe(false);
    });
  });

  describe('checkBelumDicairkan', () => {
    test.each(['DIAJUKAN', 'DISETUJUI'])('%s valid', (status) => {
      expect(checkBelumDicairkan(status).valid).toBe(true);
    });
    test.each(['AKTIF', 'LUNAS', 'MACET', 'DITOLAK'])('%s tidak valid (sudah cair/selesai)', (status) => {
      expect(checkBelumDicairkan(status).valid).toBe(false);
    });
  });

  describe('checkPembayaranTidakMelebihiOutstanding', () => {
    test('bayar <= outstanding → valid', () => {
      expect(checkPembayaranTidakMelebihiOutstanding(100_000, 100_000).valid).toBe(true);
    });
    test('bayar > outstanding → TIDAK valid (bukan dipotong diam-diam)', () => {
      const r = checkPembayaranTidakMelebihiOutstanding(150_000, 100_000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/150000/);
    });
  });

  describe('validateAll', () => {
    test('semua valid → valid', () => {
      const r = validateAll({ valid: true }, { valid: true }, { valid: true });
      expect(r.valid).toBe(true);
    });
    test('salah satu gagal → return rule yang gagal itu (yang pertama)', () => {
      const r = validateAll(
        { valid: true },
        { valid: false, reason: 'rule kedua gagal' },
        { valid: false, reason: 'rule ketiga gagal' }
      );
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('rule kedua gagal');
    });
  });
});
