import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S75 — DETAIL PENGAJUAN KELUAR ANGGOTA.
 *
 * Dua lapis:
 *  1. PERILAKU (SQLite sungguhan) — fungsi baca detail, alur status,
 *     dan bukti bahwa membuka detail tidak menyentuh database.
 *  2. STRUKTURAL (audit sumber) — aksi hanya di detail, sumber
 *     pembayaran hanya pada konteks bayar, params ringan, rute tunggal.
 *
 * Renderer React Native tidak tersedia di Jest repo ini, jadi lapis (2)
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
  getKeluarAnggotaDetailById,
  listKeluarAnggota,
} from '@/services/KeluarAnggotaService';
import { setorSimpanan } from '@/services/SimpananService';
import { LABEL_STATUS_KELUAR, PENJELASAN_STATUS_KELUAR } from '@/screens/Transaksi/keluarAnggotaLabels';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const DETAIL = 'src/screens/Transaksi/KeluarAnggotaDetailScreen.tsx';
const DAFTAR = 'src/screens/Transaksi/DaftarKeluarAnggotaScreen.tsx';
const FORM = 'src/screens/Transaksi/KeluarAnggotaFormScreen.tsx';
const HUB = 'src/screens/Transaksi/KeluarAnggotaMenuScreen.tsx';
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
    ANGGOTA_ID, 'AGT-0001', '3201010101010001', 'Ahmad Fauzan', '2020-01-01', now, now
  );
  return db;
}

/** Potret seluruh tabel yang disebut gate akuntansi RC-S75. */
async function potret(db: TestDb) {
  return JSON.stringify({
    journal: await db.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    journal_entry: await db.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    keluar_anggota: await db.getAllAsync<any>(`SELECT * FROM keluar_anggota ORDER BY id`),
    simpanan_transaksi: await db.getAllAsync<any>(`SELECT * FROM simpanan_transaksi ORDER BY id`),
  });
}

async function buatPengajuan(): Promise<string> {
  const { id } = await ajukanKeluarAnggota({
    anggotaId: ANGGOTA_ID, alasanKeluar: 'MENGUNDURKAN_DIRI',
    tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01',
    keterangan: 'Pindah domisili', createdBy: USER_ID,
  });
  return id;
}

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

// ===========================================================================
// 1. SERVICE READ-ONLY (§T)
// ===========================================================================

describe('RC-S75 — getKeluarAnggotaDetailById (READ-ONLY)', () => {
  it('TEST 4 — membaca data berdasarkan ID, termasuk nomor anggota', async () => {
    const id = await buatPengajuan();
    const d = await getKeluarAnggotaDetailById(id);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({
      id,
      anggotaId: ANGGOTA_ID,
      namaAnggota: 'Ahmad Fauzan',
      nomorAnggota: 'AGT-0001',
      alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-02-01',
      keterangan: 'Pindah domisili',
      statusPengajuan: 'DIAJUKAN',
    });
  });

  it('ID tidak ditemukan / kosong -> null (empty state), bukan melempar', async () => {
    await expect(getKeluarAnggotaDetailById('tidak-ada')).resolves.toBeNull();
    await expect(getKeluarAnggotaDetailById('')).resolves.toBeNull();
  });

  it('konsisten dengan listKeluarAnggota() — nilai yang sama, bukan hitungan kedua', async () => {
    const id = await buatPengajuan();
    const dariList = (await listKeluarAnggota()).find((r) => r.id === id)!;
    const d = await getKeluarAnggotaDetailById(id);
    for (const k of [
      'saldoSimpananPokok', 'saldoSimpananWajib', 'saldoSimpananSukarela',
      'shuHakAnggota', 'totalHak', 'saldoPinjaman', 'kewajibanLain',
      'totalPengurang', 'nilaiPengembalian', 'statusPengajuan',
    ] as const) {
      expect((d as any)[k]).toEqual((dariList as any)[k]);
    }
  });

  it('TEST 11/12 — membaca detail 10x TIDAK mengubah satu baris pun', async () => {
    const id = await buatPengajuan();
    const sebelum = await potret(testDb);
    for (let i = 0; i < 10; i++) {
      await getKeluarAnggotaDetailById(id);
      await listKeluarAnggota();
    }
    expect(await potret(testDb)).toBe(sebelum); // byte-identical
  });
});

