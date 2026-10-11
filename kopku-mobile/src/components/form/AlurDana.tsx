import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, radius, spacing, touchTarget, typography } from '@/theme/colors';

export interface SimpulDana {
  ikon: keyof typeof Ionicons.glyphMap;
  /** Nama rekening terpilih; kosong = belum dipilih (tampil `placeholder`). */
  nama?: string;
  placeholder: string;
  /** Saldo saat ini, sudah terformat. */
  saldo?: string;
  /** Saldo sesudah transaksi, sudah terformat. Tampil hanya bila nominal sudah diisi. */
  saldoSetelah?: string;
  /** Tandai saldo sesudah sebagai bermasalah (mis. minus). */
  saldoSetelahBermasalah?: boolean;
}

/**
 * RC-S122 — ALUR DANA (presentasi murni).
 *
 * Kartu pembuka untuk transaksi yang MEMINDAHKAN uang antar rekening
 * (Penarikan dari Bank, Pemindahan Saldo Rekening). Yang ditunjukkan:
 * dari mana, ke mana, berapa, dan saldo masing-masing sebelum & sesudah —
 * pertanyaan yang memang ditanyakan petugas sebelum menekan Simpan.
 *
 * Semua angka datang SUDAH terformat dari layar pemanggil; komponen ini
 * tidak menghitung saldo dan tidak memvalidasi. Tombol tukar hanya muncul
 * bila pemanggil memberi `onTukar`.
 */
export default function AlurDana({
  dari,
  ke,
  nominal,
  onTukar,
}: {
  dari: SimpulDana;
  ke: SimpulDana;
  /** Nominal terformat; kosong = belum diisi. */
  nominal?: string;
  onTukar?: () => void;
}) {
  return (
    <View style={styles.kartu}>
      <Simpul peran="Dari" s={dari} />

      <View style={styles.penghubung}>
        <View style={styles.garis} />
        <View style={styles.panahKolom}>
          <View style={styles.panah}>
            <Ionicons name="arrow-down" size={14} color={colors.white} />
          </View>
        </View>
        <View style={[styles.nominalPil, !nominal && styles.nominalPilKosong]}>
          <Text style={[styles.nominalTeks, !nominal && styles.nominalTeksKosong]} numberOfLines={1}>
            {nominal ?? 'Nominal belum diisi'}
          </Text>
        </View>
        {onTukar ? (
          <TouchableOpacity
            style={styles.tukar}
            onPress={onTukar}
            accessibilityRole="button"
            accessibilityLabel="Tukar rekening sumber dan tujuan"
          >
            <Ionicons name="swap-vertical" size={18} color={colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>

      <Simpul peran="Ke" s={ke} />
    </View>
  );
}

function Simpul({ peran, s }: { peran: string; s: SimpulDana }) {
  const terpilih = !!s.nama;
  return (
    <View style={styles.simpul}>
      <View style={[styles.ikon, !terpilih && styles.ikonKosong]}>
        <Ionicons name={s.ikon} size={18} color={terpilih ? colors.primary : colors.textFaint} />
      </View>
      <View style={styles.simpulIsi}>
        <Text style={styles.peran}>{peran}</Text>
        <Text style={[styles.nama, !terpilih && styles.namaKosong]} numberOfLines={2}>
          {s.nama ?? s.placeholder}
        </Text>
        {terpilih && s.saldo ? (
          <View style={styles.saldoBaris}>
            <Text style={styles.saldo}>Saldo {s.saldo}</Text>
            {s.saldoSetelah ? (
              <>
                <Ionicons name="arrow-forward" size={12} color={colors.textFaint} />
                <Text style={[styles.saldoSetelah, s.saldoSetelahBermasalah && styles.saldoBermasalah]}>
                  {s.saldoSetelah}
                </Text>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const LEBAR_IKON = 40;

const styles = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  simpul: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  ikon: {
    width: LEBAR_IKON,
    height: LEBAR_IKON,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  ikonKosong: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  simpulIsi: { flex: 1, minWidth: 0 },
  peran: { fontSize: 11.5, color: colors.textMuted, fontWeight: '600' },
  nama: { fontSize: typography.body, fontWeight: '700', color: colors.text, lineHeight: 19, marginTop: 1 },
  namaKosong: { color: colors.textFaint, fontWeight: '500' },
  saldoBaris: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: 3 },
  saldo: { fontSize: typography.caption, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  saldoSetelah: { fontSize: typography.caption, color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  saldoBermasalah: { color: colors.danger },
  penghubung: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget + 4,
    marginVertical: spacing.xs,
  },
  // Garis vertikal tipis di bawah ikon "Dari", dari tengah ikon.
  garis: {
    position: 'absolute',
    left: LEBAR_IKON / 2 - 1,
    top: -spacing.xs,
    bottom: -spacing.xs,
    width: 2,
    backgroundColor: colors.border,
  },
  panahKolom: { width: LEBAR_IKON, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  panah: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nominalPil: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  nominalPilKosong: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  nominalTeks: { color: colors.white, fontWeight: '700', fontSize: 15, fontVariant: ['tabular-nums'] },
  nominalTeksKosong: { color: colors.textMuted, fontWeight: '500', fontSize: typography.caption },
  tukar: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: touchTarget / 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
