/**
 * Formulir Kebijakan Penarikan Dini yang disederhanakan: tiga keputusan
 * diterjemahkan ke parameter kebijakan EXISTING tanpa aturan/angka baru.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  evaluasiKebijakanEarlyWithdrawal,
  type KebijakanEarlyWithdrawalDraft,
} from '@/accounting/EarlyWithdrawalPolicy';
import {
  bacaKebijakanSederhana,
  keParameterKebijakan,
  type KeputusanSederhana,
  type PilihanBiaya,
  type PilihanBunga,
  type PilihanPenalti,
} from '@/utils/kebijakanDiniSederhana';

const ROOT = path.join(__dirname, '..');
const baca = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function draf(k: KeputusanSederhana): KebijakanEarlyWithdrawalDraft {
  const t = keParameterKebijakan(k);
  const adaPenalti = k.penalti === 'PERSEN_POKOK' || k.penalti === 'NOMINAL_TETAP';
  const adaBiaya = k.biaya === 'NOMINAL_TETAP' || k.biaya === 'PERSEN_POKOK';
  return {
    versi: 'SK-1', berlakuMulai: '2026-01-01', diizinkan: true,
    ...t,
    nilaiPenalti: adaPenalti ? 2 : null, akunPenaltiId: adaPenalti ? 'akun-p' : null,
    nilaiBiayaAdmin: adaBiaya ? (k.biaya === 'PERSEN_POKOK' ? 1 : 10_000) : null, akunBiayaAdminId: adaBiaya ? 'akun-b' : null,
    dasarPenetapan: null, ditetapkanOleh: null,
  };
}

const SEMUA: KeputusanSederhana[] = [];
for (const penalti of ['TIDAK_ADA', 'PERSEN_POKOK', 'NOMINAL_TETAP'] as PilihanPenalti[])
  for (const bunga of ['HANGUS', 'DIBAYAR'] as PilihanBunga[])
    for (const biaya of ['TIDAK_ADA', 'NOMINAL_TETAP', 'PERSEN_POKOK'] as PilihanBiaya[]) SEMUA.push({ penalti, bunga, biaya });

describe('pemetaan tiga keputusan -> parameter existing', () => {
  test.each(SEMUA.map((k) => [JSON.stringify(k), k]))('%s dinilai AKTIF oleh evaluator existing', (_n, k) => {
    expect(evaluasiKebijakanEarlyWithdrawal(draf(k as KeputusanSederhana)).status).toBe('AKTIF');
  });

  test('bunga hangus / dibayarkan = pasangan yang konsisten menurut evaluator', () => {
    expect(keParameterKebijakan({ penalti: null, bunga: 'HANGUS', biaya: null })).toMatchObject({
      jenisForfeiture: 'SELURUH_BUNGA', perlakuanBunga: 'TIDAK_DIBAYAR',
    });
    expect(keParameterKebijakan({ penalti: null, bunga: 'DIBAYAR', biaya: null })).toMatchObject({
      jenisForfeiture: 'TIDAK_ADA', perlakuanBunga: 'BAYAR_SETELAH_FORFEITURE',
    });
  });

  test('persentase penalti & biaya admin selalu dari POKOK (basis yang didukung service)', () => {
    expect(keParameterKebijakan({ penalti: 'PERSEN_POKOK', bunga: null, biaya: null }).basisPenalti).toBe('POKOK');
    expect(keParameterKebijakan({ penalti: null, bunga: null, biaya: 'PERSEN_POKOK' })).toMatchObject({
      jenisBiayaAdmin: 'PERSENTASE',
      basisBiayaAdmin: 'POKOK',
    });
    for (const k of SEMUA) {
      const t = keParameterKebijakan(k);
      if (t.jenisBiayaAdmin !== 'PERSENTASE') expect(t.basisBiayaAdmin).toBeNull();
    }
  });

  test('opsi lanjutan tidak dipakai: tanpa rate dini, tanpa persentase/nominal bunga hangus', () => {
    for (const k of SEMUA) {
      const t = keParameterKebijakan(k);
      expect(t.jenisPenyesuaianRate).toBe('TIDAK_ADA');
      expect(t.rateDini).toBeNull();
      expect(t.cakupanPenyesuaianRate).toBeNull();
      expect(t.nilaiForfeiture).toBeNull();
      expect(['TIDAK_ADA', 'SELURUH_BUNGA']).toContain(t.jenisForfeiture);
    }
  });

  test('BELUM MEMUTUSKAN tetap null — tidak ada keputusan yang dibuat atas nama pengurus', () => {
    const t = keParameterKebijakan({ penalti: null, bunga: null, biaya: null });
    for (const v of Object.values(t)) expect(v).toBeNull();
    expect(evaluasiKebijakanEarlyWithdrawal({ ...draf({ penalti: 'TIDAK_ADA', bunga: 'DIBAYAR', biaya: 'TIDAK_ADA' }), ...t }).status)
      .toBe('POLICY_REQUIRED');
    // satu keputusan kosong saja sudah cukup untuk POLICY_REQUIRED
    expect(evaluasiKebijakanEarlyWithdrawal(draf({ penalti: 'TIDAK_ADA', bunga: null, biaya: 'TIDAK_ADA' })).status).toBe('POLICY_REQUIRED');
  });

  test('potongan dari pokok — selalu dapat dihitung walau bunga hangus', () => {
    expect(keParameterKebijakan({ penalti: 'NOMINAL_TETAP', bunga: 'HANGUS', biaya: 'NOMINAL_TETAP' }).perlakuanPokok)
      .toBe('DIKURANGI_PENALTI_DAN_BIAYA');
    expect(keParameterKebijakan({ penalti: 'TIDAK_ADA', bunga: 'HANGUS', biaya: 'TIDAK_ADA' }).perlakuanPokok).toBe('PENUH');
  });
});

describe('membaca kebijakan tersimpan', () => {
  test.each(SEMUA.map((k) => [JSON.stringify(k), k]))('round-trip %s', (_n, k) => {
    const b = bacaKebijakanSederhana(draf(k as KeputusanSederhana));
    expect(b.jenis).toBe('SEDERHANA');
    if (b.jenis === 'SEDERHANA') expect(b.keputusan).toEqual(k);
  });

  test('kebijakan versi lama dengan opsi lanjutan dikenali, tidak dipaksa ke formulir', () => {
    const dasar = draf({ penalti: 'TIDAK_ADA', bunga: 'DIBAYAR', biaya: 'TIDAK_ADA' });
    expect(bacaKebijakanSederhana({ ...dasar, jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3, cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN' }).jenis).toBe('LANJUTAN');
    expect(bacaKebijakanSederhana({ ...dasar, jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50 }).jenis).toBe('LANJUTAN');
    // Biaya persentase dari BUNGA (bukan pokok) = opsi lanjutan versi lama.
    expect(bacaKebijakanSederhana({ ...dasar, jenisBiayaAdmin: 'PERSENTASE', nilaiBiayaAdmin: 1, basisBiayaAdmin: 'BUNGA_BRUTO', akunBiayaAdminId: 'x', perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN' }).jenis).toBe('LANJUTAN');
    expect(bacaKebijakanSederhana({ ...draf({ penalti: 'PERSEN_POKOK', bunga: 'DIBAYAR', biaya: 'TIDAK_ADA' }), basisPenalti: 'BUNGA_BRUTO' }).jenis).toBe('LANJUTAN');
    expect(bacaKebijakanSederhana(null).jenis).toBe('KOSONG');
  });
});

describe('layar', () => {
  const layar = baca('screens/Simpanan/KebijakanPenarikanDiniScreen.tsx');
  test('tidak ada istilah teknis/konfigurasi lanjutan di UI', () => {
    // Teks yang terlihat pengguna (literal string & teks JSX), bukan nama variabel.
    expect(layar).not.toMatch(/['">][^'"<>{}\n]*[Ff]orfeiture[^'"<>{}\n]*['"<]/);
    expect(layar).not.toMatch(/Rate dini|Penyesuaian Rate|Perlakuan Pokok|Basis penalti|Cakupan penyesuaian/);
    expect(layar).not.toMatch(/setRateDini|setJenisForfeiture|setPerlakuanPokok|setJenisPenyesuaianRate/);
  });
  test('tiga komponen dengan label sederhana', () => {
    const helper = baca('utils/kebijakanDiniSederhana.ts');
    for (const l of ['Persentase dari Pokok', 'Nominal Tetap', 'Bunga Hangus', 'Bunga Tetap Dibayarkan']) expect(helper).toContain(l);
    expect(helper).toMatch(/PERSEN_POKOK: 'Persentase dari Pokok',\s*\};/);
    expect(layar).toContain('judul="Penalti Penarikan Dini"');
    expect(layar).toContain('judul="Bunga"');
    expect(layar).toContain('judul="Biaya Administrasi"');
  });
  test('alur konfirmasi sebelum menyimpan; tetap lewat service existing', () => {
    expect(layar).toMatch(/onPress=\{tinjau\}/);
    expect(layar).toMatch(/onPress=\{\(\) => void simpan\(\)\}/);
    expect(layar).toMatch(/await simpanKebijakanDini\(\{/);
    expect(layar).toMatch(/evaluasiKebijakanEarlyWithdrawal\(draf\)/);
  });
  test('akun pendapatan TERKUNCI: penalti 4-1150, biaya administrasi 4-1100 (tidak dapat dipilih)', () => {
    // Keputusan pengguna: akun tidak lagi dipilih lewat AccountPicker.
    expect(layar).not.toMatch(/AccountPicker/);
    expect(layar).toMatch(/<AkunTerkunci akun=\{akunPenalti\} kodeBaku=\{KODE_AKUN_PENALTI_DINI\} \/>/);
    expect(layar).toMatch(/<AkunTerkunci akun=\{akunBiayaAdmin\} kodeBaku=\{KODE_AKUN_BIAYA_ADMIN_DINI\} \/>/);
    const service = fs.readFileSync(path.join(ROOT, 'services/SimpananBerjangkaEarlyWithdrawalService.ts'), 'utf8');
    expect(service).toMatch(/export const KODE_AKUN_PENALTI_DINI = '4-1150';/);
    expect(service).toMatch(/export const KODE_AKUN_BIAYA_ADMIN_DINI = '4-1100';/);
    // Ditegakkan service, bukan hanya layar.
    expect(service).toMatch(/akunPenaltiId: perluPenalti \? akunTetap\.penalti!\.id : null/);
    expect(service).toMatch(/akunBiayaAdminId: perluBiaya \? akunTetap\.biayaAdmin!\.id : null/);
  });
  test('nominal rupiah tampil berpemisah ribuan saat diketik (100000 -> 100.000)', () => {
    expect(layar).toMatch(/formatNominalInput\(parseNominalInput\(nilai\)\)/);
  });
  test('nominal rupiah divalidasi bilangan bulat (aturan integer rupiah existing)', () => {
    expect(layar).toMatch(/Number\.isInteger\(n\)/);
  });
});

describe('Tarik Simpanan — bahasa sederhana', () => {
  test('ringkasan tidak memakai istilah "Forfeiture"', () => {
    const tarik = baca('screens/Transaksi/TarikSimpananFormScreen.tsx');
    const ui = baca('utils/tarikSimpananUi.ts');
    expect(tarik).not.toMatch(/['">][^'"<>{}\n]*[Ff]orfeiture[^'"<>{}\n]*['"<]/);
    expect(ui).not.toMatch(/'Forfeiture/);
    expect(ui).toContain("label: 'Bunga hangus'");
  });
});

describe('perhitungan biaya persentase tetap milik mesin existing', () => {
  test('basis POKOK -> percentageOf(pokok) di EarlyWithdrawalCalculation', () => {
    const calc = fs.readFileSync(path.join(ROOT, 'accounting/EarlyWithdrawalCalculation.ts'), 'utf8');
    expect(calc).toMatch(/jenisBiayaAdmin === 'PERSENTASE'[\s\S]{0,250}case 'POKOK':\s*biayaAdmin = percentageOf\(pokok, persen\)/);
  });
  test('layar tidak menghitung nominal penarikan', () => {
    const layar = baca('screens/Simpanan/KebijakanPenarikanDiniScreen.tsx');
    expect(layar).not.toMatch(/percentageOf|calculateEarlyWithdrawalSettlement|previewPencairanDini/);
  });
});

describe('mode lihat / edit & versi baru', () => {
  const layar = baca('screens/Simpanan/KebijakanPenarikanDiniScreen.tsx');
  test('kebijakan aktif tampil read-only dengan tombol Edit Kebijakan', () => {
    expect(layar).toMatch(/mode === 'LIHAT' && aktif/);
    expect(layar).toContain('Edit Kebijakan');
    expect(layar).toMatch(/onPress=\{mulaiEdit\}/);
    expect(layar).toMatch(/setMode\(kebijakan \? 'LIHAT' : 'EDIT'\)/);
  });
  test('edit mengisi nilai sebelumnya, versi dikosongkan & wajib berbeda', () => {
    const edit = layar.slice(layar.indexOf('const mulaiEdit'), layar.indexOf("setMode('EDIT');\n  };"));
    expect(edit).toMatch(/setVersi\(''\)/);
    expect(edit).toMatch(/setPilihanPenalti\(b\.keputusan\.penalti\)/);
    expect(edit).toMatch(/setPilihanBiaya\(b\.keputusan\.biaya\)/);
    // Akun tidak lagi disalin dari versi lama — selalu akun baku terkunci.
    expect(edit).not.toMatch(/setAkunPenalti|setAkunBiayaAdmin/);
    expect(layar).toMatch(/Perubahan harus memakai versi baru/);
  });
  test('penyimpanan tetap satu jalur: Tinjau -> konfirmasi -> simpanKebijakanDini (versi baru, tanpa hapus)', () => {
    expect(layar).toMatch(/onPress=\{tinjau\}/);
    expect((layar.match(/await simpanKebijakanDini\(/g) ?? []).length).toBe(1);
    expect(layar).not.toMatch(/DELETE|UPDATE simpanan_berjangka_kebijakan_dini/);
  });
  test('konfirmasi menampilkan nilai sebelumnya untuk yang berubah', () => {
    expect(layar).toMatch(/sebelumnya=\{lama !== b\.nilai \? lama : undefined\}/);
  });
});

describe('akses dari Tarik Simpanan Anggota', () => {
  test('tautan kebijakan tersedia di mode berjangka walau kebijakan sudah aktif (untuk Edit)', () => {
    const tarik = baca('screens/Transaksi/TarikSimpananFormScreen.tsx');
    expect(tarik).toMatch(/jenis === 'BERJANGKA' && bolehBukaKebijakan \? \([\s\S]{0,250}navigation\.navigate\('KebijakanPenarikanDini'\)/);
    const pengaturan = baca('screens/Pengaturan/PengaturanScreen.tsx');
    expect(pengaturan).not.toMatch(/KebijakanPenarikanDini/);
  });
});
