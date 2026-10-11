import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listHistoryTransaksi, type HistoryTransaksiRow } from '@/services/HistoryTransaksiService';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import SearchField from '@/components/SearchField';
import { usePermission } from '@/hooks/usePermission';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { colors, iconSize, radius, spacing } from '@/theme/colors';
import {
  HALAMAN_RIWAYAT,
  LABEL_PERIODE_RIWAYAT,
  LABEL_STATUS_RIWAYAT,
  RIWAYAT_MENU,
  kelompokkanRiwayatPerBulan,
  ringkasRiwayat,
  saringStatusRiwayat,
  statusTampilRiwayat,
  tanggalMulaiPeriodeRiwayat,
  type FilterStatusRiwayat,
  type KunciRiwayatMenu,
  type PeriodeRiwayat,
  type StatusTampilRiwayat,
} from '@/utils/riwayatMenu';

/**
 * PANEL RIWAYAT — isi tab "Riwayat" di setiap menu transaksi.
 *
 * Ringkasan periode, pencarian, filter periode & status, daftar per bulan,
 * dan "Muat lebih banyak". Mengetuk transaksi membuka Detail History
 * Transaksi — satu-satunya tempat koreksi/pembatalan (cek periode
 * tertutup, izin, jurnal pembalik, jejak audit). Panel ini HANYA MEMBACA:
 * tidak ada aksi koreksi, tidak ada jurnal, tidak ada SQL.
 */
