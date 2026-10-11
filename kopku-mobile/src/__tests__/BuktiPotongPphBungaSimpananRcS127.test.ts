import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S127 — BUKTI POTONG PPh 4(2) BUNGA SIMPANAN SUKARELA.
 *
 * Membuktikan pemotongan PPh pada akrual bunga Sukarela benar-benar
 * terjadi (jurnal + utang 2-1901 + bukti potong per anggota, termasuk 0%),
 * dan bahwa bukti potong itu kini terbaca, terfilter, terjumlah, dan
 * tercetak lewat PphPotongService — sumber layar Pajak › Bukti Potong.
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

import { batalkanAkrualBungaSukarela, prosesAkrualBungaSukarela, PENANDA_BUKTI_POTONG_SUKARELA } from '@/services/BungaSukarelaService';
import {
  buildBuktiPotongSatuExport,
  buildDaftarBuktiPotongExport,
  filterBuktiPotong,
  getIdentitasPemotong,
  keteranganTarifBuktiPotong,
  listBuktiPotongPphBungaSimpanan,
  listBuktiPotongTahun,
  PENANDA_BUKTI_POTONG_SUKARELA as PENANDA_DI_MESIN_PAJAK,
  ringkasBuktiPotong,
} from '@/services/PphPotongService';
import { KODE_UTANG_PPH_BUNGA_SIMPANAN } from '@/config/pajakPolicy';
import { isiInfoPajak } from '@/screens/Pajak/infoPajak';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
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
  // Andi: bunga Jan 31.000 (di bawah batas -> 0%). Budi: 3.100.000 (10% -> 310.000).
  let n = 0;
  for (const [a, nominal] of [['ang-1', 3_650_000], ['ang-2', 365_000_000]] as const) {
    n += 1;
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,'SUKARELA','SETOR','2025-12-01',?,'KAS',?,'user-1',?)`,
      `trx-${n}`, a, nominal, `N-${n}`, now()
    );
  }
  await testDb.runAsync(
    `INSERT INTO bunga_sukarela_kebijakan (id, berlaku_mulai, aktif, tarif_persen, created_by, created_at) VALUES ('kb-1','2026-01',1,10,'user-1',?)`,
    now()
  );
}

const saldoUtangPph = async () =>
  (
    await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) AS s
         FROM journal_entry je JOIN account a ON a.id = je.account_id JOIN journal j ON j.id = je.journal_id
        WHERE a.kode = ?`,
      KODE_UTANG_PPH_BUNGA_SIMPANAN
    )
  )?.s ?? 0;

