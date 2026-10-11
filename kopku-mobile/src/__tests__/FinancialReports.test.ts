import { createTestDb, TestDb } from './testDb';

/**
 * FIXTURE FIX (kategori B — test setup, BUKAN produksi): sebagian jalur
 * laporan (mis. generateCALK -> listAsetDenganNilaiBuku, dan resolusi
 * accounting_period untuk CALK manual) memakai `getDb()` internal seperti
 * SELURUH service lain di aplikasi ini. Test ini SEBELUMNYA tidak pernah
 * memasang mock '@/database/db', sehingga panggilan tersebut jatuh ke
 * runtime expo-sqlite yang memang tidak tersedia di lingkungan test.
 * Produksi TIDAK diubah supaya bergantung pada mock — yang dilakukan di
 * sini PERSIS pola yang sudah dipakai seluruh test lain di repo ini
 * (PinjamanService/ShuService/KasBankService): arahkan getDb()/
 * withTransaction() ke SQLite sungguhan milik test (testDb.ts / sql.js,
 * skema asli schema.ts), bukan ke data palsu.
 */
let dbAktif: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => dbAktif),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await dbAktif.withTransactionAsync(async () => {
      result = await fn(dbAktif);
    });
    return result;
  }),
}));
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import {
  getTrialBalance,
  getLedger,
  getPosisiKeuangan,
  getLabaRugi,
  getInformasiShuRAT,
  getPerubahanEkuitas,
  getArusKas,
  generateCALK,
  getCalkDenganEditManual,
  simpanCalkManual,
  resetCalkKeOtomatis,
  getPosisiKeuanganKomparatif,
  getLabaRugiKomparatif,
  getPerubahanEkuitasKomparatif,
  getArusKasKomparatif,
  validasiKesetaraanPeriode,
  auditBalancePosisiKeuangan,
} from '@/reports/FinancialReports';

/**
 * Integration test modul Laporan Keuangan — memakai SQLite SUNGGUHAN
 * (via sql.js, skema asli dari schema.ts) dan jurnal SUNGGUHAN yang
 * dibuat lewat AccountingEngine.createJournal, BUKAN data dummy yang
 * ditempel ke laporan. Ini membuktikan laporan benar-benar berasal
 * dari journal/journal_entry.
 */

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  pendapatanJasa: 'acc-pendapatan-jasa',
  bebanOperasional: 'acc-beban-operasional',
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  dbAktif = db;

  // FIXTURE FIX (kategori B): service yang dipanggil lewat jalur laporan
  // (mis. catatInvestasi/catatImpairmentInvestasi pada test disclosure
  // CALK) memakai requirePermission() seperti seluruh service lain.
  // Sebelumnya fixture ini tidak pernah menyeed app_user, sehingga
  // pemeriksaan izin ditolak dengan benar (UnauthorizedError). Matriks
  // role_permission TIDAK diseed manual — PermissionService sudah
  // self-heal (pastikanPermissionMatrix), jadi cukup usernya yang ada.
  {
    const nowUser = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
      nowUser,
      nowUser
    );
  }

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.bebanOperasional, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.simpananPokok);
  await seedMapping(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.simpananWajib);
  await seedMapping(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  await db.runAsync(
    `INSERT INTO koperasi (id, nama, tahun_buku_aktif, standar_akuntansi, setup_selesai, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)`,
    'kop-1',
    'Koperasi Uji Coba',
    2026,
    'SAK_EP',
    new Date().toISOString(),
    new Date().toISOString()
  );

  // Transaksi nyata lewat AccountingEngine — bukan insert manual ke journal_entry.
  await createJournal(db as any, {
    tanggal: '2026-02-01',
    sumberTransaksi: 'SIMPANAN_POKOK',
    deskripsi: 'Setoran simpanan pokok anggota A',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 100000, kredit: 0 },
      { accountId: ACC.simpananPokok, debit: 0, kredit: 100000 },
    ],
  });

  await createJournal(db as any, {
    tanggal: '2026-02-05',
    sumberTransaksi: 'SIMPANAN_WAJIB',
    deskripsi: 'Setoran simpanan wajib anggota A',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 50000, kredit: 0 },
      { accountId: ACC.simpananWajib, debit: 0, kredit: 50000 },
    ],
  });

  await createJournal(db as any, {
    tanggal: '2026-03-01',
    sumberTransaksi: 'PENCAIRAN_PINJAMAN',
    deskripsi: 'Pencairan pinjaman anggota A',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.piutang, debit: 80000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 80000 },
    ],
  });

  await createJournal(db as any, {
    tanggal: '2026-04-01',
    sumberTransaksi: 'ANGSURAN_JASA',
    deskripsi: 'Pembayaran jasa pinjaman anggota A',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.kas, debit: 5000, kredit: 0 },
      { accountId: ACC.pendapatanJasa, debit: 0, kredit: 5000 },
    ],
  });

  await createJournal(db as any, {
    tanggal: '2026-04-10',
    sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
    deskripsi: 'Pembayaran beban operasional tunai',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC.bebanOperasional, debit: 2000, kredit: 0 },
      { accountId: ACC.kas, debit: 0, kredit: 2000 },
    ],
  });

  return db;
}

describe('Reporting engine — data harus berasal dari journal/journal_entry (PRD §24-27)', () => {
  test('Neraca Saldo: total debit = total kredit, dan saldo per akun benar', async () => {
    const db = await setupFixture();
    const trial = await getTrialBalance(db as any, '2026-12-31');

    expect(trial.isBalanced).toBe(true);
    expect(trial.totalDebit).toBe(trial.totalKredit);

    const kas = trial.rows.find((r) => r.accountId === ACC.kas);
    // 100000 + 50000 - 80000 + 5000 - 2000 = 73000
    expect(kas?.debit).toBe(73000);

    const simpananPokok = trial.rows.find((r) => r.accountId === ACC.simpananPokok);
    expect(simpananPokok?.kredit).toBe(100000);
  });

  test('Neraca Saldo mendeteksi ketidakseimbangan jika data journal_entry rusak (bukan selalu true)', async () => {
    const db = await setupFixture();
    // Sisipkan journal_entry TIDAK BALANCE langsung ke tabel (bypass engine)
    // untuk membuktikan validasi Neraca Saldo benar-benar memeriksa data,
    // bukan asumsi bawaan.
    await db.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j-broken','JRN-BROKEN','2026-05-01','period-2026','MANUAL','Jurnal rusak untuk uji','POSTED','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-broken-1','j-broken',?,10000,0,0)`,
      ACC.kas
    );
    // Sengaja TIDAK menambahkan baris kredit lawannya.

    const trial = await getTrialBalance(db as any, '2026-12-31');
    expect(trial.isBalanced).toBe(false);
    expect(trial.totalDebit).not.toBe(trial.totalKredit);
  });

  test('Buku Besar: filter tanggal & akun, saldo berjalan terhitung benar', async () => {
    const db = await setupFixture();
    const ledger = await getLedger(db as any, ACC.kas, { tanggalMulai: '2026-01-01', tanggalSelesai: '2026-12-31' });

    expect(ledger.length).toBe(5);
    expect(ledger[0].saldoBerjalan).toBe(100000);
    expect(ledger[ledger.length - 1].saldoBerjalan).toBe(73000);

    const filtered = await getLedger(db as any, ACC.kas, { tanggalMulai: '2026-04-01', tanggalSelesai: '2026-04-30' });
    expect(filtered.length).toBe(2);
  });

  test('Laporan Posisi Keuangan: Aset = Liabilitas + Ekuitas (termasuk SHU berjalan)', async () => {
    const db = await setupFixture();
    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');

    expect(posisi.totalAset).toBe(153000); // Kas 73000 + Piutang 80000
    expect(posisi.totalLiabilitas).toBe(0);
    expect(posisi.labaBerjalan).toBe(3000); // Pendapatan 5000 - Beban 2000
    expect(posisi.totalEkuitas).toBe(153000); // 150000 (simpanan) + 3000 (laba berjalan)
    expect(posisi.isBalanced).toBe(true);
    expect(posisi.selisih).toBe(0);
  });

  test('Laporan Hasil Usaha/Laba Rugi: dihitung dari mutasi periode, bukan kumulatif', async () => {
    const db = await setupFixture();
    const laba = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');

    expect(laba.totalPendapatan).toBe(5000);
    expect(laba.totalBeban).toBe(2000);
    expect(laba.hasilUsaha).toBe(3000);
  });

  test('Prioritas 5 (G): Penghasilan Komprehensif Lain SELALU 0 (tidak ada mekanisme OCI di aplikasi ini) — bukan fiktif, dan total komprehensif = hasilUsaha + OCI', async () => {
    const db = await setupFixture();
    const laba = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');

    expect(laba.penghasilanKomprehensifLain).toBe(0);
    expect(laba.totalPenghasilanKomprehensif).toBe(laba.hasilUsaha);
    expect(laba.totalPenghasilanKomprehensif).toBe(3000);
  });

  test('Laba Rugi: transaksi yang di-REVERSAL tetap netto benar (bug fix Phase 1, AUDIT_INTERNAL.md §3.5)', async () => {
    const db = await setupFixture();

    // Tambah satu transaksi pendapatan ekstra, lalu batalkan lewat
    // reversal (bukan hapus) — pola koreksi yang dipakai di seluruh app.
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa tambahan (akan dikoreksi)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 10000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 10000 },
      ],
    });
    await reverseJournal(db as any, journalId, 'user-1', 'Salah input, dibatalkan');

    const laba = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');

    // SEBELUM fix: filter cuma 'POSTED' membuat baris asli (sekarang
    // berstatus REVERSED) ikut terbuang, tapi jurnal reversal-nya
    // (berstatus POSTED, kredit/debit dibalik) tetap terhitung —
    // hasilnya pendapatan malah berkurang 10000 (5000 - 10000 = -5000),
    // padahal seharusnya balik ke angka semula (transaksi dibatalkan
    // = tidak berpengaruh sama sekali ke Laba Rugi).
    expect(laba.totalPendapatan).toBe(5000);
    expect(laba.hasilUsaha).toBe(3000);
  });

  test('Arus Kas: transaksi kas yang di-REVERSAL tetap netto benar (bug fix Phase 1)', async () => {
    const db = await setupFixture();

    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-07-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Penerimaan kas tambahan (akan dikoreksi)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 20000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 20000 },
      ],
    });
    await reverseJournal(db as any, journalId, 'user-1', 'Salah input, dibatalkan');

    const arusKas = await getArusKas(db as any, '2026-01-01', '2026-12-31');
    // kasAkhirAktual dihitung dari getAccountBalance (sudah benar sejak
    // awal); rincian aktivitas operasi HARUS konsisten dengan itu —
    // transaksi yang dibatalkan tidak boleh muncul sebagai kas masuk
    // 20000 di rincian (itu yang terjadi kalau REVERSED tidak dihitung).
    const totalRincian = arusKas.rincian.reduce((a, r) => a + r.jumlah, 0);
    expect(totalRincian).toBe(arusKas.kasAkhirAktual - arusKas.kasAwal);
  });

  test('Laporan Perubahan Ekuitas: saldo awal 0, mutasi = setoran periode berjalan, saldo akhir benar', async () => {
    const db = await setupFixture();
    const ekuitas = await getPerubahanEkuitas(db as any, '2026-01-01', '2026-12-31');

    expect(ekuitas.totalSaldoAwal).toBe(0); // belum ada transaksi sebelum 2026
    expect(ekuitas.totalMutasi).toBe(150000); // simpanan pokok + wajib
    expect(ekuitas.hasilUsahaPeriode).toBe(3000);
    expect(ekuitas.totalSaldoAkhir).toBe(153000);
  });

  test('Prioritas 6 (P): perolehan aset tetap (ASET_TETAP) tunai diklasifikasikan INVESTASI, bukan default OPERASI', async () => {
    const db = await setupFixture();
    const asetTetap = 'acc-aset-tetap';
    await seedAccount(db, asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');

    await createJournal(db as any, {
      tanggal: '2026-08-01',
      sumberTransaksi: 'ASET_TETAP',
      deskripsi: 'Beli komputer kantor tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: asetTetap, debit: 10000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 10000 },
      ],
    });

    const arusKas = await getArusKas(db as any, '2026-01-01', '2026-12-31');
    // SEBELUM FIX: -10000 ini masuk ke `operasi` (fallback default),
    // bukan `investasi` — total tetap terekonsiliasi (kolomnya saja
    // yang salah), tapi klasifikasi tiga aktivitas jadi keliru.
    expect(arusKas.investasi).toBe(-10000);
    const rincianAset = arusKas.rincian.find((r) => r.deskripsi.includes('komputer'));
    expect(rincianAset?.aktivitas).toBe('INVESTASI');
  });

  test('Prioritas 6 (P): pencairan utang bank (UTANG_BANK) diklasifikasikan PENDANAAN, bukan default OPERASI', async () => {
    const db = await setupFixture();
    const utangBank = 'acc-utang-bank';
    await seedAccount(db, utangBank, '2-2000', 'Utang Bank', 'LIABILITAS', 'KREDIT');

    await createJournal(db as any, {
      tanggal: '2026-08-01',
      sumberTransaksi: 'UTANG_BANK',
      deskripsi: 'Pencairan pinjaman bank ke koperasi',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 200000, kredit: 0 },
        { accountId: utangBank, debit: 0, kredit: 200000 },
      ],
    });

    const arusKas = await getArusKas(db as any, '2026-01-01', '2026-12-31');
    expect(arusKas.pendanaan).toBe(150000 + 200000); // simpanan pokok+wajib + pencairan utang bank
    const rincianUtang = arusKas.rincian.find((r) => r.deskripsi.includes('Pencairan pinjaman bank'));
    expect(rincianUtang?.aktivitas).toBe('PENDANAAN');
  });

  test('Laporan Arus Kas: kas akhir dari klasifikasi jurnal HARUS sama dengan saldo kas aktual (rekonsiliasi)', async () => {
    const db = await setupFixture();
    const arusKas = await getArusKas(db as any, '2026-01-01', '2026-12-31');

    expect(arusKas.kasAwal).toBe(0);
    expect(arusKas.pendanaan).toBe(150000); // simpanan pokok + wajib
    expect(arusKas.operasi).toBe(-77000); // -80000 (pencairan) + 5000 (jasa) - 2000 (beban)
    expect(arusKas.investasi).toBe(0);
    expect(arusKas.kasAkhirDihitung).toBe(73000);
    expect(arusKas.kasAkhirAktual).toBe(73000);
    expect(arusKas.terekonsiliasi).toBe(true);
    expect(arusKas.selisihRekonsiliasi).toBe(0);
  });

  test('CALK: dihasilkan dari data koperasi & laporan nyata, bukan teks statis', async () => {
    const db = await setupFixture();
    const calk = await generateCALK(db as any, '2026-01-01', '2026-12-31');

    const infoUmum = calk.sections.find((s) => s.sectionKey === 'informasi_umum');
    expect(infoUmum?.konten).toContain('Koperasi Uji Coba');

    // Pasca-Prioritas 12/N: nama standar akuntansi sekarang ada di
    // section "dasar_penyusunan" (bukan lagi "kebijakan_akuntansi",
    // yang sekarang berisi ikhtisar 19 kebijakan naratif — lihat test
    // describe block terpisah di bawah).
    const dasarPenyusunan = calk.sections.find((s) => s.sectionKey === 'dasar_penyusunan');
    // RC-S39 follow-up: nama standar di CALK adalah konstanta kanonik,
    // BUKAN nilai kolom `koperasi.standar_akuntansi`. Sebelumnya laporan
    // mencetak apa pun yang tersimpan di sana — instalasi lama
    // menghasilkan "disusun berdasarkan SAK EMKM" di laporan aktif.
    expect(dasarPenyusunan?.konten).toContain('SAK Entitas Privat (SAK EP)');
    expect(dasarPenyusunan?.konten).not.toContain('EMKM');

    const kas = calk.sections.find((s) => s.sectionKey === 'kas');
    expect(kas?.konten).toContain('73.000'); // saldo kas nyata, bukan angka rekaan

    const arusKasSection = calk.sections.find((s) => s.sectionKey === 'arus_kas');
    expect(arusKasSection?.konten).toContain('sesuai dengan saldo kas/bank');
  });
});

