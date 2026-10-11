import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { getDb } from '@/database/db';
import {
  getPerubahanEkuitas,
  getPerubahanEkuitasKomparatif,
  getPosisiKeuangan,
  PerubahanEkuitasResult,
  PerubahanEkuitasKomparatif,
} from '@/reports/FinancialReports';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildPerubahanEkuitasExport, buildPerubahanEkuitasKomparatifExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import EmptyState from '@/components/report/EmptyState';
import TabelGeser, { SelNilai, lebarTabel, tabelUi } from '@/components/report/TabelGeser';

/**
 * Laporan Perubahan Ekuitas/Modal. Phase 17 §6: mode "Komparatif"
 * ditambahkan di atas mode tunggal yang sudah ada — data layer MURNI
 * pakai `getPerubahanEkuitasKomparatif()` yang sudah ada sejak
 * Prioritas 13/O (TIDAK ada service baru dibuat di sini). Default
 * periode pembanding = periode berjalan digeser TEPAT setahun ke
 * belakang (§5 — YTD tetap YTD, bukan dipaksa full-year), lewat
 * `geserPeriodeSetahunKeBelakang()`.
 */
export default function PerubahanEkuitasScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [modeKomparatif, setModeKomparatif] = useState(false);

  const [data, setData] = useState<PerubahanEkuitasResult | null>(null);
  const [dataKomparatif, setDataKomparatif] = useState<PerubahanEkuitasKomparatif | null>(null);
  // Rekonsiliasi eksplisit terhadap Posisi Keuangan (§ "VALIDASI
  // PERUBAHAN EKUITAS") — dihitung & ditampilkan APA ADANYA, tidak
  // pernah disembunyikan walau seharusnya selalu 0 (lihat Prioritas
  // 4/F: getPerubahanEkuitas sudah dijamin sama dengan getPosisiKeuangan
  // secara konstruksi — ini pengecekan langsung/live, bukan asumsi buta).
  const [selisihSekarang, setSelisihSekarang] = useState<number | null>(null);
  const [selisihPembanding, setSelisihPembanding] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(async (mulai: string, selesai: string, komparatif: boolean) => {
    if (!mulai || !selesai) return;
    // §10 — token diambil SEBELUM await apa pun.
    const token = permintaan.mulai();
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      if (komparatif) {
        const periodePembanding = geserPeriodeSetahunKeBelakang({ mulai, selesai });
        const [hasil, posisiSekarang, posisiPembanding] = await Promise.all([
          getPerubahanEkuitasKomparatif(db, { mulai, selesai }, periodePembanding),
          getPosisiKeuangan(db, selesai),
          getPosisiKeuangan(db, periodePembanding.selesai),
        ]);
        if (!permintaan.masihTerbaru(token)) return;
        setDataKomparatif(hasil);
        setSelisihSekarang(hasil.sekarang.totalSaldoAkhir - posisiSekarang.totalEkuitas);
        setSelisihPembanding(hasil.pembanding.totalSaldoAkhir - posisiPembanding.totalEkuitas);
        setData(null);
      } else {
        const [hasil, posisi] = await Promise.all([getPerubahanEkuitas(db, mulai, selesai), getPosisiKeuangan(db, selesai)]);
        if (!permintaan.masihTerbaru(token)) return;
        setData(hasil);
        setSelisihSekarang(hasil.totalSaldoAkhir - posisi.totalEkuitas);
        setSelisihPembanding(null);
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
  // saat mount (useEffect deps `[]`) dan saat pengguna memilih tanggal.
  // Layar ini dulu memuat data DI DALAM `onChangePeriode`, jadi
  // pemuatan terikat pada peristiwa pemilihan tanggal — bukan pada
  // peristiwa navigasi. Native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, sehingga kembali dari mencatat transaksi tidak
  // memicu apa pun dan layar menampilkan hasil perhitungan LAMA.
  //
  // Memakai helper lifecycle yang SUDAH ADA & terbukti di
  // PosisiKeuanganScreen (`useFocusRefresh` + `usePermintaanTerakhir`),
  // bukan mekanisme refresh kedua. `onChangePeriode` sekarang HANYA
  // menyimpan periode; SATU lifecycle yang memuat — baik saat filter
  // berubah selagi fokus maupun saat layar difokuskan ulang.
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
  useReportRefreshHeader(muat, { loading, testID: 'refresh-perubahan-ekuitas' });

  const onChangePeriode = (p: ResolvedReportPeriod) => {
    setPeriode(p);
  };

  const toggleKomparatif = (val: boolean) => {
    setModeKomparatif(val);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
      <View style={styles.kop}>
        <Text style={styles.title}>Laporan Perubahan Ekuitas</Text>
        {koperasi?.nama ? <Text style={styles.sub}>{koperasi.nama}</Text> : null}
        {periode && (
          <View style={styles.periodeBanner}>
            <Text style={styles.periodeBannerLabel}>Untuk Periode</Text>
            <Text style={styles.periodeBannerValue}>{periode.label}</Text>
            {modeKomparatif ? <Text style={styles.periodeBanding}>dibandingkan dengan periode yang sama tahun sebelumnya</Text> : null}
          </View>
        )}
      </View>

      <View style={styles.pengaturan}>
        <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

        <Text style={styles.label}>Mode Tampilan</Text>
        <View style={styles.modeRow}>
          <TouchableOpacity
            accessibilityRole="radio"
            accessibilityState={{ selected: !modeKomparatif }}
            style={[styles.modeChip, !modeKomparatif && styles.modeChipActive]}
            onPress={() => toggleKomparatif(false)}
          >
            <Ionicons name="document-outline" size={16} color={!modeKomparatif ? colors.white : colors.primary} />
            <Text style={[styles.modeChipText, !modeKomparatif && styles.modeChipTextActive]}>Tunggal</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="radio"
            accessibilityState={{ selected: modeKomparatif }}
            style={[styles.modeChip, modeKomparatif && styles.modeChipActive]}
            onPress={() => toggleKomparatif(true)}
          >
            <Ionicons name="git-compare-outline" size={16} color={modeKomparatif ? colors.white : colors.primary} />
            <Text style={[styles.modeChipText, modeKomparatif && styles.modeChipTextActive]}>Komparatif</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {!loading && error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && !modeKomparatif && data && (
        <>
          {data.rows.length === 0 && data.hasilUsahaPeriode === 0 ? (
            <EmptyState message="Tidak ada mutasi ekuitas pada periode ini." />
          ) : (
            <>
              <ExportButton
                data={
                  koperasi
                    ? buildPerubahanEkuitasExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data)
                    : null
                }
              />
              <TabelGeser lebarMinimum={lebarTabel(3)}>
                <View style={tabelUi.header}>
                  <Text style={[tabelUi.th, tabelUi.kolomAkun]}>Akun</Text>
                  <Text style={[tabelUi.th, tabelUi.thNilai]}>Saldo Awal</Text>
                  <Text style={[tabelUi.th, tabelUi.thNilai]}>Mutasi</Text>
                  <Text style={[tabelUi.th, tabelUi.thNilai]}>Saldo Akhir</Text>
                </View>
                {data.rows.map((r, idx) => (
                  <View key={r.kode} style={[tabelUi.baris, idx % 2 === 1 && tabelUi.barisGenap]}>
                    <Text style={[tabelUi.label, tabelUi.kolomAkun]}>
                      {r.nama}
                      {/* RC-S133.6.1 — distribusi SHU ditampilkan sebagai mutasi yang sesuai. */}
                      {r.mutasiDistribusiShu ? <Text style={styles.subLabel}>{`\ntermasuk distribusi SHU ${formatRupiah(r.mutasiDistribusiShu)}`}</Text> : null}
                    </Text>
                    <SelNilai style={r.saldoAwal < 0 && tabelUi.nilaiNegatif}>{formatRupiah(r.saldoAwal)}</SelNilai>
                    <SelNilai style={r.mutasi < 0 && tabelUi.nilaiNegatif}>{formatRupiah(r.mutasi)}</SelNilai>
                    <SelNilai style={[tabelUi.nilaiTebal, r.saldoAkhir < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(r.saldoAkhir)}</SelNilai>
                  </View>
                ))}
                {/* RC-S133.6 (AUDIT F-4) — baris SHU kini punya saldo awal (sisa
                    hasil usaha belum dibagikan per H-1), sehingga saldo awal
                    tahun ini = ekuitas akhir tahun lalu. */}
                <View style={[tabelUi.baris, data.rows.length % 2 === 1 && tabelUi.barisGenap]}>
                  <Text style={[tabelUi.label, tabelUi.kolomAkun]}>{data.hasilUsahaPeriodeLabel}</Text>
                  {(data.saldoAwalHasilUsaha ?? 0) === 0 ? (
                    <SelNilai style={tabelUi.nilaiRedup}>-</SelNilai>
                  ) : (
                    <SelNilai style={(data.saldoAwalHasilUsaha ?? 0) < 0 && tabelUi.nilaiNegatif}>{formatRupiah(data.saldoAwalHasilUsaha ?? 0)}</SelNilai>
                  )}
                  <SelNilai style={data.hasilUsahaPeriode - (data.saldoAwalHasilUsaha ?? 0) < 0 && tabelUi.nilaiNegatif}>
                    {formatRupiah(data.hasilUsahaPeriode - (data.saldoAwalHasilUsaha ?? 0))}
                  </SelNilai>
                  <SelNilai style={[tabelUi.nilaiTebal, data.hasilUsahaPeriode < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(data.hasilUsahaPeriode)}</SelNilai>
                </View>
                {/* RC-S133.6.1 — rincian baris SHU/hasil usaha (jumlahnya = baris di atas, tidak dijumlah lagi):
                    SHU tahun buku sebelumnya dikurangi distribusi, dan hasil usaha periode = Laporan Hasil Usaha. */}
                {(data.rincianHasilUsaha ?? []).map((r) => (
                  <View key={r.kunci} style={[tabelUi.baris, styles.barisRincian]} testID={`rincian-shu-${r.kunci}`}>
                    <Text style={[tabelUi.label, tabelUi.kolomAkun, styles.labelRincian]}>{`• ${r.nama}`}</Text>
                    {r.saldoAwal === 0 ? (
                      <SelNilai style={tabelUi.nilaiRedup}>-</SelNilai>
                    ) : (
                      <SelNilai style={[styles.nilaiRincian, r.saldoAwal < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(r.saldoAwal)}</SelNilai>
                    )}
                    <SelNilai style={[styles.nilaiRincian, r.mutasi < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(r.mutasi)}</SelNilai>
                    <SelNilai style={[styles.nilaiRincian, r.saldoAkhir < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(r.saldoAkhir)}</SelNilai>
                  </View>
                ))}

                <View style={tabelUi.total}>
                  <Text style={[tabelUi.labelTebal, tabelUi.kolomAkun]}>Total</Text>
                  <SelNilai style={tabelUi.nilaiTebal}>{formatRupiah(data.totalSaldoAwal)}</SelNilai>
                  <SelNilai style={tabelUi.nilaiTebal}>{formatRupiah(data.totalSaldoAkhir - data.totalSaldoAwal)}</SelNilai>
                  <SelNilai style={tabelUi.nilaiUtama}>{formatRupiah(data.totalSaldoAkhir)}</SelNilai>
                </View>
              </TabelGeser>

              {data.hasilUsahaPeriodeBerjalan !== undefined &&
                ((data.saldoAwalHasilUsaha ?? 0) !== 0 || (data.shuDibagikanPeriode ?? 0) !== 0) && (
                  <Text style={styles.catatanShu} testID="rincian-mutasi-shu">
                    Mutasi SHU/hasil usaha: hasil usaha periode ini {formatRupiah(data.hasilUsahaPeriodeBerjalan)}
                    {(data.shuDibagikanPeriode ?? 0) !== 0 ? `, SHU dibagikan ${formatRupiah(-(data.shuDibagikanPeriode ?? 0))}` : ''}.
                    {(data.shuDibagikanPeriode ?? 0) !== 0 && data.distribusiShuKeEkuitas !== undefined
                      ? ` Dari SHU yang dibagikan, ${formatRupiah(data.distribusiShuKeEkuitas)} tetap di ekuitas (Cadangan) dan ${formatRupiah(
                          data.distribusiShuKeLuarEkuitas ?? 0
                        )} keluar dari ekuitas ke dana-dana dan simpanan anggota.`
                      : ''}
                    {` Di Posisi Keuangan, rincian di atas tersaji sebagai satu baris "${data.hasilUsahaPeriodeLabel}" ${formatRupiah(data.hasilUsahaPeriode)}.`}
                  </Text>
                )}

              <RekonsiliasiBanner selisih={selisihSekarang} label="Rekonsiliasi ke Posisi Keuangan" />
            </>
          )}
        </>
      )}

      {!loading && !error && modeKomparatif && dataKomparatif && (
        <>
          {dataKomparatif.peringatanPeriode && (
            <View style={styles.warnBanner}>
              <Ionicons name="warning-outline" size={iconSize.sm} color={colors.warning} />
              <Text style={styles.warnBannerText}>{dataKomparatif.peringatanPeriode}</Text>
            </View>
          )}

          <ExportButton
            data={
              koperasi
                ? buildPerubahanEkuitasKomparatifExport(
                    { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                    dataKomparatif
                  )
                : null
            }
          />

          <TabelGeser lebarMinimum={lebarTabel(2)}>
            <View style={tabelUi.header}>
              <Text style={[tabelUi.th, tabelUi.kolomAkun]}>Komponen</Text>
              <Text style={[tabelUi.th, tabelUi.thNilai]}>Periode Berjalan</Text>
              <Text style={[tabelUi.th, tabelUi.thNilai]}>Periode Komparatif</Text>
            </View>

            <KomparatifRow label="Saldo Awal" sekarang={dataKomparatif.sekarang.totalSaldoAwal} pembanding={dataKomparatif.pembanding.totalSaldoAwal} />
            {gabungkanRowsUntukKomparasi(dataKomparatif).map((r, idx) => (
              <KomparatifRow key={r.kode} label={r.nama} sekarang={r.sekarang} pembanding={r.pembanding} genap={idx % 2 === 0} />
            ))}
            <KomparatifRow
              label={dataKomparatif.sekarang.hasilUsahaPeriodeLabel}
              sekarang={dataKomparatif.sekarang.hasilUsahaPeriode}
              pembanding={dataKomparatif.pembanding.hasilUsahaPeriode}
            />
            {/* RC-S133.6.1 — rincian saldo akhir baris SHU/hasil usaha per periode. */}
            {gabungkanRincianShu(dataKomparatif).map((r) => (
              <KomparatifRow key={r.kunci} label={`   • ${r.nama}`} sekarang={r.sekarang} pembanding={r.pembanding} />
            ))}
            <KomparatifRow bold label="Saldo Akhir" sekarang={dataKomparatif.sekarang.totalSaldoAkhir} pembanding={dataKomparatif.pembanding.totalSaldoAkhir} />
          </TabelGeser>

          <RekonsiliasiBanner selisih={selisihSekarang} label="Rekonsiliasi Periode Berjalan ke Posisi Keuangan" />
          <RekonsiliasiBanner selisih={selisihPembanding} label="Rekonsiliasi Periode Komparatif ke Posisi Keuangan" />
        </>
      )}
    </ScrollView>
  );
}

/**
 * Komponen ekuitas (Simpanan Pokok, Simpanan Wajib, Cadangan, Ekuitas
 * Lainnya, dst) di kedua periode TIDAK SELALU akun yang persis sama
 * (mis. akun baru yang baru dipakai tahun ini) — digabung berdasar
 * `kode` akun (union kedua sisi), nilai 0 kalau tidak ada di satu sisi.
 * Hanya komponen yang BENAR-BENAR ADA di salah satu periode yang
 * ditampilkan (§6: "Hanya tampilkan komponen yang benar-benar ada
 * dalam model existing. Jangan membuat angka.").
 */
/** RC-S133.6.1 — rincian baris SHU kedua periode, digabung per kunci (saldo akhir). */
function gabungkanRincianShu(data: PerubahanEkuitasKomparatif): { kunci: string; nama: string; sekarang: number; pembanding: number }[] {
  const a = data.sekarang.rincianHasilUsaha ?? [];
  const b = data.pembanding.rincianHasilUsaha ?? [];
  if (a.length === 0 && b.length === 0) return [];
  const kunci = [...new Set([...a, ...b].map((r) => r.kunci))];
  return kunci.map((k) => {
    const x = a.find((r) => r.kunci === k);
    const y = b.find((r) => r.kunci === k);
    return { kunci: k, nama: (x ?? y)!.nama, sekarang: x?.saldoAkhir ?? 0, pembanding: y?.saldoAkhir ?? 0 };
  });
}

function gabungkanRowsUntukKomparasi(data: PerubahanEkuitasKomparatif): { kode: string; nama: string; sekarang: number; pembanding: number }[] {
  const map = new Map<string, { nama: string; sekarang: number; pembanding: number }>();
  for (const r of data.sekarang.rows) map.set(r.kode, { nama: r.nama, sekarang: r.saldoAkhir, pembanding: 0 });
  for (const r of data.pembanding.rows) {
    const existing = map.get(r.kode);
    if (existing) existing.pembanding = r.saldoAkhir;
    else map.set(r.kode, { nama: r.nama, sekarang: 0, pembanding: r.saldoAkhir });
  }
  return Array.from(map.entries()).map(([kode, v]) => ({ kode, ...v }));
}

function KomparatifRow({
  label,
  sekarang,
  pembanding,
  bold,
  genap,
}: {
  label: string;
  sekarang: number;
  pembanding: number;
  bold?: boolean;
  genap?: boolean;
}) {
  return (
    <View style={bold ? tabelUi.total : [tabelUi.baris, genap && tabelUi.barisGenap]}>
      <Text style={[bold ? tabelUi.labelTebal : tabelUi.label, tabelUi.kolomAkun]}>{label}</Text>
      <SelNilai style={[bold && tabelUi.nilaiUtama, sekarang < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(sekarang)}</SelNilai>
      <SelNilai style={[bold && tabelUi.nilaiTebal, pembanding < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(pembanding)}</SelNilai>
    </View>
  );
}

function RekonsiliasiBanner({ selisih, label }: { selisih: number | null; label: string }) {
  if (selisih === null) return null;
  const sesuai = selisih === 0;
  return (
    <View style={[styles.validationBanner, sesuai ? styles.validationOk : styles.validationWarn]}>
      {sesuai ? <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />}
      <Text style={styles.validationText}>
        {sesuai ? `${label}: sesuai` : `Selisih Rekonsiliasi Ekuitas (${label}): ${formatRupiah(Math.abs(selisih))}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: { marginBottom: spacing.md },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  periodeBanner: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, alignItems: 'center' },
  periodeBannerLabel: { fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700' },
  periodeBannerValue: { fontSize: 16, fontWeight: '700', color: colors.primary, marginTop: 2, textAlign: 'center' },
  periodeBanding: { fontSize: 12, color: colors.textMuted, marginTop: 2, textAlign: 'center' },
  pengaturan: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  label: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginTop: spacing.md, marginBottom: spacing.xs, letterSpacing: 0.3, textTransform: 'uppercase' },
  modeRow: { flexDirection: 'row', gap: spacing.sm },
  modeChip: { flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: 11, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  modeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeChipText: { fontSize: 13, color: colors.text, fontWeight: '700' },
  modeChipTextActive: { color: colors.white },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  catatanShu: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 18 },
  subLabel: { fontSize: 11, color: colors.textMuted },
  barisRincian: { backgroundColor: colors.surface },
  labelRincian: { paddingLeft: spacing.md, fontSize: 12, color: colors.textMuted },
  nilaiRincian: { fontSize: 12, color: colors.textMuted },
  warnBanner: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.sm },
  warnBannerText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  validationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
  },
  validationOk: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  validationWarn: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  validationText: { flexShrink: 1, fontSize: 12.5, fontWeight: '700', color: colors.text, textAlign: 'center' },
});
