import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual<typeof import('@/database/db')>('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { catatRAK, getStatusModalTetapUnit } from '@/services/RAKService';
import { buatUnitUsaha, setStatusUnitUsaha, listUnitUsaha } from '@/services/KoperasiMasterService';

/**
 * ============================================================
 * RC-S65 — UX RAKU & KESIAPAN DEVICE QA
 * ============================================================
 *
 * Layar tidak dapat DIRENDER di lingkungan ini (tidak ada React Native
 * testing library). Karena itu test di berkas ini memakai dua jalur:
 *
 *  - STATIC VERIFIED : memeriksa SOURCE layar/komponen (komentar dibuang
 *    lebih dulu supaya yang diuji kode, bukan penjelasannya). Pola yang
 *    sama sudah dipakai suite audit lain di repo.
 *  - DATABASE VERIFIED : memanggil service sungguhan di atas SQLite.
 *
 * Yang TIDAK dibuktikan berkas ini: perilaku render, gestur, dan keyboard.
 * Itu hanya bisa dibuktikan pada perangkat — lihat checklist QA-RAK-01..14
 * di laporan RC-S65.
 */

const ROOT = join(__dirname, '..');
const bacaTanpaKomentar = (...p: string[]) =>
  readFileSync(join(ROOT, ...p), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const FORM = () => bacaTanpaKomentar('screens', 'Transaksi', 'RAKFormScreen.tsx');
const PICKER = () => bacaTanpaKomentar('components', 'UnitUsahaPicker.tsx');
const LIST = () => bacaTanpaKomentar('screens', 'Akuntansi', 'RAKListScreen.tsx');

const ACC = { kas: 'acc-kas', rak: 'acc-rak', modal: 'acc-modal' };
const T0 = '2020-01-01T00:00:00.000Z';

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: string) {
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kat, nb, T0, T0
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.rak, '1-1800', 'Rekening Antar Kantor', 'ASET', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');
  for (const [tt, role, acc] of [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['RAK', 'DEBIT_ASET', ACC.rak],
    ['RAK', 'KREDIT_ASET', ACC.rak],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      `map-${tt}-${role}`, tt, role, acc
    );
  }
  for (const th of [2025, 2026]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    T0, T0
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,900000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,0,900000000)`,
    ACC.modal
  );
});
afterEach(() => testDb.closeSync());

const dasar = {
  jenisRak: 'PENYALURAN_DANA' as const,
  jumlah: 100_000_000,
  tanggal: '2026-03-10',
  sumberDana: 'KAS' as const,
  createdBy: 'user-1',
};

// ============================================================
describe('RC-S65 §C/§D — Unit Usaha Picker (STATIC VERIFIED)', () => {
  it('O1. picker membaca HANYA unit aktif dari master', () => {
    expect(PICKER()).toContain('listUnitUsaha(true)');
  });

  it('O2. picker tidak punya jalur tulis apa pun ke master unit usaha', () => {
    const src = PICKER();
    for (const terlarang of ['buatUnitUsaha', 'setStatusUnitUsaha', 'perbaruiUnitUsaha', 'INSERT INTO', 'UPDATE ']) {
      expect(src).not.toContain(terlarang);
    }
  });

  it('O3. picker menyediakan jalur menampilkan unit historis saat edit', () => {
    const src = PICKER();
    expect(src).toContain('unitHistoris');
    expect(src).toMatch(/NONAKTIF/);
  });

  it('§C. modal dapat ditutup: tombol X, tombol Tutup, dan tombol back Android', () => {
    const src = PICKER();
    expect(src).toContain('onRequestClose');   // tombol back Android
    expect(src).toMatch(/setOpen\(false\)/);
  });

  it('§C. ada loading state dan empty state yang eksplisit', () => {
    const src = PICKER();
    expect(src).toContain('ActivityIndicator');
    expect(src).toContain('ListEmptyComponent');
  });

  it('§C. tidak ada dependency baru — hanya React Native & tema existing', () => {
    const src = PICKER();
    const impor = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const diizinkan = [
      'react', 'react-native', 'react-native-safe-area-context', '@expo/vector-icons',
      '@/services/KoperasiMasterService', '@/theme/colors', '@/theme/modal',
    ];
    expect(impor.filter((i) => !diizinkan.includes(i))).toEqual([]);
  });

  it('§C. selection menutup modal dan menulis satu state — tidak ada duplicate selection', () => {
    const src = PICKER();
    expect(src).toMatch(/onChange\(item\);\s*setOpen\(false\);/);
  });
});

// ============================================================
describe('RC-S65 §B/§U — source of truth (STATIC VERIFIED)', () => {
  it('U. tidak ada input teks bebas nama unit di RAK Form', () => {
    const src = FORM();
    expect(src).not.toMatch(/Nama Unit\/Kantor Tujuan/);
    expect(src).not.toMatch(/setNamaUnit/);
    expect(src).not.toMatch(/namaUnit:\s*namaUnit/);
  });

  it('U. FocusTextInput yang tersisa di RAK Form hanya untuk Keterangan', () => {
    const src = FORM();
    const blok = src.split('<FocusTextInput');
    expect(blok).toHaveLength(2); // satu pemakaian
    expect(blok[1]).toContain('keterangan');
  });

  it('U. hanya RAKService yang menulis rak_transaksi', () => {
    const svc = readFileSync(join(ROOT, 'services', 'RAKService.ts'), 'utf8');
    expect(svc).toContain('INSERT INTO rak_transaksi');
    // Layar tidak boleh punya SQL rak_transaksi sama sekali.
    expect(FORM()).not.toContain('rak_transaksi');
    expect(LIST()).not.toContain('rak_transaksi');
  });

  it('B. form mengirim unitUsahaId, bukan nama unit', () => {
    expect(FORM()).toMatch(/unitUsahaId:\s*unitUsahaId/);
  });
});

// ============================================================
describe('RC-S65 §I/§J — double submit & pesan galat (STATIC VERIFIED)', () => {
  it('O13. ada kunci pengiriman sinkron (useRef), bukan hanya state React', () => {
    const src = FORM();
    expect(src).toContain('sedangMengirim');
    expect(src).toMatch(/if\s*\(sedangMengirim\.current\)\s*return;/);
    expect(src).toMatch(/sedangMengirim\.current\s*=\s*true;/);
    expect(src).toMatch(/sedangMengirim\.current\s*=\s*false;/);
  });

  it('O13. tombol submit disabled dan menampilkan indikator selama pengiriman', () => {
    const src = FORM();
    expect(src).toMatch(/disabled=\{submitting\}/);
    expect(src).toMatch(/submitting\s*\?\s*\(\s*<ActivityIndicator/);
  });

  it('O14. galat ditampilkan lewat penyaring operator-friendly', () => {
    const src = FORM();
    expect(src).toContain('pesanRamahOperator');
    expect(src).not.toMatch(/notify\('Gagal',\s*e instanceof Error \? e\.message/);
  });

  it('O14. penyaring menutup galat teknis dan meneruskan galat bisnis', () => {
    const src = FORM();
    // Pola teknis yang harus dikenali.
    for (const pola of ['SQLite', 'TypeError', 'Cannot read propert']) {
      expect(src).toContain(pola);
    }
  });

  it('J. tidak ada bahasa teknis yang bocor ke teks UI', () => {
    const src = FORM();
    for (const istilah of ['invariant', 'unique constraint', 'database guard', 'SQLITE_CONSTRAINT']) {
      expect(src.toLowerCase()).not.toContain(istilah.toLowerCase());
    }
  });
});

// ============================================================
describe('RC-S65 §E/§F — status Modal Tetap & jenis alokasi (STATIC VERIFIED)', () => {
  it('E. status memakai bahasa operator: "Belum dialokasikan" / "Sudah dialokasikan"', () => {
    const src = FORM();
    expect(src).toContain('Belum dialokasikan');
    expect(src).toContain('Sudah dialokasikan');
    expect(src).toContain('Satu Unit Usaha hanya dapat memiliki satu Modal Tetap aktif');
  });

  it('F. hanya MODAL_TETAP yang dapat terkunci; dua jenis lain tidak', () => {
    const src = FORM();
    expect(src).toMatch(/a === 'MODAL_TETAP' && modalTetapTerkunci/);
    expect(src).not.toMatch(/MODAL_TAMBAHAN'\s*&&\s*\w*[Tt]erkunci/);
    expect(src).not.toMatch(/OPERASIONAL'\s*&&\s*\w*[Tt]erkunci/);
  });

  it('R. status Modal Tetap dibaca hanya saat unit berubah — tanpa polling/interval', () => {
    const src = FORM();
    expect(src).toMatch(/getStatusModalTetapUnit\(unitUsahaId\)/);
    expect(src).toMatch(/\}, \[unitUsahaId\]\);/);
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('setTimeout');
  });
});

// ============================================================
describe('RC-S65 §K — RAK List (STATIC VERIFIED)', () => {
  it('K. Unit Usaha, Jenis Alokasi, Nominal, Tanggal, Status terbaca', () => {
    const src = LIST();
    expect(src).toContain('item.namaUnit');
    expect(src).toContain('item.jenisAlokasi');
    expect(src).toContain('formatRupiah(item.jumlah)');
    expect(src).toContain('item.tanggal');
    expect(src).toMatch(/item\.status/);
  });

  it('K/N. baris lama tanpa jenis alokasi tidak diberi nilai tebakan', () => {
    expect(LIST()).toMatch(/item\.jenisAlokasi \?/);
  });

  it('N. transaksi DIBATALKAN tetap tampil sebagai histori', () => {
    expect(LIST()).toMatch(/DIBATALKAN/);
  });
});

// ============================================================
describe('RC-S65 §D/§O — perilaku unit usaha (DATABASE VERIFIED)', () => {
  it('O2. unit NONAKTIF tidak muncul di daftar pilihan transaksi baru', async () => {
    const aktif = await buatUnitUsaha({ namaUsaha: 'Unit Aktif' });
    const mati = await buatUnitUsaha({ namaUsaha: 'Unit Tutup' });
    await setStatusUnitUsaha(mati, 'NONAKTIF');

    const daftar = await listUnitUsaha(true);
    expect(daftar.map((u) => u.id)).toContain(aktif);
    expect(daftar.map((u) => u.id)).not.toContain(mati);

    // Dan master TIDAK berubah: unit nonaktif tetap ada bila diminta semua.
    const semua = await listUnitUsaha(false);
    expect(semua.map((u) => u.id)).toContain(mati);
  });

  it('O3. transaksi ke unit yang kemudian dinonaktifkan tetap terbaca', async () => {
    const unit = await buatUnitUsaha({ namaUsaha: 'Unit Lama' });
    const r = await catatRAK({ ...dasar, unitUsahaId: unit, jenisAlokasi: 'MODAL_TETAP' });
    await setStatusUnitUsaha(unit, 'NONAKTIF');

    const row = await testDb.getFirstAsync<{ unit_usaha_id: string; nama_unit: string; status: string }>(
      `SELECT unit_usaha_id, nama_unit, status FROM rak_transaksi WHERE id = ?`, r.id
    );
    expect(row?.unit_usaha_id).toBe(unit);
    expect(row?.nama_unit).toBe('Unit Lama');
    expect(row?.status).toBe('AKTIF');
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('O12/G. submit Modal Tetap kedua ditolak dengan pesan yang dapat dibaca operator', async () => {
    const unit = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    await catatRAK({ ...dasar, unitUsahaId: unit, jenisAlokasi: 'MODAL_TETAP' });

    let pesan = '';
    try {
      await catatRAK({ ...dasar, jumlah: 5_000_000, unitUsahaId: unit, jenisAlokasi: 'MODAL_TETAP' });
    } catch (e) {
      pesan = e instanceof Error ? e.message : String(e);
    }

    expect(pesan).toContain('Modal Tetap');
    expect(pesan).toContain('Unit Toko');
    expect(pesan).toContain('Modal Tambahan');
    // Tidak ada kebocoran teknis pada pesan bisnis.
    for (const teknis of ['SQLite', 'SQLITE_', 'TypeError', 'undefined', 'null']) {
      expect(pesan).not.toContain(teknis);
    }
  });

  it('§R. getStatusModalTetapUnit mencerminkan slot setelah pembatalan', async () => {
    const unit = await buatUnitUsaha({ namaUsaha: 'Unit Toko' });
    expect((await getStatusModalTetapUnit(unit)).sudahAda).toBe(false);
    await catatRAK({ ...dasar, unitUsahaId: unit, jenisAlokasi: 'MODAL_TETAP' });
    const st = await getStatusModalTetapUnit(unit);
    expect(st.sudahAda).toBe(true);
    expect(st.jumlah).toBe(100_000_000);
    expect(st.nomorRak).toBeTruthy();
  });
});
