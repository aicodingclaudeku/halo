import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { getDb } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { bridge } from '@/desktop/bridge';
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
  type Perubahan,
} from './SyncEngine';
import { acak, b64, buka, dariB64, gabung, idAcak, segel, teksKeB64url, turunkanKunci, MASA_BERLAKU_PESAN_MS, type Amplop } from './SyncKripto';
import { bacaPasangan, hapusPasangan, identitasPerangkat, perbaruiPasangan, simpanPasangan, type DataPasangan, type JenisPerangkat } from './SyncIdentitas';
import { arsipkanPerubahanTertunda, buatSnapshot, DIR_SINKRON, gantiDatabaseDenganSnapshot, hashBerkas, setelKursorSetelahSnapshotKeluar } from './SyncSnapshot';
import { useSyncStore } from './SyncStore';
import { activateLicenseCompanion, hasValidLocalLicense } from '@/services/LicenseService';
import { useAppStore } from '@/store/useAppStore';
import { GalatLisensiSinkron, periksaLisensiHp } from './SyncLisensi';
import { lepasModeBacaSaja } from './SyncModeBacaSaja';

/**
 * SERVER SINKRON DESKTOP.
 *
 * Proses utama Electron hanya menjadi "pipa" HTTP di LAN
 * (`desktop/electron/hosts/lanServer.js`); seluruh keputusan — dekripsi,
 * autentikasi, deteksi konflik, penerapan perubahan — dijalankan DI SINI,
 * dengan kode yang sama yang dipakai HP. HP selalu menjadi pihak yang
 * memulai permintaan (desktop = server), sehingga HP tidak perlu
 * membuka port apa pun.
 */

export const JALUR_PASANG = '/kopku/v1/pasang';
export const JALUR_PESAN = '/kopku/v1/pesan';
export const MASA_BERLAKU_QR_MS = 10 * 60 * 1000;

interface PemasanganAktif {
  id: string;
  rahasia: Uint8Array;
  kedaluwarsa: number;
}

interface Unggahan {
  uri: string;
  ukuran: number;
  sha256: string;
  diterima: number;
  status: 'MENERIMA' | 'MENUNGGU' | 'MENERAPKAN' | 'SELESAI' | 'DITOLAK' | 'GAGAL';
  hasil?: { smax: number; sseq: number; baseline: string };
  pesan?: string;
  alasan?: string;
}

let pemasangan: PemasanganAktif | null = null;
let snapshotKeluar: { id: string; uri: string; ukuran: number; sha256: string; baseline: string } | null = null;
const unggahan = new Map<string, Unggahan>();
const nonceTerlihat = new Map<string, number>();
let serverBerjalan = false;

function jawab(status: number, body: unknown) {
  return { status, body: JSON.stringify(body) };
}

export async function infoServer() {
  const db = await getDb();
  const koperasi = await db.getFirstAsync<{ nama: string }>('SELECT nama FROM koperasi LIMIT 1').catch(() => null);
  const anggota = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM anggota').catch(() => ({ n: 0 }));
  const jurnal = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM journal').catch(() => ({ n: 0 }));
  const p = await bacaPasangan();
  const saya = await identitasPerangkat();
  const kursorHp = p ? await bacaKursor(db, p.peerId).catch(() => null) : null;
  const perluLisensi = !(await hasValidLocalLicense().catch(() => false));
  return {
    kursorHp,
    perluLisensi,
    desktopId: saya.id,
    desktopNama: saya.nama,
    setupSelesai: !!koperasi,
    namaKoperasi: koperasi?.nama ?? null,
    jumlahAnggota: Number(anggota?.n ?? 0),
    jumlahJurnal: Number(jurnal?.n ?? 0),
    skema: SCHEMA_VERSION,
    baseline: p?.baseline ?? null,
    perangkatUtama: p?.perangkatUtama ?? 'DESKTOP',
    keputusan: p?.keputusan ?? null,
  };
}

