import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listUtang, UtangListItem, lengkapiBasisBungaUtang, BasisBunga } from '@/services/UtangService';
import {
  getStatusBungaSemuaUtang,
  LABEL_STATUS_BUNGA_UTANG,
  StatusBungaUtangDetail,
} from '@/services/UtangBungaAccrualService';
import { jalankanTugasStartup, tungguTugasStartupSelesai } from '@/services/StartupTasks';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { usePermission } from '@/hooks/usePermission';
import ExportButton from '@/components/ExportButton';
import SearchField from '@/components/SearchField';
import { buildUtangExport } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

/** RC-S74 §14 — filter tampilan saja (tidak mengubah data/akuntansi). */
type FilterStatus = 'SEMUA' | 'AKTIF' | 'LUNAS';
type FilterJenis = 'SEMUA' | 'BANK' | 'PIHAK_LAIN' | 'UTANG_USAHA';
const FILTER_STATUS: { v: FilterStatus; label: string }[] = [
  { v: 'SEMUA', label: 'Semua' },
  { v: 'AKTIF', label: 'Aktif' },
  { v: 'LUNAS', label: 'Lunas' },
];
const FILTER_JENIS: { v: FilterJenis; label: string }[] = [
  { v: 'SEMUA', label: 'Semua' },
  { v: 'BANK', label: 'Bank' },
  { v: 'PIHAK_LAIN', label: 'Pihak Lain' },
  { v: 'UTANG_USAHA', label: 'Utang Usaha' },
];

const JENIS_PEMBERI_LABEL: Record<string, string> = {
  BANK: 'Bank',
  PIHAK_LAIN: 'Pihak Lain',
  UTANG_USAHA: 'Utang Usaha (Pembelian Aset)',
};

/**
 * "Daftar Utang" (§E, permintaan pengguna) — masuk dari Laporan >
 * Rincian Laporan Lainnya. Layar RINCIAN/READ-ONLY murni di atas
 * `UtangService.listUtang()` yang sudah ada (BUKAN transaksi baru,
 * tidak ada tombol tambah/edit/hapus di sini — pencatatan utang tetap
 * lewat menu Penerimaan > Utang Koperasi & pelunasan lewat Pengeluaran
 * > Kewajiban, seperti biasa). Menutup gap yang sama seperti "Daftar
 * Investasi"/"Daftar Aset" sebelumnya.
 *
 * RC-S71 — setiap utang berbunga menampilkan section "Status Bunga"
 * (akrual otomatis, akrual terakhir, utang bunga, status). Layar ini TIDAK
 * menjalankan mesin akrual dan tidak meminta nominal apa pun. Satu-satunya
 * aksi adalah melengkapi basis bunga utang warisan (fakta kontrak, lewat
 * `UtangService.lengkapiBasisBungaUtang`, ber-permission & ber-audit); setelah
 * itu rantai tugas startup dijalankan ulang sehingga akrual tertinggal
 * dibukukan oleh mesin yang sama.
 */
