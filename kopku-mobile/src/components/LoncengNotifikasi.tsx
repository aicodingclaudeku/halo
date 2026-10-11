import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { colors, radius, spacing } from '@/theme/colors';
import { usePengumumanStore } from '@/store/usePengumumanStore';
import { bandingkanVersi, versiAplikasi, type LevelPengumuman } from '@/services/PengumumanService';
import { getLicenseStatus, type LicenseStatus } from '@/services/LicenseService';
import { getDevicePlatform } from '@/security/devicePlatform';

/**
 * RC-S125 — LONCENG NOTIFIKASI DASHBOARD
 * =========================================================================
 *
 * Dipasang di header Dashboard, di KIRI logo koperasi. Murni tampilan:
 *   - Tab "Pengumuman": pengumuman dari website KOPKU (target aplikasi).
 *   - Tab "Notifikasi": pengingat lokal yang dihitung dari status lisensi
 *     (sisa masa trial, batas verifikasi online, jam perangkat) dan
 *     ketersediaan versi aplikasi yang lebih baru.
 *
 * Komponen ini TIDAK memutuskan akses lisensi — ia hanya MEMBACA
 * `getLicenseStatus()` untuk ditampilkan. Penegakan tetap milik LicenseGate.
 */

type Tab = 'pengumuman' | 'notifikasi';

interface NotifLokal {
  kunci: string;
  judul: string;
  isi: string;
  ikon: keyof typeof Ionicons.glyphMap;
  warna: string;
  tautan?: string | null;
  labelTautan?: string;
  /** RC-S126 — aksi di dalam aplikasi (mis. membuka layar Lisensi). */
  bukaLisensi?: boolean;
}

/**
 * RC-S126 — item yang sedang dibuka di tampilan detail. Satu bentuk untuk
 * pengumuman dan notifikasi lokal supaya layar detailnya hanya satu.
 */
interface DetailItem {
  kunci: string;
  judul: string;
  isi: string;
  ikon: keyof typeof Ionicons.glyphMap;
  warna: string;
  label: string;
  waktu: string;
  disematkan: boolean;
  tautan: string | null;
  labelTautan: string | null;
  bukaLisensi: boolean;
}

const GAYA_LEVEL: Record<LevelPengumuman, { ikon: keyof typeof Ionicons.glyphMap; warna: string; label: string }> = {
  info: { ikon: 'information-circle', warna: colors.primary, label: 'Info' },
  update: { ikon: 'cloud-download', warna: colors.accent, label: 'Pembaruan' },
  penting: { ikon: 'alert-circle', warna: colors.danger, label: 'Penting' },
  promo: { ikon: 'pricetag', warna: colors.warning, label: 'Promo' },
};

const JAM_MS = 60 * 60 * 1000;
const HARI_MS = 24 * JAM_MS;

