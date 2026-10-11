import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

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

import { buatPersonel, setStatusPersonel, listPersonel } from '@/services/KoperasiMasterService';
import {
  catatImbalanKerja,
  bayarImbalanKerja,
  listImbalanKerja,
  getSaldoUtangImbalanKerjaSaatIni,
  periodKeyDariTanggalImbalan,
} from '@/services/ImbalanKerjaService';
import {
  ajukanKeluarAnggota,
  setujuiKeluarAnggota,
  tolakKeluarAnggota,
  bayarKeluarAnggota,
  listKeluarAnggota,
  previewKeluarAnggota,
} from '@/services/KeluarAnggotaService';

/**
 * FASE 8 FINAL — UI IMBALAN KERJA & KELUAR ANGGOTA.
 *
 * DUA JENIS PEMBUKTIAN, dibedakan dengan jujur:
 *
 *  1. DATABASE VERIFIED — setiap operasi yang dipicu layar dijalankan
 *     lewat service yang sama yang dipanggil layar, di atas SQLite
 *     sungguhan dengan skema produksi dan jurnal AccountingEngine asli.
 *
 *  2. STATIC/UI VERIFIED — pembacaan source untuk hal yang hanya hidup
 *     di lapisan React: nominal read-only, refresh dari database,
 *     tombol nonaktif saat menyimpan, aksi mengikuti status database,
 *     tidak ada SQL/jurnal di layar.
 *
 * RENDER VERIFIED = NOT VERIFIED. `jest.config.js` memakai
 * `testMatch: *.test.ts` dengan `testEnvironment: 'node'` dan tanpa
 * transformer JSX, sehingga komponen `.tsx` tidak dapat dimount di
 * sini. Itu batas lingkungan, bukan klaim.
 */

const LAYAR_IMBALAN = 'src/screens/Transaksi/ImbalanKerjaFormScreen.tsx';
const LAYAR_KELUAR = 'src/screens/Transaksi/KeluarAnggotaFormScreen.tsx';
// DIPERBARUI RESTRUKTURISASI HUB KELUAR ANGGOTA: layar keluar anggota
// dipecah menjadi hub / pengajuan / daftar. Daftar pengajuan beserta aksi
// Setujui/Tolak/Bayar dan pemilih Sumber Pembayaran PINDAH ke berkas ini.
// Maksud asersi di bawah tidak berubah — hanya berkas tempatnya diperiksa.
const LAYAR_DAFTAR_KELUAR = 'src/screens/Transaksi/DaftarKeluarAnggotaScreen.tsx';
// DIPERBARUI RC-S75: aksi Setujui/Tolak/Bayar dan pemilih Sumber Pembayaran
// pindah lagi — dari kartu daftar ke layar DETAIL satu pengajuan. Daftar kini
// murni monitoring + navigasi. Maksud asersi tetap sama; hanya berkasnya.
const LAYAR_DETAIL_KELUAR = 'src/screens/Transaksi/KeluarAnggotaDetailScreen.tsx';

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

function tanpaKomentar(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutang: 'acc-piutang',
  pokok: 'acc-pokok',
  wajib: 'acc-wajib',
  sukarela: 'acc-sukarela',
  utangImbalan: 'acc-2-1600',
  bebanImbalan: 'acc-5-1050',
  modal: 'acc-modal',
};

async function seedAccount(id: string, kode: string, nama: string, kat: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kat, nb, now, now
  );
}

