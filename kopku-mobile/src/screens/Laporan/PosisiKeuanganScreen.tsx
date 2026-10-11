import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, StyleProp, ViewStyle, TextStyle, TouchableOpacity } from 'react-native';
import { getDb } from '@/database/db';
import { getPosisiKeuangan, getPosisiKeuanganKomparatif, PosisiKeuanganResult, PosisiKeuanganKomparatif } from '@/reports/FinancialReports';
import { formatRupiah, formatPersentasePerubahan } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildPosisiKeuanganExport, buildPosisiKeuanganKomparatifExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import TabelGeser, { SelNilai, lebarTabel, tabelUi, LEBAR_KOLOM_NILAI } from '@/components/report/TabelGeser';
import TombolOpsi from '@/components/report/TombolOpsi';
import EmptyState from '@/components/report/EmptyState';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';
import { tungguTugasStartupSelesai } from '@/services/StartupTasks';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { getWaktuSekarang } from '@/services/DevClockService';
import {
  KODE_BARIS_SHU_BERJALAN,
  URUTAN_PENYAJIAN_ASET,
  URUTAN_PENYAJIAN_EKUITAS,
  urutkanUntukPenyajian,
} from '@/reports/UrutanPenyajianPosisiKeuangan';

/**
 * Laporan Posisi Keuangan (PRD §24) — Aset, Liabilitas, Ekuitas,
 * validasi balance.
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §I): input tanggal
 * mentah "YYYY-MM-DD" (TextInput bebas) diganti `DatePicker` existing
 * + kartu "UNTUK PERIODE" menampilkan tanggal format Indonesia ("17
 * Agustus 2026"), konsisten dengan gaya laporan utama lain.
 *
 * Audit ulang (permintaan pengguna §8/§11): toggle "Termasuk Saldo
 * Awal Draft" ditambahkan — kalau AKTIF, baris Saldo Awal yang masih
 * DRAFT (belum diposting lewat modul Saldo Awal) ikut ditampilkan di
 * Aset/Liabilitas/Ekuitas, dengan banner peringatan jelas bahwa
 * laporan ini BELUM FINAL (draft, bukan jurnal POSTED). Default MATI
 * (perilaku lama tidak berubah) — pengguna harus menyalakannya sendiri.
 */
/**
 * URUTAN PENYAJIAN baris ASET & EKUITAS — dipindah ke
 * `@/reports/UrutanPenyajianPosisiKeuangan` (Poin 9/11) supaya layar dan
 * export PDF/Excel/CSV (tunggal & komparatif) memakai urutan yang sama.
 * PRESENTATION ONLY — lihat dokumentasi di modul tersebut.
 */

