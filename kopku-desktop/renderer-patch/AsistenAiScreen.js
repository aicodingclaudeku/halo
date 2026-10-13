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
 * Protocol) di komputer ini — membaca; mengubah data hanya bila diizinkan (1.0.27). Seluruh aksi lewat
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
const TextInput = interop(r(d[14])).default;

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

// ============================================================ PANDUAN SLIDE BERANIMASI (1.0.28)
// Animasi memakai gaya CSS react-native-web (animationKeyframes) — tanpa pustaka tambahan.
const KF = {
  naik: [{ '0%': { opacity: 0, transform: [{ translateY: 18 }] }, '100%': { opacity: 1, transform: [{ translateY: 0 }] } }],
  muncul: [{ '0%': { opacity: 0 }, '100%': { opacity: 1 } }],
  pop: [{ '0%': { opacity: 0, transform: [{ scale: 0.6 }] }, '70%': { opacity: 1, transform: [{ scale: 1.08 }] }, '100%': { opacity: 1, transform: [{ scale: 1 }] } }],
  kanan: [{ '0%': { opacity: 0, transform: [{ translateX: -22 }] }, '100%': { opacity: 1, transform: [{ translateX: 0 }] } }],
  denyut: [{ '0%': { transform: [{ scale: 1 }] }, '50%': { transform: [{ scale: 1.06 }] }, '100%': { transform: [{ scale: 1 }] } }],
  lompat: [{ '0%': { transform: [{ translateY: 0 }] }, '50%': { transform: [{ translateY: -8 }] }, '100%': { transform: [{ translateY: 0 }] } }],
  ketik: [{ '0%': { width: 0 }, '100%': { width: '100%' } }],
  tuasGeser: [{ '0%': { transform: [{ translateX: 0 }] }, '100%': { transform: [{ translateX: 22 }] } }],
  tuasWarna: [{ '0%': { backgroundColor: '#CBD2DA' }, '100%': { backgroundColor: '#1E7B4A' } }],
  sorot: [{ '0%': { backgroundColor: 'rgba(30,123,74,0)' }, '100%': { backgroundColor: 'rgba(30,123,74,0.16)' } }],
  isi: [{ '0%': { width: '0%' }, '100%': { width: '100%' } }],
};
// react-native-web hanya mengubah animationKeyframes menjadi @keyframes bila lewat StyleSheet.create
// (gaya inline membuangnya) → setiap kombinasi dibuat sekali lalu disimpan.
const CACHE_AN = new Map();
function an(nama, tunda, durasi, ulang) {
  const kunci = [nama, tunda || 0, durasi || 600, ulang ? 1 : 0].join('|');
  if (!CACHE_AN.has(kunci)) {
    CACHE_AN.set(kunci, StyleSheet.create({ a: { animationKeyframes: KF[nama], animationDuration: `${durasi || 600}ms`, animationDelay: `${tunda || 0}ms`, animationFillMode: 'both', animationTimingFunction: 'ease-out', animationIterationCount: ulang ? 'infinite' : 1 } }).a);
  }
  return CACHE_AN.get(kunci);
}

function Jendela({ judul, children, lebar }) {
  return h(View, { style: [sp.jendela, lebar ? { width: lebar } : null, an('naik', 0, 500)] },
    h(View, { style: sp.jendelaBar }, h(View, { style: [sp.titik, { backgroundColor: '#F87171' }] }), h(View, { style: [sp.titik, { backgroundColor: '#FBBF24' }] }), h(View, { style: [sp.titik, { backgroundColor: '#34D399' }] }), h(Text, { style: sp.jendelaJudul }, judul)),
    h(View, { style: sp.jendelaIsi }, children)
  );
}
function Gelembung({ dari, teks, tunda, ketik }) {
  const ai = dari === 'ai';
  return h(View, { style: [sp.gelembung, ai ? sp.gelembungAi : sp.gelembungUser, an('naik', tunda, 500)] },
    ketik ? h(View, { style: [{ overflow: 'hidden' }, an('ketik', tunda + 300, 1400)] }, h(Text, { style: [sp.gelembungTeks, ai ? null : { color: '#fff' }], numberOfLines: 3 }, teks)) : h(Text, { style: [sp.gelembungTeks, ai ? null : { color: '#fff' }] }, teks)
  );
}
function TuasAnimasi({ tunda, label }) {
  return h(View, { style: sp.tuasBaris },
    h(Text, { style: sp.tuasLabel }, label),
    h(View, { style: [sp.tuas, an('tuasWarna', tunda, 350)] }, h(View, { style: [sp.tuasKnop, an('tuasGeser', tunda, 350)] }))
  );
}
function Poin({ ikon, teks, tunda, warna }) {
  return h(View, { style: [sp.poin, an('kanan', tunda, 450)] }, h(View, { style: [sp.poinIkon, warna ? { backgroundColor: warna } : null] }, h(Ionicons, { name: ikon, size: 16, color: C.white })), h(Text, { style: sp.poinTeks }, teks));
}
function Pil({ teks, ikon, tunda, warna }) {
  return h(View, { style: [sp.pil, warna === 'kuning' ? sp.pilKuning : null, an('pop', tunda, 450)] }, ikon ? h(Ionicons, { name: ikon, size: 13, color: warna === 'kuning' ? C.warning : C.primaryDark }) : null, h(Text, { style: [sp.pilTeks, warna === 'kuning' ? { color: C.warning } : null] }, teks));
}

