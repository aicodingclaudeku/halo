/**
 * Shim desktop `expo-background-task`. OS desktop tidak menjalankan tugas
 * latar milik aplikasi yang ditutup; padanannya: tugas dijalankan berkala
 * (sesuai minimumInterval, minimal 15 menit) SELAMA aplikasi terbuka.
 * Catch-up saat startup tetap berjalan seperti di HP.
 */
import { __ambilTugas } from './expo-task-manager';
export const BackgroundTaskResult = { Success: 1, Failed: 2 };
export const BackgroundTaskStatus = { Restricted: 1, Available: 2 };
export async function getStatusAsync() { return BackgroundTaskStatus.Available; }
export async function registerTaskAsync(name, options = {}) {
  const peta = (globalThis.__kopkuTugasTerdaftar = globalThis.__kopkuTugasTerdaftar || new Map());
  if (peta.has(name)) clearInterval(peta.get(name));
  const menit = Math.max(15, Number(options.minimumInterval) || 15);
  peta.set(name, setInterval(() => { const fn = __ambilTugas(name); if (fn) Promise.resolve(fn({ data: null, error: null })).catch(() => undefined); }, menit * 60 * 1000));
}
export async function unregisterTaskAsync(name) {
  const peta = globalThis.__kopkuTugasTerdaftar;
  if (peta && peta.has(name)) { clearInterval(peta.get(name)); peta.delete(name); }
}
export async function triggerTaskWorkerForTestingAsync() { return false; }
export default { registerTaskAsync, unregisterTaskAsync, getStatusAsync, BackgroundTaskResult, BackgroundTaskStatus };
