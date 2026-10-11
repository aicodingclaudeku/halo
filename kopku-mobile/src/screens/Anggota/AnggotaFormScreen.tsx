import React, { useEffect, useState } from 'react';
import { labelStatusAnggota } from '@/reports/TampilanAnggotaPlan';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { notify } from '@/store/useNotifyStore';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  createAnggota,
  updateAnggota,
  getAnggotaById,
  StatusAnggota,
  JenisKelamin,
} from '@/repositories/AnggotaRepository';
import { useAppStore } from '@/store/useAppStore';
import DatePicker from '@/components/DatePicker';
import { colors, radius, spacing } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

const schema = z
  .object({
    isiNik: z.boolean(),
    nik: z.string().optional(),
    namaLengkap: z.string().min(2, 'Nama wajib diisi'),
    tempatLahir: z.string().optional(),
    tanggalLahir: z.string().optional(),
    alamat: z.string().optional(),
    nomorHp: z.string().optional(),
    pekerjaan: z.string().optional(),
    tanggalBergabung: z.string().min(1, 'Tanggal bergabung wajib diisi'),
    catatan: z.string().optional(),
    // Bug fix: NIK asli (dari database, mode EDIT) — TIDAK divalidasi
    // ulang formatnya kalau user tidak mengubahnya sama sekali. Field
    // internal, tidak dikirim ke server (lihat `buildPayload`/`onSubmit`).
    nikAsli: z.string().optional(),
  })
  .refine(
    (data) => {
      if (!data.isiNik) return true;
      // Kalau NIK TIDAK diubah dari data yang sudah tersimpan (mode
      // EDIT), jangan blokir simpan hanya karena data lama itu ternyata
      // tidak persis 16 digit (mis. hasil import/entry manual lama,
      // sebelum aturan 16-digit ini ada). Validasi format HANYA berlaku
      // untuk NIK yang benar-benar baru diketik/diubah user — supaya
      // user tidak terjebak tidak bisa menyimpan perubahan field LAIN
      // gara-gara NIK lama yang tidak mereka sentuh.
      if (data.nikAsli !== undefined && data.nik === data.nikAsli) return true;
      return /^\d{16}$/.test(data.nik ?? '');
    },
    { message: 'NIK harus 16 digit angka', path: ['nik'] }
  );

type FormValues = z.infer<typeof schema>;

const STATUS_OPTIONS: StatusAnggota[] = ['AKTIF', 'TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'];
// Permintaan pengguna §8 — opsional, data anggota lama tanpa nilai tidak dianggap invalid.
const JENIS_KELAMIN_OPTIONS: { value: JenisKelamin; label: string }[] = [
  { value: 'LAKI_LAKI', label: 'Laki-laki' },
  { value: 'PEREMPUAN', label: 'Perempuan' },
];

/**
 * Form tambah/edit anggota (PRD §7). Mode ditentukan oleh ada/tidaknya
 * anggotaId.
 *
 * NIK sekarang bisa di-nonaktifkan (switch "Isi NIK sekarang") untuk
 * kasus anggota didaftarkan dulu sebelum KTP/NIK tersedia — field NIK
 * jadi opsional & disembunyikan saat switch OFF. Saat OFF, nik
 * disimpan sebagai NULL (bukan string kosong), supaya banyak anggota
 * tanpa NIK tidak saling bentrok di kolom UNIQUE (lihat migrasi
 * schema v4 di database/db.ts).
 *
 * Bug fix (dilaporkan pengguna — "tidak bisa edit dan simpan"): akar
 * masalahnya validasi NIK 16-digit yang dipaksakan ulang ke data NIK
 * LAMA yang sudah tersimpan (lihat komentar `schema` di atas) —
 * membuat Simpan gagal TANPA pesan error yang jelas kalau data anggota
 * itu punya NIK lama yang tidak persis 16 digit, walau field yang
 * diedit user sama sekali bukan NIK. Diperbaiki dengan (1) tidak
 * memvalidasi ulang NIK yang tidak diubah, dan (2) `handleSubmit` di
 * bawah SEKARANG selalu memberi tahu user lewat notify() kalau validasi
 * gagal — sebelumnya benar-benar diam (hanya teks merah kecil di bawah
 * field yang gampang terlewat), yang terlihat persis seperti "tombol
 * Simpan tidak berfungsi".
 */
