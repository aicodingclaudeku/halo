'use strict';
/**
 * Menu LAN lengkap (LAN-WhatsApp3): setiap endpoint baru mengikuti Permission
 * Matrix KOPKU. Harapan dihitung dari DEFAULT_ROLE_PERMISSIONS (konstanta di
 * bundle, sumber terpisah dari hasPermission yang dipakai server) — dan untuk
 * profil Pengawas: hanya `view` pada resource baca.
 * (proses terpisah: satu DB per proses)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { siapkan, Klien, beriAkses, PASSWORD } = require('./kit');

let K;
const c = {};
let DEF;
const PENGAWAS_BACA = new Set(['anggota', 'simpanan', 'pinjaman', 'laporan', 'shu', 'history_transaksi']);
const ROLE = { admin: 'ADMIN', pengurus: 'PENGURUS', bendahara: 'BENDAHARA', operator: 'PETUGAS', pengawas: 'PENGURUS' };
const KUNCI = { view: 'canView', create: 'canCreate', edit: 'canEdit', approve: 'canApprove', export: 'canExport' };
function harap(user, res, act) {
  if (user === 'pengawas' && (act !== 'view' || !PENGAWAS_BACA.has(res))) return false;
  return !!DEF[ROLE[user]][res][KUNCI[act]];
}

before(async () => {
  K = await siapkan();
  DEF = K.k.R('izinKonstanta').DEFAULT_ROLE_PERMISSIONS;
  for (const u of ['pengurus', 'bendahara', 'operator']) await beriAkses(K.base, K.s.users[u]);
  await beriAkses(K.base, K.s.users.pengawas, 'PENGAWAS');
  for (const u of Object.keys(ROLE)) {
    c[u] = new Klien(K.base);
    const l = await c[u].login(u, PASSWORD[u]);
    assert.equal(l.status, 200, `${u} login ${JSON.stringify(l.body)}`);
  }
});
after(async () => {
  await K.srv.henti();
});

test('sesi: peta izin = Permission Matrix existing (Pengawas dipersempit ke baca)', async () => {
  for (const u of Object.keys(ROLE)) {
    const s = await c[u].req('GET', '/api/auth/sesi');
    assert.equal(s.status, 200);
    const iz = s.body.data.izin;
    assert.equal(Object.keys(iz).length, 12, 'semua 12 resource');
    for (const [res, aksi] of Object.entries(iz)) for (const [act, v] of Object.entries(aksi)) assert.equal(v, harap(u, res, act), `${u} ${res}.${act}`);
  }
});

test('RBAC server-side: semua endpoint baru × 5 peran mengikuti matriks', async () => {
  const pid = K.s.pinjaman[0];
  const aid = K.s.anggota[0];
  // [method, path, resource, action]; badan kosong → diizinkan = 4xx validasi (bukan 403), ditolak = 403
  const E = [
    ['GET', '/api/simpanan', 'simpanan', 'view'],
    ['GET', '/api/simpanan/saldo', 'simpanan', 'view'],
    ['GET', `/api/simpanan?anggotaId=${aid}`, 'simpanan', 'view'],
    ['GET', '/api/simpanan/sukarela-tersedia', 'simpanan', 'create'],
    ['POST', '/api/simpanan/tarik', 'simpanan', 'create'],
    ['GET', '/api/simpanan-berjangka', 'simpanan', 'view'],
    ['GET', '/api/pinjaman-simulasi?jumlah=1000000&tenor=3&jasa=1.5&metode=FLAT', 'pinjaman', 'view'],
    ['POST', '/api/pinjaman', 'pinjaman', 'create'],
    ['POST', `/api/pinjaman/${pid}/cairkan`, 'pinjaman', 'approve'],
    ['POST', `/api/pinjaman/${pid}/batalkan`, 'pinjaman', 'edit'],
    ['GET', '/api/kas/rekening', 'kas_bank', 'view'],
    ['GET', '/api/kas/riwayat', 'kas_bank', 'view'],
    ['GET', '/api/kas/opsi', 'kas_bank', 'create'],
    ['POST', '/api/kas/masuk', 'kas_bank', 'create'],
    ['POST', '/api/kas/keluar', 'kas_bank', 'create'],
    ['POST', '/api/kas/transfer', 'kas_bank', 'edit'],
    ['GET', '/api/akun', 'pengaturan', 'view'],
    ['GET', '/api/personel', 'anggota', 'view'],
    ['GET', '/api/laporan/laba-rugi?mulai=2026-01-01&selesai=2026-12-31', 'laporan', 'view'],
    ['GET', '/api/laporan/arus-kas?mulai=2026-01-01&selesai=2026-12-31', 'laporan', 'view'],
    ['GET', '/api/laporan/perubahan-ekuitas?mulai=2026-01-01&selesai=2026-12-31', 'laporan', 'view'],
    ['GET', '/api/laporan/neraca-saldo?tanggal=2026-12-31', 'laporan', 'view'],
    ['GET', '/api/laporan/akun', 'laporan', 'view'],
    ['GET', '/api/laporan/kolektibilitas', 'pinjaman', 'view'],
    ['GET', '/api/history', 'history_transaksi', 'view'],
    ['GET', '/api/history/jenis', 'history_transaksi', 'view'],
    ['GET', '/api/shu', 'shu', 'view'],
    ['GET', '/api/admin/izin', 'user_management', 'view'],
  ];
  let diperiksa = 0;
  for (const u of Object.keys(ROLE)) {
    for (const [m, p, res, act] of E) {
      const r = await c[u].req(m, p, m === 'GET' ? null : {});
      const boleh = harap(u, res, act);
      if (boleh) assert.notEqual(r.status, 403, `${u} ${m} ${p} seharusnya diizinkan (${JSON.stringify(r.body)})`);
      else assert.equal(r.status, 403, `${u} ${m} ${p} seharusnya ditolak, dapat ${r.status}`);
      if (boleh && m === 'GET') assert.equal(r.status, 200, `${u} ${m} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
      diperiksa++;
    }
  }
  assert.ok(diperiksa >= 140);
});

test('dashboard: bagian hanya diisi sesuai izin lihat', async () => {
  for (const u of Object.keys(ROLE)) {
    const d = await c[u].req('GET', '/api/dashboard');
    assert.equal(d.status, 200);
    const x = d.body.data;
    assert.equal(x.anggotaAktif !== undefined, harap(u, 'anggota', 'view'), `${u} anggota`);
    assert.equal(!!x.simpanan, harap(u, 'simpanan', 'view'), `${u} simpanan`);
    assert.equal(!!x.pinjaman, harap(u, 'pinjaman', 'view'), `${u} pinjaman`);
    assert.equal(!!x.rekening, harap(u, 'kas_bank', 'view'), `${u} kas`);
    assert.equal(!!x.transaksiTerakhir, harap(u, 'history_transaksi', 'view'), `${u} history`);
  }
  const a = (await c.admin.req('GET', '/api/dashboard')).body.data;
  assert.equal(a.anggotaAktif, 4);
  assert.equal(a.pinjaman.aktif, 4);
  assert.equal(a.simpanan.total, 4 * 20150000);
});

test('transaksi harian lewat LAN: tarik, kas masuk/keluar, transfer, ajukan → simulasi = jadwal, cairkan, batalkan', async () => {
  const a = c.admin;
  const aid = K.s.anggota[1];
  // tarik melebihi saldo → aturan bisnis service
  const lebih = await a.req('POST', '/api/simpanan/tarik', { anggotaId: aid, tanggal: '2026-09-01', nominal: 99000000, sumberDana: 'KAS' });
  assert.equal(lebih.status, 422);
  assert.match(lebih.body.pesan, /tidak cukup/);
  const t = await a.req('POST', '/api/simpanan/tarik', { anggotaId: aid, tanggal: '2026-09-01', nominal: 500000, sumberDana: 'KAS', keterangan: 'uji' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.data.nomorTransaksi, /^ST-TARIK-/);
  const saldo = (await a.req('GET', '/api/simpanan/saldo?cari=Uji 2')).body.data[0];
  assert.equal(saldo.sukarela, 20000000 - 500000);

  const opsi = (await a.req('GET', '/api/kas/opsi')).body.data;
  assert.ok(opsi.pendapatan.length > 0 && opsi.beban.length > 0);
  const masuk = await a.req('POST', '/api/kas/masuk', { jenis: 'KAS', accountId: opsi.pendapatan[0].accountId, tanggal: '2026-09-02', nominal: 125000, keterangan: 'uji' });
  assert.equal(masuk.status, 200, JSON.stringify(masuk.body));
  const akunLain = (await a.req('GET', '/api/akun?cari=1-1200')).body.data[0];
  const salahAkun = await a.req('POST', '/api/kas/masuk', { jenis: 'KAS', accountId: akunLain.id, tanggal: '2026-09-02', nominal: 1000 });
  assert.equal(salahAkun.status, 422, 'akun piutang tidak boleh dipakai sebagai pendapatan lain');
  const keluar = await a.req('POST', '/api/kas/keluar', { jenis: 'KAS', kategoriKey: opsi.beban[0].key, tanggal: '2026-09-03', nominal: 40000 });
  assert.equal(keluar.status, 200, JSON.stringify(keluar.body));
  const kategoriPalsu = await a.req('POST', '/api/kas/keluar', { jenis: 'KAS', kategoriKey: 'kat:Akun Rekaan', tanggal: '2026-09-03', nominal: 40000 });
  assert.equal(kategoriPalsu.status, 422);
  const tfSama = await a.req('POST', '/api/kas/transfer', { sumberJenis: 'KAS', tujuanJenis: 'KAS', tanggal: '2026-09-04', nominal: 1000 });
  assert.equal(tfSama.status, 422);
  const riwayat = (await a.req('GET', '/api/kas/riwayat')).body.data.baris;
  assert.ok(riwayat.some((r) => r.nominal === 125000) && riwayat.some((r) => r.nominal === 40000));

  // ajukan: simulasi dari server = jadwal yang dibuat service
  const sim = await a.req('GET', '/api/pinjaman-simulasi?jumlah=2400000&tenor=4&jasa=1.5&metode=EFEKTIF');
  assert.equal(sim.status, 200);
  const aj = await a.req('POST', '/api/pinjaman', { anggotaId: aid, tanggal: '2026-09-05', jumlahPinjaman: 2400000, tenor: 4, satuanTenor: 'BULAN', metodeJasa: 'EFEKTIF', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', dendaAktif: false });
  assert.equal(aj.status, 200, JSON.stringify(aj.body));
  const det = (await a.req('GET', `/api/pinjaman/${aj.body.data.id}`)).body.data;
  assert.equal(det.pinjaman.status, 'DIAJUKAN');
  assert.deepEqual(det.jadwal.map((j) => [j.pokok, j.jasa]), sim.body.data.map((j) => [j.pokok, j.jasa]), 'simulasi LAN = jadwal service');
  assert.equal((await a.req('POST', '/api/pinjaman', { anggotaId: aid, tanggal: '2026-09-05', jumlahPinjaman: 1000000, tenor: 2, satuanTenor: 'BULAN', metodeJasa: 'CUSTOM', persentaseJasa: 1 })).status, 422, 'metode CUSTOM hanya di desktop');
  // operator: pinjaman.approve? (mengikuti matriks)
  const opCair = await c.operator.req('POST', `/api/pinjaman/${aj.body.data.id}/cairkan`, { tanggalPencairan: '2026-09-06', sumberDana: 'KAS' });
  assert.equal(opCair.status === 403, !harap('operator', 'pinjaman', 'approve'));
  if (opCair.status !== 200) {
    const cair = await a.req('POST', `/api/pinjaman/${aj.body.data.id}/cairkan`, { tanggalPencairan: '2026-09-06', sumberDana: 'KAS' });
    assert.equal(cair.status, 200, JSON.stringify(cair.body));
  }
  const lagi = await a.req('POST', `/api/pinjaman/${aj.body.data.id}/cairkan`, { tanggalPencairan: '2026-09-06', sumberDana: 'KAS' });
  assert.equal(lagi.status, 422, 'tidak bisa dicairkan dua kali');
  assert.equal((await a.req('GET', `/api/pinjaman/${aj.body.data.id}`)).body.data.pinjaman.status, 'AKTIF');
  const aj2 = await a.req('POST', '/api/pinjaman', { anggotaId: aid, tanggal: '2026-09-07', jumlahPinjaman: 500000, tenor: 2, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1, biayaAdminTipe: 'TIDAK_ADA' });
  assert.equal((await a.req('POST', `/api/pinjaman/${aj2.body.data.id}/batalkan`, {})).status, 422, 'alasan wajib');
  assert.equal((await a.req('POST', `/api/pinjaman/${aj2.body.data.id}/batalkan`, { alasan: 'uji' })).status, 200);
  assert.equal((await a.req('GET', `/api/pinjaman/${aj2.body.data.id}`)).body.data.pinjaman.status, 'DITOLAK');

  // laporan & history membaca transaksi di atas
  const tb = (await a.req('GET', '/api/laporan/neraca-saldo?tanggal=2026-12-31')).body.data;
  assert.equal(tb.isBalanced, true);
  const lr = (await a.req('GET', '/api/laporan/laba-rugi?mulai=2026-01-01&selesai=2026-12-31')).body.data;
  assert.ok(lr.totalPendapatan >= 125000 && lr.totalBeban >= 40000);
  const kas = (await a.req('GET', '/api/laporan/akun')).body.data.find((x) => x.kode === '1-1000');
  const bb = (await a.req('GET', `/api/laporan/buku-besar?akun=${kas.id}&mulai=2026-01-01&selesai=2026-12-31`)).body.data;
  assert.equal(bb.akun.kode, '1-1000');
  assert.ok(bb.baris.length > 5);
  const hist = (await a.req('GET', '/api/history?cari=ST-TARIK')).body.data.baris;
  assert.equal(hist.length, 1);
  const hd = (await a.req('GET', `/api/history/${hist[0].journalId}`)).body.data;
  assert.ok(hd.lines.length >= 2, 'detail jurnal berisi baris');
  assert.equal(hd.lines.reduce((t, l) => t + l.debit, 0), hd.lines.reduce((t, l) => t + l.kredit, 0), 'jurnal seimbang');
  const kol = (await a.req('GET', '/api/laporan/kolektibilitas')).body.data;
  assert.ok(kol.ringkasan.length >= 4 && kol.rincian.length >= 5);
  const audit = (await a.req('GET', '/api/admin/audit')).body.data.baris.map((r) => r.action);
  for (const x of ['SIMPANAN_TARIK', 'KAS_MASUK', 'KAS_KELUAR', 'PINJAMAN_AJUKAN', 'PINJAMAN_CAIR', 'PINJAMAN_BATAL']) assert.ok(audit.includes(x), `audit ${x}`);
});

test('klik ganda (Idempotency-Key sama) pada transaksi baru → satu transaksi', async () => {
  const a = c.admin;
  const body = { anggotaId: K.s.anggota[2], tanggal: '2026-09-08', nominal: 100000, sumberDana: 'KAS' };
  const h = { 'Idempotency-Key': 'uji-tarik-ganda-0001' };
  const [r1, r2] = await Promise.all([a.req('POST', '/api/simpanan/tarik', body, h), a.req('POST', '/api/simpanan/tarik', body, h)]);
  // yang kedua: 409 SEDANG_DIPROSES (bila bersamaan) atau replay 200 (bila yang pertama sudah selesai)
  assert.ok([r1.status, r2.status].includes(200) && [r1.status, r2.status].every((x) => x === 200 || x === 409), `${r1.status},${r2.status}`);
  if (r1.status === 200 && r2.status === 200) assert.deepEqual(r2.body.data, r1.body.data, 'replay identik');
  const r3 = await a.req('POST', '/api/simpanan/tarik', body, h);
  assert.equal(r3.status, 200, 'replay mengembalikan respons yang sama');
  const hist = (await a.req('GET', `/api/simpanan?anggotaId=${K.s.anggota[2]}`)).body.data.baris.filter((x) => x.tipe === 'TARIK');
  assert.equal(hist.length, 1);
});
