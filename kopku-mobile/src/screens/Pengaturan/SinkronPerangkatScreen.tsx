import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { apakahDesktop } from '@/desktop/platformSinkron';
import PanelSinkronDesktop from '@/components/sinkron/PanelSinkronDesktop';
import PanelSinkronHp from '@/components/sinkron/PanelSinkronHp';

/**
 * Pengaturan › Sinkron Desktop (HP) / Sinkron HP (desktop).
 * Satu rute untuk kedua platform; isi panel menyesuaikan peran perangkat:
 * desktop menampilkan QR (server), HP memindai QR (klien).
 */
export default function SinkronPerangkatScreen() {
  return <View style={st.wadah}>{apakahDesktop() ? <PanelSinkronDesktop /> : <PanelSinkronHp />}</View>;
}

const st = StyleSheet.create({ wadah: { flex: 1, backgroundColor: colors.background } });
