import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import { gateHeader } from '@/theme/ui';
import { verifyLicense, type LicenseStatus } from '@/services/LicenseService';
import { maskDeviceId } from '@/security/deviceId';
import LicenseDiagnosticScreen from './LicenseDiagnosticScreen';

/**
 * Status lisensi untuk perangkat yang SUDAH aktif.
 *
 * ---------------------------------------------------------------------
 * KENAPA TIDAK ADA TOMBOL "NONAKTIFKAN" DI SINI (RC-S37)
 * ---------------------------------------------------------------------
 * Versi sebelumnya menyediakan self-deactivate agar pengguna dapat
 * memindahkan lisensi ke perangkat baru sendiri. Itu keliru untuk model
 * lisensi ini: lisensi terikat pada License Key + Perangkat + Koperasi,
 * dan self-deactivate memberi pengguna cara melepas ikatan itu lalu
 * memasangnya kembali dengan koperasi yang berbeda.
 *
 * Pelepasan slot perangkat sekarang menjadi kewenangan penerbit lewat
 * panel admin. Layar ini hanya MEMBACA status dan memungkinkan
 * verifikasi ulang; tidak ada aksi di sini yang mengubah ikatan lisensi.
 *
 * `deactivateLicense()` di LicenseService SENGAJA DIPERTAHANKAN — ia
 * masih dibutuhkan lifecycle server dan diuji, tetapi TIDAK BOLEH punya
 * pemanggil dari UI pengguna. Ada test struktural yang menjaga itu.
 *
 * ---------------------------------------------------------------------
 * UI/UX FINAL POLISH — HIERARKI TAMPILAN (§4)
 * ---------------------------------------------------------------------
 * Sebelumnya layar ini adalah satu kartu berisi tujuh baris label-nilai
 * yang semuanya setara: tanggal kedaluwarsa dan ID perangkat tampil
 * dengan bobot visual yang sama, sehingga informasi terpenting
 * ("lisensi ini sah sampai kapan") harus dicari.
 *
 * Sekarang urutannya eksplisit:
 *   LICENSE STATUS  -> kartu status besar (ikon + keadaan + koperasi)
 *   MASA BERLAKU    -> kartu tersendiri: berlaku sampai & wajib online
 *   INFORMASI       -> detail lisensi (tipe, aktivasi, verifikasi, ID)
 *   AKSI            -> verifikasi sekarang + diagnostik
 *
 * Yang TIDAK berubah: `verifyLicense()`, isi `status`, perhitungan masa
 * berlaku/grace, teks Alert, dan `onChanged()`. Fungsi `formatDate` dan
 * `formatGrace` tetap persis seperti sebelumnya.
 */

