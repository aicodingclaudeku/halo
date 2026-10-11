import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S76 — STATE MACHINE LOCK + TRACEABILITY BUKTI KELUAR ANGGOTA.
 *
 * Dua lapis:
 *  1. PERILAKU (SQLite sungguhan) — seluruh transisi status diuji satu
 *     per satu, dan tautan dua arah pengajuan ↔ bukti dibuktikan lewat
 *     id authoritative (`journal.sumber_id`), bukan pencocokan
 *     nama/tanggal/nominal.
 *  2. STRUKTURAL (audit sumber) — CTA lintas tab memakai tab induk,
 *     hanya muncul pada kondisi yang sah, dan tidak ada layar yang
 *     melakukan mutasi akuntansi.
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
} from '@/services/KeluarAnggotaService';
import {
  listBuktiKeluarAnggota,
  getBuktiKeluarAnggotaById,
} from '@/services/BuktiTransaksiService';
import { setorSimpanan } from '@/services/SimpananService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const DETAIL_KELUAR = 'src/screens/Transaksi/KeluarAnggotaDetailScreen.tsx';
const DETAIL_BUKTI = 'src/screens/Laporan/BuktiTransaksiDetailScreen.tsx';
const LIST_BUKTI = 'src/screens/Laporan/BuktiTransaksiListScreen.tsx';
const DAFTAR_KELUAR = 'src/screens/Transaksi/DaftarKeluarAnggotaScreen.tsx';
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

async function potret(db: TestDb) {
  return JSON.stringify({
    journal: await db.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    journal_entry: await db.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    keluar_anggota: await db.getAllAsync<any>(`SELECT * FROM keluar_anggota ORDER BY id`),
    simpanan_transaksi: await db.getAllAsync<any>(`SELECT * FROM simpanan_transaksi ORDER BY id`),
  });
}

