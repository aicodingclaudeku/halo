import { createTestDb, TestDb } from './testDb';

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
  hitungCadangan,
  getKlasifikasiPinjamanAktif,
  sesuaikanPenyisihanPiutang,
  getRingkasanAging,
  ringkasKualitasPinjaman,
  KOLEKTIBILITAS_LABEL,
  KOLEKTIBILITAS_URUT,
  PERSENTASE_CADANGAN,
} from '@/services/LoanImpairmentService';
import { PERSENTASE_PENYISIHAN_SOM } from '@/services/KolektibilitasSomService';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = { beban: 'acc-beban-penyisihan', penyisihan: 'acc-penyisihan' };

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.beban, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.beban);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-1','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-2','A002','6543210987654321','Sari (Nonaktif)','2020-01-01','TIDAK_AKTIF',?,?)`,
    now,
    now
  );

  return db;
}

/** Buat satu pinjaman AKTIF dengan satu baris angsuran jatuh tempo N hari yang lalu (as-of tanggalLaporan). */
async function seedPinjamanTunggak(
  db: TestDb,
  id: string,
  sisaPokok: number,
  hariTerlambat: number,
  opts: { anggotaId?: string; tanggalLaporan?: string } = {}
) {
  const anggotaId = opts.anggotaId ?? 'anggota-1';
  const referensi = opts.tanggalLaporan ? new Date(opts.tanggalLaporan) : new Date();
  const now = new Date().toISOString();
  const tanggalJatuhTempo = new Date(referensi.getTime() - hariTerlambat * 86400 * 1000).toISOString().slice(0, 10);
  await db.runAsync(
    `INSERT INTO pinjaman
      (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
       persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    `PJ-${id}`,
    anggotaId,
    '2025-01-01',
    sisaPokok,
    1,
    'BULAN',
    'FLAT',
    0,
    'TIDAK_ADA',
    0,
    0,
    0,
    tanggalJatuhTempo,
    'AKTIF',
    'user-1',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    `jadwal-${id}`,
    id,
    1,
    tanggalJatuhTempo,
    sisaPokok,
    0,
    0,
    sisaPokok,
    'BELUM_BAYAR'
  );
}

describe('LoanImpairmentService — taksonomi & penyisihan (SOM Juklat 3/2025)', () => {
  test('KOLEKTIBILITAS_URUT: PERSIS 4 kategori SOM, tanpa kategori perbankan "Dalam Perhatian"', () => {
    // Penggolongan berbasis hari (5 kategori, ambang 1/91/121/181) sudah
    // DIGANTI penggolongan SOM. Ambangnya sendiri diuji langsung terhadap
    // mesin aturannya di KolektibilitasSomService.test.ts — di sini yang
    // dijaga adalah bahwa service ini benar-benar memakai taksonomi itu.
    expect(KOLEKTIBILITAS_URUT).toEqual(['LANCAR', 'KURANG_LANCAR', 'DIRAGUKAN', 'MACET']);
    expect(Object.keys(KOLEKTIBILITAS_LABEL)).not.toContain('DALAM_PERHATIAN');
  });

  test('PERSENTASE_CADANGAN: 0 / 50 / 75 / 100 (SOM angka 15) — satu sumber dengan PERSENTASE_PENYISIHAN_SOM', () => {
    // BUKAN 0,5/10/50/100 — itu batasan FISKAL PMK 74, bukan cadangan
    // risiko SOM. Lihat KolektibilitasFiskalService untuk lapisan fiskal.
    expect(PERSENTASE_CADANGAN).toBe(PERSENTASE_PENYISIHAN_SOM);
    expect(PERSENTASE_CADANGAN.LANCAR).toBe(0);
    expect(PERSENTASE_CADANGAN.KURANG_LANCAR).toBe(50);
    expect(PERSENTASE_CADANGAN.DIRAGUKAN).toBe(75);
    expect(PERSENTASE_CADANGAN.MACET).toBe(100);
  });

  test('hitungCadangan: saldo pokok × persentase kategori, dibulatkan ke Rupiah', () => {
    expect(hitungCadangan(10_000_000, 'LANCAR')).toBe(0); // 0% — SOM tidak mencadangkan pinjaman lancar
    expect(hitungCadangan(10_000_000, 'KURANG_LANCAR')).toBe(5_000_000); // 50%
    expect(hitungCadangan(10_000_000, 'DIRAGUKAN')).toBe(7_500_000); // 75%
    expect(hitungCadangan(10_000_000, 'MACET')).toBe(10_000_000); // 100%
  });
});

describe('LoanImpairmentService — I/O (update pasca-Phase 18 §4/§14-§18)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('getKlasifikasiPinjamanAktif: kategori SOM terhitung benar dari data sungguhan', async () => {
    // `seedPinjamanTunggak` membuat pinjaman ber-jadwal SATU baris, yaitu
    // pengembalian TANPA ANGSURAN (sekali bayar di jatuh tempo) — jadi
    // ambang yang berlaku adalah kriteria Kurang Lancar huruf b SOM:
    // sudah jatuh tempo & belum dibayar, belum melampaui 3 bulan ->
    // Kurang Lancar; melampaui 3 bulan & agunan < 75% -> Macet.
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200); // ~6 bulan lewat jatuh tempo, tanpa agunan -> MACET
    await seedPinjamanTunggak(testDb, 'p2', 2_000_000, 0); // jatuh tempo hari ini, belum lewat -> LANCAR
    await seedPinjamanTunggak(testDb, 'p3', 3_000_000, 45); // ~1 bulan lewat jatuh tempo -> KURANG_LANCAR

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any);
    expect(klasifikasi.find((k) => k.pinjamanId === 'p1')?.kolektibilitas).toBe('MACET');
    expect(klasifikasi.find((k) => k.pinjamanId === 'p2')?.kolektibilitas).toBe('LANCAR');
    expect(klasifikasi.find((k) => k.pinjamanId === 'p3')?.kolektibilitas).toBe('KURANG_LANCAR');

    // Pola pengembalian & masukan SOM ikut dilaporkan, supaya hasil
    // penggolongan bisa ditelusuri tanpa menghitung ulang.
    const p3 = klasifikasi.find((k) => k.pinjamanId === 'p3')!;
    expect(p3.polaPengembalian).toBe('TANPA_ANGSURAN');
    expect(p3.bermasalah).toBe(true);
    expect(p3.dasarPenggolongan).toContain('Kurang Lancar');
    expect(klasifikasi.find((k) => k.pinjamanId === 'p2')!.bermasalah).toBe(false);
  });

  test('pinjaman BERANGSURAN memakai ambang bulan, bukan ambang pinjaman tanpa angsuran', async () => {
    // Pinjaman 12 angsuran bulanan; angsuran pertama jatuh tempo 100 hari
    // lalu (~3 bulan) dan belum dibayar. Untuk pinjaman berangsuran
    // bulanan, tunggakan pokok baru Kurang Lancar bila MELAMPAUI 3 bulan —
    // jadi pada 3 bulan pas kategorinya masih LANCAR. Pinjaman TANPA
    // angsuran dengan tunggakan yang sama sudah KURANG_LANCAR (test di
    // atas): inilah beda ambang yang dibawa SOM dan yang tidak mungkin
    // dibedakan oleh skema ambang hari tunggal.
    const now = new Date().toISOString();
    const jatuhTempo1 = new Date(Date.now() - 100 * 86400 * 1000).toISOString().slice(0, 10);
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('p-angsur','PJ-p-angsur','anggota-1','2025-01-01',12000000,12,'BULAN','FLAT',0,'TIDAK_ADA',0,0,0,NULL,'AKTIF','user-1',?,?)`,
      now,
      now
    );
    for (let n = 1; n <= 12; n++) {
      // Angsuran ke-1 sudah jatuh tempo; sisanya masih di masa depan.
      const jatuhTempo =
        n === 1 ? jatuhTempo1 : new Date(Date.now() + n * 30 * 86400 * 1000).toISOString().slice(0, 10);
      await testDb.runAsync(
        `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
         VALUES (?,?,?,?,1000000,0,0,1000000,'BELUM_BAYAR')`,
        `jadwal-p-angsur-${n}`,
        'p-angsur',
        n,
        jatuhTempo
      );
    }

    const item = (await getKlasifikasiPinjamanAktif(testDb as any)).find((k) => k.pinjamanId === 'p-angsur')!;
    expect(item.polaPengembalian).toBe('ANGSURAN');
    expect(item.bulanTunggakanPokok).toBe(3);
    expect(item.kolektibilitas).toBe('LANCAR');
  });

  test('getKlasifikasiPinjamanAktif: saldo piutang & nilai cadangan dihitung dari SALDO OUTSTANDING (bukan nilai awal pinjaman)', async () => {
    const now = new Date().toISOString();
    await seedPinjamanTunggak(testDb, 'p1', 10_000_000, 200); // MACET, tapi akan dibayar sebagian
    // Bayar sebagian pokok — sisa saldo piutang harus mencerminkan ini, bukan jumlah_pinjaman awal.
    await testDb.runAsync(
      `UPDATE angsuran_jadwal SET pokok_terbayar = 6000000, status = 'SEBAGIAN' WHERE id = 'jadwal-p1'`
    );

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any);
    const p1 = klasifikasi.find((k) => k.pinjamanId === 'p1')!;
    expect(p1.saldoPiutang).toBe(4_000_000); // 10jt - 6jt sudah dibayar
    expect(p1.nilaiCadangan).toBe(4_000_000); // MACET 100% dari SISA, bukan dari 10jt awal
  });

  test('update pasca-6-perbaikan §5: nilaiCadangan HANYA berdasarkan POKOK, BUKAN pokok+jasa+denda — bug yang dilaporkan pengguna', async () => {
    // Skenario PERSIS dari laporan bug: pokok 10jt, jasa 2jt, denda 500rb.
    // Ambang MACET (>180 hari, §14) -> persentase 100% -> cadangan HARUS
    // 10.000.000 (100% dari pokok), BUKAN 12.500.000 (100% dari total).
    const now = new Date().toISOString();
    const tanggalJatuhTempo = new Date(Date.now() - 200 * 86400 * 1000).toISOString().slice(0, 10);
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('p-bug','PJ-p-bug','anggota-1','2025-01-01',10000000,1,'BULAN','FLAT',20,'TIDAK_ADA',0,1,500000,?,'AKTIF','user-1',?,?)`,
      tanggalJatuhTempo,
      now,
      now
    );
    // total = pokok(10jt) + jasa(2jt) = 12jt (denda TIDAK termasuk `total`
    // di schema angsuran_jadwal — dicek terpisah via kolom `denda`).
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES ('jadwal-p-bug','p-bug',1,?,10000000,2000000,500000,12000000,'BELUM_BAYAR')`,
      tanggalJatuhTempo
    );

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any);
    const item = klasifikasi.find((k) => k.pinjamanId === 'p-bug')!;
    expect(item.kolektibilitas).toBe('MACET'); // >180 hari (§14)
    expect(item.persentaseCadangan).toBe(100);
    expect(item.saldoPokok).toBe(10_000_000); // pokok SAJA
    expect(item.saldoPiutang).toBe(12_000_000); // total (pokok+jasa, TIDAK termasuk denda) — dipakai TAMPILAN saja, bukan basis cadangan
    expect(item.nilaiCadangan).toBe(10_000_000); // 100% × POKOK (10jt) — BUKAN 12.500.000 (100% × total+denda)
    expect(item.nilaiCadangan).not.toBe(12_500_000);
    expect(item.nilaiCadangan).not.toBe(12_000_000);
  });

  test('pokok 10jt, jasa 2jt, denda 500rb, kategori Kurang Lancar SOM (50%) -> penyisihan 5.000.000 dari POKOK saja', async () => {
    const now = new Date().toISOString();
    // Pinjaman tanpa angsuran, ~3 bulan lewat jatuh tempo -> Kurang Lancar
    // menurut SOM (belum melampaui 3 bulan sejak jatuh tempo).
    const tanggalJatuhTempo = new Date(Date.now() - 100 * 86400 * 1000).toISOString().slice(0, 10);
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('p-bug2','PJ-p-bug2','anggota-1','2025-01-01',10000000,1,'BULAN','FLAT',20,'TIDAK_ADA',0,1,500000,?,'AKTIF','user-1',?,?)`,
      tanggalJatuhTempo,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES ('jadwal-p-bug2','p-bug2',1,?,10000000,2000000,500000,12000000,'BELUM_BAYAR')`,
      tanggalJatuhTempo
    );

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any);
    const item = klasifikasi.find((k) => k.pinjamanId === 'p-bug2')!;
    expect(item.kolektibilitas).toBe('KURANG_LANCAR');
    expect(item.persentaseCadangan).toBe(50); // SOM angka 15, bukan 15% skema lama & bukan 10% fiskal
    expect(item.nilaiCadangan).toBe(5_000_000); // 50% × 10.000.000 (POKOK)
    expect(item.nilaiCadangan).not.toBe(6_250_000); // BUKAN 50% × 12.500.000 (pokok+jasa+denda)
    expect(item.nilaiCadangan).not.toBe(6_000_000); // BUKAN 50% × 12.000.000 (pokok+jasa)
    expect(item.nilaiCadangan).not.toBe(1_000_000); // BUKAN 10% (batas fiskal PMK 74, bukan cadangan buku)
  });

  test('getKlasifikasiPinjamanAktif: pinjaman yang SEMUA angsurannya sudah LUNAS tidak muncul (saldo piutang 0)', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200);
    await testDb.runAsync(
      `UPDATE angsuran_jadwal SET pokok_terbayar = 5000000, status = 'LUNAS' WHERE id = 'jadwal-p1'`
    );

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any);
    expect(klasifikasi.find((k) => k.pinjamanId === 'p1')).toBeUndefined();
  });

  test('§4E: filter status anggota — AKTIF (default), TIDAK_AKTIF, SEMUA', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200, { anggotaId: 'anggota-1' }); // anggota AKTIF
    await seedPinjamanTunggak(testDb, 'p2', 3_000_000, 200, { anggotaId: 'anggota-2' }); // anggota TIDAK_AKTIF

    const aktif = await getKlasifikasiPinjamanAktif(testDb as any, { statusAnggota: 'AKTIF' });
    expect(aktif.map((k) => k.pinjamanId)).toEqual(['p1']);

    const nonaktif = await getKlasifikasiPinjamanAktif(testDb as any, { statusAnggota: 'TIDAK_AKTIF' });
    expect(nonaktif.map((k) => k.pinjamanId)).toEqual(['p2']);

    const semua = await getKlasifikasiPinjamanAktif(testDb as any, { statusAnggota: 'SEMUA' });
    expect(semua.map((k) => k.pinjamanId).sort()).toEqual(['p1', 'p2']);
  });

  test('§4F: tanggalLaporan mempengaruhi hari tunggakan (aging dihitung as-of tanggal laporan, bukan selalu hari ini)', async () => {
    // Jatuh tempo TETAP di kalender: 2026-01-01. Laporan per 2026-01-01 -> LANCAR (0 hari).
    // Laporan per 2026-05-15 -> 134 hari terlambat -> DIRAGUKAN (121-180 hari, §14).
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('p1','PJ-p1','anggota-1','2025-12-01',5000000,1,'BULAN','FLAT',0,'TIDAK_ADA',0,0,0,'2026-01-01','AKTIF','user-1',?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES ('jadwal-p1','p1',1,'2026-01-01',5000000,0,0,5000000,'BELUM_BAYAR')`
    );

    const perAwal = await getKlasifikasiPinjamanAktif(testDb as any, { tanggalLaporan: '2026-01-01' });
    expect(perAwal.find((k) => k.pinjamanId === 'p1')?.kolektibilitas).toBe('LANCAR');

    // 2026-05-15: pinjaman tanpa angsuran ini sudah 4 bulan lewat jatuh
    // tempo (melampaui 3 bulan) dan tidak beragunan -> MACET menurut SOM.
    const perMei = await getKlasifikasiPinjamanAktif(testDb as any, { tanggalLaporan: '2026-05-15' });
    expect(perMei.find((k) => k.pinjamanId === 'p1')?.kolektibilitas).toBe('MACET');
  });

  test('sesuaikanPenyisihanPiutang: jurnal balance & sesuai target — akun DITENTUKAN OTOMATIS (tidak ada parameter akun)', async () => {
    // Bug fix (test): sebelumnya `seedPinjamanTunggak` tanpa
    // `tanggalLaporan` menghitung "200 hari terlambat" relatif
    // terhadap `Date.now()` (waktu SUNGGUHAN saat test dijalankan),
    // sedangkan `sesuaikanPenyisihanPiutang` di bawah mengevaluasi
    // umur tunggakan relatif terhadap tanggal TETAP '2026-06-01'. Kalau
    // jarak antara "sekarang" (wall-clock) dan '2026-06-01' berubah
    // (mis. dijalankan di hari lain), jumlah hari tunggakan efektif
    // ikut bergeser dan pinjaman bisa jatuh ke kategori kolektibilitas
    // yang salah (bukan lagi MACET/180+ hari seperti yang dimaksud).
    // Fix: kunci `tanggalLaporan` ke tanggal yang sama dengan `tanggal`
    // di `sesuaikanPenyisihanPiutang`, supaya "200 hari" selalu benar
    // relatif terhadap tanggal evaluasi, bukan wall-clock.
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200, { tanggalLaporan: '2026-06-01' }); // MACET, 100%

    const hasil = await sesuaikanPenyisihanPiutang({ tanggal: '2026-06-01', createdBy: 'user-1' });
    expect(hasil.targetPenyisihan).toBe(5_000_000);
    expect(hasil.delta).toBe(5_000_000);
    expect(hasil.journalId).not.toBeNull();

    const bebanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.beban
    );
    const penyisihanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.penyisihan
    );
    expect(bebanRow?.total).toBe(5_000_000);
    expect(penyisihanRow?.total).toBe(5_000_000);
  });

  test('sesuaikanPenyisihanPiutang: mencakup piutang anggota NONAKTIF juga (CKPN soal risiko kredit, bukan status keanggotaan)', async () => {
    // Bug fix (test): lihat komentar di test sebelumnya — kunci
    // tanggalLaporan supaya "200 hari terlambat" konsisten terhadap
    // tanggal evaluasi '2026-06-01', bukan wall-clock saat test jalan.
    await seedPinjamanTunggak(testDb, 'p1', 4_000_000, 200, { anggotaId: 'anggota-2', tanggalLaporan: '2026-06-01' }); // anggota TIDAK_AKTIF, MACET

    const hasil = await sesuaikanPenyisihanPiutang({ tanggal: '2026-06-01', createdBy: 'user-1' });
    expect(hasil.targetPenyisihan).toBe(4_000_000);
  });

  test('sesuaikanPenyisihanPiutang dijalankan DUA KALI berturut-turut TANPA perubahan → jurnal kedua tidak dibuat (delta 0)', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200);

    const pertama = await sesuaikanPenyisihanPiutang({ tanggal: '2026-06-01', createdBy: 'user-1' });
    expect(pertama.journalId).not.toBeNull();

    const kedua = await sesuaikanPenyisihanPiutang({ tanggal: '2026-06-02', createdBy: 'user-1' });
    expect(kedua.delta).toBe(0);
    expect(kedua.journalId).toBeNull();

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENYISIHAN_PIUTANG'`
    );
    expect(jumlahJurnal?.cnt).toBe(1); // bukan 2
  });

  test('getRingkasanAging: agregat per kategori benar (§4C), berbasis saldoPokok/outstanding (§23-24)', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 5_000_000, 200); // MACET
    await seedPinjamanTunggak(testDb, 'p2', 3_000_000, 200); // MACET juga
    await seedPinjamanTunggak(testDb, 'p3', 1_000_000, 0); // LANCAR

    const ringkasan = await getRingkasanAging();
    const macet = ringkasan.find((r) => r.kategori === 'MACET')!;
    expect(macet.jumlahPinjaman).toBe(2);
    expect(macet.totalOutstanding).toBe(8_000_000);
    expect(macet.totalCadangan).toBe(8_000_000); // 100%

    const lancar = ringkasan.find((r) => r.kategori === 'LANCAR')!;
    expect(lancar.jumlahPinjaman).toBe(1);
    expect(lancar.totalOutstanding).toBe(1_000_000);
    // SOM angka 15: pinjaman lancar 0% — TIDAK dicadangkan sama sekali.
    // Berbeda dari PMK 74 yang tetap mengakui 0,5% untuk kategori Lancar.
    expect(lancar.totalCadangan).toBe(0);
  });

  test('audit ulang §23-25: totalOutstanding memakai saldoPokok SAJA, BUKAN pokok+jasa, walau ada jasa/bunga belum terbayar', async () => {
    const now = new Date().toISOString();
    // Pinjaman dengan jasa belum terbayar (pokok 5jt + jasa 1jt = saldoPiutang 6jt, saldoPokok tetap 5jt).
    await testDb.runAsync(
      `INSERT INTO pinjaman
        (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
         persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
         tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
       VALUES ('p-jasa','PJ-p-jasa','anggota-1','2025-01-01',5000000,1,'BULAN','FLAT',20,'TIDAK_ADA',0,0,0,'2025-06-01','AKTIF','user-1',?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES ('jadwal-p-jasa','p-jasa',1,'2025-06-01',5000000,1000000,0,6000000,'BELUM_BAYAR')`
    );

    const ringkasan = await getRingkasanAging({ tanggalLaporan: '2026-06-01' });
    const macet = ringkasan.find((r) => r.kategori === 'MACET')!;
    expect(macet.jumlahPinjaman).toBe(1);
    // totalOutstanding HARUS 5jt (saldoPokok), BUKAN 6jt (saldoPiutang).
    expect(macet.totalOutstanding).toBe(5_000_000);
    expect(macet.totalCadangan).toBe(5_000_000); // 100% x saldoPokok (5jt), bukan x saldoPiutang (6jt)
  });
});
