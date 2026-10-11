import React, { useCallback, useEffect, useState } from 'react';
import FieldError from '@/components/FieldError';
import FocusTextInput from '@/components/FocusTextInput';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Modal,
  ScrollView,
} from 'react-native';
import { notify } from '@/store/useNotifyStore';
import { useNavigation } from '@react-navigation/native';
import {
  createBackup,
  listBackups,
  deleteBackup,
  shareBackup,
  pilihFileBackupEksternal,
  validasiFileBackup,
  restoreBackup,
  BackupFileInfo,
  BackupProgressStage,
  enkripsiUlangBackupLama,
} from '@/services/BackupService';
import { pastikanKodePemulihan } from '@/security/backupKeyStore';
import {
  periksaKodePemulihan,
  rapikanKodePemulihan,
  formatKodePemulihan,
  PESAN_PERIKSA_KODE,
  PANJANG_DATA_KODE,
} from '@/backup/KodePemulihan';

/** Panjang kode setelah dirapikan (data + satu karakter periksa). */
const PANJANG_KODE_PENUH = PANJANG_DATA_KODE + 1;
import { HasilValidasiBackup } from '@/backup/BackupValidator';
import { formatUkuranFile } from '@/backup/BackupValidator';
import { useAppStore } from '@/store/useAppStore';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

const STAGE_LABEL: Record<BackupProgressStage, string> = {
  MEMPERSIAPKAN: 'Mempersiapkan…',
  MENYALIN: 'Menyalin database…',
  SELESAI: 'Selesai',
};

interface KandidatRestore {
  uri: string;
  label: string;
}

