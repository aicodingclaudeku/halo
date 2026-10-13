/**
 * KOPKU Desktop — layar "Pengaturan › Asisten AI" (1.0.25).
 *
 * Sumber modul yang DISUNTIKKAN ke bundle renderer oleh
 * `scripts/pasang-menu-asisten-ai.js` (bundle hasil `expo export` tidak memiliki
 * source TS di paket desktop ini). Isi berkas ini adalah BADAN fungsi modul
 * Metro: parameter yang tersedia `r` (require), `_e` (exports), `d` (peta
 * dependensi). Urutan `d[...]` sesuai DEPENDENSI di skrip pemasang.
 *
 * Menghubungkan KOPKU Desktop dengan Claude Desktop lewat MCP (Model Context
 * Protocol) di komputer ini — BACA SAJA. Seluruh aksi lewat
 * `window.kopkuDesktop.asistenAi` (preload) → main process (electron/mcp/).
 */
'use strict';
function interop(x) {
  return x && x.__esModule ? x : { default: x };
}
Object.defineProperty(_e, '__esModule', { value: true });
Object.defineProperty(_e, 'default', { enumerable: true, get: function () { return AsistenAiScreen; } });

const React = r(d[0]);
const View = interop(r(d[1])).default;
const Text = interop(r(d[2])).default;
const Touchable = interop(r(d[3])).default;
const ScrollView = interop(r(d[4])).default;
const StyleSheet = interop(r(d[5])).default;
const Spinner = interop(r(d[6])).default;
const Switch = interop(r(d[7])).default;
const Ionicons = r(d[8]).Ionicons;
const usePermission = r(d[9]).usePermission;
const T = r(d[10]);
const UI = r(d[11]).ui;
const notify = r(d[12]).notify;
const useAppStore = r(d[13]).useAppStore;

const C = T.colors;
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

function api() {
  const b = globalThis.kopkuDesktop;
  return b && b.asistenAi ? b.asistenAi : null;
}

const WARNA = {
  hijau: { teks: C.primaryDark, latar: C.primaryLight },
  abu: { teks: C.textMuted, latar: '#EEF0F3' },
  merah: { teks: C.danger, latar: C.dangerBg },
  kuning: { teks: C.warning, latar: C.warningBg },
};

const CONTOH = [
  'Buatkan ringkasan kondisi koperasi hari ini.',
  'Berapa total piutang pinjaman dan tunggakan saat ini? Bandingkan dengan total simpanan.',
  'Tampilkan Laporan Posisi Keuangan per akhir bulan lalu dan jelaskan pos-pos utamanya.',
  'Analisis kolektibilitas pinjaman: berapa yang Kurang Lancar, Diragukan, dan Macet?',
  'Siapa 10 anggota dengan tunggakan paling lama? Buat tabel dan saran tindak lanjut.',
  'Buat draf laporan pengurus untuk RAT berdasarkan Laporan Hasil Usaha tahun ini.',
];

function Lencana({ warna, teks, ikon }) {
  const w = WARNA[warna] || WARNA.abu;
  return h(
    View,
    { style: [s.lencana, { backgroundColor: w.latar }] },
    ikon ? h(Ionicons, { name: ikon, size: 13, color: w.teks }) : null,
    h(Text, { style: [s.lencanaTeks, { color: w.teks }] }, teks)
  );
}

function Tombol({ label, ikon, onPress, utama, bahaya, disabled, sibuk, testID, kecil }) {
  const warnaTeks = utama ? C.white : bahaya ? C.danger : C.text;
  return h(
    Touchable,
    {
      testID,
      accessibilityRole: 'button',
      disabled: !!(disabled || sibuk),
      onPress,
      style: [s.tombol, kecil && s.tombolKecil, utama && s.tombolUtama, bahaya && s.tombolBahaya, (disabled || sibuk) && s.tombolMati],
    },
    sibuk ? h(Spinner, { size: 'small', color: warnaTeks }) : ikon ? h(Ionicons, { name: ikon, size: kecil ? 14 : 16, color: warnaTeks }) : null,
    h(Text, { style: [s.tombolTeks, kecil && { fontSize: 12 }, { color: warnaTeks }] }, label)
  );
}

