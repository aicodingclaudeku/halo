import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet, RefreshControl, TouchableOpacity, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listAsetDenganNilaiBuku, hapusAset, AsetDenganNilaiBukuItem } from '@/services/AsetService';
import { listRingkasanPenyusutanAset, RingkasanAsetPenyusutan } from '@/services/PenyusutanService';
import RingkasanPenyusutanAsetList from './RingkasanPenyusutanAsetList';
import {
  lepaskanAsetTetap,
  pratinjauPelepasanAsetTetap,
  PratinjauPelepasanAsetTetap,
  PelepasanAsetTetapInput,
} from '@/services/PelepasanAsetTetapService';
import RekeningPicker from '@/components/RekeningPicker';
import FocusTextInput from '@/components/FocusTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { colors, elevation, iconSize, radius, spacing, touchTarget } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { ui, menuIconSize } from '@/theme/ui';

/**
 * "Daftar Aset Tetap" (F2, hub "Rincian Laporan Lainnya") — sumber data
 * `AsetService.listAsetDenganNilaiBuku()` (akumulasi penyusutan/
 * amortisasi & nilai buku, sudah ada sejak sebelumnya untuk layar
 * lain). Kelompok/Sub Kelompok tampil "Belum Diklasifikasikan" untuk
 * aset lama yang belum diberi klasifikasi — tidak ada data yang
 * disembunyikan/hilang.
 *
 * Permintaan pengguna §10/§11: `AsetDetailScreen` DIHAPUS dari alur —
 * Edit & Delete (yang sebelumnya hanya ada di sana) SEKARANG langsung
 * tersedia di sini per baris (pola sama dengan DaftarInvestasiScreen).
 * Edit -> `AsetEditFormScreen` (field yang sudah pernah disusutkan
 * otomatis terkunci, TIDAK ADA logic edit kedua). Delete memakai
 * `AsetService.hapusAset()` yang SAMA — reversal jurnal kalau aset
 * belum pernah disusutkan, atau soft-deactivate (status DIHAPUS) kalau
 * sudah ada histori penyusutan/amortisasi — TIDAK PERNAH hard-delete.
 * Alasan penghapusan WAJIB diisi & dicatat sebagai audit trail lewat
 * `hapusAset()` (userId + timestamp otomatis, pola sama pencairan
 * investasi §6).
 */