/** Buat kode pemasangan baru (QR). Kode lama otomatis tidak berlaku. */
export async function mulaiPemasanganBaru(): Promise<{ teksQr: string; qrDataUrl: string; kedaluwarsa: number; alamat: string[]; port: number }> {
  const b = bridge();
  if (!b) throw new Error('Pemasangan HP hanya tersedia di aplikasi desktop.');
  await mulaiServerSinkron();
  const lan = await b.lan.info();
  if (lan.addresses.length === 0) {
    throw new Error('Komputer ini belum tersambung ke Wi-Fi/hotspot/LAN. Sambungkan HP dan komputer ke jaringan yang sama terlebih dahulu.');
  }
  const saya = await identitasPerangkat();
  pemasangan = { id: idAcak(), rahasia: acak(32), kedaluwarsa: Date.now() + MASA_BERLAKU_QR_MS };
  const isi = {
    v: 1,
    a: lan.addresses,
    p: lan.port,
    i: pemasangan.id,
    k: b64(pemasangan.rahasia),
    d: saya.id,
    n: saya.nama,
    x: pemasangan.kedaluwarsa,
  };
  const teksQr = `KOPKU1:${teksKeB64url(JSON.stringify(isi))}`;
  const qrDataUrl = await b.qr.toDataUrl(teksQr);
  return { teksQr, qrDataUrl, kedaluwarsa: pemasangan.kedaluwarsa, alamat: lan.addresses, port: lan.port };
}

export function batalkanPemasangan(): void {
  pemasangan = null;
}

export async function setPerangkatUtama(jenis: JenisPerangkat): Promise<void> {
  await perbaruiPasangan({ perangkatUtama: jenis });
}

/**
 * RC-S133.5 — permintaan kirim dari layar DESKTOP (sinkron manual):
 *  - 'PAKAI_DESKTOP' = "Kirim data PC → HP";
 *  - 'PAKAI_HP'      = "Minta data dari HP" (HP → PC).
 * HP mengambil permintaan ini saat menghubungi desktop (KOPKU di HP
 * terbuka) dan menanyakan persetujuan pemiliknya. null = batalkan.
 */
export async function setKeputusan(k: 'PAKAI_DESKTOP' | 'PAKAI_HP' | null): Promise<void> {
  await perbaruiPasangan({ keputusan: k });
  const s = useSyncStore.getState();
  if (k) {
    s.setStatus(
      'MENUNGGU_KONFIRMASI',
      k === 'PAKAI_DESKTOP'
        ? 'Menunggu persetujuan di HP untuk menerima data komputer ini. Buka KOPKU di HP.'
        : 'Menunggu HP mengirim datanya. Buka KOPKU di HP lalu setujui permintaan.'
    );
  } else {
    s.setStatus('SIAP', 'Permintaan dibatalkan.');
  }
}

export async function putuskanPemasanganDesktop(): Promise<void> {
  await hapusPasangan();
  const db = await getDb();
  await cabutInfrastrukturSinkron(db).catch(() => undefined);
  useSyncStore.getState().setStatus('BELUM_DIPASANGKAN');
}

export async function segarkanStatusDesktop(): Promise<void> {
  const p = await bacaPasangan();
  const s = useSyncStore.getState();
  if (!p) return s.setStatus('BELUM_DIPASANGKAN');
  s.setTerakhir(p.terakhirSinkron ?? null);
  // RC-S133.5 — sinkron manual: terpasang = terhubung; permintaan kirim yang
  // masih menunggu HP ditampilkan sebagai MENUNGGU_KONFIRMASI.
  if (p.keputusan && s.status !== 'MENYINKRONKAN') {
    s.setStatus('MENUNGGU_KONFIRMASI', p.keputusan === 'PAKAI_DESKTOP' ? 'Menunggu persetujuan di HP untuk menerima data komputer ini.' : 'Menunggu HP mengirim datanya.');
  }
  try {
    const db = await getDb();
    s.setTertunda(await jumlahTertunda(db, p.peerId));
  } catch {
    /* abaikan */
  }
  if (!p.keputusan && (s.status === 'BELUM_DIPASANGKAN' || s.status === 'PERLU_DATA_AWAL' || s.status === 'MENUNGGU_KONFIRMASI')) {
    s.setStatus('SIAP', `Terhubung dengan ${p.peerNama}.`);
  }
}

