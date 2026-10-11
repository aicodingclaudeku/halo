import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { tambahRekeningBank, editRekeningBank, listRekening, listJenisSimpanan, JenisSimpananItem } from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing } from '@/theme/colors';
import AppTextInput from '@/components/AppTextInput';

/**
 * Form EDIT rekening bank (fase 7 §5).
 *
 * Audit ulang (permintaan pengguna, request baru §4): alur TAMBAH data
 * bank baru sekarang inline di layar "Data Bank" (`RekeningListScreen`)
 * — form ini jadi murni untuk EDIT (dibuka lewat long-press item di
 * daftar). Cabang kode untuk mode tambah (`!rekeningId`) TETAP
 * dipertahankan di bawah sebagai fallback aman kalau ada pemanggilan
 * langsung tanpa `rekeningId` — tidak ada fungsi yang dihapus, cuma
 * pintu masuk utamanya pindah ke layar daftar.
 *
 * Audit ulang (permintaan pengguna §21/§22): field "Saldo Awal" DIHAPUS
 * dari form ini — Data Bank sekarang HANYA Nama Bank + Nomor Rekening
 * (+ Status saat edit). Saldo awal rekening bank (baru maupun lama)
 * diisi lewat menu "Saldo Akun (COA)" (SaldoAwalAkunService), bukan
 * lagi lewat form ini. `tambahRekeningBank()` sekarang dipanggil
 * tanpa `saldoAwal` sama sekali (parameter opsional di service, TIDAK
 * lagi memicu jurnal apa pun — lihat KasBankService.ts).
 */
export default function RekeningFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const rekeningId: string | undefined = route.params?.rekeningId;
  const isEdit = !!rekeningId;

  const [namaBank, setNamaBank] = useState('');
  const [nomorRekening, setNomorRekening] = useState('');
  const [aktif, setAktif] = useState(true);
  // Target §10 (permintaan pengguna): "Jenis Simpanan" — opsional,
  // dipertahankan apa adanya kalau tidak diedit (fallback aman untuk
  // rekening lama yang belum diisi).
  const [jenisSimpananList, setJenisSimpananList] = useState<JenisSimpananItem[]>([]);
  const [jenisSimpanan, setJenisSimpanan] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const list = await listJenisSimpanan({ hanyaAktif: true });
      setJenisSimpananList(list);
    })();
  }, []);

  useEffect(() => {
    if (!rekeningId) return;
    (async () => {
      const semua = await listRekening();
      const r = semua.find((x) => x.jenis === 'BANK' && x.id === rekeningId);
      if (r) {
        const [nama, nomor] = r.nama.split(' — ');
        setNamaBank(nama);
        setNomorRekening(nomor ?? '');
        setAktif(r.aktif);
        setJenisSimpanan(r.jenisSimpanan ?? null);
      }
      setLoading(false);
    })();
  }, [rekeningId]);

  const submit = async () => {
    if (!currentUser) return;
    setError(null);

    if (!namaBank.trim() || !nomorRekening.trim()) {
      setError('Nama bank dan nomor rekening wajib diisi.');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit) {
        await editRekeningBank(currentUser.id, rekeningId!, { namaBank, nomorRekening, aktif, jenisSimpanan });
      } else {
        await tambahRekeningBank({ namaBank, nomorRekening, createdBy: currentUser.id, jenisSimpanan: jenisSimpanan ?? undefined });
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan rekening.');
    } finally {
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
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Field label="Nama Bank *" value={namaBank} onChangeText={setNamaBank} />
        <Field label="Nomor Rekening *" value={nomorRekening} onChangeText={setNomorRekening} keyboardType="number-pad" />

        {jenisSimpananList.length > 0 && (
          <View style={styles.field}>
            <Text style={styles.label}>Jenis Simpanan</Text>
            <View style={styles.chipRow}>
              {jenisSimpananList.map((j) => (
                <Chip
                  key={j.kode}
                  label={j.nama}
                  active={jenisSimpanan === j.kode}
                  onPress={() => setJenisSimpanan(jenisSimpanan === j.kode ? null : j.kode)}
                />
              ))}
            </View>
          </View>
        )}

        {!isEdit && (
          <Text style={styles.hint}>
            Sudah punya saldo di rekening ini? Isi lewat menu "Saldo Awal" (Pengaturan) setelah rekening ini
            disimpan — bukan di sini.
          </Text>
        )}

        {isEdit && (
          <View style={styles.field}>
            <Text style={styles.label}>Status</Text>
            <View style={styles.chipRow}>
              <Chip label="Aktif" active={aktif} onPress={() => setAktif(true)} />
              <Chip label="Nonaktif" active={!aktif} onPress={() => setAktif(false)} />
            </View>
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan</Text>}
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
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
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: any;
}) {
  return (
    <AppTextInput label={label} value={value} onChangeText={onChangeText} keyboardType={keyboardType} noIcon />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 18 },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  errorText: { color: colors.danger, fontSize: 12, marginBottom: spacing.md, textAlign: 'center' },
  submitButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14, alignItems: 'center', marginBottom: 40 },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
