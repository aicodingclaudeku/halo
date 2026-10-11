import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet, RefreshControl, TouchableOpacity, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listInvestasi, batalkanInvestasi, InvestasiListItem, JenisInvestasi, LABEL_JENIS_INVESTASI } from '@/services/InvestasiService';
import {
  lepaskanInvestasi,
  pratinjauPelepasanInvestasi,
  PratinjauPelepasanInvestasi,
  PelepasanInvestasiInput,
} from '@/services/PelepasanInvestasiService';
import RekeningPicker from '@/components/RekeningPicker';
import { RekeningItem } from '@/services/KasBankService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import ExportButton from '@/components/ExportButton';
import FocusTextInput from '@/components/FocusTextInput';
import { buildDaftarInvestasiExport } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';

// Audit ulang (permintaan pengguna §3): label jenis investasi SEKARANG
// satu sumber kebenaran di InvestasiService.ts (LABEL_JENIS_INVESTASI)
// — tidak lagi didefinisikan ulang di layar ini, supaya label baru
// (Usaha Lain, Tabungan, Giro, Deposito, Properti
// Investasi) otomatis konsisten di semua tempat.

/**
 * "Daftar Investasi" (F1, hub "Rincian Laporan Lainnya").
 *
 * Update pasca-Phase 18 §11 (permintaan pengguna): Edit/Delete/Export
 * ditambahkan (sebelumnya read-only murni). Edit & Batalkan memakai
 * `InvestasiService` existing (`editInvestasi`/`batalkanInvestasi`,
 * pola sama RAKService) — reversal jurnal, BUKAN hard-delete. Investasi
 * yang sudah dibatalkan tetap tampil (dicoret) untuk audit trail.
 * Investasi Unit Usaha Internal TETAP tidak tersedia untuk transaksi
 * BARU (Phase 18 §2) — baik lewat tombol tambah maupun Edit.
 */
