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
import { addDays, addWeeks, addMonths, format } from 'date-fns';
import {
  getPinjamanDetail,
  getJadwalAngsuran,
  simpanJadwalAngsuranCustom,
} from '@/services/PinjamanService';
import {
  validasiJadwalCustom,
  hitungTotalBarisCustom,
  BarisAngsuranCustomInput,
  SatuanTenor,
} from '@/accounting/PinjamanCalculator';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

import FocusTextInput from '@/components/FocusTextInput';
type BarisForm = { nomorAngsuran: number; tanggalJatuhTempo: string; pokok: string; jasa: string };

function tambahTenor(tanggal: Date, satuan: SatuanTenor, n: number): Date {
  if (satuan === 'HARI') return addDays(tanggal, n);
  if (satuan === 'MINGGU') return addWeeks(tanggal, n);
  return addMonths(tanggal, n);
}

/**
 * Susun jadwal angsuran CUSTOM (fase 9 §1-5, §10): tentukan jumlah
 * periode, lalu edit tanggal/pokok/bunga tiap periode, preview sebelum
 * disimpan (§10-11).
 */
export default function PinjamanJadwalCustomScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { pinjamanId } = route.params ?? {};

  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getPinjamanDetail>>>(null);
  const [loading, setLoading] = useState(true);
  const [errorMuat, setErrorMuat] = useState<string | null>(null);
  const [jumlahPeriodeInput, setJumlahPeriodeInput] = useState('');
  const [baris, setBaris] = useState<BarisForm[]>([]);
  const [modePreview, setModePreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!pinjamanId) {
      setErrorMuat('Pinjaman tidak ditemukan (ID tidak valid).');
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      setErrorMuat(null);
      try {
        const [d, jadwalLama] = await Promise.all([getPinjamanDetail(pinjamanId), getJadwalAngsuran(pinjamanId)]);
        if (!d) {
          // Bug fix: sebelumnya kalau pinjaman tidak ditemukan (return
          // null tanpa error), layar jatuh ke spinner selamanya karena
          // kondisi render `loading || !detail` menganggapnya "masih
          // loading". Sekarang pesan jelas ditampilkan.
          setErrorMuat('Pinjaman tidak ditemukan. Data mungkin sudah dihapus atau ID tidak valid.');
          setLoading(false);
          return;
        }
        setDetail(d);
        if (jadwalLama.length > 0) {
          setJumlahPeriodeInput(String(jadwalLama.length));
          setBaris(
            jadwalLama.map((j) => ({
              nomorAngsuran: j.nomorAngsuran,
              tanggalJatuhTempo: j.tanggalJatuhTempo,
              pokok: String(j.pokok),
              jasa: String(j.jasa),
            }))
          );
        }
      } catch (e) {
        setErrorMuat(e instanceof Error ? e.message : 'Gagal memuat data pinjaman.');
      } finally {
        setLoading(false);
      }
    })();
  }, [pinjamanId]);

  /** Tentukan jumlah periode (fase 9 §2) — generate baris default (pokok rata, bunga 0, tanggal berjarak sesuai satuan tenor pinjaman). */
  const generateBaris = () => {
    if (!detail) return;
    const n = parseInt(jumlahPeriodeInput, 10);
    if (isNaN(n) || n <= 0) {
      notify('Jumlah periode tidak valid', 'Isi jumlah periode dengan angka lebih dari 0.');
      return;
    }

    const pokokRata = Math.floor(detail.jumlahPinjaman / n);
    const sisaPembulatan = detail.jumlahPinjaman - pokokRata * n;

    const barisBaru: BarisForm[] = [];
    let tanggalBerjalan = new Date(detail.tanggal);
    for (let i = 1; i <= n; i++) {
      tanggalBerjalan = tambahTenor(tanggalBerjalan, detail.satuanTenor, 1);
      barisBaru.push({
        nomorAngsuran: i,
        tanggalJatuhTempo: format(tanggalBerjalan, 'yyyy-MM-dd'),
        pokok: String(pokokRata + (i === n ? sisaPembulatan : 0)), // sisa pembulatan ke periode terakhir
        jasa: '0',
      });
    }
    setBaris(barisBaru);
    setModePreview(false);
  };

  const updateBaris = (index: number, field: 'tanggalJatuhTempo' | 'pokok' | 'jasa', value: string) => {
    setBaris((prev) => prev.map((b, i) => (i === index ? { ...b, [field]: value } : b)));
  };

  const barisSebagaiInput = (): BarisAngsuranCustomInput[] =>
    baris.map((b) => ({
      nomorAngsuran: b.nomorAngsuran,
      tanggalJatuhTempo: b.tanggalJatuhTempo,
      pokok: parseInt(b.pokok, 10) || 0,
      jasa: parseInt(b.jasa, 10) || 0,
    }));

  const validasi = detail ? validasiJadwalCustom(barisSebagaiInput(), detail.jumlahPinjaman, detail.tanggal) : null;
  const hasilPreview = hitungTotalBarisCustom(barisSebagaiInput());

  const simpan = async () => {
    if (!currentUser || !validasi?.valid) return;
    setSubmitting(true);
    try {
      await simpanJadwalAngsuranCustom({
        pinjamanId,
        baris: barisSebagaiInput(),
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Jadwal angsuran custom berhasil disimpan.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  if (errorMuat) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{errorMuat}</Text>
      </View>
    );
  }

  if (loading || !detail) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>Jadwal Angsuran Custom</Text>
        <Text style={styles.sub}>
          {detail.nomorPinjaman} — Pokok Pinjaman: {formatRupiah(detail.jumlahPinjaman)}
        </Text>

        {!modePreview && (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Jumlah Periode *</Text>
              <View style={styles.periodeRow}>
                <FocusTextInput
                  style={[styles.input, { flex: 1 }]}
                  value={jumlahPeriodeInput}
                  onChangeText={setJumlahPeriodeInput}
                  keyboardType="number-pad"
                />
                <TouchableOpacity style={styles.generateButton} onPress={generateBaris}>
                  <Text style={styles.generateButtonText}>{baris.length > 0 ? 'Ulang' : 'Buat Baris'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {baris.map((b, idx) => (
              <View key={idx} style={styles.barisCard}>
                <Text style={styles.barisTitle}>Periode {b.nomorAngsuran}</Text>
                <View style={styles.barisFieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.smallLabel}>Jatuh Tempo</Text>
                    <FocusTextInput
                      style={styles.inputSmall}
                      value={b.tanggalJatuhTempo}
                      onChangeText={(v) => updateBaris(idx, 'tanggalJatuhTempo', v)}
                      placeholder="YYYY-MM-DD"
                    />
                  </View>
                </View>
                <View style={styles.barisFieldRow}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.smallLabel}>Pokok (Rp)</Text>
                    <FocusTextInput
                      style={styles.inputSmall}
                      value={b.pokok}
                      onChangeText={(v) => updateBaris(idx, 'pokok', v)}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.smallLabel}>Bunga (Rp)</Text>
                    <FocusTextInput
                      style={styles.inputSmall}
                      value={b.jasa}
                      onChangeText={(v) => updateBaris(idx, 'jasa', v)}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <Text style={styles.totalBaris}>
                  Total: {formatRupiah((parseInt(b.pokok, 10) || 0) + (parseInt(b.jasa, 10) || 0))}
                </Text>
              </View>
            ))}

            {baris.length > 0 && (
              <TouchableOpacity style={styles.previewButton} onPress={() => setModePreview(true)}>
                <Text style={styles.previewButtonText}>Preview Jadwal</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {modePreview && (
          <>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, { flex: 0.6 }]}>Ke</Text>
              <Text style={[styles.th, { flex: 1.4 }]}>Jatuh Tempo</Text>
              <Text style={[styles.th, styles.thNum]}>Pokok</Text>
              <Text style={[styles.th, styles.thNum]}>Bunga</Text>
              <Text style={[styles.th, styles.thNum]}>Total</Text>
            </View>
            {hasilPreview.map((r) => (
              <View key={r.nomorAngsuran} style={styles.tr}>
                <Text style={[styles.td, { flex: 0.6 }]}>{r.nomorAngsuran}</Text>
                <Text style={[styles.td, { flex: 1.4 }]}>{r.tanggalJatuhTempo}</Text>
                <Text style={[styles.td, styles.tdNum]}>{formatRupiah(r.pokok)}</Text>
                <Text style={[styles.td, styles.tdNum]}>{formatRupiah(r.jasa)}</Text>
                <Text style={[styles.td, styles.tdNum]}>{formatRupiah(r.total)}</Text>
              </View>
            ))}

            <View style={styles.ringkasanCard}>
              <Row label="Total Pokok" value={formatRupiah(validasi?.totalPokok ?? 0)} />
              <Row label="Total Bunga" value={formatRupiah(validasi?.totalJasa ?? 0)} />
              <Row label="Total Angsuran" value={formatRupiah(validasi?.totalAngsuran ?? 0)} bold />
              <Row label="Pokok Pinjaman (target)" value={formatRupiah(detail.jumlahPinjaman)} />
            </View>

            {validasi && !validasi.valid && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Jadwal belum valid:</Text>
                {validasi.errors.map((err, i) => (
                  <Text key={i} style={styles.errorItem}>
                    • {err}
                  </Text>
                ))}
              </View>
            )}

            <TouchableOpacity style={styles.backButton} onPress={() => setModePreview(false)}>
              <Text style={styles.backButtonText}>Kembali Edit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.submitButton, (!validasi?.valid || submitting) && styles.disabled]}
              onPress={simpan}
              disabled={!validasi?.valid || submitting}
            >
              {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan Jadwal</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.danger, textAlign: 'center', padding: spacing.xl },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.lg },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: 4 },
  periodeRow: { flexDirection: 'row', gap: 8 },
  input: { ...formUi.inputStandalone },
  generateButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  generateButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  barisCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: 10 },
  barisTitle: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: 6 },
  barisFieldRow: { flexDirection: 'row', marginBottom: 6 },
  smallLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 2 },
  inputSmall: { ...formUi.inputCompact },
  totalBaris: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 2 },
  previewButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginTop: spacing.sm, marginBottom: 40 },
  previewButtonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  tableHeader: { flexDirection: 'row', paddingVertical: spacing.sm, borderBottomWidth: 2, borderBottomColor: colors.border },
  th: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  thNum: { flex: 1, textAlign: 'right' },
  tr: { flexDirection: 'row', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  td: { fontSize: 11, color: colors.text },
  tdNum: { flex: 1, textAlign: 'right' },
  ringkasanCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.lg, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  rowLabel: { fontSize: 12, color: colors.textMuted },
  rowValue: { fontSize: 12, color: colors.text },
  bold: { fontWeight: '700' },
  errorBox: { backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  errorTitle: { fontSize: 12, fontWeight: '700', color: colors.danger, marginBottom: 4 },
  errorItem: { fontSize: 11, color: colors.danger, marginTop: 2 },
  backButton: { paddingVertical: 12, alignItems: 'center' },
  backButtonText: { color: colors.textMuted, fontWeight: '600' },
  submitButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginBottom: 40 },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
