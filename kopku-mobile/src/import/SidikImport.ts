import type {
  BarisAnggota,
  BarisAset,
  BarisBerjangka,
  BarisPinjaman,
  BarisSimpanan,
  HasilParseBerkas,
} from './ExcelDataAwalParser';

/**
 * RC-S133.6.2 — SIDIK ISI BARIS IMPORT DATA AWAL (MODUL MURNI).
 *
 * Mencegah import ganda tanpa bergantung pada nama berkas maupun NIK.
 * Setiap baris yang menulis data ke buku diberi sidik SHA-256 dari ISI
 * barisnya dalam bentuk baku:
 *
 *  - Anggota dikenali dari nama (huruf kecil, spasi dirapikan), NIK (angka
 *    saja, bila ada), dan tanggal bergabung — BUKAN dari Kode Anggota, yang
 *    hanya berlaku di dalam satu berkas. Baris simpanan/pinjaman/berjangka
 *    merujuk anggotanya lewat identitas yang sama.
 *  - Hanya kolom yang menentukan "transaksi yang mana" yang ikut: kolom
 *    keadaan (angsuran sudah dibayar, sisa pokok, tunggakan, sumber dana,
 *    rekening) TIDAK ikut, supaya berkas yang sama dengan angka keadaan yang
 *    diperbarui tetap dikenali sebagai pinjaman/setoran yang sama dan tidak
 *    dibuat dua kali.
 *  - Isi yang sama persis yang muncul beberapa kali di satu berkas dibedakan
 *    dengan urutan kemunculannya (#0, #1, ...). Berkas kedua yang memuat isi
 *    itu sekali lagi dianggap baris yang sama dengan kemunculan pertama.
 *
 * Sheet "6. Jasa Dibayar" dan "7. Saldo Awal Akun" TIDAK diberi sidik:
 * keduanya sudah idempoten (jasa disimpan per anggota dengan menimpa; saldo
 * awal akun ditolak bila akunnya sudah bersaldo awal).
 *
 * Keterbatasan yang disengaja: dua setoran yang benar-benar berbeda tetapi
 * isinya identik (anggota, tanggal, nominal sama) di DUA berkas berbeda akan
 * dianggap sama; yang kedua dilewati dan dilaporkan. Setoran seperti itu
 * dicatat lewat menu transaksi biasa.
 */

export const VERSI_SIDIK = 'v1';

export type JenisSidik = 'ANGGOTA' | 'SIMPANAN' | 'BERJANGKA' | 'PINJAMAN' | 'ASET';

export const JENIS_SIDIK: readonly JenisSidik[] = ['ANGGOTA', 'SIMPANAN', 'BERJANGKA', 'PINJAMAN', 'ASET'];

export interface SidikBaris {
  jenis: JenisSidik;
  baris: number;
  sidik: string;
}

export interface SidikBerkas {
  perBaris: SidikBaris[];
  /** Sidik seluruh berkas (gabungan sidik baris, terurut). null bila tidak ada baris bersidik. */
  sidikBerkas: string | null;
  /** `${jenis}:${baris}` -> sidik. */
  peta: Map<string, string>;
}

/** Catatan sidik yang sudah tersimpan di database. */
export interface SidikTercatat {
  sidik: string;
  jenisSheet: string;
  status: 'BERHASIL' | 'SEBAGIAN';
  entitasId: string | null;
  createdAt: string;
  namaBerkas: string | null;
}

export function kunciSidik(jenis: JenisSidik, baris: number): string {
  return `${jenis}:${baris}`;
}

