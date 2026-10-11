import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67.9.1 — FINAL UX & LOGIC CLEANUP REKONSILIASI KAS/BANK. TEST A–J.
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
  formatTanggalPanjang,
  selisihRingkas,
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


const jumlahJurnal = () => hitung(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'REKONSILIASI_KAS_BANK'`);

describe('RC-S67.9.1 — DATABASE', () => {
  it('TEST A / G — cocok: status Cocok, 0 jurnal; snapshot tanggal/saldo tersimpan', async () => {
    const r = await catatRekonsiliasiDanTindakLanjut(rek(15_000_000));
    expect(r.status).toBe('COCOK');
    expect(await jumlahJurnal()).toBe(0);
    expect(labelStatusRiwayat(r)).toBe('Cocok');
    const row = await testDb.getFirstAsync<any>(`SELECT account_id, tanggal, saldo_buku, saldo_fisik, selisih, status FROM rekonsiliasi_kas_bank WHERE id = ?`, r.id);
    expect(row).toEqual({ account_id: ACC.bank, tanggal: '2026-08-31', saldo_buku: 15_000_000, saldo_fisik: 15_000_000, selisih: 0, status: 'COCOK' });
    // Snapshot tidak berubah walau saldo rekening bergerak setelahnya.
    await jurnalModal('j9', '2026-08-15', 'p2026', ACC.bank, 1_000_000);
    expect((await testDb.getFirstAsync<any>(`SELECT saldo_buku FROM rekonsiliasi_kas_bank WHERE id = ?`, r.id)).saldo_buku).toBe(15_000_000);
  });

  it('TEST B / C — selisih kurang & lebih dihitung sistem', async () => {
    const b = await catatRekonsiliasiDanTindakLanjut(rek(14_800_000));
    expect(b.selisih).toBe(-200_000);
    expect(labelSelisih(b.selisih)).toEqual({ judul: 'Selisih Kurang', nilai: 200_000 });
    const c = await catatRekonsiliasiDanTindakLanjut(rek(15_200_000, { tanggal: '2026-08-30' }));
    expect(c.selisih).toBe(200_000);
    expect(labelSelisih(c.selisih)).toEqual({ judul: 'Selisih Lebih', nilai: 200_000 });
  });

  it('TEST D — historis: saldo buku per 31/08 = 15 jt walau saldo saat ini 20 jt', async () => {
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-08-31')).toBe(15_000_000);
    expect(await getSaldoBukuPerTanggal(ACC.bank, '2026-09-30')).toBe(20_000_000);
    expect(formatTanggalPanjang('2026-08-31')).toBe('31 Agustus 2026');
  });

  it('TEST E — Piutang ditolak', async () => {
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut(rek(1, { accountId: ACC.piutang }));
    } catch (e) {
      err = e;
    }
    expect(String(err?.message)).toMatch(/bukan rekening Kas\/Bank/);
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
  });

  it('TEST F — simpan x3: 1 catatan, maksimal 1 jurnal', async () => {
    const kunci = buatKunciSubmit();
    const t = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    await Promise.all([1, 2, 3].map(() => kunci.jalankan(() => catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: t }))));
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(1);
    expect(await jumlahJurnal()).toBe(1);
  });

  it('TEST H — Transaksi Belum Tercatat & Salah Pencatatan: TIDAK ada jurnal generik', async () => {
    // DIPERBARUI RC-S78 §7A/§7B: penyebabnya kini TERSIMPAN sebagai
    // temuan (dulu dibuang, sehingga hilang dari audit trail) — tetapi
    // perlakuannya tetap TIDAK_PERLU_JURNAL, walau akun ikut dipilih.
    // Itu inti test ini dan tidak berubah: tidak ada jurnal generik.
    for (const [k, penyebab] of [
      ['BELUM_TERCATAT', 'TRANSAKSI_BELUM_TERCATAT'],
      ['SALAH_PENCATATAN', 'SELISIH_PENCATATAN'],
    ] as const) {
      const tl = susunTindakLanjut(-200_000, { opsi: opsi(k), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'x' });
      expect(tl.ok).toBe(true);
      expect((tl as any).tindakLanjut).toEqual({ penyebab, perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'x' });
    }
    const r = await catatRekonsiliasiDanTindakLanjut(rek(14_800_000));
    expect(r.journalId).toBeNull();
    expect(await jumlahJurnal()).toBe(0);
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit pengguna): teks Tindak Lanjut kini menegaskan
    // bahwa temuan masih harus ditindaklanjuti.
    expect(opsi('BELUM_TERCATAT').tindakLanjut).toContain('Catat transaksi yang belum ada pada menu transaksi yang sesuai, lalu lakukan rekonsiliasi ulang.');
    expect(opsi('BELUM_TERCATAT').tindakLanjut).toContain('Belum Ditindaklanjuti');
  });

  it('Biaya Bank: penyesuaian Dr Beban / Cr Bank (semantik existing) → status Penyesuaian Tercatat', async () => {
    const t = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    const r = await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: t });
    const e = await testDb.getAllAsync<any>(`SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, r.journalId!);
    expect(e).toEqual([{ account_id: ACC.beban, debit: 200_000, kredit: 0 }, { account_id: ACC.bank, debit: 0, kredit: 200_000 }]);
    expect(labelStatusRiwayat(r)).toBe('Penyesuaian Tercatat');
    expect(selisihRingkas(r.selisih, (n) => `Rp${n}`)).toBe('−Rp200000');
  });

  it('TEST J — periode tertutup: ditolak & atomik', async () => {
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    const t = (susunTindakLanjut(-200_000, { opsi: opsi('BIAYA_BANK'), akun: { id: ACC.beban, kategori: 'BEBAN' }, catatan: 'biaya adm, ref RK-08' }) as any).tindakLanjut;
    let err: any;
    try {
      await catatRekonsiliasiDanTindakLanjut({ ...rek(14_800_000), tindakLanjut: t });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('ClosedPeriodError');
    expect(await hitung(`SELECT COUNT(*) AS n FROM rekonsiliasi_kas_bank`)).toBe(0);
    expect(strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'))).toContain("'Periode tersebut sudah ditutup dan tidak dapat diubah.'");
  });
});

