import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { GayaPdfLaporanKeuangan } from '@/export/ExportTypes';

/**
 * OVERVIEW TEMPLATE PDF — miniatur halaman A4 untuk lembar Export laporan
 * keuangan pokok. Murni tampilan (tanpa teks/angka nyata), digambar dengan
 * View supaya tajam di semua layar dan tanpa file gambar.
 *
 *  - STANDAR : kop di tengah + garis bawah, kepala tabel bergaris atas-bawah,
 *              judul kelompok hijau, baris tanpa kisi, total bergaris ganda.
 *  - JUKLAT  : contoh laporan Lampiran Juklat SOM 2025 — kop DI DALAM tabel,
 *              seluruh sel berkisi, dua kolom tahun (lama -> baru).
 * Keduanya diakhiri blok tanda tangan pengurus.
 */
const HIJAU = '#1B5E20';
const TINTA = '#2b2f33';
const REDUP = '#b9c1c8';

function Batang({ w, h = 2, c = REDUP, mt = 0, self }: { w: `${number}%` | number; h?: number; c?: string; mt?: number; self?: 'center' | 'flex-start' | 'flex-end' }) {
  return <View style={{ width: w, height: h, backgroundColor: c, borderRadius: 1, marginTop: mt, alignSelf: self }} />;
}

function TandaTangan() {
  return (
    <View style={styles.ttd}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.ttdKolom}>
          <Batang w="70%" h={1.5} c={TINTA} self="center" />
          <Batang w="50%" h={1} c={REDUP} mt={2} self="center" />
        </View>
      ))}
    </View>
  );
}

function Standar() {
  return (
    <View style={styles.halaman}>
      <Batang w="62%" h={3} c={TINTA} self="center" />
      <Batang w="44%" h={2} c={TINTA} mt={3} self="center" />
      <Batang w="34%" h={1.5} mt={2} self="center" />
      <View style={styles.garisKop} />
      <View style={styles.kepalaStandar}>
        <Batang w="30%" c={TINTA} />
        <Batang w="18%" c={TINTA} />
      </View>
      <Batang w="34%" h={2} c={HIJAU} mt={4} />
      {[52, 44, 58, 40].map((w, i) => (
        <View key={i} style={styles.barisStandar}>
          <Batang w={`${w}%`} />
          <Batang w="20%" />
        </View>
      ))}
      <View style={styles.totalStandar}>
        <Batang w="36%" c={TINTA} />
        <Batang w="22%" c={TINTA} />
      </View>
      <TandaTangan />
    </View>
  );
}

function Juklat() {
  const sel = (isi: React.ReactNode, flex: number, akhir = false, kanan = false) => (
    <View style={[styles.sel, { flex }, akhir && styles.selAkhir, kanan && { alignItems: 'flex-end' }]}>{isi}</View>
  );
  return (
    <View style={[styles.halaman, styles.halamanJuklat]}>
      <View style={styles.tabel}>
        <View style={[styles.baris, styles.selKop]}>
          <View style={{ flex: 1 }}>
            <Batang w="64%" h={2.5} c={TINTA} />
            <Batang w="50%" h={2} c={TINTA} mt={2} />
            <Batang w="38%" h={1.5} mt={2} />
          </View>
        </View>
        <View style={styles.baris}>
          {sel(<Batang w="40%" c={TINTA} />, 2.2)}
          {sel(<Batang w="60%" c={TINTA} self="center" />, 1)}
          {sel(<Batang w="60%" c={TINTA} self="center" />, 1, true)}
        </View>
        {[60, 48, 66, 42, 55].map((w, i) => (
          <View key={i} style={styles.baris}>
            {sel(<Batang w={`${w}%`} />, 2.2)}
            {sel(<Batang w="70%" />, 1, false, true)}
            {sel(<Batang w="70%" />, 1, true, true)}
          </View>
        ))}
        <View style={[styles.baris, styles.barisAkhir]}>
          {sel(<Batang w="38%" c={TINTA} />, 2.2)}
          {sel(<Batang w="75%" c={TINTA} />, 1, false, true)}
          {sel(<Batang w="75%" c={TINTA} />, 1, true, true)}
        </View>
      </View>
      <TandaTangan />
    </View>
  );
}

export default function PratinjauGayaPdf({ gaya }: { gaya: GayaPdfLaporanKeuangan }) {
  return gaya === 'JUKLAT' ? <Juklat /> : <Standar />;
}

const styles = StyleSheet.create({
  halaman: {
    width: '100%',
    aspectRatio: 0.74,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e1e6ea',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  halamanJuklat: { paddingHorizontal: 6 },
  garisKop: { height: 1, backgroundColor: TINTA, marginTop: 4, marginBottom: 4 },
  kepalaStandar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderTopWidth: 1,
    borderBottomWidth: 0.75,
    borderColor: TINTA,
  },
  barisStandar: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  totalStandar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 5,
    paddingVertical: 3,
    borderTopWidth: 0.75,
    borderBottomWidth: 2,
    borderColor: TINTA,
  },
  tabel: { borderWidth: 0.75, borderColor: TINTA },
  baris: { flexDirection: 'row', borderBottomWidth: 0.75, borderColor: TINTA },
  barisAkhir: { borderBottomWidth: 0 },
  selKop: { padding: 3 },
  sel: { paddingHorizontal: 2, paddingVertical: 2.5, borderRightWidth: 0.75, borderColor: TINTA, justifyContent: 'center' },
  selAkhir: { borderRightWidth: 0 },
  ttd: { flexDirection: 'row', marginTop: 'auto', paddingTop: 6 },
  ttdKolom: { flex: 1 },
});
