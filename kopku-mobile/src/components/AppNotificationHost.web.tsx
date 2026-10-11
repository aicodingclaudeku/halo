import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNotifyStore, NotifyType } from '@/store/useNotifyStore';
import { colors } from '@/theme/colors';

/**
 * KOPKU DESKTOP — dialog notifikasi/konfirmasi global.
 *
 * Fungsi SAMA dengan AppNotificationHost HP (store `useNotifyStore`,
 * urutan & gaya tombol, `hide()` lalu `onPress`), tampilan dialog
 * desktop: lebar terbatas, ikon di kiri, tombol rata kanan, dan keyboard
 * — Enter = tombol utama (tombol terakhir yang bukan Batal), Esc = Batal.
 */
const ICON_BY_TYPE: Record<NotifyType, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'close-circle',
  warning: 'alert-circle',
  info: 'information-circle',
};

const COLOR_BY_TYPE: Record<NotifyType, string> = {
  success: colors.success,
  error: colors.danger,
  warning: colors.warning,
  info: colors.primary,
};

export default function AppNotificationHost() {
  const { visible, type, title, message, buttons, hide } = useNotifyStore();
  const iconColor = COLOR_BY_TYPE[type];

  // RC-S133.6.1 — temuan audit (a): di react-native-web portal <Modal>
  // dibuat sekali lalu DIPERTAHANKAN di <body>. Setelah notifikasi pertama
  // muncul, modal lain yang dibuka sesudahnya (mis. "Cairkan Pinjaman")
  // berada di ATAS portal notifikasi, sehingga pesan "Gagal ..." yang
  // muncul ketika modal itu masih terbuka tertutup dan tidak terlihat
  // (dibuktikan lewat UI: urutan portal di DOM + tangkapan layar).
  // Kunci baru setiap kali notifikasi tampil memaksa portal dibuat ulang
  // di akhir <body>, sehingga notifikasi selalu berada paling atas.
  const urutanTampil = useRef(0);
  const sebelumnya = useRef(false);
  if (visible && !sebelumnya.current) urutanTampil.current += 1;
  sebelumnya.current = visible;

  const handlePress = (btn: (typeof buttons)[number]) => {
    hide();
    btn.onPress?.();
  };

  useEffect(() => {
    if (!visible) return;
    const tombol = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const batal = buttons.find((b) => b.style === 'cancel');
        if (batal) handlePress(batal);
        else if (buttons.length <= 1) handlePress(buttons[0] ?? { text: 'OK' });
      } else if (e.key === 'Enter') {
        const utama = [...buttons].reverse().find((b) => b.style !== 'cancel') ?? buttons[buttons.length - 1];
        if (utama) {
          e.preventDefault();
          handlePress(utama);
        }
      }
    };
    globalThis.addEventListener?.('keydown', tombol as any);
    return () => globalThis.removeEventListener?.('keydown', tombol as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, buttons]);

  return (
    <Modal key={urutanTampil.current} visible={visible} transparent animationType="fade" onRequestClose={hide}>
      <View style={st.overlay}>
        <View style={st.card} accessibilityRole="alert">
          <View style={st.atas}>
            <View style={[st.ikon, { backgroundColor: iconColor + '1A' }]}>
              <Ionicons name={ICON_BY_TYPE[type]} size={22} color={iconColor} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.judul}>{title}</Text>
              {!!message && <Text style={st.pesan}>{message}</Text>}
            </View>
          </View>
          <View style={st.aksi}>
            {buttons.map((btn, i) => {
              const isCancel = btn.style === 'cancel';
              const isDestructive = btn.style === 'destructive';
              return (
                <Pressable
                  key={i}
                  onPress={() => handlePress(btn)}
                  accessibilityRole="button"
                  style={({ hovered }: any) => [
                    st.tombol,
                    isCancel ? st.tombolBatal : { backgroundColor: isDestructive ? colors.danger : iconColor },
                    hovered && (isCancel ? { backgroundColor: '#F2F4F7' } : { opacity: 0.9 }),
                  ]}
                >
                  <Text style={[st.tombolTeks, isCancel && st.tombolTeksBatal]}>{btn.text}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,32,0.42)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 22,
    shadowColor: '#0B1220',
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
  },
  atas: { flexDirection: 'row', gap: 14 },
  ikon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: 16, fontWeight: '700', color: colors.text, lineHeight: 22, marginTop: 2 },
  pesan: { fontSize: 13.5, color: colors.textMuted, marginTop: 6, lineHeight: 20 },
  aksi: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10, marginTop: 22 },
  tombol: { minWidth: 96, height: 38, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tombolBatal: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 13.5 },
  tombolTeksBatal: { color: colors.text, fontWeight: '600' },
});
