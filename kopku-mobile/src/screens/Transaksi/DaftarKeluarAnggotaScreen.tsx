import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listKeluarAnggota, type KeluarAnggotaRow } from '@/services/KeluarAnggotaService';
import { LABEL_ALASAN_KELUAR, LABEL_STATUS_KELUAR } from '@/screens/Transaksi/keluarAnggotaLabels';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';

/**
 * KELUAR ANGGOTA — DAFTAR PENGAJUAN.
 *
 * RC-S75 — layar ini kini MURNI MONITORING + NAVIGASI. Aksi Setujui,
 * Tolak, dan Bayar beserta pemilih Sumber Pembayaran DIPINDAH ke
 * `KeluarAnggotaDetailScreen`.
 *
 * Alasannya bukan sekadar kerapian. Sebelumnya setiap kartu di daftar
 * membawa tombol yang mengeluarkan uang, sementara pemilih Kas/Bank
 * berdiri SENDIRI di atas daftar — satu kontrol yang diam-diam berlaku
 * untuk tombol Bayar kartu mana pun yang kebetulan ditekan. Pada layar
 * berisi banyak pengajuan, tidak ada yang menandakan pengajuan mana
 * yang akan memakai sumber dana itu.
 *
 * Sekarang keputusan dibuat di layar detail, pada satu pengajuan yang
 * identitas dan angkanya sedang terlihat penuh.
 *
 * Layar ini tidak mengimpor satu pun fungsi mutasi, tidak menghitung
 * nominal apa pun, dan tidak pernah menyimpulkan status sendiri.
 */

/** Filter TAMPILAN saja — tidak ada query baru ke database. */
const FILTER = ['SEMUA', 'DIAJUKAN', 'DISETUJUI', 'DIBAYAR', 'DITOLAK'] as const;
type Filter = (typeof FILTER)[number];

/**
 * Label chip filter sengaja TETAP RINGKAS ("Diajukan", bukan "Menunggu
 * Persetujuan"): chip berjajar horizontal, dan label panjang akan
 * membungkus atau memaksa gulir menyamping. Badge pada kartu memakai
 * `LABEL_STATUS_KELUAR` yang lebih menjelaskan, di tempat yang memang
 * punya ruang.
 */
const LABEL_FILTER: Record<Filter, string> = {
  SEMUA: 'Semua',
  DIAJUKAN: 'Diajukan',
  DISETUJUI: 'Disetujui',
  DIBAYAR: 'Dibayar',
  DITOLAK: 'Ditolak',
};

function Baris({ label, nilai, tebal }: { label: string; nilai: number; tebal?: boolean }) {
  return (
    <View style={styles.ringkasBaris}>
      <Text style={[styles.ringkasLabel, tebal && styles.ringkasTebal]}>{label}</Text>
      <Text style={[styles.ringkasNilai, tebal && styles.ringkasTebal]}>{formatRupiah(nilai)}</Text>
    </View>
  );
}

function gayaBadge(status: string) {
  if (status === 'DIBAYAR') return styles.badgeDibayar;
  if (status === 'DISETUJUI') return styles.badgeDisetujui;
  if (status === 'DITOLAK') return styles.badgeDitolak;
  return styles.badgeDiajukan;
}

