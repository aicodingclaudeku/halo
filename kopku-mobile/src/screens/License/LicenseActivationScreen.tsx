import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';
import {
  activateLicense,
  normalizeLicenseKey,
  verifyLicense,
  type LicenseStatus,
} from '@/services/LicenseService';
import { LICENSE_OFFLINE_GRACE_PERIOD_DAYS } from '@/config/license';
import { maskDeviceId } from '@/security/deviceId';
import LicenseDiagnosticScreen from './LicenseDiagnosticScreen';
// KOPKU Desktop: info data dari HP + isi otomatis nama koperasi (null di Android).
import InfoLisensiDesktop from '@/desktop/InfoLisensiDesktop';

/**
 * Layar aktivasi & layar "tertahan" lisensi.
 *
 * Satu komponen menangani DUA peran yang saling terkait:
 *   - belum pernah aktivasi  -> form license key;
 *   - sudah aktivasi tapi ditolak (dicabut/kedaluwarsa/perlu verifikasi)
 *     -> penjelasan + tombol "Coba Verifikasi Lagi" (§22).
 *
 * Digabung karena keduanya adalah "aplikasi tidak boleh dibuka, ini
 * alasannya, ini yang bisa Anda lakukan". Memisahnya jadi dua layar
 * hanya menambah rute yang harus dijaga tanpa menambah kejelasan.
 *
 * DUA AKSI YANG SENGAJA DIBEDAKAN (RC-S52):
 *   - "Coba Verifikasi Lagi"  -> `verifyLicense()`: kirim token LAMA
 *     yang tersimpan, tanya ulang ke server. Berguna bila penerbit
 *     memperpanjang lisensi tanpa menerbitkan key baru.
 *   - "Aktivasi Lisensi Baru" -> `activateLicense()`: kirim LICENSE KEY
 *     BARU, minta token baru. Inilah jalan keluar dari trial/lisensi
 *     berjangka yang habis.
 *
 * Keduanya ada bersama-sama, dan keduanya sama-sama berujung pada
 * `onLicensed()` yang HANYA memicu evaluasi ulang gate — bukan membawa
 * keputusan "boleh masuk". Layar ini tidak pernah memutuskan apa pun.
 *
 * ATURAN TAMPILAN (§11): TIDAK PERNAH menampilkan stack trace, pesan
 * exception mentah, atau detail internal server. Semua teks berasal dari
 * pemetaan kode error di LicenseService.
 */

type Phase = 'IDLE' | 'CONNECTING' | 'VALIDATING' | 'SUCCESS';

interface Props {
  readonly status: LicenseStatus;
  /** Dipanggil setelah lisensi menjadi sah — gate mengevaluasi ulang. */
  readonly onLicensed: () => void;
}

interface BlockedCopy {
  readonly title: string;
  readonly body: string;
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly tone: 'danger' | 'warn';
}

