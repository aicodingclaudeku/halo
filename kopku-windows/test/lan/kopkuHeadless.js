'use strict';
/**
 * HARNESS UJI: menjalankan BUNDLE RENDERER KOPKU ASLI di Node (tanpa
 * Electron, tanpa DOM) dengan jembatan `kopkuDesktop` yang memakai host
 * desktop ASLI (electron/hosts/sqliteHost.js — node:sqlite, fsHost.js).
 *
 * Yang dieksekusi adalah service KOPKU sungguhan (migrasi v80, anggota,
 * pinjaman, angsuran, jurnal, laporan, izin, hash password). Satu-satunya
 * pengganti: secure store (Map di memori; safeStorage Electron tidak ada
 * di Node) dan — HANYA bila diminta — status lisensi (lisensi asli butuh
 * aktivasi ke server lisensi; sistem lisensi sendiri tidak diubah).
 *
 * Satu proses = satu database (getDb() bundle adalah singleton).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

function muatKopku({ dataDir, lisensiValid = true } = {}) {
  const { SqliteHost } = require(path.join(ROOT, 'electron/hosts/sqliteHost'));
  const { FsHost } = require(path.join(ROOT, 'electron/hosts/fsHost'));
  const uri = require(path.join(ROOT, 'electron/uri'));
  const { bangunIndeks, cariBerkasBundle } = require(path.join(ROOT, 'electron/server/bundleIndex'));
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-uji-'));
  const d = { data: dataDir, documents: path.join(dataDir, 'documents'), cache: path.join(dataDir, 'cache') };
  fs.mkdirSync(path.join(d.documents, 'SQLite'), { recursive: true });
  fs.mkdirSync(d.cache, { recursive: true });
  const sq = new SqliteHost(path.join(d.documents, 'SQLite'));
  const fh = new FsHost(d);
  const sec = new Map();
  // Tiru IPC: setiap panggilan async (satu "tick" antara pemanggilan), sehingga
  // penyisipan antar-async di renderer terjadi seperti di Electron.
  const A = (f) => (...a) => new Promise((res, rej) => setImmediate(() => { try { res(f(...a)); } catch (e) { rej(e); } }));
  const statistik = { sql: 0 };
  globalThis.kopkuDesktop = {
    info: { platform: 'linux', platformLabel: 'Linux', hostname: 'uji', version: 'uji', documentUri: uri.dirToUri(d.documents), cacheUri: uri.dirToUri(d.cache), dataDir },
    sqlite: {
      open: A((n, dir) => sq.open(n, dir ? uri.toPath(dir) : undefined)),
      exec: A((i, s) => (statistik.sql++, sq.exec(i, s))),
      run: A((i, s, p) => (statistik.sql++, sq.run(i, s, p))),
      get: A((i, s, p) => (statistik.sql++, sq.get(i, s, p))),
      all: A((i, s, p) => (statistik.sql++, sq.all(i, s, p))),
      close: A((i) => sq.close(i)),
    },
    fs: {
      uriToPath: uri.toPath,
      pathToUri: uri.pathToUri,
      info: A((u) => fh.async('info', u)),
      readString: A((u, e) => fh.async('readString', u, e)),
      writeString: A((u, x, e, ap) => fh.async('writeString', u, x, e, ap)),
      remove: A((u) => fh.async('remove', u)),
      move: A((a, b) => fh.async('move', a, b)),
      copy: A((a, b) => fh.async('copy', a, b)),
      mkdir: A((u) => fh.async('mkdir', u)),
      readDir: A((u) => fh.async('readDir', u)),
      statSync: (u) => fh.sync('stat', u),
      createSync: (u, o) => fh.sync('create', u, o),
      removeSync: (u) => fh.sync('remove', u),
      openSync: (u) => fh.sync('open', u),
      readSync: (h, o, l) => fh.sync('read', h, o, l),
      writeSync: (h, o, x) => fh.sync('write', h, o, x),
      closeSync: (h) => fh.sync('close', h),
    },
    secure: { get: A((k) => (sec.has(k) ? sec.get(k) : null)), set: A((k, v) => void sec.set(k, String(v))), remove: A((k) => void sec.delete(k)) },
  };
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.__ExpoImportMetaRegistry = globalThis.__ExpoImportMetaRegistry || { env: { MODE: 'production' } }; // biasanya diisi runtime Expo saat entry
  const berkas = cariBerkasBundle(path.join(ROOT, 'renderer'));
  let src = fs.readFileSync(berkas, 'utf8');
  src = src.replace(/(\n__r\(\d+\);)+\s*$/, '\n'); // jangan jalankan entry (UI React)
  (0, eval)(src);
  const idx = bangunIndeks(path.join(ROOT, 'renderer'));
  if (idx.hilang.length) throw new Error('indeks modul tidak lengkap: ' + JSON.stringify(idx.hilang));
  // Modul tambahan HANYA untuk uji (tidak dipakai server): backup/restore existing.
  const { indeksEkspor, resolusi } = require(path.join(ROOT, 'electron/server/bundleIndex'));
  const ekstra = resolusi(indeksEkspor(fs.readFileSync(berkas, 'utf8')), { backup: ['createBackup', 'restoreBackup', 'listBackups'] });
  const ids = Object.assign({}, idx.modul, ekstra.modul);
  const status = { lisensiValid };
  const rAsli = globalThis.__r;
  const stubLisensi = { hasValidLocalLicense: async () => status.lisensiValid, getLicenseStatus: async () => ({ allowAppAccess: status.lisensiValid }) };
  globalThis.__r = function (id) {
    if (id === ids.lisensi) return stubLisensi;
    return rAsli(id);
  };
  const R = (k) => globalThis.__r(ids[k]);
  return { ids, R, dataDir, sqliteHost: sq, statusLisensi: status, statistik, dbFile: path.join(d.documents, 'SQLite', 'koperasi.db') };
}

const PASSWORD = {
  admin: 'Admin#Kopku2026',
  pengurus: 'Pengurus#Kopku2026',
  bendahara: 'Bendahara#Kopku2026',
  operator: 'Operator#Kopku2026',
  pengawas: 'Pengawas#Kopku2026',
  anggota: 'Anggota#Kopku2026',
};

/**
 * Data koperasi uji lewat SERVICE ASLI: setup, user tiap role, anggota,
 * simpanan (likuiditas kas), dua pinjaman dicairkan.
 */
