'use strict';
/**
 * KOPKU LAN SERVER — ORKESTRATOR (opsional, bawaan MATI).
 *
 * Dua saklar yang BERDIRI SENDIRI (diatur dari KOPKU Desktop ›
 * Pengaturan › LAN & WhatsApp):
 *
 *  1. Server LAN Multi-User  (kopku-server.json → mode LAN_SERVER/DESKTOP)
 *       ON : HTTP API + web UI untuk browser di Wi-Fi/LAN yang sama.
 *       OFF: port ditutup, tidak ada akses dari perangkat lain.
 *  2. WhatsApp Reminder      (kopku-server.db → pengaturan whatsapp.reminder.aktif)
 *       ON : penjadwal H-3/H-1/H/H+1/H+7 berjalan di proses ini
 *            (TIDAK butuh Server LAN menyala).
 *       OFF: penjadwal berhenti; tidak ada pesan terkirim.
 *
 * Keduanya OFF (bawaan) = KOPKU Desktop berjalan persis seperti sebelumnya:
 * tidak ada server, adapter, mutex, maupun penjadwal.
 * Seluruh akses koperasi.db tetap lewat proses KOPKU ini saja.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ServerDb } = require('./serverDb');
const { ServerConfig, WhatsAppKredensial, validasiKredensialUi, MODE } = require('./config');
const { SesiStore, PembatasLogin } = require('./auth');
const { aksesLan, LABEL_PERAN, ROLE_LAN_DILARANG } = require('./rbac');
const { AuditLan, LoggerAman } = require('./audit');
const { LanApi } = require('./api');
const { LanHttpServer } = require('./httpServer');
const { bangunIndeks } = require('./bundleIndex');
const { WhatsAppService } = require('./whatsapp/WhatsAppService');
const { ReminderScheduler, PengaturanWa, JENIS } = require('./whatsapp/ReminderScheduler');
const { normalisasiNomor, samarkanNomor } = require('./whatsapp/nomor');

/** Alamat IPv4 privat dari antarmuka jaringan aktif (logika yang sama dengan server sinkron HP). */
function alamatLan() {
  const os = require('node:os');
  const out = [];
  for (const [nama, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      if (/vEthernet|VirtualBox|VMware|docker|br-|veth/i.test(nama)) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue; // hanya privat
      out.push({ antarmuka: nama, alamat: a.address });
    }
  }
  const skor = (x) => (x.startsWith('192.168.') ? 3 : x.startsWith('10.') ? 2 : 1);
  return out.sort((x, y) => skor(y.alamat) - skor(x.alamat));
}

/** Galat yang pesannya aman ditampilkan di layar desktop. */
function galatDesktop(pesan, kode = 'VALIDASI') {
  return Object.assign(new Error(pesan), { kode, code: kode });
}

const PELAKU_DESKTOP = { userId: null, username: 'KOPKU Desktop (lokal)' };

class KopkuLanServer {
  /**
   * @param {object} o
   * @param {string} o.dataDir folder data aplikasi (userData)
   * @param {string} o.rendererDir folder renderer (untuk indeks modul)
   * @param {{ panggil:Function, pasang?:Function, siap:boolean }} o.bridge
   * @param {{get,set,remove}} [o.secure] secure store (DPAPI/Keychain)
   * @param {typeof fetch} [o.fetch]
   * @param {object} [o.env]
   * @param {() => number} [o.now]
   * @param {number} [o.tickMs]
   */
  constructor(o) {
    this.o = o;
    this.config = new ServerConfig(o.dataDir);
    this.dbFile = path.join(o.dataDir, 'kopku-server.db');
    this.db = null;
    this.http = null;
    this.scheduler = null;
    this.pengaturan = null;
    this.waService = null;
    this.audit = null;
    this.api = null;
    this.galat = null; // galat Server LAN
    this.galatWa = null; // galat WhatsApp Reminder
    this.ids = null;
    this.logger = new LoggerAman(o.logFile === null ? null : path.join(o.dataDir, 'logs', 'kopku-server.log'), () => this._rahasiaAktif || []);
    this._rahasiaAktif = [];
    this.kredensial = new WhatsAppKredensial({ env: o.env || process.env, envFile: this.config.envFile, secure: o.secure || null, ui: () => this._kredensialUi() });
    this._pembersih = null;
    this._antrean = Promise.resolve();
    this._testTerakhir = 0;
  }

