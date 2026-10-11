import * as SQLite from 'expo-sqlite';
import {
  KejadianBungaUtang,
  hitungReplayDariKejadian,
  muatKejadianBungaUtang,
} from '@/services/UtangService';

/**
 * RC-S54 TAHAP 16 — ITEM #13-A: DIAGNOSTIK URUTAN KEJADIAN BUNGA UTANG. READ-ONLY.
 *
 * Melaporkan kelompok kejadian (akrual / pembayaran) satu utang yang
 * `created_at`-nya identik:
 *  - TIMESTAMP_DUPLIKAT : seluruh anggota kelompok punya nomor jurnal dari
 *    counter yang sama, sehingga urutan pencatatan dapat dipastikan dari
 *    nomor urut jurnal (terurai tanpa asumsi);
 *  - URUTAN_AMBIGU      : urutan hanya dapat ditentukan lewat tanggal efektif,
 *    jenis, atau id (counter berbeda / pembayaran warisan tanpa jurnal).
 * `hasilBerbedaDenganUrutanLama` membandingkan hasil replay dengan aturan lama
 * (created_at lalu "akrual dulu") — menunjukkan pembayaran mana yang dahulu
 * dapat terbaca berbeda. Tidak ada INSERT/UPDATE/DELETE di berkas ini.
 */

export type KodeUrutanBungaUtang = 'TIMESTAMP_DUPLIKAT' | 'URUTAN_AMBIGU';

export interface TemuanUrutanBungaUtang {
  readonly utangId: string;
  readonly kode: KodeUrutanBungaUtang;
  readonly createdAt: string;
  readonly kejadian: readonly { jenis: KejadianBungaUtang['jenis']; id: string; tanggal: string; nomorJurnal: string | null }[];
}

export interface DiagnostikUrutanBungaUtang {
  readonly temuan: readonly TemuanUrutanBungaUtang[];
  /** Utang yang hasil replay-nya berbeda bila dibaca dengan aturan urut lama. */
  readonly hasilBerbedaDenganUrutanLama: readonly string[];
}

function urutanLama(x: KejadianBungaUtang, y: KejadianBungaUtang): number {
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
  return (x.jenis === 'AKRUAL' ? 0 : 1) - (y.jenis === 'AKRUAL' ? 0 : 1);
}

const prefixNomor = (n: string | null): string | null => {
  const m = n ? /^(.*)-(\d+)$/.exec(n) : null;
  return m ? m[1] : null;
};

export async function diagnosaUrutanKejadianBungaUtang(db: SQLite.SQLiteDatabase): Promise<DiagnostikUrutanBungaUtang> {
  const utang = await db.getAllAsync<{ id: string }>(`SELECT id FROM utang ORDER BY id`);
  const temuan: TemuanUrutanBungaUtang[] = [];
  const berbeda: string[] = [];
  for (const u of utang) {
    const kejadian = await muatKejadianBungaUtang(db, u.id);
    const perWaktu = new Map<string, KejadianBungaUtang[]>();
    for (const k of kejadian) perWaktu.set(k.createdAt, [...(perWaktu.get(k.createdAt) ?? []), k]);
    for (const [createdAt, grup] of perWaktu) {
      if (grup.length < 2) continue;
      const prefix = grup.map((k) => prefixNomor(k.nomorJurnal));
      const terurai = prefix.every((p) => p !== null && p === prefix[0]);
      temuan.push({
        utangId: u.id,
        kode: terurai ? 'TIMESTAMP_DUPLIKAT' : 'URUTAN_AMBIGU',
        createdAt,
        kejadian: grup.map((k) => ({ jenis: k.jenis, id: k.id, tanggal: k.tanggal, nomorJurnal: k.nomorJurnal })),
      });
    }
    const baru = hitungReplayDariKejadian(kejadian);
    const lama = hitungReplayDariKejadian([...kejadian].sort(urutanLama));
    if (JSON.stringify(baru) !== JSON.stringify(lama)) berbeda.push(u.id);
  }
  return { temuan, hasilBerbedaDenganUrutanLama: berbeda };
}
