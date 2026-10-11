/**
 * KOPKU Desktop — layar "Pengaturan › LAN & WhatsApp".
 *
 * Sumber modul yang DISUNTIKKAN ke bundle renderer oleh
 * `scripts/pasang-menu-lan-wa.js` (bundle hasil `expo export` tidak memiliki
 * source TS di paket desktop ini). Isi berkas ini adalah BADAN fungsi modul
 * Metro: parameter yang tersedia `r` (require), `_e` (exports), `d` (peta
 * dependensi). Urutan `d[...]` sesuai DEPENDENSI di skrip pemasang.
 *
 * Dua saklar berdiri sendiri:
 *   - Server LAN Multi-User  : PC/HP lain di Wi-Fi yang sama membuka KOPKU lewat browser.
 *   - WhatsApp Reminder      : pengingat angsuran otomatis (tidak butuh Server LAN).
 * Seluruh aksi lewat `window.kopkuDesktop.lanWa` (preload) → main process.
 */
'use strict';
function interop(x) {
  return x && x.__esModule ? x : { default: x };
}
Object.defineProperty(_e, '__esModule', { value: true });
Object.defineProperty(_e, 'default', { enumerable: true, get: function () { return LanWhatsAppScreen; } });

const React = r(d[0]);
const View = interop(r(d[1])).default;
const Text = interop(r(d[2])).default;
const Touchable = interop(r(d[3])).default;
const ScrollView = interop(r(d[4])).default;
const StyleSheet = interop(r(d[5])).default;
const Spinner = interop(r(d[6])).default;
const Switch = interop(r(d[7])).default;
const TextInput = interop(r(d[8])).default;
const Image = interop(r(d[9])).default;
const Ionicons = r(d[10]).Ionicons;
const usePermission = r(d[11]).usePermission;
const T = r(d[12]);
const UI = r(d[13]).ui;
const notify = r(d[14]).notify;

const C = T.colors;
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

function api() {
  const b = globalThis.kopkuDesktop;
  return b && b.lanWa ? b.lanWa : null;
}

const WARNA = {
  hijau: { teks: C.primaryDark, latar: C.primaryLight },
  abu: { teks: C.textMuted, latar: '#EEF0F3' },
  merah: { teks: C.danger, latar: C.dangerBg },
  kuning: { teks: C.warning, latar: C.warningBg },
};

function Lencana({ warna, teks, ikon }) {
  const w = WARNA[warna] || WARNA.abu;
  return h(
    View,
    { style: [s.lencana, { backgroundColor: w.latar }] },
    ikon ? h(Ionicons, { name: ikon, size: 13, color: w.teks }) : null,
    h(Text, { style: [s.lencanaTeks, { color: w.teks }] }, teks)
  );
}

function Tombol({ label, ikon, onPress, utama, bahaya, disabled, sibuk, testID }) {
  const warnaTeks = utama ? C.white : bahaya ? C.danger : C.text;
  return h(
    Touchable,
    {
      testID,
      accessibilityRole: 'button',
      disabled: !!(disabled || sibuk),
      onPress,
      style: [s.tombol, utama && s.tombolUtama, bahaya && s.tombolBahaya, (disabled || sibuk) && s.tombolMati],
    },
    sibuk ? h(Spinner, { size: 'small', color: warnaTeks }) : ikon ? h(Ionicons, { name: ikon, size: 16, color: warnaTeks }) : null,
    h(Text, { style: [s.tombolTeks, { color: warnaTeks }] }, label)
  );
}

function Field({ label, bantuan, children, lebar }) {
  return h(
    View,
    { style: [s.field, lebar ? { width: lebar } : { flex: 1, minWidth: 180 }] },
    h(Text, { style: s.fieldLabel }, label),
    children,
    bantuan ? h(Text, { style: s.bantuan }, bantuan) : null
  );
}

