'use strict';
/**
 * KOPKU Desktop 1.0.14 — PETA MODUL BUNDLE RENDERER ↔ SOURCE.
 *
 * Bundle renderer (Metro, terminifikasi) tidak menyimpan nama berkas. Untuk
 * MENGGANTI modul lama atau MENYISIPKAN modul baru tanpa `expo export`
 * (registry npm tidak terjangkau di lingkungan pengerjaan), setiap
 * `require` source harus dipetakan ke id modul Metro yang benar. Peta ini
 * dibangun hanya dari bukti, bukan tebakan:
 *
 *  1. Modul hasil tambalan sebelumnya (`var require=function(n){switch(n)…`)
 *     → tabel `case "<spesifier>":return _$r(<id>)` dibaca langsung.
 *  2. Modul ber-ekspor-bernama dikenali dari irisan indeks ekspor
 *     (`indeksEkspor`) dengan daftar ekspor berkas source — harus TEPAT satu.
 *  3. Untuk setiap modul Babel yang sudah dikenali, daftar dependensinya
 *     (`},ID,[d0,d1,…]`) DIPASANGKAN berurutan dengan import source-nya
 *     (urutan Babel/Metro: import sesuai urutan berkas — import dari
 *     'react-native' dipecah per komponen — lalu `react/jsx-runtime` bila
 *     ada JSX, lalu `require()` di badan kode). Hanya dipakai bila JUMLAHNYA
 *     sama persis; modul yang ditemukan lewat dependensi ikut dipasangkan
 *     (berulang sampai tidak ada yang baru).
 *  4. Setiap pemetaan yang bertentangan (satu berkas → dua id) DIGAGALKAN.
 *
 * Kunci peta: '@/<path tanpa ekstensi>' untuk berkas source, 'rn:<Nama>'
 * untuk komponen react-native-web, 'pkg:<nama>' untuk paket.
 */
const fs = require('node:fs');
const path = require('node:path');
let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(process.env.TYPESCRIPT_PATH || '/opt/node22/lib/node_modules/typescript');
}
const { indeksEkspor } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));

function segmenModul(t) {
  const awal = [];
  const re = /__d\(function\(/g;
  let m;
  while ((m = re.exec(t))) awal.push(m.index);
  const seg = new Map();
  for (let k = 0; k < awal.length; k++) {
    const batas = k + 1 < awal.length ? awal[k + 1] : t.length;
    const potong = t.slice(awal[k], batas);
    const mm = /\},(\d+),\[([0-9,]*)\]\);?/g;
    let last = null;
    let x;
    while ((x = mm.exec(potong))) last = x;
    if (!last) continue;
    seg.set(Number(last[1]), {
      mulai: awal[k],
      akhir: awal[k] + last.index + last[0].length,
      deps: last[2].split(',').filter(Boolean).map(Number),
    });
  }
  return seg;
}

