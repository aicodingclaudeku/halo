import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67.9 — REKONSILIASI KAS & BANK (disederhanakan). TEST A–H.
 * DATABASE: SQLite nyata; CashReconciliationService + AccountingEngine asli.
 */

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

import { catatRekonsiliasiDanTindakLanjut, getSaldoBukuPerTanggal } from '@/services/CashReconciliationService';
import {
  buatKunciSubmit,
  hitungSelisih,
  labelSelisih,
  labelStatusRiwayat,
  OPSI_PENYEBAB,
  opsiPenyebabUntuk,
  statusSelisih,
  susunTindakLanjut,
} from '@/utils/rekonsiliasiForm';

const ACC = { kas: 'acc-kas', bank: 'acc-bank', beban: 'acc-beban', pendapatan: 'acc-pdpt', piutang: 'acc-piutang', modal: 'acc-modal' };
const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: string) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}
async function jurnalModal(id: string, tanggal: string, periode: string, akun: string, nilai: number) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,'MODAL_AWAL','Modal','POSTED','user-1',?,?)`,
    id, `JRN-${id}`, tanggal, periode, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, `${id}-d`, id, akun, nilai);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, `${id}-k`, id, ACC.modal, nilai);
}

beforeEach(async () => {
  testDb = await createTestDb();
  const now = new Date().toISOString();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutang, '1-1200', 'Piutang Anggota', 'ASET', 'DEBIT');
  await seedAccount(ACC.beban, '5-2000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.pendapatan, '4-2000', 'Pendapatan Jasa Giro', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at) VALUES ('bank-1','Bank BRI','123','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  // Bank: 15 jt per 31 Agustus 2026; +5 jt pada 10 September 2026 → saldo saat ini 20 jt.
  await jurnalModal('j1', '2026-08-01', 'p2026', ACC.bank, 15_000_000);
  await jurnalModal('j2', '2026-09-10', 'p2026', ACC.bank, 5_000_000);
  await jurnalModal('j3', '2026-08-01', 'p2026', ACC.kas, 3_000_000);
});

const hitung = async (sql: string) => (await testDb.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
const rek = (saldoFisik: number, extra: Record<string, unknown> = {}) => ({
  accountId: ACC.bank, namaRekening: 'Bank BRI', tanggal: '2026-08-31', saldoFisik, createdBy: 'user-1', ...extra,
});
const opsi = (kode: string) => OPSI_PENYEBAB.find((o) => o.kode === kode)!;

describe('RC-S67.9 — TEST A–H (DATABASE)', () => {
  it('TEST D — saldo buku per tanggal historis 15 jt, bukan saldo saat ini 20 jt', async () => {
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-08-31')).toBe(15_000_000);
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-09-30')).toBe(20_000_000);
    const r = await catatRekonsiliasiDanTindakLanjut(rek(15_000_000));
    expect(r.saldoBuku).toBe(15_000_000);
  });

  it('TEST A — saldo cocok: status COCOK, tanpa jurnal penyesuaian', async () => {
    const r = await catatRekonsiliasiDanTindakLanjut(rek(15_000_000));
    expect(r.status).toBe('COCOK');
    expect(r.selisih).toBe(0);
    expect(r.journalId).toBeNull();
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`)).toBe(0);
    expect(labelStatusRiwayat(r)).toBe('Cocok'); // RC-S67.9.1: label riwayat disederhanakan
  });

  it('TEST B — selisih kurang -200.000 (biaya bank): Dr Beban / Cr Bank lewat semantik existing', async () => {
    // DIPERBARUI RC-S78 §11: catatan/referensi bukti bank kini WAJIB
    // untuk seluruh penyebab. Maksud test (Dr Beban / Cr Bank) tidak berubah.
    const tl = susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm Agustus, ref RK-08' });
    expect(tl.ok).toBe(true);
    const r = await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: (tl as any).tindakLanjut });
    expect(r.selisih).toBe(-200_000);
    expect(r.statusPenyelesaian).toBe('SELESAI');
    expect(r.penyebab).toBe('BIAYA_ADMIN_BANK');
    const e = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.beban, debit: 200_000, kredit: 0 },
      { account_id: ACC.bank, debit: 0, kredit: 200_000 },
    ]);
    expect(labelStatusRiwayat(r)).toBe('Penyesuaian Tercatat');
  });

  // DIPERBARUI RC-S78 §18: "jasa giro lewat Lainnya" DIHAPUS. Jasa giro
  // kini kategori tersendiri, dan `LAINNYA` tidak pernah menghasilkan
  // jurnal. Maksud test (Dr Bank / Cr Pendapatan) tidak berubah.
  it('TEST C — selisih lebih +200.000 (Jasa Giro): Dr Bank / Cr Pendapatan', async () => {
    const tl = susunTindakLanjut(200_000, { opsi: opsi('JASA_GIRO'), akun: { id: ACC.pendapatan, kategori: 'PENDAPATAN' }, catatan: 'jasa giro Agustus' });
    const r = await catatRekonsiliasiDanTindakLanjut({ ...rek(15_200_000), tindakLanjut: (tl as any).tindakLanjut });
    expect(r.selisih).toBe(200_000);
    const e = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!
    );
    expect(e).toEqual([
      { account_id: ACC.bank, debit: 200_000, kredit: 0 },
      { account_id: ACC.pendapatan, debit: 0, kredit: 200_000 },
    ]);
  });

  it('transaksi belum dicatat: TIDAK membuat jurnal; hasil pemeriksaan tersimpan sebagai selisih yang belum ditindaklanjuti', async () => {
    // DIPERBARUI RC-S78 §7A: penyebabnya kini DISIMPAN sebagai temuan
    // (dulu jalur "ARAHKAN" membuangnya, sehingga hilang dari audit
    // trail). Yang tidak berubah — dan itu intinya: TIDAK ada jurnal.
    const tl = susunTindakLanjut(-200_000, { opsi: opsi('BELUM_TERCATAT'), akun: null, catatan: 'setoran 23 Sep belum dicatat' });
    expect(tl.ok).toBe(true);
    expect((tl as any).tindakLanjut).toMatchObject({
      penyebab: 'TRANSAKSI_BELUM_TERCATAT',
      perlakuan: 'TIDAK_PERLU_JURNAL',
    });
    const r = await catatRekonsiliasiDanTindakLanjut(rek(14_800_000));
    expect(r.journalId).toBeNull();
    expect(r.statusPenyelesaian).toBe('DRAFT');
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit pengguna): temuan DRAFT kini berlabel
    // "Belum Ditindaklanjuti" — sesuai judul test ini. Aset akuntansinya
    // (tanpa jurnal, status DRAFT) tidak berubah.
    expect(labelStatusRiwayat(r)).toBe('Belum Ditindaklanjuti');
  });

  // DIPERBARUI RC-S78 §5: Perbedaan Waktu KINI ditawarkan di UI. Dulu
  // ia ada di service tetapi tidak pernah muncul di layar, sehingga
  // selisih yang sebenarnya hanya beda tanggal pembukuan terpaksa
  // dikategorikan sebagai sesuatu yang lain.
  it('TIMING_DIFFERENCE: ditawarkan UI (khusus Bank), tanpa jurnal, penjelasan tercatat', async () => {
    expect(OPSI_PENYEBAB.some((o) => o.penyebabService === 'TIMING_DIFFERENCE')).toBe(true);
    const r = await catatRekonsiliasiDanTindakLanjut({
      ...rek(14_800_000),
      tindakLanjut: { penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek no. 12' },
    });
    expect(r.journalId).toBeNull();
    expect(r.statusPenyelesaian).toBe('SELESAI');
    expect(r.perlakuan).toBe('TIDAK_PERLU_JURNAL');
    expect(labelStatusRiwayat(r)).toBe('Selisih Dijelaskan');
  });

  it('TEST E — akun non Kas/Bank (Piutang Anggota) DITOLAK tanpa catatan', async () => {
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut(rek(1, { accountId: ACC.piutang, namaRekening: 'Piutang Anggota' }));
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/bukan rekening Kas\/Bank/);
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
  });

  it('saldo aktual tidak valid (NaN / negatif / pecahan) DITOLAK', async () => {
    for (const v of [NaN, -1, 10.5, undefined as unknown as number]) {
      let err: any;
      try {
        await catatRekonsiliasiDanTindakLanjut(rek(v));
      } catch (e) {
        err = e;
      }
      // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit pengguna): wording user-facing "Saldo aktual" -> "saldo eksternal".
      expect(String(err?.message)).toMatch(/Saldo eksternal harus berupa angka/);
    }
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
  });

  it('TEST F — Simpan x3 cepat: 1 rekonsiliasi, 1 penyesuaian, 1 jurnal', async () => {
    const kunci = buatKunciSubmit();
    const tl = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    const kirim = () => kunci.jalankan(() => catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: tl }));
    const hasil = await Promise.all([kirim(), kirim(), kirim()]);
    expect(hasil.filter((h) => h.status === 'OK')).toHaveLength(1);
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(1);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`)).toBe(1);
    expect(kunci.sibuk).toBe(false); // dilepas setelah selesai: rekonsiliasi berikutnya tetap bisa
  });

  it('TEST G — periode CLOSED: penyesuaian ditolak (ClosedPeriodError) dan pemeriksaannya ikut dibatalkan (atomik)', async () => {
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    const tl = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: tl });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('ClosedPeriodError');
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`)).toBe(0);
    const layar = strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
    // RC-S67.9.1: pesan diseragamkan sesuai instruksi.
    expect(layar).toContain("'Periode tersebut sudah ditutup dan tidak dapat diubah.'");
  });

  it('TEST H — selisih selalu dihitung sistem (aktual − buku); tidak ada input selisih', async () => {
    expect(hitungSelisih(15_000_000, 14_800_000)).toBe(-200_000);
    expect(hitungSelisih(15_000_000, '')).toBeNull();
    const r = await catatRekonsiliasiDanTindakLanjut(rek(14_900_000));
    expect(r.selisih).toBe(-100_000);
    const layar = strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
    expect((layar.match(/<CurrencyInput/g) ?? []).length).toBe(1);
    expect(layar).not.toMatch(/setSelisih/);
  });
});

