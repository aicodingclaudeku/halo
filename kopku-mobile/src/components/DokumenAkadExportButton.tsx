import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getAkadAwalDocumentData, getAkadUlangDocumentData } from '@/services/PinjamanService';
import { exportDokumenAkadAwalPdf, exportDokumenAkadUlangPdf, shareExportedFile, ExportedFile } from '@/services/ExportService';
import { buildDokumenAkadUlang } from '@/export/AkadUlangDocumentBuilder';
import { buildDokumenAkadAwal } from '@/export/AkadAwalDocumentBuilder';
import { formatTanggalPanjang } from '@/services/AkadUlangPresentasi';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, touchTarget } from '@/theme/colors';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Dokumen yang diekspor:
 *  - AWAL  — Dokumen Akad Pinjaman (akad awal), tersedia TANPA akad ulang.
 *  - ULANG — Dokumen Akad Ulang untuk satu event (terbaru MAUPUN historis);
 *            `akadUlangId` null = belum ada akad ulang (tombol nonaktif).
 */
export type JenisDokumenAkad = { jenis: 'AWAL' } | { jenis: 'ULANG'; akadUlangId: string | null };

interface DokumenAkadExportButtonProps {
  pinjamanId: string;
  dokumen: JenisDokumenAkad;
  label: string;
  /** 'block' = lebar penuh (aksi utama); 'compact' = di dalam kartu riwayat. */
  variant?: 'block' | 'compact';
}

function labelTanggalCetak(): string {
  // RC-S95 — tanggal DAN jam cetak dari satu sumber: jam aplikasi. Sebelumnya
  // tanggalnya sudah jam aplikasi tetapi jamnya jam asli, sehingga saat
  // Mode Pengujian Waktu aktif dokumen memuat campuran dua waktu berbeda.
  const now = getWaktuSekarang();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${formatTanggalPanjang(getTanggalLokalHariIni())}, ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

/**
 * RC-S82 — tombol export DOKUMEN AKAD (awal / ulang), PDF saja.
 *
 * SENGAJA BUKAN `ExportButton`: dokumen akad adalah dokumen administratif,
 * jadi formatnya HANYA PDF (tidak ada pilihan Excel/CSV). Export jadwal
 * dalam bentuk tabel tetap memakai `ExportButton` existing.
 *
 * Data dimuat SAAT tombol ditekan lewat loader read-only — tidak ada state
 * dokumen yang bisa basi di layar, dan export tidak pernah menulis ke
 * database. Izin export diperiksa di ExportService (mekanisme existing).
 */
export default function DokumenAkadExportButton({ pinjamanId, dokumen, label, variant = 'block' }: DokumenAkadExportButtonProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const [memproses, setMemproses] = useState(false);

  const tersedia = dokumen.jenis === 'AWAL' || !!dokumen.akadUlangId;

  const jalankan = async () => {
    if (!currentUser || memproses || !tersedia) return;
    setMemproses(true);
    try {
      const tanggalCetak = labelTanggalCetak();
      let file: ExportedFile;
      let pesan: string;
      if (dokumen.jenis === 'AWAL') {
        const data = await getAkadAwalDocumentData(pinjamanId);
        file = await exportDokumenAkadAwalPdf(currentUser.id, buildDokumenAkadAwal(data, { tanggalCetak }));
        pesan = 'Perjanjian Pinjaman berhasil dibuat.';
      } else {
        const data = await getAkadUlangDocumentData(pinjamanId, dokumen.akadUlangId as string);
        file = await exportDokumenAkadUlangPdf(currentUser.id, buildDokumenAkadUlang(data, { tanggalCetak }));
        pesan = 'Dokumen Akad Ulang berhasil dibuat.';
      }
      setMemproses(false);
      notify('Export Berhasil', `${pesan}\n${file.fileName}`, [
        { text: 'Tutup', style: 'cancel' },
        {
          text: 'Bagikan',
          onPress: () =>
            shareExportedFile(file).catch((e) =>
              notify('Gagal Membagikan', e instanceof Error ? e.message : 'Terjadi kesalahan.')
            ),
        },
      ]);
    } catch (e) {
      setMemproses(false);
      notify('Export Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan saat membuat dokumen.');
    }
  };

  const disabled = !currentUser || memproses || !tersedia;
  const block = variant === 'block';

  return (
    <TouchableOpacity
      style={[styles.button, block ? styles.buttonBlock : styles.buttonCompact, disabled && styles.buttonDisabled]}
      onPress={jalankan}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: memproses }}
    >
      {memproses ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <Ionicons name="document-text-outline" size={block ? 18 : 16} color={colors.primary} />
      )}
      <Text style={[styles.text, block && styles.textBlock]} numberOfLines={2}>
        {memproses ? 'Membuat PDF…' : label}
      </Text>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>PDF</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  buttonBlock: { alignSelf: 'stretch', justifyContent: 'center', minHeight: touchTarget, paddingHorizontal: spacing.md, paddingVertical: 10 },
  buttonCompact: { alignSelf: 'stretch', justifyContent: 'center', minHeight: 40, paddingHorizontal: spacing.md, paddingVertical: 8 },
  buttonDisabled: { opacity: 0.45 },
  text: { flexShrink: 1, color: colors.primary, fontWeight: '700', fontSize: 13 },
  textBlock: { fontSize: 14 },
  badge: { borderRadius: radius.pill, backgroundColor: colors.primaryLight, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: colors.primary, fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
});
