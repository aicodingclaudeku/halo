import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, FlatList, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AnggotaPiutangPicker from '@/components/AnggotaPiutangPicker';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import { RekeningItem } from '@/services/KasBankService';
import { getDb } from '@/database/db';
import {
  listPinjaman,
  getJadwalAngsuran,
  bayarAngsuran,
  hitungTotalPelunasan,
  lunasiPinjaman,
  PinjamanListItem,
  JadwalAngsuranItem,
  AnggotaPiutangItem,
  RincianPelunasan,
  terapkanBiayaTambahanPelunasan,
  MetodeJasaPelunasan,
} from '@/services/PinjamanService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

type JenisPembayaran = 'ANGSURAN' | 'PELUNASAN';

/** REQUIREMENT 8 — referensi stabil; `() => {}` inline akan berbeda tiap render dan memicu render ulang input tanpa perlu. */
const noop = () => {};

/**
 * Sub-fitur "Bayar Piutang Anggota" (menu Penerimaan) — sebelumnya
 * pembayaran angsuran pinjaman HANYA bisa dilakukan lewat modal di
 * dalam PinjamanDetailScreen (menu Pengeluaran > Pemberian Pinjaman
 * untuk Anggota > pilih pinjaman > pilih jadwal), padahal ini jelas
 * transaksi PENERIMAAN kas (uang MASUK dari anggota melunasi
 * piutangnya), bukan pengeluaran — sehingga akhirnya bergabung dengan
 * form Setor/Tarik Simpanan yang salah kaprah. Sekarang jadi entry
 * point sendiri di menu Penerimaan, tetap memanggil bayarAngsuran()
 * yang sama persis (tidak ada logika/jurnal baru) — modal di
 * PinjamanDetailScreen TETAP ada juga untuk kenyamanan saat sedang
 * melihat detail satu pinjaman.
 *
 * Picker anggota di sini SENGAJA memakai `AnggotaPiutangPicker` (BUKAN
 * `AnggotaPicker` generik) — hanya menampilkan anggota yang BENAR-
 * BENAR punya piutang pinjaman outstanding (sisa piutang > 0, dihitung
 * dari jadwal angsuran, bukan cuma status pinjaman) — supaya staf
 * tidak perlu mencari-cari di antara semua anggota koperasi, dan tidak
 * bisa memilih anggota yang pinjamannya sudah lunas/belum pernah
 * pinjam. Lihat PinjamanService.listAnggotaDenganPiutangAktif.
 *
 * Update pasca-6-perbaikan (permintaan pengguna §6): "Jenis
 * Pembayaran" — Angsuran (perilaku existing, TIDAK berubah sama
 * sekali) atau Pelunasan (BARU — melunasi SELURUH sisa kewajiban
 * pinjaman dalam SATU transaksi, lewat `PinjamanService.lunasiPinjaman()`).
 * Rincian pelunasan (pokok/jasa/denda/total) dihitung lewat
 * `hitungTotalPelunasan()` — SATU sumber kebenaran yang sama dipakai
 * preview di layar ini MAUPUN transaksi sungguhan di service, supaya
 * angka yang ditampilkan & yang ditagih selalu identik.
 */
