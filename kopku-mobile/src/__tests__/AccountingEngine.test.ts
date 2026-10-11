import { createTestDb, TestDb } from './testDb';
import { createJournal, postJournal, reverseJournal, voidJournal, getOrCreatePeriodeUntukTanggal, ClosedPeriodError } from '@/accounting/AccountingEngine';

/**
 * Test khusus Phase 1 (AUDIT_INTERNAL.md §2 poin 2 & §7 temuan #1):
 * sebelumnya accounting_period HANYA diisi sekali oleh SetupService
 * untuk tahun buku pertama — transaksi di tahun berikutnya akan
 * REJECT total karena tidak ada periode yang mencakupnya. Sekarang
 * resolvePeriod() otomatis membuat periode baru (via
 * getOrCreatePeriodeUntukTanggal) kalau belum ada, idempoten per tahun.
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

const ACC = { kas: 'acc-kas', modal: 'acc-modal' };

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  // SENGAJA tidak ada accounting_period sama sekali di fixture ini —
  // meniru kondisi "koperasi baru masuk tahun buku baru, belum ada
  // periode" yang jadi akar bug.
  return db;
}

describe('AccountingEngine — period rollover otomatis (Phase 1)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('getOrCreatePeriodeUntukTanggal: membuat periode baru kalau belum ada', async () => {
    const period = await getOrCreatePeriodeUntukTanggal(testDb as any, '2027-03-15');
    expect(period.status).toBe('OPEN');

    const row = await testDb.getFirstAsync<{ tahun_buku: number; periode_mulai: string; periode_selesai: string }>(
      `SELECT tahun_buku, periode_mulai, periode_selesai FROM accounting_period WHERE id = ?`,
      period.id
    );
    expect(row?.tahun_buku).toBe(2027);
    expect(row?.periode_mulai).toBe('2027-01-01');
    expect(row?.periode_selesai).toBe('2027-12-31');
  });

  test('createJournal: transaksi di tahun TANPA periode sebelumnya sekarang BERHASIL (dulu selalu REJECT)', async () => {
    const hasil = await createJournal(testDb as any, {
      tanggal: '2027-01-10',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Setoran modal tahun buku baru',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 1_000_000 },
      ],
    });
    expect(hasil.journalId).toBeTruthy();

    const jumlahPeriode = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM accounting_period WHERE tahun_buku = 2027`
    );
    expect(jumlahPeriode?.cnt).toBe(1);
  });

  test('idempoten: dua transaksi di tahun yang sama TIDAK membuat dua periode', async () => {
    await createJournal(testDb as any, {
      tanggal: '2027-01-10',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Transaksi 1',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 500_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 500_000 },
      ],
    });
    await createJournal(testDb as any, {
      tanggal: '2027-11-20',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Transaksi 2',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 300_000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 300_000 },
      ],
    });

    const jumlahPeriode = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM accounting_period WHERE tahun_buku = 2027`
    );
    expect(jumlahPeriode?.cnt).toBe(1);

    const keduaJurnal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(keduaJurnal?.cnt).toBe(2); // dua jurnal beda, tapi satu periode
  });

  test('periode yang sudah ada (termasuk CLOSED) TIDAK disentuh/diduplikasi', async () => {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'CLOSED')`,
      'period-2026-closed',
      2026,
      '2026-01-01',
      '2026-12-31'
    );

    await expect(
      createJournal(testDb as any, {
        tanggal: '2026-06-01',
        sumberTransaksi: 'MODAL_UANG',
        deskripsi: 'Coba transaksi di periode closed',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: 100_000, kredit: 0 },
          { accountId: ACC.modal, debit: 0, kredit: 100_000 },
        ],
      })
    ).rejects.toThrow(ClosedPeriodError);

    // Periode 2026 tetap CLOSED, tidak ada periode baru dibuat untuk 2026.
    const rows = await testDb.getAllAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE tahun_buku = 2026`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CLOSED');
  });
});

describe('Idempotency key — pengaman anti double-submit (Phase 2)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('UNIQUE INDEX partial menolak idempotency_key yang sama pada simpanan_transaksi', async () => {
    const now = new Date().toISOString();
    const insert = (id: string, key: string | null) =>
      testDb.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, idempotency_key, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        'anggota-1',
        'POKOK',
        'SETOR',
        '2027-01-01',
        100000,
        'KAS',
        `SP-${id}`,
        key,
        'user-1',
        now
      );

    // Anggota dummy (FK anggota_id) — cukup minimal untuk lolos constraint.
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-1','A001','1234567890123456','Test','2025-01-01','AKTIF',?,?)`,
      now,
      now
    );

    await insert('trx-1', 'idem-abc-123');
    await expect(insert('trx-2', 'idem-abc-123')).rejects.toThrow(/UNIQUE constraint failed/);

    // Baris tanpa idempotency_key (NULL) — bebas berapa pun, tidak kena constraint.
    await insert('trx-3', null);
    await insert('trx-4', null);

    const rows = await testDb.getAllAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM simpanan_transaksi`);
    expect(rows[0].cnt).toBe(3); // trx-1, trx-3, trx-4 (trx-2 gagal insert)
  });
});

// ============================================================
// Prioritas W item #21 (Audit Trail) — GAP DITEMUKAN: writeAuditLog()
// sudah dipanggil di createJournal/postJournal/reverseJournal/
// voidJournal sejak awal, TAPI TIDAK ADA satu test pun di seluruh
// project yang memverifikasi audit_log benar-benar terisi. Karena
// SEMUA transaksi keuangan di aplikasi ini lewat AccountingEngine,
// test di sini otomatis jadi jaring pengaman untuk seluruh app —
// bukan cuma AccountingEngine sendiri.
// ============================================================
describe('AccountingEngine — audit_log terisi untuk setiap aksi jurnal (Prioritas W #21)', () => {
  async function seedFixtureAudit(): Promise<TestDb> {
    const db = await createTestDb();
    await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
    await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
    return db;
  }

  test('createJournal (autoPost, default): audit_log berisi action=POST, entity=journal, data_sesudah terisi', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Setoran modal',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 100000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 100000 },
      ],
    });

    const logs = await db.getAllAsync<{ user_id: string; action: string; entity: string; entity_id: string; data_sesudah: string | null }>(
      `SELECT * FROM audit_log WHERE entity_id = ?`,
      journalId
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].user_id).toBe('user-1');
    expect(logs[0].action).toBe('POST');
    expect(logs[0].entity).toBe('journal');
    expect(logs[0].data_sesudah).not.toBeNull();
    const parsed = JSON.parse(logs[0].data_sesudah!);
    expect(parsed.totalDebit).toBe(100000);
    expect(parsed.totalKredit).toBe(100000);
  });

  test('createJournal (autoPost: false, DRAFT): audit_log berisi action=CREATE, bukan POST', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Draft dulu',
      createdBy: 'user-1',
      autoPost: false,
      lines: [
        { accountId: ACC.kas, debit: 50000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 50000 },
      ],
    });
    const log = await db.getFirstAsync<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = ?`, journalId);
    expect(log?.action).toBe('CREATE');
  });

  test('postJournal: audit_log kedua (action=POST) ditambahkan di atas audit_log CREATE, bukan menimpanya', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Draft dulu',
      createdBy: 'user-1',
      autoPost: false,
      lines: [
        { accountId: ACC.kas, debit: 50000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 50000 },
      ],
    });
    await postJournal(db as any, journalId, 'user-2');

    const logs = await db.getAllAsync<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM audit_log WHERE entity_id = ? ORDER BY created_at ASC`,
      journalId
    );
    expect(logs).toHaveLength(2);
    expect(logs[0].action).toBe('CREATE');
    expect(logs[1].action).toBe('POST');
    expect(logs[1].user_id).toBe('user-2'); // user yang posting tercatat, bukan user yang create
  });

  test('reverseJournal: audit_log mencatat REVERSE dengan entityId jurnal ASAL, plus jurnal balik dicatat POST sendiri', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Salah input',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 100000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 100000 },
      ],
    });
    const { journalId: reversalId } = await reverseJournal(db as any, journalId, 'user-2', 'Salah nominal');

    const reverseLog = await db.getFirstAsync<{ action: string; entity_id: string; user_id: string }>(
      `SELECT action, entity_id, user_id FROM audit_log WHERE action = 'REVERSE'`
    );
    expect(reverseLog?.entity_id).toBe(journalId); // dicatat pada jurnal ASAL
    expect(reverseLog?.user_id).toBe('user-2');

    // Jurnal balik yang baru dibuat JUGA punya audit_log POST sendiri (lewat createJournal).
    const reversalLog = await db.getFirstAsync<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = ?`,
      reversalId
    );
    expect(reversalLog?.action).toBe('POST');
  });

  test('voidJournal: audit_log mencatat VOID', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Draft yang batal dipakai',
      createdBy: 'user-1',
      autoPost: false,
      lines: [
        { accountId: ACC.kas, debit: 20000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 20000 },
      ],
    });
    await voidJournal(db as any, journalId, 'user-3');

    const voidLog = await db.getFirstAsync<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM audit_log WHERE entity_id = ? AND action = 'VOID'`,
      journalId
    );
    expect(voidLog).not.toBeNull();
    expect(voidLog?.user_id).toBe('user-3');
  });

  test('Setiap baris jurnal (bukan cuma header) tidak butuh audit_log terpisah — satu baris audit_log per aksi jurnal cukup mewakili seluruh baris debit/kredit di dalamnya (via data_sesudah.lines)', async () => {
    const db = await seedFixtureAudit();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-02-01',
      sumberTransaksi: 'MODAL_UANG',
      deskripsi: 'Multi-baris',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 60000, kredit: 0 },
        { accountId: ACC.modal, debit: 0, kredit: 40000 },
        { accountId: ACC.modal, debit: 0, kredit: 20000 },
      ],
    });
    const log = await db.getFirstAsync<{ data_sesudah: string }>(`SELECT data_sesudah FROM audit_log WHERE entity_id = ?`, journalId);
    const parsed = JSON.parse(log!.data_sesudah);
    expect(parsed.lines).toHaveLength(3);
  });
});
