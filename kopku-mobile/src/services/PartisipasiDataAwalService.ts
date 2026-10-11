import * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';

/**
 * RC-S133.4.3 — JASA PINJAMAN YANG SUDAH DIBAYAR ANGGOTA SEBELUM CUT-OFF.
 *
 * MASALAH
 * Import data awal jalur "saldo lama" (RC-S102) sengaja TIDAK mencatat
 * angsuran yang sudah dibayar satu per satu: pinjaman lama hanya masuk
 * sebagai sisa pokok + jadwal yang belum dibayar, dan pendapatan jasa
 * tahun berjalan diisi sekaligus di Saldo Awal Akun (4-1000). Akibatnya
 * dasar pembagian SHU jasa usaha per anggota (`getBasisAnggotaSHU` —
 * jumlah `angsuran_pembayaran.porsi_jasa` dalam tahun buku) tidak memuat
 * jasa Jan–cut-off sama sekali: anggota yang rajin membayar sebelum
 * koperasi memakai aplikasi tidak mendapat bagian SHU jasa untuk periode
 * itu.
 *
 * PERBAIKAN
 * Sheet "6. Jasa Dibayar" di template data awal memuat jasa pinjaman
 * yang SUDAH DIBAYAR tiap anggota pada tahun buku berjalan sampai
 * cut-off (termasuk pinjaman yang sudah lunas sebelum cut-off, yang
 * memang tidak ada di sheet Pinjaman). Nilainya disimpan di sini dan
 * DITAMBAHKAN ke basis partisipasi usaha anggota tersebut.
 *
 *  - TIDAK menjurnal apa pun: sisi buku besarnya adalah saldo awal
 *    Pendapatan Jasa Pinjaman yang diisi pengurus. Totalnya hanya
 *    DIREKONSILIASI ke saldo awal itu (lihat `rekonsiliasiJasaDataAwal`).
 *  - Satu nilai per anggota. Import ulang MENGGANTI nilai lama (bukan
 *    menambah), jadi aman diulang; nilai 0 menghapusnya.
 *  - `tanggal` = sehari sebelum cut-off (hari terakhir pembukuan lama),
 *    sehingga jasa itu ikut tahun buku yang benar, termasuk bila cut-off
 *    jatuh tepat 1 Januari tahun berikutnya.
 *
 * PENYIMPANAN: `app_config`, satu kunci per anggota
 * (`shu.jasa_data_awal.<anggotaId>` → JSON {tanggal, jasa}). TANPA
 * tabel/kolom baru → TANPA kenaikan SCHEMA_VERSION, sehingga HP &
 * desktop versi lama tetap bisa sinkron (kunci yang tidak dikenal hanya
 * diabaikan). Bukan kunci khusus perangkat, jadi ikut tersinkron.
 */

export const PREFIX_CONFIG_JASA_DATA_AWAL = 'shu.jasa_data_awal.';

export function kunciJasaDataAwal(anggotaId: string): string {
  return `${PREFIX_CONFIG_JASA_DATA_AWAL}${anggotaId}`;
}

export interface JasaDataAwal {
  anggotaId: string;
  /** Hari terakhir pembukuan lama (sehari sebelum cut-off), YYYY-MM-DD. */
  tanggal: string;
  jasa: Rupiah;
}

/** Sehari sebelum `tanggal` (YYYY-MM-DD), dihitung di UTC supaya bebas zona waktu. */
export function hariSebelum(tanggal: string): string {
  const [y, m, d] = tanggal.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

export async function simpanJasaDataAwal(db: SQLite.SQLiteDatabase, data: JasaDataAwal): Promise<void> {
  const kunci = kunciJasaDataAwal(data.anggotaId);
  if (data.jasa <= 0) {
    await db.runAsync(`DELETE FROM app_config WHERE key = ?`, kunci);
    return;
  }
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    kunci,
    JSON.stringify({ tanggal: data.tanggal, jasa: data.jasa }),
    new Date().toISOString()
  );
}