const SLIDE = [
  {
    judul: 'Asisten AI untuk koperasi Anda',
    teks: 'Hubungkan KOPKU dengan Claude di komputer ini. Tanya data dengan bahasa sehari-hari — dan bila Anda izinkan, minta bantuan mencatat transaksi, mengimpor data, atau mengoreksi kesalahan.',
    gambar: () => h(View, { style: sp.tengah },
      h(View, { style: [sp.ikonBesar, an('pop', 0, 700)] }, h(Ionicons, { name: 'sparkles-outline', size: 54, color: C.primary })),
      h(View, { style: [sp.barisPil, { marginTop: 18 }] }, h(Pil, { teks: 'Tanya data', ikon: 'chatbubbles-outline', tunda: 500 }), h(Pil, { teks: 'Bantu input & import', ikon: 'create-outline', tunda: 800 }), h(Pil, { teks: 'Koreksi aman', ikon: 'shield-checkmark-outline', tunda: 1100 }))
    ),
  },
  {
    judul: '1. Pasang Claude Desktop',
    teks: 'Unduh aplikasi resmi Claude untuk Windows/macOS di claude.ai/download, pasang, buka sekali, lalu masuk dengan akun Claude Anda.',
    gambar: () => h(Jendela, { judul: 'claude.ai/download' },
      h(View, { style: sp.tengah },
        h(View, { style: an('lompat', 400, 900, true) }, h(Ionicons, { name: 'download-outline', size: 46, color: C.primary })),
        h(View, { style: [sp.tombolMock, an('pop', 600, 400)] }, h(Text, { style: sp.tombolMockTeks }, 'Download for Windows')),
        h(View, { style: [sp.progres, an('muncul', 900, 300)] }, h(View, { style: [sp.progresIsi, an('isi', 1000, 2200)] }))
      )
    ),
  },
  {
    judul: '2. Nyalakan "Aktifkan Asisten AI"',
    teks: 'Di KOPKU: Pengaturan › Asisten AI › nyalakan sakelar, lalu pilih "Hubungkan". KOPKU otomatis mendaftarkan konektor "kopku" ke Claude Desktop.',
    gambar: () => h(Jendela, { judul: 'KOPKU › Pengaturan › Asisten AI' },
      h(TuasAnimasi, { tunda: 900, label: 'Aktifkan Asisten AI' }),
      h(View, { style: [sp.barisPil, { marginTop: 14 }] }, h(Pil, { teks: 'Siap dipakai Claude', ikon: 'checkmark-circle', tunda: 1500 }), h(Pil, { teks: 'Konektor "kopku" terpasang', ikon: 'link-outline', tunda: 1800 }))
    ),
  },
  {
    judul: '3. Mulai ulang Claude Desktop',
    teks: 'Tutup Claude SEPENUHNYA: klik kanan ikon Claude di tray (dekat jam) › Quit. Lalu buka lagi agar konektor "kopku" terbaca.',
    gambar: () => h(View, { style: sp.tengah },
      h(View, { style: [sp.menuTray, an('naik', 200, 500)] },
        h(Text, { style: sp.menuItem }, 'Show Claude'),
        h(Text, { style: sp.menuItem }, 'Settings…'),
        h(View, { style: [sp.menuItemSorot, an('sorot', 900, 400)] }, h(Text, { style: [sp.menuItem, { fontWeight: '800' }] }, 'Quit'))
      ),
      h(View, { style: [sp.barisPil, { marginTop: 16 }] }, h(Pil, { teks: 'Buka Claude lagi', ikon: 'refresh', tunda: 1500 }))
    ),
  },
  {
    judul: '4. Bertanya di Claude',
    teks: 'Ketik pertanyaan seperti biasa. Saat Claude meminta izin memakai alat "kopku", pilih Allow. KOPKU Desktop harus tetap terbuka.',
    gambar: () => h(Jendela, { judul: 'Claude' },
      h(Gelembung, { dari: 'user', teks: 'Berapa total tunggakan saat ini?', tunda: 200 }),
      h(View, { style: [sp.alatPakai, an('pop', 900, 400)] }, h(Ionicons, { name: 'construct-outline', size: 13, color: C.textMuted }), h(Text, { style: sp.alatPakaiTeks }, 'Menggunakan alat: kopku › daftar_tunggakan')),
      h(Gelembung, { dari: 'ai', teks: 'Ada 9 angsuran menunggak dari 3 pinjaman, total Rp4.905.000. Yang paling lama 59 hari.', tunda: 1500, ketik: true })
    ),
  },
  {
    judul: '5. Mengubah data — selalu dengan persetujuan Anda',
    teks: 'Bila admin menyalakan "Izinkan Claude mengubah data", Claude menampilkan PRATINJAU dulu. Data baru disimpan setelah Anda setuju. Backup otomatis dibuat sebelumnya.',
    gambar: () => h(Jendela, { judul: 'Claude' },
      h(Gelembung, { dari: 'user', teks: 'Catat setoran wajib Oktober Rp50.000 untuk A00012', tunda: 200 }),
      h(View, { style: [sp.pratinjau, an('naik', 900, 500)] },
        h(Text, { style: sp.pratinjauJudul }, 'PRATINJAU — belum disimpan'),
        h(Text, { style: sp.pratinjauTeks }, 'Setor simpanan wajib · A00012 · Rp50.000 · saldo Rp450.000 → Rp500.000')
      ),
      h(Gelembung, { dari: 'user', teks: 'Ya, simpan.', tunda: 1800 }),
      h(View, { style: [sp.barisPil, { marginTop: 8 }] }, h(Pil, { teks: 'Backup otomatis', ikon: 'cloud-done-outline', tunda: 2400 }), h(Pil, { teks: 'Tersimpan: SP-WAJIB-2026-000123', ikon: 'checkmark-circle', tunda: 2700 }))
    ),
  },
  {
    judul: '6. Koreksi dan import Excel',
    teks: 'Kesalahan diperbaiki dengan JURNAL PEMBALIK — transaksi asal tetap tercatat, tidak ada yang dihapus. Import Data Awal memakai pemeriksaan yang sama dengan menu Import.',
    gambar: () => h(View, { style: sp.duaKolom },
      h(View, { style: [sp.kartuMini, an('naik', 200, 500)] },
        h(Text, { style: sp.kartuMiniJudul }, 'Koreksi transaksi'),
        h(View, { style: [sp.jurnal, an('kanan', 600, 400)] }, h(Text, { style: sp.jurnalTeks }, 'SP-WAJIB-…123  Rp50.000')),
        h(View, { style: [sp.jurnal, sp.jurnalBalik, an('kanan', 1200, 400)] }, h(Text, { style: sp.jurnalTeks }, '↩ Pembalik  −Rp50.000')),
        h(Text, { style: [sp.kecil, an('muncul', 1700, 400)] }, 'Asal tetap tercatat · jejak koreksi tersimpan')
      ),
      h(View, { style: [sp.kartuMini, an('naik', 500, 500)] },
        h(Text, { style: sp.kartuMiniJudul }, 'Import Data Awal'),
        h(View, { style: [sp.berkas, an('pop', 900, 400)] }, h(Ionicons, { name: 'document-text-outline', size: 22, color: C.primary }), h(Text, { style: sp.jurnalTeks }, 'saldo-lama.xlsx')),
        h(Poin, { ikon: 'search-outline', teks: 'Pratinjau & periksa baris', tunda: 1400 }),
        h(Poin, { ikon: 'checkmark-done-outline', teks: 'Impor setelah disetujui', tunda: 1900 })
      )
    ),
  },
  {
    judul: '7. Cara lain: ekstensi Claude (.mcpb)',
    teks: 'Bila konektor tidak muncul, klik "Buat & buka ekstensi". Pilih folder penyimpanan (bawaan: Dokumen › KOPKU Desktop), lalu klik Install di Claude Desktop.',
    gambar: () => h(Jendela, { judul: 'Simpan ekstensi Claude (KOPKU Asisten AI)' },
      h(View, { style: [sp.dialogBaris, an('kanan', 300, 400)] }, h(Ionicons, { name: 'folder-open-outline', size: 18, color: C.warning }), h(Text, { style: sp.jurnalTeks }, 'Dokumen › KOPKU Desktop')),
      h(View, { style: [sp.dialogBaris, an('kanan', 700, 400)] }, h(Ionicons, { name: 'cube-outline', size: 18, color: C.primary }), h(Text, { style: sp.jurnalTeks }, 'KOPKU-Asisten-AI.mcpb')),
      h(View, { style: [sp.barisPil, { marginTop: 12 }] }, h(View, { style: [sp.tombolMock, an('pop', 1200, 400)] }, h(Text, { style: sp.tombolMockTeks }, 'Simpan')), h(View, { style: [sp.tombolMock, sp.tombolMockUngu, an('pop', 1800, 400)] }, h(Text, { style: sp.tombolMockTeks }, 'Install di Claude')))
    ),
  },
  {
    judul: '8. ChatGPT (opsional)',
    teks: 'Tab ChatGPT memakai cara resmi OpenAI (Secure MCP Tunnel). Sekali saja: tempel Tunnel ID + Runtime API key dari OpenAI Platform. Lalu klik "Hubungkan ke ChatGPT" dan tambahkan konektor (Connection: Tunnel) di ChatGPT. Tanpa URL publik, tanpa Command Prompt.',
    gambar: () => h(Jendela, { judul: 'KOPKU › Asisten AI › ChatGPT' },
      h(View, { style: [sp.dialogBaris, an('kanan', 300, 400)] }, h(Ionicons, { name: 'key-outline', size: 18, color: C.primary }), h(Text, { style: sp.jurnalTeks }, '1  Tunnel ID + API key (sekali)')),
      h(View, { style: [sp.dialogBaris, an('kanan', 800, 400)] }, h(Ionicons, { name: 'link-outline', size: 18, color: C.primary }), h(Text, { style: sp.jurnalTeks }, '2  Hubungkan ke ChatGPT')),
      h(View, { style: [sp.dialogBaris, an('kanan', 1300, 400)] }, h(Ionicons, { name: 'chatbubbles-outline', size: 18, color: C.primary }), h(Text, { style: sp.jurnalTeks }, '3  ChatGPT › Connector › Tunnel')),
      h(View, { style: [sp.barisPil, { marginTop: 12 }] }, h(Pil, { teks: 'Terhubung', ikon: 'checkmark-circle', tunda: 1800 }), h(Pil, { teks: 'Ubah data: izin terpisah', ikon: 'create-outline', warna: 'kuning', tunda: 2200 }))
    ),
  },
  {
    judul: '9. Aman dan rahasia',
    teks: 'Asisten AI dirancang hanya untuk pekerjaan koperasi yang sah.',
    gambar: () => h(View, { style: { gap: 10, paddingHorizontal: 10 } },
      h(Poin, { ikon: 'eye-off-outline', teks: 'NIK, alamat, nomor HP, tanggal lahir, rekening tidak pernah dikirim', tunda: 200 }),
      h(Poin, { ikon: 'lock-closed-outline', teks: 'Struktur aplikasi (kode, basis data, folder, kunci) tidak dibuka ke AI', tunda: 600 }),
      h(Poin, { ikon: 'ban-outline', teks: 'Permintaan ilegal (memalsukan/menyembunyikan transaksi, rekayasa laporan) ditolak', tunda: 1000, warna: C.danger }),
      h(Poin, { ikon: 'speedometer-outline', teks: 'Batas aman: maks 10 perubahan/menit, 120/jam', tunda: 1400 }),
      h(Poin, { ikon: 'list-outline', teks: 'Semua pemakaian tercatat · dapat dimatikan kapan saja', tunda: 1800 })
    ),
  },
  {
    judul: 'Siap dipakai!',
    teks: 'Contoh pertanyaan: "Buatkan ringkasan kondisi koperasi hari ini", "Siapa 10 anggota dengan tunggakan terlama?", "Buat draf laporan pengurus untuk RAT". Selalu periksa jawaban & pratinjau — AI dapat keliru.',
    gambar: () => h(View, { style: sp.tengah },
      h(View, { style: [sp.ikonBesar, an('pop', 0, 700), { backgroundColor: C.primaryLight }] }, h(Ionicons, { name: 'checkmark-done-outline', size: 54, color: C.primary })),
      h(View, { style: an('denyut', 800, 1600, true) }, h(Text, { style: [sp.slideJudul, { marginTop: 14, fontSize: 18 }] }, 'Selamat bertanya 👋'))
    ),
  },
];

