/**
 * HARDENING RC-S74 (final) — TUTUP RACE WINDOW pada GLOBAL STARTUP TASK
 * COORDINATOR.
 *
 * KONTEKS: sesi sebelumnya memindahkan konsumsi `startupTaskRequested` dari
 * `DashboardScreen` ke `app/index.tsx` lewat `useEffect` berdependensi
 * (`[phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]`).
 * Itu memperbaiki masalah "Dashboard tidak dibuka", TETAPI masih menyisakan
 * jendela race: `requestStartupTask()` mengubah state Zustand SEKETIKA
 * (listener store dipanggil SINKRON di dalam `setState`), sedangkan
 * `useEffect` React sendiri baru berjalan SETELAH commit — asinkron. Kalau
 * pengguna sempat membuka Bayar Kewajiban tepat di jendela itu,
 * `getStatusTugasStartup().berjalan` masih `false` dan read-model lama
 * (Rp0 + PERLU_PERHATIAN) terbaca.
 *
 * PERBAIKAN (diuji di sini): langganan MENTAH ke store (`useAppStore.subscribe`,
 * BUKAN lewat hook React) yang dipanggil SINKRON oleh Zustand sebagai bagian
 * dari `setState` itu sendiri — lihat `node_modules/zustand/vanilla.js`,
 * `listeners.forEach((listener) => listener(state, previousState));` di
 * DALAM `setState`, sebelum `setState` mengembalikan kontrol. Karena
 * `jalankanTugasStartup()` juga menetapkan gate internalnya (`tugasBerjalan`)
 * secara SINKRON sebelum `await` pertamanya (lihat `StartupTasks.ts`), begitu
 * `requestStartupTask()` selesai dipanggil, `getStatusTugasStartup().berjalan`
 * SUDAH `true` — TANPA menunggu render/effect React apa pun.
 *
 * Fungsi replika di bawah (`daftarkanListenerSinkron`, `konsumsiFallbackJikaReady`)
 * MENCERMINKAN PERSIS logika produksi di `app/index.tsx` — dicocokkan
 * baris-demi-baris oleh test struktural di `KewajibanRcS74.test.ts`
 * (describe "GLOBAL APPLICATION COORDINATOR"). Keduanya memanggil FUNGSI
 * PRODUKSI ASLI (`useAppStore.subscribe`, `useAppStore.getState`,
 * `jalankanTugasStartup`) — bukan tiruannya — sehingga perilaku yang diuji
 * di sini adalah perilaku NYATA store & StartupTasks, tanpa perlu renderer
 * React (tidak tersedia di Jest repo ini).
 *
 * Enam langkah kerja StartupTasks (penyusutan, akrual jasa, EIR, catch-up
 * berjangka, akrual bunga utang, registrasi task OS) di-mock di sini —
 * seperti `EstimasiAkrualRealtimeRcS74Hotfix.test.ts` — supaya timing batch
 * dapat DIKENDALIKAN test (ditahan sampai `lepas()` dipanggil). Skenario
 * SQLite sungguhan (tanpa mock mesin akrual), lewat listener sinkron yang
 * SAMA, ada di `SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts`.
 */

// --------------------------------------------------------------------------
// Mock pekerjaan latar: batch penyusutan ditahan sampai `lepas()` dipanggil;
// lima langkah lain resolve seketika (fokus test ini adalah TIMING gate,
// bukan durasi setiap langkah).
// --------------------------------------------------------------------------
let penahan: Array<() => void> = [];
const jejak: string[] = [];

