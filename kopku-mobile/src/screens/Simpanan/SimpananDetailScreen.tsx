import React, { useCallback, useState } from 'react';
import { labelJenisSimpanan, LABEL_TIPE_SIMPANAN } from '@/reports/TampilanAnggotaPlan';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { formatRupiah } from '@/utils/money';
import {
  getSimpananDetailById,
  getRingkasanSaldoSimpananAnggota,
  SimpananDetailRow,
  JenisSimpanan,
} from '@/services/SimpananService';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { colors, radius, spacing } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';

/**
 * ============================================================
 * DETAIL SATU TRANSAKSI SIMPANAN — READ-ONLY
 * ============================================================
 *
 * MASALAH YANG DITUTUP. Daftar "Setor Simpanan" (`SimpananHistoriScreen`)
 * merender tiap transaksi sebagai `<View>` biasa: menyentuhnya tidak
 * melakukan apa pun, jadi daftar itu jalan buntu. Nomor transaksi,
 * sumber dana, periode, dan — yang paling penting — status koreksi
 * tidak dapat dilihat di mana pun.
 *
 * YANG TIDAK DILAKUKAN LAYAR INI, DAN ITU DISENGAJA.
 *
 * 1. TIDAK ADA MUTASI. Tanpa tombol Edit/Hapus/Batalkan, dan layar ini
 *    tidak mengimpor `setorSimpanan`, `tarikSimpananSukarela`,
 *    `koreksiSimpanan`, `createJournal`, atau `reverseJournal`. Koreksi
 *    tetap memakai workflow existing di tempatnya sendiri. Membuka
 *    detail TIDAK PERNAH menulis transaksi atau jurnal baru.
 *
 * 2. TIDAK ADA PERHITUNGAN. Saldo dibaca lewat
 *    `getRingkasanSaldoSimpananAnggota()` yang memanggil
 *    `getSaldoSimpanan` yang SAMA dengan seluruh aplikasi — layar ini
 *    tidak menjumlahkan transaksi sendiri, sehingga angkanya tidak
 *    mungkin berbeda dari layar lain.
 *
 * 3. TIDAK MEMBAWA OBJEK TRANSAKSI LEWAT PARAMS. Route hanya menerima
 *    `simpananId`; datanya selalu dibaca ulang dari service. Objek yang
 *    dikirim lewat params akan menjadi basi begitu transaksi dikoreksi
 *    dari layar lain.
 *
 * 4. TIDAK ADA TOMBOL BACK LOKAL. Native stack header sudah
 *    menyediakannya (konvensi yang sama dengan
 *    `SimpananBerjangkaDetailScreen`).
 *
 * REFRESH BERBASIS FOKUS. Native stack tidak meng-unmount layar yang
 * ditinggalkan, jadi `useEffect(..., [])` tidak akan berjalan ulang saat
 * pengguna kembali ke sini setelah transaksi dikoreksi di tempat lain.
 * Karena itu pemuatannya memakai `useFocusRefresh` (konvensi proyek),
 * BUKAN polling dan BUKAN interval.
 */

/**
 * RC-S111: label pendek ("Pokok") datang dari modul tampilan bersama
 * `@/reports/TampilanAnggotaPlan`, satu-satunya tempat pemetaan enum
 * simpanan ditulis. Layar ini menambahkan awalan "Simpanan " sendiri
 * karena di sini label itu berdiri sebagai judul, sedangkan di daftar
 * histori ia sudah didahului kata "Simpanan". Sebelumnya pemetaannya
 * disalin di sini, dan salinan seperti itu cepat atau lambat berbeda
 * dari aslinya.
 */
const LABEL_JENIS: Record<JenisSimpanan, string> = {
  POKOK: `Simpanan ${labelJenisSimpanan('POKOK')}`,
  WAJIB: `Simpanan ${labelJenisSimpanan('WAJIB')}`,
  SUKARELA: `Simpanan ${labelJenisSimpanan('SUKARELA')}`,
};

/**
 * Nilai mentah `SETOR`/`TARIK`/`KOREKSI` tidak pernah ditampilkan
 * sebagai teks utama — itu istilah tabel, bukan bahasa pengguna.
 */
