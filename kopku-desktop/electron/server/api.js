'use strict';
/**
 * KOPKU LAN SERVER — API HTTP (router + handler).
 *
 * Alur setiap request terproteksi:
 *   cookie sesi → validasi sesi (idle/absolut/dicabut) → user AUTHORITATIVE
 *   dari app_user (aktif, role) → akses LAN → CSRF (request ubah data) →
 *   lisensi & setup KOPKU valid → otorisasi matriks izin existing (+profil
 *   Pengawas) → validasi input → idempotensi (request ubah data) →
 *   service KOPKU existing (via adapter) → audit.
 *
 * Tidak ada endpoint SQL mentah, akses berkas, eksekusi perintah, unduh
 * database, atau internal Electron. Galat internal tidak pernah dikirim
 * ke klien (hanya kode + pesan aman + requestId untuk penelusuran log).
 */
const crypto = require('node:crypto');
const V = require('./validasi');
const { aksesLan, otorisasi, LABEL_PERAN, RESOURCE_PENGAWAS } = require('./rbac');
const { parseCookie, cookieSesi, cookieHapus, samaAman, NAMA_COOKIE } = require('./auth');

const HTTP_KODE = {
  VALIDASI: 422,
  KONFLIK: 409,
  IZIN: 403,
  TIDAK_DITEMUKAN: 404,
  DB_SIBUK: 503,
  TIMEOUT: 504,
  LAYANAN_BELUM_SIAP: 503,
  RENDERER_TIDAK_ADA: 503,
  ADAPTER_GAGAL: 503,
  LAYANAN_TIDAK_TERSEDIA: 501,
  LAYANAN_TIDAK_LENGKAP: 501,
  OP_TIDAK_DIKENAL: 500,
  INTERNAL: 500,
};

class GalatApi extends Error {
  constructor(status, kode, pesan) {
    super(pesan);
    this.status = status;
    this.kode = kode;
  }
}

const tolak = (status, kode, pesan) => {
  throw new GalatApi(status, kode, pesan);
};

class LanApi {
  /**
   * @param {object} d
   * @param {import('./serverDb').ServerDb} d.db
   * @param {{ panggil(op:string,args:object,ctx:object):Promise<any> }} d.bridge
   * @param {import('./auth').SesiStore} d.sesi
   * @param {import('./auth').PembatasLogin} d.pembatas
   * @param {import('./audit').AuditLan} d.audit
   * @param {import('./audit').LoggerAman} d.logger
   * @param {() => boolean} [d.https]
   * @param {(uri:string) => Buffer} [d.bacaEkspor] baca (lalu hapus) berkas hasil exportLaporan
   * @param {() => number} [d.now]
   * @param {(ms:number)=>Promise<void>} [d.tidur]
   */
  constructor(d) {
    Object.assign(this, d);
    this.now = d.now || (() => Date.now());
    this.tidur = d.tidur || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.https = d.https || (() => false);
    this._statusCache = null;
    this.rute = this._rute();
  }

  // ======================================================== pipeline
  async tangani(req) {
    const requestId = crypto.randomBytes(6).toString('hex');
    try {
      const cocok = this._cocokkan(req.method, req.path);
      if (!cocok) tolak(404, 'TIDAK_DITEMUKAN', 'Endpoint tidak ditemukan.');
      const { r, params } = cocok;
      const ctx = { req, params, ip: req.ip, requestId, set: [] };
      if (!r.publik) await this._autentikasi(ctx, r);
      const hasil = r.mutasi ? await this._denganIdempotensi(ctx, r) : await r.h(ctx);
      return Object.assign({ status: 200, body: { ok: true, data: hasil === undefined ? null : hasil } }, ctx.respons || {}, { headers: this._headerSet(ctx) });
    } catch (e) {
      return this._galatKeRespons(e, requestId, req);
    }
  }

  _headerSet(ctx) {
    return ctx.set.length ? { 'Set-Cookie': ctx.set } : {};
  }

  _galatKeRespons(e, requestId, req) {
    let status;
    let kode;
    let pesan;
    if (e instanceof GalatApi) {
      ({ status, kode } = e);
      pesan = e.message;
    } else if (e && e.kode === 'VALIDASI') {
      status = 422;
      kode = 'VALIDASI';
      pesan = e.message;
    } else if (e && e.kode && HTTP_KODE[e.kode]) {
      status = HTTP_KODE[e.kode];
      kode = e.kode;
      pesan = status >= 500 && kode === 'INTERNAL' ? 'Terjadi kesalahan pada server KOPKU.' : e.message;
    } else {
      status = 500;
      kode = 'INTERNAL';
      pesan = 'Terjadi kesalahan pada server KOPKU.';
    }
    if (status >= 500 && this.logger) this.logger.error(`request ${requestId} ${req.method} ${req.path} gagal`, { kode, pesan: e && e.message });
    return { status, body: { ok: false, kode, pesan, requestId }, headers: {} };
  }

  async _statusSistem(paksa = false) {
    const t = this.now();
    if (!paksa && this._statusCache && t - this._statusCache.t < 15000) return this._statusCache.v;
    const v = await this.bridge.panggil('sistem.status', {}, {});
    this._statusCache = { t, v };
    return v;
  }

  async _syaratKopku() {
    let st;
    try {
      st = await this._statusSistem();
    } catch (e) {
      tolak(503, 'LAYANAN_BELUM_SIAP', 'KOPKU Desktop di komputer server belum siap. Pastikan aplikasi terbuka.');
    }
    if (!st.setupSelesai) tolak(503, 'BELUM_SETUP', 'Setup koperasi di KOPKU Desktop belum selesai.');
    if (!st.lisensiValid) tolak(503, 'LISENSI', 'Lisensi KOPKU Desktop di komputer server tidak aktif/valid.');
    return st;
  }