jest.mock('@/services/PenyusutanService', () => ({
  jalankanPenyusutanOtomatisJikaPerlu: jest.fn(async () => {
    jejak.push('batch:mulai');
    await new Promise<void>((r) => penahan.push(r));
    jejak.push('batch:selesai');
  }),
}));
jest.mock('@/services/AkrualJasaPinjamanService', () => ({ jalankanAkrualJasaOtomatisJikaPerlu: jest.fn(async () => undefined) }));
jest.mock('@/services/EirAccountingService', () => ({ jalankanEirOtomatisJikaPerlu: jest.fn(async () => undefined) }));
jest.mock('@/services/SimpananBerjangkaCatchUpService', () => ({ jalankanCatchUpAkrualSimpananBerjangka: jest.fn(async () => undefined) }));
jest.mock('@/services/SimpananBerjangkaBackgroundTask', () => ({ daftarkanTaskAkrualBerjangka: jest.fn(async () => true) }));
jest.mock('@/services/UtangBungaAccrualService', () => ({
  jalankanAkrualBungaUtangJikaPerlu: jest.fn(async () => ({ dijalankan: true, periodeDiproses: [], exception: [], totalDibukukan: 0, jumlahJurnalBaru: 0 })),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  jalankanTugasStartup,
  tungguTugasStartupSelesai,
  getStatusTugasStartup,
  _resetTugasStartupUntukTest,
} from '@/services/StartupTasks';
import { jalankanAkrualBungaUtangJikaPerlu } from '@/services/UtangBungaAccrualService';
import { useAppStore } from '@/store/useAppStore';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

type PhaseLike = 'LOADING' | 'SETUP' | 'LOGIN' | 'LOCKED' | 'READY';

/**
 * Replika PERSIS listener sinkron `app/index.tsx` (lihat struktur asli yang
 * dicocokkan test di `KewajibanRcS74.test.ts`). `phaseRef` meniru
 * `phaseRef.current` produksi (diperbarui setiap render di komponen asli;
 * di sini test yang mengendalikannya langsung, persis peran ref itu).
 */
function daftarkanListenerSinkron(phaseRef: { current: PhaseLike }): () => void {
  return useAppStore.subscribe((state, prevState) => {
    if (!state.startupTaskRequested || prevState.startupTaskRequested) return; // rising edge saja
    if (phaseRef.current !== 'READY' || !state.currentUser) return; // fallback yang menangani
    if (!useAppStore.getState().consumeStartupTaskRequest()) return; // sudah dikonsumsi -> tidak dobel
    jalankanTugasStartup(state.currentUser.id).catch(() => {});
  });
}

/** Replika PERSIS efek fallback (kasus request datang sebelum phase READY). */
function konsumsiFallbackJikaReady(phase: PhaseLike): void {
  const { startupTaskRequested, currentUser, consumeStartupTaskRequest } = useAppStore.getState();
  if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;
  if (!consumeStartupTaskRequest()) return;
  jalankanTugasStartup(currentUser.id).catch(() => {});
}

function lepas(): void {
  const r = penahan.shift();
  if (!r) throw new Error('tidak ada batch yang ditahan');
  r();
}

/**
 * Kuras microtask queue: `jalankanTugasStartup()` menetapkan `tugasBerjalan`
 * SINKRON (itulah yang dibuktikan TEST A), tetapi ISI langkah pertamanya
 * (mock `jalankanPenyusutanOtomatisJikaPerlu`, yang menulis ke `jejak` dan
 * `penahan`) baru jalan setelah promise chain internal
 * (`sebelumnya.catch(() => {}).then(async () => {...})`) sempat berjalan —
 * MICROTASK, bukan macrotask/timer. Helper ini HANYA menunggu microtask
 * (tanpa `setTimeout`), untuk membedakan "task terpasang" (sinkron, TEST A)
 * dari "langkah pertamanya sudah tereksekusi" (perlu tick) tanpa
 * menyembunyikan race apa pun — assertion `berjalan===true` di TEST A tetap
 * dicek SEBELUM helper ini dipanggil di semua test.
 */
async function kurasMicrotask(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const USER = { id: 'user-1', nama: 'Admin', role: 'ADMIN' } as const;

beforeEach(() => {
  penahan = [];
  jejak.length = 0;
  _resetTugasStartupUntukTest();
  (jalankanAkrualBungaUtangJikaPerlu as jest.Mock).mockClear();
  useAppStore.setState({ startupTaskRequested: false, currentUser: null });
});

// ===========================================================================
// TEST A (§14) — RACE WINDOW: bukti SINKRON, bukan `await`/`waitFor`
// ===========================================================================

describe('HARDENING RC-S74 (final) — TEST A: race window ditutup', () => {
  it('tugasBerjalan terpasang SINKRON dalam call stack YANG SAMA dengan requestStartupTask(), TANPA await apa pun', async () => {
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      expect(getStatusTugasStartup().berjalan).toBe(false);
      expect(useAppStore.getState().startupTaskRequested).toBe(false);

      // TIDAK ADA `await`, TIDAK ADA `Promise.resolve()`, TIDAK ADA
      // `waitFor(...)` di antara baris ini dan DUA assertion berikutnya.
      // Inilah yang membuktikan konsumsi TIDAK menunggu render/effect React
      // berikutnya — persis yang diminta §16 tiket ("jangan hanya
      // `await waitFor(...)` lalu menyimpulkan berhasil").
      useAppStore.getState().requestStartupTask();

      expect(getStatusTugasStartup().berjalan).toBe(true); // task BENAR-BENAR sudah berjalan
      expect(useAppStore.getState().startupTaskRequested).toBe(false); // dikonsumsi sinkron, one-shot

      // Bukti TAMBAHAN (bukan bagian dari klaim sinkron di atas, yang sudah
      // selesai dibuktikan): langkah pertama batch itu benar-benar mengarah
      // ke engine akrual asli begitu microtask sempat jalan — bukan sekadar
      // `tugasBerjalan` yang terpasang tanpa isi.
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);
    } finally {
      unsub();
      lepas();
    }
  });

  it('CASE 2/29 — kalau BayarUtangFormScreen memotret status TEPAT setelah requestStartupTask() (skenario bug asli), ia melihat "berjalan: true", bukan snapshot lama', async () => {
    // Ini adalah replika presisi dari root cause yang dilaporkan: potret
    // `getStatusTugasStartup()` yang dilakukan BayarUtangFormScreen sesaat
    // setelah request dibuat. Dengan listener sinkron terpasang, potret itu
    // TIDAK PERNAH lagi jatuh pada jendela "request=true, tugasBerjalan=null".
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask(); // mis. UtangFormScreen setelah terimaUtang()
      // BayarUtangFormScreen: const proses = getStatusTugasStartup();
      const proses = getStatusTugasStartup();

      // INI yang menentukan: `berjalan === true` berarti layar masuk tahap
      // MEMUAT dan gate `tungguTugasStartupSelesai()` akan BENAR-BENAR
      // menunggu — tidak ada lagi jalan lolos ke read-model basi.
      expect(proses.berjalan).toBe(true);

      // BATAS YANG DIDOKUMENTASIKAN (bukan bug): pada instan sinkron ini
      // `mulaiMs` masih null, karena `waktuMulaiTugas` baru ditetapkan di
      // dalam body batch (`.then()`) — satu microtask kemudian. Gate sudah
      // terpasang, hanya stempel waktunya yang menyusul.
      //
      // Layar SUDAH menangani ini apa adanya:
      //   mulaiMs: proses.mulaiMs ?? Date.now()
      // Selisihnya satu microtask (<1 ms), jadi angka estimasi yang
      // ditampilkan identik. Sengaja TIDAK diubah: memindahkan penetapan
      // `waktuMulaiTugas` ke luar body batch akan mengubah arti "durasi
      // batch aktual" yang menjadi dasar rolling average estimasi.
      expect(proses.mulaiMs).toBeNull();
      await kurasMicrotask();
      expect(getStatusTugasStartup().mulaiMs).not.toBeNull(); // menyusul satu microtask kemudian
    } finally {
      unsub();
      await kurasMicrotask(); // biarkan batch mencapai langkah yang ditahan sebelum dilepas
      lepas();
    }
  });
});