const EXT = ['.web.tsx', '.web.ts', '.tsx', '.ts', '/index.tsx', '/index.ts', '.js'];
function cariBerkas(akar, rel) {
  for (const e of EXT) {
    const f = path.join(akar, rel + e);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Normalisasi spesifier import relatif terhadap berkas `rel` (tanpa ekstensi, relatif ke src/). */
function kunciSpesifier(spes, relBerkas) {
  if (spes.startsWith('@/')) return '@/' + spes.slice(2).replace(/\.(web\.)?(tsx?|js)$/, '');
  if (spes.startsWith('./') || spes.startsWith('../')) {
    const r = path.posix.normalize(path.posix.join(path.posix.dirname(relBerkas), spes));
    if (r.startsWith('../')) return 'aset:' + r; // keluar dari src (mis. ../../assets)
    // `require('./colors.ts')` di dalam varian .web = berkas DASAR (bukan varian web).
    if (/\.tsx?$/.test(r) && !/\.web\.tsx?$/.test(r)) return '@/' + r.replace(/\.tsx?$/, '') + '#dasar';
    return '@/' + r.replace(/\.(web\.)?(tsx?|js)$/, '');
  }
  return 'pkg:' + spes;
}

/**
 * Daftar dependensi sebuah berkas source sebagaimana dihasilkan Babel/Metro.
 * @returns {string[]|null} kunci berurutan
 */
function depsSource(file, relBerkas) {
  const src = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: path.basename(file),
  }).outputText;
  const hasil = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Spesifier import yang DIPERTAHANKAN TypeScript (impor tipe saja dibuang).
  const dipakai = new Set([...out.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
  const sudah = new Set();
  let adaJsx = /react\/jsx-runtime/.test(out);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spes = st.moduleSpecifier.text;
    if (st.importClause && st.importClause.isTypeOnly) continue;
    if (!dipakai.has(spes)) continue;
    if (spes === 'react-native') {
      const nb = st.importClause && st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const nama = (el.propertyName || el.name).text;
          const lokal = el.name.text;
          // Babel menghapus spesifier yang tidak dipakai sebagai nilai.
          const re = new RegExp(`react_native_\\d*\\.${lokal}\\b|\\b${lokal}\\b`);
          const badan = out.replace(/^.*require\("react-native"\).*$/m, '');
          if (!re.test(badan)) continue;
          const k = 'rn:' + nama;
          if (!sudah.has(k)) {
            sudah.add(k);
            hasil.push(k);
          }
        }
      }
      continue;
    }
    const k = kunciSpesifier(spes, relBerkas);
    if (!sudah.has(k)) {
      sudah.add(k);
      hasil.push(k);
    }
  }
  if (adaJsx) {
    hasil.push('pkg:react/jsx-runtime');
    sudah.add('pkg:react/jsx-runtime');
  }
  // require() di badan kode (mis. aset gambar), urut kemunculan.
  for (const m of src.matchAll(/(?<![.\w])require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const k = kunciSpesifier(m[1], relBerkas);
    if (!sudah.has(k)) {
      sudah.add(k);
      hasil.push(k);
    }
  }
  return hasil;
}

function eksporSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const nama = new Set();
  for (const m of src.matchAll(/^export (?:async )?(?:function\*? |class |const |let |enum )([A-Za-z_$][\w$]*)/gm)) nama.add(m[1]);
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(/\s+as\s+/).pop();
      if (n && !n.startsWith('type ') && n !== 'default') nama.add(n);
    }
  }
  return [...nama];
}

function semuaBerkas(akar, sub) {
  const hasil = [];
  const jalan = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test-utils') continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) jalan(p, r);
      else if (/\.(tsx?|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) hasil.push({ file: p, rel: r.replace(/\.(tsx?|js)$/, '') });
    }
  };
  jalan(path.join(akar, sub), sub === 'src' ? '' : sub);
  return hasil;
}

/**
 * @param {string} teks bundle
 * @param {string} akarSource akar proyek source (berisi src/ & app/) yang COCOK dengan bundle
 */
