/**
 * Shim desktop `@react-native-community/datetimepicker` (paket aslinya
 * tidak punya implementasi web). Menampilkan kalender modal yang nyaman
 * dipakai dengan mouse/keyboard: navigasi bulan & tahun, "Hari ini",
 * batas min/maks, Esc untuk batal, Enter untuk pilih.
 * Kontrak event sama dengan paket aslinya: onChange({type:'set'|'dismissed'}, date).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const HIJAU = '#1B5E20';

function awalHari(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default function DateTimePicker({ value, onChange, minimumDate, maximumDate }) {
  const awal = value instanceof Date && !isNaN(value) ? value : new Date();
  const [terpilih, setTerpilih] = useState(awalHari(awal));
  const [tampil, setTampil] = useState({ y: awal.getFullYear(), m: awal.getMonth() });
  const [terbuka, setTerbuka] = useState(true);
  const min = minimumDate ? awalHari(minimumDate) : null;
  const maks = maximumDate ? awalHari(maximumDate) : null;
  const boleh = (d) => (!min || d >= min) && (!maks || d <= maks);

  const sel = useMemo(() => {
    const pertama = new Date(tampil.y, tampil.m, 1);
    const geser = (pertama.getDay() + 6) % 7;
    const jumlah = new Date(tampil.y, tampil.m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < geser; i++) out.push(null);
    for (let t = 1; t <= jumlah; t++) out.push(new Date(tampil.y, tampil.m, t));
    while (out.length % 7) out.push(null);
    return out;
  }, [tampil]);

  const tutup = (jenis, tanggal) => {
    setTerbuka(false);
    if (jenis === 'set') {
      const hasil = new Date(tanggal);
      hasil.setHours(12, 0, 0, 0);
      onChange && onChange({ type: 'set', nativeEvent: { timestamp: hasil.getTime() } }, hasil);
    } else onChange && onChange({ type: 'dismissed', nativeEvent: {} }, undefined);
  };

  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') tutup('dismissed');
      if (e.key === 'Enter' && boleh(terpilih)) tutup('set', terpilih);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const geserBulan = (n) => setTampil(({ y, m }) => {
    const d = new Date(y, m + n, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const hariIni = awalHari(new Date());

  return (
    <Modal transparent visible={terbuka} animationType="fade" onRequestClose={() => tutup('dismissed')}>
      <Pressable style={s.latar} onPress={() => tutup('dismissed')}>
        <Pressable style={s.kartu} onPress={() => undefined}>
          <Text style={s.label}>Pilih tanggal</Text>
          <Text style={s.judulTanggal}>
            {terpilih.getDate()} {BULAN[terpilih.getMonth()]} {terpilih.getFullYear()}
          </Text>
          <View style={s.navBaris}>
            <Pressable style={s.tombolNav} onPress={() => geserBulan(-12)}><Text style={s.navTeks}>«</Text></Pressable>
            <Pressable style={s.tombolNav} onPress={() => geserBulan(-1)}><Text style={s.navTeks}>‹</Text></Pressable>
            <Text style={s.bulan}>{BULAN[tampil.m]} {tampil.y}</Text>
            <Pressable style={s.tombolNav} onPress={() => geserBulan(1)}><Text style={s.navTeks}>›</Text></Pressable>
            <Pressable style={s.tombolNav} onPress={() => geserBulan(12)}><Text style={s.navTeks}>»</Text></Pressable>
          </View>
          <View style={s.grid}>
            {HARI.map((h) => (
              <Text key={h} style={[s.sel, s.hari]}>{h}</Text>
            ))}
            {sel.map((d, i) => {
              if (!d) return <View key={`k${i}`} style={s.sel} />;
              const aktif = d.getTime() === terpilih.getTime();
              const ok = boleh(d);
              const kini = d.getTime() === hariIni.getTime();
              return (
                <Pressable
                  key={d.toISOString()}
                  disabled={!ok}
                  onPress={() => setTerpilih(d)}
                  style={({ hovered }) => [s.sel, s.tgl, hovered && ok && s.hover, aktif && s.aktif, kini && !aktif && s.kini]}
                >
                  <Text style={[s.tglTeks, !ok && s.mati, aktif && s.aktifTeks]}>{d.getDate()}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={s.aksi}>
            <Pressable
              onPress={() => {
                if (boleh(hariIni)) {
                  setTerpilih(hariIni);
                  setTampil({ y: hariIni.getFullYear(), m: hariIni.getMonth() });
                }
              }}
            >
              <Text style={s.link}>Hari ini</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable style={s.btnSek} onPress={() => tutup('dismissed')}><Text style={s.btnSekTeks}>Batal</Text></Pressable>
            <Pressable style={[s.btn, !boleh(terpilih) && { opacity: 0.4 }]} disabled={!boleh(terpilih)} onPress={() => tutup('set', terpilih)}>
              <Text style={s.btnTeks}>Pilih</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export const DateTimePickerAndroid = { open: () => undefined, dismiss: () => undefined };

const s = StyleSheet.create({
  latar: { flex: 1, backgroundColor: 'rgba(16,24,16,0.45)', alignItems: 'center', justifyContent: 'center' },
  kartu: { width: 360, backgroundColor: '#fff', borderRadius: 16, padding: 20, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
  label: { fontSize: 12, color: '#6B756B', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  judulTanggal: { fontSize: 22, fontWeight: '700', color: '#1C1F1C', marginTop: 4, marginBottom: 12 },
  navBaris: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  tombolNav: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  navTeks: { fontSize: 18, color: HIJAU, fontWeight: '700' },
  bulan: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '700', color: '#1C1F1C' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  sel: { width: `${100 / 7}%`, height: 40, alignItems: 'center', justifyContent: 'center' },
  hari: { fontSize: 12, color: '#9AA39A', fontWeight: '700', textAlign: 'center', lineHeight: 40 },
  tgl: { borderRadius: 20 },
  hover: { backgroundColor: '#E8F3E9' },
  aktif: { backgroundColor: HIJAU },
  kini: { borderWidth: 1, borderColor: HIJAU },
  tglTeks: { fontSize: 14, color: '#1C1F1C' },
  aktifTeks: { color: '#fff', fontWeight: '700' },
  mati: { color: '#C9CFC9' },
  aksi: { flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 8 },
  link: { color: HIJAU, fontWeight: '700', fontSize: 14 },
  btn: { backgroundColor: HIJAU, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  btnTeks: { color: '#fff', fontWeight: '700' },
  btnSek: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  btnSekTeks: { color: '#6B756B', fontWeight: '700' },
});
