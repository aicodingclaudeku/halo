import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppTextInput from '@/components/AppTextInput';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import { gantiPasswordSendiri } from '@/services/UserManagementService';
import { periksaPassword, kekuatanPassword, PANJANG_MIN_PASSWORD } from '@/security/kebijakanPassword';
import { useAppStore } from '@/store/useAppStore';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';

/**
 * RC-S133.5 — GANTI PASSWORD SENDIRI.
 *
 * `wajib`: dibuka oleh app/index.tsx sebelum aplikasi bisa dipakai, untuk
 * akun yang password-nya dibuat Admin (mis. akun anggota massal). Tidak
 * ada tombol kembali — hanya Simpan atau Keluar.
 */
export default function GantiPasswordScreen({
  userId,
  wajib,
  onSelesai,
  onKeluar,
}: {
  userId: string;
  wajib?: boolean;
  onSelesai: () => void;
  onKeluar?: () => void;
}) {
  const nama = useAppStore((s) => s.currentUser?.nama);
  const [lama, setLama] = useState('');
  const [baru, setBaru] = useState('');
  const [ulang, setUlang] = useState('');
  const [lihat, setLihat] = useState(false);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState<string | null>(null);

  const cek = periksaPassword({ password: baru, konfirmasi: ulang });
  const kekuatan = baru ? kekuatanPassword(baru) : null;
  const bisa = lama.length > 0 && baru.length > 0 && ulang.length > 0 && !sibuk;

  const simpan = async () => {
    setGalat(null);
    if (!cek.sah) {
      setGalat(cek.pesan ?? 'Password baru tidak memenuhi syarat.');
      return;
    }
    setSibuk(true);
    try {
      await gantiPasswordSendiri(userId, lama, baru);
      onSelesai();
    } catch (e) {
      setGalat(e instanceof Error ? e.message : 'Gagal mengganti password.');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={st.akar}>
    <ScrollView {...PROP_SCROLL_FORM} style={st.akar} contentContainerStyle={[st.isi, { paddingBottom: RUANG_BAWAH_FORM }]}>
      <View style={st.ikonBulat}>
        <Ionicons name="key-outline" size={30} color={colors.white} />
      </View>
      <Text style={st.judul}>{wajib ? 'Buat password baru' : 'Ganti password'}</Text>
      <Text style={st.sub}>
        {wajib
          ? `Halo${nama ? `, ${nama}` : ''}. Password Anda dibuat oleh Admin koperasi. Demi keamanan, ganti dengan password milik Anda sendiri sebelum melanjutkan.`
          : 'Masukkan password lama, lalu password baru dua kali.'}
      </Text>

      <View style={st.kartu} testID="ganti-password">
        <AppTextInput
          label={wajib ? 'Password dari Admin' : 'Password lama'}
          inputType="key"
          secureTextEntry={!lihat}
          autoCapitalize="none"
          autoCorrect={false}
          value={lama}
          onChangeText={setLama}
        />
        <AppTextInput
          label="Password baru"
          inputType="key"
          secureTextEntry={!lihat}
          autoCapitalize="none"
          autoCorrect={false}
          value={baru}
          onChangeText={setBaru}
          placeholder={`Minimal ${PANJANG_MIN_PASSWORD} karakter, huruf & angka`}
        />
        {kekuatan ? (
          <Text style={[st.kekuatan, kekuatan === 'KUAT' ? st.kuat : kekuatan === 'CUKUP' ? st.cukup : st.lemah]}>
            Kekuatan: {kekuatan === 'KUAT' ? 'kuat' : kekuatan === 'CUKUP' ? 'cukup' : 'lemah'}
          </Text>
        ) : null}
        <AppTextInput
          label="Ulangi password baru"
          inputType="key"
          secureTextEntry={!lihat}
          autoCapitalize="none"
          autoCorrect={false}
          value={ulang}
          onChangeText={setUlang}
          onSubmitEditing={() => bisa && void simpan()}
          returnKeyType="go"
        />
        <TouchableOpacity
          style={st.lihat}
          onPress={() => setLihat((b) => !b)}
          accessibilityRole="switch"
          accessibilityState={{ checked: lihat }}
          accessibilityLabel="Tampilkan password"
        >
          <Ionicons name={lihat ? 'eye-off-outline' : 'eye-outline'} size={iconSize.sm} color={colors.textMuted} />
          <Text style={st.lihatTeks}>{lihat ? 'Sembunyikan password' : 'Tampilkan password'}</Text>
        </TouchableOpacity>

        {galat ? (
          <View style={st.galat}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={st.galatTeks}>{galat}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[st.tombol, !bisa && st.tombolMati]}
          onPress={simpan}
          disabled={!bisa}
          accessibilityRole="button"
          accessibilityLabel="Simpan password baru"
          testID="simpan-password-baru"
        >
          {sibuk ? <ActivityIndicator color={colors.white} /> : <Text style={st.tombolTeks}>Simpan & lanjutkan</Text>}
        </TouchableOpacity>
      </View>

      {onKeluar ? (
        <TouchableOpacity style={st.keluar} onPress={onKeluar} accessibilityRole="button" accessibilityLabel="Keluar">
          <Ionicons name="log-out-outline" size={iconSize.sm} color={colors.textMuted} />
          <Text style={st.keluarTeks}>Keluar</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
    </AreaAmanKeyboard>
  );
}

const st = StyleSheet.create({
  akar: { flex: 1, backgroundColor: colors.background },
  // maxWidth: tetap rapi saat dibuka dari Portal Anggota di jendela desktop lebar.
  isi: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, width: '100%', maxWidth: 560, alignSelf: 'center' },
  ikonBulat: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  judul: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
  sub: { fontSize: typography.subtitle, color: colors.textMuted, textAlign: 'center', lineHeight: 19, marginTop: 6, marginBottom: spacing.xl },
  kartu: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  kekuatan: { fontSize: 12, fontWeight: '600', marginTop: -4, marginBottom: 8 },
  kuat: { color: colors.success },
  cukup: { color: colors.warning },
  lemah: { color: colors.danger },
  lihat: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 },
  lihatTeks: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  galat: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.md },
  galatTeks: { color: colors.danger, fontSize: 13, flex: 1 },
  tombol: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  tombolMati: { backgroundColor: colors.disabled },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 15 },
  keluar: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', padding: spacing.md, marginTop: spacing.md },
  keluarTeks: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
});
