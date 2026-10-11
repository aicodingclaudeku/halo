import { getDb } from '@/database/db';
import { catatPemasukan, type JenisRekening } from '@/services/KasBankService';
import { listTransaksiPendapatan, type FilterTransaksiPendapatan, type TransaksiPendapatanRow } from '@/services/PendapatanLainnyaService';
import type { LhuKlasifikasi } from '@/config/defaultCOA';
import { KEBIJAKAN_PENDAPATAN_UNIT_USAHA } from '@/config/pendapatanKoperasiPolicy';
import { Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * PENDAPATAN UNIT USAHA (Dr Kas/Bank, Cr 4-1400).
 * COA existing: 4-1400 — Pendapatan Unit Usaha.
 *
 * Transaksi PENDAPATAN yang sudah menjadi hak koperasi dari kegiatan unit
 * usaha dan SUDAH diterima di kas/bank (cash-basis). Ini BUKAN
 * pengembalian RAKU — pengembalian dana RAKU tetap lewat RAKUService
 * (PENGEMBALIAN_RAK, Cr 1-1800) dan tidak disentuh oleh berkas ini.
 *
 * Jalur akuntansi: SATU-SATUNYA jalur existing
 * `KasBankService.catatPemasukan` -> `createJournal`. Berkas ini tidak
 * menulis database dan tidak membuat jurnal sendiri; ia hanya lapisan
 * validasi di depannya:
 *
 *   - akun TIDAK dipilih pemanggil: selalu dibaca dari kebijakan
 *     (`KEBIJAKAN_PENDAPATAN_UNIT_USAHA.akunKode`) lalu divalidasi
 *     kategori PENDAPATAN, aktif, dan LHU PENDAPATAN_USAHA_LAIN. Tidak ada
 *     auto-create COA dan tidak ada fallback ke akun lain.
 *   - pemanggil yang menyelipkan field akun (`accountId`/`akunLawanId`)
 *     DITOLAK, bukan diabaikan diam-diam.
 *   - Poin 5 — UNIT USAHA WAJIB dipilih dari master `koperasi_unit_usaha`
 *     (status AKTIF) dan disimpan sebagai referensi `unit_usaha_id` pada
 *     baris kas/bank (kolom v77). Field "Nomor Dokumen" DIHAPUS karena
 *     tidak terhubung dengan master mana pun. Unit usaha baru TIDAK pernah
 *     dibuat otomatis.
 *   - idempotensi: kunci pengiriman dari form (`idempotencyKey`, dibuat
 *     sekali per isian) -> `PENDAPATAN_UNIT_USAHA|4-1400|<KUNCI>`; retry /
 *     ketukan ganda dengan kunci sama mengembalikan efek yang sudah ada,
 *     tidak membuat jurnal kedua.
 *   - periode tertutup ditolak oleh `createJournal` (ClosedPeriodError),
 *     atomik di dalam transaksi `catatPemasukan`.
 *
 * Reversal memakai mekanisme existing (`koreksiTransaksiPendapatan` ->
 * `koreksiTransaksiKasBank`): jurnal asli dibalik, tidak dihapus.
 *
 * Atribusi per unit usaha (Poin 5): relasi disimpan di kolom
 * `unit_usaha_id` (bukan diselipkan di teks keterangan). Nama unit ikut
 * ditulis di keterangan hanya sebagai teks baca untuk jurnal/histori.
 */

export type KodePenolakanPendapatanUnitUsaha =
  | 'AKUN_TIDAK_BOLEH_DIPILIH'
  | 'NOMINAL_TIDAK_VALID'
  | 'TANGGAL_TIDAK_VALID'
  | 'TANGGAL_MASA_DEPAN'
  | 'REKENING_WAJIB'
  | 'COA_TIDAK_TERSEDIA'
  | 'UNIT_USAHA_WAJIB'
  | 'UNIT_USAHA_TIDAK_DITEMUKAN'
  | 'UNIT_USAHA_NONAKTIF'
  | 'KUNCI_PENGIRIMAN_WAJIB';

export class PendapatanUnitUsahaDitolakError extends Error {
  constructor(readonly kode: KodePenolakanPendapatanUnitUsaha, pesan: string) {
    super(pesan);
    this.name = 'PendapatanUnitUsahaDitolakError';
  }
}

export interface InfoPendapatanUnitUsaha {
  label: string;
  akunKode: string;
  sumberKebijakan: string;
  /** NULL bila akun tidak dapat dipakai — lihat `masalah`. */
  akun: { accountId: string; kode: string; nama: string; klasifikasiLhu: LhuKlasifikasi } | null;
  /** Pesan untuk operator bila akun tidak tersedia/tidak aktif/salah klasifikasi. */
  masalah: string | null;
}

/**
 * Status akun 4-1400. Dipakai layar (tampilan read-only + tolak dini) DAN
 * oleh `catatPendapatanUnitUsaha` sebagai validasi otoritatif.
 */
export async function getInfoPendapatanUnitUsaha(): Promise<InfoPendapatanUnitUsaha> {
  const k = KEBIJAKAN_PENDAPATAN_UNIT_USAHA;
  const db = await getDb();
  const acc = await db.getFirstAsync<{
    id: string; kode: string; nama: string; kategori: string; is_active: number; lhu_klasifikasi: string | null;
  }>(`SELECT id, kode, nama, kategori, is_active, lhu_klasifikasi FROM account WHERE kode = ?`, k.akunKode);

  let masalah: string | null = null;
  if (!acc) masalah = `COA ${k.akunKode} belum tersedia. Hubungi administrator.`;
  else if (acc.kategori !== 'PENDAPATAN') masalah = `COA ${k.akunKode} bukan akun Pendapatan.`;
  else if (!acc.is_active) masalah = `COA ${k.akunKode} tidak aktif.`;
  else if (!acc.lhu_klasifikasi) masalah = `COA ${k.akunKode} belum diklasifikasikan untuk LHU.`;
  else if (acc.lhu_klasifikasi !== k.klasifikasiLhuWajib) {
    masalah = `COA ${k.akunKode} tidak diklasifikasikan sebagai Pendapatan Usaha Lain untuk LHU.`;
  }

  return {
    label: k.label,
    akunKode: k.akunKode,
    sumberKebijakan: k.sumberKebijakan,
    akun:
      acc && !masalah
        ? { accountId: acc.id, kode: acc.kode, nama: acc.nama, klasifikasiLhu: acc.lhu_klasifikasi as LhuKlasifikasi }
        : null,
    masalah,
  };
}

export interface CatatPendapatanUnitUsahaInput {
  tanggal: string;
  /** Poin 5 — `koperasi_unit_usaha.id` dari master; wajib & AKTIF. */
  unitUsahaId: string;
  /**
   * Kunci pengiriman (dibuat form SEKALI per isian, mis. `newId()`).
   * Menjadi identitas idempotensi — retry dengan kunci sama tidak
   * menggandakan jurnal.
   */
  idempotencyKey: string;
  nominal: Rupiah;
  jenis: JenisRekening;
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

/** Identitas idempotensi: `PENDAPATAN_UNIT_USAHA|4-1400|<KUNCI PENGIRIMAN>`. */
export function kunciIdentitasPendapatanUnitUsaha(kunciPengiriman: string): string {
  const k = KEBIJAKAN_PENDAPATAN_UNIT_USAHA;
  return `${k.prefiksIdentitas}|${k.akunKode}|${(kunciPengiriman ?? '').trim()}`;
}

function tanggalValid(tanggal: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return false;
  const [y, m, d] = tanggal.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Catat penerimaan Pendapatan Unit Usaha. Service adalah otoritas
 * validasi; UI hanya lapisan UX.
 */
export async function catatPendapatanUnitUsaha(
  input: CatatPendapatanUnitUsahaInput
): Promise<{ id: string; journalId: string; akunKode: string; klasifikasiLhu: LhuKlasifikasi; unitUsahaId: string }> {
  const k = KEBIJAKAN_PENDAPATAN_UNIT_USAHA;

  // Akun ditetapkan kebijakan. Field akun dari pemanggil = upaya memilih
  // akun lain -> DITOLAK eksplisit, tidak diabaikan diam-diam.
  const mentah = input as unknown as Record<string, unknown>;
  if (mentah.accountId !== undefined || mentah.akunLawanId !== undefined) {
    throw new PendapatanUnitUsahaDitolakError(
      'AKUN_TIDAK_BOLEH_DIPILIH',
      `Akun Pendapatan Unit Usaha ditetapkan sistem (${k.akunKode}) dan tidak dapat dipilih.`
    );
  }

  if (!Number.isFinite(input.nominal) || !Number.isInteger(input.nominal) || input.nominal <= 0) {
    throw new PendapatanUnitUsahaDitolakError('NOMINAL_TIDAK_VALID', 'Nominal harus bilangan bulat rupiah lebih dari 0.');
  }
  const tanggal = (input.tanggal ?? '').trim();
  if (!tanggalValid(tanggal)) {
    throw new PendapatanUnitUsahaDitolakError('TANGGAL_TIDAK_VALID', 'Tanggal tidak valid (format YYYY-MM-DD).');
  }
  if (tanggal > getTanggalLokalHariIni()) {
    throw new PendapatanUnitUsahaDitolakError('TANGGAL_MASA_DEPAN', 'Tanggal penerimaan tidak boleh di masa depan.');
  }
  if (input.jenis === 'BANK' && !input.bankAccountId) {
    throw new PendapatanUnitUsahaDitolakError('REKENING_WAJIB', 'Rekening bank wajib dipilih.');
  }

  const unitUsahaId = (input.unitUsahaId ?? '').trim();
  if (!unitUsahaId) throw new PendapatanUnitUsahaDitolakError('UNIT_USAHA_WAJIB', 'Unit usaha wajib dipilih.');
  const kunciPengiriman = (input.idempotencyKey ?? '').trim();
  if (!kunciPengiriman) {
    throw new PendapatanUnitUsahaDitolakError('KUNCI_PENGIRIMAN_WAJIB', 'Kunci pengiriman transaksi tidak tersedia.');
  }

  const db = await getDb();
  // Unit usaha HANYA dari master; tidak pernah dibuat otomatis.
  const unit = await db.getFirstAsync<{ id: string; nama_usaha: string; status: string }>(
    `SELECT id, nama_usaha, status FROM koperasi_unit_usaha WHERE id = ?`,
    unitUsahaId
  );
  if (!unit) {
    throw new PendapatanUnitUsahaDitolakError('UNIT_USAHA_TIDAK_DITEMUKAN', 'Unit usaha tidak ditemukan di master Unit Usaha.');
  }
  if (unit.status !== 'AKTIF') {
    throw new PendapatanUnitUsahaDitolakError('UNIT_USAHA_NONAKTIF', `Unit usaha ${unit.nama_usaha} tidak aktif.`);
  }

  const info = await getInfoPendapatanUnitUsaha();
  if (!info.akun) {
    throw new PendapatanUnitUsahaDitolakError('COA_TIDAK_TERSEDIA', info.masalah ?? `COA ${k.akunKode} tidak dapat dipakai.`);
  }

  const kunciIdentitas = kunciIdentitasPendapatanUnitUsaha(kunciPengiriman);
  const catatan = (input.keterangan ?? '').trim();
  const keterangan = catatan ? `${k.label} — ${unit.nama_usaha} · ${catatan}` : `${k.label} — ${unit.nama_usaha}`;

  // Retry/ketukan ganda dengan kunci sama: `catatPemasukan` mengembalikan
  // efek yang sudah ada (cek di dalam transaksinya) dan UNIQUE INDEX
  // idempotency_key menjadi jaring terakhir — tetap satu jurnal.
  const { id, journalId } = await catatPemasukan({
    jenis: input.jenis,
    bankAccountId: input.jenis === 'BANK' ? input.bankAccountId : undefined,
    tanggal,
    nominal: input.nominal,
    akunLawanId: info.akun.accountId,
    kategori: k.kategoriTransaksi,
    keterangan,
    createdBy: input.createdBy,
    idempotencyKey: kunciIdentitas,
    unitUsahaId: unit.id,
  });

  return { id, journalId, akunKode: info.akun.kode, klasifikasiLhu: info.akun.klasifikasiLhu, unitUsahaId: unit.id };
}

/** Baris riwayat Pendapatan Unit Usaha + unit usaha asalnya (Poin 5). */
export interface RiwayatPendapatanUnitUsahaRow extends TransaksiPendapatanRow {
  /** NULL untuk baris lama (sebelum v77) yang tidak menyimpan unit. */
  unitUsahaId: string | null;
  namaUnitUsaha: string | null;
}

/**
 * Riwayat leaf ini — SUBSET dari `listTransaksiPendapatan` (tabel & status
 * koreksi yang sama), disaring kategori PENDAPATAN_UNIT_USAHA + akun 4-1400.
 */
export async function listRiwayatPendapatanUnitUsaha(
  filter: FilterTransaksiPendapatan = {}
): Promise<RiwayatPendapatanUnitUsahaRow[]> {
  const k = KEBIJAKAN_PENDAPATAN_UNIT_USAHA;
  const semua = await listTransaksiPendapatan(filter);
  const baris = semua.filter((r) => r.kategori === k.kategoriTransaksi && r.akunKode === k.akunKode);
  if (baris.length === 0) return [];

  // Poin 5 — unit usaha asal dibaca dari kolom referensi (bukan dari teks).
  const db = await getDb();
  const unitPerBaris = new Map<string, { unitUsahaId: string | null; namaUnitUsaha: string | null }>();
  for (const tabel of ['kas_transaksi', 'bank_transaksi'] as const) {
    const rows = await db.getAllAsync<{ id: string; unit_usaha_id: string | null; nama_usaha: string | null }>(
      `SELECT t.id, t.unit_usaha_id, u.nama_usaha
         FROM ${tabel} t LEFT JOIN koperasi_unit_usaha u ON u.id = t.unit_usaha_id
        WHERE t.kategori = ?`,
      k.kategoriTransaksi
    );
    for (const r of rows) {
      unitPerBaris.set(`${tabel === 'bank_transaksi' ? 'BANK' : 'KAS'}:${r.id}`, {
        unitUsahaId: r.unit_usaha_id ?? null,
        namaUnitUsaha: r.nama_usaha ?? null,
      });
    }
  }
  return baris.map((r) => {
    const u = unitPerBaris.get(`${r.jenis === 'BANK' ? 'BANK' : 'KAS'}:${r.id}`);
    return { ...r, unitUsahaId: u?.unitUsahaId ?? null, namaUnitUsaha: u?.namaUnitUsaha ?? null };
  });
}
