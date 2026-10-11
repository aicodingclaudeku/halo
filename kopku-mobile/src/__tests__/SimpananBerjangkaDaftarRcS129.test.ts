import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

/**
 * RC-S129 — UI/UX Simpanan Berjangka (daftar dengan pencarian & filter,
 * penjelasan status) dan akrual bunga Simpanan Sukarela tanpa tombol manual.
 *
 * Bagian A–B fungsi murni, C integrasi SQLite (daftar + nama anggota),
 * D struktural layar.
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import {
  listSimpananBerjangka,
  listSimpananBerjangkaDaftar,
  setorSimpananBerjangka,
  SimpananBerjangkaDaftarRow,
} from '@/services/SimpananBerjangkaService';
import {
  adaFilterAktif,
  cocokPencarianBerjangka,
  hitungPerStatus,
  inisialNama,
  jatuhTempoPadaBulan,
  KRITERIA_AWAL,
  perluDitinjauPengurus,
  saringDaftarBerjangka,
} from '@/utils/daftarSimpananBerjangka';
import { penjelasanKontrak, tahapKontrak, tanggalPendek, teksSukuBunga } from '@/screens/Simpanan/tampilanBerjangka';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function baris(p: Partial<SimpananBerjangkaDaftarRow> & { id: string }): SimpananBerjangkaDaftarRow {
  return {
    anggotaId: 'a',
    nomorTransaksi: `SPB-${p.id}`,
    tanggalMulai: '2026-01-10',
    tanggalJatuhTempo: '2026-07-10',
    nominal: 1_000_000,
    tenorBulan: 6,
    sukuBungaPerTahun: 6,
    status: 'AKTIF',
    sumberDana: 'KAS',
    bankAccountId: null,
    keterangan: null,
    journalId: null,
    createdAt: '2026-01-10T00:00:00Z',
    bungaTerakru: 0,
    bungaDibayar: 0,
    tanggalPencairan: null,
    journalPencairanId: null,
    statusPolicy: 'POLICY_SNAPSHOT',
    policyVersi: 'KBP-1',
    namaAnggota: 'Anggota',
    nomorAnggota: 'A000',
    ...p,
  };
}

const DATA: SimpananBerjangkaDaftarRow[] = [
  baris({ id: '1', namaAnggota: 'Siti Aminah', nomorAnggota: 'A001', nominal: 10_000_000, tanggalMulai: '2026-04-15', tanggalJatuhTempo: '2026-10-15' }),
  baris({ id: '2', namaAnggota: 'Budi Hartono', nomorAnggota: 'A002', nominal: 5_000_000, status: 'JATUH_TEMPO', tanggalMulai: '2026-01-02', tanggalJatuhTempo: '2026-04-02' }),
  baris({ id: '3', namaAnggota: 'Andi Saputra', nomorAnggota: 'A003', nominal: 25_000_000, status: 'DICAIRKAN', tanggalMulai: '2025-06-01', tanggalJatuhTempo: '2026-06-01', tanggalPencairan: '2026-06-05' }),
  baris({ id: '4', namaAnggota: 'Siti Rahma', nomorAnggota: 'A004', nominal: 2_500_000, statusPolicy: 'LEGACY_POLICY_REVIEW_REQUIRED', policyVersi: null, tanggalMulai: '2026-07-01', tanggalJatuhTempo: '2026-10-01', keterangan: 'bilyet 77' }),
  baris({ id: '5', namaAnggota: null, nomorAnggota: null, nominal: 1_000_000, status: 'DIBATALKAN', tanggalMulai: '2026-02-01' }),
];
const HARI_INI = '2026-10-06';
const k = (p: Partial<typeof KRITERIA_AWAL> = {}) => ({ ...KRITERIA_AWAL, hariIni: HARI_INI, ...p });
const ids = (r: SimpananBerjangkaDaftarRow[]) => r.map((x) => x.id);

// ---------------------------------------------------------------------------
describe('RC-S129 §A — pencarian & filter daftar (murni)', () => {
  test('tanpa kriteria: semua kontrak, urut terbaru, input tidak diubah', () => {
    const salin = [...DATA];
    expect(ids(saringDaftarBerjangka(DATA, k()))).toEqual(['4', '1', '5', '2', '3']);
    expect(DATA).toEqual(salin);
    expect(adaFilterAktif(k())).toBe(false);
  });

  test('cari nama tanpa peka huruf besar; beberapa kata urutan bebas', () => {
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'siti' })))).toEqual(['4', '1']);
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'AMINAH siti' })))).toEqual(['1']);
  });

  test('cari nomor anggota, nomor kontrak, keterangan', () => {
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'a002' })))).toEqual(['2']);
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'SPB-3' })))).toEqual(['3']);
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'bilyet' })))).toEqual(['4']);
  });

  test('cari nominal dengan atau tanpa titik ribuan', () => {
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: '25.000.000' })))).toEqual(['3']);
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: 'Rp5000000' })))).toEqual(['2']);
    // Kurang dari 4 digit tidak dianggap pencarian nominal (hindari "1" cocok ke semua).
    expect(ids(saringDaftarBerjangka(DATA, k({ cari: '25' })))).toEqual([]);
  });

  test('filter status, jatuh tempo bulan ini (hanya kontrak berjalan), perlu ditinjau', () => {
    expect(ids(saringDaftarBerjangka(DATA, k({ status: 'JATUH_TEMPO' })))).toEqual(['2']);
    expect(ids(saringDaftarBerjangka(DATA, k({ jatuhTempoBulanIni: true })))).toEqual(['4', '1']);
    expect(ids(saringDaftarBerjangka(DATA, k({ perluDitinjau: true })))).toEqual(['4']);
    expect(ids(saringDaftarBerjangka(DATA, k({ status: 'AKTIF', cari: 'rahma', perluDitinjau: true })))).toEqual(['4']);
    expect(adaFilterAktif(k({ status: 'AKTIF' }))).toBe(true);
  });

  test('urutan: jatuh tempo terdekat (kontrak berjalan dulu) & pokok terbesar', () => {
    expect(ids(saringDaftarBerjangka(DATA, k({ urutan: 'JATUH_TEMPO_TERDEKAT' })))).toEqual(['2', '4', '1', '3', '5']);
    expect(ids(saringDaftarBerjangka(DATA, k({ urutan: 'NOMINAL_TERBESAR' })))).toEqual(['3', '1', '2', '4', '5']);
  });

  test('hitungan per status = jumlah kontrak, bukan uang', () => {
    expect(hitungPerStatus(DATA)).toEqual({ SEMUA: 5, AKTIF: 2, JATUH_TEMPO: 1, DICAIRKAN: 1, DIBATALKAN: 1 });
  });

  test('helper kecil', () => {
    expect(cocokPencarianBerjangka(DATA[0], '   ')).toBe(true);
    expect(jatuhTempoPadaBulan(DATA[2], '2026-06-30')).toBe(false); // sudah dicairkan
    expect(perluDitinjauPengurus(DATA[3])).toBe(true);
    expect(inisialNama('Siti Aminah')).toBe('SA');
    expect(inisialNama('budi')).toBe('B');
    expect(inisialNama(null)).toBe('?');
  });
});

// ---------------------------------------------------------------------------
describe('RC-S129 §B — bahasa tampilan (murni)', () => {
  test('tanggal pendek & suku bunga', () => {
    expect(tanggalPendek('2027-01-15')).toBe('15 Jan 2027');
    expect(tanggalPendek(null)).toBe('-');
    expect(tanggalPendek('bukan tanggal')).toBe('bukan tanggal');
    expect(teksSukuBunga(6)).toMatch(/^6.*per tahun$/);
    expect(teksSukuBunga(0)).toBe('Tanpa bunga');
  });

  test('tahap kontrak untuk penunjuk langkah', () => {
    expect(tahapKontrak('AKTIF', false)).toBe(1);
    expect(tahapKontrak('AKTIF', true)).toBe(2);
    expect(tahapKontrak('JATUH_TEMPO', false)).toBe(2);
    expect(tahapKontrak('DICAIRKAN', true)).toBe(3);
    expect(tahapKontrak('DIBATALKAN', false)).toBe(-1);
  });

  const dasar = { sudahJatuhTempo: false, tanggalJatuhTempo: '2027-01-15', tanggalPencairan: null, ratePerTahun: 6, bungaPascaAktif: true, ratePasca: 4 };
  test('penjelasan status dalam bahasa sehari-hari', () => {
    expect(penjelasanKontrak({ ...dasar, status: 'AKTIF' }).isi).toMatch(/Simpanan Sukarela.*15 Jan 2027/);
    expect(penjelasanKontrak({ ...dasar, status: 'AKTIF', ratePerTahun: 0 }).isi).toMatch(/tanpa bunga/);
    const jt = penjelasanKontrak({ ...dasar, status: 'JATUH_TEMPO' });
    expect(jt.judul).toMatch(/siap dicairkan/);
    expect(jt.isi).toMatch(/tidak dicairkan atau diperpanjang otomatis/);
    expect(jt.isi).toMatch(/tetap berbunga 4/);
    expect(penjelasanKontrak({ ...dasar, status: 'JATUH_TEMPO', bungaPascaAktif: false }).isi).toMatch(/tidak berbunga lagi/);
    expect(penjelasanKontrak({ ...dasar, status: 'JATUH_TEMPO', bungaPascaAktif: null }).isi).toMatch(/Kontrak lama/);
    expect(penjelasanKontrak({ ...dasar, status: 'DICAIRKAN', tanggalPencairan: '2027-08-20' }).isi).toMatch(/20 Agu 2027.*Simpanan Sukarela/);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S129 §C — listSimpananBerjangkaDaftar (SQLite)', () => {
  const now = () => new Date().toISOString();
  beforeEach(async () => {
    testDb = await createTestDb();
    const akun = async (id: string, kode: string, nama: string, kat: string, nb: string) =>
      testDb.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
        id, kode, nama, kat, nb, now(), now()
      );
    await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
    await akun('acc-2-1210', '2-1210', 'Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT','acc-kas')`);
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m2','SIMPANAN_BERJANGKA','KREDIT_DEFAULT','acc-2-1210')`);
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
    );
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
      now(), now()
    );
    for (const [id, no, nama] of [['ang-A', 'A001', 'Siti Aminah'], ['ang-B', 'A002', 'Budi Hartono']]) {
      await testDb.runAsync(
        `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
         VALUES (?,?,?,?,'2020-01-01','AKTIF',?,?)`,
        id, no, `NIK-${id}`, nama, now(), now()
      );
    }
    await seedKebijakanProdukUji(testDb);
  });

  test('baris sama dengan listSimpananBerjangka + nama & nomor anggota; filter anggota tetap jalan', async () => {
    await setorSimpananBerjangka({ anggotaId: 'ang-A', nominal: 10_000_000, tenorBulan: 6, sukuBungaPerTahun: 6, tanggal: '2026-07-15', sumberDana: 'KAS', createdBy: 'user-1' });
    await setorSimpananBerjangka({ anggotaId: 'ang-B', nominal: 5_000_000, tenorBulan: 3, tanggal: '2026-08-01', sumberDana: 'KAS', createdBy: 'user-1' });

    const lama = await listSimpananBerjangka();
    const baru = await listSimpananBerjangkaDaftar();
    expect(baru.map(({ namaAnggota, nomorAnggota, ...r }) => r)).toEqual(lama);
    expect(baru.map((r) => [r.namaAnggota, r.nomorAnggota])).toEqual([['Budi Hartono', 'A002'], ['Siti Aminah', 'A001']]);
    expect((await listSimpananBerjangkaDaftar('ang-A')).map((r) => r.namaAnggota)).toEqual(['Siti Aminah']);

    // Pencarian bekerja di atas data nyata.
    expect(saringDaftarBerjangka(baru, k({ cari: 'aminah' })).map((r) => r.nominal)).toEqual([10_000_000]);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S129 §D — struktur layar', () => {
  const daftar = tanpaKomentar(baca('src/screens/Simpanan/SimpananBerjangkaHistoriScreen.tsx'));
  const detail = tanpaKomentar(baca('src/screens/Simpanan/SimpananBerjangkaDetailScreen.tsx'));
  const form = tanpaKomentar(baca('src/screens/Simpanan/SimpananFormScreen.tsx'));
  const sukarela = tanpaKomentar(baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx'));

  test('daftar: pencarian, filter, urutan, dan nama anggota dari service baca-saja', () => {
    expect(daftar).toMatch(/<SearchField\b/);
    expect(daftar).toMatch(/saringDaftarBerjangka\(data, kriteria\)/);
    expect(daftar).toMatch(/listSimpananBerjangkaDaftar\(anggotaId\)/);
    expect(daftar).toMatch(/Jatuh tempo bulan ini/);
    expect(daftar).toMatch(/Kontrak lama perlu ditinjau/);
    expect(daftar).toMatch(/Reset filter/);
    expect(daftar).toMatch(/item\.namaAnggota/);
    // Tidak ada lagi "Total Dicairkan = pokok + bunga" yang dihitung di layar.
    expect(daftar).not.toMatch(/nominal \+ item\.bungaDibayar/);
  });

  test('detail: penjelasan status & penunjuk tahap, tanpa aritmetika uang', () => {
    expect(detail).toMatch(/penjelasanKontrak\(/);
    expect(detail).toMatch(/LANGKAH_KONTRAK\.map/);
    expect(detail).toMatch(/<CaraKerjaBerjangka/);
    expect(detail).not.toMatch(/reduce\(/);
  });

  test('form penempatan: kartu langkah, ringkasan, dan perkiraan bunga dari helper akuntansi', () => {
    expect(form).toMatch(/<KartuLangkah nomor=\{1\}/);
    expect(form).toMatch(/<KartuLangkah nomor=\{3\}/);
    expect(form).toMatch(/<RingkasanTransaksi\b/);
    expect(form).toMatch(/hitungTotalBungaKontrak\(berjangkaNominal, rateTampil, tenor\)/);
    expect(form).toMatch(/buatJadwalBungaSimpananBerjangka\(/);
    // Jalur reguler tetap memakai tombol & teks lamanya.
    expect(form).toMatch(/Simpan Transaksi/);
    expect(form).toMatch(/Total yang akan disetor/);
  });

  test('bunga sukarela: tanpa tombol akru manual; layar menunggu & memicu koordinator otomatis', () => {
    expect(sukarela).not.toMatch(/prosesAkrualBungaSukarela/);
    expect(sukarela).not.toMatch(/Akru Bunga \{/);
    expect(sukarela).toMatch(/await tungguTugasStartupSelesai\(\)/);
    expect(sukarela).toMatch(/await jalankanTugasStartup\(currentUser\.id\)/);
    expect(sukarela).toMatch(/Akrual bunga otomatis/);
    // Satu kali per pemuatan — tidak ada loop/timer.
    expect(sukarela).not.toMatch(/setInterval|setTimeout/);
    expect(baca('src/config/panduanAplikasi.ts')).not.toMatch(/menekan "Akru Bunga"/);
    expect(baca('src/components/panduan/IlustrasiUi.tsx')).not.toMatch(/Akru Bunga Oktober/);
  });
});
