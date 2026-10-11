import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluasiKebijakanEarlyWithdrawal,
  isKebijakanLengkap,
  type KebijakanEarlyWithdrawalDraft,
} from '@/accounting/EarlyWithdrawalPolicy';

/**
 * RC-S44b — NULL BUKAN KEPUTUSAN.
 *
 * Bug yang ditutup suite ini halus dan karena itu berbahaya:
 *
 *   null        = pengurus BELUM MEMUTUSKAN
 *   'TIDAK_ADA' = pengurus MEMUTUSKAN tidak ada penalti
 *
 * Keduanya menghasilkan perhitungan yang identik — penalti nol — jadi
 * tidak ada satu angka pun di laporan yang akan membedakannya. Yang
 * berbeda hanya siapa yang bertanggung jawab atas aturannya, dan itu
 * baru ketahuan ketika seseorang bertanya "siapa yang memutuskan ini?"
 * setelah jurnalnya terposting.
 */

const ROOT = join(__dirname, '..', '..');

function draft(o: Partial<KebijakanEarlyWithdrawalDraft> = {}): KebijakanEarlyWithdrawalDraft {
  return {
    versi: 'EW-2026-01',
    berlakuMulai: '2026-01-01',
    diizinkan: true,
    jenisPenalti: null,
    nilaiPenalti: null,
    basisPenalti: null,
    akunPenaltiId: null,
    jenisForfeiture: null,
    nilaiForfeiture: null,
    jenisBiayaAdmin: null,
    nilaiBiayaAdmin: null,
    basisBiayaAdmin: null,
    akunBiayaAdminId: null,
    rateDini: null,
    jenisPenyesuaianRate: null,
    cakupanPenyesuaianRate: null,
    perlakuanPokok: null,
    perlakuanBunga: null,
    dasarPenetapan: null,
    ditetapkanOleh: null,
    ...o,
  };
}

/** Keputusan eksplisit "tanpa apa pun" — sah, dan HARUS lolos. */
const SEMUA_EKSPLISIT: Partial<KebijakanEarlyWithdrawalDraft> = {
  jenisPenalti: 'TIDAK_ADA',
  jenisForfeiture: 'TIDAK_ADA',
  jenisBiayaAdmin: 'TIDAK_ADA',
  jenisPenyesuaianRate: 'TIDAK_ADA',
  perlakuanPokok: 'PENUH',
  perlakuanBunga: 'BAYAR_SETELAH_FORFEITURE',
};

describe('A. diizinkan=true tetapi seluruh keputusan masih null', () => {
  const hasil = evaluasiKebijakanEarlyWithdrawal(draft());

  it('berstatus POLICY_REQUIRED', () => {
    expect(hasil.status).toBe('POLICY_REQUIRED');
  });

  it('keenam keputusan disebut sebagai kekurangan', () => {
    for (const teks of [
      'keputusan jenis penalti',
      'keputusan perlakuan bunga hangus',
      'keputusan biaya administrasi',
      'keputusan penyesuaian rate',
      'keputusan perlakuan pokok',
      'keputusan perlakuan bunga',
    ]) {
      expect(hasil.kekurangan).toContain(teks);
    }
  });

  it('tidak dapat dipakai menghitung', () => {
    expect(isKebijakanLengkap(draft())).toBe(false);
  });
});

describe('B. keputusan eksplisit BERBEDA dari null', () => {
  it('TIDAK_ADA/PENUH/BAYAR yang dipilih sengaja -> AKTIF', () => {
    // Inti pembedaan. Kalau evaluator memperlakukan keduanya sama,
    // salah satu dari dua test ini pasti gagal.
    const hasil = evaluasiKebijakanEarlyWithdrawal(draft(SEMUA_EKSPLISIT));
    expect(hasil.status).toBe('AKTIF');
    expect(hasil.kekurangan).toHaveLength(0);
  });

  it('kebijakan eksplisit dapat dipakai menghitung', () => {
    expect(isKebijakanLengkap(draft(SEMUA_EKSPLISIT))).toBe(true);
  });

  it('satu keputusan dikosongkan saja sudah cukup untuk menolak', () => {
    const hasil = evaluasiKebijakanEarlyWithdrawal(
      draft({ ...SEMUA_EKSPLISIT, perlakuanPokok: null })
    );
    expect(hasil.status).toBe('POLICY_REQUIRED');
    expect(hasil.kekurangan).toContain('keputusan perlakuan pokok');
  });
});