export default function PosisiKeuanganScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  // Tanggal lokal aplikasi (bukan `new Date()` mentah) — dipakai juga
  // sebagai dasar default tanggal pembanding di bawah.
  const [asOfDateAwal] = useState(getTanggalLokalHariIni);
  const [asOfDate, setAsOfDate] = useState(asOfDateAwal);
  const [sertakanDraft, setSertakanDraft] = useState(false);
  const [data, setData] = useState<PosisiKeuanganResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // PHASE 6 §B/§P (permintaan pengguna): mode Komparatif — point-in-time
  // (Posisi Keuangan itu sendiri laporan titik-waktu, bukan rentang,
  // lihat komentar getPosisiKeuanganKomparatif) dibanding SATU tanggal
  // pembanding, default sebulan sebelum tanggal berjalan.
  const [komparatif, setKomparatif] = useState(false);
  /**
   * REQUIREMENT 5 (permintaan pengguna) — default periode pembanding
   * TIDAK LAGI dihitung dari `new Date()` (waktu perangkat, lepas dari
   * tanggal laporan yang sedang dilihat). Sebelumnya defaultnya adalah
   * "sebulan sebelum HARI INI", sehingga kalau petugas memilih tanggal
   * laporan 31 Desember 2025, pembandingnya justru jadi tanggal di
   * sekitar hari ini — perbandingan yang tidak setara & menyesatkan.
   *
   * Sekarang default = TANGGAL LAPORAN digeser SATU TAHUN ke belakang,
   * memakai `geserPeriodeSetahunKeBelakang()` — util periode akuntansi
   * yang SUDAH ADA & sudah dipakai layar Laba Rugi/LHU untuk keperluan
   * yang sama (termasuk penanganan 29 Februari). Konvensi tahun-ke-tahun
   * inilah yang lazim untuk Laporan Posisi Keuangan komparatif.
   * Petugas TETAP bebas memilih tanggal pembanding lain.
   */
  const [tanggalPembanding, setTanggalPembanding] = useState(
    () => geserPeriodeSetahunKeBelakang({ mulai: asOfDateAwal, selesai: asOfDateAwal }).selesai
  );
  // REQUIREMENT 5 — kalau petugas belum pernah menyentuh tanggal
  // pembanding, ikutkan otomatis saat tanggal laporan berubah supaya
  // keduanya tidak pernah lepas satu sama lain tanpa disadari.
  const [pembandingDisentuh, setPembandingDisentuh] = useState(false);
  useEffect(() => {
    if (pembandingDisentuh) return;
    setTanggalPembanding(geserPeriodeSetahunKeBelakang({ mulai: asOfDate, selesai: asOfDate }).selesai);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOfDate, pembandingDisentuh]);
  const [dataKomparatif, setDataKomparatif] = useState<PosisiKeuanganKomparatif | null>(null);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(async (date: string, includeDraft: boolean, isKomparatif: boolean, tglPembanding: string) => {
    // §10 — penanda permintaan diambil SEBELUM await apa pun, supaya
    // hasil pemuatan lama tidak pernah menimpa hasil yang lebih baru
    // ketika pengguna cepat fokus/blur atau mengubah filter berkali-kali.
    const token = permintaan.mulai();
    setLoading(true);
    setError(null);
    try {
      // BUG FIRST-OPEN (root cause, lihat StartupTasks.ts): saat aplikasi
      // baru dibuka, penyusutan otomatis & akrual jasa masih MENULIS
      // jurnal di latar belakang pada koneksi SQLite yang SAMA dengan
      // laporan ini. Menghitung laporan di tengah penulisan itu berarti
      // membaca jurnal yang baru punya SEBAGIAN kakinya -> Aset !=
      // Liabilitas + Ekuitas, padahal databasenya sendiri sehat. Begitu
      // pekerjaan latar selesai, jurnalnya utuh dan pembukaan berikutnya
      // kembali 0 — persis gejala "first open != second open".
      //
      // Gate ini menunggu PENYELESAIAN NYATA dari promise pekerjaan
      // tersebut (BUKAN setTimeout/delay yang dikarang, BUKAN toleransi
      // pembulatan). Kalau tidak ada pekerjaan latar yang berjalan —
      // kasus paling umum, termasuk SETIAP pembukaan ulang layar ini —
      // fungsi ini resolve seketika dan tidak menambah latensi apa pun.
      // `loading` tetap true selama menunggu, jadi UI TIDAK PERNAH
      // menampilkan laporan parsial (§5 tiket).
      await tungguTugasStartupSelesai();
      const db = await getDb();
      if (isKomparatif) {
        const result = await getPosisiKeuanganKomparatif(db, date, tglPembanding);
        if (!permintaan.masihTerbaru(token)) return;
        setDataKomparatif(result);
        setData(result.sekarang);
      } else {
        const result = await getPosisiKeuangan(db, date, { sertakanSaldoAwalDraft: includeDraft });
        if (!permintaan.masihTerbaru(token)) return;
        setData(result);
        setDataKomparatif(null);
      }
    } catch (e) {
      // §12 — kegagalan refresh TIDAK menimpa data valid dengan angka 0.
      // `data` dibiarkan apa adanya; hanya `error` yang diisi, dan layar
      // menampilkan status error, bukan laporan berisi nol yang tampak
      // sah padahal bukan hasil perhitungan.
      if (!permintaan.masihTerbaru(token)) return;
      setError(e instanceof Error ? e.message : 'Gagal memuat laporan.');
    } finally {
      if (permintaan.masihTerbaru(token)) setLoading(false);
    }
  }, [permintaan]);

  // §4/§20 — SATU lifecycle otoritatif. `useEffect` DIGANTI (bukan
  // ditambahi) `useFocusEffect`: native-stack tidak meng-unmount layar
  // yang ditinggalkan, jadi efek berbasis dependensi filter tidak pernah
  // berjalan ulang saat pengguna kembali dari mencatat transaksi.
  // `useFocusEffect` menjalankan callback saat layar difokuskan DAN saat
  // filter berubah selagi fokus, sehingga mencakup keduanya tanpa
  // menggandakan kueri.
  const muat = useCallback(() => {
    load(asOfDate, sertakanDraft, komparatif, tanggalPembanding);
  }, [load, asOfDate, sertakanDraft, komparatif, tanggalPembanding]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1/§A2 — TOMBOL REFRESH MANUAL.
  //
  // Memakai `muat` yang SAMA dengan initial load & focus refresh di
  // atas: satu sumber fungsi load, tidak ada kueri kedua yang dibuat
  // khusus untuk tombol. `loading` layar dipakai sebagai penguncian
  // tap sekaligus indikator — bukan state loading baru.
  useReportRefreshHeader(muat, { loading, testID: 'refresh-posisi-keuangan' });

  /**
   * REQUIREMENT 5 — baris per seksi disiapkan SEKALI di sini untuk kedua
   * mode, supaya komponen render tidak perlu tahu mode apa yang aktif.
   *
   * Mode tunggal: `saldoPembanding` selalu 0 dan tidak pernah dirender.
   * Mode komparatif: union kode dari KEDUA periode (akun yang hanya ada
   * di salah satu sisi tetap tampil dengan saldo 0 di sisi lain).
   *
   * BUG FIX (REQUIREMENT 5): baris SHU/laba tahun berjalan
   * (`labaBerjalan`) SEKARANG ikut ditambahkan pada mode KOMPARATIF
   * juga. Sebelumnya baris ini hanya dirender di mode tunggal, padahal
   * nilainya SUDAH termasuk dalam `totalEkuitas` di kedua mode — jadi
   * rincian Ekuitas mode komparatif tidak pernah menjumlah ke Total
   * Ekuitas-nya sendiri setiap kali ada laba berjalan.
   */
  const barisSeksi = useMemo(() => {
    const kosong = { aset: [] as BarisPosisi[], liabilitas: [] as BarisPosisi[], ekuitas: [] as BarisPosisi[] };
    if (!data) return kosong;

    const gabung = (
      sekarang: { kode: string; nama: string; saldo: number }[],
      pembanding: { kode: string; nama: string; saldo: number }[] | undefined
    ): BarisPosisi[] => {
      if (!pembanding) {
        return sekarang.map((r) => ({ kode: r.kode, nama: r.nama, saldo: r.saldo, saldoPembanding: 0 }));
      }
      const pembandingMap = new Map(pembanding.map((r) => [r.kode, r]));
      const kodeSekarang = new Set(sekarang.map((r) => r.kode));
      return [
        ...sekarang.map((r) => ({
          kode: r.kode,
          nama: r.nama,
          saldo: r.saldo,
          saldoPembanding: pembandingMap.get(r.kode)?.saldo ?? 0,
        })),
        ...pembanding
          .filter((r) => !kodeSekarang.has(r.kode))
          .map((r) => ({ kode: r.kode, nama: r.nama, saldo: 0, saldoPembanding: r.saldo })),
      ];
    };

    const pembandingData = komparatif ? dataKomparatif?.pembanding : undefined;
    const ekuitas = gabung(data.ekuitas, pembandingData?.ekuitas);
    const labaSekarang = data.labaBerjalan;
    const labaPembanding = pembandingData?.labaBerjalan ?? 0;
    if (labaSekarang !== 0 || labaPembanding !== 0) {
      // RC-S133.6.2 — baris SHU dapat DIKETUK untuk menampilkan rinciannya:
      // SHU tahun sebelumnya yang belum dibagikan + SHU tahun berjalan.
      // Jumlah rincian = angka baris (dari service, tidak dihitung ulang).
      const rs = data.rincianLabaBerjalan;
      const rp = pembandingData?.rincianLabaBerjalan ?? null;
      const rincian =
        rs || rp
          ? [
              {
                kunci: 'sebelumnya',
                nama: 'SHU tahun sebelumnya yang belum dibagikan',
                saldo: rs?.shuTahunSebelumnya ?? 0,
                saldoPembanding: rp?.shuTahunSebelumnya ?? 0,
              },
              {
                kunci: 'berjalan',
                nama: `SHU tahun berjalan${rs ? ` (tahun buku ${rs.tahunBuku})` : ''}`,
                saldo: rs?.shuTahunBerjalan ?? 0,
                saldoPembanding: rp?.shuTahunBerjalan ?? 0,
              },
            ]
          : undefined;
      ekuitas.push({
        // Poin 9 — kode penanda: baris SHU disajikan tepat di bawah Cadangan Risiko.
        kode: KODE_BARIS_SHU_BERJALAN,
        nama: data.labaBerjalanLabel,
        saldo: labaSekarang,
        saldoPembanding: labaPembanding,
        rincian,
      });
    }

    return {
      // RC-S49 — HANYA baris ASET yang diurutkan ulang untuk penyajian
      // (lihat URUTAN_PENYAJIAN_ASET). LIABILITAS & EKUITAS dibiarkan
      // apa adanya: urutan kode akunnya sudah sesuai urutan penyajian
      // yang diminta.
      aset: urutkanUntukPenyajian(gabung(data.aset, pembandingData?.aset), URUTAN_PENYAJIAN_ASET),
      liabilitas: gabung(data.liabilitas, pembandingData?.liabilitas),
      // RC-S53 §X — EKUITAS ikut diurutkan untuk penyajian, dengan helper
      // yang PERSIS SAMA. Poin 9: baris SHU tahun berjalan memakai kode
      // penanda terdaftar sehingga tampil tepat di bawah Cadangan Risiko,
      // di mode tunggal maupun komparatif.
      ekuitas: urutkanUntukPenyajian(ekuitas, URUTAN_PENYAJIAN_EKUITAS),
    };
  }, [data, dataKomparatif, komparatif]);

  const jumlahKolomNilai = komparatif ? 2 : 1;
  // Mode tunggal: tabel selebar layar, TIDAK dapat digeser (satu kolom
  // nominal selalu muat). Hanya mode komparatif yang dapat digeser.
  const kolomAkun = komparatif ? tabelUi.kolomAkun : styles.kolomAkunPenuh;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        {/* KOP LAPORAN */}
        <View style={styles.kop}>
          <Text style={styles.title}>Laporan Posisi Keuangan</Text>
          {koperasi?.nama ? <Text style={styles.sub}>{koperasi.nama}</Text> : null}
          <View style={styles.periodeCard}>
            <Text style={styles.periodeLabel}>UNTUK PERIODE</Text>
            <Text style={styles.periodeValue}>{formatTanggalIndonesia(asOfDate)}</Text>
            {komparatif ? (
              <Text style={styles.periodeBanding}>dibandingkan dengan {formatTanggalIndonesia(tanggalPembanding)}</Text>
            ) : null}
          </View>
        </View>

        {/* PENGATURAN LAPORAN */}
        <View style={styles.pengaturan}>
          <Text style={styles.label}>Tanggal Laporan</Text>
          <DatePicker value={asOfDate} onChange={setAsOfDate} maximumDate={getWaktuSekarang()} />

          <Text style={[styles.label, { marginTop: spacing.md }]}>Opsi Tampilan</Text>
          <View style={styles.opsiRow}>
            <TombolOpsi
              testID="opsi-komparatif"
              ikon="git-compare-outline"
              label="Mode Komparatif"
              keterangan="Bandingkan 2 tanggal"
              aktif={komparatif}
              onPress={() => setKomparatif((v) => !v)}
            />
            <TombolOpsi
              testID="opsi-saldo-awal-draf"
              ikon="document-text-outline"
              label="Saldo Awal Draf"
              keterangan={komparatif ? 'Tidak untuk komparatif' : 'Belum diposting'}
              aktif={!komparatif && sertakanDraft}
              disabled={komparatif}
              onPress={() => setSertakanDraft((v) => !v)}
            />
          </View>

          {komparatif && (
            <View style={{ marginTop: spacing.md }}>
              <Text style={styles.label}>Tanggal Pembanding</Text>
              <DatePicker
                value={tanggalPembanding}
                onChange={(v) => {
                  setPembandingDisentuh(true);
                  setTanggalPembanding(v);
                }}
                maximumDate={getWaktuSekarang()}
              />
              {dataKomparatif?.peringatanPeriode && (
                <View style={[styles.draftBanner, { marginTop: spacing.sm, marginBottom: 0 }]}>
                  <Ionicons name="warning-outline" size={iconSize.sm} color={colors.warning} />
                  <Text style={styles.draftBannerText}>{dataKomparatif.peringatanPeriode}</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
        {!loading && error && <Text style={styles.errorText}>{error}</Text>}

        {/* SATU layout laporan untuk kedua mode (REQUIREMENT 5): komponen
            <SeksiPosisi/> yang SAMA, mode komparatif hanya menambah kolom. */}
        {!loading && !error && data && (
          <>
            {data.termasukSaldoAwalDraft && (
              <View style={styles.draftBanner}>
                <Ionicons name="warning-outline" size={iconSize.sm} color={colors.warning} />
                <Text style={styles.draftBannerText}>
                  Termasuk Saldo Awal Draft — laporan ini BELUM FINAL. Saldo awal yang ditampilkan belum diposting
                  sebagai jurnal; nilainya bisa berubah sampai benar-benar diposting lewat menu Saldo Awal.
                </Text>
              </View>
            )}

            <ExportButton
              data={
                koperasi
                  ? komparatif && dataKomparatif
                    ? buildPosisiKeuanganKomparatifExport(
                        { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                        dataKomparatif
                      )
                    : buildPosisiKeuanganExport(
                        { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                        data
                      )
                  : null
              }
            />

            {barisSeksi.aset.length === 0 &&
            barisSeksi.liabilitas.length === 0 &&
            barisSeksi.ekuitas.length === 0 ? (
              <EmptyState message="Belum ada mutasi jurnal sampai tanggal ini." />
            ) : (
              <TabelGeser lebarMinimum={lebarTabel(jumlahKolomNilai)} geser={komparatif}>
                <View style={tabelUi.header}>
                  <Text style={[tabelUi.th, kolomAkun]}>Akun</Text>
                  <Text style={[tabelUi.th, tabelUi.thNilai]} numberOfLines={1}>
                    {komparatif ? formatTanggalIndonesia(asOfDate) : 'Saldo'}
                  </Text>
                  {komparatif && (
                    <Text style={[tabelUi.th, tabelUi.thNilai]} numberOfLines={1}>
                      {formatTanggalIndonesia(tanggalPembanding)}
                    </Text>
                  )}
                </View>

                <SeksiPosisi
                  title="ASET"
                  komparatif={komparatif}
                  kolomAkun={kolomAkun}
                  rows={barisSeksi.aset}
                  total={data.totalAset}
                  totalPembanding={dataKomparatif?.pembanding.totalAset}
                />
                <SeksiPosisi
                  title="LIABILITAS"
                  komparatif={komparatif}
                  kolomAkun={kolomAkun}
                  rows={barisSeksi.liabilitas}
                  total={data.totalLiabilitas}
                  totalPembanding={dataKomparatif?.pembanding.totalLiabilitas}
                />
                <SeksiPosisi
                  title="EKUITAS"
                  komparatif={komparatif}
                  kolomAkun={kolomAkun}
                  rows={barisSeksi.ekuitas}
                  total={data.totalEkuitas}
                  totalPembanding={dataKomparatif?.pembanding.totalEkuitas}
                />

                <View style={tabelUi.total}>
                  <Text style={[tabelUi.labelTebal, kolomAkun]}>Total Aset</Text>
                  <SelNilai style={tabelUi.nilaiUtama}>{formatRupiah(data.totalAset)}</SelNilai>
                  {komparatif && dataKomparatif && (
                    <SelNilai style={[tabelUi.nilaiTebal, tabelUi.nilaiRedup]}>
                      {formatRupiah(dataKomparatif.pembanding.totalAset)}
                    </SelNilai>
                  )}
                </View>
                <View style={[tabelUi.total, { borderTopWidth: 0 }]}>
                  <Text style={[tabelUi.labelTebal, kolomAkun]}>Total Liabilitas + Ekuitas</Text>
                  <SelNilai style={tabelUi.nilaiUtama}>{formatRupiah(data.totalLiabilitas + data.totalEkuitas)}</SelNilai>
                  {komparatif && dataKomparatif && (
                    <SelNilai style={[tabelUi.nilaiTebal, tabelUi.nilaiRedup]}>
                      {formatRupiah(dataKomparatif.pembanding.totalLiabilitas + dataKomparatif.pembanding.totalEkuitas)}
                    </SelNilai>
                  )}
                </View>
              </TabelGeser>
            )}

            {/* Balance check ada di KEDUA mode (REQUIREMENT 5). */}
            <View style={[styles.validationBanner, data.isBalanced ? styles.validationOk : styles.validationWarn]}>
              {data.isBalanced ? <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />}
              <Text style={styles.validationText}>
                {data.isBalanced
                  ? `Seimbang — Aset = Liabilitas + Ekuitas${komparatif ? ' (periode berjalan)' : ''}`
                  : `TIDAK SEIMBANG — selisih ${formatRupiah(Math.abs(data.selisih))}`}
              </Text>
            </View>
            {komparatif && dataKomparatif && (
              <View
                style={[
                  styles.validationBanner,
                  dataKomparatif.pembanding.isBalanced ? styles.validationOk : styles.validationWarn,
                  { marginTop: spacing.sm },
                ]}
              >
                {dataKomparatif.pembanding.isBalanced ? <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />}
                <Text style={styles.validationText}>
                  {dataKomparatif.pembanding.isBalanced
                    ? 'Seimbang — periode komparatif'
                    : `PERIODE KOMPARATIF TIDAK SEIMBANG — selisih ${formatRupiah(
                        Math.abs(dataKomparatif.pembanding.selisih)
                      )}`}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

interface BarisPosisi {
  kode: string;
  nama: string;
  saldo: number;
  saldoPembanding: number;
  /** RC-S133.6.2 — rincian yang muncul bila baris diketuk (baris SHU). */
  rincian?: { kunci: string; nama: string; saldo: number; saldoPembanding: number }[];
}

/**
 * REQUIREMENT 5 — SATU komponen seksi untuk KEDUA mode laporan.
 *
 * Sebelumnya ada dua komponen terpisah (`Section` & `SectionKomparatif`)
 * dengan tata letak yang sangat berbeda: mode komparatif menumpuk nilai
 * pembanding sebagai teks "vs Rp..." di bawah nilai berjalan, bukan
 * sebagai KOLOM. Akibatnya kedua mode terlihat seperti dua laporan yang
 * berbeda dan kolomnya tidak pernah sejajar. Sekarang keduanya memakai
 * grid kolom yang sama; mode komparatif hanya menambah satu kolom.
 *
 * §S.10 (dipertahankan): akun yang hanya ada di salah satu periode TETAP
 * tampil, dengan saldo 0 di sisi yang tidak punya baris tersebut — tidak
 * pernah disembunyikan.
 */
function SeksiPosisi({
  title,
  rows,
  total,
  totalPembanding,
  komparatif,
  kolomAkun,
}: {
  title: string;
  rows: BarisPosisi[];
  total: number;
  totalPembanding?: number;
  komparatif: boolean;
  kolomAkun: StyleProp<ViewStyle & TextStyle>;
}) {
  const [terbuka, setTerbuka] = useState<Record<string, boolean>>({});
  if (rows.length === 0) return null;
  return (
    <View>
      <View style={tabelUi.seksi}>
        <Text style={tabelUi.seksiText}>{title}</Text>
      </View>
      {rows.map((r, idx) => (
        <React.Fragment key={`${r.kode}-${idx}`}>
        <TouchableOpacity
          activeOpacity={r.rincian ? 0.6 : 1}
          disabled={!r.rincian}
          onPress={() => setTerbuka((t) => ({ ...t, [r.kode]: !t[r.kode] }))}
          accessibilityRole={r.rincian ? 'button' : undefined}
          accessibilityState={r.rincian ? { expanded: !!terbuka[r.kode] } : undefined}
          testID={r.rincian ? 'baris-shu-posisi' : undefined}
          style={[tabelUi.baris, idx % 2 === 1 && tabelUi.barisGenap]}
        >
          {/* RC-S50 §1 — kode akun TIDAK dirender (hanya nama); `r.kode`
              tetap dipakai internal untuk key, penggabungan & urutan. */}
          <View style={[kolomAkun, r.rincian ? styles.namaDenganIkon : null]}>
            <Text style={styles.rowNama}>{r.nama}</Text>
            {r.rincian ? (
              <Ionicons
                name={terbuka[r.kode] ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={colors.primary}
                style={styles.ikonRincian}
              />
            ) : null}
          </View>
          {/* Nilai ditampilkan APA ADANYA (tanpa Math.abs) — saldo negatif
              tetap negatif; warna & label "Negatif" hanya indikator. */}
          <View style={styles.nilaiKolom}>
            <SelNilai style={r.saldo < 0 && styles.rowValueNegative}>{formatRupiah(r.saldo)}</SelNilai>
            {r.saldo < 0 && (
              <View style={styles.negatifTag}>
                <Ionicons name="warning-outline" size={11} color={colors.danger} />
                <Text style={styles.negativeWarning}>Negatif</Text>
              </View>
            )}
          </View>
          {komparatif && (
            <View style={styles.nilaiKolom}>
              <SelNilai style={r.saldoPembanding < 0 && styles.rowValueNegative}>{formatRupiah(r.saldoPembanding)}</SelNilai>
              <Text style={styles.komparatifPerubahan} numberOfLines={1}>
                {r.saldo - r.saldoPembanding >= 0 ? '+' : ''}
                {formatPersentasePerubahan(r.saldo, r.saldoPembanding)}
              </Text>
            </View>
          )}
        </TouchableOpacity>
        {r.rincian && terbuka[r.kode]
          ? r.rincian.map((d) => (
              <View key={d.kunci} style={[tabelUi.baris, styles.barisRincian]} testID={`rincian-shu-posisi-${d.kunci}`}>
                <View style={kolomAkun}>
                  <Text style={styles.rincianNama}>{d.nama}</Text>
                </View>
                <View style={styles.nilaiKolom}>
                  <SelNilai style={[styles.rincianNilai, d.saldo < 0 && styles.rowValueNegative]}>{formatRupiah(d.saldo)}</SelNilai>
                </View>
                {komparatif && (
                  <View style={styles.nilaiKolom}>
                    <SelNilai style={[styles.rincianNilai, d.saldoPembanding < 0 && styles.rowValueNegative]}>
                      {formatRupiah(d.saldoPembanding)}
                    </SelNilai>
                  </View>
                )}
              </View>
            ))
          : null}
        </React.Fragment>
      ))}
      <View style={tabelUi.subtotal}>
        <Text style={[tabelUi.labelTebal, kolomAkun]}>Total {title}</Text>
        <SelNilai style={tabelUi.nilaiTebal}>{formatRupiah(total)}</SelNilai>
        {komparatif && <SelNilai style={tabelUi.nilaiTebal}>{formatRupiah(totalPembanding ?? 0)}</SelNilai>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: { marginBottom: spacing.md },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  periodeCard: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  periodeLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.5 },
  periodeValue: { fontSize: 18, fontWeight: '700', color: colors.primary, marginTop: 2 },
  periodeBanding: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  pengaturan: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  label: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginBottom: spacing.xs, letterSpacing: 0.3, textTransform: 'uppercase' },
  // Poin 16 — flexWrap: tombol turun baris di layar sempit, teks tidak terpotong.
  opsiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  nilaiKolom: { width: LEBAR_KOLOM_NILAI, alignItems: 'flex-end' },
  kolomAkunPenuh: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  komparatifPerubahan: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 1 },
  draftBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  draftBannerText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17, fontWeight: '600' },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  rowNama: { fontSize: 13, color: colors.text, flex: 1 },
  // RC-S133.6.2 — baris SHU yang dapat diketuk & rinciannya.
  namaDenganIkon: { flexDirection: 'row', alignItems: 'center' },
  ikonRincian: { marginLeft: 4 },
  barisRincian: { backgroundColor: colors.primaryLight },
  rincianNama: { fontSize: 12, color: colors.textMuted, paddingLeft: spacing.md },
  rincianNilai: { fontSize: 12, color: colors.textMuted },
  rowValueNegative: { color: colors.danger, fontWeight: '700' },
  negatifTag: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1 },
  negativeWarning: { fontSize: 10, color: colors.danger },
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
  validationText: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'center' },
});
