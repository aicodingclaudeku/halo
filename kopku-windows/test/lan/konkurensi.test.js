'use strict';
/**
 * Konkurensi multi-user, proteksi transaksi ganda, database terkunci,
 * restart server & browser reconnect — KOPKU ASLI + server LAN ASLI.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { siapkan, Klien, beriAkses, PASSWORD } = require('./kit');

let K;
let A; // admin
let B; // bendahara (client ke-2)
before(async () => {
  K = await siapkan();
  await beriAkses(K.base, K.s.users.bendahara);
  A = new Klien(K.base);
  B = new Klien(K.base);
  assert.equal((await A.login('admin', PASSWORD.admin)).status, 200);
  assert.equal((await B.login('bendahara', PASSWORD.bendahara)).status, 200);
});
after(async () => {
  await K.srv.henti();
});

const db = () => K.R_db();
async function jadwalPertamaTertagih(pinjamanId, c = A) {
  const r = await c.req('GET', `/api/pinjaman/${pinjamanId}`);
  return r.body.data.jadwal.find((j) => j.bisaDibayar);
}

test('dua client membaca data authoritative yang sama lewat API', async () => {
  const [a, b] = await Promise.all([A.req('GET', `/api/pinjaman/${K.s.pinjaman[0]}`), B.req('GET', `/api/pinjaman/${K.s.pinjaman[0]}`)]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.data, b.body.data);
});

test('dua client membayar angsuran yang SAMA bersamaan → hanya satu tercatat, lainnya KONFLIK', async () => {
  const pid = K.s.pinjaman[0];
  const j = await jadwalPertamaTertagih(pid);
  const sisa = j.total - j.pokokTerbayar - j.jasaTerbayar;
  const body = { tanggal: j.tanggalJatuhTempo, nominal: sisa, sumberDana: 'KAS', versiJadwal: j.versi };
  const [r1, r2] = await Promise.all([A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body), B.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body)]);
  const st = [r1.status, r2.status].sort();
  assert.deepEqual(st, [200, 409], JSON.stringify([r1.body, r2.body]));
  const kalah = r1.status === 409 ? r1 : r2;
  assert.equal(kalah.body.kode, 'KONFLIK');
  const d = await db();
  const n = await d.getFirstAsync('SELECT COUNT(*) n FROM angsuran_pembayaran WHERE jadwal_id = ?', j.id);
  assert.equal(n.n, 1);
  const row = await d.getFirstAsync('SELECT status FROM angsuran_jadwal WHERE id = ?', j.id);
  assert.equal(row.status, 'LUNAS');
});

test('Idempotency-Key sama (klik ganda / retry jaringan) → satu transaksi, respons identik', async () => {
  const pid = K.s.pinjaman[1];
  const j = await jadwalPertamaTertagih(pid);
  const body = { tanggal: j.tanggalJatuhTempo, nominal: 100000, sumberDana: 'KAS', versiJadwal: j.versi };
  const kunci = { 'Idempotency-Key': 'klikganda-0001-abcdef' };
  const [r1, r2] = await Promise.all([A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci), A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci)]);
  const ok = [r1, r2].filter((r) => r.status === 200);
  const lain = [r1, r2].filter((r) => r.status !== 200);
  assert.equal(ok.length, 1, JSON.stringify([r1.body, r2.body]));
  assert.equal(lain[0].status, 409);
  assert.equal(lain[0].body.kode, 'SEDANG_DIPROSES');
  const r3 = await A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci);
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.body, ok[0].body);
  const d = await db();
  assert.equal((await d.getFirstAsync('SELECT COUNT(*) n FROM angsuran_pembayaran WHERE jadwal_id = ?', j.id)).n, 1);
  // kunci yang sama untuk permintaan lain ditolak
  const r4 = await A.req('POST', '/api/anggota', { namaLengkap: 'Z', tanggalBergabung: '2026-09-01' }, kunci);
  assert.equal(r4.status, 409);
});

test('desktop + 2 client LAN bertransaksi bersamaan: semua atomik, tanpa galat transaksi bersarang, jurnal seimbang', async () => {
  const R = K.k.R;
  const tugas = [];
  const hasilDesktop = [];
  // Desktop (layar KOPKU di komputer server) memanggil service langsung, bersamaan dengan LAN.
  for (let i = 0; i < 6; i++) {
    tugas.push(R('anggota').createAnggota(K.s.users.admin, { namaLengkap: `Desktop ${i}`, tanggalBergabung: '2026-09-02', status: 'AKTIF' }).then((x) => hasilDesktop.push(x.id)));
    tugas.push(R('simpanan').setorSimpanan({ anggotaId: K.s.anggota[1], jenis: 'SUKARELA', tanggal: '2026-09-02', nominal: 1000 + i, sumberDana: 'KAS', createdBy: K.s.users.admin }));
  }
  const hasilLan = [];
  for (let i = 0; i < 6; i++) {
    const c = i % 2 ? A : B;
    tugas.push(c.req('POST', '/api/simpanan/setor', { anggotaId: K.s.anggota[2], jenis: 'SUKARELA', tanggal: '2026-09-03', nominal: 2000 + i, sumberDana: 'KAS' }).then((r) => hasilLan.push(r)));
    tugas.push(A.req('POST', '/api/anggota', { namaLengkap: `LAN ${i}`, tanggalBergabung: '2026-09-03' }).then((r) => hasilLan.push(r)));
  }
  const pid = K.s.pinjaman[2];
  const jad = (await A.req('GET', `/api/pinjaman/${pid}`)).body.data.jadwal.filter((j) => j.bisaDibayar).slice(0, 3);
  for (const j of jad) tugas.push(B.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, { tanggal: '2026-09-04', nominal: 50000, sumberDana: 'KAS', versiJadwal: j.versi }).then((r) => hasilLan.push(r)));
  const set = await Promise.allSettled(tugas);
  const gagal = set.filter((x) => x.status === 'rejected');
  assert.equal(gagal.length, 0, 'desktop gagal: ' + gagal.map((g) => g.reason && g.reason.message).join(' | '));
  for (const r of hasilLan) assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await db();
  const tb = await d.getFirstAsync("SELECT SUM(je.debit) d, SUM(je.kredit) k FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.status = 'POSTED'");
  assert.equal(tb.d, tb.k, 'jurnal harus seimbang');
  const tidakSeimbang = await d.getAllAsync('SELECT journal_id FROM journal_entry GROUP BY journal_id HAVING SUM(debit) <> SUM(kredit)');
  assert.equal(tidakSeimbang.length, 0);
  // Setiap pembayaran punya jurnal & setiap simpanan punya jurnal (atomik)
  assert.equal((await d.getFirstAsync('SELECT COUNT(*) n FROM angsuran_pembayaran WHERE journal_id IS NULL OR journal_id NOT IN (SELECT id FROM journal)')).n, 0);
  assert.equal((await d.getFirstAsync('SELECT COUNT(*) n FROM simpanan_transaksi WHERE journal_id IS NULL OR journal_id NOT IN (SELECT id FROM journal)')).n, 0);
  const nomor = await d.getAllAsync('SELECT nomor_anggota FROM anggota');
  assert.equal(new Set(nomor.map((x) => x.nomor_anggota)).size, nomor.length, 'nomor anggota unik');
});

test('KONTROL NEGATIF: tanpa mutex transaksi, dua transaksi bersamaan pada koneksi yang sama gagal', async () => {
  const Proto = K.k.R('sqliteShim').SQLiteDatabase.prototype;
  const denganMutex = Proto.withTransactionAsync;
  Proto.withTransactionAsync = Proto.__kopkuWithTransactionAsli; // perilaku sebelum modul LAN
  try {
    const R = K.k.R;
    const hasil = await Promise.allSettled([0, 1, 2, 3].map((i) => R('anggota').createAnggota(K.s.users.admin, { namaLengkap: `Kontrol ${i}`, tanggalBergabung: '2026-09-05', status: 'AKTIF' })));
    const gagal = hasil.filter((x) => x.status === 'rejected');
    assert.ok(gagal.length > 0, 'tanpa mutex seharusnya ada transaksi yang bertabrakan');
    assert.match(String(gagal[0].reason && gagal[0].reason.message), /transaction/i);
  } finally {
    Proto.withTransactionAsync = denganMutex;
    try {
      await (await db()).execAsync('ROLLBACK');
    } catch {
      /* tidak ada transaksi menggantung */
    }
  }
});