async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function seedFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(ACC.pokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.wajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(ACC.sukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.utangImbalan, '2-1600', 'Utang Imbalan Kerja', 'LIABILITAS', 'KREDIT');
  await seedAccount(ACC.bebanImbalan, '5-1050', 'Beban Imbalan Kerja', 'BEBAN', 'DEBIT');
  await seedAccount(ACC.modal, '3-9000', 'Modal Awal', 'EKUITAS', 'KREDIT');

  await seedMapping('KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping('UTANG_IMBALAN_KERJA', 'DEBIT_BEBAN', ACC.bebanImbalan);
  await seedMapping('UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT', ACC.utangImbalan);
  await seedMapping('SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.pokok);
  await seedMapping('SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.wajib);
  await seedMapping('SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await seedMapping('PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);

  for (const th of [2025, 2026, 2027]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES ('bank-1','Bank A','123','Koperasi',?,1,?)`,
    ACC.bank, now
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-A','A001','1111111111111111','Anggota A','2020-01-01','AKTIF',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-modal','JRN-MODAL','2025-01-01','p2025','MODAL_AWAL','Modal awal','POSTED','user-1',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm1','j-modal',?,400000000,0)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm2','j-modal',?,100000000,0)`,
    ACC.bank
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('jm3','j-modal',?,0,500000000)`,
    ACC.modal
  );
}

async function snapshotAkuntansi(): Promise<Record<string, number>> {
  const j = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal`);
  const je = await testDb.getFirstAsync<{ n: number; d: number; k: number }>(
    `SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(kredit),0) k FROM journal_entry`
  );
  return {
    jurnal: j?.n ?? 0,
    entri: je?.n ?? 0,
    debit: je?.d ?? 0,
    kredit: je?.k ?? 0,
  };
}

async function setorSimpanan(jenis: string, nominal: number, id: string): Promise<void> {
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?, 'anggota-A', ?, 'SETOR', '2026-01-10', ?, 'KAS', ?, 'user-1', ?)`,
    id, jenis, nominal, id.toUpperCase(), new Date().toISOString()
  );
}

beforeEach(async () => {
  await seedFixture();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// IMBALAN KERJA — alur layar
// ===========================================================================

describe('§33 UI Imbalan Kerja — DATABASE VERIFIED', () => {
  async function personelAktif(): Promise<string> {
    return buatPersonel({ nama: 'Siti', jenisPersonel: 'PENGURUS', jabatan: 'Bendahara' });
  }

  const DASAR = {
    periodKey: '2026-09',
    jenisImbalan: 'HONORARIUM' as const,
    dasarPerhitungan: 5_000_000,
    nilaiImbalan: 1_000_000,
    tanggalPengakuan: '2026-09-30',
    tanggalJatuhTempo: '2026-10-05',
    createdBy: 'user-1',
  };

  it('1. layar memuat personel AKTIF saja untuk picker penerima', async () => {
    const aktif = await personelAktif();
    const nonaktif = await buatPersonel({ nama: 'Budi', jenisPersonel: 'KARYAWAN', jabatan: 'Staf' });
    await setStatusPersonel(nonaktif, false);

    const kandidat = await listPersonel({ hanyaAktif: true });
    expect(kandidat.map((p) => p.id)).toContain(aktif);
    expect(kandidat.map((p) => p.id)).not.toContain(nonaktif);
  });

  it('2-4. penerima dipilih -> jenis personel & jabatan dari database', async () => {
    const id = await personelAktif();
    const p = (await listPersonel({ hanyaAktif: true })).find((x) => x.id === id);
    // Inilah yang ditampilkan layar di kolom read-only.
    expect(p?.jenisPersonel).toBe('PENGURUS');
    expect(p?.jabatan).toBe('Bendahara');

    const hasil = await catatImbalanKerja({ ...DASAR, personelId: id });
    // Dan inilah yang BENAR-BENAR disimpan service — bukan string UI.
    expect(hasil.jenisPersonel).toBe('PENGURUS');
    expect(hasil.jabatan).toBe('Bendahara');
  });

  it('5-7. create menghasilkan jurnal Dr 5-1050 / Cr 2-1600 & status POSTED', async () => {
    const id = await personelAktif();
    const hasil = await catatImbalanKerja({ ...DASAR, personelId: id });

    expect(hasil.status).toBe('POSTED');
    expect(hasil.journalId).not.toBeNull();
    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    expect(baris.find((b) => b.account_id === ACC.bebanImbalan)?.debit).toBe(1_000_000);
    expect(baris.find((b) => b.account_id === ACC.utangImbalan)?.kredit).toBe(1_000_000);
    expect(baris.reduce((t, b) => t + b.debit, 0)).toBe(baris.reduce((t, b) => t + b.kredit, 0));
  });

  it('8. double submit -> satu transaksi, satu jurnal', async () => {
    const id = await personelAktif();
    await catatImbalanKerja({ ...DASAR, personelId: id });
    await expect(catatImbalanKerja({ ...DASAR, personelId: id })).rejects.toThrow(
      /sudah pernah dibukukan/
    );
    expect(await listImbalanKerja()).toHaveLength(1);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'UTANG_IMBALAN_KERJA'`
    );
    expect(n?.n).toBe(1);
  });

  it('9/12. list & reload membaca ulang dari database', async () => {
    const id = await personelAktif();
    await catatImbalanKerja({ ...DASAR, personelId: id });
    const daftar = await listImbalanKerja();
    expect(daftar).toHaveLength(1);
    expect(daftar[0].namaPenerima).toBe('Siti');
    expect(daftar[0].status).toBe('POSTED');
    // Saldo kartu atas layar juga dari ledger, bukan dijumlahkan UI.
    expect(await getSaldoUtangImbalanKerjaSaatIni()).toBe(1_000_000);
  });

  it('10. bayar KAS -> status PAID, utang nol, beban tidak bertambah', async () => {
    const id = await personelAktif();
    const imb = await catatImbalanKerja({ ...DASAR, personelId: id });
    await bayarImbalanKerja({
      imbalanId: imb.id,
      tanggal: '2026-10-05',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const daftar = await listImbalanKerja();
    expect(daftar[0].status).toBe('PAID');
    expect(daftar[0].journalBayarId).not.toBeNull();
    expect(await getSaldoUtangImbalanKerjaSaatIni()).toBe(0);
  });

  it('10b. bayar BANK memakai akun bank, bukan kas', async () => {
    const id = await personelAktif();
    const imb = await catatImbalanKerja({ ...DASAR, personelId: id });
    await bayarImbalanKerja({
      imbalanId: imb.id,
      tanggal: '2026-10-05',
      sumberDana: 'BANK',
      bankAccountId: 'bank-1',
      createdBy: 'user-1',
    });
    const j = (await listImbalanKerja())[0].journalBayarId as string;
    const kredit = await testDb.getAllAsync<{ account_id: string }>(
      `SELECT account_id FROM journal_entry WHERE journal_id = ? AND kredit > 0`,
      j
    );
    expect(kredit.map((k) => k.account_id)).toContain(ACC.bank);
    expect(kredit.map((k) => k.account_id)).not.toContain(ACC.kas);
  });

  it('11. pembayaran kedua ditolak SERVICE, bukan sekadar tombol disembunyikan', async () => {
    const id = await personelAktif();
    const imb = await catatImbalanKerja({ ...DASAR, personelId: id });
    await bayarImbalanKerja({ imbalanId: imb.id, tanggal: '2026-10-05', sumberDana: 'KAS', createdBy: 'user-1' });
    await expect(
      bayarImbalanKerja({ imbalanId: imb.id, tanggal: '2026-10-06', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah dibayar/);
  });

  it('13. periode CLOSED ditolak', async () => {
    const id = await personelAktif();
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);
    await expect(catatImbalanKerja({ ...DASAR, personelId: id })).rejects.toThrow(/ditutup|CLOSED/i);
  });

  it('14. personel nonaktif ditolak', async () => {
    const id = await personelAktif();
    await setStatusPersonel(id, false);
    await expect(catatImbalanKerja({ ...DASAR, personelId: id })).rejects.toThrow(/nonaktif/);
  });

  it('15. membuka layar (membaca daftar) TIDAK mengubah akuntansi', async () => {
    const id = await personelAktif();
    await catatImbalanKerja({ ...DASAR, personelId: id });
    const sebelum = await snapshotAkuntansi();

    await listImbalanKerja();
    await listPersonel({ hanyaAktif: true });
    await getSaldoUtangImbalanKerjaSaatIni();

    expect(await snapshotAkuntansi()).toEqual(sebelum);
  });

  it('periode diturunkan dari tanggal pengakuan', () => {
    expect(periodKeyDariTanggalImbalan('2026-09-30')).toBe('2026-09');
  });
});

// ===========================================================================
// KELUAR ANGGOTA — alur layar
// ===========================================================================

describe('§34 UI Keluar Anggota — DATABASE VERIFIED', () => {
  async function isiSimpanan() {
    await setorSimpanan('POKOK', 100_000, 'sp1');
    await setorSimpanan('WAJIB', 600_000, 'sw1');
    await setorSimpanan('SUKARELA', 300_000, 'ss1');
  }

  async function ajukan() {
    return ajukanKeluarAnggota({
      anggotaId: 'anggota-A',
      alasanKeluar: 'MENGUNDURKAN_DIRI',
      tanggalPengajuan: '2026-06-01',
      tanggalEfektifKeluar: '2026-06-30',
      createdBy: 'user-1',
    });
  }

  it('2-9. ringkasan hak & pengurang dari service, bukan hitungan layar', async () => {
    await isiSimpanan();
    const p = await previewKeluarAnggota('anggota-A');
    expect(p.saldoSimpananPokok).toBe(100_000);
    expect(p.saldoSimpananWajib).toBe(600_000);
    expect(p.saldoSimpananSukarela).toBe(300_000);
    expect(p.shuHakAnggota).toBe(0);
    expect(p.totalHak).toBe(1_000_000);
    expect(p.totalPengurang).toBe(0);
    expect(p.nilaiPengembalian).toBe(1_000_000);
  });

  it('10. ajukan -> DIAJUKAN; status anggota belum berubah', async () => {
    await isiSimpanan();
    const p = await ajukan();
    expect(p.statusPengajuan).toBe('DIAJUKAN');
    const a = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM anggota WHERE id='anggota-A'`);
    expect(a?.status).toBe('AKTIF');
  });

  it('11-12. setujui & tolak mengikuti alur', async () => {
    await isiSimpanan();
    const p = await ajukan();
    const s = await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    expect(s.statusPengajuan).toBe('DISETUJUI');
    expect(s.disetujuiOleh).toBe('user-1');

    const p2 = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM keluar_anggota`);
    expect(p2?.id).toBe(p.id);
  });

  it('12b. tolak -> DITOLAK dan tidak dapat dibayar', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await tolakKeluarAnggota(p.id, 'user-1');
    expect((await listKeluarAnggota())[0].statusPengajuan).toBe('DITOLAK');
    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/DISETUJUI/);
  });

  it('15. pembayaran sebelum persetujuan ditolak', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/DISETUJUI/);
  });

  it('13-14. pembayaran KAS & BANK; nominal = nilai pengembalian', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    const hasil = await bayarKeluarAnggota({
      id: p.id,
      tanggal: '2026-06-30',
      sumberDana: 'BANK',
      bankAccountId: 'bank-1',
      createdBy: 'user-1',
    });
    expect(hasil.nilaiPengembalian).toBe(p.nilaiPengembalian);
    const kredit = await testDb.getAllAsync<{ account_id: string; kredit: number }>(
      `SELECT account_id, kredit FROM journal_entry WHERE journal_id = ? AND kredit > 0`,
      hasil.journalId
    );
    expect(kredit.map((k) => k.account_id)).toContain(ACC.bank);
  });

  it('16. duplicate payment ditolak — satu jurnal', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    await bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' });
    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-07-01', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah dibayar/);
    const n = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'KELUAR_ANGGOTA'`
    );
    expect(n?.n).toBe(1);
  });

  it('17. saldo berubah setelah persetujuan -> pembayaran ditolak dengan pesan jelas', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    await setorSimpanan('SUKARELA', 400_000, 'ss9');

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/berubah setelah pengajuan disetujui/);
  });

  it('18. rollback — kegagalan tidak meninggalkan jejak', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type='KAS_UMUM'`);

    await expect(
      bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow();
    expect((await listKeluarAnggota())[0].statusPengajuan).toBe('DISETUJUI');
    const a = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM anggota WHERE id='anggota-A'`);
    expect(a?.status).toBe('AKTIF');
  });

  it('19-20. reload & histori tetap terbaca setelah dibayar', async () => {
    await isiSimpanan();
    const p = await ajukan();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');
    await bayarKeluarAnggota({ id: p.id, tanggal: '2026-06-30', sumberDana: 'KAS', createdBy: 'user-1' });

    const daftar = await listKeluarAnggota();
    expect(daftar[0].statusPengajuan).toBe('DIBAYAR');
    expect(daftar[0].journalId).not.toBeNull();
    expect(daftar[0].tanggalPembayaran).toBe('2026-06-30');

    const anggota = await testDb.getFirstAsync(`SELECT id FROM anggota WHERE id='anggota-A'`);
    expect(anggota).not.toBeNull();
    const simpanan = await testDb.getAllAsync(`SELECT id FROM simpanan_transaksi WHERE anggota_id='anggota-A'`);
    expect(simpanan.length).toBeGreaterThan(0);
    expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
  });

  it('§30 — membuka form/list TIDAK mengubah akuntansi; approve juga tidak', async () => {
    await isiSimpanan();
    const p = await ajukan();
    const sebelum = await snapshotAkuntansi();

    await previewKeluarAnggota('anggota-A');
    await listKeluarAnggota();
    await setujuiKeluarAnggota(p.id, 'user-1', '2026-06-10');

    // Persetujuan TIDAK boleh membuat jurnal apa pun.
    expect(await snapshotAkuntansi()).toEqual(sebelum);
  });
});

// ===========================================================================
// STATIC/UI VERIFIED
// ===========================================================================

describe('Fase 8 — STATIC/UI VERIFIED', () => {
  const imbalan = tanpaKomentar(baca(LAYAR_IMBALAN));
  const keluar = tanpaKomentar(baca(LAYAR_KELUAR));
  const daftarKeluar = tanpaKomentar(baca(LAYAR_DAFTAR_KELUAR));
  const detailKeluar = tanpaKomentar(baca(LAYAR_DETAIL_KELUAR));

  it('§6/§24 — tidak ada SQL maupun jurnal di layar', () => {
    for (const src of [imbalan, keluar, daftarKeluar, detailKeluar]) {
      for (const terlarang of ['INSERT INTO', 'SELECT ', 'UPDATE ', 'createJournal', 'getDb(', 'withTransaction(']) {
        expect(src).not.toContain(terlarang);
      }
    }
  });

  it('§3 — penerima imbalan dari KoperasiMasterService, bukan AnggotaPicker', () => {
    expect(imbalan).toMatch(/from '@\/services\/KoperasiMasterService'/);
    expect(imbalan).toMatch(/listPersonel\(\{ hanyaAktif: true \}\)/);
    expect(imbalan).not.toMatch(/AnggotaPicker/);
  });

  it('§4 — jenis personel & jabatan READ-ONLY di layar imbalan', () => {
    expect(imbalan).toMatch(/Jenis Personel<\/Text>[\s\S]{0,200}readonlyBox/);
    expect(imbalan).toMatch(/Jabatan<\/Text>[\s\S]{0,200}readonlyBox/);
    // Tidak ada input teks yang menulis jenis/jabatan.
    expect(imbalan).not.toMatch(/setJenisPersonel|setJabatan/);
  });

  it('§6 — SIMPAN & JURNAL memanggil catatImbalanKerja', () => {
    expect(imbalan).toMatch(/await catatImbalanKerja\(\{/);
    expect(imbalan).toMatch(/SIMPAN &amp; JURNAL/);
  });

  it('§7 — tombol dinonaktifkan selama menyimpan', () => {
    expect(imbalan).toMatch(/disabled=\{submitting\}/);
    expect(keluar).toMatch(/disabled=\{sibuk === 'ajukan'\}/);
  });

  it('§8 — umpan balik memuat nominal, penerima, periode, status, journal id', () => {
    expect(imbalan).toMatch(/hasil\.namaPenerima/);
    expect(imbalan).toMatch(/labelPeriode\(hasil\.periodKey\)/);
    expect(imbalan).toMatch(/formatRupiah\(hasil\.nilaiImbalan\)/);
    // DIPERBARUI (perbaikan UI/UX Imbalan Kerja, permintaan pengguna): status
    // kini berlabel manusia ("Belum Dibayar") dan UUID jurnal tidak lagi
    // ditampilkan. Ringkasan TETAP dibaca dari hasil nyata service.
    expect(imbalan).toMatch(/Status \$\{labelStatusImbalan\(hasil\.status\)\}/);
    expect(imbalan).toMatch(/jurnal pengakuan tercatat/);
    expect(imbalan).not.toMatch(/\$\{hasil\.journalId\}/);
  });

  it('§10 — tombol Bayar hanya muncul saat POSTED', () => {
    expect(imbalan).toMatch(/row\.status === 'POSTED' &&[\s\S]{0,200}tombolBayar/);
  });

  it('§14/§15 — seluruh nominal keluar anggota READ-ONLY dari service', () => {
    expect(keluar).toMatch(/previewKeluarAnggota\(anggota\.id\)/);
    expect(keluar).toMatch(/function Baris\(/);
    // Tidak ada CurrencyInput untuk saldo di layar keluar anggota.
    expect(keluar).not.toMatch(/CurrencyInput/);
    // Tidak ada penjumlahan sendiri.
    expect(keluar).not.toMatch(/totalHak =|nilaiPengembalian =/);
  });

  it('§18/§19/§20 — aksi mengikuti status dari database (kini di layar Detail Pengajuan)', () => {
    expect(detailKeluar).toMatch(/row\.statusPengajuan === 'DIAJUKAN' &&/);
    expect(detailKeluar).toMatch(/row\.statusPengajuan === 'DISETUJUI' &&/);
    expect(detailKeluar).toMatch(/setujuiKeluarAnggota\(/);
    expect(detailKeluar).toMatch(/tolakKeluarAnggota\(/);
    expect(detailKeluar).toMatch(/bayarKeluarAnggota\(/);
    // Tidak ada jalan pintas DIAJUKAN -> DIBAYAR di layar.
    expect(detailKeluar).not.toMatch(/statusPengajuan === 'DIAJUKAN'[\s\S]{0,200}bayarKeluarAnggota/);
    // Form pengajuan dan daftar TIDAK memegang satu pun aksi mutasi.
    for (const terlarang of ['setujuiKeluarAnggota', 'tolakKeluarAnggota', 'bayarKeluarAnggota']) {
      expect(keluar).not.toContain(terlarang);
      expect(daftarKeluar).not.toContain(terlarang);
    }
    expect(keluar).not.toContain('listKeluarAnggota');
  });

  it('§23 — layar tidak mengubah status anggota sendiri', () => {
    expect(keluar).not.toMatch(/status = 'KELUAR'|setStatusAnggota/);
    expect(daftarKeluar).not.toMatch(/status = 'KELUAR'|setStatusAnggota/);
    expect(detailKeluar).not.toMatch(/status = 'KELUAR'|setStatusAnggota/);
  });

  it('§21 — picker BANK hanya menampilkan rekening bank', () => {
    // Pemilih rekening ikut pindah bersama tombol Bayar — kini di Detail.
    for (const src of [imbalan, detailKeluar]) {
      expect(src).toMatch(/<RekeningPicker[\s\S]{0,200}hanyaBank/);
    }
    for (const src of [keluar, daftarKeluar]) {
      expect(src).not.toMatch(/RekeningPicker/);
    }
  });

  it('§25 — setiap aksi diikuti muat ulang dari database', () => {
    expect((imbalan.match(/await muat\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Ketiga aksi kini di layar Detail; satu helper `jalankanMutasi`
    // memanggil `muat()` setelah SETIAP mutasi berhasil.
    expect(detailKeluar).toMatch(/await kerja\(\);\s*await muat\(\);/);
    for (const src of [imbalan, daftarKeluar, detailKeluar]) {
      expect(src).not.toMatch(/setDaftar\(\[\.\.\.daftar/);
    }
  });

  it('§27 — loading, empty, dan error state ada di kedua layar', () => {
    expect(imbalan).toContain('Data imbalan kerja gagal dimuat.');
    expect(imbalan).toContain('Belum ada imbalan kerja yang dicatat.');
    // Loading/empty/error daftar keluar anggota kini milik layar daftar.
    expect(daftarKeluar).toContain('Pengajuan keluar anggota gagal dimuat.');
    expect(daftarKeluar).toContain('Belum ada pengajuan keluar anggota');
    for (const src of [imbalan, keluar, daftarKeluar, detailKeluar]) {
      expect(src).toMatch(/ActivityIndicator/);
      expect(src).not.toMatch(/catch \([^)]*\) \{\s*\}/);
    }
  });

  it('§28 — pesan sukses hanya setelah service berhasil', () => {
    expect(imbalan).toMatch(/await catatImbalanKerja\([\s\S]{0,900}Imbalan kerja berhasil dicatat\./);
    expect(keluar).toMatch(/await ajukanKeluarAnggota\([\s\S]{0,600}Pengajuan keluar anggota berhasil dibuat\./);
    expect(detailKeluar).toMatch(/await bayarKeluarAnggota\([\s\S]{0,600}Pembayaran berhasil\./);
  });

  it('§29 — tanggal memakai helper existing, bukan new Date() tersebar', () => {
    // Daftar kini tidak lagi menulis tanggal apa pun (tanpa mutasi).
    for (const src of [imbalan, keluar, detailKeluar]) {
      expect(src).toMatch(/getTanggalLokalHariIni\(\)/);
      expect(src).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice/);
    }
  });

  it('§13/§1 — layar existing diperbaiki, bukan layar kedua', () => {
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    expect((nav.match(/name="ImbalanKerjaForm"/g) ?? [])).toHaveLength(1);
    expect((nav.match(/name="KeluarAnggotaForm"/g) ?? [])).toHaveLength(1);
    expect(nav).not.toMatch(/ImbalanKerjaFormV2|KeluarAnggotaFormV2/);
  });

  it('§37 — UI Fase 8 sendiri tidak menambah migration di atas v61', () => {
    // Bentuk semula memakukan angkanya pada 61 dan melarang blok v62
    // mana pun. Itu memutus fase berikutnya yang memang membutuhkan
    // tabel baru, padahal UI Fase 8 tetap tidak menyumbang skema
    // apa pun. Yang diuji sekarang maksudnya: v61 tetap terpasang, dan
    // kedua tabel Fase 8 dibuat di dalam blok v61 — bukan di blok lain.
    const schema = baca('src/database/schema.ts');
    const cocok = schema.match(/export const SCHEMA_VERSION = (\d+);/);
    expect(Number(cocok![1])).toBeGreaterThanOrEqual(61);

    const db = baca('src/database/db.ts');
    const awal = db.indexOf('export async function migrasiV61');
    const akhir = db.indexOf('export async function migrasiV62');
    const blok = db.slice(awal, akhir > awal ? akhir : undefined);
    expect(blok).toContain('imbalan_kerja');
    expect(blok).toContain('keluar_anggota');
  });
});
