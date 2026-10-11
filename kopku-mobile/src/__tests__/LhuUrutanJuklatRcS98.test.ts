import { createTestDb, TestDb } from './testDb';
import { createJournal } from '@/accounting/AccountingEngine';
import { getLHU } from '@/reports/FinancialReports';
import { buildLHUExport } from '@/export/ReportTableBuilders';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { buildCsv } from '@/export/CsvExporter';
import { hitungKomposisiPendapatanLhu, formatPersenKomposisi } from '@/reports/KomposisiPendapatanLhu';
import { formatRupiahPengurang } from '@/utils/money';
import type { TingkatBarisLaporan } from '@/export/ExportTypes';

/**
 * RC-S98 — LHU DISAJIKAN SESUAI NASKAH JUKLAT SOM No. 3/2025 + EXPORT RAPI.
 *
 * Angka fixture di bawah diambil PERSIS dari Lampiran "CONTOH PERHITUNGAN
 * HASIL USAHA UNTUK KSP" (kolom tahun 2021) pada naskah Juklat, supaya
 * yang diuji adalah kesesuaian dengan naskah — bukan kesesuaian dengan
 * tebakan sendiri:
 *
 *   Pendapatan bunga                   85.375.000
 *   Pendapatan usaha lain               3.000.000
 *     Jumlah partisipasi anggota       88.375.000
 *   Beban usaha (total 6 pos)         (13.600.000)
 *   SISA HASIL USAHA BRUTO             74.775.000
 *   Hasil investasi                    12.500.000
 *   Beban perkoperasian                (5.000.000)
 *   Pendapatan lain                     4.000.000
 *   Beban lain                           (550.000)
 *   Sisa hasil usaha sebelum pajak     85.725.000
 *   Beban pajak penghasilan            (4.300.000)
 *   SISA HASIL USAHA                   81.425.000
 *
 * Memakai SQLite sungguhan (sql.js) dan jurnal sungguhan lewat
 * `createJournal` — bukan objek LhuResult karangan — supaya urutan &
 * pengelompokan benar-benar berasal dari `getLHU()`.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  pendapatanBunga: 'acc-pendapatan-bunga',
  pendapatanUsahaLain: 'acc-pendapatan-usaha-lain',
  hasilInvestasi: 'acc-hasil-investasi',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanBunga: 'acc-beban-bunga',
  bebanPerkoperasian: 'acc-beban-perkoperasian',
  bebanLain: 'acc-beban-lain',
  bebanPajak: 'acc-beban-pajak',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  lhuKlasifikasi: string | null = null
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    lhuKlasifikasi,
    now,
    now
  );
}

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank', 'ASET', 'DEBIT');

  await seedAccount(db, ACC.pendapatanBunga, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT', null);
  await seedAccount(db, ACC.pendapatanUsahaLain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.hasilInvestasi, '4-1300', 'Pendapatan Hasil Investasi', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
  await seedAccount(db, ACC.pendapatanLain, '4-3000', 'Pendapatan Lainnya', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_LAIN');

  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');
  // PENTING: akun ini DIBERI 'BEBAN_USAHA' seperti isi database lama —
  // membuktikan getLHU() mengeluarkannya dari Beban Usaha berdasarkan
  // KODE, bukan bergantung pada migrasi klasifikasi apa pun.
  await seedAccount(db, ACC.bebanPerkoperasian, '5-1900', 'Beban Perkoperasian', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');
  await seedAccount(db, ACC.bebanLain, '5-2150', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT', 'BEBAN_LAIN');
  await seedAccount(db, ACC.bebanPajak, '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT', null);

  for (const tahun of [2021, 2026]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${tahun}`,
      tahun,
      `${tahun}-01-01`,
      `${tahun}-12-31`
    );
  }
  return db;
}

async function jurnal(db: TestDb, tanggal: string, debitAccountId: string, kreditAccountId: string, nominal: number) {
  await createJournal(db as never, {
    tanggal,
    sumberTransaksi: 'TEST',
    deskripsi: 'test',
    createdBy: 'user-1',
    lines: [
      { accountId: debitAccountId, debit: nominal, kredit: 0 },
      { accountId: kreditAccountId, debit: 0, kredit: nominal },
    ],
  });
}

/** Isi buku besar dengan angka contoh Juklat 2021. */
async function isiContohJuklat(db: TestDb) {
  await jurnal(db, '2026-03-01', ACC.kas, ACC.pendapatanBunga, 85_375_000);
  await jurnal(db, '2026-03-02', ACC.kas, ACC.pendapatanUsahaLain, 3_000_000);
  await jurnal(db, '2026-03-03', ACC.bebanBunga, ACC.kas, 13_600_000);
  await jurnal(db, '2026-03-04', ACC.bank, ACC.hasilInvestasi, 12_500_000);
  await jurnal(db, '2026-03-05', ACC.bebanPerkoperasian, ACC.kas, 5_000_000);
  await jurnal(db, '2026-03-06', ACC.kas, ACC.pendapatanLain, 4_000_000);
  await jurnal(db, '2026-03-07', ACC.bebanLain, ACC.kas, 550_000);
  await jurnal(db, '2026-03-08', ACC.bebanPajak, ACC.kas, 4_300_000);
}

