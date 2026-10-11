import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import KartuLangkah from '@/components/form/KartuLangkah';
import KotakInfo from '@/components/form/KotakInfo';
import { UbinOpsi } from '@/components/form/PilihanOpsi';
import RingkasanTransaksi, { type BarisRingkasan } from '@/components/form/RingkasanTransaksi';
import TombolUtama from '@/components/form/TombolUtama';
import { RekeningItem } from '@/services/KasBankService';
import { terimaModalUang, terimaModalBarang } from '@/services/ModalService';
import { listKelompokAset, listSubKelompokAset, AsetKlasifikasiItem } from '@/services/AsetKlasifikasiService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

type BentukModal = 'UANG' | 'BARANG';
/**
 * RC-S50 §2 — jenis barang yang disetor sebagai modal.
 *
 * Nilainya diteruskan apa adanya ke `terimaModalBarang()`, yang memilih
 * mapping akun existing (`ASET_TETAP` / `ASET_TAK_BERWUJUD`) dan
 * menuliskan `aset_tetap.jenis_aset`. Layar ini TIDAK menentukan akun,
 * tidak menghitung apa pun, dan tidak mengenal kode akun.
 */
type JenisBarangModal = 'TETAP' | 'TAK_BERWUJUD';

/** "50 bulan" -> "4 tahun 2 bulan" — hanya bantuan baca, nilai yang dikirim tetap bulan. */
function bacaBulan(bulan: number): string | null {
  if (!Number.isFinite(bulan) || bulan < 12) return null;
  const tahun = Math.floor(bulan / 12);
  const sisa = bulan % 12;
  return sisa === 0 ? `${tahun} tahun` : `${tahun} tahun ${sisa} bulan`;
}

/**
 * Sub-fitur "Modal Koperasi" (Penerimaan; label diubah dari "Modal"
 * — target §1 permintaan pengguna, MURNI nomenklatur UI) — dua
 * bentuk: Modal Uang & Modal Barang. Deskripsi menu: "Setoran modal
 * uang atau barang ke koperasi (hibah/donasi/simpanan khusus)"
 * (permintaan pengguna, update pasca-Phase 18/19 §P — sebelumnya
 * "...(hibah)" saja) — lihat `sub` di TransaksiPenerimaanScreen.tsx.
 * Logika transaksi & akun COA TIDAK diubah, murni perubahan label.
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna): isian
 * dikelompokkan menjadi langkah bernomor, pilihan bentuk/metode/jenis
 * memakai ubin berketerangan (bukan chip polos), klasifikasi aset
 * memakai pemilih berchevron, dan ringkasan tampil sebelum simpan.
 * State, validasi, dan pemanggilan `terimaModalUang`/`terimaModalBarang`
 * TIDAK berubah.
 */
