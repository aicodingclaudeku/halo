/* KOPKU LAN — klien web (browser PC/laptop/tablet/HP di jaringan lokal).
 *
 * Tampilan mengikuti KOPKU Desktop: sidebar gelap bergrup (Dashboard, Data,
 * Transaksi, Laporan), pencarian menu Ctrl+K, bilah status.
 * Sejak Windows 1.0.21 TIDAK ADA menu Pengaturan di web: akses LAN pengguna,
 * sesi, audit log, WhatsApp Reminder & status server diatur di KOPKU Desktop ›
 * Pengaturan › LAN & WhatsApp.
 * Menu dibangun dari PETA IZIN user (Permission Matrix KOPKU, dipersempit
 * profil Pengawas) yang dikirim server.
 *
 * Keamanan klien:
 *  - Sesi = cookie HttpOnly (tidak terbaca JS). Token CSRF hanya di memori.
 *  - Tidak ada kredensial di localStorage/sessionStorage.
 *  - Semua teks dari server dirender lewat textContent (tanpa innerHTML).
 *  - Menu disembunyikan sesuai izin hanya demi kenyamanan; SEMUA izin tetap
 *    diperiksa di server.
 */
(function () {
  'use strict';

  // ============================================================ util DOM
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const anak = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    tambah(el, anak);
    return el;
  }
  function tambah(el, anak) {
    for (const a of anak) {
      if (a == null || a === false) continue;
      if (Array.isArray(a)) tambah(el, a);
      else el.appendChild(a instanceof Node ? a : document.createTextNode(String(a)));
    }
  }
  // append() bawaan mengubah array/null menjadi teks; tambahkan() meratakan array & melewati null/false.
  Object.defineProperty(Element.prototype, 'tambahkan', {
    value: function () {
      tambah(this, Array.prototype.slice.call(arguments));
      return this;
    },
  });
  function kosongkan(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  const $ = (s) => document.querySelector(s);
  const angka = (n) => new Intl.NumberFormat('id-ID').format(Math.round(Number(n) || 0));
  const rp = (n) => (Number(n) < 0 ? '-Rp ' + angka(-n) : 'Rp ' + angka(n));
  const tgl = (s) => {
    if (!s) return '-';
    const d = new Date(String(s).length === 10 ? s + 'T00:00:00' : s);
    return isNaN(d) ? String(s) : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const waktu = (s) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const hariIni = () => ymd(new Date());
  const awalTahun = () => new Date().getFullYear() + '-01-01';
  const label = (s) => String(s == null ? '-' : s).replace(/_/g, ' ');
  function kunciAcak() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b); // tersedia juga di http:// (bukan secure context)
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  let toastT = null;
  function toast(pesan, jenis) {
    const t = $('#toast');
    t.textContent = pesan;
    t.className = 'toast tampil' + (jenis ? ' ' + jenis : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.className = 'toast'), 4000);
  }
  function inisial(nama) {
    const p = String(nama || '?').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || '')[1] || '')).toUpperCase();
  }

  // ============================================================ ikon (SVG garis, gaya Ionicons outline)
  const NS = 'http://www.w3.org/2000/svg';
  const IKON = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    tukar: 'M7 7h13l-4-4M17 17H4l4 4',
    laporan: 'M4 20h16M7 16V10M12 16V5M17 16v-4',
    atur: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
    orang: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    pita: 'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8.2 13.9 7 22l5-3 5 3-1.2-8.1',
    daftar: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    bank: 'M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3',
    dompet: 'M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z',
    masuk: 'M12 3v12M7 10l5 5 5-5M5 21h14',
    keluar: 'M12 21V9M7 14l5-5 5 5M5 3h14',
    jam: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    uang: 'M2 7h20v10H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
    struk: 'M5 3v18l2-1.5L9 21l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3 5 4.5zM9 9h6M9 13h6',
    plus: 'M12 5v14M5 12h14',
    ulang: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    dokumen: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
    timbang: 'M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8',
    buku: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
    peringatan: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    riwayat: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    pai: 'M21.2 15.9A10 10 0 1 1 8 2.8M22 12A10 10 0 0 0 12 2v10z',
    perisai: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
    wifi: 'M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01',
    pesan: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.4-8.5 8.4 8.4 0 0 1 8.6 8z',
    kunci: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
    pena: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    server: 'M2 3h20v7H2zM2 14h20v7H2zM6 6.5h.01M6 17.5h.01',
    cari: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    menu: 'M3 6h18M3 12h18M3 18h18',
    kembali: 'M19 12H5M12 19l-7-7 7-7',
    panah: 'M9 18l6-6-6-6',
    bawah: 'M6 9l6 6 6-6',
    cetak: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
    keluarAkun: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    centang: 'M20 6 9 17l-5-5',
    silang: 'M18 6 6 18M6 6l12 12',
    kalkulator: 'M5 2h14v20H5zM8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
    jangkar: 'M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 22V8M5 12H2a10 10 0 0 0 20 0h-3',
    unduh: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    pdf: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 15h6',
    tabelIk: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16',
  };
  function ikon(nama, kelas) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ik' + (kelas ? ' ' + kelas : ''));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', IKON[nama] || IKON.grid);
    s.appendChild(p);
    return s;
  }

  // ============================================================ API
  const negara = { user: null, csrf: null, menu: {}, izin: null, koperasi: null, online: true, grupTerbuka: {} };

  class GalatApi extends Error {
    constructor(status, body) {
      super((body && body.pesan) || 'Permintaan gagal.');
      this.status = status;
      this.kode = body && body.kode;
    }
  }

  async function api(method, path, body, opsi) {
    opsi = opsi || {};
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (negara.csrf) headers['X-KOPKU-CSRF'] = negara.csrf;
      if (opsi.kunci) headers['Idempotency-Key'] = opsi.kunci;
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}), credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      setOnline(false);
      throw new GalatApi(0, { kode: 'JARINGAN', pesan: 'Server KOPKU tidak dapat dihubungi. Periksa Wi-Fi/LAN dan pastikan KOPKU Desktop di komputer server terbuka.' });
    }
    setOnline(true);
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    if (res.status === 401 && !opsi.tanpaRedirect) {
      negara.user = null;
      negara.csrf = null;
      location.hash = '#/masuk';
      throw new GalatApi(401, json);
    }
    if (!res.ok || !json || !json.ok) throw new GalatApi(res.status, json);
    return json.data;
  }
  const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o || {})) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  };

  // ============================================================ izin
  function boleh(res, act) {
    return !!(negara.izin && negara.izin[res] && negara.izin[res][act || 'view']);
  }
  function bolehSemua(syarat) {
    if (!syarat) return true;
    if (typeof syarat === 'function') return syarat();
    return boleh(syarat[0], syarat[1]);
  }

  // ============================================================ status koneksi
  function setOnline(v) {
    if (negara.online === v) return;
    negara.online = v;
    const b = $('#luring');
    if (!v && !b) document.body.appendChild(h('div', { id: 'luring', class: 'luring' }, 'Server KOPKU Offline — mencoba menyambung ulang…'));
    if (v && b) {
      b.remove();
      toast('Tersambung kembali ke server KOPKU.');
    }
    perbaruiStatusBar();
  }
  let statusServer = { database: '-' };
  async function cekKesehatan() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      statusServer = j.data || {};
      setOnline(true);
    } catch (e) {
      statusServer = { database: '-' };
      setOnline(false);
    }
    perbaruiStatusBar();
  }
  setInterval(cekKesehatan, 15000);
  window.addEventListener('online', cekKesehatan);
  function perbaruiStatusBar() {
    const sb = $('#statusbar');
    if (!sb) return;
    const db = { READY: 'Database siap', NOT_CONFIGURED: 'Belum disetup', LICENSE_REQUIRED: 'Lisensi diperlukan', NOT_READY: 'Database belum siap' }[statusServer.database] || '-';
    kosongkan(sb).tambahkan(
      h('span', { class: 'sb ' + (negara.online ? 'ok' : 'merah') }, negara.online ? 'Server online' : 'Server offline'),
      h('span', { class: 'sb ' + (statusServer.database === 'READY' ? 'ok' : 'kuning') }, db),
      negara.koperasi ? h('span', null, negara.koperasi.nama) : null,
      negara.koperasi && negara.koperasi.tahunBuku ? h('span', null, 'Tahun buku ' + negara.koperasi.tahunBuku) : null,
      negara.user ? h('span', null, negara.user.nama + ' · ' + negara.user.labelPeran) : null,
      h('span', { class: 'kanan' }, 'LAN · ' + location.host)
    );
  }

  // ============================================================ dialog
  function dialog(judul, isi, tombol, opsi) {
    const akar = $('#dialog-akar');
    const tutup = () => {
      kosongkan(akar);
      document.removeEventListener('keydown', esc);
    };
    const esc = (e) => e.key === 'Escape' && tutup();
    document.addEventListener('keydown', esc);
    const lat = h(
      'div',
      { class: 'latar', onclick: (e) => { if (e.target === lat) tutup(); } },
      h('div', { class: 'dialog' + (opsi && opsi.lebar ? ' lebar' : '') + (opsi && opsi.kelas ? ' ' + opsi.kelas : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': judul }, h('div', { class: 'dialog-kepala' }, h('h2', null, judul), h('button', { class: 'ikon-btn', type: 'button', 'aria-label': 'Tutup', onclick: tutup }, ikon('silang'))), isi, h('div', { class: 'aksi' }, tombol(tutup)))
    );
    kosongkan(akar).appendChild(lat);
    const f = lat.querySelector('input,select,textarea') || lat.querySelector('.aksi .utama');
    if (f) f.focus();
    return tutup;
  }
  function pesanGalat(e) {
    return (e && e.message) || 'Terjadi kesalahan.';
  }
  function konfirmasi(judul, isi, labelOk, fn, kelas) {
    const galat = h('div', { class: 'pesan galat', hidden: true });
    dialog(judul, h('div', null, galat, isi), (tutup) => {
      const ok = h('button', {
        class: 'tombol ' + (kelas || 'utama'),
        type: 'button',
        onclick: async () => {
          ok.disabled = true;
          galat.hidden = true;
          try {
            await fn();
            tutup();
          } catch (e) {
            galat.textContent = pesanGalat(e);
            galat.hidden = false;
            ok.disabled = false;
          }
        },
      }, labelOk);
      return [h('button', { class: 'tombol', type: 'button', onclick: tutup }, 'Batal'), ok];
    });
  }

  // ============================================================ bukti input tersimpan
  /**
   * Tanda yang JELAS bahwa data sudah tersimpan di server KOPKU (bukan sekadar
   * toast yang hilang): dialog bukti berisi ringkasan yang diinput, nomor
   * transaksi, waktu & nama pencatat, dengan tombol Cetak bukti.
   * Bila halaman berpindah (keHash) dialog muncul setelah halaman baru dimuat.
   *
   * @param {{judul:string, sub?:string, nomor?:string, labelNomor?:string,
   *          baris?:Array<[string,any]>, aksi?:Array<{label:string,href?:string,fn?:Function}>,
   *          labelOk?:string, muatUlang?:boolean}} info
   */
  function sukses(info, keHash) {
    toast(info.judul + (info.nomor ? ' · ' + info.nomor : ''), 'sukses');
    negara.suksesTertunda = Object.assign({ waktu: new Date() }, info);
    if (keHash && keHash !== location.hash) location.hash = keHash; // rute() menampilkan setelah halaman dimuat
    else if (info.muatUlang) rute();
    else tampilkanSukses();
  }
  function tampilkanSukses() {
    const info = negara.suksesTertunda;
    if (!info) return;
    negara.suksesTertunda = null;
    const bukti = h(
      'div',
      { class: 'bukti' },
      h('div', { class: 'judul-cetak bukti-koperasi' }, h('b', null, negara.koperasi ? negara.koperasi.nama : 'KOPKU'), h('div', null, 'Bukti Input Data')),
      h('div', { class: 'bukti-kepala' }, h('span', { class: 'bukti-ikon' }, ikon('centang')), h('div', null, h('b', null, info.judul), h('small', null, info.sub || 'Tersimpan di KOPKU Desktop (komputer server) dan langsung tercatat di laporan.'))),
      info.nomor ? h('div', { class: 'bukti-nomor' }, h('small', null, info.labelNomor || 'Nomor transaksi'), h('b', null, info.nomor)) : null,
      info.baris && info.baris.length ? dl(info.baris.filter(Boolean)) : null,
      h('div', { class: 'bukti-kaki' }, ikon('jam'), 'Dicatat oleh ' + negara.user.nama + ' (' + negara.user.username + ') · ' + info.waktu.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }))
    );
    dialog('Data berhasil disimpan', bukti, (tutup) => [
      h('button', { class: 'tombol kiri', type: 'button', onclick: cetakBukti }, ikon('cetak'), 'Cetak bukti'),
      (info.aksi || []).map((a) =>
        a.href
          ? h('a', { class: 'tombol', href: a.href, onclick: tutup }, a.label)
          : h('button', { class: 'tombol', type: 'button', onclick: () => { tutup(); if (a.fn) a.fn(); } }, a.label)
      ),
      h('button', { class: 'tombol utama', type: 'button', onclick: () => { tutup(); if (info.fokus) info.fokus(); } }, ikon('centang'), info.labelOk || 'Selesai'),
    ], { kelas: 'dialog-sukses' });
  }
  function cetakBukti() {
    document.body.classList.add('cetak-bukti');
    const selesai = () => {
      document.body.classList.remove('cetak-bukti');
      window.removeEventListener('afterprint', selesai);
    };
    window.addEventListener('afterprint', selesai);
    window.print();
    setTimeout(selesai, 1500);
  }
  const teksPilihan = (sel) => (sel && sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : '-');

  // ============================================================ menu (mengikuti layout & Permission Matrix desktop)
  const MENU = [
    { id: 'dashboard', label: 'Dashboard', ikon: 'grid', href: '#/' },
    {
      id: 'data',
      label: 'Data',
      ikon: 'data',
      anak: [
        { label: 'Anggota', href: '#/anggota', ikon: 'orang', izin: ['anggota', 'view'], kata: 'member nasabah' },
        { label: 'Pengurus & Pengawas', href: '#/personel', ikon: 'pita', izin: ['anggota', 'view'], kata: 'pengelola karyawan organisasi' },
        { label: 'Daftar Akun', href: '#/akun', ikon: 'daftar', izin: ['pengaturan', 'view'], kata: 'coa chart of account' },
        { label: 'Data Bank & Kas', href: '#/rekening', ikon: 'bank', izin: ['kas_bank', 'view'], kata: 'rekening saldo' },
      ],
    },
    {
      id: 'transaksi',
      label: 'Transaksi',
      ikon: 'tukar',
      anak: [
        { sub: 'Simpanan' },
        { label: 'Setor Simpanan', href: '#/simpanan/setor', ikon: 'masuk', izin: ['simpanan', 'create'], kata: 'setor pokok wajib sukarela' },
        { label: 'Tarik Simpanan Sukarela', href: '#/simpanan/tarik', ikon: 'keluar', izin: ['simpanan', 'create'], kata: 'penarikan' },
        { label: 'Riwayat Simpanan', href: '#/simpanan', ikon: 'riwayat', izin: ['simpanan', 'view'] },
        { label: 'Saldo Simpanan Anggota', href: '#/simpanan/saldo', ikon: 'dompet', izin: ['simpanan', 'view'] },
        { label: 'Simpanan Berjangka', href: '#/berjangka', ikon: 'jam', izin: ['simpanan', 'view'], kata: 'deposito' },
        { sub: 'Pinjaman' },
        { label: 'Pinjaman Anggota', href: '#/pinjaman', ikon: 'uang', izin: ['pinjaman', 'view'], kata: 'kredit angsuran bayar pelunasan' },
        { label: 'Ajukan Pinjaman', href: '#/pinjaman/baru', ikon: 'plus', izin: ['pinjaman', 'create'], kata: 'pengajuan kredit baru simulasi' },
        { label: 'Bayar Angsuran', href: '#/pinjaman?kategori=AKTIF&bayar=1', ikon: 'struk', izin: ['pinjaman', 'create'], kata: 'cicilan piutang' },
        { sub: 'Kas & Bank' },
        { label: 'Kas Masuk', href: '#/kas/masuk', ikon: 'masuk', izin: ['kas_bank', 'create'], kata: 'penerimaan pendapatan lain' },
        { label: 'Kas Keluar', href: '#/kas/keluar', ikon: 'keluar', izin: ['kas_bank', 'create'], kata: 'pengeluaran beban biaya' },
        { label: 'Pemindahan Saldo', href: '#/kas/transfer', ikon: 'ulang', izin: ['kas_bank', 'edit'], kata: 'transfer antar rekening setor bank' },
        { label: 'Riwayat Kas & Bank', href: '#/kas', ikon: 'riwayat', izin: ['kas_bank', 'view'] },
      ],
    },
    {
      id: 'laporan',
      label: 'Laporan',
      ikon: 'laporan',
      anak: [
        { sub: 'Laporan Keuangan' },
        { label: 'Posisi Keuangan', href: '#/laporan/posisi', ikon: 'timbang', izin: ['laporan', 'view'], kata: 'neraca' },
        { label: 'Laporan Hasil Usaha', href: '#/laporan/lhu', ikon: 'laporan', izin: ['laporan', 'view'], kata: 'lhu shu' },
        { label: 'Laba Rugi', href: '#/laporan/laba-rugi', ikon: 'laporan', izin: ['laporan', 'view'], kata: 'pendapatan beban' },
        { label: 'Arus Kas', href: '#/laporan/arus-kas', ikon: 'tukar', izin: ['laporan', 'view'], kata: 'cash flow' },
        { label: 'Perubahan Ekuitas', href: '#/laporan/ekuitas', ikon: 'pai', izin: ['laporan', 'view'] },
        { label: 'Neraca Saldo', href: '#/laporan/neraca-saldo', ikon: 'timbang', izin: ['laporan', 'view'], kata: 'trial balance' },
        { label: 'Buku Besar', href: '#/laporan/buku-besar', ikon: 'buku', izin: ['laporan', 'view'], kata: 'ledger' },
        { sub: 'Pinjaman & Transaksi' },
        { label: 'Kolektibilitas', href: '#/laporan/kolektibilitas', ikon: 'perisai', izin: ['pinjaman', 'view'], kata: 'aging lancar macet' },
        { label: 'Tunggakan', href: '#/tunggakan', ikon: 'peringatan', izin: ['pinjaman', 'view'], kata: 'terlambat' },
        { label: 'History Transaksi', href: '#/history', ikon: 'riwayat', izin: ['history_transaksi', 'view'], kata: 'jurnal' },
        { label: 'SHU', href: '#/shu', ikon: 'pai', izin: ['shu', 'view'], kata: 'sisa hasil usaha' },
      ],
    },
  ];
  function itemTerlihat() {
    const out = [];
    for (const g of MENU) {
      if (!g.anak) out.push({ grup: null, item: g });
      else for (const a of g.anak) if (!a.sub && bolehSemua(a.izin)) out.push({ grup: g, item: a });
    }
    return out;
  }
  /** Item menu paling cocok dengan rute sekarang (query spesifik > jalur persis > awalan terpanjang). */
  function hrefAktif() {
    const r = location.hash || '#/';
    const [rp2, rq] = r.split('?');
    const rqs = new URLSearchParams(rq || '');
    let terbaik = null;
    let skor = -1;
    for (const x of itemTerlihat()) {
      const [hp, hq] = x.item.href.split('?');
      let s2 = -1;
      if (hp === '#/') s2 = rp2 === '#/' || rp2 === '' || rp2 === '#' ? 1000 : -1;
      else if (hq) {
        const hqs = new URLSearchParams(hq);
        s2 = rp2 === hp && [...hqs].every(([k, v]) => rqs.get(k) === v) ? 3000 : -1;
      } else if (rp2 === hp) s2 = 2000;
      else if (rp2.startsWith(hp + '/')) s2 = hp.length;
      if (s2 > skor) {
        skor = s2;
        terbaik = x.item.href;
      }
    }
    return terbaik;
  }
  let _aktif = null;
  function cocokRute(href) {
    return href === _aktif;
  }

  // ============================================================ kerangka
  function kerangka(judul, jejak, opsi) {
    opsi = opsi || {};
    const app = $('#app');
    app.className = 'app' + (negara.sidebarCiut ? ' ciut' : '');
    _aktif = hrefAktif();
    // Hanya grup yang memuat halaman aktif yang terbuka (seperti sidebar desktop) — kecuali dibuka manual di halaman ini.
    if (negara._ruteTerakhir !== location.hash) {
      negara._ruteTerakhir = location.hash;
      negara.grupTerbuka = {};
    }
    const nav = h('nav', { class: 'nav', 'aria-label': 'Menu utama' });
    nav.appendChild(h('div', { class: 'nav-label' }, 'Navigasi'));
    for (const g of MENU) {
      if (!g.anak) {
        nav.appendChild(h('a', { href: g.href, class: 'nav-item' + (cocokRute(g.href) ? ' aktif' : ''), title: g.label, onclick: () => app.classList.remove('menu-terbuka') }, ikon(g.ikon), h('span', { class: 'teks' }, g.label)));
        continue;
      }
      const anak = g.anak.filter((a) => a.sub || bolehSemua(a.izin));
      const items = anak.filter((a) => !a.sub);
      if (!items.length) continue;
      const aktifDi = items.some((a) => cocokRute(a.href));
      if (aktifDi) negara.grupTerbuka[g.id] = true;
      const terbuka = negara.grupTerbuka[g.id] != null ? negara.grupTerbuka[g.id] : false;
      const sub = h('div', { class: 'nav-sub', hidden: !terbuka });
      let subJudul = null;
      for (const a of anak) {
        if (a.sub) {
          subJudul = a.sub;
          continue;
        }
        if (subJudul) {
          sub.appendChild(h('div', { class: 'nav-subjudul' }, subJudul));
          subJudul = null;
        }
        sub.appendChild(h('a', { href: a.href, class: cocokRute(a.href) ? 'aktif' : '', onclick: () => app.classList.remove('menu-terbuka') }, h('span', { class: 'titik' }), a.label));
      }
      const kepala = h(
        'button',
        {
          type: 'button',
          class: 'nav-item' + (aktifDi ? ' induk-aktif' : ''),
          'aria-expanded': String(terbuka),
          title: g.label,
          onclick: () => {
            if (app.classList.contains('ciut')) {
              location.hash = items[0].href;
              return;
            }
            negara.grupTerbuka[g.id] = sub.hidden;
            sub.hidden = !sub.hidden;
            kepala.setAttribute('aria-expanded', String(!sub.hidden));
            kepala.classList.toggle('terbuka', !sub.hidden);
          },
        },
        ikon(g.ikon),
        h('span', { class: 'teks' }, g.label),
        ikon('bawah', 'panah-grup')
      );
      if (terbuka) kepala.classList.add('terbuka');
      nav.tambahkan(kepala, sub);
    }
    const konten = h('main', { class: 'konten', id: 'konten' });
    const kepalaHalaman = h(
      'div',
      { class: 'kepala-halaman' },
      opsi.kembali ? h('a', { class: 'kembali', href: opsi.kembali, 'aria-label': 'Kembali' }, ikon('kembali')) : null,
      h('div', { class: 'isi' }, h('div', { class: 'jejak' }, jejak || (negara.koperasi ? negara.koperasi.nama : 'KOPKU')), h('h1', null, judul)),
      opsi.aksi || null
    );
    kosongkan(app).tambahkan(
      h(
        'aside',
        { class: 'sidebar' },
        h('div', { class: 'brand' }, h('img', { src: '/logo.svg', alt: '' }), h('div', { class: 'teks' }, h('b', null, 'KOPKU'), h('small', null, negara.koperasi ? negara.koperasi.nama : 'Akses Jaringan Lokal'))),
        h('button', { type: 'button', class: 'cari-menu', onclick: bukaPalet }, ikon('cari'), h('span', { class: 'teks label-cari' }, 'Cari menu…'), h('kbd', { class: 'teks' }, 'Ctrl K')),
        nav,
        h('button', { type: 'button', class: 'ciutkan', onclick: () => { negara.sidebarCiut = !negara.sidebarCiut; app.classList.toggle('ciut', negara.sidebarCiut); } }, ikon('kembali'), h('span', { class: 'teks' }, 'Ciutkan sidebar'))
      ),
      h(
        'div',
        { class: 'kolom-utama' },
        h(
          'header',
          { class: 'topbar' },
          h('button', { class: 'ikon-btn menu-btn', type: 'button', 'aria-label': 'Buka menu', onclick: () => app.classList.toggle('menu-terbuka') }, ikon('menu')),
          h('button', { class: 'cari-atas', type: 'button', onclick: bukaPalet }, ikon('cari'), h('span', null, 'Cari menu, transaksi, laporan…'), h('kbd', null, 'Ctrl K')),
          h('div', { class: 'isi' }),
          negara.user.profil === 'PENGAWAS' ? h('span', { class: 'lencana kuning' }, 'Pengawas · baca saja') : null,
          menuAkun()
        ),
        kepalaHalaman,
        konten,
        h('footer', { class: 'statusbar', id: 'statusbar' })
      ),
      h('div', { class: 'tirai', onclick: () => app.classList.remove('menu-terbuka') })
    );
    perbaruiStatusBar();
    return konten;
  }

  function menuAkun() {
    const daftar = h(
      'div',
      { class: 'menu-akun-isi', hidden: true },
      h('div', { class: 'akun-info' }, h('b', null, negara.user.nama), h('small', null, negara.user.username + ' · ' + negara.user.labelPeran)),
      h('button', { type: 'button', onclick: keluar }, ikon('keluarAkun'), 'Keluar')
    );
    const tombol = h(
      'button',
      {
        type: 'button',
        class: 'akun-btn',
        'aria-haspopup': 'true',
        onclick: (e) => {
          e.stopPropagation();
          daftar.hidden = !daftar.hidden;
        },
      },
      h('span', { class: 'avatar' }, inisial(negara.user.nama)),
      h('span', { class: 'akun-teks' }, h('b', null, negara.user.nama), h('small', null, negara.user.labelPeran)),
      ikon('bawah')
    );
    return h('div', { class: 'menu-akun' }, tombol, daftar);
  }

  // ---- palet Ctrl+K
  function bukaPalet() {
    const semua = itemTerlihat().map((x) => ({ label: x.item.label, href: x.item.href, grup: x.grup ? x.grup.label : '', kata: x.item.kata || '', ikon: x.item.ikon }));
    const input = h('input', { type: 'search', placeholder: 'Ketik nama menu, transaksi, atau laporan…', 'aria-label': 'Cari menu' });
    const daftar = h('div', { class: 'palet-daftar', role: 'listbox' });
    let pilih = 0;
    let hasil = semua;
    const tampil = () => {
      const q = input.value.trim().toLowerCase();
      hasil = !q ? semua : semua.filter((m) => (m.label + ' ' + m.grup + ' ' + m.kata).toLowerCase().includes(q));
      pilih = Math.min(pilih, Math.max(0, hasil.length - 1));
      kosongkan(daftar).tambahkan(
        hasil.length
          ? hasil.map((m, i) => h('a', { href: m.href, class: 'palet-item' + (i === pilih ? ' dipilih' : ''), role: 'option', onclick: () => tutup() }, ikon(m.ikon), h('span', { class: 'isi' }, m.label), h('small', null, m.grup)))
          : h('div', { class: 'kosong' }, 'Tidak ada menu yang cocok atau Anda tidak memiliki izin.')
      );
    };
    input.addEventListener('input', () => {
      pilih = 0;
      tampil();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') pilih = Math.min(hasil.length - 1, pilih + 1);
      else if (e.key === 'ArrowUp') pilih = Math.max(0, pilih - 1);
      else if (e.key === 'Enter' && hasil[pilih]) {
        location.hash = hasil[pilih].href;
        tutup();
        return;
      } else return;
      e.preventDefault();
      tampil();
    });
    tampil();
    const tutup = dialog('Cari menu', h('div', { class: 'palet' }, input, daftar), () => [], { lebar: false });
  }
  document.addEventListener('click', () => document.querySelectorAll('.menu-akun-isi, .menu-ekspor-isi').forEach((x) => (x.hidden = true)));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K') && negara.user) {
      e.preventDefault();
      bukaPalet();
    }
  });

  async function keluar() {
    try {
      await api('POST', '/api/auth/logout', {}, { tanpaRedirect: true });
    } catch (e) {
      /* tetap keluar di sisi klien */
    }
    negara.user = null;
    negara.csrf = null;
    negara.izin = null;
    location.hash = '#/masuk';
  }

  // ============================================================ komponen
  const stat = (lbl, nilai, opsi) => {
    opsi = opsi || {};
    return h(opsi.href ? 'a' : 'div', { class: 'statistik' + (opsi.nada ? ' ' + opsi.nada : ''), href: opsi.href || null }, h('div', { class: 'stat-kepala' }, opsi.ikon ? h('span', { class: 'stat-ikon' }, ikon(opsi.ikon)) : null, h('span', { class: 'label' }, lbl)), h('div', { class: 'nilai' }, String(nilai)), opsi.sub ? h('div', { class: 'sub' }, opsi.sub) : null);
  };
  const kartu = (judul, ...isi) => h('section', { class: 'kartu' }, judul ? h('h2', null, judul) : null, ...isi);
  const dl = (pasangan) => h('dl', { class: 'dl' }, pasangan.filter(Boolean).map((x) => [h('dt', null, x[0]), h('dd', null, x[1] == null || x[1] === '' ? '-' : x[1])]));
  function memuat(el) {
    return kosongkan(el).appendChild(h('div', { class: 'kosong memuat-ani' }, 'Memuat…'));
  }

  const WARNA_STATUS = { AKTIF: '', LUNAS: 'abu', TIDAK_AKTIF: 'kuning', KELUAR: 'abu', MENINGGAL: 'abu', MACET: 'merah', DIAJUKAN: 'biru', DISETUJUI: 'biru', DITOLAK: 'abu', BELUM_BAYAR: 'kuning', SEBAGIAN: 'kuning', TERLAMBAT: 'merah', DIHAPUSBUKU: 'abu', DIRESTRUKTURISASI: 'abu', JATUH_TEMPO: 'kuning', DICAIRKAN: 'abu', sent: '', pending: 'kuning', sending: 'kuning', failed: 'merah', skipped: 'abu', BERHASIL: '', GAGAL: 'merah', DITOLAK_: 'merah', POSTED: '', REVERSED: 'abu', VOID: 'merah', SETOR: '', TARIK: 'kuning', PENERIMAAN: '', PENGELUARAN: 'kuning', TRANSFER: 'biru', KOREKSI: 'abu', LANCAR: '', DALAM_PERHATIAN_KHUSUS: 'kuning', KURANG_LANCAR: 'kuning', DIRAGUKAN: 'merah', DRAFT: 'kuning', DIHITUNG: 'biru', DISAHKAN: '', DIBAGIKAN: 'abu' };
  function lencanaStatus(s) {
    return h('span', { class: 'lencana ' + (WARNA_STATUS[s] != null ? WARNA_STATUS[s] : 'abu') }, label(s));
  }

  /** Tabel: kolom = ['Judul' | {t, c}], baris = [{sel:[...], klik?}], opsi.kaki = [...sel] */
  function tabel(kolom, baris, opsi) {
    opsi = opsi || {};
    if (!baris.length) return h('div', { class: 'kosong' }, opsi.kosong || 'Tidak ada data.');
    const sel = (c) => (c && typeof c === 'object' && !(c instanceof Node) ? c : { t: c });
    const td = (c, tag) => {
      const x = sel(c);
      return h(tag || 'td', { class: x.c || null, colspan: x.span || null }, x.t instanceof Node ? x.t : x.t == null ? '-' : String(x.t));
    };
    return h(
      'div',
      { class: 'tabel-bungkus' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, kolom.map((c) => td(c, 'th')))),
        h('tbody', null, baris.map((b) => h('tr', { class: (b.klik ? 'klik' : '') + (b.kelas ? ' ' + b.kelas : '') || null, onclick: b.klik || null, tabindex: b.klik ? '0' : null, onkeydown: b.klik ? (e) => e.key === 'Enter' && b.klik() : null }, b.sel.map((c) => td(c))))),
        opsi.kaki ? h('tfoot', null, [].concat(opsi.kaki[0] && Array.isArray(opsi.kaki[0]) ? opsi.kaki : [opsi.kaki]).map((r) => h('tr', null, r.map((c) => td(c))))) : null
      )
    );
  }
  function paginasi(hal, jumlah, ke) {
    if (hal <= 1 && jumlah < 50) return null;
    return h('div', { class: 'halaman' }, h('button', { class: 'tombol kecil', type: 'button', disabled: hal <= 1, onclick: () => ke(hal - 1) }, '‹ Sebelumnya'), h('span', { class: 'bantu' }, 'Halaman ' + hal), h('button', { class: 'tombol kecil', type: 'button', disabled: jumlah < 50, onclick: () => ke(hal + 1) }, 'Berikutnya ›'));
  }
  function tab(daftar, aktif, ke) {
    return h('div', { class: 'tab', role: 'tablist' }, daftar.map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(aktif === t[0]), class: aktif === t[0] ? 'aktif' : '', onclick: () => ke(t[0]) }, t[1])));
  }
  const medan = (lbl, el, bantu, opsi) => h('label', { class: 'medan' + (opsi && opsi.lebar ? ' lebar' : '') }, h('span', null, lbl), el, bantu ? h('div', { class: 'bantu' }, bantu) : null);

  /** Input Rupiah: tampil berformat ribuan, nilai() → bilangan bulat. */
  function inputRupiah(awal, opsi) {
    opsi = opsi || {};
    const el = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: opsi.placeholder || '0', class: 'rupiah' });
    const set = (n) => (el.value = n == null || n === '' ? '' : angka(n));
    set(awal);
    el.addEventListener('input', () => {
      const d = el.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
      const pos = el.value.length - el.selectionStart;
      el.value = d ? angka(Number(d)) : '';
      const p = Math.max(0, el.value.length - pos);
      el.setSelectionRange(p, p);
    });
    const bungkus = h('div', { class: 'input-rp' }, h('span', { class: 'awalan' }, 'Rp'), el);
    bungkus.nilai = () => {
      const d = el.value.replace(/[^0-9]/g, '');
      return d ? Number(d) : NaN;
    };
    bungkus.set = set;
    bungkus.input = el;
    return bungkus;
  }

  let rekeningCache = null;
  async function daftarRekening() {
    if (!rekeningCache) rekeningCache = await api('GET', '/api/rekening');
    return rekeningCache;
  }
  /** Sumber dana KAS/BANK (simpanan & pinjaman) — sama dengan pilihan di desktop. */
  async function pilihSumberDana() {
    const rek = await daftarRekening();
    const bankList = rek.filter((r) => r.jenis === 'BANK');
    const sumber = h('select', null, h('option', { value: 'KAS' }, 'Kas Tunai'), bankList.length ? h('option', { value: 'BANK' }, 'Bank') : null);
    const bank = h('select', { hidden: true }, bankList.map((r) => h('option', { value: r.id }, r.nama)));
    sumber.addEventListener('change', () => (bank.hidden = sumber.value !== 'BANK'));
    return { el: h('div', { class: 'tumpuk' }, sumber, bank), sumber, bank, nilai: () => ({ sumberDana: sumber.value, bankAccountId: sumber.value === 'BANK' ? bank.value : undefined }), label: () => (sumber.value === 'BANK' ? 'Bank — ' + teksPilihan(bank) : 'Kas Tunai') };
  }
  /** Rekening KAS / KAS_KECIL / BANK (menu Kas & Bank). */
  async function pilihRekening(opsi) {
    opsi = opsi || {};
    const rek = await daftarRekening();
    const s = h('select', null, rek.map((r) => h('option', { value: r.jenis + '|' + r.id }, r.nama + (r.jenis === 'BANK' ? '' : ''))));
    if (opsi.awal) s.value = opsi.awal;
    s.nilai = () => {
      const [jenis, id] = s.value.split('|');
      return { jenis, bankAccountId: jenis === 'BANK' ? id : undefined };
    };
    return s;
  }

  /** Pencarian anggota dengan hasil langsung (dipakai di form transaksi). */
  function pilihAnggota(opsi) {
    opsi = opsi || {};
    let terpilih = null;
    const input = h('input', { type: 'search', placeholder: opsi.placeholder || 'Ketik nama atau nomor anggota…', autocomplete: 'off' });
    const daftar = h('div', { class: 'saran', hidden: true });
    const chip = h('div', { class: 'terpilih', hidden: true });
    const bungkus = h('div', { class: 'pilih-anggota' }, input, daftar, chip);
    let t = null;
    let urutan = 0;
    const cari = async () => {
      if (terpilih) return;
      const q = input.value.trim();
      const nomor = ++urutan;
      try {
        const list = opsi.sumber ? await opsi.sumber(q) : (await api('GET', '/api/anggota' + qs({ cari: q, status: 'AKTIF' }))).baris;
        if (nomor !== urutan || terpilih) return; // hasil basi (ketikan sudah berubah / anggota sudah dipilih)
        kosongkan(daftar).tambahkan(
          list.length
            ? list.slice(0, 12).map((a) =>
                h('button', { type: 'button', class: 'saran-item', onclick: () => pilih(a) }, h('b', null, a.namaLengkap || a.namaAnggota), h('small', null, (a.nomorAnggota || '') + (opsi.info ? ' · ' + opsi.info(a) : '')))
              )
            : h('div', { class: 'kosong kecil' }, 'Anggota tidak ditemukan.')
        );
        daftar.hidden = false;
      } catch (e) {
        kosongkan(daftar).tambahkan(h('div', { class: 'pesan galat' }, pesanGalat(e)));
        daftar.hidden = false;
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(cari, 250);
    });
    input.addEventListener('focus', () => !terpilih && cari());
    function pilih(a) {
      clearTimeout(t);
      urutan++;
      terpilih = a;
      daftar.hidden = true;
      input.hidden = true;
      kosongkan(chip).tambahkan(
        h('span', { class: 'avatar kecil' }, inisial(a.namaLengkap || a.namaAnggota)),
        h('span', { class: 'isi' }, h('b', null, a.namaLengkap || a.namaAnggota), h('small', null, (a.nomorAnggota || '') + (opsi.info ? ' · ' + opsi.info(a) : ''))),
        h('button', { type: 'button', class: 'tombol kecil', onclick: () => { terpilih = null; chip.hidden = true; input.hidden = false; input.value = ''; input.focus(); if (opsi.onUbah) opsi.onUbah(null); } }, 'Ganti')
      );
      chip.hidden = false;
      if (opsi.onUbah) opsi.onUbah(a);
    }
    bungkus.nilai = () => terpilih;
    bungkus.pilih = pilih;
    return bungkus;
  }

  function barisPeriode(q, ke, opsi) {
    opsi = opsi || {};
    const mulai = h('input', { type: 'date', value: q.mulai || awalTahun() });
    const selesai = h('input', { type: 'date', value: q.selesai || hariIni() });
    const tanggal = h('input', { type: 'date', value: q.tanggal || hariIni() });
    const tampil = h('button', { class: 'tombol utama', type: 'button', onclick: () => ke(opsi.tunggal ? { tanggal: tanggal.value } : { mulai: mulai.value, selesai: selesai.value }) }, 'Tampilkan');
    return h(
      'div',
      { class: 'alat periode tanpa-cetak' },
      opsi.tunggal ? [h('span', { class: 'bantu' }, 'Per tanggal'), tanggal] : [h('span', { class: 'bantu' }, 'Periode'), mulai, h('span', { class: 'bantu' }, 's.d.'), selesai],
      opsi.ekstra || null,
      tampil,
      h('div', { class: 'isi' }),
      tombolCetak(),
      opsi.ekspor ? tombolEkspor(opsi.ekspor[0], opsi.ekspor[1]) : null
    );
  }
  const tombolCetak = () => h('button', { class: 'tombol', type: 'button', onclick: () => window.print() }, ikon('cetak'), 'Cetak');

  /**
   * Ekspor PDF / Excel / CSV — berkas dibuat oleh KOPKU Desktop dengan builder &
   * ExportService yang sama dengan tombol Export di aplikasi (kop koperasi, logo,
   * penanda tangan, format Rupiah). Tampil hanya bila peran punya izin Export.
   * @param {string} jenis jenis laporan (lihat /api/ekspor/:jenis)
   * @param {object|() => object} param filter yang sedang ditampilkan
   */
  function tombolEkspor(jenis, param) {
    if (!boleh('export', 'export')) return null;
    const FORMAT = [['PDF', 'PDF', 'pdf', 'Siap cetak, dengan kop koperasi'], ['EXCEL', 'Excel (.xlsx)', 'tabelIk', 'Untuk diolah lebih lanjut'], ['CSV', 'CSV', 'daftar', 'Data mentah, dipisah koma']];
    const isi = h('div', { class: 'menu-ekspor-isi', hidden: true, role: 'menu' });
    const btn = h('button', { class: 'tombol', type: 'button', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); document.querySelectorAll('.menu-ekspor-isi').forEach((x) => x !== isi && (x.hidden = true)); isi.hidden = !isi.hidden; } }, ikon('unduh'), 'Ekspor', ikon('bawah', 'kecil'));
    for (const [f, lbl, ik, ket] of FORMAT) {
      isi.appendChild(h('button', { type: 'button', role: 'menuitem', onclick: (e) => { e.stopPropagation(); isi.hidden = true; unduhEkspor(jenis, f, typeof param === 'function' ? param() : param, btn); } }, ikon(ik), h('span', null, h('b', null, lbl), h('small', null, ket))));
    }
    return h('div', { class: 'menu-ekspor tanpa-cetak' }, btn, isi);
  }
  async function unduhEkspor(jenis, format, param, btn) {
    const asli = Array.from(btn.childNodes);
    btn.disabled = true;
    kosongkan(btn).tambahkan(h('span', { class: 'putar' }), 'Menyiapkan ' + (format === 'EXCEL' ? 'Excel' : format) + '…');
    try {
      let res;
      try {
        res = await fetch('/api/ekspor/' + encodeURIComponent(jenis) + qs(Object.assign({ format }, param || {})), { credentials: 'same-origin', cache: 'no-store' });
      } catch (e) {
        setOnline(false);
        throw new Error('Server KOPKU tidak dapat dihubungi.');
      }
      if (res.status === 401) {
        location.hash = '#/masuk';
        throw new Error('Sesi berakhir. Silakan masuk lagi.');
      }
      if (!res.ok) {
        let j = null;
        try {
          j = await res.json();
        } catch (e) {
          j = null;
        }
        throw new Error((j && j.pesan) || 'Ekspor gagal.');
      }
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd);
      const nama = m ? decodeURIComponent(m[1]) : 'kopku-' + jenis;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: nama, hidden: true });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 4000);
      toast('Berkas ' + nama + ' diunduh.', 'sukses');
    } catch (e) {
      toast(pesanGalat(e), 'galat');
    } finally {
      btn.disabled = false;
      kosongkan(btn).tambahkan(asli);
    }
  }
  function tanpaIzin(judul) {
    const k = kerangka(judul);
    k.appendChild(h('div', { class: 'kosong besar' }, ikon('kunci', 'besar'), h('p', null, 'Anda tidak memiliki izin untuk membuka menu ini.'), h('p', { class: 'bantu' }, 'Izin mengikuti Permission Matrix di KOPKU Desktop (Pengaturan › Permission Matrix).')));
  }
  function formGalat() {
    return h('div', { class: 'pesan galat', hidden: true, role: 'alert' });
  }
  function tampilGalat(el, e) {
    el.textContent = pesanGalat(e);
    el.hidden = false;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  /** Tombol kirim form: cegah klik ganda; Idempotency-Key baru setelah sukses. */
  function kirimForm(form, tombol, galat, fn) {
    let kunci = kunciAcak();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      galat.hidden = true;
      tombol.disabled = true;
      try {
        await fn(kunci);
        kunci = kunciAcak();
      } catch (err) {
        tampilGalat(galat, err);
        if (err.kode === 'KONFLIK') kunci = kunciAcak();
      } finally {
        tombol.disabled = false;
      }
    });
  }

  // ============================================================ halaman: masuk
  function halamanMasuk() {
    const app = $('#app');
    app.className = '';
    const galat = formGalat();
    const u = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
    const p = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    const b = h('button', { class: 'tombol utama', type: 'submit' }, 'Masuk');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          galat.hidden = true;
          b.disabled = true;
          b.textContent = 'Memeriksa…';
          try {
            const r = await api('POST', '/api/auth/login', { username: u.value.trim(), password: p.value }, { tanpaRedirect: true });
            p.value = '';
            negara.csrf = r.csrf;
            await muatSesi();
            location.hash = '#/';
          } catch (err) {
            galat.textContent = pesanGalat(err);
            galat.hidden = false;
          } finally {
            b.disabled = false;
            b.textContent = 'Masuk';
          }
        },
      },
      galat,
      medan('Username', u),
      medan('Password', p),
      b
    );
    kosongkan(app).appendChild(
      h(
        'div',
        { class: 'layar-masuk' },
        h(
          'div',
          { class: 'panel-merek' },
          h('div', { class: 'brand-masuk' }, h('img', { src: '/logo.svg', alt: '' }), h('div', null, h('b', null, 'KOPKU'), h('small', null, 'Akuntansi Koperasi Simpan Pinjam'))),
          h('h2', null, 'Akses KOPKU dari perangkat mana pun di jaringan kantor.'),
          h('ul', null, h('li', null, 'Data langsung dari KOPKU Desktop di komputer server'), h('li', null, 'Menu & tombol mengikuti hak akses peran Anda'), h('li', null, 'Setiap transaksi tercatat atas nama Anda'))
        ),
        h(
          'div',
          { class: 'kotak-masuk' },
          h('h1', null, 'Masuk'),
          h('p', { class: 'sub' }, 'Gunakan username & password KOPKU Anda.'),
          form,
          h('p', { class: 'catatan' }, 'Akses LAN diberikan oleh Admin koperasi.' + (location.protocol === 'http:' ? ' Koneksi ini HTTP lokal: gunakan hanya di jaringan yang Anda percayai.' : ''))
        )
      )
    );
    u.focus();
  }

  async function muatSesi() {
    const s = await api('GET', '/api/auth/sesi', null, { tanpaRedirect: true });
    negara.user = s.user;
    negara.csrf = s.csrf;
    negara.menu = s.menu;
    negara.izin = s.izin;
    negara.koperasi = s.koperasi;
    rekeningCache = null;
  }

  // ============================================================ halaman: dashboard
  async function halamanDashboard() {
    const jam = new Date().getHours();
    const salam = jam < 11 ? 'Selamat pagi' : jam < 15 ? 'Selamat siang' : jam < 18 ? 'Selamat sore' : 'Selamat malam';
    const k = kerangka(salam + ', ' + negara.user.nama, negara.koperasi ? negara.koperasi.nama + (negara.koperasi.tahunBuku ? ' · Tahun buku ' + negara.koperasi.tahunBuku : '') : 'KOPKU');
    memuat(k);
    const d = await api('GET', '/api/dashboard');
    kosongkan(k);
    // aksi cepat sesuai izin
    const aksiCepat = [
      boleh('simpanan', 'create') && ['Setor Simpanan', '#/simpanan/setor', 'masuk'],
      boleh('pinjaman', 'create') && ['Bayar Angsuran', '#/pinjaman?kategori=AKTIF&bayar=1', 'struk'],
      boleh('pinjaman', 'create') && ['Ajukan Pinjaman', '#/pinjaman/baru', 'plus'],
      boleh('simpanan', 'create') && ['Tarik Sukarela', '#/simpanan/tarik', 'keluar'],
      boleh('kas_bank', 'create') && ['Kas Masuk', '#/kas/masuk', 'masuk'],
      boleh('kas_bank', 'create') && ['Kas Keluar', '#/kas/keluar', 'keluar'],
      boleh('anggota', 'create') && ['Anggota Baru', '#/anggota/baru', 'orang'],
      boleh('laporan', 'view') && ['Posisi Keuangan', '#/laporan/posisi', 'timbang'],
    ].filter(Boolean);
    const tiles = [];
    if (d.anggotaAktif != null) tiles.push(stat('Anggota aktif', angka(d.anggotaAktif), { ikon: 'orang', href: '#/anggota' }));
    if (d.simpanan) tiles.push(stat('Total simpanan', rp(d.simpanan.total), { ikon: 'dompet', href: '#/simpanan/saldo', sub: 'Pokok ' + rp(d.simpanan.pokok) + ' · Wajib ' + rp(d.simpanan.wajib) + ' · Sukarela ' + rp(d.simpanan.sukarela) }));
    if (d.pinjaman) {
      tiles.push(stat('Pinjaman aktif', angka(d.pinjaman.aktif), { ikon: 'uang', href: '#/pinjaman', sub: 'Sisa piutang ' + rp(d.pinjaman.sisaPiutang) }));
      tiles.push(stat('Angsuran tertunggak', angka(d.pinjaman.jumlahTunggakan), { ikon: 'peringatan', href: '#/tunggakan', nada: d.pinjaman.jumlahTunggakan ? 'waspada' : '', sub: rp(d.pinjaman.nilaiTunggakan) }));
      if (d.pinjaman.menungguPencairan) tiles.push(stat('Menunggu pencairan', angka(d.pinjaman.menungguPencairan), { ikon: 'jam', href: '#/pinjaman?kategori=BELUM_AKTIF' }));
    }
    if (d.rekening) {
      const total = d.rekening.reduce((t, r) => t + (r.saldo || 0), 0);
      tiles.push(stat('Saldo kas & bank', rp(total), { ikon: 'bank', href: '#/rekening', sub: d.rekening.map((r) => r.nama + ' ' + rp(r.saldo)).join(' · ') }));
    }
    k.tambahkan(
      aksiCepat.length ? h('div', { class: 'aksi-cepat' }, aksiCepat.map((a) => h('a', { class: 'aksi-item', href: a[1] }, h('span', { class: 'aksi-ikon' }, ikon(a[2])), a[0]))) : null,
      tiles.length ? h('div', { class: 'kisi' }, tiles) : null
    );
    const bawah = h('div', { class: 'dua-kolom' });
    if (d.kolektibilitas) {
      const total = d.kolektibilitas.reduce((t, x) => t + x.totalOutstanding, 0) || 1;
      bawah.appendChild(
        kartu(
          'Kolektibilitas piutang',
          h(
            'div',
            { class: 'batang-daftar' },
            d.kolektibilitas.map((x) => {
              const isi = h('div', { class: 'batang-isi ' + (x.kategori === 'LANCAR' ? '' : x.kategori === 'MACET' || x.kategori === 'DIRAGUKAN' ? 'merah' : 'kuning') });
              isi.style.width = Math.max(x.totalOutstanding ? 2 : 0, (x.totalOutstanding / total) * 100) + '%';
              return h('div', { class: 'batang' }, h('div', { class: 'batang-label' }, h('span', null, label(x.kategori)), h('small', null, x.jumlahPinjaman + ' pinjaman · ' + rp(x.totalOutstanding))), h('div', { class: 'batang-rel' }, isi));
            })
          ),
          h('a', { class: 'tautan', href: '#/laporan/kolektibilitas' }, 'Lihat rincian ›')
        )
      );
      bawah.appendChild(
        kartu(
          'Tunggakan terlama',
          tabel(['Pinjaman', 'Anggota', { t: 'Hari', c: 'angka' }, { t: 'Sisa', c: 'angka' }], d.pinjaman.tunggakanTeratas.map((t) => ({ klik: () => (location.hash = '#/pinjaman/' + t.pinjamanId), sel: [t.nomorPinjaman, t.namaAnggota, { t: t.hariTerlambat, c: 'angka' }, { t: rp(t.sisaTagihan), c: 'angka' }] })), { kosong: 'Tidak ada tunggakan. 👍' }),
          h('a', { class: 'tautan', href: '#/tunggakan' }, 'Semua tunggakan ›')
        )
      );
    }
    if (d.transaksiTerakhir) {
      bawah.appendChild(
        h(
          'section',
          { class: 'kartu penuh' },
          h('h2', null, 'Transaksi terakhir'),
          tabel(['Tanggal', 'Nomor', 'Jenis', { t: 'Keterangan', c: 'sembunyi-hp' }, { t: 'Nominal', c: 'angka' }, { t: 'Oleh', c: 'sembunyi-hp' }], d.transaksiTerakhir.map((t) => ({ klik: () => (location.hash = '#/history/' + t.journalId), sel: [tgl(t.tanggal), t.nomorTransaksi, t.jenisLabel, { t: t.deskripsi, c: 'sembunyi-hp' }, { t: rp(t.nominal), c: 'angka' }, { t: t.createdByNama, c: 'sembunyi-hp' }] }))),
          h('a', { class: 'tautan', href: '#/history' }, 'History transaksi ›')
        )
      );
    }
    if (bawah.childNodes.length) k.appendChild(bawah);
    if (!tiles.length && !aksiCepat.length) k.appendChild(kartu(null, h('p', null, 'Selamat datang. Pilih menu di samping sesuai hak akses Anda.')));
  }

  // ============================================================ DATA: anggota
  async function halamanAnggota(q) {
    if (!boleh('anggota')) return tanpaIzin('Anggota');
    const k = kerangka('Anggota', 'Data', { aksi: boleh('anggota', 'create') ? h('a', { class: 'tombol utama', href: '#/anggota/baru' }, ikon('plus'), 'Anggota baru') : null });
    const cari = h('input', { type: 'search', placeholder: 'Cari nama / nomor anggota / NIK', value: q.cari || '' });
    const status = h('select', null, h('option', { value: '' }, 'Semua status'), ['AKTIF', 'TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'].map((s) => h('option', { value: s }, label(s))));
    status.value = q.status || '';
    const hal = Number(q.halaman || 1);
    const ke = (p) => (location.hash = '#/anggota' + qs({ cari: cari.value, status: status.value, halaman: p }));
    cari.addEventListener('keydown', (e) => e.key === 'Enter' && ke(1));
    status.addEventListener('change', () => ke(1));
    const isi = h('div', { class: 'kartu' });
    k.tambahkan(h('div', { class: 'alat' }, h('div', { class: 'isi' }, cari), status, tombolEkspor('anggota', { cari: q.cari, status: q.status })), isi);
    memuat(isi);
    const d = await api('GET', '/api/anggota' + qs({ cari: q.cari, status: q.status, halaman: hal }));
    kosongkan(isi).tambahkan(
      tabel(['No. Anggota', 'Nama', { t: 'No. HP', c: 'sembunyi-hp' }, { t: 'Bergabung', c: 'sembunyi-hp' }, 'Status'], d.baris.map((a) => ({ klik: () => (location.hash = '#/anggota/' + a.id), sel: [a.nomorAnggota, a.namaLengkap, { t: a.nomorHp || '-', c: 'sembunyi-hp' }, { t: tgl(a.tanggalBergabung), c: 'sembunyi-hp' }, lencanaStatus(a.status)] }))),
      paginasi(hal, d.baris.length, ke)
    );
  }

  async function halamanAnggotaDetail(id, q) {
    if (!boleh('anggota')) return tanpaIzin('Detail Anggota');
    const k = kerangka('Detail Anggota', 'Data › Anggota', { kembali: '#/anggota' });
    memuat(k);
    const d = await api('GET', '/api/anggota/' + encodeURIComponent(id));
    const a = d.anggota;
    const tabAktif = q.tab || 'profil';
    kosongkan(k).tambahkan(
      h(
        'section',
        { class: 'kartu profil' },
        h('span', { class: 'avatar besar' }, inisial(a.namaLengkap)),
        h('div', { class: 'isi' }, h('h2', null, a.namaLengkap), h('div', { class: 'bantu' }, a.nomorAnggota + ' · bergabung ' + tgl(a.tanggalBergabung))),
        lencanaStatus(a.status),
        h(
          'div',
          { class: 'tombol-baris' },
          boleh('anggota', 'edit') ? h('a', { class: 'tombol', href: '#/anggota/' + a.id + '/ubah' }, ikon('pena'), 'Ubah') : null,
          boleh('simpanan', 'create') && a.status === 'AKTIF' ? h('a', { class: 'tombol', href: '#/simpanan/setor?anggota=' + a.id }, ikon('masuk'), 'Setor') : null,
          boleh('pinjaman', 'create') && a.status === 'AKTIF' ? h('a', { class: 'tombol', href: '#/pinjaman/baru?anggota=' + a.id }, ikon('plus'), 'Ajukan pinjaman') : null
        )
      ),
      h('div', { class: 'kisi' }, stat('Simpanan pokok', rp(d.saldoSimpanan.pokok)), stat('Simpanan wajib', rp(d.saldoSimpanan.wajib)), stat('Simpanan sukarela', rp(d.saldoSimpanan.sukarela)), stat('Total simpanan', rp(d.saldoSimpanan.total), { nada: 'utama' })),
      tab(
        [['profil', 'Profil'], ['pinjaman', 'Pinjaman (' + d.pinjaman.length + ')'], boleh('simpanan') && ['simpanan', 'Riwayat simpanan'], boleh('simpanan') && ['berjangka', 'Simpanan berjangka']].filter(Boolean),
        tabAktif,
        (t) => (location.hash = '#/anggota/' + a.id + qs({ tab: t }))
      )
    );
    const isi = h('div', { class: 'kartu' });
    k.appendChild(isi);
    if (tabAktif === 'profil') {
      isi.tambahkan(
        dl([
          ['NIK', a.nik],
          ['Jenis kelamin', a.jenisKelamin ? (a.jenisKelamin === 'LAKI_LAKI' ? 'Laki-laki' : 'Perempuan') : '-'],
          ['Tempat, tgl lahir', (a.tempatLahir || '-') + ', ' + tgl(a.tanggalLahir)],
          ['Alamat', a.alamat],
          ['No. HP / WhatsApp', a.nomorHp],
          ['Pekerjaan', a.pekerjaan],
          ['Catatan', a.catatan],
        ])
      );
    } else if (tabAktif === 'pinjaman') {
      isi.tambahkan(tabelPinjaman(d.pinjaman));
    } else if (tabAktif === 'simpanan') {
      memuat(isi);
      const s = await api('GET', '/api/simpanan' + qs({ anggotaId: a.id }));
      kosongkan(isi).tambahkan(tabelSimpanan(s.baris, true));
    } else if (tabAktif === 'berjangka') {
      memuat(isi);
      const b = await api('GET', '/api/simpanan-berjangka' + qs({ anggotaId: a.id }));
      kosongkan(isi).tambahkan(tabelBerjangka(b, true));
    }
  }

  async function halamanAnggotaForm(id) {
    const ubah = !!id;
    if (!boleh('anggota', ubah ? 'edit' : 'create')) return tanpaIzin(ubah ? 'Ubah Anggota' : 'Anggota Baru');
    const k = kerangka(ubah ? 'Ubah Anggota' : 'Anggota Baru', 'Data › Anggota', { kembali: ubah ? '#/anggota/' + id : '#/anggota' });
    let versi = null;
    let a = { tanggalBergabung: hariIni() };
    if (ubah) {
      const d = await api('GET', '/api/anggota/' + encodeURIComponent(id));
      a = d.anggota;
      versi = d.versi;
    }
    const f = {
      namaLengkap: h('input', { type: 'text', value: a.namaLengkap || '', required: true, maxlength: 150 }),
      nik: h('input', { type: 'text', value: a.nik || '', maxlength: 32, inputmode: 'numeric' }),
      jenisKelamin: h('select', null, h('option', { value: '' }, '- belum diisi -'), h('option', { value: 'LAKI_LAKI' }, 'Laki-laki'), h('option', { value: 'PEREMPUAN' }, 'Perempuan')),
      tempatLahir: h('input', { type: 'text', value: a.tempatLahir || '', maxlength: 100 }),
      tanggalLahir: h('input', { type: 'date', value: a.tanggalLahir || '' }),
      nomorHp: h('input', { type: 'tel', value: a.nomorHp || '', maxlength: 20, placeholder: '08xxxxxxxxxx' }),
      pekerjaan: h('input', { type: 'text', value: a.pekerjaan || '', maxlength: 100 }),
      tanggalBergabung: h('input', { type: 'date', value: a.tanggalBergabung || '', required: true }),
      alamat: h('textarea', { rows: 2, maxlength: 300 }),
      catatan: h('textarea', { rows: 2, maxlength: 500 }),
    };
    f.jenisKelamin.value = a.jenisKelamin || '';
    f.alamat.value = a.alamat || '';
    f.catatan.value = a.catatan || '';
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan');
    const form = h(
      'form',
      { class: 'kartu' },
      galat,
      h('div', { class: 'form-kisi' }, medan('Nama lengkap *', f.namaLengkap), medan('NIK', f.nik), medan('Jenis kelamin', f.jenisKelamin), medan('Tempat lahir', f.tempatLahir), medan('Tanggal lahir', f.tanggalLahir), medan('Nomor HP / WhatsApp', f.nomorHp, 'Dipakai untuk WhatsApp Reminder.'), medan('Pekerjaan', f.pekerjaan), medan('Tanggal bergabung *', f.tanggalBergabung)),
      medan('Alamat', f.alamat),
      medan('Catatan', f.catatan),
      h('div', { class: 'alat akhir' }, h('a', { class: 'tombol', href: ubah ? '#/anggota/' + id : '#/anggota' }, 'Batal'), simpan)
    );
    kirimForm(form, simpan, galat, async (kunci) => {
      const data = {};
      for (const n of Object.keys(f)) data[n] = f[n].value.trim() === '' ? null : f[n].value.trim();
      if (ubah) {
        await api('PUT', '/api/anggota/' + encodeURIComponent(id), { versi, data }, { kunci });
        sukses({ judul: 'Perubahan data anggota tersimpan', nomor: a.nomorAnggota, labelNomor: 'Nomor anggota', baris: [['Nama lengkap', data.namaLengkap], ['NIK', data.nik], ['No. HP / WhatsApp', data.nomorHp], ['Tanggal bergabung', tgl(data.tanggalBergabung)]] }, '#/anggota/' + id);
      } else {
        const r = await api('POST', '/api/anggota', data, { kunci });
        sukses({ judul: 'Anggota baru tersimpan', nomor: r.nomorAnggota, labelNomor: 'Nomor anggota', baris: [['Nama lengkap', data.namaLengkap], ['NIK', data.nik], ['No. HP / WhatsApp', data.nomorHp], ['Tanggal bergabung', tgl(data.tanggalBergabung)]], aksi: boleh('simpanan', 'create') ? [{ label: 'Setor simpanan', href: '#/simpanan/setor?anggota=' + r.id }, { label: 'Tambah anggota lagi', href: '#/anggota/baru' }] : [{ label: 'Tambah anggota lagi', href: '#/anggota/baru' }] }, '#/anggota/' + r.id);
      }
    });
    k.appendChild(form);
    f.namaLengkap.focus();
  }

  // ---- personel
  async function halamanPersonel(q) {
    if (!boleh('anggota')) return tanpaIzin('Pengurus & Pengawas');
    const k = kerangka('Pengurus & Pengawas', 'Data');
    const jenis = q.jenis || 'PENGURUS';
    k.tambahkan(tab([['PENGURUS', 'Pengurus'], ['PENGAWAS', 'Pengawas'], ['PENGELOLA', 'Pengelola'], ['KARYAWAN', 'Karyawan'], ['PEKERJA', 'Pekerja']], jenis, (t) => (location.hash = '#/personel' + qs({ jenis: t }))));
    const isi = h('div', { class: 'kartu' });
    k.appendChild(isi);
    memuat(isi);
    const d = await api('GET', '/api/personel' + qs({ jenis }));
    kosongkan(isi).tambahkan(
      tabel(['Nama', 'Jabatan', { t: 'Mulai', c: 'sembunyi-hp' }, { t: 'Berakhir', c: 'sembunyi-hp' }, { t: 'Telepon', c: 'sembunyi-hp' }, 'Status'], d.map((p) => ({ sel: [p.nama, p.jabatan || '-', { t: tgl(p.tanggalMulaiJabatan), c: 'sembunyi-hp' }, { t: tgl(p.tanggalBerakhirJabatan), c: 'sembunyi-hp' }, { t: p.nomorTelepon || '-', c: 'sembunyi-hp' }, lencanaStatus(p.statusAktif ? 'AKTIF' : 'TIDAK_AKTIF')] })), { kosong: 'Belum ada data. Data organisasi diisi di KOPKU Desktop › Data.' })
    );
  }

  // ---- daftar akun
  async function halamanAkun(q) {
    if (!boleh('pengaturan')) return tanpaIzin('Daftar Akun');
    const k = kerangka('Daftar Akun (COA)', 'Data');
    const cari = h('input', { type: 'search', placeholder: 'Cari kode atau nama akun', value: q.cari || '' });
    const status = h('select', null, h('option', { value: 'AKTIF' }, 'Aktif'), h('option', { value: 'NONAKTIF' }, 'Nonaktif'), h('option', { value: '' }, 'Semua'));
    status.value = q.status != null ? q.status : 'AKTIF';
    const ke = () => (location.hash = '#/akun' + qs({ cari: cari.value, status: status.value || 'semua' }));
    cari.addEventListener('keydown', (e) => e.key === 'Enter' && ke());
    status.addEventListener('change', ke);
    const isi = h('div', { class: 'kartu' });
    k.tambahkan(h('div', { class: 'alat' }, h('div', { class: 'isi' }, cari), status, tombolCetak()), isi);
    memuat(isi);
    const d = await api('GET', '/api/akun' + qs({ cari: q.cari, status: status.value === 'semua' ? '' : status.value }));
    const grup = {};
    for (const a of d) (grup[a.kategori] = grup[a.kategori] || []).push(a);
    kosongkan(isi);
    if (!d.length) isi.appendChild(h('div', { class: 'kosong' }, 'Tidak ada akun.'));
    for (const [kat, list] of Object.entries(grup)) {
      isi.tambahkan(h('h3', { class: 'subjudul' }, label(kat) + ' (' + list.length + ')'), tabel(['Kode', 'Nama akun', { t: 'Induk', c: 'sembunyi-hp' }, { t: 'Saldo normal', c: 'sembunyi-hp' }, ''], list.map((a) => ({ sel: [h('code', null, a.kode), a.nama, { t: a.parentNama || '-', c: 'sembunyi-hp' }, { t: a.normalBalance, c: 'sembunyi-hp' }, h('span', null, a.isSystem ? h('span', { class: 'lencana abu polos' }, 'sistem') : '', a.isActive ? '' : h('span', { class: 'lencana kuning polos' }, 'nonaktif'))] }))));
    }
  }

  // ---- rekening
  async function halamanRekening() {
    if (!boleh('kas_bank')) return tanpaIzin('Data Bank & Kas');
    const k = kerangka('Data Bank & Kas', 'Data');
    memuat(k);
    const d = await api('GET', '/api/kas/rekening');
    const total = d.filter((r) => r.aktif).reduce((t, r) => t + r.saldo, 0);
    kosongkan(k).tambahkan(
      h('div', { class: 'kisi' }, d.filter((r) => r.aktif).map((r) => stat(r.nama, rp(r.saldo), { ikon: r.jenis === 'BANK' ? 'bank' : 'dompet', href: '#/kas' + qs({ rek: r.jenis + '|' + r.id }), sub: r.jenis === 'BANK' ? 'a.n. ' + (r.namaPemilik || '-') : r.jenis === 'KAS' ? 'Kas tunai' : 'Kas kecil' })), stat('Total kas & bank', rp(total), { nada: 'utama' })),
      kartu('Rekening', tabel(['Rekening', 'Jenis', { t: 'No. rekening', c: 'sembunyi-hp' }, { t: 'Saldo', c: 'angka' }, 'Status'], d.map((r) => ({ klik: () => (location.hash = '#/kas' + qs({ rek: r.jenis + '|' + r.id })), sel: [r.nama, label(r.jenis), { t: r.nomorRekening || '-', c: 'sembunyi-hp' }, { t: rp(r.saldo), c: 'angka' }, lencanaStatus(r.aktif ? 'AKTIF' : 'TIDAK_AKTIF')] })))),
      h('div', { class: 'alat' }, h('p', { class: 'bantu isi' }, 'Rekening bank baru ditambahkan di KOPKU Desktop › Data › Data Bank.'), tombolEkspor('data-bank', {}))
    );
  }

  // ============================================================ TRANSAKSI: simpanan
  function tabelSimpanan(baris, tanpaNama) {
    return tabel(
      ['Tanggal', 'Nomor', tanpaNama ? null : 'Anggota', 'Jenis', 'Tipe', { t: 'Nominal', c: 'angka' }, { t: 'Keterangan', c: 'sembunyi-hp' }].filter(Boolean),
      baris.map((s) => ({ sel: [tgl(s.tanggal), s.nomorTransaksi, tanpaNama ? null : s.namaAnggota, label(s.jenis), lencanaStatus(s.tipe), { t: (s.tipe === 'TARIK' ? '-' : '') + rp(s.nominal), c: 'angka' + (s.tipe === 'TARIK' ? ' negatif' : '') }, { t: s.keterangan || '', c: 'sembunyi-hp' }].filter((x) => x !== null) }))
    );
  }
  async function halamanSimpanan(q) {
    if (!boleh('simpanan')) return tanpaIzin('Riwayat Simpanan');
    const k = kerangka('Riwayat Simpanan', 'Transaksi › Simpanan', { aksi: boleh('simpanan', 'create') ? h('div', { class: 'tombol-baris' }, h('a', { class: 'tombol', href: '#/simpanan/tarik' }, ikon('keluar'), 'Tarik'), h('a', { class: 'tombol utama', href: '#/simpanan/setor' }, ikon('masuk'), 'Setor')) : null });
    const jenis = q.jenis || '';
    const hal = Number(q.halaman || 1);
    k.tambahkan(h('div', { class: 'alat' }, tab([['', 'Semua'], ['POKOK', 'Pokok'], ['WAJIB', 'Wajib'], ['SUKARELA', 'Sukarela']], jenis, (t) => (location.hash = '#/simpanan' + qs({ jenis: t }))), h('div', { class: 'isi' }), tombolEkspor('simpanan', { jenis })));
    const isi = h('div', { class: 'kartu' });
    k.appendChild(isi);
    memuat(isi);
    const d = await api('GET', '/api/simpanan' + qs({ jenis, halaman: hal }));
    kosongkan(isi).tambahkan(tabelSimpanan(d.baris), paginasi(hal, d.baris.length, (p) => (location.hash = '#/simpanan' + qs({ jenis, halaman: p }))));
  }
  async function halamanSaldoSimpanan(q) {
    if (!boleh('simpanan')) return tanpaIzin('Saldo Simpanan');
    const k = kerangka('Saldo Simpanan Anggota', 'Transaksi › Simpanan');
    const cari = h('input', { type: 'search', placeholder: 'Cari nama / nomor anggota', value: q.cari || '' });
    cari.addEventListener('keydown', (e) => e.key === 'Enter' && (location.hash = '#/simpanan/saldo' + qs({ cari: cari.value })));
    const isi = h('div', { class: 'kartu' });
    k.tambahkan(h('div', { class: 'alat' }, h('div', { class: 'isi' }, cari), tombolCetak()), isi);
    memuat(isi);
    const d = await api('GET', '/api/simpanan/saldo' + qs({ cari: q.cari }));
    const tot = d.reduce((t, x) => ({ pokok: t.pokok + x.pokok, wajib: t.wajib + x.wajib, sukarela: t.sukarela + x.sukarela, total: t.total + x.total }), { pokok: 0, wajib: 0, sukarela: 0, total: 0 });
    kosongkan(isi).tambahkan(
      tabel(
        ['No.', 'Anggota', { t: 'Pokok', c: 'angka sembunyi-hp' }, { t: 'Wajib', c: 'angka sembunyi-hp' }, { t: 'Sukarela', c: 'angka' }, { t: 'Total', c: 'angka' }],
        d.map((x) => ({ klik: boleh('anggota') ? () => (location.hash = '#/anggota/' + x.anggotaId + '?tab=simpanan') : null, sel: [x.nomorAnggota, x.namaAnggota, { t: rp(x.pokok), c: 'angka sembunyi-hp' }, { t: rp(x.wajib), c: 'angka sembunyi-hp' }, { t: rp(x.sukarela), c: 'angka' }, { t: rp(x.total), c: 'angka tebal' }] })),
        { kaki: ['', 'Total (' + d.length + ' anggota)', { t: rp(tot.pokok), c: 'angka sembunyi-hp' }, { t: rp(tot.wajib), c: 'angka sembunyi-hp' }, { t: rp(tot.sukarela), c: 'angka' }, { t: rp(tot.total), c: 'angka' }] }
      )
    );
  }

  async function halamanSetorSimpanan(q) {
    if (!boleh('simpanan', 'create')) return tanpaIzin('Setor Simpanan');
    const k = kerangka('Setor Simpanan', 'Transaksi › Simpanan', { kembali: '#/simpanan' });
    const sd = await pilihSumberDana();
    const ang = pilihAnggota({});
    const jenis = h('select', null, h('option', { value: 'WAJIB' }, 'Simpanan Wajib'), h('option', { value: 'SUKARELA' }, 'Simpanan Sukarela'), h('option', { value: 'POKOK' }, 'Simpanan Pokok'));
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni(), required: true });
    const periode = h('input', { type: 'month', value: hariIni().slice(0, 7) });
    const nominal = inputRupiah();
    const ket = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional' });
    const medanPeriode = medan('Periode wajib', periode, 'Bulan simpanan wajib yang dibayar.');
    jenis.addEventListener('change', () => (medanPeriode.hidden = jenis.value !== 'WAJIB'));
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan setoran');
    const form = h(
      'form',
      { class: 'kartu form-transaksi' },
      galat,
      medan('Anggota *', ang, null, { lebar: true }),
      h('div', { class: 'form-kisi' }, medan('Jenis simpanan', jenis), medanPeriode, medan('Tanggal', tanggal), medan('Nominal *', nominal), medan('Sumber dana', sd.el), medan('Keterangan', ket)),
      h('div', { class: 'alat akhir' }, simpan)
    );
    kirimForm(form, simpan, galat, async (kunci) => {
      const a = ang.nilai();
      if (!a) throw new Error('Pilih anggota terlebih dahulu.');
      const n = nominal.nilai();
      const r = await api('POST', '/api/simpanan/setor', Object.assign({ anggotaId: a.id, jenis: jenis.value, tanggal: tanggal.value, nominal: n, periode: jenis.value === 'WAJIB' ? periode.value : undefined, keterangan: ket.value.trim() || undefined }, sd.nilai()), { kunci });
      sukses({
        judul: 'Setoran simpanan tersimpan',
        nomor: r && r.nomorTransaksi,
        baris: [['Anggota', (a.namaLengkap || a.namaAnggota) + (a.nomorAnggota ? ' (' + a.nomorAnggota + ')' : '')], ['Jenis simpanan', teksPilihan(jenis)], jenis.value === 'WAJIB' ? ['Periode wajib', periode.value] : null, ['Tanggal', tgl(tanggal.value)], ['Nominal', h('b', null, rp(n))], ['Sumber dana', sd.label()], ket.value.trim() ? ['Keterangan', ket.value.trim()] : null],
        aksi: [{ label: 'Lihat riwayat', href: '#/simpanan' }],
        labelOk: 'Input setoran lagi',
        fokus: () => nominal.input.focus(),
      });
      nominal.set('');
      ket.value = '';
    });
    k.appendChild(form);
    if (q.anggota) {
      try {
        const d = await api('GET', '/api/anggota/' + encodeURIComponent(q.anggota));
        ang.pilih(d.anggota);
      } catch (e) {
        /* abaikan */
      }
    }
  }

  async function halamanTarikSimpanan() {
    if (!boleh('simpanan', 'create')) return tanpaIzin('Tarik Simpanan Sukarela');
    const k = kerangka('Tarik Simpanan Sukarela', 'Transaksi › Simpanan', { kembali: '#/simpanan' });
    const sd = await pilihSumberDana();
    const infoSaldo = h('div', { class: 'pesan info', hidden: true });
    const ang = pilihAnggota({
      sumber: async (q2) => api('GET', '/api/simpanan/sukarela-tersedia' + qs({ cari: q2 })),
      info: (a) => 'saldo sukarela ' + rp(a.saldoSukarela),
      onUbah: (a) => {
        infoSaldo.hidden = !a;
        if (a) infoSaldo.textContent = 'Saldo sukarela tersedia: ' + rp(a.saldoSukarela);
      },
    });
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const nominal = inputRupiah();
    const ket = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional' });
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan penarikan');
    const form = h('form', { class: 'kartu form-transaksi' }, galat, medan('Anggota (hanya yang punya saldo sukarela) *', ang, null, { lebar: true }), infoSaldo, h('div', { class: 'form-kisi' }, medan('Tanggal', tanggal), medan('Nominal ditarik *', nominal), medan('Dibayar dari', sd.el), medan('Keterangan', ket)), h('p', { class: 'bantu' }, 'Hanya simpanan sukarela yang dapat ditarik. Saldo & kecukupan kas diperiksa ulang oleh server saat menyimpan.'), h('div', { class: 'alat akhir' }, simpan));
    kirimForm(form, simpan, galat, async (kunci) => {
      const a = ang.nilai();
      if (!a) throw new Error('Pilih anggota terlebih dahulu.');
      const n = nominal.nilai();
      const r = await api('POST', '/api/simpanan/tarik', Object.assign({ anggotaId: a.id, tanggal: tanggal.value, nominal: n, keterangan: ket.value.trim() || undefined }, sd.nilai()), { kunci });
      sukses({ judul: 'Penarikan simpanan sukarela tersimpan', nomor: r && r.nomorTransaksi, baris: [['Anggota', (a.namaLengkap || a.namaAnggota) + (a.nomorAnggota ? ' (' + a.nomorAnggota + ')' : '')], ['Tanggal', tgl(tanggal.value)], ['Nominal ditarik', h('b', null, rp(n))], ['Dibayar dari', sd.label()], ket.value.trim() ? ['Keterangan', ket.value.trim()] : null], aksi: [{ label: 'Tarik lagi', href: '#/simpanan/tarik' }] }, '#/simpanan?jenis=SUKARELA');
    });
    k.appendChild(form);
  }

  function tabelBerjangka(list, tanpaNama) {
    return tabel(
      ['Nomor', tanpaNama ? null : 'Anggota', 'Mulai', 'Jatuh tempo', { t: 'Tenor', c: 'sembunyi-hp' }, { t: 'Bunga/th', c: 'angka sembunyi-hp' }, { t: 'Pokok', c: 'angka' }, { t: 'Bunga terakru', c: 'angka sembunyi-hp' }, 'Status'].filter(Boolean),
      list.map((x) => ({ sel: [x.nomorTransaksi, tanpaNama ? null : (x.namaAnggota || '-') + (x.nomorAnggota ? ' (' + x.nomorAnggota + ')' : ''), tgl(x.tanggalMulai), tgl(x.tanggalJatuhTempo), { t: x.tenorBulan + ' bln', c: 'sembunyi-hp' }, { t: x.sukuBungaPerTahun + '%', c: 'angka sembunyi-hp' }, { t: rp(x.nominal), c: 'angka' }, { t: rp(x.bungaTerakru), c: 'angka sembunyi-hp' }, lencanaStatus(x.status)].filter((y) => y !== null) })),
      { kosong: 'Belum ada simpanan berjangka.' }
    );
  }
  async function halamanBerjangka() {
    if (!boleh('simpanan')) return tanpaIzin('Simpanan Berjangka');
    const k = kerangka('Simpanan Berjangka', 'Transaksi › Simpanan');
    memuat(k);
    const d = await api('GET', '/api/simpanan-berjangka');
    const aktif = d.filter((x) => x.status === 'AKTIF' || x.status === 'JATUH_TEMPO');
    kosongkan(k).tambahkan(
      h('div', { class: 'kisi' }, stat('Kontrak aktif', angka(aktif.length), { ikon: 'jam' }), stat('Total pokok aktif', rp(aktif.reduce((t, x) => t + x.nominal, 0)), { ikon: 'dompet' }), stat('Bunga terakru', rp(aktif.reduce((t, x) => t + (x.bungaTerakru || 0), 0)))),
      kartu(null, tabelBerjangka(d)),
      h('p', { class: 'bantu' }, 'Penempatan & pencairan simpanan berjangka diproses di KOPKU Desktop (kebijakan produk & bunga).')
    );
  }

  // ============================================================ TRANSAKSI: pinjaman
  function tabelPinjaman(baris) {
    return tabel(
      ['No. Pinjaman', 'Anggota', { t: 'Pokok', c: 'angka sembunyi-hp' }, { t: 'Tenor', c: 'sembunyi-hp' }, { t: 'Sisa piutang', c: 'angka' }, { t: 'Jatuh tempo', c: 'sembunyi-hp' }, 'Status'],
      baris.map((p) => ({ klik: () => (location.hash = '#/pinjaman/' + p.id), sel: [p.nomorPinjaman, p.namaAnggota, { t: rp(p.jumlahPinjaman), c: 'angka sembunyi-hp' }, { t: p.tenor + ' ' + String(p.satuanTenor || '').toLowerCase(), c: 'sembunyi-hp' }, { t: rp(p.sisaPiutang), c: 'angka' }, { t: tgl(p.tanggalJatuhTempo), c: 'sembunyi-hp' }, lencanaStatus(p.status)] })),
      { kosong: 'Tidak ada pinjaman.' }
    );
  }
  async function halamanPinjaman(q) {
    if (!boleh('pinjaman')) return tanpaIzin('Pinjaman Anggota');
    const k = kerangka('Pinjaman Anggota', 'Transaksi › Pinjaman', { aksi: boleh('pinjaman', 'create') ? h('a', { class: 'tombol utama', href: '#/pinjaman/baru' }, ikon('plus'), 'Ajukan pinjaman') : null });
    const kat = q.kategori || 'AKTIF';
    const hal = Number(q.halaman || 1);
    const cari = h('input', { type: 'search', placeholder: 'Cari nomor pinjaman / nama anggota', value: q.cari || '' });
    const ke = (p, kk) => (location.hash = '#/pinjaman' + qs({ cari: cari.value, kategori: kk || kat, halaman: p, bayar: q.bayar }));
    cari.addEventListener('keydown', (e) => e.key === 'Enter' && ke(1));
    k.tambahkan(tab([['AKTIF', 'Aktif'], ['BELUM_AKTIF', 'Pengajuan'], ['DIBATALKAN', 'Dibatalkan'], ['semua', 'Semua']], kat, (t) => ke(1, t)), h('div', { class: 'alat' }, h('div', { class: 'isi' }, cari), tombolEkspor('pinjaman', { cari: q.cari, kategori: kat })));
    if (q.bayar && boleh('pinjaman', 'create')) k.appendChild(h('div', { class: 'pesan info' }, 'Untuk membayar angsuran atau melunasi: buka pinjaman, lalu tekan Bayar pada baris angsuran.'));
    const isi = h('div', { class: 'kartu' });
    k.appendChild(isi);
    memuat(isi);
    const d = await api('GET', '/api/pinjaman' + qs({ cari: q.cari, kategori: kat === 'semua' ? '' : kat, halaman: hal }));
    kosongkan(isi).tambahkan(tabelPinjaman(d.baris), paginasi(hal, d.baris.length, (p) => ke(p)));
  }

  async function halamanPinjamanDetail(id) {
    if (!boleh('pinjaman')) return tanpaIzin('Detail Pinjaman');
    const k = kerangka('Detail Pinjaman', 'Transaksi › Pinjaman', { kembali: '#/pinjaman' });
    memuat(k);
    const d = await api('GET', '/api/pinjaman/' + encodeURIComponent(id));
    const p = d.pinjaman;
    const belumCair = p.status === 'DIAJUKAN' || p.status === 'DISETUJUI';
    const totalJadwal = d.jadwal.reduce((t, j) => t + j.total, 0);
    const terbayar = d.jadwal.reduce((t, j) => t + j.pokokTerbayar + j.jasaTerbayar, 0);
    const tombol = [
      belumCair && boleh('pinjaman', 'approve') ? h('button', { class: 'tombol utama', type: 'button', onclick: () => dialogCairkan(p, d.versi) }, ikon('uang'), 'Cairkan') : null,
      belumCair && boleh('pinjaman', 'edit') ? h('button', { class: 'tombol', type: 'button', onclick: () => dialogBatalkan(p) }, ikon('silang'), 'Batalkan') : null,
      p.status === 'AKTIF' && boleh('pinjaman', 'create') ? h('button', { class: 'tombol', type: 'button', onclick: () => dialogPelunasan(p) }, ikon('centang'), 'Pelunasan…') : null,
    ];
    kosongkan(k).tambahkan(
      h('section', { class: 'kartu profil' }, h('span', { class: 'avatar besar' }, inisial(p.namaAnggota)), h('div', { class: 'isi' }, h('h2', null, p.nomorPinjaman), h('div', { class: 'bantu' }, p.namaAnggota + ' (' + p.nomorAnggota + ')')), lencanaStatus(p.status), h('div', { class: 'tombol-baris' }, tombol)),
      belumCair ? h('div', { class: 'pesan peringatan' }, 'Pinjaman belum dicairkan. Jadwal di bawah adalah rencana angsuran.') : null,
      h('div', { class: 'kisi' }, stat('Jumlah pinjaman', rp(p.jumlahPinjaman), { ikon: 'uang' }), stat('Total angsuran', rp(totalJadwal)), stat('Sudah dibayar', rp(terbayar)), stat('Sisa pokok + jasa', rp(totalJadwal - terbayar), { nada: 'utama' })),
      kartu(
        'Ketentuan',
        dl([
          ['Tanggal pengajuan', tgl(p.tanggal)],
          ['Tenor', p.tenor + ' ' + String(p.satuanTenor).toLowerCase()],
          ['Metode jasa', label(p.metodeJasa) + ' · ' + p.persentaseJasa + '% per periode'],
          ['Biaya administrasi', p.biayaAdminTipe === 'TIDAK_ADA' ? 'Tidak ada' : p.biayaAdminTipe === 'PERSENTASE' ? p.biayaAdminNilai + '%' : rp(p.biayaAdminNilai)],
          ['Denda', p.dendaAktif ? label(p.dendaTipe) + ' · ' + rp(p.dendaNilai) : 'Tidak aktif'],
          ['Tujuan', p.tujuanPinjaman ? label(p.tujuanPinjaman) + (p.tujuanDetail ? ' — ' + p.tujuanDetail : '') : '-'],
          ['Jatuh tempo akhir', tgl(p.tanggalJatuhTempo)],
          p.agunan && p.agunan.length ? ['Agunan', p.agunan.map((a) => label(a.jenisAgunan) + ' · ' + a.nomorDokumen + ' · ' + rp(a.nilaiAgunan)).join('; ')] : null,
          ['Keterangan', p.keterangan],
        ])
      ),
      kartu(
        h('span', { class: 'judul-dengan-aksi' }, 'Jadwal angsuran', belumCair ? null : tombolEkspor('angsuran', { pinjaman: p.id })),
        tabel(
          ['Ke', 'Jatuh tempo', { t: 'Pokok', c: 'angka sembunyi-hp' }, { t: 'Jasa', c: 'angka sembunyi-hp' }, { t: 'Total', c: 'angka' }, { t: 'Terbayar', c: 'angka sembunyi-hp' }, 'Status', ''],
          d.jadwal.map((j) => ({
            sel: [
              j.nomorAngsuran,
              tgl(j.tanggalJatuhTempo),
              { t: rp(j.pokok), c: 'angka sembunyi-hp' },
              { t: rp(j.jasa), c: 'angka sembunyi-hp' },
              { t: rp(j.total), c: 'angka' },
              { t: rp(j.pokokTerbayar + j.jasaTerbayar), c: 'angka sembunyi-hp' },
              lencanaStatus(j.status),
              j.bisaDibayar && boleh('pinjaman', 'create') ? h('button', { class: 'tombol kecil utama', type: 'button', onclick: (e) => { e.stopPropagation(); dialogBayar(p, j); } }, 'Bayar') : '',
            ],
          })),
          { kaki: ['', 'Total', { t: rp(d.jadwal.reduce((t, j) => t + j.pokok, 0)), c: 'angka sembunyi-hp' }, { t: rp(d.jadwal.reduce((t, j) => t + j.jasa, 0)), c: 'angka sembunyi-hp' }, { t: rp(totalJadwal), c: 'angka' }, { t: rp(terbayar), c: 'angka sembunyi-hp' }, '', ''] }
        )
      )
    );
  }

  async function dialogBayar(p, j) {
    const sd = await pilihSumberDana();
    const sisa = j.total - j.pokokTerbayar - j.jasaTerbayar;
    const tanggal = h('input', { type: 'date', value: hariIni(), required: true });
    const nominal = inputRupiah(sisa);
    const galat = formGalat();
    const kunci = kunciAcak();
    dialog(
      'Bayar angsuran ke-' + j.nomorAngsuran,
      h('div', null, h('div', { class: 'pesan info' }, p.nomorPinjaman + ' · ' + p.namaAnggota + ' · sisa pokok+jasa ' + rp(sisa) + '. Denda (bila ada) dihitung server KOPKU sesuai tanggal bayar.'), galat, medan('Tanggal bayar', tanggal), medan('Nominal', nominal), medan('Sumber dana', sd.el)),
      (tutup) => {
        const ok = h('button', {
          class: 'tombol utama',
          type: 'button',
          onclick: async () => {
            ok.disabled = true;
            galat.hidden = true;
            try {
              const r = await api('POST', '/api/pinjaman/' + p.id + '/angsuran/' + j.id + '/bayar', Object.assign({ tanggal: tanggal.value, nominal: nominal.nilai(), versiJadwal: j.versi }, sd.nilai()), { kunci });
              tutup();
              const tot = (r.porsiPokok || 0) + (r.porsiJasa || 0) + (r.porsiDenda || 0);
              sukses({ judul: 'Pembayaran angsuran tersimpan', nomor: r.nomorTransaksi || p.nomorPinjaman, labelNomor: r.nomorTransaksi ? 'Nomor transaksi' : 'Nomor pinjaman', baris: [['Anggota', p.namaAnggota + ' (' + p.nomorAnggota + ')'], ['Pinjaman', p.nomorPinjaman + ' · angsuran ke-' + j.nomorAngsuran], ['Tanggal bayar', tgl(tanggal.value)], ['Pokok', rp(r.porsiPokok)], ['Jasa', rp(r.porsiJasa)], r.porsiDenda ? ['Denda', rp(r.porsiDenda)] : null, ['Total diterima', h('b', null, rp(tot || nominal.nilai()))], ['Diterima di', sd.label()]], muatUlang: true });
            } catch (e) {
              tampilGalat(galat, e);
              ok.disabled = e.kode === 'KONFLIK';
            }
          },
        }, 'Simpan pembayaran');
        return [h('button', { class: 'tombol', type: 'button', onclick: tutup }, 'Batal'), ok];
      }
    );
  }

  async function dialogPelunasan(p) {
    const sd = await pilihSumberDana();
    const tanggal = h('input', { type: 'date', value: hariIni() });
    const metode = h('select', null, h('option', { value: 'JASA_KONTRAKTUAL' }, 'Jasa kontraktual (seluruh sisa jasa)'), h('option', { value: 'JASA_TERUTANG' }, 'Jasa terutang (jasa jatuh tempo saja)'));
    const ringkas = h('div', { class: 'pesan info' }, 'Tekan "Hitung" untuk menghitung total pelunasan dari server.');
    const galat = formGalat();
    let hitung = null;
    const kunci = kunciAcak();
    const proses = h('button', { class: 'tombol bahaya', type: 'button', disabled: true }, 'Proses pelunasan');
    const hitungBtn = h('button', {
      class: 'tombol',
      type: 'button',
      onclick: async () => {
        galat.hidden = true;
        try {
          hitung = await api('GET', '/api/pinjaman/' + p.id + '/pelunasan' + qs({ tanggal: tanggal.value, metode: metode.value }));
          kosongkan(ringkas).tambahkan(dl([['Pokok tersisa', rp(hitung.pokokTersisa)], ['Jasa ditagih', rp(hitung.jasaDitagih)], ['Denda', rp(hitung.denda)], hitung.rabatJasa ? ['Rabat jasa', rp(hitung.rabatJasa)] : null, ['Total pelunasan', h('b', null, rp(hitung.totalPelunasan))]]));
          proses.disabled = false;
        } catch (e) {
          tampilGalat(galat, e);
        }
      },
    }, ikon('kalkulator'), 'Hitung');
    [tanggal, metode].forEach((x) => x.addEventListener('change', () => { proses.disabled = true; hitung = null; }));
    dialog('Pelunasan ' + p.nomorPinjaman, h('div', null, galat, h('div', { class: 'form-kisi' }, medan('Tanggal pelunasan', tanggal), medan('Metode jasa', metode)), medan('Sumber dana', sd.el), hitungBtn, h('div', { class: 'jarak' }), ringkas), (tutup) => {
      proses.addEventListener('click', async () => {
        if (!hitung) return;
        proses.disabled = true;
        try {
          await api('POST', '/api/pinjaman/' + p.id + '/pelunasan', Object.assign({ tanggal: tanggal.value, metode: metode.value, totalDilihat: hitung.totalPelunasan }, sd.nilai()), { kunci });
          tutup();
          sukses({ judul: 'Pelunasan pinjaman tersimpan', nomor: p.nomorPinjaman, labelNomor: 'Nomor pinjaman', sub: 'Pinjaman berstatus LUNAS. Jurnal pelunasan tercatat di KOPKU.', baris: [['Anggota', p.namaAnggota + ' (' + p.nomorAnggota + ')'], ['Tanggal pelunasan', tgl(tanggal.value)], ['Metode jasa', teksPilihan(metode)], ['Pokok', rp(hitung.pokokTersisa)], ['Jasa', rp(hitung.jasaDitagih)], hitung.denda ? ['Denda', rp(hitung.denda)] : null, hitung.rabatJasa ? ['Rabat jasa', rp(hitung.rabatJasa)] : null, ['Total pelunasan', h('b', null, rp(hitung.totalPelunasan))], ['Diterima di', sd.label()]], muatUlang: true });
        } catch (e) {
          tampilGalat(galat, e);
        }
      });
      return [h('button', { class: 'tombol', type: 'button', onclick: tutup }, 'Batal'), proses];
    });
  }

  async function dialogCairkan(p, versi) {
    const sd = await pilihSumberDana();
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const kunci = kunciAcak();
    konfirmasi(
      'Cairkan ' + p.nomorPinjaman,
      h('div', null, h('div', { class: 'pesan info' }, 'Dana ' + rp(p.jumlahPinjaman) + ' diserahkan kepada ' + p.namaAnggota + '. Biaya administrasi (bila ada), jurnal pencairan & jadwal aktif dibuat oleh server KOPKU.'), h('div', { class: 'form-kisi' }, medan('Tanggal pencairan', tanggal), medan('Dibayar dari', sd.el))),
      'Cairkan pinjaman',
      async () => {
        await api('POST', '/api/pinjaman/' + p.id + '/cairkan', Object.assign({ tanggalPencairan: tanggal.value, versi }, sd.nilai()), { kunci });
        sukses({ judul: 'Pencairan pinjaman tersimpan', nomor: p.nomorPinjaman, labelNomor: 'Nomor pinjaman', sub: 'Pinjaman AKTIF; jadwal angsuran & jurnal pencairan sudah dibuat.', baris: [['Anggota', p.namaAnggota + ' (' + p.nomorAnggota + ')'], ['Tanggal pencairan', tgl(tanggal.value)], ['Jumlah pinjaman', h('b', null, rp(p.jumlahPinjaman))], ['Dibayar dari', sd.label()]], muatUlang: true });
      }
    );
  }
  function dialogBatalkan(p) {
    const alasan = h('input', { type: 'text', maxlength: 200, placeholder: 'Mis. anggota membatalkan pengajuan' });
    const kunci = kunciAcak();
    konfirmasi('Batalkan pengajuan ' + p.nomorPinjaman, h('div', null, medan('Alasan pembatalan *', alasan)), 'Batalkan pengajuan', async () => {
      await api('POST', '/api/pinjaman/' + p.id + '/batalkan', { alasan: alasan.value.trim() }, { kunci });
      sukses({ judul: 'Pembatalan pengajuan tersimpan', nomor: p.nomorPinjaman, labelNomor: 'Nomor pinjaman', baris: [['Anggota', p.namaAnggota + ' (' + p.nomorAnggota + ')'], ['Jumlah diajukan', rp(p.jumlahPinjaman)], ['Alasan', alasan.value.trim()]], muatUlang: true });
    }, 'bahaya');
  }

  async function halamanAjukanPinjaman(q) {
    if (!boleh('pinjaman', 'create')) return tanpaIzin('Ajukan Pinjaman');
    const k = kerangka('Ajukan Pinjaman', 'Transaksi › Pinjaman', { kembali: '#/pinjaman' });
    const ang = pilihAnggota({});
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const jumlah = inputRupiah();
    const tenor = h('input', { type: 'number', min: 1, max: 600, step: 1, value: 12, inputmode: 'numeric' });
    const satuan = h('select', null, h('option', { value: 'BULAN' }, 'Bulan'), h('option', { value: 'MINGGU' }, 'Minggu'), h('option', { value: 'HARI' }, 'Hari'));
    const metode = h('select', null, h('option', { value: 'FLAT' }, 'Flat'), h('option', { value: 'EFEKTIF' }, 'Efektif'), h('option', { value: 'MENURUN' }, 'Menurun'));
    const jasa = h('input', { type: 'number', min: 0, max: 100, step: '0.01', value: '1.5', inputmode: 'decimal' });
    const tujuan = h('select', null, h('option', { value: '' }, '- tidak diisi -'), h('option', { value: 'MODAL_KERJA' }, 'Modal kerja'), h('option', { value: 'INVESTASI' }, 'Investasi'), h('option', { value: 'KONSUMTIF' }, 'Konsumtif'), h('option', { value: 'LAINNYA' }, 'Lainnya'));
    const tujuanDetail = h('input', { type: 'text', maxlength: 200, placeholder: 'Jelaskan tujuan' });
    const mTujuanDetail = medan('Detail tujuan *', tujuanDetail);
    mTujuanDetail.hidden = true;
    tujuan.addEventListener('change', () => (mTujuanDetail.hidden = tujuan.value !== 'LAINNYA'));
    const adminTipe = h('select', null, h('option', { value: 'TIDAK_ADA' }, 'Tidak ada'), h('option', { value: 'NOMINAL' }, 'Nominal tetap'), h('option', { value: 'PERSENTASE' }, 'Persentase'));
    const adminNominal = inputRupiah();
    const adminPersen = h('input', { type: 'number', min: 0, max: 100, step: 1, inputmode: 'numeric', placeholder: '%' });
    const adminKlas = h('select', null, h('option', { value: 'SEPARATE_SERVICE' }, 'Jasa layanan terpisah (diakui saat cair)'), h('option', { value: 'INTEGRAL_FINANCIAL_INSTRUMENT' }, 'Bagian integral pinjaman (diamortisasi EIR)'));
    const mAdminNominal = medan('Nominal biaya admin', adminNominal);
    const mAdminPersen = medan('Persentase biaya admin', adminPersen);
    const mAdminKlas = medan('Klasifikasi biaya admin', adminKlas, 'Sama dengan pilihan di desktop (SAK EP).');
    const aturAdmin = () => {
      mAdminNominal.hidden = adminTipe.value !== 'NOMINAL';
      mAdminPersen.hidden = adminTipe.value !== 'PERSENTASE';
      mAdminKlas.hidden = adminTipe.value === 'TIDAK_ADA';
    };
    adminTipe.addEventListener('change', aturAdmin);
    aturAdmin();
    const dendaAktif = h('input', { type: 'checkbox' });
    const dendaNilai = inputRupiah();
    const mDenda = medan('Denda per hari keterlambatan', dendaNilai);
    mDenda.hidden = true;
    dendaAktif.addEventListener('change', () => (mDenda.hidden = !dendaAktif.checked));
    const agunanAktif = h('input', { type: 'checkbox' });
    const ag = {
      jenis: h('select', null, [['TANAH', 'Tanah'], ['TANAH_DAN_BANGUNAN', 'Tanah dan bangunan'], ['KENDARAAN', 'Kendaraan'], ['DEPOSITO', 'Deposito'], ['TABUNGAN', 'Tabungan'], ['BARANG_BERGERAK_LAINNYA', 'Barang bergerak lainnya']].map((x) => h('option', { value: x[0] }, x[1]))),
      pemilik: h('input', { type: 'text', maxlength: 150 }),
      dokumen: h('input', { type: 'text', maxlength: 100, placeholder: 'Mis. BPKB / SHM' }),
      nilai: inputRupiah(),
    };
    const blokAgunan = h('div', { class: 'form-kisi', hidden: true }, medan('Jenis agunan', ag.jenis), medan('Pemilik', ag.pemilik), medan('Nomor dokumen', ag.dokumen), medan('Nilai agunan', ag.nilai));
    agunanAktif.addEventListener('change', () => (blokAgunan.hidden = !agunanAktif.checked));
    const ket = h('textarea', { rows: 2, maxlength: 300 });
    const simulasi = h('div', { class: 'simulasi' }, h('div', { class: 'kosong kecil' }, 'Isi jumlah, tenor, metode & jasa untuk melihat simulasi angsuran.'));
    let tSim = null;
    const muatSim = () => {
      clearTimeout(tSim);
      tSim = setTimeout(async () => {
        const j = jumlah.nilai();
        if (!(j > 0) || !(Number(tenor.value) > 0) || jasa.value === '') return;
        try {
          const s = await api('GET', '/api/pinjaman-simulasi' + qs({ jumlah: j, tenor: tenor.value, jasa: jasa.value, metode: metode.value }));
          const total = s.reduce((t, x) => t + x.total, 0);
          kosongkan(simulasi).tambahkan(
            h('div', { class: 'kisi kecil' }, stat('Angsuran pertama', rp(s[0] ? s[0].total : 0)), stat('Total jasa', rp(s.reduce((t, x) => t + x.jasa, 0))), stat('Total dibayar', rp(total))),
            tabel(['Ke', { t: 'Pokok', c: 'angka' }, { t: 'Jasa', c: 'angka' }, { t: 'Total', c: 'angka' }], s.map((x) => ({ sel: [x.nomorAngsuran, { t: rp(x.pokok), c: 'angka' }, { t: rp(x.jasa), c: 'angka' }, { t: rp(x.total), c: 'angka' }] }))),
            h('p', { class: 'bantu' }, 'Simulasi dihitung server KOPKU dengan rumus yang sama dengan desktop (tanggal jatuh tempo mengikuti tanggal pengajuan & satuan tenor).')
          );
        } catch (e) {
          kosongkan(simulasi).tambahkan(h('div', { class: 'pesan galat' }, pesanGalat(e)));
        }
      }, 300);
    };
    [jumlah.input, tenor, jasa].forEach((x) => x.addEventListener('input', muatSim));
    metode.addEventListener('change', muatSim);
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan pengajuan');
    const form = h(
      'form',
      { class: 'form-dua' },
      h(
        'div',
        { class: 'kartu' },
        galat,
        h('h3', { class: 'subjudul' }, 'Peminjam'),
        medan('Anggota *', ang, 'Anggota harus aktif. Kelayakan (plafon, tunggakan) diperiksa server.', { lebar: true }),
        h('h3', { class: 'subjudul' }, 'Pinjaman'),
        h('div', { class: 'form-kisi' }, medan('Tanggal pengajuan', tanggal), medan('Jumlah pinjaman *', jumlah), medan('Tenor *', h('div', { class: 'gabung' }, tenor, satuan)), medan('Metode jasa', metode), medan('Jasa per periode (%) *', jasa), medan('Tujuan pinjaman', tujuan), mTujuanDetail),
        h('h3', { class: 'subjudul' }, 'Biaya & denda'),
        h('div', { class: 'form-kisi' }, medan('Biaya administrasi', adminTipe), mAdminNominal, mAdminPersen, mAdminKlas),
        h('label', { class: 'cek' }, dendaAktif, 'Aktifkan denda keterlambatan (per hari)'),
        mDenda,
        h('label', { class: 'cek' }, agunanAktif, 'Ada agunan'),
        blokAgunan,
        medan('Keterangan', ket),
        h('p', { class: 'bantu' }, 'Pengajuan berstatus DIAJUKAN. Pencairan dilakukan oleh pengguna dengan izin Setuju (approve) pinjaman. Metode Custom hanya tersedia di KOPKU Desktop.'),
        h('div', { class: 'alat akhir' }, h('a', { class: 'tombol', href: '#/pinjaman' }, 'Batal'), simpan)
      ),
      h('div', { class: 'kartu lengket' }, h('h2', null, 'Simulasi angsuran'), simulasi)
    );
    kirimForm(form, simpan, galat, async (kunci) => {
      const a = ang.nilai();
      if (!a) throw new Error('Pilih anggota terlebih dahulu.');
      const body = {
        anggotaId: a.id,
        tanggal: tanggal.value,
        jumlahPinjaman: jumlah.nilai(),
        tenor: Number(tenor.value),
        satuanTenor: satuan.value,
        metodeJasa: metode.value,
        persentaseJasa: Number(jasa.value),
        biayaAdminTipe: adminTipe.value,
        biayaAdminNilai: adminTipe.value === 'NOMINAL' ? adminNominal.nilai() : adminTipe.value === 'PERSENTASE' ? Number(adminPersen.value) : 0,
        biayaAdminKlasifikasi: adminKlas.value,
        tujuanPinjaman: tujuan.value || undefined,
        tujuanDetail: tujuan.value === 'LAINNYA' ? tujuanDetail.value.trim() : undefined,
        dendaAktif: dendaAktif.checked,
        dendaNilai: dendaAktif.checked ? dendaNilai.nilai() || 0 : 0,
        agunan: agunanAktif.checked ? { jenisAgunan: ag.jenis.value, pemilik: ag.pemilik.value.trim(), nomorDokumen: ag.dokumen.value.trim(), nilaiAgunan: ag.nilai.nilai() } : undefined,
        keterangan: ket.value.trim() || undefined,
      };
      const r = await api('POST', '/api/pinjaman', body, { kunci });
      sukses({ judul: 'Pengajuan pinjaman tersimpan', nomor: r.nomorPinjaman, labelNomor: 'Nomor pinjaman', sub: 'Status DIAJUKAN — menunggu pencairan oleh pengguna dengan izin Setuju.', baris: [['Anggota', (a.namaLengkap || a.namaAnggota) + (a.nomorAnggota ? ' (' + a.nomorAnggota + ')' : '')], ['Tanggal pengajuan', tgl(body.tanggal)], ['Jumlah pinjaman', h('b', null, rp(body.jumlahPinjaman))], ['Tenor', body.tenor + ' ' + teksPilihan(satuan).toLowerCase()], ['Jasa', teksPilihan(metode) + ' · ' + body.persentaseJasa + '% per periode']], aksi: [{ label: 'Ajukan lagi', href: '#/pinjaman/baru' }] }, '#/pinjaman/' + r.id);
    });
    k.appendChild(form);
    if (q.anggota) {
      try {
        const d = await api('GET', '/api/anggota/' + encodeURIComponent(q.anggota));
        ang.pilih(d.anggota);
      } catch (e) {
        /* abaikan */
      }
    }
  }

  // ============================================================ TRANSAKSI: kas & bank
  async function halamanKas(q) {
    if (!boleh('kas_bank')) return tanpaIzin('Riwayat Kas & Bank');
    const k = kerangka('Riwayat Kas & Bank', 'Transaksi › Kas & Bank', {
      aksi: h('div', { class: 'tombol-baris' }, boleh('kas_bank', 'create') ? h('a', { class: 'tombol', href: '#/kas/masuk' }, ikon('masuk'), 'Masuk') : null, boleh('kas_bank', 'create') ? h('a', { class: 'tombol', href: '#/kas/keluar' }, ikon('keluar'), 'Keluar') : null, boleh('kas_bank', 'edit') ? h('a', { class: 'tombol', href: '#/kas/transfer' }, ikon('ulang'), 'Pindah saldo') : null),
    });
    const rek = await daftarRekening();
    const pilih = h('select', null, h('option', { value: '' }, 'Semua rekening'), rek.map((r) => h('option', { value: r.jenis + '|' + r.id }, r.nama)));
    pilih.value = q.rek || '';
    const mulai = h('input', { type: 'date', value: q.mulai || '' });
    const selesai = h('input', { type: 'date', value: q.selesai || '' });
    const hal = Number(q.halaman || 1);
    const ke = (p) => (location.hash = '#/kas' + qs({ rek: pilih.value, mulai: mulai.value, selesai: selesai.value, halaman: p }));
    const isi = h('div', { class: 'kartu' });
    k.tambahkan(h('div', { class: 'alat' }, pilih, h('span', { class: 'bantu' }, 'dari'), mulai, h('span', { class: 'bantu' }, 's.d.'), selesai, h('button', { class: 'tombol utama', type: 'button', onclick: () => ke(1) }, 'Tampilkan')), isi);
    memuat(isi);
    const [jenis, id] = (q.rek || '').split('|');
    const d = await api('GET', '/api/kas/riwayat' + qs({ jenis: jenis || '', bank: jenis === 'BANK' ? id : '', mulai: q.mulai, selesai: q.selesai, halaman: hal }));
    const keluarTipe = (r) => r.tipe === 'PENGELUARAN' || (r.tipe === 'TRANSFER' && /keluar/i.test(r.keterangan || r.nomorTransaksi || ''));
    kosongkan(isi).tambahkan(
      tabel(['Tanggal', 'Nomor', 'Rekening', 'Tipe', { t: 'Akun lawan / kategori', c: 'sembunyi-hp' }, { t: 'Keterangan', c: 'sembunyi-hp' }, { t: 'Nominal', c: 'angka' }], d.baris.map((r) => ({ klik: r.journalId && boleh('history_transaksi') ? () => (location.hash = '#/history/' + r.journalId) : null, sel: [tgl(r.tanggal), r.nomorTransaksi, r.rekeningNama, lencanaStatus(r.tipe), { t: (r.akunLawanNama || '-') + (r.kategori ? ' · ' + r.kategori : ''), c: 'sembunyi-hp' }, { t: r.keterangan || '', c: 'sembunyi-hp' }, { t: (keluarTipe(r) ? '-' : '+') + rp(r.nominal), c: 'angka ' + (keluarTipe(r) ? 'negatif' : 'positif') }] }))),
      paginasi(hal, d.baris.length, ke)
    );
  }

  async function halamanKasMasuk() {
    if (!boleh('kas_bank', 'create')) return tanpaIzin('Kas Masuk');
    const k = kerangka('Kas Masuk · Pendapatan Lain', 'Transaksi › Kas & Bank', { kembali: '#/kas' });
    memuat(k);
    const opsi = await api('GET', '/api/kas/opsi');
    const rek = await pilihRekening();
    const akun = h('select', { required: true }, h('option', { value: '' }, '- pilih akun pendapatan -'), opsi.pendapatan.map((a) => h('option', { value: a.accountId }, a.kode + ' — ' + a.nama)));
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const nominal = inputRupiah();
    const kategori = h('input', { type: 'text', maxlength: 100, placeholder: 'Opsional, mis. Sewa gedung' });
    const ket = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional' });
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan penerimaan');
    const form = h('form', { class: 'kartu form-transaksi' }, galat, h('div', { class: 'form-kisi' }, medan('Akun pendapatan *', akun, 'Sama dengan menu Penerimaan › Pendapatan Koperasi di desktop.'), medan('Diterima di', rek), medan('Tanggal', tanggal), medan('Nominal *', nominal), medan('Kategori', kategori), medan('Keterangan', ket)), h('div', { class: 'alat akhir' }, simpan));
    kirimForm(form, simpan, galat, async (kunci) => {
      const r = rek.nilai();
      const n = nominal.nilai();
      const x = await api('POST', '/api/kas/masuk', { jenis: r.jenis, bankAccountId: r.bankAccountId, accountId: akun.value, tanggal: tanggal.value, nominal: n, kategori: kategori.value.trim() || undefined, keterangan: ket.value.trim() || undefined }, { kunci });
      rekeningCache = null;
      sukses({ judul: 'Kas masuk tersimpan', nomor: x && (x.nomorTransaksi || x.nomor), baris: [['Akun pendapatan', teksPilihan(akun)], ['Diterima di', teksPilihan(rek)], ['Tanggal', tgl(tanggal.value)], ['Nominal', h('b', null, rp(n))], kategori.value.trim() ? ['Kategori', kategori.value.trim()] : null, ket.value.trim() ? ['Keterangan', ket.value.trim()] : null], aksi: [{ label: 'Input kas masuk lagi', href: '#/kas/masuk' }] }, '#/kas');
    });
    kosongkan(k).appendChild(form);
  }

  async function halamanKasKeluar() {
    if (!boleh('kas_bank', 'create')) return tanpaIzin('Kas Keluar');
    const k = kerangka('Kas Keluar · Beban', 'Transaksi › Kas & Bank', { kembali: '#/kas' });
    memuat(k);
    const opsi = await api('GET', '/api/kas/opsi');
    const rek = await pilihRekening();
    const kat = h('select', { required: true }, h('option', { value: '' }, '- pilih kategori beban -'), h('optgroup', { label: 'Kategori beban' }, opsi.beban.filter((o) => o.sumber === 'KATEGORI').map((o) => h('option', { value: o.key }, o.label))), opsi.beban.some((o) => o.sumber !== 'KATEGORI') ? h('optgroup', { label: 'Beban lain (5-2000)' }, opsi.beban.filter((o) => o.sumber !== 'KATEGORI').map((o) => h('option', { value: o.key }, o.label + (o.keterangan ? ' — ' + o.keterangan : '')))) : null);
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const nominal = inputRupiah();
    const ket = h('input', { type: 'text', maxlength: 200, placeholder: 'Opsional' });
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan pengeluaran');
    const form = h('form', { class: 'kartu form-transaksi' }, galat, h('div', { class: 'form-kisi' }, medan('Kategori beban *', kat, 'Sama dengan menu Pengeluaran › Beban di desktop.'), medan('Dibayar dari', rek), medan('Tanggal', tanggal), medan('Nominal *', nominal), medan('Keterangan', ket)), h('p', { class: 'bantu' }, 'Saldo rekening diperiksa server; pengeluaran ditolak bila saldo tidak cukup.'), h('div', { class: 'alat akhir' }, simpan));
    kirimForm(form, simpan, galat, async (kunci) => {
      const r = rek.nilai();
      const n = nominal.nilai();
      const x = await api('POST', '/api/kas/keluar', { jenis: r.jenis, bankAccountId: r.bankAccountId, kategoriKey: kat.value, tanggal: tanggal.value, nominal: n, keterangan: ket.value.trim() || undefined }, { kunci });
      rekeningCache = null;
      sukses({ judul: 'Kas keluar tersimpan', nomor: x && (x.nomorTransaksi || x.nomor), baris: [['Kategori beban', teksPilihan(kat)], ['Dibayar dari', teksPilihan(rek)], ['Tanggal', tgl(tanggal.value)], ['Nominal', h('b', null, rp(n))], ket.value.trim() ? ['Keterangan', ket.value.trim()] : null], aksi: [{ label: 'Input kas keluar lagi', href: '#/kas/keluar' }] }, '#/kas');
    });
    kosongkan(k).appendChild(form);
  }

  async function halamanTransfer() {
    if (!boleh('kas_bank', 'edit')) return tanpaIzin('Pemindahan Saldo');
    const k = kerangka('Pemindahan Saldo Rekening', 'Transaksi › Kas & Bank', { kembali: '#/kas' });
    const dari = await pilihRekening();
    const ke = await pilihRekening();
    if (ke.options.length > 1) ke.selectedIndex = 1;
    const tanggal = h('input', { type: 'date', value: hariIni(), max: hariIni() });
    const nominal = inputRupiah();
    const ket = h('input', { type: 'text', maxlength: 200, placeholder: 'Mis. setor kas ke bank' });
    const galat = formGalat();
    const simpan = h('button', { class: 'tombol utama', type: 'submit' }, ikon('centang'), 'Simpan pemindahan');
    const form = h('form', { class: 'kartu form-transaksi' }, galat, h('div', { class: 'form-kisi' }, medan('Dari rekening', dari), medan('Ke rekening', ke), medan('Tanggal', tanggal), medan('Nominal *', nominal), medan('Keterangan', ket)), h('div', { class: 'alat akhir' }, simpan));
    kirimForm(form, simpan, galat, async (kunci) => {
      const a = dari.nilai();
      const b = ke.nilai();
      const n = nominal.nilai();
      const x = await api('POST', '/api/kas/transfer', { sumberJenis: a.jenis, sumberBankAccountId: a.bankAccountId, tujuanJenis: b.jenis, tujuanBankAccountId: b.bankAccountId, tanggal: tanggal.value, nominal: n, keterangan: ket.value.trim() || undefined }, { kunci });
      rekeningCache = null;
      sukses({ judul: 'Pemindahan saldo tersimpan', nomor: x && (x.nomorTransaksi || x.nomor), baris: [['Dari rekening', teksPilihan(dari)], ['Ke rekening', teksPilihan(ke)], ['Tanggal', tgl(tanggal.value)], ['Nominal', h('b', null, rp(n))], ket.value.trim() ? ['Keterangan', ket.value.trim()] : null] }, '#/kas');
    });
    k.appendChild(form);
  }

  // ============================================================ LAPORAN
  const barisAkun = (list) => list.map((r) => ({ sel: [h('code', null, r.kode || ''), r.nama, { t: rp(r.saldo != null ? r.saldo : r.jumlah), c: 'angka' }] }));
  function judulCetak(judul, periode) {
    return h('div', { class: 'judul-cetak' }, h('b', null, negara.koperasi ? negara.koperasi.nama : 'KOPKU'), h('div', null, judul), h('small', null, periode));
  }
  async function halamanPosisi(q) {
    if (!boleh('laporan')) return tanpaIzin('Posisi Keuangan');
    const k = kerangka('Laporan Posisi Keuangan', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/posisi' + qs(p)), { tunggal: true, ekspor: ['posisi-keuangan', { tanggal: q.tanggal || hariIni() }] }), isi);
    memuat(isi);
    const d = await api('GET', '/api/laporan/posisi-keuangan' + qs({ tanggal: q.tanggal || hariIni() }));
    const kol = ['Kode', 'Akun', { t: 'Saldo', c: 'angka' }];
    kosongkan(isi).tambahkan(
      judulCetak('Laporan Posisi Keuangan', 'Per ' + tgl(d.asOfDate)),
      h('div', { class: 'dua-kolom laporan-kolom' }, h('div', null, h('h3', { class: 'subjudul' }, 'Aset'), tabel(kol, barisAkun(d.aset || []), { kaki: ['', 'Total aset', { t: rp(d.totalAset), c: 'angka' }] })), h('div', null, h('h3', { class: 'subjudul' }, 'Liabilitas'), tabel(kol, barisAkun(d.liabilitas || []), { kaki: ['', 'Total liabilitas', { t: rp(d.totalLiabilitas), c: 'angka' }] }), h('h3', { class: 'subjudul' }, 'Ekuitas'), tabel(kol, barisAkun(d.ekuitas || []).concat(d.labaBerjalanLabel ? [{ sel: ['', d.labaBerjalanLabel, { t: rp(d.labaBerjalan), c: 'angka' }] }] : []), { kaki: ['', 'Total ekuitas', { t: rp(d.totalEkuitas), c: 'angka' }] }))),
      h('div', { class: 'pesan ' + (d.isBalanced ? 'info' : 'galat') }, d.isBalanced ? 'Seimbang — total aset = liabilitas + ekuitas.' : 'Tidak seimbang, selisih ' + rp(d.selisih) + '.')
    );
  }
  function daftarPos(judul, list, total) {
    return [h('h3', { class: 'subjudul' }, judul), tabel(['Kode', 'Akun', { t: 'Jumlah', c: 'angka' }], barisAkun(list || []), { kaki: ['', 'Jumlah ' + judul.toLowerCase(), { t: rp(total), c: 'angka' }], kosong: '—' })];
  }
  async function halamanLhu(q) {
    if (!boleh('laporan')) return tanpaIzin('Laporan Hasil Usaha');
    const k = kerangka('Laporan Hasil Usaha', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/lhu' + qs(p)), { ekspor: ['lhu', { mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }] }), isi);
    memuat(isi);
    const d = await api('GET', '/api/laporan/lhu' + qs({ mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }));
    const baris = (lbl, n, tebal) => ({ kelas: tebal ? 'tebal' : null, sel: [lbl, { t: rp(n), c: 'angka' }] });
    kosongkan(isi).tambahkan(
      judulCetak('Laporan Hasil Usaha', tgl(d.tanggalMulai) + ' s.d. ' + tgl(d.tanggalSelesai)),
      tabel(['Pos', { t: 'Jumlah', c: 'angka' }], [
        baris('Pendapatan jasa pinjaman', d.pendapatanJasaPinjaman),
        baris('Pendapatan usaha lain', d.totalPendapatanUsahaLain),
        baris('Jumlah partisipasi anggota', d.jumlahPartisipasiAnggota, true),
        baris('Beban usaha', -d.jumlahBebanUsaha),
        baris('SHU bruto', d.shuBruto, true),
        baris('Hasil investasi', d.totalHasilInvestasi),
        baris('Beban perkoperasian', -d.totalBebanPerkoperasian),
        baris('Pendapatan / beban lain neto', d.pendapatanBebanLainNeto),
        baris('SHU sebelum pajak', d.shuSebelumPajak, true),
        baris('Beban pajak penghasilan', -d.bebanPajakPenghasilan),
        baris('SHU neto', d.shuNeto, true),
        d.totalOci ? baris('Penghasilan komprehensif lain', d.totalOci) : null,
        d.totalOci ? baris('Total penghasilan komprehensif', d.totalPenghasilanKomprehensif, true) : null,
      ].filter(Boolean)),
      ...[['Rincian pendapatan usaha lain', d.pendapatanUsahaLain], ['Rincian beban usaha', d.bebanUsaha], ['Rincian hasil investasi', d.hasilInvestasi], ['Rincian beban perkoperasian', d.bebanPerkoperasian], ['Rincian pendapatan lain', d.pendapatanLain], ['Rincian beban lain', d.bebanLain]].filter((x) => x[1] && x[1].length).map((x) => h('details', { class: 'rincian' }, h('summary', null, x[0] + ' (' + x[1].length + ')'), tabel(['Kode', 'Akun', { t: 'Jumlah', c: 'angka' }], barisAkun(x[1]))))
    );
  }
  async function halamanLabaRugi(q) {
    if (!boleh('laporan')) return tanpaIzin('Laba Rugi');
    const k = kerangka('Laporan Laba Rugi', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/laba-rugi' + qs(p)), { ekspor: ['laba-rugi', { mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }] }), isi);
    memuat(isi);
    const d = await api('GET', '/api/laporan/laba-rugi' + qs({ mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }));
    kosongkan(isi).tambahkan(judulCetak('Laporan Laba Rugi', tgl(d.tanggalMulai) + ' s.d. ' + tgl(d.tanggalSelesai)), ...daftarPos('Pendapatan', d.pendapatan, d.totalPendapatan), ...daftarPos('Beban', d.beban, d.totalBeban), h('div', { class: 'kisi' }, stat('Hasil usaha', rp(d.hasilUsaha), { nada: d.hasilUsaha < 0 ? 'waspada' : 'utama' }), d.penghasilanKomprehensifLain ? stat('Penghasilan komprehensif lain', rp(d.penghasilanKomprehensifLain)) : null, stat('Total penghasilan komprehensif', rp(d.totalPenghasilanKomprehensif))));
  }
  async function halamanArusKas(q) {
    if (!boleh('laporan')) return tanpaIzin('Arus Kas');
    const k = kerangka('Laporan Arus Kas', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/arus-kas' + qs(p)), { ekspor: ['arus-kas', { mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }] }), isi);
    memuat(isi);
    const d = await api('GET', '/api/laporan/arus-kas' + qs({ mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }));
    const grup = (akt) => (d.rincian || []).filter((r) => r.aktivitas === akt);
    kosongkan(isi).tambahkan(
      judulCetak('Laporan Arus Kas', tgl(d.tanggalMulai) + ' s.d. ' + tgl(d.tanggalSelesai)),
      tabel(['Aktivitas', { t: 'Arus kas neto', c: 'angka' }], [
        { sel: ['Aktivitas operasi', { t: rp(d.operasi), c: 'angka' }] },
        { sel: ['Aktivitas investasi', { t: rp(d.investasi), c: 'angka' }] },
        { sel: ['Aktivitas pendanaan', { t: rp(d.pendanaan), c: 'angka' }] },
        { kelas: 'tebal', sel: ['Kenaikan (penurunan) kas', { t: rp(d.perubahanKas), c: 'angka' }] },
        { sel: ['Kas awal periode', { t: rp(d.kasAwal), c: 'angka' }] },
        { kelas: 'tebal', sel: ['Kas akhir periode', { t: rp(d.kasAkhirDihitung), c: 'angka' }] },
      ]),
      h('div', { class: 'pesan ' + (d.terekonsiliasi ? 'info' : 'peringatan') }, d.terekonsiliasi ? 'Terekonsiliasi dengan saldo kas & bank aktual (' + rp(d.kasAkhirAktual) + ').' : 'Selisih rekonsiliasi ' + rp(d.selisihRekonsiliasi) + '.'),
      ...['OPERASI', 'INVESTASI', 'PENDANAAN'].filter((a) => grup(a).length).map((a) => h('details', { class: 'rincian' }, h('summary', null, 'Rincian aktivitas ' + a.toLowerCase() + ' (' + grup(a).length + ')'), tabel(['Sumber', 'Deskripsi', { t: 'Jumlah', c: 'angka' }], grup(a).map((r) => ({ sel: [label(r.sumberTransaksi), r.deskripsi, { t: rp(r.jumlah), c: 'angka ' + (r.jumlah < 0 ? 'negatif' : '') }] })))))
    );
  }
  async function halamanEkuitas(q) {
    if (!boleh('laporan')) return tanpaIzin('Perubahan Ekuitas');
    const k = kerangka('Laporan Perubahan Ekuitas', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/ekuitas' + qs(p)), { ekspor: ['perubahan-ekuitas', { mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }] }), isi);
    memuat(isi);
    const d = await api('GET', '/api/laporan/perubahan-ekuitas' + qs({ mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }));
    kosongkan(isi).tambahkan(
      judulCetak('Laporan Perubahan Ekuitas', tgl(d.tanggalMulai) + ' s.d. ' + tgl(d.tanggalSelesai)),
      tabel(['Kode', 'Komponen ekuitas', { t: 'Saldo awal', c: 'angka' }, { t: 'Mutasi', c: 'angka' }, { t: 'Saldo akhir', c: 'angka' }], (d.rows || []).map((r) => ({ sel: [h('code', null, r.kode), r.nama, { t: rp(r.saldoAwal), c: 'angka' }, { t: rp(r.mutasi), c: 'angka' }, { t: rp(r.saldoAkhir), c: 'angka' }] })).concat(d.hasilUsahaPeriodeLabel ? [{ sel: ['', d.hasilUsahaPeriodeLabel, { t: '', c: 'angka' }, { t: rp(d.hasilUsahaPeriode), c: 'angka' }, { t: rp(d.hasilUsahaPeriode), c: 'angka' }] }] : []), { kaki: ['', 'Total', { t: rp(d.totalSaldoAwal), c: 'angka' }, { t: rp(d.totalMutasi), c: 'angka' }, { t: rp(d.totalSaldoAkhir), c: 'angka' }] })
    );
  }
  async function halamanNeracaSaldo(q) {
    if (!boleh('laporan')) return tanpaIzin('Neraca Saldo');
    const k = kerangka('Neraca Saldo', 'Laporan');
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/neraca-saldo' + qs(p)), { tunggal: true, ekspor: ['neraca-saldo', { tanggal: q.tanggal || hariIni() }] }), isi);
    memuat(isi);
    const tanggal = q.tanggal || hariIni();
    const d = await api('GET', '/api/laporan/neraca-saldo' + qs({ tanggal }));
    kosongkan(isi).tambahkan(
      judulCetak('Neraca Saldo', 'Per ' + tgl(tanggal)),
      tabel(['Kode', 'Akun', { t: 'Debit', c: 'angka' }, { t: 'Kredit', c: 'angka' }], d.rows.map((r) => ({ klik: () => (location.hash = '#/laporan/buku-besar' + qs({ akun: r.accountId, selesai: tanggal })), sel: [h('code', null, r.kode), r.nama, { t: r.debit ? rp(r.debit) : '', c: 'angka' }, { t: r.kredit ? rp(r.kredit) : '', c: 'angka' }] })), { kaki: ['', 'Total', { t: rp(d.totalDebit), c: 'angka' }, { t: rp(d.totalKredit), c: 'angka' }] }),
      h('div', { class: 'pesan ' + (d.isBalanced ? 'info' : 'galat') }, d.isBalanced ? 'Seimbang — total debit = total kredit.' : 'Tidak seimbang.'),
      h('p', { class: 'bantu tanpa-cetak' }, 'Klik baris untuk membuka buku besar akun.')
    );
  }
  let akunLaporanCache = null;
  async function halamanBukuBesar(q) {
    if (!boleh('laporan')) return tanpaIzin('Buku Besar');
    const k = kerangka('Buku Besar', 'Laporan');
    if (!akunLaporanCache) akunLaporanCache = await api('GET', '/api/laporan/akun');
    const akun = h('select', null, h('option', { value: '' }, '- pilih akun -'), akunLaporanCache.map((a) => h('option', { value: a.id }, a.kode + ' — ' + a.nama)));
    akun.value = q.akun || '';
    const isi = h('div', { class: 'kartu laporan' });
    k.tambahkan(barisPeriode(q, (p) => (location.hash = '#/laporan/buku-besar' + qs(Object.assign({ akun: akun.value }, p))), { ekstra: akun, ekspor: q.akun ? ['buku-besar', { akun: q.akun, mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }] : null }), isi);
    if (!q.akun) return isi.appendChild(h('div', { class: 'kosong' }, 'Pilih akun lalu tekan Tampilkan.'));
    memuat(isi);
    const d = await api('GET', '/api/laporan/buku-besar' + qs({ akun: q.akun, mulai: q.mulai || awalTahun(), selesai: q.selesai || hariIni() }));
    const td = d.baris.reduce((t, r) => t + r.debit, 0);
    const tk = d.baris.reduce((t, r) => t + r.kredit, 0);
    const awal = typeof d.saldoAwal === 'number' ? d.saldoAwal : null;
    const akhir = d.baris.length ? d.baris[d.baris.length - 1].saldoBerjalan : awal;
    // Sama dengan aplikasi: baris Saldo Awal (saldo sebelum "dari tanggal"), saldo berjalan dimulai dari situ.
    const barisAwal = awal != null ? [{ kelas: 'tebal', sel: [tgl(q.mulai || awalTahun()), '', 'Saldo Awal', { t: '', c: 'angka' }, { t: '', c: 'angka' }, { t: rp(awal), c: 'angka' }] }] : [];
    kosongkan(isi).tambahkan(
      judulCetak('Buku Besar ' + d.akun.kode + ' — ' + d.akun.nama, tgl(q.mulai || awalTahun()) + ' s.d. ' + tgl(q.selesai || hariIni())),
      tabel(['Tanggal', 'No. jurnal', 'Keterangan', { t: 'Debit', c: 'angka' }, { t: 'Kredit', c: 'angka' }, { t: 'Saldo', c: 'angka' }], barisAwal.concat(d.baris.map((r) => ({ sel: [tgl(r.tanggal), r.nomorJurnal, r.keterangan, { t: r.debit ? rp(r.debit) : '', c: 'angka' }, { t: r.kredit ? rp(r.kredit) : '', c: 'angka' }, { t: rp(r.saldoBerjalan), c: 'angka' }] }))), { kaki: ['', '', 'Jumlah mutasi · saldo akhir', { t: rp(td), c: 'angka' }, { t: rp(tk), c: 'angka' }, { t: akhir != null ? rp(akhir) : '-', c: 'angka' }], kosong: 'Tidak ada mutasi pada periode ini.' })
    );
  }
  async function halamanKolektibilitas() {
    if (!boleh('pinjaman')) return tanpaIzin('Kolektibilitas');
    const k = kerangka('Kolektibilitas Piutang', 'Laporan', { aksi: h('div', { class: 'tombol-baris' }, tombolCetak(), tombolEkspor('kolektibilitas', {})) });
    memuat(k);
    const d = await api('GET', '/api/laporan/kolektibilitas');
    kosongkan(k).tambahkan(
      h('div', { class: 'kisi' }, d.ringkasan.map((r) => stat(label(r.kategori), r.jumlahPinjaman + ' pinjaman', { nada: r.kategori === 'LANCAR' ? 'utama' : r.kategori === 'MACET' || r.kategori === 'DIRAGUKAN' ? 'waspada' : '', sub: 'Outstanding ' + rp(r.totalOutstanding) + ' · cadangan ' + rp(r.totalCadangan) }))),
      kartu('Rincian per pinjaman', tabel(['Pinjaman', 'Anggota', { t: 'Saldo pokok', c: 'angka' }, { t: 'Hari tunggak', c: 'angka' }, 'Kolektibilitas', { t: 'Cadangan', c: 'angka sembunyi-hp' }, { t: 'Dasar', c: 'sembunyi-hp' }], d.rincian.map((r) => ({ klik: () => (location.hash = '#/pinjaman/' + r.pinjamanId), sel: [r.nomorPinjaman, r.namaAnggota, { t: rp(r.saldoPokok), c: 'angka' }, { t: r.hariTunggakan, c: 'angka' }, lencanaStatus(r.kolektibilitas), { t: rp(r.nilaiCadangan), c: 'angka sembunyi-hp' }, { t: r.dasarPenggolongan, c: 'sembunyi-hp kecil' }] }))))
    );
  }
  async function halamanTunggakan() {
    if (!boleh('pinjaman')) return tanpaIzin('Tunggakan');
    const k = kerangka('Tunggakan Angsuran', 'Laporan', { aksi: tombolCetak() });
    memuat(k);
    const d = await api('GET', '/api/laporan/tunggakan');
    kosongkan(k).tambahkan(
      h('div', { class: 'kisi' }, stat('Angsuran tertunggak', angka(d.length), { ikon: 'peringatan', nada: d.length ? 'waspada' : '' }), stat('Nilai tertunggak', rp(d.reduce((t, x) => t + x.sisaTagihan, 0)))),
      kartu(null, tabel(['Pinjaman', 'Anggota', 'Ke', 'Jatuh tempo', { t: 'Hari', c: 'angka' }, { t: 'Sisa tagihan', c: 'angka' }], d.map((t) => ({ klik: () => (location.hash = '#/pinjaman/' + t.pinjamanId), sel: [t.nomorPinjaman, t.namaAnggota, t.nomorAngsuran, tgl(t.tanggalJatuhTempo), { t: t.hariTerlambat, c: 'angka' }, { t: rp(t.sisaTagihan), c: 'angka' }] })), { kosong: 'Tidak ada tunggakan.' }))
    );
  }
  let jenisHistoryCache = null;
  async function halamanHistory(q) {
    if (!boleh('history_transaksi')) return tanpaIzin('History Transaksi');
    const k = kerangka('History Transaksi', 'Laporan');
    if (!jenisHistoryCache) jenisHistoryCache = await api('GET', '/api/history/jenis');
    const cari = h('input', { type: 'search', placeholder: 'Cari nomor / keterangan', value: q.cari || '' });
    const jenis = h('select', null, h('option', { value: '' }, 'Semua jenis'), jenisHistoryCache.map((j) => h('option', { value: j.jenis }, j.label)));
    jenis.value = q.jenis || '';
    const mulai = h('input', { type: 'date', value: q.mulai || '' });
    const selesai = h('input', { type: 'date', value: q.selesai || '' });
    const hal = Number(q.halaman || 1);
    const ke = (p) => (location.hash = '#/history' + qs({ cari: cari.value, jenis: jenis.value, mulai: mulai.value, selesai: selesai.value, halaman: p }));
    cari.addEventListener('keydown', (e) => e.key === 'Enter' && ke(1));
    const isi = h('div', { class: 'kartu' });
    k.tambahkan(h('div', { class: 'alat' }, h('div', { class: 'isi' }, cari), jenis, mulai, selesai, h('button', { class: 'tombol utama', type: 'button', onclick: () => ke(1) }, 'Cari'), tombolEkspor('history', { cari: q.cari, jenis: q.jenis, mulai: q.mulai, selesai: q.selesai })), isi);
    memuat(isi);
    const d = await api('GET', '/api/history' + qs({ cari: q.cari, jenis: q.jenis, mulai: q.mulai, selesai: q.selesai, halaman: hal }));
    kosongkan(isi).tambahkan(tabel(['Tanggal', 'Nomor', 'Jenis', { t: 'Keterangan', c: 'sembunyi-hp' }, { t: 'Nominal', c: 'angka' }, { t: 'Oleh', c: 'sembunyi-hp' }, 'Status'], d.baris.map((t) => ({ klik: () => (location.hash = '#/history/' + t.journalId), sel: [tgl(t.tanggal), t.nomorTransaksi, t.jenisLabel, { t: t.deskripsi, c: 'sembunyi-hp' }, { t: rp(t.nominal), c: 'angka' }, { t: t.createdByNama || '-', c: 'sembunyi-hp' }, lencanaStatus(t.status)] }))), paginasi(hal, d.baris.length, ke));
  }
  async function halamanHistoryDetail(id) {
    if (!boleh('history_transaksi')) return tanpaIzin('Detail Transaksi');
    const k = kerangka('Detail Transaksi', 'Laporan › History Transaksi', { kembali: '#/history', aksi: tombolCetak() });
    memuat(k);
    const d = await api('GET', '/api/history/' + encodeURIComponent(id));
    const td = d.lines.reduce((t, l) => t + l.debit, 0);
    const tk = d.lines.reduce((t, l) => t + l.kredit, 0);
    kosongkan(k).tambahkan(
      h('section', { class: 'kartu' }, h('div', { class: 'alat' }, h('h2', { class: 'isi' }, d.nomorTransaksi), lencanaStatus(d.status)), dl([['Tanggal', tgl(d.tanggal)], ['Jenis', d.jenisLabel], ['Keterangan', d.deskripsi], ['Nominal', rp(d.nominal)], ['Dicatat oleh', d.createdByNama], ['Periode', label(d.periodeStatus)]])),
      kartu('Jurnal', tabel(['Kode', 'Akun', { t: 'Debit', c: 'angka' }, { t: 'Kredit', c: 'angka' }], d.lines.map((l) => ({ sel: [h('code', null, l.kodeAkun), l.namaAkun + (l.keterangan ? ' — ' + l.keterangan : ''), { t: l.debit ? rp(l.debit) : '', c: 'angka' }, { t: l.kredit ? rp(l.kredit) : '', c: 'angka' }] })), { kaki: ['', 'Total', { t: rp(td), c: 'angka' }, { t: rp(tk), c: 'angka' }] })),
      h('p', { class: 'bantu' }, 'Koreksi/pembatalan transaksi dilakukan di KOPKU Desktop (History Transaksi).')
    );
  }
  async function halamanShu(q) {
    if (!boleh('shu')) return tanpaIzin('SHU');
    const k = kerangka('Sisa Hasil Usaha', 'Laporan');
    memuat(k);
    const d = await api('GET', '/api/shu');
    kosongkan(k);
    if (!d.length) return k.appendChild(kartu(null, h('div', { class: 'kosong' }, 'Belum ada perhitungan SHU. SHU dihitung & diajukan ke RAT di KOPKU Desktop.')));
    const pilih = q.id || d[0].id;
    k.tambahkan(tab(d.map((s) => [s.id, 'Tahun ' + s.tahunBuku]), pilih, (t) => (location.hash = '#/shu' + qs({ id: t }))));
    const s = d.find((x) => x.id === pilih) || d[0];
    const persen = [['Cadangan', s.persenCadangan], ['Jasa modal', s.persenJasaModal], ['Jasa usaha', s.persenJasaUsaha], ['Pendidikan', s.persenPendidikan], ['Sosial', s.persenSosial], ['Pengurus', s.persenPengurus], ['Pengawas', s.persenPengawas], ['Karyawan', s.persenKaryawan], ['Pembangunan daerah kerja', s.persenPembangunanDaerahKerja], ['Cadangan risiko', s.persenCadanganRisiko]].filter((x) => x[1]);
    k.tambahkan(h('div', { class: 'kisi' }, stat('Total SHU', rp(s.totalShu), { nada: 'utama' }), stat('Status', label(s.status)), s.shuDisahkanRat != null ? stat('Disahkan RAT', rp(s.shuDisahkanRat)) : null), kartu('Pembagian', tabel(['Pos', { t: 'Persentase', c: 'angka' }, { t: 'Nilai', c: 'angka' }], persen.map((p) => ({ sel: [p[0], { t: p[1] + '%', c: 'angka' }, { t: rp((s.totalShu * p[1]) / 100), c: 'angka' }] })))));
    const isi = h('div', { class: 'kartu' }, h('h2', { class: 'judul-dengan-aksi' }, 'SHU per anggota', tombolEkspor('shu-anggota', { shu: s.id })));
    k.appendChild(isi);
    const a = await api('GET', '/api/shu/' + encodeURIComponent(s.id) + '/anggota');
    isi.appendChild(tabel(['No.', 'Anggota', { t: 'Jasa modal', c: 'angka' }, { t: 'Jasa usaha', c: 'angka' }, { t: 'Total', c: 'angka' }], a.map((x) => ({ sel: [x.nomorAnggota, x.namaAnggota, { t: rp(x.jasaModal), c: 'angka' }, { t: rp(x.jasaUsaha), c: 'angka' }, { t: rp(x.totalShuAnggota), c: 'angka tebal' }] })), { kosong: 'Belum dibagikan per anggota.' }));
  }

  // ============================================================ router
  const RUTE = [
    [/^\/$|^$/, (m, q) => halamanDashboard(q)],
    [/^\/anggota$/, (m, q) => halamanAnggota(q)],
    [/^\/anggota\/baru$/, () => halamanAnggotaForm(null)],
    [/^\/anggota\/([\w-]+)\/ubah$/, (m) => halamanAnggotaForm(m[1])],
    [/^\/anggota\/([\w-]+)$/, (m, q) => halamanAnggotaDetail(m[1], q)],
    [/^\/personel$/, (m, q) => halamanPersonel(q)],
    [/^\/akun$/, (m, q) => halamanAkun(q)],
    [/^\/rekening$/, () => halamanRekening()],
    [/^\/simpanan$/, (m, q) => halamanSimpanan(q)],
    [/^\/simpanan\/saldo$/, (m, q) => halamanSaldoSimpanan(q)],
    [/^\/simpanan\/setor$/, (m, q) => halamanSetorSimpanan(q)],
    [/^\/simpanan\/tarik$/, () => halamanTarikSimpanan()],
    [/^\/berjangka$/, () => halamanBerjangka()],
    [/^\/pinjaman$/, (m, q) => halamanPinjaman(q)],
    [/^\/pinjaman\/baru$/, (m, q) => halamanAjukanPinjaman(q)],
    [/^\/pinjaman\/([\w-]+)$/, (m) => halamanPinjamanDetail(m[1])],
    [/^\/kas$/, (m, q) => halamanKas(q)],
    [/^\/kas\/masuk$/, () => halamanKasMasuk()],
    [/^\/kas\/keluar$/, () => halamanKasKeluar()],
    [/^\/kas\/transfer$/, () => halamanTransfer()],
    [/^\/laporan$/, (m, q) => halamanPosisi(q)],
    [/^\/laporan\/posisi$/, (m, q) => halamanPosisi(q)],
    [/^\/laporan\/lhu$/, (m, q) => halamanLhu(q)],
    [/^\/laporan\/laba-rugi$/, (m, q) => halamanLabaRugi(q)],
    [/^\/laporan\/arus-kas$/, (m, q) => halamanArusKas(q)],
    [/^\/laporan\/ekuitas$/, (m, q) => halamanEkuitas(q)],
    [/^\/laporan\/neraca-saldo$/, (m, q) => halamanNeracaSaldo(q)],
    [/^\/laporan\/buku-besar$/, (m, q) => halamanBukuBesar(q)],
    [/^\/laporan\/kolektibilitas$/, () => halamanKolektibilitas()],
    [/^\/tunggakan$/, () => halamanTunggakan()],
    [/^\/history$/, (m, q) => halamanHistory(q)],
    [/^\/history\/([\w-]+)$/, (m) => halamanHistoryDetail(m[1])],
    [/^\/shu$/, (m, q) => halamanShu(q)],
  ];

  let ruteAktif = 0;
  async function rute() {
    const hash = location.hash || '#/';
    const [jalur, qs2] = hash.slice(1).split('?');
    const q = Object.fromEntries(new URLSearchParams(qs2 || ''));
    kosongkan($('#dialog-akar'));
    if (jalur === '/masuk') return halamanMasuk();
    if (!negara.user) {
      try {
        await muatSesi();
      } catch (e) {
        return halamanMasuk();
      }
    }
    const nomor = ++ruteAktif;
    try {
      for (const [re, fn] of RUTE) {
        const m = re.exec(jalur);
        if (m) {
          await fn(m, q);
          if (nomor === ruteAktif) {
            window.scrollTo(0, 0);
            tampilkanSukses();
          }
          return;
        }
      }
      kerangka('Tidak ditemukan').appendChild(h('div', { class: 'kosong' }, 'Halaman tidak ditemukan.'));
    } catch (e) {
      if (e.status === 401 || nomor !== ruteAktif) return;
      const k = $('#konten') || kerangka('Galat');
      kosongkan(k).appendChild(h('div', { class: 'pesan galat' }, pesanGalat(e)));
    }
  }

  window.addEventListener('hashchange', rute);
  cekKesehatan();
  rute();
})();
