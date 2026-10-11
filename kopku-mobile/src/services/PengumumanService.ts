/**
 * RC-S125 — PENGUMUMAN & NOTIFIKASI DARI WEBSITE KOPKU
 * =========================================================================
 *
 * Mengambil pengumuman yang diterbitkan admin di website (target
 * "Aplikasi" atau "Website & Aplikasi") lewat `GET /api/announcements.php`.
 *
 * Prinsip yang dijaga (sama dengan sistem lisensi):
 *   - OFFLINE-FIRST. Gagal jaringan bukan error yang perlu ditampilkan;
 *     daftar terakhir yang tersimpan tetap dipakai.
 *   - TIDAK MEMBEBANI SERVER. Paling sering satu request per 30 menit,
 *     memakai ETag (server menjawab 304 tanpa isi bila tidak ada yang
 *     berubah), dan pemanggilan bersamaan diantrikan jadi satu request.
 *   - TIDAK MENYENTUH DATA KOPERASI. Tidak ada data anggota/transaksi yang
 *     dikirim; tidak ada tulis ke database akuntansi. Cache disimpan di
 *     satu berkas JSON terpisah.
 *   - ISI DIPERLAKUKAN SEBAGAI TEKS. Tidak ada HTML yang dirender, dan
 *     tautan hanya diterima bila https.
 */
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { LICENSE_API_BASE } from '@/config/license';
import { getDevicePlatform } from '@/security/devicePlatform';

export type LevelPengumuman = 'info' | 'update' | 'penting' | 'promo';

export interface Pengumuman {
  readonly id: number;
  readonly judul: string;
  readonly isi: string;
  readonly level: LevelPengumuman;
  readonly tautan: string | null;
  readonly labelTautan: string | null;
  readonly disematkan: boolean;
  readonly terbitPada: string | null;
}

export interface RilisTerbaru {
  readonly versi: string | null;
  readonly url: string | null;
}

export interface CachePengumuman {
  readonly etag: string | null;
  readonly diambilPadaMs: number;
  readonly items: readonly Pengumuman[];
  readonly rilis: Readonly<Record<string, RilisTerbaru>>;
  /** Kunci yang sudah dibaca: `a:<id>` untuk pengumuman, `n:<kunci>` untuk notifikasi lokal. */
  readonly dibaca: readonly string[];
}

const NAMA_BERKAS = 'kopku-pengumuman.json';
const JEDA_MINIMUM_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8_000;
const MAKS_ITEM = 30;
const MAKS_DIBACA = 300;
const LEVEL: readonly LevelPengumuman[] = ['info', 'update', 'penting', 'promo'];

const KOSONG: CachePengumuman = { etag: null, diambilPadaMs: 0, items: [], rilis: {}, dibaca: [] };

let cacheMemori: CachePengumuman | null = null;
let permintaanBerjalan: Promise<CachePengumuman> | null = null;

function lokasiBerkas(): string | null {
  const dir = FileSystem.documentDirectory;
  return dir ? `${dir}${NAMA_BERKAS}` : null;
}

export function versiAplikasi(): string {
  const v = Constants.expoConfig?.version;
  return typeof v === 'string' && v.length > 0 ? v : '0.0.0';
}

/** Bandingkan "1.2.10" vs "1.2.9" secara numerik. Positif bila a > b. */
export function bandingkanVersi(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function teks(nilai: unknown, maks: number): string {
  return typeof nilai === 'string' ? nilai.trim().slice(0, maks) : '';
}

function tautanAman(nilai: unknown): string | null {
  const t = teks(nilai, 255);
  return /^https:\/\/[^\s<>"']+$/i.test(t) ? t : null;
}

function sanitasiItem(raw: unknown): Pengumuman | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'number' ? r.id : parseInt(String(r.id ?? ''), 10);
  const judul = teks(r.title, 150);
  const isi = teks(r.body, 2000);
  if (!Number.isFinite(id) || id <= 0 || judul === '') return null;
  const level = LEVEL.includes(r.level as LevelPengumuman) ? (r.level as LevelPengumuman) : 'info';
  const terbit = teks(r.published_at, 40);
  return {
    id,
    judul,
    isi,
    level,
    tautan: tautanAman(r.link_url),
    labelTautan: teks(r.link_label, 60) || null,
    disematkan: r.pinned === true,
    terbitPada: terbit !== '' && Number.isFinite(Date.parse(terbit)) ? terbit : null,
  };
}

function sanitasiRilis(raw: unknown): Record<string, RilisTerbaru> {
  const hasil: Record<string, RilisTerbaru> = {};
  if (typeof raw !== 'object' || raw === null) return hasil;
  for (const [platform, isi] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2,12}$/.test(platform) || typeof isi !== 'object' || isi === null) continue;
    const r = isi as Record<string, unknown>;
    hasil[platform] = { versi: teks(r.version, 50) || null, url: tautanAman(r.url) };
  }
  return hasil;
}

