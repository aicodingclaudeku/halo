import React, { useCallback, useEffect, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { listRekening, tambahRekeningBank, listJenisSimpanan, JenisSimpananItem, RekeningItem } from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import ExportButton from '@/components/ExportButton';
import FocusTextInput from '@/components/FocusTextInput';
import { buildDataBankExport } from '@/export/ReportTableBuilders';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

/**
 * Layar "Data Bank" (fase 7 §1-3, §6; rename dari "Rekening Bank" —
 * permintaan pengguna §4/request baru). Phase 17 §O: HANYA menampilkan
 * rekening BANK — `listRekening()` (dipakai bersama oleh picker
 * sumber dana lain yang memang butuh Kas+Bank tercampur) sengaja TIDAK
 * diubah; filter dilakukan di sini saja supaya Kas Tunai/Kas Kecil
 * (yang tetap akun kas biasa, bukan bank) tidak lagi tercampur di
 * daftar ini. Saldo Kas Tunai/Kas Kecil tetap bisa dilihat lewat
 * Saldo Akun (COA) / laporan Posisi Keuangan — datanya tidak hilang,
 * cuma tidak lagi ditampilkan sebagai "bank" di sini.
 *
 * Audit ulang (permintaan pengguna, request baru §4): layar ini
 * SEKARANG digabung — form tambah data bank inline di bagian ATAS
 * (dengan tombol "Simpan"), lalu TEPAT DI BAWAHNYA bagian "Rincian
 * Data Bank" berisi seluruh data bank yang sudah tersimpan (sebelumnya
 * dua langkah terpisah: FAB "+" -> layar form terpisah). FAB dihapus
 * karena tambah sekarang inline di sini. Edit tetap lewat layar
 * terpisah `RekeningFormScreen` (long-press item, TIDAK diubah), yang
 * juga menyediakan toggle Aktif/Nonaktif (setara "hapus" — pola soft-
 * delete yang sudah dipakai konsisten di seluruh app, tidak ada
 * hard-delete supaya integritas referensial jurnal/saldo awal yang
 * sudah menunjuk ke rekening ini tetap aman). Data bank existing TIDAK
 * hilang/berubah — `listRekening()`/`tambahRekeningBank()` dari
 * KasBankService.ts SAMA PERSIS, cuma UI-nya yang digabung.
 */
export default function RekeningListScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const [data, setData] = useState<RekeningItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [namaBank, setNamaBank] = useState('');
  const [nomorRekening, setNomorRekening] = useState('');
  // Target §10 (permintaan pengguna): "Jenis Simpanan" (Tabungan/
  // Giro/Deposito) — pilihan diambil dari bank_jenis_simpanan yang
  // AKTIF saja (admin bisa ON/OFF-kan lewat toggle terpisah, lihat
  // KasBankService.listJenisSimpanan/setJenisSimpananAktif), opsional
  // (rekening lama tanpa jenis simpanan tetap valid).
  const [jenisSimpananList, setJenisSimpananList] = useState<JenisSimpananItem[]>([]);
  const [jenisSimpanan, setJenisSimpanan] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadJenisSimpanan = useCallback(async () => {
    const list = await listJenisSimpanan({ hanyaAktif: true });
    setJenisSimpananList(list);
  }, []);

  useEffect(() => {
    loadJenisSimpanan();
  }, [loadJenisSimpanan]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listRekening();
      setData(rows.filter((r) => r.jenis === 'BANK'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar rekening.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  const totalSaldo = data.reduce((a, r) => a + r.saldo, 0);

  const simpanDataBank = async () => {
    if (!currentUser) return;
    setFormError(null);
    if (!namaBank.trim() || !nomorRekening.trim()) {
      setFormError('Nama bank dan nomor rekening wajib diisi.');
      return;
    }
    setSubmitting(true);
    try {
      await tambahRekeningBank({
        namaBank: namaBank.trim(),
        nomorRekening: nomorRekening.trim(),
        createdBy: currentUser.id,
        jenisSimpanan: jenisSimpanan ?? undefined,
      });
      setNamaBank('');
      setNomorRekening('');
      setJenisSimpanan(null);
      notify('Tersimpan', 'Data bank berhasil disimpan.');
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Gagal menyimpan data bank.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <View style={styles.container}>
        {loading && <ActivityIndicator style={styles.center} />}

        {!loading && (
          <FlatList
            data={data}
            keyExtractor={(item) => `${item.jenis}-${item.id}`}
            contentContainerStyle={{ padding: 16 }}
            ListHeaderComponent={
              <>
                <Text style={styles.sectionTitle}>Tambah Data Bank</Text>
                <View style={styles.field}>
                  <Text style={styles.label}>Nama Bank *</Text>
                  <FocusTextInput style={styles.input} value={namaBank} onChangeText={setNamaBank} placeholder="Mis. BCA" placeholderTextColor={colors.placeholder} />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Nomor Rekening *</Text>
                  <FocusTextInput
                    style={styles.input}
                    value={nomorRekening}
                    onChangeText={setNomorRekening}
                    keyboardType="number-pad"
                    placeholder="Mis. 1234567890"
                    placeholderTextColor={colors.placeholder}
                  />
                </View>
                {/* Target §10 (permintaan pengguna): "Jenis Simpanan" — tepat
                    di bawah "Nomor Rekening", opsional. Hanya jenis yang
                    AKTIF (bisa di-ON/OFF-kan admin) yang tampil di sini. */}
                {jenisSimpananList.length > 0 && (
                  <View style={styles.field}>
                    <Text style={styles.label}>Jenis Simpanan</Text>
                    <View style={styles.chipRow}>
                      {jenisSimpananList.map((j) => (
                        <TouchableOpacity
                          key={j.kode}
                          style={[styles.chip, jenisSimpanan === j.kode && styles.chipActive]}
                          onPress={() => setJenisSimpanan(jenisSimpanan === j.kode ? null : j.kode)}
                        >
                          <Text style={[styles.chipText, jenisSimpanan === j.kode && styles.chipTextActive]}>{j.nama}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}
                <Text style={styles.hint}>
                  Sudah punya saldo di rekening ini? Isi lewat menu "Saldo Akun (COA)" setelah rekening ini disimpan —
                  bukan di sini.
                </Text>
                {formError && <Text style={styles.formErrorText}>{formError}</Text>}
                <TouchableOpacity style={[styles.saveButton, submitting && styles.disabled]} onPress={simpanDataBank} disabled={submitting}>
                  {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.saveButtonText}>Simpan</Text>}
                </TouchableOpacity>

                {/* Audit ulang §4: "Rincian Data Bank" — TEPAT DI BAWAH tombol Simpan (posisi eksplisit diminta). */}
                <Text style={[styles.sectionTitle, { marginTop: spacing.xl }]}>Rincian Data Bank</Text>

                {error && <Text style={styles.errorText}>{error}</Text>}

                {!error && (
                  <>
                    <View style={styles.totalCard}>
                      <Text style={styles.totalLabel}>Total Saldo Bank</Text>
                      <Text style={styles.totalValue}>{formatRupiah(totalSaldo)}</Text>
                    </View>
                    <ExportButton
                      data={koperasi && data.length > 0 ? buildDataBankExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data) : null}
                    />
                  </>
                )}
              </>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.card, !item.aktif && styles.cardNonAktif]}
                onPress={() =>
                  // HOTFIX v108.8.4 — `KasBankHistori` hanya terdaftar di TransaksiStack
                  // (tab "Transaksi"), sedangkan layar ini dibuka dari tab "Data"
                  // (AnggotaStack). `navigate('KasBankHistori')` dari AnggotaStack tidak
                  // ditangani navigator mana pun, jadi arahkan ke owner route-nya lewat tab.
                  // `initial: false` (konvensi RC-S67.6): menu tab Transaksi tetap di bawah
                  // layar histori sehingga tombol Kembali berfungsi normal.
                  navigation.navigate('Transaksi', {
                    screen: 'KasBankHistori',
                    initial: false,
                    params: {
                      jenis: item.jenis,
                      bankAccountId: item.id,
                      namaRekening: item.nama,
                    },
                  })
                }
                onLongPress={() => navigation.navigate('RekeningForm', { rekeningId: item.id })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.nama}>{item.nama}</Text>
                  <Text style={styles.jenis}>Rekening Bank{item.aktif ? '' : ' (nonaktif)'}</Text>
                  {item.jenisSimpanan ? <Text style={styles.jenis}>Jenis Simpanan: {LABEL_JENIS_SIMPANAN[item.jenisSimpanan] ?? item.jenisSimpanan}</Text> : null}
                  {item.namaPemilik ? <Text style={styles.jenis}>Pemilik: {item.namaPemilik}</Text> : null}
                </View>
                <Text style={styles.saldo}>{formatRupiah(item.saldo)}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={!error ? <Text style={styles.emptyText}>Belum ada data bank tersimpan.</Text> : null}
            ListFooterComponent={
              data.length > 0 ? <Text style={styles.footerHint}>Tekan lama (long-press) salah satu data bank untuk mengedit atau menonaktifkan.</Text> : null
            }
          />
        )}
      </View>
    </AreaAmanKeyboard>
  );
}

const LABEL_JENIS_SIMPANAN: Record<string, string> = { TABUNGAN: 'Tabungan', GIRO: 'Giro', DEPOSITO: 'Deposito' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.danger, textAlign: 'center', marginBottom: spacing.md },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 24 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: 4 },
  input: { ...formUi.inputStandalone },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 18 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  formErrorText: { color: colors.danger, fontSize: 12, marginBottom: spacing.md, textAlign: 'center' },
  saveButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center' },
  saveButtonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.6 },
  totalCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.lg, alignItems: 'center' },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 4 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardNonAktif: { opacity: 0.5 },
  nama: { fontSize: 15, fontWeight: '700', color: colors.text },
  jenis: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  saldo: { fontSize: 15, fontWeight: '700', color: colors.primary },
  footerHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
});
