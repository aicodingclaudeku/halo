import { TestDb } from './testDb';

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

import { buatFixtureHistoris, USER_ID } from './historicalFixture';
import {
  bacaParameterLpea,
  bagianShuAnggota,
  basisPinjaman,
  basisSimpananBerjangka,
  basisTabungan,
  kunciKonfigLpea,
  rincianBagianShuAnggota,
  selisihHari,
  simpanParameterLpea,
  susunKomponenLpea,
} from '@/reports/LpeaRepository';
import { parameterLpeaKosong, rakitLaporanLpea, type ParameterLpea } from '@/reports/LpeaPlan';

/**
 * RC-S101 — LPEA DARI DATA AKTUAL (SQLite sungguhan, skema asli).
 *
 * §LpeaNaskahRcS101 sudah membuktikan RUMUS-nya sama dengan naskah. Yang
 * dibuktikan di sini adalah hal yang berbeda dan sama pentingnya:
 *  - basisnya (a) diambil dari transaksi yang BENAR ADA, bukan dikarang;
 *  - tarif koperasi (b) dibaca dari data untuk pinjaman & simpanan
 *    berjangka, sehingga tidak perlu ditebak;
 *  - bagian SHU HANYA terbaca bila pembagiannya sudah berstatus
 *    DIBAGIKAN (hasil `bagikanSHU()`);
 *  - tidak ada penghitungan ganda antara saldo simpanan dan SHU.
 */

const ANG = { a1: 'ang-lpea-1', a2: 'ang-lpea-2' };

async function seedAnggota(db: TestDb, id: string, nomor: string, nama: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,'AKTIF',?,?)`,
    id,
    nomor,
    nama,
    '2026-01-02',
    now,
    now
  );
}

/** Pinjaman + jadwalnya, ditulis langsung supaya basis (a) dapat dikendalikan persis. */
async function seedPinjaman(
  db: TestDb,
  opsi: {
    id: string;
    nomor: string;
    anggotaId: string;
    tanggal: string;
    jumlah: number;
    persentaseJasa: number;
    satuanTenor: 'HARI' | 'MINGGU' | 'BULAN';
    status?: string;
    jadwal: { pokok: number; pokokTerbayar: number; status: string }[];
  }
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
                           metode_jasa, persentase_jasa, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'FLAT',?,?,?,?,?)`,
    opsi.id,
    opsi.nomor,
    opsi.anggotaId,
    opsi.tanggal,
    opsi.jumlah,
    opsi.jadwal.length,
    opsi.satuanTenor,
    opsi.persentaseJasa,
    opsi.status ?? 'AKTIF',
    USER_ID,
    now,
    now
  );
  let i = 0;
  for (const j of opsi.jadwal) {
    i += 1;
    await db.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo,
                                    pokok, jasa, denda, total, pokok_terbayar, jasa_terbayar, denda_terbayar, status)
       VALUES (?,?,?,?,?,0,0,?,?,0,0,?)`,
      `${opsi.id}-j${i}`,
      opsi.id,
      i,
      opsi.tanggal,
      j.pokok,
      j.pokok,
      j.pokokTerbayar,
      j.status
    );
  }
}

async function seedSimpanan(
  db: TestDb,
  opsi: { id: string; anggotaId: string; jenis: string; tipe: string; nominal: number; tanggal: string }
) {
  await db.runAsync(
    `INSERT INTO simpanan_transaksi
       (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,?,?,?, 'KAS', ?, ?, ?)`,
    opsi.id,
    opsi.anggotaId,
    opsi.jenis,
    opsi.tipe,
    opsi.tanggal,
    opsi.nominal,
    `TX-${opsi.id}`,
    USER_ID,
    new Date().toISOString()
  );
}

async function seedBerjangka(
  db: TestDb,
  opsi: { id: string; anggotaId: string; nominal: number; sukuBunga: number; mulai: string; status?: string }
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO simpanan_berjangka
       (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
        suku_bunga, status, sumber_dana, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,12,?,?, 'KAS', ?, ?, ?)`,
    opsi.id,
    opsi.anggotaId,
    `SB-${opsi.id}`,
    opsi.mulai,
    '2027-01-01',
    opsi.nominal,
    opsi.sukuBunga,
    opsi.status ?? 'AKTIF',
    USER_ID,
    now,
    now
  );
}

