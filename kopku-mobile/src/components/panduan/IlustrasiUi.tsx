import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import type { JenisIlustrasi } from '@/config/panduanAplikasi';

/**
 * ILUSTRASI UI APLIKASI untuk panduan — digambar dengan komponen React
 * Native (bukan file gambar), meniru tata letak & warna layar KOPKU
 * sebenarnya. Elemen yang sedang dijelaskan diberi SOROTAN berdenyut.
 * Murni tampilan: tidak membaca data apa pun.
 */

const LEBAR = 208;
const TINGGI = 372;

/** Cincin sorotan berdenyut di sekeliling elemen yang dijelaskan. */
function Sorotan({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const denyut = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(denyut, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(denyut, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [denyut]);
  return (
    <View style={style}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          styles.sorotan,
          {
            opacity: denyut.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
            transform: [{ scale: denyut.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }],
          },
        ]}
      />
    </View>
  );
}

function Bingkai({ judul, children, tabAktif }: { judul?: string; children: React.ReactNode; tabAktif?: number }) {
  return (
    <View style={styles.bingkai} accessible accessibilityRole="image">
      <View style={styles.layar}>
        <View style={styles.statusBar}>
          <Text style={styles.statusJam}>09.41</Text>
          <View style={{ flexDirection: 'row', gap: 3 }}>
            <Ionicons name="cellular" size={8} color={colors.text} />
            <Ionicons name="battery-full" size={8} color={colors.text} />
          </View>
        </View>
        {judul ? (
          <View style={styles.header}>
            <Ionicons name="chevron-back" size={10} color={colors.white} />
            <Text style={styles.headerTeks} numberOfLines={1}>
              {judul}
            </Text>
          </View>
        ) : null}
        <View style={styles.isi}>{children}</View>
        {tabAktif !== undefined ? <TabBar aktif={tabAktif} /> : null}
      </View>
    </View>
  );
}

const TAB: { ikon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { ikon: 'grid', label: 'Dashboard' },
  { ikon: 'people', label: 'Data' },
  { ikon: 'swap-horizontal', label: 'Transaksi' },
  { ikon: 'document-text', label: 'Laporan' },
  { ikon: 'settings', label: 'Pengaturan' },
];

function TabBar({ aktif }: { aktif: number }) {
  return (
    <View style={styles.tabBar}>
      {TAB.map((t, i) => (
        <View key={t.label} style={styles.tabItem}>
          <Ionicons name={t.ikon} size={11} color={i === aktif ? colors.primary : colors.textFaint} />
          <Text style={[styles.tabLabel, i === aktif && { color: colors.primary, fontWeight: '700' }]}>{t.label}</Text>
        </View>
      ))}
    </View>
  );
}

const Garis = ({ lebar = '70%', tebal = 5, warna = colors.border }: { lebar?: `${number}%` | number; tebal?: number; warna?: string }) => (
  <View style={{ width: lebar, height: tebal, borderRadius: 3, backgroundColor: warna, marginTop: 3 }} />
);

function Kartu({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.kartu, style]}>{children}</View>;
}

function BarisMenu({ ikon, judul, sorot }: { ikon: keyof typeof Ionicons.glyphMap; judul: string; sorot?: boolean }) {
  const isi = (
    <View style={styles.barisMenu}>
      <View style={styles.ikonBulat}>
        <Ionicons name={ikon} size={10} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.teksKecilTebal} numberOfLines={1}>
          {judul}
        </Text>
        <Garis lebar="80%" tebal={3} />
      </View>
      <Ionicons name="chevron-forward" size={9} color={colors.textFaint} />
    </View>
  );
  return sorot ? <Sorotan style={{ borderRadius: 8 }}>{isi}</Sorotan> : isi;
}

function Tombol({ teks, sorot }: { teks: string; sorot?: boolean }) {
  const isi = (
    <View style={styles.tombol}>
      <Text style={styles.tombolTeks}>{teks}</Text>
    </View>
  );
  return sorot ? <Sorotan style={{ borderRadius: 6, marginTop: 6 }}>{isi}</Sorotan> : <View style={{ marginTop: 6 }}>{isi}</View>;
}