export async function mulaiServerSinkron(): Promise<void> {
  const b = bridge();
  if (!b || serverBerjalan) return;
  serverBerjalan = true;
  // Desktop adalah buku induk: tidak pernah membawa trigger baca-saja HP.
  void getDb().then((db) => lepasModeBacaSaja(db)).catch(() => undefined);
  b.lan.onRequest(({ path, body }) => tanganiPermintaan(path, body));
  await b.lan.start();
  await segarkanStatusDesktop().catch(() => undefined);
}

export async function tanganiPermintaan(path: string, body: string): Promise<{ status: number; body: string }> {
  try {
    const o = JSON.parse(body) as Record<string, string>;
    if (path === JALUR_PASANG) return await tanganiPasang(o);
    if (path === JALUR_PESAN) return await tanganiPesan(o);
    return jawab(404, { kode: 'TIDAK_DIKENAL' });
  } catch (e) {
    return jawab(400, { kode: 'PERMINTAAN_RUSAK', pesan: e instanceof Error ? e.message : String(e) });
  }
}

async function tanganiPasang(o: Record<string, string>) {
  if (!pemasangan || o.i !== pemasangan.id || Date.now() > pemasangan.kedaluwarsa) {
    return jawab(403, { kode: 'KODE_PASANG_TIDAK_BERLAKU', pesan: 'Kode QR sudah tidak berlaku. Tampilkan QR baru di desktop.' });
  }
  const p = pemasangan;
  const kunciPasang = turunkanKunci(p.rahasia, p.id, 'kopku-pasang-v1');
  let isi: { hpId: string; hpNama: string; skema: number; rp: string; t: number; lisensi?: { token?: string; deviceId?: string } | null };
  try {
    isi = buka(kunciPasang, `pasang|${p.id}`, { n: o.n, c: o.c });
  } catch {
    return jawab(403, { kode: 'AUTENTIKASI_GAGAL' });
  }
  pemasangan = null; // sekali pakai
  const saya = await identitasPerangkat();
  if (isi.skema !== SCHEMA_VERSION) {
    return jawab(200, segel(kunciPasang, `pasang-balas|${p.id}`, { ok: false, kode: 'SKEMA_BEDA', pesan: `Versi data HP v${isi.skema}, desktop v${SCHEMA_VERSION}. Samakan versi aplikasi.` }));
  }
  let lisensiId: number;
  try {
    lisensiId = await periksaLisensiHp(isi.lisensi);
  } catch (e) {
    const g = e as GalatLisensiSinkron;
    return jawab(200, segel(kunciPasang, `pasang-balas|${p.id}`, { ok: false, kode: g.kode ?? 'LISENSI_HP_TIDAK_SAH', pesan: g.message }));
  }
  const rd = acak(32);
  const ltk = turunkanKunci(gabung(p.rahasia, dariB64(isi.rp), rd), 'kopku-ltk-v1', `${saya.id}|${isi.hpId}`);
  const lama = await bacaPasangan();
  const lan = await bridge()?.lan.info();
  const data: DataPasangan = {
    peerId: isi.hpId,
    peerNama: isi.hpNama,
    kunci: b64(ltk),
    alamat: [],
    port: lan?.port ?? 0,
    dipasangPada: new Date().toISOString(),
    baseline: null,
    hwm: 0,
    perangkatUtama: 'DESKTOP',
    keputusan: null,
    terakhirSinkron: null,
    lisensiId,
  };
  void lama;
  await simpanPasangan(data);
  useSyncStore.getState().setStatus('SIAP', `${isi.hpNama} terhubung. Pilih arah kirim data.`);
  useSyncStore.getState().setHpTerlihat(new Date().toISOString());
  return jawab(200, segel(kunciPasang, `pasang-balas|${p.id}`, { ok: true, rd: b64(rd), info: await infoServer() }));
}

