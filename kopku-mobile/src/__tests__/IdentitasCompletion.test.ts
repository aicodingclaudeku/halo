import { readFileSync } from 'fs';
import { join } from 'path';


/**
 * PART G — STATUS KELENGKAPAN IDENTITAS KOPERASI.
 *
 * Dua lapis yang diuji di sini, dan keduanya perlu:
 *
 *   1. PERHITUNGANNYA (`hitungIdentityCompletion`) — fungsi murni.
 *      Diuji di `SetupMinimalPinIdentitas.test.ts`, yang sudah
 *      menyiapkan database dan berjalan di bawah Jest sungguhan.
 *      TIDAK diduplikasi di sini: mengimpor SetupService akan menarik
 *      seluruh `database/db.ts` beserta API expo-sqlite-nya.
 *   2. KESEGARANNYA di Dashboard — diuji secara struktural di berkas
 *      ini, karena
 *      bug yang dilaporkan bukan salah hitung melainkan snapshot basi:
 *      `useEffect(..., [])` hanya berjalan sekali, sementara
 *      native-stack tidak pernah meng-unmount layar. Perhitungannya
 *      selalu benar; yang salah adalah KAPAN ia dijalankan.
 */

const ROOT = join(__dirname, '..', '..');

describe('G3-G4. status di Dashboard tidak boleh basi', () => {
  const dashboard = readFileSync(
    join(ROOT, 'src', 'screens', 'Dashboard', 'DashboardScreen.tsx'),
    'utf8'
  );

  it('status identitas dimuat ulang saat layar mendapat fokus', () => {
    // Inti bug: native-stack TIDAK meng-unmount layar, jadi efek
    // sekali-jalan tidak pernah berjalan lagi setelah pengguna kembali
    // dari layar Pengaturan.
    expect(dashboard).toMatch(/useFocusRefresh\(\(\) => \{[\s\S]{0,120}muatStatusIdentitas\(\)/);
  });

  it('tidak ada lagi useEffect sekali-jalan untuk status identitas', () => {
    expect(dashboard).not.toMatch(/useEffect\(\(\) => \{\s*getIdentityCompletionStatus\(\)/);
  });

  it('kegagalan membaca status tidak menampilkan "lengkap"', () => {
    expect(dashboard).toMatch(/catch \{\s*setIdentitas\(null\);/);
  });

  it('tidak memakai timer atau remount paksa sebagai solusi', () => {
    // Potongan dibatasi pada DEFINISI `muatStatusIdentitas` saja.
    //
    // Sebelum RC-S49b, potongannya sampai akhir berkas dan itu kebetulan
    // aman karena Dashboard tidak punya timer sama sekali. RC-S49b
    // menambahkan `setInterval` untuk menggambar countdown lisensi (§D),
    // sehingga potongan sampai akhir berkas akan menandai timer yang
    // TIDAK ada hubungannya dengan status identitas.
    //
    // Sifat yang dijaga tetap sama dan justru lebih tepat sasaran:
    // status identitas dimuat oleh PERISTIWA fokus, bukan oleh waktu.
    const mulai = dashboard.indexOf('const muatStatusIdentitas');
    const fungsi = dashboard.slice(mulai, dashboard.indexOf('}, []);', mulai) + 7);
    expect(fungsi).not.toMatch(/setTimeout|setInterval|forceUpdate|key=\{Math\.random/);
    // Dan timer yang ada di layar ini memang bukan pemuat data.
    expect(dashboard).not.toMatch(/setInterval\([^)]*muatStatusIdentitas/);
  });
});
