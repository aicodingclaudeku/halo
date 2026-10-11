/**
 * Shim desktop `expo-local-authentication`. macOS: Touch ID (bila ada).
 * Windows: Windows Hello tidak tersedia lewat Electron tanpa modul native —
 * dilaporkan "tidak ada perangkat keras", sehingga aplikasi otomatis
 * memakai PIN/password (perilaku yang sama dengan HP tanpa sidik jari).
 */
import { b } from './_bridge';
export const AuthenticationType = { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 };
export const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
export function hasHardwareAsync() { return b().auth.canBiometric(); }
export function isEnrolledAsync() { return b().auth.canBiometric(); }
export async function supportedAuthenticationTypesAsync() { return (await b().auth.canBiometric()) ? [AuthenticationType.FINGERPRINT] : []; }
export async function getEnrolledLevelAsync() { return (await b().auth.canBiometric()) ? SecurityLevel.BIOMETRIC_STRONG : SecurityLevel.NONE; }
export async function authenticateAsync(options = {}) {
  if (!(await b().auth.canBiometric())) return { success: false, error: 'not_available' };
  return (await b().auth.promptBiometric(options.promptMessage || 'Buka KOPKU')) ? { success: true } : { success: false, error: 'user_cancel' };
}
export async function cancelAuthenticate() {}
export default { hasHardwareAsync, isEnrolledAsync, authenticateAsync, supportedAuthenticationTypesAsync, AuthenticationType };