async function seedShu(
  db: TestDb,
  opsi: { tahun: number; status: string; disahkan: number; anggota: { id: string; modal: number; usaha: number }[] }
) {
  const now = new Date().toISOString();
  const konfigId = `shu-${opsi.tahun}`;
  await db.runAsync(
    `INSERT INTO shu_konfigurasi (id, tahun_buku, total_shu, shu_disahkan_rat, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    konfigId,
    opsi.tahun,
    opsi.disahkan,
    opsi.disahkan,
    opsi.status,
    now,
    now
  );
  let i = 0;
  for (const a of opsi.anggota) {
    i += 1;
    await db.runAsync(
      `INSERT INTO shu_anggota (id, shu_konfigurasi_id, anggota_id, basis_simpanan, basis_partisipasi_usaha,
                                jasa_modal, jasa_usaha, total_shu_anggota)
       VALUES (?,?,?,0,0,?,?,?)`,
      `${konfigId}-${i}`,
      konfigId,
      a.id,
      a.modal,
      a.usaha,
      a.modal + a.usaha
    );
  }
}

const AKHIR = '2026-12-31';

describe('RC-S101 §1 — basis pinjaman dari sisa pokok yang benar-benar tercatat', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
    await seedAnggota(testDb, ANG.a2, 'A-002', 'Sari');
  });

  test('sisa pokok = pokok − pokok_terbayar, dan tarif dibaca dari data', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-1',
      nomor: 'PJ-001',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 20_000_000,
      persentaseJasa: 2.5,
      satuanTenor: 'BULAN',
      jadwal: [
        { pokok: 10_000_000, pokokTerbayar: 10_000_000, status: 'LUNAS' },
        { pokok: 10_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' },
      ],
    });

    const basis = await basisPinjaman(testDb as never, AKHIR);
    expect(basis.baris).toHaveLength(1);
    // 20.000.000 − 10.000.000 terbayar = 10.000.000
    expect(basis.baris[0].basis).toBe(10_000_000);
    // Tarif koperasi (b) dibaca dari `persentase_jasa`, bukan diminta pengguna.
    expect(basis.baris[0].tarifKoperasiPersenPerBulan).toBe(2.5);
    expect(basis.baris[0].keterangan).toContain('PJ-001');
    expect(basis.tarifKoperasiSeragam).toBeNull();
  });

  test('jadwal obsolete (digantikan akad ulang) TIDAK dihitung dua kali', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-2',
      nomor: 'PJ-002',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 30_000_000,
      persentaseJasa: 2,
      satuanTenor: 'BULAN',
      jadwal: [
        // Jadwal lama yang sudah digantikan — harus diabaikan.
        { pokok: 30_000_000, pokokTerbayar: 0, status: 'DIRESTRUKTURISASI' },
        { pokok: 12_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' },
      ],
    });
    const basis = await basisPinjaman(testDb as never, AKHIR);
    // Hanya jadwal yang bukan obsolete: 12.000.000, bukan 42.000.000.
    expect(basis.baris[0].basis).toBe(12_000_000);
  });

  test('pinjaman yang belum cair / ditolak tidak masuk basis', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-3',
      nomor: 'PJ-003',
      anggotaId: ANG.a2,
      tanggal: '2026-03-01',
      jumlah: 5_000_000,
      persentaseJasa: 2,
      satuanTenor: 'BULAN',
      status: 'DIAJUKAN',
      jadwal: [{ pokok: 5_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });
    expect((await basisPinjaman(testDb as never, AKHIR)).baris).toHaveLength(0);
  });

  test('pinjaman setelah akhir periode tidak masuk — laporan adalah keadaan sampai akhir periode', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-4',
      nomor: 'PJ-004',
      anggotaId: ANG.a2,
      tanggal: '2027-01-05',
      jumlah: 7_000_000,
      persentaseJasa: 2,
      satuanTenor: 'BULAN',
      jadwal: [{ pokok: 7_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });
    expect((await basisPinjaman(testDb as never, AKHIR)).baris).toHaveLength(0);
  });

  test('tenor mingguan dikonversi ke per bulan, bukan dipakai apa adanya', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-5',
      nomor: 'PJ-005',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 4_000_000,
      persentaseJasa: 0.5,
      satuanTenor: 'MINGGU',
      jadwal: [{ pokok: 4_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });
    const basis = await basisPinjaman(testDb as never, AKHIR);
    expect(basis.baris[0].tarifKoperasiPersenPerBulan).toBe(2); // 0,5% x 4 minggu
  });
});

describe('RC-S101 §2 — basis tabungan: sukarela SAJA, supaya tidak berhitung ganda dengan SHU', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
  });

  test('saldo sukarela = setor − tarik', async () => {
    await seedSimpanan(testDb, { id: 's1', anggotaId: ANG.a1, jenis: 'SUKARELA', tipe: 'SETOR', nominal: 3_000_000, tanggal: '2026-03-01' });
    await seedSimpanan(testDb, { id: 's2', anggotaId: ANG.a1, jenis: 'SUKARELA', tipe: 'TARIK', nominal: 1_000_000, tanggal: '2026-04-01' });
    const basis = await basisTabungan(testDb as never, AKHIR, 2);
    expect(basis.baris).toHaveLength(1);
    expect(basis.baris[0].basis).toBe(2_000_000);
    expect(basis.baris[0].tarifKoperasiPersenPerBulan).toBe(2);
    expect(basis.tarifKoperasiSeragam).toBe(2);
  });

  test('simpanan POKOK & WAJIB TIDAK masuk basis tabungan', async () => {
    // Keduanya setoran MODAL yang imbalannya jasa modal di pembagian SHU.
    // Memasukkannya akan menghitung manfaat yang sama dua kali.
    await seedSimpanan(testDb, { id: 's3', anggotaId: ANG.a1, jenis: 'POKOK', tipe: 'SETOR', nominal: 100_000, tanggal: '2026-01-05' });
    await seedSimpanan(testDb, { id: 's4', anggotaId: ANG.a1, jenis: 'WAJIB', tipe: 'SETOR', nominal: 5_000_000, tanggal: '2026-01-05' });
    expect((await basisTabungan(testDb as never, AKHIR, 2)).baris).toHaveLength(0);
  });

  test('saldo nol atau negatif tidak dilaporkan sebagai basis', async () => {
    await seedSimpanan(testDb, { id: 's5', anggotaId: ANG.a1, jenis: 'SUKARELA', tipe: 'SETOR', nominal: 1_000_000, tanggal: '2026-03-01' });
    await seedSimpanan(testDb, { id: 's6', anggotaId: ANG.a1, jenis: 'SUKARELA', tipe: 'TARIK', nominal: 1_000_000, tanggal: '2026-04-01' });
    expect((await basisTabungan(testDb as never, AKHIR, 2)).baris).toHaveLength(0);
  });

  test('tarif koperasi null (belum diisi) tetap menghasilkan basis, tarifnya 0 dan dikunci di lapisan rencana', async () => {
    await seedSimpanan(testDb, { id: 's7', anggotaId: ANG.a1, jenis: 'SUKARELA', tipe: 'SETOR', nominal: 2_000_000, tanggal: '2026-03-01' });
    const basis = await basisTabungan(testDb as never, AKHIR, null);
    expect(basis.baris[0].basis).toBe(2_000_000);
    expect(basis.tarifKoperasiSeragam).toBeNull();
  });
});

describe('RC-S101 §3 — basis simpanan berjangka & prorata umur', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
  });

  test('suku bunga tahunan dikonversi ke per bulan', async () => {
    await seedBerjangka(testDb, { id: 'sb1', anggotaId: ANG.a1, nominal: 100_000_000, sukuBunga: 30, mulai: '2026-01-10' });
    const basis = await basisSimpananBerjangka(testDb as never, AKHIR);
    expect(basis.baris[0].basis).toBe(100_000_000);
    expect(basis.baris[0].tarifKoperasiPersenPerBulan).toBe(2.5); // 30%/tahun
    // Sudah jauh lebih dari sebulan -> penuh, tanpa prorata.
    expect(basis.baris[0].hariProrata).toBeUndefined();
  });

  test('yang belum genap sebulan diprorata per hari, seperti baris kedua buku pembantu D', async () => {
    // Mulai 2026-12-22 -> umur 9 hari pada 2026-12-31.
    await seedBerjangka(testDb, { id: 'sb2', anggotaId: ANG.a1, nominal: 50_000_000, sukuBunga: 30, mulai: '2026-12-22' });
    const basis = await basisSimpananBerjangka(testDb as never, AKHIR);
    expect(basis.baris[0].hariProrata).toBe(9);
  });

  test('simpanan yang sudah dicairkan tidak lagi menjadi basis', async () => {
    await seedBerjangka(testDb, { id: 'sb3', anggotaId: ANG.a1, nominal: 10_000_000, sukuBunga: 12, mulai: '2026-02-01', status: 'DICAIRKAN' });
    expect((await basisSimpananBerjangka(testDb as never, AKHIR)).baris).toHaveLength(0);
  });

  test('selisihHari menghitung kalender murni & aman terhadap tanggal rusak', () => {
    expect(selisihHari('2026-12-22', '2026-12-31')).toBe(9);
    expect(selisihHari('2026-01-01', '2026-01-01')).toBe(0);
    expect(selisihHari('bukan-tanggal', '2026-01-01')).toBe(0);
  });
});

describe('RC-S101 §4 — bagian SHU hanya dari pembagian yang sudah diproses', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
    await seedAnggota(testDb, ANG.a2, 'A-002', 'Sari');
  });

  test('status DIBAGIKAN -> terbaca, dengan total & jumlah penerima', async () => {
    await seedShu(testDb, {
      tahun: 2026,
      status: 'DIBAGIKAN',
      disahkan: 50_000_000,
      anggota: [
        { id: ANG.a1, modal: 1_000_000, usaha: 2_000_000 },
        { id: ANG.a2, modal: 500_000, usaha: 1_500_000 },
      ],
    });
    const bagian = await bagianShuAnggota(testDb as never, 2026);
    expect(bagian.sudahDibagikan).toBe(true);
    expect(bagian.totalBagianAnggota).toBe(5_000_000);
    expect(bagian.jumlahAnggotaPenerima).toBe(2);
    expect(bagian.shuDisahkanRat).toBe(50_000_000);
  });

  test.each(['DRAFT', 'DIHITUNG', 'DIAJUKAN_RAT', 'DISAHKAN_RAT'])(
    'status %s -> TIDAK terbaca sebagai manfaat walau baris shu_anggota sudah ada',
    async (status) => {
      await seedShu(testDb, {
        tahun: 2026,
        status,
        disahkan: 50_000_000,
        anggota: [{ id: ANG.a1, modal: 1_000_000, usaha: 2_000_000 }],
      });
      const bagian = await bagianShuAnggota(testDb as never, 2026);
      expect(bagian.sudahDibagikan).toBe(false);
      expect(bagian.totalBagianAnggota).toBe(0);
      expect(bagian.jumlahAnggotaPenerima).toBe(0);
      // Nominal disahkan tetap dibawa untuk rekonsiliasi, TIDAK untuk ditotal.
      expect(bagian.shuDisahkanRat).toBe(50_000_000);
    }
  );

  test('tanpa konfigurasi SHU -> belum dibagikan, tanpa melempar', async () => {
    const bagian = await bagianShuAnggota(testDb as never, 2099);
    expect(bagian.sudahDibagikan).toBe(false);
    expect(bagian.shuDisahkanRat).toBeNull();
  });

  test('rincian per anggota hanya keluar bila sudah DIBAGIKAN', async () => {
    await seedShu(testDb, {
      tahun: 2026,
      status: 'DISAHKAN_RAT',
      disahkan: 50_000_000,
      anggota: [{ id: ANG.a1, modal: 1_000_000, usaha: 2_000_000 }],
    });
    expect(await rincianBagianShuAnggota(testDb as never, 2026)).toEqual([]);

    await testDb.runAsync(`UPDATE shu_konfigurasi SET status = 'DIBAGIKAN' WHERE tahun_buku = 2026`);
    const rincian = await rincianBagianShuAnggota(testDb as never, 2026);
    expect(rincian).toHaveLength(1);
    expect(rincian[0]).toMatchObject({
      nomorAnggota: 'A-001',
      namaLengkap: 'Budi',
      jasaModal: 1_000_000,
      jasaUsaha: 2_000_000,
      totalShuAnggota: 3_000_000,
    });
  });

  test('rekonsiliasi: total bagian anggota = jumlah seluruh baris rincian', async () => {
    await seedShu(testDb, {
      tahun: 2026,
      status: 'DIBAGIKAN',
      disahkan: 50_000_000,
      anggota: [
        { id: ANG.a1, modal: 1_000_000, usaha: 2_000_000 },
        { id: ANG.a2, modal: 500_000, usaha: 1_500_000 },
      ],
    });
    const bagian = await bagianShuAnggota(testDb as never, 2026);
    const rincian = await rincianBagianShuAnggota(testDb as never, 2026);
    expect(rincian.reduce((t, r) => t + r.totalShuAnggota, 0)).toBe(bagian.totalBagianAnggota);
    // Dan total bagian anggota TIDAK sama dengan SHU disahkan RAT —
    // sisanya adalah cadangan/dana lain, bukan manfaat anggota.
    expect(bagian.totalBagianAnggota).toBeLessThan(bagian.shuDisahkanRat!);
  });
});

describe('RC-S101 §5 — parameter tersimpan di app_config, tanpa tabel baru', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('belum pernah diisi -> null (bukan nol)', async () => {
    expect(await bacaParameterLpea(testDb as never, 2026)).toBeNull();
  });

  test('tersimpan & terbaca kembali utuh, di kunci app_config per tahun', async () => {
    const p: ParameterLpea = {
      ...parameterLpeaKosong(2026),
      tarifLuarJasaPinjaman: 1.75,
      tarifLuarSimpananBerjangka: 0,
      sumberAcuan: 'SBDK Bank X',
    };
    await simpanParameterLpea(testDb as never, p, '2026-06-01T00:00:00.000Z');

    const baca = await bacaParameterLpea(testDb as never, 2026);
    expect(baca?.tarifLuarJasaPinjaman).toBe(1.75);
    // Nol adalah nilai yang SAH dan harus terbaca sebagai nol, bukan null.
    expect(baca?.tarifLuarSimpananBerjangka).toBe(0);
    expect(baca?.tarifLuarTabungan).toBeNull();
    expect(baca?.sumberAcuan).toBe('SBDK Bank X');
    expect(baca?.diperbaruiPada).toBe('2026-06-01T00:00:00.000Z');

    const row = await testDb.getFirstAsync<{ key: string }>(
      `SELECT key FROM app_config WHERE key = ?`,
      kunciKonfigLpea(2026)
    );
    expect(row?.key).toBe('lpea.parameter.2026');
  });

  test('menyimpan dua kali menimpa, tidak menggandakan baris', async () => {
    const p = { ...parameterLpeaKosong(2026), tarifLuarJasaPinjaman: 1 };
    await simpanParameterLpea(testDb as never, p, '2026-06-01T00:00:00.000Z');
    await simpanParameterLpea(testDb as never, { ...p, tarifLuarJasaPinjaman: 2 }, '2026-07-01T00:00:00.000Z');
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_config WHERE key = ?`,
      kunciKonfigLpea(2026)
    );
    expect(Number(n?.n)).toBe(1);
    expect((await bacaParameterLpea(testDb as never, 2026))?.tarifLuarJasaPinjaman).toBe(2);
  });

  test('konfigurasi rusak diperlakukan sebagai BELUM DIISI, bukan angka setengah terbaca', async () => {
    await testDb.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)`,
      kunciKonfigLpea(2026),
      '{bukan json',
      '2026-06-01T00:00:00.000Z'
    );
    expect(await bacaParameterLpea(testDb as never, 2026)).toBeNull();
  });

  test('field tak dikenal di JSON tidak menyelundup ke perhitungan', async () => {
    await testDb.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)`,
      kunciKonfigLpea(2026),
      JSON.stringify({ tarifLuarJasaPinjaman: 2, jahat: 'x', tarifLuarTabungan: 'bukan angka' }),
      '2026-06-01T00:00:00.000Z'
    );
    const baca = await bacaParameterLpea(testDb as never, 2026);
    expect(baca?.tarifLuarJasaPinjaman).toBe(2);
    // String bukan angka -> null, bukan NaN yang lolos ke rumus.
    expect(baca?.tarifLuarTabungan).toBeNull();
    expect((baca as unknown as Record<string, unknown>).jahat).toBeUndefined();
  });
});