/** Layar Backup & Restore (PRD §34-35, fase 5). */
export default function BackupRestoreScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [backups, setBackups] = useState<BackupFileInfo[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [creatingBackup, setCreatingBackup] = useState(false);
  const [backupStage, setBackupStage] = useState<BackupProgressStage | null>(null);

  const [kandidat, setKandidat] = useState<KandidatRestore | null>(null);
  const [validating, setValidating] = useState(false);
  const [validasi, setValidasi] = useState<HasilValidasiBackup | null>(null);
  const [restoring, setRestoring] = useState(false);
  // RC-S114 — kode pemulihan & jalur buka kunci berkas dari perangkat lain.
  const [kodePemulihan, setKodePemulihan] = useState<string | null>(null);
  const [kodeTampil, setKodeTampil] = useState(false);
  const [kodeMasukan, setKodeMasukan] = useState('');
  const [perluKode, setPerluKode] = useState(false);
  const [kodeSalah, setKodeSalah] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const rows = await listBackups();
      setBackups(rows);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Gagal memuat riwayat backup.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  const buatBackup = async () => {
    if (!currentUser) return;
    setCreatingBackup(true);
    try {
      await createBackup(currentUser.id, setBackupStage);
      await load();
      notify('Berhasil', 'Backup database berhasil dibuat.');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan saat membuat backup.');
    } finally {
      setCreatingBackup(false);
      setBackupStage(null);
    }
  };

  const bagikan = async (item: BackupFileInfo) => {
    try {
      await shareBackup(item.uri);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Tidak bisa membagikan file.');
    }
  };

  const hapus = (item: BackupFileInfo) => {
    notify('Hapus Backup', `Hapus file "${item.fileName}" dari riwayat? Tindakan ini tidak bisa dibatalkan.`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Hapus',
        style: 'destructive',
        onPress: async () => {
          await deleteBackup(item.fileName);
          await load();
        },
      },
    ]);
  };

  /**
   * RC-S114 — `butuhKode` dipakai saat berkas dibungkus kunci perangkat
   * LAIN (mis. dipindahkan dari ponsel lama). Kode pemulihan diminta
   * lebih dulu, bukan setelah gagal: pesan "gagal membuka kunci" tanpa
   * jalan keluar adalah cara tercepat membuat pengguna menyerah pada
   * pemulihan yang sebenarnya masih mungkin.
   */
  const mulaiValidasiRestore = async (uri: string, label: string, butuhKode = false) => {
    setKandidat({ uri, label });
    setValidasi(null);
    setPerluKode(butuhKode);
    setKodeMasukan('');
    if (butuhKode) return; // tunggu kode dimasukkan dulu
    await jalankanValidasi(uri);
  };

  const jalankanValidasi = async (uri: string, kode?: string) => {
    setValidating(true);
    try {
      const hasil = await validasiFileBackup(uri, kode ? { jenis: 'KODE_PEMULIHAN', kode } : undefined);
      setValidasi(hasil);
    } catch (e) {
      setValidasi({ valid: false, errors: [e instanceof Error ? e.message : 'Gagal memvalidasi file.'] });
    } finally {
      setValidating(false);
    }
  };

  /**
   * Kode yang jelas belum lengkap TIDAK dikirim ke scrypt: menjalankan
   * turunan kunci 32 MiB selama beberapa detik untuk kode yang sudah
   * pasti salah hanya membuat pengguna menunggu kegagalan.
   */
  const kodeSiap = periksaKodePemulihan(kodeMasukan) === 'SAH';

  const kirimKodePemulihan = async () => {
    const periksa = periksaKodePemulihan(kodeMasukan);
    if (periksa !== 'SAH') {
      // Ditampilkan DI SAMPING kotaknya, bukan sebagai pemberitahuan
      // melayang: kesalahannya tentang apa yang baru saja diketik.
      setKodeSalah(PESAN_PERIKSA_KODE[periksa]);
      return;
    }
    if (!kandidat) return;
    setKodeSalah(null);
    setPerluKode(false);
    await jalankanValidasi(kandidat.uri, kodeMasukan);
  };

  const enkripsiUlang = async (item: BackupFileInfo) => {
    if (!currentUser) return;
    try {
      await enkripsiUlangBackupLama(item.fileName, currentUser.id);
      notify('Berhasil', `Backup "${item.fileName}" sekarang terenkripsi.`);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Tidak bisa mengenkripsi ulang berkas ini.');
    }
  };

  const imporFileLain = async () => {
    try {
      const berkas = await pilihFileBackupEksternal();
      if (!berkas) return; // user membatalkan
      await mulaiValidasiRestore(berkas.uri, berkas.nama);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Tidak bisa membuka file.');
    }
  };

  const tutupModal = () => {
    setKandidat(null);
    setValidasi(null);
    setPerluKode(false);
    setKodeMasukan('');
    setKodeSalah(null);
  };

  const konfirmasiRestore = async () => {
    if (!kandidat || !currentUser) return;
    setRestoring(true);
    try {
      await restoreBackup(
        kandidat.uri,
        currentUser.id,
        kodeMasukan ? { jenis: 'KODE_PEMULIHAN', kode: kodeMasukan } : undefined
      );
      tutupModal();
      notify(
        'Restore Berhasil',
        'Database berhasil dipulihkan. Anda akan diminta login ulang untuk memuat data yang baru.'
      );
      // App.tsx akan otomatis pindah ke layar Login lewat restoreSignal —
      // tidak perlu navigasi manual dari sini.
    } catch (e) {
      notify('Gagal Restore', e instanceof Error ? e.message : 'Terjadi kesalahan saat memulihkan database.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
    <View style={{ flex: 1 }}>
      <FlatList
        {...PROP_SCROLL_FORM}
        style={styles.container}
        contentContainerStyle={{ padding: 16 }}
        data={backups}
        keyExtractor={(item) => item.fileName}
        ListHeaderComponent={
          <>
            <Text style={styles.hint}>
              Backup mencakup seluruh data koperasi: anggota, simpanan, pinjaman, jurnal, SHU, dan
              konfigurasi. Berkasnya dienkripsi dan disimpan di penyimpanan privat aplikasi.
            </Text>

            {/* KODE PEMULIHAN — ditaruh PALING ATAS dengan sengaja.
                Kunci perangkat tersimpan di AndroidKeyStore dan tidak
                dapat diekspor: ia tidak ikut pindah ke ponsel baru,
                tidak ikut cadangan cloud, dan hilang saat aplikasi
                di-uninstall. Kode ini satu-satunya jalan pulang saat
                perangkat hilang — dan ia tidak berguna kalau baru
                dicari setelah perangkatnya hilang. */}
            <View style={styles.kartuKode}>
              <View style={styles.kodeBaris}>
                <Ionicons name="key-outline" size={16} color={colors.warning} />
                <Text style={styles.kodeJudul}>Kode Pemulihan</Text>
              </View>
              <Text style={styles.kodeTeks}>
                Catat atau cetak kode ini dan simpan terpisah dari ponsel. Tanpa kode ini, backup TIDAK
                dapat dipulihkan bila ponsel hilang, rusak, atau diganti.
              </Text>
              {kodeTampil && kodePemulihan ? (
                <Text style={styles.kodeNilai} selectable>
                  {kodePemulihan}
                </Text>
              ) : null}
              <TouchableOpacity
                style={styles.kodeTombol}
                onPress={async () => {
                  if (!kodeTampil) {
                    const kode = await pastikanKodePemulihan();
                    setKodePemulihan(kode);
                  }
                  setKodeTampil((v) => !v);
                }}
                accessibilityRole="button"
              >
                <Ionicons name={kodeTampil ? 'eye-off-outline' : 'eye-outline'} size={14} color={colors.primary} />
                <Text style={styles.kodeTombolText}>{kodeTampil ? 'Sembunyikan' : 'Tampilkan Kode Pemulihan'}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.primaryButton} onPress={buatBackup} disabled={creatingBackup}>
              {creatingBackup ? (
                <View style={styles.progressRow}>
                  <ActivityIndicator color={colors.white} />
                  <Text style={styles.primaryButtonText}>
                    {backupStage ? STAGE_LABEL[backupStage] : 'Memproses…'}
                  </Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>Buat Backup Sekarang</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={imporFileLain}>
              <Text style={styles.secondaryButtonText}>Impor File Backup Lain…</Text>
            </TouchableOpacity>

            <Text style={styles.sectionLabel}>Riwayat Backup</Text>

            {loadingList && <ActivityIndicator style={{ marginVertical: 16 }} />}
            {!loadingList && listError && <Text style={styles.errorText}>{listError}</Text>}
            {!loadingList && !listError && backups.length === 0 && (
              <Text style={styles.emptyText}>Belum ada backup. Tekan "Buat Backup Sekarang" di atas.</Text>
            )}
          </>
        }
        renderItem={({ item }) => (
          <View style={styles.backupRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.backupNama}>{item.fileName}</Text>
              <Text style={styles.backupSub}>
                {new Date(item.createdAt).toLocaleString('id-ID')} · {formatUkuranFile(item.sizeBytes)}
              </Text>
              {/* Status ditampilkan apa adanya, tidak disembunyikan:
                  pengguna berhak tahu berkas mana yang masih terbuka. */}
              {item.terenkripsi ? (
                <View style={styles.tandaBaris}>
                  <Ionicons name="lock-closed" size={11} color={colors.success} />
                  <Text style={styles.tandaAman}>
                    Terenkripsi{item.butuhKodePemulihan ? ' · dari perangkat lain' : ''}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity style={styles.tandaBaris} onPress={() => enkripsiUlang(item)} accessibilityRole="button">
                  <Ionicons name="lock-open-outline" size={11} color={colors.warning} />
                  <Text style={styles.tandaLama}>Belum terenkripsi — ketuk untuk mengenkripsi</Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity style={styles.iconButton} onPress={() => bagikan(item)}>
              <Text style={styles.iconButtonText}>Bagikan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconButton, styles.restoreButton]}
              onPress={() => mulaiValidasiRestore(item.uri, item.fileName, item.butuhKodePemulihan)}
            >
              <Text style={styles.restoreButtonText}>Pulihkan</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton} onPress={() => hapus(item)}>
              <Text style={styles.deleteButtonText}>Hapus</Text>
            </TouchableOpacity>
          </View>
        )}
      />

      <Modal visible={!!kandidat} transparent animationType="fade" onRequestClose={tutupModal}>
        <AreaAmanKeyboard varian="dialog" style={styles.areaKeyboard}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {/* RC-S120 — isi dialog ini bertambah panjang menurut keadaan
                (kotak Kode Pemulihan, daftar galat, ringkasan backup).
                Tanpa ScrollView, di layar kecil tombol Pulihkan/Batal
                terdorong ke belakang papan ketik saat Kode Pemulihan
                diketik, dan tidak dapat digulir. */}
            <ScrollView {...PROP_SCROLL_FORM}>
            {/* Kepala dialog: ikon + judul + nama berkas, bukan dua
                baris teks yang mengambang. */}
            <View style={styles.dialogKepala}>
              <View style={styles.dialogIkon}>
                <Ionicons name="cloud-download-outline" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.modalTitle}>Pulihkan Database</Text>
                <Text style={styles.modalFileName} numberOfLines={2}>
                  {kandidat?.label}
                </Text>
              </View>
            </View>

            {validating && (
              <View style={styles.modalLoadingRow}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.modalLoadingText}>Memeriksa berkas backup…</Text>
              </View>
            )}

            {/* ============================================================
                KOTAK KODE PEMULIHAN
                ============================================================
                Muncul di DUA keadaan:
                  1. berkas sudah diketahui milik perangkat lain sejak
                     sebelum diperiksa (dari daftar backup), dan
                  2. pemeriksaan gagal membuka dengan kunci perangkat
                     (`butuhKodePemulihan`) — termasuk berkas yang dipilih
                     dari luar aplikasi lewat "Impor File Backup Lain".

                Keadaan kedua inilah yang sebelumnya menjadi JALAN BUNTU:
                pesannya menyuruh memakai Kode Pemulihan, tetapi tidak ada
                tempat mengisinya dan satu-satunya tombol adalah "Batal". */}
            {!validating && (perluKode || validasi?.butuhKodePemulihan) && (
              <View style={styles.kotakKode}>
                <View style={styles.kotakKodeKepala}>
                  <Ionicons name="key" size={15} color={colors.warning} />
                  <Text style={styles.kotakKodeJudul}>Perlu Kode Pemulihan</Text>
                </View>
                <Text style={styles.kotakKodeTeks}>
                  {validasi?.errors?.[0] ??
                    'Backup ini dibuat di perangkat lain, jadi kunci perangkat ini tidak cocok.'}{' '}
                  Masukkan Kode Pemulihan yang dicatat saat backup dibuat.
                </Text>
                <FocusTextInput
                  style={styles.kodeInput}
                  value={kodeMasukan}
                  onChangeText={(teks) => {
                    // Dirapikan sambil diketik: huruf besar, huruf yang
                    // mudah tertukar dibetulkan, tanda hubung tiap empat
                    // karakter. Yang disalin dari kertas jadi cocok apa
                    // adanya, tanpa pengguna harus menebak formatnya.
                    setKodeMasukan(formatKodePemulihan(rapikanKodePemulihan(teks).slice(0, PANJANG_KODE_PENUH)));
                    setKodeSalah(null);
                  }}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-X"
                  placeholderTextColor={colors.placeholder}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  accessibilityLabel="Kode Pemulihan"
                  invalid={!!kodeSalah}
                />
                {kodeSalah && <FieldError message={kodeSalah} />}
                <TouchableOpacity
                  style={[styles.tombolKode, !kodeSiap && styles.disabled]}
                  onPress={kirimKodePemulihan}
                  disabled={!kodeSiap}
                  accessibilityRole="button"
                >
                  <Ionicons name="lock-open-outline" size={15} color={colors.white} />
                  <Text style={styles.tombolKodeText}>Buka dengan Kode Pemulihan</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Kegagalan yang BUKAN soal kunci — berkas rusak, bukan
                backup aplikasi ini, jurnal tidak balance. Tidak ada yang
                bisa diperbaiki pengguna di sini, jadi tidak ada isian. */}
            {!validating && validasi && !validasi.valid && !validasi.butuhKodePemulihan && (
              <View style={styles.validasiGagal}>
                <View style={styles.kotakKodeKepala}>
                  <Ionicons name="close-circle" size={15} color={colors.danger} accessibilityLabel="Tidak valid" />
                  <Text style={styles.validasiGagalTitle}>Berkas tidak dapat dipulihkan</Text>
                </View>
                {validasi.errors.map((err, idx) => (
                  <Text key={idx} style={styles.validasiGagalItem}>
                    • {err}
                  </Text>
                ))}
              </View>
            )}

            {!validating && validasi?.valid && validasi.ringkasan && (
              <View style={styles.validasiOk}>
                {/* UI/UX FINAL POLISH (§18) — glyph '\u2713' diganti Ionicons
                    berlabel aksesibilitas; teksnya tetap sama, jadi
                    informasinya tidak hanya bergantung pada ikon. */}
                <View style={styles.validasiOkTitleRow}>
                  <Ionicons
                    name="checkmark-circle"
                    size={iconSize.sm}
                    color={colors.primary}
                    accessibilityLabel="Valid"
                  />
                  <Text style={styles.validasiOkTitle}>Berkas backup valid</Text>
                </View>
                <View style={styles.ringkasBaris}>
                  <Text style={styles.ringkasLabel}>Koperasi</Text>
                  <Text style={styles.ringkasNilai} numberOfLines={1}>
                    {validasi.ringkasan.namaKoperasi ?? '-'}
                  </Text>
                </View>
                <View style={styles.ringkasBaris}>
                  <Text style={styles.ringkasLabel}>Jumlah anggota</Text>
                  <Text style={styles.ringkasNilai}>{validasi.ringkasan.jumlahAnggota}</Text>
                </View>
                <View style={styles.ringkasBaris}>
                  <Text style={styles.ringkasLabel}>Jumlah jurnal</Text>
                  <Text style={styles.ringkasNilai}>{validasi.ringkasan.jumlahJurnal}</Text>
                </View>
                <View style={styles.ringkasBaris}>
                  <Text style={styles.ringkasLabel}>Jurnal terakhir</Text>
                  <Text style={styles.ringkasNilai}>{validasi.ringkasan.tanggalJurnalTerakhir ?? '-'}</Text>
                </View>
                <Text style={styles.warnText}>
                  Data koperasi SAAT INI akan digantikan dengan data di atas. Backup otomatis dari
                  data sekarang dibuat lebih dulu sebagai jaring pengaman. Setelah selesai, Anda akan
                  diminta login ulang.
                </Text>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={tutupModal} disabled={restoring}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              {validasi?.valid && (
                <TouchableOpacity style={styles.modalConfirm} onPress={konfirmasiRestore} disabled={restoring}>
                  {restoring ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalConfirmText}>Pulihkan</Text>}
                </TouchableOpacity>
              )}
            </View>
            </ScrollView>
          </View>
        </View>
        </AreaAmanKeyboard>
      </Modal>
    </View>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  dialogKepala: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  dialogIkon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kotakKode: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: 12,
    marginBottom: 12,
  },
  kotakKodeKepala: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kotakKodeJudul: { fontSize: 13, fontWeight: '800', color: colors.text },
  kotakKodeTeks: { fontSize: 11.5, color: colors.text, lineHeight: 17, marginTop: 6 },
  tombolKode: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    marginTop: 12,
  },
  tombolKodeText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  ringkasBaris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 3,
  },
  ringkasLabel: { fontSize: 12, color: colors.textMuted },
  ringkasNilai: { fontSize: 12.5, fontWeight: '700', color: colors.text, flexShrink: 1, textAlign: 'right' },
  disabled: { opacity: 0.5 },
  areaKeyboard: { flex: 1 },
  kartuKode: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: 14,
    marginBottom: 16,
  },
  kodeBaris: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kodeJudul: { fontSize: 13, fontWeight: '800', color: colors.text },
  kodeTeks: { fontSize: 11.5, color: colors.text, lineHeight: 17, marginTop: 6 },
  kodeNilai: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: 1.5,
    marginTop: 10,
    fontVariant: ['tabular-nums'],
  },
  kodeTombol: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 },
  kodeTombolText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  tandaBaris: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  tandaAman: { fontSize: 10.5, color: colors.success, fontWeight: '700' },
  tandaLama: { fontSize: 10.5, color: colors.warning, fontWeight: '700' },
  kodeInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    letterSpacing: 1.2,
    color: colors.text,
    marginTop: 10,
  },

  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 4, marginBottom: spacing.lg, lineHeight: 18 },
  primaryButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginBottom: 10 },
  primaryButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryButton: { borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.primary, marginBottom: spacing.xl },
  secondaryButtonText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  sectionLabel: { fontSize: 14, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  errorText: { color: colors.danger, textAlign: 'center', marginVertical: spacing.lg },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginVertical: spacing.lg },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 6,
  },
  backupNama: { fontSize: 12, fontWeight: '600', color: colors.text },
  backupSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  iconButton: { paddingHorizontal: 8, paddingVertical: 6 },
  iconButtonText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  restoreButton: { backgroundColor: '#E8F5E9', borderRadius: 6 },
  restoreButtonText: { fontSize: 11, color: colors.primary, fontWeight: '700' },
  deleteButtonText: { fontSize: 11, color: colors.danger, fontWeight: '600' },
  modalOverlay: { ...modalUi.backdrop, justifyContent: 'center', padding: spacing.xl },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalFileName: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  modalLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  modalLoadingText: { fontSize: 13, color: colors.textMuted },
  validasiGagal: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  validasiGagalTitle: { fontSize: 13, fontWeight: '700', color: colors.danger, marginBottom: 4 },
  validasiGagalItem: { fontSize: 12, color: colors.danger, marginTop: 2 },
  validasiOk: { backgroundColor: '#E8F5E9', borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  validasiOkTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  validasiOkTitle: { fontSize: 13, fontWeight: '700', color: colors.primary, flexShrink: 1, minWidth: 0 },
  validasiOkItem: { fontSize: 12, color: colors.text, marginTop: 2 },
  warnText: { fontSize: 11, color: colors.danger, marginTop: 10, lineHeight: 16 },
  modalActions: { ...modalUi.actions, marginTop: 4 },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { ...modalUi.secondaryText },
  modalConfirm: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.sm },
  modalConfirmText: { color: colors.white, fontWeight: '700' },
});
