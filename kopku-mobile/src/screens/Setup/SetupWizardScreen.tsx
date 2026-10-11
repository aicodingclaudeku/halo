import React, { useState } from 'react';
import TombolHubungkanHpSetup from '@/desktop/TombolHubungkanHpSetup';
import { tandaiPanduanAwalPerluTampil } from '@/services/PanduanService';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { notify } from '@/store/useNotifyStore';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Ionicons } from '@expo/vector-icons';
import { setupKoperasi } from '@/services/SetupService';
import {
  activateLicense,
  getLicenseStatus,
  isValidLicenseKeyFormat,
  normalizeLicenseKey,
} from '@/services/LicenseService';
import { useAppStore } from '@/store/useAppStore';
import LicenseDiagnosticScreen from '@/screens/License/LicenseDiagnosticScreen';
import { colors, iconSize, radius, spacing, touchTarget, typography } from '@/theme/colors';
import { formUi, type InputTypeName } from '@/theme/form';
import AppTextInput from '@/components/AppTextInput';
import { getWaktuSekarang } from '@/services/DevClockService';
import {
  periksaPassword,
  rapikanPassword,
  kekuatanPassword,
  LABEL_KEKUATAN,
  PANJANG_MIN_PASSWORD,
  type TingkatKekuatan,
} from '@/security/kebijakanPassword';
import { periksaUsername, rapikanUsername } from '@/security/kebijakanUsername';

/**
 * ============================================================
 * SETUP AWAL — MINIMAL (§8, §11, §12, §13 permintaan pengguna)
 * ============================================================
 *
 * Wizard ini berjalan DUA LANGKAH:
 *
 *   Langkah 1 — Koperasi : Nama Koperasi, Tahun Buku, License Key
 *   Langkah 2 — Administrator : Nama, Username, Password, Konfirmasi
 *
 * ------------------------------------------------------------
 * KENAPA LANGKAH 2 ADA (RC-S119)
 * ------------------------------------------------------------
 * Sebelumnya wizard hanya meminta tiga isian langkah 1, dan akun admin
 * dibuat diam-diam dengan username "admin" serta kolom password yang
 * MENCERMIN hash PIN. Pada jalur setup minimal PIN itu sendiri acak dan
 * memang dibuat agar tidak dapat dipakai — sehingga admin pertama tidak
 * punya password yang bisa diketik sama sekali.
 *
 * Selama sesi terbuka sendiri, hal itu tidak terlihat. Tetapi begitu
 * pengguna menyalakan PIN di Pengaturan lalu menekan "Keluar" di layar
 * kunci, aplikasi meminta password yang tidak pernah ada, dan tidak ada
 * jalan kembali selain memasang ulang. Meminta username dan password
 * sejak awal menutup jalan buntu itu, sekaligus membuat pemiliknya tahu
 * kredensial koperasinya sendiri.
 *
 * Dipisah menjadi langkah sendiri, bukan ditumpuk jadi tujuh isian dalam
 * satu layar: kedua kelompok menjawab pertanyaan yang berbeda ("koperasi
 * ini apa" vs "siapa yang memegangnya"), dan tujuh isian sekaligus pada
 * layar pertama sebuah aplikasi adalah cara tercepat membuat orang
 * berhenti sebelum mulai.
 *
 * ------------------------------------------------------------
 * KENAPA LICENSE KEY ADA DI SINI, BUKAN DI LAYAR TERPISAH
 * ------------------------------------------------------------
 * Aktivasi ke server membutuhkan `cooperative_name`. Kalau lisensi
 * diminta di layar sendiri SEBELUM wizard, nama koperasi harus
 * ditanyakan dua kali di dua layar berbeda — dan keduanya bisa berbeda
 * isi, sehingga nama yang terdaftar di server tidak sama dengan nama di
 * database lokal. Menggabungkannya menghapus seluruh kelas masalah itu.
 *
 * Layar aktivasi terpisah TETAP ADA dan tetap dipakai untuk keadaan
 * setelah setup pernah selesai: NOT_ACTIVATED, DEVICE_MISMATCH,
 * INVALID, EXPIRED, NEEDS_VERIFICATION, REVOKED. Yang berubah hanya
 * jalur pemasangan pertama.
 *
 * YANG DIHAPUS dari wizard (beserta alasannya):
 *
 *  - "Standar Akuntansi" (§9). Pilihan SAK EP / SAK EMKM tidak lagi
 *    ditanyakan. Aplikasi memakai SAK EP secara otomatis lewat
 *    `STANDAR_AKUNTANSI_DEFAULT` (defaultCOA.ts). Ini BUKAN sekadar
 *    menyembunyikan dropdown: `SetupService.setupKoperasi()` menuliskan
 *    nilai default itu ke kolom `koperasi.standar_akuntansi` yang NOT
 *    NULL + CHECK, sehingga tidak ada konfigurasi kosong / standar
 *    undefined yang bisa lolos ke service mana pun. Seluruh pembaca
 *    lama (ACCOUNTING_POLICY, ReportTableBuilders, ExportService,
 *    AccountingPolicyService) tetap menerima nilai enum yang valid.
 *
 *  - Identitas lengkap: Nomor Badan Hukum, NPWP, Alamat, Telepon,
 *    Email (§8 "tidak boleh meminta identitas lengkap"). Semuanya
 *    dipindah ke Dashboard -> "Lengkapi Identitas Koperasi" (§19-§24).
 *    Kolomnya nullable di skema, jadi tidak ada yang rusak kalau kosong.
 *
 *  - Akun Admin + PIN + Konfirmasi PIN (§14 "PIN OPSIONAL. Jangan
 *    memaksa user membuat PIN pada first setup"). User admin tetap
 *    dibuat otomatis oleh SetupService (dibutuhkan sebagai `created_by`
 *    audit trail), tetapi app-lock PIN NONAKTIF secara default dan bisa
 *    dinyalakan kapan saja lewat Pengaturan -> Keamanan -> Gunakan PIN.
 *    Audit dependensi PIN ada di SecurityService.ts: PIN pada aplikasi
 *    ini murni app lock, BUKAN akar kunci enkripsi, jadi mematikannya
 *    tidak membuat data apa pun kehilangan proteksi.
 */

