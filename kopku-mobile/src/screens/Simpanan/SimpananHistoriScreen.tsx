import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  labelJenisSimpanan,
  labelTipeSimpanan,
  tandaTipeSimpanan,
  nadaTipeSimpanan,
  ikonTipeSimpanan,
} from '@/reports/TampilanAnggotaPlan';
import { View, Text, FlatList, ActivityIndicator, StyleSheet, TouchableOpacity, Pressable, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  listSimpananHistori,
  listSaldoSimpananSemuaAnggota,
  SimpananHistoriRow,
  JenisSimpanan,
} from '@/services/SimpananService';
import { exportLaporan, shareExportedFile } from '@/services/ExportService';
import { FormatExport } from '@/export/ExportTypes';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { buildSimpananExport } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

// Update pasca-Phase 18/19 (permintaan pengguna §X): opsi "Semua"
// DIHAPUS — hanya Pokok/Wajib/Sukarela. Filter tetap menampilkan
// SELURUH transaksi untuk jenis yang dipilih (tidak ada perubahan di
// situ, hanya pilihan "lihat campuran semua jenis sekaligus" yang
// dihilangkan).
const JENIS_TAB: { value: JenisSimpanan; label: string }[] = [
  { value: 'POKOK', label: 'Pokok' },
  { value: 'WAJIB', label: 'Wajib' },
  { value: 'SUKARELA', label: 'Sukarela' },
];

const FORMAT_OPTIONS: { format: FormatExport; label: string }[] = [
  { format: 'PDF', label: 'PDF' },
  { format: 'EXCEL', label: 'Excel (.xlsx)' },
  { format: 'CSV', label: 'CSV' },
];

/**
 * Histori seluruh transaksi simpanan (PRD §8-10).
 *
 * UI: satu baris tab sederhana untuk menyaring tampilan — mirip
 * filter di banyak layar lain di app ini, jadi tidak perlu dipelajari
 * ulang. Semua opsi export yang lebih detail (pilih jenis mana yang
 * mau diexport + opsi total seluruh anggota) dipindah ke dalam modal
 * "Export", supaya layar utama tidak penuh checkbox sejak awal.
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §X): opsi tab "Semua"
 * DIHAPUS — user WAJIB memilih salah satu dari Pokok/Wajib/Sukarela
 * (default: Pokok). Filter tetap menampilkan SELURUH transaksi untuk
 * jenis yang dipilih — hanya opsi "gabungkan semua jenis" yang hilang.
 *
 * RC-S123 — SEGMEN "RIWAYAT" (permintaan pengguna). Panel riwayat Setor
 * Simpanan (`RiwayatTransaksiMenu menu="SIMPANAN_SETOR"`: filter periode,
 * pencarian, status Dibatalkan/Koreksi, dan pintu ke Detail History
 * Transaksi untuk koreksi/pembatalan) DIPINDAH ke sini dari form Setor
 * Simpanan, tempat ia tersembunyi di balik tombol + lalu tab "Riwayat".
 * Layar ini kini punya dua segmen sejajar di atas: "Daftar Simpanan"
 * (daftar per jenis yang sudah ada, tidak berubah) dan "Riwayat".
 * Komponen riwayat, konfigurasi jenis jurnal, dan service TIDAK diubah.
 */