function PanduanSlide({ onTutup }) {
  const [i, setI] = useState(0);
  const [otomatis, setOtomatis] = useState(false);
  const maju = useCallback(() => setI((x) => Math.min(SLIDE.length - 1, x + 1)), []);
  const mundur = useCallback(() => setI((x) => Math.max(0, x - 1)), []);
  useEffect(() => {
    const t = (e) => {
      if (e.key === 'ArrowRight') maju();
      else if (e.key === 'ArrowLeft') mundur();
      else if (e.key === 'Escape') onTutup();
    };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('keydown', t);
    return () => typeof window !== 'undefined' && window.removeEventListener && window.removeEventListener('keydown', t);
  }, [maju, mundur, onTutup]);
  useEffect(() => {
    if (!otomatis) return undefined;
    const t = setTimeout(() => (i < SLIDE.length - 1 ? maju() : setOtomatis(false)), 7000);
    return () => clearTimeout(t);
  }, [otomatis, i, maju]);
  const sl = SLIDE[i];
  return h(View, { style: sp.latar, testID: 'panduan-asisten-ai' },
    h(View, { style: [sp.kotak, an('pop', 0, 350)] },
      h(View, { style: sp.kepala },
        h(Ionicons, { name: 'easel-outline', size: 18, color: C.primary }),
        h(Text, { style: sp.kepalaTeks }, `Panduan Asisten AI · ${i + 1}/${SLIDE.length}`),
        h(View, { style: { flex: 1 } }),
        h(Touchable, { accessibilityRole: 'button', onPress: () => setOtomatis(!otomatis), style: sp.ikonTombol, testID: 'panduan-otomatis' }, h(Ionicons, { name: otomatis ? 'pause' : 'play', size: 16, color: C.text })),
        h(Touchable, { accessibilityRole: 'button', onPress: onTutup, style: sp.ikonTombol, testID: 'panduan-tutup' }, h(Ionicons, { name: 'close', size: 18, color: C.text }))
      ),
      otomatis ? h(View, { style: sp.progresAtas }, h(View, { key: 'p' + i, style: [sp.progresIsi, an('isi', 0, 7000)] })) : null,
      h(View, { key: 'slide-' + i, style: sp.isiSlide },
        h(View, { style: sp.gambar }, sl.gambar()),
        h(View, { style: [sp.teksSlide, an('naik', 150, 450)] }, h(Text, { style: sp.slideJudul }, sl.judul), h(Text, { style: sp.slideTeks }, sl.teks))
      ),
      h(View, { style: sp.kaki },
        h(Tombol, { label: 'Sebelumnya', ikon: 'chevron-back', disabled: i === 0, onPress: mundur, testID: 'panduan-mundur' }),
        h(View, { style: sp.titikBaris }, SLIDE.map((_, k) => h(Touchable, { key: k, accessibilityRole: 'button', accessibilityLabel: `Slide ${k + 1}`, onPress: () => setI(k), style: [sp.titikNav, k === i && sp.titikNavAktif] }))),
        i < SLIDE.length - 1 ? h(Tombol, { label: 'Berikutnya', ikon: 'chevron-forward', utama: true, onPress: maju, testID: 'panduan-maju' }) : h(Tombol, { label: 'Selesai', ikon: 'checkmark', utama: true, onPress: onTutup, testID: 'panduan-selesai' })
      )
    )
  );
}

