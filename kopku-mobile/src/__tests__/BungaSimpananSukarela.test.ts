import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * BUNGA HARIAN SIMPANAN SUKARELA + BASIS JASA MODAL SHU (kebijakan, v78).
 * Definisi: bunga hari = saldo AKHIR hari × tarif ÷ 365, seluruh hari kalender.
 */
let testDb: TestDb;

// RC-S93: `...requireActual` — tanpa ini `migrasiV78` ikut ter-mock menjadi
// undefined dan test migrasi di bawah gagal (TypeError), bukan gagal assertion.
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

import { hitungBungaHarian, bungaSatuHari } from '@/accounting/BungaSimpananSukarela';
import {
  batalkanAkrualBungaSukarela,
  bulanTertunda,
  getRingkasanBungaAnggota,
  jalankanAkrualBungaSukarelaOtomatis,
  kebijakanUntukBulan,
  listProsesAkrual,
  pratinjauAkrualBungaSukarela,
  prosesAkrualBungaSukarela,
  validasiDrafKebijakanBunga,
  type VersiKebijakanBunga,
} from '@/services/BungaSukarelaService';
import {
  basisJasaModalUntukTahun,
  getSukarelaIkutJasaModalTahun,
  simpanVersiBasisJasaModal,
  tentukanSnapshotBasisJasaModal,
} from '@/services/KebijakanBasisJasaModalService';
import { getBasisAnggotaSHU } from '@/services/ShuService';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { migrasiV78 } from '@/database/db';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ==================================================================
// A. MESIN HITUNG (murni)
// ==================================================================
describe('mesin bunga harian: saldo akhir hari × tarif ÷ 365, seluruh hari kalender', () => {
  const satu = (o: Partial<Parameters<typeof hitungBungaHarian>[0]> = {}) =>
    hitungBungaHarian({ periode: '2026-01', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10, ...o });

  it('saldo tetap satu bulan: 31 hari × Rp1.000 = Rp31.000', () => {
    const h = satu();
    expect(h.jumlahHari).toBe(31);
    expect(h.bunga).toBe(31_000);
    expect(h.ruas).toEqual([{ dari: '2026-01-01', sampai: '2026-01-31', hari: 31, saldo: 3_650_000 }]);
  });

  it('setoran di tengah bulan berlaku mulai tanggal setoran (16–31 = 16 hari)', () => {
    expect(satu({ saldoAwal: 0, mutasi: [{ tanggal: '2026-01-16', delta: 3_650_000 }] }).bunga).toBe(16_000);
  });

  it('penarikan di tengah bulan: saldo akhir hari tanggal penarikan sudah nol (1–10 = 10 hari)', () => {
    expect(satu({ mutasi: [{ tanggal: '2026-01-11', delta: -3_650_000 }] }).bunga).toBe(10_000);
  });

  it('beberapa mutasi: contoh rekening Lampiran 10 dengan 31 hari penuh = Rp11.309', () => {
    const h = hitungBungaHarian({
      periode: '2022-12',
      saldoAwal: 150_000,
      mutasi: [
        { tanggal: '2022-12-03', delta: 500_000 },
        { tanggal: '2022-12-10', delta: 1_000_000 },
        { tanggal: '2022-12-23', delta: -750_000 },
      ],
      tarifPersenTahun: 12,
    });
    expect(h.ruas.map((r) => r.hari)).toEqual([2, 7, 13, 9]);
    expect(h.bunga).toBe(11_309);
  });

  it('beberapa mutasi pada hari yang sama memakai saldo akhir hari itu', () => {
    const h = satu({ saldoAwal: 0, mutasi: [{ tanggal: '2026-01-31', delta: 3_650_000 }, { tanggal: '2026-01-31', delta: -3_650_000 }] });
    expect(h.bunga).toBe(0);
  });

  it('saldo nol & negatif tidak berbunga', () => {
    expect(satu({ saldoAwal: 0 }).bunga).toBe(0);
    expect(satu({ saldoAwal: -500_000 }).bunga).toBe(0);
  });

  it('tahun kabisat: Februari 2024 = 29 hari, basis tetap 365', () => {
    expect(hitungBungaHarian({ periode: '2024-02', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10 }).bunga).toBe(29_000);
  });

  it('perkiraan berjalan s.d. tanggal tertentu & bunga satu hari', () => {
    expect(satu({ sampaiTanggal: '2026-01-10' }).bunga).toBe(10_000);
    expect(bungaSatuHari(3_650_000, 10)).toBeCloseTo(1_000, 6);
  });
});