describe('RC-S98 §1 — Beban Perkoperasian adalah baris baku, BUKAN bagian Beban Usaha', () => {
  test('angka contoh Juklat 2021 direproduksi persis, termasuk Jumlah Beban Usaha & SHU Bruto', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);

    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');

    expect(lhu.jumlahPartisipasiAnggota).toBe(88_375_000);

    // Inti perbaikan: 13.600.000 TIDAK memuat 5.000.000 beban
    // perkoperasian. Sebelum RC-S98 nilai ini 18.600.000 dan SHU Bruto
    // 69.775.000 — keduanya menyimpang dari naskah.
    expect(lhu.jumlahBebanUsaha).toBe(13_600_000);
    expect(lhu.shuBruto).toBe(74_775_000);
    expect(lhu.bebanUsaha.map((r) => r.kode)).not.toContain('5-1900');

    expect(lhu.totalHasilInvestasi).toBe(12_500_000);
    expect(lhu.bebanPerkoperasian).toEqual([
      { kode: '5-1900', nama: 'Beban Perkoperasian', jumlah: 5_000_000 },
    ]);
    expect(lhu.totalBebanPerkoperasian).toBe(5_000_000);

    expect(lhu.pendapatanBebanLainNeto).toBe(3_450_000);
    expect(lhu.shuSebelumPajak).toBe(85_725_000);
    expect(lhu.bebanPajakPenghasilan).toBe(4_300_000);
    expect(lhu.shuNeto).toBe(81_425_000);
  });

  test('baris baku tidak pernah ikut terhitung dua kali: SHU sebelum pajak = SHU bruto + investasi − perkoperasian + lain neto', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');

    expect(lhu.shuSebelumPajak).toBe(
      lhu.shuBruto + lhu.totalHasilInvestasi - lhu.totalBebanPerkoperasian + lhu.pendapatanBebanLainNeto
    );
    // Pemisahan ini MURNI penyajian: hasil akhir tidak boleh bergeser
    // sepeser pun dibandingkan bila beban itu tetap di Beban Usaha.
    expect(lhu.shuNeto).toBe(88_375_000 - 13_600_000 + 12_500_000 - 5_000_000 + 3_450_000 - 4_300_000);
  });

  test('akun 5-1900 tidak ditandai "belum diklasifikasikan" walau lhu_klasifikasi-nya NULL', async () => {
    const db = await setupFixture();
    // Kondisi database BARU (setelah migrasi v74): klasifikasi dikosongkan.
    await db.runAsync(`UPDATE account SET lhu_klasifikasi = NULL WHERE kode = '5-1900'`);
    await isiContohJuklat(db);

    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    expect(lhu.totalBebanPerkoperasian).toBe(5_000_000);
    expect(lhu.bebanPerkoperasian[0].belumDiklasifikasikan).toBeUndefined();
    // NULL pada akun ini TIDAK boleh menjatuhkannya ke Beban Usaha
    // sebagai "belum diklasifikasikan".
    expect(lhu.bebanUsaha.map((r) => r.kode)).not.toContain('5-1900');
    expect(lhu.jumlahBebanUsaha).toBe(13_600_000);
  });

  test('tanpa beban perkoperasian, seksinya kosong dan angka lain tidak berubah', async () => {
    const db = await setupFixture();
    await jurnal(db, '2026-03-01', ACC.kas, ACC.pendapatanBunga, 10_000_000);
    await jurnal(db, '2026-03-03', ACC.bebanBunga, ACC.kas, 4_000_000);

    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    expect(lhu.bebanPerkoperasian).toEqual([]);
    expect(lhu.totalBebanPerkoperasian).toBe(0);
    expect(lhu.shuBruto).toBe(6_000_000);
    expect(lhu.shuSebelumPajak).toBe(6_000_000);
  });
});

