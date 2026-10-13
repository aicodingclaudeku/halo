'use strict';
// Uji asap RC-S133.4.6 di ELECTRON NYATA — import "Saldo lama" setara transaksi biasa.
//  1) Koperasi & admin lewat service asli; lisensi DIGANTI TIRUAN (khusus uji); kebijakan produk berjangka dibuat.
//  2) Import (cut-off 2026-07-01): simpanan berjangka lama + sheet 7 Saldo Awal Akun.
//  3) Berjangka lama: TANPA jurnal kas, saldo awal 2-1210 otomatis, bunga sebelum cut-off tidak diakru ulang.
//  4) Sheet 7: Kas/pendapatan/beban masuk Saldo Awal Akun; "Saldo Awal Belum Sesuai" = 0.
//  5) SHU Basis Kas: saldo awal Beban Penyusutan bawaan belum tunai.
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-import-saldo-lama-setara.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');

/** Isi uji — teks fungsi, dijalankan di jendela renderer (juga dipakai harness headless). */
const UJI = `async (P) => {
  const R = (k) => __r(P.ids[k]);
  await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Saldo Lama', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026', tanggalBerdiri: '2026-01-02' });
  if (!P.lisensiAsli) { const L = R('lisensi'); const asli = L.getLicenseStatus; L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true }); L.hasValidLocalLicense = async () => true; }
  const db = await R('db').getDb();
  const uid = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
  await __r(P.kebijakan).simpanKebijakanProduk({ versi: 'KP-UJI', berlakuMulai: '2026-07-01', autoRenewal: false, bungaPascaJatuhTempoAktif: false, ratePascaJatuhTempo: null, dasarPenetapan: 'Uji', ditetapkanOleh: 'Uji', ditetapkanPada: '2026-07-01', createdBy: uid });
  const saldo = async (kode) => (await db.getFirstAsync("SELECT COALESCE(SUM(je.debit - je.kredit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id JOIN account a ON a.id = je.account_id WHERE j.status IN ('POSTED','REVERSED') AND a.kode = ?", kode)).s;
  const berkas = __r(P.parser).parseBerkasDataAwal({
    ANGGOTA: [['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], ['K1', 'Siti Uji', '2026-01-05']],
    SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'], ['K1', '2026-06-30', 100000, 300000, 2560000]],
    BERJANGKA: [['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana'], ['K1', '2026-03-20', 4000000, 12, 6, 'KAS']],
    SALDO_AWAL_AKUN: [['Kode Akun', 'Nama Akun', 'Saldo', 'Bagian Tunai'], ['1-1000', 'Kas', 6900000, null], ['5-1300', 'Beban Penyusutan', 60000, null]],
  });
  const h = await __r(P.impor).jalankanImportDataAwal(berkas, { createdBy: uid, tanggalCutOff: '2026-07-01', namaBerkas: 'uji.xlsx' });
  const jurnalSetor = (await db.getFirstAsync("SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'SIMPANAN_BERJANGKA'")).n;
  const bungaLama = await db.getAllAsync('SELECT nomor_periode n, journal_id j FROM simpanan_berjangka_bunga ORDER BY nomor_periode');
  const kasSetelahImport = await saldo('1-1000');
  await __r(P.catchUp).jalankanCatchUpAkrualSimpananBerjangka(uid, '2026-08-25');
  const belum = await __r(P.realisasi).bacaBagianBelumTunaiSaldoAwal(db);
  const akunPenyusutan = (await db.getFirstAsync("SELECT id FROM account WHERE kode = '5-1300'")).id;
  return {
    gagal: h.gagal.map((g) => g.pesan), berjangka: h.perSheet.find((s) => s.jenis === 'BERJANGKA'),
    sheet7: h.saldoAwalAkun, jurnalSetor, bungaLama, kasSetelahImport,
    berjangkaGl: await saldo('2-1210'), kliring: await saldo('3-5000'),
    bebanBunga: await saldo('5-1955'), sukarela: await saldo('2-1200'),
    penyusutanBelumTunai: belum.get(akunPenyusutan) || 0,
  };
}`;

