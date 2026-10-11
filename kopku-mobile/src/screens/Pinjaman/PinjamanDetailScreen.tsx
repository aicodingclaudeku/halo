import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Modal, Pressable } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { notify } from '@/store/useNotifyStore';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getPinjamanDetail,
  getJadwalAngsuran,
  cairkanPinjaman,
  editPencairanPinjaman,
  hapusPencairanPinjaman,
  batalkanPinjaman,
  bayarAngsuran,
  akadUlangPinjaman,
  getRiwayatAkadUlang,
  getOutstandingPiutangJasa,
  kelompokkanJadwalAngsuran,
  JadwalAngsuranItem,
  RiwayatAkadUlangItem,
} from '@/services/PinjamanService';
import { MetodeJasa, SatuanTenor } from '@/accounting/PinjamanCalculator';
import DatePicker from '@/components/DatePicker';
import RekeningPicker from '@/components/RekeningPicker';
import { RekeningItem } from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildAngsuranExport, BagianAngsuranExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import DokumenAkadExportButton from '@/components/DokumenAkadExportButton';
import PenyelesaianPinjamanCard from '@/components/pinjaman/PenyelesaianPinjamanCard';
import { getSusunanPengurusInti, LABEL_JABATAN_PENGURUS } from '@/services/KoperasiMasterService';
import { jabatanIntiKosong, type JabatanPengurusInti } from '@/services/PengurusInti';
import { calculateMaturityDate } from '@/accounting/InstallmentDate';
import {
  DraftAkadUlang,
  PeriodeRelatif,
  formatPersenJasa,
  formatTanggalPanjang,
  formatTenor,
  hitungPeriodeRelatifAkadUlang,
  jadwalMilikAkadAwal,
  jadwalMilikAkadUlang,
  jatuhTempoAkhir,
  statusDokumenAkadAwal,
  buatNomorDokumenAkadAwal,
  tentukanStatusJadwalKontrak,
  labelMetodeJasa,
  labelSatuanTenor,
  labelStatusEventAkadUlang,
  nomorUrutEventAkadUlang,
  preflightAkadUlang,
  ringkasPosisiAkadUlang,
  tentukanStatusEventAkadUlang,
  validasiFormAkadUlang,
} from '@/services/AkadUlangPresentasi';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S82 — jatuh tempo akhir akad baru untuk PREVIEW, memakai fungsi
 * yang SAMA PERSIS dengan yang dipakai `akadUlangPinjaman()` untuk
 * menulis `pinjaman.tanggal_jatuh_tempo` (tidak ada algoritma kedua).
 */
function jatuhTempoBaruPreview(draft: DraftAkadUlang): string | null {
  try {
    return calculateMaturityDate(draft.tanggal, draft.tenor, draft.satuanTenor);
  } catch {
    return null;
  }
}

/** Label nomor angsuran: relatif untuk jadwal hasil akad ulang, nomor internal tetap ditampilkan untuk jejak audit. */
function labelNomorAngsuran(item: JadwalAngsuranItem, rel: PeriodeRelatif | undefined): { utama: string; internal: string | null } {
  if (item.dibuatDariAkadUlangId && rel) {
    return { utama: `Periode ${rel.periode} dari ${rel.jumlah}`, internal: `No. jadwal internal ${item.nomorAngsuran}` };
  }
  return { utama: `Angsuran ke-${item.nomorAngsuran}`, internal: null };
}

const STATUS_ANGSURAN_COLOR: Record<string, string> = {
  BELUM_BAYAR: colors.textMuted,
  SEBAGIAN: colors.warning,
  LUNAS: colors.primary,
  TERLAMBAT: colors.danger,
};

/**
 * Detail pinjaman + jadwal angsuran + aksi cairkan/bayar (PRD §12-13).
 *
 * Update pasca-Phase 18 §8 (permintaan pengguna): pencairan sekarang
 * memilih sumber dana/rekening lewat `RekeningPicker` existing
 * (sebelumnya hardcode 'KAS' — tidak bisa cair dari Bank sama sekali).
 * Setelah cair (status AKTIF) & SELAMA belum ada satu pun angsuran
 * dibayarkan, tombol "Edit Pencairan" (ganti sumber dana yang salah
 * dipilih, ID transaksi/nomor pinjaman tidak berubah) dan "Batalkan
 * Pencairan" (reversal, kembali ke status DISETUJUI, siap dicairkan
 * ulang) tersedia. Begitu ada angsuran, keduanya otomatis hilang
 * (server juga menolak kalau entah bagaimana dipaksa lewat state).
 */
