import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { Ionicons } from '@expo/vector-icons';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { listAccountingPeriods, AccountingPeriodItem } from '@/repositories/PeriodeRepository';
import { simpanRAT, hapusRAT, getRATByTahunBuku, listRAT, RATItem } from '@/services/RATService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * "Pelaksanaan RAT" (§L, permintaan pengguna) — Laporan > Rincian
 * Laporan Lainnya. Mencatat tanggal & berita acara Rapat Anggota
 * Tahunan per tahun buku, dipakai sebagai syarat Tutup Periode (§K.14)
 * & Bagikan SHU (§M) lewat `RATService` yang SUDAH ADA (dibangun untuk
 * kebutuhan ini sejak update sebelumnya) — layar ini adalah TITIK
 * MASUK UI PERTAMA untuk mencatat RAT secara mandiri (sebelumnya cuma
 * bisa lewat modal di dalam ShuDetailScreen).
 *
 * Label "Nomor/Identitas RAT" diganti "Nomor Berita Acara RAT" sesuai
 * instruksi eksplisit — field database TETAP `nomor_rat`
 * (RATService.RATInput.nomorRat, tidak diubah).
 */
export default function PelaksanaanRATScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEdit = can('shu', 'approve');

  const [periodeList, setPeriodeList] = useState<AccountingPeriodItem[]>([]);
  const [tahunBuku, setTahunBuku] = useState<number | null>(null);
  const [existing, setExisting] = useState<RATItem | null>(null);
  const [tanggalRat, setTanggalRat] = useState('');
  const [nomorRat, setNomorRat] = useState('');
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Target §6 (permintaan pengguna): "Daftar Pelaksanaan RAT" di bawah
  // tombol Simpan Perubahan — pakai RATService.listRAT() yang SUDAH
  // ADA (dipakai tempat lain), tidak membuat service/tabel baru.
  const [daftarRAT, setDaftarRAT] = useState<RATItem[]>([]);
  const [loadingDaftar, setLoadingDaftar] = useState(true);

  // Permintaan pengguna §13: Delete per baris — modal alasan wajib
  // diisi, pola sama dengan pencairan investasi/hapus aset.
  const [hapusTarget, setHapusTarget] = useState<RATItem | null>(null);
  const [alasanHapus, setAlasanHapus] = useState('');
  const [deleting, setDeleting] = useState(false);

  const loadDaftarRAT = useCallback(async () => {
    setLoadingDaftar(true);
    const list = await listRAT();
    setDaftarRAT(list);
    setLoadingDaftar(false);
  }, []);

  useEffect(() => {
    loadDaftarRAT();
  }, [loadDaftarRAT]);

  const loadPeriode = useCallback(async () => {
    setLoading(true);
    const periode = await listAccountingPeriods();
    setPeriodeList(periode);
    if (periode.length > 0 && tahunBuku === null) {
      setTahunBuku(periode[0].tahunBuku);
    }
    setLoading(false);
  }, [tahunBuku]);

  useEffect(() => {
    loadPeriode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tahunBuku === null) return;
    (async () => {
      const rat = await getRATByTahunBuku(tahunBuku);
      setExisting(rat);
      setTanggalRat(rat?.tanggalRat ?? '');
      setNomorRat(rat?.nomorRat ?? '');
      setKeterangan(rat?.keterangan ?? '');
      setErrors({});
    })();
  }, [tahunBuku]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!tahunBuku) e.tahunBuku = 'Tahun buku wajib dipilih';
    if (!tanggalRat) e.tanggalRat = 'Tanggal Pelaksanaan RAT wajib diisi.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !currentUser || !tahunBuku) return;
    setSubmitting(true);
    try {
      const hasil = await simpanRAT({
        tahunBuku,
        tanggalRat,
        nomorRat: nomorRat.trim() || undefined,
        keterangan: keterangan.trim() || undefined,
        createdBy: currentUser.id,
      });
      setExisting(hasil);
      notify('Berhasil', `Data RAT tahun buku ${tahunBuku} berhasil disimpan.`);
      // Refresh daftar supaya data yang baru disimpan langsung terlihat
      // (tidak dobel karena simpanRAT() sendiri UPDATE, bukan INSERT
      // baru, kalau tahun buku sudah pernah tercatat).
      loadDaftarRAT();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitHapus = async () => {
    if (!hapusTarget || !currentUser || !alasanHapus.trim()) return;
    setDeleting(true);
    try {
      await hapusRAT({ id: hapusTarget.id, alasan: alasanHapus.trim(), actingUserId: currentUser.id });
      setHapusTarget(null);
      setAlasanHapus('');
      // Kalau yang dihapus adalah tahun buku yang sedang dibuka di
      // form, kosongkan form supaya tidak menampilkan data basi.
      if (existing && existing.id === hapusTarget.id) {
        setExisting(null);
        setTanggalRat('');
        setNomorRat('');
        setKeterangan('');
      }
      await loadDaftarRAT();
      notify('Berhasil', `Data RAT tahun buku ${hapusTarget.tahunBuku} berhasil dihapus.`);
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

  return (
    <>
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <View style={styles.infoBox}>
        <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
        <Text style={styles.infoText}>
          Data RAT dipakai sebagai syarat sebelum periode dapat ditutup & SHU dapat dibagikan untuk tahun buku
          terkait. Satu RAT per tahun buku — kalau sudah ada, mengisi ulang akan memperbarui data yang sama, bukan
          membuat catatan baru.
        </Text>
      </View>

      <Text style={styles.label}>Tahun Buku *</Text>
      {periodeList.length === 0 ? (
        <Text style={styles.emptyText}>Belum ada periode akuntansi (tahun buku).</Text>
      ) : (
        <View style={styles.chipRow}>
          {periodeList.map((p) => (
            <TouchableOpacity key={p.id} style={[styles.chip, tahunBuku === p.tahunBuku && styles.chipActive]} onPress={() => setTahunBuku(p.tahunBuku)}>
              <Text style={[styles.chipText, tahunBuku === p.tahunBuku && styles.chipTextActive]}>{p.tahunBuku}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {errors.tahunBuku && <Text style={styles.errorText}>{errors.tahunBuku}</Text>}

      {existing && (
        <View style={styles.existingBox}>
          <Ionicons name="checkmark-circle-outline" size={16} color={colors.primary} />
          <Text style={styles.existingText}>
            RAT tahun buku {existing.tahunBuku} sudah tercatat: {formatTanggalIndonesia(existing.tanggalRat)}
            {existing.nomorRat ? ` · ${existing.nomorRat}` : ''}. Ubah field di bawah lalu simpan untuk memperbarui.
          </Text>
        </View>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Pelaksanaan RAT *</Text>
      <DatePicker value={tanggalRat} onChange={canEdit ? setTanggalRat : () => {}} error={errors.tanggalRat} maximumDate={getWaktuSekarang()} />

      <Text style={styles.label}>Nomor Berita Acara RAT</Text>
      <FocusTextInput
        style={styles.input}
        value={nomorRat}
        onChangeText={setNomorRat}
        editable={canEdit}
        placeholder="Opsional, mis. 001/BA-RAT/2026"
        placeholderTextColor={colors.placeholder}
      />

      <Text style={styles.label}>Keterangan</Text>
      <FocusTextInput
        style={styles.inputMultiline}
        value={keterangan}
        onChangeText={setKeterangan}
        editable={canEdit}
        multiline
        placeholder="Opsional"
        placeholderTextColor={colors.placeholder}
      />

      {!canEdit && (
        <Text style={styles.noPermissionText}>Anda tidak memiliki izin untuk mencatat/mengubah data RAT.</Text>
      )}

      {canEdit && (
        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>{existing ? 'Simpan Perubahan' : 'Simpan Data RAT'}</Text>}
        </TouchableOpacity>
      )}

      <Text style={[styles.label, { marginTop: canEdit ? spacing.xl : spacing.md }]}>Daftar Pelaksanaan RAT</Text>
      {loadingDaftar ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.sm }} />
      ) : daftarRAT.length === 0 ? (
        <Text style={styles.emptyText}>Belum ada data RAT yang tercatat.</Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {daftarRAT.map((rat) => (
            <View key={rat.id} style={styles.ratListItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ratListTitle}>Tahun Buku {rat.tahunBuku}</Text>
                <Text style={styles.ratListSubtitle}>
                  {formatTanggalIndonesia(rat.tanggalRat)}
                  {rat.nomorRat ? ` · ${rat.nomorRat}` : ''}
                </Text>
                {rat.keterangan ? <Text style={styles.ratListNote}>{rat.keterangan}</Text> : null}
              </View>
              {canEdit && (
                <View style={styles.ratListActions}>
                  <TouchableOpacity style={styles.ratActionBtn} onPress={() => setTahunBuku(rat.tahunBuku)}>
                    <Ionicons name="create-outline" size={16} color={colors.primary} />
                    <Text style={styles.ratActionText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.ratActionBtn}
                    onPress={() => {
                      setHapusTarget(rat);
                      setAlasanHapus('');
                    }}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    <Text style={[styles.ratActionText, { color: colors.danger }]}>Hapus</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>

    <Modal visible={!!hapusTarget} transparent animationType="fade" onRequestClose={() => setHapusTarget(null)}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Hapus Data RAT</Text>
          <Text style={styles.modalSub}>
            Data RAT tahun buku {hapusTarget?.tahunBuku} akan dihapus. Kalau periode tahun buku ini sudah ditutup
            atau sudah dipakai untuk mengesahkan SHU, penghapusan akan ditolak.
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
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setHapusTarget(null)}>
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
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.md },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.white },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  existingBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: '#E8F5E9',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  existingText: { flex: 1, fontSize: 12, color: colors.primary, lineHeight: 17 },
  noPermissionText: { color: colors.danger, fontSize: 12, marginTop: spacing.lg, textAlign: 'center' },
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
  ratListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  ratListTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  ratListSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  ratListNote: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontStyle: 'italic' },
  ratListActions: { flexDirection: 'row', gap: spacing.md },
  ratActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratActionText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSub: { ...modalUi.description },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.destructiveButton },
  modalSubmitText: { ...modalUi.primaryText },
});
