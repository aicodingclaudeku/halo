import { createTestDb, TestDb } from './testDb';

/**
 * HOTFIX RC-S74 §18 (dan HOTFIX RC-S74 final §11) — SKENARIO PENGGUNA
 * END-TO-END (SQLite sungguhan + AccountingEngine + mesin akrual bunga
 * utang ASLI, tanpa mock mesin).
 *
 *   1. Input Utang Koperasi (25 jt, 10%/thn, mulai bulan lalu) -> simpan.
 *   2. requestStartupTask() aktif.
 *   3. GLOBAL APPLICATION COORDINATOR (`app/index.tsx`) mengonsumsi request
 *      one-shot — TERLEPAS apakah Dashboard pernah difokuskan. Ini
 *      perbaikan HOTFIX final: sebelumnya hanya `DashboardScreen` yang
 *      mengonsumsi, sehingga bug aktual muncul ketika pengguna TIDAK
 *      pernah membuka Dashboard (mis. Penerimaan -> Transaksi -> Bayar
 *      Kewajiban langsung).
 *   4. jalankanTugasStartup() berjalan (TIDAK di-await, seperti coordinator).
 *   5. Bayar Kewajiban dibuka SELAGI startup masih berjalan.
 *
 * `coordinatorGlobal()` di bawah mereplikasi persis logika efek
 * `app/index.tsx` (§ "GLOBAL APPLICATION COORDINATOR" di berkas itu):
 * membaca `startupTaskRequested`/`currentUser` dari store yang sama,
 * consume dalam guard, lalu panggil `jalankanTugasStartup()` — tanpa
 * bergantung pada DashboardScreen sama sekali (DashboardScreen tidak
 * di-mount atau di-fokuskan di berkas test ini).
 *
 * Layar Bayar Kewajiban direplikasi lewat urutan persis yang dipakai
 * `BayarUtangFormScreen` (potret metadata -> MEMUAT -> gate -> baca
 * read-model -> status kegagalan mesin -> infoDariDetail), memakai helper
 * produksi yang sama. Renderer RN tidak tersedia di Jest repo ini; teks
 * yang "terlihat" dirakit dari helper yang juga dirender layar.
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

import { terimaUtang } from '@/services/UtangService';
import {
  jalankanTugasStartup,
  tungguTugasStartupSelesai,
  getStatusTugasStartup,
  _resetTugasStartupUntukTest,
} from '@/services/StartupTasks';
import {
  getStatusBungaSemuaUtang,
  getHasilAkrualBungaUtangTerakhir,
  _resetGerbangAkrualUntukTest,
  LABEL_STATUS_BUNGA_UTANG,
} from '@/services/UtangBungaAccrualService';
import {
  InfoBunga,
  ProsesLatarBunga,
  infoBungaUntuk,
  infoDariDetail,
  akrualBungaGagalUntuk,
  bungaSiapUntukBayar,
  teksNilaiBunga,
  teksMemuatBunga,
  TEKS_ESTIMASI_TANPA_RIWAYAT,
} from '@/screens/Transaksi/bayarUtangGate';
import { useAppStore } from '@/store/useAppStore';
import { tambahBulan, toPeriode } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

async function seedAccount(id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}
async function seedMapping(tt: string, role: string, accountId: string) {
  await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${tt}-${role}`, tt, role, accountId);
}

beforeEach(async () => {
  _resetTugasStartupUntukTest();
  _resetGerbangAkrualUntukTest();
  testDb = await createTestDb();
  await seedAccount('acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount('acc-modal', '3-1000', 'Modal', 'EKUITAS', 'KREDIT');
  await seedAccount('acc-beban-bunga', '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount('acc-utang-bank', '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount('acc-utang-bunga', '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');
  await seedMapping('KAS_UMUM', 'DEFAULT', 'acc-kas');
  await seedMapping('UTANG_BANK', 'KREDIT_DEFAULT', 'acc-utang-bank');
  await seedMapping('UTANG_BUNGA', 'DEBIT_BEBAN', 'acc-beban-bunga');
  await seedMapping('UTANG_BUNGA', 'KREDIT_AKRUAL', 'acc-utang-bunga');
  const tahun = Number(getTanggalLokalHariIni().slice(0, 4));
  for (const t of [tahun - 1, tahun]) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `p${t}`, t, `${t}-01-01`, `${t}-12-31`
    );
  }
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`, now, now
  );
  useAppStore.setState({ startupTaskRequested: false, currentUser: { id: 'user-1', nama: 'Admin', role: 'ADMIN' } as any });
});

afterEach(() => testDb.closeSync());

/** Langkah 1–2: UtangFormScreen -> terimaUtang() lalu requestStartupTask(). */
async function inputUtangKoperasi(): Promise<string> {
  const tanggal = `${tambahBulan(toPeriode(getTanggalLokalHariIni()), -1)}-01`;
  const { id } = await terimaUtang({
    namaPemberi: 'Bank Device', jenisPemberi: 'BANK', pokokPinjaman: 25_000_000, persenBunga: 10,
    basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal, sumberDana: 'KAS', createdBy: 'user-1',
  });
  useAppStore.getState().requestStartupTask();
  return id;
}

