import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listAnggota, Anggota } from '@/repositories/AnggotaRepository';
import { listAnggotaSaldoSukarelaTersedia } from '@/services/SimpananService';
import { listAnggotaDenganBerjangkaEligible } from '@/services/SimpananBerjangkaService';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';

import SearchField from '@/components/SearchField';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { keteranganJumlahPicker } from '@/components/hasilPicker';

interface AnggotaPickerProps {
  value: Anggota | null;
  onChange: (anggota: Anggota) => void;
  error?: string;
  /**
   * Phase 17 §A: dipakai di TarikSimpananFormScreen. Ketika true, daftar
   * kandidat HANYA anggota dengan saldo simpanan sukarela > 0 (bukan
   * cuma cek status aktif) — anggota yang hanya punya simpanan
   * pokok/wajib, atau yang saldo sukarelanya sudah 0, tidak muncul.
   * Filter dilakukan di service layer (query SQL), bukan di UI saja.
   */
  onlyWithSaldoSukarela?: boolean;
  /**
   * RC-S53 §E: dipakai TarikSimpananFormScreen pada mode BERJANGKA.
   * Ketika true, kandidat HANYA anggota yang punya kontrak simpanan
   * berjangka yang masih dapat diproses (relasi anggota ->
   * simpanan_berjangka, status AKTIF/JATUH_TEMPO). Kontrak DICAIRKAN
   * dan DIBATALKAN tidak membuat anggota muncul.
   *
   * Saling eksklusif dengan `onlyWithSaldoSukarela` — keduanya menjawab
   * pertanyaan "kandidat mana", dan dua jawaban sekaligus tidak punya
   * arti. Bila keduanya true, yang berjangka menang (lihat useEffect).
   */
  onlyWithBerjangkaEligible?: boolean;
  /**
   * Bug fix (Edit Pinjaman): saat true, selector tidak membuka modal
   * pemilihan — dipakai untuk menampilkan anggota SECARA READ-ONLY
   * ketika field ini memang tidak boleh diubah lewat form (mis. edit
   * pinjaman yang belum cair — editPinjaman() sengaja tidak
   * mengizinkan ganti anggota). Default false, tidak mengubah perilaku
   * pemanggil existing mana pun.
   */
  disabled?: boolean;
}