describe('kebijakan bunga berversi', () => {
  const v = (berlakuMulai: string, aktif: boolean, tarif: number): VersiKebijakanBunga => ({
    id: berlakuMulai,
    berlakuMulai,
    aktif,
    tarifPersenTahun: tarif,
    createdAt: berlakuMulai,
  });
  const versi = [v('2026-01', true, 6), v('2026-03', true, 3), v('2026-05', false, 0)];

  it('perubahan tarif berlaku mulai bulannya; OFF menghentikan akrual', () => {
    expect(kebijakanUntukBulan(versi, '2025-12')).toBeNull();
    expect(kebijakanUntukBulan(versi, '2026-02')?.tarifPersenTahun).toBe(6);
    expect(kebijakanUntukBulan(versi, '2026-03')?.tarifPersenTahun).toBe(3);
    expect(kebijakanUntukBulan(versi, '2026-06')?.aktif).toBe(false);
    expect(bulanTertunda(versi, new Set(['2026-01']), '2026-12-31')).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('validasi: hanya berlaku ke depan, tarif <= 9%', () => {
    expect(validasiDrafKebijakanBunga({ aktif: true, tarifPersenTahun: 5, berlakuMulai: '2026-10' }, '2026-11')).toMatch(/paling awal/);
    expect(validasiDrafKebijakanBunga({ aktif: true, tarifPersenTahun: 9.5, berlakuMulai: '2026-11' }, '2026-11')).toMatch(/9%/);
    expect(validasiDrafKebijakanBunga({ aktif: true, tarifPersenTahun: 5, berlakuMulai: '2026-11' }, '2026-11')).toBeNull();
  });
});

// ==================================================================
// B. INTEGRASI DATABASE
// ==================================================================
const now = () => new Date().toISOString();

async function siapkan() {
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
    ['acc-pokok', '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT'],
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
async function simpanan(anggota: string, jenis: string, tanggal: string, nominal: number, tipe = 'SETOR'): Promise<string> {
  urut += 1;
  const id = `trx-${urut}`;
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?,'KAS',?,'user-1',?)`,
    id, anggota, jenis, tipe, tanggal, nominal, `N-${urut}`, now()
  );
  return id;
}

async function versiBunga(berlakuMulai: string, aktif: boolean, tarif: number) {
  await testDb.runAsync(
    `INSERT INTO bunga_sukarela_kebijakan (id, berlaku_mulai, aktif, tarif_persen, created_by, created_at) VALUES (?,?,?,?,'user-1',?)`,
    `kb-${berlakuMulai}-${tarif}`, berlakuMulai, aktif ? 1 : 0, tarif, now()
  );
}

const saldoSkr = (a: string) => getSaldoSimpanan(testDb as never, a, 'SUKARELA');
const jumlahJurnal = async () => (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'SIMPANAN_SUKARELA_BUNGA'`))?.n ?? 0;

describe('akrual bulanan', () => {
  beforeEach(async () => {
    await siapkan();
    // Andi 3,65 jt sejak 2025; Budi 365 jt (bunga > Rp240.000 -> PPh 10%).
    await simpanan('ang-1', 'SUKARELA', '2025-12-01', 3_650_000);
    await simpanan('ang-2', 'SUKARELA', '2025-12-01', 365_000_000);
    // Jenis simpanan lain tidak memengaruhi bunga sukarela.
    await simpanan('ang-1', 'POKOK', '2025-12-01', 500_000);
    await simpanan('ang-1', 'WAJIB', '2026-01-10', 100_000);
  });

  it('OFF (tanpa kebijakan): tidak ada akrual maupun jurnal', async () => {
    await expect(prosesAkrualBungaSukarela('user-1', '2026-01')).rejects.toThrow(/tidak aktif/);
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual([]);
    expect(await jumlahJurnal()).toBe(0);
  });

  it('ON: bunga masuk saldo sukarela; jurnal seimbang; PPh via mesin existing; audit trail lengkap', async () => {
    await versiBunga('2026-01', true, 10);
    const p = await prosesAkrualBungaSukarela('user-1', '2026-01');
    // Andi: 1.000/hari × 31 = 31.000 (PPh 0). Budi: 100.000/hari × 31 = 3.100.000 (PPh 310.000).
    expect(p).toMatchObject({ totalBruto: 3_131_000, totalPajak: 310_000, totalNetto: 2_821_000, jumlahAnggota: 2, status: 'POSTED' });
    expect(await saldoSkr('ang-1')).toBe(3_681_000);
    expect(await saldoSkr('ang-2')).toBe(365_000_000 + 2_790_000);
    // Pokok/wajib tidak tersentuh.
    expect(await getSaldoSimpanan(testDb as never, 'ang-1', 'POKOK')).toBe(500_000);

    const g = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, p.journalId);
    expect(g.reduce((t, x) => t + x.debit, 0)).toBe(g.reduce((t, x) => t + x.kredit, 0));

    const r = await testDb.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE anggota_id = 'ang-1'`);
    expect(r).toMatchObject({ jenis: 'BUNGA', periode_bunga: '2026-01', tarif_persen: 10, jumlah_hari: 31, saldo_awal: 3_650_000, bruto: 31_000, pajak: 0, netto: 31_000 });
    expect(r.saldo_hari).toBe(3_650_000 * 31);
    expect(JSON.parse(r.ruas_saldo)).toHaveLength(1);
    expect(r.created_at).toBeTruthy();
  });

  it('re-run akrual idempoten: proses sama, tidak ada jurnal kedua, saldo tidak berlipat', async () => {
    await versiBunga('2026-01', true, 10);
    const a = await prosesAkrualBungaSukarela('user-1', '2026-01');
    const b = await prosesAkrualBungaSukarela('user-1', '2026-01');
    expect(b.id).toBe(a.id);
    expect(await jumlahJurnal()).toBe(1);
    expect(await saldoSkr('ang-1')).toBe(3_681_000);
    await jalankanAkrualBungaSukarelaOtomatis('user-1');
    const proses = await listProsesAkrual();
    expect(new Set(proses.map((x) => x.periode)).size).toBe(proses.length);
  });

  it('perubahan tarif efektif mulai periode berikutnya; bunga bulan lalu ikut berbunga bulan berikutnya', async () => {
    await versiBunga('2026-01', true, 10);
    await versiBunga('2026-02', true, 5);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    const feb = await prosesAkrualBungaSukarela('user-1', '2026-02');
    expect(feb.tarifPersen).toBe(5);
    const r = await testDb.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE anggota_id = 'ang-1' AND periode_bunga = '2026-02'`);
    // Saldo Feb = 3.681.000 (termasuk bunga Jan) × 5% ÷ 365 × 28 hari
    expect(r.saldo_awal).toBe(3_681_000);
    expect(r.bruto).toBe(Math.floor((3_681_000 * 28 * 5) / 100 / 365));
  });

  it('urutan wajib: bulan sebelumnya harus diakru lebih dulu', async () => {
    await versiBunga('2026-01', true, 10);
    await expect(prosesAkrualBungaSukarela('user-1', '2026-02')).rejects.toThrow(/Januari 2026/);
  });

  it('transaksi bertanggal mundur ke bulan yang sudah diakru: selisih dibukukan sebagai KOREKSI di akrual berikutnya, tanpa bunga ganda', async () => {
    await versiBunga('2026-01', true, 10);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    // Setoran 3,65 jt bertanggal 22 Jan dicatat SETELAH Januari diakru (22–31 = 10 hari = 10.000).
    await simpanan('ang-1', 'SUKARELA', '2026-01-22', 3_650_000);
    const feb = await prosesAkrualBungaSukarela('user-1', '2026-02');
    const k = await testDb.getAllAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE jenis = 'KOREKSI'`);
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ anggota_id: 'ang-1', periode_bunga: '2026-01', bruto: 10_000, proses_id: feb.id });
    // Akrual Maret tidak mengulang koreksi yang sama.
    await prosesAkrualBungaSukarela('user-1', '2026-03');
    expect(await testDb.getAllAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE jenis = 'KOREKSI'`)).toHaveLength(1);
  });

  it('pembatalan (koreksi) transaksi di bulan yang sudah diakru menghasilkan koreksi negatif', async () => {
    await versiBunga('2026-01', true, 10);
    const trx = await simpanan('ang-1', 'SUKARELA', '2026-01-22', 3_650_000);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    // Batalkan setoran itu lewat baris koreksi (pola existing: reversal_of_id).
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, reversal_of_id, created_by, created_at)
       VALUES ('kor-1','ang-1','SUKARELA','KOREKSI','2026-02-05',3650000,'KAS','KOREKSI-x',?,'user-1',?)`,
      trx,
      now()
    );
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    const k = await testDb.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_rincian WHERE jenis = 'KOREKSI'`);
    expect(k).toMatchObject({ anggota_id: 'ang-1', periode_bunga: '2026-01', bruto: -10_000, netto: -10_000 });
  });

  it('anggota keluar (hak dibayar) tidak menerima bunga bulan keluarnya', async () => {
    await versiBunga('2026-01', true, 10);
    await testDb.runAsync(
      `INSERT INTO keluar_anggota (id, anggota_id, alasan_keluar, tanggal_pengajuan, tanggal_efektif_keluar, diajukan_oleh,
                                   status_pengajuan, tanggal_pembayaran, created_at, updated_at)
       VALUES ('k1','ang-2','MENGUNDURKAN_DIRI','2026-01-10','2026-01-15','user-1','DIBAYAR','2026-01-20',?,?)`,
      now(),
      now()
    );
    const p = await pratinjauAkrualBungaSukarela('2026-01');
    expect(p.baris.some((b) => b.anggotaId === 'ang-2')).toBe(false);
  });

  it('batal hanya dari bulan terakhir; saldo kembali; bulan dapat diakru ulang', async () => {
    await versiBunga('2026-01', true, 10);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    await prosesAkrualBungaSukarela('user-1', '2026-02');
    await expect(batalkanAkrualBungaSukarela('user-1', '2026-01', 'x')).rejects.toThrow(/Februari 2026/);
    await batalkanAkrualBungaSukarela('user-1', '2026-02', 'tarif salah');
    await batalkanAkrualBungaSukarela('user-1', '2026-01', 'tarif salah');
    expect(await saldoSkr('ang-1')).toBe(3_650_000);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    expect(await saldoSkr('ang-1')).toBe(3_681_000);
  });

  it('otomatis: semua bulan aktif yang sudah berakhir diakru berurutan, sekali saja', async () => {
    await versiBunga('2026-01', true, 10);
    const h = await jalankanAkrualBungaSukarelaOtomatis('user-1');
    expect(h.diproses[0]).toBe('2026-01');
    expect(h.diproses).toEqual([...h.diproses].sort());
    expect((await jalankanAkrualBungaSukarelaOtomatis('user-1')).diproses).toEqual([]);
  });

  it('detail anggota: saldo, bunga yang sudah masuk saldo, PPh', async () => {
    await versiBunga('2026-01', true, 10);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    const r = await getRingkasanBungaAnggota('ang-2');
    expect(r.totalBungaMasukSaldo).toBe(2_790_000);
    expect(r.totalPphDipotong).toBe(310_000);
    expect(r.aktifBulanIni).toBe(true);
    expect(r.bungaHariIni).toBeGreaterThan(0);
  });
});

