import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getShuKonfigurasiByTahun,
  getShuAnggotaList,
  bagikanSHU,
  ajukanShuKeRAT,
  sahkanShuRAT,
  ShuKonfigurasiRow,
  ShuAnggotaRow,
} from '@/services/ShuService';
import { simpanRAT, getRATByTahunBuku, RATItem } from '@/services/RATService';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import DatePicker from '@/components/DatePicker';
import { useAppStore } from '@/store/useAppStore';
import { buildShuAnggotaExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import CurrencyInput from '@/components/CurrencyInput';
import EditButton from '@/components/EditButton';
import StatusBadge from '@/components/StatusBadge';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * Ringkasan hasil perhitungan SHU + daftar anggota (PRD §29).
 *
 * Update pasca-Phase 18 §12 (permintaan pengguna): flow BAGIKAN SHU
 * diubah — DIHITUNG -> [RAT belum ada] -> Form Pelaksanaan RAT ->
 * simpan -> BARU tombol Bagikan SHU aktif. Sebelumnya tombol Bagikan
 * SHU langsung aktif begitu status DIHITUNG. Gate SUNGGUHAN ada di
 * `ShuService.bagikanSHU()` (menolak kalau RAT belum ada) — form RAT
 * di sini murni UX supaya penggunanya tidak perlu menebak alasan
 * tombol nonaktif.
 */
export default function ShuDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { tahunBuku } = route.params ?? {};

  const [konfigurasi, setKonfigurasi] = useState<ShuKonfigurasiRow | null>(null);
  const [anggotaList, setAnggotaList] = useState<ShuAnggotaRow[]>([]);
  const [rat, setRat] = useState<RATItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [ratModalOpen, setRatModalOpen] = useState(false);
  const [ajukanModalOpen, setAjukanModalOpen] = useState(false);
  const [sahkanModalOpen, setSahkanModalOpen] = useState(false);

  const load = useCallback(async () => {
    if (!tahunBuku) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const k = await getShuKonfigurasiByTahun(tahunBuku);
      setKonfigurasi(k);
      if (!k) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const rows = await getShuAnggotaList(k.id);
      setAnggotaList(rows);
      setRat(await getRATByTahunBuku(tahunBuku));
    } catch (e) {
      // Bug fix: sebelumnya error apa pun di sini tidak ditangani —
      // layar diam di spinner selamanya. Sekarang pesan jelas.
      setNotFound(true);
      notify('Gagal', e instanceof Error ? e.message : 'Gagal memuat data SHU.');
    } finally {
      setLoading(false);
    }
  }, [tahunBuku]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  // Update pasca-6-perbaikan (permintaan pengguna §3): RAT harus ADA
  // *dan* tanggal pelaksanaannya sudah lewat/sama dengan hari ini —
  // dua kondisi terpisah (dulu cuma "RAT ada" saja cukup). Perbandingan
  // string ISO (YYYY-MM-DD), SAMA persis dengan cara ShuService.bagikanSHU()
  // membandingkan, supaya UI & service TIDAK PERNAH berselisih hasil.
  const hariIni = getTanggalLokalHariIni();
  const ratSudahLewat = !!rat && hariIni >= rat.tanggalRat;

  const konfirmasiBagikan = () => {
    notify(
      'Bagikan SHU',
      `SHU DISAHKAN RAT tahun buku ${tahunBuku} (${formatRupiah(konfigurasi?.shuDisahkanRat ?? 0)}) akan diposting ke jurnal dan ditambahkan ke simpanan sukarela tiap anggota. Tindakan ini TIDAK BISA dibatalkan. Lanjutkan?`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Bagikan', style: 'destructive', onPress: doBagikan },
      ]
    );
  };

  // Phase 18 §6 (permintaan pengguna): edit SHU yang sudah DIHITUNG —
  // mengarah ke ShuFormScreen (yang sudah lama pre-fill konfigurasi
  // existing & memanggil simpanKonfigurasiShu, yang sudah lama
  // mereset status ke DRAFT + hapus shu_anggota lama secara aman
  // sebelum hitungSHU dijalankan ulang). Konfirmasi dulu di sini
  // karena aksinya mengubah hasil yang sudah ada, sesuai permintaan
  // "tampilkan konfirmasi".
  const konfirmasiEdit = () => {
    notify(
      'Edit Konfigurasi SHU',
      `Mengedit akan mereset hasil perhitungan SHU tahun buku ${tahunBuku} yang sekarang — dihitung ulang dari konfigurasi baru setelah disimpan. Lanjutkan?`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Edit', onPress: () => navigation.navigate('ShuForm', { tahunBuku }) },
      ]
    );
  };

  const doBagikan = async () => {
    if (!currentUser) return;
    setProcessing(true);
    try {
      await bagikanSHU(tahunBuku, currentUser.id);
      await load();
      notify('Berhasil', 'SHU berhasil dibagikan dan diposting ke jurnal.');
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  // Audit ulang (permintaan pengguna, request baru §4): ajukan nominal
  // ke RAT — TIDAK memposting jurnal apa pun (§9: "jangan membuat
  // jurnal pembagian ketika hanya... mengajukan SHU ke RAT").
  const doAjukan = async (nominal: number) => {
    if (!currentUser) return;
    setProcessing(true);
    try {
      await ajukanShuKeRAT(currentUser.id, tahunBuku, nominal);
      await load();
      notify('Berhasil', `SHU tahun buku ${tahunBuku} berhasil diajukan ke RAT.`);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  // Audit ulang §5/§6: sahkan nominal final RAT — menghitung ulang
  // distribusi (shu_anggota) berbasis nominal ini, TIDAK memposting
  // jurnal apa pun (jurnal baru dibuat saat benar-benar Bagikan SHU).
  const doSahkan = async (nominal: number, catatan: string) => {
    if (!currentUser) return;
    setProcessing(true);
    try {
      await sahkanShuRAT({ tahunBuku, nominalDisahkan: nominal, catatan: catatan || undefined, actingUserId: currentUser.id });
      await load();
      notify('Berhasil', `SHU tahun buku ${tahunBuku} berhasil disahkan RAT.`);
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

  if (notFound || !konfigurasi) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
        <Text style={styles.notFoundText}>Data SHU tidak ditemukan untuk tahun buku ini.</Text>
        <TouchableOpacity style={styles.notFoundButton} onPress={() => navigation.goBack()}>
          <Text style={styles.notFoundButtonText}>Kembali</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const totalShu = konfigurasi.totalShu ?? 0;
  // Audit ulang (permintaan pengguna, request baru §6): dasar tampilan
  // breakdown komponen SHU — SETELAH disahkan RAT, pakai shuDisahkanRat
  // (basis yang SUNGGUHAN dipakai bagikanSHU() & sudah tercermin di
  // shu_anggota lewat sahkanShuRAT()); SEBELUM disahkan, tetap tampilkan
  // pratinjau berbasis totalShu (akrual) seperti sebelumnya — supaya
  // pengguna tetap bisa melihat gambaran distribusi sebelum RAT.
  const basisTampilan = konfigurasi.shuDisahkanRat ?? konfigurasi.totalShu;

  const konfirmasiAjukan = (nominal: number) => {
    setAjukanModalOpen(false);
    doAjukan(nominal);
  };

  return (
    <>
      <FlatList keyboardShouldPersistTaps="handled"
      style={styles.container}
      data={anggotaList}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16 }}
      ListHeaderComponent={
        <>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>SHU Tahun Buku {tahunBuku}</Text>
              <StatusBadge
                label={STATUS_LABEL[konfigurasi.status]}
                bg={STATUS_STYLE[konfigurasi.status].bg}
                fg={STATUS_STYLE[konfigurasi.status].fg}
              />
            </View>
            {(konfigurasi.status === 'DIHITUNG' || konfigurasi.status === 'DIAJUKAN_RAT' || konfigurasi.status === 'DISAHKAN_RAT') && (
              <EditButton onPress={konfirmasiEdit} disabled={processing} />
            )}
          </View>
          <Text style={styles.totalShuLabel}>SHU Laporan Keuangan (Akrual)</Text>
          <Text style={[styles.totalShu, totalShu < 0 && styles.negative]}>{formatRupiah(totalShu)}</Text>
          {totalShu <= 0 && (
            <Text style={styles.warnText}>
              Hasil usaha periode ini tidak positif — sebagian/seluruh komponen SHU bernilai 0 atau negatif.
            </Text>
          )}

          {/* Audit ulang (permintaan pengguna, request baru §10): ringkasan
              perbedaan SHU akrual vs kas vs keputusan RAT — istilah PERSIS
              sesuai §16 ("SHU Laporan Keuangan (Akrual)", "Informasi SHU
              RAT (Basis Kas)", "SHU Disahkan RAT", "SHU Dibagikan").
              Ditampilkan mulai status DIHITUNG (begitu shuInformasiRat
              tersedia) — TIDAK ADA di status DRAFT (belum dihitung). */}
          {konfigurasi.status !== 'DRAFT' && (
            <View style={styles.ratInfoPanel}>
              <Text style={styles.ratInfoPanelTitle}>Informasi SHU RAT</Text>
              <Text style={styles.ratInfoPanelSub}>
                Basis kas/realisasi — laporan tambahan untuk membantu RAT menentukan jumlah yang akan dibagikan.
                Bukan pengganti laporan keuangan berbasis akrual.
              </Text>
              <SummaryRow label="SHU Laporan Keuangan (Akrual)" value={konfigurasi.totalShu} />
              <SummaryRow label="Informasi SHU RAT (Basis Kas)" value={konfigurasi.shuInformasiRat} />
              <SummaryRow
                label="Selisih"
                value={
                  konfigurasi.totalShu !== null && konfigurasi.shuInformasiRat !== null
                    ? konfigurasi.totalShu - konfigurasi.shuInformasiRat
                    : null
                }
              />
              <View style={styles.ratInfoPanelDivider} />
              <SummaryRow label="SHU Diajukan ke RAT" value={konfigurasi.shuDiajukanRat} />
              <SummaryRow label="SHU Disahkan RAT" value={konfigurasi.shuDisahkanRat} bold />
              <SummaryRow
                label="SHU Siap Dibagikan"
                value={konfigurasi.status === 'DISAHKAN_RAT' ? konfigurasi.shuDisahkanRat : null}
                bold
              />
              {konfigurasi.catatanKeputusanRat && (
                <Text style={styles.ratInfoPanelCatatan}>Catatan RAT: {konfigurasi.catatanKeputusanRat}</Text>
              )}
            </View>
          )}

          <View style={styles.card}>
            <Row label="Cadangan Umum" persen={konfigurasi.persenCadangan} nominal={cadangan(konfigurasi, jasaModalDistribusi(anggotaList), jasaUsahaDistribusi(anggotaList))} />
            <Row label="Cadangan Risiko" persen={konfigurasi.persenCadanganRisiko} nominal={pool(basisTampilan, konfigurasi.persenCadanganRisiko)} />
            <Row label="Jasa Modal" persen={konfigurasi.persenJasaModal} nominal={jasaModalDistribusi(anggotaList)} />
            <Row label="Jasa Usaha" persen={konfigurasi.persenJasaUsaha} nominal={jasaUsahaDistribusi(anggotaList)} />
            <Row label="Pendidikan" persen={konfigurasi.persenPendidikan} nominal={pool(basisTampilan, konfigurasi.persenPendidikan)} />
            <Row label="Sosial" persen={konfigurasi.persenSosial} nominal={pool(basisTampilan, konfigurasi.persenSosial)} />
            <Row label="Pengurus" persen={konfigurasi.persenPengurus} nominal={pool(basisTampilan, konfigurasi.persenPengurus)} />
            <Row label="Pengawas" persen={konfigurasi.persenPengawas} nominal={pool(basisTampilan, konfigurasi.persenPengawas)} />
            <Row label="Karyawan" persen={konfigurasi.persenKaryawan} nominal={pool(basisTampilan, konfigurasi.persenKaryawan)} />
            <Row label="Pembangunan Daerah Kerja" persen={konfigurasi.persenPembangunanDaerahKerja} nominal={pool(basisTampilan, konfigurasi.persenPembangunanDaerahKerja)} />
          </View>
          <Text style={styles.reconcileNote}>
            {konfigurasi.shuDisahkanRat !== null
              ? 'Breakdown di atas berbasis SHU DISAHKAN RAT (nominal yang benar-benar akan dijurnal saat dibagikan).'
              : 'Breakdown di atas MASIH PRATINJAU berbasis SHU Laporan Keuangan (akrual) — akan dihitung ulang berbasis SHU Disahkan RAT setelah RAT menetapkan nominal final.'}
            {' '}Total seluruh komponen selalu dijumlahkan persis sama dengan basis di atas (selisih pembulatan &amp;
            sisa pool Jasa Modal/Jasa Usaha yang tidak terbagi ke anggota dilimpahkan ke baris "Cadangan Umum").
            Cadangan Risiko adalah pool tetap (persentase × basis), TIDAK ikut menyerap selisih. Setiap dana
            (Pendidikan, Sosial, Pengurus, Pengawas, Karyawan, Pembangunan Daerah Kerja) dijurnal ke akun Liabilitas
            masing-masing saat SHU dibagikan (lihat Buku Besar akun 2-1800 s.d. 2-1850 untuk penelusuran); Cadangan
            Umum ke akun 3-2000 dan Cadangan Risiko ke akun 3-2100.
          </Text>

          {/* Audit ulang (permintaan pengguna, request baru §4/§8): data
              RAT (tanggal pelaksanaan/nomor berita acara) perlu dilengkapi
              SEBELUM SHU bisa disahkan — ditampilkan selama status belum
              mencapai DISAHKAN_RAT/DIBAGIKAN, supaya bisa disiapkan lebih
              awal (mis. sebelum SHU sempat diajukan). Tiga kondisi
              (belum ada RAT / RAT di masa depan / RAT sudah lewat) — pola
              yang sama dengan sebelumnya. */}
          {(konfigurasi.status === 'DIHITUNG' || konfigurasi.status === 'DIAJUKAN_RAT') && !rat && (
            <View style={styles.ratWarnBox}>
              <Text style={styles.ratWarnText}>SHU baru dapat disahkan RAT setelah RAT dilaksanakan.</Text>
              <TouchableOpacity style={styles.ratButton} onPress={() => setRatModalOpen(true)}>
                <Text style={styles.ratButtonText}>Lengkapi Data RAT</Text>
              </TouchableOpacity>
            </View>
          )}
          {(konfigurasi.status === 'DIHITUNG' || konfigurasi.status === 'DIAJUKAN_RAT') && rat && !ratSudahLewat && (
            <View style={styles.ratWarnBox}>
              <Text style={styles.ratWarnText}>
                SHU dapat disahkan mulai setelah RAT dilaksanakan pada {formatTanggalIndonesia(rat.tanggalRat)}.
              </Text>
              <TouchableOpacity style={styles.ratButtonOutline} onPress={() => setRatModalOpen(true)}>
                <Text style={styles.ratButtonOutlineText}>Lihat Data RAT</Text>
              </TouchableOpacity>
            </View>
          )}
          {(konfigurasi.status === 'DIHITUNG' || konfigurasi.status === 'DIAJUKAN_RAT') && rat && ratSudahLewat && (
            <View style={styles.ratInfoBox}>
              <Text style={styles.ratInfoText}>
                RAT dilaksanakan {formatTanggalIndonesia(rat.tanggalRat)}
                {rat.nomorRat ? ` · ${rat.nomorRat}` : ''}
              </Text>
              <TouchableOpacity onPress={() => setRatModalOpen(true)}>
                <Text style={styles.ratEditLink}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Audit ulang §4: "Ajukan ke RAT" — nominal diajukan default
              Informasi SHU RAT (kas), admin bisa menyesuaikan di modal. */}
          {konfigurasi.status === 'DIHITUNG' && (
            <TouchableOpacity
              style={[styles.bagikanButton, processing && styles.disabled]}
              onPress={() => setAjukanModalOpen(true)}
              disabled={processing}
            >
              <Text style={styles.bagikanButtonText}>Ajukan ke RAT</Text>
            </TouchableOpacity>
          )}

          {/* Audit ulang §5/§6: "Sahkan SHU RAT" — hanya aktif setelah RAT
              tercatat & tanggalnya sudah lewat. */}
          {konfigurasi.status === 'DIAJUKAN_RAT' && ratSudahLewat && (
            <TouchableOpacity
              style={[styles.bagikanButton, processing && styles.disabled]}
              onPress={() => setSahkanModalOpen(true)}
              disabled={processing}
            >
              <Text style={styles.bagikanButtonText}>Sahkan SHU RAT</Text>
            </TouchableOpacity>
          )}

          {/* Audit ulang §7: "Bagikan SHU" HANYA aktif setelah DISAHKAN_RAT
              — kalau belum, tampilkan tombol nonaktif + alasan PERSIS
              sesuai permintaan pengguna. */}
          {konfigurasi.status === 'DISAHKAN_RAT' && (
            <TouchableOpacity
              style={[styles.bagikanButton, processing && styles.disabled]}
              onPress={konfirmasiBagikan}
              disabled={processing}
            >
              {processing ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.bagikanButtonText}>Bagikan SHU</Text>
              )}
            </TouchableOpacity>
          )}
          {(konfigurasi.status === 'DIHITUNG' || konfigurasi.status === 'DIAJUKAN_RAT') && (
            <>
              <TouchableOpacity style={[styles.bagikanButton, styles.bagikanButtonDisabled]} disabled>
                <Text style={styles.bagikanButtonText}>Bagikan SHU</Text>
              </TouchableOpacity>
              <Text style={styles.disabledReasonText}>SHU belum disahkan dalam RAT.</Text>
            </>
          )}

          <ExportButton
            data={
              koperasi && anggotaList.length > 0
                ? buildShuAnggotaExport(
                    { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                    konfigurasi,
                    anggotaList
                  )
                : null
            }
          />

          <Text style={styles.sectionLabel}>Daftar Anggota</Text>
          {anggotaList.length === 0 && <Text style={styles.emptyText}>Tidak ada anggota aktif.</Text>}
        </>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.anggotaRow}
          onPress={() => navigation.navigate('ShuAnggotaDetail', { tahunBuku, anggotaId: item.anggotaId })}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.anggotaNama}>{item.namaAnggota}</Text>
            <Text style={styles.anggotaSub}>{item.nomorAnggota}</Text>
          </View>
          <Text style={styles.anggotaNominal}>{formatRupiah(item.totalShuAnggota)}</Text>
        </TouchableOpacity>
      )}
      />
      <RATFormModal
        visible={ratModalOpen}
        tahunBuku={tahunBuku}
        rat={rat}
        onClose={() => setRatModalOpen(false)}
        onSaved={async () => {
          setRatModalOpen(false);
          await load();
        }}
      />
      <AjukanRATModal
        visible={ajukanModalOpen}
        defaultValue={konfigurasi.shuInformasiRat ?? konfigurasi.totalShu ?? 0}
        maxValue={konfigurasi.totalShu ?? 0}
        onClose={() => setAjukanModalOpen(false)}
        onSubmit={konfirmasiAjukan}
      />
      <SahkanRATModal
        visible={sahkanModalOpen}
        defaultValue={konfigurasi.shuDiajukanRat ?? 0}
        maxValue={konfigurasi.shuDiajukanRat ?? 0}
        onClose={() => setSahkanModalOpen(false)}
        onSubmit={(nominal, catatan) => {
          setSahkanModalOpen(false);
          doSahkan(nominal, catatan);
        }}
      />
    </>
  );
}

