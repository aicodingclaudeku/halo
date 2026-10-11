import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import type { SlidePanduan } from '@/config/panduanAplikasi';
import IlustrasiUi from './IlustrasiUi';

/**
 * PANDUAN SLIDE BERANIMASI (layar penuh).
 *
 * - Geser kiri/kanan atau tombol Lanjut/Kembali; "Lewati" kapan saja.
 * - Animasi native-driver dari posisi geser: ilustrasi membesar & memudar
 *   masuk, teks bergerak paralaks, titik indikator melebar.
 * - Murni tampilan: menutup panduan memanggil `onTutup`; penanda "sudah
 *   dilihat" diurus pemanggil (Dashboard) lewat PanduanService.
 */
export default function PanduanSlide({
  visible,
  slides,
  judulAkhir = 'Mulai Menggunakan',
  onTutup,
}: {
  visible: boolean;
  slides: readonly SlidePanduan[];
  judulAkhir?: string;
  onTutup: () => void;
}) {
  const { width } = useWindowDimensions();
  const scrollX = useRef(new Animated.Value(0)).current;
  // Salinan posisi geser untuk animasi berbasis JS (lebar titik indikator).
  // `width` tidak didukung native driver, jadi tidak boleh diinterpolasi dari
  // `scrollX` (yang terikat ke native driver).
  const scrollXJs = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<any>(null);
  const [indeks, setIndeks] = useState(0);
  const terakhir = indeks === slides.length - 1;

  // Selalu mulai dari slide pertama setiap kali dibuka.
  useEffect(() => {
    if (visible) {
      setIndeks(0);
      scrollX.setValue(0);
      scrollXJs.setValue(0);
      requestAnimationFrame(() => scrollRef.current?.scrollTo?.({ x: 0, animated: false }));
    }
  }, [visible, scrollX, scrollXJs]);

  const keSlide = (i: number) => {
    const tujuan = Math.max(0, Math.min(slides.length - 1, i));
    scrollRef.current?.scrollTo?.({ x: tujuan * width, animated: true });
    setIndeks(tujuan);
  };

  const onAkhirGeser = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndeks(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width)));
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onTutup} statusBarTranslucent>
      <SafeAreaView style={styles.wadah} edges={['top', 'bottom']}>
        <View style={styles.atas}>
          <Text style={styles.hitung}>
            {indeks + 1} / {slides.length}
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Lewati panduan" onPress={onTutup} hitSlop={12}>
            <Text style={styles.lewati}>{terakhir ? 'Tutup' : 'Lewati'}</Text>
          </TouchableOpacity>
        </View>

        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
            useNativeDriver: true,
            listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => scrollXJs.setValue(e.nativeEvent.contentOffset.x),
          })}
          onMomentumScrollEnd={onAkhirGeser}
        >
          {slides.map((s, i) => {
            const rentang = [(i - 1) * width, i * width, (i + 1) * width];
            const skala = scrollX.interpolate({ inputRange: rentang, outputRange: [0.82, 1, 0.82], extrapolate: 'clamp' });
            const pudar = scrollX.interpolate({ inputRange: rentang, outputRange: [0, 1, 0], extrapolate: 'clamp' });
            const naik = scrollX.interpolate({ inputRange: rentang, outputRange: [24, 0, 24], extrapolate: 'clamp' });
            const geserTeks = scrollX.interpolate({ inputRange: rentang, outputRange: [width * 0.25, 0, -width * 0.25], extrapolate: 'clamp' });
            return (
              <View key={s.kunci} style={[styles.slide, { width }]}>
                <Animated.View style={[styles.ilustrasi, { opacity: pudar, transform: [{ scale: skala }, { translateY: naik }] }]}>
                  <View style={styles.lingkaranLatar} />
                  <IlustrasiUi jenis={s.ilustrasi} />
                </Animated.View>
                <Animated.View style={[styles.teks, { opacity: pudar, transform: [{ translateX: geserTeks }] }]}>
                  <Text style={styles.label}>{s.label.toUpperCase()}</Text>
                  <Text style={styles.judul}>{s.judul}</Text>
                  <Text style={styles.isi}>{s.isi}</Text>
                  {s.poin?.map((p) => (
                    <View key={p} style={styles.poin}>
                      <Ionicons name="checkmark-circle" size={15} color={colors.primary} />
                      <Text style={styles.poinTeks}>{p}</Text>
                    </View>
                  ))}
                </Animated.View>
              </View>
            );
          })}
        </Animated.ScrollView>

        <View style={styles.bawah}>
          <View style={styles.titikBaris}>
            {slides.map((s, i) => {
              const rentang = [(i - 1) * width, i * width, (i + 1) * width];
              const lebar = scrollXJs.interpolate({ inputRange: rentang, outputRange: [8, 24, 8], extrapolate: 'clamp' });
              const pudar = scrollXJs.interpolate({ inputRange: rentang, outputRange: [0.3, 1, 0.3], extrapolate: 'clamp' });
              return <Animated.View key={s.kunci} style={[styles.titik, { width: lebar, opacity: pudar }]} />;
            })}
          </View>
          <View style={styles.tombolBaris}>
            <TouchableOpacity
              accessibilityRole="button"
              style={[styles.tombolSekunder, indeks === 0 && styles.tak]}
              disabled={indeks === 0}
              onPress={() => keSlide(indeks - 1)}
            >
              <Ionicons name="arrow-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.tombolUtama}
              onPress={() => (terakhir ? onTutup() : keSlide(indeks + 1))}
            >
              <Text style={styles.tombolUtamaTeks}>{terakhir ? judulAkhir : 'Lanjut'}</Text>
              <Ionicons name={terakhir ? 'checkmark' : 'arrow-forward'} size={18} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wadah: { flex: 1, backgroundColor: colors.background },
  atas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  hitung: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  lewati: { fontSize: 14, fontWeight: '700', color: colors.primary },
  slide: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.lg },
  ilustrasi: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 300 },
  lingkaranLatar: { position: 'absolute', width: 300, height: 300, borderRadius: 150, backgroundColor: colors.primaryLight },
  teks: { width: '100%', paddingBottom: spacing.md },
  label: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 1 },
  judul: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 4, lineHeight: 26 },
  isi: { fontSize: 14, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 21 },
  poin: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  poinTeks: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  bawah: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md },
  titikBaris: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  titik: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  tombolBaris: { flexDirection: 'row', gap: spacing.sm },
  tombolSekunder: { width: 52, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  tak: { opacity: 0.35 },
  tombolUtama: { flex: 1, flexDirection: 'row', gap: 8, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: 'center', justifyContent: 'center' },
  tombolUtamaTeks: { fontSize: 15, fontWeight: '700', color: colors.white },
});
