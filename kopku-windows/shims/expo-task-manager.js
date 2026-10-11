/** Shim desktop `expo-task-manager` — tugas latar berjalan selama aplikasi desktop terbuka. */
const tugas = new Map();
export function defineTask(name, fn) { tugas.set(name, fn); }
export function isTaskDefined(name) { return tugas.has(name); }
export async function isTaskRegisteredAsync(name) { return !!(globalThis.__kopkuTugasTerdaftar && globalThis.__kopkuTugasTerdaftar.has(name)); }
export async function getRegisteredTasksAsync() { return [...(globalThis.__kopkuTugasTerdaftar || new Map()).keys()].map((taskName) => ({ taskName })); }
export async function unregisterAllTasksAsync() { for (const t of (globalThis.__kopkuTugasTerdaftar || new Map()).values()) clearInterval(t); globalThis.__kopkuTugasTerdaftar = new Map(); }
export function __ambilTugas(name) { return tugas.get(name); }
export default { defineTask, isTaskDefined, isTaskRegisteredAsync };