describe('RC-S67.9 — bahasa & pilihan (helper murni)', () => {
  it('label selisih tanpa angka negatif', () => {
    expect(labelSelisih(-200_000)).toEqual({ judul: 'Selisih Kurang', nilai: 200_000 });
    expect(labelSelisih(200_000)).toEqual({ judul: 'Selisih Lebih', nilai: 200_000 });
    expect(labelSelisih(0)).toEqual({ judul: 'Tidak ada selisih', nilai: 0 });
    expect(statusSelisih(0)).toBe('COCOK');
  });

  // DIPERBARUI RC-S78 §5: taksonomi 7 penyebab untuk Bank & 4 untuk Kas.
  // Perbedaan Waktu, Jasa Giro, dan Kesalahan Bank kini ditawarkan;
  // Selisih Kas Fisik tetap tidak muncul pada Bank, dan penyebab khas
  // bank tidak muncul pada Kas.
  it('pilihan penyebab sesuai arah & jenis rekening; cocok → tanpa pilihan', () => {
    expect(opsiPenyebabUntuk(0, 'BANK')).toEqual([]);
    const bankKurang = opsiPenyebabUntuk(-1, 'BANK').map((o) => o.kode);
    expect(bankKurang).toEqual([
      'BELUM_TERCATAT', 'SALAH_PENCATATAN', 'PERBEDAAN_WAKTU', 'BIAYA_BANK', 'KESALAHAN_BANK', 'LAINNYA',
    ]);
    const bankLebih = opsiPenyebabUntuk(1, 'BANK').map((o) => o.kode);
    expect(bankLebih).toEqual([
      'BELUM_TERCATAT', 'SALAH_PENCATATAN', 'PERBEDAAN_WAKTU', 'JASA_GIRO', 'KESALAHAN_BANK', 'LAINNYA',
    ]);
    const kas = opsiPenyebabUntuk(-1, 'KAS').map((o) => o.kode);
    expect(kas).toEqual(['BELUM_TERCATAT', 'SALAH_PENCATATAN', 'SELISIH_KAS_FISIK', 'LAINNYA']);
    // Penyebab khas bank tidak boleh bocor ke Kas, dan sebaliknya.
    expect(kas).not.toContain('BIAYA_BANK');
    expect(kas).not.toContain('JASA_GIRO');
    expect(kas).not.toContain('KESALAHAN_BANK');
    expect(bankKurang).not.toContain('SELISIH_KAS_FISIK');
  });

  // DIPERBARUI RC-S78 §11: catatan WAJIB untuk SEMUA penyebab (dulu
  // "Lainnya" opsional). Baris SELESAI tanpa penjelasan tidak berguna
  // bagi pemeriksa berikutnya, dan service menolaknya juga.
  it('penyesuaian wajib akun sesuai arah; semua penyebab wajib catatan; tanpa penyebab ditolak', () => {
    expect(susunTindakLanjut(-1, { opsi: null, akun: null, catatan: '' })).toEqual({ ok: false, galat: 'Pilih penyebab selisih.' });
    const CAT = 'hasil opname 23 Sep';
    expect(susunTindakLanjut(-1, { opsi: opsi('SELISIH_KAS_FISIK'), akun: null, catatan: CAT })).toEqual({ ok: false, galat: 'Pilih akun pencatatan terlebih dahulu.' });
    expect(susunTindakLanjut(-1, { opsi: opsi('SELISIH_KAS_FISIK'), akun: { id: 'x', kategori: 'PENDAPATAN' }, catatan: CAT })).toEqual({ ok: false, galat: 'Pilih akun Beban untuk selisih kurang.' });
    // Catatan kosong ditolak untuk setiap penyebab, termasuk Lainnya.
    for (const kode of ['LAINNYA', 'SELISIH_KAS_FISIK', 'BELUM_TERCATAT'] as const) {
      expect(susunTindakLanjut(1, { opsi: opsi(kode), akun: { id: 'x', kategori: 'PENDAPATAN' }, catatan: ' ' }))
        .toEqual({ ok: false, galat: 'Jelaskan penyebab selisih pada catatan.' });
    }
    // RC-S78 §7H: "Lainnya" TIDAK PERNAH menghasilkan jurnal, walau akun dipilih.
    const lain = susunTindakLanjut(1, { opsi: opsi('LAINNYA'), akun: { id: 'x', kategori: 'PENDAPATAN' }, catatan: CAT });
    expect(lain.ok).toBe(true);
    expect((lain as any).tindakLanjut).toEqual({ penyebab: 'LAINNYA', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: CAT });
    expect(susunTindakLanjut(0, { opsi: null, akun: null, catatan: '' })).toEqual({ ok: true });
  });
});

