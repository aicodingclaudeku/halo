'use strict';
/**
 * KOPKU LAN SERVER — OTORISASI (RBAC) SISI SERVER.
 *
 * Sumber kebenaran izin = matriks KOPKU EXISTING (`role_permission`,
 * fungsi `hasPermission(userId, resource, action)` di bundle renderer) —
 * matriks yang sama yang dipakai layar desktop & dicek ulang oleh setiap
 * service lewat `requirePermission`. Server LAN TIDAK membuat matriks baru.
 *
 * Lapisan tambahan khusus LAN (hanya MEMPERSEMPIT, tidak pernah menambah):
 *   1. Role ANGGOTA tidak boleh masuk lewat LAN.
 *   2. Selain ADMIN, user harus diberi akses LAN secara eksplisit oleh
 *      Admin (`lan_akses.aktif = 1`). Admin dapat dicabut akses LAN-nya.
 *   3. Profil LAN "PENGAWAS": hanya aksi `view` pada resource baca yang
 *      diizinkan, apa pun role KOPKU-nya (least privilege).
 *
 * Pemetaan peran permintaan → role KOPKU existing:
 *   Admin/Pengurus → ADMIN, PENGURUS
 *   Bendahara      → BENDAHARA
 *   Operator       → PETUGAS
 *   Pengawas       → profil LAN PENGAWAS (read-only) di atas role apa pun
 */

const ROLE_LAN_DILARANG = new Set(['ANGGOTA']);
const RESOURCE_PENGAWAS = new Set(['anggota', 'simpanan', 'pinjaman', 'laporan', 'shu', 'history_transaksi']);
const AKSI = new Set(['view', 'create', 'edit', 'approve', 'export']);

const LABEL_PERAN = {
  ADMIN: 'Admin',
  PENGURUS: 'Pengurus',
  BENDAHARA: 'Bendahara',
  PETUGAS: 'Operator (Petugas)',
  ANGGOTA: 'Anggota',
};

/**
 * Status akses LAN seorang user.
 * @param {{role:string, aktif:boolean}} user baris app_user (authoritative)
 * @param {null|{aktif:number, profil:string}} akses baris lan_akses
 */
function aksesLan(user, akses) {
  if (!user || !user.aktif) return { boleh: false, alasan: 'USER_NONAKTIF', profil: null };
  if (ROLE_LAN_DILARANG.has(user.role)) return { boleh: false, alasan: 'ROLE_TIDAK_DIIZINKAN', profil: null };
  const profil = akses && akses.profil === 'PENGAWAS' ? 'PENGAWAS' : 'IKUT_ROLE';
  if (user.role === 'ADMIN') {
    if (akses && Number(akses.aktif) === 0) return { boleh: false, alasan: 'AKSES_LAN_DICABUT', profil };
    return { boleh: true, alasan: null, profil };
  }
  if (!akses || Number(akses.aktif) !== 1) return { boleh: false, alasan: 'AKSES_LAN_BELUM_DIBERIKAN', profil };
  return { boleh: true, alasan: null, profil };
}

/**
 * @param {{ user:{id:string,role:string,aktif:boolean}, profil:string }} ctx
 * @param {{ resource?:string, action?:string, khusus?:string }} kebutuhan
 * @param {(userId:string, resource:string, action:string)=>Promise<boolean>} hasPermission fungsi KOPKU existing
 * @returns {Promise<{ok:boolean, alasan?:string}>}
 */
async function otorisasi(ctx, kebutuhan, hasPermission) {
  if (!kebutuhan) return { ok: false, alasan: 'TANPA_ATURAN' }; // fail-closed
  const { user, profil } = ctx;
  if (kebutuhan.khusus === 'SESI') return { ok: true };
  if (kebutuhan.khusus === 'AUDIT_LAN') {
    if (profil === 'PENGAWAS') return { ok: true };
    return (await hasPermission(user.id, 'user_management', 'view')) ? { ok: true } : { ok: false, alasan: 'IZIN' };
  }
  const { resource, action } = kebutuhan;
  if (!resource || !AKSI.has(action)) return { ok: false, alasan: 'TANPA_ATURAN' };
  if (profil === 'PENGAWAS' && (action !== 'view' || !RESOURCE_PENGAWAS.has(resource))) return { ok: false, alasan: 'PENGAWAS_READ_ONLY' };
  return (await hasPermission(user.id, resource, action)) ? { ok: true } : { ok: false, alasan: 'IZIN' };
}

module.exports = { aksesLan, otorisasi, RESOURCE_PENGAWAS, LABEL_PERAN, ROLE_LAN_DILARANG };
