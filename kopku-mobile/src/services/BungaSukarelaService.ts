import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { idAkunUtangPphBungaSimpanan } from '@/services/PajakService';
import {
  buatPenghitungPphAgregat,
  catatBuktiPotongBungaSimpananPadaDb,
  PENANDA_BUKTI_POTONG_SUKARELA as PENANDA_SUKARELA_PPH,
} from '@/services/PphPotongService';
import {
  BATAS_TARIF_BUNGA_SIMPANAN_PERSEN,
  akhirBulan,
  bulanBerikut,
  bungaSatuHari,
  hitungBungaHarian,
  type MutasiSukarela,
  type RuasSaldo,
} from '@/accounting/BungaSimpananSukarela';
import type { DataLaporanExport } from '@/export/ExportTypes';
import { newId, nextSequence } from '@/utils/id';
import { NAMA_BULAN } from '@/utils/reportPeriod';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * BUNGA HARIAN SIMPANAN SUKARELA — KEBIJAKAN, AKRUAL BULANAN, KOREKSI, AUDIT.
 * ============================================================
 * Kebijakan produk koperasi (Juklat SOM 2025 hlm. 30–31), default OFF.
 * Memakai engine existing: createJournal/reverseJournal, resolveAccountId,
 * mesin PPh bunga simpanan (pajakPolicy + PphPotongService), pola baris
 * simpanan_transaksi & koreksi yang sama dengan ShuService/SimpananService.
 *
 * ALUR
 *  1. Kebijakan: versi APPEND-ONLY (`bunga_sukarela_kebijakan`): aktif,
 *     tarif tahunan, berlaku mulai bulan. Versi baru hanya boleh berlaku
 *     mulai BULAN BERIKUTNYA (dan setelah bulan terakhir yang diakru),
 *     sehingga tarif bulan yang sudah lewat tidak pernah berubah.
 *  2. Akhir bulan M (M sudah berakhir, kebijakan M aktif): bunga harian
 *     tiap anggota = Σ saldo akhir hari × tarif ÷ 365 untuk SELURUH hari
 *     bulan M (`hitungBungaHarian`). Satu jurnal per bulan, tanggal akhir M:
 *        Dr Beban Bunga Simpanan Sukarela (5-1956)
 *           Cr Simpanan Sukarela (2-1200)                      netto
 *           Cr Utang PPh 4(2) Bunga Simpanan (2-1901)          PPh
 *     + satu baris simpanan per anggota (saldo bertambah netto) + rincian
 *     audit (tarif, jumlah hari, saldo-hari, ruas saldo harian, bruto, PPh,
 *     netto) + bukti potong PPh lewat mesin pajak existing.
 *  3. KOREKSI BULAN LALU: setiap akrual menghitung ulang bulan-bulan yang
 *     sudah diakru dengan data terkini. Transaksi bertanggal mundur,
 *     koreksi, atau pembatalan pada bulan itu menghasilkan SELISIH yang
 *     dibukukan sebagai rincian KOREKSI di akrual berikutnya (bisa positif
 *     atau negatif) — tidak ada bunga ganda, tidak ada data lama diubah.
 *  4. Idempoten: satu proses POSTED per bulan (indeks unik). Menjalankan
 *     ulang mengembalikan proses yang sama tanpa jurnal kedua.
 *  5. Batal: hanya bulan TERAKHIR yang diakru (bulan sesudahnya dihitung
 *     dari saldo yang memuat bunga ini), lewat jurnal pembalik + baris
 *     koreksi simpanan. Bulan itu lalu dapat diakru ulang.
 *
 * ATURAN DETERMINISTIK
 *  - Bunga yang dikreditkan oleh akrual bulan M bertanggal akhir M tetapi
 *    TIDAK ikut dasar bunga bulan M (mulai berbunga bulan M+1).
 *  - Anggota yang hak keluarnya sudah dibayar (keluar_anggota DIBAYAR)
 *    paling lambat akhir bulan M tidak menerima bunga bulan M maupun
 *    koreksi sesudahnya (rekening sudah ditutup). Anggota berstatus KELUAR
 *    lewat jalur lama yang saldonya nol di akhir bulan juga dilewati.
 *  - Saldo nol/negatif tidak berbunga; basis 365 juga di tahun kabisat.
 *  - PPh per anggota per masa bunga, AGREGAT LINTAS PRODUK (RC-S127):
 *    batas bebas PPh (pajakPolicy) diuji terhadap bunga sukarela + berjangka
 *    anggota yang sama pada bulan itu (`buatPenghitungPphAgregat`). Bila
 *    total melewati batas, 10% atas seluruh bruto bulan itu; potongan
 *    susulan atas bunga yang sebelumnya 0% ikut dipotong di sini (neto
 *    boleh negatif = ditarik dari saldo sukarela).
 *  - Tidak bercampur dengan simpanan berjangka (subledger & jurnal sendiri).
 */

export const SUMBER_BUNGA_SUKARELA = 'SIMPANAN_SUKARELA_BUNGA';
/** Penanda pada `pajak_potong_bunga_simpanan.simpanan_berjangka_id` untuk bukti potong bunga sukarela. */
export const PENANDA_BUKTI_POTONG_SUKARELA = PENANDA_SUKARELA_PPH;

