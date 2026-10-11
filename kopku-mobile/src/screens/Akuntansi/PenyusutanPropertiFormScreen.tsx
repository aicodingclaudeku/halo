import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import InvestasiPicker from '@/components/InvestasiPicker';
import DatePicker from '@/components/DatePicker';
import CurrencyInput from '@/components/CurrencyInput';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { InvestasiListItem } from '@/services/InvestasiService';
import {
  simpanKonfigurasiPenyusutanProperti,
  prosesPenyusutanPropertiInvestasi,
  getPeriodePenyusutanPropertiTertunggak,
  listPenyusutanPropertiInvestasi,
  JenisObjekProperti,
  InvestasiPenyusutanRow,
} from '@/services/PenyusutanPropertiInvestasiService';
import { useAppStore } from '@/store/useAppStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * PENYUSUTAN PROPERTI INVESTASI — RC-S53 corrective.
 *
 * POLICY 03 = MODEL BIAYA, sehingga properti investasi yang berupa
 * bangunan harus disusutkan. Layar ini mengumpulkan parameter yang
 * memang harus datang dari pengurus — sifat objek, nilai bangunan yang
 * dapat disusutkan, nilai residu, masa manfaat, tanggal mulai — lalu
 * memanggil `PenyusutanPropertiInvestasiService`.
 *
 * NOL logika akuntansi di berkas ini: tidak ada SQL, tidak ada
 * perhitungan penyusutan, tidak ada pemanggilan AccountingEngine. Nilai
 * penyusutan dan jurnalnya sepenuhnya milik service.
 *
 * TIDAK ADA TOMBOL "PROSES SEMUA". Periode tertunggak DITAMPILKAN satu
 * per satu dan diproses satu per satu atas perintah eksplisit — catch-up
 * diam-diam atas periode historis justru yang harus dihindari.
 */

const JENIS_OBJEK: { nilai: JenisObjekProperti; label: string; catatan: string }[] = [
  { nilai: 'TANAH', label: 'Tanah saja', catatan: 'Tanah tidak disusutkan.' },
  { nilai: 'BANGUNAN', label: 'Bangunan saja', catatan: 'Seluruh nilai dapat disusutkan.' },
  {
    nilai: 'TANAH_DAN_BANGUNAN',
    label: 'Tanah dan bangunan',
    catatan: 'Nilai bangunannya wajib dinyatakan sendiri — porsinya tidak ditaksir sistem.',
  },
];

