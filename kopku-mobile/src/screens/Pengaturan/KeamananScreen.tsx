import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Switch, ActivityIndicator } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '@/store/useAppStore';
import {
  getUserById,
  setBiometricEnabled,
  siapkanPinCepatSetelahDiatur,
  verifikasiIdentitasPengguna,
} from '@/services/AuthService';
import { aturPinKunciAplikasi } from '@/services/UserManagementService';
import {
  isPinEnabled,
  setPinEnabled,
  resolvePinState,
  tandaiPinSudahDitetapkan,
  PinState,
} from '@/services/SecurityService';
import PinInput from '@/components/PinInput';
import AppTextInput from '@/components/AppTextInput';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { notify } from '@/store/useNotifyStore';
import { colors, elevation, iconSize, radius, spacing, touchTarget } from '@/theme/colors';
import { ui } from '@/theme/ui';
import { validasiPinBaru } from '@/utils/pinBaru';

/**
 * ============================================================
 * MENU KEAMANAN (Pengaturan > Keamanan) — RC-S121 · RC-S131
 * ============================================================
 *
 * RC-S131 — BUG: "tidak bisa menambahkan PIN baru".
 * Formulir PIN dulu HANYA tampil pada state PIN_ENABLED_SETUP_REQUIRED
 * (penanda global "PIN belum ditetapkan", yang hanya bernilai 1 bila
 * setup awal dilewati tanpa PIN). Akibatnya:
 *   - PIN yang sudah ada tidak pernah bisa diganti;
 *   - pengguna yang dibuat Admin (PIN awalnya acak & memang tidak dapat
 *     dipakai, lihat UserManagementService) tidak pernah bisa membuat PIN
 *     sendiri — padahal begitu aplikasi terkunci, layar kunci menanyakan
 *     PIN yang tidak pernah mereka ketahui.
 * Sekarang:
 *   - SETUP_REQUIRED  -> formulir "Buat PIN" langsung terbuka (perilaku lama);
 *   - selain itu      -> tombol "Ganti PIN" / "Atur PIN" membuka formulir
 *     yang meminta bukti identitas dulu: PIN saat ini ATAU password login
 *     (`verifikasiIdentitasPengguna`).
 * Penyimpanan tetap `aturPinKunciAplikasi` (RC-S117) — service tidak diubah.
 * Setelah tersimpan, jalur buka kunci cepat (RC-S130) langsung disiapkan
 * untuk PIN baru.
 *
 * Menu ini TIDAK digerbangi permission role: PIN & biometrik adalah
 * pengaturan kunci aplikasi milik user yang sedang login.
 * Layar merender PinInput, jadi dibungkus AreaAmanKeyboard +
 * PROP_SCROLL_FORM (sensus RC-S120).
 */
