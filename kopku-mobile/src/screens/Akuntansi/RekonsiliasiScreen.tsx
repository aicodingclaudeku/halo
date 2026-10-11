import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import AccountPicker from '@/components/AccountPicker';
import FocusTextInput from '@/components/FocusTextInput';
import { RekeningItem } from '@/services/KasBankService';
import {
  catatRekonsiliasiDanTindakLanjut,
  getSaldoBukuPerTanggal,
  listRekonsiliasiDetail,
  type RekonsiliasiDetailRow,
} from '@/services/CashReconciliationService';
import { AccountItem } from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { useNavigation } from '@react-navigation/native';
import {
  buatKunciSubmit,
  ctaRekonsiliasi,
  perluPilihAkun,
  formatTanggalPanjang,
  selisihRingkas,
  hitungSelisih,
  kategoriAkunPenyesuaian,
  labelSelisih,
  labelSaldoEksternal,
  hintSaldoEksternal,
  penjelasanSelisih,
  labelStatusRiwayat,
  labelPenyebabRiwayat,
  statusRiwayat,
  jenisHasilSimpan,
  akibatPenyebab,
  type JenisHasilSimpan,
  type NadaStatus,
  OpsiPenyebab,
  opsiPenyebabUntuk,
  statusSelisih,
  susunTindakLanjut,
} from '@/utils/rekonsiliasiForm';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * RC-S67.9 — REKONSILIASI KAS & BANK (disederhanakan).
 *
 * "Cek apakah saldo saya cocok." Satu layar:
 *   Rekening → Tanggal → Saldo Menurut Buku (ledger PER TANGGAL) →
 *   Saldo eksternal → Selisih (dihitung sistem) → Cocok / Ada Selisih →
 *   (bila ada selisih) Penyebab → Simpan / Catat Penyesuaian.
 *
 * Layar ini tidak menyusun jurnal dan tidak menyentuh database. Pencatatan
 * & penyesuaian lewat `catatRekonsiliasiDanTindakLanjut` (atomik) yang
 * memanggil logika existing `catatRekonsiliasi` + `selesaikanRekonsiliasi`.
 * Istilah internal (DRAFT/SELESAI/PERLU_JURNAL) tidak ditampilkan.
 *
 * RC-S67.9.1 — satu CTA utama per kondisi; 5 penyebab sederhana; akun
 * pencatatan di bagian "Pilih Akun Pencatatan" (RC-S67.9.2: terbuka otomatis
 * untuk penyebab yang membutuhkan penyesuaian) karena
 * service existing mewajibkan akun lawan ditentukan pengurus (belum ada
 * mapping). "Transaksi Belum Tercatat" & "Salah Pencatatan" tidak pernah
 * membuat jurnal — diarahkan ke workflow existing.
 */

function pesanOperator(e: unknown): string {
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ClosedPeriodError') {
    return 'Periode tersebut sudah ditutup dan tidak dapat diubah.';
  }
  const m = e instanceof Error ? e.message : '';
  if (!m || /sqlite|constraint|typeerror|undefined|\bnull\b|stack/i.test(m)) return 'Rekonsiliasi belum dapat disimpan. Silakan coba lagi.';
  return m;
}

