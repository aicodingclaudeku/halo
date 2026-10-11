/**
 * NATIVE SPLASH ANDROID — POLOS (tanpa gambar/logo).
 * ============================================================
 * Tujuan: saat APK dibuka, native splash hanya berupa warna latar yang SAMA
 * dengan latar SplashIntro.tsx, lalu langsung tampil SplashIntro (satu-satunya
 * splash animasi). Tanpa plugin ini Android 12+ selalu menampilkan IKON
 * LAUNCHER di tengah layar sebagai splash sistem -> terlihat seperti "splash
 * kedua" sebelum SplashIntro.
 *
 * Proyek ini TIDAK memasang paket `expo-splash-screen`, sehingga Expo
 * prebuild memakai jalur bawaan (legacy) yang hanya mengatur warna latar dan
 * tidak bisa mengatur ikon splash Android 12+. Plugin lokal ini menambahkan
 * HANYA atribut tampilan berikut — tanpa kode native, tanpa dependensi baru:
 *
 *   Theme.App.SplashScreen (dipakai MainActivity saat cold start)
 *     android:windowSplashScreenBackground          -> @color/splashscreen_background
 *     android:windowSplashScreenAnimatedIcon        -> @drawable/splashscreen_polos (transparan)
 *     android:windowSplashScreenIconBackgroundColor -> @color/splashscreen_background
 *   values-night/colors.xml
 *     activityBackground (latar jendela sebelum JS tampil) versi gelap
 *
 * Warna terang/gelap diambil dari app.json (`android.splash.backgroundColor`
 * dan `android.splash.dark.backgroundColor`) supaya satu sumber dengan
 * konfigurasi splash bawaan Expo; nilainya harus sama dengan token latar
 * SplashIntro (src/theme/colors.ts -> splashTema).
 *
 * RC-S123 — nilai `dark.backgroundColor` di app.json kini SAMA dengan warna
 * terang. Kode plugin tidak berubah; yang berubah hanya nilainya, sehingga
 * native splash dan latar jendela pada ponsel bermode gelap ikut terang
 * (sebelumnya navy, sumber tampilan "hitam" di APK).
 */
const fs = require('fs');
const path = require('path');
const { withAndroidStyles, withAndroidColorsNight, withDangerousMod, AndroidConfig } = require('expo/config-plugins');

const NAMA_GAYA = 'Theme.App.SplashScreen';
const DRAWABLE_POLOS = 'splashscreen_polos';

const ITEM_SPLASH = [
  ['android:windowSplashScreenBackground', '@color/splashscreen_background'],
  ['android:windowSplashScreenAnimatedIcon', `@drawable/${DRAWABLE_POLOS}`],
  ['android:windowSplashScreenIconBackgroundColor', '@color/splashscreen_background'],
];

function warnaGelap(config) {
  return config.android?.splash?.dark?.backgroundColor ?? null;
}

/** 1) Ikon splash Android 12+ = drawable transparan (tidak ada logo/gambar). */
const withDrawablePolos = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const folder = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
      await fs.promises.mkdir(folder, { recursive: true });
      await fs.promises.writeFile(
        path.join(folder, `${DRAWABLE_POLOS}.xml`),
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<!-- Ikon splash kosong: native splash hanya warna latar (lihat plugins/withSplashNativePolos.js). -->',
          '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">',
          '  <solid android:color="@android:color/transparent" />',
          '  <size android:width="1dp" android:height="1dp" />',
          '</shape>',
          '',
        ].join('\n')
      );
      return cfg;
    },
  ]);

/** 2) Atribut splash Android 12+ pada Theme.App.SplashScreen. */
const withGayaSplashPolos = (config) =>
  withAndroidStyles(config, (cfg) => {
    const res = cfg.modResults.resources;
    res.$ = { ...(res.$ ?? {}), 'xmlns:tools': 'http://schemas.android.com/tools' };
    const gaya = (res.style ?? []).find((s) => s.$?.name === NAMA_GAYA);
    if (!gaya) return cfg;
    gaya.item = (gaya.item ?? []).filter((i) => !ITEM_SPLASH.some(([nama]) => nama === i.$?.name));
    for (const [nama, nilai] of ITEM_SPLASH) {
      // tools:targetApi -> atribut API 31 tidak memicu lint NewApi di minSdk lebih rendah.
      gaya.item.push({ $: { name: nama, 'tools:targetApi': '31' }, _: nilai });
    }
    return cfg;
  });

/** 3) Latar jendela (sebelum JS menggambar) versi mode gelap perangkat = `android.splash.dark.backgroundColor`. */
const withLatarJendelaGelap = (config) =>
  withAndroidColorsNight(config, (cfg) => {
    const gelap = warnaGelap(cfg);
    if (gelap) {
      cfg.modResults = AndroidConfig.Colors.assignColorValue(cfg.modResults, { name: 'activityBackground', value: gelap });
    }
    return cfg;
  });

module.exports = function withSplashNativePolos(config) {
  config = withDrawablePolos(config);
  config = withGayaSplashPolos(config);
  config = withLatarJendelaGelap(config);
  return config;
};