// ===========================================================================
// 2. ALUR STATUS (§X)
// ===========================================================================

describe('RC-S75 — alur status lewat service existing', () => {
  it('TEST 15 — DIAJUKAN → DISETUJUI → DIBAYAR; detail selalu menampilkan status aktual', async () => {
    const id = await buatPengajuan();
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DIAJUKAN');

    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DISETUJUI');

    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    const final = (await getKeluarAnggotaDetailById(id))!;
    expect(final.statusPengajuan).toBe('DIBAYAR');
    expect(final.journalId).toBe(hasil.journalId);
    expect(final.sumberPembayaran).toBe('KAS');
    expect(final.tanggalPembayaran).toBe('2026-02-03');
  });

  it('TEST 14 — pembayaran kedua DITOLAK service (double tap tidak menggandakan mutasi)', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const sesudahBayarPertama = await potret(testDb);
    await expect(
      bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow(/sudah dibayar/i);
    // Percobaan kedua tidak meninggalkan jejak apa pun.
    expect(await potret(testDb)).toBe(sesudahBayarPertama);
  });

  it('TEST 7/8 — status final: DITOLAK tidak dapat dibayar, DIBAYAR tidak dapat disetujui ulang', async () => {
    const ditolak = await buatPengajuan();
    await tolakKeluarAnggota(ditolak, USER_ID);
    await expect(
      bayarKeluarAnggota({ id: ditolak, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow();

    const dibayar = await buatPengajuan();
    await setujuiKeluarAnggota(dibayar, USER_ID, '2026-02-02');
    await bayarKeluarAnggota({ id: dibayar, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    await expect(setujuiKeluarAnggota(dibayar, USER_ID, '2026-02-04')).rejects.toThrow();
  });

  it('service tetap penegak: menyetujui yang sudah DISETUJUI ditolak', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    await expect(setujuiKeluarAnggota(id, USER_ID, '2026-02-03')).rejects.toThrow(/DIAJUKAN/);
  });

  it('label status & penjelasannya lengkap untuk keempat status', () => {
    for (const st of ['DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DIBAYAR'] as const) {
      expect(LABEL_STATUS_KELUAR[st]).toBeTruthy();
      expect(PENJELASAN_STATUS_KELUAR[st]).toBeTruthy();
    }
    expect(LABEL_STATUS_KELUAR.DIAJUKAN).toBe('Menunggu Persetujuan');
    expect(LABEL_STATUS_KELUAR.DIBAYAR).toBe('Selesai');
  });
});

// ===========================================================================
// 3. STRUKTURAL — layar & rute
// ===========================================================================

describe('RC-S75 — struktur layar Detail', () => {
  const detail = tanpaKomentar(baca(DETAIL));

  it('TEST 5 — DIAJUKAN: Setujui & Tolak ada, Bayar TIDAK', () => {
    const blok = detail.slice(
      detail.indexOf("{row.statusPengajuan === 'DIAJUKAN' && ("),
      detail.indexOf("{row.statusPengajuan === 'DISETUJUI' && (")
    );
    expect(blok).toContain('onPress={setujui}');
    expect(blok).toContain('onPress={tolak}');
    expect(blok).not.toContain('onPress={bayar}');
    expect(blok).not.toContain('RekeningPicker');
  });

  it('TEST 6 — DISETUJUI: Bayar & Sumber Pembayaran ada, Setujui/Tolak TIDAK', () => {
    const blok = detail.slice(
      detail.indexOf("{row.statusPengajuan === 'DISETUJUI' && ("),
      detail.indexOf("{row.statusPengajuan === 'DIBAYAR' && (\n        <View style={styles.final}>")
    );
    expect(blok).toContain('onPress={bayar}');
    expect(blok).toContain('Sumber Pembayaran');
    expect(blok).toContain('<RekeningPicker');
    expect(blok).not.toContain('onPress={setujui}');
    expect(blok).not.toContain('onPress={tolak}');
  });

  it('TEST 7/8 — DITOLAK & DIBAYAR tidak punya satu pun tombol mutasi', () => {
    for (const st of ['DITOLAK', 'DIBAYAR']) {
      const i = detail.indexOf(`{row.statusPengajuan === '${st}' && (\n        <View style={styles.final}>`);
      expect(i).toBeGreaterThan(0);
      const blok = detail.slice(i, detail.indexOf(') : null}\n', i) > 0 ? i + 700 : i + 700);
      expect(blok).not.toMatch(/onPress=\{(setujui|tolak|bayar)\}/);
    }
  });

  it('§I — Sumber Pembayaran HANYA di detail, dan hanya pada cabang DISETUJUI', () => {
    expect(detail.match(/Sumber Pembayaran/g)).toHaveLength(1);
    const iDisetujui = detail.indexOf("{row.statusPengajuan === 'DISETUJUI' && (");
    expect(detail.indexOf('Sumber Pembayaran')).toBeGreaterThan(iDisetujui);
    // Tidak muncul di hub, form, maupun daftar.
    for (const rel of [HUB, FORM, DAFTAR]) {
      expect(tanpaKomentar(baca(rel))).not.toContain('Sumber Pembayaran');
    }
  });

  it('TEST 13 — mutasi hanya lewat service; tidak ada SQL/jurnal di layar', () => {
    for (const wajib of ['setujuiKeluarAnggota(', 'tolakKeluarAnggota(', 'bayarKeluarAnggota(']) {
      expect(detail).toContain(wajib);
    }
    for (const terlarang of ['createJournal', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'getDb(', 'withTransaction(']) {
      expect(detail).not.toContain(terlarang);
    }
    // Tidak menghitung ulang accounting di UI.
    expect(detail).not.toMatch(/totalHak =|nilaiPengembalian =|totalPengurang =/);
  });

  it('TEST 14 — setiap mutasi dipagari `sibuk`: tombol disabled & guard di helper', () => {
    expect(detail).toMatch(/if \(sibuk\) return;/);
    expect(detail).toMatch(/setSibuk\(true\);/);
    expect(detail.match(/disabled=\{sibuk\}/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('§H/§I — setiap mutasi didahului konfirmasi, Tolak bersifat destructive', () => {
    expect(detail).toContain("Alert.alert(\n      'Setujui Pengajuan?'");
    expect(detail).toContain("Alert.alert('Tolak Pengajuan?'");
    expect(detail).toContain("'Bayar Pengajuan Keluar Anggota?'");
    expect(detail).toContain("style: 'destructive'");
  });

  it('TEST 15 — setiap mutasi berhasil diikuti pembacaan ulang', () => {
    expect(detail).toMatch(/await kerja\(\);\s*await muat\(\);/);
    expect(detail).toContain('useFocusRefresh(muat, [muat]);');
    expect(detail).not.toMatch(/setInterval|setTimeout/);
  });

  it('§O — loading, error, dan not-found state ada; tanpa nominal palsu & tanpa error mentah', () => {
    expect(detail).toContain('Memuat detail pengajuan…');
    expect(detail).toContain('Detail pengajuan tidak dapat dimuat.');
    expect(detail).toContain('Pengajuan tidak ditemukan.');
    // Nominal di BODY hanya dirender setelah `row` dipastikan ada:
    // ketiga early-return (memuat/galat/tidak ditemukan) mendahului JSX
    // utama. (Kemunculan `formatRupiah` lebih awal ada di dalam handler
    // `bayar()`, yang baru berjalan ketika `row` sudah terisi.)
    const iReturn = detail.indexOf('if (tidakDitemukan || !row) {');
    expect(iReturn).toBeGreaterThan(0);
    expect(detail.indexOf('<ScrollView style={styles.container}')).toBeGreaterThan(iReturn);
    expect(detail.indexOf('styles.heroNominal')).toBeGreaterThan(iReturn);
    expect(detail).not.toMatch(/setGalat\(e instanceof Error \? e\.message/);
  });

  it('§E — detail tidak memamerkan field teknis database', () => {
    // Yang dilarang adalah MERENDER id teknis sebagai teks. RC-S76
    // memakai `{row.journalId ? …}` sebagai GUARD untuk memutuskan
    // apakah CTA bukti ditampilkan — itu bukan menampilkan idnya.
    for (const teknis of ['row.journalId', 'row.diajukanOleh', 'row.disetujuiOleh', 'row.id']) {
      expect(detail).not.toMatch(new RegExp(`<Text[^>]*>\\{${teknis.replace('.', '\\.')}`));
      expect(detail).not.toContain(`nilai={${teknis}}`);
    }
    // Nomor bukti yang dirender berasal dari read-model bukti, bukan id jurnal.
    expect(detail).toContain('nilai={bukti?.nomorBukti ?? \'-\'}');
  });

  it('§K — label alasan & status dari modul bersama, tidak disalin ulang', () => {
    expect(detail).toContain("from '@/screens/Transaksi/keluarAnggotaLabels'");
    expect(detail).not.toMatch(/MENGUNDURKAN_DIRI: 'Mengundurkan Diri'/);
    expect(detail).not.toMatch(/DIAJUKAN: 'Menunggu Persetujuan'/);
  });
});

describe('RC-S75 — daftar hanya monitoring + navigasi', () => {
  const daftar = tanpaKomentar(baca(DAFTAR));

  it('TEST 9 — daftar TIDAK memanggil satu pun fungsi mutasi', () => {
    for (const terlarang of [
      'setujuiKeluarAnggota', 'tolakKeluarAnggota', 'bayarKeluarAnggota',
      'ajukanKeluarAnggota', 'RekeningPicker',
    ]) {
      expect(daftar).not.toContain(terlarang);
    }
  });

  it('TEST 2/3 — seluruh kartu dapat ditekan, mengirim HANYA keluarAnggotaId', () => {
    expect(daftar).toContain("navigation.navigate('KeluarAnggotaDetail', { keluarAnggotaId: row.id })");
    expect(daftar).toMatch(/<Pressable[\s\S]{0,400}onPress=\{\(\) => navigation\.navigate\('KeluarAnggotaDetail'/);
    // Objek pengajuan TIDAK ikut params.
    expect(daftar).not.toMatch(/KeluarAnggotaDetail', \{ row|pengajuan: row|\.\.\.row/);
  });

  it('§E/§R — kartu punya hierarchy, chevron, press state, dan label aksesibilitas; tanpa nested button', () => {
    expect(daftar).toContain('{row.namaAnggota}');
    expect(daftar).toContain('LABEL_ALASAN_KELUAR[row.alasanKeluar]');
    expect(daftar).toContain('{row.tanggalPengajuan}');
    expect(daftar).toContain('formatRupiah(row.nilaiPengembalian)');
    expect(daftar).toContain('LABEL_STATUS_KELUAR[row.statusPengajuan]');
    expect(daftar).toContain('name="chevron-forward"');
    expect(daftar).toContain('pressed && styles.barisDitekan');
    expect(daftar).toContain('accessibilityRole="button"');
    // Tidak ada TouchableOpacity di dalam kartu yang bersaing dengan tap.
    const kartu = daftar.slice(daftar.indexOf('<Pressable'), daftar.indexOf('</Pressable>'));
    expect(kartu).not.toContain('TouchableOpacity');
  });

  it('§E — daftar tidak menampilkan field teknis database', () => {
    for (const teknis of ['journalId', 'diajukanOleh', 'disetujuiOleh', 'created_by']) {
      expect(daftar).not.toContain(teknis);
    }
  });

  it('§E — filter tetap presentasi saja (satu pembacaan, tanpa query per chip)', () => {
    expect(daftar.match(/listKeluarAnggota\(\)/g)).toHaveLength(1);
    expect(daftar).toMatch(/daftar\.filter\(\(r\) => r\.statusPengajuan === filter\)/);
  });
});

describe('RC-S75 — rute', () => {
  const nav = tanpaKomentar(baca(NAV));

  it('TEST 17 — KeluarAnggotaDetail terdaftar tepat sekali, di stack yang sama, bukan orphan', () => {
    expect(nav.match(/name="KeluarAnggotaDetail"/g)).toHaveLength(1);
    expect(nav).toMatch(/<TransaksiStack\.Screen name="KeluarAnggotaDetail"/);
    // Jalan masuk nyata dari daftar, ditulis literal agar terbaca
    // pemindai keterjangkauan rute proyek.
    expect(tanpaKomentar(baca(DAFTAR))).toContain("navigate('KeluarAnggotaDetail'");
  });

  it('TEST 16 — keempat rute Keluar Anggota hidup di TransaksiStack yang sama', () => {
    for (const r of ['KeluarAnggotaMenu', 'KeluarAnggotaForm', 'DaftarKeluarAnggota', 'KeluarAnggotaDetail']) {
      expect(nav.match(new RegExp(`name="${r}"`, 'g'))).toHaveLength(1);
      expect(nav).toMatch(new RegExp(`<TransaksiStack\\.Screen name="${r}"`));
    }
  });

  it('TEST 10 — form tetap hanya untuk pengajuan', () => {
    const form = tanpaKomentar(baca(FORM));
    expect(form).toContain('ajukanKeluarAnggota(');
    expect(form).toContain('previewKeluarAnggota(');
    for (const terlarang of [
      'listKeluarAnggota', 'setujuiKeluarAnggota', 'tolakKeluarAnggota',
      'bayarKeluarAnggota', 'getKeluarAnggotaDetailById', 'RekeningPicker',
    ]) {
      expect(form).not.toContain(terlarang);
    }
  });

  it('TEST 1 — hub tetap tepat dua aksi utama, tanpa menu ketiga', () => {
    const hub = tanpaKomentar(baca(HUB));
    const judul = Array.from(hub.matchAll(/judul: '([^']+)'/g)).map((m) => m[1]);
    expect(judul).toEqual(['Pengajuan', 'Daftar Pengajuan']);
    expect(hub).not.toContain('KeluarAnggotaDetail');
  });
});

// ===========================================================================
// 4. GATE AKUNTANSI (§X)
// ===========================================================================

describe('RC-S75 — gate akuntansi', () => {
  it('membuka hub → daftar → detail → kembali → detail berulang: keempat tabel byte-identical', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');

    const sebelum = await potret(testDb);
    // Hub tidak membaca apa pun; daftar & detail dibaca berulang kali
    // seperti saat pengguna bolak-balik.
    for (let i = 0; i < 5; i++) {
      await listKeluarAnggota();
      await getKeluarAnggotaDetailById(id);
    }
    expect(await potret(testDb)).toBe(sebelum);
  });

  it('nilai accounting alur DIAJUKAN→DISETUJUI→DIBAYAR tidak berubah oleh RC ini', async () => {
    const id = await buatPengajuan();
    const awal = (await getKeluarAnggotaDetailById(id))!;
    expect(awal.totalHak).toBe(500_000);
    expect(awal.totalPengurang).toBe(0);
    expect(awal.nilaiPengembalian).toBe(500_000);

    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    expect(hasil.nilaiPengembalian).toBe(500_000);

    // Jurnal memang terbentuk — oleh service, bukan layar.
    const entries = await testDb.getAllAsync<any>(
      `SELECT * FROM journal_entry WHERE journal_id = ?`, hasil.journalId
    );
    expect(entries.length).toBeGreaterThan(0);
    const debit = entries.reduce((a, e) => a + (e.debit ?? 0), 0);
    const kredit = entries.reduce((a, e) => a + (e.kredit ?? 0), 0);
    expect(debit).toBe(kredit); // tetap seimbang
  });
});
