import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { sqlJadwalBukanObsolete, sqlJadwalCurrent } from '@/accounting/ScheduleLifecycle';
import { getDb } from '@/database/db';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute } from '@/navigation/izinRute';
import { getIdentityCompletionStatus, IdentityCompletion } from '@/services/SetupService';
import { colors } from '@/theme/colors';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import PanduanSlide from '@/components/panduan/PanduanSlide';
import { PANDUAN_APLIKASI } from '@/config/panduanAplikasi';
import { perluTampilkanPanduanAwal, tandaiPanduanAwalSudahDilihat } from '@/services/PanduanService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getLicenseStatus, type LicenseStatus } from '@/services/LicenseService';
import { useSyncStore } from '@/sync/SyncStore';
import { STATUS_SINKRON, waktuRelatif } from '@/desktop/shell/infoSinkron';
import {
  LABEL_TIPE_LISENSI,
  formatSisaWaktu,
  hitungSisaMs,
  tipeLisensiPakaiCountdown,
  urgensiSisaWaktu,
} from '@/utils/licenseCountdown';

/**
 * KOPKU DESKTOP — DASHBOARD.
 *
 * Tata letak desktop (grid multi-kolom) untuk FUNGSI YANG SAMA dengan
 * Dashboard HP (`DashboardScreen.tsx`, tidak diubah):
 *  - kueri ringkasan identik (anggota aktif/total, simpanan per jenis tanpa
 *    baris koreksi, total & jumlah pinjaman, piutang berjalan, tunggakan);
 *  - kartu Identitas Koperasi (status dari `getIdentityCompletionStatus`);
 *  - Panduan Aplikasi (otomatis sekali + dapat dibuka lagi);
 *  - kartu lisensi + countdown (tampilan saja; penegakan tetap LicenseGate,
 *    `triggerLicenseRecheck` saat akses tidak diizinkan / waktu habis);
 *  - Aksi Cepat disaring Permission Matrix;
 *  - Statistik: komposisi simpanan, kesehatan pinjaman, keanggotaan;
 *  - semua tujuan navigasi sama (rute & `initial: false`).
 * Tambahan desktop: kartu status Sinkron HP, tombol Muat ulang (pengganti
 * tarik-untuk-memuat-ulang), dan pemuatan ulang otomatis setelah data
 * diterima dari HP.
 */
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

type Ikon = keyof typeof Ionicons.glyphMap;

function sapaan(): string {
  const j = new Date().getHours();
  if (j < 11) return 'Selamat pagi';
  if (j < 15) return 'Selamat siang';
  if (j < 18) return 'Selamat sore';
  return 'Selamat malam';
}

