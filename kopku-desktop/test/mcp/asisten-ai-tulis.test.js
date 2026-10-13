'use strict';
/**
 * KOPKU Desktop 1.0.27 — uji Asisten AI "Izinkan Claude mengubah data".
 *
 * KOPKU ASLI headless (service, SQLite asli) + adapter LAN ASLI + adapter tulis ASLI + McpHost ASLI.
 * Klien MCP = proses stdio sungguhan (seperti Claude Desktop) untuk alur utama.
 *
 * Yang dibuktikan:
 *   - bawaan MATI, hanya Admin, mengizinkan ubah data juga menyalakan data per anggota;
 *   - pratinjau TIDAK menulis apa pun (jumlah baris semua tabel tetap);
 *   - kode konfirmasi: wajib, sekali pakai, terikat alat + argumen + isi pratinjau (data berubah → pratinjau baru);
 *   - backup otomatis sebelum perubahan; izin Permission Matrix per aksi;
 *   - setiap alat ubah data menghasilkan perubahan yang sama dengan layar, neraca tetap seimbang;
 *   - koreksi = jurnal pembalik, tidak ada jurnal yang dihapus;
 *   - import Data Awal: berkas terblokir tidak dapat diimpor, berkas sah terimpor, impor ulang dilewati.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { muatKopku, seed, ROOT } = require('../lan/kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { McpHost } = require(path.join(ROOT, 'electron/mcp/host'));
const { pasangAdapterTulis, indeksTulis } = require(path.join(ROOT, 'electron/mcp/adapterTulis'));
const { jalankanAlatTulis } = require(path.join(ROOT, 'electron/mcp/alatTulis'));
const { FsHost } = require(path.join(ROOT, 'electron/hosts/fsHost'));
const katalog = require(path.join(ROOT, 'electron/mcp/katalog'));

let k;
let s;
let host;
let dataDir;
let c;
const anak = new Set();

function klienStdio(dir) {
  const p = spawn(process.execPath, [path.join(ROOT, 'electron', 'mcp', 'stdio.js'), '--data', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  anak.add(p);
  p.on('exit', () => anak.delete(p));
  let buf = '';
  const tunggu = new Map();
  const notifikasi = [];
  p.stdout.on('data', (x) => {
    buf += x;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id === undefined) notifikasi.push(m.method);
      else if (tunggu.has(m.id)) tunggu.get(m.id)(m);
    }
  });
  let id = 0;
  const kirim = (method, params) => new Promise((r) => { const n = ++id; tunggu.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    kirim,
    alat: async (name, args) => {
      const r = await kirim('tools/call', { name, arguments: args });
      const t = r.result.content[0].text;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        j = t;
      }
      return { isError: r.result.isError, j, t };
    },
    notifikasi,
    tutup: () => new Promise((r) => { p.on('exit', r); p.stdin.end(); }),
  };
}

async function hitungSemuaTabel() {
  const d = await k.R('db').getDb();
  const out = {};
  for (const t of await d.getAllAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) out[t.name] = (await d.getFirstAsync(`SELECT COUNT(*) AS n FROM "${t.name}"`)).n;
  return out;
}
async function neraca() {
  const p = await k.R('laporan').getPosisiKeuangan(await k.R('db').getDb(), '2026-12-31');
  return p;
}
/** Pratinjau lalu konfirmasi (seperti Claude setelah pengguna setuju). */
async function pratinjauLaluSimpan(nama, args) {
  const p = await c.alat(nama, args);
  assert.equal(p.isError, false, `${nama} pratinjau: ${p.t}`);
  assert.equal(p.j.status, 'MENUNGGU_KONFIRMASI', p.t);
  assert.equal(p.j.belumDisimpan, true);
  const h = await c.alat(nama, Object.assign({}, args, { konfirmasi: p.j.konfirmasi }));
  assert.equal(h.isError, false, `${nama} simpan: ${h.t}`);
  assert.equal(h.j.status, 'BERHASIL', h.t);
  return h.j;
}

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  const bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  const tulis = pasangAdapterTulis(indeksTulis(path.join(ROOT, 'renderer')));
  const fsh = new FsHost({ data: k.dataDir, documents: path.join(k.dataDir, 'documents'), cache: path.join(k.dataDir, 'cache') });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-mcp-tulis-'));
  host = new McpHost({ dataDir, bridge, versi: '1.0.27', pastikanAdapter: async () => undefined, tulis, salinKeCache: (p) => fsh.copyIntoCache(p) });
  await host.atur({ aktif: true, penggunaId: s.users.admin });
  c = klienStdio(dataDir);
  await c.kirim('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
});
after(async () => {
  for (const p of anak) p.kill();
  await host.henti();
});

