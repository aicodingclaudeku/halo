import type * as SQLite from 'expo-sqlite';
import { apakahKunciConfigLokal, daftarTabelData, lit, q, type InfoTabel } from './SyncSchema';

/**
 * MESIN SINKRONISASI — murni SQL, dipakai identik oleh HP dan desktop.
 *
 * ATURAN (didokumentasikan juga di docs/SINKRONISASI.md):
 *
 *  A. Setiap perangkat mencatat perubahan lokalnya (per baris, berurutan)
 *     di `sync_changelog`. Kursor per pasangan:
 *       - `terima_seq` : seq perubahan MILIK PASANGAN tertinggi yang sudah
 *                        diterapkan di sini;
 *       - `kirim_seq`  : seq perubahan MILIK SENDIRI tertinggi yang sudah
 *                        dikonfirmasi diterapkan oleh pasangan.
 *  B. Penerapan perubahan pasangan SELALU atomik: satu skrip
 *     BEGIN … COMMIT yang juga memperbarui kursor. Gagal di tengah jalan =
 *     tidak ada yang berubah. Mengirim ulang paket yang sama tidak
 *     menggandakan data (seq ≤ terima_seq dilewati; penerapan berbentuk
 *     upsert per kunci primer).
 *  C. KONFLIK = baris yang sama (tabel + kunci primer) diubah di KEDUA
 *     perangkat sejak sinkron terakhir. Konflik TIDAK diselesaikan diam-
 *     diam (bukan "last writer wins"): seluruh paket ditahan dan pengguna
 *     memilih perangkat buku induk. Hal yang sama berlaku bila penerapan
 *     melanggar constraint (UNIQUE/FK/CHECK) atau jurnal menjadi tidak
 *     seimbang.
 *  D. Perubahan yang tidak bersinggungan digabung otomatis.
 */

export interface Perubahan {
  seq: number;
  tbl: string;
  pk: string;
  pk_lama: string | null;
  op: 'U' | 'D';
  data: string | null;
}

export interface BarisKonflik {
  tbl: string;
  pk: string;
  label: string;
  lokal: string | null;
  pasangan: string | null;
}

export class KonflikSinkronError extends Error {
  constructor(
    public readonly jenis: 'BARIS_SAMA' | 'INTEGRITAS' | 'PERUBAHAN_BARU',
    message: string,
    public readonly baris: BarisKonflik[] = []
  ) {
    super(message);
    this.name = 'KonflikSinkronError';
  }
}

export const BATAS_PAKET = 1500;

export function kunci(tbl: string, pk: string): string {
  return `${tbl}\u0001${pk}`;
}

export function kunciPerubahan(daftar: readonly Perubahan[]): Set<string> {
  const s = new Set<string>();
  for (const p of daftar) {
    s.add(kunci(p.tbl, p.pk));
    if (p.pk_lama) s.add(kunci(p.tbl, p.pk_lama));
  }
  return s;
}

export async function seqLokalTertinggi(db: SQLite.SQLiteDatabase): Promise<number> {
  const r = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(seq) AS m FROM sync_changelog');
  return Number(r?.m ?? 0);
}

/** Nilai `sqlite_sequence` changelog: penomoran yang tidak pernah mundur. */
export async function nomorUrutChangelog(db: SQLite.SQLiteDatabase): Promise<number> {
  const r = await db.getFirstAsync<{ seq: number | null }>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_changelog'");
  return Math.max(Number(r?.seq ?? 0), await seqLokalTertinggi(db));
}

