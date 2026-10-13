'use strict';
// Uji asap RC-S133.6 pada BUNDLE RENDERER TERTAMBAL (Chromium + jembatan desktop tiruan).
// SQLite = SqliteHost asli paket Windows (node:sqlite, berkas SQLite sungguhan di folder sementara).
// Bukan Electron: preload diganti emulator; lisensi/UI login tidak diuji di sini.
// Pemakaian: (1) sajikan renderer/ dengan header COOP/COEP, mis. `node test/sajikan-renderer.js renderer 8817`
//            (2) `node test/smoke-renderer-rc-s133.6-chromium.js <folder paket> 8817 hasil.json`
// Butuh paket `playwright` (Chromium). Keluar 0 bila semua pemeriksaan OK.
const path = require('path'), fs = require('fs'), os = require('os');
const { chromium } = (() => { try { return require('playwright'); } catch { return require(process.env.PLAYWRIGHT_PATH || 'playwright-core'); } })();
const WIN = process.argv[2], PORT = +process.argv[3], OUT = process.argv[4];
const { SqliteHost } = require(path.join(WIN, 'electron/hosts/sqliteHost.js'));
const { bangunIndeks } = require(path.join(WIN, 'electron/server/bundleIndex.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-smoke-'));
const host = new SqliteHost(path.join(tmp, 'SQLite'));
const secure = new Map();
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = []; pg.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await pg.exposeFunction('__kopkuCall', async (ch, args) => {
    try {
      const [a, c, d] = args;
      let v;
      if (ch === 'sqlite:open') v = host.open(a, undefined);
      else if (ch === 'sqlite:exec') v = host.exec(a, c);
      else if (ch === 'sqlite:run') v = host.run(a, c, d);
      else if (ch === 'sqlite:get') v = host.get(a, c, d);
      else if (ch === 'sqlite:all') v = host.all(a, c, d);
      else if (ch === 'sqlite:close') v = host.close(a);
      else if (ch === 'secure:get') v = secure.has(a) ? secure.get(a) : null;
      else if (ch === 'secure:set') { secure.set(a, c); v = null; }
      else if (ch === 'secure:remove') { secure.delete(a); v = null; }
      else v = null;
      return { ok: true, value: v === undefined ? null : v };
    } catch (e) { return { ok: false, error: { message: String(e && e.message || e), code: e && e.code } }; }
  });
  await pg.addInitScript(({ tmp }) => {
    const call = (ch, ...a) => window.__kopkuCall(ch, a).then((r) => { if (r.ok) return r.value; const e = new Error(r.error.message); e.code = r.error.code; throw e; });
    const tolak = () => { throw new Error('fs sinkron tidak diemulasi'); };
    const nol = async () => null;
    window.kopkuDesktop = {
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.15', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
      sqlite: { open: (n, d) => call('sqlite:open', n, d), exec: (i, s) => call('sqlite:exec', i, s), run: (i, s, p) => call('sqlite:run', i, s, p), get: (i, s, p) => call('sqlite:get', i, s, p), all: (i, s, p) => call('sqlite:all', i, s, p), close: (i) => call('sqlite:close', i) },
      fs: { uriToPath: (u) => String(u).replace('kopkufs://local', ''), pathToUri: (p) => 'kopkufs://local' + p, info: async () => ({ exists: false, isDirectory: false }), readString: nol, writeString: nol, remove: nol, move: nol, copy: nol, mkdir: nol, readDir: async () => [], statSync: () => ({ exists: false }), createSync: tolak, removeSync: tolak, openSync: tolak, readSync: tolak, writeSync: tolak, closeSync: tolak },
      secure: { get: (k) => call('secure:get', k), set: (k, v) => call('secure:set', k, v), remove: (k) => call('secure:remove', k) },
      print: { toPdf: nol, printHtml: nol, printFile: nol }, dialog: { openFiles: async () => [], saveFile: nol },
      shell: { openPath: nol, showItem: nol, openExternal: nol }, http: { fetch: async () => { throw new Error('offline'); } },
      auth: { canBiometric: async () => false, promptBiometric: async () => false },
      lan: { start: nol, info: nol, onRequest() {}, onPing() { return () => {}; } }, firewall: { status: nol, perbaiki: nol }, qr: { toDataUrl: nol },
      server: { onCall() {} }, lanWa: new Proxy({}, { get: () => nol }), app: { openDataFolder: nol, onMenu() { return () => {}; }, setTitle() {} },
    };
  }, { tmp });
  await pg.goto('http://localhost:' + PORT + '/');
  await pg.waitForTimeout(9000);
  const idx = bangunIndeks(path.join(WIN, 'renderer')).modul;
  const lap = JSON.parse(fs.readFileSync(path.join(WIN, 'docs/laporan-tambal-rc-s133.6.json'), 'utf8'));
  const ID = Object.fromEntries(lap.modul.map((m) => [path.basename(m.berkas).replace(/\.tsx?$/, ''), m.id]));
  const hasil = await pg.evaluate(async ({ idx, ID }) => {
    const R = (k) => __r(idx[k]); const M = (k) => __r(ID[k]);
    const cek = {}; const ok = (n, v, info) => { cek[n] = { ok: !!v, info }; };
    await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji RC-S133.6', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Admin', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const K = R('kasBank'); const FR = M('FinancialReports'); const P = M('ExcelDataAwalParser'); const I = M('EksekusiImportDataAwal');
    const acc = {}; for (const a of await db.getAllAsync('SELECT id, kode FROM account')) acc[a.kode] = a.id;
    // Modal kas & satu rekening bank aktif
    await K.catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 100000000, tanggal: '2025-01-01', createdBy: admin });
    const bank = await K.tambahRekeningBank({ namaBank: 'BRI', nomorRekening: '123', saldoAwal: 50000000, createdBy: admin, tanggalSaldoAwal: '2025-01-01' });
    // F-1: impor "Transaksi baru" dengan Sumber Dana BANK
    const berkas = P.parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi Uji', '2025-01-01']],
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'], ['K1', '2025-02-01', 100000, 50000, 250000, 'BANK']],
      PINJAMAN: [['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'], ['K1', '2025-03-01', 300000, 12, 'BULAN', 'FLAT', '1.5%', 'BANK']],
    });
    const h = await I.jalankanImportDataAwal(berkas, { createdBy: admin, namaBerkas: 'uji.xlsx' });
    ok('F-1 impor BANK (simpanan + pinjaman): 0 baris gagal', h.totalGagal === 0, JSON.stringify(h.gagal.map((g) => g.pesan)));
    const saldoBank = (await db.getFirstAsync('SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE je.account_id = ?', bank.accountId)).s;
    ok('F-1 kas masuk/keluar lewat akun rekening bank', saldoBank === 400000 - 300000, String(saldoBank));
    const besar = P.parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K2', 'Siti Uji', '2025-01-01']],
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'], ['K2', '2025-02-01', 100000, 50000, 0, 'KAS']],
      PINJAMAN: [['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'], ['K2', '2025-03-01', 90000000, 12, 'BULAN', 'FLAT', 1, 'BANK']],
    });
    const h2 = await I.jalankanImportDataAwal(besar, { createdBy: admin, namaBerkas: 'uji2.xlsx' });
    const st = await db.getAllAsync("SELECT p.status FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE a.nama_lengkap = 'Siti Uji'");
    ok('F-1b pencairan gagal (saldo tidak cukup) → pinjaman DITOLAK, bukan DIAJUKAN', h2.totalGagal === 1 && st.length === 1 && st[0].status === 'DITOLAK', JSON.stringify({ st, g: h2.gagal.map((g) => g.pesan) }));
    const pj = await db.getFirstAsync("SELECT p.persentase_jasa p FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE a.nama_lengkap = 'Budi Uji'");
    ok('B-2 teks "1.5%" → jasa 1,5', pj && Math.abs(pj.p - 1.5) < 1e-9, JSON.stringify(pj));
    // F-2: Arus Kas — sukarela = Operasi
    const ak = await FR.getArusKas(db, '2025-02-01', '2025-02-28');
    ok('F-2 arus kas Feb 2025: sukarela 250.000 di Operasi, pokok+wajib 2 anggota 300.000 di Pendanaan', ak.operasi === 250000 && ak.pendanaan === 300000 && ak.terekonsiliasi, JSON.stringify({ o: ak.operasi, p: ak.pendanaan }));
    // F-4: kesinambungan ekuitas 2025 → 2026
    await K.catatPemasukan({ jenis: 'KAS', tanggal: '2025-06-01', nominal: 5000000, akunLawanId: acc['4-3000'], kategori: 'Penghasilan Lain', keterangan: 'x', createdBy: admin });
    await K.catatPengeluaran({ jenis: 'KAS', tanggal: '2025-07-01', nominal: 1000000, akunLawanId: acc['5-1200'], kategori: 'Beban', keterangan: 'x', createdBy: admin });
    await K.catatPemasukan({ jenis: 'KAS', tanggal: '2026-02-01', nominal: 1000000, akunLawanId: acc['4-3000'], kategori: 'Penghasilan Lain', keterangan: 'y', createdBy: admin });
    const p25 = await FR.getPosisiKeuangan(db, '2025-12-31');
    const e26 = await FR.getPerubahanEkuitas(db, '2026-01-01', '2026-12-31');
    const p26 = await FR.getPosisiKeuangan(db, '2026-12-31');
    const lr26 = await FR.getLabaRugi(db, '2026-01-01', '2026-12-31');
    ok('F-4 saldo awal ekuitas 2026 = ekuitas Posisi Keuangan 31-12-2025', e26.totalSaldoAwal === p25.totalEkuitas, `${e26.totalSaldoAwal} vs ${p25.totalEkuitas}`);
    ok('F-4 hasil usaha periode 2026 = LHU 2026', e26.hasilUsahaPeriodeBerjalan === lr26.hasilUsaha, `${e26.hasilUsahaPeriodeBerjalan} vs ${lr26.hasilUsaha}`);
    ok('F-4 saldo akhir = Posisi Keuangan 31-12-2026', e26.totalSaldoAkhir === p26.totalEkuitas, `${e26.totalSaldoAkhir} vs ${p26.totalEkuitas}`);
    // B-3 & fungsi baru tersedia di bundle
    ok('B-3 parseBilanganHitungan("12,5") = 12,5 (bukan 125)', P.parseBilanganHitungan('12,5') === 12.5);
    ok('B-2 normalkanSelPersen tersedia', typeof P.normalkanSelPersen === 'function');
    ok('F-5 jadwal 31 Jan → 28 Feb', M('InstallmentDate').calculateInstallmentDate('2025-01-31', 1, 'BULAN') === '2025-02-28');
    // Ekspor tabel memakai saldo awal SHU
    const ex = M('ReportTableBuilders').buildPerubahanEkuitasExport({ namaKoperasi: 'Uji', standarAkuntansi: 'SAK EP' }, e26);
    const bs = ex.baris.find((r) => r[0] === e26.hasilUsahaPeriodeLabel);
    ok('F-4 ekspor: baris SHU punya saldo awal', bs && bs[1] === e26.saldoAwalHasilUsaha && bs[1] === 4000000, JSON.stringify(bs));
    return cek;
  }, { idx, ID });
  let gagal = 0;
  for (const [n, v] of Object.entries(hasil)) { console.log(`${v.ok ? 'OK   ' : 'GAGAL'} ${n}${v.info ? ' :: ' + v.info : ''}`); if (!v.ok) gagal++; }
  console.log(logs.filter((l) => !/jembatan sistem/.test(l)).slice(0, 10).join('\n'));
  fs.writeFileSync(OUT, JSON.stringify({ hasil, pageErrors: logs }, null, 1));
  await b.close();
  process.exit(gagal ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
