/** Stub desktop `expo-camera`: desktop MENAMPILKAN QR, tidak memindai. Tidak pernah dirender di desktop. */
import React from 'react';
import { View, Text } from 'react-native';
export function CameraView() { return React.createElement(View, null, React.createElement(Text, null, 'Kamera tidak digunakan di desktop.')); }
export function useCameraPermissions() { return [{ granted: false, canAskAgain: false, status: 'denied' }, async () => ({ granted: false })]; }
export const Camera = { requestCameraPermissionsAsync: async () => ({ granted: false }) };
export default { CameraView, useCameraPermissions };
