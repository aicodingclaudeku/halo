import type * as SQLite from 'expo-sqlite';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { tambahSaldoAwalAkun, getSaldoAwalLockInfo } from '@/services/SaldoAwalAkunService';
import {
  susunRencanaSaldoAwal,
  pesanSudahAda,
  type TotalPerPos,
  type HasilSaldoAwalOtomatis,
  type HasilPengisianPos,
} from '@/import/SaldoAwalOtomatisPlan';

/**
 * RC-S107 — PENULISAN SALDO AWAL OTOMATIS.
 *
 * Memakai `tambahSaldoAwalAkun()` yang SUDAH ADA, bukan INSERT sendiri.
 * Alasannya penting: fungsi itu yang memeriksa penguncian, membuat
 * jurnal dua-baris terhadap akun kliring, menulis audit log, dan
 * menolak saldo <= 0. Menulis langsung ke tabel akan melewatkan
 * seluruh penjaga itu dan menghasilkan saldo awal yang tidak berjurnal.
 *
 * Satu baris gagal TIDAK menggagalkan baris lain: tiap pos dilaporkan
 * sendiri-sendiri, supaya pengguna tahu persis mana yang terisi dan
 * mana yang perlu dikerjakan manual.
 */
export async function isiSaldoAwalOtomatis(
  db: SQLite.SQLiteDatabase,
  total: TotalPerPos,
  opsi: { tanggalCutOff: string; createdBy: string }
): Promise<HasilSaldoAwalOtomatis> {
  const rencana = susunRencanaSaldoAwal(total);
  const baris: HasilPengisianPos[] = [];

  // Saldo awal yang sudah DIKUNCI permanen tidak boleh disentuh sama
  // sekali. Diperiksa sekali di depan supaya pesannya satu, bukan
  // pengulangan galat yang sama untuk tiap pos.
  let terkunci = false;
  try {
    terkunci = (await getSaldoAwalLockInfo()) !== null;
  } catch {
    terkunci = false;
  }
  if (terkunci) {
    for (const r of rencana) {
      baris.push({
        pos: r.pos,
        label: r.label,
        status: 'GAGAL',
        saldoImport: r.saldo,
        pesan: `${r.label}: saldo awal sudah dikunci permanen, tidak dapat diisi otomatis.`,
      });
    }
    return { baris, jumlahDiisi: 0, jumlahSudahAda: 0, jumlahGagal: baris.length, terkunci: true };
  }

  for (const r of rencana) {
    let accountId: string;
    try {
      accountId = await resolveAccountId(db, r.tipeTransaksi, r.peran);
    } catch (e) {
      baris.push({
        pos: r.pos,
        label: r.label,
        status: 'GAGAL',
        saldoImport: r.saldo,
        pesan: `${r.label}: pemetaan akun "${r.tipeTransaksi}/${r.peran}" belum diatur. Isi saldo awalnya manual.`,
      });
      continue;
    }

    // TIDAK MENIMPA. Nilai yang sudah diketik pengguna dipertahankan;
    // hasil import hanya dilaporkan sebagai pembanding.
    const adaSebelumnya = await db.getFirstAsync<{ saldo: number }>(
      `SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`,
      accountId
    );
    if (adaSebelumnya) {
      baris.push({
        pos: r.pos,
        label: r.label,
        status: 'SUDAH_ADA',
        saldoImport: r.saldo,
        saldoSebelumnya: adaSebelumnya.saldo,
        pesan: pesanSudahAda(r.label, adaSebelumnya.saldo, r.saldo),
      });
      continue;
    }

    try {
      await tambahSaldoAwalAkun({
        accountId,
        tanggal: opsi.tanggalCutOff,
        saldo: r.saldo,
        createdBy: opsi.createdBy,
      } as Parameters<typeof tambahSaldoAwalAkun>[0]);
      baris.push({
        pos: r.pos,
        label: r.label,
        status: 'DIISI',
        saldoImport: r.saldo,
        pesan: `${r.label}: saldo awal diisi ${r.saldo.toLocaleString('id-ID')} dari ${r.asal}.`,
      });
    } catch (e) {
      baris.push({
        pos: r.pos,
        label: r.label,
        status: 'GAGAL',
        saldoImport: r.saldo,
        pesan: `${r.label}: gagal mengisi saldo awal — ${e instanceof Error ? e.message : 'kesalahan tidak diketahui'}`,
      });
    }
  }

  return {
    baris,
    jumlahDiisi: baris.filter((b) => b.status === 'DIISI').length,
    jumlahSudahAda: baris.filter((b) => b.status === 'SUDAH_ADA').length,
    jumlahGagal: baris.filter((b) => b.status === 'GAGAL').length,
    terkunci: false,
  };
}

/**
 * Cari `journal_id` saldo awal sebuah pos — dipakai migrasi aset untuk
 * merujuk jurnal Akumulasi Penyusutan saat mencatat periode penyusutan
 * masa lalu. Mengembalikan null bila posnya tidak terisi.
 */
export async function journalIdSaldoAwal(
  db: SQLite.SQLiteDatabase,
  tipeTransaksi: string,
  peran: string
): Promise<string | null> {
  let accountId: string;
  try {
    accountId = await resolveAccountId(db, tipeTransaksi, peran);
  } catch {
    return null;
  }
  const row = await db.getFirstAsync<{ journal_id: string | null }>(
    `SELECT journal_id FROM saldo_awal_akun WHERE account_id = ?`,
    accountId
  );
  return row?.journal_id ?? null;
}
