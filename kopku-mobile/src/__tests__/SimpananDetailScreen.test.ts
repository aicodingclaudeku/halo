import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * FITUR DETAIL SIMPANAN — READ-ONLY + NAVIGATION.
 *
 * Dua lapis pengujian:
 *
 *  1. PERILAKU (SQLite sungguhan, tanpa mock service): membaca transaksi
 *     SETOR/TARIK/KOREKSI lewat `getSimpananDetailById()`, saldo lewat
 *     `getRingkasanSaldoSimpananAnggota()`, dan memverifikasi bahwa
 *     membuka detail TIDAK mengubah satu baris pun di database.
 *
 *  2. STRUKTURAL (audit sumber): layar detail tidak mengimpor satu pun
 *     fungsi mutasi/jurnal, baris daftar benar-benar pressable, dan rute
 *     `SimpananDetail` terdaftar tepat sekali di stack yang sama dengan
 *     pemanggilnya.
 *
 * Renderer React Native tidak tersedia di Jest repo ini, jadi lapis (2)
 * memeriksa sumber layar — konvensi yang sama dengan test-test UI lain
 * di proyek ini (mis. `KewajibanRcS74.test.ts`).
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
  setorSimpanan,
  tarikSimpananSukarela,
  koreksiSimpanan,
  getSimpananDetailById,
  getRingkasanSaldoSimpananAnggota,
  getSaldoSimpanan,
} from '@/services/SimpananService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ACC = { kas: 'acc-kas', pokok: 'acc-pokok', wajib: 'acc-wajib', sukarela: 'acc-sukarela' };
const ANGGOTA_ID = 'anggota-1';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.pokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.wajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.pokok);
  await seedMapping(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.wajib);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('period-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'AGT-0001', '1234567890123456', 'Budi Santoso', '2020-01-01', now, now
  );
  return db;
}

/** Potret seluruh isi tabel yang relevan — untuk membuktikan detail tidak menulis apa pun. */
async function potretDatabase(db: TestDb) {
  const simpanan = await db.getAllAsync<any>(`SELECT * FROM simpanan_transaksi ORDER BY id`);
  const journal = await db.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`);
  const journalEntry = await db.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`);
  return JSON.stringify({ simpanan, journal, journalEntry });
}

beforeEach(async () => {
  testDb = await seedFixture();
});

// ===========================================================================
// 1. PERILAKU — membaca transaksi & saldo
// ===========================================================================

