import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { splashTema, type PaletSplash } from '@/theme/colors';
import { LINIMASA_SPLASH } from './splashLinimasa';

/**
 * LAYAR PEMBUKA "Kopku Finance by Alqizani" — 5 detik, mode terang & gelap.
 *
 * RC-S121 — teks atribusi "by Kopku" diganti "by Alqizani" (teks saja;
 * linimasa, animasi, logo, dan palet tidak berubah).
 *
 * DIPASANG SEBAGAI OVERLAY di app/_layout.tsx, DI ATAS aplikasi — bukan
 * sebagai gerbang. Aplikasi di bawahnya (LicenseGate, migrasi database,
 * setup/login) tetap mulai bekerja SEJAK DETIK PERTAMA, jadi 5 detik ini
 * tidak menambah waktu tunggu inisialisasi dan tidak mengubah urutan
 * License Gate -> Setup/Login -> PIN.
 *
 * Satu-satunya splash yang terlihat: native splash Android dibuat polos
 * (hanya warna latar yang SAMA dengan `palet.background`, lihat
 * plugins/withSplashNativePolos.js), lalu langsung layar ini.
 *
 * RC-S123 — SELALU TERANG. Dulu palet mengikuti mode perangkat
 * (useColorScheme), dan itulah sebab laporan "di Expo Go putih, setelah
 * build EAS hitam": app.json mengunci `userInterfaceStyle: "light"`, tetapi
 * di build Android kunci itu hanya berlaku bila paket `expo-system-ui`
 * terpasang — dan proyek ini tidak memasangnya. Expo Go menerapkan kunci
 * tersebut sendiri, sehingga di sana selalu terang; di APK, ponsel bermode
 * gelap membuat useColorScheme() = 'dark' -> splash navy gelap, padahal
 * seluruh isi aplikasi terang. Sekarang palet `splashTema.terang` dipakai
 * tanpa syarat, dan warna native splash mode gelap di app.json disamakan
 * dengan terang, jadi Expo Go dan APK tampil sama. Palet gelap tetap
 * tersimpan di theme/colors.ts bila kelak aplikasi punya mode gelap.
 *
 * RC-S123 — BILAH MEMUAT DIPERBARUI: trek lebih tebal, isi berkilau
 * (pita cahaya menyapu berulang), dan kepala bilah berdenyut. Semua
 * animasi tetap native driver dan berhenti bersama linimasa utama.
 *
 * Durasi dikendalikan SATU Animated.sequence (`utama`, total 5000 ms, lihat
 * splashLinimasa.ts); overlay dilepas di callback selesainya. Tidak ada
 * setTimeout. Dua animasi latar (`orbit` = busur berputar di sekitar logo,
 * `aura` = cahaya latar bergeser pelan) berhenti bersama `utama`.
 *
 * "Kurangi gerakan" (aksesibilitas) aktif: tanpa orbit, aura, kilau, skala,
 * dan geseran — hanya fade, durasi tetap sama.
 */
const LEBAR_PROGRES = 208;
const TINGGI_TREK = 6;
const LEBAR_KILAU_BILAH = 44;
const UKURAN_TITIK = 12;
const UKURAN_LOGO = 124;
const UKURAN_CINCIN = UKURAN_LOGO + 56;
const UKURAN_CINCIN_LUAR = UKURAN_LOGO + 96;