/**
 * Form Pelaksanaan RAT (§12) — inline di file ini karena hanya
 * dipakai satu tempat. Field wajib: Tanggal Pelaksanaan RAT. Nomor/
 * Identitas RAT & Keterangan opsional. Data tersimpan SUNGGUHAN lewat
 * `RATService.simpanRAT()` (tabel `rat`), bukan cuma state UI.
 */
function RATFormModal({
  visible,
  tahunBuku,
  rat,
  onClose,
  onSaved,
}: {
  visible: boolean;
  tahunBuku: number;
  rat: RATItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const currentUser = useAppStore((s) => s.currentUser);
  const [tanggalRat, setTanggalRat] = useState(rat?.tanggalRat ?? '');
  const [nomorRat, setNomorRat] = useState(rat?.nomorRat ?? '');
  const [keterangan, setKeterangan] = useState(rat?.keterangan ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setTanggalRat(rat?.tanggalRat ?? '');
      setNomorRat(rat?.nomorRat ?? '');
      setKeterangan(rat?.keterangan ?? '');
      setError(null);
    }
  }, [visible, rat]);

  const submit = async () => {
    if (!currentUser) return;
    if (!tanggalRat) {
      setError('Pelaksanaan RAT wajib diisi sebelum SHU dapat dibagikan.');
      return;
    }
    setSubmitting(true);
    try {
      await simpanRAT({ tahunBuku, tanggalRat, nomorRat: nomorRat.trim() || undefined, keterangan: keterangan.trim() || undefined, createdBy: currentUser.id });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan data RAT.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView
          contentContainerStyle={styles.modalScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Pelaksanaan RAT — Tahun Buku {tahunBuku}</Text>
          <Text style={styles.modalSub}>
            Rapat Anggota Tahunan (RAT) wajib dicatat sebelum SHU tahun buku ini dapat dibagikan.
          </Text>

          <Text style={styles.modalLabel}>Tanggal Pelaksanaan RAT *</Text>
          {/* RC-S109 — BATAS TANGGAL DIPERBAIKI.
              Sebelumnya `maximumDate={getWaktuSekarang()}`: tanggal RAT
              tidak boleh melewati HARI INI. Itu mengunci kasus yang
              justru paling lazim — RAT tahun buku N dilaksanakan pada
              awal tahun N+1, sehingga selama tahun buku N belum lewat,
              tanggal RAT-nya mustahil diisi.

              Sekarang rentangnya mengikuti TAHUN BUKU-nya, bukan hari
              ini: 1 Januari tahun buku s.d. 31 Desember dua tahun
              sesudahnya. Batas atas tetap ada supaya salah ketik tahun
              (mis. 2062) tertangkap, tetapi tahun berikutnya — jadwal
              RAT yang sebenarnya — kini terbuka.

              Gerbang pembagian SHU TIDAK dilonggarkan: `ratSudahLewat`
              di atas tetap menuntut tanggal RAT sudah tiba, dan
              `bagikanSHU()` memeriksa hal yang sama di service. Jadi
              tanggal RAT yang masih di masa depan hanya berarti
              "RAT belum dilaksanakan" — SHU tetap tidak bisa dibagikan
              sampai harinya tiba. */}
          <DatePicker
            value={tanggalRat}
            onChange={setTanggalRat}
            minimumDate={new Date(Date.UTC(tahunBuku, 0, 1))}
            maximumDate={new Date(Date.UTC(tahunBuku + 2, 11, 31))}
          />
          <Text style={styles.modalCatatan}>
            RAT tahun buku {tahunBuku} umumnya dilaksanakan pada awal tahun {tahunBuku + 1}. Tanggal yang belum tiba
            boleh diisi sebagai rencana — pembagian SHU tetap terkunci sampai tanggal itu lewat.
          </Text>

          <Text style={styles.modalLabel}>Nomor Berita Acara RAT</Text>
          <FocusTextInput
            style={styles.modalInput}
            value={nomorRat}
            onChangeText={setNomorRat}
            placeholder="Opsional, mis. 001/BA-RAT/2026"
            placeholderTextColor={colors.placeholder}
          />

          <Text style={styles.modalLabel}>Keterangan</Text>
          <FocusTextInput
            style={[styles.modalInput, styles.modalTextArea]}
            value={keterangan}
            onChangeText={setKeterangan}
            multiline
            placeholder="Opsional"
            placeholderTextColor={colors.placeholder}
          />

          {error && <Text style={styles.ratWarnText}>{error}</Text>}

          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Tutup</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalSubmitBtn, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
              {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Simpan</Text>}
            </TouchableOpacity>
          </View>
          </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>
  );
}

/**
 * Baris ringkasan "Rp xxx" untuk panel Informasi SHU RAT (§10). Value
 * `null` ditampilkan sebagai "-" (belum ada, mis. belum diajukan/
 * disahkan) — TIDAK ditampilkan sebagai "Rp0" supaya tidak disalah-
 * artikan sebagai nominal nol sungguhan.
 */
function SummaryRow({ label, value, bold }: { label: string; value: number | null; bold?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, bold && styles.summaryLabelBold]}>{label}</Text>
      <Text style={[styles.summaryValue, bold && styles.summaryValueBold]}>
        {value !== null ? formatRupiah(value) : '-'}
      </Text>
    </View>
  );
}

