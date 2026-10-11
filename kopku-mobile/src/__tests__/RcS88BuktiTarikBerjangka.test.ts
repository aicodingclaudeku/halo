jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb,
  pasangKebijakan,
  KEBIJAKAN_NETRAL,
  ACC,
  USER_ID,
  POKOK,
  TANGGAL_TARIK,
  BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import {
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  simpanKebijakanDini,
  getKebijakanDiniAktif,
  KODE_AKUN_PENALTI_DINI,
  KODE_AKUN_BIAYA_ADMIN_DINI,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { listBuktiTarikSimpanan, getBuktiTarikSimpananById } from '@/services/BuktiTransaksiService';
import { buildBuktiTarikSimpananExport } from '@/export/ReportTableBuilders';
import { keParameterKebijakan } from '@/utils/kebijakanDiniSederhana';
import { formatNominalInput, parseNominalInput } from '@/utils/money';

/**
 * RC-S88 — (1) Bukti Tarik Simpanan Anggota kini mencakup pencairan SIMPANAN
 * BERJANGKA (jatuh tempo & penarikan dini) beserta rinciannya; (2) akun
 * pendapatan kebijakan penarikan dini TERKUNCI: penalti 4-1150, biaya
 * administrasi 4-1100, ditegakkan service.
 */

let db: TestDb;
const INFO = { namaKoperasi: 'Koperasi Uji', standarAkuntansi: 'SAK_EP' } as never;

async function tambahAkun(id: string, kode: string, nama: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,'PENDAPATAN','KREDIT',1,1,?,?)`,
    id, kode, nama, now, now
  );
}

beforeEach(async () => {
  db = await siapkanDb();
  await tambahAkun('acc-4-1150', '4-1150', 'Pendapatan Penalti Pelunasan');
});

describe('RC-S88 — Bukti Tarik Simpanan: simpanan berjangka', () => {
  it('penarikan dini tampil dengan rincian pokok, bunga, penalti, biaya admin; nominal = uang diterima anggota', async () => {
    await pasangKebijakan(db, {
      ...KEBIJAKAN_NETRAL,
      versi: 'EW-BUKTI',
      jenisPenalti: 'NOMINAL_TETAP',
      nilaiPenalti: 100_000,
      akunPenaltiId: 'acc-4-1150',
      jenisBiayaAdmin: 'NOMINAL_TETAP',
      nilaiBiayaAdmin: 50_000,
      akunBiayaAdminId: ACC.pendapatanAdmin,
      perlakuanPokok: 'DIKURANGI_PENALTI_DAN_BIAYA',
    });
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    await cairkanSimpananBerjangkaDini({ kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', alasan: 'Kebutuhan mendesak', createdBy: USER_ID });

    const daftar = await listBuktiTarikSimpanan();
    const b = daftar.find((r) => r.id === id)!;
    expect(b).toBeDefined();
    expect(b.jenisSimpanan).toBe('BERJANGKA');
    expect(b.tanggal).toBe(TANGGAL_TARIK);
    expect(b.nomorBukti).toMatch(/^SPB-DINI/);
    expect(b.sumberDana).toBe('KAS');
    expect(b.jumlah).toBe(POKOK + BUNGA_EARNED_3_PERIODE - 150_000);
    expect(b.rincianBerjangka).toMatchObject({
      jenisPencairan: 'DINI',
      pokok: POKOK,
      bunga: BUNGA_EARNED_3_PERIODE,
      penalti: 100_000,
      biayaAdmin: 50_000,
      pphDipotong: 0,
      policyVersi: 'EW-BUKTI',
      tenorBulan: 6,
    });
    expect(b.keterangan).toMatch(/Penarikan dini simpanan berjangka .* — Kebutuhan mendesak/);

    // Detail & export membaca data yang sama.
    expect(await getBuktiTarikSimpananById(id)).toEqual(b);
    const ekspor = buildBuktiTarikSimpananExport(INFO, b);
    expect(ekspor.baris).toContainEqual(['Jenis Simpanan', 'Simpanan Berjangka']);
    expect(ekspor.baris).toContainEqual(['Jenis Pencairan', 'Penarikan Dini']);
    expect(ekspor.baris).toContainEqual(['Penalti Penarikan Dini', '-Rp100.000']);
    expect(ekspor.baris).toContainEqual(['Biaya Administrasi', '-Rp50.000']);
    expect(ekspor.ringkasan?.[0]).toEqual({ label: 'Total Diterima Anggota', nilai: 'Rp24.210.000' });

    // Pencarian nomor kontrak ikut menemukan bukti berjangka.
    const nomorKontrak = b.rincianBerjangka!.nomorKontrak;
    expect((await listBuktiTarikSimpanan({ search: nomorKontrak })).map((r) => r.id)).toEqual([id]);
  });

  it('pencairan jatuh tempo tampil; uang diterima = bruto − PPh 4(2)', async () => {
    const id = await buatKontrakUji({ pokok: 120_000_000 });
    const JT = '2026-12-12';
    await prosesAkrualBungaKontrak(id, JT, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(JT, USER_ID);
    const cair = await cairkanSimpananBerjangka({ kontrakId: id, tanggal: JT, sumberDana: 'KAS', createdBy: USER_ID });

    const b = (await getBuktiTarikSimpananById(id))!;
    expect(b.jenisSimpanan).toBe('BERJANGKA');
    expect(b.nomorBukti).toMatch(/^SPB-CAIR/);
    expect(b.rincianBerjangka).toMatchObject({
      jenisPencairan: 'JATUH_TEMPO',
      pokok: cair.pokok,
      bunga: cair.bunga,
      pphDipotong: cair.pajakDipotong,
      penalti: 0,
      biayaAdmin: 0,
      policyVersi: null,
    });
    expect(b.jumlah).toBe(cair.totalDibayarBersih);
    expect(b.jumlah).toBe(b.rincianBerjangka!.pokok + b.rincianBerjangka!.bunga - b.rincianBerjangka!.pphDipotong);
  });

  it('kontrak yang belum dicairkan tidak muncul', async () => {
    const id = await buatKontrakUji();
    expect((await listBuktiTarikSimpanan()).some((r) => r.id === id)).toBe(false);
    expect(await getBuktiTarikSimpananById(id)).toBeNull();
  });
});

describe('RC-S88 — kebijakan penarikan dini: akun pendapatan terkunci', () => {
  const keputusan = keParameterKebijakan({ penalti: 'NOMINAL_TETAP', bunga: 'DIBAYAR', biaya: 'NOMINAL_TETAP' });
  const dasar = {
    versi: 'SK-01',
    berlakuMulai: '2026-01-01',
    diizinkan: true,
    ...keputusan,
    nilaiPenalti: 100_000,
    nilaiBiayaAdmin: 25_000,
    dasarPenetapan: null,
    ditetapkanOleh: null,
    createdBy: USER_ID,
  };

  it('akun dari masukan DIABAIKAN — service selalu memakai 4-1150 (penalti) & 4-1100 (biaya administrasi)', async () => {
    expect(KODE_AKUN_PENALTI_DINI).toBe('4-1150');
    expect(KODE_AKUN_BIAYA_ADMIN_DINI).toBe('4-1100');
    const hasil = await simpanKebijakanDini({ ...dasar, akunPenaltiId: ACC.pendapatanLain, akunBiayaAdminId: ACC.pendapatanDenda });
    expect(hasil.evaluasi.status).toBe('AKTIF');
    const aktif = await getKebijakanDiniAktif();
    expect(aktif?.akunPenaltiId).toBe('acc-4-1150');
    expect(aktif?.akunBiayaAdminId).toBe(ACC.pendapatanAdmin); // 4-1100
  });

  it('tanpa penalti/biaya, akun dikosongkan; akun baku hilang -> ditolak eksplisit', async () => {
    const tanpa = keParameterKebijakan({ penalti: 'TIDAK_ADA', bunga: 'DIBAYAR', biaya: 'TIDAK_ADA' });
    await simpanKebijakanDini({ ...dasar, ...tanpa, versi: 'SK-02', nilaiPenalti: null, nilaiBiayaAdmin: null, akunPenaltiId: 'x', akunBiayaAdminId: 'y' });
    const aktif = await getKebijakanDiniAktif();
    expect(aktif?.akunPenaltiId).toBeNull();
    expect(aktif?.akunBiayaAdminId).toBeNull();

    await db.runAsync(`UPDATE account SET is_active = 0 WHERE kode = '4-1150'`);
    await expect(simpanKebijakanDini({ ...dasar, versi: 'SK-03', akunPenaltiId: null, akunBiayaAdminId: null })).rejects.toThrow(/4-1150/);
  });
});

describe('RC-S88 — format nominal rupiah pada input kebijakan', () => {
  it('10000 tampil 10.000 dan tetap tersimpan sebagai digit murni', () => {
    expect(formatNominalInput(parseNominalInput('10000'))).toBe('10.000');
    expect(formatNominalInput(parseNominalInput('100.000'))).toBe('100.000');
    expect(String(parseNominalInput('Rp1.250.000'))).toBe('1250000');
  });
});