export default function DaftarInvestasiScreen() {
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEdit = can('kas_bank', 'edit');
  const canExport = can('kas_bank', 'export');

  const [data, setData] = useState<InvestasiListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalTarget, setModalTarget] = useState<InvestasiListItem | null>(null);
  const [alasan, setAlasan] = useState('');
  const [processing, setProcessing] = useState(false);

  // RC-S54 T16 #20 — PELEPASAN_INVESTASI ("Jual Kembali"/"Cairkan"): operasi TERPISAH dari
  // koreksi. Hasil pelepasan diketik pengguna (tidak pernah diisi dari biaya perolehan);
  // pratinjau dan eksekusi memakai input yang sama persis.
  const [lepasTarget, setLepasTarget] = useState<InvestasiListItem | null>(null);
  const [lepasTanggal, setLepasTanggal] = useState(getTanggalLokalHariIni());
  const [lepasHasil, setLepasHasil] = useState('');
  const [lepasRekening, setLepasRekening] = useState<RekeningItem | null>(null);
  const [pratinjau, setPratinjau] = useState<PratinjauPelepasanInvestasi | null>(null);
  const [pratinjauError, setPratinjauError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setData(await listInvestasi());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar investasi.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => load(false));
    return unsub;
  }, [navigation, load]);

  const totalInvestasi = data.filter((d) => d.status === 'AKTIF').reduce((acc, d) => acc + d.jumlah, 0);

  const submitBatalkan = async () => {
    if (!modalTarget || !currentUser || !alasan.trim()) return;
    setProcessing(true);
    try {
      await batalkanInvestasi(modalTarget.id, currentUser.id, alasan.trim());
      setModalTarget(null);
      setAlasan('');
      await load();
      notify('Berhasil', 'Koreksi salah input dicatat (jurnal penempatan di-reversal, saldo dikembalikan).');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  // RC-S54 T16 GAP 1: pesan service berbentuk "KODE: pesan" — tampilkan bagian pesan saja.
  const pesanPengguna = (e: unknown, cadangan: string) => {
    const m = e instanceof Error ? e.message : cadangan;
    return m.replace(/^[A-Z][A-Z0-9_]+:\s*/, '');
  };
  const angkaHasil = lepasHasil.replace(/[^0-9]/g, '');
  const hasilPositif = angkaHasil !== '' && Number(angkaHasil) > 0;
  const statusValidasi = pratinjau
    ? 'Valid — pratinjau sesuai input, siap dikonfirmasi.'
    : pratinjauError ?? 'Belum divalidasi — jalankan Hitung Pratinjau.';

  const bukaPelepasan = (item: InvestasiListItem) => {
    setLepasTarget(item);
    setLepasTanggal(getTanggalLokalHariIni());
    setLepasHasil('');
    setLepasRekening(null);
    setPratinjau(null);
    setPratinjauError(null);
  };

  const inputPelepasan = (): PelepasanInvestasiInput | null => {
    if (!lepasTarget || !currentUser) return null;
    const angka = lepasHasil.replace(/[^0-9]/g, '');
    if (angka === '') return null;
    const hasil = Number(angka);
    return {
      investasiId: lepasTarget.id,
      tanggalPelepasan: lepasTanggal.trim(),
      hasilPelepasan: hasil,
      sumberDana: hasil > 0 && lepasRekening ? (lepasRekening.jenis === 'BANK' ? 'BANK' : 'KAS') : undefined,
      bankAccountId: hasil > 0 && lepasRekening?.jenis === 'BANK' ? lepasRekening.id : undefined,
      createdBy: currentUser.id,
    };
  };

  const hitungPratinjau = async () => {
    const input = inputPelepasan();
    setPratinjau(null);
    setPratinjauError(null);
    if (!input) {
      setPratinjauError('Isi Hasil Pelepasan (boleh 0) dan tanggal pelepasan.');
      return;
    }
    try {
      setPratinjau(await pratinjauPelepasanInvestasi(input));
    } catch (e) {
      setPratinjauError(pesanPengguna(e, 'Pratinjau gagal.'));
    }
  };

  const konfirmasiPelepasan = async () => {
    const input = inputPelepasan();
    if (!input || !pratinjau) return;
    setProcessing(true);
    try {
      const { pratinjau: hasil } = await lepaskanInvestasi(input);
      setPratinjau(null);
      setLepasTarget(null);
      await load();
      notify(
        'Berhasil',
        `Pelepasan dicatat. Hasil ${formatRupiah(hasil.hasilPelepasan)}, nilai tercatat ${formatRupiah(hasil.nilaiTercatat)}, ` +
          `${hasil.jenisSelisih === 'LABA' ? `laba ${formatRupiah(hasil.selisih)}` : hasil.jenisSelisih === 'RUGI' ? `rugi ${formatRupiah(-hasil.selisih)}` : 'impas'}.`
      );
    } catch (e) {
      setPratinjau(null);
      notify('Gagal', pesanPengguna(e, 'Terjadi kesalahan.'));
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

  // Permintaan pengguna §10: teks modal & tombol menyesuaikan jenis
  // investasi target (Properti Investasi -> "Jual Kembali", lainnya
  // tetap "Cairkan").
  const modalIsProperti = modalTarget?.jenisInvestasi === 'PROPERTI_INVESTASI';
  // RC-S54 T16 #20: modal ini kini HANYA untuk KOREKSI_SALAH_INPUT (batalkanInvestasi).
  const modalTitle = 'Koreksi Salah Input Investasi';
  const modalSub =
    'Hanya untuk transaksi yang SALAH INPUT. Jurnal penempatan semula di-reversal (bukan dihapus) seolah transaksi tidak pernah terjadi — ' +
    'BUKAN penjualan/pencairan dan tanpa laba/rugi. Investasi yang sudah disusutkan atau diturunkan nilainya tidak dapat dikoreksi di sini; ' +
    `untuk menjual/mencairkan gunakan tombol ${modalIsProperti ? '"Jual Kembali"' : '"Cairkan"'}.`;
  const modalPlaceholder = 'Alasan koreksi (wajib diisi)';
  const modalSubmitLabel = 'Koreksi';

  return (
    <>
    <FlatList keyboardShouldPersistTaps="handled"
      style={styles.container}
      data={data}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      ListHeaderComponent={
        <>
          {data.length > 0 && (
            <View style={styles.totalCard}>
              <Text style={styles.totalLabel}>Total Investasi Aktif</Text>
              <Text style={styles.totalValue}>{formatRupiah(totalInvestasi)}</Text>
              <Text style={styles.totalSub}>{data.length} transaksi investasi</Text>
            </View>
          )}
          {canExport && (
            <ExportButton
              data={
                koperasi && data.length > 0
                  ? buildDaftarInvestasiExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data)
                  : null
              }
            />
          )}
        </>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <Text style={styles.emptyText}>Belum ada investasi yang dicatat. Catat lewat menu Pengeluaran &gt; Investasi Koperasi.</Text>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <View style={[styles.card, item.status === 'DIBATALKAN' && styles.cardDibatalkan]}>
          <View style={styles.cardHeader}>
            <Text style={styles.nomor}>{item.nomorInvestasi}</Text>
            <Text style={[styles.jenisBadge, item.jenisInvestasi === 'UNIT_USAHA' ? styles.badgeUnitUsaha : styles.badgeKoperasiLain]}>
              {LABEL_JENIS_INVESTASI[item.jenisInvestasi]}
            </Text>
          </View>
          <Text style={styles.namaTujuan}>{item.namaTujuan}</Text>
          {item.nomorRekeningInvestasi ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Nomor Rekening</Text>
              <Text style={styles.rowValue}>{item.nomorRekeningInvestasi}</Text>
            </View>
          ) : null}
          {item.lokasiProperti ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Lokasi</Text>
              <Text style={styles.rowValue}>{item.lokasiProperti}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Tanggal</Text>
            <Text style={styles.rowValue}>{item.tanggal}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Jumlah</Text>
            <Text style={styles.rowValueBold}>{formatRupiah(item.jumlah)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Sumber Dana</Text>
            <Text style={styles.rowValue}>{item.sumberDana === 'BANK' ? 'Bank' : 'Kas'}</Text>
          </View>
          {item.keterangan ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Keterangan</Text>
              <Text style={styles.rowValue}>{item.keterangan}</Text>
            </View>
          ) : null}
          {/* Status internal DIBATALKAN dipertahankan (backward compat) —
              hanya label bisnis/UI yang tampil ke user diubah. Properti
              Investasi (permintaan pengguna §10) memakai "DIJUAL
              KEMBALI"; jenis lain tetap "DICAIRKAN" (permintaan
              pengguna §6, sesi sebelumnya). */}
          {item.status === 'DIBATALKAN' && <Text style={styles.statusDibatalkan}>DIKOREKSI (SALAH INPUT)</Text>}
          {item.status === 'DILEPAS' && (
            <Text style={styles.statusDibatalkan}>{item.jenisInvestasi === 'PROPERTI_INVESTASI' ? 'DIJUAL KEMBALI' : 'DICAIRKAN'}</Text>
          )}

          {/* Audit ulang §2/§5/§11: Edit sekarang tersedia untuk SEMUA
              jenis investasi input yang valid (bukan cuma KOPERASI_LAIN
              lagi) — jenisnya sendiri tetap tidak bisa diganti saat edit
              (lihat komentar InvestasiService.editInvestasi). Investasi
              Unit Usaha Internal (legacy) TETAP TIDAK bisa diedit —
              hanya bisa dibatalkan. */}
          {canEdit && item.status === 'AKTIF' && (
            <View style={styles.actionRow}>
              {item.jenisInvestasi !== 'UNIT_USAHA' && (
                <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('InvestasiForm', { investasiId: item.id })}>
                  <Ionicons name="create-outline" size={16} color={colors.primary} />
                  <Text style={styles.actionText}>Edit</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => {
                  setModalTarget(item);
                  setAlasan('');
                }}
              >
                <Ionicons name="return-down-back-outline" size={16} color={colors.textMuted} />
                <Text style={[styles.actionText, { color: colors.textMuted }]}>Koreksi</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={() => bukaPelepasan(item)}>
                {/* Permintaan pengguna §10: khusus Properti Investasi,
                    "Cairkan" -> "Jual Kembali" (Properti tidak "dicairkan"
                    seperti tabungan/deposito, melainkan dijual). Jenis
                    investasi lain TETAP memakai "Cairkan" seperti semula.
                    RC-S54 T16 #20: tombol ini menjalankan PELEPASAN_INVESTASI
                    (lepaskanInvestasi), BUKAN batalkanInvestasi. */}
                <Ionicons name="cash-outline" size={16} color={colors.danger} />
                <Text style={[styles.actionText, { color: colors.danger }]}>
                  {item.jenisInvestasi === 'PROPERTI_INVESTASI' ? 'Jual Kembali' : 'Cairkan'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    />

    <Modal visible={!!modalTarget} transparent animationType="fade" onRequestClose={() => setModalTarget(null)}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{modalTitle}</Text>
          <Text style={styles.modalSub}>{modalSub}</Text>
          <FocusTextInput
            style={styles.modalInput}
            value={alasan}
            onChangeText={setAlasan}
            placeholder={modalPlaceholder}
            placeholderTextColor={colors.placeholder}
            multiline
          />
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setModalTarget(null)}>
              <Text style={styles.modalCancelText}>Tutup</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalSubmitBtn, (!alasan.trim() || processing) && styles.disabled]}
              onPress={submitBatalkan}
              disabled={!alasan.trim() || processing}
            >
              {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>{modalSubmitLabel}</Text>}
            </TouchableOpacity>
          </View>
        </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>

    <Modal visible={!!lepasTarget} transparent animationType="fade" onRequestClose={() => setLepasTarget(null)}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>
            {lepasTarget?.jenisInvestasi === 'PROPERTI_INVESTASI' ? 'Jual Kembali Properti Investasi' : 'Cairkan Investasi'}
          </Text>
          <Text style={styles.modalSub}>
            {lepasTarget?.namaTujuan} ({lepasTarget?.nomorInvestasi}). Pelepasan dicatat sebagai transaksi baru pada tanggal pelepasan:
            aset, akumulasi penyusutan, dan penurunan nilai investasi ini dikeluarkan, lalu laba/rugi = Hasil Pelepasan − Nilai Tercatat.
          </Text>
          <Text style={styles.rowLabel}>Tanggal Pelepasan (YYYY-MM-DD)</Text>
          <FocusTextInput
            style={styles.modalInputSingle}
            value={lepasTanggal}
            onChangeText={(t) => { setLepasTanggal(t); setPratinjau(null); setPratinjauError(null); }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.placeholder}
          />
          <Text style={styles.rowLabel}>Hasil Pelepasan (Rp, wajib diisi, boleh 0)</Text>
          <FocusTextInput
            style={styles.modalInputSingle}
            value={lepasHasil}
            onChangeText={(t) => {
              setLepasHasil(t);
              setPratinjau(null);
              setPratinjauError(null);
              // Hasil 0/kosong: tidak ada penerimaan kas, rekening dikosongkan.
              if (!(Number(t.replace(/[^0-9]/g, '')) > 0)) setLepasRekening(null);
            }}
            keyboardType="number-pad"
            placeholder="Nilai yang benar-benar diterima"
            placeholderTextColor={colors.placeholder}
          />
          {hasilPositif && (
            <RekeningPicker label="Rekening Penerima (wajib bila hasil > 0)" value={lepasRekening} onChange={(r) => { setLepasRekening(r); setPratinjau(null); setPratinjauError(null); }} />
          )}
          <TouchableOpacity style={[styles.modalCancelBtn, { marginTop: spacing.sm }]} onPress={hitungPratinjau}>
            <Text style={styles.modalCancelText}>Hitung Pratinjau</Text>
          </TouchableOpacity>
          <Text style={pratinjau ? styles.rowLabel : styles.errorText}>Status validasi: {statusValidasi}</Text>
          {pratinjau && (
            <View style={{ marginTop: spacing.sm }}>
              <View style={styles.row}><Text style={styles.rowLabel}>Nomor Investasi</Text><Text>{pratinjau.nomorInvestasi}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Tanggal Pelepasan</Text><Text>{pratinjau.tanggalPelepasan}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Rekening Penerima</Text><Text>{pratinjau.hasilPelepasan > 0 ? lepasRekening?.nama ?? '-' : 'Tidak ada (hasil 0)'}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Nilai Perolehan</Text><Text>{formatRupiah(pratinjau.biayaPerolehan)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Akumulasi Penyusutan</Text><Text>{formatRupiah(pratinjau.akumulasiPenyusutan)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Penurunan Nilai</Text><Text>{formatRupiah(pratinjau.akumulasiImpairment)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Nilai Tercatat</Text><Text>{formatRupiah(pratinjau.nilaiTercatat)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Hasil Pelepasan</Text><Text>{formatRupiah(pratinjau.hasilPelepasan)}</Text></View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Laba/Rugi Pelepasan</Text>
                <Text>
                  {pratinjau.jenisSelisih === 'LABA'
                    ? `Laba ${formatRupiah(pratinjau.selisih)}`
                    : pratinjau.jenisSelisih === 'RUGI'
                      ? `Rugi ${formatRupiah(-pratinjau.selisih)}`
                      : 'Impas'}
                </Text>
              </View>
            </View>
          )}
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setLepasTarget(null)}>
              <Text style={styles.modalCancelText}>Tutup</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalSubmitBtn, (!pratinjau || processing) && styles.disabled]}
              onPress={konfirmasiPelepasan}
              disabled={!pratinjau || processing}
            >
              {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Konfirmasi Pelepasan</Text>}
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  totalCard: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    alignItems: 'center',
  },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 4 },
  totalSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardDibatalkan: { opacity: 0.55 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nomor: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  jenisBadge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  badgeUnitUsaha: { backgroundColor: '#E3F2FD', color: '#1565C0' },
  badgeKoperasiLain: { backgroundColor: '#FFF3E0', color: '#E65100' },
  namaTujuan: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  rowLabel: { fontSize: 12, color: colors.textMuted },
  rowValue: { fontSize: 12, color: colors.text },
  rowValueBold: { fontSize: 13, color: colors.text, fontWeight: '700' },
  statusDibatalkan: { fontSize: 11, fontWeight: '700', color: colors.danger, marginTop: 6 },
  actionRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSub: { ...modalUi.description },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  // INPUT STANDARDIZATION — isian SATU BARIS di modal (tanggal, hasil
  // pelepasan) sebelumnya ikut memakai `modalInput` multiline, sehingga
  // kotak tanggal setinggi 88 dp dengan teks rata atas.
  modalInputSingle: { ...formUi.inputStandalone },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.destructiveButton },
  modalSubmitText: { ...modalUi.primaryText },
  disabled: { opacity: 0.6 },
});
