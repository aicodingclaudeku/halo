import * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';

/** PRD §22 — Buku Besar per akun. */
export interface LedgerLine {
  tanggal: string;
  nomorJurnal: string;
  keterangan: string;
  debit: Rupiah;
  kredit: Rupiah;
  saldoBerjalan: Rupiah;
}

export async function getLedger(
  db: SQLite.SQLiteDatabase,
  accountId: string,
  opts: { tanggalMulai?: string; tanggalSelesai?: string } = {}
): Promise<LedgerLine[]> {
  const account = await db.getFirstAsync<{ normal_balance: string }>(
    'SELECT normal_balance FROM account WHERE id = ?',
    accountId
  );
  if (!account) throw new Error('Akun tidak ditemukan.');

  // Sama seperti getAccountBalance() — REVERSED tetap ditampilkan (transaksi
  // asli beneran terjadi, lalu dikoreksi lewat baris reversal terpisah).
  // Buku besar yang baik justru HARUS menunjukkan keduanya sebagai jejak
  // audit, bukan menyembunyikan transaksi yang sudah dikoreksi.
  const filters: string[] = [`je.account_id = ?`, `j.status IN ('POSTED','REVERSED')`];
  const params: (string | number)[] = [accountId];
  if (opts.tanggalMulai) {
    filters.push('j.tanggal >= ?');
    params.push(opts.tanggalMulai);
  }
  if (opts.tanggalSelesai) {
    filters.push('j.tanggal <= ?');
    params.push(opts.tanggalSelesai);
  }

  const rows = await db.getAllAsync<{
    tanggal: string;
    nomor_jurnal: string;
    deskripsi: string;
    keterangan: string | null;
    debit: number;
    kredit: number;
  }>(
    `SELECT j.tanggal, j.nomor_jurnal, j.deskripsi, je.keterangan, je.debit, je.kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     WHERE ${filters.join(' AND ')}
     ORDER BY j.tanggal ASC, j.nomor_jurnal ASC, je.urutan ASC`,
    ...params
  );

  let saldo = 0;
  const isDebitNormal = account.normal_balance === 'DEBIT';

  return rows.map((r) => {
    saldo += isDebitNormal ? r.debit - r.kredit : r.kredit - r.debit;
    return {
      tanggal: r.tanggal,
      nomorJurnal: r.nomor_jurnal,
      keterangan: r.keterangan ?? r.deskripsi,
      debit: r.debit,
      kredit: r.kredit,
      saldoBerjalan: saldo,
    };
  });
}

/** PRD §23 — Neraca Saldo (trial balance), tervalidasi total debit = total kredit. */
export interface TrialBalanceRow {
  accountId: string;
  kode: string;
  nama: string;
  debit: Rupiah;
  kredit: Rupiah;
}

export interface TrialBalanceResult {
  rows: TrialBalanceRow[];
  totalDebit: Rupiah;
  totalKredit: Rupiah;
  isBalanced: boolean;
}

export async function getTrialBalance(
  db: SQLite.SQLiteDatabase,
  asOfDate: string
): Promise<TrialBalanceResult> {
  // BUG FIX (Prioritas 2/D — audit selisih neraca): sebelumnya filter
  // `WHERE is_active = 1` di sini membuat akun yang SUDAH DINONAKTIFKAN
  // (soft-delete lewat AccountRepository.setAccountActive) langsung
  // HILANG dari Neraca Saldo — padahal komentar
  // `AccountRepository.setAccountActive` sendiri menegaskan "histori
  // ledger harus tetap utuh". Kalau akun yang dinonaktifkan itu masih
  // punya saldo historis (mis. Aset), saldo itu ikut lenyap dari Total
  // Aset TAPI counterpart-nya di akun lain tetap terhitung -> Aset ≠
  // Liabilitas + Ekuitas, selisih yang sulit ditelusuri user karena
  // akun penyebabnya sendiri sudah tidak tampak di UI mana pun.
  // Fix: Neraca Saldo/laporan HARUS membaca SEMUA akun yang tercatat
  // di ledger, aktif maupun nonaktif — status is_active hanya relevan
  // untuk memilih akun pada transaksi BARU (dropdown input), bukan
  // untuk membaca histori.
  const accounts = await db.getAllAsync<{
    id: string;
    kode: string;
    nama: string;
    normal_balance: string;
  }>(`SELECT id, kode, nama, normal_balance FROM account ORDER BY kode ASC`);

  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalKredit = 0;

  for (const acc of accounts) {
    // Sama seperti getAccountBalance()/getLedger() — REVERSED tetap dihitung.
    const sums = await db.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') AND j.tanggal <= ?`,
      acc.id,
      asOfDate
    );
    const totalD = sums?.d ?? 0;
    const totalK = sums?.k ?? 0;
    const saldo = acc.normal_balance === 'DEBIT' ? totalD - totalK : totalK - totalD;
    if (saldo === 0) continue; // akun tanpa mutasi tidak ditampilkan

    // BUG FIX (permintaan pengguna — "Kas negatif menjadi Rp0 pada
    // Posisi Keuangan"): SEBELUMNYA kedua kolom dibungkus
    // `Math.max(saldo, 0)` — untuk akun ber-saldo NEGATIF (mis. Kas
    // yang ditarik melebihi saldo tercatatnya, kondisi valid & harus
    // terlihat, bukan cuma dari input saldo awal), INI MEMBUAT KEDUA
    // KOLOM (debit maupun kredit) JADI NOL SEKALIGUS — debitCol nol
    // karena Math.max(negatif, 0)=0, dan kreditCol nol karena memang
    // di-hardcode 0 untuk akun DEBIT-normal (dan sebaliknya untuk akun
    // KREDIT-normal). Akibatnya saldo negatif LENYAP TOTAL dari Neraca
    // Saldo, lalu ikut lenyap di Posisi Keuangan (yang membaca kolom
    // ini) — persis root cause "Kas -Rp5.000.000 tampil Rp0".
    //
    // FIX: HAPUS Math.max — kolom yang sesuai normal_balance akun diisi
    // `saldo` APA ADANYA (boleh negatif), kolom satunya tetap 0. Ini
    // BUKAN sekadar perbaikan tampilan — juga menjaga invarian
    // akuntansi `totalDebit === totalKredit` tetap benar secara
    // matematis TANPA syarat tambahan: karena SETIAP jurnal individual
    // sudah balance (debit=kredit per jurnal), maka
    // Σ_semua_akun(totalD) = Σ_semua_akun(totalK) SELALU — dan bisa
    // dibuktikan aljabar bahwa itu PERSIS setara dengan
    // Σ(debitCol akun DEBIT-normal) = Σ(kreditCol akun KREDIT-normal)
    // kalau kedua kolom diisi `saldo` bertanda apa adanya (tanpa
    // clamp) — clamp yang lama justru BERISIKO membuat totalDebit ≠
    // totalKredit secara diam-diam untuk akun ber-saldo abnormal,
    // bukan cuma masalah tampilan.
    const debitCol = acc.normal_balance === 'DEBIT' ? saldo : 0;
    const kreditCol = acc.normal_balance === 'KREDIT' ? saldo : 0;

    rows.push({ accountId: acc.id, kode: acc.kode, nama: acc.nama, debit: debitCol, kredit: kreditCol });
    totalDebit += debitCol;
    totalKredit += kreditCol;
  }

  return { rows, totalDebit, totalKredit, isBalanced: totalDebit === totalKredit };
}
