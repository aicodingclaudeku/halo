import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import DataReferensiPicker from '@/components/DataReferensiPicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem } from '@/services/KasBankService';
import { beliAset } from '@/services/AsetService';
import { listKelompokAset, listSubKelompokAset, AsetKlasifikasiItem } from '@/services/AsetKlasifikasiService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatRupiah } from '@/utils/money';
import {
  buatPenjagaSubmit,
  efekJurnalPembelian,
  labelMasaManfaat,
  nilaiResiduUntukDisimpan,
  pratinjauNilaiDisusutkan,
  RingkasanPembelianAset,
  validasiNilaiResidu,
} from '@/utils/pembelianAsetForm';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/** Sub-fitur "Pembelian Aset" (Pengeluaran) — tunai atau kredit, sesuai penyusutan SAK (masa manfaat). */
export default function PembelianAsetFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [namaAset, setNamaAset] = useState('');
  const [jenisAset, setJenisAset] = useState<'TETAP' | 'TAK_BERWUJUD'>('TETAP');
  const [kelompokAset, setKelompokAset] = useState('');
  const [subKelompokAset, setSubKelompokAset] = useState('');
  const [kelompokList, setKelompokList] = useState<string[]>([]);
  const [subKelompokList, setSubKelompokList] = useState<AsetKlasifikasiItem[]>([]);
  const [kelompokPickerOpen, setKelompokPickerOpen] = useState(false);
  const [subKelompokPickerOpen, setSubKelompokPickerOpen] = useState(false);
  const [nilaiPerolehan, setNilaiPerolehan] = useState<number | ''>('');
  // RC-S67.7.2 — Nilai Residu (kosong = 0). Service sudah mendukung & memvalidasinya.
  const [nilaiResidu, setNilaiResidu] = useState<number | ''>('');
  const [masaManfaat, setMasaManfaat] = useState('');
  const [masaManfaatOtomatis, setMasaManfaatOtomatis] = useState(false);
  const [metodePembayaran, setMetodePembayaran] = useState<'TUNAI' | 'KREDIT'>('TUNAI');
  const [namaPemasok, setNamaPemasok] = useState('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // RC-S67.7.2 — kunci submit SINKRON (state React terlambat satu render
  // untuk tap cepat) + kunci permanen setelah berhasil: form tidak dapat
  // mengirim transaksi kedua walau notifikasi ditutup tanpa menekan tombol.
  // RC-S67.7.3: logika penjaga dipindah ke helper murni `buatPenjagaSubmit`
  // (diuji langsung: 3 tap cepat -> 1 beliAset; gagal -> boleh retry).
  const submitInFlightRef = useRef(buatPenjagaSubmit());
  const [berhasil, setBerhasil] = useState<RingkasanPembelianAset | null>(null);

  // RC-S67.7.2 §9 — ganti jenis aset: klasifikasi & masa manfaat otomatis
  // dari klasifikasi lama direset (tidak dibawa ke jenis lain).
  const gantiJenisAset = (jenis: 'TETAP' | 'TAK_BERWUJUD') => {
    if (jenis === jenisAset) return;
    setJenisAset(jenis);
    setKelompokAset('');
    setSubKelompokAset('');
    if (masaManfaatOtomatis) {
      setMasaManfaat('');
      setMasaManfaatOtomatis(false);
    }
  };

  // Bagian G (permintaan pengguna): Kelompok -> Sub Kelompok ->
  // Masa Manfaat otomatis terisi, tapi tetap opsional & bisa diedit —
  // kalau admin belum pernah mengisi "Data Klasifikasi Aset" (hub
  // Input Data), kelompokList kosong dan form tetap bisa dipakai
  // normal (Masa Manfaat diisi manual seperti sebelumnya) supaya
  // fitur ini tidak memblokir transaksi yang sudah berjalan baik.
  useEffect(() => {
    listKelompokAset().then(setKelompokList);
  }, []);

  useEffect(() => {
    setSubKelompokAset('');
    if (!kelompokAset) {
      setSubKelompokList([]);
      return;
    }
    listSubKelompokAset(kelompokAset).then(setSubKelompokList);
  }, [kelompokAset]);

  const pilihSubKelompok = (item: AsetKlasifikasiItem) => {
    setSubKelompokAset(item.subKelompok);
    // Audit ulang (permintaan pengguna §18/§19): sub-kelompok tanpa
    // masa manfaat default (mis. Kelompok 5 "Lainnya", `null`) TIDAK
    // lagi auto-isi field ini dengan "null" (bug kalau tidak ditangani
    // — String(null) === "null") — dikosongkan supaya pengguna WAJIB
    // mengetik masa manfaat manual (validate() tetap menolak submit
    // kalau kosong/0, jadi aset tidak akan pernah tersimpan dengan
    // masa manfaat 0/kosong).
    if (item.masaManfaatBulanDefault !== null) {
      setMasaManfaat(String(item.masaManfaatBulanDefault));
      setMasaManfaatOtomatis(true);
    } else {
      setMasaManfaat('');
      setMasaManfaatOtomatis(false);
    }
    setSubKelompokPickerOpen(false);
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!namaAset.trim()) e.namaAset = 'Nama aset wajib diisi';
    if (nilaiPerolehan === '' || nilaiPerolehan <= 0) e.nilaiPerolehan = 'Nilai perolehan harus lebih dari 0';
    const galatResidu = validasiNilaiResidu(nilaiPerolehan, nilaiResidu);
    if (galatResidu) e.nilaiResidu = galatResidu;
    const masaNum = parseInt(masaManfaat, 10);
    if (!masaManfaat || isNaN(masaNum) || masaNum <= 0) e.masaManfaat = 'Masa manfaat (bulan) harus lebih dari 0';
    if (metodePembayaran === 'TUNAI' && !rekening) e.rekening = 'Rekening sumber dana wajib dipilih';
    if (metodePembayaran === 'KREDIT' && !namaPemasok.trim()) e.namaPemasok = 'Nama pemasok wajib diisi (dicatat sebagai utang usaha)';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (submitInFlightRef.current.terkunci || berhasil) return;
    if (!validate() || !currentUser || nilaiPerolehan === '') return;
    setSubmitting(true);
    const residu = nilaiResiduUntukDisimpan(nilaiResidu);
    const masaBulan = parseInt(masaManfaat, 10);
    try {
      const hasilSubmit = await submitInFlightRef.current.jalankan(() => beliAset({
        namaAset: namaAset.trim(),
        jenisAset,
        kelompokAset: kelompokAset || undefined,
        subKelompokAset: subKelompokAset || undefined,
        nilaiPerolehan,
        nilaiResidu: residu,
        masaManfaatBulan: masaBulan,
        tanggal,
        metodePembayaran,
        sumberDana: metodePembayaran === 'TUNAI' ? (rekening?.jenis === 'BANK' ? 'BANK' : 'KAS') : undefined,
        bankAccountId: metodePembayaran === 'TUNAI' && rekening?.jenis === 'BANK' ? rekening.id : undefined,
        namaPemasok: metodePembayaran === 'KREDIT' ? namaPemasok.trim() : undefined,
        createdBy: currentUser.id,
      }));
      if (hasilSubmit.status === 'DIABAIKAN') return;
      const { id, nomorAset } = hasilSubmit.hasil;
      // RC-S67.7.6 — SATU FORM. Pembelian Aset adalah satu-satunya tempat
      // pengisian data aset: beliAset() sudah mendaftarkan aset + jurnal.
      // Setelah berhasil hanya ada Ringkasan dan satu aksi "Kembali ke
      // Pengeluaran". Tidak ada lagi aksi yang membuka layar pengelolaan aset
      // tetap (akar masalah UX RC-S67.7.2–7.3: aksi lihat aset pasca-simpan
      // masih membuka form aset penuh sehingga terasa seperti mengisi ulang).
      // Pengelolaan aset tetap dilakukan dari modul Aset Tetap sendiri.
      const ringkasan: RingkasanPembelianAset = {
        asetId: id,
        nomorAset,
        namaAset: namaAset.trim(),
        nilaiPerolehan,
        nilaiResidu: residu,
        masaManfaatBulan: masaBulan,
        metodePembayaran,
        sumber: metodePembayaran === 'TUNAI' ? rekening?.nama ?? '-' : namaPemasok.trim(),
      };
      setBerhasil(ringkasan);
      notify('Berhasil', 'Pembelian aset berhasil dicatat.', [
        { text: 'Kembali ke Pengeluaran', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      // Gagal: penjaga sudah melepas kunci (boleh coba lagi); beliAset atomik.
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  if (berhasil) {
    return (
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={styles.sukses}>
          <Ionicons name="checkmark-circle" size={28} color={colors.success} />
          <Text style={styles.suksesJudul}>Pembelian Aset Berhasil</Text>
        </View>
        <View style={styles.ringkasan}>
          <BarisRingkasan label="Nama Aset" nilai={berhasil.namaAset} />
          <BarisRingkasan label="Nomor Aset" nilai={berhasil.nomorAset} />
          <BarisRingkasan label="Nilai Perolehan" nilai={formatRupiah(berhasil.nilaiPerolehan)} />
          <BarisRingkasan label="Nilai Residu" nilai={formatRupiah(berhasil.nilaiResidu)} />
          <BarisRingkasan label="Masa Manfaat" nilai={labelMasaManfaat(berhasil.masaManfaatBulan)} />
          <BarisRingkasan label="Metode Pembayaran" nilai={berhasil.metodePembayaran === 'TUNAI' ? 'Tunai' : 'Kredit'} />
          <BarisRingkasan label={berhasil.metodePembayaran === 'TUNAI' ? 'Sumber Dana' : 'Pemasok'} nilai={berhasil.sumber} />
          <BarisRingkasan label="Jurnal" nilai={efekJurnalPembelian(berhasil.metodePembayaran)} />
        </View>
        <TouchableOpacity accessibilityRole="button" style={styles.submitButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back-outline" size={18} color={colors.white} />
          <Text style={styles.submitText}>Kembali ke Pengeluaran</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={styles.container}>
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
          lewat Detail History Transaksi (satu pintu). */}
      <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PEMBELIAN_ASET" />
      {tabMenu === 'RIWAYAT' ? (
        <RiwayatTransaksiMenu menu="PEMBELIAN_ASET" />
      ) : (
      <>
      <Text style={styles.sectionLabelPertama}>Informasi Aset</Text>
      <Text style={styles.label}>Jenis Aset *</Text>
      <View style={styles.jenisRow}>
        <TouchableOpacity
          style={[styles.jenisChip, jenisAset === 'TETAP' && styles.jenisChipActive]}
          onPress={() => gantiJenisAset('TETAP')}
        >
          <Text style={[styles.jenisChipText, jenisAset === 'TETAP' && styles.jenisChipTextActive]}>Aset Tetap</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.jenisChip, jenisAset === 'TAK_BERWUJUD' && styles.jenisChipActive]}
          onPress={() => gantiJenisAset('TAK_BERWUJUD')}
        >
          <Text style={[styles.jenisChipText, jenisAset === 'TAK_BERWUJUD' && styles.jenisChipTextActive]}>
            Aset Tak Berwujud
          </Text>
        </TouchableOpacity>
      </View>
      {jenisAset === 'TAK_BERWUJUD' && (
        <Text style={styles.jenisNote}>
          Mis. lisensi software, hak paten/merek. Dicatat pada akun "Aset Tak Berwujud" (1-1700) dan diamortisasi
          (bukan disusutkan) dengan mekanisme yang sama seperti aset tetap.
        </Text>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Nama Aset *</Text>
      <FocusTextInput
        style={styles.input}
        value={namaAset}
        onChangeText={setNamaAset}
        placeholder="Mis. Laptop, Kendaraan Operasional"
        placeholderTextColor={colors.placeholder}
        invalid={!!errors.namaAset}
      />
      {errors.namaAset && <FieldError message={errors.namaAset} />}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Kelompok Aset</Text>
      <TouchableOpacity
        style={styles.selector}
        onPress={() => (kelompokList.length > 0 ? setKelompokPickerOpen(true) : undefined)}
      >
        <Ionicons name="folder-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={kelompokAset ? styles.selectorText : styles.selectorPlaceholder}>
          {kelompokAset || (kelompokList.length > 0 ? 'Pilih kelompok aset...' : 'Klasifikasi aset belum tersedia. Atur di Input Data > Data Klasifikasi Aset')}
        </Text>
      </TouchableOpacity>

      {kelompokAset && (
        <>
          <Text style={[styles.label, { marginTop: spacing.md }]}>Sub Kelompok Aset</Text>
          <TouchableOpacity
            style={styles.selector}
            onPress={() => (subKelompokList.length > 0 ? setSubKelompokPickerOpen(true) : undefined)}
          >
            <Ionicons name="folder-open-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
            <Text style={subKelompokAset ? styles.selectorText : styles.selectorPlaceholder}>
              {subKelompokAset || 'Pilih sub kelompok aset...'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      <Text style={styles.sectionLabel}>Nilai Aset</Text>
      <Text style={styles.label}>Nilai Perolehan *</Text>
      <CurrencyInput value={nilaiPerolehan} onChangeValue={setNilaiPerolehan} error={errors.nilaiPerolehan} />

      <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Residu</Text>
      <CurrencyInput
        value={nilaiResidu}
        onChangeValue={setNilaiResidu}
        placeholder="Masukkan nilai residu"
        error={errors.nilaiResidu ?? validasiNilaiResidu(nilaiPerolehan, nilaiResidu)}
      />
      <Text style={styles.autoFillHint}>Kosongkan bila tidak ada nilai residu (dicatat Rp0).</Text>

      <Text style={styles.sectionLabel}>Penyusutan</Text>
      <Text style={styles.label}>Masa Manfaat (bulan, sesuai SAK) *</Text>
      <FocusTextInput
        style={styles.input}
        value={masaManfaat}
        onChangeText={(v) => {
          setMasaManfaat(v);
          setMasaManfaatOtomatis(false);
        }}
        keyboardType="number-pad"
        placeholder="Mis. 48"
        placeholderTextColor={colors.placeholder}
      />
      {masaManfaatOtomatis && (
        <Text style={styles.autoFillHint}>Terisi otomatis dari Sub Kelompok "{subKelompokAset}" — tetap bisa diubah.</Text>
      )}
      {errors.masaManfaat && <Text style={styles.errorText}>{errors.masaManfaat}</Text>}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Metode Penyusutan</Text>
      <View style={styles.readonlyBox}>
        <Text style={styles.readonlyText}>Garis lurus (per bulan)</Text>
      </View>

      <Text style={styles.sectionLabel}>Ringkasan Penyusutan</Text>
      <View style={styles.ringkasan}>
        <BarisRingkasan label="Nilai Perolehan" nilai={nilaiPerolehan === '' ? '-' : formatRupiah(nilaiPerolehan)} />
        <BarisRingkasan label="Nilai Residu" nilai={formatRupiah(nilaiResiduUntukDisimpan(nilaiResidu))} />
        <BarisRingkasan
          label="Dasar Penyusutan"
          nilai={(() => {
            const n = pratinjauNilaiDisusutkan(nilaiPerolehan, nilaiResidu);
            return n === null ? '-' : formatRupiah(n);
          })()}
          tebal
        />
        <BarisRingkasan
          label="Masa Manfaat"
          nilai={(() => {
            const m = parseInt(masaManfaat, 10);
            return !masaManfaat || isNaN(m) || m <= 0 ? '-' : labelMasaManfaat(m);
          })()}
        />
      </View>

      <Text style={styles.sectionLabel}>Pembayaran</Text>
      <Text style={styles.label}>Metode Pembayaran</Text>
      <View style={styles.chipRow}>
        <Chip label="Tunai" active={metodePembayaran === 'TUNAI'} onPress={() => setMetodePembayaran('TUNAI')} />
        <Chip label="Kredit" active={metodePembayaran === 'KREDIT'} onPress={() => setMetodePembayaran('KREDIT')} />
      </View>

      {metodePembayaran === 'TUNAI' ? (
        <>
          <RekeningPicker label="Sumber Dana" value={rekening} onChange={setRekening} />
          {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
        </>
      ) : (
        <>
          <DataReferensiPicker jenis="PEMASOK" label="Nama Pemasok *" value={namaPemasok} onChange={setNamaPemasok} error={errors.namaPemasok} />

          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.infoText}>
              Dibeli kredit — dicatat sebagai utang usaha, tidak ada uang kas/bank yang keluar sekarang. Akan muncul
              di daftar utang aktif dan bisa dilunasi lewat sub-fitur Kewajiban.
            </Text>
          </View>
        </>
      )}

      <Text style={styles.sectionLabel}>Transaksi</Text>
      <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Transaksi *</Text>
      <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ disabled: submitting }}
        style={[styles.submitButton, submitting && styles.disabled]}
        onPress={submit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <>
            <Ionicons name="save-outline" size={18} color={colors.white} />
            <Text style={styles.submitText}>Simpan Pembelian</Text>
          </>
        )}
      </TouchableOpacity>

      <Modal visible={kelompokPickerOpen} animationType="slide" onRequestClose={() => setKelompokPickerOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Kelompok Aset</Text>
            <TouchableOpacity onPress={() => setKelompokPickerOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
            {kelompokList.map((k) => (
              <TouchableOpacity
                key={k}
                style={styles.pickerRow}
                onPress={() => {
                  setKelompokAset(k);
                  setKelompokPickerOpen(false);
                }}
              >
                <Text style={styles.pickerRowText}>{k}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={subKelompokPickerOpen} animationType="slide" onRequestClose={() => setSubKelompokPickerOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Sub Kelompok Aset</Text>
            <TouchableOpacity onPress={() => setSubKelompokPickerOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
            {subKelompokList.map((s) => (
              <TouchableOpacity key={s.id} style={styles.pickerRow} onPress={() => pilihSubKelompok(s)}>
                <Text style={styles.pickerRowText}>{s.subKelompok}</Text>
                <Text style={styles.pickerRowSub}>
                  {s.masaManfaatBulanDefault !== null
                    ? `Masa manfaat default: ${s.masaManfaatBulanDefault} bulan`
                    : 'Masa manfaat belum ditentukan — isi manual'}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      </>
      )}
    </ScrollView>
    </AreaAmanKeyboard>
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
  jenisRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.sm },
  jenisChip: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  jenisChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  jenisChipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  jenisChipTextActive: { color: colors.white },
  jenisNote: { fontSize: 11, color: colors.textMuted, marginBottom: spacing.sm, lineHeight: 16 },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
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
  selectorText: { fontSize: 15, color: colors.text },
  selectorPlaceholder: { fontSize: 13, color: colors.placeholder },
  autoFillHint: { fontSize: 11, color: colors.primary, marginTop: spacing.xs, fontStyle: 'italic' },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    marginBottom: 40,
  },
  disabled: { opacity: 0.6 },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl * 4 },
  sectionLabelPertama: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  readonlyBox: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md },
  readonlyText: { fontSize: 14, color: colors.text },
  sukses: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  suksesJudul: { fontSize: 17, fontWeight: '700', color: colors.text },
  ringkasan: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md, gap: 4 },
  ringRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  ringLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  ringValue: { fontSize: 13, color: colors.text, flexShrink: 1, textAlign: 'right' },
  ringBold: { fontWeight: '700', color: colors.text },
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
  pickerRow: {
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  pickerRowText: { fontSize: 15, fontWeight: '600', color: colors.text },
  pickerRowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});

function BarisRingkasan({ label, nilai, tebal }: { label: string; nilai: string; tebal?: boolean }) {
  return (
    <View style={styles.ringRow}>
      <Text style={[styles.ringLabel, tebal && styles.ringBold]}>{label}</Text>
      <Text style={[styles.ringValue, tebal && styles.ringBold]}>{nilai}</Text>
    </View>
  );
}
