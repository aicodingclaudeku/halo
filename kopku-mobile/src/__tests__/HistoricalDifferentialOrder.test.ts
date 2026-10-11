import { TestDb } from './testDb';

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

import {
  buatFixtureHistoris,
  ringkasanAkuntansi,
  totalDebitKredit,
  ACC,
  ANGGOTA_ID,
  ANGGOTA_2_ID,
  ANGGOTA_3_ID,
  USER_ID,
  BANK_ID,
} from './historicalFixture';
import { catatPemasukan, catatPengeluaran, transferAntarRekening } from '@/services/KasBankService';
import { setorSimpanan, tarikSimpananSukarela } from '@/services/SimpananService';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { prosesAkrualBungaSemuaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { beliAset } from '@/services/AsetService';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { terimaPendapatanDimuka } from '@/services/PendapatanDimukaService';
import { terimaUtang } from '@/services/UtangService';
import { jalankanPenyusutanCatchUp } from '@/services/PenyusutanService';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import { getPosisiKeuangan, getLabaRugi, getArusKas, getPerubahanEkuitas } from '@/reports/FinancialReports';

/**
 * ============================================================
 * §G/§AH/§AI — URUTAN PENYISIPAN & UJI MASSAL HISTORIS
 * ============================================================
 *
 * Pertanyaan yang dijawab suite ini: apakah HASIL AKUNTANSI bergantung
 * pada URUTAN pencatatan? Dua database dibangun dari transaksi yang
 * SAMA PERSIS (jenis, nominal, tanggal) —
 *
 *   Database A : dimasukkan kronologis (tanggal menaik)
 *   Database B : dimasukkan acak (urutan tetap & sengaja diacak,
 *                supaya test deterministik dan bisa diulang)
 *
 * — lalu keduanya menjalankan penyusutan, akrual, laporan, dan
 * rekonsiliasi. Yang dibandingkan adalah AKIBAT AKUNTANSI (saldo per
 * akun, jurnal per tanggal+sumber, penyusutan per periode), BUKAN id
 * atau nomor urut yang memang tergantung urutan input.
 *
 * §AI meminta minimal 30 transaksi bertanggal acak sepanjang 2026 dari
 * berbagai jenis yang BENAR-BENAR tersedia di source — daftar di bawah
 * berjumlah 33 langkah.
 */

interface Langkah {
  tanggal: string;
  nama: string;
  jalankan: () => Promise<unknown>;
}

function daftarLangkah(): Langkah[] {
  const kas = (tanggal: string, nominal: number, masuk: boolean, nama: string): Langkah => ({
    tanggal,
    nama,
    jalankan: () =>
      masuk
        ? catatPemasukan({
            jenis: 'KAS', tanggal, nominal, akunLawanId: ACC.pendapatanLain,
            keterangan: nama, createdBy: USER_ID,
          })
        : catatPengeluaran({
            jenis: 'KAS', tanggal, nominal, akunLawanId: ACC.bebanLain,
            keterangan: nama, createdBy: USER_ID,
          }),
  });
  const bank = (tanggal: string, nominal: number, masuk: boolean, nama: string): Langkah => ({
    tanggal,
    nama,
    jalankan: () =>
      masuk
        ? catatPemasukan({
            jenis: 'BANK', bankAccountId: BANK_ID, tanggal, nominal,
            akunLawanId: ACC.pendapatanLain, keterangan: nama, createdBy: USER_ID,
          })
        : catatPengeluaran({
            jenis: 'BANK', bankAccountId: BANK_ID, tanggal, nominal,
            akunLawanId: ACC.bebanLain, keterangan: nama, createdBy: USER_ID,
          }),
  });

  return [
    kas('2026-01-15', 3_000_000, true, 'pendapatan lain Januari'),
    kas('2026-02-03', 1_250_000, false, 'beban operasional Februari'),
    {
      tanggal: '2026-02-10', nama: 'simpanan pokok A001',
      jalankan: () => setorSimpanan({
        anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-02-10',
        nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    {
      tanggal: '2026-02-10', nama: 'simpanan pokok A002',
      jalankan: () => setorSimpanan({
        anggotaId: ANGGOTA_2_ID, jenis: 'POKOK', tanggal: '2026-02-10',
        nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    {
      tanggal: '2026-03-05', nama: 'simpanan wajib Maret A001',
      jalankan: () => setorSimpanan({
        anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-03-05',
        nominal: 100_000, periode: '2026-03', sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    {
      // SATU KELOMPOK: setor 5 Maret lalu tarik 7 Juli. Keduanya
      // sengaja tidak dipisah menjadi dua langkah acak — saldo simpanan
      // anggota adalah PRASYARAT NYATA penarikan (bukan artefak test):
      // menarik sebelum menyetor mustahil di dunia nyata, jadi
      // mengacaknya hanya akan menguji guard saldo, bukan urutan
      // pembukuan. Tanggal jurnal masing-masing TETAP berbeda.
      tanggal: '2026-03-05', nama: 'simpanan sukarela A001 (setor lalu tarik)',
      jalankan: async () => {
        await setorSimpanan({
          anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-03-05',
          nominal: 2_000_000, sumberDana: 'KAS', createdBy: USER_ID,
        });
        await tarikSimpananSukarela({
          anggotaId: ANGGOTA_ID, tanggal: '2026-07-07', nominal: 500_000,
          sumberDana: 'KAS', createdBy: USER_ID,
        });
      },
    },
    bank('2026-03-20', 15_000_000, true, 'penerimaan bank Maret'),
    {
      tanggal: '2026-03-31', nama: 'transfer kas -> bank',
      jalankan: () => transferAntarRekening({
        sumberJenis: 'KAS', tujuanJenis: 'BANK', tujuanBankAccountId: BANK_ID,
        tanggal: '2026-03-31', nominal: 20_000_000, keterangan: 'setor ke bank',
        createdBy: USER_ID,
      }),
    },
    kas('2026-04-02', 750_000, false, 'beban April'),
    {
      tanggal: '2026-04-15', nama: 'utang bank',
      jalankan: () => terimaUtang({
        namaPemberi: 'Bank Mitra', jenisPemberi: 'BANK', pokokPinjaman: 50_000_000,
        persenBunga: 0, jenisBunga: 'FLAT', tanggal: '2026-04-15',
        sumberDana: 'BANK', bankAccountId: BANK_ID, createdBy: USER_ID,
      }),
    },
    bank('2026-04-28', 2_400_000, false, 'biaya administrasi bank April'),
    {
      tanggal: '2026-05-04', nama: 'simpanan wajib Mei A001',
      jalankan: () => setorSimpanan({
        anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-05-04',
        nominal: 100_000, periode: '2026-05', sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    kas('2026-05-19', 4_100_000, true, 'pendapatan lain Mei'),
    {
      tanggal: '2026-06-01', nama: 'simpanan berjangka A002 (12 bulan)',
      jalankan: () => setorSimpananBerjangka({
        anggotaId: ANGGOTA_2_ID, nominal: 24_000_000, tanggal: '2026-06-01',
        tenorBulan: 12, sukuBungaPerTahun: 6, sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    {
      tanggal: '2026-06-12', nama: 'beli aset historis Rp12.000.000',
      jalankan: () => beliAset({
        namaAset: 'Mesin Kantor Historis', nilaiPerolehan: 12_000_000, nilaiResidu: 0,
        masaManfaatBulan: 48, tanggal: '2026-06-12', tanggalPerolehan: '2026-06-12',
        metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    kas('2026-06-12', 900_000, false, 'beban 12 Juni'),
    kas('2026-06-30', 1_100_000, true, 'pendapatan akhir Juni'),
    kas('2026-07-07', 1_400_000, true, 'penerimaan kas 7 Juli'),
    kas('2026-07-15', 2_300_000, false, 'transaksi kas 15 Juli'),
    bank('2026-07-22', 6_500_000, true, 'penerimaan bank Juli'),
    {
      tanggal: '2026-08-10', nama: 'beli aset kedua Rp6.000.000',
      jalankan: () => beliAset({
        namaAset: 'Kendaraan Operasional', nilaiPerolehan: 6_000_000, nilaiResidu: 0,
        masaManfaatBulan: 48, tanggal: '2026-08-10', tanggalPerolehan: '2026-08-10',
        metodePembayaran: 'TUNAI', sumberDana: 'BANK', bankAccountId: BANK_ID,
        createdBy: USER_ID,
      }),
    },
    kas('2026-08-18', 1_750_000, true, 'pendapatan Agustus'),
    bank('2026-08-31', 3_200_000, false, 'beban bank akhir Agustus'),
    {
      tanggal: '2026-09-09', nama: 'simpanan wajib September A002',
      jalankan: () => setorSimpanan({
        anggotaId: ANGGOTA_2_ID, jenis: 'WAJIB', tanggal: '2026-09-09',
        nominal: 100_000, periode: '2026-09', sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    kas('2026-09-20', 5_400_000, true, 'transaksi lain September'),
    {
      tanggal: '2026-09-30', nama: 'transfer bank -> kas',
      jalankan: () => transferAntarRekening({
        sumberJenis: 'BANK', sumberBankAccountId: BANK_ID, tujuanJenis: 'KAS',
        tanggal: '2026-09-30', nominal: 8_000_000, keterangan: 'tarik tunai',
        createdBy: USER_ID,
      }),
    },
    kas('2026-10-05', 1_900_000, false, 'beban Oktober'),
    bank('2026-10-21', 4_750_000, true, 'penerimaan bank Oktober'),
    kas('2026-11-11', 2_600_000, true, 'pendapatan November'),
    kas('2026-11-27', 3_300_000, false, 'beban November'),
    {
      tanggal: '2026-12-01', nama: 'biaya Desember',
      jalankan: () => catatPengeluaran({
        jenis: 'KAS', tanggal: '2026-12-01', nominal: 4_800_000,
        akunLawanId: ACC.bebanLain, keterangan: 'biaya Desember', createdBy: USER_ID,
      }),
    },
    bank('2026-12-15', 7_100_000, false, 'beban bank Desember'),
    kas('2026-12-31', 6_200_000, true, 'pendapatan tutup tahun'),

    // ---------- §V: perluasan menjadi >= 50 transaksi ----------
    kas('2026-01-08', 1_150_000, true, 'pendapatan awal Januari'),
    kas('2026-01-22', 640_000, false, 'beban akhir Januari'),
    bank('2026-02-14', 2_850_000, true, 'penerimaan bank Februari'),
    bank('2026-02-25', 1_320_000, false, 'beban bank Februari'),
    kas('2026-03-12', 980_000, false, 'beban pertengahan Maret'),
    kas('2026-04-09', 3_450_000, true, 'pendapatan April'),
    bank('2026-04-30', 1_960_000, true, 'penerimaan bank akhir April'),
    kas('2026-05-21', 1_270_000, false, 'beban Mei'),
    bank('2026-06-05', 4_300_000, true, 'penerimaan bank awal Juni'),
    kas('2026-06-25', 2_050_000, true, 'pendapatan akhir Juni'),
    bank('2026-07-31', 1_680_000, false, 'beban bank akhir Juli'),
    kas('2026-08-05', 890_000, false, 'beban awal Agustus'),
    bank('2026-09-14', 2_240_000, false, 'beban bank September'),
    kas('2026-10-28', 3_780_000, true, 'pendapatan akhir Oktober'),
    bank('2026-11-18', 5_150_000, true, 'penerimaan bank November'),
    {
      tanggal: '2026-04-20', nama: 'pendapatan diterima dimuka A002 (12 bulan)',
      jalankan: () => terimaPendapatanDimuka({
        anggotaId: ANGGOTA_2_ID, jumlah: 6_000_000, jangkaWaktuBulan: 12,
        tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: USER_ID,
      }),
    },
    {
      // SATU KELOMPOK: simpanan wajib syarat kelayakan -> pengajuan ->
      // pencairan -> angsuran pertama. Dipertahankan berurutan di dalam
      // kelompok karena memang berurutan di dunia nyata; POSISI
      // kelompoknya di antara transaksi lain tetap diacak.
      tanggal: '2026-02-02', nama: 'pinjaman anggota A003 + angsuran pertama',
      jalankan: async () => {
        await setorSimpanan({
          anggotaId: ANGGOTA_3_ID, jenis: 'POKOK', tanggal: '2026-02-02',
          nominal: 500_000, sumberDana: 'KAS', createdBy: USER_ID,
        });
        await setorSimpanan({
          anggotaId: ANGGOTA_3_ID, jenis: 'WAJIB', tanggal: '2026-02-02',
          nominal: 100_000, periode: '2026-02', sumberDana: 'KAS', createdBy: USER_ID,
        });
        const { id } = await ajukanPinjaman({
          anggotaId: ANGGOTA_3_ID, tanggal: '2026-02-05', jumlahPinjaman: 12_000_000,
          tenor: 12, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1,
          biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false,
          createdBy: USER_ID,
        });
        await cairkanPinjaman({
          pinjamanId: id, sumberDana: 'KAS', approvedBy: USER_ID, tanggalPencairan: '2026-02-05',
        });
        const jadwal = await getJadwalAngsuran(id);
        await bayarAngsuran({
          pinjamanId: id, jadwalId: jadwal[0].id, tanggal: jadwal[0].tanggalJatuhTempo,
          nominal: jadwal[0].total, sumberDana: 'KAS', createdBy: USER_ID,
        });
      },
    },
  ];
}

/**
 * Pengacakan DETERMINISTIK (LCG berbenih tetap). Dipakai menggantikan
 * daftar indeks yang ditulis tangan supaya jumlah langkah bisa tumbuh
 * tanpa menyusun ulang array — tetapi urutannya SELALU sama di setiap
 * eksekusi, sehingga kegagalan dapat diulang persis.
 */
function urutanAcakDeterministik(n: number, benih = 20260612): number[] {
  const indeks = Array.from({ length: n }, (_, i) => i);
  let state = benih;
  const acak = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = indeks.length - 1; i > 0; i--) {
    const j = Math.floor(acak() * (i + 1));
    [indeks[i], indeks[j]] = [indeks[j], indeks[i]];
  }
  return indeks;
}

const URUTAN_ACAK = urutanAcakDeterministik(daftarLangkah().length);

async function bangunDatabase(urutan: number[]): Promise<TestDb> {
  const db = await buatFixtureHistoris();
  testDb = db; // service memakai mock getDb() yang menunjuk `testDb`
  const langkah = daftarLangkah();
  for (const idx of urutan) {
    await langkah[idx].jalankan();
  }
  // Proses periodik dijalankan SETELAH seluruh transaksi masuk —
  // persis seperti aplikasi yang dibuka di akhir tahun.
  await jalankanPenyusutanCatchUp(USER_ID, '2026-12-31');
  await prosesAkrualBungaSemuaKontrak('2026-12-31', USER_ID);
  return db;
}

describe('§G/§AH/§AI — hasil akuntansi tidak boleh bergantung pada urutan input', () => {
  let dbA: TestDb;
  let dbB: TestDb;
  let ringkasanA: Awaited<ReturnType<typeof ringkasanAkuntansi>>;
  let ringkasanB: Awaited<ReturnType<typeof ringkasanAkuntansi>>;

  beforeAll(async () => {
    const kronologis = daftarLangkah()
      .map((l, i) => ({ i, tanggal: l.tanggal }))
      .sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : a.i - b.i))
      .map((x) => x.i);

    dbA = await bangunDatabase(kronologis);
    ringkasanA = await ringkasanAkuntansi(dbA);

    dbB = await bangunDatabase(URUTAN_ACAK);
    ringkasanB = await ringkasanAkuntansi(dbB);
  }, 120_000);

  it('menguji minimal 50 transaksi historis sepanjang 2026 (§AI/§V)', () => {
    const langkah = daftarLangkah();
    expect(langkah.length).toBeGreaterThanOrEqual(50);
    expect(URUTAN_ACAK.length).toBe(langkah.length);
    expect([...URUTAN_ACAK].sort((a, b) => a - b)).toEqual(langkah.map((_, i) => i));
    expect(langkah.every((l) => l.tanggal >= '2026-01-01' && l.tanggal <= '2026-12-31')).toBe(true);
  });

  it('saldo per akun IDENTIK antara urutan kronologis dan acak', () => {
    expect(ringkasanB.perAkun).toEqual(ringkasanA.perAkun);
  });

  it('jurnal per tanggal + sumber transaksi IDENTIK (tidak ada posting nyasar periode)', () => {
    expect(ringkasanB.perTanggalSumber).toEqual(ringkasanA.perTanggalSumber);
  });

  it('penyusutan per periode IDENTIK — tidak ada ketergantungan urutan', () => {
    expect(ringkasanB.penyusutan).toEqual(ringkasanA.penyusutan);
    // Aset 12 Juni (250.000/bln) + aset 10 Agustus (125.000/bln).
    const juni = ringkasanA.penyusutan.find((p) => p.periode === '2026-06');
    const agustus = ringkasanA.penyusutan.find((p) => p.periode === '2026-08');
    expect(juni?.nilai).toBe(250_000);
    expect(agustus?.nilai).toBe(375_000);
  });

  it.each([['A', () => dbA], ['B', () => dbB]])(
    'database %s: seluruh laporan konsisten & seimbang',
    async (_nama, ambil) => {
      const db = ambil();
      testDb = db;
      const posisi = await getPosisiKeuangan(db as any, '2026-12-31');
      expect(posisi.totalAset).toBe(posisi.totalLiabilitas + posisi.totalEkuitas);

      const lr = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
      expect(lr.totalPendapatan - lr.totalBeban).toBe(lr.hasilUsaha);

      const arusKas = await getArusKas(db as any, '2026-01-01', '2026-12-31');
      // Cash movement = cashflow movement: kas akhir hasil klasifikasi
      // arus kas harus SAMA dengan saldo kas/bank aktual di GL.
      expect(arusKas.kasAkhirDihitung).toBe(arusKas.kasAwal + arusKas.perubahanKas);
      expect(arusKas.kasAkhirDihitung).toBe(arusKas.kasAkhirAktual);
      expect(arusKas.terekonsiliasi).toBe(true);
      expect(arusKas.selisihRekonsiliasi).toBe(0);

      const ekuitas = await getPerubahanEkuitas(db as any, '2026-01-01', '2026-12-31');
      expect(ekuitas.totalSaldoAkhir).toBe(posisi.totalEkuitas);
    }
  );

  it.each([['A', () => dbA], ['B', () => dbB]])(
    'database %s: debit = kredit dan rekonsiliasi subledger vs GL seimbang (§AE)',
    async (_nama, ambil) => {
      const db = ambil();
      testDb = db;
      const { debit, kredit } = await totalDebitKredit(db);
      expect(debit).toBe(kredit);

      const rekon = await jalankanRekonsiliasiLengkap(db as any);
      const selisih = rekon.baris
        .filter((b) => b.status === 'SELISIH')
        .map((b) => `${b.domain}: subledger=${b.subledger} gl=${b.gl} variance=${b.variance}`);

      // S19: setelah P2 diperbaiki, TIDAK ADA domain yang boleh
      // berselisih — termasuk Cash & Bank.
      expect(selisih).toEqual([]);
    }
  );

  it.each([['A', () => dbA], ['B', () => dbB]])(
    'database %s: REGRESI P2 (SUDAH DIPERBAIKI di S19) — transfer antar rekening TIDAK lagi menghasilkan selisih palsu',
    async (_nama, ambil) => {
      const db = ambil();
      testDb = db;
      const rekon = await jalankanRekonsiliasiLengkap(db as any);
      const kas = rekon.baris.find((b) => b.domain === 'Cash')!;
      const bank = rekon.baris.find((b) => b.domain === 'Bank')!;

      // RIWAYAT TEMUAN (jangan dihapus — ini yang membuat regresi
      // terdeteksi kalau seseorang mengembalikan perilaku lama):
      // `transferAntarRekening()` menulis DUA baris subledger dengan
      // `tipe = 'TRANSFER'`; arahnya TIDAK tersimpan di kolom `tipe`,
      // keduanya bernominal positif. Sisi SUBLEDGER di
      // FullReconciliation.ts dulu menjumlah dengan
      //   CASE WHEN tipe='PENERIMAAN' THEN nominal
      //        WHEN tipe='PENGELUARAN' THEN -nominal
      //        ELSE 0 END
      // sehingga baris TRANSFER dihitung NOL, sementara sisi GL justru
      // MEMASUKKAN jurnal transfer itu. Selisihnya persis sebesar
      // transfer NETO dan muncul berlawanan tanda di Kas & Bank:
      // skenario ini (Kas->Bank 20.000.000 pada 2026-03-31 dan
      // Bank->Kas 8.000.000 pada 2026-09-30) dulu menghasilkan
      // variance +12.000.000 / -12.000.000.
      //
      // PERBAIKAN S19: kolom `arah_transfer` pada kas_transaksi &
      // bank_transaksi (schema v53) menyimpan arah DI SUBLEDGER,
      // sehingga rekonsiliasi tidak perlu membaca GL yang sedang
      // diverifikasi (tetap non-sirkular).
      expect(kas.variance).toBe(0);
      expect(bank.variance).toBe(0);
      expect(kas.status).toBe('SEIMBANG');
      expect(bank.status).toBe('SEIMBANG');
      expect(kas.variance + bank.variance).toBe(0);

      // Seluruh baris transfer punya arah — tidak ada yang jatuh ke
      // "tidak dapat direkonsiliasi".
      for (const tabel of ['kas_transaksi', 'bank_transaksi']) {
        const tanpaArah = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) n FROM ${tabel} WHERE tipe = 'TRANSFER' AND arah_transfer IS NULL`
        );
        expect(tanpaArah!.n).toBe(0);
      }
    }
  );

  it.each([['A', () => dbA], ['B', () => dbB]])(
    'database %s: integritas database & tidak ada baris yatim (§AF)',
    async (_nama, ambil) => {
      const db = ambil();
      const integrity = await db.getAllAsync<Record<string, string>>(`PRAGMA integrity_check`);
      expect(Object.values(integrity[0])[0]).toBe('ok');
      const fk = await db.getAllAsync<unknown>(`PRAGMA foreign_key_check`);
      expect(fk).toEqual([]);

      const hitung = async (sql: string) =>
        (await db.getFirstAsync<{ n: number }>(sql))!.n;

      expect(await hitung(
        `SELECT COUNT(*) n FROM journal j WHERE NOT EXISTS (SELECT 1 FROM journal_entry je WHERE je.journal_id = j.id)`
      )).toBe(0); // jurnal tanpa entry
      expect(await hitung(
        `SELECT COUNT(*) n FROM journal_entry je WHERE NOT EXISTS (SELECT 1 FROM journal j WHERE j.id = je.journal_id)`
      )).toBe(0); // entry tanpa jurnal
      expect(await hitung(
        `SELECT COUNT(*) n FROM aset_tetap a WHERE a.journal_id IS NULL OR NOT EXISTS (SELECT 1 FROM journal j WHERE j.id = a.journal_id)`
      )).toBe(0); // aset tanpa jurnal
      expect(await hitung(
        `SELECT COUNT(*) n FROM aset_penyusutan ap WHERE NOT EXISTS (SELECT 1 FROM aset_tetap a WHERE a.id = ap.aset_id)`
      )).toBe(0); // penyusutan tanpa aset
      expect(await hitung(
        `SELECT COUNT(*) n FROM (SELECT aset_id, periode FROM aset_penyusutan GROUP BY aset_id, periode HAVING COUNT(*) > 1)`
      )).toBe(0); // duplicate depreciation
      expect(await hitung(`SELECT COUNT(*) n FROM aset_penyusutan WHERE nilai_penyusutan < 0`)).toBe(0);
      expect(await hitung(`SELECT COUNT(*) n FROM journal_entry WHERE debit < 0 OR kredit < 0`)).toBe(0);

      // Setiap jurnal seimbang, satu per satu — bukan cuma totalnya.
      const takSeimbang = await db.getAllAsync<{ id: string }>(
        `SELECT j.id FROM journal j JOIN journal_entry je ON je.journal_id = j.id
         GROUP BY j.id HAVING SUM(je.debit) <> SUM(je.kredit)`
      );
      expect(takSeimbang).toEqual([]);
    }
  );
});