export function normalkanNamaSidik(nama: string | null | undefined): string {
  return String(nama ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function teks(v: unknown): string {
  return String(v ?? '').trim();
}

function angka(v: unknown): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '';
}

/** Identitas baku anggota (tanpa kode lokal berkas). */
export function identitasAnggota(r: Pick<BarisAnggota, 'namaLengkap' | 'nik' | 'tanggalBergabung'>): string {
  return [normalkanNamaSidik(r.namaLengkap), teks(r.nik).replace(/\D/g, ''), teks(r.tanggalBergabung)].join('~');
}

/**
 * Hitung sidik setiap baris bersidik pada hasil parse. Fungsi murni — dipakai
 * pratinjau (layar) dan eksekutor dengan hasil yang identik.
 */
export function hitungSidikBerkas(h: HasilParseBerkas): SidikBerkas {
  const identitasPerKode = new Map<string, string>();
  for (const r of h.anggota.baris as BarisAnggota[]) {
    const k = teks(r.kode).toUpperCase();
    if (!identitasPerKode.has(k)) identitasPerKode.set(k, identitasAnggota(r));
  }
  const refAnggota = (kode: string) => identitasPerKode.get(teks(kode).toUpperCase()) ?? `KODE~${teks(kode).toUpperCase()}`;

  const perBaris: SidikBaris[] = [];
  const peta = new Map<string, string>();
  const tambah = (jenis: JenisSidik, rows: { baris: number }[], baku: (r: any) => string) => {
    const kemunculan = new Map<string, number>();
    for (const r of rows) {
      const isi = baku(r);
      const k = kemunculan.get(isi) ?? 0;
      kemunculan.set(isi, k + 1);
      const sidik = sha256Hex(`${VERSI_SIDIK}|${jenis}|${isi}|#${k}`);
      perBaris.push({ jenis, baris: r.baris, sidik });
      peta.set(kunciSidik(jenis, r.baris), sidik);
    }
  };

  tambah('ANGGOTA', h.anggota.baris, (r: BarisAnggota) => identitasAnggota(r));
  tambah('SIMPANAN', h.simpanan.baris, (r: BarisSimpanan) =>
    [refAnggota(r.kode), teks(r.tanggal), angka(r.pokok), angka(r.wajib), angka(r.sukarela)].join('|')
  );
  tambah('BERJANGKA', h.berjangka.baris, (r: BarisBerjangka) =>
    [refAnggota(r.kode), teks(r.tanggal), angka(r.nominal), angka(r.tenorBulan), angka(r.sukuBungaPerTahun ?? '')].join('|')
  );
  tambah('PINJAMAN', h.pinjaman.baris, (r: BarisPinjaman) =>
    [
      refAnggota(r.kode),
      teks(r.tanggal),
      angka(r.jumlahPinjaman),
      angka(r.tenor),
      teks(r.satuanTenor),
      teks(r.metodeJasa),
      angka(r.persentaseJasa),
    ].join('|')
  );
  tambah('ASET', h.aset.baris, (r: BarisAset) =>
    [teks(r.nomorAset).toUpperCase(), normalkanNamaSidik(r.namaAset), teks(r.tanggalPerolehan), angka(r.nilaiPerolehan)].join('|')
  );

  const sidikBerkas =
    perBaris.length > 0 ? sha256Hex(`${VERSI_SIDIK}|BERKAS|${perBaris.map((b) => b.sidik).sort().join(',')}`) : null;
  return { perBaris, sidikBerkas, peta };
}

export interface PerbandinganSidik {
  total: number;
  sudah: (SidikBaris & { catatan: SidikTercatat })[];
  baru: SidikBaris[];
  /** Catatan paling awal di antara baris yang sudah diimpor (untuk pesan). */
  pertama: SidikTercatat | null;
}

/** Bandingkan sidik berkas dengan sidik yang sudah tercatat. */
export function bandingkanSidik(sb: SidikBerkas, tercatat: ReadonlyMap<string, SidikTercatat>): PerbandinganSidik {
  const sudah: (SidikBaris & { catatan: SidikTercatat })[] = [];
  const baru: SidikBaris[] = [];
  let pertama: SidikTercatat | null = null;
  for (const b of sb.perBaris) {
    const c = tercatat.get(b.sidik);
    if (c) {
      sudah.push({ ...b, catatan: c });
      if (!pertama || c.createdAt < pertama.createdAt) pertama = c;
    } else {
      baru.push(b);
    }
  }
  return { total: sb.perBaris.length, sudah, baru, pertama };
}

// ===========================================================================
// SHA-256 (FIPS 180-4) — implementasi murni, tanpa dependensi.
// ===========================================================================

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256Hex(pesan: string): string {
  const b = utf8(pesan);
  const panjangBit = b.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  const tinggi = Math.floor(panjangBit / 0x100000000);
  const rendah = panjangBit >>> 0;
  b.push((tinggi >>> 24) & 255, (tinggi >>> 16) & 255, (tinggi >>> 8) & 255, tinggi & 255);
  b.push((rendah >>> 24) & 255, (rendah >>> 16) & 255, (rendah >>> 8) & 255, rendah & 255);

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array<number>(64);
  for (let off = 0; off < b.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      W[t] = ((b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15];
      const y = W[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + bb) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  return H.map((v) => v.toString(16).padStart(8, '0')).join('');
}
