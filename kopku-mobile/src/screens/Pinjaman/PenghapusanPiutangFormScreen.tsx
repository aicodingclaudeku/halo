import React, { useCallback, useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal, FlatList } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { listPinjamanMacetUntukPenghapusan, PinjamanMacetItem } from '@/services/LoanImpairmentService';
import { hapusPiutangPinjaman } from '@/services/PinjamanService';
import { getRATByTahunBuku } from '@/services/RATService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import SearchField from '@/components/SearchField';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import KartuLangkah from '@/components/form/KartuLangkah';
import KotakInfo from '@/components/form/KotakInfo';
import RingkasanTransaksi from '@/components/form/RingkasanTransaksi';
import TombolUtama from '@/components/form/TombolUtama';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Sub-fitur "Penghapusan Piutang" (menu Pengeluaran). SENGAJA punya
 * form terpisah dari KasBankTransaksiFormScreen: ini jurnal NON-KAS
 * (tidak menyentuh rekening kas/bank sama sekali), jadi tidak cocok
 * dipaksakan ke form Kas & Bank yang selalu butuh rekening sumber —
 * lihat penjelasan lengkap di PinjamanService.hapusPiutangPinjaman.
 *
 * Update pasca-Phase 18 (permintaan pengguna §14/§18/§19):
 * - §14: picker "Pilih Pinjaman" HANYA menampilkan pinjaman
 *   berkolektibilitas MACET (filter di service, `listPinjamanMacetUntukPenghapusan`)
 *   — bukan lagi seluruh pinjaman AKTIF.
 * - §18: field "Akun Penyisihan/Beban (yang didebit)" DIHAPUS — akun
 *   ditentukan otomatis oleh service (lihat `hapusPiutangPinjaman`).
 * - §19: kalau RAT tahun buku (dari tanggal transaksi) belum ada,
 *   diblokir dengan pesan yang sama persis diminta pengguna, SEBELUM
 *   sempat submit (dicek juga di service sebagai lapis kedua).
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna): dua langkah
 * bernomor, kartu detail pinjaman terpilih (sisa piutang, plafon,
 * tunggakan, tenor), ringkasan dampak, dialog konfirmasi sebelum hapus
 * buku, dan peringatan RAT kini memberi jalan langsung ke Pelaksanaan RAT
 * (rute `PelaksanaanRAT` yang sudah terdaftar di TransaksiStack; teks lama
 * menyuruh ke "menu SHU", padahal RAT kini ada di Data). Validasi,
 * `hapusPiutangPinjaman`, dan pesan sukses TIDAK diubah.
 */
