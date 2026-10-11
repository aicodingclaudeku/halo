import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import {
  listAkunNeracaUntukSaldoAwal,
  tambahSaldoAwalAkun,
  hapusSaldoAwalAkun,
  koreksiSaldoAwal,
  aturBagianTunaiSaldoAwal,
  adalahAkunLabaRugi,
  kunciSaldoAwalPermanen,
  getRingkasanSaldoAwal,
  AkunNeracaItem,
  SaldoAwalAkunItem,
  RingkasanSaldoAwal,
} from '@/services/SaldoAwalAkunService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import SearchField from '@/components/SearchField';
import { colors, iconSize, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import {
  JUDUL_MODUL_SALDO_AWAL,
  SUBJUDUL_MODUL_SALDO_AWAL,
  LABEL_STATUS_SALDO_AWAL,
  KETERANGAN_STATUS_SALDO_AWAL,
  NADA_STATUS_SALDO_AWAL,
  IKON_STATUS_SALDO_AWAL,
  URUTAN_FILTER_PENGISIAN,
  LABEL_FILTER_PENGISIAN,
  hitungKemajuanPengisian,
  bolehDiedit,
  bolehDikoreksi,
  bolehKunciPermanen,
  CATATAN_BUKAN_PEMERIKSAAN_KESEIMBANGAN,
  JUDUL_PERINGATAN_KLIRING,
  PENJELASAN_PERINGATAN_KLIRING,
  perluPeringatanKliring,
  type StatusSaldoAwal,
  type FilterPengisian,
} from '@/reports/StatusSaldoAwalPlan';

/**
 * "SALDO AWAL AKUN (COA)" — sebelumnya "Saldo Akun (COA)" (rename
 * tampilan, permintaan pengguna request baru §S — menegaskan bahwa
 * fitur ini SPESIFIK untuk saldo AWAL per akun, bukan Daftar Akun/COA
 * itu sendiri). Phase 18: rombak total dari layar "Neraca Awal" lama.
 *
 * UI SINGLE-ENTRY (§2/§24): user hanya mengisi NILAI per akun, tidak
 * pernah diminta memilih debit/kredit/akun kontra. Sistem yang
 * menentukan arah jurnal dari `normal_balance` akun (di
 * SaldoAwalAkunService — TIDAK ADA logic debit/kredit di layar ini).
 *
 * Audit ulang (permintaan pengguna, request baru §1): SEKARANG
 * mencakup SELURUH kategori COA (ASET/LIABILITAS/EKUITAS/PENDAPATAN/
 * BEBAN), bukan cuma akun neraca — nilai yang diinput menjadi SALDO
 * AWAL akun yang bersangkutan apa pun kategorinya.
 *
 * Audit ulang (permintaan pengguna, request lebih baru): tampilan
 * Total Aset/Liabilitas/Ekuitas serta indikator/badge "saldo seimbang"
 * DIHAPUS TOTAL dari layar ini (§8 permintaan FINAL — "form Saldo Awal
 * HANYA UNTUK INPUT DATA", tidak ada dashboard keseimbangan sama
 * sekali di sini). Pengecekan Seimbang/Belum Seimbang SEKARANG murni
 * tugas laporan Posisi Keuangan (§9), bukan layar ini.
 *
 * Audit ulang (permintaan pengguna, request FINAL §5/§6/§7): alur
 * "Simpan Draft -> Posting Saldo Akun" (dua langkah terpisah) DIHAPUS
 * TOTAL. SEKARANG: setiap baris yang diisi & ditekan SIMPAN langsung
 * membuat jurnal & AKTIF SEKETIKA (lihat komentar panjang
 * `tambahSaldoAwalAkun()` di SaldoAwalAkunService.ts untuk penjelasan
 * mekanisme akun kliring "Saldo Awal Belum Sesuai" yang menjaga
 * integritas double-entry TANPA menyamarkan selisih) — TIDAK ADA lagi
 * tombol "Posting" terpisah, TIDAK ADA status "belum diposting" yang
 * membuat saldo tidak masuk laporan. Baris yang SUDAH aktif (sudah
 * pernah SIMPAN) menjadi READ-ONLY di daftar ini — perubahan lebih
 * lanjut WAJIB lewat "Koreksi" (reversal + jurnal baru, §16), bukan
 * ketik ulang di kotak yang sama.
 *
 * Audit ulang (permintaan pengguna, request terbaru §2-9/§24-26/§29/§34
 * — "prinsip desain" utama): daftar akun di layar ini SATU daftar
 * datar (flat) terurut kode akun, TIDAK dikelompokkan ke section ASET/
 * LIABILITAS/EKUITAS/PENDAPATAN/BEBAN sama sekali — pengelompokan
 * seperti itu HANYA boleh terjadi di laporan (Posisi Keuangan dkk,
 * berbasis `account.kategori`, tidak diubah), bukan di form input ini.
 * Kategori TETAP ditampilkan per baris sebagai info READ-ONLY kecil
 * (bukan header/section) — user tidak pernah diminta "akun ini masuk
 * kategori apa", itu murni ikut apa adanya dari COA. Kolom pencarian
 * (kode/nama) ditambahkan (§25/§26) supaya tetap mudah dipakai walau
 * daftar akun panjang & tidak lagi terkelompok.
 */
export default function SaldoAwalAkunListScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [akunList, setAkunList] = useState<AkunNeracaItem[]>([]);
  const [ringkasan, setRingkasan] = useState<RingkasanSaldoAwal | null>(null);
  const [nilaiMap, setNilaiMap] = useState<Record<string, number | ''>>({});
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockModalOpen, setLockModalOpen] = useState(false);
  /**
   * Penjelasan akun kliring tertutup secara bawaan. Paragraf itu
   * perlu dibaca SEKALI untuk mengerti angkanya, bukan setiap kali
   * layar dibuka — dan lima baris teks di kop mengambil ruang yang
   * seharusnya jadi milik daftar akun.
   */
  const [peringatanTerbuka, setPeringatanTerbuka] = useState(false);
  // Audit ulang §25/§26: pencarian kode/nama akun + filter opsional
  // (bukan grouping wajib — daftar tetap satu, hanya disaring).
  const [cari, setCari] = useState('');
  const [filterDiisi, setFilterDiisi] = useState<'SEMUA' | 'SUDAH' | 'BELUM'>('SEMUA');

  const [koreksiTarget, setKoreksiTarget] = useState<SaldoAwalAkunItem | null>(null);
  const [koreksiNilaiBaru, setKoreksiNilaiBaru] = useState<number | ''>('');
  const [koreksiAlasan, setKoreksiAlasan] = useState('');
  const [koreksiSubmitting, setKoreksiSubmitting] = useState(false);

  // RC-S133.4.3 — bagian tunai saldo awal Pendapatan/Beban (SHU Basis Kas).
  const [tunaiTarget, setTunaiTarget] = useState<SaldoAwalAkunItem | null>(null);
  const [tunaiNilai, setTunaiNilai] = useState<number | ''>('');
  const [tunaiSubmitting, setTunaiSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [akun, ring] = await Promise.all([listAkunNeracaUntukSaldoAwal(), getRingkasanSaldoAwal()]);
      setAkunList(akun);
      setRingkasan(ring);
      const map: Record<string, number | ''> = {};
      for (const row of ring.rows) map[row.accountId] = row.saldo;
      setNilaiMap(map);
      if (ring.rows.length > 0) setTanggal(ring.rows[0].tanggal);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Audit ulang (permintaan pengguna, request FINAL): dulu `editable`
  // adalah SATU flag GLOBAL untuk seluruh layar (tergantung status
  // batch draft/posted). Sekarang PER BARIS — akun yang BELUM punya
  // saldo awal boleh diisi langsung di kotak ini (akan langsung aktif
  // begitu SIMPAN ditekan); akun yang SUDAH punya saldo awal jadi
  // read-only di sini, perubahan lewat "Koreksi" (§16).
  const terkunciPermanen = !!ringkasan?.lockInfo;

  const setNilai = (accountId: string, v: number | '') => {
    setNilaiMap((prev) => ({ ...prev, [accountId]: v }));
  };

  /**
   * Audit ulang (permintaan pengguna, request FINAL §5/§6/§7): SATU-
   * SATUNYA tombol simpan sekarang. Hanya memproses akun yang BELUM
   * punya saldo awal (baris yang SUDAH aktif read-only di kotaknya —
   * tidak mungkin nilainya berubah lewat sini, harus lewat "Koreksi").
   * Setiap akun baru yang diisi langsung membuat jurnalnya sendiri &
   * aktif SEKETIKA (`tambahSaldoAwalAkun()` — TIDAK ADA lagi draft/
   * posting terpisah, lihat komentar besar di SaldoAwalAkunService.ts).
   */
  const simpanSaldoAwal = async () => {
    if (!currentUser) return;
    setSaving(true);
    try {
      const existingByAccount = new Map((ringkasan?.rows ?? []).map((r) => [r.accountId, r]));
      let jumlahDisimpan = 0;
      for (const akun of akunList) {
        if (existingByAccount.has(akun.id)) continue; // sudah aktif — read-only, lewat Koreksi kalau mau ubah
        const nilaiBaru = nilaiMap[akun.id];
        const nilaiBaruValid = nilaiBaru !== '' && nilaiBaru > 0 ? nilaiBaru : null;
        if (nilaiBaruValid === null) continue;
        await tambahSaldoAwalAkun({ accountId: akun.id, tanggal, saldo: nilaiBaruValid, createdBy: currentUser.id });
        jumlahDisimpan++;
      }
      await load();
      if (jumlahDisimpan > 0) {
        notify('Tersimpan', `${jumlahDisimpan} saldo awal berhasil disimpan & langsung aktif.`);
      } else {
        notify('Tidak Ada Perubahan', 'Tidak ada akun baru yang diisi untuk disimpan.');
      }
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSaving(false);
    }
  };

  const submitKunciPermanen = async () => {
    if (!currentUser) return;
    setLocking(true);
    try {
      await kunciSaldoAwalPermanen(currentUser.id);
      setLockModalOpen(false);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setLocking(false);
    }
  };

  const bukaBagianTunai = (row: SaldoAwalAkunItem) => {
    setTunaiTarget(row);
    setTunaiNilai(row.saldo - row.bagianBelumTunai);
  };

  const submitBagianTunai = async () => {
    if (!tunaiTarget || !currentUser || tunaiNilai === '') return;
    setTunaiSubmitting(true);
    try {
      await aturBagianTunaiSaldoAwal({ accountId: tunaiTarget.accountId, bagianTunai: tunaiNilai, actingUserId: currentUser.id });
      notify('Berhasil', 'Bagian tunai tersimpan. SHU Basis Kas di Laporan Hasil Usaha ikut diperbarui.');
      setTunaiTarget(null);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setTunaiSubmitting(false);
    }
  };

  const bukaKoreksi = (row: SaldoAwalAkunItem) => {
    setKoreksiTarget(row);
    setKoreksiNilaiBaru(row.saldo);
    setKoreksiAlasan('');
  };

  /**
   * Audit ulang (permintaan pengguna, request FINAL §17/§18): hapus
   * saldo awal yang sudah aktif — SELALU lewat reversal (§17), TIDAK
   * PERNAH langsung DELETE journal POSTED (`hapusSaldoAwalAkun()` di
   * service sudah menangani ini). Konfirmasi dulu supaya tidak
   * tertekan tidak sengaja (aksi ini membuat jurnal reversal baru,
   * bukan aksi yang bisa "dibatalkan" begitu saja).
   */
  const konfirmasiHapus = (row: SaldoAwalAkunItem) => {
    notify(
      'Hapus Saldo Awal',
      `Saldo awal "${row.namaAkun}" (${formatRupiah(row.saldo)}) akan dihapus — jurnal aslinya akan di-reversal (bukan dihapus langsung, histori tetap tersimpan). Akun ini kembali berstatus "Belum Diisi". Lanjutkan?`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Hapus', style: 'destructive', onPress: () => doHapus(row) },
      ]
    );
  };

  const doHapus = async (row: SaldoAwalAkunItem) => {
    if (!currentUser) return;
    setSaving(true);
    try {
      await hapusSaldoAwalAkun(row.id, currentUser.id);
      notify('Berhasil', 'Saldo awal berhasil dihapus (jurnal aslinya sudah di-reversal).');
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSaving(false);
    }
  };

  const submitKoreksi = async () => {
    if (!koreksiTarget || !currentUser || koreksiNilaiBaru === '') return;
    if (!koreksiAlasan.trim()) {
      notify('Gagal', 'Alasan koreksi wajib diisi.');
      return;
    }
    setKoreksiSubmitting(true);
    try {
      await koreksiSaldoAwal({
        accountId: koreksiTarget.accountId,
        saldoBaru: koreksiNilaiBaru,
        alasan: koreksiAlasan.trim(),
        actingUserId: currentUser.id,
      });
      notify('Berhasil', 'Koreksi saldo awal berhasil diposting.');
      setKoreksiTarget(null);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setKoreksiSubmitting(false);
    }
  };

  if (loading || !ringkasan) {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={{ marginTop: 40 }} />
      </View>
    );
  }

  // Peta akun -> baris saldo awal yang sudah aktif. Dihitung SEKALI,
  // bukan `rows.find()` di dalam loop render: dengan COA penuh
  // (ratusan akun) pencarian linear per baris membuat setiap ketikan
  // di kotak nominal terasa tersendat.
  const barisAktif = new Map(ringkasan.rows.map((r) => [r.accountId, r]));

  const daftarTampil = akunList.filter((a) => {
    const q = cari.trim().toLowerCase();
    if (q && !a.kode.toLowerCase().includes(q) && !a.nama.toLowerCase().includes(q)) return false;
    const sudahDiisi = barisAktif.has(a.id);
    if (filterDiisi === 'SUDAH' && !sudahDiisi) return false;
    if (filterDiisi === 'BELUM' && sudahDiisi) return false;
    return true;
  });

  // Kemajuan dihitung dari SELURUH COA, bukan dari daftar yang sedang
  // tersaring — kalau ikut saringan, mengetik satu kata di pencarian
  // akan membuat bar melompat ke 100% dan memberi kesan pekerjaan
  // sudah selesai. Lihat `hitungKemajuanPengisian()`: yang dihitung
  // JUMLAH AKUN, tidak pernah nominal, jadi ini bukan pemeriksaan
  // keseimbangan yang memang tidak boleh ada di layar ini.
  const kemajuan = hitungKemajuanPengisian(akunList.length, ringkasan.rows.length);
  const jumlahSudah = ringkasan.rows.length;
  const jumlahBelum = Math.max(akunList.length - jumlahSudah, 0);
  const jumlahPerFilter: Record<FilterPengisian, number> = {
    SEMUA: akunList.length,
    SUDAH: jumlahSudah,
    BELUM: jumlahBelum,
  };

  const status = ringkasan.status as StatusSaldoAwal;
  const nada = NADA_STATUS_SALDO_AWAL[status];
  const tampilkanSimpanPermanen = bolehKunciPermanen(status, ringkasan.rows.length, terkunciPermanen);

  return (
    <View style={styles.container}>
      {/*
        KOP MODUL — RINGKAS, dan sengaja begitu.

        Versi sebelumnya memuat judul, subjudul empat baris, kalimat
        status, bar kemajuan, DAN penjelasan lengkap akun kliring
        sekaligus. Hasilnya kop setinggi dua pertiga layar: daftar akun
        — satu-satunya hal yang perlu dikerjakan di layar ini — tinggal
        satu kartu yang terpotong di antara kop dan footer.

        Aturan yang dipakai sekarang: kop hanya memuat yang HARUS
        terlihat setiap saat, yaitu status, kemajuan, dan ADA-TIDAKNYA
        selisih. Semua yang bersifat penjelasan turun ke dalam daftar
        (bisa digulir) atau disembunyikan di balik ketukan.
      */}
      <View style={styles.kop}>
        <View style={styles.kopBaris}>
          <Text style={styles.kopJudul}>{JUDUL_MODUL_SALDO_AWAL}</Text>
          <View style={styles.kopTeks} />
          <View style={[styles.chipStatus, styles[`chipStatus_${nada}`]]}>
            <Ionicons
              name={IKON_STATUS_SALDO_AWAL[status] as React.ComponentProps<typeof Ionicons>['name']}
              size={12}
              color={nada === 'netral' ? colors.textMuted : colors.white}
            />
            <Text style={[styles.chipStatusText, nada === 'netral' && styles.chipStatusTextNetral]}>
              {LABEL_STATUS_SALDO_AWAL[status]}
            </Text>
          </View>
        </View>

        {/* Bar kemajuan: hitungan KELENGKAPAN PEKERJAAN (berapa akun
            sudah diisi), bukan Total Aset/Liabilitas/Ekuitas yang
            memang dihapus dari layar ini. */}
        <View style={styles.kemajuanBaris}>
          <Text style={styles.kemajuanTeks}>{kemajuan.teks}</Text>
          <Text style={styles.kemajuanPersen}>{kemajuan.persen}%</Text>
        </View>
        <View style={styles.kemajuanRel}>
          <View style={[styles.kemajuanIsi, { width: `${kemajuan.persen}%` }, kemajuan.lengkap && styles.kemajuanLengkap]} />
        </View>

        {/* PEMBERITAHUAN "SALDO AWAL BELUM SESUAI" (akun kliring
            3-5000). Tetap di kop — sebagai banner di dalam daftar ia
            hilang dari pandangan begitu pengguna menggulir ke akun
            ke-40, justru saat paling dibutuhkan.

            Yang berubah: hanya SATU BARIS (label + nominal) yang
            selalu tampil. Paragraf penjelasannya baru muncul saat
            barisnya diketuk. Penjelasan itu perlu dibaca sekali, bukan
            setiap kali layar dibuka — sementara nominalnya perlu
            terlihat terus. */}
        {perluPeringatanKliring(ringkasan.saldoKliringKoreksi) && (
          <TouchableOpacity
            style={styles.peringatanKliring}
            onPress={() => setPeringatanTerbuka((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: peringatanTerbuka }}
            accessibilityLabel={`${JUDUL_PERINGATAN_KLIRING}, ${formatRupiah(ringkasan.saldoKliringKoreksi)}. Ketuk untuk ${peringatanTerbuka ? 'menutup' : 'membuka'} penjelasan.`}
          >
            <View style={styles.peringatanBaris}>
              <Ionicons name="alert-circle" size={iconSize.sm} color={colors.warning} />
              <Text style={styles.peringatanJudul}>{JUDUL_PERINGATAN_KLIRING}</Text>
              <View style={styles.kopTeks} />
              <Text style={styles.peringatanNominal}>{formatRupiah(ringkasan.saldoKliringKoreksi)}</Text>
              <Ionicons
                name={peringatanTerbuka ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={colors.textMuted}
              />
            </View>
            {peringatanTerbuka && <Text style={styles.peringatanTeks}>{PENJELASAN_PERINGATAN_KLIRING}</Text>}
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        {...PROP_SCROLL_FORM}
        style={styles.daftarGulir}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.lg }}
      >
        {/* Penjelasan layar & apa yang boleh dilakukan pada status
            sekarang. Dulu keduanya ada di kop dan ikut memakan tinggi
            layar setiap saat; keduanya bacaan sekali, jadi tempatnya
            di sini — ikut tergulir seperti isi lainnya. */}
        <View style={styles.kartuPengantar}>
          <Text style={styles.pengantarTeks}>{SUBJUDUL_MODUL_SALDO_AWAL}</Text>
          <Text style={styles.pengantarStatus}>{KETERANGAN_STATUS_SALDO_AWAL[status]}</Text>
        </View>

        {ringkasan.legacy.isLegacy && (
          <View style={[styles.banner, styles.bannerInfo]}>
            <Ionicons name="information-circle-outline" size={iconSize.sm} color={colors.primary} style={styles.bannerIcon} accessibilityLabel="Informasi" />
            <Text style={styles.bannerText}>
              Sebagian saldo awal berasal dari mekanisme lama ({ringkasan.legacy.jumlahJurnalTerpisah} jurnal terpisah,
              sebelum refactor) — data historis ini tetap valid dan tidak diubah.
            </Text>
          </View>
        )}
        <View style={styles.kartu}>
          <Text style={styles.kartuJudul}>Tanggal Saldo Awal</Text>
          <Text style={styles.kartuSub}>Dipakai untuk akun baru yang akan diisi di bawah.</Text>
          {!terkunciPermanen ? (
            <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />
          ) : (
            <Text style={styles.nilaiTerkunci}>{formatTanggalIndonesia(tanggal)}</Text>
          )}
        </View>

        <View style={styles.kartu}>
          <Text style={styles.kartuJudul}>Daftar Akun</Text>
          <SearchField
            wrapStyle={styles.searchInput}
            value={cari}
            onChangeText={setCari}
            placeholder="Cari kode atau nama akun..."
            placeholderTextColor={colors.placeholder}
          />
          {/* Chip penyaring membawa ANGKANYA — supaya "Belum Diisi"
              bisa dinilai tanpa harus menekannya lebih dulu. */}
          <View style={styles.filterRow}>
            {URUTAN_FILTER_PENGISIAN.map((f) => (
              <TouchableOpacity
                key={f}
                style={[styles.filterChip, filterDiisi === f && styles.filterChipActive]}
                onPress={() => setFilterDiisi(f)}
                accessibilityRole="button"
                accessibilityState={{ selected: filterDiisi === f }}
              >
                <Text style={[styles.filterChipText, filterDiisi === f && styles.filterChipTextActive]}>
                  {LABEL_FILTER_PENGISIAN[f]} ({jumlahPerFilter[f]})
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {daftarTampil.length === 0 && (
          <View style={styles.kosong}>
            <Ionicons name="search-outline" size={28} color={colors.textMuted} />
            <Text style={styles.kosongText}>Tidak ada akun yang cocok dengan pencarian atau penyaring ini.</Text>
          </View>
        )}

        {daftarTampil.map((akun) => {
          const existing = barisAktif.get(akun.id);
          const sudahDiisi = !!existing;
          const bisaDiedit = bolehDiedit(sudahDiisi, terkunciPermanen);
          const bisaDikoreksi = bolehDikoreksi(sudahDiisi, terkunciPermanen);
          return (
            <View key={akun.id} style={[styles.akunKartu, sudahDiisi && styles.akunKartuAktif]}>
              {/* Baris atas: identitas akun yang READ-ONLY seluruhnya.
                  Kode & kategori sebagai chip kecil supaya nama akun —
                  satu-satunya yang benar-benar dibaca saat mencari
                  baris — mendapat ukuran teks paling besar. */}
              <View style={styles.akunKepala}>
                <Text style={styles.akunKode}>{akun.kode}</Text>
                <Text style={styles.akunKategori}>{akun.kategori}</Text>
                <View style={styles.akunKepalaSisa} />
                {sudahDiisi ? (
                  <View style={styles.tandaAktif}>
                    <Ionicons name="checkmark-circle" size={13} color={colors.success} />
                    <Text style={styles.tandaAktifText}>AKTIF</Text>
                  </View>
                ) : (
                  <Text style={styles.tandaBelum}>BELUM DIISI</Text>
                )}
              </View>
              <Text style={styles.akunNama}>{akun.nama}</Text>

              <Text style={styles.akunLabelNilai}>{sudahDiisi ? 'Saldo awal tersimpan' : 'Saldo awal'}</Text>
              {/* Input melebar penuh, tidak lagi terjepit 150px di
                  ujung baris — angka rupiah panjang jadi terbaca utuh. */}
              <CurrencyInput
                value={nilaiMap[akun.id] ?? ''}
                onChangeValue={(val) => setNilai(akun.id, val)}
                editable={bisaDiedit}
                placeholder="0"
              />

              {existing && adalahAkunLabaRugi(akun.kategori) && (
                <View style={styles.tunaiBaris} testID={`tunai-${akun.kode}`}>
                  <Ionicons name="cash-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.tunaiTeks}>
                    Basis kas: {formatRupiah(existing.saldo - existing.bagianBelumTunai)}{' '}
                    {akun.kategori === 'PENDAPATAN' ? 'sudah diterima tunai' : 'sudah dibayar tunai'}
                    {existing.bagianBelumTunai > 0
                      ? ` · ${formatRupiah(existing.bagianBelumTunai)} belum tunai`
                      : ' (seluruhnya)'}
                  </Text>
                  <TouchableOpacity onPress={() => bukaBagianTunai(existing)} accessibilityRole="button">
                    <Text style={styles.tunaiUbah}>Ubah</Text>
                  </TouchableOpacity>
                </View>
              )}

              {bisaDikoreksi && (
                <View style={styles.akunAksi}>
                  <TouchableOpacity style={styles.tombolAksi} onPress={() => bukaKoreksi(existing!)} accessibilityRole="button">
                    <Ionicons name="create-outline" size={14} color={colors.primary} />
                    <Text style={styles.tombolAksiText}>Koreksi</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.tombolAksi, styles.tombolAksiHapus]} onPress={() => konfirmasiHapus(existing!)} accessibilityRole="button">
                    <Ionicons name="trash-outline" size={14} color={colors.danger} />
                    <Text style={[styles.tombolAksiText, styles.tombolAksiTextHapus]}>Hapus</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })}

        <Text style={styles.catatanKaki}>{CATATAN_BUKAN_PEMERIKSAAN_KESEIMBANGAN}</Text>
      </ScrollView>

      {/*
        FOOTER TIDAK MELAYANG — dan itu inti perbaikannya.

        Sebelumnya footer ini `position: 'absolute'` di atas daftar.
        Menambah ruang bawah pada daftar hanya menyelesaikan SEBAGIAN
        masalah: kartu TERAKHIR jadi bisa digulir naik, tetapi kartu
        yang sedang DIKETIK di tengah daftar tetap tertutup. Sebabnya,
        bagi ScrollView tepi bawah viewport-nya ada di bawah footer;
        saat Android menggulirkan input yang difokuskan "ke dalam
        pandangan", tujuannya adalah area yang sebagian tertutup panel
        melayang itu. Jadi inputnya memang masuk viewport — tepat di
        belakang tombol SIMPAN.

        Sekarang footer menjadi saudara biasa dalam kolom flex:
        kop (setinggi isinya), daftar (`flex: 1`), footer (setinggi
        isinya). Tepi bawah viewport daftar kini benar-benar berada DI
        ATAS footer, sehingga tidak ada tempat untuk bersembunyi — baik
        bagi kartu terakhir maupun kartu mana pun yang sedang diketik.
        Karena itu pengukuran tinggi footer lewat onLayout tidak lagi
        diperlukan dan dihapus.

        Isi footer tidak berubah: SIMPAN tetap aksi utama (penuh warna,
        paling kanan tempat jempol berada), "Simpan Permanen" aksi
        sekunder bergaris di sebelahnya.
      */}
      {!terkunciPermanen && (
        <View style={styles.footer}>
          {tampilkanSimpanPermanen && (
            <TouchableOpacity style={styles.draftButton} onPress={() => setLockModalOpen(true)}>
              <Ionicons name="lock-closed-outline" size={15} color={colors.primary} />
              <Text style={styles.draftButtonText}>Simpan Permanen</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.postButton, saving && styles.disabled]} onPress={simpanSaldoAwal} disabled={saving}>
            {saving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.postButtonText}>SIMPAN</Text>}
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={lockModalOpen} transparent animationType="fade" onRequestClose={() => setLockModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Simpan Permanen</Text>
            <Text style={styles.modalText}>
              Setelah dikunci permanen, saldo awal tidak dapat diubah lagi kecuali lewat Koreksi Saldo Awal. Lanjutkan?
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setLockModalOpen(false)} disabled={locking}>
                <Text style={styles.modalCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirmBtn, locking && styles.disabled]} onPress={submitKunciPermanen} disabled={locking}>
                {locking ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalConfirmText}>Ya, Kunci Permanen</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!tunaiTarget} animationType="slide" onRequestClose={() => setTunaiTarget(null)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>Bagian Tunai Saldo Awal</Text>
            <TouchableOpacity onPress={() => setTunaiTarget(null)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <AreaAmanKeyboard varian="dialog" style={styles.areaKeyboard}>
            <ScrollView {...PROP_SCROLL_FORM} contentContainerStyle={{ padding: spacing.lg, paddingBottom: RUANG_BAWAH_FORM }}>
              <Text style={styles.label}>Akun</Text>
              <Text style={styles.koreksiAkunNama}>{tunaiTarget?.kodeAkun} · {tunaiTarget?.namaAkun}</Text>

              <Text style={styles.label}>Saldo Awal</Text>
              <Text style={styles.koreksiSaldoLama}>{formatRupiah(tunaiTarget?.saldo ?? 0)}</Text>

              <Text style={[styles.label, { marginTop: spacing.md }]}>
                {tunaiTarget?.kategoriAkun === 'BEBAN' ? 'Sudah dibayar tunai sebelum cut-off *' : 'Sudah diterima tunai sebelum cut-off *'}
              </Text>
              <CurrencyInput value={tunaiNilai} onChangeValue={setTunaiNilai} />
              {tunaiTarget && tunaiNilai !== '' && tunaiNilai <= tunaiTarget.saldo && (
                <Text style={styles.hint}>
                  {tunaiTarget.kategoriAkun === 'BEBAN' ? 'Belum dibayar (masih utang)' : 'Belum diterima (masih piutang)'}:{' '}
                  {formatRupiah(tunaiTarget.saldo - tunaiNilai)}
                </Text>
              )}

              <Text style={styles.hint}>
                Hanya memengaruhi SHU Basis Kas (informasi RAT) di Laporan Hasil Usaha. Tidak membuat jurnal dan tidak
                mengubah SHU akrual, neraca, maupun saldo akun. Bawaan: seluruh saldo awal dianggap sudah tunai, karena
                uangnya sudah termasuk dalam saldo awal Kas/Bank.
              </Text>

              <TouchableOpacity
                style={[styles.postButton, tunaiSubmitting && styles.disabled, { marginTop: spacing.lg }]}
                onPress={submitBagianTunai}
                disabled={tunaiSubmitting}
              >
                {tunaiSubmitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.postButtonText}>Simpan</Text>}
              </TouchableOpacity>
            </ScrollView>
          </AreaAmanKeyboard>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!koreksiTarget} animationType="slide" onRequestClose={() => setKoreksiTarget(null)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>Koreksi Saldo Awal</Text>
            <TouchableOpacity onPress={() => setKoreksiTarget(null)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <AreaAmanKeyboard varian="dialog" style={styles.areaKeyboard}>
          <ScrollView {...PROP_SCROLL_FORM} contentContainerStyle={{ padding: spacing.lg, paddingBottom: RUANG_BAWAH_FORM }}>
            <Text style={styles.label}>Akun</Text>
            <Text style={styles.koreksiAkunNama}>{koreksiTarget?.namaAkun}</Text>

            <Text style={styles.label}>Saldo Saat Ini</Text>
            <Text style={styles.koreksiSaldoLama}>{formatRupiah(koreksiTarget?.saldo ?? 0)}</Text>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Saldo Baru *</Text>
            <CurrencyInput value={koreksiNilaiBaru} onChangeValue={setKoreksiNilaiBaru} />

            <Text style={[styles.label, { marginTop: spacing.md }]}>Alasan Koreksi *</Text>
            <FocusTextInput
              style={styles.textArea}
              value={koreksiAlasan}
              onChangeText={setKoreksiAlasan}
              placeholder="Jelaskan alasan koreksi"
              placeholderTextColor={colors.placeholder}
              multiline
            />

            <Text style={styles.hint}>
              Koreksi akan diposting sebagai jurnal baru (jurnal lama TIDAK diubah/dihapus) — selisihnya sementara masuk
              akun kliring "Saldo Awal Belum Sesuai" sampai akun pasangannya juga dikoreksi.
            </Text>

            <TouchableOpacity
              style={[styles.postButton, koreksiSubmitting && styles.disabled, { marginTop: spacing.lg }]}
              onPress={submitKoreksi}
              disabled={koreksiSubmitting}
            >
              {koreksiSubmitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.postButtonText}>Posting Koreksi</Text>}
            </TouchableOpacity>
          </ScrollView>
          </AreaAmanKeyboard>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  /* ---------- KOP MODUL (tetap terlihat saat daftar digulir) ---------- */
  kop: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  kopBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  kopTeks: { flex: 1, minWidth: 0 },
  kopJudul: { fontSize: 15, fontWeight: '800', color: colors.primary, letterSpacing: 0.3 },
  chipStatus: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12 },
  /* Tiga nada, bukan tiga komponen badge terpisah seperti dulu —
     status saldo awal selalu tepat satu dari tiga, jadi tempatnya di
     layar juga harus tepat satu. */
  chipStatus_netral: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  chipStatus_aktif: { backgroundColor: colors.primary },
  chipStatus_terkunci: { backgroundColor: colors.danger },
  chipStatusText: { fontSize: 9.5, fontWeight: '800', color: colors.white, letterSpacing: 0.3 },
  chipStatusTextNetral: { color: colors.textMuted },

  kemajuanBaris: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: spacing.sm },
  kemajuanTeks: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  kemajuanPersen: { fontSize: 11, color: colors.primary, fontWeight: '800', fontVariant: ['tabular-nums'] },
  kemajuanRel: { height: 5, borderRadius: 3, backgroundColor: colors.border, marginTop: 5, overflow: 'hidden' },
  kemajuanIsi: { height: 5, borderRadius: 3, backgroundColor: colors.primary },
  kemajuanLengkap: { backgroundColor: colors.success },

  peringatanKliring: {
    marginTop: spacing.sm,
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  },
  kartuPengantar: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  pengantarTeks: { fontSize: 11.5, color: colors.textMuted, lineHeight: 17 },
  pengantarStatus: { fontSize: 11.5, color: colors.text, lineHeight: 17, marginTop: spacing.sm, fontWeight: '600' },
  peringatanBaris: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  peringatanJudul: { fontSize: 12, fontWeight: '800', color: colors.text },
  peringatanNominal: { fontSize: 13, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  peringatanTeks: { fontSize: 11, color: colors.text, lineHeight: 16, marginTop: 6 },

  /* ---------- BANNER ---------- */
  /* Satu bentuk banner dengan garis aksen di kiri; dulu dua gaya
     terpisah yang hanya berbeda warna latar. */
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerInfo: { backgroundColor: colors.primaryLight, borderLeftColor: colors.primary },
  bannerIcon: { flexShrink: 0, marginTop: 1 },
  bannerText: { flex: 1, minWidth: 0, fontSize: 11.5, color: colors.text, lineHeight: 17 },

  /* ---------- KARTU PENGATURAN (tanggal, pencarian) ---------- */
  kartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kartuJudul: { fontSize: 12.5, fontWeight: '800', color: colors.text, letterSpacing: 0.2 },
  kartuSub: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 2, marginBottom: spacing.sm },
  nilaiTerkunci: { fontSize: 14, color: colors.textMuted, marginTop: spacing.sm },
  searchInput: { marginTop: spacing.sm },
  filterRow: { flexDirection: 'row', gap: 6, marginTop: spacing.sm, flexWrap: 'wrap' },
  filterChip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 11.5, color: colors.textMuted, fontWeight: '700' },
  filterChipTextActive: { color: colors.white },

  kosong: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  kosongText: { fontSize: 12.5, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },

  /* ---------- KARTU AKUN ---------- */
  /* Dulu satu baris rapat: kode/nama/kategori bertumpuk di kiri,
     kotak nominal terjepit 150px, dua tautan teks kecil di ujung
     kanan. Sekarang kartu bertingkat — identitas akun di atas, kotak
     nominal selebar kartu, aksi sebagai tombol bergaris berikon. */
  akunKartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  akunKartuAktif: { borderLeftWidth: 3, borderLeftColor: colors.success },
  akunKepala: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  akunKepalaSisa: { flex: 1 },
  akunKode: {
    fontSize: 10.5, fontWeight: '800', color: colors.textMuted, fontVariant: ['tabular-nums'],
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2,
  },
  /* §5/§24: kategori tetap info READ-ONLY per baris — bukan header
     section, dan tidak bisa diubah dari layar ini. */
  akunKategori: { fontSize: 9.5, fontWeight: '800', color: colors.primary, letterSpacing: 0.3 },
  tandaAktif: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tandaAktifText: { fontSize: 9.5, fontWeight: '800', color: colors.success, letterSpacing: 0.3 },
  tandaBelum: { fontSize: 9.5, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.3 },
  akunNama: { fontSize: 14, color: colors.text, fontWeight: '600', marginTop: 6, lineHeight: 19 },
  akunLabelNilai: { fontSize: 10.5, color: colors.textMuted, fontWeight: '700', marginTop: spacing.sm, marginBottom: 4 },
  akunAksi: { flexDirection: 'row', gap: 8, marginTop: spacing.sm },
  tunaiBaris: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  tunaiTeks: { flex: 1, fontSize: 11.5, color: colors.textMuted, lineHeight: 16 },
  tunaiUbah: { fontSize: 12, fontWeight: '700', color: colors.primary },
  tombolAksi: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 9, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.primary,
  },
  tombolAksiHapus: { borderColor: colors.danger },
  tombolAksiText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  tombolAksiTextHapus: { color: colors.danger },

  catatanKaki: { fontSize: 10.5, color: colors.textMuted, lineHeight: 15, marginTop: spacing.md, fontStyle: 'italic' },

  /* ---------- FOOTER ---------- */
  /* `flex: 1` di sini yang membuat daftar mengambil SISA tinggi —
     bukan setinggi isinya — sehingga footer selalu punya tempat
     sendiri di bawahnya, tidak menumpuk di atas daftar. */
  daftarGulir: { flex: 1 },
  footer: {
    flexDirection: 'row', gap: 8,
    padding: spacing.lg, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
  draftButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.sm, paddingVertical: 14, borderWidth: 1, borderColor: colors.primary,
  },
  draftButtonText: { color: colors.primary, fontWeight: '700' },
  postButton: { flex: 1, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center' },
  postButtonText: { color: colors.white, fontWeight: '700', letterSpacing: 0.5 },
  disabled: { opacity: 0.5 },

  /* ---------- MODAL ---------- */
  areaKeyboard: { flex: 1 },
  modalBackdrop: { ...modalUi.backdrop, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalText: { fontSize: 13, color: colors.text, marginTop: spacing.sm, marginBottom: spacing.md, lineHeight: 19 },
  modalActions: { ...modalUi.actions },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalConfirmBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.danger, minWidth: 150, alignItems: 'center' },
  modalConfirmText: { color: colors.white, fontWeight: '700' },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface,
  },
  modalHeaderTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  label: { fontSize: 12.5, color: colors.textMuted, fontWeight: '700', marginBottom: 4, marginTop: spacing.md },
  koreksiAkunNama: { fontSize: 15, fontWeight: '700', color: colors.text },
  koreksiSaldoLama: { fontSize: 15, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  textArea: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
});