  async _autentikasi(ctx, r) {
    const token = parseCookie(ctx.req.headers.cookie)[NAMA_COOKIE];
    const s = token ? this.sesi.validasi(token) : null;
    if (!s) tolak(401, 'SESI', 'Sesi berakhir atau belum masuk. Silakan masuk kembali.');
    await this._syaratKopku();
    const user = await this.bridge.panggil('auth.user', { userId: s.user_id }, {});
    const akses = aksesLan(user, this.db.get('SELECT aktif, profil FROM lan_akses WHERE user_id = ?', s.user_id));
    if (!akses.boleh) {
      this.sesi.cabut(token);
      this.audit.catat({ userId: s.user_id, username: user && user.username, action: 'SESI_DICABUT', status: 'DITOLAK', ip: ctx.ip, metadata: { alasan: akses.alasan } });
      ctx.set.push(cookieHapus(this.https()));
      tolak(401, 'SESI', 'Akses LAN akun ini tidak aktif lagi. Hubungi Admin.');
    }
    if (ctx.req.method !== 'GET' && !samaAman(ctx.req.headers['x-kopku-csrf'], s.csrf)) {
      tolak(403, 'CSRF', 'Permintaan ditolak (token keamanan tidak cocok). Muat ulang halaman.');
    }
    ctx.token = token;
    ctx.sesiRow = s;
    ctx.user = user;
    ctx.profil = akses.profil;
    const ot = await otorisasi({ user, profil: akses.profil }, r.izin, (uid, res, act) => this.bridge.panggil('izin.cek', { userId: uid, resource: res, action: act }, {}));
    if (!ot.ok) {
      this.audit.catat({ userId: user.id, username: user.username, action: 'AKSES_DITOLAK', entity: r.pola, status: 'DITOLAK', ip: ctx.ip, metadata: { alasan: ot.alasan, method: ctx.req.method } });
      tolak(403, 'IZIN', ot.alasan === 'PENGAWAS_READ_ONLY' ? 'Profil Pengawas hanya dapat melihat data.' : 'Anda tidak memiliki izin untuk tindakan ini.');
    }
  }

  async _denganIdempotensi(ctx, r) {
    const kunciKlien = ctx.req.headers['idempotency-key'];
    if (typeof kunciKlien !== 'string' || !/^[A-Za-z0-9_\-]{8,100}$/.test(kunciKlien)) {
      tolak(400, 'IDEMPOTENCY_KEY', 'Header Idempotency-Key wajib untuk perubahan data.');
    }
    const kunci = `${ctx.user.id}:${kunciKlien}`;
    const ada = this.db.get('SELECT * FROM idempotensi WHERE kunci = ?', kunci);
    if (ada) {
      if (ada.rute !== `${ctx.req.method} ${ctx.req.path}`) tolak(409, 'IDEMPOTENCY_KEY', 'Idempotency-Key sudah dipakai untuk permintaan lain.');
      if (ada.status === 'PROSES') tolak(409, 'SEDANG_DIPROSES', 'Permintaan yang sama sedang diproses. Tunggu sebentar.');
      ctx.respons = { status: ada.http_status, replay: true };
      const body = JSON.parse(ada.respons);
      ctx.respons.body = body;
      return body.data;
    }
    try {
      this.db.run(
        'INSERT INTO idempotensi (kunci, user_id, rute, status, created_at) VALUES (?,?,?,?,?)',
        kunci,
        ctx.user.id,
        `${ctx.req.method} ${ctx.req.path}`,
        'PROSES',
        new Date(this.now()).toISOString()
      );
    } catch {
      tolak(409, 'SEDANG_DIPROSES', 'Permintaan yang sama sedang diproses. Tunggu sebentar.');
    }
    const meta = { method: ctx.req.method, path: ctx.req.path, requestId: ctx.requestId };
    try {
      const hasil = await r.h(ctx);
      const body = { ok: true, data: hasil === undefined ? null : hasil };
      this.db.run("UPDATE idempotensi SET status = 'SELESAI', http_status = 200, respons = ? WHERE kunci = ?", JSON.stringify(body), kunci);
      this.audit.catat({ userId: ctx.user.id, username: ctx.user.username, action: r.aksiAudit, entity: r.entitas, entityId: ctx.entityId || null, status: 'BERHASIL', ip: ctx.ip, metadata: Object.assign(meta, ctx.auditMeta || {}) });
      return hasil;
    } catch (e) {
      const resp = this._galatKeRespons(e, ctx.requestId, ctx.req);
      if (resp.status < 500 && resp.body.kode !== 'KONFLIK') {
        // Galat validasi/izin bersifat final untuk kunci ini → simpan agar replay konsisten.
        this.db.run("UPDATE idempotensi SET status = 'SELESAI', http_status = ?, respons = ? WHERE kunci = ?", resp.status, JSON.stringify(resp.body), kunci);
      } else {
        // Galat sementara / konflik: kunci dilepas agar klien boleh mencoba lagi.
        this.db.run('DELETE FROM idempotensi WHERE kunci = ?', kunci);
      }
      this.audit.catat({ userId: ctx.user.id, username: ctx.user.username, action: r.aksiAudit, entity: r.entitas, entityId: ctx.entityId || null, status: 'GAGAL', ip: ctx.ip, metadata: Object.assign(meta, { kode: resp.body.kode, pesan: resp.body.pesan }) });
      throw e;
    }
  }

  bersihkanIdempotensi() {
    const batas = new Date(this.now() - 24 * 3600 * 1000).toISOString();
    this.db.run("DELETE FROM idempotensi WHERE created_at < ? OR (status = 'PROSES' AND created_at < ?)", batas, new Date(this.now() - 10 * 60 * 1000).toISOString());
  }