/**
 * Langkah 3–4: GLOBAL APPLICATION COORDINATOR (`app/index.tsx`) bereaksi
 * terhadap perubahan `startupTaskRequested` -> consume -> koordinator
 * existing, TIDAK di-await. Direplikasi persis dari efek produksi:
 *
 *   if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;
 *   if (!consumeStartupTaskRequest()) return;
 *   jalankanTugasStartup(currentUser.id).catch(() => {});
 *
 * `phase` selalu 'READY' di sini (aplikasi sudah login); `startupTaskRequested`
 * dibaca langsung dari store yang sama seperti efek produksi. TIDAK
 * bergantung pada DashboardScreen — DashboardScreen tidak pernah dipanggil
 * di berkas test ini, sesuai skenario bug aktual yang dilaporkan.
 */
function coordinatorGlobal(): Promise<void> | null {
  const { startupTaskRequested, currentUser, consumeStartupTaskRequest } = useAppStore.getState();
  if (!startupTaskRequested || !currentUser) return null;
  if (!consumeStartupTaskRequest()) return null;
  return jalankanTugasStartup(currentUser.id).catch(() => {});
}

/**
 * Langkah 5: urutan efek `BayarUtangFormScreen` (sama persis dengan layar).
 * `tampil` menerima setiap state yang akan dirender.
 */
async function bukaBayarKewajiban(utangId: string, tampil: (info: InfoBunga, proses: ProsesLatarBunga | null) => void) {
  const snap = getStatusTugasStartup();
  const proses = snap.berjalan ? { mulaiMs: snap.mulaiMs ?? Date.now(), estimasiMs: snap.estimasiMs } : null;
  tampil({ utangId, tahap: 'MEMUAT' }, proses);
  await tungguTugasStartupSelesai();
  const detail = (await getStatusBungaSemuaUtang()).get(utangId);
  const akrualGagal = akrualBungaGagalUntuk(utangId, getHasilAkrualBungaUtangTerakhir());
  tampil(infoDariDetail(utangId, detail, akrualGagal), proses);
}

/** Teks yang terlihat di kartu "Utang Bunga" untuk satu state. */
function teksKartu(utangId: string, info: InfoBunga, proses: ProsesLatarBunga | null, berjalanMs = 0): string {
  const t = infoBungaUntuk({ id: utangId, jenisPemberi: 'BANK', persenBunga: 10 }, info)!;
  if (t.tahap === 'MEMUAT') {
    const m = teksMemuatBunga(proses, berjalanMs);
    return ['Utang Bunga', m.judul, m.estimasi, m.penjelasan].filter(Boolean).join(' | ');
  }
  const bagian = ['Utang Bunga', teksNilaiBunga(t)];
  if (t.tahap === 'SIAP') bagian.push(LABEL_STATUS_BUNGA_UTANG[t.statusBunga], t.pesanBunga ?? '');
  if (t.tahap === 'AKRUAL_GAGAL') bagian.push('Perhitungan belum selesai', 'Gagal memperbarui akrual otomatis.');
  return bagian.filter(Boolean).join(' | ');
}