export default function KeamananScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [biometricTersedia, setBiometricTersedia] = useState(false);
  const [loadingBiometric, setLoadingBiometric] = useState(true);
  const [togglingBiometric, setTogglingBiometric] = useState(false);

  // Status PIN dibaca dari SATU sumber (SecurityService). PIN pada aplikasi
  // ini MURNI kunci layar — bukan kunci enkripsi database/backup — sehingga
  // mematikannya tidak membuat data kehilangan proteksi.
  const [pinAktif, setPinAktif] = useState(false);
  const [pinState, setPinState] = useState<PinState | null>(null);
  const [loadingPin, setLoadingPin] = useState(true);
  const [togglingPin, setTogglingPin] = useState(false);

  // Formulir PIN. `formGanti` = dibuka lewat tombol (butuh verifikasi identitas).
  const [formGanti, setFormGanti] = useState(false);
  const [verifikasi, setVerifikasi] = useState('');
  const [pinBaru, setPinBaru] = useState('');
  const [pinKonfirmasi, setPinKonfirmasi] = useState('');
  const [menyimpanPin, setMenyimpanPin] = useState(false);
  const [galatVerifikasi, setGalatVerifikasi] = useState<string | null>(null);

  const muatStatusPin = async () => {
    try {
      setPinAktif(await isPinEnabled());
      setPinState(await resolvePinState({ sesiTerkunci: false }));
    } catch {
      // Biarkan status apa adanya — kegagalan baca konfigurasi tidak boleh
      // membuat seluruh layar gagal render.
    } finally {
      setLoadingPin(false);
    }
  };

  useEffect(() => {
    muatStatusPin();
  }, []);

  const perluBuatPin = pinState === 'PIN_ENABLED_SETUP_REQUIRED';
  const formTerbuka = perluBuatPin || formGanti;
  const validasi = validasiPinBaru(pinBaru, pinKonfirmasi);
  const bolehSimpan = validasi.bolehSimpan && (!formGanti || perluBuatPin || verifikasi.length > 0) && !menyimpanPin;

  const kosongkanForm = () => {
    setVerifikasi('');
    setPinBaru('');
    setPinKonfirmasi('');
    setGalatVerifikasi(null);
  };

  const togglePin = async (nilaiBaru: boolean) => {
    setTogglingPin(true);
    try {
      await setPinEnabled(nilaiBaru);
      // §16: mematikan PIN TIDAK menghapus pin_hash/pin_salt milik user.
      // Menyalakannya kembali langsung memakai PIN yang sama.
      if (!nilaiBaru) {
        kosongkanForm();
        setFormGanti(false);
      }
      await muatStatusPin();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setTogglingPin(false);
    }
  };

  const simpanPinBaru = async () => {
    if (!currentUser) return;
    if (!/^\d{6}$/.test(pinBaru)) {
      notify('PIN tidak valid', 'PIN harus 6 digit angka.');
      return;
    }
    if (pinBaru !== pinKonfirmasi) {
      notify('PIN tidak cocok', 'Konfirmasi PIN berbeda dengan PIN yang dibuat.');
      return;
    }
    if (validasi.galatPin) {
      notify('PIN terlalu mudah', validasi.galatPin);
      return;
    }
    setMenyimpanPin(true);
    setGalatVerifikasi(null);
    try {
      // Mengganti PIN yang sudah ada -> buktikan identitas dulu.
      if (formGanti && !perluBuatPin) {
        const sah = await verifikasiIdentitasPengguna(currentUser.id, verifikasi.trim());
        if (!sah) {
          setGalatVerifikasi('PIN saat ini atau password salah.');
          return;
        }
      }
      // RC-S117 — jalur khusus PIN kunci aplikasi (bukan resetUserPin yang
      // menuntut ADMIN), sehingga setiap pengguna dapat mengatur PIN-nya sendiri.
      await aturPinKunciAplikasi(currentUser.id, currentUser.id, pinBaru);
      await tandaiPinSudahDitetapkan();
      await siapkanPinCepatSetelahDiatur(currentUser.id, pinBaru);
      kosongkanForm();
      setFormGanti(false);
      await muatStatusPin();
      notify(
        'PIN tersimpan',
        pinAktif ? 'PIN baru langsung berlaku saat aplikasi terkunci berikutnya.' : 'PIN tersimpan. Nyalakan "Gunakan PIN" agar aplikasi meminta PIN saat dibuka.'
      );
    } catch (e) {
      notify('Gagal menyimpan PIN', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpanPin(false);
    }
  };

  useEffect(() => {
    (async () => {
      if (!currentUser) return;
      try {
        const [user, hasHardware, isEnrolled] = await Promise.all([
          getUserById(currentUser.id),
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        setBiometricEnabledState(user?.biometricEnabled ?? false);
        setBiometricTersedia(hasHardware && isEnrolled);
      } catch {
        setBiometricTersedia(false);
      } finally {
        setLoadingBiometric(false);
      }
    })();
  }, [currentUser]);

  const toggleBiometric = async (nilaiBaru: boolean) => {
    if (!currentUser) return;
    setTogglingBiometric(true);
    try {
      if (nilaiBaru) {
        // Verifikasi identitas dulu sebelum benar-benar mengaktifkan —
        // supaya yang mengaktifkan memang pemilik sidik jari/wajah
        // yang terdaftar di perangkat ini.
        const hasil = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Verifikasi untuk mengaktifkan login biometric',
        });
        if (!hasil.success) {
          notify('Gagal', 'Verifikasi biometric gagal, login biometric tidak diaktifkan.');
          return;
        }
      }
      await setBiometricEnabled(currentUser.id, nilaiBaru);
      setBiometricEnabledState(nilaiBaru);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setTogglingBiometric(false);
    }
  };

  const status = loadingPin
    ? null
    : perluBuatPin
      ? { teks: 'PIN belum dibuat', warna: colors.warning, latar: colors.warningBg, ikon: 'alert-circle' as const }
      : pinAktif
        ? { teks: 'Aktif', warna: colors.success, latar: colors.primaryLight, ikon: 'checkmark-circle' as const }
        : { teks: 'Nonaktif', warna: colors.textMuted, latar: colors.background, ikon: 'remove-circle-outline' as const };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
    <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={ui.screenContent}>
      {/* Kop penjelasan */}
      <View style={styles.kop}>
        <View style={styles.kopIkon}>
          <Ionicons name="shield-checkmark" size={22} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.kopJudul}>Keamanan Aplikasi</Text>
          <Text style={styles.kopTeks}>
            Atur kunci layar untuk akun Anda. PIN dan biometrik hanya mengunci tampilan aplikasi di perangkat ini; password tetap
            dipakai untuk masuk.
          </Text>
        </View>
      </View>

      <Text style={styles.sectionLabel}>KUNCI APLIKASI</Text>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.ikonBaris}>
            <Ionicons name="keypad-outline" size={iconSize.md} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Gunakan PIN</Text>
            <Text style={styles.cardSub}>
              {pinAktif
                ? 'Aplikasi meminta PIN saat dibuka dan setelah terkunci otomatis.'
                : 'PIN tidak diminta saat membuka aplikasi. Data koperasi tetap tersimpan seperti biasa.'}
            </Text>
          </View>
          {loadingPin || togglingPin ? (
            <ActivityIndicator />
          ) : (
            <Switch
              value={pinAktif}
              onValueChange={togglePin}
              trackColor={{ false: colors.border, true: colors.primaryLight }}
              thumbColor={pinAktif ? colors.primary : undefined}
            />
          )}
        </View>

        {status ? (
          <View style={styles.statusBaris}>
            <View style={[styles.lencana, { backgroundColor: status.latar }]}>
              <Ionicons name={status.ikon} size={13} color={status.warna} />
              <Text style={[styles.lencanaTeks, { color: status.warna }]}>{status.teks}</Text>
            </View>
            {pinAktif && !perluBuatPin ? <Text style={styles.statusInfo}>Terkunci otomatis setelah 5 menit tidak aktif</Text> : null}
          </View>
        ) : null}

        {/* Tombol membuka formulir ganti/atur PIN (selain kondisi wajib-buat). */}
        {!loadingPin && !perluBuatPin && !formGanti ? (
          <TouchableOpacity
            style={styles.tombolGaris}
            onPress={() => {
              kosongkanForm();
              setFormGanti(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={pinAktif ? 'Ganti PIN' : 'Atur PIN'}
          >
            <Ionicons name="create-outline" size={iconSize.sm} color={colors.primary} />
            <Text style={styles.tombolGarisTeks}>{pinAktif ? 'Ganti PIN' : 'Atur PIN'}</Text>
            <Ionicons name="chevron-forward" size={iconSize.sm} color={colors.primary} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        ) : null}

        {formTerbuka && (
          <View style={styles.pinSetupBox}>
            <Text style={styles.formJudul}>{perluBuatPin ? 'Buat PIN (6 digit)' : 'Ganti PIN'}</Text>
            <Text style={styles.cardSub}>
              {perluBuatPin
                ? 'PIN belum ditetapkan. Aplikasi belum akan mengunci sampai PIN dibuat.'
                : 'Lupa PIN lama atau belum pernah membuat PIN? Isi dengan password login Anda.'}
            </Text>

            {formGanti && !perluBuatPin ? (
              <View style={{ marginTop: spacing.md }}>
                <AppTextInput
                  label="PIN saat ini atau password login"
                  inputType="key"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={verifikasi}
                  onChangeText={(t) => {
                    setVerifikasi(t);
                    if (galatVerifikasi) setGalatVerifikasi(null);
                  }}
                  error={galatVerifikasi ?? undefined}
                  hint="Untuk keamanan, buktikan bahwa ini Anda."
                />
              </View>
            ) : null}

            <Text style={[styles.pinSetupTitle, { marginTop: spacing.md }]}>PIN baru</Text>
            <PinInput value={pinBaru} onChangeText={setPinBaru} error={validasi.galatPin ?? undefined} />
            {validasi.galatPin ? <Pesan jenis="galat" teks={validasi.galatPin} /> : null}

            <Text style={[styles.pinSetupTitle, { marginTop: spacing.md }]}>Ulangi PIN baru</Text>
            <PinInput value={pinKonfirmasi} onChangeText={setPinKonfirmasi} error={validasi.galatKonfirmasi ?? undefined} />
            {validasi.galatKonfirmasi ? (
              <Pesan jenis="galat" teks={validasi.galatKonfirmasi} />
            ) : validasi.cocok ? (
              <Pesan jenis="ok" teks="PIN cocok" />
            ) : null}

            <View style={styles.tips}>
              <Ionicons name="bulb-outline" size={iconSize.sm} color={colors.textMuted} />
              <Text style={styles.tipsTeks}>
                Ketuk kotak untuk mengetik. Hindari tanggal lahir, angka berurutan (123456), atau angka yang sama semua (111111).
              </Text>
            </View>

            <View style={styles.aksiBaris}>
              {formGanti && !perluBuatPin ? (
                <TouchableOpacity
                  style={styles.tombolBatal}
                  onPress={() => {
                    kosongkanForm();
                    setFormGanti(false);
                  }}
                  disabled={menyimpanPin}
                  accessibilityRole="button"
                >
                  <Text style={styles.tombolBatalTeks}>Batal</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.pinSaveButton, !bolehSimpan && styles.pinSaveButtonDisabled]}
                onPress={simpanPinBaru}
                disabled={!bolehSimpan}
                accessibilityRole="button"
                accessibilityLabel="Simpan PIN"
                accessibilityState={{ disabled: !bolehSimpan }}
              >
                {menyimpanPin ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={styles.pinSaveText}>Simpan PIN</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      <Text style={styles.sectionLabel}>BIOMETRIK</Text>
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.ikonBaris}>
            <Ionicons name="finger-print" size={iconSize.md} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Login dengan Biometric</Text>
            <Text style={styles.cardSub}>
              {biometricTersedia
                ? 'Gunakan sidik jari/wajah untuk membuka kunci aplikasi'
                : 'Perangkat ini belum mendaftarkan sidik jari/wajah'}
            </Text>
          </View>
          {loadingBiometric || togglingBiometric ? (
            <ActivityIndicator />
          ) : (
            <Switch
              value={biometricEnabled}
              onValueChange={toggleBiometric}
              disabled={!biometricTersedia}
              trackColor={{ false: colors.border, true: colors.primaryLight }}
              thumbColor={biometricEnabled ? colors.primary : undefined}
            />
          )}
        </View>
        <Text style={[styles.cardSub, { marginTop: spacing.sm }]}>
          Tombol biometrik muncul di layar kunci sebagai alternatif PIN, jadi hanya terpakai saat "Gunakan PIN" menyala.
        </Text>
      </View>
    </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Pesan({ jenis, teks }: { jenis: 'galat' | 'ok'; teks: string }) {
  const warna = jenis === 'galat' ? colors.danger : colors.success;
  return (
    <View style={styles.pesan}>
      <Ionicons name={jenis === 'galat' ? 'alert-circle' : 'checkmark-circle'} size={iconSize.sm} color={warna} />
      <Text style={[styles.pesanTeks, { color: warna }]}>{teks}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  kopIkon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kopJudul: { fontSize: 15, fontWeight: '800', color: colors.primaryDark },
  kopTeks: { fontSize: 12, color: colors.text, lineHeight: 17, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  ikonBaris: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
  sectionLabel: { ...ui.sectionLabel },
  statusBaris: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  lencana: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  lencanaTeks: { fontSize: 12, fontWeight: '700' },
  statusInfo: { fontSize: 11, color: colors.textMuted },
  tombolGaris: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
  },
  tombolGarisTeks: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  pinSetupBox: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
  formJudul: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 2 },
  pinSetupTitle: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  pesan: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  pesanTeks: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  tips: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.lg,
  },
  tipsTeks: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  aksiBaris: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tombolBatal: {
    flex: 1,
    minHeight: touchTarget,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tombolBatalTeks: { color: colors.text, fontWeight: '700', fontSize: 14 },
  pinSaveButton: {
    flex: 2,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinSaveButtonDisabled: { backgroundColor: colors.disabled },
  pinSaveText: { color: colors.white, fontWeight: '700', fontSize: 14 },
});
