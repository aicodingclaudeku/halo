import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import IndikatorMemuat from '@/components/IndikatorMemuat';
import { SafeAreaView } from 'react-native-safe-area-context';
import FirstRunSetup from '@/components/FirstRunSetup';
import { colors } from '@/theme/colors';
import LicenseActivationScreen from '@/screens/License/LicenseActivationScreen';
import { getLicenseStatus, verifyLicenseIfDue, type LicenseStatus } from '@/services/LicenseService';
import { isSetupComplete } from '@/services/SetupService';
import { useAppStore } from '@/store/useAppStore';

/**
 * LICENSE GATE (§10, §23)
 * =========================================================================
 *
 * Penghalang tunggal sebelum SELURUH aplikasi. Dipasang di
 * `app/_layout.tsx` MEMBUNGKUS `<Slot />`, bukan di `app/index.tsx`.
 *
 * Kenapa di layout dan bukan di halaman?
 * Expo Router membangun rute dari struktur berkas. Kalau gate dipasang
 * di `app/index.tsx`, maka setiap berkas rute BARU yang ditambahkan
 * kelak (`app/laporan.tsx`, `app/pengaturan.tsx`, …) otomatis lahir
 * TANPA gate, dan bisa dibuka lewat deep link. Kesalahan itu tidak akan
 * terlihat sampai ada yang mencobanya. Dengan gate di root layout,
 * `<Slot />` — yaitu SEMUA rute, yang sekarang maupun yang belum ada —
 * berada di belakangnya secara struktural.
 *
 * Urutan yang dijamin komponen ini (§15, §23):
 *
 *     APP START -> LICENSE GATE -> (SETUP/LOGIN/PIN) -> MAIN APP
 *
 * Anak-anaknya (`children`) TIDAK PERNAH di-render sebelum evaluasi
 * lisensi selesai dan hasilnya mengizinkan. Ini penting: kalau anak
 * di-render lebih dulu lalu "disembunyikan", `useEffect` di dalamnya
 * sudah terlanjur jalan — termasuk pembukaan database dan tugas
 * startup akuntansi.
 *
 * BATAS YANG JUJUR (§17): gate ini adalah kode JavaScript di dalam
 * bundle, dan siapa pun yang bisa mengubah bundle bisa mengubahnya.
 * Nilai sesungguhnya bukan pada gate ini sendirian, melainkan pada
 * server sebagai akar kepercayaan: token bertanda tangan Ed25519 tidak
 * bisa DIBUAT tanpa private key server, sehingga penyerang harus
 * mem-patch aplikasi, bukan sekadar mengarang lisensi. Lihat catatan
 * "ancaman yang tersisa" di dokumentasi.
 */

interface Props {
  readonly children: React.ReactNode;
}

/**
 * FIRST_RUN adalah satu-satunya fase yang me-render aplikasi TANPA lisensi
 * yang sah. Baca penjelasan lengkapnya di `evaluate()` sebelum mengubahnya.
 */
type GatePhase = 'EVALUATING' | 'ALLOWED' | 'FIRST_RUN' | 'BLOCKED';

