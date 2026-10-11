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

import { buatFixtureHistoris, ACC, USER_ID, saldoGl, totalDebitKredit } from './historicalFixture';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { getJadwalAngsuran, listPinjaman } from '@/services/PinjamanService';
import { listSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';

/**
 * RC-S96 — IMPORT DATA AWAL DARI EXCEL, end-to-end ke database.
 *
 * Yang dibuktikan di sini bukan "parser jalan" (itu tugas
 * ExcelDataAwalParser.test.ts), melainkan bahwa import MEMBUAT DATA &
 * JURNAL YANG BENAR lewat service yang sudah ada:
 *   - anggota dibuat dengan nomor anggota otomatis, dan kode Excel
 *     menautkan sheet lain ke anggota yang tepat;
 *   - saldo simpanan per jenis sama dengan yang diisi di Excel;
 *   - pinjaman terbentuk beserta jadwalnya, dan angsuran yang sudah
 *     dibayar mengurangi sisa pokok — bukan angka sisa yang ditempel;
 *   - buku besar tetap seimbang (debit = kredit) setelah seluruh import;
 *   - satu baris yang gagal TIDAK menggagalkan baris lainnya.
 */

/** Baris anggota sheet Excel (header + data), seperti yang diisi pengguna. */
function sheetAnggota(baris: (string | number)[][]): (string | number)[][] {
  return [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ...baris];
}

const TANGGAL_SIMPANAN = '2026-01-05';
const TANGGAL_PINJAMAN = '2026-02-01';

describe('RC-S96 — import data awal: anggota, simpanan, berjangka, pinjaman', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('berkas lengkap: seluruh baris masuk, saldo & jadwal benar, buku tetap seimbang', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([
        ['A1', 'Budi Santoso', '01/01/2026'],
        ['A2', 'Sari Melati', '01/01/2026'],
      ]),
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'],
        ['A1', TANGGAL_SIMPANAN, '100.000', '50.000', '25.000', 'KAS'],
        ['A2', TANGGAL_SIMPANAN, 'Rp 100.000', '75.000', '0', 'KAS'],
      ],
      BERJANGKA: [
        ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana'],
        ['A2', TANGGAL_SIMPANAN, '10.000.000', '12', '6', 'KAS'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar'],
        ['A1', '01/02/2026', '12.000.000', '12', 'BULAN', 'FLAT', '1', 'KAS', '3'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });
    expect(hasil.gagal).toEqual([]);
    expect(hasil.totalGagal).toBe(0);
    expect(hasil.totalBerhasil).toBe(6); // 2 anggota + 2 simpanan + 1 berjangka + 1 pinjaman

    // ---- Anggota: nomor dibuat otomatis oleh aplikasi ----
    const anggota = await testDb.getAllAsync<{ id: string; nomor_anggota: string; nama_lengkap: string }>(
      `SELECT id, nomor_anggota, nama_lengkap FROM anggota WHERE nama_lengkap IN ('Budi Santoso','Sari Melati') ORDER BY nama_lengkap`
    );
    expect(anggota).toHaveLength(2);
    for (const a of anggota) expect(a.nomor_anggota).toMatch(/\d/);
    const budi = anggota.find((a) => a.nama_lengkap === 'Budi Santoso')!;
    const sari = anggota.find((a) => a.nama_lengkap === 'Sari Melati')!;

    // ---- Simpanan: saldo per jenis PERSIS seperti di Excel ----
    expect(await getSaldoSimpanan(testDb as any, budi.id, 'POKOK')).toBe(100_000);
    expect(await getSaldoSimpanan(testDb as any, budi.id, 'WAJIB')).toBe(50_000);
    expect(await getSaldoSimpanan(testDb as any, budi.id, 'SUKARELA')).toBe(25_000);
    // Kolom Sukarela dikosongkan -> 0, bukan galat.
    expect(await getSaldoSimpanan(testDb as any, sari.id, 'SUKARELA')).toBe(0);
    expect(await getSaldoSimpanan(testDb as any, sari.id, 'WAJIB')).toBe(75_000);

    // ---- Berjangka ----
    const berjangka = await listSimpananBerjangka(sari.id);
    expect(berjangka).toHaveLength(1);
    expect(berjangka[0]).toMatchObject({ nominal: 10_000_000, tenorBulan: 12 });

    // ---- Pinjaman: dicairkan pada tanggal historis, jadwal penuh ----
    const pinjaman = await listPinjaman({});
    const milikBudi = pinjaman.filter((p) => p.anggotaId === budi.id);
    expect(milikBudi).toHaveLength(1);
    const jadwal = await getJadwalAngsuran(milikBudi[0].id);
    expect(jadwal).toHaveLength(12);
    expect(jadwal[0].tanggalJatuhTempo > TANGGAL_PINJAMAN).toBe(true);

    // 3 angsuran pertama LUNAS, sisanya belum — sisa pokok terhitung
    // sendiri oleh mesin angsuran, bukan ditempel dari Excel.
    const lunas = jadwal.filter((j) => j.status === 'LUNAS');
    expect(lunas).toHaveLength(3);
    const sisaPokok = jadwal.reduce((t, j) => t + (j.pokok - j.pokokTerbayar), 0);
    expect(sisaPokok).toBe(9_000_000); // 12jt - 3x1jt

    // Kolektibilitas ikut terbentuk dari jadwal sungguhan.
    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any, {
      tanggalLaporan: '2026-05-10',
      statusAnggota: 'SEMUA',
    });
    expect(klasifikasi.find((k) => k.pinjamanId === milikBudi[0].id)?.saldoPokok).toBe(9_000_000);

    // ---- Buku besar tetap seimbang ----
    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);

    // Simpanan MENAMBAH kas; pencairan pinjaman MENGURANGI kas. Saldo
    // akun simpanan di buku besar harus sama dengan total yang diimpor.
    expect(await saldoGl(testDb, ACC.simpananPokok)).toBe(-200_000); // KREDIT 2x100.000
  });

  test('kolom pilihan tersimpan sebagai nilai DOMAIN database, bukan huruf dari Excel', async () => {
    // REGRESI: pengguna mengetik L/P di Excel, tetapi kolom
    // `anggota.jenis_kelamin` hanya menerima 'LAKI_LAKI'/'PEREMPUAN'.
    // Bug aslinya membuat SELURUH baris anggota ditolak database, dan
    // karena sheet lain menunjuk anggota itu, seluruh import ikut gagal.
    // Test integrasi sebelumnya lolos hanya karena kolom ini dikosongkan.
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung', 'Jenis Kelamin'],
        ['A1', 'Budi Santoso', '01/01/2026', 'L'],
        ['A2', 'Sari Melati', '01/01/2026', 'Perempuan'],
      ],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A1', TANGGAL_SIMPANAN, '100000', '0', '0'],
      ],
    });

    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });
    expect(hasil.gagal).toEqual([]);

    const baris = await testDb.getAllAsync<{ nama_lengkap: string; jenis_kelamin: string }>(
      `SELECT nama_lengkap, jenis_kelamin FROM anggota
       WHERE nama_lengkap IN ('Budi Santoso','Sari Melati') ORDER BY nama_lengkap`
    );
    expect(baris.map((b) => b.jenis_kelamin)).toEqual(['LAKI_LAKI', 'PEREMPUAN']);
  });

  test('satu baris gagal TIDAK menggagalkan baris lain, dan dilaporkan dengan nomor baris Excel', async () => {
    // Simpanan Pokok hanya boleh dicatat SEKALI per anggota
    // (`pastikanBelumAdaSimpananPokok`). Baris kedua untuk A1 karena itu
    // harus gagal, tetapi baris A2 tetap masuk.
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([
        ['A1', 'Budi Santoso', '01/01/2026'],
        ['A2', 'Sari Melati', '01/01/2026'],
      ]),
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A1', TANGGAL_SIMPANAN, '100000', '50000', '0'],
        ['A1', TANGGAL_SIMPANAN, '100000', '50000', '0'],
        ['A2', TANGGAL_SIMPANAN, '100000', '50000', '0'],
      ],
    });
    expect(ringkasan.siapDiimpor).toBe(true);

    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });

    expect(hasil.totalGagal).toBe(1);
    expect(hasil.gagal[0]).toMatchObject({ jenis: 'SIMPANAN', baris: 3 });
    // Dua anggota + dua baris simpanan yang sah tetap tersimpan.
    expect(hasil.perSheet.find((s) => s.jenis === 'ANGGOTA')!.berhasil).toBe(2);
    expect(hasil.perSheet.find((s) => s.jenis === 'SIMPANAN')!.berhasil).toBe(2);

    const { debit, kredit } = await totalDebitKredit(testDb);
    expect(debit).toBe(kredit);
  });

  test('pinjaman tanpa simpanan pokok/wajib ditolak aturan kelayakan yang sudah ada', async () => {
    // Import TIDAK BOLEH menjadi pintu belakang: `checkEligibilitasPinjaman`
    // mewajibkan anggota sudah punya Simpanan Pokok & Wajib.
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([['A1', 'Tanpa Simpanan', '01/01/2026']]),
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor'],
        ['A1', '01/02/2026', '5000000', '6'],
      ],
    });

    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });

    expect(hasil.perSheet.find((s) => s.jenis === 'ANGGOTA')!.berhasil).toBe(1);
    expect(hasil.perSheet.find((s) => s.jenis === 'PINJAMAN')!.gagal).toBe(1);
    expect(hasil.gagal[0].jenis).toBe('PINJAMAN');
    // Tidak ada pinjaman yang tertinggal separuh jadi.
    expect(await listPinjaman({})).toHaveLength(0);
  });

  test('baris milik anggota yang gagal dibuat dilewati dengan sebab yang jelas, bukan galat susulan', async () => {
    // NIK ganda membuat baris anggota kedua gagal di `createAnggota`
    // (UNIQUE), sehingga baris simpanan miliknya tidak bisa diproses.
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung', 'NIK'],
        ['A1', 'Budi', '01/01/2026', '1111111111111111'],
        ['A2', 'Kembar NIK', '01/01/2026', '1111111111111111'],
      ],
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A2', TANGGAL_SIMPANAN, '100000', '0', '0'],
      ],
    });

    const hasil = await jalankanImportDataAwal(ringkasan, { createdBy: USER_ID, dbRiwayat: testDb as never });

    expect(hasil.perSheet.find((s) => s.jenis === 'ANGGOTA')!.gagal).toBe(1);
    const gagalSimpanan = hasil.gagal.find((g) => g.jenis === 'SIMPANAN')!;
    expect(gagalSimpanan.pesan).toContain('gagal dibuat pada tahap Anggota');
  });

  test('kemajuan dilaporkan sekali per baris, termasuk baris yang gagal', async () => {
    const ringkasan = parseBerkasDataAwal({
      ANGGOTA: sheetAnggota([['A1', 'Budi', '01/01/2026']]),
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'], ['A1', TANGGAL_SIMPANAN, '100000', '0', '0']],
    });
    const tik: number[] = [];
    await jalankanImportDataAwal(ringkasan, {
      createdBy: USER_ID,
      // DIPERBARUI RC-S100: `dbRiwayat` diarahkan ke database uji supaya
      // pencatatan riwayat import benar-benar DIJALANKAN di test ini.
      // Tanpa itu, `getDb()` melempar (mock expo-sqlite sengaja begitu)
      // dan pencatatannya tertelan try/catch — jalur baru itu akan lulus
      // tanpa pernah tersentuh.
      dbRiwayat: testDb as never,
      onKemajuan: (selesai, total) => {
        expect(total).toBe(2);
        tik.push(selesai);
      },
    });
    expect(tik).toEqual([1, 2]);
  });
});
