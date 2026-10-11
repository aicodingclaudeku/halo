import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb } from './testDb';
import { migrasiV77 } from '@/database/db';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import {
  buildCalkExport,
  buildLHUExport,
  buildPosisiKeuanganExport,
  labelKolomKomparatif,
} from '@/export/ReportTableBuilders';
import { DEFAULT_ACCOUNTS, ACCOUNTING_POLICY } from '@/config/defaultCOA';
import {
  KELOMPOK_JENIS_IMBALAN,
  kelompokJenisImbalan,
  selisihHariKalender,
  tambahHariKalender,
} from '@/utils/imbalanKerjaUi';
import { JENIS_IMBALAN } from '@/services/ImbalanKerjaService';
import type { PosisiKeuanganResult } from '@/reports/FinancialReports';

/**
 * PATCH 19 POIN — PRESENTASI/UI/LABEL/NAVIGASI. Suite ini mengunci
 * perubahan yang TIDAK menyentuh logika akuntansi: teks PDF, tanda tangan,
 * header komparatif, urutan & label menu, serta migrasi v77 (aditif /
 * klasifikasi saja). Dibaca dari source untuk berkas `.tsx` (tidak ada
 * transformer JSX di Jest proyek ini).
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const INFO = { namaKoperasi: 'KSP Kenanga', standarAkuntansi: 'SAK_EP' };

function posisiContoh(): PosisiKeuanganResult {
  return {
    asOfDate: '2026-12-31',
    aset: [
      { kode: '1-1000', nama: 'Kas', saldo: 1_000 },
      { kode: '1-1500', nama: 'Aset Tetap', saldo: 500 },
      { kode: '1-1800', nama: 'Rekening Antar Kantor/Unit (RAKU)', saldo: 200 },
      { kode: '1-1205', nama: 'Piutang Jasa Pinjaman', saldo: 100 },
    ],
    liabilitas: [],
    ekuitas: [
      { kode: '3-1000', nama: 'Simpanan Pokok', saldo: 1_000 },
      { kode: '3-2100', nama: 'Cadangan Risiko', saldo: 300 },
      { kode: '3-3000', nama: 'Ekuitas Lainnya', saldo: 100 },
    ],
    labaBerjalan: 400,
    labaBerjalanLabel: 'SHU Tahun Berjalan',
    totalAset: 1_800,
    totalLiabilitas: 0,
    totalEkuitas: 1_800,
    isBalanced: true,
    selisih: 0,
    shuStatus: null,
    tahunBuku: null,
    termasukSaldoAwalDraft: false,
  } as unknown as PosisiKeuanganResult;
}

describe('Poin 1 — PDF dokumen pinjaman tanpa kotak', () => {
  const css = baca('src/export/DokumenKontrakHtml.ts');
  it('.info, .identitas-dokumen, .nilai-utama, .keterangan tidak memakai border/latar', () => {
    for (const sel of ['.info', '.identitas-dokumen', '.nilai-utama', '.keterangan']) {
      const baris = css.split('\n').find((l) => l.trim().startsWith(`${sel} {`)) ?? '';
      expect(baris.length).toBeGreaterThan(0);
      expect(baris).not.toMatch(/border|background/);
    }
  });
});

describe('Poin 2/13/15 — PDF laporan keuangan', () => {
  it('tidak ada label SAK EP di kop/isi; tanggal ISO dicetak format Indonesia', () => {
    const data = buildPosisiKeuanganExport(INFO, posisiContoh());
    // DIPERBARUI: satu-satunya penyebutan SAK EP adalah baris identitas cetak
    // KOPKU Finance di bagian bawah (permintaan pengguna) — kop & isi tetap bersih.
    const tanpaIdentitas = (h: string) => h.replace(/<div class="identitas-cetak">[\s\S]*?<\/div>/, '');
    for (const gayaPdf of ['STANDAR', 'JUKLAT'] as const) {
      const html = buildReportHtml({ ...data, laporanKeuangan: { ...data.laporanKeuangan!, gayaPdf } });
      expect(tanpaIdentitas(html)).not.toMatch(/SAK EP|SAK Entitas Privat/);
      expect(html).toContain('Aplikasi Akuntansi KSP/USP berdasarkan SAK EP');
      expect(html).not.toContain('2026-12-31');
    }
    // Format contoh Lampiran Juklat SOM 2025: kop posisi "Tanggal ... (Dalam Rupiah)".
    expect(buildReportHtml({ ...data, laporanKeuangan: { ...data.laporanKeuangan!, gayaPdf: 'JUKLAT' } })).toContain(
      'Tanggal 31 Desember 2026 (Dalam Rupiah)'
    );
  });

  it('blok tanda tangan Ketua/Sekretaris/Bendahara; nama kosong -> garis titik-titik, bukan nama karangan', () => {
    const data = buildPosisiKeuanganExport(INFO, posisiContoh());
    expect(data.laporanKeuangan?.tanggalAcuan).toBe('2026-12-31');
    expect(data.laporanKeuangan?.juklat?.judul).toBe('Laporan Posisi Keuangan');
    const html = buildReportHtml(data);
    for (const j of ['Ketua', 'Sekretaris', 'Bendahara']) expect(html).toContain(`<div class="ttd-jabatan">${j}</div>`);
    expect(html).toContain('(.................................)');
    expect(html).toMatch(/\.ttd-blok \{[^}]*page-break-inside: avoid/);
    expect(html).toContain('<body class="lk">');
  });

  it('nama pejabat dari data Pengurus dicetak bila tersedia', () => {
    const data = buildPosisiKeuanganExport(INFO, posisiContoh());
    const html = buildReportHtml({
      ...data,
      laporanKeuangan: {
        tanggalAcuan: '2026-12-31',
        penandaTangan: [
          { jabatan: 'Ketua', nama: 'Budi Santoso' },
          { jabatan: 'Sekretaris', nama: null },
          { jabatan: 'Bendahara', nama: 'Sari' },
        ],
      },
    });
    expect(html).toContain('Budi Santoso');
    expect(html).toContain('Sari');
  });

  it('laporan non-keuangan tidak mendapat blok tanda tangan / gaya formal', () => {
    const html = buildReportHtml({
      judulLaporan: 'Daftar Anggota',
      namaFileDasar: 'x',
      namaKoperasi: 'K',
      periodeLabel: 'Per 2026-01-01',
      kolom: ['A'],
      baris: [['x']],
      kolomAngka: [],
    });
    expect(html).not.toContain('class="ttd-blok"');
    expect(html).not.toContain('<body class="lk">');
  });

  it('LHU, CALK ditandai laporan keuangan (tanda tangan)', () => {
    const calk = buildCalkExport(INFO, { tanggalMulai: '2026-01-01', tanggalSelesai: '2026-12-31', sections: [] } as never);
    expect(calk.laporanKeuangan?.tanggalAcuan).toBe('2026-12-31');
    const builders = tanpaKomentar(baca('src/export/ReportTableBuilders.ts'));
    // posisi, posisi komparatif, LHU, LHU komparatif, ekuitas, ekuitas komparatif, arus kas, arus kas komparatif, CALK, LPEA
    expect((builders.match(/laporanKeuangan: \{\s*tanggalAcuan:/g) ?? []).length).toBe(10);
    expect(typeof buildLHUExport).toBe('function');
  });

  it('nama pejabat diisi ExportService dari getSusunanPengurusInti (bukan hardcode)', () => {
    const svc = tanpaKomentar(baca('src/services/ExportService.ts'));
    expect(svc).toMatch(/getSusunanPengurusInti\(lk\.tanggalAcuan\)/);
    expect(svc).toMatch(/const denganTtd = await isiPenandaTanganLaporan\(data\)/);
  });
});

describe('Poin 14 — header komparatif = tahun periode laporan', () => {
  it('2026 vs 2025, 2025 vs 2024 (tidak di-hardcode)', () => {
    expect(labelKolomKomparatif('2026-12-31', '2025-12-31')).toEqual(['2026', '2025']);
    expect(labelKolomKomparatif('2025-06-30', '2024-06-30')).toEqual(['2025', '2024']);
  });
  it('tahun sama -> tanggal lengkap supaya tidak ambigu', () => {
    expect(labelKolomKomparatif('2026-02-28', '2026-01-31')).toEqual(['28 Februari 2026', '31 Januari 2026']);
  });
  it('tidak ada lagi kolom "Periode Berjalan"/"Periode Komparatif" di builder', () => {
    const builders = tanpaKomentar(baca('src/export/ReportTableBuilders.ts'));
    expect(builders).not.toMatch(/'Periode Berjalan'|'Periode Komparatif'/);
  });
});

describe('Poin 9/11 — urutan Posisi Keuangan di export', () => {
  it('RAKU tepat di bawah Piutang Jasa Pinjaman; SHU tepat di bawah Cadangan Risiko', () => {
    const b = buildPosisiKeuanganExport(INFO, posisiContoh()).baris.map((r) => String(r[0]));
    expect(b.indexOf('Rekening Antar Kantor/Unit (RAKU)')).toBe(b.indexOf('Piutang Jasa Pinjaman') + 1);
    expect(b.indexOf('SHU Tahun Berjalan')).toBe(b.indexOf('Cadangan Risiko') + 1);
  });
});

describe('Poin 5/6/10 — migrasi v77 (aditif & klasifikasi saja)', () => {
  it('menambah kolom unit_usaha_id, 4-1500 -> PENDAPATAN_USAHA_LAIN, nama 1-1800 -> RAKU; idempoten', async () => {
    const db = await createTestDb();
    const now = new Date().toISOString();
    const akun = (id: string, kode: string, nama: string, kat: string, nb: string, lhu: string | null) =>
      db.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
         VALUES (?,?,?,?,?,1,0,?,?,?)`,
        id, kode, nama, kat, nb, lhu, now, now
      );
    await akun('a1', '4-1500', 'Pendapatan Bunga', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
    await akun('a2', '1-1800', 'Rekening Antar Kantor (RAK)', 'ASET', 'DEBIT', null);
    await akun('a3', '4-1600', 'Pendapatan Sewa', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');

    const tambah = async (t: string, k: string, tipe: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${t} ADD COLUMN ${k} ${tipe};`);
      } catch {
        /* sudah ada */
      }
    };
    await migrasiV77(db as never, tambah);
    await migrasiV77(db as never, tambah); // idempoten

    const kol = async (t: string) => (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${t})`)).map((c) => c.name);
    expect(await kol('kas_transaksi')).toContain('unit_usaha_id');
    expect(await kol('bank_transaksi')).toContain('unit_usaha_id');
    expect((await db.getFirstAsync<{ l: string }>(`SELECT lhu_klasifikasi AS l FROM account WHERE id='a1'`))?.l).toBe('PENDAPATAN_USAHA_LAIN');
    expect((await db.getFirstAsync<{ n: string }>(`SELECT nama AS n FROM account WHERE id='a2'`))?.n).toBe('Rekening Antar Kantor/Unit (RAKU)');
    // Akun lain tidak tersentuh; kode tidak berubah.
    expect((await db.getFirstAsync<{ l: string }>(`SELECT lhu_klasifikasi AS l FROM account WHERE id='a3'`))?.l).toBe('HASIL_INVESTASI');
    expect((await db.getFirstAsync<{ k: string }>(`SELECT kode AS k FROM account WHERE id='a2'`))?.k).toBe('1-1800');
  });

  it('klasifikasi kustom admin pada 4-1500 tidak ditimpa', async () => {
    const db = await createTestDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('a1','4-1500','Pendapatan Bunga','PENDAPATAN','KREDIT',1,0,'PENDAPATAN_LAIN',?,?)`,
      now, now
    );
    await migrasiV77(db as never, async () => undefined);
    expect((await db.getFirstAsync<{ l: string }>(`SELECT lhu_klasifikasi AS l FROM account WHERE id='a1'`))?.l).toBe('PENDAPATAN_LAIN');
  });

  it('defaultCOA: 4-1500 Pendapatan Usaha Lain, 1-1800 berlabel RAKU, kode tetap', () => {
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1500')?.lhuKlasifikasi).toBe('PENDAPATAN_USAHA_LAIN');
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '1-1800')?.nama).toBe('Rekening Antar Kantor/Unit (RAKU)');
  });
});