/**
 * Modal "Ajukan ke RAT" (§4) — nominal default = Informasi SHU RAT
 * (basis kas), admin bisa menyesuaikan. Divalidasi TIDAK melebihi SHU
 * Laporan Keuangan (akrual) — sama seperti validasi di
 * `ShuService.ajukanShuKeRAT()` (dicek juga di sini untuk UX cepat,
 * validasi SUNGGUHAN tetap di service).
 */
function AjukanRATModal({
  visible,
  defaultValue,
  maxValue,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  defaultValue: number;
  maxValue: number;
  onClose: () => void;
  onSubmit: (nominal: number) => void;
}) {
  const [nominal, setNominal] = useState<number | ''>(defaultValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setNominal(defaultValue);
      setError(null);
    }
  }, [visible, defaultValue]);

  const submit = () => {
    if (nominal === '' || nominal <= 0) {
      setError('Nominal yang diajukan harus lebih dari 0.');
      return;
    }
    if (nominal > maxValue) {
      setError(`Nominal yang diajukan tidak boleh melebihi SHU Laporan Keuangan (${formatRupiah(maxValue)}).`);
      return;
    }
    onSubmit(nominal);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Ajukan SHU ke RAT</Text>
            <Text style={styles.modalSub}>
              Nominal ini akan diajukan sebagai usulan untuk diputuskan RAT. RAT bisa menyahkan sama dengan atau
              lebih kecil dari nominal ini.
            </Text>

            <Text style={styles.modalLabel}>Nominal Diajukan (Rp) *</Text>
            <CurrencyInput value={nominal} onChangeValue={setNominal} />

            {error && <Text style={styles.ratWarnText}>{error}</Text>}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={onClose}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSubmitBtn} onPress={submit}>
                <Text style={styles.modalSubmitText}>Ajukan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>
  );
}

