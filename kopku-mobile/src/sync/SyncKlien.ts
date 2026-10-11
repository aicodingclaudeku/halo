import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { getDb } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { pasangInfrastrukturSinkron, bacaMeta, cabutInfrastrukturSinkron } from './SyncSchema';
import {
  ambilPerubahanLokal,
  bacaKursor,
  BATAS_PAKET,
  cariKonflik,
  catatRiwayat,
  KonflikSinkronError,
  kunciPerubahanLokalSejak,
  nomorUrutChangelog,
  seqLokalTertinggi,
  sqlPangkasChangelog,
  sqlSetKursor,
  terapkanPerubahan,
  jumlahTertunda,
  type BarisKonflik,
  type Perubahan,
} from './SyncEngine';
import { acak, b64, b64urlKeTeks, buka, dariB64, gabung, idAcak, pembuatHash, hex, segel, turunkanKunci } from './SyncKripto';
import { bacaPasangan, hapusPasangan, identitasPerangkat, perbaruiPasangan, simpanPasangan, type DataPasangan } from './SyncIdentitas';
import { arsipkanPerubahanTertunda, buatSnapshot, DIR_SINKRON, gantiDatabaseDenganSnapshot, setelKursorSetelahSnapshotKeluar } from './SyncSnapshot';
import { useSyncStore } from './SyncStore';
import { useAppStore } from '@/store/useAppStore';
import { lepasModeBacaSaja, PESAN_DIPUTUS_DESKTOP } from './SyncModeBacaSaja';
import { getStoredLicense, hasValidLocalLicense } from '@/services/LicenseService';

/**
 * KLIEN SINKRON (HP). HP selalu memulai; desktop melayani.
 * Koneksi: HTTP langsung ke alamat IPv4 desktop di Wi-Fi/hotspot yang
 * sama — tanpa internet, tanpa server perantara. Isi terenkripsi.
 */

const JALUR_PASANG = '/kopku/v1/pasang';
const JALUR_PESAN = '/kopku/v1/pesan';
const UKURAN_POTONG = 256 * 1024;

export interface KodeQr {
  v: number;
  a: string[];
  p: number;
  i: string;
  k: string;
  d: string;
  n: string;
  x: number;
}

export class GalatSinkron extends Error {
  constructor(public readonly kode: string, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'GalatSinkron';
  }
}

export function bacaKodeQr(teks: string): KodeQr {
  const t = teks.trim();
  if (!t.startsWith('KOPKU1:')) throw new GalatSinkron('QR_BUKAN_KOPKU', 'Ini bukan kode pemasangan KOPKU Desktop.');
  let o: KodeQr;
  try {
    o = JSON.parse(b64urlKeTeks(t.slice(7))) as KodeQr;
  } catch {
    throw new GalatSinkron('QR_RUSAK', 'Kode pemasangan tidak terbaca. Coba pindai ulang.');
  }
  if (!Array.isArray(o.a) || !o.p || !o.i || !o.k || !o.d) throw new GalatSinkron('QR_RUSAK', 'Kode pemasangan tidak lengkap.');
  if (Date.now() > o.x) throw new GalatSinkron('QR_KEDALUWARSA', 'Kode pemasangan sudah kedaluwarsa. Tampilkan QR baru di desktop.');
  return o;
}

