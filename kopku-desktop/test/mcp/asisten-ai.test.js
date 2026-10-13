'use strict';
/**
 * KOPKU Desktop 1.0.25 — uji Pengaturan › Asisten AI (konektor MCP untuk Claude Desktop).
 *
 * KOPKU ASLI headless (service, migrasi v82, SQLite asli; lihat test/lan/kopkuHeadless.js) +
 * adapter renderer ASLI + McpHost ASLI + server stdio ASLI dalam proses terpisah (seperti Claude Desktop).
 * Integrasi main.js/preload.js/IPC diuji di test/lan/desktop-electron.test.js; layar di
 * test/smoke-asisten-ai-chromium.js.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { muatKopku, seed, ROOT } = require('../lan/kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { McpHost } = require(path.join(ROOT, 'electron/mcp/host'));
const { jalankanAlat, bersihkan, OPERASI_BACA } = require(path.join(ROOT, 'electron/mcp/alat'));
const katalog = require(path.join(ROOT, 'electron/mcp/katalog'));
const { tangani } = require(path.join(ROOT, 'electron/mcp/stdio'));
const { buatMcpb, crc32 } = require(path.join(ROOT, 'electron/mcp/mcpb'));

let k;
let s;
let bridge;
let host;
let dataDir;
const anak = new Set(); // proses stdio yang masih hidup (dihentikan di after bila uji gagal di tengah)

function klienStdio(dir) {
  const p = spawn(process.execPath, [path.join(ROOT, 'electron', 'mcp', 'stdio.js'), '--data', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  anak.add(p);
  p.on('exit', () => anak.delete(p));
  let buf = '';
  const tunggu = new Map();
  const mentah = [];
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const baris = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(baris);
      mentah.push(msg);
      const kunci = Array.isArray(msg) ? 'batch' : msg.id;
      if (tunggu.has(kunci)) tunggu.get(kunci)(msg);
    }
  });
  let id = 0;
  return {
    kirim: (method, params) => new Promise((r) => { const n = ++id; tunggu.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }),
    tulis: (teks) => p.stdin.write(teks + '\n'),
    tunggu: (kunci) => new Promise((r) => tunggu.set(kunci, r)),
    mentah,
    tutup: () => new Promise((r) => { p.on('exit', r); p.stdin.end(); }),
  };
}
const teksAlat = (r) => r.result.content[0].text;

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-mcp-uji-'));
  host = new McpHost({ dataDir, bridge, versi: '1.0.25', pastikanAdapter: async () => undefined });
});
after(async () => {
  for (const p of anak) p.kill();
  await host.henti();
});

test('katalog: 14 alat, nama unik, semuanya baca saja & berskema objek', () => {
  const nama = katalog.ALAT.map((a) => a.name);
  assert.equal(nama.length, 14);
  assert.equal(new Set(nama).size, 14);
  for (const a of katalog.untukMcp()) {
    assert.match(a.name, /^[a-z_]{3,40}$/);
    assert.equal(a.inputSchema.type, 'object');
    assert.equal(a.annotations.readOnlyHint, true);
    assert.equal(a.annotations.destructiveHint, false);
  }
  // tidak ada operasi tulis adapter yang dapat dicapai Asisten AI
  for (const op of OPERASI_BACA) assert.doesNotMatch(op, /bayar|setor|tarik|ajukan|cairkan|batalkan|buat|ubah|masuk|keluar|transfer|proses|ekspor|verifikasi/, op);
});

test('bawaan MATI; hanya pengguna aktif dengan izin ubah Pengaturan yang dapat menyalakan', async () => {
  assert.equal(host.status().aktif, false);
  assert.equal(host.status().berjalan, false);
  await assert.rejects(host.atur({ aktif: true, penggunaId: s.users.operator }), /izin ubah Pengaturan/);
  await assert.rejects(host.atur({ aktif: true, penggunaId: s.users.anggotaUser }), /izin ubah Pengaturan/);
  await assert.rejects(host.atur({ aktif: true, penggunaId: 'tidak-ada' }), /tidak ditemukan|nonaktif/);
  await assert.rejects(host.atur({ aktif: true }), /Masuk/);
  assert.equal(host.status().aktif, false);
  const st = await host.atur({ aktif: true, penggunaId: s.users.admin });
  assert.equal(st.aktif, true);
  assert.equal(st.berjalan, true);
  assert.equal(st.perAnggota, false, 'data per anggota bawaan MATI');
  const ep = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp', 'endpoint.json'), 'utf8'));
  assert.match(ep.token, /^[0-9a-f]{64}$/);
  assert.ok(ep.port > 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'mcp', 'endpoint.json')).mode & 0o077, 0, 'endpoint.json hanya untuk pemilik');
});

test('protokol MCP lewat stdio: initialize/negosiasi versi, notifikasi, ping, batch, galat JSON-RPC', async () => {
  const c = klienStdio(dataDir);
  const i1 = await c.kirim('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
  assert.equal(i1.result.protocolVersion, '2025-06-18');
  assert.equal(i1.result.serverInfo.name, 'kopku');
  assert.ok(i1.result.capabilities.tools);
  assert.match(i1.result.instructions, /Rupiah/);
  const i2 = await c.kirim('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(i2.result.protocolVersion, katalog.VERSI_PROTOKOL[0], 'versi tak dikenal → versi terbaru yang didukung');
  c.tulis(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.deepEqual((await c.kirim('ping')).result, {});
  assert.deepEqual((await c.kirim('resources/list')).result, { resources: [] });
  assert.deepEqual((await c.kirim('prompts/list')).result, { prompts: [] });
  assert.equal((await c.kirim('metode/asing')).error.code, -32601);
  assert.equal((await c.kirim('tools/call', { name: 'hapus_semua', arguments: {} })).error.code, -32602);
  c.tulis('{bukan json');
  c.tulis(JSON.stringify([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]));
  const batch = await c.tunggu('batch');
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 'b1', result: {} }]);
  assert.ok(c.mentah.some((m) => m.id === null && m.error && m.error.code === -32700), 'parse error dijawab');
  assert.ok(!c.mentah.some((m) => m.id === undefined && !Array.isArray(m)), 'notifikasi tidak dijawab');
  await c.tutup();
});

test('per anggota OFF: alat angka total saja; tidak ada nama anggota', async () => {
  const c = klienStdio(dataDir);
  const daftar = (await c.kirim('tools/list')).result.tools.map((t) => t.name);
  assert.deepEqual(daftar.sort(), ['buku_besar', 'kolektibilitas_pinjaman', 'laporan_keuangan', 'ringkasan_koperasi', 'riwayat_shu', 'saldo_kas_bank', 'status_kopku']);
  const r = await c.kirim('tools/call', { name: 'ringkasan_koperasi', arguments: {} });
  assert.equal(r.result.isError, false);
  assert.doesNotMatch(teksAlat(r), /Anggota Uji/);
  const kol = await c.kirim('tools/call', { name: 'kolektibilitas_pinjaman', arguments: { rinci: true } });
  assert.match(teksAlat(kol), /tidak diizinkan/);
  assert.doesNotMatch(teksAlat(kol), /Anggota Uji/);
  const ak = await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'arus_kas' } });
  const j = JSON.parse(teksAlat(ak));
  assert.equal(j.data.rincian, undefined, 'rincian arus kas per transaksi tidak dikirim');
  assert.ok(j.data.rekapPerSumber.length > 0);
  const tolak = await c.kirim('tools/call', { name: 'daftar_tunggakan', arguments: {} });
  assert.equal(tolak.result.isError, true);
  await c.tutup();
});

test('angka alat SAMA dengan service KOPKU (sumber yang sama dengan layar)', async () => {
  await host.atur({ perAnggota: true, penggunaId: s.users.admin });
  const c = klienStdio(dataDir);
  const tanggal = '2026-10-13';
  const pos = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'posisi_keuangan', tanggal } })));
  const asli = await k.R('laporan').getPosisiKeuangan(await k.R('db').getDb(), tanggal);
  assert.equal(pos.data.totalAset, asli.totalAset);
  assert.equal(pos.data.totalLiabilitas, asli.totalLiabilitas);
  assert.equal(pos.data.isBalanced, true);
  const tg = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'daftar_tunggakan', arguments: { batas: 1 } })));
  const tgAsli = await k.R('pinjaman').listTunggakan();
  assert.equal(tg.jumlahAngsuranMenunggak, tgAsli.length);
  assert.equal(tg.totalSisaTagihan, tgAsli.reduce((a, x) => a + x.sisaTagihan, 0));
  assert.equal(tg.tunggakan.length, 1);
  assert.equal(tg.terpotong, true);
  const sim = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'saldo_simpanan', arguments: {} })));
  const simAsli = await k.R('simpanan').listSaldoSimpananSemuaAnggota();
  assert.equal(sim.total.total, simAsli.reduce((a, x) => a + x.total, 0));
  const dp = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'detail_pinjaman', arguments: { pinjaman: 'pj-2026-000002' } })));
  assert.equal(dp.pinjaman.nomorPinjaman, 'PJ-2026-000002');
  assert.equal(dp.jadwal.length, 6);
  const bb = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'buku_besar', arguments: { akun: '1-1000', mulai: '2026-01-01', selesai: tanggal } })));
  assert.equal(bb.akun.nama, 'Kas');
  assert.ok(bb.mutasi.length > 0);
  await c.tutup();
});

test('data pribadi tidak pernah keluar (NIK, alamat, HP, tanggal lahir, rekening)', async () => {
  const d = await k.R('db').getDb();
  await d.runAsync("UPDATE anggota SET nik = '3201010101010001', alamat = 'Jl. Rahasia 9', tempat_lahir = 'Bogor', tanggal_lahir = '1990-02-03' WHERE id = ?", s.anggota[0]);
  const c = klienStdio(dataDir);
  for (const [nama, args] of [['cari_anggota', {}], ['detail_anggota', { anggota: 'A00001' }], ['saldo_simpanan', {}], ['daftar_pinjaman', {}], ['detail_pinjaman', { pinjaman: 'PJ-2026-000001' }], ['daftar_tunggakan', {}], ['ringkasan_koperasi', {}], ['kolektibilitas_pinjaman', { rinci: true }], ['saldo_kas_bank', {}], ['riwayat_transaksi', {}]]) {
    const t = teksAlat(await c.kirim('tools/call', { name: nama, arguments: args }));
    assert.doesNotMatch(t, /3201010101010001|Rahasia|Bogor|1990-02-03|081234567890|813-1111-2222|nomorHp|"nik"|"alamat"|password|salt/i, nama);
  }
  await c.tutup();
  assert.deepEqual(bersihkan({ a: 1, nik: 'x', nested: [{ nomorHp: '1', tanggalLahir: 'x', pinjaman: 5, nomorRekening: '9' }], token: 't' }), { a: 1, nested: [{ pinjaman: 5 }] });
});

test('validasi masukan: tanggal tidak sah, periode terbalik, pencarian ambigu, batas dibatasi', async () => {
  const c = klienStdio(dataDir);
  const t1 = await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'laba_rugi', mulai: '2026-02-30' } });
  assert.equal(t1.result.isError, true);
  assert.match(teksAlat(t1), /tanggal yang sah/);
  const t2 = await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'laba_rugi', mulai: '2026-05-01', selesai: '2026-01-01' } });
  assert.match(teksAlat(t2), /tidak boleh setelah/);
  const t3 = await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'apa' } });
  assert.equal(t3.result.isError, true);
  const t4 = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'detail_anggota', arguments: { anggota: 'Anggota Uji' } })));
  assert.match(t4.pesan, /Lebih dari satu/);
  assert.equal(t4.kandidat.length, 4);
  const t5 = await c.kirim('tools/call', { name: 'detail_pinjaman', arguments: { pinjaman: 'PJ-9999' } });
  assert.match(teksAlat(t5), /tidak ditemukan/);
  const t6 = JSON.parse(teksAlat(await c.kirim('tools/call', { name: 'cari_anggota', arguments: { batas: 99999 } })));
  assert.equal(t6.anggota.length, 4);
  await c.tutup();
});

test('izin mengikuti Permission Matrix pengguna yang menyalakan (gagal tertutup)', async () => {
  // Pengguna tanpa izin Lihat Laporan → alat laporan ditolak dengan penjelasan.
  const tanpaLaporan = { perAnggota: true, hariIni: '2026-10-13', info: { pengguna: 'Uji' }, boleh: async (r) => r !== 'laporan', panggil: (op, a) => bridge.panggil(op, a, { userId: s.users.admin }) };
  const r = await jalankanAlat('laporan_keuangan', { jenis: 'posisi_keuangan' }, tanpaLaporan);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /tidak punya izin melihat laporan/);
  // role ANGGOTA tidak pernah dapat dipakai
  const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp', 'pengaturan.json'), 'utf8'));
  fs.writeFileSync(path.join(dataDir, 'mcp', 'pengaturan.json'), JSON.stringify(Object.assign({}, p, { pengguna: { id: s.users.anggotaUser, nama: 'A', username: 'anggota1' } })));
  const ag = await host.panggil('status_kopku', {});
  assert.equal(ag.isError, true);
  assert.match(ag.content[0].text, /Anggota tidak dapat/);
  fs.writeFileSync(path.join(dataDir, 'mcp', 'pengaturan.json'), JSON.stringify(p));
  // lisensi tidak valid
  k.statusLisensi.lisensiValid = false;
  const lis = await host.panggil('status_kopku', {});
  k.statusLisensi.lisensiValid = true;
  assert.match(lis.content[0].text, /Lisensi/);
  assert.equal((await host.panggil('status_kopku', {})).isError, false);
});

test('log pemakaian tanpa isi data; status menghitung pemakaian', async () => {
  const log = fs.readFileSync(path.join(dataDir, 'mcp', 'pemakaian.log'), 'utf8');
  assert.match(log, /ringkasan_koperasi\tBERHASIL/);
  assert.doesNotMatch(log, /Anggota Uji|PJ-2026|56600000/, 'tidak ada isi data di log');
  assert.ok(host.status().pemakaian.total > 20);
  assert.ok(host.riwayat(5).length === 5);
});

test('paket .mcpb: ZIP sah, manifest MCPB 0.2, server di dalamnya menjawab lewat Node', async () => {
  const tujuan = path.join(dataDir, 'mcp', 'KOPKU-Asisten-AI.mcpb');
  buatMcpb({ tujuan, versi: '1.0.25', dataDir, ikon: path.join(ROOT, 'build', 'icon.png') });
  const buf = fs.readFileSync(tujuan);
  const akhir = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(akhir + 10);
  let o = buf.readUInt32LE(akhir + 16);
  const isi = {};
  for (let i = 0; i < n; i++) {
    const pn = buf.readUInt16LE(o + 28);
    const nama = buf.slice(o + 46, o + 46 + pn).toString();
    const lokal = buf.readUInt32LE(o + 42);
    const awal = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
    const data = zlib.inflateRawSync(buf.slice(awal, awal + buf.readUInt32LE(o + 20)));
    assert.equal(crc32(data), buf.readUInt32LE(o + 16), `CRC ${nama}`);
    isi[nama] = data;
    o += 46 + pn;
  }
  assert.deepEqual(Object.keys(isi).sort(), ['icon.png', 'manifest.json', 'server/index.js', 'server/katalog.js', 'server/stdio.js']);
  const man = JSON.parse(isi['manifest.json']);
  assert.equal(man.manifest_version, '0.2');
  assert.equal(man.name, 'kopku');
  assert.equal(man.version, '1.0.25');
  assert.equal(man.server.type, 'node');
  assert.equal(man.server.entry_point, 'server/index.js');
  assert.deepEqual(man.server.mcp_config, { command: 'node', args: ['${__dirname}/server/index.js', '--data', dataDir] });
  assert.equal(man.tools.length, 14);
  // 1.0.28 — server di paket = stdio.js tanpa komentar (tidak memuat keterangan struktur internal).
  assert.deepEqual(isi['server/stdio.js'], untukDikirim(fs.readFileSync(path.join(ROOT, 'electron', 'mcp', 'stdio.js'), 'utf8')));
  for (const n of ['server/index.js', 'server/stdio.js', 'server/katalog.js']) assert.doesNotMatch(isi[n].toString(), /\/\*\*|^\s*\/\//m, `${n} tanpa komentar`);
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-mcpb-'));
  for (const [nama, data] of Object.entries(isi)) {
    fs.mkdirSync(path.dirname(path.join(ext, nama)), { recursive: true });
    fs.writeFileSync(path.join(ext, nama), data);
  }
  const p = spawn(process.execPath, man.server.mcp_config.args.map((a) => a.replace('${__dirname}', ext)), { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (c) => (out += c));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'saldo_kas_bank', arguments: {} } }) + '\n');
  p.stdin.end();
  await new Promise((r) => p.on('exit', r));
  const j = JSON.parse(out.trim());
  assert.equal(j.result.isError, false);
  assert.match(j.result.content[0].text, /Kas Tunai/);

  // 1.0.30 — Node.js bawaan Claude Desktop MEMUAT titik masuk lewat pembungkusnya (require.main ≠ berkas server).
  // Dulu (entry = stdio.js) server tidak pernah menyala → `initialize` tidak dijawab → "Request timed out".
  const lewatPembungkus = async (berkas) => {
    const q = spawn(process.execPath, ['-e', 'require(process.argv[1])', path.join(ext, berkas), '--data', dataDir], { stdio: ['pipe', 'pipe', 'ignore'] });
    let keluar = '';
    q.stdout.on('data', (c) => (keluar += c));
    q.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    q.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'saldo_kas_bank', arguments: {} } }) + '\n');
    q.stdin.end();
    await new Promise((r) => q.on('exit', r));
    return keluar.trim().split('\n').filter(Boolean).map((b) => JSON.parse(b));
  };
  const lewat = await lewatPembungkus(man.server.entry_point);
  assert.equal(lewat.length, 2, 'titik masuk menjawab walau dimuat lewat pembungkus');
  assert.equal(lewat[0].result.serverInfo.name, 'kopku');
  assert.match(lewat[1].result.content[0].text, /Kas Tunai/);
  assert.deepEqual(await lewatPembungkus('server/stdio.js'), [], 'bukti penyebab: stdio.js saja tidak menyala bila dimuat pembungkus');
});

test('dimatikan: port ditutup, endpoint dihapus; server stdio tetap menjawab dengan petunjuk', async () => {
  const ep = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp', 'endpoint.json'), 'utf8'));
  await host.atur({ aktif: false, penggunaId: s.users.admin });
  assert.equal(fs.existsSync(path.join(dataDir, 'mcp', 'endpoint.json')), false);
  await assert.rejects(fetch(`http://127.0.0.1:${ep.port}/alat`, { headers: { Authorization: 'Bearer ' + ep.token } }));
  const r = await tangani({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status_kopku', arguments: {} } }, { dataDir });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /belum dinyalakan/);
  const l = await tangani({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { dataDir });
  assert.equal(l.result.tools.length, 14, 'Claude tetap mengenal alat walau KOPKU tertutup');
});

test('pemasang menu: idempoten, dapat dilepas, bundle kembali byte-identik', () => {
  const ai = require(path.join(ROOT, 'scripts', 'pasang-menu-asisten-ai.js'));
  const lan = require(path.join(ROOT, 'scripts', 'pasang-menu-lan-wa.js'));
  const dir = path.join(ROOT, 'renderer', '_expo', 'static', 'js', 'web');
  const teks = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => /^entry-.*\.js$/.test(f))), 'utf8');
  assert.ok(teks.includes('name:"AsistenAi"'), 'menu terpasang di bundle paket ini');
  const tanpa = ai.lepas(teks);
  assert.ok(!/AsistenAi|asistenai|,9201,\[/.test(tanpa));
  const sumber = fs.readFileSync(path.join(ROOT, 'renderer-patch', 'AsistenAiScreen.js'), 'utf8');
  const lagi = ai.pasang(tanpa, sumber);
  assert.equal(lagi.teks, teks, 'pasang(lepas(x)) === x');
  assert.equal(ai.pasang(teks, sumber).sudah, true);
  // menu LAN & WhatsApp dapat dipasang ulang (prestart) tanpa merusak menu Asisten AI; setelah keduanya
  // dilepas isinya sama dengan bundle asli, dan pemasangan berikutnya stabil (tidak menulis ulang bundle).
  const sumberLan = fs.readFileSync(path.join(ROOT, 'renderer-patch', 'LanWhatsAppScreen.js'), 'utf8');
  const lanUlang = lan.pasang(lan.lepas(teks), sumberLan).teks;
  for (const k of ['name:"AsistenAi"', ',9201,[', "'asistenai'===e"]) assert.equal(lanUlang.split(k).length - 1, 1, k);
  assert.equal(lan.lepas(ai.lepas(lanUlang)), lan.lepas(ai.lepas(teks)));
  const stabil = ai.pasang(ai.lepas(lanUlang), sumber).teks;
  assert.equal(lan.pasang(lan.lepas(stabil), sumberLan).teks, stabil, 'LAN lalu Asisten AI: hasil stabil');
  assert.throws(() => ai.pasang(lan.lepas(tanpa), sumber), /LAN & WhatsApp belum terpasang/);
  for (const k of ["AsistenAi:n('pengaturan')", "'AsistenAi','Asisten AI','sparkles-outline'", "route:'AsistenAi'", "'asistenai'===e", 'name:"AsistenAi",component:']) assert.equal(teks.split(k).length - 1, 1, k);
});

// ---------------------------------------------------------------- 1.0.26: Node.js / ekstensi (temuan Windows)
const { siapkanServerLokal, cariNode, kandidatNode, untukDikirim } = require(path.join(ROOT, 'electron/mcp/serverLokal'));
const { daftarkanIpcAsistenAi } = require(path.join(ROOT, 'electron/mcp/ipc'));
const claudeConfig = require(path.join(ROOT, 'electron/mcp/claudeConfig'));

test('1.0.26: cariNode — PATH & lokasi umum Windows, hanya Node ≥ 18 yang dapat dijalankan', () => {
  const rumah = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-node-'));
  const pf = path.join(rumah, 'Program Files');
  fs.mkdirSync(path.join(pf, 'nodejs'), { recursive: true });
  fs.writeFileSync(path.join(pf, 'nodejs', 'node.exe'), '');
  const lama = path.join(rumah, 'lama');
  fs.mkdirSync(lama);
  fs.writeFileSync(path.join(lama, 'node.exe'), '');
  const env = { PATH: `${lama};C:\\tidak-ada`, ProgramFiles: pf };
  const versi = { [path.join(lama, 'node.exe')]: 'v16.20.0', [path.join(pf, 'nodejs', 'node.exe')]: 'v22.11.0' };
  const n = cariNode({ platform: 'win32', env, home: rumah, jalankan: (f) => versi[f] });
  assert.deepEqual(n, { path: path.join(pf, 'nodejs', 'node.exe'), versi: 'v22.11.0' }, 'Node 16 di PATH dilewati');
  assert.equal(cariNode({ platform: 'win32', env: { PATH: '' , ProgramFiles: path.join(rumah, 'kosong') }, home: rumah, jalankan: () => 'v22.0.0' }), null);
  assert.ok(kandidatNode({ platform: 'darwin', env: { PATH: '' }, home: '/Users/u' }).includes('/opt/homebrew/bin/node'));
  // Node asli di komputer uji ditemukan dan dapat dijalankan
  const asli = cariNode();
  assert.ok(asli && /^v\d+/.test(asli.versi));
});

test('1.0.26: server lokal disalin ke folder data & dijalankan Node.js persis seperti entri Claude', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-srv-'));
  const f = siapkanServerLokal(dir);
  assert.equal(f, path.join(dir, 'mcp', 'server', 'stdio.js'));
  const mtime = fs.statSync(f).mtimeMs;
  siapkanServerLokal(dir);
  assert.equal(fs.statSync(f).mtimeMs, mtime, 'tidak ditulis ulang bila sama');
  const entri = claudeConfig.entriNode({ nodePath: process.execPath, serverPath: f, dataDir: dataDir });
  assert.equal(claudeConfig.entriMilikKopku(entri), true);
  const p = spawn(entri.command, entri.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (err += c));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  p.stdin.end();
  await new Promise((r) => p.on('exit', r));
  const b = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(b[0].result.serverInfo.name, 'kopku');
  assert.equal(b[1].result.tools.length, 14);
  assert.match(err, /stdin ditutup setelah 2 pesan/);
});

function ipcUji({ platform, node, rumah, dir, dialog, folderDokumen }) {
  const handler = new Map();
  const dibuka = [];
  const h2 = new McpHost({ dataDir: dir, bridge, versi: '1.0.26', pastikanAdapter: async () => undefined });
  const lingkungan = { platform: 'win32', env: { APPDATA: path.join(rumah, 'Roaming'), LOCALAPPDATA: path.join(rumah, 'Local') }, home: rumah };
  daftarkanIpcAsistenAi({
    h: (ch, fn) => handler.set(ch, fn),
    host: h2,
    dataDir: dir,
    execPath: 'C:\\K\\KOPKU Desktop.exe',
    appPath: null,
    versi: '1.0.26',
    ikon: path.join(ROOT, 'build', 'icon.png'),
    shell: { openPath: async (p) => (dibuka.push(p), ''), showItemInFolder() {}, openExternal: async () => undefined },
    clipboard: { writeText() {} },
    lingkungan,
    platform,
    cariNode: () => node,
    dialog,
    jendela: dialog ? () => 'jendela-utama' : undefined,
    folderDokumen,
  });
  const config = () => JSON.parse(fs.readFileSync(path.join(rumah, 'Roaming', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  return { ipc: (ch, ...a) => handler.get(ch)(...a), dibuka, host: h2, config };
}

test('1.0.26: Windows + Node.js → entri "kopku" memakai node.exe (bukan KOPKU Desktop.exe)', async () => {
  const rumah = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-rumah-'));
  fs.mkdirSync(path.join(rumah, 'Roaming', 'Claude'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-data-'));
  const u = ipcUji({ platform: 'win32', node: { path: 'C:\\Program Files\\nodejs\\node.exe', versi: 'v22.11.0' }, rumah, dir });
  const st = await u.ipc('asistenAi:atur', { aktif: true, penggunaId: s.users.admin });
  assert.equal(st.runtime.jenis, 'node');
  assert.equal(st.claude.cocok, true);
  assert.deepEqual(u.config().mcpServers.kopku, { command: 'C:\\Program Files\\nodejs\\node.exe', args: [path.join(dir, 'mcp', 'server', 'stdio.js'), '--data', dir] });
  assert.ok(fs.existsSync(path.join(dir, 'mcp', 'server', 'katalog.js')));
  assert.equal(u.dibuka.length, 0, 'tidak membuka ekstensi');
  await u.host.henti();
});

test('1.0.26: Windows TANPA Node.js → menyalakan membuat & membuka ekstensi .mcpb (exe tidak dipakai)', async () => {
  const rumah = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-rumah-'));
  fs.mkdirSync(path.join(rumah, 'Roaming', 'Claude'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-data-'));
  const u = ipcUji({ platform: 'win32', node: null, rumah, dir });
  const st = await u.ipc('asistenAi:atur', { aktif: true, penggunaId: s.users.admin });
  assert.equal(st.runtime.jenis, 'exe');
  assert.equal(st.runtime.perluEkstensi, true);
  assert.equal(st.cara, 'ekstensi');
  assert.equal(st.ekstensi.dibuka, true);
  assert.deepEqual(u.dibuka, [path.join(dir, 'mcp', 'KOPKU-Asisten-AI.mcpb')]);
  assert.equal(fs.existsSync(path.join(rumah, 'Roaming', 'Claude', 'claude_desktop_config.json')), false, 'tidak ada entri exe yang gagal');
  const p = await u.ipc('asistenAi:pasangClaude', s.users.admin);
  assert.ok(p.ekstensi, 'Pasang ke Claude Desktop juga memakai ekstensi');
  await u.host.henti();
});

test('1.0.26: entri lama 1.0.25 (KOPKU Desktop.exe --kopku-mcp-stdio) otomatis diganti ke Node.js saat KOPKU dibuka', async () => {
  const rumah = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-rumah-'));
  const folder = path.join(rumah, 'Roaming', 'Claude');
  fs.mkdirSync(folder, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-data-'));
  fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp', 'pengaturan.json'), JSON.stringify({ aktif: true, perAnggota: false, cara: 'config', pengguna: { id: s.users.admin, nama: 'A', username: 'admin' } }));
  const blender = { command: 'uvx', args: ['blender-mcp'] };
  fs.writeFileSync(path.join(folder, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { Blender: blender, kopku: { command: 'D:\\kopku\\KOPKU Desktop\\KOPKU Desktop.exe', args: ['--kopku-mcp-stdio', '--data', dir] } } }));
  const u = ipcUji({ platform: 'win32', node: { path: 'C:\\Program Files\\nodejs\\node.exe', versi: 'v22.11.0' }, rumah, dir });
  const c = u.config();
  assert.equal(c.mcpServers.kopku.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(c.mcpServers.Blender, blender);
  assert.ok(fs.readdirSync(folder).some((f) => /kopku-cadangan/.test(f)));
});

// ---------------------------------------------------------------- 1.0.28: keamanan & privasi
const privasi = require(path.join(ROOT, 'electron/mcp/privasi'));
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

test('1.0.28: penyaring keluaran membuang data pribadi & struktur internal (ID, jalur, SQL, stack)', () => {
  const out = privasi.saring({
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    anggotaId: 'x',
    nik: '3201',
    alamat: 'Jl. A',
    nomorAnggota: 'A-0001',
    nama: 'Budi',
    catatan: 'lihat C:\\Users\\budi\\AppData\\Roaming\\KOPKU\\kopku.db dan /home/budi/.config/KOPKU/x.db',
    galat: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: anggota.nik\n    at simpan (C:\\app\\renderer\\entry.js:1:2)',
    uri: 'kopkufs://local/C:/x',
    daftar: [{ pinjamanId: 'y', nomorPinjaman: 'PJ-1', ket: 'ref 0f8fad5b-d9cb-469f-a165-70867728950e' }],
  });
  assert.deepEqual(Object.keys(out).sort(), ['catatan', 'daftar', 'galat', 'nama', 'nomorAnggota']);
  assert.equal(out.catatan, 'lihat [jalur] dan [jalur]');
  assert.doesNotMatch(out.galat, /SQLITE|anggota\.nik|entry\.js|at simpan/);
  assert.deepEqual(out.daftar, [{ nomorPinjaman: 'PJ-1', ket: 'ref [id]' }]);
});

test('1.0.28: semua alat baca tidak membocorkan ID internal, jalur berkas, URI, atau galat SQL', async () => {
  await host.atur({ aktif: true, perAnggota: true, penggunaId: s.users.admin });
  const anggota = JSON.parse((await host.panggil('cari_anggota', {})).content[0].text).anggota;
  const pinjaman = JSON.parse((await host.panggil('daftar_pinjaman', {})).content[0].text);
  const noPinjaman = JSON.stringify(pinjaman).match(/PJ-[\w-]+/);
  const panggilan = katalog.ALAT.map((a) => [a.name, {}]).concat([
    ['laporan_keuangan', { jenis: 'posisi_keuangan' }],
    ['laporan_keuangan', { jenis: 'shu' }],
    ['detail_anggota', { anggota: anggota[0].nomorAnggota }],
    ['saldo_simpanan', { anggota: anggota[0].nomorAnggota }],
    ['riwayat_transaksi', { anggota: anggota[0].nomorAnggota }],
  ]).concat(noPinjaman ? [['detail_pinjaman', { pinjaman: noPinjaman[0] }]] : []);
  let berhasil = 0;
  for (const [nama, args] of panggilan) {
    const r = await host.panggil(nama, args);
    const t = r.content[0].text;
    if (!r.isError) berhasil++;
    assert.doesNotMatch(t, RE_UUID, `${nama}: UUID`);
    assert.doesNotMatch(t, /kopkufs:|file:\/\/|[A-Za-z]:\\\\|\/tmp\/|\/home\//, `${nama}: jalur`);
    assert.doesNotMatch(t, /SQLITE_|no such table|\bat \S+ \(/, `${nama}: galat internal`);
    assert.ok(!t.includes(dataDir) && !t.includes(k.dataDir), `${nama}: folder data`);
  }
  assert.ok(berhasil >= katalog.ALAT.length, `sebagian besar alat berhasil (${berhasil})`);
});

test('1.0.28: Claude menerima kebijakan (rahasia struktur aplikasi, hanya penggunaan sah, data ≠ perintah)', async () => {
  const r = await tangani({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { host: async () => ({}) });
  assert.ok(r.result.instructions.includes(katalog.KEBIJAKAN));
  assert.match(katalog.KEBIJAKAN, /struktur|internal/i);
  assert.match(katalog.KEBIJAKAN, /ilegal|melanggar hukum|sah/i);
});

test('1.0.28: berkas server yang disalin ke luar aplikasi tanpa komentar & tetap berjalan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-kirim-'));
  const f = siapkanServerLokal(dir);
  for (const n of ['stdio.js', 'katalog.js']) {
    const isi = fs.readFileSync(path.join(path.dirname(f), n), 'utf8');
    assert.doesNotMatch(isi, /\/\*|^\s*\/\//m, `${n} tanpa komentar`);
    assert.doesNotMatch(isi, /renderer|adapterTulis|rendererAdapter|serviceBridge|main\.js/, `${n} tanpa rujukan internal`);
  }
  const p = spawn(process.execPath, [f, '--data', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  const balas = new Promise((r) => p.stdout.once('data', (d) => r(JSON.parse(String(d).split('\n')[0]))));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  const m = await balas;
  p.stdin.end();
  assert.equal(m.result.serverInfo.name, 'kopku');
});

test('1.0.28: .mcpb — pengguna memilih folder simpan; batal = tidak ada berkas; folder diingat', async () => {
  const rumah = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-rumah-'));
  fs.mkdirSync(path.join(rumah, 'Roaming', 'Claude'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-data-'));
  const dokumen = path.join(rumah, 'Dokumen');
  const pilihan = path.join(rumah, 'Pilihan Saya');
  const opsiDialog = [];
  let jawab = { canceled: true };
  const dialog = { showSaveDialog: async (induk, o) => (opsiDialog.push({ induk, o }), jawab) };
  const u = ipcUji({ platform: 'win32', node: null, rumah, dir, dialog, folderDokumen: dokumen });
  await u.ipc('asistenAi:atur', { aktif: false, penggunaId: s.users.admin });
  // bawaan: Dokumen › KOPKU Desktop
  assert.equal((await u.ipc('asistenAi:status')).folderEkstensi, path.join(dokumen, 'KOPKU Desktop'));
  // batal
  assert.deepEqual(await u.ipc('asistenAi:buatEkstensi', s.users.admin), { dibatalkan: true });
  assert.equal(opsiDialog[0].induk, 'jendela-utama');
  assert.equal(opsiDialog[0].o.defaultPath, path.join(dokumen, 'KOPKU Desktop', 'KOPKU-Asisten-AI.mcpb'));
  assert.deepEqual(opsiDialog[0].o.filters[0].extensions, ['mcpb']);
  assert.equal(u.dibuka.length, 0);
  assert.equal(fs.readdirSync(path.join(dokumen, 'KOPKU Desktop')).length, 0, 'batal → tidak ada berkas');
  // pilih folder lain (tanpa ekstensi → .mcpb ditambahkan)
  fs.mkdirSync(pilihan);
  jawab = { canceled: false, filePath: path.join(pilihan, 'kopku-claude') };
  const r = await u.ipc('asistenAi:buatEkstensi', s.users.admin);
  assert.equal(r.berkas, path.join(pilihan, 'kopku-claude.mcpb'));
  assert.equal(r.folder, pilihan);
  assert.ok(fs.statSync(r.berkas).size > 1000);
  assert.deepEqual(u.dibuka, [r.berkas]);
  const st = await u.ipc('asistenAi:status');
  assert.equal(st.folderEkstensi, pilihan, 'folder terakhir diingat');
  assert.equal(st.cara, 'ekstensi');
  // 1.0.30 — ekstensi dari versi lama → layar meminta dibuat ulang; ekstensi baru → tidak
  assert.equal(st.ekstensiUsang, false);
  fs.writeFileSync(path.join(dir, 'mcp', 'lokasi-ekstensi.json'), JSON.stringify({ folder: pilihan }));
  assert.equal((await u.ipc('asistenAi:status')).ekstensiUsang, true, 'ekstensi buatan versi lama (tanpa versi)');
  // dialog berikutnya dibuka di folder terakhir; "Buka folder ekstensi" membuka folder itu
  jawab = { canceled: true };
  await u.ipc('asistenAi:buatEkstensi', s.users.admin);
  assert.equal(path.dirname(opsiDialog[2].o.defaultPath), pilihan);
  await u.ipc('asistenAi:bukaFolderEkstensi');
  assert.equal(u.dibuka[u.dibuka.length - 1], pilihan);
  await u.host.henti();
});
