'use strict';
/** Uji unit modul server LAN (tanpa bundle KOPKU). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = (p) => require(path.join(__dirname, '..', '..', 'electron', 'server', p));
const { normalisasiNomor, samarkanNomor } = S('whatsapp/nomor');
const { validasiConfig, parseEnv, WhatsAppKredensial } = S('config');
const { ServerDb, SERVER_SCHEMA_VERSION } = S('serverDb');
const { SesiStore, PembatasLogin, parseCookie } = S('auth');
const { bersihkan, samarkanTeks, LoggerAman } = S('audit');
const { aksesLan, otorisasi } = S('rbac');
const { alamatPrivat, hostSah } = S('httpServer');
const { WhatsAppService, klasifikasiGalatApi } = S('whatsapp/WhatsAppService');
const { indeksEkspor, resolusi, bangunIndeks } = S('bundleIndex');
const V = S('validasi');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-unit-'));

test('normalisasi nomor Indonesia', () => {
  const ok = { '081234567890': '6281234567890', '+62 812-3456-7890': '6281234567890', '0062812345678': '62812345678', '81234567890': '6281234567890', '6285700001111': '6285700001111', '(0857) 0000.1111': '6285700001111' };
  for (const [i, o] of Object.entries(ok)) assert.equal(normalisasiNomor(i).nomor, o, i);
  for (const x of ['', null, '12345', '021-5551234', '+1 415 555 0100', '0812abc', '08123', '6281234567890123', '62112345678']) assert.equal(normalisasiNomor(x).valid, false, String(x));
  assert.equal(samarkanNomor('6281234567890'), '62812****7890');
});

test('validasi config server: nilai aneh dibuang ke bawaan aman', () => {
  const c = validasiConfig({ mode: 'ROOT', host: 'evil.com', port: 80, hanyaJaringanPrivat: 'tidak', sesiIdleMenit: 99999 });
  assert.equal(c.mode, 'DESKTOP');
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 47880);
  assert.equal(c.hanyaJaringanPrivat, true);
  assert.equal(c.sesiIdleMenit, 30);
  assert.equal(validasiConfig({ mode: 'LAN_SERVER', port: 50000, host: '192.168.1.10' }).host, '192.168.1.10');
});

test('kredensial WhatsApp: env > berkas > secure store; ringkasan tanpa nilai rahasia', async () => {
  const d = tmp();
  const f = path.join(d, 'kopku-server.env');
  fs.writeFileSync(f, '# komentar\nWHATSAPP_PHONE_NUMBER_ID=111\nWHATSAPP_ACCESS_TOKEN="dariBerkas_123456789012345"\nWHATSAPP_TEMPLATE_NAME=tpl\n');
  assert.deepEqual(parseEnv('A=1\n#B=2\nC = "x y"'), { A: '1', C: 'x y' });
  const map = new Map([['kopku.server.whatsapp.accessToken', 'dariSecure_1234567890123']]);
  const sec = { get: async (k) => map.get(k) || null, set: async (k, v) => map.set(k, v), remove: async (k) => map.delete(k) };
  let k = new WhatsAppKredensial({ env: {}, envFile: f, secure: sec });
  assert.equal((await k.ambil()).accessToken, 'dariBerkas_123456789012345');
  k = new WhatsAppKredensial({ env: { WHATSAPP_ACCESS_TOKEN: 'dariEnv_12345678901234567' }, envFile: f, secure: sec });
  assert.equal((await k.ambil()).sumber.WHATSAPP_ACCESS_TOKEN, 'ENV');
  k = new WhatsAppKredensial({ env: {}, envFile: null, secure: sec });
  const r = await k.ringkasan();
  assert.equal(r.sumberAccessToken, 'SECURE_STORE');
  assert.ok(!JSON.stringify(r).includes('dariSecure'));
  await assert.rejects(k.simpanTokenAman('pendek'), /tidak valid/);
});

test('serverDb: migrasi idempoten, versi tercatat, versi lebih baru ditolak', () => {
  const f = path.join(tmp(), 'kopku-server.db');
  const a = new ServerDb(f);
  a.run("INSERT INTO pengaturan (kunci, nilai, updated_at) VALUES ('x','1','t')");
  a.close();
  const b = new ServerDb(f); // buka ulang: tidak menghapus data
  assert.equal(b.versi(), SERVER_SCHEMA_VERSION);
  assert.equal(b.get("SELECT nilai FROM pengaturan WHERE kunci='x'").nilai, '1');
  b.run('UPDATE server_meta SET version = 99');
  b.close();
  assert.throws(() => new ServerDb(f), /lebih baru/);
});

test('whatsapp_notifications: UNIQUE (pinjaman, jenis, tanggal_jadwal) mencegah duplikat', () => {
  const db = new ServerDb(':memory:');
  const ins = (id) => db.run("INSERT OR IGNORE INTO whatsapp_notifications (id, pinjaman_id, jenis_notifikasi, tanggal_jadwal, status, created_at, updated_at) VALUES (?, 'P1', 'H', '2026-10-15', 'pending', 't', 't')", id);
  assert.equal(Number(ins('a').changes), 1);
  assert.equal(Number(ins('b').changes), 0);
  assert.throws(() => db.run("INSERT INTO whatsapp_notifications (id, jenis_notifikasi, tanggal_jadwal, status, created_at, updated_at) VALUES ('c','H','x','terkirim','t','t')"), /CHECK/);
});

test('sesi: kedaluwarsa idle & absolut, cabut; hanya hash token tersimpan', () => {
  const db = new ServerDb(':memory:');
  let t = Date.parse('2026-10-07T00:00:00Z');
  const s = new SesiStore(db, { idleMenit: 30, maksJam: 12 }, () => t);
  const a = s.buat('u1', '10.0.0.2', 'UA');
  assert.ok(s.validasi(a.token));
  assert.equal(db.all('SELECT id FROM sesi').some((r) => r.id === a.token), false);
  t += 29 * 60 * 1000;
  assert.ok(s.validasi(a.token));
  t += 31 * 60 * 1000;
  assert.equal(s.validasi(a.token), null, 'idle');
  const b = s.buat('u1');
  for (let i = 0; i < 26; i++) {
    t += 29 * 60 * 1000;
    s.validasi(b.token);
  }
  assert.equal(s.validasi(b.token), null, 'batas absolut 12 jam');
  const c = s.buat('u2');
  s.cabut(c.token);
  assert.equal(s.validasi(c.token), null);
  assert.equal(s.validasi('x'), null);
  assert.deepEqual(parseCookie('a=1; kopku_sid=abc%3D; b=2'), { a: '1', kopku_sid: 'abc=', b: '2' });
});

test('pembatas login: penundaan progresif & kunci 15 menit per username dan per IP', () => {
  const db = new ServerDb(':memory:');
  let t = 0;
  const p = new PembatasLogin(db, () => t);
  assert.equal(p.cek('budi', '10.0.0.5').jedaMs, 0);
  p.catatGagal('budi', '10.0.0.5');
  p.catatGagal('budi', '10.0.0.5');
  assert.equal(p.cek('budi', '10.0.0.5').jedaMs, 500);
  for (let i = 0; i < 3; i++) p.catatGagal('budi', '10.0.0.5');
  const c = p.cek('BUDI', '10.0.0.9');
  assert.equal(c.diizinkan, false, 'username tidak peka huruf besar');
  t += 16 * 60 * 1000;
  assert.equal(p.cek('budi', '10.0.0.9').diizinkan, true);
  for (let i = 0; i < 20; i++) p.catatGagal('user' + i, '10.0.0.66');
  assert.equal(p.cek('siapapun', '10.0.0.66').diizinkan, false, 'kunci per IP');
});

test('audit & logger: rahasia dibuang/disamarkan', () => {
  const o = bersihkan({ password: 'x', accessToken: 'y', nested: { pin: '1', Authorization: 'Bearer abc.def', ok: 'Bearer abcdefgh123' }, nominal: 5 });
  assert.deepEqual(o, { nested: { ok: '[DISAMARKAN]' }, nominal: 5 });
  assert.equal(samarkanTeks('token EAAB1234567890abcd di sini'), 'token [DISAMARKAN] di sini');
  const L = new LoggerAman(null, () => ['rahasia-khusus-123']);
  L.info('isi rahasia-khusus-123 bocor?');
  assert.ok(!L.memori.join().includes('rahasia-khusus-123'));
});

test('akses LAN: ANGGOTA & nonaktif ditolak; non-admin perlu izin eksplisit; admin bisa dicabut', () => {
  assert.equal(aksesLan({ role: 'ANGGOTA', aktif: true }, { aktif: 1 }).boleh, false);
  assert.equal(aksesLan({ role: 'BENDAHARA', aktif: false }, { aktif: 1 }).boleh, false);
  assert.equal(aksesLan({ role: 'BENDAHARA', aktif: true }, null).boleh, false);
  assert.equal(aksesLan({ role: 'BENDAHARA', aktif: true }, { aktif: 1 }).boleh, true);
  assert.equal(aksesLan({ role: 'ADMIN', aktif: true }, null).boleh, true);
  assert.equal(aksesLan({ role: 'ADMIN', aktif: true }, { aktif: 0 }).boleh, false);
  assert.equal(aksesLan(null, null).boleh, false);
});

test('otorisasi: fail-closed tanpa aturan; Pengawas hanya view; matriks existing menentukan', async () => {
  const semua = async () => true;
  const u = { id: 'u', role: 'ADMIN', aktif: true };
  assert.equal((await otorisasi({ user: u, profil: 'IKUT_ROLE' }, null, semua)).ok, false);
  assert.equal((await otorisasi({ user: u, profil: 'IKUT_ROLE' }, { resource: 'x', action: 'hapus' }, semua)).ok, false);
  assert.equal((await otorisasi({ user: u, profil: 'PENGAWAS' }, { resource: 'pinjaman', action: 'create' }, semua)).ok, false);
  assert.equal((await otorisasi({ user: u, profil: 'PENGAWAS' }, { resource: 'pengaturan', action: 'view' }, semua)).ok, false);
  assert.equal((await otorisasi({ user: u, profil: 'PENGAWAS' }, { resource: 'laporan', action: 'view' }, semua)).ok, true);
  assert.equal((await otorisasi({ user: u, profil: 'IKUT_ROLE' }, { resource: 'laporan', action: 'view' }, async () => false)).ok, false);
});

test('jaringan: hanya alamat privat; Host harus IP/localhost/nama komputer', () => {
  for (const a of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.1', '::ffff:192.168.0.7', 'fe80::1', 'fd12::1']) assert.equal(alamatPrivat(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '::ffff:1.1.1.1', '2001:db8::1', '']) assert.equal(alamatPrivat(a), false, a);
  assert.equal(hostSah('192.168.1.10:47880'), true);
  assert.equal(hostSah('localhost:47880'), true);
  assert.equal(hostSah(os.hostname() + ':47880'), true);
  assert.equal(hostSah('attacker.example:47880'), false);
  assert.equal(hostSah(undefined), false);
});

test('validasi input', () => {
  assert.throws(() => V.tanggal('2026-13-01', 'T'), /sah/);
  assert.equal(V.tanggal('2028-02-29', 'T'), '2028-02-29');
  assert.throws(() => V.rupiah(Number.MAX_SAFE_INTEGER + 2, 'N'), /bulat/);
  assert.throws(() => V.teks('a\u0001b', 'X'), /karakter/);
  assert.throws(() => V.id('../etc', 'ID'), /tidak valid/);
  const ubah = V.dataAnggota({ namaLengkap: 'A', pekerjaan: 'B' }, { buat: false });
  assert.deepEqual(Object.keys(ubah).sort(), ['namaLengkap', 'pekerjaan'], 'kolom yang tidak dikirim tidak ditimpa null');
  assert.equal(V.dataAnggota({ namaLengkap: 'A', tanggalBergabung: '2026-01-01', status: 'KELUAR' }, { buat: true }).status, 'AKTIF');
});

test('klasifikasi galat Cloud API', () => {
  assert.equal(klasifikasiGalatApi(401, { code: 190 }).kategori, 'KONFIGURASI');
  assert.equal(klasifikasiGalatApi(403, {}).kategori, 'KONFIGURASI');
  assert.equal(klasifikasiGalatApi(429, {}).kategori, 'SEMENTARA');
  assert.equal(klasifikasiGalatApi(400, { code: 131056 }).kategori, 'SEMENTARA');
  assert.equal(klasifikasiGalatApi(503, {}).kategori, 'SEMENTARA');
  assert.equal(klasifikasiGalatApi(400, { code: 132001 }).kode, 'TEMPLATE');
  assert.equal(klasifikasiGalatApi(400, { code: 131026 }).kode, 'NOMOR');
  assert.equal(klasifikasiGalatApi(400, { code: 100 }).kategori, 'PERMANEN');
});

test('WhatsAppService: kredensial belum lengkap / nomor tidak sah tidak memanggil jaringan', async () => {
  let dipanggil = 0;
  const f = async () => {
    dipanggil++;
    return { status: 200, json: async () => ({}) };
  };
  const kosong = new WhatsAppService({ kredensial: new WhatsAppKredensial({ env: {} }), fetch: f });
  assert.equal((await kosong.sendTemplateMessage({ to: '081234567890', parameters: [] })).kode, 'BELUM_DIKONFIGURASI');
  const ada = new WhatsAppService({ kredensial: new WhatsAppKredensial({ env: { WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 'EAAtoken1234567890123', WHATSAPP_TEMPLATE_NAME: 't' } }), fetch: f });
  assert.equal((await ada.sendTemplateMessage({ to: '12345', parameters: [] })).kode, 'NOMOR');
  assert.equal(dipanggil, 0);
  const st = await ada.getDeliveryStatus('wamid.x');
  assert.equal(st.didukung, false);
  const sukses = await new WhatsAppService({ kredensial: new WhatsAppKredensial({ env: { WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 'EAAtoken1234567890123', WHATSAPP_TEMPLATE_NAME: 't' } }), fetch: async () => ({ status: 200, json: async () => ({ messages: [{ id: 'wamid.OK' }] }) }) }).sendTemplateMessage({ to: '081234567890', parameters: ['a'] });
  assert.deepEqual(sukses, { ok: true, messageId: 'wamid.OK' });
});

test('indeks modul bundle: semua layanan yang dibutuhkan ditemukan tepat satu; nama ambigu ditolak', () => {
  const idx = bangunIndeks(path.join(__dirname, '..', '..', 'renderer'));
  assert.deepEqual(idx.hilang, []);
  for (const v of Object.values(idx.modul)) assert.equal(typeof v, 'number');
  const teks = '__d(function(g,r,i,a,m,e,d){e.foo=1,e.bar=2},10,[]);\n__d(function(g,r,i,a,m,x,d){x.foo=3},11,[]);';
  const p = indeksEkspor(teks);
  assert.deepEqual(p.get('foo'), [10, 11]);
  assert.deepEqual(resolusi(p, { k: ['foo', 'bar'] }).modul, { k: 10 });
  assert.equal(resolusi(p, { k: ['foo'] }).hilang.length, 1, 'ambigu → tidak dipilih (fail-closed)');
});
