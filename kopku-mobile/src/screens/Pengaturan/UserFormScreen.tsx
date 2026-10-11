import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  createUser,
  updateUser,
  resetUserPassword,
  listUsers,
  UserItem,
} from '@/services/UserManagementService';
import { ROLES, ROLE_LABEL, Role } from '@/config/defaultPermissions';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import {
  periksaPassword,
  kekuatanPassword,
  LABEL_KEKUATAN,
  PANJANG_MIN_PASSWORD,
} from '@/security/kebijakanPassword';
import { colors, radius, spacing, touchTarget, typography } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';
import FieldError from '@/components/FieldError';
import KartuLangkah from '@/components/form/KartuLangkah';
import KotakInfo from '@/components/form/KotakInfo';
import AnggotaPicker from '@/components/AnggotaPicker';
import { Anggota, getAnggotaById } from '@/repositories/AnggotaRepository';
import TombolUtama from '@/components/form/TombolUtama';
import { IKON_ROLE } from './ikonRole';

/** Dua huruf awal nama untuk avatar — hanya tampilan. */
function inisial(nama: string): string {
  const kata = nama.trim().split(/\s+/).filter(Boolean);
  if (kata.length === 0) return '?';
  const a = kata[0][0] ?? '';
  const b = kata.length > 1 ? kata[kata.length - 1][0] ?? '' : kata[0][1] ?? '';
  return (a + b).toUpperCase();
}

/**
 * RC-S117 — FORM USER: TAMBAH & SUNTING, MEMAKAI PASSWORD.
 *
 * ============================================================
 * DUA PERUBAHAN DARI VERSI SEBELUMNYA
 * ============================================================
 * 1. PASSWORD, BUKAN PIN. Dulu admin menetapkan PIN 6 digit sebagai
 *    kredensial masuk user baru. PIN kini HANYA membuka kunci aplikasi,
 *    dan ditetapkan sendiri oleh pemiliknya lewat Pengaturan >
 *    Keamanan — admin tidak menetapkan kunci layar orang lain.
 *
 * 2. BISA MENYUNTING. Sebelumnya hanya role yang bisa diubah, lewat
 *    dialog terpisah; salah ketik nama atau username berarti user harus
 *    dinonaktifkan dan dibuat ulang — yang memutus jejak audit atas
 *    namanya.
 *
 * Ganti password berdiri sebagai bagian TERSENDIRI di layar ini, dan
 * hanya dikirim bila benar-benar diisi: menyimpan suntingan nama tidak
 * boleh diam-diam mengganti password dan mengunci orangnya di luar.
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna): tiga langkah
 * bernomor (Identitas, Hak akses, Password), kartu profil saat
 * menyunting, dan role sebagai ubin berikon dengan penanda centang.
 * Validasi, kebijakan password, dan pemanggilan createUser/updateUser/
 * resetUserPassword TIDAK diubah.
 */
