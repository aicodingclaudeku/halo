'use strict';
/**
 * Autentikasi, sesi, RBAC sisi server, validasi input & audit —
 * terhadap KOPKU ASLI (bundle renderer) + server LAN ASLI di 127.0.0.1.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { siapkan, Klien, beriAkses, PASSWORD } = require('./kit');

let K;
before(async () => {
  K = await siapkan();
});
after(async () => {
  await K.srv.henti();
});

test('health: online tanpa data sensitif, tanpa login', async () => {
  const r = await new Klien(K.base).req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.server, 'ONLINE');
  assert.equal(r.body.data.database, 'READY');
  const t = JSON.stringify(r.body);
  assert.ok(!/koperasi uji|admin|schema|password|token/i.test(t), t);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
});

test('endpoint terproteksi tanpa sesi → 401; tanpa izin role → 403', async () => {
  for (const p of ['/api/anggota', '/api/pinjaman', '/api/dashboard', '/api/whatsapp/pengaturan', '/api/admin/audit', '/api/laporan/lhu?mulai=2026-01-01&selesai=2026-12-31']) {
    const r = await new Klien(K.base).req('GET', p);
    assert.equal(r.status, 401, p);
    assert.equal(r.body.kode, 'SESI');
  }
});

test('login admin: cookie HttpOnly SameSite=Strict, token tidak ada di body, hash token di DB', async () => {
  const c = new Klien(K.base);
  const r = await c.login('admin', PASSWORD.admin);
  assert.equal(r.status, 200);
  const sc = r.setCookie.join(';');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const token = c.cookie.split('=')[1];
  assert.ok(!JSON.stringify(r.body).includes(token));
  const db = K.srv.db;
  assert.equal(db.get('SELECT COUNT(*) n FROM sesi WHERE id = ?', token).n, 0, 'token mentah tidak boleh tersimpan');
  assert.equal(r.body.data.user.role, 'ADMIN');
  const s = await c.req('GET', '/api/auth/sesi');
  assert.equal(s.status, 200);
  assert.equal(s.body.data.menu.adminLan, true);
});

test('login gagal: pesan generik + audit LOGIN_GAGAL, password tidak tercatat', async () => {
  const c = new Klien(K.base);
  const r1 = await c.login('admin', 'salah-sekali');
  const r2 = await c.login('tidak-ada', 'apapun');
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  assert.equal(r1.body.pesan, r2.body.pesan, 'username tak dikenal & password salah harus sama (anti enumerasi)');
  const a = K.srv.db.all("SELECT * FROM audit_lan WHERE action = 'LOGIN_GAGAL'");
  assert.ok(a.length >= 2);
  assert.ok(!JSON.stringify(a).includes('salah-sekali'));
  // reset penghitung admin agar tidak mengganggu uji lain
  await c.login('admin', PASSWORD.admin);
});

test('brute force: 5x gagal → akun terkunci (429) walau password benar, tercatat di DB', async () => {
  const c = new Klien(K.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('operator', 'salah' + i)).status, 401);
  const r = await c.login('operator', PASSWORD.operator);
  assert.equal(r.status, 429);
  assert.equal(r.body.kode, 'TERKUNCI');
  const row = K.srv.db.get("SELECT * FROM login_gagal WHERE kunci = 'u:operator'");
  assert.ok(row.kunci_sampai);
  K.jam.maju(16 * 60 * 1000);
  // setelah 15 menit, user (yang belum diberi akses LAN) lolos verifikasi password lalu ditolak AKSES_LAN
  const r2 = await c.login('operator', PASSWORD.operator);
  assert.equal(r2.status, 403);
  assert.equal(r2.body.kode, 'AKSES_LAN');
});

test('akses LAN: non-admin ditolak sampai diberi Admin; Anggota tidak pernah boleh', async () => {
  for (const u of ['pengurus', 'bendahara']) {
    const r = await new Klien(K.base).login(u, PASSWORD[u]);
    assert.equal(r.status, 403, u);
  }
  const ang = await new Klien(K.base).login('anggota1', PASSWORD.anggota);
  assert.equal(ang.status, 403);
  assert.match(ang.body.pesan, /Anggota/);
  const a = new Klien(K.base);
  await a.login('admin', PASSWORD.admin);
  const tolak = await a.req('PUT', `/api/admin/lan-akses/${K.s.users.anggotaUser}`, { aktif: true, profil: 'IKUT_ROLE' });
  assert.equal(tolak.status, 422);
  for (const u of ['pengurus', 'bendahara', 'operator']) await beriAkses(K.base, K.s.users[u]);
  await beriAkses(K.base, K.s.users.pengawas, 'PENGAWAS');
  for (const u of ['pengurus', 'bendahara', 'operator', 'pengawas']) {
    const r = await new Klien(K.base).login(u, PASSWORD[u]);
    assert.equal(r.status, 200, u + ' ' + JSON.stringify(r.body));
  }
});

test('RBAC server-side mengikuti matriks KOPKU existing (+ Pengawas baca saja)', async () => {
  const c = {};
  for (const u of ['admin', 'pengurus', 'bendahara', 'operator', 'pengawas']) {
    c[u] = new Klien(K.base);
    assert.equal((await c[u].login(u, PASSWORD[u])).status, 200);
  }
  const anggotaBaru = { namaLengkap: 'Calon RBAC', tanggalBergabung: '2026-09-01' };
  const harap = [
    // [user, method, path, body, status yang diharapkan]
    ['admin', 'POST', '/api/anggota', anggotaBaru, 200],
    ['pengurus', 'POST', '/api/anggota', anggotaBaru, 200],
    ['operator', 'POST', '/api/anggota', anggotaBaru, 200], // PETUGAS anggota.create = true
    ['bendahara', 'POST', '/api/anggota', anggotaBaru, 403], // BENDAHARA anggota hanya view
    ['pengawas', 'POST', '/api/anggota', anggotaBaru, 403], // profil Pengawas
    ['pengawas', 'GET', '/api/anggota', null, 200],
    ['pengawas', 'GET', '/api/laporan/posisi-keuangan?tanggal=2026-09-30', null, 200],
    ['operator', 'GET', '/api/laporan/posisi-keuangan?tanggal=2026-09-30', null, 200], // PETUGAS laporan.view = true
    ['admin', 'GET', '/api/whatsapp/pengaturan', null, 200],
    ['pengurus', 'GET', '/api/whatsapp/pengaturan', null, 200], // pengaturan.view
    ['pengurus', 'PUT', '/api/whatsapp/pengaturan', { aktif: true }, 403], // pengaturan.edit hanya Admin
    ['bendahara', 'GET', '/api/whatsapp/pengaturan', null, 403],
    ['operator', 'GET', '/api/admin/lan-akses', null, 403],
    ['pengurus', 'PUT', `/api/admin/lan-akses/${'x'.repeat(8)}`, { aktif: true, profil: 'IKUT_ROLE' }, 403],
    ['pengawas', 'GET', '/api/admin/audit', null, 200],
    ['operator', 'GET', '/api/admin/audit', null, 403],
  ];
  for (const [u, m, p, b, st] of harap) {
    const r = await c[u].req(m, p, b);
    assert.equal(r.status, st, `${u} ${m} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    if (st === 403) assert.equal(r.body.kode, 'IZIN', `${u} ${m} ${p} harus ditolak karena izin, bukan ${r.body.kode}`);
  }
  // Ubah anggota: PETUGAS tidak punya anggota.edit
  const d = await c.admin.req('GET', `/api/anggota/${K.s.anggota[0]}`);
  const ubah = { versi: d.body.data.versi, data: { namaLengkap: 'Anggota Uji 1', nomorHp: '081234567890' } };
  assert.equal((await c.operator.req('PUT', `/api/anggota/${K.s.anggota[0]}`, ubah)).status, 403);
  // Bayar angsuran: pengawas ditolak; PETUGAS pinjaman.create = true (sama dengan desktop)
  const pj = await c.admin.req('GET', `/api/pinjaman/${K.s.pinjaman[3]}`);
  const j = pj.body.data.jadwal[0];
  const bayar = { tanggal: '2026-08-15', nominal: 1000, sumberDana: 'KAS', versiJadwal: j.versi };
  assert.equal((await c.pengawas.req('POST', `/api/pinjaman/${K.s.pinjaman[3]}/angsuran/${j.id}/bayar`, bayar)).status, 403);
  const ok = await c.operator.req('POST', `/api/pinjaman/${K.s.pinjaman[3]}/angsuran/${j.id}/bayar`, bayar);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // createdBy authoritative = user sesi (tidak bisa dipalsukan klien)
  const d2 = await K.R_db();
  const row = await d2.getFirstAsync('SELECT created_by FROM angsuran_pembayaran WHERE id = ?', ok.body.data.id);
  assert.equal(row.created_by, K.s.users.operator);
  const aud = K.srv.db.all("SELECT * FROM audit_lan WHERE action = 'AKSES_DITOLAK'");
  assert.ok(aud.length >= 5);
});

test('CSRF & Idempotency-Key wajib untuk request ubah data', async () => {
  const c = new Klien(K.base);
  await c.login('admin', PASSWORD.admin);
  const tanpaCsrf = await c.req('POST', '/api/anggota', { namaLengkap: 'X', tanggalBergabung: '2026-09-01' }, { 'X-KOPKU-CSRF': undefined });
  assert.equal(tanpaCsrf.status, 403);
  assert.equal(tanpaCsrf.body.kode, 'CSRF');
  const csrfSalah = await c.req('POST', '/api/anggota', { namaLengkap: 'X', tanggalBergabung: '2026-09-01' }, { 'X-KOPKU-CSRF': 'a'.repeat(32) });
  assert.equal(csrfSalah.status, 403);
  const tanpaKunci = await c.req('POST', '/api/anggota', { namaLengkap: 'X', tanggalBergabung: '2026-09-01' }, { 'Idempotency-Key': undefined });
  assert.equal(tanpaKunci.status, 400);
});

test('validasi input server: tanggal, nominal, enum, tipe konten, ukuran badan', async () => {
  const c = new Klien(K.base);
  await c.login('admin', PASSWORD.admin);
  const pj = await c.req('GET', `/api/pinjaman/${K.s.pinjaman[2]}`);
  const j = pj.body.data.jadwal[0];
  const u = `/api/pinjaman/${K.s.pinjaman[2]}/angsuran/${j.id}/bayar`;
  for (const [b, harap] of [
    [{ tanggal: '2026-02-30', nominal: 1000, sumberDana: 'KAS', versiJadwal: j.versi }, /tanggal yang sah/],
    [{ tanggal: '15/08/2026', nominal: 1000, sumberDana: 'KAS', versiJadwal: j.versi }, /YYYY-MM-DD/],
    [{ tanggal: '2026-08-15', nominal: -5, sumberDana: 'KAS', versiJadwal: j.versi }, /lebih besar dari 0/],
    [{ tanggal: '2026-08-15', nominal: 10.5, sumberDana: 'KAS', versiJadwal: j.versi }, /bulat/],
    [{ tanggal: '2026-08-15', nominal: '1000', sumberDana: 'KAS', versiJadwal: j.versi }, /bulat/],
    [{ tanggal: '2026-08-15', nominal: 1000, sumberDana: 'DOMPET', versiJadwal: j.versi }, /Sumber dana/],
  ]) {
    const r = await c.req('POST', u, b);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.pesan, harap);
  }
  // aturan bisnis tetap milik service existing: bayar melebihi tunggakan ditolak service
  const lebih = await c.req('POST', u, { tanggal: '2026-08-15', nominal: 999999999, sumberDana: 'KAS', versiJadwal: j.versi });
  assert.equal(lebih.status, 422);
  const id404 = await c.req('GET', '/api/pinjaman/tidak-ada-123');
  assert.equal(id404.status, 404);
  const sqlInj = await c.req('GET', "/api/anggota?cari=' OR 1=1 --");
  assert.equal(sqlInj.status, 200);
  assert.equal(sqlInj.body.data.baris.length, 0);
  const res = await fetch(K.base + '/api/anggota', { method: 'POST', headers: { Cookie: c.cookie, 'X-KOPKU-CSRF': c.csrf, 'Idempotency-Key': 'kkkkkkkkkk1', 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(res.status, 415);
  const besar = await fetch(K.base + '/api/anggota', { method: 'POST', headers: { Cookie: c.cookie, 'X-KOPKU-CSRF': c.csrf, 'Idempotency-Key': 'kkkkkkkkkk2', 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70000) }) }).catch(() => ({ status: 413 }));
  assert.equal(besar.status, 413);
});

test('tidak ada endpoint SQL/berkas/database; galat tanpa stack trace', async () => {
  const c = new Klien(K.base);
  await c.login('admin', PASSWORD.admin);
  for (const p of ['/api/sql', '/koperasi.db', '/../documents/SQLite/koperasi.db', '/api/../../kopku-server.db', '/electron/main.js', '/api/admin/exec']) {
    const r = await c.req('GET', p);
    assert.ok([404, 400].includes(r.status), p + ' ' + r.status);
  }
  const r = await c.req('DELETE', '/api/anggota');
  assert.equal(r.status, 405);
  const all = JSON.stringify(K.srv.db.all('SELECT * FROM audit_lan'));
  assert.ok(!/at .*\.js:\d+/.test(all));
});

test('Host header asing ditolak (proteksi DNS rebinding)', async () => {
  const http = require('node:http');
  const st = await new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: K.port, path: '/api/health', headers: { Host: 'evil.example.com' } }, (r) => res(r.statusCode));
    rq.end();
  });
  assert.equal(st, 421);
});

test('sesi: idle timeout, logout, user dinonaktifkan di desktop → sesi dicabut', async () => {
  const c = new Klien(K.base);
  await c.login('bendahara', PASSWORD.bendahara);
  assert.equal((await c.req('GET', '/api/pinjaman')).status, 200);
  K.jam.maju(31 * 60 * 1000); // idle > 30 menit
  assert.equal((await c.req('GET', '/api/pinjaman')).status, 401);
  await c.login('bendahara', PASSWORD.bendahara);
  const out = await c.req('POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  const sesudah = await c.req('GET', '/api/pinjaman');
  assert.equal(sesudah.status, 401);
  // nonaktifkan user lewat service KOPKU existing (seperti Admin di desktop)
  const d = new Klien(K.base);
  assert.equal((await d.login('pengurus', PASSWORD.pengurus)).status, 200);
  await K.k.R('userAdmin').updateUserStatus(K.s.users.admin, K.s.users.pengurus, false);
  const r = await d.req('GET', '/api/anggota');
  assert.equal(r.status, 401);
  await K.k.R('userAdmin').updateUserStatus(K.s.users.admin, K.s.users.pengurus, true);
});

test('cabut akses LAN berlaku segera untuk sesi yang sedang aktif', async () => {
  const c = new Klien(K.base);
  assert.equal((await c.login('operator', PASSWORD.operator)).status, 200);
  await beriAkses(K.base, K.s.users.operator, 'IKUT_ROLE', false);
  assert.equal((await c.req('GET', '/api/anggota')).status, 401);
  await beriAkses(K.base, K.s.users.operator, 'IKUT_ROLE', true);
});

test('lisensi tidak valid → semua endpoint bisnis & login fail-closed (503)', async () => {
  const c = new Klien(K.base);
  await c.login('admin', PASSWORD.admin);
  K.k.statusLisensi.lisensiValid = false;
  K.srv.api._statusCache = null;
  try {
    assert.equal((await c.req('GET', '/api/anggota')).status, 503);
    assert.equal((await new Klien(K.base).login('admin', PASSWORD.admin)).status, 503);
    const h = await new Klien(K.base).req('GET', '/api/health');
    assert.equal(h.body.data.database, 'LICENSE_REQUIRED');
  } finally {
    K.k.statusLisensi.lisensiValid = true;
    K.srv.api._statusCache = null;
  }
});

test('audit LAN: login, logout, mutasi tercatat tanpa password/token/cookie', async () => {
  const rows = K.srv.db.all('SELECT * FROM audit_lan');
  const aksi = new Set(rows.map((r) => r.action));
  for (const a of ['LOGIN', 'LOGIN_GAGAL', 'LOGOUT', 'ANGGOTA_BUAT', 'ANGSURAN_BAYAR', 'LAN_AKSES_UBAH', 'AKSES_DITOLAK', 'LOGIN_DIKUNCI']) assert.ok(aksi.has(a), a);
  const t = JSON.stringify(rows);
  for (const p of Object.values(PASSWORD)) assert.ok(!t.includes(p), 'password bocor ke audit');
  assert.ok(!/kopku_sid|csrf/i.test(t));
  // audit bisnis existing (koperasi.db) mencatat user LAN yang sama
  const d = await K.R_db();
  const n = await d.getFirstAsync("SELECT COUNT(*) n FROM audit_log WHERE entity = 'anggota' AND action = 'CREATE' AND user_id = ?", K.s.users.operator);
  assert.ok(n.n >= 1);
});
