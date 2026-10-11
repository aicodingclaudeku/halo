import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { sqlJadwalMasihTertagih } from '@/accounting/ScheduleLifecycle';
import { requirePermission } from '@/services/PermissionService';
import { catatDataAwalSimpananDb } from '@/services/SimpananService';
import { bayarAngsuranDb, cairkanPinjamanDb } from '@/services/PinjamanService';
import { newId } from '@/utils/id';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import type { Rupiah } from '@/utils/money';

/**
 * RC-S133.6.2 — KOREKSI TRANSAKSI DARI HISTORY (temuan audit T-08).
 *
 * Jalur koreksi untuk tiga jenis transaksi yang sebelumnya tidak punya jalur
 * dari History Transaksi: setoran simpanan (Setor Simpanan / data awal,
 * sumber SIMPANAN_DATA_AWAL), pencairan pinjaman, dan pembayaran angsuran.
 *
 * Prinsip (keputusan pengguna "SETUJUI DENGAN AUDIT TRAIL"):
 *  - Transaksi yang sudah dibukukan TIDAK diedit dan TIDAK dihapus. Koreksi =
 *    jurnal PEMBALIK (AccountingEngine.reverseJournal — jurnal asal berstatus
 *    REVERSED, pembalik bertanggal hari ini) + (opsional) PENCATATAN ULANG
 *    dengan data yang benar lewat fungsi service yang SAMA dengan input biasa
 *    (catatDataAwalSimpanan / cairkanPinjaman / bayarAngsuran), seluruhnya
 *    dalam SATU transaksi database: gagal di langkah mana pun = tidak ada
 *    yang berubah.
 *  - Wajib alasan; izin History Transaksi (edit) DAN izin domainnya; pengguna
 *    yang mengotorisasi, ID jurnal asal, pembalik, dan pengganti tercatat di
 *    tabel koreksi_transaksi (v81) dan audit_log.
 *  - Validasi khusus bila ada transaksi lanjutan atau periode tertutup — bila
 *    koreksi bisa merusak saldo/jurnal terkait, koreksi DITOLAK dengan alasan
 *    yang jelas (gagal tertutup), bukan dikerjakan sebagian.
 */

export type JenisKoreksi = 'SETORAN_SIMPANAN' | 'PENCAIRAN_PINJAMAN' | 'ANGSURAN_PINJAMAN';

/** Sumber jurnal -> jenis koreksi khusus. */
export const SUMBER_KOREKSI: Readonly<Record<string, JenisKoreksi>> = {
  SIMPANAN_DATA_AWAL: 'SETORAN_SIMPANAN',
  PENCAIRAN_PINJAMAN: 'PENCAIRAN_PINJAMAN',
  ANGSURAN_POKOK: 'ANGSURAN_PINJAMAN',
};

export const LABEL_JENIS_KOREKSI: Readonly<Record<JenisKoreksi, string>> = {
  SETORAN_SIMPANAN: 'Setoran simpanan',
  PENCAIRAN_PINJAMAN: 'Pencairan pinjaman',
  ANGSURAN_PINJAMAN: 'Pembayaran angsuran',
};

export interface AsalSetoran {
  anggotaId: string;
  nomorAnggota: string;
  namaAnggota: string;
  tanggal: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
  nomorTransaksi: string;
  barisIds: string[];
}

export interface AsalPencairan {
  pinjamanId: string;
  nomorPinjaman: string;
  namaAnggota: string;
  tanggal: string;
  jumlahPinjaman: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
}

export interface AsalAngsuran {
  pembayaranId: string;
  pinjamanId: string;
  nomorPinjaman: string;
  namaAnggota: string;
  jadwalId: string;
  nomorAngsuran: number;
  tanggal: string;
  nominal: Rupiah;
  porsiPokok: Rupiah;
  porsiJasa: Rupiah;
  porsiDenda: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
}

export interface PemeriksaanKoreksi {
  journalId: string;
  nomorJurnal: string;
  jenis: JenisKoreksi;
  /** true = koreksi dapat dijalankan (setidaknya pembalikan tanpa pencatatan ulang). */
  boleh: boolean;
  /** Alasan penolakan (gagal tertutup). Kosong bila boleh. */
  alasanTolak: string[];
  /** Hal yang perlu diketahui pengguna, tidak menghalangi koreksi. */
  catatan: string[];
  setoran?: AsalSetoran;
  pencairan?: AsalPencairan;
  angsuran?: AsalAngsuran;
}

export interface JejakKoreksi {
  id: string;
  jenis: JenisKoreksi;
  alasan: string;
  diotorisasiOleh: string;
  namaPengotorisasi: string | null;
  createdAt: string;
  journalAsalId: string;
  nomorJurnalAsal: string | null;
  journalPembalikId: string;
  nomorJurnalPembalik: string | null;
  journalPenggantiId: string | null;
  nomorJurnalPengganti: string | null;
}

const STATUS_SHU_FINAL = ['DIAJUKAN_RAT', 'DISAHKAN_RAT', 'DIBAGIKAN'];

async function tahunBukuUntuk(db: SQLite.SQLiteDatabase, tanggal: string): Promise<number> {
  const p = await db.getFirstAsync<{ tahun_buku: number }>(
    `SELECT tahun_buku FROM accounting_period WHERE ? BETWEEN periode_mulai AND periode_selesai ORDER BY periode_mulai LIMIT 1`,
    tanggal
  );
  return p ? Number(p.tahun_buku) : Number(tanggal.slice(0, 4));
}

