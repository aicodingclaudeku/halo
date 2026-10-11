import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, semantic, spacing, iconSize, typography, radius } from '@/theme/colors';
import { ui } from '@/theme/ui';
import { formatRupiah } from '@/utils/money';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { DashboardPajak, getDashboardPajak, TugasPajak } from '@/services/PajakDashboardService';
import { SaldoAkunPajak } from '@/services/PajakService';
import { ARTI_REZIM, LABEL_REZIM_SINGKAT, RezimPajak } from '@/config/pajakPolicy';
import { isiInfoPajak, IsiInfo, KunciInfo } from './infoPajak';
import { Catatan, LabelInfo, Memuat, TombolInfo } from './PajakUi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S87.5 — Hub Pajak versi SANGAT SEDERHANA.
 *
 * Hanya empat blok, dari atas ke bawah:
 *   1. Pajak apa yang berlaku (satu kalimat).
 *   2. SATU hal yang harus dikerjakan sekarang (tugas paling mendesak) —
 *      tugas lain disembunyikan di balik "lainnya".
 *   3. Utang pajak: satu angka + tombol Setor; rincian dilipat.
 *   4. Empat tombol besar.
 * Setiap blok & tombol punya ikon tanda seru. Data dari PajakDashboardService;
 * layar tidak menghitung apa pun.
 */

interface Tombol {
  ikon: keyof typeof Ionicons.glyphMap;
  label: string;
  route: string;
  info: KunciInfo;
}

const IKON_REZIM: Record<RezimPajak, keyof typeof Ionicons.glyphMap> = {
  FINAL_UMKM: 'receipt-outline',
  BADAN_31E: 'business-outline',
  BADAN_UMUM: 'briefcase-outline',
};

