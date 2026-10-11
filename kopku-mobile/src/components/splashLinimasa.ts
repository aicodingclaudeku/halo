/**
 * LINIMASA LAYAR PEMBUKA (murni, tanpa react-native) supaya durasinya bisa
 * diuji langsung. Dipakai components/SplashIntro.tsx.
 *
 *     0 –  900  logo masuk (fade + skala dengan sedikit pantulan)
 *   200 – 1100  dua cincin orbit di belakang logo mengembang
 *   550 – 1350  "Kopku" lalu "Finance" naik bergantian
 *  1000 – 1700  "by Alqizani" (garis tumbuh), tagline, dan bilah progres muncul;
 *               kilau tipis menyapu logo
 *  1700 – 4400  bilah progres terisi
 *  4400 – 5000  logo sedikit membesar, isi naik, seluruh layar memudar
 */
export const LINIMASA_SPLASH = {
  logoMs: 900,
  cincinTundaMs: 200,
  cincinMs: 900,
  judulTundaMs: 550,
  judulMs: 650,
  /** Jeda antara "Kopku" dan "Finance". */
  judulJedaMs: 150,
  subTundaMs: 1000,
  subMs: 700,
  kilauTundaMs: 1000,
  kilauMs: 700,
  /** Fase pembuka = elemen terakhir selesai muncul. */
  pembukaMs: 1700,
  progresMs: 2700,
  keluarMs: 600,
} as const;

/** 1700 + 2700 + 600 = 5000 ms. Dikunci tes (SplashIntroRcS85). */
export const DURASI_TOTAL_MS = LINIMASA_SPLASH.pembukaMs + LINIMASA_SPLASH.progresMs + LINIMASA_SPLASH.keluarMs;
