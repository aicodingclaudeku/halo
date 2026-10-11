import React, { useCallback, useRef, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { getDb } from '@/database/db';
import { getLedger, LedgerLine } from '@/reports/FinancialReports';
import AccountPicker from '@/components/AccountPicker';
import DatePicker from '@/components/DatePicker';
import { AccountItem } from '@/repositories/AccountRepository';
import { formatRupiah } from '@/utils/money';
import { buildBukuBesarExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing } from '@/theme/colors';
import TabelGeser, { SelNilai, lebarTabel, tabelUi } from '@/components/report/TabelGeser';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import { Ionicons } from '@expo/vector-icons';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh, usePermintaanTerakhir } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Buku Besar (PRD §22) — filter akun & tanggal, saldo berjalan.
 *
 * BUG FIX (UI/UX): tanggal sebelumnya diketik bebas via TextInput
 * ("YYYY-MM-DD") — rawan salah format/typo. Diganti ke DatePicker
 * native yang sama dipakai di seluruh layar lain.
 */
/** Format tampilan tanggal; string yang bukan 'YYYY-MM-DD' ditampilkan apa adanya (tidak pernah diganti tanggal hari ini). */
function tampilTanggal(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatTanggalIndonesia(s) : s;
}

export default function BukuBesarScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const [account, setAccount] = useState<AccountItem | null>(null);
  const [tanggalMulai, setTanggalMulai] = useState('');
  const [tanggalSelesai, setTanggalSelesai] = useState(getTanggalLokalHariIni());
  const [data, setData] = useState<LedgerLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permintaan = usePermintaanTerakhir();
  const pernahDitampilkan = useRef(false);

  const load = useCallback(async () => {
    if (!account) return;
    // §10 — token diambil SEBELUM await apa pun.
    const token = permintaan.mulai();
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const rows = await getLedger(db, account.id, {
        tanggalMulai: tanggalMulai || undefined,
        tanggalSelesai: tanggalSelesai || undefined,
      });
      if (!permintaan.masihTerbaru(token)) return;
      pernahDitampilkan.current = true;
      setData(rows);
    } catch (e) {
      // §12 — kegagalan refresh TIDAK menimpa data valid dengan nol.
      if (!permintaan.masihTerbaru(token)) return;
      setError(e instanceof Error ? e.message : 'Gagal memuat buku besar.');
    } finally {
      if (permintaan.masihTerbaru(token)) setLoading(false);
    }
  }, [account, tanggalMulai, tanggalSelesai, permintaan]);

  // ============================================================
  // AUTO-REFRESH SAAT LAYAR KEMBALI DIFOKUSKAN (audit §B)
  // ============================================================
  // Buku Besar berbeda dari laporan lain: pemuatan PERTAMA memang
  // sengaja dipicu tombol "Tampilkan" (akun wajib dipilih dulu, dan
  // memuat otomatis begitu akun dipilih akan mengubah alur kerja yang
  // sudah ada). Yang diperbaiki HANYA gejalanya: setelah laporan
  // pernah ditampilkan, meninggalkan layar untuk mencatat transaksi
  // lalu kembali TIDAK memuat ulang apa pun karena native-stack tidak
  // meng-unmount layar ini.
  //
  // `pernahDitampilkan` disimpan di ref, BUKAN state: kalau ia menjadi
  // dependensi `useFocusRefresh`, setiap pemuatan akan mengubah
  // dependensi dan memicu pemuatan berikutnya — loop tak berujung.
  // Filter (akun & rentang tanggal) tetap dipertahankan apa adanya.
  const muat = useCallback(() => {
    if (!account || !pernahDitampilkan.current) return;
    load();
  }, [load, account]);

  useFocusRefresh(muat, [muat]);

  // RC-S49b §A1 — TOMBOL REFRESH MANUAL.
  //
  // Memakai `load` yang SAMA dengan tombol "Tampilkan"
  // (`onPress={load}`) dan focus refresh — filter akun & rentang
  // tanggal yang sedang aktif dipertahankan apa adanya.
  //
  // Terkunci selama akun belum dipilih: Buku Besar tidak punya
  // "semua akun" untuk dimuat, dan `load()` sendiri memang berhenti
  // di baris pertamanya bila `account` kosong. Menguncinya membuat
  // keadaan itu terlihat pengguna, bukan tombol yang ditekan lalu
  // tidak terjadi apa-apa.
  useReportRefreshHeader(load, { loading, disabled: !account, testID: 'refresh-buku-besar' });

  const saldoAkhir = data && data.length > 0 ? data[data.length - 1].saldoBerjalan : null;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        <View style={styles.kop}>
          <Text style={styles.title}>Buku Besar</Text>
          {koperasi?.nama ? <Text style={styles.sub}>{koperasi.nama}</Text> : null}
        </View>

        <View style={styles.pengaturan}>
          <AccountPicker value={account} onChange={setAccount} />

          <View style={styles.dateRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Dari Tanggal</Text>
              <DatePicker value={tanggalMulai} onChange={setTanggalMulai} maximumDate={getWaktuSekarang()} />
            </View>
            <View style={{ width: spacing.sm }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Sampai Tanggal</Text>
              <DatePicker value={tanggalSelesai} onChange={setTanggalSelesai} maximumDate={getWaktuSekarang()} />
            </View>
          </View>

          <TouchableOpacity style={[styles.refreshButton, !account && styles.disabled]} onPress={load} disabled={!account}>
            <Ionicons name="search-outline" size={18} color={colors.white} />
            <Text style={styles.refreshButtonText}>Tampilkan</Text>
          </TouchableOpacity>
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
        {!loading && error && <Text style={styles.errorText}>{error}</Text>}

        {!loading && !error && data && data.length === 0 && (
          <Text style={styles.emptyText}>Tidak ada mutasi pada akun & rentang tanggal ini.</Text>
        )}

        {!loading && !error && data && data.length > 0 && (
          <>
            {account ? (
              <View style={styles.ringkasan}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.ringkasanKode}>{account.kode}</Text>
                  <Text style={styles.ringkasanNama} numberOfLines={2}>{account.nama}</Text>
                  <Text style={styles.ringkasanPeriode}>
                    {tanggalMulai ? tampilTanggal(tanggalMulai) : 'Awal'} s.d.{' '}
                    {tanggalSelesai ? tampilTanggal(tanggalSelesai) : 'Sekarang'} · {data.length} mutasi
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.ringkasanLabel}>Saldo Akhir</Text>
                  <Text style={styles.ringkasanSaldo} numberOfLines={1}>{formatRupiah(saldoAkhir ?? 0)}</Text>
                </View>
              </View>
            ) : null}

            <ExportButton
              data={
                koperasi && account
                  ? buildBukuBesarExport(
                      { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                      account.nama,
                      data,
                      `${tanggalMulai || 'Awal'} s.d. ${tanggalSelesai || 'Sekarang'}`
                    )
                  : null
              }
            />
            <TabelGeser lebarMinimum={lebarTabel(3, 220)}>
              <View style={tabelUi.header}>
                <Text style={[tabelUi.th, tabelUi.kolomAkun, { minWidth: 220 - spacing.md * 2 }]}>Tanggal / No. Jurnal</Text>
                <Text style={[tabelUi.th, tabelUi.thNilai]}>Debit</Text>
                <Text style={[tabelUi.th, tabelUi.thNilai]}>Kredit</Text>
                <Text style={[tabelUi.th, tabelUi.thNilai]}>Saldo</Text>
              </View>
              {data.map((line, idx) => (
                <View key={idx} style={[tabelUi.baris, idx % 2 === 1 && tabelUi.barisGenap]}>
                  <View style={[tabelUi.kolomAkun, { minWidth: 220 - spacing.md * 2 }]}>
                    <Text style={styles.tanggal}>{tampilTanggal(line.tanggal)}</Text>
                    <Text style={styles.nomorJurnal}>{line.nomorJurnal}</Text>
                    {line.keterangan ? <Text style={styles.keterangan} numberOfLines={2}>{line.keterangan}</Text> : null}
                  </View>
                  <SelNilai style={line.debit > 0 ? undefined : tabelUi.nilaiRedup}>{line.debit > 0 ? formatRupiah(line.debit) : '-'}</SelNilai>
                  <SelNilai style={line.kredit > 0 ? undefined : tabelUi.nilaiRedup}>{line.kredit > 0 ? formatRupiah(line.kredit) : '-'}</SelNilai>
                  <SelNilai style={[tabelUi.nilaiUtama, line.saldoBerjalan < 0 && tabelUi.nilaiNegatif]}>{formatRupiah(line.saldoBerjalan)}</SelNilai>
                </View>
              ))}
            </TabelGeser>
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: { marginBottom: spacing.md },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  pengaturan: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  label: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginBottom: spacing.xs, letterSpacing: 0.3, textTransform: 'uppercase' },
  dateRow: { flexDirection: 'row', marginTop: spacing.md, marginBottom: spacing.md },
  refreshButton: { flexDirection: 'row', gap: 6, justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 12, alignItems: 'center' },
  refreshButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 24, fontStyle: 'italic' },
  ringkasan: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  ringkasanKode: { fontSize: 11, fontWeight: '700', color: colors.primary },
  ringkasanNama: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 1 },
  ringkasanPeriode: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  ringkasanLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  ringkasanSaldo: { fontSize: 16, fontWeight: '700', color: colors.primary, marginTop: 2, fontVariant: ['tabular-nums'] },
  tanggal: { fontSize: 12.5, fontWeight: '600', color: colors.text },
  nomorJurnal: { fontSize: 11, color: colors.primary, marginTop: 1 },
  keterangan: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
});