async function statusPeriodeTanggal(db: SQLite.SQLiteDatabase, tanggal: string): Promise<string | null> {
  const p = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM accounting_period WHERE ? BETWEEN periode_mulai AND periode_selesai ORDER BY periode_mulai LIMIT 1`,
    tanggal
  );
  return p?.status ?? null;
}

/** SHU tahun buku tanggal itu: sudah diajukan/disahkan/dibagikan -> tolak; dihitung -> catatan. */
async function periksaShu(
  db: SQLite.SQLiteDatabase,
  tanggal: string,
  dasar: string,
  tolak: string[],
  catatan: string[]
): Promise<void> {
  const tahun = await tahunBukuUntuk(db, tanggal);
  const shu = await db.getFirstAsync<{ status: string }>(`SELECT status FROM shu_konfigurasi WHERE tahun_buku = ?`, tahun);
  if (!shu) return;
  if (STATUS_SHU_FINAL.includes(shu.status)) {
    tolak.push(
      `SHU tahun buku ${tahun} sudah ${shu.status === 'DIBAGIKAN' ? 'dibagikan' : 'diajukan/disahkan RAT'}; ${dasar} tahun itu menjadi dasar pembagian SHU dan tidak boleh berubah lewat koreksi.`
    );
  } else if (shu.status === 'DIHITUNG') {
    catatan.push(`SHU tahun buku ${tahun} sudah dihitung — hitung ulang SHU sesudah koreksi ini.`);
  }
}

async function kasBankDariJurnal(
  db: SQLite.SQLiteDatabase,
  journalId: string,
  sisi: 'debit' | 'kredit'
): Promise<{ sumberDana: 'KAS' | 'BANK'; bankAccountId: string | null }> {
  const banks = await db.getAllAsync<{ id: string; account_id: string }>(`SELECT id, account_id FROM bank_account`);
  const lines = await db.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
    journalId
  );
  for (const l of lines) {
    if (Number(l[sisi]) <= 0) continue;
    const b = banks.find((x) => x.account_id === l.account_id);
    if (b) return { sumberDana: 'BANK', bankAccountId: b.id };
  }
  return { sumberDana: 'KAS', bankAccountId: null };
}

async function jumlahKreditAkun(
  db: SQLite.SQLiteDatabase,
  journalId: string,
  tipe: string,
  peran: string
): Promise<number> {
  let akun: string | null = null;
  try {
    akun = await resolveAccountId(db, tipe, peran);
  } catch {
    return 0;
  }
  const r = await db.getFirstAsync<{ k: number }>(
    `SELECT COALESCE(SUM(kredit), 0) k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
    journalId,
    akun
  );
  return Number(r?.k ?? 0);
}

/**
 * Saldo setiap jenis simpanan anggota TIDAK BOLEH negatif di titik mana pun
 * setelah baris `dihapus` dikeluarkan dan baris `tambahan` (pencatatan ulang)
 * dimasukkan. Penarikan sesudah setoran yang dikoreksi bisa membuat saldo
 * historis negatif walau saldo hari ini masih positif — itu juga ditolak.
 */
export async function cekSaldoSimpananSetelahKoreksi(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  dihapus: ReadonlySet<string>,
  tambahan: { jenis: string; tanggal: string; nominal: number }[]
): Promise<string | null> {
  const rows = await db.getAllAsync<{ id: string; jenis: string; tipe: string; tanggal: string; nominal: number }>(
    `SELECT id, jenis, tipe, tanggal, nominal FROM simpanan_transaksi
      WHERE anggota_id = ? AND reversal_of_id IS NULL
        AND id NOT IN (SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL)`,
    anggotaId
  );
  const peristiwa = [
    ...rows.filter((r) => !dihapus.has(r.id)).map((r) => ({ jenis: r.jenis, tanggal: r.tanggal, delta: r.tipe === 'TARIK' ? -Number(r.nominal) : r.tipe === 'SETOR' ? Number(r.nominal) : 0 })),
    ...tambahan.filter((t) => t.nominal > 0).map((t) => ({ jenis: t.jenis, tanggal: t.tanggal, delta: t.nominal })),
  ];
  const label: Record<string, string> = { POKOK: 'Pokok', WAJIB: 'Wajib', SUKARELA: 'Sukarela' };
  for (const jenis of ['POKOK', 'WAJIB', 'SUKARELA']) {
    // Setoran pada tanggal yang sama dihitung lebih dulu daripada penarikan.
    const urut = peristiwa.filter((p) => p.jenis === jenis).sort((a, b) => (a.tanggal === b.tanggal ? b.delta - a.delta : a.tanggal < b.tanggal ? -1 : 1));
    let saldo = 0;
    for (const p of urut) {
      saldo += p.delta;
      if (saldo < 0) {
        return `Saldo Simpanan ${label[jenis]} anggota ini akan menjadi negatif (Rp${(-saldo).toLocaleString('id-ID')}) pada ${p.tanggal} karena sudah ada penarikan sesudah setoran ini.`;
      }
    }
  }
  return null;
}

/**
 * Periksa apakah jurnal dapat dikoreksi lewat jalur khusus, beserta data
 * asalnya. Tidak menulis apa pun. `null` bila jurnal bukan salah satu dari
 * tiga jenis yang dilayani.
 */
