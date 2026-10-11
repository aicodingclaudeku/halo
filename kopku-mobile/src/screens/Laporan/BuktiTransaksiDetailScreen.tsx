import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getBuktiBayarPiutangById,
  getBuktiBayarUtangById,
  getBuktiBayarSimpananById,
  getBuktiTarikSimpananById,
  getBuktiKeluarAnggotaById,
  BuktiBayarPiutangRow,
  BuktiBayarUtangRow,
  BuktiBayarSimpananRow,
  BuktiTarikSimpananRow,
  BuktiKeluarAnggotaRow,
  RincianTarikBerjangka,
} from '@/services/BuktiTransaksiService';
import { buildBuktiBayarPiutangExport, buildBuktiBayarUtangExport, buildBuktiBayarSimpananExport, buildBuktiTarikSimpananExport, buildBuktiKeluarAnggotaExport, labelJenisSimpananBukti } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing } from '@/theme/colors';
import { JenisBukti, LABEL_JENIS_BUKTI } from './BuktiTransaksiListScreen';

/**
 * Detail satu "Bukti Transaksi" (§W/§X/§Y) + tombol Export (§Z: bukti
 * mengambil data transaksi ASLI lewat get...ById, TIDAK membuat
 * transaksi/data baru saat dibuka atau di-export — layar ini murni
 * read-only).
 */
