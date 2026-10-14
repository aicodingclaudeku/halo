; =====================================================================
; KOPKU Desktop — Installer Windows (NSIS 3, Unicode)
; Dibangun oleh desktop/scripts/build-installer-win.sh dari dist/win-unpacked.
; - Instal per pengguna (tanpa hak Administrator), folder bisa diubah.
; - Pintasan Menu Start & Desktop, entri "Aplikasi & fitur" + uninstaller.
; - Data koperasi (%APPDATA%\KOPKU Desktop) TIDAK dihapus saat uninstall.
; =====================================================================
Unicode true
SetCompressor /SOLID zlib
; zlib: cepat dibangun SetCompressorDictSize 64 andal (lzma > 5 menit untuk ±400 MB)
RequestExecutionLevel user
ManifestDPIAware true

!define APP_NAME "KOPKU Desktop"
!define APP_EXE "KOPKU Desktop.exe"
!define APP_VERSION "1.0.32"
!define PUBLISHER "KOPKU"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\KOPKUDesktop"
!ifndef SRC
  !define SRC "..\dist\win-unpacked"
!endif
!ifndef OUT
  !define OUT "..\dist\KOPKU-Desktop-${APP_VERSION}-Setup.exe"
!endif

Name "${APP_NAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "KOPKU — Keuangan Koperasi Simpan Pinjam"
VIProductVersion "1.0.32.0"
VIAddVersionKey /LANG=1057 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1057 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1057 "FileDescription" "Pemasang ${APP_NAME}"
VIAddVersionKey /LANG=1057 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1057 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1057 "LegalCopyright" "© KOPKU"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Selamat datang di Pemasang ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "Pemasang ini akan memasang ${APP_NAME} ${APP_VERSION} di komputer Anda.$\r$\n$\r$\nKOPKU Desktop berjalan sepenuhnya offline dan menyimpan data secara lokal. Data dapat disinkronkan dengan aplikasi KOPKU di HP melalui Wi-Fi lokal atau hotspot (pemasangan lewat QR).$\r$\n$\r$\nTutup KOPKU Desktop bila sedang terbuka, lalu klik Berikutnya."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Jalankan ${APP_NAME} sekarang"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} telah terpasang.$\r$\n$\r$\nIzin Windows Firewall untuk sinkron HP sudah dipasang (bila Anda menyetujui dialog Administrator). Bila belum, buka KOPKU Desktop › Sinkron HP › Izinkan di Firewall."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Indonesian"

Section "Pasang"
  InitPluginsDir
  ; Tutup instans yang sedang berjalan agar berkas dapat diganti (pembaruan).
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  ; Bersihkan versi lama (kecuali data — data ada di %APPDATA%, bukan di sini).
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall ${APP_NAME}.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ; --- Izin Windows Firewall untuk sinkron HP (Wi-Fi lokal) -----------------
  ; Tanpa ini HP mendapat "Tidak dapat menghubungi desktop … Aborted" bila
  ; dialog firewall pertama kali ditutup (Windows lalu MEMBLOKIR aplikasi).
  ; Aturan lama milik program ini (termasuk blokir) dihapus, lalu port
  ; 47821-47840 diizinkan HANYA dari subnet lokal. Butuh persetujuan UAC;
  ; bila ditolak, dapat diulang dari aplikasi: Sinkron HP › Izinkan di Firewall.
  FileOpen $9 "$PLUGINSDIR\kopku-firewall.cmd" w
  FileWrite $9 "@echo off$\r$\n"
  FileWrite $9 'netsh advfirewall firewall delete rule name=all dir=in program="$INSTDIR\${APP_EXE}" >nul 2>&1$\r$\n'
  FileWrite $9 'netsh advfirewall firewall delete rule name="KOPKU Desktop Sinkron" >nul 2>&1$\r$\n'
  FileWrite $9 'netsh advfirewall firewall add rule name="KOPKU Desktop Sinkron" dir=in action=allow protocol=TCP localport=47821-47840 remoteip=localsubnet profile=any >nul$\r$\n'
  FileWrite $9 'netsh advfirewall firewall add rule name="KOPKU Desktop Sinkron" dir=in action=allow program="$INSTDIR\${APP_EXE}" protocol=TCP remoteip=localsubnet profile=any >nul$\r$\n'
  FileClose $9
  DetailPrint "Mengizinkan sinkron HP di Windows Firewall (perlu persetujuan Administrator)…"
  ExecShellWait "runas" "$PLUGINSDIR\kopku-firewall.cmd" "" SW_HIDE

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Sleep 800
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; Lepas aturan firewall KOPKU (butuh persetujuan Administrator; bila ditolak aturan tetap ada — aman, hanya subnet lokal).
  IfSilent +2
  ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall delete rule name="KOPKU Desktop Sinkron"' SW_HIDE
  ; Data koperasi di %APPDATA%\KOPKU Desktop sengaja TIDAK dihapus.
  MessageBox MB_ICONINFORMATION|MB_OK "${APP_NAME} telah dihapus.$\r$\n$\r$\nData koperasi Anda tetap tersimpan di:$\r$\n$APPDATA\${APP_NAME}$\r$\n$\r$\nHapus folder itu secara manual hanya bila data memang tidak diperlukan lagi." /SD IDOK
SectionEnd
