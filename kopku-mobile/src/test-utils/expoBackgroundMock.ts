/**
 * Stub lingkungan test untuk `expo-task-manager` / `expo-background-task`.
 * Modul native ini tidak tersedia di Node. Perilaku registrasi task diuji
 * lewat mock eksplisit di SimpananBerjangkaScheduler.test.ts; stub ini
 * hanya membuat modul yang mengimpornya dapat dimuat.
 */
export const BackgroundTaskResult = { Success: 1, Failed: 2 };
export function isTaskDefined(): boolean { return false; }
export function defineTask(): void { /* no-op */ }
export async function isTaskRegisteredAsync(): Promise<boolean> { return false; }
export async function registerTaskAsync(): Promise<void> { /* no-op */ }
export async function unregisterTaskAsync(): Promise<void> { /* no-op */ }
