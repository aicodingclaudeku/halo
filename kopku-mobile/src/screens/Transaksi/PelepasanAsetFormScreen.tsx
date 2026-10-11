import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, FlatList, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import EmptyState from '@/components/report/EmptyState';
import { listAsetDenganNilaiBuku, AsetDenganNilaiBukuItem } from '@/services/AsetService';
import {
  lepaskanAsetTetap,
  pratinjauPelepasanAsetTetap,
  PratinjauPelepasanAsetTetap,
} from '@/services/PelepasanAsetTetapService';
import { RekeningItem } from '@/services/KasBankService';
import {
  asetDapatDilepas,
  daftarKekuranganPelepasan,
  labelSelisihPelepasan,
  pesanOperatorPelepasan,
  sinkronAsetTerpilih,
  susunInputPelepasan,
  validasiIsianPelepasan,
} from '@/utils/pelepasanAsetForm';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * RC-S67.7 — FORM TRANSAKSI "Penjualan / Pelepasan Aset".
 *
 * Menu Pendapatan Koperasi › Penjualan / Pelepasan Aset membuka layar INI
 * (bukan master Daftar Aset Tetap & Penyusutan). Alur:
 *   pilih aset (AKTIF saja) → detail read-only (data AsetService) → isi
 *   tanggal, nomor dokumen, hasil pelepasan, Kas/Bank → pratinjau laba/rugi
 *   (pratinjauPelepasanAsetTetap) → konfirmasi → lepaskanAsetTetap.
 *
 * Seluruh akuntansi & validasi otoritatif tetap di PelepasanAsetTetapService
 * (tidak diubah). Layar ini tidak menulis database dan tidak menghitung
 * nilai buku/laba/rugi sendiri.
 */

