import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem, getRekening } from '@/services/KasBankService';
import {
  catatInvestasi,
  editInvestasi,
  getInvestasiDetail,
  JenisInvestasiInput,
  LABEL_JENIS_INVESTASI,
  JENIS_BANK_UMUM,
} from '@/services/InvestasiService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/** §2: 4 pilihan utama Tujuan Investasi — "Bank Umum" adalah kelompok dengan sub-pilihan (JENIS_BANK_UMUM), bukan jenis tersendiri. */
const TUJUAN_UTAMA: { key: 'KOPERASI_LAIN' | 'USAHA_LAIN' | 'BANK_UMUM' | 'PROPERTI_INVESTASI'; label: string }[] = [
  { key: 'KOPERASI_LAIN', label: LABEL_JENIS_INVESTASI.KOPERASI_LAIN },
  { key: 'USAHA_LAIN', label: LABEL_JENIS_INVESTASI.USAHA_LAIN },
  // Target §11 (permintaan pengguna): label diganti "Bank Umum
  // (Simpanan > 3 Bulan)" -> "Deposito Berjangka (> 3 Bulan)" — HANYA
  // label tampilan. Internal value `key: 'BANK_UMUM'` TIDAK berubah
  // (dipakai untuk state `tujuanUtama` di komponen ini saja, tidak
  // disimpan ke database — nilai yang disimpan tetap salah satu dari
  // TABUNGAN_BANK_UMUM/GIRO_BANK_UMUM/DEPOSITO_BANK_UMUM sesuai
  // JENIS_BANK_UMUM, lihat InvestasiService.ts — jadi tidak ada risiko
  // data existing rusak, dan logic accounting TIDAK berubah).
  { key: 'BANK_UMUM', label: 'Deposito Berjangka (> 3 Bulan)' },
  { key: 'PROPERTI_INVESTASI', label: LABEL_JENIS_INVESTASI.PROPERTI_INVESTASI },
];

/**
 * Sub-fitur "Investasi" (menu Pengeluaran, dikelompokkan dengan
 * Kewajiban). Dicatat sebagai ASET (penyertaan/investasi), bukan
 * beban — lihat InvestasiService.catatInvestasi.
 *
 * Audit ulang (permintaan pengguna §2/§3/§5): form SEKARANG mendukung
 * 4 pilihan utama Tujuan Investasi — Penyertaan pada Koperasi Lain,
 * Usaha Lain, Bank Umum (dengan sub-pilihan Tabungan/Giro/Deposito > 3
 * bulan), dan Properti Investasi — bukan hanya Koperasi Lain/External
 * seperti sebelumnya. Field yang ditampilkan menyesuaikan jenis yang
 * dipilih (§5): Bank Umum menambahkan Nama Bank tersendiri + Jenis +
 * Nomor Rekening (opsional); Properti Investasi menambahkan Lokasi/
 * Deskripsi (opsional). Sumber dana, tanggal, jumlah, keterangan TETAP
 * sama untuk semua jenis.
 *
 * Phase 18 §2 (permintaan pengguna, tetap berlaku): pilihan "Unit
 * Usaha Internal" TETAP TIDAK tersedia di form ini — histori lama
 * tetap tersimpan & bisa dilihat di DaftarInvestasiScreen, hanya
 * tidak bisa dibuat lagi.
 *
 * Update pasca-Phase 18 §11 (tetap berlaku): mode EDIT
 * (route.params.investasiId, dari DaftarInvestasiScreen) — mengedit
 * MENGGANTI transaksi lama (reversal + baru, lewat
 * InvestasiService.editInvestasi), bukan UPDATE mentah. Jenis
 * investasi TIDAK bisa diganti saat edit (mengikuti jenis transaksi
 * asli — lihat komentar `editInvestasi`), jadi picker jenis
 * disembunyikan/dikunci pada mode edit.
 */
