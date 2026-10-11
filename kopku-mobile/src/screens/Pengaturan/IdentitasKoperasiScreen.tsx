import React, { useCallback, useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import {
  getIdentitasKoperasi,
  updateIdentitasKoperasi,
  hitungIdentityCompletion,
  bolehGantiTahunBuku,
  IdentitasKoperasiRow,
} from '@/services/SetupService';
import { hapusBerkasLogoLama, pilihLogoDariGaleri } from '@/services/LogoKoperasiService';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';

/**
 * ============================================================
 * IDENTITAS KOPERASI (§20-§24, §27, §28 permintaan pengguna)
 * ============================================================
 *
 * Memisahkan SETUP MINIMUM (Nama Koperasi + Tahun Buku, §8) dari
 * IDENTITAS LENGKAP. Layar ini dijangkau dari Dashboard -> "Lengkapi
 * Identitas Koperasi" dan TIDAK PERNAH menghalangi transaksi (§22).
 *
 * FIELD YANG DITAMPILKAN — hanya yang BENAR-BENAR didukung skema
 * (§20/§21). Seluruhnya kolom tabel `koperasi` yang sudah ada sejak
 * CREATE_TABLES_SQL: nama, tanggal_berdiri, alamat, telepon, email,
 * nomor_badan_hukum, npwp, logo_uri, tahun_buku_aktif. TIDAK ADA kolom
 * database baru yang dibuat untuk layar ini.
 *
 * NOT IMPLEMENTED (didokumentasikan, bukan dikarang): provinsi,
 * kabupaten/kota, kode pos, faksimile, situs web, Nomor Induk Koperasi,
 * jenis koperasi. Tidak ada kolomnya dan tidak ada laporan yang
 * memakainya — menambahkannya butuh migrasi skema tersendiri.
 *
 * TAHUN BUKU (§27/§28) bersifat READ-ONLY begitu ada data akuntansi
 * (jurnal tercatat atau periode tertutup) — lihat
 * `SetupService.bolehGantiTahunBuku()`. Layar ini TIDAK PERNAH mengubah
 * tahun buku; ia hanya menampilkannya beserta alasan penguncian.
 *
 * TIDAK ADA EFEK SAMPING AKUNTANSI (§26/§34): Simpan hanya melakukan
 * satu UPDATE pada tabel `koperasi` di dalam satu transaksi (atomic,
 * tidak mungkin partial state). Tidak ada jurnal/subledger yang dibuat.
 */
/**
 * ============================================================
 * RC-S49b §B — LAYAR INI TIDAK LAGI HIDUP DI DALAM PENGATURAN
 * ============================================================
 *
 * Sampai RC-S48, `IdentitasKoperasi` terdaftar di `PengaturanStack`.
 * Konsekuensinya berantai:
 *
 *   - Dashboard harus membukanya dengan navigasi bersarang
 *     `navigate('Pengaturan', { screen: 'IdentitasKoperasi' })`, yang
 *     MENGAKTIFKAN tab Pengaturan dan menaruh `PengaturanMenu` di
 *     bawah layar ini.
 *   - Back bawaan lalu mendarat di menu Pengaturan — layar yang tidak
 *     pernah dibuka pengguna.
 *   - Untuk menambalnya, layar ini menerima parameter `asal`, menimpa
 *     `headerLeft`, DAN memasang `BackHandler` sendiri: tiga mekanisme
 *     yang semuanya ada hanya untuk mengoreksi satu keputusan
 *     pendaftaran rute yang salah.
 *
 * RC-S49b memperbaiki penyebabnya: rutenya dipindah ke `RootStack`,
 * sejajar dengan `Tabs`, sebagai destination independen. Begitu itu
 * benar, ketiga tambalan di atas TIDAK LAGI DIPERLUKAN dan dihapus:
 *
 *   - `asal` tidak dibutuhkan karena tidak ada lagi dua asal yang
 *     berbeda maknanya. Dari mana pun layar ini dibuka, ia di-push ke
 *     atas layar pemanggilnya.
 *   - `goBack()` bawaan SUDAH benar: ia kembali ke `Tabs` dengan tab
 *     yang sedang aktif tetap aktif — dibuka dari Dashboard, kembali
 *     ke Dashboard.
 *   - Back perangkat keras Android juga sudah `goBack()` bawaan, jadi
 *     tombol layar dan tombol fisik mustahil berbeda.
 *
 * Berkas layar, service, dan skema TIDAK berubah sama sekali. Yang
 * dihapus hanyalah kode navigasi yang keberadaannya bergantung pada
 * struktur lama.
 */
export default function IdentitasKoperasiScreen() {
  const navigation = useNavigation<any>();
  const setKoperasi = useAppStore((s) => s.setKoperasi);

  /**
   * SATU tujuan kembali untuk SEMUA jalan keluar (RC-S48 §D/§E/§I,
   * dipertahankan): dipakai penyelesaian Simpan, dan sama dengan yang
   * dilakukan tombol back bawaan header maupun tombol fisik Android.
   * Menuliskannya sekali membuat ketiganya mustahil berbeda.
   *
   * `canGoBack()` mendahului `goBack()` — jangan pernah memanggil
   * goBack() pada stack kosong. Cabang fallback praktis tidak pernah
   * terjadi (rute `Tabs` selalu berada di bawah layar ini), tetapi ia
   * memastikan kegagalan berujung di Dashboard, bukan di layar buntu.
   *
   * Tidak ada `reset()`/`replace()` di sini: riwayat navigasi pengguna
   * tidak boleh dibuang (§B3).
   */
  const kembali = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate('Tabs', { screen: 'Dashboard' });
  }, [navigation]);

  const kembaliSetelahSimpan = kembali;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identitas, setIdentitas] = useState<IdentitasKoperasiRow | null>(null);
  const [kunciTahunBuku, setKunciTahunBuku] = useState<string | null>(null);

  const [nama, setNama] = useState('');
  const [tanggalBerdiri, setTanggalBerdiri] = useState('');
  const [alamat, setAlamat] = useState('');
  const [telepon, setTelepon] = useState('');
  const [email, setEmail] = useState('');
  // Fase 7 — AHU menggantikan label "Nomor Badan Hukum". Nilainya
  // ditulis SetupService ke kedua kolom sekaligus, jadi layar ini cukup
  // memegang satu state. NIK KOPERASI berdiri sendiri dan TIDAK ada
  // hubungannya dengan NIK perorangan personel.
  const [nomorAhu, setNomorAhu] = useState('');
  const [nomorIndukKoperasi, setNomorIndukKoperasi] = useState('');
  const [npwp, setNpwp] = useState('');
  const [logoUri, setLogoUri] = useState('');
  /**
   * RC-S100 — URI logo yang tersimpan di database saat layar dimuat.
   * Diingat supaya salinan berkas LAMA baru dibersihkan setelah
   * penyimpanan berhasil (lihat `hapusBerkasLogoLama`).
   */
  const [logoUriAwal, setLogoUriAwal] = useState('');
  const [memilihLogo, setMemilihLogo] = useState(false);

  const muat = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await getIdentitasKoperasi();
      const kunci = await bolehGantiTahunBuku();
      setIdentitas(row);
      setKunciTahunBuku(kunci.boleh ? null : kunci.alasan);
      if (row) {
        setNama(row.nama ?? '');
        setTanggalBerdiri(row.tanggalBerdiri ?? '');
        setAlamat(row.alamat ?? '');
        setTelepon(row.telepon ?? '');
        setEmail(row.email ?? '');
        setNomorAhu(row.nomorAhu ?? '');
        setNomorIndukKoperasi(row.nomorIndukKoperasi ?? '');
        setNpwp(row.npwp ?? '');
        setLogoUri(row.logoUri ?? '');
        setLogoUriAwal(row.logoUri ?? '');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat identitas koperasi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    muat();
  }, [muat]);

  /**
   * RC-S100 — pilih logo dari galeri. URI yang disimpan ke state adalah
   * SALINAN permanen (lihat LogoKoperasiService); belum masuk database
   * sampai pengguna menekan Simpan, jadi membatalkan perubahan cukup
   * dengan meninggalkan layar tanpa menyimpan.
   */
  const pilihLogo = async () => {
    setMemilihLogo(true);
    try {
      const hasil = await pilihLogoDariGaleri();
      if (hasil) setLogoUri(hasil.uri);
    } catch (e) {
      notify('Gagal memilih logo', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemilihLogo(false);
    }
  };

  const simpan = async () => {
    if (nama.trim().length < 3) {
      notify('Tidak dapat disimpan', 'Nama koperasi minimal 3 karakter.');
      return;
    }
    setSaving(true);
    try {
      // Atomic (§24): satu transaksi di service. Kalau gagal, TIDAK ADA
      // sebagian field yang tersimpan.
      await updateIdentitasKoperasi({
        nama,
        tanggalBerdiri,
        alamat,
        telepon,
        email,
        nomorAhu,
        nomorIndukKoperasi,
        npwp,
        logoUri,
      });
      // Sinkronkan store supaya header laporan (yang memakai
      // `koperasi.nama`) langsung konsisten — ini murni METADATA
      // laporan, TIDAK mengubah nilai akuntansi apa pun (§25).
      const segar = await getIdentitasKoperasi();
      if (segar) {
        setKoperasi({
          id: segar.id,
          nama: segar.nama,
          standarAkuntansi: segar.standarAkuntansi,
          tahunBukuAktif: segar.tahunBukuAktif,
          logoUri: segar.logoUri ?? undefined,
        });
      }
      // RC-S100 — salinan logo LAMA dibersihkan hanya setelah URI baru
      // benar-benar tersimpan; kalau penyimpanan gagal, berkas lama masih
      // ada dan logo tidak hilang.
      await hapusBerkasLogoLama(logoUriAwal || null, logoUri || null);
      setLogoUriAwal(logoUri);
      setIdentitas(segar);
      notify('Tersimpan', 'Identitas koperasi berhasil diperbarui.');
      // Navigasi dilakukan LANGSUNG, tidak menunggu pengguna menekan OK
      // pada notifikasi: §K menuntut "langsung kembali", dan host
      // notifikasi hidup di atas navigator sehingga pesannya tetap
      // terlihat setelah layar berpindah.
      kembaliSetelahSimpan();
    } catch (e) {
      notify('Gagal menyimpan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  const completion = hitungIdentityCompletion(identitas);

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={[styles.statusBanner, completion.status === 'COMPLETE' ? styles.statusOk : styles.statusWarn]}>
          <Ionicons
            name={completion.status === 'COMPLETE' ? 'checkmark-circle' : 'alert-circle-outline'}
            size={18}
            color={completion.status === 'COMPLETE' ? colors.success : '#E65100'}
          />
          <Text style={styles.statusText}>
            {completion.status === 'COMPLETE'
              ? 'Identitas lengkap'
              : `Belum lengkap — ${completion.fieldBelumTerisi.join(', ')}`}
          </Text>
        </View>

        <SectionHeader icon="information-circle-outline" label="Informasi Dasar" />
        <Field label="Nama Koperasi *" value={nama} onChange={setNama} placeholder="Tulis nama koperasi" />
        <Field
          label="Tanggal Berdiri"
          value={tanggalBerdiri}
          onChange={setTanggalBerdiri}
          placeholder="YYYY-MM-DD"
        />

        <View style={styles.readonlyField}>
          <Text style={styles.label}>Tahun Buku</Text>
          <View style={styles.readonlyBox}>
            <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
            <Text style={styles.readonlyValue}>{identitas?.tahunBukuAktif ?? '-'}</Text>
          </View>
          <Text style={styles.hint}>
            {kunciTahunBuku ??
              'Tahun buku belum dikunci, namun perubahannya hanya boleh dilakukan sebelum ada transaksi apa pun.'}
          </Text>
        </View>

        <SectionHeader icon="location-outline" label="Alamat" />
        <Field label="Alamat" value={alamat} onChange={setAlamat} multiline placeholder="Alamat lengkap koperasi" />

        <SectionHeader icon="call-outline" label="Kontak" />
        <Field label="Nomor Telepon" value={telepon} onChange={setTelepon} keyboardType="phone-pad" />
        <Field label="Email" value={email} onChange={setEmail} keyboardType="email-address" />

        <SectionHeader icon="document-text-outline" label="Administratif" />
        <Field
          label="Nomor Administrasi Hukum Umum (AHU)"
          value={nomorAhu}
          onChange={setNomorAhu}
          placeholder="Nomor pengesahan badan hukum"
        />
        <Field
          label="Nomor Induk Koperasi (NIK)"
          value={nomorIndukKoperasi}
          onChange={setNomorIndukKoperasi}
          placeholder="Nomor induk koperasi"
        />
        <Text style={styles.hint}>
          Nomor Induk Koperasi adalah identitas KOPERASI — berbeda dari NIK (KTP) pengurus,
          pengawas, atau karyawan yang dicatat pada masing-masing data personel.
        </Text>
        <Field label="NPWP" value={npwp} onChange={setNpwp} />

        <SectionHeader icon="image-outline" label="Branding" />
        {/*
          RC-S100 — LOGO DIPILIH LANGSUNG DARI BERKAS GAMBAR.

          Sebelumnya di sini ada kotak teks "Logo (URI)" yang menuntut
          pengguna MENGETIK alamat berkas — praktis tidak mungkin di ponsel,
          dan tidak ada satu pun tempat di aplikasi yang menampilkan
          hasilnya. Sekarang: galeri, pratinjau, dan logo tampil di
          Dashboard serta kop PDF hasil export.

          Gambar yang dipilih DISALIN ke penyimpanan permanen aplikasi —
          lihat LogoKoperasiService untuk alasannya (URI galeri bisa
          kedaluwarsa dan logo akan hilang sendiri di kemudian hari).
        */}
        <View style={styles.logoBaris}>
          <View style={styles.logoKotak}>
            {logoUri ? (
              <Image source={{ uri: logoUri }} style={styles.logoGambar} resizeMode="contain" />
            ) : (
              <Ionicons name="image-outline" size={26} color={colors.textFaint} />
            )}
          </View>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <TouchableOpacity
              style={styles.tombolLogo}
              onPress={pilihLogo}
              disabled={memilihLogo}
              testID="tombol-pilih-logo"
            >
              {memilihLogo ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <>
                  <Ionicons name="images-outline" size={iconSize.sm} color={colors.primary} />
                  <Text style={styles.tombolLogoText}>{logoUri ? 'Ganti Logo' : 'Pilih Logo'}</Text>
                </>
              )}
            </TouchableOpacity>
            {logoUri ? (
              <TouchableOpacity style={styles.tombolHapusLogo} onPress={() => setLogoUri('')} testID="tombol-hapus-logo">
                <Ionicons name="trash-outline" size={iconSize.sm} color={colors.danger} />
                <Text style={styles.tombolHapusLogoText}>Hapus Logo</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <Text style={styles.hint}>
          Logo bersifat opsional — laporan tetap dapat dicetak tanpa logo. Setelah disimpan, logo tampil di Dashboard dan
          di kop laporan PDF hasil export. Maksimal 2 MB, sebaiknya gambar persegi berlatar putih atau transparan.
        </Text>

        {/*
          RESTRUKTURISASI DATA — section "Administrasi" DIHAPUS dari sini.

          Enam pintasan (Pengurus, Pengawas, Pengelola/Karyawan/Pekerja,
          Perizinan, Unit Usaha, Peraturan Internal) dipindah ke tab
          Data, karena di sinilah letak kebingungannya: layar yang
          bernama "Identitas Koperasi" menjanjikan data koperasi itu
          sendiri, bukan daftar orang dan izin. Pengguna harus menebak
          bahwa Pengurus berada di dalam form identitas.

          Yang berpindah HANYA menunya. Tabel `koperasi_personel`,
          `koperasi_perizinan`, `koperasi_unit_usaha`,
          `koperasi_peraturan`, service-nya, dan layarnya
          (MasterKoperasiScreens.tsx) SAMA SEKALI tidak berubah —
          komponen yang sama kini didaftarkan di AnggotaStack (tab Data).
          Tidak ada data yang dihapus.
        */}

        <TouchableOpacity style={[styles.saveButton, saving && styles.saveButtonDisabled]} onPress={simpan} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.saveText}>Simpan</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.footerNote}>
          Menyimpan identitas hanya memperbarui data koperasi. Tidak ada jurnal, saldo, atau laporan
          keuangan yang berubah nilainya.
        </Text>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function SectionHeader({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={styles.sectionLabel}>{label}</Text>
    </View>
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
  value,
  onChange,
  placeholder,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: any;
}) {
  return (
    <AppTextInput
      label={label}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      multiline={multiline}
      keyboardType={keyboardType}
      noIcon={!multiline}
    />
  );
}

const styles = StyleSheet.create({
  // RC-S100 — pemilih logo.
  logoBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xs },
  logoKotak: {
    width: 76,
    height: 76,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoGambar: { width: '100%', height: '100%' },
  tombolLogo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
  },
  tombolLogoText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  tombolHapusLogo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  tombolHapusLogoText: { fontSize: 12, fontWeight: '600', color: colors.danger },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  errorText: { color: colors.danger, textAlign: 'center' },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  statusOk: { backgroundColor: '#E8F5E9' },
  statusWarn: { backgroundColor: '#FFF3E0' },
  statusText: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.text, lineHeight: 17 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.lg, marginBottom: spacing.sm },
  sectionLabel: { fontSize: 14, fontWeight: '700', color: colors.primary },
  field: { marginBottom: spacing.md },
  readonlyField: { marginBottom: spacing.md },
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
  inputMultiline: { minHeight: 70, textAlignVertical: 'top', paddingTop: 10 },
  readonlyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  readonlyValue: { fontSize: 15, color: colors.textMuted, fontWeight: '600' },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  saveButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  saveButtonDisabled: { backgroundColor: colors.disabled },
  saveText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  footerNote: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md, marginBottom: 40, lineHeight: 16 },
});