export default function DaftarKeluarAnggotaScreen() {
  const navigation = useNavigation<any>();

  const [daftar, setDaftar] = useState<KeluarAnggotaRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('SEMUA');

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setDaftar(await listKeluarAnggota());
    } catch {
      // Pesan teknis/SQLite tidak diteruskan ke pengguna.
      setGalat('Pengajuan keluar anggota gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, []);

  // Native stack tidak meng-unmount layar yang ditinggalkan, jadi
  // kembali ke sini setelah membuat pengajuan baru harus memicu
  // pembacaan ulang. Konvensi proyek: useFocusRefresh, bukan polling.
  useFocusRefresh(muat, [muat]);

  // Filter murni presentasi: `listKeluarAnggota()` sudah mengembalikan
  // seluruh baris, jadi tidak ada query tambahan saat chip ditekan.
  const terlihat = useMemo(
    () => (filter === 'SEMUA' ? daftar : daftar.filter((r) => r.statusPengajuan === filter)),
    [daftar, filter]
  );

  if (memuat) {
    return (
      <View style={styles.pusat}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (galat !== null) {
    return (
      <View style={styles.pusat}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.danger} />
        <Text style={styles.pusatTeks}>{galat}</Text>
        <TouchableOpacity accessibilityRole="button" style={styles.cobaLagi} onPress={() => void muat()}>
          <Text style={styles.cobaLagiTeks}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (daftar.length === 0) {
    return (
      <View style={styles.pusat}>
        <Ionicons name="document-outline" size={32} color={colors.textMuted} />
        <Text style={styles.kosongJudul}>Belum ada pengajuan keluar anggota</Text>
        <Text style={styles.pusatTeks}>Pengajuan yang dibuat akan muncul di sini.</Text>
        {/* Murni navigasi — tidak membuat apa pun dari layar ini. */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Buat pengajuan keluar anggota"
          style={styles.ctaKosong}
          onPress={() => navigation.navigate('KeluarAnggotaForm')}
        >
          <Text style={styles.ctaKosongTeks}>Buat Pengajuan</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <View style={styles.chipRow}>
        {FILTER.map((f) => (
          <TouchableOpacity
            key={f}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f }}
            accessibilityLabel={`Filter status ${LABEL_FILTER[f]}`}
            style={[styles.chip, filter === f && styles.chipAktif]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextAktif]}>
              {LABEL_FILTER[f]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {terlihat.length === 0 ? (
        <Text style={styles.catatan}>
          Tidak ada pengajuan pada status ini.
        </Text>
      ) : (
        terlihat.map((row) => (
          // SELURUH kartu adalah target tap — bukan tombol kecil
          // "Detail" yang bersaing dengan gesture membuka kartu.
          // Hanya `keluarAnggotaId` yang dikirim: objek pengajuan yang
          // ikut params akan basi begitu statusnya berubah.
          <Pressable
            key={row.id}
            style={({ pressed }) => [styles.baris, pressed && styles.barisDitekan]}
            onPress={() => navigation.navigate('KeluarAnggotaDetail', { keluarAnggotaId: row.id })}
            accessibilityRole="button"
            accessibilityLabel={`Detail pengajuan ${row.namaAnggota}, ${LABEL_STATUS_KELUAR[row.statusPengajuan]}`}
          >
            <View style={styles.barisAtas}>
              <Text style={styles.barisJudul}>{row.namaAnggota}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
            </View>
            <Text style={styles.barisDetail}>{LABEL_ALASAN_KELUAR[row.alasanKeluar]}</Text>
            <Text style={styles.barisTanggal}>{row.tanggalPengajuan}</Text>

            <View style={styles.barisNilaiRow}>
              <Text style={styles.barisNilaiLabel}>Nilai pengembalian</Text>
              <Text style={styles.barisNilai}>{formatRupiah(row.nilaiPengembalian)}</Text>
            </View>

            {/* Status sebagai badge + TEKS — tidak pernah warna saja. */}
            <View style={[styles.badge, gayaBadge(row.statusPengajuan)]}>
              <Text style={styles.badgeText}>{LABEL_STATUS_KELUAR[row.statusPengajuan]}</Text>
            </View>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  pusat: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  pusatTeks: { color: colors.textMuted, textAlign: 'center', fontSize: 13 },
  kosongJudul: { fontSize: 15, fontWeight: '700', color: colors.text, textAlign: 'center' },
  cobaLagi: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  cobaLagiTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  ctaKosong: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: radius.sm,
  },
  ctaKosongTeks: { color: colors.white, fontWeight: '700', fontSize: 14 },

  catatan: { fontSize: 12, color: colors.textFaint, marginTop: spacing.md, textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextAktif: { color: colors.white },

  ringkasBaris: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  ringkasLabel: { fontSize: 12, color: colors.textMuted },
  ringkasNilai: { fontSize: 12, color: colors.text },
  ringkasTebal: { fontWeight: '700', color: colors.text },

  baris: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  barisDitekan: { backgroundColor: colors.background, opacity: 0.9 },
  barisAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  barisTanggal: { fontSize: 11, color: colors.textFaint, marginBottom: spacing.sm },
  barisNilaiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  barisNilaiLabel: { fontSize: 12, color: colors.textMuted },
  barisNilai: { fontSize: 16, fontWeight: '800', color: colors.primary },
  barisJudul: { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1 },
  barisDetail: { fontSize: 11, color: colors.textMuted, marginTop: 2, marginBottom: spacing.xs },
  badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeDiajukan: { backgroundColor: '#FFF4E5' },
  badgeDisetujui: { backgroundColor: '#E3F2FD' },
  badgeDibayar: { backgroundColor: '#E6F4EA' },
  badgeDitolak: { backgroundColor: '#FDECEA' },
  badgeText: { fontSize: 10, fontWeight: '700', color: colors.text },
});
