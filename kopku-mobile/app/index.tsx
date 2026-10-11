import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, AppState } from 'react-native';
import IndikatorMemuat from '@/components/IndikatorMemuat';
import { colors } from '@/theme/colors';
import { getDb } from '@/database/db';
import RootNavigator from '@/navigation/RootNavigator';
import SetupWizardScreen from '@/screens/Setup/SetupWizardScreen';
import LoginScreen from '@/screens/Setup/LoginScreen';
import LockScreen from '@/screens/Setup/LockScreen';
import GantiPasswordScreen from '@/screens/Setup/GantiPasswordScreen';
import PortalAnggotaScreen from '@/screens/PortalAnggota/PortalAnggotaScreen';
import { apakahWajibGantiPassword } from '@/services/UserManagementService';
import { isSetupComplete, getActiveKoperasi } from '@/services/SetupService';
import { apakahKeluarManual, getSessionStatus, getUserById, logout, mulaiSesiTanpaPin } from '@/services/AuthService';
import { resolvePinState } from '@/services/SecurityService';
import { getPermissionsForRole } from '@/services/PermissionService';
import { jalankanTugasStartup } from '@/services/StartupTasks';
import { muatJamUjiDariDb } from '@/services/DevClockService';
import { useAppStore } from '@/store/useAppStore';

// RC-S133.5 — GANTI_PASSWORD: akun wajib mengganti password sebelum memakai
// aplikasi (akun anggota massal). PORTAL_ANGGOTA: akun ber-role Anggota
// hanya melihat data dirinya sendiri — navigator koperasi TIDAK di-mount.
type AppPhase = 'LOADING' | 'SETUP' | 'LOGIN' | 'LOCKED' | 'GANTI_PASSWORD' | 'PORTAL_ANGGOTA' | 'READY';

const AUTO_LOCK_MINUTES = 5; // PRD §32; bisa dipindah ke Pengaturan pada phase berikutnya

/**
 * Orkestrasi alur aplikasi (PRD §4 setup wizard, §32 PIN/auto-lock):
 * belum setup -> SetupWizard
 * sudah setup tapi belum login -> Login
 * sudah login tapi sesi terkunci (auto-lock) -> Lock
 * siap -> RootNavigator
 *
 * Sebelumnya berkas ini adalah `App.tsx` di root proyek (entry point lama
 * `node_modules/expo/AppEntry.js`). Sejak migrasi ke Expo Router (SDK 54),
 * satu-satunya route yang didaftarkan adalah `/` (berkas ini) — lihat
 * `app/_layout.tsx` untuk penjelasan lengkap keputusan migrasinya.
 */