export default function PelepasanAsetFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [daftar, setDaftar] = useState<AsetDenganNilaiBukuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [aset, setAset] = useState<AsetDenganNilaiBukuItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nomorDokumen, setNomorDokumen] = useState('');
  const [hasil, setHasil] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  // Field yang sudah disentuh operator — galat inline hanya tampil untuk ini.
  const [disentuh, setDisentuh] = useState<Record<string, boolean>>({});
  const sentuh = (k: string) => setDisentuh((d) => (d[k] ? d : { ...d, [k]: true }));

  const [pratinjau, setPratinjau] = useState<PratinjauPelepasanAsetTetap | null>(null);
  const [pratinjauError, setPratinjauError] = useState<string | null>(null);
  const [menghitung, setMenghitung] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const sedangMengirim = useRef(false);
  // Hindari setState setelah layar ditutup (async load / submit).
  const masihTerpasang = useRef(true);
  useEffect(() => {
    masihTerpasang.current = true;
    return () => {
      masihTerpasang.current = false;
    };
  }, []);

  const isian = { aset, tanggal, nomorDokumen, hasil, rekening };
  const galat = validasiIsianPelepasan(isian);
  const kekurangan = daftarKekuranganPelepasan(isian);

  const muat = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const baru = asetDapatDilepas(await listAsetDenganNilaiBuku());
      if (!masihTerpasang.current) return;
      setDaftar(baru);
      // Aset terpilih diperbarui dari data terbaru; dikosongkan bila tidak eligible lagi.
      setAset((lama) => sinkronAsetTerpilih(lama, baru));
    } catch {
      if (masihTerpasang.current) setLoadError('Data aset belum dapat dimuat. Silakan coba lagi.');
    } finally {
      if (masihTerpasang.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    muat();
  }, [muat]);

  // Pratinjau dihitung ulang oleh SERVICE setiap isian berubah & lengkap.
  // RC-S67.7.1: status `menghitung` SELALU direset di awal efek & saat
  // cleanup — sebelumnya bisa tertinggal `true` bila isian berubah menjadi
  // tidak lengkap saat pratinjau berjalan (tombol Simpan terkunci selamanya).
  useEffect(() => {
    setPratinjau(null);
    setPratinjauError(null);
    setMenghitung(false);
    if (!currentUser) return;
    const input = susunInputPelepasan(isian, currentUser.id, keterangan);
    if (!input) return;
    let batal = false;
    setMenghitung(true);
    pratinjauPelepasanAsetTetap(input)
      .then((p) => {
        if (!batal) setPratinjau(p);
      })
      .catch((e) => {
        if (!batal) setPratinjauError(pesanOperatorPelepasan(e, 'Pratinjau belum dapat dihitung.'));
      })
      .finally(() => {
        if (!batal) setMenghitung(false);
      });
    return () => {
      batal = true;
      setMenghitung(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aset, tanggal, nomorDokumen, hasil, rekening, currentUser]);

  const kirim = async () => {
    if (sedangMengirim.current || !currentUser) return;
    const input = susunInputPelepasan(isian, currentUser.id, keterangan);
    if (!input) return;
    sedangMengirim.current = true;
    setSubmitting(true);
    try {
      await lepaskanAsetTetap(input);
      if (masihTerpasang.current) {
        setPratinjau(null); // tombol langsung nonaktif: tidak ada submit kedua dari layar ini
        notify('Berhasil', 'Pelepasan aset berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
      }
    } catch (e) {
      notify('Gagal', pesanOperatorPelepasan(e, 'Gagal menyimpan transaksi. Silakan coba lagi.'));
      if (masihTerpasang.current) await muat();
    } finally {
      sedangMengirim.current = false;
      if (masihTerpasang.current) setSubmitting(false);
    }
  };

  const konfirmasi = () => {
    setDisentuh({ aset: true, tanggal: true, nomorDokumen: true, hasil: true, rekening: true });
    if (kekurangan.length > 0 || !pratinjau || sedangMengirim.current) return;
    const s = labelSelisihPelepasan(pratinjau);
    notify(
      'Konfirmasi Pelepasan Aset',
      `${pratinjau.namaAset} (${pratinjau.nomorAset})\nNilai buku ${formatRupiah(pratinjau.nilaiBuku)} · Hasil ${formatRupiah(pratinjau.hasilPelepasan)}\n${s.label} ${formatRupiah(s.nilai)}\nAset akan berstatus DIHAPUS (dilepas).`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Simpan', onPress: kirim },
      ]
    );
  };

  // Nonaktif bila: isian belum lengkap/valid, pratinjau belum valid, sedang menghitung, atau sedang submit.
  const bisaSimpan = kekurangan.length === 0 && !!pratinjau && !pratinjauError && !submitting && !menghitung;
  const tampilGalat = (k: keyof typeof galat) => (disentuh[k] ? galat[k] : undefined);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Data belum dapat dimuat" message={loadError} />
        <TouchableOpacity accessibilityRole="button" style={styles.retryButton} onPress={muat}>
          <Text style={styles.submitText}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={styles.container}>
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
          lewat Detail History Transaksi (satu pintu). */}
      <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PELEPASAN_ASET" />
      {tabMenu === 'RIWAYAT' ? (
        <RiwayatTransaksiMenu menu="PELEPASAN_ASET" />
      ) : (
      <>
      {/* Poin 12 — tata letak dikelompokkan per kartu bernomor: Aset & Nilai
          Buku -> Rincian Pelepasan -> Rekening Penerimaan -> Keterangan ->
          Pratinjau Laba/Rugi -> Konfirmasi. Logika, validasi, service,
          jurnal, dan perhitungan laba/rugi TIDAK diubah. */}
      <View style={styles.infoBox}>
        <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
        <Text style={styles.infoText}>
          Pelepasan aset mengeluarkan aset dari buku. Yang diakui hanya selisih hasil terhadap nilai buku (laba atau rugi
          pelepasan), bukan seluruh hasil penjualan.
        </Text>
      </View>

      <Seksi nomor={1} ikon="business-outline" judul="Aset & Nilai Buku">
        <Text style={styles.label}>Aset Tetap *</Text>
        {daftar.length === 0 ? (
          <Text style={styles.muted}>Belum ada aset tetap aktif yang dapat dilepas.</Text>
        ) : (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Pilih aset tetap" style={[styles.selector, !!tampilGalat('aset') && styles.selectorError]} onPress={() => setPickerOpen(true)}>
            <Ionicons name="business-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
            <Text style={aset ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={2}>
              {aset ? `${aset.namaAset} · ${aset.nomorAset}` : 'Pilih Aset...'}
            </Text>
            <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={{ flexShrink: 0 }} />
          </TouchableOpacity>
        )}
        {tampilGalat('aset') ? <GalatInline pesan={tampilGalat('aset')!} /> : null}

        {aset ? (
          <View style={styles.detail}>
            <Baris label="Nama Aset" nilai={aset.namaAset} />
            <Baris label="Kode Aset" nilai={aset.nomorAset} />
            <Baris label="Tanggal Perolehan" nilai={formatTanggalIndonesia(aset.tanggalPerolehan)} />
            <Baris label="Status" nilai={aset.status} />
            <View style={styles.garis} />
            <Baris label="Harga Perolehan" nilai={formatRupiah(aset.nilaiPerolehan)} angka />
            <Baris label="Akumulasi Penyusutan" nilai={formatRupiah(aset.akumulasiPenyusutan)} angka />
            <View style={styles.garis} />
            <Baris label="Nilai Buku" nilai={formatRupiah(aset.nilaiBuku)} tebal angka />
          </View>
        ) : null}
      </Seksi>

      <Seksi nomor={2} ikon="calendar-outline" judul="Rincian Pelepasan">
        <Text style={styles.label}>Tanggal Pelepasan *</Text>
        <DatePicker value={tanggal} onChange={(t: string) => { setTanggal(t); sentuh('tanggal'); }} error={tampilGalat('tanggal')} maximumDate={getWaktuSekarang()} />

        <Text style={[styles.label, styles.labelJarak]}>Nomor Dokumen *</Text>
        <FocusTextInput
          style={[styles.input, !!tampilGalat('nomorDokumen') && styles.inputError]}
          value={nomorDokumen}
          onChangeText={(t: string) => {
            setNomorDokumen(t);
            sentuh('nomorDokumen');
          }}
          onBlur={() => sentuh('nomorDokumen')}
          placeholder="Mis. kuitansi / berita acara penjualan"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="characters"
        />
        {tampilGalat('nomorDokumen') ? <GalatInline pesan={tampilGalat('nomorDokumen')!} /> : null}

        <Text style={[styles.label, styles.labelJarak]}>Hasil Penjualan / Nilai Pelepasan (Rp) *</Text>
        <CurrencyInput value={hasil} onChangeValue={(v: number | '') => { setHasil(v); sentuh('hasil'); }} error={tampilGalat('hasil')} />
        <Text style={styles.muted}>Isi 0 bila aset dilepas tanpa hasil (mis. rusak/dibuang).</Text>
      </Seksi>

      {hasil !== '' && hasil > 0 ? (
        <Seksi nomor={3} ikon="wallet-outline" judul="Rekening Penerimaan">
          <RekeningPicker label="Diterima di Kas/Bank *" value={rekening} onChange={(r: RekeningItem) => { setRekening(r); sentuh('rekening'); }} />
          {tampilGalat('rekening') ? <GalatInline pesan={tampilGalat('rekening')!} /> : null}
        </Seksi>
      ) : null}

      <Seksi nomor={hasil !== '' && hasil > 0 ? 4 : 3} ikon="document-text-outline" judul="Keterangan">
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholder="Opsional — mis. alasan pelepasan / pembeli"
          placeholderTextColor={colors.placeholder}
        />
      </Seksi>

      <Seksi nomor={hasil !== '' && hasil > 0 ? 5 : 4} ikon="calculator-outline" judul="Pratinjau Laba / Rugi">
        {menghitung ? (
          <View style={styles.memuatBaris}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.muted}>Menghitung pratinjau…</Text>
          </View>
        ) : pratinjau ? (
          <View>
            <Baris label="Nilai Buku" nilai={formatRupiah(pratinjau.nilaiBuku)} angka />
            <Baris label="Hasil Pelepasan" nilai={formatRupiah(pratinjau.hasilPelepasan)} angka />
            <View style={styles.garis} />
            <View style={[styles.hasilPratinjau, pratinjau.hasilPelepasan < pratinjau.nilaiBuku ? styles.hasilRugi : styles.hasilLaba]}>
              <Text style={styles.hasilLabel}>{labelSelisihPelepasan(pratinjau).label}</Text>
              <Text style={styles.hasilNilai}>{formatRupiah(labelSelisihPelepasan(pratinjau).nilai)}</Text>
            </View>
          </View>
        ) : pratinjauError ? (
          <View style={styles.warnBox} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.warnText}>{pratinjauError}</Text>
          </View>
        ) : (
          <View accessibilityLabel="Isian belum lengkap">
            <Text style={styles.mutedJudul}>Lengkapi isian berikut untuk melihat pratinjau:</Text>
            {kekurangan.map((k) => (
              <Text key={k} style={styles.muted}>
                • {k}
              </Text>
            ))}
          </View>
        )}
      </Seksi>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ disabled: !bisaSimpan }}
        style={[styles.submitButton, !bisaSimpan && styles.disabled]}
        onPress={konfirmasi}
        disabled={!bisaSimpan}
      >
        {submitting ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <>
            <Ionicons name="checkmark-done-outline" size={18} color={colors.white} />
            <Text style={styles.submitText}>Konfirmasi & Simpan Pelepasan</Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.catatanSimpan}>Anda akan diminta konfirmasi sebelum transaksi disimpan.</Text>

      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Aset Tetap</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Tutup" hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.closeIcon} onPress={() => setPickerOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={daftar}
            keyExtractor={(i) => i.id}
            contentContainerStyle={{ padding: spacing.lg }}
            ListEmptyComponent={<Text style={styles.muted}>Tidak ada aset aktif.</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity
                accessibilityRole="button"
                style={[styles.pickRow, aset?.id === item.id && styles.pickRowActive]}
                onPress={() => {
                  setAset(item);
                  sentuh('aset');
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.pickTitle}>{item.namaAset}</Text>
                <Text style={styles.pickSub}>
                  {item.nomorAset} · perolehan {formatTanggalIndonesia(item.tanggalPerolehan)} · nilai buku {formatRupiah(item.nilaiBuku)}
                </Text>
              </TouchableOpacity>
            )}
          />
        </SafeAreaView>
      </Modal>
      </>
      )}
    </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Baris({ label, nilai, tebal, angka }: { label: string; nilai: string; tebal?: boolean; angka?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, tebal && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, angka && styles.rowAngka, tebal && styles.bold]}>{nilai}</Text>
    </View>
  );
}

