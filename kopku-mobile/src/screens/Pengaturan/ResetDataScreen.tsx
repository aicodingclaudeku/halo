import React, { useCallback, useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppTextInput from '@/components/AppTextInput';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { isPinEnabled } from '@/services/SecurityService';
import { unlockWithPin } from '@/services/AuthService';
import { createBackup } from '@/services/BackupService';
import {
  hitungRingkasanDataUntukReset,
  jalankanResetData,
  HasilReset,
} from '@/services/ResetDataService';
import { KelompokRingkasanData } from '@/services/ResetDataTransaksi';
import {
  DURASI_TAHAN_MS,
  FRASA_KONFIRMASI,
  LABEL_MODE,
  ModeResetData,
  PESAN_LAPIS,
  RINGKASAN_MODE,
  StatusKonfirmasiReset,
  TABEL_DIPERTAHANKAN_TRANSAKSI,
  bolehJalankanReset,
  gantiMode,
  lapisBelumTerpenuhi,
  statusKonfirmasiAwal,
} from '@/services/ResetDataPlan';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui } from '@/theme/ui';

/**
 * RC-S99 — LAYAR RESET DATA.
 *
 * Permintaan pengguna: "tombol reset data yang memiliki beberapa kali
 * konfirmasi agar tidak tertekan tidak sengaja".
 *
 * Layar ini TIDAK menyusun sendiri syarat "boleh reset". Seluruh
 * keputusan itu ada di `ResetDataPlan.bolehJalankanReset()` — satu
 * gerbang yang diuji terpisah. Alasannya langsung: kalau syaratnya
 * ditulis ulang di sini sebagai rangkaian `&&`, satu lapis bisa lupa
 * diikutkan saat tata letak layar diubah, dan itu tepat jenis kesalahan
 * yang paling mahal pada fitur penghapusan permanen.
 *
 * Enam lapis, masing-masing menuntut JENIS tindakan yang berbeda —
 * bukan enam kali menekan "Ya", yang justru dihafal dan ditekan refleks:
 *
 *   1. Memilih mode (tidak ada yang terpilih saat layar dibuka).
 *   2. Membaca rincian dampak beserta jumlah baris NYATA, lalu
 *      menyatakan paham.
 *   3. Membuat backup, atau menyatakan sengaja tanpa backup.
 *   4. MENGETIK frasa konfirmasi.
 *   5. Memasukkan PIN (bila app-lock PIN aktif).
 *   6. MENAHAN tombol terakhir 3 detik, lalu satu dialog penutup.
 *
 * Berganti mode di tengah jalan MENGOSONGKAN lapis yang sudah dilewati
 * (lihat `gantiMode`), supaya persiapan untuk reset ringan tidak pernah
 * menjadi izin untuk reset total.
 */
