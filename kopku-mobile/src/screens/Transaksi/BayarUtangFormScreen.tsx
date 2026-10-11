import React, { useEffect, useLayoutEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import KewajibanAkunPicker from '@/components/KewajibanAkunPicker';
import UtangPicker from '@/components/UtangPicker';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import { RekeningItem } from '@/services/KasBankService';
import { bayarUtang, bayarKewajibanCoa, UtangListItem, AkunKewajibanOption } from '@/services/UtangService';
import { getStatusBungaSemuaUtang, getHasilAkrualBungaUtangTerakhir, LABEL_STATUS_BUNGA_UTANG } from '@/services/UtangBungaAccrualService';
import { tungguTugasStartupSelesai, getStatusTugasStartup } from '@/services/StartupTasks';
import {
  InfoBunga,
  ProsesLatarBunga,
  infoBungaUntuk,
  bungaSiapUntukBayar,
  infoDariDetail,
  akrualBungaGagalUntuk,
  teksNilaiBunga,
  teksMemuatBunga,
} from '@/screens/Transaksi/bayarUtangGate';
import { useDetikMemuat } from '@/hooks/useDetikMemuat';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { getRingkasanPajak } from '@/services/PajakService';
import { KODE_UTANG_PAJAK_SETORAN } from '@/config/pajakPolicy';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, semantic, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { ui, menuIconSize } from '@/theme/ui';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * RC-S74 — "Bayar Kewajiban" (route/nama internal tetap `BayarUtangForm`).
 *
 * Alur: Apa yang akan dibayar? → Utang Koperasi / Kewajiban Lainnya →
 * pilih → lihat saldo → isi pembayaran → ringkasan → simpan.
 *
 *  - Utang Koperasi: LANGSUNG ke UtangPicker (tanpa memilih akun COA).
 *    Pencatatan tetap `bayarUtang()` existing — pokok, bunga, outstanding,
 *    pembagian bunga, cek saldo rekening: semuanya di service, tidak diubah.
 *  - RC-S87.2 — Setor Pajak: kartu ketiga yang membuka alur Setor Pajak
 *    (masa pajak + NTPN, mesin `bayarKewajibanCoa` yang sama). Utang pajak
 *    yang dipilih lewat "Kewajiban Lainnya" diarahkan ke alur ini supaya
 *    masa dan NTPN-nya tidak hilang.
 *  - Kewajiban Lainnya: KewajibanAkunPicker (`listAkunKewajibanUmum`,
 *    pengecualian berbasis mapping, hanya saldo > 0) lalu
 *    `bayarKewajibanCoa()`, yang menolak pembayaran melebihi saldo.
 *
 * Kompleksitas akuntansi tetap di service. Layar ini tidak menampilkan
 * istilah internal (mapping/role/transaction_type).
 */

type JenisBayar = 'UTANG' | 'LAINNYA';

// RC-S74 (final hardening) — tampilan & kunci tombol "Utang Bunga" berasal dari
// SATU sumber murni (`bayarUtangGate.ts`): info diikat ke utangId, MEMUAT /
// TIDAK_TERSEDIA / belum ada / basi = tombol terkunci; Rp0 hanya dari SIAP.

const JENIS_PEMBERI_LABEL: Record<string, string> = {
  BANK: 'Bank',
  PIHAK_LAIN: 'Pihak Lain',
  UTANG_USAHA: 'Utang Usaha',
};

/** Pesan internal (mapping/kode peran/tipe transaksi) tidak pernah ditampilkan ke pengguna. */
const POLA_PESAN_INTERNAL = /KREDIT_|DEBIT_|transaction_?type|account_?mapping|accountId|jenisPemberiTerkait|SQLITE|constraint/i;
function pesanUntukPengguna(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (!m || POLA_PESAN_INTERNAL.test(m)) return 'Pembayaran tidak dapat diproses. Periksa data yang dipilih, lalu coba lagi.';
  return m;
}

export default function BayarUtangFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  // RC-S74 §3 — judul header (label UI saja; route tetap).
  useLayoutEffect(() => {
    navigation.setOptions?.({ title: 'Bayar Kewajiban' });
  }, [navigation]);

  const [jenis, setJenis] = useState<JenisBayar | null>(null);

  // Utang Koperasi (tracked)
  const [utang, setUtang] = useState<UtangListItem | null>(null);
  const [infoBunga, setInfoBunga] = useState<InfoBunga | null>(null);
  /**
   * HOTFIX RC-S74 — potret proses latar yang sedang ditunggu (metadata runtime
   * StartupTasks: kapan mulai + rata-rata durasi aktual). HANYA untuk teks
   * estimasi; tidak pernah menentukan kapan data dianggap siap.
   */
  const [prosesBunga, setProsesBunga] = useState<ProsesLatarBunga | null>(null);
  /** Dinaikkan HANYA oleh tombol "Coba lagi" (aksi pengguna) — bukan polling/timer. */
  const [muatUlangBunga, setMuatUlangBunga] = useState(0);
  const [pokok, setPokok] = useState<number | ''>('');
  const [bunga, setBunga] = useState<number | ''>('');

  // Kewajiban Lainnya (COA umum)
  const [akun, setAkun] = useState<AkunKewajibanOption | null>(null);
  const [nominal, setNominal] = useState<number | ''>('');
  const [keterangan, setKeterangan] = useState('');

  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [submitting, setSubmitting] = useState(false);

  // RC-S87.2 — total utang pajak (untuk subjudul kartu Setor Pajak).
  const [utangPajak, setUtangPajak] = useState<{ total: number; jumlah: number } | null>(null);
  useFocusRefresh(async () => {
    try {
      const r = await getRingkasanPajak();
      const ada = r.utang.filter((u) => u.saldo > 0);
      setUtangPajak({ total: ada.reduce((t, u) => t + u.saldo, 0), jumlah: ada.length });
    } catch {
      setUtangPajak(null);
    }
  }, []);

  // Ganti jenis -> reset seluruh isian (mencegah data basi lintas alur).
  useEffect(() => {
    setUtang(null);
    setInfoBunga(null);
    setPokok('');
    setBunga('');
    setAkun(null);
    setNominal('');
    setKeterangan('');
  }, [jenis]);

  // Utang usaha tidak punya komponen bunga.
  useEffect(() => {
    if (utang?.jenisPemberi === 'UTANG_USAHA' && bunga !== '') setBunga('');
  }, [utang]);

  // Sisa utang bunga per utang: monitor read-only yang sama dengan Daftar Utang Koperasi.
  // RC-S74 (update): TUNGGU dulu gate resmi `tungguTugasStartupSelesai()` — bila
  // catch-up akrual otomatis sedang berjalan, nilai yang dibaca sebelum selesai
  // bisa Rp0 padahal belum final. Layar ini tidak menjalankan mesin akrual;
  // ia hanya menunggu pekerjaan yang SUDAH berjalan (promise nyata, tanpa timer).
  // RC-S74 loading UX: `useLayoutEffect` — tahap MEMUAT dipasang SEBELUM frame
  // pertama digambar, jadi setelah memilih utang yang pertama terlihat adalah
  // loading (tidak ada frame "—"/nilai lama). Mekanisme baca tidak berubah.
  useLayoutEffect(() => {
    let aktif = true;
    if (!utang || utang.jenisPemberi === 'UTANG_USAHA' || !(utang.persenBunga > 0)) {
      setInfoBunga(null); // tampilan untuk kasus ini ditentukan `infoBungaUntuk`
      setProsesBunga(null);
      return;
    }
    const utangId = utang.id;
    setInfoBunga({ utangId, tahap: 'MEMUAT' });
    // HOTFIX RC-S74 — potret metadata SEBELUM menunggu: apakah batch StartupTasks
    // sedang berjalan, kapan mulai, dan estimasi dari durasi aktual sebelumnya.
    // Membaca variabel modul saja (bukan database, bukan pemicu).
    const proses = getStatusTugasStartup();
    setProsesBunga(proses.berjalan ? { mulaiMs: proses.mulaiMs ?? Date.now(), estimasiMs: proses.estimasiMs } : null);
    (async () => {
      try {
        // Satu-satunya penentu selesai: promise nyata koordinator (bukan estimasi).
        await tungguTugasStartupSelesai();
        const detail = (await getStatusBungaSemuaUtang()).get(utangId);
        // §13 — mesin akrual gagal -> angka yang terbaca basi, bukan hasil final.
        const akrualGagal = akrualBungaGagalUntuk(utangId, getHasilAkrualBungaUtangTerakhir());
        // Hasil utang lain yang datang terlambat diabaikan (effect lama sudah dibatalkan).
        if (!aktif) return;
        // SIAP = data berhasil dibaca; status accounting dibawa APA ADANYA (statusBunga).
        setInfoBunga(infoDariDetail(utangId, detail, akrualGagal));
      } catch {
        if (aktif) setInfoBunga({ utangId, tahap: 'TIDAK_TERSEDIA' });
      }
    })();
    return () => {
      aktif = false;
    };
  }, [utang?.id, muatUlangBunga]);

  // Satu-satunya sumber tampilan & kunci tombol bunga (info basi/belum ada = MEMUAT).
  const bungaTampil = infoBungaUntuk(utang, infoBunga);

  // RC-S74 loading UX — waktu berjalan AKTUAL untuk TAMPILAN saja. Hook ini tidak
  // memanggil service apa pun dan tidak menentukan kapan data siap; ia berhenti
  // saat tahap bukan MEMUAT dan dibersihkan saat unmount. Kunci baru = hitungan baru.
  // HOTFIX: diukur dari mulainya batch StartupTasks (bila ada), lalu sisa estimasi
  // = rata-rata durasi aktual − waktu berjalan (helper murni, tidak pernah negatif).
  const detikMemuat = useDetikMemuat(bungaTampil?.tahap === 'MEMUAT', `${utang?.id ?? ''}:${muatUlangBunga}`, prosesBunga?.mulaiMs ?? null);
  const memuat = teksMemuatBunga(prosesBunga, detikMemuat * 1000);

  const pokokNum = pokok === '' ? 0 : pokok;
  const bungaNum = bunga === '' ? 0 : bunga;
  const nominalNum = nominal === '' ? 0 : nominal;
  /** RC-S87.2 — utang pajak disetor lewat alur Setor Pajak (masa & NTPN), bukan form umum. */
  const akunPajak = !!akun && KODE_UTANG_PAJAK_SETORAN.includes(akun.kode);
  const totalBayar = jenis === 'UTANG' ? pokokNum + bungaNum : nominalNum;

  // Pesan validasi tampilan (service tetap memvalidasi ulang).
  const pesan: string[] = [];
  if (jenis === 'UTANG' && utang) {
    if (pokokNum > utang.sisaPokok) pesan.push(`Pokok melebihi sisa utang (${formatRupiah(utang.sisaPokok)}).`);
  }
  if (jenis === 'LAINNYA' && akun && nominalNum > akun.saldo) {
    pesan.push(`Pembayaran melebihi saldo kewajiban.\nSaldo yang tersedia: ${formatRupiah(akun.saldo)}.`);
  }
  if (rekening && totalBayar > 0 && totalBayar > rekening.saldo) {
    pesan.push(`Saldo ${rekening.nama} tidak cukup (${formatRupiah(rekening.saldo)}).`);
  }

  // Tombol bayar utang HANYA aktif bila informasi bunga sudah final untuk utang terpilih.
  const bungaSiap = bungaSiapUntukBayar(utang, infoBunga);
  const lengkap =
    !!rekening &&
    !!tanggal &&
    ((jenis === 'UTANG' && !!utang && totalBayar > 0 && bungaSiap) || (jenis === 'LAINNYA' && !!akun && nominalNum > 0));
  const siap = lengkap && pesan.length === 0;
  const labelTombol =
    jenis === 'UTANG'
      ? bungaTampil?.tahap === 'MEMUAT'
        ? 'Menunggu perhitungan bunga…'
        : 'Bayar Utang'
      : 'Bayar Kewajiban';

  const submit = async () => {
    if (!siap || submitting || !rekening || !currentUser) return;
    setSubmitting(true);
    try {
      const sumber = {
        sumberDana: (rekening.jenis === 'BANK' ? 'BANK' : 'KAS') as 'BANK' | 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
      };
      if (jenis === 'UTANG' && utang) {
        const hasil = await bayarUtang({ utangId: utang.id, tanggal, pokok: pokokNum, bunga: bungaNum, ...sumber, createdBy: currentUser.id });
        notify(
          'Berhasil',
          hasil.sisaPokokSetelah <= 0
            ? `Utang kepada ${utang.namaPemberi} sudah lunas.`
            : `Pembayaran tercatat. Sisa pokok: ${formatRupiah(hasil.sisaPokokSetelah)}.`,
          [{ text: 'OK', onPress: () => navigation.goBack() }]
        );
      } else if (jenis === 'LAINNYA' && akun) {
        await bayarKewajibanCoa({ accountId: akun.accountId, tanggal, nominal: nominalNum, ...sumber, keterangan: keterangan || undefined, createdBy: currentUser.id });
        notify('Berhasil', `Pembayaran ${akun.nama} tercatat. Sisa: ${formatRupiah(akun.saldo - nominalNum)}.`, [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      }
    } catch (e) {
      notify('Pembayaran gagal', pesanUntukPengguna(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="UTANG" labelBaru="Bayar Utang" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="UTANG" />
        ) : (
        <>
        <Text style={styles.intro}>Bayar utang dan kewajiban yang sudah tercatat.</Text>

        <Text style={styles.sectionTitle}>Apa yang akan dibayar?</Text>
        <PilihanJenis
          icon="card-outline"
          title="Utang Koperasi"
          sub="Bank, pihak lain, atau utang usaha"
          aktif={jenis === 'UTANG'}
          onPress={() => setJenis('UTANG')}
        />
        <PilihanJenis
          icon="document-text-outline"
          title="Kewajiban Lainnya"
          sub="Pajak, dana, dan kewajiban lain yang tercatat"
          aktif={jenis === 'LAINNYA'}
          onPress={() => setJenis('LAINNYA')}
        />
        <PilihanJenis
          icon="receipt-outline"
          title="Setor Pajak"
          sub={
            utangPajak && utangPajak.jumlah > 0
              ? `${utangPajak.jumlah} utang pajak belum disetor · ${formatRupiah(utangPajak.total)}`
              : 'PPh Final, PPh 4(2), PPh 29 — lengkap dengan masa & NTPN'
          }
          aktif={false}
          onPress={() => navigation.navigate('SetorPajakForm')}
        />

        {jenis === 'UTANG' && (
          <View style={styles.section}>
            <UtangPicker value={utang} onChange={setUtang} />
            {utang && (
              <View style={styles.infoCard}>
                <View style={styles.infoJudulBaris}>
                  {/* RC-S70.1 — ikon identitas Pengeluaran: merah, bukan hijau brand. */}
                  <Ionicons name="wallet-outline" size={18} color={semantic.expenseIcon} />
                  <Text style={styles.infoJudul}>Utang yang dipilih</Text>
                </View>
                <Baris label="Pemberi" nilai={utang.namaPemberi} />
                <Baris label="Jenis" nilai={JENIS_PEMBERI_LABEL[utang.jenisPemberi] ?? '—'} />
                <Baris label="Nomor Utang" nilai={utang.nomorUtang} />
                <Baris label="Sisa Pokok" nilai={formatRupiah(utang.sisaPokok)} tebal />
                {bungaTampil?.tahap === 'MEMUAT' ? (
                  <View style={styles.baris}>
                    <Text style={styles.barisLabel}>Utang Bunga</Text>
                    <View style={styles.memuatKolom} accessibilityLiveRegion="polite">
                      <View style={styles.memuatBaris}>
                        <ActivityIndicator size="small" color={colors.textMuted} />
                        <Text style={styles.memuatTeks}>{memuat.judul}</Text>
                      </View>
                      {memuat.estimasi ? <Text style={styles.memuatSub}>{memuat.estimasi}</Text> : null}
                      {memuat.penjelasan ? <Text style={styles.memuatCatatan}>{memuat.penjelasan}</Text> : null}
                    </View>
                  </View>
                ) : bungaTampil ? (
                  <Baris label="Utang Bunga" nilai={teksNilaiBunga(bungaTampil)} />
                ) : null}
                {bungaTampil?.tahap === 'SIAP' ? (
                  <>
                    {/* Status accounting apa adanya — label & penanda sama dengan Daftar Utang Koperasi. */}
                    <Baris
                      label="Status"
                      nilai={`${bungaTampil.statusBunga === 'TERKENDALI' ? '✓ ' : bungaTampil.statusBunga === 'MENUNGGU_PERIODE' ? '' : '⚠ '}${LABEL_STATUS_BUNGA_UTANG[bungaTampil.statusBunga]}`}
                    />
                    {bungaTampil.pesanBunga ? <Text style={styles.infoCatatanBunga}>{bungaTampil.pesanBunga}</Text> : null}
                  </>
                ) : null}
                {bungaTampil?.tahap === 'TIDAK_TERSEDIA' ? (
                  <View style={styles.bungaGagal}>
                    <Text style={styles.bungaGagalTeks}>
                      Perhitungan bunga belum tersedia. Pembayaran utang ini dinonaktifkan sampai informasi bunga berhasil dimuat.
                    </Text>
                    <TouchableOpacity accessibilityRole="button" style={styles.cobaLagi} onPress={() => setMuatUlangBunga((n) => n + 1)}>
                      <Text style={styles.cobaLagiTeks}>Coba lagi</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {bungaTampil?.tahap === 'AKRUAL_GAGAL' ? (
                  <View style={styles.bungaGagal}>
                    <Text style={styles.bungaGagalJudul}>Perhitungan belum selesai</Text>
                    <Text style={styles.bungaGagalTeks}>
                      Gagal memperbarui akrual otomatis. Pembayaran utang ini dinonaktifkan sampai perhitungan bunga selesai. Akrual otomatis dijalankan lagi saat aplikasi dibuka kembali.
                    </Text>
                    <TouchableOpacity accessibilityRole="button" style={styles.cobaLagi} onPress={() => setMuatUlangBunga((n) => n + 1)}>
                      <Text style={styles.cobaLagiTeks}>Coba lagi</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            )}
            {utang && (
              <>
                <Text style={styles.label}>Jumlah Pokok</Text>
                <CurrencyInput value={pokok} onChangeValue={setPokok} />
                {utang.jenisPemberi !== 'UTANG_USAHA' && (
                  <>
                    <Text style={[styles.label, { marginTop: spacing.md }]}>Jumlah Bunga</Text>
                    <CurrencyInput value={bunga} onChangeValue={setBunga} />
                  </>
                )}
              </>
            )}
          </View>
        )}

        {jenis === 'LAINNYA' && (
          <View style={styles.section}>
            <KewajibanAkunPicker value={akun} onChange={setAkun} />
            {akun && akunPajak && (
              <View style={styles.infoCard}>
                <View style={styles.infoJudulBaris}>
                  <Ionicons name="receipt-outline" size={18} color={semantic.expenseIcon} />
                  <Text style={[styles.infoCatatan, { fontWeight: '700' }]}>Ini utang pajak</Text>
                </View>
                <Baris label="Kewajiban" nilai={`${akun.kode} — ${akun.nama}`} />
                <Baris label="Saldo" nilai={formatRupiah(akun.saldo)} tebal />
                <Text style={[styles.infoCatatan, { marginTop: spacing.sm }]}>
                  Setoran pajak dicatat lewat Setor Pajak supaya masa pajak dan NTPN (bukti setor negara) ikut tersimpan untuk pelaporan.
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  style={[styles.submitButton, { marginTop: spacing.md }]}
                  onPress={() => navigation.navigate('SetorPajakForm', { kodeAkun: akun.kode })}
                >
                  <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.white} />
                  <Text style={styles.submitText}>Lanjut ke Setor Pajak</Text>
                </TouchableOpacity>
              </View>
            )}
            {akun && !akunPajak && (
              <>
                <View style={styles.infoCard}>
                  <Baris label="Kewajiban" nilai={`${akun.kode} — ${akun.nama}`} />
                  <Baris label="Saldo" nilai={formatRupiah(akun.saldo)} tebal />
                  <View style={[styles.infoJudulBaris, { marginTop: spacing.sm, marginBottom: 0 }]}>
                    {/* RC-S70.1 — ikon identitas Pengeluaran: merah, bukan hijau brand. */}
                    <Ionicons name="information-circle-outline" size={18} color={semantic.expenseIcon} />
                    <Text style={styles.infoCatatan}>Boleh dibayar sebagian, maksimal sebesar saldo.</Text>
                  </View>
                </View>
                <Text style={styles.label}>Jumlah Pembayaran</Text>
                <CurrencyInput value={nominal} onChangeValue={setNominal} />
                <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
                <FocusTextInput
                  style={styles.inputMultiline}
                  value={keterangan}
                  onChangeText={setKeterangan}
                  multiline
                  placeholder={`Mis. Pembayaran ${akun.nama} bulan ini`}
                  placeholderTextColor={colors.placeholder}
                />
              </>
            )}
          </View>
        )}

        {((jenis === 'UTANG' && utang) || (jenis === 'LAINNYA' && akun && !akunPajak)) && (
          <>
            <View style={{ marginTop: spacing.md }}>
              <RekeningPicker label="Rekening Sumber" value={rekening} onChange={setRekening} />
            </View>
            <Text style={styles.label}>Tanggal</Text>
            <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />

            {pesan.map((p) => (
              <View key={p} style={styles.peringatan}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
                <Text style={styles.peringatanTeks}>{p}</Text>
              </View>
            ))}

            {siap && rekening && (
              <View style={styles.ringkasan}>
                {jenis === 'UTANG' && utang ? (
                  <>
                    <Text style={styles.ringkasanJudul}>Pembayaran Utang</Text>
                    <Baris label="Pemberi" nilai={utang.namaPemberi} />
                    <Baris label="Sisa pokok" nilai={formatRupiah(utang.sisaPokok)} />
                    <Baris label="Pokok dibayar" nilai={formatRupiah(pokokNum)} tebal />
                    {utang.jenisPemberi !== 'UTANG_USAHA' && <Baris label="Bunga dibayar" nilai={formatRupiah(bungaNum)} tebal />}
                    <Baris label="Sumber dana" nilai={rekening.nama} />
                  </>
                ) : akun ? (
                  <>
                    <Text style={styles.ringkasanJudul}>Pembayaran Kewajiban</Text>
                    <Baris label="Yang dibayar" nilai={akun.nama} />
                    <Baris label="Saldo sebelum" nilai={formatRupiah(akun.saldo)} />
                    <Baris label="Dibayar" nilai={formatRupiah(nominalNum)} tebal />
                    <Baris label="Sisa" nilai={formatRupiah(akun.saldo - nominalNum)} />
                    <Baris label="Sumber dana" nilai={rekening.nama} />
                  </>
                ) : null}
              </View>
            )}

            <TouchableOpacity
              accessibilityRole="button"
              style={[styles.submitButton, (!siap || submitting) && styles.disabled]}
              onPress={submit}
              disabled={!siap || submitting}
            >
              {submitting ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <>
                  <Ionicons name="save-outline" size={18} color={colors.white} />
                  <Text style={styles.submitText}>{labelTombol}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function PilihanJenis({ icon, title, sub, aktif, onPress }: { icon: any; title: string; sub: string; aktif: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: aktif }} style={[styles.card, aktif && styles.cardAktif]} onPress={onPress}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={menuIconSize} color={semantic.expenseIcon} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardSub}>{sub}</Text>
      </View>
      <Ionicons name={aktif ? 'checkmark-circle' : 'chevron-forward'} size={20} color={aktif ? semantic.expenseIcon : colors.textMuted} />
    </TouchableOpacity>
  );
}

function Baris({ label, nilai, tebal }: { label: string; nilai: string; tebal?: boolean }) {
  return (
    <View style={styles.baris}>
      <Text style={styles.barisLabel}>{label}</Text>
      <Text style={[styles.barisNilai, tebal && styles.barisNilaiTebal]}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  intro: { ...ui.screenIntro },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  section: { marginTop: spacing.md },
  card: { ...ui.menuCard },
  cardAktif: { borderColor: semantic.expenseIcon, borderWidth: 1.5 },
  iconCircle: { ...ui.menuIcon, ...ui.menuIconExpense },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  infoCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  infoJudulBaris: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.sm },
  infoJudul: { fontSize: 13, fontWeight: '700', color: colors.text },
  infoCatatan: { flex: 1, fontSize: 12, color: colors.textMuted },
  infoCatatanBunga: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs },
  memuatKolom: { flexShrink: 1, alignItems: 'flex-end', gap: 2 },
  memuatBaris: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  memuatTeks: { fontSize: 13, color: colors.textMuted },
  memuatSub: { fontSize: 12, color: colors.textMuted, textAlign: 'right' },
  memuatCatatan: { fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 2 },
  bungaGagal: { marginTop: spacing.sm, gap: spacing.sm },
  bungaGagalTeks: { fontSize: 12, color: colors.danger },
  bungaGagalJudul: { fontSize: 13, fontWeight: '700', color: colors.danger },
  cobaLagi: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 6 },
  cobaLagiTeks: { fontSize: 13, fontWeight: '600', color: colors.text },
  baris: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 3 },
  barisLabel: { fontSize: 13, color: colors.textMuted },
  barisNilai: { fontSize: 13, color: colors.text, flexShrink: 1, textAlign: 'right' },
  barisNilaiTebal: { fontWeight: '700' },
  peringatan: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  peringatanTeks: { flex: 1, fontSize: 13, color: colors.danger },
  ringkasan: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.lg },
  ringkasanJudul: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  submitButton: { flexDirection: 'row', gap: 8, backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl, marginBottom: 40 },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