/** Poin 12 — kartu seksi bernomor (hierarki visual form). Presentasi saja. */
function Seksi({
  nomor,
  ikon,
  judul,
  children,
}: {
  nomor: number;
  ikon: keyof typeof Ionicons.glyphMap;
  judul: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.kartu}>
      <View style={styles.kartuHeader}>
        <View style={styles.nomorBulat}>
          <Text style={styles.nomorText}>{nomor}</Text>
        </View>
        <Ionicons name={ikon} size={16} color={colors.primary} />
        <Text style={styles.kartuJudul}>{judul}</Text>
      </View>
      {children}
    </View>
  );
}

function GalatInline({ pesan }: { pesan: string }) {
  return (
    <View style={styles.errorRow}>
      <Ionicons name="alert-circle-outline" size={13} color={colors.danger} />
      <Text style={styles.errorText}>{pesan}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // Ruang bawah cukup agar tombol Simpan dapat digulir di atas keyboard / navigation bar.
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl * 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  labelJarak: { marginTop: spacing.md },
  kartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  kartuHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  nomorBulat: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  nomorText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  kartuJudul: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  inputError: { borderColor: colors.danger },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xs },
  mutedJudul: { fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: 2 },
  memuatBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowAngka: { fontVariant: ['tabular-nums'] },
  hasilPratinjau: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginTop: 4 },
  hasilLaba: { backgroundColor: colors.primaryLight },
  hasilRugi: { backgroundColor: colors.warningBg },
  hasilLabel: { fontSize: 13, fontWeight: '700', color: colors.text, flexShrink: 1 },
  hasilNilai: { fontSize: 15, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  catatanSimpan: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  muted: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 17 },
  bold: { fontWeight: '700', color: colors.text },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  errorText: { color: colors.danger, fontSize: 12, flexShrink: 1 },
  infoBox: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.lg },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  warnBox: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radius.sm, padding: spacing.md },
  warnText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  selector: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 12 },
  selectorError: { borderColor: colors.danger },
  selectorText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '600' },
  selectorPlaceholder: { flex: 1, fontSize: 14, color: colors.placeholder },
  detail: { marginTop: spacing.md, backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  rowLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 13, color: colors.text, flexShrink: 0, textAlign: 'right' },
  garis: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  submitButton: { flexDirection: 'row', gap: 8, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  retryButton: { marginTop: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.xl, borderRadius: radius.sm, backgroundColor: colors.primary },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  modalTitle: { ...modalUi.title },
  closeIcon: { ...modalUi.closeIcon },
  pickRow: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.sm },
  pickRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  pickTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  pickSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});
