import React, { useMemo, useState } from 'react';
import { useRoute } from '@react-navigation/native';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PanduanImportSlide from '@/components/panduan/PanduanImportSlide';
import {
  ATURAN_UMUM,
  KODE_CONTOH,
  KolomTemplate,
  SHEET_SALDO_AWAL_AKUN,
  SHEET_TEMPLATE_TRANSAKSI_BARU,
  judulKolomExcel,
  sheetTemplateUrutTampilan,
  type JenisTemplateDataAwal,
} from '@/import/TemplateDataAwal';
import { LABEL_SHEET, LABEL_SHEET_SALDO_AWAL_AKUN } from '@/import/ExcelDataAwalParser';
import { unduhTemplateDataAwal } from '@/services/ImportDataAwalService';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, iconSize, elevation } from '@/theme/colors';
import { ui } from '@/theme/ui';

/**
 * Layar "Struktur Template" — menampilkan ISI template Excel Import Data
 * Awal di dalam aplikasi, sehingga pengurus bisa memahami apa yang harus
 * diisi tanpa membuka Excel lebih dulu.
 *
 * ============================================================
 * SATU SUMBER DENGAN BERKAS EXCEL-NYA
 * ============================================================
 * Seluruh isi layar ini dirender dari `SHEET_TEMPLATE` — objek yang SAMA
 * yang dipakai membangun berkas `.xlsx`-nya, dan judul kolom di bawah
 * dihitung `judulKolomExcel()` yang SAMA dipakai menulis baris header
 * Excel. Jadi layar ini mustahil menampilkan kolom yang tidak ada di
 * berkasnya, atau menandai kolom sebagai wajib padahal di Excel tidak —
 * kesalahan yang hampir pasti terjadi kalau layar ini mengetik ulang
 * daftar kolomnya sendiri.
 *
 * Yang ditampilkan per sheet:
 *   1. PRATINJAU TABEL — baris header + baris contoh, digulir ke samping
 *      persis seperti tampilannya di Excel. Ini bagian yang paling cepat
 *      dipahami: pengguna melihat bentuk tabelnya, bukan membaca daftar.
 *   2. RINCIAN KOLOM — untuk tiap kolom: wajib/opsional, pilihan nilai
 *      yang sah, contoh format, dan catatan yang tidak muat di Excel.
 *
 * Layar ini TIDAK memuat aturan apa pun sendiri dan tidak menulis
 * apa-apa ke database.
 */
/** Satu sheet yang ditampilkan: sheet data (punya `jenis`) atau sheet tambahan (sheet 7). */
interface SheetTampil {
  kunci: string;
  nama: string;
  label: string;
  keterangan: string;
  kolom: KolomTemplate[];
}

