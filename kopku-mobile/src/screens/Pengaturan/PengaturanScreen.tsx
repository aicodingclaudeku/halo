import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { usePermission } from '@/hooks/usePermission';
import { Resource, ROLE_LABEL } from '@/config/defaultPermissions';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { logout } from '@/services/AuthService';
import { IKON_ROLE } from './ikonRole';
import type { PermissionAction } from '@/security/permissions';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';

/**
 * Menu Pengaturan (PRD §4-6, §31-32, §34-35, §41). Backup & Restore
 * selesai di fase 5; User Management & Permission Matrix selesai di
 * fase 8 — keduanya HANYA tampil jika role user punya izin (fase 8 §5:
 * "proteksi halaman berdasarkan permission"). Menyembunyikan menu ini
 * TIDAK cukup sendirian — setiap aksi di baliknya juga di-cek ulang di
 * service (lihat UserManagementService.ts/PermissionService.ts, §10).
 */
const MENU: {
  route: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  resource: Resource;
  /**
   * RC-S99 — level izin yang diperiksa untuk MENAMPILKAN entri ini.
   * Default 'view'. Diisi eksplisit untuk entri yang berbahaya, supaya
   * entri semacam "Reset Data" tidak ikut muncul hanya karena sebuah
   * role boleh MELIHAT modul backup.
   */
  aksi?: PermissionAction;
  /**
   * RC-S99 — entri ini dirender di bagian "Zona Berbahaya" di bawah,
   * bukan di daftar menu biasa: warna merah, ikon peringatan, dan
   * terpisah jarak dari menu lain supaya tidak bersebelahan dengan
   * tujuan yang sering ditekan.
   */
  danger?: boolean;
  /** §Q — hanya diisi bila memang dibutuhkan selector test. */
  testID?: string;
}[] = [
  /**
   * RC-S49b §B1 — ENTRI "IDENTITAS KOPERASI" DIHAPUS DARI SINI.
   *
   * RC-S48 menambahkannya karena saat itu rutenya memang hidup di
   * `PengaturanStack` dan tidak punya pintu masuk selain kartu
   * Dashboard. RC-S49b memindahkan rutenya ke `RootStack` sebagai
   * destination independen (lihat RootNavigator.tsx), sehingga
   * Identitas Koperasi BUKAN lagi submenu Pengaturan — pintu masuknya
   * adalah kartu di Dashboard, sesuai UX yang diminta:
   *
   *     Dashboard   : Identitas Koperasi, Statistik, Lisensi
   *     Pengaturan  : Backup & Restore, User Management,
   *                   Permission Matrix
   *
   * Kebijakan Penarikan Dini TIDAK lagi di sini: Pengaturan hanya untuk
   * konfigurasi aplikasi, sedangkan seluruh workflow penarikan/pencairan
   * simpanan (termasuk kebijakannya) berpusat di Tarik Simpanan Anggota.
   *
   * Yang dihapus HANYA entri menu ini. Layar, service, permission
   * matrix (`resource: 'pengaturan'` tidak diubah), dan data identitas
   * tidak disentuh sama sekali.
   */
  { route: 'BackupRestore', icon: 'cloud-upload-outline', title: 'Backup & Restore', sub: 'Cadangkan database, pulihkan dari backup', resource: 'backup' },
  /**
   * SINKRON HP ⇄ DESKTOP — pemasangan lewat QR & sinkron dua arah di
   * Wi-Fi lokal/hotspot. `resource: 'backup'` karena setara operasi data
   * massal (dapat mengganti seluruh database saat memilih buku induk).
   */
  { route: 'SinkronPerangkat', icon: 'sync-outline', title: Platform.OS === 'web' ? 'Sinkron HP' : 'Sinkron Desktop', sub: 'Hubungkan lewat QR, lalu kirim data HP ⇄ komputer', resource: 'backup' },
  /**
   * RC-S96 — IMPORT DATA AWAL (Excel).
   *
   * Ditempatkan TEPAT SETELAH Backup & Restore karena keduanya urusan
   * "memasukkan/mengeluarkan data dalam jumlah besar", dan karena
   * langkah yang disarankan sebelum import adalah membuat backup.
   * `resource: 'backup'` dipakai ULANG dengan sengaja: import adalah
   * operasi data massal seperti restore, jadi kewenangannya memang
   * setara — dan TIDAK ADA resource baru yang perlu ditambahkan ke
   * permission matrix. Pemeriksaan izin per domain (anggota/simpanan/
   * pinjaman) tetap dilakukan service masing-masing saat baris diproses.
   */
  { route: 'ImportDataAwal', icon: 'documents-outline', title: 'Import Data Awal', sub: 'Anggota, simpanan, pinjaman dari Excel', resource: 'backup' },
  { route: 'UserManagement', icon: 'people-outline', title: 'User Management', sub: 'Kelola user, role, dan status aktif', resource: 'user_management' },
  { route: 'PermissionMatrix', icon: 'shield-checkmark-outline', title: 'Permission Matrix', sub: 'Atur izin akses tiap role', resource: 'user_management' },
  /**
   * RC-S99 — RESET DATA (permintaan pengguna: "tombol reset data yang
   * memiliki beberapa kali konfirmasi agar tidak tertekan tidak
   * sengaja").
   *
   * `resource: 'backup'` dengan `aksi: 'approve'` — level yang SAMA
   * dengan `restoreBackup`, tindakan paling berisiko yang sudah ada di
   * aplikasi ini, dan level tertinggi pada matrix. Tidak ada resource
   * baru yang ditambahkan ke permission matrix: reset adalah operasi
   * database menyeluruh seperti restore, jadi kewenangannya memang
   * setara.
   *
   * Izin ini BUKAN satu-satunya penjaga — `ResetDataService`
   * meng-hardcode ADMIN-only (pertahanan berlapis, pola yang sama
   * dengan UserManagementService), dan layarnya sendiri menolak role
   * non-Admin. Entrinya sengaja TIDAK disembunyikan: yang melindungi
   * adalah enam lapis konfirmasi di dalam layar, bukan pintu yang
   * susah ditemukan.
   */
  {
    route: 'ResetData',
    icon: 'trash-outline',
    title: 'Reset Data',
    sub: 'Hapus data transaksi atau reset total — berlapis konfirmasi',
    resource: 'backup',
    aksi: 'approve',
    danger: true,
    testID: 'menu-reset-data',
  },
];