describe('Detail Simpanan — pembacaan transaksi (SQLite sungguhan)', () => {
  it('TEST 3 — transaksi SETOR terbaca lengkap: nominal, jenis, tipe, nomor, sumber dana, periode, keterangan', async () => {
    const { id, nomorTransaksi } = await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-09-23', periode: '2026-09',
      nominal: 500_000, sumberDana: 'KAS', keterangan: 'Setoran wajib September', createdBy: 'user-1',
    });

    const detail = await getSimpananDetailById(id);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id,
      anggotaId: ANGGOTA_ID,
      jenis: 'WAJIB',
      tipe: 'SETOR',
      tanggal: '2026-09-23',
      periode: '2026-09',
      nominal: 500_000,
      sumberDana: 'KAS',
      nomorTransaksi,
      keterangan: 'Setoran wajib September',
    });
    // TEST 7 — identitas anggota ikut terbaca (lewat JOIN, bukan params).
    expect(detail!.namaAnggota).toBe('Budi Santoso');
    expect(detail!.nomorAnggota).toBe('AGT-0001');
    // Transaksi ini belum dikoreksi.
    expect(detail!.reversalOfId).toBeNull();
    expect(detail!.dikoreksiOlehNomorTransaksi).toBeNull();
    expect(detail!.koreksiDariNomorTransaksi).toBeNull();
    // Jurnal memang ada, tetapi ini data audit — layar tidak menampilkannya.
    expect(detail!.journalId).not.toBeNull();
  });

  it('TEST 4 — transaksi TARIK terbaca dengan tipe TARIK (arah ditentukan tipe, bukan tanda nominal tersimpan)', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-02-01',
      nominal: 900_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    const { id } = await tarikSimpananSukarela({
      anggotaId: ANGGOTA_ID, tanggal: '2026-03-01', nominal: 400_000, sumberDana: 'KAS', createdBy: 'user-1',
    });

    const detail = await getSimpananDetailById(id);
    expect(detail).toMatchObject({ jenis: 'SUKARELA', tipe: 'TARIK', nominal: 400_000 });
    // Nominal DISIMPAN positif; arah "-" murni presentasi dari `tipe`.
    expect(detail!.nominal).toBeGreaterThan(0);
  });

  it('TEST 5 / TEST 13 — KOREKSI dan transaksi aslinya saling menunjuk; histori KEDUANYA tetap ada (tidak dihapus)', async () => {
    const asli = await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-04-01', periode: '2026-04',
      nominal: 300_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    const koreksi = await koreksiSimpanan(asli.id, 'user-1', 'Salah nominal');

    // Sisi KOREKSI: menunjuk ke nomor transaksi asli.
    const detailKoreksi = await getSimpananDetailById(koreksi.id);
    expect(detailKoreksi).toMatchObject({ tipe: 'KOREKSI', reversalOfId: asli.id });
    expect(detailKoreksi!.koreksiDariNomorTransaksi).toBe(asli.nomorTransaksi);
    expect(detailKoreksi!.keterangan).toBe('Salah nominal');

    // Sisi ASLI: ditandai sudah dikoreksi, dengan nomor koreksinya.
    const detailAsli = await getSimpananDetailById(asli.id);
    expect(detailAsli).not.toBeNull(); // histori TIDAK dihapus
    expect(detailAsli!.tipe).toBe('SETOR');
    expect(detailAsli!.dikoreksiOlehNomorTransaksi).toBe(`KOREKSI-${asli.nomorTransaksi}`);

    // Konsisten dengan saldo: transaksi yang sudah dikoreksi memang dikecualikan.
    expect(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'WAJIB')).toBe(0);
  });

  it('TEST 12 — id tidak dikenal / kosong menghasilkan null (empty state), BUKAN crash', async () => {
    await expect(getSimpananDetailById('tidak-ada')).resolves.toBeNull();
    await expect(getSimpananDetailById('')).resolves.toBeNull();
  });

  it('anggota terhapus: transaksi tetap dapat dibuka, identitas null (layar menampilkan "Data anggota tidak ditemukan.")', async () => {
    const { id } = await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-05',
      nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1',
    });
    // LEFT JOIN (bukan INNER) — inilah yang membuat kasus ini tidak hilang.
    // FK dimatikan SEMENTARA hanya untuk membuat kondisi data yang tidak
    // bisa dibuat lewat jalur normal (FK produksi memang melarangnya);
    // yang diuji adalah ketahanan PEMBACAAN, bukan cara datanya muncul.
    await testDb.execAsync('PRAGMA foreign_keys = OFF');
    await testDb.runAsync(`DELETE FROM anggota WHERE id = ?`, ANGGOTA_ID);
    await testDb.execAsync('PRAGMA foreign_keys = ON');

    const detail = await getSimpananDetailById(id);
    expect(detail).not.toBeNull();
    expect(detail!.nominal).toBe(100_000);
    expect(detail!.namaAnggota).toBeNull();
    expect(detail!.nomorAnggota).toBeNull();
  });
});

describe('Detail Simpanan — ringkasan saldo', () => {
  it('TEST 10 / TEST 11 — saldo per jenis identik dengan getSaldoSimpanan; total = pokok+wajib+sukarela TANPA Simpanan Berjangka', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-05', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-06', periode: '2026-01', nominal: 250_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-07', nominal: 700_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const ringkasan = await getRingkasanSaldoSimpananAnggota(ANGGOTA_ID);
    expect(ringkasan).toEqual({ pokok: 100_000, wajib: 250_000, sukarela: 700_000, total: 1_050_000 });

    // Sumbernya benar-benar getSaldoSimpanan yang sama dengan aplikasi.
    expect(ringkasan.pokok).toBe(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'POKOK'));
    expect(ringkasan.wajib).toBe(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'WAJIB'));
    expect(ringkasan.sukarela).toBe(await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA'));
    expect(ringkasan.total).toBe(ringkasan.pokok + ringkasan.wajib + ringkasan.sukarela);
  });

  it('saldo mengecualikan transaksi yang sudah dikoreksi (konsisten dengan seluruh aplikasi)', async () => {
    const a = await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-05-01', periode: '2026-05', nominal: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-06-01', periode: '2026-06', nominal: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect((await getRingkasanSaldoSimpananAnggota(ANGGOTA_ID)).wajib).toBe(500_000);

    await koreksiSimpanan(a.id, 'user-1', 'Dobel input');
    expect((await getRingkasanSaldoSimpananAnggota(ANGGOTA_ID)).wajib).toBe(300_000);
  });

  it('anggota tanpa transaksi: semua nol, bukan undefined/NaN', async () => {
    const r = await getRingkasanSaldoSimpananAnggota(ANGGOTA_ID);
    expect(r).toEqual({ pokok: 0, wajib: 0, sukarela: 0, total: 0 });
    expect(Number.isNaN(r.total)).toBe(false);
  });
});