function Saklar({ judul, sub, ikon, nilai, onUbah, disabled, sibuk, lencana, testID }) {
  return h(
    View,
    { style: s.saklarBaris },
    h(View, { style: s.saklarIkon }, h(Ionicons, { name: ikon, size: 22, color: C.primary })),
    h(
      View,
      { style: { flex: 1, minWidth: 0 } },
      h(View, { style: s.judulBaris }, h(Text, { style: s.saklarJudul }, judul), lencana),
      h(Text, { style: s.saklarSub }, sub)
    ),
    sibuk ? h(Spinner, { size: 'small', color: C.primary, style: { marginRight: 8 } }) : null,
    h(View, { style: s.saklarKanan },
      h(Text, { style: [s.onOff, { color: nilai ? C.primary : C.textFaint }] }, nilai ? 'ON' : 'OFF'),
      h(Switch, {
        testID,
        accessibilityLabel: judul,
        value: !!nilai,
        disabled: !!(disabled || sibuk),
        onValueChange: onUbah,
        trackColor: { false: '#CBD2DA', true: '#8CC5A4' },
        thumbColor: nilai ? C.primary : '#FFFFFF',
        activeThumbColor: C.primary,
      })
    )
  );
}

function Kartu({ children, style, testID }) {
  return h(View, { style: [s.kartu, style], testID }, children);
}

function Subjudul({ teks }) {
  return h(Text, { style: s.subjudul }, teks);
}

function Langkah({ no, judul, children, selesai }) {
  return h(
    View,
    { style: s.langkah },
    h(View, { style: [s.langkahNo, selesai && s.langkahNoSelesai] }, selesai ? h(Ionicons, { name: 'checkmark', size: 15, color: C.white }) : h(Text, { style: s.langkahNoTeks }, String(no))),
    h(View, { style: { flex: 1, minWidth: 0, gap: 6 } }, h(Text, { style: s.langkahJudul }, judul), children)
  );
}

function waktuLokal(iso) {
  if (!iso) return '-';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getDate())}/${p(t.getMonth() + 1)} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

const LABEL_ALAT = {};