// ============================================================
// Prioritas 12 (N) — CALK lengkap & dinamis: 21 section, kebijakan
// akuntansi naratif (Prioritas 11/M), dan penggabungan dengan edit
// manual (calk_note) yang TIDAK PERNAH ditimpa auto-generate.
// ============================================================
describe('generateCALK — 21 section lengkap, semuanya dari data actual (Prioritas 12/N)', () => {
  test('mencakup seluruh section wajib', async () => {
    const db = await setupFixture();
    const calk = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const keys = calk.sections.map((s) => s.sectionKey);

    const wajib = [
      'informasi_umum',
      'dasar_penyusunan',
      'kebijakan_akuntansi',
      'kas',
      'piutang',
      'penyisihan_piutang',
      'aset_tetap',
      'penyusutan',
      'aset_tak_berwujud',
      'amortisasi',
      'investasi',
      'utang',
      'simpanan_anggota',
      'ekuitas',
      'pendapatan',
      'beban',
      'penghasilan_komprehensif_lain',
      'shu',
      'arus_kas',
      'imbalan_kerja',
      'biaya_pinjaman',
      'informasi_komparatif',
    ];
    for (const k of wajib) expect(keys).toContain(k);
  });

  test('section SHU membaca status actual dari shu_konfigurasi, tidak lagi berkomentar "modul SHU belum tersedia"', async () => {
    const db = await setupFixture();
    const calkSebelum = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const shuSebelum = calkSebelum.sections.find((s) => s.sectionKey === 'shu');
    expect(shuSebelum?.konten).not.toContain('belum tersedia');
    expect(shuSebelum?.konten).toContain('belum dihitung');

    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2026',2026,20,30,30,5,5,5,5,0,0,3000,'DIHITUNG',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    const calkSesudah = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const shuSesudah = calkSesudah.sections.find((s) => s.sectionKey === 'shu');
    expect(shuSesudah?.konten).toContain('telah dihitung');
    expect(shuSesudah?.konten).toContain('3.000');
  });

  test('section OCI menyatakan eksplisit tidak ada, bukan angka fiktif', async () => {
    const db = await setupFixture();
    const calk = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const oci = calk.sections.find((s) => s.sectionKey === 'penghasilan_komprehensif_lain');
    expect(oci?.konten).toContain('Tidak terdapat penghasilan komprehensif lain');
  });

  test('CALK TIDAK GAGAL walau fitur opsional (akrual bunga/imbalan kerja) belum pernah dipakai koperasi (mapping belum ada)', async () => {
    const db = await setupFixture();
    // setupFixture TIDAK menyeed mapping UTANG_BUNGA/UTANG_IMBALAN_KERJA
    // sama sekali — CALK harus tetap berhasil, bukan melempar error.
    await expect(generateCALK(db as any, '2026-01-01', '2026-12-31')).resolves.toBeDefined();
  });

  // ============================================================
  // Phase 17 §4/§13 (#11/#12) — CALK periode LAMA tidak boleh diam-diam
  // membaca kondisi database SEKARANG untuk aset/investasi/utang.
  // ============================================================
  test('#11/#12: CALK 2025 TIDAK menampilkan aset yang baru dibeli di 2026; CALK 2026 menampilkannya', async () => {
    const db = await setupFixture();
    await db.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at)
       VALUES ('aset-2026','AST-2026','Mesin Baru 2026',15000000,0,60,'2026-06-01','TUNAI','PEMBELIAN','user-1',?)`,
      new Date().toISOString()
    );

    const calk2025 = await generateCALK(db as any, '2025-01-01', '2025-12-31');
    const asetTetap2025 = calk2025.sections.find((s) => s.sectionKey === 'aset_tetap')!;
    expect(asetTetap2025.konten).not.toContain('15.000.000');

    const calk2026 = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const asetTetap2026 = calk2026.sections.find((s) => s.sectionKey === 'aset_tetap')!;
    expect(asetTetap2026.konten).toContain('15.000.000');
  });

  test('Phase 17 §10: CALK tanpa impairment investasi menyatakan eksplisit tidak ada, bukan angka fiktif', async () => {
    const db = await setupFixture();
    const calk = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const investasiSection = calk.sections.find((s) => s.sectionKey === 'investasi')!;
    expect(investasiSection.konten).toContain('Tidak ada penurunan nilai investasi');
  });

  test('Phase 17 §10: CALK menampilkan disclosure impairment investasi kalau memang ada tercatat', async () => {
    const db = await setupFixture();
    await seedAccount(db, 'acc-investasi', '1-1610', 'Penyertaan pada Koperasi Lain', 'ASET', 'DEBIT');
    await seedAccount(db, 'acc-beban-impairment', '5-2150', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT');
    await seedAccount(db, 'acc-penyisihan-impairment', '1-1900', 'Penyisihan Penurunan Nilai Investasi', 'ASET', 'KREDIT');
    await seedMapping(db, 'INVESTASI_KOPERASI_LAIN', 'DEBIT_ASET', 'acc-investasi');
    await seedMapping(db, 'IMPAIRMENT_INVESTASI', 'DEBIT_BEBAN', 'acc-beban-impairment');
    await seedMapping(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN', 'acc-penyisihan-impairment');

    // FIXTURE FIX (kategori B): catatInvestasi() memvalidasi saldo Kas
    // (guard kas negatif) — fixture dasar hanya punya kas kecil, jadi
    // penolakannya BENAR. Ditambah modal awal lewat jurnal MODAL_AWAL
    // POSTED (pola yang sama dengan fixture lain), bukan dengan
    // mem-bypass validasi saldo.
    await seedAccount(db, 'acc-modal-investasi', '3-3100', 'Modal Disetor Lainnya', 'EKUITAS', 'KREDIT');
    await createJournal(db as any, {
      tanggal: '2026-01-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Modal awal (fixture test investasi)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 20_000_000, kredit: 0 },
        { accountId: 'acc-modal-investasi', debit: 0, kredit: 20_000_000 },
      ],
    });

    const { catatInvestasi } = await import('@/services/InvestasiService');
    const { catatImpairmentInvestasi, INDIKATOR_IMPAIRMENT_INVESTASI } = await import('@/services/InvestasiImpairmentService');
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Bermasalah',
      jumlah: 8_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await catatImpairmentInvestasi({
      investasiId: id,
      tanggal: '2026-06-01',
      indikasiTerpilih: [INDIKATOR_IMPAIRMENT_INVESTASI[0]],
      dasarPenilaian: 'Laporan keuangan unit usaha tujuan.',
      nilaiImpairment: 2_000_000,
      alasan: 'Kerugian berkelanjutan.',
      createdBy: 'user-1',
    });

    const calk = await generateCALK(db as any, '2026-01-01', '2026-12-31');
    const investasiSection = calk.sections.find((s) => s.sectionKey === 'investasi')!;
    expect(investasiSection.konten).toContain('Penurunan nilai investasi: Rp2.000.000');
    expect(investasiSection.konten).toContain('setelah penurunan nilai: Rp6.000.000');
  });
});

describe('getCalkDenganEditManual / simpanCalkManual / resetCalkKeOtomatis (Prioritas 12/N §12)', () => {
  test('sebelum ada edit manual: konten = kontenOtomatis, isManualEdit false', async () => {
    const db = await setupFixture();
    const calk = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    const info = calk.sections.find((s) => s.sectionKey === 'informasi_umum')!;
    expect(info.isManualEdit).toBe(false);
    expect(info.konten).toBe(info.kontenOtomatis);
  });

  test('simpanCalkManual: konten section berubah, isManualEdit true, TIDAK menimpa section lain', async () => {
    const db = await setupFixture();
    const calkAwal = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    expect(calkAwal.periodId).not.toBeNull();

    await simpanCalkManual(db as any, {
      periodId: calkAwal.periodId!,
      sectionKey: 'informasi_umum',
      konten: 'Catatan khusus yang ditulis pengurus koperasi secara manual.',
      updatedBy: 'user-1',
    });

    const calkSesudah = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    const info = calkSesudah.sections.find((s) => s.sectionKey === 'informasi_umum')!;
    expect(info.isManualEdit).toBe(true);
    expect(info.konten).toBe('Catatan khusus yang ditulis pengurus koperasi secara manual.');

    const kas = calkSesudah.sections.find((s) => s.sectionKey === 'kas')!;
    expect(kas.isManualEdit).toBe(false); // section lain tidak ikut berubah
  });

  test('auto-generate TIDAK PERNAH menimpa balik edit manual, walau data ledger berubah', async () => {
    const db = await setupFixture();
    const calkAwal = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');

    await simpanCalkManual(db as any, {
      periodId: calkAwal.periodId!,
      sectionKey: 'kas',
      konten: 'Catatan manual tentang kas yang sengaja berbeda dari angka ledger.',
      updatedBy: 'user-1',
    });

    // Tambah transaksi baru yang mengubah saldo kas di ledger.
    await createJournal(db as any, {
      tanggal: '2026-11-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Setoran modal tambahan',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 10000, kredit: 0 },
        { accountId: ACC.simpananPokok, debit: 0, kredit: 10000 },
      ],
    });

    const calkSesudah = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    const kas = calkSesudah.sections.find((s) => s.sectionKey === 'kas')!;
    // Konten TAMPILAN tetap versi manual (tidak berubah)...
    expect(kas.konten).toBe('Catatan manual tentang kas yang sengaja berbeda dari angka ledger.');
    // ...tapi kontenOtomatis (referensi) MEMANG ikut update sesuai ledger terbaru.
    expect(kas.kontenOtomatis).toContain('83.000');
  });

  test('resetCalkKeOtomatis: section kembali memakai draf otomatis terbaru', async () => {
    const db = await setupFixture();
    const calkAwal = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    await simpanCalkManual(db as any, {
      periodId: calkAwal.periodId!,
      sectionKey: 'informasi_umum',
      konten: 'Teks manual sementara.',
      updatedBy: 'user-1',
    });

    await resetCalkKeOtomatis(db as any, { periodId: calkAwal.periodId!, sectionKey: 'informasi_umum' });

    const calkSesudah = await getCalkDenganEditManual(db as any, '2026-01-01', '2026-12-31');
    const info = calkSesudah.sections.find((s) => s.sectionKey === 'informasi_umum')!;
    expect(info.isManualEdit).toBe(false);
    expect(info.konten).toContain('Koperasi Uji Coba');
  });

  test('periodId null kalau tanggal di luar seluruh accounting_period — tidak error, tapi edit manual tidak berlaku', async () => {
    const db = await setupFixture();
    const calk = await getCalkDenganEditManual(db as any, '2099-01-01', '2099-12-31');
    expect(calk.periodId).toBeNull();
    expect(calk.sections.every((s) => !s.isManualEdit)).toBe(true);
  });
});

describe('Laporan Komparatif (Phase 12) — murni membungkus getPosisiKeuangan/getLabaRugi yang sudah teruji', () => {
  test('getLabaRugiKomparatif: hasilUsaha per kuartal benar & selisihnya benar', async () => {
    const db = await setupFixture();
    // Q1 (Jan-Mar): belum ada pendapatan jasa/beban (dua-duanya di April) -> hasilUsaha 0.
    // Q2 (Apr-Jun): pendapatan 5000, beban 2000 -> hasilUsaha 3000.
    const komparatif = await getLabaRugiKomparatif(
      db as any,
      { mulai: '2026-04-01', selesai: '2026-06-30' },
      { mulai: '2026-01-01', selesai: '2026-03-31' }
    );

    expect(komparatif.sekarang.hasilUsaha).toBe(3000);
    expect(komparatif.pembanding.hasilUsaha).toBe(0);
    expect(komparatif.perubahanHasilUsaha).toBe(3000);
    expect(komparatif.perubahanTotalPendapatan).toBe(5000);
    expect(komparatif.perubahanTotalBeban).toBe(2000);
  });

  test('getPosisiKeuanganKomparatif: total aset & perubahannya benar antara dua tanggal', async () => {
    const db = await setupFixture();
    const komparatif = await getPosisiKeuanganKomparatif(db as any, '2026-12-31', '2026-02-28');

    // Independen: hasil komparatif harus identik dengan memanggil
    // getPosisiKeuangan langsung dua kali (murni pembungkus, tidak ada
    // logika baru yang bisa membuatnya berbeda).
    const langsungAkhir = await getPosisiKeuangan(db as any, '2026-12-31');
    const langsungFeb = await getPosisiKeuangan(db as any, '2026-02-28');

    expect(komparatif.sekarang.totalAset).toBe(langsungAkhir.totalAset);
    expect(komparatif.pembanding.totalAset).toBe(langsungFeb.totalAset);
    expect(komparatif.perubahanTotalAset).toBe(langsungAkhir.totalAset - langsungFeb.totalAset);
    expect(komparatif.perubahanTotalEkuitas).toBe(langsungAkhir.totalEkuitas - langsungFeb.totalEkuitas);
  });
});

// ============================================================
// Prioritas 13 (O) — Komparatif: Perubahan Ekuitas & Arus Kas
// (sebelumnya HANYA Posisi Keuangan & Laba Rugi yang punya versi
// komparatif) + validasi kesetaraan periode.
// ============================================================
describe('validasiKesetaraanPeriode (Prioritas 13/O)', () => {
  test('periode setara (selisih rentang hari kecil) -> tidak ada peringatan', () => {
    const hasil = validasiKesetaraanPeriode(
      { mulai: '2026-01-01', selesai: '2026-12-31' },
      { mulai: '2025-01-01', selesai: '2025-12-31' }
    );
    expect(hasil.setara).toBe(true);
    expect(hasil.peringatan).toBeNull();
  });

  test('2026 YTD (Jan-Agu) vs 2025 full year -> peringatan eksplisit, TIDAK memblokir', () => {
    const hasil = validasiKesetaraanPeriode(
      { mulai: '2026-01-01', selesai: '2026-08-21' },
      { mulai: '2025-01-01', selesai: '2025-12-31' }
    );
    expect(hasil.setara).toBe(false);
    expect(hasil.peringatan).toContain('berbeda jauh');
  });
});

describe('getPerubahanEkuitasKomparatif (Prioritas 13/O — BARU, sebelumnya tidak ada)', () => {
  test('murni membungkus getPerubahanEkuitas dua kali, hasilnya identik dengan panggilan langsung', async () => {
    const db = await setupFixture();
    const komparatif = await getPerubahanEkuitasKomparatif(
      db as any,
      { mulai: '2026-01-01', selesai: '2026-12-31' },
      { mulai: '2025-01-01', selesai: '2025-12-31' }
    );
    const langsungSekarang = await getPerubahanEkuitas(db as any, '2026-01-01', '2026-12-31');
    const langsungPembanding = await getPerubahanEkuitas(db as any, '2025-01-01', '2025-12-31');

    expect(komparatif.sekarang.totalSaldoAkhir).toBe(langsungSekarang.totalSaldoAkhir);
    expect(komparatif.pembanding.totalSaldoAkhir).toBe(langsungPembanding.totalSaldoAkhir);
    expect(komparatif.perubahanTotalSaldoAkhir).toBe(langsungSekarang.totalSaldoAkhir - langsungPembanding.totalSaldoAkhir);
    expect(komparatif.peringatanPeriode).toBeNull(); // dua-duanya full year, setara
  });
});

describe('getArusKasKomparatif (Prioritas 13/O — BARU, sebelumnya tidak ada)', () => {
  test('murni membungkus getArusKas dua kali, hasilnya identik dengan panggilan langsung', async () => {
    const db = await setupFixture();
    const komparatif = await getArusKasKomparatif(
      db as any,
      { mulai: '2026-04-01', selesai: '2026-06-30' },
      { mulai: '2026-01-01', selesai: '2026-03-31' }
    );
    const langsungSekarang = await getArusKas(db as any, '2026-04-01', '2026-06-30');
    const langsungPembanding = await getArusKas(db as any, '2026-01-01', '2026-03-31');

    expect(komparatif.sekarang.kasAkhirAktual).toBe(langsungSekarang.kasAkhirAktual);
    expect(komparatif.pembanding.kasAkhirAktual).toBe(langsungPembanding.kasAkhirAktual);
    expect(komparatif.perubahanKasAkhir).toBe(langsungSekarang.kasAkhirAktual - langsungPembanding.kasAkhirAktual);
  });
});

describe('getPosisiKeuangan — bug fix: akun kontra-aset (Akumulasi Penyusutan / Penyisihan Piutang) harus MENGURANGI total aset, bukan menambahnya', () => {
  test('Akumulasi Penyusutan Aset Tetap (KREDIT-normal, kategori ASET) mengurangi nilai buku aset, bukan ditambahkan ke Total Aset', async () => {
    const db = await createTestDb();
  dbAktif = db;
    const asetTetap = 'acc-aset-tetap';
    const akumulasiPenyusutan = 'acc-akumulasi-penyusutan';
    const modal = 'acc-modal';

    await seedAccount(db, asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
    await seedAccount(db, akumulasiPenyusutan, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
    await seedAccount(db, modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );

    // Perolehan aset 10.000.000 (Debit Aset Tetap, Kredit Modal).
    await createJournal(db as any, {
      tanggal: '2026-01-01',
      sumberTransaksi: 'ASET_TETAP',
      deskripsi: 'Perolehan aset tetap',
      createdBy: 'user-1',
      lines: [
        { accountId: asetTetap, debit: 10_000_000, kredit: 0 },
        { accountId: modal, debit: 0, kredit: 10_000_000 },
      ],
    });
    // Penyusutan berjalan 2.000.000 (Debit Beban — tidak disimulasikan,
    // langsung Kredit Akumulasi Penyusutan lewat jurnal manual setara).
    await createJournal(db as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'PENYUSUTAN_ASET',
      deskripsi: 'Penyusutan aset tetap Jan-Jun',
      createdBy: 'user-1',
      lines: [
        { accountId: modal, debit: 2_000_000, kredit: 0 }, // proxy beban (kategori tidak relevan utk test ini)
        { accountId: akumulasiPenyusutan, debit: 0, kredit: 2_000_000 },
      ],
    });

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');

    const asetTetapRow = posisi.aset.find((r) => r.kode === '1-1500');
    const akumulasiRow = posisi.aset.find((r) => r.kode === '1-1510');
    expect(asetTetapRow?.saldo).toBe(10_000_000);
    // INI BUG YANG DILAPORKAN: sebelum fix, baris ini bernilai POSITIF
    // 2.000.000 dan ikut DIJUMLAHKAN ke Total Aset (harusnya MENGURANGI).
    expect(akumulasiRow?.saldo).toBe(-2_000_000);

    // Total Aset = 10.000.000 (aset tetap) - 2.000.000 (akumulasi
    // penyusutan) = 8.000.000 (nilai buku neto), BUKAN 12.000.000.
    expect(posisi.totalAset).toBe(8_000_000);
    expect(posisi.isBalanced).toBe(true);
  });
});

// ============================================================
// Audit ulang (permintaan pengguna §8/§11): getPosisiKeuangan opsional
// menggabungkan baris Saldo Awal yang MASIH DRAFT (belum diposting).
// ============================================================
describe('getPosisiKeuangan — opsi sertakanSaldoAwalDraft (audit ulang §8/§11)', () => {
  async function setupDraftFixture(): Promise<{ db: TestDb; kas: string; piutang: string; utang: string; simpananPokok: string; pendapatan: string; beban: string }> {
    const db = await createTestDb();
  dbAktif = db;
    const kas = 'acc-kas';
    const piutang = 'acc-piutang';
    const utang = 'acc-utang';
    const simpananPokok = 'acc-simpanan-pokok';
    const pendapatan = 'acc-pendapatan';
    const beban = 'acc-beban';

    await seedAccount(db, kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount(db, piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
    await seedAccount(db, utang, '2-1000', 'Utang Bank', 'LIABILITAS', 'KREDIT');
    await seedAccount(db, simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
    await seedAccount(db, pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(db, beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');

    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );
    return { db, kas, piutang, utang, simpananPokok, pendapatan, beban };
  }

  async function seedDraft(db: TestDb, accountId: string, saldo: number) {
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,NULL,?,?,?)`,
      `draft-${accountId}`,
      accountId,
      '2026-01-01',
      saldo,
      'user-1',
      now,
      now
    );
  }

  test('default (opts kosong): draft TIDAK ikut ditampilkan sama sekali, termasukSaldoAwalDraft=false', async () => {
    const { db, kas, simpananPokok } = await setupDraftFixture();
    await seedDraft(db, kas, 5_000_000);
    await seedDraft(db, simpananPokok, 5_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    expect(posisi.aset.find((r) => r.kode === '1-1000')).toBeUndefined();
    expect(posisi.totalAset).toBe(0);
    expect(posisi.termasukSaldoAwalDraft).toBe(false);
  });

  test('sertakanSaldoAwalDraft=true: draft digabung ke Aset/Ekuitas, totalnya benar, termasukSaldoAwalDraft=true', async () => {
    const { db, kas, simpananPokok } = await setupDraftFixture();
    await seedDraft(db, kas, 5_000_000);
    await seedDraft(db, simpananPokok, 5_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    expect(posisi.termasukSaldoAwalDraft).toBe(true);
    expect(posisi.aset.find((r) => r.kode === '1-1000')?.saldo).toBe(5_000_000);
    expect(posisi.ekuitas.find((r) => r.kode === '3-1000')?.saldo).toBe(5_000_000);
    expect(posisi.totalAset).toBe(5_000_000);
    expect(posisi.totalEkuitas).toBe(5_000_000);
    expect(posisi.isBalanced).toBe(true);
  });

  test('draft digabung ke akun yang SUDAH punya saldo posted (ditambahkan, bukan menimpa)', async () => {
    const { db, kas, simpananPokok } = await setupDraftFixture();
    // Saldo posted sungguhan lewat jurnal biasa.
    await createJournal(db as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'SIMPANAN_POKOK',
      deskripsi: 'Setoran simpanan pokok anggota baru',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 2_000_000, kredit: 0 },
        { accountId: simpananPokok, debit: 0, kredit: 2_000_000 },
      ],
    });
    // Draft saldo awal TERPISAH untuk akun yang SAMA (kas, simpanan pokok).
    await seedDraft(db, kas, 1_000_000);
    await seedDraft(db, simpananPokok, 1_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    expect(posisi.aset.find((r) => r.kode === '1-1000')?.saldo).toBe(3_000_000); // 2jt posted + 1jt draft
    expect(posisi.ekuitas.find((r) => r.kode === '3-1000')?.saldo).toBe(3_000_000);
    expect(posisi.totalAset).toBe(3_000_000);
    expect(posisi.isBalanced).toBe(true);
  });

  test('draft TIDAK PERNAH memengaruhi labaBerjalan/Pendapatan/Beban walau digabung', async () => {
    const { db, kas, pendapatan, beban } = await setupDraftFixture();
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENERIMAAN_LAIN',
      deskripsi: 'Pendapatan jasa',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 1_000_000, kredit: 0 },
        { accountId: pendapatan, debit: 0, kredit: 1_000_000 },
      ],
    });
    await seedDraft(db, kas, 500_000);

    const tanpaOpsi = await getPosisiKeuangan(db as any, '2026-12-31');
    const denganOpsi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    // labaBerjalan (dari Pendapatan-Beban) HARUS sama persis, tidak
    // terpengaruh oleh draft — draft hanya boleh menyentuh akun neraca.
    expect(denganOpsi.labaBerjalan).toBe(tanpaOpsi.labaBerjalan);
    expect(denganOpsi.labaBerjalan).toBe(1_000_000);
  });

  test('draft yang TIDAK balance (Aset != Liabilitas+Ekuitas) tetap ditampilkan apa adanya — isBalanced=false, TIDAK disembunyikan/diratakan', async () => {
    const { db, kas } = await setupDraftFixture();
    // Hanya satu sisi draft diisi (Kas) tanpa lawan Liabilitas/Ekuitas — sengaja belum balance.
    await seedDraft(db, kas, 7_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    expect(posisi.termasukSaldoAwalDraft).toBe(true);
    expect(posisi.totalAset).toBe(7_000_000);
    expect(posisi.totalLiabilitas + posisi.totalEkuitas).toBe(0);
    expect(posisi.isBalanced).toBe(false);
    expect(posisi.selisih).toBe(7_000_000);
  });

  // Audit ulang (permintaan pengguna, request baru §1): "Saldo Awal
  // Neraca" -> "Saldo Akun (COA)" — SaldoAwalAkunService SEKARANG
  // mengizinkan draft untuk akun PENDAPATAN/BEBAN juga (bukan cuma
  // neraca). Posisi Keuangan TETAP TIDAK menampilkan baris Pendapatan/
  // Beban apa pun (struktural — laporan ini bukan tempatnya), draft
  // kategori itu harus DILEWATI, bukan dianggap error.
  test('draft berkategori PENDAPATAN/BEBAN (diizinkan sejak request baru §1) DILEWATI oleh Posisi Keuangan — tidak muncul di aset/liabilitas/ekuitas, tidak bikin crash', async () => {
    const { db, kas, simpananPokok, pendapatan, beban } = await setupDraftFixture();
    await seedDraft(db, kas, 5_000_000);
    await seedDraft(db, simpananPokok, 5_000_000);
    // Draft Pendapatan/Beban — HANYA valid sejak request baru §1, dan
    // HARUS diabaikan laporan ini (bukan bagian Posisi Keuangan).
    await seedDraft(db, pendapatan, 2_000_000);
    await seedDraft(db, beban, 1_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    expect(posisi.termasukSaldoAwalDraft).toBe(true);
    // Total tetap hanya dari draft neraca (5jt/5jt) — draft Pendapatan/
    // Beban TIDAK ikut menambah/mengurangi totalAset/totalEkuitas di sini.
    expect(posisi.totalAset).toBe(5_000_000);
    expect(posisi.totalEkuitas).toBe(5_000_000);
    expect(posisi.isBalanced).toBe(true);
    // Tidak ada baris kode akun Pendapatan/Beban yang nyasar ke aset/liabilitas/ekuitas.
    expect(posisi.aset.some((r) => r.kode === '4-1000')).toBe(false);
    expect(posisi.ekuitas.some((r) => r.kode === '5-1000')).toBe(false);
  });

  test('kalau HANYA ada draft PENDAPATAN/BEBAN (tanpa draft neraca sama sekali), termasukSaldoAwalDraft harus false — laporan ini memang tidak menampilkan apa pun dari draft tersebut', async () => {
    const { db, pendapatan, beban } = await setupDraftFixture();
    await seedDraft(db, pendapatan, 2_000_000);
    await seedDraft(db, beban, 1_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31', { sertakanSaldoAwalDraft: true });
    expect(posisi.termasukSaldoAwalDraft).toBe(false);
    expect(posisi.totalAset).toBe(0);
  });
});

// ============================================================
// Prioritas 1 (C) — label "SHU/Laba Tahun Berjalan" harus mengikuti
// status shu_konfigurasi, bukan selalu "(belum dibagikan)".
// ============================================================
// ============================================================
// Audit ulang (permintaan pengguna, request baru "Perbaikan SHU —
// pemisahan basis akrual/kas/RAT"): getInformasiShuRAT() — SHU basis
// KAS/realisasi, DIHITUNG dari jurnal yang SAMA (bukan transaksi baru).
// ============================================================
describe('getInformasiShuRAT (audit ulang §1/§2/§3/§10/§14)', () => {
  test('Pendapatan/Beban yang DIBAYAR TUNAI (kas langsung dalam satu jurnal) dihitung sebagai realisasi kas', async () => {
    const db = await setupFixture();
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa - tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 100_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 100_000 },
      ],
    });
    await createJournal(db as any, {
      tanggal: '2026-04-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Beban operasional - tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 30_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 30_000 },
      ],
    });

    const hasil = await getInformasiShuRAT(db as any, '2026-01-01', '2026-12-31');
    // Bug fix (test): test ini menumpang `setupFixture()` yang SUDAH
    // mencatat pendapatan jasa 5.000 (tunai) & beban operasional 2.000
    // (tunai) sebagai baseline (lihat setupFixture() di atas) — net
    // +3.000 yang sebelumnya tidak diperhitungkan di angka yang
    // diharapkan di sini. Nilai below sudah termasuk kontribusi
    // baseline itu (100.000+5.000=105.000 pendapatan kas,
    // 30.000+2.000=32.000 beban kas, dst).
    expect(hasil.shuLaporanKeuanganAkrual).toBe(73_000);
    expect(hasil.pendapatanRealisasiKas).toBe(105_000);
    expect(hasil.bebanRealisasiKas).toBe(32_000);
    expect(hasil.shuInformasiRat).toBe(73_000);
    expect(hasil.selisihAkrualVsKas).toBe(0); // sama-sama tunai penuh, tidak ada selisih
  });

  test('Pendapatan yang BELUM diterima kas (akrual murni, tanpa baris kas di jurnal yang sama) TIDAK dihitung sebagai realisasi kas — selisih akrual vs kas MUNCUL, BUKAN error', async () => {
    const db = await setupFixture();
    await seedAccount(db, 'acc-piutang-lain', '1-1900', 'Piutang Pendapatan Lain', 'ASET', 'DEBIT');

    // Pendapatan TUNAI 60.000.
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa - tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 60_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 60_000 },
      ],
    });
    // Pendapatan AKRUAL 40.000 — TANPA baris kas/bank sama sekali.
    await createJournal(db as any, {
      tanggal: '2026-04-01',
      sumberTransaksi: 'PENGAKUAN_PENDAPATAN_DIMUKA',
      deskripsi: 'Pendapatan jasa - masih piutang',
      createdBy: 'user-1',
      lines: [
        { accountId: 'acc-piutang-lain', debit: 40_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 40_000 },
      ],
    });

    const hasil = await getInformasiShuRAT(db as any, '2026-01-01', '2026-12-31');
    // Bug fix (test): sama seperti test di atas — `setupFixture()`
    // sudah mencatat baseline pendapatan jasa 5.000 (tunai) & beban
    // operasional 2.000 (tunai), belum diperhitungkan di angka lama.
    expect(hasil.shuLaporanKeuanganAkrual).toBe(103_000); // baseline 3.000 (5rb-2rb) + 60rb + 40rb
    expect(hasil.pendapatanRealisasiKas).toBe(65_000); // baseline 5rb + 60rb tunai
    expect(hasil.shuInformasiRat).toBe(63_000); // 65rb kas pendapatan - 2rb kas beban baseline
    expect(hasil.selisihAkrualVsKas).toBe(40_000); // selisih MUNCUL, bukan error (§2) — baseline balance sama di akrual & kas, tidak menambah selisih
  });

  test('getInformasiShuRAT TIDAK PERNAH mengubah/mempengaruhi getLabaRugi (akrual) — dua fungsi dipanggil berurutan menghasilkan angka akrual yang IDENTIK', async () => {
    const db = await setupFixture();
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa - tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 50_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50_000 },
      ],
    });

    const sebelumLabaRugi = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    await getInformasiShuRAT(db as any, '2026-01-01', '2026-12-31'); // dipanggil di antara, TIDAK BOLEH mengubah apa pun
    const sesudahLabaRugi = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');

    expect(sebelumLabaRugi.hasilUsaha).toBe(53_000); // baseline 3.000 (5rb-2rb) + 50rb pendapatan baru
    expect(sesudahLabaRugi.hasilUsaha).toBe(53_000);
    expect(sebelumLabaRugi.hasilUsaha).toBe(sesudahLabaRugi.hasilUsaha);
  });

  test('tanpa akun kas/bank apa pun terdaftar: tidak crash, semua nilai kas 0, akrual tetap dihitung benar', async () => {
    const db = await createTestDb();
  dbAktif = db;
    // Sengaja TIDAK memanggil setupFixture (yang men-seed mapping KAS_UMUM)
    // — cuma akun Pendapatan/Beban murni tanpa akun kas/bank sama sekali.
    await seedAccount(db, 'acc-pendapatan-min', '4-1000', 'Pendapatan', 'PENDAPATAN', 'KREDIT');
    await seedAccount(db, 'acc-beban-min', '5-1000', 'Beban', 'BEBAN', 'DEBIT');
    await seedAccount(db, 'acc-piutang-min', '1-1000', 'Piutang', 'ASET', 'DEBIT');
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENERIMAAN_LAIN',
      deskripsi: 'Pendapatan akrual murni',
      createdBy: 'user-1',
      lines: [
        { accountId: 'acc-piutang-min', debit: 20_000, kredit: 0 },
        { accountId: 'acc-pendapatan-min', debit: 0, kredit: 20_000 },
      ],
    });

    const hasil = await getInformasiShuRAT(db as any, '2026-01-01', '2026-12-31');
    expect(hasil.shuLaporanKeuanganAkrual).toBe(20_000);
    expect(hasil.pendapatanRealisasiKas).toBe(0);
    expect(hasil.bebanRealisasiKas).toBe(0);
    expect(hasil.shuInformasiRat).toBe(0);
    expect(hasil.selisihAkrualVsKas).toBe(20_000);
  });

  test('getInformasiShuRAT TIDAK membuat jurnal/transaksi baru apa pun (§3) — jumlah baris journal SEBELUM & SESUDAH pemanggilan identik', async () => {
    const db = await setupFixture();
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa - tunai',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 50_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 50_000 },
      ],
    });

    const sebelum = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    await getInformasiShuRAT(db as any, '2026-01-01', '2026-12-31');
    const sesudah = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(sesudah?.cnt).toBe(sebelum?.cnt);
  });
});