export function labelBulan(periode: string): string {
  const [y, m] = periode.split('-');
  return `${NAMA_BULAN[Number(m) - 1] ?? m} ${y}`;
}

const bulanIni = () => getTanggalLokalHariIni().slice(0, 7);

// ------------------------------------------------------------------
// 1. Kebijakan bunga (versi)
// ------------------------------------------------------------------

export interface VersiKebijakanBunga {
  id: string;
  berlakuMulai: string;
  aktif: boolean;
  tarifPersenTahun: number;
  createdAt: string;
}

export interface DrafKebijakanBunga {
  aktif: boolean;
  tarifPersenTahun: number;
  berlakuMulai: string;
}

export async function listVersiKebijakanBunga(dbParam?: SQLite.SQLiteDatabase): Promise<VersiKebijakanBunga[]> {
  const db = dbParam ?? (await getDb());
  const rows = await db.getAllAsync<{ id: string; berlaku_mulai: string; aktif: number; tarif_persen: number; created_at: string }>(
    `SELECT id, berlaku_mulai, aktif, tarif_persen, created_at FROM bunga_sukarela_kebijakan ORDER BY berlaku_mulai, created_at`
  );
  return rows.map((r) => ({
    id: r.id,
    berlakuMulai: r.berlaku_mulai,
    aktif: r.aktif === 1,
    tarifPersenTahun: r.tarif_persen,
    createdAt: r.created_at,
  }));
}

/** Murni: versi yang berlaku untuk bulan M (null = belum pernah diatur = OFF). */
export function kebijakanUntukBulan(versi: readonly VersiKebijakanBunga[], periode: string): VersiKebijakanBunga | null {
  let hasil: VersiKebijakanBunga | null = null;
  for (const v of versi) if (v.berlakuMulai <= periode) hasil = v;
  return hasil;
}

export function validasiDrafKebijakanBunga(d: DrafKebijakanBunga, berlakuMinimum: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.berlakuMulai)) return 'Bulan mulai berlaku harus berformat YYYY-MM.';
  if (d.berlakuMulai < berlakuMinimum) return `Perubahan kebijakan berlaku paling awal ${labelBulan(berlakuMinimum)}.`;
  if (!Number.isFinite(d.tarifPersenTahun) || d.tarifPersenTahun < 0) return 'Tarif bunga tidak valid.';
  if (d.aktif && d.tarifPersenTahun <= 0) return 'Tarif bunga harus lebih dari 0% bila bunga dinyalakan.';
  if (d.tarifPersenTahun > BATAS_TARIF_BUNGA_SIMPANAN_PERSEN) {
    return `Tarif bunga simpanan paling tinggi ${BATAS_TARIF_BUNGA_SIMPANAN_PERSEN}% per tahun (Juklat SOM 2025).`;
  }
  return null;
}

/** Bulan paling awal untuk versi baru: bulan depan, dan setelah bulan terakhir yang diakru. */
export async function berlakuMinimumVersiBaru(dbParam?: SQLite.SQLiteDatabase): Promise<string> {
  const db = dbParam ?? (await getDb());
  const terakhir = await db.getFirstAsync<{ p: string | null }>(`SELECT MAX(periode) AS p FROM bunga_sukarela_proses WHERE status = 'POSTED'`);
  const bulanDepan = bulanBerikut(bulanIni());
  const setelahAkru = terakhir?.p ? bulanBerikut(terakhir.p) : bulanDepan;
  return setelahAkru > bulanDepan ? setelahAkru : bulanDepan;
}

export async function simpanVersiKebijakanBunga(userId: string, d: DrafKebijakanBunga): Promise<void> {
  await withTransaction(async (db) => {
    await requirePermission(db, userId, 'pengaturan', 'edit');
    const galat = validasiDrafKebijakanBunga(d, await berlakuMinimumVersiBaru(db));
    if (galat) throw new BungaSukarelaDitolakError(galat);
    await db.runAsync(
      `INSERT INTO bunga_sukarela_kebijakan (id, berlaku_mulai, aktif, tarif_persen, created_by, created_at) VALUES (?,?,?,?,?,?)`,
      newId(),
      d.berlakuMulai,
      d.aktif ? 1 : 0,
      d.aktif ? d.tarifPersenTahun : 0,
      userId,
      new Date().toISOString()
    );
  });
}

// ------------------------------------------------------------------
// 2. Perhitungan (hanya membaca)
// ------------------------------------------------------------------

const BARIS_SIMPANAN_SAH = `s.reversal_of_id IS NULL AND s.id NOT IN (
  SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)`;

/** Baris kredit bunga milik proses bulan X — tidak ikut dasar bunga bulan X sendiri. */
const KECUALI_KREDIT_BUNGA_BULAN = `s.id NOT IN (
  SELECT r.simpanan_transaksi_id FROM bunga_sukarela_rincian r
    JOIN bunga_sukarela_proses p ON p.id = r.proses_id
   WHERE p.periode = ? AND p.status = 'POSTED' AND r.simpanan_transaksi_id IS NOT NULL)`;

