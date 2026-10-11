import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import InvestasiPicker from '@/components/InvestasiPicker';
import RekeningPicker from '@/components/RekeningPicker';
import DatePicker from '@/components/DatePicker';
import CurrencyInput from '@/components/CurrencyInput';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { InvestasiListItem, LABEL_JENIS_INVESTASI } from '@/services/InvestasiService';
import { RekeningItem } from '@/services/KasBankService';
import {
  catatBagianShuInvestasi,
  catatPenerimaanBagianShu,
  listBagianShuInvestasi,
  BagianShuRow,
} from '@/services/BagianShuService';
import { useAppStore } from '@/store/useAppStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { JENIS_INVESTASI_BAGIAN_SHU } from '@/config/pendapatanKoperasiPolicy';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * BAGIAN SHU INVESTASI — RC-S53 (KEPUTUSAN 04-A & 05).
 *
 * Layar ini TIDAK memegang logika akuntansi sama sekali. Ia hanya
 * mengumpulkan input, memvalidasinya, lalu memanggil
 * `BagianShuService`. Seluruh penjurnalan terjadi di service lewat
 * `AccountingEngine.createJournal()` — tidak ada satu pun SQL di
 * berkas ini.
 *
 * DUA PERISTIWA YANG SENGAJA DIPISAH:
 *
 *   1. AKUI BAGIAN SHU — hak koperasi diakui setelah investee resmi
 *      menetapkan pembagian DAN koperasi memegang buktinya. Karena
 *      itu jenis, nomor, dan tanggal dokumen adalah field WAJIB, bukan
 *      pelengkap.
 *
 *   2. TERIMA PEMBAYARAN — kas masuk, piutang berkurang. Layar ini
 *      TIDAK pernah menyentuh akun pendapatan; pendapatannya sudah
 *      diakui pada langkah 1. Itulah yang mencegah pendapatan
 *      terhitung dua kali, dan aturan itu ditegakkan di service, bukan
 *      di sini.
 *
 * Status baris mengikuti apa yang dikembalikan service — layar tidak
 * pernah menghitung atau mengubah status sendiri.
 */

type Tab = 'AKUI' | 'RIWAYAT';

interface FormErrors {
  investasi?: string;
  jumlah?: string;
  jenisDokumen?: string;
  nomorDokumen?: string;
  tanggalDokumen?: string;
}

interface TerimaErrors {
  rekening?: string;
  jumlah?: string;
  nomorReferensi?: string;
}

function labelStatus(row: BagianShuRow): string {
  if (row.status === 'LUNAS') return 'DITERIMA';
  return row.jumlahDiterima > 0 ? 'SEBAGIAN' : 'DIAKUI';
}

export default function BagianShuFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [tab, setTab] = useState<Tab>('AKUI');

  // ---- form pengakuan ----------------------------------------------------
  const [investasi, setInvestasi] = useState<InvestasiListItem | null>(null);
  const [tanggalHak, setTanggalHak] = useState(getTanggalLokalHariIni());
  const [jenisDokumen, setJenisDokumen] = useState('');
  const [nomorDokumen, setNomorDokumen] = useState('');
  const [tanggalDokumen, setTanggalDokumen] = useState(getTanggalLokalHariIni());
  const [jumlah, setJumlah] = useState<number | ''>('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // ---- riwayat & penerimaan ---------------------------------------------
  const [riwayat, setRiwayat] = useState<BagianShuRow[]>([]);
  const [loadingRiwayat, setLoadingRiwayat] = useState(false);
  const [terimaUntuk, setTerimaUntuk] = useState<BagianShuRow | null>(null);
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggalTerima, setTanggalTerima] = useState(getTanggalLokalHariIni());
  const [jumlahTerima, setJumlahTerima] = useState<number | ''>('');
  const [nomorReferensi, setNomorReferensi] = useState('');
  const [terimaErrors, setTerimaErrors] = useState<TerimaErrors>({});
  const [submittingTerima, setSubmittingTerima] = useState(false);

  const muatRiwayat = useCallback(() => {
    setLoadingRiwayat(true);
    listBagianShuInvestasi()
      .then(setRiwayat)
      .catch((e) => notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.'))
      .finally(() => setLoadingRiwayat(false));
  }, []);

  useFocusRefresh(muatRiwayat);

  // ========================================================================
  // PENGAKUAN
  // ========================================================================

  const validate = (): boolean => {
    const e: FormErrors = {};
    if (!investasi) e.investasi = 'Pilih investasi yang membagikan SHU';
    if (jumlah === '' || jumlah <= 0) e.jumlah = 'Nominal bagian SHU wajib diisi, lebih dari 0';
    if (!jenisDokumen.trim()) e.jenisDokumen = 'Jenis dokumen bukti hak wajib diisi';
    if (!nomorDokumen.trim()) e.nomorDokumen = 'Nomor dokumen bukti hak wajib diisi';
    if (!tanggalDokumen) e.tanggalDokumen = 'Tanggal dokumen wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const akui = async () => {
    if (!validate()) return;
    if (!investasi || !currentUser || jumlah === '') return;
    setSubmitting(true);
    try {
      await catatBagianShuInvestasi({
        investasiId: investasi.id,
        tanggalHak,
        jumlah,
        jenisDokumen: jenisDokumen.trim(),
        nomorDokumen: nomorDokumen.trim(),
        tanggalDokumen,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Bagian SHU diakui sebagai piutang dan jurnalnya sudah diposting.', [
        {
          text: 'OK',
          onPress: () => {
            setInvestasi(null);
            setJumlah('');
            setJenisDokumen('');
            setNomorDokumen('');
            setErrors({});
            setTab('RIWAYAT');
            muatRiwayat();
          },
        },
      ]);
    } catch (e) {
      // Duplikat, periode tertutup, dan investasi non-aktif semuanya
      // ditolak service — pesannya ditampilkan apa adanya supaya
      // pengguna tahu alasan sebenarnya.
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // ========================================================================
  // PENERIMAAN
  // ========================================================================

  const bukaTerima = (row: BagianShuRow) => {
    setTerimaUntuk(row);
    setRekening(null);
    setTanggalTerima(getTanggalLokalHariIni());
    setJumlahTerima(row.sisaPiutang);
    setNomorReferensi('');
    setTerimaErrors({});
  };

  const validateTerima = (): boolean => {
    const e: TerimaErrors = {};
    if (!rekening) e.rekening = 'Pilih rekening kas atau bank tujuan';
    // AUDIT FIX RC-S53 — Kas Kecil ikut muncul di picker, tetapi register
    // penerimaan hanya mengenal Kas Umum dan bank. Menerimanya di sini
    // akan membuat jurnal mendebit Kas Umum padahal yang dipilih Kas
    // Kecil, jadi ditolak di depan dengan alasan yang jelas.
    if (rekening && rekening.jenis !== 'BANK' && rekening.jenis !== 'KAS') {
      e.rekening = 'Penerimaan bagian SHU hanya ke Kas Umum atau rekening bank';
    }
    if (jumlahTerima === '' || jumlahTerima <= 0) e.jumlah = 'Nominal penerimaan wajib diisi, lebih dari 0';
    if (terimaUntuk && jumlahTerima !== '' && jumlahTerima > terimaUntuk.sisaPiutang) {
      e.jumlah = `Tidak boleh melebihi sisa piutang (${formatRupiah(terimaUntuk.sisaPiutang)})`;
    }
    if (!nomorReferensi.trim()) e.nomorReferensi = 'Nomor referensi penerimaan wajib diisi';
    setTerimaErrors(e);
    return Object.keys(e).length === 0;
  };

  const terima = async () => {
    if (!validateTerima()) return;
    if (!terimaUntuk || !rekening || !currentUser || jumlahTerima === '') return;
    setSubmittingTerima(true);
    try {
      await catatPenerimaanBagianShu({
        bagianShuId: terimaUntuk.id,
        tanggal: tanggalTerima,
        jumlah: jumlahTerima,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        // aman: validateTerima() sudah menolak jenis rekening selain
        // KAS dan BANK, jadi cabang 'KAS' di sini tidak pernah menampung
        // Kas Kecil.
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        nomorReferensi: nomorReferensi.trim(),
        createdBy: currentUser.id,
      });
      setTerimaUntuk(null);
      notify('Berhasil', 'Penerimaan dicatat. Piutang berkurang; pendapatan tidak diakui ulang.');
      muatRiwayat();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmittingTerima(false);
    }
  };

  // ========================================================================
  // RENDER
  // ========================================================================

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {(['AKUI', 'RIWAYAT'] as Tab[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabAktif]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextAktif]}>
              {t === 'AKUI' ? 'Akui Bagian SHU' : 'Riwayat'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'AKUI' ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.body} contentContainerStyle={{ padding: spacing.lg }}>
          <Text style={styles.catatan}>
            Bagian SHU diakui saat koperasi tempat dana ditempatkan RESMI menetapkan pembagiannya
            dan koperasi memegang buktinya — bukan saat kas diterima, bukan dari estimasi.
          </Text>

          {/* Hanya penyertaan pada koperasi lain yang aktif; service tetap memvalidasi ulang. */}
          <InvestasiPicker
            value={investasi}
            onChange={setInvestasi}
            error={errors.investasi}
            onlyJenisInvestasi={JENIS_INVESTASI_BAGIAN_SHU}
            emptyTitle="Belum Ada Penyertaan pada Koperasi Lain"
            emptyMessage="Tidak ada investasi aktif yang memenuhi syarat untuk pencatatan Bagian SHU."
          />

          {investasi && (
            <View style={styles.infoBox}>
              <Text style={styles.infoLabel}>Jenis Investasi</Text>
              <Text style={styles.infoValue}>
                {LABEL_JENIS_INVESTASI[investasi.jenisInvestasi] ?? investasi.jenisInvestasi}
              </Text>
              <Text style={[styles.infoLabel, { marginTop: spacing.sm }]}>Nilai Penempatan</Text>
              <Text style={styles.infoValue}>{formatRupiah(investasi.jumlah)}</Text>
            </View>
          )}

          <Text style={styles.label}>Tanggal Hak *</Text>
          <DatePicker value={tanggalHak} onChange={setTanggalHak} maximumDate={getWaktuSekarang()} />
          <Text style={styles.hintText}>
            Tanggal investee menetapkan pembagian SHU — inilah tanggal pengakuan pendapatan.
          </Text>

          <Text style={[styles.label, { marginTop: spacing.md }]}>Jenis Dokumen Bukti *</Text>
          <FocusTextInput
            style={styles.input}
            value={jenisDokumen}
            onChangeText={setJenisDokumen}
            placeholder="mis. Berita Acara RAT atau Keputusan Pembagian SHU"
            placeholderTextColor={colors.placeholder}
            invalid={!!errors.jenisDokumen}
          />
          {errors.jenisDokumen && <FieldError message={errors.jenisDokumen} />}

          <Text style={[styles.label, { marginTop: spacing.md }]}>Nomor Dokumen *</Text>
          <FocusTextInput
            style={styles.input}
            value={nomorDokumen}
            onChangeText={setNomorDokumen}
            placeholder="Nomor berita acara / keputusan"
            placeholderTextColor={colors.placeholder}
            invalid={!!errors.nomorDokumen}
          />
          {errors.nomorDokumen && <FieldError message={errors.nomorDokumen} />}

          <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Dokumen *</Text>
          <DatePicker value={tanggalDokumen} onChange={setTanggalDokumen} maximumDate={getWaktuSekarang()} />
          {errors.tanggalDokumen && <Text style={styles.errorText}>{errors.tanggalDokumen}</Text>}

          <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal Bagian SHU *</Text>
          <CurrencyInput value={jumlah} onChangeValue={setJumlah} error={errors.jumlah} />

          <View style={styles.jurnalBox}>
            <Text style={styles.jurnalJudul}>Jurnal yang akan dibuat</Text>
            <View style={styles.journalRow}>
              <Text style={styles.journalDebit}>DEBIT</Text>
              <Text style={styles.journalAkun}>Piutang Pendapatan Investasi</Text>
              <Text style={styles.journalNominal}>{formatRupiah(jumlah === '' ? 0 : jumlah)}</Text>
            </View>
            <View style={styles.journalRow}>
              <Text style={styles.journalKredit}>KREDIT</Text>
              <Text style={styles.journalAkun}>Pendapatan Hasil Investasi</Text>
              <Text style={styles.journalNominal}>{formatRupiah(jumlah === '' ? 0 : jumlah)}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.disabled]}
            onPress={akui}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.submitButtonText}>Akui Bagian SHU</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.body} contentContainerStyle={{ padding: spacing.lg }}>
          {loadingRiwayat && <ActivityIndicator style={{ marginBottom: spacing.md }} />}
          {!loadingRiwayat && riwayat.length === 0 && (
            <Text style={styles.kosong}>Belum ada bagian SHU yang diakui.</Text>
          )}
          {riwayat.map((row) => (
            <View key={row.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardJudul}>{row.namaTujuan}</Text>
                <View style={[styles.badge, row.status === 'LUNAS' && styles.badgeLunas]}>
                  <Text style={styles.badgeText}>{labelStatus(row)}</Text>
                </View>
              </View>
              <Text style={styles.cardBaris}>Tanggal hak: {row.tanggalHak}</Text>
              <Text style={styles.cardBaris}>Jenis hasil: Bagian SHU</Text>
              <Text style={styles.cardBaris}>
                {row.jenisDokumen} · {row.nomorDokumen} · {row.tanggalDokumen}
              </Text>
              <Text style={styles.cardBaris}>Journal ID: {row.journalId}</Text>
              <View style={styles.nominalRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.infoLabel}>Diakui</Text>
                  <Text style={styles.infoValue}>{formatRupiah(row.jumlah)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.infoLabel}>Sisa Piutang</Text>
                  <Text style={styles.infoValue}>{formatRupiah(row.sisaPiutang)}</Text>
                </View>
              </View>
              {row.sisaPiutang > 0 && (
                <TouchableOpacity style={styles.terimaButton} onPress={() => bukaTerima(row)}>
                  <Ionicons name="wallet-outline" size={16} color={colors.white} />
                  <Text style={styles.terimaButtonText}>Terima Pembayaran</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={!!terimaUntuk} animationType="slide" transparent onRequestClose={() => setTerimaUntuk(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.areaKeyboard}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              {/*
                RC-S120 — kartu ini memuat empat isian dan dua tombol di
                dalam `modalUi.card` yang `maxHeight: '90%'`. Tanpa
                ScrollView, saat papan ketik muncul kartunya dibatasi 90%
                dari ruang yang tersisa, isinya meluber ke belakang papan
                ketik, dan tombol Simpan/Batal tidak dapat dijangkau sama
                sekali. Dengan ScrollView, yang menyusut adalah isinya —
                dan isinya dapat digulir.
              */}
              <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalJudul}>Terima Pembayaran</Text>
              <Text style={styles.catatan}>
                Penerimaan kas hanya menutup piutang. Pendapatan sudah diakui pada tanggal hak dan
                TIDAK diakui ulang di sini.
              </Text>

              {/* Service hanya mengenal Kas Umum dan bank, jadi Kas Kecil
                  tidak ditawarkan sejak awal. Validasi & penjagaan service
                  di bawah TETAP ada — dua lapis, bukan satu. */}
              <RekeningPicker
                label="Rekening Kas/Bank *"
                value={rekening}
                onChange={setRekening}
                jenisDiizinkan={['KAS', 'BANK']}
              />
              {terimaErrors.rekening && <Text style={styles.errorText}>{terimaErrors.rekening}</Text>}

              <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Penerimaan *</Text>
              <DatePicker value={tanggalTerima} onChange={setTanggalTerima} maximumDate={getWaktuSekarang()} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal Penerimaan *</Text>
              <CurrencyInput value={jumlahTerima} onChangeValue={setJumlahTerima} error={terimaErrors.jumlah} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>Nomor Referensi *</Text>
              <FocusTextInput
                style={styles.input}
                value={nomorReferensi}
                onChangeText={setNomorReferensi}
                placeholder="Nomor bukti transfer / kuitansi"
                placeholderTextColor={colors.placeholder}
                invalid={!!terimaErrors.nomorReferensi}
              />
              {terimaErrors.nomorReferensi && <FieldError message={terimaErrors.nomorReferensi} />}

              <View style={styles.previewActions}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => setTerimaUntuk(null)}
                  disabled={submittingTerima}
                >
                  <Text style={styles.cancelButtonText}>Batal</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.submitButton, { marginTop: 0, flex: 1 }, submittingTerima && styles.disabled]}
                  onPress={terima}
                  disabled={submittingTerima}
                >
                  {submittingTerima ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.submitButtonText}>Simpan Penerimaan</Text>
                  )}
                </TouchableOpacity>
              </View>
              </ScrollView>
            </View>
          </View>
        </AreaAmanKeyboard>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  areaKeyboard: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabAktif: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  tabTextAktif: { color: colors.primary },
  catatan: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginBottom: spacing.md },
  infoBox: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  infoLabel: { fontSize: 11, color: colors.textMuted },
  infoValue: { fontSize: 15, fontWeight: '700', color: colors.primary, marginTop: 2 },
  label: { fontSize: 13, color: colors.text, marginBottom: 4, fontWeight: '600' },
  input: { ...formUi.inputStandalone },
  hintText: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 4 },
  jurnalBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
  },
  jurnalJudul: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 4 },
  journalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  journalDebit: { width: 56, fontSize: 11, fontWeight: '700', color: colors.primary },
  journalKredit: { width: 56, fontSize: 11, fontWeight: '700', color: colors.danger },
  journalAkun: { flex: 1, fontSize: 13, color: colors.text },
  journalNominal: { fontSize: 13, fontWeight: '700', color: colors.text },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  submitButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },
  kosong: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardJudul: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  badge: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLunas: { backgroundColor: colors.border },
  badgeText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  cardBaris: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  nominalRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  terimaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 10,
    marginTop: spacing.md,
  },
  terimaButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  modalBackdrop: { ...modalUi.backdrop, justifyContent: 'flex-end' },
  modalCard: { ...modalUi.card },
  modalJudul: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  previewActions: { flexDirection: 'row', gap: 8, marginTop: spacing.lg },
  cancelButton: {
    flex: 1,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: { color: colors.text, fontWeight: '700' },
});
