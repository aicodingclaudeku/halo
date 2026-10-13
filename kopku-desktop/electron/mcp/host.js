'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · HOST di proses utama.
 *
 *   Claude Desktop ──stdio MCP──▶ electron/mcp/stdio.js
 *        └── HTTP 127.0.0.1:<port acak> + Bearer <token acak 256-bit> ──▶ McpHost (berkas ini)
 *               └── jembatan IPC ──▶ adapter renderer (sama dengan Server LAN) ──▶ service KOPKU ──▶ koperasi.db
 *
 * Pengamanan:
 *   - Bawaan MATI. Dinyalakan dari Pengaturan › Asisten AI oleh pengguna yang punya izin
 *     Pengaturan › Ubah; host bertindak ATAS NAMA pengguna itu (Permission Matrix existing).
 *   - Hanya mendengar 127.0.0.1; token diperbarui setiap kali menyala dan hanya ditulis ke
 *     <userData>/mcp/endpoint.json (folder data milik pengguna Windows/macOS ini).
 *   - Permintaan dengan header Origin (halaman web) atau Host selain localhost ditolak
 *     (cegah DNS rebinding / CSRF dari browser).
 *   - Setiap pemanggilan: pengguna masih aktif & bukan role Anggota, lisensi KOPKU valid,
 *     izin `view` resource alat — gagal tertutup.
 *   - Baca saja (lihat OPERASI_BACA di alat.js). Data pribadi selalu dibuang.
 *   - Log pemakaian <userData>/mcp/pemakaian.log: waktu, alat, berhasil/gagal, durasi — TANPA isi data.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { jalankanAlat, alatTersedia, hariIniLokal } = require('./alat');
const { untukMcp, ALAT, ALAT_TULIS } = require('./katalog');
const { jalankanAlatTulis } = require('./alatTulis');
const { samarkanTeks } = require('./privasi');

const NAMA_TULIS = new Set(ALAT_TULIS.map((a) => a.name));
const JEDA_BACKUP_MS = 30 * 60 * 1000;
// 1.0.28 — batas laju perubahan data (cegah AI "kebablasan" mengubah banyak data sekaligus; import Excel = 1 perubahan).
const BATAS_UBAH = [
  { ms: 60 * 1000, maks: 10, label: '10 perubahan per menit' },
  { ms: 60 * 60 * 1000, maks: 120, label: '120 perubahan per jam' },
];

const BATAS_BADAN = 256 * 1024;
const BATAS_LOG = 512 * 1024;