  /** Server LAN (HTTP) sedang mendengarkan. */
  get berjalan() {
    return !!(this.http && this.http.server);
  }
  /** Penjadwal WhatsApp Reminder sedang berjalan. */
  get waBerjalan() {
    return !!(this.scheduler && this.scheduler.timer);
  }
  /** Salah satu layanan aktif → adapter KOPKU perlu terpasang di jendela utama. */
  get aktif() {
    return this.berjalan || this.waBerjalan;
  }

  /** Nilai kredensial NON-rahasia yang diisi di layar desktop. */
  _kredensialUi() {
    if (!this.db) return {};
    const v = this.db.getPengaturan('whatsapp.kredensial', {});
    return v && typeof v === 'object' ? v : {};
  }

  _now() {
    return (this.o.now || (() => Date.now()))();
  }

  /** Semua perubahan status dijalankan berurutan (klik cepat ON/OFF tidak saling tumpang tindih). */
  _serial(fn) {
    const p = this._antrean.then(fn, fn);
    this._antrean = p.catch(() => undefined);
    return p;
  }

  async _segarkanRahasia() {
    try {
      const k = await this.kredensial.ambil();
      this._rahasiaAktif = [k.accessToken].filter(Boolean);
    } catch {
      this._rahasiaAktif = [];
    }
  }

  /** Buka kopku-server.db + objek WhatsApp (tanpa menyalakan apa pun). */
  _pastikanDb() {
    if (this.db) return;
    this.db = new ServerDb(this.dbFile);
    this.audit = new AuditLan(this.db, () => this._now());
    this.pengaturan = new PengaturanWa(this.db);
    // Perubahan saklar WhatsApp (layar desktop) langsung diterapkan ke penjadwal.
    const simpanAsli = this.pengaturan.simpan.bind(this.pengaturan);
    this.pengaturan.simpan = (input, oleh) => {
      const baru = simpanAsli(input, oleh);
      if (input && typeof input === 'object' && 'aktif' in input) this._terapkanScheduler(baru.aktif);
      return baru;
    };
    this.waService = new WhatsAppService({ kredensial: this.kredensial, fetch: this.o.fetch, logger: this.logger });
    this.scheduler = new ReminderScheduler({ db: this.db, bridge: this.o.bridge, service: this.waService, pengaturan: this.pengaturan, logger: this.logger, now: () => this._now(), tickMs: this.o.tickMs });
  }

  _terapkanScheduler(aktif) {
    if (!this.scheduler) return;
    if (aktif && this.o.bridge && this.o.bridge.siap) this.scheduler.start();
    else if (!aktif) this.scheduler.stop();
  }

  /** Status WhatsApp tersimpan tanpa membuat berkas baru bila belum pernah dipakai. */
  _waAktifTersimpan() {
    if (this.pengaturan) return this.pengaturan.baca().aktif;
    if (!fs.existsSync(this.dbFile)) return false;
    this._pastikanDb();
    return this.pengaturan.baca().aktif;
  }

  async _pastikanAdapter() {
    if (!this.ids) {
      const idx = bangunIndeks(this.o.rendererDir);
      if (idx.hilang.length) throw new Error(`Layanan KOPKU tidak ditemukan di renderer: ${idx.hilang.map((h) => h.kunci).join(', ')}`);
      this.ids = idx.modul;
    }
    if (this.o.bridge.pasang && !this.o.bridge.siap) await this.o.bridge.pasang(this.ids);
  }