function idModul(bundle, penanda) {
  const i = bundle.indexOf(penanda);
  if (i < 0) throw new Error('penanda tidak ada: ' + penanda);
  const m = /\},(\d+),\[[\d,]*\]\)/g;
  m.lastIndex = i;
  return Number(m.exec(bundle)[1]);
}
function siapkanParameter(rendererDir) {
  const { bangunIndeks, cariBerkasBundle, indeksEkspor, resolusi } = require('../electron/server/bundleIndex');
  const teks = fs.readFileSync(cariBerkasBundle(rendererDir), 'utf8');
  const ids = bangunIndeks(rendererDir).modul;
  const x = resolusi(indeksEkspor(teks), {
    parser: ['parseBerkasDataAwal', 'parseSheetSaldoAwalAkun'],
    impor: ['jalankanImportDataAwal', 'PESAN_SALDO_AWAL_AKUN_TANPA_CUTOFF'],
    kebijakan: ['simpanKebijakanProduk', 'listKebijakanProduk'],
    catchUp: ['jalankanCatchUpAkrualSimpananBerjangka'],
    realisasi: ['bacaBagianBelumTunaiSaldoAwal', 'BEBAN_NON_KAS_SALDO_AWAL'],
  });
  if (x.hilang.length) throw new Error('modul tidak ditemukan: ' + JSON.stringify(x.hilang));
  void idModul;
  return Object.assign({ ids }, x.modul);
}
function periksa(r, cek) {
  cek('import berhasil tanpa galat', r.gagal.length === 0 && r.berjangka.berhasil === 1, JSON.stringify(r.gagal));
  cek('berjangka lama TIDAK dijurnal ke Kas', r.jurnalSetor === 0 && r.kasSetelahImport === 6900000, `jurnal ${r.jurnalSetor}, kas ${r.kasSetelahImport}`);
  cek('saldo awal Simpanan Berjangka otomatis Rp4.000.000', r.berjangkaGl === -4000000, String(r.berjangkaGl));
  cek('bunga 3 periode sebelum cut-off tercatat tanpa jurnal', r.bungaLama.length >= 3 && r.bungaLama.slice(0, 3).every((b) => b.j === null), JSON.stringify(r.bungaLama));
  cek('catch-up hanya mengakru periode sesudah cut-off (Jul & Agu = Rp40.000)', r.bebanBunga === 40000, String(r.bebanBunga));
  cek('sheet 7 terisi 2 akun & Saldo Awal Belum Sesuai Rp0', r.sheet7 && r.sheet7.berhasil.length === 2 && r.sheet7.saldoKliring === 0 && r.kliring === 0, JSON.stringify(r.sheet7));
  cek('saldo awal Beban Penyusutan bawaan belum tunai (SHU Basis Kas)', r.penyusutanBelumTunai === 60000, String(r.penyusutanBelumTunai));
}

module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  const hasil = {};
  const cek = (nama, ok, info) => {
    hasil[nama] = !!ok;
    console.log(`SL-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 8000));
      const P = siapkanParameter(path.join(__dirname, '..', 'renderer'));
      const r = await win.webContents.executeJavaScript(`(${UJI})(${JSON.stringify(P)})`);
      console.log('HASIL:', JSON.stringify(r));
      periksa(r, cek);
    } catch (e) {
      console.log('SL-SMOKE-ERR', e && e.stack);
    }
    const gagal = Object.entries(hasil).filter(([, v]) => !v).map(([k]) => k);
    console.log(`SL-SMOKE RINGKASAN ${Object.keys(hasil).length - gagal.length}/${Object.keys(hasil).length} lulus${gagal.length ? ' — gagal: ' + gagal.join('; ') : ''}`);
    fs.writeFileSync(path.join(out, 'hasil-import-saldo-lama-smoke.json'), JSON.stringify(hasil, null, 2));
    app.exit(0);
  });
};
module.exports.UJI = UJI;
module.exports.siapkanParameter = siapkanParameter;
module.exports.periksa = periksa;