async function tanganiPesan(o: Record<string, string>) {
  const pasangan = await bacaPasangan();
  if (!pasangan || o.p !== pasangan.peerId) return jawab(403, { kode: 'TIDAK_DIPASANGKAN', pesan: 'HP ini tidak lagi terpasang dengan desktop.' });
  const kunci = dariB64(pasangan.kunci);
  let isi: { t: number; r: string; op: string; data: any };
  try {
    isi = buka(kunci, `pesan|${o.p}`, { n: o.n, c: o.c } as Amplop);
  } catch {
    return jawab(403, { kode: 'AUTENTIKASI_GAGAL' });
  }
  const kini = Date.now();
  if (Math.abs(kini - isi.t) > MASA_BERLAKU_PESAN_MS) return jawab(403, { kode: 'JAM_BEDA', pesan: 'Jam HP dan desktop berbeda lebih dari 10 menit.' });
  if (nonceTerlihat.has(isi.r)) return jawab(403, { kode: 'REPLAY' });
  nonceTerlihat.set(isi.r, kini);
  if (nonceTerlihat.size > 2000) {
    for (const [k, t] of nonceTerlihat) if (kini - t > MASA_BERLAKU_PESAN_MS) nonceTerlihat.delete(k);
  }
  useSyncStore.getState().setHpTerlihat(new Date().toISOString());

  let hasil: unknown;
  try {
    hasil = { ok: true, data: await jalankanOp(isi.op, isi.data ?? {}, pasangan) };
  } catch (e) {
    hasil = { ok: false, kode: (e as { kode?: string }).kode ?? 'GALAT', pesan: e instanceof Error ? e.message : String(e) };
  }
  return jawab(200, segel(kunci, `balas|${o.p}|${isi.r}`, hasil));
}

function galat(kode: string, pesan: string): Error {
  const e = new Error(pesan) as Error & { kode: string };
  e.kode = kode;
  return e;
}

const OP_BERLISENSI = new Set(['SYNC', 'SNAP_BUAT', 'UNGGAH_MULAI']);

