import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute, ruteDariAksi } from '@/navigation/izinRute';

/**
 * KELUAR ANGGOTA — HUB.
 *
 * MASALAH YANG DITUTUP. Sebelumnya rute `KeluarAnggotaForm` memuat
 * SATU layar panjang berisi dua pekerjaan yang berbeda sifatnya:
 * membuat pengajuan (input) dan menyetujui/menolak/membayar pengajuan
 * (monitoring + aksi uang keluar). Keduanya dipisahkan hanya oleh
 * sebuah judul di tengah, sehingga "Daftar Pengajuan" baru terlihat
 * setelah pengurus menggulir melewati seluruh form dan ringkasan hak.
 *
 * Yang membuatnya berisiko, bukan sekadar tidak rapi: kontrol "Sumber
 * Pembayaran" (KAS/BANK) berada di layar yang sama dengan form
 * pengajuan, padahal ia HANYA dipakai tombol Bayar. Dua konteks
 * bercampur di satu gulungan, dan tombol yang mengeluarkan uang berada
 * di layar yang dibuka orang untuk mengetik pengajuan baru.
 *
 * Layar ini murni NAVIGASI: tidak memanggil service apa pun, tidak
 * memuat data, tidak menghitung, dan tidak punya state. Membukanya
 * tidak menyentuh database sama sekali.
 */

interface MenuKeluar {
  kunci: string;
  icon: keyof typeof Ionicons.glyphMap;
  judul: string;
  sub: string;
  onPress: (nav: any) => void;
  aksesLabel: string;
}

// Nama rute ditulis sebagai LITERAL di dalam `navigate(...)`, bukan
// disimpan sebagai field lalu dipanggil `navigate(m.rute)`. Audit
// keterjangkauan rute proyek ini memindai pemanggilan `navigate('X')`
// secara statis; rute yang hanya dirujuk lewat variabel akan terbaca
// sebagai rute yatim — terdaftar di navigator tetapi tampak tidak
// punya jalan masuk. Pola literal ini sama dengan hub-hub lain.
const MENU: MenuKeluar[] = [
  {
    kunci: 'pengajuan',
    icon: 'document-text-outline',
    judul: 'Pengajuan',
    sub: 'Buat pengajuan keluar anggota',
    onPress: (nav) => nav.navigate('KeluarAnggotaForm'),
    aksesLabel: 'Pengajuan keluar anggota',
  },
  {
    kunci: 'daftar',
    icon: 'list-outline',
    judul: 'Daftar Pengajuan',
    sub: 'Lihat dan kelola pengajuan',
    onPress: (nav) => nav.navigate('DaftarKeluarAnggota'),
    aksesLabel: 'Daftar pengajuan keluar anggota',
  },
];

export default function KeluarAnggotaMenuScreen() {
  // RC-S132 — hanya entri yang rutenya diizinkan role ini.
  const { permissions } = usePermission();
  const menuTampil = MENU.filter((m) => bolehBukaRute(ruteDariAksi(m.onPress) ?? '', permissions));
  const navigation = useNavigation<any>();

  return (
    // Sengaja View, BUKAN ScrollView: kalau hub ini sampai perlu
    // digulir, berarti ia sudah tumbuh melampaui tujuannya.
    <View style={styles.container}>
      <Text style={styles.subtitle}>
        Kelola pengajuan dan penyelesaian hak anggota yang keluar.
      </Text>

      <View style={styles.baris}>
        {menuTampil.map((m) => (
          <Pressable
            key={m.kunci}
            style={({ pressed }) => [styles.kartu, pressed && styles.kartuDitekan]}
            onPress={() => m.onPress(navigation)}
            accessibilityRole="button"
            accessibilityLabel={m.aksesLabel}
          >
            <View style={styles.ikonBulat}>
              <Ionicons name={m.icon} size={22} color={colors.primary} />
            </View>
            <Text style={styles.kartuJudul}>{m.judul}</Text>
            <Text style={styles.kartuSub}>{m.sub}</Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.textFaint}
              style={styles.chevron}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  subtitle: { fontSize: 13, color: colors.textMuted, lineHeight: 18, marginBottom: spacing.lg },
  // Dua kolom pada lebar Android umum. `flexWrap` membuat tile jatuh ke
  // bawah (bukan terpotong) kalau lebarnya benar-benar sempit, karena
  // `minWidth` di bawah tidak lagi muat berdampingan.
  baris: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  kartu: {
    flex: 1,
    minWidth: 150,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    paddingBottom: spacing.lg,
  },
  kartuDitekan: { backgroundColor: colors.background, opacity: 0.85 },
  ikonBulat: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    marginBottom: spacing.sm,
  },
  kartuJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  kartuSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  chevron: { position: 'absolute', right: spacing.md, bottom: spacing.md },
});