export default function PenghapusanPiutangFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [pinjaman, setPinjaman] = useState<PinjamanMacetItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [alasan, setAlasan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const [ratAda, setRatAda] = useState<boolean | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const cekRAT = useCallback(async (tgl: string) => {
    const tahunBuku = new Date(tgl).getFullYear();
    const rat = await getRATByTahunBuku(tahunBuku);
    setRatAda(!!rat);
  }, []);

  useEffect(() => {
    cekRAT(tanggal);
  }, [tanggal, cekRAT]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!pinjaman) e.pinjaman = 'Pinjaman wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    if (!alasan.trim()) e.alasan = 'Alasan penghapusan wajib diisi';
    if (ratAda === false) {
      e.rat = 'Pelaksanaan RAT wajib diisi sebelum penghapusan piutang dapat dilakukan.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !pinjaman || !currentUser) return;
    setSubmitting(true);
    try {
      // BUG FIX (pre-existing, ditemukan lewat typecheck TS2339):
      // sebelumnya baris ini melakukan `const { sisaPiutang } = ...`,
      // padahal `HapusPiutangResult` TIDAK PERNAH punya field
      // `sisaPiutang`. Akibatnya `sisaPiutang.toLocaleString(...)` di
      // bawah melempar "Cannot read properties of undefined" TEPAT SAAT
      // hapus buku BERHASIL — jurnalnya sudah tercatat, tapi petugas
      // melihat pesan Gagal, sehingga rawan dicoba ulang.
      //
      // Field pengganti TIDAK ditebak. Dari implementasi aktual
      // `hapusPiutangPinjaman()`:
      //   writeOffPrincipal = saldo Piutang Pokok dari GL
      //   writeOffJasa      = Piutang Jasa yang SUDAH diakui
      //   writeOffTotal     = writeOffPrincipal + writeOffJasa
      // `writeOffTotal` inilah nominal yang benar-benar dikeluarkan dari
      // neraca oleh transaksi ini — persis yang dimaksud kalimat
      // "sebesar ... telah dihapusbukukan".
      const { writeOffTotal, writeOffPrincipal, writeOffJasa } = await hapusPiutangPinjaman({
        pinjamanId: pinjaman.id,
        tanggal,
        alasan: alasan.trim(),
        createdBy: currentUser.id,
      });
      notify(
        'Berhasil',
        `Piutang pinjaman ${pinjaman.nomorPinjaman} sebesar ${formatRupiah(writeOffTotal)} telah dihapusbukukan ` +
          `(pokok ${formatRupiah(writeOffPrincipal)}, jasa ${formatRupiah(writeOffJasa)}).`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const tahunBuku = new Date(tanggal).getFullYear();

  // RC-S122 — konfirmasi sebelum hapus buku. Validasi tetap di
  // `validate()`; dialog ini hanya memberi jeda sebelum jurnal dibuat.
  const konfirmasi = () => {
    if (!validate() || !pinjaman) return;
    notify(
      'Konfirmasi hapus buku',
      `Hapus buku piutang ${pinjaman.nomorPinjaman} (${pinjaman.namaAnggota}) sebesar ${formatRupiah(pinjaman.sisaPiutang)}? ` +
        'Jurnalnya masih dapat dibatalkan lewat Detail History Transaksi.',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Hapus Buku', style: 'destructive', onPress: submit },
      ]
    );
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.konten}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PENGHAPUSAN_PIUTANG" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PENGHAPUSAN_PIUTANG" />
        ) : (
        <>
        <KotakInfo nada="netral" judul="Transaksi non-kas">
          Tidak ada uang kas/bank yang bergerak. Sisa piutang pinjaman dikeluarkan dari neraca dengan memakai cadangan
          penyisihan yang sudah dibentuk, lalu pinjaman ditandai Macet. Akun ditentukan otomatis oleh sistem.
        </KotakInfo>

        {ratAda === false && (
          <KotakInfo
            nada="bahaya"
            judul={`RAT tahun buku ${tahunBuku} belum dicatat`}
            aksi={{ label: 'Buka Pelaksanaan RAT', onPress: () => navigation.navigate('PelaksanaanRAT') }}
          >
            Pelaksanaan RAT wajib diisi sebelum SHU dapat dibagikan dan sebelum piutang dapat dihapuskan untuk tahun
            buku ini.
          </KotakInfo>
        )}

        <KartuLangkah nomor={1} judul="Pinjaman macet" keterangan="Hanya pinjaman berkolektibilitas Macet yang dapat dihapus buku.">
          <TouchableOpacity
            style={[styles.selector, errors.pinjaman && styles.selectorError]}
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={pinjaman ? `Pinjaman terpilih ${pinjaman.nomorPinjaman}, ketuk untuk mengganti` : 'Pilih pinjaman macet'}
          >
            <Ionicons name="cash-outline" size={18} color={colors.textMuted} />
            <Text style={pinjaman ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={1}>
              {pinjaman ? `${pinjaman.namaAnggota} · ${pinjaman.nomorPinjaman}` : 'Pilih pinjaman macet'}
            </Text>
            <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} />
          </TouchableOpacity>
          {errors.pinjaman && <FieldError message={errors.pinjaman} />}

          {pinjaman && (
            <View style={styles.detail}>
              <View style={styles.detailKepala}>
                <Text style={styles.detailLabel}>Sisa piutang dihapus</Text>
                <View style={styles.badgeMacet}>
                  <Ionicons name="alert-circle" size={12} color={colors.danger} />
                  <Text style={styles.badgeMacetTeks}>Macet</Text>
                </View>
              </View>
              <Text style={styles.detailNominal}>{formatRupiah(pinjaman.sisaPiutang)}</Text>
              <View style={styles.detailGrid}>
                <Statistik label="Plafon awal" nilai={formatRupiah(pinjaman.jumlahPinjaman)} />
                <Statistik label="Tunggakan" nilai={`${pinjaman.hariTunggakan} hari`} />
                <Statistik label="Tenor" nilai={`${pinjaman.tenor} ${pinjaman.satuanTenor.toLowerCase()}`} />
              </View>
              <Text style={styles.detailCatatan}>
                Sisa piutang sudah dikurangi angsuran yang pernah dibayar, bukan plafon awal.
              </Text>
            </View>
          )}
        </KartuLangkah>

        <KartuLangkah nomor={2} judul="Tanggal & alasan">
          <Text style={styles.label}>Tanggal *</Text>
          <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />
          {errors.rat && <FieldError message={errors.rat} />}

          <View style={styles.jarak}>
            <Text style={styles.label}>Alasan penghapusan *</Text>
            <FocusTextInput
              style={styles.inputMultiline}
              value={alasan}
              onChangeText={setAlasan}
              multiline
              placeholder="Mis. anggota meninggal tanpa ahli waris, tidak bisa dilacak, dsb."
              placeholderTextColor={colors.placeholder}
              invalid={!!errors.alasan}
            />
            {errors.alasan && <FieldError message={errors.alasan} />}
          </View>
        </KartuLangkah>

        {pinjaman ? (
          <RingkasanTransaksi
            judul="Dampak penghapusan"
            nada="bahaya"
            baris={[
              { label: 'Pinjaman', nilai: `${pinjaman.nomorPinjaman} · ${pinjaman.namaAnggota}` },
              { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
              { label: 'Kas/bank', nilai: 'Tidak berubah' },
              { label: 'Status pinjaman', nilai: 'Macet (dihapus buku)' },
              { label: 'Piutang dihapus', nilai: formatRupiah(pinjaman.sisaPiutang), tegas: true },
            ]}
            catatan="Nilai final (pokok + jasa yang sudah diakui) dihitung sistem saat disimpan dan ditampilkan setelahnya."
          />
        ) : null}

        <TombolUtama
          label="Hapus Buku Piutang"
          ikon="trash-outline"
          nada="bahaya"
          onPress={konfirmasi}
          memuat={submitting}
          nonaktif={ratAda === false}
        />

        <PinjamanMacetPickerModal visible={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={setPinjaman} />
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Statistik({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.statistik}>
      <Text style={styles.statistikLabel}>{label}</Text>
      <Text style={styles.statistikNilai} numberOfLines={1}>
        {nilai}
      </Text>
    </View>
  );
}

/** Modal picker pinjaman MACET saja (§14) — inline di file ini karena hanya dipakai satu tempat. */
function PinjamanMacetPickerModal({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (p: PinjamanMacetItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PinjamanMacetItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        setResults(await listPinjamanMacetUntukPenghapusan({ search: query || undefined }));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [query, visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
        {/* RC-S120 — tanpa ini, saat mencari, butir terakhir daftar dan
            tombol di bawahnya berada di belakang papan ketik. */}
        <AreaAmanKeyboard varian="dialog" style={{ flex: 1 }}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Pilih Pinjaman (Macet)</Text>
          <TouchableOpacity style={styles.tutupIkon} onPress={onClose} accessibilityRole="button" accessibilityLabel="Tutup">
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: spacing.lg }}>
          <SearchField
            placeholder="Cari nama anggota atau nomor pinjaman..."
            placeholderTextColor={colors.placeholder}
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 16 }} />}

        {!loading && (
          <FlatList keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: spacing.lg }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  onSelect(item);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityLabel={`${item.namaAnggota}, ${item.nomorPinjaman}, sisa piutang ${formatRupiah(item.sisaPiutang)}`}
              >
                <View style={styles.rowKepala}>
                  <Text style={styles.rowNama} numberOfLines={1}>
                    {item.namaAnggota}
                  </Text>
                  <Text style={styles.rowSisa}>{formatRupiah(item.sisaPiutang)}</Text>
                </View>
                <Text style={styles.rowSub}>
                  {item.nomorPinjaman} · Plafon {formatRupiah(item.jumlahPinjaman)} · {item.tenor} {item.satuanTenor.toLowerCase()}
                </Text>
                <View style={styles.rowTunggakan}>
                  <Ionicons name="time-outline" size={12} color={colors.danger} />
                  <Text style={styles.rowTunggakanTeks}>{item.hariTunggakan} hari tunggakan</Text>
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada pinjaman berkolektibilitas Macet saat ini.</Text>}
          />
        )}

        <View style={styles.footer}>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Tutup</Text>
          </TouchableOpacity>
        </View>
        </AreaAmanKeyboard>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  konten: { padding: spacing.lg, paddingBottom: spacing.xxl },
  jarak: { marginTop: spacing.md },
  label: { fontSize: typography.subtitle, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  selector: { ...formUi.inputWrap, gap: spacing.sm },
  selectorError: { ...formUi.inputWrapError },
  selectorText: { flex: 1, minWidth: 0, fontSize: 15, color: colors.text },
  selectorPlaceholder: { flex: 1, minWidth: 0, fontSize: 15, color: colors.placeholder },
  detail: {
    marginTop: spacing.md,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  detailKepala: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  detailLabel: { fontSize: typography.caption, color: colors.textMuted, fontWeight: '600' },
  badgeMacet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeMacetTeks: { fontSize: 11, fontWeight: '700', color: colors.danger },
  detailNominal: { fontSize: 24, fontWeight: '700', color: colors.danger, marginTop: 2, fontVariant: ['tabular-nums'] },
  detailGrid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  statistik: { flex: 1, minWidth: 0, backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm },
  statistikLabel: { fontSize: 11, color: colors.textMuted },
  statistikNilai: { fontSize: typography.subtitle, fontWeight: '700', color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] },
  detailCatatan: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginTop: spacing.sm },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
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
    marginBottom: spacing.md,
  },
  modalTitle: { ...modalUi.title },
  tutupIkon: { width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowKepala: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  rowNama: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700', color: colors.text },
  rowSisa: { fontSize: 14, fontWeight: '700', color: colors.danger, fontVariant: ['tabular-nums'] },
  rowSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 3 },
  rowTunggakan: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xs },
  rowTunggakanTeks: { fontSize: 11.5, color: colors.danger, fontWeight: '600' },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  closeButton: { ...modalUi.secondaryButton },
  closeButtonText: { ...modalUi.secondaryText },
});