const LABEL_TIPE: Record<SimpananDetailRow['tipe'], string> = LABEL_TIPE_SIMPANAN;

const LABEL_SUMBER_DANA: Record<SimpananDetailRow['sumberDana'], string> = {
  KAS: 'Kas',
  // Sengaja hanya "Bank": baris historis menyimpan `bank_account_id`
  // tanpa snapshot nama rekening, jadi menampilkan nama dari master bank
  // SAAT INI akan menyajikan data sekarang sebagai fakta historis.
  BANK: 'Bank',
};

/** Tanda nominal mengikuti arah transaksi; KOREKSI netral (tidak menambah/mengurangi saldo). */
function nominalBertanda(row: SimpananDetailRow): string {
  const angka = formatRupiah(row.nominal);
  if (row.tipe === 'SETOR') return `+${angka}`;
  if (row.tipe === 'TARIK') return `-${angka}`;
  return angka;
}

function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.baris}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={styles.barisNilai}>{nilai}</Text>
    </View>
  );
}

function BarisSaldo({ label, nilai, tebal }: { label: string; nilai: number; tebal?: boolean }) {
  return (
    <View style={[styles.baris, tebal && styles.barisTotal]}>
      <Text style={[styles.barisLabel, tebal && styles.barisLabelTotal]}>{label}</Text>
      <Text style={[styles.barisNilai, tebal && styles.barisNilaiTotal]}>{formatRupiah(nilai)}</Text>
    </View>
  );
}

interface Saldo {
  pokok: number;
  wajib: number;
  sukarela: number;
  total: number;
}

