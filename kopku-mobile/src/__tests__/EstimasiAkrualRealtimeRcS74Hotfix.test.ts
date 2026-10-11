import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * HOTFIX RC-S74 — KEWAJIBAN / UTANG BUNGA: ESTIMASI REAL-TIME + SEMBUNYIKAN Rp0 BASI.
 *
 * Berkas ini menguji bagian yang TIDAK butuh database:
 *  - metadata runtime `StartupTasks` (mulai, rolling average durasi AKTUAL),
 *    dengan jam (`Date.now`) yang dikendalikan test — durasi bukan angka tetap;
 *  - helper murni teks estimasi (`teksMemuatBunga`, `hitungSisaEstimasiDetik`);
 *  - helper murni kegagalan akrual (`akrualBungaGagalUntuk`, `infoDariDetail`);
 *  - hook `useDetikMemuat` dengan titik mulai nyata (timer cleanup);
 *  - struktur layar (tanpa polling DB, tanpa angka 9 tetap, tanpa pemicu akrual).
 *
 * Skenario pengguna end-to-end dengan SQLite sungguhan ada di
 * `SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts`.
 *
 * Seluruh pekerjaan StartupTasks di-mock di sini supaya durasi batch dapat
 * DIKENDALIKAN (ditahan sampai test melepaskannya). Tidak ada accounting yang
 * dijalankan di berkas ini.
 */

// --------------------------------------------------------------------------
// Mock pekerjaan latar: setiap batch ditahan sampai `lepas()` dipanggil.
// --------------------------------------------------------------------------
let penahan: Array<() => void> = [];
let gagalBerikutnya = false;
const jejak: string[] = [];

jest.mock('@/services/PenyusutanService', () => ({
  jalankanPenyusutanOtomatisJikaPerlu: jest.fn(async () => {
    jejak.push('batch:mulai');
    await new Promise<void>((r) => penahan.push(r));
  }),
}));
jest.mock('@/services/AkrualJasaPinjamanService', () => ({ jalankanAkrualJasaOtomatisJikaPerlu: jest.fn(async () => undefined) }));
jest.mock('@/services/EirAccountingService', () => ({
  jalankanEirOtomatisJikaPerlu: jest.fn(async () => {
    if (gagalBerikutnya) {
      gagalBerikutnya = false;
      throw new Error('kegagalan tak terduga');
    }
  }),
}));
jest.mock('@/services/SimpananBerjangkaCatchUpService', () => ({ jalankanCatchUpAkrualSimpananBerjangka: jest.fn(async () => undefined) }));
jest.mock('@/services/SimpananBerjangkaBackgroundTask', () => ({ daftarkanTaskAkrualBerjangka: jest.fn(async () => true) }));
jest.mock('@/services/UtangBungaAccrualService', () => ({
  jalankanAkrualBungaUtangJikaPerlu: jest.fn(async () => {
    jejak.push('akrualBunga');
    return { dijalankan: true, periodeDiproses: [], exception: [], totalDibukukan: 0, jumlahJurnalBaru: 0 };
  }),
}));

import {
  jalankanTugasStartup,
  tungguTugasStartupSelesai,
  getStatusTugasStartup,
  MAKS_SAMPEL_DURASI_TUGAS,
  _resetTugasStartupUntukTest,
} from '@/services/StartupTasks';
import { jalankanAkrualBungaUtangJikaPerlu } from '@/services/UtangBungaAccrualService';
import {
  teksMemuatBunga,
  hitungSisaEstimasiDetik,
  akrualBungaGagalUntuk,
  infoDariDetail,
  infoBungaUntuk,
  bungaSiapUntukBayar,
  teksNilaiBunga,
  InfoBunga,
  TEKS_MEMUAT_AWAL,
  TEKS_ESTIMASI_TANPA_RIWAYAT,
  TEKS_MELEWATI_ESTIMASI,
  TEKS_PENJELASAN_PROSES,
} from '@/screens/Transaksi/bayarUtangGate';
import { mulaiPenghitungDetik } from '@/hooks/useDetikMemuat';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Jam yang dikendalikan test: `Date.now()` di StartupTasks membaca nilai ini. */
let jam = 1_000_000;
let spyNow: jest.SpyInstance;

