'use strict';
// Uji asap RC-S133.4.3 di ELECTRON NYATA — sheet "6. Jasa Dibayar" & petunjuk import.
//  1) Koperasi & admin dibuat lewat service asli; lisensi DIGANTI TIRUAN (khusus uji).
//  2) Import data awal (jalur saldo lama, cut-off 2026-09-29) dengan sheet 1 + sheet 6 lewat
//     parser & eksekutor ASLI di renderer; lalu import "sheet 6 saja" dengan nomor anggota.
//  3) Dasar SHU jasa usaha per anggota (getBasisAnggotaSHU) memuat jasa sebelum cut-off.
//  4) Layar Import Data Awal & Struktur Template menampilkan teks/tab baru.
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-import-jasa.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');

module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const teks = () => js('document.body.innerText');
  const shot = async (nama) => fs.writeFileSync(path.join(out, nama + '.png'), (await win.webContents.capturePage()).toPNG());
  const hasil = {};
  const cek = (nama, ok, info) => {
    hasil[nama] = !!ok;
    console.log(`JASA-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  const klikTeks = (t, idx = 0) =>
    js(`(() => { const el = [...document.querySelectorAll('div,span,a,button')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(t)});
      const x = el[${idx}]; if (!x) return false; x.click(); return true; })()`);
  const isiInput = (indeks, nilai) =>
    js(`(() => { const i = document.querySelectorAll('input')[${indeks}]; if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)});
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
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
    shu: idModul('.getBasisAnggotaSHU='),
  };
  const bukaLewatCari = async (kata, judul) => {
    win.webContents.send('menu', 'cari');
    await tunggu(800);
    await js(`(() => { const i = [...document.querySelectorAll('input')].pop(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(kata)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await tunggu(800);
    const ok = await js(`(() => { const el = [...document.querySelectorAll('div,span')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(judul)}); const x = el[el.length - 1]; if (!x) return false; x.click(); return true; })()`);
    await tunggu(3000);
    return ok;
  };

  win.setSize(1440, 900);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(8000);
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Import Jasa', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        const L = R('lisensi'); const asli = L.getLicenseStatus;
        L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
        L.hasValidLocalLicense = async () => true;
        return true; })()`);
      const r = await js(`(async () => {
        const db = await __r(${ID.db}).getDb(); const P = __r(${ID.parser}); const I = __r(${ID.impor}); const S = __r(${ID.shu});
        const u = await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'");
        const H1 = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'];
        const H6 = ['Kode Anggota *', 'Nama Anggota', 'Jasa Pinjaman Dibayar * (tahun ini s.d. cut-off)'];
        const berkas1 = P.parseBerkasDataAwal({
          ANGGOTA: [H1, ['AGT0001', 'Arman Uji', '2025-01-01'], ['AGT0002', 'Ariani Uji', '2025-01-01'], ['AGT0003', 'Nakira Uji', '2025-01-01']],
          JASA: [['ket'], [], H6, ['AGT0001', 'Arman', 3000000], ['AGT0002', 'Ariani', 2010701]],
        });
        const h1 = await I.jalankanImportDataAwal(berkas1, { createdBy: u.id, tanggalCutOff: '2026-09-29', namaBerkas: 'uji-1.xlsx' });
        const anggota = await db.getAllAsync('SELECT id, nomor_anggota, nama_lengkap FROM anggota ORDER BY nomor_anggota');
        const nomor3 = anggota.find((a) => a.nama_lengkap === 'Nakira Uji').nomor_anggota;
        // berkas kedua: sheet 6 saja, memakai NOMOR anggota aplikasi
        const berkas2 = P.parseBerkasDataAwal({ JASA: [H6, [nomor3, 'Nakira', 280345], ['A99999', 'Tidak Ada', 1]] });
        const h2 = await I.jalankanImportDataAwal(berkas2, { createdBy: u.id, tanggalCutOff: '2026-09-29', namaBerkas: 'uji-2.xlsx' });
        const basis = await S.getBasisAnggotaSHU(db, '2026-01-01', '2026-12-31', true);
        const riwayat = await db.getAllAsync('SELECT nama_berkas, total_berhasil, total_gagal FROM import_data_awal_riwayat ORDER BY created_at');
        return { siap1: berkas1.siapDiimpor, jasa1: h1.perSheet.find((s) => s.jenis === 'JASA'), rek1: h1.jasaDataAwal,
          jasa2: h2.perSheet.find((s) => s.jenis === 'JASA'), gagal2: h2.gagal.map((g) => g.pesan),
          basis: basis.map((b) => [b.namaAnggota, b.basisPartisipasiUsaha]), riwayat,
          jurnal: (await db.getFirstAsync('SELECT COUNT(*) n FROM journal')).n };
      })()`);
      console.log('HASIL:', JSON.stringify(r));
      cek('berkas sheet 1 + sheet 6 siap diimpor', r.siap1);
      cek('import 1: 2 baris jasa berhasil, total Rp5.010.701', r.jasa1.berhasil === 2 && r.jasa1.gagal === 0 && r.rek1.totalJasa === 5010701);
      cek('import 2 (sheet 6 saja, nomor anggota): 1 berhasil, 1 gagal dgn pesan jelas', r.jasa2.berhasil === 1 && r.jasa2.gagal === 1 && /tidak ditemukan/.test(r.gagal2[0]));
      const b = Object.fromEntries(r.basis);
      cek('dasar SHU jasa usaha per anggota memuat jasa sebelum cut-off', b['Arman Uji'] === 3000000 && b['Ariani Uji'] === 2010701 && b['Nakira Uji'] === 280345, JSON.stringify(b));
      cek('tanpa jurnal baru dari sheet 6', r.jurnal === 0, 'jurnal=' + r.jurnal);
      cek('riwayat import tercatat untuk kedua import', r.riwayat.length === 2, JSON.stringify(r.riwayat));

      win.webContents.once('did-finish-load', async () => {
        try {
          await js(`(() => { const ids = ${JSON.stringify(ids)}; const L = __r(ids.lisensi); const asli = L.getLicenseStatus;
            L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
            L.hasValidLocalLicense = async () => true; return true; })()`).catch(() => undefined);
          await tunggu(7000);
          let t = await teks();
          if (/Masuk|Login|Username/i.test(t)) {
            await isiInput(0, 'admin');
            await isiInput(1, 'Admin#Kopku2026');
            await tunggu(300);
            await js(`(() => { const b = [...document.querySelectorAll('[role=button],button,div')].filter((e) => e.childElementCount <= 2 && /^\\s*Masuk\\s*$/.test(e.textContent)); const x = b[b.length - 1]; if (x) x.click(); return !!x; })()`);
            await tunggu(5000);
          }
          cek('masuk ke aplikasi', /Dashboard/.test(await teks()));
          cek('Ctrl+K membuka Import Data Awal', await bukaLewatCari('import data awal', 'Import Data Awal'));
          await shot('01-import-data-awal');
          t = await teks();
          cek('layar import menjelaskan jasa dibayar di sheet 6', /jasa yang sudah dibayar\s+tiap anggota diisi di sheet 6/.test(t.replace(/\n/g, ' ')));
          await klikTeks('Lihat Struktur');
          await tunggu(2000);
          t = await teks();
          cek('Struktur Template punya tab "Jasa Dibayar s.d. Cut-off"', t.includes('Jasa Dibayar s.d. Cut-off'));
          await klikTeks('Jasa Dibayar s.d. Cut-off');
          await tunggu(1200);
          t = await teks();
          await shot('02-struktur-template-jasa');
          cek('tab 6 memuat kolom Jasa Pinjaman Dibayar & aturan saldo lama', /Jasa Pinjaman Dibayar/.test(t) && /tanpa jurnal kas/i.test(t));
        } catch (e) {
          console.log('JASA-SMOKE-ERR', e && e.stack);
        }
        const gagal = Object.entries(hasil).filter(([, v]) => !v).map(([k]) => k);
        console.log(`JASA-SMOKE RINGKASAN ${Object.keys(hasil).length - gagal.length}/${Object.keys(hasil).length} lulus${gagal.length ? ' — gagal: ' + gagal.join('; ') : ''}`);
        fs.writeFileSync(path.join(out, 'hasil-import-jasa-smoke.json'), JSON.stringify(hasil, null, 2));
        app.exit(0);
      });
      win.webContents.reload();
    } catch (e) {
      console.log('JASA-SMOKE-ERR', e && e.stack);
      app.exit(1);
    }
  });
};
