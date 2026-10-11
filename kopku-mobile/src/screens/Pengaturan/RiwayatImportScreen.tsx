import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ambilDaftarRiwayatImport,
  ambilLogRiwayatImport,
  LABEL_FILTER_LOG,
  LABEL_STATUS_RIWAYAT,
  KETERANGAN_STATUS_RIWAYAT,
  saringLogRiwayat,
  type BarisLogRiwayat,
  type FilterLogRiwayat,
  type RingkasanRiwayatImport,
  type StatusRiwayatImport,
} from '@/services/ImportDataAwalService';
import { LABEL_SHEET } from '@/import/ExcelDataAwalParser';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import EmptyState from '@/components/report/EmptyState';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui } from '@/theme/ui';

/**
 * RC-S100 — RIWAYAT HASIL IMPORT DATA AWAL.
 *
 * Permintaan pengguna: "riwayat hasil import data awal menampilkan log
 * berhasil dan error".
 *
 * MASALAH YANG DISELESAIKAN: hasil import sebelumnya hanya hidup di
 * layar Import selama layar itu terbuka. Begitu ditinggalkan, daftar
 * baris yang gagal beserta alasannya hilang — padahal justru itulah yang
 * dibutuhkan untuk memperbaiki berkas Excel-nya, dan import data awal
 * biasanya dilakukan berulang sampai bersih.
 *
 * Satu import = satu kartu yang bisa dibuka. Di dalamnya log per baris
 * dengan penyaring Semua/Berhasil/Gagal. Log dimuat sekali per import,
 * lalu penyaringannya MURNI di memori (`saringLogRiwayat`) — berpindah
 * tab tidak menyentuh database lagi.
 *
 * Layar ini TIDAK memuat aturan apa pun: status & label berasal dari
 * `RiwayatImportPlan`, pembacaan dari `RiwayatImportRepository`.
 */
export default function RiwayatImportScreen() {
  const [daftar, setDaftar] = useState<RingkasanRiwayatImport[] | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terbuka, setTerbuka] = useState<string | null>(null);

  const muat = useCallback(() => {
    void (async () => {
      setMemuat(true);
      setError(null);
      try {
        setDaftar(await ambilDaftarRiwayatImport());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setMemuat(false);
      }
    })();
  }, []);

  useFocusRefresh(muat, [muat]);

  if (memuat && !daftar) {
    return (
      <View style={styles.tengah}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.intro}>
        Setiap kali Import Data Awal dijalankan, hasilnya dicatat di sini beserta log per baris — termasuk baris yang
        gagal dan alasannya, supaya berkas Excel bisa diperbaiki tanpa menebak.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {!error && daftar && daftar.length === 0 && (
        <EmptyState message="Belum ada import data awal yang tercatat." />
      )}

      {daftar?.map((r) => (
        <KartuRiwayat
          key={r.id}
          riwayat={r}
          terbuka={terbuka === r.id}
          onToggle={() => setTerbuka((t) => (t === r.id ? null : r.id))}
        />
      ))}
    </ScrollView>
  );
}

const WARNA_STATUS: Record<StatusRiwayatImport, string> = {
  BERHASIL: colors.success,
  SEBAGIAN: colors.warning,
  GAGAL: colors.danger,
};

const IKON_STATUS: Record<StatusRiwayatImport, keyof typeof Ionicons.glyphMap> = {
  BERHASIL: 'checkmark-circle',
  SEBAGIAN: 'alert-circle',
  GAGAL: 'close-circle',
};

/** Waktu lokal lengkap — jam ASLI saat import dijalankan (lihat KonteksCatatRiwayat). */
function formatWaktu(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });
}

