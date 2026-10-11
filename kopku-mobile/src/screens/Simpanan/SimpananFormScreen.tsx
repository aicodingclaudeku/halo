import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM, RUANG_BAWAH_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AnggotaPicker from '@/components/AnggotaPicker';
import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { getKebijakanProdukUntukTanggal } from '@/services/SimpananBerjangkaKebijakanProdukService';
import {
  KebijakanProdukBerjangka,
  PESAN_KEBIJAKAN_PRODUK_BELUM_ADA,
  ringkasanPerlakuanPascaJatuhTempo,
} from '@/accounting/SimpananBerjangkaKebijakanProduk';
import {
  TENOR_SIMPANAN_BERJANGKA,
  TenorSimpananBerjangka,
  hitungTanggalJatuhTempo,
} from '@/accounting/SimpananBerjangkaTenor';
import { buatJadwalBungaSimpananBerjangka, hitungTotalBungaKontrak } from '@/accounting/SimpananBerjangkaBunga';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import CaraKerjaBerjangka from '@/components/simpanan/CaraKerjaBerjangka';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import RekeningPicker from '@/components/RekeningPicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem } from '@/services/KasBankService';
import { Anggota } from '@/repositories/AnggotaRepository';
import { catatDataAwalSimpanan, cekStatusSimpananPokok } from '@/services/SimpananService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';
import KartuLangkah from '@/components/form/KartuLangkah';
import KotakInfo from '@/components/form/KotakInfo';
import PilihanOpsi, { type OpsiPilihan } from '@/components/form/PilihanOpsi';
import RingkasanTransaksi from '@/components/form/RingkasanTransaksi';
import TombolUtama from '@/components/form/TombolUtama';

/**
 * "Setor Simpanan" (menu Penerimaan) — PRD §8-10 + Revisi KOPKU Bagian
 * 5-13.
 *
 * PERBAIKAN: "Data Awal Simpanan Anggota" BUKAN transaksi/menu
 * terpisah — itu sebenarnya fungsi Setor Simpanan juga (mengisi
 * Pokok/Wajib/Sukarela anggota, entah anggota baru atau top-up
 * bulanan). Sebelumnya ada DUA layar/menu untuk hal yang sama
 * (SimpananFormScreen dgn chip satu-jenis, dan
 * DataAwalSimpananFormScreen dgn tiga field sekaligus) — sekarang
 * DIGABUNG jadi SATU layar ini, dipanggil dari SATU menu "Setor
 * Simpanan". DataAwalSimpananFormScreen & route
 * "DataAwalSimpananForm" sudah dihapus (lihat RootNavigator.tsx &
 * TransaksiPenerimaanScreen.tsx) — tidak dipakai fungsi lain apa pun
 * di aplikasi ini.
 *
 * SATU form, SATU submit: Simpanan Pokok + Wajib + Sukarela sekaligus
 * (Bagian 5.1/5.5) — pengguna cukup buka "Setor Simpanan", tidak perlu
 * pindah ke menu lain. Sukarela boleh dikosongkan (0) (Bagian 5.4).
 * Wajib/Sukarela-saja (mis. setoran bulanan rutin anggota yang
 * Pokoknya sudah tercatat) tetap bisa dilakukan di form yang sama —
 * cukup isi field yang relevan, sisanya dibiarkan kosong.
 *
 * Submit memanggil `SimpananService.catatDataAwalSimpanan` — service
 * ini TIDAK diubah sama sekali (masih fungsi yang sama persis, cuma
 * sekarang dipanggil dari satu pintu UI, bukan dua) — SATU jurnal,
 * atomic, rollback penuh kalau ada yang gagal (lihat komentar di
 * service). Tidak membuat service baru.
 *
 * SIMPANAN POKOK SATU KALI (Bagian 4/5.2/12): begitu anggota dipilih,
 * status Pokok-nya dicek lewat `cekStatusSimpananPokok`. Kalau sudah
 * ada, field Pokok ditampilkan sebagai saldo existing (read-only) dan
 * TIDAK ikut dikirim ke service (`pokok: 0` — service juga menolak
 * kalau tetap dikirim >0, jadi ini pertahanan berlapis).
 *
 * Field Wajib/Sukarela TETAP bisa diisi kapan pun (termasuk kalau
 * Pokok anggota ini sudah ada dari sebelumnya).
 *
 * Fitur Tarik Simpanan TIDAK disentuh — tetap di
 * TarikSimpananFormScreen (menu Pengeluaran), servicenya
 * (tarikSimpananSukarela) tidak berubah.
 */