function bangunPeta(teks, akarSource, penanda = {}) {
  const daftarAkar = Array.isArray(akarSource) ? akarSource : [akarSource];
  akarSource = daftarAkar[0];
  const SEG = segmenModul(teks);
  const indeks = indeksEkspor(teks);
  const peta = new Map(); // kunci -> id
  const asal = new Map(); // kunci -> bukti
  const konflik = [];
  const set = (k, id, bukti) => {
    if (peta.has(k) && peta.get(k) !== id) {
      konflik.push(`${k}: ${peta.get(k)} (${asal.get(k)}) vs ${id} (${bukti})`);
      return;
    }
    if (!peta.has(k)) {
      peta.set(k, id);
      asal.set(k, bukti);
    }
  };
  const isi = (id) => teks.slice(SEG.get(id).mulai, SEG.get(id).akhir);

  // 1. modul hasil tambalan (tabel switch)
  const ditambal = new Set();
  for (const [id] of SEG) {
    const m = isi(id);
    const sw = /var require=function\(n\)\{switch\(n\)\{(.*?)\}throw new Error\("KOPKU patch/.exec(m);
    if (!sw) continue;
    ditambal.add(id);
    for (const c of sw[1].matchAll(/case "([^"]+)":return ([^;]+);/g)) {
      if (c[1] === 'react-native') {
        for (const k of c[2].matchAll(/(\w+):_\$r\((\d+)\)\.default/g)) set('rn:' + k[1], Number(k[2]), `tambalan#${id}`);
      } else if (c[1].startsWith('@/')) {
        const n = /_\$r\((\d+)\)/.exec(c[2]);
        if (n) set('@/' + c[1].slice(2), Number(n[1]), `tambalan#${id}`);
      } else if (!c[1].startsWith('.')) {
        const n = /^_\$r\((\d+)\)$/.exec(c[2].trim());
        if (n) set('pkg:' + c[1], Number(n[1]), `tambalan#${id}`);
      }
    }
  }

  // 2. kenali berkas ber-ekspor-bernama
  const berkas = [...semuaBerkas(akarSource, 'src'), ...semuaBerkas(akarSource, 'app').map((b) => ({ ...b, rel: b.rel }))];
  const relKeFile = new Map(berkas.map((b) => [b.rel, b.file]));
  for (const b of berkas) {
    const nm = eksporSource(b.file);
    if (nm.length === 0) continue;
    let k = null;
    for (const n of nm) {
      const ids = new Set(indeks.get(n) || []);
      k = k === null ? ids : new Set([...k].filter((x) => ids.has(x)));
    }
    if (k && k.size === 1) set('@/' + b.rel, [...k][0], 'ekspor');
  }

  // 2b. berkas ber-ekspor-default saja: dikenali dari penanda isi (harus tepat satu modul)
  for (const [rel, tanda] of Object.entries(penanda)) {
    const ids = [];
    for (const [id] of SEG) {
      const m = isi(id);
      if (tanda.every((t) => m.includes(t))) ids.push(id);
    }
    if (ids.length !== 1) throw new Error(`penanda ${rel}: ${ids.length} modul (${ids.slice(0, 5).join(',')})`);
    set('@/' + rel, ids[0], 'penanda');
  }

  // 3. pasangkan dependensi (berulang)
  const dipasang = new Set();
  const tidakCocok = [];
  for (let putaran = 0; putaran < 30; putaran++) {
    let baru = 0;
    for (const [k, id] of [...peta]) {
      if (!k.startsWith('@/') || dipasang.has(k) || ditambal.has(id) || !SEG.has(id)) continue;
      const rel = k.slice(2).replace(/#dasar$/, '');
      const dasar = k.endsWith('#dasar');
      dipasang.add(k);
      const deps = SEG.get(id).deps;
      // Coba setiap akar source (versi berbeda) — pakai yang jumlah importnya sama persis.
      let ds = null;
      const dicoba = [];
      for (const akar of daftarAkar) {
        const file = dasar
          ? ['.ts', '.tsx'].map((e) => path.join(akar, 'src', rel + e)).find((f) => fs.existsSync(f))
          : cariBerkas(path.join(akar, 'src'), rel) || (rel.startsWith('app/') ? cariBerkas(akar, rel) : null);
        if (!file) continue;
        const d = depsSource(file, rel);
        dicoba.push(d.length);
        if (d.length === deps.length) {
          ds = d;
          break;
        }
      }
      if (!ds) {
        if (dicoba.length) tidakCocok.push(`${rel}#${id}: source ${dicoba.join('/')} vs bundle ${deps.length}`);
        continue;
      }
      ds.forEach((kd, i) => {
        if (!peta.has(kd)) baru++;
        set(kd, deps[i], `deps ${rel}#${id}[${i}]`);
      });
    }
    if (baru === 0) break;
  }
  return { peta, asal, konflik, tidakCocok, SEG, indeks };
}

module.exports = { bangunPeta, segmenModul, depsSource, kunciSpesifier, eksporSource, cariBerkas };

if (require.main === module) {
  const { cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));
  const [renderer, akar] = process.argv.slice(2);
  const teks = fs.readFileSync(cariBerkasBundle(renderer), 'utf8');
  const r = bangunPeta(teks, akar);
  console.log(JSON.stringify({ jumlah: r.peta.size, konflik: r.konflik.slice(0, 30), tidakCocok: r.tidakCocok.length, contohTidakCocok: r.tidakCocok.slice(0, 30) }, null, 1));
}