// ==================================================================
// C. BASIS JASA MODAL SHU
// ==================================================================
describe('Simpanan Sukarela sebagai Basis Jasa Modal SHU', () => {
  beforeEach(async () => {
    await siapkan();
    await simpanan('ang-1', 'POKOK', '2026-01-01', 100_000);
    await simpanan('ang-1', 'WAJIB', '2026-02-01', 200_000);
    await simpanan('ang-1', 'SUKARELA', '2026-01-01', 1_000_000);
    await versiBunga('2026-01', true, 10);
    await prosesAkrualBungaSukarela('user-1', '2026-01');
  });
  const basis = async (ikut: boolean) =>
    (await getBasisAnggotaSHU(testDb as never, '2026-01-01', '2026-12-31', ikut)).find((b) => b.anggotaId === 'ang-1')?.basisSimpanan;

  it('OFF: sukarela & bunga yang sudah dikreditkan TIDAK masuk basis (hanya pokok + wajib)', async () => {
    expect(await basis(false)).toBe(300_000);
  });

  it('ON: sukarela termasuk bunga masuk basis', async () => {
    const bunga = (await testDb.getFirstAsync<{ n: number }>(`SELECT SUM(netto) AS n FROM bunga_sukarela_rincian`))!.n;
    expect(await basis(true)).toBe(300_000 + 1_000_000 + bunga);
  });

  it('instalasi baru default OFF; versi baru hanya berlaku ke depan', async () => {
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(false);
    await expect(simpanVersiBasisJasaModal('user-1', true, 2020)).rejects.toThrow(/ke depan/);
  });

  it('snapshot per tahun buku: perubahan kebijakan sesudah SHU dihitung tidak mengubah tahun itu', async () => {
    await testDb.runAsync(`INSERT INTO kebijakan_basis_jasa_modal (id, berlaku_mulai_tahun, sukarela_ikut, created_by, created_at) VALUES ('v1', 0, 1, 'x', ?)`, now());
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, created_at, updated_at) VALUES ('shu-2026', 2026, ?, ?)`,
      now(),
      now()
    );
    const k = await testDb.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE id = 'shu-2026'`);
    // RC-S93: bunga sukarela aktif di 2026 (beforeEach) -> turunan = tidak ikut,
    // walau kebijakan SHU koperasi (v1) = ikut. Snapshot menyimpan hasil turunan.
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, k)).toBe(false);
    // Keadaan kebijakan berubah sesudahnya (bunga 2026 dihapus paksa -> turunan
    // menjadi "ikut") — snapshot 2026 TETAP tidak ikut.
    await testDb.runAsync(`DELETE FROM bunga_sukarela_kebijakan`);
    expect(await getSukarelaIkutJasaModalTahun(2026)).toBe(true);
    const k2 = await testDb.getFirstAsync<any>(`SELECT * FROM shu_konfigurasi WHERE id = 'shu-2026'`);
    expect(k2.sukarela_basis_jasa_modal).toBe(0);
    expect(await tentukanSnapshotBasisJasaModal(testDb as never, k2)).toBe(false);
  });

  it('versi per tahun buku: (sejak awal ON, 2027 OFF) -> 2026 ON, 2027 OFF', () => {
    const v = [
      { id: 'a', berlakuMulaiTahun: 0, sukarelaIkut: true, createdAt: '' },
      { id: 'b', berlakuMulaiTahun: 2027, sukarelaIkut: false, createdAt: '' },
    ];
    expect(basisJasaModalUntukTahun(v, 2026)).toBe(true);
    expect(basisJasaModalUntukTahun(v, 2027)).toBe(false);
    expect(basisJasaModalUntukTahun([], 2026)).toBe(false);
  });
});