export default function PinjamanDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { pinjamanId } = route.params ?? {};

  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getPinjamanDetail>>>(null);
  const [jadwal, setJadwal] = useState<JadwalAngsuranItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [payModal, setPayModal] = useState<JadwalAngsuranItem | null>(null);
  const [payNominal, setPayNominal] = useState('');
  const [processing, setProcessing] = useState(false);

  const [cairkanModalOpen, setCairkanModalOpen] = useState(false);
  // Konfirmasi tanda tangan akad SEBELUM form pencairan dibuka. Hanya
  // gerbang UI: pencairan tetap memakai cairkanPinjaman() yang sama.
  const [konfirmasiAkadOpen, setKonfirmasiAkadOpen] = useState(false);
  const [akadDitandatangani, setAkadDitandatangani] = useState(false);
  const [cairkanMode, setCairkanMode] = useState<'BARU' | 'EDIT'>('BARU');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [alasanEdit, setAlasanEdit] = useState('');
  const [batalkanModalOpen, setBatalkanModalOpen] = useState(false);
  const [alasanBatal, setAlasanBatal] = useState('');

  // Bug fix (BUG 1): "Batalkan Pinjaman" untuk loan yang BELUM
  // dicairkan sama sekali (DIAJUKAN/DISETUJUI) — state TERPISAH dari
  // batalkanModalOpen/alasanBatal di atas, yang khusus untuk "Batalkan
  // Pencairan" (reversal jurnal, hanya relevan setelah AKTIF). Dua flow
  // ini TIDAK BOLEH berbagi modal/state karena memanggil service yang
  // berbeda (batalkanPinjaman vs hapusPencairanPinjaman) dengan efek
  // yang berbeda pula.
  const [batalkanPinjamanModalOpen, setBatalkanPinjamanModalOpen] = useState(false);
  const [alasanBatalPinjaman, setAlasanBatalPinjaman] = useState('');

  // Target §9 (permintaan pengguna): "Fungsi Akad Ulang".
  const [akadModalOpen, setAkadModalOpen] = useState(false);
  const [akadKonfirmasiOpen, setAkadKonfirmasiOpen] = useState(false);
  const [akadTanggal, setAkadTanggal] = useState(getTanggalLokalHariIni());
  const [akadTenor, setAkadTenor] = useState('');
  const [akadSatuanTenor, setAkadSatuanTenor] = useState<SatuanTenor>('BULAN');
  const [akadMetodeJasa, setAkadMetodeJasa] = useState<MetodeJasa>('FLAT');
  const [akadPersentaseJasa, setAkadPersentaseJasa] = useState('');
  const [akadKeterangan, setAkadKeterangan] = useState('');
  const [akadError, setAkadError] = useState<string | null>(null);
  // RC-S82 §C/§D: draft TERVALIDASI yang dibekukan saat menekan
  // "Simpan Akad Ulang". Konfirmasi menampilkan nilai ini, dan HANYA
  // nilai ini yang dikirim ke akadUlangPinjaman() — preview, konfirmasi,
  // dan payload mustahil berbeda.
  const [akadDraft, setAkadDraft] = useState<DraftAkadUlang | null>(null);
  // PHASE 4 §H (permintaan pengguna): info live yang ditampilkan saat
  // membuka Akad Ulang — outstanding pokok dihitung dari `jadwal` yang
  // sudah dimuat, Piutang Jasa lewat getOutstandingPiutangJasa
  // (fungsi Phase 2 yang sama, TIDAK ada rumus kedua).
  const [akadOutstandingJasa, setAkadOutstandingJasa] = useState<number | null>(null);
  const [riwayatAkad, setRiwayatAkad] = useState<RiwayatAkadUlangItem[]>([]);
  const [riwayatAkadOpen, setRiwayatAkadOpen] = useState(false);

  const [notFound, setNotFound] = useState(false);

  /**
   * REQUIREMENT 6 (permintaan pengguna) — pisahkan jadwal angsuran
   * menjadi tiga kelompok yang JELAS TERPISAH. Pengelompokan dilakukan
   * lewat `kelompokkanJadwalAngsuran()` di PinjamanService (data aktual:
   * status + kolom traceability akad ulang), BUKAN tebakan di layar ini,
   * dan fungsi yang SAMA dipakai untuk menentukan isi export sehingga
   * layar & file hasil export mustahil berbeda.
   */
  const kelompokJadwal = useMemo(() => {
    const aktif: JadwalAngsuranItem[] = [];
    const akadUlang: JadwalAngsuranItem[] = [];
    const restrukturisasi: JadwalAngsuranItem[] = [];
    const dihapusbuku: JadwalAngsuranItem[] = [];
    for (const item of jadwal) {
      switch (kelompokkanJadwalAngsuran(item)) {
        case 'AKTIF':
          aktif.push(item);
          break;
        case 'AKAD_ULANG':
          akadUlang.push(item);
          break;
        case 'RESTRUKTURISASI':
          restrukturisasi.push(item);
          break;
        default:
          dihapusbuku.push(item);
      }
    }
    return { aktif, akadUlang, restrukturisasi, dihapusbuku };
  }, [jadwal]);

  /**
   * RC-S82 §A — ringkasan Akad Ulang dari SEMUA jadwal CURRENT
   * (BELUM_BAYAR/SEBAGIAN/TERLAMBAT) lewat `isCurrentRepaymentSchedule()`.
   * Sebelumnya daftar status diketik ulang di sini tanpa TERLAMBAT.
   */
  const ringkasanAkad = useMemo(() => ringkasPosisiAkadUlang(jadwal), [jadwal]);

  /** RC-S82 §G — nomor periode relatif untuk jadwal hasil akad ulang (nomor internal DB tidak diubah). */
  const periodeRelatif = useMemo(() => hitungPeriodeRelatifAkadUlang(jadwal), [jadwal]);

  const load = useCallback(async () => {
    if (!pinjamanId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [d, j] = await Promise.all([getPinjamanDetail(pinjamanId), getJadwalAngsuran(pinjamanId)]);
      setDetail(d);
      setJadwal(j);
      if (!d) setNotFound(true);
    } catch (e) {
      // Bug fix: sebelumnya error apa pun di sini tidak ditangani —
      // layar diam di spinner selamanya. Sekarang pesan jelas.
      setNotFound(true);
      notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat detail pinjaman.');
    } finally {
      setLoading(false);
    }
  }, [pinjamanId]);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Diganti (bukan
  // ditambahi) dengan refresh berbasis FOKUS supaya layar selalu
  // membaca state SQLite terkini. Tidak ada timer, tidak ada remount paksa.
  useFocusRefresh(() => {
    load();
  }, [load]);

  // §8: pencairan hanya aman diedit/dihapus SELAMA belum ada angsuran
  // yang dibayarkan sama sekali — proxy client-side dari jadwal (server
  // mengecek ulang lewat tabel angsuran_pembayaran, ini murni untuk
  // menampilkan/menyembunyikan tombol).
  // PHASE 4 §G (permintaan pengguna): `belumAdaPembayaran` yang dulu
  // dipakai untuk menampilkan Edit/Batalkan Pencairan bersyarat sudah
  // TIDAK dipakai lagi — tombol tersebut sekarang disembunyikan total
  // begitu status AKTIF, tanpa pengecualian (lihat render di bawah).

  /** Tombol "Cairkan Pinjaman": konfirmasi tanda tangan akad dulu. */
  const bukaCairkanBaru = () => {
    setAkadDitandatangani(false);
    setKonfirmasiAkadOpen(true);
  };

  /** Dipanggil setelah pengguna menyatakan akad sudah ditandatangani. */
  const lanjutCairkanSetelahAkad = () => {
    if (!akadDitandatangani) return;
    setKonfirmasiAkadOpen(false);
    setCairkanMode('BARU');
    setRekening(null);
    setAlasanEdit('');
    setCairkanModalOpen(true);
  };

  const bukaEditPencairan = () => {
    setCairkanMode('EDIT');
    setRekening(null);
    setAlasanEdit('');
    setCairkanModalOpen(true);
  };

  const submitCairkan = async () => {
    if (!currentUser || !rekening) return;
    setProcessing(true);
    try {
      if (cairkanMode === 'BARU') {
        await cairkanPinjaman({
          pinjamanId,
          sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
          bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          approvedBy: currentUser.id,
        });
        notify('Berhasil', 'Pinjaman berhasil dicairkan.');
      } else {
        if (!alasanEdit.trim()) {
          notify('Gagal', 'Alasan koreksi wajib diisi.');
          setProcessing(false);
          return;
        }
        await editPencairanPinjaman({
          pinjamanId,
          sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
          bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          alasan: alasanEdit.trim(),
          actingUserId: currentUser.id,
        });
        notify('Berhasil', 'Sumber dana pencairan berhasil dikoreksi.');
      }
      setCairkanModalOpen(false);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  const submitBatalkan = async () => {
    if (!currentUser || !alasanBatal.trim()) return;
    setProcessing(true);
    try {
      await hapusPencairanPinjaman({ pinjamanId, alasan: alasanBatal.trim(), actingUserId: currentUser.id });
      setBatalkanModalOpen(false);
      setAlasanBatal('');
      await load();
      notify('Berhasil', 'Pencairan dibatalkan — pinjaman kembali berstatus Disetujui.');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  // Bug fix (BUG 1): "Batalkan Pinjaman" — untuk loan yang belum cair
  // sama sekali. Memanggil batalkanPinjaman() (set status DITOLAK,
  // TIDAK pernah menyentuh jurnal/piutang/EIR karena semua itu memang
  // belum ada sebelum pencairan).
  const submitBatalkanPinjaman = async () => {
    if (!currentUser || !alasanBatalPinjaman.trim()) return;
    setProcessing(true);
    try {
      await batalkanPinjaman({ pinjamanId, alasan: alasanBatalPinjaman.trim(), actingUserId: currentUser.id });
      setBatalkanPinjamanModalOpen(false);
      setAlasanBatalPinjaman('');
      await load();
      notify('Berhasil', 'Pinjaman dibatalkan.');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  /**
   * RC-S82 (lanjutan) — ringkasan AKAD AWAL untuk kartu Akad & Dokumen.
   * Syarat asli = nilai `*_lama` event akad ulang PERTAMA bila pernah
   * diakadulangkan (baris pinjaman sudah memuat syarat terbaru); status
   * dari jadwal akad asli (dibuat_dari_akad_ulang_id kosong).
   */
  const akadAwal = useMemo(() => {
    if (!detail) return null;
    const pertama = [...riwayatAkad].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0];
    const jadwalAwal = jadwalMilikAkadAwal(jadwal);
    const sifat = statusDokumenAkadAwal(detail.status);
    const status = tentukanStatusJadwalKontrak(jadwalAwal);
    return {
      sifat,
      tenor: formatTenor(pertama ? pertama.tenorLama : detail.tenor, pertama ? pertama.satuanTenorLama : detail.satuanTenor),
      jasa: `${labelMetodeJasa(pertama ? pertama.metodeJasaLama : detail.metodeJasa)} ${formatPersenJasa(pertama ? pertama.persentaseJasaLama : detail.persentaseJasa)}`,
      statusLabel: sifat === 'BELUM_DICAIRKAN' ? 'SIAP DITANDATANGANI' : status === 'DIGANTIKAN' ? 'DIGANTIKAN' : status === 'BERLAKU' ? 'BERLAKU' : labelStatusEventAkadUlang(status),
      berlaku: sifat === 'FINAL' && status === 'BERLAKU',
    };
  }, [detail, jadwal, riwayatAkad]);

  /**
   * RC-S82 — jabatan pengurus inti yang KOSONG pada tanggal akad. Perjanjian
   * ditandatangani Ketua (diketahui Sekretaris & Bendahara); nama yang
   * kosong dicetak sebagai garis titik-titik — pengguna diberi tahu
   * sebelum mencetak. Hanya BACA; gagal memuat tidak memblokir export.
   */
  const [pengurusKosong, setPengurusKosong] = useState<JabatanPengurusInti[]>([]);
  useEffect(() => {
    if (!detail?.tanggal) return;
    let batal = false;
    getSusunanPengurusInti(detail.tanggal)
      .then((s) => {
        // Hanya Ketua yang dicetak di dokumen perjanjian.
        if (!batal) setPengurusKosong(jabatanIntiKosong(s).filter((j) => j === 'KETUA'));
      })
      .catch(() => {
        if (!batal) setPengurusKosong([]);
      });
    return () => {
      batal = true;
    };
  }, [detail?.tanggal]);

  /** RC-S82 §F/§J — nomor urut kronologis event (stabil; event tidak pernah dihapus). */
  const nomorUrutAkad = useMemo(() => nomorUrutEventAkadUlang(riwayatAkad), [riwayatAkad]);

  /** RC-S82 §C — preview langsung dari parser yang SAMA dengan validasi submit. */
  const akadValidasiLive = useMemo(
    () =>
      validasiFormAkadUlang({
        tanggal: akadTanggal,
        tenorText: akadTenor,
        satuanTenor: akadSatuanTenor,
        metodeJasa: akadMetodeJasa,
        persentaseText: akadPersentaseJasa,
        keterangan: akadKeterangan,
      }),
    [akadTanggal, akadTenor, akadSatuanTenor, akadMetodeJasa, akadPersentaseJasa, akadKeterangan]
  );

  const loadRiwayatAkad = useCallback(async () => {
    const r = await getRiwayatAkadUlang(pinjamanId);
    setRiwayatAkad(r);
  }, [pinjamanId]);

  useFocusRefresh(() => {
    loadRiwayatAkad();
  }, [loadRiwayatAkad]);

  const bukaAkadUlang = () => {
    // RC-S82 §B — preflight UX. TERLAMBAT TIDAK memblokir; yang
    // diblokir hanya kondisi yang juga ditolak service. Service tetap
    // otoritas terakhir (validasinya tidak diubah).
    const preflight = preflightAkadUlang(jadwal);
    if (!preflight.boleh) {
      notify(preflight.judul, preflight.pesan, undefined, 'warning');
      return;
    }
    setAkadDraft(null);
    setAkadTanggal(getTanggalLokalHariIni());
    setAkadTenor(detail ? String(detail.tenor) : '');
    setAkadSatuanTenor(detail ? detail.satuanTenor : 'BULAN');
    setAkadMetodeJasa(detail && detail.metodeJasa !== 'CUSTOM' ? detail.metodeJasa : 'FLAT');
    setAkadPersentaseJasa(detail ? String(detail.persentaseJasa) : '');
    setAkadKeterangan('');
    setAkadError(null);
    setAkadOutstandingJasa(null);
    getOutstandingPiutangJasa(pinjamanId).then(setAkadOutstandingJasa);
    setAkadModalOpen(true);
  };

  const validasiAkadLaluKonfirmasi = () => {
    // RC-S82 §E — parsing KETAT ('12abc' / '1.5abc' ditolak). Validasi
    // service tetap berjalan sebagai lapisan kedua.
    if (akadValidasiLive.ok === false) {
      setAkadError(akadValidasiLive.error);
      return;
    }
    setAkadError(null);
    setAkadDraft(akadValidasiLive.draft);
    // §9: "Tampilkan confirmation dialog. Jelaskan bahwa akad ulang
    // akan membuat/memperbarui akad pinjaman ... Jangan langsung
    // menjalankan aksi hanya karena tombol ditekan."
    setAkadKonfirmasiOpen(true);
  };

  const submitAkadUlang = async () => {
    if (!currentUser || !akadDraft) return;
    setProcessing(true);
    try {
      await akadUlangPinjaman({
        pinjamanId,
        tanggal: akadDraft.tanggal,
        tenorBaru: akadDraft.tenor,
        satuanTenorBaru: akadDraft.satuanTenor,
        metodeJasaBaru: akadDraft.metodeJasa,
        persentaseJasaBaru: akadDraft.persentaseJasa,
        keterangan: akadDraft.keterangan,
        actingUserId: currentUser.id,
      });
      setAkadDraft(null);
      setAkadKonfirmasiOpen(false);
      setAkadModalOpen(false);
      await load();
      await loadRiwayatAkad();
      notify('Berhasil', 'Akad ulang pinjaman berhasil disimpan — jadwal angsuran tersisa sudah disusun ulang.');
    } catch (e) {
      setAkadKonfirmasiOpen(false);
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  const openPay = (item: JadwalAngsuranItem) => {
    const sisa = item.total - item.pokokTerbayar - item.jasaTerbayar;
    setPayNominal(sisa.toString());
    setPayModal(item);
  };

  const submitPay = async () => {
    if (!payModal || !currentUser) return;
    const nominal = parseInt(payNominal, 10);
    if (isNaN(nominal) || nominal <= 0) {
      notify('Nominal tidak valid');
      return;
    }
    setProcessing(true);
    try {
      await bayarAngsuran({
        pinjamanId,
        jadwalId: payModal.id,
        tanggal: getTanggalLokalHariIni(),
        nominal,
        sumberDana: 'KAS',
        createdBy: currentUser.id,
      });
      setPayModal(null);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (notFound || !detail) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
        <Text style={styles.notFoundText}>Pinjaman tidak ditemukan. Data mungkin sudah dihapus atau ID tidak valid.</Text>
        <TouchableOpacity style={styles.notFoundButton} onPress={() => navigation.goBack()}>
          <Text style={styles.notFoundButtonText}>Kembali</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>{detail.nomorPinjaman}</Text>
        <Text style={styles.sub}>{detail.namaAnggota} ({detail.nomorAnggota})</Text>

        <View style={styles.card}>
          <Row label="Jumlah Pinjaman" value={formatRupiah(detail.jumlahPinjaman)} />
          <Row label="Tenor" value={`${detail.tenor} ${detail.satuanTenor.toLowerCase()}`} />
          <Row label="Metode Jasa" value={detail.metodeJasa} />
          <Row label="Persentase Jasa" value={`${detail.persentaseJasa}% / periode`} />
          <Row label="Status" value={detail.status} bold />
        </View>

        {/* RC-S133.6.4 (v82) — pencatatan manual penyelesaian ke Pengadilan Negeri / klaim asuransi (kriteria Macet angka 3). */}
        <PenyelesaianPinjamanCard
          pinjamanId={pinjamanId}
          statusPinjaman={detail.status}
          tanggalPinjaman={detail.tanggal}
          penyelesaian={detail.penyelesaian}
          onBerubah={load}
        />

        {detail.metodeJasa === 'CUSTOM' && (detail.status === 'DIAJUKAN' || detail.status === 'DISETUJUI') && (
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonSecondary]}
            onPress={() => navigation.navigate('PinjamanJadwalCustom', { pinjamanId })}
          >
            <Text style={styles.actionButtonSecondaryText}>
              {jadwal.length > 0 ? 'Ubah Jadwal Custom' : 'Susun Jadwal Custom'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Bug fix (BUG 1): loan yang belum dicairkan (DIAJUKAN/
            DISETUJUI) harus punya Edit Pinjaman, Batalkan Pinjaman, dan
            Cairkan Pinjaman — sebelumnya hanya Cairkan Pinjaman yang
            ada. Edit navigasi ke PinjamanFormScreen (mode edit, reuse
            form yang sama persis dengan pengajuan baru). Batalkan
            memakai modal + batalkanPinjaman() baru di bawah. */}
        {(detail.status === 'DIAJUKAN' || detail.status === 'DISETUJUI') && (
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonSecondary]}
            onPress={() => navigation.navigate('PinjamanForm', { pinjamanId })}
          >
            <Text style={styles.actionButtonSecondaryText}>Edit Pinjaman</Text>
          </TouchableOpacity>
        )}

        {(detail.status === 'DIAJUKAN' || detail.status === 'DISETUJUI') && (
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonDanger]}
            onPress={() => setBatalkanPinjamanModalOpen(true)}
          >
            <Text style={styles.actionButtonDangerText}>Batalkan Pinjaman</Text>
          </TouchableOpacity>
        )}

        {(detail.status === 'DIAJUKAN' || detail.status === 'DISETUJUI') && (
          <TouchableOpacity
            style={[styles.actionButton, detail.metodeJasa === 'CUSTOM' && jadwal.length === 0 && styles.disabled]}
            onPress={bukaCairkanBaru}
            disabled={processing || (detail.metodeJasa === 'CUSTOM' && jadwal.length === 0)}
          >
            <Text style={styles.actionButtonText}>
              {detail.metodeJasa === 'CUSTOM' && jadwal.length === 0
                ? 'Susun Jadwal Custom Dulu'
                : 'Cairkan Pinjaman'}
            </Text>
          </TouchableOpacity>
        )}

        {/* PHASE 4 §G (permintaan pengguna): Edit Pencairan/Batalkan
            Pencairan DIHILANGKAN total dari UI begitu pinjaman sudah
            dicairkan (status AKTIF) — TIDAK ADA pengecualian lagi
            walau belum ada angsuran (beda dari Fase 8 sebelumnya yang
            masih mengizinkan kalau belumAdaPembayaran). Backend
            (cekPencairanAmanDiubah) juga diperketat SELALU menolak
            begitu status AKTIF — kalau perlu koreksi, gunakan
            reversal/correction lewat Akuntansi > Koreksi Transaksi. */}

        {/* PHASE 4 §H (permintaan pengguna): label "Akad Ulang" (bukan
            "Fungsi Akad Ulang" seperti sebelumnya) — implementasi tetap
            memakai akadUlangPinjaman() dari Phase 3 (histori bertingkat,
            tidak pernah menghapus jadwal lama). */}
        {/* ============================================================
            RC-S82 (lanjutan) — KARTU "AKAD & DOKUMEN". Urutan tetap:
              A. AKAD AWAL  — ringkasan + "Export Dokumen Akad" (tersedia
                 TANPA akad ulang; sebelum dicairkan dokumen dicetak utuh
                 untuk ditandatangani)
              B. AKAD ULANG — aksi "Akad Ulang" → "Export Dokumen Akad
                 Ulang" tepat di bawahnya → riwayat (lipat/buka), tiap
                 kartu riwayat punya export dokumennya sendiri.
            ============================================================ */}
        {akadAwal && akadAwal.sifat !== 'TIDAK_TERSEDIA' && (
          <View style={styles.akadSection}>
            <View style={styles.akadSectionTitleWrap}>
              <Ionicons name="document-text-outline" size={18} color={colors.primary} />
              <Text style={styles.akadSectionTitle}>{'Akad & Dokumen'}</Text>
            </View>

            {/* A. AKAD AWAL */}
            <View style={styles.akadBlok}>
              <View style={styles.akadSectionHeader}>
                <Text style={styles.akadBlokJudul}>Akad Awal</Text>
                <View style={[styles.statusPill, akadAwal.berlaku ? styles.statusPillBerlaku : styles.statusPillHistoris]}>
                  <Text style={[styles.statusPillText, akadAwal.berlaku ? styles.statusPillTextBerlaku : styles.statusPillTextHistoris]}>
                    {akadAwal.statusLabel}
                  </Text>
                </View>
              </View>
              <Text style={styles.akadBlokMeta}>
                {formatTanggalPanjang(detail.tanggal)} · {akadAwal.tenor} · {akadAwal.jasa}
              </Text>
              <DokumenAkadExportButton pinjamanId={pinjamanId} dokumen={{ jenis: 'AWAL' }} label="Export Perjanjian Pinjaman" />
              {pengurusKosong.length > 0 && (
                <View style={styles.pengurusPeringatan}>
                  <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
                  <Text style={styles.pengurusPeringatanText}>
                    {pengurusKosong.map((j) => LABEL_JABATAN_PENGURUS[j]).join(', ')} belum ditetapkan pada tanggal akad — nama
                    penanda tangan koperasi akan dicetak kosong. Lengkapi di menu Data › Pengurus.
                  </Text>
                </View>
              )}
              <Text style={styles.akadExportHint}>
                {akadAwal.sifat === 'BELUM_DICAIRKAN'
                  ? 'Cetak perjanjian ini dan tandatangani bersama anggota (anggota di atas meterai) sebelum pinjaman dicairkan.'
                  : riwayatAkad.length > 0
                    ? 'Salinan akad awal untuk arsip — sudah digantikan akad ulang.'
                    : 'Akad yang berlaku saat ini.'}
              </Text>
            </View>

            {/* B. AKAD ULANG */}
            {(detail.status === 'AKTIF' || riwayatAkad.length > 0) && (
              <View style={[styles.akadBlok, styles.akadBlokPemisah]}>
                <View style={styles.akadSectionHeader}>
                  <Text style={styles.akadBlokJudul}>Akad Ulang</Text>
                  <View style={[styles.statusPill, riwayatAkad.length > 0 ? styles.statusPillBerlaku : styles.statusPillHistoris]}>
                    <Text style={[styles.statusPillText, riwayatAkad.length > 0 ? styles.statusPillTextBerlaku : styles.statusPillTextHistoris]}>
                      {riwayatAkad.length > 0 ? `${riwayatAkad.length}× akad ulang` : 'Belum pernah'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.akadSectionDesc}>
                  Menyusun ulang syarat pinjaman atas sisa pokok. Jadwal lama tetap tersimpan sebagai histori.
                </Text>

                {detail.status === 'AKTIF' && (
                  <TouchableOpacity
                    style={styles.akadPrimaryButton}
                    onPress={bukaAkadUlang}
                    accessibilityRole="button"
                    accessibilityLabel="Akad Ulang"
                  >
                    <Ionicons name="create-outline" size={18} color={colors.white} />
                    <Text style={styles.akadPrimaryButtonText}>Akad Ulang</Text>
                  </TouchableOpacity>
                )}

                <View style={styles.akadExportWrap}>
                  <DokumenAkadExportButton
                    pinjamanId={pinjamanId}
                    dokumen={{ jenis: 'ULANG', akadUlangId: riwayatAkad[0]?.id ?? null }}
                    label={riwayatAkad.length > 1 ? 'Export Dokumen Akad Ulang Terbaru' : 'Export Dokumen Akad Ulang'}
                  />
                  <Text style={styles.akadExportHint}>
                    {riwayatAkad.length > 0
                      ? `Dokumen akad ulang #${nomorUrutAkad.get(riwayatAkad[0].id) ?? riwayatAkad.length} · ${formatTanggalPanjang(riwayatAkad[0].tanggal)}`
                      : 'Tersedia setelah akad ulang pertama disimpan.'}
                  </Text>
                </View>
            {riwayatAkad.length > 0 && (
              <TouchableOpacity
                style={styles.riwayatAkadToggle}
                onPress={() => setRiwayatAkadOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: riwayatAkadOpen }}
              >
                <Text style={styles.riwayatAkadLinkText}>Riwayat Akad Ulang ({riwayatAkad.length})</Text>
                <Ionicons name={riwayatAkadOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.primary} />
              </TouchableOpacity>
            )}
            {/* RC-S82 §F — status BERLAKU/HISTORIS dari jadwal yang lahir dari
                event (dibuat_dari_akad_ulang_id), BUKAN kolom `status` event. */}
            {riwayatAkadOpen &&
              riwayatAkad.map((r) => {
                const statusEvent = tentukanStatusEventAkadUlang(r.id, jadwal);
                const berlaku = statusEvent === 'BERLAKU';
                const jadwalEvent = jadwalMilikAkadUlang(jadwal, r.id);
                const akhir = jatuhTempoAkhir(jadwalEvent);
                return (
                  <View key={r.id} style={[styles.riwayatAkadCard, berlaku && styles.riwayatAkadCardBerlaku]}>
                    <View style={styles.riwayatAkadHeader}>
                      <Text style={styles.riwayatAkadJudul}>AKAD ULANG #{nomorUrutAkad.get(r.id) ?? '-'}</Text>
                      <View style={[styles.statusPill, berlaku ? styles.statusPillBerlaku : styles.statusPillHistoris]}>
                        <Text style={[styles.statusPillText, berlaku ? styles.statusPillTextBerlaku : styles.statusPillTextHistoris]}>
                          {labelStatusEventAkadUlang(statusEvent)}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.riwayatAkadTanggal}>{formatTanggalPanjang(r.tanggal)}</Text>

                    <PerbandinganRow label="Tenor" lama={formatTenor(r.tenorLama, r.satuanTenorLama)} baru={formatTenor(r.tenorBaru, r.satuanTenorBaru)} />
                    <PerbandinganRow label="Metode" lama={labelMetodeJasa(r.metodeJasaLama)} baru={labelMetodeJasa(r.metodeJasaBaru)} />
                    <PerbandinganRow label="Jasa" lama={formatPersenJasa(r.persentaseJasaLama)} baru={formatPersenJasa(r.persentaseJasaBaru)} />

                    <View style={styles.riwayatAkadDivider} />
                    <InfoRow label="Sisa pokok saat akad" value={formatRupiah(r.sisaPokok)} strong />
                    <InfoRow label="Jumlah periode akad baru" value={jadwalEvent.length > 0 ? `${jadwalEvent.length} periode` : '-'} />
                    <InfoRow label="Jatuh tempo akhir" value={formatTanggalPanjang(akhir)} />
                    {r.keterangan ? <Text style={styles.riwayatAkadKeterangan}>Keterangan: {r.keterangan}</Text> : null}

                    <View style={styles.riwayatAkadAksi}>
                      <DokumenAkadExportButton
                        pinjamanId={pinjamanId}
                        dokumen={{ jenis: 'ULANG', akadUlangId: r.id }}
                        label="Export Dokumen Akad Ulang"
                        variant="compact"
                      />
                    </View>
                  </View>
                );
              })}
              </View>
            )}
          </View>
        )}

        {/* ============================================================
            REQUIREMENT 6 (permintaan pengguna) — jadwal angsuran TIDAK
            LAGI dirender sebagai satu daftar campur. Empat kelompok
            dipisah tegas, masing-masing dengan export SENDIRI:
              1. Angsuran Aktif      — jadwal berjalan dari akad asli
              2. Angsuran Akad Ulang — jadwal berjalan hasil akad ulang
              3. Restrukturisasi     — jadwal lama yang sudah digantikan
              4. Hapus Buku          — jadwal yang piutangnya di-write-off
            Export "Angsuran Aktif" HANYA memuat kelompok 1 (+2 kalau
            pinjaman memang sudah diakadulangkan), TIDAK PERNAH memuat
            baris restrukturisasi/hapus buku.
            ============================================================ */}
        <SeksiJadwal
          judul="Angsuran Aktif"
          keterangan="Angsuran berjalan dari akad asli pinjaman ini."
          items={kelompokJadwal.aktif}
          bagian="AKTIF"
          detail={detail}
          koperasi={koperasi}
          periodeRelatif={periodeRelatif}
          bolehBayar={detail.status === 'AKTIF'}
          onBayar={openPay}
          emptyText={
            kelompokJadwal.akadUlang.length > 0
              ? 'Seluruh angsuran akad asli sudah digantikan oleh akad ulang — lihat bagian Angsuran Akad Ulang di bawah.'
              : 'Belum ada jadwal angsuran. Susun jadwal terlebih dahulu sebelum pencairan.'
          }
        />

        {kelompokJadwal.akadUlang.length > 0 && (
          <SeksiJadwal
            judul="Angsuran Akad Ulang"
            keterangan="Angsuran berjalan yang disusun ulang lewat Akad Ulang. Inilah kewajiban yang berlaku saat ini."
            items={kelompokJadwal.akadUlang}
            bagian="AKAD_ULANG"
            detail={detail}
            koperasi={koperasi}
            periodeRelatif={periodeRelatif}
            bolehBayar={detail.status === 'AKTIF'}
            onBayar={openPay}
            emptyText=""
          />
        )}

        {kelompokJadwal.restrukturisasi.length > 0 && (
          <SeksiJadwal
            judul="Restrukturisasi (Histori)"
            keterangan="Jadwal LAMA yang sudah digantikan oleh akad ulang. Disimpan untuk audit — tidak ditagih dan tidak ikut dalam export Angsuran Aktif."
            items={kelompokJadwal.restrukturisasi}
            bagian="RESTRUKTURISASI"
            detail={detail}
            koperasi={koperasi}
            periodeRelatif={periodeRelatif}
            bolehBayar={false}
            onBayar={openPay}
            emptyText=""
            redup
          />
        )}

        {kelompokJadwal.dihapusbuku.length > 0 && (
          <SeksiJadwal
            judul="Hapus Buku (Histori)"
            keterangan="Angsuran yang piutangnya sudah dihapusbukukan. Disimpan untuk audit."
            items={kelompokJadwal.dihapusbuku}
            bagian="RESTRUKTURISASI"
            detail={detail}
            koperasi={koperasi}
            periodeRelatif={periodeRelatif}
            bolehBayar={false}
            onBayar={openPay}
            emptyText=""
            redup
          />
        )}
      </ScrollView>

      <Modal visible={!!payModal} transparent animationType="fade" onRequestClose={() => setPayModal(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Bayar {payModal ? labelNomorAngsuran(payModal, periodeRelatif.get(payModal.id)).utama : ''}
            </Text>
            <FocusTextInput
              style={styles.modalInput}
              keyboardType="number-pad"
              value={payNominal}
              onChangeText={setPayNominal}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setPayModal(null)}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSubmit} onPress={submitPay} disabled={processing}>
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Bayar</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      {/* KONFIRMASI TANDA TANGAN AKAD — langkah 1 dari 2 sebelum pencairan. */}
      <Modal visible={konfirmasiAkadOpen} transparent animationType="fade" onRequestClose={() => setKonfirmasiAkadOpen(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.modalCard}>
              <View style={styles.akadKonfirmasiIkon}>
                <Ionicons name="document-text-outline" size={26} color={colors.primary} />
              </View>
              <Text style={styles.akadKonfirmasiLangkah}>Langkah 1 dari 2</Text>
              <Text style={[styles.modalTitle, styles.akadKonfirmasiJudul]}>Konfirmasi Tanda Tangan Akad</Text>
              <Text style={styles.akadKonfirmasiDesk}>
                Dana hanya boleh dicairkan setelah Perjanjian Pinjaman ditandatangani oleh kedua pihak.
              </Text>

              <View style={styles.akadKonfirmasiRingkas}>
                <BarisKonfirmasi label="No. Pinjaman" nilai={detail.nomorPinjaman} />
                <BarisKonfirmasi pemisah label="No. Perjanjian" nilai={buatNomorDokumenAkadAwal(detail.nomorPinjaman, detail.tanggal)} />
                <BarisKonfirmasi pemisah label="Peminjam" nilai={detail.namaAnggota} />
                <BarisKonfirmasi pemisah label="Jumlah Pinjaman" nilai={formatRupiah(detail.jumlahPinjaman)} tebal />
              </View>

              <View style={styles.akadKonfirmasiCek}>
                {[
                  'Perjanjian Pinjaman sudah dicetak',
                  'Anggota sudah menandatangani di atas meterai Rp10.000',
                  'Ketua koperasi sudah menandatangani',
                ].map((t) => (
                  <View key={t} style={styles.akadKonfirmasiCekBaris}>
                    <Ionicons name="ellipse-outline" size={8} color={colors.textMuted} style={{ marginTop: 5 }} />
                    <Text style={styles.akadKonfirmasiCekTeks}>{t}</Text>
                  </View>
                ))}
              </View>

              <Pressable
                style={[styles.akadPernyataan, akadDitandatangani && styles.akadPernyataanAktif]}
                onPress={() => setAkadDitandatangani((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: akadDitandatangani }}
                accessibilityLabel="Akad sudah ditandatangani kedua pihak"
              >
                <Ionicons
                  name={akadDitandatangani ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={akadDitandatangani ? colors.primary : colors.textMuted}
                />
                <Text style={styles.akadPernyataanTeks}>Saya menyatakan akad pinjaman ini sudah ditandatangani oleh anggota dan koperasi.</Text>
              </Pressable>

              <View style={styles.akadKonfirmasiExport}>
                <DokumenAkadExportButton pinjamanId={pinjamanId} dokumen={{ jenis: 'AWAL' }} label="Cetak Perjanjian Pinjaman" />
              </View>

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setKonfirmasiAkadOpen(false)}>
                  <Text style={styles.modalCancelText}>Belum</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalSubmit, !akadDitandatangani && styles.disabled]}
                  onPress={lanjutCairkanSetelahAkad}
                  disabled={!akadDitandatangani}
                  accessibilityState={{ disabled: !akadDitandatangani }}
                >
                  <Text style={styles.modalSubmitText}>Sudah, Lanjutkan</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      <Modal visible={cairkanModalOpen} transparent animationType="fade" onRequestClose={() => setCairkanModalOpen(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            {cairkanMode === 'BARU' && <Text style={styles.akadKonfirmasiLangkah}>Langkah 2 dari 2</Text>}
            <Text style={styles.modalTitle}>{cairkanMode === 'BARU' ? 'Cairkan Pinjaman' : 'Edit Pencairan — Ganti Sumber Dana'}</Text>
            {cairkanMode === 'BARU' && (
              <View style={styles.akadTerkonfirmasi}>
                <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
                <Text style={styles.akadTerkonfirmasiTeks}>Akad sudah ditandatangani · {formatRupiah(detail.jumlahPinjaman)}</Text>
              </View>
            )}
            <RekeningPicker label="Sumber Dana / Rekening" value={rekening} onChange={setRekening} />
            {cairkanMode === 'EDIT' && (
              <>
                <Text style={styles.modalLabel}>Alasan Koreksi *</Text>
                <FocusTextInput
                  style={[styles.modalInput, styles.modalInputMultiline]}
                  value={alasanEdit}
                  onChangeText={setAlasanEdit}
                  multiline
                  placeholder="Mis. salah pilih rekening bank"
                />
              </>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setCairkanModalOpen(false)}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, (!rekening || processing) && styles.disabled]}
                onPress={submitCairkan}
                disabled={!rekening || processing}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>{cairkanMode === 'BARU' ? 'Cairkan' : 'Simpan'}</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      <Modal visible={batalkanModalOpen} transparent animationType="fade" onRequestClose={() => setBatalkanModalOpen(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Batalkan Pencairan</Text>
            <Text style={styles.modalSub}>
              Jurnal pencairan akan di-reversal dan pinjaman kembali ke status Disetujui, siap dicairkan ulang.
              Hanya bisa dilakukan karena belum ada angsuran yang dibayarkan.
            </Text>
            <FocusTextInput
              style={[styles.modalInput, styles.modalInputMultiline]}
              value={alasanBatal}
              onChangeText={setAlasanBatal}
              multiline
              placeholder="Alasan pembatalan (wajib diisi)"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setBatalkanModalOpen(false)}>
                <Text style={styles.modalCancelText}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitDanger, (!alasanBatal.trim() || processing) && styles.disabled]}
                onPress={submitBatalkan}
                disabled={!alasanBatal.trim() || processing}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Batalkan</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      {/* Bug fix (BUG 1): modal TERPISAH untuk "Batalkan Pinjaman"
          (loan belum cair sama sekali) — beda dari modal "Batalkan
          Pencairan" di atas. Memanggil batalkanPinjaman() (set status
          DITOLAK), BUKAN hapusPencairanPinjaman(). */}
      <Modal visible={batalkanPinjamanModalOpen} transparent animationType="fade" onRequestClose={() => setBatalkanPinjamanModalOpen(false)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Batalkan Pinjaman</Text>
            <Text style={styles.modalSub}>
              Pengajuan pinjaman ini akan dibatalkan. Belum ada jurnal, piutang, atau pendapatan jasa yang
              tercipta karena pinjaman belum pernah dicairkan — tidak ada dampak akuntansi.
            </Text>
            <FocusTextInput
              style={[styles.modalInput, styles.modalInputMultiline]}
              value={alasanBatalPinjaman}
              onChangeText={setAlasanBatalPinjaman}
              multiline
              placeholder="Alasan pembatalan (wajib diisi)"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setBatalkanPinjamanModalOpen(false)}>
                <Text style={styles.modalCancelText}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitDanger, (!alasanBatalPinjaman.trim() || processing) && styles.disabled]}
                onPress={submitBatalkanPinjaman}
                disabled={!alasanBatalPinjaman.trim() || processing}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Batalkan</Text>}
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>

      {/* ============================================================
          RC-S82 §C (revisi UX) — AKAD ULANG SEBAGAI BOTTOM SHEET.
          Bug sebelumnya: formulir panjang di dalam `modalUi.card`
          (maxHeight 90%) yang dibungkus ScrollView luar — latar kartu
          berhenti di 90% sementara isinya terus dirender di atas backdrop
          gelap, dan judul ikut tergulung keluar layar.
          Struktur sekarang (dipakai modal akad ulang DAN konfirmasinya):
            header TETAP (judul + tutup) → body SCROLL → footer aksi TETAP.
          Kartu = satu-satunya batas tinggi; hanya body yang bergulir.
          ============================================================ */}
      <AkadSheet
        visible={akadModalOpen}
        onClose={() => setAkadModalOpen(false)}
        judul="Akad Ulang Pinjaman"
        subjudul="Menyusun kembali syarat pinjaman untuk sisa pokok. Jadwal lama tetap tersimpan sebagai histori."
        footer={
          <>
            {akadError && <Text style={styles.sheetError}>{akadError}</Text>}
            <View style={styles.sheetActions}>
              <TouchableOpacity style={styles.sheetSecondary} onPress={() => setAkadModalOpen(false)} accessibilityRole="button">
                <Text style={styles.sheetSecondaryText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetPrimary, (!akadValidasiLive.ok || processing) && styles.disabled]}
                onPress={validasiAkadLaluKonfirmasi}
                disabled={processing}
                accessibilityRole="button"
              >
                <Text style={styles.sheetPrimaryText}>Simpan Akad Ulang</Text>
              </TouchableOpacity>
            </View>
          </>
        }
      >
        <Text style={styles.akadSeksiJudul}>Posisi Saat Ini</Text>
        <View style={styles.akadInfoBox}>
          <InfoRow label="Status Pinjaman" value={detail?.status ?? '-'} />
          <InfoRow label="Sisa Pokok Akad Ulang" value={formatRupiah(ringkasanAkad.sisaPokok)} strong />
          <InfoRow label="Jumlah Jadwal Current" value={`${ringkasanAkad.jumlahJadwalCurrent} periode`} />
          <View style={styles.akadInfoDivider} />
          <InfoRow label="Piutang Jasa Telah Diakui" value={akadOutstandingJasa === null ? '…' : formatRupiah(akadOutstandingJasa)} />
          <Text style={styles.akadHelper}>Informasi historis/audit — bukan tambahan pokok akad baru.</Text>
        </View>

        <Text style={styles.akadSeksiJudul}>Akad Baru</Text>
        <Text style={styles.sheetLabel}>Tanggal Akad Ulang *</Text>
        <DatePicker value={akadTanggal} onChange={setAkadTanggal} maximumDate={getWaktuSekarang()} />

        <Text style={styles.sheetLabel}>Tenor Baru *</Text>
        <View style={styles.tenorRow}>
          <FocusTextInput
            style={[styles.modalInput, styles.tenorInput]}
            keyboardType="number-pad"
            value={akadTenor}
            onChangeText={setAkadTenor}
            placeholder="Mis. 12"
          />
          <Text style={styles.tenorSuffix}>{labelSatuanTenor(akadSatuanTenor)}</Text>
        </View>

        <Text style={styles.sheetLabel}>Satuan Tenor</Text>
        <View style={styles.segment}>
          {(['HARI', 'MINGGU', 'BULAN'] as SatuanTenor[]).map((sat) => {
            const aktif = akadSatuanTenor === sat;
            return (
              <TouchableOpacity
                key={sat}
                style={[styles.segmentItem, aktif && styles.segmentItemActive]}
                onPress={() => setAkadSatuanTenor(sat)}
                accessibilityRole="radio"
                accessibilityState={{ selected: aktif }}
              >
                <Text style={[styles.segmentText, aktif && styles.segmentTextActive]}>{labelSatuanTenor(sat)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.sheetLabel}>Metode Jasa Baru</Text>
        <View style={styles.segment}>
          {(['FLAT', 'MENURUN', 'EFEKTIF'] as MetodeJasa[]).map((m) => {
            const aktif = akadMetodeJasa === m;
            return (
              <TouchableOpacity
                key={m}
                style={[styles.segmentItem, aktif && styles.segmentItemActive]}
                onPress={() => setAkadMetodeJasa(m)}
                accessibilityRole="radio"
                accessibilityState={{ selected: aktif }}
              >
                <Text style={[styles.segmentText, aktif && styles.segmentTextActive]}>{labelMetodeJasa(m)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.sheetLabel}>Persentase Jasa Baru *</Text>
        <View style={styles.tenorRow}>
          <FocusTextInput
            style={[styles.modalInput, styles.tenorInput]}
            keyboardType="decimal-pad"
            value={akadPersentaseJasa}
            onChangeText={setAkadPersentaseJasa}
            placeholder="Mis. 1,5"
          />
          <Text style={styles.tenorSuffix}>% / periode</Text>
        </View>

        <Text style={styles.sheetLabel}>Keterangan</Text>
        <FocusTextInput
          style={[styles.modalInput, styles.modalInputMultiline]}
          value={akadKeterangan}
          onChangeText={setAkadKeterangan}
          multiline
          placeholder="Opsional — alasan/berita acara akad ulang"
        />

        <Text style={[styles.akadSeksiJudul, styles.akadSeksiJudulJarak]}>Preview Perubahan</Text>
        {akadValidasiLive.ok ? (
          <PreviewPerubahanAkad detail={detail} draft={akadValidasiLive.draft} sisaPokok={ringkasanAkad.sisaPokok} />
        ) : (
          <View style={styles.akadPreviewKosongBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
            <Text style={styles.akadPreviewKosong}>{akadValidasiLive.error}</Text>
          </View>
        )}
      </AkadSheet>

      {/* RC-S82 §D — konfirmasi: ringkasan perubahan AKTUAL dari draft yang
          dibekukan; draft yang sama dikirim ke service. */}
      <AkadSheet
        visible={akadKonfirmasiOpen}
        onClose={() => !processing && setAkadKonfirmasiOpen(false)}
        judul="Konfirmasi Akad Ulang"
        subjudul="Akad ulang akan mengganti syarat akad berdasarkan sisa pokok saat ini."
        footer={
          <View style={styles.sheetActions}>
            <TouchableOpacity style={styles.sheetSecondary} onPress={() => setAkadKonfirmasiOpen(false)} disabled={processing} accessibilityRole="button">
              <Text style={styles.sheetSecondaryText}>Kembali</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sheetPrimary, (!akadDraft || processing) && styles.disabled]}
              onPress={submitAkadUlang}
              disabled={!akadDraft || processing}
              accessibilityRole="button"
            >
              {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.sheetPrimaryText}>Ya, Simpan Akad Ulang</Text>}
            </TouchableOpacity>
          </View>
        }
      >
        {akadDraft && <PreviewPerubahanAkad detail={detail} draft={akadDraft} sisaPokok={ringkasanAkad.sisaPokok} />}
        <View style={styles.akadCatatanBox}>
          <Ionicons name="archive-outline" size={16} color={colors.textMuted} />
          <Text style={styles.akadCatatan}>Jadwal lama tetap tersimpan sebagai histori dan tidak menjadi kewajiban berjalan.</Text>
        </View>
      </AkadSheet>
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

/**
 * RC-S82 (revisi UX) — kerangka bottom sheet untuk alur Akad Ulang.
 * Header dan footer TETAP; hanya body yang bergulir, dan tinggi sheet
 * dibatasi 92% layar di SATU tempat (wrapper), sehingga latar sheet
 * selalu membungkus seluruh isi — tidak ada konten yang "bocor" ke
 * backdrop. Tap di backdrop menutup sheet (sama dengan tombol ×).
 */
function AkadSheet({
  visible,
  onClose,
  judul,
  subjudul,
  footer,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  judul: string;
  subjudul?: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.sheetBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Tutup" />
        <AreaAmanKeyboard varian="dialog" style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>{judul}</Text>
                {subjudul ? <Text style={styles.sheetSub}>{subjudul}</Text> : null}
              </View>
              <TouchableOpacity style={styles.sheetClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Tutup">
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.sheetBody}
              contentContainerStyle={styles.sheetBodyContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>
            <View style={styles.sheetFooter}>{footer}</View>
          </View>
        </AreaAmanKeyboard>
      </View>
    </Modal>
  );
}

/** RC-S82 — baris label/nilai ringkas untuk kartu posisi & riwayat. */
function InfoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.akadInfoRow}>
      <Text style={styles.akadInfoLabel}>{label}</Text>
      <Text style={[styles.akadInfoValue, strong && styles.akadInfoValueStrong]}>{value}</Text>
    </View>
  );
}

/** RC-S82 — baris "lama → baru" pada kartu riwayat. */
function PerbandinganRow({ label, lama, baru }: { label: string; lama: string; baru: string }) {
  return (
    <View style={styles.perbandinganRow}>
      <Text style={styles.perbandinganLabel}>{label}</Text>
      <Text style={styles.perbandinganNilai}>
        {lama} <Text style={styles.perbandinganPanah}>→</Text> <Text style={styles.perbandinganBaru}>{baru}</Text>
      </Text>
    </View>
  );
}

/**
 * RC-S82 §C/§D — tabel AKAD LAMA → AKAD BARU. Nilai "baru" berasal dari
 * `draft` (hasil parser yang sama dengan payload service); nilai "lama"
 * dari data pinjaman yang sedang berlaku. Dipakai di preview modal DAN
 * dialog konfirmasi supaya keduanya identik.
 */
function PreviewPerubahanAkad({
  detail,
  draft,
  sisaPokok,
}: {
  detail: { tenor: number; satuanTenor: string; metodeJasa: string; persentaseJasa: number; tanggalJatuhTempo: string | null } | null;
  draft: DraftAkadUlang;
  sisaPokok: number;
}) {
  const baris: { label: string; lama: string; baru: string }[] = [
    {
      label: 'Tenor',
      lama: detail ? formatTenor(detail.tenor, detail.satuanTenor) : '-',
      baru: formatTenor(draft.tenor, draft.satuanTenor),
    },
    { label: 'Metode Jasa', lama: detail ? labelMetodeJasa(detail.metodeJasa) : '-', baru: labelMetodeJasa(draft.metodeJasa) },
    {
      label: 'Persentase Jasa',
      lama: detail ? formatPersenJasa(detail.persentaseJasa) : '-',
      baru: formatPersenJasa(draft.persentaseJasa),
    },
    { label: 'Sisa Pokok', lama: formatRupiah(sisaPokok), baru: formatRupiah(sisaPokok) },
    {
      label: 'Jatuh Tempo',
      lama: formatTanggalPanjang(detail?.tanggalJatuhTempo ?? null),
      baru: formatTanggalPanjang(jatuhTempoBaruPreview(draft)),
    },
  ];
  return (
    <View style={styles.previewBox}>
      <View style={[styles.previewRow, styles.previewHeader]}>
        <Text style={[styles.previewLabel, styles.previewHeaderText]}> </Text>
        <Text style={[styles.previewCell, styles.previewHeaderText]}>AKAD LAMA</Text>
        <Text style={[styles.previewCell, styles.previewHeaderText]}>AKAD BARU</Text>
      </View>
      {baris.map((b) => (
        <View key={b.label} style={styles.previewRow}>
          <Text style={styles.previewLabel}>{b.label}</Text>
          <Text style={styles.previewCell}>{b.lama}</Text>
          <Text style={[styles.previewCell, b.lama !== b.baru && styles.previewCellBerubah]}>{b.baru}</Text>
        </View>
      ))}
      <Text style={styles.previewTanggal}>Tanggal akad ulang: {formatTanggalPanjang(draft.tanggal)}</Text>
    </View>
  );
}

/**
 * REQUIREMENT 6 — satu seksi jadwal angsuran (judul, keterangan, tombol
 * export bagian ini, daftar baris). Dibuat sebagai komponen level-modul
 * (BUKAN fungsi di dalam PinjamanDetailScreen) supaya identitas tipenya
 * stabil dan React tidak me-mount ulang seluruh daftar setiap kali
 * layar induk render.
 */
function SeksiJadwal({
  judul,
  keterangan,
  items,
  bagian,
  detail,
  koperasi,
  bolehBayar,
  onBayar,
  emptyText,
  redup,
  periodeRelatif,
}: {
  judul: string;
  keterangan: string;
  items: JadwalAngsuranItem[];
  bagian: BagianAngsuranExport;
  detail: any;
  koperasi: any;
  bolehBayar: boolean;
  onBayar: (item: JadwalAngsuranItem) => void;
  emptyText: string;
  redup?: boolean;
  /** RC-S82 §G — nomor periode relatif jadwal hasil akad ulang. */
  periodeRelatif: Map<string, PeriodeRelatif>;
}) {
  const totalSisa = items.reduce(
    (a, j) => a + Math.max(0, j.total - j.pokokTerbayar - j.jasaTerbayar),
    0
  );

  return (
    <View style={styles.seksiJadwal}>
      <View style={styles.seksiHeader}>
        <Text style={styles.sectionLabel}>{judul}</Text>
        <Text style={styles.seksiJumlah}>{items.length} periode</Text>
      </View>
      {!!keterangan && <Text style={styles.seksiKeterangan}>{keterangan}</Text>}

      {items.length > 0 && (
        <ExportButton
          label={`Export ${judul}`}
          data={
            koperasi && detail
              ? buildAngsuranExport(
                  { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                  detail.nomorPinjaman,
                  detail.namaAnggota,
                  items,
                  bagian
                )
              : null
          }
        />
      )}

      {items.length === 0 ? (
        <Text style={styles.seksiEmpty}>{emptyText}</Text>
      ) : (
        items.map((item) => {
          const sisa = item.total - item.pokokTerbayar - item.jasaTerbayar;
          const nomor = labelNomorAngsuran(item, periodeRelatif.get(item.id));
          return (
            <View key={item.id} style={[styles.jadwalRow, redup && styles.jadwalRowRedup]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.jadwalNomor}>{nomor.utama}</Text>
                {nomor.internal ? <Text style={styles.jadwalInternal}>{nomor.internal}</Text> : null}
                <Text style={styles.jadwalSub}>Jatuh tempo {item.tanggalJatuhTempo}</Text>
                <Text style={styles.jadwalSub}>
                  Pokok {formatRupiah(item.pokok)} · Jasa {formatRupiah(item.jasa)}
                  {item.denda > 0 ? ` · Denda ${formatRupiah(item.denda)}` : ''}
                </Text>
                <Text style={[styles.jadwalStatus, { color: STATUS_ANGSURAN_COLOR[item.status] ?? colors.textMuted }]}>
                  {item.status.replace(/_/g, ' ')}
                </Text>
              </View>
              {/* Tombol Bayar HANYA untuk baris yang benar-benar aktif —
                  baris restrukturisasi/hapus buku tidak boleh bisa
                  dibayar (server juga menolaknya). */}
              {bolehBayar && item.status !== 'LUNAS' && (
                <TouchableOpacity style={styles.payButton} onPress={() => onBayar(item)}>
                  <Text style={styles.payButtonText}>Bayar</Text>
                </TouchableOpacity>
              )}
              {item.status === 'LUNAS' && <Text style={styles.lunasText}>Lunas</Text>}
              {item.status !== 'LUNAS' && <Text style={styles.sisaText}>Sisa {formatRupiah(sisa)}</Text>}
            </View>
          );
        })
      )}

      {items.length > 0 && bolehBayar && (
        <View style={styles.seksiTotalRow}>
          <Text style={styles.seksiTotalLabel}>Total Sisa {judul}</Text>
          <Text style={styles.seksiTotalValue}>{formatRupiah(totalSisa)}</Text>
        </View>
      )}
    </View>
  );
}

function BarisKonfirmasi({ label, nilai, tebal, pemisah }: { label: string; nilai: string; tebal?: boolean; pemisah?: boolean }) {
  return (
    <View style={[styles.akadKonfirmasiBaris, pemisah && styles.akadKonfirmasiBarisPemisah]}>
      <Text style={styles.akadKonfirmasiLabel}>{label}</Text>
      <Text style={[styles.akadKonfirmasiNilai, tebal && { fontWeight: '800' }]}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.lg, lineHeight: 18 },
  notFoundButton: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  notFoundButtonText: { color: colors.text, fontWeight: '600' },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2, marginBottom: spacing.lg },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { color: colors.textMuted },
  rowValue: { color: colors.text },
  bold: { fontWeight: '700' },
  actionButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center', marginBottom: spacing.lg },
  actionButtonText: { color: colors.white, fontWeight: '700' },
  actionButtonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary },
  actionButtonSecondaryText: { color: colors.primary, fontWeight: '700' },
  pencairanActionRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.lg },
  actionButtonDanger: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger },
  actionButtonDangerText: { color: colors.danger, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  sectionLabel: { fontSize: 14, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  jadwalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  jadwalNomor: { fontSize: 13, fontWeight: '700', color: colors.text },
  jadwalSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  jadwalStatus: { fontSize: 11, fontWeight: '700', marginTop: 4 },
  payButton: { backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.sm, marginLeft: 8 },
  payButtonText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  lunasText: { color: colors.primary, fontSize: 12, fontWeight: '700', marginLeft: 8 },
  sisaText: { color: colors.danger, fontSize: 11, marginLeft: 8 },
  modalOverlay: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title, marginBottom: spacing.md },
  modalSub: { ...modalUi.description },
  akadInfoBox: { backgroundColor: colors.background, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md, gap: 4 },
  akadInfoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 2, gap: spacing.sm },
  akadInfoLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  akadInfoValue: { fontSize: 12, fontWeight: '700', color: colors.text, textAlign: 'right', flexShrink: 1 },
  akadInfoValueStrong: { fontSize: 14, color: colors.primary },
  akadInfoDivider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  akadHelper: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', lineHeight: 15 },
  akadSeksiJudul: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: spacing.sm, marginBottom: spacing.xs },
  akadPreviewKosong: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  akadPreviewKosongBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, backgroundColor: colors.background },
  akadCatatan: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  akadCatatanBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: radius.sm, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  akadSeksiJudulJarak: { marginTop: spacing.lg },

  // --- Bottom sheet Akad Ulang (header tetap / body scroll / footer tetap) ---
  sheetBackdrop: { ...modalUi.backdrop, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%', maxHeight: '92%' },
  sheet: { ...modalUi.sheet, maxHeight: '100%', padding: 0, overflow: 'hidden' },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: spacing.sm },
  sheetHeader: { ...modalUi.headerRow, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetHeaderText: { flex: 1, minWidth: 0 },
  sheetTitle: { ...modalUi.title, fontSize: 17 },
  sheetSub: { ...modalUi.description, marginBottom: 0 },
  sheetClose: { ...modalUi.closeIcon, marginRight: -spacing.sm },
  sheetBody: { flexGrow: 0, flexShrink: 1 },
  sheetBodyContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg },
  sheetFooter: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  sheetActions: { flexDirection: 'row', gap: spacing.sm },
  sheetPrimary: { ...modalUi.primaryButton, flex: 1, minWidth: 0 },
  sheetPrimaryText: { ...modalUi.primaryText },
  sheetSecondary: { ...modalUi.secondaryButton, flex: 1, minWidth: 0 },
  sheetSecondaryText: { ...modalUi.secondaryText },
  sheetError: { color: colors.danger, fontSize: 12, lineHeight: 17, marginBottom: spacing.sm },
  sheetLabel: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.xs, marginTop: spacing.md },
  tenorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tenorInput: { flex: 1 },
  tenorSuffix: { minWidth: 64, fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  segmentItem: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderLeftWidth: 1, borderLeftColor: colors.border },
  segmentItemActive: { backgroundColor: colors.primary, borderLeftColor: colors.primary },
  segmentText: { fontSize: 13, fontWeight: '600', color: colors.text },
  segmentTextActive: { color: colors.white, fontWeight: '700' },

  // --- Seksi Akad Ulang di layar detail ---
  akadSection: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  akadSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  akadSectionTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 1 },
  akadSectionTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  akadSectionDesc: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.xs, marginBottom: spacing.md },
  akadPrimaryButton: { ...modalUi.primaryButton, alignSelf: 'stretch' },
  akadPrimaryButtonText: { ...modalUi.primaryText },
  akadExportWrap: { marginTop: spacing.sm },
  akadBlok: { marginTop: spacing.md },
  pengurusPeringatan: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, marginTop: spacing.sm, padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningBg },
  pengurusPeringatanText: { flex: 1, fontSize: 11, color: colors.text, lineHeight: 16 },
  akadBlokPemisah: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  akadBlokJudul: { fontSize: 13, fontWeight: '800', color: colors.text, letterSpacing: 0.3 },
  akadBlokMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm, lineHeight: 17 },
  akadExportHint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, textAlign: 'center' },
  riwayatAkadToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  previewBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, marginBottom: spacing.md, overflow: 'hidden' },
  previewRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
  previewHeader: { backgroundColor: colors.primaryLight, borderTopWidth: 0 },
  previewHeaderText: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.4 },
  previewLabel: { width: 84, fontSize: 11, color: colors.textMuted },
  previewCell: { flex: 1, fontSize: 11, color: colors.text },
  previewCellBerubah: { fontWeight: '700', color: colors.primary },
  previewTanggal: { fontSize: 11, color: colors.textMuted, paddingHorizontal: spacing.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background },
  modalLabel: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.sm },
  modalInput: { ...formUi.inputStandalone },
  /**
   * UI/UX FINAL POLISH — sebelumnya keempat isian alasan memakai
   * `height: 60` yang ditulis inline. Tinggi TETAP berarti teks yang
   * lebih panjang dari dua baris terpotong tanpa bisa di-scroll. Token
   * bersama memakai `minHeight`, jadi kotaknya tumbuh lalu isinya yang
   * di-scroll setelah batas atas tercapai.
   */
  modalInputMultiline: { ...formUi.inputStandaloneMultiline },
  modalActions: { ...modalUi.actions },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmit: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm },
  modalSubmitDanger: { backgroundColor: colors.danger, paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm },
  modalSubmitText: { ...modalUi.primaryText },
  seksiJadwal: { marginTop: spacing.lg },
  seksiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  seksiJumlah: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  seksiKeterangan: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginBottom: spacing.sm },
  seksiEmpty: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: spacing.sm },
  jadwalRowRedup: { opacity: 0.6, backgroundColor: colors.background },
  seksiTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  seksiTotalLabel: { fontSize: 12, fontWeight: '700', color: colors.text },
  seksiTotalValue: { fontSize: 12, fontWeight: '700', color: colors.primary },
  riwayatAkadLinkText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  riwayatAkadCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  riwayatAkadCardBerlaku: { borderColor: colors.primary, borderWidth: 1.5 },
  riwayatAkadHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, marginBottom: 2 },
  riwayatAkadJudul: { fontSize: 13, fontWeight: '800', color: colors.text, letterSpacing: 0.3 },
  riwayatAkadTanggal: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  riwayatAkadDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  riwayatAkadKeterangan: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  riwayatAkadAksi: { marginTop: spacing.sm },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, flexShrink: 1 },
  akadKonfirmasiIkon: { alignSelf: 'center', width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  akadKonfirmasiLangkah: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', textAlign: 'center', marginBottom: 2 },
  akadKonfirmasiJudul: { textAlign: 'center', marginBottom: spacing.xs },
  akadKonfirmasiDesk: { fontSize: 13, color: colors.textMuted, lineHeight: 19, textAlign: 'center', marginBottom: spacing.md },
  akadKonfirmasiRingkas: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: colors.background },
  akadKonfirmasiBaris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 6 },
  akadKonfirmasiBarisPemisah: { borderTopWidth: 1, borderTopColor: colors.border },
  akadKonfirmasiLabel: { fontSize: 12, color: colors.textMuted },
  akadKonfirmasiNilai: { flexShrink: 1, fontSize: 12, fontWeight: '600', color: colors.text, textAlign: 'right' },
  akadKonfirmasiCek: { marginTop: spacing.md, gap: 6 },
  akadKonfirmasiCekBaris: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  akadKonfirmasiCekTeks: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  akadPernyataan: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  akadPernyataanAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  akadPernyataanTeks: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text, lineHeight: 18 },
  akadKonfirmasiExport: { marginTop: spacing.md },
  akadTerkonfirmasi: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.md, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: colors.primaryLight },
  akadTerkonfirmasiTeks: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.text },
  statusPillBerlaku: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  statusPillHistoris: { backgroundColor: colors.background, borderColor: colors.border },
  statusPillText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  statusPillTextBerlaku: { color: colors.primary },
  statusPillTextHistoris: { color: colors.textMuted },
  perbandinganRow: { flexDirection: 'row', paddingVertical: 2, gap: spacing.sm },
  perbandinganLabel: { width: 56, fontSize: 11, color: colors.textMuted },
  perbandinganNilai: { flex: 1, fontSize: 11, color: colors.textMuted },
  perbandinganPanah: { color: colors.textFaint },
  perbandinganBaru: { color: colors.text, fontWeight: '700' },
  jadwalInternal: { fontSize: 10, color: colors.textFaint, marginTop: 1 },
});
