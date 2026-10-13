'use strict';
// Uji asap "Pengaturan › Asisten AI" di ELECTRON NYATA (main.js + preload.js + IPC + renderer terpasang):
//  1) Koperasi, anggota, simpanan, pinjaman dibuat lewat service asli; lisensi DIGANTI TIRUAN (khusus uji).
//  2) Masuk sebagai Admin lewat layar Login asli; Berkas › Asisten AI… membuka layarnya.
//  3) Sakelar "Hubungkan ke Claude" diklik di layar (dialog konfirmasi asli) → host MCP menyala dan entri
//     "kopku" ditulis ke claude_desktop_config.json (folder Claude TIRUAN: KOPKU_CLAUDE_HOME).
//  4) Perintah PERSIS dari entri itu dijalankan seperti Claude Desktop (exe Electron --kopku-mcp-stdio):
//     initialize → tools/list → tools/call; jawabannya berasal dari service KOPKU di jendela ini.
// Jalankan (Linux: di bawah xvfb-run):
//   KOPKU_USERDATA=<dir> KOPKU_CLAUDE_HOME=<dir> KOPKU_SMOKE=$PWD/test/smoke-asisten-ai.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
    console.log(`ASISTEN-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  const isiInput = (indeks, nilai) =>
    js(`(() => { const i = document.querySelectorAll('input')[${indeks}]; if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)});
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const klikTombol = (re) => js(`(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => ${re}.test((x.innerText || '').trim())); if (b) b.click(); return !!b; })()`);
  const klikTestId = (id) => js(`(() => { const e = document.querySelector('[data-testid="${id}"]'); if (!e) return false; (e.querySelector('input') || e).click(); return true; })()`);

  /** Klien MCP stdio — perintah diambil dari claude_desktop_config.json, persis seperti Claude Desktop. */
  function klienDariConfig(entri) {
    // Lingkungan seperti Claude Desktop: tanpa variabel uji/Electron milik proses KOPKU ini.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k2]) => !/^(KOPKU_|ELECTRON_|CHROME_)/.test(k2)));
    // Linux sebagai root (container uji): Chromium mewajibkan --no-sandbox sebelum JS berjalan. Tidak berlaku di Windows/macOS.
    const args = process.platform === 'linux' && process.getuid && process.getuid() === 0 && entri.args.includes('--kopku-mcp-stdio') ? ['--no-sandbox', ...entri.args] : entri.args;
    const p = spawn(entri.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let galat = '';
    let buf = '';
    const bukanJson = [];
    const tunggu2 = new Map();
    p.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(l);
        } catch {
          bukanJson.push(l);
          continue;
        }
        if (tunggu2.has(m.id)) tunggu2.get(m.id)(m);
      }
    });
    p.stderr.on('data', (c) => (galat += c));
    let id = 0;
    return {
      kirim: (method, params) =>
        new Promise((r, j) => {
          const n = ++id;
          tunggu2.set(n, r);
          setTimeout(() => j(new Error('timeout ' + method + ' :: ' + galat.slice(-800))), 30000);
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
        }),
      tutup: () => new Promise((r) => { p.on('exit', r); p.stdin.end(); }),
      bukanJson,
    };
  }

  win.setSize(1440, 900);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(8000);
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      const lisensiTiruan = `const L = __r(ids.lisensi); const asli = L.getLicenseStatus;
        L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
        L.hasValidLocalLicense = async () => true;`;
      await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Maju Bersama', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        ${lisensiTiruan}
        const db = await R('db').getDb();
        const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
        const nama = ['Siti Aminah', 'Budi Santoso', 'Rina Wulandari'];
        for (let i = 0; i < nama.length; i++) {
          const a = (await R('anggota').createAnggota(admin, { namaLengkap: nama[i], tanggalBergabung: '2025-01-10', nomorHp: '08129999000' + i, status: 'AKTIF' })).id;
          await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'POKOK', tanggal: '2026-01-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin });
          await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'WAJIB', tanggal: '2026-01-15', periode: '2026-01', nominal: 50000, sumberDana: 'KAS', createdBy: admin });
          await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'SUKARELA', tanggal: '2026-01-15', nominal: 10000000, sumberDana: 'KAS', createdBy: admin });
          const p = await R('pinjaman').ajukanPinjaman({ anggotaId: a, jumlahPinjaman: 3000000, tanggal: '2026-06-15', tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin });
          await R('pinjaman').cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin, tanggalPencairan: '2026-06-15', sumberDana: 'KAS' });
        }
        return true; })()`);
      win.webContents.once('did-finish-load', async () => {
        try {
          await js(`(() => { const ids = ${JSON.stringify(ids)}; ${lisensiTiruan} return true; })()`).catch(() => undefined);
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
          cek('masuk ke aplikasi', /Dashboard/.test(t) && /Pengaturan/.test(t));
          cek('preload mengekspos kopkuDesktop.asistenAi', await js('typeof kopkuDesktop.asistenAi.status === "function" && typeof kopkuDesktop.asistenAi.atur === "function"'));

          // ---- Berkas › Asisten AI… (perintah menu Electron yang sama)
          win.webContents.send('menu', 'asistenai');
          await tunggu(2500);
          await shot('50-asisten-mati');
          t = await teks();
          cek('menu Berkas › Asisten AI… membuka layar', /Aktifkan Asisten AI/.test(t) && /Pasang di Claude Desktop/.test(t));
          cek('bawaan MATI', (await js('kopkuDesktop.asistenAi.status()')).aktif === false);

          // ---- nyalakan lewat sakelar di layar + dialog konfirmasi asli
          await klikTestId('saklar-asisten-ai');
          await tunggu(800);
          await shot('51-konfirmasi');
          await klikTombol('/^Hubungkan$/');
          await tunggu(3000);
          await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
          await tunggu(800);
          const st = await js('kopkuDesktop.asistenAi.status()');
          cek('host MCP menyala atas nama admin', st.aktif && st.berjalan && st.pengguna && st.pengguna.username === 'admin', JSON.stringify({ aktif: st.aktif, berjalan: st.berjalan, port: st.port }));
          cek('entri "kopku" terpasang & cocok di Claude Desktop', st.claude.terpasang && st.claude.cocok, st.claude.lokasi.map((l) => l.berkas).join(','));
          const berkasConf = st.claude.lokasi.find((l) => l.terpasang).berkas;
          const entri = JSON.parse(fs.readFileSync(berkasConf, 'utf8')).mcpServers.kopku;
          // 1.0.26: Node.js terpasang → node + salinan server di folder data (exe: stdin tertutup di Windows).
          cek('entri menjalankan Node.js + server lokal (tanpa ELECTRON_RUN_AS_NODE)', st.runtime.jenis === 'node' && entri.command === st.runtime.path && /mcp[\\/]server[\\/]stdio\.js$/.test(entri.args[0]) && !entri.env, JSON.stringify(entri));

          // ---- jalankan entri persis seperti Claude Desktop
          const c = klienDariConfig(entri);
          const init = await c.kirim('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
          cek('entri Claude: initialize', init.result && init.result.serverInfo.name === 'kopku');
          const daftar = await c.kirim('tools/list', {});
          cek('tools/list (per anggota OFF → 7 alat)', daftar.result.tools.length === 7, String(daftar.result.tools.length));
          const r = await c.kirim('tools/call', { name: 'ringkasan_koperasi', arguments: {} });
          const j = JSON.parse(r.result.content[0].text);
          cek('ringkasan_koperasi dari jendela KOPKU (adapter disuntikkan lewat IPC asli)', !r.result.isError && j.koperasi === 'Koperasi Maju Bersama' && j.anggotaAktif === 3 && j.pinjaman.jumlahPinjamanAktif === 3, r.result.content[0].text.slice(0, 160));
          const pos = await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'posisi_keuangan' } });
          cek('laporan posisi keuangan seimbang', JSON.parse(pos.result.content[0].text).data.isBalanced === true);
          // per anggota lewat sakelar di layar
          await klikTestId('saklar-asisten-per-anggota');
          await tunggu(700);
          await klikTombol('/^Izinkan$/');
          await tunggu(2500);
          await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
          const tg = await c.kirim('tools/call', { name: 'daftar_tunggakan', arguments: {} });
          cek('per anggota ON → daftar_tunggakan tanpa nomor HP', !tg.result.isError && /Siti Aminah|Budi Santoso|Rina Wulandari/.test(tg.result.content[0].text) && !/0812999/.test(tg.result.content[0].text), tg.result.content[0].text.slice(0, 120));
          // ---- 1.0.27: izinkan Claude mengubah data (sakelar + dialog asli) → setoran lewat pratinjau + konfirmasi,
          //      backup otomatis SUNGGUHAN, lalu koreksi (jurnal pembalik) — adapter tulis disuntikkan main.js.
          await js(`(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 0; return true; })()`);
          await klikTestId('saklar-asisten-ubah-data');
          await tunggu(800);
          await shot('54-konfirmasi-ubah-data');
          await klikTombol('/^Izinkan mengubah data$/');
          await tunggu(2500);
          await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
          const st2 = await js('kopkuDesktop.asistenAi.status()');
          cek('ubah data ON lewat layar', st2.bolehTulis === true);
          const argSetor = { anggota: 'Siti Aminah', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-01', periode: '2026-10' };
          const pr = JSON.parse((await c.kirim('tools/call', { name: 'simpanan_setor', arguments: argSetor })).result.content[0].text);
          cek('pratinjau setoran + kode konfirmasi', pr.status === 'MENUNGGU_KONFIRMASI' && /^K-/.test(pr.konfirmasi), JSON.stringify(pr.pratinjau));
          const sm = JSON.parse((await c.kirim('tools/call', { name: 'simpanan_setor', arguments: Object.assign({}, argSetor, { konfirmasi: pr.konfirmasi }) })).result.content[0].text);
          cek('setoran tersimpan setelah konfirmasi', sm.status === 'BERHASIL' && /^SP-WAJIB-/.test(sm.hasil.nomorTransaksi), JSON.stringify(sm).slice(0, 200));
          const dirBackup = path.join(app.getPath('userData'), 'documents', 'backups');
          cek('backup otomatis SUNGGUHAN dibuat sebelum perubahan', fs.existsSync(dirBackup) && fs.readdirSync(dirBackup).some((f) => /\.kdb$/.test(f)), fs.existsSync(dirBackup) ? fs.readdirSync(dirBackup).join(',') : 'tidak ada folder');
          const kp = JSON.parse((await c.kirim('tools/call', { name: 'koreksi_transaksi', arguments: { transaksi: sm.hasil.nomorTransaksi, alasan: 'uji koreksi dari Claude' } })).result.content[0].text);
          const kj = JSON.parse((await c.kirim('tools/call', { name: 'koreksi_transaksi', arguments: { transaksi: sm.hasil.nomorTransaksi, alasan: 'uji koreksi dari Claude', konfirmasi: kp.konfirmasi } })).result.content[0].text);
          cek('koreksi transaksi (jurnal pembalik) lewat Claude', kj.status === 'BERHASIL', JSON.stringify(kj).slice(0, 200));
          const pos2 = JSON.parse((await c.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'posisi_keuangan' } })).result.content[0].text);
          cek('neraca tetap seimbang setelah perubahan', pos2.data.isBalanced === true);
          cek('stdout server stdio hanya berisi JSON-RPC', c.bukanJson.length === 0, c.bukanJson.slice(0, 2).join(' / '));
          await tunggu(5500);
          await shot('52-asisten-menyala');
          await js(`(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 99999; return true; })()`);
          await tunggu(500);
          await shot('53-aktivitas');
          t = await teks();
          cek('layar menampilkan aktivitas pemakaian (termasuk perubahan)', /Ringkasan koperasi/.test(t) && /Daftar tunggakan/.test(t) && /UBAH: Setor simpanan wajib/.test(t));
          await c.tutup();

          // ---- 1.0.31: ChatGPT lewat OpenAI Secure MCP Tunnel — main.js ASLI (SecureHost/safeStorage, jalur runtime,
          // IPC dari jendela) + tunnel-client-runtime RESMI + tiruan control plane OpenAI (KOPKU_OPENAI_BASE).
          if (process.env.KOPKU_OPENAI_BASE) {
            const { buatTiruanOpenAI } = require(path.join(__dirname, 'mcp', 'tiruanOpenAI.js'));
            const TID = 'tunnel_0123456789abcdef0123456789abcdef';
            const KEY = 'sk-proj-ujiElectron0123456789abcdefABCD';
            const openai = buatTiruanOpenAI({ apiKey: KEY, tunnelId: TID });
            await openai.mulai(Number(new URL(process.env.KOPKU_OPENAI_BASE).port));
            const isiTestId = (id, nilai) =>
              js(`(() => { const i = document.querySelector('[data-testid="${id}"]'); if (!i) return false;
                const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)});
                i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const stGpt = () => js('window.kopkuDesktop.asistenAi.status().then((x) => x.chatgpt)');
            await js(`(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 0; return true; })()`);
            await klikTestId('tab-chatgpt');
            await tunggu(800);
            await isiTestId('input-tunnel-id', TID);
            await isiTestId('input-api-key', KEY);
            await tunggu(300);
            await klikTestId('tombol-simpan-kredensial');
            await tunggu(2000);
            await klikTombol(/^OK$/);
            let g = await stGpt();
            cek('ChatGPT: prasyarat otomatis lengkap (runtime resmi ditemukan main.js)', g.prasyarat.every((x) => x.ok), JSON.stringify(g.prasyarat.map((x) => x.kode + ':' + x.ok)));
            const berkasRahasia = path.join(app.getPath('userData'), 'mcp', 'chatgpt-rahasia.json');
            const isiRahasia = fs.existsSync(berkasRahasia) ? fs.readFileSync(berkasRahasia, 'utf8') : '';
            const { safeStorage } = require('electron');
            cek('ChatGPT: API key di penyimpanan rahasia terpisah (bukan teks polos) & tidak di chatgpt.json', isiRahasia.length > 0 && !isiRahasia.includes(KEY) && (safeStorage.isEncryptionAvailable() ? /"enc:/.test(isiRahasia) : true) && !fs.readFileSync(path.join(app.getPath('userData'), 'mcp', 'chatgpt.json'), 'utf8').includes('sk-'), `enkripsi tersedia: ${safeStorage.isEncryptionAvailable()} · format: ${(isiRahasia.match(/"(enc|raw):/) || [])[1]}`);
            await klikTestId('tombol-hubungkan-chatgpt');
            await tunggu(800);
            await klikTombol(/^Hubungkan$/);
            for (let i = 0; i < 60 && !['TERHUBUNG', 'GAGAL'].includes((g = await stGpt()).keadaan); i++) await tunggu(500);
            cek('ChatGPT: TERHUBUNG (runtime resmi ⇄ tiruan OpenAI)', g.keadaan === 'TERHUBUNG', g.pesan);
            const r1 = await openai.kirim({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ringkasan_koperasi', arguments: {} } });
            cek('ChatGPT: data koperasi lewat tunnel (aplikasi Electron asli)', !r1.resp_json.result.isError && /anggotaAktif/.test(r1.resp_json.result.content[0].text), r1.resp_json.result.content[0].text.slice(0, 120));
            const daftar = (await openai.kirim({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).resp_json.result.tools.map((x) => x.name);
            cek('ChatGPT: hanya-baca walau ubah data Claude ON (izin terpisah)', daftar.length === 14 && !daftar.includes('simpanan_setor'), String(daftar.length));
            const logT = fs.readFileSync(path.join(app.getPath('userData'), 'mcp', 'chatgpt-tunnel.log'), 'utf8');
            cek('ChatGPT: log runtime tanpa API key', logT.length > 0 && !logT.includes(KEY));
            await tunggu(5500);
            await shot('54-chatgpt-terhubung');
            await klikTestId('tombol-putuskan-chatgpt');
            await tunggu(2500);
            g = await stGpt();
            cek('ChatGPT: Putuskan → MATI', g.keadaan === 'MATI');
            await openai.tutup();
          }
        } catch (e) {
          console.log('ASISTEN-SMOKE-ERR', e && e.stack);
          hasil.galat = false;
        }
        fs.writeFileSync(path.join(out, 'hasil-asisten-ai.json'), JSON.stringify(hasil, null, 1));
        const semua = Object.values(hasil);
        console.log(`ASISTEN-SMOKE SELESAI ${semua.filter(Boolean).length}/${semua.length}`);
        app.exit(semua.every(Boolean) ? 0 : 1);
      });
      win.webContents.reload();
    } catch (e) {
      console.log('ASISTEN-SMOKE-ERR', e && e.stack);
      app.exit(1);
    }
  });
};