describe('RC-S67.9 — layar (struktural)', () => {
  const layar = strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
  const helper = strip(baca('src/utils/rekonsiliasiForm.ts'));

  it('istilah internal tidak tampil sebagai teks UI', () => {
    // DIPERBARUI RC-S78: 'TIMING_DIFFERENCE' kini muncul di helper
    // sebagai `penyebabService` (nilai database), bukan sebagai TEKS UI —
    // labelnya "Perbedaan Waktu". Larangan untuk LAYAR tetap.
    for (const t of ['DRAFT', 'PERLU_JURNAL', 'TIDAK_PERLU_JURNAL', 'SELESAIKAN', 'Debit', 'Kredit', 'TIMING_DIFFERENCE']) {
      expect(layar).not.toContain(t);
    }
    // 'SELESAI' hanya boleh muncul sebagai pembanding status internal, bukan teks tampilan.
    expect(layar).not.toMatch(/>[^<{]*\bSELESAI\b/);
    expect((layar.match(/'SELESAI'/g) ?? []).length).toBe((layar.match(/statusPenyelesaian === 'SELESAI'/g) ?? []).length);
    // RC-S67.9.2: label CTA dipindah ke helper ctaRekonsiliasi.
    // DIPERBARUI RC-S79 §2A/§2B: label saldo eksternal kini kontekstual
    // ("Rekening Koran" / "Kas Opname"), dan caption "SELISIH" menjadi
    // "HASIL REKONSILIASI". Maksud test — layar memakai bahasa manusia,
    // bukan enum internal — tidak berubah.
    for (const t of ['SALDO MENURUT BUKU', 'HASIL REKONSILIASI', 'Saldo Cocok', 'Ada Selisih', 'Kenapa ada selisih?']) {
      expect(layar).toContain(t);
    }
    for (const t of ['Simpan Rekonsiliasi', 'Catat Penyesuaian']) {
      expect(helper).toContain(t);
    }
    // DIPERBARUI RC-S78 §5/§36: taksonomi menjadi 8 label, dan "Lainnya"
    // diganti "Penyebab Lain" agar tidak terbaca sebagai kategori sisa
    // yang boleh dipakai sebagai jalan pintas.
    for (const t of [
      'Transaksi Belum Tercatat', 'Salah Pencatatan', 'Perbedaan Waktu',
      'Biaya Bank / Administrasi', 'Jasa Giro / Bunga Bank', 'Kesalahan Bank',
      'Selisih Kas Fisik', 'Penyebab Lain',
    ]) {
      expect(helper).toContain(t);
    }
  });

  it('akun hanya diminta untuk penyebab yang memang membutuhkan penyesuaian, difilter Beban/Pendapatan', () => {
    // RC-S67.9.2: kondisi lewat helper perluPilihAkun (tindakan PENYESUAIAN).
    expect(layar).toMatch(/perluPilihAkun\(opsi\) && opsi && selisih !== null \? \([\s\S]*?<AccountPicker[\s\S]*?filterKategori=\{kategoriAkunPenyesuaian\(selisih\)\}/);
    expect(layar).not.toContain('<AccountPicker value={akunLawan}');
  });

  it('kunci submit sinkron + tombol nonaktif saat belum siap/sedang menyimpan', () => {
    expect(layar).toContain('const kunci = useRef(buatKunciSubmit());');
    expect(layar).toContain('kunci.current.jalankan(() =>');
    expect(layar).toContain('disabled={!cta.aktif || submitting}'); // RC-S67.9.1: satu CTA per kondisi
  });
});
