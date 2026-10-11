import * as fs from 'fs';
import * as path from 'path';
import {
  KebijakanEarlyWithdrawal,
  evaluasiKebijakanEarlyWithdrawal,
  targetPotongan,
  ringkasKebijakan,
  TUJUAN_AKUNTANSI_FORFEITURE,
} from '@/accounting/EarlyWithdrawalPolicy';
import { KEBIJAKAN_NETRAL, KEBIJAKAN_ENAM_KOMPONEN, ACC } from './earlyWithdrawalHarness';

/**
 * EW-01 — POLICY ENGINE.
 *
 * Yang dibuktikan di sini: (a) tanpa kebijakan, jawabannya
 * POLICY_REQUIRED — bukan nol, bukan asumsi; (b) setiap parameter yang
 * hilang disebutkan namanya; (c) kombinasi yang saling bertentangan
 * ditolak, bukan dipilih salah satunya; (d) tidak ada satu pun angka
 * kebijakan yang tertanam di source produksi.
 */

describe('EW-01 §B/§C — kebijakan sebagai satu sumber kebenaran', () => {
  it('tanpa kebijakan sama sekali -> POLICY_REQUIRED', () => {
    const h = evaluasiKebijakanEarlyWithdrawal(null);
    expect(h.status).toBe('POLICY_REQUIRED');
    expect(h.kekurangan.length).toBeGreaterThan(0);
  });

  it('undefined diperlakukan sama dengan null — tidak ada jalur diam-diam', () => {
    expect(evaluasiKebijakanEarlyWithdrawal(undefined).status).toBe('POLICY_REQUIRED');
  });

  it('kebijakan yang melarang penarikan dini -> DILARANG, bukan POLICY_REQUIRED', () => {
    const h = evaluasiKebijakanEarlyWithdrawal({ ...KEBIJAKAN_NETRAL, diizinkan: false });
    expect(h.status).toBe('DILARANG');
  });

  it('kebijakan netral (semua komponen tidak berlaku) sudah lengkap -> AKTIF', () => {
    const h = evaluasiKebijakanEarlyWithdrawal(KEBIJAKAN_NETRAL);
    expect(h.status).toBe('AKTIF');
    expect(h.kekurangan).toEqual([]);
  });

  it('kebijakan enam komponen lengkap -> AKTIF', () => {
    expect(evaluasiKebijakanEarlyWithdrawal(KEBIJAKAN_ENAM_KOMPONEN).status).toBe('AKTIF');
  });
});

