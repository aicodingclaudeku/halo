import React from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNotifyStore, NotifyType } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';

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

/**
 * Pop-up notifikasi global — pengganti dialog native `Alert.alert` bawaan
 * RN yang tampilannya polos & tidak konsisten dengan desain aplikasi
 * (lihat useNotifyStore.ts). Cukup dirender SEKALI di root layout;
 * dipicu dari mana saja lewat notify(title, message, buttons).
 */
export default function AppNotificationHost() {
  const { visible, type, title, message, buttons, hide } = useNotifyStore();
  const iconColor = COLOR_BY_TYPE[type];

  const handlePress = (btn: (typeof buttons)[number]) => {
    hide();
    btn.onPress?.();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={hide}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={[styles.iconCircle, { backgroundColor: iconColor + '1A' }]}>
            <Ionicons name={ICON_BY_TYPE[type]} size={28} color={iconColor} />
          </View>
          <Text style={styles.title}>{title}</Text>
          {!!message && <Text style={styles.message}>{message}</Text>}

          <View style={styles.buttonRow}>
            {buttons.map((btn, i) => {
              const isCancel = btn.style === 'cancel';
              const isDestructive = btn.style === 'destructive';
              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.button,
                    isCancel && styles.buttonCancel,
                    isDestructive && styles.buttonDestructive,
                    !isCancel && !isDestructive && { backgroundColor: iconColor },
                  ]}
                  onPress={() => handlePress(btn)}
                >
                  <Text
                    style={[
                      styles.buttonText,
                      isCancel && styles.buttonTextCancel,
                    ]}
                  >
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.text, textAlign: 'center' },
  message: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm, lineHeight: 19 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: spacing.xl, width: '100%' },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  buttonCancel: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  buttonDestructive: { backgroundColor: colors.danger },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  buttonTextCancel: { color: colors.textMuted },
});