// ===========================================================================
// §5/§6/§17 — rising edge, satu batch per sinyal, TANPA batch paralel
// ===========================================================================

describe('HARDENING RC-S74 (final) — rising edge & larangan batch paralel', () => {
  it('set() berulang dengan nilai true YANG SAMA (belum dikonsumsi) tidak memicu konsumsi berulang', () => {
    // Membuktikan mengapa rising-edge check DIPERLUKAN: zustand memanggil
    // listener pada SETIAP setState(), bahkan bila nilai field tidak
    // berubah (partial state selalu objek baru -> Object.is selalu false).
    // Tanpa guard `prevState.startupTaskRequested`, baris ini akan mencoba
    // consume berkali-kali.
    const phaseRef = { current: 'LOADING' as PhaseLike }; // sengaja BELUM READY -> tidak boleh konsumsi
    let panggilanListener = 0;
    const unsubHitung = useAppStore.subscribe((state, prevState) => {
      if (state.startupTaskRequested && !prevState.startupTaskRequested) panggilanListener++;
    });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask(); // false -> true: rising edge #1
      useAppStore.getState().requestStartupTask(); // true -> true: BUKAN rising edge
      useAppStore.getState().requestStartupTask(); // true -> true: BUKAN rising edge
      expect(panggilanListener).toBe(1); // hanya SATU rising edge tercatat
      expect(useAppStore.getState().startupTaskRequested).toBe(true); // belum dikonsumsi (phase belum READY)
      expect(getStatusTugasStartup().berjalan).toBe(false); // tidak ada batch yang salah mulai
    } finally {
      unsub();
      unsubHitung();
    }
  });

  it('SATU rising edge -> SATU konsumsi -> SATU pemanggilan jalankanTugasStartup() untuk sinyal itu', async () => {
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask();
      expect(getStatusTugasStartup().berjalan).toBe(true); // sinkron
      expect(useAppStore.getState().startupTaskRequested).toBe(false);
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);
    } finally {
      unsub();
      lepas();
    }
  });

  it('permintaan BARU yang genuinely datang SELAGI batch masih berjalan tetap DIRANTAI berurutan — TIDAK PERNAH paralel (tugasBerjalan dipertahankan apa adanya)', async () => {
    // Catatan kejujuran (lihat laporan sesi): dua permintaan yang BENAR-BENAR
    // berbeda (mis. dua utang berbeda disimpan sebelum batch pertama
    // selesai) TETAP masing-masing memicu satu `jalankanTugasStartup()` —
    // itu BENAR, bukan bug: batch pertama sudah mulai SEBELUM utang kedua
    // ada, jadi tidak bisa mengakrualnya; batch kedua diperlukan untuk
    // benar-benar mengakru utang kedua. Yang WAJIB dicegah adalah PARALEL —
    // dan itulah yang dibuktikan di sini: batch kedua baru mulai SETELAH
    // batch pertama selesai, tidak pernah tumpang tindih.
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask(); // sinyal #1 (mis. utang A)
      expect(getStatusTugasStartup().berjalan).toBe(true); // sinkron
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);

      useAppStore.getState().requestStartupTask(); // sinyal #2 (mis. utang B, batch #1 MASIH berjalan)
      await kurasMicrotask();
      // Batch kedua BELUM boleh mulai (langkah pertamanya ditahan lewat mock
      // yang SAMA — kalau ia mulai paralel, `jejak` akan berisi dua
      // 'batch:mulai' berturutan TANPA 'batch:selesai' di antaranya).
      expect(jejak).toEqual(['batch:mulai']); // masih SATU yang tercatat mulai — batch #2 menunggu giliran

      lepas(); // batch #1 selesai
      await kurasMicrotask(); // biarkan batch #2 (dirantai otomatis oleh tugasBerjalan) mulai
      expect(jejak).toEqual(['batch:mulai', 'batch:selesai', 'batch:mulai']); // batch #2 BARU mulai SETELAH #1 selesai
      lepas(); // batch #2 selesai
      await tungguTugasStartupSelesai(); // menunggu SELURUH rantai benar-benar tuntas
      expect(jejak).toEqual(['batch:mulai', 'batch:selesai', 'batch:mulai', 'batch:selesai']); // tepat dua batch, berurutan, tidak lebih
    } finally {
      unsub();
    }
  });
});