async function jalankanOp(op: string, data: any, pasangan: DataPasangan): Promise<unknown> {
  const peer = { id: pasangan.peerId, nama: pasangan.peerNama };
  if (OP_BERLISENSI.has(op)) {
    try {
      const id = await periksaLisensiHp(data?.lisensi, pasangan.lisensiId ?? null);
      if (pasangan.lisensiId == null) await perbaruiPasangan({ lisensiId: id });
    } catch (e) {
      const g = e as GalatLisensiSinkron;
      useSyncStore.getState().setStatus('GALAT', g.message);
      throw galat(g.kode ?? 'LISENSI_BEDA', g.message);
    }
  }
  switch (op) {
    case 'INFO':
      return infoServer();
    case 'SYNC':
      return opSync(data, pasangan);
    case 'SNAP_BUAT': {
      useSyncStore.getState().setStatus('MENYINKRONKAN', 'Menyiapkan salinan data untuk HP…');
      useSyncStore.getState().setAliran('DESKTOP_KE_HP');
      const s = await buatSnapshot();
      snapshotKeluar = { id: idAcak(), ...s };
      return { id: snapshotKeluar.id, ukuran: s.ukuran, sha256: s.sha256, baseline: s.baseline };
    }
    case 'SNAP_AMBIL': {
      if (!snapshotKeluar || data.id !== snapshotKeluar.id) throw galat('SNAPSHOT_HILANG', 'Salinan data tidak ditemukan; ulangi.');
      const f = new File(snapshotKeluar.uri);
      const h = f.open();
      try {
        h.offset = Number(data.offset);
        const panjang = Math.max(0, Math.min(Number(data.panjang), snapshotKeluar.ukuran - Number(data.offset)));
        const st = useSyncStore.getState();
        if (!st.aliran) st.setAliran('DESKTOP_KE_HP');
        st.setPersen(Math.min(1, (Number(data.offset) + panjang) / Math.max(1, snapshotKeluar.ukuran)));
        st.setProgres('Mengirim data ke HP…');
        return { data: b64(h.readBytes(panjang)) };
      } finally {
        h.close();
      }
    }
    case 'SNAP_SELESAI': {
      if (!snapshotKeluar || data.id !== snapshotKeluar.id || data.baseline !== snapshotKeluar.baseline) throw galat('SNAPSHOT_HILANG', 'Salinan data tidak cocok.');
      await setelKursorSetelahSnapshotKeluar(peer, Number(data.smax), Number(data.sseq));
      const db = await getDb();
      await perbaruiPasangan({ baseline: snapshotKeluar.baseline, keputusan: null, hwm: await nomorUrutChangelog(db), terakhirSinkron: new Date().toISOString() });
      await FileSystem.deleteAsync(snapshotKeluar.uri, { idempotent: true });
      snapshotKeluar = null;
      useSyncStore.getState().setKonflik([]);
      useSyncStore.getState().setProgres(null);
      useSyncStore.getState().setAliran(null);
      useSyncStore.getState().setStatus('SIAP', 'Data HP kini sama dengan desktop.');
      return { ok: true };
    }
    case 'UNGGAH_MULAI': {
      const id = idAcak();
      const dir = DIR_SINKRON;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const uri = `${dir}unggah-${id}.db`;
      const f = new File(uri);
      if (f.exists) f.delete();
      f.create({ overwrite: true });
      unggahan.set(id, { uri, ukuran: Number(data.ukuran), sha256: String(data.sha256), diterima: 0, status: 'MENERIMA', alasan: String(data.alasan ?? '') });
      useSyncStore.getState().setStatus('MENYINKRONKAN', 'Menerima salinan data dari HP…');
      useSyncStore.getState().setAliran('HP_KE_DESKTOP');
      return { id };
    }
    case 'UNGGAH_POTONG': {
      const u = unggahan.get(String(data.id));
      if (!u || u.status !== 'MENERIMA') throw galat('UNGGAH_HILANG', 'Sesi unggah tidak ditemukan.');
      const bytes = dariB64(String(data.data));
      const h = new File(u.uri).open();
      try {
        h.offset = Number(data.offset);
        h.writeBytes(bytes);
      } finally {
        h.close();
      }
      u.diterima = Math.max(u.diterima, Number(data.offset) + bytes.length);
      useSyncStore.getState().setPersen(Math.min(1, u.diterima / Math.max(1, u.ukuran)));
      useSyncStore.getState().setProgres('Menerima data dari HP…');
      return { diterima: u.diterima };
    }
    case 'UNGGAH_SELESAI': {
      const id = String(data.id);
      const u = unggahan.get(id);
      if (!u) throw galat('UNGGAH_HILANG', 'Sesi unggah tidak ditemukan.');
      useSyncStore.getState().setProgres(null);
      const cek = hashBerkas(u.uri);
      if (cek.ukuran !== u.ukuran || cek.sha256 !== u.sha256) {
        u.status = 'GAGAL';
        u.pesan = 'Berkas rusak saat dikirim (hash tidak cocok). Ulangi.';
        return { status: u.status, pesan: u.pesan };
      }
      const info = await infoServer();
      const otomatis = pasangan.keputusan === 'PAKAI_HP' || !info.setupSelesai;
      if (otomatis) {
        void terapkanUnggahan(id, peer);
        return { status: 'MENERAPKAN' };
      }
      u.status = 'MENUNGGU';
      useSyncStore.getState().setStatus('MENUNGGU_KONFIRMASI', `${peer.nama} meminta mengganti data desktop.`);
      useSyncStore.getState().setKonfirmasi({
        id,
        judul: 'Ganti data desktop dengan data HP?',
        pesan:
          `${peer.nama} mengirim datanya (Kirim data HP → PC). Data di komputer ini akan diganti dengan salinan data HP.\n\n` +
          'Sebelum diganti, data desktop saat ini otomatis dicadangkan (menu Backup & Restore) dan perubahan yang belum terkirim diarsipkan.',
        setujui: async () => {
          useSyncStore.getState().setKonfirmasi(null);
          await terapkanUnggahan(id, peer);
        },
        tolak: async () => {
          useSyncStore.getState().setKonfirmasi(null);
          u.status = 'DITOLAK';
          u.pesan = 'Ditolak oleh pengguna desktop.';
          await FileSystem.deleteAsync(u.uri, { idempotent: true });
          await segarkanStatusDesktop();
        },
      });
      return { status: 'MENUNGGU' };
    }
    case 'UNGGAH_STATUS': {
      const u = unggahan.get(String(data.id));
      if (!u) throw galat('UNGGAH_HILANG', 'Sesi unggah tidak ditemukan.');
      return { status: u.status, hasil: u.hasil ?? null, pesan: u.pesan ?? null };
    }
    case 'LISENSI_SPONSOR':
      return opLisensiSponsor(data);
    case 'PUTUS':
      await putuskanPemasanganDesktop();
      return { ok: true };
    case 'TOLAK_PERMINTAAN': {
      // RC-S133.5 — pemilik HP menolak permintaan kirim dari desktop.
      await perbaruiPasangan({ keputusan: null });
      useSyncStore.getState().setStatus('SIAP', `${peer.nama} menolak permintaan kirim data.`);
      return { ok: true };
    }
    default:
      throw galat('OP_TIDAK_DIKENAL', `Operasi ${op} tidak dikenal.`);
  }
}

