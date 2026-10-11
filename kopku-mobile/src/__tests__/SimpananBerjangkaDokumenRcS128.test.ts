import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

/**
 * RC-S128 — PDF BUKTI PENEMPATAN & BUKTI PENCAIRAN SIMPANAN BERJANGKA.
 * HTML dibangun dari data yang TERSIMPAN (kontrak + snapshot, jurnal,
 * bukti potong) setelah transaksi sungguhan; angka dicocokkan ke GL.
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

import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { cairkanSimpananBerjangka } from '@/services/SimpananBerjangkaLifecycleService';
import { jalankanCatchUpAkrualSimpananBerjangka, _resetCatchUpUntukTest } from '@/services/SimpananBerjangkaCatchUpService';
import { getDataBuktiPenempatan, getDataBuktiPencairan } from '@/services/SimpananBerjangkaDokumenService';
import { buildBuktiPenempatanHtml, buildBuktiPencairanHtml } from '@/export/SimpananBerjangkaDokumenBuilder';

const now = () => new Date().toISOString();
const U = 'user-1';

async function siapkan() {
  _resetCatchUpUntukTest();
  testDb = await createTestDb();
  const akun = async (id: string, kode: string, kat: string, nb: string) =>
    testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, kode, kat, nb, now(), now()
    );
  await akun('acc-kas', '1-1000', 'ASET', 'DEBIT');
  await akun('acc-2-1210', '2-1210', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1200', '2-1200', 'LIABILITAS', 'KREDIT');
  await akun('acc-2-1710', '2-1710', 'LIABILITAS', 'KREDIT');
  await akun('acc-5-1955', '5-1955', 'BEBAN', 'DEBIT');
  for (const [tt, role, acc] of [
    ['KAS_UMUM', 'DEFAULT', 'acc-kas'], ['SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', 'acc-2-1210'],
    ['SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', 'acc-2-1200'], ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', 'acc-5-1955'],
    ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', 'acc-2-1710'], ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', 'acc-2-1210'],
    ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', 'acc-2-1710'],
  ]) {
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `m-${tt}-${role}`, tt, role, acc);
  }
  for (const t of [2026, 2027]) {
    await testDb.runAsync(`INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`, `p${t}`, t, `${t}-01-01`, `${t}-12-31`);
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at) VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now(), now()
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at) VALUES ('ang-A','A001','7371000000000001','Siti Aminah','2020-01-01','AKTIF',?,?)`,
    now(), now()
  );
  await testDb.runAsync(
    `INSERT INTO koperasi (id, nama, alamat, npwp, tahun_buku_aktif, standar_akuntansi, created_at, updated_at) VALUES ('kop','KSP Maju Bersama','Jl. Contoh 1, Makassar','01.234.567.8-901.000',2026,'SAK_EP',?,?)`,
    now(), now()
  );
  await testDb.runAsync(
    `INSERT INTO koperasi_personel (id, nama, jabatan, jenis_personel, tanggal_mulai_jabatan, status_aktif, created_at, updated_at)
     VALUES ('p1','Drs. Andi Ketua','Ketua','PENGURUS','2025-01-01',1,?,?)`,
    now(), now()
  );
  await seedKebijakanProdukUji(testDb, { versi: 'KBP-2026-01', bungaPasca: true, ratePasca: 4 });
}

async function kontrak(): Promise<string> {
  return (await setorSimpananBerjangka({
    anggotaId: 'ang-A', nominal: 10_000_000, tenorBulan: 6, sukuBungaPerTahun: 6, tanggal: '2026-07-15', sumberDana: 'KAS', createdBy: U,
  })).id;
}

beforeEach(siapkan);

test('Bukti Penempatan: judul, nomor kontrak, terbilang, rate kontrak & pasca, auto-renewal, versi kebijakan, kesepakatan, dua tanda tangan', async () => {
  const id = await kontrak();
  const html = buildBuktiPenempatanHtml(await getDataBuktiPenempatan(id), { tanggalCetak: '15 Juli 2026' });
  expect(html).toContain('BUKTI PENEMPATAN SIMPANAN BERJANGKA');
  expect(html).toMatch(/SPB-/);
  expect(html).toContain('KSP Maju Bersama');
  expect(html).toContain('Siti Aminah');
  expect(html).toContain('A001');
  expect(html).toContain('15 Juli 2026');
  expect(html).toContain('15 Januari 2027');
  expect(html).toMatch(/sepuluh juta rupiah/i);
  expect(html).toContain('6% per tahun');
  expect(html).toMatch(/4% per tahun atas pokok/);
  expect(html).toMatch(/Perpanjangan otomatis<\/td><td class="kv-sep">:<\/td><td class="kv-nilai">Tidak/);
  expect(html).toContain('KBP-2026-01');
  expect(html).toMatch(/tidak berarti pokok dicairkan secara otomatis/);
  expect(html).toMatch(/Bunga tidak ditambahkan ke pokok/);
  expect(html).toMatch(/snapshot/);
  expect(html).toContain('ANGGOTA / PENYIMPAN');
  expect(html).toContain('KETUA KOPERASI');
  expect(html).toContain('Drs. Andi Ketua'); // dari resolver pengurus, bukan diketik
  expect(html).toContain('Stempel koperasi');
  expect((html.match(/Tanggal: \.{10,}/g) ?? []).length).toBe(2);
});

test('Bukti Penempatan kontrak legacy: menyatakan kebijakan belum ditetapkan, tanpa rate karangan', async () => {
  await testDb.runAsync(
    `INSERT INTO simpanan_berjangka (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
       suku_bunga, status, sumber_dana, created_by, created_at, updated_at)
     VALUES ('lama','ang-A','SPB-LAMA','2026-01-15','2026-04-15',5000000,3,6,'JATUH_TEMPO','KAS','user-1',?,?)`,
    now(), now()
  );
  const html = buildBuktiPenempatanHtml(await getDataBuktiPenempatan('lama'), { tanggalCetak: 'x' });
  expect(html).toMatch(/Belum ditetapkan — kontrak dibuat sebelum kebijakan produk tersedia/);
  expect(html).not.toMatch(/per tahun atas pokok/);
});

test('Bukti Pencairan: pokok ke anggota, bunga ke Sukarela, PPh, total kas = GL, referensi jurnal, alasan periode berjalan', async () => {
  const id = await kontrak();
  await jalankanCatchUpAkrualSimpananBerjangka(U, '2027-08-20');
  await cairkanSimpananBerjangka({ kontrakId: id, tanggal: '2027-08-20', sumberDana: 'KAS', createdBy: U });
  const d = await getDataBuktiPencairan(id);
  expect(d.pencairan).toMatchObject({
    pokokDicairkan: 10_000_000, bungaSelamaTenor: 300_000, bungaPascaJatuhTempo: 7 * 33_333,
    bungaKeSukarelaBruto: 300_000 + 7 * 33_333, pphAtasPemindahan: 0, bungaKeSukarelaNeto: 300_000 + 7 * 33_333,
    jumlahJurnalPemindahan: 13, bungaDibayarTunai: 0, totalKeluarKasBank: 10_000_000, sumberDana: 'KAS',
  });
  const kasGl = await testDb.getFirstAsync<{ k: number }>(
    `SELECT COALESCE(SUM(kredit),0) k FROM journal_entry WHERE account_id = 'acc-kas' AND journal_id = (SELECT journal_pencairan_id FROM simpanan_berjangka WHERE id = ?)`,
    id
  );
  expect(d.pencairan.totalKeluarKasBank).toBe(kasGl!.k);
  expect(d.pencairan.alasanTidakDibayarkan).toMatch(/15 Agustus 2027 – 15 September 2027/);
  const html = buildBuktiPencairanHtml(d, { tanggalCetak: '20 Agustus 2027' });
  expect(html).toContain('BUKTI PENCAIRAN SIMPANAN BERJANGKA');
  expect(html).toMatch(/TOTAL UANG KELUAR DARI KAS\/BANK<\/td><td class="kv-sep">:<\/td><td class="kv-nilai">Rp\s?10\.000\.000/);
  expect(html).toContain('Referensi jurnal pencairan');
  expect(html).toContain('KETUA KOPERASI');
});

test('Bukti Pencairan ditolak untuk kontrak yang belum dicairkan', async () => {
  const id = await kontrak();
  await expect(getDataBuktiPencairan(id)).rejects.toThrow(/sudah dicairkan/);
});