export interface BungaAnggotaBulan {
  anggotaId: string;
  nomorAnggota: string;
  namaAnggota: string;
  saldoAwal: number;
  saldoAkhir: number;
  jumlahHari: number;
  saldoHari: number;
  bruto: number;
  ruas: RuasSaldo[];
}

async function hitungBulanPadaDb(
  db: SQLite.SQLiteDatabase,
  periode: string,
  tarif: number,
  opsi: { sampaiTanggal?: string; anggotaId?: string } = {}
): Promise<BungaAnggotaBulan[]> {
  const awal = `${periode}-01`;
  const akhir = akhirBulan(periode);
  const filterAnggota = opsi.anggotaId ? 'AND s.anggota_id = ?' : '';
  const pAnggota = opsi.anggotaId ? [opsi.anggotaId] : [];
  const saldoAwalRows = await db.getAllAsync<{ anggota_id: string; total: number }>(
    `SELECT s.anggota_id, COALESCE(SUM(CASE WHEN s.tipe = 'SETOR' THEN s.nominal WHEN s.tipe = 'TARIK' THEN -s.nominal ELSE 0 END), 0) AS total
       FROM simpanan_transaksi s
      WHERE s.jenis = 'SUKARELA' AND s.tanggal < ? AND ${BARIS_SIMPANAN_SAH} ${filterAnggota}
      GROUP BY s.anggota_id`,
    awal,
    ...pAnggota
  );
  const mutasiRows = await db.getAllAsync<{ anggota_id: string; tanggal: string; tipe: string; nominal: number }>(
    `SELECT s.anggota_id, s.tanggal, s.tipe, s.nominal
       FROM simpanan_transaksi s
      WHERE s.jenis = 'SUKARELA' AND s.tanggal >= ? AND s.tanggal <= ? AND s.tipe IN ('SETOR','TARIK')
        AND ${BARIS_SIMPANAN_SAH} AND ${KECUALI_KREDIT_BUNGA_BULAN} ${filterAnggota}`,
    awal,
    akhir,
    periode,
    ...pAnggota
  );
  // Anggota yang rekeningnya sudah ditutup (hak keluar dibayar) s.d. akhir bulan.
  const tertutup = new Set<string>(
    (
      await db.getAllAsync<{ anggota_id: string }>(
        `SELECT anggota_id FROM keluar_anggota WHERE status_pengajuan = 'DIBAYAR' AND tanggal_pembayaran IS NOT NULL AND tanggal_pembayaran <= ?`,
        akhir
      )
    ).map((r) => r.anggota_id)
  );
  const anggota = await db.getAllAsync<{ id: string; nomor_anggota: string; nama_lengkap: string; status: string }>(
    `SELECT id, nomor_anggota, nama_lengkap, status FROM anggota ${opsi.anggotaId ? 'WHERE id = ?' : ''} ORDER BY nomor_anggota`,
    ...pAnggota
  );
  const saldoAwal = new Map<string, number>(saldoAwalRows.map((r) => [r.anggota_id, r.total] as const));
  const mutasi = new Map<string, MutasiSukarela[]>();
  for (const m of mutasiRows) {
    const daftar = mutasi.get(m.anggota_id) ?? [];
    daftar.push({ tanggal: m.tanggal, delta: m.tipe === 'SETOR' ? m.nominal : -m.nominal });
    mutasi.set(m.anggota_id, daftar);
  }

  const hasil: BungaAnggotaBulan[] = [];
  for (const a of anggota) {
    if (tertutup.has(a.id)) continue;
    const sa = saldoAwal.get(a.id) ?? 0;
    const mu = mutasi.get(a.id) ?? [];
    if (sa === 0 && mu.length === 0) continue;
    const h = hitungBungaHarian({ periode, saldoAwal: sa, mutasi: mu, tarifPersenTahun: tarif, sampaiTanggal: opsi.sampaiTanggal });
    // Jalur keluar lama (tanpa keluar_anggota): status KELUAR & saldo akhir nol -> rekening ditutup.
    if (a.status === 'KELUAR' && h.saldoAkhir <= 0) continue;
    hasil.push({
      anggotaId: a.id,
      nomorAnggota: a.nomor_anggota,
      namaAnggota: a.nama_lengkap,
      saldoAwal: sa,
      saldoAkhir: h.saldoAkhir,
      jumlahHari: h.jumlahHari,
      saldoHari: h.saldoHari,
      bruto: h.bunga,
      ruas: h.ruas,
    });
  }
  return hasil;
}

export interface BarisPratinjau {
  anggotaId: string;
  nomorAnggota: string;
  namaAnggota: string;
  jenis: 'BUNGA' | 'KOREKSI';
  periodeBunga: string;
  tarifPersen: number;
  jumlahHari: number;
  saldoHari: number;
  saldoAwal: number;
  saldoAkhir: number;
  bruto: number;
  pajak: number;
  netto: number;
  ruas: RuasSaldo[];
}

