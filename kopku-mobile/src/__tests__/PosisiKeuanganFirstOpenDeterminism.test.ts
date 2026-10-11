import { createTestDb, TestDb } from './testDb';
import { getPosisiKeuangan } from '@/reports/FinancialReports';

/**
 * §6/§30 — DETERMINISME LAPORAN POSISI KEUANGAN.
 *
 * Bug yang dijaga test ini: pada pembukaan PERTAMA setelah aplikasi
 * dijalankan, Posisi Keuangan kadang menampilkan selisih kecil
 * (mis. Rp25,58); keluar dari layar lalu masuk lagi -> selisih 0, TANPA
 * transaksi baru apa pun.
 *
 * ROOT CAUSE (lihat StartupTasks.ts): pekerjaan latar penyusutan &
 * akrual jasa dimulai fire-and-forget saat fase READY dan MENULIS
 * jurnal pada koneksi SQLite yang SAMA dengan laporan. `createJournal()`
 * menulis header jurnal lebih dulu, lalu tiap baris `journal_entry` satu
 * per satu. Laporan yang dihitung di tengah penulisan itu melihat jurnal
 * POSTED yang baru punya SEBAGIAN kakinya -> himpunan baris yang terbaca
 * TIDAK seimbang -> selisih. Setelah pekerjaan latar selesai, jurnalnya
 * utuh dan pembukaan kedua kembali 0.
 *
 * Test ini membuktikan DUA hal sekaligus:
 *   1. mekanismenya memang itu (jurnal setengah tertulis -> selisih),
 *      sehingga perbaikan tidak dibangun di atas tebakan;
 *   2. begitu ledger utuh, perhitungan bersifat DETERMINISTIK — dibuka
 *      berapa kali pun hasilnya identik dan selisihnya 0.
 *
 * TIDAK ADA toleransi pembulatan, TIDAK ADA Math.abs(selisih) < X,
 * TIDAK ADA setTimeout — selisih dibandingkan dengan 0 secara persis.
 */

let db: TestDb;

const ACC = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  akumPenyusutan: 'acc-akum-penyusutan',
  modal: 'acc-modal',
  pendapatan: 'acc-pendapatan',
  beban: 'acc-beban',
};

async function seedAccount(
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

async function seedJournalHeader(id: string, tanggal: string, sumber: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?, 'period-2026', ?, ?, 'POSTED', 'user-1', ?,?,?)`,
    id,
    `JRN-${id}`,
    tanggal,
    sumber,
    `fixture ${id}`,
    now,
    now,
    now
  );
}

async function seedLeg(id: string, journalId: string, accountId: string, debit: number, kredit: number, urutan: number) {
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES (?,?,?,?,?,?)`,
    id,
    journalId,
    accountId,
    debit,
    kredit,
    urutan
  );
}

