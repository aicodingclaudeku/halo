import { File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import {
  HeaderBackup,
  SlotPembungkus,
  UKURAN_SEGMEN_BAWAAN,
  PANJANG_KUNCI,
  PANJANG_NONCE,
  PANJANG_PREFIKS_NONCE,
  PANJANG_TAG,
  VERSI_FORMAT_SEKARANG,
  rakitPendahuluan,
  bacaPendahuluan,
  jumlahSegmen,
  ukuranPlaintextSegmen,
  kenaliJenisBerkas,
  JenisBerkasBackup,
  keBase64,
  dariBase64,
} from './FormatBackupTerenkripsi';
import {
  aadSegmen,
  buatSlot,
  bukaKunci,
  cariSlot,
  dekripsiSegmen,
  enkripsiSegmen,
  turunkanKunciDariKode,
  PARAMETER_SCRYPT_BAWAAN,
} from './MesinKriptoBackup';

/**
 * RC-S114 — BACA/TULIS BERKAS BACKUP TERENKRIPSI.
 *
 * Satu-satunya berkas di jalur ini yang menyentuh filesystem. Seluruh
 * keputusan kriptografinya ada di `MesinKriptoBackup` (murni, teruji);
 * di sini hanya urusan potongan byte masuk dan keluar berkas.
 *
 * ============================================================
 * KENAPA PER SEGMEN, BUKAN SEKALIGUS
 * ============================================================
 * Database koperasi bisa puluhan MB. Membacanya sekaligus berarti
 * menahan plaintext, ciphertext, dan (kalau lewat base64) salinan
 * teksnya sekaligus di memori — jalan tercepat menuju kehabisan memori
 * di perangkat murah, yang justru perangkat yang dipakai di lapangan.
 *
 * `File.open()` memberi FileHandle dengan `readBytes`/`writeBytes` dan
 * `offset` yang bisa digeser, sehingga puncak pemakaian memori tetap
 * sebesar satu segmen (1 MiB) berapa pun besar databasenya.
 */

export interface HasilTulisBackup {
  ukuranBerkas: number;
  totalSegmen: number;
}

/** Enkripsi `sumber` menjadi berkas backup di `tujuan`. */
export async function tulisBackupTerenkripsi(input: {
  sumberUri: string;
  tujuanUri: string;
  kunciPerangkat: Uint8Array;
  kodePemulihan: string;
  idInstalasi: string;
  skema: number | null;
  ukuranSegmen?: number;
  onKemajuan?: (selesai: number, total: number) => void;
}): Promise<HasilTulisBackup> {
  const ukuranSegmen = input.ukuranSegmen ?? UKURAN_SEGMEN_BAWAAN;
  const sumber = new File(input.sumberUri);
  const ukuranAsli = sumber.size ?? 0;
  const totalSegmen = jumlahSegmen(ukuranAsli, ukuranSegmen);

  const kunciBerkas = Crypto.getRandomBytes(PANJANG_KUNCI);
  const prefiksNonce = Crypto.getRandomBytes(PANJANG_PREFIKS_NONCE);
  const saltKode = Crypto.getRandomBytes(16);

  const pembungkus: SlotPembungkus[] = [
    buatSlot({
      jenis: 'PERANGKAT',
      kunciBerkas,
      kunciPembungkus: input.kunciPerangkat,
      nonce: Crypto.getRandomBytes(PANJANG_NONCE),
      idInstalasi: input.idInstalasi,
    }),
    buatSlot({
      jenis: 'KODE_PEMULIHAN',
      kunciBerkas,
      kunciPembungkus: turunkanKunciDariKode(input.kodePemulihan, saltKode),
      nonce: Crypto.getRandomBytes(PANJANG_NONCE),
      kdf: { ...PARAMETER_SCRYPT_BAWAAN, salt: keBase64(saltKode) },
    }),
  ];

  const header: HeaderBackup = {
    v: VERSI_FORMAT_SEKARANG,
    alg: 'xchacha20poly1305',
    ukuranSegmen,
    totalSegmen,
    ukuranAsli,
    prefiksNonce: keBase64(prefiksNonce),
    dibuatPada: new Date().toISOString(),
    skema: input.skema,
    pembungkus,
  };

  const pendahuluan = rakitPendahuluan(header);
  const aad = aadSegmen(pendahuluan);

  const tujuan = new File(input.tujuanUri);
  if (tujuan.exists) tujuan.delete();
  tujuan.create({ overwrite: true });

  const bacaan = sumber.open();
  const tulisan = tujuan.open();
  try {
    tulisan.writeBytes(pendahuluan);
    for (let i = 0; i < totalSegmen; i++) {
      bacaan.offset = i * ukuranSegmen;
      const panjang = ukuranPlaintextSegmen(header, i);
      const potongan = panjang > 0 ? bacaan.readBytes(panjang) : new Uint8Array(0);
      if (potongan.length !== panjang) {
        throw new Error('Pembacaan database terputus — ukuran potongan tidak sesuai.');
      }
      tulisan.writeBytes(
        enkripsiSegmen({
          plaintext: potongan,
          kunciBerkas,
          prefiksNonce,
          indeks: i,
          terakhir: i === totalSegmen - 1,
          aad,
        })
      );
      input.onKemajuan?.(i + 1, totalSegmen);
    }
  } finally {
    bacaan.close();
    tulisan.close();
  }

  return { ukuranBerkas: new File(input.tujuanUri).size ?? 0, totalSegmen };
}

export type CaraBuka = { jenis: 'PERANGKAT'; kunciPerangkat: Uint8Array } | { jenis: 'KODE_PEMULIHAN'; kode: string };

export interface InfoBerkasBackup {
  jenis: JenisBerkasBackup;
  header?: HeaderBackup;
  /** Untuk berkas terenkripsi: apakah slot perangkat ini yang membungkusnya. */
  dariPerangkatIni?: boolean;
}

const UKURAN_INTIP = 64 * 1024; // cukup untuk magic + header JSON

/** Kenali berkas tanpa membukanya: terenkripsi, SQLite lama, atau bukan keduanya. */
export function periksaBerkasBackup(uri: string, idInstalasi: string | null): InfoBerkasBackup {
  const berkas = new File(uri);
  if (!berkas.exists) return { jenis: 'TIDAK_DIKENAL' };
  const pegangan = berkas.open();
  let awal: Uint8Array;
  try {
    pegangan.offset = 0;
    awal = pegangan.readBytes(Math.min(UKURAN_INTIP, berkas.size ?? UKURAN_INTIP));
  } finally {
    pegangan.close();
  }

  const jenis = kenaliJenisBerkas(awal);
  if (jenis !== 'TERENKRIPSI') return { jenis };

  const { header } = bacaPendahuluan(awal);
  const slot = cariSlot(header, 'PERANGKAT');
  return {
    jenis,
    header,
    dariPerangkatIni: !!idInstalasi && slot?.idInstalasi === idInstalasi,
  };
}

/**
 * Dekripsi berkas backup ke `tujuanUri`.
 *
 * Kegagalan pada titik mana pun melempar SEBELUM berkas tujuan dipakai
 * pemanggil — dan pemanggil (BackupService) tidak pernah menyentuh
 * database aktif sampai berkas hasil dekripsi lolos validasi.
 */
export async function dekripsiBackupKeBerkas(input: {
  sumberUri: string;
  tujuanUri: string;
  cara: CaraBuka;
  onKemajuan?: (selesai: number, total: number) => void;
}): Promise<void> {
  const sumber = new File(input.sumberUri);
  if (!sumber.exists) throw new Error('Berkas backup tidak ditemukan.');

  const pegangan = sumber.open();
  let pendahuluanBytes: Uint8Array;
  try {
    pegangan.offset = 0;
    pendahuluanBytes = pegangan.readBytes(Math.min(UKURAN_INTIP, sumber.size ?? UKURAN_INTIP));
  } finally {
    pegangan.close();
  }

  const { header, bytesPendahuluan, offsetData } = bacaPendahuluan(pendahuluanBytes);
  const kunciBerkas = bukaKunciBerkas(header, input.cara);
  const aad = aadSegmen(bytesPendahuluan);
  const prefiks = dariBase64(header.prefiksNonce);

  const tujuan = new File(input.tujuanUri);
  if (tujuan.exists) tujuan.delete();
  tujuan.create({ overwrite: true });

  const bacaan = sumber.open();
  const tulisan = tujuan.open();
  try {
    let posisi = offsetData;
    for (let i = 0; i < header.totalSegmen; i++) {
      const panjangCipher = ukuranPlaintextSegmen(header, i) + PANJANG_TAG;
      bacaan.offset = posisi;
      const potongan = bacaan.readBytes(panjangCipher);
      if (potongan.length !== panjangCipher) {
        throw new Error('Berkas backup terpotong — segmen tidak lengkap.');
      }
      tulisan.writeBytes(
        dekripsiSegmen({
          ciphertext: potongan,
          kunciBerkas,
          prefiksNonce: prefiks,
          indeks: i,
          terakhir: i === header.totalSegmen - 1,
          aad,
        })
      );
      posisi += panjangCipher;
      input.onKemajuan?.(i + 1, header.totalSegmen);
    }
  } finally {
    bacaan.close();
    tulisan.close();
  }

  const hasil = new File(input.tujuanUri);
  if ((hasil.size ?? -1) !== header.ukuranAsli) {
    hasil.delete();
    throw new Error('Ukuran hasil pemulihan tidak sesuai dengan yang tercatat di berkas backup.');
  }
}

function bukaKunciBerkas(header: HeaderBackup, cara: CaraBuka): Uint8Array {
  if (cara.jenis === 'PERANGKAT') {
    const slot = cariSlot(header, 'PERANGKAT');
    if (!slot) throw new Error('Backup ini tidak punya kunci perangkat.');
    return bukaKunci(slot, cara.kunciPerangkat);
  }
  const slot = cariSlot(header, 'KODE_PEMULIHAN');
  if (!slot || !slot.kdf) throw new Error('Backup ini tidak punya slot kode pemulihan.');
  return bukaKunci(slot, turunkanKunciDariKode(cara.kode, dariBase64(slot.kdf.salt), slot.kdf));
}