export default function PenyusutanPropertiFormScreen() {
  const currentUser = useAppStore((s) => s.currentUser);

  const [investasi, setInvestasi] = useState<InvestasiListItem | null>(null);
  const [jenisObjek, setJenisObjek] = useState<JenisObjekProperti | null>(null);
  const [nilaiDapatDisusutkan, setNilaiDapatDisusutkan] = useState<number | ''>('');
  const [nilaiResidu, setNilaiResidu] = useState<number | ''>('');
  const [masaManfaat, setMasaManfaat] = useState('');
  const [tanggalMulai, setTanggalMulai] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [menyimpan, setMenyimpan] = useState(false);

  const [tertunggak, setTertunggak] = useState<string[]>([]);
  const [catatanTertunggak, setCatatanTertunggak] = useState<string | null>(null);
  const [riwayat, setRiwayat] = useState<InvestasiPenyusutanRow[]>([]);
  const [memproses, setMemproses] = useState<string | null>(null);

  const muat = useCallback(() => {
    if (!investasi) {
      setTertunggak([]);
      setRiwayat([]);
      setCatatanTertunggak(null);
      return;
    }
    listBersih(investasi.id);
  }, [investasi]);

  const listBersih = (investasiId: string) => {
    listPenyusutanPropertiInvestasi({ investasiId })
      .then(setRiwayat)
      .catch(() => setRiwayat([]));
    getPeriodePenyusutanPropertiTertunggak(investasiId)
      .then((p) => {
        setTertunggak(p);
        setCatatanTertunggak(null);
      })
      .catch((e) => {
        // Properti yang belum dikonfigurasi, berupa tanah, atau punya DATA
        // GAP komponen akan sampai ke sini — alasannya ditampilkan apa
        // adanya, bukan disembunyikan sebagai daftar kosong.
        setTertunggak([]);
        setCatatanTertunggak(e instanceof Error ? e.message : 'Belum dapat disusutkan.');
      });
  };

  useFocusRefresh(muat, [investasi?.id]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!investasi) e.investasi = 'Pilih properti investasi';
    if (!jenisObjek) e.jenisObjek = 'Tetapkan sifat objek';
    if (jenisObjek && jenisObjek !== 'TANAH') {
      if (nilaiDapatDisusutkan === '' || nilaiDapatDisusutkan <= 0) {
        e.nilaiDapatDisusutkan = 'Nilai bangunan yang dapat disusutkan wajib diisi, lebih dari 0';
      }
      if (nilaiResidu === '') e.nilaiResidu = 'Nilai residu wajib dinyatakan (boleh 0)';
      if (!masaManfaat.trim() || Number(masaManfaat) <= 0) {
        e.masaManfaat = 'Masa manfaat (bulan) wajib diisi, lebih dari 0';
      }
      if (!tanggalMulai) e.tanggalMulai = 'Tanggal mulai penyusutan wajib diisi';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const simpan = async () => {
    if (!validate()) return;
    if (!investasi || !jenisObjek || !currentUser) return;
    setMenyimpan(true);
    try {
      await simpanKonfigurasiPenyusutanProperti({
        investasiId: investasi.id,
        jenisObjek,
        nilaiDapatDisusutkan: nilaiDapatDisusutkan === '' ? undefined : nilaiDapatDisusutkan,
        nilaiResidu: nilaiResidu === '' ? undefined : nilaiResidu,
        masaManfaatBulan: masaManfaat ? Number(masaManfaat) : undefined,
        tanggalMulaiPenyusutan: tanggalMulai,
        createdBy: currentUser.id,
      });
      notify('Tersimpan', 'Parameter penyusutan properti disimpan. Tidak ada jurnal yang dibuat oleh langkah ini.');
      listBersih(investasi.id);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMenyimpan(false);
    }
  };

  const proses = async (periode: string) => {
    if (!investasi || !currentUser) return;
    setMemproses(periode);
    try {
      const hasil = await prosesPenyusutanPropertiInvestasi({
        investasiId: investasi.id,
        periode,
        createdBy: currentUser.id,
      });
      notify(
        hasil.dibuat ? 'Berhasil' : 'Sudah pernah diproses',
        hasil.dibuat
          ? `Penyusutan periode ${periode} sebesar ${formatRupiah(hasil.row.nilaiPenyusutan)} telah dijurnal.`
          : `Periode ${periode} sudah punya jurnal penyusutan — tidak ada jurnal kedua yang dibuat.`
      );
      listBersih(investasi.id);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(null);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Text style={styles.catatan}>
          Properti investasi diukur dengan model biaya, sehingga bangunan disusutkan dan tanah tidak.
          Masa manfaat, nilai residu, dan porsi bangunan TIDAK diisi otomatis — semuanya harus
          dinyatakan pengurus.
        </Text>

        {/* Hanya properti investasi yang boleh dipilih. Penjagaan akuntansi
            tetap di service (`BUKAN_PROPERTI_INVESTASI`); filter ini
            semata-mata agar pengguna tidak memilih objek yang pasti
            ditolak. */}
        <InvestasiPicker
          value={investasi}
          onChange={setInvestasi}
          error={errors.investasi}
          onlyJenisInvestasi="PROPERTI_INVESTASI"
        />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Sifat Objek *</Text>
        {JENIS_OBJEK.map((j) => (
          <TouchableOpacity key={j.nilai} style={styles.pilihanRow} onPress={() => setJenisObjek(j.nilai)}>
            <View style={[styles.radio, jenisObjek === j.nilai && styles.radioAktif]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.pilihanLabel}>{j.label}</Text>
              <Text style={styles.pilihanCatatan}>{j.catatan}</Text>
            </View>
          </TouchableOpacity>
        ))}
        {errors.jenisObjek && <Text style={styles.errorText}>{errors.jenisObjek}</Text>}

        {jenisObjek && jenisObjek !== 'TANAH' && (
          <View>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Bangunan yang Dapat Disusutkan *</Text>
            <CurrencyInput
              value={nilaiDapatDisusutkan}
              onChangeValue={setNilaiDapatDisusutkan}
              error={errors.nilaiDapatDisusutkan}
            />

            <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Residu *</Text>
            <CurrencyInput value={nilaiResidu} onChangeValue={setNilaiResidu} error={errors.nilaiResidu} />

            <Text style={[styles.label, { marginTop: spacing.md }]}>Masa Manfaat (bulan) *</Text>
            <FocusTextInput
              style={styles.input}
              value={masaManfaat}
              onChangeText={setMasaManfaat}
              keyboardType="number-pad"
              placeholder="mis. 240"
              placeholderTextColor={colors.placeholder}
              invalid={!!errors.masaManfaat}
            />
            {errors.masaManfaat && <FieldError message={errors.masaManfaat} />}

            <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal Mulai Penyusutan *</Text>
            <DatePicker value={tanggalMulai} onChange={setTanggalMulai} maximumDate={getWaktuSekarang()} />
            {errors.tanggalMulai && <Text style={styles.errorText}>{errors.tanggalMulai}</Text>}
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitButton, menyimpan && styles.disabled]}
          onPress={simpan}
          disabled={menyimpan}
        >
          {menyimpan ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.submitButtonText}>Simpan Parameter Penyusutan</Text>
          )}
        </TouchableOpacity>

        {investasi && (
          <View style={styles.blok}>
            <Text style={styles.blokJudul}>Periode Belum Disusutkan</Text>
            {catatanTertunggak && <Text style={styles.gapText}>{catatanTertunggak}</Text>}
            {!catatanTertunggak && tertunggak.length === 0 && (
              <Text style={styles.kosong}>Tidak ada periode tertunggak.</Text>
            )}
            {tertunggak.map((p) => (
              <View key={p} style={styles.periodeRow}>
                <Text style={styles.periodeText}>{p}</Text>
                <TouchableOpacity
                  style={[styles.prosesButton, memproses === p && styles.disabled]}
                  onPress={() => proses(p)}
                  disabled={memproses !== null}
                >
                  {memproses === p ? (
                    <ActivityIndicator color={colors.white} size="small" />
                  ) : (
                    <Text style={styles.prosesButtonText}>Proses</Text>
                  )}
                </TouchableOpacity>
              </View>
            ))}
            <Text style={styles.gapCatatan}>
              Setiap periode diproses satu per satu dan atas perintah Anda — tidak ada penyusutan
              periode lampau yang dijurnal diam-diam.
            </Text>
          </View>
        )}

        {investasi && riwayat.length > 0 && (
          <View style={styles.blok}>
            <Text style={styles.blokJudul}>Riwayat Penyusutan</Text>
            {riwayat.map((r) => (
              <View key={r.id} style={styles.riwayatRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.periodeText}>{r.periode}</Text>
                  <Text style={styles.riwayatSub}>
                    {r.tanggal} · Journal ID {r.journalId}
                  </Text>
                </View>
                <Text style={styles.riwayatNominal}>{formatRupiah(r.nilaiPenyusutan)}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  catatan: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, marginBottom: 4, fontWeight: '600' },
  input: { ...formUi.inputStandalone },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 4 },
  pilihanRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginTop: 2,
  },
  radioAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  pilihanLabel: { fontSize: 13, color: colors.text, fontWeight: '600' },
  pilihanCatatan: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  submitButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },
  blok: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
  },
  blokJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  kosong: { fontSize: 12, color: colors.textMuted },
  gapText: { fontSize: 12, color: colors.danger, lineHeight: 17 },
  gapCatatan: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 16 },
  periodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  periodeText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  prosesButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  prosesButtonText: { color: colors.white, fontWeight: '700', fontSize: 12 },
  riwayatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  riwayatSub: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  riwayatNominal: { fontSize: 13, fontWeight: '700', color: colors.text },
});
