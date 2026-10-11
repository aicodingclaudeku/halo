/** Shim desktop `expo-secure-store` — DPAPI (Windows) / Keychain (macOS) lewat safeStorage. */
import { b } from './_bridge';
export const AFTER_FIRST_UNLOCK = 0, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1, ALWAYS = 2, WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3, ALWAYS_THIS_DEVICE_ONLY = 4, WHEN_UNLOCKED = 5, WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
export function getItemAsync(key) { return b().secure.get(key); }
export function setItemAsync(key, value) { return b().secure.set(key, value); }
export function deleteItemAsync(key) { return b().secure.remove(key); }
export async function isAvailableAsync() { return true; }
export function canUseBiometricAuthentication() { return false; }
export default { getItemAsync, setItemAsync, deleteItemAsync, isAvailableAsync };