function Input(props) {
  return h(TextInput, Object.assign({ placeholderTextColor: C.placeholder, autoCapitalize: 'none', autoCorrect: false }, props, { style: [s.input, props.editable === false && s.inputMati, props.style] }));
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

function Kartu({ children, style }) {
  return h(View, { style: [s.kartu, style] }, children);
}

function Subjudul({ teks }) {
  return h(Text, { style: s.subjudul }, teks);
}

function Centang({ label, nilai, onUbah, disabled }) {
  return h(
    Touchable,
    { accessibilityRole: 'checkbox', accessibilityState: { checked: !!nilai, disabled: !!disabled }, disabled, onPress: () => onUbah(!nilai), style: [s.chip, nilai && s.chipAktif, disabled && s.tombolMati] },
    h(Ionicons, { name: nilai ? 'checkbox' : 'square-outline', size: 16, color: nilai ? C.primary : C.textMuted }),
    h(Text, { style: [s.chipTeks, nilai && { color: C.primaryDark }] }, label)
  );
}

function BarisInfo({ label, nilai, ok }) {
  return h(
    View,
    { style: s.barisInfo },
    h(Ionicons, { name: ok ? 'checkmark-circle' : 'alert-circle', size: 16, color: ok ? C.success : C.warning }),
    h(Text, { style: s.barisInfoLabel }, label),
    h(Text, { style: s.barisInfoNilai, numberOfLines: 1 }, nilai)
  );
}

const LABEL_SUMBER = { ENV: 'variabel lingkungan', FILE: 'berkas kopku-server.env', SECURE_STORE: 'tersimpan aman (DPAPI)', APLIKASI: 'diisi di aplikasi' };
const LABEL_STATUS = { pending: 'Menunggu', sending: 'Mengirim', sent: 'Terkirim', failed: 'Gagal', skipped: 'Dilewati' };
const WARNA_STATUS = { pending: 'kuning', sending: 'kuning', sent: 'hijau', failed: 'merah', skipped: 'abu' };

function LanWhatsAppScreen() {
  const { can } = usePermission();
  const bolehUbah = can('pengaturan', 'edit');
  const A = api();
  const [st, setSt] = useState(null);
  const [wa, setWa] = useState(null);
  const [log, setLog] = useState(null);
  const [sibuk, setSibuk] = useState('');
  const [qr, setQr] = useState({});
  const qrRef = useRef({});
  const [lanLanjut, setLanLanjut] = useState(false);
  // formulir jaringan
  const [host, setHost] = useState('0.0.0.0');
  const [port, setPort] = useState('47880');
  const [privat, setPrivat] = useState(true);
  const kotorLan = useRef(false);
  // formulir WhatsApp
  const [jam, setJam] = useState('08:00');
  const [jenis, setJenis] = useState({});
  const [nomorTest, setNomorTest] = useState('');
  const [kred, setKred] = useState({ WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '', WHATSAPP_TEMPLATE_NAME: '', WHATSAPP_TEMPLATE_LANG: '', WHATSAPP_API_VERSION: '' });
  const [token, setToken] = useState('');
  const kotorWa = useRef(false);
  const kotorKred = useRef(false);
  const hidup = useRef(true);

  const muat = useCallback(async () => {
    if (!A) return;
    try {
      const [a, b] = await Promise.all([A.status(), A.waInfo()]);
      if (!hidup.current) return;
      setSt(a);
      setWa(b);
      if (!kotorLan.current) {
        setHost(a.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0');
        setPort(String(a.port));
        setPrivat(!!a.hanyaJaringanPrivat);
      }
      if (!kotorWa.current) {
        setJam(b.pengaturan.jamKirim);
        setJenis(Object.assign({}, b.pengaturan.jenis));
        setNomorTest(b.pengaturan.nomorTest || '');
      }
      if (!kotorKred.current) {
        const n = b.nilaiAplikasi || {};
        setKred({
          WHATSAPP_PHONE_NUMBER_ID: n.WHATSAPP_PHONE_NUMBER_ID || '',
          WHATSAPP_BUSINESS_ACCOUNT_ID: n.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
          WHATSAPP_TEMPLATE_NAME: n.WHATSAPP_TEMPLATE_NAME || '',
          WHATSAPP_TEMPLATE_LANG: n.WHATSAPP_TEMPLATE_LANG || '',
          WHATSAPP_API_VERSION: n.WHATSAPP_API_VERSION || '',
        });
      }
      const l = await A.waLog({ limit: 8 });
      if (hidup.current) setLog(l);
      if (a.server === 'ONLINE') {
        for (const x of a.alamat) {
          if (qrRef.current[x.url]) continue;
          qrRef.current[x.url] = 'memuat';
          A.qr(x.url)
            .then((u) => {
              qrRef.current[x.url] = u;
              if (hidup.current) setQr(Object.assign({}, qrRef.current));
            })
            .catch(() => delete qrRef.current[x.url]);
        }
      }
    } catch (e) {
      /* abaikan; dicoba lagi pada siklus berikutnya */
    }
  }, [A]);

  useEffect(() => {
    hidup.current = true;
    muat();
    const t = setInterval(muat, 4000);
    return () => {
      hidup.current = false;
      clearInterval(t);
    };
  }, [muat]);

  const jalankan = async (kunci, fn, pesanBerhasil) => {
    setSibuk(kunci);
    try {
      const hasil = await fn();
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
      h(Kartu, null, h(Text, { style: s.teks }, 'Menu ini hanya tersedia di KOPKU Desktop (Windows/macOS).')));
  }

  const lanOn = !!(st && st.lanAktif);
  const waOn = !!(wa && wa.pengaturan && wa.pengaturan.aktif);
  const kr = wa ? wa.kredensial : null;

  // ---------------- aksi LAN
  const ubahLan = (v) => {
    const terapkan = () =>
      jalankan('lan', async () => {
        const hasil = await A.aturLan(v ? { mode: 'LAN_SERVER', host, port: Number(port), hanyaJaringanPrivat: privat } : { mode: 'DESKTOP' });
        kotorLan.current = false;
        if (v && hasil && hasil.galat) throw new Error(hasil.galat);
        return hasil;
      }, v ? 'Server LAN menyala. Perangkat lain di Wi-Fi yang sama dapat membuka alamat yang tampil.' : 'Server LAN dimatikan. Perangkat lain tidak dapat terhubung lagi.');
    if (!v) return terapkan();
    notify(
      'Nyalakan Server LAN?',
      'Komputer ini menjadi KOPKU Local Server. PC/laptop/HP di Wi-Fi atau LAN yang sama dapat masuk lewat browser memakai username & password KOPKU. Database tetap hanya di komputer ini, dan KOPKU Desktop harus tetap terbuka.',
      [{ text: 'Batal', style: 'cancel' }, { text: 'Nyalakan', style: 'default', onPress: terapkan }],
      'warning'
    );
  };
  const terapkanJaringan = () =>
    jalankan('jaringan', async () => {
      const hasil = await A.aturLan({ mode: lanOn ? 'LAN_SERVER' : 'DESKTOP', host, port: Number(port), hanyaJaringanPrivat: privat });
      kotorLan.current = false;
      if (lanOn && hasil && hasil.galat) throw new Error(hasil.galat);
      return hasil;
    }, 'Pengaturan jaringan disimpan.');

  // ---------------- aksi WhatsApp
  const ubahWa = (v) => {
    const terapkan = () =>
      jalankan('wa', async () => {
        const hasil = await A.aturWa(v);
        if (v && hasil && hasil.whatsapp && hasil.whatsapp.galat) throw new Error(hasil.whatsapp.galat);
        return hasil;
      }, v ? 'WhatsApp Reminder menyala.' : 'WhatsApp Reminder dimatikan. Tidak ada pesan yang akan dikirim.');
    if (!v) return terapkan();
    const kurang = kr && !kr.lengkap;
    notify(
      'Nyalakan WhatsApp Reminder?',
      (kurang
        ? 'Perhatian: kredensial WhatsApp Cloud API belum lengkap, sehingga pesan belum bisa terkirim sampai dilengkapi.\n\n'
        : '') +
        `Setiap hari pukul ${(wa && wa.pengaturan.jamKirim) || '08:00'} KOPKU mengirim pengingat angsuran ke nomor WhatsApp anggota sesuai jenis yang dicentang. Server LAN tidak perlu menyala, tetapi KOPKU Desktop harus terbuka dan terhubung ke internet.`,
      [{ text: 'Batal', style: 'cancel' }, { text: 'Nyalakan', style: 'default', onPress: terapkan }],
      'warning'
    );
  };
  const simpanWa = () =>
    jalankan('simpanWa', async () => {
      const r2 = await A.waSimpan({ jamKirim: jam.trim(), jenis, nomorTest: nomorTest.trim() });
      kotorWa.current = false;
      return r2;
    }, 'Pengaturan pengingat disimpan.');
  const simpanKred = () =>
    jalankan('simpanKred', async () => {
      const r2 = await A.waKredensial(kred);
      kotorKred.current = false;
      return r2;
    }, 'Kredensial WhatsApp disimpan.');
  const simpanToken = () =>
    jalankan('token', async () => {
      const r2 = await A.waToken(token.trim());
      setToken('');
      return r2;
    }, 'Access token disimpan terenkripsi di komputer ini.');
  const hapusToken = () =>
    notify('Hapus access token?', 'Token yang tersimpan di aplikasi dihapus. Pesan tidak dapat dikirim sampai token diisi lagi.', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Hapus', style: 'destructive', onPress: () => jalankan('hapusToken', () => A.waHapusToken(), 'Access token dihapus.') },
    ], 'warning');
  const testKoneksi = () =>
    jalankan('testKoneksi', async () => {
      const r2 = await A.waTestKoneksi();
      if (!r2 || !r2.ok) throw new Error((r2 && r2.pesan) || 'Koneksi ke WhatsApp Cloud API gagal.');
      return r2;
    }, (r2) => `Terhubung ke WhatsApp Cloud API${r2.nomorTampil ? ' — ' + r2.nomorTampil : ''}${r2.namaTerverifikasi ? ' (' + r2.namaTerverifikasi + ')' : ''}.${r2.templateTerkonfigurasi ? '' : ' Nama template belum diisi.'}`);
  const testPesan = () =>
    jalankan('testPesan', async () => {
      const r2 = await A.waTestPesan();
      if (!r2 || r2.status !== 'sent') throw new Error((r2 && r2.pesan) || 'Pesan uji tidak terkirim.');
      return r2;
    }, 'Pesan uji terkirim ke Nomor Test Administrator.');
  const jalankanSekarang = () =>
    jalankan('jalankan', () => A.waJalankan(), (r2) => {
      if (r2 && r2.dilewati) return 'Dilewati: ' + String(r2.pesan || r2.dilewati).replace(/_/g, ' ').toLowerCase();
      const k = (r2 && r2.kirim) || {};
      const b = (r2 && r2.dibuat) || {};
      if (k.dijeda) return 'Penjadwal sedang dijeda karena token/izin ditolak. Periksa kredensial lalu coba lagi.';
      return `Selesai. Pengingat baru: ${b.pending || 0} · terkirim: ${k.sent || 0} · gagal: ${k.failed || 0} · dilewati: ${(k.skipped || 0) + (b.skipped || 0)} · ditunda: ${k.ditunda || 0}.`;
    });

  // ---------------- tampilan
  const lencanaLan = !st
    ? h(Lencana, { warna: 'abu', teks: 'Memuat…' })
    : st.server === 'ONLINE'
      ? h(Lencana, { warna: 'hijau', teks: 'Online', ikon: 'radio-button-on' })
      : lanOn
        ? h(Lencana, { warna: 'merah', teks: 'Offline', ikon: 'alert-circle' })
        : h(Lencana, { warna: 'abu', teks: 'Mati' });
  const lencanaWa = !wa
    ? h(Lencana, { warna: 'abu', teks: 'Memuat…' })
    : wa.berjalan
      ? h(Lencana, { warna: kr && kr.lengkap ? 'hijau' : 'kuning', teks: kr && kr.lengkap ? 'Berjalan' : 'Berjalan · kredensial belum lengkap', ikon: kr && kr.lengkap ? 'radio-button-on' : 'alert-circle' })
      : waOn
        ? h(Lencana, { warna: 'merah', teks: 'Belum berjalan', ikon: 'alert-circle' })
        : h(Lencana, { warna: 'abu', teks: 'Mati' });

  const kartuLan = h(
    Kartu,
    null,
    h(Saklar, {
      testID: 'saklar-lan',
      judul: 'Server LAN Multi-User',
      sub: 'PC, laptop, atau HP lain di Wi-Fi/LAN yang sama membuka KOPKU lewat browser. Database tetap hanya di komputer ini.',
      ikon: 'wifi-outline',
      nilai: lanOn,
      onUbah: ubahLan,
      disabled: !bolehUbah || !st,
      sibuk: sibuk === 'lan',
      lencana: lencanaLan,
    }),
    st && st.galat ? h(View, { style: s.galat }, h(Ionicons, { name: 'warning-outline', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, st.galat)) : null,
    st && st.server === 'ONLINE'
      ? h(
          View,
          { style: s.blok },
          h(Subjudul, { teks: 'Alamat untuk perangkat lain' }),
          st.alamat.length === 0
            ? h(Text, { style: s.redup }, 'Tidak ada alamat Wi-Fi/LAN aktif (atau server hanya untuk komputer ini). Alamat lokal: ' + st.urlLokal)
            : st.alamat.map((x) =>
                h(
                  View,
                  { key: x.url, style: s.alamat },
                  qr[x.url] && qr[x.url] !== 'memuat' ? h(Image, { source: { uri: qr[x.url] }, style: s.qr, accessibilityLabel: 'QR ' + x.url }) : h(View, { style: [s.qr, s.qrKosong] }, h(Spinner, { size: 'small', color: C.primary })),
                  h(
                    View,
                    { style: { flex: 1, minWidth: 0 } },
                    h(Text, { style: s.url, selectable: true }, x.url),
                    h(Text, { style: s.redup }, x.antarmuka + (st.adapterSiap ? ' · layanan KOPKU siap' : ' · menunggu KOPKU siap')),
                    h(Text, { style: s.redup }, 'Buka alamat ini di browser perangkat lain, atau pindai QR dengan kamera HP.')
                  )
                )
              ),
          h(
            View,
            { style: s.aksi },
            h(Tombol, { label: 'Buka Panel Web (Admin)', ikon: 'open-outline', onPress: () => jalankan('admin', () => A.bukaAdmin()), sibuk: sibuk === 'admin' }),
            h(Tombol, { label: 'Izinkan di Windows Firewall…', ikon: 'shield-checkmark-outline', disabled: !bolehUbah, sibuk: sibuk === 'fw', onPress: () => jalankan('fw', async () => { const r2 = await A.firewall(); if (!r2.ok) throw new Error(r2.pesan || 'Gagal.'); return r2; }, (r2) => r2.pesan) })
          ),
          h(Text, { style: s.catatan }, 'Pengguna selain Admin harus diberi akses di Panel Web › Akses LAN Pengguna. Jangan meneruskan (port-forward) port ini ke internet.')
        )
      : null,
    h(
      Touchable,
      { onPress: () => setLanLanjut(!lanLanjut), style: s.lanjutToggle, accessibilityRole: 'button' },
      h(Ionicons, { name: lanLanjut ? 'chevron-down' : 'chevron-forward', size: 16, color: C.textMuted }),
      h(Text, { style: s.lanjutTeks }, 'Pengaturan jaringan (alamat bind & port)')
    ),
    lanLanjut
      ? h(
          View,
          { style: s.blok },
          h(
            View,
            { style: s.barisForm },
            h(
              Field,
              { label: 'Terima koneksi dari', lebar: 340 },
              h(
                View,
                { style: s.segmen },
                [['0.0.0.0', 'Semua jaringan LAN'], ['127.0.0.1', 'Hanya komputer ini']].map(([v, l]) =>
                  h(Touchable, { key: v, disabled: !bolehUbah, onPress: () => { kotorLan.current = true; setHost(v); }, style: [s.segmenItem, host === v && s.segmenAktif] }, h(Text, { style: [s.segmenTeks, host === v && s.segmenTeksAktif] }, l))
                )
              )
            ),
            h(Field, { label: 'Port', lebar: 140, bantuan: '1024–65535 (bawaan 47880)' }, h(Input, { value: port, editable: bolehUbah, keyboardType: 'number-pad', onChangeText: (t) => { kotorLan.current = true; setPort(t.replace(/[^0-9]/g, '').slice(0, 5)); } }))
          ),
          h(
            View,
            { style: s.barisSwitch },
            h(Switch, { value: privat, disabled: !bolehUbah, onValueChange: (v) => { kotorLan.current = true; setPrivat(v); }, trackColor: { false: '#CBD2DA', true: '#8CC5A4' }, thumbColor: privat ? C.primary : '#FFFFFF', activeThumbColor: C.primary }),
            h(Text, { style: s.teks }, 'Tolak koneksi dari alamat non-privat (internet) — disarankan tetap aktif')
          ),
          h(View, { style: s.aksi }, h(Tombol, { label: lanOn ? 'Terapkan & mulai ulang server' : 'Simpan', ikon: 'save-outline', utama: true, disabled: !bolehUbah, sibuk: sibuk === 'jaringan', onPress: terapkanJaringan }))
        )
      : null
  );

  const kartuWa = h(
    Kartu,
    null,
    h(Saklar, {
      testID: 'saklar-whatsapp',
      judul: 'WhatsApp Reminder',
      sub: 'Pengingat angsuran otomatis ke WhatsApp anggota (H-3, H-1, H, H+1, H+7) lewat WhatsApp Cloud API. Bisa menyala walaupun Server LAN mati.',
      ikon: 'logo-whatsapp',
      nilai: waOn,
      onUbah: ubahWa,
      disabled: !bolehUbah || !wa,
      sibuk: sibuk === 'wa',
      lencana: lencanaWa,
    }),
    wa && wa.galat ? h(View, { style: s.galat }, h(Ionicons, { name: 'warning-outline', size: 16, color: C.danger }), h(Text, { style: s.galatTeks }, wa.galat)) : null,
    wa && wa.scheduler && wa.scheduler.galatTerakhir ? h(Text, { style: s.redup }, 'Galat terakhir penjadwal: ' + wa.scheduler.galatTerakhir.pesan) : null,
    wa && wa.scheduler && wa.scheduler.dijedaSampai ? h(Text, { style: s.redup }, 'Penjadwal dijeda sampai ' + new Date(wa.scheduler.dijedaSampai).toLocaleTimeString('id-ID') + ' (periksa token/izin).') : null,

    // --- jadwal & jenis
    wa
      ? h(
          View,
          { style: s.blok },
          h(Subjudul, { teks: 'Jadwal pengingat' }),
          h(
            View,
            { style: s.barisForm },
            h(Field, { label: 'Jam kirim', lebar: 150, bantuan: 'HH:MM, jam komputer ini' }, h(Input, { value: jam, editable: bolehUbah, placeholder: '08:00', onChangeText: (t) => { kotorWa.current = true; setJam(t.replace(/[^0-9:]/g, '').slice(0, 5)); } })),
            h(Field, { label: 'Nomor Test Administrator', lebar: 240, bantuan: 'Pesan uji hanya dikirim ke nomor ini' }, h(Input, { value: nomorTest, editable: bolehUbah, placeholder: '081234567890', keyboardType: 'phone-pad', onChangeText: (t) => { kotorWa.current = true; setNomorTest(t); } }))
          ),
          h(Text, { style: s.fieldLabel }, 'Kirim pengingat pada'),
          h(
            View,
            { style: s.chipBaris },
            (wa.jenisDaftar || []).map((j) =>
              h(Centang, { key: j.kunci, label: `${j.label} · ${j.keterangan}`, nilai: !!jenis[j.kunci], disabled: !bolehUbah, onUbah: (v) => { kotorWa.current = true; setJenis(Object.assign({}, jenis, { [j.kunci]: v })); } })
            )
          ),
          h(View, { style: s.aksi }, h(Tombol, { label: 'Simpan jadwal', ikon: 'save-outline', utama: true, disabled: !bolehUbah, sibuk: sibuk === 'simpanWa', onPress: simpanWa }))
        )
      : h(Spinner, { color: C.primary, style: { marginVertical: 16 } }),

    // --- kredensial
    wa
      ? h(
          View,
          { style: s.blok },
          h(Subjudul, { teks: 'Koneksi WhatsApp Cloud API (Meta)' }),
          h(BarisInfo, { label: 'Phone Number ID', ok: kr.phoneNumberIdTersedia, nilai: kr.phoneNumberIdTersedia ? 'tersedia · ' + (LABEL_SUMBER[kr.sumber && kr.sumber.WHATSAPP_PHONE_NUMBER_ID] || '') : 'belum diisi' }),
          h(BarisInfo, { label: 'Access token', ok: kr.accessTokenTersedia, nilai: kr.accessTokenTersedia ? 'tersedia · ' + (LABEL_SUMBER[kr.sumberAccessToken] || kr.sumberAccessToken) : 'belum diisi' }),
          h(BarisInfo, { label: 'Template pesan', ok: !!kr.templateName, nilai: kr.templateName ? `${kr.templateName} (${kr.templateLang}) · API ${kr.apiVersion}` : 'belum diisi' }),
          h(
            View,
            { style: s.barisForm },
            h(Field, { label: 'Phone Number ID' }, h(Input, { value: kred.WHATSAPP_PHONE_NUMBER_ID, editable: bolehUbah, placeholder: 'contoh: 123456789012345', onChangeText: (t) => { kotorKred.current = true; setKred(Object.assign({}, kred, { WHATSAPP_PHONE_NUMBER_ID: t.trim() })); } })),
            h(Field, { label: 'WhatsApp Business Account ID (opsional)' }, h(Input, { value: kred.WHATSAPP_BUSINESS_ACCOUNT_ID, editable: bolehUbah, onChangeText: (t) => { kotorKred.current = true; setKred(Object.assign({}, kred, { WHATSAPP_BUSINESS_ACCOUNT_ID: t.trim() })); } }))
          ),
          h(
            View,
            { style: s.barisForm },
            h(Field, { label: 'Nama template (approved)', bantuan: 'Body wajib 6 parameter {{1}}–{{6}}' }, h(Input, { value: kred.WHATSAPP_TEMPLATE_NAME, editable: bolehUbah, placeholder: 'kopku_pengingat_angsuran', onChangeText: (t) => { kotorKred.current = true; setKred(Object.assign({}, kred, { WHATSAPP_TEMPLATE_NAME: t.trim() })); } })),
            h(Field, { label: 'Bahasa', lebar: 110 }, h(Input, { value: kred.WHATSAPP_TEMPLATE_LANG, editable: bolehUbah, placeholder: 'id', onChangeText: (t) => { kotorKred.current = true; setKred(Object.assign({}, kred, { WHATSAPP_TEMPLATE_LANG: t.trim() })); } })),
            h(Field, { label: 'Versi API', lebar: 110 }, h(Input, { value: kred.WHATSAPP_API_VERSION, editable: bolehUbah, placeholder: 'v21.0', onChangeText: (t) => { kotorKred.current = true; setKred(Object.assign({}, kred, { WHATSAPP_API_VERSION: t.trim() })); } }))
          ),
          h(View, { style: s.aksi }, h(Tombol, { label: 'Simpan kredensial', ikon: 'save-outline', disabled: !bolehUbah, sibuk: sibuk === 'simpanKred', onPress: simpanKred })),
          h(
            View,
            { style: s.barisForm },
            h(Field, { label: 'Access token (permanen / System User)', bantuan: 'Disimpan terenkripsi di komputer ini dan tidak pernah ditampilkan lagi.' }, h(Input, { value: token, editable: bolehUbah, secureTextEntry: true, placeholder: kr.accessTokenTersedia ? '•••••••• (tersimpan) — isi untuk mengganti' : 'tempel access token di sini', onChangeText: setToken }))
          ),
          h(
            View,
            { style: s.aksi },
            h(Tombol, { label: 'Simpan token', ikon: 'key-outline', disabled: !bolehUbah || token.trim().length < 20, sibuk: sibuk === 'token', onPress: simpanToken }),
            kr.sumberAccessToken === 'SECURE_STORE' ? h(Tombol, { label: 'Hapus token', ikon: 'trash-outline', bahaya: true, disabled: !bolehUbah, sibuk: sibuk === 'hapusToken', onPress: hapusToken }) : null
          ),
          h(Subjudul, { teks: 'Uji & jalankan' }),
          h(
            View,
            { style: s.aksi },
            h(Tombol, { label: 'Test koneksi', ikon: 'pulse-outline', disabled: !bolehUbah, sibuk: sibuk === 'testKoneksi', onPress: testKoneksi }),
            h(Tombol, { label: 'Kirim pesan uji', ikon: 'paper-plane-outline', disabled: !bolehUbah || !wa.pengaturan.nomorTest, sibuk: sibuk === 'testPesan', onPress: testPesan }),
            h(Tombol, { label: 'Jalankan sekarang', ikon: 'play-outline', disabled: !bolehUbah || !wa.berjalan, sibuk: sibuk === 'jalankan', onPress: jalankanSekarang })
          ),
          h(Text, { style: s.catatan }, 'Pesan uji dibatasi 1× per menit. "Jalankan sekarang" tidak menggandakan pesan yang sudah dibuat hari ini.')
        )
      : null,

    // --- log
    log
      ? h(
          View,
          { style: s.blok },
          h(Subjudul, { teks: 'Riwayat pengiriman' }),
          h(
            View,
            { style: s.chipBaris },
            Object.keys(LABEL_STATUS).map((k) => h(Lencana, { key: k, warna: WARNA_STATUS[k], teks: `${LABEL_STATUS[k]}: ${(log.ringkasan && log.ringkasan[k]) || 0}` }))
          ),
          log.baris.length === 0
            ? h(Text, { style: s.redup }, 'Belum ada pesan.')
            : log.baris.map((b) =>
                h(
                  View,
                  { key: b.id, style: s.logBaris },
                  h(Lencana, { warna: WARNA_STATUS[b.status], teks: LABEL_STATUS[b.status] || b.status }),
                  h(Text, { style: s.logTeks, numberOfLines: 1 }, `${b.labelJenis} · ${b.nama_anggota || '-'}${b.nomor_pinjaman ? ' · ' + b.nomor_pinjaman : ''}${b.angsuran_ke ? ' · angsuran ke-' + b.angsuran_ke : ''} · ${b.nomor_masked || ''}`),
                  h(Text, { style: s.logWaktu }, String(b.created_at || '').replace('T', ' ').slice(0, 16))
                )
              )
        )
      : null
  );

  return h(
    ScrollView,
    { style: s.layar, contentContainerStyle: UI.screenContent, testID: 'layar-lan-whatsapp' },
    h(Text, { style: UI.screenIntro }, 'Nyalakan atau matikan masing-masing fitur di bawah. Keduanya mati secara bawaan — KOPKU Desktop tetap berjalan seperti biasa.'),
    !bolehUbah ? h(View, { style: [s.galat, { backgroundColor: C.warningBg, borderColor: C.warningBorder }] }, h(Ionicons, { name: 'lock-closed-outline', size: 16, color: C.warning }), h(Text, { style: [s.galatTeks, { color: C.warning }] }, 'Hanya pengguna dengan izin ubah Pengaturan (Admin) yang dapat menyalakan/mematikan fitur ini.')) : null,
    h(View, { style: s.kolom }, kartuLan, kartuWa)
  );
}

const s = StyleSheet.create({
  layar: { flex: 1, backgroundColor: C.background },
  kolom: { gap: 14, maxWidth: 980 },
  kartu: Object.assign({ backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: T.radius.lg, padding: 18 }, T.elevation.card),
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
  subjudul: { fontSize: 11.5, fontWeight: '700', color: '#667085', letterSpacing: 0.8, textTransform: 'uppercase' },
  teks: { fontSize: 13, color: C.text, flexShrink: 1 },
  redup: { fontSize: 12, color: C.textMuted, lineHeight: 17 },
  catatan: { fontSize: 11.5, color: C.textMuted, lineHeight: 16, marginTop: 2 },
  galat: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.dangerBg, borderWidth: 1, borderColor: '#F3C7C5', borderRadius: T.radius.md, paddingHorizontal: 12, paddingVertical: 8, marginTop: 12 },
  galatTeks: { fontSize: 12.5, color: C.danger, flex: 1 },
  alamat: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 4 },
  qr: { width: 112, height: 112, borderRadius: T.radius.sm, borderWidth: 1, borderColor: C.border },
  qrKosong: { alignItems: 'center', justifyContent: 'center' },
  url: { fontSize: 17, fontWeight: '800', color: C.primaryDark, marginBottom: 2 },
  aksi: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  tombol: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: T.radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  tombolUtama: { backgroundColor: C.primary, borderColor: C.primary },
  tombolBahaya: { borderColor: C.danger },
  tombolMati: { opacity: 0.5 },
  tombolTeks: { fontSize: 13, fontWeight: '700' },
  lanjutToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, alignSelf: 'flex-start' },
  lanjutTeks: { fontSize: 12.5, fontWeight: '600', color: C.textMuted },
  barisForm: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  barisSwitch: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: C.text },
  bantuan: { fontSize: 11, color: C.textFaint },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: T.radius.md, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13.5, color: C.text, backgroundColor: C.surface, outlineStyle: 'none' },
  inputMati: { backgroundColor: C.background, color: C.textMuted },
  segmen: { flexDirection: 'row', borderWidth: 1, borderColor: C.border, borderRadius: T.radius.md, overflow: 'hidden' },
  segmenItem: { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: C.surface },
  segmenAktif: { backgroundColor: C.primaryLight },
  segmenTeks: { fontSize: 12.5, fontWeight: '600', color: C.textMuted },
  segmenTeksAktif: { color: C.primaryDark, fontWeight: '800' },
  chipBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: T.radius.pill, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  chipAktif: { borderColor: '#9CCBB0', backgroundColor: C.primaryLight },
  chipTeks: { fontSize: 12, fontWeight: '600', color: C.textMuted },
  barisInfo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barisInfoLabel: { fontSize: 12.5, fontWeight: '700', color: C.text, width: 130 },
  barisInfoNilai: { fontSize: 12.5, color: C.textMuted, flex: 1 },
  logBaris: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#F0F2F5' },
  logTeks: { flex: 1, fontSize: 12.5, color: C.text },
  logWaktu: { fontSize: 11.5, color: C.textFaint },
});