export async function periksaKoreksiTransaksi(
  db: SQLite.SQLiteDatabase,
  journalId: string
): Promise<PemeriksaanKoreksi | null> {
  const j = await db.getFirstAsync<{
    id: string;
    nomor_jurnal: string;
    nomor_referensi: string | null;
    tanggal: string;
    sumber_transaksi: string;
    status: string;
    reversal_of_id: string | null;
    periode_status: string | null;
  }>(
    `SELECT j.id, j.nomor_jurnal, j.nomor_referensi, j.tanggal, j.sumber_transaksi, j.status, j.reversal_of_id,
            ap.status AS periode_status
       FROM journal j LEFT JOIN accounting_period ap ON ap.id = j.period_id
      WHERE j.id = ?`,
    journalId
  );
  if (!j) return null;
  const jenis = SUMBER_KOREKSI[j.sumber_transaksi];
  if (!jenis) return null;

  const tolak: string[] = [];
  const catatan: string[] = [];
  const hasil: PemeriksaanKoreksi = {
    journalId,
    nomorJurnal: j.nomor_jurnal,
    jenis,
    boleh: false,
    alasanTolak: tolak,
    catatan,
  };

  // ---- Syarat umum ----
  if (j.reversal_of_id) tolak.push('Jurnal ini adalah jurnal pembalik (hasil koreksi) dan tidak dikoreksi lagi.');
  if (j.status !== 'POSTED') tolak.push('Hanya transaksi berstatus aktif (POSTED) yang dapat dikoreksi; transaksi ini sudah dikoreksi/dibatalkan.');
  if (j.periode_status === 'CLOSED') tolak.push('Transaksi ini berada pada periode akuntansi yang sudah ditutup (CLOSED).');
  const hariIni = getTanggalLokalHariIni();
  if ((await statusPeriodeTanggal(db, hariIni)) === 'CLOSED') {
    tolak.push(`Periode akuntansi hari ini (${hariIni}) sudah ditutup — jurnal pembalik tidak dapat dibuat.`);
  }
  const sudah = await db.getFirstAsync<{ id: string }>(`SELECT id FROM koreksi_transaksi WHERE journal_asal_id = ?`, journalId);
  if (sudah) tolak.push('Transaksi ini sudah pernah dikoreksi.');

  if (jenis === 'SETORAN_SIMPANAN') {
    const rows = await db.getAllAsync<{
      id: string;
      anggota_id: string;
      jenis: string;
      tipe: string;
      tanggal: string;
      nominal: number;
      sumber_dana: 'KAS' | 'BANK';
      bank_account_id: string | null;
      nomor_transaksi: string;
      reversal_of_id: string | null;
    }>(`SELECT * FROM simpanan_transaksi WHERE journal_id = ? ORDER BY jenis`, journalId);
    const asli = rows.filter((r) => !r.reversal_of_id && r.tipe === 'SETOR');
    if (asli.length === 0) {
      tolak.push('Baris simpanan untuk jurnal ini tidak ditemukan.');
      hasil.boleh = false;
      return hasil;
    }
    const sudahDibalik = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_transaksi WHERE reversal_of_id IN (${asli.map(() => '?').join(',')})`,
      ...asli.map((r) => r.id)
    );
    if (Number(sudahDibalik?.n ?? 0) > 0) tolak.push('Sebagian baris setoran ini sudah dikoreksi sebelumnya.');
    const a = await db.getFirstAsync<{ nomor_anggota: string; nama_lengkap: string; status: string }>(
      `SELECT nomor_anggota, nama_lengkap, status FROM anggota WHERE id = ?`,
      asli[0].anggota_id
    );
    const jml = (je: string) => asli.filter((r) => r.jenis === je).reduce((t, r) => t + Number(r.nominal), 0);
    hasil.setoran = {
      anggotaId: asli[0].anggota_id,
      nomorAnggota: a?.nomor_anggota ?? '',
      namaAnggota: a?.nama_lengkap ?? '',
      tanggal: asli[0].tanggal,
      pokok: jml('POKOK'),
      wajib: jml('WAJIB'),
      sukarela: jml('SUKARELA'),
      sumberDana: asli[0].sumber_dana,
      bankAccountId: asli[0].bank_account_id,
      nomorTransaksi: j.nomor_referensi ?? asli[0].nomor_transaksi,
      barisIds: asli.map((r) => r.id),
    };
    if (a && a.status !== 'AKTIF') {
      tolak.push(`Anggota ${a.nomor_anggota} berstatus ${a.status}; simpanannya sudah diselesaikan, setoran lama tidak dapat dikoreksi.`);
    }
    const negatif = await cekSaldoSimpananSetelahKoreksi(db, hasil.setoran.anggotaId, new Set(hasil.setoran.barisIds), []);
    if (negatif) {
      // Masih mungkin bila dicatat ulang dengan nominal yang cukup — diperiksa ulang saat eksekusi.
      catatan.push(`${negatif} Koreksi hanya dapat dijalankan bila dicatat ulang dengan nominal yang menutup penarikan itu.`);
    }
    if (hasil.setoran.pokok > 0) {
      const pinj = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM pinjaman WHERE anggota_id = ? AND status IN ('DIAJUKAN','DISETUJUI','AKTIF')`,
        hasil.setoran.anggotaId
      );
      if (Number(pinj?.n ?? 0) > 0) {
        catatan.push('Anggota ini memiliki pinjaman berjalan; Simpanan Pokok yang dibalik wajib dicatat ulang (syarat pinjaman).');
      }
    }
    await periksaShu(db, hasil.setoran.tanggal, 'simpanan', tolak, catatan);
    if (hasil.setoran.sukarela > 0) {
      const proses = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM bunga_sukarela_proses WHERE status = 'POSTED' AND periode >= ?`,
        hasil.setoran.tanggal.slice(0, 7)
      );
      if (Number(proses?.n ?? 0) > 0) {
        catatan.push('Bunga Simpanan Sukarela sejak tanggal setoran sudah diproses; selisihnya dibukukan otomatis sebagai KOREKSI pada proses bunga berikutnya.');
      }
    }
  }

  if (jenis === 'PENCAIRAN_PINJAMAN') {
    const p = await db.getFirstAsync<{
      id: string;
      nomor_pinjaman: string;
      status: string;
      anggota_id: string;
      jumlah_pinjaman: number;
      pencairan_journal_id: string | null;
      biaya_admin_klasifikasi: string | null;
      nama_lengkap: string;
    }>(
      `SELECT p.id, p.nomor_pinjaman, p.status, p.anggota_id, p.jumlah_pinjaman, p.pencairan_journal_id,
              p.biaya_admin_klasifikasi, a.nama_lengkap
         FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id
        WHERE p.pencairan_journal_id = ?`,
      journalId
    );
    if (!p) {
      tolak.push('Jurnal ini bukan pencairan yang berlaku untuk pinjaman mana pun (mungkin sudah dikoreksi sumber dananya).');
      return selesai(hasil);
    }
    hasil.pencairan = {
      pinjamanId: p.id,
      nomorPinjaman: p.nomor_pinjaman,
      namaAnggota: p.nama_lengkap,
      tanggal: j.tanggal,
      jumlahPinjaman: Number(p.jumlah_pinjaman),
      ...(await kasBankDariJurnal(db, journalId, 'kredit')),
    };
    if (p.status !== 'AKTIF') tolak.push(`Pinjaman berstatus ${p.status}; hanya pinjaman AKTIF yang pencairannya dapat dikoreksi.`);
    const bayar = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM angsuran_pembayaran ap
        WHERE ap.pinjaman_id = ? AND ap.reversal_of_id IS NULL
          AND ap.id NOT IN (SELECT reversal_of_id FROM angsuran_pembayaran WHERE reversal_of_id IS NOT NULL)`,
      p.id
    );
    if (Number(bayar?.n ?? 0) > 0) {
      tolak.push('Sudah ada pembayaran angsuran atas pinjaman ini. Koreksi pembayaran angsurannya lebih dulu (mulai dari yang terakhir).');
    }
    const akru = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND status <> 'DIBATALKAN'`,
      p.id
    );
    if (Number(akru?.n ?? 0) > 0) {
      tolak.push('Jasa pinjaman ini sudah diakru (Piutang Jasa/Pendapatan Jasa). Pembalikan pencairan akan meninggalkan akrual tanpa pinjaman — koreksi dengan jurnal penyesuaian di menu Akuntansi.');
    }
    const akad = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM pinjaman_akad_ulang WHERE pinjaman_id = ?`, p.id);
    if (Number(akad?.n ?? 0) > 0) tolak.push('Pinjaman ini sudah diakad ulang.');
    if (p.biaya_admin_klasifikasi === 'INTEGRAL_FINANCIAL_INSTRUMENT') {
      tolak.push('Biaya admin pinjaman ini diukur dengan EIR (fee integral); pembalikan otomatis tidak didukung.');
    }
    catatan.push('Tanpa pencairan ulang, pinjaman kembali berstatus Disetujui: dapat diedit/ditolak lalu dicairkan dari menu Pinjaman. Jadwal angsuran tidak berubah.');
  }

  if (jenis === 'ANGSURAN_PINJAMAN') {
    const ap = await db.getFirstAsync<{
      id: string;
      pinjaman_id: string;
      jadwal_id: string | null;
      tanggal: string;
      nominal: number;
      porsi_pokok: number;
      porsi_jasa: number;
      porsi_denda: number;
      sumber_dana: 'KAS' | 'BANK';
      bank_account_id: string | null;
      metode_jasa_pelunasan: string | null;
      created_at: string;
    }>(`SELECT * FROM angsuran_pembayaran WHERE journal_id = ? AND reversal_of_id IS NULL`, journalId);
    if (!ap || !ap.jadwal_id) {
      tolak.push('Data pembayaran angsuran untuk jurnal ini tidak ditemukan.');
      return selesai(hasil);
    }
    const p = await db.getFirstAsync<{ id: string; nomor_pinjaman: string; status: string; biaya_admin_klasifikasi: string | null; nama_lengkap: string }>(
      `SELECT p.id, p.nomor_pinjaman, p.status, p.biaya_admin_klasifikasi, a.nama_lengkap
         FROM pinjaman p JOIN anggota a ON a.id = p.anggota_id WHERE p.id = ?`,
      ap.pinjaman_id
    );
    const jd = await db.getFirstAsync<{ id: string; nomor_angsuran: number; status: string; tanggal_jatuh_tempo: string; jasa_dimuka: number }>(
      `SELECT id, nomor_angsuran, status, tanggal_jatuh_tempo, jasa_dimuka FROM angsuran_jadwal WHERE id = ?`,
      ap.jadwal_id
    );
    hasil.angsuran = {
      pembayaranId: ap.id,
      pinjamanId: ap.pinjaman_id,
      nomorPinjaman: p?.nomor_pinjaman ?? '',
      namaAnggota: p?.nama_lengkap ?? '',
      jadwalId: ap.jadwal_id,
      nomorAngsuran: Number(jd?.nomor_angsuran ?? 0),
      tanggal: ap.tanggal,
      nominal: Number(ap.nominal),
      porsiPokok: Number(ap.porsi_pokok),
      porsiJasa: Number(ap.porsi_jasa),
      porsiDenda: Number(ap.porsi_denda),
      sumberDana: ap.sumber_dana,
      bankAccountId: ap.bank_account_id,
    };
    if (ap.metode_jasa_pelunasan) tolak.push('Ini transaksi pelunasan dipercepat, bukan pembayaran angsuran biasa.');
    const dibalik = await db.getFirstAsync<{ id: string }>(`SELECT id FROM angsuran_pembayaran WHERE reversal_of_id = ?`, ap.id);
    if (dibalik) tolak.push('Pembayaran ini sudah dikoreksi sebelumnya.');
    if (!p || !['AKTIF', 'LUNAS'].includes(p.status)) tolak.push(`Pinjaman berstatus ${p?.status ?? '-'}; koreksi angsuran hanya untuk pinjaman AKTIF/LUNAS.`);
    if (jd && ['DIHAPUSBUKU', 'DIRESTRUKTURISASI'].includes(jd.status)) {
      tolak.push(`Angsuran ini berstatus ${jd.status} (hapus buku/akad ulang).`);
    }
    const sesudah = await db.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM angsuran_pembayaran x
        WHERE x.pinjaman_id = ? AND x.id <> ? AND x.reversal_of_id IS NULL
          AND x.id NOT IN (SELECT reversal_of_id FROM angsuran_pembayaran WHERE reversal_of_id IS NOT NULL)
          AND (x.tanggal > ? OR (x.tanggal = ? AND x.created_at > ?))
        ORDER BY x.tanggal DESC LIMIT 1`,
      ap.pinjaman_id,
      ap.id,
      ap.tanggal,
      ap.tanggal,
      ap.created_at
    );
    if (sesudah) {
      tolak.push(`Sudah ada pembayaran sesudahnya (${sesudah.tanggal}). Koreksi dimulai dari pembayaran TERAKHIR agar alokasi pokok/jasa/denda tetap benar.`);
    }
    const akad = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM pinjaman_akad_ulang WHERE pinjaman_id = ? AND created_at > ?`,
      ap.pinjaman_id,
      ap.created_at
    );
    if (Number(akad?.n ?? 0) > 0) tolak.push('Pinjaman sudah diakad ulang sesudah pembayaran ini.');
    if (p?.status === 'LUNAS' && p.biaya_admin_klasifikasi === 'INTEGRAL_FINANCIAL_INSTRUMENT') {
      tolak.push('Pinjaman lunas dengan fee integral (EIR) sudah diselesaikan; pembalikan otomatis tidak didukung.');
    }
    if (jd) {
      const periode = jd.tanggal_jatuh_tempo.slice(0, 7);
      const akru = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM pinjaman_akuntansi_jasa
          WHERE pinjaman_id = ? AND periode_akuntansi = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND created_at > ?`,
        ap.pinjaman_id,
        periode,
        ap.created_at
      );
      if (Number(akru?.n ?? 0) > 0) {
        tolak.push(`Akrual jasa periode ${periode} sudah dihitung SESUDAH pembayaran ini (memperhitungkan jasa yang dibayar). Pembalikan akan membuat pendapatan jasa periode itu tidak lengkap — koreksi dengan jurnal penyesuaian.`);
      }
      const dimuka = await jumlahKreditAkun(db, journalId, 'ANGSURAN_JASA', 'KREDIT_DIMUKA');
      if (dimuka > 0 && Number(jd.jasa_dimuka) < dimuka) {
        tolak.push('Jasa yang dibayar di muka pada angsuran ini sudah diakui sebagai pendapatan oleh proses akrual.');
      }
    }
    await periksaShu(db, ap.tanggal, 'jasa yang dibayar anggota', tolak, catatan);
  }

  return selesai(hasil);
}

function selesai(h: PemeriksaanKoreksi): PemeriksaanKoreksi {
  h.boleh = h.alasanTolak.length === 0;
  return h;
}

async function catatJejak(
  db: SQLite.SQLiteDatabase,
  d: {
    jenis: JenisKoreksi;
    journalAsalId: string;
    journalPembalikId: string;
    journalPenggantiId: string | null;
    entitasId: string | null;
    alasan: string;
    userId: string;
    sebelum: unknown;
    sesudah: unknown;
  }
): Promise<string> {
  const id = newId();
  const now = new Date();
  await db.runAsync(
    `INSERT INTO koreksi_transaksi
       (id, jenis, journal_asal_id, journal_pembalik_id, journal_pengganti_id, entitas_id, alasan, diotorisasi_oleh,
        data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    d.jenis,
    d.journalAsalId,
    d.journalPembalikId,
    d.journalPenggantiId,
    d.entitasId,
    d.alasan,
    d.userId,
    JSON.stringify(d.sebelum ?? null),
    d.sesudah == null ? null : JSON.stringify(d.sesudah),
    now.toISOString()
  );
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    d.userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    'KOREKSI',
    'journal',
    d.journalAsalId,
    JSON.stringify({ jenis: d.jenis, data: d.sebelum ?? null }),
    JSON.stringify({ alasan: d.alasan, journalPembalikId: d.journalPembalikId, journalPenggantiId: d.journalPenggantiId, data: d.sesudah ?? null }),
    now.toISOString()
  );
  return id;
}

