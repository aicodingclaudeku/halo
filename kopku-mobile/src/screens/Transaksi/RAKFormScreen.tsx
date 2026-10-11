import React, { useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem, getRekening } from '@/services/KasBankService';
import {
  catatRAK,
  editRAK,
  getRAKDetail,
  JenisRAKInput,
  JENIS_RAK_LABEL,
  JENIS_ALOKASI_RAKU,
  type JenisAlokasiRAKU,
} from '@/services/RAKService';
import { listUnitUsaha, getUnitUsaha, type UnitUsahaRow } from '@/services/KoperasiMasterService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import UnitUsahaPicker from '@/components/UnitUsahaPicker';
import { formatRupiah } from '@/utils/money';
import { getStatusModalTetapUnit } from '@/services/RAKService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

// Update pasca-Phase 18/19 (permintaan pengguna §C.4): "Setoran Dana
// ke Unit/Kantor Pusat" DIHAPUS dari pilihan transaksi BARU — hanya
// satu pilihan tersisa (dipertahankan sebagai chip supaya konsisten
// visual dengan pola pemilihan jenis di form lain, walau cuma 1 opsi).
const JENIS_OPTIONS: { value: JenisRAKInput; label: string }[] = [
  { value: 'PENYALURAN_DANA', label: JENIS_RAK_LABEL.PENYALURAN_DANA },
];

/**
 * Form RAK — Rekening Antar Kantor (Phase 18 §3, permintaan pengguna).
 * Mode tambah (default) & edit (route.params.rakId — dipanggil dari
 * RAKListScreen). Edit TIDAK meng-UPDATE jurnal lama langsung — lewat
 * RAKService.editRAK yang me-reversal transaksi lama & membuat
 * transaksi+jurnal baru (§9, "koreksi lewat mekanisme aman").
 */