describe('getPosisiKeuangan — status SHU menentukan label & nilai labaBerjalan (Prioritas 1)', () => {
  async function setupShuFixture(): Promise<{ db: TestDb; kas: string; simpananPokok: string; pendapatan: string }> {
    const db = await createTestDb();
  dbAktif = db;
    const kas = 'acc-kas';
    const simpananPokok = 'acc-simpanan-pokok';
    const pendapatan = 'acc-pendapatan';
    const cadangan = 'acc-cadangan';
    const danaLainnya = 'acc-dana-lainnya';
    const shuBerjalan = 'acc-shu-berjalan';
    const simpananSukarela = 'acc-simpanan-sukarela';

    await seedAccount(db, kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount(db, simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
    await seedAccount(db, pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(db, cadangan, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
    await seedAccount(db, danaLainnya, '3-3000', 'Ekuitas Lainnya', 'EKUITAS', 'KREDIT');
    await seedAccount(db, shuBerjalan, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
    await seedAccount(db, simpananSukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');

    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2025',
      2025,
      '2025-01-01',
      '2025-12-31'
    );
    // Bug fix (test): periode 2026 SEBELUMNYA tidak pernah di-seed di
    // sini, padahal test "SHU sudah DIBAGIKAN" di bawah mengevaluasi
    // getPosisiKeuangan per tanggal 2026-03-15 (tahun berikutnya, tempat
    // RAT biasanya terjadi). Tanpa accounting_period yang mencakup
    // 2026-03-15, `getPeriodBounds()` mengembalikan null, sehingga
    // labaBerjalanMentah tidak pernah dihitung dari getLabaRugi (tetap
    // 0) walau saldo akun klering "SHU Tahun Berjalan" (shuBerjalanSaldo)
    // tetap dihitung dari trial balance — keduanya jadi tidak sinkron
    // dan labaBerjalan hasil akhir salah (bukan bug di
    // FinancialReports.ts, murni fixture yang kurang lengkap).
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );

    // Modal awal + SHU tahun 2025 sebesar 20.000.000.
    await createJournal(db as any, {
      tanggal: '2025-01-05',
      sumberTransaksi: 'SIMPANAN_POKOK',
      deskripsi: 'Setoran simpanan pokok anggota',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 5_000_000, kredit: 0 },
        { accountId: simpananPokok, debit: 0, kredit: 5_000_000 },
      ],
    });
    await createJournal(db as any, {
      tanggal: '2025-06-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 20_000_000, kredit: 0 },
        { accountId: pendapatan, debit: 0, kredit: 20_000_000 },
      ],
    });

    return { db, kas, simpananPokok, pendapatan };
  }

  test('SHU belum dihitung sama sekali: label "belum dihitung, belum dibagikan"', async () => {
    const { db } = await setupShuFixture();
    const posisi = await getPosisiKeuangan(db as any, '2025-12-31');

    expect(posisi.labaBerjalan).toBe(20_000_000);
    expect(posisi.shuStatus).toBe('BELUM_DIHITUNG');
    expect(posisi.labaBerjalanLabel).toContain('belum dihitung');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });

  test('SHU sudah DIHITUNG tapi belum dibagikan: nilai tetap tampil, label "menunggu pembagian"', async () => {
    const { db } = await setupShuFixture();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2025',2025,20,30,30,5,5,5,5,0,0,20000000,'DIHITUNG',?,?)`,
      now,
      now
    );

    const posisi = await getPosisiKeuangan(db as any, '2025-12-31');

    expect(posisi.labaBerjalan).toBe(20_000_000); // belum ada jurnal distribusi, jadi belum berubah
    expect(posisi.shuStatus).toBe('DIHITUNG');
    expect(posisi.labaBerjalanLabel).toContain('menunggu pembagian');
    expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);
  });

  test('SHU sudah DIBAGIKAN: labaBerjalan tidak lagi double-count, label bukan lagi "belum dibagikan"', async () => {
    const { db, kas } = await setupShuFixture();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2025',2025,20,30,30,5,5,5,5,0,0,20000000,'DIBAGIKAN',?,?)`,
      now,
      now
    );

    // Jurnal distribusi SHU (persis pola bagikanSHU() di ShuService,
    // ditulis manual di sini supaya test murni fokus pada laporan,
    // tidak ikut menguji gate RAT/permission ShuService yang sudah
    // dites terpisah): DEBIT SHU Tahun Berjalan, KREDIT Cadangan
    // 4.000.000 + Ekuitas Lainnya 8.000.000 + Simpanan Sukarela
    // (liabilitas) 8.000.000 = total 20.000.000.
    await createJournal(db as any, {
      tanggal: '2026-03-15', // RAT biasanya tahun berikutnya
      sumberTransaksi: 'SHU_DISTRIBUSI',
      deskripsi: 'Distribusi SHU tahun buku 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: 'acc-shu-berjalan', debit: 20_000_000, kredit: 0 },
        { accountId: 'acc-cadangan', debit: 0, kredit: 4_000_000 },
        { accountId: 'acc-dana-lainnya', debit: 0, kredit: 8_000_000 },
        { accountId: 'acc-simpanan-sukarela', debit: 0, kredit: 8_000_000 },
      ],
    });

    // Posisi Keuangan per 31-12-2025 (SEBELUM distribusi terjadi secara
    // tanggal — snapshot historis) tetap menunjukkan SHU sebagai milik
    // periode 2025 apa adanya; yang penting adalah statusnya sudah
    // terbaca DIBAGIKAN dari shu_konfigurasi, bukan tanggal jurnalnya.
    const posisiAkhir2025 = await getPosisiKeuangan(db as any, '2025-12-31');
    expect(posisiAkhir2025.shuStatus).toBe('DIBAGIKAN');
    expect(posisiAkhir2025.labaBerjalanLabel).not.toContain('belum dibagikan');
    expect(posisiAkhir2025.isBalanced).toBe(true);

    // Posisi Keuangan per tanggal SETELAH jurnal distribusi diposting:
    // labaBerjalan efektif harus 0 (sudah dialokasikan ke Cadangan/
    // Ekuitas Lainnya/Simpanan Sukarela via jurnal), BUKAN 20.000.000
    // lagi (yang berarti double-count kalau tidak diperbaiki).
    const posisiSetelahDistribusi = await getPosisiKeuangan(db as any, '2026-03-15');
    expect(posisiSetelahDistribusi.labaBerjalan).toBe(0);
    expect(posisiSetelahDistribusi.labaBerjalanLabel).toContain('sudah dibagikan');
    expect(posisiSetelahDistribusi.isBalanced).toBe(true);
    expect(posisiSetelahDistribusi.selisih).toBe(0);

    // Total Aset tidak berubah (jurnal distribusi murni reklasifikasi
    // ekuitas/liabilitas, tidak menyentuh kas) — hanya komposisinya.
    expect(posisiSetelahDistribusi.totalAset).toBe(posisiAkhir2025.totalAset);
    // Simpanan Sukarela (liabilitas) sekarang muncul.
    const simpananSukarelaRow = posisiSetelahDistribusi.liabilitas.find((r) => r.kode === '2-1200');
    expect(simpananSukarelaRow?.saldo).toBe(8_000_000);
    // Akun kliring SHU Tahun Berjalan (3-4000) TIDAK muncul sebagai
    // baris ekuitas biasa (akan membingungkan kalau ditampilkan).
    expect(posisiSetelahDistribusi.ekuitas.find((r) => r.kode === '3-4000')).toBeUndefined();

    // Tahun buku 2026 sendiri: kalau ada transaksi pendapatan/beban
    // baru di 2026, itu HARUS terhitung independen, TIDAK dipaksa 0
    // hanya karena SHU 2025 sudah dibagikan (larangan eksplisit di
    // instruksi perbaikan).
    // FIXTURE FIX: accounting_period 2026 SUDAH diseed di setup test ini
    // (lihat komentar "Bug fix (test)" di atas). INSERT kedua di sini
    // menabrak UNIQUE accounting_period.id — dulu tidak pernah terlihat
    // karena test gagal lebih dulu di assertion sebelumnya.
    await createJournal(db as any, {
      tanggal: '2026-04-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa 2026',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 7_000_000, kredit: 0 },
        { accountId: 'acc-pendapatan', debit: 0, kredit: 7_000_000 },
      ],
    });
    const posisi2026 = await getPosisiKeuangan(db as any, '2026-06-30');
    expect(posisi2026.shuStatus).toBe('BELUM_DIHITUNG'); // belum ada shu_konfigurasi utk 2026
    expect(posisi2026.labaBerjalan).toBe(7_000_000); // laba 2026 murni, TIDAK dipaksa 0
    expect(posisi2026.isBalanced).toBe(true);
  });
});