  /** Dipanggil saat KOPKU dibuka / halaman dimuat: nyalakan yang tersimpan ON. Aman dipanggil berulang. */
  async mulaiBilaAktif() {
    return this._serial(async () => {
      const lan = this.config.baca().mode === MODE.LAN_SERVER;
      let wa = false;
      try {
        wa = this._waAktifTersimpan();
      } catch {
        wa = false;
      }
      if (!lan && !wa) {
        if (this.db && !this.aktif) this._tutupDb();
        return this.status();
      }
      return this._sinkron(lan);
    });
  }

  /** Nyalakan Server LAN sekarang (dipakai uji & kompatibilitas), apa pun isi konfigurasi. */
  async mulai() {
    return this._serial(() => this._sinkron(true));
  }

  /**
   * Samakan keadaan berjalan dengan keadaan yang diminta.
   * Galat Server LAN tidak mematikan WhatsApp Reminder, dan sebaliknya.
   */
  async _sinkron(lanDiminta) {
    const c = this.config.baca();
    const lan = lanDiminta === undefined ? c.mode === MODE.LAN_SERVER : !!lanDiminta;
    this.galat = null;
    this.galatWa = null;
    this._pastikanDb();
    const wa = this.pengaturan.baca().aktif;
    if (!lan && !wa) {
      await this._hentiSemua();
      return this.status();
    }
    try {
      await this._pastikanAdapter();
    } catch (e) {
      const pesan = String(e.message || e).slice(0, 300);
      if (lan) this.galat = pesan;
      if (wa) this.galatWa = pesan;
      this.logger.error('Adapter KOPKU gagal dipasang', { pesan });
      await this._hentiHttp();
      this.scheduler.stop();
      return this.status();
    }
    await this._segarkanRahasia();

    // ---- Server LAN
    if (lan && !this.berjalan) {
      try {
        await this._mulaiHttp(c);
      } catch (e) {
        this.galat = e.code === 'EADDRINUSE' ? `Port ${c.port} sedang dipakai aplikasi lain. Ganti port lalu terapkan lagi.` : String(e.message || e).slice(0, 300);
        this.logger.error('KOPKU LAN server gagal dimulai', { pesan: this.galat });
        await this._hentiHttp();
      }
    } else if (!lan && this.berjalan) {
      await this._hentiHttp();
    }

    // ---- WhatsApp Reminder
    try {
      if (wa) this.scheduler.start();
      else this.scheduler.stop();
    } catch (e) {
      this.galatWa = String(e.message || e).slice(0, 300);
    }
    return this.status();
  }

  async _mulaiHttp(c) {
    const now = () => this._now();
    const sesi = new SesiStore(this.db, { idleMenit: c.sesiIdleMenit, maksJam: c.sesiMaksJam }, now);
    const isHttps = !!(c.https.aktif && c.https.certFile && c.https.keyFile);
    this.api = new LanApi({
      db: this.db,
      bridge: this.o.bridge,
      sesi,
      pembatas: new PembatasLogin(this.db, now),
      audit: this.audit,
      logger: this.logger,
      https: () => isHttps,
      bacaEkspor: (u) => this._bacaEkspor(u),
      now,
      tidur: this.o.tidur,
    });
    this.http = new LanHttpServer({ api: this.api, logger: this.logger, hanyaPrivat: c.hanyaJaringanPrivat, https: isHttps ? { certFile: c.https.certFile, keyFile: c.https.keyFile } : null });
    await this.http.listen(c.port, c.host);
    this._pembersih = setInterval(() => {
      try {
        sesi.bersihkan();
        this.api && this.api.bersihkanIdempotensi();
      } catch {
        /* abaikan */
      }
    }, 10 * 60 * 1000);
    if (this._pembersih.unref) this._pembersih.unref();
    this.logger.info('KOPKU LAN server berjalan', { port: this.http.port, host: c.host, https: isHttps });
  }

  async _hentiHttp() {
    if (this._pembersih) clearInterval(this._pembersih);
    this._pembersih = null;
    if (this.http) await this.http.close();
    this.http = null;
    this.api = null;
  }

  _tutupDb() {
    if (this.scheduler) this.scheduler.stop();
    if (this.db) this.db.close();
    this.db = null;
    this.scheduler = null;
    this.pengaturan = null;
    this.waService = null;
    this.audit = null;
  }