describe('RC-S101 §6 — laporan utuh dari data aktual', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await seedAnggota(testDb, ANG.a1, 'A-001', 'Budi');
  });

  test('tanpa tarif pembanding: basis terbaca, angka TIDAK dikarang, total ditandai belum lengkap', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-1',
      nomor: 'PJ-001',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 20_000_000,
      persentaseJasa: 2.5,
      satuanTenor: 'BULAN',
      jadwal: [{ pokok: 20_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });

    const parameter = parameterLpeaKosong(2026);
    const komponen = await susunKomponenLpea(testDb as never, AKHIR, parameter);
    const laporan = rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: AKHIR,
      parameter,
      komponen,
      bagianShu: await bagianShuAnggota(testDb as never, 2026),
    });

    const pinjaman = komponen.find((k) => k.komponen === 'JASA_PINJAMAN')!;
    expect(pinjaman.status).toBe('BELUM_DAPAT_DIHITUNG');
    // Basisnya NYATA dan dilaporkan, hanya tarif pembandingnya yang belum ada.
    expect(pinjaman.totalBasis).toBe(20_000_000);
    expect(laporan.jumlahPeaAnggota).toBe(0);
    expect(laporan.totalBelumLengkap).toBe(true);
  });

  test('dengan tarif pembanding: angka muncul dari data aktual & rumus naskah', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-1',
      nomor: 'PJ-001',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 20_000_000,
      persentaseJasa: 2.5,
      satuanTenor: 'BULAN',
      jadwal: [{ pokok: 20_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });
    await seedBerjangka(testDb, { id: 'sb1', anggotaId: ANG.a1, nominal: 100_000_000, sukuBunga: 30, mulai: '2026-01-10' });
    await seedShu(testDb, {
      tahun: 2026,
      status: 'DIBAGIKAN',
      disahkan: 50_000_000,
      anggota: [{ id: ANG.a1, modal: 1_000_000, usaha: 2_000_000 }],
    });

    const parameter: ParameterLpea = {
      ...parameterLpeaKosong(2026),
      tarifLuarJasaPinjaman: 1.5,
      tarifLuarSimpananBerjangka: 1,
    };
    const komponen = await susunKomponenLpea(testDb as never, AKHIR, parameter);
    const laporan = rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: AKHIR,
      parameter,
      komponen,
      bagianShu: await bagianShuAnggota(testDb as never, 2026),
    });

    // Jasa pinjaman: (1,5% − 2,5%) x 20.000.000 = −200.000
    expect(komponen.find((k) => k.komponen === 'JASA_PINJAMAN')!.nilai).toBe(-200_000);
    // Berjangka: (2,5% − 1%) x 100.000.000 = 1.500.000
    expect(komponen.find((k) => k.komponen === 'SIMPANAN_BERJANGKA')!.nilai).toBe(1_500_000);
    // Provisi & tabungan tetap terkunci karena tarifnya belum diisi.
    expect(komponen.find((k) => k.komponen === 'JASA_PROVISI')!.status).toBe('BELUM_DAPAT_DIHITUNG');
    expect(laporan.totalBelumLengkap).toBe(true);

    // Total = (−200.000) + 1.500.000 + SHU 3.000.000
    expect(laporan.jumlahPeaPelayanan).toBe(1_300_000);
    expect(laporan.jumlahPeaAnggota).toBe(4_300_000);
  });

  test('provisi memakai basis yang SAMA dengan pinjaman (naskah huruf B juga saldo pokok pinjaman)', async () => {
    await seedPinjaman(testDb, {
      id: 'pj-1',
      nomor: 'PJ-001',
      anggotaId: ANG.a1,
      tanggal: '2026-02-01',
      jumlah: 20_000_000,
      persentaseJasa: 2.5,
      satuanTenor: 'BULAN',
      jadwal: [{ pokok: 20_000_000, pokokTerbayar: 0, status: 'BELUM_BAYAR' }],
    });
    const parameter: ParameterLpea = {
      ...parameterLpeaKosong(2026),
      tarifLuarJasaProvisi: 2,
      tarifKoperasiJasaProvisi: 1,
    };
    const komponen = await susunKomponenLpea(testDb as never, AKHIR, parameter);
    const provisi = komponen.find((k) => k.komponen === 'JASA_PROVISI')!;
    expect(provisi.totalBasis).toBe(20_000_000);
    // (2% − 1%) x 20.000.000 = 200.000
    expect(provisi.nilai).toBe(200_000);
  });

  test('database kosong: seluruh komponen TIDAK_ADA_TRANSAKSI bila tarif lengkap', async () => {
    const parameter: ParameterLpea = {
      ...parameterLpeaKosong(2026),
      tarifLuarJasaPinjaman: 1,
      tarifLuarJasaProvisi: 1,
      tarifKoperasiJasaProvisi: 0,
      tarifLuarTabungan: 1,
      tarifKoperasiTabungan: 0,
      tarifLuarSimpananBerjangka: 1,
    };
    const komponen = await susunKomponenLpea(testDb as never, AKHIR, parameter);
    expect(komponen.every((k) => k.status === 'TIDAK_ADA_TRANSAKSI')).toBe(true);
    const laporan = rakitLaporanLpea({
      tahunBuku: 2026,
      tanggalMulai: '2026-01-01',
      tanggalSelesai: AKHIR,
      parameter,
      komponen,
      bagianShu: await bagianShuAnggota(testDb as never, 2026),
    });
    expect(laporan.jumlahPeaAnggota).toBe(0);
    // Nol di sini SAH — bukan karena parameter kurang.
    expect(laporan.totalBelumLengkap).toBe(false);
  });
});