// ===========================================================================
// §4/§8/§18 — request sebelum READY tidak hilang; fallback konsumsi SATU kali
// ===========================================================================

describe('HARDENING RC-S74 (final) — request sebelum phase READY tetap aman', () => {
  it('CASE 5/29 — phase belum READY: request TIDAK dikonsumsi, TIDAK hilang (bendera tetap true)', () => {
    const phaseRef = { current: 'LOADING' as PhaseLike };
    // currentUser sengaja BELUM diset — persis kondisi nyata sebelum login selesai.
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask();
      expect(useAppStore.getState().startupTaskRequested).toBe(true); // tidak hilang
      expect(getStatusTugasStartup().berjalan).toBe(false); // belum ada yang salah mulai
      expect(jejak).toEqual([]);
    } finally {
      unsub();
    }
  });

  it('setelah phase menjadi READY, fallback mengonsumsi request yang tertunda TEPAT SATU KALI', async () => {
    const phaseRef = { current: 'LOADING' as PhaseLike };
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask(); // datang sebelum READY
      expect(useAppStore.getState().startupTaskRequested).toBe(true);

      // Transisi ke READY (persis `evaluatePhase()` -> `setPhase('READY')`,
      // lalu efek fallback React berjalan pada render berikutnya).
      phaseRef.current = 'READY';
      useAppStore.setState({ currentUser: { ...USER } });
      konsumsiFallbackJikaReady('READY');

      expect(useAppStore.getState().startupTaskRequested).toBe(false); // konsumsi tetap sinkron (set + panggil)
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);

      // Panggilan fallback BERIKUTNYA (mis. re-render lain) tidak membuat batch kedua.
      konsumsiFallbackJikaReady('READY');
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);
    } finally {
      unsub();
      lepas();
    }
  });

  it('listener sinkron dan fallback tidak pernah DOBEL mengonsumsi request yang sama (consume atomic, siapa lebih dulu menang)', async () => {
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask(); // listener sinkron menang -> konsumsi
      expect(getStatusTugasStartup().berjalan).toBe(true); // sinkron
      // Fallback (mis. efek React lain yang kebetulan re-run) mencoba juga —
      // tidak boleh membuat batch kedua karena bendera sudah false.
      konsumsiFallbackJikaReady('READY');
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']); // tetap SATU
    } finally {
      unsub();
      lepas();
    }
  });
});