// ==================================================================
// D. MIGRASI v78 & REGISTRI
// ==================================================================
describe('migrasi v78 (instalasi lama) & registri', () => {
  // DIPERBARUI (hotfix snapshot DRAFT): baris SHU lama yang SUDAH DIHITUNG
  // dikunci ON; baris DRAFT yang belum pernah dihitung tidak lagi dikunci
  // migrasi (diuji di SnapshotBasisJasaModalDraftV78.test.ts).
  it('instalasi lama: basis jasa modal ON dipertahankan, snapshot SHU lama yang sudah dihitung = 1, kebijakan bunga tetap OFF; idempoten', async () => {
    await siapkan();
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, status, total_shu, created_at, updated_at) VALUES ('shu-2025', 2025, 'DIHITUNG', 1000, ?, ?)`,
      now(),
      now()
    );
    const tambah = async () => undefined;
    await migrasiV78(testDb as never, tambah);
    await migrasiV78(testDb as never, tambah);
    expect(await getSukarelaIkutJasaModalTahun(2030)).toBe(true);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM kebijakan_basis_jasa_modal`))!.n).toBe(1);
    expect((await testDb.getFirstAsync<any>(`SELECT sukarela_basis_jasa_modal AS s FROM shu_konfigurasi WHERE id = 'shu-2025'`))!.s).toBe(1);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM bunga_sukarela_kebijakan`))!.n).toBe(0);
  });

  it('arus kas NON_KAS; akun & pemetaan default; dipicu startup setelah berjangka; menu di Penyesuaian', () => {
    expect(CASH_FLOW_CLASSIFICATION.SIMPANAN_SUKARELA_BUNGA).toBe('NON_KAS');
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '5-1956')).toMatchObject({ kategori: 'BEBAN', lhuKlasifikasi: 'BEBAN_USAHA' });
    expect(DEFAULT_ACCOUNT_MAPPING).toContainEqual({ transactionType: 'SIMPANAN_SUKARELA_BUNGA', role: 'DEBIT_BEBAN', accountKode: '5-1956' });
    const s = baca('src/services/StartupTasks.ts');
    expect(s.indexOf('jalankanCatchUpAkrualSimpananBerjangka(userId)')).toBeLessThan(s.indexOf('jalankanAkrualBungaSukarelaOtomatis(userId)'));
    expect(baca('src/screens/Transaksi/PenyesuaianScreen.tsx')).toContain("route: 'BungaSimpananSukarela'");
  });

  it('tidak bercampur dengan simpanan berjangka & tidak membuat tarif pajak sendiri', () => {
    const svc = baca('src/services/BungaSukarelaService.ts');
    expect(svc).not.toMatch(/simpanan_berjangka(?!_id)/);
    // RC-S127: mesin pajak agregat lintas produk (pajakPolicy.hitungPphBungaSimpananAgregat via PphPotongService).
    expect(svc).toMatch(/buatPenghitungPphAgregat\(/);
    expect(svc).not.toMatch(/hitungPphBungaSimpanan\(/);
    expect(svc).not.toMatch(/240[._]?000|\b0\.1\b|10 \/ 100/);
  });
});