describe('RC-S67.9.1 — layar (struktural)', () => {
  const layar = strip(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));
  const helper = strip(baca('src/utils/rekonsiliasiForm.ts'));

  // DIPERBARUI RC-S78 §5: taksonomi diperluas menjadi 8 penyebab.
  // Perbedaan Waktu, Jasa Giro, dan Kesalahan Bank sebelumnya tidak
  // pernah muncul di layar, sehingga kejadian lapangan yang paling
  // umum terpaksa dikategorikan sebagai sesuatu yang lain.
  it('delapan penyebab; "Transaksi dalam proses" tetap tidak dipakai sebagai istilah UI', () => {
    expect(OPSI_PENYEBAB.map((o) => o.label)).toEqual([
      'Transaksi Belum Tercatat', 'Salah Pencatatan', 'Perbedaan Waktu',
      'Biaya Bank / Administrasi', 'Jasa Giro / Bunga Bank', 'Kesalahan Bank',
      'Selisih Kas Fisik', 'Penyebab Lain',
    ]);
    // Setiap penyebab wajib punya helper text, tindak lanjut, dan CTA.
    for (const o of OPSI_PENYEBAB) {
      expect(o.deskripsi.trim()).not.toBe('');
      expect(o.tindakLanjut.trim()).not.toBe('');
      expect(o.ctaLabel.trim()).not.toBe('');
    }
    expect(layar + helper).not.toMatch(/Transaksi dalam proses/i);
    expect(layar).toContain('Kenapa ada selisih?');
    expect(layar).toContain('Pilih penyebab yang paling sesuai. Kopku akan menentukan tindakan pencatatan yang diperlukan.');
  });

  // RC-S67.9.2: bagian akun kini TERBUKA otomatis sebagai "Pilih Akun Pencatatan"
  // (sebelumnya "Detail Penyesuaian" terlipat membuat tombol nonaktif tanpa sebab jelas).
  it('TEST I — AccountPicker hanya untuk penyebab penyesuaian, di bagian "Pilih Akun Pencatatan"', () => {
    expect((layar.match(/<AccountPicker/g) ?? []).length).toBe(1);
    expect(layar).toMatch(/perluPilihAkun\(opsi\) && opsi && selisih !== null \? \([\s\S]*?Pilih Akun Pencatatan[\s\S]*?<AccountPicker/);
    expect(layar).toMatch(/status === 'KURANG' \|\| status === 'LEBIH' \? \([\s\S]*?Kenapa ada selisih\?/);
  });

  it('satu CTA utama per kondisi; pesan saat belum lengkap', () => {
    expect((layar.match(/style=\{\[styles\.submitButton/g) ?? []).length).toBe(1);
    // RC-S67.9.2: logika CTA dipindah ke helper murni ctaRekonsiliasi.
    expect(layar).toContain('const cta = ctaRekonsiliasi({ siap, selisih, opsi, akun, catatan });');
    // DIPERBARUI RC-S78 §10: label CTA tidak lagi ditulis di dalam
    // `ctaRekonsiliasi`; ia berasal dari `ctaLabel` milik tiap penyebab,
    // supaya label dan tindak lanjut tidak bisa berbeda antar tempat.
    for (const t of ["label: 'Simpan Rekonsiliasi'", "label: 'Pilih Penyebab'", 'label: p.opsi.ctaLabel']) {
      expect(helper).toContain(t);
    }
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81, instruksi eksplisit pengguna): tombol temuan cukup "Simpan Temuan";
    // pintasan ke Transaksi/Riwayat pindah ke kartu hasil setelah simpan.
    for (const t of ['Catat Penyesuaian', 'Simpan Temuan', 'Tandai Sebagai Perbedaan Waktu']) {
      expect(helper).toContain(`ctaLabel: '${t}'`);
    }
    for (const t of ['Simpan Temuan & Buka Transaksi', 'Simpan Temuan & Buka Riwayat']) {
      expect(helper).not.toContain(t);
    }
    expect(helper).toContain("pesan: 'Lengkapi data rekonsiliasi terlebih dahulu.'");
    expect(layar).toContain("navigation.navigate('TransaksiHub')");
    expect(layar).toContain("navigation.navigate('Laporan', { screen: 'HistoryTransaksi', initial: false })");
  });

  it('saldo buku historis dengan tanggal panjang + helper text; status hasil "Penyesuaian Tercatat"', () => {
    expect(layar).toContain('SALDO MENURUT BUKU PER {formatTanggalPanjang(tanggal).toUpperCase()}');
    expect(layar).toContain('Saldo dihitung berdasarkan transaksi sampai tanggal rekonsiliasi.');
    expect(layar).toContain("'Penyesuaian Tercatat'");
    expect(layar).toContain('berhasil dicatat. Silakan lakukan rekonsiliasi kembali setelah saldo diperbarui.'); // RC-S67.9.2
  });

  it('terminologi lama tidak tampil', () => {
    for (const t of ['Selesaikan Rekonsiliasi', 'SELESAIKAN', 'PERLU_JURNAL', 'TIDAK_PERLU_JURNAL', 'Transaksi dalam proses', 'Lihat Aset', 'DRAFT']) {
      expect(layar).not.toContain(t);
    }
  });
});
