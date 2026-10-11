import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67.9.2 — FINAL UX CLOSURE REKONSILIASI KAS/BANK. TEST A–P.
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
  ctaRekonsiliasi,
  perluPilihAkun,
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


const jurnal = () => hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`);
const layar = strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
const BEBAN = { id: ACC.beban, kategori: 'BEBAN' };
// DIPERBARUI RC-S78: catatan menjadi parameter — ia kini ikut menentukan
// apakah CTA aktif (catatan wajib untuk semua penyebab, §11). Default ''
// supaya kasus "catatan kosong" dapat diuji apa adanya.
const cta = (selisih: number | null, o: string | null, akun: any = null, siap = true, catatan = '') =>
  ctaRekonsiliasi({ siap, selisih, opsi: o ? opsi(o) : null, akun, catatan });

describe('RC-S67.9.2 — DATABASE', () => {
  it('TEST A — cocok: journal 0, status COCOK', async () => {
    const r = await catatRekonsiliasiDanTindakLanjut(rek(15_000_000));
    expect(r.status).toBe('COCOK');
    expect(await jurnal()).toBe(0);
  });
  it('TEST B / C — selisih kurang & lebih', async () => {
    const b = await catatRekonsiliasiDanTindakLanjut(rek(14_800_000));
    expect(b.selisih).toBeLessThan(0);
    expect(labelSelisih(b.selisih).judul).toBe('Selisih Kurang');
    const c = await catatRekonsiliasiDanTindakLanjut(rek(15_200_000, { tanggal: '2026-08-30' }));
    expect(c.selisih).toBeGreaterThan(0);
    expect(labelSelisih(c.selisih).judul).toBe('Selisih Lebih');
  });
  it('TEST D / O — historis: saldo buku mengikuti tanggal (31/08 = 15 jt, 30/09 = 20 jt)', async () => {
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-08-31')).toBe(15_000_000);
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-09-30')).toBe(20_000_000);
  });
  it('TEST E — non Kas/Bank ditolak', async () => {
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut(rek(1, { accountId: ACC.piutang }));
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/bukan rekening Kas\/Bank/);
  });
  it('TEST F — simpan x3: 1 rekonsiliasi, maks 1 jurnal', async () => {
    const k = buatKunciSubmit();
    // DIPERBARUI RC-S78 §7H: "Penyebab Lain" tidak lagi menghasilkan jurnal,
    // jadi kasus uji ini memakai Biaya Bank — penyebab yang memang
    // memerlukan penyesuaian. Maksud test (single-flight / atomicity) tetap.
    const t = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: BEBAN, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    await Promise.all([1, 2, 3].map(() => k.jalankan(() => catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: t }))));
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(1);
    expect(await jurnal()).toBe(1);
  });
  it('TEST G / H — belum tercatat & salah pencatatan: tanpa jurnal generik; diarahkan ke workflow existing', async () => {
    // DIPERBARUI RC-S78 §10: label CTA berasal dari taksonomi, dan
    // temuannya DISIMPAN lebih dulu sebelum navigasi ("Simpan Temuan &
    // Buka ..."), supaya penyebab tidak hilang kalau pengguna tidak jadi
    // mengoreksi apa pun. Catatan kini wajib, jadi CTA butuh catatan.
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit pengguna): tombol utama hanya menyimpan
    // ("Simpan Temuan"); navigasi menjadi pintasan pada kartu hasil.
    expect(cta(-1, 'BELUM_TERCATAT', null, true, 'setoran belum dicatat'))
      .toEqual({ label: 'Simpan Temuan', aktif: true, aksi: 'SIMPAN' });
    expect(cta(-1, 'SALAH_PENCATATAN', null, true, 'nominal tertukar'))
      .toEqual({ label: 'Simpan Temuan', aktif: true, aksi: 'SIMPAN' });
    // DIPERBARUI RC-S78 §7A/§7B: penyebab kini TERSIMPAN sebagai temuan
    // (dulu dibuang), tetapi tetap TANPA jurnal walau akun ikut dipilih.
    expect(susunTindakLanjut(-1, { opsi: opsi('BELUM_TERCATAT'), akun: BEBAN, catatan: 'cek fisik' }))
      .toEqual({ ok: true, tindakLanjut: { penyebab: 'TRANSAKSI_BELUM_TERCATAT', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek fisik' } });
    expect(susunTindakLanjut(-1, { opsi: opsi('SALAH_PENCATATAN'), akun: BEBAN, catatan: 'cek fisik' }))
      .toEqual({ ok: true, tindakLanjut: { penyebab: 'SELISIH_PENCATATAN', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek fisik' } });
    await catatRekonsiliasiDanTindakLanjut(rek(14_800_000));
    expect(await jurnal()).toBe(0);
    // DIPERBARUI RC-S78 §10: teks tindak lanjut diseragamkan menjadi
    // instruksi singkat per penyebab. Maksudnya tidak berubah — koreksi
    // dilakukan pada transaksi sumber, bukan lewat jurnal rekonsiliasi.
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit
    // pengguna): teks kini juga menegaskan bahwa temuan masih harus
    // ditindaklanjuti. Maksud test tetap: koreksi di transaksi sumber, tanpa jurnal.
    expect(opsi('SALAH_PENCATATAN').tindakLanjut).toContain(
      'Periksa transaksi sumber dan koreksi transaksi tersebut, lalu lakukan rekonsiliasi ulang.'
    );
    expect(opsi('SALAH_PENCATATAN').tindakLanjut).toContain('Belum Ditindaklanjuti');
  });
  it('TEST I / J — biaya bank & selisih kas fisik: treatment existing (Dr Beban / Cr Kas-Bank); akun tetap diminta karena tidak ada mapping otomatis', async () => {
    // FINDING (didokumentasikan): tidak ada account_mapping untuk biaya bank / selisih kas;
    // service existing mewajibkan akun lawan. Tanpa akun → CTA nonaktif + pesan jelas.
    expect(cta(-200_000, 'BIAYA_BANK', null, true, 'ref RK-08'))
      .toEqual({ label: 'Catat Penyesuaian', aktif: false, aksi: 'NONE', pesan: 'Pilih akun pencatatan terlebih dahulu.' });
    const tb = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: BEBAN, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    const rb = await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: tb });
    const eb = await testDb.getAllAsync<any>(`SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, rb.journalId!);
    expect(eb).toEqual([{ account_id: ACC.beban, debit: 200_000, kredit: 0 }, { account_id: ACC.bank, debit: 0, kredit: 200_000 }]);
    const tk = (susunTindakLanjut(-100_000, { opsi: opsi('SELISIH_KAS_FISIK'), akun: BEBAN, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    const rk = await catatRekonsiliasiDanTindakLanjut({ accountId: ACC.kas, namaRekening: 'Kas', tanggal: '2026-08-31', saldoFisik: 2_900_000, createdBy: 'user-1', tindakLanjut: tk });
    const ek = await testDb.getAllAsync<any>(`SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, rk.journalId!);
    expect(ek).toEqual([{ account_id: ACC.beban, debit: 100_000, kredit: 0 }, { account_id: ACC.kas, debit: 0, kredit: 100_000 }]);
  });
  it('TEST P — periode tertutup ditolak; tanpa catatan & jurnal', async () => {
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    // DIPERBARUI RC-S78 §7H: "Penyebab Lain" tidak lagi menghasilkan jurnal,
    // jadi kasus uji ini memakai Biaya Bank — penyebab yang memang
    // memerlukan penyesuaian. Maksud test (single-flight / atomicity) tetap.
    const t = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: BEBAN, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: t });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('ClosedPeriodError');
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
    expect(await jurnal()).toBe(0);
    expect(layar).toContain("'Periode tersebut sudah ditutup dan tidak dapat diubah.'");
  });
});

describe('RC-S67.9.2 — flow "Lainnya" & CTA', () => {
  // DIPERBARUI RC-S78 §7H/§12: "Penyebab Lain" adalah EXCEPTION, bukan
  // jalan pintas jurnal. Tidak ada AccountPicker dan tidak pernah
  // menghasilkan penyesuaian; yang wajib justru catatannya.
  it('TEST K — Penyebab Lain: tanpa AccountPicker; catatan kosong menonaktifkan CTA', () => {
    expect(cta(-200_000, 'LAINNYA')).toEqual({ label: 'Simpan Temuan', aktif: false, aksi: 'NONE', pesan: 'Jelaskan penyebab selisih pada catatan.' });
    expect(perluPilihAkun(opsi('LAINNYA'))).toBe(false);
    // Bagian tampil langsung (tidak terlipat): tidak ada state lipat/buka.
    expect(layar).not.toMatch(/detailTerbuka|setDetailTerbuka|Akun pencatatan belum dipilih/);
    expect(layar).toMatch(/perluPilihAkun\(opsi\) && opsi && selisih !== null \? \(\s*<>\s*<View style=\{styles\.akunSection\}>\s*<Text style=\{styles\.akunJudul\}>Pilih Akun Pencatatan<\/Text>/);
    expect(layar).toContain('Pilih akun yang sesuai untuk mencatat selisih ini.');
    expect(layar).toContain('{cta.pesan && !submitting ? <Text style={styles.ctaPesan}>{cta.pesan}</Text> : null}');
  });
  // DIPERBARUI RC-S78 §11: catatan WAJIB (dulu opsional).
  it('TEST L — Penyebab Lain dengan catatan: CTA aktif, tetap tanpa jurnal', () => {
    expect(cta(-200_000, 'LAINNYA', null, true, 'selisih setoran ATM belum jelas'))
      .toEqual({ label: 'Simpan Temuan', aktif: true, aksi: 'SIMPAN' });
    expect(opsi('LAINNYA').wajibCatatan).toBe(true);
  });
  it('akun salah arah (Pendapatan untuk selisih kurang) → CTA nonaktif + pesan', () => {
    // Dipindah ke Selisih Kas Fisik: satu-satunya penyebab dua arah yang
    // memang memerlukan akun lawan.
    expect(cta(-1, 'SELISIH_KAS_FISIK', { id: 'x', kategori: 'PENDAPATAN' }, true, 'hasil opname')
      .pesan).toBe('Pilih akun Beban untuk selisih kurang.');
  });
  it('CTA: belum siap → pesan lengkapi; cocok → Simpan; selisih tanpa penyebab → Pilih Penyebab (nonaktif + pesan)', () => {
    expect(cta(null, null, null, false)).toEqual({ label: 'Simpan Rekonsiliasi', aktif: false, aksi: 'NONE', pesan: 'Lengkapi data rekonsiliasi terlebih dahulu.' });
    expect(cta(0, null)).toEqual({ label: 'Simpan Rekonsiliasi', aktif: true, aksi: 'SIMPAN' });
    expect(cta(-1, null)).toEqual({ label: 'Pilih Penyebab', aktif: false, aksi: 'NONE', pesan: 'Pilih penyebab selisih di atas.' });
  });
  it('TEST M — ganti penyebab (Lainnya → Biaya Bank) mereset akun; bagian akun hanya untuk penyebab penyesuaian', () => {
    expect(layar).toMatch(/onPress=\{\(\) => \{\s*setOpsi\(o\);\s*setAkun\(null\);/);
    expect(perluPilihAkun(opsi('BELUM_TERCATAT'))).toBe(false);
    expect(perluPilihAkun(opsi('SALAH_PENCATATAN'))).toBe(false);
    expect(perluPilihAkun(null)).toBe(false);
  });
  it('TEST N / O — ganti rekening / tanggal: saldo buku dimuat ulang; penyebab, akun, catatan direset; saldo aktual direset saat ganti rekening', () => {
    expect(layar).toMatch(/const muatSaldo = useCallback\([\s\S]*?getSaldoBukuPerTanggal\(rekening\.accountId, tanggal\)[\s\S]*?\}, \[rekening, tanggal\]\);/);
    expect(layar).toMatch(/setOpsi\(null\);\s*setAkun\(null\);\s*setCatatan\(''\);\s*setGalatForm\(null\);\s*\}, \[status, rekening, tanggal\]\);/);
    expect(layar).toMatch(/setSaldoAktual\(''\);\s*\}, \[rekening\]\);/);
  });
  it('status hasil: Rekonsiliasi Tersimpan / Penyesuaian Tercatat (bukan "Rekonsiliasi selesai")', () => {
    expect(layar).toContain("'Saldo buku dan saldo eksternal cocok. Tidak diperlukan penyesuaian.'"); // DIPERBARUI RC-S81 §7: wording user-facing "saldo aktual" diganti "saldo eksternal".
    expect(layar).toContain('berhasil dicatat. Silakan lakukan rekonsiliasi kembali setelah saldo diperbarui.');
    expect(layar).not.toMatch(/Rekonsiliasi selesai/i);
  });
  it('static: terminologi lama tidak tampil', () => {
    for (const t of ['Selesaikan Rekonsiliasi', 'PERLU_JURNAL', 'TIDAK_PERLU_JURNAL', 'Transaksi dalam proses', 'Akun pencatatan belum dipilih', 'Detail Penyesuaian']) {
      expect(layar).not.toContain(t);
    }
  });
});
