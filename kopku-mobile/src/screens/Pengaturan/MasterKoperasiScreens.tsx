import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import AppTextInput from '@/components/AppTextInput';
import { type InputTypeName } from '@/theme/form';
import { notify } from '@/store/useNotifyStore';
import {
  buatPersonel,
  listPersonel,
  perbaruiPersonel,
  setStatusPersonel,
  buatPerizinan,
  listPerizinan,
  perbaruiPerizinan,
  buatUnitUsaha,
  listUnitUsaha,
  perbaruiUnitUsaha,
  setStatusUnitUsaha,
  buatPeraturan,
  listPeraturan,
  perbaruiPeraturan,
  type JenisPersonel,
  type PersonelRow,
  type PerizinanRow,
  type StatusPerizinan,
  type UnitUsahaRow,
  type StatusUnitUsaha,
  type PeraturanRow,
  type StatusPeraturan,
  type SumberDataPersonel,
  SUMBER_DATA_PERSONEL,
  LABEL_SUMBER_DATA,
  getSusunanPengurusInti,
  JABATAN_PENGURUS_INTI,
  LABEL_JABATAN_PENGURUS,
} from '@/services/KoperasiMasterService';
import { kenaliJabatanPengurusInti, type JabatanPengurusInti, type SusunanPengurusInti } from '@/services/PengurusInti';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getIdentitasKoperasi } from '@/services/SetupService';
import { getAnggotaById, type Anggota } from '@/repositories/AnggotaRepository';
import AnggotaPicker from '@/components/AnggotaPicker';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';

/**
 * ============================================================
 * MASTER DATA IDENTITAS KOPERASI — LAYAR (Fase 7)
 * ============================================================
 *
 * Empat layar CRUD: personel, perizinan, unit usaha, peraturan internal.
 *
 * SATU BERKAS, BUKAN EMPAT. Keempatnya adalah daftar + modal form di
 * atas service yang sudah ada, dengan gaya yang sama persis. Memecahnya
 * akan menyalin blok `StyleSheet` dan primitif form yang identik empat
 * kali — dan salinan itulah yang kelak berbeda satu sama lain tanpa ada
 * yang menyadarinya. Primitif bersama (`Field`, `MasterModal`,
 * `BarisMaster`) didefinisikan sekali di bawah.
 *
 * TIDAK ADA SQL DI LAYAR INI. Seluruh baca/tulis lewat
 * `KoperasiMasterService`; identitas koperasi lewat `SetupService`.
 *
 * TIDAK ADA HAPUS PERMANEN. Master ini akan dirujuk transaksi pada fase
 * berikutnya, jadi yang tersedia hanya penonaktifan/perubahan status.
 *
 * SUMBER KEBENARAN ADALAH DATABASE. Setiap simpan diikuti `muat()` yang
 * membaca ulang dari service — tidak ada array lokal yang dimutasi lalu
 * dianggap benar.
 */

// ===========================================================================
// PRIMITIF BERSAMA
// ===========================================================================

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
  wajib,
  multiline,
  keyboardType,
  inputType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  wajib?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'phone-pad' | 'numeric';
  inputType?: InputTypeName;
}) {
  return (
    <AppTextInput
      label={label}
      required={wajib}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      multiline={multiline}
      keyboardType={keyboardType ?? 'default'}
      inputType={inputType}
      noIcon={!multiline && inputType === undefined}
    />
  );
}

/**
 * Isian tanggal berformat ISO (YYYY-MM-DD).
 *
 * SENGAJA teks, bukan date picker native: seluruh tanggal di aplikasi
 * ini disimpan sebagai string 'YYYY-MM-DD' dan dibandingkan sebagai
 * string. Mengubahnya lewat objek `Date` memperkenalkan pergeseran
 * zona waktu — tanggal yang dipilih 1 September bisa tersimpan 31
 * Agustus. Pola yang sama sudah dipakai `IdentitasKoperasiScreen`
 * untuk Tanggal Berdiri.
 */
function FieldTanggal(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  wajib?: boolean;
}) {
  return <Field {...props} placeholder="YYYY-MM-DD" inputType="date" />;
}

/**
 * Poin 3 — tanggal masa jabatan Pengurus/Pengawas/Karyawan/Pengelola
 * memakai `DatePicker` EXISTING (kalender native), bukan teks bebas.
 * Nilai yang disimpan TETAP string ISO 'YYYY-MM-DD' (format internal
 * existing, dihasilkan komponen dari tanggal LOKAL — tanpa pergeseran
 * zona waktu); tampilannya "4 Oktober 2026". Karena tanggal opsional
 * (NULL = masa jabatan tidak dibatasi), disediakan tombol "Kosongkan".
 */