export default function DaftarUtangScreen() {
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const { can } = usePermission();
  const canExport = can('kas_bank', 'export');
  const canEdit = can('kas_bank', 'edit');
  const currentUser = useAppStore((s) => s.currentUser);

  const [statusBunga, setStatusBunga] = useState<Map<string, StatusBungaUtangDetail>>(new Map());
  const [menyimpanBasis, setMenyimpanBasis] = useState<string | null>(null);

  const [data, setData] = useState<UtangListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('SEMUA');
  const [filterJenis, setFilterJenis] = useState<FilterJenis>('SEMUA');

  // RC-S74 §3 — judul header (label UI saja; route tetap `DaftarUtang`).
  useLayoutEffect(() => {
    navigation.setOptions?.({ title: 'Daftar Utang Koperasi' });
  }, [navigation]);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setData(await listUtang());
      // Tunggu rantai tugas latar (termasuk mesin akrual) agar status yang
      // tampil adalah status SETELAH mesin berjalan, bukan sebelum.
      await tungguTugasStartupSelesai();
      try {
        setStatusBunga(await getStatusBungaSemuaUtang());
      } catch {
        setStatusBunga(new Map());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar utang.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => load(false));
    return unsub;
  }, [navigation, load]);

  const simpanBasis = async (utangId: string, basisBunga: BasisBunga) => {
    if (!currentUser || menyimpanBasis) return;
    setMenyimpanBasis(utangId);
    try {
      await lengkapiBasisBungaUtang({ utangId, basisBunga, createdBy: currentUser.id });
      await jalankanTugasStartup(currentUser.id).catch(() => undefined);
      notify('Basis bunga tersimpan', 'Akrual bunga utang ini sekarang dihitung dan dibukukan otomatis oleh sistem.');
      await load(true);
    } catch (e) {
      notify('Basis bunga gagal disimpan', e instanceof Error ? e.message : 'Basis bunga tidak dapat disimpan.');
    } finally {
      setMenyimpanBasis(null);
    }
  };

  const dataTampil = data.filter((d) => {
    if (filterStatus !== 'SEMUA' && d.status !== filterStatus) return false;
    if (filterJenis !== 'SEMUA' && d.jenisPemberi !== filterJenis) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return d.namaPemberi.toLowerCase().includes(q) || d.nomorUtang.toLowerCase().includes(q);
  });

  const totalSisa = data.filter((d) => d.status === 'AKTIF').reduce((acc, d) => acc + d.sisaPokok, 0);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={dataTampil}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      ListHeaderComponent={
        <>
          {data.length > 0 && (
            <View style={styles.totalCard}>
              {/* RC-S74 §15 — hanya record `utang`, BUKAN seluruh liabilitas koperasi. */}
              <Text style={styles.totalLabel}>Total Sisa Utang Koperasi</Text>
              <Text style={styles.totalValue}>{formatRupiah(totalSisa)}</Text>
              <Text style={styles.totalSub}>Utang bank, pihak lain, dan utang usaha yang masih tercatat</Text>
              <Text style={styles.totalSub}>{data.length} utang tercatat</Text>
            </View>
          )}
          {data.length > 0 && (
            <SearchField
              wrapStyle={styles.searchBox}
              value={search}
              onChangeText={setSearch}
              placeholder="Cari nama pemberi/nomor utang..."
              placeholderTextColor={colors.placeholder}
            />
          )}
          {data.length > 0 && (
            <>
              <View style={styles.chipWrap}>
                {FILTER_STATUS.map((f) => (
                  <TouchableOpacity
                    key={f.v}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filterStatus === f.v }}
                    style={[styles.chip, filterStatus === f.v && styles.chipActive]}
                    onPress={() => setFilterStatus(f.v)}
                  >
                    <Text style={[styles.chipText, filterStatus === f.v && styles.chipTextActive]}>{f.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.chipWrap}>
                {FILTER_JENIS.map((f) => (
                  <TouchableOpacity
                    key={f.v}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filterJenis === f.v }}
                    style={[styles.chip, filterJenis === f.v && styles.chipActive]}
                    onPress={() => setFilterJenis(f.v)}
                  >
                    <Text style={[styles.chipText, filterJenis === f.v && styles.chipTextActive]}>{f.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
          {canExport && (
            <ExportButton
              data={
                koperasi && dataTampil.length > 0
                  ? buildUtangExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, dataTampil)
                  : null
              }
            />
          )}
        </>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <Text style={styles.emptyText}>{data.length > 0 ? 'Tidak ada utang yang cocok dengan filter.' : 'Belum ada utang yang dicatat.'}</Text>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <View style={[styles.card, item.status === 'LUNAS' && styles.cardLunas]}>
          <View style={styles.cardHeader}>
            <Text style={styles.nomor}>{item.nomorUtang}</Text>
            <Text style={[styles.statusBadge, item.status === 'AKTIF' ? styles.badgeAktif : styles.badgeLunas]}>
              {item.status === 'AKTIF' ? 'Aktif' : 'Lunas'}
            </Text>
          </View>
          <Text style={styles.namaPemberi}>{item.namaPemberi}</Text>
          <Text style={styles.jenisPemberi}>{JENIS_PEMBERI_LABEL[item.jenisPemberi] ?? item.jenisPemberi}</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Tanggal</Text>
            <Text style={styles.rowValue}>{item.tanggal}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Pokok Pinjaman</Text>
            <Text style={styles.rowValue}>{formatRupiah(item.pokokPinjaman)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Bunga</Text>
            <Text style={styles.rowValue}>
              {item.persenBunga}%
              {item.basisBunga === 'TAHUNAN' ? ' per tahun' : item.basisBunga === 'BULANAN' ? ' per bulan' : ''}
              {' '}({item.jenisBunga})
            </Text>
          </View>
          {/*
            RC-S71 — Status Bunga. Informatif, bukan form transaksi: akrual
            dihitung & dibukukan sistem. Istilah teknis tidak ditampilkan.
          */}
          {statusBunga.has(item.id) ? (
            <StatusBungaSection
              detail={statusBunga.get(item.id)!}
              bolehLengkapi={canEdit && !!currentUser}
              sedangMenyimpan={menyimpanBasis === item.id}
              onPilihBasis={(basis) => simpanBasis(item.id, basis)}
            />
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Sisa Kewajiban</Text>
            <Text style={styles.rowValueBold}>{formatRupiah(item.sisaPokok)}</Text>
          </View>
          {item.keterangan ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Keterangan</Text>
              <Text style={styles.rowValue}>{item.keterangan}</Text>
            </View>
          ) : null}
        </View>
      )}
    />
  );
}

function StatusBungaSection({
  detail,
  bolehLengkapi,
  sedangMenyimpan,
  onPilihBasis,
}: {
  detail: StatusBungaUtangDetail;
  bolehLengkapi: boolean;
  sedangMenyimpan: boolean;
  onPilihBasis: (basis: BasisBunga) => void;
}) {
  const baik = detail.status === 'TERKENDALI' || detail.status === 'MENUNGGU_PERIODE';
  return (
    <View style={styles.statusBunga}>
      <Text style={styles.statusBungaJudul}>Status Bunga</Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Akrual</Text>
        <Text style={styles.rowValue}>{detail.status === 'KONTRAK_BELUM_LENGKAP' ? 'Belum berjalan' : 'Otomatis'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Akrual terakhir</Text>
        <Text style={styles.rowValue}>{detail.akrualTerakhirTanggal ?? '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Utang bunga</Text>
        <Text style={styles.rowValue}>{formatRupiah(detail.outstandingBunga)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Status</Text>
        <Text style={[styles.rowValueBold, { color: baik ? colors.primary : colors.danger }]}>
          {/* RC-S71.1 §26: ✓ Terkendali · Menunggu Periode · ⚠ Kontrak Belum Lengkap · ⚠ Perlu Perhatian */}
          {detail.status === 'TERKENDALI' ? '✓ ' : detail.status === 'MENUNGGU_PERIODE' ? '' : '⚠ '}
          {LABEL_STATUS_BUNGA_UTANG[detail.status]}
        </Text>
      </View>
      {detail.pesan ? (
        <View style={baik ? styles.catatanInfo : styles.basisBelumDitentukan}>
          <Text style={baik ? styles.catatanInfoTeks : styles.basisBelumDitentukanTeks}>{detail.pesan}</Text>
        </View>
      ) : null}
      {detail.bisaLengkapiBasis && bolehLengkapi ? (
        <View style={styles.basisAksi}>
          <Text style={styles.rowLabel}>Persentase bunga pada kontrak berlaku:</Text>
          <View style={styles.basisTombolBaris}>
            {(['TAHUNAN', 'BULANAN'] as BasisBunga[]).map((b) => (
              <TouchableOpacity
                key={b}
                accessibilityRole="button"
                accessibilityLabel={b === 'TAHUNAN' ? 'Basis bunga per tahun' : 'Basis bunga per bulan'}
                disabled={sedangMenyimpan}
                style={[styles.basisTombol, sedangMenyimpan && { opacity: 0.5 }]}
                onPress={() => onPilihBasis(b)}
              >
                <Text style={styles.basisTombolTeks}>{b === 'TAHUNAN' ? 'Per tahun' : 'Per bulan'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  statusBunga: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  statusBungaJudul: { fontSize: 12, fontWeight: '700', color: colors.text, marginBottom: 2 },
  catatanInfo: { marginTop: 4 },
  catatanInfoTeks: { fontSize: 11, color: colors.textMuted },
  basisAksi: { marginTop: spacing.sm },
  basisTombolBaris: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  basisTombol: { flex: 1, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.md, paddingVertical: 8, alignItems: 'center' },
  basisTombolTeks: { fontSize: 12, fontWeight: '700', color: colors.primary },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  totalCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.md, alignItems: 'center' },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 4 },
  totalSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  searchBox: { marginBottom: spacing.md },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  cardLunas: { opacity: 0.6 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nomor: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  statusBadge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  badgeAktif: { backgroundColor: colors.primaryLight, color: colors.primary },
  badgeLunas: { backgroundColor: '#EEE', color: colors.textMuted },
  namaPemberi: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 4 },
  jenisPemberi: { fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  rowLabel: { fontSize: 12, color: colors.textMuted },
  rowValue: { fontSize: 12, color: colors.text },
  basisBelumDitentukan: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: 8,
    marginTop: 6,
  },
  basisBelumDitentukanTeks: { fontSize: 11, color: colors.text, lineHeight: 15 },
  rowValueBold: { fontSize: 13, color: colors.text, fontWeight: '700' },
});