  _cocokkan(method, path) {
    for (const r of this.rute) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) return { r, params: m.groups || {} };
    }
    return null;
  }

  // ======================================================== rute
  _rute() {
    const B = this.bridge;
    const call = (ctx, op, args) => B.panggil(op, args, { userId: ctx.user.id });
    const q = (ctx) => ctx.req.query || {};
    const b = (ctx) => {
      const x = ctx.req.body;
      if (x == null || typeof x !== 'object' || Array.isArray(x)) tolak(400, 'BADAN', 'Badan permintaan harus objek JSON.');
      return x;
    };
    const def = [];
    const R = (method, pola, opsi, h) => {
      const re = new RegExp('^' + pola.replace(/:([a-zA-Z]+)/g, '(?<$1>[A-Za-z0-9_\\-]{1,64})') + '$');
      def.push(Object.assign({ method, pola, re, h }, opsi));
    };

    // ------------------------------------------------ publik
    R('GET', '/api/health', { publik: true }, async () => {
      let database = 'NOT_READY';
      try {
        const st = await this._statusSistem(true);
        database = !st.setupSelesai ? 'NOT_CONFIGURED' : st.lisensiValid ? 'READY' : 'LICENSE_REQUIRED';
      } catch {
        database = 'NOT_READY';
      }
      return { layanan: 'kopku-lan', server: 'ONLINE', database, waktu: new Date(this.now()).toISOString() };
    });

    R('POST', '/api/auth/login', { publik: true }, async (ctx) => {
      const body = b(ctx);
      const username = V.teks(body.username, 'Username', { wajib: true, maks: 64 });
      const password = body.password;
      if (typeof password !== 'string' || password.length === 0 || password.length > 256) tolak(422, 'VALIDASI', 'Password wajib diisi.');
      const batas = this.pembatas.cek(username, ctx.ip);
      if (!batas.diizinkan) {
        this.audit.catat({ username, action: 'LOGIN_DIKUNCI', status: 'DITOLAK', ip: ctx.ip, metadata: { sisaDetik: batas.sisaDetik } });
        tolak(429, 'TERKUNCI', `Terlalu banyak percobaan masuk. Coba lagi dalam ${Math.ceil(batas.sisaDetik / 60)} menit.`);
      }
      if (batas.jedaMs) await this.tidur(batas.jedaMs);
      await this._syaratKopku();
      const v = await B.panggil('auth.verifikasi', { username, password }, {});
      if (!v.ok) {
        this.pembatas.catatGagal(username, ctx.ip);
        this.audit.catat({ username, action: 'LOGIN_GAGAL', status: 'GAGAL', ip: ctx.ip, metadata: { alasan: v.alasan === 'HASH_LAMA' ? 'HASH_LAMA' : 'KREDENSIAL' } });
        if (v.alasan === 'HASH_LAMA') tolak(401, 'PERBARUI_PASSWORD', 'Masuk sekali di aplikasi KOPKU Desktop untuk memperbarui keamanan kata sandi, lalu coba lagi.');
        tolak(401, 'KREDENSIAL', 'Username atau password salah.');
      }
      const akses = aksesLan(v.user, this.db.get('SELECT aktif, profil FROM lan_akses WHERE user_id = ?', v.user.id));
      if (!akses.boleh) {
        this.audit.catat({ userId: v.user.id, username, action: 'LOGIN_DITOLAK', status: 'DITOLAK', ip: ctx.ip, metadata: { alasan: akses.alasan } });
        tolak(403, 'AKSES_LAN', akses.alasan === 'ROLE_TIDAK_DIIZINKAN' ? 'Akun Anggota tidak dapat masuk lewat jaringan.' : 'Akun ini belum diberi akses LAN oleh Admin.');
      }
      this.pembatas.berhasil(username);
      const s = this.sesi.buat(v.user.id, ctx.ip, ctx.req.headers['user-agent']);
      ctx.set.push(cookieSesi(s.token, { secure: this.https(), maxAgeDetik: this.sesi.batas.maksJam * 3600 }));
      this.audit.catat({ userId: v.user.id, username, action: 'LOGIN', status: 'BERHASIL', ip: ctx.ip, metadata: { profil: akses.profil } });
      return { user: this._infoUser(v.user, akses.profil), csrf: s.csrf };
    });

    R('POST', '/api/auth/logout', { publik: true }, async (ctx) => {
      const token = parseCookie(ctx.req.headers.cookie)[NAMA_COOKIE];
      const s = token ? this.sesi.validasi(token) : null;
      if (s) {
        if (!samaAman(ctx.req.headers['x-kopku-csrf'], s.csrf)) tolak(403, 'CSRF', 'Permintaan ditolak (token keamanan tidak cocok).');
        this.sesi.cabut(token);
        this.audit.catat({ userId: s.user_id, action: 'LOGOUT', status: 'BERHASIL', ip: ctx.ip });
      }
      ctx.set.push(cookieHapus(this.https()));
      return { keluar: true };
    });

    // ------------------------------------------------ sesi & status
    R('GET', '/api/auth/sesi', { izin: { khusus: 'SESI' } }, async (ctx) => {
      const menu = {};
      const cek = async (k, res, act) => {
        const o = await otorisasi({ user: ctx.user, profil: ctx.profil }, { resource: res, action: act }, (u, r1, a1) => B.panggil('izin.cek', { userId: u, resource: r1, action: a1 }, {}));
        menu[k] = o.ok;
      };
      await cek('anggotaLihat', 'anggota', 'view');
      await cek('anggotaBuat', 'anggota', 'create');
      await cek('anggotaUbah', 'anggota', 'edit');
      await cek('pinjamanLihat', 'pinjaman', 'view');
      await cek('angsuranBayar', 'pinjaman', 'create');
      await cek('simpananSetor', 'simpanan', 'create');
      await cek('laporanLihat', 'laporan', 'view');
      const st = await this._statusSistem();
      // Peta izin lengkap (Permission Matrix existing, dipersempit profil Pengawas) — hanya untuk
      // menampilkan menu; SETIAP endpoint tetap memeriksa izin sendiri di server.
      const izin = await this._petaIzin(ctx);
      return { user: this._infoUser(ctx.user, ctx.profil), csrf: ctx.sesiRow.csrf, menu, izin, koperasi: st.koperasi };
    });

    R('GET', '/api/dashboard', { izin: { khusus: 'SESI' } }, async (ctx) => {
      // Setiap bagian dashboard hanya diisi bila user berhak MELIHAT resource-nya.
      const iz = await this._petaIzin(ctx);
      const bagian = { anggota: iz.anggota.view, simpanan: iz.simpanan.view, pinjaman: iz.pinjaman.view, kas: iz.kas_bank.view, history: iz.history_transaksi.view };
      const d = await call(ctx, 'dashboard.ringkas', { bagian });
      // Kompatibilitas klien lama: kunci datar.
      if (d.pinjaman) Object.assign(d, { pinjamanAktif: d.pinjaman.aktif, sisaPiutang: d.pinjaman.sisaPiutang, jumlahTunggakan: d.pinjaman.jumlahTunggakan, nilaiTunggakan: d.pinjaman.nilaiTunggakan });
      d.bagian = bagian;
      return d;
    });

    // ------------------------------------------------ anggota
    R('GET', '/api/anggota', { izin: { resource: 'anggota', action: 'view' } }, async (ctx) => {
      const h = V.halaman(q(ctx));
      const search = V.teks(q(ctx).cari, 'Pencarian', { maks: 100 });
      const status = q(ctx).status ? V.pilihan(q(ctx).status, 'Status', V.STATUS_ANGGOTA) : undefined;
      return { halaman: h.halaman, baris: await call(ctx, 'anggota.daftar', { search, status, limit: h.limit, offset: h.offset }) };
    });
    R('GET', '/api/anggota/:id', { izin: { resource: 'anggota', action: 'view' } }, (ctx) => call(ctx, 'anggota.detail', { id: V.id(ctx.params.id, 'ID anggota') }));
    R('POST', '/api/anggota', { izin: { resource: 'anggota', action: 'create' }, mutasi: true, aksiAudit: 'ANGGOTA_BUAT', entitas: 'anggota' }, async (ctx) => {
      const data = V.dataAnggota(b(ctx), { buat: true });
      const hasil = await call(ctx, 'anggota.buat', { data });
      ctx.entityId = hasil && hasil.id;
      return { id: hasil.id, nomorAnggota: hasil.nomorAnggota };
    });
    R('PUT', '/api/anggota/:id', { izin: { resource: 'anggota', action: 'edit' }, mutasi: true, aksiAudit: 'ANGGOTA_UBAH', entitas: 'anggota' }, async (ctx) => {
      const body = b(ctx);
      const idA = V.id(ctx.params.id, 'ID anggota');
      ctx.entityId = idA;
      const versi = V.teks(body.versi, 'Versi data', { wajib: true, maks: 40 });
      const data = V.dataAnggota(body.data, { buat: false });
      ctx.auditMeta = { kolom: Object.keys(data) };
      return call(ctx, 'anggota.ubah', { id: idA, versi, data });
    });

    // ------------------------------------------------ pinjaman & angsuran
    R('GET', '/api/pinjaman', { izin: { resource: 'pinjaman', action: 'view' } }, async (ctx) => {
      const h = V.halaman(q(ctx));
      const search = V.teks(q(ctx).cari, 'Pencarian', { maks: 100 });
      const statusKategori = q(ctx).kategori ? V.pilihan(q(ctx).kategori, 'Kategori', ['AKTIF', 'BELUM_AKTIF', 'DIBATALKAN']) : undefined;
      const status = q(ctx).status ? V.pilihan(q(ctx).status, 'Status', ['DIAJUKAN', 'DISETUJUI', 'AKTIF', 'LUNAS', 'MACET', 'DITOLAK']) : undefined;
      return { halaman: h.halaman, baris: await call(ctx, 'pinjaman.daftar', { search, statusKategori, status, limit: h.limit, offset: h.offset }) };
    });
    R('GET', '/api/pinjaman/:id', { izin: { resource: 'pinjaman', action: 'view' } }, (ctx) => call(ctx, 'pinjaman.detail', { id: V.id(ctx.params.id, 'ID pinjaman') }));
    R(
      'POST',
      '/api/pinjaman/:id/angsuran/:jadwalId/bayar',
      { izin: { resource: 'pinjaman', action: 'create' }, mutasi: true, aksiAudit: 'ANGSURAN_BAYAR', entitas: 'angsuran_jadwal' },
      async (ctx) => {
        const body = b(ctx);
        const args = {
          pinjamanId: V.id(ctx.params.id, 'ID pinjaman'),
          jadwalId: V.id(ctx.params.jadwalId, 'ID jadwal'),
          tanggal: V.tanggal(body.tanggal, 'Tanggal bayar'),
          nominal: V.rupiah(body.nominal, 'Nominal'),
          sumberDana: V.pilihan(body.sumberDana, 'Sumber dana', V.SUMBER_DANA),
          bankAccountId: body.sumberDana === 'BANK' ? V.id(body.bankAccountId, 'Rekening bank') : undefined,
          versiJadwal: V.teks(body.versiJadwal, 'Versi jadwal', { wajib: true, maks: 80 }),
        };
        ctx.entityId = args.jadwalId;
        ctx.auditMeta = { pinjamanId: args.pinjamanId, nominal: args.nominal, tanggal: args.tanggal, sumberDana: args.sumberDana };
        return call(ctx, 'angsuran.bayar', args);
      }
    );
    const argsPelunasan = (ctx, sumber) => ({
      pinjamanId: V.id(ctx.params.id, 'ID pinjaman'),
      tanggal: V.tanggal(sumber.tanggal, 'Tanggal pelunasan'),
      metodeJasaPelunasan: sumber.metode ? V.pilihan(sumber.metode, 'Metode jasa pelunasan', V.METODE_PELUNASAN) : undefined,
    });
    R('GET', '/api/pinjaman/:id/pelunasan', { izin: { resource: 'pinjaman', action: 'view' } }, (ctx) => call(ctx, 'pelunasan.hitung', argsPelunasan(ctx, q(ctx))));
    R('POST', '/api/pinjaman/:id/pelunasan', { izin: { resource: 'pinjaman', action: 'create' }, mutasi: true, aksiAudit: 'PELUNASAN', entitas: 'pinjaman' }, async (ctx) => {
      const body = b(ctx);
      const args = Object.assign(argsPelunasan(ctx, body), {
        sumberDana: V.pilihan(body.sumberDana, 'Sumber dana', V.SUMBER_DANA),
        bankAccountId: body.sumberDana === 'BANK' ? V.id(body.bankAccountId, 'Rekening bank') : undefined,
        totalDilihat: V.rupiah(body.totalDilihat, 'Total pelunasan yang ditampilkan'),
      });
      ctx.entityId = args.pinjamanId;
      ctx.auditMeta = { tanggal: args.tanggal, total: args.totalDilihat, metode: args.metodeJasaPelunasan || 'BAWAAN' };
      return call(ctx, 'pelunasan.proses', args);
    });

    // ------------------------------------------------ simpanan
    R('POST', '/api/simpanan/setor', { izin: { resource: 'simpanan', action: 'create' }, mutasi: true, aksiAudit: 'SIMPANAN_SETOR', entitas: 'simpanan_transaksi' }, async (ctx) => {
      const body = b(ctx);
      const args = {
        anggotaId: V.id(body.anggotaId, 'Anggota'),
        jenis: V.pilihan(body.jenis, 'Jenis simpanan', V.JENIS_SIMPANAN),
        tanggal: V.tanggal(body.tanggal, 'Tanggal'),
        nominal: V.rupiah(body.nominal, 'Nominal'),
        sumberDana: V.pilihan(body.sumberDana, 'Sumber dana', V.SUMBER_DANA),
        bankAccountId: body.sumberDana === 'BANK' ? V.id(body.bankAccountId, 'Rekening bank') : undefined,
        periode: V.teks(body.periode, 'Periode', { maks: 7, pola: /^\d{4}-\d{2}$/ }) || undefined,
        keterangan: V.teks(body.keterangan, 'Keterangan', { maks: 200 }) || undefined,
      };
      ctx.auditMeta = { anggotaId: args.anggotaId, jenis: args.jenis, nominal: args.nominal };
      const h = await call(ctx, 'simpanan.setor', args);
      ctx.entityId = h && h.id;
      return h;
    });
    R('GET', '/api/rekening', { izin: { khusus: 'SESI' } }, (ctx) => call(ctx, 'rekening.daftar', {}));

    // ------------------------------------------------ laporan
    R('GET', '/api/laporan/tunggakan', { izin: { resource: 'pinjaman', action: 'view' } }, (ctx) => call(ctx, 'laporan.tunggakan', {}));
    R('GET', '/api/laporan/posisi-keuangan', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.posisi', { tanggal: V.tanggal(q(ctx).tanggal, 'Tanggal') }));
    R('GET', '/api/laporan/lhu', { izin: { resource: 'laporan', action: 'view' } }, (ctx) =>
      call(ctx, 'laporan.lhu', { mulai: V.tanggal(q(ctx).mulai, 'Tanggal mulai'), selesai: V.tanggal(q(ctx).selesai, 'Tanggal selesai') })
    );

    // ================================================ MENU LAN LENGKAP (LAN-WhatsApp3)
    const rekeningArgs = (body, prefix, label) => {
      const jenis = V.pilihan(body[prefix + 'Jenis'] != null ? body[prefix + 'Jenis'] : body.jenis, label, V.JENIS_REKENING);
      return { jenis, bankAccountId: jenis === 'BANK' ? V.id(body[prefix ? prefix + 'BankAccountId' : 'bankAccountId'], 'Rekening bank') : undefined };
    };
    const periode = (ctx) => {
      const mulai = V.tanggal(q(ctx).mulai, 'Tanggal mulai');
      const selesai = V.tanggal(q(ctx).selesai, 'Tanggal selesai');
      if (mulai > selesai) tolak(422, 'VALIDASI', 'Tanggal mulai harus sebelum tanggal selesai.');
      return { mulai, selesai };
    };

    // ---- simpanan
    R('GET', '/api/simpanan/saldo', { izin: { resource: 'simpanan', action: 'view' } }, async (ctx) => call(ctx, 'simpanan.saldoSemua', { search: V.teks(q(ctx).cari, 'Pencarian', { maks: 100 }) }));
    R('GET', '/api/simpanan/sukarela-tersedia', { izin: { resource: 'simpanan', action: 'create' } }, async (ctx) => call(ctx, 'simpanan.sukarelaTersedia', { search: V.teks(q(ctx).cari, 'Pencarian', { maks: 100 }) }));
    R('GET', '/api/simpanan', { izin: { resource: 'simpanan', action: 'view' } }, async (ctx) => {
      const h = V.halaman(q(ctx));
      const anggotaId = q(ctx).anggotaId ? V.id(q(ctx).anggotaId, 'Anggota') : undefined;
      const jenis = q(ctx).jenis ? V.pilihan(q(ctx).jenis, 'Jenis simpanan', V.JENIS_SIMPANAN) : undefined;
      return { halaman: h.halaman, baris: await call(ctx, 'simpanan.histori', { anggotaId, jenis, limit: h.limit, offset: h.offset }) };
    });
    R('GET', '/api/simpanan/:id', { izin: { resource: 'simpanan', action: 'view' } }, (ctx) => call(ctx, 'simpanan.detail', { id: V.id(ctx.params.id, 'ID transaksi') }));
    R('POST', '/api/simpanan/tarik', { izin: { resource: 'simpanan', action: 'create' }, mutasi: true, aksiAudit: 'SIMPANAN_TARIK', entitas: 'simpanan_transaksi' }, async (ctx) => {
      const body = b(ctx);
      const args = {
        anggotaId: V.id(body.anggotaId, 'Anggota'),
        tanggal: V.tanggal(body.tanggal, 'Tanggal'),
        nominal: V.rupiah(body.nominal, 'Nominal'),
        sumberDana: V.pilihan(body.sumberDana, 'Sumber dana', V.SUMBER_DANA),
        bankAccountId: body.sumberDana === 'BANK' ? V.id(body.bankAccountId, 'Rekening bank') : undefined,
        keterangan: V.teks(body.keterangan, 'Keterangan', { maks: 200 }) || undefined,
      };
      ctx.auditMeta = { anggotaId: args.anggotaId, nominal: args.nominal, sumberDana: args.sumberDana };
      const h = await call(ctx, 'simpanan.tarik', args);
      ctx.entityId = h && h.id;
      return h;
    });
    R('GET', '/api/simpanan-berjangka', { izin: { resource: 'simpanan', action: 'view' } }, (ctx) =>
      call(ctx, 'berjangka.daftar', { anggotaId: q(ctx).anggotaId ? V.id(q(ctx).anggotaId, 'Anggota') : undefined })
    );

    // ---- pinjaman: simulasi, pengajuan, pencairan, pembatalan
    R('GET', '/api/pinjaman-simulasi', { izin: { resource: 'pinjaman', action: 'view' } }, (ctx) => {
      const x = q(ctx);
      const num = (v) => (v == null || v === '' ? NaN : Number(v));
      return call(ctx, 'pinjaman.simulasi', {
        jumlahPinjaman: V.rupiah(num(x.jumlah), 'Jumlah pinjaman'),
        tenor: V.bulat(num(x.tenor), 'Tenor', { min: 1, maks: 600 }),
        persentaseJasa: V.desimal(num(x.jasa), 'Persentase jasa'),
        metodeJasa: V.pilihan(x.metode, 'Metode jasa', V.METODE_JASA),
      });
    });
    R('POST', '/api/pinjaman', { izin: { resource: 'pinjaman', action: 'create' }, mutasi: true, aksiAudit: 'PINJAMAN_AJUKAN', entitas: 'pinjaman' }, async (ctx) => {
      const data = V.dataPinjaman(b(ctx));
      ctx.auditMeta = { anggotaId: data.anggotaId, jumlah: data.jumlahPinjaman, tenor: data.tenor, satuan: data.satuanTenor, metode: data.metodeJasa, jasa: data.persentaseJasa };
      const h = await call(ctx, 'pinjaman.ajukan', { data });
      ctx.entityId = h && h.id;
      return h;
    });
    R('POST', '/api/pinjaman/:id/cairkan', { izin: { resource: 'pinjaman', action: 'approve' }, mutasi: true, aksiAudit: 'PINJAMAN_CAIR', entitas: 'pinjaman' }, async (ctx) => {
      const body = b(ctx);
      const args = {
        pinjamanId: V.id(ctx.params.id, 'ID pinjaman'),
        tanggalPencairan: V.tanggal(body.tanggalPencairan, 'Tanggal pencairan'),
        sumberDana: V.pilihan(body.sumberDana, 'Sumber dana', V.SUMBER_DANA),
        bankAccountId: body.sumberDana === 'BANK' ? V.id(body.bankAccountId, 'Rekening bank') : undefined,
        versi: V.teks(body.versi, 'Versi data', { maks: 40 }) || undefined,
      };
      ctx.entityId = args.pinjamanId;
      ctx.auditMeta = { tanggal: args.tanggalPencairan, sumberDana: args.sumberDana };
      return call(ctx, 'pinjaman.cairkan', args);
    });
    R('POST', '/api/pinjaman/:id/batalkan', { izin: { resource: 'pinjaman', action: 'edit' }, mutasi: true, aksiAudit: 'PINJAMAN_BATAL', entitas: 'pinjaman' }, async (ctx) => {
      const body = b(ctx);
      const args = { pinjamanId: V.id(ctx.params.id, 'ID pinjaman'), alasan: V.teks(body.alasan, 'Alasan pembatalan', { wajib: true, maks: 200 }) };
      ctx.entityId = args.pinjamanId;
      ctx.auditMeta = { alasan: args.alasan };
      return call(ctx, 'pinjaman.batalkan', args);
    });

    // ---- kas & bank
    R('GET', '/api/kas/rekening', { izin: { resource: 'kas_bank', action: 'view' } }, (ctx) => call(ctx, 'kas.rekening', {}));
    R('GET', '/api/kas/riwayat', { izin: { resource: 'kas_bank', action: 'view' } }, async (ctx) => {
      const h = V.halaman(q(ctx));
      const x = q(ctx);
      const jenis = x.jenis ? V.pilihan(x.jenis, 'Rekening', V.JENIS_REKENING) : undefined;
      return {
        halaman: h.halaman,
        baris: await call(ctx, 'kas.riwayat', {
          jenis,
          bankAccountId: jenis === 'BANK' && x.bank ? V.id(x.bank, 'Rekening bank') : undefined,
          tanggalMulai: V.tanggal(x.mulai, 'Tanggal mulai', { wajib: false }) || undefined,
          tanggalSelesai: V.tanggal(x.selesai, 'Tanggal selesai', { wajib: false }) || undefined,
          limit: h.limit,
          offset: h.offset,
        }),
      };
    });
    R('GET', '/api/kas/opsi', { izin: { resource: 'kas_bank', action: 'create' } }, (ctx) => call(ctx, 'kas.opsi', {}));
    R('POST', '/api/kas/masuk', { izin: { resource: 'kas_bank', action: 'create' }, mutasi: true, aksiAudit: 'KAS_MASUK', entitas: 'kas_bank' }, async (ctx) => {
      const body = b(ctx);
      const args = Object.assign(rekeningArgs(body, '', 'Rekening penerima'), {
        accountId: V.id(body.accountId, 'Akun pendapatan'),
        tanggal: V.tanggal(body.tanggal, 'Tanggal'),
        nominal: V.rupiah(body.nominal, 'Nominal'),
        kategori: V.teks(body.kategori, 'Kategori', { maks: 100 }) || undefined,
        keterangan: V.teks(body.keterangan, 'Keterangan', { maks: 200 }) || undefined,
      });
      ctx.auditMeta = { jenis: args.jenis, nominal: args.nominal, accountId: args.accountId };
      const h = await call(ctx, 'kas.masuk', args);
      ctx.entityId = h && h.id;
      return h;
    });
    R('POST', '/api/kas/keluar', { izin: { resource: 'kas_bank', action: 'create' }, mutasi: true, aksiAudit: 'KAS_KELUAR', entitas: 'kas_bank' }, async (ctx) => {
      const body = b(ctx);
      const args = Object.assign(rekeningArgs(body, '', 'Rekening sumber'), {
        kategoriKey: V.teks(body.kategoriKey, 'Kategori beban', { wajib: true, maks: 120, pola: /^(kat|lain):[^\u0000-\u001f]{1,110}$/ }),
        tanggal: V.tanggal(body.tanggal, 'Tanggal'),
        nominal: V.rupiah(body.nominal, 'Nominal'),
        keterangan: V.teks(body.keterangan, 'Keterangan', { maks: 200 }) || undefined,
      });
      ctx.auditMeta = { jenis: args.jenis, nominal: args.nominal, kategori: args.kategoriKey };
      const h = await call(ctx, 'kas.keluar', args);
      ctx.entityId = h && h.id;
      return h;
    });
    R('POST', '/api/kas/transfer', { izin: { resource: 'kas_bank', action: 'edit' }, mutasi: true, aksiAudit: 'KAS_TRANSFER', entitas: 'kas_bank' }, async (ctx) => {
      const body = b(ctx);
      const sumberJenis = V.pilihan(body.sumberJenis, 'Rekening sumber', V.JENIS_REKENING);
      const tujuanJenis = V.pilihan(body.tujuanJenis, 'Rekening tujuan', V.JENIS_REKENING);
      const args = {
        sumberJenis,
        sumberBankAccountId: sumberJenis === 'BANK' ? V.id(body.sumberBankAccountId, 'Rekening bank sumber') : undefined,
        tujuanJenis,
        tujuanBankAccountId: tujuanJenis === 'BANK' ? V.id(body.tujuanBankAccountId, 'Rekening bank tujuan') : undefined,
        tanggal: V.tanggal(body.tanggal, 'Tanggal'),
        nominal: V.rupiah(body.nominal, 'Nominal'),
        keterangan: V.teks(body.keterangan, 'Keterangan', { maks: 200 }) || undefined,
      };
      ctx.auditMeta = { dari: sumberJenis, ke: tujuanJenis, nominal: args.nominal };
      return call(ctx, 'kas.transfer', args);
    });

    // ---- data
    R('GET', '/api/akun', { izin: { resource: 'pengaturan', action: 'view' } }, (ctx) =>
      call(ctx, 'akun.daftar', { search: V.teks(q(ctx).cari, 'Pencarian', { maks: 100 }), status: q(ctx).status ? V.pilihan(q(ctx).status, 'Status', ['AKTIF', 'NONAKTIF']) : undefined })
    );
    R('GET', '/api/personel', { izin: { resource: 'anggota', action: 'view' } }, (ctx) => call(ctx, 'personel.daftar', { jenisPersonel: q(ctx).jenis ? V.pilihan(q(ctx).jenis, 'Jenis', V.JENIS_PERSONEL) : undefined }));

    // ---- laporan lengkap
    R('GET', '/api/laporan/laba-rugi', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.labaRugi', periode(ctx)));
    R('GET', '/api/laporan/arus-kas', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.arusKas', periode(ctx)));
    R('GET', '/api/laporan/perubahan-ekuitas', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.ekuitas', periode(ctx)));
    R('GET', '/api/laporan/neraca-saldo', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.neracaSaldo', { tanggal: V.tanggal(q(ctx).tanggal, 'Tanggal') }));
    R('GET', '/api/laporan/akun', { izin: { resource: 'laporan', action: 'view' } }, async (ctx) => (await call(ctx, 'akun.daftar', { status: 'AKTIF' })).map((a) => ({ id: a.id, kode: a.kode, nama: a.nama, kategori: a.kategori })));
    R('GET', '/api/laporan/buku-besar', { izin: { resource: 'laporan', action: 'view' } }, (ctx) => call(ctx, 'laporan.bukuBesar', Object.assign({ accountId: V.id(q(ctx).akun, 'Akun') }, periode(ctx))));
    R('GET', '/api/laporan/kolektibilitas', { izin: { resource: 'pinjaman', action: 'view' } }, (ctx) => call(ctx, 'laporan.kolektibilitas', {}));
    R('GET', '/api/history/jenis', { izin: { resource: 'history_transaksi', action: 'view' } }, (ctx) => call(ctx, 'history.jenis', {}));
    R('GET', '/api/history', { izin: { resource: 'history_transaksi', action: 'view' } }, async (ctx) => {
      const h = V.halaman(q(ctx));
      const x = q(ctx);
      return {
        halaman: h.halaman,
        baris: await call(ctx, 'history.daftar', {
          search: V.teks(x.cari, 'Pencarian', { maks: 100 }) || undefined,
          tanggalMulai: V.tanggal(x.mulai, 'Tanggal mulai', { wajib: false }) || undefined,
          tanggalSelesai: V.tanggal(x.selesai, 'Tanggal selesai', { wajib: false }) || undefined,
          jenis: V.teks(x.jenis, 'Jenis', { maks: 60, pola: /^[A-Z0-9_]+$/ }) || undefined,
          limit: h.limit,
          offset: h.offset,
        }),
      };
    });
    R('GET', '/api/history/:id', { izin: { resource: 'history_transaksi', action: 'view' } }, (ctx) => call(ctx, 'history.detail', { id: V.id(ctx.params.id, 'ID transaksi') }));
    R('GET', '/api/shu', { izin: { resource: 'shu', action: 'view' } }, (ctx) => call(ctx, 'shu.riwayat', {}));
    R('GET', '/api/shu/:id/anggota', { izin: { resource: 'shu', action: 'view' } }, (ctx) => call(ctx, 'shu.anggota', { id: V.id(ctx.params.id, 'ID SHU') }));

    // ---- EKSPOR PDF / Excel / CSV (Windows 1.0.21) — mengikuti aplikasi:
    // builder laporan & ExportService.exportLaporan yang sama dengan tombol Export
    // di KOPKU Desktop (kop, logo, penanda tangan, format Rupiah, nama berkas).
    // Syarat: izin Export (export.export) + izin LIHAT data yang diekspor.
    const opsTanggal = (x, f) => V.tanggal(x, f, { wajib: false }) || undefined;
    const EKSPOR = {
      'posisi-keuangan': { res: 'laporan', p: (x) => ({ tanggal: V.tanggal(x.tanggal, 'Tanggal') }) },
      lhu: { res: 'laporan', p: (x, c) => periode(c) },
      'laba-rugi': { res: 'laporan', p: (x, c) => periode(c) },
      'arus-kas': { res: 'laporan', p: (x, c) => periode(c) },
      'perubahan-ekuitas': { res: 'laporan', p: (x, c) => periode(c) },
      'neraca-saldo': { res: 'laporan', p: (x) => ({ tanggal: V.tanggal(x.tanggal, 'Tanggal') }) },
      'buku-besar': { res: 'laporan', p: (x) => ({ akun: V.id(x.akun, 'Akun'), mulai: opsTanggal(x.mulai, 'Tanggal mulai'), selesai: opsTanggal(x.selesai, 'Tanggal selesai') }) },
      kolektibilitas: { res: 'pinjaman', p: () => ({}) },
      anggota: { res: 'anggota', p: (x) => ({ cari: V.teks(x.cari, 'Pencarian', { maks: 100 }) || undefined, status: x.status ? V.pilihan(x.status, 'Status', V.STATUS_ANGGOTA) : undefined }) },
      pinjaman: { res: 'pinjaman', p: (x) => ({ cari: V.teks(x.cari, 'Pencarian', { maks: 100 }) || undefined, kategori: x.kategori && x.kategori !== 'semua' ? V.pilihan(x.kategori, 'Kategori', ['AKTIF', 'BELUM_AKTIF', 'DIBATALKAN']) : undefined }) },
      angsuran: { res: 'pinjaman', p: (x) => ({ pinjaman: V.id(x.pinjaman, 'Pinjaman') }) },
      simpanan: { res: 'simpanan', p: (x) => ({ jenis: x.jenis ? V.pilihan(x.jenis, 'Jenis simpanan', V.JENIS_SIMPANAN) : undefined }) },
      history: { res: 'history_transaksi', p: (x) => ({ cari: V.teks(x.cari, 'Pencarian', { maks: 100 }) || undefined, mulai: opsTanggal(x.mulai, 'Tanggal mulai'), selesai: opsTanggal(x.selesai, 'Tanggal selesai'), jenisTx: V.teks(x.jenis, 'Jenis', { maks: 60, pola: /^[A-Z0-9_]+$/ }) || undefined }) },
      'data-bank': { res: 'kas_bank', p: () => ({}) },
      'shu-anggota': { res: 'shu', p: (x) => ({ shu: V.id(x.shu, 'SHU') }) },
    };
    const MIME = { PDF: ['application/pdf', 'pdf'], EXCEL: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'], CSV: ['text/csv; charset=utf-8', 'csv'] };
    R('GET', '/api/ekspor/:jenis', { izin: { resource: 'export', action: 'export' } }, async (ctx) => {
      const jenis = ctx.params.jenis;
      const def = Object.prototype.hasOwnProperty.call(EKSPOR, jenis) ? EKSPOR[jenis] : null;
      if (!def) tolak(404, 'TIDAK_DITEMUKAN', 'Jenis ekspor tidak dikenal.');
      const lihat = await otorisasi({ user: ctx.user, profil: ctx.profil }, { resource: def.res, action: 'view' }, (u, r1, a1) => B.panggil('izin.cek', { userId: u, resource: r1, action: a1 }, {}));
      if (!lihat.ok) {
        this.audit.catat({ userId: ctx.user.id, username: ctx.user.username, action: 'AKSES_DITOLAK', entity: 'ekspor', entityId: jenis, status: 'DITOLAK', ip: ctx.ip, metadata: { resource: def.res, action: 'view' } });
        tolak(403, 'IZIN', 'Anda tidak memiliki izin untuk melihat data ini.');
      }
      const format = V.pilihan(String(q(ctx).format || '').toUpperCase(), 'Format', ['PDF', 'EXCEL', 'CSV']);
      const param = def.p(q(ctx), ctx);
      if (!this.bacaEkspor) tolak(501, 'LAYANAN_TIDAK_TERSEDIA', 'Ekspor tidak tersedia pada server ini.');
      const hasil = await call(ctx, 'ekspor.laporan', { jenis, format, param });
      let isi;
      try {
        isi = this.bacaEkspor(hasil && hasil.uri);
      } catch (e) {
        this.logger && this.logger.error('berkas ekspor tidak dapat dibaca', { pesan: e && e.message });
        tolak(500, 'INTERNAL', 'Berkas ekspor tidak dapat dibaca.');
      }
      const [tipe, ext] = MIME[format];
      const nama = String((hasil && hasil.namaBerkas) || `kopku-${jenis}.${ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
      this.audit.catat({ userId: ctx.user.id, username: ctx.user.username, action: 'EKSPOR', entity: 'ekspor', entityId: jenis, status: 'BERHASIL', ip: ctx.ip, metadata: { format, ukuran: isi.length } });
      ctx.respons = { berkas: { isi, nama, tipe } };
      return null;
    });

    // ---- PENGATURAN TIDAK ADA DI WEB (Windows 1.0.21).
    // Akses LAN pengguna, sesi aktif, audit log LAN, WhatsApp Reminder & status server
    // hanya diatur di KOPKU Desktop › Pengaturan › LAN & WhatsApp (IPC lanmu:*, jendela utama
    // saja). Browser LAN hanya untuk transaksi, data, dan laporan sesuai izin.

    return def;
  }

  /** Peta izin user untuk tampilan menu: matriks existing, dipersempit profil Pengawas (sama dengan otorisasi()). */
  async _petaIzin(ctx) {
    if (ctx._petaIzin) return ctx._petaIzin;
    const peta = await this.bridge.panggil('izin.peta', { userId: ctx.user.id }, {});
    if (ctx.profil === 'PENGAWAS') {
      for (const [res, aksi] of Object.entries(peta)) for (const a of Object.keys(aksi)) if (a !== 'view' || !RESOURCE_PENGAWAS.has(res)) aksi[a] = false;
    }
    ctx._petaIzin = peta;
    return peta;
  }

  _infoUser(u, profil) {
    return { id: u.id, nama: u.nama, username: u.username, role: u.role, labelPeran: profil === 'PENGAWAS' ? 'Pengawas (baca saja)' : LABEL_PERAN[u.role] || u.role, profil };
  }
}

module.exports = { LanApi, GalatApi, HTTP_KODE };
