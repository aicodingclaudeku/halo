import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S93 — REDESIGN KEBIJAKAN TUNGGAL BUNGA SIMPANAN SUKARELA.
 *
 * Pengurus hanya mengatur SATU kebijakan (Bunga Simpanan Sukarela ON/OFF).
 * Perlakuan sukarela dalam basis jasa modal SHU diturunkan otomatis:
 *   ON  -> tidak ikut basis jasa modal;
 *   OFF -> mengikuti kebijakan SHU koperasi yang sudah ada (tidak dipaksa ikut);
 * dan dikunci sebagai snapshot per tahun buku saat SHU pertama kali dihitung.
 *
 * Nomor (n) pada nama test = butir checklist redesign.
 */
let testDb: TestDb;
let HARI_INI = '2026-10-05';

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

jest.mock('@/utils/tanggal', () => ({
  ...jest.requireActual('@/utils/tanggal'),
  getTanggalLokalHariIni: jest.fn(() => HARI_INI),
}));

import { hitungBungaHarian } from '@/accounting/BungaSimpananSukarela';
import { hitungPphBungaSimpanan } from '@/config/pajakPolicy';
import { migrasiV78 } from '@/database/db';
import {
  berlakuMinimumVersiBaru,
  jalankanAkrualBungaSukarelaOtomatis,
  listProsesAkrual,
  listVersiKebijakanBunga,
  prosesAkrualBungaSukarela,
  simpanVersiKebijakanBunga,
} from '@/services/BungaSukarelaService';
import {
  bungaAktifDalamRentang,
  getPerlakuanShuSukarela,
  getSukarelaIkutJasaModalTahun,
  TEKS_PERLAKUAN_SHU_OFF,
  TEKS_PERLAKUAN_SHU_ON,
  teksPerlakuanShu,
  tentukanSnapshotBasisJasaModal,
  turunkanSukarelaIkutBasis,
} from '@/services/KebijakanBasisJasaModalService';
import { getBasisAnggotaSHU } from '@/services/ShuService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const now = () => new Date().toISOString();
const tambahKolom = async () => undefined;

async function siapkan() {
  HARI_INI = '2026-10-05';
  testDb = await createTestDb();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now(),
    now()
  );
  for (const [id, kode, nama, kat, nb] of [
    ['acc-skr', '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT'],
    ['acc-beban', '5-1956', 'Beban Bunga Simpanan Sukarela', 'BEBAN', 'DEBIT'],
    ['acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT'],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
      id, kode, nama, kat, nb, now(), now()
    );
  }
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','SIMPANAN_SUKARELA','KREDIT_DEFAULT','acc-skr')`);
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m2','SIMPANAN_SUKARELA_BUNGA','DEBIT_BEBAN','acc-beban')`);
  for (const [id, no, nama] of [
    ['ang-1', 'A-001', 'Andi'],
    ['ang-2', 'A-002', 'Budi'],
  ]) {
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at) VALUES (?,?,?,?, '2020-01-01','AKTIF',?,?)`,
      id, no, `NIK-${no}`, nama, now(), now()
    );
  }
}

let urut = 0;
async function simpanan(anggota: string, jenis: string, tanggal: string, nominal: number): Promise<string> {
  urut += 1;
  const id = `trx-${urut}`;
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,'SETOR',?,?,'KAS',?,'user-1',?)`,
    id, anggota, jenis, tanggal, nominal, `N-${urut}`, now()
  );
  return id;
}

/** Tulis versi kebijakan bunga langsung (untuk menyusun keadaan masa lalu). */
async function versiBunga(berlakuMulai: string, aktif: boolean, tarif: number) {
  urut += 1;
  await testDb.runAsync(
    `INSERT INTO bunga_sukarela_kebijakan (id, berlaku_mulai, aktif, tarif_persen, created_by, created_at) VALUES (?,?,?,?,'user-1',?)`,
    `kb-${urut}`, berlakuMulai, aktif ? 1 : 0, tarif, now()
  );
}

/** Kebijakan SHU koperasi yang SUDAH ADA (mis. versi migrasi v78 instalasi lama). */
async function kebijakanShu(mulaiTahun: number, sukarelaIkut: boolean) {
  urut += 1;
  await testDb.runAsync(
    `INSERT INTO kebijakan_basis_jasa_modal (id, berlaku_mulai_tahun, sukarela_ikut, created_by, created_at) VALUES (?,?,?,'x',?)`,
    `kbm-${urut}`, mulaiTahun, sukarelaIkut ? 1 : 0, now()
  );
}

