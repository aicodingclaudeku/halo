/**
 * Kategori pada form Beban (Pengeluaran) — logika MURNI, tanpa I/O.
 *
 * Permintaan pengguna:
 *  - "Beban Imbalan Kerja" TIDAK ditawarkan di sini: sudah ada menu
 *    Imbalan Kerja tersendiri. Akun 5-1050 dan menunya tidak berubah.
 *  - "Beban Lainnya" generik diganti oleh entri **Data Beban Lain** yang
 *    sudah diinput pengguna (data_referensi, jenis BEBAN_LAIN).
 *
 * Tidak ada perubahan akuntansi: entri Data Beban Lain tetap dibukukan
 * ke akun yang SAMA dengan pilihan "Beban Lainnya" sebelumnya (5-2000,
 * akun beban lain-lain di luar kategori). Yang berubah hanya label
 * kategori yang tersimpan — nama beban lainnya, bukan teks generik.
 */

/** Kategori tetap — nama WAJIB persis sama dengan nama akun di defaultCOA.ts. */
export const KATEGORI_BEBAN_TETAP: readonly string[] = [
  'Beban Administrasi dan Umum',
  'Beban Sewa',
  'Beban Transportasi',
  'Beban BBM',
  'Beban Listrik',
  'Beban Telepon',
  'Beban Perkoperasian',
  'Beban Pajak Penghasilan',
];

/** Akun tujuan entri Data Beban Lain — akun "Beban Lainnya" existing. */
export const KODE_AKUN_BEBAN_LAIN = '5-2000';

export type OpsiKategoriBeban =
  | { key: string; label: string; sumber: 'KATEGORI'; akunNama: string }
  | { key: string; label: string; sumber: 'BEBAN_LAIN'; akunKode: string; keterangan: string | null };

export function susunOpsiKategoriBeban(
  bebanLain: readonly { id: string; nama: string; keterangan?: string | null }[]
): OpsiKategoriBeban[] {
  const tetap: OpsiKategoriBeban[] = KATEGORI_BEBAN_TETAP.map((nama) => ({
    key: `kat:${nama}`,
    label: nama,
    sumber: 'KATEGORI',
    akunNama: nama,
  }));
  const dipakai = new Set(KATEGORI_BEBAN_TETAP.map((n) => n.toLowerCase()));
  const lain: OpsiKategoriBeban[] = [];
  for (const b of bebanLain) {
    const nama = b.nama.trim();
    // Nama yang sama dengan kategori tetap (atau duplikat) tidak ditampilkan
    // dua kali — pengguna memilih kategori tetapnya.
    if (!nama || dipakai.has(nama.toLowerCase())) continue;
    dipakai.add(nama.toLowerCase());
    lain.push({ key: `lain:${b.id}`, label: nama, sumber: 'BEBAN_LAIN', akunKode: KODE_AKUN_BEBAN_LAIN, keterangan: b.keterangan ?? null });
  }
  lain.sort((a, b) => a.label.localeCompare(b.label, 'id'));
  return [...tetap, ...lain];
}

export function cariOpsiKategoriBeban(opsi: readonly OpsiKategoriBeban[], query: string): OpsiKategoriBeban[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...opsi];
  return opsi.filter(
    (o) => o.label.toLowerCase().includes(q) || (o.sumber === 'BEBAN_LAIN' && (o.keterangan ?? '').toLowerCase().includes(q))
  );
}
