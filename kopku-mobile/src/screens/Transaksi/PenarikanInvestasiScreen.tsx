import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import EmptyState from '@/components/report/EmptyState';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { listInvestasi, type InvestasiListItem } from '@/services/InvestasiService';
import { getPetaPenarikanInvestasi } from '@/services/PenarikanInvestasiService';
import { colors, radius, spacing } from '@/theme/colors';
import { formatRupiah } from '@/utils/money';
import { tanggalRingkas } from '@/utils/tarikSimpananUi';
import {
  dapatDitarik,
  JENIS_PENARIKAN,
  statusInvestasiUi,
  type JenisPenarikanInvestasi,
} from '@/utils/penarikanInvestasiUi';

/**
 * PENERIMAAN PENARIKAN DANA INVESTASI — HALAMAN UTAMA.
 *
 * Pusat pencairan investasi koperasi: Penyertaan pada Koperasi Lain,
 * Penyertaan pada Usaha Lain, dan Deposito Berjangka. Setelah jenis
 * dipilih, hanya investasi yang masih dapat ditarik — berstatus Aktif
 * atau Sebagian Ditarik (status tabel AKTIF; guard yang sama dengan
 * `PenarikanInvestasiService`) — yang ditampilkan.
 * Data dibaca dari `listInvestasi()` existing.
 */
export default function PenarikanInvestasiScreen() {
  const navigation = useNavigation<any>();
  const [jenis, setJenis] = useState<JenisPenarikanInvestasi | null>(null);
  const [semua, setSemua] = useState<InvestasiListItem[]>([]);
  const [peta, setPeta] = useState<Record<string, { totalDitarik: number; jumlah: number }>>({});
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      const [daftarInv, petaTarik] = await Promise.all([listInvestasi(), getPetaPenarikanInvestasi()]);
      setSemua(daftarInv);
      setPeta(petaTarik);
    } catch {
      setGalat('Data investasi gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, []);
  useFocusRefresh(() => {
    void muat();
  }, [muat]);

  const jumlahAktif = (kode: JenisPenarikanInvestasi) =>
    semua.filter((i) => i.jenisInvestasi === kode && dapatDitarik(i.status)).length;
  const daftar = jenis ? semua.filter((i) => i.jenisInvestasi === jenis && dapatDitarik(i.status)) : [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
      <View style={styles.infoBox}>
        <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
        <Text style={styles.infoText}>
          Catat dana yang diterima kembali dari investasi koperasi. Sistem menghitung nilai tercatat, selisih
          keuntungan/kerugian, dan jurnalnya secara otomatis.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.riwayatLink}
        accessibilityRole="button"
        onPress={() => navigation.navigate('RiwayatPenarikanInvestasi')}
      >
        <Ionicons name="time-outline" size={18} color={colors.primary} />
        <Text style={styles.riwayatText}>Riwayat Penarikan Investasi</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
      </TouchableOpacity>

      <Text style={styles.sectionLabel}>Pilih jenis investasi</Text>
      {JENIS_PENARIKAN.map((j) => {
        const aktif = jenis === j.kode;
        return (
          <TouchableOpacity
            key={j.kode}
            accessibilityRole="radio"
            accessibilityState={{ selected: aktif }}
            style={[styles.jenisCard, aktif && styles.jenisCardAktif]}
            onPress={() => setJenis(j.kode)}
          >
            <View style={[styles.jenisIkon, aktif && styles.jenisIkonAktif]}>
              <Ionicons name={j.ikon} size={22} color={aktif ? colors.white : colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.jenisJudul}>{j.judul}</Text>
              <Text style={styles.jenisSub}>{j.keterangan}</Text>
            </View>
            {!memuat ? (
              <View style={styles.hitung}>
                <Text style={styles.hitungText}>{jumlahAktif(j.kode)} aktif</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}

      {jenis ? (
        <>
          <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>Investasi yang dapat ditarik</Text>
          {memuat ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
          ) : galat ? (
            <TouchableOpacity onPress={() => void muat()}>
              <Text style={styles.errorText}>{galat} Ketuk untuk memuat ulang.</Text>
            </TouchableOpacity>
          ) : daftar.length === 0 ? (
            <EmptyState icon="wallet-outline" title="Tidak ada investasi aktif" message="Belum ada investasi aktif untuk jenis ini." />
          ) : (
            daftar.map((i) => {
              const riwayat = peta[i.id];
              const st = statusInvestasiUi(i.status, riwayat?.jumlah ?? 0);
              return (
                <TouchableOpacity
                  key={i.id}
                  style={styles.invCard}
                  accessibilityRole="button"
                  onPress={() => navigation.navigate('PenarikanInvestasiForm', { investasiId: i.id })}
                >
                  <View style={styles.invAtas}>
                    <Text style={styles.invNama} numberOfLines={1}>
                      {i.namaTujuan}
                    </Text>
                    <View style={[styles.badge, st.nada === 'OK' ? styles.badgeOk : st.nada === 'WARN' ? styles.badgeWarn : styles.badgeMuted]}>
                      <Text style={[styles.badgeText, st.nada === 'OK' ? styles.badgeTextOk : st.nada === 'WARN' ? styles.badgeTextWarn : styles.badgeTextMuted]}>
                        {st.label}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.invNomor}>
                    {i.nomorInvestasi}
                    {i.nomorRekeningInvestasi ? ` · No. ${i.nomorRekeningInvestasi}` : ''}
                  </Text>
                  {i.tanggalJatuhTempo ? (
                    <Text style={styles.invNomor}>Jatuh tempo {tanggalRingkas(i.tanggalJatuhTempo)}</Text>
                  ) : null}
                  {riwayat && riwayat.totalDitarik > 0 ? (
                    <Text style={styles.invDitarik}>Telah ditarik {formatRupiah(riwayat.totalDitarik)}</Text>
                  ) : null}
                  <View style={styles.invBawah}>
                    <Text style={styles.invTanggal}>Penempatan {tanggalRingkas(i.tanggal.slice(0, 10))}</Text>
                    <Text style={styles.invNominal}>{formatRupiah(i.jumlah)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  infoBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  riwayatLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  riwayatText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: spacing.sm },
  jenisCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  jenisCardAktif: { borderColor: colors.primary, borderWidth: 1.5, backgroundColor: colors.primaryLight },
  jenisIkon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  jenisIkonAktif: { backgroundColor: colors.primary },
  jenisJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  jenisSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  hitung: { borderRadius: radius.pill, backgroundColor: colors.background, paddingHorizontal: 10, paddingVertical: 3 },
  hitungText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: spacing.lg },
  invCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  invAtas: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  invNama: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  invNomor: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  invBawah: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: spacing.sm },
  invTanggal: { fontSize: 12, color: colors.textMuted },
  invNominal: { fontSize: 16, fontWeight: '700', color: colors.text },
  badge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeOk: { backgroundColor: colors.primaryLight },
  badgeMuted: { backgroundColor: colors.background },
  badgeWarn: { backgroundColor: colors.warningBg },
  badgeTextWarn: { color: colors.warning },
  invDitarik: { fontSize: 12, color: colors.warning, fontWeight: '600', marginTop: 2 },
  badgeText: { fontSize: 10.5, fontWeight: '700' },
  badgeTextOk: { color: colors.success },
  badgeTextMuted: { color: colors.textMuted },
});