function AsistenAiScreen() {
  const { can } = usePermission();
  const bolehUbah = can('pengaturan', 'edit');
  const pengguna = useAppStore((x) => x.currentUser);
  const A = api();
  const [st, setSt] = useState(null);
  const [galatMuat, setGalatMuat] = useState('');
  const [sibuk, setSibuk] = useState('');
  const [manual, setManual] = useState(false);
  const hidup = useRef(true);

  const muat = useCallback(async () => {
    if (!A) return;
    try {
      const x = await A.status();
      if (!hidup.current) return;
      setSt(x);
      setGalatMuat('');
      for (const a of x.alat || []) LABEL_ALAT[a.nama] = a.judul;
    } catch (e) {
      if (hidup.current) setGalatMuat(String((e && e.message) || e));
    }
  }, [A]);

  useEffect(() => {
    hidup.current = true;
    muat();
    const t = setInterval(muat, 5000);
    return () => {
      hidup.current = false;
      clearInterval(t);
    };
  }, [muat]);

  const jalankan = async (kunci, fn, pesanBerhasil) => {
    setSibuk(kunci);
    try {
      const hasil = await fn();
      if (hasil && hasil.claude && hidup.current) setSt(hasil);
      if (pesanBerhasil) notify('Berhasil', typeof pesanBerhasil === 'function' ? pesanBerhasil(hasil) : pesanBerhasil, undefined, 'success');
      return hasil;
    } catch (e) {
      notify('Gagal', String((e && e.message) || e), undefined, 'error');
      return null;
    } finally {
      if (hidup.current) setSibuk('');
      muat();
    }
  };

  if (!A) {
    return h(ScrollView, { style: s.layar, contentContainerStyle: UI.screenContent },
      h(Kartu, null, h(Text, { style: s.teks }, 'Asisten AI hanya tersedia di KOPKU Desktop (Windows/macOS), karena terhubung dengan aplikasi Claude Desktop di komputer yang sama.')));
  }
  if (!st) {
    return h(ScrollView, { style: s.layar, contentContainerStyle: UI.screenContent },
      galatMuat ? h(View, { style: s.galat }, h(Ionicons, { name: 'alert-circle', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, galatMuat)) : h(Spinner, { color: C.primary, style: { marginTop: 40 } }));
  }

  const pid = pengguna ? pengguna.id : null;
  const aktif = !!st.aktif;
  const cl = st.claude || { claudeTerdeteksi: false, terpasang: false, cocok: false, lokasi: [] };
  const caraEkstensi = st.cara === 'ekstensi';
  const terhubung = aktif && st.berjalan && (caraEkstensi || cl.cocok);

  // ---------------- aksi
  const ubahAktif = (v) => {
    const terapkan = () =>
      jalankan('aktif', () => A.atur({ aktif: v, penggunaId: pid }), (x) =>
        !v
          ? 'Asisten AI dimatikan. Claude tidak dapat membaca data KOPKU lagi.'
          : x && x.ekstensi
            ? 'Asisten AI menyala. Node.js tidak ditemukan, jadi konektor dibuat sebagai ekstensi Claude: klik "Install" di Claude Desktop, lalu aktifkan "KOPKU — Asisten AI Koperasi".'
            : 'Asisten AI menyala. Tutup Claude Desktop sepenuhnya lalu buka lagi agar konektor "kopku" terbaca.');
    if (!v) return terapkan();
    notify(
      'Hubungkan KOPKU ke Claude?',
      'Claude (Anthropic) akan dapat MEMBACA data koperasi dari KOPKU Desktop di komputer ini saat Anda bertanya di aplikasi Claude Desktop, atas nama Anda (' +
        ((pengguna && (pengguna.nama || pengguna.username)) || 'pengguna ini') +
        ') dan sesuai izin Anda. Data yang dibaca dikirim ke Claude sebagai bagian percakapan. Claude tidak dapat mencatat atau mengubah transaksi. NIK, alamat, nomor HP, tanggal lahir, dan nomor rekening tidak pernah dikirim.',
      [{ text: 'Batal', style: 'cancel' }, { text: 'Hubungkan', style: 'default', onPress: terapkan }],
      'warning'
    );
  };
  const ubahPerAnggota = (v) => {
    const terapkan = () => jalankan('perAnggota', () => A.atur({ perAnggota: v, penggunaId: pid }), v ? 'Data per anggota diizinkan.' : 'Claude kini hanya menerima angka total & laporan.');
    if (!v) return terapkan();
    notify(
      'Izinkan data per anggota?',
      'Claude akan dapat membaca nama & nomor anggota, saldo simpanan, pinjaman, jadwal angsuran, dan tunggakan per anggota. Data pribadi (NIK, alamat, nomor HP, tanggal lahir, nomor rekening) tetap tidak dikirim.',
      [{ text: 'Batal', style: 'cancel' }, { text: 'Izinkan', style: 'default', onPress: terapkan }],
      'warning'
    );
  };
  const pasang = () =>
    jalankan('pasang', () => A.pasangClaude(pid), (x) => {
      if (x && x.ekstensi) return 'Node.js tidak ditemukan, jadi konektor dibuat sebagai ekstensi Claude (.mcpb). Klik "Install" di Claude Desktop.';
      const n = x && x.hasilPasang ? x.hasilPasang.diubah.length + x.hasilPasang.tetap.length : 0;
      return 'Konektor "kopku" terdaftar di Claude Desktop' + (n > 1 ? ` (${n} lokasi)` : '') + '. Tutup Claude Desktop sepenuhnya (ikon di tray › Quit) lalu buka lagi.';
    });
  const lepas = () =>
    notify('Lepas dari Claude Desktop?', 'Entri "kopku" dihapus dari konfigurasi Claude Desktop (cadangan dibuat). Server MCP lain tidak disentuh.', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Lepas', style: 'destructive', onPress: () => jalankan('lepas', () => A.lepasClaude(pid), 'Konektor dilepas dari Claude Desktop.') },
    ], 'warning');
  const ekstensi = () =>
    jalankan('ekstensi', () => A.buatEkstensi(pid), (x) =>
      x && x.dibuka
        ? 'Berkas ekstensi dibuka. Di Claude Desktop klik "Install", lalu aktifkan ekstensi "KOPKU — Asisten AI Koperasi".'
        : 'Berkas ekstensi dibuat: ' + (x && x.berkas) + '. Seret berkas itu ke jendela Claude Desktop (Settings › Extensions) lalu klik "Install".');
  const salin = (teks, label) => jalankan('salin', () => A.salin(teks), label || 'Disalin ke clipboard.');

  // ---------------- kartu 1: sakelar
  const lencanaUtama = !aktif
    ? h(Lencana, { warna: 'abu', teks: 'Mati', ikon: 'power' })
    : st.galat
      ? h(Lencana, { warna: 'merah', teks: 'Galat', ikon: 'alert-circle' })
      : terhubung
        ? h(Lencana, { warna: 'hijau', teks: 'Siap dipakai Claude', ikon: 'checkmark-circle' })
        : h(Lencana, { warna: 'kuning', teks: 'Menyala — belum terpasang di Claude', ikon: 'time-outline' });

  const kartuSaklar = h(
    Kartu,
    { testID: 'kartu-asisten-saklar' },
    h(Saklar, {
      judul: 'Hubungkan ke Claude',
      sub: 'Tanya data koperasi dengan bahasa sehari-hari dari aplikasi Claude Desktop di komputer ini. Hanya membaca — tidak dapat mencatat atau mengubah transaksi.',
      ikon: 'sparkles-outline',
      nilai: aktif,
      onUbah: ubahAktif,
      disabled: !bolehUbah || !pid,
      sibuk: sibuk === 'aktif',
      lencana: lencanaUtama,
      testID: 'saklar-asisten-ai',
    }),
    st.galat ? h(View, { style: s.galat }, h(Ionicons, { name: 'alert-circle', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, st.galat)) : null,
    aktif && st.pengguna
      ? h(View, { style: s.infoBaris }, h(Ionicons, { name: 'person-circle-outline', size: 16, color: C.textMuted }), h(Text, { style: s.redup }, 'Claude membaca atas nama ', h(Text, { style: s.tebal }, st.pengguna.nama || st.pengguna.username), ' (@' + st.pengguna.username + ') dan mengikuti izinnya di Permission Matrix.'))
      : null,
    h(View, { style: s.blok },
      h(Saklar, {
        judul: 'Izinkan data per anggota',
        sub: st.perAnggota
          ? 'Claude dapat membaca nama & nomor anggota, saldo simpanan, pinjaman, jadwal angsuran, tunggakan, dan riwayat transaksi.'
          : 'MATI: Claude hanya menerima angka total, laporan keuangan, dan kolektibilitas — tanpa nama anggota.',
        ikon: 'people-outline',
        nilai: !!st.perAnggota,
        onUbah: ubahPerAnggota,
        disabled: !bolehUbah || !pid,
        sibuk: sibuk === 'perAnggota',
        testID: 'saklar-asisten-per-anggota',
      })
    ),
    h(View, { style: [s.blok, s.privasi] },
      h(Ionicons, { name: 'shield-checkmark-outline', size: 18, color: C.primary }),
      h(Text, { style: [s.redup, { flex: 1 }] },
        'Tidak pernah dikirim: NIK, alamat, nomor HP, tempat/tanggal lahir, nomor rekening, password. Koneksi hanya di komputer ini (127.0.0.1 + token acak). Data yang dibaca alat dikirim ke Claude (Anthropic) sebagai bagian percakapan Anda. KOPKU Desktop harus tetap terbuka saat bertanya.')
    )
  );

  // ---------------- kartu 2: pemasangan
  const lokasiTerpasang = (cl.lokasi || []).filter((l) => l.terpasang);
  const lokasiRusak = (cl.lokasi || []).filter((l) => l.rusak);
  const lokasiLain = (cl.lokasi || []).filter((l) => l.entriLain);
  const kartuPasang = h(
    Kartu,
    { testID: 'kartu-asisten-pasang' },
    h(View, { style: s.judulBaris },
      h(Ionicons, { name: 'extension-puzzle-outline', size: 20, color: C.primary }),
      h(Text, { style: s.kartuJudul }, 'Pasang di Claude Desktop'),
      cl.claudeTerdeteksi ? h(Lencana, { warna: 'hijau', teks: 'Claude Desktop terdeteksi', ikon: 'checkmark' }) : h(Lencana, { warna: 'kuning', teks: 'Claude Desktop belum terdeteksi', ikon: 'help-circle-outline' }),
      caraEkstensi
        ? h(Lencana, { warna: 'hijau', teks: 'Cara: ekstensi .mcpb', ikon: 'cube-outline' })
        : cl.cocok
          ? h(Lencana, { warna: 'hijau', teks: 'Konektor "kopku" terpasang', ikon: 'link-outline' })
          : cl.terpasang
            ? h(Lencana, { warna: 'kuning', teks: 'Perlu diperbarui', ikon: 'refresh' })
            : h(Lencana, { warna: 'abu', teks: 'Belum terpasang', ikon: 'unlink-outline' })
    ),
    h(View, { style: { gap: 14, marginTop: 14 } },
      h(Langkah, { no: 1, judul: 'Pasang & buka Claude Desktop', selesai: cl.claudeTerdeteksi },
        h(Text, { style: s.redup }, 'Aplikasi resmi Claude untuk Windows/macOS. Masuk dengan akun Claude Anda, lalu buka sekali agar foldernya dibuat.'),
        !cl.claudeTerdeteksi ? h(View, { style: s.aksi }, h(Tombol, { label: 'Unduh Claude Desktop', ikon: 'download-outline', onPress: () => jalankan('unduh', () => A.unduhClaude()) })) : null
      ),
      h(Langkah, { no: 2, judul: 'Nyalakan "Hubungkan ke Claude" di atas', selesai: aktif && st.berjalan },
        h(Text, { style: s.redup }, 'Konektor "kopku" otomatis didaftarkan ke Claude Desktop saat dinyalakan. Gunakan tombol di bawah bila perlu mendaftarkan ulang.'),
        h(View, { style: s.aksi },
          h(Tombol, { label: cl.terpasang && !caraEkstensi ? 'Pasang ulang ke Claude Desktop' : 'Pasang ke Claude Desktop', ikon: 'link-outline', utama: !cl.cocok || caraEkstensi, onPress: pasang, sibuk: sibuk === 'pasang', disabled: !bolehUbah || !pid, testID: 'tombol-pasang-claude' }),
          cl.terpasang ? h(Tombol, { label: 'Lepas', ikon: 'unlink-outline', bahaya: true, onPress: lepas, sibuk: sibuk === 'lepas', disabled: !bolehUbah || !pid }) : null
        ),
        lokasiTerpasang.length ? h(Text, { style: s.catatan }, 'Terdaftar di: ' + lokasiTerpasang.map((l) => l.berkas).join(' · ')) : null,
        st.runtime && st.runtime.jenis === 'node'
          ? h(View, { style: s.infoBaris }, h(Ionicons, { name: 'checkmark-circle', size: 15, color: C.success }), h(Text, { style: s.catatan }, 'Claude menjalankan konektor dengan Node.js ' + (st.runtime.versi || '') + ' (' + st.runtime.path + ').'))
          : st.runtime && st.runtime.perluEkstensi
            ? h(View, { style: [s.galat, { backgroundColor: C.warningBg, borderColor: C.warningBorder }] },
                h(Ionicons, { name: 'information-circle-outline', size: 16, color: C.warning }),
                h(Text, { style: [s.galatTeks, { color: C.warning }] }, 'Node.js tidak ditemukan di komputer ini. Konektor dipasang sebagai ekstensi Claude (.mcpb) yang memakai Node.js bawaan Claude Desktop — klik "Install" saat Claude Desktop menampilkannya. Alternatif: pasang Node.js LTS (nodejs.org), lalu klik "Pasang ulang ke Claude Desktop".'))
            : null,
        lokasiRusak.length ? h(View, { style: s.galat }, h(Ionicons, { name: 'alert-circle', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, 'Berkas konfigurasi Claude rusak (bukan JSON sah), tidak diubah: ' + lokasiRusak.map((l) => l.berkas).join(', ') + '. Perbaiki berkas itu atau pakai Pasang manual.')) : null,
        lokasiLain.length ? h(View, { style: s.galat }, h(Ionicons, { name: 'alert-circle', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, 'Sudah ada server bernama "kopku" milik program lain di ' + lokasiLain.map((l) => l.berkas).join(', ') + ' — tidak ditimpa.')) : null
      ),
      h(Langkah, { no: 3, judul: 'Mulai ulang Claude Desktop', selesai: false },
        h(Text, { style: s.redup }, 'Tutup Claude Desktop SEPENUHNYA (Windows: klik kanan ikon Claude di tray › Quit; macOS: Claude › Quit), lalu buka lagi. Di kotak chat, ikon alat/konektor akan menampilkan "kopku".')
      ),
      h(Langkah, { no: 4, judul: 'Bertanya', selesai: st.pemakaian && st.pemakaian.total > 0 },
        h(Text, { style: s.redup }, 'Ketik pertanyaan di Claude Desktop. Saat Claude meminta izin memakai alat "kopku", pilih Allow. Jangan tutup KOPKU Desktop.')
      )
    ),
    h(View, { style: s.blok },
      h(Subjudul, { teks: 'Cara lain bila konektor tidak muncul' }),
      h(View, { style: s.caraLain },
        h(View, { style: { flex: 1, minWidth: 240, gap: 6 } },
          h(Text, { style: s.tebal }, 'Ekstensi Claude (.mcpb)'),
          h(Text, { style: s.redup }, 'Membuat paket ekstensi lalu membukanya di Claude Desktop (klik Install). Memakai Node.js bawaan Claude Desktop. Entri konfigurasi di atas dilepas agar tidak ganda.'),
          h(View, { style: s.aksi }, h(Tombol, { label: 'Buat & buka ekstensi', ikon: 'cube-outline', onPress: ekstensi, sibuk: sibuk === 'ekstensi', disabled: !bolehUbah || !pid, testID: 'tombol-ekstensi-claude' }))
        ),
        h(View, { style: { flex: 1, minWidth: 240, gap: 6 } },
          h(Text, { style: s.tebal }, 'Pasang manual'),
          h(Text, { style: s.redup }, 'Claude Desktop › Settings › Developer › Edit Config, lalu tambahkan isi berikut ke claude_desktop_config.json.'),
          h(View, { style: s.aksi },
            h(Tombol, { label: manual ? 'Sembunyikan' : 'Tampilkan konfigurasi', ikon: manual ? 'chevron-up' : 'code-slash-outline', onPress: () => setManual(!manual) }),
            h(Tombol, { label: 'Salin', ikon: 'copy-outline', onPress: () => salin(st.potonganManual, 'Konfigurasi disalin. Tempel ke claude_desktop_config.json.') })
          )
        )
      ),
      manual ? h(View, { style: s.kode }, h(Text, { selectable: true, style: s.kodeTeks }, st.potonganManual)) : null
    )
  );

  // ---------------- kartu 3: contoh pertanyaan & alat
  const kartuContoh = h(
    Kartu,
    null,
    h(View, { style: s.judulBaris }, h(Ionicons, { name: 'chatbubbles-outline', size: 20, color: C.primary }), h(Text, { style: s.kartuJudul }, 'Contoh pertanyaan di Claude')),
    h(View, { style: { marginTop: 10, gap: 6 } },
      CONTOH.map((t, i) =>
        h(View, { key: i, style: s.contoh },
          h(Ionicons, { name: 'chatbubble-ellipses-outline', size: 15, color: C.textMuted }),
          h(Text, { style: [s.teks, { flex: 1 }] }, t),
          h(Tombol, { label: 'Salin', ikon: 'copy-outline', kecil: true, onPress: () => salin(t, 'Pertanyaan disalin. Tempel di Claude Desktop.') })
        )
      )
    ),
    h(View, { style: s.blok },
      h(Subjudul, { teks: `Alat yang dapat dipakai Claude (${st.jumlahAlat} dari ${(st.alat || []).length}) — semuanya baca saja` }),
      h(View, { style: s.chipBaris },
        (st.alat || []).map((a) =>
          h(View, { key: a.nama, style: [s.chip, a.aktif ? s.chipAktif : null] },
            h(Ionicons, { name: a.aktif ? 'checkmark-circle' : 'lock-closed-outline', size: 14, color: a.aktif ? C.primary : C.textFaint }),
            h(Text, { style: [s.chipTeks, a.aktif && { color: C.primaryDark }] }, a.judul)
          )
        )
      ),
      !st.perAnggota ? h(Text, { style: s.catatan }, 'Alat bergembok memerlukan "Izinkan data per anggota". Alat juga hanya berjalan bila pengguna punya izin Lihat pada menu terkait.') : null
    )
  );

  // ---------------- kartu 4: aktivitas
  const riwayat = st.riwayat || [];
  const kartuAktivitas = h(
    Kartu,
    null,
    h(View, { style: s.judulBaris },
      h(Ionicons, { name: 'pulse-outline', size: 20, color: C.primary }),
      h(Text, { style: s.kartuJudul }, 'Aktivitas'),
      h(Lencana, { warna: 'abu', teks: `Sesi ini: ${st.pemakaian ? st.pemakaian.total : 0}× dipakai` + (st.pemakaian && st.pemakaian.gagal ? `, ${st.pemakaian.gagal} gagal` : '') }),
      h(View, { style: { flex: 1 } }),
      h(Tombol, { label: 'Buka folder log', ikon: 'folder-open-outline', kecil: true, onPress: () => jalankan('folder', () => A.bukaFolder()) })
    ),
    h(View, { style: { marginTop: 10 } },
      riwayat.length === 0
        ? h(Text, { style: s.redup }, 'Belum ada aktivitas. Setiap kali Claude memakai alat, waktu, nama alat, dan hasilnya (berhasil/gagal) dicatat di sini — tanpa isi data.')
        : riwayat.map((x, i) =>
            h(View, { key: i, style: s.logBaris },
              h(Lencana, { warna: x.status === 'BERHASIL' ? 'hijau' : 'merah', teks: x.status === 'BERHASIL' ? 'Berhasil' : 'Gagal' }),
              h(Text, { style: [s.td, { width: 190 }], numberOfLines: 1 }, x.alat === '(pengaturan)' ? 'Pengaturan diubah' : LABEL_ALAT[x.alat] || x.alat),
              h(Text, { style: s.logTeks, numberOfLines: 1 }, x.ket || x.ms || ''),
              h(Text, { style: s.logWaktu }, waktuLokal(x.waktu))
            )
          )
    )
  );

  return h(
    ScrollView,
    { style: s.layar, contentContainerStyle: UI.screenContent, testID: 'layar-asisten-ai' },
    h(Text, { style: UI.screenIntro }, 'Hubungkan KOPKU dengan Claude (Anthropic) lewat MCP agar Anda dapat bertanya tentang data koperasi — ringkasan, laporan keuangan, kolektibilitas, tunggakan, simpanan, pinjaman, SHU — langsung dari aplikasi Claude Desktop. Mati secara bawaan.'),
    !bolehUbah ? h(View, { style: [s.galat, { backgroundColor: C.warningBg, borderColor: C.warningBorder, marginBottom: 12 }] }, h(Ionicons, { name: 'lock-closed-outline', size: 16, color: C.warning }), h(Text, { style: [s.galatTeks, { color: C.warning }] }, 'Hanya pengguna dengan izin ubah Pengaturan (Admin) yang dapat menyalakan/mematikan Asisten AI.')) : null,
    h(View, { style: s.kolom }, kartuSaklar, kartuPasang, kartuContoh, kartuAktivitas)
  );
}

const s = StyleSheet.create({
  layar: { flex: 1, backgroundColor: C.background },
  kolom: { gap: 14, maxWidth: 980 },
  kartu: Object.assign({ backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: T.radius.lg, padding: 18 }, T.elevation.card),
  kartuJudul: { fontSize: 15.5, fontWeight: '800', color: C.text },
  saklarBaris: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  saklarIkon: { width: 44, height: 44, borderRadius: T.radius.md, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judulBaris: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  saklarJudul: { fontSize: 16, fontWeight: '800', color: C.text },
  saklarSub: { fontSize: 12.5, lineHeight: 18, color: C.textMuted, marginTop: 3 },
  saklarKanan: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onOff: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, width: 30, textAlign: 'right' },
  lencana: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 2, borderRadius: T.radius.pill },
  lencanaTeks: { fontSize: 11.5, fontWeight: '700' },
  blok: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.border, gap: 8 },
  privasi: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  subjudul: { fontSize: 11.5, fontWeight: '700', color: '#667085', letterSpacing: 0.8, textTransform: 'uppercase' },
  teks: { fontSize: 13, color: C.text, flexShrink: 1 },
  tebal: { fontSize: 13, fontWeight: '700', color: C.text },
  redup: { fontSize: 12.5, color: C.textMuted, lineHeight: 18 },
  catatan: { fontSize: 11.5, color: C.textMuted, lineHeight: 16, marginTop: 2 },
  infoBaris: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  galat: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.dangerBg, borderWidth: 1, borderColor: '#F3C7C5', borderRadius: T.radius.md, paddingHorizontal: 12, paddingVertical: 8, marginTop: 8 },
  galatTeks: { fontSize: 12.5, color: C.danger, flex: 1 },
  aksi: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  tombol: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: T.radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  tombolKecil: { minHeight: 28, paddingHorizontal: 10 },
  tombolUtama: { backgroundColor: C.primary, borderColor: C.primary },
  tombolBahaya: { borderColor: C.danger },
  tombolMati: { opacity: 0.5 },
  tombolTeks: { fontSize: 13, fontWeight: '700' },
  langkah: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  langkahNo: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: C.primary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  langkahNoSelesai: { backgroundColor: C.primary },
  langkahNoTeks: { fontSize: 12.5, fontWeight: '800', color: C.primary },
  langkahJudul: { fontSize: 13.5, fontWeight: '800', color: C.text },
  caraLain: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  kode: { marginTop: 8, backgroundColor: '#0F1720', borderRadius: T.radius.md, padding: 12 },
  kodeTeks: { fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace', fontSize: 12, lineHeight: 17, color: '#D7F5E1' },
  contoh: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F0F2F5' },
  chipBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: T.radius.pill, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  chipAktif: { borderColor: '#9CCBB0', backgroundColor: C.primaryLight },
  chipTeks: { fontSize: 12, fontWeight: '600', color: C.textMuted },
  logBaris: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F0F2F5' },
  logTeks: { flex: 1, fontSize: 12.5, color: C.textMuted },
  logWaktu: { fontSize: 11.5, color: C.textFaint },
  td: { fontSize: 13, fontWeight: '600', color: C.text },
});
