import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listAkunKewajibanUmum, AkunKewajibanOption } from '@/services/UtangService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

/**
 * Revisi KOPKU (Bagian 2): picker akun LIABILITAS untuk "Bayar
 * Kewajiban" — sumber pilihan SEKARANG dari COA (`listAkunKewajiban`,
 * yang sudah mengecualikan Simpanan Sukarela), BUKAN lagi langsung
 * menampilkan record `utang` berdasarkan nama pemberi. Dipakai
 * `BayarUtangFormScreen` sebagai LANGKAH PERTAMA — akun yang dipilih
 * di sini menentukan apakah layar berikutnya menampilkan `UtangPicker`
 * (akun Utang Bank/Pihak Lain/Usaha — tetap pakai tracking
 * pokok/bunga/outstanding existing) atau form pembayaran langsung
 * (kewajiban COA umum lain, mis. Dana Pendidikan, Utang Pajak).
 *
 * Revisi "Akun Liabilitas" (audit lanjutan menu Kewajiban):
 *  - Istilah UI diringkas dari "Akun Kewajiban" -> "Akun Liabilitas".
 *  - Setiap baris SEKARANG menampilkan saldo akun (dari
 *    `AkunKewajibanOption.saldo`, sudah dihitung `listAkunKewajiban`
 *    lewat `getAccountBalance` ledger existing — TIDAK ada saldo baru
 *    yang dihitung di sini) di samping nama akun.
 *  - Ditambahkan ringkasan "Total Liabilitas" (jumlah saldo SELURUH
 *    akun yang tampil di daftar ini — Simpanan Sukarela sudah
 *    dikecualikan dari sumbernya, jadi otomatis tidak ikut terhitung).
 *  - Saldo negatif ditampilkan apa adanya (TANPA Math.max/Math.abs).
 */
/**
 * RC-S50 §7 — AKUN YANG TIDAK DITAWARKAN DI PICKER INI.
 *
 * `2-1210` (Simpanan Anggota Berjangka) dan `2-1300` (Utang Bunga
 * Simpanan Berjangka) adalah kewajiban yang saldonya DIKENDALIKAN
 * SEPENUHNYA oleh siklus simpanan berjangka: penempatan kontrak,
 * akrual bunga per periode, dan pencairan — semuanya dijurnal otomatis
 * oleh `SimpananBerjangkaLifecycleService`. Membayarnya lewat menu
 * "Kewajiban Koperasi" akan mengurangi saldo GL tanpa mengubah
 * subledger `simpanan_berjangka`, sehingga rekonsiliasi kontrak vs GL
 * langsung tidak cocok.
 *
 * INI FILTER TAMPILAN SAJA, dan sengaja dipasang di picker:
 *  - kedua akun TETAP ADA di COA, tetap punya mapping, tetap muncul di
 *    Neraca Saldo/Buku Besar/Laporan Posisi Keuangan;
 *  - `listAkunKewajiban()` TIDAK diubah, karena ia juga sumber
 *    kebenaran untuk hal lain (dan diuji tersendiri);
 *  - tidak ada jurnal, saldo, atau accounting engine yang tersentuh.
 *
 * Daftar ini memakai KODE AKUN, bukan nama, supaya tidak ikut rusak
 * bila suatu saat labelnya diganti.
 */
/**
 * RC-S53 §D — 2-1710 Utang Bunga Simpanan Berjangka IKUT DISEMBUNYIKAN.
 *
 * Akunnya TIDAK dihapus dan TIDAK berubah: ia tetap ada di COA, GL,
 * Neraca Saldo, Laporan Posisi Keuangan, dan tetap dipakai lifecycle
 * Simpanan Berjangka. Yang dicabut hanya kemunculannya di picker
 * pembayaran kewajiban MANUAL — saldonya dibentuk dan dilunasi oleh
 * lifecycle berjangka, sehingga pembayaran manual ke akun ini akan
 * merusak rekonsiliasi subledger bunga.
 */
export const KODE_AKUN_DISEMBUNYIKAN_PICKER: readonly string[] = ['2-1210', '2-1300', '2-1710'];

/**
 * RC-S74 — picker ini sekarang HANYA untuk "Kewajiban Lainnya" (kewajiban
 * COA umum). Sumber data `listAkunKewajibanUmum()`: pengecualian berbasis
 * ACCOUNT MAPPING di service (Simpanan Sukarela, 2-1210, 2-1300, 2-1710,
 * Utang Bank/Pihak Lain/Usaha tracked, Utang Bunga) dan hanya saldo > 0.
 * Filter kode di atas dipertahankan sebagai lapis pertahanan kedua di layar.
 * Utang Koperasi (tracked) dipilih lewat UtangPicker, bukan lewat picker ini.
 * "Total Akun Terpilih" dihapus — angka itu bukan jumlah akun yang dipilih.
 */

export default function KewajibanAkunPicker({
  value,
  onChange,
  error,
}: {
  value: AkunKewajibanOption | null;
  onChange: (akun: AkunKewajibanOption) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<AkunKewajibanOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLoadError(null);
    listAkunKewajibanUmum()
      .then((daftar) => setResults(daftar.filter((a) => !KODE_AKUN_DISEMBUNYIKAN_PICKER.includes(a.kode))))
      .catch(() => setLoadError('Daftar kewajiban gagal dimuat. Coba lagi.'))
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Pilih Kewajiban *</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="document-text-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.kode} — ${value.nama}` : 'Pilih kewajiban yang akan dibayar...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Kewajiban</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
          {!loading && loadError && <Text style={styles.errorTextModal}>{loadError}</Text>}
          {!loading && !loadError && (
            <FlatList
              data={results}
              keyExtractor={(item) => item.accountId}
              contentContainerStyle={{ paddingHorizontal: spacing.lg }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                >
                  <View style={styles.rowIcon}>
                    <Ionicons name="document-text-outline" size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowNama}>
                      {item.kode} — {item.nama}
                    </Text>
                    <Text style={styles.rowSub}>Kewajiban umum</Text>
                    <Text style={styles.rowSaldoLabel}>
                      Saldo: <Text style={styles.rowSaldo}>{formatRupiah(item.saldo)}</Text>
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  Tidak ada kewajiban lain yang perlu dibayar saat ini.
                </Text>
              }
            />
          )}

          <View style={styles.footer}>
            <TouchableOpacity style={styles.closeButton} onPress={() => setOpen(false)}>
              <Text style={styles.closeButtonText}>Tutup</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

/** UI/UX REDESIGN — penanda visual bahwa field ini dapat dibuka (tidak mengubah onPress/opsi). */
const pickerAffordance = { flexShrink: 0 };

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  selector: { gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  selectorError: { borderColor: colors.danger },
  selectorText: { flex: 1, fontSize: 15, color: colors.text },
  selectorPlaceholder: { flex: 1, fontSize: 15, color: colors.placeholder },
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
  closeIcon: { ...modalUi.closeIcon },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowSaldoLabel: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  rowSaldo: { fontSize: 13, fontWeight: '700', color: colors.text },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24, paddingHorizontal: spacing.lg },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  errorTextModal: { textAlign: 'center', color: colors.danger, marginTop: 24 },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  closeButton: {
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeButtonText: { color: colors.text, fontWeight: '700' },
});
