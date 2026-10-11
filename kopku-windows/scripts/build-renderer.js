'use strict';
/**
 * Membangun renderer KOPKU Desktop dari kode aplikasi yang SAMA dengan
 * Android: `expo export --platform web` dengan KOPKU_DESKTOP=1 (shim modul
 * native di desktop/shims), keluaran ke desktop/renderer.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..', '..');
// KOPKU_RENDERER_OUT hanya untuk build uji tampilan (desktop/test/ui); rilis selalu ke desktop/renderer.
const OUT = process.env.KOPKU_RENDERER_OUT ? path.resolve(process.env.KOPKU_RENDERER_OUT) : path.resolve(__dirname, '..', 'renderer');
fs.rmSync(OUT, { recursive: true, force: true });
execSync(`npx expo export --platform web --output-dir "${OUT}" --clear`, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, KOPKU_DESKTOP: '1', EXPO_NO_WEB_SETUP: '1', EXPO_NO_TELEMETRY: '1', CI: '1', NODE_ENV: 'production' },
});
// Meta kebijakan keamanan konten: hanya sumber lokal aplikasi.
const idx = path.join(OUT, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
html = html.replace(
  '<head>',
  `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self' app: kopkufs: data: blob:; script-src 'self' app: 'unsafe-inline'; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: kopkufs: data: blob:; font-src 'self' app: data:; connect-src 'self' app: kopkufs: data: blob:">`
);
// Gaya global khas aplikasi desktop: font sistem, scrollbar tipis, fokus
// keyboard yang jelas, tanpa garis fokus ganda pada input (bingkai input
// sudah menampilkan status fokus), seleksi teks berwarna brand.
const GAYA_DESKTOP = `<style id="kopku-desktop">
html,body{font-family:"Segoe UI Variable","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;background:#F1F3F6}
::selection{background:rgba(20,108,60,.22)}
*{scrollbar-width:thin;scrollbar-color:#C4CBD4 transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#C9D0D8;border-radius:8px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:#A9B2BD;border:2px solid transparent;background-clip:content-box}
input,textarea{outline:none!important}
*:focus{outline:none}
[role=button]:focus-visible,[role=tab]:focus-visible,[role=link]:focus-visible,[role=search]:focus-visible,[role=checkbox]:focus-visible,[role=switch]:focus-visible{outline:2px solid rgba(20,108,60,.55);outline-offset:2px;border-radius:8px}
[role=button],[role=tab]{transition:background-color .12s ease,border-color .12s ease,opacity .12s ease}
</style>`;
html = html.replace('</head>', GAYA_DESKTOP + '</head>');
fs.writeFileSync(idx, html);
console.log('Renderer desktop siap di', OUT);