// ===========================================================================
// §19 — request ditelan hanya sekali; update state lain tidak memicu ulang
// ===========================================================================

describe('HARDENING RC-S74 (final) — TEST 19: request ditelan hanya sekali', () => {
  it('setelah consume, update state store LAIN berkali-kali tidak memicu StartupTasks tambahan', async () => {
    const phaseRef = { current: 'READY' as PhaseLike };
    useAppStore.setState({ currentUser: { ...USER } });
    const unsub = daftarkanListenerSinkron(phaseRef);
    try {
      useAppStore.getState().requestStartupTask();
      expect(getStatusTugasStartup().berjalan).toBe(true); // sinkron
      await kurasMicrotask();
      expect(jejak).toEqual(['batch:mulai']);

      // Perubahan state TIDAK TERKAIT (persis skenario nyata: lisensi,
      // restore signal, permission) — listener terpanggil untuk SEMUA ini
      // (tanpa selector), tetapi rising-edge check menolaknya.
      useAppStore.getState().triggerLicenseRecheck();
      useAppStore.getState().triggerRestoreReload();
      useAppStore.setState({ isLocked: false });
      useAppStore.setState({ isLocked: true });
      await kurasMicrotask();

      expect(jejak).toEqual(['batch:mulai']); // tidak bertambah
    } finally {
      unsub();
      lepas();
    }
  });
});

// ===========================================================================
// §20/§21/§22 — Dashboard bukan trigger; Bayar Kewajiban bukan coordinator;
// tanpa polling DB (struktural, referensi silang dengan KewajibanRcS74.test.ts)
// ===========================================================================

describe('HARDENING RC-S74 (final) — struktur: Dashboard, Bayar Kewajiban, tanpa polling', () => {
  const dashboard = tanpaKomentar(baca('src/screens/Dashboard/DashboardScreen.tsx'));
  const bayarForm = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
  const appIndex = tanpaKomentar(baca('app/index.tsx'));

  it('TEST 20 — Dashboard tidak mengimpor/memanggil StartupTasks sama sekali (bukan trigger, mount/focus berkali-kali tidak membuat batch)', () => {
    expect(dashboard).not.toMatch(/jalankanTugasStartup|consumeStartupTaskRequest|startupTaskRequested|from '@\/services\/StartupTasks'/);
  });

  it('TEST 21 — BayarUtangFormScreen TIDAK mengandung jalankanTugasStartup atau jalankanAkrualBungaUtangJikaPerlu (bukan coordinator)', () => {
    expect(bayarForm).not.toMatch(/jalankanTugasStartup|jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis/);
  });

  it('TEST 22 — coordinator (subscription + fallback) tidak polling database: tanpa setInterval/setTimeout/AppState, tanpa getStatusBungaSemuaUtang()', () => {
    const iSub = appIndex.indexOf('useAppStore.subscribe((state, prevState) => {');
    const iAkhirFile = appIndex.length;
    const blokCoordinator = appIndex.slice(iSub, iAkhirFile);
    expect(blokCoordinator).not.toMatch(/setInterval|setTimeout|AppState\.addEventListener|getStatusBungaSemuaUtang/);
  });
});
