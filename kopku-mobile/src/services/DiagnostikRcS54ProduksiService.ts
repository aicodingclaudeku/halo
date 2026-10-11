import * as SQLite from 'expo-sqlite';
import { diagnosaHistoriRAK } from '@/services/RAKDiagnosticService';
import { diagnosaHistoriPelepasanPropertiInvestasi } from '@/services/PelepasanInvestasiDiagnostic';
import { diagnosaPenyajianCoaItem14 } from '@/services/CoaResolutionService';
import { diagnosaCashFlowBagianShu } from '@/services/CashFlowBagianShuDiagnostic';
import { diagnosaUrutanKejadianBungaUtang } from '@/services/UtangBungaOrderingDiagnostic';
import { diagnosaHistoriPelepasanAsetTetap } from '@/services/PelepasanAsetTetapService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * RC-S54 TAHAP 16 — GAP 2: ENTRYPOINT DIAGNOSTIK DATA PRODUKSI. READ-ONLY.
 *
 * Satu pemanggilan di perangkat: `diagnosaRcS54Produksi(await getDb())`, lalu
 * `eksporDiagnostikRcS54Json(hasil)` untuk dikirim tanpa dump basis data mentah
 * (hanya ID, nomor, kode, nilai terkait). Menggabungkan seluruh diagnostik RC-S54 dan
 * menormalkannya ke satu bentuk temuan. Kegagalan satu diagnostik tidak menghentikan
 * yang lain: dicatat sebagai temuan `DIAGNOSTIK_GAGAL` (tidak ada kegagalan tersembunyi).
 * Tidak ada INSERT/UPDATE/DELETE, perubahan status, maupun jurnal.
 */

export type AreaDiagnostikRcS54 = 'RAK' | 'INVESTASI' | 'COA' | 'CASH_FLOW_BAGIAN_SHU' | 'UTANG_BUNGA' | 'ASET_TETAP';
export type SeverityTemuan = 'TINGGI' | 'SEDANG' | 'RENDAH' | 'INFO';
export type TindakanKoreksiTemuan = 'MANUAL_REVIEW' | 'PRESENTASI_OTOMATIS' | 'KOREKSI_TERKONTROL' | 'TIDAK_PERLU';

export interface TemuanProduksiRcS54 {
  readonly area: AreaDiagnostikRcS54;
  readonly kode: string;
  readonly severity: SeverityTemuan;
  readonly periode: string | null;
  readonly transaksiId: string | null;
  readonly nomorTransaksi: string | null;
  readonly saldo: number | null;
  readonly koreksiDeterministik: boolean;
  readonly tindakanKoreksi: TindakanKoreksiTemuan;
  readonly keterangan: string;
}

export interface HasilDiagnostikRcS54Produksi {
  readonly versi: 'RC-S54-T16';
  readonly tanggalLaporan: string;
  readonly dibuatPada: string;
  readonly ringkasan: {
    readonly jumlahTemuan: number;
    readonly perArea: Readonly<Record<AreaDiagnostikRcS54, number>>;
    readonly perKode: Readonly<Record<string, number>>;
    readonly perSeverity: Readonly<Record<SeverityTemuan, number>>;
    readonly periodeTerdampak: readonly string[];
    readonly jumlahManualReview: number;
    readonly jumlahKoreksiDeterministik: number;
  };
  readonly temuan: readonly TemuanProduksiRcS54[];
}