// ============================================================
// Prioritas 2 (D) — Neraca harus balance & akar selisih harus dapat
// ditelusuri, bukan disembunyikan.
// ============================================================
describe('auditBalancePosisiKeuangan — menelusuri akar selisih, bukan menyembunyikannya (Prioritas 2/D)', () => {
  test('Posisi balance -> tidak ada akun/jurnal penyebab dilaporkan', async () => {
    const db = await setupFixture();
    const audit = await auditBalancePosisiKeuangan(db as any, '2026-12-31');

    expect(audit.isBalanced).toBe(true);
    expect(audit.selisih).toBe(0);
    expect(audit.expected).toBe(audit.totalLiabilitas + audit.totalEkuitas);
    expect(audit.akunPenyebab).toHaveLength(0);
    expect(audit.journalPenyebab).toHaveLength(0);
  });

  test('BUG FIX: akun NONAKTIF dengan saldo historis tidak lagi hilang dari Neraca Saldo/Posisi Keuangan', async () => {
    const db = await setupFixture();
    // Nonaktifkan akun Piutang SETELAH ada transaksi historis di dalamnya
    // (skenario nyata: user menonaktifkan akun lama yang tidak dipakai
    // lagi, tapi histori/saldonya harus tetap masuk laporan).
    await db.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.piutang);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    // SEBELUM fix: baris Piutang (80000) akan hilang dari posisi.aset
    // dan Total Aset turun jadi 73000 sementara Ekuitas tetap 153000
    // -> selisih 80000 yang membingungkan karena akun penyebabnya
    // sendiri sudah tidak tampak di UI Chart of Accounts aktif.
    const piutangRow = posisi.aset.find((r) => r.kode === '1-1200');
    expect(piutangRow?.saldo).toBe(80000);
    expect(posisi.totalAset).toBe(153000);
    expect(posisi.isBalanced).toBe(true);
    expect(posisi.selisih).toBe(0);

    const audit = await auditBalancePosisiKeuangan(db as any, '2026-12-31');
    expect(audit.isBalanced).toBe(true);
  });

  test('Mendeteksi jurnal tidak balance yang masuk lewat luar AccountingEngine (bypass)', async () => {
    const db = await setupFixture();
    await db.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j-broken','JRN-BROKEN','2026-05-01','period-2026','MANUAL','Jurnal rusak untuk uji','POSTED','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-broken-1','j-broken',?,10000,0,0)`,
      ACC.kas
    );

    const audit = await auditBalancePosisiKeuangan(db as any, '2026-12-31');
    expect(audit.isBalanced).toBe(false);
    expect(audit.journalPenyebab.some((j) => j.journalId === 'j-broken')).toBe(true);
  });
});

