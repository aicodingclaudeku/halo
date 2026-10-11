import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { KEBIJAKAN_PENDAPATAN_INVESTASI } from '@/config/pendapatanKoperasiPolicy';

/**
 * RC-S67 — MENU CANONICAL "PENDAPATAN KOPERASI".
 *
 * Satu-satunya titik masuk bernama "Pendapatan Koperasi" (dari
 * Transaksi > Penerimaan). Nama file/route internal TETAP
 * `PendapatanLainnyaMenu` (dipakai TransaksiPenerimaanScreen & test UI) —
 * layar ini DIEVOLUSI, bukan diganti, sehingga tidak ada dua menu yang
 * sama-sama mengklaim sebagai menu Pendapatan Koperasi.
 *
 * Setiap leaf menunjuk mekanisme yang SUDAH ADA atau yang baru dibangun
 * RC-S67 di atas jalur akuntansi existing:
 *   A.1 Bagian SHU            -> BagianShuForm (RC-S53, tidak diduplikasi)
 *   A.1 Imbal Hasil Tetap     -> PendapatanInvestasiForm (IMBAL_HASIL_TETAP, RC-S67.6,
 *                                cash-basis Kr 4-1700, nomor dokumen wajib)
 *   A.2 Usaha Lain · Bunga    -> PendapatanInvestasiForm (BUNGA_USAHA_LAIN, Kr 4-1520)
 *   A.3 Deposito · Bunga      -> PendapatanInvestasiForm (BUNGA_DEPOSITO, Kr 4-1510)
 *   A.4 Properti · Sewa       -> PendapatanInvestasiForm (SEWA_PROPERTI)
 *   B   Pendapatan Unit Usaha -> PendapatanUnitUsahaForm (PENDAPATAN,
 *                                Dr Kas/Bank / Cr 4-1400, akun ditetapkan sistem).
 *       Pengembalian RAKU BUKAN pendapatan dan tidak ada di menu ini
 *       (Penerimaan > RAKU, Cr 1-1800).
 *   C   Penjualan / Pelepasan -> PelepasanAsetForm (RC-S67.7: form transaksi — pilih aset,
 *                                hasil pelepasan, pratinjau; PelepasanAsetTetapService).
 *                                Master Daftar Aset Tetap & Penyusutan tetap di menu Laporan.
 *   D   Pendapatan Lainnya    -> PendapatanLainnyaForm (form generik existing)
 *
 * Leaf nonaktif DITAMPILKAN apa adanya dengan alasannya — tidak disamarkan
 * sebagai fitur siap, dan tidak dapat diketuk.
 */

/**
 * `initial: false` (RC-S67.6): saat tab Laporan belum pernah dibuka, layar
 * tujuan TIDAK dijadikan layar awal stack — menu Laporan tetap berada di
 * bawahnya sehingga tombol Kembali berfungsi normal.
 */
type Aksi = { route: string; params?: Record<string, unknown> } | { tab: 'Laporan'; screen: string; initial?: boolean };

interface Leaf {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  aksi?: Aksi;
  /** Diisi bila leaf SENGAJA tidak dapat dipakai. */
  nonaktif?: { badge: string };
}

interface Grup {
  judul?: string;
  leaves: Leaf[];
}

interface Seksi {
  kode: string;
  judul: string;
  grup: Grup[];
}

