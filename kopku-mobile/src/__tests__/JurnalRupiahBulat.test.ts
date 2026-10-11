import { createTestDb, TestDb } from './testDb';
import { createJournal } from '@/accounting/AccountingEngine';

/**
 * INVARIAN RUPIAH BULAT pada pembuatan jurnal (PRD §40).
 *
 * Kenapa test ini ada: gejala yang dilaporkan pada Posisi Keuangan
 * pembukaan pertama adalah selisih BERDESIMAL (mis. "Rp25,58"). Audit
 * seluruh pemanggil `createJournal()` menunjukkan setiap nominal sudah
 * melewati `roundToRupiah()`/`Math.round()`, jadi TIDAK DITEMUKAN jalur
 * pecahan pada source saat ini.
 *
 * Namun kolom `journal_entry.debit`/`kredit` hanya ber-AFINITAS INTEGER:
 * SQLite tetap menyimpan REAL apa adanya kalau nilainya tidak bisa
 * dikonversi tanpa kehilangan presisi. Artinya nominal pecahan TIDAK
 * akan ditolak database — ia mengendap diam-diam dan baru muncul jauh
 * kemudian sebagai selisih laporan berdesimal yang sulit ditelusuri.
 *
 * Guard di `validateLines()` menutup lubang itu di SATU-SATUNYA pintu
 * masuk sah pembuatan jurnal. Test ini mengunci perilakunya.
 */

let db: TestDb;

const ACC_KAS = 'acc-kas';
const ACC_MODAL = 'acc-modal';

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date().toISOString();
  for (const [id, kode, nama, kategori, nb] of [
    [ACC_KAS, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC_MODAL, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT'],
  ] as const) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      id,
      kode,
      nama,
      kategori,
      nb,
      now,
      now
    );
  }
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
});

test('nominal Rupiah bulat diterima seperti biasa', async () => {
  const hasil = await createJournal(db as any, {
    tanggal: '2026-03-01',
    sumberTransaksi: 'MODAL_AWAL',
    deskripsi: 'setoran modal',
    createdBy: 'user-1',
    lines: [
      { accountId: ACC_KAS, debit: 5_000_000, kredit: 0 },
      { accountId: ACC_MODAL, debit: 0, kredit: 5_000_000 },
    ],
  });
  expect(hasil.journalId).toBeTruthy();
});

test('nominal PECAHAN ditolak di titik pembuatan, bukan mengendap di ledger', async () => {
  await expect(
    createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'AKRUAL_JASA',
      deskripsi: 'akrual berdesimal',
      createdBy: 'user-1',
      lines: [
        // Seimbang secara matematis, jadi validasi balance TIDAK akan
        // menangkapnya — hanya invarian integer yang bisa.
        { accountId: ACC_KAS, debit: 25.58, kredit: 0 },
        { accountId: ACC_MODAL, debit: 0, kredit: 25.58 },
      ],
    })
  ).rejects.toThrow(/Rupiah bulat/i);

  // Tidak ada apa pun yang tertulis ke ledger.
  const jurnal = await db.getAllAsync<{ id: string }>(`SELECT id FROM journal`);
  const baris = await db.getAllAsync<{ id: string }>(`SELECT id FROM journal_entry`);
  expect(jurnal).toHaveLength(0);
  expect(baris).toHaveLength(0);
});

test('pecahan pada SATU sisi saja juga ditolak', async () => {
  await expect(
    createJournal(db as any, {
      tanggal: '2026-03-01',
      sumberTransaksi: 'AKRUAL_JASA',
      deskripsi: 'sisi pecahan',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC_KAS, debit: 1000.5, kredit: 0 },
        { accountId: ACC_MODAL, debit: 0, kredit: 1000.5 },
      ],
    })
  ).rejects.toThrow(/Rupiah bulat/i);
});
