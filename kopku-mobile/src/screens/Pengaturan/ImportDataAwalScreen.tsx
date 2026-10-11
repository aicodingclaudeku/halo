import React, { useMemo, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DatePicker from '@/components/DatePicker';
import PanduanImportSlide from '@/components/panduan/PanduanImportSlide';
import {
  HasilImportDataAwal,
  JUDUL_SHEET,
  LABEL_SHEET,
  RingkasanParse,
  jalankanImportDataAwal,
  pilihBerkasExcel,
  pratinjauBerkasDataAwal,
  ambilRekeningBankAktif,
  ambilNikTerdaftar,
  ambilSidikTercatat,
  ambilAnggotaTerdaftar,
  unduhTemplateDataAwal,
} from '@/services/ImportDataAwalService';
import { bandingkanSidik, hitungSidikBerkas, type SidikTercatat } from '@/import/SidikImport';
import {
  URUTAN_PROSES,
  ambilHasilSheet,
  JUDUL_SHEET_SALDO_AWAL_AKUN,
  LABEL_SHEET_SALDO_AWAL_AKUN,
  type GalatBaris,
  type RekeningBankAktif,
} from '@/import/ExcelDataAwalParser';
import type { JenisTemplateDataAwal } from '@/import/TemplateDataAwal';
import {
  DAFTAR_PERIKSA,
  adaBlokir,
  hariSebelumIso,
  periksaSebelumImport,
  tanggalPanjang,
  type PeringatanImport,
} from '@/import/PanduanImportData';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, iconSize, elevation } from '@/theme/colors';
import { ui } from '@/theme/ui';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatRupiah } from '@/utils/money';
import { CATATAN_SALDO_AWAL_OTOMATIS } from '@/import/SaldoAwalOtomatisPlan';
import { KETERBATASAN_MIGRASI_ASET } from '@/import/MigrasiAsetPlan';

/**
 * Layar "Import Data Awal" — memasukkan anggota, simpanan, simpanan
 * berjangka, pinjaman, aset, jasa dibayar, dan saldo awal akun dari satu
 * berkas Excel.
 *
 * RC-S133.4.7 — UI/UX DIRAPIKAN (tampilan saja; aturan baca & tulis TIDAK
 * berubah). Alurnya kini dibaca sebagai empat langkah bernomor dengan
 * penanda kemajuan di atas:
 *
 *   1. JENIS DATA  — dipilih PALING AWAL (Saldo lama / Transaksi baru),
 *                    karena jawabannya menentukan template yang diunduh,
 *                    arti kolom, dan cara import. Untuk Saldo lama, tanggal
 *                    cut-off ditampilkan terang-terangan (dulu tersembunyi
 *                    di "Pengaturan lanjutan" padahal menentukan apakah
 *                    sebuah baris dicatat sebagai saldo atau transaksi kas).
 *   2. TEMPLATE    — satu tombol unduh yang SESUAI pilihan, tombol panduan
 *                    slide beranimasi, dan daftar periksa sebelum memilih
 *                    berkas.
 *   3. PERIKSA     — hasil per sheet dalam bentuk ubin, kesalahan per baris
 *                    (dapat dibuka seluruhnya), ditambah PEMERIKSAAN
 *                    TAMBAHAN (`periksaSebelumImport`) untuk kesalahan yang
 *                    lolos parser: baris contoh lupa dihapus, berkas Saldo
 *                    Lama diimpor sebagai Transaksi Baru, judul kolom tidak
 *                    dikenali, tanggal pada/setelah cut-off, dsb.
 *   4. IMPORT      — ringkasan apa yang akan dikerjakan; tombol terkunci
 *                    selama ada kesalahan ATAU peringatan tingkat BLOKIR.
 *
 * Yang diimpor tetap PERSIS objek pratinjau yang sedang ditampilkan, lewat
 * `jalankanImportDataAwal` yang sama. Layar ini tidak memuat aturan bisnis:
 * pembacaan di `ExcelDataAwalParser`, penulisan di `EksekusiImportDataAwal`.
 */