  async _hentiSemua() {
    await this._hentiHttp();
    this._tutupDb();
  }

  _kredensialDenganSegar() {
    // Setiap perubahan token lewat UI memperbarui daftar rahasia logger.
    const k = this.kredensial;
    return {
      ringkasan: () => k.ringkasan(),
      simpanTokenAman: async (t) => {
        await k.simpanTokenAman(t);
        await this._segarkanRahasia();
      },
      hapusTokenAman: async () => {
        await k.hapusTokenAman();
        await this._segarkanRahasia();
      },
    };
  }

  /** Matikan semuanya (aplikasi ditutup / uji). Tidak mengubah saklar tersimpan. */
  async henti() {
    return this._serial(async () => {
      await this._hentiSemua();
      return this.status();
    });
  }

  /** Saklar Server LAN. mode: LAN_SERVER (ON) | DESKTOP (OFF). WhatsApp tidak tersentuh. */
  async aturMode(mode, perubahan = {}) {
    if (mode !== MODE.DESKTOP && mode !== MODE.LAN_SERVER) throw new Error('Mode tidak dikenal.');
    return this._serial(async () => {
      this.config.simpan(Object.assign({}, perubahan, { mode }));
      await this._hentiHttp(); // host/port baru berlaku saat dinyalakan ulang
      const wa = this._waAktifTersimpan();
      if (mode === MODE.DESKTOP && !wa) {
        await this._hentiSemua();
        return this.status();
      }
      return this._sinkron(mode === MODE.LAN_SERVER);
    });
  }

  /** Saklar WhatsApp Reminder. Server LAN tidak tersentuh. */
  async aturWhatsApp(aktif) {
    if (typeof aktif !== 'boolean') throw galatDesktop('Status aktif harus ON/OFF.');
    return this._serial(async () => {
      this._pastikanDb();
      this.pengaturan.simpan({ aktif }, null);
      this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_PENGATURAN_UBAH', entity: 'whatsapp', metadata: { aktif, dari: 'desktop' } }));
      return this._sinkron(this.config.baca().mode === MODE.LAN_SERVER);
    });
  }

  // ------------------------------------------------------------------
  // Pengaturan WhatsApp dari layar desktop (tanpa perlu Server LAN/browser).
  // Token tidak pernah dikembalikan; hanya status "tersedia" dan sumbernya.
  // ------------------------------------------------------------------
  async waInfo() {
    this._pastikanDb();
    const p = this.pengaturan.baca();
    return {
      pengaturan: Object.assign({}, p, { nomorTestMasked: p.nomorTest ? samarkanNomor(p.nomorTest) : null }),
      jenisDaftar: Object.entries(JENIS).map(([kunci, d]) => ({ kunci, label: d.label, keterangan: d.keterangan })),
      kredensial: await this.kredensial.ringkasan(),
      nilaiAplikasi: this._kredensialUi(),
      scheduler: this.scheduler.status(),
      ringkasan: this.scheduler.ringkasanStatus(),
      berjalan: this.waBerjalan,
      galat: this.galatWa,
    };
  }

  async waSimpan(input) {
    const o = input && typeof input === 'object' ? input : {};
    const bersih = {};
    for (const k of ['jamKirim', 'jenis', 'nomorTest']) if (k in o) bersih[k] = o[k];
    return this._serial(async () => {
      this._pastikanDb();
      try {
        const baru = this.pengaturan.simpan(bersih, null);
        this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_PENGATURAN_UBAH', entity: 'whatsapp', metadata: { jamKirim: baru.jamKirim, jenis: baru.jenis, nomorTest: baru.nomorTest ? samarkanNomor(baru.nomorTest) : null, dari: 'desktop' } }));
      } catch (e) {
        throw galatDesktop(e.message, e.kode || 'VALIDASI');
      }
      return this.waInfo();
    });
  }