describe('RC-S127 — PPh dipotong pada akrual bunga simpanan sukarela', () => {
  beforeEach(siapkan);

  it('penanda produk sukarela satu sumber (mesin pajak) dan tidak berubah nilainya', () => {
    expect(PENANDA_BUKTI_POTONG_SUKARELA).toBe('SUKARELA');
    expect(PENANDA_DI_MESIN_PAJAK).toBe(PENANDA_BUKTI_POTONG_SUKARELA);
  });

  it('akrual: utang PPh 4(2) bertambah sebesar PPh, bukti potong terbit per anggota termasuk tarif 0%', async () => {
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    expect(await saldoUtangPph()).toBe(310_000);

    const daftar = await listBuktiPotongPphBungaSimpanan(testDb as any, 2026);
    expect(daftar).toHaveLength(2);
    const budi = daftar.find((b) => b.anggotaId === 'ang-2')!;
    const andi = daftar.find((b) => b.anggotaId === 'ang-1')!;
    expect(budi).toMatchObject({
      produk: 'SUKARELA',
      masaPajak: '2026-01',
      bruto: 3_100_000,
      pajak: 310_000,
      netto: 2_790_000,
      nomorAnggota: 'A-002',
      nikAnggota: 'NIK-A-002',
      nomorKontrak: null,
      dibatalkan: false,
      tanggal: '2026-01-31',
    });
    expect(budi.nomorJurnal).toBeTruthy();
    expect(budi.nomorBuktiPotong).toMatch(/BP-PPH4A2/);
    expect(andi).toMatchObject({ produk: 'SUKARELA', bruto: 31_000, pajak: 0, netto: 31_000 });
  });

  it('ringkasan: hanya bukti potong berlaku yang dijumlah', async () => {
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    const r = ringkasBuktiPotong(await listBuktiPotongTahun(2026));
    expect(r).toEqual({ jumlah: 2, jumlahDipotong: 1, jumlahNol: 1, jumlahDibatalkan: 0, totalBruto: 3_131_000, totalPajak: 310_000, totalNetto: 2_821_000 });
  });

  it('pembatalan akrual: bukti potong lama ditandai dibatalkan, utang PPh kembali nol; akru ulang menerbitkan bukti baru', async () => {
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    await batalkanAkrualBungaSukarela('user-1', '2026-01', 'salah tarif');
    expect(await saldoUtangPph()).toBe(0);
    let daftar = await listBuktiPotongTahun(2026);
    expect(daftar.every((b) => b.dibatalkan)).toBe(true);
    expect(ringkasBuktiPotong(daftar)).toMatchObject({ jumlah: 0, jumlahDibatalkan: 2, totalPajak: 0 });

    await prosesAkrualBungaSukarela('user-1', '2026-01');
    daftar = await listBuktiPotongTahun(2026);
    expect(daftar).toHaveLength(4);
    expect(ringkasBuktiPotong(daftar)).toMatchObject({ jumlah: 2, jumlahDibatalkan: 2, totalPajak: 310_000 });
    expect(await saldoUtangPph()).toBe(310_000);
  });

  it('daftar membedakan produk: baris berjangka tetap terbaca & terfilter', async () => {
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    const jid = (await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM journal LIMIT 1`))!.id;
    await testDb.runAsync(
      `INSERT INTO pajak_potong_bunga_simpanan
        (id, simpanan_berjangka_id, bunga_periode_id, nomor_periode, anggota_id, masa_pajak, bruto, pajak, netto, peristiwa, journal_id,
         nomor_bukti_potong, tanggal, created_by, created_at)
       VALUES ('bp-x','sb-tidak-ada','bp-1',2,'ang-1','2026-02',250000,25000,225000,'PENCAIRAN',?,'BP-X-1','2026-02-28','user-1',?)`,
      jid,
      now()
    );
    const daftar = await listBuktiPotongTahun(2026);
    const bj = daftar.find((b) => b.id === 'bp-x')!;
    expect(bj).toMatchObject({ produk: 'BERJANGKA', nomorKontrak: null, nomorPeriode: 2 });
    expect(filterBuktiPotong(daftar, 'BERJANGKA').map((b) => b.id)).toEqual(['bp-x']);
    expect(filterBuktiPotong(daftar, 'SUKARELA')).toHaveLength(2);
    expect(filterBuktiPotong(daftar, 'SEMUA')).toHaveLength(3);
  });

  it('export daftar & satu lembar bukti potong', async () => {
    await testDb.runAsync(
      `INSERT INTO koperasi (id, nama, npwp, alamat, tahun_buku_aktif, standar_akuntansi, created_at, updated_at)
       VALUES ('kop-1','KSP Maju','01.234.567.8-901.000','Jl. Contoh',2026,'SAK_EP',?,?)`,
      now(),
      now()
    );
    await prosesAkrualBungaSukarela('user-1', '2026-01');
    const daftar = await listBuktiPotongTahun(2026);
    const id = await getIdentitasPemotong();
    expect(id).toEqual({ namaKoperasi: 'KSP Maju', alamatKoperasi: 'Jl. Contoh', npwpKoperasi: '01.234.567.8-901.000' });

    const d = buildDaftarBuktiPotongExport(id, 2026, daftar);
    expect(d.baris).toHaveLength(2);
    expect(d.kolom).toContain('PPh Dipotong');
    expect(d.kolomAngka).toEqual([6, 7, 8]);
    expect(d.ringkasan?.find((x) => x.label === 'Total PPh dipotong')?.nilai).toBe('310000');

    const budi = daftar.find((b) => b.anggotaId === 'ang-2')!;
    const satu = buildBuktiPotongSatuExport(id, budi);
    expect(satu.nomorDokumen).toBe(budi.nomorBuktiPotong);
    expect(satu.seksi).toHaveLength(3);
    const semuaBaris = satu.seksi!.flatMap((s) => (s.jenis === 'KV' ? s.baris : []));
    expect(semuaBaris).toContainEqual({ label: 'NPWP koperasi', nilai: '01.234.567.8-901.000' });
    expect(semuaBaris).toContainEqual({ label: 'Sumber bunga', nilai: 'Bunga Simpanan Sukarela' });
    expect(semuaBaris.find((b) => b.label === 'PPh dipotong')?.nilai).toMatch(/310\.000/);
  });
});

describe('RC-S127 — keterangan tarif & penjelasan (dari mesin pajak)', () => {
  it('keterangan tarif diturunkan dari angka tersimpan', () => {
    expect(keteranganTarifBuktiPotong({ bruto: 31_000, pajak: 0 })).toMatch(/^0%.*240\.000/);
    expect(keteranganTarifBuktiPotong({ bruto: 300_000, pajak: 30_000 })).toBe('10% dari bunga bruto');
    expect(keteranganTarifBuktiPotong({ bruto: -5_000, pajak: 0 })).toBe('Koreksi bunga bulan lalu');
    // RC-S127 agregat: potongan melebihi 10% barisnya sendiri = memuat susulan produk lain.
    expect(keteranganTarifBuktiPotong({ bruto: 1_000, pajak: 24_040 })).toMatch(/susulan/);
    expect(keteranganTarifBuktiPotong({ bruto: 120_000, pajak: -26_000 })).toMatch(/Pengembalian/);
  });

  it('ikon tanda seru Bukti Potong: contoh hitung memakai mesin pajak', () => {
    const isi = isiInfoPajak('menuBuktiPotong', 2026);
    const nilai = isi.contoh!.baris.map((b) => b.nilai.replace(/\D/g, ''));
    // Sukarela 150rb + Berjangka 150rb: masing-masing di bawah batas, total 300rb -> 10% atas total.
    expect(nilai).toEqual(['150000', '150000', '300000', '30000']);
  });
});

describe('RC-S127 — struktural: layar terdaftar & dapat dijangkau, tidak menghitung sendiri', () => {
  it('rute BuktiPotongPph terdaftar dan ditautkan dari menu Pajak & layar Bunga Sukarela', () => {
    expect(baca('src/navigation/RootNavigator.tsx')).toMatch(/name="BuktiPotongPph" component=\{BuktiPotongPphScreen\}/);
    expect(baca('src/screens/Pajak/PajakMenuScreen.tsx')).toMatch(/navigate\('BuktiPotongPph'\)/);
    expect(baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx')).toMatch(/navigate\('BuktiPotongPph'\)/);
  });

  it('layar bukti potong tidak memakai rumus pajak', () => {
    const src = baca('src/screens/Pajak/BuktiPotongPphScreen.tsx');
    expect(src).not.toMatch(/hitungPph/);
    expect(src).not.toMatch(/\* ?0?\.1\b|\/ ?10\b|240[_.]?000/);
  });

  it('layar bunga sukarela selalu menampilkan PPh (termasuk Rp0) dan tidak menulis ulang batas pajak', () => {
    const src = baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx');
    expect(src).not.toMatch(/pajak !== 0 \?/);
    expect(src).toMatch(/BATAS_BUNGA_SIMPANAN_PPH_BEBAS/);
    expect(src).not.toMatch(/240[_.]000/);
  });
});
