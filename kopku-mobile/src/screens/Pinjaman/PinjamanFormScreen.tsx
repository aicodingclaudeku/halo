import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import AnggotaPicker from '@/components/AnggotaPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import { Anggota, getAnggotaById } from '@/repositories/AnggotaRepository';
import {
  ajukanPinjaman,
  editPinjaman,
  getPinjamanDetail,
  BiayaAdminKlasifikasi,
} from '@/services/PinjamanService';
import { getSaldoSimpananAnggota } from '@/services/SimpananService';
import { MetodeJasa, SatuanTenor } from '@/accounting/PinjamanCalculator';
import { useAppStore } from '@/store/useAppStore';
import { colors, elevation, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import AppTextInput from '@/components/AppTextInput';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { notify } from '@/store/useNotifyStore';
import {
  TujuanPinjaman,
  JenisAgunan,
  LABEL_TUJUAN_PINJAMAN,
  LABEL_JENIS_AGUNAN,
} from '@/services/PinjamanService';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

// RC-S54 §11 — URUTAN TAMPILAN saja: Efektif, Flat, Menurun.
// Nilai enum, perhitungan, default, dan seluruh engine jasa TIDAK
// disentuh — `MetodeJasa` dan kalkulatornya tetap sama persis. 'CUSTOM'
// tetap di akhir seperti sebelumnya karena bukan salah satu dari tiga
// metode yang diminta diurutkan ulang.
const METODE_OPTIONS: { value: MetodeJasa; label: string }[] = [
  { value: 'EFEKTIF', label: 'Efektif' },
  { value: 'FLAT', label: 'Flat' },
  { value: 'MENURUN', label: 'Menurun' },
  { value: 'CUSTOM', label: 'Custom' },
];

const TENOR_SATUAN_OPTIONS: { value: SatuanTenor; label: string }[] = [
  { value: 'HARI', label: 'Hari' },
  { value: 'MINGGU', label: 'Minggu' },
  { value: 'BULAN', label: 'Bulan' },
];

const BIAYA_ADMIN_OPTIONS: { value: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA'; label: string }[] = [
  { value: 'TIDAK_ADA', label: 'Tidak ada' },
  { value: 'NOMINAL', label: 'Nominal tetap' },
  { value: 'PERSENTASE', label: 'Persentase' },
];

/**
 * Form pengajuan pinjaman baru (PRD §11-12) — admin memilih metode jasa
 * sendiri.
 *
 * Bug fix (Edit Pinjaman): screen ini SEKARANG juga dipakai untuk edit
 * pinjaman yang BELUM dicairkan — dibuka dengan `route.params.pinjamanId`
 * dari Detail Pinjaman. Field & validasi form TETAP SAMA; bedanya hanya
 * prefill data existing (lewat getPinjamanDetail) dan submit memanggil
 * `editPinjaman()` (bukan `ajukanPinjaman()`). Anggota TIDAK BISA diubah
 * dalam mode edit (lihat AnggotaPicker `disabled` — editPinjaman() sengaja
 * tidak mengubah anggota_id, konsisten dengan aturan "loan ID/nomor
 * pinjaman/historical journal tidak berubah").
 */
export default function PinjamanFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const editPinjamanId: string | undefined = route.params?.pinjamanId;
  const isEditMode = !!editPinjamanId;
  const [loadingEdit, setLoadingEdit] = useState(isEditMode);

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  // RC-S54 item 24 & 25 — tujuan pinjaman & agunan.
  const [tujuanPinjaman, setTujuanPinjaman] = useState<TujuanPinjaman | null>(null);
  const [tujuanDetail, setTujuanDetail] = useState('');
  const [adaAgunan, setAdaAgunan] = useState(false);
  const [jenisAgunan, setJenisAgunan] = useState<JenisAgunan | null>(null);
  const [pemilikAgunan, setPemilikAgunan] = useState('');
  const [nomorDokumenAgunan, setNomorDokumenAgunan] = useState('');
  const [nilaiAgunan, setNilaiAgunan] = useState<number | ''>('');
  const [jumlahPinjaman, setJumlahPinjaman] = useState<number | ''>('');
  const [tenor, setTenor] = useState('');
  const [satuanTenor, setSatuanTenor] = useState<SatuanTenor>('BULAN');
  const [metodeJasa, setMetodeJasa] = useState<MetodeJasa>('FLAT');
  // PHASE 4 §L (permintaan pengguna): modal peringatan FLAT — HANYA
  // dipicu saat user AKTIF memilih FLAT (lewat pilihMetodeJasa di
  // bawah), BUKAN saat mount/render biasa walau default metodeJasa
  // memang 'FLAT' (state awal TIDAK memicu modal, hanya interaksi
  // eksplisit yang memicu — lihat useState di atas vs onPress di bawah).
  const [flatModalOpen, setFlatModalOpen] = useState(false);
  const pilihMetodeJasa = (value: MetodeJasa) => {
    setMetodeJasa(value);
    if (value === 'FLAT') setFlatModalOpen(true);
  };
  const [persentaseJasa, setPersentaseJasa] = useState('');
  const [biayaAdminTipe, setBiayaAdminTipe] = useState<'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA'>('TIDAK_ADA');
  const [biayaAdminNilai, setBiayaAdminNilai] = useState('');
  /**
   * REQUIREMENT 7 (permintaan pengguna) — klasifikasi akuntansi biaya
   * administrasi: "Jasa Terpisah" (SEPARATE_SERVICE) vs "Jasa Integral"
   * (INTEGRAL_FINANCIAL_INSTRUMENT).
   *
   * INI BUKAN PILIHAN KOSMETIK. Kolom `pinjaman.biaya_admin_klasifikasi`
   * sudah dipakai `cairkanPinjaman()` untuk memilih akun kredit yang
   * BERBEDA saat pencairan:
   *   Jasa Terpisah -> Kr Pendapatan Administrasi (4-1100), diakui penuh
   *      sebagai pendapatan pada tanggal pencairan.
   *   Jasa Integral -> Kr Pendapatan Diterima Dimuka (2-1300) + inisiasi
   *      pengukuran EIR, lalu diamortisasi sepanjang tenor
   *      (EirAccountingService).
   * Sebelum requirement ini, form tidak pernah mengirim field tersebut
   * sehingga SELALU jatuh ke default 'SEPARATE_SERVICE'.
   */
  const [biayaAdminKlasifikasi, setBiayaAdminKlasifikasi] =
    useState<BiayaAdminKlasifikasi>('SEPARATE_SERVICE');
  // Modal pemilihan metode jasa biaya admin — dibuka HANYA saat petugas
  // AKTIF memilih "Nominal tetap" atau "Persentase" (lihat
  // pilihBiayaAdminTipe), bukan saat render/mount.
  const [jasaModalOpen, setJasaModalOpen] = useState(false);

  /**
   * REQUIREMENT 7 — memilih tipe biaya administrasi otomatis membuka
   * modal pemilihan Jasa Terpisah / Jasa Integral. Memilih "Tidak ada"
   * mengembalikan klasifikasi ke SEPARATE_SERVICE (klasifikasi integral
   * tanpa fee tidak punya arti akuntansi — backend juga menormalisasi
   * hal yang sama lewat normalisasiBiayaAdminKlasifikasi).
   */
  const pilihBiayaAdminTipe = (value: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA') => {
    setBiayaAdminTipe(value);
    if (value === 'TIDAK_ADA') {
      setBiayaAdminKlasifikasi('SEPARATE_SERVICE');
      setJasaModalOpen(false);
      return;
    }
    setJasaModalOpen(true);
  };
  const [dendaAktif, setDendaAktif] = useState(false);
  const [dendaNilai, setDendaNilai] = useState<number | ''>('');
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: isEditMode ? 'Edit Pinjaman' : 'Ajukan Pinjaman' });
  }, [isEditMode, navigation]);

  // Bug fix (Edit Pinjaman): prefill seluruh field dari data existing.
  // Hanya berjalan sekali saat screen dibuka dengan pinjamanId — TIDAK
  // menimpa isian user setelah itu.
  useEffect(() => {
    if (!editPinjamanId) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await getPinjamanDetail(editPinjamanId);
        if (!detail) {
          notify('Gagal', 'Pinjaman tidak ditemukan.');
          navigation.goBack();
          return;
        }
        if (detail.status !== 'DIAJUKAN' && detail.status !== 'DISETUJUI') {
          notify('Gagal', 'Pinjaman yang sudah dicairkan tidak bisa diedit lewat sini.');
          navigation.goBack();
          return;
        }
        const anggotaData = await getAnggotaById(detail.anggotaId);
        if (cancelled) return;
        setAnggota(anggotaData);
        setTanggal(detail.tanggal);
        setJumlahPinjaman(detail.jumlahPinjaman);
        setTenor(String(detail.tenor));
        setSatuanTenor(detail.satuanTenor);
        setMetodeJasa(detail.metodeJasa);
        setPersentaseJasa(String(detail.persentaseJasa));
        setBiayaAdminTipe(detail.biayaAdminTipe as 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA');
        setBiayaAdminNilai(detail.biayaAdminNilai ? String(detail.biayaAdminNilai) : '');
        // REQUIREMENT 7 — prefill klasifikasi existing supaya pilihan
        // petugas tidak diam-diam kembali ke default saat pinjaman diedit.
        setBiayaAdminKlasifikasi(detail.biayaAdminKlasifikasi);
        setDendaAktif(detail.dendaAktif);
        setDendaNilai(detail.dendaNilai || '');
        setKeterangan(detail.keterangan ?? '');
        // RC-S72 — prefill tujuan & agunan. Tanpa ini, menyimpan edit akan
        // mengganti tujuan/agunan tersimpan dengan isian kosong form.
        setTujuanPinjaman(detail.tujuanPinjaman);
        setTujuanDetail(detail.tujuanDetail ?? '');
        const agunanAda = detail.agunan[0];
        setAdaAgunan(!!agunanAda);
        if (agunanAda) {
          setJenisAgunan(agunanAda.jenisAgunan);
          setPemilikAgunan(agunanAda.pemilik);
          setNomorDokumenAgunan(agunanAda.nomorDokumen);
          setNilaiAgunan(agunanAda.nilaiAgunan);
        }
      } catch (e) {
        notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat data pinjaman.');
        navigation.goBack();
      } finally {
        if (!cancelled) setLoadingEdit(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editPinjamanId, navigation]);

  // Bagian D (permintaan pengguna): validasi UX — cek Simpanan Pokok
  // & Wajib begitu anggota dipilih, supaya petugas tahu SEBELUM
  // mengisi seluruh form, bukan baru tahu setelah submit gagal.
  // Validasi SEBENARNYA (yang tidak bisa dilewati) tetap di service
  // lewat checkEligibilitasPinjaman/checkKepemilikanSimpananPokokWajib
  // — banner ini murni bantuan UX, bukan satu-satunya penjaga.
  const [peringatanSimpanan, setPeringatanSimpanan] = useState<string | null>(null);
  useEffect(() => {
    if (!anggota) {
      setPeringatanSimpanan(null);
      return;
    }
    let cancelled = false;
    (async () => {
      // RC-S133.6.4 — syarat dinilai pada TANGGAL PENGAJUAN: untuk tanggal
      // lampau, saldo dihitung per tanggal itu (sama dengan penilaian di service).
      const sampai = tanggal && tanggal < getTanggalLokalHariIni() ? tanggal : undefined;
      const [pokok, wajib] = await Promise.all([
        getSaldoSimpananAnggota(anggota.id, 'POKOK', sampai),
        getSaldoSimpananAnggota(anggota.id, 'WAJIB', sampai),
      ]);
      if (cancelled) return;
      const kurang: string[] = [];
      if (pokok <= 0) kurang.push('Simpanan Pokok');
      if (wajib <= 0) kurang.push('Simpanan Wajib');
      setPeringatanSimpanan(
        kurang.length > 0
          ? `Anggota ini belum memiliki ${kurang.join(' dan ')}${sampai ? ` pada tanggal pengajuan ${tanggal}` : ''} — pengajuan akan ditolak.`
          : null
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [anggota, tanggal]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!anggota) e.anggota = 'Anggota wajib dipilih';
    // RC-S54 item 24 — tujuan WAJIB di form ini; detail hanya wajib
    // untuk 'LAINNYA'.
    if (!tujuanPinjaman) e.tujuanPinjaman = 'Tujuan pinjaman wajib dipilih';
    if (tujuanPinjaman === 'LAINNYA' && !tujuanDetail.trim()) {
      e.tujuanDetail = 'Detail tujuan wajib diisi bila memilih Lainnya';
    }
    // RC-S54 item 25 — detail agunan hanya divalidasi bila "Ada".
    if (adaAgunan) {
      if (!jenisAgunan) e.jenisAgunan = 'Jenis agunan wajib dipilih';
      if (!pemilikAgunan.trim()) e.pemilikAgunan = 'Pemilik agunan wajib diisi';
      if (!nomorDokumenAgunan.trim()) e.nomorDokumenAgunan = 'Nomor dokumen wajib diisi';
      if (nilaiAgunan === '' || nilaiAgunan < 0) e.nilaiAgunan = 'Nilai agunan wajib diisi (tidak boleh negatif)';
    }
    if (jumlahPinjaman === '' || jumlahPinjaman <= 0) e.jumlahPinjaman = 'Jumlah pinjaman harus lebih dari 0';
    const t = parseInt(tenor, 10);
    if (!tenor || isNaN(t) || t <= 0) e.tenor = 'Tenor harus lebih dari 0';
    const persen = parseFloat(persentaseJasa || '0');
    if (isNaN(persen) || persen < 0) e.persentaseJasa = 'Persentase jasa tidak valid';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !anggota || !currentUser || jumlahPinjaman === '') return;
    setSubmitting(true);
    try {
      let id: string;
      if (isEditMode && editPinjamanId) {
        await editPinjaman({
          pinjamanId: editPinjamanId,
          tanggal,
          jumlahPinjaman,
          tenor: parseInt(tenor, 10),
          satuanTenor,
          metodeJasa,
          persentaseJasa: parseFloat(persentaseJasa || '0'),
          biayaAdminTipe,
          biayaAdminNilai: parseInt(biayaAdminNilai || '0', 10),
          biayaAdminKlasifikasi,
          tujuanPinjaman: tujuanPinjaman ?? undefined,
          tujuanDetail: tujuanPinjaman === 'LAINNYA' ? tujuanDetail.trim() : undefined,
          // RC-S72 — pada EDIT, "Tidak Ada" dikirim sebagai null (hapus
          // agunan), karena undefined berarti "tidak diubah" di editPinjaman.
          agunan:
            adaAgunan && jenisAgunan && nilaiAgunan !== ''
              ? {
                  jenisAgunan,
                  pemilik: pemilikAgunan.trim(),
                  nomorDokumen: nomorDokumenAgunan.trim(),
                  nilaiAgunan,
                }
              : null,
          dendaAktif,
          dendaTipe: dendaAktif ? 'PER_HARI' : undefined,
          dendaNilai: dendaNilai === '' ? 0 : dendaNilai,
          keterangan: keterangan || undefined,
          actingUserId: currentUser.id,
        });
        id = editPinjamanId;
      } else {
        const hasil = await ajukanPinjaman({
          anggotaId: anggota.id,
          tanggal,
          jumlahPinjaman,
          tenor: parseInt(tenor, 10),
          satuanTenor,
          metodeJasa,
          persentaseJasa: parseFloat(persentaseJasa || '0'),
          biayaAdminTipe,
          biayaAdminNilai: parseInt(biayaAdminNilai || '0', 10),
          biayaAdminKlasifikasi,
          // Tujuan & agunan yang diisi di form WAJIB ikut terkirim saat
          // pengajuan baru — sebelumnya hanya jalur edit yang mengirimnya,
          // sehingga isian ini hilang untuk pinjaman baru. Validasinya
          // tetap di service (validasiTujuanPinjaman/validasiAgunan).
          tujuanPinjaman: tujuanPinjaman ?? undefined,
          tujuanDetail: tujuanPinjaman === 'LAINNYA' ? tujuanDetail.trim() : undefined,
          agunan:
            adaAgunan && jenisAgunan && nilaiAgunan !== ''
              ? {
                  jenisAgunan,
                  pemilik: pemilikAgunan.trim(),
                  nomorDokumen: nomorDokumenAgunan.trim(),
                  nilaiAgunan,
                }
              : undefined,
          dendaAktif,
          dendaTipe: dendaAktif ? 'PER_HARI' : undefined,
          dendaNilai: dendaNilai === '' ? 0 : dendaNilai,
          keterangan: keterangan || undefined,
          createdBy: currentUser.id,
        });
        id = hasil.id;
      }
      if (isEditMode) {
        notify('Berhasil', 'Perubahan pinjaman berhasil disimpan.', [
          { text: 'OK', onPress: () => navigation.replace('PinjamanDetail', { pinjamanId: id }) },
        ]);
      } else {
        // Fix: SELALU arahkan ke Detail Pinjaman yang baru dibuat (pakai
        // replace, bukan navigate, supaya tombol kembali tidak balik ke
        // form yang sudah terisi) — pinjaman langsung terlihat & tombol
        // "Cairkan Pinjaman" langsung tersedia, sama seperti alur semula,
        // dari jalur manapun form ini dibuka.
        notify('Berhasil', 'Pengajuan pinjaman & jadwal angsuran berhasil dibuat.', [
          { text: 'OK', onPress: () => navigation.replace('PinjamanDetail', { pinjamanId: id }) },
        ]);
      }
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingEdit) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const ringkasanBiaya = previewBiayaAdmin(biayaAdminTipe, biayaAdminNilai, jumlahPinjaman);
  const labelMetode = METODE_OPTIONS.find((o) => o.value === metodeJasa)?.label ?? metodeJasa;
  const labelSatuan = TENOR_SATUAN_OPTIONS.find((o) => o.value === satuanTenor)?.label.toLowerCase() ?? '';
  const tenorAngka = parseInt(tenor, 10);

  /**
   * UI/UX — form disusun per bagian bernomor (kartu) supaya alur isian
   * terbaca urut: Anggota → Tujuan → Rincian → Biaya & Denda → Agunan →
   * Catatan, ditutup ringkasan sebelum tombol kirim. SELURUH state,
   * handler, validasi, modal, dan pemanggilan service TIDAK berubah —
   * yang berubah hanya susunan & tampilan.
   */
  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.intro}>
          <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
          <Text style={styles.introText}>
            {isEditMode
              ? 'Perbarui data pengajuan yang belum dicairkan. Anggota tidak dapat diubah.'
              : 'Lengkapi data pengajuan pinjaman. Kolom bertanda * wajib diisi.'}
          </Text>
        </View>

        <Section nomor={1} icon="person-outline" title="Anggota & Tanggal">
          <AnggotaPicker value={anggota} onChange={setAnggota} error={errors.anggota} disabled={isEditMode} />
          {peringatanSimpanan && (
            <View style={styles.warningBox}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
              <Text style={styles.warningText}>{peringatanSimpanan}</Text>
            </View>
          )}
          <Text style={styles.label}>Tanggal Pengajuan *</Text>
          <DatePicker value={tanggal} onChange={setTanggal} />
        </Section>

        {/* RC-S54 item 24 — Tujuan Pinjaman. */}
        <Section nomor={2} icon="flag-outline" title="Tujuan Pinjaman" required>
          <View style={styles.chipRow}>
            {(Object.keys(LABEL_TUJUAN_PINJAMAN) as TujuanPinjaman[]).map((t) => (
              <Chip key={t} label={LABEL_TUJUAN_PINJAMAN[t]} active={tujuanPinjaman === t} onPress={() => setTujuanPinjaman(t)} />
            ))}
          </View>
          {errors.tujuanPinjaman && <FieldError message={errors.tujuanPinjaman} />}

          {tujuanPinjaman === 'LAINNYA' && (
            <View style={styles.subField}>
              <Text style={styles.label}>Detail Tujuan *</Text>
              <FocusTextInput
                style={styles.input}
                value={tujuanDetail}
                onChangeText={setTujuanDetail}
                placeholder="Jelaskan tujuan pinjaman"
                placeholderTextColor={colors.placeholder}
                invalid={!!errors.tujuanDetail}
              />
              {errors.tujuanDetail && <FieldError message={errors.tujuanDetail} />}
            </View>
          )}
        </Section>

        <Section nomor={3} icon="cash-outline" title="Rincian Pinjaman">
          <Text style={styles.label}>Jumlah Pinjaman (Rp) *</Text>
          <View style={styles.fieldGap}>
            <CurrencyInput value={jumlahPinjaman} onChangeValue={setJumlahPinjaman} error={errors.jumlahPinjaman} />
          </View>

          <View style={styles.twoCol}>
            <View style={styles.tenorCol}>
              <Field label="Tenor *" value={tenor} onChangeText={setTenor} keyboardType="number-pad" error={errors.tenor} />
            </View>
            <View style={styles.satuanCol}>
              <Text style={styles.label}>Satuan</Text>
              <Segmented
                options={TENOR_SATUAN_OPTIONS}
                value={satuanTenor}
                onChange={(v) => setSatuanTenor(v)}
              />
            </View>
          </View>

          <Text style={styles.label}>Metode Jasa</Text>
          <Segmented options={METODE_OPTIONS} value={metodeJasa} onChange={(v) => pilihMetodeJasa(v)} />
          {metodeJasa === 'CUSTOM' && (
            <View style={styles.hintBox}>
              <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
              <Text style={styles.hint}>
                Setelah pinjaman diajukan, susun jadwal angsuran custom (jumlah periode, tanggal jatuh
                tempo, pokok, dan bunga tiap periode) dari layar Detail Pinjaman sebelum dicairkan.
              </Text>
            </View>
          )}
          <View style={styles.fieldTop}>
            <Field
              label="Persentase Jasa per Periode/Bulan (%) *"
              value={persentaseJasa}
              onChangeText={setPersentaseJasa}
              keyboardType="decimal-pad"
              error={errors.persentaseJasa}
            />
          </View>
        </Section>

        <Section nomor={4} icon="receipt-outline" title="Biaya & Denda">
          <Text style={styles.label}>Biaya Administrasi</Text>
          <Segmented options={BIAYA_ADMIN_OPTIONS} value={biayaAdminTipe} onChange={(v) => pilihBiayaAdminTipe(v)} />
          {biayaAdminTipe === 'NOMINAL' && (
            <View style={styles.subField}>
              <Text style={styles.label}>Nominal Biaya Admin (Rp)</Text>
              <CurrencyInput
                value={biayaAdminNilai === '' ? '' : parseInt(biayaAdminNilai, 10)}
                onChangeValue={(v) => setBiayaAdminNilai(v === '' ? '' : v.toString())}
              />
            </View>
          )}
          {biayaAdminTipe === 'PERSENTASE' && (
            <View style={styles.subField}>
              <Field
                label="Persentase Biaya Admin (%)"
                value={biayaAdminNilai}
                onChangeText={setBiayaAdminNilai}
                keyboardType="number-pad"
              />
            </View>
          )}

          {/* REQUIREMENT 7 — ringkasan metode jasa yang sedang dipilih +
              jalan pintas mengubahnya tanpa harus menekan ulang chip tipe
              biaya admin. */}
          {biayaAdminTipe !== 'TIDAK_ADA' && (
            <TouchableOpacity style={styles.klasifikasiSummary} onPress={() => setJasaModalOpen(true)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.klasifikasiSummaryLabel}>Metode Jasa Biaya Administrasi</Text>
                <Text style={styles.klasifikasiSummaryValue}>
                  {biayaAdminKlasifikasi === 'INTEGRAL_FINANCIAL_INSTRUMENT' ? 'Jasa Integral' : 'Jasa Terpisah'}
                </Text>
                <Text style={styles.klasifikasiSummaryHint}>
                  {biayaAdminKlasifikasi === 'INTEGRAL_FINANCIAL_INSTRUMENT'
                    ? 'Fee ditangguhkan & diamortisasi sepanjang tenor (EIR).'
                    : 'Fee diakui penuh sebagai pendapatan saat pencairan.'}
                </Text>
              </View>
              <Text style={styles.klasifikasiSummaryUbah}>Ubah</Text>
            </TouchableOpacity>
          )}

          <View style={styles.sectionDivider} />

          <Text style={styles.label}>Denda Keterlambatan</Text>
          <Segmented
            options={[
              { value: 'TIDAK', label: 'Tidak Aktif' },
              { value: 'AKTIF', label: 'Aktif' },
            ]}
            value={dendaAktif ? 'AKTIF' : 'TIDAK'}
            onChange={(v) => setDendaAktif(v === 'AKTIF')}
          />
          {dendaAktif && (
            <View style={styles.subField}>
              <Text style={styles.label}>Denda per Hari Terlambat (Rp)</Text>
              <CurrencyInput value={dendaNilai} onChangeValue={setDendaNilai} />
            </View>
          )}
        </Section>

        {/* RC-S54 item 25 — Agunan/Jaminan. Detail HANYA muncul saat "Ada". */}
        <Section nomor={5} icon="shield-checkmark-outline" title="Agunan / Jaminan" required>
          <Segmented
            options={[
              { value: 'TIDAK', label: 'Tidak Ada' },
              { value: 'ADA', label: 'Ada' },
            ]}
            value={adaAgunan ? 'ADA' : 'TIDAK'}
            onChange={(v) => setAdaAgunan(v === 'ADA')}
          />

          {adaAgunan && (
            <View style={styles.subField}>
              <Text style={styles.label}>Jenis Agunan *</Text>
              <View style={styles.chipRow}>
                {(Object.keys(LABEL_JENIS_AGUNAN) as JenisAgunan[]).map((j) => (
                  <Chip key={j} label={LABEL_JENIS_AGUNAN[j]} active={jenisAgunan === j} onPress={() => setJenisAgunan(j)} />
                ))}
              </View>
              {errors.jenisAgunan && <FieldError message={errors.jenisAgunan} />}

              <Text style={[styles.label, styles.fieldTop]}>Pemilik *</Text>
              <FocusTextInput
                style={styles.input}
                value={pemilikAgunan}
                onChangeText={setPemilikAgunan}
                placeholder="Nama pemilik agunan"
                placeholderTextColor={colors.placeholder}
                invalid={!!errors.pemilikAgunan}
              />
              {errors.pemilikAgunan && <FieldError message={errors.pemilikAgunan} />}

              <Text style={[styles.label, styles.fieldTop]}>Nomor Dokumen *</Text>
              <FocusTextInput
                style={styles.input}
                value={nomorDokumenAgunan}
                onChangeText={setNomorDokumenAgunan}
                placeholder="Nomor sertifikat / BPKB / bilyet"
                placeholderTextColor={colors.placeholder}
                invalid={!!errors.nomorDokumenAgunan}
              />
              {errors.nomorDokumenAgunan && <FieldError message={errors.nomorDokumenAgunan} />}

              <Text style={[styles.label, styles.fieldTop]}>Nilai Agunan (Rp) *</Text>
              <CurrencyInput value={nilaiAgunan} onChangeValue={setNilaiAgunan} error={errors.nilaiAgunan} />
            </View>
          )}
        </Section>

        <Section nomor={6} icon="document-text-outline" title="Catatan">
          <Field label="Keterangan" value={keterangan} onChangeText={setKeterangan} multiline />
        </Section>

        {/* Ringkasan pengajuan — angka dari isian form, dihitung dengan
            previewBiayaAdmin() yang sama dengan modal biaya admin (rumus
            identik cairkanPinjaman()). Murni tampilan. */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Ringkasan Pengajuan</Text>
          <SummaryRow label="Anggota" value={anggota?.namaLengkap ?? '—'} />
          <SummaryRow label="Jumlah pinjaman" value={jumlahPinjaman === '' ? '—' : formatRupiah(jumlahPinjaman)} />
          <SummaryRow
            label="Tenor"
            value={Number.isFinite(tenorAngka) && tenorAngka > 0 ? `${tenorAngka} ${labelSatuan}` : '—'}
          />
          <SummaryRow
            label="Metode jasa"
            value={persentaseJasa ? `${labelMetode} · ${persentaseJasa}% / periode` : labelMetode}
          />
          <SummaryRow
            label="Biaya administrasi"
            value={biayaAdminTipe === 'TIDAK_ADA' ? 'Tidak ada' : formatRupiah(ringkasanBiaya.biayaAdmin)}
          />
          <View style={styles.summaryDivider} />
          <SummaryRow label="Kas diterima anggota" value={formatRupiah(ringkasanBiaya.kasDiterima)} strong />
        </View>

        <TouchableOpacity
          style={[styles.submitButton, submitting && styles.disabled]}
          onPress={submit}
          disabled={submitting}
          accessibilityRole="button"
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name={isEditMode ? 'save-outline' : 'paper-plane-outline'} size={18} color={colors.white} />
              <Text style={styles.submitText}>{isEditMode ? 'Simpan Perubahan' : 'Ajukan Pinjaman'}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* ============================================================
            REQUIREMENT 7 (permintaan pengguna): modal pemilihan metode
            jasa untuk biaya administrasi, muncul saat memilih "Nominal
            tetap" MAUPUN "Persentase". Preview perhitungan memakai rumus
            yang SAMA PERSIS dengan cairkanPinjaman() (nominal apa adanya;
            persentase = jumlah pinjaman x persen / 100, dibulatkan) —
            lihat previewBiayaAdmin() di bawah.
            ============================================================ */}
        <Modal visible={jasaModalOpen} transparent animationType="fade" onRequestClose={() => setJasaModalOpen(false)}>
          <View style={styles.flatModalOverlay}>
            <View style={styles.jasaModalCard}>
              <Text style={styles.flatModalTitle}>Metode Jasa Biaya Administrasi</Text>
              <Text style={styles.jasaModalIntro}>
                Pilih bagaimana biaya administrasi pencairan diperlakukan dalam pembukuan. Pilihan ini
                menentukan akun dan waktu pengakuan pendapatannya.
              </Text>

              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 380 }}>
                {(
                  [
                    {
                      value: 'SEPARATE_SERVICE' as BiayaAdminKlasifikasi,
                      judul: 'Jasa Terpisah',
                      ringkas: 'Jasa administrasi berdiri sendiri, terpisah dari pokok pinjaman.',
                      poin: [
                        'Diakui PENUH sebagai Pendapatan Administrasi pada tanggal pencairan.',
                        'Jasa ditampilkan terpisah dari pokok; tidak memengaruhi jadwal angsuran.',
                        'Tidak memerlukan pengukuran suku bunga efektif (EIR).',
                      ],
                    },
                    {
                      value: 'INTEGRAL_FINANCIAL_INSTRUMENT' as BiayaAdminKlasifikasi,
                      judul: 'Jasa Integral',
                      ringkas: 'Jasa menyatu dengan pengukuran instrumen pinjaman.',
                      poin: [
                        'TIDAK diakui sebagai pendapatan saat pencairan; dibukukan sebagai Pendapatan Diterima Dimuka.',
                        'Diamortisasi sepanjang tenor memakai suku bunga efektif (EIR) yang dihitung sistem.',
                        'Sisa fee yang belum teramortisasi diselesaikan otomatis saat pelunasan dipercepat.',
                      ],
                    },
                  ]
                ).map((opt) => {
                  const aktif = biayaAdminKlasifikasi === opt.value;
                  const preview = previewBiayaAdmin(biayaAdminTipe, biayaAdminNilai, jumlahPinjaman);
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[styles.jasaOptionCard, aktif && styles.jasaOptionCardActive]}
                      onPress={() => setBiayaAdminKlasifikasi(opt.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: aktif }}
                    >
                      <View style={styles.jasaOptionHeader}>
                        <View style={[styles.radioOuter, aktif && styles.radioOuterActive]}>
                          {aktif && <View style={styles.radioInner} />}
                        </View>
                        <Text style={[styles.jasaOptionJudul, aktif && styles.jasaOptionJudulActive]}>{opt.judul}</Text>
                      </View>
                      <Text style={styles.jasaOptionRingkas}>{opt.ringkas}</Text>
                      {opt.poin.map((p) => (
                        <Text key={p} style={styles.jasaOptionPoin}>
                          •  {p}
                        </Text>
                      ))}

                      {/* Preview perhitungan — angka nyata dari isian form,
                          bukan contoh karangan. */}
                      <View style={styles.jasaPreviewBox}>
                        <View style={styles.jasaPreviewRow}>
                          <Text style={styles.jasaPreviewLabel}>Biaya administrasi</Text>
                          <Text style={styles.jasaPreviewValue}>{formatRupiah(preview.biayaAdmin)}</Text>
                        </View>
                        <View style={styles.jasaPreviewRow}>
                          <Text style={styles.jasaPreviewLabel}>Kas diterima anggota</Text>
                          <Text style={styles.jasaPreviewValue}>{formatRupiah(preview.kasDiterima)}</Text>
                        </View>
                        <View style={styles.jasaPreviewRow}>
                          <Text style={styles.jasaPreviewLabel}>Pengakuan saat pencairan</Text>
                          <Text style={styles.jasaPreviewValue}>
                            {opt.value === 'SEPARATE_SERVICE'
                              ? `Pendapatan ${formatRupiah(preview.biayaAdmin)}`
                              : `Ditangguhkan ${formatRupiah(preview.biayaAdmin)}`}
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <TouchableOpacity style={styles.flatModalButton} onPress={() => setJasaModalOpen(false)}>
                <Text style={styles.flatModalButtonText}>Gunakan Metode Ini</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* PHASE 4 §L (permintaan pengguna): peringatan profesional
            tentang FLAT — TIDAK bilang "FLAT dilarang SAK EP" (itu
            keliru; masalahnya di pengukuran/pengakuan akuntansi, bukan
            keberadaan metode kontraktual FLAT). Muncul HANYA saat user
            memilih FLAT (lihat pilihMetodeJasa), tidak menghalangi user
            setelah ditekan "Saya Mengerti" (form tetap bisa dipakai
            normal, FLAT tetap tersimpan sebagai metode kontraktual). */}
        <Modal visible={flatModalOpen} transparent animationType="fade" onRequestClose={() => setFlatModalOpen(false)}>
          <View style={styles.flatModalOverlay}>
            <View style={styles.flatModalCard}>
              <Text style={styles.flatModalTitle}>Metode FLAT</Text>
              <Text style={styles.flatModalBody}>
                Metode FLAT digunakan untuk perhitungan jadwal jasa kontraktual. Untuk pelaporan
                akuntansi, pengakuan pendapatan dan pengukuran pinjaman mengikuti kebijakan
                akuntansi dan ketentuan SAK EP yang berlaku.
              </Text>
              <TouchableOpacity style={styles.flatModalButton} onPress={() => setFlatModalOpen(false)}>
                <Text style={styles.flatModalButtonText}>Saya Mengerti</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/**
 * REQUIREMENT 7 — preview biaya administrasi & kas yang diterima
 * anggota. Rumusnya SENGAJA identik dengan `cairkanPinjaman()`
 * (PinjamanService): NOMINAL dipakai apa adanya; PERSENTASE =
 * Math.round(jumlahPinjaman * persen / 100). Kalau rumus di service
 * berubah, ini WAJIB ikut disesuaikan — dicatat di sini supaya
 * ketergantungannya eksplisit, bukan tersembunyi.
 */
function previewBiayaAdmin(
  tipe: 'NOMINAL' | 'PERSENTASE' | 'TIDAK_ADA',
  nilai: string,
  jumlahPinjaman: number | ''
): { biayaAdmin: number; kasDiterima: number } {
  const pokok = jumlahPinjaman === '' ? 0 : jumlahPinjaman;
  const angka = parseFloat(nilai || '0');
  const aman = Number.isFinite(angka) && angka > 0 ? angka : 0;
  let biayaAdmin = 0;
  if (tipe === 'NOMINAL') biayaAdmin = Math.trunc(aman);
  else if (tipe === 'PERSENTASE') biayaAdmin = Math.round((pokok * aman) / 100);
  return { biayaAdmin, kasDiterima: Math.max(0, pokok - biayaAdmin) };
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
    >
      {active && <Ionicons name="checkmark" size={14} color={colors.white} />}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Kartu bagian form bernomor — murni presentasi. */
function Section({
  nomor,
  icon,
  title,
  required,
  children,
}: {
  nomor: number;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionNomor}>
          <Text style={styles.sectionNomorText}>{nomor}</Text>
        </View>
        <Ionicons name={icon} size={18} color={colors.primary} />
        <Text style={styles.sectionTitle}>
          {title}
          {required ? ' *' : ''}
        </Text>
      </View>
      {children}
    </View>
  );
}

/**
 * Kontrol segmen (pilihan tunggal, lebar sama) untuk opsi pendek
 * seperti satuan tenor, metode jasa, dan biaya admin. Hanya memanggil
 * `onChange` dengan nilai opsi — handler pemanggil tidak berubah.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((opt) => {
        const aktif = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segment, aktif && styles.segmentActive]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: aktif }}
          >
            <Text style={[styles.segmentText, aktif && styles.segmentTextActive]} numberOfLines={1}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, strong && styles.summaryLabelStrong]}>{label}</Text>
      <Text style={[styles.summaryValue, strong && styles.summaryValueStrong]} numberOfLines={1}>
        {value}
      </Text>
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
  onChangeText,
  error,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  error?: string;
  multiline?: boolean;
  keyboardType?: any;
}) {
  return (
    <AppTextInput
      label={label}
      error={error}
      value={value}
      onChangeText={onChangeText}
      multiline={multiline}
      keyboardType={keyboardType}
      noIcon={!multiline}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xxl },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.md,
  },
  introText: { flex: 1, fontSize: 12, color: colors.primaryDark, lineHeight: 17 },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionNomor: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionNomorText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  sectionDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  subField: { marginTop: spacing.md },
  fieldGap: { marginBottom: spacing.md },
  fieldTop: { marginTop: spacing.md },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  warningText: { flex: 1, color: colors.danger, fontSize: 12, lineHeight: 17 },
  twoCol: { flexDirection: 'row', gap: spacing.md },
  tenorCol: { flex: 2 },
  satuanCol: { flex: 3 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white, fontWeight: '600' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm - 2,
    paddingHorizontal: 4,
  },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  segmentTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: 6 },
  input: { ...formUi.inputStandalone },
  hintBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  hint: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  summaryTitle: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, paddingVertical: 3 },
  summaryLabel: { fontSize: 12, color: colors.textMuted },
  summaryLabelStrong: { color: colors.text, fontWeight: '700' },
  summaryValue: { flexShrink: 1, fontSize: 13, color: colors.text, fontWeight: '600', textAlign: 'right' },
  summaryValueStrong: { fontSize: 15, color: colors.primary, fontWeight: '700' },
  summaryDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  submitButton: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    ...elevation.card,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  flatModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  flatModalCard: { width: '100%', maxWidth: 380, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg },
  flatModalTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  flatModalBody: { fontSize: 13, color: colors.textMuted, lineHeight: 19, marginBottom: spacing.lg },
  flatModalButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  flatModalButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  // REQUIREMENT 7 — modal & ringkasan metode jasa biaya administrasi.
  klasifikasiSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  klasifikasiSummaryLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.3 },
  klasifikasiSummaryValue: { fontSize: 14, color: colors.primary, fontWeight: '700', marginTop: 2 },
  klasifikasiSummaryHint: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  klasifikasiSummaryUbah: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  jasaModalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  jasaModalIntro: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginBottom: spacing.md },
  jasaOptionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  jasaOptionCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  jasaOptionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  jasaOptionJudul: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  jasaOptionJudulActive: { color: colors.primary, fontWeight: '700' },
  jasaOptionRingkas: { fontSize: 12, color: colors.text, marginTop: 6, marginLeft: 28, lineHeight: 17 },
  jasaOptionPoin: { fontSize: 11, color: colors.textMuted, marginTop: 4, marginLeft: 28, lineHeight: 16 },
  jasaPreviewBox: {
    marginTop: spacing.sm,
    marginLeft: 28,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: 3,
  },
  jasaPreviewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  jasaPreviewLabel: { fontSize: 11, color: colors.textMuted, flex: 1 },
  jasaPreviewValue: { fontSize: 11, color: colors.text, fontWeight: '700' },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterActive: { borderColor: colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
});
