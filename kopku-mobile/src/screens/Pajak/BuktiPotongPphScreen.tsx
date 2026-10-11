import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaBawahAman } from '@/components/AreaAmanKeyboard';
import ExportButton from '@/components/ExportButton';
import { notify } from '@/store/useNotifyStore';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { colors, iconSize, radius, semantic, spacing, typography } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  buildBuktiPotongSatuExport,
  buildDaftarBuktiPotongExport,
  filterBuktiPotong,
  getIdentitasPemotong,
  keteranganTarifBuktiPotong,
  labelMasaPajak,
  LABEL_PRODUK_BUKTI_POTONG,
  listBuktiPotongTahun,
  ringkasBuktiPotong,
  type BuktiPotongPphBungaSimpanan,
  type IdentitasPemotong,
  type ProdukBuktiPotong,
} from '@/services/PphPotongService';
import { isiInfoPajak } from './infoPajak';
import { BarisNilai, Catatan, Lencana, Memuat, Segmen, TombolInfo, pajakStyles as ps } from './PajakUi';

/**
 * RC-S127 — BUKTI POTONG PPh PASAL 4(2) ATAS BUNGA SIMPANAN.
 *
 * Satu tempat untuk melihat SEMUA bukti potong bunga simpanan — Sukarela
 * (akrual bulanan) dan Berjangka (pemindahan ke Sukarela & pencairan) —
 * termasuk yang tarifnya 0%. Pemotongan sendiri terjadi otomatis di
 * service masing-masing produk; layar ini hanya membaca dan mencetak.
 * Semua angka & keterangan tarif dari PphPotongService — layar tidak menghitung.
 */

type FilterProduk = ProdukBuktiPotong | 'SEMUA';