function Segmen({ kiri, kanan, aktifKanan, sorot }: { kiri: string; kanan: string; aktifKanan?: boolean; sorot?: boolean }) {
  const isi = (
    <View style={styles.segmen}>
      {[kiri, kanan].map((t, i) => {
        const aktif = (i === 1) === !!aktifKanan;
        return (
          <View key={t} style={[styles.segmenItem, aktif && styles.segmenAktif]}>
            <Text style={[styles.segmenTeks, aktif && { color: colors.white }]}>{t}</Text>
          </View>
        );
      })}
    </View>
  );
  return sorot ? <Sorotan style={{ borderRadius: 8 }}>{isi}</Sorotan> : isi;
}

function Saklar({ nyala = true }: { nyala?: boolean }) {
  return (
    <View style={[styles.saklar, { backgroundColor: nyala ? colors.primary : colors.border, alignItems: nyala ? 'flex-end' : 'flex-start' }]}>
      <View style={styles.saklarBulat} />
    </View>
  );
}

function Stat({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.teksMini}>{label}</Text>
      <Text style={styles.teksKecilTebal}>{nilai}</Text>
    </View>
  );
}

// ------------------------------------------------------------------

function Sambutan() {
  return (
    <View style={styles.sambutan}>
      <View style={styles.logo}>
        <Ionicons name="wallet" size={34} color={colors.white} />
      </View>
      <Text style={styles.namaApp}>KOPKU</Text>
      <Text style={styles.teksMini}>Akuntansi Koperasi Simpan Pinjam</Text>
      <View style={styles.chipBaris}>
        {['Simpanan', 'Pinjaman', 'Kas & Bank', 'Laporan'].map((c) => (
          <View key={c} style={styles.chip}>
            <Text style={styles.chipTeks}>{c}</Text>
          </View>
        ))}
      </View>
      <View style={styles.lencanaSak}>
        <Ionicons name="shield-checkmark" size={10} color={colors.primary} />
        <Text style={styles.teksMiniHijau}>SAK EP · Juklat SOM 2025</Text>
      </View>
    </View>
  );
}

function Dashboard() {
  return (
    <Bingkai tabAktif={0}>
      <Text style={styles.sapa}>Selamat pagi, Admin</Text>
      <Sorotan style={{ borderRadius: 10, marginTop: 6 }}>
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>TOTAL SIMPANAN</Text>
          <Text style={styles.heroNilai}>Rp1.254.300.000</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
            {['Pokok', 'Wajib', 'Sukarela'].map((k) => (
              <View key={k} style={{ flex: 1 }}>
                <Text style={styles.heroMini}>{k}</Text>
                <View style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.45)', marginTop: 2 }} />
              </View>
            ))}
          </View>
        </View>
      </Sorotan>
      <View style={styles.grid}>
        <Stat label="Anggota Aktif" nilai="128" />
        <Stat label="Total Pinjaman" nilai="Rp842 jt" />
        <Stat label="Tunggakan" nilai="3 angsuran" />
        <Stat label="Kas & Bank" nilai="Rp96 jt" />
      </View>
      <Kartu style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="business-outline" size={11} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.teksKecilTebal}>Identitas Koperasi</Text>
          <Garis lebar="60%" tebal={3} />
        </View>
      </Kartu>
    </Bingkai>
  );
}

function DataAnggota() {
  return (
    <Bingkai judul="Data Anggota" tabAktif={1}>
      <View style={styles.cari}>
        <Ionicons name="search" size={9} color={colors.textFaint} />
        <Text style={styles.teksMini}>Cari nama atau nomor anggota</Text>
      </View>
      {['Andi Saputra', 'Budi Hartono', 'Citra Lestari', 'Dewi Anggraini'].map((n, i) => (
        <View key={n} style={styles.barisAnggota}>
          <View style={styles.avatar}>
            <Text style={styles.avatarTeks}>{n[0]}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.teksKecilTebal}>{n}</Text>
            <Text style={styles.teksMini}>A-00{i + 1} · Aktif</Text>
          </View>
          <Ionicons name="chevron-forward" size={9} color={colors.textFaint} />
        </View>
      ))}
      <Sorotan style={styles.fab}>
        <View style={styles.fabIsi}>
          <Ionicons name="add" size={18} color={colors.white} />
        </View>
      </Sorotan>
    </Bingkai>
  );
}

