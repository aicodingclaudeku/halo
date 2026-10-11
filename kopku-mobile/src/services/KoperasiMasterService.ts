import { getDb, withTransaction } from '@/database/db';
import { newId } from '@/utils/id';
import {
  JABATAN_PENGURUS_INTI,
  KandidatPengurus,
  LABEL_JABATAN_PENGURUS,
  SusunanPengurusInti,
  kenaliJabatanPengurusInti,
  masaJabatanTumpangTindih,
  pilihSusunanPengurusInti,
} from '@/services/PengurusInti';

/**
 * ============================================================
 * MASTER DATA IDENTITAS KOPERASI (v60)
 * ============================================================
 *
 * Empat master: personel, perizinan, unit usaha, peraturan internal.
 *
 * SATU BERKAS, BUKAN EMPAT SERVICE TERPISAH. Keempatnya adalah CRUD
 * murni di atas tabel yang tidak saling bergantung, tanpa jurnal, tanpa
 * kalkulasi, dan tanpa aturan lintas-master. Memecahnya menjadi empat
 * berkas hanya akan menyalin kerangka yang sama empat kali. Kalau kelak
 * salah satu tumbuh punya aturan bisnis sendiri, memisahnya saat itu
 * jauh lebih murah daripada menyatukannya kembali sekarang.
 *
 * TIDAK ADA HARD DELETE di mana pun di sini. Baris master yang sudah
 * pernah dirujuk transaksi tidak boleh hilang — yang tersedia hanyalah
 * perubahan status. `id` bersifat IMMUTABLE dan itulah yang dipakai
 * fase berikutnya sebagai foreign key; nama boleh berubah kapan saja.
 *
 * TIDAK MENYENTUH `koperasi`. Identitas koperasi tetap milik
 * `SetupService` — lihat catatan isolasi di sana.
 */

// ===========================================================================
// PERSONEL
// ===========================================================================

export type JenisPersonel = 'PENGURUS' | 'PENGAWAS' | 'PENGELOLA' | 'KARYAWAN' | 'PEKERJA';

export const JENIS_PERSONEL: readonly JenisPersonel[] = [
  'PENGURUS',
  'PENGAWAS',
  'PENGELOLA',
  'KARYAWAN',
  'PEKERJA',
];

/**
 * ASAL ORANGNYA — bukan jenis jabatannya (`jenisPersonel`).
 * Seorang Ketua Pengurus bisa `ANGGOTA`; seorang akuntan sewaan bisa `LUAR`.
 */
export type SumberDataPersonel = 'ANGGOTA' | 'LUAR';

export const SUMBER_DATA_PERSONEL: readonly SumberDataPersonel[] = ['ANGGOTA', 'LUAR'];

/** Label yang dipakai UI. Istilahnya dikunci di sini supaya tidak muncul varian "Eksternal"/"Non Member". */
export const LABEL_SUMBER_DATA: Record<SumberDataPersonel, string> = {
  ANGGOTA: 'Anggota Koperasi',
  LUAR: 'Pihak Luar',
};

export interface PersonelInput {
  nama: string;
  jenisPersonel: JenisPersonel;
  /** Default `LUAR` bila tidak diisi — sama dengan default kolomnya. */
  sumberData?: SumberDataPersonel;
  /** WAJIB bila `sumberData === 'ANGGOTA'`, WAJIB null bila `'LUAR'`. */
  anggotaId?: string | null;
  jenisKelamin?: 'L' | 'P' | null;
  jabatan?: string | null;
  tanggalMulaiJabatan?: string | null;
  tanggalBerakhirJabatan?: string | null;
  /** NIK PERORANGAN (KTP) — bukan Nomor Induk Koperasi. */
  nik?: string | null;
  nomorTelepon?: string | null;
  alamat?: string | null;
}

