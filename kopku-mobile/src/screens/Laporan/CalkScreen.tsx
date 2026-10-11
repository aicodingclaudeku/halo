import React, { useCallback, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { getDb } from '@/database/db';
import {
  getCalkDenganEditManual,
  simpanCalkManual,
  resetCalkKeOtomatis,
  CalkGabunganResult,
} from '@/reports/FinancialReports';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { buildCalkExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import FocusTextInput from '@/components/FocusTextInput';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

/**
 * CALK — Catatan Atas Laporan Keuangan (Prioritas 12/N). Digenerate
 * PENUH dari data nyata (21 bagian, lihat FinancialReports.generateCALK)
 * lewat `getCalkDenganEditManual()` — yang menggabungkan draf otomatis
 * dengan edit manual pengguna (`calk_note`, sudah ada di skema sejak
 * awal, sebelumnya TIDAK PERNAH dipakai — layar versi lama bahkan
 * masih bertuliskan "Fitur edit manual akan tersedia pada iterasi
 * berikutnya", padahal tabelnya sudah ada; teks itu sudah dihapus).
 *
 * ATURAN PENTING: draf otomatis TIDAK PERNAH menimpa balik section
 * yang sudah diedit manual — hanya dipakai kalau section itu belum
 * pernah diedit, atau setelah user secara eksplisit menekan "Reset ke
 * Otomatis" (dengan konfirmasi).
 */
export default function CalkScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const currentUser = useAppStore((s) => s.currentUser);
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [data, setData] = useState<CalkGabunganResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);

  const permintaan = usePermintaanTerakhir();

  const load = useCallback(async (mulai: string, selesai: string) => {
    if (!mulai || !selesai) return;
    // §10 — token diambil SEBELUM await apa pun.
    const token = permintaan.mulai();
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const result = await getCalkDenganEditManual(db, mulai, selesai);
      if (!permintaan.masihTerbaru(token)) return;
      setData(result);
    } catch (e) {
      // §12 — kegagalan refresh TIDAK menimpa data valid dengan nol.
      if (!permintaan.masihTerbaru(token)) return;
      setError(e instanceof Error ? e.message : 'Gagal membuat CALK.');
    } finally {
      if (permintaan.masihTerbaru(token)) setLoading(false);
    }
  }, [permintaan]);

  // ============================================================
  // AUTO-REFRESH SAAT LAYAR KEMBALI DIFOKUSKAN (audit §B)
  // ============================================================
  // ROOT CAUSE: `ReportPeriodPicker` memanggil `onChange` HANYA sekali
  // saat mount (useEffect deps `[]`) dan saat pengguna memilih tanggal.
  // Layar ini dulu memuat data DI DALAM `onChangePeriode`, jadi
  // pemuatan terikat pada peristiwa pemilihan tanggal — bukan pada
  // peristiwa navigasi. Native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, sehingga kembali dari mencatat transaksi tidak
  // memicu apa pun dan layar menampilkan hasil perhitungan LAMA.
  //
  // Memakai helper lifecycle yang SUDAH ADA & terbukti di
  // PosisiKeuanganScreen (`useFocusRefresh` + `usePermintaanTerakhir`),
  // bukan mekanisme refresh kedua. `onChangePeriode` sekarang HANYA
  // menyimpan periode; SATU lifecycle yang memuat — baik saat filter
  // berubah selagi fokus maupun saat layar difokuskan ulang.
  // CATATAN CALK: `editingKey` SENGAJA tidak masuk dependensi —
  // refresh fokus tidak boleh membatalkan teks yang sedang diketik
  // petugas. Pembatalan edit tetap terjadi saat periode diganti
  // (di `onChangePeriode`), persis seperti sebelumnya.
  const muat = useCallback(() => {
    if (!periode) return;
    load(periode.mulai, periode.selesai);
  }, [load, periode?.mulai, periode?.selesai]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1/§A2 — TOMBOL REFRESH MANUAL.
  //
  // Memakai `muat` yang SAMA dengan initial load & focus refresh di
  // atas: satu sumber fungsi load, tidak ada kueri kedua yang dibuat
  // khusus untuk tombol. `loading` layar dipakai sebagai penguncian
  // tap sekaligus indikator — bukan state loading baru.
  useReportRefreshHeader(muat, { loading, testID: 'refresh-calk' });

  const onChangePeriode = (p: ResolvedReportPeriod) => {
    setPeriode(p);
    setEditingKey(null);
  };

  const mulaiEdit = (sectionKey: string, kontenSaatIni: string) => {
    setEditingKey(sectionKey);
    setDraftText(kontenSaatIni);
  };

  const batalEdit = () => {
    setEditingKey(null);
    setDraftText('');
  };

  const simpanEdit = async (sectionKey: string) => {
    if (!data?.periodId || !currentUser) return;
    setSaving(true);
    try {
      const db = await getDb();
      await simpanCalkManual(db, {
        periodId: data.periodId,
        sectionKey,
        konten: draftText,
        updatedBy: currentUser.id,
      });
      notify('Tersimpan', 'Catatan manual berhasil disimpan.');
      setEditingKey(null);
      if (periode) await load(periode.mulai, periode.selesai);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSaving(false);
    }
  };

  const konfirmasiReset = (sectionKey: string, judul: string) => {
    notify(
      'Reset ke Otomatis',
      `Catatan manual untuk "${judul}" akan dihapus dan kembali memakai draf otomatis dari data terbaru. Lanjutkan?`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => doReset(sectionKey) },
      ]
    );
  };

  const doReset = async (sectionKey: string) => {
    if (!data?.periodId) return;
    try {
      const db = await getDb();
      await resetCalkKeOtomatis(db, { periodId: data.periodId, sectionKey });
      notify('Berhasil', 'Section dikembalikan ke draf otomatis.');
      if (periode) await load(periode.mulai, periode.selesai);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>Catatan Atas Laporan Keuangan</Text>
        <Text style={styles.hint}>
          Draf dibuat otomatis dari data koperasi & jurnal. Setiap bagian dapat diedit manual — draf otomatis tidak
          akan menimpa bagian yang sudah Anda edit, kecuali Anda menekan "Reset ke Otomatis".
        </Text>

        {periode && (
          <View style={styles.periodeBanner}>
            <Text style={styles.periodeBannerLabel}>Untuk Periode</Text>
            <Text style={styles.periodeBannerValue}>{periode.label}</Text>
          </View>
        )}

        <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

        {loading && <ActivityIndicator style={{ marginTop: 24 }} />}
        {!loading && error && <Text style={styles.errorText}>{error}</Text>}

        {!loading && !error && data && (
          <>
            {!data.periodId && (
              <Text style={styles.warnText}>
                Tanggal ini tidak masuk periode akuntansi manapun — catatan manual tidak dapat disimpan untuk periode
                ini.
              </Text>
            )}

            <ExportButton
              data={
                koperasi
                  ? buildCalkExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data)
                  : null
              }
            />

            {data.sections.map((s) => (
              <View key={s.sectionKey} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{s.judul}</Text>
                  {s.isManualEdit && <Text style={styles.badgeManual}>Diedit Manual</Text>}
                </View>

                {editingKey === s.sectionKey ? (
                  <>
                    <FocusTextInput
                      style={styles.editInput}
                      value={draftText}
                      onChangeText={setDraftText}
                      multiline
                      placeholder="Tulis catatan..."
                    />
                    <View style={styles.editActions}>
                      <TouchableOpacity style={styles.cancelButton} onPress={batalEdit} disabled={saving}>
                        <Text style={styles.cancelButtonText}>Batal</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.saveButton, saving && styles.disabled]}
                        onPress={() => simpanEdit(s.sectionKey)}
                        disabled={saving}
                      >
                        {saving ? <ActivityIndicator color={colors.white} size="small" /> : <Text style={styles.saveButtonText}>Simpan</Text>}
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.sectionContent}>{s.konten}</Text>
                    <View style={styles.sectionActions}>
                      <TouchableOpacity onPress={() => mulaiEdit(s.sectionKey, s.konten)} disabled={!data.periodId}>
                        <Text style={[styles.actionLink, !data.periodId && styles.actionLinkDisabled]}>Edit</Text>
                      </TouchableOpacity>
                      {s.isManualEdit && (
                        <TouchableOpacity onPress={() => konfirmasiReset(s.sectionKey, s.judul)}>
                          <Text style={styles.actionLinkDanger}>Reset ke Otomatis</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </>
                )}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: 12, lineHeight: 18 },
  periodeBanner: { backgroundColor: colors.primaryLight, borderRadius: 8, padding: 12, marginBottom: 12, alignItems: 'center' },
  periodeBannerLabel: { fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  periodeBannerValue: { fontSize: 15, fontWeight: '700', color: colors.primary, marginTop: 2 },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  warnText: { color: colors.danger, fontSize: 12, marginBottom: 12, lineHeight: 16 },
  section: { marginBottom: 14, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.primary, flex: 1 },
  badgeManual: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  sectionContent: { fontSize: 13, color: colors.text, lineHeight: 19 },
  sectionActions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  actionLink: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  actionLinkDisabled: { color: colors.textMuted },
  actionLinkDanger: { fontSize: 12, color: colors.danger, fontWeight: '600' },
  // INPUT STANDARDIZATION — batas/radius/warna dari token bersama. Tanpa
  // maxHeight: catatan CALK boleh panjang dan kotaknya tetap tumbuh seperti
  // sebelumnya.
  editInput: { ...formUi.inputStandalone, minHeight: 100, paddingTop: spacing.sm, textAlignVertical: 'top' },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  cancelButton: { paddingHorizontal: 16, paddingVertical: 8 },
  cancelButtonText: { color: colors.textMuted, fontWeight: '600', fontSize: 13 },
  saveButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 16, paddingVertical: 8 },
  saveButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.6 },
});