function wajibAlasan(alasan: string): string {
  const a = (alasan ?? '').trim();
  if (a.length < 5) throw new Error('Alasan koreksi wajib diisi (minimal 5 karakter).');
  return a;
}

async function pastikanBoleh(db: SQLite.SQLiteDatabase, journalId: string, jenis: JenisKoreksi): Promise<PemeriksaanKoreksi> {
  const cek = await periksaKoreksiTransaksi(db, journalId);
  if (!cek || cek.jenis !== jenis) throw new Error('Jenis transaksi ini tidak dapat dikoreksi lewat jalur ini.');
  if (!cek.boleh) throw new Error(`Koreksi ditolak: ${cek.alasanTolak.join(' ')}`);
  return cek;
}

export interface HasilKoreksi {
  koreksiId: string;
  journalPembalikId: string;
  journalPenggantiId: string | null;
}

// ===========================================================================
// 1. SETORAN SIMPANAN
// ===========================================================================

export interface PencatatanUlangSetoran {
  tanggal: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
}

export async function koreksiSetoranSimpanan(input: {
  journalId: string;
  alasan: string;
  userId: string;
  catatUlang?: PencatatanUlangSetoran | null;
}): Promise<HasilKoreksi> {
  const alasan = wajibAlasan(input.alasan);
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'history_transaksi', 'edit');
    await requirePermission(db, input.userId, 'simpanan', 'edit');
    const cek = await pastikanBoleh(db, input.journalId, 'SETORAN_SIMPANAN');
    const asal = cek.setoran!;
    const ulang = input.catatUlang ?? null;
    if (ulang) {
      if (ulang.pokok + ulang.wajib + ulang.sukarela <= 0) throw new Error('Pencatatan ulang: isi minimal satu nominal simpanan.');
      const tolak: string[] = [];
      await periksaShu(db, ulang.tanggal, 'simpanan', tolak, []);
      if (tolak.length) throw new Error(`Koreksi ditolak: ${tolak.join(' ')}`);
    }
    const negatif = await cekSaldoSimpananSetelahKoreksi(
      db,
      asal.anggotaId,
      new Set(asal.barisIds),
      ulang
        ? [
            { jenis: 'POKOK', tanggal: ulang.tanggal, nominal: ulang.pokok },
            { jenis: 'WAJIB', tanggal: ulang.tanggal, nominal: ulang.wajib },
            { jenis: 'SUKARELA', tanggal: ulang.tanggal, nominal: ulang.sukarela },
          ]
        : []
    );
    if (negatif) throw new Error(`Koreksi ditolak: ${negatif}`);
    if (asal.pokok > 0 && !(ulang && ulang.pokok > 0)) {
      const pinj = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) n FROM pinjaman WHERE anggota_id = ? AND status IN ('DIAJUKAN','DISETUJUI','AKTIF')`,
        asal.anggotaId
      );
      if (Number(pinj?.n ?? 0) > 0) {
        throw new Error('Koreksi ditolak: anggota memiliki pinjaman berjalan; Simpanan Pokok yang dibalik wajib dicatat ulang.');
      }
    }

    const { journalId: pembalik } = await reverseJournal(db, input.journalId, input.userId, `Koreksi setoran simpanan: ${alasan}`);
    const now = new Date().toISOString();
    for (const id of asal.barisIds) {
      const o = await db.getFirstAsync<any>(`SELECT * FROM simpanan_transaksi WHERE id = ?`, id);
      await db.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, bank_account_id,
           nomor_transaksi, keterangan, reversal_of_id, created_by, created_at)
         VALUES (?,?,?,'KOREKSI',?,?,?,?,?,?,?,?,?)`,
        newId(),
        o.anggota_id,
        o.jenis,
        getTanggalLokalHariIni(),
        o.nominal,
        o.sumber_dana,
        o.bank_account_id,
        `KOREKSI-${o.nomor_transaksi}`,
        alasan,
        id,
        input.userId,
        now
      );
    }

    let pengganti: string | null = null;
    if (ulang) {
      const r = await catatDataAwalSimpananDb(db, {
        anggotaId: asal.anggotaId,
        tanggal: ulang.tanggal,
        pokok: ulang.pokok,
        wajib: ulang.wajib,
        sukarela: ulang.sukarela,
        sumberDana: ulang.sumberDana,
        bankAccountId: ulang.sumberDana === 'BANK' ? ulang.bankAccountId : undefined,
        keterangan: `Koreksi atas ${asal.nomorTransaksi}${ulang.keterangan?.trim() ? ` — ${ulang.keterangan.trim()}` : ''}`,
        createdBy: input.userId,
      });
      pengganti = r.journalId;
    }
    const koreksiId = await catatJejak(db, {
      jenis: 'SETORAN_SIMPANAN',
      journalAsalId: input.journalId,
      journalPembalikId: pembalik,
      journalPenggantiId: pengganti,
      entitasId: asal.anggotaId,
      alasan,
      userId: input.userId,
      sebelum: asal,
      sesudah: ulang,
    });
    return { koreksiId, journalPembalikId: pembalik, journalPenggantiId: pengganti };
  });
}