export default function SplashIntro() {
  const [tampil, setTampil] = useState(true);
  const p: PaletSplash = splashTema.terang;
  const s = useMemo(() => buatGaya(p), [p]);

  const logo = useRef(new Animated.Value(0)).current;
  const cincin = useRef(new Animated.Value(0)).current;
  const judul1 = useRef(new Animated.Value(0)).current;
  const judul2 = useRef(new Animated.Value(0)).current;
  const sub = useRef(new Animated.Value(0)).current;
  const kilau = useRef(new Animated.Value(0)).current;
  const progres = useRef(new Animated.Value(0)).current;
  const keluar = useRef(new Animated.Value(0)).current;
  const putar = useRef(new Animated.Value(0)).current;
  const geser = useRef(new Animated.Value(0)).current;
  const kilauBilah = useRef(new Animated.Value(0)).current;
  const denyut = useRef(new Animated.Value(0)).current;
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
    const L = LINIMASA_SPLASH;
    const halus = Easing.out(Easing.cubic);
    const t = (v: Animated.Value, ms: number, easing = halus) =>
      Animated.timing(v, { toValue: 1, duration: ms, easing, useNativeDriver: true });

    const orbit = Animated.loop(
      Animated.timing(putar, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true })
    );
    const aura = Animated.loop(
      Animated.sequence([
        Animated.timing(geser, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(geser, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    if (!kurangiGerak) {
      orbit.start();
      aura.start();
    }

    // RC-S123 — pita cahaya di dalam isi bilah & denyut kepala bilah.
    const sapuBilah = Animated.loop(
      Animated.sequence([
        Animated.timing(kilauBilah, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay(250),
      ])
    );
    const denyutKepala = Animated.loop(
      Animated.sequence([
        Animated.timing(denyut, { toValue: 1, duration: 650, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(denyut, { toValue: 0, duration: 650, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    );
    if (!kurangiGerak) {
      sapuBilah.start();
      denyutKepala.start();
    }

    const utama = Animated.sequence([
      Animated.parallel([
        t(logo, L.logoMs, Easing.out(Easing.back(1.3))),
        Animated.sequence([Animated.delay(L.cincinTundaMs), t(cincin, L.cincinMs)]),
        Animated.sequence([
          Animated.delay(L.judulTundaMs),
          Animated.stagger(L.judulJedaMs, [t(judul1, L.judulMs), t(judul2, L.judulMs)]),
        ]),
        Animated.sequence([Animated.delay(L.subTundaMs), t(sub, L.subMs)]),
        Animated.sequence([Animated.delay(L.kilauTundaMs), t(kilau, L.kilauMs, Easing.inOut(Easing.quad))]),
      ]),
      t(progres, L.progresMs, Easing.inOut(Easing.cubic)),
      t(keluar, L.keluarMs, Easing.in(Easing.quad)),
    ]);
    utama.start(({ finished }) => {
      orbit.stop();
      aura.stop();
      sapuBilah.stop();
      denyutKepala.stop();
      if (finished) setTampil(false);
    });
    return () => {
      utama.stop();
      orbit.stop();
      aura.stop();
      sapuBilah.stop();
      denyutKepala.stop();
    };
    // Sengaja hanya sekali saat mount: perubahan preferensi gerak di tengah
    // animasi tidak memulai ulang linimasa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tampil) return null;

  const gerak = !kurangiGerak;
  const klem = { extrapolate: 'clamp' as const };

  // ---- masuk & keluar
  const opasitasLayar = keluar.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const naikKeluar = gerak ? keluar.interpolate({ inputRange: [0, 1], outputRange: [0, -14] }) : 0;
  const opasitasLogo = logo.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1], ...klem });
  const skalaLogo = gerak
    ? Animated.multiply(
        logo.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
        keluar.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] })
      )
    : 1;
  const naikLogo = gerak ? logo.interpolate({ inputRange: [0, 1], outputRange: [14, 0], ...klem }) : 0;

  // ---- cincin orbit
  const skalaCincin = gerak ? cincin.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) : 1;
  const sudut = putar.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const sudutBalik = putar.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });

  // ---- kilau menyapu logo
  const geserKilau = kilau.interpolate({ inputRange: [0, 1], outputRange: [-UKURAN_LOGO, UKURAN_LOGO * 1.2] });
  const opasitasKilau = kilau.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 1, 1, 0] });

  // ---- teks
  const naik = (v: Animated.Value, jarak: number) => (gerak ? v.interpolate({ inputRange: [0, 1], outputRange: [jarak, 0] }) : 0);
  const skalaGaris = gerak ? sub : 1;

  // ---- progres
  const geserProgres = progres.interpolate({ inputRange: [0, 1], outputRange: [-LEBAR_PROGRES, 0] });
  const geserTitik = progres.interpolate({ inputRange: [0, 1], outputRange: [0, LEBAR_PROGRES] });
  const geserKilauBilah = kilauBilah.interpolate({ inputRange: [0, 1], outputRange: [-LEBAR_KILAU_BILAH, LEBAR_PROGRES] });
  const skalaHalo = gerak ? denyut.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) : 1;
  const opasitasHalo = gerak ? denyut.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }) : 0.3;

  // ---- aura latar
  const auraA = gerak ? geser.interpolate({ inputRange: [0, 1], outputRange: [0, 26] }) : 0;
  const auraB = gerak ? geser.interpolate({ inputRange: [0, 1], outputRange: [0, -22] }) : 0;

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, s.layar, { opacity: opasitasLayar }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Kopku Finance sedang dibuka"
    >
      <StatusBar style={p.statusBar} />

      {/* Cahaya latar lembut, bergeser pelan. */}
      <Animated.View pointerEvents="none" style={[s.aura, s.auraAtas, { transform: [{ translateX: auraA }, { translateY: auraB }] }]} />
      <Animated.View pointerEvents="none" style={[s.aura, s.auraBawah, { transform: [{ translateX: auraB }, { translateY: auraA }] }]} />

      <Animated.View style={[s.tengah, { transform: [{ translateY: naikKeluar }] }]}>
        <View style={s.wadahLogo}>
          {/* Dua cincin tipis + busur orbit berputar berlawanan arah. */}
          <Animated.View pointerEvents="none" style={[s.cincinLuar, { opacity: cincin, transform: [{ scale: skalaCincin }] }]} />
          <Animated.View pointerEvents="none" style={[s.cincin, { opacity: cincin, transform: [{ scale: skalaCincin }] }]} />
          {gerak ? (
            <>
              <Animated.View pointerEvents="none" style={[s.busur, { opacity: cincin, transform: [{ scale: skalaCincin }, { rotate: sudut }] }]} />
              <Animated.View
                pointerEvents="none"
                style={[s.busurLuar, { opacity: cincin, transform: [{ scale: skalaCincin }, { rotate: sudutBalik }] }]}
              />
            </>
          ) : null}

          <Animated.View style={[s.bayangLogo, { opacity: opasitasLogo, transform: [{ translateY: naikLogo }, { scale: skalaLogo }] }]}>
            <View style={s.bingkaiLogo}>
              <Image
                source={require('../../assets/img/logo-kopku.png')}
                style={s.logo}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
              />
              {gerak ? (
                <Animated.View
                  pointerEvents="none"
                  style={[s.kilau, { opacity: opasitasKilau, transform: [{ translateX: geserKilau }, { rotate: '18deg' }] }]}
                />
              ) : null}
            </View>
          </Animated.View>
        </View>

        <View style={s.barisJudul} accessibilityRole="header" accessible accessibilityLabel="Kopku Finance">
          <Animated.Text style={[s.judul, { opacity: judul1, transform: [{ translateY: naik(judul1, 16) }] }]}>Kopku</Animated.Text>
          <Animated.Text style={[s.judul, s.judulAksen, { opacity: judul2, transform: [{ translateY: naik(judul2, 16) }] }]}>
            Finance
          </Animated.Text>
        </View>

        <Animated.View style={{ opacity: sub, transform: [{ translateY: naik(sub, 10) }], alignItems: 'center' }}>
          <View style={s.baris}>
            <Animated.View style={[s.garis, { transform: [{ scaleX: skalaGaris }] }]} />
            <Text style={s.oleh}>by Alqizani</Text>
            <Animated.View style={[s.garis, { transform: [{ scaleX: skalaGaris }] }]} />
          </View>
          <Text style={s.tagline}>Keuangan koperasi yang tertib dan transparan</Text>
        </Animated.View>
      </Animated.View>

      <Animated.View style={[s.bawah, { opacity: sub }]}>
        <View style={s.wadahTrek}>
          <View style={s.trek}>
            <Animated.View style={[s.isiTrek, { transform: [{ translateX: geserProgres }] }]}>
              <View style={s.isiTrekUjung} />
              {gerak ? (
                <Animated.View pointerEvents="none" style={[s.kilauBilah, { transform: [{ translateX: geserKilauBilah }, { skewX: '-20deg' }] }]} />
              ) : null}
            </Animated.View>
          </View>
          <Animated.View style={[s.kepalaTrek, { transform: [{ translateX: geserTitik }] }]}>
            <Animated.View style={[s.haloTrek, { opacity: opasitasHalo, transform: [{ scale: skalaHalo }] }]} />
            <View style={s.titikTrek} />
          </Animated.View>
        </View>
        <Text style={s.label}>Aplikasi Akuntansi KSP/USP · SAK EP</Text>
        <Text style={s.hak}>© {new Date().getFullYear()} Kopku</Text>
      </Animated.View>
    </Animated.View>
  );
}

