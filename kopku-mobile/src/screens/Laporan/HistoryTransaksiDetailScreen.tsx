import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getHistoryDetail, batalkanTransaksiHistory, HistoryTransaksiDetail } from '@/services/HistoryTransaksiService';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import FormKoreksiTransaksi from '@/components/koreksi/FormKoreksiTransaksi';
import { LABEL_JENIS_KOREKSI } from '@/services/KoreksiTransaksiService';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  POSTED: 'Aktif',
  VOID: 'Dibatalkan',
  REVERSED: 'Dikoreksi',
};

/**
 * Detail satu transaksi dari History Transaksi (Phase 18 §8/§9/§10).
 * Menampilkan seluruh baris jurnal (debit/kredit per akun) + status
 * boleh/tidaknya diedit/dihapus dengan ALASAN yang jelas (dihitung di
 * `getHistoryDetail`, lihat komentar di sana). Tombol Edit HANYA
 * untuk transaksi yang punya jalur edit-dengan-data-baru sungguhan
 * (RAK, lewat RAKFormScreen existing); tombol Batalkan tersedia untuk
 * semua transaksi yang routable (kas/bank/RAK/simpanan) lewat
 * `batalkanTransaksiHistory` — ROUTER ke fungsi koreksi service yang
 * SUDAH ADA, bukan implementasi baru.
 */