const sp = StyleSheet.create({
  latar: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,32,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 },
  kotak: Object.assign({ width: '100%', maxWidth: 820, backgroundColor: C.surface, borderRadius: T.radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: C.border }, T.elevation.card),
  kepala: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: '#F7F8FA' },
  kepalaTeks: { fontSize: 13, fontWeight: '700', color: C.text },
  ikonTombol: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  progresAtas: { height: 3, backgroundColor: '#EEF0F3' },
  isiSlide: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, padding: 22, minHeight: 330, alignItems: 'center' },
  gambar: { flex: 1.15, minWidth: 300, minHeight: 280, alignItems: 'stretch', justifyContent: 'center' },
  teksSlide: { flex: 1, minWidth: 240, gap: 10 },
  slideJudul: { fontSize: 21, fontWeight: '800', color: C.text },
  slideTeks: { fontSize: 14, lineHeight: 21, color: C.textMuted },
  kaki: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border },
  titikBaris: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center', flex: 1 },
  titikNav: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#D6DBE1' },
  titikNavAktif: { backgroundColor: C.primary, width: 22 },
  tengah: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  ikonBesar: { width: 104, height: 104, borderRadius: 52, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center' },
  barisPil: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  pil: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: T.radius.pill, backgroundColor: C.primaryLight, borderWidth: 1, borderColor: '#9CCBB0' },
  pilKuning: { backgroundColor: C.warningBg, borderColor: C.warningBorder },
  pilTeks: { fontSize: 12, fontWeight: '700', color: C.primaryDark },
  jendela: { borderWidth: 1, borderColor: C.border, borderRadius: T.radius.md, overflow: 'hidden', backgroundColor: C.surface },
  jendelaBar: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#F1F3F6', borderBottomWidth: 1, borderBottomColor: C.border },
  titik: { width: 9, height: 9, borderRadius: 5 },
  jendelaJudul: { fontSize: 11.5, color: C.textMuted, marginLeft: 8, fontWeight: '600' },
  jendelaIsi: { padding: 14, gap: 8, minHeight: 200, justifyContent: 'center' },
  gelembung: { maxWidth: '88%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  gelembungUser: { alignSelf: 'flex-end', backgroundColor: '#3B6FD8' },
  gelembungAi: { alignSelf: 'flex-start', backgroundColor: '#F1F3F6' },
  gelembungTeks: { fontSize: 13, lineHeight: 18, color: C.text },
  alatPakai: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: C.border },
  alatPakaiTeks: { fontSize: 11.5, color: C.textMuted },
  tuasBaris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 },
  tuasLabel: { fontSize: 15, fontWeight: '800', color: C.text },
  tuas: { width: 46, height: 24, borderRadius: 12, padding: 2, backgroundColor: '#CBD2DA' },
  tuasKnop: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  menuTray: Object.assign({ width: 220, backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingVertical: 6 }, T.elevation.card),
  menuItem: { fontSize: 13, color: C.text, paddingHorizontal: 14, paddingVertical: 6 },
  menuItemSorot: { borderRadius: 4, marginHorizontal: 4 },
  tombolMock: { alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: C.primary, marginTop: 6 },
  tombolMockUngu: { backgroundColor: '#C2410C' },
  tombolMockTeks: { color: '#fff', fontWeight: '800', fontSize: 13 },
  progres: { width: 220, height: 6, borderRadius: 3, backgroundColor: '#EEF0F3', overflow: 'hidden', marginTop: 10 },
  progresIsi: { height: '100%', backgroundColor: C.primary },
  pratinjau: { borderWidth: 1, borderStyle: 'dashed', borderColor: C.warningBorder, backgroundColor: C.warningBg, borderRadius: 10, padding: 10, gap: 3 },
  pratinjauJudul: { fontSize: 11, fontWeight: '800', color: C.warning, letterSpacing: 0.5 },
  pratinjauTeks: { fontSize: 12.5, color: C.text },
  duaKolom: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  kartuMini: { flex: 1, minWidth: 150, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: C.surface },
  kartuMiniJudul: { fontSize: 13, fontWeight: '800', color: C.text },
  jurnal: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, backgroundColor: '#F1F3F6' },
  jurnalBalik: { backgroundColor: C.dangerBg },
  jurnalTeks: { fontSize: 12, color: C.text, fontWeight: '600' },
  kecil: { fontSize: 11, color: C.textMuted },
  berkas: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: C.border },
  poin: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  poinIkon: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  poinTeks: { flex: 1, fontSize: 13, color: C.text, lineHeight: 18 },
  dialogBaris: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9, borderRadius: 8, backgroundColor: '#F7F8FA', borderWidth: 1, borderColor: C.border },
});

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
  const [panduan, setPanduan] = useState(false);
  const [tab, setTab] = useState('claude');
  const [tunnelInput, setTunnelInput] = useState(null);
  const [kunciInput, setKunciInput] = useState('');
  const tutupPanduan = useCallback(() => setPanduan(false), []);

  const muat = useCallback(async () => {
    if (!A) return;
    try {
      const x = await A.status();
      if (!hidup.current) return;
      setSt(x);
      setGalatMuat('');
      for (const a of (x.alat || []).concat(x.alatTulis || [])) LABEL_ALAT[a.nama] = a.judul;
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
      const pesan = typeof pesanBerhasil === 'function' ? pesanBerhasil(hasil) : pesanBerhasil;
      if (pesan) notify('Berhasil', pesan, undefined, 'success');
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
        ') dan sesuai izin Anda. Data yang dibaca dikirim ke Claude sebagai bagian percakapan. Claude tidak dapat mengubah data kecuali Anda juga menyalakan "Izinkan Claude mengubah data". NIK, alamat, nomor HP, tanggal lahir, dan nomor rekening tidak pernah dikirim.',
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
  const ubahBolehTulis = (v) => {
    const terapkan = () =>
      jalankan('bolehTulis', () => A.atur({ bolehTulis: v, penggunaId: pid }), v
        ? 'Claude kini dapat mengubah data (selalu lewat pratinjau + persetujuan Anda). Daftar alat di Claude diperbarui otomatis.'
        : 'Claude kembali hanya dapat membaca data.');
    if (!v) return terapkan();
    notify(
      'Izinkan Claude MENGUBAH data koperasi?',
      'Claude akan dapat mencatat transaksi (setor/tarik simpanan, ajukan/cairkan pinjaman, bayar angsuran, pelunasan, kas masuk/keluar/transfer), menambah & mengubah data anggota, MENGIMPOR Data Awal dari Excel, dan MENGOREKSI transaksi dengan jurnal pembalik — atas nama ' +
        ((pengguna && (pengguna.nama || pengguna.username)) || 'pengguna ini') +
        ' dan sesuai izinnya.\n\nPengaman: setiap perubahan selalu dipratinjau dulu dan HANYA disimpan setelah Anda menyetujuinya di Claude (kode konfirmasi sekali pakai); backup otomatis dibuat sebelum perubahan; semua aturan KOPKU (periode tutup buku, saldo, SHU) tetap berlaku; tidak ada data yang dihapus. Data per anggota ikut diizinkan.\n\nPeriksa setiap pratinjau dengan teliti — AI dapat keliru.',
      [{ text: 'Batal', style: 'cancel' }, { text: 'Izinkan mengubah data', style: 'destructive', onPress: terapkan }],
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
      x && x.dibatalkan
        ? null
        : x && x.dibuka
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
      judul: 'Aktifkan Asisten AI',
      sub: 'Tanya data koperasi dengan bahasa sehari-hari dari Claude Desktop di komputer ini atau dari ChatGPT (tab ChatGPT). Membaca data; mengubah data hanya bila diizinkan di bawah.',
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
      ? h(View, { style: s.infoBaris }, h(Ionicons, { name: 'person-circle-outline', size: 16, color: C.textMuted }), h(Text, { style: s.redup }, 'AI membaca atas nama ', h(Text, { style: s.tebal }, st.pengguna.nama || st.pengguna.username), ' (@' + st.pengguna.username + ') dan mengikuti izinnya di Permission Matrix.'))
      : null,
    h(View, { style: s.blok },
      h(Saklar, {
        judul: 'Izinkan data per anggota',
        sub: st.perAnggota
          ? 'AI dapat membaca nama & nomor anggota, saldo simpanan, pinjaman, jadwal angsuran, tunggakan, dan riwayat transaksi.'
          : 'MATI: AI hanya menerima angka total, laporan keuangan, dan kolektibilitas — tanpa nama anggota.',
        ikon: 'people-outline',
        nilai: !!st.perAnggota,
        onUbah: ubahPerAnggota,
        disabled: !bolehUbah || !pid,
        sibuk: sibuk === 'perAnggota',
        testID: 'saklar-asisten-per-anggota',
      })
    ),
    h(View, { style: s.blok },
      h(Saklar, {
        judul: 'Izinkan AI mengubah data',
        sub: st.bolehTulis
          ? 'ON: AI dapat mencatat transaksi, menambah/mengubah anggota, mengimpor Data Awal (Excel), dan mengoreksi transaksi (jurnal pembalik) — SELALU lewat pratinjau dan persetujuan Anda. ChatGPT butuh izin tambahan di tab ChatGPT. Backup otomatis sebelum perubahan.'
          : 'MATI: Claude hanya membaca. Nyalakan agar Claude dapat membantu input transaksi, import data, dan koreksi.',
        ikon: 'create-outline',
        nilai: !!st.bolehTulis,
        onUbah: ubahBolehTulis,
        disabled: !bolehUbah || !pid,
        sibuk: sibuk === 'bolehTulis',
        lencana: st.bolehTulis ? h(Lencana, { warna: 'kuning', teks: 'Ubah data aktif', ikon: 'warning-outline' }) : null,
        testID: 'saklar-asisten-ubah-data',
      })
    ),
    h(View, { style: [s.blok, s.privasi] },
      h(Ionicons, { name: 'shield-checkmark-outline', size: 18, color: C.primary }),
      h(Text, { style: [s.redup, { flex: 1 }] },
        'Tidak pernah dikirim: NIK, alamat, nomor HP, tempat/tanggal lahir, nomor rekening, password, maupun struktur internal aplikasi. Claude: koneksi hanya di komputer ini (127.0.0.1 + token acak). Data yang dibaca alat dikirim ke penyedia AI (Anthropic/OpenAI) sebagai bagian percakapan Anda. KOPKU Desktop harus tetap terbuka saat bertanya.')
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
      h(Langkah, { no: 2, judul: 'Nyalakan "Aktifkan Asisten AI" di atas', selesai: aktif && st.berjalan },
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
          h(Text, { style: s.redup }, 'Saat dibuat, Anda memilih folder penyimpanan berkas .mcpb. Folder terakhir: ', h(Text, { style: s.tebal, testID: 'folder-ekstensi' }, st.folderEkstensi || 'Dokumen › KOPKU Desktop')),
          h(View, { style: s.aksi },
            h(Tombol, { label: 'Buat & buka ekstensi', ikon: 'cube-outline', onPress: ekstensi, sibuk: sibuk === 'ekstensi', disabled: !bolehUbah || !pid, testID: 'tombol-ekstensi-claude' }),
            h(Tombol, { label: 'Buka folder ekstensi', ikon: 'folder-open-outline', onPress: () => jalankan('folderEkstensi', () => A.bukaFolderEkstensi(), null), sibuk: sibuk === 'folderEkstensi', testID: 'tombol-folder-ekstensi' })
          )
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
      h(Subjudul, { teks: `Alat baca (${st.jumlahAlat} dari ${(st.alat || []).length}) — tidak mengubah apa pun` }),
      h(View, { style: s.chipBaris },
        (st.alat || []).map((a) =>
          h(View, { key: a.nama, style: [s.chip, a.aktif ? s.chipAktif : null] },
            h(Ionicons, { name: a.aktif ? 'checkmark-circle' : 'lock-closed-outline', size: 14, color: a.aktif ? C.primary : C.textFaint }),
            h(Text, { style: [s.chipTeks, a.aktif && { color: C.primaryDark }] }, a.judul)
          )
        )
      ),
      !st.perAnggota ? h(Text, { style: s.catatan }, 'Alat bergembok memerlukan "Izinkan data per anggota". Alat juga hanya berjalan bila pengguna punya izin Lihat pada menu terkait.') : null
    ),
    h(View, { style: s.blok },
      h(Subjudul, { teks: `Alat ubah data (${(st.alatTulis || []).length}) — ${st.bolehTulis ? 'aktif, selalu pratinjau + persetujuan' : 'MATI'}` }),
      h(View, { style: s.chipBaris },
        (st.alatTulis || []).map((a) =>
          h(View, { key: a.nama, style: [s.chip, a.aktif ? s.chipUbah : null] },
            h(Ionicons, { name: a.aktif ? 'create-outline' : 'lock-closed-outline', size: 14, color: a.aktif ? C.warning : C.textFaint }),
            h(Text, { style: [s.chipTeks, a.aktif && { color: C.warning }] }, a.judul)
          )
        )
      ),
      st.bolehTulis
        ? h(Text, { style: s.catatan }, 'Contoh: "Catat setoran wajib Oktober Rp50.000 untuk A00012", "Import berkas C:\\Users\\...\\Downloads\\saldo-lama.xlsx sebagai saldo lama cut-off 1 Juli 2026", "Koreksi transaksi SP-WAJIB-2026-000123 karena nominal salah".')
        : null
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
              /^UBAH:/.test(x.ket || '')
                ? h(Lencana, { warna: 'kuning', teks: 'Diubah', ikon: 'create-outline' })
                : h(Lencana, { warna: x.status === 'BERHASIL' ? 'hijau' : 'merah', teks: x.status === 'BERHASIL' ? 'Berhasil' : 'Gagal' }),
              h(Text, { style: [s.td, { width: 190 }], numberOfLines: 1 }, x.alat === '(pengaturan)' ? 'Pengaturan diubah' : x.alat === '(backup otomatis)' ? 'Backup otomatis' : LABEL_ALAT[x.alat] || x.alat),
              h(Text, { style: s.logTeks, numberOfLines: 1 }, x.ket || x.ms || ''),
              h(Text, { style: s.logWaktu }, waktuLokal(x.waktu))
            )
          )
    )
  );

  // ---------------- kartu ChatGPT (1.0.31 — OpenAI Secure MCP Tunnel)
  const g = st.chatgpt || { prasyarat: [], apiKey: {}, tautan: {} };
  const aturGpt = (o, pesan) => jalankan('gpt', () => A.aturChatGPT(Object.assign({ penggunaId: pid }, o)), pesan);
  const buka = (nama) => jalankan('tautan', () => A.bukaTautanChatGPT(nama), null);
  const nilaiTunnel = tunnelInput === null ? g.tunnelId || '' : tunnelInput;
  const simpanKredensial = async () => {
    const x = await aturGpt({ aksi: 'simpan', tunnelId: nilaiTunnel, apiKey: kunciInput || undefined }, 'Tunnel ID & API key disimpan (API key terenkripsi di komputer ini). Lanjutkan ke langkah 2.');
    if (x) {
      setTunnelInput(null);
      setKunciInput('');
    }
  };
  const prasyaratOk = (g.prasyarat || []).every((x) => x.ok);
  const hubungkanGpt = () =>
    notify(
      'Hubungkan KOPKU ke ChatGPT?',
      'KOPKU menjalankan penghubung resmi OpenAI (Secure MCP Tunnel): koneksi KELUAR terenkripsi dari komputer ini ke OpenAI — tanpa URL publik dan tanpa membuka port.\n\nChatGPT akan dapat MEMBACA data koperasi atas nama ' +
        ((st.pengguna && (st.pengguna.nama || st.pengguna.username)) || 'pengguna ini') +
        ' sesuai izinnya; data pribadi (NIK, alamat, HP, rekening) tidak pernah dikirim. Mengubah data tetap MATI kecuali Anda izinkan terpisah. Data yang dibaca dikirim ke OpenAI sebagai bagian percakapan. KOPKU Desktop harus tetap terbuka.',
      [{ text: 'Batal', style: 'cancel' }, { text: 'Hubungkan', onPress: () => aturGpt({ aksi: 'hubungkan' }, null) }],
      'info'
    );
  const putuskanGpt = () => aturGpt({ aksi: 'putuskan' }, 'Koneksi ChatGPT diputus. ChatGPT tidak dapat lagi mengakses KOPKU.');
  const hapusGpt = () =>
    notify('Hapus Tunnel ID & API key?', 'Koneksi diputus dan kredensial OpenAI dihapus dari komputer ini. Anda juga dapat mencabut API key di OpenAI Platform.', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Hapus', style: 'destructive', onPress: () => aturGpt({ aksi: 'hapus' }, 'Kredensial ChatGPT dihapus.') },
    ], 'warning');
  const ubahGptTulis = (v) => {
    if (!v) return aturGpt({ aksi: 'izin', bolehTulis: false }, 'ChatGPT kembali hanya dapat membaca data.');
    notify('Izinkan ChatGPT MENGUBAH data?', 'ChatGPT akan dapat memakai alat ubah data yang sama dengan Claude: selalu pratinjau + kode konfirmasi sekali pakai, backup otomatis, batas 10 perubahan/menit, izin Permission Matrix tetap berlaku. Nyalakan hanya bila benar-benar perlu.', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Izinkan', style: 'destructive', onPress: () => aturGpt({ aksi: 'izin', bolehTulis: true }, 'ChatGPT kini dapat mengubah data (selalu lewat pratinjau + persetujuan Anda). Di ChatGPT, buka ulang konektor KOPKU bila daftar alat belum berubah.') },
    ], 'warning');
  };
  const lencanaGpt = {
    TERHUBUNG: h(Lencana, { warna: 'hijau', teks: 'Terhubung', ikon: 'checkmark-circle' }),
    MENYAMBUNG: h(Lencana, { warna: 'kuning', teks: 'Menyambungkan…', ikon: 'sync-outline' }),
    GAGAL: h(Lencana, { warna: 'merah', teks: 'Gagal', ikon: 'alert-circle' }),
    MATI: h(Lencana, { warna: 'abu', teks: 'Belum terhubung', ikon: 'power' }),
  }[g.keadaan || 'MATI'];
  const kartuChatGPT = h(
    Kartu,
    { testID: 'kartu-chatgpt' },
    h(View, { style: s.judulBaris },
      h(Ionicons, { name: 'chatbubbles-outline', size: 20, color: C.primary }),
      h(Text, { style: s.kartuJudul }, 'Hubungkan ke ChatGPT'),
      lencanaGpt
    ),
    h(Text, { style: [s.redup, { marginTop: 6 }], testID: 'status-chatgpt' }, g.pesan || ''),
    g.keadaan === 'GAGAL' ? h(View, { style: [s.galat, { marginTop: 8 }] }, h(Ionicons, { name: 'alert-circle', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, g.pesan)) : null,
    h(View, { style: [s.galat, { backgroundColor: '#EEF4FF', borderColor: '#C9DAF8', marginTop: 10 }] },
      h(Ionicons, { name: 'shield-checkmark-outline', size: 16, color: '#2F5DB3' }),
      h(Text, { style: [s.galatTeks, { color: '#244A8F' }] }, 'Memakai cara resmi OpenAI: Secure MCP Tunnel. Koneksi keluar terenkripsi dari komputer ini ke OpenAI — tanpa URL publik, port, domain, maupun Command Prompt. Butuh akun ChatGPT yang dapat menambah konektor (Developer mode; tergantung paket/workspace) dan akses OpenAI Platform › Tunnels.')
    ),
    h(View, { style: s.blok },
      h(Subjudul, { teks: 'Pemeriksaan otomatis' }),
      (g.prasyarat || []).map((x) =>
        h(View, { key: x.kode, style: s.infoBaris, testID: 'prasyarat-' + x.kode },
          h(Ionicons, { name: x.ok ? 'checkmark-circle' : 'ellipse-outline', size: 16, color: x.ok ? C.primary : C.textFaint }),
          h(Text, { style: [s.redup, x.ok && { color: C.text }] }, x.teks)
        )
      )
    ),
    h(View, { style: s.blok },
      h(Subjudul, { teks: 'Langkah' }),
      h(Langkah, { no: 1, judul: 'Siapkan di OpenAI (sekali saja)', selesai: !!(g.tunnelId && g.apiKey && g.apiKey.ada) },
        h(Text, { style: s.redup }, 'a) Halaman Tunnels › Create tunnel (pilih workspace ChatGPT Anda) › salin Tunnel ID.  b) Halaman API keys › Create › Restricted › Tunnels: Read + Use › salin key.'),
        h(View, { style: s.aksi },
          h(Tombol, { label: 'Buka halaman Tunnels', ikon: 'open-outline', kecil: true, onPress: () => buka('tunnels'), testID: 'tombol-buka-tunnels' }),
          h(Tombol, { label: 'Buka halaman API keys', ikon: 'open-outline', kecil: true, onPress: () => buka('apiKeys'), testID: 'tombol-buka-apikeys' })
        ),
        h(View, { style: [s.aksi, { marginTop: 8 }] },
          h(TextInput, { value: nilaiTunnel, onChangeText: setTunnelInput, placeholder: 'tunnel_…', placeholderTextColor: C.textFaint, autoCapitalize: 'none', autoCorrect: false, style: s.input, editable: bolehUbah, testID: 'input-tunnel-id' }),
          h(TextInput, { value: kunciInput, onChangeText: setKunciInput, placeholder: g.apiKey && g.apiKey.ada ? `API key tersimpan (…${g.apiKey.akhir}) — isi untuk mengganti` : 'sk-… (Runtime API key)', placeholderTextColor: C.textFaint, autoCapitalize: 'none', autoCorrect: false, secureTextEntry: true, style: s.input, editable: bolehUbah, testID: 'input-api-key' }),
          h(Tombol, { label: 'Simpan', ikon: 'save-outline', onPress: simpanKredensial, disabled: !bolehUbah || !pid || !nilaiTunnel, sibuk: sibuk === 'gpt', testID: 'tombol-simpan-kredensial' })
        )
      ),
      h(Langkah, { no: 2, judul: 'Hubungkan', selesai: g.keadaan === 'TERHUBUNG' },
        h(View, { style: s.aksi },
          !g.aktif
            ? h(Tombol, { label: 'Hubungkan ke ChatGPT', ikon: 'link-outline', utama: true, onPress: hubungkanGpt, disabled: !bolehUbah || !pid || !prasyaratOk, sibuk: sibuk === 'gpt', testID: 'tombol-hubungkan-chatgpt' })
            : h(Tombol, { label: 'Hubungkan ulang', ikon: 'refresh-outline', onPress: () => aturGpt({ aksi: 'hubungkan' }, null), disabled: !bolehUbah || !pid, sibuk: sibuk === 'gpt', testID: 'tombol-hubungkan-ulang' }),
          g.aktif ? h(Tombol, { label: 'Putuskan', ikon: 'close-circle-outline', bahaya: true, onPress: putuskanGpt, disabled: !bolehUbah || !pid, testID: 'tombol-putuskan-chatgpt' }) : null
        ),
        !prasyaratOk && !g.aktif ? h(Text, { style: s.catatan }, 'Tombol aktif setelah semua pemeriksaan di atas tercentang.') : null
      ),
      h(Langkah, { no: 3, judul: 'Tambahkan KOPKU di ChatGPT (sekali saja)', selesai: !!(g.pemakaian && g.pemakaian.total > 0) },
        h(Text, { style: s.redup }, `ChatGPT › Settings › Apps & Connectors › Create (aktifkan Developer mode bila diminta) › Connection: Tunnel › pilih tunnel ${g.tunnelId || 'Anda'} › nama "KOPKU" › Create. Lalu di percakapan baru pilih KOPKU dan bertanya, mis. "Ringkas kondisi koperasi hari ini".`),
        h(View, { style: s.aksi }, h(Tombol, { label: 'Buka pengaturan konektor ChatGPT', ikon: 'open-outline', utama: g.keadaan === 'TERHUBUNG', onPress: () => buka('konektor'), testID: 'tombol-buka-konektor' }))
      )
    ),
    h(View, { style: s.blok },
      h(Saklar, {
        judul: 'Izinkan ChatGPT mengubah data',
        sub: !st.bolehTulis ? 'MATI (hanya membaca). Butuh "Izinkan AI mengubah data" di atas.' : g.bolehTulis ? 'ON: ChatGPT dapat memakai alat ubah data (selalu pratinjau + persetujuan).' : 'MATI: ChatGPT hanya membaca (disarankan).',
        ikon: 'create-outline',
        nilai: !!(g.bolehTulis && st.bolehTulis),
        onUbah: ubahGptTulis,
        disabled: !bolehUbah || !pid || !st.bolehTulis,
        sibuk: sibuk === 'gpt',
        testID: 'saklar-chatgpt-ubah',
      })
    ),
    h(View, { style: [s.aksi, { marginTop: 10, alignItems: 'center' }] },
      h(Text, { style: [s.catatan, { flex: 1 }] }, `Permintaan dari ChatGPT: ${(g.pemakaian && g.pemakaian.total) || 0} · ditolak: ${(g.pemakaian && g.pemakaian.ditolak) || 0}`),
      g.tunnelId || (g.apiKey && g.apiKey.ada) ? h(Tombol, { label: 'Hapus kredensial', ikon: 'trash-outline', kecil: true, bahaya: true, onPress: hapusGpt, disabled: !bolehUbah || !pid, testID: 'tombol-hapus-chatgpt' }) : null
    )
  );

  const tabBar = h(View, { style: s.tabBar },
    [['claude', 'Claude', 'sparkles-outline'], ['chatgpt', 'ChatGPT', 'chatbubbles-outline']].map(([k, label, ikon]) =>
      h(Touchable, { key: k, accessibilityRole: 'tab', onPress: () => setTab(k), style: [s.tab, tab === k && s.tabAktif], testID: 'tab-' + k },
        h(Ionicons, { name: ikon, size: 16, color: tab === k ? C.primary : C.textMuted }),
        h(Text, { style: [s.tabTeks, tab === k && s.tabTeksAktif] }, label),
        k === 'chatgpt' && g.keadaan === 'TERHUBUNG' ? h(View, { style: s.tabTitik }) : null
      )
    )
  );

  const banner = h(Touchable, { accessibilityRole: 'button', onPress: () => setPanduan(true), style: s.banner, testID: 'tombol-panduan' },
    h(View, { style: s.bannerIkon }, h(Ionicons, { name: 'easel-outline', size: 22, color: C.white })),
    h(View, { style: { flex: 1, minWidth: 0 } }, h(Text, { style: s.bannerJudul }, `Baru di sini? Lihat panduan bergambar (${SLIDE.length} slide)`), h(Text, { style: s.redup }, 'Animasi langkah demi langkah: pasang Claude, menyalakan konektor, bertanya, mengubah data dengan aman, ekstensi .mcpb, dan ChatGPT.')),
    h(Ionicons, { name: 'play-circle', size: 30, color: C.primary })
  );
  return h(View, { style: { flex: 1 } }, h(
    ScrollView,
    { style: s.layar, contentContainerStyle: UI.screenContent, testID: 'layar-asisten-ai' },
    h(Text, { style: UI.screenIntro }, 'Hubungkan KOPKU dengan Claude (Anthropic) atau ChatGPT (OpenAI) lewat MCP agar Anda dapat bertanya tentang data koperasi — ringkasan, laporan keuangan, kolektibilitas, tunggakan, simpanan, pinjaman, SHU — langsung dari Claude Desktop atau ChatGPT, dan (bila diizinkan) membantu mencatat transaksi, mengimpor data, serta mengoreksi transaksi. Mati secara bawaan.'),
    !bolehUbah ? h(View, { style: [s.galat, { backgroundColor: C.warningBg, borderColor: C.warningBorder, marginBottom: 12 }] }, h(Ionicons, { name: 'lock-closed-outline', size: 16, color: C.warning }), h(Text, { style: [s.galatTeks, { color: C.warning }] }, 'Hanya pengguna dengan izin ubah Pengaturan (Admin) yang dapat menyalakan/mematikan Asisten AI.')) : null,
    st.ekstensiUsang
      ? h(View, { style: [s.galat, { backgroundColor: C.warningBg, borderColor: C.warningBorder, marginBottom: 12 }], testID: 'peringatan-ekstensi-usang' },
          h(Ionicons, { name: 'refresh-circle-outline', size: 18, color: C.warning }),
          h(Text, { style: [s.galatTeks, { color: C.warning, flex: 1 }] }, 'Ekstensi Claude (.mcpb) Anda dibuat oleh versi KOPKU lama dan dapat gagal menyala di Claude Desktop ("Request timed out"). Buat ulang lalu klik Install di Claude Desktop (ganti ekstensi lama).'),
          h(Tombol, { label: 'Buat ulang ekstensi', ikon: 'cube-outline', utama: true, kecil: true, onPress: ekstensi, sibuk: sibuk === 'ekstensi', disabled: !bolehUbah || !pid, testID: 'tombol-perbarui-ekstensi' }))
      : null,
    h(View, { style: s.kolom }, banner, kartuSaklar, tabBar, ...(tab === 'chatgpt' ? [kartuChatGPT] : [kartuPasang]), kartuContoh, kartuAktivitas)
  ), panduan ? h(PanduanSlide, { onTutup: tutupPanduan }) : null);
}

const s = StyleSheet.create({
  tabBar: { flexDirection: 'row', gap: 6, padding: 4, backgroundColor: '#EEF1F4', borderRadius: T.radius.md, alignSelf: 'flex-start' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: T.radius.md },
  tabAktif: Object.assign({ backgroundColor: C.surface }, T.elevation.card),
  tabTeks: { fontSize: 13.5, fontWeight: '600', color: C.textMuted },
  tabTeksAktif: { color: C.primary },
  tabTitik: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.success || '#16A34A' },
  input: { flex: 1, minWidth: 260, borderWidth: 1, borderColor: C.border, borderRadius: T.radius.md, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13.5, color: C.text, backgroundColor: C.surface, outlineStyle: 'none' },
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
  banner: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: T.radius.lg, borderWidth: 1, borderColor: '#9CCBB0', backgroundColor: C.primaryLight },
  bannerIkon: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  bannerJudul: { fontSize: 14.5, fontWeight: '800', color: C.primaryDark },
  chipUbah: { borderColor: C.warningBorder, backgroundColor: C.warningBg },
  chipTeks: { fontSize: 12, fontWeight: '600', color: C.textMuted },
  logBaris: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F0F2F5' },
  logTeks: { flex: 1, fontSize: 12.5, color: C.textMuted },
  logWaktu: { fontSize: 11.5, color: C.textFaint },
  td: { fontSize: 13, fontWeight: '600', color: C.text },
});