/**
 * Lisensi desktop otomatis dari HP (aktivasi pendamping). Token HP hanya
 * dipakai sebagai bukti ke server lisensi dan TIDAK disimpan di desktop.
 * Dibatasi satu percobaan per 2 menit agar tidak memicu rate-limit server.
 */
let percobaanLisensiTerakhir: { waktu: number; hasil: { ok: boolean; pesan: string } } | null = null;

async function opLisensiSponsor(data: { token?: string; deviceId?: string }): Promise<{ ok: boolean; pesan: string }> {
  if (await hasValidLocalLicense().catch(() => false)) return { ok: true, pesan: 'Lisensi desktop sudah aktif.' };
  useSyncStore.getState().setLisensiOtomatis({ ok: false, pesan: 'Menerima lisensi dari HP, menghubungi server lisensi…', waktu: new Date().toISOString() });
  if (percobaanLisensiTerakhir && Date.now() - percobaanLisensiTerakhir.waktu < 2 * 60 * 1000 && !percobaanLisensiTerakhir.hasil.ok) {
    return percobaanLisensiTerakhir.hasil;
  }
  const r = await activateLicenseCompanion({ sponsorToken: String(data.token ?? ''), sponsorDeviceId: String(data.deviceId ?? '') });
  const hasil = r.ok
    ? { ok: true, pesan: 'Lisensi desktop diaktifkan otomatis dari HP.' }
    : { ok: false, pesan: r.message };
  percobaanLisensiTerakhir = { waktu: Date.now(), hasil };
  useSyncStore.getState().setLisensiOtomatis({ ...hasil, waktu: new Date().toISOString() });
  if (r.ok) {
    useAppStore.getState().triggerLicenseRecheck();
    useSyncStore.getState().setStatus(useSyncStore.getState().status, hasil.pesan);
  }
  return hasil;
}

async function terapkanUnggahan(id: string, peer: { id: string; nama: string }): Promise<void> {
  const u = unggahan.get(id);
  if (!u) return;
  u.status = 'MENERAPKAN';
  useSyncStore.getState().setStatus('MENYINKRONKAN', 'Mengganti data desktop dengan data HP…');
  try {
    await arsipkanPerubahanTertunda(peer.id, 'Data desktop diganti dengan data HP', useSyncStore.getState().konflik);
    const hasil = await gantiDatabaseDenganSnapshot(u.uri, peer);
    const db = await getDb();
    await perbaruiPasangan({ baseline: hasil.baseline, keputusan: null, hwm: await nomorUrutChangelog(db), terakhirSinkron: new Date().toISOString() });
    u.hasil = { smax: hasil.smax, sseq: hasil.sseq, baseline: hasil.baseline };
    u.status = 'SELESAI';
    useSyncStore.getState().setAliran(null);
    useSyncStore.getState().setKonflik([]);
    useSyncStore.getState().setStatus('SIAP', `Data desktop kini sama dengan ${peer.nama}. Backup pengaman: ${hasil.backupPengaman}`);
  } catch (e) {
    u.status = 'GAGAL';
    u.pesan = e instanceof Error ? e.message : String(e);
    useSyncStore.getState().setAliran(null);
    useSyncStore.getState().setStatus('GALAT', u.pesan);
  }
}