describe('RC-S98 §2 — urutan baris export LHU sama dengan naskah Juklat', () => {
  test('band & angka antara muncul dalam urutan naskah, dengan tingkat baris yang benar', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');

    const ekspor = buildLHUExport({ namaKoperasi: 'KSP Kenanga', standarAkuntansi: 'SAK_EP' }, lhu, 'Laporan Hasil Usaha');
    const label = ekspor.baris.map((b) => String(b[0]));

    const urutanNaskah = [
      'PARTISIPASI ANGGOTA',
      'Jumlah Partisipasi Anggota',
      'BEBAN USAHA',
      'Jumlah Beban Usaha',
      'SISA HASIL USAHA BRUTO',
      'HASIL INVESTASI',
      'BEBAN PERKOPERASIAN',
      'PENDAPATAN DAN BEBAN LAIN',
      'SISA HASIL USAHA SEBELUM PAJAK',
      'Beban Pajak Penghasilan',
      'SISA HASIL USAHA NETO',
      'PENGHASILAN KOMPREHENSIF LAIN',
      'TOTAL PENGHASILAN KOMPREHENSIF',
    ];
    const indeks = urutanNaskah.map((teks) => label.indexOf(teks));
    expect(indeks).not.toContain(-1);
    expect([...indeks].sort((a, b) => a - b)).toEqual(indeks);

    // `tingkatBaris` sejajar indeks dengan `baris` — syarat renderer.
    expect(ekspor.tingkatBaris).toHaveLength(ekspor.baris.length);
    const tingkatDari = (teks: string): TingkatBarisLaporan | undefined =>
      ekspor.tingkatBaris?.[label.indexOf(teks)];
    expect(tingkatDari('PARTISIPASI ANGGOTA')).toBe('JUDUL');
    expect(tingkatDari('Pendapatan Jasa Pinjaman')).toBe('RINCIAN');
    expect(tingkatDari('Jumlah Beban Usaha')).toBe('SUBTOTAL');
    expect(tingkatDari('SISA HASIL USAHA BRUTO')).toBe('TOTAL');
    expect(tingkatDari('SISA HASIL USAHA NETO')).toBe('TOTAL');
  });

  test('kolom nominal export benar-benar bisa dijumlahkan: beban bertanda negatif', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const ekspor = buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha');
    const nilai = (teks: string) => ekspor.baris.find((b) => b[0] === teks)?.[1];

    expect(nilai('Jumlah Partisipasi Anggota')).toBe(88_375_000);
    expect(nilai('Beban Bunga')).toBe(-13_600_000);
    expect(nilai('Jumlah Beban Usaha')).toBe(-13_600_000);
    expect(nilai('Beban Perkoperasian')).toBe(-5_000_000);
    expect(nilai('Total Beban Perkoperasian')).toBe(-5_000_000);
    expect(nilai('Beban Pajak Penghasilan')).toBe(-4_300_000);

    // Aritmatika kolom seperti pada naskah: seluruh komponen di atas
    // dijumlahkan APA ADANYA menghasilkan SHU Neto.
    const jumlahKolom =
      (nilai('Jumlah Partisipasi Anggota') as number) +
      (nilai('Jumlah Beban Usaha') as number) +
      (nilai('Total Hasil Investasi') as number) +
      (nilai('Total Beban Perkoperasian') as number) +
      (nilai('Pendapatan/(Beban) Lain Neto') as number) +
      (nilai('Beban Pajak Penghasilan') as number);
    expect(jumlahKolom).toBe(lhu.shuNeto);
  });

  test('label periode memakai tanggal Indonesia, bukan format ISO penyimpanan', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const ekspor = buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha');

    expect(ekspor.periodeLabel).toBe('Untuk periode 1 Januari 2026 s.d. 31 Desember 2026');
    expect(ekspor.periodeLabel).not.toContain('2026-01-01');
  });

  test('ringkasan export memuat komposisi pendapatan sesuai perhitungan penutup Lampiran Juklat', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const ekspor = buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha');

    // Naskah: 87,6% dan 12,4% untuk kolom 2021.
    expect(ekspor.ringkasan).toContainEqual({ label: 'Komposisi — Partisipasi Anggota', nilai: '87,6%' });
    expect(ekspor.ringkasan).toContainEqual({ label: 'Komposisi — Hasil Investasi', nilai: '12,4%' });
  });

  test('seksi yang tidak ada isinya ditulis eksplisit, tidak dihilangkan diam-diam', async () => {
    const db = await setupFixture();
    await jurnal(db, '2026-03-01', ACC.kas, ACC.pendapatanBunga, 10_000_000);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const ekspor = buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha');
    const label = ekspor.baris.map((b) => String(b[0]));

    expect(label).toContain('Tidak ada beban usaha');
    expect(label).toContain('Tidak ada hasil investasi');
    expect(label).toContain('Tidak ada beban perkoperasian');
    expect(label).toContain('Tidak ada pendapatan/beban lain');
  });
});