async function buatPengajuan(tanggal = '2026-02-01'): Promise<string> {
  const { id } = await ajukanKeluarAnggota({
    anggotaId: ANGGOTA_ID, alasanKeluar: 'MENGUNDURKAN_DIRI',
    tanggalPengajuan: tanggal, tanggalEfektifKeluar: tanggal, createdBy: USER_ID,
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
// 1. STATE MACHINE (§4)
// ===========================================================================

describe('RC-S76 — state machine terkunci', () => {
  it('TEST 1 — DIAJUKAN → DISETUJUI: PASS', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DISETUJUI');
  });

  it('TEST 2 — DIAJUKAN → DITOLAK: PASS', async () => {
    const id = await buatPengajuan();
    await tolakKeluarAnggota(id, USER_ID);
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DITOLAK');
  });

  it('TEST 3 — DISETUJUI → DITOLAK: DITOLAK SERVICE (kebijakan RC-S76)', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');

    const sebelum = await potret(testDb);
    await expect(tolakKeluarAnggota(id, USER_ID)).rejects.toThrow(
      'Pengajuan yang sudah disetujui tidak dapat ditolak.'
    );
    // Transisi yang ditolak TIDAK meninggalkan efek samping apa pun.
    expect(await potret(testDb)).toBe(sebelum);
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DISETUJUI');
  });

  it('TEST 4 — DISETUJUI → DIBAYAR: PASS', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    expect(hasil.journalId).toBeTruthy();
    expect((await getKeluarAnggotaDetailById(id))!.statusPengajuan).toBe('DIBAYAR');
  });

  it('TEST 5 — DITOLAK → DIBAYAR: DITOLAK, tanpa efek samping', async () => {
    const id = await buatPengajuan();
    await tolakKeluarAnggota(id, USER_ID);
    const sebelum = await potret(testDb);
    await expect(
      bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow();
    expect(await potret(testDb)).toBe(sebelum);
  });

  it('TEST 6/7/8 — DIBAYAR bersifat final: bayar/setujui/tolak ulang semuanya ditolak', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const sesudahBayar = await potret(testDb);
    await expect(
      bayarKeluarAnggota({ id, tanggal: '2026-02-04', sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow(/sudah dibayar/i);
    await expect(setujuiKeluarAnggota(id, USER_ID, '2026-02-04')).rejects.toThrow();
    await expect(tolakKeluarAnggota(id, USER_ID)).rejects.toThrow(/sudah dibayar/i);
    // Tidak ada jurnal kedua, tidak ada perubahan saldo.
    expect(await potret(testDb)).toBe(sesudahBayar);
  });

  it('DITOLAK → DITOLAK tetap idempotent (perilaku existing dipertahankan)', async () => {
    const id = await buatPengajuan();
    await tolakKeluarAnggota(id, USER_ID);
    const sebelum = await potret(testDb);
    await expect(tolakKeluarAnggota(id, USER_ID)).resolves.toMatchObject({ statusPengajuan: 'DITOLAK' });
    expect(await potret(testDb)).toBe(sebelum);
  });
});

// ===========================================================================
// 2. TRACEABILITY DUA ARAH (§15/§23)
// ===========================================================================

describe('RC-S76 — traceability pengajuan ↔ bukti', () => {
  it('TEST §23 — bukti.journalId === keluar_anggota.journal_id, dan bukti.sumberId === keluar_anggota.id', async () => {
    const pengajuanId = await buatPengajuan();
    await setujuiKeluarAnggota(pengajuanId, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({
      id: pengajuanId, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID,
    });

    const ka = await testDb.getFirstAsync<any>(`SELECT id, journal_id FROM keluar_anggota WHERE id = ?`, pengajuanId);
    const j = await testDb.getFirstAsync<any>(`SELECT id, sumber_id, sumber_transaksi FROM journal WHERE id = ?`, ka.journal_id);
    expect(j.sumber_transaksi).toBe('KELUAR_ANGGOTA');
    expect(j.sumber_id).toBe(pengajuanId);

    const bukti = await getBuktiKeluarAnggotaById(hasil.journalId);
    expect(bukti).not.toBeNull();
    expect(bukti!.journalId).toBe(ka.journal_id);
    expect(bukti!.sumberId).toBe(ka.id); // tautan balik EXACT
  });

  it('§15 — round-trip: Pengajuan A → Jurnal J → Bukti J → sumberId → Pengajuan A (bukan B)', async () => {
    // Anggota kedua dengan NAMA, TANGGAL, dan NOMINAL identik. Service
    // hanya mengizinkan satu pengajuan hidup per anggota, jadi kembaran
    // dibuat lewat anggota berbeda — dan justru itu yang membuat
    // pencocokan nama/tanggal/nominal mustahil dibedakan.
    const now2 = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-2','AGT-0002','3201010101010002','Ahmad Fauzan','2020-01-01','AKTIF',?,?)`,
      now2, now2
    );
    await setorSimpanan({
      anggotaId: 'anggota-2', jenis: 'POKOK', tanggal: '2026-01-05',
      nominal: 100_000, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await setorSimpanan({
      anggotaId: 'anggota-2', jenis: 'SUKARELA', tanggal: '2026-01-06',
      nominal: 400_000, sumberDana: 'KAS', createdBy: USER_ID,
    });

    const a = await buatPengajuan('2026-02-01');
    const { id: b } = await ajukanKeluarAnggota({
      anggotaId: 'anggota-2', alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01', createdBy: USER_ID,
    });
    await setujuiKeluarAnggota(a, USER_ID, '2026-02-02');
    const hasilA = await bayarKeluarAnggota({ id: a, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const bukti = await getBuktiKeluarAnggotaById(hasilA.journalId);
    // Inilah alasan pencocokan nama/tanggal/nominal tidak dipakai:
    // kedua pengajuan tidak dapat dibedakan dengan cara itu.
    expect(bukti!.sumberId).toBe(a);
    expect(bukti!.sumberId).not.toBe(b);

    const kembali = await getKeluarAnggotaDetailById(bukti!.sumberId!);
    expect(kembali!.id).toBe(a);
    expect(kembali!.statusPengajuan).toBe('DIBAYAR');
  });

  it('daftar bukti juga membawa sumberId untuk setiap baris', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const daftar = await listBuktiKeluarAnggota();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].sumberId).toBe(id);
    expect(daftar[0].namaAnggota).toBe('Ahmad Fauzan');
    expect(daftar[0].totalDikembalikan).toBe(500_000);
  });

  it('§16 — sumber dana terbaca apa adanya (KAS/BANK), bukan nama rekening karangan', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    expect((await getBuktiKeluarAnggotaById(hasil.journalId))!.sumberDana).toBe('KAS');
  });

  it('§10 — jurnal non-KELUAR_ANGGOTA tidak mengembalikan sumberId (tidak menebak tautan)', async () => {
    // Jurnal setoran simpanan: `sumber_id`-nya menunjuk tabel lain.
    const setoran = await testDb.getFirstAsync<any>(
      `SELECT journal_id FROM simpanan_transaksi WHERE tipe = 'SETOR' LIMIT 1`
    );
    const bukti = await getBuktiKeluarAnggotaById(setoran.journal_id);
    // Baris tetap terbaca (query-nya generik), tetapi tautan baliknya
    // TIDAK diteruskan — id itu bukan id pengajuan keluar anggota.
    expect(bukti?.sumberId ?? null).toBeNull();
  });

  // =========================================================================
  // RC-S77 — PENCARIAN BUKTI KELUAR ANGGOTA
  // =========================================================================

  it('RC-S77 A — jalur LEGACY keluarAnggota(): search nama & nomor menemukan buktinya', async () => {
    // Jalur lama menulis baris `simpanan_transaksi`, jadi anggotanya
    // terbaca lewat alias `a`.
    const { keluarAnggota } = await import('@/services/SimpananService');
    await keluarAnggota({
      anggotaId: ANGGOTA_ID, tanggal: '2026-02-05', sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(await listBuktiKeluarAnggota({ search: 'Ahmad' })).toHaveLength(1);
    expect(await listBuktiKeluarAnggota({ search: 'AGT-0001' })).toHaveLength(1);
  });

  it('RC-S77 B — jalur PERSETUJUAN bayarKeluarAnggota(): search nama & nomor menemukan buktinya', async () => {
    // Jalur ini TIDAK menulis `simpanan_transaksi`, sehingga alias `a`
    // NULL seluruhnya. Sebelum RC-S77 bukti ini ada di daftar tetapi
    // tidak pernah ditemukan saat dicari.
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    // Prasyarat yang membuat bug ini mungkin: tidak ada satu pun baris
    // simpanan_transaksi yang menempel pada jurnal itu.
    const st = await testDb.getAllAsync<any>(
      `SELECT id FROM simpanan_transaksi WHERE journal_id = ?`, hasil.journalId
    );
    expect(st).toHaveLength(0);

    const perNama = await listBuktiKeluarAnggota({ search: 'Ahmad' });
    expect(perNama).toHaveLength(1);
    expect(perNama[0].journalId).toBe(hasil.journalId);
    expect(perNama[0].sumberId).toBe(id); // tautan tetap dari journal.sumber_id

    const perNomor = await listBuktiKeluarAnggota({ search: 'AGT-0001' });
    expect(perNomor).toHaveLength(1);
    expect(perNomor[0].journalId).toBe(hasil.journalId);
  });

  it('RC-S77 — anti false-match: dua anggota NAMA SAMA, nomor berbeda; search nomor hanya mengembalikan satu', async () => {
    const now2 = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-9','AGT-0009','3201010101010009','Ahmad Fauzan','2020-01-01','AKTIF',?,?)`,
      now2, now2
    );
    await setorSimpanan({
      anggotaId: 'anggota-9', jenis: 'POKOK', tanggal: '2026-01-05',
      nominal: 100_000, sumberDana: 'KAS', createdBy: USER_ID,
    });

    const a = await buatPengajuan();
    await setujuiKeluarAnggota(a, USER_ID, '2026-02-02');
    const hasilA = await bayarKeluarAnggota({ id: a, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const { id: b } = await ajukanKeluarAnggota({
      anggotaId: 'anggota-9', alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-02-01', tanggalEfektifKeluar: '2026-02-01', createdBy: USER_ID,
    });
    await setujuiKeluarAnggota(b, USER_ID, '2026-02-02');
    const hasilB = await bayarKeluarAnggota({ id: b, tanggal: '2026-02-04', sumberDana: 'KAS', createdBy: USER_ID });

    // Nama sama -> keduanya muncul; itu benar.
    expect(await listBuktiKeluarAnggota({ search: 'Ahmad Fauzan' })).toHaveLength(2);
    // Nomor berbeda -> hanya satu, dan yang BENAR.
    const hanyaA = await listBuktiKeluarAnggota({ search: 'AGT-0001' });
    expect(hanyaA).toHaveLength(1);
    expect(hanyaA[0].journalId).toBe(hasilA.journalId);
    expect(hanyaA[0].sumberId).toBe(a);

    const hanyaB = await listBuktiKeluarAnggota({ search: 'AGT-0009' });
    expect(hanyaB).toHaveLength(1);
    expect(hanyaB[0].journalId).toBe(hasilB.journalId);
    expect(hanyaB[0].sumberId).toBe(b);
  });

  it('RC-S77 — pencarian 10x tidak mengubah database', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const sebelum = await potret(testDb);
    for (let i = 0; i < 10; i++) {
      await listBuktiKeluarAnggota({ search: 'Ahmad' });
      await listBuktiKeluarAnggota({ search: 'AGT-0001' });
      await listBuktiKeluarAnggota();
    }
    expect(await potret(testDb)).toBe(sebelum);
  });

  it('RC-S77 REGRESI — pencarian jenis bukti LAIN tidak ikut rusak (alias ka_a tidak bocor)', async () => {
    // Filter COALESCE hanya sah di listBuktiKeluarAnggota, satu-satunya
    // query yang punya alias `ka_a`. Kalau ia bocor ke query bukti lain,
    // SQLite melempar "no such column: ka_a.nama_lengkap" begitu
    // pencarian dipakai — bukan sekadar hasil kosong.
    const { listBuktiBayarSimpanan, listBuktiTarikSimpanan, listBuktiBayarPiutang, listBuktiBayarUtang } =
      await import('@/services/BuktiTransaksiService');
    await expect(listBuktiBayarSimpanan({ search: 'Ahmad' })).resolves.toBeDefined();
    await expect(listBuktiBayarSimpanan({ search: 'AGT-0001' })).resolves.toBeDefined();
    await expect(listBuktiTarikSimpanan({ search: 'Ahmad' })).resolves.toBeDefined();
    await expect(listBuktiBayarPiutang({ search: 'Ahmad' })).resolves.toBeDefined();
    await expect(listBuktiBayarUtang({ search: 'Ahmad' })).resolves.toBeDefined();
  });

  it('id bukti tidak dikenal -> null, bukan melempar', async () => {
    await expect(getBuktiKeluarAnggotaById('tidak-ada')).resolves.toBeNull();
  });
});

// ===========================================================================
// 3. GATE AKUNTANSI (§24/§25/§35)
// ===========================================================================

describe('RC-S76 — gate akuntansi', () => {
  it('TEST §24 — membaca detail & bukti 10× masing-masing: keempat tabel byte-identical', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const sebelum = await potret(testDb);
    for (let i = 0; i < 10; i++) {
      await getKeluarAnggotaDetailById(id);
      await getBuktiKeluarAnggotaById(hasil.journalId);
    }
    expect(await potret(testDb)).toBe(sebelum);
  });

  it('TEST §25 — navigasi bolak-balik detail↔bukti 5× tidak mengubah database', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });

    const sebelum = await potret(testDb);
    for (let i = 0; i < 5; i++) {
      // detail → bukti → back → bukti → pengajuan
      await getKeluarAnggotaDetailById(id);
      await getBuktiKeluarAnggotaById(hasil.journalId);
      await listBuktiKeluarAnggota();
      await getBuktiKeluarAnggotaById(hasil.journalId);
      await getKeluarAnggotaDetailById(id);
    }
    expect(await potret(testDb)).toBe(sebelum);
  });

  it('TEST §26 — pembayaran tetap satu jurnal; nilai accounting tidak berubah', async () => {
    const id = await buatPengajuan();
    await setujuiKeluarAnggota(id, USER_ID, '2026-02-02');
    const hasil = await bayarKeluarAnggota({ id, tanggal: '2026-02-03', sumberDana: 'KAS', createdBy: USER_ID });
    expect(hasil.nilaiPengembalian).toBe(500_000);

    const jurnalKeluar = await testDb.getAllAsync<any>(
      `SELECT id FROM journal WHERE sumber_transaksi = 'KELUAR_ANGGOTA'`
    );
    expect(jurnalKeluar).toHaveLength(1); // tidak ada jurnal duplikat

    const entries = await testDb.getAllAsync<any>(`SELECT * FROM journal_entry WHERE journal_id = ?`, hasil.journalId);
    const debit = entries.reduce((a, e) => a + (e.debit ?? 0), 0);
    const kredit = entries.reduce((a, e) => a + (e.kredit ?? 0), 0);
    expect(debit).toBe(kredit);
    expect(debit).toBe(500_000);
  });
});

// ===========================================================================
// 4. STRUKTURAL — CTA, navigasi lintas tab, statis (§22/§36/§37)
// ===========================================================================

describe('RC-S76 — struktur CTA & navigasi', () => {
  const detailKeluar = tanpaKomentar(baca(DETAIL_KELUAR));
  const detailBukti = tanpaKomentar(baca(DETAIL_BUKTI));
  const listBukti = tanpaKomentar(baca(LIST_BUKTI));
  const daftarKeluar = tanpaKomentar(baca(DAFTAR_KELUAR));
  const nav = tanpaKomentar(baca(NAV));

  it('TEST A/B/C — CTA bukti memakai jenis KELUAR_ANGGOTA dan id = row.journalId', () => {
    expect(detailKeluar).toContain('Lihat Bukti Keluar Anggota');
    expect(detailKeluar).toMatch(/params: \{ jenis: 'KELUAR_ANGGOTA', id: row\.journalId \}/);
  });

  it('§6 — CTA bukti hanya pada DIBAYAR, dan hanya bila journalId ada', () => {
    const iDibayar = detailKeluar.indexOf("{row.statusPengajuan === 'DIBAYAR' && (");
    expect(iDibayar).toBeGreaterThan(0);
    expect(detailKeluar.indexOf('Lihat Bukti Keluar Anggota')).toBeGreaterThan(iDibayar);
    expect(detailKeluar).toContain('{row.journalId ? (');
    // Keadaan aman bila tidak ada jurnal.
    expect(detailKeluar).toContain('Bukti transaksi belum tersedia untuk pengajuan ini.');
  });

  it('TEST H — navigasi lintas tab lewat tab induk, bukan route sibling polos', () => {
    expect(detailKeluar).toMatch(/navigation\.navigate\('Laporan', \{\s*screen: 'BuktiTransaksiDetail'/);
    expect(detailBukti).toMatch(/navigation\.navigate\('Transaksi', \{\s*screen: 'KeluarAnggotaDetail'/);
    // Tidak ada navigate polos ke route milik stack lain.
    expect(detailKeluar).not.toMatch(/navigate\('BuktiTransaksiDetail'/);
    expect(detailBukti).not.toMatch(/navigate\('KeluarAnggotaDetail'/);
  });

  it('TEST F/G — CTA balik memakai keluarAnggotaId dari sumberId, bukan objek utuh', () => {
    expect(detailBukti).toContain('Lihat Detail Pengajuan');
    expect(detailBukti).toMatch(/params: \{ keluarAnggotaId: sumberKeluarAnggotaId \}/);
    expect(detailBukti).toContain('sumberKeluarAnggotaId = it.sumberId;');
    // Tanpa sumberId yang sah: tidak ada CTA, dan tidak menebak.
    expect(detailBukti).toContain('Detail pengajuan asal tidak tersedia.');
    expect(detailBukti).toMatch(/\{sumberKeluarAnggotaId \? \(/);
  });

  it('§10 — tidak ada pencocokan berdasarkan nama/tanggal/nominal di kedua layar', () => {
    for (const src of [detailKeluar, detailBukti]) {
      expect(src).not.toMatch(/find\(\([^)]*\) =>[^)]*namaAnggota ===/);
      expect(src).not.toMatch(/find\(\([^)]*\) =>[^)]*tanggal ===/);
      expect(src).not.toMatch(/filter\(\([^)]*\) =>[^)]*nominal ===/);
    }
  });

  it('TEST D/§12 — menu Bukti Keluar Anggota tetap satu, lewat route generic', () => {
    expect(nav.match(/name="BuktiTransaksiList"/g)).toHaveLength(1);
    expect(nav.match(/name="BuktiTransaksiDetail"/g)).toHaveLength(1);
    // Tidak ada route/screen khusus keluar anggota yang menduplikasi generic.
    expect(nav).not.toMatch(/BuktiKeluarAnggotaList|BuktiKeluarAnggotaDetail/);
    expect(listBukti).toContain('KELUAR_ANGGOTA');
  });

  it('TEST I/§29 — tidak ada service/screen bukti duplikat', () => {
    for (const rel of [
      'src/services/BuktiKeluarAnggotaService.ts',
      'src/screens/Laporan/BuktiKeluarAnggotaListScreen.tsx',
      'src/screens/Laporan/BuktiKeluarAnggotaDetailScreen.tsx',
    ]) {
      expect(() => baca(rel)).toThrow();
    }
  });

  it('TEST §36 — tidak ada mutasi akuntansi langsung di keempat layar', () => {
    for (const src of [detailKeluar, detailBukti, listBukti, daftarKeluar]) {
      for (const terlarang of ['createJournal', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'withTransaction(', 'getDb(']) {
        expect(src).not.toContain(terlarang);
      }
    }
  });

  it('§20 — catatan kewajiban muncul hanya bila ada saldo pinjaman, murni transparansi', () => {
    expect(detailKeluar).toContain('{row.saldoPinjaman > 0 && (');
    expect(detailKeluar).toContain('Catatan Kewajiban');
    expect(detailKeluar).toContain('masih tercatat sebagai piutang koperasi');
    // Tidak ada workflow penagihan / perubahan status pinjaman.
    expect(detailKeluar).not.toMatch(/tagih|hapusPiutang|updatePinjaman|setStatusPinjaman/i);
  });

  it('§21 — kedua CTA accessible sebagai tombol dengan label jelas', () => {
    expect(detailKeluar).toContain('accessibilityLabel="Lihat bukti keluar anggota"');
    expect(detailBukti).toContain('accessibilityLabel="Lihat detail pengajuan keluar anggota"');
  });

  it('§31 — label status tetap dari modul bersama, tidak diketik ulang per layar', () => {
    expect(detailKeluar).toContain("from '@/screens/Transaksi/keluarAnggotaLabels'");
    expect(detailBukti).toContain('LABEL_JENIS_BUKTI[jenis]');
    expect(detailKeluar).not.toMatch(/DIAJUKAN: 'Menunggu Persetujuan'/);
  });

  it('§30 — daftar tetap monitoring-only, tanpa sisa import mutasi', () => {
    for (const terlarang of [
      'setujuiKeluarAnggota', 'tolakKeluarAnggota', 'bayarKeluarAnggota', 'RekeningPicker',
    ]) {
      expect(daftarKeluar).not.toContain(terlarang);
    }
  });
});