export async function ambilPerubahanLokal(db: SQLite.SQLiteDatabase, sejakSeq: number, batas = BATAS_PAKET): Promise<Perubahan[]> {
  const rows = await db.getAllAsync<Perubahan>(
    'SELECT seq, tbl, pk, pk_lama, op, data FROM sync_changelog WHERE seq > ? ORDER BY seq LIMIT ?',
    sejakSeq,
    batas
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

export async function kunciPerubahanLokalSejak(db: SQLite.SQLiteDatabase, sejakSeq: number): Promise<Map<string, Perubahan>> {
  const rows = await db.getAllAsync<Perubahan>(
    'SELECT seq, tbl, pk, pk_lama, op, data FROM sync_changelog WHERE seq > ? ORDER BY seq',
    sejakSeq
  );
  const m = new Map<string, Perubahan>();
  for (const r of rows) {
    m.set(kunci(r.tbl, r.pk), r);
    if (r.pk_lama) m.set(kunci(r.tbl, r.pk_lama), r);
  }
  return m;
}

const KOLOM_LABEL = ['nama', 'nama_lengkap', 'nomor_jurnal', 'nomor_transaksi', 'nomor_anggota', 'nomor_pinjaman', 'nomor_aset', 'nomor_utang', 'kode', 'username', 'keterangan', 'deskripsi', 'key', 'seq_key'];

const NAMA_TABEL: Record<string, string> = {
  anggota: 'Anggota',
  journal: 'Jurnal',
  journal_entry: 'Baris jurnal',
  simpanan_transaksi: 'Transaksi simpanan',
  simpanan_berjangka: 'Simpanan berjangka',
  pinjaman: 'Pinjaman',
  angsuran_jadwal: 'Jadwal angsuran',
  angsuran_pembayaran: 'Pembayaran angsuran',
  kas_transaksi: 'Transaksi kas',
  bank_transaksi: 'Transaksi bank',
  sequence_counter: 'Penomoran dokumen',
  account: 'Akun (COA)',
  app_user: 'Pengguna',
  koperasi: 'Identitas koperasi',
  aset_tetap: 'Aset tetap',
  utang: 'Utang',
  app_config: 'Pengaturan',
};

export function labelBaris(tbl: string, data: string | null, pk: string): string {
  let ket = '';
  if (data) {
    try {
      const o = JSON.parse(data) as Record<string, unknown>;
      for (const k of KOLOM_LABEL) {
        if (o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') {
          ket = String(o[k]).slice(0, 60);
          break;
        }
      }
    } catch {
      /* abaikan */
    }
  }
  const nama = NAMA_TABEL[tbl] ?? tbl;
  return ket ? `${nama} — ${ket}` : `${nama} (${pk.slice(0, 40)})`;
}

export function cariKonflik(lokal: Map<string, Perubahan>, masuk: readonly Perubahan[]): BarisKonflik[] {
  const hasil: BarisKonflik[] = [];
  const sudah = new Set<string>();
  for (const p of masuk) {
    for (const k of [kunci(p.tbl, p.pk), p.pk_lama ? kunci(p.tbl, p.pk_lama) : null]) {
      if (!k || sudah.has(k)) continue;
      const l = lokal.get(k);
      if (!l) continue;
      sudah.add(k);
      hasil.push({
        tbl: p.tbl,
        pk: p.pk,
        label: labelBaris(p.tbl, p.data ?? l.data, p.pk),
        lokal: l.op === 'D' ? null : l.data,
        pasangan: p.op === 'D' ? null : p.data,
      });
    }
  }
  return hasil;
}

function nilaiPk(pkJson: string): unknown[] {
  const v = JSON.parse(pkJson);
  if (!Array.isArray(v)) throw new Error('Kunci primer paket sinkron tidak valid.');
  return v;
}

function syaratPk(t: InfoTabel, pkJson: string): string {
  const nilai = nilaiPk(pkJson);
  if (nilai.length !== t.pk.length) throw new Error(`Kunci primer ${t.nama} tidak cocok dengan skema.`);
  return t.pk.map((k, i) => `${q(k)} = ${lit(nilai[i])}`).join(' AND ');
}

/** SQL untuk SATU perubahan pasangan. Nilai diambil SQLite dari JSON (tipe tetap persis). */
export function sqlPerubahan(t: InfoTabel, p: Perubahan): string[] {
  if (t.nama === 'app_config') {
    const kunciCfg = String(nilaiPk(p.pk)[0] ?? '');
    if (apakahKunciConfigLokal(kunciCfg)) return [];
  }
  if (p.op === 'D') return [`DELETE FROM ${q(t.nama)} WHERE ${syaratPk(t, p.pk)};`];
  if (!p.data) throw new Error('Paket sinkron rusak: perubahan tanpa data.');
  const obj = JSON.parse(p.data) as Record<string, unknown>;
  const kolomData = Object.keys(obj);
  const asing = kolomData.filter((k) => !t.kolom.includes(k));
  if (asing.length > 0) {
    throw new Error(`Skema berbeda: kolom ${t.nama}.${asing.join(', ')} tidak dikenal perangkat ini. Samakan versi aplikasi.`);
  }
  const out: string[] = [];
  if (p.pk_lama && p.pk_lama !== p.pk) {
    const baru = nilaiPk(p.pk);
    out.push(
      `UPDATE ${q(t.nama)} SET ${t.pk.map((k, i) => `${q(k)} = ${lit(baru[i])}`).join(', ')} WHERE ${syaratPk(t, p.pk_lama)};`
    );
  }
  const d = lit(p.data);
  const pilih = kolomData.map((k) => `json_extract(d, ${lit('$."' + k.replace(/"/g, '\\"') + '"')})`).join(', ');
  const nonPk = kolomData.filter((k) => !t.pk.includes(k));
  const aksi = nonPk.length > 0 ? `DO UPDATE SET ${nonPk.map((k) => `${q(k)} = excluded.${q(k)}`).join(', ')}` : 'DO NOTHING';
  out.push(
    `INSERT INTO ${q(t.nama)} (${kolomData.map(q).join(', ')}) SELECT ${pilih} FROM (SELECT ${d} AS d) WHERE 1 ON CONFLICT(${t.pk
      .map(q)
      .join(', ')}) ${aksi};`
  );
  return out;
}

export interface OpsiTerapkan {
  /** Pernyataan tambahan (pembaruan kursor dsb.) dijalankan dalam transaksi yang sama. */
  sesudah?: string[];
  /** Bila diisi: batalkan bila changelog lokal sudah bertambah melewati nilai ini (balapan). */
  seqLokalDiharapkan?: number;
  /** Periksa keseimbangan jurnal yang tersentuh sebelum COMMIT. */
  periksaJurnal?: boolean;
}

function pesanGalat(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Terapkan perubahan pasangan secara ATOMIK dalam satu pemanggilan
 * `execAsync` (satu skrip SQL). Karena seluruh skrip adalah satu
 * pemanggilan, tidak ada kode JavaScript lain yang dapat menyisip di
 * tengah transaksi — termasuk penulisan pengguna yang, bila menyisip
 * saat guard aktif, tidak akan tercatat.
 */
export async function terapkanPerubahan(db: SQLite.SQLiteDatabase, daftar: readonly Perubahan[], opsi: OpsiTerapkan = {}): Promise<void> {
  const tabel = new Map((await daftarTabelData(db)).map((t) => [t.nama, t]));
  const badan: string[] = [];
  const jurnalTersentuh = new Set<string>();
  for (const p of daftar) {
    const t = tabel.get(p.tbl);
    if (!t) throw new Error(`Skema berbeda: tabel ${p.tbl} tidak ada di perangkat ini. Samakan versi aplikasi.`);
    badan.push(...sqlPerubahan(t, p));
    if (p.tbl === 'journal') jurnalTersentuh.add(String(nilaiPk(p.pk)[0]));
    if (p.tbl === 'journal_entry' && p.data) {
      try {
        const j = (JSON.parse(p.data) as { journal_id?: string }).journal_id;
        if (j) jurnalTersentuh.add(j);
      } catch {
        /* abaikan */
      }
    }
  }

  const skrip: string[] = ['BEGIN;', 'PRAGMA defer_foreign_keys = ON;'];
  if (opsi.seqLokalDiharapkan !== undefined) {
    skrip.push(
      `INSERT INTO sync_assert (ok) SELECT CASE WHEN (SELECT IFNULL(MAX(seq), 0) FROM sync_changelog) <= ${Math.trunc(opsi.seqLokalDiharapkan)} THEN 1 ELSE NULL END;`,
      'DELETE FROM sync_assert;'
    );
  }
  skrip.push('UPDATE sync_guard SET aktif = 1 WHERE id = 1;', ...badan, 'UPDATE sync_guard SET aktif = 0 WHERE id = 1;');
  if (opsi.periksaJurnal !== false && jurnalTersentuh.size > 0 && tabel.has('journal_entry')) {
    const daftarJ = [...jurnalTersentuh].map(lit).join(', ');
    skrip.push(
      `INSERT INTO sync_assert (ok) SELECT NOT EXISTS (SELECT 1 FROM journal_entry WHERE journal_id IN (${daftarJ}) GROUP BY journal_id HAVING SUM(debit) <> SUM(kredit));`,
      'DELETE FROM sync_assert;'
    );
  }
  skrip.push(...(opsi.sesudah ?? []), 'COMMIT;');

  try {
    await db.execAsync(skrip.join('\n'));
  } catch (e) {
    const m = pesanGalat(e);
    // BEGIN gagal karena transaksi lain (milik layar/service) sedang
    // terbuka: JANGAN ROLLBACK — itu transaksi orang lain.
    if (!/within a transaction/i.test(m)) {
      await db.execAsync('ROLLBACK;').catch(() => undefined);
    }
    if (/within a transaction|database is locked|busy/i.test(m)) {
      throw new Error('SIBUK: database sedang dipakai transaksi lain. Sinkron akan dicoba lagi.');
    }
    if (/NOT NULL constraint failed: sync_assert/i.test(m)) {
      throw new KonflikSinkronError('PERUBAHAN_BARU', 'Ada perubahan baru selama sinkron; dicoba lagi.');
    }
    if (/CHECK constraint failed: ok = 1/i.test(m)) {
      throw new KonflikSinkronError('INTEGRITAS', 'Penggabungan dibatalkan: jurnal menjadi tidak seimbang.');
    }
    if (/constraint|FOREIGN KEY|UNIQUE/i.test(m)) {
      throw new KonflikSinkronError('INTEGRITAS', `Penggabungan dibatalkan karena melanggar aturan data: ${m}`);
    }
    throw e;
  }
}

export async function catatRiwayat(
  db: SQLite.SQLiteDatabase,
  arah: string,
  kirim: number,
  terima: number,
  hasil: string,
  pesan?: string
): Promise<void> {
  try {
    await db.runAsync(
      'INSERT INTO sync_riwayat (waktu, arah, jumlah_kirim, jumlah_terima, hasil, pesan) VALUES (?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      arah,
      kirim,
      terima,
      hasil,
      pesan ?? null
    );
    await db.runAsync('DELETE FROM sync_riwayat WHERE id <= (SELECT MAX(id) - 200 FROM sync_riwayat)');
  } catch {
    /* riwayat bukan bagian kritis */
  }
}

export interface Kursor {
  terima_seq: number;
  kirim_seq: number;
}

export async function bacaKursor(db: SQLite.SQLiteDatabase, peerId: string): Promise<Kursor | null> {
  const r = await db.getFirstAsync<Kursor>('SELECT terima_seq, kirim_seq FROM sync_peer WHERE peer_id = ?', peerId);
  return r ? { terima_seq: Number(r.terima_seq), kirim_seq: Number(r.kirim_seq) } : null;
}

export function sqlSetKursor(peerId: string, nama: string, k: Partial<Kursor> & { status?: string }): string[] {
  const set: string[] = [];
  if (k.terima_seq !== undefined) set.push(`terima_seq = MAX(terima_seq, ${Math.trunc(k.terima_seq)})`);
  if (k.kirim_seq !== undefined) set.push(`kirim_seq = MAX(kirim_seq, ${Math.trunc(k.kirim_seq)})`);
  set.push(`terakhir_sinkron = ${lit(new Date().toISOString())}`);
  if (k.status) set.push(`status = ${lit(k.status)}`);
  return [
    `INSERT OR IGNORE INTO sync_peer (peer_id, nama) VALUES (${lit(peerId)}, ${lit(nama)});`,
    `UPDATE sync_peer SET ${set.join(', ')} WHERE peer_id = ${lit(peerId)};`,
  ];
}

/** Buang changelog yang sudah dikonfirmasi pasangan. */
export function sqlPangkasChangelog(sampaiSeq: number): string {
  return `DELETE FROM sync_changelog WHERE seq <= ${Math.trunc(sampaiSeq)};`;
}

export async function jumlahTertunda(db: SQLite.SQLiteDatabase, peerId: string): Promise<number> {
  try {
    const k = await bacaKursor(db, peerId);
    const r = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_changelog WHERE seq > ?', k?.kirim_seq ?? 0);
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}
