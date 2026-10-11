import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  createAccount,
  updateAccount,
  getAccountById,
  listAllAccounts,
  isAccountInUse,
  setLhuKlasifikasi,
  DEFAULT_NORMAL_BALANCE,
  LHU_KLASIFIKASI_LABEL,
  KategoriAkun,
  NormalBalance,
  LhuKlasifikasi,
  AccountFull,
} from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

import FocusTextInput from '@/components/FocusTextInput';
const KATEGORI_OPTIONS: { value: KategoriAkun; label: string }[] = [
  { value: 'ASET', label: 'Aset' },
  { value: 'LIABILITAS', label: 'Liabilitas' },
  { value: 'EKUITAS', label: 'Ekuitas' },
  { value: 'PENDAPATAN', label: 'Pendapatan' },
  { value: 'BEBAN', label: 'Beban' },
];

const NORMAL_BALANCE_OPTIONS: { value: NormalBalance; label: string }[] = [
  { value: 'DEBIT', label: 'Debit' },
  { value: 'KREDIT', label: 'Kredit' },
];

/**
 * "Input Akun" (Phase 17 §Q) — tambah/edit akun langsung ke Chart of
 * Accounts (tabel `account` yang sudah ada, dipakai
 * AccountingEngine/AccountMapping/seluruh laporan). Saldo normal
 * default mengikuti kategori (ASET/BEBAN=Debit,
 * LIABILITAS/EKUITAS/PENDAPATAN=Kredit) tapi bisa dioverride manual
 * untuk kasus kontra-akun (mis. akumulasi penyusutan — ASET tapi
 * saldo normal Kredit).
 *
 * Update pasca-Phase 18 §2 (permintaan pengguna): kalau akun sudah
 * dipakai di jurnal/mapping (`isAccountInUse`) ATAU akun sistem
 * (`is_system`), field STRUKTURAL (Kode, Tipe/Kategori, Saldo Normal)
 * dikunci (read-only, dengan penjelasan) — hanya Nama, Sub Kategori,
 * dan Akun Induk yang tetap bisa diedit. `updateAccount()` di
 * AccountRepository.ts MENOLAK di level service kalaupun field
 * terkunci ini entah bagaimana terkirim berubah — penguncian UI di
 * sini murni UX, bukan satu-satunya lapis pertahanan.
 */
