import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DatePicker from '@/components/DatePicker';
import {
  getStatusPenyusutanPeriode,
  jalankanPenyusutanPeriode,
  getModePenyusutan,
  setModePenyusutan,
  listRingkasanPenyusutanAset,
  ModePenyusutan,
  StatusPenyusutanItem,
  RingkasanAsetPenyusutan,
} from '@/services/PenyusutanService';
import RingkasanPenyusutanAsetList from './RingkasanPenyusutanAsetList';
import {
  getStatusPengakuanPeriode,
  jalankanPengakuanPeriode,
  StatusPengakuanDimukaItem,
} from '@/services/PendapatanDimukaService';
import { toPeriode, periodeSekarang } from '@/accounting/PeriodeUtil';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';

const STATUS_LABEL: Record<string, string> = {
  BELUM_MULAI: 'Belum Mulai',
  SIAP_DIPROSES: 'Siap Diproses',
  SUDAH_DIPROSES: 'Sudah Diproses',
  SELESAI: 'Selesai',
  DIHENTIKAN: 'Aset Dihapus',
};
const STATUS_COLOR: Record<string, string> = {
  BELUM_MULAI: colors.textFaint,
  SIAP_DIPROSES: colors.warning,
  SUDAH_DIPROSES: colors.primary,
  SELESAI: colors.textMuted,
  DIHENTIKAN: colors.textFaint,
};

/**
 * Status Periode Penyusutan — pusat kendali proses bulanan: pilih
 * periode (bulan), lihat status tiap aset/pendapatan dimuka untuk
 * periode itu, lalu jalankan proses penyusutan & pengakuan pendapatan
 * sekaligus untuk semua yang siap. Aman dijalankan berkali-kali — item
 * yang sudah diproses otomatis dilewati (lihat
 * PenyusutanService/PendapatanDimukaService).
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §F): "Mode Penyusutan"
 * (Otomatis/Manual, default Otomatis) ditambahkan di bagian atas.
 * Mode OTOMATIS: `PeriodCloseService.tutupPeriode()` otomatis
 * menjalankan penyusutan untuk seluruh bulan tahun buku yang belum
 * diproses SEBELUM periode ditutup (tombol proses manual di sini
 * disembunyikan — tidak diperlukan lagi). Mode MANUAL: user WAJIB
 * menjalankan proses ini sendiri, tombol tetap tampil. Kedua mode
 * memakai `jalankanPenyusutanPeriode()` yang SAMA (idempoten, TIDAK
 * ada jurnal ganda) — TIDAK ada cron/background job (app offline-first).
 */