async function opSync(data: { baseline: string; skema: number; perubahan: Perubahan[]; kursorTerima: number }, pasangan: DataPasangan) {
  if (data.skema !== SCHEMA_VERSION) throw galat('SKEMA_BEDA', `Versi data HP v${data.skema}, desktop v${SCHEMA_VERSION}. Samakan versi aplikasi.`);
  if (pasangan.keputusan) return { status: 'KEPUTUSAN', keputusan: pasangan.keputusan };
  if (!pasangan.baseline) throw galat('PERLU_DATA_AWAL', 'Data awal belum dipilih.');
  const db = await getDb();
  await pasangInfrastrukturSinkron(db);
  const dbBaseline = await bacaMeta(db, 'baseline');
  if (data.baseline !== pasangan.baseline || dbBaseline !== pasangan.baseline || (await nomorUrutChangelog(db)) < pasangan.hwm) {
    useSyncStore.getState().setStatus('PERLU_SINKRON_ULANG', 'Data salah satu perangkat telah dipulihkan/direset. Pilih perangkat buku induk.');
    throw galat('PERLU_SINKRON_ULANG', 'Data salah satu perangkat telah dipulihkan/direset sejak sinkron terakhir. Pilih perangkat buku induk untuk menyamakan data.');
  }
  const peer = { id: pasangan.peerId, nama: pasangan.peerNama };
  useSyncStore.getState().setStatus('MENYINKRONKAN');
  const kursor = (await bacaKursor(db, peer.id)) ?? { terima_seq: 0, kirim_seq: 0 };
  const masuk = (data.perubahan ?? []).filter((p) => Number(p.seq) > kursor.terima_seq);
  const kursorHp = Math.max(0, Number(data.kursorTerima) || 0);
  const lokal = await kunciPerubahanLokalSejak(db, kursorHp);
  const konflik = cariKonflik(lokal, masuk);
  if (konflik.length > 0) {
    useSyncStore.getState().setKonflik(konflik);
    useSyncStore.getState().setStatus('KONFLIK', `${konflik.length} data diubah di HP dan desktop sekaligus.`);
    await catatRiwayat(db, 'MASUK', 0, masuk.length, 'KONFLIK', `${konflik.length} baris bentrok`);
    return { status: 'KONFLIK', jenis: 'BARIS_SAMA', konflik: konflik.slice(0, 100), jumlah: konflik.length };
  }
  const maksMasuk = masuk.reduce((m, p) => Math.max(m, Number(p.seq)), kursor.terima_seq);
  const seqLokal = await seqLokalTertinggi(db);
  const sesudah = [...sqlSetKursor(peer.id, peer.nama, { terima_seq: maksMasuk, kirim_seq: kursorHp, status: 'OK' }), sqlPangkasChangelog(kursorHp)];
  try {
    await terapkanPerubahan(db, masuk, { sesudah, seqLokalDiharapkan: seqLokal });
  } catch (e) {
    if (e instanceof KonflikSinkronError && e.jenis === 'PERUBAHAN_BARU') return { status: 'ULANGI' };
    if (e instanceof KonflikSinkronError) {
      useSyncStore.getState().setKonflik([]);
      useSyncStore.getState().setStatus('KONFLIK', e.message);
      await catatRiwayat(db, 'MASUK', 0, masuk.length, 'KONFLIK', e.message);
      return { status: 'KONFLIK', jenis: e.jenis, konflik: [], pesan: e.message, jumlah: 0 };
    }
    throw e;
  }
  const keluar = await ambilPerubahanLokal(db, kursorHp, BATAS_PAKET);
  const terakhir = new Date().toISOString();
  await perbaruiPasangan({ hwm: await nomorUrutChangelog(db), terakhirSinkron: terakhir });
  await catatRiwayat(db, 'DUA_ARAH', keluar.length, masuk.length, 'OK');
  const s = useSyncStore.getState();
  s.setTerakhir(terakhir);
  s.setKonflik([]);
  s.setStatus('SIAP');
  s.setTertunda(await jumlahTertunda(db, peer.id));
  if (masuk.length > 0) s.naikkanVersiData();
  if (keluar.length > 0) {
    s.setAliran('DESKTOP_KE_HP');
    s.setProgres(`Mengirim ${keluar.length} perubahan ke HP…`);
    setTimeout(() => {
      useSyncStore.getState().setAliran(null);
      useSyncStore.getState().setProgres(null);
    }, 1600);
  }
  return {
    status: 'OK',
    diterimaSampai: maksMasuk,
    perubahan: keluar,
    adaLanjutan: keluar.length >= BATAS_PAKET,
    perangkatUtama: pasangan.perangkatUtama,
  };
}

/** Khusus uji: menirukan renderer desktop dimuat ulang (sesi unggah di memori hilang). */
export function _lupakanSesiUnggahUntukUji(): void {
  unggahan.clear();
}