export default function AccountFormScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const accountId: string | undefined = route.params?.accountId;
  const isEdit = !!accountId;

  const [kode, setKode] = useState('');
  const [nama, setNama] = useState('');
  const [kategori, setKategori] = useState<KategoriAkun>('ASET');
  const [normalBalance, setNormalBalance] = useState<NormalBalance>('DEBIT');
  const [normalBalanceManual, setNormalBalanceManual] = useState(false);
  const [subKategori, setSubKategori] = useState('');
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [klasifikasiLhu, setKlasifikasiLhu] = useState<LhuKlasifikasi | null>(null);
  const [parentOptions, setParentOptions] = useState<AccountFull[]>([]);
  const [existing, setExisting] = useState<AccountFull | null>(null);
  const [sudahDipakai, setSudahDipakai] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const semua = await listAllAccounts();
        setParentOptions(accountId ? semua.filter((a) => a.id !== accountId) : semua);
        if (accountId) {
          const a = await getAccountById(accountId);
          if (a) {
            setExisting(a);
            setKode(a.kode);
            setNama(a.nama);
            setKategori(a.kategori as KategoriAkun);
            setNormalBalance(a.normalBalance);
            setNormalBalanceManual(a.normalBalance !== DEFAULT_NORMAL_BALANCE[a.kategori as KategoriAkun]);
            setSubKategori(a.subKategori ?? '');
            setParentId(a.parentId ?? undefined);
            setKlasifikasiLhu(a.lhuKlasifikasi ?? null);
          }
          setSudahDipakai(await isAccountInUse(accountId));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [accountId]);

  // Field struktural terkunci kalau akun sistem ATAU sudah dipakai di
  // jurnal/mapping — lihat komentar updateAccount() di AccountRepository.ts.
  const strukturTerkunci = isEdit && (!!existing?.isSystem || sudahDipakai);

  const pilihKategori = (k: KategoriAkun) => {
    setKategori(k);
    if (!normalBalanceManual) setNormalBalance(DEFAULT_NORMAL_BALANCE[k]);
  };

  const submit = async () => {
    if (!currentUser) return;
    setError(null);
    if (!kode.trim() || !nama.trim()) {
      setError('Kode akun dan nama akun wajib diisi.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        kode: kode.trim(),
        nama: nama.trim(),
        kategori,
        normalBalance,
        subKategori: subKategori.trim() || undefined,
        parentId,
      };
      if (isEdit) {
        await updateAccount(currentUser.id, accountId!, payload);
        if (kategori === 'PENDAPATAN' || kategori === 'BEBAN') {
          if (kode.trim() !== '4-1000' && kode.trim() !== '5-2200') {
            await setLhuKlasifikasi(currentUser.id, accountId!, klasifikasiLhu);
          }
        }
      } else {
        const created = await createAccount(currentUser.id, payload);
        if ((kategori === 'PENDAPATAN' || kategori === 'BEBAN') && klasifikasiLhu) {
          await setLhuKlasifikasi(currentUser.id, created.id, klasifikasiLhu);
        }
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal menyimpan akun.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {strukturTerkunci && (
          <View style={styles.warnBox}>
            <Text style={styles.warnText}>
              {existing?.isSystem
                ? 'Akun ini adalah akun inti (dipakai mapping otomatis) — Kode, Tipe, dan Saldo Normal dikunci agar tidak mengganggu pencatatan transaksi. Nama, Sub Kategori, dan Akun Induk tetap bisa diubah.'
                : 'Akun ini sudah dipakai di jurnal/mapping transaksi — Kode, Tipe, dan Saldo Normal dikunci supaya histori laporan lama tidak salah baca. Nama, Sub Kategori, dan Akun Induk tetap bisa diubah.'}
            </Text>
          </View>
        )}

        <Text style={styles.label}>Kode Akun *</Text>
        <FocusTextInput
          style={[styles.input, strukturTerkunci && styles.inputLocked]}
          value={kode}
          onChangeText={setKode}
          editable={!strukturTerkunci}
          placeholder="Mis. 1-1700"
          placeholderTextColor={colors.placeholder}
        />

        <Text style={styles.label}>Nama Akun *</Text>
        <FocusTextInput style={styles.input} value={nama} onChangeText={setNama} placeholder="Mis. Peralatan Kantor" placeholderTextColor={colors.placeholder} />

        <Text style={styles.sectionLabel}>Tipe Akun (Kategori) *</Text>
        <View style={styles.chipRow}>
          {KATEGORI_OPTIONS.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={kategori === opt.value}
              disabled={strukturTerkunci}
              onPress={() => (strukturTerkunci ? undefined : pilihKategori(opt.value))}
            />
          ))}
        </View>

        <Text style={styles.sectionLabel}>Saldo Normal *</Text>
        <View style={styles.chipRow}>
          {NORMAL_BALANCE_OPTIONS.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={normalBalance === opt.value}
              disabled={strukturTerkunci}
              onPress={() => {
                if (strukturTerkunci) return;
                setNormalBalance(opt.value);
                setNormalBalanceManual(opt.value !== DEFAULT_NORMAL_BALANCE[kategori]);
              }}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Default mengikuti kategori — ubah manual hanya untuk akun kontra (mis. Akumulasi Penyusutan: kategori Aset,
          saldo normal Kredit).
        </Text>

        <Text style={styles.label}>Sub Kategori</Text>
        <FocusTextInput style={styles.input} value={subKategori} onChangeText={setSubKategori} placeholder="Opsional" placeholderTextColor={colors.placeholder} />

        <Text style={styles.sectionLabel}>Akun Induk (Parent)</Text>
        <View style={styles.chipRow}>
          <Chip label="Tidak ada" active={!parentId} onPress={() => setParentId(undefined)} />
          {parentOptions.map((p) => (
            <Chip key={p.id} label={`${p.kode} ${p.nama}`} active={parentId === p.id} onPress={() => setParentId(p.id)} />
          ))}
        </View>

        {(kategori === 'PENDAPATAN' || kategori === 'BEBAN') && kode.trim() !== '4-1000' && kode.trim() !== '5-2200' && (
          <>
            <Text style={styles.sectionLabel}>Klasifikasi LHU (Laporan Hasil Usaha)</Text>
            <View style={styles.chipRow}>
              {(Object.keys(LHU_KLASIFIKASI_LABEL) as LhuKlasifikasi[])
                .filter((k) => (kategori === 'PENDAPATAN' ? k !== 'BEBAN_USAHA' && k !== 'BEBAN_LAIN' : k === 'BEBAN_USAHA' || k === 'BEBAN_LAIN'))
                .map((k) => (
                  <Chip key={k} label={LHU_KLASIFIKASI_LABEL[k]} active={klasifikasiLhu === k} onPress={() => setKlasifikasiLhu(k)} />
                ))}
            </View>
            <Text style={styles.hint}>
              Menentukan posisi OTOMATIS akun ini di LHU (Partisipasi Anggota/Beban Usaha/Hasil Investasi/Pendapatan &amp; Beban
              Lain). Klasifikasi ini tidak pernah mengubah jurnal, hanya penyajian laporan.
            </Text>
          </>
        )}

        {(kode.trim() === '4-1000' || kode.trim() === '5-2200') && (
          <Text style={styles.hint}>
            Akun ini sudah punya baris tersendiri di LHU ({kode.trim() === '4-1000' ? 'Pendapatan Jasa Pinjaman' : 'Beban Pajak Penghasilan'}) — tidak perlu diklasifikasikan.
          </Text>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitText}>Simpan</Text>}
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Chip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm, marginTop: spacing.md },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipDisabled: { opacity: 0.5 },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  inputLocked: { backgroundColor: colors.background, color: colors.textMuted },
  warnBox: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  warnText: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.md, textAlign: 'center' },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: 40,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
