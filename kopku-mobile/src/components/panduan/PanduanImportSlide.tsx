import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { PANDUAN_IMPORT, type PoinPanduan } from '@/import/PanduanImportData';
import type { JenisTemplateDataAwal } from '@/import/TemplateDataAwal';
import IlustrasiImportView from './IlustrasiImport';

/**
 * RC-S133.4.7 — PANDUAN PENGISIAN TEMPLATE IMPORT, BERBENTUK SLIDE BERANIMASI.
 *
 * - Satu slide = satu langkah/sheet: ilustrasi Excel beranimasi, penjelasan,
 *   daftar BENAR / SALAH / INFO, dan kotak tips.
 * - Navigasi: tombol Kembali/Lanjut, ketuk titik, geser kiri/kanan (HP), atau
 *   tombol panah & Esc (desktop).
 * - Perpindahan slide dianimasikan (geser + memudar) dan bilah kemajuan di
 *   atas bergerak mengikuti posisi.
 * - Lebar isi dibatasi supaya nyaman dibaca di layar laptop.
 *
 * Murni tampilan: isi slide berasal dari `PANDUAN_IMPORT` (modul murni yang
 * diuji), tidak ada data koperasi yang dibaca atau ditulis.
 */
export default function PanduanImportSlide({
  visible,
  jenis,
  onTutup,
  onUnduhTemplate,
}: {
  visible: boolean;
  jenis: JenisTemplateDataAwal;
  onTutup: () => void;
  /** Bila diisi, slide terakhir menampilkan tombol unduh template. */
  onUnduhTemplate?: () => void;
}) {
  const slides = PANDUAN_IMPORT[jenis];
  const { width: lebarLayar } = useWindowDimensions();
  const lebarIsi = Math.min(lebarLayar, 760);
  const [indeks, setIndeks] = useState(0);
  const arah = useRef(1);
  const masuk = useRef(new Animated.Value(1)).current;
  const maju = useRef(new Animated.Value(0)).current;
  const gulir = useRef<any>(null);
  const sentuhX = useRef<number | null>(null);
  const terakhir = indeks === slides.length - 1;
  const slide = slides[Math.min(indeks, slides.length - 1)];

  useEffect(() => {
    if (visible) {
      setIndeks(0);
      maju.setValue(0);
    }
  }, [visible, jenis, maju]);

  useLayoutEffect(() => {
    masuk.setValue(0);
    const a = Animated.parallel([
      Animated.timing(masuk, { toValue: 1, duration: 320, useNativeDriver: false }),
      Animated.timing(maju, { toValue: (indeks + 1) / slides.length, duration: 320, useNativeDriver: false }),
    ]);
    a.start();
    gulir.current?.scrollTo?.({ y: 0, animated: false });
    return () => a.stop();
  }, [indeks, masuk, maju, slides.length]);

  const keSlide = (i: number) => {
    const tujuan = Math.max(0, Math.min(slides.length - 1, i));
    if (tujuan === indeks) return;
    arah.current = tujuan > indeks ? 1 : -1;
    setIndeks(tujuan);
  };

  // Desktop: panah kiri/kanan & Esc.
  useEffect(() => {
    const doc = (globalThis as any).document;
    if (!visible || !doc || typeof doc.addEventListener !== 'function') return;
    const onKey = (e: { key: string }) => {
      if (e.key === 'ArrowRight') keSlide(indeks + 1);
      else if (e.key === 'ArrowLeft') keSlide(indeks - 1);
      else if (e.key === 'Escape') onTutup();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  });

  const geser = masuk.interpolate({ inputRange: [0, 1], outputRange: [36 * arah.current, 0] });

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onTutup} statusBarTranslucent>
      <SafeAreaView style={st.wadah} edges={['top', 'bottom']}>
        <View style={[st.kolom, { width: lebarIsi }]}>
          {/* ---- Kepala: judul panduan, nomor slide, tutup ---- */}
          <View style={st.atas}>
            <View style={st.atasKiri}>
              <View style={st.ikonPanduan}>
                <Ionicons name="school-outline" size={16} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.atasJudul} numberOfLines={1}>
                  {jenis === 'SALDO_LAMA' ? 'Panduan Template Saldo Lama' : 'Panduan Template Transaksi Baru'}
                </Text>
                <Text style={st.atasSub}>
                  Langkah {indeks + 1} dari {slides.length}
                </Text>
              </View>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Tutup panduan" onPress={onTutup} hitSlop={12} style={st.tutup}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View style={st.rel}>
            <Animated.View style={[st.relIsi, { width: maju.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
          </View>

          {/* ---- Isi slide ---- */}
          <View
            style={{ flex: 1 }}
            onTouchStart={(e) => {
              sentuhX.current = e.nativeEvent.pageX;
            }}
            onTouchEnd={(e) => {
              if (sentuhX.current === null) return;
              const dx = e.nativeEvent.pageX - sentuhX.current;
              sentuhX.current = null;
              if (dx < -60) keSlide(indeks + 1);
              else if (dx > 60) keSlide(indeks - 1);
            }}
          >
            <ScrollView ref={gulir} contentContainerStyle={st.gulirIsi} showsVerticalScrollIndicator={false}>
              <Animated.View style={{ opacity: masuk, transform: [{ translateX: geser }] }}>
                <View style={st.panggung}>
                  <IlustrasiImportView key={`${jenis}-${slide.kunci}`} ilustrasi={slide.ilustrasi} />
                </View>

                <Text style={st.label}>{slide.label.toUpperCase()}</Text>
                <Text style={st.judul}>{slide.judul}</Text>
                <Text style={st.isi}>{slide.isi}</Text>

                {slide.poin?.length ? (
                  <View style={st.poinDaftar}>
                    {slide.poin.map((p, i) => (
                      <Poin key={i} p={p} />
                    ))}
                  </View>
                ) : null}

                {slide.tips ? (
                  <View style={st.tips}>
                    <Ionicons name="bulb-outline" size={16} color={colors.warning} />
                    <Text style={st.tipsTeks}>{slide.tips}</Text>
                  </View>
                ) : null}

                {terakhir && onUnduhTemplate ? (
                  <TouchableOpacity accessibilityRole="button" style={st.unduh} onPress={onUnduhTemplate}>
                    <Ionicons name="download-outline" size={16} color={colors.primary} />
                    <Text style={st.unduhTeks}>
                      Unduh {jenis === 'SALDO_LAMA' ? 'Template Saldo Lama' : 'Template Transaksi Baru'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </Animated.View>
            </ScrollView>
          </View>

          {/* ---- Kaki: titik & tombol ---- */}
          <View style={st.bawah}>
            <View style={st.titikBaris}>
              {slides.map((x, i) => (
                <TouchableOpacity
                  key={x.kunci}
                  accessibilityRole="button"
                  accessibilityLabel={`Ke langkah ${i + 1}: ${x.judul}`}
                  onPress={() => keSlide(i)}
                  hitSlop={6}
                >
                  <View style={[st.titik, i === indeks && st.titikAktif, i < indeks && st.titikLewat]} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={st.tombolBaris}>
              <TouchableOpacity
                accessibilityRole="button"
                style={[st.tombolSekunder, indeks === 0 && st.tak]}
                disabled={indeks === 0}
                onPress={() => keSlide(indeks - 1)}
              >
                <Ionicons name="arrow-back" size={18} color={colors.text} />
                <Text style={st.tombolSekunderTeks}>Kembali</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={st.tombolUtama}
                onPress={() => (terakhir ? onTutup() : keSlide(indeks + 1))}
              >
                <Text style={st.tombolUtamaTeks}>{terakhir ? 'Selesai' : 'Lanjut'}</Text>
                <Ionicons name={terakhir ? 'checkmark' : 'arrow-forward'} size={18} color={colors.white} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Poin({ p }: { p: PoinPanduan }) {
  const gaya =
    p.nada === 'BENAR'
      ? { ikon: 'checkmark-circle' as const, warna: colors.success, bg: '#F2F8F2', label: 'Benar' }
      : p.nada === 'SALAH'
      ? { ikon: 'close-circle' as const, warna: colors.danger, bg: '#FDF1F1', label: 'Hindari' }
      : { ikon: 'information-circle' as const, warna: '#1E5AA8', bg: '#EEF4FC', label: 'Info' };
  return (
    <View style={[st.poin, { backgroundColor: gaya.bg }]} accessibilityLabel={`${gaya.label}: ${p.teks}`}>
      <Ionicons name={gaya.ikon} size={16} color={gaya.warna} style={{ marginTop: 1 }} />
      <Text style={st.poinTeks}>{p.teks}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  wadah: { flex: 1, backgroundColor: colors.background, alignItems: 'center' },
  kolom: { flex: 1, maxWidth: '100%' },
  atas: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  atasKiri: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ikonPanduan: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  atasJudul: { fontSize: 14, fontWeight: '800', color: colors.text },
  atasSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  tutup: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  rel: { height: 4, backgroundColor: colors.border, marginHorizontal: spacing.lg, borderRadius: 2, overflow: 'hidden' },
  relIsi: { height: 4, backgroundColor: colors.primary, borderRadius: 2 },
  gulirIsi: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  panggung: {
    minHeight: 200,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  label: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 1 },
  judul: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 4, lineHeight: 26 },
  isi: { fontSize: 14, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 21 },
  poinDaftar: { gap: 6, marginTop: spacing.md },
  poin: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8 },
  poinTeks: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 19 },
  tips: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.md,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    padding: 10,
  },
  tipsTeks: { flex: 1, fontSize: 12.5, color: colors.text, lineHeight: 18 },
  unduh: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 12,
  },
  unduhTeks: { fontSize: 14, fontWeight: '700', color: colors.primary },
  bawah: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, paddingTop: spacing.sm, gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  titikBaris: { flexDirection: 'row', justifyContent: 'center', gap: 6, flexWrap: 'wrap' },
  titik: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  titikAktif: { width: 22, backgroundColor: colors.primary },
  titikLewat: { backgroundColor: '#A5C9A7' },
  tombolBaris: { flexDirection: 'row', gap: spacing.sm },
  tombolSekunder: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  tombolSekunderTeks: { fontSize: 14, fontWeight: '700', color: colors.text },
  tak: { opacity: 0.35 },
  tombolUtama: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tombolUtamaTeks: { fontSize: 15, fontWeight: '700', color: colors.white },
});
