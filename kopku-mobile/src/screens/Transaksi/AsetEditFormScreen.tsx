import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem } from '@/services/KasBankService';
import { getAsetById, updateAset, hapusAset, asetSudahDisusutkan, AsetDetail } from '@/services/AsetService';
import { listKelompokAset, listSubKelompokAset, AsetKlasifikasiItem } from '@/services/AsetKlasifikasiService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Edit (& lihat) Aset Tetap (§9, tetap berlaku). Nama/Klasifikasi/
 * Keterangan SELALU bisa diubah. Nilai Perolehan/Nilai Residu/Masa
 * Manfaat/Tanggal Perolehan TERKUNCI (read-only, dengan penjelasan)
 * kalau aset sudah pernah disusutkan/diamortisasi — lihat komentar
 * `AsetService.updateAset()`. Kalau nilai perolehan/tanggal berubah
 * (hanya mungkin sebelum ada penyusutan), wajib isi alasan + sumber
 * dana untuk mengoreksi jurnal perolehan (reversal + repost).
 *
 * Permintaan pengguna §10/§11: layar ini SEKARANG merangkap sebagai
 * layar "detail" (`AsetDetailScreen` dihapus — semua field tetap
 * tampil di sini, terkunci atau tidak) + tombol Hapus ditambahkan di
 * bawah (memakai `AsetService.hapusAset()` yang SAMA dipakai
 * AsetListScreen/DaftarAsetTetapScreen — bukan logic delete kedua).
 */