async function shu(id: string, tahun: number, kolom: Record<string, unknown> = {}) {
  const k = { status: 'DRAFT', ...kolom };
  const nama = Object.keys(k);
  await testDb.runAsync(
    `INSERT INTO shu_konfigurasi (id, tahun_buku, ${nama.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${nama.map(() => '?').join(', ')}, ?, ?)`,
    id, tahun, ...nama.map((n) => k[n as keyof typeof k]), now(), now()
  );
}
const barisShu = (id: string) => testDb.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE id = ?`, id);
const snapshot = async (id: string) => (await barisShu(id))?.sukarela_basis_jasa_modal ?? null;
const jumlahJurnal = async () =>
  (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'SIMPANAN_SUKARELA_BUNGA'`))?.n ?? 0;
const posted = async () => (await listProsesAkrual()).filter((p) => p.status === 'POSTED').map((p) => p.periode).sort();

// ==================================================================
// UI — satu toggle utama
// ==================================================================
describe('UI kebijakan tunggal', () => {
  const layar = baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx');

  it('(1) layar hanya memiliki SATU toggle: Bunga Simpanan Sukarela', () => {
    expect((layar.match(/<Switch\b/g) ?? []).length).toBe(1);
    expect(layar).toContain('accessibilityLabel="Bunga Simpanan Sukarela"');
  });

  it('(2) toggle lama basis jasa modal tidak muncul di UI mana pun', () => {
    for (const f of ['src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx', 'src/components/panduan/IlustrasiUi.tsx', 'src/config/panduanAplikasi.ts']) {
      const isi = baca(f);
      expect([f, /Sukarela ikut basis jasa modal/i.test(isi)]).toEqual([f, false]);
      expect([f, isi.includes('simpanVersiBasisJasaModal')]).toEqual([f, false]);
      expect([f, isi.includes('Simpan Kebijakan Jasa Modal')]).toEqual([f, false]);
    }
    // Konsekuensi ditampilkan sebagai informasi, tanpa jargon kolom database.
    expect(layar).toContain('teksPerlakuanShu(');
    expect(layar).not.toMatch(/sukarela_basis_jasa_modal|kebijakan_basis_jasa_modal/);
    expect(TEKS_PERLAKUAN_SHU_ON).toMatch(/tidak diperhitungkan sebagai basis jasa modal selama kebijakan bunga aktif/);
    expect(TEKS_PERLAKUAN_SHU_OFF).toMatch(/mengikuti kebijakan pembagian SHU koperasi/);
    expect(teksPerlakuanShu(true)).toBe(TEKS_PERLAKUAN_SHU_ON);
    expect(teksPerlakuanShu(false)).toBe(TEKS_PERLAKUAN_SHU_OFF);
  });

  it('struktur layar: tarif, metode Saldo Harian, berlaku mulai, status akrual, ringkasan, histori', () => {
    const urutan = [
      'Kebijakan Bunga Simpanan Sukarela',
      'Tarif bunga tahunan',
      'Metode perhitungan',
      'Berlaku mulai',
      'Status periode akrual',
      'Ringkasan kebijakan aktif',
      'Histori kebijakan',
    ].map((t) => layar.indexOf(t));
    expect(urutan.every((i) => i > 0)).toBe(true);
    expect([...urutan].sort((a, b) => a - b)).toEqual(urutan);
    // OFF: tarif read-only (tidak dihapus), histori menampilkan waktu perubahan.
    expect(layar).toContain('editable={aktif}');
    expect(layar).toContain('waktuPerubahan(v.createdAt)');
  });
});

