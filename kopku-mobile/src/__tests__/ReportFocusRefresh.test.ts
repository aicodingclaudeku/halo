import * as fs from 'fs';
import * as path from 'path';
import { TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { buatFixtureHistoris, ACC, USER_ID } from './historicalFixture';
import { catatPemasukan, catatPengeluaran } from '@/services/KasBankService';
import {
  getLHU,
  getArusKas,
  getPerubahanEkuitas,
  getLedger,
  getCalkDenganEditManual,
} from '@/reports/FinancialReports';

/**
 * ============================================================
 * §B/§C — AUTO-REFRESH ENAM LAYAR LAPORAN
 * ============================================================
 *
 * Dua lapis pemeriksaan, karena masalahnya memang dua hal berbeda:
 *
 *  1. LAPIS LIFECYCLE (pemeriksaan source). Proyek ini tidak memuat
 *     react-test-renderer / @testing-library/react-native, sehingga
 *     peristiwa fokus navigator TIDAK BISA disimulasikan di Jest.
 *     Yang bisa dipastikan secara otomatis adalah kontrak strukturnya:
 *     tiap layar memakai SATU helper lifecycle bersama
 *     (`useFocusRefresh`), memasang penjaga balapan
 *     (`usePermintaanTerakhir`), dan TIDAK lagi memuat data di dalam
 *     handler pemilihan periode — sumber tepat dari bug "laporan baru
 *     berubah setelah aplikasi di-restart". Test ini akan gagal kalau
 *     ada yang mengembalikan pola lama atau memasang mekanisme refresh
 *     kedua.
 *
 *  2. LAPIS DATA. Setelah layar memuat ULANG, apakah angkanya memang
 *     berubah? Diuji dengan memanggil fungsi laporan yang SAMA dua
 *     kali pada koneksi SQLite yang sama, dengan transaksi BACKDATED
 *     disisipkan di antaranya — meniru "buka laporan -> catat transaksi
 *     -> kembali ke laporan" tanpa mengubah filter/periode.
 */

const DIR_LAPORAN = path.join(__dirname, '..', 'screens', 'Laporan');

const LAYAR: { nama: string; berkas: string }[] = [
  { nama: 'Laba Rugi (LHU)', berkas: 'LabaRugiScreen.tsx' },
  { nama: 'Arus Kas', berkas: 'ArusKasScreen.tsx' },
  { nama: 'Perubahan Ekuitas', berkas: 'PerubahanEkuitasScreen.tsx' },
  { nama: 'Buku Besar', berkas: 'BukuBesarScreen.tsx' },
  { nama: 'Kolektibilitas Piutang', berkas: 'KolektibilitasPiutangScreen.tsx' },
  { nama: 'CALK', berkas: 'CalkScreen.tsx' },
];

function sumber(berkas: string): string {
  return fs.readFileSync(path.join(DIR_LAPORAN, berkas), 'utf8');
}

describe('§B — lifecycle refresh enam layar laporan', () => {
  it.each(LAYAR)('$nama memakai helper lifecycle bersama useFocusRefresh', ({ berkas }) => {
    const kode = sumber(berkas);
    expect(kode).toMatch(/from '@\/hooks\/useFocusRefresh'/);
    expect(kode).toContain('useFocusRefresh(muat, [muat])');
  });

  it.each(LAYAR)('$nama memasang penjaga balapan usePermintaanTerakhir', ({ berkas }) => {
    const kode = sumber(berkas);
    expect(kode).toContain('usePermintaanTerakhir()');
    expect(kode).toContain('permintaan.mulai()');
    expect(kode).toContain('permintaan.masihTerbaru(token)');
  });

  it.each(LAYAR)('$nama hanya punya SATU lifecycle pemuatan (tidak ada refresh ganda)', ({ berkas }) => {
    const kode = sumber(berkas);
    expect(kode.match(/useFocusRefresh\(/g) ?? []).toHaveLength(1);
    // Tidak boleh ada useEffect yang memanggil load() di sampingnya —
    // itu akan menghasilkan dua kueri per perubahan filter (§4/§20).
    expect(kode).not.toMatch(/useEffect\(\s*\(\)\s*=>\s*\{\s*load\(/);
  });

  it.each(LAYAR.filter((l) => l.berkas !== 'BukuBesarScreen.tsx'))(
    '$nama tidak lagi memuat data di dalam handler pemilihan periode',
    ({ berkas }) => {
      const kode = sumber(berkas);
      const handler = kode.slice(kode.indexOf('const onChangePeriode'));
      const badan = handler.slice(0, handler.indexOf('};') + 2);
      expect(badan).toContain('setPeriode(p)');
      expect(badan).not.toMatch(/\bload\(/);
    }
  );

  it('Buku Besar mempertahankan tombol "Tampilkan" dan memakai ref (bukan state) sebagai penanda', () => {
    const kode = sumber('BukuBesarScreen.tsx');
    expect(kode).toContain('onPress={load}');
    // Penanda WAJIB ref: kalau state, ia menjadi dependensi dan setiap
    // pemuatan akan memicu pemuatan berikutnya (loop).
    expect(kode).toContain('const pernahDitampilkan = useRef(false)');
    expect(kode).not.toMatch(/useState\([^)]*\)[^;]*pernahDitampilkan/);
  });

  it('ROOT CAUSE terdokumentasi: ReportPeriodPicker memang hanya memanggil onChange sekali saat mount', () => {
    const picker = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'ReportPeriodPicker.tsx'), 'utf8'
    );
    // useEffect dengan daftar dependensi KOSONG -> sekali saat mount.
    expect(picker).toMatch(/useEffect\(\(\) => \{[\s\S]*?\}\)\(\);[\s\S]*?\}, \[\]\);/);
  });
});

describe('§C — lapis data: laporan mencerminkan transaksi backdated tanpa restart', () => {
  const PERIODE = { mulai: '2026-06-01', selesai: '2026-06-30' };

  beforeAll(async () => {
    testDb = await buatFixtureHistoris();
  });

  it('Laba Rugi (LHU): pendapatan & beban 12 Juni langsung terbaca pada pemanggilan berikutnya', async () => {
    const sebelum = await getLHU(testDb as any, PERIODE.mulai, PERIODE.selesai);
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 2_500_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendapatan backdated', createdBy: USER_ID,
    });
    await catatPengeluaran({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 400_000,
      akunLawanId: ACC.bebanLain, keterangan: 'beban backdated', createdBy: USER_ID,
    });
    const sesudah = await getLHU(testDb as any, PERIODE.mulai, PERIODE.selesai);
    expect(sesudah.shuNeto - sebelum.shuNeto).toBe(2_500_000 - 400_000);
  });

  it('Arus Kas: mutasi kas 12 Juni langsung terbaca', async () => {
    const sebelum = await getArusKas(testDb as any, PERIODE.mulai, PERIODE.selesai);
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 1_000_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'kas backdated', createdBy: USER_ID,
    });
    const sesudah = await getArusKas(testDb as any, PERIODE.mulai, PERIODE.selesai);
    expect(sesudah.perubahanKas - sebelum.perubahanKas).toBe(1_000_000);
    expect(sesudah.kasAkhirDihitung).toBe(sesudah.kasAkhirAktual);
  });

  it('Perubahan Ekuitas: hasil usaha periode ikut berubah', async () => {
    const sebelum = await getPerubahanEkuitas(testDb as any, PERIODE.mulai, PERIODE.selesai);
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 700_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendapatan ekuitas', createdBy: USER_ID,
    });
    const sesudah = await getPerubahanEkuitas(testDb as any, PERIODE.mulai, PERIODE.selesai);
    expect(sesudah.hasilUsahaPeriode - sebelum.hasilUsahaPeriode).toBe(700_000);
  });

  it('Buku Besar: baris baru muncul tanpa mengubah filter akun/tanggal', async () => {
    const opsi = { tanggalMulai: PERIODE.mulai, tanggalSelesai: PERIODE.selesai };
    const sebelum = await getLedger(testDb as any, ACC.kas, opsi);
    await catatPengeluaran({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 250_000,
      akunLawanId: ACC.bebanLain, keterangan: 'beban buku besar', createdBy: USER_ID,
    });
    const sesudah = await getLedger(testDb as any, ACC.kas, opsi);
    expect(sesudah.length).toBe(sebelum.length + 1);
    expect(sesudah[sesudah.length - 1].tanggal).toBe('2026-06-12');
  });

  it('CALK: angka yang dirujuk catatan ikut mutakhir', async () => {
    const sebelum = await getCalkDenganEditManual(testDb as any, PERIODE.mulai, PERIODE.selesai);
    await catatPemasukan({
      jenis: 'KAS', tanggal: '2026-06-12', nominal: 3_300_000,
      akunLawanId: ACC.pendapatanLain, keterangan: 'pendapatan calk', createdBy: USER_ID,
    });
    const sesudah = await getCalkDenganEditManual(testDb as any, PERIODE.mulai, PERIODE.selesai);
    expect(JSON.stringify(sesudah)).not.toBe(JSON.stringify(sebelum));
  });
});