export interface PratinjauAkrual {
  periode: string;
  tanggal: string;
  tarifPersen: number;
  baris: BarisPratinjau[];
  totalBruto: number;
  totalPajak: number;
  totalNetto: number;
  totalKoreksiBruto: number;
}

async function susunAkrualPadaDb(db: SQLite.SQLiteDatabase, periode: string, versi: VersiKebijakanBunga[]): Promise<PratinjauAkrual> {
  const k = kebijakanUntukBulan(versi, periode);
  if (!k || !k.aktif) throw new BungaSukarelaDitolakError(`Bunga simpanan sukarela tidak aktif untuk ${labelBulan(periode)}.`);
  const baris: BarisPratinjau[] = [];
  // RC-S127 — satu penghitung untuk seluruh baris proses ini: posisi bulan
  // dibaca dari bukti potong SEMUA produk anggota, lalu dijumlah di memori.
  const pph = buatPenghitungPphAgregat(db);

  // (a) Bunga bulan berjalan proses.
  for (const b of await hitungBulanPadaDb(db, periode, k.tarifPersenTahun)) {
    if (b.bruto <= 0) continue;
    const pajak = await pph.hitung(b.anggotaId, periode, b.bruto);
    baris.push({ ...b, jenis: 'BUNGA', periodeBunga: periode, tarifPersen: k.tarifPersenTahun, pajak, netto: b.bruto - pajak });
  }

  // (b) Koreksi bulan-bulan yang sudah diakru (data terkini vs tercatat).
  const sudah = await db.getAllAsync<{ periode: string }>(
    `SELECT periode FROM bunga_sukarela_proses WHERE status = 'POSTED' AND periode < ? ORDER BY periode`,
    periode
  );
  const tutupSekarang = new Set<string>(
    (
      await db.getAllAsync<{ anggota_id: string }>(
        `SELECT anggota_id FROM keluar_anggota WHERE status_pengajuan = 'DIBAYAR' AND tanggal_pembayaran IS NOT NULL AND tanggal_pembayaran <= ?`,
        akhirBulan(periode)
      )
    ).map((r) => r.anggota_id)
  );
  for (const { periode: p } of sudah) {
    const kp = kebijakanUntukBulan(versi, p);
    if (!kp || !kp.aktif) continue;
    const tercatat = new Map<string, { anggota_id: string; bruto: number; pajak: number }>(
      (
        await db.getAllAsync<{ anggota_id: string; bruto: number; pajak: number }>(
          `SELECT r.anggota_id, SUM(r.bruto) AS bruto, SUM(r.pajak) AS pajak
             FROM bunga_sukarela_rincian r JOIN bunga_sukarela_proses pr ON pr.id = r.proses_id
            WHERE pr.status = 'POSTED' AND r.periode_bunga = ?
            GROUP BY r.anggota_id`,
          p
        )
      ).map((r) => [r.anggota_id, r] as const)
    );
    const kini = new Map((await hitungBulanPadaDb(db, p, kp.tarifPersenTahun)).map((b) => [b.anggotaId, b]));
    const semua = new Set<string>([...tercatat.keys(), ...kini.keys()]);
    for (const anggotaId of semua) {
      if (tutupSekarang.has(anggotaId)) continue;
      const t = tercatat.get(anggotaId);
      const b = kini.get(anggotaId);
      const brutoKini = b?.bruto ?? 0;
      const delta = brutoKini - (t?.bruto ?? 0);
      if (delta === 0) continue;
      // RC-S127 — selisih PPh dihitung terhadap posisi bulan p SELURUH produk:
      // PPh(total bulan sesudah koreksi) − PPh yang sudah dipotong bulan itu.
      const pajakDelta = await pph.hitung(anggotaId, p, delta);
      const identitas = b
        ? { nomor: b.nomorAnggota, nama: b.namaAnggota }
        : await db
            .getFirstAsync<{ nomor_anggota: string; nama_lengkap: string }>(`SELECT nomor_anggota, nama_lengkap FROM anggota WHERE id = ?`, anggotaId)
            .then((r) => ({ nomor: r?.nomor_anggota ?? '', nama: r?.nama_lengkap ?? '' }));
      baris.push({
        anggotaId,
        nomorAnggota: identitas.nomor,
        namaAnggota: identitas.nama,
        jenis: 'KOREKSI',
        periodeBunga: p,
        tarifPersen: kp.tarifPersenTahun,
        jumlahHari: b?.jumlahHari ?? 0,
        saldoHari: b?.saldoHari ?? 0,
        saldoAwal: b?.saldoAwal ?? 0,
        saldoAkhir: b?.saldoAkhir ?? 0,
        bruto: delta,
        pajak: pajakDelta,
        netto: delta - pajakDelta,
        ruas: b?.ruas ?? [],
      });
    }
  }

  const sum = (f: (b: BarisPratinjau) => number) => baris.reduce((t, b) => t + f(b), 0);
  return {
    periode,
    tanggal: akhirBulan(periode),
    tarifPersen: k.tarifPersenTahun,
    baris,
    totalBruto: sum((b) => b.bruto),
    totalPajak: sum((b) => b.pajak),
    totalNetto: sum((b) => b.netto),
    totalKoreksiBruto: sum((b) => (b.jenis === 'KOREKSI' ? b.bruto : 0)),
  };
}

