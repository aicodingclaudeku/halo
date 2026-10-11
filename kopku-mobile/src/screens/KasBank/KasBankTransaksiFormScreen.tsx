import React, { useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import AccountPicker from '@/components/AccountPicker';
import PenerimaanPenghasilanLainAccountPicker from '@/components/PenerimaanPenghasilanLainAccountPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import { RekeningItem } from '@/services/KasBankService';
import { AccountItem } from '@/repositories/AccountRepository';
import {
  catatPemasukan,
  catatPengeluaran,
  transferAntarRekening,
  KATEGORI_PENERIMAAN,
  KATEGORI_PENGELUARAN,
} from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, touchTarget, typography } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import FieldError from '@/components/FieldError';
import AlurDana from '@/components/form/AlurDana';
import KartuLangkah from '@/components/form/KartuLangkah';
import PilihanOpsi from '@/components/form/PilihanOpsi';
import RingkasanTransaksi from '@/components/form/RingkasanTransaksi';
import TombolUtama from '@/components/form/TombolUtama';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';
import { formatRupiah } from '@/utils/money';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';

type TipeForm = 'PEMASUKAN' | 'PENGELUARAN' | 'TRANSFER';

/**
 * Form transaksi Kas & Bank (fase 7 §7-14).
 *
 * Menu Transaksi hanya punya 2 menu awal — Penerimaan & Pengeluaran
 * (lihat TransaksiScreen.tsx) — jadi chip di sini pun cuma 2, TIDAK
 * ada chip "Transfer" terpisah lagi. "Pemindahan Saldo Rekening" kini
 * jadi salah satu sub-fitur Pengeluaran (TransaksiPengeluaranScreen)
 * yang membuka form ini dengan tipe TRANSFER lewat route.params — form
 * transfer yang sudah ada dipertahankan persis sama, cuma jalur
 * masuknya yang berubah.
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna). Mode TRANSFER
 * (Pengeluaran › Pemindahan Saldo Rekening) mendapat kartu Alur Dana
 * (sumber → tujuan, saldo sebelum & sesudah, tombol tukar), tab Riwayat,
 * dan tombol simpan yang nonaktif bila saldo sumber jelas tidak cukup.
 * Semua mode memakai langkah bernomor + ringkasan sebelum simpan.
 * Validasi, `catatPemasukan`/`catatPengeluaran`/`transferAntarRekening`,
 * dan parameter route TIDAK diubah.
 */
