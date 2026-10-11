import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import AppTextInput from '@/components/AppTextInput';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import ExportButton from '@/components/ExportButton';
import {
  buatAkunAnggotaMassal,
  daftarCalonAkunAnggota,
  usernameDariNomor,
  type AkunAnggotaDibuat,
  type CalonAkunAnggota,
  type ModePasswordMassal,
  type ModeUsernameMassal,
} from '@/services/UserManagementService';
import { periksaPassword, PANJANG_MIN_PASSWORD } from '@/security/kebijakanPassword';
import type { DataLaporanExport } from '@/export/ExportTypes';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, touchTarget, typography } from '@/theme/colors';

/**
 * RC-S133.5 — BUAT AKUN SEMUA ANGGOTA (Pengaturan › User Management).
 *
 * Langkah: ATUR (username & password) → PROSES (hash satu per satu) →
 * HASIL (daftar username + password, ekspor/cetak). Password teks hanya
 * ada di layar ini; setelah layar ditutup ia tidak dapat ditampilkan lagi.
 */
type Langkah = 'ATUR' | 'PROSES' | 'HASIL';

function Pilihan<T extends string>({
  nilai,
  opsi,
  onPilih,
}: {
  nilai: T;
  opsi: { kunci: T; judul: string; contoh: string; ikon: keyof typeof Ionicons.glyphMap }[];
  onPilih: (k: T) => void;
}) {
  return (
    <View style={st.opsiBaris}>
      {opsi.map((o) => {
        const aktif = nilai === o.kunci;
        return (
          <TouchableOpacity
            key={o.kunci}
            style={[st.opsi, aktif && st.opsiAktif]}
            onPress={() => onPilih(o.kunci)}
            accessibilityRole="radio"
            accessibilityState={{ checked: aktif }}
            testID={`opsi-${o.kunci.toLowerCase()}`}
          >
            <View style={st.opsiKepala}>
              <Ionicons name={o.ikon} size={18} color={aktif ? colors.primary : colors.textMuted} />
              <Ionicons name={aktif ? 'radio-button-on' : 'radio-button-off'} size={18} color={aktif ? colors.primary : colors.textFaint} />
            </View>
            <Text style={[st.opsiJudul, aktif && { color: colors.primary }]}>{o.judul}</Text>
            <Text style={st.opsiContoh}>{o.contoh}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function AkunAnggotaMassalScreen() {
  const navigation = useNavigation<any>();
  const user = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const [langkah, setLangkah] = useState<Langkah>('ATUR');
  const [calon, setCalon] = useState<CalonAkunAnggota[] | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [modeUsername, setModeUsername] = useState<ModeUsernameMassal>('NOMOR_ANGGOTA');
  const [modePassword, setModePassword] = useState<ModePasswordMassal>('ACAK');
  const [passwordSama, setPasswordSama] = useState('');
  const [wajibGanti, setWajibGanti] = useState(true);
  const [progres, setProgres] = useState({ selesai: 0, total: 0 });
  const [hasil, setHasil] = useState<AkunAnggotaDibuat[]>([]);
  const [tampilPassword, setTampilPassword] = useState(true);

  useEffect(() => {
    if (!user) return;
    daftarCalonAkunAnggota(user.id)
      .then(setCalon)
      .catch((e) => setGalat(e instanceof Error ? e.message : 'Gagal memuat anggota.'));
  }, [user]);

  const cekSama = modePassword === 'SAMA' ? periksaPassword({ password: passwordSama }) : null;
  const bisaBuat = !!calon && calon.length > 0 && (modePassword === 'ACAK' || !!cekSama?.sah);

  const contohUsername = calon?.[0] ? usernameDariNomor(calon[0].nomorAnggota) : 'a001';

  const buat = () => {
    if (!user || !calon) return;
    notify(
      `Buat ${calon.length} akun anggota?`,
      `Setiap anggota aktif yang belum punya akun dibuatkan akun ber-role Anggota (hanya melihat data dirinya sendiri).` +
        (wajibGanti ? ' Anggota wajib mengganti password saat masuk pertama.' : ''),
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Buat akun',
          onPress: async () => {
            setGalat(null);
            setLangkah('PROSES');
            setProgres({ selesai: 0, total: calon.length });
            try {
              const r = await buatAkunAnggotaMassal(
                user.id,
                { modeUsername, modePassword, passwordSama: modePassword === 'SAMA' ? passwordSama : undefined, wajibGanti },
                undefined,
                (selesai, total) => setProgres({ selesai, total })
              );
              setHasil(r);
              setLangkah('HASIL');
            } catch (e) {
              setGalat(e instanceof Error ? e.message : 'Gagal membuat akun.');
              setLangkah('ATUR');
            }
          },
        },
      ]
    );
  };

  const dataEkspor: DataLaporanExport | null = useMemo(
    () =>
      hasil.length === 0
        ? null
        : {
            judulLaporan: 'Daftar Akun Anggota',
            namaFileDasar: 'akun-anggota',
            namaKoperasi: koperasi?.nama ?? 'Koperasi',
            periodeLabel: `Dibuat ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`,
            kolom: ['No. Anggota', 'Nama', 'Username', 'Password'],
            baris: hasil.map((h) => [h.nomorAnggota, h.nama, h.username, h.password]),
            kolomAngka: [],
            ringkasan: [
              { label: 'Jumlah akun', nilai: String(hasil.length) },
              {
                label: 'Catatan',
                nilai: wajibGanti ? 'Password sementara — wajib diganti saat masuk pertama.' : 'Simpan dokumen ini di tempat aman.',
              },
            ],
          },
    [hasil, koperasi, wajibGanti]
  );

  if (langkah === 'PROSES') {
    const persen = progres.total ? Math.round((progres.selesai / progres.total) * 100) : 0;
    return (
      <View style={[st.akar, st.tengah]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={st.prosesJudul}>Membuat akun anggota…</Text>
        <Text style={st.ket}>
          Mengamankan password {progres.selesai} dari {progres.total}
        </Text>
        <View style={st.batang}>
          <View style={[st.batangIsi, { width: `${persen}%` }]} />
        </View>
        <Text style={st.ket}>Jangan tutup aplikasi sampai selesai.</Text>
      </View>
    );
  }

  if (langkah === 'HASIL') {
    return (
      <ScrollView {...PROP_SCROLL_FORM} style={st.akar} contentContainerStyle={st.isi} testID="hasil-akun-massal">
        <View style={st.sukses}>
          <Ionicons name="checkmark-circle" size={26} color={colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={st.suksesJudul}>{hasil.length} akun anggota dibuat</Text>
            <Text style={st.ket}>Bagikan username & password kepada masing-masing anggota.</Text>
          </View>
        </View>
        <View style={st.peringatan}>
          <Ionicons name="warning-outline" size={18} color={colors.warning} />
          <Text style={st.peringatanTeks}>
            Password hanya ditampilkan SEKALI di layar ini. Ekspor atau cetak sekarang; setelah layar ditutup, password yang lupa harus direset
            Admin lewat Sunting.
          </Text>
        </View>
        <View style={st.barisAksi}>
          <ExportButton data={dataEkspor} label="Ekspor / cetak daftar" />
          <TouchableOpacity style={st.tombolGaris} onPress={() => setTampilPassword((b) => !b)}>
            <Ionicons name={tampilPassword ? 'eye-off-outline' : 'eye-outline'} size={16} color={colors.primary} />
            <Text style={st.tombolGarisTeks}>{tampilPassword ? 'Sembunyikan password' : 'Tampilkan password'}</Text>
          </TouchableOpacity>
        </View>
        <View style={st.tabel}>
          <View style={[st.tabelBaris, st.tabelKepala]}>
            <Text style={[st.th, st.cNo]}>No.</Text>
            <Text style={[st.th, st.cNama]}>Nama</Text>
            <Text style={[st.th, st.cUser]}>Username</Text>
            <Text style={[st.th, st.cPass]}>Password</Text>
          </View>
          {hasil.map((h) => (
            <View key={h.userId} style={st.tabelBaris}>
              <Text style={[st.td, st.cNo]}>{h.nomorAnggota}</Text>
              <Text style={[st.td, st.cNama]} numberOfLines={1}>
                {h.nama}
              </Text>
              <Text style={[st.td, st.cUser, st.mono]} selectable>
                {h.username}
              </Text>
              <Text style={[st.td, st.cPass, st.mono]} selectable>
                {tampilPassword ? h.password : '••••••••'}
              </Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={st.tombol} onPress={() => navigation.goBack()} accessibilityRole="button">
          <Text style={st.tombolTeks}>Selesai</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={st.akar}>
    <ScrollView {...PROP_SCROLL_FORM} style={st.akar} contentContainerStyle={[st.isi, { paddingBottom: RUANG_BAWAH_FORM }]} testID="akun-anggota-massal">
      <View style={st.kartu}>
        <View style={st.kepalaKartu}>
          <View style={st.ikonBulat}>
            <Ionicons name="people-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={st.judul}>Akun untuk semua anggota</Text>
            <Text style={st.ket}>
              {calon === null
                ? 'Menghitung anggota…'
                : calon.length === 0
                  ? 'Semua anggota aktif sudah memiliki akun.'
                  : `${calon.length} anggota aktif belum memiliki akun dan akan dibuatkan akun ber-role Anggota.`}
            </Text>
          </View>
        </View>
        {calon && calon.length > 0 ? (
          <Text style={st.daftarCalon} numberOfLines={2}>
            {calon.slice(0, 6).map((c) => `${c.nomorAnggota} ${c.nama}`).join(' · ')}
            {calon.length > 6 ? ` · dan ${calon.length - 6} lainnya` : ''}
          </Text>
        ) : null}
      </View>

      <Text style={st.bagian}>1. Username</Text>
      <Pilihan<ModeUsernameMassal>
        nilai={modeUsername}
        onPilih={setModeUsername}
        opsi={[
          { kunci: 'NOMOR_ANGGOTA', judul: 'Nomor anggota', contoh: `mis. ${contohUsername}`, ikon: 'id-card-outline' },
          { kunci: 'ACAK', judul: 'Acak', contoh: 'mis. agt-x7k2mp', ikon: 'shuffle-outline' },
        ]}
      />

      <Text style={st.bagian}>2. Password</Text>
      <Pilihan<ModePasswordMassal>
        nilai={modePassword}
        onPilih={setModePassword}
        opsi={[
          { kunci: 'ACAK', judul: 'Acak per anggota', contoh: '10 karakter, berbeda tiap anggota', ikon: 'key-outline' },
          { kunci: 'SAMA', judul: 'Sama untuk semua', contoh: 'Satu password yang Anda tentukan', ikon: 'copy-outline' },
        ]}
      />
      {modePassword === 'SAMA' ? (
        <View style={st.kartu}>
          <AppTextInput
            label="Password untuk semua anggota"
            inputType="key"
            autoCapitalize="none"
            autoCorrect={false}
            value={passwordSama}
            onChangeText={setPasswordSama}
            placeholder={`Minimal ${PANJANG_MIN_PASSWORD} karakter, huruf & angka`}
          />
          {passwordSama && cekSama && !cekSama.sah ? <Text style={st.galatKecil}>{cekSama.pesan}</Text> : null}
        </View>
      ) : null}

      <View style={[st.kartu, st.barisSwitch]}>
        <View style={{ flex: 1 }}>
          <Text style={st.tebal}>Wajib ganti password saat masuk pertama</Text>
          <Text style={st.ket}>Disarankan, terutama bila password sama untuk semua atau dibagikan lewat kertas/WhatsApp.</Text>
        </View>
        <Switch value={wajibGanti} onValueChange={setWajibGanti} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>

      <View style={st.info}>
        <Ionicons name="shield-checkmark-outline" size={16} color={colors.primary} />
        <Text style={st.infoTeks}>
          Akun Anggota hanya dapat melihat data dirinya sendiri: simpanan, pinjaman & jadwal angsuran, riwayat transaksi, dan SHU.
        </Text>
      </View>

      {galat ? (
        <View style={st.galat}>
          <Ionicons name="alert-circle" size={16} color={colors.danger} />
          <Text style={st.galatTeks}>{galat}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[st.tombol, !bisaBuat && st.tombolMati]}
        onPress={buat}
        disabled={!bisaBuat}
        accessibilityRole="button"
        testID="buat-akun-massal"
      >
        <Ionicons name="person-add-outline" size={18} color={colors.white} />
        <Text style={st.tombolTeks}>{calon && calon.length > 0 ? `Buat ${calon.length} akun` : 'Buat akun'}</Text>
      </TouchableOpacity>
    </ScrollView>
    </AreaAmanKeyboard>
  );
}

const st = StyleSheet.create({
  akar: { flex: 1, backgroundColor: colors.background },
  tengah: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  isi: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  kartu: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 6 },
  kepalaKartu: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  ikonBulat: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: typography.sectionTitle, fontWeight: '800', color: colors.text },
  ket: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  tebal: { fontWeight: '700', color: colors.text, fontSize: typography.body },
  daftarCalon: { fontSize: 11.5, color: colors.textMuted, marginTop: 4 },
  bagian: { fontSize: typography.body, fontWeight: '800', color: colors.text, marginTop: spacing.sm },
  opsiBaris: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  opsi: { flex: 1, minWidth: 150, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, padding: spacing.md, gap: 4 },
  opsiAktif: { borderColor: colors.primary, backgroundColor: colors.focusBg },
  opsiKepala: { flexDirection: 'row', justifyContent: 'space-between' },
  opsiJudul: { fontWeight: '700', color: colors.text, fontSize: typography.body },
  opsiContoh: { fontSize: 12, color: colors.textMuted },
  barisSwitch: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  info: { flexDirection: 'row', gap: 8, backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md },
  infoTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  galat: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm },
  galatTeks: { color: colors.danger, fontSize: 13, flex: 1 },
  galatKecil: { color: colors.danger, fontSize: 12 },
  tombol: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  tombolMati: { backgroundColor: colors.disabled },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 15 },
  prosesJudul: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  batang: { width: 260, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden', marginVertical: 6 },
  batangIsi: { height: 8, backgroundColor: colors.primary },
  sukses: { flexDirection: 'row', gap: spacing.md, alignItems: 'center', backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md },
  suksesJudul: { fontSize: 16, fontWeight: '800', color: colors.text },
  peringatan: { flexDirection: 'row', gap: 8, backgroundColor: colors.warningBg, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radius.md, padding: spacing.md },
  peringatanTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  // Selaras dengan ExportButton (tinggi & marginBottom 12) agar dua tombol sejajar rapi.
  barisAksi: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'flex-start' },
  tombolGaris: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, marginBottom: 12 },
  tombolGarisTeks: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  tabel: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  tabelBaris: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 6 },
  tabelKepala: { backgroundColor: colors.background },
  th: { fontSize: 11.5, fontWeight: '700', color: colors.textMuted },
  td: { fontSize: 12.5, color: colors.text },
  mono: { fontFamily: 'monospace' },
  cNo: { width: 64 },
  cNama: { flex: 1 },
  cUser: { width: 110 },
  cPass: { width: 100 },
});
