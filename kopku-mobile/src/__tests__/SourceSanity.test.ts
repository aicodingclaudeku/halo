import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * PENJAGA SANITASI SOURCE — khususnya berkas `.tsx`.
 *
 * KENAPA SUITE INI ADA.
 * RC-S41 mengapalkan compile blocker: dua deklarasi `const navigation`
 * di dalam satu komponen. Penyebabnya patch yang menambah deklarasi
 * tanpa memeriksa apakah sudah ada.
 *
 * Yang seharusnya menangkapnya adalah compiler — tetapi berkas `.tsx`
 * TIDAK tercakup typecheck ter-scope, karena `@types/react` tidak dapat
 * dipasang di lingkungan pengembangan ini. Jadi kesalahan yang mestinya
 * berhenti di detik pertama justru sampai ke tahap review.
 *
 * Suite ini BUKAN pengganti `npm run typecheck`. Ia hanya menutup satu
 * kelas kesalahan yang terbukti pernah lolos, sampai typecheck penuh
 * benar-benar dapat dijalankan.
 */

const ROOT = join(__dirname, '..', '..');

function berkasSumber(dir: string, hasil: string[] = []): string[] {
  for (const entri of readdirSync(dir)) {
    if (entri === 'node_modules' || entri === '.harness' || entri === '__tests__') continue;
    const penuh = join(dir, entri);
    if (statSync(penuh).isDirectory()) berkasSumber(penuh, hasil);
    else if (/\.(ts|tsx)$/.test(entri)) hasil.push(penuh);
  }
  return hasil;
}

/**
 * Cari deklarasi `const`/`let` ganda dalam SATU blok yang sama.
 *
 * Kedalaman kurung kurawal dilacak supaya dua variabel bernama sama di
 * dua fungsi berbeda TIDAK dianggap konflik — itu sah dan sering
 * terjadi (mis. `const rows` di dua handler terpisah).
 *
 * Baris di dalam string atau komentar diabaikan secara kasar; tujuannya
 * menangkap kesalahan nyata, bukan menjadi parser TypeScript.
 */
function deklarasiGanda(sumber: string): string[] {
  const temuan: string[] = [];
  const tumpukan: Array<Map<string, number>> = [new Map()];
  let kedalaman = 0;

  const baris = sumber
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n');

  for (let i = 0; i < baris.length; i += 1) {
    const b = baris[i];
    const cocok = b.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (cocok) {
      const nama = cocok[1];
      const blok = tumpukan[kedalaman];
      if (blok.has(nama)) {
        temuan.push(`${nama} (baris ${blok.get(nama)} dan ${i + 1})`);
      } else {
        blok.set(nama, i + 1);
      }
    }
    for (const ch of b) {
      if (ch === '{') {
        kedalaman += 1;
        if (!tumpukan[kedalaman]) tumpukan[kedalaman] = new Map();
        else tumpukan[kedalaman] = new Map();
      } else if (ch === '}') {
        if (kedalaman > 0) kedalaman -= 1;
      }
    }
  }
  return temuan;
}

describe('tidak ada deklarasi ganda di satu blok', () => {
  const sumber = berkasSumber(join(ROOT, 'src')).concat(berkasSumber(join(ROOT, 'app')));

  it('menemukan berkas untuk diperiksa', () => {
    expect(sumber.length).toBeGreaterThan(50);
  });

  it('seluruh source bebas deklarasi const/let ganda', () => {
    const pelanggaran: string[] = [];
    for (const berkas of sumber) {
      const ganda = deklarasiGanda(readFileSync(berkas, 'utf8'));
      if (ganda.length > 0) {
        pelanggaran.push(`${berkas.replace(ROOT + '/', '')}: ${ganda.join(', ')}`);
      }
    }
    expect(pelanggaran).toEqual([]);
  });

  it('pendeteksinya benar-benar bekerja pada contoh yang salah', () => {
    // Tanpa ini, pendeteksi yang rusak akan selalu melaporkan "bersih"
    // dan test di atas menjadi hijau palsu — persis kegagalan yang
    // membuat suite ini dibutuhkan.
    const contohSalah = `
      function Komponen() {
        const navigation = useNavigation();
        const navigation = useNavigation<any>();
      }
    `;
    expect(deklarasiGanda(contohSalah)).toHaveLength(1);
  });

  it('dua nama sama di blok BERBEDA tidak dianggap konflik', () => {
    const contohSah = `
      function a() {
        const rows = ambil();
      }
      function b() {
        const rows = ambilLain();
      }
    `;
    expect(deklarasiGanda(contohSah)).toEqual([]);
  });
});

describe('tidak ada nama impor ganda', () => {
  const sumber = berkasSumber(join(ROOT, 'src')).concat(berkasSumber(join(ROOT, 'app')));

  it('tidak ada identifier yang diimpor dua kali dalam satu berkas', () => {
    /**
     * Yang diperiksa adalah NAMA BINDING, bukan modulnya.
     *
     * Versi pertama test ini melarang modul yang sama diimpor dua kali
     * — dan itu KELIRU: `import { A } from '@/x'` lalu
     * `import type { B } from '@/x'` sepenuhnya sah dan sudah dipakai
     * di tujuh berkas proyek ini. Melarangnya berarti menuntut
     * perubahan gaya pada kode yang tidak bermasalah.
     *
     * Yang benar-benar gagal dikompilasi adalah nama yang sama diikat
     * dua kali — kelas yang sama dengan `const navigation` ganda.
     */
    const pelanggaran: string[] = [];
    for (const berkas of sumber) {
      const isi = readFileSync(berkas, 'utf8');
      const terlihat = new Map<string, number>();
      const baris = isi.split('\n');

      for (let i = 0; i < baris.length; i += 1) {
        const impor = baris[i].match(/^import\s+(.+?)\s+from\s+['"]/);
        if (!impor) continue;
        const klausa = impor[1].replace(/^type\s+/, '');

        const nama: string[] = [];
        const kurung = klausa.match(/\{([^}]*)\}/);
        if (kurung) {
          for (const bagian of kurung[1].split(',')) {
            const bersih = bagian.trim().replace(/^type\s+/, '');
            if (!bersih) continue;
            const alias = bersih.split(/\s+as\s+/);
            nama.push((alias[1] ?? alias[0]).trim());
          }
        }
        const bawaan = klausa.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
        if (bawaan && !bawaan.startsWith('*')) nama.push(bawaan);

        for (const n of nama) {
          if (terlihat.has(n)) {
            pelanggaran.push(
              `${berkas.replace(ROOT + '/', '')}: '${n}' (baris ${terlihat.get(n)} dan ${i + 1})`
            );
          } else {
            terlihat.set(n, i + 1);
          }
        }
      }
    }
    expect(pelanggaran).toEqual([]);
  });
});
