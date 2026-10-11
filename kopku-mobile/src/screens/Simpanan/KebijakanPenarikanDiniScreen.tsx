import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getAccountById, type AccountItem } from '@/repositories/AccountRepository';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import { formatNominalInput, formatRupiah, parseNominalInput } from '@/utils/money';
import {
  getAkunTetapKebijakanDini,
  getKebijakanDiniAktif,
  getStatusKebijakanDini,
  simpanKebijakanDini,
  KODE_AKUN_BIAYA_ADMIN_DINI,
  KODE_AKUN_PENALTI_DINI,
  type AkunTetapKebijakanDini,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import {
  evaluasiKebijakanEarlyWithdrawal,
  type HasilEvaluasiKebijakan,
  type KebijakanEarlyWithdrawalDraft,
} from '@/accounting/EarlyWithdrawalPolicy';
import {
  bacaKebijakanSederhana,
  deskripsiKebijakan,
  keParameterKebijakan,
  LABEL_BIAYA,
  LABEL_BUNGA,
  LABEL_PENALTI,
  type BacaKebijakan,
  type PilihanBiaya,
  type PilihanBunga,
  type PilihanPenalti,
} from '@/utils/kebijakanDiniSederhana';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * KEBIJAKAN PENARIKAN DINI SIMPANAN BERJANGKA — FORMULIR SEDERHANA.
 *
 * Dibuka dari Tarik Simpanan Anggota (bukan Pengaturan). Pengurus hanya
 * memutuskan tiga hal — Penalti, Bunga, Biaya Administrasi — yang
 * diterjemahkan `keParameterKebijakan()` ke parameter kebijakan YANG
 * SUDAH ADA. Model data, evaluator, mesin perhitungan, service, jurnal,
 * COA, database, permission (`pengaturan:edit` di service), versioning,
 * dan audit trail tidak berubah.
 *
 * TIDAK ADA SATU PUN ANGKA BAWAAN. Semua pilihan dimulai belum terpilih
 * (`null`) dan semua nilai dimulai KOSONG, bukan 0: `0`/"Tidak Ada" adalah
 * keputusan pengurus, kosong berarti belum diputuskan. Layar ini juga
 * tidak menghitung apa pun — evaluasi kelengkapan memakai evaluator
 * domain yang sama dengan service.
 */

/**
 * Kosong -> null. TIDAK PERNAH menjadi 0.
 *
 * Nominal rupiah ditampilkan berpemisah ribuan ("100.000"); persentase
 * memakai koma desimal ("2,5"). Titik pada nilai persentase tidak pernah
 * diketik sebagai pemisah ribuan, jadi keduanya dapat dibaca dengan aman:
 * nominal disimpan state sebagai digit murni lewat `parseNominalInput`.
 */
function keAngka(teks: string): number | null {
  const bersih = teks.trim().replace(',', '.');
  if (bersih === '') return null;
  const n = Number(bersih);
  return Number.isFinite(n) ? n : null;
}

const OPSI_PENALTI: readonly { nilai: PilihanPenalti; keterangan: string }[] = [
  { nilai: 'TIDAK_ADA', keterangan: 'Anggota tidak dikenai penalti.' },
  { nilai: 'PERSEN_POKOK', keterangan: 'Penalti sebesar persentase tertentu dari pokok simpanan.' },
  { nilai: 'NOMINAL_TETAP', keterangan: 'Penalti dengan nominal rupiah yang sama untuk setiap penarikan.' },
];
const OPSI_BUNGA: readonly { nilai: PilihanBunga; keterangan: string }[] = [
  {
    nilai: 'HANGUS',
    keterangan: 'Bunga yang sudah berjalan dan belum dibayarkan dibatalkan; anggota tidak menerima bunga tersebut.',
  },
  {
    nilai: 'DIBAYAR',
    keterangan: 'Bunga yang sudah berjalan sampai tanggal pencairan tetap dibayarkan kepada anggota.',
  },
];
const OPSI_BIAYA: readonly { nilai: PilihanBiaya; keterangan: string }[] = [
  { nilai: 'TIDAK_ADA', keterangan: 'Tidak ada biaya administrasi.' },
  { nilai: 'NOMINAL_TETAP', keterangan: 'Biaya administrasi dengan nominal rupiah tetap.' },
  { nilai: 'PERSEN_POKOK', keterangan: 'Biaya administrasi sebesar persentase tertentu dari pokok simpanan.' },
];

type Mode = 'LIHAT' | 'EDIT';

/** Pesan ramah untuk pelanggaran UNIQUE(versi) di database. */
function pesanGagalSimpan(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (/UNIQUE/i.test(m) && /versi/i.test(m)) return 'Versi kebijakan ini sudah pernah dipakai. Gunakan versi baru.';
  return m || 'Terjadi kesalahan.';
}

export default function KebijakanPenarikanDiniScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [memuat, setMemuat] = useState(true);
  const [menyimpan, setMenyimpan] = useState(false);
  const [evaluasi, setEvaluasi] = useState<HasilEvaluasiKebijakan | null>(null);
  /** Baris kebijakan yang sedang berlaku (bertipe DRAFT: keputusan boleh null). */
  const [aktif, setAktif] = useState<KebijakanEarlyWithdrawalDraft | null>(null);
  const [bacaan, setBacaan] = useState<BacaKebijakan>({ jenis: 'KOSONG' });
  /** Akun pada kebijakan BERLAKU — untuk tampilan mode lihat. */
  const [akunAktif, setAkunAktif] = useState<{ penalti: AccountItem | null; biaya: AccountItem | null }>({
    penalti: null,
    biaya: null,
  });
  /**
   * LIHAT: kebijakan berlaku ditampilkan read-only + tombol Edit Kebijakan.
   * EDIT : formulir; menyimpan selalu membuat VERSI BARU lewat
   *        `simpanKebijakanDini()` (baris lama dinonaktifkan, tidak dihapus).
   */
  const [mode, setMode] = useState<Mode>('LIHAT');

  const [versi, setVersi] = useState('');
  const [berlakuMulai, setBerlakuMulai] = useState(() => getTanggalLokalHariIni());
  const [diizinkan, setDiizinkan] = useState<boolean | null>(null);

  // Tiga keputusan — dimulai BELUM terpilih.
  const [pilihanPenalti, setPilihanPenalti] = useState<PilihanPenalti | null>(null);
  const [pilihanBunga, setPilihanBunga] = useState<PilihanBunga | null>(null);
  const [pilihanBiaya, setPilihanBiaya] = useState<PilihanBiaya | null>(null);

  // Nilai berupa STRING agar dapat benar-benar kosong.
  const [nilaiPenalti, setNilaiPenalti] = useState('');
  const [nilaiBiayaAdmin, setNilaiBiayaAdmin] = useState('');
  /**
   * Akun pendapatan TERKUNCI (keputusan pengguna): penalti -> 4-1150,
   * biaya administrasi -> 4-1100. Dibaca dari COA, tidak dapat dipilih.
   * Service `simpanKebijakanDini()` menegakkan akun yang sama.
   */
  const [akunTetap, setAkunTetap] = useState<{
    penalti: AkunTetapKebijakanDini | null;
    biayaAdmin: AkunTetapKebijakanDini | null;
  }>({ penalti: null, biayaAdmin: null });
  const akunPenalti = akunTetap.penalti;
  const akunBiayaAdmin = akunTetap.biayaAdmin;

  const [dasarPenetapan, setDasarPenetapan] = useState('');
  const [ditetapkanOleh, setDitetapkanOleh] = useState('');

  const [galat, setGalat] = useState<Record<string, string>>({});
  const [lembarKonfirmasi, setLembarKonfirmasi] = useState(false);

  const muat = useCallback(async () => {
    setMemuat(true);
    try {
      const [status, kebijakan, tetap] = await Promise.all([
        getStatusKebijakanDini(),
        getKebijakanDiniAktif(),
        getAkunTetapKebijakanDini(),
      ]);
      setAkunTetap(tetap);
      setEvaluasi(status);
      setAktif(kebijakan);
      setBacaan(bacaKebijakanSederhana(kebijakan));
      const [ap, ab] = await Promise.all([
        kebijakan?.akunPenaltiId ? getAccountById(kebijakan.akunPenaltiId) : Promise.resolve(null),
        kebijakan?.akunBiayaAdminId ? getAccountById(kebijakan.akunBiayaAdminId) : Promise.resolve(null),
      ]);
      setAkunAktif({ penalti: ap, biaya: ab });
      // Belum ada kebijakan -> langsung formulir; ada -> tampilan lihat.
      setMode(kebijakan ? 'LIHAT' : 'EDIT');
    } catch {
      setEvaluasi(null);
      setAktif(null);
      setMode('EDIT');
    } finally {
      setMemuat(false);
    }
  }, []);

  /**
   * Masuk mode edit dengan nilai kebijakan BERLAKU terisi otomatis (data
   * tersimpan, bukan angka bawaan) — bila dapat dinyatakan persis oleh
   * formulir sederhana. Versi SENGAJA dikosongkan: perubahan selalu
   * ditetapkan sebagai versi baru.
   */
  const mulaiEdit = () => {
    setGalat({});
    setVersi('');
    setBerlakuMulai(getTanggalLokalHariIni());
    setDasarPenetapan('');
    setDitetapkanOleh('');
    const b = bacaan;
    if (b.jenis === 'SEDERHANA') {
      setDiizinkan(true);
      setPilihanPenalti(b.keputusan.penalti);
      setPilihanBunga(b.keputusan.bunga);
      setPilihanBiaya(b.keputusan.biaya);
      setNilaiPenalti(b.nilaiPenalti === null ? '' : String(b.nilaiPenalti));
      setNilaiBiayaAdmin(b.nilaiBiayaAdmin === null ? '' : String(b.nilaiBiayaAdmin));
    } else {
      setDiizinkan(aktif && !aktif.diizinkan ? false : null);
      setPilihanPenalti(null);
      setPilihanBunga(null);
      setPilihanBiaya(null);
      setNilaiPenalti('');
      setNilaiBiayaAdmin('');
    }
    setMode('EDIT');
  };

  useEffect(() => {
    void muat();
  }, [muat]);

  const {
    jenisPenalti,
    basisPenalti,
    jenisForfeiture,
    nilaiForfeiture,
    perlakuanBunga,
    jenisBiayaAdmin,
    basisBiayaAdmin,
    rateDini,
    jenisPenyesuaianRate,
    cakupanPenyesuaianRate,
    perlakuanPokok,
  } = keParameterKebijakan({ penalti: pilihanPenalti, bunga: pilihanBunga, biaya: pilihanBiaya });

  const adaPenalti = pilihanPenalti === 'PERSEN_POKOK' || pilihanPenalti === 'NOMINAL_TETAP';
  const adaBiaya = pilihanBiaya === 'NOMINAL_TETAP' || pilihanBiaya === 'PERSEN_POKOK';

  /** Draf lengkap — dipakai evaluator (pratinjau status) DAN dikirim ke service. */
  const draf = useMemo<KebijakanEarlyWithdrawalDraft | null>(
    () =>
      diizinkan === null
        ? null
        : {
            versi: versi.trim(),
            berlakuMulai,
            diizinkan,
            jenisPenalti,
            nilaiPenalti: adaPenalti ? keAngka(nilaiPenalti) : null,
            basisPenalti,
            akunPenaltiId: adaPenalti ? (akunPenalti?.id ?? null) : null,
            jenisForfeiture,
            nilaiForfeiture,
            jenisBiayaAdmin,
            nilaiBiayaAdmin: adaBiaya ? keAngka(nilaiBiayaAdmin) : null,
            basisBiayaAdmin,
            akunBiayaAdminId: adaBiaya ? (akunBiayaAdmin?.id ?? null) : null,
            rateDini,
            jenisPenyesuaianRate,
            cakupanPenyesuaianRate,
            perlakuanPokok,
            perlakuanBunga,
            dasarPenetapan: dasarPenetapan.trim() || null,
            ditetapkanOleh: ditetapkanOleh.trim() || null,
          },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      versi,
      berlakuMulai,
      diizinkan,
      pilihanPenalti,
      pilihanBunga,
      pilihanBiaya,
      nilaiPenalti,
      nilaiBiayaAdmin,
      akunPenalti,
      akunBiayaAdmin,
      dasarPenetapan,
      ditetapkanOleh,
    ],
  );
  const pratinjau = draf ? evaluasiKebijakanEarlyWithdrawal(draf) : null;

  const validasi = (): boolean => {
    const e: Record<string, string> = {};
    if (versi.trim() === '') e.versi = 'Versi kebijakan wajib diisi (mis. nomor SK pengurus).';
    else if (aktif && versi.trim().toLowerCase() === aktif.versi.trim().toLowerCase())
      e.versi = `Versi "${aktif.versi}" sedang berlaku. Perubahan harus memakai versi baru.`;
    if (diizinkan === null) e.diizinkan = 'Tentukan apakah penarikan dini diizinkan.';
    if (diizinkan) {
      if (pilihanPenalti === null) e.penalti = 'Pilih ketentuan penalti.';
      if (adaPenalti) {
        const n = keAngka(nilaiPenalti);
        if (n === null || n <= 0)
          e.nilaiPenalti = pilihanPenalti === 'PERSEN_POKOK' ? 'Isi persentase penalti.' : 'Isi nominal penalti.';
        else if (pilihanPenalti === 'NOMINAL_TETAP' && !Number.isInteger(n))
          e.nilaiPenalti = 'Nominal penalti harus rupiah bulat (tanpa desimal).';
        if (!akunPenalti)
          e.akunPenalti = `Akun ${KODE_AKUN_PENALTI_DINI} Pendapatan Penalti Pelunasan tidak ditemukan atau nonaktif di Daftar Akun.`;
      }
      if (pilihanBunga === null) e.bunga = 'Pilih ketentuan bunga.';
      if (pilihanBiaya === null) e.biaya = 'Pilih ketentuan biaya administrasi.';
      if (adaBiaya) {
        const n = keAngka(nilaiBiayaAdmin);
        if (n === null || n <= 0)
          e.nilaiBiaya =
            pilihanBiaya === 'PERSEN_POKOK' ? 'Isi persentase biaya administrasi.' : 'Isi nominal biaya administrasi.';
        else if (pilihanBiaya === 'NOMINAL_TETAP' && !Number.isInteger(n))
          e.nilaiBiaya = 'Nominal biaya administrasi harus rupiah bulat (tanpa desimal).';
        if (!akunBiayaAdmin)
          e.akunBiaya = `Akun ${KODE_AKUN_BIAYA_ADMIN_DINI} Pendapatan Administrasi tidak ditemukan atau nonaktif di Daftar Akun.`;
      }
    }
    setGalat(e);
    return Object.keys(e).length === 0;
  };

  const tinjau = () => {
    if (!validasi()) {
      notify('Belum lengkap', 'Lengkapi isian yang ditandai sebelum menetapkan kebijakan.');
      return;
    }
    setLembarKonfirmasi(true);
  };

  const simpan = async () => {
    setLembarKonfirmasi(false);
    if (!currentUser) return;
    if (versi.trim() === '') {
      notify('Versi wajib diisi', 'Beri identitas versi kebijakan, misalnya nomor SK pengurus.');
      return;
    }
    if (diizinkan === null) {
      notify('Belum lengkap', 'Tentukan apakah penarikan dini diizinkan.');
      return;
    }

    setMenyimpan(true);
    try {
      // Nilai dikirim APA ADANYA; keputusan yang belum dipilih tetap null
      // (tanpa fallback) sehingga evaluator — bukan layar — yang menilai
      // kelengkapan, dan kebijakan tidak lengkap tetap menolak pencairan.
      const hasil = await simpanKebijakanDini({
        versi: versi.trim(),
        berlakuMulai,
        diizinkan,
        jenisPenalti,
        nilaiPenalti: adaPenalti ? keAngka(nilaiPenalti) : null,
        basisPenalti,
        akunPenaltiId: adaPenalti ? (akunPenalti?.id ?? null) : null,
        jenisForfeiture,
        nilaiForfeiture,
        jenisBiayaAdmin,
        nilaiBiayaAdmin: adaBiaya ? keAngka(nilaiBiayaAdmin) : null,
        basisBiayaAdmin,
        akunBiayaAdminId: adaBiaya ? (akunBiayaAdmin?.id ?? null) : null,
        rateDini,
        jenisPenyesuaianRate,
        cakupanPenyesuaianRate,
        perlakuanPokok,
        perlakuanBunga,
        dasarPenetapan: dasarPenetapan.trim() || null,
        ditetapkanOleh: ditetapkanOleh.trim() || null,
        createdBy: currentUser.id,
      });

      setEvaluasi(hasil.evaluasi);
      notify(
        hasil.evaluasi.status === 'AKTIF' ? 'Kebijakan tersimpan & aktif' : 'Kebijakan tersimpan',
        hasil.evaluasi.pesan,
      );
      setVersi('');
      await muat();
    } catch (e) {
      notify('Gagal menyimpan', pesanGagalSimpan(e));
    } finally {
      setMenyimpan(false);
    }
  };

  if (memuat) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const status = evaluasi?.status;
  const tampilanStatus =
    status === 'AKTIF'
      ? { judul: 'Kebijakan Aktif', ikon: 'shield-checkmark' as const, warna: colors.success, gaya: styles.statusAktif }
      : status === 'DILARANG'
        ? {
            judul: 'Penarikan Dini Tidak Diizinkan',
            ikon: 'ban-outline' as const,
            warna: colors.danger,
            gaya: styles.statusDilarang,
          }
        : {
            judul: 'Belum Ditetapkan',
            ikon: 'alert-circle-outline' as const,
            warna: colors.warning,
            gaya: styles.statusBelum,
          };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        <ScrollView style={styles.container} contentContainerStyle={styles.isi} keyboardShouldPersistTaps="handled">
          {/* ---------------- STATUS ---------------- */}
          <View style={[styles.statusBox, tampilanStatus.gaya]}>
            <Ionicons name={tampilanStatus.ikon} size={22} color={tampilanStatus.warna} />
            <View style={{ flex: 1 }}>
              <Text style={styles.statusJudul}>{tampilanStatus.judul}</Text>
              {status !== 'AKTIF' ? (
                <Text style={styles.statusPesan}>
                  {status === 'DILARANG'
                    ? 'Simpanan berjangka hanya dapat dicairkan saat jatuh tempo.'
                    : 'Penarikan sebelum jatuh tempo belum dapat diproses sampai kebijakan ditetapkan lengkap.'}
                </Text>
              ) : null}
              {aktif && (
                <Text style={styles.statusMeta}>
                  Versi {aktif.versi} · berlaku mulai {aktif.berlakuMulai}
                </Text>
              )}
            </View>
          </View>

          {/* ===================== MODE LIHAT ===================== */}
          {mode === 'LIHAT' && aktif ? (
            <>
              <Kartu ikon="shield-checkmark-outline" judul="Kebijakan Berlaku">
                <BarisRingkas label="Versi" nilai={aktif.versi} />
                <BarisRingkas label="Berlaku mulai" nilai={aktif.berlakuMulai} />
                <View style={styles.pemisah} />
                {deskripsiKebijakan(aktif).map((b) => (
                  <BarisRingkas key={b.label} label={b.label} nilai={b.nilai} />
                ))}
                {akunAktif.penalti ? (
                  <BarisRingkas label="Akun penalti" nilai={`${akunAktif.penalti.kode} ${akunAktif.penalti.nama}`} />
                ) : null}
                {akunAktif.biaya ? (
                  <BarisRingkas
                    label="Akun biaya administrasi"
                    nilai={`${akunAktif.biaya.kode} ${akunAktif.biaya.nama}`}
                  />
                ) : null}
                {(akunAktif.penalti && akunAktif.penalti.kode !== KODE_AKUN_PENALTI_DINI) ||
                (akunAktif.biaya && akunAktif.biaya.kode !== KODE_AKUN_BIAYA_ADMIN_DINI) ? (
                  <View style={styles.infoAkunLama}>
                    <Ionicons name="information-circle-outline" size={16} color={colors.warning} />
                    <Text style={styles.infoAkunLamaText}>
                      Versi ini masih memakai akun lama. Tetapkan versi baru agar penalti tercatat ke{' '}
                      {KODE_AKUN_PENALTI_DINI} dan biaya administrasi ke {KODE_AKUN_BIAYA_ADMIN_DINI}.
                    </Text>
                  </View>
                ) : null}
                {aktif.dasarPenetapan || aktif.ditetapkanOleh ? <View style={styles.pemisah} /> : null}
                {aktif.dasarPenetapan ? <BarisRingkas label="Dasar penetapan" nilai={aktif.dasarPenetapan} /> : null}
                {aktif.ditetapkanOleh ? <BarisRingkas label="Ditetapkan oleh" nilai={aktif.ditetapkanOleh} /> : null}
              </Kartu>

              {bacaan.jenis === 'LANJUTAN' ? (
                <View style={styles.infoLanjutan}>
                  <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
                  <Text style={styles.infoLanjutanText}>
                    Versi ini memakai pengaturan lanjutan dari versi sebelumnya dan tetap berlaku apa adanya. Saat diedit,
                    formulir dimulai kosong dan versi baru memakai ketentuan yang disederhanakan.
                  </Text>
                </View>
              ) : null}

              <TouchableOpacity style={styles.tombol} onPress={mulaiEdit} accessibilityRole="button">
                <Ionicons name="create-outline" size={18} color={colors.white} />
                <Text style={styles.tombolTeks}>Edit Kebijakan</Text>
              </TouchableOpacity>
              <Text style={styles.footnote}>
                Perubahan disimpan sebagai versi baru. Versi lama tidak dihapus dan tetap tercatat dalam riwayat.
              </Text>
            </>
          ) : null}

          {/* ===================== MODE EDIT ===================== */}
          {mode === 'EDIT' ? (
            <>
              {aktif ? (
                <View style={styles.editBanner}>
                  <Ionicons name="create-outline" size={18} color={colors.text} />
                  <Text style={styles.editBannerText}>
                    Mengubah kebijakan versi {aktif.versi}. Isi versi baru, lalu Tinjau &amp; Tetapkan.
                  </Text>
                  <TouchableOpacity onPress={() => setMode('LIHAT')} accessibilityRole="button" hitSlop={8}>
                    <Text style={styles.batalLink}>Batal</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {/* ---------------- IDENTITAS ---------------- */}
              <Kartu ikon="document-text-outline" judul="Identitas Kebijakan">
                <Label teks="Versi kebijakan *" />
                <FocusTextInput
                  style={[styles.input, galat.versi && styles.inputGalat]}
                  value={versi}
                  onChangeText={(t: string) => {
                    setVersi(t);
                    setGalat((g) => ({ ...g, versi: '' }));
                  }}
                  placeholder={aktif ? `Versi baru (berlaku: ${aktif.versi})` : 'Mis. nomor SK pengurus'}
                  placeholderTextColor={colors.placeholder}
                />
                <Galat teks={galat.versi} />
                <Label teks="Berlaku mulai *" />
                <DatePicker value={berlakuMulai} onChange={setBerlakuMulai} />
                <Label teks="Penarikan dini diizinkan? *" />
                <View style={styles.segmen}>
                  {[
                    { nilai: true, label: 'Diizinkan' },
                    { nilai: false, label: 'Tidak diizinkan' },
                  ].map((p) => (
                    <TouchableOpacity
                      key={String(p.nilai)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: diizinkan === p.nilai }}
                      style={[styles.segmenItem, diizinkan === p.nilai && styles.segmenItemAktif]}
                      onPress={() => {
                        setDiizinkan(p.nilai);
                        setGalat((g) => ({ ...g, diizinkan: '' }));
                      }}
                    >
                      <Text style={[styles.segmenText, diizinkan === p.nilai && styles.segmenTextAktif]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Galat teks={galat.diizinkan} />
              </Kartu>

              {diizinkan !== false && (
                <>
                  {/* ---------------- 1. PENALTI ---------------- */}
                  <Kartu ikon="remove-circle-outline" judul="Penalti Penarikan Dini" nomor={1}>
                    {OPSI_PENALTI.map((o) => (
                      <OpsiRadio
                        key={o.nilai}
                        label={LABEL_PENALTI[o.nilai]}
                        keterangan={o.keterangan}
                        aktif={pilihanPenalti === o.nilai}
                        onPress={() => {
                          if (pilihanPenalti !== o.nilai) setNilaiPenalti('');
                          setPilihanPenalti(o.nilai);
                          setGalat((g) => ({ ...g, penalti: '' }));
                        }}
                      />
                    ))}
                    <Galat teks={galat.penalti} />
                    {adaPenalti && (
                      <View style={styles.subIsian}>
                        <Label
                          teks={pilihanPenalti === 'PERSEN_POKOK' ? 'Persentase dari pokok *' : 'Nominal penalti *'}
                        />
                        <InputSatuan
                          nilai={nilaiPenalti}
                          onUbah={(t) => {
                            setNilaiPenalti(t);
                            setGalat((g) => ({ ...g, nilaiPenalti: '' }));
                          }}
                          satuan={pilihanPenalti === 'PERSEN_POKOK' ? '%' : 'Rp'}
                          galat={!!galat.nilaiPenalti}
                        />
                        <PratinjauNilai nilai={nilaiPenalti} satuan={pilihanPenalti === 'PERSEN_POKOK' ? '%' : 'Rp'} />
                        <Galat teks={galat.nilaiPenalti} />
                        <AkunTerkunci akun={akunPenalti} kodeBaku={KODE_AKUN_PENALTI_DINI} />
                        <Galat teks={galat.akunPenalti} />
                      </View>
                    )}
                  </Kartu>

                  {/* ---------------- 2. BUNGA ---------------- */}
                  <Kartu ikon="trending-up-outline" judul="Bunga" nomor={2}>
                    {OPSI_BUNGA.map((o) => (
                      <OpsiRadio
                        key={o.nilai}
                        label={LABEL_BUNGA[o.nilai]}
                        keterangan={o.keterangan}
                        aktif={pilihanBunga === o.nilai}
                        onPress={() => {
                          setPilihanBunga(o.nilai);
                          setGalat((g) => ({ ...g, bunga: '' }));
                        }}
                      />
                    ))}
                    <Galat teks={galat.bunga} />
                  </Kartu>

                  {/* ---------------- 3. BIAYA ADMINISTRASI ---------------- */}
                  <Kartu ikon="receipt-outline" judul="Biaya Administrasi" nomor={3}>
                    {OPSI_BIAYA.map((o) => (
                      <OpsiRadio
                        key={o.nilai}
                        label={LABEL_BIAYA[o.nilai]}
                        keterangan={o.keterangan}
                        aktif={pilihanBiaya === o.nilai}
                        onPress={() => {
                          if (pilihanBiaya !== o.nilai) setNilaiBiayaAdmin('');
                          setPilihanBiaya(o.nilai);
                          setGalat((g) => ({ ...g, biaya: '' }));
                        }}
                      />
                    ))}
                    <Galat teks={galat.biaya} />
                    {adaBiaya && (
                      <View style={styles.subIsian}>
                        <Label
                          teks={
                            pilihanBiaya === 'PERSEN_POKOK' ? 'Persentase dari pokok *' : 'Nominal biaya administrasi *'
                          }
                        />
                        <InputSatuan
                          nilai={nilaiBiayaAdmin}
                          onUbah={(t) => {
                            setNilaiBiayaAdmin(t);
                            setGalat((g) => ({ ...g, nilaiBiaya: '' }));
                          }}
                          satuan={pilihanBiaya === 'PERSEN_POKOK' ? '%' : 'Rp'}
                          galat={!!galat.nilaiBiaya}
                        />
                        <PratinjauNilai nilai={nilaiBiayaAdmin} satuan={pilihanBiaya === 'PERSEN_POKOK' ? '%' : 'Rp'} />
                        <Galat teks={galat.nilaiBiaya} />
                        <AkunTerkunci akun={akunBiayaAdmin} kodeBaku={KODE_AKUN_BIAYA_ADMIN_DINI} />
                        <Galat teks={galat.akunBiaya} />
                      </View>
                    )}
                  </Kartu>

                  {/* ---------------- CARA MENGHITUNG ---------------- */}
                  <View style={styles.rumusBox}>
                    <View style={styles.rumusHeader}>
                      <Ionicons name="calculator-outline" size={18} color={colors.text} />
                      <Text style={styles.rumusJudul}>Dihitung otomatis saat penarikan</Text>
                    </View>
                    <Text style={styles.rumusText}>
                      Petugas tidak perlu menghitung manual. Saat penarikan dini diproses di Tarik Simpanan Anggota,
                      sistem menampilkan Pokok, Bunga, Penalti, Biaya Administrasi, dan Total Diterima:
                    </Text>
                    <Text style={styles.rumusBaris}>Total Diterima = Pokok + Bunga − Penalti − Biaya Administrasi</Text>
                    <Text style={styles.rumusCatatan}>
                      Bila bunga hangus, bunga yang ikut dihitung bernilai 0. Persentase penalti dan biaya administrasi
                      dihitung dari pokok; keduanya dipotong dari dana pokok yang dikembalikan.
                    </Text>
                  </View>
                </>
              )}

              {/* ---------------- DASAR PENETAPAN ---------------- */}
              <Kartu ikon="create-outline" judul="Dasar Penetapan">
                <Label teks="Dasar penetapan" />
                <FocusTextInput
                  style={styles.input}
                  value={dasarPenetapan}
                  onChangeText={setDasarPenetapan}
                  placeholder="Nomor SK / hasil rapat pengurus"
                  placeholderTextColor={colors.placeholder}
                />
                <Label teks="Ditetapkan oleh" />
                <FocusTextInput
                  style={styles.input}
                  value={ditetapkanOleh}
                  onChangeText={setDitetapkanOleh}
                  placeholder="Nama/jabatan penetap"
                  placeholderTextColor={colors.placeholder}
                />
              </Kartu>

              <TouchableOpacity
                style={[styles.tombol, menyimpan && styles.tombolNonaktif]}
                onPress={tinjau}
                disabled={menyimpan}
                accessibilityRole="button"
              >
                {menyimpan ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <>
                    <Text style={styles.tombolTeks}>Tinjau &amp; Tetapkan</Text>
                    <Ionicons name="arrow-forward" size={18} color={colors.white} />
                  </>
                )}
              </TouchableOpacity>

              <Text style={styles.footnote}>
                Menetapkan kebijakan baru akan menonaktifkan kebijakan sebelumnya. Kebijakan lama tidak dihapus —
                settlement yang sudah terjadi tetap merujuk versi yang berlaku saat itu.
              </Text>
            </>
          ) : null}
        </ScrollView>

        {/* ---------------- KONFIRMASI ---------------- */}
        <Modal
          visible={lembarKonfirmasi}
          transparent
          animationType="slide"
          onRequestClose={() => setLembarKonfirmasi(false)}
        >
          <View style={styles.overlay}>
            <SafeAreaView edges={['bottom']} style={styles.lembar}>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
                <View style={styles.lembarPegangan} />
                <Text style={styles.lembarJudul}>
                  {aktif ? 'Tetapkan Versi Baru Kebijakan?' : 'Tetapkan Kebijakan Penarikan Dini?'}
                </Text>
                <Text style={styles.lembarSub}>
                  Versi {versi.trim()} · berlaku mulai {berlakuMulai}
                </Text>

                <View style={styles.ringkas}>
                  {draf
                    ? deskripsiKebijakan(draf).map((b) => {
                        const lama = aktif
                          ? deskripsiKebijakan(aktif).find((x) => x.label === b.label)?.nilai
                          : undefined;
                        return (
                          <BarisRingkas
                            key={b.label}
                            label={b.label}
                            nilai={b.nilai}
                            sebelumnya={lama !== b.nilai ? lama : undefined}
                          />
                        );
                      })
                    : null}
                  {adaPenalti && akunPenalti ? (
                    <BarisRingkas label="Akun penalti" nilai={`${akunPenalti.kode} ${akunPenalti.nama}`} />
                  ) : null}
                  {adaBiaya && akunBiayaAdmin ? (
                    <BarisRingkas
                      label="Akun biaya administrasi"
                      nilai={`${akunBiayaAdmin.kode} ${akunBiayaAdmin.nama}`}
                    />
                  ) : null}
                </View>

                {pratinjau ? (
                  <View
                    style={[styles.pratinjau, pratinjau.status === 'AKTIF' ? styles.pratinjauOk : styles.pratinjauWarn]}
                  >
                    <Ionicons
                      name={pratinjau.status === 'AKTIF' ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                      size={18}
                      color={pratinjau.status === 'AKTIF' ? colors.success : colors.warning}
                    />
                    {/* Mengikuti service: hanya versi berstatus AKTIF yang
                        dipromosikan. Selain itu versi tersimpan sebagai draf dan
                        kebijakan yang berlaku (bila ada) tidak berubah. */}
                    <Text style={styles.pratinjauText}>
                      {pratinjau.status === 'AKTIF'
                        ? aktif
                          ? `Versi baru langsung berlaku menggantikan versi ${aktif.versi}. Versi lama tetap tersimpan di riwayat.`
                          : 'Kebijakan lengkap dan langsung berlaku untuk penarikan dini berikutnya.'
                        : aktif
                          ? `Versi ini disimpan sebagai draf dan BELUM berlaku; versi ${aktif.versi} tetap dipakai.`
                          : 'Versi ini disimpan sebagai draf dan belum berlaku; penarikan dini tetap belum dapat diproses.'}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.lembarTombol}>
                  <TouchableOpacity
                    style={styles.tombolBatal}
                    onPress={() => setLembarKonfirmasi(false)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.tombolBatalText}>Periksa Lagi</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.tombolKonfirmasi}
                    onPress={() => void simpan()}
                    accessibilityRole="button"
                  >
                    <Ionicons name="checkmark-circle-outline" size={18} color={colors.white} />
                    <Text style={styles.tombolTeks}>Tetapkan</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      </View>
    </AreaAmanKeyboard>
  );
}

function Kartu({
  judul,
  ikon,
  nomor,
  children,
}: {
  judul: string;
  ikon: keyof typeof Ionicons.glyphMap;
  nomor?: number;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.kartu}>
      <View style={styles.kartuHeader}>
        <View style={styles.kartuIkon}>
          <Ionicons name={ikon} size={18} color={colors.text} />
        </View>
        <Text style={styles.kartuJudul}>
          {nomor ? `${nomor}. ` : ''}
          {judul}
        </Text>
      </View>
      {children}
    </View>
  );
}

function Label({ teks }: { teks: string }) {
  return <Text style={styles.label}>{teks}</Text>;
}

function Galat({ teks }: { teks?: string }) {
  if (!teks) return null;
  return (
    <View style={styles.galatRow}>
      <Ionicons name="alert-circle" size={13} color={colors.danger} />
      <Text style={styles.galatText}>{teks}</Text>
    </View>
  );
}

function OpsiRadio({
  label,
  keterangan,
  aktif,
  onPress,
}: {
  label: string;
  keterangan: string;
  aktif: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={{ selected: aktif }}
      style={[styles.opsi, aktif && styles.opsiAktif]}
      onPress={onPress}
    >
      <Ionicons
        name={aktif ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={aktif ? colors.text : colors.textFaint}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.opsiLabel, aktif && styles.opsiLabelAktif]}>{label}</Text>
        <Text style={styles.opsiKeterangan}>{keterangan}</Text>
      </View>
    </TouchableOpacity>
  );
}

function InputSatuan({
  nilai,
  onUbah,
  satuan,
  galat,
}: {
  nilai: string;
  onUbah: (t: string) => void;
  satuan: 'Rp' | '%';
  galat: boolean;
}) {
  // Rupiah: tampil berpemisah ribuan ("100.000") saat diketik, tetapi
  // state tetap digit murni ("100000") — pola yang sama dengan
  // CurrencyInput (formatNominalInput/parseNominalInput). Persentase
  // dibiarkan apa adanya supaya koma desimal ("2,5") tetap dapat diketik.
  const tampil = satuan === 'Rp' ? formatNominalInput(parseNominalInput(nilai)) : nilai;
  const ubah = (t: string) => {
    if (satuan !== 'Rp') return onUbah(t);
    const n = parseNominalInput(t);
    onUbah(n === '' ? '' : String(n));
  };
  return (
    <View style={[styles.inputSatuan, galat && styles.inputGalat]}>
      {satuan === 'Rp' ? <Text style={styles.satuan}>Rp</Text> : null}
      <FocusTextInput
        style={styles.inputSatuanField}
        value={tampil}
        onChangeText={ubah}
        keyboardType={satuan === '%' ? 'decimal-pad' : 'number-pad'}
        placeholder="0"
        placeholderTextColor={colors.placeholder}
      />
      {satuan === '%' ? <Text style={styles.satuan}>%</Text> : null}
    </View>
  );
}

/** Pratinjau nilai yang diketik (tampilan saja): "= Rp10.000" atau "= 2,5% dari pokok". */
function PratinjauNilai({ nilai, satuan }: { nilai: string; satuan: 'Rp' | '%' }) {
  const n = keAngka(nilai);
  if (n === null || n <= 0) return null;
  return (
    <Text style={styles.pratinjauNilai}>
      = {satuan === 'Rp' ? formatRupiah(n) : `${String(n).replace('.', ',')}% dari pokok`}
    </Text>
  );
}

/**
 * Akun pendapatan TERKUNCI — ditampilkan read-only (bukan picker).
 * Penalti selalu 4-1150, biaya administrasi selalu 4-1100.
 */
function AkunTerkunci({ akun, kodeBaku }: { akun: AkunTetapKebijakanDini | null; kodeBaku: string }) {
  return (
    <View style={styles.akunKunciWrap}>
      <Text style={styles.label}>Dicatat ke akun pendapatan</Text>
      <View
        style={[styles.akunKunci, !akun && styles.inputGalat]}
        accessibilityLabel={akun ? `Akun ${akun.kode} ${akun.nama}, terkunci` : `Akun ${kodeBaku} tidak ditemukan`}
      >
        <View style={styles.akunKunciKode}>
          <Text style={styles.akunKunciKodeText}>{akun?.kode ?? kodeBaku}</Text>
        </View>
        <Text style={styles.akunKunciNama} numberOfLines={2}>
          {akun?.nama ?? 'Akun tidak ditemukan di Daftar Akun'}
        </Text>
        <Ionicons name="lock-closed" size={16} color={colors.textFaint} />
      </View>
      <Text style={styles.akunKunciHint}>Akun ditetapkan sistem dan tidak dapat diubah.</Text>
    </View>
  );
}

function BarisRingkas({ label, nilai, sebelumnya }: { label: string; nilai: string; sebelumnya?: string }) {
  return (
    <View style={styles.ringkasRow}>
      <Text style={styles.ringkasLabel}>{label}</Text>
      <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>
        <Text style={styles.ringkasNilai}>{nilai}</Text>
        {sebelumnya ? <Text style={styles.ringkasLama}>sebelumnya: {sebelumnya}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  akunKunciWrap: { marginTop: 0 },
  akunKunci: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  akunKunciKode: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  akunKunciKodeText: { fontSize: 12, fontWeight: '700', color: colors.primary, fontVariant: ['tabular-nums'] },
  akunKunciNama: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text },
  akunKunciHint: { fontSize: 11, color: colors.textFaint, marginTop: 4 },
  infoAkunLama: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'flex-start',
    backgroundColor: '#FFF7E6',
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  infoAkunLamaText: { flex: 1, fontSize: 11, color: '#8A6D3B', lineHeight: 15 },
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  statusBox: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.md,
    alignItems: 'flex-start',
  },
  statusAktif: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  statusBelum: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  statusDilarang: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBg },
  statusJudul: { fontSize: 15, fontWeight: '700', color: colors.text },
  statusPesan: { fontSize: 12, color: colors.text, marginTop: 2, lineHeight: 17 },
  statusMeta: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  infoLanjutan: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  infoLanjutanText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kartuHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  kartuIkon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kartuJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  label: { fontSize: 12, fontWeight: '600', color: colors.text, marginTop: spacing.sm, marginBottom: spacing.xs },
  input: { ...formUi.inputStandalone },
  inputGalat: { borderColor: colors.danger },
  galatRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  galatText: { fontSize: 11.5, color: colors.danger, flex: 1 },
  segmen: { flexDirection: 'row', gap: spacing.sm },
  segmenItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmenItemAktif: { backgroundColor: colors.text, borderColor: colors.text },
  segmenText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  segmenTextAktif: { color: colors.white },
  opsi: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  opsiAktif: { borderColor: colors.text, borderWidth: 1.5, backgroundColor: colors.background },
  opsiLabel: { fontSize: 13.5, fontWeight: '600', color: colors.text },
  opsiLabelAktif: { fontWeight: '700' },
  opsiKeterangan: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  subIsian: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, marginTop: spacing.xs },
  inputSatuan: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  inputSatuanField: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.text },
  satuan: { fontSize: 14, fontWeight: '700', color: colors.textMuted, paddingHorizontal: 4 },
  pratinjauNilai: { fontSize: 11.5, color: colors.textMuted, marginTop: 4 },
  rumusBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  rumusHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  rumusJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  rumusText: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  rumusBaris: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  rumusCatatan: { fontSize: 11.5, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  tombol: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 15,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  tombolNonaktif: { opacity: 0.6 },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 15 },
  footnote: { fontSize: 11, color: colors.textFaint, marginTop: spacing.md, lineHeight: 16, textAlign: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  lembar: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.md * 2,
    borderTopRightRadius: radius.md * 2,
    maxHeight: '90%',
  },
  lembarPegangan: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  lembarJudul: { fontSize: 17, fontWeight: '700', color: colors.text },
  lembarSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  ringkas: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md },
  ringkasRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  ringkasLabel: { fontSize: 13, color: colors.textMuted },
  ringkasNilai: { fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'right' },
  ringkasLama: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'right',
    marginTop: 1,
    textDecorationLine: 'line-through',
  },
  pemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  editBannerText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  batalLink: { fontSize: 13, fontWeight: '700', color: colors.danger },
  pratinjau: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
  },
  pratinjauOk: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  pratinjauWarn: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  pratinjauText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  lembarTombol: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tombolBatal: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tombolBatalText: { fontSize: 15, fontWeight: '700', color: colors.text },
  tombolKonfirmasi: {
    flex: 2,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
});