export async function pratinjauAkrualBungaSukarela(periode: string): Promise<PratinjauAkrual> {
  const db = await getDb();
  return susunAkrualPadaDb(db, periode, await listVersiKebijakanBunga(db));
}

/** Murni: bulan aktif yang sudah SELESAI (akhir bulan < hari ini) dan belum diakru, urut naik. */
export function bulanTertunda(versi: readonly VersiKebijakanBunga[], sudahDiakru: Set<string>, hariIni: string): string[] {
  const pertama = versi.find((v) => v.aktif)?.berlakuMulai;
  if (!pertama) return [];
  const hasil: string[] = [];
  // Bulan M dianggap SELESAI hanya bila hari ini sudah melewati akhir M.
  // Pada hari terakhir bulan, bulan itu masih berjalan (transaksi hari itu
  // masih bisa masuk) sehingga belum boleh diakru.
  for (let p = pertama, i = 0; i < 600 && akhirBulan(p) < hariIni; p = bulanBerikut(p), i++) {
    if (kebijakanUntukBulan(versi, p)?.aktif && !sudahDiakru.has(p)) hasil.push(p);
  }
  return hasil;
}

// ------------------------------------------------------------------
// 3. Akrual, batal, otomatis
// ------------------------------------------------------------------

export interface ProsesAkrual {
  id: string;
  periode: string;
  tanggal: string;
  tarifPersen: number;
  jumlahAnggota: number;
  totalBruto: number;
  totalPajak: number;
  totalNetto: number;
  totalKoreksiBruto: number;
  journalId: string | null;
  status: 'POSTED' | 'DIBATALKAN';
  alasanBatal: string | null;
  createdAt: string;
}

function petakanProses(r: any): ProsesAkrual {
  return {
    id: r.id,
    periode: r.periode,
    tanggal: r.tanggal,
    tarifPersen: r.tarif_persen,
    jumlahAnggota: r.jumlah_anggota,
    totalBruto: r.total_bruto,
    totalPajak: r.total_pajak,
    totalNetto: r.total_netto,
    totalKoreksiBruto: r.total_koreksi_bruto,
    journalId: r.journal_id ?? null,
    status: r.status,
    alasanBatal: r.alasan_batal ?? null,
    createdAt: r.created_at,
  };
}

