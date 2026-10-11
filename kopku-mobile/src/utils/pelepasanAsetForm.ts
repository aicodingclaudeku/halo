import type { AsetDenganNilaiBukuItem } from '@/services/AsetService';
import type { PelepasanAsetTetapInput, PratinjauPelepasanAsetTetap } from '@/services/PelepasanAsetTetapService';
import type { Rupiah } from '@/utils/money';

/**
 * RC-S67.7 — helper MURNI untuk layar transaksi "Penjualan / Pelepasan Aset".
 *
 * TIDAK ada rumus akuntansi di sini. Nilai buku, selisih, dan jenis
 * laba/rugi SELALU berasal dari `pratinjauPelepasanAsetTetap()` (service
 * existing). Berkas ini hanya: menyaring aset yang boleh dipilih, memvalidasi
 * isian form (UX), menyusun input service, dan memberi label pratinjau.
 */

/** Aset yang boleh dipilih: hanya status AKTIF (DIHAPUS = terminal, sudah dilepas/dihapus). */
export function asetDapatDilepas(daftar: readonly AsetDenganNilaiBukuItem[]): AsetDenganNilaiBukuItem[] {
  return daftar.filter((a) => a.status === 'AKTIF');
}

export interface RekeningDipilih {
  id: string;
  jenis: 'KAS' | 'KAS_KECIL' | 'BANK';
}

export interface IsianPelepasan {
  aset: { id: string; status: string } | null;
  tanggal: string;
  nomorDokumen: string;
  hasil: number | '';
  rekening: RekeningDipilih | null;
}

export type ErrorIsianPelepasan = Partial<Record<'aset' | 'tanggal' | 'nomorDokumen' | 'hasil' | 'rekening', string>>;

/** Validasi UX. Service tetap otoritas (tanggal vs perolehan/penyusutan, periode, dsb.). */
export function validasiIsianPelepasan(i: IsianPelepasan): ErrorIsianPelepasan {
  const e: ErrorIsianPelepasan = {};
  if (!i.aset) e.aset = 'Aset tetap wajib dipilih.';
  else if (i.aset.status !== 'AKTIF') e.aset = 'Aset ini sudah tidak dapat dilepas.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test((i.tanggal ?? '').trim())) e.tanggal = 'Tanggal pelepasan wajib diisi.';
  if (!(i.nomorDokumen ?? '').trim()) e.nomorDokumen = 'Nomor dokumen wajib diisi.';
  if (i.hasil === '' || !Number.isFinite(i.hasil)) e.hasil = 'Hasil pelepasan wajib diisi (boleh 0).';
  else if (i.hasil < 0 || !Number.isInteger(i.hasil)) e.hasil = 'Hasil pelepasan harus rupiah bulat, tidak negatif.';
  if (i.hasil !== '' && i.hasil > 0 && !i.rekening) e.rekening = 'Kas/Bank wajib dipilih bila hasil pelepasan lebih dari 0.';
  return e;
}

/** Susun input `PelepasanAsetTetapInput` — mengikuti persis pola DaftarAsetTetapScreen. */
export function susunInputPelepasan(i: IsianPelepasan, createdBy: string, keterangan?: string): PelepasanAsetTetapInput | null {
  if (Object.keys(validasiIsianPelepasan(i)).length > 0 || !i.aset || i.hasil === '') return null;
  const hasil = i.hasil;
  const dok = i.nomorDokumen.trim().replace(/\s+/g, ' ');
  const cat = (keterangan ?? '').trim();
  return {
    asetId: i.aset.id,
    tanggalPelepasan: i.tanggal.trim(),
    hasilPelepasan: hasil,
    sumberDana: hasil > 0 && i.rekening ? (i.rekening.jenis === 'BANK' ? 'BANK' : 'KAS') : undefined,
    bankAccountId: hasil > 0 && i.rekening?.jenis === 'BANK' ? i.rekening.id : undefined,
    keterangan: `Dok ${dok}` + (cat ? ` · ${cat}` : ''),
    createdBy,
  };
}

/** Label baris selisih pratinjau — nilai & jenis dari service, tanpa hitung ulang. */
export function labelSelisihPelepasan(p: Pick<PratinjauPelepasanAsetTetap, 'jenisSelisih' | 'selisih'>): { label: string; nilai: Rupiah } {
  if (p.jenisSelisih === 'LABA') return { label: 'Laba Pelepasan', nilai: p.selisih };
  if (p.jenisSelisih === 'RUGI') return { label: 'Rugi Pelepasan', nilai: -p.selisih };
  return { label: 'Laba/Rugi', nilai: 0 };
}

// ------------------------------------------------------------------
// RC-S67.7.1 — hardening (helper murni, dapat diuji tanpa render RN)
// ------------------------------------------------------------------

/** Daftar kekurangan isian (urutan tetap) — dipakai layar untuk menjelaskan kenapa tombol Simpan nonaktif. */
export function daftarKekuranganPelepasan(i: IsianPelepasan): string[] {
  const e = validasiIsianPelepasan(i);
  return (['aset', 'tanggal', 'nomorDokumen', 'hasil', 'rekening'] as const).map((k) => e[k]).filter((x): x is string => !!x);
}

/**
 * Setelah daftar aset dimuat ulang (mis. submit gagal), aset terpilih
 * diganti dengan data TERBARU dari daftar; bila sudah tidak eligible
 * (dilepas/dihapus di tempat lain) pilihan dikosongkan — state lama tidak
 * terbawa.
 */
export function sinkronAsetTerpilih<T extends { id: string }>(terpilih: T | null, daftarEligibleBaru: readonly T[]): T | null {
  if (!terpilih) return null;
  return daftarEligibleBaru.find((a) => a.id === terpilih.id) ?? null;
}

/**
 * Pesan galat ramah operator. Kode service ("SUDAH_DILEPAS: ...") dibuang,
 * galat periode tertutup diterjemahkan, galat teknis (SQLite/stack/undefined)
 * TIDAK pernah diteruskan.
 */
export function pesanOperatorPelepasan(e: unknown, cadangan: string): string {
  if (e && typeof e === 'object') {
    const kode = (e as { kode?: string }).kode;
    const nama = (e as { name?: string }).name;
    if (nama === 'ClosedPeriodError' || kode === 'PERIODE_CLOSED') return 'Periode akuntansi untuk tanggal pelepasan sudah ditutup.';
    if (kode === 'ASET_TIDAK_DITEMUKAN') return 'Aset tidak ditemukan.';
    if (kode === 'SUDAH_DILEPAS') return 'Aset sudah dilepas; transaksi ganda ditolak.';
    if (kode === 'HASIL_TIDAK_VALID') return 'Nilai pelepasan tidak valid.';
    if (kode === 'REKENING_WAJIB') return 'Kas/Bank wajib dipilih bila hasil pelepasan lebih dari 0.';
  }
  const m = e instanceof Error ? e.message : '';
  if (!m || /sqlite|constraint|typeerror|referenceerror|undefined|\bnull\b|stack|at \w+ \(/i.test(m)) return cadangan;
  return m.replace(/^[A-Z][A-Z0-9_]+:\s*/, '');
}
