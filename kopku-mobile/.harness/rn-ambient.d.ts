/**
 * DEKLARASI MINIMAL REACT + REACT NATIVE UNTUK TYPECHECK `.tsx`.
 *
 * `@types/react` dan `@types/react-native` tidak dapat dipasang di
 * lingkungan ini (registry npm 403), sehingga berkas `.tsx` selama ini
 * BERADA DI LUAR jangkauan compiler. Gap itu sudah dua kali menghasilkan
 * bug yang lolos sampai review:
 *
 *   RC-S41  : `const navigation` dideklarasikan dua kali;
 *   RC-S46  : blok helper + StyleSheet terpotong habis oleh patch.
 *
 * Keduanya adalah kesalahan yang compiler tangkap dalam sekejap.
 *
 * BATAS YANG HARUS DIAKUI: deklarasi di bawah JAUH lebih longgar
 * daripada tipe aslinya. Ia membuktikan berkas dapat di-parse, seluruh
 * identifier yang dipakai benar-benar ada, dan tidak ada deklarasi
 * ganda. Ia TIDAK memvalidasi props komponen maupun bentuk style.
 * `npm run typecheck` yang sesungguhnya tetap wajib.
 */

declare module 'react' {
  export type ReactNode = unknown;
  export function useState<T>(awal: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useCallback<T>(fn: T, deps?: unknown[]): T;
  export function useMemo<T>(fn: () => T, deps?: unknown[]): T;
  export function useLayoutEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useRef<T>(awal: T): { current: T };
  const React: {
    useState: typeof useState;
    useEffect: typeof useEffect;
    useCallback: typeof useCallback;
    useMemo: typeof useMemo;
    // RC-S133.4.7 — keduanya ada di paket aslinya; yang kurang hanya deklarasi shim.
    useLayoutEffect: typeof useLayoutEffect;
    Fragment: (props: Record<string, unknown>) => JSX.Element;
  };
  export default React;
}

/** `React.ReactNode` dipakai sebagai namespace di beberapa komponen. */
declare namespace React {
  type ReactNode = unknown;
  type FC<P = unknown> = (props: P) => JSX.Element;
}

declare namespace JSX {
  interface Element { readonly __jsx: unique symbol }
  interface IntrinsicElements { [nama: string]: unknown }
  interface ElementAttributesProperty { props: unknown }
  interface ElementChildrenAttribute { children: unknown }
  /**
   * `key` adalah prop khusus React yang TIDAK diteruskan ke komponen,
   * sehingga tidak muncul di tipe props buatan sendiri. Tanpa ini,
   * setiap `<Chip key=... />` dilaporkan sebagai error padahal benar.
   */
  interface IntrinsicAttributes { key?: string | number }
  interface IntrinsicClassAttributes<T> { key?: string | number }
}

declare module 'react' {
  interface Attributes { key?: string | number }
}

declare module 'react/jsx-runtime' {
  export function jsx(...a: unknown[]): JSX.Element;
  export function jsxs(...a: unknown[]): JSX.Element;
  export const Fragment: unknown;
}

declare module 'react-native' {
  type Komponen = (props: Record<string, unknown>) => JSX.Element;
  export const View: Komponen;
  export const Text: Komponen;
  export const TextInput: Komponen;
  export const Switch: Komponen;
  export const ScrollView: Komponen;
  export const TouchableOpacity: Komponen;
  export const ActivityIndicator: Komponen;
  export const RefreshControl: Komponen;
  export const Modal: Komponen;
  export const FlatList: Komponen;
  export const SectionList: Komponen;
  // Fase 7 — dipakai modal form master data. Ketiganya memang ada di
  // paket aslinya; yang kurang adalah deklarasi di shim ini, sehingga
  // ketiadaannya memunculkan TS2305 palsu pada kode yang benar.
  export const KeyboardAvoidingView: Komponen;
  // RC-S133.4.7 — panduan slide import. Sengaja longgar seperti deklarasi lain.
  export const Animated: any;
  export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number };
  export const Platform: { OS: string; select<T>(spec: Record<string, T>): T };
  export const Alert: { alert(...a: unknown[]): void };
  export const AppState: { addEventListener(t: string, cb: (s: string) => void): { remove(): void } };
  export const StyleSheet: { create<T extends Record<string, unknown>>(s: T): T };
  // UI/UX FINAL POLISH — tipe yang dipakai komponen input bersama
  // (`components/AppTextInput.tsx`). Sama seperti catatan "Fase 7" di
  // atas: ketiganya MEMANG ada di paket aslinya, yang kurang hanya
  // deklarasinya di shim ini, sehingga ketiadaannya memunculkan TS2305
  // palsu pada kode yang sudah lolos `tsconfig.json` sungguhan.
  // Sengaja longgar — shim ini tidak pernah memvalidasi bentuk props.
  export type StyleProp<T> = T | readonly T[] | false | null | undefined;
  export type ViewStyle = Record<string, unknown>;
  export type TextStyle = Record<string, unknown>;
  export type TextInputProps = Record<string, unknown> & {
    onFocus?: (e?: unknown) => void;
    onBlur?: (e?: unknown) => void;
  };
}

declare module 'react-native-safe-area-context' {
  export const SafeAreaView: (props: Record<string, unknown>) => JSX.Element;
  export const SafeAreaProvider: (props: Record<string, unknown>) => JSX.Element;
  export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number };
}

declare module '@react-navigation/native' {
  export function useNavigation<T = unknown>(): T;
  export function useIsFocused(): boolean;
  export function useFocusEffect(fn: unknown): void;
  // Fase 7 — parameter rute dibaca layar personel (jenis personel).
  export function useRoute<T = unknown>(): T;
}

declare module '@expo/vector-icons' {
  export const Ionicons: ((props: Record<string, unknown>) => JSX.Element) & {
    glyphMap: Record<string, number>;
  };
}

/** RC-S133.4.7 — timer global (ada di Hermes & browser; shim ini tanpa lib DOM). */
declare function setInterval(fn: () => void, ms?: number): number;
declare function clearInterval(id?: number): void;
declare function setTimeout(fn: () => void, ms?: number): number;
declare function clearTimeout(id?: number): void;