describe('RC-S98 §3 — renderer memakai tingkat baris supaya PDF/CSV rapi', () => {
  test('PDF: JUDUL/RINCIAN/SUBTOTAL/TOTAL dirender dengan kelas yang berbeda', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const html = buildReportHtml(buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha'));

    expect(html).toContain('<tr class="sub-header">');
    expect(html).toContain('<tr class="rincian">');
    expect(html).toContain('<tr class="subtotal">');
    expect(html).toContain('<tr class="total">');
    // Aturan gaya untuk ketiga tingkat baru wajib ada, kalau tidak
    // kelasnya tidak berarti apa pun saat dicetak.
    expect(html).toContain('tr.rincian td:first-child');
    expect(html).toContain('tr.subtotal td');
    expect(html).toContain('tr.total td');
  });

  test('PDF: laporan yang TIDAK mengisi tingkatBaris tetap dirender seperti sebelumnya', () => {
    const html = buildReportHtml({
      judulLaporan: 'Laporan Lama',
      namaFileDasar: 'lama',
      namaKoperasi: 'Koperasi Uji',
      periodeLabel: 'Per 31 Desember 2026',
      kolom: ['Akun', 'Jumlah'],
      baris: [
        ['KELOMPOK', ''],
        ['Kas', 1_000],
      ],
      kolomAngka: [1],
    });
    // Tebakan lama (kolom kedua kosong = band judul) tetap berlaku.
    expect(html).toContain('<tr class="sub-header">');
    expect(html).not.toContain('class="rincian"');
    expect(html).not.toContain('class="subtotal"');
  });

  test('CSV: hierarki dipertahankan lewat indentasi label rincian', async () => {
    const db = await setupFixture();
    await isiContohJuklat(db);
    const lhu = await getLHU(db as never, '2026-01-01', '2026-12-31');
    const csv = buildCsv(buildLHUExport({ namaKoperasi: 'KSP Kenanga' }, lhu, 'Laporan Hasil Usaha'));
    const baris = csv.split('\r\n');

    expect(baris).toContain('PARTISIPASI ANGGOTA,');
    // Rincian diindentasi; band judul & subtotal TIDAK.
    expect(baris.some((b) => b.startsWith('  Pendapatan Jasa Pinjaman,'))).toBe(true);
    expect(baris.some((b) => b.startsWith('Jumlah Partisipasi Anggota,'))).toBe(true);
  });
});

describe('RC-S98 §4 — modul murni penyajian', () => {
  test('komposisi pendapatan memakai penyebut naskah (partisipasi + hasil investasi)', () => {
    // Angka naskah 2021: 85.375.000 + 3.000.000 = 88.375.000 partisipasi.
    const k = hitungKomposisiPendapatanLhu(88_375_000, 12_500_000);
    expect(k.totalPendapatanDasar).toBe(100_875_000);
    expect(formatPersenKomposisi(k.persenPartisipasiAnggota)).toBe('87,6%');
    expect(formatPersenKomposisi(k.persenHasilInvestasi)).toBe('12,4%');

    // Kolom 2022 naskah: 92.300.000 + 6.700.000 = 99.000.000; investasi 15.000.000.
    const k2 = hitungKomposisiPendapatanLhu(99_000_000, 15_000_000);
    expect(formatPersenKomposisi(k2.persenPartisipasiAnggota)).toBe('86,8%');
    expect(formatPersenKomposisi(k2.persenHasilInvestasi)).toBe('13,2%');
  });

  test('penyebut nol / negatif tidak menghasilkan Infinity atau NaN', () => {
    const nol = hitungKomposisiPendapatanLhu(0, 0);
    expect(nol.persenPartisipasiAnggota).toBeNull();
    expect(formatPersenKomposisi(nol.persenPartisipasiAnggota)).toBe('—');

    const negatif = hitungKomposisiPendapatanLhu(1_000_000, -5_000_000);
    expect(negatif.persenHasilInvestasi).toBeNull();
    expect(Number.isFinite(negatif.totalPendapatanDasar)).toBe(true);
  });

  test('nominal pengurang disajikan dalam tanda kurung seperti naskah, dan tidak menyesatkan pada kasus batas', () => {
    expect(formatRupiahPengurang(4_700_000)).toBe('(Rp4.700.000)');
    // Nol bukan pengurangan.
    expect(formatRupiahPengurang(0)).toBe('Rp0');
    // Pengurang bernilai negatif justru MENAMBAH — tidak boleh berkurung.
    expect(formatRupiahPengurang(-500_000)).toBe('Rp500.000');
  });
});
