import { create } from 'zustand';
import { maskerIzinBacaSaja } from '@/sync/SyncModeBacaSaja';
import { StandarAkuntansi } from '@/config/defaultCOA';
import { Role, Resource, PermissionSet } from '@/config/defaultPermissions';

interface KoperasiInfo {
  id: string;
  nama: string;
  standarAkuntansi: StandarAkuntansi;
  tahunBukuAktif: number;
  logoUri?: string;
}

interface CurrentUser {
  id: string;
  nama: string;
  role: Role;
  /** RC-S133.5 — anggota yang ditautkan (hanya akun ber-role ANGGOTA). */
  anggotaId?: string | null;
}

interface AppState {
  koperasi: KoperasiInfo | null;
  currentUser: CurrentUser | null;
  isLocked: boolean;
  restoreSignal: number;
  /** Dinaikkan SetupWizard setelah setup awal benar-benar selesai
   *  (lisensi sudah aktif + database tertulis). LicenseGate memantaunya
   *  untuk keluar dari fase FIRST_RUN dan kembali menegakkan lisensi
   *  secara penuh — lihat penjelasan di LicenseGate.tsx. */
  licenseRecheckSignal: number;
  /** Cache matrix permission untuk role user yang sedang login — dimuat
   * sekali setelah login/unlock (App.tsx), dipakai hook usePermission
   * untuk proteksi UI (fase 8 §5). Enforcement SEBENARNYA tetap di
   * service lewat requirePermission(), cache ini murni untuk UX. */
  permissions: Record<Resource, PermissionSet> | null;
  /**
   * RC-S74 FINAL FIX DELAY AKRUAL — ONE-SHOT STARTUP TASK REQUEST (§3/§4).
   *
   * Bendera UI murni, BUKAN state accounting. `StartupTasks` (koordinator
   * existing) tetap satu-satunya yang menjalankan akrual; store ini hanya
   * membawa PESAN "tolong jalankan koordinator itu lagi" dari layar
   * transaksi (mis. `UtangFormScreen` setelah `terimaUtang()`) ke
   * `DashboardScreen`, karena `navigation.goBack()` mengembalikan ke layar
   * SEBELUMNYA (mis. Penerimaan), bukan ke Dashboard — dan
   * `tungguTugasStartupSelesai()` hanya menunggu task yang SUDAH berjalan,
   * tidak memulai batch baru.
   *
   * Dashboard mengonsumsinya HANYA saat benar-benar ada request tertunda
   * (lewat `consumeStartupTaskRequest()`, yang membaca lalu mematikan
   * bendera dalam satu langkah) — bukan pada setiap fokus biasa.
   */
  startupTaskRequested: boolean;
  setKoperasi: (k: KoperasiInfo) => void;
  setCurrentUser: (u: CurrentUser | null) => void;
  setPermissions: (p: Record<Resource, PermissionSet> | null) => void;
  /** Izin role sebelum disaring mode cadangan HP. */
  izinAsli: Record<Resource, PermissionSet> | null;
  /** Terapkan ulang saringan mode cadangan (setelah pemasangan berubah). */
  segarkanMaskerIzin: () => void;
  setLocked: (locked: boolean) => void;
  triggerRestoreReload: () => void;
  triggerLicenseRecheck: () => void;
  /** Ditandai layar transaksi setelah commit berhasil (§4). Idempoten:
   *  menandai berkali-kali sebelum sempat dikonsumsi tetap satu request. */
  requestStartupTask: () => void;
  /** Dipanggil Dashboard saat fokus. Mengembalikan `true` HANYA bila memang
   *  ada request tertunda, dan mematikan bendera dalam operasi yang sama
   *  supaya request yang sama tidak pernah dikonsumsi dua kali. */
  consumeStartupTaskRequest: () => boolean;
  reset: () => void;
}

/**
 * Store UI-level saja (siapa yang login, koperasi mana yang aktif).
 * SEMUA data transaksional TETAP di SQLite lewat repositories/services —
 * store ini bukan sumber kebenaran data, hanya cache tampilan.
 */
export const useAppStore = create<AppState>((set, get) => ({
  koperasi: null,
  currentUser: null,
  isLocked: true,
  restoreSignal: 0,
  licenseRecheckSignal: 0,
  permissions: null,
  izinAsli: null,
  startupTaskRequested: false,
  setKoperasi: (koperasi) => set({ koperasi }),
  setCurrentUser: (currentUser) => set({ currentUser }),
  // Sinkron HP⇄Desktop: HP dalam mode cadangan hanya boleh Lihat/Export
  // (lihat src/sync/SyncModeBacaSaja.ts). Tanpa pemasangan → izin apa adanya.
  setPermissions: (permissions) => set({ permissions: maskerIzinBacaSaja(permissions), izinAsli: permissions }),
  segarkanMaskerIzin: () => set((s) => ({ permissions: maskerIzinBacaSaja(s.izinAsli) })),
  setLocked: (isLocked) => set({ isLocked }),
  // Dipanggil BackupService setelah restore selesai (fase 5 §10) — App.tsx
  // memantau nilai ini untuk memuat ulang seluruh state aplikasi dengan aman.
  triggerRestoreReload: () => set((s) => ({ restoreSignal: s.restoreSignal + 1 })),
  // Memaksa LicenseGate mengevaluasi ulang. TIDAK dapat dipakai untuk
  // MEMBUKA apa pun: gate selalu menghitung ulang keputusannya dari
  // LicenseService, jadi sinyal ini hanya bisa memperketat.
  triggerLicenseRecheck: () => set((s) => ({ licenseRecheckSignal: s.licenseRecheckSignal + 1 })),
  requestStartupTask: () => set({ startupTaskRequested: true }),
  consumeStartupTaskRequest: () => {
    const ada = get().startupTaskRequested;
    if (ada) set({ startupTaskRequested: false });
    return ada;
  },
  reset: () => set({ koperasi: null, currentUser: null, isLocked: true, permissions: null, izinAsli: null, startupTaskRequested: false }),
}));