test('database dikunci proses lain → 503 DB_SIBUK tanpa detail internal; retry kunci yang sama sukses sekali', async () => {
  const pid = K.s.pinjaman[3];
  const j = await jadwalPertamaTertagih(pid);
  const lain = new DatabaseSync(K.k.dbFile);
  lain.exec('BEGIN IMMEDIATE');
  const body = { tanggal: '2026-09-10', nominal: 10000, sumberDana: 'KAS', versiJadwal: j.versi };
  const kunci = { 'Idempotency-Key': 'kunci-db-terkunci-001' };
  let r;
  try {
    r = await A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci);
  } finally {
    lain.exec('ROLLBACK');
    lain.close();
  }
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.kode, 'DB_SIBUK');
  assert.ok(!/SQLITE|locked|\.js/i.test(r.body.pesan.replace('dikunci', '')));
  const r2 = await A.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const d = await db();
  assert.equal((await d.getFirstAsync("SELECT COUNT(*) n FROM angsuran_pembayaran WHERE jadwal_id = ? AND tanggal = '2026-09-10'", j.id)).n, 1);
});

test('server offline → restart → browser reconnect: sesi tetap berlaku, retry dengan kunci yang sama tidak menggandakan', async () => {
  const pid = K.s.pinjaman[3];
  const j = await jadwalPertamaTertagih(pid);
  const body = { tanggal: '2026-09-11', nominal: 5000, sumberDana: 'KAS', versiJadwal: j.versi };
  const kunci = { 'Idempotency-Key': 'restart-kunci-0001' };
  const r1 = await B.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci);
  assert.equal(r1.status, 200);
  await K.srv.henti();
  await assert.rejects(fetch(K.base + '/api/health'), 'server harus offline');
  K.srv = K.buatServer();
  const st = await K.srv.mulai();
  assert.equal(st.server, 'ONLINE');
  const h = await B.req('GET', '/api/health');
  assert.equal(h.status, 200);
  const r2 = await B.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, body, kunci); // klien tidak sempat melihat respons pertama
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, r1.body);
  const d = await db();
  assert.equal((await d.getFirstAsync("SELECT COUNT(*) n FROM angsuran_pembayaran WHERE jadwal_id = ? AND tanggal = '2026-09-11'", j.id)).n, 1);
  assert.equal((await B.req('GET', '/api/anggota')).status, 200, 'sesi bertahan setelah restart');
});

