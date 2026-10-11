import React, { useCallback, useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getDb } from '@/database/db';
import {
  cocokkanPasswordDeveloper,
  getStatusJamUji,
  getWaktuSekarang,
  muatJamUjiDariDb,
  setJamUjiAktif,
  setModeRealtime,
  setTahunKustom,
  setWaktuKustom,
  StatusJamUji,
} from '@/services/DevClockService';
import DatePicker from '@/components/DatePicker';
import AppTextInput from '@/components/AppTextInput';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing, iconSize, elevation } from '@/theme/colors';
import { ui } from '@/theme/ui';

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function toTanggalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toJamHHmmss(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

function toJamHHmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tanggalPanjang(d: Date): string {
  return `${HARI[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Layar "Developer" — Mode Pengujian Waktu (permintaan pengguna).
 *
 * DIKUNCI PASSWORD (bukan permission role): entri menu ini sengaja
 * TIDAK melewati `usePermission`/`Resource` seperti submenu Pengaturan
 * lain — fitur ini soal simulasi waktu untuk pengujian, bukan soal
 * kewenangan operasional koperasi, jadi gerbangnya password tetap
 * (lihat `DevClockService.cocokkanPasswordDeveloper`), diminta ULANG
 * setiap kali layar ini dibuka (tidak diingat antar sesi).
 *
 * SATU-SATUNYA hal yang diubah layar ini adalah baris `app_config` yang
 * dibaca `DevClockService` — TIDAK ADA logic tanggal baru di sini, dan
 * TIDAK ADA jurnal/transaksi yang diposting dari layar ini. Preset
 * lompat cepat di bawah murni MENYUSUN tanggal lalu memanggil
 * `setWaktuKustom()`/`setTahunKustom()` yang sudah ada — layar tidak
 * menyimpan jam simulasi sendiri.
 */
export default function DeveloperScreen() {
  const [terbuka, setTerbuka] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordSalah, setPasswordSalah] = useState(false);
  const [lihatPassword, setLihatPassword] = useState(false);
  const [memverifikasi, setMemverifikasi] = useState(false);

  const [status, setStatus] = useState<StatusJamUji | null>(null);
  const [menampilkanFormKustom, setMenampilkanFormKustom] = useState(false);
  const [tanggalKustom, setTanggalKustom] = useState('');
  const [jamKustom, setJamKustom] = useState('');
  const [tahunKustom, setTahunKustom_] = useState('');
  const [menyimpan, setMenyimpan] = useState(false);


  const simulasiAktif = !!status?.aktif && status?.mode === 'KUSTOM';

  const muatStatus = useCallback(async () => {
    const db = await getDb();
    await muatJamUjiDariDb(db);
    setStatus(getStatusJamUji());
  }, []);

  const bukaDenganPassword = async () => {
    if (!cocokkanPasswordDeveloper(passwordInput)) {
      setPasswordSalah(true);
      setPasswordInput('');
      return;
    }
    setMemverifikasi(true);
    try {
      await muatStatus();
      setTerbuka(true);
    } catch (e) {
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemverifikasi(false);
    }
  };

  const perbarui = () => setStatus(getStatusJamUji());

  const jalankan = async (fn: (db: Awaited<ReturnType<typeof getDb>>) => Promise<void>, sukses?: () => void) => {
    setMenyimpan(true);
    try {
      const db = await getDb();
      await fn(db);
      perbarui();
      // RC-S94 — "hari ini" aplikasi baru saja berubah. Minta koordinator
      // tugas latar (`StartupTasks`) mengejar periode yang kini jatuh tempo:
      // akrual jasa (termasuk pelepasan jasa diterima di muka ke Pendapatan
      // Jasa), penyusutan, EIR, bunga simpanan berjangka & bunga utang.
      // Tanpa ini pekerjaan itu baru jalan saat login/buka kunci berikutnya,
      // sehingga Laporan Hasil Usaha yang dibuka setelah waktu diganti masih
      // memakai keadaan lama. Memakai mekanisme resmi `requestStartupTask()`
      // (dikonsumsi listener di app/index.tsx) — bukan pemanggilan langsung —
      // jadi tetap satu batch, berurutan, dan idempoten.
      useAppStore.getState().requestStartupTask();
      sukses?.();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const toggleAktif = (nilaiBaru: boolean) => jalankan((db) => setJamUjiAktif(db, nilaiBaru));

  const pilihRealtime = () =>
    jalankan(
      (db) => setModeRealtime(db),
      () => setMenampilkanFormKustom(false)
    );

  const bukaFormKustom = () => {
    const basis = getWaktuSekarang();
    setTanggalKustom(toTanggalIso(basis));
    setJamKustom(toJamHHmm(basis));
    setMenampilkanFormKustom(true);
  };

  const terapkanWaktuKustom = () => {
    if (!/^\d{2}:\d{2}$/.test(jamKustom)) {
      notify('Jam tidak valid', 'Format jam harus HH:mm, misalnya 14:30.');
      return;
    }
    jalankan(
      (db) => setWaktuKustom(db, tanggalKustom, jamKustom),
      () => notify('Waktu kustom diterapkan', 'Aplikasi sekarang memakai waktu simulasi ini sebagai "hari ini".')
    );
  };

  // Preset lompat cepat — MENYUSUN tanggal dari waktu simulasi yang
  // sedang berjalan, lalu memanggil setWaktuKustom() yang sudah ada.
  // Skenario uji khas koperasi: tutup bulan, tutup buku akhir tahun,
  // pergantian tahun buku. Jam dipertahankan dari waktu berjalan.
  const lompatKe = (buat: (basis: Date) => Date, label: string) => {
    const basis = getWaktuSekarang();
    const target = buat(basis);
    jalankan(
      (db) => setWaktuKustom(db, toTanggalIso(target), toJamHHmm(target)),
      () => notify('Waktu diterapkan', `Waktu simulasi dilompatkan ke ${label}.`)
    );
  };

  const presetAkhirBulan = () =>
    lompatKe((b) => new Date(b.getFullYear(), b.getMonth() + 1, 0, b.getHours(), b.getMinutes()), 'akhir bulan berjalan');
  const presetAkhirTahun = () =>
    lompatKe((b) => new Date(b.getFullYear(), 11, 31, b.getHours(), b.getMinutes()), '31 Desember (tutup buku)');
  const presetAwalTahunDepan = () =>
    lompatKe((b) => new Date(b.getFullYear() + 1, 0, 1, b.getHours(), b.getMinutes()), '1 Januari tahun depan');

  const geserTahun = (delta: number) => {
    const tahunBerjalan = getWaktuSekarang().getFullYear();
    jalankan((db) => setTahunKustom(db, tahunBerjalan + delta));
  };

  const terapkanTahun = () => {
    const tahun = Number(tahunKustom);
    if (!Number.isInteger(tahun) || tahun < 2000 || tahun > 2100) {
      notify('Tahun tidak valid', 'Masukkan tahun berupa angka 2000–2100, misalnya 2027.');
      return;
    }
    jalankan(
      (db) => setTahunKustom(db, tahun),
      () => {
        setTahunKustom_('');
        notify('Tahun diterapkan', `Tahun simulasi sekarang ${tahun}, tanggal & jam lainnya mengikuti waktu berjalan.`);
      }
    );
  };

  // ============================================================
  // GERBANG PASSWORD
  // ============================================================
  if (!terbuka) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={ui.screenContent} keyboardShouldPersistTaps="handled">
        <View style={styles.lockCard}>
          <View style={styles.lockIconCircle}>
            <Ionicons name="terminal-outline" size={30} color={colors.primary} />
          </View>
          <Text style={styles.lockTitle}>Area Developer</Text>
          <Text style={styles.lockSub}>
            Alat pengujian internal. Masukkan password developer untuk membuka Mode Pengujian Waktu — bukan menu
            operasional koperasi.
          </Text>

          <View style={styles.pwWrap}>
            <View style={styles.pwField}>
              <AppTextInput
                label="Password Developer"
                value={passwordInput}
                onChangeText={(t) => {
                  setPasswordInput(t);
                  if (passwordSalah) setPasswordSalah(false);
                }}
                secureTextEntry={!lihatPassword}
                keyboardType="number-pad"
                placeholder="Masukkan password"
                onSubmitEditing={bukaDenganPassword}
              />
            </View>
            <TouchableOpacity
              style={styles.pwToggle}
              onPress={() => setLihatPassword((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={lihatPassword ? 'Sembunyikan password' : 'Tampilkan password'}
            >
              <Ionicons name={lihatPassword ? 'eye-off-outline' : 'eye-outline'} size={iconSize.md} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {passwordSalah && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={14} color={colors.danger} />
              <Text style={styles.errorText}>Password developer tidak cocok.</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, memverifikasi && styles.disabled]}
            onPress={bukaDenganPassword}
            disabled={memverifikasi}
            accessibilityRole="button"
          >
            {memverifikasi ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Ionicons name="lock-open-outline" size={iconSize.sm} color={colors.white} />
                <Text style={styles.primaryButtonText}>Buka</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ============================================================
  // ISI — MODE PENGUJIAN WAKTU
  // ============================================================
  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={ui.screenContent} keyboardShouldPersistTaps="handled">
        {/* Banner peringatan */}
        <View style={styles.warningBanner}>
          <Ionicons name="warning-outline" size={iconSize.md} color={colors.warning} />
          <Text style={styles.warningText}>
            Mode Pengujian Waktu mengubah "hari ini" yang dipakai SELURUH aplikasi — akrual, tutup periode, masa
            pajak, kalender transaksi, laporan & dokumen cetak. Lisensi, cap waktu audit, dan nama file backup tetap
            memakai jam asli. Gunakan hanya di database pengujian — matikan sebelum kembali ke data koperasi
            sungguhan.
          </Text>
        </View>

        {/* Jam simulasi — kartu utama. Detik berjalan diurus komponen
            `KartuJam` SENDIRI (lihat komentarnya): layar ini TIDAK lagi
            me-render ulang setiap detik, sehingga form tanggal/jam di bawah
            (termasuk kalender yang sedang terbuka) tidak terganggu. `key`
            membuat kartu langsung menampilkan waktu baru begitu pengaturan
            diubah, tanpa menunggu detik berikutnya. */}
        <KartuJam
          key={`${status?.aktif}-${status?.mode}-${status?.basisIso}-${status?.ditetapkanEpoch}`}
          simulasiAktif={simulasiAktif}
        />

        {/* Sakelar utama */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, paddingRight: spacing.md }}>
              <Text style={styles.cardTitle}>Aktifkan Mode Pengujian</Text>
              <Text style={styles.cardSub}>
                {status?.aktif
                  ? 'Aktif — aplikasi memakai jam simulasi di bawah.'
                  : 'Mati — aplikasi memakai jam perangkat asli.'}
              </Text>
            </View>
            {menyimpan || status === null ? (
              <ActivityIndicator />
            ) : (
              <Switch
                value={status.aktif}
                onValueChange={toggleAktif}
                trackColor={{ false: colors.border, true: colors.primaryLight }}
                thumbColor={status.aktif ? colors.primary : undefined}
              />
            )}
          </View>
        </View>

        {status?.aktif && (
          <>
            {/* Sumber waktu — segmented control */}
            <Text style={styles.sectionLabel}>SUMBER WAKTU</Text>
            <View style={styles.segment}>
              <TouchableOpacity
                style={[styles.segmentItem, status.mode === 'REALTIME' && styles.segmentItemActive]}
                onPress={pilihRealtime}
                disabled={menyimpan}
                accessibilityRole="button"
                accessibilityState={{ selected: status.mode === 'REALTIME' }}
              >
                <Ionicons
                  name="pulse-outline"
                  size={iconSize.sm}
                  color={status.mode === 'REALTIME' ? colors.white : colors.textMuted}
                />
                <Text style={[styles.segmentText, status.mode === 'REALTIME' && styles.segmentTextActive]}>Real-time</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentItem, status.mode === 'KUSTOM' && styles.segmentItemActive]}
                onPress={bukaFormKustom}
                disabled={menyimpan}
                accessibilityRole="button"
                accessibilityState={{ selected: status.mode === 'KUSTOM' }}
              >
                <Ionicons
                  name="construct-outline"
                  size={iconSize.sm}
                  color={status.mode === 'KUSTOM' ? colors.white : colors.textMuted}
                />
                <Text style={[styles.segmentText, status.mode === 'KUSTOM' && styles.segmentTextActive]}>Waktu Kustom</Text>
              </TouchableOpacity>
            </View>

            {/* Lompat cepat — skenario uji */}
            <Text style={styles.sectionLabel}>LOMPAT CEPAT</Text>
            <View style={styles.card}>
              <Text style={styles.cardSub}>
                Lompatkan waktu simulasi ke titik uji yang sering dipakai. Jam dipertahankan dari waktu berjalan.
              </Text>
              <View style={styles.presetGrid}>
                <PresetButton icon="calendar-outline" label="Akhir Bulan" onPress={presetAkhirBulan} disabled={menyimpan} />
                <PresetButton icon="flag-outline" label="31 Desember" sub="tutup buku" onPress={presetAkhirTahun} disabled={menyimpan} />
                <PresetButton icon="play-forward-outline" label="1 Jan Depan" sub="tahun baru" onPress={presetAwalTahunDepan} disabled={menyimpan} />
              </View>
            </View>

            {/* Form waktu kustom lengkap */}
            {menampilkanFormKustom && (
              <View style={styles.card}>
                <View style={styles.cardTitleRow}>
                  <Ionicons name="create-outline" size={iconSize.md} color={colors.primary} />
                  <Text style={styles.cardTitle}>Tetapkan Tanggal & Jam</Text>
                </View>
                <View style={{ marginTop: spacing.sm }}>
                  <DatePicker value={tanggalKustom} onChange={setTanggalKustom} />
                </View>
                <AppTextInput
                  label="Jam (HH:mm)"
                  value={jamKustom}
                  onChangeText={setJamKustom}
                  placeholder="14:30"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
                <TouchableOpacity
                  style={[styles.primaryButton, menyimpan && styles.disabled]}
                  onPress={terapkanWaktuKustom}
                  disabled={menyimpan}
                  accessibilityRole="button"
                >
                  {menyimpan ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <>
                      <Ionicons name="checkmark-outline" size={iconSize.sm} color={colors.white} />
                      <Text style={styles.primaryButtonText}>Terapkan Waktu Kustom</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Ubah tahun cepat — stepper + input */}
            <Text style={styles.sectionLabel}>UBAH TAHUN</Text>
            <View style={styles.card}>
              <Text style={styles.cardSub}>
                Ganti hanya komponen tahun; tanggal & jam mengikuti waktu yang sedang berjalan. Cocok untuk menguji
                pergantian tahun buku, SHU, dan masa lisensi.
              </Text>

              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={[styles.stepperBtn, menyimpan && styles.disabled]}
                  onPress={() => geserTahun(-1)}
                  disabled={menyimpan}
                  accessibilityRole="button"
                  accessibilityLabel="Kurangi satu tahun"
                >
                  <Ionicons name="remove" size={20} color={colors.primary} />
                  <Text style={styles.stepperBtnText}>1 Tahun</Text>
                </TouchableOpacity>

                <View style={styles.stepperYearBox}>
                  <Text style={styles.stepperYearLabel}>Tahun kini</Text>
                  <Text style={styles.stepperYearValue}>{getWaktuSekarang().getFullYear()}</Text>
                </View>

                <TouchableOpacity
                  style={[styles.stepperBtn, menyimpan && styles.disabled]}
                  onPress={() => geserTahun(1)}
                  disabled={menyimpan}
                  accessibilityRole="button"
                  accessibilityLabel="Tambah satu tahun"
                >
                  <Ionicons name="add" size={20} color={colors.primary} />
                  <Text style={styles.stepperBtnText}>1 Tahun</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.manualYearRow}>
                <View style={{ flex: 1 }}>
                  <AppTextInput
                    label="Tahun manual"
                    value={tahunKustom}
                    onChangeText={setTahunKustom_}
                    placeholder="2027"
                    keyboardType="number-pad"
                    maxLength={4}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.secondaryButton, menyimpan && styles.disabled]}
                  onPress={terapkanTahun}
                  disabled={menyimpan}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Terapkan</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/**
 * Kartu jam simulasi dengan detik berjalan.
 *
 * BUG FIX — kalender "melompat kembali": sebelumnya `setInterval` 1 detik
 * hidup di `DeveloperScreen` sendiri, sehingga SELURUH layar — termasuk
 * `DatePicker` pada form "Tetapkan Tanggal & Jam" — me-render ulang tiap
 * detik. Pada Android, render ulang itu membuat dialog kalender dibuka
 * ulang ke tanggal terpilih (lihat komentar di `DatePicker.tsx`), jadi
 * pengguna yang menggeser kalender dari November ke Desember ditarik
 * kembali ke November. Detik berjalan sekarang terkurung di komponen
 * ini: hanya kartu jam yang me-render ulang, form di bawahnya tidak.
 *
 * Murni tampilan — membaca `getWaktuSekarang()` / waktu asli, TIDAK
 * mengubah state `DevClockService`.
 */
function KartuJam({ simulasiAktif }: { simulasiAktif: boolean }) {
  const [pratinjau, setPratinjau] = useState(() => getWaktuSekarang());
  const [waktuAsli, setWaktuAsli] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => {
      setPratinjau(getWaktuSekarang());
      setWaktuAsli(new Date());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={[styles.clockCard, simulasiAktif ? styles.clockCardSim : styles.clockCardReal]}>
      <View style={styles.clockHeaderRow}>
        <View style={[styles.clockDot, { backgroundColor: simulasiAktif ? colors.warning : '#8FD69A' }]} />
        <Text style={styles.clockHeaderText}>{simulasiAktif ? 'WAKTU SIMULASI' : 'WAKTU APLIKASI'}</Text>
        <View
          style={[
            styles.clockModePill,
            { backgroundColor: simulasiAktif ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.12)' },
          ]}
        >
          <Text style={[styles.clockModePillText, { color: simulasiAktif ? '#FFE08A' : '#DFF3E2' }]}>
            {simulasiAktif ? 'Kustom' : 'Real-time'}
          </Text>
        </View>
      </View>

      <Text style={styles.clockTime}>{toJamHHmmss(pratinjau)}</Text>
      <Text style={styles.clockDate}>{tanggalPanjang(pratinjau)}</Text>

      {simulasiAktif && (
        <View style={styles.realtimeRefRow}>
          <Ionicons name="time-outline" size={13} color={colors.textFaint} />
          <Text style={styles.realtimeRefText}>
            Waktu asli perangkat: {tanggalPanjang(waktuAsli)} · {toJamHHmm(waktuAsli)}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Tombol preset lompat cepat — kartu kecil beraksen ikon. */
function PresetButton({
  icon,
  label,
  sub,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.presetBtn, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={20} color={colors.primary} />
      <Text style={styles.presetLabel}>{label}</Text>
      {sub ? <Text style={styles.presetSub}>{sub}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  sectionLabel: { ...ui.sectionLabel },

  // ---- Gerbang password ----
  lockCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    marginTop: spacing.xl,
    ...elevation.card,
  },
  lockIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  lockTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
  lockSub: {
    fontSize: 12.5,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    lineHeight: 18,
  },
  pwWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, width: '100%' },
  pwField: { flex: 1 },
  pwToggle: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: spacing.xs },
  errorText: { fontSize: 12, color: colors.danger, fontWeight: '600' },

  // ---- Banner peringatan ----
  warningBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  warningText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },

  // ---- Jam simulasi ----
  clockCard: { borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md, ...elevation.card },
  clockCardSim: { backgroundColor: '#3A2A00', borderWidth: 1, borderColor: colors.warning },
  clockCardReal: { backgroundColor: colors.primaryDark },
  clockHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  clockDot: { width: 8, height: 8, borderRadius: 4 },
  clockHeaderText: { flex: 1, fontSize: 11, fontWeight: '700', letterSpacing: 1, color: 'rgba(255,255,255,0.75)' },
  clockModePill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  clockModePillText: { fontSize: 10.5, fontWeight: '700' },
  clockTime: { fontSize: 40, fontWeight: '800', color: colors.white, fontVariant: ['tabular-nums'], letterSpacing: 1 },
  clockDate: { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  realtimeRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.15)',
  },
  realtimeRefText: { fontSize: 11, color: 'rgba(255,255,255,0.6)' },

  // ---- Kartu umum ----
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  cardSub: { fontSize: 12, color: colors.textMuted, marginTop: 3, lineHeight: 17 },

  // ---- Segmented control ----
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    padding: 3,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  segmentItemActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 12.5, color: colors.textMuted, fontWeight: '600' },
  segmentTextActive: { color: colors.white },

  // ---- Preset lompat cepat ----
  presetGrid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  presetBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.primaryLight,
  },
  presetLabel: { fontSize: 12, fontWeight: '700', color: colors.primary, textAlign: 'center' },
  presetSub: { fontSize: 10, color: colors.textMuted },

  // ---- Stepper tahun ----
  stepperRow: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm, marginTop: spacing.md },
  stepperBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  stepperBtnText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  stepperYearBox: {
    flex: 1.1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepperYearLabel: { fontSize: 10, color: colors.textMuted },
  stepperYearValue: { fontSize: 20, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  manualYearRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },

  // ---- Tombol ----
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    marginTop: spacing.md,
    width: '100%',
  },
  primaryButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  secondaryButton: {
    backgroundColor: colors.primaryLight,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    marginBottom: 2,
  },
  secondaryButtonText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.6 },
});