describe('HOTFIX RC-S74 §18 — skenario pengguna persis (SQLite sungguhan)', () => {
  it('startup masih berjalan saat Bayar Kewajiban dibuka -> "Menghitung otomatis…" + estimasi; BUKAN Rp0 / Perlu Perhatian; lalu nominal & status aktual', async () => {
    const id = await inputUtangKoperasi();
    const tugas = coordinatorGlobal();
    expect(tugas).not.toBeNull(); // request one-shot memang dikonsumsi oleh coordinator global
    expect(getStatusTugasStartup().berjalan).toBe(true);

    // Bukti bahwa snapshot BASI memang ada saat itu (pembacaan langsung tanpa gate).
    const basi = (await getStatusBungaSemuaUtang()).get(id);
    expect(basi?.status).toBe('PERLU_PERHATIAN');
    expect(basi?.outstandingBunga).toBe(0);

    const layar: string[] = [];
    const states: InfoBunga[] = [];
    await bukaBayarKewajiban(id, (info, proses) => {
      states.push(info);
      layar.push(teksKartu(id, info, proses));
    });
    await tugas;

    // Aplikasi baru dibuka: belum ada riwayat durasi -> estimasi kualitatif.
    expect(layar[0]).toBe(
      `Utang Bunga | Menghitung otomatis… | ${TEKS_ESTIMASI_TANPA_RIWAYAT} | Proses ini dijalankan otomatis untuk memperbarui akrual bunga.`
    );
    expect(layar[0]).not.toMatch(/Rp0|Perlu Perhatian|belum tercatat/);
    expect(bungaSiapUntukBayar({ id, jenisPemberi: 'BANK', persenBunga: 10 }, states[0])).toBe(false);

    // Setelah promise StartupTasks selesai: angka & status accounting aktual.
    expect(layar[1]).toBe('Utang Bunga | Rp208.333 | Terkendali');
    expect(layar.join(' ')).not.toMatch(/Rp0\b|Perlu Perhatian/);
    expect(bungaSiapUntukBayar({ id, jenisPemberi: 'BANK', persenBunga: 10 }, states[1])).toBe(true);
  });

  it('estimasi ±X berasal dari durasi batch StartupTasks yang BENAR-BENAR terukur sebelumnya', async () => {
    // Batch sebelumnya (mis. saat login) — durasinya diukur nyata.
    await jalankanTugasStartup('user-1');
    const riwayat = getStatusTugasStartup();
    expect(riwayat.jumlahSampel).toBe(1);
    expect(riwayat.estimasiMs).not.toBeNull();

    const id = await inputUtangKoperasi();
    const tugas = coordinatorGlobal();
    const layar: string[] = [];
    let prosesTerlihat: ProsesLatarBunga | null = null;
    await bukaBayarKewajiban(id, (info, proses) => {
      prosesTerlihat = proses;
      layar.push(teksKartu(id, info, proses));
    });
    await tugas;

    expect(prosesTerlihat).not.toBeNull();
    expect(prosesTerlihat!.estimasiMs).toBe(riwayat.estimasiMs); // bukan angka karangan
    // Batch sebelumnya di lingkungan test bisa selesai <1 ms, sehingga
    // durasi terukurnya 0. Itu BUKAN kegagalan: `teksMemuatBunga`
    // memperlakukan estimasi <= 0 sebagai "belum ada riwayat berarti" dan
    // menampilkan teks kualitatif — persis perilaku yang dikunci
    // EstimasiAkrualRealtimeRcS74Hotfix. Yang diuji di sini adalah bahwa
    // angkanya BERASAL dari durasi nyata (diasersi di baris atas), bukan
    // bentuk teksnya pada satu nilai tertentu.
    const est = riwayat.estimasiMs!;
    const sisa = Math.max(0, Math.ceil(est / 1000));
    expect(layar[0]).toContain(est > 0 ? `Estimasi selesai dalam ±${sisa} detik` : 'Estimasi beberapa detik');
    expect(layar[1]).toBe('Utang Bunga | Rp208.333 | Terkendali');
    expect(getStatusTugasStartup().jumlahSampel).toBe(2); // batch ini ikut memperbarui rolling average
  });

  it('TEST 10 — hasil accounting yang BENAR-BENAR Rp0 (utang bulan berjalan) tetap tampil Rp0 setelah task selesai', async () => {
    const { id } = await terimaUtang({
      namaPemberi: 'Bank Baru', jenisPemberi: 'BANK', pokokPinjaman: 25_000_000, persenBunga: 10,
      basisBunga: 'TAHUNAN', jenisBunga: 'FLAT', tanggal: getTanggalLokalHariIni(), sumberDana: 'KAS', createdBy: 'user-1',
    });
    const tugas = jalankanTugasStartup('user-1');
    const layar: string[] = [];
    await bukaBayarKewajiban(id, (info, proses) => layar.push(teksKartu(id, info, proses)));
    await tugas;
    expect(layar[0]).not.toMatch(/Rp/);
    expect(layar[1]).toMatch(/^Utang Bunga \| Rp0 \| /); // Rp0 final yang sah
    expect(layar[1]).not.toMatch(/Perlu Perhatian/);
  });

  it('TEST 11 — mesin akrual gagal sungguhan -> "Perhitungan belum selesai", BUKAN Rp0 + Perlu Perhatian', async () => {
    const id = await inputUtangKoperasi();
    // Rusak konfigurasi jurnal akrual SETELAH utang tercatat -> mesin gagal membukukan.
    const hapus = `DELETE FROM account_mapping WHERE transaction_type = 'UTANG_BUNGA' AND role = 'KREDIT_AKRUAL'`;
    await testDb.runAsync(hapus);
    const tugas = coordinatorGlobal();
    const states: InfoBunga[] = [];
    const layar: string[] = [];
    const tampil = (info: InfoBunga, proses: ProsesLatarBunga | null) => {
      states.push(info);
      layar.push(teksKartu(id, info, proses));
    };
    // Urutan layar yang sama dengan `bukaBayarKewajiban`, dengan satu langkah
    // perancah test: mapping dipulihkan SETELAH mesin gagal & SEBELUM layar
    // membaca, supaya read-model berhasil dibaca (kalau tidak, read-model ikut
    // melempar dan layar sudah menampilkan TIDAK_TERSEDIA — itu jalur lain).
    const snap = getStatusTugasStartup();
    tampil({ utangId: id, tahap: 'MEMUAT' }, snap.berjalan ? { mulaiMs: snap.mulaiMs ?? Date.now(), estimasiMs: snap.estimasiMs } : null);
    await tungguTugasStartupSelesai();
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-pulih','UTANG_BUNGA','KREDIT_AKRUAL','acc-utang-bunga')`);
    const detail = (await getStatusBungaSemuaUtang()).get(id);
    const akrualGagal = akrualBungaGagalUntuk(id, getHasilAkrualBungaUtangTerakhir());
    tampil(infoDariDetail(id, detail, akrualGagal), null);
    await tugas;

    // Mesin memang melaporkan kegagalan, dan angka mentah read-model memang basi…
    expect(akrualGagal).toBe(true);
    expect(detail?.outstandingBunga).toBe(0);
    expect(detail?.status).toBe('PERLU_PERHATIAN');
    // …tetapi layar tidak menampilkannya sebagai hasil valid.
    expect(states[1]).toEqual({ utangId: id, tahap: 'AKRUAL_GAGAL' });
    expect(layar[1]).toBe('Utang Bunga | — | Perhitungan belum selesai | Gagal memperbarui akrual otomatis.');
    expect(layar.join(' ')).not.toMatch(/Rp0|Perlu Perhatian/);
    expect(bungaSiapUntukBayar({ id, jenisPemberi: 'BANK', persenBunga: 10 }, states[1])).toBe(false);
    // Tidak ada jurnal akrual yang tertulis (layar tidak pernah menulis jurnal).
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM utang_bunga_akrual WHERE utang_id = ? AND journal_id IS NOT NULL`, id);
    expect(n!.n).toBe(0);

    // Batch berikutnya (mis. aplikasi dibuka kembali) sukses -> Coba lagi memberi angka aktual.
    await jalankanTugasStartup('user-1');
    const ulang = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id), akrualBungaGagalUntuk(id, getHasilAkrualBungaUtangTerakhir()));
    expect(teksKartu(id, ulang, null)).toBe('Utang Bunga | Rp208.333 | Terkendali');
  });

  it('BUG AKTUAL DIPERBAIKI (HOTFIX final §11) — Dashboard TIDAK PERNAH dibuka: Penerimaan -> Utang Koperasi -> simpan -> LANGSUNG Bayar Kewajiban', async () => {
    // Replikasi PERSIS skenario yang dilaporkan pengguna (§11 tiket):
    //   1. Input Utang Koperasi, simpan.
    //   2. requestStartupTask() aktif.
    //   3. Pengguna TIDAK membuka Dashboard sama sekali — DashboardScreen
    //      tidak di-mount/di-fokuskan di test ini. Modul DashboardScreen
    //      bahkan tidak diimpor.
    //   4. Pengguna langsung: Transaksi -> Bayar Kewajiban -> Utang Koperasi.
    const id = await inputUtangKoperasi();
    expect(useAppStore.getState().startupTaskRequested).toBe(true);
    expect(getStatusTugasStartup().berjalan).toBe(false); // belum ada yang mengonsumsi

    // GLOBAL APPLICATION COORDINATOR (app/index.tsx) bereaksi terhadap
    // PERUBAHAN state `startupTaskRequested` — bukan fokus Dashboard.
    const tugas = coordinatorGlobal();
    expect(tugas).not.toBeNull(); // dikonsumsi TANPA Dashboard pernah dibuka
    expect(getStatusTugasStartup().berjalan).toBe(true);
    expect(useAppStore.getState().startupTaskRequested).toBe(false); // one-shot: habis dikonsumsi

    // Bukti nilai basi memang ada di database saat itu (persis laporan bug).
    const basi = (await getStatusBungaSemuaUtang()).get(id);
    expect(basi?.status).toBe('PERLU_PERHATIAN');
    expect(basi?.outstandingBunga).toBe(0);

    const layar: string[] = [];
    const states: InfoBunga[] = [];
    await bukaBayarKewajiban(id, (info, proses) => {
      states.push(info);
      layar.push(teksKartu(id, info, proses));
    });
    await tugas;

    // TIDAK BOLEH: Rp0 + Perlu Perhatian sebagai hasil sementara.
    expect(layar[0]).toMatch(/^Utang Bunga \| Menghitung otomatis…/);
    expect(layar.join(' ')).not.toMatch(/Rp0|Perlu Perhatian|belum tercatat/);
    expect(states[0]).toEqual({ utangId: id, tahap: 'MEMUAT' });
    expect(bungaSiapUntukBayar({ id, jenisPemberi: 'BANK', persenBunga: 10 }, states[0])).toBe(false);

    // Setelah task selesai: angka & status accounting AKTUAL.
    expect(layar[1]).toBe('Utang Bunga | Rp208.333 | Terkendali');
    expect(states[1]).toEqual({ utangId: id, tahap: 'SIAP', nilai: 208_333, statusBunga: 'TERKENDALI', pesanBunga: null });
    expect(bungaSiapUntukBayar({ id, jenisPemberi: 'BANK', persenBunga: 10 }, states[1])).toBe(true);
  });

  it('perubahan startupTaskRequested berulang sebelum task selesai -> hanya SATU batch (tidak ada task kedua paralel)', async () => {
    const id = await inputUtangKoperasi();
    const tugas1 = coordinatorGlobal();
    expect(tugas1).not.toBeNull();
    // Efek coordinator berjalan ulang karena alasan lain (mis. currentUser
    // berubah referensi) SEMENTARA task masih berjalan & tidak ada request
    // baru — tidak boleh memulai batch kedua.
    const tugas2 = coordinatorGlobal();
    expect(tugas2).toBeNull(); // consume gagal: request sudah habis
    await tugas1;
    const detail = infoDariDetail(id, (await getStatusBungaSemuaUtang()).get(id));
    expect(detail).toMatchObject({ tahap: 'SIAP', nilai: 208_333, statusBunga: 'TERKENDALI' });
  });

  it('perubahan state TANPA request tertunda tidak pernah memicu StartupTasks', () => {
    expect(useAppStore.getState().startupTaskRequested).toBe(false);
    expect(coordinatorGlobal()).toBeNull();
    expect(getStatusTugasStartup().berjalan).toBe(false);
  });

  it('HARDENING (final) §15 — listener SINKRON produksi: requestStartupTask() langsung menjalankan mesin akrual ASLI; potret layar tidak pernah melihat "berjalan: false"', async () => {
    // Berbeda dengan test-test di atas (yang memanggil `coordinatorGlobal()`
    // secara manual, meniru efek React), test ini memasang langganan MENTAH
    // ke store — persis `useAppStore.subscribe(...)` di `app/index.tsx` —
    // lalu HANYA memanggil `requestStartupTask()`. Tidak ada pemanggilan
    // coordinator manual sama sekali.
    //
    // Mesin akrual di sini ASLI (berkas ini tidak me-mock service apa pun),
    // berjalan di atas SQLite sungguhan.
    const phaseRef = { current: 'READY' as const };
    const unsub = useAppStore.subscribe((state, prevState) => {
      if (!state.startupTaskRequested || prevState.startupTaskRequested) return; // rising edge
      if (phaseRef.current !== 'READY' || !state.currentUser) return;
      if (!useAppStore.getState().consumeStartupTaskRequest()) return;
      jalankanTugasStartup(state.currentUser.id).catch(() => {});
    });

    try {
      const id = await inputUtangKoperasi(); // ini sudah memanggil requestStartupTask() di dalamnya

      // POTRET LAYAR, SINKRON — tanpa await di antara request dan baris ini.
      // Inilah instan yang dulu menghasilkan Rp0 + Perlu Perhatian.
      const proses = getStatusTugasStartup();
      expect(proses.berjalan).toBe(true);
      expect(useAppStore.getState().startupTaskRequested).toBe(false); // dikonsumsi sinkron

      // Layar: MEMUAT -> gate -> baca read-model.
      const layar: string[] = [];
      const states: InfoBunga[] = [];
      await bukaBayarKewajiban(id, (info, p) => {
        states.push(info);
        layar.push(teksKartu(id, info, p));
      });

      expect(states[0]).toEqual({ utangId: id, tahap: 'MEMUAT' });
      expect(layar[0]).toMatch(/^Utang Bunga \| Menghitung otomatis…/);
      expect(layar.join(' ')).not.toMatch(/Rp0|Perlu Perhatian|belum tercatat/);
      // Hasil akhir dari mesin akrual ASLI.
      expect(layar[1]).toBe('Utang Bunga | Rp208.333 | Terkendali');
      await tungguTugasStartupSelesai();
    } finally {
      unsub();
    }
  });
});
