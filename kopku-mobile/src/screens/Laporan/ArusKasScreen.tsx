import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { getDb } from '@/database/db';
import { getArusKas, getArusKasKomparatif, ArusKasResult, ArusKasKomparatif } from '@/reports/FinancialReports';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildArusKasExport, buildArusKasKomparatifExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import EmptyState from '@/components/report/EmptyState';
import ReportRow from '@/components/report/ReportRow';
import ReportSectionCard from '@/components/report/ReportSectionCard';
import {
  susunBagianArusKas,
  CATATAN_PENYAJIAN,
  LABEL_KENAIKAN,
  LABEL_SALDO_AWAL,
  LABEL_SALDO_AKHIR,
} from '@/reports/ArusKasJuklat';

/**
 * Laporan Arus Kas — Operasi/Investasi/Pendanaan + rekonsiliasi.
 * Phase 17 §7: mode "Komparatif" ditambahkan di atas mode tunggal yang
 * sudah ada — data layer MURNI pakai `getArusKasKomparatif()` yang
 * sudah ada sejak Prioritas 13/O (TIDAK ada service baru). Klasifikasi
 * Operasi/Investasi/Pendanaan yang sudah diperbaiki di Phase 6 (fase
 * sebelumnya) otomatis ikut terpakai karena memanggil fungsi yang
 * sama persis — tidak ada logic klasifikasi baru/terpisah di sini.
 */