interface Kueri {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

const SEVERITY_RAK: Record<string, SeverityTemuan> = {
  GAP: 'TINGGI', DUPLICATE_REVERSAL: 'TINGGI', MISSING_SOURCE: 'TINGGI', ORPHAN_REVERSAL: 'TINGGI',
  OUTSTANDING_MISMATCH: 'TINGGI', JOURNAL_MISMATCH: 'TINGGI', PERIOD_MISMATCH: 'SEDANG', HISTORICAL_GAP: 'SEDANG',
};

export async function diagnosaRcS54Produksi(db: SQLite.SQLiteDatabase, opsi: { tanggal?: string } = {}): Promise<HasilDiagnostikRcS54Produksi> {
  const tanggal = opsi.tanggal ?? getTanggalLokalHariIni();
  const q = db as unknown as Kueri;
  const periodeJurnal = async (journalId: string | null): Promise<string | null> =>
    journalId ? ((await q.getFirstAsync<{ t: string }>(`SELECT substr(tanggal,1,7) AS t FROM journal WHERE id = ?`, journalId))?.t ?? null) : null;
  const temuan: TemuanProduksiRcS54[] = [];
  const jalankan = async (area: AreaDiagnostikRcS54, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      temuan.push({
        area, kode: 'DIAGNOSTIK_GAGAL', severity: 'TINGGI', periode: null, transaksiId: null, nomorTransaksi: null, saldo: null,
        koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await jalankan('RAK', async () => {
    const h = await diagnosaHistoriRAK(db);
    const semua = [...h.baris.flatMap((b) => b.temuan.map((t) => ({ t, jumlah: b.jumlah }))), ...h.temuanJurnal.map((t) => ({ t, jumlah: null as number | null }))];
    for (const { t, jumlah } of semua) {
      temuan.push({
        area: 'RAK', kode: t.kode, severity: SEVERITY_RAK[t.kode] ?? 'SEDANG', periode: await periodeJurnal(t.journalId),
        transaksiId: t.rakId ?? t.journalId, nomorTransaksi: t.nomorRak, saldo: jumlah,
        // Belum ada aturan koreksi RAK yang disetujui: fakta boleh pasti, koreksinya tetap manual.
        koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: t.detail,
      });
    }
  });

  await jalankan('INVESTASI', async () => {
    const h = await diagnosaHistoriPelepasanPropertiInvestasi(db);
    for (const b of h.baris) {
      for (const t of b.temuan) {
        temuan.push({
          area: 'INVESTASI', kode: t.kode, severity: t.kode === 'JOURNAL_MISMATCH' || t.kode.startsWith('ASET_DILEPAS') || t.kode === 'CARRYING_AMOUNT_MISMATCH' ? 'TINGGI' : 'SEDANG',
          periode: await periodeJurnal(b.journalPelepasanId), transaksiId: b.investasiId, nomorTransaksi: b.nomorInvestasi, saldo: t.nilai,
          koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: t.keterangan,
        });
      }
    }
  });

  await jalankan('COA', async () => {
    for (const t of await diagnosaPenyajianCoaItem14(db, tanggal)) {
      temuan.push({
        area: 'COA', kode: t.kode, severity: 'INFO', periode: t.tanggalAkhir ? t.tanggalAkhir.slice(0, 7) : null,
        transaksiId: null, nomorTransaksi: t.akun, saldo: t.saldo, koreksiDeterministik: t.koreksiDeterministik,
        tindakanKoreksi: t.koreksiDeterministik ? 'PRESENTASI_OTOMATIS' : 'MANUAL_REVIEW', keterangan: t.keterangan,
      });
    }
  });

  await jalankan('CASH_FLOW_BAGIAN_SHU', async () => {
    const h = await diagnosaCashFlowBagianShu(db);
    for (const t of h.temuan) {
      temuan.push({
        area: 'CASH_FLOW_BAGIAN_SHU', kode: t.kode, severity: t.kode === 'KLASIFIKASI_BELUM_TERDAFTAR' ? 'TINGGI' : 'SEDANG',
        periode: t.tanggal ? t.tanggal.slice(0, 7) : null, transaksiId: t.journalId, nomorTransaksi: null, saldo: t.nilaiKas,
        koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: t.sumber,
      });
    }
  });

  await jalankan('UTANG_BUNGA', async () => {
    const h = await diagnosaUrutanKejadianBungaUtang(db);
    for (const t of h.temuan) {
      temuan.push({
        area: 'UTANG_BUNGA', kode: t.kode, severity: t.kode === 'URUTAN_AMBIGU' ? 'SEDANG' : 'INFO', periode: t.createdAt.slice(0, 7),
        transaksiId: t.utangId, nomorTransaksi: t.kejadian.map((k) => k.nomorJurnal ?? k.id).join(','), saldo: null,
        // Replay T16 membaca urutan secara deterministik; tidak ada data yang perlu ditulis.
        koreksiDeterministik: true, tindakanKoreksi: 'TIDAK_PERLU', keterangan: `${t.kejadian.length} kejadian pada created_at yang sama`,
      });
    }
    for (const utangId of h.hasilBerbedaDenganUrutanLama) {
      temuan.push({
        area: 'UTANG_BUNGA', kode: 'HASIL_REPLAY_BERBEDA_ATURAN_LAMA', severity: 'SEDANG', periode: null, transaksiId: utangId, nomorTransaksi: null, saldo: null,
        koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: 'Pembagian pembayaran yang pernah diposting dengan aturan lama perlu ditinjau.',
      });
    }
  });

  await jalankan('ASET_TETAP', async () => {
    for (const b of await diagnosaHistoriPelepasanAsetTetap(db)) {
      for (const t of b.temuan) {
        temuan.push({
          area: 'ASET_TETAP', kode: t.kode, severity: t.kode === 'DOUBLE_DISPOSAL' || t.kode === 'JOURNAL_MISMATCH' || t.kode === 'CARRYING_AMOUNT_MISMATCH' ? 'TINGGI' : 'SEDANG',
          periode: await periodeJurnal(b.journalPelepasanId), transaksiId: b.asetId, nomorTransaksi: b.nomorAset, saldo: t.nilai,
          koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW', keterangan: t.keterangan,
        });
      }
    }
  });

  const hitung = <K extends string>(kunci: (t: TemuanProduksiRcS54) => K, awal: Record<K, number>) => {
    for (const t of temuan) awal[kunci(t)] = (awal[kunci(t)] ?? 0) + 1;
    return awal;
  };
  return {
    versi: 'RC-S54-T16',
    tanggalLaporan: tanggal,
    dibuatPada: new Date().toISOString(),
    ringkasan: {
      jumlahTemuan: temuan.length,
      perArea: hitung((t) => t.area, { RAK: 0, INVESTASI: 0, COA: 0, CASH_FLOW_BAGIAN_SHU: 0, UTANG_BUNGA: 0, ASET_TETAP: 0 }),
      perKode: hitung((t) => t.kode, {} as Record<string, number>),
      perSeverity: hitung((t) => t.severity, { TINGGI: 0, SEDANG: 0, RENDAH: 0, INFO: 0 }),
      periodeTerdampak: [...new Set(temuan.map((t) => t.periode).filter((p): p is string => !!p))].sort(),
      jumlahManualReview: temuan.filter((t) => t.tindakanKoreksi === 'MANUAL_REVIEW').length,
      jumlahKoreksiDeterministik: temuan.filter((t) => t.koreksiDeterministik).length,
    },
    temuan,
  };
}

/** JSON untuk dikirim dari perangkat — hanya hasil diagnostik, tanpa isi tabel mentah. */
export function eksporDiagnostikRcS54Json(hasil: HasilDiagnostikRcS54Produksi): string {
  return JSON.stringify(hasil, null, 2);
}
