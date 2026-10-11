import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { listAccountingPeriods, AccountingPeriodItem } from '@/repositories/PeriodeRepository';
import DatePicker from '@/components/DatePicker';
import { colors, radius, spacing } from '@/theme/colors';
import { resolveReportPeriodFromDate, ResolvedReportPeriod } from '@/utils/reportPeriod';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

export type { ResolvedReportPeriod };

interface ReportPeriodPickerProps {
  onChange: (period: ResolvedReportPeriod) => void;
  value?: ResolvedReportPeriod | null;
}

/**
 * Selector periode laporan — SATU tanggal saja (update pasca-Phase
 * 18/19, permintaan pengguna §J/§S). Sebelumnya 3 mode Tahun/Bulan/
 * Tanggal dengan chip terpisah; SEKARANG hanya `DatePicker` tunggal +
 * kartu "UNTUK PERIODE" menampilkan tanggal format Indonesia, sesuai
 * mockup yang diminta. Tanggal terpilih otomatis dipasangkan dengan
 * awal tahun buku (accounting_period) yang memuatnya lewat
 * `resolveReportPeriodFromDate()` — laporan tetap year-to-date sampai
 * tanggal tsb, TANPA field "Dari"/"Sampai" bebas. Dipakai SATU
 * komponen yang sama oleh SELURUH laporan utama (Laba Rugi/Hasil
 * Usaha, Perubahan Ekuitas, Arus Kas, CALK) & Kolektibilitas Piutang —
 * export memakai tanggal yang sama (`period.selesai`/`period.label`).
 * Query laporan (`getLabaRugi`, dst) TIDAK diubah sama sekali — tetap
 * menerima (mulai, selesai) seperti sebelumnya.
 */
export default function ReportPeriodPicker({ onChange, value }: ReportPeriodPickerProps) {
  const [periods, setPeriods] = useState<AccountingPeriodItem[]>([]);
  const [tanggal, setTanggal] = useState<string>(value?.selesai ?? getTanggalLokalHariIni());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const rows = await listAccountingPeriods();
        setPeriods(rows);
        onChange(resolveReportPeriodFromDate(tanggal, rows));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat periode akuntansi.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pilihTanggal = (t: string) => {
    setTanggal(t);
    onChange(resolveReportPeriodFromDate(t, periods));
  };

  if (error) {
    return <Text style={styles.errorText}>{error}</Text>;
  }

  return (
    <View style={{ marginBottom: spacing.md }}>
      <DatePicker value={tanggal} onChange={pilihTanggal} maximumDate={getWaktuSekarang()} />
    </View>
  );
}

const styles = StyleSheet.create({
  errorText: { color: colors.danger, fontSize: 12, marginBottom: 8 },
});
