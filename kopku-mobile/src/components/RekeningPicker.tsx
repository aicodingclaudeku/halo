import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listRekening, RekeningItem } from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

interface RekeningPickerProps {
  label?: string;
  value: RekeningItem | null;
  onChange: (rekening: RekeningItem) => void;
  /** Kecualikan satu rekening dari daftar pilihan (mis. rekening sumber saat memilih tujuan transfer). */
  kecualikanId?: string;
  /**
   * Phase 17 §D/§H: kalau true, daftar HANYA berisi rekening BANK
   * (Kas Tunai/Kas Kecil disembunyikan) — dipakai form yang sudah
   * punya chip Kas/Bank terpisah (mis. Setor & Tarik Simpanan), jadi
   * picker ini cuma perlu tampil & aktif saat opsi "Bank" dipilih.
   */
  hanyaBank?: boolean;
  /**
   * RC-S53 hardening: batasi daftar ke jenis rekening tertentu.
   * OPSIONAL dan tidak mengubah perilaku pemanggil mana pun yang sudah
   * ada — tanpa prop ini daftarnya persis seperti sebelumnya.
   *
   * Dipakai form yang service-nya memang hanya mengenal sebagian jenis
   * (mis. penerimaan Bagian SHU: Kas Umum dan bank saja). Menampilkan
   * pilihan yang pasti ditolak service hanya memancing kesalahan —
   * lebih buruk lagi kalau sampai dipetakan diam-diam ke akun lain.
   * Penjagaan di service TIDAK dihapus; keduanya berlapis.
   */
  jenisDiizinkan?: RekeningItem['jenis'][];
  /**
   * Fase 9 — beri label eksplisit pada nominal di setiap baris, mis.
   * "Saldo Buku". Dipakai layar Rekonsiliasi, yang justru
   * membandingkan saldo BUKU dengan saldo eksternal, sehingga angka
   * tanpa label di sana ambigu.
   *
   * OPSIONAL supaya tampilan picker di seluruh layar lain TIDAK
   * berubah — nilainya sendiri sudah selalu berasal dari ledger.
   */
  labelSaldo?: string;
}

const LABEL_JENIS_SIMPANAN: Record<string, string> = { TABUNGAN: 'Tabungan', GIRO: 'Giro', DEPOSITO: 'Deposito' };

/**
 * Format tampilan "Pilih Rekening" (permintaan pengguna §15): rekening
 * BANK menampilkan Nama Bank — Nomor Rekening — Jenis Simpanan (data
 * AKTUAL dari `RekeningItem`/`listRekening()`, BUKAN hardcode). Kalau
 * rekening lama belum punya jenis simpanan, tampilkan penanda "belum
 * diatur" (bukan data palsu). Rekening KAS tetap hanya menampilkan
 * namanya (Kas Umum dsb.) karena field bank tidak relevan untuk kas.
 */
function formatNamaRekening(item: RekeningItem): string {
  if (item.jenis !== 'BANK') return item.nama;
  // Bug fix (duplikasi nomor rekening): `item.nama` yang dikembalikan
  // listRekening() SUDAH berformat "NamaBank — NomorRekening" (lihat
  // KasBankService.listRekening). Sebelumnya baris ini menambahkan
  // `item.nomorRekening` LAGI secara terpisah, sehingga nomor rekening
  // tampil dua kali (mis. "Bca — 123 — 123 — Tabungan"). `nama` dipakai
  // apa adanya sebagai basis, cukup ditambah label Jenis Simpanan.
  const bagian = [item.nama];
  bagian.push(item.jenisSimpanan ? (LABEL_JENIS_SIMPANAN[item.jenisSimpanan] ?? item.jenisSimpanan) : 'Jenis Simpanan belum diatur');
  return bagian.join(' — ');
}

/**
 * Picker rekening Kas/Kas Kecil/Bank, dipakai form transaksi & transfer
 * (fase 7). Modal-nya dibungkus SafeAreaView (atas & bawah) — sebelumnya
 * pakai `paddingTop: 48` manual & tanpa inset bawah sama sekali,
 * sehingga tombol "Tutup" di bagian bawah ketutup/berhimpitan dengan
 * gesture nav bar Android.
 */