export default function UserFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const userId: string | undefined = route.params?.userId;
  const mode: 'TAMBAH' | 'SUNTING' = userId ? 'SUNTING' : 'TAMBAH';

  const [nama, setNama] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('PETUGAS');
  // RC-S132 — role ANGGOTA: identitas dipilih dari data anggota, bukan diketik.
  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [password, setPassword] = useState('');
  const [passwordKonfirmasi, setPasswordKonfirmasi] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [memuat, setMemuat] = useState(mode === 'SUNTING');

  useEffect(() => {
    if (mode !== 'SUNTING' || !currentUser || !userId) return;
    let dibatalkan = false;
    (async () => {
      try {
        const semua = await listUsers(currentUser.id);
        const target = semua.find((u: UserItem) => u.id === userId);
        if (dibatalkan) return;
        if (!target) {
          setError('User tidak ditemukan.');
          return;
        }
        setNama(target.nama);
        setUsername(target.username);
        setRole(target.role);
        if (target.anggotaId) {
          const a = await getAnggotaById(target.anggotaId);
          if (!dibatalkan) setAnggota(a);
        }
      } catch (e) {
        if (!dibatalkan) setError(e instanceof Error ? e.message : 'Gagal memuat data user.');
      } finally {
        if (!dibatalkan) setMemuat(false);
      }
    })();
    return () => {
      dibatalkan = true;
    };
  }, [mode, userId, currentUser]);

  // Password WAJIB saat membuat user baru, OPSIONAL saat menyunting —
  // dikosongkan berarti "jangan diubah".
  const gantiPassword = mode === 'TAMBAH' || password.length > 0 || passwordKonfirmasi.length > 0;
  const hasilPassword = gantiPassword
    ? periksaPassword({ password, konfirmasi: passwordKonfirmasi, username })
    : { sah: true, masalah: [], pesan: null };

  const peranAnggota = role === 'ANGGOTA';
  const namaTampil = peranAnggota ? anggota?.namaLengkap ?? '' : nama;

  /** Usulan username dari nomor anggota (mis. "A-0012" -> "a0012"), hanya bila kolom masih kosong. */
  const pilihAnggota = (a: Anggota | null) => {
    setAnggota(a);
    if (a && !username.trim()) setUsername(a.nomorAnggota.toLowerCase().replace(/[^a-z0-9._]/g, ''));
  };

  const submit = async () => {
    if (!currentUser) return;
    setError(null);

    if (peranAnggota && !anggota) {
      setError('Pilih anggota yang akan dibuatkan akun.');
      return;
    }
    if (!namaTampil.trim() || !username.trim()) {
      setError(peranAnggota ? 'Username wajib diisi.' : 'Nama dan username wajib diisi.');
      return;
    }
    if (gantiPassword && !hasilPassword.sah) {
      setError(hasilPassword.pesan);
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'TAMBAH') {
        await createUser(currentUser.id, { nama: namaTampil, username, role, password, anggotaId: peranAnggota ? anggota?.id : null });
        notify('User dibuat', `${namaTampil} dapat masuk dengan username dan password yang Anda tetapkan.`);
      } else if (userId) {
        await updateUser(currentUser.id, userId, { nama: namaTampil, username, role, anggotaId: peranAnggota ? anggota?.id : null });
        if (gantiPassword) {
          await resetUserPassword(currentUser.id, userId, password);
          notify('Tersimpan', `Data ${namaTampil} diperbarui dan passwordnya diganti.`);
        } else {
          notify('Tersimpan', `Data ${namaTampil} diperbarui.`);
        }
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan user.');
    } finally {
      setSubmitting(false);
    }
  };

  if (memuat) {
    return (
      <View style={styles.tengah}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const kekuatan = kekuatanPassword(password);

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView
        {...PROP_SCROLL_FORM}
        style={styles.container}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: RUANG_BAWAH_FORM }}
      >
        {mode === 'SUNTING' && namaTampil.trim() ? (
          <View style={styles.profil}>
            <View style={styles.avatar}>
              <Text style={styles.avatarTeks}>{inisial(namaTampil)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.profilNama} numberOfLines={1}>
                {namaTampil}
              </Text>
              <Text style={styles.profilSub} numberOfLines={1}>
                @{username} · {ROLE_LABEL[role]}
              </Text>
            </View>
          </View>
        ) : null}

        <KartuLangkah nomor={1} judul="Hak akses" keterangan="Pilih peran dulu. Rincian izin tiap role diatur di Pengaturan › Permission Matrix.">
          <View style={styles.roleGrid}>
            {ROLES.map((r) => {
              const aktif = role === r;
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.roleUbin, aktif && styles.roleUbinAktif]}
                  onPress={() => setRole(r)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: aktif, checked: aktif }}
                  accessibilityLabel={ROLE_LABEL[r]}
                >
                  <Ionicons
                    name={IKON_ROLE[r] as keyof typeof Ionicons.glyphMap}
                    size={18}
                    color={aktif ? colors.primary : colors.textMuted}
                  />
                  <Text style={[styles.roleTeks, aktif && styles.roleTeksAktif]} numberOfLines={1}>
                    {ROLE_LABEL[r]}
                  </Text>
                  <Ionicons name={aktif ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={aktif ? colors.primary : colors.border} />
                </TouchableOpacity>
              );
            })}
          </View>
        </KartuLangkah>

        <KartuLangkah
          nomor={2}
          judul={peranAnggota ? 'Anggota & username' : 'Identitas'}
          keterangan={peranAnggota ? 'Akun Anggota ditautkan ke data anggota; nama akun mengikuti nama anggota.' : 'Nama tampil di jejak audit; username dipakai untuk masuk.'}
        >
          {peranAnggota ? (
            <>
              <AnggotaPicker value={anggota} onChange={pilihAnggota} />
              {anggota ? (
                <View style={styles.tautanAnggota}>
                  <Ionicons name="link-outline" size={15} color={colors.primary} />
                  <Text style={styles.tautanAnggotaTeks} numberOfLines={2}>
                    Nama akun: <Text style={styles.tebal}>{anggota.namaLengkap}</Text> · No. {anggota.nomorAnggota}
                  </Text>
                </View>
              ) : (
                <KotakInfo nada="info">Satu anggota hanya dapat memiliki satu akun. Anggota yang sudah keluar tidak dapat dipilih.</KotakInfo>
              )}
            </>
          ) : (
            <Field label="Nama Lengkap *" icon="person-outline" value={nama} onChangeText={setNama} />
          )}
          <Field label="Username *" icon="at-outline" value={username} onChangeText={setUsername} />
        </KartuLangkah>

        <KartuLangkah
          nomor={3}
          judul={mode === 'TAMBAH' ? 'Password masuk' : 'Ganti password'}
          label={mode === 'SUNTING' ? 'Opsional' : undefined}
        >
          {/* Penjelasan pemisahan peran ditaruh DI SINI, tempat
              pertanyaannya muncul: "kenapa password, bukan PIN?" */}
          <View style={styles.catatan}>
            <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
            <Text style={styles.catatanTeks}>
              Password dipakai untuk MASUK. PIN 6 digit hanya untuk membuka kunci aplikasi, dan
              ditetapkan sendiri oleh pemiliknya lewat Pengaturan &rsaquo; Keamanan.
            </Text>
          </View>

          {mode === 'SUNTING' && (
            <Text style={styles.petunjuk}>
              Kosongkan bila password tidak ingin diubah.
            </Text>
          )}

          <AppTextInput
            label={mode === 'TAMBAH' ? `Password * (minimal ${PANJANG_MIN_PASSWORD} karakter)` : 'Password Baru'}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            noIcon
          />
          {gantiPassword && password.length > 0 && (
            <View style={styles.kekuatanBaris}>
              <View style={styles.kekuatanRel}>
                <View
                  style={[
                    styles.kekuatanIsi,
                    kekuatan === 'LEMAH' && styles.kekuatanLemah,
                    kekuatan === 'CUKUP' && styles.kekuatanCukup,
                    kekuatan === 'KUAT' && styles.kekuatanKuat,
                  ]}
                />
              </View>
              <Text style={styles.kekuatanTeks}>{LABEL_KEKUATAN[kekuatan]}</Text>
            </View>
          )}

          <AppTextInput
            label={mode === 'TAMBAH' ? 'Ulangi Password *' : 'Ulangi Password Baru'}
            value={passwordKonfirmasi}
            onChangeText={setPasswordKonfirmasi}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            noIcon
          />
          {gantiPassword && hasilPassword.pesan && passwordKonfirmasi.length > 0 && (
            <FieldError message={hasilPassword.pesan} />
          )}
        </KartuLangkah>

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={15} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TombolUtama
          label={mode === 'TAMBAH' ? 'Buat User' : 'Simpan Perubahan'}
          ikon={mode === 'TAMBAH' ? 'person-add-outline' : 'save-outline'}
          onPress={submit}
          memuat={submitting}
        />
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Field({
  label,
  icon,
  value,
  onChangeText,
}: {
  label: string;
  icon: any;
  value: string;
  onChangeText: (v: string) => void;
}) {
  return (
    <AppTextInput
      label={label}
      value={value}
      onChangeText={onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      icon={icon}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  profil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarTeks: { fontSize: 15, fontWeight: '700', color: colors.primary },
  profilNama: { fontSize: 15, fontWeight: '700', color: colors.text },
  profilSub: { fontSize: typography.caption, color: colors.primaryDark, marginTop: 1 },
  roleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tautanAnggota: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  tautanAnggotaTeks: { flex: 1, fontSize: 12, color: colors.primaryDark },
  tebal: { fontWeight: '800' },
  roleUbin: {
    flexGrow: 1,
    flexBasis: '46%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  roleUbinAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  roleTeks: { flex: 1, minWidth: 0, fontSize: typography.subtitle, fontWeight: '600', color: colors.text },
  roleTeksAktif: { color: colors.primaryDark },
  catatan: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: spacing.md },
  catatanTeks: { flex: 1, minWidth: 0, fontSize: 11.5, color: colors.textMuted, lineHeight: 17 },
  petunjuk: { fontSize: 11.5, color: colors.textMuted, marginBottom: spacing.sm, fontStyle: 'italic' },
  kekuatanBaris: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: spacing.sm },
  kekuatanRel: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' },
  kekuatanIsi: { height: 4, borderRadius: 2 },
  kekuatanLemah: { width: '33%', backgroundColor: colors.danger },
  kekuatanCukup: { width: '66%', backgroundColor: colors.warning },
  kekuatanKuat: { width: '100%', backgroundColor: colors.success },
  kekuatanTeks: { fontSize: 11, fontWeight: '700', color: colors.textMuted, minWidth: 42, textAlign: 'right' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { flex: 1, minWidth: 0, color: colors.danger, fontSize: 12.5, lineHeight: 18 },
});