export default function ArusKasScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [modeKomparatif, setModeKomparatif] = useState(false);
  const [data, setData] = useState<ArusKasResult | null>(null);
  const [dataKomparatif, setDataKomparatif] = useState<ArusKasKomparatif | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(async (mulai: string, selesai: string, komparatif: boolean) => {
    if (!mulai || !selesai) return;
    // §10 — token diambil SEBELUM await apa pun supaya hasil permintaan
    // lama tidak pernah menimpa hasil permintaan yang lebih baru.
    const token = permintaan.mulai();
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      if (komparatif) {
        const periodePembanding = geserPeriodeSetahunKeBelakang({ mulai, selesai });
        const hasil = await getArusKasKomparatif(db, { mulai, selesai }, periodePembanding);
        if (!permintaan.masihTerbaru(token)) return;
        setDataKomparatif(hasil);
        setData(null);
      } else {
        const hasil = await getArusKas(db, mulai, selesai);
        if (!permintaan.masihTerbaru(token)) return;
        setData(hasil);
        setDataKomparatif(null);
      }
    } catch (e) {
      // §12 — kegagalan refresh TIDAK menimpa data valid dengan nol.
      if (!permintaan.masihTerbaru(token)) return;
      setError(e instanceof Error ? e.message : 'Gagal memuat laporan.');
    } finally {
      if (permintaan.masihTerbaru(token)) setLoading(false);
    }
  }, [permintaan]);

  // ============================================================
  // AUTO-REFRESH SAAT LAYAR KEMBALI DIFOKUSKAN (audit §B)
  // ============================================================
  // ROOT CAUSE: `ReportPeriodPicker` memanggil `onChange` HANYA sekali
  // saat mount (useEffect dengan deps `[]`) dan saat pengguna memilih
  // tanggal. Layar ini dulu memuat data DI DALAM `onChangePeriode`,
  // jadi pemuatan terikat pada peristiwa pemilihan tanggal — bukan pada
  // peristiwa navigasi. Native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, sehingga kembali dari mencatat transaksi tidak memicu
  // apa pun dan layar menampilkan hasil perhitungan LAMA sampai aplikasi
  // di-restart.
  //
  // Perbaikannya memakai helper lifecycle yang SUDAH ADA dan sudah
  // terbukti di PosisiKeuanganScreen (`useFocusRefresh` +
  // `usePermintaanTerakhir`) — bukan mekanisme refresh kedua.
  // `onChangePeriode` sekarang HANYA menyimpan periode; SATU lifecycle
  // (`useFocusRefresh`) yang memuat, baik saat filter berubah selagi
  // fokus maupun saat layar difokuskan ulang. Periode & filter terakhir
  // dipertahankan karena disimpan di state layar, bukan dihitung ulang.
  const muat = useCallback(() => {
    if (!periode) return;
    load(periode.mulai, periode.selesai, modeKomparatif);
  }, [load, periode?.mulai, periode?.selesai, modeKomparatif]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1/§A2 — TOMBOL REFRESH MANUAL.
  //
  // Memakai `muat` yang SAMA dengan initial load & focus refresh di
  // atas: satu sumber fungsi load, tidak ada kueri kedua yang dibuat
  // khusus untuk tombol. `loading` layar dipakai sebagai penguncian
  // tap sekaligus indikator — bukan state loading baru.
  useReportRefreshHeader(muat, { loading, testID: 'refresh-arus-kas' });

  const onChangePeriode = (p: ResolvedReportPeriod) => {
    setPeriode(p);
  };

  const toggleKomparatif = (val: boolean) => {
    setModeKomparatif(val);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      {/* RC-S104 — KOP LAPORAN. Pola yang SAMA dengan LHU (RC-S98) dan
          dengan kop PDF hasil export: nama koperasi di atas, judul
          laporan, lalu periode — bukan judul layar dan banner periode
          sebagai dua elemen lepas seperti sebelumnya. */}
      <View style={styles.kop}>
        <Text style={styles.kopKoperasi} numberOfLines={2}>
          {koperasi?.nama ?? '\u2014'}
        </Text>
        <Text style={styles.kopJudul}>Laporan Arus Kas</Text>
        {periode ? <Text style={styles.kopPeriode}>Untuk periode {periode.label}</Text> : null}
        <Text style={styles.kopStandar}>
          Metode langsung \u00b7 Urutan penyajian mengikuti Juklat SOM No. 3/2025
        </Text>
      </View>

      <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

      <View style={styles.modeRow}>
        <TouchableOpacity style={[styles.modeChip, !modeKomparatif && styles.modeChipActive]} onPress={() => toggleKomparatif(false)}>
          <Text style={[styles.modeChipText, !modeKomparatif && styles.modeChipTextActive]}>Tunggal</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modeChip, modeKomparatif && styles.modeChipActive]} onPress={() => toggleKomparatif(true)}>
          <Text style={[styles.modeChipText, modeKomparatif && styles.modeChipTextActive]}>Komparatif</Text>
        </TouchableOpacity>
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 24 }} />}
      {!loading && error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && !modeKomparatif && data && (
        <>
          {data.rincian.length === 0 ? (
            <EmptyState message="Tidak ada mutasi kas/bank pada periode ini." />
          ) : (
            <>
              <ExportButton
                data={
                  koperasi
                    ? buildArusKasExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data)
                    : null
                }
              />
              {/* RC-S104 — SUSUNAN MENGIKUTI CONTOH JUKLAT SOM No. 3/2025
                  (hlm. 73): tiga bagian kegiatan bernomor, masing-masing
                  dengan BARIS RINCIAN bernama lalu "Jumlah arus kas ...",
                  kemudian kenaikan, saldo awal, dan saldo akhir.

                  Sebelumnya layar ini hanya menampilkan TIGA angka total
                  tanpa satu pun rincian, padahal `data.rincian` sudah
                  memuat seluruh mutasi kas — pembaca tidak bisa tahu kas
                  operasinya berasal dari angsuran, simpanan, atau biaya.

                  Penamaan & pengurutan barisnya ada di modul murni
                  `ArusKasJuklat.susunBagianArusKas()`; layar ini TIDAK
                  menghitung apa pun. `getArusKas()` tidak disentuh. */}
              {susunBagianArusKas(data.rincian).map((bagian) => (
                <ReportSectionCard key={bagian.bagian} title={bagian.judul} nomor={bagian.nomor}>
                  {bagian.baris.length === 0 ? (
                    <Text style={styles.barisKosong}>Tidak ada mutasi kas pada kegiatan ini.</Text>
                  ) : (
                    bagian.baris.map((b) => (
                      <ReportRow key={b.label} label={b.label} value={b.jumlah} indent />
                    ))
                  )}
                  <ReportRow label={bagian.labelJumlah} value={bagian.jumlah} variant="subtotal" />
                </ReportSectionCard>
              ))}

              {/* Penutup laporan — tiga baris terakhir pada contoh naskah. */}
              <View style={styles.penutup}>
                <View style={styles.bandRow}>
                  <Text style={styles.bandLabel}>{LABEL_KENAIKAN}</Text>
                  <Text
                    style={[styles.bandValue, data.perubahanKas < 0 && styles.bandValueNegatif]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    {formatRupiah(data.perubahanKas)}
                  </Text>
                </View>
                <Text style={styles.bandRumus}>
                  Jumlah arus kas operasi + investasi + pendanaan
                </Text>
              </View>

              <ReportSectionCard title="Rekonsiliasi Saldo Kas">
                <ReportRow label={LABEL_SALDO_AWAL} value={data.kasAwal} indent />
                <ReportRow label={LABEL_KENAIKAN} value={data.perubahanKas} indent />
                <ReportRow label={LABEL_SALDO_AKHIR} value={data.kasAkhirDihitung} variant="subtotal" />
                <ReportRow
                  label="Saldo kas dan bank aktual pada akhir periode"
                  value={data.kasAkhirAktual}
                  variant="total"
                />
              </ReportSectionCard>

              <View style={[styles.validationBanner, data.terekonsiliasi ? styles.validationOk : styles.validationWarn]}>
                <Text style={styles.validationText}>
                  {data.terekonsiliasi ? <Ionicons name="checkmark-circle-outline" size={iconSize.sm} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={iconSize.sm} color={colors.danger} />}{' '}{data.terekonsiliasi
                    ? 'Kas akhir sesuai dengan saldo kas/bank aktual'
                    : `Selisih rekonsiliasi ${formatRupiah(Math.abs(data.selisihRekonsiliasi))} — perlu ditelusuri`}
                </Text>
              </View>

              {/* RC-S104 — CATATAN PENYAJIAN. Memuat dua tempat di mana
                  penyajian ini berbeda dari contoh naskah beserta
                  alasannya. Ditampilkan, bukan didiamkan: pembaca
                  laporan berhak tahu dasar penempatan tiap pos. */}
              <View style={styles.catatanCard}>
                <Text style={styles.catatanJudul}>Catatan Penyajian</Text>
                {CATATAN_PENYAJIAN.map((c, i) => (
                  <View key={i} style={styles.catatanBaris}>
                    <Text style={styles.catatanBullet}>{i + 1}.</Text>
                    <Text style={styles.catatanTeks}>{c}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </>
      )}

      {!loading && !error && modeKomparatif && dataKomparatif && (
        <>
          {dataKomparatif.peringatanPeriode && (
            <View style={styles.warnBanner}>
              <Text style={styles.warnBannerText}><Ionicons name="warning-outline" size={iconSize.sm} color={colors.warning} /> {dataKomparatif.peringatanPeriode}</Text>
            </View>
          )}

          <ExportButton
            data={
              koperasi
                ? buildArusKasKomparatifExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, dataKomparatif)
                : null
            }
          />

          <Text style={styles.komparatifSubtitle}>LAPORAN ARUS KAS — KOMPARATIF</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, { flex: 2 }]}>Aktivitas</Text>
            <Text style={[styles.th, styles.numCol]}>Periode Berjalan</Text>
            <Text style={[styles.th, styles.numCol]}>Periode Komparatif</Text>
          </View>

          {/* RC-S49 — urutan & istilah disamakan dengan mode tunggal di
              atas: aktivitas dulu, lalu kenaikan/penurunan neto kas,
              baru kas awal & kas akhir. Pasangan nilai
              sekarang/pembanding untuk setiap baris TIDAK berubah. */}
          <KomparatifRow label="Kas Neto dari Aktivitas Operasi" sekarang={dataKomparatif.sekarang.operasi} pembanding={dataKomparatif.pembanding.operasi} />
          <KomparatifRow label="Kas Neto dari Aktivitas Investasi" sekarang={dataKomparatif.sekarang.investasi} pembanding={dataKomparatif.pembanding.investasi} />
          <KomparatifRow label="Kas Neto dari Aktivitas Pendanaan" sekarang={dataKomparatif.sekarang.pendanaan} pembanding={dataKomparatif.pembanding.pendanaan} />
          <KomparatifRow
            label="Kenaikan (Penurunan) Neto Kas"
            sekarang={dataKomparatif.sekarang.perubahanKas}
            pembanding={dataKomparatif.pembanding.perubahanKas}
          />
          <KomparatifRow
            label="Kas dan Setara Kas Awal Periode"
            sekarang={dataKomparatif.sekarang.kasAwal}
            pembanding={dataKomparatif.pembanding.kasAwal}
          />
          <KomparatifRow
            bold
            label="Kas dan Setara Kas Akhir Periode"
            sekarang={dataKomparatif.sekarang.kasAkhirAktual}
            pembanding={dataKomparatif.pembanding.kasAkhirAktual}
          />

          {/* Validasi independen KEDUA periode (§7: "Untuk kedua periode
              secara independen") — bukan cuma periode berjalan. */}
          <View style={[styles.validationBanner, dataKomparatif.sekarang.terekonsiliasi ? styles.validationOk : styles.validationWarn]}>
            <Text style={styles.validationText}>
              {dataKomparatif.sekarang.terekonsiliasi ? <Ionicons name="checkmark-circle-outline" size={iconSize.sm} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={iconSize.sm} color={colors.danger} />}{' '}{dataKomparatif.sekarang.terekonsiliasi
                ? 'Periode berjalan: kas akhir sesuai saldo aktual'
                : `Periode berjalan: selisih ${formatRupiah(Math.abs(dataKomparatif.sekarang.selisihRekonsiliasi))}`}
            </Text>
          </View>
          <View style={[styles.validationBanner, dataKomparatif.pembanding.terekonsiliasi ? styles.validationOk : styles.validationWarn]}>
            <Text style={styles.validationText}>
              {dataKomparatif.pembanding.terekonsiliasi ? <Ionicons name="checkmark-circle-outline" size={iconSize.sm} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={iconSize.sm} color={colors.danger} />}{' '}{dataKomparatif.pembanding.terekonsiliasi
                ? 'Periode komparatif: kas akhir sesuai saldo aktual'
                : `Periode komparatif: selisih ${formatRupiah(Math.abs(dataKomparatif.pembanding.selisihRekonsiliasi))}`}
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{formatRupiah(value)}</Text>
    </View>
  );
}

function KomparatifRow({ label, sekarang, pembanding, bold }: { label: string; sekarang: number; pembanding: number; bold?: boolean }) {
  return (
    <View style={styles.tr}>
      <Text style={[styles.rowNama, { flex: 2 }, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.numCol, bold && styles.bold]}>{formatRupiah(sekarang)}</Text>
      <Text style={[styles.numCol, bold && styles.bold]}>{formatRupiah(pembanding)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // RC-S104 — KOP LAPORAN (menggantikan title + periodeBanner yang lepas).
  // Gaya SAMA PERSIS dengan kop LHU supaya kedua laporan terbaca sebagai
  // satu keluarga dokumen.
  kop: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    borderTopColor: colors.primary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  kopKoperasi: { fontSize: 15, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  kopJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 2, textAlign: 'center' },
  kopPeriode: { fontSize: 12, color: colors.textMuted, marginTop: 2, textAlign: 'center' },
  kopStandar: { fontSize: 10, color: colors.textFaint, marginTop: spacing.xs, textAlign: 'center' },

  barisKosong: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: spacing.xs },

  // Band penutup "Kenaikan (penurunan) kas" — pola BandTotal di LHU.
  penutup: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  bandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  bandLabel: { flex: 1, flexShrink: 1, fontSize: 12, fontWeight: '800', color: colors.white },
  bandValue: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.white,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  bandValueNegatif: { color: '#FFD9D9' },
  bandRumus: { fontSize: 10, color: '#DDEEDD', marginTop: 2 },

  catatanCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  catatanJudul: { fontSize: 12, fontWeight: '800', color: colors.text, marginBottom: spacing.xs },
  catatanBaris: { flexDirection: 'row', gap: spacing.xs, marginTop: 4 },
  catatanBullet: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  catatanTeks: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  modeChip: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  modeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeChipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  modeChipTextActive: { color: colors.white },
  komparatifSubtitle: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 8, marginBottom: 4 },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 24 },
  warnBanner: { backgroundColor: '#FFF3E0', borderRadius: 8, padding: 10, marginBottom: 12 },
  warnBannerText: { fontSize: 12, color: '#8A5300' },
  section: { marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 8, marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: spacing.sm, alignItems: 'flex-start' },
  rowLabel: { fontSize: 13, color: colors.text, flex: 1 },
  rowValue: { fontSize: 13, color: colors.text, textAlign: 'right', fontVariant: ['tabular-nums'], flexShrink: 1 },
  bold: { fontWeight: '700' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  tableHeader: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: colors.border },
  th: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  numCol: { flex: 1, textAlign: 'right', fontSize: 11, color: colors.text },
  tr: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  rowNama: { fontSize: 12, color: colors.text, flexShrink: 1 },
  validationBanner: { borderRadius: 8, padding: 12, marginTop: 10 },
  validationOk: { backgroundColor: '#E8F5E9' },
  validationWarn: { backgroundColor: '#FFEBEE' },
  validationText: { fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'center' },
});
