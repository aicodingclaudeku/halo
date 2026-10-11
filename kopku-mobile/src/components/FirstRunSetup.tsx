import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import IndikatorMemuat from '@/components/IndikatorMemuat';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getDb } from '@/database/db';
import SetupWizardScreen from '@/screens/Setup/SetupWizardScreen';
import { colors } from '@/theme/colors';

/**
 * Layar pemasangan pertama, dirender LANGSUNG oleh LicenseGate.
 *
 * ---------------------------------------------------------------------
 * KENAPA KOMPONEN INI ADA
 * ---------------------------------------------------------------------
 * Selama FIRST_RUN, gate tidak boleh me-render `<Slot />`. Kalau ia
 * me-render pohon rute, deep link ke `/license` atau rute apa pun akan
 * mem-mount rute itu — dan `useEffect` di dalamnya sudah terlanjur jalan
 * sebelum pengalihan apa pun sempat bekerja.
 *
 * Dengan komponen ini, selama setup belum selesai TIDAK ADA rute yang
 * pernah dirender. Perlindungannya struktural, bukan bergantung pada
 * daftar rute yang harus diingat seseorang untuk diperbarui.
 *
 * ---------------------------------------------------------------------
 * KENAPA DATABASE DIBUKA DI SINI
 * ---------------------------------------------------------------------
 * `SetupWizardScreen` menulis ke SQLite lewat `setupKoperasi()`, jadi
 * database harus siap sebelum ia dirender. Biasanya `app/index.tsx` yang
 * melakukannya, tetapi jalur itu tidak dilewati selama FIRST_RUN.
 *
 * Ini TIDAK melanggar aturan "database tidak boleh jalan sebelum gate
 * mengizinkan": yang dilarang adalah membuka data bisnis tanpa lisensi.
 * Pada pemasangan pertama belum ada satu pun data bisnis — yang ada
 * hanyalah skema kosong yang memang harus dibuat agar setup dapat
 * berjalan. Tidak ada tugas startup akuntansi yang dijalankan di sini.
 */
interface Props {
  /** Dipanggil setelah setup selesai agar gate mengevaluasi ulang. */
  readonly onComplete: () => void;
}

export default function FirstRunSetup({ onComplete }: Props) {
  const [siap, setSiap] = useState(false);
  const [gagal, setGagal] = useState(false);

  useEffect(() => {
    let aktif = true;
    void (async () => {
      try {
        await getDb();
        if (aktif) setSiap(true);
      } catch {
        // Database tidak dapat disiapkan. Fail-closed: tetap di layar
        // pemuatan, jangan pernah melanjutkan ke aplikasi.
        if (aktif) setGagal(true);
      }
    })();
    return () => {
      aktif = false;
    };
  }, []);

  const handleComplete = useCallback(() => {
    onComplete();
  }, [onComplete]);

  if (!siap || gagal) {
    return (
      // Dirender DI LUAR navigator, jadi tidak ada header yang
      // menyediakan inset atas. Tanpa SafeAreaView, wadah ini
      // menggambar sampai ke balik jam Android pada mode edge-to-edge.
      // RC-S123 — indikator bermerek (lanjutan visual SplashIntro), UI saja.
      <SafeAreaView style={styles.center} edges={['top']}>
        <IndikatorMemuat label="Menyiapkan aplikasi" />
      </SafeAreaView>
    );
  }

  return <SetupWizardScreen onComplete={handleComplete} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