export default function BuktiPotongPphScreen() {
  const tahunIni = Number(getTanggalLokalHariIni().slice(0, 4));
  const opsiTahun = useMemo(() => [tahunIni - 2, tahunIni - 1, tahunIni].map(String), [tahunIni]);
  const [tahun, setTahun] = useState(String(tahunIni));
  const [produk, setProduk] = useState<FilterProduk>('SEMUA');
  const [semua, setSemua] = useState<BuktiPotongPphBungaSimpanan[] | null>(null);
  const [identitas, setIdentitas] = useState<IdentitasPemotong | null>(null);
  const [dipilih, setDipilih] = useState<BuktiPotongPphBungaSimpanan | null>(null);

  const muat = useCallback(async () => {
    setSemua(null);
    try {
      const [daftar, id] = await Promise.all([listBuktiPotongTahun(Number(tahun)), getIdentitasPemotong()]);
      setSemua(daftar);
      setIdentitas(id);
    } catch (e) {
      setSemua([]);
      notify('Gagal memuat', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    }
  }, [tahun]);
  useFocusRefresh(muat, [muat]);

  const data = useMemo(() => (semua ? filterBuktiPotong(semua, produk) : null), [semua, produk]);
  const ringkas = useMemo(() => (data ? ringkasBuktiPotong(data) : null), [data]);
  const info = isiInfoPajak('menuBuktiPotong', Number(tahun));

  return (
    <View style={ps.layar}>
      <View style={styles.atas}>
        <Segmen<string> opsi={opsiTahun.map((t) => ({ nilai: t, label: t }))} nilai={tahun} onChange={setTahun} />
        <View style={{ height: spacing.sm }} />
        <Segmen<FilterProduk>
          opsi={[
            { nilai: 'SEMUA', label: 'Semua' },
            { nilai: 'SUKARELA', label: 'Sukarela' },
            { nilai: 'BERJANGKA', label: 'Berjangka' },
          ]}
          nilai={produk}
          onChange={setProduk}
        />
      </View>

      {!data || !ringkas ? (
        <Memuat />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.daftar}
          ListHeaderComponent={
            <View style={styles.kartu}>
              <View style={styles.barisJudul}>
                <Text style={styles.kecil}>PPh dipotong {tahun}</Text>
                <TombolInfo isi={info} />
              </View>
              <Text style={styles.total}>{formatRupiah(ringkas.totalPajak)}</Text>
              <Text style={styles.sub}>
                {ringkas.jumlah} bukti potong · {ringkas.jumlahDipotong} dipotong · {ringkas.jumlahNol} tarif 0%
                {ringkas.jumlahDibatalkan > 0 ? ` · ${ringkas.jumlahDibatalkan} dibatalkan` : ''}
              </Text>
              <Text style={styles.sub}>Bunga bruto {formatRupiah(ringkas.totalBruto)} · diterima anggota {formatRupiah(ringkas.totalNetto)}</Text>
              {identitas && data.length > 0 ? (
                <View style={{ marginTop: spacing.md }}>
                  <ExportButton data={buildDaftarBuktiPotongExport(identitas, Number(tahun), data, produk)} label="Export Daftar" />
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.kosong}>
              <Ionicons name="receipt-outline" size={32} color={colors.textFaint} />
              <Text style={styles.kosongJudul}>Belum ada bukti potong di {tahun}</Text>
              <Text style={styles.kosongSub}>
                Bukti potong terbit otomatis saat bunga simpanan dibukukan ke anggota — akrual bunga Sukarela tiap akhir bulan, atau
                pemindahan/pencairan bunga Simpanan Berjangka.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.baris}
              onPress={() => setDipilih(item)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Bukti potong ${item.nomorBuktiPotong} ${item.anggotaNama}`}
            >
              <View style={styles.ikon}>
                <Ionicons name={item.produk === 'SUKARELA' ? 'wallet-outline' : 'time-outline'} size={iconSize.md} color={semantic.expenseIcon} />
              </View>
              <View style={styles.teks}>
                <Text style={[styles.judul, item.dibatalkan && styles.coret]} numberOfLines={1}>
                  {item.anggotaNama}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.produk === 'SUKARELA' ? 'Sukarela' : 'Berjangka'} · {labelMasaPajak(item.masaPajak)} · {item.nomorBuktiPotong}
                </Text>
                <Text style={styles.sub}>Bruto {formatRupiah(item.bruto)}{item.dibatalkan ? ' · Dibatalkan' : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.nilai, item.dibatalkan && styles.coret]}>{formatRupiah(item.pajak)}</Text>
                <Lencana teks={item.pajak > 0 ? 'Dipotong' : 'Tarif 0%'} nada={item.pajak > 0 ? 'peringatan' : 'netral'} />
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={!!dipilih} animationType="slide" transparent onRequestClose={() => setDipilih(null)}>
        <View style={styles.latar}>
          <SafeAreaBawahAman style={styles.lembar}>
            <View style={styles.lembarHeader}>
              <Text style={modalUi.title}>Bukti Potong PPh 4(2)</Text>
              <TouchableOpacity style={modalUi.closeIcon} onPress={() => setDipilih(null)} accessibilityLabel="Tutup">
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            {dipilih ? (
              <ScrollView>
                <View style={styles.lembarIsi}>
                  <Text style={styles.sub}>{dipilih.nomorBuktiPotong}</Text>
                  <Text style={styles.detailNama}>{dipilih.anggotaNama}</Text>
                  <Text style={styles.sub}>
                    {dipilih.nomorAnggota}
                    {dipilih.nikAnggota ? ` · NIK ${dipilih.nikAnggota}` : ''}
                  </Text>
                  <View style={styles.jarak}>
                    <BarisNilai label="Sumber bunga" nilai={LABEL_PRODUK_BUKTI_POTONG[dipilih.produk]} />
                    {dipilih.nomorKontrak ? <BarisNilai label="Kontrak" nilai={`${dipilih.nomorKontrak} · periode ${dipilih.nomorPeriode}`} /> : null}
                    <BarisNilai label="Masa pajak" nilai={labelMasaPajak(dipilih.masaPajak)} />
                    <BarisNilai label="Tanggal potong" nilai={dipilih.tanggal} />
                    <BarisNilai label="Bunga bruto" nilai={formatRupiah(dipilih.bruto)} garisAtas />
                    <BarisNilai label="Tarif" nilai={keteranganTarifBuktiPotong(dipilih)} redam />
                    <BarisNilai label="PPh dipotong" nilai={formatRupiah(dipilih.pajak)} tebal />
                    <BarisNilai label="Diterima anggota (neto)" nilai={formatRupiah(dipilih.netto)} tebal garisAtas />
                    <BarisNilai label="Nomor jurnal" nilai={dipilih.nomorJurnal || '-'} redam />
                  </View>
                  {dipilih.dibatalkan ? (
                    <View style={styles.jarak}>
                      <Catatan nada="peringatan">Bukti potong ini tidak berlaku — jurnal pembayaran bunganya sudah dibatalkan.</Catatan>
                    </View>
                  ) : (
                    <View style={styles.jarak}>
                      <Catatan>
                        {dipilih.produk === 'SUKARELA'
                          ? 'Untuk membatalkan, batalkan akrual bulan itu di Penyesuaian › Bunga Simpanan Sukarela — PPh dan utang pajaknya ikut terbalik.'
                          : 'Untuk membatalkan, batalkan pembayaran bunga di layar Simpanan Berjangka terkait — PPh dan utang pajaknya ikut terbalik.'}
                      </Catatan>
                    </View>
                  )}
                  {identitas ? (
                    <View style={styles.jarak}>
                      <ExportButton data={buildBuktiPotongSatuExport(identitas, dipilih)} label="Cetak Bukti Potong" />
                    </View>
                  ) : null}
                </View>
              </ScrollView>
            ) : null}
          </SafeAreaBawahAman>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  atas: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  daftar: { padding: spacing.lg, paddingTop: spacing.sm, flexGrow: 1 },
  kartu: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.md },
  barisJudul: { flexDirection: 'row', alignItems: 'center' },
  kecil: { fontSize: typography.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  total: { fontSize: 24, fontWeight: '700', color: colors.text, marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
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
  judul: { fontSize: typography.subtitle, fontWeight: '600', color: colors.text },
  sub: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2 },
  nilai: { fontSize: typography.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'], marginBottom: 4 },
  coret: { textDecorationLine: 'line-through', color: colors.textFaint },
  kosong: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm, paddingHorizontal: spacing.lg },
  kosongJudul: { fontSize: typography.sectionTitle, fontWeight: '600', color: colors.text },
  kosongSub: { fontSize: typography.caption, color: colors.textMuted, textAlign: 'center', lineHeight: 18 },
  latar: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  lembar: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '90%' },
  lembarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  lembarIsi: { padding: spacing.lg },
  detailNama: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  jarak: { marginTop: spacing.md },
});