function tulisAtomik(berkas, isi, mode) {
  const tmp = `${berkas}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, isi, mode ? { mode } : undefined);
  fs.renameSync(tmp, berkas);
}

function galat(pesan, kode = 'VALIDASI') {
  return Object.assign(new Error(pesan), { kode, code: kode });
}

class McpHost {
  /**
   * @param {object} o
   * @param {string} o.dataDir folder data aplikasi (userData)
   * @param {{ panggil:(op:string,args:object,ctx:object)=>Promise<any>, siap:boolean }} o.bridge
   * @param {() => Promise<void>} o.pastikanAdapter pasang adapter renderer bila belum
   * @param {string} [o.versi] versi KOPKU Desktop
   * @param {() => number} [o.now]
   * @param {{ jalankan:(op:string,args:object,ctx:object)=>Promise<{ok:boolean,value?:any,error?:{kode:string,pesan:string}}> }} [o.tulis]
   *        adapter tulis (koreksi, import, backup) — lihat adapterTulis.js
   * @param {(jalur:string) => string} [o.salinKeCache] salin berkas pengguna ke cache aplikasi → URI
   */
  constructor(o) {
    this.o = o;
    this.dir = path.join(o.dataDir, 'mcp');
    this.berkasPengaturan = path.join(this.dir, 'pengaturan.json');
    this.berkasEndpoint = path.join(this.dir, 'endpoint.json');
    this.berkasLog = path.join(this.dir, 'pemakaian.log');
    this.server = null;
    this.port = null;
    this.token = null;
    this.galat = null;
    this.statistik = { total: 0, gagal: 0, terakhir: null, perubahan: 0 };
    this.kodeKonfirmasi = new Map(); // kode → { nama, sidik, kedaluwarsa } (sekali pakai)
    this.backupTerakhir = 0;
    this.waktuUbah = []; // waktu setiap perubahan yang tersimpan (batas laju)
    this._antrean = Promise.resolve();
  }

  _now() {
    return (this.o.now || Date.now)();
  }

  /** Semua perubahan status dijalankan berurutan. */
  _serial(fn) {
    const p = this._antrean.then(fn, fn);
    this._antrean = p.catch(() => undefined);
    return p;
  }

  baca() {
    // cara: 'config' = entri di claude_desktop_config.json (bawaan), 'ekstensi' = paket .mcpb.
    // bolehTulis (1.0.27): Claude boleh MENGUBAH data lewat alat dua-langkah (bawaan MATI).
    const bawaan = { aktif: false, perAnggota: false, bolehTulis: false, pengguna: null, cara: 'config', diubah: null };
    try {
      const j = JSON.parse(fs.readFileSync(this.berkasPengaturan, 'utf8'));
      return Object.assign(bawaan, {
        aktif: j.aktif === true,
        perAnggota: j.perAnggota === true,
        bolehTulis: j.bolehTulis === true && j.perAnggota === true,
        pengguna: j.pengguna && typeof j.pengguna.id === 'string' ? { id: j.pengguna.id, nama: String(j.pengguna.nama || ''), username: String(j.pengguna.username || '') } : null,
        cara: j.cara === 'ekstensi' ? 'ekstensi' : 'config',
        diubah: j.diubah || null,
      });
    } catch {
      return bawaan;
    }
  }

  _simpan(p) {
    fs.mkdirSync(this.dir, { recursive: true });
    tulisAtomik(this.berkasPengaturan, JSON.stringify(Object.assign({}, p, { diubah: new Date(this._now()).toISOString() }), null, 2));
  }

  get berjalan() {
    return !!(this.server && this.server.listening);
  }

  status() {
    const p = this.baca();
    return {
      aktif: p.aktif,
      berjalan: this.berjalan,
      perAnggota: p.perAnggota,
      bolehTulis: p.bolehTulis,
      cara: p.cara,
      pengguna: p.pengguna ? { nama: p.pengguna.nama, username: p.pengguna.username } : null,
      port: this.berjalan ? this.port : null,
      galat: this.galat,
      pemakaian: Object.assign({}, this.statistik),
      jumlahAlat: ALAT.filter((a) => p.perAnggota || !a.perAnggota).length,
      alat: ALAT.map((a) => ({ nama: a.name, judul: a.title, perAnggota: a.perAnggota, aktif: p.perAnggota || !a.perAnggota })),
      alatTulis: ALAT_TULIS.map((a) => ({ nama: a.name, judul: a.title, aktif: p.bolehTulis })),
      folder: this.dir,
    };
  }

  /** Pengguna yang meminta perubahan harus aktif dan punya izin Pengaturan › Ubah. */
  async _cekPengubah(penggunaId) {
    if (typeof penggunaId !== 'string' || !penggunaId) throw galat('Masuk ke KOPKU Desktop terlebih dahulu.', 'IZIN');
    await this.o.pastikanAdapter();
    const u = await this.o.bridge.panggil('auth.user', { userId: penggunaId }, {});
    if (!u || !u.aktif) throw galat('Pengguna tidak ditemukan atau nonaktif.', 'IZIN');
    const boleh = await this.o.bridge.panggil('izin.cek', { userId: u.id, resource: 'pengaturan', action: 'edit' }, {});
    if (!boleh) throw galat('Hanya pengguna dengan izin ubah Pengaturan (Admin) yang dapat mengatur Asisten AI.', 'IZIN');
    return u;
  }

  /**
   * Ubah pengaturan dari layar Pengaturan › Asisten AI.
   * @param {{ aktif?:boolean, perAnggota?:boolean, bolehTulis?:boolean, cara?:'config'|'ekstensi', penggunaId:string }} input
   */
  async atur(input) {
    return this._serial(async () => {
      const i = input && typeof input === 'object' ? input : {};
      const u = await this._cekPengubah(i.penggunaId);
      const p = this.baca();
      if (i.perAnggota !== undefined) p.perAnggota = i.perAnggota === true;
      if (i.bolehTulis !== undefined) p.bolehTulis = i.bolehTulis === true;
      // Mengubah data butuh data per anggota (mencari anggota/pinjaman); mematikan per anggota juga mematikan ubah data.
      if (i.bolehTulis === true) p.perAnggota = true;
      if (!p.perAnggota) p.bolehTulis = false;
      if (!p.bolehTulis) this.kodeKonfirmasi.clear();
      if (i.cara === 'config' || i.cara === 'ekstensi') p.cara = i.cara;
      if (i.aktif !== undefined) {
        p.aktif = i.aktif === true;
        // Menyalakan = host bertindak atas nama pengguna yang menyalakan.
        if (p.aktif) p.pengguna = { id: u.id, nama: u.nama, username: u.username };
      }
      this._simpan(p);
      this._catat({ alat: '(pengaturan)', ok: true, ket: `${p.aktif ? 'Menyala' : 'Mati'} · data per anggota ${p.perAnggota ? 'diizinkan' : 'tidak diizinkan'} · ubah data ${p.bolehTulis ? 'DIIZINKAN' : 'tidak diizinkan'} · ${p.cara === 'ekstensi' ? 'ekstensi .mcpb' : 'konfigurasi Claude Desktop'} · oleh ${u.username}` });
      if (p.aktif) await this._mulai();
      else {
        await this._henti();
        if (this.chatgpt) await this.chatgpt.henti();
      }
      return this.status();
    });
  }

  /** Dipanggil saat KOPKU dibuka: nyalakan bila tersimpan ON. */
  async mulaiBilaAktif() {
    return this._serial(async () => {
      if (this.baca().aktif) await this._mulai();
      return this.status();
    });
  }

  async henti() {
    return this._serial(async () => {
      await this._henti();
      if (this.chatgpt) await this.chatgpt.henti();
    });
  }

  async _mulai() {
    if (this.berjalan) return;
    this.galat = null;
    fs.mkdirSync(this.dir, { recursive: true });
    const token = crypto.randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => this._layani(req, res));
    server.keepAliveTimeout = 5000;
    server.requestTimeout = 180000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (e) {
      this.galat = `Asisten AI gagal menyala: ${(e && e.message) || e}`;
      throw galat(this.galat, 'GAGAL');
    }
    this.server = server;
    this.port = server.address().port;
    this.token = token;
    tulisAtomik(this.berkasEndpoint, JSON.stringify({ port: this.port, token, pid: process.pid, versi: this.o.versi || null, dibuat: new Date(this._now()).toISOString() }), 0o600);
  }

  async _henti() {
    const s = this.server;
    this.server = null;
    this.token = null;
    this.port = null;
    try {
      fs.rmSync(this.berkasEndpoint, { force: true });
    } catch {
      /* abaikan */
    }
    if (s) {
      await new Promise((r) => {
        s.close(() => r());
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      });
    }
  }

  _catat({ alat, ok, ms, ket }) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.berkasLog).size > BATAS_LOG) fs.renameSync(this.berkasLog, this.berkasLog + '.1');
      } catch {
        /* belum ada */
      }
      const baris = [new Date(this._now()).toISOString(), alat, ok ? 'BERHASIL' : 'GAGAL', ms != null ? `${ms}ms` : '', ket ? String(ket).replace(/[\r\n]+/g, ' ').slice(0, 200) : ''].join('\t');
      fs.appendFileSync(this.berkasLog, baris + '\n');
    } catch {
      /* log tidak boleh menggagalkan alat */
    }
  }

  /** 20 baris terakhir log pemakaian (untuk layar). */
  riwayat(n = 20) {
    try {
      const baris = fs.readFileSync(this.berkasLog, 'utf8').trim().split('\n').filter(Boolean);
      return baris
        .slice(-n)
        .reverse()
        .map((b) => {
          const [waktu, alat, status, ms, ket] = b.split('\t');
          return { waktu, alat, status, ms, ket };
        });
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ HTTP
  _tolak(res, status, pesan) {
    const badan = JSON.stringify({ pesan });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(badan) });
    res.end(badan);
  }

  _kirim(res, obj) {
    const badan = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(badan) });
    res.end(badan);
  }

  _otentik(req) {
    if (req.headers.origin !== undefined) return false; // permintaan dari halaman web
    const host = String(req.headers.host || '');
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${this.port}$`).test(host)) return false;
    const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization || ''));
    if (!m || !this.token) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _layani(req, res) {
    if (!this._otentik(req)) return this._tolak(res, 401, 'Tidak diizinkan.');
    const url = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/alat') {
      return this._konteks()
        .then(async (k) => this._kirim(res, { tools: await this._daftarDariKonteks(k) }))
        // Konteks gagal (mis. lisensi kedaluwarsa): tetap kirim katalog agar Claude memanggil alat dan menerima penjelasannya.
        .catch((e) => this._kirim(res, { tools: untukMcp(ALAT.filter((a) => this.baca().perAnggota || !a.perAnggota)), pesan: e.message }));
    }
    if (req.method === 'POST' && url === '/panggil') {
      const bagian = [];
      let ukuran = 0;
      req.on('data', (c) => {
        ukuran += c.length;
        if (ukuran > BATAS_BADAN) req.destroy();
        else bagian.push(c);
      });
      req.on('end', () => {
        let isi;
        try {
          isi = JSON.parse(Buffer.concat(bagian).toString('utf8'));
        } catch {
          return this._tolak(res, 400, 'Permintaan tidak sah.');
        }
        this.panggil(isi && isi.name, isi && isi.arguments).then(
          (h) => this._kirim(res, h),
          () => this._kirim(res, { content: [{ type: 'text', text: 'Terjadi kesalahan di KOPKU Desktop.' }], isError: true })
        );
      });
      return undefined;
    }
    return this._tolak(res, 404, 'Tidak ditemukan.');
  }

  /** Izin ubah data per sumber: ChatGPT butuh izin tambahan tersendiri (1.0.29). */
  _bolehTulisDari(k, sumber) {
    if (!k.bolehTulis) return false;
    if (sumber === 'chatgpt') return !!(this.chatgpt && this.chatgpt.bolehTulis());
    return true;
  }

  /** Daftar alat untuk sumber tertentu ('claude' | 'chatgpt'). */
  async daftarAlat(sumber) {
    try {
      const k = await this._konteks();
      return this._daftarDariKonteks(Object.assign({}, k, { bolehTulis: this._bolehTulisDari(k, sumber) }));
    } catch {
      return untukMcp(ALAT.filter((a) => this.baca().perAnggota || !a.perAnggota));
    }
  }

  /** Alat yang boleh dipakai pada pengaturan & izin saat ini. */
  async _daftarDariKonteks(k) {
    const baca = await alatTersedia({ perAnggota: k.perAnggota, boleh: k.boleh });
    const tulis = [];
    if (k.bolehTulis) for (const a of ALAT_TULIS) if (await k.bolehAksi(a.resource, a.aksi)) tulis.push(a);
    return untukMcp(baca.concat(tulis));
  }

  /** Konteks pemanggilan: memeriksa ulang status, lisensi, dan pengguna SETIAP kali. */
  async _konteks() {
    const p = this.baca();
    if (!p.aktif || !p.pengguna) throw galat('Asisten AI dimatikan di KOPKU Desktop (Pengaturan › Asisten AI).', 'MATI');
    await this.o.pastikanAdapter();
    const B = this.o.bridge;
    const st = await B.panggil('sistem.status', {}, {});
    if (!st.setupSelesai) throw galat('Koperasi di KOPKU Desktop belum disiapkan.', 'BELUM_SIAP');
    if (!st.lisensiValid) throw galat('Lisensi KOPKU Desktop tidak valid atau kedaluwarsa. Buka KOPKU Desktop untuk memperbarui lisensi.', 'LISENSI');
    const u = await B.panggil('auth.user', { userId: p.pengguna.id }, {});
    if (!u || !u.aktif) throw galat(`Pengguna KOPKU "${p.pengguna.username}" yang memberi akses sudah nonaktif. Nyalakan ulang Asisten AI dengan pengguna lain.`, 'IZIN');
    if (u.role === 'ANGGOTA') throw galat('Akun Anggota tidak dapat memakai Asisten AI.', 'IZIN');
    const cache = new Map();
    const boleh = async (resource) => {
      if (!cache.has(resource)) cache.set(resource, !!(await B.panggil('izin.cek', { userId: u.id, resource, action: 'view' }, {})));
      return cache.get(resource);
    };
    const ctx = { userId: u.id };
    const cacheAksi = new Map();
    const bolehAksi = async (resource, action) => {
      const kk = resource + ':' + action;
      if (!cacheAksi.has(kk)) cacheAksi.set(kk, !!(await B.panggil('izin.cek', { userId: u.id, resource, action }, {})));
      return cacheAksi.get(kk);
    };
    const tulis = async (op, args) => {
      if (!this.o.tulis) throw galat('Perubahan data tidak tersedia pada versi ini.', 'TIDAK_TERSEDIA');
      const r = await this.o.tulis.jalankan(op, args || {}, ctx);
      if (r && r.ok) return r.value;
      const e = (r && r.error) || { kode: 'INTERNAL', pesan: 'Terjadi kesalahan.' };
      throw galat(e.pesan, e.kode);
    };
    return {
      perAnggota: p.perAnggota,
      bolehTulis: p.bolehTulis && p.perAnggota,
      bolehAksi,
      tulis,
      salinKeCache: (jalur) => {
        if (!this.o.salinKeCache) throw galat('Import berkas tidak tersedia pada versi ini.', 'TIDAK_TERSEDIA');
        return this.o.salinKeCache(jalur);
      },
      catatBackup: () => (this.backupTerakhir = this._now()),
      /** Backup terenkripsi sebelum perubahan (paling jarang tiap 30 menit). Gagal → perubahan dibatalkan. */
      backupOtomatis: async () => {
        if (this._now() - this.backupTerakhir < JEDA_BACKUP_MS) return;
        try {
          await tulis('backup.buat', {});
        } catch (e) {
          throw galat(`Backup otomatis sebelum perubahan gagal (${e.message}). Perubahan DIBATALKAN demi keamanan data.`, 'BACKUP_GAGAL');
        }
        this.backupTerakhir = this._now();
        this._catat({ alat: '(backup otomatis)', ok: true, ket: 'sebelum perubahan data oleh AI' });
      },
      boleh,
      hariIni: hariIniLokal(this._now()),
      panggil: (op, args) => B.panggil(op, args || {}, ctx),
      info: { koperasi: st.koperasi ? st.koperasi.nama : null, tahunBuku: st.koperasi ? st.koperasi.tahunBuku : null, pengguna: u.nama || u.username, versi: this.o.versi || null },
    };
  }

  /** Batas laju perubahan: null bila boleh, atau pesan penolakan. */
  _cekBatasUbah() {
    const kini = this._now();
    const batas = this.o.batasUbah || BATAS_UBAH;
    this.waktuUbah = this.waktuUbah.filter((t) => kini - t < Math.max(0, ...batas.map((b) => b.ms)));
    for (const b of batas) {
      if (this.waktuUbah.filter((t) => kini - t < b.ms).length >= b.maks) return `Batas keamanan tercapai (${b.label}). Tunggu sebentar, atau lakukan input massal lewat Import Data Awal (Excel).`;
    }
    return null;
  }

  /** Jalankan satu alat (dipakai HTTP & uji). `opsi.sumber`: 'claude' (bawaan) | 'chatgpt'. */
  async panggil(nama, args, opsi = {}) {
    const mulai = this._now();
    const sumber = opsi.sumber === 'chatgpt' ? 'chatgpt' : 'claude';
    const namaAi = sumber === 'chatgpt' ? 'ChatGPT' : 'Claude';
    let hasil;
    try {
      const k0 = await this._konteks();
      const k = Object.assign({}, k0, { bolehTulis: this._bolehTulisDari(k0, sumber) });
      const n = String(nama || '');
      if (NAMA_TULIS.has(n)) {
        const adaKonfirmasi = args && typeof args === 'object' && typeof args.konfirmasi === 'string' && args.konfirmasi.trim();
        const batas = adaKonfirmasi ? this._cekBatasUbah() : null;
        if (!k.bolehTulis) {
          const sakelar = sumber === 'chatgpt' && k0.bolehTulis ? 'ChatGPT › "Izinkan ChatGPT mengubah data"' : '"Izinkan Claude mengubah data"';
          hasil = { content: [{ type: 'text', text: `Perubahan data oleh ${namaAi} TIDAK diizinkan di KOPKU Desktop (Pengaturan › Asisten AI › ${sakelar}). Minta admin KOPKU menyalakannya, atau lakukan perubahan di aplikasi.` }], isError: true };
        } else if (batas) hasil = { content: [{ type: 'text', text: batas }], isError: true };
        else hasil = await jalankanAlatTulis(n, args, k, this.kodeKonfirmasi, this._now());
      } else hasil = await jalankanAlat(n, args, k);
    } catch (e) {
      hasil = { content: [{ type: 'text', text: e && e.kode ? samarkanTeks(String(e.message)) : 'KOPKU Desktop belum siap. Pastikan aplikasi terbuka dan sudah masuk, lalu coba lagi.' }], isError: true };
    }
    this.statistik.total++;
    if (hasil.isError) this.statistik.gagal++;
    this.statistik.terakhir = new Date(this._now()).toISOString();
    let ket = hasil.isError ? String(hasil.content[0].text).slice(0, 160) : '';
    if (!hasil.isError && hasil._ringkasLog) {
      this.statistik.perubahan++;
      this.waktuUbah.push(this._now());
      ket = 'UBAH: ' + hasil._ringkasLog;
    } else if (!hasil.isError && NAMA_TULIS.has(String(nama)) && /MENUNGGU_KONFIRMASI|PRATINJAU_BERUBAH/.test(hasil.content[0].text)) ket = 'pratinjau (belum disimpan)';
    delete hasil._ringkasLog;
    if (sumber === 'chatgpt') ket = '[ChatGPT] ' + ket;
    this._catat({ alat: String(nama || '?').slice(0, 60), ok: !hasil.isError, ms: this._now() - mulai, ket });
    delete hasil._galat;
    return hasil;
  }
}

module.exports = { McpHost };
