'use strict';
// Uji asap RC-S133.6.5 (Desktop 1.0.20) — perbaikan temuan audit KOPKU-AUDIT-TEST-DAMY — pada BUNDLE RENDERER TERTAMBAL (Chromium + jembatan desktop tiruan).
// SQLite = SqliteHost asli paket Windows (node:sqlite, berkas SQLite sungguhan di folder sementara).
// Bukan Electron: preload diganti emulator; lisensi/UI login tidak diuji di sini.
// Pemakaian: (1) sajikan renderer/ dengan header COOP/COEP, mis. `node test/sajikan-renderer.js renderer 8817`
//            (2) `node test/smoke-renderer-rc-s133.6.5-chromium.js <folder paket> 8817 hasil.json`
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
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.20', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
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
  const { cariBerkasBundle, indeksEkspor } = require(path.join(WIN, 'electron/server/bundleIndex.js'));
  const eks = indeksEkspor(fs.readFileSync(cariBerkasBundle(path.join(WIN, 'renderer')), 'utf8'));
  const UI = { createRoot: eks.get('createRoot')[0], createElement: eks.get('createElement')[0], useAppStore: eks.get('useAppStore')[0] };
  // Id modul: gabungan laporan tambalan (yang lebih baru menimpa) — modul yang tidak diubah 6.5 (mis. parser Excel)
  // memakai id dari laporan rilis sebelumnya.
  const ID = {};
  for (const f of ['6', '6.1', '6.2', '6.3', '6.4', '6.5']) {
    const lap = JSON.parse(fs.readFileSync(path.join(WIN, `docs/laporan-tambal-rc-s133.${f}.json`), 'utf8'));
    for (const m of lap.modul) ID[path.basename(m.berkas).replace(/\.tsx?$/, '')] = m.id;
  }
  const hasil = await pg.evaluate(async ({ idx, ID }) => {
    const R = (k) => __r(idx[k]); const M = (k) => __r(ID[k]);
    const cek = {}; const ok = (n, v, info) => { cek[n] = { ok: !!v, info }; };
    const tolak = async (fn) => { try { await fn(); return null; } catch (e) { return String(e && e.message || e); } };
    await R('koperasi').setupKoperasi({ nama: 'Koperasi DAMY (SIMULASI) RC-S133.6.5', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Admin', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const ver = (await db.getFirstAsync('SELECT version FROM schema_meta')).version;
    ok('skema tetap v82 (tanpa migrasi baru)', ver === 82, String(ver));
    const K = R('kasBank'); const PIN = M('PinjamanService'); const SIM = M('SimpananService'); const AG = M('AnggotaRepository');
    const L = M('Ledger'); const PCT = M('persen'); const TK = M('tanggalKalender');
    const P = M('ExcelDataAwalParser'); const PG = M('PanduanImportData'); const I = M('EksekusiImportDataAwal'); const RTB = M('ReportTableBuilders');
    await K.catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 100000000, tanggal: '2026-01-02', createdBy: admin });
    const a1 = (await AG.createAnggota(admin, { namaLengkap: 'Simulasi Anggota 01', tanggalBergabung: '2026-01-05' })).id;
    const a2 = (await AG.createAnggota(admin, { namaLengkap: 'Simulasi Anggota 02', tanggalBergabung: '2026-01-05' })).id;
    for (const a of [a1, a2]) await SIM.catatDataAwalSimpanan({ anggotaId: a, tanggal: '2026-01-05', pokok: 100000, wajib: 50000, sukarela: 500000, sumberDana: 'KAS', createdBy: admin });

    // T-01 Buku Besar
    const kas = (await db.getFirstAsync("SELECT id FROM account WHERE kode='1-1000'")).id;
    const pend = (await db.getFirstAsync("SELECT id FROM account WHERE kategori='PENDAPATAN' AND is_active=1 ORDER BY kode LIMIT 1")).id;
    await K.catatPemasukan({ jenis: 'KAS', tanggal: '2026-03-05', nominal: 20000, akunLawanId: pend, createdBy: admin });
    const sa = await L.getSaldoAwalLedger(db, kas, '2026-03-01');
    const bb = await L.getLedger(db, kas, { tanggalMulai: '2026-03-01', tanggalSelesai: '2026-03-31', sertakanSaldoAwal: true });
    const tb = (await L.getTrialBalance(db, '2026-03-31')).rows.find((r) => r.kode === '1-1000');
    ok('T-01 Buku Besar ber-filter: saldo awal ikut, saldo akhir = Neraca Saldo', sa === 101300000 && bb[bb.length - 1].saldoBerjalan === tb.debit - tb.kredit, JSON.stringify({ sa, akhir: bb[bb.length - 1].saldoBerjalan, ns: tb.debit - tb.kredit }));
    const eks = RTB.buildBukuBesarExport({ namaKoperasi: 'X' }, 'Kas', bb, 'Mar', sa);
    ok('T-01 ekspor Buku Besar memuat baris Saldo Awal', eks.baris[0][2] === 'Saldo Awal' && eks.baris[0][5] === sa);
    // T-02
    ok('T-02 parsePersenInput("1,5") = 1,5; "0,75" = 0,75', PCT.parsePersenInput('1,5') === 1.5 && PCT.parsePersenInput('0,75') === 0.75 && Number.isNaN(PCT.parsePersenInput('1,5,2')));
    // T-03/T-05/T-07/T-10
    const dasar = (o) => Object.assign({ anggotaId: a1, tanggal: '2026-03-01', jumlahPinjaman: 1200000, tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, tujuanPinjaman: 'MODAL_KERJA', createdBy: admin }, o || {});
    const pA = await PIN.ajukanPinjaman(dasar());
    const jA = await PIN.getJadwalAngsuran(pA.id);
    const e5 = await tolak(() => PIN.bayarAngsuran({ pinjamanId: pA.id, jadwalId: jA[0].id, tanggal: '2026-04-01', nominal: 218000, sumberDana: 'KAS', createdBy: admin }));
    ok('T-05 bayar pinjaman belum cair ditolak', /tidak dapat menerima pembayaran/.test(e5 || ''), e5);
    const e3 = await tolak(() => PIN.cairkanPinjaman({ pinjamanId: pA.id, sumberDana: 'KAS', approvedBy: admin, tanggalPencairan: '2026-02-01' }));
    ok('T-03 pencairan sebelum pengajuan ditolak', /sebelum tanggal pengajuan/.test(e3 || ''), e3);
    await PIN.cairkanPinjaman({ pinjamanId: pA.id, sumberDana: 'KAS', approvedBy: admin, tanggalPencairan: '2026-03-01' });
    const e3b = await tolak(() => PIN.bayarAngsuran({ pinjamanId: pA.id, jadwalId: jA[0].id, tanggal: '2026-02-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin }));
    ok('T-03 bayar sebelum tanggal akad/pencairan ditolak', /sebelum tanggal akad\/pencairan/.test(e3b || ''), e3b);
    const e7 = await tolak(() => PIN.ajukanPinjaman(dasar({ persentaseJasa: 1000 })));
    const e7b = await tolak(() => PIN.ajukanPinjaman(dasar({ biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 2000000 })));
    ok('T-07 jasa 1000% dan admin > pokok ditolak saat pengajuan', /tidak wajar/.test(e7 || '') && /lebih kecil dari jumlah pinjaman/.test(e7b || ''), `${e7} | ${e7b}`);
    const e10 = await tolak(() => K.catatPemasukan({ jenis: 'KAS', tanggal: '2026-02-30', nominal: 1000, akunLawanId: pend, createdBy: admin }));
    const e10b = await tolak(() => AG.createAnggota(admin, { namaLengkap: 'X', nik: '123', tanggalBergabung: '2026-01-05' }));
    ok('T-10 tanggal fiktif & NIK salah ditolak di layanan', /tidak sah/.test(e10 || '') && /16 digit/.test(e10b || ''), `${e10} | ${e10b}`);
    const e3c = await tolak(() => SIM.catatDataAwalSimpanan({ anggotaId: a2, tanggal: '2025-12-01', pokok: 0, wajib: 50000, sukarela: 0, sumberDana: 'KAS', createdBy: admin }));
    ok('T-03 setoran sebelum anggota bergabung ditolak', /sebelum tanggal anggota bergabung/.test(e3c || ''), e3c);
    ok('T-08 tanggal CUSTOM 2026-06-31 / 2026-5-1 tidak sah', !TK.isTanggalKalender('2026-06-31') && !TK.isTanggalKalender('2026-5-1') && TK.isTanggalKalender('2026-05-01'));
    // T-12
    const mirip = await AG.cariAnggotaMirip('simulasi anggota 01', '2026-01-05');
    ok('T-12 anggota mirip terdeteksi', mirip.length === 1 && mirip[0].id === a1);
    // T-04/T-13/T-16 impor
    const hdrP = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Denda per Hari'];
    const berkas = P.parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], ['F1', 'Masa Depan', '01/01/2099'], ['B1', 'Budi Simulasi', '05/01/2026']],
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'], ['F1', '01/01/2099', 100000, 50000, 0, 'KAS'], ['B1', '05/01/2026', 100000, 50000.5, 0, 'KAS']],
      PINJAMAN: [hdrP, ['B1', '01/02/2026', 1200000, 6, 'BULAN', 'FLAT', 1.5, 'KAS', 1000], ['B1', '01/02/2026', 1200000, 6, 'BULAN', 'FLAT', 150, 'KAS', 0]],
    });
    const prat = PG.periksaSebelumImport(berkas, { sifat: 'TRANSAKSI_BARU' }).map((p) => p.kunci + ':' + p.tingkat);
    ok('T-04/T-13 pratinjau: BLOKIR tanggal masa depan, PERINGATAN pembulatan', prat.includes('tanggal-masa-depan:BLOKIR') && prat.includes('nominal-dibulatkan:PERINGATAN'), prat.join(','));
    ok('T-07 parser: Jasa Persen 150 ditolak', berkas.hasil.pinjaman.galat.some((g) => /tidak wajar/.test(g.pesan)), JSON.stringify(berkas.hasil.pinjaman.galat));
    const h = await I.jalankanImportDataAwal(berkas, { createdBy: admin, namaBerkas: 'uji.xlsx' });
    const j2099 = (await db.getFirstAsync("SELECT COUNT(*) n FROM journal WHERE tanggal >= '2099-01-01'")).n;
    ok('T-04 eksekutor: tanpa jurnal 2099', j2099 === 0 && h.gagal.some((g) => /masa depan/.test(g.pesan)), JSON.stringify(h.gagal.map((g) => g.pesan)));
    const pj = await db.getFirstAsync("SELECT denda_aktif, denda_tipe, denda_nilai FROM pinjaman WHERE anggota_id = (SELECT id FROM anggota WHERE nama_lengkap = 'Budi Simulasi')");
    ok('T-16 denda per hari ikut diimpor', pj && pj.denda_aktif === 1 && pj.denda_tipe === 'PER_HARI' && pj.denda_nilai === 1000, JSON.stringify(pj));
    const tak = (await db.getAllAsync('SELECT journal_id FROM journal_entry GROUP BY journal_id HAVING SUM(debit) <> SUM(kredit)')).length;
    ok('semua jurnal seimbang', tak === 0, String(tak));
    return cek;
  }, { idx, ID });
  let gagal = 0;
  for (const [n, v] of Object.entries(hasil)) { console.log(`${v.ok ? 'OK   ' : 'GAGAL'} ${n}${v.info ? ' :: ' + v.info : ''}`); if (!v.ok) gagal++; }
  console.log(logs.filter((l) => !/jembatan sistem/.test(l)).slice(0, 10).join('\n'));
  fs.writeFileSync(OUT, JSON.stringify({ hasil, pageErrors: logs }, null, 1));
  await b.close();
  process.exit(gagal ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
