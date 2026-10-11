import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { getDb } from '@/database/db';
import { getLHU, getLHUKomparatif, getInformasiShuRAT, LhuResult, LhuRow, LhuKomparatif, InformasiShuRatResult } from '@/reports/FinancialReports';
import { getShuKonfigurasiByTahun, ShuKonfigurasiRow } from '@/services/ShuService';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { tungguTugasStartupSelesai } from '@/services/StartupTasks';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import ReportRow from '@/components/report/ReportRow';
import ReportSectionCard from '@/components/report/ReportSectionCard';
import SummaryCard from '@/components/report/SummaryCard';
import EmptyState from '@/components/report/EmptyState';
import { formatRupiah, formatRupiahPengurang, formatPersentasePerubahan } from '@/utils/money';
import { hitungKomposisiPendapatanLhu, formatPersenKomposisi } from '@/reports/KomposisiPendapatanLhu';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';
import { useAppStore } from '@/store/useAppStore';
import { ACCOUNTING_POLICY } from '@/config/defaultCOA';
import { LABEL_KELOMPOK_OCI } from '@/config/ociPolicy';
import { buildLHUExport, buildLHUKomparatifExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import { colors, radius, spacing, iconSize } from '@/theme/colors';

/**
 * LHU — Laporan Hasil Usaha (Revisi LHU KOPKU + Revisi UI/UX). Struktur
 * FINAL sesuai Bagian A (sesi Revisi LHU): PARTISIPASI ANGGOTA -> BEBAN
 * USAHA -> SHU BRUTO -> HASIL INVESTASI -> PENDAPATAN DAN BEBAN LAIN ->
 * SHU SEBELUM PAJAK -> Beban Pajak Penghasilan -> SHU NETO.
 *
 * RC-S88 — setelah SHU Neto laporan dilanjutkan PENGHASILAN KOMPREHENSIF
 * LAIN (OCI, dua kelompok SAK EP) dan TOTAL PENGHASILAN KOMPREHENSIF.
 * OCI dibaca dari getLHU() (sumber: revaluasi aset tetap) dan TIDAK
 * mengubah SHU Neto — SHU tetap angka yang dibagikan kepada anggota.
 *
 * RC-S98 (permintaan pengguna: "urutan laporanya sesuai dengan SAK EP
 * atau Juklat") — URUTAN SEKSI sekarang dicocokkan baris-demi-baris
 * dengan Lampiran "CONTOH PERHITUNGAN HASIL USAHA UNTUK KSP" pada
 * Juklat SOM No. 3/2025:
 *
 *   I    PARTISIPASI ANGGOTA        -> Jumlah partisipasi anggota
 *   II   BEBAN USAHA                -> Jumlah beban usaha
 *        = SISA HASIL USAHA BRUTO
 *   III  HASIL INVESTASI
 *   IV   BEBAN PERKOPERASIAN        <- BARU: baris baku, dulu ikut Beban Usaha
 *   V    PENDAPATAN & BEBAN LAIN
 *        = SISA HASIL USAHA SEBELUM PAJAK
 *        Beban pajak penghasilan
 *        = SISA HASIL USAHA (NETO)
 *        Penghasilan komprehensif lain
 *        = PENGHASILAN KOMPREHENSIF
 *
 * Penyajian mengikuti naskah juga dalam hal TANDA: setiap beban ditulis
 * di dalam tanda kurung (`ReportRow pengurang`), sehingga kolom nominal
 * benar-benar bisa dijumlahkan dari atas ke bawah oleh pembaca.
 *
 * Revisi UI/UX sesi ini: HANYA tampilan — `getLHU()`/rumus/data TIDAK
 * disentuh. Perbaikan: hierarchy visual (SectionHeader/ReportRow REUSE
 * lintas laporan), SHU Neto sebagai focal point (SummaryCard), nominal
 * besar dijamin tidak terpotong (ReportRow: label flexShrink, nominal
 * flexShrink:0 rata kanan), empty state jelas, dan (§8) info tambahan
 * "SHU setelah pembagian" kalau SHU tahun buku terkait SUDAH DIBAGIKAN
 * (murni informasi tambahan, TIDAK mengubah baris "SISA HASIL USAHA
 * NETO" itu sendiri).
 */
export default function LabaRugiScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [data, setData] = useState<LhuResult | null>(null);
  const [shuKonfigurasi, setShuKonfigurasi] = useState<ShuKonfigurasiRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PHASE 6 §D/§F/§P (permintaan pengguna): mode Komparatif + SHU
  // Akrual vs Basis Kas — KEDUANYA murni memanggil fungsi
  // FinancialReports yang SUDAH ADA (getLHUKomparatif,
  // getInformasiShuRAT), TIDAK ADA logic akuntansi baru di layar ini.
  const [komparatif, setKomparatif] = useState(false);
  const [periodePembanding, setPeriodePembanding] = useState<ResolvedReportPeriod | null>(null);
  const [dataKomparatif, setDataKomparatif] = useState<LhuKomparatif | null>(null);
  const [shuRat, setShuRat] = useState<InformasiShuRatResult | null>(null);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(
    async (mulai: string, selesai: string, isKomparatif: boolean, pembandingMulai?: string, pembandingSelesai?: string) => {
      if (!mulai || !selesai) return;
      // §10 — token diambil SEBELUM await apa pun.
      const token = permintaan.mulai();
      setLoading(true);
      setError(null);
      try {
        // RC-S94 — tunggu pekerjaan latar yang MENULIS jurnal (akrual jasa,
        // pelepasan jasa diterima di muka, penyusutan, EIR, dst.) selesai
        // SEBELUM menghitung LHU. Pola yang SAMA PERSIS dengan
        // PosisiKeuanganScreen. Tanpa ini, LHU yang dibuka tepat setelah
        // login atau setelah "hari ini" diganti di menu Developer bisa
        // membaca buku besar sebelum pendapatan periode yang baru jatuh
        // tempo selesai diakui. Bila tidak ada pekerjaan yang berjalan
        // (kasus umum), gate ini resolve seketika tanpa menambah latensi.
        await tungguTugasStartupSelesai();
        const db = await getDb();
        const [result, konfigurasi, informasiShuRat] = await Promise.all([
          getLHU(db, mulai, selesai),
          // Bagian 8 (Revisi UI/UX): info tambahan "sudah dibagikan"
          // kalau ada — tahunBuku diturunkan dari akhir periode (murni
          // untuk MENCARI konfigurasi SHU yang sudah ada, tidak
          // memengaruhi angka LHU sama sekali).
          getShuKonfigurasiByTahun(Number(selesai.slice(0, 4))),
          // §F/§G/§H/§I: SHU Akrual vs Basis Kas — section terpisah,
          // TIDAK memengaruhi angka LHU di atas sama sekali.
          getInformasiShuRAT(db, mulai, selesai),
        ]);
        if (!permintaan.masihTerbaru(token)) return;
        setData(result);
        setShuKonfigurasi(konfigurasi);
        setShuRat(informasiShuRat);

        if (isKomparatif && pembandingMulai && pembandingSelesai) {
          const komparatifResult = await getLHUKomparatif(
            db,
            { mulai, selesai },
            { mulai: pembandingMulai, selesai: pembandingSelesai }
          );
          if (!permintaan.masihTerbaru(token)) return;
          setDataKomparatif(komparatifResult);
        } else {
          setDataKomparatif(null);
        }
      } catch (e) {
        // §12 — kegagalan refresh TIDAK menimpa data valid dengan nol.
        if (!permintaan.masihTerbaru(token)) return;
        setError(e instanceof Error ? e.message : 'Gagal memuat laporan.');
      } finally {
        if (permintaan.masihTerbaru(token)) setLoading(false);
      }
    },
    [permintaan]
  );

  // ============================================================
  // AUTO-REFRESH SAAT LAYAR KEMBALI DIFOKUSKAN (audit §B)
  // ============================================================
  // ROOT CAUSE sama dengan layar laporan lain: `ReportPeriodPicker`
  // memanggil `onChange` HANYA saat mount & saat tanggal dipilih, dan
  // pemuatan dulu terikat pada peristiwa itu. Native-stack tidak
  // meng-unmount layar yang ditinggalkan, jadi kembali dari mencatat
  // transaksi tidak memuat ulang apa pun.
  //
  // Memakai helper lifecycle existing (`useFocusRefresh` +
  // `usePermintaanTerakhir`), pola yang sama persis dengan
  // PosisiKeuanganScreen. Mode Komparatif & periode pembanding ikut
  // menjadi dependensi supaya filter terakhir dipertahankan apa adanya.
  const muat = useCallback(() => {
    if (!periode) return;
    load(periode.mulai, periode.selesai, komparatif, periodePembanding?.mulai, periodePembanding?.selesai);
  }, [load, periode?.mulai, periode?.selesai, komparatif, periodePembanding?.mulai, periodePembanding?.selesai]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1/§A2 — TOMBOL REFRESH MANUAL.
  //
  // Memakai `muat` yang SAMA dengan initial load & focus refresh di
  // atas: satu sumber fungsi load, tidak ada kueri kedua yang dibuat
  // khusus untuk tombol. `loading` layar dipakai sebagai penguncian
  // tap sekaligus indikator — bukan state loading baru.
  useReportRefreshHeader(muat, { loading, testID: 'refresh-laba-rugi' });

  const onChangePeriode = (p: ResolvedReportPeriod) => {
    setPeriode(p);
  };

  const onChangePeriodePembanding = (p: ResolvedReportPeriod) => {
    setPeriodePembanding(p);
  };

  const toggleKomparatif = (val: boolean) => {
    setKomparatif(val);
    if (!periode) return;
    // DEFAULT COMPARATIVE POLICY KOPKU (§6): periode pembanding =
    // tanggal & bulan yang SAMA pada tahun sebelumnya (Jan-Sep 2026
    // dibandingkan Jan-Sep 2025), memakai helper existing
    // `geserPeriodeSetahunKeBelakang()` — pola yang SAMA PERSIS dengan
    // PerubahanEkuitasScreen & ArusKasScreen. Sebelumnya layar ini
    // membiarkan periode pembanding kosong sampai user memilih manual,
    // sehingga mode Komparatif tidak menampilkan apa pun. User TETAP
    // bebas memilih periode pembanding lain lewat picker di bawah
    // (default TIDAK memaksa, hanya mengisi awal).
    const pembanding = periodePembanding ?? {
      ...periode,
      ...geserPeriodeSetahunKeBelakang({ mulai: periode.mulai, selesai: periode.selesai }),
    };
    // Hanya menyimpan state; pemuatan dilakukan SATU lifecycle
    // (`useFocusRefresh` di atas) supaya tidak ada kueri ganda.
    if (val && !periodePembanding) setPeriodePembanding(pembanding);
  };

  // RC-S39 — tidak lagi bercabang berdasarkan standar: SAK EP adalah
  // satu-satunya basis, jadi judulnya tetap.
  const label = ACCOUNTING_POLICY.SAK_EP.labelLabaRugi;

  const kosong =
    !!data &&
    data.pendapatanJasaPinjaman === 0 &&
    data.pendapatanUsahaLain.length === 0 &&
    data.bebanUsaha.length === 0 &&
    data.hasilInvestasi.length === 0 &&
    data.bebanPerkoperasian.length === 0 &&
    data.pendapatanLain.length === 0 &&
    data.bebanLain.length === 0 &&
    data.bebanPajakPenghasilan === 0 &&
    data.totalOci === 0 &&
    data.ociTidakDireklasifikasi.length === 0 &&
    data.ociDireklasifikasi.length === 0;

  const adaBelumDiklasifikasikan =
    !!data &&
    [
      ...data.pendapatanUsahaLain,
      ...data.bebanUsaha,
      ...data.hasilInvestasi,
      ...data.bebanPerkoperasian,
      ...data.pendapatanLain,
      ...data.bebanLain,
    ].some(
      (r) => r.belumDiklasifikasikan
    );

  // Bagian 8: hanya tampil kalau SHU tahun buku ini SUDAH DIBAGIKAN &
  // nominal disahkan tersedia — sekadar informasi tambahan, TIDAK
  // pernah menggantikan/mengubah baris SHU Neto.
  const tampilkanPembagian =
    !!shuKonfigurasi && shuKonfigurasi.status === 'DIBAGIKAN' && shuKonfigurasi.shuDisahkanRat !== null && !!data;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      {/* RC-S98 — KOP LAPORAN: nama koperasi, judul laporan, dan periode
          dalam SATU kartu, urutan yang sama dengan kepala laporan pada
          naskah Juklat (nama entitas di atas judul, periode di bawahnya)
          dan dengan kop PDF hasil export — sebelumnya judul, nama
          koperasi, dan periode berupa tiga elemen lepas dengan hierarki
          yang justru terbalik. */}
      <View style={styles.kop}>
        <Text style={styles.kopKoperasi} numberOfLines={2}>
          {koperasi?.nama ?? '—'}
        </Text>
        <Text style={styles.kopJudul}>{label}</Text>
        {periode ? <Text style={styles.kopPeriode}>Untuk periode {periode.label}</Text> : null}
        <Text style={styles.kopStandar}>SAK Entitas Privat · Urutan penyajian mengikuti Juklat SOM No. 3/2025</Text>
      </View>

      <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

      <View style={styles.modeRow}>
        <TouchableOpacity style={[styles.modeChip, !komparatif && styles.modeChipActive]} onPress={() => toggleKomparatif(false)}>
          <Text style={[styles.modeChipText, !komparatif && styles.modeChipTextActive]}>Tunggal</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modeChip, komparatif && styles.modeChipActive]} onPress={() => toggleKomparatif(true)}>
          <Text style={[styles.modeChipText, komparatif && styles.modeChipTextActive]}>Komparatif</Text>
        </TouchableOpacity>
      </View>

      {komparatif && (
        <View style={{ marginBottom: spacing.sm }}>
          <Text style={styles.label}>Periode Pembanding</Text>
          <ReportPeriodPicker value={periodePembanding} onChange={onChangePeriodePembanding} />
          {dataKomparatif?.peringatanPeriode && (
            <View style={styles.warningBanner}>
              <Text style={styles.warningText}><Ionicons name="warning-outline" size={iconSize.sm} color={colors.warning} /> {dataKomparatif.peringatanPeriode}</Text>
            </View>
          )}
        </View>
      )}

      {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {!loading && error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && data && (
        <>
          {kosong ? (
            <EmptyState message="Belum ada data hasil usaha untuk periode ini." />
          ) : (
            <>
              <ExportButton
                data={
                  koperasi
                    ? komparatif && dataKomparatif
                      ? buildLHUKomparatifExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, dataKomparatif, label)
                      : buildLHUExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data, label, shuRat ?? undefined)
                    : null
                }
              />

              {komparatif && dataKomparatif ? (
                <LhuKomparatifBody data={dataKomparatif} adaBelumDiklasifikasikan={adaBelumDiklasifikasikan} />
              ) : (
                <>
                  {adaBelumDiklasifikasikan && (
                    <View style={styles.warningBanner}>
                      <Text style={styles.warningText}>
                        Ada akun Pendapatan/Beban yang belum diklasifikasikan untuk LHU. Sementara ditempatkan di kelompok default
                        di bawah — atur klasifikasinya lewat Input Data &gt; Akun.
                      </Text>
                    </View>
                  )}

                  {/* I — PARTISIPASI ANGGOTA (Juklat: "PARTISIPASI ANGGOTA") */}
                  <ReportSectionCard title="Partisipasi Anggota" nomor="I" testID="seksi-partisipasi-anggota">
                    <ReportRow label="Pendapatan Jasa Pinjaman" value={data.pendapatanJasaPinjaman} indent />
                    {data.pendapatanUsahaLain.map((r) => (
                      <RowKlasifikasi key={r.kode} row={r} />
                    ))}
                    <ReportRow label="Jumlah Partisipasi Anggota" value={data.jumlahPartisipasiAnggota} variant="subtotal" />
                  </ReportSectionCard>

                  {/* II — BEBAN USAHA (Juklat: "BEBAN USAHA"; nominal dalam tanda kurung) */}
                  <ReportSectionCard title="Beban Usaha" nomor="II" testID="seksi-beban-usaha">
                    {data.bebanUsaha.length === 0 ? (
                      <Text style={styles.emptyRowText}>Tidak ada beban usaha.</Text>
                    ) : (
                      data.bebanUsaha.map((r) => <RowKlasifikasi key={r.kode} row={r} pengurang />)
                    )}
                    <ReportRow label="Jumlah Beban Usaha" value={data.jumlahBebanUsaha} variant="subtotal" pengurang />
                  </ReportSectionCard>

                  <BandTotal label="Sisa Hasil Usaha Bruto" value={data.shuBruto} rumus="Jumlah partisipasi anggota − jumlah beban usaha" />

                  {/* III — HASIL INVESTASI (Juklat: "Hasil investasi") */}
                  <ReportSectionCard title="Hasil Investasi" nomor="III" testID="seksi-hasil-investasi">
                    {data.hasilInvestasi.length === 0 ? (
                      <Text style={styles.emptyRowText}>Tidak ada hasil investasi.</Text>
                    ) : (
                      data.hasilInvestasi.map((r) => <RowKlasifikasi key={r.kode} row={r} />)
                    )}
                    <ReportRow label="Total Hasil Investasi" value={data.totalHasilInvestasi} variant="subtotal" />
                  </ReportSectionCard>

                  {/* IV — BEBAN PERKOPERASIAN (RC-S98: baris baku Juklat,
                      berada SETELAH hasil investasi & DI LUAR beban usaha). */}
                  <ReportSectionCard
                    title="Beban Perkoperasian"
                    nomor="IV"
                    testID="seksi-beban-perkoperasian"
                    catatan="Beban kegiatan perkoperasian (RAT, pendidikan anggota, iuran gerakan koperasi). Juklat SOM 3/2025 menempatkannya setelah Hasil Investasi — di luar Jumlah Beban Usaha."
                  >
                    {data.bebanPerkoperasian.length === 0 ? (
                      <Text style={styles.emptyRowText}>Tidak ada beban perkoperasian.</Text>
                    ) : (
                      data.bebanPerkoperasian.map((r) => <RowKlasifikasi key={r.kode} row={r} pengurang />)
                    )}
                    <ReportRow
                      label="Total Beban Perkoperasian"
                      value={data.totalBebanPerkoperasian}
                      variant="subtotal"
                      pengurang
                    />
                  </ReportSectionCard>

                  {/* V — PENDAPATAN DAN BEBAN LAIN (Juklat: "PENDAPATAN & BEBAN LAIN") */}
                  <ReportSectionCard title="Pendapatan dan Beban Lain" nomor="V" testID="seksi-pendapatan-beban-lain">
                    {data.pendapatanLain.length === 0 && data.bebanLain.length === 0 ? (
                      <Text style={styles.emptyRowText}>Tidak ada pendapatan/beban lain.</Text>
                    ) : (
                      <>
                        {data.pendapatanLain.map((r) => (
                          <RowKlasifikasi key={r.kode} row={r} />
                        ))}
                        {data.bebanLain.map((r) => (
                          <RowKlasifikasi key={r.kode} row={r} pengurang />
                        ))}
                      </>
                    )}
                    <ReportRow label="Pendapatan/(Beban) Lain Neto" value={data.pendapatanBebanLainNeto} variant="subtotal" />
                  </ReportSectionCard>

                  <BandTotal
                    label="Sisa Hasil Usaha Sebelum Pajak"
                    value={data.shuSebelumPajak}
                    rumus="SHU bruto + hasil investasi − beban perkoperasian + pendapatan/(beban) lain neto"
                  />

                  <View style={styles.pajakWrap}>
                    <ReportRow label="Beban Pajak Penghasilan" value={data.bebanPajakPenghasilan} pengurang />
                  </View>
                </>
              )}

              <SummaryCard
                label="Sisa Hasil Usaha Neto"
                value={data.shuNeto}
                caption={periode ? `Untuk Periode: ${periode.label}` : undefined}
              />

              {/* RC-S88 — PENGHASILAN KOMPREHENSIF LAIN & TOTAL
                  PENGHASILAN KOMPREHENSIF (SAK EP). */}
              {komparatif && dataKomparatif ? (
                <OciKomparatif data={dataKomparatif} />
              ) : (
                <>
                  <OciSection data={data} />
                  <KomposisiPendapatanCard data={data} />
                </>
              )}

              {tampilkanPembagian && (
                <View style={styles.pembagianCard}>
                  <Text style={styles.pembagianTitle}>SHU Setelah Pembagian</Text>
                  <ReportRow label="SHU Neto LHU" value={data.shuNeto} />
                  <ReportRow label="Dibagikan (Disahkan RAT)" value={-(shuKonfigurasi!.shuDisahkanRat ?? 0)} />
                  <ReportRow
                    label="Sisa SHU Setelah Pembagian"
                    value={data.shuNeto - (shuKonfigurasi!.shuDisahkanRat ?? 0)}
                    variant="subtotal"
                  />
                  <Text style={styles.pembagianNote}>
                    Informasi tambahan — baris "Sisa Hasil Usaha Neto" di atas TETAP nilai LHU periode ini, tidak berubah oleh
                    pembagian.
                  </Text>
                </View>
              )}

              {/* PHASE 6 §F/§Q (permintaan pengguna): SHU — Akrual vs
                  Basis Kas. Murni tampilan dari getInformasiShuRAT()
                  yang sudah ada — TIDAK ADA perhitungan baru di layar
                  ini. */}
              {shuRat && (
                <View style={styles.pembagianCard}>
                  <Text style={styles.pembagianTitle}>SHU — Akrual vs Basis Kas</Text>
                  <ReportRow label="SHU Basis Akrual" value={shuRat.shuLaporanKeuanganAkrual} />
                  <ReportRow label="SHU Basis Kas" value={shuRat.shuInformasiRat} />
                  <ReportRow label="Selisih" value={shuRat.selisihAkrualVsKas} variant="subtotal" />

                  <Text style={[styles.pembagianTitle, { marginTop: spacing.md }]}>Rekonsiliasi</Text>
                  <ReportRow label="Pendapatan akrual belum kas" value={-shuRat.pendapatanAkrualBelumKas} />
                  <ReportRow label="Pendapatan kas belum akrual" value={shuRat.pendapatanKasBelumAkrual} />
                  <ReportRow label="Beban akrual belum kas" value={shuRat.bebanAkrualBelumKas} />
                  <ReportRow label="Beban kas belum akrual" value={-shuRat.bebanKasBelumAkrual} />

                  <Text style={styles.pembagianNote}>
                    SHU Basis Akrual dikurangi pendapatan akrual yang belum diterima kas, ditambah pendapatan kas yang
                    belum diakui akrual, ditambah beban akrual yang belum dibayar kas, dikurangi beban kas yang belum
                    diakui akrual — hasilnya persis SHU Basis Kas di atas.
                  </Text>
                  {(shuRat.pendapatanSaldoAwalTunai !== 0 || shuRat.bebanSaldoAwalTunai !== 0) && (
                    <Text style={styles.pembagianNote} testID="catatan-saldo-awal-tunai">
                      SHU Basis Kas sudah termasuk saldo awal yang dicatat sebelum memakai aplikasi
                      {shuRat.pendapatanSaldoAwalTunai !== 0 ? ` — pendapatan ${formatRupiah(shuRat.pendapatanSaldoAwalTunai)}` : ''}
                      {shuRat.bebanSaldoAwalTunai !== 0 ? `, beban ${formatRupiah(shuRat.bebanSaldoAwalTunai)}` : ''}
                      {' '}(dianggap sudah tunai; ubah lewat menu Saldo Awal bila sebagian masih piutang/utang).
                    </Text>
                  )}
                </View>
              )}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

/**
 * RC-S88 — seksi Penghasilan Komprehensif Lain (mode tunggal). Dua
 * kelompok SAK EP selalu tampil; kelompok tanpa pos ditulis "Tidak ada"
 * (bukan angka nol karangan). Diakhiri Total Penghasilan Komprehensif
 * = SHU Neto + OCI.
 */
function OciSection({ data }: { data: LhuResult }) {
  const adaOci = data.ociTidakDireklasifikasi.length > 0 || data.ociDireklasifikasi.length > 0;
  return (
    <View style={styles.ociCard} testID="seksi-oci">
      <View style={styles.ociHeader}>
        <View style={styles.ociIcon}>
          <Ionicons name="layers-outline" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.ociTitle}>Penghasilan Komprehensif Lain</Text>
          <Text style={styles.ociSubtitle}>Diakui di ekuitas · tidak termasuk SHU yang dibagikan</Text>
        </View>
      </View>

      <ReportRow label="Sisa Hasil Usaha Neto" value={data.shuNeto} />

      <Text style={styles.ociGroup}>{LABEL_KELOMPOK_OCI.TIDAK_DIREKLASIFIKASI}</Text>
      {data.ociTidakDireklasifikasi.length === 0 ? (
        <Text style={styles.ociEmpty}>Tidak ada</Text>
      ) : (
        data.ociTidakDireklasifikasi.map((r) => <ReportRow key={r.kode} label={r.nama} value={r.jumlah} />)
      )}

      <Text style={styles.ociGroup}>{LABEL_KELOMPOK_OCI.DIREKLASIFIKASI}</Text>
      {data.ociDireklasifikasi.length === 0 ? (
        <Text style={styles.ociEmpty}>Tidak ada</Text>
      ) : (
        data.ociDireklasifikasi.map((r) => <ReportRow key={r.kode} label={r.nama} value={r.jumlah} />)
      )}

      <ReportRow label="Jumlah Penghasilan Komprehensif Lain" value={data.totalOci} variant="subtotal" />
      <ReportRow label="Total Penghasilan Komprehensif" value={data.totalPenghasilanKomprehensif} variant="total" />

      <Text style={styles.ociNote}>
        {adaOci
          ? 'Berasal dari revaluasi aset tetap (Penyesuaian Nilai Wajar). Surplus revaluasi terakumulasi di ekuitas dan tidak dibagikan sebagai SHU.'
          : 'Tidak ada penghasilan komprehensif lain pada periode ini. Pos ini terisi bila ada revaluasi aset tetap yang diakui di ekuitas.'}
      </Text>
    </View>
  );
}

/** RC-S88 — seksi OCI mode komparatif (union pos by kode, pola sama gabungLhuRows). */
function OciKomparatif({ data }: { data: LhuKomparatif }) {
  const tidak = gabungLhuRows(data.sekarang.ociTidakDireklasifikasi, data.pembanding.ociTidakDireklasifikasi);
  const akan = gabungLhuRows(data.sekarang.ociDireklasifikasi, data.pembanding.ociDireklasifikasi);
  return (
    <View style={styles.ociCard} testID="seksi-oci-komparatif">
      <View style={styles.ociHeader}>
        <View style={styles.ociIcon}>
          <Ionicons name="layers-outline" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.ociTitle}>Penghasilan Komprehensif Lain</Text>
          <Text style={styles.ociSubtitle}>Diakui di ekuitas · tidak termasuk SHU yang dibagikan</Text>
        </View>
      </View>
      <Text style={styles.ociGroup}>{LABEL_KELOMPOK_OCI.TIDAK_DIREKLASIFIKASI}</Text>
      {tidak.length === 0 ? (
        <Text style={styles.ociEmpty}>Tidak ada</Text>
      ) : (
        tidak.map((r) => <ComparativeRow key={r.kode} label={r.nama} sekarang={r.sekarang} pembanding={r.pembanding} />)
      )}
      <Text style={styles.ociGroup}>{LABEL_KELOMPOK_OCI.DIREKLASIFIKASI}</Text>
      {akan.length === 0 ? (
        <Text style={styles.ociEmpty}>Tidak ada</Text>
      ) : (
        akan.map((r) => <ComparativeRow key={r.kode} label={r.nama} sekarang={r.sekarang} pembanding={r.pembanding} />)
      )}
      <ComparativeRow label="Jumlah Penghasilan Komprehensif Lain" sekarang={data.sekarang.totalOci} pembanding={data.pembanding.totalOci} bold />
      <ComparativeRow
        label="Total Penghasilan Komprehensif"
        sekarang={data.sekarang.totalPenghasilanKomprehensif}
        pembanding={data.pembanding.totalPenghasilanKomprehensif}
        bold
      />
    </View>
  );
}

/**
 * Satu baris RINCIAN akun di dalam seksi. RC-S98: selalu ber-indentasi
 * (rincian di bawah header seksi) dan boleh disajikan sebagai pengurang
 * — `row.jumlah` TIDAK dibalik tandanya, hanya cara menampilkannya yang
 * berubah (lihat `formatRupiahPengurang`).
 */
function RowKlasifikasi({ row, pengurang }: { row: LhuRow; pengurang?: boolean }) {
  return (
    <ReportRow
      label={row.nama}
      value={row.jumlah}
      flagged={row.belumDiklasifikasikan}
      flagLabel="Belum diklasifikasikan"
      pengurang={pengurang}
      indent
    />
  );
}

/**
 * RC-S98 — BAND ANGKA ANTARA (SHU Bruto & SHU Sebelum Pajak).
 *
 * Pada naskah Juklat kedua angka ini adalah garis pemisah antar
 * kelompok, bukan baris rincian. Di layar keduanya diberi permukaan
 * gelap tersendiri supaya terbaca sebagai "hasil sampai di sini",
 * ditambah satu baris `rumus` sehingga pembaca tahu angka itu berasal
 * dari baris mana — bukan angka yang muncul entah dari mana.
 */
function BandTotal({ label, value, rumus }: { label: string; value: number; rumus: string }) {
  return (
    <View style={styles.band}>
      <View style={styles.bandRow}>
        <Text style={styles.bandLabel}>{label}</Text>
        <Text
          style={[styles.bandValue, value < 0 && styles.bandValueNegatif]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {formatRupiah(value)}
        </Text>
      </View>
      <Text style={styles.bandRumus}>{rumus}</Text>
    </View>
  );
}

/**
 * RC-S98 — KOMPOSISI PENDAPATAN (dua persentase penutup pada Lampiran
 * contoh LHU Juklat SOM 3/2025). Murni penyajian dari angka `getLHU()`
 * lewat modul murni `hitungKomposisiPendapatanLhu` — TIDAK ada
 * perhitungan akuntansi di layar ini.
 */
function KomposisiPendapatanCard({ data }: { data: LhuResult }) {
  const komposisi = hitungKomposisiPendapatanLhu(data.jumlahPartisipasiAnggota, data.totalHasilInvestasi);
  return (
    <View style={styles.komposisiCard} testID="kartu-komposisi-pendapatan">
      <View style={styles.komposisiHeader}>
        <View style={styles.ociIcon}>
          <Ionicons name="pie-chart-outline" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.ociTitle}>Komposisi Pendapatan</Text>
          <Text style={styles.ociSubtitle}>Partisipasi anggota vs hasil investasi</Text>
        </View>
      </View>

      {komposisi.persenPartisipasiAnggota === null ? (
        <Text style={styles.ociEmpty}>Belum ada pendapatan pada periode ini.</Text>
      ) : (
        <>
          <View style={styles.meterTrack}>
            <View
              style={[styles.meterIsi, { width: `${Math.max(0, Math.min(100, komposisi.persenPartisipasiAnggota))}%` }]}
            />
          </View>
          <View style={styles.komposisiBarisWrap}>
            <BarisKomposisi
              warna={colors.primary}
              label="Partisipasi Anggota"
              nominal={data.jumlahPartisipasiAnggota}
              persen={formatPersenKomposisi(komposisi.persenPartisipasiAnggota)}
            />
            <BarisKomposisi
              warna={colors.border}
              label="Hasil Investasi"
              nominal={data.totalHasilInvestasi}
              persen={formatPersenKomposisi(komposisi.persenHasilInvestasi)}
            />
          </View>
          <ReportRow label="Dasar Perhitungan (Pendapatan + Hasil Investasi)" value={komposisi.totalPendapatanDasar} variant="subtotal" />
        </>
      )}

      <Text style={styles.ociNote}>
        Dua persentase ini mengikuti perhitungan penutup pada Lampiran "Contoh Perhitungan Hasil Usaha untuk KSP" (Juklat
        SOM No. 3/2025): masing-masing dibagi dengan pendapatan bunga + pendapatan usaha lain + hasil investasi. Naskah
        tidak memberi nama resmi untuk kedua rasio ini.
      </Text>
    </View>
  );
}

function BarisKomposisi({ warna, label, nominal, persen }: { warna: string; label: string; nominal: number; persen: string }) {
  return (
    <View style={styles.komposisiBaris}>
      <View style={[styles.komposisiDot, { backgroundColor: warna }]} />
      <Text style={styles.komposisiLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.komposisiNominal}>{formatRupiah(nominal)}</Text>
      <Text style={styles.komposisiPersen}>{persen}</Text>
    </View>
  );
}

/** PHASE 6 §B/§D (permintaan pengguna) — satu baris ringkasan komparatif: nilai berjalan, nilai pembanding, perubahan & persentase (aman kalau pembanding 0). */
function ComparativeRow({ label, sekarang, pembanding, bold }: { label: string; sekarang: number; pembanding: number; bold?: boolean }) {
  const perubahan = sekarang - pembanding;
  return (
    <View style={styles.comparativeRow}>
      <Text style={[styles.comparativeLabel, bold && styles.comparativeLabelBold]}>{label}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.comparativeValue, bold && styles.comparativeLabelBold]}>{formatRupiah(sekarang)}</Text>
        <Text style={styles.comparativePembanding}>vs {formatRupiah(pembanding)}</Text>
        <Text style={styles.comparativePerubahan}>
          {perubahan >= 0 ? '+' : ''}
          {formatRupiah(perubahan)} ({formatPersentasePerubahan(sekarang, pembanding)})
        </Text>
      </View>
    </View>
  );
}