function waktuRelatif(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const selisih = Date.now() - t;
  if (selisih < 60_000) return 'Baru saja';
  if (selisih < JAM_MS) return `${Math.floor(selisih / 60_000)} menit lalu`;
  if (selisih < HARI_MS) return `${Math.floor(selisih / JAM_MS)} jam lalu`;
  if (selisih < 7 * HARI_MS) return `${Math.floor(selisih / HARI_MS)} hari lalu`;
  const d = new Date(t);
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}`;
}

function susunNotifLokal(
  status: LicenseStatus | null,
  rilis: Readonly<Record<string, { versi: string | null; url: string | null }>>
): NotifLokal[] {
  const hasil: NotifLokal[] = [];

  if (status && status.expiresAt) {
    const sisa = Date.parse(status.expiresAt) - Date.now();
    if (Number.isFinite(sisa) && sisa > 0 && sisa <= 7 * HARI_MS) {
      const hari = Math.ceil(sisa / HARI_MS);
      hasil.push({
        kunci: `n:masa:${status.expiresAt}:${hari}`,
        judul: hari <= 1 ? 'Masa lisensi berakhir hari ini' : `Masa lisensi tersisa ${hari} hari`,
        isi: 'Siapkan License Key baru agar pencatatan tidak terhenti. Data koperasi tetap aman di perangkat.',
        ikon: 'time',
        warna: hari <= 2 ? colors.danger : colors.warning,
        bukaLisensi: true,
      });
    }
  }

  if (status && status.allowAppAccess && status.graceRemainingMs !== null && status.graceRemainingMs <= 48 * JAM_MS) {
    const jam = Math.max(1, Math.ceil(status.graceRemainingMs / JAM_MS));
    hasil.push({
      kunci: `n:grace:${Math.ceil(jam / 12)}`,
      judul: 'Sambungkan ke internet sebentar',
      isi: `Lisensi perlu diverifikasi online dalam ${jam} jam. Cukup buka aplikasi saat ada koneksi.`,
      ikon: 'wifi',
      warna: colors.warning,
      bukaLisensi: true,
    });
  }

  if (status?.clockRollbackDetected) {
    hasil.push({
      kunci: 'n:jam',
      judul: 'Jam perangkat tidak sesuai',
      isi: 'Atur tanggal & jam perangkat ke otomatis agar pemeriksaan lisensi berjalan normal.',
      ikon: 'alarm',
      warna: colors.danger,
      bukaLisensi: true,
    });
  }

  const terbaru = rilis[getDevicePlatform()];
  if (terbaru?.versi && bandingkanVersi(terbaru.versi, versiAplikasi()) > 0) {
    hasil.push({
      kunci: `n:versi:${terbaru.versi}`,
      judul: `Versi ${terbaru.versi} tersedia`,
      isi: `Anda memakai versi ${versiAplikasi()}. Unduh versi terbaru dari website KOPKU.`,
      ikon: 'arrow-up-circle',
      warna: colors.accent,
      tautan: terbaru.url,
      labelTautan: 'Unduh pembaruan',
    });
  }

  return hasil;
}

function bukaTautan(url: string | null | undefined) {
  if (url && /^https:\/\//i.test(url)) {
    Linking.openURL(url).catch(() => undefined);
  }
}

export default function LoncengNotifikasi() {
  const insets = useSafeAreaInsets();
  const items = usePengumumanStore((s) => s.items);
  const rilis = usePengumumanStore((s) => s.rilis);
  const dibaca = usePengumumanStore((s) => s.dibaca);
  const memuat = usePengumumanStore((s) => s.memuat);
  const muat = usePengumumanStore((s) => s.muat);
  const tandai = usePengumumanStore((s) => s.tandai);

  const [terbuka, setTerbuka] = useState(false);
  const [tab, setTab] = useState<Tab>('pengumuman');
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [baruSaatDibuka, setBaruSaatDibuka] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<DetailItem | null>(null);
  const goyang = useRef(new Animated.Value(0)).current;

  const muatStatus = useCallback(() => {
    getLicenseStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void muat(false);
    muatStatus();
  }, [muat, muatStatus]);

  const notifLokal = useMemo(() => susunNotifLokal(status, rilis), [status, rilis]);
  const setDibaca = useMemo(() => new Set(dibaca), [dibaca]);
  const belumPengumuman = items.filter((a) => !setDibaca.has(`a:${a.id}`)).length;
  const belumNotif = notifLokal.filter((n) => !setDibaca.has(n.kunci)).length;
  const totalBelum = belumPengumuman + belumNotif;

  // Satu goyangan halus saat ada yang belum dibaca — bukan animasi berulang.
  useEffect(() => {
    if (totalBelum === 0) return;
    goyang.setValue(0);
    Animated.sequence([
      Animated.timing(goyang, { toValue: 1, duration: 110, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(goyang, { toValue: -1, duration: 160, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(goyang, { toValue: 0.6, duration: 140, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(goyang, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [totalBelum, goyang]);

  const kunciTab = useCallback(
    (t: Tab) => (t === 'pengumuman' ? items.map((a) => `a:${a.id}`) : notifLokal.map((n) => n.kunci)),
    [items, notifLokal]
  );

  const buka = () => {
    const awal: Tab = belumPengumuman === 0 && belumNotif > 0 ? 'notifikasi' : 'pengumuman';
    setBaruSaatDibuka(new Set([...items.map((a) => `a:${a.id}`), ...notifLokal.map((n) => n.kunci)].filter((k) => !setDibaca.has(k))));
    setTab(awal);
    setDetail(null);
    setTerbuka(true);
    void tandai(kunciTab(awal));
    void muat(true);
    muatStatus();
  };

  const gantiTab = (t: Tab) => {
    setTab(t);
    void tandai(kunciTab(t));
  };

  const tutup = () => {
    setTerbuka(false);
    setDetail(null);
  };

  /** RC-S126 — ketuk pesan: buka tampilan lengkap & tandai dibaca. */
  const bukaDetail = (d: DetailItem) => {
    setDetail(d);
    void tandai([d.kunci]);
  };

  const keLisensi = () => {
    tutup();
    router.push('/license');
  };

  const putar = goyang.interpolate({ inputRange: [-1, 1], outputRange: ['-14deg', '14deg'] });

  return (
    <>
      <TouchableOpacity
        style={styles.tombol}
        onPress={buka}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={totalBelum > 0 ? `Notifikasi, ${totalBelum} belum dibaca` : 'Notifikasi'}
      >
        <Animated.View style={{ transform: [{ rotate: putar }] }}>
          <Ionicons name={totalBelum > 0 ? 'notifications' : 'notifications-outline'} size={21} color={colors.primary} />
        </Animated.View>
        {totalBelum > 0 && (
          <View style={styles.lencana}>
            <Text style={styles.lencanaTeks}>{totalBelum > 9 ? '9+' : totalBelum}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Modal visible={terbuka} transparent animationType="slide" onRequestClose={() => (detail ? setDetail(null) : tutup())}>
        <Pressable style={styles.latar} onPress={tutup} accessibilityLabel="Tutup notifikasi" />
        <View style={[styles.lembar, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.pegangan} />
          <View style={styles.kepala}>
            {detail && (
              <TouchableOpacity onPress={() => setDetail(null)} style={styles.kembali} accessibilityLabel="Kembali ke daftar">
                <Ionicons name="chevron-back" size={20} color={colors.primary} />
              </TouchableOpacity>
            )}
            <Text style={styles.judulLembar}>{detail ? detail.label : 'Notifikasi'}</Text>
            <TouchableOpacity onPress={tutup} style={styles.tutup} accessibilityLabel="Tutup">
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {detail ? (
            <ScrollView style={styles.daftar} contentContainerStyle={styles.detailIsi}>
              <View style={[styles.detailIkon, { backgroundColor: detail.warna + '1A' }]}>
                <Ionicons name={detail.ikon} size={28} color={detail.warna} />
              </View>
              <View style={styles.barisMeta}>
                <Text style={[styles.label, { color: detail.warna }]}>{detail.label}</Text>
                {detail.disematkan && <Ionicons name="pin" size={11} color={colors.textFaint} />}
                {!!detail.waktu && <Text style={styles.waktu}>{detail.waktu}</Text>}
              </View>
              <Text style={styles.detailJudul} selectable>
                {detail.judul}
              </Text>
              {!!detail.isi && (
                <Text style={styles.detailTeks} selectable>
                  {detail.isi}
                </Text>
              )}
              {detail.bukaLisensi && (
                <TouchableOpacity style={styles.tombolAksi} onPress={keLisensi} accessibilityRole="button">
                  <Ionicons name="key-outline" size={16} color={colors.white} />
                  <Text style={styles.tombolAksiTeks}>Buka info lisensi</Text>
                </TouchableOpacity>
              )}
              {detail.tautan && (
                <TouchableOpacity
                  style={[styles.tombolAksi, detail.bukaLisensi && styles.tombolAksiSekunder]}
                  onPress={() => bukaTautan(detail.tautan)}
                  accessibilityRole="link"
                >
                  <Ionicons name="open-outline" size={16} color={detail.bukaLisensi ? colors.primary : colors.white} />
                  <Text style={[styles.tombolAksiTeks, detail.bukaLisensi && { color: colors.primary }]}>
                    {detail.labelTautan ?? 'Buka tautan'}
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          ) : (
          <>

          <View style={styles.segmen}>
            {(['pengumuman', 'notifikasi'] as const).map((t) => {
              const aktif = tab === t;
              const jumlah = t === 'pengumuman' ? items.length : notifLokal.length;
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.segmenItem, aktif && styles.segmenAktif]}
                  onPress={() => gantiTab(t)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: aktif }}
                >
                  <Text style={[styles.segmenTeks, aktif && styles.segmenTeksAktif]}>
                    {t === 'pengumuman' ? 'Pengumuman' : 'Notifikasi'}
                    {jumlah > 0 ? ` (${jumlah})` : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <ScrollView
            style={styles.daftar}
            contentContainerStyle={styles.daftarIsi}
            refreshControl={
              <RefreshControl
                refreshing={memuat}
                onRefresh={() => {
                  void muat(true);
                  muatStatus();
                }}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
          >
            {tab === 'pengumuman' &&
              (items.length === 0 ? (
                memuat ? (
                  <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
                ) : (
                  <Kosong ikon="megaphone-outline" teks="Belum ada pengumuman. Tarik ke bawah untuk memeriksa lagi." />
                )
              ) : (
                items.map((a) => {
                  const gaya = GAYA_LEVEL[a.level];
                  return (
                    <TouchableOpacity
                      key={a.id}
                      style={[styles.kartu, a.disematkan && styles.kartuSemat]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityHint="Buka pesan lengkap"
                      onPress={() =>
                        bukaDetail({
                          kunci: `a:${a.id}`,
                          judul: a.judul,
                          isi: a.isi,
                          ikon: gaya.ikon,
                          warna: gaya.warna,
                          label: gaya.label,
                          waktu: waktuRelatif(a.terbitPada),
                          disematkan: a.disematkan,
                          tautan: a.tautan,
                          labelTautan: a.labelTautan,
                          bukaLisensi: false,
                        })
                      }
                    >
                      <View style={[styles.ikonWadah, { backgroundColor: gaya.warna + '1A' }]}>
                        <Ionicons name={gaya.ikon} size={18} color={gaya.warna} />
                      </View>
                      <View style={styles.kartuIsi}>
                        <View style={styles.barisMeta}>
                          <Text style={[styles.label, { color: gaya.warna }]}>{gaya.label}</Text>
                          {a.disematkan && <Ionicons name="pin" size={11} color={colors.textFaint} />}
                          <Text style={styles.waktu}>{waktuRelatif(a.terbitPada)}</Text>
                          {baruSaatDibuka.has(`a:${a.id}`) && <View style={styles.titikBaru} />}
                        </View>
                        <Text style={styles.judulItem} numberOfLines={2}>{a.judul}</Text>
                        {!!a.isi && <Text style={styles.isiItem} numberOfLines={2}>{a.isi}</Text>}
                        <Text style={styles.bacaSelengkapnya}>Ketuk untuk membaca</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={styles.chevron} />
                    </TouchableOpacity>
                  );
                })
              ))}

            {tab === 'notifikasi' &&
              (notifLokal.length === 0 ? (
                <Kosong ikon="checkmark-done-circle-outline" teks="Semua beres. Lisensi aktif dan aplikasi sudah versi terbaru." />
              ) : (
                notifLokal.map((n) => (
                  <TouchableOpacity
                    key={n.kunci}
                    style={styles.kartu}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityHint="Buka pesan lengkap"
                    onPress={() =>
                      bukaDetail({
                        kunci: n.kunci,
                        judul: n.judul,
                        isi: n.isi,
                        ikon: n.ikon,
                        warna: n.warna,
                        label: 'Notifikasi',
                        waktu: '',
                        disematkan: false,
                        tautan: n.tautan ?? null,
                        labelTautan: n.labelTautan ?? null,
                        bukaLisensi: n.bukaLisensi === true,
                      })
                    }
                  >
                    <View style={[styles.ikonWadah, { backgroundColor: n.warna + '1A' }]}>
                      <Ionicons name={n.ikon} size={18} color={n.warna} />
                    </View>
                    <View style={styles.kartuIsi}>
                      <View style={styles.barisMeta}>
                        <Text style={styles.judulItem}>{n.judul}</Text>
                        {baruSaatDibuka.has(n.kunci) && <View style={styles.titikBaru} />}
                      </View>
                      <Text style={styles.isiItem} numberOfLines={2}>{n.isi}</Text>
                      <Text style={styles.bacaSelengkapnya}>Ketuk untuk membaca</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={styles.chevron} />
                  </TouchableOpacity>
                ))
              ))}
          </ScrollView>
          </>
          )}
        </View>
      </Modal>
    </>
  );
}

function Kosong({ ikon, teks }: { ikon: keyof typeof Ionicons.glyphMap; teks: string }) {
  return (
    <View style={styles.kosong}>
      <View style={styles.kosongIkon}>
        <Ionicons name={ikon} size={26} color={colors.primary} />
      </View>
      <Text style={styles.kosongTeks}>{teks}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tombol: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lencana: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 19,
    height: 19,
    paddingHorizontal: 4,
    borderRadius: 10,
    backgroundColor: colors.danger,
    borderWidth: 2,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lencanaTeks: { color: colors.white, fontSize: 10, fontWeight: '800' },

  latar: { flex: 1, backgroundColor: 'rgba(12, 24, 14, 0.45)' },
  lembar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '84%',
    backgroundColor: colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: spacing.sm,
  },
  pegangan: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.sm },
  kepala: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  judulLembar: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text },
  tutup: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },

  segmen: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: 4,
    marginBottom: spacing.md,
  },
  segmenItem: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
  segmenAktif: { backgroundColor: colors.white },
  segmenTeks: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  segmenTeksAktif: { color: colors.primary },

  daftar: { flexGrow: 0 },
  daftarIsi: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  kartu: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  kartuSemat: { borderColor: colors.primary },
  ikonWadah: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  kartuIsi: { flex: 1, minWidth: 0 },
  barisMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' },
  label: { fontSize: 11, fontWeight: '800' },
  waktu: { fontSize: 11, color: colors.textFaint },
  titikBaru: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.danger },
  judulItem: { fontSize: 14, fontWeight: '700', color: colors.text },
  isiItem: { fontSize: 13, color: colors.textMuted, lineHeight: 19, marginTop: 3 },
  bacaSelengkapnya: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 6 },
  chevron: { alignSelf: 'center' },
  kembali: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
    marginRight: spacing.sm,
  },
  detailIsi: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm },
  detailIkon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  detailJudul: { fontSize: 18, fontWeight: '800', color: colors.text, lineHeight: 24 },
  detailTeks: { fontSize: 14.5, color: colors.text, lineHeight: 22 },
  tombolAksi: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.md,
    paddingVertical: 13,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  tombolAksiSekunder: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.primary },
  tombolAksiTeks: { color: colors.white, fontWeight: '800', fontSize: 14 },

  kosong: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  kosongIkon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  kosongTeks: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
});
