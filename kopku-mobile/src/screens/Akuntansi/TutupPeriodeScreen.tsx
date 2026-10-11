import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  listPeriodeAkuntansi,
  getRingkasanPenutupanPeriode,
  tutupPeriode,
  RingkasanPenutupanPeriode,
} from '@/services/PeriodCloseService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

interface PeriodeItem {
  id: string;
  tahunBuku: number;
  periodeMulai: string;
  periodeSelesai: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
}

/**
 * Layar "Tutup Periode" — UI MINIMAL di atas `PeriodCloseService` yang
 * SUDAH ADA (Phase 11, backend lengkap & teruji, sebelumnya nol UI —
 * lihat FORM_TRANSACTION_AUDIT.md §3). TIDAK ADA logic baru: seluruh
 * keputusan "boleh ditutup atau tidak" dan alasannya berasal LANGSUNG
 * dari `getRingkasanPenutupanPeriode()`; tombol "Tutup Periode" hanya
 * aktif kalau `bolehDitutup === true` — layar ini TIDAK PERNAH
 * meng-UPDATE status CLOSED sendiri, selalu lewat `tutupPeriode()`
 * yang mengecek ulang seluruh syarat sebelum benar-benar menulis
 * (aman dari race condition, lihat komentar di service-nya).
 */
