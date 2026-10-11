import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { runEd25519SelfTest, type Ed25519SelfTestResult } from '@/security/ed25519SelfTest';
import { describePublicKeyConfiguration } from '@/security/publicKeyRegistry';
import { getDeviceId } from '@/security/deviceId';

/**
 * DIAGNOSTIK KRIPTOGRAFI DI PERANGKAT.
 *
 * Layar ini menjawab pertanyaan yang TIDAK bisa dijawab test Node:
 * apakah `@noble/ed25519` benar-benar bekerja di Hermes pada APK yang
 * sesungguhnya. Ia menjalankan vektor RFC 8032 beserta kasus negatifnya
 * dan menampilkan hasil per-kasus.
 *
 * Kenapa perlu layar, bukan sekadar log?
 * Karena yang menguji APK preview sering bukan orang yang bisa memasang
 * Android Studio dan membaca logcat. Layar ini membuat pemeriksaan
 * paling kritis dalam sistem lisensi bisa dilakukan siapa pun dengan
 * satu ketukan, di perangkat mana pun, tanpa kabel.
 *
 * Layar ini TIDAK bisa dipakai untuk melewati apa pun: ia hanya
 * membaca dan melaporkan. Tidak ada aksi yang mengubah state lisensi
 * di sini.
 */

interface Props {
  readonly onBack?: () => void;
}

export default function LicenseDiagnosticScreen({ onBack }: Props) {
  const [result, setResult] = useState<Ed25519SelfTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('—');

  const keyConfig = describePublicKeyConfiguration();

  const run = useCallback(async () => {
    setRunning(true);
    // Sengaja memanggil `runEd25519SelfTest` (bukan versi ber-cache):
    // tombol "Jalankan Ulang" harus benar-benar menjalankan ulang,
    // bukan menampilkan hasil lama.
    const next = await runEd25519SelfTest();
    setResult(next);
    setRunning(false);
  }, []);

  useEffect(() => {
    void run();
    void getDeviceId().then(setDeviceId);
  }, [run]);

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        {onBack && (
          <TouchableOpacity style={styles.backRow} onPress={onBack}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
            <Text style={styles.backText}>Kembali</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.title}>Diagnostik Keamanan</Text>
        <Text style={styles.subtitle}>
          Memeriksa apakah verifikasi tanda tangan Ed25519 bekerja benar pada perangkat ini.
        </Text>

        {/* --- Hasil self-test --- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Verifikasi Ed25519 (RFC 8032)</Text>

          {running && !result && (
            <View style={styles.runningRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.runningText}>Menjalankan pemeriksaan…</Text>
            </View>
          )}

          {result && (
            <>
              <View
                style={[styles.verdict, result.ok ? styles.verdictOk : styles.verdictFail]}
              >
                <Ionicons
                  name={result.ok ? 'shield-checkmark' : 'warning'}
                  size={20}
                  color={result.ok ? colors.success : colors.danger}
                />
                <Text style={[styles.verdictText, !result.ok && styles.verdictTextFail]}>
                  {result.ok ? 'LULUS' : 'GAGAL'}
                </Text>
              </View>

              <Text style={styles.summary}>{result.summary}</Text>

              {result.cases.map((testCase) => (
                <View key={testCase.name} style={styles.caseRow}>
                  <Ionicons
                    name={testCase.passed ? 'checkmark-circle' : 'close-circle'}
                    size={16}
                    color={testCase.passed ? colors.success : colors.danger}
                  />
                  <Text style={styles.caseName}>{testCase.name}</Text>
                  <Text style={styles.caseValue}>
                    {testCase.actual === null ? 'error' : String(testCase.actual)}
                  </Text>
                </View>
              ))}

              {!result.ok && (
                <View style={styles.failNotice}>
                  <Text style={styles.failNoticeText}>
                    Pustaka kriptografi tidak bekerja benar di mesin JavaScript perangkat ini.
                    Aplikasi sengaja mengunci diri daripada menerima lisensi yang tidak dapat
                    diperiksa. Laporkan hasil layar ini kepada penerbit aplikasi.
                  </Text>
                </View>
              )}
            </>
          )}

          <TouchableOpacity
            style={[styles.button, running && styles.disabled]}
            onPress={run}
            disabled={running}
          >
            {running ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Ionicons name="refresh" size={18} color={colors.primary} />
                <Text style={styles.buttonText}>Jalankan Ulang</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* --- Konfigurasi kunci --- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Kunci Verifikasi</Text>
          <Row label="Kunci sah" value={String(keyConfig.validCount)} />
          <Row label="Ditanam di source" value={String(keyConfig.hardcodedCount)} />
          {keyConfig.fingerprints.map((fingerprint) => (
            <Row key={fingerprint} label="Sidik jari" value={fingerprint} mono />
          ))}

          {keyConfig.validCount === 0 && (
            <View style={styles.failNotice}>
              <Text style={styles.failNoticeText}>
                Tidak ada kunci verifikasi yang sah. Aplikasi tidak dapat memeriksa lisensi apa pun
                dan akan menolak semua aktivasi.
              </Text>
            </View>
          )}

          {keyConfig.rejections.map((rejection, index) => (
            <View key={`${rejection.reason}-${index}`} style={styles.rejectionRow}>
              <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
              <Text style={styles.rejectionText}>
                Kunci ditolak: {describeRejection(rejection.reason)}
                {rejection.decodedLength !== undefined
                  ? ` (${rejection.decodedLength} byte, seharusnya 32)`
                  : ''}
              </Text>
            </View>
          ))}
        </View>

        {/* --- Identitas perangkat --- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Identitas Perangkat</Text>
          <Row label="ID Perangkat" value={deviceId} mono />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function describeRejection(reason: string): string {
  switch (reason) {
    case 'EMPTY':
      return 'kosong';
    case 'WRAPPED_FORMAT':
      return 'memakai format PEM/SPKI, bukan kunci mentah 32 byte';
    case 'WRONG_LENGTH':
      return 'panjang tidak sesuai';
    case 'NOT_DECODABLE':
    default:
      return 'bukan base64/base64url/hex yang sah';
  }
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]} selectable numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  backText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  runningRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  runningText: { fontSize: 13, color: colors.textMuted },
  verdict: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  verdictOk: { backgroundColor: colors.primaryLight },
  verdictFail: { backgroundColor: colors.dangerBg },
  verdictText: { fontWeight: '700', fontSize: 13, color: colors.success },
  verdictTextFail: { color: colors.danger },
  summary: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md },
  caseRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 3 },
  caseName: { flex: 1, fontSize: 12, color: colors.text },
  caseValue: { fontSize: 11, color: colors.textFaint },
  failNotice: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  failNoticeText: { fontSize: 12, color: colors.danger, lineHeight: 18 },
  rejectionRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.sm },
  rejectionText: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.sm },
  rowLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 0 },
  rowValue: { fontSize: 12, color: colors.text, fontWeight: '600', flex: 1, textAlign: 'right' },
  rowValueMono: { fontSize: 10, fontWeight: '400' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  buttonText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.5 },
});