export async function listProsesAkrual(): Promise<ProsesAkrual[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM bunga_sukarela_proses ORDER BY periode DESC, created_at DESC`);
  return rows.map(petakanProses);
}

export class BungaSukarelaDitolakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BungaSukarelaDitolakError';
  }
}

/** Akrual satu bulan. Idempoten: bulan yang sudah diakru mengembalikan proses yang ada. */
export async function prosesAkrualBungaSukarela(userId: string, periode: string): Promise<ProsesAkrual> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'simpanan', 'create');
    const ada = await db.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_proses WHERE periode = ? AND status = 'POSTED'`, periode);
    if (ada) return petakanProses(ada);

    const versi = await listVersiKebijakanBunga(db);
    const tanggal = akhirBulan(periode);
    if (tanggal >= getTanggalLokalHariIni()) {
      throw new BungaSukarelaDitolakError(`${labelBulan(periode)} belum selesai. Bunga diakru setelah bulan berakhir.`);
    }
    const sudah = new Set<string>(
      (await db.getAllAsync<{ periode: string }>(`SELECT periode FROM bunga_sukarela_proses WHERE status = 'POSTED'`)).map((r) => r.periode)
    );
    const belum = bulanTertunda(versi, sudah, getTanggalLokalHariIni()).filter((p) => p < periode);
    if (belum.length > 0) throw new BungaSukarelaDitolakError(`Akru dulu bunga ${labelBulan(belum[0])}.`);

    const hasil = await susunAkrualPadaDb(db, periode, versi);
    const prosesId = newId();
    const now = new Date().toISOString();
    let journalId: string | null = null;

    // Baris jurnal KOTOR per arah (bunga & koreksi positif terpisah dari
    // koreksi negatif) — tetap benar walau koreksi antar-anggota saling
    // meniadakan, dan lebih jelas untuk audit.
    const positif = (f: (x: BarisPratinjau) => number) => hasil.baris.reduce((t, x) => t + Math.max(0, f(x)), 0);
    const negatif = (f: (x: BarisPratinjau) => number) => hasil.baris.reduce((t, x) => t + Math.max(0, -f(x)), 0);
    const adaMutasi = hasil.baris.some((x) => x.bruto !== 0 || x.pajak !== 0 || x.netto !== 0);
    if (adaMutasi) {
      const akunBeban = await resolveAccountId(db, SUMBER_BUNGA_SUKARELA, 'DEBIT_BEBAN');
      const akunSukarela = await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT');
      const lines: { accountId: string; debit: number; kredit: number }[] = [];
      const garis = (accountId: string, debit: number, kredit: number) => {
        if (debit > 0) lines.push({ accountId, debit, kredit: 0 });
        if (kredit > 0) lines.push({ accountId, debit: 0, kredit });
      };
      garis(akunBeban, positif((x) => x.bruto), negatif((x) => x.bruto));
      garis(akunSukarela, negatif((x) => x.netto), positif((x) => x.netto));
      if (hasil.baris.some((x) => x.pajak !== 0)) {
        garis(await idAkunUtangPphBungaSimpanan(db), negatif((x) => x.pajak), positif((x) => x.pajak));
      }
      const nomorReferensi = await nextSequence(db, 'BNG-SKR', Number(periode.slice(0, 4)));
      ({ journalId } = await createJournal(db, {
        tanggal,
        sumberTransaksi: 'SIMPANAN_SUKARELA_BUNGA',
        sumberId: prosesId,
        nomorReferensi,
        deskripsi: `Akrual bunga simpanan sukarela ${labelBulan(periode)} - ${nomorReferensi}`,
        createdBy: userId,
        lines,
      }));
    }

    await db.runAsync(
      `INSERT INTO bunga_sukarela_proses
        (id, periode, tanggal, tarif_persen, jumlah_anggota, total_bruto, total_pajak, total_netto, total_koreksi_bruto,
         journal_id, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'POSTED',?,?)`,
      prosesId,
      periode,
      tanggal,
      hasil.tarifPersen,
      new Set(hasil.baris.map((b) => b.anggotaId)).size,
      hasil.totalBruto,
      hasil.totalPajak,
      hasil.totalNetto,
      hasil.totalKoreksiBruto,
      journalId,
      userId,
      now
    );

    for (const b of hasil.baris) {
      let simpananId: string | null = null;
      if (b.netto !== 0 && journalId) {
        simpananId = newId();
        const nomorTransaksi = await nextSequence(db, 'BUNGA-SKR', Number(periode.slice(0, 4)));
        const ket =
          b.jenis === 'BUNGA'
            ? `Bunga simpanan ${labelBulan(b.periodeBunga)}${b.pajak > 0 ? ` (bruto ${b.bruto}, PPh ${b.pajak})` : ''}`
            : `Koreksi bunga simpanan ${labelBulan(b.periodeBunga)} (selisih bruto ${b.bruto}, PPh ${b.pajak})`;
        await db.runAsync(
          `INSERT INTO simpanan_transaksi
            (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, keterangan, journal_id, created_by, created_at)
           VALUES (?,?,'SUKARELA',?,?,?,'KAS',?,?,?,?,?)`,
          simpananId,
          b.anggotaId,
          b.netto > 0 ? 'SETOR' : 'TARIK',
          tanggal,
          Math.abs(b.netto),
          nomorTransaksi,
          ket,
          journalId,
          userId,
          now
        );
      }
      const rincianId = newId();
      await db.runAsync(
        `INSERT INTO bunga_sukarela_rincian
          (id, proses_id, anggota_id, periode_bunga, jenis, tarif_persen, jumlah_hari, saldo_hari, saldo_awal, saldo_akhir,
           bruto, pajak, netto, ruas_saldo, simpanan_transaksi_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        rincianId,
        prosesId,
        b.anggotaId,
        b.periodeBunga,
        b.jenis,
        b.tarifPersen,
        b.jumlahHari,
        b.saldoHari,
        b.saldoAwal,
        b.saldoAkhir,
        b.bruto,
        b.pajak,
        b.netto,
        JSON.stringify(b.ruas),
        simpananId,
        now
      );
      if (journalId) {
        // Bukti potong PPh 4(2) lewat mesin pajak existing (termasuk tarif 0%).
        await catatBuktiPotongBungaSimpananPadaDb(db, {
          simpananBerjangkaId: PENANDA_BUKTI_POTONG_SUKARELA,
          anggotaId: b.anggotaId,
          journalId,
          peristiwa: 'TRANSFER_SUKARELA',
          tanggal,
          createdBy: userId,
          hasil: {
            totalBruto: b.bruto,
            totalPajak: b.pajak,
            totalNetto: b.netto,
            perPeriode: [{ bungaPeriodeId: rincianId, nomorPeriode: 0, masaPajak: b.periodeBunga, bruto: b.bruto, pajak: b.pajak, netto: b.netto }],
          },
        });
      }
    }

    return petakanProses(await db.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_proses WHERE id = ?`, prosesId));
  });
}