function FieldTanggalKalender({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <DatePicker value={value || undefined} onChange={onChange} />
      {value ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Kosongkan ${label}`}
          onPress={() => onChange('')}
          style={styles.tanggalKosongkan}
        >
          <Ionicons name="close-circle-outline" size={14} color={colors.textMuted} />
          <Text style={styles.tanggalKosongkanText}>Kosongkan</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.catatanModal}>Kosong = tidak dibatasi.</Text>
      )}
    </View>
  );
}

/** ISO 'YYYY-MM-DD' yang benar-benar ada di kalender (menolak data lama berformat salah). */
function tanggalIsoValid(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const bulan = Number(m[2]);
  const hari = Number(m[3]);
  if (bulan < 1 || bulan > 12 || hari < 1) return false;
  const tahun = Number(m[1]);
  const kabisat = (tahun % 4 === 0 && tahun % 100 !== 0) || tahun % 400 === 0;
  const maks = [31, kabisat ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][bulan - 1];
  return hari <= maks;
}

function PilihanChip<T extends string>({
  label,
  nilai,
  pilihan,
  onPilih,
}: {
  label: string;
  nilai: T;
  pilihan: readonly T[];
  onPilih: (v: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {pilihan.map((p) => (
          <TouchableOpacity
            key={p}
            style={[styles.chip, nilai === p && styles.chipAktif]}
            onPress={() => onPilih(p)}
          >
            <Text style={[styles.chipText, nilai === p && styles.chipTextAktif]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

/** Baris identitas read-only (mode ANGGOTA) — nilainya berasal dari data anggota. */
function BarisIdentitas({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.barisIdentitas}>
      <Text style={styles.barisIdentitasLabel}>{label}</Text>
      <Text style={styles.barisIdentitasNilai}>{nilai.trim() === '' ? '-' : nilai}</Text>
    </View>
  );
}

function MasterModal({
  terlihat,
  judul,
  menyimpan,
  onTutup,
  onSimpan,
  children,
}: {
  terlihat: boolean;
  judul: string;
  menyimpan: boolean;
  onTutup: () => void;
  onSimpan: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={terlihat} animationType="slide" transparent onRequestClose={onTutup}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalWrap}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalJudul}>{judul}</Text>
            <TouchableOpacity onPress={onTutup} disabled={menyimpan}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={[styles.tombolSekunder, menyimpan && styles.tombolNonaktif]}
              onPress={onTutup}
              disabled={menyimpan}
            >
              <Text style={styles.tombolSekunderText}>Batal</Text>
            </TouchableOpacity>
            {/*
              Tombol dinonaktifkan selama penyimpanan sehingga ketukan
              ganda tidak mengirim dua permintaan. Ini KENYAMANAN, bukan
              jaminan: jaminannya tetap berada di service/database.
            */}
            <TouchableOpacity
              style={[styles.tombolUtama, menyimpan && styles.tombolNonaktif]}
              onPress={onSimpan}
              disabled={menyimpan}
            >
              {menyimpan ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.tombolUtamaText}>Simpan</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </AreaAmanKeyboard>
    </Modal>
  );
}

function Kondisi({
  memuat,
  galat,
  kosong,
  pesanKosong,
  onCobaLagi,
}: {
  memuat: boolean;
  galat: string | null;
  kosong: boolean;
  pesanKosong: string;
  onCobaLagi: () => void;
}) {
  if (memuat) {
    return (
      <View style={styles.kondisi}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.kondisiText}>Memuat data…</Text>
      </View>
    );
  }
  if (galat !== null) {
    return (
      <View style={styles.kondisi}>
        <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
        <Text style={styles.kondisiText}>{galat}</Text>
        <TouchableOpacity style={styles.tombolSekunder} onPress={onCobaLagi}>
          <Text style={styles.tombolSekunderText}>Coba Lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (kosong) {
    return (
      <View style={styles.kondisi}>
        <Ionicons name="folder-open-outline" size={22} color={colors.textFaint} />
        <Text style={styles.kondisiText}>{pesanKosong}</Text>
      </View>
    );
  }
  return null;
}

function BarisMaster({
  judul,
  subjudul,
  badge,
  badgeAktif,
  detail,
  onEdit,
  onToggle,
  labelToggle,
}: {
  judul: string;
  subjudul?: string | null;
  badge: string;
  badgeAktif: boolean;
  detail?: readonly (string | null)[];
  onEdit: () => void;
  onToggle?: () => void;
  labelToggle?: string;
}) {
  return (
    <View style={styles.baris}>
      <View style={styles.barisAtas}>
        <Text style={styles.barisJudul}>{judul}</Text>
        <View style={[styles.badge, badgeAktif ? styles.badgeAktif : styles.badgeNonaktif]}>
          <Text style={[styles.badgeText, badgeAktif ? styles.badgeTextAktif : styles.badgeTextNonaktif]}>
            {badge}
          </Text>
        </View>
      </View>
      {subjudul ? <Text style={styles.barisSub}>{subjudul}</Text> : null}
      {(detail ?? []).filter(Boolean).map((d, i) => (
        <Text key={i} style={styles.barisDetail}>
          {d}
        </Text>
      ))}
      <View style={styles.barisAksi}>
        <TouchableOpacity style={styles.aksi} onPress={onEdit}>
          <Ionicons name="create-outline" size={15} color={colors.primary} />
          <Text style={styles.aksiText}>Edit</Text>
        </TouchableOpacity>
        {onToggle ? (
          <TouchableOpacity style={styles.aksi} onPress={onToggle}>
            <Ionicons name="power-outline" size={15} color={colors.textMuted} />
            <Text style={[styles.aksiText, styles.aksiTextNetral]}>{labelToggle}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function pesanGalat(e: unknown, bawaan: string): string {
  return e instanceof Error && e.message ? e.message : bawaan;
}

// ===========================================================================
// PERSONEL
// ===========================================================================

const LABEL_PERSONEL: Record<JenisPersonel, string> = {
  PENGURUS: 'Pengurus',
  PENGAWAS: 'Pengawas',
  PENGELOLA: 'Pengelola',
  KARYAWAN: 'Karyawan',
  PEKERJA: 'Pekerja',
};

interface FormPersonel {
  id: string | null;
  /** ASAL orangnya — menentukan identitas diketik manual atau disalin dari anggota. */
  sumberData: SumberDataPersonel;
  /** Anggota terpilih (mode ANGGOTA). Objek penuh supaya kartu info bisa ditampilkan tanpa query ulang. */
  anggota: Anggota | null;
  nama: string;
  jenisKelamin: 'L' | 'P';
  jabatan: string;
  tanggalMulai: string;
  tanggalBerakhir: string;
  nik: string;
  telepon: string;
  alamat: string;
}

const FORM_PERSONEL_KOSONG: FormPersonel = {
  id: null,
  // Default "Anggota Koperasi": pengurus/pengawas koperasi pada
  // umumnya memang anggota, jadi jalur itu yang paling sering dipakai.
  sumberData: 'ANGGOTA',
  anggota: null,
  nama: '',
  jenisKelamin: 'L',
  jabatan: '',
  tanggalMulai: '',
  tanggalBerakhir: '',
  nik: '',
  telepon: '',
  alamat: '',
};

/**
 * Identitas anggota -> bentuk yang dipakai form personel.
 *
 * `anggota.jenis_kelamin` memakai domain 'LAKI_LAKI'/'PEREMPUAN',
 * sedangkan `koperasi_personel` memakai 'L'/'P' (CHECK constraint).
 * Nilai yang belum diisi TIDAK ditebak — jatuh ke 'L' hanya sebagai
 * nilai awal kontrol UI, sementara yang benar-benar tersimpan tetap
 * ditentukan ulang oleh service dari baris anggota.
 */
function prefillDariAnggota(a: Anggota): Pick<FormPersonel, 'nama' | 'jenisKelamin' | 'nik' | 'telepon' | 'alamat'> {
  return {
    nama: a.namaLengkap,
    jenisKelamin: a.jenisKelamin === 'PEREMPUAN' ? 'P' : 'L',
    nik: a.nik ?? '',
    telepon: a.nomorHp ?? '',
    alamat: a.alamat ?? '',
  };
}

/**
 * Satu layar untuk KELIMA jenis personel.
 *
 * Jenisnya datang dari parameter rute (`kategori`), bukan dari pilihan
 * pengguna: begitu layar dibuka dari section "Pengurus", jenisnya sudah
 * pasti PENGURUS dan menanyakannya lagi hanya membuka peluang salah
 * pilih. Untuk Pengelola/Karyawan/Pekerja, ketiganya berbagi layar yang
 * sama dengan chip kategori di atas.
 */
export function PersonelKoperasiScreen() {
  const route = useRoute() as { params?: { kategori?: JenisPersonel[]; judul?: string } };
  const kategori = useMemo<JenisPersonel[]>(
    () => route.params?.kategori ?? ['PENGURUS'],
    [route.params?.kategori]
  );

  const [jenisAktif, setJenisAktif] = useState<JenisPersonel>(kategori[0]);
  const [data, setData] = useState<PersonelRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);
  const [form, setForm] = useState<FormPersonel>(FORM_PERSONEL_KOSONG);
  const [nikKoperasi, setNikKoperasi] = useState<string | null>(null);
  /** RC-S82 — susunan Ketua/Sekretaris/Bendahara yang menjabat HARI INI (hanya kategori Pengurus). */
  const [susunan, setSusunan] = useState<SusunanPengurusInti | null>(null);
  /** Pilihan jabatan pada form Pengurus: salah satu jabatan inti, atau 'LAINNYA' (teks bebas, mis. Wakil Ketua). */
  const [pilihanJabatan, setPilihanJabatan] = useState<JabatanPengurusInti | 'LAINNYA'>('KETUA');

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setData(await listPersonel({ jenisPersonel: jenisAktif }));
      setSusunan(jenisAktif === 'PENGURUS' ? await getSusunanPengurusInti(getTanggalLokalHariIni()) : null);
      const identitas = await getIdentitasKoperasi();
      setNikKoperasi(identitas?.nomorIndukKoperasi ?? null);
    } catch (e) {
      setGalat(pesanGalat(e, 'Data personel gagal dimuat.'));
    } finally {
      setMemuat(false);
    }
  }, [jenisAktif]);

  useEffect(() => {
    void muat();
  }, [muat]);

  const bukaTambah = (jabatanInti?: JabatanPengurusInti) => {
    const jab: JabatanPengurusInti = jabatanInti ?? 'KETUA';
    setPilihanJabatan(jab);
    setForm({ ...FORM_PERSONEL_KOSONG, jabatan: jenisAktif === 'PENGURUS' ? LABEL_JABATAN_PENGURUS[jab] : '' });
    setModal(true);
  };

  const pilihJabatan = (j: JabatanPengurusInti | 'LAINNYA') => {
    setPilihanJabatan(j);
    setForm((f) => ({
      ...f,
      jabatan: j === 'LAINNYA' ? (kenaliJabatanPengurusInti(f.jabatan) ? '' : f.jabatan) : LABEL_JABATAN_PENGURUS[j],
    }));
  };

  const bukaEdit = async (r: PersonelRow) => {
    // Personel lama (pra-v70) terbaca `sumberData: 'LUAR'` — form
    // menampilkannya apa adanya. TIDAK ada pencocokan otomatis ke
    // anggota berdasarkan nama/NIK: kemiripan bukan bukti identitas.
    let anggota: Anggota | null = null;
    if (r.sumberData === 'ANGGOTA' && r.anggotaId) {
      // Baris tautannya sendiri yang dibaca, bukan ditebak dari snapshot.
      anggota = await getAnggotaById(r.anggotaId).catch(() => null);
    }
    setPilihanJabatan(kenaliJabatanPengurusInti(r.jabatan) ?? 'LAINNYA');
    setForm({
      id: r.id,
      sumberData: r.sumberData,
      anggota,
      nama: r.nama,
      jenisKelamin: r.jenisKelamin ?? 'L',
      jabatan: r.jabatan ?? '',
      tanggalMulai: r.tanggalMulaiJabatan ?? '',
      tanggalBerakhir: r.tanggalBerakhirJabatan ?? '',
      nik: r.nik ?? '',
      telepon: r.nomorTelepon ?? '',
      alamat: r.alamat ?? '',
    });
    setModal(true);
  };

  /**
   * Ganti mode. Perpindahan TIDAK pernah meninggalkan tautan basi:
   *   ANGGOTA -> LUAR : tautan diputus; snapshot yang sudah ada menjadi
   *                     data manual yang bisa diedit (tidak dikosongkan,
   *                     karena itu memang identitas orangnya).
   *   LUAR -> ANGGOTA : anggota WAJIB dipilih ulang; identitas dikosongkan
   *                     supaya tidak ada campuran data ketikan lama dengan
   *                     anggota baru yang belum dipilih.
   */
  const ubahSumberData = (sumber: SumberDataPersonel) => {
    if (sumber === form.sumberData) return;
    if (sumber === 'LUAR') {
      setForm({ ...form, sumberData: 'LUAR', anggota: null });
      return;
    }
    setForm({ ...form, sumberData: 'ANGGOTA', anggota: null, nama: '', nik: '', telepon: '', alamat: '' });
  };

  const pilihAnggota = (a: Anggota) => {
    setForm((f) => ({ ...f, anggota: a, ...prefillDariAnggota(a) }));
  };

  /**
   * Validasi layar. Aturan yang SUDAH dijaga service (nama wajib,
   * tanggal berakhir >= mulai) sengaja diperiksa juga di sini supaya
   * pesannya muncul sebelum modal tertutup — bukan menggantikan
   * service, yang tetap menjadi penjaga terakhir.
   */
  const validasi = (): string | null => {
    if (form.sumberData === 'ANGGOTA' && form.anggota === null) {
      return 'Pilih anggota koperasi terlebih dahulu.';
    }
    if (form.nama.trim() === '') return 'Nama wajib diisi.';
    if (form.jabatan.trim() === '') return 'Jabatan wajib diisi.';
    const mulai = form.tanggalMulai.trim();
    const akhir = form.tanggalBerakhir.trim();
    // Poin 3 — tanggal hanya dari kalender; data lama berformat salah ditolak.
    if (mulai !== '' && !tanggalIsoValid(mulai)) return 'Tanggal mulai jabatan tidak valid. Pilih ulang lewat kalender.';
    if (akhir !== '' && !tanggalIsoValid(akhir)) return 'Tanggal berakhir jabatan tidak valid. Pilih ulang lewat kalender.';
    if (mulai !== '' && akhir !== '' && akhir < mulai) {
      return 'Tanggal berakhir jabatan tidak boleh mendahului tanggal mulai.';
    }
    const nik = form.nik.trim();
    // NIK PERORANGAN tidak boleh diisi Nomor Induk Koperasi — keduanya
    // hal yang berbeda dan tertukar di sini akan menular ke fase
    // berikutnya yang memakai personel sebagai penerima imbalan.
    if (nik !== '' && nikKoperasi !== null && nik === nikKoperasi) {
      return 'NIK personel tidak boleh sama dengan Nomor Induk Koperasi.';
    }
    return null;
  };

  const simpan = async () => {
    const salah = validasi();
    if (salah !== null) {
      notify('Tidak dapat disimpan', salah);
      return;
    }
    setMenyimpan(true);
    try {
      const payload = {
        nama: form.nama,
        jenisPersonel: jenisAktif,
        sumberData: form.sumberData,
        // Mode LUAR mengirim null EKSPLISIT — service menolak tautan sisa.
        anggotaId: form.sumberData === 'ANGGOTA' ? (form.anggota?.id ?? null) : null,
        jenisKelamin: form.jenisKelamin,
        jabatan: form.jabatan,
        tanggalMulaiJabatan: form.tanggalMulai,
        tanggalBerakhirJabatan: form.tanggalBerakhir,
        nik: form.nik,
        nomorTelepon: form.telepon,
        alamat: form.alamat,
      };
      if (form.id === null) await buatPersonel(payload);
      else await perbaruiPersonel(form.id, payload);
      setModal(false);
      // Baca ulang dari database, bukan menyunting array lokal.
      await muat();
      notify('Tersimpan', `${LABEL_PERSONEL[jenisAktif]} berhasil disimpan.`);
    } catch (e) {
      notify('Gagal menyimpan', pesanGalat(e, 'Personel gagal disimpan.'));
    } finally {
      setMenyimpan(false);
    }
  };

  const ubahStatus = async (r: PersonelRow) => {
    try {
      await setStatusPersonel(r.id, !r.statusAktif);
      await muat();
    } catch (e) {
      notify('Gagal', pesanGalat(e, 'Status personel gagal diubah.'));
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.layar} contentContainerStyle={styles.layarIsi}>
      {kategori.length > 1 && (
        <View style={styles.chipRow}>
          {kategori.map((k) => (
            <TouchableOpacity
              key={k}
              style={[styles.chip, jenisAktif === k && styles.chipAktif]}
              onPress={() => setJenisAktif(k)}
            >
              <Text style={[styles.chipText, jenisAktif === k && styles.chipTextAktif]}>
                {LABEL_PERSONEL[k]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* RC-S82 — SUSUNAN PENGURUS INTI. Tiga jabatan yang menandatangani
          dokumen perjanjian pinjaman (UU 25/1992 Pasal 30 ayat (2) huruf a:
          Pengurus mewakili Koperasi di dalam dan di luar pengadilan). */}
      {jenisAktif === 'PENGURUS' && susunan && (
        <View style={styles.susunanKartu}>
          <View style={styles.susunanHeader}>
            <Ionicons name="people-outline" size={18} color={colors.primary} />
            <Text style={styles.susunanJudul}>Susunan Pengurus</Text>
          </View>
          <Text style={styles.susunanDesk}>
            Ketua menandatangani perjanjian pinjaman atas nama koperasi.
          </Text>
          {JABATAN_PENGURUS_INTI.map((j) => {
            const p = susunan[j];
            return (
              <View key={j} style={styles.susunanBaris}>
                <View style={styles.susunanJabatanWrap}>
                  <Text style={styles.susunanJabatan}>{LABEL_JABATAN_PENGURUS[j]}</Text>
                </View>
                <View style={styles.susunanIsi}>
                  {p ? (
                    <>
                      <Text style={styles.susunanNama} numberOfLines={2}>{p.nama}</Text>
                      <Text style={styles.susunanMasa}>
                        {p.tanggalMulaiJabatan ? `Sejak ${formatTanggalIndonesia(p.tanggalMulaiJabatan)}` : 'Masa jabatan tidak dibatasi'}
                        {p.tanggalBerakhirJabatan ? ` s.d. ${formatTanggalIndonesia(p.tanggalBerakhirJabatan)}` : ''}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.susunanKosong}>Belum ditetapkan</Text>
                  )}
                </View>
                {!p && (
                  <TouchableOpacity
                    style={styles.susunanTetapkan}
                    onPress={() => bukaTambah(j)}
                    accessibilityRole="button"
                    accessibilityLabel={`Tetapkan ${LABEL_JABATAN_PENGURUS[j]}`}
                  >
                    <Text style={styles.susunanTetapkanText}>Tetapkan</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      )}

      <TouchableOpacity style={styles.tombolTambah} onPress={() => bukaTambah()}>
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text style={styles.tombolTambahText}>Tambah {LABEL_PERSONEL[jenisAktif]}</Text>
      </TouchableOpacity>

      <Kondisi
        memuat={memuat}
        galat={galat}
        kosong={data.length === 0}
        pesanKosong={`Belum ada ${LABEL_PERSONEL[jenisAktif]}.`}
        onCobaLagi={() => void muat()}
      />

      {data.map((r) => (
        <BarisMaster
          key={r.id}
          judul={r.nama}
          subjudul={r.jabatan}
          badge={r.statusAktif ? 'Aktif' : 'Nonaktif'}
          badgeAktif={r.statusAktif}
          detail={[
            LABEL_PERSONEL[r.jenisPersonel],
            // Asal orangnya terlihat langsung di daftar, sebagai teks —
            // bukan hanya warna/ikon.
            LABEL_SUMBER_DATA[r.sumberData],
            r.tanggalMulaiJabatan ? `Mulai: ${formatTanggalIndonesia(r.tanggalMulaiJabatan)}` : null,
            r.tanggalBerakhirJabatan ? `Berakhir: ${formatTanggalIndonesia(r.tanggalBerakhirJabatan)}` : null,
          ]}
          onEdit={() => void bukaEdit(r)}
          onToggle={() => void ubahStatus(r)}
          labelToggle={r.statusAktif ? 'Nonaktifkan' : 'Aktifkan'}
        />
      ))}

      <MasterModal
        terlihat={modal}
        judul={`${form.id === null ? 'Tambah' : 'Edit'} ${LABEL_PERSONEL[jenisAktif]}`}
        menyimpan={menyimpan}
        onTutup={() => setModal(false)}
        onSimpan={() => void simpan()}
      >
        {/* SUMBER DATA — dipilih lebih dulu karena ia yang menentukan
            apakah identitas diketik manual atau disalin dari anggota. */}
        <Text style={styles.label}>Sumber Data</Text>
        <View style={styles.sumberRow}>
          {SUMBER_DATA_PERSONEL.map((sd) => {
            const aktif = form.sumberData === sd;
            return (
              <TouchableOpacity
                key={sd}
                accessibilityRole="button"
                accessibilityState={{ selected: aktif }}
                accessibilityLabel={`Sumber data: ${LABEL_SUMBER_DATA[sd]}`}
                style={[styles.sumberTombol, aktif && styles.sumberTombolAktif]}
                onPress={() => ubahSumberData(sd)}
              >
                <Text style={[styles.sumberTeks, aktif && styles.sumberTeksAktif]}>
                  {LABEL_SUMBER_DATA[sd]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {form.sumberData === 'ANGGOTA' ? (
          <>
            {/* Picker anggota yang SUDAH ADA dipakai apa adanya — sudah
                mencari nama/nomor anggota/NIK dan menyaring anggota aktif. */}
            <Text style={styles.label}>Anggota *</Text>
            <AnggotaPicker value={form.anggota} onChange={pilihAnggota} />
            {form.anggota && (
              <View style={styles.kartuAnggota}>
                <Text style={styles.kartuAnggotaNama}>{form.anggota.namaLengkap}</Text>
                <Text style={styles.kartuAnggotaSub}>{form.anggota.nomorAnggota}</Text>
                {form.anggota.nik ? <Text style={styles.kartuAnggotaSub}>NIK {form.anggota.nik}</Text> : null}
                <Text style={styles.kartuAnggotaCatatan}>
                  Identitas disalin dari data anggota saat disimpan. Memperbarui data anggota nanti
                  tidak mengubah catatan jabatan ini.
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <Field label="Nama" wajib value={form.nama} onChange={(v) => setForm({ ...form, nama: v })} />
            <PilihanChip
              label="Jenis Kelamin"
              nilai={form.jenisKelamin}
              pilihan={['L', 'P'] as const}
              onPilih={(v) => setForm({ ...form, jenisKelamin: v })}
            />
          </>
        )}

        {/* Jabatan & masa jabatan SELALU diedit manual — keduanya milik
            peran di koperasi, bukan bagian dari identitas anggota. */}
        {jenisAktif === 'PENGURUS' ? (
          <>
            <Text style={styles.label}>Jabatan *</Text>
            <View style={styles.sumberRow}>
              {([...JABATAN_PENGURUS_INTI, 'LAINNYA'] as const).map((j) => {
                const aktif = pilihanJabatan === j;
                return (
                  <TouchableOpacity
                    key={j}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: aktif }}
                    style={[styles.sumberTombol, aktif && styles.sumberTombolAktif]}
                    onPress={() => pilihJabatan(j)}
                  >
                    <Text style={[styles.sumberTeks, aktif && styles.sumberTeksAktif]}>
                      {j === 'LAINNYA' ? 'Lainnya' : LABEL_JABATAN_PENGURUS[j]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {pilihanJabatan === 'LAINNYA' ? (
              <Field label="Nama Jabatan" wajib value={form.jabatan} onChange={(v) => setForm({ ...form, jabatan: v })} />
            ) : (
              <Text style={styles.catatanModal}>
                Satu jabatan {LABEL_JABATAN_PENGURUS[pilihanJabatan]} hanya dapat dipegang satu orang pada masa jabatan yang
                sama. Untuk pergantian, isi tanggal berakhir jabatan pejabat lama terlebih dahulu.
              </Text>
            )}
          </>
        ) : (
          <Field label="Jabatan" wajib value={form.jabatan} onChange={(v) => setForm({ ...form, jabatan: v })} />
        )}
        <FieldTanggalKalender
          label="Tanggal Mulai Jabatan"
          value={form.tanggalMulai}
          onChange={(v) => setForm((f) => ({ ...f, tanggalMulai: v }))}
        />
        <FieldTanggalKalender
          label="Tanggal Berakhir Jabatan"
          value={form.tanggalBerakhir}
          onChange={(v) => setForm((f) => ({ ...f, tanggalBerakhir: v }))}
        />
        {/* Mode ANGGOTA: identitas ditampilkan read-only — sumbernya data
            anggota, jadi mengeditnya di sini hanya akan membuat dua versi
            yang berbeda tanpa ada yang tahu mana yang benar. */}
        {form.sumberData === 'ANGGOTA' ? (
          form.anggota ? (
            <View style={styles.identitasReadonly}>
              <BarisIdentitas label="NIK" nilai={form.nik} />
              <BarisIdentitas label="Jenis Kelamin" nilai={form.jenisKelamin === 'P' ? 'Perempuan' : 'Laki-laki'} />
              <BarisIdentitas label="No. Telepon" nilai={form.telepon} />
              <BarisIdentitas label="Alamat" nilai={form.alamat} />
            </View>
          ) : null
        ) : (
          <>
            <Field label="NIK" value={form.nik} onChange={(v) => setForm({ ...form, nik: v })} keyboardType="numeric" />
            <Field
              label="No. Telepon"
              value={form.telepon}
              onChange={(v) => setForm({ ...form, telepon: v })}
              keyboardType="phone-pad"
            />
            <Field label="Alamat" multiline value={form.alamat} onChange={(v) => setForm({ ...form, alamat: v })} />
          </>
        )}
        <Text style={styles.catatanModal}>
          Personel tidak dapat dihapus permanen karena dapat dirujuk transaksi. Gunakan
          &quot;Nonaktifkan&quot; bila sudah tidak menjabat.
        </Text>
      </MasterModal>
    </ScrollView>
  );
}

// ===========================================================================
// PERIZINAN
// ===========================================================================

const STATUS_IZIN: readonly StatusPerizinan[] = ['AKTIF', 'KEDALUWARSA', 'DICABUT'];

export function PerizinanKoperasiScreen() {
  const [data, setData] = useState<PerizinanRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);
  const [form, setForm] = useState({
    id: null as string | null,
    namaIzin: '',
    nomorIzin: '',
    tanggalTerbit: '',
    berlakuSampai: '',
    instansi: '',
    status: 'AKTIF' as StatusPerizinan,
    catatan: '',
  });

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setData(await listPerizinan());
    } catch (e) {
      setGalat(pesanGalat(e, 'Data perizinan gagal dimuat.'));
    } finally {
      setMemuat(false);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);

  const simpan = async () => {
    if (form.namaIzin.trim() === '') {
      notify('Tidak dapat disimpan', 'Nama izin wajib diisi.');
      return;
    }
    const terbit = form.tanggalTerbit.trim();
    const sampai = form.berlakuSampai.trim();
    if (terbit !== '' && sampai !== '' && sampai < terbit) {
      notify('Tidak dapat disimpan', 'Masa berlaku tidak boleh mendahului tanggal terbit.');
      return;
    }
    setMenyimpan(true);
    try {
      const payload = {
        namaIzin: form.namaIzin,
        nomorIzin: form.nomorIzin,
        tanggalTerbit: form.tanggalTerbit,
        berlakuSampai: form.berlakuSampai,
        instansiPenerbit: form.instansi,
        status: form.status,
        catatan: form.catatan,
      };
      if (form.id === null) await buatPerizinan(payload);
      else await perbaruiPerizinan(form.id, payload);
      setModal(false);
      await muat();
      notify('Tersimpan', 'Data perizinan berhasil disimpan.');
    } catch (e) {
      notify('Gagal menyimpan', pesanGalat(e, 'Perizinan gagal disimpan.'));
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.layar} contentContainerStyle={styles.layarIsi}>
      <TouchableOpacity
        style={styles.tombolTambah}
        onPress={() => {
          setForm({
            id: null,
            namaIzin: '',
            nomorIzin: '',
            tanggalTerbit: '',
            berlakuSampai: '',
            instansi: '',
            status: 'AKTIF',
            catatan: '',
          });
          setModal(true);
        }}
      >
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text style={styles.tombolTambahText}>Tambah Izin</Text>
      </TouchableOpacity>

      <Kondisi
        memuat={memuat}
        galat={galat}
        kosong={data.length === 0}
        pesanKosong="Belum ada perizinan."
        onCobaLagi={() => void muat()}
      />

      {data.map((r) => (
        <BarisMaster
          key={r.id}
          judul={r.namaIzin}
          subjudul={r.nomorIzin}
          badge={r.status}
          badgeAktif={r.status === 'AKTIF'}
          detail={[
            r.instansiPenerbit,
            r.tanggalTerbit ? `Terbit: ${r.tanggalTerbit}` : null,
            r.berlakuSampai ? `Berlaku sampai: ${r.berlakuSampai}` : 'Tanpa batas waktu',
          ]}
          onEdit={() => {
            setForm({
              id: r.id,
              namaIzin: r.namaIzin,
              nomorIzin: r.nomorIzin ?? '',
              tanggalTerbit: r.tanggalTerbit ?? '',
              berlakuSampai: r.berlakuSampai ?? '',
              instansi: r.instansiPenerbit ?? '',
              status: r.status,
              catatan: r.catatan ?? '',
            });
            setModal(true);
          }}
        />
      ))}

      <MasterModal
        terlihat={modal}
        judul={form.id === null ? 'Tambah Izin' : 'Edit Izin'}
        menyimpan={menyimpan}
        onTutup={() => setModal(false)}
        onSimpan={() => void simpan()}
      >
        <Field label="Nama Izin" wajib value={form.namaIzin} onChange={(v) => setForm({ ...form, namaIzin: v })} />
        <Field label="Nomor Izin" value={form.nomorIzin} onChange={(v) => setForm({ ...form, nomorIzin: v })} />
        <FieldTanggal
          label="Tanggal Terbit"
          value={form.tanggalTerbit}
          onChange={(v) => setForm({ ...form, tanggalTerbit: v })}
        />
        <FieldTanggal
          label="Berlaku Sampai Dengan"
          value={form.berlakuSampai}
          onChange={(v) => setForm({ ...form, berlakuSampai: v })}
        />
        <Field
          label="Instansi yang Menerbitkan"
          value={form.instansi}
          onChange={(v) => setForm({ ...form, instansi: v })}
        />
        <PilihanChip
          label="Status"
          nilai={form.status}
          pilihan={STATUS_IZIN}
          onPilih={(v) => setForm({ ...form, status: v })}
        />
        <Field label="Catatan" multiline value={form.catatan} onChange={(v) => setForm({ ...form, catatan: v })} />
        <Text style={styles.catatanModal}>
          Masa berlaku tidak diperpanjang otomatis. Perbarui status secara manual bila izin sudah
          kedaluwarsa atau dicabut.
        </Text>
      </MasterModal>
    </ScrollView>
  );
}

// ===========================================================================
// UNIT USAHA
// ===========================================================================

const STATUS_UNIT: readonly StatusUnitUsaha[] = ['AKTIF', 'NONAKTIF'];

export function UnitUsahaKoperasiScreen() {
  const [data, setData] = useState<UnitUsahaRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);
  const [form, setForm] = useState({
    id: null as string | null,
    namaUsaha: '',
    jenisUsaha: '',
    alamat: '',
    status: 'AKTIF' as StatusUnitUsaha,
  });

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setData(await listUnitUsaha());
    } catch (e) {
      setGalat(pesanGalat(e, 'Data unit usaha gagal dimuat.'));
    } finally {
      setMemuat(false);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);

  const simpan = async () => {
    if (form.namaUsaha.trim() === '') {
      notify('Tidak dapat disimpan', 'Nama usaha wajib diisi.');
      return;
    }
    setMenyimpan(true);
    try {
      const payload = {
        namaUsaha: form.namaUsaha,
        jenisUsaha: form.jenisUsaha,
        alamat: form.alamat,
        status: form.status,
      };
      if (form.id === null) await buatUnitUsaha(payload);
      else await perbaruiUnitUsaha(form.id, payload);
      setModal(false);
      await muat();
      notify('Tersimpan', 'Unit usaha berhasil disimpan.');
    } catch (e) {
      notify('Gagal menyimpan', pesanGalat(e, 'Unit usaha gagal disimpan.'));
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.layar} contentContainerStyle={styles.layarIsi}>
      <TouchableOpacity
        style={styles.tombolTambah}
        onPress={() => {
          setForm({ id: null, namaUsaha: '', jenisUsaha: '', alamat: '', status: 'AKTIF' });
          setModal(true);
        }}
      >
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text style={styles.tombolTambahText}>Tambah Unit Usaha</Text>
      </TouchableOpacity>

      <Kondisi
        memuat={memuat}
        galat={galat}
        kosong={data.length === 0}
        pesanKosong="Belum ada unit usaha."
        onCobaLagi={() => void muat()}
      />

      {data.map((r) => (
        <BarisMaster
          key={r.id}
          judul={r.namaUsaha}
          subjudul={r.jenisUsaha}
          badge={r.status}
          badgeAktif={r.status === 'AKTIF'}
          detail={[r.alamat, `ID Unit Usaha: ${r.id}`]}
          onEdit={() => {
            setForm({
              id: r.id,
              namaUsaha: r.namaUsaha,
              jenisUsaha: r.jenisUsaha ?? '',
              alamat: r.alamat ?? '',
              status: r.status,
            });
            setModal(true);
          }}
          onToggle={() => {
            void (async () => {
              try {
                await setStatusUnitUsaha(r.id, r.status === 'AKTIF' ? 'NONAKTIF' : 'AKTIF');
                await muat();
              } catch (e) {
                notify('Gagal', pesanGalat(e, 'Status unit usaha gagal diubah.'));
              }
            })();
          }}
          labelToggle={r.status === 'AKTIF' ? 'Nonaktifkan' : 'Aktifkan'}
        />
      ))}

      <MasterModal
        terlihat={modal}
        judul={form.id === null ? 'Tambah Unit Usaha' : 'Edit Unit Usaha'}
        menyimpan={menyimpan}
        onTutup={() => setModal(false)}
        onSimpan={() => void simpan()}
      >
        {form.id !== null && (
          // ID DITAMPILKAN TETAPI TIDAK DAPAT DIUBAH: ia akan menjadi
          // foreign key transaksi pada fase berikutnya, jadi mengubahnya
          // sama dengan memutus seluruh riwayat yang menunjuknya.
          <View style={styles.field}>
            <Text style={styles.label}>ID Unit Usaha</Text>
            <View style={styles.readonlyBox}>
              <Ionicons name="lock-closed-outline" size={15} color={colors.textMuted} />
              <Text style={styles.readonlyValue} selectable>
                {form.id}
              </Text>
            </View>
          </View>
        )}
        <Field label="Nama Usaha" wajib value={form.namaUsaha} onChange={(v) => setForm({ ...form, namaUsaha: v })} />
        <Field label="Jenis Usaha" value={form.jenisUsaha} onChange={(v) => setForm({ ...form, jenisUsaha: v })} />
        <Field label="Alamat" multiline value={form.alamat} onChange={(v) => setForm({ ...form, alamat: v })} />
        <PilihanChip
          label="Status"
          nilai={form.status}
          pilihan={STATUS_UNIT}
          onPilih={(v) => setForm({ ...form, status: v })}
        />
      </MasterModal>
    </ScrollView>
  );
}

// ===========================================================================
// PERATURAN INTERNAL
// ===========================================================================

const STATUS_ATURAN: readonly StatusPeraturan[] = ['BERLAKU', 'DICABUT', 'DIGANTI'];

export function PeraturanInternalScreen() {
  const [data, setData] = useState<PeraturanRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [menyimpan, setMenyimpan] = useState(false);
  const [form, setForm] = useState({
    id: null as string | null,
    namaDokumen: '',
    jenisDokumen: '',
    nomor: '',
    yangMenetapkan: '',
    status: 'BERLAKU' as StatusPeraturan,
    catatan: '',
  });

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setData(await listPeraturan());
    } catch (e) {
      setGalat(pesanGalat(e, 'Data peraturan internal gagal dimuat.'));
    } finally {
      setMemuat(false);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);

  const simpan = async () => {
    if (form.namaDokumen.trim() === '') {
      notify('Tidak dapat disimpan', 'Nama dokumen wajib diisi.');
      return;
    }
    setMenyimpan(true);
    try {
      const payload = {
        namaDokumen: form.namaDokumen,
        jenisDokumen: form.jenisDokumen,
        nomor: form.nomor,
        yangMenetapkan: form.yangMenetapkan,
        status: form.status,
        catatan: form.catatan,
      };
      if (form.id === null) await buatPeraturan(payload);
      else await perbaruiPeraturan(form.id, payload);
      setModal(false);
      await muat();
      notify('Tersimpan', 'Peraturan internal berhasil disimpan.');
    } catch (e) {
      notify('Gagal menyimpan', pesanGalat(e, 'Peraturan internal gagal disimpan.'));
    } finally {
      setMenyimpan(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.layar} contentContainerStyle={styles.layarIsi}>
      <TouchableOpacity
        style={styles.tombolTambah}
        onPress={() => {
          setForm({
            id: null,
            namaDokumen: '',
            jenisDokumen: '',
            nomor: '',
            yangMenetapkan: '',
            status: 'BERLAKU',
            catatan: '',
          });
          setModal(true);
        }}
      >
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text style={styles.tombolTambahText}>Tambah Peraturan</Text>
      </TouchableOpacity>

      <Kondisi
        memuat={memuat}
        galat={galat}
        kosong={data.length === 0}
        pesanKosong="Belum ada peraturan internal."
        onCobaLagi={() => void muat()}
      />

      {data.map((r) => (
        <BarisMaster
          key={r.id}
          judul={r.namaDokumen}
          subjudul={r.nomor}
          badge={r.status}
          badgeAktif={r.status === 'BERLAKU'}
          detail={[r.jenisDokumen, r.yangMenetapkan ? `Ditetapkan: ${r.yangMenetapkan}` : null]}
          onEdit={() => {
            setForm({
              id: r.id,
              namaDokumen: r.namaDokumen,
              jenisDokumen: r.jenisDokumen ?? '',
              nomor: r.nomor ?? '',
              yangMenetapkan: r.yangMenetapkan ?? '',
              status: r.status,
              catatan: r.catatan ?? '',
            });
            setModal(true);
          }}
        />
      ))}

      <MasterModal
        terlihat={modal}
        judul={form.id === null ? 'Tambah Peraturan' : 'Edit Peraturan'}
        menyimpan={menyimpan}
        onTutup={() => setModal(false)}
        onSimpan={() => void simpan()}
      >
        <Field
          label="Nama Dokumen"
          wajib
          value={form.namaDokumen}
          onChange={(v) => setForm({ ...form, namaDokumen: v })}
        />
        <Field
          label="Jenis Dokumen"
          value={form.jenisDokumen}
          onChange={(v) => setForm({ ...form, jenisDokumen: v })}
        />
        <Field label="Nomor" value={form.nomor} onChange={(v) => setForm({ ...form, nomor: v })} />
        <Field
          label="Yang Menetapkan"
          value={form.yangMenetapkan}
          onChange={(v) => setForm({ ...form, yangMenetapkan: v })}
        />
        <PilihanChip
          label="Status"
          nilai={form.status}
          pilihan={STATUS_ATURAN}
          onPilih={(v) => setForm({ ...form, status: v })}
        />
        <Field label="Catatan" multiline value={form.catatan} onChange={(v) => setForm({ ...form, catatan: v })} />
        <Text style={styles.catatanModal}>
          Dokumen yang sudah tidak berlaku TIDAK dihapus — ubah statusnya menjadi Dicabut atau
          Diganti agar riwayatnya tetap dapat ditelusuri.
        </Text>
      </MasterModal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  layar: { flex: 1, backgroundColor: colors.background },

  // Sumber data personel (Anggota Koperasi / Pihak Luar).
  sumberRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  sumberTombol: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sumberTombolAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  sumberTeks: { fontSize: 13, fontWeight: '600', color: colors.text },
  sumberTeksAktif: { color: colors.white, fontWeight: '700' },
  kartuAnggota: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kartuAnggotaNama: { fontSize: 14, fontWeight: '700', color: colors.text },
  kartuAnggotaSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  kartuAnggotaCatatan: { fontSize: 11, color: colors.textFaint, marginTop: spacing.sm, lineHeight: 15 },
  identitasReadonly: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  barisIdentitas: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 9,
  },
  barisIdentitasLabel: { fontSize: 12, color: colors.textMuted },
  barisIdentitasNilai: { fontSize: 12, color: colors.text, fontWeight: '600', flex: 1, textAlign: 'right' },

  layarIsi: { padding: spacing.md, paddingBottom: spacing.xl },

  tombolTambah: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  tombolTambahText: { color: colors.white, fontWeight: '700', fontSize: 14 },

  kondisi: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  kondisiText: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },

  baris: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  barisAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barisJudul: { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1 },
  barisSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  barisDetail: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  barisAksi: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  aksi: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  aksiText: { fontSize: 12, fontWeight: '600', color: colors.primary },
  aksiTextNetral: { color: colors.textMuted },

  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeAktif: { backgroundColor: '#E6F4EA' },
  badgeNonaktif: { backgroundColor: '#F0F0F0' },
  badgeText: { fontSize: 10, fontWeight: '700' },
  badgeTextAktif: { color: colors.success },
  badgeTextNonaktif: { color: colors.textMuted },

  field: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: spacing.xs },
  wajib: { color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  readonlyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
  },
  readonlyValue: { fontSize: 12, color: colors.textMuted, flex: 1 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextAktif: { color: colors.white },

  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modalCard: { ...modalUi.card },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalJudul: { fontSize: 15, fontWeight: '700', color: colors.text },
  modalBody: { padding: spacing.md },
  modalFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  tombolUtama: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  tombolUtamaText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  tombolSekunder: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  tombolSekunderText: { color: colors.textMuted, fontWeight: '600', fontSize: 14 },
  tombolNonaktif: { opacity: 0.6 },
  catatanModal: { fontSize: 11, color: colors.textFaint, lineHeight: 16, marginBottom: spacing.md },
  tanggalKosongkan: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: spacing.xs, marginTop: 2 },
  tanggalKosongkanText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

  // RC-S82 — kartu Susunan Pengurus (Ketua / Sekretaris / Bendahara)
  susunanKartu: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  susunanHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  susunanJudul: { fontSize: 15, fontWeight: '800', color: colors.text },
  susunanDesk: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.xs, marginBottom: spacing.sm },
  susunanBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  susunanJabatanWrap: { width: 92 },
  susunanJabatan: { fontSize: 12, fontWeight: '700', color: colors.primary, letterSpacing: 0.3 },
  susunanIsi: { flex: 1, minWidth: 0 },
  susunanNama: { fontSize: 14, fontWeight: '700', color: colors.text },
  susunanMasa: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  susunanKosong: { fontSize: 13, color: colors.danger, fontStyle: 'italic' },
  susunanTetapkan: { paddingHorizontal: spacing.md, minHeight: 36, justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.primary },
  susunanTetapkanText: { fontSize: 12, fontWeight: '700', color: colors.primary },
});
