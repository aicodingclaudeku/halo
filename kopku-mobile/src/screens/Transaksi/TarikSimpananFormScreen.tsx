import React, { useCallback, useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { tentukanAksiPencairanDini } from '@/screens/Simpanan/aksiPencairanDini';
import { Ionicons } from '@expo/vector-icons';
import AnggotaPicker from '@/components/AnggotaPicker';
import { listSimpananBerjangka, SimpananBerjangkaRow } from '@/services/SimpananBerjangkaService';
import {
  cairkanSimpananBerjangka,
  getRingkasanPencairan,
  RingkasanPencairan,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  previewPencairanDini,
  PreviewPencairanDini,
  getStatusKebijakanDini,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { HasilEvaluasiKebijakan } from '@/accounting/EarlyWithdrawalPolicy';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import RekeningPicker from '@/components/RekeningPicker';
import FocusTextInput from '@/components/FocusTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { Anggota, getAnggotaById } from '@/repositories/AnggotaRepository';
import { tarikSimpananSukarela, getSaldoSimpananAnggota } from '@/services/SimpananService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, semantic, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { usePermission } from '@/hooks/usePermission';
import {
  alokasiPembayaranDini,
  badgeKontrak,
  BarisKonfirmasi,
  jenisTransaksiBerjangka,
  ringkasanKonfirmasiDini,
  ringkasanKonfirmasiJatuhTempo,
  ringkasanBungaKeSukarela,
  tanggalRingkas,
  type NadaBadge,
} from '@/utils/tarikSimpananUi';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Sub-fitur "Tarik Simpanan Anggota" (menu Pengeluaran, dikelompokkan
 * dengan Kewajiban) — sebelumnya digabung dengan Setor lewat chip
 * Setor/Tarik di SimpananFormScreen yang dipanggil dari menu
 * Penerimaan. Itu keliru: penarikan simpanan sukarela adalah
 * koperasi MENGELUARKAN uang untuk melunasi kewajibannya ke anggota
 * (persis seperti melunasi utang), bukan penerimaan. Service yang
 * dipakai (tarikSimpananSukarela di SimpananService.ts) SAMA PERSIS,
 * tidak ada perubahan logika/jurnal — cuma pintu masuk UI-nya pindah.
 */
export default function TarikSimpananFormScreen({ route }: { route?: any }) {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  // RC-S47 §F — dibuka dari detail kontrak dengan kontrak & anggota
  // yang SUDAH dipilih. Tanpa ini, pengguna yang baru saja melihat
  // sebuah kontrak harus mencari anggota dan kontrak itu lagi dari awal
  // di layar ini. Parameternya hanya PREFILL: seluruh validasi,
  // preview, dan service yang dipanggil tidak berubah, dan pengguna
  // tetap bebas mengganti pilihan.
  const paramJenis: 'BERJANGKA' | undefined =
    route?.params?.jenis === 'BERJANGKA' ? 'BERJANGKA' : undefined;
  const paramAnggotaId: string | undefined = route?.params?.anggotaId;
  const paramKontrakId: string | undefined = route?.params?.kontrakId;

  // RC-S70.1 — LAYAR BERSAMA (dipakai Pengeluaran DAN Simpanan >
  // Detail Kontrak Berjangka). Default ikon TIDAK diubah; hanya ketika
  // dibuka dari menu Pengeluaran (param `aksen`) ikon identitasnya
  // memakai merah Pengeluaran. Murni tampilan — tidak menyentuh
  // prefill, validasi, maupun service pencairan.
  const ikonAksen = route?.params?.aksen === 'PENGELUARAN' ? semantic.expenseIcon : colors.primary;

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nominal, setNominal] = useState<number | ''>('');
  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK'>('KAS');
  const [bankRekening, setBankRekening] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // §23 — pilihan jenis penarikan. Alur SUKARELA di bawah TIDAK DIUBAH
  // sedikit pun; mode BERJANGKA adalah cabang terpisah yang memakai
  // service lifecycle simpanan berjangka. Keduanya tidak pernah tampil
  // bersamaan, sehingga tidak ada field yang saling mengganggu.
  const [jenis, setJenis] = useState<'SUKARELA' | 'BERJANGKA'>(paramJenis ?? 'SUKARELA');
  const [kontrakList, setKontrakList] = useState<SimpananBerjangkaRow[]>([]);
  const [kontrakDipilih, setKontrakDipilih] = useState<SimpananBerjangkaRow | null>(null);
  const [ringkasanCair, setRingkasanCair] = useState<RingkasanPencairan | null>(null);

  // §AH — penarikan sebelum jatuh tempo. Preview SELALU berasal dari
  // `previewPencairanDini()`, yang memakai mesin perhitungan yang SAMA
  // dengan eksekusi. Layar ini TIDAK menghitung apa pun sendiri —
  // termasuk tidak menjumlahkan ulang total — supaya angka di layar
  // mustahil berbeda dengan angka yang dibukukan.
  const [statusKebijakanDini, setStatusKebijakanDini] = useState<HasilEvaluasiKebijakan | null>(null);
  const [previewDini, setPreviewDini] = useState<PreviewPencairanDini | null>(null);
  const [alasanDini, setAlasanDini] = useState('');
  const [konfirmasiDini, setKonfirmasiDini] = useState(false);

  const [saldoSukarela, setSaldoSukarela] = useState<number | null>(null);
  const [cekingSaldo, setCekingSaldo] = useState(false);

  /** §F — parameter prefill hanya dikonsumsi sekali (lihat pemakaian). */
  const paramKontrakDipakai = useRef(false);
  const paramAnggotaDipakai = useRef(false);

  // Anggota dari layar detail kontrak. Dibaca lewat repository yang
  // sudah ada; tidak ada objek anggota yang dititipkan lewat parameter
  // navigasi (data titipan bisa basi terhadap database).
  useEffect(() => {
    if (!paramAnggotaId || paramAnggotaDipakai.current) return;
    paramAnggotaDipakai.current = true;
    let cancelled = false;
    getAnggotaById(paramAnggotaId)
      .then((a) => {
        if (!cancelled && a) setAnggota(a);
      })
      .catch(() => {
        /* Anggota tidak terbaca -> pengguna memilih manual seperti biasa. */
      });
    return () => {
      cancelled = true;
    };
  }, [paramAnggotaId]);

  useEffect(() => {
    if (!anggota) {
      setSaldoSukarela(null);
      return;
    }
    let cancelled = false;
    setCekingSaldo(true);
    getSaldoSimpananAnggota(anggota.id, 'SUKARELA')
      .then((saldo) => {
        if (!cancelled) setSaldoSukarela(saldo);
      })
      .catch(() => {
        if (!cancelled) setSaldoSukarela(null);
      })
      .finally(() => {
        if (!cancelled) setCekingSaldo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [anggota]);

  const saldoTidakCukup = saldoSukarela !== null && nominal !== '' && nominal > saldoSukarela;

  /**
   * Status kebijakan penarikan dini. UI tidak boleh menebak: kalau
   * kebijakan belum lengkap, tombol penarikan dini memang tidak
   * tersedia.
   *
   * RC-S47 §H — DIBACA ULANG SAAT LAYAR KEMBALI DIFOKUSKAN.
   *
   * Versi sebelumnya memakai `useEffect(..., [jenis])`. Kebijakan
   * penarikan dini diisi di layar LAIN (Kebijakan Penarikan Dini, dibuka
   * dari layar ini), dan native stack tidak meng-unmount layar yang
   * ditinggalkan — jadi saat pengurus melengkapi kebijakan lalu
   * kembali ke sini, `jenis` tidak berubah, efeknya tidak berjalan
   * ulang, dan layar tetap menampilkan POLICY_REQUIRED sampai aplikasi
   * di-restart. Persis gejala "sudah diisi tapi tombolnya masih mati".
   *
   * `useFocusRefresh` MENGGANTI useEffect (bukan ditambahkan di
   * sampingnya): useFocusEffect juga menjalankan ulang callback saat
   * dependensinya berubah selagi layar fokus, sehingga perilaku lama
   * untuk perubahan `jenis` tetap utuh tanpa kueri ganda.
   */
  const permintaanKebijakan = usePermintaanTerakhir();
  const muatStatusKebijakan = useCallback(async () => {
    if (jenis !== 'BERJANGKA') return;
    const token = permintaanKebijakan.mulai();
    try {
      const st = await getStatusKebijakanDini();
      if (!permintaanKebijakan.masihTerbaru(token)) return;
      setStatusKebijakanDini(st);
    } catch {
      if (!permintaanKebijakan.masihTerbaru(token)) return;
      setStatusKebijakanDini(null);
    }
  }, [jenis, permintaanKebijakan]);

  useFocusRefresh(() => {
    void muatStatusKebijakan();
  }, [muatStatusKebijakan]);

  // Muat kontrak berjangka milik anggota saat mode BERJANGKA dipilih.
  useEffect(() => {
    setKontrakDipilih(null);
    setRingkasanCair(null);
    setPreviewDini(null);
    setKonfirmasiDini(false);
    if (jenis !== 'BERJANGKA' || !anggota) {
      setKontrakList([]);
      return;
    }
    let cancelled = false;
    listSimpananBerjangka(anggota.id)
      .then((rows) => {
        if (cancelled) return;
        setKontrakList(rows);
        // §F — kontrak yang dikirim layar detail dipilih otomatis, SATU
        // KALI saja (`paramKontrakDipakai`). Tanpa penanda itu, setiap
        // pemuatan ulang daftar akan memaksa pilihan kembali ke kontrak
        // parameter dan pengguna tidak bisa berpindah kontrak.
        if (paramKontrakId && !paramKontrakDipakai.current) {
          const cocok = rows.find((r) => r.id === paramKontrakId);
          if (cocok) {
            paramKontrakDipakai.current = true;
            setKontrakDipilih(cocok);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setKontrakList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [jenis, anggota?.id, paramKontrakId]);

  useEffect(() => {
    if (!kontrakDipilih) {
      setRingkasanCair(null);
      return;
    }
    let cancelled = false;
    getRingkasanPencairan(kontrakDipilih.id, tanggal)
      .then((r) => {
        if (!cancelled) setRingkasanCair(r);
      })
      .catch(() => {
        if (!cancelled) setRingkasanCair(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kontrakDipilih?.id, tanggal]);

  /**
   * Preview penarikan dini. Dimuat ulang saat TANGGAL berubah juga,
   * karena bunga berjalan, penalti, dan biaya administrasi bergantung
   * pada tanggal bisnis pencairan — bukan pada tanggal input.
   *
   * §H — juga dimuat ulang saat layar difokuskan, dengan alasan yang
   * sama seperti status kebijakan di atas: `previewPencairanDini()`
   * membawa `statusKebijakan` DAN `alasanTidakBoleh`, jadi preview yang
   * basi berarti tombol yang salah. Konfirmasi centang direset setiap
   * pemuatan — persetujuan atas potongan LAMA tidak boleh terbawa ke
   * angka baru.
   */
  const permintaanPreview = usePermintaanTerakhir();
  const muatPreviewDini = useCallback(async () => {
    setKonfirmasiDini(false);
    if (!kontrakDipilih || kontrakDipilih.status !== 'AKTIF') {
      setPreviewDini(null);
      return;
    }
    const token = permintaanPreview.mulai();
    try {
      const p = await previewPencairanDini(kontrakDipilih.id, tanggal);
      if (!permintaanPreview.masihTerbaru(token)) return;
      setPreviewDini(p);
    } catch {
      if (!permintaanPreview.masihTerbaru(token)) return;
      setPreviewDini(null);
    }
  }, [kontrakDipilih?.id, kontrakDipilih?.status, tanggal, permintaanPreview]);

  useFocusRefresh(() => {
    void muatPreviewDini();
  }, [muatPreviewDini]);

  const modeDini = !!kontrakDipilih && kontrakDipilih.status === 'AKTIF';

  /**
   * §I/§U — status tampilan pencairan dini, dihitung SATU KALI dari
   * evaluasi domain. Fungsinya murni & dipakai bersama layar detail
   * kontrak, sehingga kedua layar tidak mungkin menampilkan kesimpulan
   * berbeda untuk kebijakan yang sama.
   *
   * Perhatikan: ini HANYA untuk teks & badge. Hidup/matinya tombol
   * submit tetap ditentukan `bolehSubmitDini` di bawah, yang menuntut
   * settlement benar-benar terhitung DAN pengguna mencentang
   * konfirmasi. Tidak ada satu pun guard yang digantikan oleh nilai ini.
   */
  const aksiDini = tentukanAksiPencairanDini({
    statusKontrak: kontrakDipilih?.status ?? 'DIBATALKAN',
    sudahJatuhTempo: previewDini?.sudahJatuhTempo ?? false,
    evaluasi: statusKebijakanDini,
    alasanTidakBoleh: previewDini?.alasanTidakBoleh ?? null,
    adaSettlement: !!previewDini?.settlement,
  });

  const bolehSubmitDini =
    modeDini && !!previewDini && !previewDini.alasanTidakBoleh && !!previewDini.settlement && konfirmasiDini;

  const submitPencairanDini = async () => {
    if (!kontrakDipilih || !currentUser || !previewDini?.settlement) return;
    if (previewDini.alasanTidakBoleh) {
      notify('Tidak dapat dicairkan', previewDini.alasanTidakBoleh);
      return;
    }
    if (sumberDana === 'BANK' && !bankRekening) {
      setErrors({ bankRekening: 'Bank wajib dipilih' });
      return;
    }
    setSubmitting(true);
    try {
      const hasil = await cairkanSimpananBerjangkaDini({
        kontrakId: kontrakDipilih.id,
        tanggal,
        sumberDana,
        bankAccountId: sumberDana === 'BANK' ? bankRekening?.id : undefined,
        alasan: alasanDini || undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      const st = hasil.settlement;
      notify(
        'Pencairan dini berhasil',
        st
          ? `Pokok ${formatRupiah(st.pokokDibayar)} + bunga ${formatRupiah(st.bungaDibayar)} = ` +
              `${formatRupiah(st.totalPayout)}.`
          : 'Pencairan dini sudah pernah dicatat sebelumnya.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitPencairan = async () => {
    if (!kontrakDipilih || !currentUser || !ringkasanCair) return;
    if (ringkasanCair.alasanTidakBolehCair) {
      notify('Tidak dapat dicairkan', ringkasanCair.alasanTidakBolehCair);
      return;
    }
    if (sumberDana === 'BANK' && !bankRekening) {
      setErrors({ bankRekening: 'Bank wajib dipilih' });
      return;
    }
    setSubmitting(true);
    try {
      const hasil = await cairkanSimpananBerjangka({
        kontrakId: kontrakDipilih.id,
        tanggal,
        sumberDana,
        bankAccountId: sumberDana === 'BANK' ? bankRekening?.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      notify(
        'Pencairan berhasil',
        hasil.bunga > 0
          ? `Pokok ${formatRupiah(hasil.pokok)} + bunga ${formatRupiah(hasil.bunga)} = ${formatRupiah(hasil.total)}.`
          : `Pokok ${formatRupiah(hasil.pokok)} dicairkan kepada anggota (diterima ${formatRupiah(hasil.totalDibayarBersih)}). ` +
            (hasil.bungaDipindahkanSaatPencairan > 0
              ? `Bunga ${formatRupiah(hasil.bungaDipindahkanSaatPencairan)} dipindahkan ke Simpanan Sukarela pada pencairan ini. `
              : '') +
            'Bunga kontrak ini tidak dibayar tunai karena dikreditkan ke Simpanan Sukarela. Bukti pencairan dapat dicetak dari detail kontrak.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!anggota) e.anggota = 'Anggota wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih dari 0';
    if (saldoTidakCukup) {
      e.nominal = `Saldo sukarela tidak cukup (saldo: ${formatRupiah(saldoSukarela ?? 0)})`;
    }
    if (sumberDana === 'BANK' && !bankRekening) e.bankRekening = 'Bank wajib dipilih';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const beritahuSaldoTidakCukup = () =>
    notify(
      'Saldo Tidak Cukup',
      `Saldo simpanan sukarela ${anggota?.namaLengkap} saat ini ${formatRupiah(saldoSukarela ?? 0)}, ` +
        `tidak cukup untuk penarikan ${formatRupiah(nominal || 0)}.`
    );

  const submit = async () => {
    if (!validate()) {
      if (saldoTidakCukup) beritahuSaldoTidakCukup();
      return;
    }
    if (!anggota || !currentUser || nominal === '') return;
    setSubmitting(true);
    try {
      await tarikSimpananSukarela({
        anggotaId: anggota.id,
        tanggal,
        nominal,
        sumberDana,
        bankAccountId: sumberDana === 'BANK' ? bankRekening?.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Penarikan simpanan sukarela berhasil disimpan.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // ============================================================
  // KONFIRMASI — tombol utama TIDAK langsung menyimpan. Ringkasan
  // ditampilkan dulu; tombol "Konfirmasi" pada lembar itu memanggil
  // handler yang SAMA seperti sebelumnya (submit / submitPencairan /
  // submitPencairanDini), lengkap dengan seluruh guard-nya.
  // ============================================================
  const { can } = usePermission();
  // Gerbang yang SAMA dengan menu Pengaturan sebelumnya (resource
  // 'pengaturan', aksi 'view'); menyimpan tetap dituntut service
  // `simpanKebijakanDini()` dengan izin `pengaturan:edit`.
  const bolehBukaKebijakan = can('pengaturan', 'view');
  const [lembarKonfirmasi, setLembarKonfirmasi] = useState(false);

  const jenisBerjangka = kontrakDipilih ? jenisTransaksiBerjangka(kontrakDipilih.status) : null;
  const kebijakanDiniAktif = statusKebijakanDini?.status === 'AKTIF';

  const tombolNonaktif =
    submitting ||
    (jenis === 'SUKARELA' && saldoTidakCukup) ||
    (jenis === 'BERJANGKA' &&
      (modeDini ? !bolehSubmitDini : !ringkasanCair || !!ringkasanCair.alasanTidakBolehCair));

  const bukaKonfirmasi = () => {
    if (jenis === 'SUKARELA') {
      if (!validate()) {
        if (saldoTidakCukup) beritahuSaldoTidakCukup();
        return;
      }
    } else if (sumberDana === 'BANK' && !bankRekening) {
      setErrors({ bankRekening: 'Bank wajib dipilih' });
      return;
    }
    setLembarKonfirmasi(true);
  };

  const jalankanKonfirmasi = () => {
    setLembarKonfirmasi(false);
    if (jenis === 'BERJANGKA') {
      if (modeDini) void submitPencairanDini();
      else void submitPencairan();
    } else {
      void submit();
    }
  };

  const barisKonfirmasi: BarisKonfirmasi[] =
    jenis === 'SUKARELA'
      ? nominal === ''
        ? []
        : [{ label: 'Nominal penarikan', nilai: nominal, jenis: 'TOTAL' }]
      : modeDini
        ? previewDini?.settlement
          ? ringkasanKonfirmasiDini(previewDini.settlement)
          : []
        : ringkasanCair
          ? ringkasanKonfirmasiJatuhTempo(ringkasanCair)
          : [];

  const labelTombol =
    jenis === 'BERJANGKA' ? (modeDini ? 'Lanjutkan Penarikan Dini' : 'Lanjutkan Pencairan') : 'Lanjutkan Penarikan';

  const kontrakBisaDiproses = kontrakList.filter((k) => k.status === 'JATUH_TEMPO' || k.status === 'AKTIF');
  const kontrakSelesai = kontrakList.filter((k) => !(k.status === 'JATUH_TEMPO' || k.status === 'AKTIF'));

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        <ScrollView
          style={styles.container}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
              lewat Detail History Transaksi (satu pintu). */}
          <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="SIMPANAN_TARIK" />
          {tabMenu === 'RIWAYAT' ? (
            <RiwayatTransaksiMenu menu="SIMPANAN_TARIK" />
          ) : (
          <>
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={18} color={ikonAksen} />
            <Text style={styles.infoText}>
              Satu tempat untuk seluruh penarikan simpanan anggota. Simpanan sukarela ditarik sesuai saldo.
              Simpanan berjangka dicairkan otomatis sebagai Jatuh Tempo atau Penarikan Dini mengikuti tanggal
              jatuh temponya. Simpanan pokok &amp; wajib tidak dapat ditarik selama masih menjadi anggota.
            </Text>
          </View>

          {/* ---------------- 1. JENIS SIMPANAN ---------------- */}
          <View style={styles.card}>
            <JudulLangkah nomor={1} judul="Jenis Simpanan" />
            <View style={styles.jenisRow}>
              {/*
                RC-S53 §E — berpindah jenis MENGOSONGKAN anggota terpilih
                (kandidat kedua jenis berbeda). Dilakukan di handler, BUKAN
                di useEffect atas `jenis`, supaya prefill `paramAnggotaId`
                dari layar detail tidak terhapus saat mount.
              */}
              <JenisCard
                label="Simpanan Sukarela"
                keterangan="Tarik sesuai saldo"
                ikon="wallet-outline"
                warnaIkon={ikonAksen}
                active={jenis === 'SUKARELA'}
                onPress={() => {
                  if (jenis === 'SUKARELA') return;
                  setAnggota(null);
                  setJenis('SUKARELA');
                }}
              />
              <JenisCard
                label="Simpanan Berjangka"
                keterangan="Jatuh tempo / penarikan dini"
                ikon="time-outline"
                warnaIkon={ikonAksen}
                active={jenis === 'BERJANGKA'}
                onPress={() => {
                  if (jenis === 'BERJANGKA') return;
                  setAnggota(null);
                  setJenis('BERJANGKA');
                }}
              />
            </View>
            {/* §L — penjelasan singkat, tanpa menjanjikan angka apa pun. */}
            {jenis === 'BERJANGKA' && (
              <Text style={styles.jenisKeterangan}>
                Simpanan dengan jangka waktu dan tanggal jatuh tempo sesuai ketentuan koperasi.
                Pencairan sebelum tanggal jatuh tempo mengikuti kebijakan penarikan dini koperasi.
              </Text>
            )}
            {/* Pintu masuk kebijakan penarikan dini (lihat & edit) — selalu
                tersedia di mode berjangka bagi yang berizin, tidak hanya saat
                kebijakan belum aktif. Gerbang izin sama dengan panel di bawah. */}
            {jenis === 'BERJANGKA' && bolehBukaKebijakan ? (
              <TouchableOpacity
                style={styles.linkKebijakan}
                accessibilityRole="button"
                onPress={() => navigation.navigate('KebijakanPenarikanDini')}
              >
                <Ionicons name="document-text-outline" size={16} color={ikonAksen} />
                <Text style={styles.linkKebijakanText}>Kebijakan Penarikan Dini</Text>
                <Text style={styles.linkKebijakanStatus}>
                  {statusKebijakanDini?.status === 'AKTIF' ? 'Aktif' : 'Belum aktif'}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* ---------------- 2. ANGGOTA ---------------- */}
          <View style={styles.card}>
            <JudulLangkah nomor={2} judul="Anggota" />
            {/*
              RC-S53 §E — kandidat anggota mengikuti jenis:
              SUKARELA  : anggota dengan saldo sukarela > 0.
              BERJANGKA : anggota yang punya kontrak AKTIF/JATUH_TEMPO.
            */}
            <AnggotaPicker
              value={anggota}
              onChange={setAnggota}
              error={errors.anggota}
              onlyWithSaldoSukarela={jenis === 'SUKARELA'}
              onlyWithBerjangkaEligible={jenis === 'BERJANGKA'}
            />

            {jenis === 'SUKARELA' && anggota && (
              <View style={styles.saldoBox}>
                <Ionicons name="wallet-outline" size={20} color={ikonAksen} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.saldoLabel}>Saldo simpanan sukarela</Text>
                  {cekingSaldo ? (
                    <Text style={styles.saldoText}>Mengecek saldo…</Text>
                  ) : (
                    <Text style={styles.saldoNominal}>{formatRupiah(saldoSukarela ?? 0)}</Text>
                  )}
                </View>
              </View>
            )}
          </View>

          {/* ---------------- 3. KONTRAK BERJANGKA ---------------- */}
          {jenis === 'BERJANGKA' && anggota && (
            <View style={styles.card}>
              <JudulLangkah nomor={3} judul="Kontrak Simpanan Berjangka" />
              {kontrakList.length === 0 ? (
                <View style={styles.kosongBox}>
                  <Ionicons name="file-tray-outline" size={28} color={colors.textFaint} />
                  <Text style={styles.kosongJudul}>Belum ada simpanan berjangka</Text>
                  <Text style={styles.kosongText}>Anggota ini tidak memiliki kontrak simpanan berjangka.</Text>
                </View>
              ) : (
                <>
                  {[...kontrakBisaDiproses, ...kontrakSelesai].map((k) => {
                    // §48/RC-S43 — kontrak AKTIF selalu dapat dipilih (agar
                    // penjelasan kebijakan sampai ke pengguna); eksekusi tetap
                    // tertahan tiga lapis guard di bawah & di service.
                    const selectable = k.status === 'JATUH_TEMPO' || k.status === 'AKTIF';
                    const dipilih = kontrakDipilih?.id === k.id;
                    const badge = badgeKontrak(k.status, kebijakanDiniAktif);
                    return (
                      <TouchableOpacity
                        key={k.id}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: dipilih, disabled: !selectable }}
                        style={[styles.kontrakCard, dipilih && styles.kontrakCardAktif, !selectable && styles.kontrakCardNonaktif]}
                        disabled={!selectable}
                        onPress={() => setKontrakDipilih(k)}
                      >
                        <View style={styles.kontrakAtas}>
                          <Text style={styles.kontrakNomor}>{k.nomorTransaksi}</Text>
                          <Badge label={badge.label} nada={badge.nada} />
                        </View>
                        <Text style={styles.kontrakNominal}>{formatRupiah(k.nominal)}</Text>
                        <View style={styles.kontrakMeta}>
                          <Text style={styles.kontrakDetail}>
                            {k.tenorBulan} bulan · {k.sukuBungaPerTahun > 0 ? `${k.sukuBungaPerTahun}% p.a.` : 'tanpa bunga'}
                          </Text>
                          <Text style={styles.kontrakDetail}>Jatuh tempo {tanggalRingkas(k.tanggalJatuhTempo)}</Text>
                        </View>
                        <Text style={[styles.kontrakKeterangan, badge.nada === 'WARN' && { color: colors.warning }]}>
                          {badge.keterangan}
                        </Text>
                        {selectable ? (
                          <Ionicons
                            name={dipilih ? 'radio-button-on' : 'radio-button-off'}
                            size={20}
                            color={dipilih ? ikonAksen : colors.textFaint}
                            style={styles.kontrakRadio}
                          />
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {/* Jenis transaksi ditentukan SISTEM dari status kontrak. */}
              {kontrakDipilih && jenisBerjangka !== 'SELESAI' ? (
                <View style={[styles.jenisOtomatis, jenisBerjangka === 'PENARIKAN_DINI' ? styles.nadaWarn : styles.nadaOk]}>
                  <Ionicons
                    name={jenisBerjangka === 'PENARIKAN_DINI' ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                    size={18}
                    color={jenisBerjangka === 'PENARIKAN_DINI' ? colors.warning : colors.success}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jenisOtomatisLabel}>Jenis transaksi (otomatis)</Text>
                    <Text style={styles.jenisOtomatisNilai}>
                      {jenisBerjangka === 'PENARIKAN_DINI' ? 'Penarikan Dini — sebelum jatuh tempo' : 'Pencairan Jatuh Tempo'}
                    </Text>
                  </View>
                </View>
              ) : null}

              {/* §AH/RC-S47 §I — kebijakan belum aktif: badge, judul & alasan
                  dari `tentukanAksiPencairanDini()` (sama dengan layar detail);
                  pesan panjang APA ADANYA dari evaluator domain. */}
              {modeDini && statusKebijakanDini && statusKebijakanDini.status !== 'AKTIF' && (
                <View style={[styles.panel, styles.panelTertahan]}>
                  <View style={styles.badgeRow}>
                    <View style={styles.badgeTertahan}>
                      <Text style={styles.badgeTextTertahan}>{aksiDini.badge}</Text>
                    </View>
                    <Text style={styles.badgeJudul}>{aksiDini.judul}</Text>
                  </View>
                  <Text style={styles.badgeRingkas}>{aksiDini.ringkasAlasan}</Text>
                  <Text style={styles.warnText}>{statusKebijakanDini.pesan}</Text>
                  {bolehBukaKebijakan ? (
                    <TouchableOpacity
                      style={styles.tombolKebijakan}
                      accessibilityRole="button"
                      onPress={() => navigation.navigate('KebijakanPenarikanDini')}
                    >
                      <Ionicons name="document-text-outline" size={16} color={ikonAksen} />
                      <Text style={styles.tombolKebijakanText}>Tetapkan Kebijakan Penarikan Dini</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.hint}>Hubungi pengurus yang berwenang untuk menetapkan kebijakan penarikan dini.</Text>
                  )}
                </View>
              )}

              {/* §AH — rincian penarikan dini. Seluruh angka dari
                  previewDini.settlement; layar tidak menghitung ulang apa pun. */}
              {modeDini && previewDini && (
                <View style={styles.panel}>
                  <Text style={styles.panelJudul}>Rincian Penarikan Dini (dihitung otomatis)</Text>
                  <BarisInfo label="Jatuh tempo" nilai={tanggalRingkas(previewDini.tanggalJatuhTempo)} />
                  <BarisInfo label="Tanggal pencairan" nilai={tanggalRingkas(previewDini.tanggalPencairan)} />
                  {previewDini.settlement && (
                    <>
                      <BarisInfo label="Versi kebijakan" nilai={previewDini.settlement.policyVersi} />
                      <View style={styles.pemisah} />
                      <DaftarBarisKonfirmasi baris={ringkasanKonfirmasiDini(previewDini.settlement)} />
                    </>
                  )}

                  {previewDini.alasanTidakBoleh && (
                    <View style={styles.warnRow}>
                      <Ionicons name="alert-circle" size={14} color={colors.danger} />
                      <Text style={[styles.warnText, { flex: 1 }]}>{previewDini.alasanTidakBoleh}</Text>
                    </View>
                  )}

                  {!previewDini.alasanTidakBoleh && previewDini.settlement && (
                    <>
                      <Text style={[styles.label, { marginTop: spacing.md }]}>Alasan Penarikan Dini</Text>
                      <FocusTextInput
                        style={styles.inputMultiline}
                        value={alasanDini}
                        onChangeText={setAlasanDini}
                        multiline
                        placeholder="Dicatat pada jejak audit pencairan dini"
                        placeholderTextColor={colors.placeholder}
                      />
                      <TouchableOpacity
                        style={[styles.konfirmasiRow, konfirmasiDini && styles.konfirmasiRowAktif]}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: konfirmasiDini }}
                        onPress={() => setKonfirmasiDini((v) => !v)}
                      >
                        <Ionicons
                          name={konfirmasiDini ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={konfirmasiDini ? ikonAksen : colors.textMuted}
                        />
                        <Text style={styles.konfirmasiText}>
                          Saya mengerti kontrak ini BELUM jatuh tempo dan menyetujui potongan di atas.
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}

              {!modeDini && ringkasanCair && (
                <View style={styles.panel}>
                  <Text style={styles.panelJudul}>Rincian Pencairan Jatuh Tempo</Text>
                  <BarisInfo label="Tanggal mulai" nilai={tanggalRingkas(ringkasanCair.tanggalMulai)} />
                  <BarisInfo label="Jatuh tempo" nilai={tanggalRingkas(ringkasanCair.tanggalJatuhTempo)} />
                  <BarisInfo label="Total bunga kontrak" nilai={formatRupiah(ringkasanCair.totalBungaKontrak)} />
                  <View style={styles.pemisah} />
                  <DaftarBarisKonfirmasi baris={ringkasanKonfirmasiJatuhTempo(ringkasanCair)} />
                  {/* RC-S128 — pokok saja: jelaskan ke mana bunga pergi. */}
                  {ringkasanCair.pencairanPokokSaja ? (
                    <View style={[styles.jenisOtomatis, styles.nadaOk, { marginTop: spacing.sm }]}>
                      <Ionicons name="information-circle-outline" size={18} color={colors.success} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.jenisOtomatisNilai}>Yang dicairkan dari rekening berjangka hanya POKOK.</Text>
                        <Text style={styles.hint}>
                          Bunga yang sudah menjadi hak anggota dikreditkan ke Simpanan Sukarela (setelah PPh), jadi tidak dibayar lagi di sini.
                        </Text>
                        {ringkasanBungaKeSukarela(ringkasanCair).map((b) => (
                          <BarisInfo key={b.label} label={b.label} nilai={formatRupiah(Number(b.nilai))} />
                        ))}
                        <BarisInfo
                          label="Perhitungan bunga terakhir"
                          nilai={ringkasanCair.tanggalPerhitunganTerakhir ? tanggalRingkas(ringkasanCair.tanggalPerhitunganTerakhir) : '-'}
                        />
                      </View>
                    </View>
                  ) : null}
                  {ringkasanCair.alasanTidakBolehCair && (
                    <View style={styles.warnRow}>
                      <Ionicons name="alert-circle" size={14} color={colors.danger} />
                      <Text style={[styles.warnText, { flex: 1 }]}>{ringkasanCair.alasanTidakBolehCair}</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
          )}

          {/* ---------------- DETAIL TRANSAKSI ---------------- */}
          <View style={styles.card}>
            <JudulLangkah nomor={jenis === 'BERJANGKA' && anggota ? 4 : 3} judul="Detail Transaksi" />
            <Text style={styles.label}>Tanggal *</Text>
            <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

            {jenis === 'SUKARELA' && (
              <>
                <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
                <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />
                {saldoTidakCukup && !errors.nominal && (
                  <View style={styles.warnRow}>
                    <Ionicons name="alert-circle" size={14} color={colors.danger} />
                    <Text style={styles.warnText}>Nominal melebihi saldo sukarela yang tersedia.</Text>
                  </View>
                )}
              </>
            )}

            <Text style={[styles.label, { marginTop: spacing.md }]}>Sumber Dana</Text>
            <View style={styles.segmen}>
              {(['KAS', 'BANK'] as const).map((sd) => (
                <TouchableOpacity
                  key={sd}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: sumberDana === sd }}
                  style={[styles.segmenItem, sumberDana === sd && styles.segmenItemAktif]}
                  onPress={() => {
                    setSumberDana(sd);
                    if (sd === 'KAS') setBankRekening(null);
                  }}
                >
                  <Ionicons
                    name={sd === 'KAS' ? 'cash-outline' : 'business-outline'}
                    size={16}
                    color={sumberDana === sd ? colors.white : colors.textMuted}
                  />
                  <Text style={[styles.segmenText, sumberDana === sd && styles.segmenTextAktif]}>
                    {sd === 'KAS' ? 'Kas' : 'Bank'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {sumberDana === 'BANK' && (
              <RekeningPicker label="Bank" value={bankRekening} onChange={setBankRekening} hanyaBank />
            )}
            {sumberDana === 'BANK' && errors.bankRekening && <Text style={styles.errorText}>{errors.bankRekening}</Text>}

            <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
            <FocusTextInput
              style={styles.inputMultiline}
              value={keterangan}
              onChangeText={setKeterangan}
              multiline
              placeholder="Opsional"
              placeholderTextColor={colors.placeholder}
            />
          </View>

          <TouchableOpacity
            style={[styles.submitButton, tombolNonaktif && styles.disabled]}
            onPress={bukaKonfirmasi}
            disabled={
              submitting ||
              (jenis === 'BERJANGKA' &&
                (modeDini ? !bolehSubmitDini : !ringkasanCair || !!ringkasanCair.alasanTidakBolehCair))
            }
            accessibilityRole="button"
          >
            {submitting ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Text style={styles.submitText}>{labelTombol}</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.white} />
              </>
            )}
          </TouchableOpacity>
          {jenis === 'BERJANGKA' && modeDini && previewDini?.settlement && !konfirmasiDini ? (
            <Text style={styles.hintTengah}>Centang persetujuan potongan di atas untuk melanjutkan.</Text>
          ) : null}
          </>
          )}
        </ScrollView>

        {/* ---------------- LEMBAR KONFIRMASI ---------------- */}
        <Modal visible={lembarKonfirmasi} transparent animationType="slide" onRequestClose={() => setLembarKonfirmasi(false)}>
          <View style={styles.overlay}>
            <SafeAreaView edges={['bottom']} style={styles.lembar}>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
                <View style={styles.lembarPegangan} />
                <Text style={styles.lembarJudul}>
                  {jenis === 'BERJANGKA'
                    ? modeDini
                      ? 'Konfirmasi Penarikan Dini'
                      : 'Konfirmasi Pencairan Jatuh Tempo'
                    : 'Konfirmasi Penarikan Simpanan Sukarela'}
                </Text>
                <Text style={styles.lembarSub}>Periksa kembali sebelum transaksi disimpan dan dijurnal.</Text>

                <View style={styles.lembarInfo}>
                  <BarisInfo label="Anggota" nilai={anggota?.namaLengkap ?? '-'} />
                  {jenis === 'BERJANGKA' && kontrakDipilih ? <BarisInfo label="Kontrak" nilai={kontrakDipilih.nomorTransaksi} /> : null}
                  <BarisInfo label="Tanggal" nilai={tanggalRingkas(tanggal)} />
                  <BarisInfo
                    label="Dibayar dari"
                    nilai={sumberDana === 'BANK' ? bankRekening?.nama ?? 'Bank' : 'Kas'}
                  />
                </View>

                <DaftarBarisKonfirmasi baris={barisKonfirmasi} besar />

                {jenis === 'BERJANGKA' && modeDini && previewDini?.settlement ? (
                  <Text style={styles.hint}>
                    Terdiri atas pokok {formatRupiah(alokasiPembayaranDini(previewDini.settlement).pokok)} dan bunga{' '}
                    {formatRupiah(alokasiPembayaranDini(previewDini.settlement).bunga)}. Kebijakan versi{' '}
                    {previewDini.settlement.policyVersi}.
                  </Text>
                ) : null}
                {jenis === 'BERJANGKA' && !modeDini ? (
                  <Text style={styles.hint}>Pencairan jatuh tempo tidak dikenai penalti, bunga hangus, maupun biaya administrasi.</Text>
                ) : null}
                {jenis === 'SUKARELA' && saldoSukarela !== null ? (
                  <Text style={styles.hint}>Saldo simpanan sukarela saat ini {formatRupiah(saldoSukarela)}.</Text>
                ) : null}

                <View style={styles.lembarTombol}>
                  <TouchableOpacity style={styles.tombolBatal} onPress={() => setLembarKonfirmasi(false)} accessibilityRole="button">
                    <Text style={styles.tombolBatalText}>Batal</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.tombolKonfirmasi} onPress={jalankanKonfirmasi} accessibilityRole="button">
                    <Ionicons name="checkmark-circle-outline" size={18} color={colors.white} />
                    <Text style={styles.submitText}>Konfirmasi &amp; Simpan</Text>
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

function JudulLangkah({ nomor, judul }: { nomor: number; judul: string }) {
  return (
    <View style={styles.langkahHeader}>
      <View style={styles.langkahNomor}>
        <Text style={styles.langkahNomorText}>{nomor}</Text>
      </View>
      <Text style={styles.langkahJudul}>{judul}</Text>
    </View>
  );
}

function JenisCard({
  label,
  keterangan,
  ikon,
  warnaIkon,
  active,
  onPress,
}: {
  label: string;
  keterangan: string;
  ikon: keyof typeof Ionicons.glyphMap;
  warnaIkon: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.jenisCard, active && styles.jenisCardAktif]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
    >
      <Ionicons name={ikon} size={22} color={warnaIkon} />
      <Text style={[styles.jenisLabel, active && styles.jenisLabelAktif]}>{label}</Text>
      <Text style={styles.jenisSub}>{keterangan}</Text>
      {active ? <Ionicons name="checkmark-circle" size={18} color={warnaIkon} style={styles.jenisCek} /> : null}
    </TouchableOpacity>
  );
}

function Badge({ label, nada }: { label: string; nada: NadaBadge }) {
  const gaya =
    nada === 'OK'
      ? { bg: colors.primaryLight, fg: colors.success }
      : nada === 'WARN'
        ? { bg: colors.warningBg, fg: colors.warning }
        : { bg: colors.background, fg: colors.textMuted };
  return (
    <View style={[styles.badge, { backgroundColor: gaya.bg }]}>
      <Text style={[styles.badgeText, { color: gaya.fg }]}>{label}</Text>
    </View>
  );
}

function BarisInfo({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoRowLabel}>{label}</Text>
      <Text style={styles.infoRowNilai}>{nilai}</Text>
    </View>
  );
}

function DaftarBarisKonfirmasi({ baris, besar }: { baris: BarisKonfirmasi[]; besar?: boolean }) {
  return (
    <View>
      {baris.map((b) =>
        b.jenis === 'TOTAL' ? (
          <View key={b.label} style={[styles.totalRow, besar && styles.totalRowBesar]}>
            <Text style={styles.totalLabel}>{b.label}</Text>
            <Text style={[styles.totalNilai, besar && styles.totalNilaiBesar]}>{formatRupiah(b.nilai)}</Text>
          </View>
        ) : (
          <View key={b.label} style={styles.rincianRow}>
            <Text style={styles.rincianLabel}>{b.label}</Text>
            <Text style={[styles.rincianNilai, b.jenis === 'KURANG' && b.nilai !== 0 && { color: colors.danger }]}>
              {b.jenis === 'KURANG' ? '− ' : ''}
              {formatRupiah(b.nilai)}
            </Text>
          </View>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  infoBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  langkahHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  langkahNomor: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
  langkahNomorText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  langkahJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  jenisRow: { flexDirection: 'row', gap: spacing.sm },
  jenisCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    gap: 4,
  },
  jenisCardAktif: { borderColor: colors.text, borderWidth: 1.5, backgroundColor: colors.background },
  jenisLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 4 },
  jenisLabelAktif: { color: colors.text },
  jenisSub: { fontSize: 11, color: colors.textMuted },
  jenisCek: { position: 'absolute', top: spacing.sm, right: spacing.sm },
  jenisKeterangan: { fontSize: 12, color: colors.textMuted, lineHeight: 18, marginTop: spacing.md },
  linkKebijakan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  linkKebijakanText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text },
  linkKebijakanStatus: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  saldoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  saldoLabel: { fontSize: 11, color: colors.textMuted },
  saldoText: { fontSize: 13, color: colors.text },
  saldoNominal: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 1 },
  kosongBox: { alignItems: 'center', paddingVertical: spacing.lg, gap: 4 },
  kosongJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  kosongText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },
  kontrakCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    paddingRight: spacing.xl + spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  kontrakCardAktif: { borderColor: colors.text, borderWidth: 1.5, backgroundColor: colors.background },
  kontrakCardNonaktif: { opacity: 0.55 },
  kontrakAtas: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  kontrakNomor: { fontSize: 12, fontWeight: '700', color: colors.textMuted, flexShrink: 1 },
  kontrakNominal: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 4 },
  kontrakMeta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, marginTop: 2 },
  kontrakDetail: { fontSize: 12, color: colors.textMuted },
  kontrakKeterangan: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginTop: 4 },
  kontrakRadio: { position: 'absolute', right: spacing.md, top: '50%', marginTop: -10 },
  badge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 10.5, fontWeight: '700' },
  jenisOtomatis: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  nadaOk: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  nadaWarn: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  jenisOtomatisLabel: { fontSize: 11, color: colors.textMuted },
  jenisOtomatisNilai: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 1 },
  panel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.surface,
  },
  panelTertahan: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBg },
  panelJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  badgeTertahan: { backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTextTertahan: { fontSize: 10, fontWeight: '700', color: colors.danger },
  badgeJudul: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  badgeRingkas: { fontSize: 12, color: colors.text, lineHeight: 17, marginBottom: spacing.sm },
  tombolKebijakan: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tombolKebijakanText: { fontSize: 13, fontWeight: '700', color: colors.text },
  pemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 },
  infoRowLabel: { fontSize: 12, color: colors.textMuted },
  infoRowNilai: { fontSize: 12, fontWeight: '600', color: colors.text, flexShrink: 1, textAlign: 'right' },
  rincianRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  rincianLabel: { fontSize: 13, color: colors.text, flex: 1 },
  rincianNilai: { fontSize: 13, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.text,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  totalRowBesar: { backgroundColor: colors.background, borderRadius: radius.sm, borderTopWidth: 0, padding: spacing.md },
  totalLabel: { fontSize: 13, fontWeight: '700', color: colors.text, flex: 1 },
  totalNilai: { fontSize: 16, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  totalNilaiBesar: { fontSize: 20 },
  konfirmasiRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  konfirmasiRowAktif: { borderColor: colors.text, backgroundColor: colors.background },
  konfirmasiText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  label: { fontSize: 12, color: colors.text, fontWeight: '600', marginBottom: spacing.xs },
  hint: { fontSize: 11.5, color: colors.textMuted, lineHeight: 17, marginTop: spacing.sm },
  hintTengah: { fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline, marginBottom: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: spacing.sm },
  warnText: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  segmen: { flexDirection: 'row', gap: spacing.sm },
  segmenItem: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmenItemAktif: { backgroundColor: colors.text, borderColor: colors.text },
  segmenText: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  segmenTextAktif: { color: colors.white },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.danger,
    borderRadius: radius.sm,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  lembar: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.md * 2,
    borderTopRightRadius: radius.md * 2,
    maxHeight: '90%',
  },
  lembarPegangan: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  lembarJudul: { fontSize: 17, fontWeight: '700', color: colors.text },
  lembarSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  lembarInfo: {
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
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
    backgroundColor: colors.danger,
  },
});