export default function StatusPeriodeScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const [tanggalAcuan, setTanggalAcuan] = useState(getTanggalLokalHariIni());
  const periode = toPeriode(tanggalAcuan);

  const [statusAset, setStatusAset] = useState<StatusPenyusutanItem[]>([]);
  const [statusDimuka, setStatusDimuka] = useState<StatusPengakuanDimukaItem[]>([]);
  /**
   * RC-S50 §10 — DAFTAR ASET, digabung ke layar ini.
   *
   * Sumbernya `listRingkasanPenyusutanAset()`, fungsi service yang
   * SAMA yang dipakai layar "Daftar Penyusutan" sebelumnya. Tidak ada
   * kueri baru, tidak ada perhitungan penyusutan yang dijalankan dari
   * layar ini.
   */
  const [ringkasanAset, setRingkasanAset] = useState<RingkasanAsetPenyusutan[]>([]);
  const [loading, setLoading] = useState(true);
  const [memprosesAset, setMemprosesAset] = useState(false);
  const [memprosesDimuka, setMemprosesDimuka] = useState(false);
  const [modePenyusutan, setModePenyusutanState] = useState<ModePenyusutan>('OTOMATIS');
  const [mengubahMode, setMengubahMode] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aset, dimuka, mode, ringkasan] = await Promise.all([
        getStatusPenyusutanPeriode(periode),
        getStatusPengakuanPeriode(periode),
        getModePenyusutan(),
        listRingkasanPenyusutanAset(),
      ]);
      setStatusAset(aset);
      setStatusDimuka(dimuka);
      setModePenyusutanState(mode);
      setRingkasanAset(ringkasan);
    } catch (e) {
      notify('Gagal Memuat Status', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setLoading(false);
    }
  }, [periode]);

  // §6/§13/§14 — native-stack TIDAK meng-unmount layar yang
  // ditinggalkan, jadi efek berbasis dependensi tidak berjalan ulang
  // saat pengguna kembali setelah mencatat transaksi. Diganti (bukan
  // ditambahi) dengan refresh berbasis FOKUS supaya layar selalu
  // membaca state SQLite terkini. Tidak ada timer, tidak ada remount paksa.
  useFocusRefresh(() => {
    load();
  }, [load]);

  const toggleMode = async (otomatis: boolean) => {
    if (!currentUser || mengubahMode) return;
    const modeBaru: ModePenyusutan = otomatis ? 'OTOMATIS' : 'MANUAL';
    setMengubahMode(true);
    try {
      await setModePenyusutan(modeBaru, currentUser.id);
      setModePenyusutanState(modeBaru);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMengubahMode(false);
    }
  };

  const siapAset = statusAset.filter((s) => s.status === 'SIAP_DIPROSES').length;
  const siapDimuka = statusDimuka.filter((s) => s.status === 'SIAP_DIPROSES').length;

  const prosesAset = async () => {
    if (!currentUser) return;
    setMemprosesAset(true);
    try {
      const hasil = await jalankanPenyusutanPeriode(periode, currentUser.id);
      notify(
        'Proses Penyusutan Selesai',
        `${hasil.diproses.length} aset berhasil diproses, ${hasil.dilewati.length} dilewati untuk periode ${periode}.`
      );
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemprosesAset(false);
    }
  };

  const prosesDimuka = async () => {
    if (!currentUser) return;
    setMemprosesDimuka(true);
    try {
      const hasil = await jalankanPengakuanPeriode(periode, currentUser.id);
      notify(
        'Proses Pengakuan Selesai',
        `${hasil.diproses.length} baris berhasil diakui, ${hasil.dilewati.length} dilewati untuk periode ${periode}.`
      );
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemprosesDimuka(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <View style={styles.modeCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.modeTitle}>Mode Penyusutan</Text>
          <Text style={styles.modeSub}>
            {modePenyusutan === 'OTOMATIS'
              ? 'Otomatis — penyusutan diproses sendiri saat periode ditutup.'
              : 'Manual — proses penyusutan harus dijalankan sendiri di bawah.'}
          </Text>
        </View>
        {mengubahMode ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Switch value={modePenyusutan === 'OTOMATIS'} onValueChange={toggleMode} trackColor={{ true: colors.primary }} />
        )}
      </View>

      <Text style={styles.label}>Periode (pilih tanggal apa saja di bulan target)</Text>
      <DatePicker value={tanggalAcuan} onChange={setTanggalAcuan} />
      <View style={styles.periodeBox}>
        <Ionicons name="calendar-outline" size={16} color={colors.primary} />
        <Text style={styles.periodeText}>Memproses untuk periode: {periode}</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : (
        <>
          <SectionHeader icon="trending-down-outline" title="Penyusutan Aset" siap={siapAset} />
          {statusAset.length === 0 && <Text style={styles.emptyText}>Belum ada aset tetap.</Text>}
          {statusAset.map((item) => (
            <View key={item.asetId} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemNama}>{item.namaAset}</Text>
                <Text style={styles.itemSub}>{formatRupiah(item.nilaiPenyusutanBulanan)}/bulan</Text>
              </View>
              <Text style={[styles.badge, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
            </View>
          ))}
          {siapAset > 0 && modePenyusutan === 'MANUAL' && (
            <TouchableOpacity style={[styles.prosesButton, memprosesAset && styles.disabled]} onPress={prosesAset} disabled={memprosesAset}>
              {memprosesAset ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <>
                  <Ionicons name="play-outline" size={16} color={colors.white} />
                  <Text style={styles.prosesButtonText}>Proses Penyusutan ({siapAset} aset)</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {siapAset > 0 && modePenyusutan === 'OTOMATIS' && (
            <Text style={styles.otomatisHint}>Akan diproses otomatis saat periode ditutup — tidak perlu tombol manual.</Text>
          )}

          <SectionHeader icon="time-outline" title="Pengakuan Pendapatan Dimuka" siap={siapDimuka} />
          {statusDimuka.length === 0 && <Text style={styles.emptyText}>Belum ada pendapatan diterima dimuka.</Text>}
          {statusDimuka.map((item) => (
            <View key={item.pendapatanDimukaId} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemNama}>{item.namaAnggota}</Text>
                <Text style={styles.itemSub}>{formatRupiah(item.nilaiPengakuanBulanan)}/bulan</Text>
              </View>
              <Text style={[styles.badge, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
            </View>
          ))}
          {siapDimuka > 0 && (
            <TouchableOpacity style={[styles.prosesButton, memprosesDimuka && styles.disabled]} onPress={prosesDimuka} disabled={memprosesDimuka}>
              {memprosesDimuka ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <>
                  <Ionicons name="play-outline" size={16} color={colors.white} />
                  <Text style={styles.prosesButtonText}>Proses Pengakuan ({siapDimuka} baris)</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {/* RC-S50 §10 — DAFTAR ASET.
              Menu "Daftar Penyusutan" dan "Status Periode Penyusutan"
              digabung menjadi satu menu `Penyusutan Aset`, sehingga
              daftar aset tampil sebagai SEKSI di layar yang sama —
              bukan layar kedua. Markup kartunya adalah komponen yang
              SAMA yang dipakai layar lama
              (`RingkasanPenyusutanAsetList`), jadi tampilannya tidak
              berubah sama sekali. */}
          <SectionHeader icon="cube-outline" title="Daftar Aset" siap={0} />
          {ringkasanAset.length === 0 ? (
            <Text style={styles.emptyText}>
              Belum ada aset tetap. Tambahkan lewat Transaksi &gt; Pengeluaran &gt; Pembelian Aset.
            </Text>
          ) : (
            <RingkasanPenyusutanAsetList data={ringkasanAset} />
          )}
        </>
      )}
    </ScrollView>
  );
}

function SectionHeader({ icon, title, siap }: { icon: keyof typeof Ionicons.glyphMap; title: string; siap: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={styles.sectionTitle}>{title}</Text>
      {siap > 0 && (
        <View style={styles.siapBadge}>
          <Text style={styles.siapBadgeText}>{siap} siap</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  modeTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  modeSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  otomatisHint: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic', marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  periodeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  periodeText: { fontSize: 13, fontWeight: '600', color: colors.primary },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.lg, marginBottom: spacing.sm },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1 },
  siapBadge: { backgroundColor: colors.warning, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  siapBadgeText: { fontSize: 10, fontWeight: '700', color: colors.white },
  emptyText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.xs,
  },
  itemNama: { fontSize: 13, fontWeight: '600', color: colors.text },
  itemSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  badge: { fontSize: 11, fontWeight: '700' },
  prosesButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  disabled: { opacity: 0.6 },
  prosesButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
});
