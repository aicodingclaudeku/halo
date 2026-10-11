'use strict';
// Uji asap RC-S133.4.5 di ELECTRON NYATA — pinjaman hasil import data awal SETARA pinjaman biasa.
//  1) Koperasi & admin dibuat lewat service asli (COA & pemetaan bawaan); lisensi DIGANTI TIRUAN (khusus uji).
//  2) Import data awal jalur saldo lama (cut-off 2026-09-29) lewat parser & eksekutor ASLI di renderer:
//     PJ-1 akad 1 Agu 24 bln belum bayar + piutang jasa 1 angsuran; PJ-2 akad 1 Jun 10 bln sudah bayar 8
//     (5 di muka); PJ-3 tunggakan di berkas tidak cocok dengan akad.
//  3) Jadwal = kalkulator angsuran pinjaman biasa (nomor, tanggal dari akad, pokok, jasa), LUNAS tercatat,
//     tanpa jurnal kas; jasa dimuka & rekonsiliasi; akrual jasa tidak mengakui ulang piutang jasa saldo awal.
//  4) Layar hasil import memuat daftar "Pinjaman yang perlu dicek" (teks ada di bundle).
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-import-pinjaman-setara.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');

module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const hasil = {};
  const cek = (nama, ok, info) => {
    hasil[nama] = !!ok;
    console.log(`PJ-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  const bundle = (() => {
    const d = path.join(__dirname, '..', 'renderer', '_expo', 'static', 'js', 'web');
    return fs.readFileSync(path.join(d, fs.readdirSync(d).find((f) => f.endsWith('.js'))), 'utf8');
  })();
  const idModul = (penanda) => {
    const i = bundle.indexOf(penanda);
    if (i < 0) throw new Error('penanda tidak ada: ' + penanda);
    const m = /\},(\d+),\[[\d,]*\]\)/g;
    m.lastIndex = i;
    return Number(m.exec(bundle)[1]);
  };
  const ID = {
    db: idModul('runMigrations (setelah blok migrasi legacy)'),
    parser: idModul('.parseBerkasDataAwal=function'),
    impor: idModul('_e.jalankanImportDataAwal=async function'),
    kalk: idModul('.hitungJadwalAngsuran='),
    akrual: idModul('.jalankanAkrualJasaOtomatisJikaPerlu='),
  };

  win.setSize(1440, 900);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(8000);
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Import Pinjaman', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        const L = R('lisensi'); const asli = L.getLicenseStatus;
        L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
        L.hasValidLocalLicense = async () => true;
        return true; })()`);
      const r = await js(`(async () => {
        const db = await __r(${ID.db}).getDb(); const P = __r(${ID.parser}); const I = __r(${ID.impor}); const K = __r(${ID.kalk}); const A = __r(${ID.akrual});
        const u = await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'");
        const saldoKas = async () => (await db.getFirstAsync("SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id JOIN account a ON a.id = je.account_id WHERE j.status = 'POSTED' AND a.kode LIKE '1-1%' AND a.nama LIKE 'Kas%'")).s;
        const jurnalAwal = (await db.getFirstAsync('SELECT COUNT(*) n FROM journal')).n;
        const kasAwal = await saldoKas();
        const berkas = P.parseBerkasDataAwal({
          ANGGOTA: [['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'], ['K1', 'Budi Uji', '2025-01-01'], ['K2', 'Siti Uji', '2025-01-01'], ['K3', 'Rudi Uji', '2025-01-01']],
          PINJAMAN: [
            ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar', 'Nomor Pinjaman Lama', 'Piutang Jasa', 'Tunggakan Pokok'],
            ['K1', '2026-08-01', 9706600, 24, 'BULAN', 'FLAT', 0.5, 'KAS', 0, 'PJ-1', 48533, null],
            ['K2', '2026-06-01', 10000000, 10, 'BULAN', 'FLAT', 1.5, 'KAS', 8, 'PJ-2', null, null],
            ['K3', '2026-01-01', 12000000, 12, 'BULAN', 'FLAT', 1, 'KAS', 6, 'PJ-3', null, 3000000],
          ],
        });
        const h = await I.jalankanImportDataAwal(berkas, { createdBy: u.id, tanggalCutOff: '2026-09-29', namaBerkas: 'uji-pinjaman.xlsx' });
        const p1 = await db.getFirstAsync("SELECT id, tenor, status FROM pinjaman WHERE nomor_pinjaman = 'PJ-1'");
        const j1 = await db.getAllAsync('SELECT nomor_angsuran n, tanggal_jatuh_tempo t, pokok, jasa, status FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran', p1.id);
        const asli = K.hitungJadwalAngsuran({ jumlahPinjaman: 9706600, tenor: 24, persentaseJasaPerPeriode: 0.5, metode: 'FLAT' });
        const p2 = await db.getFirstAsync("SELECT id FROM pinjaman WHERE nomor_pinjaman = 'PJ-2'");
        const j2 = await db.getAllAsync('SELECT nomor_angsuran n, tanggal_jatuh_tempo t, status FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran', p2.id);
        const jurnalImport = (await db.getFirstAsync('SELECT COUNT(*) n FROM journal')).n - jurnalAwal;
        const kasSetelahImport = await saldoKas();
        const pajMigrasi = await db.getAllAsync("SELECT periode_akuntansi periode, pendapatan_akuntansi jumlah FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL'", p1.id);
        // akrual otomatis per 2 Okt: angsuran #1 PJ-1 (Sep) sudah di saldo awal → hanya #2 (Okt) yang diakui
        let akrual = null, galatAkrual = null;
        try { akrual = await A.jalankanAkrualJasaOtomatisJikaPerlu(u.id, new Date('2026-10-02T10:00:00')); } catch (e) { galatAkrual = String(e && e.message); }
        const pajSetelah = await db.getAllAsync("SELECT periode_akuntansi periode, pendapatan_akuntansi jumlah, journal_id FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' ORDER BY periode_akuntansi", p1.id);
        return {
          sheet: h.perSheet.find((s) => s.jenis === 'PINJAMAN'), gagal: h.gagal.map((g) => g.pesan),
          mode: h.migrasi.berhasil.map((b) => [b.nomorPinjaman, b.modeJadwal, b.catatan]),
          tenor1: p1.tenor, j1, asli: asli.map((a) => [a.nomorAngsuran, a.pokok, a.jasa]),
          j2, jurnalImport, kasAwal, kasSetelahImport, dimuka: h.migrasi.totalJasaDimuka,
          saldoAwal: (h.saldoAwal ? h.saldoAwal.baris : []).map((b) => [b.pos, b.status, b.saldoImport]),
          cocok: h.migrasi.rekonsiliasi.cocok, pesanRek: h.migrasi.rekonsiliasi.pesan,
          pajMigrasi, pajSetelah, akrual, galatAkrual,
        };
      })()`);
      console.log('HASIL:', JSON.stringify(r));
      cek('3 pinjaman lama berhasil diimpor', r.sheet && r.sheet.berhasil === 3 && r.sheet.gagal === 0, JSON.stringify(r.gagal));
      cek('PJ-1: tenor akad 24 & jadwal = kalkulator pinjaman biasa', r.tenor1 === 24 && JSON.stringify(r.j1.map((x) => [x.n, x.pokok, x.jasa])) === JSON.stringify(r.asli));
      cek('PJ-1: jatuh tempo dari tanggal akad (1 Sep 2026 … 1 Agu 2028)', r.j1[0].t === '2026-09-01' && r.j1[23].t === '2028-08-01');
      cek('PJ-2: 8 angsuran LUNAS, 2 belum', r.j2.filter((x) => x.status === 'LUNAS').length === 8 && r.j2.length === 10);
      const pos = Object.fromEntries(r.saldoAwal.map(([p, s, v]) => [p, [s, v]]));
      cek('jasa dibayar di muka PJ-2 (5 × Rp150.000) → saldo awal Pendapatan Diterima Dimuka', r.dimuka === 750000 && pos.PENDAPATAN_DIMUKA && pos.PENDAPATAN_DIMUKA[1] === 750000, JSON.stringify(pos.PENDAPATAN_DIMUKA));
      cek('PJ-3: tunggakan berkas tidak cocok dengan akad → dicatat untuk dicek', r.mode.find((m) => m[0] === 'PJ-3')[2].some((c) => /Tunggakan pokok di berkas/.test(c)), JSON.stringify(r.mode));
      cek('import tidak mengubah kas', r.kasAwal === r.kasSetelahImport, `${r.kasAwal} → ${r.kasSetelahImport}`);
      cek('piutang jasa per pinjaman tercatat (periode 2026-09)', r.pajMigrasi.length === 1 && r.pajMigrasi[0].periode === '2026-09' && r.pajMigrasi[0].jumlah === 48533, JSON.stringify(r.pajMigrasi));
      cek('akrual otomatis tidak mengakui ulang jasa September', !r.galatAkrual && r.pajSetelah.filter((p) => p.periode === '2026-09').length === 1 && r.pajSetelah.some((p) => p.periode === '2026-10' && p.journal_id), JSON.stringify(r.pajSetelah) + (r.galatAkrual || ''));
      cek('layar hasil import punya daftar "Pinjaman yang perlu dicek"', bundle.includes('Pinjaman yang perlu dicek'));
    } catch (e) {
      console.log('PJ-SMOKE-ERR', e && e.stack);
    }
    const gagal = Object.entries(hasil).filter(([, v]) => !v).map(([k]) => k);
    console.log(`PJ-SMOKE RINGKASAN ${Object.keys(hasil).length - gagal.length}/${Object.keys(hasil).length} lulus${gagal.length ? ' — gagal: ' + gagal.join('; ') : ''}`);
    fs.writeFileSync(path.join(out, 'hasil-import-pinjaman-smoke.json'), JSON.stringify(hasil, null, 2));
    app.exit(0);
  });
};