function TransaksiRiwayat() {
  return (
    <Bingkai judul="Setor Simpanan" tabAktif={2}>
      <Segmen kiri="Setor Simpanan" kanan="Riwayat" aktifKanan sorot />
      <Kartu style={{ marginTop: 6 }}>
        <Text style={styles.teksKecilTebal}>Riwayat Simpanan</Text>
        <Text style={styles.heroNilaiGelap}>Rp18.450.000</Text>
        <Text style={styles.teksMini}>12 transaksi · bulan ini</Text>
      </Kartu>
      <Text style={styles.judulBulan}>OKTOBER 2026</Text>
      {[
        ['04', 'Setoran sukarela · Andi', 'Rp500.000', false],
        ['03', 'Simpanan wajib · Budi', 'Rp100.000', false],
        ['02', 'Setoran sukarela · Citra', 'Rp250.000', true],
      ].map(([tgl, ket, nom, batal]) => (
        <View key={String(tgl)} style={styles.barisRiwayat}>
          <View style={styles.kotakTanggal}>
            <Text style={styles.kotakTanggalAngka}>{tgl}</Text>
            <Text style={styles.teksMini}>Okt</Text>
          </View>
          <Text style={[styles.teksKecil, { flex: 1 }, batal ? styles.coret : null]} numberOfLines={1}>
            {ket}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.teksKecilTebal, batal ? styles.coret : null]}>{nom}</Text>
            {batal ? <Text style={styles.lencanaBatal}>Dibatalkan</Text> : null}
          </View>
        </View>
      ))}
    </Bingkai>
  );
}

function Penyesuaian() {
  return (
    <Bingkai judul="Penyesuaian" tabAktif={2}>
      <BarisMenu ikon="analytics-outline" judul="Kolektibilitas Piutang" />
      <BarisMenu ikon="git-compare-outline" judul="Rekonsiliasi Kas/Bank" />
      <BarisMenu ikon="stats-chart-outline" judul="Penyesuaian Nilai Wajar" />
      <BarisMenu ikon="home-outline" judul="Penyusutan Properti Investasi" />
      <BarisMenu ikon="cash-outline" judul="Bunga Simpanan Sukarela" sorot />
      <BarisMenu ikon="trending-down-outline" judul="Impairment Investasi" />
    </Bingkai>
  );
}

function Laporan() {
  return (
    <Bingkai judul="Laporan Posisi Keuangan" tabAktif={3}>
      <View style={styles.kertas}>
        <View style={styles.kop}>
          <Text style={styles.kopNama}>KOPERASI SIMPAN PINJAM “KENANGA”</Text>
          <Text style={styles.kopJudul}>Laporan Posisi Keuangan</Text>
          <Text style={styles.teksMini}>Tanggal 31 Desember 2025 dan 2026</Text>
        </View>
        <View style={[styles.barisTabel, { backgroundColor: colors.background }]}>
          <Text style={[styles.selLabel, styles.teksMiniTebal]} />
          <Text style={[styles.selAngka, styles.teksMiniTebal]}>2025</Text>
          <Text style={[styles.selAngka, styles.teksMiniTebal]}>2026</Text>
        </View>
        {[
          ['ASET', '', '', true],
          ['Kas', '26.750.000', '69.550.000', false],
          ['Pinjaman anggota', '174.000.000', '230.000.000', false],
          ['Total aset', '569.958.131', '744.382.212', true],
        ].map(([l, a, b, tebal]) => (
          <View key={String(l)} style={styles.barisTabel}>
            <Text style={[styles.selLabel, tebal ? styles.teksMiniTebal : styles.teksMini]}>{l}</Text>
            <Text style={[styles.selAngka, styles.teksMini]}>{a}</Text>
            <Text style={[styles.selAngka, styles.teksMini]}>{b}</Text>
          </View>
        ))}
      </View>
      <Sorotan style={{ borderRadius: 8, marginTop: 8 }}>
        <View style={styles.lembarExport}>
          <Text style={styles.teksKecilTebal}>Export</Text>
          <Segmen kiri="Juklat SOM 2025" kanan="Standar" />
          <View style={{ flexDirection: 'row', gap: 4, marginTop: 5 }}>
            {['PDF', 'Excel', 'CSV'].map((f) => (
              <View key={f} style={styles.chipFormat}>
                <Text style={styles.chipTeks}>{f}</Text>
              </View>
            ))}
          </View>
        </View>
      </Sorotan>
    </Bingkai>
  );
}

