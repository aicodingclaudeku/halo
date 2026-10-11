import { createTestDb, TestDb } from './testDb';
import {
  createJournal,
  reverseJournal,
  InactiveAccountJournalError,
} from '@/accounting/AccountingEngine';

/**
 * REQUIREMENT 4 (permintaan pengguna) — "Delete COA" menjadi
 * Active/Non-active, dan aturannya DITEGAKKAN DI BACKEND.
 *
 * Sebelum perbaikan ini, satu-satunya penjaga akun nonaktif adalah
 * `AccountMapping.resolveAccountId()` — yang hanya melindungi akun yang
 * dipilih OTOMATIS lewat mapping transaksi. Akun yang dipilih MANUAL
 * lewat picker (form Beban, Pendapatan Lainnya, Saldo Awal Akun,
 * Kas/Bank) hanya disaring di query UI (`is_active = 1`), jadi
 * `createJournal()` akan menerimanya begitu saja kalau accountId
 * sampai ke sana lewat state basi atau jalur lain.
 *
 * Yang dibuktikan:
 *   1) jurnal BARU yang menyentuh akun nonaktif DITOLAK;
 *   2) pesan errornya menyebut akun mana yang bermasalah (bukan error
 *      generik yang menyesatkan petugas);
 *   3) jurnal dengan akun aktif TETAP jalan (tidak ada regresi);
 *   4) TIDAK ADA baris jurnal/entry yang tertulis sebagian saat ditolak;
 *   5) REVERSAL jurnal lama yang akunnya SUDAH dinonaktifkan TETAP BISA
 *      dijalankan — kalau tidak, menonaktifkan COA justru mengunci
 *      histori, persis yang dilarang requirement.
 */

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  isActive = 1
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    isActive,
    now,
    now
  );
}

const ACC = { kas: 'acc-kas', beban: 'acc-beban', bebanMati: 'acc-beban-mati' };

describe('REQ 4 — COA non-active tidak dapat dipakai transaksi baru', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount(testDb, ACC.beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
    await seedAccount(testDb, ACC.bebanMati, '5-9999', 'Beban Lama Nonaktif', 'BEBAN', 'DEBIT', 0);
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
      now,
      now
    );
  });

  test('jurnal dengan akun AKTIF tetap berhasil (tidak ada regresi)', async () => {
    const hasil = await createJournal(testDb as any, {
      tanggal: '2026-05-01',
      sumberTransaksi: 'BEBAN',
      deskripsi: 'Beban listrik',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.beban, debit: 100000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 100000 },
      ],
    });
    expect(hasil.journalId).toBeTruthy();
  });

  test('jurnal BARU yang menyentuh akun NONAKTIF ditolak', async () => {
    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-05-01',
        sumberTransaksi: 'BEBAN',
        deskripsi: 'Beban ke akun nonaktif',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.bebanMati, debit: 100000, kredit: 0 },
          { accountId: ACC.kas, debit: 0, kredit: 100000 },
        ],
      })
    ).rejects.toThrow(InactiveAccountJournalError);
  });

  test('pesan error menyebut kode & nama akun yang bermasalah', async () => {
    let pesan = '';
    try {
      await createJournal(testDb as any, {
        tanggal: '2026-05-01',
        sumberTransaksi: 'BEBAN',
        deskripsi: 'Beban ke akun nonaktif',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.bebanMati, debit: 100000, kredit: 0 },
          { accountId: ACC.kas, debit: 0, kredit: 100000 },
        ],
      });
    } catch (e) {
      pesan = e instanceof Error ? e.message : String(e);
    }
    expect(pesan).toContain('5-9999');
    expect(pesan).toContain('Beban Lama Nonaktif');
  });

  test('penolakan TIDAK meninggalkan jurnal/entry setengah jadi', async () => {
    const sebelumJ = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    const sebelumE = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal_entry`);

    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-05-01',
        sumberTransaksi: 'BEBAN',
        deskripsi: 'Ditolak',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.bebanMati, debit: 100000, kredit: 0 },
          { accountId: ACC.kas, debit: 0, kredit: 100000 },
        ],
      })
    ).rejects.toThrow();

    const sesudahJ = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    const sesudahE = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal_entry`);
    expect(sesudahJ?.cnt).toBe(sebelumJ?.cnt);
    expect(sesudahE?.cnt).toBe(sebelumE?.cnt);
  });

  test('akun yang tidak ada sama sekali juga ditolak (bukan diam-diam tertulis)', async () => {
    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-05-01',
        sumberTransaksi: 'BEBAN',
        deskripsi: 'Akun hantu',
        createdBy: 'user-1',
        lines: [
          { accountId: 'acc-tidak-ada', debit: 100000, kredit: 0 },
          { accountId: ACC.kas, debit: 0, kredit: 100000 },
        ],
      })
    ).rejects.toThrow(/tidak ditemukan/i);
  });

  test('HISTORI TETAP AMAN: reversal jurnal lama yang akunnya kemudian dinonaktifkan tetap bisa dijalankan', async () => {
    // 1. Jurnal dibuat saat akun MASIH AKTIF.
    const asli = await createJournal(testDb as any, {
      tanggal: '2026-05-01',
      sumberTransaksi: 'BEBAN',
      deskripsi: 'Beban operasional',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.beban, debit: 100000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 100000 },
      ],
    });

    // 2. Akun dinonaktifkan SETELAH jurnal ada.
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.beban);

    // 3. Transaksi BARU ke akun itu harus ditolak...
    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-06-01',
        sumberTransaksi: 'BEBAN',
        deskripsi: 'Transaksi baru',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.beban, debit: 50000, kredit: 0 },
          { accountId: ACC.kas, debit: 0, kredit: 50000 },
        ],
      })
    ).rejects.toThrow(InactiveAccountJournalError);

    // 4. ...TAPI koreksi histori (reversal) HARUS tetap bisa.
    const reversal = await reverseJournal(testDb as any, asli.journalId, 'user-1', 'Salah input');
    expect(reversal.journalId).toBeTruthy();

    const status = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM journal WHERE id = ?`,
      asli.journalId
    );
    expect(status?.status).toBe('REVERSED');

    // Jurnal lama TIDAK dihapus — histori utuh.
    const entriLama = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT account_id FROM journal_entry WHERE journal_id = ?`,
      asli.journalId
    );
    expect(entriLama.length).toBe(2);
  });
});
