import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { Ionicons } from '@expo/vector-icons';
import {
  getInfoLayarKunci,
  InvalidCredentialsError,
  logout,
  unlockWithBiometric,
  unlockWithPin,
} from '@/services/AuthService';
import PinInput from '@/components/PinInput';
import { useAppStore } from '@/store/useAppStore';
import { colors, elevation, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';

const PANJANG_PIN = 6;

/**
 * ============================================================
 * LAYAR KUNCI (RC-S130)
 * ============================================================
 *
 * 1. PAPAN KETIK TIDAK MUNCUL SENDIRI. Dulu PIN `autoFocus`, sehingga
 *    papan ketik angka terbuka tepat saat animasi pembuka (SplashIntro)
 *    masih berjalan dan menggeser tata letak di belakangnya. Sekarang
 *    papan ketik baru terbuka saat kotak PIN DIKETUK.
 *
 * 2. LANGSUNG MEMVERIFIKASI SAAT DIGIT KE-6. Tombol "Buka Kunci" tetap
 *    ada (aksesibilitas & mencoba ulang), tetapi tidak wajib ditekan.
 *
 * 3. CEPAT. Verifikasi memakai jalur cepat yang terikat kredensial
 *    (security/unlockCepat.ts); hanya pembukaan pertama setelah PIN
 *    diganti/aplikasi diperbarui yang memakai scrypt penuh, dan scrypt
 *    itu kini asinkron sehingga layar tetap hidup ("Memverifikasi PIN…").
 *
 * 4. UMPAN BALIK JELAS. PIN salah -> kotak bergetar & memerah, isian
 *    dikosongkan, papan ketik tetap terbuka untuk mencoba lagi.
 *
 * Tata letak tengah tetap di dalam ScrollView (RC-S120): bila papan
 * ketik terbuka, tombol di bawah PIN tetap dapat digulir ke atasnya.
 */
export default function LockScreen({
  onUnlock,
  onLoggedOut,
}: {
  onUnlock: () => void;
  onLoggedOut: () => void;
}) {
  const koperasi = useAppStore((s) => s.koperasi);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fokus, setFokus] = useState(false);
  const [nama, setNama] = useState<string | null>(null);
  const [biometrikTersedia, setBiometrikTersedia] = useState(false);
  const sedangVerifikasi = useRef(false);
  const goyang = useRef(new Animated.Value(0)).current;

  // Hanya MEMBACA (nama & ketersediaan biometrik) — tidak memunculkan
  // papan ketik maupun dialog biometrik, supaya animasi pembuka tidak terganggu.
  useEffect(() => {
    let batal = false;
    getInfoLayarKunci().then((info) => {
      if (batal) return;
      setNama(info.nama);
      setBiometrikTersedia(info.biometrikTersedia);
    });
    return () => {
      batal = true;
    };
  }, []);

  const getarkan = () => {
    goyang.setValue(0);
    Animated.sequence(
      [10, -10, 7, -7, 3, 0].map((x) => Animated.timing(goyang, { toValue: x, duration: 45, useNativeDriver: true }))
    ).start();
  };

  const submitPin = async (nilai: string) => {
    if (sedangVerifikasi.current || nilai.length !== PANJANG_PIN) return;
    sedangVerifikasi.current = true;
    setError(null);
    setLoading(true);
    try {
      await unlockWithPin(nilai);
      // Sukses: biarkan indikator tetap tampil sampai layar diganti, supaya
      // tombol tidak sempat "hidup" lagi sesaat sebelum aplikasi terbuka.
      onUnlock();
    } catch (e) {
      setPin('');
      setError(e instanceof InvalidCredentialsError ? 'PIN salah. Silakan coba lagi.' : e instanceof Error ? e.message : 'PIN salah.');
      setLoading(false);
      getarkan();
    } finally {
      sedangVerifikasi.current = false;
    }
  };

  const ubahPin = (v: string) => {
    // Selama verifikasi isian diabaikan (tanpa menonaktifkan input, supaya
    // papan ketik tidak menutup-buka bila PIN salah dan perlu diketik ulang).
    if (sedangVerifikasi.current) return;
    if (error && v.length > 0) setError(null);
    setPin(v);
    // Digit ke-6 langsung diverifikasi — tidak perlu menekan tombol.
    if (v.length === PANJANG_PIN) void submitPin(v);
  };

  const useBiometric = async () => {
    setError(null);
    setLoading(true);
    try {
      await unlockWithBiometric();
      onUnlock();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Biometric gagal.');
      setLoading(false);
    }
  };

  const doLogout = async () => {
    await logout();
    onLoggedOut();
  };

  const bisaSubmit = !loading && pin.length === PANJANG_PIN;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <AreaAmanKeyboard varian="layar" style={styles.flex}>
      <ScrollView {...PROP_SCROLL_FORM} contentContainerStyle={styles.isi}>
        <View style={styles.kartu}>
          <View style={styles.lockCircle}>
            <Ionicons name="lock-closed" size={28} color={colors.white} />
          </View>
          <Text style={styles.title}>{nama ? `Halo, ${nama}` : 'Aplikasi Terkunci'}</Text>
          <Text style={styles.subtitle}>Masukkan PIN 6 digit untuk membuka aplikasi</Text>

          <Animated.View style={{ transform: [{ translateX: goyang }] }}>
            <PinInput
              value={pin}
              onChangeText={ubahPin}
              error={error ?? undefined}
              onFokusBerubah={setFokus}
            />
          </Animated.View>

          {/* Satu baris status di bawah kotak — tingginya tetap supaya tata letak tidak meloncat. */}
          <View style={styles.statusBaris} accessibilityLiveRegion="polite">
            {loading ? (
              <>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.statusTeks}>Memverifikasi PIN…</Text>
              </>
            ) : error ? (
              <>
                <Ionicons name="alert-circle" size={iconSize.sm} color={colors.danger} />
                <Text style={[styles.statusTeks, styles.error]}>{error}</Text>
              </>
            ) : !fokus && pin.length === 0 ? (
              <>
                <Ionicons name="keypad-outline" size={iconSize.sm} color={colors.textMuted} />
                <Text style={styles.statusTeks}>Ketuk kotak PIN untuk mulai mengetik</Text>
              </>
            ) : null}
          </View>

          <TouchableOpacity
            style={[styles.button, !bisaSubmit && styles.buttonDisabled]}
            onPress={() => void submitPin(pin)}
            disabled={!bisaSubmit}
            accessibilityRole="button"
            accessibilityLabel="Buka kunci"
            accessibilityState={{ disabled: !bisaSubmit }}
          >
            {loading ? <ActivityIndicator color={colors.white} /> : <Text style={styles.buttonText}>Buka Kunci</Text>}
          </TouchableOpacity>

          {biometrikTersedia ? (
            <TouchableOpacity
              style={styles.buttonOutline}
              onPress={useBiometric}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Gunakan biometrik"
              accessibilityState={{ disabled: loading }}
            >
              <Ionicons name="finger-print" size={iconSize.md} color={colors.primary} />
              <Text style={styles.buttonOutlineText}>Gunakan Biometrik</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <TouchableOpacity
          onPress={doLogout}
          style={styles.logoutRow}
          accessibilityRole="button"
          accessibilityLabel="Keluar dari akun ini"
          disabled={loading}
        >
          <Ionicons name="log-out-outline" size={iconSize.sm} color={colors.textMuted} />
          <Text style={styles.logoutText}>Lupa PIN? Keluar, lalu masuk dengan password</Text>
        </TouchableOpacity>

        {koperasi?.nama ? (
          <View style={styles.kaki}>
            <Ionicons name="shield-checkmark-outline" size={iconSize.sm} color={colors.textFaint} />
            <Text style={styles.kakiTeks} numberOfLines={1}>
              {koperasi.nama}
            </Text>
          </View>
        ) : null}
      </ScrollView>
      </AreaAmanKeyboard>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  isi: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    ...elevation.card,
  },
  lockCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primary,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
    borderWidth: 5,
    borderColor: colors.primaryLight,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' },
  subtitle: {
    fontSize: typography.subtitle,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  statusBaris: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.sm,
  },
  statusTeks: { fontSize: 13, color: colors.textMuted, textAlign: 'center', flexShrink: 1 },
  error: { color: colors.danger, fontWeight: '600' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: { backgroundColor: colors.disabled },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  buttonOutline: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  buttonOutlineText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  logoutRow: {
    flexDirection: 'row',
    gap: spacing.xs + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget,
    marginTop: spacing.lg,
  },
  logoutText: { color: colors.textMuted, textAlign: 'center', fontSize: 13 },
  kaki: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.sm },
  kakiTeks: { fontSize: 11, color: colors.textFaint, flexShrink: 1 },
});