// ============================================================
// Prioritas 4 (F) — Perubahan Ekuitas harus selalu sama dengan Posisi
// Keuangan, TERMASUK untuk tahun buku ke-2 dst. (skenario yang
// pertama kali membongkar bug "akun SHU Tahun Berjalan kumulatif,
// bukan per-tahun" — lihat komentar panjang di getPerubahanEkuitas).
// ============================================================
describe('getPerubahanEkuitas — total akhir HARUS selalu sama dengan getPosisiKeuangan (Prioritas 4/F)', () => {
  async function setupDuaTahunFixture(): Promise<TestDb> {
    const db = await createTestDb();
  dbAktif = db;
    const kas = 'acc-kas';
    const simpananPokok = 'acc-simpanan-pokok';
    const pendapatan = 'acc-pendapatan';
    const cadangan = 'acc-cadangan';
    const danaLainnya = 'acc-dana-lainnya';
    const shuBerjalan = 'acc-shu-berjalan';
    const simpananSukarela = 'acc-simpanan-sukarela';

    await seedAccount(db, kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount(db, simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
    await seedAccount(db, pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');
    await seedAccount(db, cadangan, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
    await seedAccount(db, danaLainnya, '3-3000', 'Ekuitas Lainnya', 'EKUITAS', 'KREDIT');
    await seedAccount(db, shuBerjalan, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
    await seedAccount(db, simpananSukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');

    for (const [id, tahun] of [['period-2025', 2025], ['period-2026', 2026], ['period-2027', 2027]] as const) {
      await db.runAsync(
        `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
        id,
        tahun,
        `${tahun}-01-01`,
        `${tahun}-12-31`
      );
    }

    await createJournal(db as any, {
      tanggal: '2025-01-05',
      sumberTransaksi: 'SIMPANAN_POKOK',
      deskripsi: 'Modal awal',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 5_000_000, kredit: 0 },
        { accountId: simpananPokok, debit: 0, kredit: 5_000_000 },
      ],
    });

    // Tahun buku 2025: laba 20.000.000, dihitung & dibagikan (jurnal
    // distribusi DITANGGALKAN 2026, seperti kondisi nyata RAT tahun
    // berikutnya) — Cadangan 4.000.000, Ekuitas Lainnya 8.000.000,
    // Simpanan Sukarela (liabilitas) 8.000.000.
    await createJournal(db as any, {
      tanggal: '2025-06-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 20_000_000, kredit: 0 },
        { accountId: pendapatan, debit: 0, kredit: 20_000_000 },
      ],
    });
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2025',2025,20,30,30,5,5,5,5,0,0,20000000,'DIBAGIKAN',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await createJournal(db as any, {
      tanggal: '2026-03-15',
      sumberTransaksi: 'SHU_DISTRIBUSI',
      deskripsi: 'Distribusi SHU tahun buku 2025',
      createdBy: 'user-1',
      lines: [
        { accountId: shuBerjalan, debit: 20_000_000, kredit: 0 },
        { accountId: cadangan, debit: 0, kredit: 4_000_000 },
        { accountId: danaLainnya, debit: 0, kredit: 8_000_000 },
        { accountId: simpananSukarela, debit: 0, kredit: 8_000_000 },
      ],
    });

    // Tahun buku 2026: laba 15.000.000, dihitung & dibagikan (jurnal
    // distribusi ditanggalkan 2027) — Cadangan 3.000.000, Ekuitas
    // Lainnya 6.000.000, Simpanan Sukarela 6.000.000.
    await createJournal(db as any, {
      tanggal: '2026-06-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa 2026',
      createdBy: 'user-1',
      lines: [
        { accountId: kas, debit: 15_000_000, kredit: 0 },
        { accountId: pendapatan, debit: 0, kredit: 15_000_000 },
      ],
    });
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
         total_shu, status, created_at, updated_at)
       VALUES ('shu-2026',2026,20,30,30,5,5,5,5,0,0,15000000,'DIBAGIKAN',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await createJournal(db as any, {
      tanggal: '2027-04-01',
      sumberTransaksi: 'SHU_DISTRIBUSI',
      deskripsi: 'Distribusi SHU tahun buku 2026',
      createdBy: 'user-1',
      lines: [
        { accountId: shuBerjalan, debit: 15_000_000, kredit: 0 },
        { accountId: cadangan, debit: 0, kredit: 3_000_000 },
        { accountId: danaLainnya, debit: 0, kredit: 6_000_000 },
        { accountId: simpananSukarela, debit: 0, kredit: 6_000_000 },
      ],
    });

    return db;
  }

  test('Tahun buku ke-1 (2025): total akhir Perubahan Ekuitas = total Posisi Keuangan', async () => {
    const db = await setupDuaTahunFixture();
    const posisi = await getPosisiKeuangan(db as any, '2025-12-31');
    const ekuitas = await getPerubahanEkuitas(db as any, '2025-01-01', '2025-12-31');

    expect(ekuitas.totalSaldoAkhir).toBe(posisi.totalEkuitas);
    // Baris kliring 3-4000 tidak boleh muncul sebagai baris biasa.
    expect(ekuitas.rows.find((r) => r.kode === '3-4000')).toBeUndefined();
  });

  test('BUG YANG DITEMUKAN & DIPERBAIKI: tahun buku ke-2 (2026, setelah SHU 2025 dibagikan) — total akhir Perubahan Ekuitas TETAP sama dengan Posisi Keuangan, bukan selisih 20jt', async () => {
    const db = await setupDuaTahunFixture();
    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    const ekuitas = await getPerubahanEkuitas(db as any, '2026-01-01', '2026-12-31');

    // Percobaan fix pertama (memakai delta 3-4000 dalam window laporan
    // saja) akan gagal di sini karena tidak memperhitungkan distribusi
    // 2025 yang tanggalnya JATUH SEBELUM window 2026 dimulai.
    expect(ekuitas.totalSaldoAkhir).toBe(posisi.totalEkuitas);
  });

  test('BUG YANG DITEMUKAN & DIPERBAIKI: tahun buku ke-3 (2027, tepat setelah SHU 2026 dibagikan pada 2027-04-01) — tetap rekonsiliasi', async () => {
    const db = await setupDuaTahunFixture();
    const posisi = await getPosisiKeuangan(db as any, '2027-04-01');
    const ekuitas = await getPerubahanEkuitas(db as any, '2027-01-01', '2027-04-01');

    expect(ekuitas.totalSaldoAkhir).toBe(posisi.totalEkuitas);
    expect(posisi.isBalanced).toBe(true);
  });

  test('Label mengikuti status SHU tahun berjalan, sama seperti Posisi Keuangan', async () => {
    const db = await setupDuaTahunFixture();
    const ekuitas = await getPerubahanEkuitas(db as any, '2026-01-01', '2026-12-31');
    expect(ekuitas.hasilUsahaPeriodeLabel).not.toContain('belum dibagikan');
  });
});

// ============================================================
// Audit ulang (permintaan pengguna — "BUG SALDO AWAL DRAFT →
// PERMANEN + KAS NEGATIF PADA POSISI KEUANGAN"): BUG NYATA ditemukan
// & diperbaiki di `getTrialBalance()` (src/accounting/Ledger.ts) —
// `Math.max(saldo, 0)` membuat KEDUA kolom debit/kredit jadi 0 untuk
// akun ber-saldo NEGATIF (bukan cuma "ditampilkan 0", tapi BENAR-BENAR
// hilang dari total Neraca Saldo, lalu ikut hilang di Posisi
// Keuangan). Root cause SEBENARNYA bukan soal "draft vs permanen"
// (arsitektur saat ini sudah membuat setiap baris langsung aktif
// seketika, tidak ada lagi draft yang beda dari ledger — lihat
// `tambahSaldoAwalAkun()` di SaldoAwalAkunService.ts), melainkan bug
// signed-value ini, yang akan muncul di SEMUA akun ber-saldo abnormal
// (termasuk Kas yang ditarik melebihi saldo tercatatnya lewat
// transaksi normal, bukan cuma dari input saldo awal).
// ============================================================
describe('getTrialBalance & getPosisiKeuangan — saldo NEGATIF harus tetap tampil negatif, TIDAK BOLEH menjadi Rp0 (bug fix)', () => {
  test('Kas ber-saldo NEGATIF (ditarik melebihi saldo tercatat): getTrialBalance TIDAK menghilangkan nilainya — sebelumnya Math.max(saldo,0) membuat kedua kolom debit & kredit jadi 0', async () => {
    const db = await setupFixture();
    // Bug fix (test): komentar "Kas mulai dari 0" SALAH — `setupFixture()`
    // sudah mencatat baseline transaksi yang membuat Kas = 73.000
    // (100.000+50.000-80.000+5.000-2.000, lihat test Trial Balance
    // paling atas file ini). Nilai akhir di bawah sudah memperhitungkan
    // baseline itu (73.000 - 5.000.000 = -4.927.000), BUKAN dari 0.
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Penarikan kas melebihi saldo tercatat',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 5_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 5_000_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    const kasRow = trial.rows.find((r) => r.accountId === ACC.kas);
    expect(kasRow).toBeDefined(); // TIDAK boleh hilang dari daftar sama sekali
    // Kas (normal DEBIT) ber-saldo negatif HARUS masuk kolom debit
    // sebagai NEGATIF (bukan 0 di kedua kolom seperti bug lama).
    expect(kasRow!.debit).toBe(-4_927_000);
    expect(kasRow!.kredit).toBe(0);

    // Invarian akuntansi TETAP terjaga walau ada saldo abnormal.
    expect(trial.totalDebit).toBe(trial.totalKredit);
    expect(trial.isBalanced).toBe(true);
  });

  test('Kas ber-saldo NEGATIF: getPosisiKeuangan menampilkan Kas = -Rp5.000.000, BUKAN Rp0 dan BUKAN Rp5.000.000 (tanda tidak boleh hilang/terbalik)', async () => {
    const db = await setupFixture();
    // Bug fix (test): sama seperti test di atas — baseline setupFixture()
    // membuat Kas mulai dari 73.000 (bukan 0), jadi hasil akhir & total
    // aset di bawah disesuaikan (73.000 - 5.000.000 = -4.927.000; Total
    // Aset = Kas -4.927.000 + Piutang 80.000 baseline = -4.847.000).
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Penarikan kas melebihi saldo tercatat',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 5_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 5_000_000 },
      ],
    });

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    const kasRow = posisi.aset.find((r) => r.kode === '1-1000');
    expect(kasRow).toBeDefined();
    expect(kasRow!.saldo).toBe(-4_927_000);

    // Total Aset ikut mencerminkan Kas negatif (bukan diperlakukan sebagai 0).
    expect(posisi.totalAset).toBe(-4_847_000);
    // Posisi Keuangan TETAP balance (tidak ada balancing palsu) — sisi
    // Ekuitas (Simpanan Pokok naik 5jt) mengimbangi turunnya Kas.
    expect(posisi.isBalanced).toBe(true);
    expect(posisi.selisih).toBe(0);
  });

  test('Akun KREDIT-normal ber-saldo NEGATIF (mis. Simpanan Pokok "kelebihan tarik") juga TIDAK hilang — bug yang sama berlaku simetris untuk sisi kredit', async () => {
    const db = await setupFixture();
    // Bug fix (test): baseline setupFixture() sudah membuat Simpanan
    // Pokok = 100.000 (kredit) dari setoran awal — nilai akhir di
    // bawah memperhitungkan itu (100.000 - 3.000.000 = -2.900.000).
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Simpanan Pokok ditarik melebihi saldo (kondisi abnormal, harus tetap terlihat)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 3_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 3_000_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    const simpananRow = trial.rows.find((r) => r.accountId === ACC.simpananPokok);
    expect(simpananRow).toBeDefined();
    // Simpanan Pokok (normal KREDIT) ber-saldo negatif HARUS masuk
    // kolom kredit sebagai NEGATIF.
    expect(simpananRow!.kredit).toBe(-2_900_000);
    expect(simpananRow!.debit).toBe(0);
    expect(trial.totalDebit).toBe(trial.totalKredit);
  });

  test('Saldo TEPAT Rp0 tetap tidak muncul di Trial Balance (akun tanpa mutasi bersih) — dibedakan dari saldo negatif, bukan dihilangkan karena bug', async () => {
    const db = await setupFixture();
    // Bug fix (test): sebelumnya dites pakai ACC.kas dengan asumsi
    // "masuk 5jt lalu keluar 5jt lagi -> bersih 0" — tapi Kas SUDAH
    // punya baseline 73.000 dari setupFixture(), jadi saldo bersihnya
    // TIDAK PERNAH benar-benar 0 (tetap 73.000), membuat premis test
    // ini (akun bersaldo netto 0 disembunyikan dari trial balance)
    // tidak pernah teruji dengan benar. Fix: pakai akun BARU yang
    // benar-benar bersih dari baseline apa pun, supaya net-nya
    // genuinely 0.
    await seedAccount(db, 'acc-uji-nol', '1-1990', 'Akun Uji Saldo Nol', 'ASET', 'DEBIT');
    // Masuk 5jt lalu keluar 5jt lagi -> bersih 0.
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENERIMAAN_LAIN',
      deskripsi: 'Masuk',
      createdBy: 'user-1',
      lines: [
        { accountId: 'acc-uji-nol', debit: 5_000_000, kredit: 0 },
        { accountId: ACC.simpananPokok, debit: 0, kredit: 5_000_000 },
      ],
    });
    await createJournal(db as any, {
      tanggal: '2026-04-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Keluar lagi, bersih 0',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 5_000_000, kredit: 0 },
        { accountId: 'acc-uji-nol', debit: 0, kredit: 5_000_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    expect(trial.rows.find((r) => r.accountId === 'acc-uji-nol')).toBeUndefined(); // saldo bersih 0 -> tidak ditampilkan (perilaku lama, TIDAK berubah)
  });
});

// ============================================================
// Audit ulang (permintaan pengguna — "AUDIT LANJUTAN, jangan
// mengklaim seluruh project bersih jika hanya beberapa file yang
// diperiksa"): memperluas cakupan kategori akun yang diuji secara
// eksplisit sesuai §4 permintaan — Bank, Piutang, Liabilitas,
// Pendapatan (via reversal), Beban (via reversal). Semuanya memakai
// mekanisme SATU fungsi yang sama (`getTrialBalance` di Ledger.ts,
// sudah diperbaiki) — test ini adalah defense-in-depth eksplisit per
// kategori, BUKAN indikasi ada bug terpisah per kategori.
// ============================================================
describe('Audit lanjutan — saldo negatif per kategori akun (Bank/Piutang/Liabilitas/Pendapatan/Beban)', () => {
  test('Bank ber-saldo NEGATIF: getTrialBalance & getPosisiKeuangan TIDAK menghilangkannya', async () => {
    const db = await setupFixture();
    await seedAccount(db, 'acc-bank', '1-1100', 'Bank', 'ASET', 'DEBIT');
    await db.runAsync(
      `INSERT INTO bank_account (id, account_id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, aktif, created_at)
       VALUES ('bank-1','acc-bank','Bank Uji','1234567890','Koperasi Uji Coba',0,1,?)`,
      new Date().toISOString()
    );
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Transfer keluar melebihi saldo Bank tercatat',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 2_000_000, kredit: 0 },
        { accountId: 'acc-bank', debit: 0, kredit: 2_000_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    const bankRow = trial.rows.find((r) => r.accountId === 'acc-bank');
    expect(bankRow?.debit).toBe(-2_000_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    const bankPosisi = posisi.aset.find((r) => r.kode === '1-1100');
    expect(bankPosisi?.saldo).toBe(-2_000_000);
  });

  test('Piutang ber-saldo NEGATIF (mis. kelebihan bayar anggota): TIDAK dihilangkan', async () => {
    const db = await setupFixture();
    // Bug fix (test): baseline setupFixture() sudah mencatat Piutang =
    // 80.000 (debit, dari pencairan pinjaman awal) — nilai akhir di
    // bawah memperhitungkan itu (80.000 - 1.500.000 = -1.420.000).
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Koreksi piutang jadi negatif (kelebihan bayar)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.simpananPokok, debit: 1_500_000, kredit: 0 },
        { accountId: ACC.piutang, debit: 0, kredit: 1_500_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    const piutangRow = trial.rows.find((r) => r.accountId === ACC.piutang);
    expect(piutangRow?.debit).toBe(-1_420_000);

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    expect(posisi.aset.find((r) => r.kode === '1-1200')?.saldo).toBe(-1_420_000);
  });

  test('Liabilitas ber-saldo NEGATIF (mis. Utang terbayar melebihi pokok tercatat): TIDAK dihilangkan', async () => {
    const db = await setupFixture();
    await seedAccount(db, 'acc-utang', '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
    await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Bayar utang melebihi saldo tercatat',
      createdBy: 'user-1',
      lines: [
        { accountId: 'acc-utang', debit: 4_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 4_000_000 },
      ],
    });

    const trial = await getTrialBalance(db as any, '2026-12-31');
    const utangRow = trial.rows.find((r) => r.accountId === 'acc-utang');
    expect(utangRow?.kredit).toBe(-4_000_000); // LIABILITAS normal KREDIT, saldo abnormal -> negatif di kolom kredit

    const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
    expect(posisi.liabilitas.find((r) => r.kode === '2-1400')?.saldo).toBe(-4_000_000);
  });

  test('Pendapatan ber-saldo NEGATIF via REVERSAL (jurnal asal dibatalkan) — Laba Rugi TIDAK menjadi Rp0, tetap tampil negatif pada tanggal reversal itu sendiri', async () => {
    const db = await setupFixture();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'ANGSURAN_JASA',
      deskripsi: 'Pendapatan jasa (akan direversal)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 10_000_000, kredit: 0 },
        { accountId: ACC.pendapatanJasa, debit: 0, kredit: 10_000_000 },
      ],
    });
    // reverseJournal() SELALU membuat jurnal BARU bertanggal HARI INI
    // (lihat AccountingEngine.ts) — BUKAN tanggal jurnal asal. Ambil
    // journalId & tanggal dari HASIL reverseJournal, bukan dari jurnal
    // asalnya, supaya window laporan tepat mencakup baris reversal itu
    // sendiri (yang membalik arah normal Pendapatan jadi net DEBIT,
    // menghasilkan `jumlah` negatif murni pada tanggal ini).
    const { journalId: reversalJournalId } = await reverseJournal(db as any, journalId, 'user-1', 'Salah catat, dibatalkan');
    const reversalJournal = await db.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE id = ?`, reversalJournalId);

    const labaRugi = await getLabaRugi(db as any, reversalJournal!.tanggal, reversalJournal!.tanggal);
    const pendapatanRow = labaRugi.pendapatan.find((r) => r.kode === '4-1000');
    expect(pendapatanRow).toBeDefined();
    expect(pendapatanRow!.jumlah).toBe(-10_000_000); // NEGATIF, BUKAN Rp0 dan BUKAN disembunyikan
  });

  test('Beban ber-saldo NEGATIF via REVERSAL (jurnal asal dibatalkan) — Laba Rugi tetap tampil negatif pada tanggal reversal itu sendiri', async () => {
    const db = await setupFixture();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Beban operasional (akan direversal)',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanOperasional, debit: 3_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 3_000_000 },
      ],
    });
    const { journalId: reversalJournalId } = await reverseJournal(db as any, journalId, 'user-1', 'Salah catat, dibatalkan');
    const reversalJournal = await db.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE id = ?`, reversalJournalId);

    const labaRugi = await getLabaRugi(db as any, reversalJournal!.tanggal, reversalJournal!.tanggal);
    const bebanRow = labaRugi.beban.find((r) => r.kode === '5-1000');
    expect(bebanRow).toBeDefined();
    expect(bebanRow!.jumlah).toBe(-3_000_000); // NEGATIF (reversal membalik arah normal DEBIT jadi net KREDIT), BUKAN Rp0
  });
});

describe('formatRupiah — nilai negatif harus tetap tampil negatif (bug fix, request baru §16)', () => {
  test('nilai negatif diformat dengan minus DI DEPAN "Rp" (mis. -Rp5.000.000), bukan "Rp-5.000.000" dan bukan Rp0', async () => {
    const { formatRupiah } = await import('@/utils/money');
    expect(formatRupiah(-5_000_000)).toBe('-Rp5.000.000');
    expect(formatRupiah(-1)).toBe('-Rp1');
  });

  test('nilai 0 dan positif TIDAK berubah formatnya (backward compatible)', async () => {
    const { formatRupiah } = await import('@/utils/money');
    expect(formatRupiah(0)).toBe('Rp0');
    expect(formatRupiah(5_000_000)).toBe('Rp5.000.000');
  });
});

// ============================================================
// Audit ulang (permintaan pengguna §23/§24/§25 — "rekonsiliasi draft
// vs permanen"): membuktikan SECARA LANGSUNG bahwa "tampilan draft"
// (getRingkasanSaldoAwal, dibaca dari saldo_awal_akun) dan "hasil
// permanen" (getPosisiKeuangan, dibaca dari ledger sungguhan setelah
// tambahSaldoAwalAkun langsung memposting) MENGHASILKAN NILAI YANG
// SAMA PERSIS untuk setiap akun — sesuai arsitektur instan (§6/§7 sesi
// sebelumnya): tidak ada lagi jeda "draft beda dari permanen" karena
// SIMPAN langsung membuat jurnal seketika, bukan dua tahap terpisah.
// ============================================================
describe('Rekonsiliasi Saldo Awal DRAFT vs PERMANEN (permintaan pengguna §23/§24/§25) — harus identik', () => {
  test('Multi akun (Kas, Piutang, Simpanan Pokok, Simpanan Wajib): nilai di tabel saldo_awal_akun ("tampilan draft") SAMA PERSIS dengan getPosisiKeuangan ("ledger permanen") untuk setiap akun', async () => {
    const db = await setupFixture();
    const kliringId = 'acc-kliring-uji';
    await seedAccount(db, kliringId, '3-5000', 'Saldo Awal Belum Sesuai', 'EKUITAS', 'KREDIT');

    // Mensimulasikan PERSIS apa yang dilakukan `tambahSaldoAwalAkun()`
    // (SaldoAwalAkunService.ts) — jurnal 2-baris (akun + kliring)
    // seketika, DAN baris `saldo_awal_akun` (tabel "tampilan draft")
    // — TANPA perlu mock `@/database/db` (yang tidak tersedia di file
    // test ini), tapi tetap menembus accounting engine SUNGGUHAN
    // (createJournal), bukan raw INSERT ke ledger.
    async function simpanSaldoAwal(accountId: string, kode: string, saldo: number, normalBalance: 'DEBIT' | 'KREDIT') {
      const lines =
        normalBalance === 'DEBIT'
          ? [
              { accountId, debit: saldo, kredit: 0 },
              { accountId: kliringId, debit: 0, kredit: saldo },
            ]
          : [
              { accountId: kliringId, debit: saldo, kredit: 0 },
              { accountId, debit: 0, kredit: saldo },
            ];
      const { journalId } = await createJournal(db as any, {
        tanggal: '2026-01-01',
        sumberTransaksi: 'SALDO_AWAL_AKUN',
        sumberId: accountId,
        deskripsi: `Saldo awal akun ${kode}`,
        createdBy: 'user-1',
        lines,
      });
      const now = new Date().toISOString();
      await db.runAsync(
        `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        `saw-${accountId}`,
        accountId,
        '2026-01-01',
        saldo,
        journalId,
        'user-1',
        now,
        now
      );
    }

    await simpanSaldoAwal(ACC.kas, '1-1000', 100_000_000, 'DEBIT');
    await simpanSaldoAwal(ACC.piutang, '1-1200', 50_000_000, 'DEBIT');
    await simpanSaldoAwal(ACC.simpananPokok, '3-1000', 80_000_000, 'KREDIT');
    await simpanSaldoAwal(ACC.simpananWajib, '3-1100', 70_000_000, 'KREDIT');

    // "Tampilan draft" — apa yang tersimpan di saldo_awal_akun (dibaca
    // getRingkasanSaldoAwal/getValidasiSaldoAwal di layar Saldo Awal Akun).
    const draftRows = await db.getAllAsync<{ account_id: string; saldo: number }>(`SELECT account_id, saldo FROM saldo_awal_akun`);
    const tampilan: Record<string, number> = {};
    for (const r of draftRows) tampilan[r.account_id] = r.saldo;

    // "Hasil permanen" — apa yang sungguhan dibaca laporan resmi dari ledger.
    const posisi = await getPosisiKeuangan(db as any, '2026-01-01');
    const semuaRow = [...posisi.aset, ...posisi.liabilitas, ...posisi.ekuitas];
    const permanen: Record<string, number> = {};
    for (const r of semuaRow) {
      const acc = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, r.kode);
      if (acc) permanen[acc.id] = r.saldo;
    }

    // SETIAP akun: nilai tampilan draft == nilai ledger permanen, PERSIS (§2/§23).
    expect(tampilan[ACC.kas]).toBe(100_000_000);
    expect(permanen[ACC.kas]).toBe(100_000_000);
    expect(tampilan[ACC.piutang]).toBe(50_000_000);
    expect(permanen[ACC.piutang]).toBe(50_000_000);
    expect(tampilan[ACC.simpananPokok]).toBe(80_000_000);
    expect(permanen[ACC.simpananPokok]).toBe(80_000_000);
    expect(tampilan[ACC.simpananWajib]).toBe(70_000_000);
    expect(permanen[ACC.simpananWajib]).toBe(70_000_000);

    // Posisi Keuangan BALANCE (100jt+50jt Aset = 80jt+70jt Ekuitas = 150jt).
    expect(posisi.totalAset).toBe(150_000_000);
    expect(posisi.totalEkuitas).toBe(150_000_000);
    expect(posisi.isBalanced).toBe(true);
  });
});