// ==================================================================
// SHU — perlakuan turunan
// ==================================================================
describe('perlakuan SHU diturunkan dari kebijakan bunga', () => {
  beforeEach(siapkan);

  it('(3) ON -> sukarela otomatis tidak ikut basis jasa modal untuk tahun buku yang belum dikunci', async () => {
    await kebijakanShu(0, true); // instalasi lama: kebijakan SHU = ikut
    await versiBunga('2026-03', true, 5);
    await shu('draft', 2026);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(false);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await barisShu('draft'))).toBe(false);
    expect(await snapshot('draft')).toBe(0);
    // Basis SHU hanya pokok + wajib.
    await simpanan('ang-1', 'POKOK', '2026-01-01', 100_000);
    await simpanan('ang-1', 'WAJIB', '2026-01-01', 200_000);
    await simpanan('ang-1', 'SUKARELA', '2026-01-01', 1_000_000);
    const b = await getBasisAnggotaSHU(testDb as never, '2026-01-01', '2026-12-31', false);
    expect(b.find((x) => x.anggotaId === 'ang-1')?.basisSimpanan).toBe(300_000);
  });

  it('(4) OFF tidak memaksa sukarela ikut: mengikuti kebijakan SHU yang ada', async () => {
    // Tanpa kebijakan SHU (pokok + wajib saja) -> tetap tidak ikut.
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(false);
    // Bunga OFF eksplisit juga tidak memaksa ikut.
    await versiBunga('2026-01', false, 0);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(false);
    // Kebijakan SHU yang ada = ikut -> ikut.
    await kebijakanShu(0, true);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(true);
    expect(await getPerlakuanShuSukarela(2026)).toEqual({ tahunBuku: 2026, sukarelaIkut: true, sumber: 'KEBIJAKAN_SHU' });
  });

  it('bunga aktif pada SALAH SATU bulan tahun buku sudah cukup; tahun tanpa bulan aktif mengikuti kebijakan SHU', async () => {
    await kebijakanShu(0, true);
    await versiBunga('2025-11', true, 5);
    await versiBunga('2026-01', false, 0);
    expect(await getSukarelaIkutJasaModalTahun(2025)).toBe(false); // Nov–Des 2025 aktif
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(true); // 2026 seluruhnya OFF
    expect(await getSukarelaIkutJasaModalTahun(2024)).toBe(true);
  });

  it('rentang tahun buku diambil dari accounting_period bila ada', async () => {
    await kebijakanShu(0, true);
    // Tahun buku 2026 (pendek) berakhir Juni; bunga baru aktif Agustus.
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('ap-2026', 2026, '2026-01-01', '2026-06-30', 'OPEN')`
    );
    await versiBunga('2026-08', true, 5);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(true); // tidak ada bulan aktif di Jan–Jun
    expect(await getSukarelaIkutJasaModalTahun(2027)).toBe(false);
  });

  it('(11) snapshot tahun buku tidak berubah setelah SHU dikunci', async () => {
    await kebijakanShu(0, true);
    await shu('t2026', 2026);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await barisShu('t2026'))).toBe(true);
    // Sesudahnya bunga dinyalakan untuk tahun yang sama: turunan berubah, snapshot tidak.
    await versiBunga('2026-11', true, 5);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(false);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await barisShu('t2026'))).toBe(true);
    expect(await snapshot('t2026')).toBe(1);
    expect(await getPerlakuanShuSukarela(2026)).toEqual({ tahunBuku: 2026, sukarelaIkut: true, sumber: 'SNAPSHOT' });
  });

  it('(12) migrasi tidak mengunci tahun buku DRAFT yang belum pernah dihitung', async () => {
    await shu('draft', 2026);
    await migrasiV78(testDb as never, tambahKolom);
    expect(await snapshot('draft')).toBeNull();
    // Snapshot baru terbentuk saat perhitungan pertama, memakai kebijakan turunan saat itu.
    await versiBunga('2026-02', true, 4);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, await barisShu('draft'))).toBe(false);
    expect(await snapshot('draft')).toBe(0);
  });

  it('(13) instalasi lama mempertahankan histori perilaku lama', async () => {
    await shu('lama', 2024, { status: 'DIBAGIKAN' });
    await shu('dihitung', 2025, { status: 'DIHITUNG', total_shu: 1_000 });
    await migrasiV78(testDb as never, tambahKolom);
    expect(await snapshot('lama')).toBe(1);
    expect(await snapshot('dihitung')).toBe(1);
    // Mengaktifkan bunga untuk tahun-tahun itu tidak mengubah snapshot lama.
    await versiBunga('2024-01', true, 5);
    for (const id of ['lama', 'dihitung']) expect(await tentukanSnapshotBasisJasaModal(testDb as never, await barisShu(id))).toBe(true);
    // Tahun tanpa bunga aktif tetap mengikuti kebijakan lama (ikut).
    await versiBunga('2025-01', false, 0);
    expect(await getSukarelaIkutJasaModalTahun(2025)).toBe(true);
  });

  it('(23) kombinasi kebijakan bunga × kebijakan SHU deterministik', async () => {
    const tabel: [boolean, boolean, boolean][] = [
      // [bungaAktif, kebijakanShuIkut, hasil]
      [true, true, false],
      [true, false, false],
      [false, true, true],
      [false, false, false],
    ];
    for (const [bunga, kebijakan, hasil] of tabel) {
      expect(turunkanSukarelaIkutBasis({ bungaAktifDiTahunBuku: bunga, kebijakanShuSukarelaIkut: kebijakan })).toBe(hasil);
    }
    await kebijakanShu(0, true);
    await versiBunga('2026-06', true, 5);
    const a = await getPerlakuanShuSukarela(2026);
    const b = await getPerlakuanShuSukarela(2026);
    expect(a).toEqual(b);
    expect(a).toEqual({ tahunBuku: 2026, sukarelaIkut: false, sumber: 'BUNGA_AKTIF' });
    expect(bungaAktifDalamRentang(await listVersiKebijakanBunga(), '2026-01', '2026-05')).toBe(false);
    expect(bungaAktifDalamRentang(await listVersiKebijakanBunga(), '2026-01', '2026-12')).toBe(true);
  });
});

// ==================================================================
// AKRUAL OTOMATIS — hanya periode selesai, idempoten
// ==================================================================
describe('akrual otomatis saat startup', () => {
  beforeEach(async () => {
    await siapkan();
    await simpanan('ang-1', 'SUKARELA', '2025-12-01', 3_650_000);
    await simpanan('ang-2', 'SUKARELA', '2025-12-01', 365_000_000);
  });

  it('(14) instalasi baru default OFF: tanpa kebijakan, tanpa akrual, tanpa jurnal', async () => {
    expect(await listVersiKebijakanBunga()).toEqual([]);
    expect(await getPerlakuanShuSukarela(2026)).toEqual({ tahunBuku: 2026, sukarelaIkut: false, sumber: 'KEBIJAKAN_SHU' });
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual([]);
    expect(await jumlahJurnal()).toBe(0);
  });

  it('(5) startup tidak mengakru saat bunga OFF', async () => {
    await versiBunga('2026-01', false, 0);
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual([]);
    expect(await jumlahJurnal()).toBe(0);
  });

  it('(6) startup mengakru periode yang sudah selesai saat bunga ON', async () => {
    HARI_INI = '2026-04-10';
    await versiBunga('2026-01', true, 10);
    const h = await jalankanAkrualBungaSukarelaOtomatis('user-1');
    expect(h).toMatchObject({ diproses: ['2026-01', '2026-02', '2026-03'], berhentiDi: null, pesan: null });
    expect(await jumlahJurnal()).toBe(3);
  });

  it('(7) bulan berjalan tidak diposting — termasuk pada hari terakhir bulan', async () => {
    HARI_INI = '2026-03-31';
    await versiBunga('2026-01', true, 10);
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual(['2026-01', '2026-02']);
    await expect(prosesAkrualBungaSukarela('user-1', '2026-03')).rejects.toThrow(/belum selesai/);
    expect(await posted()).toEqual(['2026-01', '2026-02']);
    // Keesokan harinya Maret sudah selesai.
    HARI_INI = '2026-04-01';
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual(['2026-03']);
  });

  it('(8) startup berulang idempoten: tidak ada jurnal ganda', async () => {
    HARI_INI = '2026-03-15';
    await versiBunga('2026-01', true, 10);
    for (let i = 0; i < 4; i++) await jalankanAkrualBungaSukarelaOtomatis('user-1');
    expect(await jumlahJurnal()).toBe(2);
    expect(await posted()).toEqual(['2026-01', '2026-02']);
  });

  it('(9) beberapa bulan tertinggal diproses satu per satu, berurutan, tanggal jurnal = akhir bulan', async () => {
    HARI_INI = '2026-07-02';
    await versiBunga('2026-01', true, 10);
    const h = await jalankanAkrualBungaSukarelaOtomatis('user-1');
    expect(h.diproses).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    const tgl = (
      await testDb.getAllAsync<{ tanggal: string }>(
        `SELECT tanggal FROM journal WHERE sumber_transaksi = 'SIMPANAN_SUKARELA_BUNGA' ORDER BY created_at, tanggal`
      )
    ).map((r) => r.tanggal);
    expect(tgl).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  });

  it('(10) perubahan tarif hanya berlaku ke depan', async () => {
    HARI_INI = '2026-03-10';
    await versiBunga('2026-01', true, 10);
    expect(await berlakuMinimumVersiBaru()).toBe('2026-04');
    await expect(simpanVersiKebijakanBunga('user-1', { aktif: true, tarifPersenTahun: 5, berlakuMulai: '2026-03' })).rejects.toThrow(/paling awal/);
    await simpanVersiKebijakanBunga('user-1', { aktif: true, tarifPersenTahun: 5, berlakuMulai: '2026-04' });
    HARI_INI = '2026-05-02';
    await jalankanAkrualBungaSukarelaOtomatis('user-1');
    const tarif = Object.fromEntries((await listProsesAkrual()).map((p) => [p.periode, p.tarifPersen]));
    expect(tarif).toEqual({ '2026-01': 10, '2026-02': 10, '2026-03': 10, '2026-04': 5 });
  });

  it('(22) perubahan ON/OFF tidak mengubah histori periode sebelumnya', async () => {
    HARI_INI = '2026-03-10';
    await versiBunga('2026-01', true, 10);
    await jalankanAkrualBungaSukarelaOtomatis('user-1');
    const sebelum = await listProsesAkrual();
    const versiSebelum = await listVersiKebijakanBunga();
    await simpanVersiKebijakanBunga('user-1', { aktif: false, tarifPersenTahun: 0, berlakuMulai: '2026-04' });
    HARI_INI = '2026-06-02';
    await jalankanAkrualBungaSukarelaOtomatis('user-1');
    // Maret tetap diakru (masih ON), April–Mei tidak (OFF).
    expect(await posted()).toEqual(['2026-01', '2026-02', '2026-03']);
    const sesudah = await listProsesAkrual();
    for (const p of sebelum) expect(sesudah.find((x) => x.id === p.id)).toEqual(p);
    // Histori kebijakan lama tetap ada; versi baru ditambahkan.
    const versiSesudah = await listVersiKebijakanBunga();
    expect(versiSesudah.slice(0, versiSebelum.length)).toEqual(versiSebelum);
    expect(versiSesudah).toHaveLength(versiSebelum.length + 1);
  });
});

// ==================================================================
// RUMUS & JURNAL — tidak berubah, dibuktikan ulang
// ==================================================================
describe('rumus, koreksi, jurnal, pajak (engine existing)', () => {
  const satu = (o: Partial<Parameters<typeof hitungBungaHarian>[0]> = {}) =>
    hitungBungaHarian({ periode: '2026-01', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10, ...o });

  it('(15) seluruh hari kalender termasuk hari terakhir bulan', () => {
    const h = satu();
    expect(h.jumlahHari).toBe(31);
    expect(h.ruas[h.ruas.length - 1].sampai).toBe('2026-01-31');
    expect(h.bunga).toBe(31_000);
  });

  it('(16) transaksi pada tanggal efektif memengaruhi saldo hari itu', () => {
    expect(satu({ saldoAwal: 0, mutasi: [{ tanggal: '2026-01-31', delta: 3_650_000 }] }).bunga).toBe(1_000);
    expect(satu({ mutasi: [{ tanggal: '2026-01-31', delta: -3_650_000 }] }).bunga).toBe(30_000);
  });

  it('(17) tahun kabisat tetap dibagi 365', () => {
    expect(hitungBungaHarian({ periode: '2024-02', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10 }).bunga).toBe(29_000);
    expect(hitungBungaHarian({ periode: '2024-12', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10 }).bunga).toBe(31_000);
  });

  it('(18) saldo nol/negatif tidak berbunga', () => {
    expect(satu({ saldoAwal: 0 }).bunga).toBe(0);
    expect(satu({ saldoAwal: -1_000_000 }).bunga).toBe(0);
  });

  describe('integrasi', () => {
    beforeEach(async () => {
      await siapkan();
      await simpanan('ang-1', 'SUKARELA', '2025-12-01', 3_650_000);
      await simpanan('ang-2', 'SUKARELA', '2025-12-01', 365_000_000);
    });

    it('(19) koreksi transaksi mundur -> selisih KOREKSI, tanpa jurnal ganda', async () => {
      HARI_INI = '2026-02-10';
      await versiBunga('2026-01', true, 10);
      await jalankanAkrualBungaSukarelaOtomatis('user-1');
      await simpanan('ang-1', 'SUKARELA', '2026-01-22', 3_650_000); // dicatat setelah Januari diakru
      HARI_INI = '2026-04-03';
      await jalankanAkrualBungaSukarelaOtomatis('user-1');
      await jalankanAkrualBungaSukarelaOtomatis('user-1');
      const k = await testDb.getAllAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE jenis = 'KOREKSI'`);
      expect(k).toHaveLength(1);
      expect(k[0]).toMatchObject({ anggota_id: 'ang-1', periode_bunga: '2026-01', bruto: 10_000 });
      expect(await jumlahJurnal()).toBe(3); // Jan, Feb, Mar — satu per bulan
    });

    it('(20) jurnal: Dr Beban Bunga Simpanan Sukarela, Cr Simpanan Sukarela, Cr Utang PPh', async () => {
      HARI_INI = '2026-02-10';
      await versiBunga('2026-01', true, 10);
      const p = await prosesAkrualBungaSukarela('user-1', '2026-01');
      const g = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
        `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
        p.journalId
      );
      const debit = g.filter((x) => x.debit > 0);
      expect(debit).toEqual([{ account_id: 'acc-beban', debit: p.totalBruto, kredit: 0 }]);
      expect(g.find((x) => x.account_id === 'acc-skr')?.kredit).toBe(p.totalNetto);
      const pph = g.filter((x) => x.kredit > 0 && x.account_id !== 'acc-skr');
      expect(pph).toHaveLength(1);
      expect(pph[0].kredit).toBe(p.totalPajak);
      const akunPph = await testDb.getFirstAsync<{ kode: string }>(`SELECT kode FROM account WHERE id = ?`, pph[0].account_id);
      expect(akunPph?.kode).toBe('2-1901');
    });

    it('(21) pajak dihitung oleh tax engine existing (per anggota per masa)', async () => {
      HARI_INI = '2026-02-10';
      await versiBunga('2026-01', true, 10);
      await prosesAkrualBungaSukarela('user-1', '2026-01');
      const r = await testDb.getAllAsync<{ bruto: number; pajak: number }>(`SELECT bruto, pajak FROM bunga_sukarela_rincian WHERE jenis = 'BUNGA'`);
      for (const x of r) expect(x.pajak).toBe(hitungPphBungaSimpanan(x.bruto));
      // Redesign tidak menulis tarif/threshold pajak sendiri.
      for (const f of ['src/services/KebijakanBasisJasaModalService.ts', 'src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx', 'src/config/panduanAplikasi.ts']) {
        expect([f, /240[._]?000/.test(baca(f))]).toEqual([f, false]);
      }
    });
  });
});

// ==================================================================
// AUDIT — satu sumber kebenaran, engine lain tidak tersentuh
// ==================================================================
describe('audit code path', () => {
  it('snapshot SHU memakai nilai turunan; ShuService tetap dua titik inisialisasi', () => {
    const k = baca('src/services/KebijakanBasisJasaModalService.ts');
    const fn = k.slice(k.indexOf('export async function tentukanSnapshotBasisJasaModal'));
    expect(fn).toContain('getSukarelaIkutJasaModalTahun(konfigurasi.tahun_buku, db)');
    expect(k).toContain("listVersiKebijakanBunga(db)");
    const svc = baca('src/services/ShuService.ts');
    expect((svc.match(/await tentukanSnapshotBasisJasaModal\(db, konfigurasi\)/g) ?? []).length).toBe(2);
  });

  it('status bunga hanya dibaca dari tabel kebijakan bunga berversi (tidak ada tabel kebijakan kedua)', () => {
    const schema = baca('src/database/schema.ts');
    expect((schema.match(/CREATE TABLE IF NOT EXISTS bunga_sukarela_kebijakan/g) ?? []).length).toBe(1);
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS \w*kebijakan_bunga\w*/);
  });
});
