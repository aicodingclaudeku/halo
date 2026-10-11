import { bacaPasangan, pasanganDiMemori, type DataPasangan } from './SyncIdentitas';
import { infoPlatformSinkron } from '@/desktop/platformSinkron';

/**
 * PERANGKAT UTAMA (BUKU INDUK) UNTUK TUGAS OTOMATIS.
 *
 * Tugas startup (penyusutan, akrual jasa, EIR, akrual simpanan
 * berjangka, bunga sukarela, akrual bunga utang) membuat jurnal secara
 * otomatis. Bila HP dan desktop sama-sama menjalankannya selagi offline,
 * keduanya membuat jurnal yang sama dengan ID berbeda dan sinkron
 * berikutnya PASTI konflik. Karena itu, SELAMA terpasang, hanya
 * perangkat utama yang menjalankannya; hasilnya sampai ke perangkat lain
 * lewat sinkronisasi.
 *
 * Perangkat yang TIDAK pernah dipasangkan → selalu `true` (perilaku
 * Android lama tidak berubah sedikit pun).
 *
 * Data pemasangan dimuat ke memori saat modul ini dimuat, sehingga
 * pemeriksaan di jalur startup bersifat SINKRON (tidak menambah satu pun
 * jeda async pada urutan tugas yang sudah ada).
 */

const muatAwal: Promise<unknown> = bacaPasangan().catch(() => null);

function nilai(p: DataPasangan | null): boolean {
  if (!p || !p.baseline) return true;
  // RC-S133.4 — selama terpasang, KOPKU Desktop adalah buku induk tunggal;
  // HP adalah penyimpanan cadangan baca-saja dan tidak pernah menjurnal.
  return infoPlatformSinkron().jenis === 'DESKTOP';
}

/** `true`/`false` bila data pemasangan sudah di memori; `null` bila belum. */
export function bolehTugasOtomatisSinkron(): boolean | null {
  const p = pasanganDiMemori();
  return p === undefined ? null : nilai(p);
}

export async function bolehMenjalankanTugasOtomatis(): Promise<boolean> {
  const cepat = bolehTugasOtomatisSinkron();
  if (cepat !== null) return cepat;
  try {
    await muatAwal;
    return nilai((await bacaPasangan()) ?? null);
  } catch {
    return true;
  }
}