/** Batalkan akrual bulan TERAKHIR: jurnal pembalik + koreksi baris simpanan. */
export async function batalkanAkrualBungaSukarela(userId: string, periode: string, alasan: string): Promise<void> {
  const alasanBersih = alasan.trim();
  if (!alasanBersih) throw new BungaSukarelaDitolakError('Alasan pembatalan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, userId, 'simpanan', 'edit');
    const proses = await db.getFirstAsync<any>(`SELECT * FROM bunga_sukarela_proses WHERE periode = ? AND status = 'POSTED'`, periode);
    if (!proses) throw new BungaSukarelaDitolakError(`Tidak ada akrual bunga ${labelBulan(periode)}.`);
    const lebihBaru = await db.getFirstAsync<{ periode: string }>(
      `SELECT periode FROM bunga_sukarela_proses WHERE status = 'POSTED' AND periode > ? ORDER BY periode LIMIT 1`,
      periode
    );
    if (lebihBaru) {
      throw new BungaSukarelaDitolakError(`Batalkan dulu akrual ${labelBulan(lebihBaru.periode)} — pembatalan dilakukan dari bulan terakhir.`);
    }
    if (proses.journal_id) {
      await reverseJournal(db, proses.journal_id, userId, `Pembatalan akrual bunga simpanan sukarela ${labelBulan(periode)}: ${alasanBersih}`);
    }
    const now = new Date().toISOString();
    const rows = await db.getAllAsync<{ simpanan_transaksi_id: string | null }>(
      `SELECT simpanan_transaksi_id FROM bunga_sukarela_rincian WHERE proses_id = ? AND simpanan_transaksi_id IS NOT NULL`,
      proses.id
    );
    for (const r of rows) {
      const asli = await db.getFirstAsync<any>(`SELECT * FROM simpanan_transaksi WHERE id = ?`, r.simpanan_transaksi_id);
      if (!asli) continue;
      await db.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, bank_account_id, nomor_transaksi, keterangan, reversal_of_id, created_by, created_at)
         VALUES (?,?,?,'KOREKSI',?,?,?,?,?,?,?,?,?)`,
        newId(),
        asli.anggota_id,
        asli.jenis,
        now.slice(0, 10),
        asli.nominal,
        asli.sumber_dana,
        asli.bank_account_id ?? null,
        `KOREKSI-${asli.nomor_transaksi}`,
        alasanBersih,
        asli.id,
        userId,
        now
      );
    }
    await db.runAsync(
      `UPDATE bunga_sukarela_proses SET status = 'DIBATALKAN', alasan_batal = ?, dibatalkan_at = ? WHERE id = ?`,
      alasanBersih,
      now,
      proses.id
    );
  });
}

export interface HasilOtomatisBungaSukarela {
  diproses: string[];
  berhentiDi: string | null;
  pesan: string | null;
}

let hasilOtomatisTerakhir: HasilOtomatisBungaSukarela | null = null;
export function getHasilAkrualOtomatisTerakhir(): HasilOtomatisBungaSukarela | null {
  return hasilOtomatisTerakhir;
}

/** Akrual otomatis bulan-bulan yang sudah berakhir (StartupTasks). Tidak pernah melempar. */
export async function jalankanAkrualBungaSukarelaOtomatis(userId: string): Promise<HasilOtomatisBungaSukarela> {
  const hasil: HasilOtomatisBungaSukarela = { diproses: [], berhentiDi: null, pesan: null };
  try {
    const db = await getDb();
    const versi = await listVersiKebijakanBunga(db);
    if (!versi.some((v) => v.aktif)) return (hasilOtomatisTerakhir = hasil);
    const sudah = new Set<string>(
      (await db.getAllAsync<{ periode: string }>(`SELECT periode FROM bunga_sukarela_proses WHERE status = 'POSTED'`)).map((r) => r.periode)
    );
    for (const p of bulanTertunda(versi, sudah, getTanggalLokalHariIni())) {
      try {
        await prosesAkrualBungaSukarela(userId, p);
        hasil.diproses.push(p);
      } catch (e) {
        hasil.berhentiDi = p;
        hasil.pesan = e instanceof Error ? e.message : 'Akrual bunga gagal.';
        break;
      }
    }
  } catch (e) {
    hasil.pesan = e instanceof Error ? e.message : 'Akrual bunga gagal.';
  }
  hasilOtomatisTerakhir = hasil;
  return hasil;
}

// ------------------------------------------------------------------
// 4. Detail anggota & laporan (hanya membaca)
// ------------------------------------------------------------------

export interface RingkasanBungaAnggota {
  aktifBulanIni: boolean;
  tarifBulanIni: number;
  saldoSukarela: number;
  /** Bunga satu hari dari saldo akhir hari ini (pecahan rupiah). */
  bungaHariIni: number;
  /** Perkiraan bunga bulan berjalan s.d. hari ini — BELUM dibukukan. */
  bungaBerjalan: number;
  /** Bunga bruto yang sudah diakru tahun ini (termasuk koreksi). */
  bungaDiakruTahunIni: number;
  /** Total bunga neto yang sudah masuk saldo sejak awal. */
  totalBungaMasukSaldo: number;
  totalPphDipotong: number;
}

export async function getRingkasanBungaAnggota(anggotaId: string): Promise<RingkasanBungaAnggota> {
  const db = await getDb();
  const hariIni = getTanggalLokalHariIni();
  const periode = hariIni.slice(0, 7);
  const versi = await listVersiKebijakanBunga(db);
  const k = kebijakanUntukBulan(versi, periode);
  const aktif = !!k?.aktif;
  const tarif = aktif ? k!.tarifPersenTahun : 0;
  const saldoRow = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN s.tipe = 'SETOR' THEN s.nominal WHEN s.tipe = 'TARIK' THEN -s.nominal ELSE 0 END), 0) AS total
       FROM simpanan_transaksi s WHERE s.anggota_id = ? AND s.jenis = 'SUKARELA' AND s.tanggal <= ? AND ${BARIS_SIMPANAN_SAH}`,
    anggotaId,
    hariIni
  );
  const saldo = saldoRow?.total ?? 0;
  const berjalan = aktif ? (await hitungBulanPadaDb(db, periode, tarif, { sampaiTanggal: hariIni, anggotaId }))[0] : undefined;
  const agregat = await db.getFirstAsync<{ diakru: number; netto: number; pajak: number }>(
    `SELECT COALESCE(SUM(CASE WHEN substr(r.periode_bunga,1,4) = ? THEN r.bruto ELSE 0 END),0) AS diakru,
            COALESCE(SUM(r.netto),0) AS netto, COALESCE(SUM(r.pajak),0) AS pajak
       FROM bunga_sukarela_rincian r JOIN bunga_sukarela_proses p ON p.id = r.proses_id
      WHERE p.status = 'POSTED' AND r.anggota_id = ?`,
    periode.slice(0, 4),
    anggotaId
  );
  return {
    aktifBulanIni: aktif,
    tarifBulanIni: tarif,
    saldoSukarela: saldo,
    bungaHariIni: bungaSatuHari(saldo, tarif),
    bungaBerjalan: berjalan ? (berjalan.saldoHari * tarif) / 100 / 365 : 0,
    bungaDiakruTahunIni: agregat?.diakru ?? 0,
    totalBungaMasukSaldo: agregat?.netto ?? 0,
    totalPphDipotong: agregat?.pajak ?? 0,
  };
}

