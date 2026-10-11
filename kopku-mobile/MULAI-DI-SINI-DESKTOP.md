# KOPKU Desktop 1.0.10 — Source Code & Cara Membuat Setup.exe

Aplikasi desktop memakai KODE YANG SAMA dengan aplikasi Android:
- `src/`, `app/` — seluruh layar, service, aturan bisnis (dipakai HP & desktop)
- `desktop/` — bagian khusus desktop: Electron (jendela, SQLite, berkas, cetak/PDF,
  firewall, server sinkron LAN), shim modul Expo, installer, uji
- `src/sync/`, `src/desktop/`, `src/components/sinkron/` — sinkron HP ⇄ desktop

Karena itu folder `desktop/` tidak dapat dibangun sendirian; ekstrak seluruh ZIP ini.

## Membuat Setup.exe di Windows (± 10 menit, sekali saja)
1. Pasang **Node.js 22 LTS** dari https://nodejs.org (centang "Add to PATH").
2. Ekstrak ZIP ini, mis. ke `C:\KOPKU-src`.
3. Buka **PowerShell** di folder itu, lalu jalankan:
   ```
   npm install
   cd desktop
   npm install
   npm run dist:win
   ```
4. Hasil di `desktop\dist\`:
   - `KOPKU-Desktop-1.0.10-Setup.exe` — installer lengkap (±118 MB), memasang izin
     Windows Firewall untuk sinkron HP (setujui dialog Administrator saat instalasi)
   - `KOPKU-Desktop-1.0.10-Windows-x64.zip` — versi portable
5. Uji tanpa memaketkan: `cd desktop` lalu `npm run dev`.

## macOS
`cd desktop && npm install && npm run dist:mac` (di Mac) → ZIP arm64 & x64.

## Dokumen lain
`desktop/README.md` (pasang, lokasi data, pemecahan masalah) ·
`docs/DESKTOP_ARSITEKTUR.md` · `docs/SINKRONISASI.md` ·
`RC-S133_DESKTOP_SINKRON_HP.md` · `RC-S133.1_HOTFIX_FIREWALL_SINKRON.md` · `RC-S133.4.3_SHU_BASIS_KAS_SALDO_AWAL.md` · `RC-S133.4.4_IMPORT_DATA_AWAL_JASA_DIBAYAR.md` · `RC-S133.4.5_IMPORT_SETARA_TRANSAKSI_LANGSUNG.md` · `RC-S133.4.6_IMPORT_SALDO_LAMA_SETARA_TEMPLATE_BARU.md` · `RC-S133.4.7_UI_UX_IMPORT_PANDUAN_SLIDE.md`