describe('C-E. parameter turunan tetap wajib', () => {
  it('C. penalti PERSENTASE tanpa nilai/basis/akun -> POLICY_REQUIRED', () => {
    const hasil = evaluasiKebijakanEarlyWithdrawal(
      draft({ ...SEMUA_EKSPLISIT, jenisPenalti: 'PERSENTASE', perlakuanPokok: 'DIKURANGI_PENALTI' })
    );
    expect(hasil.status).toBe('POLICY_REQUIRED');
    expect(hasil.kekurangan).toContain('persentase penalti');
    expect(hasil.kekurangan).toContain('basis perhitungan penalti');
    expect(hasil.kekurangan).toContain('akun pendapatan penalti');
  });

  it('D. biaya admin PERSENTASE tanpa nilai/basis/akun -> POLICY_REQUIRED', () => {
    const hasil = evaluasiKebijakanEarlyWithdrawal(
      draft({
        ...SEMUA_EKSPLISIT,
        jenisBiayaAdmin: 'PERSENTASE',
        perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN',
      })
    );
    expect(hasil.status).toBe('POLICY_REQUIRED');
    expect(hasil.kekurangan).toContain('persentase biaya administrasi');
    expect(hasil.kekurangan).toContain('basis perhitungan biaya administrasi');
    expect(hasil.kekurangan).toContain('akun pendapatan biaya administrasi');
  });

  it('E. RATE_DINI tanpa rate/cakupan -> POLICY_REQUIRED', () => {
    const hasil = evaluasiKebijakanEarlyWithdrawal(
      draft({ ...SEMUA_EKSPLISIT, jenisPenyesuaianRate: 'RATE_DINI' })
    );
    expect(hasil.status).toBe('POLICY_REQUIRED');
    expect(hasil.kekurangan).toContain('rate penarikan dini');
    expect(hasil.kekurangan).toContain('cakupan berlakunya rate penarikan dini');
  });

  it('diizinkan=false tetap DILARANG, bukan POLICY_REQUIRED', () => {
    // Melarang penarikan dini ADALAH keputusan yang lengkap.
    const hasil = evaluasiKebijakanEarlyWithdrawal(draft({ diizinkan: false }));
    expect(hasil.status).toBe('DILARANG');
  });
});

describe('F. tidak ada fallback yang mengubah null menjadi keputusan', () => {
  const layar = readFileSync(
    join(ROOT, 'src', 'screens', 'Simpanan', 'KebijakanPenarikanDiniScreen.tsx' /* DIPERBARUI: layar dipindah dari Pengaturan */),
    'utf8'
  );
  const kode = layar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each([
    ["?? 'TIDAK_ADA'"],
    ["?? 'PENUH'"],
    ["?? 'BAYAR_SETELAH_FORFEITURE'"],
    ["?? 'SELURUH_BUNGA'"],
  ])('layar tidak memakai fallback %s', (pola) => {
    expect(kode).not.toContain(pola);
  });

  it('nilai keputusan dikirim apa adanya', () => {
    for (const f of [
      'jenisPenalti,',
      'jenisForfeiture,',
      'jenisBiayaAdmin,',
      'jenisPenyesuaianRate,',
      'perlakuanPokok,',
      'perlakuanBunga,',
    ]) {
      expect(kode).toContain(f);
    }
  });

  it('penyempit tipe terikat ke evaluator, bukan pemeriksaan terpisah', () => {
    // Dua definisi "lengkap" akan berbeda cepat atau lambat, dan yang
    // lebih longgar yang menentukan apa yang boleh dihitung.
    const policy = readFileSync(join(ROOT, 'src', 'accounting', 'EarlyWithdrawalPolicy.ts'), 'utf8');
    expect(policy).toMatch(
      /export function isKebijakanLengkap[\s\S]{0,400}evaluasiKebijakanEarlyWithdrawal\(k\)\.status === 'AKTIF'/
    );
  });

  it('service menyempitkan sebelum menghitung, di kedua jalur', () => {
    const service = readFileSync(
      join(ROOT, 'src', 'services', 'SimpananBerjangkaEarlyWithdrawalService.ts'),
      'utf8'
    );
    expect((service.match(/isKebijakanLengkap\(kebijakan\)/g) ?? []).length).toBe(2);
  });
});