/**
 * PHASE 6 FINAL FIX §2 (permintaan pengguna) — gabungkan dua array
 * LhuRow[] (periode berjalan & pembanding) jadi satu daftar baris
 * berpasangan by `kode`, union kedua sisi (baris yang cuma ada di
 * salah satu periode TETAP ikut, nilai sisi lain 0 — konsisten dengan
 * SeksiPosisi/barisSeksi di PosisiKeuanganScreen.tsx — komponen itu
 * DIGANTI namanya saat penyatuan layout single/komparatif, tapi aturan
 * union-nya SAMA). Helper GENERIK,
 * dipakai untuk SEMUA 5 seksi LhuRow[] di getLHU() (pendapatanUsahaLain,
 * bebanUsaha, hasilInvestasi, pendapatanLain, bebanLain) — TIDAK ADA
 * logic akuntansi, murni pemasangan data yang SUDAH dihitung getLHU().
 */
function gabungLhuRows(sekarang: LhuRow[], pembanding: LhuRow[]): { kode: string; nama: string; sekarang: number; pembanding: number; belumDiklasifikasikan?: boolean }[] {
  const kodeSet = new Set<string>();
  sekarang.forEach((r) => kodeSet.add(r.kode));
  pembanding.forEach((r) => kodeSet.add(r.kode));
  const namaByKode = new Map<string, string>();
  const flagByKode = new Map<string, boolean>();
  sekarang.forEach((r) => {
    namaByKode.set(r.kode, r.nama);
    if (r.belumDiklasifikasikan) flagByKode.set(r.kode, true);
  });
  pembanding.forEach((r) => {
    if (!namaByKode.has(r.kode)) namaByKode.set(r.kode, r.nama);
    if (r.belumDiklasifikasikan) flagByKode.set(r.kode, true);
  });
  const sekarangMap = new Map(sekarang.map((r) => [r.kode, r.jumlah]));
  const pembandingMap = new Map(pembanding.map((r) => [r.kode, r.jumlah]));
  return Array.from(kodeSet).map((kode) => ({
    kode,
    nama: namaByKode.get(kode) ?? kode,
    sekarang: sekarangMap.get(kode) ?? 0,
    pembanding: pembandingMap.get(kode) ?? 0,
    belumDiklasifikasikan: flagByKode.get(kode),
  }));
}