export interface PersonelRow extends PersonelInput {
  id: string;
  sumberData: SumberDataPersonel;
  anggotaId: string | null;
  statusAktif: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Buang spasi tepi; string kosong menjadi `null`, bukan `''`. */
function bersih(nilai: string | null | undefined): string | null {
  if (nilai === null || nilai === undefined) return null;
  const t = nilai.trim();
  return t === '' ? null : t;
}

/** Sumber data efektif — baris/imput lama tanpa nilai dianggap `LUAR`, sama dengan default kolom. */
function sumberDataDari(input: Pick<PersonelInput, 'sumberData'>): SumberDataPersonel {
  return input.sumberData ?? 'LUAR';
}

function validasiPersonel(input: PersonelInput): void {
  const sumber = sumberDataDari(input);
  if (!SUMBER_DATA_PERSONEL.includes(sumber)) {
    throw new Error(`Sumber data personel tidak dikenali: ${String(sumber)}.`);
  }
  // Nama WAJIB hanya pada mode LUAR. Pada mode ANGGOTA nama tidak pernah
  // dipakai: `identitasUntukSimpan()` menimpanya dengan snapshot dari
  // baris anggota, jadi mewajibkannya di sini berarti menuntut data yang
  // dijamin dibuang — dan menolak penyimpanan yang sebenarnya sah.
  // Identitas pada mode ANGGOTA dijaga oleh syarat `anggotaId` di bawah
  // plus `ambilSnapshotAnggota()` yang melempar bila anggotanya tidak ada.
  if (sumber === 'LUAR' && bersih(input.nama) === null) {
    throw new Error('Nama personel wajib diisi.');
  }
  // Dua arah, bukan hanya satu: `anggotaId` yang tertinggal saat mode
  // diubah ke LUAR adalah tautan basi ke orang yang tidak lagi dipilih.
  if (sumber === 'ANGGOTA' && bersih(input.anggotaId) === null) {
    throw new Error('Anggota wajib dipilih bila sumber data personel adalah Anggota Koperasi.');
  }
  if (sumber === 'LUAR' && bersih(input.anggotaId) !== null) {
    throw new Error('Personel Pihak Luar tidak boleh terhubung ke data anggota.');
  }
  if (!JENIS_PERSONEL.includes(input.jenisPersonel)) {
    throw new Error(`Jenis personel tidak dikenali: ${String(input.jenisPersonel)}.`);
  }
  const mulai = bersih(input.tanggalMulaiJabatan);
  const akhir = bersih(input.tanggalBerakhirJabatan);
  // Diperiksa HANYA bila keduanya ada: jabatan yang masih berjalan
  // memang tidak punya tanggal berakhir, dan itu bukan kesalahan.
  if (mulai !== null && akhir !== null && akhir < mulai) {
    throw new Error(
      `Tanggal berakhir jabatan (${akhir}) tidak boleh mendahului tanggal mulai (${mulai}).`
    );
  }
}

function petakanPersonel(r: Record<string, unknown>): PersonelRow {
  return {
    id: r.id as string,
    nama: r.nama as string,
    jenisPersonel: r.jenis_personel as JenisPersonel,
    // Baris pra-v70 (kolomnya belum ada / NULL) dibaca sebagai LUAR —
    // bukan klaim, melainkan "hubungan ke anggota tidak diketahui".
    sumberData: ((r.sumber_data as SumberDataPersonel | null) ?? 'LUAR'),
    anggotaId: (r.anggota_id as string | null) ?? null,
    jenisKelamin: (r.jenis_kelamin as 'L' | 'P' | null) ?? null,
    jabatan: (r.jabatan as string | null) ?? null,
    tanggalMulaiJabatan: (r.tanggal_mulai_jabatan as string | null) ?? null,
    tanggalBerakhirJabatan: (r.tanggal_berakhir_jabatan as string | null) ?? null,
    nik: (r.nik as string | null) ?? null,
    nomorTelepon: (r.nomor_telepon as string | null) ?? null,
    alamat: (r.alamat as string | null) ?? null,
    statusAktif: (r.status_aktif as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * SNAPSHOT IDENTITAS — inti dari mengapa kolom `nama`/`nik`/dll TETAP
 * ada walau `anggota_id` terisi.
 *
 * Saat personel berasal dari anggota, identitasnya DISALIN ke baris
 * personel, bukan dibaca lewat JOIN setiap kali. Konsekuensinya
 * disengaja: memperbarui master Anggota TIDAK menulis ulang histori
 * jabatan. Susunan pengurus periode lalu harus tetap menunjukkan data
 * sebagaimana tercatat saat itu; memperbaiki alamat seorang anggota
 * hari ini tidak boleh diam-diam mengubah dokumen kepengurusan yang
 * sudah berjalan. Menautkan ulang secara eksplisit lewat form adalah
 * satu-satunya cara snapshot diperbarui.
 *
 * Melempar bila anggota tidak ada — id yang tidak dapat diverifikasi
 * lebih buruk daripada penyimpanan yang gagal.
 */
async function ambilSnapshotAnggota(
  db: Awaited<ReturnType<typeof getDb>>,
  anggotaId: string
): Promise<Pick<PersonelInput, 'nama' | 'jenisKelamin' | 'nik' | 'nomorTelepon' | 'alamat'>> {
  const a = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT nama_lengkap, jenis_kelamin, nik, nomor_hp, alamat FROM anggota WHERE id = ?`,
    anggotaId
  );
  if (!a) throw new Error('Anggota yang dipilih tidak ditemukan.');
  // Dua tabel memakai domain BERBEDA untuk hal yang sama, dan itu
  // tidak boleh disamakan diam-diam:
  //   anggota.jenis_kelamin        -> 'LAKI_LAKI' | 'PEREMPUAN'
  //   koperasi_personel.jenis_kelamin -> 'L' | 'P'  (CHECK constraint)
  // Nilai di luar keduanya (NULL / data lama) tetap NULL, bukan ditebak.
  const jk = (a.jenis_kelamin as string | null) ?? null;
  const jenisKelamin: 'L' | 'P' | null = jk === 'LAKI_LAKI' ? 'L' : jk === 'PEREMPUAN' ? 'P' : null;
  return {
    nama: (a.nama_lengkap as string) ?? '',
    jenisKelamin,
    nik: (a.nik as string | null) ?? null,
    // Kolomnya bernama `nomor_hp` di `anggota`, `nomor_telepon` di personel.
    nomorTelepon: (a.nomor_hp as string | null) ?? null,
    alamat: (a.alamat as string | null) ?? null,
  };
}

/**
 * Nilai identitas yang benar-benar ditulis: dari anggota (mode ANGGOTA)
 * atau dari input manual (mode LUAR). Satu tempat, supaya insert dan
 * update tidak bisa berbeda perilaku.
 */
async function identitasUntukSimpan(
  db: Awaited<ReturnType<typeof getDb>>,
  input: PersonelInput
): Promise<{ sumber: SumberDataPersonel; anggotaId: string | null; identitas: Pick<PersonelInput, 'nama' | 'jenisKelamin' | 'nik' | 'nomorTelepon' | 'alamat'> }> {
  const sumber = sumberDataDari(input);
  if (sumber === 'ANGGOTA') {
    const anggotaId = bersih(input.anggotaId)!;
    return { sumber, anggotaId, identitas: await ambilSnapshotAnggota(db, anggotaId) };
  }
  return {
    sumber,
    // LUAR: tautan DIPUTUS, bukan sekadar diabaikan.
    anggotaId: null,
    identitas: {
      nama: input.nama,
      jenisKelamin: input.jenisKelamin ?? null,
      nik: input.nik ?? null,
      nomorTelepon: input.nomorTelepon ?? null,
      alamat: input.alamat ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// RC-S82 (lanjutan) — PENGURUS INTI (Ketua / Sekretaris / Bendahara)
// ---------------------------------------------------------------------------

/**
 * Jabatan yang DISIMPAN. Untuk PENGURUS dengan jabatan inti, teksnya
 * dikanonikkan ("ketua pengurus" -> "Ketua") agar dokumen & laporan
 * seragam. Jabatan lain (dan jenis personel lain) disimpan apa adanya.
 */
function jabatanUntukSimpan(input: PersonelInput): string | null {
  if (input.jenisPersonel === 'PENGURUS') {
    const inti = kenaliJabatanPengurusInti(input.jabatan);
    if (inti) return LABEL_JABATAN_PENGURUS[inti];
  }
  return bersih(input.jabatan);
}

/**
 * Satu jabatan inti = satu orang pada satu waktu. Ditolak bila ada
 * PENGURUS AKTIF LAIN dengan jabatan inti yang sama dan masa jabatan
 * yang tumpang-tindih. Pergantian pengurus dilakukan dengan mengisi
 * "tanggal berakhir jabatan" pejabat lama (histori tetap tersimpan).
 */
async function pastikanJabatanIntiUnik(
  db: Awaited<ReturnType<typeof getDb>>,
  calon: Pick<KandidatPengurus, 'jabatan' | 'jenisPersonel' | 'tanggalMulaiJabatan' | 'tanggalBerakhirJabatan'>,
  idSendiri: string | null
): Promise<void> {
  if (calon.jenisPersonel !== 'PENGURUS') return;
  const inti = kenaliJabatanPengurusInti(calon.jabatan);
  if (!inti) return;
  const lain = await db.getAllAsync<Record<string, unknown>>(
    `SELECT id, nama, jabatan, tanggal_mulai_jabatan, tanggal_berakhir_jabatan
       FROM koperasi_personel
      WHERE jenis_personel = 'PENGURUS' AND status_aktif = 1 AND id <> ?`,
    idSendiri ?? ''
  );
  for (const r of lain) {
    if (kenaliJabatanPengurusInti(r.jabatan as string | null) !== inti) continue;
    const bentrok = masaJabatanTumpangTindih(calon, {
      tanggalMulaiJabatan: (r.tanggal_mulai_jabatan as string | null) ?? null,
      tanggalBerakhirJabatan: (r.tanggal_berakhir_jabatan as string | null) ?? null,
    });
    if (bentrok) {
      throw new Error(
        `Jabatan ${LABEL_JABATAN_PENGURUS[inti]} sudah dipegang oleh ${String(r.nama)} pada masa jabatan yang sama. ` +
          `Isi tanggal berakhir jabatan ${String(r.nama)} (atau nonaktifkan) terlebih dahulu, lalu tetapkan pejabat baru ` +
          'dengan tanggal mulai setelahnya.'
      );
    }
  }
}

/**
 * Susunan pengurus inti yang MENJABAT pada `tanggal` (YYYY-MM-DD).
 * Read-only. Dipakai dokumen perjanjian pinjaman (tanggal = tanggal akad)
 * dan kartu "Susunan Pengurus" di menu Pengurus (tanggal = hari ini).
 */
export async function getSusunanPengurusInti(tanggal: string): Promise<SusunanPengurusInti> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT id, nama, jabatan, jenis_personel, status_aktif, tanggal_mulai_jabatan,
            tanggal_berakhir_jabatan, updated_at
       FROM koperasi_personel
      WHERE jenis_personel = 'PENGURUS'`
  );
  return pilihSusunanPengurusInti(
    rows.map((r) => ({
      id: r.id as string,
      nama: r.nama as string,
      jabatan: (r.jabatan as string | null) ?? null,
      jenisPersonel: r.jenis_personel as string,
      statusAktif: (r.status_aktif as number) === 1,
      tanggalMulaiJabatan: (r.tanggal_mulai_jabatan as string | null) ?? null,
      tanggalBerakhirJabatan: (r.tanggal_berakhir_jabatan as string | null) ?? null,
      updatedAt: r.updated_at as string,
    })),
    tanggal
  );
}

export { JABATAN_PENGURUS_INTI, LABEL_JABATAN_PENGURUS };

export async function buatPersonel(input: PersonelInput): Promise<string> {
  validasiPersonel(input);
  return withTransaction(async (db) => {
    const id = newId();
    const now = new Date().toISOString();
    await pastikanJabatanIntiUnik(
      db,
      {
        jabatan: input.jabatan ?? null,
        jenisPersonel: input.jenisPersonel,
        tanggalMulaiJabatan: bersih(input.tanggalMulaiJabatan),
        tanggalBerakhirJabatan: bersih(input.tanggalBerakhirJabatan),
      },
      null
    );
    const { sumber, anggotaId, identitas } = await identitasUntukSimpan(db, input);
    await db.runAsync(
      `INSERT INTO koperasi_personel
        (id, nama, jenis_kelamin, jabatan, tanggal_mulai_jabatan, tanggal_berakhir_jabatan,
         nik, nomor_telepon, alamat, jenis_personel, sumber_data, anggota_id,
         status_aktif, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      id,
      bersih(identitas.nama),
      bersih(identitas.jenisKelamin),
      jabatanUntukSimpan(input),
      bersih(input.tanggalMulaiJabatan),
      bersih(input.tanggalBerakhirJabatan),
      bersih(identitas.nik),
      bersih(identitas.nomorTelepon),
      bersih(identitas.alamat),
      input.jenisPersonel,
      sumber,
      anggotaId,
      now,
      now
    );
    return id;
  });
}

export async function getPersonel(id: string): Promise<PersonelRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_personel WHERE id = ?`,
    id
  );
  return r ? petakanPersonel(r) : null;
}

export async function listPersonel(opts: {
  jenisPersonel?: JenisPersonel;
  hanyaAktif?: boolean;
} = {}): Promise<PersonelRow[]> {
  const db = await getDb();
  const filter: string[] = [];
  const params: (string | number)[] = [];
  if (opts.jenisPersonel) {
    filter.push('jenis_personel = ?');
    params.push(opts.jenisPersonel);
  }
  if (opts.hanyaAktif) filter.push('status_aktif = 1');
  const where = filter.length > 0 ? `WHERE ${filter.join(' AND ')}` : '';
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_personel ${where} ORDER BY nama ASC`,
    ...params
  );
  return rows.map(petakanPersonel);
}

export async function perbaruiPersonel(id: string, input: PersonelInput): Promise<void> {
  validasiPersonel(input);
  await withTransaction(async (db) => {
    const ada = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM koperasi_personel WHERE id = ?`,
      id
    );
    if (!ada) throw new Error('Personel tidak ditemukan.');
    const statusRow = await db.getFirstAsync<{ status_aktif: number }>(
      `SELECT status_aktif FROM koperasi_personel WHERE id = ?`,
      id
    );
    if (statusRow?.status_aktif === 1) {
      await pastikanJabatanIntiUnik(
        db,
        {
          jabatan: input.jabatan ?? null,
          jenisPersonel: input.jenisPersonel,
          tanggalMulaiJabatan: bersih(input.tanggalMulaiJabatan),
          tanggalBerakhirJabatan: bersih(input.tanggalBerakhirJabatan),
        },
        id
      );
    }
    // `id` TIDAK PERNAH berubah di sini — `personel_id` pada transaksi
    // historis (mis. Imbalan Kerja) tetap menunjuk baris yang sama.
    const { sumber, anggotaId, identitas } = await identitasUntukSimpan(db, input);
    await db.runAsync(
      `UPDATE koperasi_personel
          SET nama = ?, jenis_kelamin = ?, jabatan = ?, tanggal_mulai_jabatan = ?,
              tanggal_berakhir_jabatan = ?, nik = ?, nomor_telepon = ?, alamat = ?,
              jenis_personel = ?, sumber_data = ?, anggota_id = ?, updated_at = ?
        WHERE id = ?`,
      bersih(identitas.nama),
      bersih(identitas.jenisKelamin),
      jabatanUntukSimpan(input),
      bersih(input.tanggalMulaiJabatan),
      bersih(input.tanggalBerakhirJabatan),
      bersih(identitas.nik),
      bersih(identitas.nomorTelepon),
      bersih(identitas.alamat),
      input.jenisPersonel,
      sumber,
      anggotaId,
      new Date().toISOString(),
      id
    );
  });
}

/**
 * Nonaktifkan personel — PENGGANTI penghapusan.
 *
 * Barisnya tetap ada sehingga transaksi historis yang menunjuk
 * `personel_id` ini tidak pernah menjadi yatim.
 */
export async function setStatusPersonel(id: string, aktif: boolean): Promise<void> {
  await withTransaction(async (db) => {
    if (aktif) {
      // Mengaktifkan kembali tidak boleh menghasilkan dua Ketua/Sekretaris/Bendahara sekaligus.
      const r = await db.getFirstAsync<Record<string, unknown>>(
        `SELECT jabatan, jenis_personel, tanggal_mulai_jabatan, tanggal_berakhir_jabatan
           FROM koperasi_personel WHERE id = ?`,
        id
      );
      if (r) {
        await pastikanJabatanIntiUnik(
          db,
          {
            jabatan: (r.jabatan as string | null) ?? null,
            jenisPersonel: r.jenis_personel as string,
            tanggalMulaiJabatan: (r.tanggal_mulai_jabatan as string | null) ?? null,
            tanggalBerakhirJabatan: (r.tanggal_berakhir_jabatan as string | null) ?? null,
          },
          id
        );
      }
    }
    const hasil = await db.runAsync(
      `UPDATE koperasi_personel SET status_aktif = ?, updated_at = ? WHERE id = ?`,
      aktif ? 1 : 0,
      new Date().toISOString(),
      id
    );
    if (hasil.changes === 0) throw new Error('Personel tidak ditemukan.');
  });
}

// ===========================================================================
// PERIZINAN
// ===========================================================================

export type StatusPerizinan = 'AKTIF' | 'KEDALUWARSA' | 'DICABUT';

export interface PerizinanInput {
  namaIzin: string;
  nomorIzin?: string | null;
  tanggalTerbit?: string | null;
  berlakuSampai?: string | null;
  instansiPenerbit?: string | null;
  status?: StatusPerizinan;
  catatan?: string | null;
}

/**
 * RC-S72 — `Required<...>`: baris yang DIBACA dari database selalu memuat setiap
 * kolom; kolom nullable dipetakan ke `null` (lihat `petakan*`), tidak pernah
 * `undefined`. Tanpa `Required`, Row mewarisi `?:` milik tipe INPUT sehingga
 * tipenya `string | null | undefined` — lebih longgar dari kontrak data aktual.
 */
export interface PerizinanRow extends Required<Omit<PerizinanInput, 'status'>> {
  id: string;
  status: StatusPerizinan;
  createdAt: string;
  updatedAt: string;
}

function validasiPerizinan(input: PerizinanInput): void {
  if (bersih(input.namaIzin) === null) throw new Error('Nama izin wajib diisi.');
  const terbit = bersih(input.tanggalTerbit);
  const sampai = bersih(input.berlakuSampai);
  if (terbit !== null && sampai !== null && sampai < terbit) {
    throw new Error(`Masa berlaku (${sampai}) tidak boleh mendahului tanggal terbit (${terbit}).`);
  }
}

function petakanPerizinan(r: Record<string, unknown>): PerizinanRow {
  return {
    id: r.id as string,
    namaIzin: r.nama_izin as string,
    nomorIzin: (r.nomor_izin as string | null) ?? null,
    tanggalTerbit: (r.tanggal_terbit as string | null) ?? null,
    berlakuSampai: (r.berlaku_sampai as string | null) ?? null,
    instansiPenerbit: (r.instansi_penerbit as string | null) ?? null,
    status: r.status as StatusPerizinan,
    catatan: (r.catatan as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function buatPerizinan(input: PerizinanInput): Promise<string> {
  validasiPerizinan(input);
  return withTransaction(async (db) => {
    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO koperasi_perizinan
        (id, nama_izin, nomor_izin, tanggal_terbit, berlaku_sampai, instansi_penerbit,
         status, catatan, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      bersih(input.namaIzin),
      bersih(input.nomorIzin),
      bersih(input.tanggalTerbit),
      bersih(input.berlakuSampai),
      bersih(input.instansiPenerbit),
      input.status ?? 'AKTIF',
      bersih(input.catatan),
      now,
      now
    );
    return id;
  });
}

export async function getPerizinan(id: string): Promise<PerizinanRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_perizinan WHERE id = ?`,
    id
  );
  return r ? petakanPerizinan(r) : null;
}

export async function listPerizinan(): Promise<PerizinanRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_perizinan ORDER BY berlaku_sampai IS NULL, berlaku_sampai ASC, nama_izin ASC`
  );
  return rows.map(petakanPerizinan);
}

export async function perbaruiPerizinan(id: string, input: PerizinanInput): Promise<void> {
  validasiPerizinan(input);
  await withTransaction(async (db) => {
    const hasil = await db.runAsync(
      `UPDATE koperasi_perizinan
          SET nama_izin = ?, nomor_izin = ?, tanggal_terbit = ?, berlaku_sampai = ?,
              instansi_penerbit = ?, status = ?, catatan = ?, updated_at = ?
        WHERE id = ?`,
      bersih(input.namaIzin),
      bersih(input.nomorIzin),
      bersih(input.tanggalTerbit),
      bersih(input.berlakuSampai),
      bersih(input.instansiPenerbit),
      input.status ?? 'AKTIF',
      bersih(input.catatan),
      new Date().toISOString(),
      id
    );
    if (hasil.changes === 0) throw new Error('Data perizinan tidak ditemukan.');
  });
}

// ===========================================================================
// UNIT USAHA
// ===========================================================================

export type StatusUnitUsaha = 'AKTIF' | 'NONAKTIF';

export interface UnitUsahaInput {
  namaUsaha: string;
  jenisUsaha?: string | null;
  alamat?: string | null;
  status?: StatusUnitUsaha;
}

/**
 * RC-S72 — `Required<...>`: baris yang DIBACA dari database selalu memuat setiap
 * kolom; kolom nullable dipetakan ke `null` (lihat `petakan*`), tidak pernah
 * `undefined`. Tanpa `Required`, Row mewarisi `?:` milik tipe INPUT sehingga
 * tipenya `string | null | undefined` — lebih longgar dari kontrak data aktual.
 */
export interface UnitUsahaRow extends Required<Omit<UnitUsahaInput, 'status'>> {
  /** `id_unit_usaha` — IMMUTABLE, dipakai RAKU sebagai foreign key. */
  id: string;
  status: StatusUnitUsaha;
  createdAt: string;
  updatedAt: string;
}

function petakanUnitUsaha(r: Record<string, unknown>): UnitUsahaRow {
  return {
    id: r.id as string,
    namaUsaha: r.nama_usaha as string,
    jenisUsaha: (r.jenis_usaha as string | null) ?? null,
    alamat: (r.alamat as string | null) ?? null,
    status: r.status as StatusUnitUsaha,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function buatUnitUsaha(input: UnitUsahaInput): Promise<string> {
  if (bersih(input.namaUsaha) === null) throw new Error('Nama unit usaha wajib diisi.');
  return withTransaction(async (db) => {
    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO koperasi_unit_usaha (id, nama_usaha, jenis_usaha, alamat, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      id,
      bersih(input.namaUsaha),
      bersih(input.jenisUsaha),
      bersih(input.alamat),
      input.status ?? 'AKTIF',
      now,
      now
    );
    return id;
  });
}

export async function getUnitUsaha(id: string): Promise<UnitUsahaRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_unit_usaha WHERE id = ?`,
    id
  );
  return r ? petakanUnitUsaha(r) : null;
}

export async function listUnitUsaha(hanyaAktif = false): Promise<UnitUsahaRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_unit_usaha ${hanyaAktif ? "WHERE status = 'AKTIF'" : ''} ORDER BY nama_usaha ASC`
  );
  return rows.map(petakanUnitUsaha);
}

/**
 * Perbarui unit usaha. `id` SENGAJA tidak termasuk yang dapat diubah —
 * ia sudah menjadi referensi transaksi di fase berikutnya.
 */
export async function perbaruiUnitUsaha(id: string, input: UnitUsahaInput): Promise<void> {
  if (bersih(input.namaUsaha) === null) throw new Error('Nama unit usaha wajib diisi.');
  await withTransaction(async (db) => {
    const hasil = await db.runAsync(
      `UPDATE koperasi_unit_usaha
          SET nama_usaha = ?, jenis_usaha = ?, alamat = ?, status = ?, updated_at = ?
        WHERE id = ?`,
      bersih(input.namaUsaha),
      bersih(input.jenisUsaha),
      bersih(input.alamat),
      input.status ?? 'AKTIF',
      new Date().toISOString(),
      id
    );
    if (hasil.changes === 0) throw new Error('Unit usaha tidak ditemukan.');
  });
}

export async function setStatusUnitUsaha(id: string, status: StatusUnitUsaha): Promise<void> {
  await withTransaction(async (db) => {
    const hasil = await db.runAsync(
      `UPDATE koperasi_unit_usaha SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      new Date().toISOString(),
      id
    );
    if (hasil.changes === 0) throw new Error('Unit usaha tidak ditemukan.');
  });
}

// ===========================================================================
// PERATURAN INTERNAL
// ===========================================================================

export type StatusPeraturan = 'BERLAKU' | 'DICABUT' | 'DIGANTI';

export interface PeraturanInput {
  namaDokumen: string;
  jenisDokumen?: string | null;
  nomor?: string | null;
  yangMenetapkan?: string | null;
  status?: StatusPeraturan;
  catatan?: string | null;
}

/**
 * RC-S72 — `Required<...>`: baris yang DIBACA dari database selalu memuat setiap
 * kolom; kolom nullable dipetakan ke `null` (lihat `petakan*`), tidak pernah
 * `undefined`. Tanpa `Required`, Row mewarisi `?:` milik tipe INPUT sehingga
 * tipenya `string | null | undefined` — lebih longgar dari kontrak data aktual.
 */
export interface PeraturanRow extends Required<Omit<PeraturanInput, 'status'>> {
  id: string;
  status: StatusPeraturan;
  createdAt: string;
  updatedAt: string;
}

function petakanPeraturan(r: Record<string, unknown>): PeraturanRow {
  return {
    id: r.id as string,
    namaDokumen: r.nama_dokumen as string,
    jenisDokumen: (r.jenis_dokumen as string | null) ?? null,
    nomor: (r.nomor as string | null) ?? null,
    yangMenetapkan: (r.yang_menetapkan as string | null) ?? null,
    status: r.status as StatusPeraturan,
    catatan: (r.catatan as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function buatPeraturan(input: PeraturanInput): Promise<string> {
  if (bersih(input.namaDokumen) === null) throw new Error('Nama dokumen wajib diisi.');
  return withTransaction(async (db) => {
    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO koperasi_peraturan_internal
        (id, nama_dokumen, jenis_dokumen, nomor, yang_menetapkan, status, catatan, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      bersih(input.namaDokumen),
      bersih(input.jenisDokumen),
      bersih(input.nomor),
      bersih(input.yangMenetapkan),
      input.status ?? 'BERLAKU',
      bersih(input.catatan),
      now,
      now
    );
    return id;
  });
}

export async function getPeraturan(id: string): Promise<PeraturanRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_peraturan_internal WHERE id = ?`,
    id
  );
  return r ? petakanPeraturan(r) : null;
}

export async function listPeraturan(): Promise<PeraturanRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM koperasi_peraturan_internal ORDER BY nama_dokumen ASC`
  );
  return rows.map(petakanPeraturan);
}

export async function perbaruiPeraturan(id: string, input: PeraturanInput): Promise<void> {
  if (bersih(input.namaDokumen) === null) throw new Error('Nama dokumen wajib diisi.');
  await withTransaction(async (db) => {
    const hasil = await db.runAsync(
      `UPDATE koperasi_peraturan_internal
          SET nama_dokumen = ?, jenis_dokumen = ?, nomor = ?, yang_menetapkan = ?,
              status = ?, catatan = ?, updated_at = ?
        WHERE id = ?`,
      bersih(input.namaDokumen),
      bersih(input.jenisDokumen),
      bersih(input.nomor),
      bersih(input.yangMenetapkan),
      input.status ?? 'BERLAKU',
      bersih(input.catatan),
      new Date().toISOString(),
      id
    );
    if (hasil.changes === 0) throw new Error('Peraturan internal tidak ditemukan.');
  });
}
