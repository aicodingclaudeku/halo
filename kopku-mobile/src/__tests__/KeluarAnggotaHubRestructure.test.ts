import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RESTRUKTURISASI UI/UX — KELUAR ANGGOTA sebagai HUB.
 *
 * Dua lapis:
 *  1. STRUKTURAL (audit sumber) — hub murni navigasi, pemisahan
 *     pengajuan vs daftar, rute tidak ganda, service tidak diduplikasi.
 *  2. PERILAKU (SQLite sungguhan) — alur DIAJUKAN → DISETUJUI → DIBAYAR
 *     tetap utuh setelah layar dipecah, dan navigasi tidak membuat
 *     jurnal apa pun.
 *
 * Renderer React Native tidak tersedia di Jest repo ini, jadi lapis (1)
 * memeriksa sumber layar — konvensi yang sama dengan test UI lain.
 */

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

import {
  ajukanKeluarAnggota,
  setujuiKeluarAnggota,
  tolakKeluarAnggota,
  bayarKeluarAnggota,
  listKeluarAnggota,
  previewKeluarAnggota,
} from '@/services/KeluarAnggotaService';
import { setorSimpanan } from '@/services/SimpananService';
import { LABEL_ALASAN_KELUAR } from '@/screens/Transaksi/keluarAnggotaLabels';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HUB = 'src/screens/Transaksi/KeluarAnggotaMenuScreen.tsx';
const FORM = 'src/screens/Transaksi/KeluarAnggotaFormScreen.tsx';
const DAFTAR = 'src/screens/Transaksi/DaftarKeluarAnggotaScreen.tsx';
const NAV = 'src/navigation/RootNavigator.tsx';