export default function RAKFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const rakId: string | undefined = route.params?.rakId;
  const isEdit = !!rakId;

  const [jenisRak, setJenisRak] = useState<JenisRAKInput>('PENYALURAN_DANA');
  /**
   * Fase 9 (RAKU) — unit usaha dari MASTER, bukan teks bebas.
   *
   * Hanya unit AKTIF yang dimuat untuk transaksi baru; unit yang
   * kemudian dinonaktifkan tidak menghapus histori RAKU yang sudah
   * menunjuknya. Yang disimpan adalah `id`, bukan namanya — nama boleh
   * berubah, id tidak.
   */
  const [unitUsaha, setUnitUsaha] = useState<UnitUsahaRow[]>([]);
  const [unitUsahaId, setUnitUsahaId] = useState<string | null>(null);
  /** RC-S64: objek unit terpilih — nama unit dibaca dari sini, tidak diketik. */
  const [unitDipilih, setUnitDipilih] = useState<UnitUsahaRow | null>(null);
  /** RC-S64: status Modal Tetap unit terpilih, untuk pratinjau sebelum simpan. */
  const [statusModalTetap, setStatusModalTetap] = useState<{ sudahAda: boolean; jumlah: number | null } | null>(null);
  /** RC-S64: identitas RAKU baris ASAL saat edit — dipakai agar edit tidak menuduh dirinya sendiri duplikat. */
  const [unitUsahaAsalId, setUnitUsahaAsalId] = useState<string | null>(null);
  const [jenisAlokasiAsal, setJenisAlokasiAsal] = useState<JenisAlokasiRAKU | null>(null);
  const [jenisAlokasi, setJenisAlokasi] = useState<JenisAlokasiRAKU>('MODAL_TETAP');
  const [memuatUnit, setMemuatUnit] = useState(true);
  const [galatUnit, setGalatUnit] = useState<string | null>(null);
  const [jumlah, setJumlah] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!rakId) return;
    (async () => {
      const detail = await getRAKDetail(rakId);
      if (detail) {
        // §C.4: edit hanya dijangkau untuk baris PENYALURAN_DANA
        // (RAKListScreen sudah menyaring ini) — state selalu diisi
        // literal 'PENYALURAN_DANA' (satu-satunya nilai JenisRAKInput
        // yang valid), bukan dari detail.jenisRak (tipenya JenisRAK
        // yang masih mencakup histori SETORAN_DANA lama).
        setJenisRak('PENYALURAN_DANA');
        setJumlah(detail.jumlah);
        setTanggal(detail.tanggal);
        setKeterangan(detail.keterangan ?? '');
        // RC-S54 T13 (#19): kolom RAKU baris asal dimuat, agar edit tidak
        // membuangnya. Baris lama tanpa jenis alokasi tetap memakai pilihan
        // bawaan layar yang terlihat pengguna sebelum menyimpan.
        setUnitUsahaId(detail.unitUsahaId);
        setUnitUsahaAsalId(detail.unitUsahaId);
        setJenisAlokasiAsal(detail.jenisAlokasi);
        if (detail.jenisAlokasi) setJenisAlokasi(detail.jenisAlokasi);
        // RC-S64 §2: unit transaksi lama TETAP ditampilkan walau kini NONAKTIF.
        if (detail.unitUsahaId) {
          const u = await getUnitUsaha(detail.unitUsahaId);
          if (u) setUnitDipilih(u);
        }
        const rek = await getRekening(detail.sumberDana, detail.bankAccountId ?? undefined);
        setRekening(rek);
      }
      setLoading(false);
    })();
  }, [rakId]);

  useEffect(() => {
    let batal = false;
    setMemuatUnit(true);
    setGalatUnit(null);
    listUnitUsaha(true)
      .then((u) => {
        if (!batal) setUnitUsaha(u);
      })
      .catch((e) => {
        if (!batal) setGalatUnit(e instanceof Error ? e.message : 'Data unit usaha gagal dimuat.');
      })
      .finally(() => {
        if (!batal) setMemuatUnit(false);
      });
    return () => {
      batal = true;
    };
  }, []);

  /**
   * RC-S64 §12 — pratinjau status Modal Tetap unit terpilih.
   * Ini SEMATA informasi layar; penjaga sebenarnya `assertModalTetapBelumAda`
   * di dalam transaksi service. Dipakai untuk menonaktifkan pilihan Modal
   * Tetap dan menampilkan peringatan sebelum pengguna menekan Simpan.
   */
  useEffect(() => {
    let batal = false;
    if (!unitUsahaId) {
      setStatusModalTetap(null);
      return;
    }
    getStatusModalTetapUnit(unitUsahaId)
      .then((st) => {
        if (!batal) setStatusModalTetap({ sudahAda: st.sudahAda, jumlah: st.jumlah });
      })
      .catch(() => {
        if (!batal) setStatusModalTetap(null);
      });
    return () => {
      batal = true;
    };
  }, [unitUsahaId]);

  /**
   * RC-S64: slot Modal Tetap dianggap terkunci bila unit sudah punya Modal
   * Tetap aktif DAN transaksi yang sedang diedit bukan Modal Tetap unit itu
   * sendiri (edit nominal Modal Tetap yang sama tetap boleh).
   */
  const modalTetapTerkunci =
    !!statusModalTetap?.sudahAda && !(isEdit && jenisAlokasiAsal === 'MODAL_TETAP' && unitUsahaAsalId === unitUsahaId);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!unitUsahaId) e.unitUsaha = 'Unit usaha wajib dipilih';
    if (jenisAlokasi === 'MODAL_TETAP' && modalTetapTerkunci) {
      e.jenisAlokasi = 'Unit usaha ini sudah memiliki Modal Tetap aktif. Gunakan Modal Tambahan.';
    }
    if (jumlah === '' || jumlah <= 0) e.jumlah = 'Nominal RAKU harus lebih dari 0';
    if (!rekening) e.rekening = 'Sumber dana wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal transaksi wajib diisi';
    // RC-S54 T14 — POLICY-B: pratinjau penolakan service (service tetap penentu).
    else if (tanggal > getTanggalLokalHariIni()) e.tanggal = 'Tanggal RAKU tidak boleh setelah hari ini';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  /*
   * RC-S65 §I — KUNCI PENGIRIMAN GANDA YANG SINKRON.
   *
   * `submitting` adalah state React: `setSubmitting(true)` baru terlihat
   * pada render BERIKUTNYA. Dua ketukan yang sangat cepat masih dapat
   * masuk ke `submit()` sebelum tombol sempat ter-disable, sehingga dua
   * permintaan terkirim. `useRef` diperbarui SEKETIKA, jadi ketukan kedua
   * berhenti di baris pertama.
   *
   * Ini lapisan UI. Penjaga terakhir tetap `assertModalTetapBelumAda()`
   * di service (RC-S64), yang berjalan di dalam transaksi.
   */
  const sedangMengirim = useRef(false);

  const submit = async () => {
    if (sedangMengirim.current) return;
    if (!validate() || !rekening || !currentUser || jumlah === '') return;
    sedangMengirim.current = true;
    setSubmitting(true);
    try {
      const payload = {
        jenisRak,
        // RC-S64 §10: `namaUnit` TIDAK lagi dikirim dari layar. Service
        // menurunkannya dari master berdasarkan `unitUsahaId`, sehingga
        // kombinasi (id = A, nama = "Unit B") tidak mungkin terbentuk.
        unitUsahaId: unitUsahaId ?? undefined,
        jenisAlokasi,
        jumlah,
        tanggal,
        sumberDana: rekening.jenis === 'BANK' ? ('BANK' as const) : ('KAS' as const),
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        keterangan: keterangan || undefined,
      };
      if (isEdit && rakId) {
        await editRAK(rakId, currentUser.id, payload);
        notify('Berhasil', 'Transaksi RAKU berhasil diperbarui (jurnal lama di-reversal, jurnal baru dibuat).', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        await catatRAK({ ...payload, createdBy: currentUser.id });
        notify('Berhasil', 'Transaksi RAKU berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
      }
    } catch (e) {
      notify('Gagal', pesanRamahOperator(e));
    } finally {
      sedangMengirim.current = false;
      setSubmitting(false);
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
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        {/* Mode edit: tab disembunyikan — layar fokus pada transaksi yang sedang diubah. */}
        {!isEdit && <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="RAKU" />}
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="RAKU" />
        ) : (
        <>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Dicatat sebagai penempatan dana antar kantor (aset), bukan beban — koperasi tetap punya klaim atas dana
            ini.
          </Text>
        </View>

        {isEdit && (
          <View style={styles.warnBox}>
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.warnText}>
              Menyimpan perubahan akan membatalkan (reversal) transaksi RAK lama dan membuat transaksi baru dengan
              data ini.
            </Text>
          </View>
        )}

        <Text style={styles.sectionLabel}>Jenis RAKU</Text>
        <View style={styles.chipRow}>
          {JENIS_OPTIONS.map((opt) => (
            <Chip key={opt.value} label={opt.label} active={jenisRak === opt.value} onPress={() => setJenisRak(opt.value)} />
          ))}
        </View>

        {/*
          UNIT USAHA dari master. Memilih unit di sini MENGISI nama unit
          sekaligus — kolom nama tetap ada untuk kompatibilitas baris lama
          yang memang hanya punya teks bebas.
        */}
        {/*
          RC-S64 §2/§3 — Unit Usaha kini dipilih lewat Select/Picker dari master
          `koperasi_unit_usaha`, bukan deretan Chip, dan input teks bebas
          "Nama Unit/Kantor Tujuan" DIHAPUS. Nama unit diturunkan service dari
          master; layar tidak lagi menjadi sumber kebenaran untuk nama.
        */}
        {memuatUnit ? (
          <ActivityIndicator color={colors.primary} />
        ) : galatUnit !== null ? (
          <Text style={styles.errorText}>{galatUnit}</Text>
        ) : (
          <>
            <UnitUsahaPicker
              value={unitDipilih}
              onChange={(u) => {
                setUnitDipilih(u);
                setUnitUsahaId(u.id);
              }}
              error={errors.unitUsaha}
            />
            {unitUsaha.length === 0 && !unitDipilih && (
              <Text style={styles.hintText}>
                Belum ada unit usaha aktif. Tambahkan lewat Pengaturan → Identitas Koperasi →
                Administrasi → Unit Usaha.
              </Text>
            )}
          </>
        )}

        {/* RC-S64 §12 — status Modal Tetap unit terpilih. */}
        {!!unitUsahaId && statusModalTetap !== null && (
          <View style={statusModalTetap.sudahAda ? styles.statusBoxWarn : styles.statusBoxOk}>
            <Text style={styles.statusLabel}>Modal Tetap</Text>
            <Text style={styles.statusTitle}>
              {statusModalTetap.sudahAda
                ? `✓ Sudah dialokasikan  ${formatRupiah(statusModalTetap.jumlah ?? 0)}`
                : 'Belum dialokasikan'}
            </Text>
            <Text style={styles.statusText}>
              {statusModalTetap.sudahAda
                ? 'Satu Unit Usaha hanya dapat memiliki satu Modal Tetap aktif. Jika membutuhkan tambahan alokasi, gunakan Modal Tambahan.'
                : 'Unit Usaha ini belum pernah menerima alokasi Modal Tetap.'}
            </Text>
          </View>
        )}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Jenis Alokasi *</Text>
        <View style={styles.chipRow}>
          {JENIS_ALOKASI_RAKU.map((a) => {
            const terkunci = a === 'MODAL_TETAP' && modalTetapTerkunci;
            return (
              <Chip
                key={a}
                label={a.replace(/_/g, ' ')}
                active={jenisAlokasi === a}
                disabled={terkunci}
                onPress={() => {
                  if (terkunci) return;
                  setJenisAlokasi(a);
                }}
              />
            );
          })}
        </View>
        {errors.jenisAlokasi && <FieldError message={errors.jenisAlokasi} />}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
        <CurrencyInput value={jumlah} onChangeValue={setJumlah} error={errors.jumlah} />

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Sumber Dana / Rekening" value={rekening} onChange={setRekening} labelSaldo="Saldo Buku" />
          {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
        </View>

        <Text style={styles.label}>Tanggal Transaksi *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>{isEdit ? 'Simpan Perubahan' : 'Simpan RAKU'}</Text>
            </>
          )}
        </TouchableOpacity>
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

/**
 * RC-S65 §J — PESAN GALAT UNTUK OPERATOR KOPERASI.
 *
 * Galat BISNIS dari `RAKService` memang sudah ditulis untuk dibaca manusia
 * ("Modal Tetap ... sudah pernah dialokasikan", "Unit usaha ... NONAKTIF",
 * "Saldo Kas tidak mencukupi", dsb.) — pesan itu diteruskan apa adanya.
 *
 * Yang TIDAK boleh sampai ke layar adalah galat teknis: SQLiteException,
 * SQLITE_CONSTRAINT, TypeError, "Cannot read property", dan stack trace.
 * Galat seperti itu diganti satu kalimat netral; detail teknisnya tetap
 * masuk console untuk keperluan diagnosa.
 *
 * Ini BUKAN arsitektur error handling baru — hanya penyaring di satu titik
 * pemanggilan, memakai `notify()` yang sudah dipakai layar ini.
 */
export function pesanRamahOperator(e: unknown): string {
  const pesan = e instanceof Error ? e.message : String(e ?? '');
  const teknis = /SQLite|SQLITE_|TypeError|ReferenceError|Cannot read propert|undefined is not|null is not|at \w+ \(/i;
  if (!pesan || teknis.test(pesan)) {
    // eslint-disable-next-line no-console
    console.error('[RAK] galat teknis:', e);
    return 'Transaksi tidak dapat disimpan karena terjadi kesalahan pada aplikasi. Coba lagi; bila tetap gagal, hubungi pengurus.';
  }
  return pesan;
}

function Chip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled, selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive, disabled && styles.chipTextDisabled]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chipDisabled: { opacity: 0.45 },
  chipTextDisabled: { textDecorationLine: 'line-through' },
  statusBoxOk: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  statusBoxWarn: {
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  statusLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 2 },
  statusTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 4 },
  statusText: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.sm, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  hintText: { fontSize: 11, color: colors.textFaint, lineHeight: 16 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  warnBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: '#FFF3E0',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  warnText: { flex: 1, fontSize: 12, color: '#8A5300', lineHeight: 17 },
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
