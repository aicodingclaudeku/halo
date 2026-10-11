import React from 'react';
import { View, Text, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSyncStore } from '@/sync/SyncStore';
import { bridge } from './bridge';

/**
 * KOPKU DESKTOP — bingkai layar di luar aplikasi utama (memuat, aktivasi
 * lisensi, setup, masuk, layar kunci).
 *
 * Di HP layar-layar itu memenuhi layar ponsel. Di jendela desktop yang
 * lebar, formulir selebar 1400 px tampak janggal, jadi di sini: panel merek
 * di kiri + area formulir terpusat (maks. 560 px) di kanan.
 *
 * Struktur pohon SENGAJA tetap sama dalam semua keadaan (hanya gaya dan
 * panel merek yang berubah), sehingga LicenseGate/fase aplikasi di
 * dalamnya TIDAK pernah dipasang ulang ketika sidebar aplikasi muncul.
 */
const FITUR: { ikon: keyof typeof Ionicons.glyphMap; judul: string; ket: string }[] = [
  { ikon: 'server-outline', judul: 'Bekerja penuh offline', ket: 'Database tersimpan aman di komputer ini.' },
  { ikon: 'phone-portrait-outline', judul: 'Tersambung dengan HP', ket: 'Hubungkan lewat QR, kirim data HP ⇄ PC via Wi-Fi lokal.' },
  { ikon: 'document-text-outline', judul: 'Laporan SAK EP', ket: 'Posisi keuangan, PHU, arus kas, CALK — siap cetak & ekspor.' },
  { ikon: 'shield-checkmark-outline', judul: 'Aman & terverifikasi', ket: 'Lisensi bertanda tangan digital, akses per peran.' },
];

export default function BingkaiAplikasi({ children }: { children: React.ReactNode }) {
  const sidebarAktif = useSyncStore((s) => s.sidebarAktif);
  const { width } = useWindowDimensions();
  // RC-S133.5 — Portal Anggota memakai lebar penuh (tanpa panel merek).
  const layarPenuh = useSyncStore((s) => s.layarPenuh);
  const berbingkai = !sidebarAktif && !layarPenuh;
  const panelMerek = berbingkai && width >= 960;

  return (
    <View style={st.akar}>
      {panelMerek ? <PanelMerek /> : null}
      <View style={[st.kanan, berbingkai && st.kananBerbingkai]}>
        <View style={[st.isi, berbingkai && st.isiBerbingkai]}>{children}</View>
      </View>
    </View>
  );
}

function PanelMerek() {
  const info = bridge()?.info;
  return (
    <View style={st.merek}>
      <View style={st.merekAtas}>
        <View style={st.logoKotak}>
          <Image source={require('../../assets/img/logo-kopku.png')} style={st.logo} resizeMode="contain" />
        </View>
        <View>
          <Text style={st.nama}>KOPKU Desktop</Text>
          <Text style={st.sub}>Akuntansi Koperasi Simpan Pinjam</Text>
        </View>
      </View>

      <View>
        <Text style={st.slogan}>Keuangan koperasi yang tertib dan transparan.</Text>
        <View style={{ gap: 18, marginTop: 28 }}>
          {FITUR.map((f) => (
            <View key={f.judul} style={st.fitur}>
              <View style={st.fiturIkon}>
                <Ionicons name={f.ikon} size={18} color="#4ADE80" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.fiturJudul}>{f.judul}</Text>
                <Text style={st.fiturKet}>{f.ket}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      <Text style={st.kaki}>
        {info ? `v${info.version} · ${info.platformLabel}` : ''}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  akar: { flex: 1, flexDirection: 'row', backgroundColor: '#F1F3F6' },
  kanan: { flex: 1 },
  kananBerbingkai: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  isi: { flex: 1, width: '100%' },
  isiBerbingkai: { maxWidth: 580 },
  merek: {
    width: '40%',
    maxWidth: 560,
    minWidth: 380,
    paddingHorizontal: 48,
    paddingVertical: 44,
    justifyContent: 'space-between',
    backgroundColor: '#0E1A14',
    backgroundImage: 'radial-gradient(circle at 20% 0%, rgba(31,138,79,0.35), transparent 55%), radial-gradient(circle at 100% 100%, rgba(0,163,176,0.18), transparent 50%)',
  } as any,
  merekAtas: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  logoKotak: { width: 48, height: 48, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  logo: { width: 36, height: 36 },
  nama: { fontSize: 18, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
  sub: { fontSize: 12.5, color: '#8B9B91', marginTop: 2 },
  slogan: { fontSize: 30, lineHeight: 38, fontWeight: '800', color: '#fff', letterSpacing: -0.5, maxWidth: 420 },
  fitur: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  fiturIkon: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.25)', alignItems: 'center', justifyContent: 'center' },
  fiturJudul: { fontSize: 14, fontWeight: '700', color: '#E6EEE9' },
  fiturKet: { fontSize: 12.5, color: '#8B9B91', marginTop: 2, lineHeight: 18 },
  kaki: { fontSize: 11.5, color: '#5E6E64' },
});