// ===========================================================================
// 2. PENCAIRAN PINJAMAN
// ===========================================================================

export interface PencairanUlang {
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
}

export async function koreksiPencairanPinjaman(input: {
  journalId: string;
  alasan: string;
  userId: string;
  cairkanUlang?: PencairanUlang | null;
}): Promise<HasilKoreksi> {
  const alasan = wajibAlasan(input.alasan);
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'history_transaksi', 'edit');
    await requirePermission(db, input.userId, 'pinjaman', 'approve');
    const cek = await pastikanBoleh(db, input.journalId, 'PENCAIRAN_PINJAMAN');
    const asal = cek.pencairan!;

    const { journalId: pembalik } = await reverseJournal(db, input.journalId, input.userId, `Koreksi pencairan: ${alasan}`);
    await db.runAsync(
      `UPDATE pinjaman SET status = 'DISETUJUI', pencairan_journal_id = NULL, approved_by = NULL, updated_at = ? WHERE id = ?`,
      new Date().toISOString(),
      asal.pinjamanId
    );

    let pengganti: string | null = null;
    const ulang = input.cairkanUlang ?? null;
    if (ulang) {
      const r = await cairkanPinjamanDb(db, {
        pinjamanId: asal.pinjamanId,
        sumberDana: ulang.sumberDana,
        bankAccountId: ulang.sumberDana === 'BANK' ? ulang.bankAccountId : undefined,
        approvedBy: input.userId,
        tanggalPencairan: ulang.tanggal,
      });
      pengganti = r.journalId;
    }
    const koreksiId = await catatJejak(db, {
      jenis: 'PENCAIRAN_PINJAMAN',
      journalAsalId: input.journalId,
      journalPembalikId: pembalik,
      journalPenggantiId: pengganti,
      entitasId: asal.pinjamanId,
      alasan,
      userId: input.userId,
      sebelum: asal,
      sesudah: ulang,
    });
    return { koreksiId, journalPembalikId: pembalik, journalPenggantiId: pengganti };
  });
}