export default function RekonsiliasiScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const navigation = useNavigation<any>();

  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [saldoBukuPerTanggal, setSaldoBukuPerTanggal] = useState<number | null>(null);
  const [memuatSaldo, setMemuatSaldo] = useState(false);
  const [galatSaldo, setGalatSaldo] = useState<string | null>(null);
  const [saldoAktual, setSaldoAktual] = useState<number | ''>('');
  const [opsi, setOpsi] = useState<OpsiPenyebab | null>(null);
  const [akun, setAkun] = useState<AccountItem | null>(null);
  const [catatan, setCatatan] = useState('');
  const [galatForm, setGalatForm] = useState<string | null>(null);
  // Hasil simpan terakhir — ditampilkan sebagai kartu status yang jelas.
  // Jenisnya dibaca dari baris yang DIKEMBALIKAN service (jenisHasilSimpan),
  // bukan dari pilihan di layar — sehingga temuan tidak pernah tampil
  // sebagai "Penyesuaian Tercatat".
  const [hasilTerakhir, setHasilTerakhir] = useState<{
    jenis: JenisHasilSimpan;
    nilai: number;
    tanggal: string;
    pintasan?: OpsiPenyebab['pintasanTindakLanjut'];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const kunci = useRef(buatKunciSubmit());

  const [histori, setHistori] = useState<RekonsiliasiDetailRow[]>([]);
  const [loadingHistori, setLoadingHistori] = useState(false);

  const loadHistori = useCallback(async () => {
    if (!rekening) {
      setHistori([]);
      return;
    }
    setLoadingHistori(true);
    try {
      setHistori(await listRekonsiliasiDetail({ accountId: rekening.accountId }));
    } finally {
      setLoadingHistori(false);
    }
  }, [rekening]);

  // Saldo buku SELALU dibaca dari ledger per tanggal rekonsiliasi (bukan saldo saat ini).
  const muatSaldo = useCallback(async () => {
    if (!rekening || !tanggal) {
      setSaldoBukuPerTanggal(null);
      return;
    }
    setMemuatSaldo(true);
    setGalatSaldo(null);
    try {
      setSaldoBukuPerTanggal(await getSaldoBukuPerTanggal(rekening.accountId, tanggal));
    } catch {
      setSaldoBukuPerTanggal(null);
      setGalatSaldo('Saldo buku belum dapat dimuat. Silakan coba lagi.');
    } finally {
      setMemuatSaldo(false);
    }
  }, [rekening, tanggal]);

  useEffect(() => {
    muatSaldo();
  }, [muatSaldo]);

  useFocusRefresh(() => {
    loadHistori();
    muatSaldo();
  }, [loadHistori, muatSaldo]);

  const selisih = saldoBukuPerTanggal === null ? null : hitungSelisih(saldoBukuPerTanggal, saldoAktual);
  const status = selisih === null ? null : statusSelisih(selisih);
  const pilihan = selisih !== null && rekening ? opsiPenyebabUntuk(selisih, rekening.jenis) : [];

  // Arah selisih / rekening berubah → pilihan penyebab & akun lama tidak dibawa.
  // RC-S67.9.2 — rekening, tanggal, atau arah selisih berubah → penyebab,
  // akun, catatan & galat lama TIDAK dibawa (saldo buku dihitung ulang oleh muatSaldo).
  useEffect(() => {
    setOpsi(null);
    setAkun(null);
    setCatatan('');
    setGalatForm(null);
  }, [status, rekening, tanggal]);
  // Ganti rekening → saldo eksternal milik rekening sebelumnya dikosongkan.
  useEffect(() => {
    setSaldoAktual('');
  }, [rekening]);

  // Isian berubah → kartu hasil simpan sebelumnya tidak lagi relevan.
  useEffect(() => {
    if (saldoAktual !== '') setHasilTerakhir(null);
  }, [saldoAktual]);
  useEffect(() => {
    setHasilTerakhir(null);
  }, [rekening, tanggal]);

  const siap = !!rekening && !!tanggal && selisih !== null && !memuatSaldo && !galatSaldo;
  // SATU CTA utama per kondisi — dihitung fungsi murni `ctaRekonsiliasi`
  // (selalu memberi pesan saat nonaktif).
  const cta = ctaRekonsiliasi({ siap, selisih, opsi, akun, catatan });

  /**
   * RC-S80 — mengembalikan `true` HANYA bila pemeriksaan benar-benar
   * tersimpan. CTA "Simpan Temuan & Buka ..." memakai nilai ini untuk
   * memutuskan apakah boleh berpindah layar: temuan harus tercatat
   * lebih dulu, karena kalau pengguna berpindah lalu tidak jadi
   * mengoreksi apa pun, penyebabnya hilang tanpa jejak.
   */
  const simpan = async (): Promise<boolean> => {
    if (!siap || !rekening || !currentUser || selisih === null || saldoAktual === '' || kunci.current.sibuk) return false;
    const t = susunTindakLanjut(selisih, { opsi, akun, catatan });
    if (!t.ok) {
      setGalatForm(t.galat);
      return false;
    }
    setGalatForm(null);
    setSubmitting(true);
    try {
      const r = await kunci.current.jalankan(() =>
        catatRekonsiliasiDanTindakLanjut({
          accountId: rekening.accountId,
          namaRekening: rekening.nama,
          tanggal,
          saldoFisik: saldoAktual,
          keterangan: catatan.trim() || undefined,
          createdBy: currentUser.id,
          tindakLanjut: t.tindakLanjut,
        })
      );
      // Ditolak kunci single-flight: TIDAK dianggap tersimpan, jadi
      // tidak boleh memicu navigasi.
      if (r.status === 'DIABAIKAN') return false;
      const h = r.hasil;
      const jenis = jenisHasilSimpan(h);
      if (jenis === 'COCOK') {
        notify('Rekonsiliasi Tersimpan', 'Saldo buku dan saldo eksternal cocok. Tidak diperlukan penyesuaian.');
      } else if (jenis === 'PENYESUAIAN') {
        notify('Penyesuaian Tercatat', `Penyesuaian sebesar ${formatRupiah(Math.abs(h.selisih))} berhasil dicatat.`);
      } else if (jenis === 'DIJELASKAN') {
        notify('Selisih Dijelaskan', 'Penjelasan selisih tersimpan. Tidak ada jurnal yang dibuat.');
      } else {
        notify('Temuan Tersimpan', 'Status: Belum Ditindaklanjuti. Selesaikan tindak lanjutnya, lalu lakukan rekonsiliasi ulang.');
      }
      setHasilTerakhir({
        jenis,
        nilai: Math.abs(h.selisih),
        tanggal: h.tanggal,
        pintasan: jenis === 'TEMUAN' ? opsi?.pintasanTindakLanjut : undefined,
      });
      setSaldoAktual('');
      setOpsi(null);
      setAkun(null);
      setCatatan('');
      await Promise.all([loadHistori(), muatSaldo()]);
      return true;
    } catch (e) {
      notify('Rekonsiliasi gagal disimpan', pesanOperator(e));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const jalankanCta = () => {
    if (!cta.aktif) return;
    if (cta.aksi === 'SIMPAN') {
      void simpan();
      return;
    }
  };

  /**
   * Pintasan tindak lanjut — HANYA dirender di kartu hasil, yang baru
   * ada setelah `simpan()` berhasil. Jadi berpindah layar tidak pernah
   * mendahului tersimpannya temuan (invariant RC-S80 tetap berlaku).
   */
  const bukaPintasan = (tujuan: 'TRANSAKSI' | 'RIWAYAT') => {
    if (tujuan === 'TRANSAKSI') navigation.navigate('TransaksiHub');
    else navigation.navigate('Laporan', { screen: 'HistoryTransaksi', initial: false });
  };

  const ls = selisih === null ? null : labelSelisih(selisih);

  return (
    <AreaAmanKeyboard varian="layar" style={styles.container}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={styles.scrollContent}>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
          <Text style={styles.infoText}>
            Bandingkan saldo menurut buku dengan saldo eksternal (hasil kas opname, atau saldo rekening koran bank).
            Kopku menghitung selisihnya; penyesuaian hanya dicatat untuk penyebab yang memang memerlukan jurnal.
          </Text>
        </View>

        {/* LANGKAH 1 — rekening & tanggal */}
        <View style={styles.card}>
          <JudulLangkah nomor={1} judul="Rekening & Tanggal" />
          <RekeningPicker label="Rekening" value={rekening} onChange={setRekening} labelSaldo="Saldo saat ini" />
          {rekening ? (
            <>
              <Text style={styles.label}>Tanggal Rekonsiliasi</Text>
              <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />
            </>
          ) : (
            <Text style={styles.hint}>Pilih rekening Kas atau Bank yang akan direkonsiliasi.</Text>
          )}
        </View>

        {rekening ? (
          <>
            {/* LANGKAH 2 — perbandingan saldo */}
            <View style={styles.card}>
              <JudulLangkah nomor={2} judul="Perbandingan Saldo" />

              <Text style={styles.caption}>SALDO MENURUT BUKU PER {formatTanggalPanjang(tanggal).toUpperCase()}</Text>
              {memuatSaldo ? (
                <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start', marginVertical: spacing.sm }} />
              ) : galatSaldo ? (
                <TouchableOpacity accessibilityRole="button" onPress={muatSaldo}>
                  <Text style={styles.errorText}>{galatSaldo} Ketuk untuk memuat ulang.</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.nilaiBesar}>{saldoBukuPerTanggal === null ? '-' : formatRupiah(saldoBukuPerTanggal)}</Text>
              )}
              <Text style={styles.hint}>Saldo dihitung berdasarkan transaksi sampai tanggal rekonsiliasi.</Text>

              {/* RC-S79 — label menyebut DOKUMEN SUMBERNYA. Kolom database tetap `saldo_fisik`. */}
              <Text style={[styles.caption, { marginTop: spacing.lg }]}>
                {labelSaldoEksternal(rekening.jenis).toUpperCase()}
              </Text>
              <CurrencyInput value={saldoAktual} onChangeValue={setSaldoAktual} />
              <Text style={styles.hint}>{hintSaldoEksternal(rekening.jenis)}</Text>

              <View style={styles.pemisah} />
              <Text style={styles.caption}>HASIL REKONSILIASI</Text>
              <View style={styles.hasilBaris}>
                <Text style={styles.readonlyJudul}>{ls ? ls.judul : 'Isi saldo eksternal untuk menghitung selisih'}</Text>
                {ls && ls.nilai > 0 ? (
                  <Text style={[styles.nilaiSedang, { color: status === 'KURANG' ? colors.danger : colors.primary }]}>
                    {formatRupiah(ls.nilai)}
                  </Text>
                ) : null}
              </View>
              {selisih !== null ? <Text style={styles.hint}>{penjelasanSelisih(selisih)}</Text> : null}
            </View>

            {status === 'COCOK' ? (
              <View style={[styles.statusCard, styles.statusOk]}>
                <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusJudul}>Saldo Cocok</Text>
                  <Text style={styles.statusSub}>Saldo buku dan saldo eksternal sama. Tidak diperlukan penyesuaian.</Text>
                </View>
              </View>
            ) : null}

            {status === 'KURANG' || status === 'LEBIH' ? (
              <>
                <View style={[styles.statusCard, styles.statusWarn]}>
                  <Ionicons name="warning" size={22} color={colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.statusJudul}>Ada Selisih</Text>
                    <Text style={styles.statusSub}>
                      {ls?.judul} {formatRupiah(ls?.nilai ?? 0)}. Tentukan penyebabnya di bawah.
                    </Text>
                  </View>
                </View>

                {/* LANGKAH 3 — penyebab & tindak lanjut */}
                <View style={styles.card}>
                  <JudulLangkah nomor={3} judul="Penyebab & Tindak Lanjut" />
                  <Text style={styles.labelTanpaJarak}>Kenapa ada selisih?</Text>
                  {pilihan.map((o) => {
                    const aktif = opsi?.kode === o.kode;
                    const akibat = akibatPenyebab(o);
                    return (
                      <TouchableOpacity
                        key={o.kode}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: aktif }}
                        style={[styles.opsiRow, aktif && styles.opsiRowAktif]}
                        onPress={() => {
                          setOpsi(o);
                          setAkun(null);
                          setGalatForm(null);
                        }}
                      >
                        <Ionicons
                          name={aktif ? 'radio-button-on' : 'radio-button-off'}
                          size={18}
                          color={aktif ? colors.primary : colors.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.opsiText, aktif && styles.opsiTextAktif]}>{o.label}</Text>
                          <Text style={styles.opsiDeskripsi}>{o.deskripsi}</Text>
                          <Text style={[styles.chip, gayaNada(akibat.nada).chip]}>{akibat.tag}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  <Text style={styles.hint}>Pilih penyebab yang paling sesuai. Kopku akan menentukan tindakan pencatatan yang diperlukan.</Text>

                  {/* TINDAK LANJUT — isi & warna mengikuti akibat penyebab di service:
                      temuan (Belum Ditindaklanjuti), dijelaskan tanpa jurnal, atau penyesuaian. */}
                  {opsi ? (
                    <View style={[styles.tindakLanjutBox, gayaNada(akibatPenyebab(opsi).nada).box]}>
                      <View style={styles.tindakLanjutHeader}>
                        <Ionicons
                          name={akibatPenyebab(opsi).nada === 'WARN' ? 'flag-outline' : akibatPenyebab(opsi).nada === 'INFO' ? 'time-outline' : 'create-outline'}
                          size={18}
                          color={gayaNada(akibatPenyebab(opsi).nada).warna}
                        />
                        <Text style={[styles.tindakLanjutJudul, { color: gayaNada(akibatPenyebab(opsi).nada).warna }]}>Tindak Lanjut</Text>
                      </View>
                      <Text style={styles.statusSub}>{opsi.tindakLanjut}</Text>
                      <View style={styles.statusSetelah}>
                        <Text style={styles.statusSetelahLabel}>Status setelah disimpan</Text>
                        <Text style={[styles.statusSetelahNilai, { color: gayaNada(akibatPenyebab(opsi).nada).warna }]}>
                          {akibatPenyebab(opsi).statusSetelahSimpan}
                        </Text>
                      </View>
                    </View>
                  ) : null}

                  {perluPilihAkun(opsi) && opsi && selisih !== null ? (
                    <>
                      <View style={styles.akunSection}>
                        <Text style={styles.akunJudul}>Pilih Akun Pencatatan</Text>
                        <Text style={styles.hint}>Pilih akun yang sesuai untuk mencatat selisih ini.</Text>
                        <AccountPicker
                          value={akun}
                          onChange={(a: AccountItem) => {
                            setAkun(a);
                            setGalatForm(null);
                          }}
                          filterKategori={kategoriAkunPenyesuaian(selisih)}
                          label={selisih < 0 ? 'Akun beban *' : 'Akun pendapatan *'}
                        />
                        <Text style={styles.hint}>
                          Kopku akan {selisih < 0 ? 'mengurangi' : 'menambah'} saldo {rekening.nama} di buku sebesar {formatRupiah(Math.abs(selisih))}.
                        </Text>
                      </View>
                    </>
                  ) : null}

                  {/* Catatan WAJIB untuk setiap penyebab (service menolaknya
                      bila kosong) — karena itu kolomnya tampil untuk semua
                      penyebab, bukan hanya penyesuaian. */}
                  {opsi ? (
                    <>
                      <Text style={styles.label}>Catatan *</Text>
                      <FocusTextInput
                        style={styles.inputMultiline}
                        value={catatan}
                        onChangeText={setCatatan}
                        multiline
                        placeholder={
                          opsi.tindakan === 'PENYESUAIAN'
                            ? 'Contoh: biaya administrasi Agustus, ref. rekening koran hal. 3'
                            : 'Jelaskan temuan dan rencana tindak lanjutnya'
                        }
                        placeholderTextColor={colors.placeholder}
                      />
                    </>
                  ) : null}
                </View>
              </>
            ) : null}

            {hasilTerakhir ? (
              <View style={[styles.statusCard, gayaNada(nadaHasil(hasilTerakhir.jenis)).box]}>
                <Ionicons
                  name={hasilTerakhir.jenis === 'TEMUAN' ? 'flag' : 'checkmark-circle'}
                  size={22}
                  color={gayaNada(nadaHasil(hasilTerakhir.jenis)).warna}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusJudul}>
                    {hasilTerakhir.jenis === 'COCOK'
                      ? 'Rekonsiliasi Tersimpan'
                      : hasilTerakhir.jenis === 'PENYESUAIAN'
                        ? 'Penyesuaian Tercatat'
                        : hasilTerakhir.jenis === 'DIJELASKAN'
                          ? 'Selisih Dijelaskan'
                          : 'Temuan Tersimpan'}
                  </Text>
                  <Text style={styles.statusSub}>
                    {hasilTerakhir.jenis === 'COCOK'
                      ? 'Saldo buku dan saldo eksternal cocok. Tidak diperlukan penyesuaian.'
                      : hasilTerakhir.jenis === 'PENYESUAIAN'
                        ? `Penyesuaian sebesar ${formatRupiah(hasilTerakhir.nilai)} berhasil dicatat. Silakan lakukan rekonsiliasi kembali setelah saldo diperbarui.`
                        : hasilTerakhir.jenis === 'DIJELASKAN'
                          ? `Selisih ${formatRupiah(hasilTerakhir.nilai)} tersimpan sebagai selisih yang dijelaskan. Tidak ada jurnal yang dibuat.`
                          : `Selisih ${formatRupiah(hasilTerakhir.nilai)} tersimpan dengan status Belum Ditindaklanjuti. Selesaikan tindak lanjutnya, lalu lakukan rekonsiliasi ulang.`}
                  </Text>
                  {hasilTerakhir.pintasan ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={styles.pintasan}
                      onPress={() => hasilTerakhir.pintasan && bukaPintasan(hasilTerakhir.pintasan.tujuan)}
                    >
                      <Text style={styles.linkText}>{hasilTerakhir.pintasan.label}</Text>
                      <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ) : null}

            {galatForm ? <Text style={styles.errorText}>{galatForm}</Text> : null}

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: !cta.aktif || submitting }}
              style={[styles.submitButton, (!cta.aktif || submitting) && styles.disabled]}
              onPress={jalankanCta}
              disabled={!cta.aktif || submitting}
            >
              {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>{cta.label}</Text>}
            </TouchableOpacity>
            {cta.pesan && !submitting ? <Text style={styles.ctaPesan}>{cta.pesan}</Text> : null}

            {/* RIWAYAT — setiap baris selalu menampilkan Penyebab + Status
                Penyelesaian, dibaca apa adanya dari database. */}
            <View style={styles.riwayatHeader}>
              <Text style={styles.sectionLabel}>Riwayat Rekonsiliasi {rekening.nama}</Text>
              {histori.length > 0 ? <Text style={styles.riwayatJumlah}>{histori.length} pemeriksaan</Text> : null}
            </View>
            {loadingHistori ? <ActivityIndicator style={{ marginTop: spacing.md }} /> : null}
            {!loadingHistori && histori.length === 0 ? (
              <Text style={styles.emptyText}>Belum ada rekonsiliasi untuk rekening ini.</Text>
            ) : null}
            {!loadingHistori &&
              histori.map((r) => {
                const st = statusRiwayat(r);
                const g = gayaNada(st.nada);
                return (
                  <View key={r.id} style={[styles.historiCard, { borderLeftColor: g.warna }]}>
                    <View style={styles.historiAtas}>
                      <Text style={styles.historiTanggal} numberOfLines={1}>
                        {formatTanggalPanjang(r.tanggal)}
                      </Text>
                      <Text style={[styles.chip, g.chip]}>{labelStatusRiwayat(r)}</Text>
                    </View>

                    <View style={styles.historiGrid}>
                      <View style={styles.historiKolom}>
                        <Text style={styles.historiKolomLabel}>Saldo Buku</Text>
                        <Text style={styles.historiKolomNilai}>{formatRupiah(r.saldoBuku)}</Text>
                      </View>
                      <View style={styles.historiKolom}>
                        <Text style={styles.historiKolomLabel} numberOfLines={1}>{labelSaldoEksternal(rekening.jenis)}</Text>
                        <Text style={styles.historiKolomNilai}>{formatRupiah(r.saldoFisik)}</Text>
                      </View>
                      <View style={[styles.historiKolom, { alignItems: 'flex-end' }]}>
                        <Text style={styles.historiKolomLabel}>Selisih</Text>
                        <Text style={[styles.historiKolomNilai, r.selisih < 0 && { color: colors.danger }]}>
                          {selisihRingkas(r.selisih, formatRupiah)}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.historiMeta}>
                      <Text style={styles.historiMetaBaris}>
                        <Text style={styles.historiMetaLabel}>Penyebab: </Text>
                        {labelPenyebabRiwayat(r.penyebab) ?? st.penyebab}
                      </Text>
                      <Text style={styles.historiMetaBaris}>
                        <Text style={styles.historiMetaLabel}>Status Penyelesaian: </Text>
                        <Text style={{ color: g.warna, fontWeight: '700' }}>{st.status}</Text>
                      </Text>
                      {r.keterangan ? (
                        <Text style={styles.historiCatatan} numberOfLines={3}>
                          “{r.keterangan}”
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
          </>
        ) : null}
      </ScrollView>
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

/** Warna per nada status — hanya token tema yang sudah ada. */
function gayaNada(nada: NadaStatus): { warna: string; chip: { backgroundColor: string; color: string }; box: { backgroundColor: string; borderColor: string } } {
  if (nada === 'OK') {
    return { warna: colors.success, chip: { backgroundColor: colors.primaryLight, color: colors.success }, box: { backgroundColor: colors.primaryLight, borderColor: colors.border } };
  }
  if (nada === 'INFO') {
    return { warna: colors.primary, chip: { backgroundColor: colors.background, color: colors.primary }, box: { backgroundColor: colors.surface, borderColor: colors.primary } };
  }
  return { warna: colors.warning, chip: { backgroundColor: colors.warningBg, color: colors.warning }, box: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder } };
}

function nadaHasil(jenis: JenisHasilSimpan): NadaStatus {
  return jenis === 'TEMUAN' ? 'WARN' : jenis === 'DIJELASKAN' ? 'INFO' : 'OK';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl * 4 },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.md },
  caption: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  nilaiBesar: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 2 },
  nilaiSedang: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 },
  opsiDeskripsi: { fontSize: 11, color: colors.textMuted, marginTop: 1, lineHeight: 15 },
  tindakLanjutJudul: { fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: 2 },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.xl, marginBottom: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  infoBox: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.lg },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  readonlyJudul: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  statusCard: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.lg, borderWidth: 1 },
  statusOk: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  statusWarn: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  statusJudul: { fontSize: 15, fontWeight: '700', color: colors.text },
  statusSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  opsiRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, marginBottom: spacing.xs },
  opsiRowAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  opsiText: { flex: 1, fontSize: 13, color: colors.text },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  submitButton: { flexDirection: 'row', gap: 8, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  historiTanggal: { fontSize: 13, fontWeight: '600', color: colors.text },
  akunSection: { marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: colors.surface },
  akunJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  ctaPesan: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
  linkText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
  emptyText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.sm },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  langkahHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  langkahNomor: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  langkahNomorText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  langkahJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  labelTanpaJarak: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  pemisah: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  hasilBaris: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' },
  opsiTextAktif: { fontWeight: '700', color: colors.primary },
  chip: { alignSelf: 'flex-start', fontSize: 10.5, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden', marginTop: 4 },
  tindakLanjutBox: { borderWidth: 1, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  tindakLanjutHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  statusSetelah: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, flexWrap: 'wrap' },
  statusSetelahLabel: { fontSize: 11, color: colors.textMuted },
  statusSetelahNilai: { fontSize: 12, fontWeight: '700' },
  pintasan: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm, alignSelf: 'flex-start' },
  riwayatHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  riwayatJumlah: { fontSize: 11, color: colors.textMuted },
  historiCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.sm },
  historiAtas: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  historiGrid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  historiKolom: { flex: 1, minWidth: 0 },
  historiKolomLabel: { fontSize: 10.5, color: colors.textMuted },
  historiKolomNilai: { fontSize: 12.5, fontWeight: '600', color: colors.text, marginTop: 1 },
  historiMeta: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  historiMetaBaris: { fontSize: 12, color: colors.text },
  historiMetaLabel: { color: colors.textMuted },
  historiCatatan: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginTop: 2 },
});