export interface RincianProsesBaris {
  nomorAnggota: string;
  namaAnggota: string;
  jenis: 'BUNGA' | 'KOREKSI';
  periodeBunga: string;
  tarifPersen: number;
  jumlahHari: number;
  saldoHari: number;
  bruto: number;
  pajak: number;
  netto: number;
  ruas: RuasSaldo[];
}

export async function listRincianProsesAkrual(prosesId: string): Promise<RincianProsesBaris[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT a.nomor_anggota, a.nama_lengkap, r.jenis, r.periode_bunga, r.tarif_persen, r.jumlah_hari, r.saldo_hari,
            r.bruto, r.pajak, r.netto, r.ruas_saldo
       FROM bunga_sukarela_rincian r JOIN anggota a ON a.id = r.anggota_id
      WHERE r.proses_id = ? ORDER BY r.jenis, a.nomor_anggota, r.periode_bunga`,
    prosesId
  );
  return rows.map((r) => ({
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    jenis: r.jenis,
    periodeBunga: r.periode_bunga,
    tarifPersen: r.tarif_persen,
    jumlahHari: r.jumlah_hari,
    saldoHari: r.saldo_hari,
    bruto: r.bruto,
    pajak: r.pajak,
    netto: r.netto,
    ruas: JSON.parse(r.ruas_saldo || '[]'),
  }));
}

/** Data laporan (PDF/Excel/CSV) rincian satu akrual — dipakai tombol Export. */
export function buildRincianAkrualExport(
  info: { namaKoperasi: string; alamatKoperasi?: string },
  proses: ProsesAkrual,
  rincian: readonly RincianProsesBaris[]
): DataLaporanExport {
  return {
    judulLaporan: 'Rincian Bunga Simpanan Sukarela',
    namaFileDasar: `bunga-simpanan-sukarela-${proses.periode}`,
    namaKoperasi: info.namaKoperasi,
    alamatKoperasi: info.alamatKoperasi,
    periodeLabel: `Akrual ${labelBulan(proses.periode)} · tarif ${String(proses.tarifPersen).replace('.', ',')}% per tahun · saldo harian (365 hari)`,
    kolom: ['No. Anggota', 'Nama', 'Jenis', 'Bulan Bunga', 'Hari', 'Saldo Rata-rata Harian', 'Bunga Bruto', 'PPh', 'Bunga Neto'],
    kolomAngka: [5, 6, 7, 8],
    baris: rincian.map((r) => [
      r.nomorAnggota,
      r.namaAnggota,
      r.jenis === 'BUNGA' ? 'Bunga' : 'Koreksi',
      labelBulan(r.periodeBunga),
      r.jumlahHari,
      r.jumlahHari > 0 ? Math.round(r.saldoHari / r.jumlahHari) : 0,
      r.bruto,
      r.pajak,
      r.netto,
    ]),
    ringkasan: [
      { label: 'Jumlah anggota', nilai: String(proses.jumlahAnggota) },
      { label: 'Total bunga bruto', nilai: String(proses.totalBruto) },
      { label: 'Total PPh', nilai: String(proses.totalPajak) },
      { label: 'Total bunga neto dikreditkan', nilai: String(proses.totalNetto) },
    ],
    catatanKaki: [
      'Bunga harian = saldo akhir hari × tarif tahunan ÷ 365, untuk seluruh hari kalender bulan bunga.',
      'Baris Koreksi = selisih bunga bulan lalu akibat transaksi bertanggal mundur, koreksi, atau pembatalan.',
      'PPh final bunga simpanan dihitung per anggota per masa bunga dengan mesin pajak KOPKU.',
    ],
  };
}
