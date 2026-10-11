import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getUsernameTerakhir, login } from '@/services/AuthService';
import { useAppStore } from '@/store/useAppStore';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';

export default function LoginScreen({ onSuccess }: { onSuccess: (userId: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lihatPassword, setLihatPassword] = useState(false);
  const koperasi = useAppStore((s) => s.koperasi);

  // RC-S132 — isi username terakhir yang berhasil masuk (bukan password),
  // supaya berganti akun / masuk kembali cukup mengetik password.
  useEffect(() => {
    let batal = false;
    getUsernameTerakhir().then((u) => {
      if (!batal && u) setUsername((kini) => (kini ? kini : u));
    });
    return () => {
      batal = true;
    };
  }, []);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const user = await login(username.trim(), password);
      onSuccess(user.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login gagal.');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = username.trim().length > 0 && password.trim().length > 0 && !loading;

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <AreaAmanKeyboard varian="layar" style={styles.flex}>
      {/*
        UI/UX FINAL POLISH — konten dibungkus ScrollView supaya pada
        layar kecil dengan keyboard terbuka seluruh kartu (termasuk
        tombol Masuk) tetap dapat dijangkau, bukan terpotong di bawah
        keyboard. Susunan HEADER -> DESCRIPTION -> FORM -> PRIMARY
        ACTION tidak berubah, demikian pula `login()` dan `onSuccess`.
      */}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.inner}>
        <View style={styles.logoCircle}>
          <Ionicons name="business" size={32} color={colors.white} />
        </View>
        <Text style={styles.title}>Selamat Datang</Text>
        <Text style={styles.subtitle}>
          {koperasi?.nama ? `Masuk ke ${koperasi.nama}` : 'Masuk ke Kopku untuk melanjutkan'}
        </Text>

        <View style={styles.card}>
          <AppTextInput
            label="Username"
            inputType="person"
            placeholder="Masukkan username"
            autoCapitalize="none"
            value={username}
            onChangeText={setUsername}
          />

          {/* RC-S117 — PASSWORD, bukan PIN. PIN 6 digit tetap ada,
              tetapi hanya untuk membuka kunci aplikasi di perangkat
              yang sudah dipegang orangnya; untuk memisahkan seorang
              petugas dari wewenang Admin atas seluruh buku besar,
              ruang tebakan sejuta tidak memadai. */}
          <AppTextInput
            label="Password"
            placeholder="Masukkan password"
            secureTextEntry={!lihatPassword}
            autoCapitalize="none"
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => canSubmit && void submit()}
            returnKeyType="go"
            inputType="key"
          />
          <TouchableOpacity
            style={styles.lihatBaris}
            onPress={() => setLihatPassword((b) => !b)}
            accessibilityRole="switch"
            accessibilityState={{ checked: lihatPassword }}
            accessibilityLabel="Tampilkan password"
          >
            <Ionicons name={lihatPassword ? 'eye-off-outline' : 'eye-outline'} size={iconSize.sm} color={colors.textMuted} />
            <Text style={styles.lihatTeks}>{lihatPassword ? 'Sembunyikan password' : 'Tampilkan password'}</Text>
          </TouchableOpacity>

          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color={colors.danger} />
              <Text style={styles.error}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={submit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Masuk"
            accessibilityState={{ disabled: !canSubmit }}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Text style={styles.buttonText}>Masuk</Text>
                <Ionicons name="arrow-forward" size={iconSize.md} color={colors.white} />
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* RC-S132 — bantuan singkat; akun dibuat Admin di User Management. */}
        <View style={styles.bantuan}>
          <Ionicons name="information-circle-outline" size={iconSize.sm} color={colors.textMuted} />
          <Text style={styles.bantuanTeks}>
            Akun dibuat oleh Admin di Pengaturan › User Management. Lupa password? Minta Admin meresetnya. Untuk akun lama,
            password awal sama dengan PIN lama.
          </Text>
        </View>
        </View>
      </ScrollView>
    </AreaAmanKeyboard>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  inner: { width: '100%' },
  logoCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'center' },
  subtitle: {
    fontSize: typography.subtitle,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: { fontSize: typography.subtitle, fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  error: { color: colors.danger, fontSize: 13, flex: 1 },
  button: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  buttonDisabled: { backgroundColor: colors.disabled },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  lihatBaris: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 },
  lihatTeks: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  bantuan: { flexDirection: 'row', gap: 6, marginTop: spacing.lg, paddingHorizontal: spacing.xs },
  bantuanTeks: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
});