export default function SimpananHistoriScreen() {
  const insets = useSafeAreaInsets();
  // Satu deklarasi saja. `<any>` dipertahankan karena itulah bentuk yang
  // sudah dipakai layar-layar lain di proyek ini; menggantinya dengan
  // versi bertipe akan menuntut tipe param navigator yang belum ada.
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const [data, setData] = useState<SimpananHistoriRow[]>([]);
  const [tab, setTab] = useState<JenisSimpanan>('POKOK');
  const [tampilan, setTampilan] = useState<'DAFTAR' | 'RIWAYAT'>('DAFTAR');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [jenisDicentang, setJenisDicentang] = useState<Set<JenisSimpanan>>(
    () => new Set(['POKOK', 'WAJIB', 'SUKARELA'])
  );
  const [includeTotalSeluruhAnggota, setIncludeTotalSeluruhAnggota] = useState(false);
  const [memproses, setMemproses] = useState<FormatExport | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // Ambil semua transaksi (bukan hanya 50 pertama) supaya export laporan
      // "Simpanan Anggota" (fase 6) selalu lengkap.
      const rows = await listSimpananHistori({ limit: 100000 });
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat histori simpanan.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation]);

  const tampilkanData = data.filter((d) => d.jenis === tab);

  const toggleJenis = (j: JenisSimpanan) => {
    setJenisDicentang((prev) => {
      const next = new Set(prev);
      if (next.has(j)) next.delete(j);
      else next.add(j);
      return next;
    });
  };

  /**
   * Tombol Export di header navigasi, sejajar judul "Simpanan".
   *
   * `useLayoutEffect` (bukan `useEffect`) dipakai supaya tombol sudah
   * terpasang pada frame pertama — dengan `useEffect`, header sempat
   * ter-render sekali tanpa tombol dan terlihat berkedip.
   *
   * Handler-nya TIDAK diubah: tombol tetap hanya membuka modal export
   * yang sudah ada. Tidak ada logika export yang berpindah ke sini.
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          style={styles.headerExportButton}
          onPress={() => setExportOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Export data simpanan"
          // Area sentuh diperlebar tanpa memperbesar tampilannya —
          // ikon 18px saja berada di bawah ambang 44px yang nyaman
          // ditekan di layar kecil.
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="download-outline" size={18} color={colors.primary} />
          <Text style={styles.headerExportText}>Export</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const jalankanExport = async (format: FormatExport) => {
    if (!koperasi || !currentUser) return;
    const jenisArray = Array.from(jenisDicentang);
    if (jenisArray.length === 0) {
      notify('Pilih Jenis Simpanan', 'Centang minimal satu jenis simpanan untuk diexport.');
      return;
    }
    setMemproses(format);
    try {
      const dataExport = data.filter((d) => jenisDicentang.has(d.jenis));
      let totalSeluruhAnggota: { pokok: number; wajib: number; sukarela: number } | undefined;
      if (includeTotalSeluruhAnggota) {
        const rows = await listSaldoSimpananSemuaAnggota();
        totalSeluruhAnggota = {
          pokok: rows.reduce((a, r) => a + r.pokok, 0),
          wajib: rows.reduce((a, r) => a + r.wajib, 0),
          sukarela: rows.reduce((a, r) => a + r.sukarela, 0),
        };
      }
      const laporan = buildSimpananExport(
        { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
        dataExport,
        `Per ${getTanggalLokalHariIni()}`,
        jenisArray,
        totalSeluruhAnggota
      );
      const file = await exportLaporan(currentUser.id, laporan, format);
      setMemproses(null);
      setExportOpen(false);
      notify('Export Berhasil', `File ${file.fileName} berhasil dibuat.`, [
        { text: 'Tutup', style: 'cancel' },
        {
          text: 'Bagikan',
          onPress: () =>
            shareExportedFile(file).catch((e) =>
              notify('Gagal Membagikan', e instanceof Error ? e.message : 'Terjadi kesalahan.')
            ),
        },
      ]);
    } catch (e) {
      setMemproses(null);
      notify('Export Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan saat membuat file.');
    }
  };

  return (
    <View style={styles.container}>
      {/*
        PART D — tombol Export DIPINDAH ke header navigasi.

        Judul "Simpanan" berasal dari `options={{ title: 'Simpanan' }}`
        di RootNavigator, yaitu header navigasi — BUKAN teks di dalam
        layar. Selama tombol Export berada di dalam body layar, ia
        selalu berada satu baris DI BAWAH judul dan tidak akan pernah
        sejajar dengannya. Itulah gejala "terlalu rendah" yang
        dilaporkan.

        Karena itu tombolnya dipasang lewat `headerRight` (lihat
        `useLayoutEffect` di atas). Dengan begitu ia benar-benar berada
        pada baris yang sama dengan judul, rata kanan, dan Safe Area
        ditangani header navigasi itu sendiri — tanpa posisi absolut
        dan tanpa perhitungan inset manual.

        Baris ini kini hanya berisi tab jenis simpanan.
      */}
      <View style={styles.segmen} accessibilityRole="tablist">
        {(
          [
            ['DAFTAR', 'Daftar Simpanan', 'wallet-outline'],
            ['RIWAYAT', 'Riwayat', 'time-outline'],
          ] as const
        ).map(([nilai, label, ikon]) => {
          const aktif = tampilan === nilai;
          return (
            <TouchableOpacity
              key={nilai}
              style={[styles.segmenItem, aktif && styles.segmenItemAktif]}
              onPress={() => setTampilan(nilai)}
              accessibilityRole="tab"
              accessibilityState={{ selected: aktif }}
              accessibilityLabel={label}
              activeOpacity={0.8}
            >
              <Ionicons name={ikon} size={16} color={aktif ? colors.white : colors.textMuted} />
              <Text style={[styles.segmenTeks, aktif && styles.segmenTeksAktif]} numberOfLines={1}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {tampilan === 'RIWAYAT' ? (
        <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
          <ScrollView {...PROP_SCROLL_FORM} contentContainerStyle={[styles.riwayatIsi, { paddingBottom: 96 + insets.bottom }]}>
            <RiwayatTransaksiMenu menu="SIMPANAN_SETOR" />
          </ScrollView>
        </AreaAmanKeyboard>
      ) : (
      <>
      <View style={styles.headerRow}>
        <View style={styles.tabRow}>
          {JENIS_TAB.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.tab, tab === opt.value && styles.tabActive]}
              onPress={() => setTab(opt.value)}
            >
              <Text style={[styles.tabText, tab === opt.value && styles.tabTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {loading && <ActivityIndicator style={styles.center} color={colors.primary} />}

      {!loading && error && (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={32} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && tampilkanData.length === 0 && (
        <View style={styles.center}>
          <Ionicons name="wallet-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyJudul}>Belum ada transaksi simpanan</Text>
          <Text style={styles.emptyText}>Tekan tombol Setor Simpanan di pojok kanan bawah untuk mencatat setoran.</Text>
        </View>
      )}

      {!loading && tampilkanData.length > 0 && (
        <FlatList
          data={tampilkanData}
          keyExtractor={(item) => item.id}
          // Ruang di bawah supaya tombol Setor Simpanan tidak menutupi baris terakhir.
          contentContainerStyle={{ paddingBottom: 96 + insets.bottom }}
          renderItem={({ item }) => {
            // Label dibaca screen reader menggantikan seluruh isi baris,
            // jadi ia memuat yang menentukan identitas transaksi
            // (siapa, jenis apa, berapa) — bukan seluruh teks yang
            // terlihat, yang akan membuatnya terlalu panjang.
            // Tanda diambil dari modul tampilan, bukan ditebak dengan
            // `tipe === 'TARIK' ? '-' : '+'` seperti dulu: rumus lama
            // memberi '+' pada KOREKSI yang sebenarnya bisa MENGURANGI
            // saldo — tanda yang salah tapi terlihat meyakinkan.
            const arah = tandaTipeSimpanan(item.tipe);
            const nada = nadaTipeSimpanan(item.tipe);
            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => navigation.navigate('SimpananDetail', { simpananId: item.id })}
                accessibilityRole="button"
                accessibilityLabel={`Lihat detail simpanan ${labelJenisSimpanan(item.jenis)} milik ${item.namaAnggota}, ${formatRupiah(item.nominal)}`}
              >
                {/* Ikon arah: satu tanda yang bisa dipindai mata jauh
                    lebih cepat daripada membaca kata "SETOR"/"TARIK"
                    di tengah baris teks seukuran sama. */}
                <View style={[styles.ikonBulat, styles[`ikonBulat_${nada}`]]}>
                  <Ionicons
                    name={ikonTipeSimpanan(item.tipe) as React.ComponentProps<typeof Ionicons>['name']}
                    size={18}
                    color={nada === 'keluar' ? colors.danger : nada === 'masuk' ? colors.primary : colors.textMuted}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.nama} numberOfLines={1}>{item.namaAnggota}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    Simpanan {labelJenisSimpanan(item.jenis)} · {labelTipeSimpanan(item.tipe)}
                  </Text>
                  <Text style={styles.nomor} numberOfLines={1}>
                    {item.nomorTransaksi} · {item.tanggal}
                  </Text>
                </View>
                <View style={styles.kanan}>
                  <Text style={[styles.nominal, nada === 'keluar' && styles.nominalTarik]}>
                    {arah}
                    {formatRupiah(item.nominal)}
                  </Text>
                  {/* Penanda visual bahwa baris ini dapat dibuka. */}
                  <Ionicons name="chevron-forward-outline" size={16} color={colors.textFaint} />
                </View>
              </Pressable>
            );
          }}
        />
      )}
      </>
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('SimpananForm')}
        accessibilityRole="button"
        accessibilityLabel="Setor simpanan"
      >
        <Ionicons name="add" size={22} color={colors.white} />
        <Text style={styles.fabTeks}>Setor Simpanan</Text>
      </TouchableOpacity>

      <Modal visible={exportOpen} transparent animationType="fade" onRequestClose={() => setExportOpen(false)}>
        <View style={styles.overlay}>
          <View style={[styles.sheet, { paddingBottom: 32 + insets.bottom }]}>
            <Text style={styles.sheetTitle}>Export Simpanan</Text>

            <Text style={styles.sheetLabel}>Jenis yang diexport</Text>
            {(['POKOK', 'WAJIB', 'SUKARELA'] as JenisSimpanan[]).map((j) => {
              const checked = jenisDicentang.has(j);
              return (
                <TouchableOpacity key={j} style={styles.checkRow} onPress={() => toggleJenis(j)}>
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Ionicons name="checkmark" size={14} color={colors.white} />}
                  </View>
                  <Text style={styles.checkLabel}>Simpanan {j.charAt(0) + j.slice(1).toLowerCase()}</Text>
                </TouchableOpacity>
              );
            })}

            <View style={styles.divider} />

            <TouchableOpacity style={styles.checkRow} onPress={() => setIncludeTotalSeluruhAnggota((v) => !v)}>
              <View style={[styles.checkbox, includeTotalSeluruhAnggota && styles.checkboxChecked]}>
                {includeTotalSeluruhAnggota && <Ionicons name="checkmark" size={14} color={colors.white} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkLabel}>Sertakan Total Seluruh Anggota</Text>
                <Text style={styles.checkHint}>Tambahkan ringkasan total saldo per jenis di seluruh koperasi</Text>
              </View>
            </TouchableOpacity>

            <View style={styles.divider} />

            <Text style={styles.sheetLabel}>Pilih format</Text>
            {FORMAT_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.format}
                style={styles.formatOption}
                onPress={() => jalankanExport(opt.format)}
                disabled={memproses !== null}
              >
                {memproses === opt.format ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <Ionicons name="document-outline" size={16} color={colors.primary} />
                )}
                <Text style={styles.formatOptionText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity style={styles.cancelButton} onPress={() => setExportOpen(false)} disabled={memproses !== null}>
              <Text style={styles.cancelButtonText}>Batal</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerExportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  headerExportText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  tabRow: { flexDirection: 'row', gap: 6, flex: 1 },
  tab: { flex: 1, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontSize: 12, color: colors.text, fontWeight: '600' },
  tabTextActive: { color: colors.white, fontWeight: '700' },
  exportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  exportButtonText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  emptyText: { color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  errorText: { color: colors.danger, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  ikonBulat: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  ikonBulat_masuk: { backgroundColor: colors.primaryLight },
  ikonBulat_keluar: { backgroundColor: colors.dangerBg },
  ikonBulat_netral: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  // Umpan balik tekan yang halus — baris tetap terlihat sebagai baris
  // daftar, bukan tombol besar.
  rowPressed: { backgroundColor: colors.background },
  kanan: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  nama: { fontSize: 14.5, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  nomor: { fontSize: 11, color: colors.textFaint, marginTop: 2, fontVariant: ['tabular-nums'] },
  nominal: { fontSize: 14, fontWeight: '800', color: colors.primary, fontVariant: ['tabular-nums'] },
  nominalTarik: { color: colors.danger },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg + 2,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabTeks: { color: colors.white, fontWeight: '700', fontSize: 14 },
  // RC-S123 — segmen Daftar Simpanan | Riwayat (bentuk sama dengan TabTransaksi).
  segmen: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 4,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  segmenItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 40,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
  },
  segmenItemAktif: { backgroundColor: colors.primary },
  segmenTeks: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  segmenTeksAktif: { color: colors.white },
  riwayatIsi: { padding: spacing.lg },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: 32,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  sheetLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: spacing.sm, textTransform: 'uppercase' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkLabel: { fontSize: 13, color: colors.text, fontWeight: '600' },
  checkHint: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  formatOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  formatOptionText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  cancelButton: { paddingVertical: 14, alignItems: 'center', marginTop: spacing.sm },
  cancelButtonText: { color: colors.textMuted, fontWeight: '600' },
});