export default function BuktiTransaksiDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const jenis: JenisBukti = route.params?.jenis;
  const id: string = route.params?.id;
  const koperasi = useAppStore((s) => s.koperasi);

  const [item, setItem] = useState<BuktiBayarPiutangRow | BuktiBayarUtangRow | BuktiBayarSimpananRow | BuktiTarikSimpananRow | BuktiKeluarAnggotaRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        if (jenis === 'BAYAR_UTANG') setItem(await getBuktiBayarUtangById(id));
        else if (jenis === 'BAYAR_PIUTANG') setItem(await getBuktiBayarPiutangById(id));
        else if (jenis === 'BAYAR_SIMPANAN') setItem(await getBuktiBayarSimpananById(id));
        else if (jenis === 'TARIK_SIMPANAN') setItem(await getBuktiTarikSimpananById(id));
        else setItem(await getBuktiKeluarAnggotaById(id));
      } finally {
        setLoading(false);
      }
    })();
  }, [jenis, id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!item) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Data bukti tidak ditemukan.</Text>
      </View>
    );
  }

  const info = koperasi ? { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi } : null;

  let rows: { label: string; value: string }[] = [];
  let nominal = 0;
  let exportData = null;
  // RC-S76 — hanya terisi untuk jenis KELUAR_ANGGOTA yang jurnalnya
  // memang menyimpan sumber_id.
  let sumberKeluarAnggotaId: string | null = null;
  // Rincian pencairan simpanan berjangka (hanya Bukti Tarik Simpanan).
  let rincianBerjangka: RincianTarikBerjangka | null = null;

  if (jenis === 'BAYAR_UTANG') {
    const JENIS_PEMBERI_LABEL: Record<string, string> = { BANK: 'Bank', PIHAK_LAIN: 'Pihak Lain', UTANG_USAHA: 'Utang Usaha (Pembelian Aset)' };
    const it = item as BuktiBayarUtangRow;
    nominal = it.jumlahPembayaran;
    rows = [
      { label: 'Nomor Bukti', value: it.nomorBukti },
      { label: 'Tanggal', value: it.tanggal },
      { label: 'Nomor Utang', value: it.nomorUtang },
      { label: 'Pihak Pemberi', value: it.namaPemberi },
      { label: 'Jenis Pemberi', value: JENIS_PEMBERI_LABEL[it.jenisPemberi] ?? it.jenisPemberi },
      { label: 'Porsi Pokok', value: formatRupiah(it.porsiPokok) },
      { label: 'Porsi Bunga/Jasa', value: formatRupiah(it.porsiBunga) },
      { label: 'Sumber Dana', value: it.sumberDana },
      { label: 'Keterangan', value: it.keterangan ?? '-' },
      { label: 'Dibuat Oleh', value: it.dibuatOleh ?? '-' },
    ];
    exportData = info ? buildBuktiBayarUtangExport(info, it) : null;
  } else if (jenis === 'BAYAR_PIUTANG') {
    const it = item as BuktiBayarPiutangRow;
    nominal = it.jumlahPembayaran;
    rows = [
      { label: 'Nomor Bukti', value: it.nomorBukti },
      { label: 'Tanggal', value: it.tanggal },
      { label: 'Nomor Anggota', value: it.nomorAnggota },
      { label: 'Nama Anggota', value: it.namaAnggota },
      { label: 'Nomor Pinjaman', value: it.nomorPinjaman },
      { label: 'Porsi Pokok', value: formatRupiah(it.porsiPokok) },
      { label: 'Porsi Jasa', value: formatRupiah(it.porsiJasa) },
      { label: 'Porsi Denda', value: formatRupiah(it.porsiDenda) },
      { label: 'Sumber Dana', value: it.sumberDana },
      { label: 'Keterangan', value: it.keterangan ?? '-' },
    ];
    exportData = info ? buildBuktiBayarPiutangExport(info, it) : null;
  } else if (jenis === 'BAYAR_SIMPANAN') {
    const it = item as BuktiBayarSimpananRow;
    nominal = it.jumlah;
    rows = [
      { label: 'Nomor Bukti', value: it.nomorBukti },
      { label: 'Tanggal', value: it.tanggal },
      { label: 'Nomor Anggota', value: it.nomorAnggota },
      { label: 'Nama Anggota', value: it.namaAnggota },
      { label: 'Jenis Simpanan', value: it.jenisSimpanan },
      { label: 'Sumber Dana', value: it.sumberDana },
      { label: 'Keterangan', value: it.keterangan ?? '-' },
    ];
    exportData = info ? buildBuktiBayarSimpananExport(info, it) : null;
  } else if (jenis === 'TARIK_SIMPANAN') {
    const it = item as BuktiTarikSimpananRow;
    nominal = it.jumlah;
    rows = [
      { label: 'Nomor Bukti', value: it.nomorBukti },
      { label: 'Tanggal', value: it.tanggal },
      { label: 'Nomor Anggota', value: it.nomorAnggota },
      { label: 'Nama Anggota', value: it.namaAnggota },
      { label: 'Jenis Simpanan', value: labelJenisSimpananBukti(it.jenisSimpanan) },
      { label: 'Sumber Dana', value: it.sumberDana },
      { label: 'Keterangan', value: it.keterangan ?? '-' },
    ];
    rincianBerjangka = it.rincianBerjangka ?? null;
    exportData = info ? buildBuktiTarikSimpananExport(info, it) : null;
  } else {
    const it = item as BuktiKeluarAnggotaRow;
    nominal = it.totalDikembalikan;
    rows = [
      { label: 'Nomor Bukti', value: it.nomorBukti },
      { label: 'Tanggal', value: it.tanggal },
      { label: 'Nomor Anggota', value: it.nomorAnggota },
      { label: 'Nama Anggota', value: it.namaAnggota },
      { label: 'Sumber Dana Pengembalian', value: it.sumberDana },
      { label: 'Keterangan', value: it.keterangan ?? '-' },
    ];
    exportData = info ? buildBuktiKeluarAnggotaExport(info, it) : null;
    // RC-S76 — tautan balik ke pengajuan asalnya, lewat
    // `journal.sumber_id` yang dibawa read-model. Sengaja BUKAN
    // pencocokan nama/tanggal/nominal: dua anggota bisa bernama sama,
    // dan dua pengajuan bisa jatuh di tanggal yang sama.
    sumberKeluarAnggotaId = it.sumberId;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={styles.title}>{LABEL_JENIS_BUKTI[jenis]}</Text>
      <Text style={styles.sub}>{koperasi?.nama}</Text>

      <View style={styles.nominalBox}>
        <Text style={styles.nominalLabel}>{rincianBerjangka ? 'Total Diterima Anggota' : 'Total'}</Text>
        <Text style={styles.nominalValue}>{formatRupiah(nominal)}</Text>
      </View>

      <ExportButton data={exportData} />

      <View style={styles.card}>
        {rows.map((r) => (
          <View key={r.label} style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <Text style={styles.rowValue}>{r.value}</Text>
          </View>
        ))}
      </View>

      {rincianBerjangka && <RincianBerjangkaCard r={rincianBerjangka} total={nominal} />}

      {/* RC-S76 — SUMBER TRANSAKSI (khusus Keluar Anggota). Tanpa
          `sumber_id` yang sah, CTA TIDAK ditampilkan: menebak pengajuan
          mana yang dimaksud jauh lebih buruk daripada mengakui bahwa
          tautannya tidak tersedia. */}
      {jenis === 'KELUAR_ANGGOTA' && (
        <>
          <Text style={styles.sectionTitle}>Sumber Transaksi</Text>
          {sumberKeluarAnggotaId ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Lihat detail pengajuan keluar anggota"
              style={styles.ctaSumber}
              onPress={() =>
                // Lintas tab: KeluarAnggotaDetail milik TransaksiStack.
                navigation.navigate('Transaksi', {
                  screen: 'KeluarAnggotaDetail',
                  initial: false,
                  params: { keluarAnggotaId: sumberKeluarAnggotaId },
                })
              }
            >
              <Text style={styles.ctaSumberTeks}>Lihat Detail Pengajuan</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </TouchableOpacity>
          ) : (
            <Text style={styles.catatan}>Detail pengajuan asal tidak tersedia.</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

/**
 * Rincian pencairan simpanan berjangka: kontrak + perhitungan uang yang
 * diterima anggota. Murni tampilan dari angka yang dibaca service
 * (jurnal pencairan & settlement penarikan dini) — tidak menghitung ulang.
 */
function RincianBerjangkaCard({ r, total }: { r: RincianTarikBerjangka; total: number }) {
  const dini = r.jenisPencairan === 'DINI';
  const potongan: { label: string; nilai: number }[] = [
    { label: 'PPh Pasal 4 ayat (2) atas bunga', nilai: r.pphDipotong },
    { label: 'Penalti penarikan dini', nilai: r.penalti },
    { label: 'Biaya administrasi', nilai: r.biayaAdmin },
  ].filter((p) => p.nilai > 0);
  return (
    <>
      <Text style={styles.sectionTitle}>Kontrak Simpanan Berjangka</Text>
      <View style={[styles.card, { marginTop: 0 }]}>
        <View style={styles.badgeRow}>
          <View style={[styles.badge, dini ? styles.badgeDini : styles.badgeNormal]}>
            <Ionicons name={dini ? 'flash-outline' : 'calendar-outline'} size={12} color={dini ? colors.warning : colors.primary} />
            <Text style={[styles.badgeText, { color: dini ? colors.warning : colors.primary }]}>
              {dini ? 'Penarikan Dini' : 'Pencairan Jatuh Tempo'}
            </Text>
          </View>
        </View>
        {[
          { label: 'Nomor Kontrak', value: r.nomorKontrak },
          { label: 'Tanggal Penempatan', value: r.tanggalMulai },
          { label: 'Jatuh Tempo', value: r.tanggalJatuhTempo },
          { label: 'Tenor', value: `${r.tenorBulan} bulan` },
          { label: 'Suku Bunga', value: `${String(r.sukuBunga).replace('.', ',')}% per tahun` },
          ...(dini && r.policyVersi ? [{ label: 'Kebijakan Penarikan Dini', value: `Versi ${r.policyVersi}` }] : []),
        ].map((x) => (
          <View key={x.label} style={styles.row}>
            <Text style={styles.rowLabel}>{x.label}</Text>
            <Text style={styles.rowValue}>{x.value}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Rincian Pencairan</Text>
      <View style={[styles.card, { marginTop: 0 }]}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Pokok simpanan</Text>
          <Text style={styles.rowValue}>{formatRupiah(r.pokok)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Bunga dibayarkan</Text>
          <Text style={styles.rowValue}>{formatRupiah(r.bunga)}</Text>
        </View>
        {potongan.map((p) => (
          <View key={p.label} style={styles.row}>
            <Text style={styles.rowLabel}>{p.label}</Text>
            <Text style={[styles.rowValue, { color: colors.danger }]}>-{formatRupiah(p.nilai)}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.rowTotal]}>
          <Text style={styles.rowTotalLabel}>Total Diterima Anggota</Text>
          <Text style={styles.rowTotalValue}>{formatRupiah(total)}</Text>
        </View>
        {r.bungaHangus > 0 && (
          <Text style={styles.catatanRincian}>
            Bunga hangus sesuai kebijakan penarikan dini: {formatRupiah(r.bungaHangus)} (tidak dibayarkan).
          </Text>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  badgeRow: { flexDirection: 'row', marginBottom: spacing.xs },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  badgeDini: { backgroundColor: '#FFF4E5' },
  badgeNormal: { backgroundColor: colors.primaryLight },
  badgeText: { fontSize: 11, fontWeight: '700' },
  rowTotal: { borderBottomWidth: 0, borderTopWidth: 1.5, borderTopColor: colors.text, marginTop: 2, paddingTop: 10 },
  rowTotalLabel: { fontSize: 13, fontWeight: '700', color: colors.text, flexShrink: 1 },
  rowTotalValue: { fontSize: 14, fontWeight: '800', color: colors.primary, fontVariant: ['tabular-nums'] },
  catatanRincian: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.sm, lineHeight: 15 },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textMuted },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.md },
  nominalBox: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginBottom: spacing.md },
  nominalLabel: { fontSize: 11, color: colors.textMuted, textTransform: 'uppercase' },
  nominalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  ctaSumber: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  ctaSumberTeks: { fontSize: 13, fontWeight: '700', color: colors.primary, flex: 1 },
  catatan: { fontSize: 12, color: colors.textFaint, lineHeight: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, gap: spacing.sm, alignItems: 'flex-start' },
  rowLabel: { fontSize: 13, color: colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 13, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
