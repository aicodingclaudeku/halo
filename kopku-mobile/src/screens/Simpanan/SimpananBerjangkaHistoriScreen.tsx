import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatRupiah } from '@/utils/money';
import { listSimpananBerjangkaDaftar, SimpananBerjangkaDaftarRow } from '@/services/SimpananBerjangkaService';
import {
  listPencairanDini,
  SettlementDiniRow,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { colors, elevation, radius, spacing } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import SearchField from '@/components/SearchField';
import CaraKerjaBerjangka from '@/components/simpanan/CaraKerjaBerjangka';
import {
  adaFilterAktif,
  FilterStatusBerjangka,
  hitungPerStatus,
  inisialNama,
  jatuhTempoPadaBulan,
  KRITERIA_AWAL,
  LABEL_URUTAN,
  perluDitinjauPengurus,
  saringDaftarBerjangka,
  UrutanBerjangka,
} from '@/utils/daftarSimpananBerjangka';
import { GAYA_STATUS_BERJANGKA, tanggalPendek, teksSukuBunga, teksSukuBungaPendek, WARNA_BERJANGKA } from './tampilanBerjangka';

/**
 * ============================================================
 * DAFTAR SIMPANAN BERJANGKA (§23, §36 · RC-S129)
 * ============================================================
 *
 * Sumber data adalah SUBLEDGER `simpanan_berjangka`, BUKAN rekonstruksi
 * dari jurnal. Jurnal hanya menyimpan "Kas naik, liabilitas naik" — ia
 * tidak tahu tenor, suku bunga, tanggal jatuh tempo, maupun status
 * kontrak. Subledger-lah yang otoritatif untuk syarat kontrak; jurnal
 * otoritatif untuk angka di buku besar. Keduanya direkonsiliasi di
 * `FullReconciliation`.
 *
 * RC-S129 — daftar dirapikan agar mudah dipindai:
 *  - kartu menampilkan NAMA anggota (dulu hanya nomor kontrak), pokok,
 *    tenor, suku bunga, dan jatuh tempo dalam satu blok;
 *  - pencarian (nama, nomor anggota, nomor kontrak, keterangan, nominal),
 *    filter status lewat kotak ringkasan, filter cepat "jatuh tempo bulan
 *    ini" & "kontrak lama perlu ditinjau", serta pilihan urutan.
 * Penyaringan murni di `utils/daftarSimpananBerjangka.ts`; layar tidak
 * menghitung angka keuangan apa pun.
 */

const FILTER_RINGKASAN: readonly { v: FilterStatusBerjangka; label: string }[] = [
  { v: 'SEMUA', label: 'Semua kontrak' },
  { v: 'AKTIF', label: 'Belum jatuh tempo' },
  { v: 'JATUH_TEMPO', label: 'Siap dicairkan' },
  { v: 'DICAIRKAN', label: 'Sudah dicairkan' },
];

const URUTAN: readonly UrutanBerjangka[] = ['TERBARU', 'JATUH_TEMPO_TERDEKAT', 'NOMINAL_TERBESAR'];

export default function SimpananBerjangkaHistoriScreen({ route }: { route?: any }) {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const anggotaId: string | undefined = route?.params?.anggotaId;

  const [data, setData] = useState<SimpananBerjangkaDaftarRow[]>([]);
  // §AG — rincian pencairan dini per kontrak. Riwayat WAJIB menampilkan
  // komponennya (pokok, bunga, bunga hangus, penalti, biaya admin,
  // penyesuaian rate, net), bukan hanya satu total.
  const [settlementDini, setSettlementDini] = useState<Record<string, SettlementDiniRow>>({});
  const [diniTerbuka, setDiniTerbuka] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- pencarian & filter (RC-S129)
  const [cari, setCari] = useState(KRITERIA_AWAL.cari);
  const [status, setStatus] = useState<FilterStatusBerjangka>(KRITERIA_AWAL.status);
  const [urutan, setUrutan] = useState<UrutanBerjangka>(KRITERIA_AWAL.urutan);
  const [jtBulanIni, setJtBulanIni] = useState(KRITERIA_AWAL.jatuhTempoBulanIni);
  const [perluTinjau, setPerluTinjau] = useState(KRITERIA_AWAL.perluDitinjau);
  const hariIni = getTanggalLokalHariIni();

  const muat = useCallback(async () => {
    setError(null);
    try {
      const [kontrak, dini] = await Promise.all([
        listSimpananBerjangkaDaftar(anggotaId),
        listPencairanDini(anggotaId),
      ]);
      setData(kontrak);
      setSettlementDini(Object.fromEntries(dini.map((d) => [d.kontrakId, d])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar simpanan berjangka.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [anggotaId]);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Refresh berbasis
  // FOKUS supaya layar selalu membaca state SQLite terkini.
  useFocusRefresh(() => {
    muat();
  }, [muat]);

  const kriteria = { cari, status, urutan, jatuhTempoBulanIni: jtBulanIni, perluDitinjau: perluTinjau, hariIni };
  const dataTampil = useMemo(
    () => saringDaftarBerjangka(data, kriteria),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, cari, status, urutan, jtBulanIni, perluTinjau, hariIni]
  );
  const jumlah = hitungPerStatus(data);
  const jumlahJtBulanIni = data.filter((d) => jatuhTempoPadaBulan(d, hariIni)).length;
  const jumlahPerluTinjau = data.filter(perluDitinjauPengurus).length;
  const filterAktif = adaFilterAktif(kriteria);

  const resetFilter = () => {
    setCari(KRITERIA_AWAL.cari);
    setStatus(KRITERIA_AWAL.status);
    setUrutan(KRITERIA_AWAL.urutan);
    setJtBulanIni(KRITERIA_AWAL.jatuhTempoBulanIni);
    setPerluTinjau(KRITERIA_AWAL.perluDitinjau);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textFaint} />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <FlatList
        style={styles.container}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 96 + insets.bottom }}
        data={dataTampil}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              muat();
            }}
          />
        }
        ListHeaderComponent={
          <>
            <CaraKerjaBerjangka awalTerbuka={data.length === 0} />
            {data.length > 0 ? (
              <>
                <View style={styles.ringkasanBox}>
                  <Text style={styles.ringkasanJudul}>Ringkasan Kontrak</Text>
                  {/*
                    HANYA JUMLAH KONTRAK, BUKAN NILAI UANG — disengaja (§E
                    "jangan menghitung angka ulang secara UI"). Kotak ini
                    sekaligus FILTER status: ketuk untuk menyaring daftar.
                  */}
                  <View style={styles.ringkasanBaris}>
                    {FILTER_RINGKASAN.map((f) => {
                      const terpilih = status === f.v;
                      return (
                        <TouchableOpacity
                          key={f.v}
                          style={[styles.ringkasanItem, terpilih && styles.ringkasanItemAktif]}
                          onPress={() => setStatus(terpilih && f.v !== 'SEMUA' ? 'SEMUA' : f.v)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: terpilih }}
                          accessibilityLabel={`Saring: ${f.label}, ${jumlah[f.v]} kontrak`}
                        >
                          <Text style={[styles.ringkasanAngka, terpilih && styles.ringkasanAngkaAktif]}>{jumlah[f.v]}</Text>
                          <Text style={[styles.ringkasanLabel, terpilih && styles.ringkasanLabelAktif]}>{f.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  {jumlah.DIBATALKAN > 0 ? (
                    <TouchableOpacity onPress={() => setStatus(status === 'DIBATALKAN' ? 'SEMUA' : 'DIBATALKAN')} accessibilityRole="button">
                      <Text style={styles.tautanKecil}>
                        {status === 'DIBATALKAN' ? 'Tampilkan semua kontrak' : `Lihat ${jumlah.DIBATALKAN} kontrak dibatalkan`}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                <SearchField
                  wrapStyle={styles.searchBox}
                  value={cari}
                  onChangeText={setCari}
                  placeholder="Cari nama, no. anggota/kontrak, nominal"
                  returnKeyType="search"
                  autoCorrect={false}
                  accessibilityLabel="Cari simpanan berjangka"
                />

                <Text style={styles.labelBaris}>Saring cepat</Text>
                <View style={styles.chipWrap}>
                  <Chip
                    label={`Jatuh tempo bulan ini (${jumlahJtBulanIni})`}
                    ikon="alarm-outline"
                    aktif={jtBulanIni}
                    onPress={() => setJtBulanIni((b) => !b)}
                  />
                  <Chip
                    label={`Kontrak lama perlu ditinjau (${jumlahPerluTinjau})`}
                    ikon="alert-circle-outline"
                    aktif={perluTinjau}
                    onPress={() => setPerluTinjau((b) => !b)}
                  />
                </View>

                <Text style={styles.labelBaris}>Urutkan</Text>
                <View style={styles.chipWrap}>
                  {URUTAN.map((u) => (
                    <Chip key={u} label={LABEL_URUTAN[u]} aktif={urutan === u} onPress={() => setUrutan(u)} />
                  ))}
                </View>

                <View style={styles.hasilBaris}>
                  <Text style={styles.hasilTeks}>
                    {filterAktif ? `Menampilkan ${dataTampil.length} dari ${data.length} kontrak` : `${data.length} kontrak`}
                  </Text>
                  {filterAktif ? (
                    <TouchableOpacity onPress={resetFilter} accessibilityRole="button" style={styles.resetTombol}>
                      <Ionicons name="refresh-outline" size={14} color={colors.primary} />
                      <Text style={styles.tautanKecil}>Reset filter</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </>
            ) : null}
          </>
        }
        ListEmptyComponent={
          data.length === 0 ? (
            <View style={styles.kosong}>
              <View style={styles.kosongIkon}>
                <Ionicons name="time-outline" size={28} color={colors.primary} />
              </View>
              <Text style={styles.kosongJudul}>Belum ada simpanan berjangka</Text>
              <Text style={styles.kosongTeks}>
                Tekan tombol + di kanan bawah untuk menempatkan simpanan berjangka pertama. Pastikan kebijakan produk sudah ditetapkan
                pengurus.
              </Text>
            </View>
          ) : (
            <View style={styles.kosong}>
              <Ionicons name="search-outline" size={28} color={colors.textFaint} />
              <Text style={styles.kosongJudul}>Tidak ada kontrak yang cocok</Text>
              <Text style={styles.kosongTeks}>Ubah kata kunci atau filter, atau reset untuk melihat semua kontrak.</Text>
              <TouchableOpacity onPress={resetFilter} accessibilityRole="button">
                <Text style={styles.tautan}>Reset filter</Text>
              </TouchableOpacity>
            </View>
          )
        }
        renderItem={({ item }) => (
          /*
            §E — KARTU MEMBUKA DETAIL dengan membawa `kontrakId` saja —
            detail memuat sendiri dari service, sehingga tidak ada data
            yang "dititipkan" lewat parameter navigasi dan bisa basi.
          */
          <TouchableOpacity
            style={[styles.card, { borderLeftColor: GAYA_STATUS_BERJANGKA[item.status].warna }]}
            onPress={() =>
              navigation.navigate('SimpananBerjangkaDetail', { kontrakId: item.id })
            }
            accessibilityRole="button"
            accessibilityLabel={`Buka detail kontrak ${item.nomorTransaksi} milik ${item.namaAnggota ?? 'anggota'}`}
          >
            <View style={styles.headerRow}>
              <View style={styles.avatar}>
                <Text style={styles.avatarTeks}>{inisialNama(item.namaAnggota)}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.nama} numberOfLines={1}>
                  {item.namaAnggota ?? 'Anggota tidak ditemukan'}
                </Text>
                <Text style={styles.nomor} numberOfLines={1}>
                  {item.nomorAnggota ? `${item.nomorAnggota} · ` : ''}
                  {item.nomorTransaksi}
                </Text>
              </View>
              <View style={[styles.lencana, { backgroundColor: GAYA_STATUS_BERJANGKA[item.status].latar }]}>
                <Ionicons name={GAYA_STATUS_BERJANGKA[item.status].ikon} size={12} color={GAYA_STATUS_BERJANGKA[item.status].warna} />
                <Text style={[styles.lencanaTeks, { color: GAYA_STATUS_BERJANGKA[item.status].warna }]}>
                  {GAYA_STATUS_BERJANGKA[item.status].label}
                </Text>
              </View>
            </View>

            <Text style={styles.nominalLabel}>Pokok simpanan</Text>
            <Text style={styles.nominal}>{formatRupiah(item.nominal)}</Text>

            <View style={styles.grid}>
              <Sel label="Tenor" nilai={`${item.tenorBulan} bulan`} />
              <Sel label="Suku bunga" nilai={teksSukuBungaPendek(item.sukuBungaPerTahun)} />
              <Sel label={item.status === 'DICAIRKAN' ? 'Dicairkan' : 'Jatuh tempo'} nilai={tanggalPendek(item.status === 'DICAIRKAN' ? item.tanggalPencairan : item.tanggalJatuhTempo)} />
            </View>

            {item.status === 'JATUH_TEMPO' ? (
              <View style={styles.sorotan}>
                <Ionicons name="alarm-outline" size={14} color={WARNA_BERJANGKA.jatuhTempo} />
                <Text style={styles.sorotanTeks}>
                  Siap dicairkan — pokok menunggu diambil anggota
                  {item.bungaPascaAktif && item.ratePascaJatuhTempo ? `, tetap berbunga ${teksSukuBunga(item.ratePascaJatuhTempo)}` : ''}.
                </Text>
              </View>
            ) : null}
            {perluDitinjauPengurus(item) ? (
              <View style={[styles.sorotan, styles.sorotanTinjau]}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
                <Text style={styles.sorotanTeks}>Kontrak lama — kebijakan pasca jatuh tempo perlu ditinjau pengurus.</Text>
              </View>
            ) : null}

            {/* §33 — bunga hanya ditampilkan bila kontrak memang berbunga. */}
            {item.sukuBungaPerTahun > 0 && item.status !== 'DIBATALKAN' ? (
              <Baris label="Bunga sudah diakui" nilai={formatRupiah(item.bungaTerakru)} />
            ) : null}
            {item.keterangan ? <Baris label="Keterangan" nilai={item.keterangan} /> : null}

            {item.status === 'DICAIRKAN' && settlementDini[item.id] ? (
              <>
                <TouchableOpacity
                  style={styles.diniToggle}
                  onPress={() => setDiniTerbuka((s) => ({ ...s, [item.id]: !s[item.id] }))}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !!diniTerbuka[item.id] }}
                >
                  <Ionicons name={diniTerbuka[item.id] ? 'chevron-up' : 'chevron-down'} size={14} color={WARNA_BERJANGKA.jatuhTempo} />
                  <Text style={styles.diniToggleTeks}>
                    {diniTerbuka[item.id] ? 'Tutup rincian pencairan dini' : 'Dicairkan sebelum jatuh tempo — lihat rincian'}
                  </Text>
                </TouchableOpacity>
                {diniTerbuka[item.id] ? <RincianPencairanDini d={settlementDini[item.id]} /> : null}
              </>
            ) : null}

            {/* Petunjuk bahwa kartu ini dapat dibuka. */}
            <View style={styles.bukaDetailRow}>
              <Text style={styles.mulaiTeks}>Mulai {tanggalPendek(item.tanggalMulai)} · {item.sumberDana === 'BANK' ? 'Bank' : 'Kas'}</Text>
              <Text style={styles.bukaDetailText}>Detail</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </View>
          </TouchableOpacity>
        )}
      />

      {/*
        FAB PENEMPATAN SIMPANAN BERJANGKA (RC-S46). `mode: 'BERJANGKA'`
        HANYA menentukan jalur form; form, validasi, dan service yang
        dipanggil TIDAK berubah — tidak ada jalur penyimpanan kedua.
      */}
      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('SimpananForm', { mode: 'BERJANGKA' })}
        accessibilityRole="button"
        // RC-S47 §D menetapkan wording ini secara eksplisit: yang dibuat
        // di sini adalah KONTRAK, bukan penambahan baris ke daftar.
        accessibilityLabel="Buat Simpanan Berjangka"
      >
        <Ionicons name="add" size={28} color={colors.white} />
      </TouchableOpacity>
    </View>
  );
}

/**
 * Rincian pencairan dini — dibaca APA ADANYA dari baris settlement yang
 * tersimpan saat transaksi terjadi. TIDAK dihitung ulang di layar:
 * kebijakan bisa saja sudah berganti versi sejak saat itu, dan riwayat
 * harus menampilkan angka yang benar-benar dibukukan.
 */
function RincianPencairanDini({ d }: { d: SettlementDiniRow }) {
  return (
    <View style={styles.diniBox}>
      <Text style={styles.diniJudul}>Pencairan Sebelum Jatuh Tempo</Text>
      <Baris label="Tanggal Pencairan" nilai={d.tanggalPencairan} />
      <Baris label="Versi Kebijakan" nilai={d.policyVersi} />
      <Baris label="Pokok Bruto" nilai={formatRupiah(d.pokokBruto)} />
      <Baris label="Bunga Terakru (Rate Kontrak)" nilai={formatRupiah(d.bungaAkrualKontrak)} />
      <Baris label="Penyesuaian Rate" nilai={formatRupiah(d.penyesuaianRate)} />
      <Baris label="Bunga Bruto" nilai={formatRupiah(d.bungaBruto)} />
      <Baris label="Bunga Hangus" nilai={formatRupiah(d.bungaHangus)} />
      <Baris label="Penalti" nilai={formatRupiah(d.penalti)} />
      <Baris label="Biaya Administrasi" nilai={formatRupiah(d.biayaAdmin)} />
      <Baris label="Potongan atas Pokok" nilai={formatRupiah(d.penyesuaianPokok)} />
      <Baris label="Potongan atas Bunga" nilai={formatRupiah(d.penyesuaianBunga)} />
      <Baris label="Pokok Dibayar" nilai={formatRupiah(d.pokokDibayar)} />
      <Baris label="Bunga Dibayar" nilai={formatRupiah(d.bungaDibayar)} />
      <Baris label="Total Diterima" nilai={formatRupiah(d.totalPayout)} />
      <Baris label="Rate Efektif" nilai={`${d.rateEfektif}% per tahun`} />
      {d.alasan ? <Baris label="Alasan" nilai={d.alasan} /> : null}
    </View>
  );
}

function Chip({ label, aktif, onPress, ikon }: { label: string; aktif: boolean; onPress: () => void; ikon?: 'alarm-outline' | 'alert-circle-outline' }) {
  return (
    <TouchableOpacity
      style={[styles.chip, aktif && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: aktif }}
    >
      {ikon ? <Ionicons name={ikon} size={13} color={aktif ? colors.white : colors.textMuted} /> : null}
      <Text style={[styles.chipText, aktif && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Sel({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.sel}>
      <Text style={styles.selLabel}>{label}</Text>
      <Text style={styles.selNilai} numberOfLines={1}>
        {nilai}
      </Text>
    </View>
  );
}

function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.baris}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={styles.barisNilai}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.background },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm, backgroundColor: colors.background },
  errorText: { color: colors.danger, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTeks: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  nama: { fontSize: 14, fontWeight: '700', color: colors.text },
  nomor: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  lencana: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  lencanaTeks: { fontSize: 11, fontWeight: '700' },
  nominalLabel: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md },
  nominal: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 1 },
  grid: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  sel: { flex: 1, paddingHorizontal: spacing.sm },
  selLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  selNilai: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: 2 },
  sorotan: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: WARNA_BERJANGKA.jatuhTempoLatar,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  sorotanTinjau: { backgroundColor: colors.warningBg },
  sorotanTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 16 },
  baris: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, gap: spacing.md },
  barisLabel: { fontSize: 12, color: colors.textMuted },
  barisNilai: { fontSize: 12, fontWeight: '600', color: colors.text, flexShrink: 1, textAlign: 'right' },
  diniToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, marginTop: spacing.xs },
  diniToggleTeks: { fontSize: 12, fontWeight: '700', color: WARNA_BERJANGKA.jatuhTempo },
  diniBox: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, marginTop: spacing.xs },
  diniJudul: { fontSize: 12, fontWeight: '700', color: WARNA_BERJANGKA.jatuhTempo, marginBottom: 4 },
  ringkasanBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  ringkasanJudul: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  ringkasanBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  ringkasanItem: {
    flexGrow: 1,
    flexBasis: '45%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  ringkasanItemAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  ringkasanAngka: { fontSize: 18, fontWeight: '800', color: colors.text },
  ringkasanAngkaAktif: { color: colors.white },
  ringkasanLabel: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  ringkasanLabelAktif: { color: colors.white },
  searchBox: { marginBottom: spacing.sm },
  labelBaris: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.xs, marginBottom: 6 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white, fontWeight: '600' },
  hasilBaris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xs, marginBottom: spacing.sm },
  hasilTeks: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  resetTombol: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  tautanKecil: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 2 },
  tautan: { fontSize: 13, fontWeight: '700', color: colors.primary, paddingVertical: spacing.sm },
  kosong: { alignItems: 'center', paddingVertical: spacing.xl, paddingHorizontal: spacing.lg, gap: spacing.sm },
  kosongIkon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kosongJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  kosongTeks: { fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 17 },
  mulaiTeks: { flex: 1, fontSize: 11, color: colors.textMuted },
  bukaDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  bukaDetailText: { fontSize: 12, fontWeight: '700', color: colors.primary },
});
