/**
 * SELF-TEST Ed25519 — MEMBUKTIKAN KRIPTOGRAFI BEKERJA DI PERANGKAT
 * =========================================================================
 *
 * MASALAH YANG DIPECAHKAN BERKAS INI.
 *
 * Test di Node membuktikan LOGIKA di sekitar verifikasi (parsing token,
 * pemilihan pesan, device binding). Ia TIDAK membuktikan bahwa
 * `@noble/ed25519` berjalan benar di Hermes — mesin JavaScript yang
 * dipakai React Native, dengan implementasi BigInt sendiri. Itu dua
 * pertanyaan berbeda, dan yang kedua hanya bisa dijawab di perangkat.
 *
 * Kalau BigInt Hermes bermasalah, gejalanya sangat buruk: SETIAP token
 * ditolak dengan `BAD_SIGNATURE`. Pesan itu menunjuk ke arah yang salah
 * — orang akan mencurigai server, memutar kunci, atau menuduh token
 * dipalsukan, sementara penyebabnya ada di mesin JS klien.
 *
 * Berkas ini mengubah kegagalan senyap itu menjadi diagnosis eksplisit:
 * sebelum verifikasi lisensi mana pun dipercaya, primitif kriptografinya
 * diuji dulu dengan vektor yang jawabannya sudah diketahui.
 *
 * ---------------------------------------------------------------------
 * ASAL VEKTOR — dan kenapa ini bukan angka karangan
 * ---------------------------------------------------------------------
 * Ketiga vektor positif di bawah adalah TEST 1, TEST 2, dan TEST 3 dari
 * RFC 8032 §7.1 (Ed25519 test vectors). Ketiganya sudah diperiksa
 * ulang terhadap implementasi Ed25519 yang independen (`crypto.verify`
 * bawaan Node) dan ketiganya lolos — jadi angka-angka ini terbukti
 * konsisten secara matematis, bukan sekadar disalin dari ingatan.
 *
 * Itu penting: vektor "known-good" yang ternyata salah akan membuat
 * library yang SEHAT dinyatakan rusak, dan aplikasi mengunci diri
 * sendiri tanpa alasan.
 *
 * ---------------------------------------------------------------------
 * KASUS NEGATIF
 * ---------------------------------------------------------------------
 * Lolosnya vektor positif saja TIDAK cukup. Implementasi yang selalu
 * mengembalikan `true` juga akan lolos semuanya. Karena itu tiga kasus
 * negatif ikut diuji — pesan diubah, tanda tangan diubah, kunci salah —
 * dan ketiganya HARUS ditolak.
 */

import { hexToBytes } from './bytes';
import { verifyEd25519 } from './ed25519';

interface Vector {
  readonly name: string;
  readonly publicKeyHex: string;
  readonly messageHex: string;
  readonly signatureHex: string;
}

/** RFC 8032 §7.1 — TEST 1, TEST 2, TEST 3. */
const RFC8032_VECTORS: readonly Vector[] = [
  {
    name: 'RFC 8032 TEST 1 (pesan kosong)',
    publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    messageHex: '',
    signatureHex:
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'RFC 8032 TEST 2 (1 byte)',
    publicKeyHex: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    messageHex: '72',
    signatureHex:
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'RFC 8032 TEST 3 (2 byte)',
    publicKeyHex: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    messageHex: 'af82',
    signatureHex:
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
];

export interface SelfTestCase {
  readonly name: string;
  /** Hasil yang seharusnya. */
  readonly expected: boolean;
  /** Hasil sebenarnya di mesin ini. `null` bila verifikasi melempar. */
  readonly actual: boolean | null;
  readonly passed: boolean;
}

export interface Ed25519SelfTestResult {
  readonly ok: boolean;
  readonly cases: readonly SelfTestCase[];
  readonly durationMs: number;
  /** Ringkas & aman ditampilkan ke pengguna. */
  readonly summary: string;
}

function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[0] ^= 0xff;
  return copy;
}