export default function ModalFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [bentuk, setBentuk] = useState<BentukModal>('UANG');
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Modal Uang
  const [nilaiUang, setNilaiUang] = useState<number | ''>('');
  const [metodePembayaran, setMetodePembayaran] = useState<'TUNAI' | 'TRANSFER'>('TUNAI');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);

  // Modal Barang
  const [jenisBarang, setJenisBarang] = useState<JenisBarangModal>('TETAP');
  const [namaBarang, setNamaBarang] = useState('');
  const [nilaiPerolehan, setNilaiPerolehan] = useState<number | ''>('');
  const [masaManfaat, setMasaManfaat] = useState('');
  const [masaManfaatOtomatis, setMasaManfaatOtomatis] = useState(false);
  // PHASE 5 (§F/§H/§I, permintaan pengguna): Klasifikasi Aset — pola
  // Kelompok -> Sub Kelompok SAMA PERSIS dengan PembelianAsetFormScreen
  // (data dari aset_klasifikasi, TIDAK di-hardcode) — WAJIB diisi
  // untuk Modal Barang (beda dari Pembelian Aset yang opsional),
  // karena barang di sini SELALU menjadi aset tetap.
  const [kelompokAset, setKelompokAset] = useState('');
  const [subKelompokAset, setSubKelompokAset] = useState('');
  const [kelompokList, setKelompokList] = useState<string[]>([]);
  const [subKelompokList, setSubKelompokList] = useState<AsetKlasifikasiItem[]>([]);
  const [kelompokPickerOpen, setKelompokPickerOpen] = useState(false);
  const [subKelompokPickerOpen, setSubKelompokPickerOpen] = useState(false);

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
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    if (bentuk === 'UANG') {
      if (nilaiUang === '' || nilaiUang <= 0) e.nilaiUang = 'Nilai harus lebih dari 0';
      if (metodePembayaran === 'TRANSFER' && !rekening) e.rekening = 'Rekening tujuan wajib dipilih';
    } else {
      if (!namaBarang.trim()) e.namaBarang = 'Nama barang wajib diisi';
      if (nilaiPerolehan === '' || nilaiPerolehan <= 0) e.nilaiPerolehan = 'Nilai perolehan harus lebih dari 0';
      const masaNum = parseInt(masaManfaat, 10);
      if (!masaManfaat || isNaN(masaNum) || masaNum <= 0) e.masaManfaat = 'Masa manfaat (bulan) harus lebih dari 0';
      // PHASE 5 (§I, permintaan pengguna): klasifikasi WAJIB untuk
      // Modal Barang — divalidasi lagi di backend (ModalService/
      // AsetService), ini murni supaya error tampil di form sebelum submit.
      if (!kelompokAset) e.kelompokAset = 'Kelompok aset wajib dipilih';
      if (kelompokAset && !subKelompokAset) e.subKelompokAset = 'Sub kelompok aset wajib dipilih';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !currentUser) return;
    setSubmitting(true);
    try {
      if (bentuk === 'UANG') {
        if (nilaiUang === '') return;
        await terimaModalUang({
          nilai: nilaiUang,
          metodePembayaran,
          bankAccountId: metodePembayaran === 'TRANSFER' ? rekening?.id : undefined,
          tanggal,
          createdBy: currentUser.id,
        });
      } else {
        if (nilaiPerolehan === '') return;
        await terimaModalBarang({
          jenisAset: jenisBarang,
          namaBarang: namaBarang.trim(),
          nilaiPerolehan,
          masaManfaatBulan: parseInt(masaManfaat, 10),
          kelompokAset,
          subKelompokAset,
          tanggal,
          createdBy: currentUser.id,
        });
      }
      notify('Berhasil', 'Penerimaan modal berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // Ringkasan — HANYA cerminan isian; tidak menghitung apa pun.
  const masaNum = parseInt(masaManfaat, 10);
  const ringkasan: BarisRingkasan[] | null =
    bentuk === 'UANG'
      ? nilaiUang !== '' && nilaiUang > 0
        ? [
            { label: 'Bentuk', nilai: 'Modal uang' },
            {
              label: 'Diterima di',
              nilai: metodePembayaran === 'TUNAI' ? 'Kas (tunai)' : rekening?.nama ?? 'Rekening bank belum dipilih',
            },
            { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
            { label: 'Nilai modal', nilai: formatRupiah(nilaiUang), tegas: true },
          ]
        : null
      : nilaiPerolehan !== '' && nilaiPerolehan > 0 && namaBarang.trim()
        ? [
            { label: 'Bentuk', nilai: jenisBarang === 'TAK_BERWUJUD' ? 'Aset tak berwujud' : 'Aset tetap' },
            { label: 'Nama barang', nilai: namaBarang.trim() },
            {
              label: 'Klasifikasi',
              nilai: kelompokAset ? (subKelompokAset ? `${kelompokAset} › ${subKelompokAset}` : kelompokAset) : 'Belum dipilih',
            },
            {
              label: 'Masa manfaat',
              nilai: Number.isFinite(masaNum) && masaNum > 0 ? `${masaNum} bulan` : 'Belum diisi',
            },
            { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
            { label: 'Nilai perolehan', nilai: formatRupiah(nilaiPerolehan), tegas: true },
          ]
        : null;

  const masaTerbaca = bacaBulan(masaNum);

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.konten}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="MODAL" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="MODAL" />
        ) : (
        <>
        <KartuLangkah nomor={1} judul="Bentuk modal" keterangan="Setoran modal ke koperasi: hibah, donasi, atau simpanan khusus.">
          <View style={styles.opsiBaris}>
            <Chip
              label="Uang"
              ikon="cash-outline"
              keterangan="Tunai atau transfer ke rekening koperasi"
              active={bentuk === 'UANG'}
              onPress={() => setBentuk('UANG')}
            />
            <Chip
              label="Barang"
              ikon="cube-outline"
              keterangan="Dicatat sebagai aset, tanpa arus kas"
              active={bentuk === 'BARANG'}
              onPress={() => setBentuk('BARANG')}
            />
          </View>
        </KartuLangkah>

        {bentuk === 'UANG' ? (
          <KartuLangkah nomor={2} judul="Nilai & penerimaan dana">
            <Text style={styles.label}>Nilai modal *</Text>
            <CurrencyInput value={nilaiUang} onChangeValue={setNilaiUang} error={errors.nilaiUang} />

            <Text style={[styles.label, styles.jarak]}>Diterima melalui</Text>
            <View style={styles.opsiBaris}>
              <Chip label="Tunai" ikon="wallet-outline" active={metodePembayaran === 'TUNAI'} onPress={() => setMetodePembayaran('TUNAI')} />
              <Chip
                label="Transfer"
                ikon="business-outline"
                active={metodePembayaran === 'TRANSFER'}
                onPress={() => setMetodePembayaran('TRANSFER')}
              />
            </View>

            {metodePembayaran === 'TRANSFER' && (
              <View style={styles.jarak}>
                {/* RC-S53 §C — Metode TRANSFER hanya boleh menunjuk rekening BANK.
                    Kas Tunai/Kas Kecil bukan tujuan transfer, dan rekening
                    nonaktif sudah disaring RekeningPicker sendiri. Filternya
                    memakai prop `hanyaBank` yang SUDAH ADA — tidak ada picker
                    baru yang dibuat. */}
                <RekeningPicker
                  label="Rekening tujuan"
                  value={rekening}
                  onChange={setRekening}
                  hanyaBank
                />
                {errors.rekening && <FieldError message={errors.rekening} />}
              </View>
            )}
          </KartuLangkah>
        ) : (
          <>
            <KartuLangkah nomor={2} judul="Data barang">
              {/* RC-S50 §2 — memakai komponen `Chip` yang SUDAH dipakai
                  layar ini untuk Bentuk Modal & Metode Pembayaran, jadi
                  tidak ada gaya kontrol baru yang diperkenalkan. */}
              <Text style={styles.label}>Jenis barang</Text>
              <View style={styles.opsiBaris}>
                <Chip label="Aset Tetap" ikon="business-outline" active={jenisBarang === 'TETAP'} onPress={() => setJenisBarang('TETAP')} />
                <Chip
                  label="Aset Tak Berwujud"
                  ikon="key-outline"
                  active={jenisBarang === 'TAK_BERWUJUD'}
                  onPress={() => setJenisBarang('TAK_BERWUJUD')}
                />
              </View>

              <Text style={[styles.label, styles.jarak]}>Nama barang *</Text>
              <FocusTextInput
                style={styles.input}
                value={namaBarang}
                onChangeText={setNamaBarang}
                placeholder={
                  jenisBarang === 'TAK_BERWUJUD' ? 'Mis. Lisensi Software, Hak Paten' : 'Mis. Laptop Kantor, Meja Kursi'
                }
                placeholderTextColor={colors.placeholder}
                invalid={!!errors.namaBarang}
              />
              {errors.namaBarang && <FieldError message={errors.namaBarang} />}

              <Text style={[styles.label, styles.jarak]}>Klasifikasi aset *</Text>
              {kelompokList.length === 0 ? (
                <KotakInfo nada="netral">
                  Belum ada data klasifikasi aset. Atur dulu di Data › Data Klasifikasi Aset.
                </KotakInfo>
              ) : (
                <>
                  <Pemilih
                    ikon="folder-outline"
                    nilai={kelompokAset}
                    placeholder="Pilih kelompok aset"
                    salah={!!errors.kelompokAset}
                    onPress={() => setKelompokPickerOpen(true)}
                  />
                  {errors.kelompokAset && <FieldError message={errors.kelompokAset} />}

                  {kelompokAset ? (
                    <View style={styles.jarakKecil}>
                      <Pemilih
                        ikon="folder-open-outline"
                        nilai={subKelompokAset}
                        placeholder={subKelompokList.length > 0 ? 'Pilih sub kelompok aset' : 'Sub kelompok belum tersedia'}
                        salah={!!errors.subKelompokAset}
                        onPress={() => (subKelompokList.length > 0 ? setSubKelompokPickerOpen(true) : undefined)}
                      />
                      {errors.subKelompokAset && <FieldError message={errors.subKelompokAset} />}
                    </View>
                  ) : null}
                </>
              )}
            </KartuLangkah>

            <KartuLangkah nomor={3} judul="Nilai & masa manfaat">
              <Text style={styles.label}>Nilai perolehan *</Text>
              <CurrencyInput value={nilaiPerolehan} onChangeValue={setNilaiPerolehan} error={errors.nilaiPerolehan} />

              <Text style={[styles.label, styles.jarak]}>Masa manfaat (bulan) *</Text>
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
              {masaManfaatOtomatis ? (
                <Text style={styles.petunjuk}>
                  Terisi otomatis dari sub kelompok "{subKelompokAset}"{masaTerbaca ? ` (${masaTerbaca})` : ''}. Tetap bisa diubah.
                </Text>
              ) : masaTerbaca ? (
                <Text style={styles.petunjuk}>Setara {masaTerbaca}.</Text>
              ) : null}
              {errors.masaManfaat && <FieldError message={errors.masaManfaat} />}

              <View style={styles.jarak}>
                <KotakInfo nada="info">
                  {jenisBarang === 'TAK_BERWUJUD'
                    ? 'Barang masuk ke register Aset Tak Berwujud sebagai modal non-tunai (tidak ada kas/bank yang bergerak) dan diamortisasi sesuai masa manfaatnya.'
                    : 'Barang masuk ke register Aset Tetap sebagai modal non-tunai (tidak ada kas/bank yang bergerak) dan disusutkan sesuai masa manfaatnya.'}
                </KotakInfo>
              </View>
            </KartuLangkah>
          </>
        )}

        <KartuLangkah nomor={bentuk === 'UANG' ? 3 : 4} judul="Tanggal transaksi">
          <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />
        </KartuLangkah>

        {ringkasan ? <RingkasanTransaksi judul="Ringkasan modal" baris={ringkasan} /> : null}

        <TombolUtama label="Simpan Modal Koperasi" ikon="save-outline" onPress={submit} memuat={submitting} />

        <Modal visible={kelompokPickerOpen} animationType="slide" onRequestClose={() => setKelompokPickerOpen(false)}>
          <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pilih Kelompok Aset</Text>
              <TouchableOpacity
                style={styles.tutupIkon}
                onPress={() => setKelompokPickerOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Tutup"
              >
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalIsi}>
              {kelompokList.map((k) => (
                <BarisPilihan
                  key={k}
                  judul={k}
                  terpilih={k === kelompokAset}
                  onPress={() => {
                    setKelompokAset(k);
                    setKelompokPickerOpen(false);
                  }}
                />
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        <Modal visible={subKelompokPickerOpen} animationType="slide" onRequestClose={() => setSubKelompokPickerOpen(false)}>
          <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pilih Sub Kelompok Aset</Text>
              <TouchableOpacity
                style={styles.tutupIkon}
                onPress={() => setSubKelompokPickerOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Tutup"
              >
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalIsi}>
              {subKelompokList.map((s) => (
                <BarisPilihan
                  key={s.id}
                  judul={s.subKelompok}
                  sub={
                    s.masaManfaatBulanDefault !== null
                      ? `Masa manfaat default: ${s.masaManfaatBulanDefault} bulan`
                      : 'Masa manfaat belum ditentukan — isi manual'
                  }
                  terpilih={s.subKelompok === subKelompokAset}
                  onPress={() => pilihSubKelompok(s)}
                />
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

/**
 * Pilihan tunggal layar ini. Nama & prop `label`/`active`/`onPress`
 * dipertahankan (dikunci test RC-S50); RC-S122 hanya mengganti
 * tampilannya menjadi ubin bersama `UbinOpsi`.
 */
function Chip({
  label,
  active,
  onPress,
  ikon,
  keterangan,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  ikon?: keyof typeof Ionicons.glyphMap;
  keterangan?: string;
}) {
  return <UbinOpsi label={label} aktif={active} onPress={onPress} ikon={ikon} keterangan={keterangan} />;
}

/** Pemicu modal pilihan — tampil seperti input (batas, ikon, chevron). */
function Pemilih({
  ikon,
  nilai,
  placeholder,
  salah,
  onPress,
}: {
  ikon: keyof typeof Ionicons.glyphMap;
  nilai: string;
  placeholder: string;
  salah?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.pemilih, salah && styles.pemilihSalah]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={nilai || placeholder}
    >
      <Ionicons name={ikon} size={18} color={colors.textMuted} />
      <Text style={nilai ? styles.pemilihTeks : styles.pemilihPlaceholder} numberOfLines={1}>
        {nilai || placeholder}
      </Text>
      <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function BarisPilihan({ judul, sub, terpilih, onPress }: { judul: string; sub?: string; terpilih: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.pickerRow, terpilih && styles.pickerRowTerpilih]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: terpilih }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.pickerRowText}>{judul}</Text>
        {sub ? <Text style={styles.pickerRowSub}>{sub}</Text> : null}
      </View>
      {terpilih ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  konten: { padding: spacing.lg, paddingBottom: spacing.xxl },
  opsiBaris: { flexDirection: 'row', gap: spacing.sm },
  label: { fontSize: typography.subtitle, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  jarak: { marginTop: spacing.md },
  jarakKecil: { marginTop: spacing.sm },
  input: { ...formUi.inputStandalone },
  petunjuk: { fontSize: 11.5, color: colors.primary, marginTop: spacing.xs, lineHeight: 16 },
  pemilih: {
    ...formUi.inputWrap,
    gap: spacing.sm,
  },
  pemilihSalah: { ...formUi.inputWrapError },
  pemilihTeks: { flex: 1, minWidth: 0, fontSize: 15, color: colors.text },
  pemilihPlaceholder: { flex: 1, minWidth: 0, fontSize: 15, color: colors.placeholder },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalTitle: { ...modalUi.title },
  tutupIkon: { width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' },
  modalIsi: { padding: spacing.lg },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget + 8,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  pickerRowTerpilih: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  pickerRowText: { fontSize: 15, fontWeight: '600', color: colors.text },
  pickerRowSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
});