/** Satu baris klasifikasi LHU dalam mode komparatif — label, current, comparison, delta, % (reuse ComparativeRow, tambah flag "belum diklasifikasikan"). */
function ComparativeRowKlasifikasi({ row }: { row: { nama: string; sekarang: number; pembanding: number; belumDiklasifikasikan?: boolean } }) {
  return (
    <View>
      <ComparativeRow label={row.nama} sekarang={row.sekarang} pembanding={row.pembanding} />
      {row.belumDiklasifikasikan && <Text style={styles.flagText}>Belum diklasifikasikan</Text>}
    </View>
  );
}

/**
 * PHASE 6 FINAL FIX §2 (permintaan pengguna) — LHU komparatif LENGKAP:
 * SEMUA baris klasifikasi yang tersedia di getLHU() dibandingkan
 * (bukan cuma ringkasan 5 baris seperti draft sebelumnya), mengikuti
 * hierarchy/urutan seksi PERSIS SAMA dengan tampilan non-komparatif di
 * atas (Partisipasi Anggota -> Beban Usaha -> SHU Bruto -> Hasil
 * Investasi -> Pendapatan & Beban Lain -> SHU Sebelum Pajak -> Beban
 * Pajak). TIDAK ADA logic akuntansi baru — murni memasangkan
 * `dataKomparatif.sekarang`/`dataKomparatif.pembanding` (dua
 * `LhuResult` dari getLHU(), sudah dihitung) baris-demi-baris lewat
 * `gabungLhuRows`.
 */
