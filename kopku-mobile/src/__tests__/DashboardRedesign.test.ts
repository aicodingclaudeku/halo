/**
 * Redesign Dashboard (UI/UX saja): kartu dapat diketuk ke rute existing,
 * data & logika (kueri, lisensi, identitas) tidak berubah.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const dash = fs.readFileSync(path.join(ROOT, 'src/screens/Dashboard/DashboardScreen.tsx'), 'utf8');
const nav = fs.readFileSync(path.join(ROOT, 'src/navigation/RootNavigator.tsx'), 'utf8');

describe('kartu dapat diketuk ke rute terdaftar', () => {
  it.each([
    ['Anggota', 'AnggotaList', 'AnggotaStack'],
    ['Transaksi', 'SimpananHistori', 'TransaksiStack'],
    ['Transaksi', 'PinjamanList', 'TransaksiStack'],
    ['Transaksi', 'BayarAngsuranForm', 'TransaksiStack'],
    ['Transaksi', 'TarikSimpananForm', 'TransaksiStack'],
    ['Laporan', 'KolektibilitasPiutang', 'LaporanStack'],
  ])('%s › %s', (tab, rute, stack) => {
    expect(dash).toContain(`navigation.navigate('${tab}', { screen: '${rute}', initial: false })`);
    expect(nav).toMatch(new RegExp(`<${stack}\\.Screen\\s+name="${rute}"`));
    expect(nav).toContain(`<Tab.Screen name="${tab}"`);
  });

  it('kartu Anggota Aktif, Total Pinjaman, Tunggakan & hero Total Simpanan memakai aksi navigasi', () => {
    expect(dash).toMatch(/label="Anggota Aktif"[\s\S]{0,200}onPress=\{buka\.anggota\}/);
    expect(dash).toMatch(/label="Total Pinjaman"[\s\S]{0,200}onPress=\{buka\.pinjaman\}/);
    expect(dash).toMatch(/label="Tunggakan"[\s\S]{0,250}onPress=\{buka\.tunggakan\}/);
    expect(dash).toMatch(/style=\{styles\.hero\}[\s\S]{0,80}onPress=\{buka\.simpanan\}/);
  });

  it('tidak ada navigasi bersarang ke tab Pengaturan', () => {
    expect(dash).not.toMatch(/navigate\('Pengaturan', \{/);
  });
});

describe('data & logika tidak berubah', () => {
  it('kueri ringkasan tetap sama', () => {
    expect(dash).toMatch(/SELECT COUNT\(\*\) as cnt FROM anggota WHERE status = 'AKTIF'/);
    expect(dash).toMatch(/FROM simpanan_transaksi\s+WHERE reversal_of_id IS NULL/);
    expect(dash).toMatch(/SELECT COALESCE\(SUM\(jumlah_pinjaman\),0\) as total FROM pinjaman WHERE status IN \('AKTIF','LUNAS'\)/);
    expect(dash).toMatch(/aj\.tanggal_jatuh_tempo < date\('now'\)/);
  });
  it('tarik-untuk-memuat-ulang memanggil load() yang sama', () => {
    expect(dash).toMatch(/<RefreshControl[\s\S]{0,200}await load\(\);/);
  });
});