async function bacaCache(): Promise<CachePengumuman> {
  if (cacheMemori) return cacheMemori;
  const lokasi = lokasiBerkas();
  if (!lokasi) return KOSONG;
  try {
    const info = await FileSystem.getInfoAsync(lokasi);
    if (!info.exists) return (cacheMemori = KOSONG);
    const data = JSON.parse(await FileSystem.readAsStringAsync(lokasi)) as Partial<CachePengumuman>;
    cacheMemori = {
      etag: typeof data.etag === 'string' ? data.etag : null,
      diambilPadaMs: typeof data.diambilPadaMs === 'number' ? data.diambilPadaMs : 0,
      items: Array.isArray(data.items) ? data.items.map(sanitasiUlang).filter((x): x is Pengumuman => x !== null) : [],
      rilis: sanitasiRilisCache(data.rilis),
      dibaca: Array.isArray(data.dibaca) ? data.dibaca.filter((k): k is string => typeof k === 'string').slice(-MAKS_DIBACA) : [],
    };
    return cacheMemori;
  } catch {
    return (cacheMemori = KOSONG);
  }
}

/** Item dari cache sudah berbentuk `Pengumuman`; tetap divalidasi karena berkas bisa rusak. */
function sanitasiUlang(raw: unknown): Pengumuman | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return sanitasiItem({
    id: r.id,
    title: r.judul,
    body: r.isi,
    level: r.level,
    link_url: r.tautan,
    link_label: r.labelTautan,
    pinned: r.disematkan,
    published_at: r.terbitPada,
  });
}

function sanitasiRilisCache(raw: unknown): Record<string, RilisTerbaru> {
  const hasil: Record<string, RilisTerbaru> = {};
  if (typeof raw !== 'object' || raw === null) return hasil;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    hasil[k] = { versi: teks(r.versi, 50) || null, url: tautanAman(r.url) };
  }
  return hasil;
}

async function simpanCache(cache: CachePengumuman): Promise<void> {
  cacheMemori = cache;
  const lokasi = lokasiBerkas();
  if (!lokasi) return;
  try {
    await FileSystem.writeAsStringAsync(lokasi, JSON.stringify(cache));
  } catch {
    // Cache hanya kenyamanan. Gagal menulis tidak boleh mengganggu aplikasi.
  }
}

async function ambilDariServer(cache: CachePengumuman): Promise<CachePengumuman> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url =
    `${LICENSE_API_BASE}/announcements.php?platform=${encodeURIComponent(getDevicePlatform())}` +
    `&v=${encodeURIComponent(versiAplikasi())}`;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cache.etag && cache.items.length > 0) headers['If-None-Match'] = cache.etag;
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const sekarang = Date.now();
    if (res.status === 304) {
      const baru = { ...cache, diambilPadaMs: sekarang };
      await simpanCache(baru);
      return baru;
    }
    if (res.status !== 200) return cache;
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    if (body.ok !== true || !Array.isArray(body.items)) return cache;
    const items = body.items
      .map(sanitasiItem)
      .filter((x): x is Pengumuman => x !== null)
      .slice(0, MAKS_ITEM);
    const etag = res.headers.get('etag');
    const baru: CachePengumuman = {
      etag: etag && etag.length < 100 ? etag : null,
      diambilPadaMs: sekarang,
      items,
      rilis: sanitasiRilis(body.latest),
      dibaca: cache.dibaca,
    };
    await simpanCache(baru);
    return baru;
  } catch {
    return cache; // offline / timeout / respons rusak -> pakai yang terakhir
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Muat pengumuman. Tanpa `paksa`, server hanya dihubungi bila data
 * terakhir lebih tua dari 30 menit. Pemanggilan bersamaan berbagi satu
 * request (antrian single-flight).
 */
export async function muatPengumuman(paksa = false): Promise<CachePengumuman> {
  if (permintaanBerjalan) return permintaanBerjalan;
  permintaanBerjalan = (async () => {
    const cache = await bacaCache();
    if (!paksa && Date.now() - cache.diambilPadaMs < JEDA_MINIMUM_MS) return cache;
    return ambilDariServer(cache);
  })().finally(() => {
    permintaanBerjalan = null;
  });
  return permintaanBerjalan;
}

export async function tandaiSudahDibaca(kunci: readonly string[]): Promise<CachePengumuman> {
  const cache = await bacaCache();
  const set = new Set(cache.dibaca);
  let berubah = false;
  for (const k of kunci) {
    if (!set.has(k)) {
      set.add(k);
      berubah = true;
    }
  }
  if (!berubah) return cache;
  const baru = { ...cache, dibaca: Array.from(set).slice(-MAKS_DIBACA) };
  await simpanCache(baru);
  return baru;
}
