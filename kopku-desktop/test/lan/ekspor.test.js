'use strict';
/**
 * Windows 1.0.21 — ekspor PDF/Excel/CSV dari browser LAN memakai builder
 * laporan + ExportService.exportLaporan yang SAMA dengan aplikasi.
 * (PDF butuh mesin cetak Electron; di harness Node diuji CSV & Excel.)
 * (proses terpisah: satu DB per proses)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { siapkan, Klien, beriAkses, PASSWORD } = require('./kit');

let K;
let admin;
before(async () => {
  K = await siapkan();
  admin = new Klien(K.base);
  assert.equal((await admin.login('admin', PASSWORD.admin)).status, 200);
});
after(async () => {
  await K.srv.henti();
});

async function unduh(klien, p) {
  const res = await fetch(K.base + p, { headers: { Cookie: klien.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, tipe: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), buf };
}

test('semua jenis ekspor menghasilkan berkas yang sama formatnya dengan aplikasi', async () => {
  const akun = (await admin.req('GET', '/api/laporan/akun')).body.data;
  const kas = akun.find((a) => /kas/i.test(a.nama)) || akun[0];
  const pj = (await admin.req('GET', '/api/pinjaman?kategori=AKTIF')).body.data.baris[0];
  const kasus = [
    ['posisi-keuangan', 'tanggal=2026-12-31', /Posisi Keuangan/i],
    ['lhu', 'mulai=2026-01-01&selesai=2026-12-31', /Hasil Usaha/i],
    ['laba-rugi', 'mulai=2026-01-01&selesai=2026-12-31', /Laba Rugi/i],
    ['arus-kas', 'mulai=2026-01-01&selesai=2026-12-31', /Arus Kas/i],
    ['perubahan-ekuitas', 'mulai=2026-01-01&selesai=2026-12-31', /Ekuitas/i],
    ['neraca-saldo', 'tanggal=2026-12-31', /Neraca Saldo/i],
    ['buku-besar', `akun=${kas.id}&mulai=2026-06-01&selesai=2026-12-31`, /Saldo Awal/i],
    ['kolektibilitas', '', /Kolektibilitas/i],
    ['anggota', 'status=AKTIF', /Daftar Anggota/i],
    ['pinjaman', 'kategori=AKTIF', /Daftar Pinjaman/i],
    ['angsuran', `pinjaman=${pj.id}`, new RegExp(pj.nomorPinjaman)],
    ['simpanan', '', /Simpanan/i],
    ['history', 'mulai=2026-01-01&selesai=2026-12-31', /Transaksi/i],
    ['data-bank', '', /Data Bank/i],
  ];
  for (const [jenis, qs, pola] of kasus) {
    const r = await unduh(admin, `/api/ekspor/${jenis}?format=CSV${qs ? '&' + qs : ''}`);
    assert.equal(r.status, 200, `${jenis}: ${r.buf.toString('utf8').slice(0, 300)}`);
    assert.match(r.tipe, /text\/csv/, jenis);
    assert.match(r.disp, /^attachment; filename="[^"]+\.csv"/, jenis);
    assert.match(r.buf.toString('utf8'), pola, jenis);
  }
  const x = await unduh(admin, '/api/ekspor/neraca-saldo?format=EXCEL&tanggal=2026-12-31');
  assert.equal(x.status, 200, x.buf.toString('utf8').slice(0, 300));
  assert.match(x.tipe, /spreadsheetml/);
  assert.equal(x.buf.slice(0, 2).toString('latin1'), 'PK', 'berkas .xlsx (zip)');
  assert.match(x.disp, /\.xlsx"/);
  // berkas sementara di komputer server dihapus setelah dikirim
  const dir = path.join(path.dirname(path.dirname(K.k.dbFile)), 'exports');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  // tercatat di audit LAN
  const audit = (await K.srv.auditDaftar({ limit: 100 })).baris.filter((r) => r.action === 'EKSPOR');
  assert.ok(audit.length >= kasus.length + 1);
});

test('ekspor: izin Export + izin lihat data; parameter divalidasi', async () => {
  await beriAkses(K.base, K.s.users.pengawas, 'PENGAWAS');
  const pengawas = new Klien(K.base);
  assert.equal((await pengawas.login('pengawas', PASSWORD.pengawas)).status, 200);
  const r = await pengawas.req('GET', '/api/ekspor/neraca-saldo?format=CSV&tanggal=2026-12-31');
  assert.equal(r.status, 403, 'Pengawas = baca saja (tanpa export)');
  assert.equal((await admin.req('GET', '/api/ekspor/tidak-ada?format=CSV')).status, 404);
  assert.equal((await admin.req('GET', '/api/ekspor/neraca-saldo?format=DOCX&tanggal=2026-12-31')).status, 422);
  assert.equal((await admin.req('GET', '/api/ekspor/neraca-saldo?format=CSV&tanggal=31-12-2026')).status, 422);
  assert.equal((await new Klien(K.base).req('GET', '/api/ekspor/neraca-saldo?format=CSV&tanggal=2026-12-31')).status, 401);
});

test('buku besar web: saldo awal sebelum "dari tanggal" ikut (sama dengan aplikasi)', async () => {
  const akun = (await admin.req('GET', '/api/laporan/akun')).body.data;
  const kas = akun.find((a) => /kas/i.test(a.nama)) || akun[0];
  const penuh = (await admin.req('GET', `/api/laporan/buku-besar?akun=${kas.id}&mulai=2000-01-01&selesai=2026-12-31`)).body.data;
  const potong = (await admin.req('GET', `/api/laporan/buku-besar?akun=${kas.id}&mulai=2026-08-20&selesai=2026-12-31`)).body.data;
  const akhir = (d) => (d.baris.length ? d.baris[d.baris.length - 1].saldoBerjalan : d.saldoAwal);
  assert.equal(akhir(potong), akhir(penuh), 'saldo akhir sama walau periode dipotong');
  assert.equal(typeof potong.saldoAwal, 'number');
});