/**
 * Modal "Sahkan SHU RAT" (§5/§6) — nominal default = nominal diajukan,
 * admin bisa menurunkan (tidak boleh menaikkan — divalidasi juga di
 * `ShuService.sahkanShuRAT()`). Catatan keputusan RAT opsional (§4).
 */
function SahkanRATModal({
  visible,
  defaultValue,
  maxValue,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  defaultValue: number;
  maxValue: number;
  onClose: () => void;
  onSubmit: (nominal: number, catatan: string) => void;
}) {
  const [nominal, setNominal] = useState<number | ''>(defaultValue);
  const [catatan, setCatatan] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setNominal(defaultValue);
      setCatatan('');
      setError(null);
    }
  }, [visible, defaultValue]);

  const submit = () => {
    if (nominal === '' || nominal <= 0) {
      setError('Nominal yang disahkan harus lebih dari 0.');
      return;
    }
    if (nominal > maxValue) {
      setError(`Nominal yang disahkan tidak boleh melebihi nominal yang diajukan ke RAT (${formatRupiah(maxValue)}).`);
      return;
    }
    onSubmit(nominal, catatan.trim());
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Sahkan SHU RAT</Text>
            <Text style={styles.modalSub}>
              Nominal ini adalah keputusan FINAL RAT — akan menjadi satu-satunya dasar distribusi & jurnal saat SHU
              benar-benar dibagikan. Rincian per-anggota akan dihitung ulang berbasis nominal ini.
            </Text>

            <Text style={styles.modalLabel}>Nominal Disahkan RAT (Rp) *</Text>
            <CurrencyInput value={nominal} onChangeValue={setNominal} />

            <Text style={styles.modalLabel}>Catatan Keputusan RAT</Text>
            <FocusTextInput
              style={[styles.modalInput, styles.modalTextArea]}
              value={catatan}
              onChangeText={setCatatan}
              multiline
              placeholder="Opsional"
              placeholderTextColor={colors.placeholder}
            />

            {error && <Text style={styles.ratWarnText}>{error}</Text>}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={onClose}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSubmitBtn} onPress={submit}>
                <Text style={styles.modalSubmitText}>Sahkan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>
  );
}

