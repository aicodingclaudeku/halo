import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';

/**
 * ANIMASI KIRIM / TRANSFER DATA (HP ⇄ KOPKU Desktop).
 *
 * Satu kartu rapi yang menyesuaikan lebar layar (HP sempit maupun desktop):
 *
 *   [ikon arah]  Judul ("Menerima data dari desktop")          [ 42% ]
 *                keterangan proses
 *   ( HP )  ── ▪ ── ▪ ── ▪ ──>  ( Laptop )      ← paket data mengalir
 *   HP ini                       Desktop
 *   Pengirim                     Penerima
 *   [██████████░░░░░░░░░░░░░░░░░░░░░]          ← progres
 *
 * - HP selalu di kiri, laptop di kanan; paket mengalir sesuai `aliran`.
 * - Lebar jalur diukur (onLayout), jadi tidak pernah meluber di HP kecil.
 * - Progres memakai `persen` bila diketahui, selain itu bergerak tak tentu.
 * - Selesai: centang (atau silang bila `gagal`) + bilah penuh, tahan 2 detik
 *   lalu memudar. Transfer yang sangat singkat tetap tampil minimal ±1,2 detik
 *   supaya tidak sekadar berkedip.
 *
 * Murni Animated bawaan React Native → berjalan di Android maupun desktop.
 */
export type Aliran = 'HP_KE_DESKTOP' | 'DESKTOP_KE_HP';

const JUMLAH_PAKET = 3;
const DURASI_PAKET = 1500;
const UKURAN_PAKET = 18;
const TAMPIL_MINIMUM = 1200;
const TAHAN_SELESAI = 2000;

