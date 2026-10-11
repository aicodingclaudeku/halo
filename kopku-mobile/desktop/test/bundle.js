'use strict';
// Membundel modul TypeScript aplikasi untuk diuji di Node (node:sqlite).
let esbuild; try { esbuild = require('esbuild'); } catch { esbuild = require(process.env.ESBUILD_PATH || '/opt/npm-tools/node_modules/esbuild'); }
const path = require('node:path'); const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '../..');
const alias = {
  'expo-sqlite': path.join(__dirname, 'shims/expo-sqlite-node.js'),
  'expo-file-system/legacy': path.join(__dirname, 'shims/expo-file-system-node.js'),
  'expo-crypto': path.join(ROOT, 'src/test-utils/expoCryptoMock.ts'),
  'expo-secure-store': path.join(ROOT, 'src/test-utils/expoSecureStoreMock.ts'),
  'expo-task-manager': path.join(ROOT, 'src/test-utils/expoBackgroundMock.ts'),
  'expo-background-task': path.join(ROOT, 'src/test-utils/expoBackgroundMock.ts'),
  'expo-file-system': path.join(__dirname, 'shims/expo-file-system-new-node.js'),
  'expo-local-authentication': path.join(__dirname, 'shims/stub-native.js'),
  'expo-sharing': path.join(__dirname, 'shims/stub-native.js'),
  'expo-document-picker': path.join(__dirname, 'shims/stub-native.js'),
  'expo-print': path.join(__dirname, 'shims/stub-native.js'),
  'expo-image-picker': path.join(__dirname, 'shims/stub-native.js'),
  'expo-constants': path.join(__dirname, 'shims/stub-native.js'),
};
// Cadangan bila node_modules proyek tidak ada (lingkungan tanpa registry npm):
// paket kecil dipetakan ke shim uji yang sudah ada di repositori.
const adaPaket = (n) => { try { require.resolve(n, { paths: [path.join(ROOT, 'node_modules')] }); return true; } catch { return false; } };
const CADANGAN = {
  zustand: path.join(__dirname, 'shims/zustand-node.js'),
  'date-fns': path.join(ROOT, '.harness/dateFnsShim.ts'),
  'decimal.js': path.join(ROOT, 'src/test-utils/decimalShim.ts'),
  // Ed25519 lewat crypto Node ASLI (bukan pemalsuan) — lihat berkas mock-nya.
  '@noble/ed25519': path.join(ROOT, 'src/test-utils/nobleEd25519Mock.ts'),
};
for (const [n, f] of Object.entries(CADANGAN)) if (!adaPaket(n) && fs.existsSync(f)) alias[n] = f;
const plugin = { name: 'alias', setup(b) {
  b.onResolve({ filter: /^(zustand|date-fns|decimal\.js|@noble\/ed25519)$/ }, (a) => (alias[a.path] ? { path: alias[a.path] } : undefined));
  b.onResolve({ filter: /^(expo-sqlite|expo-file-system\/legacy|expo-file-system|expo-crypto|expo-secure-store|expo-task-manager|expo-background-task|expo-local-authentication|expo-sharing|expo-document-picker|expo-print|expo-image-picker|expo-constants)$/ }, (a) => ({ path: alias[a.path] }));
} };
async function bundle(entry, out, opts = {}) {
  await esbuild.build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    plugins: [plugin], tsconfig: path.join(ROOT, 'tsconfig.json'), nodePaths: [path.join(ROOT,'node_modules'), ...(process.env.NODE_PATH || '').split(':').filter(Boolean)], resolveExtensions: opts.desktop ? ['.web.ts', '.ts', '.tsx', '.js', '.json'] : ['.ts', '.tsx', '.js', '.json'], external: ['node:*', 'react-native', 'expo-*', 'react'], logLevel: 'warning', sourcemap: 'inline' });
}
module.exports = { bundle, ROOT };
if (require.main === module) bundle(process.argv[2], process.argv[3]).catch((e) => { console.error(e); process.exit(1); });