test('katalog: 16 alat ubah data, semuanya dua langkah (kecuali backup & opsi) dan bertanda destruktif', () => {
  assert.equal(katalog.ALAT_TULIS.length, 16);
  for (const a of katalog.untukMcp(katalog.ALAT_TULIS)) {
    const def = katalog.ALAT_TULIS.find((x) => x.name === a.name);
    if (def.baca) assert.equal(a.annotations.readOnlyHint, true);
    else assert.equal(a.annotations.destructiveHint, true, a.name);
    if (!def.baca && !def.tanpaKonfirmasi) assert.ok(a.inputSchema.properties.konfirmasi, `${a.name} punya konfirmasi`);
  }
  assert.match(katalog.PETUNJUK, /HANYA setelah pengguna menyetujui/);
});

test('bawaan MATI: alat ubah data tidak terdaftar & ditolak; hanya Admin yang dapat menyalakan', async () => {
  assert.equal(host.status().bolehTulis, false);
  const daftar = (await c.kirim('tools/list')).result.tools.map((t) => t.name);
  assert.ok(!daftar.includes('simpanan_setor'));
  const r = await c.alat('simpanan_setor', { anggota: 'A00001', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-01' });
  assert.equal(r.isError, true);
  assert.match(r.t, /TIDAK diizinkan/);
  await assert.rejects(host.atur({ bolehTulis: true, penggunaId: s.users.operator }), /izin ubah Pengaturan/);
  assert.equal(host.status().bolehTulis, false);
});

test('menyalakan ubah data → per anggota ikut ON, Claude diberi tahu daftar alat berubah', async () => {
  const st = await host.atur({ bolehTulis: true, penggunaId: s.users.admin });
  assert.equal(st.bolehTulis, true);
  assert.equal(st.perAnggota, true);
  await c.alat('status_kopku', {});
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(c.notifikasi.includes('notifications/tools/list_changed'), 'notifications/tools/list_changed dikirim');
  const daftar = (await c.kirim('tools/list')).result.tools.map((t) => t.name);
  for (const n of ['simpanan_setor', 'koreksi_transaksi', 'import_data_awal', 'buat_backup']) assert.ok(daftar.includes(n), n);
  assert.equal(daftar.length, 30);
});

test('pratinjau tidak menulis apa pun; kode wajib, sekali pakai, terikat argumen & data', async () => {
  const sebelum = await hitungSemuaTabel();
  const args = { anggota: 'A00001', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-01', periode: '2026-10' };
  const p1 = await c.alat('simpanan_setor', args);
  assert.equal(p1.j.status, 'MENUNGGU_KONFIRMASI');
  assert.match(p1.j.konfirmasi, /^K-[0-9A-F]{6}$/);
  assert.equal(p1.j.pratinjau.saldoSebelum, 'Rp50.000');
  assert.equal(p1.j.pratinjau.saldoSesudah, 'Rp100.000');
  assert.deepEqual(await hitungSemuaTabel(), sebelum, 'pratinjau tidak menulis');
  // kode palsu
  const palsu = await c.alat('simpanan_setor', Object.assign({}, args, { konfirmasi: 'K-000000' }));
  assert.equal(palsu.isError, true);
  // argumen berubah → pratinjau baru, tidak disimpan
  const beda = await c.alat('simpanan_setor', Object.assign({}, args, { nominal: 70000, konfirmasi: p1.j.konfirmasi }));
  assert.equal(beda.j.status, 'PRATINJAU_BERUBAH');
  assert.deepEqual(await hitungSemuaTabel(), sebelum);
  // kode untuk alat lain ditolak
  const p2 = await c.alat('simpanan_setor', args);
  const salahAlat = await c.alat('simpanan_tarik', { anggota: 'A00001', nominal: 1000, tanggal: '2026-10-01', konfirmasi: p2.j.konfirmasi });
  assert.equal(salahAlat.isError, true);
  // data KOPKU berubah setelah pratinjau (setoran lain dicatat di layar) → pratinjau baru
  const p3 = await c.alat('simpanan_setor', args);
  await k.R('simpanan').setorSimpanan({ anggotaId: s.anggota[0], jenis: 'WAJIB', tanggal: '2026-09-01', periode: '2026-09', nominal: 50000, sumberDana: 'KAS', createdBy: s.users.admin });
  const basi = await c.alat('simpanan_setor', Object.assign({}, args, { konfirmasi: p3.j.konfirmasi }));
  assert.equal(basi.j.status, 'PRATINJAU_BERUBAH', 'saldo berubah sejak pratinjau');
  assert.equal(basi.j.pratinjau.saldoSebelum, 'Rp100.000');
  // konfirmasi yang benar → tersimpan; kode tidak dapat dipakai ulang
  const ok = await c.alat('simpanan_setor', Object.assign({}, args, { konfirmasi: basi.j.konfirmasi }));
  assert.equal(ok.j.status, 'BERHASIL', ok.t);
  assert.match(ok.j.hasil.nomorTransaksi, /^SP-WAJIB-2026-/);
  const ulang = await c.alat('simpanan_setor', Object.assign({}, args, { konfirmasi: basi.j.konfirmasi }));
  assert.equal(ulang.isError, true, 'kode sekali pakai');
  const saldo = await k.R('simpanan').getRingkasanSaldoSimpananAnggota(s.anggota[0]);
  assert.equal(saldo.wajib, 150000);
});

test('backup otomatis dibuat sebelum perubahan pertama', async () => {
  const log = fs.readFileSync(path.join(dataDir, 'mcp', 'pemakaian.log'), 'utf8');
  assert.match(log, /\(backup otomatis\)\tBERHASIL/);
  const daftar = await k.R('backup') ? null : null; // modul backup tidak diindeks kopkuHeadless.R → periksa lewat berkas
  void daftar;
  const dirBackup = path.join(k.dataDir, 'documents', 'backups');
  assert.ok(fs.existsSync(dirBackup) && fs.readdirSync(dirBackup).some((f) => /\.kdb$/.test(f)), 'berkas backup .kdb ada');
  const b = await c.alat('buat_backup', {});
  assert.equal(b.j.status, 'BERHASIL');
  assert.match(b.j.hasil.berkas, /\.kdb$/);
});

test('alat ubah data: anggota, simpanan, pinjaman, angsuran, pelunasan, kas — hasil sama dengan service, neraca seimbang', async () => {
  const a = await pratinjauLaluSimpan('anggota_tambah', { nama_lengkap: 'Dewi Lestari', tanggal_bergabung: '2026-10-01', nik: '3201010101990002', nomor_hp: '081200001111', jenis_kelamin: 'PEREMPUAN' });
  assert.match(a.hasil.nomorAnggota, /^A\d+/);
  assert.deepEqual(a.ringkasan.dataPribadiDiisi, ['NIK', 'Nomor HP']);
  assert.doesNotMatch(JSON.stringify(a), /3201010101990002|081200001111/, 'data pribadi tidak dikembalikan ke Claude');
  const nomorBaru = a.hasil.nomorAnggota;
  const u = await pratinjauLaluSimpan('anggota_ubah', { anggota: nomorBaru, perubahan: { pekerjaan: 'Guru', alamat: 'Jl. Melati 1' } });
  assert.deepEqual(u.ringkasan.perubahan[0], { kolom: 'Pekerjaan', sebelum: '', sesudah: 'Guru' });
  const ag = (await k.R('anggota').listAnggota({ search: nomorBaru }))[0];
  assert.equal(ag.pekerjaan, 'Guru');
  assert.equal(ag.alamat, 'Jl. Melati 1');
  assert.equal(ag.nik, '3201010101990002', 'kolom lain tidak terhapus');
  await pratinjauLaluSimpan('simpanan_setor', { anggota: nomorBaru, jenis: 'POKOK', nominal: 100000, tanggal: '2026-10-02' });
  await pratinjauLaluSimpan('simpanan_setor', { anggota: nomorBaru, jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-02', periode: '2026-10' });
  await pratinjauLaluSimpan('simpanan_setor', { anggota: nomorBaru, jenis: 'SUKARELA', nominal: 3000000, tanggal: '2026-10-02' });
  const tarikLebih = await c.alat('simpanan_tarik', { anggota: nomorBaru, nominal: 9000000, tanggal: '2026-10-03' });
  assert.equal(tarikLebih.isError, true);
  assert.match(tarikLebih.t, /hanya Rp3\.000\.000/);
  await pratinjauLaluSimpan('simpanan_tarik', { anggota: nomorBaru, nominal: 500000, tanggal: '2026-10-03' });
  const saldo = await k.R('simpanan').getRingkasanSaldoSimpananAnggota(ag.id);
  assert.deepEqual([saldo.pokok, saldo.wajib, saldo.sukarela], [100000, 50000, 2500000]);
  // pinjaman: ajukan → batalkan; ajukan → cairkan → bayar → lunasi
  const pj1 = await pratinjauLaluSimpan('pinjaman_ajukan', { anggota: 'A00002', tanggal: '2026-10-03', jumlah: 2000000, tenor: 4, metode_jasa: 'FLAT', persentase_jasa: 1.5 });
  assert.equal(pj1.ringkasan.simulasi.totalDibayar, 'Rp2.120.000');
  const pinj1 = (await k.R('pinjaman').listPinjaman({ anggotaId: s.anggota[1], limit: 50, offset: 0 })).find((x) => x.status === 'DIAJUKAN');
  await pratinjauLaluSimpan('pinjaman_batalkan', { pinjaman: pinj1.nomorPinjaman, alasan: 'anggota membatalkan pengajuan' });
  assert.equal((await k.R('pinjaman').getPinjamanDetail(pinj1.id)).status, 'DITOLAK');
  await pratinjauLaluSimpan('pinjaman_ajukan', { anggota: 'A00002', tanggal: '2026-10-04', jumlah: 3000000, tenor: 3, metode_jasa: 'FLAT', persentase_jasa: 1 });
  const pinj2 = (await k.R('pinjaman').listPinjaman({ anggotaId: s.anggota[1], limit: 50, offset: 0 })).find((x) => x.status === 'DIAJUKAN');
  await pratinjauLaluSimpan('pinjaman_cairkan', { pinjaman: pinj2.nomorPinjaman, tanggal: '2026-10-04' });
  assert.equal((await k.R('pinjaman').getPinjamanDetail(pinj2.id)).status, 'AKTIF');
  const bayar = await pratinjauLaluSimpan('angsuran_bayar', { pinjaman: pinj2.nomorPinjaman, nominal: 1030000, tanggal: '2026-10-10' });
  assert.equal(bayar.ringkasan.angsuranKe, 1);
  const jadwal = await k.R('pinjaman').getJadwalAngsuran(pinj2.id);
  assert.equal(jadwal[0].status, 'LUNAS');
  const lunas = await pratinjauLaluSimpan('pinjaman_lunasi', { pinjaman: pinj2.nomorPinjaman, tanggal: '2026-10-12' });
  assert.match(lunas.ringkasan.totalPelunasan, /^Rp/);
  assert.equal((await k.R('pinjaman').getPinjamanDetail(pinj2.id)).status, 'LUNAS');
  // kas & bank
  const opsi = await c.alat('opsi_transaksi', {});
  assert.ok(opsi.j.hasil.akunPendapatan.some((x) => x.kode === '4-1500'));
  await pratinjauLaluSimpan('kas_masuk', { akun_pendapatan: '4-1500', nominal: 250000, tanggal: '2026-10-05', keterangan: 'bunga bank' });
  const beban = opsi.j.hasil.kategoriBeban[0].kategori;
  await pratinjauLaluSimpan('kas_keluar', { kategori_beban: beban, nominal: 75000, tanggal: '2026-10-05', keterangan: 'uji beban' });
  const p = await neraca();
  assert.equal(p.isBalanced, true);
  assert.equal(p.selisih, 0);
});

test('koreksi = jurnal pembalik (tidak ada yang dihapus): setoran, angsuran + bayar ulang, pencairan + cairkan ulang, kas', async () => {
  const d = await k.R('db').getDb();
  const jumlahJurnal = async () => (await d.getFirstAsync('SELECT COUNT(*) n FROM journal')).n;
  // setoran simpanan biasa
  const setor = await pratinjauLaluSimpan('simpanan_setor', { anggota: 'A00003', jenis: 'SUKARELA', nominal: 123000, tanggal: '2026-10-06' });
  const nomor = setor.hasil.nomorTransaksi;
  const j0 = await jumlahJurnal();
  const saldo0 = (await k.R('simpanan').getRingkasanSaldoSimpananAnggota(s.anggota[2])).sukarela;
  const kr = await pratinjauLaluSimpan('koreksi_transaksi', { transaksi: nomor, alasan: 'nominal setoran salah ketik' });
  assert.match(kr.ringkasan.caraKoreksi, /TETAP tercatat/);
  assert.equal(await jumlahJurnal(), j0 + 1, 'jurnal pembalik ditambahkan, tidak ada yang dihapus');
  assert.equal((await k.R('simpanan').getRingkasanSaldoSimpananAnggota(s.anggota[2])).sukarela, saldo0 - 123000);
  const lagi = await c.alat('koreksi_transaksi', { transaksi: nomor, alasan: 'dua kali' });
  assert.equal(lagi.isError, true, 'tidak dapat dikoreksi dua kali');
  // angsuran → koreksi + bayar ulang dengan nominal benar
  await pratinjauLaluSimpan('angsuran_bayar', { pinjaman: 'PJ-2026-000003', nominal: 1090000, tanggal: '2026-10-07' });
  const riwayat = (await c.alat('riwayat_transaksi', { cari: 'PJ-2026-000003', batas: 10 })).j.transaksi;
  const angs = riwayat.find((x) => /Angsuran/i.test(x.jenis));
  assert.ok(angs, JSON.stringify(riwayat));
  const ka = await pratinjauLaluSimpan('koreksi_transaksi', { transaksi: angs.nomor, alasan: 'tanggal bayar keliru', catat_ulang: { tanggal: '2026-10-08', nominal: 1090000 } });
  assert.match(ka.ringkasan.aksi, /catat ulang/);
  const jd = await k.R('pinjaman').getJadwalAngsuran((await k.R('pinjaman').listPinjaman({ search: 'PJ-2026-000003', limit: 5, offset: 0 }))[0].id);
  // Dibayar ulang lewat service angsuran: denda keterlambatan (data uji Rp5.000) dialokasikan lebih dulu → SEBAGIAN.
  assert.ok(['LUNAS', 'SEBAGIAN'].includes(jd[0].status) && Number(jd[0].pokokTerbayar) + Number(jd[0].jasaTerbayar) > 0, `dibayar ulang (${jd[0].status})`);
  // pencairan → koreksi tanpa catat ulang mengembalikan pinjaman ke DISETUJUI
  const pinj4 = (await k.R('pinjaman').listPinjaman({ search: 'PJ-2026-000004', limit: 5, offset: 0 }))[0];
  await pratinjauLaluSimpan('koreksi_transaksi', { transaksi: 'PJ-2026-000004', alasan: 'pencairan tercatat ganda', catat_ulang: { tanggal: '2026-07-16' } });
  assert.equal((await k.R('pinjaman').getPinjamanDetail(pinj4.id)).status, 'AKTIF', 'dicairkan ulang');
  // kas keluar → koreksi
  const kk = await pratinjauLaluSimpan('kas_keluar', { kategori_beban: (await c.alat('opsi_transaksi', {})).j.hasil.kategoriBeban[0].kategori, nominal: 99000, tanggal: '2026-10-09' });
  void kk;
  const kasRiwayat = (await c.alat('riwayat_transaksi', { batas: 100 })).j.transaksi.find((x) => x.nominal === 99000);
  await pratinjauLaluSimpan('koreksi_transaksi', { transaksi: kasRiwayat.nomor, alasan: 'beban salah kategori' });
  const p = await neraca();
  assert.equal(p.isBalanced, true);
  const pembalik = (await d.getFirstAsync('SELECT COUNT(*) n FROM journal WHERE reversal_of_id IS NOT NULL')).n;
  assert.ok(pembalik >= 4, `jurnal pembalik tercatat (${pembalik})`);
});

test('import Data Awal: berkas BLOKIR tidak dapat diimpor; berkas sah terimpor; impor ulang dilewati', async () => {
  const blokir = await c.alat('import_data_awal', { berkas: path.join(ROOT, 'docs', 'Contoh-Terisi-Template-Saldo-Lama.xlsx'), sifat: 'SALDO_LAMA', cut_off: '2026-07-01' });
  assert.equal(blokir.j.status, 'TIDAK_DAPAT_DIPROSES');
  assert.equal(blokir.j.konfirmasi, undefined, 'tidak ada kode konfirmasi untuk berkas yang terblokir');
  assert.ok(blokir.j.pratinjau.peringatan.some((x) => x.tingkat === 'BLOKIR' && /Berjangka/.test(x.judul)));
  const tanpaCutoff = await c.alat('import_data_awal', { berkas: path.join(ROOT, 'test', 'mcp', 'fixtures', 'data-awal-tanpa-berjangka.xlsx'), sifat: 'SALDO_LAMA' });
  assert.equal(tanpaCutoff.isError, true);
  assert.equal((await c.alat('import_data_awal', { berkas: 'relatif.xlsx', sifat: 'SALDO_LAMA', cut_off: '2026-07-01' })).isError, true);
  const anggotaSebelum = (await k.R('anggota').listAnggota({ semuaData: true })).length;
  const args = { berkas: path.join(ROOT, 'test', 'mcp', 'fixtures', 'data-awal-tanpa-berjangka.xlsx'), sifat: 'SALDO_LAMA', cut_off: '2026-07-01' };
  const h = await pratinjauLaluSimpan('import_data_awal', args);
  assert.equal(h.ringkasan.siapDiimpor, true);
  assert.equal(h.hasil.totalGagal, 0, JSON.stringify(h.hasil.gagal));
  assert.ok(h.hasil.totalBerhasil >= 8, JSON.stringify(h.hasil));
  assert.equal((await k.R('anggota').listAnggota({ semuaData: true })).length, anggotaSebelum + 2);
  // berkas yang sama lagi → pratinjau menolak / melewati (pencegahan impor ganda KOPKU)
  const ulang = await c.alat('import_data_awal', args);
  assert.ok(ulang.j.status === 'TIDAK_DAPAT_DIPROSES' || (ulang.j.pratinjau && ulang.j.pratinjau.peringatan.some((x) => /sudah pernah diimpor/i.test(x.judul + x.pesan))), ulang.t.slice(0, 400));
  assert.equal((await neraca()).isBalanced, true);
});

test('izin Permission Matrix per aksi & log perubahan', async () => {
  const k2 = { info: { pengguna: 'Uji' }, bolehAksi: async (r, a) => !(r === 'simpanan' && a === 'create') };
  const r = await jalankanAlatTulis('simpanan_setor', { anggota: 'A00001', jenis: 'WAJIB', nominal: 1, tanggal: '2026-10-01' }, k2, new Map());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /tidak punya izin create pada simpanan/);
  const log = fs.readFileSync(path.join(dataDir, 'mcp', 'pemakaian.log'), 'utf8');
  assert.match(log, /simpanan_setor\tBERHASIL\t\d+ms\tUBAH: Setor simpanan wajib Rp50\.000 · A00001/);
  assert.match(log, /koreksi_transaksi\tBERHASIL\t\d+ms\tUBAH: Koreksi/);
  assert.doesNotMatch(log, /3201010101990002|081200001111|Jl\. Melati/, 'log tanpa data pribadi');
  assert.ok(host.status().pemakaian.perubahan >= 15);
});

test('mematikan per anggota ikut mematikan ubah data; kode konfirmasi lama tidak berlaku', async () => {
  const p = await c.alat('simpanan_setor', { anggota: 'A00001', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-11' });
  await host.atur({ perAnggota: false, penggunaId: s.users.admin });
  assert.equal(host.status().bolehTulis, false);
  const r = await c.alat('simpanan_setor', { anggota: 'A00001', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-11', konfirmasi: p.j.konfirmasi });
  assert.equal(r.isError, true);
  await host.atur({ bolehTulis: true, penggunaId: s.users.admin });
  const r2 = await c.alat('simpanan_setor', { anggota: 'A00001', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-11', konfirmasi: p.j.konfirmasi });
  assert.equal(r2.isError, true, 'kode dihapus saat ubah data dimatikan');
  await c.tutup();
});