interface Props {
  readonly status: LicenseStatus;
  readonly onChanged: () => void;
  readonly onBack?: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatGrace(remainingMs: number | null): string {
  if (remainingMs === null) return 'Belum pernah diverifikasi';
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days} hari ${hours} jam lagi`;
  return `${hours} jam lagi`;
}

export default function LicenseInfoScreen({ status, onChanged, onBack }: Props) {
  const [busy, setBusy] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);

  const handleVerify = useCallback(async () => {
    setBusy(true);
    const result = await verifyLicense();
    setBusy(false);
    Alert.alert(
      result.ok ? 'Verifikasi Berhasil' : 'Verifikasi Gagal',
      result.ok ? 'Lisensi terkonfirmasi oleh server.' : result.message
    );
    onChanged();
  }, [onChanged]);

  if (showDiagnostic) {
    return <LicenseDiagnosticScreen onBack={() => setShowDiagnostic(false)} />;
  }

  // MURNI TAMPILAN: `serverVerificationDue` sudah dihitung
  // LicenseService; di sini ia hanya memilih warna & teks, tidak
  // memutuskan apa pun.
  const perluOnline = status.serverVerificationDue;
  const tanpaBatas = status.expiresAt === null;

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerBar}>
          {onBack && (
            <TouchableOpacity
              style={styles.headerBack}
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel="Kembali"
            >
              <Ionicons name="arrow-back" size={iconSize.lg} color={colors.text} />
            </TouchableOpacity>
          )}
          <Text style={[styles.headerTitle, !onBack && styles.headerTitleNoBack]} numberOfLines={2} accessibilityRole="header">
            Lisensi
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/* ---------------- LICENSE STATUS ---------------- */}
        <Text style={styles.sectionLabel}>Status Lisensi</Text>
        <View style={styles.statusCard}>
          <View style={styles.statusIcon}>
            <Ionicons name="shield-checkmark" size={26} color={colors.success} />
          </View>
          <View style={styles.statusBody}>
            <Text style={styles.statusTitle}>Lisensi Aktif</Text>
            <Text style={styles.statusSub} numberOfLines={3}>
              {status.cooperativeName ?? 'Koperasi belum tercatat'}
            </Text>
          </View>
        </View>

        {/* ---------------- MASA BERLAKU ---------------- */}
        <Text style={styles.sectionLabel}>Masa Berlaku</Text>
        <View style={styles.card}>
          <View style={styles.expiryRow}>
            <Ionicons name="calendar-outline" size={iconSize.md} color={colors.textMuted} style={styles.expiryIcon} />
            <View style={styles.expiryBody}>
              <Text style={styles.expiryLabel}>Berlaku Sampai</Text>
              <Text style={styles.expiryValue} numberOfLines={3}>
                {tanpaBatas ? 'Tanpa batas waktu' : formatDate(status.expiresAt)}
              </Text>
            </View>
          </View>
          <View style={styles.divider} />
          <View style={styles.expiryRow}>
            <Ionicons
              name={perluOnline ? 'cloud-offline-outline' : 'cloud-done-outline'}
              size={iconSize.md}
              color={perluOnline ? colors.warning : colors.textMuted}
              style={styles.expiryIcon}
            />
            <View style={styles.expiryBody}>
              <Text style={styles.expiryLabel}>Wajib Online Sebelum</Text>
              <Text style={[styles.expiryValue, perluOnline && styles.expiryValueWarn]} numberOfLines={3}>
                {formatGrace(status.graceRemainingMs)}
              </Text>
            </View>
          </View>
        </View>

        {/* ---------------- INFORMASI ---------------- */}
        <Text style={styles.sectionLabel}>Informasi</Text>
        <View style={styles.card}>
          <Row label="Tipe Lisensi" value={status.licenseType ?? '—'} />
          <Row label="Diaktivasi" value={formatDate(status.activatedAt)} />
          <Row
            label="Verifikasi Terakhir"
            value={status.lastVerifiedAtMs ? formatDate(new Date(status.lastVerifiedAtMs).toISOString()) : '—'}
          />
          <Row label="ID Perangkat" value={maskDeviceId(status.deviceId)} mono last />
        </View>

        {status.clockRollbackDetected && (
          <View style={styles.warnBox}>
            <Ionicons name="alarm-outline" size={iconSize.md} color={colors.warning} />
            <Text style={styles.warnText}>
              Jam perangkat terdeteksi mundur. Setel tanggal &amp; waktu ke otomatis agar verifikasi lisensi berjalan
              normal.
            </Text>
          </View>
        )}

        {/* ---------------- AKSI ---------------- */}
        <Text style={styles.sectionLabel}>Aksi</Text>
        <TouchableOpacity
          style={[styles.secondaryButton, busy && styles.disabled]}
          onPress={handleVerify}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Verifikasi lisensi sekarang"
          accessibilityState={{ disabled: busy }}
        >
          {busy ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              <Ionicons name="refresh" size={iconSize.md} color={colors.primary} />
              <Text style={styles.secondaryText}>Verifikasi Sekarang</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.diagnosticButton}
          onPress={() => setShowDiagnostic(true)}
          accessibilityRole="button"
          accessibilityLabel="Buka diagnostik keamanan"
        >
          <Ionicons name="pulse-outline" size={iconSize.md} color={colors.textMuted} />
          <Text style={styles.diagnosticText}>Diagnostik Keamanan</Text>
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={styles.chevron} />
        </TouchableOpacity>

        <Text style={styles.footnote}>
          Lisensi ini terikat pada perangkat dan koperasi Anda. Untuk memindahkannya ke perangkat lain,
          hubungi penerbit aplikasi.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]} selectable numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  header: { ...gateHeader.wrap },
  headerBar: { ...gateHeader.bar },
  headerBack: { ...gateHeader.backBtn },
  headerTitle: { ...gateHeader.title },
  headerTitleNoBack: { ...gateHeader.titleNoBack },
  container: { padding: spacing.lg, paddingBottom: spacing.xl },
  sectionLabel: {
    fontSize: typography.caption,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  statusIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statusBody: { flex: 1, minWidth: 0 },
  statusTitle: { fontSize: 16, fontWeight: '700', color: colors.success, lineHeight: 22 },
  statusSub: { fontSize: typography.subtitle, color: colors.textMuted, lineHeight: 18, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  expiryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md },
  expiryIcon: { flexShrink: 0, marginTop: 2 },
  expiryBody: { flex: 1, minWidth: 0 },
  expiryLabel: { fontSize: typography.caption, color: colors.textMuted },
  expiryValue: { fontSize: 15, fontWeight: '700', color: colors.text, lineHeight: 20, marginTop: 2 },
  expiryValueWarn: { color: colors.warning },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { fontSize: typography.caption, color: colors.textMuted, flexShrink: 1, minWidth: 0 },
  rowValue: {
    fontSize: typography.subtitle,
    color: colors.text,
    fontWeight: '600',
    flexShrink: 1,
    maxWidth: '62%',
    textAlign: 'right',
  },
  rowValueMono: { fontSize: 11, fontWeight: '400' },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  warnText: { flex: 1, minWidth: 0, fontSize: typography.caption, color: colors.text, lineHeight: 18 },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  secondaryText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.55 },
  diagnosticButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  diagnosticText: { flex: 1, minWidth: 0, fontSize: typography.subtitle, color: colors.text, fontWeight: '600' },
  chevron: { flexShrink: 0 },
  footnote: {
    fontSize: 11,
    color: colors.textFaint,
    marginTop: spacing.lg,
    lineHeight: 16,
    textAlign: 'center',
  },
});