function LhuKomparatifBody({ data, adaBelumDiklasifikasikan }: { data: LhuKomparatif; adaBelumDiklasifikasikan: boolean }) {
  return (
    <>
      {adaBelumDiklasifikasikan && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            Ada akun Pendapatan/Beban yang belum diklasifikasikan untuk LHU. Sementara ditempatkan di kelompok default di
            bawah — atur klasifikasinya lewat Input Data &gt; Akun.
          </Text>
        </View>
      )}

      {/* PARTISIPASI ANGGOTA */}
      <ReportSectionCard title="Partisipasi Anggota" nomor="I" testID="seksi-partisipasi-anggota-komparatif">
        <ComparativeRow label="Pendapatan Jasa Pinjaman" sekarang={data.sekarang.pendapatanJasaPinjaman} pembanding={data.pembanding.pendapatanJasaPinjaman} />
        {gabungLhuRows(data.sekarang.pendapatanUsahaLain, data.pembanding.pendapatanUsahaLain).map((r) => (
          <ComparativeRowKlasifikasi key={r.kode} row={r} />
        ))}
        <ComparativeRow label="Jumlah Partisipasi Anggota" sekarang={data.sekarang.jumlahPartisipasiAnggota} pembanding={data.pembanding.jumlahPartisipasiAnggota} bold />
      </ReportSectionCard>

      {/* BEBAN USAHA */}
      <ReportSectionCard title="Beban Usaha" nomor="II" testID="seksi-beban-usaha-komparatif">
        {gabungLhuRows(data.sekarang.bebanUsaha, data.pembanding.bebanUsaha).length === 0 ? (
          <Text style={styles.emptyRowText}>Tidak ada beban usaha.</Text>
        ) : (
          gabungLhuRows(data.sekarang.bebanUsaha, data.pembanding.bebanUsaha).map((r) => <ComparativeRowKlasifikasi key={r.kode} row={r} />)
        )}
        <ComparativeRow label="Jumlah Beban Usaha" sekarang={data.sekarang.jumlahBebanUsaha} pembanding={data.pembanding.jumlahBebanUsaha} bold />
      </ReportSectionCard>

      <View style={styles.grandTotalWrap}>
        <ComparativeRow label="Sisa Hasil Usaha Bruto" sekarang={data.sekarang.shuBruto} pembanding={data.pembanding.shuBruto} bold />
      </View>

      {/* HASIL INVESTASI */}
      <ReportSectionCard title="Hasil Investasi" nomor="III" testID="seksi-hasil-investasi-komparatif">
        {gabungLhuRows(data.sekarang.hasilInvestasi, data.pembanding.hasilInvestasi).length === 0 ? (
          <Text style={styles.emptyRowText}>Tidak ada hasil investasi.</Text>
        ) : (
          gabungLhuRows(data.sekarang.hasilInvestasi, data.pembanding.hasilInvestasi).map((r) => <ComparativeRowKlasifikasi key={r.kode} row={r} />)
        )}
        <ComparativeRow label="Total Hasil Investasi" sekarang={data.sekarang.totalHasilInvestasi} pembanding={data.pembanding.totalHasilInvestasi} bold />
      </ReportSectionCard>

      {/* RC-S98 — BEBAN PERKOPERASIAN: seksi yang SAMA & pada posisi yang
          SAMA dengan mode tunggal, supaya kedua mode tidak pernah
          menyajikan urutan yang berbeda. */}
      <ReportSectionCard title="Beban Perkoperasian" nomor="IV" testID="seksi-beban-perkoperasian-komparatif">
        {gabungLhuRows(data.sekarang.bebanPerkoperasian, data.pembanding.bebanPerkoperasian).length === 0 ? (
          <Text style={styles.emptyRowText}>Tidak ada beban perkoperasian.</Text>
        ) : (
          gabungLhuRows(data.sekarang.bebanPerkoperasian, data.pembanding.bebanPerkoperasian).map((r) => (
            <ComparativeRowKlasifikasi key={r.kode} row={{ ...r, sekarang: -r.sekarang, pembanding: -r.pembanding }} />
          ))
        )}
        <ComparativeRow
          label="Total Beban Perkoperasian"
          sekarang={-data.sekarang.totalBebanPerkoperasian}
          pembanding={-data.pembanding.totalBebanPerkoperasian}
          bold
        />
      </ReportSectionCard>

      {/* PENDAPATAN DAN BEBAN LAIN */}
      <ReportSectionCard title="Pendapatan dan Beban Lain" nomor="V" testID="seksi-pendapatan-beban-lain-komparatif">
        {gabungLhuRows(data.sekarang.pendapatanLain, data.pembanding.pendapatanLain).length === 0 &&
        gabungLhuRows(data.sekarang.bebanLain, data.pembanding.bebanLain).length === 0 ? (
          <Text style={styles.emptyRowText}>Tidak ada pendapatan/beban lain.</Text>
        ) : (
          <>
            {gabungLhuRows(data.sekarang.pendapatanLain, data.pembanding.pendapatanLain).map((r) => (
              <ComparativeRowKlasifikasi key={r.kode} row={r} />
            ))}
            {gabungLhuRows(data.sekarang.bebanLain, data.pembanding.bebanLain).map((r) => (
              <ComparativeRowKlasifikasi key={r.kode} row={{ ...r, sekarang: -r.sekarang, pembanding: -r.pembanding }} />
            ))}
          </>
        )}
        <ComparativeRow label="Pendapatan/(Beban) Lain Neto" sekarang={data.sekarang.pendapatanBebanLainNeto} pembanding={data.pembanding.pendapatanBebanLainNeto} bold />
      </ReportSectionCard>

      <View style={styles.grandTotalWrap}>
        <ComparativeRow label="Sisa Hasil Usaha Sebelum Pajak" sekarang={data.sekarang.shuSebelumPajak} pembanding={data.pembanding.shuSebelumPajak} bold />
      </View>

      <ComparativeRow label="Beban Pajak Penghasilan" sekarang={-data.sekarang.bebanPajakPenghasilan} pembanding={-data.pembanding.bebanPajakPenghasilan} />

      <View style={styles.komparatifCard}>
        <Text style={styles.komparatifTitle}>SISA HASIL USAHA NETO</Text>
        <ComparativeRow label="SHU Neto" sekarang={data.sekarang.shuNeto} pembanding={data.pembanding.shuNeto} bold />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // RC-S98 — KOP LAPORAN (menggantikan title/sub/periodeBanner yang lepas).
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

  // RC-S98 — band angka antara (SHU Bruto / SHU Sebelum Pajak).
  band: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  bandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  bandLabel: {
    flex: 1,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  bandValue: { flexShrink: 1, maxWidth: '58%', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'], color: colors.white, textAlign: 'right' },
  bandValueNegatif: { color: colors.warningBg },
  bandRumus: { fontSize: 10, color: colors.primaryLight, marginTop: 2 },

  pajakWrap: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },

  // RC-S98 — kartu komposisi pendapatan (Lampiran Juklat).
  komposisiCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
  },
  komposisiHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  meterTrack: { height: 10, borderRadius: 5, backgroundColor: colors.border, overflow: 'hidden' },
  meterIsi: { height: 10, borderRadius: 5, backgroundColor: colors.primary },
  komposisiBarisWrap: { marginTop: spacing.sm },
  komposisiBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 3 },
  komposisiDot: { width: 9, height: 9, borderRadius: 5 },
  komposisiLabel: { flex: 1, fontSize: 12, color: colors.text },
  komposisiNominal: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  komposisiPersen: { width: 56, fontSize: 12, fontWeight: '700', color: colors.primary, textAlign: 'right', fontVariant: ['tabular-nums'] },

  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  emptyRowText: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic', marginBottom: 4 },
  warningBanner: { backgroundColor: '#FFF7E6', borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.md },
  warningText: { fontSize: 12, color: '#8A6D3B' },
  grandTotalWrap: { marginBottom: spacing.md },
  pembagianCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  pembagianTitle: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.xs },
  pembagianNote: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 15, fontStyle: 'italic' },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  modeChip: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' },
  modeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeChipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  modeChipTextActive: { color: colors.white },
  label: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: spacing.xs },
  komparatifCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  komparatifTitle: { fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm, letterSpacing: 0.5 },
  comparativeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  comparativeLabel: { fontSize: 13, color: colors.text, flex: 1 },
  comparativeLabelBold: { fontWeight: '700' },
  comparativeValue: { fontSize: 13, color: colors.text },
  comparativePembanding: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  comparativePerubahan: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 1 },
  flagText: { fontSize: 10, color: colors.warning, fontStyle: 'italic', marginBottom: 4 },
  ociCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  ociHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  ociIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ociTitle: { fontSize: 13, fontWeight: '800', color: colors.text, letterSpacing: 0.2, textTransform: 'uppercase' },
  ociSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  ociGroup: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginTop: spacing.sm, marginBottom: 2 },
  ociEmpty: { fontSize: 12, color: colors.textFaint, fontStyle: 'italic', paddingVertical: 4, paddingLeft: spacing.sm },
  ociNote: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 15 },
});
