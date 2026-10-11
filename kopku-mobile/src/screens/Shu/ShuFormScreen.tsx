import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { notify } from '@/store/useNotifyStore';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  simpanKonfigurasiShu,
  hitungSHU,
  getShuKonfigurasiByTahun,
  ShuSudahDihitungError,
} from '@/services/ShuService';
import { listAccountingPeriods, AccountingPeriodItem } from '@/repositories/PeriodeRepository';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

import FocusTextInput from '@/components/FocusTextInput';
interface FieldPersen {
  key:
    | 'persenCadangan'
    | 'persenJasaModal'
    | 'persenJasaUsaha'
    | 'persenPendidikan'
    | 'persenSosial'
    | 'persenPengurus'
    | 'persenPengawas'
    | 'persenKaryawan'
    | 'persenPembangunanDaerahKerja'
    | 'persenCadanganRisiko';
  label: string;
}

const FIELDS: FieldPersen[] = [
  // Audit ulang (permintaan pengguna §12): label diganti "Cadangan (%)"
  // -> "Cadangan Umum (%)" — HANYA label tampilan. Field/kolom/kode
  // akun (persenCadangan / 3-2000) TIDAK berubah, nilai existing tetap.
  { key: 'persenCadangan', label: 'Cadangan Umum (%)' },
  // Audit ulang (permintaan pengguna §3, request baru): "Cadangan
  // Risiko" dipindah ke SINI — tepat di atas "Jasa Modal" — HANYA
  // urutan TAMPILAN yang berubah (posisi field di array ini menentukan
  // urutan render, lihat FIELDS.map di JSX di bawah). Persentase,
  // nominal, rumus (ShuCalculator.ts), jurnal (ShuService.ts), dan
  // total distribusi SAMA SEKALI TIDAK disentuh oleh perubahan ini.
  { key: 'persenCadanganRisiko', label: 'Cadangan Risiko (%)' },
  { key: 'persenJasaModal', label: 'Jasa Modal (%)' },
  { key: 'persenJasaUsaha', label: 'Jasa Usaha (%)' },
  { key: 'persenPendidikan', label: 'Pendidikan (%)' },
  { key: 'persenSosial', label: 'Sosial (%)' },
  { key: 'persenPengurus', label: 'Pengurus (%)' },
  { key: 'persenPengawas', label: 'Pengawas (%)' },
  // Update pasca-Phase 18/19 (permintaan pengguna §U): 2 komponen baru.
  { key: 'persenKaryawan', label: 'Karyawan (%)' },
  { key: 'persenPembangunanDaerahKerja', label: 'Pembangunan Daerah Kerja (%)' },
  // Audit ulang §5/§6/§12 (permintaan pengguna): "Lainnya (%)" DIHAPUS
  // TOTAL dari form ini — bukan lagi komponen distribusi SHU yang bisa
  // dikonfigurasi. Nilai persentase komponen LAIN di atas TIDAK diubah
  // oleh penghapusan ini — form ini tetap memuat nilai existing apa
  // adanya (lihat `useEffect` di bawah, TIDAK mengganti default dari
  // screenshot/contoh mana pun). Kalau total komponen di atas belum
  // genap 100%, validasi total di bawah akan menampilkan peringatan —
  // pengguna/admin yang harus menyesuaikan sendiri, TIDAK dinormalisasi
  // otomatis oleh aplikasi.
];

