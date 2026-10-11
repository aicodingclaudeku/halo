import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { colors } from '@/theme/colors';
import LicenseActivationScreen from '@/screens/License/LicenseActivationScreen';
import LicenseInfoScreen from '@/screens/License/LicenseInfoScreen';
import { getLicenseStatus, type LicenseStatus } from '@/services/LicenseService';

/**
 * Rute `/license` (§11, §14).
 *
 * PENTING — rute ini BUKAN penegak kebijakan.
 * Penegaknya adalah `LicenseGate` di `app/_layout.tsx`, yang membungkus
 * `<Slot />` sehingga berada DI DEPAN rute ini juga. Selama lisensi
 * belum sah, membuka `/license` maupun `/` sama-sama berujung pada
 * layar aktivasi yang dirender gate — rute ini bahkan tidak sempat
 * di-mount. Deep link `kopku://license` tidak melewati apa pun.
 *
 * Jadi rute ini praktis hanya tercapai dalam SATU keadaan: lisensi
 * sudah sah dan pengguna membukanya dari Pengaturan > Lisensi. Karena
 * itu isinya panel status + deaktivasi, bukan form aktivasi. Form
 * aktivasi tetap dirender bila entah bagaimana rute ini tercapai dalam
 * keadaan tidak sah — bertahan terhadap keadaan yang "seharusnya tidak
 * mungkin" lebih murah daripada mengasumsikannya.
 */
export default function LicenseRoute() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getLicenseStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (status.allowAppAccess) {
    return (
      <LicenseInfoScreen status={status} onChanged={() => void refresh()} onBack={() => router.back()} />
    );
  }

  return <LicenseActivationScreen status={status} onLicensed={() => void refresh()} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
