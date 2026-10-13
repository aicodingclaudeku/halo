'use strict';
// Uji asap RC-S133.6.4 (Desktop 1.0.19) pada BUNDLE RENDERER TERTAMBAL (Chromium + jembatan desktop tiruan).
// SQLite = SqliteHost asli paket Windows (node:sqlite, berkas SQLite sungguhan di folder sementara).
// Bukan Electron: preload diganti emulator; lisensi/UI login tidak diuji di sini.
// Pemakaian: (1) sajikan renderer/ dengan header COOP/COEP, mis. `node test/sajikan-renderer.js renderer 8817`
//            (2) `node test/smoke-renderer-rc-s133.6.4-chromium.js <folder paket> 8817 hasil.json`
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
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.19', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
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
  // Id modul: gabungan laporan tambalan (yang lebih baru menimpa) — modul yang tidak diubah 6.4 (mis. parser Excel)
  // memakai id dari laporan rilis sebelumnya.
  const ID = {};
  for (const f of ['6', '6.1', '6.2', '6.3', '6.4']) {
    const lap = JSON.parse(fs.readFileSync(path.join(WIN, `docs/laporan-tambal-rc-s133.${f}.json`), 'utf8'));
    for (const m of lap.modul) ID[path.basename(m.berkas).replace(/\.tsx?$/, '')] = m.id;
  }
  const hasil = await pg.evaluate(async ({ idx, ID, UI }) => {
    const R = (k) => __r(idx[k]); const M = (k) => __r(ID[k]);
    const cek = {}; const ok = (n, v, info) => { cek[n] = { ok: !!v, info }; };
    await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji RC-S133.6.4', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Admin', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const K = R('kasBank'); const P = M('ExcelDataAwalParser'); const I = M('EksekusiImportDataAwal');
    const PP = M('PenyelesaianPinjaman'); const PS = M('PenyelesaianPinjamanService'); const LI = M('LoanImpairmentService');
    const PG = M('PanduanImportData'); const RR = M('RiwayatImportRepository'); const RP = M('RiwayatImportPlan');

    // ---- Skema v82 lewat migrasi/instalasi di bundle ----
    const ver = (await db.getFirstAsync('SELECT version FROM schema_meta')).version;
    ok('skema aplikasi v82', ver === 82, String(ver));
    const kol = (await db.getAllAsync('PRAGMA table_info(pinjaman)')).map((c) => c.name);
    ok('enam kolom pinjaman.penyelesaian_* ada', ['jalur', 'tanggal', 'nomor', 'dokumen', 'alasan', 'oleh'].every((k) => kol.includes('penyelesaian_' + k)), kol.filter((c) => c.startsWith('penyelesaian')).join(','));

    await K.catatSaldoAwalKas({ jenisKas: 'KAS_UMUM', saldoAwal: 100000000, tanggal: '2025-01-01', createdBy: admin });

    // ---- §1 import: pinjaman bertanggal 01-02-2026 tanpa simpanan pada tanggal itu -> masuk dengan PERINGATAN ----
    const berkas = P.parseBerkasDataAwal({
      ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi Uji', '2026-01-01'], ['K2', 'Siti Uji', '2026-01-01']],
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'], ['K1', '2026-03-01', 100000, 50000, 0, 'KAS'], ['K2', '2026-01-05', 100000, 50000, 0, 'KAS']],
      PINJAMAN: [['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana'], ['K1', '2026-02-01', 3000000, 6, 'BULAN', 'FLAT', 1, 'KAS'], ['K2', '2026-02-01', 3000000, 6, 'BULAN', 'FLAT', 1, 'KAS']],
    });
    const prat = PG.periksaSebelumImport(berkas, { sifat: 'TRANSAKSI_BARU', kebijakanSyaratPinjaman: { saldoMinimum: 0, plafonPinjaman: 0 } });
    const pSyarat = prat.find((p) => p.kunci === 'syarat-pinjaman-lampau');
    ok('pratinjau: PERINGATAN syarat pinjaman (bukan BLOKIR)', pSyarat && pSyarat.tingkat === 'PERINGATAN' && !prat.some((p) => p.tingkat === 'BLOKIR'), JSON.stringify(pSyarat));
    const h = await I.jalankanImportDataAwal(berkas, { createdBy: admin, namaBerkas: 'uji.xlsx' });
    ok('import: 0 baris gagal (peringatan tidak menolak)', h.totalGagal === 0, JSON.stringify(h.gagal.map((g) => g.pesan)));
    const per = h.berhasil.filter((b) => b.peringatan && b.peringatan.length);
    ok('import: tepat 1 pinjaman berperingatan (K1), K2 bersih', per.length === 1 && per[0].baris === 2, JSON.stringify(per));
    const rw = await db.getFirstAsync('SELECT id FROM import_data_awal_riwayat');
    const log = await RR.logRiwayatImport(db, rw.id);
    ok('Riwayat Import: log BERHASIL memuat peringatan syarat', log.some((b) => RP.adalahPeringatanSyarat(b)), JSON.stringify(log.filter((b) => b.pesan)));

    // ---- §1 form: pengajuan bertanggal lampau tetap DITOLAK; tanggal sesudah simpanan lolos ----
    const PIN = M('PinjamanService');
    const k1 = (await db.getFirstAsync("SELECT id FROM anggota WHERE nama_lengkap = 'Budi Uji'")).id;
    const form = (tanggal) => ({ anggotaId: k1, tanggal, jumlahPinjaman: 1000000, tenor: 2, satuanTenor: 'BULAN', metodeJasa: 'CUSTOM', persentaseJasa: 0, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin });
    let tolak = null;
    try { await PIN.ajukanPinjaman(form('2026-02-15')); } catch (e) { tolak = String(e.message || e); }
    ok('form: pengajuan 15-02-2026 (simpanan K1 baru 01-03-2026) DITOLAK', tolak && /Simpanan Pokok dan Simpanan Wajib/.test(tolak), tolak);
    const lolos = await PIN.ajukanPinjaman(form('2026-03-05'));
    ok('form: pengajuan 05-03-2026 lolos tanpa peringatan', lolos.id && lolos.peringatanSyarat.length === 0, JSON.stringify(lolos.peringatanSyarat));

    // ---- §2 penyelesaian Pengadilan/asuransi ----
    const k2 = (await db.getFirstAsync("SELECT id FROM anggota WHERE nama_lengkap = 'Siti Uji'")).id;
    const pj = await db.getFirstAsync("SELECT id, status FROM pinjaman WHERE anggota_id = ? AND status = 'AKTIF'", k2);
    ok('pinjaman K2 AKTIF dari import', !!pj);
    const tgl = '2026-03-01';
    const lapor = '2026-03-15'; // sesudah tanggal pencatatan, belum menunggak lama
    const sebelum = (await LI.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: lapor, statusAnggota: 'SEMUA' })).find((d) => d.pinjamanId === pj.id);
    await PS.catatPenyelesaianPinjaman({ pinjamanId: pj.id, jalur: 'PENGADILAN', tanggal: tgl, nomor: '123/Pdt.G/2026/PN Uji', dokumen: 'Surat gugatan', alasan: 'uji', actingUserId: admin });
    const sesudah = (await LI.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: lapor, statusAnggota: 'SEMUA' })).find((d) => d.pinjamanId === pj.id);
    ok('klasifikasi: setelah dicatat -> MACET (cadangan 100%) dan dasar memuat nomor perkara', sesudah.kolektibilitas === 'MACET' && sesudah.persentaseCadangan === 100 && /123\/Pdt\.G\/2026\/PN Uji/.test(sesudah.dasarPenggolongan), JSON.stringify({ sebelum: sebelum.kolektibilitas, sesudah: sesudah.kolektibilitas, dasar: sesudah.dasarPenggolongan }));
    ok('klasifikasi: sebelum dicatat bukan MACET', sebelum.kolektibilitas !== 'MACET', sebelum.kolektibilitas);
    const aud = await db.getAllAsync("SELECT action FROM audit_log WHERE entity = 'pinjaman' AND entity_id = ?", pj.id);
    ok('audit_log CATAT_PENYELESAIAN', aud.some((a) => a.action === 'CATAT_PENYELESAIAN'), JSON.stringify(aud));
    const jr = (await db.getFirstAsync("SELECT COUNT(*) n FROM journal WHERE deskripsi LIKE '%enyelesaian%'")).n;
    ok('pencatatan tidak membuat jurnal', jr === 0, String(jr));
    await PS.batalkanPenyelesaianPinjaman({ pinjamanId: pj.id, alasan: 'uji batal', actingUserId: admin });
    const akhir = (await LI.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: lapor, statusAnggota: 'SEMUA' })).find((d) => d.pinjamanId === pj.id);
    ok('dibatalkan -> kembali bukan MACET', akhir.kolektibilitas === sebelum.kolektibilitas, akhir.kolektibilitas);
    const det = await PIN.getPinjamanDetail(pj.id);
    ok('getPinjamanDetail.penyelesaian null setelah dibatalkan', det.penyelesaian === null);

    // ---- UI sungguhan: kartu "Penyelesaian Pengadilan / Asuransi" di Detail Pinjaman ----
    const React = __r(UI.createElement); const { createRoot } = __r(UI.createRoot); const store = __r(UI.useAppStore).useAppStore;
    const Kartu = M('PenyelesaianPinjamanCard').default;
    const matrix = await R('izin').getPermissionMatrix?.();
    const adm = await db.getFirstAsync("SELECT id, nama, username, role FROM app_user WHERE username = 'admin'");
    const render = async (props, izinApprove) => {
      const izin = { pinjaman: { canView: true, canCreate: true, canEdit: true, canApprove: izinApprove, canExport: true } };
      store.setState({ currentUser: adm, permissions: new Proxy(izin, { get: (t, k) => t[k] || { canView: true, canCreate: false, canEdit: false, canApprove: false, canExport: false } }) });
      const el = document.createElement('div'); document.body.appendChild(el);
      const root = createRoot(el);
      root.render(React.createElement(Kartu, { pinjamanId: pj.id, statusPinjaman: 'AKTIF', tanggalPinjaman: '2026-02-01', penyelesaian: null, onBerubah() {}, ...props }));
      await new Promise((r) => setTimeout(r, 400));
      const teks = el.innerText; root.unmount(); el.remove(); return teks;
    };
    const t1 = await render({}, true);
    ok('UI kartu (Admin, AKTIF, belum ada): judul + tombol Catat Penyelesaian', /Penyelesaian Pengadilan \/ Asuransi/.test(t1) && /Catat Penyelesaian/.test(t1) && /SOM 12\.1 kriteria Macet angka 3/.test(t1), t1.slice(0, 200));
    const t2 = await render({}, false);
    ok('UI kartu (tanpa izin approve): tombol Catat TIDAK ada, ada keterangan hanya Admin/Pengurus', !/Catat Penyelesaian/.test(t2) && /Hanya Admin\/Pengurus/.test(t2), t2.slice(0, 200));
    const t3 = await render({ penyelesaian: { pinjamanId: pj.id, jalur: 'ASURANSI', tanggal: '2026-03-01', nomor: 'KLM-9', dokumen: 'Surat klaim', alasan: null, dicatatOleh: adm.id } }, true);
    ok('UI kartu (sudah tercatat): MACET sejak, nomor klaim, tombol Ubah & Batalkan', /MACET sejak 2026-03-01/.test(t3) && /Nomor klaim/.test(t3) && /KLM-9/.test(t3) && /Ubah/.test(t3) && /Batalkan Pencatatan/.test(t3), t3.slice(0, 260));
    const t4 = await render({ statusPinjaman: 'LUNAS' }, true);
    ok('UI kartu (LUNAS, tanpa pencatatan): tidak ditampilkan', t4.trim() === '', JSON.stringify(t4));
    return cek;
  }, { idx, ID, UI });
  let gagal = 0;
  for (const [n, v] of Object.entries(hasil)) { console.log(`${v.ok ? 'OK   ' : 'GAGAL'} ${n}${v.info ? ' :: ' + v.info : ''}`); if (!v.ok) gagal++; }
  console.log(logs.filter((l) => !/jembatan sistem/.test(l)).slice(0, 10).join('\n'));
  fs.writeFileSync(OUT, JSON.stringify({ hasil, pageErrors: logs }, null, 1));
  await b.close();
  process.exit(gagal ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });
