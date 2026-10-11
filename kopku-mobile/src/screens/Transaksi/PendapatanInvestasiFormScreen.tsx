import React, { useCallback, useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import InvestasiPicker from '@/components/InvestasiPicker';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import EmptyState from '@/components/report/EmptyState';
import { RekeningItem } from '@/services/KasBankService';
import { LABEL_JENIS_INVESTASI, type InvestasiListItem } from '@/services/InvestasiService';
import {
  getInfoPendapatanInvestasi,
  listRiwayatPendapatanInvestasi,
  tambahPendapatanInvestasi,
  InfoPendapatanInvestasi,
  TransaksiPendapatanRow,
} from '@/services/PendapatanLainnyaService';
import { isKategoriPendapatanInvestasi, KategoriPendapatanInvestasi } from '@/config/pendapatanKoperasiPolicy';
import { LHU_KLASIFIKASI_LABEL } from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { formatRupiah } from '@/utils/money';
import { newId } from '@/utils/id';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S67 — Form leaf "Pendapatan Investasi" pada menu canonical
 * Pendapatan Koperasi (Usaha Lain · Bunga, Deposito · Bunga, Properti
 * Investasi · Sewa). Parameter rute: `{ kategori }`.
 *
 * Akun pendapatan TIDAK dipilih operator — ditetapkan kebijakan yang sudah
 * terkunci (lihat `pendapatanKoperasiPolicy.ts`) dan ditampilkan read-only.
 * Seluruh validasi otoritatif ada di `tambahPendapatanInvestasi`; validasi
 * di sini hanya UX. Jurnal lewat jalur canonical existing (Dr Kas/Bank,
 * Cr akun pendapatan) — layar ini tidak menulis database.
 */

const MAKS_RIWAYAT = 20;

function pesanUntukOperator(e: unknown): string {
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ClosedPeriodError') {
    return 'Periode akuntansi untuk tanggal ini sudah ditutup. Pilih tanggal pada periode yang masih terbuka.';
  }
  const pesan = e instanceof Error ? e.message : '';
  if (!pesan || /sqlite|constraint|typeerror|undefined|\bnull\b|stack/i.test(pesan)) {
    return 'Transaksi belum dapat disimpan. Silakan coba lagi.';
  }
  return pesan;
}

export default function PendapatanInvestasiFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const kategoriParam: unknown = route?.params?.kategori;
  const kategori: KategoriPendapatanInvestasi | null = isKategoriPendapatanInvestasi(kategoriParam) ? kategoriParam : null;
  const currentUser = useAppStore((s) => s.currentUser);

  const [info, setInfo] = useState<InfoPendapatanInvestasi | null>(null);
  const [riwayat, setRiwayat] = useState<TransaksiPendapatanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [investasi, setInvestasi] = useState<InvestasiListItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  const [nomorDokumen, setNomorDokumen] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Kunci submit SINKRON (pola RC-S65 RAKFormScreen) + identitas submit
  // untuk mekanisme idempotensi existing. Kunci idempotensi hanya
  // diperbarui setelah transaksi BERHASIL, sehingga retry setelah galat
  // jaringan/timeout memakai kunci yang sama dan tidak menggandakan jurnal.
  const sedangMengirim = useRef(false);
  const kunciSubmit = useRef<string>(newId());

  const muat = useCallback(async () => {
    if (!kategori) {
      setLoading(false);
      setLoadError('Jenis pendapatan tidak dikenal. Kembali ke menu Pendapatan Koperasi.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [i, r] = await Promise.all([getInfoPendapatanInvestasi(kategori), listRiwayatPendapatanInvestasi(kategori)]);
      setInfo(i);
      setRiwayat(r.slice(0, MAKS_RIWAYAT));
      navigation.setOptions?.({ title: i.label });
    } catch {
      setLoadError('Data belum dapat dimuat. Silakan coba lagi.');
    } finally {
      setLoading(false);
    }
  }, [kategori, navigation]);

  useEffect(() => {
    muat();
  }, [muat]);

  // Kembali dari Detail Transaksi (mis. setelah koreksi/reversal) ->
  // status riwayat dimuat ulang. Hanya BACA; tidak ada efek tulis.
  useEffect(() => {
    const unsub = navigation.addListener?.('focus', () => {
      if (kategori) listRiwayatPendapatanInvestasi(kategori).then((r) => setRiwayat(r.slice(0, MAKS_RIWAYAT))).catch(() => undefined);
    });
    return unsub;
  }, [navigation, kategori]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!investasi) e.investasi = 'Investasi sumber wajib dipilih.';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi.';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih besar dari 0.';
    if (!rekening) e.rekening = 'Kas/Bank wajib dipilih.';
    if (info?.wajibDokumen) {
      if (!nomorDokumen.trim()) e.nomorDokumen = 'Nomor dokumen wajib diisi.';
      else if (nomorDokumen.includes('|')) e.nomorDokumen = 'Nomor dokumen tidak boleh memuat karakter "|".';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (sedangMengirim.current) return;
    if (!kategori || !info?.akun || !currentUser) return;
    if (!validate() || !investasi || !rekening || nominal === '') return;
    sedangMengirim.current = true;
    setSubmitting(true);
    try {
      await tambahPendapatanInvestasi({
        kategori,
        investasiId: investasi.id,
        tanggal,
        nominal,
        jenis: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
        idempotencyKey: kunciSubmit.current,
        nomorDokumen: info.wajibDokumen ? nomorDokumen : undefined,
      });
      kunciSubmit.current = newId();
      notify('Berhasil', `${info.label} berhasil dicatat.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', pesanUntukOperator(e));
    } finally {
      sedangMengirim.current = false;
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (loadError || !info || !kategori) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Data belum dapat dimuat" message={loadError ?? 'Silakan coba lagi.'} />
        {kategori ? (
          <TouchableOpacity accessibilityRole="button" style={styles.retryButton} onPress={muat}>
            <Text style={styles.retryText}>Coba lagi</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  const bisaSimpan = !!info.akun && !submitting;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Dicatat saat kas/bank diterima (cash-basis): Dr Kas/Bank, Kr {info.akunKode}
            {info.akun ? ` ${info.akun.nama}` : ''}. Akun ditetapkan kebijakan: {info.sumberKebijakan}.
          </Text>
        </View>

        {kategori === 'IMBAL_HASIL_TETAP' ? (
          // Model investasi belum menyimpan hak imbal hasil tetap per investasi;
          // jenis KOPERASI_LAIN hanya menentukan kelompok, bukan bukti fixed return.
          <View style={styles.infoBox}>
            <Ionicons name="document-text-outline" size={16} color={colors.textMuted} />
            <Text style={styles.infoText}>
              Catat hanya bila ada ketentuan atau perjanjian yang memberi hak imbal hasil tetap atas investasi ini, dan
              isi nomor dokumennya. Sistem belum menyimpan data hak imbal hasil tetap per investasi, sehingga dasar ini
              tidak diverifikasi secara sistem.
            </Text>
          </View>
        ) : null}

        {info.masalah ? (
          <View style={styles.warnBox} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.warnText}>{info.masalah} Transaksi tidak dapat disimpan sampai akun tersedia.</Text>
          </View>
        ) : null}

        <InvestasiPicker
          value={investasi}
          onChange={setInvestasi}
          error={errors.investasi}
          onlyJenisInvestasi={info.jenisInvestasi as InvestasiListItem['jenisInvestasi']}
          emptyTitle={kategori === 'IMBAL_HASIL_TETAP' ? 'Belum Ada Investasi Koperasi Lain' : undefined}
          emptyMessage={
            kategori === 'IMBAL_HASIL_TETAP' ? 'Tidak ada investasi aktif yang tersedia untuk workflow ini.' : undefined
          }
        />

        {investasi ? (
          <View style={styles.readonlyBox}>
            <Text style={styles.readonlySub}>Jenis Investasi</Text>
            <Text style={styles.readonlyText}>{LABEL_JENIS_INVESTASI[investasi.jenisInvestasi] ?? investasi.jenisInvestasi}</Text>
            <Text style={[styles.readonlySub, { marginTop: spacing.sm }]}>Pihak / Investee</Text>
            <Text style={styles.readonlyText}>
              {investasi.namaTujuan} · {investasi.nomorInvestasi}
            </Text>
          </View>
        ) : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Diterima *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        {info.akun ? (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Akun Pendapatan (ditetapkan kebijakan)</Text>
            <View style={styles.readonlyBox}>
              <Text style={styles.readonlyText}>
                {info.akun.kode} — {info.akun.nama}
              </Text>
              <Text style={styles.readonlySub}>{LHU_KLASIFIKASI_LABEL[info.akun.klasifikasiLhu]}</Text>
            </View>
          </>
        ) : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
        <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Diterima di Kas/Bank" value={rekening} onChange={setRekening} />
          {errors.rekening ? <Text style={styles.errorText}>{errors.rekening}</Text> : null}
        </View>

        {info.wajibDokumen ? (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Nomor Dokumen *</Text>
            <FocusTextInput
              style={styles.input}
              value={nomorDokumen}
              onChangeText={setNomorDokumen}
              placeholder="Mis. bukti transfer / surat pembayaran imbal hasil"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="characters"
            />
            {errors.nomorDokumen ? <Text style={styles.errorText}>{errors.nomorDokumen}</Text> : null}
          </>
        ) : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholder="Mis. nomor bukti bank / kuitansi"
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: !bisaSimpan }}
          style={[styles.submitButton, !bisaSimpan && styles.disabled]}
          onPress={submit}
          disabled={!bisaSimpan}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Penerimaan</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Riwayat {info.label}</Text>
        {riwayat.length === 0 ? (
          <EmptyState message={'Belum ada transaksi pendapatan.\nSilakan tambahkan transaksi baru.'} />
        ) : (
          riwayat.map((r) => (
            <TouchableOpacity
              key={r.id}
              accessibilityRole="button"
              accessibilityLabel={`Detail transaksi ${r.nomorTransaksi}`}
              style={styles.histRow}
              onPress={() => navigation.navigate('KasBankDetail', { jenis: r.jenis, id: r.id })}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.histTitle} numberOfLines={2}>
                  {r.keterangan ?? r.nomorTransaksi}
                </Text>
                <Text style={styles.histSub}>
                  {r.tanggal} · {r.nomorTransaksi} · {r.kasBank}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
                <Text style={[styles.histNominal, r.status === 'DIKOREKSI' && styles.histDikoreksi]}>{formatRupiah(r.nominal)}</Text>
                <Text style={r.status === 'DIKOREKSI' ? styles.badgeWarn : styles.badge}>
                  {r.status === 'DIKOREKSI' ? 'Dikoreksi' : 'Aktif'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
            </TouchableOpacity>
          ))
        )}
        <Text style={styles.footNote}>
          Ketuk transaksi untuk melihat detail. Koreksi/pembatalan memakai mekanisme reversal existing (jurnal asli
          dibalik, tidak dihapus).
        </Text>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.xl, marginBottom: spacing.sm },
  readonlyBox: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md },
  readonlyText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  readonlySub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
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
  warnBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  warnText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  retryButton: { marginTop: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.xl, borderRadius: radius.sm, backgroundColor: colors.primary },
  retryText: { color: colors.white, fontWeight: '700' },
  histRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  histTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  histSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  histNominal: { fontSize: 14, fontWeight: '700', color: colors.text },
  histDikoreksi: { textDecorationLine: 'line-through', color: colors.textMuted },
  badge: { fontSize: 10, color: colors.success, fontWeight: '700', marginTop: 2 },
  badgeWarn: { fontSize: 10, color: colors.warning, fontWeight: '700', marginTop: 2 },
  footNote: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md, marginBottom: 40, lineHeight: 16 },
});
