import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S81 — TEMUAN NON-JURNAL HARUS TERSIMPAN SEBAGAI DRAFT.
 *
 * Berbeda dari RC-S80 yang sebagian mengaudit urutan source, berkas ini
 * membuktikan STATUS DI DATABASE lewat SQLite sungguhan: memilih
 * penyebab bukan berarti menyelesaikan temuannya.
 */

let testDb: TestDb;

jest.mock('@/database/db', () => {
  const asli = jest.requireActual('@/database/db');
  return {
    ...asli,
    getDb: jest.fn(async () => testDb),
    withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
      let result: unknown;
      await testDb.withTransactionAsync(async () => {
        result = await fn(testDb);
      });
      return result;
    }),
  };
});

import {
  catatRekonsiliasiDanTindakLanjut,
  getStatusRekonsiliasiPeriode,
  rekonsiliasiMenghalangiTutupPeriode,
  penyebabTetapDraft,
  PENYEBAB_SELESAI_SEKETIKA,
  type PenyebabSelisih,
} from '@/services/CashReconciliationService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const USER = 'user-1';
const ACC = { kas: 'acc-kas', bank: 'acc-bank', beban: 'acc-beban', pendapatan: 'acc-pendapatan' };

async function seed(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  const akun = async (id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') =>
    db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
      id, kode, nama, kat, nb, now, now
    );
  await akun(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await akun(ACC.bank, '1-1100', 'Bank Operasional', 'ASET', 'DEBIT');
  await akun(ACC.beban, '5-9000', 'Beban Administrasi Bank', 'BEBAN', 'DEBIT');
  await akun(ACC.pendapatan, '4-9000', 'Pendapatan Jasa Giro', 'PENDAPATAN', 'KREDIT');
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`, ACC.kas
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','12345','Koperasi',0,?,1,?)`, ACC.bank, now
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,'Admin','admin','ADMIN','x','x',0,1,?,?)`, USER, now, now
  );
  return db;
}

/**
 * Persis yang dilakukan layar: catat pemeriksaan + tindak lanjut dalam
 * satu panggilan. Saldo buku fixture = 0, jadi `saldoFisik` yang
 * diberikan sama dengan selisihnya (selalu >= 0 di sini).
 */
const periksa = (accountId: string, saldoFisik: number, tindakLanjut: any, tanggal = '2026-08-31') =>
  catatRekonsiliasiDanTindakLanjut({
    accountId,
    namaRekening: accountId === ACC.bank ? 'Bank Operasional' : 'Kas',
    tanggal,
    saldoFisik,
    createdBy: USER,
    tindakLanjut,
  });

/** Baca langsung dari tabel — bukan dari objek yang dikembalikan service. */
const dariDb = (id: string) =>
  testDb.getFirstAsync<any>(
    `SELECT status, status_penyelesaian, penyebab, perlakuan, journal_id, diselesaikan_oleh, diselesaikan_at
       FROM rekonsiliasi_kas_bank WHERE id = ?`,
    id
  );

async function potret() {
  return JSON.stringify({
    journal: await testDb.getAllAsync<any>(`SELECT * FROM journal ORDER BY id`),
    journal_entry: await testDb.getAllAsync<any>(`SELECT * FROM journal_entry ORDER BY id`),
    rekonsiliasi: await testDb.getAllAsync<any>(`SELECT * FROM rekonsiliasi_kas_bank ORDER BY id`),
  });
}

beforeEach(async () => {
  testDb = await seed();
});

// ===========================================================================
// 1–4. TEMUAN NON-JURNAL → DRAFT (SQLite nyata)
// ===========================================================================

describe('RC-S81 — temuan non-jurnal tersimpan DRAFT di database', () => {
  it.each([
    ['TRANSAKSI_BELUM_TERCATAT', 'setoran 23 Sep belum dicatat'],
    ['SELISIH_PENCATATAN', 'nominal tertukar pada bukti 112'],
    ['KESALAHAN_BANK', 'bank salah debit, lapor 01/09'],
    ['LAINNYA', 'selisih setoran ATM belum jelas'],
  ] as [PenyebabSelisih, string][])(
    '%s → SELISIH + DRAFT + tanpa jurnal, dan belum ditandai diselesaikan',
    async (penyebab, catatan) => {
      const r = await periksa(ACC.bank, 200_000, {
        penyebab, perlakuan: 'TIDAK_PERLU_JURNAL', catatan,
      });

      const db = await dariDb(r.id);
      expect(db.status).toBe('SELISIH');
      expect(db.status_penyelesaian).toBe('DRAFT'); // inti RC-S81
      expect(db.penyebab).toBe(penyebab); // penyebab TETAP tersimpan
      expect(db.perlakuan).toBe('TIDAK_PERLU_JURNAL');
      expect(db.journal_id).toBeNull();
      // Belum ada yang menyelesaikan apa pun — jangan tampak sudah ditangani.
      expect(db.diselesaikan_oleh).toBeNull();
      expect(db.diselesaikan_at).toBeNull();
      // Tidak ada jurnal apa pun yang terbentuk.
      expect(await testDb.getAllAsync<any>(`SELECT id FROM journal`)).toHaveLength(0);
    }
  );

  it('helper penyebabTetapDraft konsisten dengan daftar penyebab selesai-seketika', () => {
    expect([...PENYEBAB_SELESAI_SEKETIKA].sort()).toEqual(
      ['BIAYA_ADMIN_BANK', 'JASA_GIRO', 'SELISIH_FISIK', 'TIMING_DIFFERENCE'].sort()
    );
    for (const p of ['TRANSAKSI_BELUM_TERCATAT', 'SELISIH_PENCATATAN', 'KESALAHAN_BANK', 'LAINNYA'] as PenyebabSelisih[]) {
      expect(penyebabTetapDraft(p)).toBe(true);
    }
    for (const p of PENYEBAB_SELESAI_SEKETIKA) expect(penyebabTetapDraft(p)).toBe(false);
  });

  it('catatan tetap wajib, dan akun lawan tetap ditolak untuk temuan', async () => {
    const sebelum = await potret();
    await expect(
      periksa(ACC.bank, 200_000, { penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: '  ' })
    ).rejects.toThrow(/Catatan pemeriksaan wajib/i);
    await expect(
      periksa(ACC.bank, 200_000, {
        penyebab: 'KESALAHAN_BANK', perlakuan: 'TIDAK_PERLU_JURNAL', akunLawanId: ACC.beban, catatan: 'x',
      })
    ).rejects.toThrow(/tidak memerlukan akun pencatatan/i);
    // 12 — penolakan tidak meninggalkan jejak.
    expect(await potret()).toBe(sebelum);
  });

  it('temuan + PERLU_JURNAL tetap ditolak (tidak ada jurnal generik)', async () => {
    const sebelum = await potret();
    await expect(
      periksa(ACC.bank, 200_000, {
        penyebab: 'LAINNYA', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan, catatan: 'x',
      })
    ).rejects.toThrow(/tidak diselesaikan dengan jurnal/i);
    expect(await potret()).toBe(sebelum);
  });
});

// ===========================================================================
// 5–6. YANG MEMANG BOLEH SELESAI SEKETIKA
// ===========================================================================

describe('RC-S81 — penyelesaian final tetap SELESAI', () => {
  it('5. perbedaan waktu → SELESAI tanpa jurnal, status tetap SELISIH', async () => {
    const r = await periksa(ACC.bank, 500_000, {
      penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek no. 12 belum cair',
    });
    const db = await dariDb(r.id);
    expect(db.status).toBe('SELISIH'); // saldo memang masih beda
    expect(db.status_penyelesaian).toBe('SELESAI');
    expect(db.journal_id).toBeNull();
    expect(db.diselesaikan_oleh).toBe(USER);
  });

  it('6. penyesuaian valid → SELESAI + jurnal seimbang', async () => {
    const r = await periksa(ACC.bank, 25_000, {
      penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan, catatan: 'jasa giro Agustus',
    });
    const db = await dariDb(r.id);
    expect(db.status_penyelesaian).toBe('SELESAI');
    expect(db.journal_id).not.toBeNull();
    const e = await testDb.getAllAsync<any>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, db.journal_id
    );
    expect(e).toEqual([
      { account_id: ACC.bank, debit: 25_000, kredit: 0 },
      { account_id: ACC.pendapatan, debit: 0, kredit: 25_000 },
    ]);
  });

  it('11. pemeriksaan ulang membuat ROW BARU dan TIDAK menghasilkan jurnal kedua', async () => {
    const a = await periksa(ACC.bank, 15_000, {
      penyebab: 'JASA_GIRO', perlakuan: 'PERLU_JURNAL', akunLawanId: ACC.pendapatan, catatan: 'giro Agustus',
    });
    expect((await dariDb(a.id)).journal_id).not.toBeNull();

    // Penyesuaian tadi MEMANG mengubah saldo buku bank sebesar 15.000,
    // jadi pemeriksaan berikutnya terhadap saldo eksternal yang sama
    // kini cocok — dan tidak boleh membukukan apa pun lagi.
    const b = await periksa(ACC.bank, 15_000, undefined, '2026-09-30');
    expect(a.id).not.toBe(b.id); // histori tidak ditimpa
    const kedua = await dariDb(b.id);
    expect(kedua.status).toBe('COCOK');
    expect(kedua.journal_id).toBeNull();

    // Tepat satu jurnal dari seluruh rangkaian.
    expect(await testDb.getAllAsync<any>(`SELECT id FROM journal`)).toHaveLength(1);
  });
});

// ===========================================================================
// 9–10. PERIOD CLOSE
// ===========================================================================

describe('RC-S81 — PeriodClose terhadap temuan DRAFT', () => {
  const AGT = ['2026-08-01', '2026-08-31'] as const;
  const pemblokir = async () => {
    const st = await getStatusRekonsiliasiPeriode(testDb as any, AGT[0], AGT[1]);
    return st
      .filter((r) => r.rekonsiliasi === null || rekonsiliasiMenghalangiTutupPeriode(r.rekonsiliasi))
      .map((r) => r.accountId);
  };
  /** Kas diselesaikan agar fokus pada Bank. */
  const kasBeres = () => periksa(ACC.kas, 0, undefined);

  it('9. temuan DRAFT memblokir penutupan periode', async () => {
    await periksa(ACC.bank, 200_000, {
      penyebab: 'TRANSAKSI_BELUM_TERCATAT', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'setoran belum dicatat',
    });
    await kasBeres();
    expect(await pemblokir()).toEqual([ACC.bank]);
  });

  it('perbedaan waktu yang sudah SELESAI TIDAK memblokir', async () => {
    await periksa(ACC.bank, 500_000, {
      penyebab: 'TIMING_DIFFERENCE', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'cek no. 12',
    });
    await kasBeres();
    expect(await pemblokir()).toEqual([]);
  });

  it('10. rekonsiliasi ulang: DRAFT lama + COCOK baru dalam periode yang sama → ALLOW, histori utuh', async () => {
    const draft = await periksa(ACC.bank, 200_000, {
      penyebab: 'TRANSAKSI_BELUM_TERCATAT', perlakuan: 'TIDAK_PERLU_JURNAL', catatan: 'belum dicatat',
    }, '2026-08-10');
    expect((await dariDb(draft.id)).status_penyelesaian).toBe('DRAFT');

    // Transaksi dicatat di luar rekonsiliasi, lalu diperiksa ulang: cocok.
    await periksa(ACC.bank, 0, undefined, '2026-08-31');
    await kasBeres();

    expect(await pemblokir()).toEqual([]);
    // Baris 10 Agustus TIDAK ditimpa — buktinya masih ada.
    const lama = await dariDb(draft.id);
    expect(lama.status_penyelesaian).toBe('DRAFT');
    expect(lama.penyebab).toBe('TRANSAKSI_BELUM_TERCATAT');
  });
});

// ===========================================================================
// 7–8. CTA SAVE-FIRST (struktural — renderer RN tidak tersedia)
// ===========================================================================

describe('RC-S81 — CTA save-first dipertahankan', () => {
  const layar = tanpaKomentar(baca('src/screens/Akuntansi/RekonsiliasiScreen.tsx'));

  it('7/8. navigasi hanya setelah simpan() berhasil', () => {
    expect(layar).toContain('const simpan = async (): Promise<boolean> => {');
    // DIPERBARUI (perbaikan UI rekonsiliasi pasca RC-S81): tombol utama kini
    // hanya menyimpan; berpindah layar menjadi PINTASAN yang dirender HANYA
    // di kartu hasil (`hasilTerakhir`), dan kartu itu baru ada setelah
    // simpan() berhasil. Invariant yang dijaga tetap sama: tidak ada
    // navigasi sebelum temuan tersimpan.
    const cta = layar.slice(layar.indexOf('const jalankanCta'), layar.indexOf('const bukaPintasan'));
    expect(cta).toMatch(/if \(cta\.aksi === 'SIMPAN'\) \{\s*void simpan\(\);\s*return;\s*\}/);
    expect(cta).not.toContain('navigation.navigate');
    // navigate hanya di bukaPintasan, dan bukaPintasan hanya dipanggil dari kartu hasil.
    expect((layar.match(/navigation\.navigate\(/g) ?? []).length).toBe(2);
    expect(layar).toMatch(/hasilTerakhir\.pintasan && bukaPintasan\(hasilTerakhir\.pintasan\.tujuan\)/);
    expect((layar.match(/bukaPintasan\(/g) ?? []).length).toBe(1);
    // hasilTerakhir hanya diisi di jalur sukses simpan(), sebelum `return true`.
    expect(layar).toMatch(/setHasilTerakhir\(\{\s*jenis,[\s\S]*?await Promise\.all\(\[loadHistori\(\), muatSaldo\(\)\]\);\s*return true;/);
  });

  it('§7 — tidak ada wording "Saldo Aktual" yang tersisa di alur rekonsiliasi', () => {
    for (const rel of [
      'src/screens/Akuntansi/RekonsiliasiScreen.tsx',
      'src/screens/Transaksi/PenyesuaianScreen.tsx',
      'src/utils/rekonsiliasiForm.ts',
    ]) {
      // Komentar penjelas di helper boleh menyebutnya sebagai istilah
      // LAMA; yang dilarang adalah teks yang dilihat pengguna.
      expect(tanpaKomentar(baca(rel))).not.toMatch(/[Ss]aldo [Aa]ktual/);
    }
  });
});
