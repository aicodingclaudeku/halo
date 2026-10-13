'use strict';
// Uji asap RC-S133.4.3 di ELECTRON NYATA (renderer hasil build source RC-S133.4.3):
//  1) Koperasi & admin dibuat lewat service asli; lisensi DIGANTI TIRUAN (khusus uji).
//  2) Saldo awal seperti data pengguna: Kas, 4-1000 Pendapatan Jasa Rp5.010.701, 4-1100 Administrasi Rp280.345.
//  3) Layar Saldo Awal menampilkan "Basis kas … sudah diterima tunai"; ubah bagian tunai lewat dialog.
//  4) Laporan Hasil Usaha: SHU Basis Kas = akrual (Rp5.291.046), lalu Rp4.280.345 setelah bagian tunai diubah.
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-saldo-awal-basis-kas.js KOPKU_SMOKE_OUT=<dir> electron .
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
    console.log(`SA-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  const klikTeks = (t, idx = 0) =>
    js(`(() => { const el = [...document.querySelectorAll('div,span,a,button')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(t)});
      const x = el[${idx}]; if (!x) return false; x.click(); return true; })()`);
  const isiInput = (indeks, nilai) =>
    js(`(() => { const i = document.querySelectorAll('input')[${indeks}]; if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)});
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // id modul Metro yang memuat teks unik tertentu
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
    saldoAwal: idModul('SET_OPENING_BALANCE_CASH_PORTION'),
    db: idModul('runMigrations (setelah blok migrasi legacy)'),
    laporan: idModul('_e.getInformasiShuRAT=async function'),
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
  const gulirKe = (kata) =>
    js(`(() => { const el = [...document.querySelectorAll('div,span')].find((e) => e.childElementCount === 0 && e.textContent.includes(${JSON.stringify(kata)})); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`);

  win.setSize(1440, 900);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(8000);
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Basis Kas', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        const L = R('lisensi'); const asli = L.getLicenseStatus;
        L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
        L.hasValidLocalLicense = async () => true;
        return true; })()`);
      // saldo awal seperti backup pengguna
      const tulis = await js(`(async () => {
        const db = await __r(${ID.db}).getDb(); const S = __r(${ID.saldoAwal});
        const u = await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'");
        const akun = async (kode) => (await db.getFirstAsync('SELECT id FROM account WHERE kode = ?', kode)).id;
        await S.tambahSaldoAwalAkun({ accountId: await akun('1-1000'), tanggal: '2026-09-29', saldo: 215134518, createdBy: u.id });
        await S.tambahSaldoAwalAkun({ accountId: await akun('4-1000'), tanggal: '2026-09-29', saldo: 5010701, createdBy: u.id });
        await S.tambahSaldoAwalAkun({ accountId: await akun('4-1100'), tanggal: '2026-09-29', saldo: 280345, createdBy: u.id });
        const r = await __r(${ID.laporan}).getInformasiShuRAT(db, '2026-01-01', '2026-12-31');
        return r; })()`);
      cek('service: SHU Basis Kas = akrual = 5.291.046', tulis.shuInformasiRat === 5291046 && tulis.shuLaporanKeuanganAkrual === 5291046, JSON.stringify(tulis));

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
          t = await teks();
          cek('masuk ke aplikasi', /Dashboard/.test(t));

          // ---- layar Saldo Awal
          cek('Ctrl+K membuka Saldo Awal', await bukaLewatCari('saldo awal', 'Saldo Awal'));
          await js(`(() => { const s = [...document.querySelectorAll('input')].find((i) => /cari/i.test(i.placeholder || '')); if (!s) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, '4-1'); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
          await tunggu(1500);
          await gulirKe('Basis kas');
          await tunggu(500);
          await shot('01-saldo-awal-basis-kas');
          t = await teks();
          const baris1000 = /Basis kas: Rp\s?5\.010\.701 sudah diterima tunai \(seluruhnya\)/.test(t);
          const baris1100 = /Basis kas: Rp\s?280\.345 sudah diterima tunai \(seluruhnya\)/.test(t);
          cek('Saldo Awal: baris basis kas 4-1000 & 4-1100 tampil', baris1000 && baris1100, (t.match(/Basis kas[^\n]*/g) || []).join(' | '));
          cek('akun neraca (Kas) tanpa baris basis kas', (t.match(/Basis kas:/g) || []).length === 2);

          // ---- ubah bagian tunai 4-1000 menjadi 4.000.000
          await js(`(() => { const k = document.querySelector('[data-testid="tunai-4-1000"]'); const u = k && [...k.querySelectorAll('div,span')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'Ubah'); if (!u) return false; u.click(); return true; })()`);
          await tunggu(1200);
          t = await teks();
          cek('dialog Bagian Tunai Saldo Awal terbuka', /Bagian Tunai Saldo Awal/.test(t) && /Sudah diterima tunai sebelum cut-off/.test(t));
          await js(`(() => { const ins = [...document.querySelectorAll('input')]; const i = ins[ins.length - 1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '4000000'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
          await tunggu(600);
          await shot('02-dialog-bagian-tunai');
          cek('dialog menghitung sisa belum tunai Rp1.010.701', /Belum diterima \(masih piutang\): Rp\s?1\.010\.701/.test(await teks()));
          await klikTeks('Simpan');
          await tunggu(2500);
          await klikTeks('OK').catch(() => undefined);
          await tunggu(800);
          await gulirKe('Basis kas');
          await shot('03-saldo-awal-setelah-ubah');
          t = await teks();
          cek('Saldo Awal: 4-1000 kini Rp4.000.000 tunai · Rp1.010.701 belum tunai', /Basis kas: Rp\s?4\.000\.000 sudah diterima tunai · Rp\s?1\.010\.701 belum tunai/.test(t), (t.match(/Basis kas[^\n]*/g) || []).join(' | '));

          // ---- Laporan Hasil Usaha
          cek('Ctrl+K membuka Perhitungan Hasil Usaha', await bukaLewatCari('hasil usaha', 'Perhitungan Hasil Usaha'));
          await tunggu(3000);
          await gulirKe('SHU — Akrual vs Basis Kas');
          await tunggu(800);
          await shot('04-lhu-basis-kas');
          t = await teks();
          const pot = t.slice(t.indexOf('SHU — Akrual vs Basis Kas'));
          console.log('TEKS-LHU:', pot.slice(0, 700).replace(/\n+/g, ' | '));
          cek('LHU: SHU Basis Akrual Rp5.291.046', /SHU Basis Akrual\s*\n?\s*Rp\s?5\.291\.046/.test(pot));
          cek('LHU: SHU Basis Kas Rp4.280.345', /SHU Basis Kas\s*\n?\s*Rp\s?4\.280\.345/.test(pot));
          cek('LHU: catatan saldo awal tampil', /sudah termasuk saldo awal yang dicatat sebelum memakai aplikasi — pendapatan Rp\s?4\.280\.345/.test(pot));
        } catch (e) {
          console.log('SA-SMOKE-ERR', e && e.stack);
        }
        const gagal = Object.entries(hasil).filter(([, v]) => !v).map(([k]) => k);
        console.log(`SA-SMOKE RINGKASAN ${Object.keys(hasil).length - gagal.length}/${Object.keys(hasil).length} lulus${gagal.length ? ' — gagal: ' + gagal.join('; ') : ''}`);
        fs.writeFileSync(path.join(out, 'hasil-saldo-awal-smoke.json'), JSON.stringify(hasil, null, 2));
        app.exit(0);
      });
      win.webContents.reload();
    } catch (e) {
      console.log('SA-SMOKE-ERR', e && e.stack);
      app.exit(1);
    }
  });
};
