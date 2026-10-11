import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import { colors, splashTema } from '@/theme/colors';

const UKURAN_LOGO = 56;
const UKURAN_CINCIN = UKURAN_LOGO + 28;

/**
 * RC-S123 — INDIKATOR MEMUAT BERMEREK (presentasi murni).
 *
 * Pengganti `ActivityIndicator` polos di layar tunggu tingkat aplikasi
 * (inisialisasi app/index, pemeriksaan lisensi LicenseGate, persiapan
 * FirstRunSetup) — layar yang terlihat tepat setelah SplashIntro selesai,
 * sehingga bahasa visualnya disambung: logo yang sama, busur orbit
 * cyan/hijau yang sama, latar terang yang sama.
 *
 *  - busur berputar mengelilingi logo, logo "bernapas" pelan;
 *  - tiga titik di belakang label menyala bergantian;
 *  - "Kurangi gerakan" aktif: semua gerak berhenti, tampilan tetap utuh.
 *
 * Semua animasi native driver dan dihentikan saat komponen dilepas.
 * Tidak membaca data, tidak menentukan kapan tampil — itu tetap milik
 * layar pemanggil.
 */
export default function IndikatorMemuat({ label = 'Memuat' }: { label?: string }) {
  const putar = useRef(new Animated.Value(0)).current;
  const napas = useRef(new Animated.Value(0)).current;
  const titik = useRef(new Animated.Value(0)).current;
  const [kurangiGerak, setKurangiGerak] = useState(false);

  useEffect(() => {
    let aktif = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => aktif && setKurangiGerak(v))
      .catch(() => undefined);
    return () => {
      aktif = false;
    };
  }, []);

  useEffect(() => {
    if (kurangiGerak) return;
    const orbit = Animated.loop(
      Animated.timing(putar, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true })
    );
    const bernapas = Animated.loop(
      Animated.sequence([
        Animated.timing(napas, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(napas, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    const kedip = Animated.loop(
      Animated.timing(titik, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true })
    );
    orbit.start();
    bernapas.start();
    kedip.start();
    return () => {
      orbit.stop();
      bernapas.stop();
      kedip.stop();
    };
  }, [kurangiGerak, putar, napas, titik]);

  const p = splashTema.terang;
  const sudut = putar.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const sudutBalik = putar.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });
  const skalaLogo = napas.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  // Tiap titik menyala pada sepertiga putaran yang berbeda.
  const nyala = (mulai: number) =>
    kurangiGerak
      ? 1
      : titik.interpolate({
          inputRange: [0, mulai, mulai + 0.15, mulai + 0.33, 1],
          outputRange: [0.25, 0.25, 1, 0.25, 0.25],
          extrapolate: 'clamp',
        });

  return (
    <View style={styles.wadah} accessibilityRole="progressbar" accessibilityLabel={`${label}…`}>
      <View style={styles.wadahLogo}>
        <View style={[styles.cincin, { borderColor: p.ring }]} />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.busur,
            { borderTopColor: p.cyan, borderRightColor: p.cyan },
            kurangiGerak ? null : { transform: [{ rotate: sudut }] },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.busurDalam, { borderBottomColor: p.green }, kurangiGerak ? null : { transform: [{ rotate: sudutBalik }] }]}
        />
        <Animated.View style={[styles.bingkaiLogo, kurangiGerak ? null : { transform: [{ scale: skalaLogo }] }]}>
          <Image
            source={require('../../assets/img/logo-kopku.png')}
            style={styles.logo}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </Animated.View>
      </View>

      <View style={styles.barisLabel}>
        <Text style={styles.label}>{label}</Text>
        {[0, 0.33, 0.66].map((m) => (
          <Animated.View key={m} style={[styles.titik, { backgroundColor: p.cyan, opacity: nyala(m) }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wadah: { alignItems: 'center', justifyContent: 'center', gap: 18 },
  wadahLogo: { width: UKURAN_CINCIN, height: UKURAN_CINCIN, alignItems: 'center', justifyContent: 'center' },
  cincin: {
    position: 'absolute',
    width: UKURAN_CINCIN,
    height: UKURAN_CINCIN,
    borderRadius: UKURAN_CINCIN / 2,
    borderWidth: 1,
  },
  busur: {
    position: 'absolute',
    width: UKURAN_CINCIN,
    height: UKURAN_CINCIN,
    borderRadius: UKURAN_CINCIN / 2,
    borderWidth: 2.5,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
  },
  busurDalam: {
    position: 'absolute',
    width: UKURAN_CINCIN - 12,
    height: UKURAN_CINCIN - 12,
    borderRadius: (UKURAN_CINCIN - 12) / 2,
    borderWidth: 2,
    borderTopColor: 'transparent',
    borderRightColor: 'transparent',
    borderLeftColor: 'transparent',
  },
  bingkaiLogo: {
    width: UKURAN_LOGO,
    height: UKURAN_LOGO,
    borderRadius: UKURAN_LOGO * 0.225,
    overflow: 'hidden',
  },
  logo: { width: UKURAN_LOGO, height: UKURAN_LOGO },
  barisLabel: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginRight: 2, letterSpacing: 0.2 },
  titik: { width: 5, height: 5, borderRadius: 2.5 },
});