export default function PengaturanScreen() {
  const navigation = useNavigation<any>();
  const { can } = usePermission();
  // RC-S99 — entri `danger` dikeluarkan dari daftar menu biasa dan
  // dirender terpisah di "Zona Berbahaya" (lihat bawah). Level izinnya
  // dibaca dari `item.aksi`, default 'view' seperti sebelumnya.
  const bolehLihat = (item: (typeof MENU)[number]) => can(item.resource, item.aksi ?? 'view');
  const menuTampil = MENU.filter((item) => !item.danger && bolehLihat(item));
  const menuBerbahaya = MENU.filter((item) => item.danger && bolehLihat(item));
  const currentUser = useAppStore((s) => s.currentUser);
  const [keluarBerjalan, setKeluarBerjalan] = useState(false);

  /**
   * RC-S132 — KELUAR. Sesi dihapus (AuthService.logout: sesi, pemverifikasi
   * PIN cepat, penanda "keluar manual"), cache user & izin di store
   * dikosongkan, lalu app/index.tsx mengevaluasi ulang fase -> layar LOGIN,
   * tempat user lain dari User Management dapat masuk dengan akunnya.
   */
  const keluar = () => {
    notify(
      'Keluar dari akun?',
      'Anda perlu masuk lagi dengan username dan password. Data koperasi tidak terpengaruh.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Keluar',
          style: 'destructive',
          onPress: async () => {
            setKeluarBerjalan(true);
            try {
              await logout();
            } finally {
              const toko = useAppStore.getState();
              toko.setPermissions(null);
              toko.setCurrentUser(null);
              toko.triggerRestoreReload();
            }
          },
        },
      ],
      'warning'
    );
  };

  return (
    // RC-S121 — PinInput dipindah ke KeamananScreen (yang kini dibungkus
    // AreaAmanKeyboard, sensus RC-S120). Layar ini tinggal daftar menu
    // tanpa input, jadi memakai ScrollView biasa seperti hub menu lain.
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      {/* RC-S132 — kartu akun: siapa yang sedang masuk & perannya. */}
      {currentUser ? (
        <View style={styles.akunKartu}>
          <View style={styles.akunAvatar}>
            <Text style={styles.akunInisial}>{inisialNama(currentUser.nama)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.akunNama} numberOfLines={1}>
              {currentUser.nama}
            </Text>
            <View style={styles.akunRole}>
              <Ionicons name={IKON_ROLE[currentUser.role] as keyof typeof Ionicons.glyphMap} size={12} color={colors.primaryDark} />
              <Text style={styles.akunRoleTeks}>{ROLE_LABEL[currentUser.role]}</Text>
            </View>
          </View>
          <Ionicons name="shield-checkmark" size={iconSize.md} color={colors.primary} />
        </View>
      ) : null}

      {/*
        RC-S121 — KEAMANAN. "Gunakan PIN" & "Login dengan Biometric"
        DIPINDAH ke layar tersendiri (KeamananScreen, rute `Keamanan`).
        Seperti sebelumnya ia TIDAK digerbangi permission role (kunci
        aplikasi milik user yang sedang login), jadi kartunya di luar
        array MENU / `can()` — pola yang sama dengan Lisensi & Developer.
      */}
      <TouchableOpacity
        testID="menu-keamanan"
        accessibilityRole="button"
        style={styles.menuCard}
        onPress={() => navigation.navigate('Keamanan')}
      >
        <View style={styles.iconCircle}>
          <Ionicons name="lock-closed-outline" size={menuIconSize} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Keamanan</Text>
          <Text style={styles.cardSub}>PIN kunci aplikasi dan login biometric</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>

      {/*
        LISENSI — dibuka lewat expo-router (`/license`), BUKAN lewat
        `navigation.navigate()` seperti menu di bawahnya.
        Alasannya: layar lisensi hidup di pohon Expo Router, di belakang
        LicenseGate — bukan di dalam RootNavigator React Navigation.
        Menempatkannya di RootNavigator akan menaruh layar keamanan di
        dalam area yang justru baru boleh dibuka SETELAH lisensi sah.
      */}
      <TouchableOpacity accessibilityRole="button" style={styles.menuCard} onPress={() => router.push('/license')}>
        <View style={styles.iconCircle}>
          <Ionicons name="key-outline" size={menuIconSize} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Lisensi</Text>
          {/* RC-S48b — WORDING SAJA.

              "nonaktifkan perangkat" dihapus karena pengguna aplikasi
              memang tidak punya kewenangan itu: deaktivasi perangkat
              dilakukan penerbit/admin lisensi, bukan dari sini.
              Menyebutnya di subtitle menjanjikan aksi yang tidak akan
              ditemukan pengguna setelah menu dibuka.

              LicenseService, layar lisensi, permission, route, dan
              lifecycle lisensi TIDAK disentuh. */}
          <Text style={styles.cardSub}>Status lisensi dan verifikasi ulang</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>

      {menuTampil.map((item) => (
        <TouchableOpacity
          key={item.route}
          testID={item.testID}
          accessibilityRole="button" style={styles.menuCard}
          onPress={() => navigation.navigate(item.route)}
        >
          <View style={styles.iconCircle}>
            <Ionicons name={item.icon} size={menuIconSize} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.cardSub}>{item.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
        </TouchableOpacity>
      ))}
      {menuTampil.length === 0 && (
        <Text style={styles.emptyText}>Menu pengaturan lain disembunyikan sesuai izin role Anda.</Text>
      )}

      {/*
        DEVELOPER — dikunci password (lihat DeveloperScreen.tsx), BUKAN
        permission role, jadi SENGAJA di luar `menuTampil`/`can()` seperti
        halnya kartu Lisensi di atas: siapa pun bisa melihat kartunya,
        tapi isinya baru terbuka setelah password developer benar.
      */}
      <TouchableOpacity accessibilityRole="button" style={styles.menuCard} onPress={() => navigation.navigate('Developer')}>
        <View style={styles.iconCircle}>
          <Ionicons name="hardware-chip-outline" size={menuIconSize} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.devTitleRow}>
            <Text style={styles.cardTitle}>Developer</Text>
            <View style={styles.devBadge}>
              <Text style={styles.devBadgeText}>PENGUJIAN</Text>
            </View>
          </View>
          <Text style={styles.cardSub}>Mode pengujian waktu (dikunci password)</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>

      {/* RC-S132 — KELUAR. Terpisah dari menu supaya tidak tertekan saat menelusuri. */}
      <TouchableOpacity
        testID="tombol-keluar"
        accessibilityRole="button"
        accessibilityLabel="Keluar dari akun"
        style={styles.tombolKeluar}
        onPress={keluar}
        disabled={keluarBerjalan}
      >
        {keluarBerjalan ? (
          <ActivityIndicator color={colors.danger} />
        ) : (
          <>
            <Ionicons name="log-out-outline" size={iconSize.md} color={colors.danger} />
            <Text style={styles.tombolKeluarTeks}>Keluar</Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.keluarCatatan}>Keluar untuk berganti akun. Masuk kembali dengan username dan password.</Text>

      {/*
        RC-S99 — ZONA BERBAHAYA.

        Entri yang menghapus data dipisah ke bagian sendiri di PALING
        BAWAH, dengan label, warna merah, dan jarak dari menu lain.
        Tujuannya satu: jari yang sedang menelusuri menu sehari-hari
        tidak pernah berada di sebelah tombol yang menghapus data
        koperasi. Perlindungan sesungguhnya tetap ada di dalam layarnya
        (enam lapis konfirmasi), bagian ini hanya menjauhkan pintunya
        dari jalur yang sering dilewati.
      */}
      {menuBerbahaya.length > 0 && (
        <View style={styles.zonaBahaya}>
          <Text style={styles.zonaBahayaLabel}>Zona Berbahaya</Text>
          {menuBerbahaya.map((item) => (
            <TouchableOpacity
              key={item.route}
              testID={item.testID}
              accessibilityRole="button"
              style={[styles.menuCard, styles.menuCardBahaya]}
              onPress={() => navigation.navigate(item.route)}
            >
              <View style={styles.iconCircleBahaya}>
                <Ionicons name={item.icon} size={menuIconSize} color={colors.danger} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: colors.danger }]}>{item.title}</Text>
                <Text style={styles.cardSub}>{item.sub}</Text>
              </View>
              <Ionicons name="chevron-forward" size={iconSize.md} color={colors.danger} style={ui.chevron} />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function inisialNama(nama: string): string {
  const kata = nama.trim().split(/\s+/).filter(Boolean);
  if (kata.length === 0) return '?';
  return (kata[0][0] + (kata.length > 1 ? kata[kata.length - 1][0] : kata[0][1] ?? '')).toUpperCase();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  akunKartu: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  akunAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  akunInisial: { color: colors.white, fontWeight: '800', fontSize: 16 },
  akunNama: { fontSize: 16, fontWeight: '800', color: colors.text },
  akunRole: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 4,
  },
  akunRoleTeks: { fontSize: 11, fontWeight: '700', color: colors.primaryDark },
  tombolKeluar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
    marginTop: spacing.lg,
  },
  tombolKeluarTeks: { color: colors.danger, fontWeight: '800', fontSize: 15 },
  keluarCatatan: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
  devTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  devBadge: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  devBadgeText: { fontSize: 9, fontWeight: '800', color: colors.warning, letterSpacing: 0.5 },
  menuCard: { ...ui.menuCard },
  // RC-S99 — Zona Berbahaya: terpisah jarak & garis dari menu biasa.
  zonaBahaya: { marginTop: spacing.xl, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
  zonaBahayaLabel: {
    ...ui.sectionLabel,
    color: colors.danger,
  },
  menuCardBahaya: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  iconCircleBahaya: { ...ui.menuIcon, backgroundColor: colors.white },
  iconCircle: { ...ui.menuIcon },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
  sectionLabel: { ...ui.sectionLabel },
  emptyText: { color: colors.textMuted, textAlign: 'center', fontSize: 12, marginTop: 2, marginBottom: spacing.md },
});
