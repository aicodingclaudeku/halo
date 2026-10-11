import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import ExportButton from '@/components/ExportButton';
import PanduanSlide from '@/components/panduan/PanduanSlide';
import { PANDUAN_BUNGA_SUKARELA } from '@/config/panduanAplikasi';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, iconSize, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { BATAS_BUNGA_SIMPANAN_PPH_BEBAS, TARIF_PPH_BUNGA_SIMPANAN_PERSEN } from '@/config/pajakPolicy';
import { BATAS_TARIF_BUNGA_SIMPANAN_PERSEN, bulanBerikut, bulanSebelum } from '@/accounting/BungaSimpananSukarela';
import {
  batalkanAkrualBungaSukarela,
  berlakuMinimumVersiBaru,
  bulanTertunda,
  buildRincianAkrualExport,
  getHasilAkrualOtomatisTerakhir,
  kebijakanUntukBulan,
  labelBulan,
  listProsesAkrual,
  listRincianProsesAkrual,
  listVersiKebijakanBunga,
  pratinjauAkrualBungaSukarela,
  simpanVersiKebijakanBunga,
  validasiDrafKebijakanBunga,
  type PratinjauAkrual,
  type ProsesAkrual,
  type RincianProsesBaris,
  type VersiKebijakanBunga,
} from '@/services/BungaSukarelaService';
import {
  getPerlakuanShuSukarela,
  teksPerlakuanShu,
  teksSnapshotShu,
  type PerlakuanShuSukarela,
} from '@/services/KebijakanBasisJasaModalService';
import { jalankanTugasStartup, tungguTugasStartupSelesai } from '@/services/StartupTasks';

/**
 * BUNGA HARIAN SIMPANAN SUKARELA — Transaksi › Penyesuaian.
 *
 * Tab "Akrual": status akrual OTOMATIS (RC-S129 — tidak ada lagi tombol
 * akru manual), koreksi bulan lalu, riwayat dengan rincian per anggota
 * (export), batal bulan terakhir.
 *
 * RC-S129 — AKRUAL TANPA TOMBOL. Bulan yang sudah selesai dibukukan oleh
 * koordinator tugas latar yang SAMA dengan startup/foreground
 * (`jalankanTugasStartup` -> `jalankanAkrualBungaSukarelaOtomatis`).
 * Layar ini (1) menunggu batch latar yang sedang berjalan selesai lebih
 * dulu, sehingga tidak pernah menampilkan bulan yang sebenarnya sedang
 * diakru, lalu (2) bila masih ada bulan tertunda — mis. bulan baru saja
 * berganti sementara aplikasi tetap terbuka — memicu koordinator itu
 * sekali lagi. Tidak ada mesin kedua, tidak ada timer, dan pemanggilan
 * berulang idempoten (bulan yang sudah POSTED tidak diakru ulang).
 * Tab "Kebijakan": SATU kebijakan utama Bunga Simpanan Sukarela ON/OFF
 * (berversi, berlaku ke depan). Perlakuan sukarela dalam basis jasa modal
 * SHU TIDAK diatur di sini — ditampilkan read-only sebagai konsekuensi
 * (lihat KebijakanBasisJasaModalService, RC-S93).
 * Tab "Panduan": penjelasan cara kerja & langkah penggunaan, plus panduan
 * slide bergambar. Terbuka otomatis bila kebijakan belum pernah diatur.
 * Seluruh perhitungan,
 * jurnal, PPh, dan pengaman ada di service — layar ini tidak menghitung.
 */

type Tab = 'AKRUAL' | 'KEBIJAKAN' | 'PANDUAN';

/** RC-S127 — teks aturan PPh 4(2), angkanya dari pajakPolicy (bukan ditulis ulang). */
const TEKS_PPH =
  `PPh final dipotong otomatis dari TOTAL bunga simpanan anggota sebulan (Sukarela + Berjangka digabung): sampai ` +
  `Rp${BATAS_BUNGA_SIMPANAN_PPH_BEBAS.toLocaleString('id-ID')} tarif 0%, di atasnya ${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas seluruh bunga bulan itu ` +
  `(termasuk susulan atas bunga Berjangka bulan itu yang tadinya 0%). Yang masuk saldo anggota adalah bunga neto.`;

const persen = (n: number) => `${String(n).replace('.', ',')}%`;

/** Waktu perubahan kebijakan (created_at ISO) dalam waktu lokal perangkat. */
function waktuPerubahan(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dua = (n: number) => String(n).padStart(2, '0');
  return `${formatTanggalIndonesia(`${d.getFullYear()}-${dua(d.getMonth() + 1)}-${dua(d.getDate())}`)} ${dua(d.getHours())}:${dua(d.getMinutes())}`;
}

export default function BungaSimpananSukarelaScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const [tab, setTab] = useState<Tab>('AKRUAL');
  const [memuat, setMemuat] = useState(true);

  const [versi, setVersi] = useState<VersiKebijakanBunga[]>([]);
  const [perlakuanShu, setPerlakuanShu] = useState<PerlakuanShuSukarela | null>(null);
  const [riwayat, setRiwayat] = useState<ProsesAkrual[]>([]);
  const [berikutnya, setBerikutnya] = useState<string | null>(null);
  const [pratinjau, setPratinjau] = useState<PratinjauAkrual | null>(null);
  const [galatPratinjau, setGalatPratinjau] = useState<string | null>(null);
  /** Bulan yang sedang diproses otomatis oleh layar ini (null = tidak ada). */
  const [otomatisBerjalan, setOtomatisBerjalan] = useState<string | null>(null);
  const [terbuka, setTerbuka] = useState<string | null>(null);
  const [rincian, setRincian] = useState<RincianProsesBaris[]>([]);
  const [batal, setBatal] = useState<ProsesAkrual | null>(null);
  const [alasan, setAlasan] = useState('');

  // ---- draf kebijakan bunga
  const [minBulan, setMinBulan] = useState(bulanBerikut(getTanggalLokalHariIni().slice(0, 7)));
  const [aktif, setAktif] = useState(false);
  const [tarifTeks, setTarifTeks] = useState('');
  const [berlakuMulai, setBerlakuMulai] = useState(minBulan);
  const [menyimpan, setMenyimpan] = useState(false);
  const [slideTerbuka, setSlideTerbuka] = useState(false);
  const sudahPilihTabAwal = useRef(false);

  const bulanIni = getTanggalLokalHariIni().slice(0, 7);
  const tahunIni = Number(bulanIni.slice(0, 4));

  const muat = useCallback(async () => {
    setMemuat(true);
    try {
      // RC-S129 — jangan membaca di tengah batch latar (startup/foreground).
      await tungguTugasStartupSelesai();
      const baca = async () => {
        const [v, daftar, mb, ps] = await Promise.all([
          listVersiKebijakanBunga(),
          listProsesAkrual(),
          berlakuMinimumVersiBaru(),
          getPerlakuanShuSukarela(tahunIni),
        ]);
        const sudah = new Set(daftar.filter((d) => d.status === 'POSTED').map((d) => d.periode));
        return { v, daftar, mb, ps, tertunda: bulanTertunda(v, sudah, getTanggalLokalHariIni()) };
      };
      let hasil = await baca();
      // Masih ada bulan selesai yang belum dibukukan -> jalankan akrual
      // otomatis lewat koordinator yang sama (berurutan, idempoten), lalu
      // baca ulang. Hanya SEKALI per pemuatan: bila gagal (mis. periode
      // tertutup), pesannya ditampilkan dan dicoba lagi pada pembukaan berikutnya.
      if (hasil.tertunda.length > 0 && currentUser) {
        setOtomatisBerjalan(hasil.tertunda[0]);
        try {
          await jalankanTugasStartup(currentUser.id).catch(() => undefined);
        } finally {
          setOtomatisBerjalan(null);
        }
        hasil = await baca();
      }
      const { v, daftar, mb, ps, tertunda } = hasil;
      setVersi(v);
      setPerlakuanShu(ps);
      // Pertama kali dibuka & kebijakan belum pernah diatur -> mulai dari Panduan.
      if (!sudahPilihTabAwal.current) {
        sudahPilihTabAwal.current = true;
        if (v.length === 0) setTab('PANDUAN');
      }
      setRiwayat(daftar);
      setMinBulan(mb);
      // Draf mengikuti versi TERAKHIR (termasuk yang terjadwal), supaya
      // pengurus melihat keadaan yang akan berlaku, bukan hanya bulan ini.
      const terakhirVersi = v[v.length - 1] ?? null;
      const tarifLama = [...v].reverse().find((x) => x.aktif)?.tarifPersenTahun;
      setAktif(terakhirVersi?.aktif ?? false);
      // Tarif lama tetap ditampilkan (read-only) walau kebijakan OFF.
      setTarifTeks(tarifLama !== undefined ? String(tarifLama).replace('.', ',') : '');
      setBerlakuMulai(mb);
      setBerikutnya(tertunda[0] ?? null);
      setGalatPratinjau(null);
      if (tertunda[0]) {
        try {
          setPratinjau(await pratinjauAkrualBungaSukarela(tertunda[0]));
        } catch (e) {
          setPratinjau(null);
          setGalatPratinjau(e instanceof Error ? e.message : 'Pratinjau gagal.');
        }
      } else {
        setPratinjau(null);
      }
    } catch (e) {
      notify('Gagal memuat', e instanceof Error ? e.message : 'Data bunga simpanan gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, [bulanIni, tahunIni, currentUser]);

  useFocusEffect(
    useCallback(() => {
      void muat();
    }, [muat])
  );

  const draf = { aktif, tarifPersenTahun: aktif ? Number(tarifTeks.replace(',', '.')) || 0 : 0, berlakuMulai };
  const kebijakanKini = kebijakanUntukBulan(versi, bulanIni);
  const terjadwal = versi.filter((v) => v.berlakuMulai > bulanIni);
  const versiTerakhir = versi[versi.length - 1] ?? null;
  // Ada perubahan bila draf berbeda dari kebijakan yang akan berlaku pada bulan pilihan.
  const pembanding = kebijakanUntukBulan(versi, berlakuMulai);
  const adaPerubahan =
    (pembanding?.aktif ?? false) !== aktif || (aktif && (pembanding?.tarifPersenTahun ?? 0) !== draf.tarifPersenTahun);
  // OFF tanpa kebijakan aktif/terjadwal: tidak ada yang perlu dijadwalkan -> bulan read-only.
  const bulanBisaDiatur = aktif || !!versiTerakhir?.aktif;
  const galatDraf = validasiDrafKebijakanBunga(draf, minBulan) ?? (adaPerubahan ? null : 'Tidak ada perubahan untuk disimpan.');
  const galatTampil = galatDraf && adaPerubahan ? galatDraf : null;

  const simpanBunga = async () => {
    if (!currentUser || galatDraf) return;
    setMenyimpan(true);
    try {
      await simpanVersiKebijakanBunga(currentUser.id, draf);
      notify(
        'Kebijakan bunga disimpan',
        `${aktif ? 'Bunga aktif' : 'Bunga nonaktif'} mulai ${labelBulan(berlakuMulai)}. Bulan sebelumnya dan riwayat tidak berubah.`
      );
      await muat();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Kebijakan gagal disimpan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const bukaRincian = async (p: ProsesAkrual) => {
    if (terbuka === p.id) {
      setTerbuka(null);
      return;
    }
    try {
      setRincian(await listRincianProsesAkrual(p.id));
      setTerbuka(p.id);
    } catch (e) {
      notify('Gagal memuat rincian', e instanceof Error ? e.message : '');
    }
  };

  const konfirmasiBatal = async () => {
    if (!currentUser || !batal) return;
    try {
      await batalkanAkrualBungaSukarela(currentUser.id, batal.periode, alasan);
      notify('Akrual dibatalkan', `Bunga ${labelBulan(batal.periode)} dibalik. Bulan itu dihitung ulang otomatis dengan data terbaru.`);
      setBatal(null);
      setAlasan('');
      await muat();
    } catch (e) {
      notify('Gagal membatalkan', e instanceof Error ? e.message : 'Pembatalan gagal.');
    }
  };

  const otomatis = getHasilAkrualOtomatisTerakhir();
  const terakhirPosted = riwayat.find((r) => r.status === 'POSTED') ?? null;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        <View style={styles.statusCard}>
          <View style={styles.statusBaris}>
            <View style={[styles.titik, { backgroundColor: kebijakanKini?.aktif ? colors.success : colors.textFaint }]} />
            <Text style={styles.statusJudul}>
              {kebijakanKini?.aktif ? `Bunga harian aktif · ${persen(kebijakanKini.tarifPersenTahun)} per tahun` : 'Bunga simpanan sukarela nonaktif'}
            </Text>
          </View>
          <Text style={styles.statusSub}>Metode Saldo Harian: saldo akhir hari × tarif tahunan ÷ 365, seluruh hari kalender.</Text>
          <Text style={styles.statusSub}>
            {perlakuanShu?.sumber === 'SNAPSHOT'
              ? `SHU ${tahunIni} sudah dikunci: sukarela ${perlakuanShu.sukarelaIkut ? 'diperhitungkan' : 'tidak diperhitungkan'} sebagai basis jasa modal.`
              : teksPerlakuanShu(!!kebijakanKini?.aktif)}
          </Text>
        </View>

        <View style={styles.tabBar}>
          {(
            [
              ['AKRUAL', 'Akrual'],
              ['KEBIJAKAN', 'Kebijakan'],
              ['PANDUAN', 'Panduan'],
            ] as const
          ).map(([k, label]) => (
            <TouchableOpacity
              key={k}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === k }}
              style={[styles.tabItem, tab === k && styles.tabItemAktif]}
              onPress={() => setTab(k)}
            >
              <Text style={[styles.tabText, tab === k && styles.tabTextAktif]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'PANDUAN' ? (
          <PanduanTertulis onBukaSlide={() => setSlideTerbuka(true)} keKebijakan={() => setTab('KEBIJAKAN')} />
        ) : memuat ? (
          otomatisBerjalan ? (
            <View style={[styles.card, styles.prosesKartu]}>
              <ActivityIndicator color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.cardJudul}>Memproses bunga {labelBulan(otomatisBerjalan)}…</Text>
                <Text style={styles.hint}>Bunga bulan yang sudah selesai sedang dibukukan otomatis. Tidak perlu menekan apa pun.</Text>
              </View>
            </View>
          ) : (
            <ActivityIndicator color={colors.textMuted} style={{ marginTop: spacing.xl }} />
          )
        ) : tab === 'KEBIJAKAN' ? (
          <>
            {/* 1. HEADER + FORM KEBIJAKAN (satu-satunya pengaturan) */}
            <View style={styles.card}>
              <Text style={styles.cardJudul}>Kebijakan Bunga Simpanan Sukarela</Text>
              <Text style={styles.hint}>
                Satu kebijakan utama. Perubahan berlaku mulai bulan yang dipilih dan tidak mengubah bulan yang sudah lewat atau sudah
                diakru.
              </Text>

              <View style={[styles.saklar, styles.jarak]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.saklarJudul}>Bunga Simpanan Sukarela</Text>
                  <Text style={styles.hint}>{aktif ? 'ON — anggota memperoleh bunga harian' : 'OFF — tidak ada bunga dan tidak ada akrual'}</Text>
                </View>
                <Switch
                  accessibilityLabel="Bunga Simpanan Sukarela"
                  value={aktif}
                  onValueChange={setAktif}
                  trackColor={{ true: colors.primary }}
                />
              </View>

              <Text style={[styles.label, styles.jarak]}>Tarif bunga tahunan (% per tahun)</Text>
              <FocusTextInput
                style={[styles.input, !aktif && styles.inputMati]}
                value={tarifTeks}
                onChangeText={setTarifTeks}
                editable={aktif}
                keyboardType="decimal-pad"
                placeholder="Mis. 3"
                placeholderTextColor={colors.placeholder}
              />
              <Text style={styles.hint}>
                {aktif
                  ? `Paling tinggi ${BATAS_TARIF_BUNGA_SIMPANAN_PERSEN}% per tahun (Juklat SOM 2025).`
                  : 'Tidak dipakai selama bunga OFF. Tarif lama tetap tersimpan di histori.'}
              </Text>

              <Text style={[styles.label, styles.jarak]}>Metode perhitungan</Text>
              <View style={styles.bacaSaja}>
                <Text style={styles.bacaSajaTeks}>Saldo Harian</Text>
                <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
              </View>
              <Text style={styles.hint}>Saldo akhir hari × tarif tahunan ÷ 365, seluruh hari kalender termasuk hari terakhir bulan.</Text>

              <Text style={[styles.label, styles.jarak]}>Berlaku mulai</Text>
              {bulanBisaDiatur ? (
                <PemilihStepper
                  label={labelBulan(berlakuMulai)}
                  bisaMundur={berlakuMulai > minBulan}
                  onMundur={() => setBerlakuMulai(bulanSebelum(berlakuMulai))}
                  onMaju={() => setBerlakuMulai(bulanBerikut(berlakuMulai))}
                />
              ) : (
                <View style={styles.bacaSaja}>
                  <Text style={[styles.bacaSajaTeks, { color: colors.textMuted }]}>Tidak ada perubahan untuk dijadwalkan</Text>
                </View>
              )}
              <Text style={styles.hint}>Paling awal {labelBulan(minBulan)}. Bunga diakru setelah setiap bulan selesai.</Text>

              <View style={[styles.konsekuensi, styles.jarak]}>
                <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.konsekuensiTeks}>{teksPerlakuanShu(aktif)}</Text>
                  {perlakuanShu && teksSnapshotShu(perlakuanShu) ? <Text style={styles.hint}>{teksSnapshotShu(perlakuanShu)}</Text> : null}
                </View>
              </View>

              {galatTampil ? <Text style={styles.errorText}>{galatTampil}</Text> : null}
              <TouchableOpacity
                style={[styles.tombol, (menyimpan || !!galatDraf) && styles.disabled]}
                onPress={() => void simpanBunga()}
                disabled={menyimpan || !!galatDraf}
              >
                <Text style={styles.tombolText}>Simpan Kebijakan</Text>
              </TouchableOpacity>
            </View>

            {/* 2. STATUS PERIODE AKRUAL */}
            <View style={styles.card}>
              <Text style={styles.cardJudul}>Status periode akrual</Text>
              <BarisInfo label="Akrual terakhir" nilai={terakhirPosted ? labelBulan(terakhirPosted.periode) : 'Belum ada'} />
              <BarisInfo label="Menunggu akrual" nilai={berikutnya ? labelBulan(berikutnya) : 'Tidak ada'} />
              <BarisInfo
                label="Bulan berjalan"
                nilai={`${labelBulan(bulanIni)} · ${kebijakanKini?.aktif ? 'diakru setelah bulan selesai' : 'tidak berbunga'}`}
              />
              <Text style={styles.hint}>
                Akrual berjalan otomatis saat aplikasi dibuka, hanya untuk bulan yang sudah selesai. Bulan berjalan tidak pernah diakru.
              </Text>
            </View>

            {/* 3. RINGKASAN KEBIJAKAN AKTIF */}
            <View style={styles.card}>
              <Text style={styles.cardJudul}>Ringkasan kebijakan aktif</Text>
              <BarisInfo label="Status" nilai={kebijakanKini?.aktif ? 'ON' : 'OFF'} />
              <BarisInfo label="Tarif" nilai={kebijakanKini?.aktif ? `${persen(kebijakanKini.tarifPersenTahun)} per tahun` : '—'} />
              <BarisInfo label="Metode" nilai="Saldo Harian" />
              <BarisInfo label="Berlaku sejak" nilai={kebijakanKini ? labelBulan(kebijakanKini.berlakuMulai) : 'Belum pernah diatur'} />
              {terjadwal.length > 0 ? (
                <BarisInfo
                  label="Terjadwal"
                  nilai={terjadwal
                    .map((t) => `${labelBulan(t.berlakuMulai)}: ${t.aktif ? `ON ${persen(t.tarifPersenTahun)}` : 'OFF'}`)
                    .join(' · ')}
                />
              ) : null}
              <Text style={[styles.hint, styles.jarakKecil]}>
                {perlakuanShu?.sumber === 'SNAPSHOT' ? teksSnapshotShu(perlakuanShu) : teksPerlakuanShu(!!kebijakanKini?.aktif)}
              </Text>
            </View>

            {/* 4. HISTORI KEBIJAKAN */}
            <View style={styles.card}>
              <Text style={styles.cardJudul}>Histori kebijakan</Text>
              {versi.length === 0 ? (
                <Text style={styles.hint}>Belum pernah diatur. Tanpa kebijakan, bunga simpanan sukarela OFF.</Text>
              ) : (
                [...versi].reverse().map((v) => (
                  <View key={v.id} style={styles.histori}>
                    <View style={styles.riwayatAtas}>
                      <Text style={styles.barisNama}>Mulai {labelBulan(v.berlakuMulai)}</Text>
                      <View style={[styles.lencana, v.aktif ? styles.lencanaAktif : styles.lencanaMati]}>
                        <Text style={styles.lencanaText}>
                          {v.aktif ? 'ON' : 'OFF'}
                          {terjadwal.some((t) => t.id === v.id) ? ' · terjadwal' : ''}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.hint}>Tarif {v.aktif ? `${persen(v.tarifPersenTahun)} per tahun` : '—'} · Saldo Harian</Text>
                    <Text style={styles.hint}>Diubah {waktuPerubahan(v.createdAt)}</Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.infoBox}>
              <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
              <Text style={styles.infoText}>
                {TEKS_PPH} Bukti potong per anggota ada di Pajak › Bukti Potong Bunga Simpanan.
              </Text>
            </View>
          </>
        ) : (
          <>
            {/* RC-S129 — STATUS AKRUAL OTOMATIS (tanpa tombol akru manual). */}
            <View style={styles.card}>
              <View style={styles.otomatisKepala}>
                <View style={styles.otomatisIkon}>
                  <Ionicons name="sync-outline" size={18} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardJudul}>Akrual bunga otomatis</Text>
                  <Text style={styles.hint}>Dibukukan sendiri oleh sistem setiap bulan selesai.</Text>
                </View>
                <View style={[styles.lencana, versi.some((v) => v.aktif) ? styles.lencanaAktif : styles.lencanaMati]}>
                  <Text style={styles.lencanaText}>{versi.some((v) => v.aktif) ? 'Otomatis' : 'Nonaktif'}</Text>
                </View>
              </View>

              {!versi.some((v) => v.aktif) ? (
                <Text style={[styles.hint, styles.jarak]}>Bunga simpanan sukarela belum diaktifkan. Atur di tab Kebijakan.</Text>
              ) : !berikutnya ? (
                <>
                  <View style={[styles.statusBaik, styles.jarak]}>
                    <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                    <Text style={styles.statusBaikTeks}>Semua bulan yang sudah selesai sudah dibukukan.</Text>
                  </View>
                  <BarisInfo label="Terakhir dibukukan" nilai={terakhirPosted ? labelBulan(terakhirPosted.periode) : 'Belum ada'} />
                  <BarisInfo label="Bulan berjalan" nilai={kebijakanKini?.aktif ? labelBulan(bulanIni) : `${labelBulan(bulanIni)} · tidak berbunga`} />
                  {kebijakanKini?.aktif ? <BarisInfo label="Dibukukan otomatis" nilai={`mulai 1 ${labelBulan(bulanBerikut(bulanIni))}`} /> : null}
                </>
              ) : (
                <>
                  <View style={[styles.warnBox, styles.jarak]}>
                    <Ionicons name="warning-outline" size={16} color={colors.warning} />
                    <Text style={styles.warnText}>
                      Bunga {labelBulan(berikutnya)} belum dapat dibukukan otomatis
                      {otomatis?.pesan ? `: ${otomatis.pesan}` : '.'} Sistem akan mencoba lagi saat aplikasi atau layar ini dibuka
                      kembali — perbaiki penyebabnya (mis. buka kembali periode akuntansi yang tertutup atau login sebagai pengguna
                      dengan izin Simpanan).
                    </Text>
                  </View>
                  {galatPratinjau ? (
                    <Text style={styles.errorText}>{galatPratinjau}</Text>
                  ) : pratinjau ? (
                    <>
                      <Text style={styles.teksMenunggu}>Menunggu dibukukan · {labelBulan(berikutnya)}</Text>
                      <Text style={styles.hint}>Tarif {persen(pratinjau.tarifPersen)} per tahun · saldo harian</Text>
                      <View style={styles.ringkas}>
                        <Ringkas label="Bunga bruto" nilai={formatRupiah(pratinjau.totalBruto)} />
                        <Ringkas label="PPh" nilai={formatRupiah(pratinjau.totalPajak)} />
                        <Ringkas label="Masuk saldo (neto)" nilai={formatRupiah(pratinjau.totalNetto)} tebal />
                        <Ringkas label="Koreksi bulan lalu" nilai={formatRupiah(pratinjau.totalKoreksiBruto)} />
                      </View>
                      {pratinjau.baris.slice(0, 5).map((b) => (
                        <View key={`${b.anggotaId}-${b.jenis}-${b.periodeBunga}`} style={styles.barisAnggota}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.barisNama} numberOfLines={1}>
                              {b.namaAnggota}
                            </Text>
                            <Text style={styles.hint}>
                              {b.jenis === 'KOREKSI' ? `Koreksi ${labelBulan(b.periodeBunga)}` : `${b.jumlahHari} hari`} · {b.nomorAnggota}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={styles.barisNominal}>{formatRupiah(b.netto)}</Text>
                            <Text style={styles.hint}>
                              bruto {formatRupiah(b.bruto)} · PPh {formatRupiah(b.pajak)}
                            </Text>
                          </View>
                        </View>
                      ))}
                      {pratinjau.baris.length > 5 ? <Text style={styles.hint}>… dan {pratinjau.baris.length - 5} baris lainnya.</Text> : null}
                    </>
                  ) : null}
                </>
              )}

              <View style={[styles.konsekuensi, styles.jarak]}>
                <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.konsekuensiTeks}>Tidak ada tombol yang perlu ditekan.</Text>
                  <Text style={styles.hint}>
                    Setelah sebuah bulan berakhir, bunganya dihitung dan dibukukan otomatis saat aplikasi dibuka, kembali aktif, atau saat
                    layar ini dibuka. {TEKS_PPH}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.seksiBaris}>
              <Text style={[styles.seksiJudul, { flex: 1 }]}>Riwayat akrual</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => navigation.navigate('BuktiPotongPph')} style={styles.tautanBukti}>
                <Ionicons name="receipt-outline" size={14} color={colors.primary} />
                <Text style={styles.tautanBuktiTeks}>Bukti potong PPh</Text>
              </TouchableOpacity>
            </View>
            {riwayat.length === 0 ? (
              <Text style={styles.hint}>Belum ada akrual bunga.</Text>
            ) : (
              riwayat.map((r) => (
                <View key={r.id} style={styles.riwayatCard}>
                  <View style={styles.riwayatAtas}>
                    <Text style={[styles.riwayatBulan, r.status === 'DIBATALKAN' && styles.coret]}>{labelBulan(r.periode)}</Text>
                    <View style={[styles.lencana, r.status === 'POSTED' ? styles.lencanaAktif : styles.lencanaBatal]}>
                      <Text style={styles.lencanaText}>{r.status === 'POSTED' ? 'Diakru' : 'Dibatalkan'}</Text>
                    </View>
                  </View>
                  <Text style={styles.hint}>
                    {r.jumlahAnggota} anggota · {persen(r.tarifPersen)} · diproses {r.createdAt.slice(0, 10)}
                  </Text>
                  <Text style={styles.riwayatNominal}>
                    Bruto {formatRupiah(r.totalBruto)} · PPh {formatRupiah(r.totalPajak)} · Neto {formatRupiah(r.totalNetto)}
                  </Text>
                  {r.totalKoreksiBruto !== 0 ? <Text style={styles.hint}>Termasuk koreksi bulan lalu {formatRupiah(r.totalKoreksiBruto)}</Text> : null}
                  {r.alasanBatal ? <Text style={styles.hint}>Alasan batal: {r.alasanBatal}</Text> : null}
                  <View style={styles.aksiBaris}>
                    <TouchableOpacity accessibilityRole="button" onPress={() => void bukaRincian(r)}>
                      <Text style={styles.link}>{terbuka === r.id ? 'Tutup rincian' : 'Lihat rincian'}</Text>
                    </TouchableOpacity>
                    {terakhirPosted?.id === r.id ? (
                      <TouchableOpacity accessibilityRole="button" onPress={() => setBatal(r)}>
                        <Text style={styles.linkBahaya}>Batalkan akrual</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  {terbuka === r.id ? (
                    <View style={styles.rincian}>
                      {rincian.map((x, i) => (
                        <View key={i} style={styles.barisAnggota}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.barisNama} numberOfLines={1}>
                              {x.namaAnggota}
                            </Text>
                            <Text style={styles.hint}>
                              {x.jenis === 'KOREKSI' ? `Koreksi ${labelBulan(x.periodeBunga)}` : `${x.jumlahHari} hari`} · rata-rata saldo{' '}
                              {formatRupiah(x.jumlahHari > 0 ? Math.round(x.saldoHari / x.jumlahHari) : 0)}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={styles.barisNominal}>{formatRupiah(x.netto)}</Text>
                            <Text style={styles.hint}>
                              bruto {formatRupiah(x.bruto)} · PPh {formatRupiah(x.pajak)}
                            </Text>
                          </View>
                        </View>
                      ))}
                      {koperasi ? (
                        <View style={styles.jarak}>
                          <ExportButton
                            data={buildRincianAkrualExport({ namaKoperasi: koperasi.nama }, r, rincian)}
                            label="Export Rincian"
                          />
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>

      <PanduanSlide visible={slideTerbuka} slides={PANDUAN_BUNGA_SUKARELA} judulAkhir="Selesai" onTutup={() => setSlideTerbuka(false)} />

      <Modal visible={batal !== null} transparent animationType="fade" onRequestClose={() => setBatal(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalLatar}>
          <ScrollView contentContainerStyle={styles.modalGulir} keyboardShouldPersistTaps="handled">
            <View style={styles.modalKartu}>
              <Text style={styles.cardJudul}>Batalkan akrual {batal ? labelBulan(batal.periode) : ''}?</Text>
              <Text style={styles.hint}>
                Jurnal dibalik dan saldo sukarela anggota dikoreksi. Data tidak dihapus. Setelah dibatalkan, bulan ini dihitung ulang
                otomatis dengan data terbaru — gunakan bila ada data bulan itu yang perlu diperbaiki.
              </Text>
              <FocusTextInput
                style={[styles.input, styles.jarak]}
                value={alasan}
                onChangeText={setAlasan}
                placeholder="Alasan pembatalan (wajib)"
                placeholderTextColor={colors.placeholder}
              />
              <View style={styles.modalAksi}>
                <TouchableOpacity style={styles.tombolSekunder} onPress={() => setBatal(null)}>
                  <Text style={styles.tombolSekunderText}>Tutup</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tombolBahaya, !alasan.trim() && styles.disabled]}
                  disabled={!alasan.trim()}
                  onPress={() => void konfirmasiBatal()}
                >
                  <Text style={styles.tombolText}>Batalkan</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </AreaAmanKeyboard>
  );
}

/**
 * PANDUAN TERTULIS — penjelasan ringkas & profesional. Isi angka contoh
 * sama dengan perilaku mesin (saldo akhir hari × tarif ÷ 365, seluruh hari).
 */
function PanduanTertulis({ onBukaSlide, keKebijakan }: { onBukaSlide: () => void; keKebijakan: () => void }) {
  return (
    <>
      <TouchableOpacity accessibilityRole="button" style={styles.bannerSlide} onPress={onBukaSlide}>
        <View style={styles.bannerIkon}>
          <Ionicons name="play-circle" size={26} color={colors.white} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerJudul}>Panduan bergambar</Text>
          <Text style={styles.bannerSub}>6 slide singkat: cara kerja, langkah penggunaan, koreksi, dan perlakuan SHU.</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.white} />
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.cardJudul}>Apa itu bunga harian simpanan sukarela?</Text>
        <Text style={styles.paragraf}>
          Kebijakan koperasi untuk memberikan imbalan atas tabungan anggota. Bunga dihitung dari saldo yang benar-benar mengendap setiap hari,
          lalu dibukukan sekali di akhir bulan dan langsung menambah saldo simpanan sukarela anggota. Fitur ini opsional dan dapat dinyalakan
          atau dimatikan sesuai keputusan koperasi.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardJudul}>Cara perhitungan</Text>
        <View style={styles.kotakRumus}>
          <Text style={styles.rumusTeks}>Bunga per hari = saldo akhir hari × tarif tahunan ÷ 365</Text>
        </View>
        <Text style={styles.paragraf}>
          Seluruh hari kalender dihitung, termasuk hari terakhir bulan. Setoran dan penarikan berlaku mulai tanggal transaksinya. Saldo nol
          atau negatif tidak berbunga.
        </Text>
        <Text style={styles.subJudul}>Contoh</Text>
        <Text style={styles.paragraf}>
          Saldo Rp3.650.000 sepanjang Januari, tarif 10% per tahun:{'\n'}Rp3.650.000 × 10% ÷ 365 = Rp1.000 per hari × 31 hari = Rp31.000.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardJudul}>Langkah penggunaan</Text>
        {[
          ['Atur kebijakan', 'Tab Kebijakan → nyalakan "Bunga Simpanan Sukarela", isi tarif tahunan (maks. 9%/tahun), pilih bulan mulai berlaku, lalu "Simpan Kebijakan".'],
          ['Akrual otomatis setelah bulan selesai', 'Tidak ada tombol yang perlu ditekan. Bulan yang sudah selesai dibukukan otomatis saat aplikasi dibuka, kembali aktif, atau saat menu ini dibuka; bulan berjalan tidak pernah diakru. Statusnya terlihat di tab Akrual.'],
          ['Periksa hasil', 'Riwayat akrual menampilkan bruto, PPh, dan neto. "Lihat rincian" untuk per anggota, lalu Export ke PDF/Excel.'],
          ['Pantau per anggota', 'Detail Anggota menampilkan bunga hari ini, perkiraan bulan berjalan, dan total bunga yang sudah masuk saldo.'],
        ].map(([judul, isi], i) => (
          <View key={judul} style={styles.langkah}>
            <View style={styles.langkahNomor}>
              <Text style={styles.langkahNomorTeks}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.langkahJudul}>{judul}</Text>
              <Text style={styles.hint}>{isi}</Text>
            </View>
          </View>
        ))}
        <TouchableOpacity accessibilityRole="button" style={styles.tombol} onPress={keKebijakan}>
          <Text style={styles.tombolText}>Buka Pengaturan Kebijakan</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardJudul}>Pertanyaan umum</Text>
        {[
          ['Ada setoran bulan lalu yang baru dicatat?', 'Tidak perlu membatalkan apa pun. Bunga bulan itu dihitung ulang dan selisihnya dibukukan sebagai "Koreksi" di akrual berikutnya — tanpa bunga ganda.'],
          ['Bagaimana membatalkan akrual?', 'Di tab Akrual, "Batalkan akrual" tersedia pada bulan terakhir. Jurnal dibalik, saldo anggota dikoreksi, lalu bulan itu dihitung ulang otomatis dengan data terbaru.'],
          ['Tarif ingin diubah?', 'Simpan kebijakan baru; berlaku mulai bulan yang dipilih (paling awal bulan berikutnya). Bulan yang sudah lewat tetap memakai tarif lamanya.'],
          ['Bunga ingin dimatikan?', 'Matikan "Bunga Simpanan Sukarela", pilih bulan mulai berlaku, lalu simpan. Bunga bulan-bulan sebelumnya dan histori kebijakan tetap tersimpan.'],
          ['Bagaimana dengan pajak?', `${TEKS_PPH} Bukti potong per anggota (bisa dicetak) ada di Pajak › Bukti Potong Bunga Simpanan.`],
          ['Anggota keluar?', 'Anggota yang hak keluarnya sudah dibayar sebelum akhir bulan tidak menerima bunga bulan itu karena rekeningnya sudah ditutup.'],
          ['Apakah sukarela ikut jasa modal SHU?', 'Tidak diatur terpisah. Selama bunga ON, simpanan sukarela tidak diperhitungkan sebagai basis jasa modal (agar tidak mendapat imbal ganda). Bila bunga OFF sepanjang tahun buku, perlakuannya mengikuti kebijakan pembagian SHU koperasi sesuai AD/ART. Hasilnya dikunci per tahun buku saat SHU pertama kali dihitung.'],
        ].map(([t, j]) => (
          <View key={t} style={styles.tanya}>
            <Text style={styles.tanyaJudul}>{t}</Text>
            <Text style={styles.hint}>{j}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

function PemilihStepper({ label, bisaMundur, onMundur, onMaju }: { label: string; bisaMundur: boolean; onMundur: () => void; onMaju: () => void }) {
  return (
    <View style={styles.stepper}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Sebelumnya" disabled={!bisaMundur} onPress={onMundur} style={[styles.stepperTombol, !bisaMundur && styles.disabled]}>
        <Ionicons name="chevron-back" size={iconSize.md} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.stepperLabel}>{label}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Berikutnya" onPress={onMaju} style={styles.stepperTombol}>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

function BarisInfo({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.barisInfo}>
      <Text style={styles.barisInfoLabel}>{label}</Text>
      <Text style={styles.barisInfoNilai}>{nilai}</Text>
    </View>
  );
}

function Ringkas({ label, nilai, tebal }: { label: string; nilai: string; tebal?: boolean }) {
  return (
    <View style={styles.ringkasItem}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={[styles.ringkasNilai, tebal && { fontWeight: '800' }]}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  statusCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, gap: 3 },
  statusBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titik: { width: 8, height: 8, borderRadius: 4 },
  statusJudul: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  statusSub: { fontSize: 12, color: colors.textMuted },
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 4, marginBottom: spacing.md },
  tabItem: { flex: 1, paddingVertical: spacing.sm + 2, borderRadius: radius.sm, alignItems: 'center' },
  tabItemAktif: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextAktif: { color: colors.white },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  cardJudul: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.xs },
  subJudul: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 2 },
  saklar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  saklarJudul: { fontSize: 14, fontWeight: '600', color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: spacing.xs + 2 },
  jarak: { marginTop: spacing.md },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  input: { ...formUi.inputStandalone },
  inputMati: { backgroundColor: colors.background, color: colors.textMuted },
  bacaSaja: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.background, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  bacaSajaTeks: { fontSize: 14, fontWeight: '700', color: colors.text },
  konsekuensi: { flexDirection: 'row', gap: spacing.xs + 2, backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.sm + 2 },
  konsekuensiTeks: { fontSize: 12, fontWeight: '600', color: colors.text, lineHeight: 17 },
  jarakKecil: { marginTop: spacing.sm },
  barisInfo: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  barisInfoLabel: { fontSize: 12, color: colors.textMuted },
  barisInfoNilai: { flexShrink: 1, fontSize: 12, fontWeight: '700', color: colors.text, textAlign: 'right' },
  histori: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  bannerSlide: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.primary, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  bannerIkon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  bannerJudul: { fontSize: 15, fontWeight: '800', color: colors.white },
  bannerSub: { fontSize: 12, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  paragraf: { fontSize: 13, color: colors.text, lineHeight: 20, marginTop: spacing.xs },
  kotakRumus: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginVertical: spacing.sm },
  rumusTeks: { fontSize: 14, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  langkah: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  langkahNomor: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  langkahNomorTeks: { fontSize: 13, fontWeight: '800', color: colors.white },
  langkahJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  tanya: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  tanyaJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  stepperTombol: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  stepperLabel: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '700', color: colors.text },
  infoBox: { flexDirection: 'row', gap: spacing.xs + 2, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm + 2 },
  infoText: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.md },
  tombol: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginTop: spacing.md },
  tombolText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.4 },
  prosesKartu: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  otomatisKepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  otomatisIkon: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  statusBaik: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.xs },
  statusBaikTeks: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.primaryDark },
  teksMenunggu: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.xs },
  warnBox: { flexDirection: 'row', gap: spacing.xs + 2, backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  warnText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  ringkas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.md },
  ringkasItem: { flexGrow: 1, flexBasis: '45%', backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.sm },
  ringkasNilai: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 2 },
  barisAnggota: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  barisNama: { fontSize: 13, fontWeight: '600', color: colors.text },
  barisNominal: { fontSize: 13, fontWeight: '700', color: colors.text },
  seksiJudul: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4, marginBottom: spacing.sm, marginTop: spacing.sm, textTransform: 'uppercase' },
  riwayatCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  riwayatAtas: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  riwayatBulan: { fontSize: 14, fontWeight: '700', color: colors.text },
  riwayatNominal: { fontSize: 12, color: colors.text, marginTop: 4 },
  coret: { textDecorationLine: 'line-through', color: colors.textMuted },
  lencana: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
  lencanaAktif: { backgroundColor: colors.primaryLight },
  lencanaBatal: { backgroundColor: colors.dangerBg },
  lencanaMati: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  lencanaText: { fontSize: 10, fontWeight: '700', color: colors.text },
  aksiBaris: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  link: { fontSize: 12, fontWeight: '600', color: colors.text, paddingVertical: 4 },
  seksiBaris: { flexDirection: 'row', alignItems: 'center' },
  tautanBukti: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingLeft: spacing.sm },
  tautanBuktiTeks: { fontSize: 12, fontWeight: '700', color: colors.primary },
  linkBahaya: { fontSize: 12, fontWeight: '600', color: colors.danger, paddingVertical: 4 },
  rincian: { marginTop: spacing.sm },
  modalLatar: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalGulir: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  modalKartu: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg },
  modalAksi: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tombolSekunder: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  tombolSekunderText: { fontWeight: '600', color: colors.text },
  tombolBahaya: { flex: 1, backgroundColor: colors.danger, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
});