export default function InvestasiFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const investasiId: string | undefined = route.params?.investasiId;
  const isEdit = !!investasiId;

  const [tujuanUtama, setTujuanUtama] = useState<'KOPERASI_LAIN' | 'USAHA_LAIN' | 'BANK_UMUM' | 'PROPERTI_INVESTASI'>(
    'KOPERASI_LAIN'
  );
  // Audit ulang (permintaan pengguna §3): pilihan "Jenis Bank Umum"
  // (Tabungan/Giro/Deposito) DIHAPUS dari form — tujuan "Deposito
  // Berjangka (> 3 Bulan)" sekarang SELALU menghasilkan investasi baru
  // berjenis DEPOSITO_BANK_UMUM (bukan lagi bisa dipilih Tabungan/Giro).
  // Master "Jenis Simpanan" di Data Bank TIDAK dihapus — nilai
  // TABUNGAN_BANK_UMUM/GIRO_BANK_UMUM tetap ada di JENIS_BANK_UMUM
  // (InvestasiService) HANYA untuk kompatibilitas data investasi lama
  // (masih bisa ditampilkan di DaftarInvestasiScreen & diedit tanpa
  // ganti jenis — lihat komentar `editInvestasi`), tidak lagi bisa
  // dipilih untuk investasi BARU lewat UI ini.
  const jenisBankUmum: JenisInvestasiInput = 'DEPOSITO_BANK_UMUM';
  const [namaTujuan, setNamaTujuan] = useState('');
  const [bankTujuan, setBankTujuan] = useState<RekeningItem | null>(null);
  const [nomorRekeningInvestasi, setNomorRekeningInvestasi] = useState('');
  const [lokasiProperti, setLokasiProperti] = useState('');
  /** v72 — jatuh tempo Deposito Berjangka (opsional; '' = tidak dicatat). */
  const [tanggalJatuhTempo, setTanggalJatuhTempo] = useState('');
  const [jumlah, setJumlah] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [jenisAsli, setJenisAsli] = useState<JenisInvestasiInput | null>(null);
  // Permintaan pengguna §7: sebelum perubahan investasi disimpan, WAJIB
  // tampilkan modal konfirmasi + field "Alasan Perubahan *". Alasan ini
  // diteruskan ke InvestasiService.editInvestasi (disimpan sebagai audit
  // trail lewat reversal jurnal + kolom keterangan baris lama — pola
  // sama seperti alasan pencairan, tapi jelas ditandai "koreksi/diedit"
  // supaya berbeda dari audit trail pencairan §6).
  const [showConfirmEdit, setShowConfirmEdit] = useState(false);
  const [alasanPerubahan, setAlasanPerubahan] = useState('');

  // Jenis investasi yang SEDANG dipilih (§2) — dipakai untuk field
  // dinamis (§5) & saat submit. Pada mode EDIT, ini mengikuti jenis
  // ASLI (tidak bisa diganti — lihat komentar service `editInvestasi`).
  const jenisInvestasi: JenisInvestasiInput = isEdit
    ? jenisAsli ?? 'KOPERASI_LAIN'
    : tujuanUtama === 'BANK_UMUM'
      ? jenisBankUmum
      : (tujuanUtama as JenisInvestasiInput);

  const isBankUmum = JENIS_BANK_UMUM.includes(jenisInvestasi);
  const isProperti = jenisInvestasi === 'PROPERTI_INVESTASI';
  // Permintaan pengguna §11: field "Nama Bank" dihapus khusus untuk
  // Deposito Berjangka — hanya jenis Bank Umum LEGACY (Tabungan/Giro,
  // hanya bisa muncul lewat edit data lama) yang masih wajib pilih
  // Nama Bank dari Data Bank. Sinkron dengan `JENIS_WAJIB_NAMA_BANK`
  // di InvestasiService.ts (sumber kebenaran validasi di server layer).
  const wajibNamaBank = jenisInvestasi === 'TABUNGAN_BANK_UMUM' || jenisInvestasi === 'GIRO_BANK_UMUM';

  useEffect(() => {
    if (!investasiId) return;
    (async () => {
      const detail = await getInvestasiDetail(investasiId);
      if (detail) {
        setNamaTujuan(detail.namaTujuan);
        setJumlah(detail.jumlah);
        setTanggal(detail.tanggal);
        setKeterangan(detail.keterangan ?? '');
        setNomorRekeningInvestasi(detail.nomorRekeningInvestasi ?? '');
        setLokasiProperti(detail.lokasiProperti ?? '');
        setTanggalJatuhTempo(detail.tanggalJatuhTempo ?? '');
        if (detail.jenisInvestasi !== 'UNIT_USAHA') {
          setJenisAsli(detail.jenisInvestasi);
        }
        const rek = await getRekening(detail.sumberDana, detail.bankAccountId ?? undefined);
        setRekening(rek);
        // Revisi KOPKU (Bagian 1.4): tampilkan bank TUJUAN yang
        // tersimpan — getRekening() tetap bisa menemukan bank yang
        // sudah tidak aktif (listRekening() tidak menyaring status
        // aktif), jadi histori investasi Bank Umum lama tetap
        // menampilkan nama bank aslinya meski bank itu sudah
        // dinonaktifkan di Data Bank.
        if (detail.bankTujuanId) {
          const bankTujuanRek = await getRekening('BANK', detail.bankTujuanId);
          setBankTujuan(bankTujuanRek);
        }
      }
      setLoading(false);
    })();
  }, [investasiId]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (wajibNamaBank) {
      // Revisi KOPKU (Bagian 1.3): "Nama Bank" WAJIB dipilih dari Data
      // Bank — tidak ada lagi input teks bebas untuk divalidasi di sini.
      // (Permintaan pengguna §11: TIDAK berlaku lagi untuk Deposito
      // Berjangka — lihat komentar `wajibNamaBank` di atas.)
      if (!bankTujuan) e.bankTujuan = 'Nama bank wajib dipilih dari Data Bank.';
    } else if (!namaTujuan.trim()) {
      e.namaTujuan = isProperti ? 'Nama/deskripsi properti wajib diisi' : 'Nama tujuan investasi wajib diisi';
    }
    if (jumlah === '' || jumlah <= 0) e.jumlah = 'Jumlah investasi harus lebih dari 0';
    if (!rekening) e.rekening = 'Sumber dana wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal transaksi wajib diisi';
    if (isBankUmum && tanggalJatuhTempo && tanggalJatuhTempo < tanggal) {
      e.tanggalJatuhTempo = 'Jatuh tempo tidak boleh sebelum tanggal penempatan';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const buildPayload = () => ({
    // Revisi KOPKU (Bagian 1): untuk Bank Umum (Tabungan/Giro legacy),
    // teks ini diabaikan oleh service (nama diambil dari
    // bankTujuan/Data Bank) — tetap dikirim string kosong/aman hanya
    // untuk memenuhi tipe input. Permintaan pengguna §11: Deposito
    // Berjangka TIDAK lagi masuk kondisi ini — namaTujuan-nya teks
    // bebas seperti jenis lain.
    namaTujuan: wajibNamaBank ? (bankTujuan?.nama ?? '') : namaTujuan.trim(),
    jumlah: jumlah as number,
    tanggal,
    sumberDana: rekening!.jenis === 'BANK' ? ('BANK' as const) : ('KAS' as const),
    bankAccountId: rekening!.jenis === 'BANK' ? rekening!.id : undefined,
    bankTujuanId: wajibNamaBank ? bankTujuan?.id : undefined,
    keterangan: keterangan || undefined,
    nomorRekeningInvestasi: isBankUmum ? nomorRekeningInvestasi.trim() || undefined : undefined,
    lokasiProperti: isProperti ? lokasiProperti.trim() || undefined : undefined,
    tanggalJatuhTempo: isBankUmum ? tanggalJatuhTempo || undefined : undefined,
  });

  // Mode TAMBAH: submit langsung seperti biasa (tidak butuh Alasan
  // Perubahan — itu hanya untuk EDIT, §7).
  const submit = async () => {
    if (!validate() || !rekening || !currentUser || jumlah === '') return;
    if (isEdit) {
      // Jangan langsung simpan — tampilkan modal konfirmasi + wajib isi
      // Alasan Perubahan terlebih dahulu (§7, langkah 4-8).
      setAlasanPerubahan('');
      setShowConfirmEdit(true);
      return;
    }
    setSubmitting(true);
    try {
      await catatInvestasi({ jenisInvestasi, ...buildPayload(), createdBy: currentUser.id });
      notify('Berhasil', 'Investasi berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // Dipanggil dari modal konfirmasi setelah Alasan Perubahan diisi
  // (§7, langkah 9-13) — alasan diteruskan ke service sebagai audit
  // trail, TERPISAH dari audit trail pencairan (§6).
  const confirmEdit = async () => {
    if (!alasanPerubahan.trim() || !rekening || !currentUser || jumlah === '' || !investasiId) return;
    setSubmitting(true);
    try {
      await editInvestasi(investasiId, currentUser.id, buildPayload(), alasanPerubahan.trim());
      setShowConfirmEdit(false);
      notify('Berhasil', 'Investasi berhasil diperbarui (jurnal lama di-reversal, jurnal baru dibuat).', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
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

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
          lewat Detail History Transaksi (satu pintu). */}
      {/* Mode edit: tab disembunyikan — layar fokus pada transaksi yang sedang diubah. */}
        {!isEdit && <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="INVESTASI" />}
      {tabMenu === 'RIWAYAT' ? (
        <RiwayatTransaksiMenu menu="INVESTASI" />
      ) : (
      <>
      <View style={styles.infoBox}>
        <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
        <Text style={styles.infoText}>
          Dicatat sebagai penyertaan/investasi (aset), bukan beban — koperasi tetap punya klaim atas nilai investasi ini.
        </Text>
      </View>

      {/* Permintaan pengguna §6: deskripsi Investasi Koperasi. Teks
          statis, tidak mengganggu form (kotak info terpisah, sebelum
          pilihan Tujuan Investasi). */}
      <View style={styles.infoBox}>
        <Ionicons name="briefcase-outline" size={16} color={colors.textMuted} />
        <Text style={styles.infoText}>
          Penyertaan pada koperasi lain, usaha lain, deposito berjangka, dan properti investasi.
        </Text>
      </View>

      <Text style={styles.sectionLabel}>Tujuan Investasi</Text>
      {isEdit ? (
        <Text style={styles.infoText}>{LABEL_JENIS_INVESTASI[jenisInvestasi]} (tidak dapat diubah saat edit)</Text>
      ) : (
        <View style={styles.chipRow}>
          {TUJUAN_UTAMA.map((t) => (
            <Chip key={t.key} label={t.label} active={tujuanUtama === t.key} onPress={() => setTujuanUtama(t.key)} />
          ))}
        </View>
      )}

      {wajibNamaBank ? (
        <>
          {/* Revisi KOPKU (Bagian 1): Nama Bank WAJIB dipilih dari Data
              Bank (bank_account) — bukan lagi input teks bebas. Reuse
              RekeningPicker existing (hanyaBank) — sama komponen yang
              dipakai untuk Sumber Dana, TIDAK ada tabel/picker bank baru.
              Permintaan pengguna §11: field ini TIDAK lagi tampil untuk
              Deposito Berjangka (jenisInvestasi === 'DEPOSITO_BANK_UMUM')
              — hanya jenis Bank Umum legacy (Tabungan/Giro, dari data
              lama) yang masih menampilkannya. */}
          <View style={{ marginTop: spacing.md }}>
            <RekeningPicker label="Nama Bank" value={bankTujuan} onChange={setBankTujuan} hanyaBank />
            {errors.bankTujuan && <Text style={styles.errorText}>{errors.bankTujuan}</Text>}
            <Text style={styles.infoText}>
              Belum ada bank yang cocok? Tambahkan bank terlebih dahulu melalui menu Data Bank.
            </Text>
          </View>
        </>
      ) : (
        <>
          <Text style={[styles.label, { marginTop: spacing.md }]}>{isProperti ? 'Nama/Deskripsi Properti *' : 'Nama Tujuan *'}</Text>
          <FocusTextInput
            style={styles.input}
            value={namaTujuan}
            onChangeText={setNamaTujuan}
            placeholder={isProperti ? 'Mis. Ruko 2 lantai di Jl. Sudirman' : 'Mis. Koperasi Sejahtera Bersama'}
            placeholderTextColor={colors.placeholder}
            invalid={!!errors.namaTujuan}
          />
          {errors.namaTujuan && <FieldError message={errors.namaTujuan} />}
        </>
      )}

      {isProperti && (
        <>
          <Text style={[styles.label, { marginTop: spacing.md }]}>Lokasi (opsional)</Text>
          <FocusTextInput
            style={styles.input}
            value={lokasiProperti}
            onChangeText={setLokasiProperti}
            placeholder="Mis. Jl. Sudirman No. 10, Jakarta"
            placeholderTextColor={colors.placeholder}
          />
        </>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Jumlah Investasi (Rp) *</Text>
      <CurrencyInput value={jumlah} onChangeValue={setJumlah} error={errors.jumlah} />

      <View style={{ marginTop: spacing.md }}>
        <RekeningPicker label="Sumber Dana" value={rekening} onChange={setRekening} />
        {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
      </View>

      <Text style={styles.label}>Tanggal Transaksi *</Text>
      <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

      {isBankUmum && (
        <>
          {/* v72 — data deposito untuk Penarikan Dana Investasi. */}
          <Text style={[styles.label, { marginTop: spacing.md }]}>Nomor Deposito (opsional)</Text>
          <FocusTextInput
            style={styles.input}
            value={nomorRekeningInvestasi}
            onChangeText={setNomorRekeningInvestasi}
            placeholder="Nomor bilyet / rekening deposito"
            placeholderTextColor={colors.placeholder}
          />
          <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Jatuh Tempo (opsional)</Text>
          <DatePicker value={tanggalJatuhTempo} onChange={setTanggalJatuhTempo} error={errors.tanggalJatuhTempo} />
          {tanggalJatuhTempo ? (
            <TouchableOpacity onPress={() => setTanggalJatuhTempo('')} accessibilityRole="button">
              <Text style={styles.infoText}>Hapus tanggal jatuh tempo</Text>
            </TouchableOpacity>
          ) : null}
        </>
      )}

      <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
      <FocusTextInput
        style={styles.inputMultiline}
        value={keterangan}
        onChangeText={setKeterangan}
        multiline
        placeholderTextColor={colors.placeholder}
      />

      <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
        {submitting ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <>
            <Ionicons name="save-outline" size={18} color={colors.white} />
            <Text style={styles.submitText}>{isEdit ? 'Simpan Perubahan' : 'Simpan Investasi'}</Text>
          </>
        )}
      </TouchableOpacity>

      <Modal visible={showConfirmEdit} transparent animationType="fade" onRequestClose={() => setShowConfirmEdit(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {/*
              RC-S120 — isian alasan di sini multibaris dan terus memanjang
              selama diketik. Tanpa ScrollView, begitu kartu mencapai
              `maxHeight`-nya tombol Simpan terdorong ke belakang papan
              ketik dan tidak dapat digulir.
            */}
            <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Konfirmasi Perubahan Investasi</Text>
            <Text style={styles.infoText}>
              Jurnal investasi lama akan di-reversal dan jurnal baru dibuat sesuai data hasil edit. Alasan perubahan
              wajib diisi untuk audit trail.
            </Text>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Alasan Perubahan *</Text>
            <FocusTextInput
              style={styles.inputMultiline}
              value={alasanPerubahan}
              onChangeText={setAlasanPerubahan}
              placeholder="Jelaskan alasan perubahan data investasi ini"
              placeholderTextColor={colors.placeholder}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setShowConfirmEdit(false)} disabled={submitting}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, (!alasanPerubahan.trim() || submitting) && styles.disabled]}
                onPress={confirmEdit}
                disabled={!alasanPerubahan.trim() || submitting}
              >
                {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan Perubahan</Text>}
              </TouchableOpacity>
            </View>
            </ScrollView>
          </View>
        </AreaAmanKeyboard>
      </Modal>
      </>
      )}
    </ScrollView>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.sm, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
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
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  modalBackdrop: { ...modalUi.backdrop, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title, marginBottom: 6 },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.primaryButton },
});