export default function LicenseGate({ children }: Props) {
  const [phase, setPhase] = useState<GatePhase>('EVALUATING');
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  /**
   * Evaluasi ulang lengkap. Sengaja SELALU menghitung ulang dari
   * SecureStore + verifikasi tanda tangan, tidak pernah membaca hasil
   * yang di-cache di memori (§17): satu variabel cache adalah satu
   * tempat untuk membekukan jawaban "boleh".
   */
  /**
   * RC-S125 — nomor urut evaluasi. Evaluasi bisa berjalan tumpang-tindih
   * (mount + kembali dari background + verifikasi latar). Hanya hasil
   * evaluasi TERBARU yang boleh menetapkan fase; hasil yang lebih lama
   * dibuang supaya keputusan basi tidak menimpa keputusan baru.
   */
  const urutanEvaluasi = useRef(0);

  const evaluate: (allowNetwork: boolean) => Promise<void> = useCallback(async (allowNetwork: boolean) => {
    const giliran = ++urutanEvaluasi.current;
    let next = await getLicenseStatus();

    // Verifikasi server hanya bila memang jatuh tempo (§13). Kegagalan
    // jaringan di sini TIDAK mengubah keputusan — `getLicenseStatus()`
    // yang berikutnya tetap mengandalkan grace period yang tersimpan.
    //
    // RC-S125 — ANTI-LAG. Bila token lokal SUDAH sah (tanda tangan,
    // perangkat, masa berlaku, dan grace period semuanya lolos), layar
    // tidak lagi ditahan menunggu server (timeout bisa 15 detik).
    // Verifikasi tetap dijalankan, tetapi di latar; begitu selesai,
    // gate mengevaluasi ULANG dari nol. Jika server menyatakan lisensi
    // dicabut/kedaluwarsa, evaluasi ulang itu memblokir aplikasi seperti
    // biasa. Bila token lokal TIDAK sah, perilaku lama dipertahankan:
    // menunggu server sebelum memutuskan.
    if (allowNetwork && next.serverVerificationDue) {
      if (next.allowAppAccess) {
        void verifyLicenseIfDue()
          .catch(() => null)
          .then(() => evaluate(false));
      } else {
        await verifyLicenseIfDue();
        next = await getLicenseStatus();
      }
    }

    if (giliran !== urutanEvaluasi.current) return;

    setStatus(next);

    if (next.allowAppAccess) {
      setPhase('ALLOWED');
      return;
    }

    // ====================================================================
    // FIRST RUN — satu-satunya kelonggaran, dan alasannya harus dipahami
    // sebelum menyentuh baris mana pun di bawah ini.
    // ====================================================================
    //
    // MASALAHNYA. Pada pemasangan baru, belum ada lisensi. Gate lama
    // langsung memblokir dan menampilkan layar aktivasi, sehingga
    // pengguna diminta License Key SEBELUM sempat memberi tahu nama
    // koperasinya — padahal aktivasi ke server MEMBUTUHKAN nama itu.
    // Akibatnya nama koperasi harus ditanyakan dua kali, di dua layar
    // berbeda, dengan risiko keduanya tidak sama.
    //
    // KELONGGARANNYA. Ketika setup BELUM selesai, gate mengizinkan
    // anak-anaknya di-render. Anak yang muncul dalam keadaan itu HANYA
    // SetupWizard: `app/index.tsx` mengarahkan ke fase 'SETUP' selama
    // `isSetupComplete()` bernilai false, sebelum menyentuh Login,
    // Lock, maupun RootNavigator.
    //
    // KENAPA INI BUKAN BYPASS. SetupWizard TIDAK DAPAT diselesaikan
    // tanpa `activateLicense()` yang berhasil — ia memanggil
    // LicenseService yang sama, dengan verifikasi tanda tangan Ed25519
    // yang sama, dan menolak menulis database bila aktivasi gagal.
    // Jadi kelonggaran ini membuka SATU layar yang tugasnya justru
    // MEMINTA lisensi; ia tidak membuka jalan ke aplikasi.
    //
    // Perhatikan juga arah keputusannya: syaratnya adalah setup BELUM
    // selesai. Memalsukan syarat itu berarti membuat aplikasi mengira
    // dirinya belum di-setup — yang menghasilkan wizard kosong, bukan
    // akses ke data. Satu-satunya cara keluar dari wizard tetap
    // lisensi yang sah.
    //
    // Sumbernya adalah `isSetupComplete()` yang membaca kolom
    // `koperasi.setup_selesai` — state SetupService yang sudah ada,
    // bukan flag baru yang dibuat untuk keperluan gate ini. Kegagalan
    // membacanya diperlakukan sebagai "setup sudah selesai", sehingga
    // database yang rusak berujung BLOCKED, bukan terbuka.
    let setupDone = true;
    try {
      setupDone = await isSetupComplete();
    } catch {
      setupDone = true; // fail-closed
    }

    setPhase(setupDone ? 'BLOCKED' : 'FIRST_RUN');
  }, []);

  useEffect(() => {
    void evaluate(true);
  }, [evaluate]);

  /**
   * Keluar dari FIRST_RUN begitu setup selesai.
   *
   * Tanpa ini, gate akan bertahan di FIRST_RUN sampai aplikasi
   * di-background-kan — artinya sisa sesi berjalan tanpa penegakan
   * lisensi penuh. Sinyalnya hanya memicu EVALUASI ULANG; ia tidak
   * membawa keputusan apa pun, sehingga tidak dapat dipakai untuk
   * membuka aplikasi.
   */
  const licenseRecheckSignal = useAppStore((s) => s.licenseRecheckSignal);
  useEffect(() => {
    if (licenseRecheckSignal > 0) {
      void evaluate(true);
    }
  }, [licenseRecheckSignal, evaluate]);

  /**
   * Evaluasi ulang saat aplikasi kembali dari background.
   *
   * Bukan sekadar kerapian: tanpa ini, aplikasi yang dibiarkan terbuka
   * berminggu-minggu tidak akan pernah menyadari lisensinya dicabut
   * atau grace period-nya habis. Ini juga alasan pemeriksaan tidak
   * cukup dilakukan sekali saat mount.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void evaluate(true);
      }
    });
    return () => subscription.remove();
  }, [evaluate]);

  if (phase === 'EVALUATING' || status === null) {
    return (
      // Dirender DI LUAR navigator, jadi tidak ada header yang
      // menyediakan inset atas. Tanpa SafeAreaView, wadah ini
      // menggambar sampai ke balik jam Android pada mode edge-to-edge.
      // RC-S123 — indikator bermerek (lanjutan visual SplashIntro), UI saja.
      <SafeAreaView style={styles.center} edges={['top']}>
        <IndikatorMemuat label="Memeriksa lisensi" />
      </SafeAreaView>
    );
  }

  // PART E — ISOLASI RUTE SELAMA FIRST RUN.
  //
  // RC-S38A memakai `<Redirect>` berbasis pathname, dan itu TIDAK CUKUP:
  // pengalihan bekerja SETELAH rute tujuan sempat di-mount, sehingga
  // `useEffect` di dalamnya sudah terlanjur jalan. Ia juga bergantung
  // pada daftar rute yang benar — rute baru yang ditambahkan kelak tidak
  // ikut terlindungi secara otomatis.
  //
  // Sekarang FIRST_RUN TIDAK me-render `<Slot />` sama sekali. Yang
  // dirender adalah SetupWizard secara langsung, jadi tidak ada pohon
  // rute yang aktif selama pemasangan pertama. Deep link ke `/license`,
  // dashboard, atau rute apa pun sama-sama berujung di layar yang sama —
  // bukan karena dialihkan, melainkan karena rutenya tidak pernah
  // dirender.
  if (phase === 'FIRST_RUN') {
    return <FirstRunSetup onComplete={() => void evaluate(true)} />;
  }

  if (phase === 'BLOCKED') {
    return <LicenseActivationScreen status={status} onLicensed={() => void evaluate(true)} />;
  }

  // ALLOWED maupun FIRST_RUN sama-sama me-render anak. Keduanya sengaja
  // dibedakan sebagai FASE, bukan digabung menjadi satu boolean: enum
  // yang bermakna membuat jelas di mana aplikasi sedang berada, dan
  // membuat `phase === 'ALLOWED'` tetap dapat dibaca sebagai
  // "lisensi benar-benar sah" oleh siapa pun yang membaca kode ini.
  return <>{children}</>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