describe('Poin 7/8 — menu Penyesuaian', () => {
  const hub = tanpaKomentar(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
  const pos = (r: string) => hub.indexOf(`route: '${r}'`);
  it('Kolektibilitas paling atas; Penyusutan Properti tepat di bawah Nilai Wajar', () => {
    expect(pos('KolektibilitasPiutang')).toBeGreaterThan(-1);
    expect(pos('KolektibilitasPiutang')).toBeLessThan(pos('Rekonsiliasi'));
    expect(pos('Rekonsiliasi')).toBeLessThan(pos('PenyesuaianNilaiWajar'));
    expect(pos('PenyesuaianNilaiWajar')).toBeLessThan(pos('PenyusutanPropertiInvestasi'));
    expect(pos('PenyusutanPropertiInvestasi')).toBeLessThan(pos('ImpairmentInvestasiForm'));
  });
});

describe('Poin 10/17/18 — label', () => {
  const ui = ['src/navigation/RootNavigator.tsx', 'src/screens/Laporan/LaporanScreen.tsx', 'src/export/ReportTableBuilders.ts']
    .map((f) => tanpaKomentar(baca(f)))
    .join('\n');
  it('tidak ada label lama', () => {
    expect(ui).not.toMatch(/Rekening Antar Kantor \(RAK\)/);
    expect(ui).not.toMatch(/Laporan Hasil Usaha \/ Laba Rugi/);
  });
  it('nama laporan baru; rute internal LabaRugi tetap', () => {
    expect(ACCOUNTING_POLICY.SAK_EP.labelLabaRugi).toBe('Laporan Perhitungan Hasil Usaha');
    expect(ui).toMatch(/name="LabaRugi"/);
  });
  it('label persentase jasa per periode/bulan', () => {
    expect(baca('src/screens/Pinjaman/PinjamanFormScreen.tsx')).toContain('Persentase Jasa per Periode/Bulan (%) *');
  });
});

describe('Poin 3 — tanggal personel memakai DatePicker existing', () => {
  const s = tanpaKomentar(baca('src/screens/Pengaturan/MasterKoperasiScreens.tsx'));
  it('form personel memakai FieldTanggalKalender (DatePicker), tampilan format Indonesia', () => {
    expect(s).toMatch(/import DatePicker, \{ formatTanggalIndonesia \} from '@\/components\/DatePicker'/);
    expect(s).toMatch(/<FieldTanggalKalender\s+label="Tanggal Mulai Jabatan"/);
    expect(s).toMatch(/<FieldTanggalKalender\s+label="Tanggal Berakhir Jabatan"/);
    expect(s).toMatch(/formatTanggalIndonesia\(r\.tanggalMulaiJabatan\)/);
    expect(s).toMatch(/tanggalIsoValid\(mulai\)/);
  });
});

describe('Poin 16 — tombol opsi tidak terpotong', () => {
  it('label boleh dua baris, ikon tidak menyusut, baris opsi dapat turun', () => {
    const t = baca('src/components/report/TombolOpsi.tsx');
    expect(t).toMatch(/numberOfLines=\{2\}/);
    expect(t).toMatch(/ikon: \{ flexShrink: 0 \}/);
    expect(baca('src/screens/Laporan/PosisiKeuanganScreen.tsx')).toMatch(/opsiRow: \{ flexDirection: 'row', flexWrap: 'wrap'/);
  });
});

describe('Poin 19 — Imbalan Kerja', () => {
  it('Honorarium berdiri sendiri; tiap jenis existing masuk tepat satu kelompok', () => {
    expect(kelompokJenisImbalan('HONORARIUM')).toBe('HONORARIUM');
    expect(kelompokJenisImbalan('GAJI')).toBe('TETAP');
    const semua = KELOMPOK_JENIS_IMBALAN.flatMap((k) => k.jenis);
    expect([...semua].sort()).toEqual([...JENIS_IMBALAN].sort());
  });
  it('aritmetika hari kalender untuk nilai awal jatuh tempo', () => {
    expect(selisihHariKalender('2026-01-25', '2026-02-05')).toBe(11);
    expect(tambahHariKalender('2026-02-25', 11)).toBe('2026-03-08');
  });
  it('jurnal tetap lewat catatImbalanKerja; nilai awal di app_config, bukan tabel baru', () => {
    const layar = tanpaKomentar(baca('src/screens/Transaksi/ImbalanKerjaFormScreen.tsx'));
    expect(layar).toMatch(/await catatImbalanKerja\(\{/);
    expect(layar).toMatch(/simpanNilaiAwalImbalan\(/);
    const svc = tanpaKomentar(baca('src/services/ImbalanKerjaService.ts'));
    expect(svc).toMatch(/INSERT INTO app_config/);
    expect(baca('src/database/schema.ts')).not.toMatch(/imbalan_kerja_default|imbalan_nilai_awal/);
  });
});

describe('Poin 12 — form Pelepasan Aset', () => {
  it('dikelompokkan per kartu; service & validasi tetap', () => {
    const s = tanpaKomentar(baca('src/screens/Transaksi/PelepasanAsetFormScreen.tsx'));
    for (const j of ['Aset & Nilai Buku', 'Rincian Pelepasan', 'Rekening Penerimaan', 'Pratinjau Laba / Rugi']) {
      expect(s).toContain(`judul="${j}"`);
    }
    expect(s).toContain('await lepaskanAsetTetap(input)');
    expect(s).toContain('pratinjauPelepasanAsetTetap(input)');
  });
});
