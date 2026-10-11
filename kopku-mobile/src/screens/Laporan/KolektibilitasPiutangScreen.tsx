import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getDb } from '@/database/db';
import {
  sesuaikanPenyisihanPiutang,
  Kolektibilitas,
  KOLEKTIBILITAS_LABEL,
  KOLEKTIBILITAS_URUT,
  PERSENTASE_CADANGAN,
  ringkasKualitasPinjaman,
} from '@/services/LoanImpairmentService';
import {
  BULAN_DIRAGUKAN_MENJADI_MACET,
  RASIO_AGUNAN_MINIMUM_DIRAGUKAN,
  RASIO_ANGSURAN_MINIMUM_DIRAGUKAN,
} from '@/services/KolektibilitasSomService';
import {
  getKlasifikasiFiskalPinjamanAktif,
  KlasifikasiFiskalItem,
  LABEL_KOLEKTIBILITAS_FISKAL,
  PERSENTASE_CADANGAN_FISKAL,
} from '@/services/KolektibilitasFiskalService';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { getAccountBalance } from '@/accounting/AccountingEngine';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { buildKolektibilitasExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import SearchField from '@/components/SearchField';
import EmptyState from '@/components/report/EmptyState';
import { colors, radius, spacing, iconSize, elevation } from '@/theme/colors';
import { kolektibilitasColor, tintKolektibilitas as tint } from '@/theme/kolektibilitas';

/**
 * AMBANG PENYAJIAN rasio pinjaman bermasalah (NPL).
 *
 * 5% adalah acuan yang lazim dipakai pengawas koperasi sebagai batas
 * portofolio yang sehat. Dipakai HANYA untuk mewarnai & memberi label
 * angka yang sudah dihitung — TIDAK memengaruhi satu pun penggolongan,
 * penyisihan, atau jurnal. Disimpan sebagai konstanta bernama supaya
 * tidak muncul sebagai angka 5 yang tidak jelas asalnya di tengah JSX.
 */
const AMBANG_RASIO_BERMASALAH_SEHAT = 5;

type StatusAnggotaFilter = 'AKTIF' | 'TIDAK_AKTIF' | 'SEMUA';

const LABEL_STATUS_ANGGOTA: Record<StatusAnggotaFilter, string> = {
  AKTIF: 'Anggota Aktif',
  TIDAK_AKTIF: 'Nonaktif',
  SEMUA: 'Semua',
};

/**
 * "Kolektibilitas Piutang Pinjaman Anggota" — masuk dari menu Laporan.
 *
 * PENGGOLONGAN & SELURUH ANGKA berasal dari `LoanImpairmentService`
 * (mesin aging + `KolektibilitasSomService` sebagai mesin aturan SOM
 * Juklat 3/2025) dan `KolektibilitasFiskalService` (batasan fiskal PMK
 * 74/2024). Layar ini TIDAK menghitung ambang, persentase, kategori,
 * maupun penyisihan apa pun sendiri — ia menyusun penyajian, filter,
 * export, dan satu aksi posting (`Sesuaikan Penyisihan`) yang memanggil
 * fungsi service yang sudah ada.
 *
 * STRUKTUR LAYAR (dari atas ke bawah), disusun mengikuti urutan
 * pertanyaan yang benar-benar dijawab pengurus koperasi:
 *   1. Periode & lingkup anggota                        -> "data kapan & siapa"
 *   2. Kartu Kualitas Portofolio (outstanding + rasio
 *      pinjaman bermasalah + bar komposisi)             -> "seberapa sehat"
 *   3. Penggolongan SOM per kategori (bisa ditekan
 *      untuk memfilter daftar di bawah)                 -> "di mana risikonya"
 *   4. Penyisihan buku: target vs tercatat + aksi       -> "apa yang harus dibukukan"
 *   5. Batasan fiskal PMK 74 + arah koreksi fiskal      -> "apa yang diakui fiskus"
 *   6. Dasar peraturan (bisa dilipat)                   -> "dari mana aturannya"
 *   7. Export, pencarian, lalu daftar per pinjaman      -> "tunjukkan rinciannya"
 */
export default function KolektibilitasPiutangScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const currentUser = useAppStore((s) => s.currentUser);
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [statusAnggota, setStatusAnggota] = useState<StatusAnggotaFilter>('AKTIF');
  const [kategoriFilter, setKategoriFilter] = useState<Kolektibilitas | null>(null);
  const [search, setSearch] = useState('');
  const [dasarTerbuka, setDasarTerbuka] = useState(false);
  /** Id pinjaman yang barisnya sedang dibuka (menampilkan dasar penggolongan & rincian SOM). */
  const [barisTerbuka, setBarisTerbuka] = useState<string | null>(null);

  // KlasifikasiFiskalItem = KlasifikasiPinjamanItem (buku, SOM) + field
  // fiskal PMK 74 di atasnya — SATU query, karena field buku & fiskal
  // datang dari sumber yang sama.
  const [data, setData] = useState<KlasifikasiFiskalItem[]>([]);
  const [saldoTercatat, setSaldoTercatat] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(
    async (tanggalLaporan: string, status: StatusAnggotaFilter) => {
      // §10 — token diambil SEBELUM await apa pun.
      const token = permintaan.mulai();
      setLoading(true);
      setError(null);
      try {
        const db = await getDb();
        const rows = await getKlasifikasiFiskalPinjamanAktif(db, { tanggalLaporan, statusAnggota: status });
        if (!permintaan.masihTerbaru(token)) return;
        setData(rows);
        // Saldo AKTUAL yang sudah tercatat di ledger — dibandingkan dengan
        // target hasil klasifikasi supaya user tahu ada selisih yang perlu
        // disesuaikan atau tidak.
        const penyisihanAccountId = await resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN');
        const saldo = await getAccountBalance(db, penyisihanAccountId, tanggalLaporan);
        if (!permintaan.masihTerbaru(token)) return;
        setSaldoTercatat(saldo);
      } catch (e) {
        // §12 — kegagalan refresh TIDAK menimpa data valid dengan nol.
        if (!permintaan.masihTerbaru(token)) return;
        setError(e instanceof Error ? e.message : 'Gagal memuat data kolektibilitas.');
      } finally {
        if (permintaan.masihTerbaru(token)) setLoading(false);
      }
    },
    [permintaan]
  );

  // ============================================================
  // AUTO-REFRESH SAAT LAYAR KEMBALI DIFOKUSKAN (audit §B)
  // ============================================================
  // `ReportPeriodPicker` memanggil `onChange` HANYA saat mount & saat
  // pengguna memilih tanggal, sedangkan native-stack TIDAK meng-unmount
  // layar yang ditinggalkan — jadi memuat data di dalam `onChangePeriode`
  // membuat layar menampilkan hasil perhitungan LAMA setelah pengguna
  // mencatat transaksi lalu kembali. `onChangePeriode` karena itu HANYA
  // menyimpan periode; SATU lifecycle (`useFocusRefresh`) yang memuat.
  const muat = useCallback(() => {
    if (!periode) return;
    load(periode.selesai, statusAnggota);
  }, [load, periode?.selesai, statusAnggota]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1/§A2 — tombol refresh manual memakai `muat` yang SAMA
  // dengan initial load & focus refresh: satu sumber fungsi load, tidak
  // ada kueri kedua khusus untuk tombol.
  useReportRefreshHeader(muat, { loading, testID: 'refresh-kolektibilitas-piutang' });

  const onChangePeriode = (p: ResolvedReportPeriod) => setPeriode(p);
  const onChangeStatus = (s: StatusAnggotaFilter) => setStatusAnggota(s);

  // ============================================================
  // ANGKA RINGKASAN
  // ============================================================
  // Dihitung `ringkasKualitasPinjaman()` di service — BUKAN dijumlah
  // ulang di layar — supaya angka kartu ringkasan di sini dan angka
  // laporan/export MUSTAHIL berbeda. `useMemo` supaya tidak dihitung
  // ulang pada setiap ketikan di kotak pencarian.
  const ringkasan = useMemo(() => ringkasKualitasPinjaman(data), [data]);

  const totalCadanganFiskal = useMemo(() => data.reduce((a, d) => a + d.cadanganFiskal, 0), [data]);
  const totalAgunan = useMemo(() => data.reduce((a, d) => a + d.nilaiAgunan, 0), [data]);
  const selisihBukuFiskal = ringkasan.totalCadangan - totalCadanganFiskal;
  const selisihPenyisihan = saldoTercatat !== null ? ringkasan.totalCadangan - saldoTercatat : 0;
  const rasioSehat = ringkasan.rasioBermasalahPersen <= AMBANG_RASIO_BERMASALAH_SEHAT;

  const ringkasanFiskal = useMemo(
    () =>
      KOLEKTIBILITAS_URUT.map((kat) => {
        const items = data.filter((d) => d.kolektibilitasFiskal === kat);
        return {
          kategori: kat,
          jumlah: items.length,
          dasar: items.reduce((a, d) => a + d.dasarPencadanganFiskal, 0),
          cadangan: items.reduce((a, d) => a + d.cadanganFiskal, 0),
        };
      }),
    [data]
  );

  const dataTampil = useMemo(
    () =>
      data.filter((d) => {
        if (kategoriFilter && d.kolektibilitas !== kategoriFilter) return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return (
          d.namaAnggota.toLowerCase().includes(q) ||
          d.nomorAnggota.toLowerCase().includes(q) ||
          d.nomorPinjaman.toLowerCase().includes(q)
        );
      }),
    [data, kategoriFilter, search]
  );

  // ============================================================
  // AKSI: SESUAIKAN PENYISIHAN (memanggil service, tanpa logic baru)
  // ============================================================
  const konfirmasiSesuaikanPenyisihan = () => {
    if (!periode || !currentUser) return;
    notify(
      'Sesuaikan Penyisihan Piutang',
      `Saldo Penyisihan Piutang akan disesuaikan dari ${formatRupiah(saldoTercatat ?? 0)} menjadi ${formatRupiah(
        ringkasan.totalCadangan
      )} (selisih ${formatRupiah(selisihPenyisihan)}) lewat satu jurnal penyesuaian. Lanjutkan?`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Sesuaikan', style: 'destructive', onPress: doSesuaikanPenyisihan },
      ]
    );
  };

  const doSesuaikanPenyisihan = async () => {
    if (!periode || !currentUser) return;
    setProcessing(true);
    try {
      const hasil = await sesuaikanPenyisihanPiutang({ tanggal: periode.selesai, createdBy: currentUser.id });
      if (hasil.journalId) {
        notify('Berhasil', `Penyisihan piutang disesuaikan sebesar ${formatRupiah(hasil.delta)} dan diposting ke jurnal.`);
      } else {
        notify('Tidak Ada Perubahan', 'Saldo penyisihan sudah sesuai dengan target, tidak ada jurnal yang dibuat.');
      }
      await load(periode.selesai, statusAnggota);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <FlatList
      style={styles.container}
      data={dataTampil}
      keyExtractor={(item) => item.pinjamanId}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <>
          <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

          {/* Segmented control lingkup anggota — satu wadah berbingkai,
              bukan tiga pil terpisah: pilihan yang saling eksklusif lebih
              terbaca sebagai satu kelompok. */}
          <View style={styles.segment}>
            {(['AKTIF', 'TIDAK_AKTIF', 'SEMUA'] as StatusAnggotaFilter[]).map((s) => {
              const aktif = statusAnggota === s;
              return (
                <TouchableOpacity
                  key={s}
                  style={[styles.segmentItem, aktif && styles.segmentItemActive]}
                  onPress={() => onChangeStatus(s)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: aktif }}
                >
                  <Text style={[styles.segmentText, aktif && styles.segmentTextActive]}>{LABEL_STATUS_ANGGOTA[s]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {loading && <ActivityIndicator style={styles.loader} color={colors.primary} />}
          {!loading && error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={iconSize.md} color={colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {!loading && !error && data.length > 0 && (
            <>
              {/* ============================================================
                  1. KUALITAS PORTOFOLIO — outstanding, rasio bermasalah, komposisi
                  ============================================================ */}
              <View style={[styles.card, styles.heroCard]}>
                <View style={styles.heroTopRow}>
                  <View style={styles.heroTotal}>
                    <Text style={styles.heroLabel}>Piutang Pinjaman Outstanding</Text>
                    <Text style={styles.heroValue}>{formatRupiah(ringkasan.totalOutstanding)}</Text>
                    <Text style={styles.heroHint}>Saldo pokok — dasar perhitungan penyisihan</Text>
                  </View>
                  <View style={styles.heroCountBadge}>
                    <Ionicons name="documents-outline" size={iconSize.sm} color={colors.primary} />
                    <Text style={styles.heroCountText}>{ringkasan.jumlahPinjaman} pinjaman</Text>
                  </View>
                </View>

                {/* Rasio pinjaman bermasalah — indikator pengawasan utama. */}
                <View style={styles.nplBlock}>
                  <View style={styles.nplHeadRow}>
                    <View style={styles.nplHeadLeft}>
                      <Text style={styles.nplLabel}>Rasio Pinjaman Bermasalah</Text>
                      <Text style={styles.nplSub}>Kurang Lancar + Diragukan + Macet</Text>
                    </View>
                    <View style={styles.nplHeadRight}>
                      <Text style={[styles.nplValue, { color: rasioSehat ? colors.success : colors.danger }]}>
                        {ringkasan.rasioBermasalahPersen.toFixed(2)}%
                      </Text>
                      <View
                        style={[
                          styles.nplPill,
                          { backgroundColor: rasioSehat ? colors.primaryLight : colors.dangerBg },
                        ]}
                      >
                        <Text style={[styles.nplPillText, { color: rasioSehat ? colors.primary : colors.danger }]}>
                          {rasioSehat ? 'Dalam acuan' : 'Perlu perhatian'}
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* Meter rasio terhadap acuan 5%. Panjang bar dibatasi 100%
                      (rasio bisa melebihi acuan berkali-kali lipat, tapi bar
                      tidak boleh keluar dari kartunya). */}
                  <View style={styles.meterTrack}>
                    <View
                      style={[
                        styles.meterFill,
                        {
                          width: `${Math.min(100, ringkasan.rasioBermasalahPersen)}%`,
                          backgroundColor: rasioSehat ? colors.success : colors.danger,
                        },
                      ]}
                    />
                    <View style={[styles.meterMark, { left: `${AMBANG_RASIO_BERMASALAH_SEHAT}%` }]} />
                  </View>
                  <View style={styles.meterCaptionRow}>
                    <Text style={styles.meterCaption}>
                      {formatRupiah(ringkasan.outstandingBermasalah)} · {ringkasan.jumlahPinjamanBermasalah} pinjaman
                    </Text>
                    <Text style={styles.meterCaption}>acuan {AMBANG_RASIO_BERMASALAH_SEHAT}%</Text>
                  </View>
                </View>

                {/* Komposisi outstanding per kategori. */}
                <View style={styles.riskBar}>
                  {ringkasan.perKategori.map((k) => {
                    const pct =
                      ringkasan.totalOutstanding > 0 ? k.totalOutstanding / ringkasan.totalOutstanding : 0;
                    if (pct <= 0) return null;
                    return <View key={k.kategori} style={{ flex: pct, backgroundColor: kolektibilitasColor[k.kategori] }} />;
                  })}
                </View>
              </View>

              {/* ============================================================
                  2. PENGGOLONGAN SOM — 4 kategori, bisa ditekan untuk memfilter
                  ============================================================ */}
              <View style={[styles.card, styles.cardSpaced]}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="layers-outline" size={iconSize.md} color={colors.primary} />
                  <View style={styles.cardTitleBody}>
                    <Text style={styles.cardTitle}>Penggolongan Kualitas Pinjaman</Text>
                    <Text style={styles.cardSubtitle}>SOM Juklat Pengawasan Koperasi No. 3/2025</Text>
                  </View>
                </View>

                {/* SELURUH 4 kategori selalu ditampilkan, termasuk yang
                    kosong (diredam warnanya): ini laporan pengawasan —
                    "Macet: 0 pinjaman" adalah informasi, bukan baris kosong
                    yang layak disembunyikan. */}
                <View style={styles.kategoriList}>
                  {ringkasan.perKategori.map((k, idx) => {
                    const kosong = k.jumlahPinjaman === 0;
                    const aktif = kategoriFilter === k.kategori;
                    const pctPortofolio =
                      ringkasan.totalOutstanding > 0
                        ? (k.totalOutstanding / ringkasan.totalOutstanding) * 100
                        : 0;
                    const warna = kolektibilitasColor[k.kategori];
                    return (
                      <TouchableOpacity
                        key={k.kategori}
                        style={[
                          styles.kategoriRow,
                          idx === ringkasan.perKategori.length - 1 && styles.kategoriRowLast,
                          aktif && { backgroundColor: tint(warna, 0.08) },
                        ]}
                        onPress={() => setKategoriFilter(aktif ? null : k.kategori)}
                        // Kategori kosong tidak bisa dipakai memfilter —
                        // hasilnya pasti daftar kosong, jadi tekanannya
                        // dimatikan alih-alih membawa pengguna ke jalan buntu.
                        disabled={kosong}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityState={{ selected: aktif, disabled: kosong }}
                      >
                        <View style={styles.kategoriLeft}>
                          <View style={[styles.kategoriDot, { backgroundColor: kosong ? colors.border : warna }]} />
                          <View style={styles.kategoriTextWrap}>
                            <Text style={[styles.kategoriTitle, kosong && styles.mutedText]}>
                              {KOLEKTIBILITAS_LABEL[k.kategori]}
                            </Text>
                            <Text style={styles.kategoriSub}>
                              {k.jumlahPinjaman} pinjaman · penyisihan {PERSENTASE_CADANGAN[k.kategori]}%
                            </Text>
                          </View>
                        </View>
                        <View style={styles.kategoriRight}>
                          <Text style={[styles.kategoriValue, kosong && styles.mutedText]}>
                            {formatRupiah(k.totalOutstanding)}
                          </Text>
                          <Text style={styles.kategoriPct}>{pctPortofolio.toFixed(1)}% portofolio</Text>
                        </View>
                        {aktif && <Ionicons name="funnel" size={12} color={warna} style={styles.kategoriFunnel} />}
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {kategoriFilter ? (
                  <TouchableOpacity style={styles.clearFilterRow} onPress={() => setKategoriFilter(null)}>
                    <Ionicons name="close-circle" size={iconSize.sm} color={colors.textMuted} />
                    <Text style={styles.clearFilterText}>
                      Hapus filter "{KOLEKTIBILITAS_LABEL[kategoriFilter]}"
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.cardNote}>Tekan salah satu kategori untuk memfilter daftar di bawah.</Text>
                )}
              </View>

              {/* ============================================================
                  3. PENYISIHAN BUKU — target vs tercatat + aksi posting
                  ============================================================ */}
              <View style={[styles.card, styles.cardSpaced]}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="shield-checkmark-outline" size={iconSize.md} color={colors.primary} />
                  <View style={styles.cardTitleBody}>
                    <Text style={styles.cardTitle}>Taksiran Piutang Tak Tertagih</Text>
                    <Text style={styles.cardSubtitle}>
                      Cadangan risiko SOM angka 15 — 0% / 50% / 75% / 100% atas saldo pokok penuh
                    </Text>
                  </View>
                </View>

                <View style={styles.statPairRow}>
                  <View style={styles.statCell}>
                    <Text style={styles.statLabel}>Target hasil penggolongan</Text>
                    <Text style={styles.statValue}>{formatRupiah(ringkasan.totalCadangan)}</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statCell}>
                    <Text style={styles.statLabel}>Tercatat di buku besar</Text>
                    <Text style={styles.statValue}>
                      {saldoTercatat !== null ? formatRupiah(saldoTercatat) : '—'}
                    </Text>
                  </View>
                </View>

                {saldoTercatat !== null && selisihPenyisihan !== 0 && (
                  <>
                    <View style={styles.deltaBanner}>
                      <Ionicons
                        name={selisihPenyisihan > 0 ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'}
                        size={iconSize.sm}
                        color={colors.warning}
                      />
                      <Text style={styles.deltaText}>
                        Selisih {formatRupiah(Math.abs(selisihPenyisihan))} —{' '}
                        {selisihPenyisihan > 0 ? 'cadangan perlu ditambah' : 'cadangan bisa dilepas'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.primaryButton, processing && styles.disabled]}
                      onPress={konfirmasiSesuaikanPenyisihan}
                      disabled={processing}
                      accessibilityRole="button"
                    >
                      {processing ? (
                        <ActivityIndicator color={colors.white} />
                      ) : (
                        <>
                          <Ionicons name="create-outline" size={iconSize.sm} color={colors.white} />
                          <Text style={styles.primaryButtonText}>Sesuaikan Penyisihan</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </>
                )}
                {saldoTercatat !== null && selisihPenyisihan === 0 && (
                  <View style={styles.okRow}>
                    <Ionicons name="checkmark-circle" size={iconSize.sm} color={colors.success} />
                    <Text style={styles.okText}>Saldo sudah sesuai target — tidak perlu penyesuaian.</Text>
                  </View>
                )}
              </View>

              {/* ============================================================
                  4. BATASAN FISKAL PMK 74/2024
                  ============================================================ */}
              <View style={[styles.card, styles.cardSpaced]}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="receipt-outline" size={iconSize.md} color={colors.primary} />
                  <View style={styles.cardTitleBody}>
                    <Text style={styles.cardTitle}>Batasan Fiskal Cadangan Piutang</Text>
                    <Text style={styles.cardSubtitle}>PMK 74/2024 Ps.7 — baris Koperasi Simpan Pinjam</Text>
                  </View>
                </View>

                <View style={styles.statPairRow}>
                  <View style={styles.statCell}>
                    <Text style={styles.statLabel}>Cadangan diakui fiskal</Text>
                    <Text style={styles.statValue}>{formatRupiah(totalCadanganFiskal)}</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statCell}>
                    <Text style={styles.statLabel}>Agunan sebagai pengurang</Text>
                    <Text style={styles.statValue}>{formatRupiah(totalAgunan)}</Text>
                  </View>
                </View>

                <View
                  style={[
                    styles.koreksiBanner,
                    { backgroundColor: selisihBukuFiskal === 0 ? colors.primaryLight : colors.warningBg },
                  ]}
                >
                  <Ionicons
                    name={selisihBukuFiskal === 0 ? 'checkmark-circle' : 'swap-vertical-outline'}
                    size={iconSize.sm}
                    color={selisihBukuFiskal === 0 ? colors.primary : colors.warning}
                  />
                  <Text style={styles.koreksiText}>
                    {selisihBukuFiskal === 0
                      ? 'Cadangan buku sama dengan batas fiskal — tidak ada koreksi fiskal dari pos ini.'
                      : selisihBukuFiskal > 0
                      ? `Cadangan buku melebihi batas fiskal ${formatRupiah(
                          selisihBukuFiskal
                        )} — calon koreksi fiskal POSITIF di SPT Badan.`
                      : `Cadangan buku di bawah batas fiskal ${formatRupiah(
                          Math.abs(selisihBukuFiskal)
                        )} — calon koreksi fiskal NEGATIF di SPT Badan.`}
                  </Text>
                </View>

                {/* Tabel ringkas per kategori fiskal. Lebar kolom ditetapkan
                    lewat flex, bukan spasi/tab, supaya angka tetap sejajar
                    pada label kategori sepanjang "Kurang Lancar". */}
                <View style={styles.tabelHeadRow}>
                  <Text style={[styles.tabelHead, styles.colKategori]}>Kategori</Text>
                  <Text style={[styles.tabelHead, styles.colAngka]}>Dasar</Text>
                  <Text style={[styles.tabelHead, styles.colPersen]}>%</Text>
                  <Text style={[styles.tabelHead, styles.colAngka]}>Cadangan</Text>
                </View>
                {ringkasanFiskal.map((r) => (
                  <View key={r.kategori} style={styles.tabelRow}>
                    <View style={[styles.colKategori, styles.tabelKategoriCell]}>
                      <View style={[styles.kategoriDotKecil, { backgroundColor: kolektibilitasColor[r.kategori] }]} />
                      <Text style={styles.tabelSel} numberOfLines={1}>
                        {LABEL_KOLEKTIBILITAS_FISKAL[r.kategori]}
                      </Text>
                    </View>
                    <Text style={[styles.tabelSel, styles.colAngka, styles.angka]}>{formatRupiah(r.dasar)}</Text>
                    <Text style={[styles.tabelSel, styles.colPersen, styles.angka]}>
                      {PERSENTASE_CADANGAN_FISKAL[r.kategori]}
                    </Text>
                    <Text style={[styles.tabelSel, styles.colAngka, styles.angka]}>{formatRupiah(r.cadangan)}</Text>
                  </View>
                ))}

                <Text style={styles.cardNote}>
                  Dasar fiskal = saldo pokok dikurangi nilai agunan, kecuali kategori Lancar yang dihitung tanpa
                  pengurang agunan. Laporan pembanding untuk menyusun koreksi fiskal SPT Badan — tidak memposting
                  jurnal apa pun.
                </Text>
              </View>

              {/* ============================================================
                  5. DASAR PERATURAN (bisa dilipat)
                  ============================================================ */}
              <TouchableOpacity
                style={[styles.card, styles.cardSpaced, styles.dasarCard]}
                onPress={() => setDasarTerbuka((v) => !v)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ expanded: dasarTerbuka }}
              >
                <View style={styles.dasarHeadRow}>
                  <Ionicons name="book-outline" size={iconSize.md} color={colors.primary} />
                  <Text style={styles.dasarTitle}>Dasar Penggolongan & Pencadangan</Text>
                  <Ionicons
                    name={dasarTerbuka ? 'chevron-up' : 'chevron-down'}
                    size={iconSize.sm}
                    color={colors.textMuted}
                  />
                </View>
                {dasarTerbuka && (
                  <View style={styles.dasarBody}>
                    <Text style={styles.dasarSubjudul}>
                      Juklat SOM No. 3/2025 angka 12.1 — kriteria pinjaman bermasalah
                    </Text>
                    <Text style={styles.dasarTeks}>
                      Naskah mendefinisikan tiga kategori bermasalah (Kurang Lancar, Diragukan, Macet); Lancar adalah
                      pinjaman yang tidak memenuhi ketiganya. Ambang Kurang Lancar dinyatakan dalam BULAN tunggakan dan
                      berbeda menurut masa angsuran: tunggakan pokok melampaui 1 bulan belum 2 bulan (masa angsuran
                      kurang dari 1 bulan), melampaui 3 belum 6 bulan (masa angsuran 2 sampai 3 bulan), atau melampaui
                      6 belum 12 bulan (masa angsuran 6 bulan atau lebih). Tunggakan bunga: melampaui 1 belum 3 bulan
                      (masa angsuran kurang dari 1 bulan) atau melampaui 3 belum 6 bulan (lebih dari 1 bulan). Pinjaman
                      tanpa angsuran dinilai dari tunggakan bunga (melampaui 3 belum 6 bulan) bila belum jatuh tempo,
                      atau dari lewatnya jatuh tempo (belum melampaui 3 bulan) bila sudah jatuh tempo.
                    </Text>
                    <Text style={styles.dasarTeks}>
                      Melewati ambang Kurang Lancar, pinjaman digolongkan Diragukan bila angsurannya sudah bernilai
                      sekurang-kurangnya {RASIO_ANGSURAN_MINIMUM_DIRAGUKAN}% dari utang peminjam termasuk bunganya
                      (huruf a), ATAU agunannya masih bernilai sekurang-kurangnya {RASIO_AGUNAN_MINIMUM_DIRAGUKAN}%
                      dari utang peminjam (huruf b). Bila tidak memenuhi keduanya, pinjaman digolongkan Macet.
                      Diragukan yang berlanjut {BULAN_DIRAGUKAN_MENJADI_MACET} bulan tanpa pelunasan, dan pinjaman yang
                      penyelesaiannya diserahkan ke Pengadilan Negeri atau diajukan ganti rugi ke asuransi kredit, juga
                      digolongkan Macet. Kriteria terakhir ini dicatat manual oleh Admin/Pengurus di Detail Pinjaman
                      (nomor perkara/klaim dan dokumen) dan berlaku sejak tanggal pencatatan.
                    </Text>
                    <Text style={styles.dasarSubjudul}>
                      Juklat SOM No. 3/2025 angka 15 — taksiran piutang tak tertagih
                    </Text>
                    <Text style={styles.dasarTeks}>
                      Cadangan risiko: Lancar {PERSENTASE_CADANGAN.LANCAR}%, Kurang Lancar{' '}
                      {PERSENTASE_CADANGAN.KURANG_LANCAR}%, Diragukan {PERSENTASE_CADANGAN.DIRAGUKAN}%, Macet{' '}
                      {PERSENTASE_CADANGAN.MACET}% — dikenakan atas saldo pokok penuh, tanpa pengurang agunan.
                    </Text>
                    <Text style={styles.dasarSubjudul}>PMK 74/2024 Pasal 7 & Lampiran</Text>
                    <Text style={styles.dasarTeks}>
                      Batasan cadangan piutang tak tertagih yang boleh dikurangkan dari penghasilan bruto Koperasi
                      Simpan Pinjam: Lancar {PERSENTASE_CADANGAN_FISKAL.LANCAR}%, Kurang Lancar{' '}
                      {PERSENTASE_CADANGAN_FISKAL.KURANG_LANCAR}%, Diragukan {PERSENTASE_CADANGAN_FISKAL.DIRAGUKAN}%,
                      Macet {PERSENTASE_CADANGAN_FISKAL.MACET}%, dihitung atas piutang dikurangi agunan kecuali
                      kategori Lancar. Batas fiskal ini jauh lebih rendah daripada cadangan SOM di atas — selisihnya
                      adalah koreksi fiskal di SPT Badan, bukan kesalahan hitung.
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              <ExportButton
                data={
                  koperasi && periode
                    ? buildKolektibilitasExport(
                        { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                        periode.label,
                        data,
                        // RC-S133.6.3 — angka yang tampil di layar ikut ke berkas:
                        // lingkup anggota, penyisihan tercatat, dan data fiskal (di `data`).
                        {
                          lingkupAnggota: { AKTIF: 'Anggota aktif', TIDAK_AKTIF: 'Anggota nonaktif', SEMUA: 'Semua anggota' }[statusAnggota],
                          penyisihanTercatat: saldoTercatat,
                          tarifFiskal: PERSENTASE_CADANGAN_FISKAL,
                        }
                      )
                    : null
                }
              />

              <SearchField
                wrapStyle={styles.searchBox}
                value={search}
                onChangeText={setSearch}
                placeholder="Cari nama/nomor anggota/nomor pinjaman..."
                placeholderTextColor={colors.placeholder}
              />
              <View style={styles.sectionHeadRow}>
                <Text style={styles.sectionLabel}>Rincian per Pinjaman</Text>
                <Text style={styles.sectionCount}>{dataTampil.length}</Text>
              </View>
            </>
          )}

          {!loading && !error && data.length === 0 && (
            <EmptyState
              icon="document-text-outline"
              title="Belum ada piutang outstanding"
              message="Tidak ada piutang pinjaman outstanding untuk periode & filter ini."
            />
          )}
        </>
      }
      ListEmptyComponent={
        !loading && !error && data.length > 0 ? (
          <EmptyState
            icon="search-outline"
            title="Tidak ada pinjaman yang cocok"
            message="Tidak ada pinjaman yang cocok dengan kategori atau kata pencarian saat ini."
          />
        ) : null
      }
      renderItem={({ item }) => {
        const warna = kolektibilitasColor[item.kolektibilitas];
        const terbuka = barisTerbuka === item.pinjamanId;
        const inisial = item.namaAnggota
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase() ?? '')
          .join('');
        return (
          <TouchableOpacity
            style={[styles.row, { borderLeftColor: warna }]}
            // Rincian penggolongan disembunyikan di balik satu tap alih-alih
            // selalu tampil: daftar tetap bisa dipindai sekilas, tetapi
            // alasan penggolongan tiap pinjaman tetap bisa ditelusuri —
            // yang justru dibutuhkan saat pemeriksaan.
            onPress={() => setBarisTerbuka(terbuka ? null : item.pinjamanId)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ expanded: terbuka }}
          >
            <View style={styles.rowTop}>
              <View style={[styles.avatar, { backgroundColor: tint(warna, 0.14) }]}>
                <Text style={[styles.avatarText, { color: warna }]}>{inisial}</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowNama} numberOfLines={1}>
                  {item.namaAnggota}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {item.nomorAnggota} · {item.nomorPinjaman}
                </Text>
                <View style={styles.rowBadgeRow}>
                  <View style={[styles.rowBadge, { backgroundColor: tint(warna, 0.12) }]}>
                    <Text style={[styles.rowBadgeText, { color: warna }]}>
                      {KOLEKTIBILITAS_LABEL[item.kolektibilitas]} · {item.persentaseCadangan}%
                    </Text>
                  </View>
                  {item.nilaiAgunan > 0 && (
                    <View style={styles.rowBadgeNetral}>
                      <Ionicons name="lock-closed-outline" size={10} color={colors.textMuted} />
                      <Text style={styles.rowBadgeNetralText}>agunan {item.rasioAgunanPersen.toFixed(0)}%</Text>
                    </View>
                  )}
                  {item.rasioAngsuranPersen > 0 && (
                    <View style={styles.rowBadgeNetral}>
                      <Ionicons name="trending-up-outline" size={10} color={colors.textMuted} />
                      <Text style={styles.rowBadgeNetralText}>
                        terbayar {item.rasioAngsuranPersen.toFixed(0)}%
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowPokok}>{formatRupiah(item.saldoPokok)}</Text>
                <Text style={styles.rowCadangan}>Penyisihan {formatRupiah(item.nilaiCadangan)}</Text>
                <Ionicons
                  name={terbuka ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={colors.textFaint}
                  style={styles.rowChevron}
                />
              </View>
            </View>

            {terbuka && (
              <View style={styles.rowDetail}>
                <Text style={[styles.rowDasar, { color: warna }]}>{item.dasarPenggolongan}</Text>
                <DetailBaris
                  label="Pola pengembalian"
                  nilai={item.polaPengembalian === 'TANPA_ANGSURAN' ? 'Tanpa angsuran' : 'Dengan angsuran'}
                />
                <DetailBaris label="Tunggakan pokok" nilai={`${item.bulanTunggakanPokok} bulan`} />
                <DetailBaris label="Tunggakan jasa" nilai={`${item.bulanTunggakanJasa} bulan`} />
                <DetailBaris
                  label="Jatuh tempo tertunggak"
                  nilai={
                    item.tanggalJatuhTempoTertunggak
                      ? `${formatTanggalIndonesia(item.tanggalJatuhTempoTertunggak)} (${item.hariTunggakan} hari)`
                      : 'Tidak menunggak'
                  }
                />
                <DetailBaris
                  label="Saldo piutang (pokok + jasa)"
                  nilai={formatRupiah(item.saldoPiutang)}
                />
                <DetailBaris
                  label={`Angsuran terbayar (kriteria Diragukan a, min. ${RASIO_ANGSURAN_MINIMUM_DIRAGUKAN}%)`}
                  nilai={`${formatRupiah(item.angsuranTerbayar)} dari ${formatRupiah(
                    item.kewajibanKontraktual
                  )} — ${item.rasioAngsuranPersen.toFixed(1)}%`}
                />
                <DetailBaris
                  label={`Nilai agunan (kriteria Diragukan b, min. ${RASIO_AGUNAN_MINIMUM_DIRAGUKAN}%)`}
                  nilai={
                    item.nilaiAgunan > 0
                      ? `${formatRupiah(item.nilaiAgunan)} — ${item.rasioAgunanPersen.toFixed(1)}% dari sisa utang`
                      : 'Tanpa agunan'
                  }
                />
                <DetailBaris
                  label="Batas fiskal PMK 74"
                  nilai={`${LABEL_KOLEKTIBILITAS_FISKAL[item.kolektibilitasFiskal]} ${
                    item.persentaseCadanganFiskal
                  }% · ${formatRupiah(item.cadanganFiskal)}`}
                />
              </View>
            )}
          </TouchableOpacity>
        );
      }}
    />
  );
}

/** Baris label/nilai pada panel rincian satu pinjaman. */
function DetailBaris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailNilai}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { padding: spacing.lg, paddingBottom: 40 },
  loader: { marginVertical: 32 },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.md,
    padding: spacing.md,
    marginVertical: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: 12.5, flexShrink: 1, lineHeight: 18 },

  // ---- Segmented control lingkup anggota ----
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    padding: 3,
    marginBottom: spacing.md,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  segmentItemActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  segmentTextActive: { color: colors.white },

  // ---- Kartu umum ----
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...elevation.card,
  },
  cardSpaced: { marginTop: spacing.md },
  cardTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.md },
  cardTitleBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  cardSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  cardNote: { fontSize: 10.5, color: colors.textFaint, lineHeight: 15, marginTop: spacing.md },
  mutedText: { color: colors.textFaint },
  angka: { fontVariant: ['tabular-nums'] },

  // ---- Hero: kualitas portofolio ----
  heroCard: { paddingBottom: spacing.md },
  heroTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  heroTotal: { flex: 1, minWidth: 0 },
  heroLabel: { fontSize: 12, color: colors.textMuted },
  heroValue: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 3, fontVariant: ['tabular-nums'] },
  heroHint: { fontSize: 10.5, color: colors.textFaint, marginTop: 3 },
  heroCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexShrink: 0,
  },
  heroCountText: { fontSize: 11, fontWeight: '700', color: colors.primary },

  nplBlock: {
    marginTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  nplHeadRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  nplHeadLeft: { flex: 1, minWidth: 0 },
  nplHeadRight: { alignItems: 'flex-end', flexShrink: 0 },
  nplLabel: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  nplSub: { fontSize: 10.5, color: colors.textMuted, marginTop: 1 },
  nplValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  nplPill: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3, marginTop: 3 },
  nplPillText: { fontSize: 10, fontWeight: '700' },

  meterTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.md,
    overflow: 'hidden',
    position: 'relative',
  },
  meterFill: { height: '100%', borderRadius: radius.pill },
  // Penanda acuan: garis tipis gelap di atas track, bukan warna kedua di
  // dalam fill — supaya posisi acuannya tetap terlihat baik saat rasio
  // masih di bawahnya maupun sudah melewatinya.
  meterMark: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.textMuted },
  meterCaptionRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  meterCaption: { fontSize: 10.5, color: colors.textMuted },

  riskBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.border,
    marginTop: spacing.lg,
  },

  // ---- Daftar kategori SOM ----
  kategoriList: { borderTopWidth: 1, borderTopColor: colors.border },
  kategoriRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderRadius: radius.sm,
    gap: spacing.sm,
  },
  kategoriRowLast: { borderBottomWidth: 0 },
  kategoriLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, minWidth: 0 },
  kategoriDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  kategoriDotKecil: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  kategoriTextWrap: { flex: 1, minWidth: 0 },
  kategoriTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  kategoriSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  kategoriRight: { alignItems: 'flex-end', flexShrink: 0 },
  kategoriValue: { fontSize: 13, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  kategoriPct: { fontSize: 10.5, color: colors.textMuted, marginTop: 1 },
  kategoriFunnel: { flexShrink: 0 },
  clearFilterRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: spacing.md },
  clearFilterText: { fontSize: 11.5, color: colors.textMuted, fontWeight: '600' },

  // ---- Pasangan statistik ----
  statPairRow: { flexDirection: 'row', alignItems: 'stretch' },
  statCell: { flex: 1, minWidth: 0 },
  statDivider: { width: 1, backgroundColor: colors.border, marginHorizontal: spacing.md },
  statLabel: { fontSize: 11, color: colors.textMuted },
  statValue: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 3, fontVariant: ['tabular-nums'] },

  deltaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: spacing.md,
  },
  deltaText: { fontSize: 12, color: colors.text, fontWeight: '600', flexShrink: 1 },
  okRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md },
  okText: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    marginTop: spacing.sm,
  },
  primaryButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.6 },

  koreksiBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 10,
    marginTop: spacing.md,
  },
  koreksiText: { fontSize: 11.5, color: colors.text, lineHeight: 16, flexShrink: 1 },

  // ---- Tabel ringkas fiskal ----
  tabelHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  tabelHead: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  tabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  tabelKategoriCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabelSel: { fontSize: 11, color: colors.text },
  colKategori: { flex: 2.4, minWidth: 0 },
  colAngka: { flex: 2.3, textAlign: 'right' },
  colPersen: { flex: 0.8, textAlign: 'right' },

  // ---- Kartu dasar peraturan ----
  dasarCard: { paddingVertical: spacing.md },
  dasarHeadRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dasarTitle: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  dasarBody: { marginTop: spacing.md, gap: spacing.sm },
  dasarSubjudul: { fontSize: 11.5, fontWeight: '700', color: colors.primary },
  dasarTeks: { fontSize: 11, color: colors.textMuted, lineHeight: 17 },

  searchBox: { marginTop: spacing.md },
  sectionHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sectionCount: { fontSize: 11, fontWeight: '700', color: colors.primary },

  // ---- Baris detail per pinjaman ----
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...elevation.card,
  },
  rowTop: { flexDirection: 'row', gap: spacing.sm },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { fontSize: 13, fontWeight: '800' },
  rowBody: { flex: 1, minWidth: 0 },
  rowRight: { alignItems: 'flex-end', flexShrink: 0 },
  rowNama: { fontSize: 14, fontWeight: '700', color: colors.text },
  rowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rowBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  rowBadge: { borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 },
  rowBadgeText: { fontSize: 10.5, fontWeight: '700' },
  rowBadgeNetral: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  rowBadgeNetralText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  rowPokok: { fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowCadangan: { fontSize: 10.5, color: colors.textMuted, marginTop: 2, textAlign: 'right' },
  rowChevron: { marginTop: 4 },

  rowDetail: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowDasar: { fontSize: 11, lineHeight: 16, fontWeight: '600', marginBottom: spacing.sm },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 },
  detailLabel: { fontSize: 11, color: colors.textMuted, flexShrink: 1 },
  detailNilai: { fontSize: 11, color: colors.text, fontWeight: '600', textAlign: 'right', flexShrink: 1 },
});
