'use strict';
/**
 * WhatsApp Reminder: H-3/H-1/H/H+1/H+7, idempotensi, lunas/dibayar,
 * nomor tidak sah, offline, 401/429/500/timeout/template, scheduler ganda,
 * restart, pemulihan 'sending', kedaluwarsa, kerahasiaan token.
 * Data pinjaman berasal dari KOPKU ASLI; Cloud API diganti fetch palsu.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { muatKopku, seed, ROOT } = require('./kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { ServerDb } = require(path.join(ROOT, 'electron/server/serverDb'));
const { WhatsAppKredensial } = require(path.join(ROOT, 'electron/server/config'));
const { WhatsAppService } = require(path.join(ROOT, 'electron/server/whatsapp/WhatsAppService'));
const { ReminderScheduler, PengaturanWa } = require(path.join(ROOT, 'electron/server/whatsapp/ReminderScheduler'));
const { LoggerAman } = require(path.join(ROOT, 'electron/server/audit'));

const TOKEN = 'EAAGtokenRAHASIAuji1234567890abcdefXYZ';
const ENV = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_TEMPLATE_NAME: 'kopku_pengingat_angsuran', WHATSAPP_API_VERSION: 'v21.0' };

let k;
let s;
let bridge;
let db;
let logFile;
let logger;
const jam = { t: new Date(2026, 9, 12, 7, 30).getTime() };
const setJam = (y, m, d, hh, mm) => (jam.t = new Date(y, m - 1, d, hh, mm).getTime());
const kirim = [];
let mode = 'ok';
async function fetchPalsu(url, init) {
  kirim.push({ url, init, mode });
  if (mode === 'network') throw new TypeError('fetch failed');
  if (mode === 'timeout') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const resp = (status, json) => ({ status, json: async () => json });
  if (mode === 'ok') return resp(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBg' + kirim.length }] });
  if (mode === 401) return resp(401, { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } });
  if (mode === 403) return resp(403, { error: { code: 200, message: 'Permission' } });
  if (mode === 429) return resp(429, { error: { code: 130429, message: 'Rate limit' } });
  if (mode === 500) return resp(500, { error: { code: 1, message: 'Unknown' } });
  if (mode === 'template') return resp(400, { error: { code: 132001, message: 'Template name does not exist' } });
  throw new Error('mode?');
}

function buatScheduler(pemilik) {
  const kred = new WhatsAppKredensial({ env: ENV });
  const service = new WhatsAppService({ kredensial: kred, fetch: fetchPalsu, timeoutMs: 60 });
  return new ReminderScheduler({ db, bridge, service, pengaturan: new PengaturanWa(db), logger, now: () => jam.t, pemilik });
}
const baris = (where = '1=1', ...p) => db.all(`SELECT * FROM whatsapp_notifications WHERE ${where} ORDER BY nomor_pinjaman, jenis_notifikasi`, ...p);

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k); // 4 pinjaman 15 Jul 2026, 6 bulan → jatuh tempo tgl 15 tiap bulan
  bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-wa-'));
  db = new ServerDb(path.join(dir, 'kopku-server.db'));
  logFile = path.join(dir, 'logs', 'kopku-server.log');
  logger = new LoggerAman(logFile, () => [TOKEN]);
  new PengaturanWa(db).simpan({ aktif: true, jamKirim: '08:00' }, 'uji');
});
after(() => db.close());

test('sebelum jam kirim (07:30) tidak ada reminder dibuat', async () => {
  const sc = buatScheduler('A');
  const r = await sc.tick();
  assert.equal(r.dibuat, null);
  assert.equal(baris().length, 0);
  assert.equal(kirim.length, 0);
});

test('H-3 (12 Okt 08:30, jatuh tempo 15 Okt): nomor sah terkirim, nomor tidak sah skipped tanpa dikirim', async () => {
  setJam(2026, 10, 12, 8, 30);
  const sc = buatScheduler('A');
  const r = await sc.tick();
  assert.deepEqual(r.dibuat, { pending: 3, skipped: 1, sudahAda: 0 });
  const rows = baris("jenis_notifikasi = 'H_MIN_3'");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((x) => x.status).sort(), ['sent', 'sent', 'sent', 'skipped']);
  const skip = rows.find((x) => x.status === 'skipped');
  assert.equal(skip.error_kode, 'NOMOR_TIDAK_SAH');
  assert.equal(kirim.length, 3);
  const nomor = kirim.map((c) => JSON.parse(c.init.body).to).sort();
  assert.deepEqual(nomor, ['6281234567890', '6281311112222', '6285700001111']);
  const b = JSON.parse(kirim[0].init.body);
  assert.equal(b.type, 'template');
  assert.equal(b.template.name, 'kopku_pengingat_angsuran');
  assert.equal(b.template.language.code, 'id');
  assert.equal(b.template.components[0].parameters.length, 6);
  assert.equal(b.template.components[0].parameters[3].text, '15 Oktober 2026');
  assert.match(b.template.components[0].parameters[5].text, /3 hari lagi/);
  assert.equal(kirim[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(rows.every((x) => x.status !== 'sent' || (x.provider_message_id && x.sent_at)));
  assert.ok(rows.every((x) => !x.nomor_masked || /\*{3,}/.test(x.nomor_masked)));
});

test('eksekusi ganda: tick ulang, scheduler kedua (lease), restart, & tick bersamaan → tidak ada pesan ganda', async () => {
  const sebelum = kirim.length;
  const a = buatScheduler('A');
  const b = buatScheduler('B');
  const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
  assert.ok(rb.dilewati === 'LEASE_DIPEGANG_INSTANCE_LAIN' || ra.dilewati === 'LEASE_DIPEGANG_INSTANCE_LAIN');
  // restart: instance baru dengan pemilik baru setelah lease kedaluwarsa
  jam.t += 4 * 60 * 1000;
  const c = buatScheduler('C');
  await c.tick();
  // paksa pembuatan ulang hari yang sama (mis. Admin "Jalankan sekarang")
  const r = await c.jalankanSekarang();
  assert.equal(r.dibuat.sudahAda, 4);
  assert.equal(r.dibuat.pending, 0);
  assert.equal(kirim.length, sebelum, 'tidak boleh ada pengiriman baru');
  assert.equal(baris("jenis_notifikasi = 'H_MIN_3'").length, 4);
});

test('H-1: angsuran sudah dibayar & pinjaman sudah lunas tidak diingatkan', async () => {
  const R = k.R;
  const jad0 = (await R('pinjaman').getJadwalAngsuran(s.pinjaman[0])).filter((j) => j.status !== 'LUNAS');
  // bayar angsuran ke-1..3 pinjaman 0 (yang ke-3 jatuh tempo 15 Okt)
  for (const j of jad0.slice(0, 3)) await R('pinjaman').bayarAngsuran({ pinjamanId: s.pinjaman[0], jadwalId: j.id, tanggal: '2026-10-13', nominal: j.total - j.pokokTerbayar - j.jasaTerbayar + 5000 * 10, sumberDana: 'KAS', createdBy: s.users.admin }).catch(async () => {
    // nominal termasuk denda: hitung persis lewat percobaan nominal sisa pokok+jasa+denda yang valid
    const d = await R('db').getDb();
    const row = await d.getFirstAsync('SELECT * FROM angsuran_jadwal WHERE id = ?', j.id);
    await R('pinjaman').bayarAngsuran({ pinjamanId: s.pinjaman[0], jadwalId: j.id, tanggal: '2026-10-13', nominal: row.pokok - row.pokok_terbayar + row.jasa - row.jasa_terbayar, sumberDana: 'KAS', createdBy: s.users.admin });
  });
  const d = await R('db').getDb();
  const ke3 = await d.getFirstAsync("SELECT status FROM angsuran_jadwal WHERE pinjaman_id = ? AND nomor_angsuran = 3", s.pinjaman[0]);
  assert.equal(ke3.status, 'LUNAS');
  // lunasi pinjaman 1 seluruhnya lewat service existing
  await R('pinjaman').lunasiPinjaman({ pinjamanId: s.pinjaman[1], tanggal: '2026-10-13', sumberDana: 'KAS', createdBy: s.users.admin });
  assert.equal((await d.getFirstAsync('SELECT status FROM pinjaman WHERE id = ?', s.pinjaman[1])).status, 'LUNAS');
  setJam(2026, 10, 14, 8, 5);
  const sebelum = kirim.length;
  await buatScheduler('C').tick();
  const rows = baris("jenis_notifikasi = 'H_MIN_1'");
  const pj = new Set(rows.map((x) => x.pinjaman_id));
  assert.ok(!pj.has(s.pinjaman[0]), 'angsuran sudah dibayar');
  assert.ok(!pj.has(s.pinjaman[1]), 'pinjaman lunas');
  assert.equal(rows.length, 2);
  assert.equal(kirim.length - sebelum, 1, 'hanya pinjaman 3 (pinjaman 2 nomor tidak sah)');
  assert.match(JSON.parse(kirim[kirim.length - 1].init.body).template.components[0].parameters[5].text, /besok/);
});

test('H (internet offline): tetap pending, jatah percobaan tidak habis; terkirim saat online; dibayar sebelum terkirim → skipped', async () => {
  setJam(2026, 10, 15, 8, 0);
  mode = 'network';
  await buatScheduler('C').tick();
  let rows = baris("jenis_notifikasi = 'H' AND status <> 'skipped'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].percobaan, 0);
  assert.equal(rows[0].error_kode, 'JARINGAN');
  assert.ok(!rows.some((x) => x.status === 'sent'));
  // tambahkan satu baris H lagi dengan pinjaman 3 yang kemudian dibayar
  jam.t += 6 * 60 * 1000;
  await buatScheduler('C').tick(); // masih offline
  assert.equal(baris("jenis_notifikasi = 'H' AND status = 'pending'").length, 1);
  // anggota membayar sebelum koneksi pulih
  const R = k.R;
  const d = await R('db').getDb();
  const j = await d.getFirstAsync("SELECT * FROM angsuran_jadwal WHERE pinjaman_id = ? AND nomor_angsuran = 3", s.pinjaman[3]);
  const sebelumBayar = kirim.length;
  mode = 'ok';
  jam.t += 6 * 60 * 1000;
  await buatScheduler('C').tick();
  rows = baris("jenis_notifikasi = 'H' AND pinjaman_id = ?", s.pinjaman[3]);
  assert.equal(rows[0].status, 'sent', 'online kembali → terkirim');
  assert.equal(kirim.length - sebelumBayar, 1);
  // skenario dibayar-sebelum-kirim: baris pending baru (simulasi) untuk jadwal yang lalu dilunasi
  db.run("UPDATE whatsapp_notifications SET status = 'pending', berikutnya_at = NULL WHERE jenis_notifikasi = 'H' AND pinjaman_id = ?", s.pinjaman[3]);
  await R('pinjaman').bayarAngsuran({ pinjamanId: s.pinjaman[3], jadwalId: j.id, tanggal: '2026-10-15', nominal: j.pokok - j.pokok_terbayar + j.jasa - j.jasa_terbayar, sumberDana: 'KAS', createdBy: s.users.admin });
  const n = kirim.length;
  await buatScheduler('C').jalankanSekarang();
  rows = baris("jenis_notifikasi = 'H' AND pinjaman_id = ?", s.pinjaman[3]);
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].error_kode, 'ANGSURAN_LUNAS');
  assert.equal(kirim.length, n);
});

test('401 token ditolak: pending + scheduler dijeda (tidak menghabiskan percobaan); setelah diperbaiki → terkirim', async () => {
  // jadwal ke-4 pinjaman 2 & 3 (15 Nov) dipakai sebagai H-1 pada 14 Nov; nomor pinjaman 2 tidak sah → hanya 3
  setJam(2026, 11, 14, 9, 0);
  mode = 401;
  const sc = buatScheduler('C');
  const n0 = kirim.length;
  await sc.tick();
  // 15 Nov: pinjaman 0 (angsuran ke-4 belum dibayar) & pinjaman 3 → 2 reminder; pinjaman 2 nomor tidak sah; pinjaman 1 lunas
  const rows = baris("jenis_notifikasi = 'H_MIN_1' AND tanggal_jadwal = '2026-11-14' AND status <> 'skipped'");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'pending' && r.percobaan === 0), 'tidak ada jatah percobaan terpakai');
  assert.equal(kirim.length - n0, 1, 'batch berhenti setelah 401 pertama');
  const ditolak = rows.filter((r) => r.error_kode === 'TOKEN_DITOLAK');
  assert.equal(ditolak.length, 1);
  assert.ok(!ditolak[0].error_message.includes(TOKEN), 'token tidak boleh masuk pesan galat');
  assert.ok(sc.status().dijedaSampai);
  jam.t += 60 * 1000;
  await sc.tick();
  assert.equal(kirim.length - n0, 1, 'dijeda: tidak mencoba lagi sebelum diperbaiki');
  mode = 'ok';
  await sc.jalankanSekarang();
  for (const r of rows) assert.equal(baris('id = ?', r.id)[0].status, 'sent');
});

test('429 lalu sukses (backoff); 500 tiga kali → failed; template salah → failed tanpa retry; timeout', async () => {
  // gunakan baris uji yang dibuat langsung (data pinjaman sama), tanggal jadwal hari ini
  setJam(2026, 11, 20, 9, 0);
  const sc = buatScheduler('C');
  const hari = '2026-11-20';
  const pinjamanAktif = s.pinjaman[3];
  const d = await k.R('db').getDb();
  const jad = await d.getAllAsync("SELECT id, nomor_angsuran FROM angsuran_jadwal WHERE pinjaman_id = ? AND status <> 'LUNAS' ORDER BY nomor_angsuran", pinjamanAktif);
  const buat = (jenis, jadwal) => {
    const id = 'uji-' + jenis + '-' + Math.random().toString(36).slice(2);
    db.run(
      "INSERT INTO whatsapp_notifications (id, anggota_id, pinjaman_id, jadwal_id, nama_anggota, nomor_pinjaman, angsuran_ke, tanggal_jatuh_tempo, jenis_notifikasi, tanggal_jadwal, nomor_tujuan, nomor_masked, sisa_tagihan, status, percobaan, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?)",
      id, s.anggota[3], 'P-' + id, jadwal.id, 'Anggota Uji 4', 'PJ-UJI', jadwal.nomor_angsuran, '2026-11-15', jenis, hari, '6285700001111', '62857****1111', 1000, new Date(jam.t).toISOString(), new Date(jam.t).toISOString()
    );
    return id;
  };
  // 429 → retry
  mode = 429;
  const a = buat('H_PLUS_1', jad[0]);
  await sc.prosesAntrean(hari);
  let r = baris('id = ?', a)[0];
  assert.equal(r.status, 'pending');
  assert.equal(r.percobaan, 1);
  assert.equal(r.error_kode, 'RATE_LIMIT');
  await sc.prosesAntrean(hari); // belum waktunya (backoff 60 dtk)
  assert.equal(baris('id = ?', a)[0].percobaan, 1);
  mode = 'ok';
  jam.t += 61 * 1000;
  await sc.prosesAntrean(hari);
  assert.equal(baris('id = ?', a)[0].status, 'sent');
  // 500 x3 → failed
  mode = 500;
  const b = buat('H_PLUS_7', jad[0]);
  for (const tunda of [0, 61, 301]) {
    jam.t += tunda * 1000;
    await sc.prosesAntrean(hari);
  }
  r = baris('id = ?', b)[0];
  assert.equal(r.status, 'failed');
  assert.equal(r.percobaan, 3);
  assert.match(r.error_message, /3 percobaan/);
  jam.t += 3600 * 1000;
  const n = kirim.length;
  await sc.prosesAntrean(hari);
  assert.equal(kirim.length, n, 'failed tidak dicoba lagi');
  // template salah → failed tanpa retry
  mode = 'template';
  const c = buat('H', jad[0]);
  await sc.prosesAntrean(hari);
  r = baris('id = ?', c)[0];
  assert.equal(r.status, 'failed');
  assert.equal(r.percobaan, 1);
  assert.equal(r.error_kode, 'TEMPLATE');
  // timeout → sementara (percobaan bertambah)
  mode = 'timeout';
  const t = buat('H_MIN_3', jad[0]);
  await sc.prosesAntrean(hari);
  r = baris('id = ?', t)[0];
  assert.equal(r.status, 'pending');
  assert.equal(r.error_kode, 'TIMEOUT');
  assert.equal(r.percobaan, 1);
  mode = 'ok';
});

test("pemulihan crash: baris 'sending' → failed (tidak dikirim ulang); pending kedaluwarsa → skipped", async () => {
  setJam(2026, 11, 25, 9, 0);
  db.run("UPDATE whatsapp_notifications SET status = 'sending' WHERE status = 'pending' AND error_kode = 'TIMEOUT'");
  const n = kirim.length;
  const sc = buatScheduler('D');
  sc.pulihkanSending();
  const r = baris("error_kode = 'STATUS_TIDAK_PASTI'");
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'failed');
  db.run("UPDATE whatsapp_notifications SET status = 'pending', error_kode = NULL WHERE id = ?", r[0].id); // pending lama (20 Nov)
  await sc.prosesAntrean('2026-11-25');
  assert.equal(baris('id = ?', r[0].id)[0].error_kode, 'KEDALUWARSA');
  assert.equal(kirim.length, n);
});

test('reminder nonaktif → scheduler tidak membuat/mengirim apa pun', async () => {
  new PengaturanWa(db).simpan({ aktif: false }, 'uji');
  setJam(2026, 12, 12, 9, 0);
  const n = kirim.length;
  const r = await buatScheduler('D').tick();
  assert.equal(r.dilewati, 'NONAKTIF');
  assert.equal(kirim.length, n);
  new PengaturanWa(db).simpan({ aktif: true, jenis: { H_MIN_3: false } }, 'uji');
  await buatScheduler('D').tick(); // 12 Des: hanya H-3 (15 Des) yang relevan, tapi dimatikan
  assert.equal(baris("tanggal_jadwal = '2026-12-12'").length, 0);
});

test('token tidak pernah muncul di log berkas, database, maupun pesan galat', async () => {
  logger.warn('uji', { pesan: `galat dengan token ${TOKEN}`, accessToken: TOKEN, authorization: `Bearer ${TOKEN}` });
  logger.error(`teks Bearer ${TOKEN}`);
  const isiLog = fs.readFileSync(logFile, 'utf8');
  assert.ok(isiLog.length > 0);
  assert.ok(!isiLog.includes(TOKEN), isiLog);
  const semua = JSON.stringify(db.all('SELECT * FROM whatsapp_notifications')) + JSON.stringify(db.all('SELECT * FROM pengaturan'));
  assert.ok(!semua.includes(TOKEN));
});