const schema = z.object({
  nama: z.string().trim().min(3, 'Nama koperasi minimal 3 karakter'),
  // §12: gunakan representasi tahun buku yang SUDAH dipakai source —
  // `koperasi.tahun_buku_aktif` INTEGER 4 digit, sama seperti wizard
  // lama. Tidak ada format baru yang dibuat.
  tahunBuku: z
    .string()
    .regex(/^\d{4}$/, 'Tahun buku harus 4 digit, contoh 2026')
    .transform((v) => parseInt(v, 10))
    .refine((v) => v >= 1900 && v <= 2200, 'Tahun buku tidak masuk akal'),
  // Divalidasi lewat `isValidLicenseKeyFormat()` milik LicenseService,
  // bukan dengan regex baru di sini. Menyalin pola ke tempat kedua
  // berarti dua definisi "kunci yang sah" yang cepat atau lambat akan
  // berbeda — dan yang lebih longgar yang akan dipakai.
  licenseKey: z
    .string()
    .trim()
    .min(1, 'License key wajib diisi')
    .refine((v) => isValidLicenseKeyFormat(normalizeLicenseKey(v)), 'Format license key tidak sesuai'),
});

type FormValues = z.input<typeof schema>;
type ParsedValues = z.output<typeof schema>;

/**
 * Skema langkah 2 memakai modul kebijakan yang SAMA dengan Manajemen
 * User dan dengan SetupService, bukan aturan baru yang ditulis ulang di
 * sini. Aturan password yang ditulis dua kali akan berbeda cepat atau
 * lambat, dan yang lebih longgar yang akan dipakai.
 */
const schemaAdmin = z
  .object({
    adminNama: z.string().trim().min(3, 'Nama admin minimal 3 karakter'),
    adminUsername: z.string(),
    adminPassword: z.string(),
    adminKonfirmasi: z.string(),
  })
  .superRefine((v, ctx) => {
    const u = periksaUsername(v.adminUsername);
    if (!u.sah) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['adminUsername'], message: u.pesan ?? 'Username tidak sah' });
    }
    const p = periksaPassword({
      password: v.adminPassword,
      konfirmasi: v.adminKonfirmasi,
      username: v.adminUsername,
    });
    if (!p.sah) {
      // Konfirmasi yang tidak cocok ditunjukkan DI KOTAK KONFIRMASI,
      // bukan di kotak password: yang perlu diperbaiki ada di sana.
      const diKonfirmasi = p.masalah.length === 1 && p.masalah[0] === 'KONFIRMASI_TIDAK_COCOK';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [diKonfirmasi ? 'adminKonfirmasi' : 'adminPassword'],
        message: p.pesan ?? 'Password tidak sah',
      });
    }
  });