const STATE_COPY: Record<string, BlockedCopy> = {
  CRYPTO_UNAVAILABLE: {
    title: 'Pemeriksaan Keamanan Gagal',
    body:
      'Verifikasi tanda tangan digital tidak berjalan benar di perangkat ini, sehingga lisensi ' +
      'tidak dapat diperiksa. Aplikasi sengaja mengunci diri daripada menerima lisensi yang tidak ' +
      'terverifikasi. Buka Diagnostik Keamanan di bawah dan laporkan hasilnya kepada penerbit.',
    icon: 'bug-outline',
    tone: 'danger',
  },
  NOT_CONFIGURED: {
    title: 'Lisensi Belum Dikonfigurasi',
    body:
      'Aplikasi ini dibangun tanpa kunci verifikasi lisensi, sehingga aktivasi tidak dapat diproses. ' +
      'Hubungi penerbit aplikasi untuk mendapatkan versi yang benar.',
    icon: 'construct-outline',
    tone: 'danger',
  },
  DEACTIVATED: {
    title: 'Perangkat Dinonaktifkan',
    body:
      'Perangkat ini dinonaktifkan oleh penerbit aplikasi, sehingga lisensinya tidak lagi berlaku ' +
      'di sini. Seluruh data koperasi Anda tetap tersimpan dan tidak terhapus. Bila penerbit sudah ' +
      'memberi Anda License Key baru, masukkan di bawah. Penanda deaktivasi hanya dapat dibatalkan ' +
      'oleh server — mengisi form ini tidak melewatinya.',
    icon: 'phone-portrait-outline',
    tone: 'danger',
  },
  COOPERATIVE_MISMATCH: {
    title: 'Koperasi Tidak Cocok',
    body:
      'License ini terdaftar untuk koperasi lain. Satu license key hanya dapat dipakai oleh satu ' +
      'koperasi. Periksa kembali license key Anda, atau hubungi penerbit aplikasi.',
    icon: 'business-outline',
    tone: 'danger',
  },
  REVOKED: {
    title: 'Lisensi Dicabut',
    body:
      'Penerbit telah mencabut lisensi untuk perangkat ini, sehingga aplikasi tidak dapat dibuka. ' +
      'Bila Anda sudah memiliki License Key baru, masukkan di bawah — server tetap yang memutuskan ' +
      'apakah aktivasi diizinkan. Bila Anda merasa pencabutan ini keliru, hubungi penerbit lalu ' +
      'tekan "Coba Verifikasi Lagi".',
    icon: 'close-circle-outline',
    tone: 'danger',
  },
  EXPIRED: {
    title: 'Lisensi Kedaluwarsa',
    body:
      'Masa berlaku lisensi Anda telah berakhir. Masukkan License Key baru untuk melanjutkan ' +
      'penggunaan Kopku. Data koperasi Anda tetap tersimpan di perangkat.',
    icon: 'time-outline',
    tone: 'warn',
  },
  DEVICE_MISMATCH: {
    title: 'Perangkat Tidak Cocok',
    body:
      'Lisensi yang tersimpan diterbitkan untuk perangkat lain. Demi keamanan, aplikasi dikunci. ' +
      'Aktivasi ulang dengan license key Anda, atau hubungi penerbit.',
    icon: 'shield-outline',
    tone: 'danger',
  },
  NEEDS_VERIFICATION: {
    title: 'Verifikasi Diperlukan',
    body: 'Hubungkan perangkat ke internet, lalu tekan "Coba Verifikasi Lagi".',
    icon: 'cloud-offline-outline',
    tone: 'warn',
  },
  INVALID: {
    title: 'Lisensi Tidak Valid',
    body:
      'Data lisensi di perangkat ini tidak lolos pemeriksaan keamanan. Aktivasi ulang dengan license key Anda.',
    icon: 'alert-circle-outline',
    tone: 'danger',
  },
};

