import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { getActiveKoperasi } from '@/services/SetupService';
import { useSyncStore } from '@/sync/SyncStore';

/**
 * Layar aktivasi lisensi DESKTOP: bila database sudah berisi data
 * koperasi (mis. baru diterima dari HP lewat Sinkron), jelaskan bahwa
 * desktop memakai License Key yang SAMA dengan HP (1 lisensi = 1 HP +
 * 1 Laptop/PC) dan isi otomatis Nama Koperasi — server mencocokkan nama
 * ini dengan nama yang terikat pada lisensi.
 */
export default function InfoLisensiDesktop({ namaKosong, isiNama }: { namaKosong: boolean; isiNama: (nama: string) => void }) {
  const [nama, setNama] = useState<string | null>(null);
  const otomatis = useSyncStore((st) => st.lisensiOtomatis);
  const statusSinkron = useSyncStore((st) => st.status);
  useEffect(() => {
    void getActiveKoperasi()
      .then((k) => {
        if (!k?.nama) return;
        setNama(k.nama);
        if (namaKosong) isiNama(k.nama);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!nama) return null;
  return (
    <View style={s.kotak}>
      <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={s.judul}>Data “{nama}” sudah ada di komputer ini</Text>
        <Text style={s.teks}>
          {statusSinkron === 'BELUM_DIPASANGKAN'
            ? 'Aktifkan lisensi desktop dengan License Key yang SAMA seperti di HP — satu lisensi berlaku untuk 1 HP + 1 Laptop/PC. Nama koperasi sudah diisi otomatis.'
            : 'Lisensi desktop diaktifkan OTOMATIS dari HP yang terpasang saat HP menyinkronkan (komputer ini perlu tersambung internet sekali). Bisa juga diisi manual dengan License Key yang sama seperti di HP — satu lisensi berlaku untuk 1 HP + 1 Laptop/PC.'}
        </Text>
        {!!otomatis && (
          <Text style={[s.teks, { marginTop: 6, fontWeight: '700', color: otomatis.ok ? colors.primary : colors.danger }]}>
            Lisensi otomatis dari HP: {otomatis.pesan}
          </Text>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  kotak: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: colors.primaryLight, borderRadius: 14, padding: 14, marginTop: 14, marginBottom: 4, alignSelf: 'stretch' },
  judul: { fontSize: 14, fontWeight: '800', color: colors.primary },
  teks: { fontSize: 13, color: '#2F382F', marginTop: 3, lineHeight: 19 },
});