/** Seluruh jasa data awal yang tersimpan (nilai rusak diabaikan, bukan melempar). */
export async function listJasaDataAwal(db: SQLite.SQLiteDatabase): Promise<JasaDataAwal[]> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_config WHERE key LIKE ?`,
    `${PREFIX_CONFIG_JASA_DATA_AWAL}%`
  );
  const hasil: JasaDataAwal[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as { tanggal?: unknown; jasa?: unknown };
      const jasa = Math.round(Number(v.jasa));
      if (typeof v.tanggal !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.tanggal) || !Number.isFinite(jasa) || jasa <= 0) continue;
      hasil.push({ anggotaId: r.key.slice(PREFIX_CONFIG_JASA_DATA_AWAL.length), tanggal: v.tanggal, jasa });
    } catch {
      // nilai rusak: diabaikan
    }
  }
  return hasil;
}

/** Peta anggotaId → jasa data awal yang tanggalnya jatuh dalam periode. */
export async function jasaDataAwalDalamPeriode(
  db: SQLite.SQLiteDatabase,
  periodeMulai: string,
  periodeSelesai: string
): Promise<Map<string, Rupiah>> {
  const peta = new Map<string, Rupiah>();
  for (const j of await listJasaDataAwal(db)) {
    if (j.tanggal >= periodeMulai && j.tanggal <= periodeSelesai) peta.set(j.anggotaId, (peta.get(j.anggotaId) ?? 0) + j.jasa);
  }
  return peta;
}

export interface RekonsiliasiJasaDataAwal {
  /** Jumlah anggota yang punya jasa data awal (seluruhnya, bukan hanya import ini). */
  jumlahAnggota: number;
  /** Total jasa data awal tersimpan. */
  totalJasa: Rupiah;
  /** Saldo awal akun Pendapatan Jasa Pinjaman; null bila belum diisi. */
  saldoAwalPendapatanJasa: Rupiah | null;
  /** saldoAwal − totalJasa; null bila saldo awal belum diisi. */
  selisih: Rupiah | null;
  pesan: string;
}

/**
 * Bandingkan total jasa data awal dengan saldo awal akun Pendapatan Jasa
 * Pinjaman (pemetaan `ANGSURAN_JASA / KREDIT_PENDAPATAN`). Hanya
 * informasi — selisih wajar bila sebagian pendapatan jasa diterima dari
 * bukan anggota atau dicatat di akun lain.
 */
export async function rekonsiliasiJasaDataAwal(db: SQLite.SQLiteDatabase): Promise<RekonsiliasiJasaDataAwal> {
  const semua = await listJasaDataAwal(db);
  const totalJasa = semua.reduce((t, j) => t + j.jasa, 0);
  let saldoAwalPendapatanJasa: Rupiah | null = null;
  const map = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping WHERE transaction_type = 'ANGSURAN_JASA' AND role = 'KREDIT_PENDAPATAN'`
  );
  if (map) {
    const row = await db.getFirstAsync<{ saldo: number }>(`SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`, map.account_id);
    if (row) saldoAwalPendapatanJasa = Number(row.saldo);
  }
  const selisih = saldoAwalPendapatanJasa === null ? null : saldoAwalPendapatanJasa - totalJasa;
  const rp = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
  let pesan: string;
  if (saldoAwalPendapatanJasa === null) {
    pesan = `Total jasa dibayar anggota ${rp(totalJasa)}. Saldo awal Pendapatan Jasa Pinjaman belum diisi — isi di menu Saldo Awal agar Laporan Hasil Usaha memuat pendapatan jasa sebelum cut-off.`;
  } else if (selisih === 0) {
    pesan = `Total jasa dibayar anggota ${rp(totalJasa)} sama dengan saldo awal Pendapatan Jasa Pinjaman.`;
  } else {
    pesan = `Total jasa dibayar anggota ${rp(totalJasa)}, saldo awal Pendapatan Jasa Pinjaman ${rp(saldoAwalPendapatanJasa)} (selisih ${rp(
      Math.abs(selisih as number)
    )}). Periksa kembali bila seluruh pendapatan jasa berasal dari angsuran anggota.`;
  }
  return { jumlahAnggota: semua.length, totalJasa, saldoAwalPendapatanJasa, selisih, pesan };
}