export default function RiwayatTransaksiMenu({ menu }: { menu: KunciRiwayatMenu }) {
  const navigation = useNavigation<any>();
  const { can } = usePermission();
  const bolehLihat = can('history_transaksi', 'view');
  const konfig = RIWAYAT_MENU[menu];
  const kataKunciMenu = 'kataKunci' in konfig ? (konfig.kataKunci as string) : undefined;

  const [periode, setPeriode] = useState<PeriodeRiwayat>('BULAN_INI');
  const [statusFilter, setStatusFilter] = useState<FilterStatusRiwayat>('SEMUA');
  const [cari, setCari] = useState('');
  const [cariAktif, setCariAktif] = useState('');
  const [batas, setBatas] = useState(HALAMAN_RIWAYAT);
  const [baris, setBaris] = useState<HistoryTransaksiRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState(false);

  // Pencarian dijalankan setelah pengguna berhenti mengetik sebentar.
  useEffect(() => {
    const t = setTimeout(() => setCariAktif(cari.trim()), 350);
    return () => clearTimeout(t);
  }, [cari]);

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(false);
    try {
      const hasil = await listHistoryTransaksi({
        jenis: [...konfig.jenis],
        search: cariAktif || kataKunciMenu,
        tanggalMulai: tanggalMulaiPeriodeRiwayat(periode, getTanggalLokalHariIni()),
        limit: batas,
      });
      // Kata kunci khusus menu tetap berlaku saat pengguna juga mencari.
      setBaris(kataKunciMenu && cariAktif ? hasil.filter((r) => r.deskripsi.includes(kataKunciMenu)) : hasil);
    } catch {
      setGalat(true);
    } finally {
      setMemuat(false);
    }
  }, [konfig, kataKunciMenu, cariAktif, periode, batas]);

  useFocusEffect(
    useCallback(() => {
      if (bolehLihat) void muat();
    }, [bolehLihat, muat])
  );

  const tampil = useMemo(() => saringStatusRiwayat(baris, statusFilter), [baris, statusFilter]);
  const kelompok = useMemo(() => kelompokkanRiwayatPerBulan(tampil), [tampil]);
  const ringkas = useMemo(() => ringkasRiwayat(tampil), [tampil]);
  const adaLagi = baris.length >= batas;

  if (!bolehLihat) {
    return (
      <View style={styles.kosong}>
        <Ionicons name="lock-closed-outline" size={28} color={colors.textFaint} />
        <Text style={styles.kosongJudul}>Riwayat tidak tersedia</Text>
        <Text style={styles.kosongText}>Akun Anda belum punya izin melihat History Transaksi.</Text>
      </View>
    );
  }

  const gantiPeriode = (p: PeriodeRiwayat) => {
    setPeriode(p);
    setBatas(HALAMAN_RIWAYAT);
  };

  return (
    <View>
      {/* RINGKASAN */}
      <View style={styles.ringkasan}>
        <View style={styles.ringkasanKiri}>
          <Text style={styles.ringkasanJudul}>{konfig.judul}</Text>
          <Text style={styles.ringkasanNilai}>{formatRupiah(ringkas.totalAktif)}</Text>
          {/* Jumlah nilai bruto transaksi yang ditampilkan (setor & tarik/terima & bayar
              dijumlah apa adanya) — BUKAN saldo akun. */}
          <Text style={styles.ringkasanLabel}>Nilai transaksi aktif · bukan saldo</Text>
          <Text style={styles.ringkasanSub}>
            {ringkas.jumlah} transaksi · {LABEL_PERIODE_RIWAYAT[periode].toLowerCase()}
            {ringkas.jumlahDibatalkan > 0 ? ` · ${ringkas.jumlahDibatalkan} dibatalkan` : ''}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Muat ulang riwayat"
          style={styles.tombolIkon}
          onPress={() => void muat()}
        >
          <Ionicons name="refresh" size={iconSize.md} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* CARI & FILTER */}
      <SearchField
        value={cari}
        onChangeText={setCari}
        placeholder="Cari nomor atau keterangan"
        returnKeyType="search"
      />
      <View style={styles.chipBaris}>
        {(Object.keys(LABEL_PERIODE_RIWAYAT) as PeriodeRiwayat[]).map((p) => (
          <Chip key={p} label={LABEL_PERIODE_RIWAYAT[p]} aktif={periode === p} onPress={() => gantiPeriode(p)} />
        ))}
      </View>
      <View style={styles.chipBaris}>
        {(
          [
            ['SEMUA', 'Semua status'],
            ['AKTIF', 'Aktif'],
            ['DIBATALKAN', 'Dibatalkan'],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} label={label} aktif={statusFilter === k} kecil onPress={() => setStatusFilter(k)} />
        ))}
      </View>

      {/* DAFTAR */}
      {memuat && baris.length === 0 ? (
        <ActivityIndicator color={colors.textMuted} style={{ marginVertical: spacing.xl }} />
      ) : galat ? (
        <TouchableOpacity accessibilityRole="button" style={styles.kosong} onPress={() => void muat()}>
          <Ionicons name="cloud-offline-outline" size={28} color={colors.textFaint} />
          <Text style={styles.kosongJudul}>Riwayat belum dapat dimuat</Text>
          <Text style={styles.kosongText}>Ketuk untuk mencoba lagi.</Text>
        </TouchableOpacity>
      ) : tampil.length === 0 ? (
        <View style={styles.kosong}>
          <Ionicons name="document-text-outline" size={28} color={colors.textFaint} />
          <Text style={styles.kosongJudul}>Belum ada transaksi</Text>
          <Text style={styles.kosongText}>
            {cariAktif ? 'Tidak ada yang cocok dengan pencarian.' : `Tidak ada transaksi pada periode "${LABEL_PERIODE_RIWAYAT[periode]}".`}
          </Text>
        </View>
      ) : (
        kelompok.map((g) => (
          <View key={g.kunci} style={styles.kelompok}>
            <Text style={styles.kelompokJudul}>{g.judul}</Text>
            <View style={styles.kartu}>
              {g.baris.map((r, i) => (
                <BarisRiwayat
                  key={r.journalId}
                  r={r}
                  garis={i > 0}
                  onPress={() => navigation.navigate('HistoryTransaksiDetail', { journalId: r.journalId })}
                />
              ))}
            </View>
          </View>
        ))
      )}

      {adaLagi && !galat ? (
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.muatLagi}
          onPress={() => setBatas((b) => b + HALAMAN_RIWAYAT)}
          disabled={memuat}
        >
          {memuat ? <ActivityIndicator color={colors.textMuted} /> : <Text style={styles.muatLagiText}>Muat lebih banyak</Text>}
        </TouchableOpacity>
      ) : null}

      <View style={styles.catatan}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
        <Text style={styles.catatanText}>
          Ketuk transaksi untuk melihat detail jurnal, mengoreksi, atau membatalkan. Transaksi yang dibatalkan tidak
          dihapus — jurnalnya dibalik dan tetap tercatat.
        </Text>
      </View>
    </View>
  );
}