export default function PajakMenuScreen() {
  const navigation = useNavigation<any>();
  const [dash, setDash] = useState<DashboardPajak | null>(null);
  const [gagal, setGagal] = useState(false);
  const [tugasLain, setTugasLain] = useState(false);
  const [rincianUtang, setRincianUtang] = useState(false);

  const muat = useCallback(async () => {
    try {
      setDash(await getDashboardPajak());
      setGagal(false);
    } catch {
      setGagal(true);
    }
  }, []);
  useFocusRefresh(muat, [muat]);

  const tahun = dash?.tahun ?? getWaktuSekarang().getFullYear();
  const info = (k: KunciInfo): IsiInfo => isiInfoPajak(k, tahun);

  if (!dash) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
        {gagal ? <Catatan nada="galat">Gagal memuat data pajak. Buka kembali menu ini.</Catatan> : <Memuat />}
      </ScrollView>
    );
  }

  // RC-S87 — tombol mengikuti REZIM EFEKTIF (dihitung sistem).
  const rezim = dash.rezim.rezim;
  const tombol: Tombol[] =
    rezim === 'FINAL_UMKM'
      ? [
          { ikon: 'calculator-outline', label: 'Hitung Pajak Bulanan', route: 'PphFinalForm', info: 'menuPphFinal' },
          { ikon: 'card-outline', label: 'Setor Pajak', route: 'SetorPajakForm', info: 'menuSetor' },
          { ikon: 'time-outline', label: 'Riwayat', route: 'RiwayatPajak', info: 'menuRiwayat' },
          { ikon: 'settings-outline', label: 'Pengaturan', route: 'PengaturanPajak', info: 'menuPengaturan' },
        ]
      : rezim === 'BADAN_31E' || rezim === 'BADAN_UMUM'
      ? [
          { ikon: 'calendar-number-outline', label: 'Cicilan Bulanan (PPh 25)', route: 'AngsuranPph25Form', info: 'menuPph25' },
          { ikon: 'document-text-outline', label: 'Pajak Tahunan (PPh Badan)', route: 'PphBadanForm', info: 'menuPphBadan' },
          { ikon: 'card-outline', label: 'Setor Pajak', route: 'SetorPajakForm', info: 'menuSetor' },
          { ikon: 'time-outline', label: 'Riwayat', route: 'RiwayatPajak', info: 'menuRiwayat' },
        ]
      : [{ ikon: 'settings-outline', label: 'Pengaturan', route: 'PengaturanPajak', info: 'menuPengaturan' }];

  const [utama, ...lain] = dash.tugas;
  const p = dash.posisi;

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      {/* 1. Pajak apa yang berlaku */}
      <TouchableOpacity style={styles.status} onPress={() => navigation.navigate('PengaturanPajak')} accessibilityRole="button" activeOpacity={0.8}>
        <View style={styles.statusIkon}>
          <Ionicons name={rezim ? IKON_REZIM[rezim] : 'help-circle-outline'} size={24} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.baris}>
            <Text style={styles.kecil}>Pajak koperasi {tahun}</Text>
            <TombolInfo isi={info('caraKerja')} />
          </View>
          <Text style={styles.statusJudul}>{rezim ? LABEL_REZIM_SINGKAT[rezim] : 'Belum diatur'}</Text>
          <Text style={styles.statusArti}>{rezim ? ARTI_REZIM[rezim] : 'Ketuk untuk mengisi pengaturan pajak.'}</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} />
      </TouchableOpacity>

      {/* 2. Satu hal yang harus dikerjakan */}
      <View style={styles.judulBaris}>
        <Text style={styles.judul}>Sekarang</Text>
        <TombolInfo isi={info('tugas')} />
      </View>
      {!utama ? (
        <View style={styles.beres}>
          <Ionicons name="checkmark-circle" size={28} color={colors.success} />
          <Text style={styles.beresTeks}>Semua pajak sudah beres</Text>
        </View>
      ) : (
        <>
          <KartuTugas t={utama} utama onPress={() => navigation.navigate(utama.route, utama.params)} />
          {lain.length > 0 ? (
            <>
              <TouchableOpacity onPress={() => setTugasLain((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: tugasLain }} style={styles.lainnya}>
                <Text style={styles.tautan}>{tugasLain ? 'Sembunyikan' : `Lihat ${lain.length} tugas lainnya`}</Text>
                <Ionicons name={tugasLain ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary} />
              </TouchableOpacity>
              {tugasLain ? lain.map((t) => <KartuTugas key={t.kunci} t={t} onPress={() => navigation.navigate(t.route, t.params)} />) : null}
            </>
          ) : null}
        </>
      )}

      {/* 3. Utang pajak */}
      <View style={styles.kartu}>
        <View style={styles.baris}>
          <Text style={styles.kecil}>Utang pajak belum disetor</Text>
          <TombolInfo isi={info('posisiPajak')} />
        </View>
        <View style={[styles.baris, { justifyContent: 'space-between', marginTop: spacing.xs }]}>
          <Text style={[styles.utangNilai, p.totalUtang === 0 && { color: colors.success }]}>{formatRupiah(p.totalUtang)}</Text>
          {p.totalUtang > 0 ? (
            <TouchableOpacity style={styles.tombolSetor} onPress={() => navigation.navigate('SetorPajakForm')} accessibilityRole="button">
              <Text style={styles.tombolSetorTeks}>Setor</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity onPress={() => setRincianUtang((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: rincianUtang }} style={styles.lainnya}>
          <Text style={styles.tautan}>{rincianUtang ? 'Tutup rincian' : 'Lihat rincian'}</Text>
          <Ionicons name={rincianUtang ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary} />
        </TouchableOpacity>
        {rincianUtang ? (
          <View>
            <Grup judul="Pajak koperasi" info={info('utangKoperasi')} baris={p.pajakKoperasi} />
            <Grup judul="Dipotong dari anggota" info={info('utangAnggota')} baris={p.dipotongAnggota} />
            {p.lainnya.length > 0 ? <Grup judul="Lainnya" baris={p.lainnya} /> : null}
            {p.kreditPph25 !== 0 || p.kreditPphLain !== 0 ? (
              <View style={styles.grup}>
                <LabelInfo label="Sudah dibayar di muka (bukan utang)" info={info('kreditPajak')} />
                {p.kreditPph25 !== 0 ? <BarisNilai label="Cicilan PPh 25" nilai={p.kreditPph25} /> : null}
                {p.kreditPphLain !== 0 ? <BarisNilai label="PPh 22/23/24" nilai={p.kreditPphLain} /> : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* RC-S127 — bukti potong PPh 4(2) bunga simpanan (berlaku di semua rezim). */}
      <TouchableOpacity
        style={styles.buktiPotong}
        onPress={() => navigation.navigate('BuktiPotongPph')}
        accessibilityRole="button"
        accessibilityLabel="Bukti potong PPh bunga simpanan"
        activeOpacity={0.8}
      >
        <View style={styles.kotakIkonKecil}>
          <Ionicons name="receipt-outline" size={20} color={semantic.expenseIcon} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.buktiPotongJudul}>Bukti Potong Bunga Simpanan</Text>
          <Text style={styles.buktiPotongSub}>PPh 4(2) yang dipotong dari bunga Sukarela & Berjangka anggota</Text>
        </View>
        <TombolInfo isi={info('menuBuktiPotong')} />
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} />
      </TouchableOpacity>

      {/* 4. Tombol besar */}
      <View style={styles.grid}>
        {tombol.map((b) => (
          <TouchableOpacity key={b.route} style={styles.kotak} onPress={() => navigation.navigate(b.route)} accessibilityRole="button" accessibilityLabel={b.label} activeOpacity={0.75}>
            <View style={styles.kotakInfo}>
              <TombolInfo isi={info(b.info)} />
            </View>
            <View style={styles.kotakIkon}>
              <Ionicons name={b.ikon} size={26} color={semantic.expenseIcon} />
            </View>
            <Text style={styles.kotakLabel}>{b.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {rezim === 'BADAN_31E' || rezim === 'BADAN_UMUM' ? (
        <TouchableOpacity onPress={() => navigation.navigate('PengaturanPajak')} style={styles.tautanBawah} accessibilityRole="button">
          <Ionicons name="settings-outline" size={16} color={colors.textMuted} />
          <Text style={styles.tautanBawahTeks}>Pengaturan pajak</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

function KartuTugas({ t, utama, onPress }: { t: TugasPajak; utama?: boolean; onPress: () => void }) {
  const warna = t.nada === 'MENDESAK' ? colors.danger : t.nada === 'PERLU' ? colors.warning : colors.textMuted;
  return (
    <TouchableOpacity style={[styles.tugas, { borderLeftColor: warna }, utama && styles.tugasUtama]} onPress={onPress} accessibilityRole="button" accessibilityLabel={t.judul} activeOpacity={0.8}>
      <View style={{ flex: 1, minWidth: 0 }}>
        {t.nada === 'MENDESAK' ? <Text style={[styles.tugasLabel, { color: colors.danger }]}>Mendesak</Text> : null}
        <Text style={[styles.tugasJudul, utama && { fontSize: typography.sectionTitle }]}>{t.judul}</Text>
        {t.nominal !== null ? <Text style={styles.tugasNilai}>{formatRupiah(t.nominal)}</Text> : null}
      </View>
      {utama ? (
        <View style={styles.kerjakan}>
          <Text style={styles.kerjakanTeks}>Kerjakan</Text>
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={iconSize.sm} color={colors.textFaint} />
      )}
    </TouchableOpacity>
  );
}

function BarisNilai({ label, nilai }: { label: string; nilai: number }) {
  return (
    <View style={styles.nilaiBaris}>
      <Text style={styles.nilaiLabel}>{label}</Text>
      <Text style={styles.nilaiAngka}>{formatRupiah(nilai)}</Text>
    </View>
  );
}

function Grup({ judul, info, baris }: { judul: string; info?: IsiInfo; baris: SaldoAkunPajak[] }) {
  return (
    <View style={styles.grup}>
      <LabelInfo label={judul} info={info} />
      {baris.length === 0 ? <Text style={styles.kosong}>Tidak ada</Text> : baris.map((b) => <BarisNilai key={b.kode} label={b.jenis} nilai={b.saldo} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  baris: { flexDirection: 'row', alignItems: 'center' },
  kecil: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },

  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: spacing.lg,
  },
  statusIkon: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  statusJudul: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 2 },
  statusArti: { fontSize: typography.subtitle, color: colors.textMuted, marginTop: 2, lineHeight: 18 },

  judulBaris: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.sm },
  judul: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text },

  beres: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.lg },
  beresTeks: { fontSize: typography.body, fontWeight: '700', color: colors.text },

  tugas: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  tugasUtama: { padding: spacing.lg },
  tugasLabel: { fontSize: typography.caption, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  tugasJudul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  tugasNilai: { fontSize: typography.subtitle, color: colors.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  kerjakan: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: spacing.md, minHeight: 40, justifyContent: 'center' },
  kerjakanTeks: { color: colors.white, fontWeight: '700', fontSize: typography.subtitle },

  lainnya: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  tautan: { fontSize: typography.subtitle, fontWeight: '700', color: colors.primary },

  kartu: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, marginTop: spacing.md },
  utangNilai: { fontSize: 24, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  tombolSetor: { backgroundColor: semantic.expenseIcon, borderRadius: radius.sm, paddingHorizontal: spacing.lg, minHeight: 40, justifyContent: 'center' },
  tombolSetorTeks: { color: colors.white, fontWeight: '700', fontSize: typography.body },
  grup: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, marginTop: spacing.xs },
  nilaiBaris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 },
  nilaiLabel: { flex: 1, fontSize: typography.subtitle, color: colors.text },
  nilaiAngka: { fontSize: typography.subtitle, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  kosong: { fontSize: typography.caption, color: colors.textFaint, paddingVertical: 3 },

  buktiPotong: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  kotakIkonKecil: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: semantic.expenseIconBackground, alignItems: 'center', justifyContent: 'center' },
  buktiPotongJudul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  buktiPotongSub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  kotak: {
    width: '48.5%',
    minHeight: 112,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kotakInfo: { position: 'absolute', top: spacing.xs, right: spacing.xs },
  kotakIkon: { width: 48, height: 48, borderRadius: radius.pill, backgroundColor: semantic.expenseIconBackground, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  kotakLabel: { fontSize: typography.subtitle, fontWeight: '700', color: colors.text, textAlign: 'center' },

  tautanBawah: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
  tautanBawahTeks: { fontSize: typography.subtitle, color: colors.textMuted, fontWeight: '600' },
});
