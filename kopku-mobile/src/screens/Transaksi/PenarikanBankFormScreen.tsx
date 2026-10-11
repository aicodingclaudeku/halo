import React, { useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import AppTextInput from '@/components/AppTextInput';
import FieldError from '@/components/FieldError';
import AlurDana from '@/components/form/AlurDana';
import KartuLangkah from '@/components/form/KartuLangkah';
import RingkasanTransaksi from '@/components/form/RingkasanTransaksi';
import TombolUtama from '@/components/form/TombolUtama';
import { RekeningItem, transferAntarRekening, listRekening } from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, spacing, touchTarget, typography } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Sub-fitur "Penarikan dari Bank" (Penerimaan) — kas menerima dana
 * dari rekening bank. Secara akuntansi ini transfer Bank -> Kas
 * (transferAntarRekening yang sudah ada), tapi UI-nya fokus ke satu
 * pilihan bank + sisa saldo, sesuai permintaan, bukan dua rekening
 * setara seperti form Transfer generik.
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna):
 *  - kartu Alur Dana di atas: bank -> kas, nominal, saldo sebelum & sesudah;
 *  - isian dikelompokkan jadi tiga langkah + ringkasan sebelum simpan;
 *  - picker sumber hanya menampilkan rekening BANK, picker tujuan hanya
 *    Kas/Kas Kecil (sebelumnya bebas, padahal layar ini selalu mengirim
 *    `sumberJenis: 'BANK'` sehingga memilih kas sebagai sumber pasti
 *    ditolak service);
 *  - field Keterangan kini tampil — state & parameter `keterangan` sudah
 *    dikirim ke service sejak awal, tapi tidak pernah ada isiannya;
 *  - tombol simpan benar-benar nonaktif saat saldo bank tidak cukup.
 * `transferAntarRekening`, validasi, dan alur simpan TIDAK diubah.
 */