export default function LicenseActivationScreen({ status, onLicensed }: Props) {
  const [licenseKey, setLicenseKey] = useState('');
  // Nama koperasi diambil dari lisensi yang SUDAH tersimpan bila ada
  // (§RC-S52). Mengetik ulang nama yang sudah diketahui aplikasi bukan
  // lapisan keamanan — ia hanya kesempatan salah ketik, dan salah ketik
  // di sini berakhir sebagai COOPERATIVE_MISMATCH yang membingungkan.
  //
  // Binding koperasi TIDAK ditentukan oleh isian ini: nama yang diketik
  // dikirim ke server dan dicocokkan dengan `cooperative_name` di dalam
  // token bertanda tangan (`expectedCooperativeName` di
  // `activateLicense()`). Mengubah teks di layar tanpa token yang cocok
  // hanya menghasilkan penolakan, bukan perpindahan binding.
  const [cooperativeName, setCooperativeName] = useState(status.cooperativeName ?? '');
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'danger' | 'success'>('danger');
  const [showDiagnostic, setShowDiagnostic] = useState(false);

  const busy = phase === 'CONNECTING' || phase === 'VALIDATING';

  /**
   * KEADAAN YANG HANYA BISA DISELESAIKAN DENGAN LISENSI BARU (RC-S52).
   *
   * Sebelum ini, EXPIRED / REVOKED / DEACTIVATED tidak punya form sama
   * sekali: satu-satunya tombol adalah "Coba Verifikasi Lagi", yang
   * mengirim token LAMA — token yang justru sudah ditolak. Akibatnya
   * trial 3/7 hari atau lisensi 1 bulan yang habis mengunci aplikasi
   * TANPA jalan keluar di dalam aplikasi, walaupun pengguna sudah
   * memegang License Key baru yang sah.
   *
   * Membuka form di sini BUKAN pelonggaran. Aktivasi tetap melewati
   * `activateLicense()` yang sama: HTTP ke server, token bertanda tangan
   * Ed25519, device binding, cooperative binding, trusted clock. Server
   * tetap bebas menolak (DEVICE_DEACTIVATED, LICENSE_REVOKED, dst.), dan
   * penolakan itu membiarkan layar ini tetap terkunci. Yang berubah
   * hanya SATU hal: pengguna punya cara untuk MENGAJUKAN lisensi baru.
   */
  const isRenewal =
    status.state === 'EXPIRED' ||
    status.state === 'REVOKED' ||
    status.state === 'DEACTIVATED';

  // NOT_CONFIGURED & CRYPTO_UNAVAILABLE tetap tanpa form: di kedua
  // keadaan itu `activateLicense()` menolak sebelum menyentuh jaringan,
  // jadi form hanya akan mengundang percobaan yang pasti gagal. Satu-
  // satunya tindakan yang berguna di sana adalah Diagnostik Keamanan.
  const showForm =
    status.state === 'NOT_ACTIVATED' ||
    status.state === 'DEVICE_MISMATCH' ||
    status.state === 'COOPERATIVE_MISMATCH' ||
    status.state === 'INVALID' ||
    isRenewal;

  // Tanpa token tersimpan tidak ada yang bisa diverifikasi ke server.
  // Dasarnya sekarang FAKTA ADANYA TOKEN (`hasStoredLicense`), bukan
  // tebakan dari `state`: perangkat yang ditolak server lewat
  // DEVICE_DEACTIVATED masih menyimpan token, dan bila admin membatalkan
  // deaktivasi, tombol inilah yang membuatnya terbaca tanpa key baru.
  const showRetry = status.hasStoredLicense;

  const blocked = status.state !== 'NOT_ACTIVATED' ? STATE_COPY[status.state] : undefined;

  const normalizedKey = useMemo(() => normalizeLicenseKey(licenseKey), [licenseKey]);
  const canSubmit =
    !busy &&
    normalizedKey.length > 0 &&
    cooperativeName.trim().length >= 3 &&
    status.state !== 'NOT_CONFIGURED' &&
    status.state !== 'CRYPTO_UNAVAILABLE';

  const handleActivate = useCallback(async () => {
    setMessage(null);
    setPhase('CONNECTING');
    // Fase VALIDATING ditampilkan setelah request selesai — verifikasi
    // token lokal memang terjadi SETELAH respons diterima (§12 poin 5).
    const result = await activateLicense({
      licenseKey: normalizedKey,
      cooperativeName: cooperativeName.trim(),
    });

    if (!result.ok) {
      setPhase('IDLE');
      setMessageTone('danger');
      setMessage(result.message);
      return;
    }

    setPhase('SUCCESS');
    setMessageTone('success');
    setMessage('Aktivasi berhasil.');
    onLicensed();
  }, [normalizedKey, cooperativeName, onLicensed]);

  const handleRetryVerify = useCallback(async () => {
    setMessage(null);
    setPhase('VALIDATING');
    const result = await verifyLicense();
    setPhase('IDLE');
    if (result.ok) {
      setMessageTone('success');
      setMessage('Lisensi terverifikasi.');
      onLicensed();
      return;
    }
    setMessageTone('danger');
    setMessage(result.message);
  }, [onLicensed]);

  // Diagnostik harus tercapai JUSTRU ketika aplikasi terkunci — itulah
  // saat orang paling butuh tahu penyebabnya. Karena layar ini dirender
  // langsung oleh gate (bukan lewat rute), navigasinya dilakukan dengan
  // state lokal: rute apa pun akan tetap tertahan di belakang gate.
  if (showDiagnostic) {
    return <LicenseDiagnosticScreen onBack={() => setShowDiagnostic(false)} />;
  }

  const statusLine =
    phase === 'CONNECTING'
      ? 'Menghubungkan ke server…'
      : phase === 'VALIDATING'
        ? 'Memvalidasi lisensi…'
        : null;

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <AreaAmanKeyboard varian="layar" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.logoCircle}>
            <Ionicons name="key-outline" size={30} color={colors.white} />
          </View>
          <Text style={styles.title}>Aktivasi Lisensi Kopku</Text>
          <Text style={styles.subtitle}>
            Lisensi diperlukan untuk menggunakan aplikasi. Data koperasi Anda tetap tersimpan di perangkat ini.
          </Text>
          <InfoLisensiDesktop namaKosong={!cooperativeName} isiNama={setCooperativeName} />

          {blocked && (
            <View
              style={[
                styles.noticeBox,
                blocked.tone === 'danger' ? styles.noticeDanger : styles.noticeWarn,
              ]}
            >
              <Ionicons
                name={blocked.icon}
                size={20}
                color={blocked.tone === 'danger' ? colors.danger : colors.warning}
              />
              <View style={styles.noticeTextWrap}>
                <Text style={styles.noticeTitle}>{blocked.title}</Text>
                <Text style={styles.noticeBody}>{blocked.body}</Text>
              </View>
            </View>
          )}

          {status.clockRollbackDetected && (
            <View style={[styles.noticeBox, styles.noticeWarn]}>
              <Ionicons name="alarm-outline" size={20} color={colors.warning} />
              <View style={styles.noticeTextWrap}>
                <Text style={styles.noticeTitle}>Jam Perangkat Tidak Wajar</Text>
                <Text style={styles.noticeBody}>
                  Jam perangkat terdeteksi mundur. Setel tanggal &amp; waktu ke otomatis, lalu verifikasi ulang.
                </Text>
              </View>
            </View>
          )}

          {showForm && (
            <View style={styles.card}>
              {/* UI/UX FINAL POLISH: dua field ini sekarang memakai
                  `AppTextInput` bersama, jadi label, batas, ikon per tipe,
                  dan focus state-nya sama dengan seluruh form lain.
                  `value`/`onChangeText`/`editable` diteruskan apa adanya —
                  tidak ada perilaku input yang berubah. */}
              <AppTextInput
                label={isRenewal ? 'License Key Baru' : 'License Key'}
                inputType="key"
                placeholder="KPK-XXXX-XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
                value={licenseKey}
                onChangeText={setLicenseKey}
              />

              <AppTextInput
                label="Nama Koperasi"
                inputType="business"
                placeholder="Nama koperasi Anda"
                editable={!busy}
                value={cooperativeName}
                onChangeText={setCooperativeName}
              />
              {status.cooperativeName !== null && (
                <Text style={styles.fieldHint}>
                  Terisi otomatis dari lisensi sebelumnya. Ubah hanya bila License Key baru memang diterbitkan
                  untuk nama koperasi yang berbeda.
                </Text>
              )}

              <TouchableOpacity
                style={[styles.button, !canSubmit && styles.buttonDisabled]}
                onPress={handleActivate}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
              >
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <>
                    <Text style={styles.buttonText}>
                      {isRenewal ? 'Aktivasi Lisensi Baru' : 'Aktivasi Lisensi'}
                    </Text>
                    <Ionicons name="arrow-forward" size={18} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {showRetry && (
            <TouchableOpacity
              style={[styles.secondaryButton, busy && styles.buttonDisabled]}
              onPress={handleRetryVerify}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
            >
              {busy ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <>
                  <Ionicons name="refresh" size={18} color={colors.primary} />
                  <Text style={styles.secondaryButtonText}>Coba Verifikasi Lagi</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {showRetry && showForm && (
            // Dua tombol dengan tujuan berbeda duduk berdampingan, jadi
            // bedanya dijelaskan — bukan disimpulkan dari namanya.
            <Text style={styles.fieldHint}>
              &quot;Coba Verifikasi Lagi&quot; memeriksa ulang lisensi yang sudah tersimpan ke server — pakai ini
              bila penerbit baru saja memperpanjang lisensi Anda tanpa memberi key baru.
            </Text>
          )}

          {statusLine && <Text style={styles.statusLine}>{statusLine}</Text>}

          {message && (
            <View style={[styles.messageBox, messageTone === 'success' ? styles.messageSuccess : styles.messageDanger]}>
              <Ionicons
                name={messageTone === 'success' ? 'checkmark-circle' : 'alert-circle'}
                size={16}
                color={messageTone === 'success' ? colors.success : colors.danger}
              />
              <Text style={[styles.messageText, messageTone === 'success' && styles.messageTextSuccess]}>
                {message}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.diagnosticLink}
            onPress={() => setShowDiagnostic(true)}
            accessibilityRole="button"
            accessibilityLabel="Buka diagnostik keamanan"
          >
            <Ionicons name="pulse-outline" size={16} color={colors.textMuted} />
            <Text style={styles.diagnosticLinkText}>Diagnostik Keamanan</Text>
          </TouchableOpacity>

          <Text style={styles.footnote}>
            Setelah aktivasi berhasil, aplikasi dapat digunakan sepenuhnya tanpa internet. Sambungkan ke internet
            minimal sekali setiap {LICENSE_OFFLINE_GRACE_PERIOD_DAYS} hari agar lisensi tetap terverifikasi.
          </Text>
          <Text style={styles.deviceId} selectable>
            ID Perangkat: {maskDeviceId(status.deviceId)}
          </Text>
        </ScrollView>
      </AreaAmanKeyboard>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, alignItems: 'center' },
  logoCircle: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, textAlign: 'center' },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  noticeBox: {
    flexDirection: 'row',
    gap: spacing.md,
    width: '100%',
    padding: spacing.lg,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
  },
  noticeDanger: { backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: colors.danger },
  noticeWarn: { backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder },
  noticeTextWrap: { flex: 1 },
  noticeTitle: { fontSize: typography.body, fontWeight: '700', color: colors.text, marginBottom: 2 },
  noticeBody: { fontSize: typography.caption, color: colors.textMuted, lineHeight: 18 },
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldHint: {
    width: '100%',
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 16,
    marginTop: spacing.sm,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    width: '100%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  secondaryButtonText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  statusLine: { marginTop: spacing.md, fontSize: 12, color: colors.textMuted },
  messageBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
    padding: spacing.md,
    borderRadius: radius.sm,
    marginTop: spacing.lg,
  },
  messageDanger: { backgroundColor: colors.dangerBg },
  messageSuccess: { backgroundColor: colors.primaryLight },
  messageText: { flex: 1, fontSize: 12, color: colors.danger },
  messageTextSuccess: { color: colors.success },
  diagnosticLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  diagnosticLinkText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  footnote: {
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: spacing.xl,
    lineHeight: 16,
  },
  deviceId: { fontSize: 10, color: colors.textFaint, marginTop: spacing.md, textAlign: 'center' },
});