export default function AsetEditFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  // Bug fix: `route.params` bisa undefined kalau layar ini dibuka tanpa
  // parameter (mis. navigasi salah/hilang) — destructuring langsung dari
  // `route.params` sebelumnya melempar "Cannot destructure property
  // 'asetId' of 'route.params' as it is undefined" dan menjatuhkan
  // seluruh layar. `?? {}` membuat `asetId` jadi undefined dengan aman,
  // ditangani secara eksplisit di bawah (pesan jelas, bukan crash).
  const { asetId } = route.params ?? {};

  const [loading, setLoading] = useState(true);
  const [original, setOriginal] = useState<AsetDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [terkunci, setTerkunci] = useState(false);
  const [hapusModalOpen, setHapusModalOpen] = useState(false);
  const [alasanHapus, setAlasanHapus] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [namaAset, setNamaAset] = useState('');
  const [kelompokAset, setKelompokAset] = useState('');
  const [subKelompokAset, setSubKelompokAset] = useState('');
  const [kelompokList, setKelompokList] = useState<string[]>([]);
  const [subKelompokList, setSubKelompokList] = useState<AsetKlasifikasiItem[]>([]);
  const [nilaiPerolehan, setNilaiPerolehan] = useState<number | ''>('');
  const [nilaiResidu, setNilaiResidu] = useState<number | ''>('');
  const [masaManfaat, setMasaManfaat] = useState('');
  const [tanggal, setTanggal] = useState('');
  const [keterangan, setKeterangan] = useState('');
  const [alasanKoreksi, setAlasanKoreksi] = useState('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Bug fix (§3): kalau asetId tidak dikirim sama sekali (route.params
    // hilang/kosong), jangan panggil service dengan id undefined (bisa
    // menyebabkan error query SQLite yang membingungkan) — langsung
    // tampilkan status "tidak ditemukan" yang jelas.
    if (!asetId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let batal = false;
    (async () => {
      try {
        const [detail, disusutkan, kelompok] = await Promise.all([
          getAsetById(asetId),
          asetSudahDisusutkan(asetId),
          listKelompokAset(),
        ]);
        if (batal) return;
        if (!detail) {
          // Aset tidak ditemukan (mis. sudah dihapus dari sumber lain,
          // atau id tidak valid) — tampilkan pesan jelas, JANGAN crash
          // dan JANGAN diam-diam menampilkan form kosong.
          setNotFound(true);
          setLoading(false);
          return;
        }
        setOriginal(detail);
        setNamaAset(detail.namaAset);
        setKelompokAset(detail.kelompokAset ?? '');
        setSubKelompokAset(detail.subKelompokAset ?? '');
        setNilaiPerolehan(detail.nilaiPerolehan);
        setNilaiResidu(detail.nilaiResidu);
        setMasaManfaat(String(detail.masaManfaatBulan));
        setTanggal(detail.tanggalPerolehan);
        setKeterangan(detail.keterangan ?? '');
        setTerkunci(disusutkan);
        setKelompokList(kelompok);
        setLoading(false);
      } catch (e) {
        if (batal) return;
        // Bug fix: sebelumnya error apa pun saat memuat data (mis.
        // koneksi DB gagal) tidak ditangani di sini sama sekali, hasilnya
        // layar diam di spinner selamanya (setLoading(false) tidak
        // pernah terpanggil). Sekarang error ditangkap & ditampilkan
        // sebagai pesan yang jelas, bukan try/catch kosong.
        setNotFound(true);
        setLoading(false);
        notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat data aset.');
      }
    })();
    return () => {
      batal = true;
    };
  }, [asetId]);

  useEffect(() => {
    if (!kelompokAset) {
      setSubKelompokList([]);
      return;
    }
    listSubKelompokAset(kelompokAset).then(setSubKelompokList);
  }, [kelompokAset]);

  const strukturBerubah =
    original &&
    (nilaiPerolehan !== original.nilaiPerolehan ||
      nilaiResidu !== original.nilaiResidu ||
      String(masaManfaat) !== String(original.masaManfaatBulan) ||
      tanggal !== original.tanggalPerolehan);
  const nilaiPerolehanBerubah = original && (nilaiPerolehan !== original.nilaiPerolehan || tanggal !== original.tanggalPerolehan);
  const perluAlasan = !!strukturBerubah;
  const perluRekening = !!nilaiPerolehanBerubah && original?.metodePembayaran === 'TUNAI' && original?.sumber === 'PEMBELIAN';

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!namaAset.trim()) e.namaAset = 'Nama aset wajib diisi';
    if (!terkunci) {
      if (nilaiPerolehan === '' || nilaiPerolehan <= 0) e.nilaiPerolehan = 'Nilai perolehan harus lebih dari 0';
      const masaNum = parseInt(masaManfaat, 10);
      if (!masaManfaat || isNaN(masaNum) || masaNum <= 0) e.masaManfaat = 'Masa manfaat (bulan) harus lebih dari 0';
      if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
      if (perluAlasan && !alasanKoreksi.trim()) e.alasanKoreksi = 'Alasan koreksi wajib diisi';
      if (perluRekening && !rekening) e.rekening = 'Sumber dana wajib dipilih untuk mengoreksi nilai pembelian';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !currentUser) return;
    setSubmitting(true);
    try {
      await updateAset({
        id: asetId,
        namaAset: namaAset.trim(),
        kelompokAset: kelompokAset || undefined,
        subKelompokAset: subKelompokAset || undefined,
        keterangan: keterangan.trim() || undefined,
        nilaiPerolehan: terkunci ? undefined : (nilaiPerolehan as number),
        nilaiResidu: terkunci ? undefined : (nilaiResidu as number),
        masaManfaatBulan: terkunci ? undefined : parseInt(masaManfaat, 10),
        tanggalPerolehan: terkunci ? undefined : tanggal,
        alasanKoreksi: alasanKoreksi.trim() || undefined,
        sumberDana: rekening ? (rekening.jenis === 'BANK' ? 'BANK' : 'KAS') : undefined,
        bankAccountId: rekening?.jenis === 'BANK' ? rekening.id : undefined,
        actingUserId: currentUser.id,
      });
      notify('Berhasil', 'Data aset berhasil diperbarui.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitHapus = async () => {
    if (!currentUser || !alasanHapus.trim()) return;
    setDeleting(true);
    try {
      const { direversal } = await hapusAset({ id: asetId, alasan: alasanHapus.trim(), actingUserId: currentUser.id });
      setHapusModalOpen(false);
      notify(
        'Berhasil',
        direversal
          ? 'Aset dihapus & jurnal pembeliannya dibatalkan (reversal).'
          : 'Aset dinonaktifkan. Histori penyusutan/amortisasi yang sudah tercatat tetap utuh.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // Bug fix (§3): sebelumnya kondisi `!original` (aset tidak ditemukan /
  // asetId hilang) jatuh ke spinner yang sama dengan `loading` — layar
  // terlihat "macet" loading selamanya tanpa penjelasan. Sekarang
  // tampil pesan jelas + tombol kembali, tidak crash dan tidak diam.
  if (notFound || !original) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
        <Text style={styles.notFoundText}>Data aset tidak ditemukan. Aset mungkin sudah dihapus atau ID tidak valid.</Text>
        <TouchableOpacity style={styles.notFoundButton} onPress={() => navigation.goBack()}>
          <Text style={styles.notFoundButtonText}>Kembali</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      {terkunci && (
        <View style={styles.warnBox}>
          <Ionicons name="lock-closed-outline" size={16} color={colors.warning} />
          <Text style={styles.warnText}>
            Aset ini sudah memiliki histori penyusutan — Nilai Perolehan, Nilai Residu, Masa Manfaat, dan Tanggal
            Perolehan dikunci agar catatan penyusutan yang sudah diposting tetap konsisten. Nama, klasifikasi, dan
            keterangan tetap bisa diubah.
          </Text>
        </View>
      )}

      <Text style={styles.label}>Nama Aset *</Text>
      <FocusTextInput
        style={styles.input}
        value={namaAset}
        onChangeText={setNamaAset}
        placeholderTextColor={colors.placeholder}
        invalid={!!errors.namaAset}
      />
      {errors.namaAset && <FieldError message={errors.namaAset} />}

      <Text style={styles.sectionLabel}>Kelompok Aset</Text>
      <View style={styles.chipRow}>
        {kelompokList.map((k) => (
          <Chip key={k} label={k} active={kelompokAset === k} onPress={() => setKelompokAset(k)} />
        ))}
      </View>

      {subKelompokList.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Sub Kelompok</Text>
          <View style={styles.chipRow}>
            {subKelompokList.map((s) => (
              <Chip
                key={s.id}
                label={s.subKelompok}
                active={subKelompokAset === s.subKelompok}
                onPress={() => {
                  setSubKelompokAset(s.subKelompok);
                  // Audit ulang §18/§19: hindari mengisi field dengan
                  // literal "null" saat sub-kelompok tidak punya masa
                  // manfaat default (mis. Kelompok 5) — biarkan nilai
                  // masa manfaat yang sudah ada di form apa adanya,
                  // pengguna tetap bisa mengeditnya manual di bawah.
                  if (!terkunci && s.masaManfaatBulanDefault !== null) {
                    setMasaManfaat(String(s.masaManfaatBulanDefault));
                  }
                }}
              />
            ))}
          </View>
        </>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Perolehan (Rp) *</Text>
      <CurrencyInput value={nilaiPerolehan} onChangeValue={terkunci ? () => {} : setNilaiPerolehan} error={errors.nilaiPerolehan} />

      <Text style={styles.label}>Nilai Residu (Rp)</Text>
      <CurrencyInput value={nilaiResidu} onChangeValue={terkunci ? () => {} : setNilaiResidu} />

      <Text style={styles.label}>Masa Manfaat (bulan) *</Text>
      <FocusTextInput
        style={[styles.input, terkunci && styles.inputLocked]}
        value={masaManfaat}
        onChangeText={terkunci ? undefined : setMasaManfaat}
        editable={!terkunci}
        keyboardType="number-pad"
        invalid={!!errors.masaManfaat}
      />
      {errors.masaManfaat && <FieldError message={errors.masaManfaat} />}

      <Text style={styles.label}>Tanggal Perolehan *</Text>
      <DatePicker value={tanggal} onChange={terkunci ? () => {} : setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

      {!terkunci && perluAlasan && (
        <>
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.infoText}>
              Nilai perolehan/tanggal berubah — jurnal pembelian lama akan dikoreksi (dibatalkan & dicatat ulang),
              bukan diedit langsung.
            </Text>
          </View>
          <Text style={styles.label}>Alasan Koreksi *</Text>
          <FocusTextInput
            style={styles.inputMultiline}
            value={alasanKoreksi}
            onChangeText={setAlasanKoreksi}
            multiline
            placeholder="Mis. salah input nilai perolehan"
            placeholderTextColor={colors.placeholder}
            invalid={!!errors.alasanKoreksi}
          />
          {errors.alasanKoreksi && <FieldError message={errors.alasanKoreksi} />}
        </>
      )}

      {!terkunci && perluRekening && (
        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Sumber Dana (untuk koreksi nilai)" value={rekening} onChange={setRekening} />
          {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
        </View>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
      <FocusTextInput style={styles.inputMultiline} value={keterangan} onChangeText={setKeterangan} multiline placeholderTextColor={colors.placeholder} />

      <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan Perubahan</Text>}
      </TouchableOpacity>

      {original.status === 'AKTIF' && (
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => {
            setAlasanHapus('');
            setHapusModalOpen(true);
          }}
        >
          <Ionicons name="trash-outline" size={16} color={colors.danger} />
          <Text style={styles.deleteButtonText}>Hapus Aset</Text>
        </TouchableOpacity>
      )}

      <Modal visible={hapusModalOpen} transparent animationType="fade" onRequestClose={() => setHapusModalOpen(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Hapus Aset</Text>
            <Text style={styles.modalSubText}>
              Kalau aset ini belum pernah disusutkan/diamortisasi, jurnal pembeliannya akan dibatalkan (reversal).
              Kalau sudah pernah, aset hanya dinonaktifkan — histori penyusutan/amortisasi tetap utuh.
            </Text>
            <FocusTextInput
              style={styles.modalInput}
              value={alasanHapus}
              onChangeText={setAlasanHapus}
              placeholder="Alasan penghapusan (wajib diisi)"
              placeholderTextColor={colors.placeholder}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setHapusModalOpen(false)}>
                <Text style={styles.modalCancelText}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, (!alasanHapus.trim() || deleting) && styles.disabled]}
                onPress={submitHapus}
                disabled={!alasanHapus.trim() || deleting}
              >
                {deleting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Hapus</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </ScrollView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.lg, lineHeight: 18 },
  notFoundButton: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  notFoundButtonText: { color: colors.text, fontWeight: '600' },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.md },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
  inputLocked: { backgroundColor: colors.background, color: colors.textMuted },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  warnBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: '#FFF3E0',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  warnText: { flex: 1, fontSize: 12, color: '#8A5300', lineHeight: 17 },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: 40,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  deleteButton: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    marginTop: spacing.sm,
    marginBottom: 40,
  },
  deleteButtonText: { color: colors.danger, fontWeight: '700' },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSubText: { fontSize: 12, color: colors.textMuted, marginTop: 6, marginBottom: spacing.md, lineHeight: 17 },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.destructiveButton },
  modalSubmitText: { ...modalUi.primaryText },
});