describe('G. enam kapabilitas existing tidak berubah', () => {
  it('seluruh nilai enum tetap tersedia', () => {
    const policy = readFileSync(join(ROOT, 'src', 'accounting', 'EarlyWithdrawalPolicy.ts'), 'utf8');
    for (const t of [
      "JenisPenalti = 'TIDAK_ADA' | 'NOMINAL_TETAP' | 'PERSENTASE'",
      "BasisPenalti = 'POKOK' | 'BUNGA_BRUTO' | 'TOTAL_SEBELUM_PENALTI'",
      "JenisBiayaAdmin = 'TIDAK_ADA' | 'NOMINAL_TETAP' | 'PERSENTASE'",
      "JenisPenyesuaianRate = 'TIDAK_ADA' | 'RATE_DINI'",
      "PerlakuanBunga = 'BAYAR_SETELAH_FORFEITURE' | 'TIDAK_DIBAYAR'",
    ]) {
      expect(policy).toContain(t);
    }
  });

  it('EarlyWithdrawalCalculation tidak diubah untuk mendukung null', () => {
    // §9. Kalkulasi tetap menerima kebijakan LENGKAP saja.
    const calc = readFileSync(join(ROOT, 'src', 'accounting', 'EarlyWithdrawalCalculation.ts'), 'utf8');
    expect(calc).toMatch(/kebijakan: KebijakanEarlyWithdrawal;/);
    expect(calc).not.toMatch(/KebijakanEarlyWithdrawalDraft/);
  });

  it('permission tetap pengaturan:edit, tanpa permission baru', () => {
    const service = readFileSync(
      join(ROOT, 'src', 'services', 'SimpananBerjangkaEarlyWithdrawalService.ts'),
      'utf8'
    );
    expect(service).toMatch(/requirePermission\(db, input\.createdBy, 'pengaturan', 'edit'\)/);
  });

  it('versioning tetap: kebijakan lama NONAKTIF, tidak dihapus', () => {
    const service = readFileSync(
      join(ROOT, 'src', 'services', 'SimpananBerjangkaEarlyWithdrawalService.ts'),
      'utf8'
    );
    expect(service).toMatch(/SET status = 'NONAKTIF'/);
    expect(service).not.toMatch(/DELETE FROM simpanan_berjangka_kebijakan_dini/);
  });

  it('skema mengizinkan NULL tanpa melonggarkan nilai yang sah', () => {
    /**
     * Versi skema diuji sebagai AMBANG MINIMUM, bukan angka persis.
     *
     * Assertion `= 57` langsung usang begitu RC-S44c menaikkannya ke 58
     * untuk keperluan yang berbeda — kegagalan yang tidak menandakan
     * apa pun tentang NULL. Ini kedua kalinya pola yang sama muncul di
     * suite ini, jadi ambangnya dipakai konsisten.
     *
     * Yang benar-benar penting adalah CHECK constraint-nya.
     */
    const schema = readFileSync(join(ROOT, 'src', 'database', 'schema.ts'), 'utf8');
    const versi = Number(/SCHEMA_VERSION = (\d+)/.exec(schema)?.[1]);
    expect(versi).toBeGreaterThan(56);
    expect(schema).toMatch(
      /jenis_penalti TEXT CHECK \(jenis_penalti IS NULL OR jenis_penalti IN \('TIDAK_ADA','NOMINAL_TETAP','PERSENTASE'\)\)/
    );
  });
});
