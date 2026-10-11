import * as SQLite from 'expo-sqlite';
import { newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { resolveAccountId } from '@/accounting/AccountMapping';
import {
  BarisMigrasiPinjaman,
  GalatMigrasi,
  KonteksMigrasi,
  RekonsiliasiPiutang,
  adalahPinjamanMigrasi,
  keteranganMigrasi,
  majuPeriode,
  rekonsiliasiPiutang,
  susunJadwalMigrasi,
  alokasiPiutangJasaMigrasi,
  validasiMigrasiPinjaman,
} from './MigrasiPinjamanPlan';

/**
 * RC-S102 — EKSEKUSI MIGRASI SALDO AWAL PINJAMAN BERJALAN.
 *
 * ATURAN YANG TIDAK BOLEH DILANGGAR OLEH BERKAS INI:
 *
 *  1. TIDAK memanggil `createJournal`, `cairkanPinjaman`, atau
 *     `bayarAngsuran`. Sama sekali tidak ada jurnal yang dibuat, sehingga
 *     kas/bank hari ini MUSTAHIL berkurang dan pendapatan historis
 *     MUSTAHIL diakui ulang. Ini dijaga oleh test struktural.
 *  2. TIDAK memanggil pemeriksaan likuiditas — bukan karena
 *     pemeriksaannya dilemahkan, melainkan karena tidak ada kas yang
 *     keluar untuk diperiksa. Pencairan pinjaman BARU tetap melewati
 *     seluruh pemeriksaan di `PinjamanService.cairkanPinjaman()`, yang
 *     tidak disentuh sedikit pun oleh perubahan ini.
 *  3. Sisi buku besar diserahkan ke mekanisme `saldo_awal_akun` yang
 *     sudah ada. Berkas ini hanya MEMBACA saldo awal itu untuk
 *     rekonsiliasi, tidak pernah menulisnya.
 *
 * Menerima `db` sebagai parameter (tidak memanggil `getDb`) supaya dapat
 * diuji langsung terhadap SQLite sungguhan — konvensi yang sama dengan
 * `ResetDataTransaksi` dan `RiwayatImportRepository`.
 */

export interface OpsiMigrasiPinjaman extends KonteksMigrasi {
  createdBy: string;
  /** Peta kode anggota (huruf besar) -> anggota yang sudah ada/baru dibuat. */
  petaAnggota: Map<string, { id: string; nomorAnggota: string; nama: string }>;
  onKemajuan?: (selesai: number, total: number) => void;
}

export interface HasilBarisMigrasi {
  baris: number;
  nomorPinjaman: string;
  keterangan: string;
  sisaPokok: Rupiah;
  jumlahJadwal: number;
  jumlahTertunggak: number;
  /** RC-S133.4.5 — RIWAYAT: jadwal dari akad persis; SISA: tanggal dari akad, sisa pokok dari berkas; LAMA: tanpa tenor akad. */
  modeJadwal?: 'RIWAYAT' | 'SISA' | 'LAMA';
  /** RC-S133.4.5 — catatan per baris (mis. tunggakan berkas berbeda dari tunggakan menurut jadwal). */
  catatan?: string[];
}

export interface HasilMigrasiPinjaman {
  /** Baris yang berhasil dimigrasikan. */
  berhasil: HasilBarisMigrasi[];
  /** Baris yang gagal, beserta sebabnya. */
  gagal: GalatMigrasi[];
  /** Baris yang DILEWATI karena nomornya sudah pernah dimigrasikan. */
  dilewati: GalatMigrasi[];
  totalSisaPokok: Rupiah;
  rekonsiliasi: RekonsiliasiPiutang;
  /** RC-S133.4.5 — total jasa angsuran yang dibayar di muka (jatuh tempo >= cut-off) → saldo awal Pendapatan Diterima Dimuka. */
  totalJasaDimuka?: Rupiah;
  /** RC-S133.4.5 — total pokok tertunggak per cut-off menurut tanggal jatuh tempo asli. */
  totalTunggakanPokok?: Rupiah;
}

/** Galat yang menghentikan seluruh migrasi sebelum satu baris pun ditulis. */
export class ValidasiMigrasiGagalError extends Error {
  constructor(public readonly galat: GalatMigrasi[]) {
    super(
      `Migrasi dibatalkan: ${galat.length} kesalahan pada berkas. ` +
        `Tidak ada satu baris pun yang ditulis ke database.`
    );
    this.name = 'ValidasiMigrasiGagalError';
  }
}

/**
 * Baca saldo awal sebuah akun lewat pemetaan COA — `null` bila belum
 * diisi. Dibedakan dari 0 dengan sengaja: "belum diisi" adalah langkah
 * yang belum dikerjakan, sedangkan 0 adalah pernyataan bahwa saldonya
 * memang nol.
 */
async function saldoAwalAkun(
  db: SQLite.SQLiteDatabase,
  transactionType: string,
  role: string
): Promise<Rupiah | null> {
  try {
    const accountId = await resolveAccountId(db, transactionType, role);
    const row = await db.getFirstAsync<{ saldo: number }>(
      `SELECT saldo FROM saldo_awal_akun WHERE account_id = ?`,
      accountId
    );
    return row ? Number(row.saldo) : null;
  } catch {
    // Pemetaan/akun belum ada — diperlakukan sebagai belum diisi, bukan
    // menggagalkan rekonsiliasi.
    return null;
  }
}

/**
 * Nomor pinjaman yang sudah ada di database beserta keterangannya —
 * dipakai penjaga duplikasi. Perbandingan memakai huruf besar supaya
 * "PJ-001" dan "pj-001" dikenali sebagai nomor yang sama.
 */
async function nomorPinjamanTerpakai(
  db: SQLite.SQLiteDatabase
): Promise<Map<string, { id: string; keterangan: string | null }>> {
  const rows = await db.getAllAsync<{ id: string; nomor_pinjaman: string; keterangan: string | null }>(
    `SELECT id, nomor_pinjaman, keterangan FROM pinjaman`
  );
  return new Map(rows.map((r) => [r.nomor_pinjaman.toUpperCase(), { id: r.id, keterangan: r.keterangan }]));
}

/**
 * PRATINJAU — memeriksa tanpa menulis apa pun.
 *
 * Mengembalikan galat validasi, baris yang akan dilewati karena sudah
 * pernah dimigrasikan, dan rekonsiliasi yang AKAN terjadi. Dipakai layar
 * sebelum tombol jalankan diaktifkan, sehingga pengguna melihat
 * akibatnya lebih dulu.
 */
export async function pratinjauMigrasiPinjaman(
  db: SQLite.SQLiteDatabase,
  baris: BarisMigrasiPinjaman[],
  konteks: KonteksMigrasi
): Promise<{
  galat: GalatMigrasi[];
  dilewati: GalatMigrasi[];
  totalSisaPokok: Rupiah;
  rekonsiliasi: RekonsiliasiPiutang;
}> {
  const galat = validasiMigrasiPinjaman(baris, konteks);
  const terpakai = await nomorPinjamanTerpakai(db);

  const dilewati: GalatMigrasi[] = [];
  const akanDiproses: BarisMigrasiPinjaman[] = [];
  for (const r of baris) {
    const kunci = (r.nomorPinjamanAsli ?? '').trim().toUpperCase();
    const ada = kunci === '' ? undefined : terpakai.get(kunci);
    if (ada) {
      dilewati.push({
        baris: r.baris,
        kode: 'NOMOR_ASLI_GANDA',
        pesan: adalahPinjamanMigrasi(ada.keterangan)
          ? `Nomor pinjaman "${r.nomorPinjamanAsli}" SUDAH pernah dimigrasikan — baris ini dilewati, data yang sudah ada tidak diubah.`
          : `Nomor pinjaman "${r.nomorPinjamanAsli}" sudah dipakai pinjaman lain di aplikasi ini (bukan hasil migrasi). Ganti nomornya atau periksa datanya.`,
      });
      continue;
    }
    akanDiproses.push(r);
  }

  const totalSisaPokok = akanDiproses.reduce((t, r) => t + (Number(r.sisaPokok) || 0), 0);
  const totalPiutangJasa = akanDiproses.reduce((t, r) => t + (Number(r.piutangJasa) || 0), 0);

  return {
    galat,
    dilewati,
    totalSisaPokok,
    rekonsiliasi: rekonsiliasiPiutang({
      totalSisaPokokBukuPembantu: totalSisaPokok,
      saldoAwalPiutangPokok: await saldoAwalAkun(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG'),
      totalPiutangJasaBukuPembantu: totalPiutangJasa,
      saldoAwalPiutangJasa: await saldoAwalAkun(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA'),
    }),
  };
}

/**
 * JALANKAN MIGRASI.
 *
 * SATU TRANSAKSI untuk seluruh baris: kalau ada satu saja yang gagal
 * ditulis, seluruhnya di-rollback. Import parsial adalah keadaan
 * terburuk di sini — buku pembantu separuh terisi tidak akan pernah
 * cocok dengan saldo awal buku besar, dan memperbaikinya manual jauh
 * lebih sulit daripada mengulang dari nol.
 *
 * Validasi dijalankan LEBIH DULU atas SELURUH baris; bila ada galat,
 * fungsi ini melempar SEBELUM menulis apa pun.
 *
 * Baris yang nomornya sudah pernah dimigrasikan DILEWATI, bukan
 * ditimpa — data yang sudah berhasil masuk tidak pernah diubah otomatis.
 */
export async function jalankanMigrasiPinjaman(
  db: SQLite.SQLiteDatabase,
  baris: BarisMigrasiPinjaman[],
  opsi: OpsiMigrasiPinjaman
): Promise<HasilMigrasiPinjaman> {
  const pra = await pratinjauMigrasiPinjaman(db, baris, opsi);
  if (pra.galat.length > 0) throw new ValidasiMigrasiGagalError(pra.galat);

  const dilewatiKunci = new Set(pra.dilewati.map((d) => d.baris));
  const akanDiproses = baris.filter((r) => !dilewatiKunci.has(r.baris));

  const berhasil: HasilBarisMigrasi[] = [];
  const gagal: GalatMigrasi[] = [];
  const total = akanDiproses.length;
  let selesai = 0;
  let totalJasaDimuka = 0;
  let totalTunggakanPokok = 0;

  await db.withTransactionAsync(async () => {
    for (const r of akanDiproses) {
      const anggota = opsi.petaAnggota.get((r.kodeAnggota ?? '').trim().toUpperCase());
      if (!anggota) {
        // Dilempar, bukan dikumpulkan: anggota yang tidak ditemukan
        // berarti berkasnya tidak konsisten, dan menulis sebagian
        // pinjaman tanpa pemiliknya akan merusak rekonsiliasi.
        throw new Error(
          `Baris ${r.baris}: anggota berkode "${r.kodeAnggota}" tidak ditemukan. Migrasi dibatalkan seluruhnya.`
        );
      }

      // RC-S133.4.5 — jadwal dibangun dari akad (tanggal & nominal sama
      // persis dengan pinjaman biasa) bila tenor akad diketahui.
      const susunan = susunJadwalMigrasi({
        tanggalAkad: r.tanggalAkad,
        jumlahPinjamanAsli: r.jumlahPinjamanAsli,
        tenorAsli: r.tenorAsli,
        sisaPokok: r.sisaPokok,
        angsuranTersisa: r.angsuranTersisa,
        tunggakanPokok: r.tunggakanPokok,
        satuanTenor: r.satuanTenor,
        metodeJasa: r.metodeJasa,
        persentaseJasa: r.persentaseJasa,
        tanggalCutOff: opsi.tanggalCutOff,
      });
      const jadwal = susunan.baris;
      const belumLunas = jadwal.filter((j) => j.status !== 'LUNAS');

      // INVARIAN: jumlah pokok jadwal yang BELUM dibayar WAJIB sama dengan
      // sisa pokok. Diperiksa di dalam transaksi, supaya penyimpangan
      // sekecil apa pun membatalkan seluruh migrasi alih-alih
      // meninggalkan buku pembantu yang tidak dapat direkonsiliasi.
      const totalPokokJadwal = belumLunas.reduce((t, j) => t + j.pokok, 0);
      if (totalPokokJadwal !== r.sisaPokok) {
        throw new Error(
          `Baris ${r.baris}: jumlah pokok jadwal (${totalPokokJadwal}) tidak sama dengan sisa pokok (${r.sisaPokok}).`
        );
      }
      const catatan: string[] = [];
      if (susunan.mode === 'RIWAYAT' && r.tunggakanPokok !== undefined && r.tunggakanPokok !== susunan.tunggakanPokok) {
        catatan.push(
          `Tunggakan pokok di berkas Rp${r.tunggakanPokok.toLocaleString('id-ID')}, menurut jadwal akad Rp${susunan.tunggakanPokok.toLocaleString('id-ID')} — yang dipakai jadwal akad.`
        );
      }
      if (susunan.mode === 'SISA') {
        catatan.push('Sisa pokok di berkas berbeda dari jadwal akad — jadwal sisa disusun dari tanggal cut-off memakai sisa pokok & tunggakan dari berkas.');
      }

      const pinjamanId = newId();
      const now = new Date().toISOString();
      const nomor = r.nomorPinjamanAsli.trim();
      const jatuhTempoAkhir = jadwal[jadwal.length - 1]?.tanggalJatuhTempo
        ?? majuPeriode(opsi.tanggalCutOff, r.satuanTenor, r.angsuranTersisa);

      await db.runAsync(
        `INSERT INTO pinjaman
           (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
            metode_jasa, persentase_jasa, biaya_admin_tipe, biaya_admin_nilai,
            denda_aktif, tanggal_jatuh_tempo, status, keterangan,
            approved_by, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'TIDAK_ADA', 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        pinjamanId,
        nomor,
        anggota.id,
        r.tanggalAkad,
        r.jumlahPinjamanAsli,
        susunan.tenor,
        r.satuanTenor,
        r.metodeJasa,
        r.persentaseJasa,
        jatuhTempoAkhir,
        r.status ?? 'AKTIF',
        keteranganMigrasi(opsi.tanggalCutOff, `Nomor lama: ${nomor}.`),
        opsi.createdBy,
        opsi.createdBy,
        now,
        now
      );

      const idJadwal = new Map<number, string>();
      for (const j of jadwal) {
        const id = newId();
        idJadwal.set(j.nomorAngsuran, id);
        const lunas = j.status === 'LUNAS';
        await db.runAsync(
          `INSERT INTO angsuran_jadwal
             (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo,
              pokok, jasa, denda, total, pokok_terbayar, jasa_terbayar, denda_terbayar, status, jasa_dimuka)
           VALUES (?,?,?,?,?,?,0,?,?,?,0,?,?)`,
          id,
          pinjamanId,
          j.nomorAngsuran,
          j.tanggalJatuhTempo,
          j.pokok,
          j.jasa,
          j.pokok + j.jasa,
          lunas ? j.pokok : 0,
          lunas ? j.jasa : 0,
          j.status,
          j.jasaDimuka ?? 0
        );
        totalJasaDimuka += j.jasaDimuka ?? 0;
      }
      totalTunggakanPokok += susunan.tunggakanPokok;

      // RC-S133.4.5 — Piutang Jasa per pinjaman didaftarkan per periode
      // (tanpa jurnal; sisi buku besarnya = saldo awal Piutang Jasa).
      // Tanpa ini akrual otomatis mengakui ULANG jasa yang sudah ada di
      // saldo awal Pendapatan Jasa (bug jasa ganda RC-S133.4.4).
      let carrying = 0;
      for (const a of alokasiPiutangJasaMigrasi(jadwal, Number(r.piutangJasa) || 0)) {
        await db.runAsync(
          `INSERT INTO pinjaman_akuntansi_jasa
             (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
              pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
              journal_id, idempotency_key, created_by, created_at, updated_at)
           VALUES (?,?,?,?, 'JASA_AKRUAL', ?, ?, 0, 0, ?, 'DIAKUI', NULL, ?, ?, ?, ?)`,
          newId(),
          pinjamanId,
          idJadwal.get(a.nomorAngsuran) ?? null,
          a.periode,
          carrying,
          a.jumlah,
          carrying + a.jumlah,
          `${pinjamanId}:${a.periode}:JASA_AKRUAL`,
          opsi.createdBy,
          now,
          now
        );
        carrying += a.jumlah;
      }

      berhasil.push({
        baris: r.baris,
        nomorPinjaman: nomor,
        keterangan: `${anggota.nomorAnggota} — ${anggota.nama}`,
        sisaPokok: r.sisaPokok,
        jumlahJadwal: belumLunas.length,
        jumlahTertunggak: belumLunas.filter((j) => j.status === 'TERLAMBAT' || j.tanggalJatuhTempo < opsi.tanggalCutOff).length,
        modeJadwal: susunan.mode,
        catatan,
      });

      selesai += 1;
      opsi.onKemajuan?.(selesai, total);
    }
  });

  const totalSisaPokok = berhasil.reduce((t, b) => t + b.sisaPokok, 0);
  const totalPiutangJasa = akanDiproses.reduce((t, r) => t + (Number(r.piutangJasa) || 0), 0);

  return {
    berhasil,
    gagal,
    dilewati: pra.dilewati,
    totalSisaPokok,
    // Dihitung ULANG setelah penulisan, supaya yang dilaporkan adalah
    // keadaan database yang sebenarnya, bukan perkiraan dari pratinjau.
    rekonsiliasi: rekonsiliasiPiutang({
      totalSisaPokokBukuPembantu: totalSisaPokok,
      saldoAwalPiutangPokok: await saldoAwalAkun(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG'),
      totalPiutangJasaBukuPembantu: totalPiutangJasa,
      saldoAwalPiutangJasa: await saldoAwalAkun(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA'),
    }),
    totalJasaDimuka,
    totalTunggakanPokok,
  };
}

/**
 * RC-S133.4.5 — hitung ULANG rekonsiliasi setelah Saldo Awal Akun terisi
 * otomatis. Dulu rekonsiliasi dibuat SEBELUM pengisian otomatis, sehingga
 * layar hasil import menyatakan "saldo awal belum diisi" padahal sesaat
 * kemudian sudah terisi.
 */
export async function rekonsiliasiUlangMigrasi(
  db: SQLite.SQLiteDatabase,
  totalSisaPokok: Rupiah,
  totalPiutangJasa: Rupiah
): Promise<RekonsiliasiPiutang> {
  return rekonsiliasiPiutang({
    totalSisaPokokBukuPembantu: totalSisaPokok,
    saldoAwalPiutangPokok: await saldoAwalAkun(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG'),
    totalPiutangJasaBukuPembantu: totalPiutangJasa,
    saldoAwalPiutangJasa: await saldoAwalAkun(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA'),
  });
}