/** Form konfigurasi persentase SHU + tombol "Hitung SHU" (PRD §29). */
export default function ShuFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const tahunBukuAwal: number | undefined = route.params?.tahunBuku;

  const [periods, setPeriods] = useState<AccountingPeriodItem[]>([]);
  const [tahunBuku, setTahunBuku] = useState<number | null>(tahunBukuAwal ?? null);
  const [values, setValues] = useState<Record<FieldPersen['key'], string>>({
    persenCadangan: '',
    persenJasaModal: '',
    persenJasaUsaha: '',
    persenPendidikan: '',
    persenSosial: '',
    persenPengurus: '',
    persenPengawas: '',
    persenKaryawan: '',
    persenPembangunanDaerahKerja: '',
    persenCadanganRisiko: '',
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await listAccountingPeriods();
        setPeriods(rows);
        const targetTahun = tahunBukuAwal ?? rows[0]?.tahunBuku ?? null;
        setTahunBuku(targetTahun);

        if (targetTahun) {
          const existing = await getShuKonfigurasiByTahun(targetTahun);
          if (existing) {
            setValues({
              persenCadangan: existing.persenCadangan.toString(),
              persenJasaModal: existing.persenJasaModal.toString(),
              persenJasaUsaha: existing.persenJasaUsaha.toString(),
              persenPendidikan: existing.persenPendidikan.toString(),
              persenSosial: existing.persenSosial.toString(),
              persenPengurus: existing.persenPengurus.toString(),
              persenPengawas: existing.persenPengawas.toString(),
              persenKaryawan: existing.persenKaryawan.toString(),
              persenPembangunanDaerahKerja: existing.persenPembangunanDaerahKerja.toString(),
              persenCadanganRisiko: existing.persenCadanganRisiko.toString(),
            });
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat data periode/konfigurasi SHU.');
      } finally {
        setLoading(false);
      }
    })();
  }, [tahunBukuAwal]);

  const totalPersen = FIELDS.reduce((acc, f) => acc + (parseFloat(values[f.key]) || 0), 0);

  const jalankanPerhitungan = async (konfirmasiUlang: boolean) => {
    if (!tahunBuku || !currentUser) return;
    setError(null);

    if (Math.abs(totalPersen - 100) > 0.01) {
      setError(`Total persentase harus 100%, saat ini ${totalPersen}%.`);
      return;
    }

    setSubmitting(true);
    try {
      const config = {
        persenCadangan: parseFloat(values.persenCadangan) || 0,
        persenJasaModal: parseFloat(values.persenJasaModal) || 0,
        persenJasaUsaha: parseFloat(values.persenJasaUsaha) || 0,
        persenPendidikan: parseFloat(values.persenPendidikan) || 0,
        persenSosial: parseFloat(values.persenSosial) || 0,
        persenPengurus: parseFloat(values.persenPengurus) || 0,
        persenPengawas: parseFloat(values.persenPengawas) || 0,
        persenKaryawan: parseFloat(values.persenKaryawan) || 0,
        persenPembangunanDaerahKerja: parseFloat(values.persenPembangunanDaerahKerja) || 0,
        persenCadanganRisiko: parseFloat(values.persenCadanganRisiko) || 0,
      };

      await simpanKonfigurasiShu(currentUser.id, tahunBuku, config);
      await hitungSHU(tahunBuku, currentUser.id, konfirmasiUlang);

      navigation.replace('ShuDetail', { tahunBuku });
    } catch (e) {
      if (e instanceof ShuSudahDihitungError) {
        notify(
          'SHU Sudah Pernah Dihitung',
          `SHU tahun buku ${tahunBuku} sudah pernah dihitung sebelumnya. Menghitung ulang akan mengganti seluruh angka sebelumnya (belum dibagikan, jadi masih aman). Lanjutkan?`,
          [
            { text: 'Batal', style: 'cancel' },
            { text: 'Hitung Ulang', style: 'destructive', onPress: () => jalankanPerhitungan(true) },
          ]
        );
      } else {
        setError(e instanceof Error ? e.message : 'Gagal menghitung SHU.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.sectionLabel}>Tahun Buku</Text>
        <View style={styles.chipRow}>
          {periods.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.chip, tahunBuku === p.tahunBuku && styles.chipActive]}
              onPress={() => setTahunBuku(p.tahunBuku)}
            >
              <Text style={[styles.chipText, tahunBuku === p.tahunBuku && styles.chipTextActive]}>{p.tahunBuku}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {periods.length === 0 && <Text style={styles.emptyText}>Belum ada periode akuntansi.</Text>}

        <Text style={styles.sectionLabel}>Komponen Distribusi SHU</Text>
        <Text style={styles.hint}>
          Total kesepuluh komponen di bawah harus tepat 100%. Jasa Modal dibagi berdasarkan saldo
          simpanan anggota, Jasa Usaha dibagi berdasarkan jasa pinjaman yang dibayarkan anggota
          selama tahun buku ini.
        </Text>

        {FIELDS.map((f) => (
          <View key={f.key} style={styles.field}>
            <Text style={styles.label}>{f.label}</Text>
            <FocusTextInput
              style={styles.input}
              keyboardType="decimal-pad"
              value={values[f.key]}
              onChangeText={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            />
          </View>
        ))}

        <View style={[styles.totalRow, Math.abs(totalPersen - 100) > 0.01 && styles.totalRowWarn]}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{totalPersen}%</Text>
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[styles.submitButton, (submitting || !tahunBuku) && styles.disabled]}
          onPress={() => jalankanPerhitungan(false)}
          disabled={submitting || !tahunBuku}
        >
          {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan & Hitung SHU</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={() => navigation.goBack()} disabled={submitting}>
          <Text style={styles.cancelText}>Batal</Text>
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.sm, marginBottom: spacing.sm },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 18 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  emptyText: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, marginBottom: 4 },
  input: { ...formUi.inputStandalone },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  totalRowWarn: { backgroundColor: colors.dangerBg },
  totalLabel: { fontSize: 13, fontWeight: '700', color: colors.text },
  totalValue: { fontSize: 13, fontWeight: '700', color: colors.text },
  errorText: { color: colors.danger, fontSize: 12, marginBottom: spacing.md, textAlign: 'center' },
  submitButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginBottom: spacing.sm },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  cancelButton: { paddingVertical: 12, alignItems: 'center', marginBottom: 40 },
  cancelText: { color: colors.textMuted, fontWeight: '600', fontSize: 14 },
});