function BarisRiwayat({ r, garis, onPress }: { r: HistoryTransaksiRow; garis: boolean; onPress: () => void }) {
  const status = statusTampilRiwayat(r);
  const batal = status === 'DIBATALKAN';
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${r.deskripsi}, ${formatRupiah(r.nominal)}, ${LABEL_STATUS_RIWAYAT[status]}`}
      accessibilityHint="Buka detail transaksi"
      activeOpacity={0.7}
      style={[styles.baris, garis && styles.barisGaris]}
      onPress={onPress}
    >
      <View style={styles.tanggalKotak}>
        <Text style={styles.tanggalHari}>{Number(r.tanggal.slice(8, 10))}</Text>
        <Text style={styles.tanggalBulan}>{formatTanggalIndonesia(r.tanggal).split(' ')[1]?.slice(0, 3) ?? ''}</Text>
      </View>
      <View style={styles.barisIsi}>
        <Text style={[styles.deskripsi, batal && styles.coret]} numberOfLines={2}>
          {r.deskripsi || r.jenisLabel}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {r.nomorTransaksi}
          {r.createdByNama ? ` · ${r.createdByNama}` : ''}
        </Text>
      </View>
      <View style={styles.kanan}>
        <Text style={[styles.nominal, batal && styles.coret]}>{formatRupiah(r.nominal)}</Text>
        <Lencana status={status} />
      </View>
      <Ionicons name="chevron-forward" size={iconSize.sm} color={colors.textFaint} />
    </TouchableOpacity>
  );
}

function Lencana({ status }: { status: StatusTampilRiwayat }) {
  const gaya =
    status === 'DIBATALKAN'
      ? styles.lencanaBatal
      : status === 'PEMBALIK'
      ? styles.lencanaKoreksi
      : status === 'DRAF'
      ? styles.lencanaDraf
      : styles.lencanaAktif;
  return (
    <View style={[styles.lencana, gaya]}>
      <Text style={styles.lencanaText}>{LABEL_STATUS_RIWAYAT[status]}</Text>
    </View>
  );
}

function Chip({ label, aktif, onPress, kecil }: { label: string; aktif: boolean; onPress: () => void; kecil?: boolean }) {
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={{ selected: aktif }}
      style={[styles.chip, kecil && styles.chipKecil, aktif && styles.chipAktif]}
      onPress={onPress}
    >
      <Text style={[styles.chipText, kecil && styles.chipTextKecil, aktif && styles.chipTextAktif]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  ringkasan: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  ringkasanKiri: { flex: 1, minWidth: 0 },
  ringkasanJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  ringkasanLabel: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  ringkasanNilai: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 4, fontVariant: ['tabular-nums'] },
  ringkasanSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  tombolIkon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },

  chipBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2, marginTop: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 7 },
  chipKecil: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5 },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12.5, fontWeight: '600', color: colors.text },
  chipTextKecil: { fontSize: 11.5 },
  chipTextAktif: { color: colors.white },

  kelompok: { marginTop: spacing.lg },
  kelompokJudul: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4, marginBottom: spacing.xs + 2, textTransform: 'uppercase' },
  kartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md },

  baris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.md, minHeight: 60 },
  barisGaris: { borderTopWidth: 1, borderTopColor: colors.border },
  tanggalKotak: { width: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderRadius: radius.sm, paddingVertical: 4 },
  tanggalHari: { fontSize: 16, fontWeight: '800', color: colors.text, lineHeight: 19 },
  tanggalBulan: { fontSize: 10, fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase' },
  barisIsi: { flex: 1, minWidth: 0 },
  deskripsi: { fontSize: 13, fontWeight: '600', color: colors.text, lineHeight: 17 },
  meta: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  kanan: { alignItems: 'flex-end', gap: 4, flexShrink: 0, maxWidth: '40%' },
  nominal: { fontSize: 13.5, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  coret: { textDecorationLine: 'line-through', color: colors.textMuted },

  lencana: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  lencanaAktif: { backgroundColor: colors.primaryLight },
  lencanaBatal: { backgroundColor: colors.dangerBg },
  lencanaKoreksi: { backgroundColor: colors.warningBg },
  lencanaDraf: { backgroundColor: colors.background },
  lencanaText: { fontSize: 10, fontWeight: '700', color: colors.text },

  kosong: { alignItems: 'center', paddingVertical: spacing.xl * 1.5, paddingHorizontal: spacing.lg, gap: 4 },
  kosongJudul: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  kosongText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },

  muatLagi: { alignItems: 'center', justifyContent: 'center', minHeight: 44, marginTop: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  muatLagiText: { fontSize: 13, fontWeight: '600', color: colors.text },

  catatan: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: spacing.lg },
  catatanText: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 15 },
});