export default function BayarAngsuranFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [anggota, setAnggota] = useState<AnggotaPiutangItem | null>(null);
  const [pinjamanList, setPinjamanList] = useState<PinjamanListItem[]>([]);
  const [pinjaman, setPinjaman] = useState<PinjamanListItem | null>(null);
  const [jadwal, setJadwal] = useState<JadwalAngsuranItem[]>([]);
  const [jadwalTerpilih, setJadwalTerpilih] = useState<JadwalAngsuranItem | null>(null);
  const [pinjamanModalOpen, setPinjamanModalOpen] = useState(false);

  const [jenisPembayaran, setJenisPembayaran] = useState<JenisPembayaran>('ANGSURAN');
  /**
   * REQUIREMENT 8 — ROOT CAUSE FIX.
   *
   * Sebelumnya SATU state `rincianPelunasan` diisi ulang lewat query
   * database setiap kali `penaltiPelunasan`/`administrasiPelunasan`
   * berubah (dua-duanya ada di dependency array useEffect), dan efek itu
   * menyalakan `loadingRincian` yang MENGGANTI seluruh kartu pelunasan
   * dengan <ActivityIndicator/>. Karena kedua <CurrencyInput/> berada DI
   * DALAM kartu itu, setiap ketukan tombol meng-UNMOUNT input yang
   * sedang diketik lalu me-mount ulang: fokus hilang, keyboard tertutup,
   * kursor lompat, isian tampak ter-reset.
   *
   * Perbaikannya STRUKTURAL, bukan delay/setTimeout:
   *  1. `rincianBase` = hasil query database, HANYA dimuat ulang saat
   *     sesuatu yang memang berasal dari database berubah (pinjaman,
   *     tanggal, metode jasa) — BUKAN saat mengetik biaya.
   *  2. Total final diturunkan secara sinkron lewat useMemo memakai
   *     `terapkanBiayaTambahanPelunasan()` — fungsi MURNI yang sama
   *     persis dipakai backend, jadi tidak ada rumus kedua.
   *  3. Kedua input dirender TANPA SYARAT selama mode Pelunasan aktif —
   *     spinner tidak pernah lagi menggantikannya (lihat JSX di bawah),
   *     sehingga komponennya tidak pernah di-unmount saat mengetik.
   */
  const [rincianBase, setRincianBase] = useState<RincianPelunasan | null>(null);
  const [loadingRincian, setLoadingRincian] = useState(false);
  // PHASE 4 (§A, permintaan pengguna): biaya penalti & administrasi
  // pelunasan dipercepat — string kosong berarti "tidak diisi" (0),
  // konsisten dengan pola `nominal` di form ini.
  const [penaltiPelunasan, setPenaltiPelunasan] = useState<number | ''>('');
  const [administrasiPelunasan, setAdministrasiPelunasan] = useState<number | ''>('');
  // REQUIREMENT 9 (permintaan pengguna): metode perhitungan jasa saat
  // pelunasan. Default 'JASA_KONTRAKTUAL' = perilaku aplikasi sebelum
  // requirement ini (menagih seluruh sisa jasa sesuai kontrak).
  const [metodeJasaPelunasan, setMetodeJasaPelunasan] = useState<MetodeJasaPelunasan>('JASA_KONTRAKTUAL');

  /**
   * REQUIREMENT 8/9 — rincian final = rincian dari database + biaya
   * tambahan, dihitung SINKRON (tanpa await, tanpa state baru, tanpa
   * remount). Nilai inilah yang ditampilkan & dikonfirmasi ke petugas.
   */
  const rincianPelunasan = useMemo<RincianPelunasan | null>(() => {
    if (!rincianBase) return null;
    try {
      return terapkanBiayaTambahanPelunasan(
        rincianBase,
        penaltiPelunasan === '' ? 0 : penaltiPelunasan,
        administrasiPelunasan === '' ? 0 : administrasiPelunasan
      );
    } catch {
      // Nilai tidak valid (mis. desimal) — tampilkan rincian dasar apa
      // adanya; validasi sesungguhnya tetap dijalankan backend saat
      // submit, jadi tidak ada yang bisa lolos dari sini.
      return rincianBase;
    }
  }, [rincianBase, penaltiPelunasan, administrasiPelunasan]);

  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [loadingJadwal, setLoadingJadwal] = useState(false);

  useEffect(() => {
    setPinjaman(null);
    setJadwal([]);
    setJadwalTerpilih(null);
    setJenisPembayaran('ANGSURAN');
    setRincianBase(null);
    setPenaltiPelunasan('');
    setAdministrasiPelunasan('');
    setMetodeJasaPelunasan('JASA_KONTRAKTUAL');
    if (!anggota) {
      setPinjamanList([]);
      return;
    }
    listPinjaman({ anggotaId: anggota.anggotaId, status: 'AKTIF', limit: 100 }).then(setPinjamanList);
  }, [anggota]);

  useEffect(() => {
    setJadwalTerpilih(null);
    setNominal('');
    setJenisPembayaran('ANGSURAN');
    setRincianBase(null);
    setPenaltiPelunasan('');
    setAdministrasiPelunasan('');
    setMetodeJasaPelunasan('JASA_KONTRAKTUAL');
    if (!pinjaman) {
      setJadwal([]);
      return;
    }
    setLoadingJadwal(true);
    getJadwalAngsuran(pinjaman.id)
      .then((rows) => setJadwal(rows.filter((r) => r.status !== 'LUNAS')))
      .finally(() => setLoadingJadwal(false));
  }, [pinjaman]);

  /**
   * REQUIREMENT 8 — dependency array SENGAJA TIDAK memuat
   * `penaltiPelunasan`/`administrasiPelunasan`. Query database hanya
   * dijalankan saat sesuatu yang benar-benar berasal dari database
   * berubah: pinjaman yang dipilih, tanggal (denda bergantung tanggal),
   * dan metode jasa (menentukan jasa mana yang ditagih). Mengetik biaya
   * TIDAK LAGI memicu satu pun request — sesuai instruksi "tidak ada
   * unnecessary API request setiap keystroke".
   *
   * REQUIREMENT 9 — `metodeJasaPelunasan` masuk dependency karena
   * pemilihan metode memang MENGUBAH ANGKA yang dihitung backend
   * (bukan sekadar label): total, jasa yang ditagih, dan rabat.
   *
   * Guard `dibatalkan` mencegah respons lama menimpa respons baru kalau
   * petugas mengganti pilihan lebih cepat daripada query selesai.
   */
  useEffect(() => {
    if (jenisPembayaran !== 'PELUNASAN' || !pinjaman) {
      return;
    }
    let dibatalkan = false;
    setLoadingRincian(true);
    (async () => {
      try {
        const db = await getDb();
        // Biaya tambahan SENGAJA tidak dikirim ke sini — keduanya
        // dikomposisikan di layar lewat terapkanBiayaTambahanPelunasan
        // (fungsi murni yang SAMA dipakai backend). Backend TETAP
        // menghitung ulang segalanya saat submit.
        const rincian = await hitungTotalPelunasan(db, pinjaman.id, tanggal, {
          metodeJasaPelunasan,
        });
        if (dibatalkan) return;
        setRincianBase(rincian);
      } catch (e) {
        if (dibatalkan) return;
        notify('Gagal', e instanceof Error ? e.message : 'Gagal menghitung total pelunasan.');
      } finally {
        if (!dibatalkan) setLoadingRincian(false);
      }
    })();
    return () => {
      dibatalkan = true;
    };
  }, [jenisPembayaran, pinjaman, tanggal, metodeJasaPelunasan]);

  /**
   * REQUIREMENT 8 — nominal yang dipakai validasi & submit. Untuk mode
   * PELUNASAN nilainya DITURUNKAN dari rincian, bukan disalin ke state
   * lewat setNominal di dalam effect (yang dulu menambah satu siklus
   * render ekstra setiap kali angka berubah).
   */
  const nominalEfektif: number | '' =
    jenisPembayaran === 'PELUNASAN' ? rincianPelunasan?.totalPelunasan ?? '' : nominal;

  const pilihJenisPembayaran = (jenis: JenisPembayaran) => {
    setJenisPembayaran(jenis);
    setJadwalTerpilih(null);
    setNominal('');
    setRincianBase(null);
    setPenaltiPelunasan('');
    setAdministrasiPelunasan('');
    setMetodeJasaPelunasan('JASA_KONTRAKTUAL');
  };

  /**
   * REQUIREMENT 8 — handler input dibungkus useCallback supaya identitas
   * fungsinya STABIL antar-render. Tanpa ini, setiap render membuat
   * closure baru sebagai prop `onChangeValue`, sehingga <CurrencyInput/>
   * ikut me-render ulang tiap kali state apa pun di layar ini berubah.
   */
  const handlePenaltiChange = useCallback((v: number | '') => setPenaltiPelunasan(v), []);
  const handleAdministrasiChange = useCallback((v: number | '') => setAdministrasiPelunasan(v), []);

  const pilihJadwal = (item: JadwalAngsuranItem) => {
    setJadwalTerpilih(item);
    const sisa = item.total - item.pokokTerbayar - item.jasaTerbayar;
    setNominal(sisa > 0 ? sisa : '');
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!anggota) e.anggota = 'Anggota wajib dipilih';
    if (!pinjaman) e.pinjaman = 'Pinjaman wajib dipilih';
    if (jenisPembayaran === 'ANGSURAN' && !jadwalTerpilih) e.jadwal = 'Angsuran ke berapa wajib dipilih';
    if (jenisPembayaran === 'PELUNASAN' && (!rincianPelunasan || rincianPelunasan.totalPelunasan <= 0)) {
      e.jadwal = 'Pinjaman ini sudah lunas.';
    }
    if (nominalEfektif === '' || nominalEfektif <= 0) e.nominal = 'Nominal harus lebih dari 0';
    if (!rekening) e.rekening = 'Rekening tujuan penerimaan wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const doSubmitAngsuran = async () => {
    if (!pinjaman || !jadwalTerpilih || !rekening || !currentUser || nominal === '') return;
    setSubmitting(true);
    try {
      await bayarAngsuran({
        pinjamanId: pinjaman.id,
        jadwalId: jadwalTerpilih.id,
        tanggal,
        nominal,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Pembayaran piutang anggota berhasil dicatat.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const doSubmitPelunasan = async () => {
    if (!pinjaman || !rekening || !currentUser) return;
    setSubmitting(true);
    try {
      const hasil = await lunasiPinjaman({
        pinjamanId: pinjaman.id,
        tanggal,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        createdBy: currentUser.id,
        penaltiPelunasan: penaltiPelunasan === '' ? 0 : penaltiPelunasan,
        administrasiPelunasan: administrasiPelunasan === '' ? 0 : administrasiPelunasan,
        // REQUIREMENT 9 — metode dikirim, lalu DIVALIDASI & DIHITUNG
        // ULANG server-side di dalam transaksi (lihat lunasiPinjaman).
        metodeJasaPelunasan,
      });
      notify(
        'Berhasil',
        `Pinjaman ${pinjaman.nomorPinjaman} berhasil dilunasi sebesar ${formatRupiah(hasil.totalPelunasan)}. Status pinjaman: LUNAS.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    // §6: cegah dua klik cepat — tombol sudah didisable via `submitting`
    // di JSX, tapi dicek eksplisit di sini juga sebagai lapis kedua di
    // level UI (lapis SUNGGUHAN tetap ada di service, lihat komentar
    // lunasiPinjaman()).
    if (submitting) return;
    if (!validate()) return;

    if (jenisPembayaran === 'PELUNASAN' && rincianPelunasan) {
      notify(
        'Konfirmasi Pelunasan',
        `Metode: ${rincianPelunasan.metodeJasaPelunasan === 'JASA_TERUTANG' ? 'Jasa Terutang' : 'Jasa Kontraktual'}.\n\n` +
          `Total pelunasan ${formatRupiah(rincianPelunasan.totalPelunasan)}` +
          (rincianPelunasan.rabatJasa > 0
            ? `, dengan rabat jasa kontraktual ${formatRupiah(rincianPelunasan.rabatJasa)} yang tidak ditagih.`
            : '.') +
          `\n\nSetelah transaksi berhasil, pinjaman akan berstatus LUNAS. Lanjutkan?`,
        [
          { text: 'Batal', style: 'cancel' },
          { text: 'Ya, Lunasi', style: 'destructive', onPress: doSubmitPelunasan },
        ]
      );
    } else {
      doSubmitAngsuran();
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="ANGSURAN" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="ANGSURAN" />
        ) : (
        <>
        <AnggotaPiutangPicker value={anggota} onChange={setAnggota} error={errors.anggota} />

        {anggota && (
          <>
            <Text style={styles.label}>Pinjaman Aktif *</Text>
            <TouchableOpacity
              style={[styles.selector, errors.pinjaman && styles.selectorError]}
              onPress={() => pinjamanList.length > 0 && setPinjamanModalOpen(true)}
            >
              <Ionicons name="cash-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
              <Text style={pinjaman ? styles.selectorText : styles.selectorPlaceholder}>
                {pinjaman
                  ? `${pinjaman.nomorPinjaman} · sisa piutang ${formatRupiah(pinjaman.sisaPiutang)}`
                  : pinjamanList.length > 0
                  ? 'Pilih pinjaman aktif...'
                  : 'Anggota ini tidak punya pinjaman aktif'}
              </Text>
            </TouchableOpacity>
            {errors.pinjaman && <Text style={styles.errorText}>{errors.pinjaman}</Text>}
          </>
        )}

        {pinjaman && (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Jenis Pembayaran</Text>
            <View style={styles.jenisRow}>
              <TouchableOpacity style={styles.radioRow} onPress={() => pilihJenisPembayaran('ANGSURAN')}>
                <View style={[styles.radioOuter, jenisPembayaran === 'ANGSURAN' && styles.radioOuterActive]}>
                  {jenisPembayaran === 'ANGSURAN' && <View style={styles.radioInner} />}
                </View>
                <Text style={styles.radioLabel}>Angsuran</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.radioRow} onPress={() => pilihJenisPembayaran('PELUNASAN')}>
                <View style={[styles.radioOuter, jenisPembayaran === 'PELUNASAN' && styles.radioOuterActive]}>
                  {jenisPembayaran === 'PELUNASAN' && <View style={styles.radioInner} />}
                </View>
                <Text style={styles.radioLabel}>Pelunasan</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {pinjaman && jenisPembayaran === 'ANGSURAN' && (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Angsuran Ke *</Text>
            {loadingJadwal ? (
              <ActivityIndicator style={{ marginVertical: spacing.md }} />
            ) : (
              <View style={styles.jadwalList}>
                {jadwal.map((item) => {
                  const sisa = item.total - item.pokokTerbayar - item.jasaTerbayar;
                  const active = jadwalTerpilih?.id === item.id;
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.jadwalRow, active && styles.jadwalRowActive]}
                      onPress={() => pilihJadwal(item)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.jadwalNomor}>Angsuran ke-{item.nomorAngsuran}</Text>
                        <Text style={styles.jadwalSub}>Jatuh tempo {item.tanggalJatuhTempo}</Text>
                      </View>
                      <Text style={styles.jadwalSisa}>{formatRupiah(sisa)}</Text>
                    </TouchableOpacity>
                  );
                })}
                {jadwal.length === 0 && <Text style={styles.emptyText}>Tidak ada jadwal yang belum lunas.</Text>}
              </View>
            )}
            {errors.jadwal && <Text style={styles.errorText}>{errors.jadwal}</Text>}
          </>
        )}

        {pinjaman && jenisPembayaran === 'PELUNASAN' && (
          <View style={{ marginTop: spacing.md }}>
            {/* ============================================================
                REQUIREMENT 9 (permintaan pengguna): pilih METODE PELUNASAN.
                Dua pilihan ini BUKAN sekadar label — keduanya benar-benar
                mengubah angka yang dihitung backend (lihat
                PinjamanService.hitungTotalPelunasan/lunasiPinjaman):
                total pelunasan, jasa yang ditagih, rabat, dan baris jurnal
                Pendapatan Diterima Dimuka.

                REQUIREMENT 8: blok pilihan & kedua input biaya di bawah
                dirender TANPA SYARAT selama mode Pelunasan aktif. Spinner
                TIDAK PERNAH menggantikannya (hanya menimpa area ANGKA
                rincian), jadi komponen input tidak pernah di-unmount saat
                petugas sedang mengetik.
                ============================================================ */}
            <Text style={styles.label}>Metode Pelunasan *</Text>
            <View style={styles.metodeGroup}>
              {(
                [
                  {
                    value: 'JASA_TERUTANG' as MetodeJasaPelunasan,
                    judul: 'Jasa Terutang',
                    deskripsi:
                      'Hanya jasa yang periodenya SUDAH jatuh tempo per tanggal pelunasan yang ditagih. Sisa jasa kontraktual masa depan dirabat (tidak ditagih).',
                    nilai: rincianPelunasan?.jasaSudahJatuhTempo,
                  },
                  {
                    value: 'JASA_KONTRAKTUAL' as MetodeJasaPelunasan,
                    judul: 'Jasa Kontraktual',
                    deskripsi:
                      'Seluruh sisa jasa sesuai kontrak ditagih, termasuk periode yang belum jatuh tempo.',
                    nilai: rincianPelunasan?.jasaTerutang,
                  },
                ]
              ).map((opt) => {
                const aktif = metodeJasaPelunasan === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.metodeCard, aktif && styles.metodeCardActive]}
                    onPress={() => setMetodeJasaPelunasan(opt.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: aktif }}
                    accessibilityLabel={`Metode ${opt.judul}`}
                  >
                    <View style={styles.metodeHeaderRow}>
                      <View style={[styles.radioOuter, aktif && styles.radioOuterActive]}>
                        {aktif && <View style={styles.radioInner} />}
                      </View>
                      <Text style={[styles.metodeJudul, aktif && styles.metodeJudulActive]}>{opt.judul}</Text>
                      {opt.nilai !== undefined && (
                        <Text style={styles.metodeNilai}>{formatRupiah(opt.nilai)}</Text>
                      )}
                    </View>
                    <Text style={styles.metodeDeskripsi}>{opt.deskripsi}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Area RINCIAN — hanya bagian inilah yang boleh diganti
                spinner/empty state, karena tidak memuat satu pun input. */}
            {loadingRincian && !rincianPelunasan ? (
              <ActivityIndicator style={{ marginVertical: spacing.md }} />
            ) : rincianPelunasan && rincianPelunasan.totalPelunasan > 0 ? (
              <View style={styles.pelunasanCard}>
                <View style={styles.pelunasanHeaderRow}>
                  <Text style={styles.pelunasanTitle}>RINCIAN PELUNASAN</Text>
                  {/* Indikator halus saat rincian sedang dimuat ulang —
                      MENGGANTIKAN spinner layar penuh yang dulu membuang
                      fokus input (requirement 8). */}
                  {loadingRincian && <ActivityIndicator size="small" color={colors.primary} />}
                </View>

                <View style={styles.pelunasanRow}>
                  <Text style={styles.pelunasanLabel}>Pokok Tersisa</Text>
                  <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.pokokTersisa)}</Text>
                </View>
                <View style={styles.pelunasanRow}>
                  <Text style={styles.pelunasanLabel}>Jasa Terutang (sudah jatuh tempo)</Text>
                  <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.jasaSudahJatuhTempo)}</Text>
                </View>
                <View style={styles.pelunasanRow}>
                  <Text style={styles.pelunasanLabel}>Jasa Kontraktual (seluruh sisa)</Text>
                  <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.jasaTerutang)}</Text>
                </View>
                <View style={styles.pelunasanRow}>
                  <Text style={[styles.pelunasanLabel, styles.pelunasanLabelKuat]}>
                    Jasa Ditagih ({rincianPelunasan.metodeJasaPelunasan === 'JASA_TERUTANG' ? 'Terutang' : 'Kontraktual'})
                  </Text>
                  <Text style={[styles.pelunasanValue, styles.pelunasanLabelKuat]}>
                    {formatRupiah(rincianPelunasan.jasaDitagih)}
                  </Text>
                </View>
                {rincianPelunasan.rabatJasa > 0 && (
                  <View style={styles.pelunasanRow}>
                    <Text style={[styles.pelunasanLabel, styles.pelunasanRabat]}>Rabat Jasa (tidak ditagih)</Text>
                    <Text style={[styles.pelunasanValue, styles.pelunasanRabat]}>
                      −{formatRupiah(rincianPelunasan.rabatJasa)}
                    </Text>
                  </View>
                )}
                <View style={styles.pelunasanRow}>
                  <Text style={styles.pelunasanLabel}>Denda</Text>
                  <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.denda)}</Text>
                </View>
                {rincianPelunasan.penaltiPelunasan > 0 && (
                  <View style={styles.pelunasanRow}>
                    <Text style={styles.pelunasanLabel}>Penalti Pelunasan</Text>
                    <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.penaltiPelunasan)}</Text>
                  </View>
                )}
                {rincianPelunasan.administrasiPelunasan > 0 && (
                  <View style={styles.pelunasanRow}>
                    <Text style={styles.pelunasanLabel}>Administrasi Pelunasan</Text>
                    <Text style={styles.pelunasanValue}>{formatRupiah(rincianPelunasan.administrasiPelunasan)}</Text>
                  </View>
                )}
                <View style={styles.pelunasanDivider} />
                <View style={styles.pelunasanRow}>
                  <Text style={styles.pelunasanTotalLabel}>TOTAL PELUNASAN</Text>
                  <Text style={styles.pelunasanTotalValue}>{formatRupiah(rincianPelunasan.totalPelunasan)}</Text>
                </View>
              </View>
            ) : !loadingRincian ? (
              <Text style={styles.emptyText}>Pinjaman ini sudah lunas.</Text>
            ) : null}

            {/* Kedua input di BAWAH kartu rincian & di LUAR kondisi
                loading/empty — inilah inti perbaikan requirement 8. */}
            <Text style={[styles.label, { marginTop: spacing.md }]}>Biaya Penalti Pelunasan (opsional)</Text>
            <CurrencyInput value={penaltiPelunasan} onChangeValue={handlePenaltiChange} />

            <Text style={[styles.label, { marginTop: spacing.sm }]}>Biaya Administrasi Pelunasan (opsional)</Text>
            <CurrencyInput value={administrasiPelunasan} onChangeValue={handleAdministrasiChange} />

            {errors.jadwal && <Text style={styles.errorText}>{errors.jadwal}</Text>}
          </View>
        )}

        {((jenisPembayaran === 'ANGSURAN' && jadwalTerpilih) ||
          (jenisPembayaran === 'PELUNASAN' && rincianPelunasan && rincianPelunasan.totalPelunasan > 0)) && (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>
              {jenisPembayaran === 'PELUNASAN' ? 'Nominal Diterima (Rp) — Total Pelunasan' : 'Nominal Diterima (Rp) *'}
            </Text>
            <CurrencyInput
              value={nominalEfektif}
              onChangeValue={jenisPembayaran === 'PELUNASAN' ? noop : setNominal}
              error={errors.nominal}
              editable={jenisPembayaran !== 'PELUNASAN'}
            />

            <View style={{ marginTop: spacing.md }}>
              <RekeningPicker label="Diterima Ke" value={rekening} onChange={setRekening} />
              {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
            </View>

            <Text style={styles.label}>Tanggal *</Text>
            <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

            <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
              {submitting ? (
                <>
                  <ActivityIndicator color={colors.white} />
                  <Text style={styles.submitText}>
                    {jenisPembayaran === 'PELUNASAN' ? 'Memproses pelunasan...' : 'Memproses...'}
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="save-outline" size={18} color={colors.white} />
                  <Text style={styles.submitText}>{jenisPembayaran === 'PELUNASAN' ? 'Lunasi Pinjaman' : 'Terima Pembayaran'}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}

        <Modal visible={pinjamanModalOpen} animationType="slide" onRequestClose={() => setPinjamanModalOpen(false)}>
          <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pilih Pinjaman</Text>
              <TouchableOpacity onPress={() => setPinjamanModalOpen(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <FlatList keyboardShouldPersistTaps="handled"
              data={pinjamanList}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.jadwalRow}
                  onPress={() => {
                    setPinjaman(item);
                    setPinjamanModalOpen(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jadwalNomor}>{item.nomorPinjaman}</Text>
                    <Text style={styles.jadwalSub}>Plafon {formatRupiah(item.jumlahPinjaman)}</Text>
                  </View>
                  <Text style={styles.jadwalSisa}>{formatRupiah(item.sisaPiutang)}</Text>
                </TouchableOpacity>
              )}
            />
          </SafeAreaView>
        </Modal>
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  selectorError: { borderColor: colors.danger },
  selectorText: { fontSize: 15, color: colors.text },
  selectorPlaceholder: { fontSize: 15, color: colors.placeholder },
  jadwalList: { marginBottom: spacing.sm },
  jadwalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  jadwalRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  jadwalNomor: { fontSize: 14, fontWeight: '700', color: colors.text },
  jadwalSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  jadwalSisa: { fontSize: 13, fontWeight: '700', color: colors.primary },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.md },
  jenisRow: { flexDirection: 'row', gap: spacing.lg, marginBottom: spacing.sm },
  radioRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  radioLabel: { fontSize: 14, color: colors.text, fontWeight: '600' },
  pelunasanCard: {
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  pelunasanTitle: { fontSize: 12, fontWeight: '700', color: colors.primary, letterSpacing: 0.5, marginBottom: spacing.sm },
  pelunasanRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  pelunasanLabel: { fontSize: 13, color: colors.textMuted },
  pelunasanValue: { fontSize: 13, color: colors.text, fontWeight: '600' },
  pelunasanDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  // REQUIREMENT 9 — kartu pilihan metode pelunasan.
  pelunasanHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  pelunasanLabelKuat: { fontWeight: '700', color: colors.text },
  pelunasanRabat: { color: colors.warning, fontWeight: '700' },
  metodeGroup: { gap: spacing.sm, marginBottom: spacing.md },
  metodeCard: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  metodeCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  metodeHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  metodeJudul: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1 },
  metodeJudulActive: { color: colors.primary, fontWeight: '700' },
  metodeNilai: { fontSize: 13, fontWeight: '700', color: colors.text },
  metodeDeskripsi: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 6, marginLeft: 28 },
  pelunasanTotalLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  pelunasanTotalValue: { fontSize: 16, fontWeight: '700', color: colors.primary },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalTitle: { ...modalUi.title },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    marginBottom: 40,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
