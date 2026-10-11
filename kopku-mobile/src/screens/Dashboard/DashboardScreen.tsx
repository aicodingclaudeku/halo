import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sqlJadwalBukanObsolete, sqlJadwalCurrent } from '@/accounting/ScheduleLifecycle';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getDb } from '@/database/db';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { useNavigation } from '@react-navigation/native';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute } from '@/navigation/izinRute';
import { getIdentityCompletionStatus, IdentityCompletion } from '@/services/SetupService';
import { colors, radius, spacing, elevation, iconSize } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import PanduanSlide from '@/components/panduan/PanduanSlide';
import { PANDUAN_APLIKASI } from '@/config/panduanAplikasi';
import { perluTampilkanPanduanAwal, tandaiPanduanAwalSudahDilihat } from '@/services/PanduanService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getLicenseStatus, type LicenseStatus } from '@/services/LicenseService';
import LoncengNotifikasi from '@/components/LoncengNotifikasi';
// Sinkron HP⇄Desktop: banner mode cadangan (null bila HP tidak dipasangkan).
import BannerModeCadangan from '@/components/sinkron/BannerModeCadangan';
import {
  LABEL_TIPE_LISENSI,
  formatSisaWaktu,
  hitungSisaMs,
  tipeLisensiPakaiCountdown,
  urgensiSisaWaktu,
} from '@/utils/licenseCountdown';

interface DashboardData {
  anggotaAktif: number;
  totalAnggota: number;
  totalSimpanan: number;
  simpananPokok: number;
  simpananWajib: number;
  simpananSukarela: number;
  totalPinjaman: number;
  pinjamanAktifCount: number;
  /** Sisa angsuran (pokok + jasa terjadwal) — dasar rasio tunggakan. */
  piutang: number;
  /** RC-S133.4.8 — sisa POKOK pinjaman aktif: angka "Piutang Berjalan". */
  piutangPokok: number;
  /** RC-S133.4.8 — jasa terjadwal yang belum dibayar (belum tentu jatuh tempo). */
  sisaJasa: number;
  tunggakan: number;
}

/** PRD §30 — kartu ringkas + statistik dashboard (bar sederhana berbasis View,
 * tanpa dependency chart tambahan — cukup untuk gambaran cepat komposisi
 * simpanan & kesehatan pinjaman). */