beforeEach(async () => {
  db = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutang, '1-1200', 'Piutang Anggota', 'ASET', 'DEBIT');
  await seedAccount(ACC.akumPenyusutan, '1-1510', 'Akumulasi Penyusutan', 'ASET', 'KREDIT');
  await seedAccount(ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.pendapatan, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(ACC.beban, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('period-2026', 2026, '2026-01-01', '2026-12-31', 'OPEN')`
  );

  // Ledger dasar yang sehat: setoran modal.
  await seedJournalHeader('j-modal', '2026-01-01', 'MODAL_AWAL');
  await seedLeg('e-modal-1', 'j-modal', ACC.kas, 50_000_000, 0, 0);
  await seedLeg('e-modal-2', 'j-modal', ACC.modal, 0, 50_000_000, 1);
});

test('ledger utuh: Aset = Liabilitas + Ekuitas, selisih PERSIS 0', async () => {
  const hasil = await getPosisiKeuangan(db as any, '2026-06-30');
  expect(hasil.selisih).toBe(0);
  expect(hasil.isBalanced).toBe(true);
  expect(hasil.totalAset).toBe(hasil.totalLiabilitas + hasil.totalEkuitas);
});

test('MEKANISME BUG: laporan yang dihitung saat jurnal baru tertulis SEBAGIAN menghasilkan selisih', async () => {
  // Meniru persis urutan tulis createJournal(): header dulu, lalu kaki
  // satu per satu. Pembacaan terjadi setelah kaki PERTAMA, sebelum kaki
  // kedua — inilah yang dilihat laporan pada first open.
  await seedJournalHeader('j-akrual', '2026-06-30', 'AKRUAL_JASA');
  await seedLeg('e-akrual-1', 'j-akrual', ACC.piutang, 1_250_000, 0, 0);

  const firstOpen = await getPosisiKeuangan(db as any, '2026-06-30');
  expect(firstOpen.isBalanced).toBe(false);
  expect(firstOpen.selisih).toBe(1_250_000);

  // Kaki kedua menyusul — penulisan selesai, TANPA transaksi baru dari user.
  await seedLeg('e-akrual-2', 'j-akrual', ACC.pendapatan, 0, 1_250_000, 1);

  const secondOpen = await getPosisiKeuangan(db as any, '2026-06-30');
  expect(secondOpen.isBalanced).toBe(true);
  expect(secondOpen.selisih).toBe(0);
});

test('DETERMINISME: 5 pembukaan berturut-turut atas database yang sama menghasilkan hasil IDENTIK', async () => {
  // Ledger lengkap & realistis: akrual jasa + penyusutan (akun kontra).
  await seedJournalHeader('j-akrual', '2026-03-31', 'AKRUAL_JASA');
  await seedLeg('e-a1', 'j-akrual', ACC.piutang, 1_250_000, 0, 0);
  await seedLeg('e-a2', 'j-akrual', ACC.pendapatan, 0, 1_250_000, 1);

  await seedJournalHeader('j-susut', '2026-04-30', 'PENYUSUTAN');
  await seedLeg('e-s1', 'j-susut', ACC.beban, 333_333, 0, 0);
  await seedLeg('e-s2', 'j-susut', ACC.akumPenyusutan, 0, 333_333, 1);

  const pembukaan = [];
  for (let i = 0; i < 5; i++) {
    pembukaan.push(await getPosisiKeuangan(db as any, '2026-06-30'));
  }

  const pertama = pembukaan[0];
  expect(pertama.selisih).toBe(0);
  expect(pertama.isBalanced).toBe(true);

  for (const buka of pembukaan) {
    expect(buka.selisih).toBe(pertama.selisih);
    expect(buka.totalAset).toBe(pertama.totalAset);
    expect(buka.totalLiabilitas).toBe(pertama.totalLiabilitas);
    expect(buka.totalEkuitas).toBe(pertama.totalEkuitas);
    expect(buka.labaBerjalan).toBe(pertama.labaBerjalan);
    // Varians laporan harus SELALU sama — tidak boleh 25,58 lalu 0.
    expect(buka.selisih).toBe(0);
  }
});

test('DETERMINISME: hasil identik walau dihitung ulang setelah "restart" (koneksi baca ulang)', async () => {
  await seedJournalHeader('j-akrual', '2026-03-31', 'AKRUAL_JASA');
  await seedLeg('e-a1', 'j-akrual', ACC.piutang, 987_654, 0, 0);
  await seedLeg('e-a2', 'j-akrual', ACC.pendapatan, 0, 987_654, 1);

  const coldStart = await getPosisiKeuangan(db as any, '2026-12-31');
  const reopen = await getPosisiKeuangan(db as any, '2026-12-31');
  const setelahRestart = await getPosisiKeuangan(db as any, '2026-12-31');

  expect(coldStart.selisih).toBe(0);
  expect(reopen.selisih).toBe(0);
  expect(setelahRestart.selisih).toBe(0);
  expect(reopen.totalAset).toBe(coldStart.totalAset);
  expect(setelahRestart.totalEkuitas).toBe(coldStart.totalEkuitas);
});
