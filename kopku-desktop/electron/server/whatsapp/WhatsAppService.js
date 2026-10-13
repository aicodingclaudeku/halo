'use strict';
/**
 * KOPKU LAN SERVER — WhatsAppService (WhatsApp Business Platform / Cloud API).
 *
 *   KOPKU Local Server → ReminderScheduler → WhatsAppService
 *     → HTTPS → graph.facebook.com/{versi}/{phone_number_id}/messages
 *
 * - Hanya PESAN TEMPLATE yang sudah disetujui (approved) yang dikirim.
 * - Access token dibaca dari WhatsAppKredensial (env / berkas env / secure
 *   store) tepat saat dipakai; tidak disimpan di objek, tidak di-log, tidak
 *   pernah ada di hasil yang dikembalikan.
 * - Setiap galat diklasifikasikan:
 *     PERMANEN     → jangan diulang (nomor/template tidak sah, 400 lain)
 *     SEMENTARA    → boleh diulang dengan backoff (429, 5xx, timeout)
 *     JARINGAN     → koneksi gagal sebelum terkirim (offline/DNS); diulang
 *                    tanpa menghabiskan jatah percobaan
 *     KONFIGURASI  → 401/403/kredensial belum lengkap; tunda pengiriman
 *                    sampai Admin memperbaiki konfigurasi
 */
const { normalisasiNomor } = require('./nomor');
const { samarkanTeks } = require('../audit');

const KODE_TEMPLATE = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const KODE_NOMOR = new Set([131026, 131030, 131009, 131021, 131047, 131051]);
const KODE_RATE = new Set([4, 80007, 130429, 131048, 131056, 133016]);
const KODE_SERVER = new Set([1, 2, 131000, 131016, 133004]);

function klasifikasiGalatApi(httpStatus, err) {
  const kode = err && typeof err.code === 'number' ? err.code : null;
  if (httpStatus === 401 || kode === 190) return { kategori: 'KONFIGURASI', kode: 'TOKEN_DITOLAK', pesan: 'Access token WhatsApp ditolak (401). Periksa/ganti token.' };
  if (httpStatus === 403 || kode === 10 || (kode >= 200 && kode <= 299)) return { kategori: 'KONFIGURASI', kode: 'IZIN_DITOLAK', pesan: 'Akun WhatsApp Business tidak memiliki izin (403).' };
  if (httpStatus === 429 || KODE_RATE.has(kode)) return { kategori: 'SEMENTARA', kode: 'RATE_LIMIT', pesan: 'Batas kirim WhatsApp tercapai (429). Akan dicoba lagi.' };
  if (httpStatus >= 500 || KODE_SERVER.has(kode)) return { kategori: 'SEMENTARA', kode: 'SERVER_WHATSAPP', pesan: `Server WhatsApp sedang bermasalah (${httpStatus}). Akan dicoba lagi.` };
  if (KODE_TEMPLATE.has(kode)) return { kategori: 'PERMANEN', kode: 'TEMPLATE', pesan: `Template WhatsApp tidak sah/tidak cocok (kode ${kode}).` };
  if (KODE_NOMOR.has(kode)) return { kategori: 'PERMANEN', kode: 'NOMOR', pesan: `Nomor tujuan tidak dapat menerima pesan WhatsApp (kode ${kode}).` };
  return { kategori: 'PERMANEN', kode: 'DITOLAK', pesan: `Permintaan ditolak WhatsApp (HTTP ${httpStatus}${kode ? `, kode ${kode}` : ''}).` };
}

class WhatsAppService {
  /**
   * @param {{ kredensial: import('../config').WhatsAppKredensial, fetch?: typeof fetch, logger?: any, timeoutMs?: number, baseUrl?: string }} o
   */
  constructor(o) {
    this.kredensial = o.kredensial;
    this.fetch = o.fetch || globalThis.fetch;
    this.logger = o.logger || null;
    this.timeoutMs = o.timeoutMs || 15000;
    this.baseUrl = o.baseUrl || 'https://graph.facebook.com';
  }

  validatePhoneNumber(nomor) {
    return normalisasiNomor(nomor);
  }

