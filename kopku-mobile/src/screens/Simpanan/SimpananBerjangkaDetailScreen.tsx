import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatRupiah } from '@/utils/money';
import {
  getSimpananBerjangka,
  SimpananBerjangkaRow,
} from '@/services/SimpananBerjangkaService';
import {
  getPencairanDiniKontrak,
  previewPencairanDini,
  PreviewPencairanDini,
  SettlementDiniRow,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { getAnggotaById, Anggota } from '@/repositories/AnggotaRepository';
import { colors, elevation, radius, spacing } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { tentukanAksiPencairanDini } from './aksiPencairanDini';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { getRincianBungaKontrak, RincianBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { getDataBuktiPencairan, getDataBuktiPenempatan } from '@/services/SimpananBerjangkaDokumenService';
import { buildBuktiPencairanHtml, buildBuktiPenempatanHtml, tanggalPanjang } from '@/export/SimpananBerjangkaDokumenBuilder';
import { exportDokumenHtmlPdf, shareExportedFile } from '@/services/ExportService';
import { formatPersen } from '@/accounting/SimpananBerjangkaKebijakanProduk';
import CaraKerjaBerjangka from '@/components/simpanan/CaraKerjaBerjangka';
import {
  GAYA_STATUS_BERJANGKA,
  LANGKAH_KONTRAK,
  penjelasanKontrak,
  tahapKontrak,
  tanggalPendek,
  teksSukuBunga,
  WARNA_BERJANGKA,
} from './tampilanBerjangka';

/**
 * ============================================================
 * DETAIL KONTRAK SIMPANAN BERJANGKA (RC-S47 §E/§F/§I/§J/§P · RC-S129)
 * ============================================================
 *
 * RC-S129 — tata letak disusun ulang supaya pengurus langsung tahu
 * "kontrak ini sedang di tahap apa dan apa langkah berikutnya":
 *   1. kartu utama: anggota, pokok, status, dan penunjuk tahap kontrak;
 *   2. penjelasan status dalam bahasa sehari-hari (`penjelasanKontrak`);
 *   3. aksi (cairkan / tarik sebelum jatuh tempo) diletakkan di atas;
 *   4. rincian bunga per sumber & tujuan, rincian kontrak, kebijakan
 *      produk, dokumen, dan riwayat pencairan.
 *
 * YANG TIDAK DILAKUKAN LAYAR INI, DAN ITU DISENGAJA.
 *
 * 1. TIDAK ADA PERHITUNGAN. Setiap angka dibaca apa adanya dari
 *    subledger (`getSimpananBerjangka`) atau dari hasil service
 *    (`getRincianBungaKontrak`, `previewPencairanDini`,
 *    `getPencairanDiniKontrak`).
 * 2. TIDAK ADA CALCULATOR BARU (§F). CTA membuka `TarikSimpananForm` —
 *    layar eksekusi yang SUDAH ADA.
 * 3. TIDAK ADA KEPUTUSAN KELAYAKAN LOKAL (§U). Hidup/matinya CTA
 *    ditentukan `tentukanAksiPencairanDini()`.
 * 4. TIDAK ADA TOMBOL BACK LOKAL (§M). Native stack header sudah
 *    menyediakan back yang benar.
 *
 * REFRESH BERBASIS FOKUS (§H) lewat `useFocusRefresh` (konvensi proyek).
 */

export default function SimpananBerjangkaDetailScreen({ route }: { route?: any }) {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const kontrakId: string | undefined = route?.params?.kontrakId;

  const [kontrak, setKontrak] = useState<SimpananBerjangkaRow | null>(null);
  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [settlementDini, setSettlementDini] = useState<SettlementDiniRow | null>(null);
  const [preview, setPreview] = useState<PreviewPencairanDini | null>(null);
  const [rincian, setRincian] = useState<RincianBungaKontrak | null>(null);
  const [mencetak, setMencetak] = useState<'PENEMPATAN' | 'PENCAIRAN' | null>(null);
  const currentUser = useAppStore((s) => s.currentUser);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const muat = useCallback(async () => {
    if (!kontrakId) {
      setError('Kontrak simpanan berjangka tidak ditemukan.');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setError(null);
    try {
      const row = await getSimpananBerjangka(kontrakId);
      if (!row) {
        setKontrak(null);
        setError('Kontrak simpanan berjangka tidak ditemukan.');
        return;
      }
      setKontrak(row);
      const [ang, dini] = await Promise.all([
        getAnggotaById(row.anggotaId),
        getPencairanDiniKontrak(row.id),
      ]);
      setAnggota(ang);
      setSettlementDini(dini);
      setRincian(row.status === 'DIBATALKAN' ? null : await getRincianBungaKontrak(row.id, getTanggalLokalHariIni()));
      // Preview HANYA untuk kontrak yang masih berjalan: ia yang
      // membawa evaluasi kebijakan terbaru & alasan penolakan.
      if (row.status === 'AKTIF') {
        setPreview(await previewPencairanDini(row.id, getTanggalLokalHariIni()));
      } else {
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat detail simpanan berjangka.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [kontrakId]);

  useFocusRefresh(() => {
    muat();
  }, [muat]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !kontrak) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textFaint} />
        <Text style={styles.errorText}>{error ?? 'Kontrak tidak ditemukan.'}</Text>
      </View>
    );
  }

  const aksi = tentukanAksiPencairanDini({
    statusKontrak: kontrak.status,
    sudahJatuhTempo: preview?.sudahJatuhTempo ?? false,
    evaluasi: preview?.statusKebijakan ?? null,
    alasanTidakBoleh: preview?.alasanTidakBoleh ?? null,
    adaSettlement: !!preview?.settlement,
  });

  const bukaFormPencairan = () =>
    navigation.navigate('TarikSimpananForm', {
      jenis: 'BERJANGKA',
      anggotaId: kontrak.anggotaId,
      kontrakId: kontrak.id,
    });

  /**
   * RC-S128 — cetak dari DATA TERSIMPAN: loader membaca kontrak, snapshot
   * kebijakan, jurnal, dan bukti potong; layar hanya meneruskan id.
   */
  const cetak = async (jenis: 'PENEMPATAN' | 'PENCAIRAN') => {
    if (!currentUser) return;
    setMencetak(jenis);
    try {
      const tanggalCetak = tanggalPanjang(getTanggalLokalHariIni());
      const file =
        jenis === 'PENEMPATAN'
          ? await (async () => {
              const d = await getDataBuktiPenempatan(kontrak.id);
              return exportDokumenHtmlPdf(currentUser.id, () => buildBuktiPenempatanHtml(d, { tanggalCetak }), `bukti-penempatan-${kontrak.nomorTransaksi}`);
            })()
          : await (async () => {
              const d = await getDataBuktiPencairan(kontrak.id);
              return exportDokumenHtmlPdf(currentUser.id, () => buildBuktiPencairanHtml(d, { tanggalCetak }), `bukti-pencairan-${kontrak.nomorTransaksi}`);
            })();
      await shareExportedFile(file);
    } catch (e) {
      notify('Gagal mencetak', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMencetak(null);
    }
  };

  const sudahJatuhTempo = kontrak.status === 'JATUH_TEMPO' || !!preview?.sudahJatuhTempo;
  const masihBerjalan = kontrak.status === 'AKTIF' || kontrak.status === 'JATUH_TEMPO';
  const gaya = GAYA_STATUS_BERJANGKA[kontrak.status];
  const tahap = tahapKontrak(kontrak.status, sudahJatuhTempo);
  const penjelasan = penjelasanKontrak({
    status: kontrak.status,
    sudahJatuhTempo,
    tanggalJatuhTempo: kontrak.tanggalJatuhTempo,
    tanggalPencairan: kontrak.tanggalPencairan,
    ratePerTahun: kontrak.sukuBungaPerTahun,
    bungaPascaAktif: rincian ? (rincian.kebijakan.policyVersi ? rincian.kebijakan.bungaPascaAktif : null) : kontrak.bungaPascaAktif,
    ratePasca: rincian ? rincian.kebijakan.ratePascaJatuhTempo : kontrak.ratePascaJatuhTempo,
  });
  const tanggalTahap = [tanggalPendek(kontrak.tanggalMulai), '', tanggalPendek(kontrak.tanggalJatuhTempo), kontrak.tanggalPencairan ? tanggalPendek(kontrak.tanggalPencairan) : ''];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl + insets.bottom }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            muat();
          }}
        />
      }
    >
      {/* --- 1. Kartu utama ----------------------------------------- */}
      <View style={styles.hero}>
        <View style={styles.headerRow}>
          <Text style={styles.heroNomor}>{kontrak.nomorTransaksi}</Text>
          <View style={[styles.statusPill, { backgroundColor: gaya.latar }]}>
            <Ionicons name={gaya.ikon} size={12} color={gaya.warna} />
            <Text style={[styles.statusPillText, { color: gaya.warna }]}>
              {gaya.label} · {gaya.arti}
            </Text>
          </View>
        </View>
        <Text style={styles.heroNama}>{anggota?.namaLengkap ?? '-'}</Text>
        <Text style={styles.heroSub}>No. anggota {anggota?.nomorAnggota ?? '-'}</Text>
        <Text style={styles.nominalKeterangan}>Pokok penempatan</Text>
        <Text style={styles.nominalBesar}>{formatRupiah(kontrak.nominal)}</Text>
        <View style={styles.heroFakta}>
          <Fakta ikon="time-outline" teks={`${kontrak.tenorBulan} bulan`} />
          <Fakta ikon="trending-up-outline" teks={teksSukuBunga(kontrak.sukuBungaPerTahun)} />
          <Fakta ikon="calendar-outline" teks={`JT ${tanggalPendek(kontrak.tanggalJatuhTempo)}`} />
        </View>

        {tahap >= 0 ? (
          <View style={styles.langkahBaris} accessibilityLabel={`Tahap kontrak: ${LANGKAH_KONTRAK[tahap]}`}>
            {LANGKAH_KONTRAK.map((l, i) => (
              <View key={l} style={styles.langkah}>
                <View style={styles.langkahGarisWadah}>
                  <View style={[styles.langkahGaris, i === 0 && styles.transparan, i <= tahap && styles.langkahGarisAktif]} />
                  <View style={[styles.langkahTitik, i <= tahap && styles.langkahTitikAktif, i === tahap && styles.langkahTitikKini]}>
                    {i < tahap ? <Ionicons name="checkmark" size={10} color={colors.white} /> : null}
                  </View>
                  <View style={[styles.langkahGaris, i === LANGKAH_KONTRAK.length - 1 && styles.transparan, i < tahap && styles.langkahGarisAktif]} />
                </View>
                <Text style={[styles.langkahLabel, i === tahap && styles.langkahLabelKini]}>{l}</Text>
                {tanggalTahap[i] ? <Text style={styles.langkahTanggal}>{tanggalTahap[i]}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* --- 2. Penjelasan status ------------------------------------ */}
      <View style={[styles.penjelasan, { borderLeftColor: gaya.warna }]}>
        <Ionicons name="information-circle" size={20} color={gaya.warna} />
        <View style={{ flex: 1 }}>
          <Text style={styles.penjelasanJudul}>{penjelasan.judul}</Text>
          <Text style={styles.penjelasanIsi}>{penjelasan.isi}</Text>
        </View>
      </View>

      {/* --- 3a. §J — kontrak matur memakai pencairan NORMAL --------- */}
      {sudahJatuhTempo && kontrak.status !== 'DICAIRKAN' && kontrak.status !== 'DIBATALKAN' && (
        <Seksi judul="Jatuh Tempo" ikon="alarm-outline">
          <Text style={styles.aksiAlasan}>
            Kontrak ini sudah mencapai tanggal jatuh tempo. Pencairannya memakai jalur pencairan
            normal — bukan pencairan sebelum jatuh tempo. Uang yang keluar dari kas hanya sebesar pokok.
          </Text>
          <TouchableOpacity
            style={styles.cta}
            onPress={bukaFormPencairan}
            accessibilityRole="button"
            accessibilityLabel="Cairkan Simpanan Berjangka"
          >
            <Ionicons name="cash-outline" size={18} color={colors.white} />
            <Text style={styles.ctaText}>Cairkan Simpanan Berjangka</Text>
          </TouchableOpacity>
        </Seksi>
      )}

      {/* --- 3b. §F/§I — pencairan sebelum jatuh tempo -------------- */}
      {aksi.tampilkanSeksi && (
        <Seksi judul="Pencairan Sebelum Jatuh Tempo" ikon="exit-outline">
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.badge,
                aksi.badge === 'TERSEDIA' ? styles.badgeTersedia : styles.badgeTertahan,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  aksi.badge === 'TERSEDIA'
                    ? styles.badgeTextTersedia
                    : styles.badgeTextTertahan,
                ]}
              >
                {aksi.badge}
              </Text>
            </View>
            <Text style={styles.aksiJudul}>{aksi.judul}</Text>
          </View>

          <Text style={styles.aksiAlasan}>{aksi.ringkasAlasan}</Text>
          {/* Penjelasan panjang berasal dari domain, bukan dari layar. */}
          {aksi.detailAlasan && <Text style={styles.aksiDetail}>{aksi.detailAlasan}</Text>}

          <TouchableOpacity
            style={[styles.cta, styles.ctaSekunder, !aksi.ctaAktif && styles.ctaDisabled]}
            onPress={bukaFormPencairan}
            disabled={!aksi.ctaAktif}
            accessibilityRole="button"
            accessibilityState={{ disabled: !aksi.ctaAktif }}
            accessibilityLabel={aksi.ctaLabel}
          >
            <Ionicons name="cash-outline" size={18} color={aksi.ctaAktif ? colors.primary : colors.white} />
            <Text style={[styles.ctaText, aksi.ctaAktif && styles.ctaTextSekunder]}>{aksi.ctaLabel}</Text>
          </TouchableOpacity>

          {!aksi.ctaAktif && (
            <Text style={styles.ctaHint}>
              Tombol ini aktif setelah pengurus menetapkan kebijakan penarikan dini secara lengkap
              melalui Tarik Simpanan Anggota › Kebijakan Penarikan Dini, dan kebijakan itu
              mengizinkan pencairan sebelum jatuh tempo.
            </Text>
          )}
        </Seksi>
      )}

      {/* --- 4. Bunga (RC-S128: dibedakan per sumber & tujuan) ------- */}
      <Seksi judul="Bunga" ikon="trending-up-outline">
        <Baris
          label="Suku Bunga Kontrak"
          nilai={teksSukuBunga(kontrak.sukuBungaPerTahun)}
        />
        {kontrak.sukuBungaPerTahun > 0 || kontrak.bungaTerakru > 0 ? (
          <Baris label="Bunga Terakru" nilai={formatRupiah(kontrak.bungaTerakru)} tebal />
        ) : null}
        {rincian ? (
          <>
            <Text style={styles.subJudul}>Dari mana bunganya</Text>
            <BarisWarna warna={WARNA_BERJANGKA.bungaTenor} label="Bunga Selama Tenor" nilai={formatRupiah(rincian.bungaSelamaTenor)} sub={`dari rencana ${formatRupiah(rincian.totalBungaKontrak)}`} />
            <BarisWarna
              warna={WARNA_BERJANGKA.bungaPasca}
              label="Bunga Pasca Jatuh Tempo"
              nilai={formatRupiah(rincian.bungaPascaJatuhTempo)}
              sub={rincian.jumlahPeriodePasca > 0 ? `${rincian.jumlahPeriodePasca} bulan` : rincian.kebijakan.bungaPascaAktif ? 'belum ada bulan penuh' : 'tidak berlaku untuk kontrak ini'}
            />
            <Text style={styles.subJudul}>Ke mana bunganya</Text>
            <BarisWarna warna={colors.success} label="Bunga Sudah Masuk Simpanan Sukarela" nilai={formatRupiah(rincian.bungaSudahKeSukarela)} sub={`neto diterima anggota ${formatRupiah(rincian.netoKeSukarela)}`} />
            <BarisWarna warna={WARNA_BERJANGKA.jatuhTempo} label="Bunga Belum Dipindahkan" nilai={formatRupiah(rincian.bungaBelumDipindahkan)} sub="dipindahkan otomatis pada proses berikutnya" />
            <BarisWarna warna={colors.textMuted} label="Total PPh Pasal 4(2)" nilai={formatRupiah(rincian.totalPph)} sub="dipotong sesuai aturan pajak, bukti potong di menu Pajak" />
            {rincian.bungaDibayarTunaiSaatPencairan > 0 ? (
              <Baris label="Bunga Dibayar Tunai saat Pencairan" nilai={formatRupiah(rincian.bungaDibayarTunaiSaatPencairan)} />
            ) : null}
            <BarisWarna warna={colors.primary} label="Pokok (tidak pernah ditambah bunga)" nilai={formatRupiah(rincian.pokok)} />
            <View style={styles.infoKecil}>
              <Ionicons name="sync-outline" size={14} color={colors.textMuted} />
              <Text style={styles.infoKecilTeks}>
                Dihitung otomatis · terakhir untuk periode s.d. {rincian.tanggalPerhitunganTerakhir ? tanggalPendek(rincian.tanggalPerhitunganTerakhir) : '— (belum ada bulan penuh)'}
              </Text>
            </View>
            {rincian.periodeBerikutnya ? (
              <Text style={styles.catatan}>
                Bulan berikutnya selesai {tanggalPendek(rincian.periodeBerikutnya.tanggalAkhir)}:{' '}
                {rincian.periodeBerikutnya.jenis === 'KONTRAK' ? 'bunga kontrak' : 'bunga pasca jatuh tempo'}{' '}
                {formatRupiah(rincian.periodeBerikutnya.bunga)}. Bunga diakui per bulan kalender penuh (tanpa prorata) lalu
                dipindahkan ke Simpanan Sukarela setelah PPh.
              </Text>
            ) : null}
          </>
        ) : null}
      </Seksi>

      {/* --- 5. Rincian kontrak -------------------------------------- */}
      <Seksi judul="Rincian Kontrak" ikon="document-text-outline">
        <Baris label="Nama Anggota" nilai={anggota?.namaLengkap ?? '-'} />
        <Baris label="Nomor Anggota" nilai={anggota?.nomorAnggota ?? '-'} />
        <Baris label="Pokok" nilai={formatRupiah(kontrak.nominal)} />
        {/* Sisa pokok RELEVAN hanya selama kontrak belum dibayarkan.
            Nilainya dibaca dari subledger, bukan dihitung ulang. */}
        {masihBerjalan && <Baris label="Sisa Pokok" nilai={formatRupiah(kontrak.nominal)} />}
        <Baris label="Tenor" nilai={String(kontrak.tenorBulan)} />
        <Baris label="Satuan Tenor" nilai="Bulan" />
        <Baris label="Tanggal Mulai" nilai={tanggalPendek(kontrak.tanggalMulai)} />
        <Baris label="Tanggal Jatuh Tempo" nilai={tanggalPendek(kontrak.tanggalJatuhTempo)} />
        <Baris label="Sumber Dana" nilai={kontrak.sumberDana === 'BANK' ? 'Bank' : 'Kas'} />
        {kontrak.keterangan ? <Baris label="Keterangan" nilai={kontrak.keterangan} /> : null}
      </Seksi>

      {/* --- 6. Kebijakan produk (snapshot kontrak) ------------------ */}
      {rincian ? (
        <Seksi judul="Kebijakan Produk" ikon="shield-checkmark-outline">
          {rincian.kebijakan.policyVersi ? (
            <>
              <Baris label="Versi" nilai={rincian.kebijakan.policyVersi} />
              <Baris label="Perpanjangan Otomatis" nilai={rincian.kebijakan.autoRenewal ? 'Ya' : 'Tidak'} />
              <Baris
                label="Bunga Pasca Jatuh Tempo"
                nilai={rincian.kebijakan.bungaPascaAktif && rincian.kebijakan.ratePascaJatuhTempo ? `${formatPersen(rincian.kebijakan.ratePascaJatuhTempo)} per tahun` : 'Tidak'}
              />
              {rincian.kebijakan.pascaMulaiEfektif ? <Baris label="Diterapkan Efektif" nilai={tanggalPendek(rincian.kebijakan.pascaMulaiEfektif)} /> : null}
              <Text style={styles.catatan}>Ketentuan ini disalin ke kontrak saat penempatan; perubahan kebijakan koperasi berikutnya tidak mengubahnya.</Text>
            </>
          ) : (
            <>
              <View style={styles.peringatan}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
                <Text style={styles.peringatanTeks}>
                  Kontrak lama — dibuat sebelum kebijakan produk tersedia. Tidak ada bunga pasca jatuh tempo sampai pengurus menerapkan
                  kebijakan secara tercatat.
                </Text>
              </View>
              <TouchableOpacity onPress={() => navigation.navigate('KebijakanProdukBerjangka')} accessibilityRole="button" style={styles.tautanBaris}>
                <Text style={styles.tautan}>Tinjau di Kebijakan Produk</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.primary} />
              </TouchableOpacity>
            </>
          )}
        </Seksi>
      ) : null}

      {/* --- 7. Dokumen ---------------------------------------------- */}
      {kontrak.status !== 'DIBATALKAN' ? (
        <Seksi judul="Dokumen" ikon="print-outline">
          <TouchableOpacity style={styles.tombolDok} onPress={() => cetak('PENEMPATAN')} disabled={!!mencetak} accessibilityRole="button">
            <View style={styles.tombolDokIkon}>
              {mencetak === 'PENEMPATAN' ? <ActivityIndicator color={colors.primary} size="small" /> : <Ionicons name="document-outline" size={18} color={colors.primary} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.tombolDokTeks}>Cetak Bukti Penempatan</Text>
              <Text style={styles.tombolDokSub}>PDF untuk ditandatangani anggota & ketua, salinan untuk anggota</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          {kontrak.status === 'DICAIRKAN' && !settlementDini ? (
            <TouchableOpacity style={[styles.tombolDok, styles.tombolDokGaris]} onPress={() => cetak('PENCAIRAN')} disabled={!!mencetak} accessibilityRole="button">
              <View style={styles.tombolDokIkon}>
                {mencetak === 'PENCAIRAN' ? <ActivityIndicator color={colors.primary} size="small" /> : <Ionicons name="receipt-outline" size={18} color={colors.primary} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.tombolDokTeks}>Cetak Bukti Pencairan</Text>
                <Text style={styles.tombolDokSub}>Pokok dicairkan, bunga ke Simpanan Sukarela, PPh, dan nomor jurnal</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </Seksi>
      ) : null}

      {/* --- 8. Riwayat pencairan ------------------------------------ */}
      {kontrak.status === 'DICAIRKAN' && (
        <Seksi judul="Pencairan" ikon="checkmark-done-outline">
          <Baris label="Tanggal Pencairan" nilai={tanggalPendek(kontrak.tanggalPencairan)} />
          <Baris label="Jenis Pencairan" nilai={settlementDini ? 'Sebelum jatuh tempo' : 'Jatuh tempo'} />
          {settlementDini && (
            <>
              <Baris label="Versi Kebijakan Dini" nilai={settlementDini.policyVersi} />
              <Baris label="Total Diterima Anggota" nilai={formatRupiah(settlementDini.totalPayout)} />
              {settlementDini.alasan ? (
                <Baris label="Alasan Penarikan Dini" nilai={settlementDini.alasan} />
              ) : null}
              <Text style={styles.catatan}>
                Rincian lengkap potongan pencairan dini (penalti, bunga hangus, biaya
                administrasi, penyesuaian rate) ditampilkan pada daftar Simpanan Berjangka,
                dibaca apa adanya dari settlement yang dibukukan saat transaksi terjadi.
              </Text>
            </>
          )}
        </Seksi>
      )}

      <View style={{ marginTop: spacing.lg }}>
        <CaraKerjaBerjangka />
      </View>
    </ScrollView>
  );
}

function Seksi({ judul, ikon, children }: { judul: string; ikon?: keyof typeof Ionicons.glyphMap; children: React.ReactNode }) {
  return (
    <View style={styles.seksi}>
      <View style={styles.seksiKepala}>
        {ikon ? <Ionicons name={ikon} size={15} color={colors.primary} /> : null}
        <Text style={styles.seksiJudul}>{judul}</Text>
      </View>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Fakta({ ikon, teks }: { ikon: keyof typeof Ionicons.glyphMap; teks: string }) {
  return (
    <View style={styles.fakta}>
      <Ionicons name={ikon} size={13} color={colors.primary} />
      <Text style={styles.faktaTeks} numberOfLines={1}>
        {teks}
      </Text>
    </View>
  );
}

function BarisWarna({ warna, label, nilai, sub }: { warna: string; label: string; nilai: string; sub?: string }) {
  return (
    <View style={[styles.barisWarna, { borderLeftColor: warna }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.barisLabel}>{label}</Text>
        {sub ? <Text style={styles.barisSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.barisNilai}>{nilai}</Text>
    </View>
  );
}

function Baris({ label, nilai, tebal }: { label: string; nilai: string; tebal?: boolean }) {
  return (
    <View style={styles.baris}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={[styles.barisNilai, tebal && styles.barisNilaiTebal]}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  errorText: { color: colors.danger, textAlign: 'center', fontSize: 13 },
  hero: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...elevation.card,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  heroNomor: { fontSize: 12, color: colors.textMuted, fontWeight: '700', flexShrink: 1 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { fontSize: 11, fontWeight: '700' },
  heroNama: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  heroSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  nominalKeterangan: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md },
  nominalBesar: { fontSize: 26, fontWeight: '800', color: colors.primary, marginTop: 1 },
  heroFakta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  fakta: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primaryLight, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  faktaTeks: { fontSize: 12, fontWeight: '600', color: colors.text },
  langkahBaris: { flexDirection: 'row', marginTop: spacing.lg },
  langkah: { flex: 1, alignItems: 'center' },
  langkahGarisWadah: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  langkahGaris: { flex: 1, height: 2, backgroundColor: colors.border },
  langkahGarisAktif: { backgroundColor: colors.primary },
  transparan: { backgroundColor: 'transparent' },
  langkahTitik: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langkahTitikAktif: { borderColor: colors.primary, backgroundColor: colors.primary },
  langkahTitikKini: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: colors.primaryLight },
  langkahLabel: { fontSize: 10, color: colors.textMuted, marginTop: 4, textAlign: 'center' },
  langkahLabelKini: { color: colors.primary, fontWeight: '800' },
  langkahTanggal: { fontSize: 9, color: colors.textFaint, textAlign: 'center', marginTop: 1 },
  penjelasan: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  penjelasanJudul: { fontSize: 13, fontWeight: '800', color: colors.text },
  penjelasanIsi: { fontSize: 12, color: colors.text, lineHeight: 18, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
  },
  seksi: { marginTop: spacing.lg },
  seksiKepala: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm },
  seksiJudul: { fontSize: 13, fontWeight: '700', color: colors.primary },
  subJudul: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: spacing.md, marginBottom: 2 },
  baris: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, gap: spacing.md },
  barisLabel: { fontSize: 12, color: colors.textMuted },
  barisNilai: { fontSize: 12, fontWeight: '600', color: colors.text, flexShrink: 1, textAlign: 'right' },
  barisNilaiTebal: { fontWeight: '800', fontSize: 13 },
  barisWarna: { flexDirection: 'row', alignItems: 'center', borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 6, marginVertical: 3, gap: 8 },
  barisSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  infoKecil: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md },
  infoKecilTeks: { flex: 1, fontSize: 11, color: colors.textMuted },
  catatan: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  peringatan: { flexDirection: 'row', gap: 6, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm },
  peringatanTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  tautanBaris: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 6 },
  tautan: { color: colors.primary, fontWeight: '700', fontSize: 13, paddingVertical: 4 },
  tombolDok: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 8 },
  tombolDokGaris: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingVertical: 12 },
  tombolDokIkon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  tombolDokTeks: { color: colors.text, fontWeight: '700', fontSize: 13 },
  tombolDokSub: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  badge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTersedia: { backgroundColor: colors.primaryLight },
  badgeTertahan: { backgroundColor: colors.dangerBg },
  badgeText: { fontSize: 10, fontWeight: '700' },
  badgeTextTersedia: { color: colors.primary },
  badgeTextTertahan: { color: colors.danger },
  aksiJudul: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  aksiAlasan: { fontSize: 12, color: colors.text, lineHeight: 17 },
  aksiDetail: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.sm },
  cta: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  ctaSekunder: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.primary },
  ctaDisabled: { backgroundColor: colors.disabled, borderColor: colors.disabled },
  ctaText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  ctaTextSekunder: { color: colors.primary },
  ctaHint: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.sm },
});