/** Picker anggota dengan pencarian offline (PRD §37), dipakai di form Simpanan/Pinjaman. */
export default function AnggotaPicker({
  value,
  onChange,
  error,
  onlyWithSaldoSukarela,
  onlyWithBerjangkaEligible,
  disabled,
}: AnggotaPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Anggota[]>([]);

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(async () => {
      /*
       * RC-S118.1: ketiga jalur meminta seluruh data — tanpa
       * LIMIT/OFFSET sama sekali, sehingga yang tampil adalah jumlah
       * anggota yang SEBENARNYA.
       *
       * Yang membedakan ketiga jalur ini BUKAN berapa banyak yang
       * ditampilkan, melainkan SIAPA yang layak muncul, dan itu tidak
       * berubah: Tarik Simpanan hanya anggota bersaldo sukarela,
       * pencairan berjangka hanya anggota berkontrak berjangka, dan
       * selebihnya seluruh anggota aktif.
       */
      if (onlyWithBerjangkaEligible) {
        const rows = await listAnggotaDenganBerjangkaEligible({ search: query, semuaData: true });
        setResults(
          rows.map((r) => ({
            id: r.id,
            nomorAnggota: r.nomorAnggota,
            namaLengkap: r.namaLengkap,
            nik: r.nik ?? undefined,
            status: r.status as Anggota['status'],
            tanggalBergabung: '',
          }))
        );
      } else if (onlyWithSaldoSukarela) {
        const rows = await listAnggotaSaldoSukarelaTersedia({ search: query, semuaData: true });
        setResults(
          rows.map((r) => ({
            id: r.id,
            nomorAnggota: r.nomorAnggota,
            namaLengkap: r.namaLengkap,
            nik: r.nik ?? undefined,
            status: r.status as Anggota['status'],
            tanggalBergabung: '',
          }))
        );
      } else {
        const rows = await listAnggota({ search: query, status: 'AKTIF', semuaData: true });
        setResults(rows);
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [query, open, onlyWithSaldoSukarela, onlyWithBerjangkaEligible]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Anggota *</Text>
      <TouchableOpacity accessibilityRole="button"
        style={[styles.selector, error && styles.selectorError, disabled && styles.selectorDisabled]}
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
      >
        <Ionicons name="person-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.namaLengkap} (${value.nomorAnggota})` : 'Pilih anggota...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          {/* RC-S120 — tanpa ini, saat mencari, butir terakhir daftar dan
              tombol Tutup berada di belakang papan ketik. */}
          <AreaAmanKeyboard varian="dialog" style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Anggota</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari nama, nomor anggota, atau NIK..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
            {/*
              RC-S118.1: keterangan jumlah SELALU tampil. Angka yang hanya
              muncul ketika ada yang tidak beres membuat ketiadaannya ikut
              bermakna, dan itu justru lebih mudah salah dibaca daripada
              angka yang selalu ada.
            */}
            <Text style={styles.keteranganJumlah}>
              {keteranganJumlahPicker(results.length, query.trim().length > 0)}
            </Text>
          </View>

          <FlatList keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg }}
            renderItem={({ item, index }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  onChange(item);
                  setOpen(false);
                }}
              >
                {/*
                  NOMOR URUT TAMPILAN (§C).

                  AnggotaPicker adalah komponen BERSAMA — dipakai
                  Pemberian Pinjaman, Setor Simpanan, Tarik Simpanan,
                  dan layar lain. Menambahkan nomor di sini sekaligus
                  memenuhi permintaan untuk daftar peminjam TANPA
                  menduplikasi komponen pemilih anggota.

                  Nomornya berasal dari `index` FlatList, yaitu posisi
                  pada `results` — daftar yang SUDAH tersaring pencarian.
                  Jadi penomoran otomatis mengikuti hasil yang tampil dan
                  selalu mulai dari 1.

                  BUKAN `item.id` maupun `item.nomorAnggota`: keduanya
                  identitas anggota, bukan posisi. Tidak ada kolom baru
                  di database — ini murni lapisan presentasi.
                */}
                <Text style={styles.rowNomor}>{index + 1}</Text>
                <View style={styles.rowIsi}>
                  <Text style={styles.rowNama} numberOfLines={1}>
                    {item.namaLengkap}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.nomorAnggota} · {item.nik ?? 'NIK belum diisi'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                {onlyWithBerjangkaEligible
                  ? 'Tidak ada anggota dengan simpanan berjangka yang dapat diproses.'
                  : onlyWithSaldoSukarela
                    ? 'Tidak ada anggota dengan saldo simpanan sukarela.'
                    : 'Tidak ada anggota ditemukan.'}
              </Text>
            }
          />

          <View style={styles.footer}>
            <TouchableOpacity style={styles.closeButton} onPress={() => setOpen(false)}>
              <Text style={styles.closeButtonText}>Tutup</Text>
            </TouchableOpacity>
          </View>
          </AreaAmanKeyboard>
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
  selectorDisabled: { backgroundColor: colors.background, opacity: 0.7 },
  selectorText: { flex: 1, fontSize: 15, color: colors.text },
  selectorPlaceholder: { flex: 1, fontSize: 15, color: colors.placeholder },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
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
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /*
   * Lebar minimum tetap agar kolom nomor sejajar antar-baris; tanpa itu
   * "1" dan "10" menggeser nama di sebelahnya. `minWidth` (bukan
   * `width`) supaya nomor tiga digit tetap muat.
   */
  rowNomor: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  rowIsi: { flex: 1, minWidth: 0 },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  keteranganJumlah: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.xs },
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