function KartuRiwayat({
  riwayat,
  terbuka,
  onToggle,
}: {
  riwayat: RingkasanRiwayatImport;
  terbuka: boolean;
  onToggle: () => void;
}) {
  const [log, setLog] = useState<BarisLogRiwayat[] | null>(null);
  const [memuatLog, setMemuatLog] = useState(false);
  const [filter, setFilter] = useState<FilterLogRiwayat>('SEMUA');
  const [errorLog, setErrorLog] = useState<string | null>(null);

  const buka = () => {
    onToggle();
    // Dimuat sekali, lalu disimpan: menutup & membuka kartu yang sama
    // tidak mengulang kueri, dan penyaringan tidak menyentuh database.
    if (!terbuka && log === null && !memuatLog) {
      setMemuatLog(true);
      setErrorLog(null);
      void ambilLogRiwayatImport(riwayat.id)
        .then(setLog)
        .catch((e) => setErrorLog(e instanceof Error ? e.message : String(e)))
        .finally(() => setMemuatLog(false));
    }
  };

  const warna = WARNA_STATUS[riwayat.status];
  const logTampil = log ? saringLogRiwayat(log, filter) : [];
  const jumlahGagal = log ? log.filter((b) => b.status === 'GAGAL').length : riwayat.totalGagal;

  return (
    <View style={[styles.kartu, { borderLeftColor: warna }]}>
      <TouchableOpacity style={styles.kartuHeader} onPress={buka} accessibilityRole="button">
        <Ionicons name={IKON_STATUS[riwayat.status]} size={20} color={warna} />
        <View style={{ flex: 1 }}>
          <Text style={styles.kartuJudul}>{LABEL_STATUS_RIWAYAT[riwayat.status]}</Text>
          <Text style={styles.kartuWaktu}>{formatWaktu(riwayat.dijalankanPada)}</Text>
          <Text style={styles.kartuBerkas} numberOfLines={1}>
            {riwayat.namaBerkas ?? 'Nama berkas tidak tercatat'}
          </Text>
        </View>
        <Ionicons
          name={terbuka ? 'chevron-up' : 'chevron-down'}
          size={iconSize.md}
          color={colors.textFaint}
        />
      </TouchableOpacity>

      <View style={styles.angkaBaris}>
        <Angka label="Baris" nilai={riwayat.totalBaris} />
        <Angka label="Berhasil" nilai={riwayat.totalBerhasil} warna={colors.success} />
        <Angka label="Gagal" nilai={riwayat.totalGagal} warna={riwayat.totalGagal > 0 ? colors.danger : undefined} />
        {(riwayat.totalDilewati ?? 0) > 0 ? (
          <Angka label="Dilewati" nilai={riwayat.totalDilewati ?? 0} warna={colors.warning} />
        ) : null}
      </View>

      {riwayat.status !== 'BERHASIL' && (
        <Text style={[styles.catatanStatus, { color: warna }]}>{KETERANGAN_STATUS_RIWAYAT[riwayat.status]}</Text>
      )}

      {terbuka && (
        <View style={styles.isi}>
          {riwayat.perSheet.length > 0 && (
            <>
              <Text style={styles.subJudul}>Per Jenis Data</Text>
              {riwayat.perSheet.map((s) => (
                <View key={s.jenis} style={styles.sheetBaris}>
                  <Text style={styles.sheetLabel}>{s.label || LABEL_SHEET[s.jenis as never] || s.jenis}</Text>
                  <Text style={styles.sheetAngka}>
                    <Text style={{ color: colors.success }}>{s.berhasil} berhasil</Text>
                    {'  ·  '}
                    <Text style={{ color: s.gagal > 0 ? colors.danger : colors.textFaint }}>{s.gagal} gagal</Text>
                    {(s.dilewati ?? 0) > 0 ? (
                      <Text style={{ color: colors.warning }}>{`  ·  ${s.dilewati} dilewati`}</Text>
                    ) : null}
                  </Text>
                </View>
              ))}
            </>
          )}

          {/* RC-S133.6.2 — baris yang dilewati karena sudah pernah diimpor
              (disimpan di ringkasan riwayat, bukan di log per baris). */}
          {riwayat.perSheet.some((s) => (s.rincianDilewati?.length ?? 0) > 0) && (
            <>
              <Text style={[styles.subJudul, { marginTop: spacing.md }]}>Dilewati (sudah pernah diimpor)</Text>
              {riwayat.perSheet.flatMap((s) =>
                (s.rincianDilewati ?? []).map((d) => (
                  <View key={`${s.jenis}-${d.baris}`} style={styles.logBaris}>
                    <View style={[styles.logTanda, { backgroundColor: colors.warning }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.logKepala}>
                        {LABEL_SHEET[s.jenis as never] ?? s.jenis} · baris {d.baris}
                      </Text>
                      <Text style={styles.logKeterangan}>{d.keterangan}</Text>
                      <Text style={[styles.logPesan, { color: colors.textMuted }]}>{d.pesan}</Text>
                    </View>
                  </View>
                ))
              )}
            </>
          )}

          <Text style={[styles.subJudul, { marginTop: spacing.md }]}>Log Per Baris</Text>

          <View style={styles.filterBaris}>
            {(['SEMUA', 'GAGAL', 'BERHASIL'] as FilterLogRiwayat[]).map((f) => (
              <TouchableOpacity
                key={f}
                style={[styles.chip, filter === f && styles.chipAktif]}
                onPress={() => setFilter(f)}
              >
                <Text style={[styles.chipText, filter === f && styles.chipTextAktif]}>
                  {LABEL_FILTER_LOG[f]}
                  {f === 'GAGAL' && jumlahGagal > 0 ? ` (${jumlahGagal})` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {memuatLog && <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />}
          {errorLog && <Text style={styles.error}>{errorLog}</Text>}

          {!memuatLog && !errorLog && logTampil.length === 0 && (
            <Text style={styles.kosong}>
              {filter === 'GAGAL' ? 'Tidak ada baris yang gagal.' : 'Tidak ada baris untuk penyaring ini.'}
            </Text>
          )}

          {logTampil.map((b) => (
            <View key={b.id} style={styles.logBaris}>
              <View style={[styles.logTanda, { backgroundColor: b.status === 'GAGAL' ? colors.danger : colors.success }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.logKepala}>
                  {LABEL_SHEET[b.jenisSheet as never] ?? b.jenisSheet} · baris {b.baris}
                </Text>
                <Text style={styles.logKeterangan}>{b.keterangan}</Text>
                {b.pesan ? <Text style={styles.logPesan}>{b.pesan}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Angka({ label, nilai, warna }: { label: string; nilai: number; warna?: string }) {
  return (
    <View style={styles.angka}>
      <Text style={[styles.angkaNilai, warna ? { color: warna } : null]}>{nilai.toLocaleString('id-ID')}</Text>
      <Text style={styles.angkaLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  intro: { ...ui.screenIntro },
  error: { color: colors.danger, fontSize: 12, marginVertical: spacing.sm },

  kartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  kartuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: spacing.sm,
  },
  kartuJudul: { fontSize: 13, fontWeight: '800', color: colors.text },
  kartuWaktu: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  kartuBerkas: { fontSize: 11, color: colors.textFaint, marginTop: 1 },

  angkaBaris: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.lg },
  angka: { alignItems: 'flex-start' },
  angkaNilai: { fontSize: 15, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  angkaLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },

  catatanStatus: {
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },

  isi: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md },
  subJudul: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: spacing.xs,
  },
  sheetBaris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  sheetLabel: { flex: 1, fontSize: 12, color: colors.text },
  sheetAngka: { fontSize: 11, fontWeight: '700' },

  filterBaris: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text, fontWeight: '600' },
  chipTextAktif: { color: colors.white },

  kosong: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: spacing.sm },

  logBaris: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logTanda: { width: 3, borderRadius: 2, alignSelf: 'stretch' },
  logKepala: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  logKeterangan: { fontSize: 12, color: colors.text, marginTop: 1 },
  logPesan: { fontSize: 11, color: colors.danger, marginTop: 2, lineHeight: 15 },
});