async function seed(k, { tahun = 2026, tanggalPinjaman = '2026-07-15' } = {}) {
  const { R } = k;
  await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji LAN', tahunBuku: tahun, adminUsername: 'admin', adminPassword: PASSWORD.admin, tanggalBerdiri: '2020-01-01' });
  const d = await R('db').getDb();
  const admin = await d.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'");
  const users = { admin: admin.id };
  const UA = R('userAdmin');
  for (const [u, role] of [['pengurus', 'PENGURUS'], ['bendahara', 'BENDAHARA'], ['operator', 'PETUGAS'], ['pengawas', 'PENGURUS']]) {
    users[u] = (await UA.createUser(admin.id, { nama: `User ${u}`, username: u, role, password: PASSWORD[u] })).id;
  }
  const ang = R('anggota');
  const anggota = [];
  const hp = ['081234567890', '+62 813-1111-2222', '12345', '085700001111'];
  for (let i = 0; i < 4; i++) {
    anggota.push((await ang.createAnggota(admin.id, { namaLengkap: `Anggota Uji ${i + 1}`, tanggalBergabung: '2025-01-10', nomorHp: hp[i], status: 'AKTIF' })).id);
  }
  users.anggotaUser = (await UA.createUser(admin.id, { nama: 'Anggota Login', username: 'anggota1', role: 'ANGGOTA', password: PASSWORD.anggota, anggotaId: anggota[0] })).id;
  const simp = R('simpanan');
  for (const a of anggota) {
    await simp.setorSimpanan({ anggotaId: a, jenis: 'POKOK', tanggal: '2026-01-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin.id });
    await simp.setorSimpanan({ anggotaId: a, jenis: 'WAJIB', tanggal: '2026-01-15', periode: '2026-01', nominal: 50000, sumberDana: 'KAS', createdBy: admin.id });
    await simp.setorSimpanan({ anggotaId: a, jenis: 'SUKARELA', tanggal: '2026-01-15', nominal: 20000000, sumberDana: 'KAS', createdBy: admin.id });
  }
  const pj = R('pinjaman');
  const pinjaman = [];
  for (let i = 0; i < 4; i++) {
    const p = await pj.ajukanPinjaman({
      anggotaId: anggota[i],
      jumlahPinjaman: 6000000,
      tanggal: tanggalPinjaman,
      tenor: 6,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1.5,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: true,
      dendaTipe: 'NOMINAL',
      dendaNilai: 5000,
      createdBy: admin.id,
    });
    await pj.cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin.id, tanggalPencairan: tanggalPinjaman, sumberDana: 'KAS' });
    pinjaman.push(p.id);
  }
  return { users, anggota, pinjaman };
}

module.exports = { muatKopku, seed, PASSWORD, ROOT };