export default function ResetDataScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const resetStore = useAppStore((s) => s.reset);

  const [status, setStatus] = useState<StatusKonfirmasiReset>(statusKonfirmasiAwal(false));
  const [ringkasan, setRingkasan] = useState<KelompokRingkasanData[] | null>(null);
  const [memuat, setMemuat] = useState(true);
  const [pin, setPin] = useState('');
  const [errorPin, setErrorPin] = useState<string | null>(null);
  const [memeriksaPin, setMemeriksaPin] = useState(false);
  const [membuatBackup, setMembuatBackup] = useState(false);
  const [namaBackup, setNamaBackup] = useState<string | null>(null);
  const [berjalan, setBerjalan] = useState(false);
  const [hasil, setHasil] = useState<HasilReset | null>(null);

  const bukanAdmin = !!currentUser && currentUser.role !== 'ADMIN';

  useEffect(() => {
    let batal = false;
    (async () => {
      try {
        const [pinAktif, kelompok] = await Promise.all([isPinEnabled(), hitungRingkasanDataUntukReset()]);
        if (batal) return;
        setStatus(statusKonfirmasiAwal(pinAktif));
        setRingkasan(kelompok);
      } catch (e) {
        if (!batal) notify('Gagal memuat', e instanceof Error ? e.message : String(e), undefined, 'error');
      } finally {
        if (!batal) setMemuat(false);
      }
    })();
    return () => {
      batal = true;
    };
  }, []);

  const pilihMode = (mode: ModeResetData) => {
    setStatus((s) => gantiMode(s, mode));
    // Kolom PIN & frasa dikosongkan bersamaan supaya yang terlihat di
    // layar tidak pernah lebih maju daripada status sebenarnya.
    setPin('');
    setErrorPin(null);
  };

  const buatBackup = async () => {
    if (!currentUser) return;
    setMembuatBackup(true);
    try {
      const info = await createBackup(currentUser.id);
      setNamaBackup(info.fileName);
      setStatus((s) => ({ ...s, backupDibuat: true }));
      notify('Backup dibuat', info.fileName, undefined, 'success');
    } catch (e) {
      notify('Backup gagal', e instanceof Error ? e.message : String(e), undefined, 'error');
    } finally {
      setMembuatBackup(false);
    }
  };

  const periksaPin = async () => {
    setMemeriksaPin(true);
    setErrorPin(null);
    try {
      await unlockWithPin(pin);
      setStatus((s) => ({ ...s, pinTerverifikasi: true }));
    } catch {
      // Pesan seragam & tidak menyebut sebabnya — sama seperti layar
      // kunci: jangan memberi petunjuk apakah PIN-nya "hampir benar".
      setErrorPin('PIN tidak cocok.');
      setStatus((s) => ({ ...s, pinTerverifikasi: false }));
    } finally {
      setMemeriksaPin(false);
    }
  };

  const kurang = lapisBelumTerpenuhi(status);
  const boleh = bolehJalankanReset(status) && !bukanAdmin;

  /** Lapis 6 — dialog penutup, ditampilkan HANYA setelah tombol ditahan penuh. */
  const konfirmasiTerakhir = () => {
    if (!status.mode || !currentUser) return;
    const mode = status.mode;
    notify(
      `${LABEL_MODE[mode]} — langkah terakhir`,
      mode === 'TOTAL'
        ? 'Seluruh isi database dihapus, termasuk akun login Anda. Aplikasi akan kembali ke setup awal. Tindakan ini TIDAK BISA dibatalkan.'
        : 'Seluruh data operasional dihapus dan tidak bisa dikembalikan kecuali dari backup. Lanjutkan?',
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Ya, jalankan', style: 'destructive', onPress: () => void jalankan(mode) },
      ],
      'warning'
    );
  };

  const jalankan = async (mode: ModeResetData) => {
    if (!currentUser) return;
    setBerjalan(true);
    try {
      const r = await jalankanResetData(currentUser.id, mode);
      setHasil(r);
      // Kunci ulang seluruh lapis: layar tidak boleh tetap "siap
      // menembak" setelah satu reset berhasil.
      setStatus(statusKonfirmasiAwal(status.pinDiperlukan));
      setPin('');
      setNamaBackup(null);
      if (r.perluSetupUlang) {
        // Database lama sudah tidak ada — state aplikasi harus dilepas
        // supaya navigasi kembali ke alur setup awal.
        resetStore();
      } else {
        setRingkasan(await hitungRingkasanDataUntukReset());
      }
    } catch (e) {
      notify('Reset gagal', e instanceof Error ? e.message : String(e), undefined, 'error');
    } finally {
      setBerjalan(false);
    }
  };

  if (memuat) {
    return (
      <View style={styles.tengah}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (hasil) {
    return <HasilResetView hasil={hasil} />;
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={ui.screenContent}>
        <View style={styles.peringatanUtama}>
          <Ionicons name="warning" size={22} color={colors.danger} />
          <Text style={styles.peringatanUtamaText}>
            Penghapusan di layar ini PERMANEN. Tidak ada tombol "urungkan" — satu-satunya jalan kembali adalah memulihkan
            dari backup.
          </Text>
        </View>

        {bukanAdmin && (
          <View style={styles.blokir}>
            <Text style={styles.blokirText}>
              Hanya Admin yang dapat melakukan reset data. Anda masuk sebagai {currentUser?.role}.
            </Text>
          </View>
        )}

        {/* ---------- LAPIS 1: PILIH MODE ---------- */}
        <Langkah nomor={1} judul="Pilih jenis reset" selesai={!!status.mode}>
          {(['TRANSAKSI', 'TOTAL'] as ModeResetData[]).map((mode) => {
            const aktif = status.mode === mode;
            return (
              <TouchableOpacity
                key={mode}
                style={[styles.kartuMode, aktif && (mode === 'TOTAL' ? styles.kartuModeTotalAktif : styles.kartuModeAktif)]}
                onPress={() => pilihMode(mode)}
                disabled={bukanAdmin}
                testID={`mode-${mode.toLowerCase()}`}
              >
                <Ionicons
                  name={aktif ? 'radio-button-on' : 'radio-button-off'}
                  size={iconSize.md}
                  color={aktif ? (mode === 'TOTAL' ? colors.danger : colors.primary) : colors.textFaint}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.kartuModeJudul, aktif && mode === 'TOTAL' && { color: colors.danger }]}>
                    {LABEL_MODE[mode]}
                  </Text>
                  <Text style={styles.kartuModeSub}>{RINGKASAN_MODE[mode]}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </Langkah>

        {/* ---------- LAPIS 2: RINCIAN DAMPAK ---------- */}
        <Langkah nomor={2} judul="Baca rincian dampaknya" selesai={status.dampakDipahami} nonaktif={!status.mode}>
          {!status.mode ? (
            <Text style={styles.tungguText}>Pilih jenis reset terlebih dahulu.</Text>
          ) : (
            <>
              {status.mode === 'TRANSAKSI' ? (
                <>
                  <Text style={styles.subJudul}>Yang akan DIHAPUS (jumlah saat ini)</Text>
                  {ringkasan?.map((k) => (
                    <View key={k.label} style={styles.barisRingkas}>
                      <Text style={styles.barisRingkasLabel}>{k.label}</Text>
                      <Text style={[styles.barisRingkasNilai, k.jumlah > 0 && styles.barisRingkasNilaiAda]}>
                        {k.jumlah.toLocaleString('id-ID')}
                      </Text>
                    </View>
                  ))}
                  <Text style={[styles.subJudul, { marginTop: spacing.md }]}>Yang TETAP ADA</Text>
                  <Text style={styles.daftarAman}>
                    Identitas & profil koperasi · Pengguna beserta login dan izinnya · Daftar akun (COA) dan pemetaannya ·
                    Master klasifikasi aset, data referensi, rekening bank · Periode akuntansi · Pengaturan aplikasi ·
                    Jejak audit
                  </Text>
                  <Text style={styles.catatanKecil}>
                    {TABEL_DIPERTAHANKAN_TRANSAKSI.length} kelompok tabel konfigurasi dipertahankan. Nomor otomatis
                    (anggota, pinjaman, bukti) mulai dari 1 lagi.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.subJudul}>Yang akan DIHAPUS</Text>
                  <Text style={styles.daftarBahaya}>
                    SELURUH isi database, tanpa kecuali — termasuk identitas koperasi, daftar akun, pengaturan, seluruh
                    pengguna, dan akun login Anda sendiri.
                  </Text>
                  <Text style={styles.subJudul}>Setelah reset</Text>
                  <Text style={styles.daftarAman}>
                    Aplikasi kembali ke layar setup awal seperti baru dipasang. Anda harus membuat ulang identitas
                    koperasi dan pengguna Admin sebelum bisa memakainya lagi.
                  </Text>
                </>
              )}

              <Kotak
                dicentang={status.dampakDipahami}
                onPress={() => setStatus((s) => ({ ...s, dampakDipahami: !s.dampakDipahami }))}
                label="Saya sudah membaca dan memahami apa yang akan hilang."
                testID="centang-dampak"
              />
            </>
          )}
        </Langkah>

        {/* ---------- LAPIS 3: GERBANG BACKUP ---------- */}
        <Langkah
          nomor={3}
          judul="Backup"
          selesai={status.backupDibuat || status.lanjutTanpaBackup}
          nonaktif={!status.dampakDipahami}
        >
          <Text style={styles.tungguText}>
            Aplikasi juga membuat salinan pengaman otomatis sebelum reset, tapi backup manual di sinilah yang bisa Anda
            simpan sendiri ke tempat lain.
          </Text>
          <TouchableOpacity
            style={[styles.tombolBackup, status.backupDibuat && styles.tombolBackupSelesai]}
            onPress={buatBackup}
            disabled={membuatBackup || !status.dampakDipahami}
            testID="tombol-backup"
          >
            {membuatBackup ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Ionicons
                  name={status.backupDibuat ? 'checkmark-circle' : 'save-outline'}
                  size={iconSize.md}
                  color={status.backupDibuat ? colors.success : colors.primary}
                />
                <Text style={styles.tombolBackupText}>
                  {status.backupDibuat ? 'Backup sudah dibuat' : 'Buat Backup Sekarang'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {namaBackup && <Text style={styles.catatanKecil}>Berkas: {namaBackup}</Text>}

          <Kotak
            dicentang={status.lanjutTanpaBackup}
            onPress={() => setStatus((s) => ({ ...s, lanjutTanpaBackup: !s.lanjutTanpaBackup }))}
            label="Saya sengaja melanjutkan TANPA backup."
            bahaya
            testID="centang-tanpa-backup"
          />
        </Langkah>

        {/* ---------- LAPIS 4: KETIK FRASA ---------- */}
        <Langkah
          nomor={4}
          judul="Ketik frasa konfirmasi"
          selesai={!kurang.includes('FRASA_BELUM_COCOK')}
          nonaktif={!status.backupDibuat && !status.lanjutTanpaBackup}
        >
          {status.mode ? (
            <>
              <Text style={styles.tungguText}>
                Ketik persis: <Text style={styles.frasa}>{FRASA_KONFIRMASI[status.mode]}</Text>
              </Text>
              <AppTextInput
                value={status.frasaDiketik}
                onChangeText={(t) => setStatus((s) => ({ ...s, frasaDiketik: t }))}
                placeholder={FRASA_KONFIRMASI[status.mode]}
                autoCapitalize="characters"
                autoCorrect={false}
                noIcon
                editable={status.backupDibuat || status.lanjutTanpaBackup}
                testID="input-frasa"
              />
            </>
          ) : (
            <Text style={styles.tungguText}>Pilih jenis reset terlebih dahulu.</Text>
          )}
        </Langkah>

        {/* ---------- LAPIS 5: PIN ---------- */}
        {status.pinDiperlukan && (
          <Langkah
            nomor={5}
            judul="Masukkan PIN Anda"
            selesai={status.pinTerverifikasi}
            nonaktif={kurang.includes('FRASA_BELUM_COCOK')}
          >
            <AppTextInput
              value={pin}
              onChangeText={(t) => {
                setPin(t);
                setErrorPin(null);
              }}
              placeholder="PIN"
              keyboardType="number-pad"
              secureTextEntry
              error={errorPin ?? undefined}
              editable={!status.pinTerverifikasi && !kurang.includes('FRASA_BELUM_COCOK')}
              noIcon
              testID="input-pin"
            />
            {!status.pinTerverifikasi && (
              <TouchableOpacity
                style={styles.tombolPin}
                onPress={periksaPin}
                disabled={memeriksaPin || pin.length === 0}
                testID="tombol-periksa-pin"
              >
                {memeriksaPin ? <ActivityIndicator color={colors.white} /> : <Text style={styles.tombolPinText}>Periksa PIN</Text>}
              </TouchableOpacity>
            )}
            {status.pinTerverifikasi && <Text style={styles.pinOk}>PIN terverifikasi.</Text>}
          </Langkah>
        )}

        {/* ---------- LAPIS 6: TAHAN TOMBOL ---------- */}
        <View style={styles.zonaAkhir}>
          {!boleh && kurang.length > 0 && (
            <View style={styles.sisaLapis}>
              <Text style={styles.sisaLapisJudul}>Belum bisa dijalankan</Text>
              {kurang.map((a) => (
                <Text key={a} style={styles.sisaLapisItem}>
                  • {PESAN_LAPIS[a]}
                </Text>
              ))}
            </View>
          )}

          <TombolTahan aktif={boleh && !berjalan} berjalan={berjalan} mode={status.mode} onSelesai={konfirmasiTerakhir} />
        </View>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/**
 * LAPIS 6 — tombol yang harus DITAHAN `DURASI_TAHAN_MS`.
 *
 * Inilah lapis yang paling langsung menjawab "agar tidak tertekan tidak
 * sengaja": sentuhan tidak sengaja bersifat sekejap, sedangkan tombol ini
 * hanya terpicu kalau jari bertahan sampai bilah terisi penuh. Melepas
 * jari lebih awal membatalkan dan mengembalikan bilah ke nol — tidak ada
 * kemajuan yang tersimpan.
 */
function TombolTahan({
  aktif,
  berjalan,
  mode,
  onSelesai,
}: {
  aktif: boolean;
  berjalan: boolean;
  mode: ModeResetData | null;
  onSelesai: () => void;
}) {
  const progres = useRef(new Animated.Value(0)).current;
  const [menahan, setMenahan] = useState(false);
  // Ref supaya callback animasi selalu memanggil versi terbaru tanpa
  // perlu me-restart animasinya (pola yang sama dengan DatePicker RC-S93).
  const onSelesaiRef = useRef(onSelesai);
  useEffect(() => {
    onSelesaiRef.current = onSelesai;
  }, [onSelesai]);

  const mulai = useCallback(() => {
    if (!aktif) return;
    setMenahan(true);
    Animated.timing(progres, {
      toValue: 1,
      duration: DURASI_TAHAN_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start(({ finished }) => {
      setMenahan(false);
      progres.setValue(0);
      if (finished) onSelesaiRef.current();
    });
  }, [aktif, progres]);

  const batal = useCallback(() => {
    progres.stopAnimation(() => {
      progres.setValue(0);
      setMenahan(false);
    });
  }, [progres]);

  const lebar = progres.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPressIn={mulai}
      onPressOut={batal}
      disabled={!aktif || berjalan}
      style={[styles.tombolAkhir, !aktif && styles.tombolAkhirMati, mode === 'TOTAL' && aktif && styles.tombolAkhirTotal]}
      testID="tombol-tahan-reset"
    >
      <Animated.View style={[styles.tombolAkhirProgres, { width: lebar }]} pointerEvents="none" />
      {berjalan ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <>
          <Ionicons name="trash-outline" size={iconSize.md} color={colors.white} />
          <Text style={styles.tombolAkhirText}>
            {menahan ? 'Terus tahan…' : aktif ? `Tahan 3 detik untuk ${LABEL_MODE[mode ?? 'TRANSAKSI']}` : 'Tahan untuk reset'}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function Langkah({
  nomor,
  judul,
  selesai,
  nonaktif,
  children,
}: {
  nomor: number;
  judul: string;
  selesai: boolean;
  nonaktif?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.langkah, nonaktif && styles.langkahNonaktif]}>
      <View style={styles.langkahHeader}>
        <View style={[styles.langkahNomor, selesai && styles.langkahNomorSelesai]}>
          {selesai ? (
            <Ionicons name="checkmark" size={14} color={colors.white} />
          ) : (
            <Text style={styles.langkahNomorText}>{nomor}</Text>
          )}
        </View>
        <Text style={styles.langkahJudul}>{judul}</Text>
      </View>
      <View style={styles.langkahIsi}>{children}</View>
    </View>
  );
}

function Kotak({
  dicentang,
  onPress,
  label,
  bahaya,
  testID,
}: {
  dicentang: boolean;
  onPress: () => void;
  label: string;
  bahaya?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity style={styles.kotakBaris} onPress={onPress} testID={testID}>
      <Ionicons
        name={dicentang ? 'checkbox' : 'square-outline'}
        size={iconSize.md}
        color={dicentang ? (bahaya ? colors.danger : colors.primary) : colors.textFaint}
      />
      <Text style={[styles.kotakLabel, dicentang && bahaya && { color: colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function HasilResetView({ hasil }: { hasil: HasilReset }) {
  return (
    <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={ui.screenContent}>
      <View style={styles.hasilKartu}>
        <Ionicons name="checkmark-circle" size={44} color={colors.success} />
        <Text style={styles.hasilJudul}>{LABEL_MODE[hasil.mode]} selesai</Text>
        {hasil.mode === 'TRANSAKSI' ? (
          <Text style={styles.hasilSub}>
            {hasil.totalBarisTerhapus.toLocaleString('id-ID')} baris data dihapus. Identitas koperasi, pengguna, dan
            daftar akun tetap seperti sebelumnya.
          </Text>
        ) : (
          <Text style={styles.hasilSub}>
            Seluruh database dihapus. Tutup dan buka kembali aplikasi untuk memulai setup awal.
          </Text>
        )}
      </View>

      {hasil.salinanPengaman ? (
        <View style={styles.hasilInfo}>
          <Text style={styles.hasilInfoJudul}>Salinan pengaman tersimpan</Text>
          <Text style={styles.hasilInfoText}>{hasil.salinanPengaman}</Text>
          <Text style={styles.catatanKecil}>
            Ada di daftar Backup &amp; Restore. Inilah satu-satunya jalan kembali ke kondisi sebelum reset.
          </Text>
        </View>
      ) : (
        <View style={styles.hasilGagalPengaman}>
          <Text style={styles.hasilInfoJudul}>Salinan pengaman TIDAK terbuat</Text>
          <Text style={styles.hasilInfoText}>
            {hasil.peringatanSalinanPengaman ?? 'Penyebabnya tidak diketahui.'}
          </Text>
          <Text style={styles.catatanKecil}>
            Reset tetap dijalankan sesuai permintaan Anda, tetapi tidak ada salinan otomatis untuk kondisi sebelum
            reset. Backup manual yang Anda buat sendiri (bila ada) tidak terpengaruh.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },

  peringatanUtama: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  peringatanUtamaText: { flex: 1, fontSize: 12, color: colors.danger, lineHeight: 17, fontWeight: '600' },

  blokir: {
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  blokirText: { fontSize: 12, color: colors.text },

  langkah: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  langkahNonaktif: { opacity: 0.55 },
  langkahHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.focusBg,
  },
  langkahNomor: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langkahNomorSelesai: { backgroundColor: colors.success },
  langkahNomorText: { fontSize: 11, fontWeight: '800', color: colors.white },
  langkahJudul: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  langkahIsi: { padding: spacing.md, gap: spacing.xs },

  kartuMode: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  kartuModeAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  kartuModeTotalAktif: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  kartuModeJudul: { fontSize: 13, fontWeight: '800', color: colors.text },
  kartuModeSub: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 2 },

  subJudul: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: spacing.xs,
  },
  barisRingkas: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barisRingkasLabel: { flex: 1, fontSize: 12, color: colors.text },
  barisRingkasNilai: { fontSize: 12, color: colors.textFaint, fontVariant: ['tabular-nums'], fontWeight: '700' },
  barisRingkasNilaiAda: { color: colors.danger },
  daftarAman: { fontSize: 12, color: colors.text, lineHeight: 18 },
  daftarBahaya: { fontSize: 12, color: colors.danger, lineHeight: 18, fontWeight: '600' },
  catatanKecil: { fontSize: 11, color: colors.textMuted, lineHeight: 15, marginTop: spacing.xs },
  tungguText: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  frasa: { fontWeight: '800', color: colors.danger, letterSpacing: 0.5 },

  kotakBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  kotakLabel: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },

  tombolBackup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  tombolBackupSelesai: { borderColor: colors.success, backgroundColor: colors.primaryLight },
  tombolBackupText: { fontSize: 13, fontWeight: '700', color: colors.primary },

  tombolPin: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  tombolPinText: { fontSize: 13, fontWeight: '700', color: colors.white },
  pinOk: { fontSize: 12, color: colors.success, fontWeight: '700' },

  zonaAkhir: { marginTop: spacing.md },
  sisaLapis: {
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  sisaLapisJudul: { fontSize: 12, fontWeight: '800', color: colors.text, marginBottom: spacing.xs },
  sisaLapisItem: { fontSize: 12, color: colors.text, lineHeight: 18 },

  tombolAkhir: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    overflow: 'hidden',
    marginBottom: spacing.xl,
  },
  tombolAkhirTotal: { backgroundColor: '#8E1B1B' },
  tombolAkhirMati: { backgroundColor: colors.disabled },
  tombolAkhirProgres: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  tombolAkhirText: { fontSize: 14, fontWeight: '800', color: colors.white },

  hasilKartu: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  hasilJudul: { fontSize: 15, fontWeight: '800', color: colors.text, textAlign: 'center' },
  hasilSub: { fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  hasilInfo: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  hasilGagalPengaman: {
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  hasilInfoJudul: { fontSize: 12, fontWeight: '800', color: colors.text, marginBottom: 2 },
  hasilInfoText: { fontSize: 12, color: colors.text },
});