export default function StrukturTemplateScreen() {
  const route = useRoute<any>();
  // RC-S133.4.7 — dua template. Bawaan mengikuti pilihan di layar Import.
  const [jenisTemplate, setJenisTemplate] = useState<JenisTemplateDataAwal>(
    route?.params?.jenis === 'TRANSAKSI_BARU' ? 'TRANSAKSI_BARU' : 'SALDO_LAMA'
  );
  const sheets: SheetTampil[] = useMemo(() => {
    const dasar = jenisTemplate === 'TRANSAKSI_BARU' ? SHEET_TEMPLATE_TRANSAKSI_BARU : sheetTemplateUrutTampilan();
    const daftar: SheetTampil[] = dasar.map((s) => ({ kunci: s.jenis, nama: s.nama, label: LABEL_SHEET[s.jenis], keterangan: s.keterangan, kolom: s.kolom }));
    if (jenisTemplate === 'SALDO_LAMA') {
      daftar.push({ kunci: 'SALDO_AWAL_AKUN', nama: SHEET_SALDO_AWAL_AKUN.nama, label: LABEL_SHEET_SALDO_AWAL_AKUN, keterangan: SHEET_SALDO_AWAL_AKUN.keterangan, kolom: SHEET_SALDO_AWAL_AKUN.kolom });
    }
    return daftar;
  }, [jenisTemplate]);
  const [aktif, setAktif] = useState<string>('ANGGOTA');
  const [mengunduh, setMengunduh] = useState(false);
  const [panduanTerbuka, setPanduanTerbuka] = useState(false);

  const sheetAktif: SheetTampil | undefined = sheets.find((s) => s.kunci === aktif) ?? sheets[0];

  const unduh = async () => {
    setMengunduh(true);
    try {
      const { fileName } = await unduhTemplateDataAwal(jenisTemplate);
      notify('Template dibuat', `${fileName} sudah disiapkan. Isi di Excel, lalu kembali ke Import Data Awal.`);
    } catch (e) {
      notify('Gagal membuat template', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMengunduh(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[ui.screenContent, styles.isiLayar]}>
      {/* ---- Pilih template ---- */}
      <View style={styles.segmen}>
        {(
          [
            { nilai: 'SALDO_LAMA' as const, label: 'Template Saldo Lama' },
            { nilai: 'TRANSAKSI_BARU' as const, label: 'Template Transaksi Baru' },
          ] as const
        ).map((t) => {
          const dipilih = jenisTemplate === t.nilai;
          return (
            <TouchableOpacity
              key={t.nilai}
              style={[styles.segmenItem, dipilih && styles.segmenAktif]}
              onPress={() => {
                setJenisTemplate(t.nilai);
                setAktif('ANGGOTA');
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: dipilih }}
            >
              <Text style={[styles.segmenTeks, dipilih && styles.segmenTeksAktif]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ---- Pengantar ---- */}
      <View style={styles.introCard}>
        <Ionicons name="grid-outline" size={iconSize.md} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.introText}>
            Ini isi template Excel yang akan Anda unduh — <Text style={styles.introTebal}>{sheets.length} sheet data</Text>{' '}
            {jenisTemplate === 'SALDO_LAMA'
              ? 'ditambah sheet Petunjuk, Panduan Kolom, dan Daftar Akun.'
              : 'ditambah sheet Petunjuk.'}{' '}
            Kolom bertanda <Text style={styles.introTebal}>Wajib</Text> harus diisi; sisanya boleh dikosongkan. Di Excel,
            arahkan kursor ke judul kolom untuk membaca catatannya.
          </Text>
          <TouchableOpacity style={styles.tombolPanduan} onPress={() => setPanduanTerbuka(true)} accessibilityRole="button">
            <Ionicons name="play-circle" size={16} color={colors.white} />
            <Text style={styles.tombolPanduanTeks}>Panduan Pengisian (slide)</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ---- Pemilih sheet ---- */}
      <Text style={styles.sectionLabel}>PILIH SHEET</Text>
      <View style={styles.tabWrap}>
        {sheets.map((s, idx) => {
          const dipilih = s.kunci === sheetAktif?.kunci;
          return (
            <TouchableOpacity
              key={s.kunci}
              style={[styles.tab, dipilih && styles.tabAktif]}
              onPress={() => setAktif(s.kunci)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityState={{ selected: dipilih }}
            >
              <View style={[styles.tabNomor, dipilih && styles.tabNomorAktif]}>
                <Text style={[styles.tabNomorText, dipilih && styles.tabNomorTextAktif]}>{idx + 1}</Text>
              </View>
              <Text style={[styles.tabText, dipilih && styles.tabTextAktif]} numberOfLines={2}>
                {s.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {sheetAktif && (
        <>
          {/* ---- Keterangan sheet ---- */}
          <View style={[styles.card, styles.cardSpaced]}>
            <View style={styles.namaSheetRow}>
              <Ionicons name="albums-outline" size={iconSize.sm} color={colors.primary} />
              <Text style={styles.namaSheet}>{sheetAktif.nama}</Text>
            </View>
            <Text style={styles.keteranganSheet}>{sheetAktif.keterangan}</Text>
            <View style={styles.metaRow}>
              <View style={styles.metaPill}>
                <Text style={styles.metaPillText}>{sheetAktif.kolom.length} kolom</Text>
              </View>
              <View style={styles.metaPill}>
                <Text style={styles.metaPillText}>
                  {sheetAktif.kolom.filter((k) => k.wajib).length} wajib
                </Text>
              </View>
            </View>
          </View>

          {/* ---- Pratinjau tabel seperti di Excel ---- */}
          <Text style={styles.sectionLabel}>TAMPILAN DI EXCEL</Text>
          <View style={styles.tabelCard}>
            <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tabelIsi}>
              <View>
                {/* Baris header — teks PERSIS seperti yang ditulis ke Excel. */}
                <View style={styles.tabelBarisHeader}>
                  {sheetAktif.kolom.map((k) => (
                    <View key={k.label} style={[styles.selHeader, lebarSel(k)]}>
                      <Text style={styles.selHeaderText} numberOfLines={2}>
                        {judulKolomExcel(k)}
                      </Text>
                    </View>
                  ))}
                </View>
                {/* Baris contoh — nilai yang benar-benar ada di template. */}
                <View style={styles.tabelBarisContoh}>
                  {sheetAktif.kolom.map((k) => (
                    <View key={k.label} style={[styles.selContoh, lebarSel(k)]}>
                      <Text
                        style={[styles.selContohText, k.contoh === '' && styles.selContohKosong]}
                        numberOfLines={1}
                      >
                        {k.contoh === '' ? '—' : formatContoh(k.contoh)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </ScrollView>
            <View style={styles.tabelKakiRow}>
              <Ionicons name="swap-horizontal-outline" size={12} color={colors.textFaint} />
              <Text style={styles.tabelKaki}>
                Geser ke samping untuk melihat seluruh kolom. Baris berisi “{KODE_CONTOH}” adalah contoh — hapus
                sebelum mengimpor.
              </Text>
            </View>
          </View>

          {/* ---- Rincian kolom ---- */}
          <Text style={styles.sectionLabel}>RINCIAN KOLOM</Text>
          <View style={styles.card}>
            {sheetAktif.kolom.map((k, idx) => (
              <View
                key={k.label}
                style={[styles.kolomRow, idx === sheetAktif.kolom.length - 1 && styles.kolomRowAkhir]}
              >
                <View style={styles.kolomHeadRow}>
                  <Text style={styles.kolomLabel}>{k.label}</Text>
                  <View style={[styles.wajibPill, k.wajib ? styles.wajibPillYa : styles.wajibPillTidak]}>
                    <Text style={[styles.wajibPillText, { color: k.wajib ? colors.danger : colors.textMuted }]}>
                      {k.wajib ? 'Wajib' : 'Opsional'}
                    </Text>
                  </View>
                </View>

                {k.pilihan?.length ? (
                  <View style={styles.pilihanRow}>
                    {k.pilihan.map((p) => (
                      <View key={p} style={styles.pilihanChip}>
                        <Text style={styles.pilihanChipText}>{p}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {k.format ? (
                  <Text style={styles.kolomFormat}>
                    Format: <Text style={styles.kolomMono}>{k.format}</Text>
                  </Text>
                ) : null}

                {k.catatan ? <Text style={styles.kolomCatatan}>{k.catatan}</Text> : null}
              </View>
            ))}
          </View>
        </>
      )}

      {/* ---- Aturan umum ---- */}
      <Text style={styles.sectionLabel}>ATURAN PENGISIAN</Text>
      <View style={styles.card}>
        {ATURAN_UMUM.map((a, idx) => (
          <View key={a.judul} style={[styles.aturanRow, idx === ATURAN_UMUM.length - 1 && styles.aturanRowAkhir]}>
            <Ionicons name="checkmark-circle-outline" size={15} color={colors.primary} style={styles.aturanIkon} />
            <View style={styles.aturanBody}>
              <Text style={styles.aturanJudul}>{a.judul}</Text>
              <Text style={styles.aturanIsi}>{a.isi}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* ---- Aksi ---- */}
      <TouchableOpacity
        style={[styles.tombolUtama, mengunduh && styles.disabled]}
        onPress={unduh}
        disabled={mengunduh}
        accessibilityRole="button"
      >
        {mengunduh ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <>
            <Ionicons name="download-outline" size={iconSize.sm} color={colors.white} />
            <Text style={styles.tombolUtamaText}>
              Unduh {jenisTemplate === 'SALDO_LAMA' ? 'Template Saldo Lama' : 'Template Transaksi Baru'}
            </Text>
          </>
        )}
      </TouchableOpacity>

      <PanduanImportSlide
        visible={panduanTerbuka}
        jenis={jenisTemplate}
        onTutup={() => setPanduanTerbuka(false)}
        onUnduhTemplate={() => {
          setPanduanTerbuka(false);
          void unduh();
        }}
      />
    </ScrollView>
  );
}

/**
 * Lebar sel pratinjau diturunkan dari `lebar` kolom Excel (satuan
 * karakter) supaya proporsi kolom di layar mirip tampilan Excel-nya,
 * dengan batas bawah/atas agar kolom sempit tetap terbaca dan kolom
 * lebar tidak menghabiskan layar.
 */
function lebarSel(k: KolomTemplate): { width: number } {
  return { width: Math.min(190, Math.max(96, k.lebar * 7.5)) };
}

/** Angka pada baris contoh ditampilkan dengan pemisah ribuan, seperti yang dilihat pengguna di Excel. */
function formatContoh(nilai: string | number): string {
  return typeof nilai === 'number' ? nilai.toLocaleString('id-ID') : nilai;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isiLayar: { width: '100%', maxWidth: 920, alignSelf: 'center' },
  sectionLabel: { ...ui.sectionLabel, marginTop: spacing.lg },
  segmen: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 3,
    marginBottom: spacing.md,
  },
  segmenItem: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
  segmenAktif: { backgroundColor: colors.primary },
  segmenTeks: { fontSize: 12.5, fontWeight: '700', color: colors.textMuted },
  segmenTeksAktif: { color: colors.white },
  tombolPanduan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: spacing.sm,
  },
  tombolPanduanTeks: { color: colors.white, fontWeight: '700', fontSize: 12 },

  introCard: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  introText: { flex: 1, fontSize: 12.5, color: colors.text, lineHeight: 18 },
  introTebal: { fontWeight: '800' },

  // ---- Pemilih sheet ----
  tabWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '48%',
    minHeight: 52,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...elevation.card,
  },
  tabAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  tabNomor: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  tabNomorAktif: { backgroundColor: colors.primary },
  tabNomorText: { fontSize: 11, fontWeight: '800', color: colors.textMuted },
  tabNomorTextAktif: { color: colors.white },
  tabText: { flex: 1, fontSize: 11.5, fontWeight: '700', color: colors.textMuted, lineHeight: 15 },
  tabTextAktif: { color: colors.primary },

  // ---- Kartu umum ----
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    ...elevation.card,
  },
  cardSpaced: { marginTop: spacing.md },

  namaSheetRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  namaSheet: { fontSize: 14, fontWeight: '800', color: colors.text },
  keteranganSheet: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.xs },
  metaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  metaPill: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  metaPillText: { fontSize: 10.5, fontWeight: '700', color: colors.textMuted },

  // ---- Pratinjau tabel ----
  tabelCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...elevation.card,
  },
  tabelIsi: { padding: 0 },
  tabelBarisHeader: { flexDirection: 'row', backgroundColor: colors.primaryLight },
  selHeader: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    justifyContent: 'center',
  },
  selHeaderText: { fontSize: 10.5, fontWeight: '800', color: colors.primary, lineHeight: 14 },
  tabelBarisContoh: { flexDirection: 'row', backgroundColor: colors.surface },
  selContoh: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    justifyContent: 'center',
  },
  selContohText: { fontSize: 11, color: colors.text, fontVariant: ['tabular-nums'] },
  selContohKosong: { color: colors.textFaint },
  tabelKakiRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  tabelKaki: { flex: 1, fontSize: 10.5, color: colors.textFaint, lineHeight: 15 },

  // ---- Rincian kolom ----
  kolomRow: {
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 5,
  },
  kolomRowAkhir: { borderBottomWidth: 0, paddingBottom: 0 },
  kolomHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  kolomLabel: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  wajibPill: { borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 2, flexShrink: 0 },
  wajibPillYa: { backgroundColor: colors.dangerBg },
  wajibPillTidak: { backgroundColor: colors.background },
  wajibPillText: { fontSize: 10, fontWeight: '800' },

  pilihanRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pilihanChip: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pilihanChipText: { fontSize: 10.5, fontWeight: '700', color: colors.primary },
  kolomFormat: { fontSize: 11.5, color: colors.textMuted },
  kolomMono: { color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  kolomCatatan: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16 },

  // ---- Aturan ----
  aturanRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  aturanRowAkhir: { borderBottomWidth: 0, paddingBottom: 0 },
  aturanIkon: { marginTop: 1, flexShrink: 0 },
  aturanBody: { flex: 1, minWidth: 0 },
  aturanJudul: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  aturanIsi: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginTop: 1 },

  tombolUtama: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 13,
    marginTop: spacing.lg,
  },
  tombolUtamaText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },
});
