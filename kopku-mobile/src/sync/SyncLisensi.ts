import { verifyActivationTokenOffline } from '@/security/licenseToken';
import { getStoredLicense } from '@/services/LicenseService';

/**
 * SINKRON HANYA UNTUK LISENSI YANG SAMA (RC-S133.4).
 *
 * KOPKU Desktop hanya bertukar data dengan HP yang lisensinya SAMA
 * (license_id yang sama di token bertanda tangan server):
 *  - HP wajib menyertakan token aktivasinya + ID perangkatnya (dikirim di
 *    dalam kanal sinkron terenkripsi). Desktop memverifikasi tanda tangan
 *    Ed25519, keterikatan token ke perangkat HP, dan masa berlakunya —
 *    verifikasi lokal yang sama dengan aktivasi lisensi biasa.
 *  - Bila desktop sudah berlisensi: license_id HP harus sama dengan
 *    license_id desktop.
 *  - Bila desktop belum berlisensi (mis. baru menerima data HP, lalu
 *    berlisensi otomatis dari HP): license_id HP harus sama dengan yang
 *    tercatat saat pemasangan.
 * Selain itu → ditolak dengan LISENSI_BEDA / LISENSI_HP_TIDAK_SAH.
 */

export class GalatLisensiSinkron extends Error {
  constructor(public readonly kode: 'LISENSI_BEDA' | 'LISENSI_HP_TIDAK_SAH' | 'LISENSI_HP_TIDAK_ADA', message: string) {
    super(message);
    this.name = 'GalatLisensiSinkron';
  }
}

export interface BuktiLisensi {
  token?: string;
  deviceId?: string;
}

/** license_id lisensi perangkat ini (desktop), atau null bila belum berlisensi sah. */
export async function lisensiIdPerangkatIni(): Promise<number | null> {
  const l = await getStoredLicense().catch(() => null);
  if (!l?.activationToken || !l.deviceId) return null;
  const v = await verifyActivationTokenOffline(l.activationToken, { deviceId: l.deviceId, nowMs: Date.now() });
  return v.ok ? v.payload.licenseId : null;
}

export async function periksaLisensiHp(bukti: BuktiLisensi | null | undefined, tercatat?: number | null): Promise<number> {
  if (!bukti?.token || !bukti.deviceId) {
    throw new GalatLisensiSinkron(
      'LISENSI_HP_TIDAK_ADA',
      'HP tidak menyertakan lisensi. Perbarui aplikasi KOPKU di HP ke versi terbaru dan pastikan lisensinya aktif.'
    );
  }
  const v = await verifyActivationTokenOffline(bukti.token, { deviceId: bukti.deviceId, nowMs: Date.now() });
  if (!v.ok) {
    throw new GalatLisensiSinkron('LISENSI_HP_TIDAK_SAH', `Lisensi HP tidak sah atau sudah berakhir (${v.reason}). Buka KOPKU di HP saat online untuk memverifikasi lisensi.`);
  }
  const idHp = v.payload.licenseId;
  const idDesktop = await lisensiIdPerangkatIni();
  const pembanding = idDesktop ?? tercatat ?? null;
  if (pembanding !== null && pembanding !== idHp) {
    throw new GalatLisensiSinkron(
      'LISENSI_BEDA',
      'Lisensi HP BERBEDA dengan lisensi KOPKU Desktop ini. Sinkron hanya dapat dilakukan antar-perangkat dengan lisensi yang sama (1 lisensi = 1 HP + 1 Laptop/PC).'
    );
  }
  return idHp;
}