// ===========================================================================
// 3. PEMBAYARAN ANGSURAN
// ===========================================================================

export interface PembayaranUlang {
  tanggal: string;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
}

export async function koreksiAngsuran(input: {
  journalId: string;
  alasan: string;
  userId: string;
  bayarUlang?: PembayaranUlang | null;
}): Promise<HasilKoreksi> {
  const alasan = wajibAlasan(input.alasan);
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'history_transaksi', 'edit');
    await requirePermission(db, input.userId, 'pinjaman', 'edit');
    const cek = await pastikanBoleh(db, input.journalId, 'ANGSURAN_PINJAMAN');
    const asal = cek.angsuran!;
    const ulang = input.bayarUlang ?? null;
    if (ulang) {
      const tolak: string[] = [];
      await periksaShu(db, ulang.tanggal, 'jasa yang dibayar anggota', tolak, []);
      if (tolak.length) throw new Error(`Koreksi ditolak: ${tolak.join(' ')}`);
    }

    // Komponen jasa yang dibukukan ke Pendapatan Diterima Dimuka / Piutang
    // Jasa dibaca dari JURNAL ASAL (bukan dihitung ulang) supaya subledger
    // dipulihkan persis sebesar yang dulu diubah.
    const dimuka = await jumlahKreditAkun(db, input.journalId, 'ANGSURAN_JASA', 'KREDIT_DIMUKA');
    const keDiakru = await jumlahKreditAkun(db, input.journalId, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA');

    const { journalId: pembalik } = await reverseJournal(db, input.journalId, input.userId, `Koreksi angsuran: ${alasan}`);

    // Jadwal: kembalikan porsi yang dulu dialokasikan.
    const jd = await db.getFirstAsync<any>(`SELECT * FROM angsuran_jadwal WHERE id = ?`, asal.jadwalId);
    const pokokT = Number(jd.pokok_terbayar) - asal.porsiPokok;
    const jasaT = Number(jd.jasa_terbayar) - asal.porsiJasa;
    const dendaT = Number(jd.denda_terbayar) - asal.porsiDenda;
    if (pokokT < 0 || jasaT < 0 || dendaT < 0) {
      throw new Error('Koreksi ditolak: data jadwal angsuran tidak konsisten dengan pembayaran ini.');
    }
    const lunas = pokokT >= Number(jd.pokok) && jasaT >= Number(jd.jasa);
    const statusJadwal = lunas ? 'LUNAS' : pokokT + jasaT > 0 ? 'SEBAGIAN' : 'BELUM_BAYAR';
    await db.runAsync(
      `UPDATE angsuran_jadwal SET pokok_terbayar = ?, jasa_terbayar = ?, denda_terbayar = ?, jasa_dimuka = jasa_dimuka - ?, status = ? WHERE id = ?`,
      pokokT,
      jasaT,
      dendaT,
      dimuka,
      statusJadwal,
      asal.jadwalId
    );

    // Piutang Jasa (subledger akrual): kembalikan kas_diterima periode jadwal.
    if (keDiakru > 0) {
      let sisa = keDiakru;
      const periode = String(jd.tanggal_jatuh_tempo).slice(0, 7);
      const rows = await db.getAllAsync<any>(
        `SELECT id, kas_diterima, pendapatan_akuntansi, saldo_awal_carrying FROM pinjaman_akuntansi_jasa
          WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND status = 'DIAKUI' AND kas_diterima > 0
            AND periode_akuntansi = ?
          ORDER BY periode_akuntansi DESC`,
        asal.pinjamanId,
        periode
      );
      for (const r of rows) {
        if (sisa <= 0) break;
        const kurang = Math.min(sisa, Number(r.kas_diterima));
        const kasBaru = Number(r.kas_diterima) - kurang;
        await db.runAsync(
          `UPDATE pinjaman_akuntansi_jasa SET kas_diterima = ?, saldo_akhir_carrying = ?, updated_at = ? WHERE id = ?`,
          kasBaru,
          Number(r.saldo_awal_carrying) + Number(r.pendapatan_akuntansi) - kasBaru,
          new Date().toISOString(),
          r.id
        );
        sisa -= kurang;
      }
      if (sisa > 0) throw new Error('Koreksi ditolak: subledger Piutang Jasa tidak dapat dipulihkan sebesar pembayaran ini.');
    }

    // Baris pembalik di angsuran_pembayaran: nilai NEGATIF bertanggal
    // pembayaran asal, sehingga setiap penjumlahan (dasar SHU jasa usaha,
    // total angsuran anggota) otomatis netral; daftar bukti bayar sudah
    // mengecualikan pasangan asal/pembalik (BuktiTransaksiService).
    await db.runAsync(
      `INSERT INTO angsuran_pembayaran
        (id, pinjaman_id, jadwal_id, tanggal, nominal, porsi_pokok, porsi_jasa, porsi_denda,
         sumber_dana, bank_account_id, journal_id, reversal_of_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      asal.pinjamanId,
      asal.jadwalId,
      asal.tanggal,
      -asal.nominal,
      -asal.porsiPokok,
      -asal.porsiJasa,
      -asal.porsiDenda,
      asal.sumberDana,
      asal.bankAccountId,
      pembalik,
      asal.pembayaranId,
      input.userId,
      new Date().toISOString()
    );

    // Pinjaman yang lunas karena pembayaran ini kembali AKTIF.
    const tertagih = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM angsuran_jadwal aj WHERE aj.pinjaman_id = ? AND ${sqlJadwalMasihTertagih('aj')}`,
      asal.pinjamanId
    );
    if (Number(tertagih?.n ?? 0) > 0) {
      await db.runAsync(
        `UPDATE pinjaman SET status = 'AKTIF', updated_at = ? WHERE id = ? AND status = 'LUNAS'`,
        new Date().toISOString(),
        asal.pinjamanId
      );
    }

    let pengganti: string | null = null;
    if (ulang) {
      const r = await bayarAngsuranDb(db, {
        pinjamanId: asal.pinjamanId,
        jadwalId: asal.jadwalId,
        tanggal: ulang.tanggal,
        nominal: ulang.nominal,
        sumberDana: ulang.sumberDana,
        bankAccountId: ulang.sumberDana === 'BANK' ? ulang.bankAccountId : undefined,
        createdBy: input.userId,
      });
      pengganti = r.journalId;
    }
    const koreksiId = await catatJejak(db, {
      jenis: 'ANGSURAN_PINJAMAN',
      journalAsalId: input.journalId,
      journalPembalikId: pembalik,
      journalPenggantiId: pengganti,
      entitasId: asal.pinjamanId,
      alasan,
      userId: input.userId,
      sebelum: { ...asal, jasaDimuka: dimuka, jasaKePiutangJasa: keDiakru },
      sesudah: ulang,
    });
    return { koreksiId, journalPembalikId: pembalik, journalPenggantiId: pengganti };
  });
}