export default function AnggotaFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const anggotaId: string | undefined = route.params?.anggotaId;
  const isEdit = !!anggotaId;

  const [status, setStatus] = useState<StatusAnggota>('AKTIF');
  const [jenisKelamin, setJenisKelamin] = useState<JenisKelamin | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [nomorAnggota, setNomorAnggota] = useState<string | null>(null); // Phase 17 §C: otomatis, read-only

  const { control, handleSubmit, reset, watch, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      isiNik: true,
      tanggalBergabung: getTanggalLokalHariIni(),
    },
  });

  const isiNik = watch('isiNik');

  useEffect(() => {
    if (!anggotaId) return;
    (async () => {
      const a = await getAnggotaById(anggotaId);
      if (a) {
        setNomorAnggota(a.nomorAnggota);
        // Bug fix ("Tidak bisa menyimpan — Expected string, received
        // null"): field opsional (tempatLahir, tanggalLahir, alamat,
        // nomorHp, pekerjaan, catatan) disimpan sebagai NULL di SQLite
        // kalau kosong — TypeScript menyatakan tipenya `string`
        // (opsional lewat `?`), tapi runtime-nya tetap bisa `null`
        // mentah dari database. Skema Zod (`z.string().optional()`)
        // HANYA menerima `string | undefined`, BUKAN `null`, jadi
        // `reset()` yang sebelumnya meneruskan `a.xxx` apa adanya
        // membuat form tersimpan dengan nilai `null` di field yang
        // tidak disentuh user sama sekali — begitu tombol Simpan
        // ditekan, validasi Zod gagal dengan "Expected string, received
        // null" walau user cuma mengedit field lain (mis. Pekerjaan).
        // `?? ''` di sini murni mengubah representasi DI FORM (bukan
        // data yang tersimpan di DB) — pola yang sama persis sudah
        // dipakai untuk `nik` di baris di bawah ini sejak awal.
        reset({
          isiNik: !!a.nik,
          nik: a.nik ?? '',
          nikAsli: a.nik ?? '',
          namaLengkap: a.namaLengkap,
          tempatLahir: a.tempatLahir ?? '',
          tanggalLahir: a.tanggalLahir ?? '',
          alamat: a.alamat ?? '',
          nomorHp: a.nomorHp ?? '',
          pekerjaan: a.pekerjaan ?? '',
          tanggalBergabung: a.tanggalBergabung,
          catatan: a.catatan ?? '',
        });
        setStatus(a.status);
        setJenisKelamin(a.jenisKelamin ?? null);
      }
      setLoading(false);
    })();
  }, [anggotaId, reset]);

  const onSubmit = async (values: FormValues) => {
    if (!currentUser) {
      notify('Gagal menyimpan', 'Sesi pengguna tidak ditemukan. Silakan login ulang lalu coba lagi.');
      return;
    }
    setSubmitting(true);
    try {
      const { nikAsli, ...rest } = values;
      // Bug fix: field opsional di form sekarang selalu string ('' kalau
      // kosong, bukan null lagi — lihat komentar di reset() di atas)
      // supaya lolos validasi Zod. Tapi representasi DI DATABASE harus
      // tetap sama seperti sebelumnya (NULL untuk field yang memang
      // kosong, bukan string kosong ''), supaya perilaku data TIDAK
      // berubah — repository (`createAnggota`/`updateAnggota`) memang
      // sudah mengharapkan null untuk field kosong. `kosongJadiNull()`
      // mengubalikkan '' (dan whitespace-only) jadi null sebelum
      // dikirim ke repository.
      const kosongJadiNull = (v?: string | null): string | null => {
        const trimmed = v?.trim();
        return trimmed ? trimmed : null;
      };
      const payload = {
        ...rest,
        tempatLahir: kosongJadiNull(rest.tempatLahir) ?? undefined,
        tanggalLahir: kosongJadiNull(rest.tanggalLahir) ?? undefined,
        alamat: kosongJadiNull(rest.alamat) ?? undefined,
        nomorHp: kosongJadiNull(rest.nomorHp) ?? undefined,
        pekerjaan: kosongJadiNull(rest.pekerjaan) ?? undefined,
        catatan: kosongJadiNull(rest.catatan) ?? undefined,
        nik: values.isiNik ? values.nik ?? null : null,
        status,
        jenisKelamin,
      };
      if (isEdit) {
        await updateAnggota(currentUser.id, anggotaId!, payload);
      } else {
        await createAnggota(currentUser.id, payload);
      }
      navigation.goBack();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // Bug fix: kalau validasi form GAGAL, beri tahu user secara eksplisit
  // (sebelumnya diam total kalau ada error selain yang langsung
  // terlihat — lihat komentar header). Ambil pesan error PERTAMA yang
  // ditemukan supaya jelas field mana yang bermasalah.
  const onInvalid = (formErrors: typeof errors) => {
    const pesanPertama = Object.values(formErrors)[0]?.message as string | undefined;
    notify('Tidak bisa menyimpan', pesanPertama ?? 'Ada data yang belum valid. Periksa kembali isian form.');
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: RUANG_BAWAH_FORM }}>
        {/* Form ini dulu satu kolom datar berisi 14 field berturut-turut
            tanpa jeda; mata tidak punya tempat beristirahat dan pengguna
            kehilangan tempat setelah menggulir. Sekarang dikelompokkan ke
            empat bagian berjudul. Murni pengelompokan visual: urutan,
            nama field, aturan wajib/opsional, dan validasinya TIDAK ada
            yang berubah. */}
        <Text style={styles.grupJudul}>Identitas Keanggotaan</Text>
        <View style={styles.grup}>
        {isEdit ? (
          <View style={styles.field}>
            <Text style={styles.label}>Nomor Anggota</Text>
            <View style={styles.readonlyBox}>
              <Text style={styles.readonlyText}>{nomorAnggota}</Text>
            </View>
            <Text style={styles.switchHint}>Nomor anggota tidak dapat diubah.</Text>
          </View>
        ) : (
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.infoText}>Nomor anggota akan dibuat otomatis saat data disimpan.</Text>
          </View>
        )}

        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Isi NIK Sekarang</Text>
            <Text style={styles.switchHint}>
              Matikan kalau NIK belum ada — anggota bisa didaftarkan dulu, NIK diisi menyusul lewat menu Edit.
            </Text>
          </View>
          <Controller
            control={control}
            name="isiNik"
            render={({ field: { onChange, value } }) => (
              <Switch
                value={value}
                onValueChange={onChange}
                trackColor={{ false: colors.border, true: colors.primaryLight }}
                thumbColor={value ? colors.primary : colors.textFaint}
              />
            )}
          />
        </View>

        {isiNik && (
          <Field label="NIK *" control={control} name="nik" keyboardType="number-pad" error={errors.nik?.message} />
        )}
        {!isiNik && (
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.infoText}>NIK belum diisi. Anggota tetap bisa disimpan tanpa NIK untuk sekarang.</Text>
          </View>
        )}

        </View>

        <Text style={styles.grupJudul}>Data Pribadi</Text>
        <View style={styles.grup}>
        <Field label="Nama Lengkap *" control={control} name="namaLengkap" error={errors.namaLengkap?.message} />

        {/* Permintaan pengguna §8: Jenis Kelamin — opsional (tidak wajib),
            data anggota lama tanpa nilai tetap aman/tidak dianggap rusak. */}
        <View style={styles.field}>
          <Text style={styles.label}>Jenis Kelamin</Text>
          <View style={styles.statusRow}>
            {JENIS_KELAMIN_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[styles.statusChip, jenisKelamin === opt.value && styles.statusChipActive]}
                onPress={() => setJenisKelamin(jenisKelamin === opt.value ? null : opt.value)}
              >
                <Text style={[styles.statusChipText, jenisKelamin === opt.value && styles.statusChipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <Field label="Tempat Lahir" control={control} name="tempatLahir" />

        <Text style={styles.label}>Tanggal Lahir</Text>
        <Controller
          control={control}
          name="tanggalLahir"
          render={({ field: { onChange, value } }) => (
            <View style={styles.field}>
              <DatePicker value={value} onChange={onChange} maximumDate={getWaktuSekarang()} />
            </View>
          )}
        />

        </View>

        <Text style={styles.grupJudul}>Kontak & Pekerjaan</Text>
        <View style={styles.grup}>
        <Field label="Alamat" control={control} name="alamat" multiline />
        <Field label="Nomor HP" control={control} name="nomorHp" keyboardType="phone-pad" />
        <Field label="Pekerjaan" control={control} name="pekerjaan" />

        </View>

        <Text style={styles.grupJudul}>Riwayat & Status</Text>
        <View style={styles.grup}>
        <Text style={styles.label}>Tanggal Bergabung *</Text>
        <Controller
          control={control}
          name="tanggalBergabung"
          render={({ field: { onChange, value } }) => (
            <View style={styles.field}>
              <DatePicker value={value} onChange={onChange} error={errors.tanggalBergabung?.message} maximumDate={getWaktuSekarang()} />
            </View>
          )}
        />

        <Field label="Catatan" control={control} name="catatan" multiline />

        {isEdit && (
          <View style={styles.field}>
            <Text style={styles.label}>Status</Text>
            <View style={styles.statusRow}>
              {STATUS_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={[styles.statusChip, status === opt && styles.statusChipActive]}
                  onPress={() => setStatus(opt)}
                >
                  <Text style={[styles.statusChipText, status === opt && styles.statusChipTextActive]}>
                    {labelStatusAnggota(opt)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        </View>

        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit(onSubmit, onInvalid)}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/**
 * UI/UX FINAL POLISH (§6, §7) — field layar ini sekarang memakai
 * `AppTextInput` bersama: label, batas, ikon per tipe, focus state, dan
 * presentasi error datang dari satu design system, bukan dari style
 * lokal tiap layar. Prop yang diterima helper ini TIDAK berubah, jadi
 * seluruh pemanggilnya tetap sama; value, handler, dan kapan error
 * muncul juga tidak disentuh.
 */
function Field({
  label,
  control,
  name,
  error,
  multiline,
  keyboardType,
}: {
  label: string;
  control: any;
  name: string;
  error?: string;
  multiline?: boolean;
  keyboardType?: any;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { onChange, onBlur, value } }) => (
        <AppTextInput
          label={label}
          error={error}
          onBlur={onBlur}
          onChangeText={onChange}
          value={value ?? ''}
          multiline={multiline}
          keyboardType={keyboardType}
          noIcon={!multiline}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  grupJudul: { fontSize: 11.5, fontWeight: '800', color: colors.primary, letterSpacing: 0.4, marginBottom: spacing.sm },
  grup: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  inputMultiline: { minHeight: 70, textAlignVertical: 'top' },
  readonlyBox: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  readonlyText: { fontSize: 15, color: colors.textMuted, fontWeight: '600' },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  switchLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  switchHint: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  statusChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusChipText: { fontSize: 12, color: colors.text },
  statusChipTextActive: { color: colors.white },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    marginBottom: 40,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