export default function HistoryTransaksiDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEditPermission = can('history_transaksi', 'edit');
  // Bug fix (pola sama seperti AsetEditFormScreen): `route.params` bisa
  // undefined kalau layar dibuka tanpa parameter — destructuring
  // langsung sebelumnya melempar crash "Cannot destructure property
  // 'journalId' of 'route.params' as it is undefined".
  const { journalId } = route.params ?? {};

  const [detail, setDetail] = useState<HistoryTransaksiDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [modalBatalkan, setModalBatalkan] = useState(false);
  const [alasan, setAlasan] = useState('');
  const [processing, setProcessing] = useState(false);
  /** RC-S133.6.2 — form koreksi setoran simpanan / pencairan / angsuran. */
  const [formKoreksi, setFormKoreksi] = useState(false);

  const load = useCallback(async () => {
    if (!journalId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const d = await getHistoryDetail(journalId);
      setDetail(d);
      if (!d) setNotFound(true);
    } catch (e) {
      // Bug fix: sebelumnya error apa pun di sini tidak ditangani sama
      // sekali — layar diam di spinner selamanya. Sekarang ditampilkan
      // sebagai pesan jelas, bukan try/catch kosong.
      setNotFound(true);
      notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat detail transaksi.');
    } finally {
      setLoading(false);
    }
  }, [journalId]);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Diganti (bukan
  // ditambahi) dengan refresh berbasis FOKUS supaya layar selalu
  // membaca state SQLite terkini. Tidak ada timer, tidak ada remount paksa.
  useFocusRefresh(() => {
    load();
  }, [load]);

  const submitBatalkan = async () => {
    if (!detail?.sumberRute || !currentUser || !alasan.trim()) return;
    setProcessing(true);
    try {
      await batalkanTransaksiHistory(detail.sumberRute, currentUser.id, alasan.trim());
      setModalBatalkan(false);
      setAlasan('');
      await load();
      notify('Berhasil', batalkanSuccessMessage);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  const bukaEdit = () => {
    if (!detail?.sumberRute) return;
    if (detail.sumberRute.table === 'rak_transaksi') {
      navigation.navigate('RAKForm', { rakId: detail.sumberRute.id });
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

  // Edit-dengan-data-baru (bukan cuma batalkan) baru tersedia untuk
  // RAK saat ini — lihat komentar batalkanTransaksiHistory di service.
  const bisaEditData = detail.canEdit && detail.sumberRute?.table === 'rak_transaksi';

  // Permintaan pengguna §3: untuk transaksi Rekening Antar Kantor (RAK)
  // saja, label "Batalkan" diganti menjadi "Tarik Dana RAK" (mekanisme
  // akuntansinya TIDAK berubah — tetap reversal jurnal lewat
  // `batalkanTransaksiHistory`, jurnal historis tidak dihapus). Jenis
  // transaksi lain (kas/bank/simpanan) tetap memakai teks "Batalkan"
  // seperti semula.
  const isRAK = detail.sumberRute?.table === 'rak_transaksi';
  const batalkanBtnLabel = isRAK ? 'Tarik Dana RAKU' : 'Batalkan Transaksi';
  const batalkanModalTitle = isRAK ? 'Tarik Dana RAKU?' : 'Batalkan Transaksi';
  const batalkanModalSub = isRAK
    ? 'Transaksi akan dibalik dan dana dikembalikan ke rekening asal. Jurnal transaksi ini akan di-reversal (bukan dihapus) — saldo/laporan akan otomatis kembali seperti sebelum transaksi ini.'
    : 'Jurnal transaksi ini akan di-reversal (bukan dihapus) lewat menu asal transaksi ini. Saldo/laporan akan otomatis kembali seperti sebelum transaksi ini.';
  const batalkanSubmitLabel = isRAK ? 'Tarik Dana RAKU' : 'Batalkan';
  const batalkanSuccessMessage = isRAK
    ? 'Dana RAKU berhasil ditarik (jurnal asli di-reversal, dana dikembalikan ke rekening asal).'
    : 'Transaksi berhasil dibatalkan/dikoreksi (jurnal asli di-reversal).';

  return (
    <View style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={styles.headerRow}>
          <Text style={styles.nomor}>{detail.nomorTransaksi}</Text>
          <Text
            style={[
              styles.statusBadge,
              detail.status === 'POSTED' ? styles.statusAktif : detail.status === 'REVERSED' ? styles.statusReversed : styles.statusLain,
            ]}
          >
            {STATUS_LABEL[detail.status] ?? detail.status}
          </Text>
        </View>
        <Text style={styles.jenisLabel}>{detail.jenisLabel}</Text>
        <Text style={styles.nominal}>{formatRupiah(detail.nominal)}</Text>

        <View style={styles.card}>
          <Row label="Tanggal" value={formatTanggalIndonesia(detail.tanggal)} />
          <Row label="Deskripsi" value={detail.deskripsi} />
          <Row label="Dibuat Oleh" value={detail.createdByNama ?? '-'} />
          {detail.periodeStatus && <Row label="Periode" value={detail.periodeStatus === 'CLOSED' ? 'Ditutup (CLOSED)' : 'Terbuka (OPEN)'} />}
        </View>

        <Text style={styles.sectionLabel}>Rincian Jurnal</Text>
        <View style={styles.card}>
          <View style={styles.lineHeader}>
            <Text style={[styles.lineHeaderText, { flex: 2 }]}>Akun</Text>
            <Text style={[styles.lineHeaderText, styles.numCol]}>Debit</Text>
            <Text style={[styles.lineHeaderText, styles.numCol]}>Kredit</Text>
          </View>
          {detail.lines.map((l, idx) => (
            <View key={idx} style={styles.lineRow}>
              <Text style={[styles.lineAkun, { flex: 2 }]}>
                {l.kodeAkun} — {l.namaAkun}
              </Text>
              <Text style={styles.numCol}>{l.debit > 0 ? formatRupiah(l.debit) : '-'}</Text>
              <Text style={styles.numCol}>{l.kredit > 0 ? formatRupiah(l.kredit) : '-'}</Text>
            </View>
          ))}
        </View>

        {detail.reversalOfId && (
          <View style={styles.infoBanner}>
            <Text style={styles.infoBannerText}>Ini adalah jurnal koreksi/reversal dari transaksi lain.</Text>
          </View>
        )}

        {/* RC-S133.6.2 — jejak koreksi: jurnal asal, pembalik, pengganti. */}
        {(detail.jejakKoreksi ?? []).map((k) => (
          <View key={k.id} style={styles.card} testID="jejak-koreksi">
            <Text style={styles.sectionLabel}>Jejak Koreksi — {LABEL_JENIS_KOREKSI[k.jenis]}</Text>
            <Row label="Alasan" value={k.alasan} />
            <Row label="Diotorisasi oleh" value={k.namaPengotorisasi ?? k.diotorisasiOleh} />
            <Row label="Waktu" value={new Date(k.createdAt).toLocaleString('id-ID')} />
            {[
              { label: 'Jurnal asal', id: k.journalAsalId, nomor: k.nomorJurnalAsal },
              { label: 'Jurnal pembalik', id: k.journalPembalikId, nomor: k.nomorJurnalPembalik },
              ...(k.journalPenggantiId ? [{ label: 'Jurnal pengganti', id: k.journalPenggantiId, nomor: k.nomorJurnalPengganti }] : []),
            ].map((t) => (
              <TouchableOpacity
                key={t.label}
                style={styles.row}
                disabled={t.id === detail.journalId}
                onPress={() => navigation.push('HistoryTransaksiDetail', { journalId: t.id })}
              >
                <Text style={styles.rowLabel}>{t.label}</Text>
                <Text style={[styles.rowValue, t.id !== detail.journalId && styles.tautan]}>
                  {t.nomor ?? t.id}
                  {t.id === detail.journalId ? ' (jurnal ini)' : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {!detail.canDelete && detail.aksiTidakTersediaAlasan && (
          <View style={styles.warnBanner}>
            <Ionicons name="information-circle-outline" size={16} color={colors.warning} />
            <Text style={styles.warnBannerText}>{detail.aksiTidakTersediaAlasan}</Text>
          </View>
        )}
      </ScrollView>

      {canEditPermission && detail.koreksiKhusus?.boleh && currentUser && (
        <View style={styles.actionBar}>
          <TouchableOpacity style={styles.batalkanBtn} onPress={() => setFormKoreksi(true)} testID="tombol-koreksi-transaksi">
            <Ionicons name="git-compare-outline" size={16} color={colors.white} />
            <Text style={styles.batalkanBtnText}>Koreksi Transaksi</Text>
          </TouchableOpacity>
        </View>
      )}
      {detail.koreksiKhusus && currentUser && formKoreksi && (
        <FormKoreksiTransaksi
          visible={formKoreksi}
          pemeriksaan={detail.koreksiKhusus}
          userId={currentUser.id}
          onClose={() => setFormKoreksi(false)}
          onSelesai={() => {
            setFormKoreksi(false);
            void load();
          }}
        />
      )}

      {canEditPermission && (detail.canDelete || bisaEditData) && (
        <View style={styles.actionBar}>
          {bisaEditData && (
            <TouchableOpacity style={styles.editBtn} onPress={bukaEdit}>
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <Text style={styles.editBtnText}>Edit</Text>
            </TouchableOpacity>
          )}
          {detail.canDelete && (
            <TouchableOpacity
              style={[styles.batalkanBtn, isRAK && styles.tarikDanaRakBtn]}
              onPress={() => {
                setAlasan('');
                setModalBatalkan(true);
              }}
            >
              <Ionicons name={isRAK ? 'swap-horizontal-outline' : 'close-circle-outline'} size={16} color={colors.white} />
              <Text style={styles.batalkanBtnText}>{batalkanBtnLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Modal visible={modalBatalkan} transparent animationType="fade" onRequestClose={() => setModalBatalkan(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{batalkanModalTitle}</Text>
            <Text style={styles.modalSub}>{batalkanModalSub}</Text>
            <FocusTextInput
              style={styles.modalInput}
              value={alasan}
              onChangeText={setAlasan}
              placeholder={isRAK ? 'Alasan penarikan dana (wajib diisi)' : 'Alasan pembatalan (wajib diisi)'}
              placeholderTextColor={colors.placeholder}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setModalBatalkan(false)}>
                <Text style={styles.modalCancelText}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, isRAK && styles.tarikDanaRakBtn, (!alasan.trim() || processing) && styles.disabled]}
                onPress={submitBatalkan}
                disabled={!alasan.trim() || processing}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>{batalkanSubmitLabel}</Text>}
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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nomor: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  statusBadge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  statusAktif: { backgroundColor: colors.primaryLight, color: colors.primary },
  statusReversed: { backgroundColor: '#FFF3E0', color: colors.warning },
  statusLain: { backgroundColor: colors.dangerBg, color: colors.danger },
  jenisLabel: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 6 },
  nominal: { fontSize: 24, fontWeight: '700', color: colors.primary, marginTop: 4, marginBottom: spacing.md, fontVariant: ['tabular-nums'] },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: spacing.sm, alignItems: 'flex-start' },
  rowLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 12, color: colors.text, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  lineHeader: { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  lineHeaderText: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  lineRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  lineAkun: { fontSize: 12, color: colors.text },
  numCol: { flex: 1, textAlign: 'right', fontSize: 12, color: colors.text },
  infoBanner: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  infoBannerText: { fontSize: 12, color: colors.primary },
  warnBanner: { flexDirection: 'row', gap: 6, backgroundColor: '#FFF3E0', borderRadius: radius.sm, padding: spacing.md, marginBottom: 40 },
  warnBannerText: { flex: 1, fontSize: 12, color: '#8A5300', lineHeight: 17 },
  actionBar: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  editBtn: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.primary },
  editBtnText: { color: colors.primary, fontWeight: '700' },
  batalkanBtn: { flex: 2, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: radius.sm, backgroundColor: colors.danger },
  batalkanBtnText: { color: colors.white, fontWeight: '700' },
  // Permintaan pengguna §3: tombol RAK dibedakan warnanya (bukan merah
  // "danger" seperti Batalkan biasa) supaya jelas ini aksi berbeda —
  // "Tarik Dana RAK" adalah pemindahan dana kembali, bukan pembatalan.
  tarikDanaRakBtn: { backgroundColor: colors.warning },
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
  disabled: { opacity: 0.6 },
  tautan: { color: colors.primary, textDecorationLine: 'underline' },
});