export default function PenarikanBankFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [bank, setBank] = useState<RekeningItem | null>(null);
  const [rekeningKas, setRekeningKas] = useState<RekeningItem | null>(null);
  const [nominal, setNominal] = useState<number | ''>('');
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Isi otomatis rekening Kas Tunai sebagai tujuan default begitu layar dibuka.
  React.useEffect(() => {
    listRekening().then((rows) => {
      const kas = rows.find((r) => r.jenis === 'KAS');
      if (kas) setRekeningKas(kas);
    });
  }, []);

  const saldoTidakCukup = !!bank && nominal !== '' && nominal > bank.saldo;
  const adaNominal = nominal !== '' && nominal > 0;

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!bank) e.bank = 'Pilih bank asal dana';
    if (!rekeningKas) e.rekeningKas = 'Pilih rekening kas tujuan';
    if (nominal === '' || nominal <= 0) e.nominal = 'Jumlah harus lebih dari 0';
    if (saldoTidakCukup) e.nominal = `Saldo bank tidak cukup (saldo: ${formatRupiah(bank?.saldo ?? 0)})`;
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !bank || !rekeningKas || !currentUser || nominal === '') return;
    setSubmitting(true);
    try {
      await transferAntarRekening({
        sumberJenis: 'BANK',
        sumberBankAccountId: bank.id,
        tujuanJenis: rekeningKas.jenis,
        tujuanBankAccountId: rekeningKas.jenis === 'BANK' ? rekeningKas.id : undefined,
        tanggal,
        nominal,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Penarikan dari bank berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={styles.konten}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PEMINDAHAN_SALDO" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PEMINDAHAN_SALDO" />
        ) : (
        <>
        <AlurDana
          dari={{
            ikon: 'business-outline',
            nama: bank?.nama,
            placeholder: 'Pilih rekening bank',
            saldo: bank ? formatRupiah(bank.saldo) : undefined,
            saldoSetelah: bank && adaNominal ? formatRupiah(bank.saldo - (nominal as number)) : undefined,
            saldoSetelahBermasalah: saldoTidakCukup,
          }}
          ke={{
            ikon: 'cash-outline',
            nama: rekeningKas?.nama,
            placeholder: 'Pilih rekening kas',
            saldo: rekeningKas ? formatRupiah(rekeningKas.saldo) : undefined,
            saldoSetelah: rekeningKas && adaNominal ? formatRupiah(rekeningKas.saldo + (nominal as number)) : undefined,
          }}
          nominal={adaNominal ? formatRupiah(nominal as number) : undefined}
        />

        <KartuLangkah nomor={1} judul="Rekening" keterangan="Bank asal dana dan kas yang menerima uangnya.">
          <RekeningPicker label="Bank asal dana" value={bank} onChange={setBank} hanyaBank />
          {errors.bank && <FieldError message={errors.bank} />}

          <View style={styles.jarak}>
            <RekeningPicker
              label="Masuk ke rekening kas"
              value={rekeningKas}
              onChange={setRekeningKas}
              jenisDiizinkan={['KAS', 'KAS_KECIL']}
              kecualikanId={bank ? `${bank.jenis}-${bank.id}` : undefined}
            />
            {errors.rekeningKas && <FieldError message={errors.rekeningKas} />}
          </View>
        </KartuLangkah>

        <KartuLangkah nomor={2} judul="Nominal & tanggal">
          <View style={styles.labelBaris}>
            <Text style={styles.label}>Jumlah ditarik *</Text>
            {bank && bank.saldo > 0 ? (
              <TouchableOpacity
                onPress={() => setNominal(bank.saldo)}
                style={styles.tautan}
                accessibilityRole="button"
                accessibilityLabel={`Tarik seluruh saldo ${formatRupiah(bank.saldo)}`}
              >
                <Text style={styles.tautanTeks}>Tarik seluruh saldo</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />
          {saldoTidakCukup && !errors.nominal && (
            <View style={styles.peringatan}>
              <Ionicons name="alert-circle" size={14} color={colors.danger} />
              <Text style={styles.peringatanTeks}>Jumlah melebihi sisa saldo bank {formatRupiah(bank?.saldo ?? 0)}.</Text>
            </View>
          )}

          <Text style={[styles.label, styles.jarak]}>Tanggal transaksi *</Text>
          <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />
        </KartuLangkah>

        <KartuLangkah nomor={3} judul="Keterangan" label="Opsional">
          <AppTextInput
            value={keterangan}
            onChangeText={setKeterangan}
            multiline
            placeholder="Mis. penarikan untuk kebutuhan kas operasional"
            accessibilityLabel="Keterangan"
          />
        </KartuLangkah>

        {bank && rekeningKas && adaNominal ? (
          <RingkasanTransaksi
            judul="Ringkasan penarikan"
            baris={[
              { label: 'Ditarik dari', nilai: bank.nama },
              { label: 'Masuk ke', nilai: rekeningKas.nama },
              { label: 'Tanggal', nilai: formatTanggalIndonesia(tanggal) },
              { label: 'Saldo bank setelahnya', nilai: formatRupiah(bank.saldo - (nominal as number)) },
              { label: 'Jumlah ditarik', nilai: formatRupiah(nominal as number), tegas: true },
            ]}
          />
        ) : null}

        <TombolUtama
          label="Simpan Penarikan"
          ikon="save-outline"
          onPress={submit}
          memuat={submitting}
          nonaktif={saldoTidakCukup}
        />
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  konten: { padding: spacing.lg, paddingBottom: spacing.xxl },
  jarak: { marginTop: spacing.md },
  label: { fontSize: typography.subtitle, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  labelBaris: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  tautan: { minHeight: touchTarget - 8, justifyContent: 'center', marginBottom: spacing.sm },
  tautanTeks: { fontSize: typography.caption, color: colors.primary, fontWeight: '700' },
  peringatan: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  peringatanTeks: { flex: 1, color: colors.danger, fontSize: typography.caption },
});