const SEKSI: Seksi[] = [
  {
    kode: 'A',
    judul: 'Pendapatan Investasi',
    grup: [
      {
        judul: 'Penyertaan pada Koperasi Lain',
        leaves: [
          {
            icon: 'gift-outline',
            title: 'Bagian SHU',
            sub: 'Catat hak atau penerimaan bagian SHU dari penyertaan pada koperasi lain.',
            aksi: { route: 'BagianShuForm' },
          },
          {
            icon: 'cash-outline',
            title: 'Imbal Hasil Tetap',
            sub: 'Catat imbal hasil tetap berdasarkan ketentuan atau hak kontraktual investasi.',
            aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'IMBAL_HASIL_TETAP' } },
          },
        ],
      },
      {
        judul: 'Usaha Lain',
        leaves: [
          {
            icon: 'briefcase-outline',
            // RC-S70.6 — judul & akun dari kebijakan (4-1520 Pendapatan Bunga Investasi).
            title: KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.label,
            sub: `Penerimaan bunga dari investasi Usaha Lain — Kr ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.akunKode} ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.label}`,
            aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'BUNGA_USAHA_LAIN' } },
          },
        ],
      },
      {
        judul: 'Deposito Berjangka',
        leaves: [
          {
            icon: 'time-outline',
            // RC-S70.6 — judul & akun dari kebijakan (4-1510 Pendapatan Bunga Deposito).
            title: KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.label,
            sub: `Penerimaan bunga deposito berjangka — Kr ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.akunKode} ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.label}`,
            aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'BUNGA_DEPOSITO' } },
          },
        ],
      },
      {
        judul: 'Properti Investasi',
        leaves: [
          {
            icon: 'home-outline',
            title: 'Pendapatan Sewa',
            sub: `Penerimaan sewa properti investasi — Kr ${KEBIJAKAN_PENDAPATAN_INVESTASI.SEWA_PROPERTI.akunKode}`,
            aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'SEWA_PROPERTI' } },
          },
        ],
      },
    ],
  },
  {
    kode: 'B',
    judul: 'Pendapatan Unit Usaha',
    grup: [
      {
        leaves: [
          {
            icon: 'storefront-outline',
            title: 'Pendapatan Unit Usaha',
            sub: 'Penerimaan pendapatan dari kegiatan unit usaha koperasi — dicatat ke COA 4-1400.',
            aksi: { route: 'PendapatanUnitUsahaForm' },
          },
        ],
      },
    ],
  },
  {
    kode: 'C',
    judul: 'Penjualan / Pelepasan Aset',
    grup: [
      {
        leaves: [
          {
            icon: 'business-outline',
            title: 'Penjualan / Pelepasan Aset',
            sub: 'Pilih aset → isi hasil pelepasan → pratinjau laba/rugi dari nilai buku, bukan seluruh harga jual',
            aksi: { route: 'PelepasanAsetForm' },
          },
        ],
      },
    ],
  },
  {
    kode: 'D',
    judul: 'Pendapatan Lainnya',
    grup: [
      {
        leaves: [
          {
            icon: 'add-circle-outline',
            title: 'Tambah Transaksi Pendapatan',
            sub: 'Pendapatan lain dari akun COA existing — klasifikasi LHU otomatis',
            aksi: { route: 'PendapatanLainnyaForm' },
          },
        ],
      },
    ],
  },
];

export default function PendapatanLainnyaMenuScreen() {
  const navigation = useNavigation<any>();

  const jalankan = (aksi: Aksi) => {
    if ('tab' in aksi) navigation.navigate(aksi.tab, { screen: aksi.screen, initial: aksi.initial });
    else navigation.navigate(aksi.route, aksi.params);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Pilih jenis pendapatan koperasi yang ingin dicatat.</Text>

      {SEKSI.map((seksi) => (
        <View key={seksi.kode} style={styles.seksi}>
          <Text style={styles.seksiLabel} accessibilityRole="header">
            {seksi.kode}. {seksi.judul}
          </Text>
          {seksi.grup.map((g, gi) => (
            <View key={`${seksi.kode}-${gi}`}>
              {g.judul ? <Text style={styles.grupLabel}>{g.judul}</Text> : null}
              {g.leaves.map((m) =>
                m.nonaktif || !m.aksi ? (
                  <View
                    key={`${seksi.kode}-${m.title}`}
                    style={[styles.card, styles.cardNonaktif]}
                    accessibilityState={{ disabled: true }}
                    accessibilityLabel={`${m.title}, ${m.nonaktif?.badge ?? 'tidak tersedia'}`}
                  >
                    <View style={[styles.iconCircle, styles.iconNonaktif]}>
                      <Ionicons name={m.icon} size={menuIconSize} color={colors.textFaint} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.cardTitle, styles.textNonaktif]}>{m.title}</Text>
                      <Text style={styles.cardSub}>{m.sub}</Text>
                      <Text style={styles.badge}>{m.nonaktif?.badge ?? 'Tidak tersedia'}</Text>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    key={`${seksi.kode}-${m.title}`}
                    accessibilityRole="button"
                    style={styles.card}
                    onPress={() => jalankan(m.aksi as Aksi)}
                  >
                    <View style={styles.iconCircle}>
                      <Ionicons name={m.icon} size={menuIconSize} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.cardTitle}>{m.title}</Text>
                      <Text style={styles.cardSub}>{m.sub}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
                  </TouchableOpacity>
                )
              )}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  subtitle: { ...ui.screenIntro },
  seksi: { marginBottom: spacing.md },
  seksiLabel: { ...ui.sectionLabel, color: colors.primary },
  grupLabel: { fontSize: 12, fontWeight: '600', color: colors.text, marginTop: spacing.xs, marginBottom: spacing.xs },
  card: { ...ui.menuCard },
  cardNonaktif: { opacity: 0.75, backgroundColor: colors.background },
  iconCircle: { ...ui.menuIcon },
  iconNonaktif: { backgroundColor: colors.border },
  cardTitle: { ...ui.menuTitle },
  textNonaktif: { color: colors.textMuted },
  cardSub: { ...ui.menuSub },
  badge: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    fontSize: 10,
    fontWeight: '700',
    color: colors.warning,
    backgroundColor: colors.warningBg,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