function Pengaturan() {
  return (
    <Bingkai judul="Pengaturan" tabAktif={4}>
      <BarisMenu ikon="business-outline" judul="Identitas Koperasi" />
      <BarisMenu ikon="cloud-upload-outline" judul="Backup & Restore" sorot />
      <BarisMenu ikon="documents-outline" judul="Import Data Awal" />
      <BarisMenu ikon="people-outline" judul="User Management" />
      <BarisMenu ikon="shield-checkmark-outline" judul="Permission Matrix" />
    </Bingkai>
  );
}

function LangkahAwal() {
  return (
    <View style={styles.ceklis}>
      {[
        ['Lengkapi Identitas Koperasi', 'business-outline', true],
        ['Saldo awal / Import Data Awal', 'documents-outline', false],
        ['Catat transaksi harian', 'swap-horizontal', false],
      ].map(([t, ikon, selesai], i) => (
        <View key={String(t)} style={styles.ceklisBaris}>
          <View style={[styles.ceklisBulat, selesai ? styles.ceklisSelesai : null]}>
            {selesai ? <Ionicons name="checkmark" size={14} color={colors.white} /> : <Text style={styles.ceklisAngka}>{i + 1}</Text>}
          </View>
          <View style={styles.ceklisKartu}>
            <Ionicons name={ikon as keyof typeof Ionicons.glyphMap} size={14} color={colors.primary} />
            <Text style={styles.ceklisTeks}>{t}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function BungaRumus() {
  const ruas = (d: number) => (d < 3 ? 0.25 : d < 10 ? 0.5 : d < 23 ? 0.9 : 0.6);
  return (
    <View style={styles.rumusWadah}>
      <Text style={styles.teksKecilTebal}>Desember · saldo akhir hari</Text>
      <View style={styles.kalender}>
        {Array.from({ length: 31 }, (_, i) => (
          <View key={i} style={[styles.hari, { backgroundColor: `rgba(27,94,32,${ruas(i + 1)})` }]}>
            <Text style={[styles.hariAngka, ruas(i + 1) > 0.5 && { color: colors.white }]}>{i + 1}</Text>
          </View>
        ))}
      </View>
      <Sorotan style={{ borderRadius: 10, marginTop: 10 }}>
        <View style={styles.rumus}>
          <Text style={styles.rumusTeks}>Saldo akhir hari × Tarif ÷ 365</Text>
          <Text style={styles.teksMini}>dijumlah untuk 31 hari → bunga bulan ini</Text>
        </View>
      </Sorotan>
    </View>
  );
}

function BungaKebijakan() {
  return (
    <Bingkai judul="Bunga Simpanan Sukarela">
      <Segmen kiri="Akrual Bulanan" kanan="Kebijakan" aktifKanan />
      <Kartu style={{ marginTop: 6 }}>
        <Text style={styles.teksKecilTebal}>Kebijakan Bunga Simpanan Sukarela</Text>
        <Sorotan style={{ borderRadius: 6, marginTop: 5 }}>
          <View style={styles.barisSaklar}>
            <Text style={[styles.teksKecil, { flex: 1 }]}>Bunga Simpanan Sukarela</Text>
            <Saklar />
          </View>
        </Sorotan>
        <Text style={[styles.teksMini, { marginTop: 6 }]}>Tarif bunga tahunan (% per tahun)</Text>
        <View style={styles.input}>
          <Text style={styles.teksKecil}>3</Text>
        </View>
        <Text style={[styles.teksMini, { marginTop: 6 }]}>Metode perhitungan</Text>
        <View style={styles.input}>
          <Text style={styles.teksKecil}>Saldo Harian</Text>
        </View>
        <Text style={[styles.teksMini, { marginTop: 6 }]}>Berlaku mulai</Text>
        <View style={styles.stepper}>
          <Ionicons name="chevron-back" size={9} color={colors.text} />
          <Text style={styles.teksKecilTebal}>November 2026</Text>
          <Ionicons name="chevron-forward" size={9} color={colors.text} />
        </View>
        <Tombol teks="Simpan Kebijakan" />
      </Kartu>
    </Bingkai>
  );
}

function BungaAkrual() {
  return (
    <Bingkai judul="Bunga Simpanan Sukarela">
      <Segmen kiri="Akrual Bulanan" kanan="Kebijakan" />
      <Kartu style={{ marginTop: 6 }}>
        <Text style={styles.teksMini}>Akrual otomatis · dibukukan</Text>
        <Text style={styles.heroNilaiGelap}>Oktober 2026</Text>
        <View style={styles.grid}>
          <Stat label="Bunga bruto" nilai="Rp3.131.000" />
          <Stat label="PPh" nilai="Rp310.000" />
          <Stat label="Masuk saldo" nilai="Rp2.821.000" />
          <Stat label="Koreksi" nilai="Rp0" />
        </View>
        <Text style={[styles.lencanaAktif, { alignSelf: 'flex-start', marginTop: 8 }]}>Otomatis · tanpa tombol</Text>
      </Kartu>
    </Bingkai>
  );
}

function BungaHasil() {
  return (
    <Bingkai judul="Bunga Simpanan Sukarela">
      <Text style={styles.judulBulan}>RIWAYAT AKRUAL</Text>
      <Kartu>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={styles.teksKecilTebal}>September 2026</Text>
          <Text style={styles.lencanaAktif}>Diakru</Text>
        </View>
        <Text style={styles.teksMini}>Bruto Rp3.120.400 · PPh Rp310.000 · Neto Rp2.810.400</Text>
        {['Andi Saputra', 'Budi Hartono'].map((n) => (
          <View key={n} style={styles.barisRiwayat}>
            <Text style={[styles.teksKecil, { flex: 1 }]}>{n}</Text>
            <Text style={styles.teksKecilTebal}>{n.startsWith('A') ? 'Rp30.000' : 'Rp2.790.000'}</Text>
          </View>
        ))}
        <Tombol teks="Export Rincian" sorot />
      </Kartu>
      <Kartu style={{ marginTop: 6 }}>
        <Text style={styles.teksKecilTebal}>Detail Anggota · Bunga</Text>
        <Text style={styles.teksMini}>Bunga hari ini Rp300,41 · Bulan berjalan Rp1.201,64</Text>
      </Kartu>
    </Bingkai>
  );
}

function BungaKoreksi() {
  return (
    <View style={styles.garisWaktu}>
      {[
        ['31 Jan', 'Januari diakru', 'checkmark-circle', colors.success],
        ['5 Feb', 'Setoran tgl 22 Jan dicatat terlambat', 'time-outline', colors.warning],
        ['28 Feb', 'Akrual Februari + Koreksi Januari Rp10.000', 'git-merge-outline', colors.primary],
      ].map(([tgl, ket, ikon, warna], i) => (
        <View key={String(tgl)} style={styles.titikWaktu}>
          <View style={[styles.titikIkon, { borderColor: String(warna) }]}>
            <Ionicons name={ikon as keyof typeof Ionicons.glyphMap} size={14} color={String(warna)} />
          </View>
          {i < 2 ? <View style={styles.garisPenghubung} /> : null}
          <View style={styles.kartuWaktu}>
            <Text style={styles.teksMiniTebal}>{tgl}</Text>
            <Text style={styles.teksKecil}>{ket}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function BungaJasaModal() {
  return (
    <View style={styles.jasaModal}>
      <Text style={styles.teksKecilTebal}>Dasar jasa modal SHU</Text>
      {[
        ['Simpanan Pokok', 1, true],
        ['Simpanan Wajib', 0.85, true],
        ['Simpanan Sukarela', 0.6, false],
      ].map(([n, w, ikut]) => (
        <View key={String(n)} style={{ marginTop: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={styles.teksKecil}>{n}</Text>
            <Text style={[styles.teksMiniTebal, { color: ikut ? colors.primary : colors.textMuted }]}>{ikut ? 'Selalu ikut' : 'Otomatis'}</Text>
          </View>
          <View style={styles.batangLatar}>
            <View style={[styles.batang, { width: `${Number(w) * 100}%`, backgroundColor: ikut ? colors.primary : colors.textFaint }]} />
          </View>
        </View>
      ))}
      <Sorotan style={{ borderRadius: 8, marginTop: 12 }}>
        <View style={{ padding: 4, backgroundColor: colors.surface, borderRadius: 6 }}>
          <Text style={styles.teksMiniTebal}>Bunga ON → sukarela tidak ikut basis jasa modal</Text>
          <Text style={[styles.teksMini, { marginTop: 3 }]}>Bunga OFF → mengikuti kebijakan SHU koperasi</Text>
        </View>
      </Sorotan>
      <Text style={[styles.teksMini, { marginTop: 6 }]}>Ditentukan sistem, dikunci per tahun buku saat SHU pertama kali dihitung.</Text>
    </View>
  );
}

const PETA: Record<JenisIlustrasi, () => React.ReactElement> = {
  SAMBUTAN: Sambutan,
  DASHBOARD: Dashboard,
  DATA_ANGGOTA: DataAnggota,
  TRANSAKSI_RIWAYAT: TransaksiRiwayat,
  PENYESUAIAN: Penyesuaian,
  LAPORAN: Laporan,
  PENGATURAN: Pengaturan,
  LANGKAH_AWAL: LangkahAwal,
  BUNGA_RUMUS: BungaRumus,
  BUNGA_KEBIJAKAN: BungaKebijakan,
  BUNGA_AKRUAL: BungaAkrual,
  BUNGA_HASIL: BungaHasil,
  BUNGA_KOREKSI: BungaKoreksi,
  BUNGA_JASA_MODAL: BungaJasaModal,
};

export const JENIS_ILUSTRASI_TERSEDIA = Object.keys(PETA) as JenisIlustrasi[];

export default function IlustrasiUi({ jenis }: { jenis: JenisIlustrasi }) {
  const Komponen = PETA[jenis];
  return <Komponen />;
}

export const UKURAN_ILUSTRASI = { lebar: LEBAR, tinggi: TINGGI };

const styles = StyleSheet.create({
  sorotan: { borderWidth: 2, borderColor: '#F2B705', borderRadius: 10 },
  bingkai: { width: LEBAR, height: TINGGI, borderRadius: 28, backgroundColor: '#1C1F1C', padding: 6 },
  layar: { flex: 1, borderRadius: 22, backgroundColor: colors.background, overflow: 'hidden' },
  statusBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 6, paddingBottom: 3, backgroundColor: colors.surface },
  statusJam: { fontSize: 8, fontWeight: '700', color: colors.text },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 7 },
  headerTeks: { flex: 1, fontSize: 10, fontWeight: '700', color: colors.white },
  isi: { flex: 1, padding: 8, gap: 5 },
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 4 },
  tabItem: { flex: 1, alignItems: 'center', gap: 1 },
  tabLabel: { fontSize: 5.5, color: colors.textFaint },
  kartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 7 },
  barisMenu: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 6 },
  ikonBulat: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  teksMini: { fontSize: 6.5, color: colors.textMuted },
  teksMiniTebal: { fontSize: 6.5, color: colors.text, fontWeight: '700' },
  teksMiniHijau: { fontSize: 7.5, color: colors.primary, fontWeight: '700' },
  teksKecil: { fontSize: 7.5, color: colors.text },
  teksKecilTebal: { fontSize: 7.5, color: colors.text, fontWeight: '700' },
  tombol: { backgroundColor: colors.primary, borderRadius: 6, paddingVertical: 6, alignItems: 'center' },
  tombolTeks: { fontSize: 7.5, color: colors.white, fontWeight: '700' },
  segmen: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 2 },
  segmenItem: { flex: 1, paddingVertical: 4, borderRadius: 6, alignItems: 'center' },
  segmenAktif: { backgroundColor: colors.primary },
  segmenTeks: { fontSize: 7, fontWeight: '700', color: colors.textMuted },
  saklar: { width: 22, height: 12, borderRadius: 6, padding: 1.5, justifyContent: 'center' },
  saklarBulat: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: colors.white },
  stat: { flexBasis: '47%', flexGrow: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 7, padding: 5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 },
  sambutan: { width: LEBAR + 40, alignItems: 'center', justifyContent: 'center', height: TINGGI },
  logo: { width: 84, height: 84, borderRadius: 26, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  namaApp: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: 2 },
  chipBaris: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 16 },
  chip: { backgroundColor: colors.primaryLight, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipTeks: { fontSize: 8, fontWeight: '700', color: colors.primary },
  chipFormat: { flex: 1, alignItems: 'center', backgroundColor: colors.primaryLight, borderRadius: 6, paddingVertical: 4 },
  lencanaSak: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 14, borderWidth: 1, borderColor: colors.primary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  sapa: { fontSize: 9, fontWeight: '700', color: colors.text },
  hero: { backgroundColor: colors.primary, borderRadius: 10, padding: 9 },
  heroLabel: { fontSize: 6.5, color: 'rgba(255,255,255,0.8)', fontWeight: '700', letterSpacing: 0.5 },
  heroNilai: { fontSize: 13, fontWeight: '800', color: colors.white, marginTop: 2 },
  heroMini: { fontSize: 6, color: 'rgba(255,255,255,0.85)' },
  heroNilaiGelap: { fontSize: 12, fontWeight: '800', color: colors.text, marginTop: 1 },
  cari: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 6 },
  barisAnggota: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: 8, padding: 6, borderWidth: 1, borderColor: colors.border },
  avatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  avatarTeks: { fontSize: 9, fontWeight: '800', color: colors.primary },
  fab: { position: 'absolute', right: 10, bottom: 10, borderRadius: 18 },
  fabIsi: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  judulBulan: { fontSize: 6.5, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.6, marginTop: 4 },
  barisRiwayat: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: 7, padding: 5, borderWidth: 1, borderColor: colors.border, marginTop: 3 },
  kotakTanggal: { width: 22, alignItems: 'center', backgroundColor: colors.background, borderRadius: 5, paddingVertical: 2 },
  kotakTanggalAngka: { fontSize: 9, fontWeight: '800', color: colors.text },
  coret: { textDecorationLine: 'line-through', color: colors.textMuted },
  lencanaBatal: { fontSize: 5.5, fontWeight: '700', color: colors.text, backgroundColor: colors.dangerBg, borderRadius: 3, paddingHorizontal: 3, marginTop: 1 },
  lencanaAktif: { fontSize: 6, fontWeight: '700', color: colors.text, backgroundColor: colors.primaryLight, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  kertas: { backgroundColor: colors.white, borderWidth: 1, borderColor: '#000', marginTop: 2 },
  kop: { padding: 5, borderBottomWidth: 1, borderBottomColor: '#000' },
  kopNama: { fontSize: 6.5, fontWeight: '800', color: '#000' },
  kopJudul: { fontSize: 7, fontWeight: '700', color: '#000' },
  barisTabel: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#000' },
  selLabel: { flex: 1.4, paddingHorizontal: 3, paddingVertical: 2.5, borderRightWidth: 0.5, borderRightColor: '#000' },
  selAngka: { flex: 1, textAlign: 'right', paddingHorizontal: 3, paddingVertical: 2.5, borderRightWidth: 0.5, borderRightColor: '#000' },
  lembarExport: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 6, gap: 4 },
  ceklis: { width: LEBAR + 40, height: TINGGI, justifyContent: 'center', gap: 14 },
  ceklisBaris: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ceklisBulat: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  ceklisSelesai: { backgroundColor: colors.primary },
  ceklisAngka: { fontSize: 13, fontWeight: '800', color: colors.primary },
  ceklisKartu: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  ceklisTeks: { flex: 1, fontSize: 11, fontWeight: '600', color: colors.text },
  rumusWadah: { width: LEBAR + 40, height: TINGGI, justifyContent: 'center' },
  kalender: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 8 },
  hari: { width: 31, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  hariAngka: { fontSize: 9, fontWeight: '700', color: colors.text },
  rumus: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, alignItems: 'center' },
  rumusTeks: { fontSize: 13, fontWeight: '800', color: colors.primary },
  barisSaklar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 4, backgroundColor: colors.surface, borderRadius: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 5, padding: 4, marginTop: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: 5, padding: 4, marginTop: 2 },
  garisWaktu: { width: LEBAR + 40, height: TINGGI, justifyContent: 'center' },
  titikWaktu: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 92 },
  titikIkon: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, zIndex: 1 },
  garisPenghubung: { position: 'absolute', left: 14, top: 30, width: 2, height: 62, backgroundColor: colors.border },
  kartuWaktu: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 3 },
  jasaModal: { width: LEBAR + 40, height: TINGGI, justifyContent: 'center' },
  batangLatar: { height: 12, borderRadius: 6, backgroundColor: colors.border, marginTop: 3, overflow: 'hidden' },
  batang: { height: 12, borderRadius: 6 },
});