export default function ImportDataAwalScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  /**
   * RC-S100 — PINTU MASUK RIWAYAT: IKON SAJA DI POJOK KANAN ATAS.
   * `navigation.setOptions` di `useLayoutEffect` supaya tombolnya hanya
   * hidup bersama layar ini.
   */
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => navigation.navigate('RiwayatImport')}
          accessibilityRole="button"
          accessibilityLabel="Riwayat hasil import"
          testID="tombol-riwayat-import"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.ikonHeader}
        >
          <Ionicons name="time-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const [namaBerkas, setNamaBerkas] = useState<string | null>(null);
  const [ringkasan, setRingkasan] = useState<RingkasanParse | null>(null);
  /** RC-S133.6.1 — rekening bank aktif saat berkas dipilih (null = belum dibaca). */
  const [rekeningAktif, setRekeningAktif] = useState<RekeningBankAktif[] | null>(null);
  const [nikTerdaftar, setNikTerdaftar] = useState<string[] | null>(null);
  /** RC-S133.6.2 — sidik baris berkas ini yang sudah pernah diimpor (null = belum dibaca). */
  const [sidikTercatat, setSidikTercatat] = useState<Map<string, SidikTercatat> | null>(null);
  const [anggotaTerdaftar, setAnggotaTerdaftar] = useState<
    { nomorAnggota: string; nama: string; tanggalBergabung: string | null }[] | null
  >(null);
  const [hasil, setHasil] = useState<HasilImportDataAwal | null>(null);
  const [sibuk, setSibuk] = useState<null | 'TEMPLATE' | 'BACA' | 'IMPORT'>(null);
  const [kemajuan, setKemajuan] = useState<{ selesai: number; total: number } | null>(null);
  /**
   * RC-S103 — SIFAT DATA DI BERKAS: Saldo lama (bawaan) atau Transaksi baru.
   *   SALDO_AWAL — cut-off bawaan HARI INI; baris bertanggal sebelum
   *     cut-off masuk jalur saldo awal (kas tidak bergerak).
   *   TRANSAKSI_BARU — tanpa cut-off; perilaku pencatatan biasa beserta
   *     seluruh pemeriksaan kelayakan & likuiditas.
   */
  const [sifatData, setSifatData] = useState<'SALDO_AWAL' | 'TRANSAKSI_BARU'>('SALDO_AWAL');
  const [ubahCutOff, setUbahCutOff] = useState(false);
  const [cutOffManual, setCutOffManual] = useState('');
  const [panduanTerbuka, setPanduanTerbuka] = useState(false);
  const [centang, setCentang] = useState<Record<string, boolean>>({});
  const [galatTerbuka, setGalatTerbuka] = useState<Record<string, boolean>>({});

  /**
   * Cut-off yang benar-benar dikirim ke eksekutor. Untuk SALDO_AWAL,
   * default-nya HARI INI — lewat `getTanggalLokalHariIni()` yang mengikuti
   * jam simulasi (penjaga RC-S95).
   */
  const hariIni = getTanggalLokalHariIni();
  const cutOffEfektif =
    sifatData === 'TRANSAKSI_BARU' ? undefined : cutOffManual.trim() || getTanggalLokalHariIni();
  const jenisTemplate: JenisTemplateDataAwal = sifatData === 'SALDO_AWAL' ? 'SALDO_LAMA' : 'TRANSAKSI_BARU';
  const namaTemplate = sifatData === 'SALDO_AWAL' ? 'Template Saldo Lama' : 'Template Transaksi Baru';

  /** Pemeriksaan tambahan atas pratinjau (tidak mengubah `ringkasan`). */
  const peringatan: PeringatanImport[] = useMemo(
    () =>
      ringkasan
        ? periksaSebelumImport(ringkasan, {
            sifat: sifatData,
            cutOff: cutOffEfektif,
            rekeningBank: rekeningAktif ?? undefined,
            nikTerdaftar: nikTerdaftar ?? undefined,
            sidikTercatat: sidikTercatat ?? undefined,
            anggotaTerdaftar: anggotaTerdaftar ?? undefined,
          })
        : [],
    [ringkasan, sifatData, cutOffEfektif, rekeningAktif, nikTerdaftar, sidikTercatat, anggotaTerdaftar]
  );
  /** RC-S133.6.2 — jumlah baris yang akan dilewati karena sudah pernah diimpor. */
  const jumlahDilewati = useMemo(
    () => (ringkasan && sidikTercatat ? bandingkanSidik(hitungSidikBerkas(ringkasan.hasil), sidikTercatat).sudah.length : 0),
    [ringkasan, sidikTercatat]
  );
  const terblokir = adaBlokir(peringatan);
  const bisaImport = !!ringkasan && ringkasan.siapDiimpor && !terblokir;

  const unduhTemplate = async (jenis: JenisTemplateDataAwal) => {
    setSibuk('TEMPLATE');
    try {
      const { fileName } = await unduhTemplateDataAwal(jenis);
      notify('Template dibuat', `${fileName} sudah disiapkan. Isi di Excel, lalu kembali ke layar ini.`);
    } catch (e) {
      notify('Gagal membuat template', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSibuk(null);
    }
  };

  const pilihDanBaca = async () => {
    setSibuk('BACA');
    try {
      const berkas = await pilihBerkasExcel();
      if (!berkas) return; // dibatalkan pengguna — bukan galat
      // Hasil import lama dibersihkan supaya tidak terbaca sebagai hasil berkas baru.
      setHasil(null);
      setGalatTerbuka({});
      const r = await pratinjauBerkasDataAwal(berkas.uri);
      // RC-S133.6.1 — rekening aktif dibaca ulang setiap berkas dipilih,
      // supaya pemeriksaan kolom Rekening Bank memakai keadaan terbaru.
      setRekeningAktif(await ambilRekeningBankAktif());
      setNikTerdaftar(await ambilNikTerdaftar());
      // RC-S133.6.2 — pemeriksaan import ganda berbasis isi (gagal tertutup:
      // bila sidik tidak dapat dibaca, pratinjau dibatalkan dengan pesan).
      setSidikTercatat(await ambilSidikTercatat(r));
      setAnggotaTerdaftar(await ambilAnggotaTerdaftar());
      setNamaBerkas(berkas.nama);
      setRingkasan(r);
    } catch (e) {
      setRingkasan(null);
      setNamaBerkas(null);
      notify(
        'Gagal membaca berkas',
        e instanceof Error ? e.message : 'Pastikan berkas yang dipilih adalah Excel (.xlsx).'
      );
    } finally {
      setSibuk(null);
    }
  };

  const konfirmasiImport = () => {
    if (!ringkasan || !currentUser || !bisaImport) return;
    const jalur =
      sifatData === 'SALDO_AWAL'
        ? `sebagai SALDO LAMA dengan cut-off ${tanggalPanjang(cutOffEfektif as string)}`
        : 'sebagai TRANSAKSI BARU (kas/bank ikut bergerak)';
    notify(
      'Mulai Import Data Awal?',
      `${ringkasan.totalBarisSah - jumlahDilewati} baris dari "${namaBerkas ?? 'berkas'}" akan dimasukkan ${jalur}. ` +
        (jumlahDilewati > 0 ? `${jumlahDilewati} baris yang sudah pernah diimpor akan DILEWATI. ` : '') +
        'Disarankan sudah membuat Backup lebih dulu. Lanjutkan?',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Import', style: 'destructive', onPress: jalankan },
      ]
    );
  };

  const jalankan = async () => {
    if (!ringkasan || !currentUser) return;
    setSibuk('IMPORT');
    setKemajuan({ selesai: 0, total: ringkasan.totalBarisSah });
    try {
      const h = await jalankanImportDataAwal(ringkasan, {
        createdBy: currentUser.id,
        onKemajuan: (selesai, total) => setKemajuan({ selesai, total }),
        // RC-S100 — ikut tersimpan di riwayat.
        namaBerkas,
        // RC-S102 — kosong berarti tanpa migrasi (perilaku lama).
        tanggalCutOff: cutOffEfektif,
      });
      setHasil(h);
      // Pratinjau dikosongkan supaya tombol Import tidak bisa ditekan dua
      // kali untuk berkas yang sama — penyebab data ganda yang paling mudah.
      setRingkasan(null);
      notify(
        h.totalGagal === 0 ? 'Import selesai' : 'Import selesai sebagian',
        `${h.totalBerhasil} baris berhasil, ${h.totalGagal} baris gagal` +
          ((h.totalDilewati ?? 0) > 0 ? `, ${h.totalDilewati} baris dilewati (sudah pernah diimpor).` : '.')
      );
    } catch (e) {
      notify('Import gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSibuk(null);
      setKemajuan(null);
    }
  };

  const perSheetPratinjau = ringkasan
    ? URUTAN_PROSES.map((jenis) => {
        // RC-S108 — pemetaan eksplisit, bukan rantai ternary ber-fallback.
        const s = ambilHasilSheet(ringkasan.hasil, jenis);
        return { jenis, label: LABEL_SHEET[jenis], judul: JUDUL_SHEET[jenis], sheet: s };
      }).sort((a, b) => a.judul.localeCompare(b.judul))
    : [];
  const sheet7 = ringkasan?.hasil.saldoAwalAkun ?? null;

  // ---- penanda kemajuan ----
  type StatusLangkah = 'SELESAI' | 'AKTIF' | 'NANTI';
  const statusLangkah: StatusLangkah[] = [
    'SELESAI',
    ringkasan || hasil ? 'SELESAI' : 'AKTIF',
    hasil || bisaImport ? 'SELESAI' : ringkasan ? 'AKTIF' : 'NANTI',
    hasil ? 'SELESAI' : bisaImport ? 'AKTIF' : 'NANTI',
  ];

  const daftarPeriksa = DAFTAR_PERIKSA[jenisTemplate];
  const jumlahDicentang = daftarPeriksa.filter((d) => centang[`${jenisTemplate}:${d}`]).length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={[ui.screenContent, styles.isiLayar]}>
      {/* ================= PENGANTAR + PANDUAN ================= */}
      <View style={styles.hero}>
        <View style={styles.heroIkon}>
          <Ionicons name="documents-outline" size={22} color={colors.primary} />
        </View>
        <View style={styles.heroBody}>
          <Text style={styles.heroJudul}>Import Data Awal dari Excel</Text>
          <Text style={styles.heroSub}>
            Masukkan anggota, simpanan, pinjaman, dan saldo koperasi sekaligus dari satu berkas. Data diperiksa
            dulu — tidak ada yang tersimpan sebelum Anda menekan Import.
          </Text>
          <TouchableOpacity
            style={styles.tombolPanduan}
            onPress={() => setPanduanTerbuka(true)}
            accessibilityRole="button"
            testID="tombol-panduan-import"
          >
            <Ionicons name="play-circle" size={18} color={colors.white} />
            <Text style={styles.tombolPanduanTeks}>Panduan Pengisian (slide)</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Stepper status={statusLangkah} />

      {/* ================= LANGKAH 1: JENIS DATA ================= */}
      <KartuLangkah nomor={1} judul="Pilih jenis data" sub="Menentukan template, arti kolom, dan cara import." status={statusLangkah[0]}>
        <View style={styles.pilihanGrid}>
          {(
            [
              {
                nilai: 'SALDO_AWAL' as const,
                ikon: 'archive-outline' as const,
                judul: 'Saldo lama',
                lencana: 'Untuk data awal',
                sub: 'Koperasi yang sudah berjalan. Yang dimasukkan posisi saldo per tanggal cut-off. Kas tidak bergerak karena uangnya sudah lama berpindah.',
                isi: 'Sheet 1–7',
              },
              {
                nilai: 'TRANSAKSI_BARU' as const,
                ikon: 'swap-horizontal-outline' as const,
                judul: 'Transaksi baru',
                lencana: null,
                sub: 'Koperasi baru atau transaksi yang uangnya bergerak sekarang. Setiap baris dicatat seperti input menu biasa: kas bertambah atau berkurang.',
                isi: 'Sheet 1–4',
              },
            ] as const
          ).map((p) => {
            const aktif = sifatData === p.nilai;
            return (
              <TouchableOpacity
                key={p.nilai}
                style={[styles.pilihan, aktif && styles.pilihanAktif]}
                onPress={() => setSifatData(p.nilai)}
                accessibilityRole="radio"
                accessibilityState={{ selected: aktif }}
                activeOpacity={0.85}
              >
                <View style={styles.pilihanKepala}>
                  <View style={[styles.pilihanIkon, aktif && styles.pilihanIkonAktif]}>
                    <Ionicons name={p.ikon} size={18} color={aktif ? colors.white : colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.pilihanJudul, aktif && { color: colors.primary }]}>{p.judul}</Text>
                    <Text style={styles.pilihanIsi}>{p.isi}</Text>
                  </View>
                  <Ionicons
                    name={aktif ? 'radio-button-on' : 'radio-button-off'}
                    size={iconSize.md}
                    color={aktif ? colors.primary : colors.textFaint}
                  />
                </View>
                {p.lencana ? (
                  <View style={styles.lencanaSaran}>
                    <Text style={styles.lencanaSaranTeks}>{p.lencana}</Text>
                  </View>
                ) : null}
                <Text style={styles.pilihanSub}>{p.sub}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tanggal cut-off — terlihat, bukan tersembunyi. */}
        {sifatData === 'SALDO_AWAL' && (
          <View style={styles.cutOffKotak}>
            <View style={styles.cutOffBaris}>
              <Ionicons name="calendar-outline" size={iconSize.md} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.cutOffLabel}>Tanggal cut-off (hari pertama pembukuan di KOPKU)</Text>
                <Text style={styles.cutOffNilai} testID="nilai-cut-off">
                  {tanggalPanjang(cutOffEfektif as string)}
                  {cutOffManual.trim() ? '' : ' · hari ini'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setUbahCutOff((v) => !v)} accessibilityRole="button" style={styles.cutOffUbah}>
                <Text style={styles.cutOffUbahTeks}>{ubahCutOff ? 'Tutup' : 'Ubah'}</Text>
              </TouchableOpacity>
            </View>
            {ubahCutOff && (
              <View style={styles.cutOffEditor}>
                <DatePicker value={cutOffManual} onChange={setCutOffManual} />
                {cutOffManual.trim() !== '' && (
                  <TouchableOpacity onPress={() => setCutOffManual('')} accessibilityRole="button">
                    <Text style={styles.tautan}>Kembalikan ke hari ini ({tanggalPanjang(hariIni)})</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            <View style={styles.cutOffPetunjuk}>
              <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
              <Text style={styles.cutOffPetunjukTeks}>
                Isi semua saldo di berkas per akhir hari{' '}
                <Text style={styles.tebal}>{tanggalPanjang(hariSebelumIso(cutOffEfektif as string))}</Text>. Tanggal di
                berkas harus sebelum cut-off. Baris pada/setelah cut-off diproses sebagai transaksi baru.
              </Text>
            </View>
          </View>
        )}
      </KartuLangkah>

      {/* ================= LANGKAH 2: TEMPLATE ================= */}
      <KartuLangkah
        nomor={2}
        judul="Unduh & isi template"
        sub={`${namaTemplate} sudah berisi petunjuk, catatan di setiap judul kolom, dan baris contoh berwarna kuning.`}
        status={statusLangkah[1]}
      >
        <TouchableOpacity
          style={[styles.tombolUtama, sibuk !== null && styles.disabled]}
          onPress={() => unduhTemplate(jenisTemplate)}
          disabled={sibuk !== null}
          accessibilityRole="button"
          testID="tombol-unduh-template"
        >
          {sibuk === 'TEMPLATE' ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="download-outline" size={iconSize.sm} color={colors.white} />
              <Text style={styles.tombolUtamaText}>Unduh {namaTemplate}</Text>
            </>
          )}
        </TouchableOpacity>
        <View style={styles.tombolBaris}>
          <TouchableOpacity
            style={[styles.tombolSekunder, styles.tombolFleksibel]}
            onPress={() => setPanduanTerbuka(true)}
            accessibilityRole="button"
          >
            <Ionicons name="play-circle-outline" size={iconSize.sm} color={colors.primary} />
            <Text style={styles.tombolSekunderText}>Panduan Pengisian</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tombolNetral, styles.tombolFleksibel]}
            onPress={() => navigation.navigate('StrukturTemplate', { jenis: jenisTemplate })}
            disabled={sibuk !== null}
            accessibilityRole="button"
          >
            <Ionicons name="grid-outline" size={iconSize.sm} color={colors.textMuted} />
            <Text style={styles.tombolNetralText}>Struktur Kolom</Text>
          </TouchableOpacity>
        </View>

        {/* Daftar periksa sebelum memilih berkas — bantu ingat, tidak mengunci apa pun. */}
        <View style={styles.periksaKotak}>
          <View style={styles.periksaKepala}>
            <Text style={styles.periksaJudul}>Sebelum memilih berkas, pastikan:</Text>
            <Text style={styles.periksaHitung}>
              {jumlahDicentang}/{daftarPeriksa.length}
            </Text>
          </View>
          {daftarPeriksa.map((d) => {
            const k = `${jenisTemplate}:${d}`;
            const ya = !!centang[k];
            return (
              <TouchableOpacity
                key={k}
                style={styles.periksaBaris}
                onPress={() => setCentang((c) => ({ ...c, [k]: !c[k] }))}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: ya }}
              >
                <Ionicons name={ya ? 'checkbox' : 'square-outline'} size={18} color={ya ? colors.primary : colors.textFaint} />
                <Text style={[styles.periksaTeks, ya && styles.periksaTeksSelesai]}>{d}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </KartuLangkah>

      {/* ================= LANGKAH 3: PILIH & PERIKSA ================= */}
      <KartuLangkah
        nomor={3}
        judul="Pilih berkas & periksa"
        sub="Berkas hanya diperiksa. Belum ada data yang tersimpan sampai Anda menekan Import."
        status={statusLangkah[2]}
      >
        <TouchableOpacity
          style={[styles.tombolPilihBerkas, sibuk !== null && styles.disabled]}
          onPress={pilihDanBaca}
          disabled={sibuk !== null}
          accessibilityRole="button"
        >
          {sibuk === 'BACA' ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              <Ionicons name="document-attach-outline" size={iconSize.md} color={colors.primary} />
              <Text style={styles.tombolSekunderText}>{namaBerkas ? 'Pilih Berkas Lain' : 'Pilih Berkas Excel (.xlsx)'}</Text>
            </>
          )}
        </TouchableOpacity>
        {namaBerkas && (
          <View style={styles.berkasRow}>
            <Ionicons name="document-text-outline" size={14} color={colors.primary} />
            <Text style={styles.berkasNama} numberOfLines={1}>
              {namaBerkas}
            </Text>
            {ringkasan && (
              <TouchableOpacity onPress={pilihDanBaca} accessibilityRole="button" disabled={sibuk !== null}>
                <Text style={styles.tautan}>Periksa ulang</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </KartuLangkah>

      {/* ================= HASIL PEMERIKSAAN ================= */}
      {ringkasan && (
        <>
          <Text style={styles.sectionLabel}>HASIL PEMERIKSAAN</Text>

          <View style={[styles.statusBanner, bisaImport ? styles.statusBannerOk : styles.statusBannerGalat]}>
            <Ionicons
              name={bisaImport ? 'checkmark-circle' : 'alert-circle'}
              size={iconSize.lg}
              color={bisaImport ? colors.success : colors.danger}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.statusJudul}>
                {bisaImport
                  ? `${ringkasan.totalBarisSah} baris siap diimpor`
                  : ringkasan.totalBarisSah === 0
                  ? 'Tidak ada baris yang bisa diimpor'
                  : ringkasan.totalGalat > 0
                  ? `${ringkasan.totalGalat} kesalahan perlu diperbaiki`
                  : 'Ada hal yang harus dibereskan dulu'}
              </Text>
              <Text style={styles.statusText}>
                {bisaImport
                  ? 'Tidak ada kesalahan. Baca peringatan (bila ada), lalu lanjut ke langkah 4.'
                  : 'Perbaiki di Excel, simpan, lalu tekan "Periksa ulang". Nomor baris di bawah sama dengan nomor baris di Excel.'}
              </Text>
            </View>
          </View>

          {peringatan.length > 0 && (
            <View style={styles.peringatanDaftar}>
              {peringatan.map((p) => (
                <KartuPeringatan key={p.kunci} p={p} />
              ))}
            </View>
          )}

          {/* Ubin per sheet */}
          <View style={styles.ubinGrid}>
            {perSheetPratinjau.map(({ jenis, label, judul, sheet }) => (
              <UbinSheet
                key={jenis}
                judul={judul}
                label={label}
                baris={sheet.baris.length}
                galat={sheet.galat.length}
                terbaca={sheet.terbaca}
                judulHilang={!!sheet.galatSheet && /baris judul kolom/.test(sheet.galatSheet)}
                tidakDipakai={sifatData === 'TRANSAKSI_BARU' && (jenis === 'ASET' || jenis === 'JASA') && !sheet.terbaca}
              />
            ))}
            {(sheet7 || sifatData === 'SALDO_AWAL') && (
              <UbinSheet
                judul={JUDUL_SHEET_SALDO_AWAL_AKUN}
                label={LABEL_SHEET_SALDO_AWAL_AKUN}
                baris={sheet7?.baris.length ?? 0}
                galat={sheet7?.galat.length ?? 0}
                terbaca={!!sheet7?.terbaca}
                judulHilang={!!sheet7?.galatSheet && /baris judul kolom/.test(sheet7.galatSheet)}
                satuan="akun"
              />
            )}
          </View>

          {/* Rincian kesalahan per sheet */}
          {[
            ...perSheetPratinjau.map(({ jenis, judul, label, sheet }) => ({ kunci: jenis as string, judul, label, galat: sheet.galat })),
            ...(sheet7 ? [{ kunci: 'SALDO_AWAL_AKUN', judul: JUDUL_SHEET_SALDO_AWAL_AKUN, label: LABEL_SHEET_SALDO_AWAL_AKUN, galat: sheet7.galat }] : []),
          ]
            .filter((x) => x.galat.length > 0)
            .map((x) => (
              <DaftarGalat
                key={x.kunci}
                judul={x.judul}
                label={x.label}
                galat={x.galat}
                terbuka={!!galatTerbuka[x.kunci]}
                onAlih={() => setGalatTerbuka((g) => ({ ...g, [x.kunci]: !g[x.kunci] }))}
              />
            ))}

          {ringkasan.galatUmum.length > 0 && (
            <View style={[styles.card, styles.cardSpaced]}>
              <Text style={styles.cardTitle}>Kesalahan Antar-Sheet</Text>
              <View style={styles.galatBox}>
                {ringkasan.galatUmum.map((g, i) => (
                  <View key={i} style={styles.galatRow}>
                    <Ionicons name="alert-circle-outline" size={14} color={colors.danger} />
                    <Text style={styles.galatPesan}>{g}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* ================= LANGKAH 4: IMPORT ================= */}
          <KartuLangkah
            nomor={4}
            judul="Import ke aplikasi"
            sub="Simpanan diproses lebih dulu agar kas terisi, baru pinjaman — sama seperti keadaan sungguhnya."
            status={statusLangkah[3]}
          >
            <View style={styles.ringkasImport}>
              <BarisRingkas label="Jenis data" nilai={sifatData === 'SALDO_AWAL' ? 'Saldo lama (tanpa jurnal kas)' : 'Transaksi baru (lewat kas)'} />
              {sifatData === 'SALDO_AWAL' && <BarisRingkas label="Cut-off" nilai={tanggalPanjang(cutOffEfektif as string)} />}
              <BarisRingkas label="Berkas" nilai={namaBerkas ?? '-'} />
              <BarisRingkas label="Baris sah" nilai={`${ringkasan.totalBarisSah}`} />
            </View>

            {sibuk === 'IMPORT' && kemajuan ? (
              <View style={styles.kemajuanBox}>
                <View style={styles.kemajuanRel}>
                  <View
                    style={[
                      styles.kemajuanIsi,
                      { width: `${Math.round((kemajuan.selesai / Math.max(1, kemajuan.total)) * 100)}%` },
                    ]}
                  />
                </View>
                <View style={styles.kemajuanBaris}>
                  <ActivityIndicator color={colors.primary} size="small" />
                  <Text style={styles.kemajuanText}>
                    Memproses {kemajuan.selesai} dari {kemajuan.total} baris…
                  </Text>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.tombolUtama, !bisaImport && styles.disabled]}
                onPress={konfirmasiImport}
                disabled={!bisaImport || sibuk !== null}
                accessibilityRole="button"
                testID="tombol-import"
              >
                <Ionicons name={bisaImport ? 'cloud-upload-outline' : 'lock-closed-outline'} size={iconSize.sm} color={colors.white} />
                <Text style={styles.tombolUtamaText}>Import {ringkasan.totalBarisSah} Baris</Text>
              </TouchableOpacity>
            )}

            {!bisaImport && (
              <Text style={styles.catatanKunci}>
                {terblokir && ringkasan.siapDiimpor
                  ? 'Tombol Import terkunci karena ada hal bertanda merah di atas.'
                  : 'Tombol Import aktif setelah seluruh kesalahan di atas diperbaiki.'}
              </Text>
            )}
          </KartuLangkah>
        </>
      )}

      {/* ================= HASIL IMPORT ================= */}
      {hasil && (
        <>
          <Text style={styles.sectionLabel}>HASIL IMPORT</Text>
          <View style={[styles.statusBanner, hasil.totalGagal === 0 ? styles.statusBannerOk : styles.statusBannerWaspada]}>
            <Ionicons
              name={hasil.totalGagal === 0 ? 'checkmark-done-circle' : 'warning'}
              size={iconSize.lg}
              color={hasil.totalGagal === 0 ? colors.success : colors.warning}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.statusJudul}>{hasil.totalGagal === 0 ? 'Import selesai' : 'Import selesai sebagian'}</Text>
              <Text style={styles.statusText}>
                {hasil.totalBerhasil} baris berhasil · {hasil.totalGagal} baris gagal
                {(hasil.totalDilewati ?? 0) > 0 ? ` · ${hasil.totalDilewati} dilewati` : ''}
              </Text>
            </View>
          </View>

          {/* Keseimbangan saldo awal — angka terpenting setelah import Saldo lama. */}
          {hasil.saldoAwalAkun != null && hasil.saldoAwalAkun.saldoKliring !== null && (
            <View
              style={[styles.seimbang, hasil.saldoAwalAkun.saldoKliring === 0 ? styles.seimbangOk : styles.seimbangGalat]}
              testID="hasil-keseimbangan"
            >
              <Text style={styles.seimbangLabel}>Saldo Awal Belum Sesuai</Text>
              <Text
                style={[
                  styles.seimbangNilai,
                  { color: hasil.saldoAwalAkun.saldoKliring === 0 ? colors.success : colors.danger },
                ]}
              >
                {formatRupiah(Math.abs(hasil.saldoAwalAkun.saldoKliring))}
                {hasil.saldoAwalAkun.saldoKliring === 0 ? '' : hasil.saldoAwalAkun.saldoKliring > 0 ? ' (debit)' : ' (kredit)'}
              </Text>
              <Text style={styles.seimbangSub}>
                {hasil.saldoAwalAkun.saldoKliring === 0
                  ? 'Saldo awal seimbang.'
                  : 'Saldo awal belum seimbang. Periksa Kas & akun lain di sheet 7, lalu koreksi di menu Saldo Awal Akun sampai Rp0.'}
              </Text>
            </View>
          )}

          <View style={[styles.card, styles.cardSpaced]}>
            {hasil.perSheet.map((s) => (
              <View key={s.jenis} style={styles.hasilRow}>
                <Text style={styles.hasilLabel}>{s.label}</Text>
                <Text style={styles.hasilNilai}>
                  {s.berhasil} berhasil
                  {s.gagal > 0 ? <Text style={{ color: colors.danger }}>{` · ${s.gagal} gagal`}</Text> : ''}
                  {(s.dilewati ?? 0) > 0 ? <Text style={{ color: colors.warning }}>{` · ${s.dilewati} dilewati`}</Text> : ''}
                </Text>
              </View>
            ))}
            <View style={styles.divider} />
            <View style={styles.hasilRow}>
              <Text style={styles.hasilTotalLabel}>Total</Text>
              <Text style={styles.hasilTotalNilai}>
                {hasil.totalBerhasil} berhasil · {hasil.totalGagal} gagal
              </Text>
            </View>
          </View>

          {(hasil.dilewati?.length ?? 0) > 0 && (
            <View style={[styles.card, styles.cardSpaced]} testID="hasil-dilewati">
              <Text style={styles.cardTitle}>Baris yang Dilewati ({hasil.dilewati!.length})</Text>
              <Text style={styles.cardSub}>
                Isi baris ini sama dengan baris yang sudah pernah diimpor, jadi tidak dicatat lagi.
              </Text>
              <View style={styles.galatBox}>
                {hasil.dilewati!.slice(0, 50).map((g, i) => (
                  <View key={i} style={styles.galatItem}>
                    <View style={styles.pilBaris}>
                      <Text style={styles.pilBarisTeks}>
                        {JUDUL_SHEET[g.jenis]} · Baris {g.baris}
                      </Text>
                    </View>
                    <Text style={styles.galatKeterangan}>{g.keterangan}</Text>
                    <Text style={styles.galatPesan}>{g.pesan}</Text>
                  </View>
                ))}
                {hasil.dilewati!.length > 50 ? (
                  <Text style={styles.galatPesan}>…dan {hasil.dilewati!.length - 50} baris lain (lihat Riwayat Import).</Text>
                ) : null}
              </View>
            </View>
          )}

          {hasil.gagal.length > 0 && (
            <View style={[styles.card, styles.cardSpaced, styles.cardGalat]}>
              <Text style={styles.cardTitle}>Baris yang Gagal ({hasil.gagal.length})</Text>
              <Text style={styles.cardSub}>
                Perbaiki baris ini di Excel, lalu import ULANG berkas yang sama. Baris yang sudah berhasil dikenali dari
                isinya dan otomatis dilewati, sehingga tidak tercatat dua kali.
              </Text>
              <View style={styles.galatBox}>
                {hasil.gagal.map((g, i) => (
                  <View key={i} style={styles.galatItem}>
                    <View style={styles.pilBaris}>
                      <Text style={styles.pilBarisTeks}>
                        {JUDUL_SHEET[g.jenis]} · Baris {g.baris}
                      </Text>
                    </View>
                    <Text style={styles.galatKeterangan}>{g.keterangan}</Text>
                    <Text style={styles.galatPesan}>{g.pesan}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* RC-S103 — LANGKAH BERIKUTNYA DITAMPILKAN OLEH APLIKASI. */}
          {(hasil.migrasi !== null ||
            hasil.saldoAwal !== null ||
            (hasil.saldoAwalAkun ?? null) !== null ||
            hasil.aset !== null ||
            (hasil.jasaDataAwal ?? null) !== null ||
            hasil.keterbatasanTurunan.length > 0) && (
            <View style={[styles.card, styles.cardSpaced]}>
              <Text style={styles.cardTitle}>Langkah Berikutnya</Text>
              <Text style={styles.cardSub}>
                Data per anggota sudah masuk. Import saldo awal sengaja tidak membuat jurnal kas. Saldo awal piutang,
                simpanan, simpanan berjangka, dan aset diisi otomatis; Kas/Bank, pendapatan & beban tahun berjalan,
                cadangan, dan utang dari sheet 7 — atau sendiri di menu Saldo Awal bila sheet 7 tidak dipakai.
              </Text>

              {hasil.migrasi !== null && (
                <Lipat ikon="cash-outline" judul={`Piutang pinjaman — ${hasil.migrasi.berhasil.length} pinjaman`} awalTerbuka>
                  <View style={styles.galatRow}>
                    <Text style={styles.galatPesan}>
                      Saldo awal Piutang Pinjaman Anggota:{' '}
                      <Text style={styles.tebal}>{formatRupiah(hasil.migrasi.rekonsiliasi.totalSisaPokokBukuPembantu)}</Text> —
                      sama dengan jumlah sisa pokok {hasil.migrasi.berhasil.length} pinjaman yang baru dimigrasikan.
                    </Text>
                  </View>
                  {hasil.migrasi.rekonsiliasi.pesan.map((m, i) => (
                    <View key={i} style={styles.galatRow}>
                      <Text style={styles.galatPesan}>{m}</Text>
                    </View>
                  ))}
                  {(hasil.migrasi.totalJasaDimuka ?? 0) > 0 && (
                    <View style={styles.galatRow}>
                      <Text style={styles.galatPesan}>
                        Angsuran yang sudah dibayar di muka (untuk angsuran setelah cut-off): jasa{' '}
                        {formatRupiah(hasil.migrasi.totalJasaDimuka ?? 0)} — diisi otomatis ke saldo awal Pendapatan
                        Diterima Dimuka dan diakui sebagai pendapatan pada bulan angsurannya.
                      </Text>
                    </View>
                  )}
                </Lipat>
              )}

              {/* RC-S133.4.5 — PINJAMAN YANG DATANYA TIDAK COCOK DENGAN AKADNYA. */}
              {hasil.migrasi !== null && hasil.migrasi.berhasil.some((b) => (b.catatan ?? []).length > 0) && (
                <Lipat
                  ikon="alert-circle-outline"
                  warna={colors.warning}
                  judul={`Pinjaman yang perlu dicek — ${hasil.migrasi.berhasil.filter((b) => (b.catatan ?? []).length > 0).length}`}
                  awalTerbuka
                  testID="hasil-migrasi-perlu-cek"
                >
                  {hasil.migrasi.berhasil
                    .filter((b) => (b.catatan ?? []).length > 0)
                    .map((b, i) => (
                      <View key={i} style={styles.galatItem}>
                        <Text style={styles.galatBaris}>
                          Baris {b.baris} · {b.nomorPinjaman} · {b.keterangan}
                        </Text>
                        {(b.catatan ?? []).map((c, k) => (
                          <Text key={k} style={styles.galatPesan}>
                            {c}
                          </Text>
                        ))}
                      </View>
                    ))}
                </Lipat>
              )}

              {/* RC-S107 — HASIL PENGISIAN SALDO AWAL OTOMATIS. */}
              {hasil.saldoAwal !== null && (
                <Lipat
                  ikon="calculator-outline"
                  judul={`Saldo awal otomatis — ${hasil.saldoAwal.jumlahDiisi} terisi${
                    hasil.saldoAwal.jumlahSudahAda > 0 ? `, ${hasil.saldoAwal.jumlahSudahAda} sudah ada` : ''
                  }${hasil.saldoAwal.jumlahGagal > 0 ? `, ${hasil.saldoAwal.jumlahGagal} gagal` : ''}`}
                >
                  {hasil.saldoAwal.baris.map((b, i) => (
                    <View key={i} style={styles.galatItem}>
                      <Text style={styles.galatBarisNetral}>
                        {b.label} — {formatRupiah(b.saldoImport)}
                      </Text>
                      <Text style={styles.galatPesan}>{b.pesan}</Text>
                    </View>
                  ))}
                  {CATATAN_SALDO_AWAL_OTOMATIS.map((c, i) => (
                    <View key={`c${i}`} style={styles.galatRow}>
                      <Ionicons name="information-circle-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.galatPesanRedup}>{c}</Text>
                    </View>
                  ))}
                </Lipat>
              )}

              {/* RC-S133.4.3 — JASA DIBAYAR SEBELUM CUT-OFF (sheet 6). */}
              {hasil.jasaDataAwal != null && (
                <Lipat
                  ikon="people-outline"
                  judul={`Jasa dibayar s.d. cut-off — ${hasil.jasaDataAwal.jumlahAnggota} anggota, ${formatRupiah(hasil.jasaDataAwal.totalJasa)}`}
                  testID="hasil-jasa-data-awal"
                >
                  <View style={styles.galatRow}>
                    <Text style={styles.galatPesan}>{hasil.jasaDataAwal.pesan}</Text>
                  </View>
                  <View style={styles.galatRow}>
                    <Text style={styles.galatPesanRedup}>
                      Dipakai sebagai dasar pembagian SHU jasa usaha per anggota (tidak dijurnal). Hitung ulang SHU bila
                      sudah pernah dihitung.
                    </Text>
                  </View>
                </Lipat>
              )}

              {/* RC-S133.4.6 — SHEET 7: SALDO AWAL AKUN */}
              {hasil.saldoAwalAkun != null && (
                <Lipat
                  ikon="list-outline"
                  judul={`Sheet 7 Saldo Awal Akun — ${hasil.saldoAwalAkun.berhasil.length} akun terisi${
                    hasil.saldoAwalAkun.gagal.length > 0 ? `, ${hasil.saldoAwalAkun.gagal.length} gagal` : ''
                  }`}
                  testID="hasil-saldo-awal-akun"
                  awalTerbuka={hasil.saldoAwalAkun.gagal.length > 0}
                >
                  {hasil.saldoAwalAkun.berhasil.map((b, i) => (
                    <View key={`b${i}`} style={styles.akunBaris}>
                      <Text style={styles.akunKode}>{b.kodeAkun}</Text>
                      <Text style={styles.akunNama} numberOfLines={1}>
                        {b.namaAkun}
                        {b.bagianTunai !== null ? ` (tunai ${formatRupiah(b.bagianTunai)})` : ''}
                      </Text>
                      <Text style={styles.akunNilai}>{formatRupiah(b.saldo)}</Text>
                    </View>
                  ))}
                  {hasil.saldoAwalAkun.gagal.map((g, i) => (
                    <View key={`g${i}`} style={styles.galatItem}>
                      <Text style={styles.galatBaris}>
                        Baris {g.baris} · {g.kodeAkun}
                      </Text>
                      <Text style={styles.galatPesan}>{g.pesan}</Text>
                    </View>
                  ))}
                </Lipat>
              )}

              {hasil.aset !== null && hasil.aset.berhasil.length > 0 && (
                <Lipat
                  ikon="business-outline"
                  judul={`Aset tetap — ${hasil.aset.berhasil.length} aset, perolehan ${formatRupiah(hasil.aset.totalNilaiPerolehan)}`}
                >
                  <View style={styles.galatRow}>
                    <Text style={styles.galatPesan}>
                      Akumulasi penyusutan s.d. cut-off: <Text style={styles.tebal}>{formatRupiah(hasil.aset.totalAkumulasiPenyusutan)}</Text>
                    </Text>
                  </View>
                  {KETERBATASAN_MIGRASI_ASET.map((k, i) => (
                    <View key={i} style={styles.galatRow}>
                      <Ionicons name="information-circle-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.galatPesanRedup}>{k}</Text>
                    </View>
                  ))}
                </Lipat>
              )}

              {hasil.keterbatasanTurunan.length > 0 && (
                <Lipat ikon="eye-outline" judul="Yang perlu Anda cocokkan sendiri">
                  {hasil.keterbatasanTurunan.map((k, i) => (
                    <View key={i} style={styles.galatRow}>
                      <Ionicons name="ellipse" size={6} color={colors.textMuted} style={{ marginTop: 6 }} />
                      <Text style={styles.galatPesan}>{k}</Text>
                    </View>
                  ))}
                </Lipat>
              )}

              <TouchableOpacity
                style={styles.tombolSekunder}
                onPress={() => navigation.navigate('SaldoAwalAkunList')}
                accessibilityRole="button"
              >
                <Ionicons name="calculator-outline" size={iconSize.md} color={colors.primary} />
                <Text style={styles.tombolSekunderText}>Buka Saldo Awal Akun</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}

      <PanduanImportSlide
        visible={panduanTerbuka}
        jenis={jenisTemplate}
        onTutup={() => setPanduanTerbuka(false)}
        onUnduhTemplate={() => {
          setPanduanTerbuka(false);
          void unduhTemplate(jenisTemplate);
        }}
      />
    </ScrollView>
  );
}

// ===========================================================================
// KOMPONEN KECIL (tampilan saja)
// ===========================================================================

const LANGKAH = ['Jenis data', 'Template', 'Periksa', 'Import'];

function Stepper({ status }: { status: ('SELESAI' | 'AKTIF' | 'NANTI')[] }) {
  return (
    <View style={styles.stepper} accessibilityRole="progressbar">
      {LANGKAH.map((l, i) => {
        const st = status[i];
        return (
          <React.Fragment key={l}>
            {i > 0 && <View style={[styles.stepGaris, status[i - 1] === 'SELESAI' && st !== 'NANTI' && styles.stepGarisAktif]} />}
            <View style={styles.stepItem}>
              <View style={[styles.stepBulat, st === 'SELESAI' && styles.stepBulatSelesai, st === 'AKTIF' && styles.stepBulatAktif]}>
                {st === 'SELESAI' ? (
                  <Ionicons name="checkmark" size={13} color={colors.white} />
                ) : (
                  <Text style={[styles.stepNomor, st === 'AKTIF' && { color: colors.white }]}>{i + 1}</Text>
                )}
              </View>
              <Text style={[styles.stepLabel, st !== 'NANTI' && styles.stepLabelAktif]} numberOfLines={1}>
                {l}
              </Text>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

function KartuLangkah({
  nomor,
  judul,
  sub,
  status,
  children,
}: {
  nomor: number;
  judul: string;
  sub: string;
  status: 'SELESAI' | 'AKTIF' | 'NANTI';
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, styles.cardSpaced, status === 'AKTIF' && styles.cardAktif]}>
      <View style={styles.cardTitleRow}>
        <View style={[styles.langkahBulat, status === 'SELESAI' && { backgroundColor: colors.success }]}>
          {status === 'SELESAI' && nomor > 1 ? (
            <Ionicons name="checkmark" size={14} color={colors.white} />
          ) : (
            <Text style={styles.langkahText}>{nomor}</Text>
          )}
        </View>
        <View style={styles.cardTitleBody}>
          <Text style={styles.cardTitle}>{judul}</Text>
          <Text style={styles.cardSub}>{sub}</Text>
        </View>
      </View>
      <View style={styles.cardIsi}>{children}</View>
    </View>
  );
}

function KartuPeringatan({ p }: { p: PeringatanImport }) {
  const gaya =
    p.tingkat === 'BLOKIR'
      ? { ikon: 'close-circle' as const, warna: colors.danger, bg: colors.dangerBg, garis: colors.danger, label: 'HARUS DIPERBAIKI' }
      : p.tingkat === 'PERINGATAN'
      ? { ikon: 'warning' as const, warna: colors.warning, bg: colors.warningBg, garis: colors.warningBorder, label: 'PERIKSA' }
      : { ikon: 'information-circle' as const, warna: '#1E5AA8', bg: '#EEF4FC', garis: '#C9DAF2', label: 'INFO' };
  return (
    <View style={[styles.peringatan, { backgroundColor: gaya.bg, borderColor: gaya.garis }]} testID={`peringatan-${p.kunci}`}>
      <Ionicons name={gaya.ikon} size={18} color={gaya.warna} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.peringatanLabel, { color: gaya.warna }]}>{gaya.label}</Text>
        <Text style={styles.peringatanJudul}>{p.judul}</Text>
        <Text style={styles.peringatanPesan}>{p.pesan}</Text>
      </View>
    </View>
  );
}

function UbinSheet({
  judul,
  label,
  baris,
  galat,
  terbaca,
  judulHilang,
  tidakDipakai,
  satuan = 'baris',
}: {
  judul: string;
  label: string;
  baris: number;
  galat: number;
  terbaca: boolean;
  judulHilang: boolean;
  tidakDipakai?: boolean;
  satuan?: string;
}) {
  const keadaan = judulHilang
    ? { ikon: 'help-circle' as const, warna: colors.danger, teks: 'Judul kolom?' }
    : galat > 0
    ? { ikon: 'alert-circle' as const, warna: colors.danger, teks: `${galat} salah` }
    : !terbaca || baris === 0
    ? { ikon: 'remove-circle-outline' as const, warna: colors.textFaint, teks: tidakDipakai ? 'Tidak dipakai' : 'Kosong' }
    : { ikon: 'checkmark-circle' as const, warna: colors.success, teks: 'Siap' };
  const nomor = /^(\d+)\./.exec(judul)?.[1] ?? '•';
  return (
    <View style={[styles.ubin, (galat > 0 || judulHilang) && styles.ubinGalat]}>
      <View style={styles.ubinKepala}>
        <View style={styles.ubinNomor}>
          <Text style={styles.ubinNomorTeks}>{nomor}</Text>
        </View>
        <Ionicons name={keadaan.ikon} size={16} color={keadaan.warna} />
      </View>
      <Text style={styles.ubinLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={styles.ubinAngka}>
        {baris} <Text style={styles.ubinSatuan}>{satuan}</Text>
      </Text>
      <Text style={[styles.ubinKeadaan, { color: keadaan.warna }]}>{keadaan.teks}</Text>
    </View>
  );
}

const BATAS_GALAT = 10;

function DaftarGalat({
  judul,
  label,
  galat,
  terbuka,
  onAlih,
}: {
  judul: string;
  label: string;
  galat: GalatBaris[];
  terbuka: boolean;
  onAlih: () => void;
}) {
  const tampil = terbuka ? galat : galat.slice(0, BATAS_GALAT);
  return (
    <View style={[styles.card, styles.cardSpaced, styles.cardGalat]}>
      <View style={styles.sheetHeadRow}>
        <View style={styles.cardTitleBody}>
          <Text style={styles.cardTitle}>{label}</Text>
          <Text style={styles.cardSubKecil}>Sheet “{judul}”</Text>
        </View>
        <View style={[styles.jumlahPill, styles.jumlahPillGalat]}>
          <Text style={[styles.jumlahPillText, { color: colors.danger }]}>{galat.length} kesalahan</Text>
        </View>
      </View>
      <View style={styles.galatBox}>
        {tampil.map((g, i) => (
          <View key={`${g.baris}-${i}`} style={styles.galatBarisWadah}>
            <View style={styles.pilBaris}>
              <Text style={styles.pilBarisTeks}>Baris {g.baris}</Text>
            </View>
            <Text style={styles.galatPesan}>{g.pesan}</Text>
          </View>
        ))}
      </View>
      {galat.length > BATAS_GALAT && (
        <TouchableOpacity onPress={onAlih} accessibilityRole="button" style={styles.tampilSemua}>
          <Text style={styles.tautan}>{terbuka ? 'Ringkas' : `Tampilkan semua (${galat.length})`}</Text>
          <Ionicons name={terbuka ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function Lipat({
  ikon,
  judul,
  children,
  awalTerbuka = false,
  warna = colors.primary,
  testID,
}: {
  ikon: keyof typeof Ionicons.glyphMap;
  judul: string;
  children: React.ReactNode;
  awalTerbuka?: boolean;
  warna?: string;
  testID?: string;
}) {
  const [buka, setBuka] = useState(awalTerbuka);
  return (
    <View style={styles.lipat} testID={testID}>
      <TouchableOpacity style={styles.lipatKepala} onPress={() => setBuka((b) => !b)} accessibilityRole="button" accessibilityState={{ expanded: buka }}>
        <Ionicons name={ikon} size={16} color={warna} />
        <Text style={styles.lipatJudul}>{judul}</Text>
        <Ionicons name={buka ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
      </TouchableOpacity>
      {buka && <View style={styles.lipatIsi}>{children}</View>}
    </View>
  );
}

function BarisRingkas({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.ringkasBaris}>
      <Text style={styles.ringkasLabel}>{label}</Text>
      <Text style={styles.ringkasNilai} numberOfLines={1}>
        {nilai}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ikonHeader: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  container: { flex: 1, backgroundColor: colors.background },
  isiLayar: { width: '100%', maxWidth: 920, alignSelf: 'center' },
  sectionLabel: { ...ui.sectionLabel, marginTop: spacing.xl },
  tebal: { fontWeight: '800', color: colors.text },
  tautan: { fontSize: 12.5, fontWeight: '700', color: colors.primary },

  // ---- Hero ----
  hero: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: '#CFE5D0',
  },
  heroIkon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  heroBody: { flex: 1, minWidth: 0 },
  heroJudul: { fontSize: 16, fontWeight: '800', color: colors.text },
  heroSub: { fontSize: 12.5, color: colors.textMuted, lineHeight: 18, marginTop: 3 },
  tombolPanduan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: spacing.md,
  },
  tombolPanduanTeks: { color: colors.white, fontWeight: '700', fontSize: 13 },

  // ---- Stepper ----
  stepper: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.lg, paddingHorizontal: spacing.xs },
  stepItem: { alignItems: 'center', width: 64 },
  stepBulat: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBulatAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepBulatSelesai: { backgroundColor: colors.success, borderColor: colors.success },
  stepNomor: { fontSize: 12, fontWeight: '800', color: colors.textMuted },
  stepLabel: { fontSize: 11, color: colors.textFaint, marginTop: 4, fontWeight: '600' },
  stepLabelAktif: { color: colors.text },
  stepGaris: { flex: 1, height: 2, backgroundColor: colors.border, marginTop: 12 },
  stepGarisAktif: { backgroundColor: colors.success },

  // ---- Kartu ----
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    ...elevation.card,
  },
  cardAktif: { borderColor: colors.primary, borderWidth: 1.5 },
  cardGalat: { borderColor: '#F3CACA' },
  cardSpaced: { marginTop: spacing.md },
  cardTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardTitleBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14.5, fontWeight: '800', color: colors.text },
  cardSub: { fontSize: 12, color: colors.textMuted, marginTop: 3, lineHeight: 17 },
  cardSubKecil: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  cardIsi: { marginTop: spacing.md },
  langkahBulat: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  langkahText: { color: colors.white, fontWeight: '800', fontSize: 13 },

  // ---- Pilihan jenis ----
  pilihanGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pilihan: {
    flexGrow: 1,
    flexBasis: 260,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  pilihanAktif: { borderColor: colors.primary, backgroundColor: colors.focusBg },
  pilihanKepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pilihanIkon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  pilihanIkonAktif: { backgroundColor: colors.primary },
  pilihanJudul: { fontSize: 14, fontWeight: '800', color: colors.text },
  pilihanIsi: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  pilihanSub: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.sm },
  lencanaSaran: { alignSelf: 'flex-start', backgroundColor: colors.primaryLight, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, marginTop: spacing.sm },
  lencanaSaranTeks: { fontSize: 10.5, fontWeight: '800', color: colors.primary },

  // ---- Cut-off ----
  cutOffKotak: { marginTop: spacing.md, borderWidth: 1, borderColor: '#CFE5D0', backgroundColor: colors.focusBg, borderRadius: radius.md, padding: spacing.md },
  cutOffBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cutOffLabel: { fontSize: 11.5, color: colors.textMuted, fontWeight: '600' },
  cutOffNilai: { fontSize: 16, fontWeight: '800', color: colors.primary, marginTop: 1 },
  cutOffUbah: { borderWidth: 1, borderColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: colors.surface },
  cutOffUbahTeks: { fontSize: 12, fontWeight: '700', color: colors.primary },
  cutOffEditor: { marginTop: spacing.sm, gap: spacing.xs },
  cutOffPetunjuk: { flexDirection: 'row', gap: 6, marginTop: spacing.sm },
  cutOffPetunjukTeks: { flex: 1, fontSize: 11.5, color: colors.textMuted, lineHeight: 16 },

  // ---- Tombol ----
  tombolUtama: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 13,
  },
  tombolUtamaText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  tombolSekunder: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 11,
    marginTop: spacing.sm,
  },
  tombolSekunderText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  tombolNetral: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 11,
    marginTop: spacing.sm,
  },
  tombolNetralText: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  tombolBaris: { flexDirection: 'row', gap: spacing.sm },
  tombolFleksibel: { flex: 1 },
  tombolPilihBerkas: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    backgroundColor: colors.focusBg,
    borderRadius: radius.md,
    paddingVertical: 18,
  },
  disabled: { opacity: 0.5 },

  // ---- Daftar periksa ----
  periksaKotak: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  periksaKepala: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  periksaJudul: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  periksaHitung: { fontSize: 11.5, fontWeight: '800', color: colors.primary },
  periksaBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  periksaTeks: { flex: 1, fontSize: 12.5, color: colors.text, lineHeight: 17 },
  periksaTeksSelesai: { color: colors.textMuted, textDecorationLine: 'line-through' },

  berkasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  berkasNama: { flex: 1, fontSize: 12, color: colors.text, fontWeight: '600' },

  // ---- Status ----
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
  },
  statusBannerOk: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  statusBannerGalat: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  statusBannerWaspada: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  statusJudul: { fontSize: 14, color: colors.text, fontWeight: '800' },
  statusText: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2 },

  // ---- Peringatan ----
  peringatanDaftar: { gap: spacing.sm, marginTop: spacing.md },
  peringatan: { flexDirection: 'row', gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  peringatanLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  peringatanJudul: { fontSize: 13, fontWeight: '800', color: colors.text, marginTop: 1 },
  peringatanPesan: { fontSize: 12, color: colors.text, lineHeight: 17, marginTop: 3 },

  // ---- Ubin sheet ----
  ubinGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  ubin: {
    flexGrow: 1,
    flexBasis: 140,
    maxWidth: 220,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    ...elevation.card,
  },
  ubinGalat: { borderColor: colors.danger, backgroundColor: '#FFF9F9' },
  ubinKepala: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ubinNomor: { width: 22, height: 22, borderRadius: 6, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  ubinNomorTeks: { fontSize: 11, fontWeight: '900', color: colors.primary },
  ubinLabel: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: spacing.sm, minHeight: 32, lineHeight: 16 },
  ubinAngka: { fontSize: 18, fontWeight: '900', color: colors.text, marginTop: 2 },
  ubinSatuan: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  ubinKeadaan: { fontSize: 11, fontWeight: '800', marginTop: 2 },

  sheetHeadRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  jumlahPill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, flexShrink: 0 },
  jumlahPillGalat: { backgroundColor: colors.dangerBg },
  jumlahPillText: { fontSize: 11, fontWeight: '700' },

  galatBox: {
    marginTop: spacing.sm,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: spacing.sm,
  },
  galatRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  galatItem: { gap: 2 },
  galatBarisWadah: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  pilBaris: { backgroundColor: colors.dangerBg, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  pilBarisTeks: { fontSize: 10.5, fontWeight: '900', color: colors.danger },
  galatBaris: { fontSize: 11.5, fontWeight: '700', color: colors.danger },
  galatBarisNetral: { fontSize: 12, fontWeight: '700', color: colors.text },
  galatKeterangan: { fontSize: 11, color: colors.textMuted },
  galatPesan: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  galatPesanRedup: { flex: 1, fontSize: 11.5, color: colors.textMuted, lineHeight: 16 },
  tampilSemua: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: spacing.sm },

  // ---- Import ----
  ringkasImport: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md, gap: 4, marginBottom: spacing.md },
  ringkasBaris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  ringkasLabel: { fontSize: 12, color: colors.textMuted },
  ringkasNilai: { flexShrink: 1, fontSize: 12, fontWeight: '700', color: colors.text, textAlign: 'right' },
  kemajuanBox: { gap: spacing.sm },
  kemajuanRel: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  kemajuanIsi: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  kemajuanBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  kemajuanText: { fontSize: 12.5, color: colors.text, fontWeight: '600' },
  catatanKunci: { fontSize: 11.5, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },

  // ---- Hasil ----
  seimbang: { marginTop: spacing.md, borderRadius: radius.md, borderWidth: 1, padding: spacing.lg, alignItems: 'center' },
  seimbangOk: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  seimbangGalat: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  seimbangLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase' },
  seimbangNilai: { fontSize: 24, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'] },
  seimbangSub: { fontSize: 12, color: colors.text, textAlign: 'center', marginTop: 4, lineHeight: 17 },
  hasilRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 5 },
  hasilLabel: { fontSize: 12.5, color: colors.textMuted, flexShrink: 1 },
  hasilNilai: { fontSize: 12.5, color: colors.text, fontWeight: '600', textAlign: 'right' },
  hasilTotalLabel: { fontSize: 13, fontWeight: '800', color: colors.text },
  hasilTotalNilai: { fontSize: 13, fontWeight: '800', color: colors.primary, textAlign: 'right' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  lipat: { marginTop: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  lipatKepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 10, backgroundColor: colors.background },
  lipatJudul: { flex: 1, fontSize: 12.5, fontWeight: '700', color: colors.text },
  lipatIsi: { padding: spacing.md, gap: spacing.sm },
  akunBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  akunKode: { width: 56, fontSize: 11.5, fontWeight: '800', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  akunNama: { flex: 1, fontSize: 12, color: colors.text },
  akunNilai: { fontSize: 12, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
});