// ===========================================================================
// 2. READ-ONLY — membuka detail tidak menulis apa pun
// ===========================================================================

describe('Detail Simpanan — TEST 14/15: READ-ONLY', () => {
  it('membaca detail + saldo TIDAK mengubah satu baris pun di simpanan_transaksi / journal / journal_entry', async () => {
    const { id } = await setorSimpanan({
      anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-07-01', periode: '2026-07',
      nominal: 450_000, sumberDana: 'KAS', createdBy: 'user-1',
    });

    const sebelum = await potretDatabase(testDb);
    // Persis yang dilakukan layar saat dibuka, lalu diulang (focus refresh).
    for (let i = 0; i < 3; i++) {
      await getSimpananDetailById(id);
      await getRingkasanSaldoSimpananAnggota(ANGGOTA_ID);
    }
    const sesudah = await potretDatabase(testDb);

    expect(sesudah).toBe(sebelum); // byte-identik: tidak ada transaksi/jurnal baru
  });
});

// ===========================================================================
// 3. STRUKTURAL — sumber layar, baris pressable, rute
// ===========================================================================

describe('Detail Simpanan — struktur layar & navigasi', () => {
  const detail = tanpaKomentar(baca('src/screens/Simpanan/SimpananDetailScreen.tsx'));
  const histori = tanpaKomentar(baca('src/screens/Simpanan/SimpananHistoriScreen.tsx'));
  const navigator = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));

  it('TEST 23 — layar detail TIDAK mengimpor satu pun fungsi mutasi/jurnal', () => {
    for (const terlarang of [
      'createJournal', 'reverseJournal', 'setorSimpanan',
      'tarikSimpananSukarela', 'koreksiSimpanan', 'keluarAnggota', 'catatDataAwalSimpanan',
    ]) {
      expect(detail).not.toContain(terlarang);
    }
    // Tidak menyentuh database langsung, dan tidak ada tombol mutasi.
    expect(detail).not.toMatch(/@\/database\/db|withTransaction|runAsync|INSERT|UPDATE|DELETE/);
    expect(detail).not.toMatch(/Hapus|Batalkan Transaksi|Edit Transaksi/);
  });

  it('layar detail hanya memakai dua fungsi service READ-ONLY, dan memformat lewat helper aplikasi', () => {
    expect(detail).toMatch(/import \{[\s\S]*?getSimpananDetailById[\s\S]*?getRingkasanSaldoSimpananAnggota[\s\S]*?\} from '@\/services\/SimpananService';/);
    // TEST 6 — nominal SELALU lewat formatRupiah, tidak pernah dirakit manual.
    expect(detail).toContain("import { formatRupiah } from '@/utils/money';");
    expect(detail).not.toMatch(/toLocaleString|toFixed\(|'Rp' \+|`Rp\$\{/);
    // TEST 14 (tanggal) — helper tanggal aplikasi, bukan toLocaleDateString ad hoc.
    expect(detail).toContain("import { formatTanggalIndonesia } from '@/utils/reportPeriod';");
    expect(detail).not.toContain('toLocaleDateString');
  });

  it('TEST 17 (refresh) — memakai useFocusRefresh, TANPA polling/interval', () => {
    expect(detail).toContain("import { useFocusRefresh } from '@/hooks/useFocusRefresh';");
    expect(detail).toContain('useFocusRefresh(load, [load]);');
    expect(detail).not.toMatch(/setInterval|setTimeout/);
  });

  it('TEST 8/9 — mapping label: jenis dan tipe tidak pernah ditampilkan sebagai nilai mentah', () => {
    // RC-S111: pemetaannya TIDAK LAGI disalin di layar ini. Layar
    // Detail, Histori, dan Form dulu masing-masing menulis pemetaan
    // enum simpanan sendiri; salinan seperti itu cepat atau lambat
    // berbeda dari aslinya. Sekarang satu sumber:
    // `@/reports/TampilanAnggotaPlan`, yang labelnya diuji langsung
    // (bukan lewat teks sumber) di TampilanAnggotaSimpananRcS111.
    // Kontrak yang dijaga di sini tetap sama — layar ini WAJIB
    // memetakan enum ke label, bukan merender nilai mentahnya.
    expect(detail).toContain("from '@/reports/TampilanAnggotaPlan'");
    expect(detail).toContain("labelJenisSimpanan('POKOK')");
    expect(detail).toContain("labelJenisSimpanan('WAJIB')");
    expect(detail).toContain("labelJenisSimpanan('SUKARELA')");
    expect(detail).toContain('LABEL_TIPE_SIMPANAN');
    // Sisi kebalikannya: nilai mentah tidak boleh dirender langsung.
    expect(detail).not.toMatch(/\{row\.jenis\}|\{row\.tipe\}/);
  });

  it('TEST 16/16b — loading, error, dan empty state ada; error SQL mentah tidak pernah ditampilkan', () => {
    expect(detail).toContain('Memuat detail simpanan…');
    expect(detail).toContain('Gagal memuat detail simpanan.');
    expect(detail).toContain('Data simpanan tidak ditemukan.');
    expect(detail).toContain('Data anggota tidak ditemukan.');
    // Pesan exception TIDAK diteruskan ke UI (berbeda dari `e.message` di layar lain).
    expect(detail).not.toMatch(/setError\(e instanceof Error \? e\.message/);
    // Tidak ada tombol back lokal — header native stack yang menanganinya.
    expect(detail).not.toMatch(/navigation\.goBack|Kembali/);
  });

  it('TEST 1/2 — baris histori pressable dan menavigasi ke SimpananDetail dengan param simpananId saja', () => {
    expect(histori).toContain("navigation.navigate('SimpananDetail', { simpananId: item.id })");
    // Objek transaksi TIDAK dikirim lewat params (anti stale data).
    expect(histori).not.toMatch(/navigate\('SimpananDetail', \{ item|simpanan: item|\.\.\.item/);
    // Baris benar-benar komponen pressable, bukan <View> pasif.
    expect(histori).toMatch(/<Pressable[\s\S]*?onPress=\{\(\) => navigation\.navigate\('SimpananDetail'/);
    expect(histori).toContain("import { View, Text, FlatList, ActivityIndicator, StyleSheet, TouchableOpacity, Pressable, Modal } from 'react-native';");
  });

  it('TEST 20 — baris punya accessibilityRole button + label yang bermakna, dan chevron sebagai penanda visual', () => {
    const blokRow = histori.slice(histori.indexOf('<Pressable'), histori.indexOf('</Pressable>'));
    expect(blokRow).toContain('accessibilityRole="button"');
    expect(blokRow).toMatch(/accessibilityLabel=\{`Lihat detail simpanan .*\}/);
    expect(blokRow).toContain('name="chevron-forward-outline"');
    // Umpan balik tekan yang halus.
    expect(histori).toContain('pressed && styles.rowPressed');
  });

  it('TEST 18 — baris tetap menampilkan seluruh informasi existing (nama, jenis·tipe·tanggal, nomor, nominal bertanda)', () => {
    const blokRow = histori.slice(histori.indexOf('<Pressable'), histori.indexOf('</Pressable>'));
    expect(blokRow).toContain('{item.namaAnggota}');
    // RC-S111: keempat informasi ini TETAP ada, tetapi tata letaknya
    // berubah — jenis & tipe kini berlabel manusiawi ("Sukarela",
    // "Penarikan") dan tanggal turun ke baris nomor transaksi,
    // supaya baris kedua tidak memuat empat potongan sekaligus.
    expect(blokRow).toContain('Simpanan {labelJenisSimpanan(item.jenis)} · {labelTipeSimpanan(item.tipe)}');
    expect(blokRow).toContain('{item.nomorTransaksi} · {item.tanggal}');
    expect(blokRow).toContain('{formatRupiah(item.nominal)}');
    // Warna merah untuk penarikan tetap ada, tetapi keputusannya kini
    // datang dari `nadaTipeSimpanan` — bukan `tipe === 'TARIK'` yang
    // diulang di layar. Lihat RcS111: rumus lama juga memberi tanda
    // '+' pada KOREKSI yang sebenarnya bisa mengurangi saldo.
    expect(blokRow).toContain("nada === 'keluar' && styles.nominalTarik");
    // Tandanya dihitung tepat di atas <Pressable>, jadi diperiksa pada
    // berkas penuh, bukan pada potongan baris.
    expect(histori).toContain('tandaTipeSimpanan(item.tipe)');
  });

  it('layar histori tidak kehilangan fitur existing (tab, export, FAB, loading, empty)', () => {
    for (const bagian of [
      "{ value: 'POKOK', label: 'Pokok' }",
      "{ value: 'WAJIB', label: 'Wajib' }",
      "{ value: 'SUKARELA', label: 'Sukarela' }",
      'headerRight',
      // RC-S111: satu kalimat dipecah jadi judul + arahan, supaya
      // layar kosong ikut memberi tahu APA yang harus dilakukan.
      'Belum ada transaksi simpanan',
      'untuk mencatat setoran simpanan',
      "navigation.navigate('SimpananForm')",
      'Export Simpanan',
    ]) {
      expect(histori).toContain(bagian);
    }
  });

  it('TEST 17 (rute) — SimpananDetail terdaftar TEPAT SEKALI, di TransaksiStack yang sama dengan SimpananHistori', () => {
    expect(navigator.match(/name="SimpananDetail"/g)).toHaveLength(1);
    expect(navigator).toMatch(/<TransaksiStack\.Screen\s+name="SimpananDetail"\s+component=\{SimpananDetailScreen\}\s+options=\{\{ title: 'Detail Simpanan' \}\}\s*\/>/);
    // Pemanggilnya (SimpananHistori) memang di stack yang sama.
    expect(navigator).toMatch(/<TransaksiStack\.Screen name="SimpananHistori"/);
    // Bukan Detail Anggota yang dipakai sebagai detail transaksi.
    expect(navigator.match(/name="SimpananDetail"[\s\S]{0,200}?component=\{AnggotaDetailScreen\}/)).toBeNull();
  });
});