  /** Simpan Phone Number ID, Business Account ID, template, bahasa, versi API (bukan rahasia). */
  async waSimpanKredensial(input) {
    return this._serial(async () => {
      this._pastikanDb();
      let bersih;
      try {
        bersih = validasiKredensialUi(input);
      } catch (e) {
        throw galatDesktop(e.message);
      }
      const baru = Object.assign({}, this._kredensialUi(), bersih);
      for (const k of Object.keys(baru)) if (!baru[k]) delete baru[k];
      this.db.setPengaturan('whatsapp.kredensial', baru, null);
      this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_PENGATURAN_UBAH', entity: 'whatsapp', metadata: { kredensialAplikasi: Object.keys(baru), dari: 'desktop' } }));
      return this.waInfo();
    });
  }

  async waSimpanToken(token) {
    try {
      await this._kredensialDenganSegar().simpanTokenAman(token);
    } catch (e) {
      throw galatDesktop(e.message);
    }
    this._pastikanDb();
    this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_TOKEN_UBAH', entity: 'whatsapp', metadata: { dari: 'desktop' } }));
    return this.waInfo();
  }

  async waHapusToken() {
    await this._kredensialDenganSegar().hapusTokenAman();
    this._pastikanDb();
    this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_TOKEN_HAPUS', entity: 'whatsapp', metadata: { dari: 'desktop' } }));
    return this.waInfo();
  }

  async waTestKoneksi() {
    this._pastikanDb();
    const r = await this.waService.testConnection();
    this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_TEST_KONEKSI', entity: 'whatsapp', status: r.ok ? 'BERHASIL' : 'GAGAL', metadata: { hasil: r.ok ? 'OK' : r.kode, dari: 'desktop' } }));
    return r;
  }

  async waTestPesan() {
    this._pastikanDb();
    const t = this._now();
    if (t - this._testTerakhir < 60000) throw galatDesktop('Pesan uji hanya dapat dikirim sekali per menit.', 'TERLALU_SERING');
    const p = this.pengaturan.baca();
    const nomor = normalisasiNomor(p.nomorTest || '');
    if (!nomor.valid) throw galatDesktop('Isi dan simpan Nomor Test Administrator yang valid terlebih dahulu.');
    this._testTerakhir = t;
    const r = await this.scheduler.kirimTest(nomor.nomor, null);
    this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_TEST_PESAN', entity: 'whatsapp', status: r.status === 'sent' ? 'BERHASIL' : 'GAGAL', metadata: { tujuan: samarkanNomor(nomor.nomor), hasil: r.status, dari: 'desktop' } }));
    return r;
  }