export default function AnimasiTransfer({
  aktif,
  aliran,
  persen,
  label,
  gagal = false,
  namaHp = 'HP',
  namaDesktop = 'Desktop',
}: {
  aktif: boolean;
  aliran: Aliran | null;
  persen?: number | null;
  label?: string | null;
  /** Hasil terakhir gagal → tanda silang, bukan centang. */
  gagal?: boolean;
  namaHp?: string;
  namaDesktop?: string;
}) {
  const paket = useRef([...Array(JUMLAH_PAKET)].map(() => new Animated.Value(0))).current;
  const denyut = useRef(new Animated.Value(0)).current;
  const takTentu = useRef(new Animated.Value(0)).current;
  const lebarProgres = useRef(new Animated.Value(0)).current;
  const lencana = useRef(new Animated.Value(0)).current;
  const muncul = useRef(new Animated.Value(0)).current;

  // tampil = kartu dirender; berjalan = animasi transfer; selesai = keadaan akhir.
  const [tampil, setTampil] = useState(aktif);
  const [berjalan, setBerjalan] = useState(aktif);
  const [lebarJalur, setLebarJalur] = useState(0);
  const [lebarKartu, setLebarKartu] = useState(320);
  const mulai = useRef<number>(aktif ? Date.now() : 0);

  // Masuk / keluar.
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    if (aktif) {
      mulai.current = Date.now();
      setTampil(true);
      setBerjalan(true);
      lencana.setValue(0);
      Animated.timing(muncul, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    } else if (berjalan) {
      const sisa = Math.max(0, TAMPIL_MINIMUM - (Date.now() - mulai.current));
      t1 = setTimeout(() => {
        setBerjalan(false);
        Animated.spring(lencana, { toValue: 1, friction: 6, tension: 140, useNativeDriver: true }).start();
        t2 = setTimeout(() => {
          Animated.timing(muncul, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
            if (finished) setTampil(false);
          });
        }, TAHAN_SELESAI);
      }, sisa);
    }
    return () => {
      if (t1) clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktif]);

  // Animasi berulang selama transfer berjalan.
  useEffect(() => {
    if (!berjalan) return;
    const loops = paket.map((p, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((i * DURASI_PAKET) / JUMLAH_PAKET),
          Animated.timing(p, { toValue: 1, duration: DURASI_PAKET, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
          Animated.timing(p, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      )
    );
    const l2 = Animated.loop(
      Animated.sequence([
        Animated.timing(denyut, { toValue: 1, duration: 750, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(denyut, { toValue: 0, duration: 750, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ])
    );
    const l3 = Animated.loop(Animated.timing(takTentu, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loops.forEach((l) => l.start());
    l2.start();
    l3.start();
    return () => {
      loops.forEach((l) => l.stop());
      l2.stop();
      l3.stop();
      paket.forEach((p) => p.setValue(0));
      denyut.setValue(0);
      takTentu.setValue(0);
    };
  }, [berjalan, paket, denyut, takTentu]);

  useEffect(() => {
    if (persen == null) return;
    Animated.timing(lebarProgres, { toValue: Math.max(0, Math.min(1, persen)), duration: 300, useNativeDriver: false }).start();
  }, [persen, lebarProgres]);

  if (!tampil) return null;

  const keDesktop = aliran !== 'DESKTOP_KE_HP';
  const sempit = lebarKartu < 330;
  const UKURAN_IKON = sempit ? 48 : 56;
  const LEBAR_KOLOM = sempit ? 76 : 92;
  const warnaHasil = gagal ? colors.danger : colors.success;

  const judul = berjalan
    ? keDesktop
      ? 'Mengirim ke desktop'
      : 'Menerima dari desktop'
    : gagal
      ? 'Transfer gagal'
      : 'Transfer selesai';
  const keterangan = berjalan ? label ?? (keDesktop ? 'Data HP sedang dikirim lewat Wi-Fi lokal…' : 'Salinan data desktop sedang diterima…') : gagal ? 'Lihat pesan di bawah, lalu coba lagi.' : 'Data di kedua perangkat sudah sama.';
  const angkaPersen = persen != null ? Math.round(Math.max(0, Math.min(1, persen)) * 100) : null;

  const skalaDenyut = denyut.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const opasitasCincin = denyut.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0] });
  const skalaCincin = denyut.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] });
  const geser = muncul.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] });

  const perangkat = (hp: boolean) => {
    const mengirim = hp === keDesktop;
    const aktifKirim = berjalan && mengirim;
    return (
      <View style={[st.kolom, { width: LEBAR_KOLOM }]}>
        <View style={{ width: UKURAN_IKON, height: UKURAN_IKON, alignItems: 'center', justifyContent: 'center' }}>
          {aktifKirim && (
            <Animated.View
              style={[
                st.cincin,
                { width: UKURAN_IKON, height: UKURAN_IKON, borderRadius: UKURAN_IKON / 2, opacity: opasitasCincin, transform: [{ scale: skalaCincin }] },
              ]}
            />
          )}
          <Animated.View
            style={[
              st.ikon,
              { width: UKURAN_IKON, height: UKURAN_IKON, borderRadius: UKURAN_IKON / 2 },
              aktifKirim ? st.ikonPengirim : null,
              aktifKirim ? { transform: [{ scale: skalaDenyut }] } : null,
            ]}
          >
            <Ionicons name={hp ? 'phone-portrait-outline' : 'laptop-outline'} size={sempit ? 22 : 26} color={aktifKirim ? colors.white : colors.primary} />
          </Animated.View>
        </View>
        <Text style={st.nama} numberOfLines={1}>
          {hp ? namaHp : namaDesktop}
        </Text>
        <Text style={st.peran} numberOfLines={1}>
          {mengirim ? 'Pengirim' : 'Penerima'}
        </Text>
      </View>
    );
  };

  const jarak = Math.max(0, lebarJalur - UKURAN_PAKET);

  return (
    <Animated.View
      style={[st.kartu, { opacity: muncul, transform: [{ translateY: geser }] }]}
      onLayout={(e: LayoutChangeEvent) => setLebarKartu(e.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      accessibilityLabel={`${judul}${angkaPersen != null ? `, ${angkaPersen} persen` : ''}`}
    >
      {/* Kepala: arah + judul + persen */}
      <View style={st.kepala}>
        <View style={[st.ikonKepala, !berjalan && { backgroundColor: gagal ? colors.dangerBg : colors.primaryLight }]}>
          <Ionicons
            name={berjalan ? (keDesktop ? 'cloud-upload-outline' : 'cloud-download-outline') : gagal ? 'alert-circle-outline' : 'checkmark-done-outline'}
            size={18}
            color={berjalan ? colors.primary : warnaHasil}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={st.judul} numberOfLines={1}>
            {judul}
          </Text>
          <Text style={st.keterangan} numberOfLines={2}>
            {keterangan}
          </Text>
        </View>
      </View>

      {/* Panggung: HP — jalur — laptop */}
      <View style={st.panggung}>
        {perangkat(true)}
        <View style={[st.jalur, { height: UKURAN_IKON }]} onLayout={(e: LayoutChangeEvent) => setLebarJalur(e.nativeEvent.layout.width)}>
          <View style={st.garis}>
            {[...Array(Math.max(5, Math.min(48, Math.floor(lebarJalur / 14) || 9)))].map((_, i) => (
              <View key={i} style={st.titikGaris} />
            ))}
          </View>
          {berjalan &&
            lebarJalur > 0 &&
            paket.map((p, i) => {
              const x = p.interpolate({ inputRange: [0, 1], outputRange: keDesktop ? [0, jarak] : [jarak, 0] });
              const op = p.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 1, 1, 0] });
              return (
                <Animated.View
                  key={i}
                  style={[st.paket, { top: (UKURAN_IKON - UKURAN_PAKET) / 2, opacity: op, transform: [{ translateX: x }] }]}
                >
                  <Ionicons name={i % 2 ? 'document-text' : 'cube'} size={10} color={colors.white} />
                </Animated.View>
              );
            })}
          {!berjalan && (
            <Animated.View style={[st.lencana, { backgroundColor: warnaHasil, transform: [{ scale: lencana }] }]}>
              <Ionicons name={gagal ? 'close' : 'checkmark'} size={20} color={colors.white} />
            </Animated.View>
          )}
        </View>
        {perangkat(false)}
      </View>

      {/* Progres (+ persen di kanan bila diketahui) */}
      <View style={st.barisProgres}>
      <View style={[st.progresLatar, { flex: 1 }]}>
        {!berjalan ? (
          <View style={[st.progresIsi, { width: '100%', backgroundColor: warnaHasil }]} />
        ) : persen != null ? (
          <Animated.View style={[st.progresIsi, { width: lebarProgres.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        ) : (
          <Animated.View
            style={[
              st.progresTakTentu,
              { transform: [{ translateX: takTentu.interpolate({ inputRange: [0, 1], outputRange: [-lebarKartu * 0.35, lebarKartu] }) }] },
            ]}
          />
        )}
      </View>
      {berjalan && angkaPersen != null && <Text style={st.persenTeks}>{angkaPersen}%</Text>}
      </View>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 14,
    overflow: 'hidden',
  },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ikonKepala: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: 15, fontWeight: '800', color: colors.text },
  keterangan: { fontSize: 12.5, color: colors.textMuted, marginTop: 1, lineHeight: 17 },
  barisProgres: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  persenTeks: { minWidth: 38, textAlign: 'right', fontSize: 13, fontWeight: '800', color: colors.primary },

  panggung: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 16, marginBottom: 14 },
  kolom: { alignItems: 'center' },
  cincin: { position: 'absolute', backgroundColor: colors.primary },
  ikon: { backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D3E6D6' },
  ikonPengirim: { backgroundColor: colors.primary, borderColor: colors.primary },
  nama: { fontSize: 12.5, fontWeight: '700', color: colors.text, marginTop: 6, textAlign: 'center', alignSelf: 'stretch' },
  peran: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  jalur: { flex: 1, minWidth: 40, justifyContent: 'center', marginHorizontal: 4 },
  garis: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 2 },
  titikGaris: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#CFDDD1' },
  paket: {
    position: 'absolute',
    left: 0,
    width: UKURAN_PAKET,
    height: UKURAN_PAKET,
    borderRadius: 6,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lencana: { position: 'absolute', alignSelf: 'center', width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },

  progresLatar: { height: 6, borderRadius: 3, backgroundColor: '#EAF0EA', overflow: 'hidden' },
  progresIsi: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  progresTakTentu: { position: 'absolute', top: 0, left: 0, width: '35%', height: 6, borderRadius: 3, backgroundColor: colors.primary },
});