export default function DashboardScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const user = useAppStore((s) => s.currentUser);
  const navigation = useNavigation<any>();
  const { permissions } = usePermission();
  // Tata letak mengikuti lebar AREA KONTEN (bukan jendela): sidebar lebar/ringkas ikut diperhitungkan.
  const [width, setWidth] = useState(1200);
  const lebar = width >= 1240;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identitas, setIdentitas] = useState<IdentityCompletion | null>(null);
  const [menyegarkan, setMenyegarkan] = useState(false);
  const [panduanTerbuka, setPanduanTerbuka] = useState(false);
  const statusSinkron = useSyncStore((s) => s.status);
  const terakhirSinkron = useSyncStore((s) => s.terakhirSinkron);
  const versiData = useSyncStore((s) => s.versiData);

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

  // Kueri SAMA dengan DashboardScreen.tsx (HP).
  const load = useCallback(async () => {
    setError(null);
    try {
      const db = await getDb();
      const anggotaAktif = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM anggota WHERE status = 'AKTIF'`);
      const totalAnggota = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM anggota`);
      const simpananPerJenis = await db.getAllAsync<{ jenis: string; total: number }>(
        `SELECT jenis, COALESCE(SUM(CASE WHEN tipe='SETOR' THEN nominal WHEN tipe='TARIK' THEN -nominal ELSE 0 END),0) as total
         FROM simpanan_transaksi
         WHERE reversal_of_id IS NULL
           AND id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)
         GROUP BY jenis`
      );
      const pinjaman = await db.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(jumlah_pinjaman),0) as total FROM pinjaman WHERE status IN ('AKTIF','LUNAS')`
      );
      const pinjamanAktifCount = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM pinjaman WHERE status = 'AKTIF'`);
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

  // ---- Lisensi (tampilan saja; penegakan milik LicenseGate)
  const triggerLicenseRecheck = useAppStore((s) => s.triggerLicenseRecheck);
  const [lisensi, setLisensi] = useState<LicenseStatus | null>(null);
  const [tikMs, setTikMs] = useState(() => Date.now());
  const sudahLaporBerakhir = useRef(false);

  const muatStatusLisensi = useCallback(async () => {
    try {
      const status = await getLicenseStatus();
      setLisensi(status);
      if (!status.allowAppAccess) triggerLicenseRecheck();
    } catch {
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

  useFocusRefresh(() => {
    load();
    void muatStatusIdentitas();
    void muatStatusLisensi();
  }, [load, muatStatusIdentitas, muatStatusLisensi]);

  // Desktop: data baru dari HP diterapkan -> segarkan angka.
  const versiAwal = useRef(versiData);
  useEffect(() => {
    if (versiAwal.current === versiData) return;
    versiAwal.current = versiData;
    void load();
  }, [versiData, load]);

  const tipeLisensi = lisensi?.licenseType ?? null;
  const pakaiCountdown = tipeLisensiPakaiCountdown(tipeLisensi) && lisensi?.expiresAt != null;
  const sisaMs = lisensi ? hitungSisaMs(lisensi.expiresAt, tikMs) : null;
  const urgensi = urgensiSisaWaktu(pakaiCountdown ? sisaMs : null);

  useEffect(() => {
    if (!pakaiCountdown) return;
    const interval = setInterval(() => setTikMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pakaiCountdown]);

  useEffect(() => {
    if (!pakaiCountdown || sisaMs === null || sisaMs > 0) {
      sudahLaporBerakhir.current = false;
      return;
    }
    if (sudahLaporBerakhir.current) return;
    sudahLaporBerakhir.current = true;
    void muatStatusLisensi();
  }, [pakaiCountdown, sisaMs, muatStatusLisensi]);

  const muatUlang = async () => {
    setMenyegarkan(true);
    await Promise.all([load(), muatStatusIdentitas(), muatStatusLisensi()]);
    setMenyegarkan(false);
  };

  if (error) {
    return (
      <View style={s.tengah}>
        <Ionicons name="alert-circle-outline" size={36} color={colors.danger} />
        <Text style={s.galat}>{error}</Text>
        <Pressable style={s.tombolUtama} onPress={load}>
          <Text style={s.tombolUtamaTeks}>Coba Lagi</Text>
        </Pressable>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={s.tengah}>
        <ActivityIndicator color={colors.primary} />
        <Text style={s.memuat}>Memuat ringkasan koperasi…</Text>
      </View>
    );
  }

  const totalSimpanan = data.totalSimpanan || 1;
  const komposisi = [
    { label: 'Pokok', value: data.simpananPokok, color: colors.primary },
    { label: 'Wajib', value: data.simpananWajib, color: '#38A169' },
    { label: 'Sukarela', value: data.simpananSukarela, color: '#D69E2E' },
  ];
  const persenTunggakan = data.piutang > 0 ? Math.min(100, Math.round((data.tunggakan / data.piutang) * 100)) : 0;
  const persenAnggotaAktif = data.totalAnggota > 0 ? Math.round((data.anggotaAktif / data.totalAnggota) * 100) : 0;

  const buka = {
    anggota: () => navigation.navigate('Anggota', { screen: 'AnggotaList', initial: false }),
    simpanan: () => navigation.navigate('Transaksi', { screen: 'SimpananHistori', initial: false }),
    pinjaman: () => navigation.navigate('Transaksi', { screen: 'PinjamanList', initial: false }),
    tunggakan: () => navigation.navigate('Laporan', { screen: 'KolektibilitasPiutang', initial: false }),
    bayarAngsuran: () => navigation.navigate('Transaksi', { screen: 'BayarAngsuranForm', initial: false }),
    tarikSimpanan: () => navigation.navigate('Transaksi', { screen: 'TarikSimpananForm', initial: false }),
    laporan: () => navigation.navigate('Laporan', { screen: 'LaporanMenu' }),
    sinkron: () => navigation.navigate('Pengaturan', { screen: 'SinkronPerangkat', initial: false }),
  };

  const aksiCepat = (
    [
      { icon: 'add-circle-outline', label: 'Setor Simpanan', ket: 'Catat setoran pokok, wajib, sukarela', rute: 'SimpananForm', onPress: buka.simpanan },
      { icon: 'remove-circle-outline', label: 'Tarik Simpanan', ket: 'Penarikan simpanan anggota', rute: 'TarikSimpananForm', onPress: buka.tarikSimpanan },
      { icon: 'receipt-outline', label: 'Bayar Angsuran', ket: 'Terima pembayaran piutang anggota', rute: 'BayarAngsuranForm', onPress: buka.bayarAngsuran },
      { icon: 'bar-chart-outline', label: 'Laporan', ket: 'Laporan keuangan koperasi', rute: 'LabaRugi', onPress: buka.laporan },
    ] as { icon: Ikon; label: string; ket: string; rute: string; onPress: () => void }[]
  ).filter((a) => bolehBukaRute(a.rute, permissions));

  const warnaUrgensi =
    urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR' ? colors.danger : urgensi === 'SEGERA_HABIS' ? colors.warning : colors.primary;
  const sync = STATUS_SINKRON[statusSinkron];

  // ---------------- Kolom kanan (status & informasi)
  const sel = !lebar ? s.panelSel : null;
  const kolomKanan = (
    <View style={[s.kolomKanan, !lebar && s.kolomKananBawah]}>
      {lisensi && tipeLisensi && (
        <View style={[s.panel, sel, (urgensi === 'HAMPIR_HABIS' || urgensi === 'BERAKHIR') && { borderColor: '#F3C2C0' }]}>
          <View style={s.panelKepala}>
            <View style={[s.panelIkon, { backgroundColor: warnaUrgensi + '18' }]}>
              <Ionicons name={pakaiCountdown ? 'time-outline' : 'shield-checkmark-outline'} size={17} color={warnaUrgensi} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.panelJudul}>{LABEL_TIPE_LISENSI[tipeLisensi]}</Text>
              {!!lisensi.cooperativeName && <Text style={s.panelSub}>Koperasi: {lisensi.cooperativeName}</Text>}
            </View>
          </View>
          {pakaiCountdown && sisaMs !== null ? (
            <View style={s.countdown}>
              <Text style={s.countdownLabel}>Sisa waktu</Text>
              <Text style={[s.countdownNilai, { color: warnaUrgensi }]}>{formatSisaWaktu(sisaMs)}</Text>
            </View>
          ) : (
            <View style={s.lencana}>
              <View style={[s.titik, { backgroundColor: colors.success }]} />
              <Text style={s.lencanaTeks}>Aktif · tanpa batas waktu</Text>
            </View>
          )}
        </View>
      )}

      <Pressable onPress={buka.sinkron} style={({ hovered }: any) => [s.panel, sel, hovered && s.panelHover]}>
        <View style={s.panelKepala}>
          <View style={[s.panelIkon, { backgroundColor: sync.warna + '18' }]}>
            <Ionicons name="phone-portrait-outline" size={17} color={sync.warna} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.panelJudul}>Sinkron HP</Text>
            <Text style={[s.panelSub, { color: sync.warna, fontWeight: '600' }]}>{sync.label}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
        </View>
        <Text style={s.panelCatatan}>
          {terakhirSinkron
            ? `Kirim data terakhir ${waktuRelatif(terakhirSinkron)}. Hubungkan HP lalu kirim data HP ⇄ PC kapan saja.`
            : 'Hubungkan HP lewat QR, lalu kirim data HP ⇄ PC sesuai kebutuhan.'}
        </Text>
      </Pressable>

      {identitas && (
        <Pressable
          onPress={() => navigation.navigate('IdentitasKoperasi')}
          style={({ hovered }: any) => [s.panel, sel, identitas.status !== 'COMPLETE' && s.panelPerhatian, hovered && s.panelHover]}
        >
          <View style={s.panelKepala}>
            <View style={[s.panelIkon, { backgroundColor: identitas.status === 'COMPLETE' ? '#E6F4EC' : colors.warningBg }]}>
              <Ionicons
                name={identitas.status === 'COMPLETE' ? 'checkmark-circle-outline' : 'business-outline'}
                size={17}
                color={identitas.status === 'COMPLETE' ? colors.success : colors.warning}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.panelJudul}>{identitas.status === 'COMPLETE' ? 'Identitas Koperasi' : 'Lengkapi Identitas Koperasi'}</Text>
              <Text style={s.panelSub}>
                {identitas.status === 'COMPLETE' ? 'Identitas lengkap' : 'Lengkapi data koperasi untuk laporan dan dokumen.'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
          </View>
          {identitas.status !== 'COMPLETE' && <Text style={s.cta}>Lengkapi Sekarang →</Text>}
        </Pressable>
      )}

      <Pressable onPress={() => setPanduanTerbuka(true)} style={({ hovered }: any) => [s.panel, sel, hovered && s.panelHover]} accessibilityLabel="Buka panduan aplikasi">
        <View style={s.panelKepala}>
          <View style={[s.panelIkon, { backgroundColor: colors.primaryLight }]}>
            <Ionicons name="book-outline" size={17} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.panelJudul}>Panduan Aplikasi</Text>
            <Text style={s.panelSub}>Kenali menu utama dan langkah awal dalam 8 slide singkat.</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
        </View>
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ScrollView contentContainerStyle={s.isi}>
        {/* ---------------- KEPALA HALAMAN */}
        <View style={s.kepala}>
          {koperasi?.logoUri ? (
            <View style={s.logoWadah}>
              <Image source={{ uri: koperasi.logoUri }} style={s.logo} resizeMode="contain" accessibilityLabel={`Logo ${koperasi.nama}`} />
            </View>
          ) : (
            <View style={[s.logoWadah, { backgroundColor: colors.primary, borderColor: colors.primary }]}>
              <Ionicons name="business" size={24} color={colors.white} />
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.sapaan}>
              {sapaan()}
              {user?.nama ? `, ${user.nama.split(' ')[0]}` : ''} · {formatTanggalIndonesia(getTanggalLokalHariIni())}
            </Text>
            <Text style={s.judul} numberOfLines={1}>
              {koperasi?.nama ?? 'Koperasi'}
            </Text>
            <View style={s.chipBaris}>
              <View style={s.chip}>
                <Ionicons name="calendar-outline" size={12} color={colors.primary} />
                <Text style={s.chipTeks}>Tahun Buku {koperasi?.tahunBukuAktif}</Text>
              </View>
              <View style={s.chip}>
                <Ionicons name="people-outline" size={12} color={colors.primary} />
                <Text style={s.chipTeks}>{data.totalAnggota} anggota</Text>
              </View>
            </View>
          </View>
          <Pressable onPress={() => setPanduanTerbuka(true)} style={({ hovered }: any) => [s.tombolSekunder, hovered && s.panelHover]}>
            <Ionicons name="book-outline" size={15} color={colors.text} />
            <Text style={s.tombolSekunderTeks}>Panduan</Text>
          </Pressable>
          <Pressable onPress={muatUlang} disabled={menyegarkan} style={({ hovered }: any) => [s.tombolSekunder, hovered && s.panelHover]} accessibilityLabel="Muat ulang dashboard">
            {menyegarkan ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="refresh" size={15} color={colors.text} />}
            <Text style={s.tombolSekunderTeks}>Muat ulang</Text>
          </Pressable>
        </View>

        <View style={[s.tata, !lebar && { flexDirection: 'column' }]}>
          <View style={{ flex: 1, minWidth: 0, gap: 18 }}>
            {/* ---------------- HERO + KPI */}
            <View style={[s.barisAtas, width < 1000 && { flexDirection: 'column' }]}>
              <Pressable onPress={buka.simpanan} style={({ hovered }: any) => [s.hero, hovered && { opacity: 0.96 }]} accessibilityRole="button" accessibilityLabel="Total Simpanan">
                <View style={s.heroKepala}>
                  <View style={s.heroIkon}>
                    <Ionicons name="wallet" size={16} color="#fff" />
                  </View>
                  <Text style={s.heroLabel}>Total Simpanan Anggota</Text>
                  <Ionicons name="arrow-forward" size={15} color="rgba(255,255,255,0.7)" />
                </View>
                <Text style={s.heroNilai} numberOfLines={1} adjustsFontSizeToFit>
                  {formatRupiah(data.totalSimpanan)}
                </Text>
                <View style={s.heroBar}>
                  {data.totalSimpanan > 0 &&
                    komposisi.map((k, i) =>
                      k.value > 0 ? <View key={k.label} style={{ flex: k.value, backgroundColor: ['#FFFFFF', '#9AE6B4', '#F6E05E'][i] }} /> : null
                    )}
                </View>
                <View style={s.heroRincian}>
                  {komposisi.map((k, i) => (
                    <View key={k.label} style={s.heroItem}>
                      <View style={s.heroItemKepala}>
                        <View style={[s.titik, { backgroundColor: ['#FFFFFF', '#9AE6B4', '#F6E05E'][i] }]} />
                        <Text style={s.heroItemLabel}>Simpanan {k.label}</Text>
                      </View>
                      <Text style={s.heroItemNilai} numberOfLines={1} adjustsFontSizeToFit>
                        {formatRupiah(k.value)}
                      </Text>
                    </View>
                  ))}
                </View>
              </Pressable>

              <View style={s.kpiGrid}>
                <Kpi icon="people-outline" label="Anggota Aktif" value={data.anggotaAktif.toString()} sub={`dari ${data.totalAnggota} anggota`} onPress={buka.anggota} />
                <Kpi icon="cash-outline" label="Total Pinjaman" value={formatRupiah(data.totalPinjaman)} sub={`${data.pinjamanAktifCount} pinjaman aktif`} onPress={buka.pinjaman} />
                <Kpi
                  icon="hourglass-outline"
                  label="Piutang Berjalan"
                  value={formatRupiah(data.piutangPokok)}
                  sub={data.sisaJasa > 0 ? `Sisa pokok · + jasa terjadwal ${formatRupiah(data.sisaJasa)}` : 'Sisa pokok pinjaman aktif'}
                  onPress={buka.pinjaman}
                />
                <Kpi
                  icon="alert-circle-outline"
                  label="Tunggakan"
                  value={formatRupiah(data.tunggakan)}
                  sub={data.tunggakan > 0 ? 'Lihat kolektibilitas' : 'Tidak ada tunggakan'}
                  warn={data.tunggakan > 0}
                  onPress={buka.tunggakan}
                />
              </View>
            </View>

            {/* ---------------- AKSI CEPAT */}
            <View style={s.bagian}>
              <View style={s.bagianKepala}>
                <Text style={s.bagianJudul}>Aksi Cepat</Text>
                <Text style={s.bagianSub}>Ctrl+K untuk mencari menu lain</Text>
              </View>
              {aksiCepat.length === 0 ? (
                <Text style={s.kosong}>Tidak ada aksi cepat untuk role Anda.</Text>
              ) : (
                <View style={s.aksiGrid}>
                  {aksiCepat.map((a) => (
                    <Pressable key={a.label} onPress={a.onPress} style={({ hovered }: any) => [s.aksi, hovered && s.aksiHover]} accessibilityRole="button" accessibilityLabel={a.label}>
                      <View style={s.aksiIkon}>
                        <Ionicons name={a.icon} size={19} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={s.aksiJudul}>{a.label}</Text>
                        <Text style={s.aksiKet} numberOfLines={1}>
                          {a.ket}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {/* ---------------- STATISTIK */}
            <View style={s.bagian}>
              <View style={s.bagianKepala}>
                <Text style={s.bagianJudul}>Statistik</Text>
              </View>
              <View style={[s.statGrid, width < 900 && { flexDirection: 'column' }]}>
                <Pressable style={({ hovered }: any) => [s.stat, hovered && s.panelHover]} onPress={buka.simpanan}>
                  <StatKepala icon="pie-chart-outline" title="Komposisi Simpanan" />
                  {data.totalSimpanan === 0 ? (
                    <Text style={s.kosong}>Belum ada data simpanan.</Text>
                  ) : (
                    <>
                      <View style={s.stackBar}>
                        {komposisi.map((k) => (k.value > 0 ? <View key={k.label} style={{ flex: k.value, backgroundColor: k.color, height: '100%' }} /> : null))}
                      </View>
                      {komposisi.map((k) => (
                        <View key={k.label} style={s.legenda}>
                          <View style={[s.titik, { backgroundColor: k.color }]} />
                          <Text style={s.legendaLabel}>{k.label}</Text>
                          <Text style={s.legendaNilai}>{Math.round((k.value / totalSimpanan) * 100)}%</Text>
                        </View>
                      ))}
                    </>
                  )}
                </Pressable>

                <Pressable style={({ hovered }: any) => [s.stat, hovered && s.panelHover]} onPress={buka.tunggakan}>
                  <StatKepala icon="pulse-outline" title="Kesehatan Pinjaman" />
                  {data.piutang === 0 ? (
                    <Text style={s.kosong}>Tidak ada piutang berjalan saat ini.</Text>
                  ) : (
                    <>
                      <Text style={[s.statAngka, persenTunggakan > 0 && { color: colors.danger }]}>{persenTunggakan}%</Text>
                      <Text style={s.statLabel}>Tunggakan dari Sisa Angsuran</Text>
                      <View style={s.track}>
                        <View style={[s.fill, { width: `${persenTunggakan}%`, backgroundColor: persenTunggakan > 20 ? colors.danger : colors.warning }]} />
                      </View>
                      <Text style={s.catatan}>
                        {data.pinjamanAktifCount} pinjaman aktif · {formatRupiah(data.piutangPokok)} sisa pokok · {formatRupiah(data.piutang)} sisa angsuran
                      </Text>
                    </>
                  )}
                </Pressable>

                <Pressable style={({ hovered }: any) => [s.stat, hovered && s.panelHover]} onPress={buka.anggota}>
                  <StatKepala icon="people-circle-outline" title="Keanggotaan" />
                  <Text style={s.statAngka}>{persenAnggotaAktif}%</Text>
                  <Text style={s.statLabel}>Anggota Aktif dari Total Anggota</Text>
                  <View style={s.track}>
                    <View style={[s.fill, { width: `${persenAnggotaAktif}%`, backgroundColor: colors.primary }]} />
                  </View>
                  <Text style={s.catatan}>
                    {data.anggotaAktif} aktif dari {data.totalAnggota} total anggota
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>

          {kolomKanan}
        </View>
      </ScrollView>
      <PanduanSlide visible={panduanTerbuka} slides={PANDUAN_APLIKASI} onTutup={tutupPanduan} />
    </View>
  );
}

function Kpi({ icon, label, value, sub, warn, onPress }: { icon: Ikon; label: string; value: string; sub?: string; warn?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      style={({ hovered }: any) => [s.kpi, warn && s.kpiWarn, hovered && s.panelHover]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={s.kpiKepala}>
        <Text style={s.kpiLabel}>{label}</Text>
        <View style={[s.kpiIkon, warn && { backgroundColor: colors.dangerBg }]}>
          <Ionicons name={icon} size={15} color={warn ? colors.danger : colors.primary} />
        </View>
      </View>
      <Text style={[s.kpiNilai, warn && { color: colors.danger }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? (
        <Text style={s.kpiSub} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );
}

function StatKepala({ icon, title }: { icon: Ikon; title: string }) {
  return (
    <View style={s.statKepala}>
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={s.statJudul}>{title}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
    </View>
  );
}

const kartu = {
  backgroundColor: colors.surface,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 12,
  shadowColor: '#101828',
  shadowOpacity: 0.04,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
};

const s = StyleSheet.create({
  isi: { padding: 28, paddingBottom: 40 },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  galat: { fontSize: 14, color: colors.danger, textAlign: 'center', maxWidth: 520 },
  memuat: { fontSize: 13, color: colors.textMuted },
  tombolUtama: { backgroundColor: colors.primary, paddingHorizontal: 18, height: 38, borderRadius: 8, justifyContent: 'center' },
  tombolUtamaTeks: { color: '#fff', fontWeight: '700' },

  kepala: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 22 },
  logoWadah: { width: 56, height: 56, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logo: { width: 48, height: 48 },
  sapaan: { fontSize: 13, color: colors.textMuted },
  judul: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: -0.4, marginTop: 2 },
  chipBaris: { flexDirection: 'row', gap: 8, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primaryLight, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipTeks: { fontSize: 11.5, color: colors.primary, fontWeight: '700' },
  tombolSekunder: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tombolSekunderTeks: { fontSize: 13, fontWeight: '600', color: colors.text },

  tata: { flexDirection: 'row', gap: 20, alignItems: 'flex-start' },
  kolomKanan: { width: 340, gap: 12 },
  kolomKananBawah: { width: '100%', flexDirection: 'row', flexWrap: 'wrap' },

  barisAtas: { flexDirection: 'row', gap: 16 },
  hero: {
    flex: 1.15,
    minWidth: 0,
    borderRadius: 14,
    padding: 22,
    backgroundColor: colors.primary,
    backgroundImage: 'linear-gradient(135deg, #0F5530 0%, #146C3C 55%, #1F8A4F 100%)',
    shadowColor: '#0D4A29',
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  } as any,
  heroKepala: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroIkon: { width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  heroLabel: { flex: 1, fontSize: 13.5, color: 'rgba(255,255,255,0.88)', fontWeight: '600' },
  heroNilai: { fontSize: 34, fontWeight: '800', color: '#FFFFFF', marginTop: 16, letterSpacing: -0.5 },
  heroBar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 16, gap: 2 },
  heroRincian: { flexDirection: 'row', gap: 12, marginTop: 16 },
  heroItem: { flex: 1, minWidth: 0, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 10, padding: 10 },
  heroItemKepala: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroItemLabel: { fontSize: 11.5, color: 'rgba(255,255,255,0.8)' },
  heroItemNilai: { fontSize: 15, fontWeight: '700', color: '#fff', marginTop: 4 },

  kpiGrid: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  kpi: { ...kartu, flexBasis: '47%', flexGrow: 1, padding: 16, minHeight: 104 } as any,
  kpiWarn: { borderColor: '#F3C2C0' },
  kpiKepala: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kpiLabel: { fontSize: 12.5, color: colors.textMuted, fontWeight: '600' },
  kpiIkon: { width: 28, height: 28, borderRadius: 7, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  kpiNilai: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 10, letterSpacing: -0.3 },
  kpiSub: { fontSize: 11.5, color: colors.textFaint, marginTop: 3 },

  bagian: { ...kartu, padding: 18 },
  bagianKepala: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 },
  bagianJudul: { fontSize: 15, fontWeight: '800', color: colors.text },
  bagianSub: { fontSize: 11.5, color: colors.textFaint },
  kosong: { fontSize: 12.5, color: colors.textMuted, marginTop: 4 },

  aksiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  aksi: { flexDirection: 'row', alignItems: 'center', gap: 12, flexBasis: '48%', flexGrow: 1, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: '#FBFCFD' } as any,
  aksiHover: { borderColor: colors.primary, backgroundColor: '#F4FAF6' },
  aksiIkon: { width: 36, height: 36, borderRadius: 9, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  aksiJudul: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  aksiKet: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },

  statGrid: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, minWidth: 0, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: '#FBFCFD' },
  statKepala: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  statJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  statAngka: { fontSize: 24, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 11.5, color: colors.textMuted, marginBottom: 10 },
  stackBar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: '#EDF0F3', marginBottom: 12 },
  legenda: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  legendaLabel: { flex: 1, fontSize: 12.5, color: colors.textMuted },
  legendaNilai: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  track: { height: 8, borderRadius: 4, backgroundColor: '#EDF0F3', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  catatan: { fontSize: 11.5, color: colors.textFaint, marginTop: 10 },
  titik: { width: 8, height: 8, borderRadius: 4 },

  panel: { ...kartu, padding: 14 },
  panelHover: { borderColor: '#C9D3DD' },
  panelSel: { flexBasis: '48%', flexGrow: 1 } as any,
  panelPerhatian: { borderColor: colors.warningBorder, backgroundColor: '#FFFDF7' },
  panelKepala: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  panelIkon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  panelJudul: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  panelSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  panelCatatan: { fontSize: 11.5, color: colors.textMuted, marginTop: 10, lineHeight: 17 },
  cta: { fontSize: 12.5, fontWeight: '700', color: colors.warning, marginTop: 10 },
  countdown: { marginTop: 12, padding: 10, borderRadius: 8, backgroundColor: '#F7F8FA' },
  countdownLabel: { fontSize: 11, color: colors.textMuted },
  countdownNilai: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  lencana: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  lencanaTeks: { fontSize: 12, color: colors.success, fontWeight: '600' },
});
