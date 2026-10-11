import * as SecureStore from 'expo-secure-store';
import { idAcak } from './SyncKripto';
import { infoPlatformSinkron } from '@/desktop/platformSinkron';

/**
 * Identitas sinkron & data pemasangan — disimpan di SECURE STORE
 * perangkat (Keystore Android / DPAPI-Keychain di desktop), BUKAN di
 * database. Alasannya: database ikut berpindah saat snapshot/restore,
 * sedangkan kunci pemasangan, peran perangkat, baseline, dan penanda
 * high-water-mark harus tetap melekat ke perangkat fisik.
 */

const KUNCI_PERANGKAT = 'kopku.sync.perangkat';
const KUNCI_PASANGAN = 'kopku.sync.pasangan';

export type JenisPerangkat = 'DESKTOP' | 'HP';

export interface IdentitasPerangkat {
  id: string;
  nama: string;
  jenis: JenisPerangkat;
}

export interface DataPasangan {
  peerId: string;
  peerNama: string;
  /** Kunci jangka panjang (base64). */
  kunci: string;
  /** Alamat IPv4 pasangan (hanya relevan di HP). */
  alamat: string[];
  port: number;
  dipasangPada: string;
  /** Baseline data bersama; null = belum memilih data awal. */
  baseline: string | null;
  /** High-water mark nomor urut changelog lokal saat sinkron terakhir. */
  hwm: number;
  /** Perangkat yang menjalankan tugas otomatis (akrual, penyusutan, dsb.). */
  perangkatUtama: JenisPerangkat;
  /** Keputusan konflik yang menunggu dieksekusi (diset di desktop). */
  keputusan?: 'PAKAI_DESKTOP' | 'PAKAI_HP' | null;
  terakhirSinkron?: string | null;
  /** license_id lisensi HP yang terpasang (desktop) — sinkron hanya untuk lisensi yang sama. */
  lisensiId?: number | null;
  /** HP: desktop telah memutus pemasangan ini. HP tetap cadangan baca-saja sampai dipindai ulang / diputus di HP. */
  diputusDesktop?: boolean;
}

let cachePerangkat: IdentitasPerangkat | null = null;
/** Salinan data pemasangan di memori; `undefined` = belum pernah dibaca. */
let cachePasangan: DataPasangan | null | undefined;

/** Baca sinkron dari memori (tanpa I/O). `undefined` bila belum dimuat. */
export function pasanganDiMemori(): DataPasangan | null | undefined {
  return cachePasangan;
}

export async function identitasPerangkat(): Promise<IdentitasPerangkat> {
  if (cachePerangkat) return cachePerangkat;
  const p = infoPlatformSinkron();
  const raw = await SecureStore.getItemAsync(KUNCI_PERANGKAT);
  if (raw) {
    try {
      const o = JSON.parse(raw) as IdentitasPerangkat;
      cachePerangkat = { ...o, jenis: p.jenis, nama: p.nama || o.nama };
      return cachePerangkat;
    } catch {
      /* buat baru */
    }
  }
  const baru: IdentitasPerangkat = { id: `${p.jenis === 'DESKTOP' ? 'PC' : 'HP'}-${idAcak()}`, nama: p.nama, jenis: p.jenis };
  await SecureStore.setItemAsync(KUNCI_PERANGKAT, JSON.stringify(baru));
  cachePerangkat = baru;
  return baru;
}

export async function bacaPasangan(): Promise<DataPasangan | null> {
  try {
    const raw = await SecureStore.getItemAsync(KUNCI_PASANGAN);
    cachePasangan = raw ? (JSON.parse(raw) as DataPasangan) : null;
    return cachePasangan;
  } catch {
    return null;
  }
}

export async function simpanPasangan(p: DataPasangan): Promise<void> {
  await SecureStore.setItemAsync(KUNCI_PASANGAN, JSON.stringify(p));
  cachePasangan = p;
}

export async function perbaruiPasangan(ubah: Partial<DataPasangan>): Promise<DataPasangan | null> {
  const p = await bacaPasangan();
  if (!p) return null;
  const baru = { ...p, ...ubah };
  await simpanPasangan(baru);
  return baru;
}

export async function hapusPasangan(): Promise<void> {
  await SecureStore.deleteItemAsync(KUNCI_PASANGAN);
  cachePasangan = null;
}