export default function DaftarAsetTetapScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEdit = can('kas_bank', 'edit');

  const [data, setData] = useState<AsetDenganNilaiBukuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hapusTarget, setHapusTarget] = useState<AsetDenganNilaiBukuItem | null>(null);
  const [alasanHapus, setAlasanHapus] = useState('');
  const [processing, setProcessing] = useState(false);

  // RC-S54 POST-CLOSURE #7 — ringkasan penyusutan per aset dari service existing
  // (`listRingkasanPenyusutanAset`), dirender komponen bersama yang sama dengan
  // layar Status Periode. Tidak ada perhitungan penyusutan baru di layar ini.
  const [ringkasanPenyusutan, setRingkasanPenyusutan] = useState<RingkasanAsetPenyusutan[]>([]);
  const [tampilkanPenyusutan, setTampilkanPenyusutan] = useState(false);

  // RC-S54 T16 GAP 6 — PELEPASAN_ASET_TETAP: alur terpisah dari koreksi salah input.
  // Hasil & rekening awal KOSONG (hasil tidak pernah diisi dari biaya perolehan);
  // konfirmasi hanya dengan pratinjau terbaru untuk input yang sama persis.
  const [lepasTarget, setLepasTarget] = useState<AsetDenganNilaiBukuItem | null>(null);
  const [lepasTanggal, setLepasTanggal] = useState(getTanggalLokalHariIni());
  const [lepasHasil, setLepasHasil] = useState('');
  const [lepasRekening, setLepasRekening] = useState<RekeningItem | null>(null);
  const [pratinjau, setPratinjau] = useState<PratinjauPelepasanAsetTetap | null>(null);
  const [pratinjauError, setPratinjauError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [aset, ringkasan] = await Promise.all([listAsetDenganNilaiBuku(), listRingkasanPenyusutanAset()]);
      setData(aset);
      setRingkasanPenyusutan(ringkasan);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar aset tetap.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => load(false));
    return unsub;
  }, [navigation, load]);

  // Bug fix (crash di FlatList.renderItem): aset lama/data korup bisa
  // menyimpan nilai numerik sebagai null/undefined/NaN di kolom
  // `nilai_perolehan`, `nilai_residu`, dsb. Sebelumnya nilai itu
  // dipakai langsung dalam operasi aritmatika (mis. `acc + d.nilaiPerolehan`)
  // — kalau salah satu NaN/undefined, hasil totalnya ikut rusak (NaN
  // menjalar ke seluruh total). `angka()` memaksa nilai jadi 0 kalau
  // bukan angka valid, TANPA mengubah data yang tersimpan di DB.
  const angka = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const totalPerolehan = data.reduce((acc, d) => acc + angka(d?.nilaiPerolehan), 0);
  const totalAkumulasi = data.reduce((acc, d) => acc + angka(d?.akumulasiPenyusutan), 0);
  const totalNilaiBuku = data.reduce((acc, d) => acc + angka(d?.nilaiBuku), 0);

  const pesanPengguna = (e: unknown, cadangan: string) => (e instanceof Error ? e.message : cadangan).replace(/^[A-Z][A-Z0-9_]+:\s*/, '');
  const angkaHasil = lepasHasil.replace(/[^0-9]/g, '');
  const hasilPositif = angkaHasil !== '' && Number(angkaHasil) > 0;
  const inputLepasValid =
    !!lepasTarget && !!currentUser && angkaHasil !== '' && /^\d{4}-\d{2}-\d{2}$/.test(lepasTanggal.trim()) && (!hasilPositif || !!lepasRekening);
  const statusValidasi = pratinjau
    ? 'Valid — pratinjau sesuai input, siap dikonfirmasi.'
    : pratinjauError ?? (inputLepasValid ? 'Belum divalidasi — jalankan Hitung Pratinjau.' : 'Lengkapi tanggal, hasil pelepasan (boleh 0), dan rekening bila hasil > 0.');
  const batalkanPratinjau = () => {
    setPratinjau(null);
    setPratinjauError(null);
  };

  const bukaPelepasan = (item: AsetDenganNilaiBukuItem) => {
    setLepasTarget(item);
    setLepasTanggal(getTanggalLokalHariIni());
    setLepasHasil('');
    setLepasRekening(null);
    batalkanPratinjau();
  };

  const inputPelepasan = (): PelepasanAsetTetapInput | null => {
    if (!inputLepasValid || !lepasTarget || !currentUser) return null;
    const hasil = Number(angkaHasil);
    return {
      asetId: lepasTarget.id,
      tanggalPelepasan: lepasTanggal.trim(),
      hasilPelepasan: hasil,
      sumberDana: hasil > 0 && lepasRekening ? (lepasRekening.jenis === 'BANK' ? 'BANK' : 'KAS') : undefined,
      bankAccountId: hasil > 0 && lepasRekening?.jenis === 'BANK' ? lepasRekening.id : undefined,
      createdBy: currentUser.id,
    };
  };

  const hitungPratinjau = async () => {
    const input = inputPelepasan();
    batalkanPratinjau();
    if (!input) return;
    try {
      setPratinjau(await pratinjauPelepasanAsetTetap(input));
    } catch (e) {
      setPratinjauError(pesanPengguna(e, 'Pratinjau gagal.'));
    }
  };

  const konfirmasiPelepasan = async () => {
    const input = inputPelepasan();
    if (!input || !pratinjau) return;
    setProcessing(true);
    try {
      const { pratinjau: hasil } = await lepaskanAsetTetap(input);
      batalkanPratinjau();
      setLepasTarget(null);
      await load();
      notify(
        'Berhasil',
        `Pelepasan aset dicatat. Hasil ${formatRupiah(hasil.hasilPelepasan)}, nilai buku ${formatRupiah(hasil.nilaiBuku)}, ` +
          `${hasil.jenisSelisih === 'LABA' ? `laba ${formatRupiah(hasil.selisih)}` : hasil.jenisSelisih === 'RUGI' ? `rugi ${formatRupiah(-hasil.selisih)}` : 'impas'}.`
      );
    } catch (e) {
      batalkanPratinjau();
      notify('Gagal', pesanPengguna(e, 'Terjadi kesalahan.'));
    } finally {
      setProcessing(false);
    }
  };

  const submitHapus = async () => {
    if (!hapusTarget || !currentUser || !alasanHapus.trim()) return;
    setProcessing(true);
    try {
      const { direversal } = await hapusAset({ id: hapusTarget.id, alasan: alasanHapus.trim(), actingUserId: currentUser.id });
      setHapusTarget(null);
      setAlasanHapus('');
      await load();
      notify(
        'Berhasil',
        direversal
          ? 'Koreksi salah input dicatat: jurnal pembelian dibatalkan (reversal).'
          : 'Koreksi salah input dicatat (aset tanpa jurnal perolehan).'
      );
    } catch (e) {
      notify('Gagal', pesanPengguna(e, 'Terjadi kesalahan.'));
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

  return (
    <>
    <FlatList keyboardShouldPersistTaps="handled"
      style={styles.container}
      data={data}
      keyExtractor={(item, index) => item?.id ?? `aset-${index}`}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      ListHeaderComponent={
        <>
          {/* UI/UX POLISH — judul layar ada di header native (RootNavigator:
              "Daftar Aset Tetap & Penyusutan"); di sini hanya subjudul ringkas,
              tanpa judul kedua supaya tidak ada header ganda. */}
          <Text style={styles.screenSubtitle}>Kelola aset, nilai buku, dan informasi penyusutan</Text>

          {/* RC-S54 POST-CLOSURE #7 — bagian penyusutan yang dulu berdiri sendiri
              di menu "Penyusutan Aset": ringkasan penyusutan per aset + pintu ke
              status/proses periode. Data & komponen existing, tanpa perhitungan baru.
              UI/UX POLISH — total (angka existing) dan ringkasan per aset disatukan
              dalam SATU section ber-ikon; angka & sumbernya tidak diubah. */}
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <Ionicons name="analytics-outline" size={menuIconSize} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Ringkasan Penyusutan Aset</Text>
                <Text style={styles.sectionSub}>Ringkasan biaya perolehan, akumulasi penyusutan, dan nilai buku</Text>
              </View>
            </View>

            {data.length > 0 ? (
              <View style={styles.totalBox}>
                <Row label="Total Nilai Perolehan" value={formatRupiah(totalPerolehan)} />
                <Row label="Total Akumulasi Penyusutan/Amortisasi" value={`(${formatRupiah(totalAkumulasi)})`} muted />
                <View style={styles.totalDivider} />
                <Row label="Total Nilai Buku" value={formatRupiah(totalNilaiBuku)} bold />
              </View>
            ) : null}

            <TouchableOpacity
              style={styles.toggleRow}
              accessibilityRole="button"
              accessibilityState={{ expanded: tampilkanPenyusutan }}
              onPress={() => setTampilkanPenyusutan((v) => !v)}
            >
              <Text style={styles.toggleText}>Rincian per aset</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{ringkasanPenyusutan.length}</Text>
              </View>
              <Ionicons name={tampilkanPenyusutan ? 'chevron-up-outline' : 'chevron-down-outline'} size={iconSize.sm} color={colors.primary} />
            </TouchableOpacity>
            {tampilkanPenyusutan &&
              (ringkasanPenyusutan.length === 0 ? (
                <Text style={styles.emptyText}>Belum ada penyusutan yang tercatat.</Text>
              ) : (
                <RingkasanPenyusutanAsetList data={ringkasanPenyusutan} />
              ))}
          </View>

          <TouchableOpacity style={styles.navCard} accessibilityRole="button" accessibilityLabel="Status dan Proses Penyusutan" onPress={() => navigation.navigate('StatusPeriode')}>
            <View style={styles.sectionIcon}>
              <Ionicons name="calendar-outline" size={menuIconSize} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>Status &amp; Proses Penyusutan</Text>
              <Text style={styles.sectionSub}>Lihat status periode dan proses penyusutan</Text>
            </View>
            <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
          </TouchableOpacity>

          {data.length > 0 ? <Text style={styles.listLabel}>Daftar Aset ({data.length})</Text> : null}
        </>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <View style={styles.emptyWrap}>
              <Ionicons name="business-outline" size={iconSize.xl} color={colors.textFaint} />
              <Text style={styles.emptyTitle}>Belum ada aset tetap</Text>
              <Text style={styles.emptyText}>Belum ada aset tetap yang dicatat.</Text>
            </View>
          )}
        </View>
      }
      renderItem={({ item }) => {
        // Bug fix (crash di FlatList.renderItem): jaga-jaga kalau ada
        // entri null/undefined di array data (mis. hasil query yang
        // tidak terduga) — sebelumnya `item.status`, `item.nomorAset`,
        // dst langsung diakses tanpa cek, yang akan melempar
        // "Cannot read property of undefined" dan menjatuhkan seluruh
        // layar. Baris ini TIDAK mengubah data apa pun, hanya
        // melewati baris yang memang tidak valid untuk dirender.
        if (!item) return null;

        const asetId: string | undefined = item.id;
        const punyaIdValid = typeof asetId === 'string' && asetId.length > 0;

        return (
          <View style={[styles.card, item.status === 'DIHAPUS' && styles.cardNonaktif]}>
            <View style={styles.cardHeader}>
              <Text style={styles.nomor}>{item.nomorAset ?? '-'}</Text>
              <Text style={styles.klasifikasi}>
                {item.kelompokAset ?? 'Belum Diklasifikasikan'}
                {item.subKelompokAset ? ` · ${item.subKelompokAset}` : ''}
              </Text>
            </View>
            <Text style={styles.namaAset}>{item.namaAset ?? '(Tanpa nama)'}</Text>
            {item.status === 'DIHAPUS' && <Text style={styles.statusNonaktif}>NONAKTIF / DIHAPUS</Text>}

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Tanggal Perolehan</Text>
              <Text style={styles.rowValue}>{item.tanggalPerolehan ?? '-'}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Nilai Perolehan</Text>
              <Text style={styles.rowValue}>{formatRupiah(angka(item.nilaiPerolehan))}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Masa Manfaat</Text>
              <Text style={styles.rowValue}>{item.masaManfaatBulan ?? '-'} bulan</Text>
            </View>
            {/* RC-S54 item 7 — nilai residu & penyusutan per bulan.
                Keduanya DIAMBIL dari service; nol rumus penyusutan di
                layar ini. `penyusutanPerBulan` berasal dari
                `hitungPenyusutanBulanan()`, mesin yang sama yang dipakai
                saat menjurnal penyusutan. */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Nilai Residu</Text>
              <Text style={styles.rowValue}>{formatRupiah(angka(item.nilaiResidu))}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                {item.jenisAset === 'TAK_BERWUJUD' ? 'Amortisasi per Bulan' : 'Penyusutan per Bulan'}
              </Text>
              <Text style={styles.rowValue}>{formatRupiah(angka(item.penyusutanPerBulan))}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                {item.jenisAset === 'TAK_BERWUJUD' ? 'Akumulasi Amortisasi' : 'Akumulasi Penyusutan'}
              </Text>
              <Text style={styles.rowValueDanger}>({formatRupiah(angka(item.akumulasiPenyusutan))})</Text>
            </View>
            <View style={[styles.row, styles.rowNilaiBuku]}>
              <Text style={styles.rowLabelBold}>Nilai Buku</Text>
              <Text style={styles.rowValueBold}>{formatRupiah(angka(item.nilaiBuku))}</Text>
            </View>

            {canEdit && item.status === 'AKTIF' && (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  hitSlop={HIT_SLOP}
                  style={[styles.actionBtn, !punyaIdValid && styles.disabled]}
                  disabled={!punyaIdValid}
                  onPress={() => {
                    // Bug fix (§2): jangan pernah membuka form edit
                    // dengan asetId kosong/undefined — sebelumnya tombol
                    // ini selalu aktif & langsung navigate meskipun
                    // `item.id` tidak valid, yang membuat AsetEditFormScreen
                    // menerima `asetId` undefined lalu gagal memuat data.
                    if (!punyaIdValid) {
                      notify('Gagal', 'Data aset ini tidak memiliki ID yang valid sehingga tidak dapat dibuka untuk diedit.');
                      return;
                    }
                    navigation.navigate('AsetEditForm', { asetId });
                  }}
                >
                  <Ionicons name="create-outline" size={iconSize.sm} color={colors.primary} />
                  <Text style={styles.actionText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  hitSlop={HIT_SLOP}
                  style={[styles.actionBtn, styles.actionBtnDanger]}
                  onPress={() => {
                    setHapusTarget(item);
                    setAlasanHapus('');
                  }}
                >
                  <Ionicons name="return-down-back-outline" size={iconSize.sm} color={colors.danger} />
                  <Text style={[styles.actionText, { color: colors.danger }]}>Koreksi Salah Input</Text>
                </TouchableOpacity>
                <TouchableOpacity hitSlop={HIT_SLOP} style={styles.actionBtn} onPress={() => bukaPelepasan(item)}>
                  <Ionicons name="swap-horizontal-outline" size={iconSize.sm} color={colors.primary} />
                  <Text style={styles.actionText}>Pelepasan</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      }}
    />

    <Modal visible={!!hapusTarget} transparent animationType="fade" onRequestClose={() => setHapusTarget(null)}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Koreksi Salah Input Aset</Text>
          <Text style={styles.modalSub}>
            Hanya untuk pembelian yang SALAH INPUT dan belum pernah disusutkan/diamortisasi: jurnal pembelian dibatalkan (reversal).
            Bukan penjualan dan tanpa laba/rugi. Aset yang sudah disusutkan ditolak — gunakan tombol "Pelepasan" bila aset benar-benar dijual/dibuang.
          </Text>
          <FocusTextInput
            style={styles.modalInput}
            value={alasanHapus}
            onChangeText={setAlasanHapus}
            placeholder="Alasan koreksi (wajib diisi)"
            placeholderTextColor={colors.placeholder}
            multiline
          />
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setHapusTarget(null)}>
              <Text style={styles.modalCancelText}>Tutup</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalSubmitBtn, (!alasanHapus.trim() || processing) && styles.disabled]}
              onPress={submitHapus}
              disabled={!alasanHapus.trim() || processing}
            >
              {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Koreksi</Text>}
            </TouchableOpacity>
          </View>
        </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>

    <Modal visible={!!lepasTarget} transparent animationType="fade" onRequestClose={() => setLepasTarget(null)}>
      <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Pelepasan Aset Tetap</Text>
          <Text style={styles.modalSub}>
            Dicatat sebagai transaksi baru pada tanggal pelepasan: biaya dan akumulasi penyusutan aset ini dikeluarkan,
            laba/rugi = Hasil Pelepasan − Nilai Buku.
          </Text>
          <View style={styles.row}><Text style={styles.rowLabel}>Nama Aset</Text><Text style={styles.rowValue}>{lepasTarget?.namaAset}</Text></View>
          <View style={styles.row}><Text style={styles.rowLabel}>Nomor Aset</Text><Text style={styles.rowValue}>{lepasTarget?.nomorAset}</Text></View>
          <View style={styles.row}><Text style={styles.rowLabel}>Tanggal Perolehan</Text><Text style={styles.rowValue}>{lepasTarget?.tanggalPerolehan}</Text></View>
          <Text style={styles.rowLabel}>Tanggal Pelepasan (YYYY-MM-DD)</Text>
          <FocusTextInput
            style={styles.modalInputSingle}
            value={lepasTanggal}
            onChangeText={(t) => { setLepasTanggal(t); batalkanPratinjau(); }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.placeholder}
          />
          <Text style={styles.rowLabel}>Hasil Pelepasan (Rp, wajib diisi, boleh 0)</Text>
          <FocusTextInput
            style={styles.modalInputSingle}
            value={lepasHasil}
            onChangeText={(t) => {
              setLepasHasil(t);
              batalkanPratinjau();
              if (!(Number(t.replace(/[^0-9]/g, '')) > 0)) setLepasRekening(null);
            }}
            keyboardType="number-pad"
            placeholder="Nilai yang benar-benar diterima"
            placeholderTextColor={colors.placeholder}
          />
          {hasilPositif && (
            <RekeningPicker label="Rekening Kas/Bank (wajib bila hasil > 0)" value={lepasRekening} onChange={(r) => { setLepasRekening(r); batalkanPratinjau(); }} />
          )}
          <TouchableOpacity
            style={[styles.modalCancelBtn, { marginTop: spacing.sm }, !inputLepasValid && styles.disabled]}
            onPress={hitungPratinjau}
            disabled={!inputLepasValid}
          >
            <Text style={styles.modalCancelText}>Hitung Pratinjau</Text>
          </TouchableOpacity>
          <Text style={pratinjau ? styles.rowLabel : styles.errorText}>Status validasi: {statusValidasi}</Text>
          {pratinjau && (
            <View style={{ marginTop: spacing.sm }}>
              <View style={styles.row}><Text style={styles.rowLabel}>Biaya Perolehan</Text><Text style={styles.rowValue}>{formatRupiah(pratinjau.biayaPerolehan)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Akumulasi Penyusutan</Text><Text style={styles.rowValue}>{formatRupiah(pratinjau.akumulasiPenyusutan)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Nilai Buku</Text><Text style={styles.rowValue}>{formatRupiah(pratinjau.nilaiBuku)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Hasil Pelepasan</Text><Text style={styles.rowValue}>{formatRupiah(pratinjau.hasilPelepasan)}</Text></View>
              <View style={styles.row}><Text style={styles.rowLabel}>Rekening Kas/Bank</Text><Text style={styles.rowValue}>{pratinjau.hasilPelepasan > 0 ? lepasRekening?.nama ?? '-' : 'Tidak ada (hasil 0)'}</Text></View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Laba/Rugi Pelepasan</Text>
                <Text style={styles.rowValue}>
                  {pratinjau.jenisSelisih === 'LABA'
                    ? `Laba ${formatRupiah(pratinjau.selisih)}`
                    : pratinjau.jenisSelisih === 'RUGI'
                      ? `Rugi ${formatRupiah(-pratinjau.selisih)}`
                      : 'Impas'}
                </Text>
              </View>
            </View>
          )}
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setLepasTarget(null)}>
              <Text style={styles.modalCancelText}>Tutup</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalSubmitBtn, (!pratinjau || processing) && styles.disabled]}
              onPress={konfirmasiPelepasan}
              disabled={!pratinjau || processing}
            >
              {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Konfirmasi Pelepasan</Text>}
            </TouchableOpacity>
          </View>
        </View>
        </ScrollView>
      </AreaAmanKeyboard>
    </Modal>
    </>
  );
}

/** UI/UX POLISH — perluasan area sentuh tombol aksi kartu (±44 dp) tanpa menambah tinggi kartu. */
const HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalRowLabel, muted && styles.totalRowLabelMuted]}>{label}</Text>
      <Text style={[styles.totalRowValue, bold && styles.totalRowValueBold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  screenSubtitle: { ...ui.screenIntro },
  sectionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sectionIcon: { ...ui.menuIcon },
  sectionTitle: { ...ui.menuTitle, fontWeight: '700' },
  sectionSub: { ...ui.menuSub },
  totalBox: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  toggleText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.primary },
  countBadge: {
    minWidth: 24,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  navCard: { ...ui.menuCard, marginBottom: spacing.lg },
  listLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: spacing.sm },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 3 },
  totalRowLabel: { fontSize: 12, color: colors.text, flexShrink: 1 },
  totalRowLabelMuted: { color: colors.textMuted },
  totalRowValue: { fontSize: 12, color: colors.text },
  totalRowValueBold: { fontSize: 15, fontWeight: '700', color: colors.primary },
  totalDivider: { height: 1, backgroundColor: colors.border, marginVertical: 6 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...elevation.card,
  },
  cardNonaktif: { opacity: 0.55 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  nomor: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  klasifikasi: { fontSize: 11, color: colors.primary, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  namaAset: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 6 },
  statusNonaktif: { fontSize: 11, fontWeight: '700', color: colors.danger, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 2 },
  rowLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  rowValue: { fontSize: 12, color: colors.text, textAlign: 'right', flexShrink: 1 },
  rowValueDanger: { fontSize: 12, color: colors.danger },
  rowNilaiBuku: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingTop: 6 },
  rowLabelBold: { fontSize: 13, fontWeight: '700', color: colors.text },
  rowValueBold: { fontSize: 13, fontWeight: '700', color: colors.primary },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionBtnDanger: { borderColor: colors.dangerBg, backgroundColor: colors.dangerBg },
  emptyWrap: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  actionText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSub: { ...modalUi.description },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  // INPUT STANDARDIZATION — isian SATU BARIS di modal (tanggal, hasil
  // pelepasan) sebelumnya ikut memakai `modalInput` multiline, sehingga
  // kotak tanggal setinggi 88 dp dengan teks rata atas.
  modalInputSingle: { ...formUi.inputStandalone },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.destructiveButton },
  modalSubmitText: { ...modalUi.primaryText },
  disabled: { opacity: 0.6 },
});
