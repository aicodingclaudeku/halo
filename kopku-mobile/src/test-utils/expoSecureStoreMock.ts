/**
 * Mock Jest untuk `expo-secure-store`.
 *
 * Alasannya persis sama dengan `expoCryptoMock.ts` yang sudah ada di
 * folder ini: paketnya native module yang di-ship sebagai ESM murni,
 * sehingga ts-jest gagal MEMUATNYA (bukan gagal assertion). Tanpa
 * pemetaan ini, setiap suite yang menyentuh `security/pin.ts` atau
 * modul lisensi mati saat import.
 *
 * Implementasinya sengaja BUKAN sekadar `Map` telanjang:
 *   - `deleteItemAsync` pada key yang tidak ada harus diam saja, sama
 *     seperti perilaku asli;
 *   - `__setFailure()` memungkinkan test menirukan keystore rusak/
 *     terkunci, yang di produksi memang bisa terjadi dan HARUS berujung
 *     fail-closed (lihat `licenseStore.ts`).
 *
 * Pemetaan ini HANYA berlaku di Jest. Bundle produksi (Metro) tetap
 * memakai paket asli.
 */

const store = new Map<string, string>();
let failMode: 'NONE' | 'READ' | 'WRITE' | 'ALL' = 'NONE';

export async function getItemAsync(key: string): Promise<string | null> {
  if (failMode === 'READ' || failMode === 'ALL') {
    throw new Error('SecureStore unavailable');
  }
  return store.has(key) ? (store.get(key) as string) : null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (failMode === 'WRITE' || failMode === 'ALL') {
    throw new Error('SecureStore unavailable');
  }
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (failMode === 'WRITE' || failMode === 'ALL') {
    throw new Error('SecureStore unavailable');
  }
  store.delete(key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

// --- Helper khusus test ----------------------------------------------------

/** Kosongkan seluruh isi (dipanggil di `beforeEach`). */
export function __clear(): void {
  store.clear();
  failMode = 'NONE';
}

/** Intip isi mentah — dipakai test untuk membuktikan token benar-benar tersimpan. */
export function __dump(): Record<string, string> {
  return Object.fromEntries(store.entries());
}

/** Tulis langsung tanpa lewat API, untuk menyiapkan kondisi awal. */
export function __seed(key: string, value: string): void {
  store.set(key, value);
}

export function __setFailure(mode: 'NONE' | 'READ' | 'WRITE' | 'ALL'): void {
  failMode = mode;
}