export default function Index() {
  const [phase, setPhase] = useState<AppPhase>('LOADING');
  const setKoperasi = useAppStore((s) => s.setKoperasi);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  const setPermissions = useAppStore((s) => s.setPermissions);
  const restoreSignal = useAppStore((s) => s.restoreSignal);
  const currentUser = useAppStore((s) => s.currentUser);
  const startupTaskRequested = useAppStore((s) => s.startupTaskRequested);
  const consumeStartupTaskRequest = useAppStore((s) => s.consumeStartupTaskRequest);

  // HARDENING RC-S74 (final) — `phase` hidup sebagai React state lokal
  // (bukan di `useAppStore`), sehingga listener SINKRON di bawah (yang
  // berjalan di luar siklus render React) butuh cara membaca nilai
  // TERBARUNYA tanpa closure basi. Ref diperbarui setiap render — bukan
  // di dalam efek — supaya nilainya selalu sinkron dengan render yang
  // sedang commit, persis saat listener mungkin terpanggil.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const loadKoperasiIntoStore = useCallback(async () => {
    const k = await getActiveKoperasi();
    if (k) {
      setKoperasi({
        id: k.id,
        nama: k.nama,
        standarAkuntansi: k.standar_akuntansi,
        tahunBukuAktif: k.tahun_buku_aktif,
        logoUri: k.logo_uri ?? undefined,
      });
    }
  }, [setKoperasi]);

  const evaluatePhase = useCallback(async () => {
    const setupDone = await isSetupComplete();
    if (!setupDone) {
      setPhase('SETUP');
      return;
    }
    await loadKoperasiIntoStore();

    // Mode Pengujian Waktu (menu Developer) — muat SEKALI di sini
    // supaya `getTanggalLokalHariIni()` (dipakai 80+ berkas akuntansi)
    // sudah memakai jam simulasi tersimpan SEBELUM fase READY, bukan
    // menunggu layar Developer dibuka. Gagal baca -> gagal aman ke
    // waktu asli (lihat DevClockService.ts), TIDAK menggagalkan startup.
    await muatJamUjiDariDb(await getDb());

    // ============================================================
    // §17 — STATE MACHINE PIN TERPUSAT.
    //
    // Fase autentikasi ditentukan dari SATU sumber (`resolvePinState`),
    // bukan dari boolean `isPinEnabled` yang disebar ke banyak layar.
    // Empat state: PIN_DISABLED / PIN_ENABLED_SETUP_REQUIRED /
    // PIN_ENABLED / PIN_LOCKED.
    // ============================================================
    const { userId, locked } = await getSessionStatus(AUTO_LOCK_MINUTES);
    const pinState = await resolvePinState({ sesiTerkunci: locked });

    let userIdAktif = userId;

    if (pinState === 'PIN_DISABLED') {
      // §16: "app tidak meminta PIN saat masuk, tidak ada forced PIN
      // setup, tidak ada PIN lock loop." Sesi dibuka langsung dengan
      // user admin yang sudah ada — TIDAK PERNAH melewati LOGIN/LOCKED.
      if (!userIdAktif) {
        // RC-S132 — pengguna menekan Keluar: tampilkan layar LOGIN supaya
        // akun lain (User Management) dapat masuk, alih-alih langsung
        // membuka sesi Admin otomatis lagi.
        if (await apakahKeluarManual()) {
          setPhase('LOGIN');
          return;
        }
        const user = await mulaiSesiTanpaPin();
        if (!user) {
          // Tidak ada user aktif sama sekali — kondisi tidak wajar untuk
          // database yang setup-nya selesai. Jatuhkan ke LOGIN daripada
          // masuk tanpa identitas (audit trail butuh created_by valid).
          setPhase('LOGIN');
          return;
        }
        userIdAktif = user.id;
      }
    } else {
      // PIN aktif -> perilaku LAMA dipertahankan persis seperti semula.
      if (!userIdAktif) {
        setPhase('LOGIN');
        return;
      }
      if (pinState === 'PIN_LOCKED') {
        setPhase('LOCKED');
        return;
      }
      // PIN_ENABLED_SETUP_REQUIRED ditangani di Pengaturan > Keamanan
      // (user WAJIB membuat PIN di sana sebelum lock benar-benar aktif);
      // aplikasi tidak mengunci dirinya sendiri dengan PIN yang belum
      // pernah ditetapkan — itu akan menjadi lock loop yang dilarang §16.
    }

    const user = await getUserById(userIdAktif as string);
    if (user) {
      setCurrentUser({ id: user.id, nama: user.nama, role: user.role, anggotaId: user.anggotaId });
      // RC-S133.5 — password sementara (dibuat Admin) wajib diganti dulu.
      if (await apakahWajibGantiPassword(user.id)) {
        setPhase('GANTI_PASSWORD');
        return;
      }
      // RC-S133.5 — akun Anggota: portal "Data Saya" (hanya data anggota yang
      // ditautkan). Tugas otomatis akuntansi tidak dijalankan atas namanya.
      if (user.role === 'ANGGOTA') {
        setPermissions(await getPermissionsForRole(user.role));
        setPhase('PORTAL_ANGGOTA');
        return;
      }
      // Muat cache permission untuk role user ini (fase 8 §5) — dipakai
      // hook usePermission untuk proteksi halaman/tombol di UI.
      const permissions = await getPermissionsForRole(user.role);
      setPermissions(permissions);
      // PHASE 5 §B + BUG P0-8 (perilaku lama dipertahankan): trigger
      // penyusutan/amortisasi otomatis & akrual jasa pinjaman. Dipanggil
      // HANYA di sini (transisi ke phase READY: login/unlock/kembali dari
      // background/restore), TIDAK di render/effect lain.
      //
      // BUG FIRST-OPEN POSISI KEUANGAN (root cause): sebelumnya KEDUA
      // pekerjaan ini dipanggil sebagai dua fire-and-forget TERPISAH,
      // sehingga (1) berjalan BERSAMAAN pada satu koneksi SQLite dan
      // (2) laporan yang dibuka sesaat kemudian membaca ledger yang
      // jurnalnya baru tertulis sebagian. Sekarang keduanya dijalankan
      // BERURUTAN lewat satu koordinator yang juga bisa DITUNGGU oleh
      // layar laporan — lihat penjelasan lengkap di StartupTasks.ts.
      // TETAP tidak di-`await` di sini: login/pemakaian aplikasi tidak
      // boleh tertunda oleh proses latar ini.
      jalankanTugasStartup(user.id).catch(() => {});
    }
    setPhase('READY');
  }, [loadKoperasiIntoStore, setCurrentUser, setPermissions]);

  useEffect(() => {
    (async () => {
      await getDb(); // membuat/migrasi skema jika perlu
      await evaluatePhase();
    })();
  }, [evaluatePhase]);

  // Auto-lock saat app kembali dari background (PRD §32).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && (phase === 'READY' || phase === 'PORTAL_ANGGOTA')) {
        evaluatePhase();
      }
    });
    return () => sub.remove();
  }, [phase, evaluatePhase]);

  // Muat ulang seluruh state aplikasi dengan aman setelah restore
  // database (fase 5 §10) — BackupService memanggil triggerRestoreReload()
  // setelah database diganti & sesi lama di-logout paksa.
  useEffect(() => {
    if (restoreSignal > 0) {
      evaluatePhase();
    }
  }, [restoreSignal, evaluatePhase]);

  // HOTFIX RC-S74 (final) — GLOBAL APPLICATION COORDINATOR untuk startup
  // task one-shot request (§2/§3 tiket "GLOBAL STARTUP TASK COORDINATOR").
  //
  // ROOT CAUSE yang diperbaiki: `requestStartupTask()` sebelumnya HANYA
  // dikonsumsi oleh `DashboardScreen` saat fokus. Kalau pengguna menyimpan
  // Utang Koperasi lalu langsung ke Bayar Kewajiban TANPA membuka
  // Dashboard, tidak ada yang pernah mengonsumsi request itu — gate
  // `tungguTugasStartupSelesai()` di layar Bayar Kewajiban resolve
  // SEKETIKA (tidak ada task berjalan), dan read-model lama (Rp0 +
  // PERLU_PERHATIAN) terbaca seolah final.
  //
  // Perbaikannya BUKAN Dashboard yang mengonsumsi, tetapi komponen ini —
  // `app/index.tsx` — karena inilah lifecycle root yang tetap mounted
  // (dan hook-nya tetap aktif) selama `phase === 'READY'`, terlepas layar
  // mana yang sedang difokuskan pengguna. `RootNavigator` di bawahnya
  // hanya menentukan tampilan; komponen INI yang terus hidup.

  // ============================================================
  // HARDENING RC-S74 (final) — TUTUP RACE WINDOW (§1–§8 tiket ini).
  // ============================================================
  //
  // MASALAH pada implementasi effect-murni sebelumnya: `requestStartupTask()`
  // mengubah state Zustand SEKETIKA (`listeners.forEach(...)` di dalam
  // `setState` — lihat `node_modules/zustand/vanilla.js` — dijalankan
  // SINKRON, dalam call stack yang sama), tetapi React binding
  // (`useAppStore((s) => s.xxx)`) hanya menjadwalkan RE-RENDER dari
  // notifikasi sinkron itu; `useEffect` React sendiri baru berjalan
  // SETELAH commit, secara asinkron. Ada jendela waktu nyata di antara
  // "state berubah" dan "efek coordinator sungguhan berjalan" — kalau
  // pengguna sempat membuka Bayar Kewajiban tepat di jendela itu,
  // `getStatusTugasStartup().berjalan` masih `false`, gate
  // `tungguTugasStartupSelesai()` lolos seketika, dan read-model lama
  // terbaca.
  //
  // PERBAIKAN: langganan MENTAH ke store Zustand (`useAppStore.subscribe`,
  // BUKAN lewat hook React) — dijalankan SINKRON oleh Zustand sebagai
  // bagian dari `setState`, dalam call stack YANG SAMA dengan
  // `requestStartupTask()`. `jalankanTugasStartup()` sendiri juga
  // menetapkan gate internalnya (`tugasBerjalan`) secara SINKRON sebelum
  // `await` pertamanya (lihat `StartupTasks.ts`) — jadi begitu
  // `requestStartupTask()` selesai dipanggil di layar mana pun,
  // `getStatusTugasStartup().berjalan` SUDAH `true`, tanpa menunggu
  // render/effect React apa pun. Race window tertutup total untuk jalur
  // "request datang saat phase sudah READY".
  //
  // Didaftarkan SEKALI (`useEffect(..., [])`) — bukan setiap render —
  // supaya tidak ada langganan ganda; unsubscribe saat unmount (yang
  // dalam praktiknya tidak pernah terjadi selama aplikasi hidup, karena
  // `Index` adalah root).
  //
  // RISING-EDGE (§5): listener hanya bertindak saat bendera berubah dari
  // `false` -> `true`, bukan pada SETIAP notifikasi store (listener
  // Zustand tanpa selector terpanggil untuk perubahan field APA PUN, mis.
  // `licenseRecheckSignal`). Ini juga mencegah listener bereaksi pada
  // `set({ startupTaskRequested: false })` yang dilakukan
  // `consumeStartupTaskRequest()` sendiri.
  //
  // STALE CLOSURE (§7): `currentUser` dibaca via `useAppStore.getState()`
  // di dalam listener (selalu terbaru, bukan dari closure React), dan
  // `phase` dibaca via `phaseRef.current` (diperbarui setiap render, lihat
  // di atas) — bukan dari parameter `phase` komponen yang bisa basi kalau
  // listener ini dari closure lama.
  //
  // FALLBACK READY (§8, §4): kalau request datang SEBELUM `phase===READY`
  // (mis. race saat startup aplikasi itu sendiri, meski secara praktik
  // hampir mustahil karena layar transaksi baru bisa dijangkau setelah
  // READY), listener ini SENGAJA tidak mengonsumsi — bendera tetap `true`,
  // TIDAK HILANG. Efek terpisah di bawah (`[phase, startupTaskRequested,
  // currentUser, consumeStartupTaskRequest]`) menutup kasus itu: begitu
  // `phase` menjadi `READY`, React menjalankan ulang efek itu secara
  // normal (transisi fase hanya terjadi lewat `setPhase` di
  // `evaluatePhase`, jauh sebelum pengguna sempat berinteraksi dengan
  // layar apa pun — tidak ada race praktis pada jalur ini).
  //
  // SATU BATCH (§6, §17, §19): `consumeStartupTaskRequest()` atomic
  // (baca+matikan bendera dalam satu operasi store) — siapa pun yang
  // memanggilnya lebih dulu (listener sinkron INI, atau efek fallback di
  // bawah) "menang"; yang lain menerima `false` dan tidak berbuat apa-apa.
  // Request berulang sebelum batch pertama selesai tetap satu bendera
  // boolean (idempoten di level store), sehingga tetap satu batch.
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prevState) => {
      if (!state.startupTaskRequested || prevState.startupTaskRequested) return; // rising edge saja
      if (phaseRef.current !== 'READY' || !state.currentUser) return; // fallback READY di bawah yang menangani
      if (!useAppStore.getState().consumeStartupTaskRequest()) return; // sudah dikonsumsi (mis. oleh fallback) -> tidak dobel
      jalankanTugasStartup(state.currentUser.id).catch(() => {});
    });
    return unsub;
  }, []);

  // Fallback READY (§4/§8 di atas): kasus "request datang sebelum phase
  // jadi READY" — listener sinkron sengaja tidak bertindak untuk kasus
  // ini, jadi efek berdependensi normal inilah yang mengonsumsinya begitu
  // `phase` berubah menjadi `READY`.
  //
  // `consumeStartupTaskRequest()` membaca DAN mematikan bendera dalam
  // satu langkah (atomic terhadap store), sehingga request yang sama
  // tidak pernah dikonsumsi dua kali walau efek ini berjalan ulang untuk
  // alasan lain (mis. `currentUser` berubah referensi) ATAU walau
  // listener sinkron di atas sudah lebih dulu mengonsumsinya.
  //
  // `jalankanTugasStartup()` adalah koordinator existing yang SAMA
  // dipakai transisi ke READY di atas (login/unlock/restore) — TIDAK ada
  // engine baru. Sengaja TIDAK di-`await`: pengguna tidak boleh menunggu
  // akrual selesai untuk bisa memakai aplikasi. Layar yang butuh
  // hasilnya (`BayarUtangFormScreen`) menunggu lewat
  // `tungguTugasStartupSelesai()` miliknya sendiri.
  useEffect(() => {
    if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;
    if (!consumeStartupTaskRequest()) return;
    jalankanTugasStartup(currentUser.id).catch(() => {});
  }, [phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]);

  // RC-S133.5 — keluar dari layar Ganti Password / Portal Anggota.
  const keluarAkun = async () => {
    await logout();
    setPermissions(null);
    setCurrentUser(null);
    evaluatePhase();
  };

  if (phase === 'LOADING') {
    return (
      // RC-S123 — indikator bermerek + latar eksplisit. Sebelumnya wadah ini
      // tanpa warna latar, sehingga di APK pada ponsel bermode gelap yang
      // terlihat adalah latar jendela gelap (layar "hitam" sesudah splash).
      <View style={styles.center}>
        <IndikatorMemuat />
      </View>
    );
  }

  if (phase === 'SETUP') {
    return <SetupWizardScreen onComplete={() => evaluatePhase()} />;
  }

  if (phase === 'LOGIN') {
    return <LoginScreen onSuccess={() => evaluatePhase()} />;
  }

  if (phase === 'LOCKED') {
    return <LockScreen onUnlock={() => evaluatePhase()} onLoggedOut={() => evaluatePhase()} />;
  }

  if (phase === 'GANTI_PASSWORD' && currentUser) {
    return <GantiPasswordScreen userId={currentUser.id} wajib onSelesai={() => evaluatePhase()} onKeluar={keluarAkun} />;
  }

  if (phase === 'PORTAL_ANGGOTA' && currentUser) {
    return <PortalAnggotaScreen onKeluar={keluarAkun} />;
  }

  return <RootNavigator />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
