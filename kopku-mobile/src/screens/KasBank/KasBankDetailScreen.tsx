import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getTransaksiDetail, koreksiTransaksiKasBank, RiwayatTransaksiRow, JenisRekening } from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';

import FocusTextInput from '@/components/FocusTextInput';
/** Detail satu transaksi kas/bank + aksi koreksi (fase 7 §17, "jangan hapus tanpa mekanisme aman"). */
export default function KasBankDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { jenis, id }: { jenis?: JenisRekening; id?: string } = route.params ?? {};

  const [detail, setDetail] = useState<RiwayatTransaksiRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [modalKoreksi, setModalKoreksi] = useState(false);
  const [alasan, setAlasan] = useState('');
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    if (!jenis || !id) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const d = await getTransaksiDetail(jenis, id);
      setDetail(d);
      if (!d) setNotFound(true);
    } catch (e) {
      // Bug fix: sebelumnya error apa pun di sini tidak ditangani —
      // layar diam di spinner selamanya (try/catch kosong sebelumnya
      // tidak ada sama sekali). Sekarang pesan jelas ditampilkan.
      setNotFound(true);
      notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat detail transaksi.');
    } finally {
      setLoading(false);
    }
  }, [jenis, id]);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Diganti (bukan
  // ditambahi) dengan refresh berbasis FOKUS supaya layar selalu
  // membaca state SQLite terkini. Tidak ada timer, tidak ada remount paksa.
  useFocusRefresh(() => {
    load();
  }, [load]);

  const submitKoreksi = async () => {
    if (!currentUser || !alasan.trim() || !jenis || !id) return;
    setProcessing(true);
    try {
      await koreksiTransaksiKasBank(jenis, id, currentUser.id, alasan.trim());
      setModalKoreksi(false);
      await load();
      notify('Berhasil', 'Transaksi berhasil dikoreksi (jurnal asli di-reversal).');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (notFound || !detail) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
        <Text style={styles.notFoundText}>Transaksi tidak ditemukan. Data mungkin sudah dihapus atau tautan tidak valid.</Text>
        <TouchableOpacity style={styles.notFoundButton} onPress={() => navigation.goBack()}>
          <Text style={styles.notFoundButtonText}>Kembali</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const bisaDikoreksi = detail.tipe !== 'KOREKSI' && !!detail.journalId;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.nomor}>{detail.nomorTransaksi}</Text>
        <Text style={[styles.nominal, detail.tipe === 'PENGELUARAN' && styles.negative]}>
          {detail.tipe === 'PENGELUARAN' ? '-' : '+'}
          {formatRupiah(detail.nominal)}
        </Text>

        <View style={styles.card}>
          <Row label="Rekening" value={detail.rekeningNama} />
          <Row label="Tipe" value={detail.tipe} />
          <Row label="Tanggal" value={detail.tanggal} />
          <Row label="Kategori" value={detail.kategori ?? '-'} />
          <Row label="Akun Lawan" value={detail.akunLawanNama ?? '-'} />
          <Row label="Deskripsi" value={detail.keterangan ?? '-'} />
        </View>

        {detail.reversalOfId && (
          <View style={styles.infoBanner}>
            <Text style={styles.infoText}>Ini adalah transaksi koreksi dari transaksi lain.</Text>
          </View>
        )}

        {bisaDikoreksi && (
          <TouchableOpacity style={styles.koreksiButton} onPress={() => setModalKoreksi(true)}>
            <Text style={styles.koreksiButtonText}>Koreksi Transaksi</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <Modal visible={modalKoreksi} transparent animationType="fade" onRequestClose={() => setModalKoreksi(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Koreksi Transaksi</Text>
            <Text style={styles.modalHint}>
              Jurnal asli akan dibalik (reversal) dan tercatat sebagai transaksi koreksi baru — data
              lama tidak dihapus, tetap ada di riwayat & laporan.
            </Text>
            <FocusTextInput
              style={styles.modalInput}
              placeholder="Alasan koreksi..."
              value={alasan}
              onChangeText={setAlasan}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setModalKoreksi(false)}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirm}
                onPress={submitKoreksi}
                disabled={processing || !alasan.trim()}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalConfirmText}>Koreksi</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.lg, lineHeight: 18 },
  notFoundButton: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  notFoundButtonText: { color: colors.text, fontWeight: '600' },
  nomor: { fontSize: 13, color: colors.textMuted },
  nominal: { fontSize: 24, fontWeight: '700', color: colors.primary, marginTop: 4, marginBottom: spacing.lg },
  negative: { color: colors.danger },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { color: colors.textMuted },
  rowValue: { color: colors.text, flex: 1, textAlign: 'right' },
  infoBanner: { backgroundColor: '#FFF3E0', borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  infoText: { fontSize: 12, color: colors.warning },
  koreksiButton: { borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  koreksiButtonText: { color: colors.danger, fontWeight: '700' },
  modalOverlay: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title, marginBottom: spacing.sm },
  modalHint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 18 },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline, marginBottom: spacing.lg },
  modalActions: { ...modalUi.actions },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { ...modalUi.secondaryText },
  modalConfirm: { backgroundColor: colors.danger, paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm },
  modalConfirmText: { color: colors.white, fontWeight: '700' },
});