describe('EW-01 §AL — parameter yang belum ditetapkan disebut namanya', () => {
  const kurang = (k: Partial<KebijakanEarlyWithdrawal>) =>
    evaluasiKebijakanEarlyWithdrawal({ ...KEBIJAKAN_NETRAL, ...k });

  it('penalti persentase tanpa nilai, basis, dan akun -> tiga kekurangan disebutkan', () => {
    const h = kurang({ jenisPenalti: 'PERSENTASE' });
    expect(h.status).toBe('POLICY_REQUIRED');
    expect(h.kekurangan).toEqual(
      expect.arrayContaining(['persentase penalti', 'basis perhitungan penalti', 'akun pendapatan penalti'])
    );
  });

  it('penalti nominal tanpa akun penampung -> ditolak (akun tidak ditebak)', () => {
    const h = kurang({ jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 100_000 });
    expect(h.status).toBe('POLICY_REQUIRED');
    expect(h.kekurangan).toContain('akun pendapatan penalti');
  });

  it('biaya admin persentase tanpa basis -> basis TIDAK diasumsikan pokok', () => {
    const h = kurang({
      jenisBiayaAdmin: 'PERSENTASE',
      nilaiBiayaAdmin: 1,
      akunBiayaAdminId: ACC.pendapatanAdmin,
    });
    expect(h.kekurangan).toContain('basis perhitungan biaya administrasi');
  });

  it('forfeiture persentase tanpa nilai -> ditolak', () => {
    expect(kurang({ jenisForfeiture: 'PERSENTASE_BUNGA' }).kekurangan).toContain(
      'persentase bunga hangus'
    );
  });

  it('rate dini tanpa nilai & tanpa cakupan -> keduanya wajib', () => {
    const h = kurang({ jenisPenyesuaianRate: 'RATE_DINI' });
    expect(h.kekurangan).toEqual(
      expect.arrayContaining(['rate penarikan dini', 'cakupan berlakunya rate penarikan dini'])
    );
  });

  it('rate dini 0% SAH bila memang ditetapkan — 0 berbeda dari "belum diisi"', () => {
    const h = kurang({
      jenisPenyesuaianRate: 'RATE_DINI',
      rateDini: 0,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    expect(h.status).toBe('AKTIF');
  });
});

describe('EW-01 — konsistensi antar-parameter (POLICY_CONFLICT)', () => {
  const konflik = (k: Partial<KebijakanEarlyWithdrawal>) =>
    evaluasiKebijakanEarlyWithdrawal({ ...KEBIJAKAN_NETRAL, ...k });

  it('bunga "tidak dibayar" tetapi forfeiture bukan seluruh bunga -> CONFLICT', () => {
    expect(konflik({ perlakuanBunga: 'TIDAK_DIBAYAR' }).status).toBe('POLICY_CONFLICT');
  });

  it('forfeiture seluruh bunga tetapi perlakuan bunga masih "bayar sisa" -> CONFLICT', () => {
    expect(konflik({ jenisForfeiture: 'SELURUH_BUNGA' }).status).toBe('POLICY_CONFLICT');
  });

  it('pokok dipotong penalti padahal tanpa penalti -> CONFLICT', () => {
    expect(konflik({ perlakuanPokok: 'DIKURANGI_PENALTI' }).status).toBe('POLICY_CONFLICT');
  });

  it('pokok dipotong biaya admin padahal tanpa biaya admin -> CONFLICT', () => {
    expect(konflik({ perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN' }).status).toBe('POLICY_CONFLICT');
  });

  it('kekurangan didahulukan daripada konflik — pesan tidak menyesatkan', () => {
    const h = konflik({ jenisPenalti: 'PERSENTASE', perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN' });
    expect(h.status).toBe('POLICY_REQUIRED');
  });
});

describe('EW-01 §D/§H — arah potongan tunggal, mustahil dipotong dua kali', () => {
  it('PENUH: tidak ada komponen yang dibebankan ke pokok', () => {
    expect(targetPotongan('PENUH')).toEqual({ penaltiDariPokok: false, biayaDariPokok: false });
  });
  it('DIKURANGI_PENALTI: hanya penalti', () => {
    expect(targetPotongan('DIKURANGI_PENALTI')).toEqual({
      penaltiDariPokok: true,
      biayaDariPokok: false,
    });
  });
  it('DIKURANGI_BIAYA_ADMIN: hanya biaya', () => {
    expect(targetPotongan('DIKURANGI_BIAYA_ADMIN')).toEqual({
      penaltiDariPokok: false,
      biayaDariPokok: true,
    });
  });
  it('DIKURANGI_PENALTI_DAN_BIAYA: keduanya', () => {
    expect(targetPotongan('DIKURANGI_PENALTI_DAN_BIAYA')).toEqual({
      penaltiDariPokok: true,
      biayaDariPokok: true,
    });
  });
  it('setiap komponen punya TEPAT SATU arah pada semua perlakuan', () => {
    for (const p of [
      'PENUH',
      'DIKURANGI_PENALTI',
      'DIKURANGI_BIAYA_ADMIN',
      'DIKURANGI_PENALTI_DAN_BIAYA',
    ] as const) {
      const t = targetPotongan(p);
      // Boolean tunggal per komponen: tidak ada representasi "dua-duanya".
      expect(typeof t.penaltiDariPokok).toBe('boolean');
      expect(typeof t.biayaDariPokok).toBe('boolean');
    }
  });
});

describe('EW-01 §AL — tidak ada angka kebijakan yang tertanam di source', () => {
  it('modul kebijakan & perhitungan tidak memuat default numerik kebijakan', () => {
    for (const berkas of ['EarlyWithdrawalPolicy.ts', 'EarlyWithdrawalCalculation.ts']) {
      const isi = fs.readFileSync(
        path.join(__dirname, '..', 'accounting', berkas),
        'utf8'
      );
      // Tidak ada penetapan default seperti `nilaiPenalti = 5` /
      // `nilaiPenalti: 5` di source produksi.
      expect(isi).not.toMatch(/nilaiPenalti\s*[:=]\s*\d/);
      expect(isi).not.toMatch(/nilaiForfeiture\s*[:=]\s*\d/);
      expect(isi).not.toMatch(/nilaiBiayaAdmin\s*[:=]\s*\d/);
      expect(isi).not.toMatch(/rateDini\s*[:=]\s*\d/);
    }
  });

  it('tujuan akuntansi forfeiture DITURUNKAN (pembalikan beban), bukan akun karangan', () => {
    expect(TUJUAN_AKUNTANSI_FORFEITURE).toBe('PEMBALIKAN_BEBAN_BUNGA_AKRUAL');
  });

  it('ringkasan kebijakan menampilkan enam komponen, tanpa menambah angka', () => {
    const baris = ringkasKebijakan(KEBIJAKAN_ENAM_KOMPONEN);
    expect(baris).toHaveLength(6);
    expect(baris.join(' ')).toContain('2%');
    expect(baris.join(' ')).toContain('50%');
  });
});
