import React, { useCallback, useMemo, useState } from 'react';
import AreaAmanKeyboard, { SafeAreaBawahAman } from '@/components/AreaAmanKeyboard';
import { FlatList, Modal, ScrollView, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AppTextInput from '@/components/AppTextInput';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { colors, radius, semantic, spacing, typography, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { batalkanPengakuanPajak, JenisRiwayatPajak, LABEL_JENIS_RIWAYAT, listRiwayatPajak, RiwayatPajakItem } from '@/services/PajakService';
import { Catatan, Memuat, Segmen, TombolSimpan, pajakStyles as ps } from './PajakUi';

const IKON: Record<JenisRiwayatPajak, keyof typeof Ionicons.glyphMap> = {
  PENGAKUAN: 'calculator-outline',
  SETORAN: 'card-outline',
  ANGSURAN_PPH25: 'calendar-number-outline',
  PPH_BUNGA_SIMPANAN: 'cash-outline',
  PEMBATALAN: 'arrow-undo-outline',
  LAINNYA: 'swap-horizontal-outline',
};

/**
 * RC-S84 — Riwayat Pajak. Diturunkan langsung dari buku besar (jurnal yang
 * menyentuh akun pajak), jadi selalu sama dengan Buku Besar. Pembatalan
 * PENGAKUAN dilakukan di sini (reversal jurnal); setoran & angsuran
 * dibatalkan lewat History Transaksi seperti transaksi kas/bank lain.
 */
export default function RiwayatPajakScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const tahunIni = Number(getTanggalLokalHariIni().slice(0, 4));
  const opsiTahun = useMemo(() => [tahunIni - 2, tahunIni - 1, tahunIni].map(String), [tahunIni]);
  const [tahun, setTahun] = useState(String(tahunIni));
  const [data, setData] = useState<RiwayatPajakItem[] | null>(null);
  const [dipilih, setDipilih] = useState<RiwayatPajakItem | null>(null);
  const [alasan, setAlasan] = useState('');
  const [memproses, setMemproses] = useState(false);

  const muat = useCallback(async () => {
    setData(null);
    try {
      setData(await listRiwayatPajak(Number(tahun)));
    } catch (e) {
      setData([]);
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, [tahun]);
  useFocusRefresh(muat, [muat]);

  const tutup = () => {
    setDipilih(null);
    setAlasan('');
  };

  const batalkan = async () => {
    if (!dipilih || !currentUser) return;
    if (!alasan.trim()) {
      notify('Alasan wajib diisi', 'Tuliskan alasan pembatalan untuk jejak audit.');
      return;
    }
    setMemproses(true);
    try {
      const h = await batalkanPengakuanPajak({ journalId: dipilih.journalId, alasan, userId: currentUser.id });
      tutup();
      notify('Pengakuan dibatalkan', `Jurnal pembalik ${h.nomorJurnal} dibuat.`);
      muat();
    } catch (e) {
      notify('Gagal membatalkan', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setMemproses(false);
    }
  };

  return (
    <View style={ps.layar}>
      <View style={styles.atas}>
        <Segmen<string> opsi={opsiTahun.map((t) => ({ nilai: t, label: t }))} nilai={tahun} onChange={setTahun} />
      </View>

      {!data ? (
        <Memuat />
      ) : (
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={data}
          keyExtractor={(i) => i.journalId}
          contentContainerStyle={styles.daftar}
          ListEmptyComponent={
            <View style={styles.kosong}>
              <Ionicons name="document-outline" size={32} color={colors.textFaint} />
              <Text style={styles.kosongJudul}>Belum ada transaksi pajak di {tahun}</Text>
              <Text style={styles.kosongSub}>Pengakuan, setoran, dan angsuran pajak akan tampil di sini.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const dibalik = item.status === 'REVERSED';
            return (
              <TouchableOpacity
                style={styles.baris}
                onPress={() => setDipilih(item)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${LABEL_JENIS_RIWAYAT[item.jenis]} ${formatRupiah(item.nominal)}`}
              >
                <View style={styles.ikon}>
                  <Ionicons name={IKON[item.jenis]} size={iconSize.md} color={semantic.expenseIcon} />
                </View>
                <View style={styles.teks}>
                  <Text style={[styles.judul, dibalik && styles.coret]} numberOfLines={2}>
                    {item.deskripsi}
                  </Text>
                  <Text style={styles.sub}>
                    {LABEL_JENIS_RIWAYAT[item.jenis]} · {item.tanggal} · {item.nomorJurnal}
                    {dibalik ? ' · Dibatalkan' : ''}
                  </Text>
                </View>
                <Text style={[styles.nilai, dibalik && styles.coret]}>{formatRupiah(item.nominal)}</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <Modal visible={!!dipilih} animationType="slide" transparent onRequestClose={tutup}>
        <AreaAmanKeyboard varian="dialog" style={styles.areaKeyboard}>
          <View style={styles.latar}>
            {/*
              RC-S120 — `SafeAreaBawahAman`, bukan SafeAreaView bawah
              biasa: saat papan ketik terbuka, padding AreaAmanKeyboard
              sudah mencakup area bilah navigasi, jadi inset bawahnya
              dilepas supaya tidak ada celah ganda di atas papan ketik.
              Isinya digulir, dan lembarnya tidak melebihi ruang yang
              tersisa di atas papan ketik.
            */}
            <SafeAreaBawahAman style={styles.lembar}>
              <View style={styles.lembarHeader}>
                <Text style={modalUi.title}>{dipilih ? LABEL_JENIS_RIWAYAT[dipilih.jenis] : ''}</Text>
                <TouchableOpacity style={modalUi.closeIcon} onPress={tutup} accessibilityLabel="Tutup">
                  <Ionicons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              {dipilih ? (
                <ScrollView keyboardShouldPersistTaps="handled">
                <View style={styles.lembarIsi}>
                  <Text style={styles.detailNilai}>{formatRupiah(dipilih.nominal)}</Text>
                  <Text style={styles.detailDesk}>{dipilih.deskripsi}</Text>
                  <Text style={styles.sub}>
                    {dipilih.nomorJurnal} · {dipilih.tanggal}
                  </Text>
                  {dipilih.bisaDibatalkan ? (
                    <>
                      <View style={styles.jarak} />
                      <AppTextInput label="Alasan pembatalan" required inputType="multiline" multiline value={alasan} onChangeText={setAlasan} placeholder="Mis. salah masa pajak" />
                      <TombolSimpan label="Batalkan Pengakuan" onPress={batalkan} memproses={memproses} ikon="arrow-undo-outline" />
                    </>
                  ) : dipilih.jenis === 'SETORAN' || dipilih.jenis === 'ANGSURAN_PPH25' ? (
                    <View style={styles.jarak}>
                      <Catatan>Setoran dibatalkan lewat History Transaksi, sama seperti transaksi kas dan bank lainnya.</Catatan>
                    </View>
                  ) : dipilih.jenis === 'PPH_BUNGA_SIMPANAN' ? (
                    <View style={styles.jarak}>
                      <Catatan>Pemotongan ini menumpang pada jurnal pembukuan bunga simpanan (akrual bunga Sukarela, atau pemindahan/pencairan bunga Berjangka). Batalkan lewat layar asalnya — pajak & utang pajaknya ikut terbalik otomatis. Rincian per anggota ada di Pajak › Bukti Potong Bunga Simpanan.</Catatan>
                    </View>
                  ) : null}
                </View>
                </ScrollView>
              ) : null}
            </SafeAreaBawahAman>
          </View>
        </AreaAmanKeyboard>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  areaKeyboard: { flex: 1 },
  atas: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  daftar: { padding: spacing.lg, paddingTop: spacing.sm, flexGrow: 1 },
  baris: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  ikon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: semantic.expenseIconBackground, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  teks: { flex: 1, minWidth: 0 },
  judul: { fontSize: typography.subtitle, fontWeight: '600', color: colors.text, lineHeight: 18 },
  sub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  nilai: { fontSize: typography.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  coret: { textDecorationLine: 'line-through', color: colors.textFaint },
  kosong: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  kosongJudul: { fontSize: typography.sectionTitle, fontWeight: '600', color: colors.text },
  kosongSub: { fontSize: typography.caption, color: colors.textMuted, textAlign: 'center' },
  latar: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  lembar: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '100%' },
  lembarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  lembarIsi: { padding: spacing.lg },
  detailNilai: { fontSize: 22, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  detailDesk: { fontSize: typography.body, color: colors.text, marginTop: spacing.xs, lineHeight: 20 },
  jarak: { marginTop: spacing.md },
});