export default function RekeningPicker({ label = 'Rekening', value, onChange, kecualikanId, hanyaBank, jenisDiizinkan, labelSaldo }: RekeningPickerProps) {
  const [open, setOpen] = useState(false);
  const [rekening, setRekening] = useState<RekeningItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    listRekening()
      .then((rows) => {
        // Phase 18 §4: Kas Kecil dinonaktifkan — listRekening() masih
        // mengembalikannya (aktif:false) supaya saldo historis tetap
        // bisa dibaca di tempat lain, tapi picker sumber dana transaksi
        // BARU tidak boleh lagi menawarkannya sebagai pilihan.
        const aktifSaja = rows.filter((r) => r.aktif !== false);
        let hasil = hanyaBank ? aktifSaja.filter((r) => r.jenis === 'BANK') : aktifSaja;
        if (jenisDiizinkan && jenisDiizinkan.length > 0) {
          hasil = hasil.filter((r) => jenisDiizinkan.includes(r.jenis));
        }

        // Bug fix (permintaan pengguna §12 — audit "Pilih Rekening" di
        // semua menu): untuk FORM EDIT, rekening yang SUDAH TERSIMPAN
        // pada transaksi (nilai `value` yang dikirim parent) harus
        // TETAP tampil sebagai opsi terpilih di daftar ini, WALAUPUN
        // rekening itu sekarang berstatus nonaktif — sebelumnya baris
        // ini otomatis hilang dari daftar (ikut ter-filter oleh
        // `aktifSaja` di atas) begitu modal dibuka, sehingga rekening
        // yang sedang dipakai transaksi terlihat "hilang". User TETAP
        // tidak bisa memilih rekening nonaktif LAIN — hanya rekening
        // yang memang sudah jadi `value` saat ini yang dikecualikan
        // dari filter aktif, sumber datanya diambil dari `rows` (data
        // TERBARU, termasuk saldo) supaya tidak menampilkan data basi
        // dari prop `value` kalau memang masih ada di `rows`.
        if (value) {
          const valueKey = `${value.jenis}-${value.id}`;
          const sudahAda = hasil.some((r) => `${r.jenis}-${r.id}` === valueKey);
          if (!sudahAda) {
            const dariRows = rows.find((r) => `${r.jenis}-${r.id}` === valueKey);
            hasil = [...hasil, dariRows ?? value];
          }
        }

        setRekening(hasil);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Gagal memuat daftar rekening.'))
      .finally(() => setLoading(false));
  }, [open, hanyaBank, jenisDiizinkan, value]);

  const daftarTampil = rekening.filter((r) => !(kecualikanId && `${r.jenis}-${r.id}` === kecualikanId));

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label} *</Text>
      <TouchableOpacity accessibilityRole="button" style={styles.selector} onPress={() => setOpen(true)}>
        <Ionicons name="business-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? formatNamaRekening(value) : 'Pilih rekening...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Rekening</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
          {!loading && error && <Text style={styles.errorText}>{error}</Text>}
          {!loading && !error && (
            <FlatList
              data={daftarTampil}
              keyExtractor={(item) => `${item.jenis}-${item.id}`}
              contentContainerStyle={{ paddingHorizontal: spacing.lg }}
              renderItem={({ item }) => {
                const isSelected = !!value && `${value.jenis}-${value.id}` === `${item.jenis}-${item.id}`;
                const isNonaktif = item.aktif === false;
                return (
                  <TouchableOpacity
                    style={[styles.row, isSelected && styles.rowSelected]}
                    onPress={() => {
                      onChange(item);
                      setOpen(false);
                    }}
                  >
                    <View style={styles.rowIcon}>
                      <Ionicons name={item.jenis === 'BANK' ? 'business-outline' : 'cash-outline'} size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowNama}>{formatNamaRekening(item)}</Text>
                      <Text style={styles.rowSub}>
                        {item.jenis === 'BANK' ? 'Bank' : 'Kas'}
                        {isNonaktif ? ' · Nonaktif (rekening tersimpan pada transaksi ini)' : ''}
                      </Text>
                    </View>
                    <View style={styles.rowSaldoWrap}>
                      {labelSaldo ? <Text style={styles.rowSaldoLabel}>{labelSaldo}</Text> : null}
                      <Text style={styles.rowSaldo}>{formatRupiah(item.saldo)}</Text>
                    </View>
                    {isSelected && <Ionicons name="checkmark-circle" size={18} color={colors.primary} style={{ marginLeft: spacing.sm }} />}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada rekening tersedia.</Text>}
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
  rowSelected: { backgroundColor: colors.primaryLight },
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
  rowSaldoWrap: { alignItems: 'flex-end' },
  rowSaldoLabel: { fontSize: 10, color: colors.textMuted },
  rowSaldo: { fontSize: 13, fontWeight: '700', color: colors.primary },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  errorText: { textAlign: 'center', color: colors.danger, marginTop: 24 },
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