export default function SimpananFormScreen({ route }: { route?: any }) {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());

  const [pokokSudahAda, setPokokSudahAda] = useState(false);
  const [pokokExisting, setPokokExisting] = useState(0);
  const [cekPokokLoading, setCekPokokLoading] = useState(false);

  const [pokok, setPokok] = useState<number | ''>('');
  const [wajib, setWajib] = useState<number | ''>('');
  const [sukarela, setSukarela] = useState<number | ''>('');

  // ============================================================
  // JENIS SIMPANAN — Reguler vs Berjangka
  // ============================================================
  // CATATAN DESAIN (penting, dan sengaja tidak disembunyikan):
  // requirement menyebut empat chip terpisah [Pokok][Wajib][Sukarela]
  // [Berjangka]. Membuat keempatnya saling eksklusif akan MERUSAK
  // perilaku existing yang sudah berjalan: layar ini sejak awal
  // mencatat Pokok + Wajib + Sukarela SEKALIGUS dalam SATU submit lewat
  // `catatDataAwalSimpanan()` (satu jurnal, satu transaksi). Memaksa
  // pilih-satu berarti anggota harus submit tiga kali dan menghasilkan
  // tiga jurnal — perubahan lifecycle yang tidak diminta dan justru
  // dilarang ("POKOK/WAJIB/SUKARELA tetap memakai field/lifecycle
  // existing").
  //
  // Karena itu pemisahannya di level JALUR TRANSAKSI, bukan di level
  // jenis: 'REGULER' = form lama persis apa adanya; 'BERJANGKA' = form
  // kontrak deposito. Keduanya tidak pernah tampil bersamaan, sehingga
  // field berjangka tidak pernah mengganggu jenis lain.
  /**
   * MODE DITENTUKAN PEMANGGIL, DAN TIDAK DAPAT DIUBAH DI DALAM FORM
   * (RC-S47 §B/§C).
   *
   * RC-S46 memperkenalkan parameter ini sebagai penentu chip mana yang
   * AKTIF saat form dibuka — pengguna masih boleh berpindah mode. Itu
   * menyisakan masalah yang justru menjadi pokok RC-S47: ada DUA tempat
   * berbeda yang sama-sama dapat membuat kontrak simpanan berjangka.
   * Jalur "Setor Simpanan" (Penerimaan › Setor Simpanan › FAB) memakai
   * form yang sama, dan chip "Berjangka" di dalamnya membuat jalur
   * reguler berakhir pada pembukaan kontrak — sesuatu yang bukan
   * setoran, punya tenor & jatuh tempo, dan subledger-nya sendiri.
   *
   * Sekarang mode adalah KONSTANTA dari parameter rute:
   *
   *   dibuka dari SimpananHistori (Setor Simpanan)  -> REGULER
   *   dibuka dari SimpananBerjangkaHistori + mode   -> BERJANGKA
   *
   * Tidak ada chip pemindah mode. Konsekuensinya: chip Pokok/Wajib/
   * Sukarela tidak pernah muncul di jalur berjangka, dan sebaliknya —
   * satu pintu masuk per domain (§S).
   *
   * Yang TIDAK berubah: `setorSimpananBerjangka()`,
   * `catatDataAwalSimpanan()`, seluruh validasi, dan seluruh jurnal.
   * Ini murni pemisahan jalur UI.
   */
  const mode: 'REGULER' | 'BERJANGKA' =
    route?.params?.mode === 'BERJANGKA' ? 'BERJANGKA' : 'REGULER';

  const [berjangkaNominal, setBerjangkaNominal] = useState<number | ''>('');
  const [tenor, setTenor] = useState<TenorSimpananBerjangka | null>(null);
  // String, BUKAN number: supaya field benar-benar terasa opsional —
  // kosong tetap kosong, tidak otomatis menampilkan "0" atau "0.00%".
  const [sukuBunga, setSukuBunga] = useState('');

  // RC-S128 — kebijakan produk yang berlaku pada TANGGAL PENEMPATAN.
  // Hanya untuk ditampilkan; validasi sesungguhnya ada di service.
  const [kebijakanBerlaku, setKebijakanBerlaku] = useState<KebijakanProdukBerjangka | null | undefined>(undefined);
  useEffect(() => {
    if (mode !== 'BERJANGKA' || !tanggal) return;
    let batal = false;
    getKebijakanProdukUntukTanggal(tanggal)
      .then((k) => !batal && setKebijakanBerlaku(k))
      .catch(() => !batal && setKebijakanBerlaku(null));
    return () => {
      batal = true;
    };
  }, [mode, tanggal]);

  const [sumberDana, setSumberDana] = useState<'KAS' | 'BANK'>('KAS');
  const [bankRekening, setBankRekening] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Begitu anggota dipilih (atau diganti) -> cek status Pokok & reset
  // field2 nominal supaya tidak tertinggal data anggota sebelumnya.
  useEffect(() => {
    setPokok('');
    setWajib('');
    setSukarela('');
    setBerjangkaNominal('');
    setTenor(null);
    setSukuBunga('');
    setErrors({});
    if (!anggota) {
      setPokokSudahAda(false);
      setPokokExisting(0);
      return;
    }
    setCekPokokLoading(true);
    cekStatusSimpananPokok(anggota.id)
      .then((status) => {
        setPokokSudahAda(status.sudahAda);
        setPokokExisting(status.nominal);
      })
      .finally(() => setCekPokokLoading(false));
  }, [anggota?.id]);

  const pokokNum = pokok === '' ? 0 : pokok;
  const wajibNum = wajib === '' ? 0 : wajib;
  const sukarelaNum = sukarela === '' ? 0 : sukarela;
  const total = (pokokSudahAda ? 0 : pokokNum) + wajibNum + sukarelaNum;

  // §13 PREVIEW JATUH TEMPO — dihitung dengan helper bulan KALENDER
  // yang sama dengan service, bukan tenor x 30 hari, sehingga tanggal
  // yang dilihat anggota di layar PERSIS sama dengan yang tersimpan.
  const jatuhTempoPreview =
    mode === 'BERJANGKA' && tanggal && tenor ? hitungTanggalJatuhTempo(tanggal, tenor) : null;

  // RC-S129 — angka ringkasan penempatan. Suku bunga kosong = tanpa bunga
  // (sama dengan service); isian tidak valid -> null (ditolak validate()).
  const rateTampil: number | null = (() => {
    if (sukuBunga.trim() === '') return 0;
    const r = Number(sukuBunga.replace(',', '.'));
    return Number.isFinite(r) && r >= 0 ? r : null;
  })();
  // Perkiraan dari helper akuntansi yang SAMA dengan akrual; tidak ada rumus di layar.
  const estimasiBunga = (() => {
    if (mode !== 'BERJANGKA' || !tenor || !tanggal || berjangkaNominal === '' || !rateTampil) return null;
    try {
      return {
        total: hitungTotalBungaKontrak(berjangkaNominal, rateTampil, tenor),
        perBulan: buatJadwalBungaSimpananBerjangka(berjangkaNominal, rateTampil, tenor, tanggal)[0].bunga,
      };
    } catch {
      return null;
    }
  })();

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!anggota) e.anggota = 'Anggota wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    if (mode === 'REGULER') {
      if (total <= 0) e.total = 'Isi minimal salah satu dari Simpanan Pokok, Wajib, atau Sukarela';
    } else {
      const nominal = berjangkaNominal === '' ? 0 : berjangkaNominal;
      if (nominal <= 0) e.berjangkaNominal = 'Nominal simpanan berjangka wajib diisi';
      // §11: tenor tidak boleh kosong — submit ditolak, bukan diam-diam
      // memilih default.
      if (tenor === null) e.tenor = 'Tenor wajib dipilih';
      if (sukuBunga.trim() !== '') {
        const rate = Number(sukuBunga.replace(',', '.'));
        if (!Number.isFinite(rate)) e.sukuBunga = 'Suku bunga harus berupa angka';
        else if (rate < 0) e.sukuBunga = 'Suku bunga tidak boleh negatif';
      }
    }
    if (sumberDana === 'BANK' && !bankRekening) e.bankRekening = 'Bank wajib dipilih';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !anggota || !currentUser) return;
    setSubmitting(true);
    try {
      if (mode === 'BERJANGKA') {
        const hasilBerjangka = await setorSimpananBerjangka({
          anggotaId: anggota.id,
          nominal: berjangkaNominal === '' ? 0 : berjangkaNominal,
          tanggal,
          tenorBulan: tenor as TenorSimpananBerjangka,
          // Kosong -> undefined -> service menyimpan 0. Tidak ada "0"
          // yang dikarang di layer UI.
          sukuBungaPerTahun:
            sukuBunga.trim() === '' ? undefined : Number(sukuBunga.replace(',', '.')),
          sumberDana,
          bankAccountId: sumberDana === 'BANK' ? bankRekening?.id : undefined,
          keterangan: keterangan || undefined,
          createdBy: currentUser.id,
        });
        notify(
          'Berhasil',
          `Simpanan berjangka ${tenor} bulan tersimpan (kebijakan produk versi ${'policyVersi' in hasilBerjangka ? hasilBerjangka.policyVersi : '-'}). ` +
            `Jatuh tempo ${hasilBerjangka.tanggalJatuhTempo}. Bukti penempatan dapat dicetak dari detail kontrak.`,
          [
            { text: 'Selesai', onPress: () => navigation.goBack() },
            {
              text: 'Lihat & Cetak Bukti',
              onPress: () => navigation.navigate('SimpananBerjangkaDetail', { kontrakId: hasilBerjangka.id }),
            },
          ]
        );
        return;
      }
      const hasil = await catatDataAwalSimpanan({
        anggotaId: anggota.id,
        tanggal,
        pokok: pokokSudahAda ? 0 : pokokNum,
        wajib: wajibNum,
        sukarela: sukarelaNum,
        sumberDana,
        bankAccountId: sumberDana === 'BANK' ? bankRekening?.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      const bagian: string[] = [];
      if (hasil.pokok > 0) bagian.push(`Pokok ${formatRupiah(hasil.pokok)}`);
      if (hasil.wajib > 0) bagian.push(`Wajib ${formatRupiah(hasil.wajib)}`);
      if (hasil.sukarela > 0) bagian.push(`Sukarela ${formatRupiah(hasil.sukarela)}`);
      notify('Berhasil', `Setoran simpanan tersimpan: ${bagian.join(', ')}.`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // ------------------------------------------------------------------
  // Elemen isian yang DIPAKAI BERSAMA kedua jalur. Didefinisikan sekali
  // supaya REGULER tetap persis seperti sebelumnya, sementara BERJANGKA
  // (RC-S129) menyusunnya ke dalam kartu langkah bernomor.
  // ------------------------------------------------------------------
  const elAnggota = <AnggotaPicker value={anggota} onChange={setAnggota} error={errors.anggota} />;
  const elTanggal = (
    <>
      <Text style={styles.label}>{mode === 'BERJANGKA' ? 'Tanggal Penempatan *' : 'Tanggal *'}</Text>
      <View style={{ marginBottom: spacing.md }}>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />
      </View>
    </>
  );
  const elBank = (
    <>
      {sumberDana === 'BANK' && (
        <RekeningPicker label="Bank" value={bankRekening} onChange={setBankRekening} hanyaBank />
      )}
      {sumberDana === 'BANK' && errors.bankRekening && <Text style={styles.errorText}>{errors.bankRekening}</Text>}
    </>
  );
  const elKeterangan = (
    <>
      <Text style={[styles.label, { marginTop: spacing.md }]}>{mode === 'BERJANGKA' ? 'Keterangan (opsional)' : 'Keterangan'}</Text>
      <FocusTextInput
        style={styles.inputMultiline}
        value={keterangan}
        onChangeText={setKeterangan}
        multiline
        placeholder={mode === 'BERJANGKA' ? 'Mis. nomor bilyet / catatan penempatan' : undefined}
        placeholderTextColor={colors.placeholder}
      />
    </>
  );
  const pilihKas = () => {
    setSumberDana('KAS');
    setBankRekening(null);
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: RUANG_BAWAH_FORM }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu).

            RC-S123 — HANYA untuk jalur BERJANGKA. Riwayat Setor Simpanan
            (SIMPANAN_SETOR) DIPINDAH ke layar Simpanan (SimpananHistoriScreen,
            segmen "Riwayat") atas permintaan pengguna: di sini ia tersembunyi
            di balik tombol + lalu tab. Karena `mode` konstanta dari rute, pada
            jalur REGULER tab tidak dirender sehingga `tabMenu` tetap 'BARU'. */}
        {mode === 'BERJANGKA' && (
          <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="SIMPANAN_BERJANGKA" />
        )}
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="SIMPANAN_BERJANGKA" />
        ) : (
        <>
        {/* §C — heading menyebut KONTEKS jalur, bukan "Jenis Simpanan"
            yang harus dipilih. Wording "Setor Simpanan" TIDAK dipakai di
            jalur berjangka: yang terjadi di sana adalah penempatan
            kontrak, bukan setoran simpanan biasa. */}
        <View style={styles.kop}>
        <Text style={styles.judulLayar}>
          {mode === 'BERJANGKA' ? 'Penempatan Simpanan Berjangka' : 'Setor Simpanan Anggota'}
        </Text>
        <Text style={styles.deskripsiLayar}>
          {mode === 'BERJANGKA'
            ? 'Atur nominal, tenor, tanggal mulai, tanggal jatuh tempo, dan ketentuan bunga sesuai kebijakan koperasi.'
            : 'Isi Simpanan Pokok, Wajib, dan/atau Sukarela dalam satu kali submit. Kosongkan field yang tidak perlu disetor. Simpanan Pokok hanya dapat dicatat satu kali per anggota.'}
        </Text>

        </View>

        {mode === 'REGULER' && (
        <>
        {elAnggota}
        {elTanggal}

        <Text style={styles.sectionLabel}>Simpanan Anggota</Text>

        <Text style={styles.label}>Simpanan Pokok</Text>
        {cekPokokLoading ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ marginBottom: spacing.md }} />
        ) : pokokSudahAda ? (
          <View style={styles.existingBox}>
            <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
            <Text style={styles.existingText}>{formatRupiah(pokokExisting)} · Sudah tercatat</Text>
          </View>
        ) : (
          <CurrencyInput value={pokok} onChangeValue={setPokok} />
        )}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Simpanan Wajib</Text>
        <CurrencyInput value={wajib} onChangeValue={setWajib} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Simpanan Sukarela (opsional)</Text>
        <CurrencyInput value={sukarela} onChangeValue={setSukarela} />
        {errors.total && <Text style={styles.errorText}>{errors.total}</Text>}

        <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>Sumber Dana</Text>
        <View style={styles.chipRow}>
          <Chip label="Kas" active={sumberDana === 'KAS'} onPress={pilihKas} />
          <Chip label="Bank" active={sumberDana === 'BANK'} onPress={() => setSumberDana('BANK')} />
        </View>
        {elBank}
        {elKeterangan}

        {total > 0 && (
          <View style={styles.totalBox}>
            <Text style={styles.totalLabel}>Total yang akan disetor</Text>
            <Text style={styles.totalValue}>{formatRupiah(total)}</Text>
          </View>
        )}

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Transaksi</Text>
            </>
          )}
        </TouchableOpacity>
        </>
        )}

        {mode === 'BERJANGKA' && (
          <>
            {/* RC-S128 — kebijakan produk wajib ada sebelum penempatan. Ditaruh
                PALING ATAS supaya petugas tahu sebelum mengisi apa pun. */}
            {kebijakanBerlaku === null ? (
              <KotakInfo
                nada="peringatan"
                judul="Kebijakan produk belum ditetapkan"
                aksi={{ label: 'Buka Kebijakan Produk', onPress: () => navigation.navigate('KebijakanProdukBerjangka') }}
              >
                {PESAN_KEBIJAKAN_PRODUK_BELUM_ADA}
              </KotakInfo>
            ) : null}

            <KartuLangkah nomor={1} judul="Anggota & tanggal" keterangan="Pilih anggota pemilik simpanan dan tanggal dana diterima koperasi.">
              {elAnggota}
              {elTanggal}
            </KartuLangkah>

            <KartuLangkah nomor={2} judul="Nominal, tenor & bunga" keterangan="Pokok tetap selama kontrak; bunga dihitung otomatis tiap bulan.">
              <Text style={styles.label}>Nominal pokok *</Text>
              <CurrencyInput value={berjangkaNominal} onChangeValue={setBerjangkaNominal} />
              {errors.berjangkaNominal && <Text style={styles.errorText}>{errors.berjangkaNominal}</Text>}
              <Text style={styles.bantuan}>Pokok tidak bisa ditambah atau dikurangi setelah disimpan.</Text>

              <Text style={[styles.label, { marginTop: spacing.md }]}>Tenor *</Text>
              <View style={styles.tenorBaris}>
                {TENOR_SIMPANAN_BERJANGKA.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tenorKartu, tenor === t && styles.tenorKartuAktif]}
                    onPress={() => setTenor(t)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: tenor === t }}
                    accessibilityLabel={`Tenor ${t} bulan`}
                  >
                    <Text style={[styles.tenorAngka, tenor === t && styles.tenorTeksAktif]}>{t}</Text>
                    <Text style={[styles.tenorSatuan, tenor === t && styles.tenorTeksAktif]}>bulan</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {errors.tenor && <Text style={styles.errorText}>{errors.tenor}</Text>}
              {jatuhTempoPreview ? (
                <View style={styles.jatuhTempoBaris}>
                  <Ionicons name="calendar-outline" size={14} color={colors.primary} />
                  <Text style={styles.jatuhTempoTeks}>
                    Jatuh tempo <Text style={styles.tebal}>{formatTanggalIndonesia(jatuhTempoPreview)}</Text>
                  </Text>
                </View>
              ) : null}

              {/* Label menyebut unit SECARA EKSPLISIT ("per Tahun"), bukan
                  "Bunga (%)" yang ambigu antara per tahun / per bulan. */}
              <Text style={[styles.label, { marginTop: spacing.md }]}>
                Suku Bunga per Tahun (%) — Opsional
              </Text>
              <FocusTextInput
                style={styles.input}
                value={sukuBunga}
                onChangeText={setSukuBunga}
                keyboardType="decimal-pad"
                placeholder="Kosongkan bila tanpa bunga"
                placeholderTextColor={colors.placeholder}
                invalid={!!errors.sukuBunga}
              />
              {errors.sukuBunga && <FieldError message={errors.sukuBunga} />}
              {estimasiBunga ? (
                <Text style={styles.bantuan}>
                  ± {formatRupiah(estimasiBunga.perBulan)} per bulan, masuk ke Simpanan Sukarela anggota setelah PPh.
                </Text>
              ) : null}
            </KartuLangkah>

            <KartuLangkah nomor={3} judul="Sumber dana" keterangan="Ke mana uang penempatan diterima.">
              <PilihanOpsi
                opsi={OPSI_SUMBER_DANA}
                nilai={sumberDana}
                onChange={(v) => (v === 'KAS' ? pilihKas() : setSumberDana('BANK'))}
                labelAksesibilitas="Sumber dana"
              />
              {elBank}
              {elKeterangan}
            </KartuLangkah>

            {/* RC-S128 — ketentuan setelah jatuh tempo dari kebijakan produk. */}
            {kebijakanBerlaku ? (
              <KotakInfo
                nada="info"
                judul={`Setelah jatuh tempo · kebijakan versi ${kebijakanBerlaku.versi}`}
                aksi={{ label: 'Lihat kebijakan', onPress: () => navigation.navigate('KebijakanProdukBerjangka') }}
              >
                {`${ringkasanPerlakuanPascaJatuhTempo({
                  autoRenewal: kebijakanBerlaku.autoRenewal,
                  bungaPascaAktif: kebijakanBerlaku.bungaPascaJatuhTempoAktif,
                  ratePascaJatuhTempo: kebijakanBerlaku.ratePascaJatuhTempo,
                })} Ketentuan ini disalin ke kontrak dan tidak berubah walau kebijakan koperasi diperbarui kemudian.`}
              </KotakInfo>
            ) : null}

            {/* RC-S129 — ringkasan sebelum simpan. Angka bunga dari helper
                akuntansi yang SAMA dengan akrual, bukan rumus di layar. */}
            <RingkasanTransaksi
              judul="Ringkasan penempatan"
              baris={[
                { label: 'Anggota', nilai: anggota ? `${anggota.namaLengkap} (${anggota.nomorAnggota})` : '—' },
                { label: 'Tenor', nilai: tenor ? `${tenor} bulan` : '— pilih tenor' },
                {
                  label: 'Suku bunga',
                  nilai: rateTampil === null ? '— periksa isian' : rateTampil > 0 ? `${String(rateTampil).replace('.', ',')}% per tahun` : 'Tanpa bunga',
                },
                { label: 'Tanggal mulai', nilai: tanggal ? formatTanggalIndonesia(tanggal) : '—' },
                { label: 'Jatuh tempo', nilai: jatuhTempoPreview ? formatTanggalIndonesia(jatuhTempoPreview) : '— pilih tenor' },
                { label: 'Sumber dana', nilai: sumberDana === 'BANK' ? bankRekening?.nama ?? 'Bank — pilih rekening' : 'Kas' },
                ...(estimasiBunga ? [{ label: 'Perkiraan bunga selama tenor', nilai: formatRupiah(estimasiBunga.total) }] : []),
                { label: 'Pokok ditempatkan', nilai: berjangkaNominal === '' ? '—' : formatRupiah(berjangkaNominal), tegas: true },
              ]}
              catatan="Saat jatuh tempo yang dicairkan hanya pokok. Bunga tiap bulan sudah lebih dulu masuk ke Simpanan Sukarela anggota."
            />

            <TombolUtama label="Simpan Penempatan" ikon="save-outline" onPress={submit} memuat={submitting} />

            <View style={{ marginTop: spacing.lg }}>
              <CaraKerjaBerjangka />
            </View>
          </>
        )}
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const OPSI_SUMBER_DANA: readonly OpsiPilihan<'KAS' | 'BANK'>[] = [
  { nilai: 'KAS', label: 'Kas', ikon: 'cash-outline', keterangan: 'Diterima tunai' },
  { nilai: 'BANK', label: 'Bank', ikon: 'business-outline', keterangan: 'Transfer ke rekening koperasi' },
];

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  input: { ...formUi.inputStandalone },
  // RC-S129 — jalur berjangka
  jatuhTempoBaris: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.xs },
  jatuhTempoTeks: { fontSize: 12, color: colors.text },
  tebal: { fontWeight: '800' },
  bantuan: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.xs },
  tenorBaris: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  tenorKartu: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tenorKartuAktif: { borderColor: colors.primary, backgroundColor: colors.primary },
  tenorAngka: { fontSize: 20, fontWeight: '800', color: colors.text },
  tenorSatuan: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  tenorTeksAktif: { color: colors.white },
  container: { flex: 1, backgroundColor: colors.background },
  kop: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  judulLayar: { fontSize: 16, fontWeight: '800', color: colors.primary, marginBottom: spacing.xs, letterSpacing: 0.2 },
  deskripsiLayar: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
    marginBottom: spacing.lg,
  },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  existingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    marginBottom: spacing.md,
  },
  existingText: { fontSize: 15, fontWeight: '600', color: colors.text },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  totalBox: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  totalValue: { fontSize: 17, color: colors.primary, fontWeight: '700' },
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