type FormAdmin = z.infer<typeof schemaAdmin>;

type LangkahWizard = 'KOPERASI' | 'ADMIN';

export default function SetupWizardScreen({ onComplete }: { onComplete: () => void }) {
  const [langkah, setLangkah] = useState<LangkahWizard>('KOPERASI');
  const [submitting, setSubmitting] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [lihatPassword, setLihatPassword] = useState(false);
  const triggerLicenseRecheck = useAppStore((s) => s.triggerLicenseRecheck);
  const {
    control,
    getValues,
    trigger,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      tahunBuku: getWaktuSekarang().getFullYear().toString(),
      licenseKey: '',
    },
  });

  const {
    control: controlAdmin,
    handleSubmit: handleSubmitAdmin,
    watch: watchAdmin,
    formState: { errors: errorsAdmin },
  } = useForm<FormAdmin>({
    resolver: zodResolver(schemaAdmin),
    defaultValues: { adminNama: '', adminUsername: '', adminPassword: '', adminKonfirmasi: '' },
  });

  const passwordDiketik = watchAdmin('adminPassword') ?? '';
  const kekuatan: TingkatKekuatan | null = passwordDiketik.length > 0 ? kekuatanPassword(passwordDiketik) : null;

  /**
   * Pindah ke langkah 2 hanya setelah langkah 1 SAH.
   *
   * Aktivasi lisensi TIDAK dilakukan di sini melainkan di submit akhir.
   * Mengaktifkan di sini akan memakan satu slot perangkat di server
   * untuk pemasangan yang mungkin ditinggalkan di langkah berikutnya —
   * slot yang tidak memberi apa pun dan tidak mudah dikembalikan.
   */
  const diAdmin = langkah === 'ADMIN';

  const keLangkahAdmin = async () => {
    setLicenseError(null);
    if (await trigger()) setLangkah('ADMIN');
  };

  /**
   * URUTAN TRANSAKSI FIRST RUN — urutannya menentukan keamanan.
   *
   *   1. validasi form (nama, tahun buku, format license key)
   *   2. activateLicense({ licenseKey, cooperativeName })
   *   3. HANYA bila (2) berhasil -> setupKoperasi()
   *   4. tandai gate untuk evaluasi ulang -> onComplete()
   *
   * Kalau (2) gagal, langkah (3) dan (4) TIDAK dijalankan: setup tidak
   * ditandai selesai dan aplikasi tetap di wizard ini. Membalik urutan
   * — menulis database dulu lalu mengaktivasi — akan menghasilkan
   * koperasi yang "sudah setup" tanpa lisensi, dan gate akan
   * memblokirnya tanpa jalan kembali ke wizard.
   *
   * Kalau (3) gagal setelah (2) berhasil, token lisensi TIDAK dihapus.
   * Lisensinya memang sudah sah; yang gagal penulisan database. Menghapus
   * token akan memakan slot perangkat di server tanpa memberi apa pun.
   */
  const onSubmit = async (admin: FormAdmin) => {
    setSubmitting(true);
    setLicenseError(null);
    try {
      const parsed = schema.parse(getValues()) as ParsedValues;
      const nama = parsed.nama.trim();

      // --- Langkah 2: aktivasi lisensi -----------------------------
      // Dilewati HANYA bila perangkat ini memang sudah punya lisensi
      // sah (mis. setup gagal di tengah lalu diulang). Keputusannya
      // diambil LicenseService, bukan flag lokal.
      const existing = await getLicenseStatus();
      if (!existing.allowAppAccess) {
        const result = await activateLicense({
          licenseKey: normalizeLicenseKey(parsed.licenseKey),
          cooperativeName: nama,
        });
        if (!result.ok) {
          // Pesan berasal dari LicenseService — sudah aman ditampilkan,
          // tidak memuat stack trace atau detail server.
          setLicenseError(result.message);
          notify('Aktivasi lisensi gagal', result.message);
          /*
           * Kembali ke langkah 1. Kotak galat lisensi hidup di sana,
           * bersebelahan dengan isian License Key yang harus diperbaiki;
           * meninggalkan pengguna di langkah 2 berarti memberi tahu ada
           * yang salah tanpa memperlihatkan di mana.
           */
          setLangkah('KOPERASI');
          return; // setupKoperasi & onComplete TIDAK dipanggil
        }
      }

      // --- Langkah 3: tulis database -------------------------------
      await setupKoperasi({
        nama,
        tahunBuku: parsed.tahunBuku,
        adminNama: admin.adminNama.trim(),
        adminUsername: rapikanUsername(admin.adminUsername),
        adminPassword: rapikanPassword(admin.adminPassword),
        // standarAkuntansi & adminPin SENGAJA tidak dikirim:
        // SetupService memakai SAK_EP dan membiarkan PIN nonaktif.
        // PIN adalah kunci layar, bukan kredensial masuk — perannya
        // dipisahkan sejak RC-S117 dan dinyalakan sendiri bila perlu.
      });
      // Panduan singkat penggunaan aplikasi tampil sekali di Dashboard
      // setelah setup administrasi. Gagal menandai tidak menggagalkan setup.
      await tandaiPanduanAwalPerluTampil().catch(() => undefined);

      // --- Langkah 4: keluar dari fase FIRST_RUN --------------------
      notify(
        'Setup selesai',
        `Akun admin "${rapikanUsername(admin.adminUsername)}" siap dipakai. Identitas koperasi dapat dilengkapi nanti dari Dashboard.`
      );
      triggerLicenseRecheck();
      onComplete();
    } catch (e) {
      notify('Gagal menyimpan setup', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // Kalau kriptografi Ed25519 tidak berfungsi di perangkat ini, aktivasi
  // PASTI gagal dan pesannya sendiri tidak menjelaskan apa-apa. Layar
  // diagnostik yang sudah ada dapat dibuka dari sini tanpa keluar dari
  // wizard, sehingga penyebabnya bisa ditemukan sejak pemasangan pertama.
  if (showDiagnostic) {
    return <LicenseDiagnosticScreen onBack={() => setShowDiagnostic(false)} />;
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/*
        UI/UX FINAL POLISH (§5) — susunan eksplisit:
          HEADER -> DESCRIPTION -> FORM GROUP -> PRIMARY ACTION.
        Sebelumnya ketiga bagian pertama menyatu sebagai teks tengah
        tanpa pemisah, sehingga tidak jelas mana judul layar dan mana
        penjelasan. Isi pertanyaan, urutan field, skema zod, dan
        `onSubmit` TIDAK berubah.
      */}
      <AreaAmanKeyboard varian="layar" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* ---------------- HEADER ---------------- */}
        <View style={styles.logoCircle}>
          <Ionicons name={diAdmin ? 'shield-checkmark' : 'business'} size={28} color={colors.white} />
        </View>

        <Text style={styles.title}>{diAdmin ? 'Akun Administrator' : 'Selamat Datang di KOPKU'}</Text>

        {/* ---------------- DESCRIPTION ---------------- */}
        <Text style={styles.subtitle}>
          {diAdmin
            ? 'Buat username dan password untuk masuk ke aplikasi. Simpan baik-baik — ini satu-satunya kunci ke data koperasi Anda.'
            : 'Dua langkah singkat sudah cukup untuk mulai memakai aplikasi.'}
        </Text>
        {/* KOPKU Desktop: opsi mengambil data dari HP (null di Android). */}
        {!diAdmin && <TombolHubungkanHpSetup />}

        {/*
          PENANDA LANGKAH — memberi tahu ADA berapa langkah dan sedang di
          mana. Tanpa ini, tombol "Lanjut" pada layar pertama sebuah
          aplikasi terasa seperti masuk ke sesuatu yang tak berujung.
        */}
        <View style={styles.langkahBaris} accessibilityRole="progressbar" accessibilityLabel={`Langkah ${diAdmin ? 2 : 1} dari 2`}>
          {(['KOPERASI', 'ADMIN'] as const).map((l, i) => {
            const aktif = l === langkah;
            const lewat = l === 'KOPERASI' && diAdmin;
            return (
              <View key={l} style={styles.langkahItem}>
                <View style={[styles.langkahBulat, (aktif || lewat) && styles.langkahBulatAktif]}>
                  {lewat ? (
                    <Ionicons name="checkmark" size={14} color={colors.white} />
                  ) : (
                    <Text style={[styles.langkahAngka, aktif && styles.langkahAngkaAktif]}>{i + 1}</Text>
                  )}
                </View>
                <Text style={[styles.langkahLabel, aktif && styles.langkahLabelAktif]}>
                  {l === 'KOPERASI' ? 'Koperasi' : 'Administrator'}
                </Text>
                {i === 0 && <View style={[styles.langkahGaris, diAdmin && styles.langkahGarisAktif]} />}
              </View>
            );
          })}
        </View>

        {/* ---------------- FORM GROUP ---------------- */}
        {!diAdmin && (
        <View>
        <View style={styles.card}>
          <Text style={styles.groupLabel}>Informasi Dasar</Text>
          <Field
            label="Nama Koperasi"
            inputType="business"
            control={control}
            name="nama"
            placeholder="Tulis nama koperasi"
            error={errors.nama?.message}
          />
          <Field
            label="Tahun Buku"
            inputType="date"
            control={control}
            name="tahunBuku"
            placeholder={String(getWaktuSekarang().getFullYear())}
            keyboardType="number-pad"
            error={errors.tahunBuku?.message as string | undefined}
          />
          {/* License Key TEPAT DI BAWAH Tahun Buku. */}
          <Field
            label="License Key"
            inputType="key"
            control={control}
            name="licenseKey"
            placeholder="KPK-XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoCorrect={false}
            error={errors.licenseKey?.message as string | undefined}
            last
          />
        </View>

        {licenseError && (
          <View style={styles.licenseErrorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.licenseErrorText}>{licenseError}</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.diagnosticLink}
          onPress={() => setShowDiagnostic(true)}
          accessibilityRole="button"
          accessibilityLabel="Buka diagnostik keamanan"
        >
          <Ionicons name="pulse-outline" size={iconSize.sm} color={colors.textMuted} />
          <Text style={styles.diagnosticLinkText}>Diagnostik Keamanan</Text>
        </TouchableOpacity>

        <View style={styles.hintBox}>
          <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
          <Text style={styles.hint}>
            Identitas koperasi selengkapnya (alamat, kontak, badan hukum, NPWP, logo) dapat dilengkapi
            nanti dari Dashboard.
          </Text>
        </View>
        </View>
        )}

        {/* ---------------- LANGKAH 2: ADMINISTRATOR ---------------- */}
        {diAdmin && (
        <View>
          <View style={styles.card}>
            <Text style={styles.groupLabel}>Identitas Pemegang Akun</Text>
            <FieldAdmin
              label="Nama Lengkap"
              inputType="person"
              control={controlAdmin}
              name="adminNama"
              placeholder="Nama pengurus yang memegang aplikasi"
              error={errorsAdmin.adminNama?.message}
              last
            />
          </View>

          <View style={[styles.card, styles.cardKedua]}>
            <Text style={styles.groupLabel}>Kredensial Masuk</Text>
            <FieldAdmin
              label="Username"
              inputType="person"
              control={controlAdmin}
              name="adminUsername"
              placeholder="contoh: admin"
              autoCapitalize="none"
              autoCorrect={false}
              error={errorsAdmin.adminUsername?.message}
            />
            <FieldAdmin
              label="Password"
              inputType="key"
              control={controlAdmin}
              name="adminPassword"
              placeholder={`Minimal ${PANJANG_MIN_PASSWORD} karakter`}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!lihatPassword}
              error={errorsAdmin.adminPassword?.message}
            />

            {/*
              Indikator kekuatan hanya muncul setelah ada yang diketik.
              Menampilkannya pada kotak kosong menandai password yang
              belum ada sebagai "lemah" — menegur orang atas sesuatu
              yang belum mereka lakukan.
            */}
            {kekuatan && (
              <View style={styles.kekuatanBaris}>
                <View style={styles.kekuatanTrek}>
                  {(['LEMAH', 'CUKUP', 'KUAT'] as const).map((t, i) => (
                    <View
                      key={t}
                      style={[
                        styles.kekuatanSegmen,
                        i <= (['LEMAH', 'CUKUP', 'KUAT'] as const).indexOf(kekuatan) && {
                          backgroundColor: warnaKekuatan(kekuatan),
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text style={[styles.kekuatanLabel, { color: warnaKekuatan(kekuatan) }]}>
                  {LABEL_KEKUATAN[kekuatan]}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.lihatPasswordBaris}
              onPress={() => setLihatPassword((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: lihatPassword }}
              accessibilityLabel={lihatPassword ? 'Sembunyikan password' : 'Tampilkan password'}
            >
              <Ionicons
                name={lihatPassword ? 'eye-off-outline' : 'eye-outline'}
                size={iconSize.sm}
                color={colors.textMuted}
              />
              <Text style={styles.lihatPasswordText}>
                {lihatPassword ? 'Sembunyikan password' : 'Tampilkan password'}
              </Text>
            </TouchableOpacity>

            <FieldAdmin
              label="Ulangi Password"
              inputType="key"
              control={controlAdmin}
              name="adminKonfirmasi"
              placeholder="Ketik ulang password"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!lihatPassword}
              error={errorsAdmin.adminKonfirmasi?.message}
              last
            />
          </View>

          <View style={styles.catatanKunci}>
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.catatanKunciText}>
              Catat username dan password ini di tempat aman. Aplikasi bekerja luring dan tidak
              menyimpan salinan di mana pun, sehingga password yang hilang tidak dapat dipulihkan
              oleh siapa pun — termasuk pembuat aplikasi.
            </Text>
          </View>

          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
            <Text style={styles.hint}>
              PIN berbeda dari password: PIN hanya membuka kunci layar, sedangkan password dipakai
              untuk masuk. PIN bersifat opsional dan dapat diaktifkan kapan saja lewat Pengaturan ›
              Keamanan.
            </Text>
          </View>
        </View>
        )}

        {/* ---------------- PRIMARY ACTION ---------------- */}
        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={diAdmin ? handleSubmitAdmin(onSubmit) : keLangkahAdmin}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={diAdmin ? 'Selesaikan setup dan mulai memakai aplikasi' : 'Lanjut ke akun administrator'}
          accessibilityState={{ disabled: submitting }}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Text style={styles.submitText}>{diAdmin ? 'Selesai & Mulai' : 'Lanjut'}</Text>
              <Ionicons name="arrow-forward" size={iconSize.md} color={colors.white} />
            </>
          )}
        </TouchableOpacity>

        {/*
          Tombol kembali hanya ada di langkah 2. Ia TIDAK menghapus isian
          langkah 1 — form-nya hidup terpisah dan tetap terisi — sehingga
          memeriksa ulang nama koperasi tidak menghukum pengguna dengan
          mengetik ulang semuanya.
        */}
        {diAdmin && (
          <TouchableOpacity
            style={styles.kembaliButton}
            onPress={() => setLangkah('KOPERASI')}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Kembali ke data koperasi"
          >
            <Ionicons name="arrow-back" size={iconSize.sm} color={colors.textMuted} />
            <Text style={styles.kembaliText}>Kembali ke data koperasi</Text>
          </TouchableOpacity>
        )}
        </ScrollView>
      </AreaAmanKeyboard>
    </SafeAreaView>
  );
}

/**
 * Field wizard — sekarang hanya pembungkus `Controller` di sekitar
 * `AppTextInput`. Label, batas, ikon per tipe, focus state, dan
 * presentasi error datang dari komponen bersama, jadi field di sini
 * tidak lagi terlihat berbeda dari field di layar lain.
 *
 * `onBlur` milik react-hook-form TETAP diteruskan (AppTextInput
 * memanggil handler pemanggil setelah mengurus state fokusnya), jadi
 * validasi mode blur tidak berubah. `error` hanya DITERUSKAN dari
 * `formState.errors` — kapan error muncul tetap ditentukan zod.
 */
function Field({
  label,
  inputType,
  control,
  name,
  error,
  placeholder,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  last,
}: {
  label: string;
  inputType?: InputTypeName;
  control: any;
  name: string;
  error?: string;
  placeholder?: string;
  keyboardType?: any;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  /** Field terakhir dalam grup: tanpa jarak bawah ganda. */
  last?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { onChange, onBlur, value } }) => (
        <AppTextInput
          label={label}
          inputType={inputType}
          error={error}
          onBlur={onBlur}
          onChangeText={onChange}
          value={value as string}
          placeholder={placeholder}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          containerStyle={last ? styles.fieldLast : undefined}
        />
      )}
    />
  );
}

/**
 * Warna indikator kekuatan. Dipisah menjadi fungsi supaya tiga tempat
 * yang memakainya (segmen terisi, label, dan tes) membaca SATU sumber.
 */
function warnaKekuatan(t: TingkatKekuatan): string {
  if (t === 'KUAT') return colors.success;
  if (t === 'CUKUP') return colors.warning;
  return colors.danger;
}

/**
 * Field langkah 2. Sama persis dengan `Field` di atas, hanya tipe
 * `control`/`name`-nya yang terikat ke form admin — dan menerima
 * `secureTextEntry`, yang tidak dibutuhkan langkah 1.
 */
function FieldAdmin({
  label,
  inputType,
  control,
  name,
  error,
  placeholder,
  autoCapitalize,
  autoCorrect,
  secureTextEntry,
  last,
}: {
  label: string;
  inputType?: InputTypeName;
  control: any;
  name: keyof FormAdmin;
  error?: string;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  secureTextEntry?: boolean;
  last?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { onChange, onBlur, value } }) => (
        <AppTextInput
          label={label}
          inputType={inputType}
          error={error}
          onBlur={onBlur}
          onChangeText={onChange}
          value={value as string}
          placeholder={placeholder}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          secureTextEntry={secureTextEntry}
          containerStyle={last ? styles.fieldLast : undefined}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: spacing.lg, flexGrow: 1, justifyContent: 'center' },
  logoCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
  subtitle: {
    fontSize: typography.subtitle,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  groupLabel: { ...formUi.groupLabel },
  fieldLast: { marginBottom: 0 },
  licenseErrorBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    backgroundColor: colors.dangerBg,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  licenseErrorText: { flex: 1, fontSize: 12, color: colors.danger, lineHeight: 17 },
  diagnosticLink: {
    flexDirection: 'row',
    gap: spacing.xs + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  diagnosticLinkText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  hintBox: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: spacing.md },
  hint: { fontSize: 12, color: colors.textMuted, flex: 1, lineHeight: 17 },
  submitButton: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  submitButtonDisabled: { backgroundColor: colors.disabled },
  cardKedua: { marginTop: spacing.md },
  langkahBaris: { flexDirection: 'row', marginBottom: spacing.lg, paddingHorizontal: spacing.xs },
  langkahItem: { flex: 1, alignItems: 'center', gap: spacing.xs },
  langkahBulat: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  langkahBulatAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  langkahAngka: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  langkahAngkaAktif: { color: colors.white },
  langkahLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  langkahLabelAktif: { color: colors.text },
  /*
   * Garis penghubung digambar di BELAKANG bulatan (zIndex -1) dan
   * dimulai dari tengah bulatan pertama, supaya ia menyambung dua
   * langkah alih-alih memotong keduanya.
   */
  langkahGaris: {
    position: 'absolute',
    top: 13,
    left: '50%',
    right: '-50%',
    height: 1,
    backgroundColor: colors.border,
    zIndex: -1,
  },
  langkahGarisAktif: { backgroundColor: colors.primary },
  kekuatanBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: -spacing.xs, marginBottom: spacing.md },
  kekuatanTrek: { flex: 1, flexDirection: 'row', gap: 4 },
  kekuatanSegmen: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  kekuatanLabel: { fontSize: 11, fontWeight: '700', minWidth: 44, textAlign: 'right' },
  lihatPasswordBaris: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    alignSelf: 'flex-start',
    minHeight: touchTarget,
    paddingVertical: spacing.sm,
    marginTop: -spacing.sm,
    marginBottom: spacing.xs,
  },
  lihatPasswordText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  catatanKunci: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  catatanKunciText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  kembaliButton: {
    flexDirection: 'row',
    gap: spacing.xs + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget,
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  kembaliText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