export default function DashboardScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const navigation = useNavigation<any>();
  const { permissions } = usePermission();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §22 — status kelengkapan identitas. Dihitung lewat helper TERPUSAT
  // `getIdentityCompletionStatus()` yang SAMA dengan layar Identitas
  // Koperasi (§23), supaya kedua layar tidak pernah menampilkan status
  // yang bertentangan. Kegagalan membacanya TIDAK PERNAH menghalangi
  // dashboard/transaksi (§22) — kartunya cukup tidak ditampilkan.
  const [identitas, setIdentitas] = useState<IdentityCompletion | null>(null);
  /** Tarik-untuk-memuat-ulang: memanggil `load()` yang sama dengan refresh fokus. */
  const [menyegarkan, setMenyegarkan] = useState(false);
  // Panduan slide: tampil otomatis SEKALI setelah setup administrasi,
  // dan dapat dibuka lagi dari kartu "Panduan Aplikasi".
  const [panduanTerbuka, setPanduanTerbuka] = useState(false);
  useEffect(() => {
    let batal = false;
    perluTampilkanPanduanAwal().then((perlu) => {
      if (!batal && perlu) setPanduanTerbuka(true);
    });
    return () => {
      batal = true;
    };
  }, []);
  const tutupPanduan = () => {
    setPanduanTerbuka(false);
    tandaiPanduanAwalSudahDilihat().catch(() => undefined);
  };

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const db = await getDb();

      const anggotaAktif = await db.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM anggota WHERE status = 'AKTIF'`
      );
      const totalAnggota = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM anggota`);
      const simpananPerJenis = await db.getAllAsync<{ jenis: string; total: number }>(
        // BUG FIX (pola sama dengan SimpananService.getSaldoSimpanan,
        // Prioritas 3/E): keluarkan juga baris ASLI yang sudah
        // dikoreksi, bukan cuma baris koreksinya sendiri — supaya
        // ringkasan dashboard tidak ikut menghitung setoran yang
        // sebenarnya sudah dibatalkan/dikoreksi.
        `SELECT jenis, COALESCE(SUM(CASE WHEN tipe='SETOR' THEN nominal WHEN tipe='TARIK' THEN -nominal ELSE 0 END),0) as total
         FROM simpanan_transaksi
         WHERE reversal_of_id IS NULL
           AND id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)
         GROUP BY jenis`
      );
      const pinjaman = await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(jumlah_pinjaman),0) as total FROM pinjaman WHERE status IN ('AKTIF','LUNAS')`
      );
      const pinjamanAktifCount = await db.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM pinjaman WHERE status = 'AKTIF'`
      );
      const piutang = await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar),0) as total
         FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
         WHERE p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`
      );
      // RC-S133.4.8 — "Piutang Berjalan" = sisa POKOK. Kueri `piutang` di atas
      // (sisa angsuran) ikut menjumlah jasa yang BELUM jatuh tempo — itu belum
      // piutang koperasi, sehingga angkanya bisa berlipat (kasus nyata
      // Rp824 jt untuk sisa pokok Rp258,9 jt). Tetap dipakai untuk rasio tunggakan.
      const sisaPokokJasa = await db.getFirstAsync<{ pokok: number; jasa: number }>(
        `SELECT COALESCE(SUM(aj.pokok - aj.pokok_terbayar),0) as pokok, COALESCE(SUM(aj.jasa - aj.jasa_terbayar),0) as jasa
         FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
         WHERE p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`
      );
      const tunggakan = await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar),0) as total
         FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
         WHERE p.status = 'AKTIF' AND aj.tanggal_jatuh_tempo < date('now') AND ${sqlJadwalCurrent('aj')}`
      );

      const byJenis: Record<string, number> = { POKOK: 0, WAJIB: 0, SUKARELA: 0 };
      for (const row of simpananPerJenis) byJenis[row.jenis] = row.total;

      setData({
        anggotaAktif: anggotaAktif?.cnt ?? 0,
        totalAnggota: totalAnggota?.cnt ?? 0,
        totalSimpanan: byJenis.POKOK + byJenis.WAJIB + byJenis.SUKARELA,
        simpananPokok: byJenis.POKOK,
        simpananWajib: byJenis.WAJIB,
        simpananSukarela: byJenis.SUKARELA,
        totalPinjaman: pinjaman?.total ?? 0,
        pinjamanAktifCount: pinjamanAktifCount?.cnt ?? 0,
        piutang: piutang?.total ?? 0,
        piutangPokok: sisaPokokJasa?.pokok ?? 0,
        sisaJasa: sisaPokokJasa?.jasa ?? 0,
        tunggakan: tunggakan?.total ?? 0,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat data dashboard.');
    }
  }, []);

  /**
   * BUG-A (RC-S40) — status kelengkapan identitas tertinggal basi.
   *
   * Sebelumnya status ini dimuat lewat `useEffect(..., [])`, yaitu
   * SEKALI saat mount. Layar Dashboard memakai native-stack, yang TIDAK
   * meng-unmount layar saat pengguna berpindah — jadi setelah menyimpan
   * identitas di layar Pengaturan lalu kembali, kartu ini masih
   * menampilkan snapshot dari saat aplikasi pertama dibuka. Statusnya
   * baru berubah setelah seluruh layar benar-benar di-mount ulang
   * (restart aplikasi), yang persis gejala yang dilaporkan.
   *
   * Alasan itu SUDAH tertulis di komentar `useFocusRefresh` di bawah,
   * dan perbaikannya sudah diterapkan untuk `load()` — tetapi efek
   * identitas di sebelahnya terlewat. Jadi ini bukan pola baru: ia
   * hanya menyelaraskan satu efek yang tertinggal dengan pola yang
   * sudah menjadi standar layar ini.
   *
   * TIDAK memakai timer, remount paksa, atau reload aplikasi.
   */
  /**
   * ============================================================
   * RC-S49b §C/§D/§E — STATUS & COUNTDOWN LISENSI
   * ============================================================
   *
   * PEMBAGIAN PERAN YANG TIDAK BOLEH DIKABURKAN:
   *
   *   getLicenseStatus()  -> sumber kebenaran
   *   LicenseGate         -> penegakan (mengunci aplikasi)
   *   kode di bawah ini   -> tampilan
   *
   * Dashboard TIDAK PERNAH memutuskan boleh/tidaknya aplikasi dipakai.
   * Ia membaca status yang SUDAH ADA, menggambarnya, dan — ketika
   * countdown-nya menyentuh nol — meminta gate mengevaluasi ulang.
   * Tidak ada sistem lisensi kedua, tidak ada timer yang menjadi acuan
   * masa berlaku, tidak ada verifikasi kriptografi yang disentuh.
   */
  const triggerLicenseRecheck = useAppStore((s) => s.triggerLicenseRecheck);
  const [lisensi, setLisensi] = useState<LicenseStatus | null>(null);

  /**
   * Jam untuk MENGGAMBAR countdown. Sengaja state terpisah dari status
   * lisensi: ia berubah tiap detik, sementara status lisensi hanya
   * dibaca ulang saat fokus atau saat waktu habis. Memisahkannya
   * itulah yang membuat §D terpenuhi — tidak ada kueri database dan
   * tidak ada panggilan server per detik.
   */
  const [tikMs, setTikMs] = useState(() => Date.now());

  /** Penjaga supaya laporan "waktu habis" dikirim SEKALI, bukan tiap detik. */
  const sudahLaporBerakhir = useRef(false);

  const muatStatusLisensi = useCallback(async () => {
    try {
      const status = await getLicenseStatus();
      setLisensi(status);
      if (!status.allowAppAccess) {
        // §E1 — jangan biarkan pengguna melanjutkan hanya karena
        // countdown di layar masih terlihat. Sinyal ini TIDAK membawa
        // keputusan apa pun; ia hanya membangunkan LicenseGate untuk
        // mengevaluasi ulang dengan mekanismenya sendiri.
        triggerLicenseRecheck();
      }
    } catch {
      // Kegagalan membaca status TIDAK PERNAH menghalangi dashboard
      // (pola sama dengan kartu identitas di bawah): kartunya cukup
      // tidak ditampilkan. Penegakan lisensi tetap milik LicenseGate,
      // yang fail-closed sendiri.
      setLisensi(null);
    }
  }, [triggerLicenseRecheck]);

  const muatStatusIdentitas = useCallback(async () => {
    try {
      setIdentitas(await getIdentityCompletionStatus());
    } catch {
      setIdentitas(null);
    }
  }, []);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Diganti (bukan
  // ditambahi) dengan refresh berbasis FOKUS supaya layar selalu
  // membaca state SQLite terkini. Tidak ada timer, tidak ada remount paksa.
  useFocusRefresh(() => {
    load();
    void muatStatusIdentitas();
    // §E1/§F — status lisensi ikut dibaca ulang tiap kali layar
    // difokuskan, memakai mekanisme fokus yang SUDAH dipakai layar ini.
    // Untuk skenario minimize -> tunggu habis -> buka lagi, penegakan
    // sesungguhnya tetap di LicenseGate (listener `AppState` di sana);
    // pembacaan di sini hanya menjaga kartu tidak menampilkan sisa
    // waktu dari snapshot lama.
    void muatStatusLisensi();
    // HOTFIX RC-S74 (final) — ONE-SHOT STARTUP TASK REQUEST DIPINDAH.
    //
    // Sebelumnya Dashboard-lah yang mengonsumsi `startupTaskRequested`
    // saat fokus. Root cause bug aktual: kalau pengguna TIDAK pernah
    // membuka Dashboard setelah menyimpan utang (mis. langsung ke Bayar
    // Kewajiban lewat tab Transaksi), request itu tidak pernah dikonsumsi
    // dan layar Bayar Kewajiban membaca read-model basi (Rp0 + Perlu
    // Perhatian) sebagai hasil final.
    //
    // Konsumsi sekarang dilakukan oleh GLOBAL APPLICATION COORDINATOR di
    // `app/index.tsx` — lifecycle root yang tetap mounted selama aplikasi
    // READY, terlepas layar mana yang difokuskan. Dashboard tidak lagi
    // menjadi syarat agar akrual otomatis berjalan; layar ini hanya
    // melakukan pekerjaan Dashboard (load, status identitas, status
    // lisensi).
  }, [load, muatStatusIdentitas, muatStatusLisensi]);

  /**
   * DERIVASI TAMPILAN — dihitung dari `lisensi.expiresAt` (§C3), bukan
   * dari durasi tipe lisensi dan bukan dari saat layar dibuka.
   */
  const tipeLisensi = lisensi?.licenseType ?? null;
  const pakaiCountdown = tipeLisensiPakaiCountdown(tipeLisensi) && lisensi?.expiresAt != null;
  const sisaMs = lisensi ? hitungSisaMs(lisensi.expiresAt, tikMs) : null;
  const urgensi = urgensiSisaWaktu(pakaiCountdown ? sisaMs : null);

  /**
   * SATU timer, dan hanya ketika memang ada yang dihitung mundur.
   *
   * §C2 — lisensi PERMANENT tidak pernah menjalankan timer sama sekali:
   * `pakaiCountdown` bernilai false, efek ini langsung keluar.
   *
   * §D — interval dibersihkan pada unmount DAN setiap kali
   * `pakaiCountdown` berubah, sehingga tidak mungkin ada dua interval
   * hidup bersamaan. Timer ini bukan variabel global, tidak menyentuh
   * database, tidak memanggil server, dan tidak menyimpan apa pun:
   * satu-satunya yang dilakukannya adalah memperbarui jam gambar.
   */
  useEffect(() => {
    if (!pakaiCountdown) return;
    const interval = setInterval(() => setTikMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pakaiCountdown]);

  /**
   * §E — SAAT COUNTDOWN MENCAPAI NOL.
   *
   * Countdown yang habis TIDAK disembunyikan diam-diam dan TIDAK
   * dipakai untuk mengunci apa pun dari sini. Yang terjadi hanyalah
   * pembacaan ulang OTORITATIF lewat `getLicenseStatus()`; kalau
   * hasilnya benar-benar tidak lagi mengizinkan akses,
   * `muatStatusLisensi()` di atas membangunkan LicenseGate, dan
   * gate itulah yang menampilkan LicenseActivationScreen serta
   * meminta lisensi baru.
   *
   * Jadi jam perangkat yang dimajukan TIDAK bisa mengunci aplikasi,
   * dan jam yang dimundurkan TIDAK bisa membukanya — keputusannya
   * tetap milik trusted clock di dalam LicenseService.
   */
  useEffect(() => {
    if (!pakaiCountdown || sisaMs === null || sisaMs > 0) {
      sudahLaporBerakhir.current = false;
      return;
    }
    if (sudahLaporBerakhir.current) return;
    sudahLaporBerakhir.current = true;
    void muatStatusLisensi();
  }, [pakaiCountdown, sisaMs, muatStatusLisensi]);

  /*
   * BUG-Q (RC-S42) — status bar tertutup pada state loading & error.
   *
   * Dashboard adalah SATU-SATUNYA layar yang dipasang sebagai
   * `Tab.Screen` langsung, sementara Tab.Navigator menyetel
   * `headerShown: false` (RootNavigator.tsx:452). Tab lain dibungkus
   * stack yang punya header, dan header itulah yang menyediakan inset
   * atas. Dashboard tidak punya keduanya.
   *
   * Jalur utamanya sudah benar — `<SafeAreaView edges={['top']}>` di
   * bawah. Tetapi DUA early-return ini melewatinya dan me-render
   * `<View>` polos, sehingga pada Android edge-to-edge (bawaan Expo
   * SDK 54) isinya menggambar di bawah jam dan ikon status.
   *
   * Diperbaiki dengan komponen Safe Area yang sama, BUKAN dengan
   * `paddingTop` angka tetap: tinggi status bar berbeda antar-perangkat
   * dan angka tetap akan salah di sebagian besar di antaranya.
   */
  if (error) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={load}>
          <Text style={styles.retryButtonText}>Coba Lagi</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  const totalSimpanan = data.totalSimpanan || 1; // hindari bagi nol
  const komposisi = [
    { label: 'Pokok', value: data.simpananPokok, color: colors.primary },
    { label: 'Wajib', value: data.simpananWajib, color: colors.accent },
    { label: 'Sukarela', value: data.simpananSukarela, color: colors.warning },
  ];

  const persenTunggakan = data.piutang > 0 ? Math.min(100, Math.round((data.tunggakan / data.piutang) * 100)) : 0;
  const persenAnggotaAktif = data.totalAnggota > 0 ? Math.round((data.anggotaAktif / data.totalAnggota) * 100) : 0;

  // Navigasi kartu — rute terdaftar existing di stack tab masing-masing.
  // `initial: false` menjaga layar akar stack tetap di bawahnya sehingga
  // Back kembali normal. Tidak ada navigasi bersarang ke tab Pengaturan.
  const buka = {
    anggota: () => navigation.navigate('Anggota', { screen: 'AnggotaList', initial: false }),
    simpanan: () => navigation.navigate('Transaksi', { screen: 'SimpananHistori', initial: false }),
    pinjaman: () => navigation.navigate('Transaksi', { screen: 'PinjamanList', initial: false }),
    tunggakan: () => navigation.navigate('Laporan', { screen: 'KolektibilitasPiutang', initial: false }),
    bayarAngsuran: () => navigation.navigate('Transaksi', { screen: 'BayarAngsuranForm', initial: false }),
    tarikSimpanan: () => navigation.navigate('Transaksi', { screen: 'TarikSimpananForm', initial: false }),
    laporan: () => navigation.navigate('Laporan', { screen: 'LaporanMenu' }),
  };

  // RC-S132 — Aksi Cepat mengikuti Permission Matrix: aksi yang layarnya
  // tidak boleh dibuka role ini tidak ditampilkan (gerbang layar tetap
  // menjaga bila dibuka lewat jalan lain).
  const aksiCepat = (
    [
      { icon: 'add-circle-outline', label: 'Setor Simpanan', rute: 'SimpananForm', onPress: buka.simpanan },
      { icon: 'remove-circle-outline', label: 'Tarik Simpanan', rute: 'TarikSimpananForm', onPress: buka.tarikSimpanan },
      { icon: 'receipt-outline', label: 'Bayar Angsuran', rute: 'BayarAngsuranForm', onPress: buka.bayarAngsuran },
      { icon: 'bar-chart-outline', label: 'Laporan', rute: 'LabaRugi', onPress: buka.laporan },
    ] as { icon: keyof typeof Ionicons.glyphMap; label: string; rute: string; onPress: () => void }[]
  ).filter((a) => bolehBukaRute(a.rute, permissions));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.isi}
        refreshControl={
          <RefreshControl
            refreshing={menyegarkan}
            onRefresh={async () => {
              setMenyegarkan(true);
              await load();
              setMenyegarkan(false);
            }}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <BannerModeCadangan />
        {/* ================= HEADER ================= */}
        <View style={styles.header}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.sapaan}>{formatTanggalIndonesia(getTanggalLokalHariIni())}</Text>
            <Text style={styles.title} numberOfLines={2}>
              {koperasi?.nama ?? 'Koperasi'}
            </Text>
            <Text style={styles.subtitle}>Tahun Buku {koperasi?.tahunBukuAktif}</Text>
          </View>
          {/*
            RC-S100 — LOGO KOPERASI DI DASHBOARD.

            Kalau logo sudah dipilih di Identitas Koperasi, gambar itulah
            yang tampil; kalau belum, kotak brand berikon "business" yang
            sudah ada sebelumnya TETAP dipakai sebagai penggantinya —
            jadi tidak ada ruang kosong pada koperasi yang belum
            mengunggah logo.
          */}
          {/* RC-S125 — lonceng pengumuman & notifikasi, di kiri logo koperasi. */}
          <View style={styles.headerKanan}>
          <LoncengNotifikasi />
          {koperasi?.logoUri ? (
            <View style={styles.logoGambarWadah}>
              <Image
                source={{ uri: koperasi.logoUri }}
                style={styles.logoGambar}
                resizeMode="contain"
                accessibilityLabel={`Logo ${koperasi.nama}`}
              />
            </View>
          ) : (
            <View style={styles.logo}>
              <Ionicons name="business" size={22} color={colors.white} />
            </View>
          )}
          </View>
        </View>

        {/* ================= HERO: TOTAL SIMPANAN ================= */}
        <TouchableOpacity style={styles.hero} activeOpacity={0.85} onPress={buka.simpanan} accessibilityRole="button" accessibilityLabel="Total Simpanan">
          <View style={styles.heroAtas}>
            <Text style={styles.heroLabel}>Total Simpanan Anggota</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.primaryLight} />
          </View>
          <Text style={styles.heroNilai} numberOfLines={1} adjustsFontSizeToFit>
            {formatRupiah(data.totalSimpanan)}
          </Text>
          <View style={styles.heroRincian}>
            {komposisi.map((k) => (
              <View key={k.label} style={styles.heroItem}>
                <Text style={styles.heroItemLabel}>{k.label}</Text>
                <Text style={styles.heroItemNilai} numberOfLines={1} adjustsFontSizeToFit>
                  {formatRupiah(k.value)}
                </Text>
              </View>
            ))}
          </View>
        </TouchableOpacity>

        {/* §19/§22 — kartu Identitas Koperasi. Mudah ditemukan tetapi TIDAK
            menghalangi penggunaan aplikasi: hanya kartu yang bisa diabaikan. */}
        {identitas && (
          <TouchableOpacity
            style={[styles.infoCard, identitas.status !== 'COMPLETE' && styles.infoCardPerhatian]}
            // RC-S49b §B5 — LANGSUNG ke destination independen (RootStack),
            // bukan navigasi bersarang lewat tab Pengaturan.
            onPress={() => navigation.navigate('IdentitasKoperasi')}
          >
            <View style={[styles.infoIcon, identitas.status === 'COMPLETE' && styles.identitasIconOk]}>
              <Ionicons
                name={identitas.status === 'COMPLETE' ? 'checkmark-circle-outline' : 'business-outline'}
                size={20}
                color={identitas.status === 'COMPLETE' ? colors.success : colors.primary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.infoTitle}>
                {identitas.status === 'COMPLETE' ? 'Identitas Koperasi' : 'Lengkapi Identitas Koperasi'}
              </Text>
              <Text style={styles.infoSub}>
                {identitas.status === 'COMPLETE' ? 'Identitas lengkap' : 'Lengkapi data koperasi untuk laporan dan dokumen.'}
              </Text>
            </View>
            {identitas.status !== 'COMPLETE' && <Text style={styles.identitasCta}>Lengkapi Sekarang</Text>}
            <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={{ flexShrink: 0 }} />
          </TouchableOpacity>
        )}

        {/* Panduan penggunaan aplikasi — slide bergambar, bisa dibuka kapan saja. */}
        <TouchableOpacity
          style={styles.infoCard}
          accessibilityRole="button"
          accessibilityLabel="Buka panduan aplikasi"
          onPress={() => setPanduanTerbuka(true)}
        >
          <View style={styles.infoIcon}>
            <Ionicons name="book-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.infoTitle}>Panduan Aplikasi</Text>
            <Text style={styles.infoSub}>Kenali menu utama dan langkah awal dalam 8 slide singkat.</Text>
          </View>
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={{ flexShrink: 0 }} />
        </TouchableOpacity>

        {/* RC-S49b §C1/§H — KARTU LISENSI (tampilan saja; penegakan milik LicenseGate). */}
        {lisensi && tipeLisensi && (
          <View
            style={[
              styles.lisensiCard,
              urgensi === 'SEGERA_HABIS' && styles.lisensiCardPeringatan,
              (urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR') && styles.lisensiCardBahaya,
            ]}
          >
            <View
              style={[
                styles.infoIcon,
                urgensi === 'SEGERA_HABIS' && styles.lisensiIconPeringatan,
                (urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR') && styles.lisensiIconBahaya,
              ]}
            >
              <Ionicons
                name={pakaiCountdown ? 'time-outline' : 'shield-checkmark-outline'}
                size={20}
                color={
                  urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR'
                    ? colors.danger
                    : urgensi === 'SEGERA_HABIS'
                      ? colors.warning
                      : colors.primary
                }
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.infoTitle}>{LABEL_TIPE_LISENSI[tipeLisensi]}</Text>
              {lisensi.cooperativeName && <Text style={styles.infoSub}>Koperasi: {lisensi.cooperativeName}</Text>}
              {/* §C2 — PERMANENT tidak menampilkan countdown sama sekali. */}
              {!pakaiCountdown && <Text style={styles.infoSub}>Status: Aktif · tanpa batas waktu</Text>}
            </View>
            {pakaiCountdown && sisaMs !== null && (
              <View style={styles.lisensiSisa}>
                <Text style={styles.lisensiSisaLabel}>Sisa waktu</Text>
                <Text
                  style={[
                    styles.lisensiSisaValue,
                    urgensi === 'SEGERA_HABIS' && { color: colors.warning },
                    (urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR') && { color: colors.danger },
                  ]}
                >
                  {formatSisaWaktu(sisaMs)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ================= RINGKASAN (dapat diketuk) ================= */}
        <Text style={styles.sectionTitle}>Ringkasan</Text>
        <View style={styles.grid}>
          <Card
            icon="people-outline"
            label="Anggota Aktif"
            value={data.anggotaAktif.toString()}
            sub={`dari ${data.totalAnggota} anggota`}
            onPress={buka.anggota}
          />
          <Card
            icon="cash-outline"
            label="Total Pinjaman"
            value={formatRupiah(data.totalPinjaman)}
            sub={`${data.pinjamanAktifCount} pinjaman aktif`}
            onPress={buka.pinjaman}
          />
          <Card
            icon="hourglass-outline"
            label="Piutang Berjalan"
            value={formatRupiah(data.piutangPokok)}
            sub={data.sisaJasa > 0 ? `Sisa pokok · + jasa terjadwal ${formatRupiah(data.sisaJasa)}` : 'Sisa pokok pinjaman aktif'}
            onPress={buka.pinjaman}
          />
          <Card
            icon="alert-circle-outline"
            label="Tunggakan"
            value={formatRupiah(data.tunggakan)}
            sub={data.tunggakan > 0 ? 'Lihat kolektibilitas' : 'Tidak ada tunggakan'}
            warn={data.tunggakan > 0}
            onPress={buka.tunggakan}
          />
        </View>

        {/* ================= AKSI CEPAT ================= */}
        <Text style={styles.sectionTitle}>Aksi Cepat</Text>
        <View style={styles.aksiRow}>
          {aksiCepat.map((a) => (
            <Aksi key={a.label} icon={a.icon} label={a.label} onPress={a.onPress} />
          ))}
        </View>
        {aksiCepat.length === 0 ? <Text style={styles.aksiKosong}>Tidak ada aksi cepat untuk role Anda.</Text> : null}

        {/* ================= STATISTIK ================= */}
        <Text style={styles.sectionTitle}>Statistik</Text>

        <TouchableOpacity style={styles.statCard} activeOpacity={0.8} onPress={buka.simpanan}>
          <StatHeader icon="pie-chart-outline" title="Komposisi Simpanan" />
          {data.totalSimpanan === 0 ? (
            <Text style={styles.statEmpty}>Belum ada data simpanan.</Text>
          ) : (
            <>
              <View style={styles.stackedBar}>
                {komposisi.map((k) =>
                  k.value > 0 ? <View key={k.label} style={{ flex: k.value, backgroundColor: k.color, height: '100%' }} /> : null
                )}
              </View>
              <View style={styles.legendRow}>
                {komposisi.map((k) => (
                  <View key={k.label} style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: k.color }]} />
                    <Text style={styles.legendLabel}>
                      {k.label} · {Math.round((k.value / totalSimpanan) * 100)}%
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.statCard} activeOpacity={0.8} onPress={buka.tunggakan}>
          <StatHeader icon="pulse-outline" title="Kesehatan Pinjaman" />
          {data.piutang === 0 ? (
            <Text style={styles.statEmpty}>Tidak ada piutang berjalan saat ini.</Text>
          ) : (
            <>
              <View style={styles.rowBetween}>
                <Text style={styles.statSubLabel}>Tunggakan dari Sisa Angsuran</Text>
                <Text style={[styles.statSubValue, persenTunggakan > 0 && { color: colors.danger }]}>{persenTunggakan}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${persenTunggakan}%`, backgroundColor: persenTunggakan > 20 ? colors.danger : colors.warning },
                  ]}
                />
              </View>
              <Text style={styles.statFootnote}>
                {data.pinjamanAktifCount} pinjaman aktif · {formatRupiah(data.piutangPokok)} sisa pokok · {formatRupiah(data.piutang)} sisa angsuran
              </Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.statCard} activeOpacity={0.8} onPress={buka.anggota}>
          <StatHeader icon="people-circle-outline" title="Keanggotaan" />
          <View style={styles.rowBetween}>
            <Text style={styles.statSubLabel}>Anggota Aktif dari Total Anggota</Text>
            <Text style={styles.statSubValue}>{persenAnggotaAktif}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${persenAnggotaAktif}%`, backgroundColor: colors.primary }]} />
          </View>
          <Text style={styles.statFootnote}>
            {data.anggotaAktif} aktif dari {data.totalAnggota} total anggota
          </Text>
        </TouchableOpacity>
      </ScrollView>
      <PanduanSlide visible={panduanTerbuka} slides={PANDUAN_APLIKASI} onTutup={tutupPanduan} />
    </SafeAreaView>
  );
}

function Card({
  icon,
  label,
  value,
  sub,
  warn,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.card, warn && styles.cardWarn]}
      activeOpacity={0.8}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.cardAtas}>
        <View style={[styles.cardIcon, warn && styles.cardIconWarn]}>
          <Ionicons name={icon} size={18} color={warn ? colors.danger : colors.primary} />
        </View>
        {onPress ? <Ionicons name="chevron-forward" size={14} color={colors.textFaint} /> : null}
      </View>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={[styles.cardValue, warn && styles.cardValueWarn]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? (
        <Text style={styles.cardSub} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function Aksi({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.aksi} activeOpacity={0.8} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <View style={styles.aksiIcon}>
        <Ionicons name={icon} size={22} color={colors.primary} />
      </View>
      <Text style={styles.aksiLabel} numberOfLines={2}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function StatHeader({ icon, title }: { icon: keyof typeof Ionicons.glyphMap; title: string }) {
  return (
    <View style={styles.statHeader}>
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={styles.statTitle}>{title}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.danger, textAlign: 'center', padding: 24 },
  retryButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 20, paddingVertical: 10 },
  retryButtonText: { color: colors.white, fontWeight: '700' },

  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  headerKanan: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sapaan: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 2 },
  subtitle: { fontSize: 12.5, color: colors.textMuted, marginTop: 2 },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // RC-S100 — wadah logo gambar. Latar putih & sudut membulat supaya logo
  // apa pun (termasuk yang berlatar transparan) tetap terbaca rapi.
  logoGambarWadah: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoGambar: { width: '100%', height: '100%' },

  hero: {
    backgroundColor: colors.primary,
    borderRadius: radius.md * 1.5,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  heroAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { fontSize: 12.5, color: colors.primaryLight, fontWeight: '600' },
  heroNilai: { fontSize: 28, fontWeight: '800', color: colors.white, marginTop: 4 },
  heroRincian: {
    flexDirection: 'row',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.18)',
    gap: spacing.sm,
  },
  heroItem: { flex: 1, minWidth: 0 },
  heroItemLabel: { fontSize: 11, color: colors.primaryLight },
  heroItemNilai: { fontSize: 13, fontWeight: '700', color: colors.white, marginTop: 2 },

  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  infoCardPerhatian: { borderColor: colors.primary },
  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identitasIconOk: { backgroundColor: '#E8F5E9' },
  infoTitle: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  infoSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  identitasCta: { fontSize: 11, fontWeight: '700', color: colors.primary, flexShrink: 0 },
  // Kartu lisensi memakai token design system yang sama dengan kartu info.
  lisensiCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  lisensiCardPeringatan: { borderColor: colors.warning },
  lisensiCardBahaya: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  lisensiIconPeringatan: { backgroundColor: colors.warningBg },
  lisensiIconBahaya: { backgroundColor: colors.dangerBg },
  lisensiSisa: { alignItems: 'flex-end', maxWidth: '45%' },
  lisensiSisaLabel: { fontSize: 10, color: colors.textFaint, fontWeight: '600' },
  lisensiSisaValue: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: 2, textAlign: 'right' },
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: spacing.md },
  card: {
    width: '48%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  cardWarn: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBg },
  cardAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconWarn: { backgroundColor: colors.surface },
  cardLabel: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, fontWeight: '600' },
  cardValue: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 2 },
  cardValueWarn: { color: colors.danger },
  cardSub: { fontSize: 11, color: colors.textFaint, marginTop: 2 },

  aksiRow: { flexDirection: 'row', gap: spacing.sm },
  aksiKosong: { fontSize: 12, color: colors.textMuted, marginTop: -spacing.xs },
  aksi: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: 4,
    gap: 6,
  },
  aksiIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aksiLabel: { fontSize: 11, fontWeight: '600', color: colors.text, textAlign: 'center' },

  statCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  statHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  statTitle: { flex: 1, fontSize: 13.5, fontWeight: '700', color: colors.text },
  statEmpty: { fontSize: 12, color: colors.textMuted },
  stackedBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 12, color: colors.textMuted },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statSubLabel: { fontSize: 12, color: colors.textMuted },
  statSubValue: { fontSize: 13, fontWeight: '700', color: colors.text },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: radius.pill },
  statFootnote: { fontSize: 11, color: colors.textFaint, marginTop: spacing.sm },
});