  async _panggil(method, path, token, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      // Batas waktu ditegakkan dengan race, tidak bergantung pada dukungan
      // AbortSignal di implementasi fetch (net.fetch Electron / fetch Node).
      const habis = new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(Object.assign(new Error('timeout'), { name: 'AbortError' }))));
      const res = await Promise.race([
        this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        }),
        habis,
      ]);
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (e) {
      if (e && (e.name === 'AbortError' || ctrl.signal.aborted)) return { galat: { kategori: 'SEMENTARA', kode: 'TIMEOUT', pesan: `Tidak ada jawaban dari WhatsApp dalam ${Math.round(this.timeoutMs / 1000)} detik.` } };
      return { galat: { kategori: 'JARINGAN', kode: 'JARINGAN', pesan: 'Tidak dapat terhubung ke WhatsApp (internet/DNS). Akan dicoba lagi saat koneksi tersedia.' } };
    } finally {
      clearTimeout(timer);
    }
  }

  _bersih(r, token) {
    if (r && r.pesan) r.pesan = samarkanTeks(r.pesan, [token]);
    return r;
  }

  /**
   * @param {{ to: string, parameters: string[], templateName?: string }} p
   * @returns {Promise<{ok:true, messageId:string} | {ok:false, kategori:string, kode:string, pesan:string, httpStatus?:number}>}
   */
  async sendTemplateMessage(p) {
    const k = await this.kredensial.ambil();
    if (!k.phoneNumberId || !k.accessToken || !(p.templateName || k.templateName)) {
      return { ok: false, kategori: 'KONFIGURASI', kode: 'BELUM_DIKONFIGURASI', pesan: 'Kredensial WhatsApp belum lengkap (Phone Number ID, Access Token, Nama Template).' };
    }
    const n = normalisasiNomor(p.to);
    if (!n.valid) return { ok: false, kategori: 'PERMANEN', kode: 'NOMOR', pesan: `Nomor tujuan tidak sah (${n.alasan}).` };
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: n.nomor,
      type: 'template',
      template: {
        name: p.templateName || k.templateName,
        language: { code: k.templateLang },
        components: [{ type: 'body', parameters: (p.parameters || []).map((t) => ({ type: 'text', text: String(t).slice(0, 900) })) }],
      },
    };
    const r = await this._panggil('POST', `/${k.apiVersion}/${encodeURIComponent(k.phoneNumberId)}/messages`, k.accessToken, body);
    if (r.galat) return this._bersih(Object.assign({ ok: false }, r.galat), k.accessToken);
    if (r.status >= 200 && r.status < 300) {
      const id = r.json && Array.isArray(r.json.messages) && r.json.messages[0] && r.json.messages[0].id;
      if (id) return { ok: true, messageId: String(id).slice(0, 200) };
      return { ok: false, kategori: 'SEMENTARA', kode: 'JAWABAN_TIDAK_DIKENAL', pesan: 'Jawaban WhatsApp tidak berisi ID pesan.', httpStatus: r.status };
    }
    return this._bersih(Object.assign({ ok: false, httpStatus: r.status }, klasifikasiGalatApi(r.status, r.json && r.json.error)), k.accessToken);
  }

  /** Cek kredensial & Phone Number ID tanpa mengirim pesan. */
  async testConnection() {
    const k = await this.kredensial.ambil();
    if (!k.phoneNumberId || !k.accessToken) return { ok: false, kode: 'BELUM_DIKONFIGURASI', pesan: 'Phone Number ID atau Access Token belum diisi.' };
    const r = await this._panggil('GET', `/${k.apiVersion}/${encodeURIComponent(k.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, k.accessToken);
    if (r.galat) return this._bersih({ ok: false, kode: r.galat.kode, pesan: r.galat.pesan }, k.accessToken);
    if (r.status >= 200 && r.status < 300 && r.json) {
      return { ok: true, kode: 'OK', pesan: 'Terhubung ke WhatsApp Cloud API.', namaTerverifikasi: r.json.verified_name || null, nomorTampil: r.json.display_phone_number || null, kualitas: r.json.quality_rating || null, templateTerkonfigurasi: !!k.templateName };
    }
    const g = klasifikasiGalatApi(r.status, r.json && r.json.error);
    return this._bersih({ ok: false, kode: g.kode, pesan: g.pesan }, k.accessToken);
  }

  /**
   * Cloud API mengirim status (delivered/read/failed) HANYA lewat webhook
   * publik; server lokal KOPKU tidak membuka endpoint publik, jadi status
   * yang tersedia adalah status kirim lokal (sent = diterima Cloud API).
   */
  async getDeliveryStatus(messageId) {
    return { didukung: false, messageId, pesan: 'Status terkirim/dibaca memerlukan webhook publik WhatsApp; server KOPKU lokal hanya mencatat status "sent" (pesan diterima Cloud API).' };
  }
}

module.exports = { WhatsAppService, klasifikasiGalatApi };