async function runCase(
  name: string,
  expected: boolean,
  run: () => Promise<boolean>
): Promise<SelfTestCase> {
  try {
    const actual = await run();
    return { name, expected, actual, passed: actual === expected };
  } catch {
    // Verifikasi yang MELEMPAR sama buruknya dengan yang salah jawab.
    // Dicatat sebagai `null` supaya bisa dibedakan di layar diagnostik.
    return { name, expected, actual: null, passed: false };
  }
}

/**
 * Jalankan seluruh self-test.
 *
 * Tidak melempar dalam keadaan apa pun: fungsi ini justru dipanggil
 * untuk MENDETEKSI lingkungan yang rusak, jadi ia sendiri tidak boleh
 * ikut roboh bersamanya.
 */
export async function runEd25519SelfTest(): Promise<Ed25519SelfTestResult> {
  const startedAt = Date.now();
  const cases: SelfTestCase[] = [];

  for (const vector of RFC8032_VECTORS) {
    const publicKey = hexToBytes(vector.publicKeyHex);
    const signature = hexToBytes(vector.signatureHex);
    const message = vector.messageHex === '' ? new Uint8Array(0) : hexToBytes(vector.messageHex);

    if (!publicKey || !signature || !message) {
      // Hanya mungkin bila konstanta di atas diedit menjadi tidak sah.
      cases.push({ name: vector.name, expected: true, actual: null, passed: false });
      continue;
    }

    cases.push(
      await runCase(vector.name, true, () => verifyEd25519(signature, message, publicKey))
    );
  }

  // --- Kasus negatif: membedakan "berfungsi" dari "selalu bilang ya" ---
  const base = RFC8032_VECTORS[2];
  const basePublicKey = hexToBytes(base.publicKeyHex);
  const baseSignature = hexToBytes(base.signatureHex);
  const baseMessage = hexToBytes(base.messageHex);

  if (basePublicKey && baseSignature && baseMessage) {
    cases.push(
      await runCase('Pesan diubah harus DITOLAK', false, () =>
        verifyEd25519(baseSignature, flipFirstByte(baseMessage), basePublicKey)
      )
    );
    cases.push(
      await runCase('Tanda tangan diubah harus DITOLAK', false, () =>
        verifyEd25519(flipFirstByte(baseSignature), baseMessage, basePublicKey)
      )
    );
    cases.push(
      await runCase('Public key salah harus DITOLAK', false, () =>
        verifyEd25519(baseSignature, baseMessage, flipFirstByte(basePublicKey))
      )
    );
  }

  const failed = cases.filter((testCase) => !testCase.passed);
  const durationMs = Date.now() - startedAt;

  return {
    ok: failed.length === 0 && cases.length > 0,
    cases,
    durationMs,
    summary:
      failed.length === 0 && cases.length > 0
        ? `${cases.length} pemeriksaan kriptografi lolos (${durationMs} ms).`
        : `${failed.length} dari ${cases.length} pemeriksaan kriptografi GAGAL.`,
  };
}

/**
 * Cache hasil per-proses.
 *
 * Self-test dijalankan sekali per peluncuran aplikasi, bukan setiap
 * pemeriksaan lisensi: hasilnya adalah sifat mesin JavaScript, yang
 * tidak berubah di tengah sesi. Menjalankannya berulang hanya menambah
 * beban tanpa menambah informasi.
 *
 * Ini BUKAN cache keputusan lisensi — hanya cache "apakah primitif
 * kriptografi di perangkat ini waras". Membekukannya lewat patch tidak
 * memberi keuntungan: melewati self-test tetap meninggalkan verifikasi
 * tanda tangan yang sesungguhnya di jalur utama.
 */
let cached: Ed25519SelfTestResult | null = null;
let inFlight: Promise<Ed25519SelfTestResult> | null = null;

export async function ensureCryptoHealthy(): Promise<Ed25519SelfTestResult> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = runEd25519SelfTest()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Hanya untuk test — mengosongkan cache proses. */
export function __resetCryptoHealthCacheForTests(): void {
  cached = null;
  inFlight = null;
}