export default function KasBankTransaksiFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const tipeAwal: TipeForm = route.params?.tipe ?? 'PEMASUKAN';
  // Dikirim dari sub-menu Penerimaan/Pengeluaran (mis. "Utang", "Beban")
  // — kalau ada, tipe & kategori sudah ditentukan dari sub-menu, jadi
  // chip Jenis Transaksi disembunyikan (tidak perlu dipilih ulang).
  const kategoriPreset: string | undefined = route.params?.kategoriPreset;
  const judulPreset: string | undefined = route.params?.judul;
  // Update pasca-Phase 18 §1: form ini dipakai bersama oleh beberapa
  // sub-fitur lewat route.params (Penghasilan Lain, dan FAB generik
  // KasBankHistoriScreen) — SATU flag eksplisit baru supaya HANYA
  // "Penerimaan Penghasilan Lain" yang memakai picker akun terbatas
  // (4-2000/4-3000), sub-fitur lain yang memakai form generik ini
  // (mis. FAB "+" di riwayat Kas & Bank) TETAP memakai AccountPicker
  // global seperti sebelumnya — tidak ada perubahan perilaku untuk
  // pemakai lain form ini.
  const filterAkunLawan: string | undefined = route.params?.filterAkunLawan;

  const [tipe, setTipe] = useState<TipeForm>(tipeAwal);
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [rekeningTujuan, setRekeningTujuan] = useState<RekeningItem | null>(null);
  const [akunLawan, setAkunLawan] = useState<AccountItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nominal, setNominal] = useState<number | ''>('');
  const [kategori, setKategori] = useState<string | null>(kategoriPreset ?? null);
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');

  // RC-S121 — chip kategori "Pendapatan Diterima Dimuka" DISEMBUNYIKAN dari
  // form ini (UI saja). Pendapatan diterima dimuka dibentuk otomatis oleh
  // sistem; menawarkannya sebagai kategori penerimaan manual berisiko
  // mencatat ganda. Konstanta `KATEGORI_PENERIMAAN` di KasBankService TIDAK
  // diubah, sehingga transaksi lama berkategori ini tetap terbaca/terfilter.
  const daftarKategori = (tipe === 'PEMASUKAN' ? KATEGORI_PENERIMAAN : KATEGORI_PENGELUARAN).filter(
    (k) => k !== 'Pendapatan Diterima Dimuka'
  );

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!rekening) e.rekening = 'Rekening wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih dari 0';

    if (tipe === 'TRANSFER') {
      if (!rekeningTujuan) e.rekeningTujuan = 'Rekening tujuan wajib dipilih';
      if (rekening && rekeningTujuan && `${rekening.jenis}-${rekening.id}` === `${rekeningTujuan.jenis}-${rekeningTujuan.id}`) {
        e.rekeningTujuan = 'Rekening tujuan tidak boleh sama dengan rekening sumber';
      }
    } else {
      if (!akunLawan) e.akunLawan = 'Akun lawan (kategori pos) wajib dipilih';
      // Pertahanan berlapis (bukan cuma andalkan UI): kalaupun state
      // `akunLawan` entah bagaimana berisi akun di luar 4-2000/4-3000
      // (mis. dari sisa state layar lain), transaksi tetap ditolak di
      // sini — bukan hanya disembunyikan dari picker.
      if (filterAkunLawan === 'PENERIMAAN_PENGHASILAN_LAIN' && akunLawan && !['4-2000', '4-3000'].includes(akunLawan.kode)) {
        e.akunLawan = 'Akun untuk Penghasilan Lain hanya boleh 4-2000 atau 4-3000.';
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !rekening || !currentUser || nominal === '') return;
    setSubmitting(true);
    try {
      if (tipe === 'PEMASUKAN') {
        await catatPemasukan({
          jenis: rekening.jenis,
          bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          tanggal,
          nominal,
          akunLawanId: akunLawan!.id,
          kategori: kategori ?? undefined,
          keterangan: keterangan || undefined,
          createdBy: currentUser.id,
        });
      } else if (tipe === 'PENGELUARAN') {
        await catatPengeluaran({
          jenis: rekening.jenis,
          bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          tanggal,
          nominal,
          akunLawanId: akunLawan!.id,
          kategori: kategori ?? undefined,
          keterangan: keterangan || undefined,
          createdBy: currentUser.id,
        });
      } else {
        await transferAntarRekening({
          sumberJenis: rekening.jenis,
          sumberBankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
          tujuanJenis: rekeningTujuan!.jenis,
          tujuanBankAccountId: rekeningTujuan!.jenis === 'BANK' ? rekeningTujuan!.id : undefined,
          tanggal,
          nominal,
          keterangan: keterangan || undefined,
          createdBy: currentUser.id,
        });
      }

      notify('Berhasil', 'Transaksi berhasil disimpan.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  // RC-S122 — angka bantu tampilan (bukan validasi; validasi tetap di
  // `validate()` dan di service).
  const transfer = tipe === 'TRANSFER';
  const adaNominal = nominal !== '' && nominal > 0;
  const nominalAngka = adaNominal ? (nominal as number) : 0;
  const saldoKurang = !!rekening && adaNominal && tipe !== 'PEMASUKAN' && nominalAngka > rekening.saldo;
  const tukarRekening = () => {
    const sumber = rekening;
    setRekening(rekeningTujuan);
    setRekeningTujuan(sumber);
  };
  let langkah = 0;
  const nomorBerikut = () => (langkah += 1);

  const formBaru = (
    <>
      {judulPreset && !transfer && (
        <View style={styles.presetBox}>
          <Ionicons name="pricetag-outline" size={16} color={colors.primary} />
          <Text style={styles.presetText}>{judulPreset}</Text>
        </View>
      )}

      {transfer ? (
        <AlurDana
          dari={{
            ikon: rekening?.jenis === 'BANK' ? 'business-outline' : 'wallet-outline',
            nama: rekening?.nama,
            placeholder: 'Pilih rekening sumber',
            saldo: rekening ? formatRupiah(rekening.saldo) : undefined,
            saldoSetelah: rekening && adaNominal ? formatRupiah(rekening.saldo - nominalAngka) : undefined,
            saldoSetelahBermasalah: saldoKurang,
          }}
          ke={{
            ikon: rekeningTujuan?.jenis === 'BANK' ? 'business-outline' : 'wallet-outline',
            nama: rekeningTujuan?.nama,
            placeholder: 'Pilih rekening tujuan',
            saldo: rekeningTujuan ? formatRupiah(rekeningTujuan.saldo) : undefined,
            saldoSetelah: rekeningTujuan && adaNominal ? formatRupiah(rekeningTujuan.saldo + nominalAngka) : undefined,
          }}
          nominal={adaNominal ? formatRupiah(nominalAngka) : undefined}
          onTukar={rekening || rekeningTujuan ? tukarRekening : undefined}
        />
      ) : null}

      {!kategoriPreset && !transfer && (
        <KartuLangkah nomor={nomorBerikut()} judul="Jenis transaksi">
          <PilihanOpsi<'PEMASUKAN' | 'PENGELUARAN'>
            labelAksesibilitas="Jenis transaksi"
            opsi={[
              { nilai: 'PEMASUKAN', label: 'Penerimaan', ikon: 'arrow-down-circle-outline', keterangan: 'Uang masuk ke rekening' },
              { nilai: 'PENGELUARAN', label: 'Pengeluaran', ikon: 'arrow-up-circle-outline', keterangan: 'Uang keluar dari rekening' },
            ]}
            nilai={tipe as 'PEMASUKAN' | 'PENGELUARAN'}
            onChange={(v) => setTipe(v)}
          />
        </KartuLangkah>
      )}

      <KartuLangkah
        nomor={nomorBerikut()}
        judul={transfer ? 'Rekening' : 'Rekening & akun'}
        keterangan={transfer ? 'Saldo berpindah dari rekening sumber ke rekening tujuan.' : undefined}
      >
        <RekeningPicker label={transfer ? 'Rekening sumber' : 'Rekening'} value={rekening} onChange={setRekening} />
        {errors.rekening && <FieldError message={errors.rekening} />}

        {transfer ? (
          <View style={styles.jarak}>
            <RekeningPicker
              label="Rekening tujuan"
              value={rekeningTujuan}
              onChange={setRekeningTujuan}
              kecualikanId={rekening ? `${rekening.jenis}-${rekening.id}` : undefined}
            />
            {errors.rekeningTujuan && <FieldError message={errors.rekeningTujuan} />}
          </View>
        ) : (
          <View style={styles.jarak}>
            {filterAkunLawan === 'PENERIMAAN_PENGHASILAN_LAIN' ? (
              <PenerimaanPenghasilanLainAccountPicker value={akunLawan} onChange={setAkunLawan} error={errors.akunLawan} />
            ) : (
              <>
                <AccountPicker value={akunLawan} onChange={setAkunLawan} />
                {errors.akunLawan && <FieldError message={errors.akunLawan} />}
              </>
            )}
          </View>
        )}
      </KartuLangkah>

      {!transfer && !kategoriPreset && (
        <KartuLangkah nomor={nomorBerikut()} judul="Kategori" label="Opsional">
          <View style={styles.chipRow}>
            {daftarKategori.map((k) => (
              <Chip key={k} label={k} active={kategori === k} onPress={() => setKategori(kategori === k ? null : k)} />
            ))}
          </View>
        </KartuLangkah>
      )}

      <KartuLangkah nomor={nomorBerikut()} judul="Nominal & tanggal">
        <View style={styles.labelBaris}>
          <Text style={styles.label}>Nominal *</Text>
          {transfer && rekening && rekening.saldo > 0 ? (
            <TouchableOpacity
              onPress={() => setNominal(rekening.saldo)}
              style={styles.tautan}
              accessibilityRole="button"
              accessibilityLabel={`Pindahkan seluruh saldo ${formatRupiah(rekening.saldo)}`}
            >
              <Text style={styles.tautanTeks}>Pindahkan seluruh saldo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />
        {saldoKurang && !errors.nominal && (
          <View style={styles.peringatan}>
            <Ionicons name="alert-circle" size={14} color={colors.danger} />
            <Text style={styles.peringatanTeks}>Nominal melebihi saldo rekening {formatRupiah(rekening?.saldo ?? 0)}.</Text>
          </View>
        )}

        <Text style={[styles.label, styles.jarak]}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />
      </KartuLangkah>

      <KartuLangkah nomor={nomorBerikut()} judul={transfer ? 'Keterangan' : 'Deskripsi'} label="Opsional">
        <Field label="" value={keterangan} onChangeText={setKeterangan} multiline />
      </KartuLangkah>

      {rekening && adaNominal && (transfer ? !!rekeningTujuan : !!akunLawan) ? (
        <RingkasanTransaksi
          judul={transfer ? 'Ringkasan pemindahan' : 'Ringkasan transaksi'}
          baris={
            transfer
              ? [
                  { label: 'Dari', nilai: rekening.nama },
                  { label: 'Ke', nilai: rekeningTujuan!.nama },
                  { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
                  { label: 'Nominal dipindahkan', nilai: formatRupiah(nominalAngka), tegas: true },
                ]
              : [
                  { label: 'Jenis', nilai: tipe === 'PEMASUKAN' ? 'Penerimaan' : 'Pengeluaran' },
                  { label: 'Rekening', nilai: rekening.nama },
                  { label: 'Akun lawan', nilai: `${akunLawan!.kode} — ${akunLawan!.nama}` },
                  ...(kategori ? [{ label: 'Kategori', nilai: kategori }] : []),
                  { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
                  { label: 'Nominal', nilai: formatRupiah(nominalAngka), tegas: true },
                ]
          }
        />
      ) : null}

      <TombolUtama
        label={transfer ? 'Simpan Pemindahan' : tipe === 'PEMASUKAN' ? 'Simpan Penerimaan' : 'Simpan Pengeluaran'}
        ikon="save-outline"
        onPress={submit}
        memuat={submitting}
        nonaktif={transfer && saldoKurang}
      />
    </>
  );

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={styles.konten}>
        {/* RC-S122 — Pemindahan Saldo kini punya pemisah "Pemindahan Saldo |
            Riwayat" seperti menu transaksi lain (riwayat jenis TRANSFER_BANK,
            konfigurasi PEMINDAHAN_SALDO yang sudah ada). Mode Penerimaan/
            Pengeluaran (FAB Kas & Bank) tidak memakai tab. */}
        {transfer ? (
          <>
            <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PEMINDAHAN_SALDO" />
            {tabMenu === 'RIWAYAT' ? <RiwayatTransaksiMenu menu="PEMINDAHAN_SALDO" /> : formBaru}
          </>
        ) : (
          formBaru
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      {active && <Ionicons name="checkmark" size={14} color={colors.white} />}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * UI/UX FINAL POLISH (§6, §7) — field layar ini sekarang memakai
 * `AppTextInput` bersama: label, batas, ikon per tipe, focus state, dan
 * presentasi error datang dari satu design system, bukan dari style
 * lokal tiap layar. Prop yang diterima helper ini TIDAK berubah, jadi
 * seluruh pemanggilnya tetap sama; value, handler, dan kapan error
 * muncul juga tidak disentuh.
 */
function Field({
  label,
  value,
  onChangeText,
  error,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  error?: string;
  multiline?: boolean;
  keyboardType?: any;
}) {
  return (
    <AppTextInput
      label={label || undefined}
      accessibilityLabel={label || 'Keterangan'}
      error={error}
      value={value}
      onChangeText={onChangeText}
      multiline={multiline}
      keyboardType={keyboardType}
      noIcon={!multiline}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  konten: { padding: spacing.lg, paddingBottom: spacing.xxl },
  presetBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  presetText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  jarak: { marginTop: spacing.md },
  label: { fontSize: typography.subtitle, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  labelBaris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  tautan: { minHeight: touchTarget - 8, justifyContent: 'center', marginBottom: spacing.sm },
  tautanTeks: { fontSize: typography.caption, color: colors.primary, fontWeight: '700' },
  peringatan: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  peringatanTeks: { flex: 1, color: colors.danger, fontSize: typography.caption },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: typography.caption, color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.white },
});