const STATUS_LABEL: Record<ShuKonfigurasiRow['status'], string> = {
  DRAFT: 'Draft',
  DIHITUNG: 'Sudah Dihitung (Informasi RAT tersedia)',
  DIAJUKAN_RAT: 'Diajukan ke RAT',
  DISAHKAN_RAT: 'Disahkan RAT (Siap Dibagikan)',
  DIBAGIKAN: 'Sudah Dibagikan',
};

/** Revisi UI/UX §11: badge status konsisten — palet SAMA dengan ShuScreen.tsx (daftar riwayat SHU). */
const STATUS_STYLE: Record<ShuKonfigurasiRow['status'], { bg: string; fg: string }> = {
  DRAFT: { bg: '#F0F0F0', fg: colors.textMuted },
  DIHITUNG: { bg: '#FFF3E0', fg: colors.warning },
  DIAJUKAN_RAT: { bg: '#E3F2FD', fg: '#1565C0' },
  DISAHKAN_RAT: { bg: '#E8F5E9', fg: '#2E7D32' },
  DIBAGIKAN: { bg: colors.primaryLight, fg: colors.primary },
};

function cadangan(k: ShuKonfigurasiRow, jasaModalDistribusiValue: number, jasaUsahaDistribusiValue: number): number {
  // Audit ulang §7/§11/§13/§16 (permintaan pengguna): Cadangan Umum
  // ditampilkan sebagai RESIDUAL (Total SHU dikurangi Jasa Modal & Jasa
  // Usaha yang BENAR-BENAR terdistribusi ke anggota, dikurangi Cadangan
  // Risiko — pool TETAP, bukan residual — dan 6 dana Pendidikan/Sosial/
  // Pengurus/Pengawas/Karyawan/Pembangunan Daerah Kerja) — pola yang
  // SAMA PERSIS dengan `hitungRingkasanSHU()` (ShuCalculator.ts) dan
  // `bagikanSHU()` (ShuService.ts), supaya breakdown yang ditampilkan
  // di layar ini SELALU rekonsiliasi 100% ke Total SHU dan SELALU sama
  // dengan nominal yang benar-benar dijurnal saat dibagikan — termasuk
  // pada kasus basis anggota 0 (pool Jasa Modal/Jasa Usaha tidak
  // terbagi habis). Cadangan Risiko TIDAK ikut menyerap residual —
  // nilainya SELALU murni persentase × totalSHU (lihat pemanggilan
  // `pool()` langsung untuk baris Cadangan Risiko di JSX di atas).
  const totalShu = k.totalShu ?? 0;
  const poolDana = sumPools([
    pool(k.totalShu, k.persenCadanganRisiko),
    pool(k.totalShu, k.persenPendidikan),
    pool(k.totalShu, k.persenSosial),
    pool(k.totalShu, k.persenPengurus),
    pool(k.totalShu, k.persenPengawas),
    pool(k.totalShu, k.persenKaryawan),
    pool(k.totalShu, k.persenPembangunanDaerahKerja),
  ]);
  return totalShu - jasaModalDistribusiValue - jasaUsahaDistribusiValue - poolDana;
}
function jasaModalDistribusi(list: ShuAnggotaRow[]): number {
  return list.reduce((acc, a) => acc + a.jasaModal, 0);
}
function jasaUsahaDistribusi(list: ShuAnggotaRow[]): number {
  return list.reduce((acc, a) => acc + a.jasaUsaha, 0);
}
function pool(totalShu: number | null, persen: number): number {
  return Math.round(((totalShu ?? 0) * persen) / 100);
}
function sumPools(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function Row({ label, persen, nominal }: { label: string; persen: number; nominal: number }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>
        {label} ({persen}%)
      </Text>
      <Text style={styles.rowValue}>{formatRupiah(nominal)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.lg, lineHeight: 18 },
  notFoundButton: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  notFoundButtonText: { color: colors.text, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  totalShu: { fontSize: 26, fontWeight: '700', color: colors.primary, marginTop: 4, marginBottom: 4 },
  totalShuLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.3, marginTop: spacing.sm },
  negative: { color: colors.danger },
  warnText: { fontSize: 12, color: colors.danger, marginBottom: spacing.md },
  reconcileNote: { fontSize: 11, color: colors.textMuted, marginTop: -8, marginBottom: spacing.md, lineHeight: 16 },
  // Audit ulang (permintaan pengguna, request baru §10): panel
  // "Informasi SHU RAT" — ringkasan akrual vs kas vs keputusan RAT.
  ratInfoPanel: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  ratInfoPanelTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  ratInfoPanelSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm, lineHeight: 16 },
  ratInfoPanelDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  ratInfoPanelCatatan: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, fontStyle: 'italic' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  summaryLabel: { fontSize: 13, color: colors.textMuted },
  summaryValue: { fontSize: 13, color: colors.text, fontWeight: '600' },
  summaryLabelBold: { color: colors.text, fontWeight: '700' },
  summaryValueBold: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  card: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { fontSize: 13, color: colors.textMuted },
  rowValue: { fontSize: 13, color: colors.text, fontWeight: '600' },
  // Tombol "Bagikan SHU" = aksi UTAMA (satu-satunya yang aktif setelah
  // RAT selesai) — full-width, warna primer, paling menonjol. Sesuai
  // pola hierarki tombol yang sama dipakai di seluruh layar lain
  // (bandingkan SaldoAwalAkunListScreen: satu tombol primer penuh,
  // bukan berjejer dengan tombol lain yang levelnya berbeda).
  bagikanButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  bagikanButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  // Audit ulang §7: tombol "Bagikan SHU" nonaktif (abu-abu) + alasan —
  // ditampilkan SELAMA status belum DISAHKAN_RAT, sesuai permintaan
  // eksplisit ("tombol harus disabled atau tidak tersedia... tampilkan
  // alasan").
  bagikanButtonDisabled: { backgroundColor: colors.border },
  disabledReasonText: { fontSize: 12, color: colors.danger, textAlign: 'center', marginTop: -8, marginBottom: spacing.md },
  ratButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  ratButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  ratButtonOutline: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  ratButtonOutlineText: { color: colors.warning, fontWeight: '700', fontSize: 13 },
  ratWarnBox: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  ratWarnText: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  ratInfoBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  ratInfoText: { color: colors.primary, fontSize: 12, flex: 1 },
  ratEditLink: { color: colors.primary, fontSize: 12, fontWeight: '700', marginLeft: spacing.sm, textDecorationLine: 'underline' },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSub: { ...modalUi.description },
  modalLabel: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.sm },
  modalCatatan: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.xs },
  modalInput: { ...formUi.inputStandalone },
  modalTextArea: { ...formUi.inputStandaloneMultiline },
  modalActions: { ...modalUi.actions, marginTop: spacing.lg },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.primaryButton },
  modalSubmitText: { ...modalUi.primaryText },
  disabled: { opacity: 0.6 },
  sectionLabel: { fontSize: 14, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  anggotaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  anggotaNama: { fontSize: 14, fontWeight: '600', color: colors.text },
  anggotaSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  anggotaNominal: { fontSize: 14, fontWeight: '700', color: colors.primary },
});
