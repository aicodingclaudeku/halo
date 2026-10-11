import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import AppNotificationHost from '@/components/AppNotificationHost';
import LicenseGate from '@/components/LicenseGate';
import SplashIntro from '@/components/SplashIntro';
// Sinkron HP⇄Desktop & host desktop. Di Android: AgenSinkron diam sampai HP
// dipasangkan; DesktopHost = null (versi .web.tsx hanya untuk desktop).
import AgenSinkron from '@/desktop/AgenSinkron';
import DesktopHost from '@/desktop/DesktopHost';
// Desktop: bingkai layar masuk/lisensi/setup. Di Android = tanpa bingkai (anak apa adanya).
import BingkaiAplikasi from '@/desktop/BingkaiAplikasi';

/**
 * Root layout Expo Router (migrasi Expo SDK 54 — Fase 11).
 *
 * KEPUTUSAN ARSITEKTUR: seluruh app ini SUDAH punya struktur navigasi
 * lengkap & teruji lewat React Navigation murni (`RootNavigator` — 5 tab,
 * masing-masing dengan native stack sendiri, 26 layar). Menulis ulang
 * setiap layar itu satu per satu ke berkas rute Expo Router (dengan
 * router.push()/useLocalSearchParams() dsb.) adalah migrasi besar yang
 * berisiko tinggi untuk dilakukan sekaligus tanpa perangkat/emulator
 * untuk uji coba manual.
 *
 * Jadi migrasi ini memakai pendekatan hybrid yang aman & umum dipakai:
 * Expo Router HANYA berperan sebagai entry point aplikasi (menggantikan
 * `App.tsx` + `node_modules/expo/AppEntry.js` lama), sedangkan navigasi
 * internal tetap 100% React Navigation seperti sebelumnya — tidak ada
 * satu pun dari 26 layar yang perlu diubah logikanya.
 *
 * Route tunggal `app/index.tsx` berisi alur SETUP → LOGIN → LOCK → READY
 * yang sebelumnya ada di `App.tsx`, lalu me-render `RootNavigator` (yang
 * NavigationContainer-nya diberi prop `independent` supaya aman
 * ditempatkan di dalam pohon navigasi Expo Router — lihat komentar di
 * `src/navigation/RootNavigator.tsx`).
 */
/**
 * LICENSE GATE — kenapa di SINI dan bukan di `app/index.tsx`.
 *
 * `<Slot />` adalah tempat SETIAP rute Expo Router di-render, yang
 * sekarang maupun yang ditambahkan kelak. Dengan membungkusnya,
 * pemeriksaan lisensi menjadi sifat STRUKTURAL dari aplikasi: tidak ada
 * rute yang bisa lahir di luar penghalang ini, termasuk lewat deep link
 * (`kopku://...`) dan termasuk `/license` itu sendiri.
 *
 * Kalau gate dipasang di dalam `app/index.tsx`, ia hanya menjaga SATU
 * rute — dan berkas rute berikutnya yang dibuat orang lain enam bulan
 * lagi akan terbuka lebar tanpa ada yang menyadarinya.
 *
 * Urutan keamanan yang dihasilkan (§15):
 *   License Gate -> validasi token lokal -> Setup/Login -> PIN/biometrik
 *   -> aplikasi utama.
 * PIN TIDAK diganti dan TIDAK dilewati: lisensi adalah hak memakai
 * aplikasi, PIN adalah identitas pengguna lokal. Keduanya berlapis.
 */
/*
 * UI/UX REDESIGN — StatusBar style="dark": app dikunci ke tema terang
 * (app.json userInterfaceStyle: light) dan header berlatar putih, jadi ikon
 * status bar harus gelap agar jam/sinyal/baterai tetap kontras. "auto" bisa
 * menghasilkan ikon putih di atas header putih bila sistem memakai mode gelap.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <BingkaiAplikasi>
        <LicenseGate>
          <Slot />
          <AgenSinkron />
        </LicenseGate>
      </BingkaiAplikasi>
      <DesktopHost />
      <AppNotificationHost />
      {/* RC-S85 — layar pembuka 5 detik. OVERLAY, bukan gerbang: LicenseGate
          & inisialisasi database di atas sudah berjalan di bawahnya, jadi
          urutan keamanan dan waktu siap aplikasi tidak berubah. Diletakkan
          paling akhir supaya tampil di atas semuanya, lalu melepas diri. */}
      <SplashIntro />
    </SafeAreaProvider>
  );
}