const ANGGOTA_ID = 'anggota-1';
const USER_ID = 'user-1';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') =>
    db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  const map = async (tt: string, role: string, acc: string) =>
    db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `m-${tt}-${role}`, tt, role, acc);

  await akun('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun('acc-pokok', '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await akun('acc-wajib', '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await akun('acc-sukarela', '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await map('KAS_UMUM', 'DEFAULT', 'acc-kas');
  await map('SIMPANAN_POKOK', 'KREDIT_DEFAULT', 'acc-pokok');
  await map('SIMPANAN_WAJIB', 'KREDIT_DEFAULT', 'acc-wajib');
  await map('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', 'acc-sukarela');
  await map('KELUAR_ANGGOTA', 'DEBIT_POKOK', 'acc-pokok');
  await map('KELUAR_ANGGOTA', 'DEBIT_WAJIB', 'acc-wajib');
  await map('KELUAR_ANGGOTA', 'DEBIT_SUKARELA', 'acc-sukarela');

  const tahun = Number(getTanggalLokalHariIni().slice(0, 4));
  for (const t of [tahun - 1, tahun]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${t}`, t, `${t}-01-01`, `${t}-12-31`
    );
  }
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,'Admin','admin','ADMIN','x','x',0,1,?,?)`, USER_ID, now, now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'AGT-0001', '3201010101010001', 'Budi Santoso', '2020-01-01', now, now
  );
  return db;
}

/** Potret seluruh tabel akuntansi — untuk membuktikan navigasi tidak menulis apa pun. */
async function potretAkuntansi(db: TestDb) {
  return JSON.stringify({
    j: await db.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    e: await db.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    k: await db.getAllAsync<any>(`SELECT * FROM keluar_anggota ORDER BY id`),
    s: await db.getAllAsync<any>(`SELECT * FROM simpanan_transaksi ORDER BY id`),
  });
}

// ===========================================================================
// 1. STRUKTURAL — hub, pemisahan, rute
// ===========================================================================

describe('Keluar Anggota — hub murni navigasi', () => {
  const hub = tanpaKomentar(baca(HUB));

  it('TEST 24 — hub TIDAK mengimpor satu pun fungsi daftar/aksi', () => {
    for (const terlarang of [
      'listKeluarAnggota', 'setujuiKeluarAnggota', 'tolakKeluarAnggota',
      'bayarKeluarAnggota', 'ajukanKeluarAnggota', 'previewKeluarAnggota',
    ]) {
      expect(hub).not.toContain(terlarang);
    }
    // Tidak menyentuh service/database sama sekali.
    expect(hub).not.toMatch(/@\/services\/|@\/database\/|useState|useEffect/);
  });

  it('TEST 4 — hub menampilkan TEPAT DUA menu utama', () => {
    const judul = Array.from(hub.matchAll(/judul: '([^']+)'/g)).map((m) => m[1]);
    expect(judul).toEqual(['Pengajuan', 'Daftar Pengajuan']);
  });

  it('TEST 5/6 — masing-masing menu menavigasi ke rutenya, ditulis sebagai literal', () => {
    expect(hub).toContain("nav.navigate('KeluarAnggotaForm')");
    expect(hub).toContain("nav.navigate('DaftarKeluarAnggota')");
  });

  it('TEST 7 — copy sesuai spesifikasi, tanpa label ambigu & tanpa istilah teknis', () => {
    expect(hub).toContain("sub: 'Buat pengajuan keluar anggota'");
    expect(hub).toContain("sub: 'Lihat dan kelola pengajuan'");
    expect(hub).toContain('Kelola pengajuan dan penyelesaian hak anggota yang keluar.');
    for (const ambigu of ["judul: 'Tambah'", "judul: 'Data'", "judul: 'List'"]) {
      expect(hub).not.toContain(ambigu);
    }
    for (const teknis of ['status_pengajuan', 'nilai_pengembalian', 'journalId']) {
      expect(hub).not.toContain(teknis);
    }
  });

  it('TEST 37 — hub tidak dapat digulir (kalau perlu scroll, ia sudah tumbuh melampaui tujuannya)', () => {
    expect(hub).not.toContain('ScrollView');
    expect(hub).not.toContain('FlatList');
  });

  it('TEST 9/10 — dua tile berbagi lebar, dan dapat turun ke bawah pada layar sangat sempit', () => {
    expect(hub).toMatch(/baris: \{ flexDirection: 'row', flexWrap: 'wrap'/);
    expect(hub).toMatch(/kartu: \{\s*flex: 1,\s*minWidth: \d+/);
  });

  it('TEST 11/12 — ikon dari Ionicons (bukan emoji), pressed state, dan accessibility', () => {
    expect(hub).toContain("icon: 'document-text-outline'");
    expect(hub).toContain("icon: 'list-outline'");
    expect(hub).toContain('accessibilityRole="button"');
    expect(hub).toContain("aksesLabel: 'Pengajuan keluar anggota'");
    expect(hub).toContain("aksesLabel: 'Daftar pengajuan keluar anggota'");
    expect(hub).toContain('pressed && styles.kartuDitekan');
  });
});

describe('Keluar Anggota — pemisahan pengajuan vs daftar', () => {
  const form = tanpaKomentar(baca(FORM));
  const daftar = tanpaKomentar(baca(DAFTAR));

  it('TEST 25 — form pengajuan memakai preview+ajukan, dan TIDAK memakai daftar/aksi', () => {
    expect(form).toContain('previewKeluarAnggota(');
    expect(form).toContain('ajukanKeluarAnggota(');
    for (const terlarang of ['listKeluarAnggota', 'setujuiKeluarAnggota', 'tolakKeluarAnggota', 'bayarKeluarAnggota']) {
      expect(form).not.toContain(terlarang);
    }
    // Sumber Pembayaran ikut pindah — ia hanya dipakai tombol Bayar.
    expect(form).not.toContain('RekeningPicker');
    expect(form).not.toContain('Sumber Pembayaran');
  });

  // DIPERBARUI RC-S75: daftar kini MURNI monitoring + navigasi; ketiga aksi
  // pindah ke layar Detail. Dijaga lengkap di `KeluarAnggotaDetailRcS75.test.ts`.
  it('TEST 26 — layar daftar hanya membaca daftar; TIDAK memegang aksi mutasi apa pun', () => {
    expect(daftar).toContain('listKeluarAnggota(');
    for (const terlarang of [
      'setujuiKeluarAnggota', 'tolakKeluarAnggota', 'bayarKeluarAnggota',
      'ajukanKeluarAnggota', 'previewKeluarAnggota', 'AnggotaPicker', 'RekeningPicker',
    ]) {
      expect(daftar).not.toContain(terlarang);
    }
  });

  it('TEST 22 — tidak ada service kedua; keduanya memakai KeluarAnggotaService yang sama', () => {
    for (const src of [form, daftar]) {
      expect(src).toMatch(/from '@\/services\/KeluarAnggotaService'/);
      expect(src).not.toMatch(/KeluarAnggotaServiceV2|KeluarAnggotaManager|KeluarAnggotaController/);
    }
    // Label alasan TIDAK disalin ke dua berkas — satu modul bersama.
    for (const src of [form, daftar]) {
      expect(src).toContain("from '@/screens/Transaksi/keluarAnggotaLabels'");
      expect(src).not.toMatch(/MENGUNDURKAN_DIRI: 'Mengundurkan Diri'/);
    }
  });

  it('TEST 30 — filter status hanya memfilter data tampilan, tanpa query baru', () => {
    expect(daftar).toMatch(/daftar\.filter\(\(r\) => r\.statusPengajuan === filter\)/);
    // listKeluarAnggota dipanggil sekali, di dalam `muat` — bukan per filter.
    expect(daftar.match(/listKeluarAnggota\(\)/g)).toHaveLength(1);
    const iFilter = daftar.indexOf('const terlihat = useMemo(');
    expect(daftar.slice(iFilter, iFilter + 300)).not.toContain('listKeluarAnggota');
  });

  it('TEST 19 — daftar memuat saat fokus, tanpa polling', () => {
    expect(daftar).toContain("import { useFocusRefresh } from '@/hooks/useFocusRefresh';");
    expect(daftar).toContain('useFocusRefresh(muat, [muat]);');
    expect(daftar).not.toMatch(/setInterval|setTimeout/);
  });

  it('TEST 16/17/18 — empty, loading, dan error state; tanpa raw SQLite error', () => {
    expect(daftar).toContain('Belum ada pengajuan keluar anggota');
    expect(daftar).toContain('Pengajuan yang dibuat akan muncul di sini.');
    expect(daftar).toContain('Buat Pengajuan');
    expect(daftar).toContain("navigation.navigate('KeluarAnggotaForm')"); // CTA murni navigasi
    expect(daftar).toContain('ActivityIndicator');
    expect(daftar).toContain('Tidak ada pengajuan pada status ini.');
    expect(daftar).toContain('Pengajuan keluar anggota gagal dimuat.');
    expect(daftar).toContain('Coba lagi');
    // Pesan exception TIDAK diteruskan ke UI saat memuat daftar.
    expect(daftar).not.toMatch(/setGalat\(e instanceof Error \? e\.message/);
  });

  it('TEST 20 — setelah pengajuan berhasil, kembali ke hub (tidak memaksa membuka daftar)', () => {
    expect(form).toMatch(/Pengajuan keluar anggota berhasil dibuat\.[\s\S]{0,400}navigation\.goBack\(\)/);
    expect(form).not.toContain("navigate('DaftarKeluarAnggota')");
  });

  it('TEST 31 — tidak ada SQL/mutasi langsung di ketiga layar', () => {
    for (const src of [tanpaKomentar(baca(HUB)), form, daftar]) {
      for (const terlarang of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'createJournal', 'getDb(', 'withTransaction(']) {
        expect(src).not.toContain(terlarang);
      }
    }
  });
});

describe('Keluar Anggota — rute', () => {
  const nav = tanpaKomentar(baca(NAV));

  it('TEST 1/2/3 — ketiga rute terdaftar TEPAT SEKALI', () => {
    for (const rute of ['KeluarAnggotaMenu', 'KeluarAnggotaForm', 'DaftarKeluarAnggota']) {
      expect(nav.match(new RegExp(`name="${rute}"`, 'g'))).toHaveLength(1);
    }
  });

  it('TEST 6 — ketiganya di TransaksiStack yang sama (tanpa nested navigator baru)', () => {
    for (const rute of ['KeluarAnggotaMenu', 'KeluarAnggotaForm', 'DaftarKeluarAnggota']) {
      expect(nav).toMatch(new RegExp(`<TransaksiStack\\.Screen name="${rute}"`));
    }
  });

  it('TEST 7/8 — judul tiap layar membuat jalur Back terbaca', () => {
    expect(nav).toMatch(/name="KeluarAnggotaMenu"[^/]*title: 'Keluar Anggota'/);
    expect(nav).toMatch(/name="KeluarAnggotaForm"[^/]*title: 'Pengajuan Keluar Anggota'/);
    expect(nav).toMatch(/name="DaftarKeluarAnggota"[^/]*title: 'Daftar Pengajuan'/);
  });

  it('menu Pengeluaran membuka HUB, bukan langsung form', () => {
    const pengeluaran = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
    expect(pengeluaran).toContain("nav.navigate('KeluarAnggotaMenu')");
    expect(pengeluaran).not.toContain("nav.navigate('KeluarAnggotaForm')");
    expect(pengeluaran).not.toContain("nav.navigate('DaftarKeluarAnggota')");
  });
});

// ===========================================================================
// 2. PERILAKU — alur status & keamanan akuntansi
// ===========================================================================

describe('Keluar Anggota — TEST 28: alur bisnis tetap utuh setelah layar dipecah', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-05',
      nominal: 100_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-06',
      nominal: 400_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
  });

  it('DIAJUKAN → DISETUJUI → DIBAYAR, dengan nilai dari service (bukan dihitung layar)', async () => {
    const preview = await previewKeluarAnggota(ANGGOTA_ID);
    expect(preview.totalHak).toBe(500_000);

    const { id } = await ajukanKeluarAnggota({
      anggotaId: ANGGOTA_ID, alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01', createdBy: USER_ID,
    });

    // Yang dibaca layar Daftar Pengajuan.
    let rows = await listKeluarAnggota();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, statusPengajuan: 'DIAJUKAN', namaAnggota: 'Budi Santoso' });
    expect(rows[0].nilaiPengembalian).toBe(preview.nilaiPengembalian);

    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    rows = await listKeluarAnggota();
    expect(rows[0].statusPengajuan).toBe('DISETUJUI');

    const hasil = await bayarKeluarAnggota({
      id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(hasil.journalId).toBeTruthy();
    rows = await listKeluarAnggota();
    expect(rows[0].statusPengajuan).toBe('DIBAYAR');
    expect(rows[0].journalId).toBe(hasil.journalId);
  });

  it('jalur TOLAK tetap tersedia dan final', async () => {
    const { id } = await ajukanKeluarAnggota({
      anggotaId: ANGGOTA_ID, alasanKeluar: 'DIBERHENTIKAN',
      tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01', createdBy: USER_ID,
    });
    await tolakKeluarAnggota(id, USER_ID);
    const rows = await listKeluarAnggota();
    expect(rows[0].statusPengajuan).toBe('DITOLAK');
    // Service tetap penegak: membayar pengajuan yang ditolak harus gagal.
    await expect(
      bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow();
  });

  it('TEST 27 — membaca daftar (navigasi antar layar) TIDAK membuat jurnal apa pun', async () => {
    await ajukanKeluarAnggota({
      anggotaId: ANGGOTA_ID, alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01', createdBy: USER_ID,
    });

    const sebelum = await potretAkuntansi(testDb);
    // Persis yang terjadi saat pengguna berpindah hub → daftar → hub →
    // daftar: layar daftar memuat ulang setiap kali difokuskan.
    for (let i = 0; i < 4; i++) {
      await listKeluarAnggota();
      await previewKeluarAnggota(ANGGOTA_ID);
    }
    expect(await potretAkuntansi(testDb)).toBe(sebelum); // byte-identik
  });

  it('TEST 29 — tanpa pengajuan, daftar kosong (memicu empty state, bukan error)', async () => {
    await expect(listKeluarAnggota()).resolves.toEqual([]);
  });

  it('label alasan bersama menerjemahkan seluruh nilai service', () => {
    expect(LABEL_ALASAN_KELUAR.MENGUNDURKAN_DIRI).toBe('Mengundurkan Diri');
    expect(LABEL_ALASAN_KELUAR.DIBERHENTIKAN).toBe('Diberhentikan');
    expect(LABEL_ALASAN_KELUAR.MENINGGAL).toBe('Meninggal');
    expect(LABEL_ALASAN_KELUAR.LAINNYA).toBe('Lainnya');
  });
});