function buatGaya(p: PaletSplash) {
  return StyleSheet.create({
    layar: {
      backgroundColor: p.background,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      elevation: 1000,
      overflow: 'hidden',
    },
    aura: { position: 'absolute', width: 380, height: 380, borderRadius: 190, opacity: p.auraOpacity },
    auraAtas: { backgroundColor: p.auraA, top: '8%', right: -150 },
    auraBawah: { backgroundColor: p.auraB, bottom: '6%', left: -170 },
    tengah: { alignItems: 'center', paddingHorizontal: 32 },
    wadahLogo: {
      width: UKURAN_CINCIN_LUAR,
      height: UKURAN_CINCIN_LUAR,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 22,
    },
    cincin: {
      position: 'absolute',
      width: UKURAN_CINCIN,
      height: UKURAN_CINCIN,
      borderRadius: UKURAN_CINCIN / 2,
      borderWidth: 1,
      borderColor: p.ring,
    },
    cincinLuar: {
      position: 'absolute',
      width: UKURAN_CINCIN_LUAR,
      height: UKURAN_CINCIN_LUAR,
      borderRadius: UKURAN_CINCIN_LUAR / 2,
      borderWidth: 1,
      borderColor: p.ring,
      opacity: 0.6,
    },
    busur: {
      position: 'absolute',
      width: UKURAN_CINCIN,
      height: UKURAN_CINCIN,
      borderRadius: UKURAN_CINCIN / 2,
      borderWidth: 2,
      borderTopColor: p.cyan,
      borderRightColor: p.cyan,
      borderBottomColor: 'transparent',
      borderLeftColor: 'transparent',
    },
    busurLuar: {
      position: 'absolute',
      width: UKURAN_CINCIN_LUAR,
      height: UKURAN_CINCIN_LUAR,
      borderRadius: UKURAN_CINCIN_LUAR / 2,
      borderWidth: 1.5,
      borderTopColor: 'transparent',
      borderRightColor: 'transparent',
      borderBottomColor: p.green,
      borderLeftColor: 'transparent',
    },
    bayangLogo: {
      borderRadius: UKURAN_LOGO * 0.225,
      shadowColor: p.logoShadow,
      shadowOpacity: 0.3,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
      elevation: 14,
      backgroundColor: '#061429',
    },
    bingkaiLogo: { width: UKURAN_LOGO, height: UKURAN_LOGO, borderRadius: UKURAN_LOGO * 0.225, overflow: 'hidden' },
    logo: { width: UKURAN_LOGO, height: UKURAN_LOGO },
    kilau: {
      position: 'absolute',
      top: -UKURAN_LOGO * 0.25,
      left: 0,
      width: 26,
      height: UKURAN_LOGO * 1.5,
      backgroundColor: 'rgba(255,255,255,0.22)',
    },
    barisJudul: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    judul: { fontSize: 31, fontWeight: '800', color: p.title, letterSpacing: 0.2 },
    judulAksen: { color: p.accent, fontWeight: '700' },
    baris: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
    garis: { width: 26, height: 1, backgroundColor: p.subtitle, opacity: 0.45 },
    oleh: { fontSize: 12.5, color: p.subtitle, fontWeight: '700', letterSpacing: 1.6, textTransform: 'uppercase' },
    tagline: { fontSize: 13.5, color: p.subtitle, marginTop: 14, textAlign: 'center', lineHeight: 19 },
    bawah: { position: 'absolute', bottom: 52, alignItems: 'center' },
    wadahTrek: { width: LEBAR_PROGRES, height: UKURAN_TITIK * 2, justifyContent: 'center' },
    trek: { width: LEBAR_PROGRES, height: TINGGI_TREK, borderRadius: TINGGI_TREK / 2, backgroundColor: p.track, overflow: 'hidden' },
    isiTrek: {
      width: LEBAR_PROGRES,
      height: TINGGI_TREK,
      borderRadius: TINGGI_TREK / 2,
      backgroundColor: p.cyan,
      overflow: 'hidden',
    },
    // Ujung isi bernuansa hijau logo: kesan gradasi cyan -> hijau tanpa pustaka gradien.
    isiTrekUjung: {
      position: 'absolute',
      right: 0,
      top: 0,
      bottom: 0,
      width: LEBAR_PROGRES * 0.35,
      backgroundColor: p.green,
      opacity: 0.55,
    },
    kilauBilah: {
      position: 'absolute',
      top: -4,
      bottom: -4,
      width: LEBAR_KILAU_BILAH,
      backgroundColor: 'rgba(255,255,255,0.55)',
    },
    kepalaTrek: {
      position: 'absolute',
      left: -UKURAN_TITIK / 2,
      width: UKURAN_TITIK,
      height: UKURAN_TITIK,
      alignItems: 'center',
      justifyContent: 'center',
    },
    haloTrek: {
      position: 'absolute',
      width: UKURAN_TITIK,
      height: UKURAN_TITIK,
      borderRadius: UKURAN_TITIK / 2,
      backgroundColor: p.cyan,
    },
    titikTrek: {
      width: UKURAN_TITIK,
      height: UKURAN_TITIK,
      borderRadius: UKURAN_TITIK / 2,
      backgroundColor: p.background,
      borderWidth: 2.5,
      borderColor: p.cyan,
      shadowColor: p.cyan,
      shadowOpacity: 0.6,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 0 },
      elevation: 3,
    },
    label: { fontSize: 11, color: p.muted, marginTop: 16, letterSpacing: 0.4, fontWeight: '600' },
    hak: { fontSize: 10.5, color: p.muted, opacity: 0.8, marginTop: 4, letterSpacing: 0.4 },
  });
}