export default function SimpananDetailScreen() {
  const route = useRoute<any>();
  const simpananId: string | undefined = route.params?.simpananId;

  const [row, setRow] = useState<SimpananDetailRow | null>(null);
  const [saldo, setSaldo] = useState<Saldo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tidakDitemukan, setTidakDitemukan] = useState(false);

  const load = useCallback(async () => {
    if (!simpananId) {
      setLoading(false);
      setTidakDitemukan(true);
      return;
    }
    setLoading(true);
    setError(null);
    setTidakDitemukan(false);
    try {
      const detail = await getSimpananDetailById(simpananId);
      if (!detail) {
        setRow(null);
        setSaldo(null);
        setTidakDitemukan(true);
        return;
      }
      setRow(detail);
      // Saldo hanya dapat dibaca bila anggotanya masih ada; kalau tidak,
      // detail transaksinya tetap ditampilkan tanpa bagian saldo.
      setSaldo(detail.anggotaId ? await getRingkasanSaldoSimpananAnggota(detail.anggotaId) : null);
    } catch (e) {
      // Pesan teknis/SQL tidak pernah diteruskan ke pengguna.
      setError('Gagal memuat detail simpanan.');
    } finally {
      setLoading(false);
    }
  }, [simpananId]);

  useFocusRefresh(load, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.centerText}>Memuat detail simpanan…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.danger} />
        <Text style={styles.centerText}>{error}</Text>
        <TouchableOpacity style={styles.cobaLagi} onPress={load} accessibilityRole="button">
          <Text style={styles.cobaLagiTeks}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (tidakDitemukan || !row) {
    return (
      <View style={styles.center}>
        <Ionicons name="document-outline" size={32} color={colors.textMuted} />
        <Text style={styles.centerText}>Data simpanan tidak ditemukan.</Text>
      </View>
    );
  }

  const sudahDikoreksi = row.dikoreksiOlehNomorTransaksi !== null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
      {/* HERO — nominal adalah hierarki visual utama. */}
      <View style={styles.hero}>
        <View style={styles.heroBaris}>
          <Ionicons name="wallet-outline" size={18} color={colors.primary} />
          <Text style={styles.heroJenis}>{LABEL_JENIS[row.jenis]}</Text>
        </View>
        {/* Status selalu terbaca sebagai TEKS, tidak hanya lewat warna. */}
        <Text style={styles.heroTipe}>{LABEL_TIPE[row.tipe]}</Text>
        <Text
          style={[
            styles.heroNominal,
            row.tipe === 'TARIK' && styles.heroNominalTarik,
            row.tipe === 'KOREKSI' && styles.heroNominalKoreksi,
          ]}
        >
          {nominalBertanda(row)}
        </Text>
      </View>

      {/* STATUS AUDIT — histori tidak pernah dihapus, jadi transaksi yang
          sudah dikoreksi harus mengatakannya sendiri. */}
      {sudahDikoreksi && (
        <View style={styles.banner}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerJudul}>Transaksi ini sudah dikoreksi.</Text>
            <Text style={styles.bannerTeks}>Koreksi: {row.dikoreksiOlehNomorTransaksi}</Text>
            <Text style={styles.bannerTeks}>Nilainya tidak lagi dihitung dalam saldo simpanan.</Text>
          </View>
        </View>
      )}

      {row.tipe === 'KOREKSI' && row.koreksiDariNomorTransaksi && (
        <View style={styles.banner}>
          <Ionicons name="swap-horizontal-outline" size={16} color={colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerJudul}>Koreksi atas transaksi:</Text>
            <Text style={styles.bannerTeks}>{row.koreksiDariNomorTransaksi}</Text>
          </View>
        </View>
      )}

      <Text style={styles.seksiJudul}>Anggota</Text>
      <View style={styles.kartu}>
        {row.namaAnggota ? (
          <>
            <Baris label="Nama" nilai={row.namaAnggota} />
            <Baris label="Nomor Anggota" nilai={row.nomorAnggota ?? '-'} />
          </>
        ) : (
          <Text style={styles.kosong}>Data anggota tidak ditemukan.</Text>
        )}
      </View>

      <Text style={styles.seksiJudul}>Detail Transaksi</Text>
      <View style={styles.kartu}>
        <Baris label="Nomor Transaksi" nilai={row.nomorTransaksi} />
        <Baris label="Tanggal" nilai={formatTanggalIndonesia(row.tanggal)} />
        <Baris label="Jenis Simpanan" nilai={LABEL_JENIS[row.jenis]} />
        <Baris label="Tipe Transaksi" nilai={LABEL_TIPE[row.tipe]} />
        <Baris label="Nominal" nilai={formatRupiah(row.nominal)} />
        <Baris label="Sumber Dana" nilai={LABEL_SUMBER_DANA[row.sumberDana]} />
        {row.periode ? <Baris label="Periode" nilai={row.periode} /> : null}
        <Baris label="Keterangan" nilai={row.keterangan ?? '-'} />
      </View>

      {saldo && (
        <>
          <Text style={styles.seksiJudul}>Saldo Simpanan Saat Ini</Text>
          <View style={styles.kartu}>
            <BarisSaldo label="Simpanan Pokok" nilai={saldo.pokok} />
            <BarisSaldo label="Simpanan Wajib" nilai={saldo.wajib} />
            <BarisSaldo label="Simpanan Sukarela" nilai={saldo.sukarela} />
            <BarisSaldo label="Total Simpanan" nilai={saldo.total} tebal />
          </View>
          <Text style={styles.catatan}>
            Saldo di atas adalah posisi terkini anggota, bukan posisi pada tanggal transaksi ini.
            Simpanan Berjangka dicatat terpisah dan tidak termasuk dalam total.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.sm },
  centerText: { color: colors.textMuted, textAlign: 'center' },
  cobaLagi: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  cobaLagiTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },

  hero: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  heroBaris: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroJenis: { fontSize: 13, fontWeight: '700', color: colors.primary },
  heroTipe: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  heroNominal: { fontSize: 28, fontWeight: '800', color: colors.primary, marginTop: spacing.sm },
  heroNominalTarik: { color: colors.danger },
  heroNominalKoreksi: { color: colors.text },

  banner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  bannerTeks: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  seksiJudul: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  baris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barisTotal: { borderBottomWidth: 0 },
  barisLabel: { fontSize: 13, color: colors.textMuted, flexShrink: 0 },
  barisLabelTotal: { fontWeight: '700', color: colors.text },
  barisNilai: { fontSize: 13, color: colors.text, fontWeight: '600', flex: 1, textAlign: 'right' },
  barisNilaiTotal: { fontSize: 15, fontWeight: '800', color: colors.primary },
  kosong: { fontSize: 13, color: colors.textMuted, paddingVertical: 12 },
  catatan: { fontSize: 11, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 16 },
});
