; Disertakan ke installer NSIS electron-builder (package.json → build.nsis.include),
; dipakai saat membangun di Windows dengan `npm run dist:win`.
; Memasang izin Windows Firewall untuk sinkron HP (TCP 47821-47840, hanya subnet
; lokal) + menghapus aturan BLOKIR lama milik aplikasi. Satu dialog UAC.
; Isi sama dengan installer/kopku-setup.nsi (dipakai build tanpa Windows).
!macro customInstall
  InitPluginsDir
  FileOpen $9 "$PLUGINSDIR\kopku-firewall.cmd" w
  FileWrite $9 "@echo off$\r$\n"
  FileWrite $9 'netsh advfirewall firewall delete rule name=all dir=in program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" >nul 2>&1$\r$\n'
  FileWrite $9 'netsh advfirewall firewall delete rule name="KOPKU Desktop Sinkron" >nul 2>&1$\r$\n'
  FileWrite $9 'netsh advfirewall firewall add rule name="KOPKU Desktop Sinkron" dir=in action=allow protocol=TCP localport=47821-47840 remoteip=localsubnet profile=any >nul$\r$\n'
  FileWrite $9 'netsh advfirewall firewall add rule name="KOPKU Desktop Sinkron" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP remoteip=localsubnet profile=any >nul$\r$\n'
  FileClose $9
  DetailPrint "Mengizinkan sinkron HP di Windows Firewall (perlu persetujuan Administrator)..."
  ExecShellWait "runas" "$PLUGINSDIR\kopku-firewall.cmd" "" SW_HIDE
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent +2
    ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall delete rule name="KOPKU Desktop Sinkron"' SW_HIDE
  ${endIf}
!macroend