// ===========================================================================
// 4. GUARD — accounting/schema tidak tersentuh oleh fitur ini
// ===========================================================================

describe('Detail Simpanan — guard: tidak menyentuh accounting/schema', () => {
  it('service hanya MENAMBAH fungsi baca; koreksiSimpanan & getSaldoSimpanan tidak berubah semantics', () => {
    const service = baca('src/services/SimpananService.ts');
    // Klausa exclusion koreksi tetap satu-satunya definisi, tidak diduplikasi.
    expect(service.match(/const SIMPANAN_TIDAK_DIKOREKSI_CLAUSE = /g)).toHaveLength(1);
    // Fungsi baru memang READ-ONLY: tidak ada INSERT/UPDATE/DELETE di dalamnya.
    const awal = service.indexOf('export async function getSimpananDetailById');
    const akhir = service.indexOf('export async function koreksiSimpanan');
    const blokBaru = service.slice(awal, akhir);
    expect(blokBaru).toMatch(/SELECT/);
    expect(blokBaru).not.toMatch(/INSERT|UPDATE |DELETE FROM|reverseJournal|createJournal|withTransaction/);
  });

  it('TEST 24 — tidak ada perubahan schema/migration untuk fitur ini', () => {
    const schema = baca('src/database/schema.ts');
    // Kolom yang dibaca detail semuanya SUDAH ada sejak sebelumnya.
    for (const kolom of ['periode', 'sumber_dana', 'bank_account_id', 'journal_id', 'reversal_of_id', 'created_by']) {
      expect(schema).toContain(kolom);
    }
    // Layar & fungsi baru tidak menyentuh versi schema.
    expect(tanpaKomentar(baca('src/screens/Simpanan/SimpananDetailScreen.tsx'))).not.toMatch(/SCHEMA_VERSION|migrat/i);
  });
});