async function postJson(alamat: string, port: number, jalur: string, body: unknown, batasMs: number): Promise<{ status: number; json: any }> {
  const kontrol = new AbortController();
  const timer = setTimeout(() => kontrol.abort(), batasMs);
  try {
    const r = await fetch(`http://${alamat}:${port}${jalur}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: kontrol.signal,
    });
    const teks = await r.text();
    return { status: r.status, json: teks ? JSON.parse(teks) : {} };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uji jangkauan cepat ke desktop (GET /kopku/v1/ping, tanpa data).
 *  - 'OK'        : desktop menjawab.
 *  - 'TIMEOUT'   : paket tidak dijawab sama sekali → firewall Windows
 *                  memblokir, isolasi klien Wi-Fi, beda jaringan, atau HP
 *                  mengirim lewat data seluler.
 *  - 'DITOLAK'   : gagal seketika → aplikasi desktop tertutup / server
 *                  sinkron belum menyala, atau alamat salah.
 */
export type HasilPing = 'OK' | 'TIMEOUT' | 'DITOLAK';

export async function ujiJangkauan(alamat: string, port: number, batasMs = 4000): Promise<HasilPing> {
  const kontrol = new AbortController();
  const timer = setTimeout(() => kontrol.abort(), batasMs);
  try {
    const r = await fetch(`http://${alamat}:${port}/kopku/v1/ping`, { signal: kontrol.signal });
    const t = await r.text();
    return /kopku/.test(t) ? 'OK' : 'DITOLAK';
  } catch (e) {
    return kontrol.signal.aborted || /abort/i.test(e instanceof Error ? e.message : String(e)) ? 'TIMEOUT' : 'DITOLAK';
  } finally {
    clearTimeout(timer);
  }
}

export function pesanTakTerjangkau(hasil: HasilPing, alamat: string[], port: number): string {
  const tujuan = `${alamat.join(' / ')}:${port}`;
  if (hasil === 'DITOLAK') {
    return (
      `Desktop (${tujuan}) menolak koneksi.\n\n` +
      '• Pastikan aplikasi KOPKU Desktop sedang terbuka di layar Sinkron HP.\n' +
      '• Bila komputer baru berganti jaringan, tampilkan QR baru lalu pindai ulang.'
    );
  }
  return (
    `Desktop (${tujuan}) tidak menjawab.\n\n` +
    'Penyebab paling sering:\n' +
    '1. Windows Firewall memblokir KOPKU Desktop → di komputer buka Sinkron HP › klik "Izinkan di Firewall" dan setujui dialog Windows.\n' +
    '2. HP dan komputer tidak di Wi-Fi yang sama, atau Wi-Fi memakai isolasi klien (Wi-Fi kantor/tamu) → nyalakan hotspot HP dan sambungkan komputer ke hotspot itu.\n' +
    '3. Wi-Fi tanpa internet dan data seluler menyala → matikan data seluler sementara.\n\n' +
    `Uji: buka http://${alamat[0]}:${port}/kopku/v1/ping di Chrome HP — harus muncul tulisan "kopku".`
  );
}

/** Pasangkan HP ini dengan desktop berdasarkan isi QR. */
export async function pasangDenganKode(teks: string): Promise<{ desktopNama: string; info: any }> {
  const qr = bacaKodeQr(teks);
  const saya = await identitasPerangkat();
  const rahasia = dariB64(qr.k);
  const kunciPasang = turunkanKunci(rahasia, qr.i, 'kopku-pasang-v1');
  const rp = acak(32);
  const amplop = segel(kunciPasang, `pasang|${qr.i}`, { hpId: saya.id, hpNama: saya.nama, skema: SCHEMA_VERSION, rp: b64(rp), t: Date.now(), lisensi: await buktiLisensiHp() });

  // Cari alamat desktop yang benar-benar terjangkau lebih dulu (uji ringan,
  // paralel), supaya galat yang tampil menjelaskan PENYEBABNYA.
  const hasilUji = await Promise.all(qr.a.map((a) => ujiJangkauan(a, qr.p)));
  const terjangkau = qr.a.filter((_, i) => hasilUji[i] === 'OK');
  if (terjangkau.length === 0) {
    const hasil: HasilPing = hasilUji.includes('DITOLAK') ? 'DITOLAK' : 'TIMEOUT';
    throw new GalatSinkron('TIDAK_TERHUBUNG', pesanTakTerjangkau(hasil, qr.a, qr.p));
  }

  let terakhirGalat: unknown = null;
  for (const alamat of terjangkau) {
    try {
      const r = await postJson(alamat, qr.p, JALUR_PASANG, { i: qr.i, ...amplop }, 15000);
      if (r.status !== 200) throw new GalatSinkron(r.json?.kode ?? 'DITOLAK', r.json?.pesan ?? 'Desktop menolak pemasangan.');
      const balas = buka<{ ok: boolean; rd?: string; info?: any; kode?: string; pesan?: string }>(kunciPasang, `pasang-balas|${qr.i}`, r.json);
      if (!balas.ok || !balas.rd) throw new GalatSinkron(balas.kode ?? 'DITOLAK', balas.pesan ?? 'Desktop menolak pemasangan.');
      const ltk = turunkanKunci(gabung(rahasia, rp, dariB64(balas.rd)), 'kopku-ltk-v1', `${qr.d}|${saya.id}`);
      const data: DataPasangan = {
        peerId: qr.d,
        peerNama: qr.n,
        kunci: b64(ltk),
        alamat: [alamat, ...qr.a.filter((x) => x !== alamat)],
        port: qr.p,
        dipasangPada: new Date().toISOString(),
        baseline: null,
        hwm: 0,
        perangkatUtama: balas.info?.perangkatUtama ?? 'DESKTOP',
        keputusan: null,
        terakhirSinkron: null,
      };
      await simpanPasangan(data);
      // RC-S133.5 — memindai QR hanya MENGHUBUNGKAN. HP tetap dapat dipakai;
      // data dikirim manual lewat "Kirim HP → PC" / "Ambil PC → HP".
      await pastikanModeManual();
      useSyncStore.getState().setStatus('SIAP', `Terhubung dengan ${qr.n}. Pilih arah kirim data.`);
      return { desktopNama: qr.n, info: balas.info };
    } catch (e) {
      terakhirGalat = e;
      if (e instanceof GalatSinkron) throw e;
    }
  }
  throw new GalatSinkron(
    'TIDAK_TERHUBUNG',
    `Desktop terjangkau tetapi pemasangan terputus di tengah jalan. Ulangi pindai QR.` +
      (terakhirGalat instanceof Error && !/abort/i.test(terakhirGalat.message) ? `\n(${terakhirGalat.message})` : '')
  );
}

/**
 * RC-S133.4.2 — PINDAI QR = HP OTOMATIS MENJADI CADANGAN.
 *
 * Pasangkan, lalu samakan data tanpa pilihan manual:
 *  - desktop sudah berisi data → data HP diganti salinan desktop (desktop =
 *    buku induk; HP membuat backup pengaman `sebelum-sinkron_*.kdb` dulu);
 *  - desktop masih kosong → data HP dikirim ke desktop.
 * Di kedua kasus HP berakhir sebagai penyimpanan cadangan baca-saja. Bila
 * langkah data gagal (mis. jaringan putus), HP tetap baca-saja dan pilihan
 * manual "data awal" tampil sebagai cadangan.
 */
// RC-S133.5 — tidak dipakai UI lagi (pemasangan tidak otomatis mengirim data);
// dipertahankan untuk kompatibilitas uji e2e lama.
export async function pasangSebagaiCadangan(teks: string): Promise<{ desktopNama: string; arah: 'AMBIL_DESKTOP' | 'KIRIM_HP' }> {
  const r = await pasangDenganKode(teks);
  const desktopBerisi = !!r.info?.setupSelesai;
  if (desktopBerisi) await ambilDataDesktop('DATA_AWAL');
  else await kirimDataHp('DATA_AWAL');
  return { desktopNama: r.desktopNama, arah: desktopBerisi ? 'AMBIL_DESKTOP' : 'KIRIM_HP' };
}

/** Kirim satu operasi terenkripsi ke desktop. */
export async function kirimOp<T = any>(op: string, data: unknown = {}, batasMs = 30000): Promise<T> {
  const p = await bacaPasangan();
  if (!p) throw new GalatSinkron('BELUM_DIPASANGKAN', 'HP belum dipasangkan dengan desktop.');
  const saya = await identitasPerangkat();
  const kunci = dariB64(p.kunci);
  const r = idAcak();
  const amplop = segel(kunci, `pesan|${saya.id}`, { t: Date.now(), r, op, data });
  let galatJaringan: unknown = null;
  for (const alamat of p.alamat) {
    let res: { status: number; json: any };
    try {
      res = await postJson(alamat, p.port, JALUR_PESAN, { p: saya.id, ...amplop }, batasMs);
    } catch (e) {
      galatJaringan = e;
      continue;
    }
    if (alamat !== p.alamat[0]) await perbaruiPasangan({ alamat: [alamat, ...p.alamat.filter((x) => x !== alamat)] });
    if (res.status !== 200) {
      const pesan =
        res.json?.pesan ??
        (res.status === 503 ? 'KOPKU Desktop sedang memuat atau belum siap. Coba lagi beberapa detik lagi.' : `Desktop menolak permintaan (${res.status}).`);
      throw new GalatSinkron(res.json?.kode ?? (res.status === 503 ? 'BELUM_SIAP' : 'DITOLAK'), pesan);
    }
    const balas = buka<{ ok: boolean; data?: T; kode?: string; pesan?: string }>(kunci, `balas|${saya.id}|${r}`, res.json);
    if (!balas.ok) throw new GalatSinkron(balas.kode ?? 'GALAT', balas.pesan ?? 'Desktop mengembalikan galat.');
    return balas.data as T;
  }
  const jangkau = await ujiJangkauan(p.alamat[0], p.port, 3000).catch(() => 'TIMEOUT' as HasilPing);
  throw new GalatSinkron(
    'TIDAK_TERHUBUNG',
    'Desktop tidak terjangkau. Perubahan tetap tersimpan di HP dan dikirim otomatis saat tersambung kembali.\n\n' +
      pesanTakTerjangkau(jangkau === 'OK' ? 'TIMEOUT' : jangkau, p.alamat, p.port) +
      (galatJaringan instanceof Error && !/abort/i.test(galatJaringan.message) ? `\n(${galatJaringan.message})` : '')
  );
}

let sedangBerjalan: Promise<void> | null = null;

/** Sinkron dua arah. Aman dipanggil berulang (single-flight). */
export function sinkronkanSekarang(): Promise<void> {
  if (sedangBerjalan) return sedangBerjalan;
  sedangBerjalan = jalankanSinkron().finally(() => {
    sedangBerjalan = null;
  });
  return sedangBerjalan;
}

async function jalankanSinkron(): Promise<void> {
  const s = useSyncStore.getState();
  const p = await bacaPasangan();
  if (!p) return s.setStatus('BELUM_DIPASANGKAN');
  if (p.diputusDesktop) return s.setStatus('GALAT', PESAN_DIPUTUS_DESKTOP);
  if (!p.baseline) return s.setStatus('PERLU_DATA_AWAL', 'Pilih data awal.');
  const db = await getDb();
  await pasangInfrastrukturSinkron(db);
  const dbBaseline = await bacaMeta(db, 'baseline');
  if (dbBaseline !== p.baseline || (await nomorUrutChangelog(db)) < p.hwm) {
    // Keputusan buku induk mungkin sudah dipilih di desktop: jalankan.
    const info = await kirimOp<any>('INFO', {}, 8000).catch(() => null);
    if (info?.keputusan === 'PAKAI_DESKTOP' || info?.keputusan === 'PAKAI_HP') {
      await jalankanKeputusan(info.keputusan).catch(() => undefined);
      return;
    }
    return s.setStatus('PERLU_SINKRON_ULANG', 'Data HP ini telah dipulihkan/direset sejak sinkron terakhir. Pilih perangkat buku induk.');
  }
  await pastikanModeManual();
  const peer = { id: p.peerId, nama: p.peerNama };
  s.setStatus('MENYINKRONKAN');
  // Animasi transfer hanya saat memang ada data yang diterima — sinkron
  // berkala tanpa perubahan (tiap 60 detik) tidak memunculkan animasi.
  let totalTerima = 0;
  try {
    for (let putaran = 0; putaran < 40; putaran++) {
      // RC-S133.4 — SINKRON SATU ARAH (desktop → HP). HP adalah penyimpanan
      // cadangan baca-saja: ia tidak mengirim perubahan apa pun. Catatan lokal
      // yang diizinkan (log audit, sesi, PIN perangkat) tidak dikirim dan
      // dibuang dari antrian supaya tidak pernah dianggap bentrok.
      await db.execAsync('DELETE FROM sync_changelog;');
      const k = (await bacaKursor(db, peer.id)) ?? { terima_seq: 0, kirim_seq: 0 };
      const res = await kirimOp<any>(
        'SYNC',
        { baseline: p.baseline, skema: SCHEMA_VERSION, perubahan: [], kursorTerima: k.terima_seq, lisensi: await buktiLisensiHp() },
        120000
      );
      if (res.status === 'KEPUTUSAN') {
        await jalankanKeputusan(res.keputusan);
        return;
      }
      if (res.status === 'KONFLIK') {
        s.setKonflik(res.konflik ?? []);
        s.setStatus('PERLU_SINKRON_ULANG', res.pesan ?? 'Data perlu disamakan ulang. Pilih perangkat buku induk.');
        return;
      }
      if (res.status === 'ULANGI') {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      const D = (res.perubahan ?? []) as Perubahan[];
      const maksD = D.reduce((m, x) => Math.max(m, Number(x.seq)), k.terima_seq);
      if (D.length > 0) {
        s.setAliran('DESKTOP_KE_HP');
        s.setProgres(`Menerima ${D.length} perubahan dari desktop…`);
        try {
          await terapkanPerubahan(db, D, {
            sesudah: [...sqlSetKursor(peer.id, peer.nama, { terima_seq: maksD, status: 'OK' }), 'DELETE FROM sync_changelog;'],
          });
          totalTerima += D.length;
          s.naikkanVersiData();
        } catch (e) {
          if (e instanceof KonflikSinkronError) {
            s.setStatus('PERLU_SINKRON_ULANG', `Perubahan desktop tidak dapat diterapkan di HP: ${e.message}. Pilih "Pakai data desktop".`);
            await catatRiwayat(db, 'MASUK', 0, D.length, 'GAGAL', e.message);
            return;
          }
          throw e;
        }
      }
      if (!res.adaLanjutan) break;
    }
    const terakhir = new Date().toISOString();
    await perbaruiPasangan({ hwm: await nomorUrutChangelog(db), terakhirSinkron: terakhir });
    await catatRiwayat(db, 'MASUK', 0, totalTerima, 'OK');
    s.setTerakhir(terakhir);
    s.setKonflik([]);
    s.setTertunda(0);
    s.setStatus('SIAP', totalTerima > 0 ? `Diterima ${totalTerima} perubahan dari desktop.` : 'Data sudah sama dengan desktop.');
    await sponsoriLisensiDesktop().catch(() => undefined);
  } catch (e) {
    if (e instanceof GalatSinkron && e.kode === 'TIDAK_TERHUBUNG') return s.setStatus('TIDAK_TERHUBUNG', e.message);
    if (e instanceof GalatSinkron && e.kode === 'PERLU_SINKRON_ULANG') return s.setStatus('PERLU_SINKRON_ULANG', e.message);
    if (e instanceof GalatSinkron && e.kode === 'LISENSI_BEDA') return s.setStatus('GALAT', e.message);
    if (e instanceof GalatSinkron && e.kode === 'TIDAK_DIPASANGKAN') {
      await perbaruiPasangan({ diputusDesktop: true }).catch(() => undefined);
      return s.setStatus('GALAT', PESAN_DIPUTUS_DESKTOP);
    }
    if (e instanceof Error && /^SIBUK/.test(e.message)) return s.setStatus('SIAP', 'Database sedang sibuk; dicoba lagi otomatis.');
    s.setStatus('GALAT', e instanceof Error ? e.message : String(e));
  } finally {
    s.setProgres(null);
    s.setAliran(null);
  }
}

/**
 * Bukti lisensi HP untuk desktop (token aktivasi + ID perangkat). Desktop
 * memverifikasi tanda tangannya dan hanya melayani HP dengan lisensi yang
 * SAMA dengan lisensinya. Token ini hanya pernah dikirim ke desktop yang
 * dipasangkan lewat QR, di dalam kanal terenkripsi.
 */
export async function buktiLisensiHp(): Promise<{ token: string; deviceId: string } | null> {
  const l = await getStoredLicense().catch(() => null);
  return l?.activationToken && l.deviceId ? { token: l.activationToken, deviceId: l.deviceId } : null;
}

/**
 * RC-S133.5 — SINKRON MANUAL: siapkan tabel sinkron (tanpa trigger
 * changelog), LEPAS trigger baca-saja peninggalan mode cadangan
 * RC-S133.4, dan segarkan izin UI. Idempoten; dipanggil saat terpasang,
 * setelah kirim/ambil data, dan oleh agen sinkron saat aplikasi dibuka.
 */
export async function pastikanModeManual(): Promise<void> {
  const db = await getDb();
  await pasangInfrastrukturSinkron(db);
  await lepasModeBacaSaja(db);
  useAppStore.getState().segarkanMaskerIzin();
}

/** @deprecated RC-S133.5 — nama lama; kini sama dengan `pastikanModeManual` (HP tidak lagi baca-saja). */
export const aktifkanModeCadangan = pastikanModeManual;

export type PermintaanDesktop = 'PAKAI_DESKTOP' | 'PAKAI_HP';

/**
 * RC-S133.5 — permintaan yang dibuat di KOPKU Desktop:
 *  - 'PAKAI_DESKTOP' = "Kirim data PC → HP" (HP diminta menerima data komputer);
 *  - 'PAKAI_HP'      = "Minta data dari HP" (HP diminta mengirim datanya).
 * HP selalu menanyakan persetujuan pemiliknya sebelum menjalankannya.
 */
export async function cekPermintaanDesktop(): Promise<{ permintaan: PermintaanDesktop | null; desktopNama: string | null }> {
  const p = await bacaPasangan();
  if (!p || p.diputusDesktop) return { permintaan: null, desktopNama: null };
  const info = await kirimOp<any>('INFO', {}, 8000);
  const k = info?.keputusan;
  return { permintaan: k === 'PAKAI_DESKTOP' || k === 'PAKAI_HP' ? k : null, desktopNama: info?.desktopNama ?? p.peerNama };
}

export async function tolakPermintaanDesktop(): Promise<void> {
  await kirimOp('TOLAK_PERMINTAAN', {}, 8000);
}

/** Jalankan permintaan desktop yang sudah disetujui di HP. */
export async function jalankanPermintaanDesktop(k: PermintaanDesktop): Promise<void> {
  if (k === 'PAKAI_DESKTOP') await ambilDataDesktop('PERMINTAAN_DESKTOP');
  else await kirimDataHp('PERMINTAAN_DESKTOP');
}

async function jalankanKeputusan(keputusan: 'PAKAI_DESKTOP' | 'PAKAI_HP'): Promise<void> {
  if (keputusan === 'PAKAI_DESKTOP') await ambilDataDesktop('KONFLIK');
  else await kirimDataHp('KONFLIK');
}

/** RC-S133.5 — MANUAL: kirim dari layar; PERMINTAAN_DESKTOP: atas permintaan dari layar desktop. */
export type AlasanKirim = 'DATA_AWAL' | 'KONFLIK' | 'SINKRON_ULANG' | 'MANUAL' | 'PERMINTAAN_DESKTOP';

/** Ganti data HP dengan salinan data desktop ("Ambil data PC → HP"). */
export async function ambilDataDesktop(alasan: AlasanKirim): Promise<void> {
  const s = useSyncStore.getState();
  const p = await bacaPasangan();
  if (!p) throw new GalatSinkron('BELUM_DIPASANGKAN', 'HP belum dipasangkan.');
  s.setStatus('MENYINKRONKAN', 'Menyiapkan salinan data di desktop…');
  s.setAliran('DESKTOP_KE_HP');
  try {
    const db = await getDb();
    await pasangInfrastrukturSinkron(db);
    if (alasan !== 'DATA_AWAL') await arsipkanPerubahanTertunda(p.peerId, 'Data HP diganti dengan data desktop', s.konflik);
    const info = await kirimOp<{ id: string; ukuran: number; sha256: string; baseline: string }>('SNAP_BUAT', { lisensi: await buktiLisensiHp() }, 120000);
    const dir = await FileSystem.getInfoAsync(DIR_SINKRON);
    if (!dir.exists) await FileSystem.makeDirectoryAsync(DIR_SINKRON, { intermediates: true });
    const uri = `${DIR_SINKRON}snapshot-masuk.db`;
    const f = new File(uri);
    if (f.exists) f.delete();
    f.create({ overwrite: true });
    const h = f.open();
    const hash = pembuatHash();
    try {
      for (let off = 0; off < info.ukuran; off += UKURAN_POTONG) {
        const r = await kirimOp<{ data: string }>('SNAP_AMBIL', { id: info.id, offset: off, panjang: UKURAN_POTONG }, 60000);
        const bytes = dariB64(r.data);
        h.offset = off;
        h.writeBytes(bytes);
        hash.update(bytes);
        s.setPersen(Math.min(1, (off + bytes.length) / Math.max(1, info.ukuran)));
        s.setProgres('Menerima data dari desktop…');
      }
    } finally {
      h.close();
    }
    if (hex(hash.digest()) !== info.sha256) throw new GalatSinkron('HASH', 'Salinan data rusak saat diunduh (hash tidak cocok). Ulangi.');
    s.setProgres('Mengganti data HP…');
    const hasil = await gantiDatabaseDenganSnapshot(uri, { id: p.peerId, nama: p.peerNama });
    const dbBaru = await getDb();
    await perbaruiPasangan({ baseline: hasil.baseline, keputusan: null, hwm: await nomorUrutChangelog(dbBaru), terakhirSinkron: new Date().toISOString() });
    await kirimOp('SNAP_SELESAI', { id: info.id, smax: hasil.smax, sseq: hasil.sseq, baseline: hasil.baseline });
    s.setKonflik([]);
    await pastikanModeManual();
    s.setStatus('SIAP', `Data HP kini sama dengan data komputer. Backup pengaman: ${hasil.backupPengaman}`);
    await sponsoriLisensiDesktop(true).catch(() => undefined);
  } catch (e) {
    s.setStatus(e instanceof GalatSinkron && e.kode === 'TIDAK_TERHUBUNG' ? 'TIDAK_TERHUBUNG' : 'GALAT', e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    s.setProgres(null);
    s.setAliran(null);
  }
}

/**
 * PEMULIHAN DATA AWAL / BUKU INDUK HP.
 *
 * Bila HP sudah mengirim salinan datanya dan desktop SUDAH memasangnya,
 * tetapi konfirmasi "selesai" tidak sampai ke HP (desktop memuat ulang,
 * Wi-Fi putus, HP ditutup), HP tidak perlu mengirim ulang: baseline yang
 * dibuat HP saat membuat salinan tersimpan di database HP (`sync_meta`),
 * dan desktop melaporkan baseline + kursor yang ia pakai. Bila keduanya
 * sama, HP cukup menyetel kursornya — persis langkah akhir kirimDataHp().
 */
export async function pulihkanBilaDesktopSudahMenerima(): Promise<boolean> {
  const p = await bacaPasangan();
  if (!p) return false;
  const db = await getDb();
  const baselineHp = await bacaMeta(db, 'baseline');
  if (!baselineHp || p.baseline === baselineHp) return false;
  const info = await kirimOp<any>('INFO', {}, 8000).catch(() => null);
  if (!info || info.baseline !== baselineHp || !info.kursorHp) return false;
  await setelKursorSetelahSnapshotKeluar({ id: p.peerId, nama: p.peerNama }, Number(info.kursorHp.terima_seq), Number(info.kursorHp.kirim_seq));
  await perbaruiPasangan({ baseline: baselineHp, keputusan: null, hwm: await nomorUrutChangelog(db), terakhirSinkron: new Date().toISOString() });
  useSyncStore.getState().setKonflik([]);
  await pastikanModeManual();
  useSyncStore.getState().setStatus('SIAP', 'Data komputer sudah sama dengan HP.');
  await sponsoriLisensiDesktop(true).catch(() => undefined);
  return true;
}

/** Kirim data HP ke desktop (HP = buku induk). Desktop menyetujui lebih dulu bila sudah berisi data. */
export async function kirimDataHp(alasan: AlasanKirim): Promise<void> {
  const s = useSyncStore.getState();
  const p = await bacaPasangan();
  if (!p) throw new GalatSinkron('BELUM_DIPASANGKAN', 'HP belum dipasangkan.');
  s.setStatus('MENYINKRONKAN', 'Menyiapkan salinan data HP…');
  s.setAliran('HP_KE_DESKTOP');
  try {
    const snap = await buatSnapshot();
    const mulai = await kirimOp<{ id: string }>('UNGGAH_MULAI', { ukuran: snap.ukuran, sha256: snap.sha256, alasan, lisensi: await buktiLisensiHp() });
    const h = new File(snap.uri).open();
    try {
      for (let off = 0; off < snap.ukuran; off += UKURAN_POTONG) {
        h.offset = off;
        const bytes = h.readBytes(Math.min(UKURAN_POTONG, snap.ukuran - off));
        await kirimOp('UNGGAH_POTONG', { id: mulai.id, offset: off, data: b64(bytes) }, 60000);
        s.setPersen(Math.min(1, (off + bytes.length) / Math.max(1, snap.ukuran)));
        s.setProgres('Mengirim data HP ke desktop…');
      }
    } finally {
      h.close();
    }
    let st = await kirimOp<{ status: string; hasil?: any; pesan?: string }>('UNGGAH_SELESAI', { id: mulai.id });
    const batas = Date.now() + 15 * 60 * 1000;
    let gagalBeruntun = 0;
    while (st.status === 'MENUNGGU' || st.status === 'MENERAPKAN' || st.status === 'MENERIMA') {
      s.setStatus('MENUNGGU_KONFIRMASI', st.status === 'MENUNGGU' ? 'Menunggu persetujuan di layar desktop…' : 'Desktop sedang mengganti datanya…');
      if (Date.now() > batas) throw new GalatSinkron('WAKTU_HABIS', 'Desktop belum menyetujui dalam 15 menit. Ulangi kapan saja.');
      await new Promise((r) => setTimeout(r, 2000));
      try {
        st = await kirimOp('UNGGAH_STATUS', { id: mulai.id });
        gagalBeruntun = 0;
      } catch (e) {
        gagalBeruntun += 1;
        // Desktop memuat ulang / sesi unggah hilang / jaringan putus sesaat:
        // cek apakah desktop SUDAH memasang data HP (baseline sama).
        if (await pulihkanBilaDesktopSudahMenerima()) {
          await FileSystem.deleteAsync(snap.uri, { idempotent: true });
          return;
        }
        const kode = e instanceof GalatSinkron ? e.kode : '';
        if (kode === 'UNGGAH_HILANG' && gagalBeruntun >= 6) {
          throw new GalatSinkron(kode, 'Desktop kehilangan sesi pengiriman (aplikasi desktop dimuat ulang) dan datanya belum terpasang. Ketuk kirim lagi.');
        }
        // BELUM_SIAP / TIDAK_TERHUBUNG: tunggu dan coba lagi.
      }
    }
    if (st.status !== 'SELESAI' || !st.hasil) throw new GalatSinkron(st.status, st.pesan ?? 'Desktop tidak menerapkan data HP.');
    await setelKursorSetelahSnapshotKeluar({ id: p.peerId, nama: p.peerNama }, Number(st.hasil.smax), Number(st.hasil.sseq));
    const db = await getDb();
    await perbaruiPasangan({ baseline: st.hasil.baseline, keputusan: null, hwm: await nomorUrutChangelog(db), terakhirSinkron: new Date().toISOString() });
    await FileSystem.deleteAsync(snap.uri, { idempotent: true });
    s.setKonflik([]);
    await pastikanModeManual();
    s.setStatus('SIAP', 'Data komputer kini sama dengan HP.');
    await sponsoriLisensiDesktop(true).catch(() => undefined);
  } catch (e) {
    s.setStatus(e instanceof GalatSinkron && e.kode === 'TIDAK_TERHUBUNG' ? 'TIDAK_TERHUBUNG' : 'GALAT', e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    s.setProgres(null);
    s.setAliran(null);
  }
}

/**
 * LISENSI DESKTOP OTOMATIS DARI HP.
 *
 * Bila desktop yang terpasang belum berlisensi, HP mengirim token
 * aktivasinya + ID perangkatnya lewat kanal sinkron terenkripsi. Desktop
 * memakainya sebagai BUKTI ke server lisensi untuk mendapatkan slot
 * Laptop/PC-nya sendiri (api/activate_companion.php). Desktop perlu
 * terhubung internet sekali untuk langkah ini. HP tidak mengirim apa pun
 * bila HP sendiri tidak berlisensi sah, dan tidak lebih dari sekali per
 * 2 menit (kecuali dipaksa dari tombol).
 */
let sponsorTerakhir = 0;

export async function sponsoriLisensiDesktop(paksa = false): Promise<{ dikirim: boolean; ok?: boolean; pesan?: string }> {
  if (!paksa && Date.now() - sponsorTerakhir < 2 * 60 * 1000) return { dikirim: false };
  sponsorTerakhir = Date.now();
  const p = await bacaPasangan();
  if (!p) return { dikirim: false };
  const info = await kirimOp<any>('INFO', {}, 8000).catch(() => null);
  if (!info || !info.perluLisensi) return { dikirim: false };
  if (!(await hasValidLocalLicense().catch(() => false))) {
    return { dikirim: false, ok: false, pesan: 'Lisensi HP ini sendiri belum sah, jadi tidak dapat dipakai untuk mengaktifkan desktop.' };
  }
  const lisensi = await getStoredLicense();
  if (!lisensi?.activationToken || !lisensi.deviceId) return { dikirim: false };
  const r = await kirimOp<{ ok: boolean; pesan: string }>('LISENSI_SPONSOR', { token: lisensi.activationToken, deviceId: lisensi.deviceId }, 45000);
  const s = useSyncStore.getState();
  if (s.status === 'SIAP') s.setStatus('SIAP', r.pesan);
  return { dikirim: true, ok: r.ok, pesan: r.pesan };
}

export async function infoDesktop(): Promise<any> {
  return kirimOp('INFO', {}, 8000);
}

export async function putuskanPemasanganHp(): Promise<void> {
  await kirimOp('PUTUS', {}, 5000).catch(() => undefined);
  await hapusPasangan();
  const db = await getDb();
  await cabutInfrastrukturSinkron(db).catch(() => undefined);
  useAppStore.getState().segarkanMaskerIzin();
  useSyncStore.getState().setStatus('BELUM_DIPASANGKAN');
  useSyncStore.getState().setKonflik([]);
}

export async function segarkanStatusHp(): Promise<void> {
  const s = useSyncStore.getState();
  const p = await bacaPasangan();
  if (!p) return s.setStatus('BELUM_DIPASANGKAN');
  await pastikanModeManual().catch(() => undefined);
  if (p.diputusDesktop) return s.setStatus('GALAT', PESAN_DIPUTUS_DESKTOP);
  // HP→PC yang terputus di tengah jalan namun sudah dipasang desktop.
  if (await pulihkanBilaDesktopSudahMenerima().catch(() => false)) return;
  if (s.status !== 'MENYINKRONKAN' && s.status !== 'MENUNGGU_KONFIRMASI') s.setStatus('SIAP', `Terhubung dengan ${p.peerNama}.`);
  s.setTerakhir(p.terakhirSinkron ?? null);
  try {
    s.setTertunda(await jumlahTertunda(await getDb(), p.peerId));
  } catch {
    /* abaikan */
  }
}

export type { BarisKonflik };