export default function TutupPeriodeScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [periodeList, setPeriodeList] = useState<PeriodeItem[]>([]);
  const [periodeTerpilih, setPeriodeTerpilih] = useState<PeriodeItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ringkasan, setRingkasan] = useState<RingkasanPenutupanPeriode | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRingkasan, setLoadingRingkasan] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ratConfirmOpen, setRatConfirmOpen] = useState(false);

  const loadDaftar = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listPeriodeAkuntansi();
      setPeriodeList(rows);
      // Default: periode OPEN pertama (paling baru) — biasanya itu
      // yang mau ditutup pengguna.
      if (!periodeTerpilih) {
        const defaultPeriode = rows.find((r) => r.status === 'OPEN') ?? rows[0] ?? null;
        setPeriodeTerpilih(defaultPeriode);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRingkasan = useCallback(async () => {
    if (!periodeTerpilih) {
      setRingkasan(null);
      return;
    }
    setLoadingRingkasan(true);
    try {
      setRingkasan(await getRingkasanPenutupanPeriode(periodeTerpilih.id));
    } catch (e) {
      notify('Gagal Memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setLoadingRingkasan(false);
    }
  }, [periodeTerpilih]);

  useEffect(() => {
    loadDaftar();
  }, [loadDaftar]);

  useEffect(() => {
    loadRingkasan();
  }, [loadRingkasan]);

  const submit = async () => {
    if (!periodeTerpilih || !currentUser || !ringkasan?.bolehDitutup) return;
    setSubmitting(true);
    try {
      await tutupPeriode({ periodeId: periodeTerpilih.id, createdBy: currentUser.id });
      notify('Berhasil', `Periode tahun buku ${periodeTerpilih.tahunBuku} berhasil ditutup. Tidak ada transaksi baru yang bisa diposting ke periode ini lagi.`);
      await loadDaftar();
      await loadRingkasan();
    } catch (e) {
      // Ditolak SAAT tutupPeriode() dipanggil (mis. kondisi berubah
      // di antara load ringkasan & submit, race condition) — pesan
      // dari service ditampilkan apa adanya, tidak ada state yang
      // berubah (withTransaction di service rollback otomatis).
      notify('Gagal Menutup Periode', e instanceof Error ? e.message : 'Terjadi kesalahan.');
      await loadRingkasan();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={styles.label}>Periode Tahun Buku</Text>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: spacing.md }} />
      ) : (
        <TouchableOpacity style={styles.selector} onPress={() => setPickerOpen(true)}>
          <Ionicons name="calendar-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
          <Text style={periodeTerpilih ? styles.selectorText : styles.selectorPlaceholder}>
            {periodeTerpilih
              ? `${periodeTerpilih.tahunBuku} (${periodeTerpilih.periodeMulai} s/d ${periodeTerpilih.periodeSelesai}) — ${periodeTerpilih.status}`
              : 'Pilih periode...'}
          </Text>
        </TouchableOpacity>
      )}

      {loadingRingkasan && <ActivityIndicator style={{ marginTop: spacing.lg }} />}

      {!loadingRingkasan && ringkasan && periodeTerpilih && (
        <>
          <View style={styles.checkRow}>
            <Ionicons
              name={ringkasan.trialBalanceSeimbang ? 'checkmark-circle' : 'close-circle'}
              size={18}
              color={ringkasan.trialBalanceSeimbang ? colors.primary : colors.danger}
            />
            <Text style={styles.checkText}>
              Trial balance {ringkasan.trialBalanceSeimbang ? 'seimbang' : 'TIDAK SEIMBANG'} (Debit{' '}
              {formatRupiah(ringkasan.totalDebit)} / Kredit {formatRupiah(ringkasan.totalKredit)})
            </Text>
          </View>

          <View style={styles.checkRow}>
            <Ionicons
              name={ringkasan.rekonsiliasiBermasalah.length === 0 ? 'checkmark-circle' : 'close-circle'}
              size={18}
              color={ringkasan.rekonsiliasiBermasalah.length === 0 ? colors.primary : colors.danger}
            />
            <Text style={styles.checkText}>
              {ringkasan.rekonsiliasiBermasalah.length === 0
                ? 'Tidak ada selisih rekonsiliasi yang belum terselesaikan'
                : `${ringkasan.rekonsiliasiBermasalah.length} rekening dengan selisih belum terselesaikan`}
            </Text>
          </View>

          {ringkasan.rekonsiliasiBermasalah.length > 0 && (
            <View style={styles.mismatchBox}>
              {ringkasan.rekonsiliasiBermasalah.map((r) => (
                <Text key={r.accountId} style={styles.mismatchText}>
                  • {r.namaRekening}: selisih {formatRupiah(r.selisih)} (per {r.tanggal})
                </Text>
              ))}
              <Text style={styles.mismatchHint}>Rekonsiliasi ulang rekening ini (menu Rekonsiliasi Kas/Bank) sampai cocok sebelum menutup periode.</Text>
            </View>
          )}

          <View style={[styles.verdictBox, ringkasan.bolehDitutup ? styles.verdictOk : styles.verdictBlocked]}>
            <Ionicons
              name={ringkasan.bolehDitutup ? 'lock-open-outline' : 'lock-closed-outline'}
              size={20}
              color={ringkasan.bolehDitutup ? colors.primary : colors.danger}
            />
            <Text style={styles.verdictText}>
              {ringkasan.bolehDitutup
                ? 'Periode ini memenuhi semua syarat dan boleh ditutup.'
                : ringkasan.alasanTidakBolehDitutup}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.submitButton, (!ringkasan.bolehDitutup || submitting) && styles.disabled]}
            onPress={() => setRatConfirmOpen(true)}
            disabled={!ringkasan.bolehDitutup || submitting}
          >
            {submitting ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Ionicons name="lock-closed-outline" size={18} color={colors.white} />
                <Text style={styles.submitText}>Tutup Periode {periodeTerpilih.tahunBuku}</Text>
              </>
            )}
          </TouchableOpacity>
        </>
      )}

      {/* Update pasca-Phase 18/19 (permintaan pengguna §K.14): popup
          konfirmasi RAT — murni UX (mengingatkan pengguna), gerbang
          SUNGGUHAN sudah ditegakkan di `PeriodCloseService.tutupPeriode()`
          sendiri (menolak kalau RAT tahun buku terkait belum tercatat,
          dicek dua kali di service — tidak bisa dilewati lewat popup
          ini). */}
      <Modal visible={ratConfirmOpen} transparent animationType="fade" onRequestClose={() => setRatConfirmOpen(false)}>
        <View style={styles.ratModalBackdrop}>
          <View style={styles.ratModalCard}>
            <Text style={styles.ratModalTitle}>Apakah laporan keuangan telah disetujui Rapat Anggota Tahunan (RAT)?</Text>
            <View style={styles.ratModalActions}>
              <TouchableOpacity style={styles.ratModalCancelBtn} onPress={() => setRatConfirmOpen(false)}>
                <Text style={styles.ratModalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.ratModalConfirmBtn}
                onPress={() => {
                  setRatConfirmOpen(false);
                  submit();
                }}
              >
                <Text style={styles.ratModalConfirmText}>Ya, Laporan Telah Disetujui RAT</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Periode</Text>
            <TouchableOpacity onPress={() => setPickerOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
            {periodeList.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={styles.periodeRow}
                onPress={() => {
                  setPeriodeTerpilih(p);
                  setPickerOpen(false);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.periodeNama}>{p.tahunBuku}</Text>
                  <Text style={styles.periodeSub}>{p.periodeMulai} s/d {p.periodeSelesai}</Text>
                </View>
                <Text style={[styles.periodeBadge, p.status === 'CLOSED' ? styles.badgeClosed : styles.badgeOpen]}>{p.status}</Text>
              </TouchableOpacity>
            ))}
            {periodeList.length === 0 && <Text style={styles.emptyText}>Belum ada periode akuntansi.</Text>}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  selectorText: { fontSize: 14, color: colors.text },
  selectorPlaceholder: { fontSize: 14, color: colors.placeholder },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.md },
  checkText: { fontSize: 13, color: colors.text, flex: 1 },
  mismatchBox: {
    backgroundColor: '#FDECEA',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  mismatchText: { fontSize: 12, color: colors.danger, marginBottom: 2 },
  mismatchHint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, fontStyle: 'italic' },
  verdictBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  verdictOk: { backgroundColor: colors.primaryLight },
  verdictBlocked: { backgroundColor: '#FDECEA' },
  verdictText: { fontSize: 13, color: colors.text, flex: 1, fontWeight: '600' },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.danger,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
    marginBottom: 40,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalTitle: { ...modalUi.title },
  periodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  periodeNama: { fontSize: 15, fontWeight: '700', color: colors.text },
  periodeSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  periodeBadge: { fontSize: 11, fontWeight: '700' },
  badgeOpen: { color: colors.primary },
  badgeClosed: { color: colors.textMuted },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  ratModalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  ratModalCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, width: '100%' },
  ratModalTitle: { fontSize: 15, fontWeight: '700', color: colors.text, lineHeight: 21 },
  ratModalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  ratModalCancelBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  ratModalCancelText: { color: colors.text, fontWeight: '600' },
  ratModalConfirmBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.primary },
  ratModalConfirmText: { color: colors.white, fontWeight: '700' },
});