/** Tunggu sampai rantai microtask sempat berjalan (bukan penundaan waktu). */
async function kuras(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
/** Lepaskan batch yang sedang ditahan. */
function lepas(): void {
  const r = penahan.shift();
  if (!r) throw new Error('tidak ada batch yang ditahan');
  r();
}
/** Jalankan satu batch dengan durasi AKTUAL `durasiMs` (jam maju selama batch berjalan). */
async function batchBerdurasi(durasiMs: number): Promise<void> {
  const t = jalankanTugasStartup('user-1');
  await kuras();
  jam += durasiMs;
  lepas();
  await t;
}

beforeEach(() => {
  penahan = [];
  gagalBerikutnya = false;
  jejak.length = 0;
  jam = 1_000_000;
  _resetTugasStartupUntukTest();
  (jalankanAkrualBungaUtangJikaPerlu as jest.Mock).mockClear();
  spyNow = jest.spyOn(Date, 'now').mockImplementation(() => jam);
});
afterEach(() => spyNow.mockRestore());

// ===========================================================================
// 1. Metadata runtime StartupTasks
// ===========================================================================

describe('HOTFIX RC-S74 — metadata runtime StartupTasks', () => {
  it('tidak ada tugas: tidak berjalan, tanpa mulai, tanpa riwayat', () => {
    expect(getStatusTugasStartup()).toEqual({ berjalan: false, mulaiMs: null, estimasiMs: null, jumlahSampel: 0 });
  });

  it('selama batch berjalan: berjalan=true & mulaiMs = saat batch BENAR-BENAR mulai; sesudahnya bersih', async () => {
    const t = jalankanTugasStartup('user-1');
    await kuras();
    expect(getStatusTugasStartup()).toMatchObject({ berjalan: true, mulaiMs: 1_000_000 });
    jam += 4_321;
    lepas();
    await t;
    expect(getStatusTugasStartup()).toEqual({ berjalan: false, mulaiMs: null, estimasiMs: 4_321, jumlahSampel: 1 });
  });

  it('TEST 4 — estimasi = durasi AKTUAL yang terukur, bukan angka tetap', async () => {
    await batchBerdurasi(3_000);
    expect(getStatusTugasStartup().estimasiMs).toBe(3_000);
    _resetTugasStartupUntukTest();
    await batchBerdurasi(12_500);
    expect(getStatusTugasStartup().estimasiMs).toBe(12_500); // angka lain -> estimasi lain
  });

  it('rolling average dari 8,7 / 9,2 / 8,9 detik = 8,933 detik -> UI "±9 detik"', async () => {
    for (const d of [8_700, 9_200, 8_900]) await batchBerdurasi(d);
    const st = getStatusTugasStartup();
    expect(st.jumlahSampel).toBe(3);
    expect(st.estimasiMs).toBeCloseTo((8_700 + 9_200 + 8_900) / 3, 6);
    expect(teksMemuatBunga({ estimasiMs: st.estimasiMs }, 0).estimasi).toBe('Estimasi selesai dalam ±9 detik');
  });

  it(`rolling average hanya ${MAKS_SAMPEL_DURASI_TUGAS} batch terakhir (sampel lama tergeser)`, async () => {
    for (const d of [60_000, 8_700, 9_200, 8_900, 9_000, 8_800]) await batchBerdurasi(d);
    const st = getStatusTugasStartup();
    expect(st.jumlahSampel).toBe(MAKS_SAMPEL_DURASI_TUGAS);
    expect(st.estimasiMs).toBe((8_700 + 9_200 + 8_900 + 9_000 + 8_800) / 5);
  });

  it('batch yang GAGAL tak terduga tidak mencemari estimasi & tidak menggantung gate', async () => {
    await batchBerdurasi(2_000);
    gagalBerikutnya = true;
    const t = jalankanTugasStartup('user-1');
    await kuras();
    jam += 50_000;
    lepas();
    await expect(t).rejects.toThrow('kegagalan tak terduga');
    await expect(tungguTugasStartupSelesai()).resolves.toBeUndefined();
    expect(getStatusTugasStartup()).toEqual({ berjalan: false, mulaiMs: null, estimasiMs: 2_000, jumlahSampel: 1 });
  });

  it('batch berantai: mulaiMs mengikuti batch yang SEDANG dieksekusi', async () => {
    const t1 = jalankanTugasStartup('user-1');
    const t2 = jalankanTugasStartup('user-1');
    await kuras();
    expect(getStatusTugasStartup().mulaiMs).toBe(1_000_000);
    jam += 1_000;
    lepas();
    await t1;
    await kuras();
    expect(getStatusTugasStartup()).toMatchObject({ berjalan: true, mulaiMs: 1_001_000 });
    jam += 3_000;
    lepas();
    await t2;
    expect(getStatusTugasStartup()).toEqual({ berjalan: false, mulaiMs: null, estimasiMs: 2_000, jumlahSampel: 2 });
  });

  it('urutan pekerjaan batch TIDAK berubah (akrual bunga utang tetap dijalankan, sekali per batch)', async () => {
    await batchBerdurasi(100);
    expect(jejak).toEqual(['batch:mulai', 'akrualBunga']);
    expect(jalankanAkrualBungaUtangJikaPerlu).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. Estimasi BUKAN timeout (§8/§9)
// ===========================================================================

describe('HOTFIX RC-S74 — estimasi hanya informasi, bukan timeout', () => {
  it('estimasi terlampaui jauh: task TIDAK dibatalkan, TIDAK diulang, gate tetap menunggu promise nyata', async () => {
    await batchBerdurasi(9_000); // riwayat: 9 detik
    const t = jalankanTugasStartup('user-1');
    let gateSelesai = false;
    void tungguTugasStartupSelesai().then(() => {
      gateSelesai = true;
    });
    await kuras();
    const st = getStatusTugasStartup();
    jam += 60_000; // jauh melewati estimasi
    await kuras();
    expect(gateSelesai).toBe(false); // estimasi habis != selesai
    expect(teksMemuatBunga({ estimasiMs: st.estimasiMs }, jam - st.mulaiMs!).estimasi).toBe(TEKS_MELEWATI_ESTIMASI);
    expect(jalankanAkrualBungaUtangJikaPerlu).toHaveBeenCalledTimes(1); // tidak ada task kedua
    lepas();
    await t;
    await kuras();
    expect(gateSelesai).toBe(true); // selesai HANYA saat promise selesai
    expect(jalankanAkrualBungaUtangJikaPerlu).toHaveBeenCalledTimes(2); // batch pertama + batch ini, tanpa tambahan
  });
});

// ===========================================================================
// 3. Teks estimasi (helper murni)
// ===========================================================================

describe('HOTFIX RC-S74 — teks estimasi real-time', () => {
  it('TEST 5 — proses berjalan tanpa riwayat durasi -> "Estimasi beberapa detik"', () => {
    expect(teksMemuatBunga({ estimasiMs: null }, 0)).toEqual({
      judul: TEKS_MEMUAT_AWAL,
      estimasi: TEKS_ESTIMASI_TANPA_RIWAYAT,
      penjelasan: TEKS_PENJELASAN_PROSES,
    });
    expect(TEKS_MEMUAT_AWAL).toBe('Menghitung otomatis…');
    expect(TEKS_ESTIMASI_TANPA_RIWAYAT).toBe('Estimasi beberapa detik');
  });

  it('tanpa proses latar (hanya membaca read-model) -> judul saja, tanpa janji estimasi', () => {
    expect(teksMemuatBunga(null, 0)).toEqual({ judul: TEKS_MEMUAT_AWAL, estimasi: null, penjelasan: null });
  });

  it('TEST 6 — waktu berjalan bertambah -> sisa estimasi ikut turun (±9, ±8, … ±1, lalu "Proses masih berjalan…")', () => {
    const est = { estimasiMs: 8_900 };
    const urutan = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15].map((d) => teksMemuatBunga(est, d * 1000).estimasi);
    expect(urutan).toEqual([
      'Estimasi selesai dalam ±9 detik',
      'Estimasi selesai dalam ±8 detik',
      'Estimasi selesai dalam ±7 detik',
      'Estimasi selesai dalam ±6 detik',
      'Estimasi selesai dalam ±5 detik',
      'Estimasi selesai dalam ±4 detik',
      'Estimasi selesai dalam ±3 detik',
      'Estimasi selesai dalam ±2 detik',
      'Estimasi selesai dalam ±1 detik',
      TEKS_MELEWATI_ESTIMASI,
      TEKS_MELEWATI_ESTIMASI,
    ]);
  });

  it('angka estimasi mengikuti riwayat: 4,2 detik -> ±5 (ceil), 30 detik -> ±30', () => {
    expect(teksMemuatBunga({ estimasiMs: 4_200 }, 0).estimasi).toBe('Estimasi selesai dalam ±5 detik');
    expect(teksMemuatBunga({ estimasiMs: 30_000 }, 0).estimasi).toBe('Estimasi selesai dalam ±30 detik');
  });

  it('TEST 7 — sisa estimasi TIDAK PERNAH negatif', () => {
    for (const est of [1, 500, 8_900, 20_000]) {
      for (let ms = 0; ms <= 60_000; ms += 250) {
        expect(hitungSisaEstimasiDetik(est, ms)).toBeGreaterThanOrEqual(0);
        const t = teksMemuatBunga({ estimasiMs: est }, ms);
        expect(t.estimasi).not.toMatch(/-\d|±0\b/);
      }
    }
  });

  it('masukan tidak valid tidak menghasilkan angka palsu', () => {
    for (const x of [NaN, -5_000, Infinity]) {
      expect(teksMemuatBunga({ estimasiMs: 8_900 }, x).estimasi).toBe('Estimasi selesai dalam ±9 detik');
    }
    for (const e of [0, -1, NaN, Infinity]) {
      expect(teksMemuatBunga({ estimasiMs: e }, 0).estimasi).toBe(TEKS_ESTIMASI_TANPA_RIWAYAT);
    }
  });

  it('TEST 1–3 — teks MEMUAT tidak pernah berisi Rp0 / Perlu Perhatian / "belum tercatat"', () => {
    for (const p of [null, { estimasiMs: null }, { estimasiMs: 8_900 }]) {
      for (let ms = 0; ms <= 20_000; ms += 500) {
        const t = teksMemuatBunga(p, ms);
        expect([t.judul, t.estimasi, t.penjelasan].join(' ')).not.toMatch(/Rp|Perlu Perhatian|belum tercatat/);
      }
    }
    const memuat: InfoBunga = { utangId: 'u1', tahap: 'MEMUAT' };
    const u = { id: 'u1', jenisPemberi: 'BANK', persenBunga: 10 };
    expect(teksNilaiBunga(infoBungaUntuk(u, memuat)!)).toBe('Menghitung otomatis…');
    expect(bungaSiapUntukBayar(u, memuat)).toBe(false);
  });
});

// ===========================================================================
// 4. Kegagalan akrual (§13) — helper murni
// ===========================================================================

describe('HOTFIX RC-S74 — TEST 11: task gagal -> Rp0 basi tidak pernah tampil sebagai hasil valid', () => {
  const u = { id: 'u1', jenisPemberi: 'BANK', persenBunga: 10 };
  const detailBasi = { status: 'PERLU_PERHATIAN' as const, outstandingBunga: 0, pesan: 'Bunga periode 2026-08 belum tercatat.' };
  const ok = { dijalankan: true, exception: [] };

  it('mesin gagal total (dijalankan=false) -> AKRUAL_GAGAL, tampil "—", tombol terkunci', () => {
    const gagal = akrualBungaGagalUntuk('u1', { dijalankan: false, exception: [] });
    expect(gagal).toBe(true);
    const info = infoDariDetail('u1', detailBasi, gagal);
    expect(info).toEqual({ utangId: 'u1', tahap: 'AKRUAL_GAGAL' });
    expect(teksNilaiBunga(infoBungaUntuk(u, info)!)).toBe('—');
    expect(bungaSiapUntukBayar(u, info)).toBe(false);
  });

  it('KEGAGALAN_TEKNIS untuk utang INI -> gagal; untuk utang lain -> tidak memengaruhi', () => {
    const hasil = { dijalankan: true, exception: [{ utangId: 'u2', nomorUtang: 'U2', namaPemberi: 'X', periode: '2026-08', kode: 'KEGAGALAN_TEKNIS' as const, pesan: 'x' }] };
    expect(akrualBungaGagalUntuk('u2', hasil)).toBe(true);
    expect(akrualBungaGagalUntuk('u1', hasil)).toBe(false);
  });

  it('kondisi DATA (kontrak belum lengkap, periode tertutup, dibalik) BUKAN kegagalan — status accounting tetap tampil', () => {
    for (const kode of ['KONTRAK_BELUM_LENGKAP', 'PERIODE_TERTUTUP', 'AKRUAL_DIREVERSAL'] as const) {
      const hasil = { dijalankan: true, exception: [{ utangId: 'u1', nomorUtang: 'U1', namaPemberi: 'X', periode: '2026-08', kode: kode as any, pesan: 'x' }] };
      expect(akrualBungaGagalUntuk('u1', hasil)).toBe(false);
    }
  });

  it('mesin belum pernah berjalan di proses ini (null) -> tidak ada bukti kegagalan', () => {
    expect(akrualBungaGagalUntuk('u1', null)).toBe(false);
    expect(akrualBungaGagalUntuk('u1', undefined)).toBe(false);
  });

  it('TEST 10 — mesin sukses & hasil accounting benar-benar Rp0 -> Rp0 tetap boleh tampil (SIAP)', () => {
    const info = infoDariDetail('u1', { status: 'MENUNGGU_PERIODE', outstandingBunga: 0, pesan: null }, akrualBungaGagalUntuk('u1', ok));
    expect(info).toEqual({ utangId: 'u1', tahap: 'SIAP', nilai: 0, statusBunga: 'MENUNGGU_PERIODE', pesanBunga: null });
    expect(teksNilaiBunga(infoBungaUntuk(u, info)!)).toBe('Rp0');
  });

  it('argumen ketiga default false: pemanggil lama infoDariDetail(utangId, detail) tetap berperilaku sama', () => {
    expect(infoDariDetail('u1', detailBasi)).toEqual({ utangId: 'u1', tahap: 'SIAP', nilai: 0, statusBunga: 'PERLU_PERHATIAN', pesanBunga: detailBasi.pesan });
    expect(infoDariDetail('u1', undefined, true)).toEqual({ utangId: 'u1', tahap: 'TIDAK_TERSEDIA' });
  });
});

// ===========================================================================
// 5. Timer tampilan dengan titik mulai nyata (TEST 8)
// ===========================================================================

/** Harness hook minimal (sama pola dengan KewajibanRcS74.test.ts), mendukung argumen mulaiMs. */
function renderHookDetik(awal: { aktif: boolean; kunci: string; mulaiMs: number | null }) {
  const st = {
    states: [] as unknown[],
    effects: [] as ({ deps: unknown[]; cleanup?: () => void } | undefined)[],
    si: 0,
    ei: 0,
    pending: [] as (() => void)[],
    sibuk: false,
    kotor: false,
    terpasang: true,
  };
  let props = awal;
  let hasil = -1;
  const render = () => {
    if (!st.terpasang) return;
    if (st.sibuk) {
      st.kotor = true;
      return;
    }
    st.sibuk = true;
    do {
      st.kotor = false;
      st.si = 0;
      st.ei = 0;
      hasil = useDetikMemuat(props.aktif, props.kunci, props.mulaiMs);
      for (const f of st.pending.splice(0)) f();
    } while (st.kotor);
    st.sibuk = false;
  };
  const reactPalsu = {
    useState(init: unknown) {
      const i = st.si++;
      if (!(i in st.states)) st.states[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const n = typeof v === 'function' ? (v as (x: unknown) => unknown)(st.states[i]) : v;
        if (Object.is(n, st.states[i])) return;
        st.states[i] = n;
        render();
      };
      return [st.states[i], set];
    },
    useLayoutEffect(fn: () => void | (() => void), deps: unknown[]) {
      const i = st.ei++;
      const prev = st.effects[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        st.pending.push(() => {
          prev?.cleanup?.();
          const c = fn();
          st.effects[i] = { deps, cleanup: typeof c === 'function' ? c : undefined };
        });
      }
    },
  };
  let useDetikMemuat!: (aktif: boolean, kunci: string, mulaiMs?: number | null) => number;
  jest.isolateModules(() => {
    jest.doMock('react', () => reactPalsu);
    useDetikMemuat = require('@/hooks/useDetikMemuat').useDetikMemuat;
  });
  render();
  return {
    get detik() {
      return hasil;
    },
    rerender(p: { aktif: boolean; kunci: string; mulaiMs: number | null }) {
      props = p;
      render();
    },
    unmount() {
      for (const e of st.effects) e?.cleanup?.();
      st.effects = [];
      st.terpasang = false;
    },
  };
}

describe('HOTFIX RC-S74 — TEST 8: timer tampilan diukur dari mulai proses nyata & selalu dibersihkan', () => {
  beforeEach(() => {
    spyNow.mockRestore(); // fake timers mengendalikan Date.now di bagian ini
    jest.useFakeTimers({ now: new Date('2026-09-23T09:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    spyNow = jest.spyOn(Date, 'now').mockImplementation(() => jam);
  });

  it('mulaiPenghitungDetik dengan mulaiMs lampau: nilai pertama = waktu yang SUDAH berjalan', () => {
    const nilai: number[] = [];
    const p = mulaiPenghitungDetik((d) => nilai.push(d), Date.now, Date.now() - 3_000);
    expect(nilai).toEqual([3]);
    jest.advanceTimersByTime(2_000);
    expect(nilai).toEqual([3, 4, 5]);
    p.berhenti();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('hook: proses mulai 2 dtk sebelum layar -> 2, 3, 4…; task selesai -> timer mati; unmount -> bersih', () => {
    const mulai = Date.now() - 2_000;
    const h = renderHookDetik({ aktif: true, kunci: 'u1:0', mulaiMs: mulai });
    expect(h.detik).toBe(2);
    jest.advanceTimersByTime(2_000);
    expect(h.detik).toBe(4);
    expect(jest.getTimerCount()).toBe(1);
    h.rerender({ aktif: false, kunci: 'u1:0', mulaiMs: mulai }); // task selesai -> SIAP
    expect(jest.getTimerCount()).toBe(0);
    expect(h.detik).toBe(0);
    h.rerender({ aktif: true, kunci: 'u1:1', mulaiMs: null }); // "Coba lagi": hitungan baru dari 0
    expect(h.detik).toBe(0);
    expect(jest.getTimerCount()).toBe(1);
    h.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('pergantian mulaiMs tidak pernah menumpuk interval', () => {
    const h = renderHookDetik({ aktif: true, kunci: 'u1:0', mulaiMs: Date.now() });
    h.rerender({ aktif: true, kunci: 'u1:0', mulaiMs: Date.now() - 5_000 });
    expect(jest.getTimerCount()).toBe(1);
    expect(h.detik).toBe(5);
    h.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ===========================================================================
// 6. Struktur layar & modul (TEST 9, 12, larangan)
// ===========================================================================

describe('HOTFIX RC-S74 — struktur: tanpa polling DB, tanpa angka tetap, tanpa pemicu baru', () => {
  const layar = tanpaKomentar(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
  const helper = tanpaKomentar(baca('src/screens/Transaksi/bayarUtangGate.ts'));
  const hook = tanpaKomentar(baca('src/hooks/useDetikMemuat.ts'));
  const startup = tanpaKomentar(baca('src/services/StartupTasks.ts'));
  const blokMemuat = layar.slice(layar.indexOf("{bungaTampil?.tahap === 'MEMUAT' ? ("), layar.indexOf(') : bungaTampil ? ('));

  it('TEST 12 — getStatusBungaSemuaUtang() dipanggil SEKALI, hanya setelah gate, di efek berdependensi [utang, Coba lagi] — bukan per detik', () => {
    expect(layar.match(/getStatusBungaSemuaUtang\(/g)).toHaveLength(1);
    const iGate = layar.indexOf('await tungguTugasStartupSelesai();');
    const iBaca = layar.indexOf('await getStatusBungaSemuaUtang()');
    expect(iGate).toBeGreaterThan(0);
    expect(iBaca).toBeGreaterThan(iGate);
    const iTutupEfek = layar.indexOf('}, [utang?.id, muatUlangBunga]);', iBaca);
    expect(iTutupEfek).toBeGreaterThan(iBaca); // efek baca tidak bergantung pada detikMemuat
    expect(layar).not.toMatch(/setInterval|setTimeout/);
    for (const src of [hook, helper]) expect(src).not.toMatch(/getStatusBungaSemuaUtang|tungguTugasStartupSelesai|@\/database/);
  });

  it('TEST 9 — hasil diterapkan setelah gate; status kegagalan dari hasil mesin yang ada (bukan pemicu baru)', () => {
    expect(layar).toMatch(
      /const akrualGagal = akrualBungaGagalUntuk\(utangId, getHasilAkrualBungaUtangTerakhir\(\)\);\s*if \(!aktif\) return;\s*setInfoBunga\(infoDariDetail\(utangId, detail, akrualGagal\)\);/
    );
    expect(layar).not.toMatch(/jalankanTugasStartup|jalankanAkrualBungaUtangJikaPerlu|prosesAkrualBungaUtangOtomatis|akruiBungaUtang|requestStartupTask|consumeStartupTaskRequest/);
  });

  it('estimasi dari metadata runtime StartupTasks — tidak ada angka detik/milidetik tetap', () => {
    expect(layar).toContain('const proses = getStatusTugasStartup();');
    expect(layar).toContain('const memuat = teksMemuatBunga(prosesBunga, detikMemuat * 1000);');
    for (const src of [layar, helper, hook, startup]) {
      expect(src).not.toMatch(/±\s*9\b|\b9\s*detik|\b9000\b|\b9_000\b|estimasi\w*\s*=\s*\d/i);
    }
  });

  it('blok MEMUAT: spinner + estimasi + penjelasan; tanpa nilai rupiah & tanpa status accounting', () => {
    expect(blokMemuat).toContain('<ActivityIndicator size="small"');
    expect(blokMemuat).toContain('{memuat.judul}');
    expect(blokMemuat).toContain('{memuat.estimasi ?');
    expect(blokMemuat).toContain('{memuat.penjelasan ?');
    expect(blokMemuat).not.toMatch(/formatRupiah|teksNilaiBunga|LABEL_STATUS_BUNGA_UTANG|statusBunga|pesanBunga|Rp0/);
  });

  it('blok AKRUAL_GAGAL: "Perhitungan belum selesai" + "Gagal memperbarui akrual otomatis." + Coba lagi (baca ulang saja)', () => {
    const i = layar.indexOf("{bungaTampil?.tahap === 'AKRUAL_GAGAL' ? (");
    expect(i).toBeGreaterThan(0);
    const blok = layar.slice(i, layar.indexOf(') : null}', i));
    expect(blok).toContain('Perhitungan belum selesai');
    expect(blok).toContain('Gagal memperbarui akrual otomatis.');
    expect(blok).toContain('onPress={() => setMuatUlangBunga((n) => n + 1)}');
    expect(blok).not.toMatch(/formatRupiah|Rp0|LABEL_STATUS_BUNGA_UTANG/);
  });

  it('metadata StartupTasks: runtime memory saja — tanpa DB, tanpa timer, tanpa persist', () => {
    expect(startup).not.toMatch(/setInterval|setTimeout|runAsync|getDb|AsyncStorage|SecureStore/);
    expect(startup).toMatch(/export function getStatusTugasStartup\(\): StatusTugasStartup/);
  });

  it('hook tetap hanya mengimpor react', () => {
    expect(hook.match(/^import .* from '[^']+';$/gm)).toEqual(["import { useLayoutEffect, useState } from 'react';"]);
  });

  it('helper tetap murni: hanya import TIPE dari service', () => {
    expect(helper).not.toMatch(/^import \{[^}]*\} from '@\/services\//m);
    expect(helper).toMatch(/^import type \{[^}]*HasilProsesAkrualOtomatis[^}]*\} from '@\/services\/UtangBungaAccrualService';$/m);
  });
});