  async waLog(opsi) {
    this._pastikanDb();
    const o = opsi && typeof opsi === 'object' ? opsi : {};
    const status = ['pending', 'sending', 'sent', 'failed', 'skipped'].includes(o.status) ? o.status : null;
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, 100) : 20;
    return { baris: this.scheduler.daftarLog({ status, limit, offset: 0 }), ringkasan: this.scheduler.ringkasanStatus() };
  }

  async waJalankan() {
    return this._serial(async () => {
      if (!this.waBerjalan) throw galatDesktop('Nyalakan WhatsApp Reminder terlebih dahulu.', 'NONAKTIF');
      const r = await this.scheduler.jalankanSekarang({ manual: true });
      this.audit.catat(Object.assign({}, PELAKU_DESKTOP, { action: 'WA_JALANKAN_MANUAL', entity: 'whatsapp', metadata: { dari: 'desktop' } }));
      return r;
    });
  }

  // ------------------------------------------------------------------
  // Akses LAN pengguna, sesi aktif & audit log LAN — DIATUR DARI LAYAR DESKTOP
  // (Pengaturan › LAN & WhatsApp). Sejak Windows 1.0.21 tidak ada lagi menu
  // pengaturan di browser LAN. Daftar pengguna (role/aktif) diambil layar dari
  // layanan User Management KOPKU di jendela utama, lalu digabung di sini
  // dengan baris lan_akses (kopku-server.db).
  // ------------------------------------------------------------------
  /**
   * Berkas hasil ExportService.exportLaporan (folder documents/exports aplikasi).
   * Hanya berkas di DALAM folder ekspor yang boleh dibaca; setelah dikirim ke
   * browser berkas dihapus dari komputer server (salinan ada di perangkat pengguna).
   */
  _bacaEkspor(u) {
    const { toPath } = require('../uri');
    const dir = path.resolve(this.o.dirEkspor || path.join(this.o.dataDir, 'documents', 'exports'));
    const p = path.resolve(toPath(String(u || '')));
    if (!p.startsWith(dir + path.sep)) throw new Error('Berkas ekspor di luar folder ekspor.');
    const isi = fs.readFileSync(p);
    try {
      fs.unlinkSync(p);
    } catch {
      /* abaikan */
    }
    return isi;
  }

  _sesiStore() {
    if (this.api && this.api.sesi) return this.api.sesi;
    const c = this.config.baca();
    return new SesiStore(this.db, { idleMenit: c.sesiIdleMenit, maksJam: c.sesiMaksJam }, () => this._now());
  }

  static _penggunaBersih(u) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !/^[A-Za-z0-9_\-]{1,64}$/.test(u.id)) return null;
    const teks = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, n);
    return { id: u.id, nama: teks(u.nama || u.namaLengkap || u.username, 150), username: teks(u.username, 64), role: teks(u.role, 20).toUpperCase(), aktif: u.aktif === true || u.isActive === true || u.isActive === 1 };
  }

  /** @param {Array<{id,nama,username,role,aktif}>} pengguna dari User Management KOPKU */
  async aksesDaftar(pengguna) {
    this._pastikanDb();
    const akses = new Map(this.db.all('SELECT * FROM lan_akses').map((r) => [r.user_id, r]));
    const list = (Array.isArray(pengguna) ? pengguna : []).slice(0, 2000).map(KopkuLanServer._penggunaBersih).filter(Boolean);
    return list.map((u) => {
      const a = akses.get(u.id) || null;
      const st = aksesLan(u, a);
      return Object.assign(u, { labelPeran: LABEL_PERAN[u.role] || u.role, aksesLan: st.boleh, alasan: st.alasan, profil: st.profil || (a && a.profil) || 'IKUT_ROLE', dapatDiubah: !ROLE_LAN_DILARANG.has(u.role) });
    });
  }

  /**
   * @param {{ pengguna:{id,role,username}, aktif:boolean, profil:'IKUT_ROLE'|'PENGAWAS', oleh?:{userId,username} }} input
   */
  async aksesSimpan(input) {
    const o = input && typeof input === 'object' ? input : {};
    const u = KopkuLanServer._penggunaBersih(o.pengguna);
    if (!u) throw galatDesktop('Pengguna tidak valid.');
    if (typeof o.aktif !== 'boolean') throw galatDesktop('Status akses LAN harus Ya/Tidak.');
    if (o.profil !== 'IKUT_ROLE' && o.profil !== 'PENGAWAS') throw galatDesktop('Profil akses tidak dikenal.');
    if (ROLE_LAN_DILARANG.has(u.role) && o.aktif) throw galatDesktop('Akun Anggota tidak dapat diberi akses LAN.');
    const oleh = o.oleh && typeof o.oleh === 'object' ? o.oleh : {};
    if (oleh.userId && oleh.userId === u.id && (!o.aktif || o.profil === 'PENGAWAS')) throw galatDesktop('Anda tidak dapat mencabut atau menurunkan akses LAN akun sendiri.');
    return this._serial(async () => {
      this._pastikanDb();
      const t = new Date(this._now()).toISOString();
      this.db.run(
        'INSERT INTO lan_akses (user_id, aktif, profil, diubah_oleh, created_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET aktif = excluded.aktif, profil = excluded.profil, diubah_oleh = excluded.diubah_oleh, updated_at = excluded.updated_at',
        u.id,
        o.aktif ? 1 : 0,
        o.profil,
        typeof oleh.userId === 'string' ? oleh.userId.slice(0, 64) : null,
        t,
        t
      );
      if (!o.aktif || o.profil === 'PENGAWAS') this._sesiStore().cabutUser(u.id); // berlaku segera
      this.audit.catat({ userId: typeof oleh.userId === 'string' ? oleh.userId.slice(0, 64) : null, username: typeof oleh.username === 'string' ? oleh.username.slice(0, 64) : PELAKU_DESKTOP.username, action: 'LAN_AKSES_UBAH', entity: 'lan_akses', entityId: u.id, metadata: { target: u.username, aktif: o.aktif, profil: o.profil, dari: 'desktop' } });
      return { userId: u.id, aktif: o.aktif, profil: o.profil };
    });
  }

  async sesiDaftar() {
    this._pastikanDb();
    return this._sesiStore()
      .aktif()
      .map((s) => ({ id: s.id.slice(0, 16), userId: s.user_id, ip: s.ip, perangkat: s.user_agent, mulai: s.created_at, terakhir: s.last_seen_at }));
  }

  async sesiCabut(input) {
    const o = input && typeof input === 'object' ? input : {};
    const pref = typeof o.id === 'string' && /^[a-f0-9]{16}$/i.test(o.id) ? o.id : null;
    if (!pref) throw galatDesktop('Sesi tidak valid.');
    this._pastikanDb();
    const st = this._sesiStore();
    const s = st.aktif().find((x) => x.id.slice(0, 16) === pref);
    if (!s) throw galatDesktop('Sesi sudah berakhir atau tidak ditemukan.', 'TIDAK_DITEMUKAN');
    st.cabutId(s.id);
    const oleh = o.oleh && typeof o.oleh === 'object' ? o.oleh : {};
    this.audit.catat({ userId: typeof oleh.userId === 'string' ? oleh.userId.slice(0, 64) : null, username: typeof oleh.username === 'string' ? oleh.username.slice(0, 64) : PELAKU_DESKTOP.username, action: 'SESI_CABUT', entity: 'sesi', entityId: pref, metadata: { dari: 'desktop' } });
    return { dicabut: true };
  }

  async auditDaftar(input) {
    const o = input && typeof input === 'object' ? input : {};
    const halaman = Number.isInteger(o.halaman) && o.halaman > 0 ? Math.min(o.halaman, 1000) : 1;
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, 100) : 25;
    this._pastikanDb();
    return { halaman, limit, baris: this.audit.daftar({ limit, offset: (halaman - 1) * limit }) };
  }

  _info() {
    const c = this.config.baca();
    const protokol = this.http && this.http.isHttps ? 'https' : 'http';
    const port = (this.http && this.http.port) || c.port;
    const alamat = c.host === '0.0.0.0' ? alamatLan() : c.host === '127.0.0.1' ? [] : [{ antarmuka: 'dipilih', alamat: c.host }];
    return { protokol, port, alamat: alamat.map((a) => Object.assign(a, { url: `${protokol}://${a.alamat}:${port}` })) };
  }

  status() {
    const c = this.config.baca();
    const info = this._info();
    let waAktif = false;
    try {
      waAktif = this.pengaturan ? this.pengaturan.baca().aktif : false;
    } catch {
      waAktif = false;
    }
    return {
      mode: c.mode,
      lanAktif: c.mode === MODE.LAN_SERVER,
      server: this.berjalan ? 'ONLINE' : c.mode === MODE.LAN_SERVER ? 'OFFLINE' : 'NOT_CONFIGURED',
      adapterSiap: !!(this.o.bridge && this.o.bridge.siap),
      host: c.host,
      port: info.port,
      protokol: info.protokol,
      alamat: info.alamat,
      urlLokal: `${info.protokol}://127.0.0.1:${info.port}`,
      hanyaJaringanPrivat: c.hanyaJaringanPrivat,
      https: c.https.aktif,
      galat: this.galat,
      whatsapp: { aktif: waAktif, berjalan: this.waBerjalan, galat: this.galatWa },
      scheduler: this.scheduler ? this.scheduler.status() : null,
    };
  }
}

module.exports = { KopkuLanServer, alamatLan, MODE };