// ===========================================================================
// JEJAK & PENDUKUNG LAYAR
// ===========================================================================

/** Koreksi yang menyangkut jurnal ini (sebagai asal, pembalik, atau pengganti). */
export async function getJejakKoreksi(db: SQLite.SQLiteDatabase, journalId: string): Promise<JejakKoreksi[]> {
  let rows: any[] = [];
  try {
    rows = await db.getAllAsync<any>(
      `SELECT k.*, u.nama AS nama_pengotorisasi,
              ja.nomor_jurnal AS nomor_asal, jb.nomor_jurnal AS nomor_pembalik, jp.nomor_jurnal AS nomor_pengganti
         FROM koreksi_transaksi k
         LEFT JOIN app_user u ON u.id = k.diotorisasi_oleh
         LEFT JOIN journal ja ON ja.id = k.journal_asal_id
         LEFT JOIN journal jb ON jb.id = k.journal_pembalik_id
         LEFT JOIN journal jp ON jp.id = k.journal_pengganti_id
        WHERE k.journal_asal_id = ? OR k.journal_pembalik_id = ? OR k.journal_pengganti_id = ?
        ORDER BY k.created_at`,
      journalId,
      journalId,
      journalId
    );
  } catch {
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    jenis: r.jenis,
    alasan: r.alasan,
    diotorisasiOleh: r.diotorisasi_oleh,
    namaPengotorisasi: r.nama_pengotorisasi ?? null,
    createdAt: r.created_at,
    journalAsalId: r.journal_asal_id,
    nomorJurnalAsal: r.nomor_asal ?? null,
    journalPembalikId: r.journal_pembalik_id,
    nomorJurnalPembalik: r.nomor_pembalik ?? null,
    journalPenggantiId: r.journal_pengganti_id ?? null,
    nomorJurnalPengganti: r.nomor_pengganti ?? null,
  }));
}

/** Rekening bank aktif untuk pilihan sumber dana pada form koreksi. */
export async function daftarRekeningBankKoreksi(
  db: SQLite.SQLiteDatabase
): Promise<{ id: string; namaBank: string; nomorRekening: string }[]> {
  const rows = await db.getAllAsync<{ id: string; nama_bank: string; nomor_rekening: string }>(
    `SELECT id, nama_bank, nomor_rekening FROM bank_account WHERE aktif = 1 ORDER BY nama_bank, nomor_rekening`
  );
  return rows.map((r) => ({ id: r.id, namaBank: r.nama_bank, nomorRekening: r.nomor_rekening }));
}

/** Versi untuk layar (membuka koneksi sendiri). */
export async function ambilRekeningBankKoreksi(): Promise<{ id: string; namaBank: string; nomorRekening: string }[]> {
  return daftarRekeningBankKoreksi(await getDb());
}