test('KOPKU Desktop belum siap (adapter terputus) → 503 tanpa crash, pulih setelah siap', async () => {
  K.bridge.siap = false;
  K.srv.api._statusCache = null;
  const r = await A.req('GET', '/api/anggota');
  assert.equal(r.status, 503);
  const h = await new Klien(K.base).req('GET', '/api/health');
  assert.equal(h.body.data.database, 'NOT_READY');
  K.bridge.siap = true;
  K.srv.api._statusCache = null;
  assert.equal((await A.req('GET', '/api/anggota')).status, 200);
});

test('ubah anggota: konflik versi (dua pengguna mengedit bersamaan)', async () => {
  const id = K.s.anggota[3];
  const d1 = (await A.req('GET', `/api/anggota/${id}`)).body.data;
  const d2 = (await A.req('GET', `/api/anggota/${id}`)).body.data;
  const u1 = await A.req('PUT', `/api/anggota/${id}`, { versi: d1.versi, data: { namaLengkap: 'Anggota Uji 4', pekerjaan: 'Petani' } });
  assert.equal(u1.status, 200, JSON.stringify(u1.body));
  await new Promise((r) => setTimeout(r, 5));
  const u2 = await A.req('PUT', `/api/anggota/${id}`, { versi: d2.versi, data: { namaLengkap: 'Anggota Uji 4', pekerjaan: 'Nelayan' } });
  assert.equal(u2.status, 409);
  const akhir = (await A.req('GET', `/api/anggota/${id}`)).body.data.anggota;
  assert.equal(akhir.pekerjaan, 'Petani');
  assert.equal(akhir.nomorHp, '085700001111', 'kolom yang tidak dikirim tidak boleh terhapus');
});
