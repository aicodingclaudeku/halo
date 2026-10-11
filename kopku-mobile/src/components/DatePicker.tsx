import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getWaktuSekarang } from '@/services/DevClockService';

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromIso(s?: string): Date {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // RC-S95 — field kosong membuka kalender di "hari ini" JAM APLIKASI
  // (ikut Mode Pengujian Waktu), bukan jam asli perangkat.
  return getWaktuSekarang();
}

/** Akhir hari (23:59:59.999) dari tanggal ISO — batas maksimum yang tetap mengizinkan memilih hari itu sendiri. */
function akhirHari(iso: string): Date {
  const d = fromIso(iso);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function formatTanggalIndonesia(s?: string): string {
  if (!s) return 'Pilih tanggal';
  const d = fromIso(s);
  return `${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

const formatLabel = formatTanggalIndonesia;

/**
 * Input tanggal dengan native date picker — menggantikan TextInput
 * bebas "YYYY-MM-DD" yang sebelumnya dipakai (rawan salah format/typo
 * dan tidak nyaman diketik manual). Value yang dikembalikan tetap
 * string ISO "YYYY-MM-DD" supaya kompatibel dengan skema/validasi yang
 * sudah ada, tampilannya saja yang diformat gaya Indonesia.
 */
export default function DatePicker({
  value,
  onChange,
  error,
  maximumDate,
  minimumDate,
}: {
  value?: string;
  onChange: (isoDate: string) => void;
  error?: string;
  maximumDate?: Date;
  minimumDate?: Date;
}) {
  const [open, setOpen] = useState(false);

  // ============================================================
  // BUG FIX — kalender "melompat kembali" ke bulan terpilih
  // ============================================================
  // Laporan pengguna: di layar Developer, saat kalender dibuka lalu
  // digeser dari November ke Desember, tampilannya kembali sendiri ke
  // November.
  //
  // AKAR MASALAH (dibaca dari source @react-native-community/datetimepicker
  // 8.4.4, `datetimepicker.android.js`): dialog Android dibuka lewat
  // `useEffect(..., [onChange, valueTimestamp, mode])`. Setiap kali
  // identitas `onChange` BERUBAH, efek itu memanggil
  // `DateTimePickerAndroid.open()` LAGI dengan `value` = tanggal terpilih,
  // sehingga bulan yang sedang dijelajahi pengguna di-reset. Sebelumnya
  // `handleChange` di bawah dibuat ULANG pada SETIAP render, jadi layar
  // induk mana pun yang me-render ulang saat kalender terbuka (layar
  // Developer me-render ulang tiap detik untuk jam berjalan) langsung
  // me-reset kalender. Di iOS (tampilan inline) objek `Date` baru di
  // setiap render juga membuat tampilan bulan berpotensi di-reset.
  //
  // PERBAIKAN: `handleChange` dibuat SEKALI (useCallback tanpa deps) dan
  // membaca `onChange` terbaru lewat ref; objek `Date` di-memo pada string
  // ISO-nya. Dengan begitu kalender hanya di-reset bila TANGGAL TERPILIH
  // benar-benar berubah — bukan karena induk sekadar me-render ulang.
  // API komponen (props & nilai ISO yang dikembalikan) TIDAK berubah.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const handleChange = useCallback((event: any, selected?: Date) => {
    // Desktop (web): kalender modal juga menutup sendiri setelah memilih/batal.
    if (Platform.OS === 'android' || Platform.OS === 'web') setOpen(false);
    if (event.type === 'dismissed') return;
    if (selected) onChangeRef.current(toIso(selected));
  }, []);

  const nilaiTanggal = useMemo(() => fromIso(value), [value]);

  // RC-S95 — batas tanggal dinormalkan ke tingkat HARI dan di-memo.
  // Hampir semua form memberi `maximumDate={getWaktuSekarang()}`, yaitu
  // objek Date BARU (dengan jam/detik berbeda) di setiap render. Menormalkan
  // ke tanggal membuat identitasnya stabil sepanjang hari yang sama —
  // alasan yang sama dengan `nilaiTanggal` di atas — dan membuat batas
  // maksimum selalu inklusif untuk hari itu (akhir hari), apa pun jam saat
  // objeknya dibuat.
  const kunciMaks = maximumDate ? toIso(maximumDate) : undefined;
  const kunciMin = minimumDate ? toIso(minimumDate) : undefined;
  const batasMaks = useMemo(() => (kunciMaks ? akhirHari(kunciMaks) : undefined), [kunciMaks]);
  const batasMin = useMemo(() => (kunciMin ? fromIso(kunciMin) : undefined), [kunciMin]);

  return (
    <View>
      <TouchableOpacity accessibilityRole="button" style={[styles.field, error && styles.fieldError]} onPress={() => setOpen(true)}>
        {/*
          UI/UX FINAL POLISH (§14) — pola picker tanggal: [CALENDAR] DATE
          chevron-down. Sebelumnya ikon kalender muncul DUA KALI (kiri dan
          kanan), sehingga tidak ada penanda "ini dapat dibuka" yang
          membedakannya dari label biasa; kalender di kanan diganti
          chevron seperti picker lain. Opsi, handler, dan nilai ISO yang
          dikembalikan tidak berubah.
        */}
        <Ionicons
          name="calendar-outline"
          size={iconSize.md - 2}
          color={error ? colors.danger : colors.textMuted}
          style={styles.leadIcon}
        />
        <Text style={[styles.text, !value && styles.placeholder]}>{formatLabel(value)}</Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {!!error && (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={iconSize.sm - 2} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {open && (
        <DateTimePicker
          value={nilaiTanggal}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={handleChange}
          maximumDate={batasMaks}
          minimumDate={batasMin}
        />
      )}

      {open && Platform.OS === 'ios' && (
        <TouchableOpacity style={styles.doneButton} onPress={() => setOpen(false)}>
          <Text style={styles.doneText}>Selesai</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** UI/UX REDESIGN — penanda visual bahwa field ini dapat dibuka (tidak mengubah onPress/opsi). */
const pickerAffordance = { flexShrink: 0 };

const styles = StyleSheet.create({
  field: { gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  fieldError: { borderColor: colors.danger },
  text: { flex: 1, fontSize: 15, color: colors.text },
  placeholder: { color: colors.placeholder },
  leadIcon: { ...formUi.inputIcon },
  errorRow: { ...formUi.errorRow },
  errorText: { ...formUi.errorText },
  doneButton: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 4 },
  doneText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
});
