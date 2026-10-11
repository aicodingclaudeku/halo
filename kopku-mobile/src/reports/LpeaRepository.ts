import * as SQLite from 'expo-sqlite';
import { Rupiah } from '@/utils/money';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import type { SatuanTenor } from '@/accounting/PinjamanCalculator';
import {
  BagianShuLpea,
  BarisPea,
  KomponenPea,
  ParameterLpea,
  susunHasilKomponen,
  tarifPinjamanKePerBulan,
  tarifTahunanKePerBulan,
  HasilKomponenPea,
} from './LpeaPlan';

/**
 * RC-S101 — PENGAMBILAN DATA AKTUAL UNTUK LPEA.
 *
 * Menerima `db` sebagai parameter (tidak memanggil `getDb`) supaya dapat
 * diuji langsung terhadap SQLite sungguhan — konvensi yang sama dengan
 * `ResetDataTransaksi` dan `RiwayatImportRepository`.
 *
 * TIDAK ADA perhitungan manfaat di berkas ini: seluruh rumus ada di
 * `LpeaPlan`. Tugas berkas ini hanya menyiapkan BASIS (a) dan TARIF
 * KOPERASI (b) dari data yang benar-benar tercatat, lalu menyerahkannya
 * ke mesin murni itu. Dengan begitu tidak ada rumus yang hidup di dua
 * tempat.
 *
 * TIDAK ADA perubahan skema untuk fitur ini: seluruh angka dibaca dari
 * tabel yang sudah ada (`pinjaman`, `angsuran_jadwal`,
 * `simpanan_transaksi`, `simpanan_berjangka`, `shu_konfigurasi`,
 * `shu_anggota`), dan parameter tarif disimpan di `app_config` yang juga
 * sudah ada.
 */

// ===========================================================================
// PARAMETER — DISIMPAN DI app_config (TANPA TABEL BARU)
// ===========================================================================

export const PREFIKS_KONFIG_LPEA = 'lpea.parameter.';

export function kunciKonfigLpea(tahunBuku: number): string {
  return `${PREFIKS_KONFIG_LPEA}${tahunBuku}`;
}

/**
 * Baca parameter tarif. Mengembalikan `null` bila belum pernah diisi —
 * dibedakan dari "diisi tapi nol", karena nol adalah tarif yang sah.
 */
export async function bacaParameterLpea(
  db: SQLite.SQLiteDatabase,
  tahunBuku: number
): Promise<ParameterLpea | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    kunciKonfigLpea(tahunBuku)
  );
  if (!row?.value) return null;
  try {
    const p = JSON.parse(row.value) as Partial<ParameterLpea>;
    // Nilai dibaca satu per satu (bukan spread mentah) supaya JSON lama /
    // rusak tidak pernah menyelundupkan field tak terduga ke perhitungan.
    return {
      tahunBuku,
      tarifLuarJasaPinjaman: angkaAtauNull(p.tarifLuarJasaPinjaman),
      tarifLuarJasaProvisi: angkaAtauNull(p.tarifLuarJasaProvisi),
      tarifLuarTabungan: angkaAtauNull(p.tarifLuarTabungan),
      tarifLuarSimpananBerjangka: angkaAtauNull(p.tarifLuarSimpananBerjangka),
      tarifKoperasiJasaProvisi: angkaAtauNull(p.tarifKoperasiJasaProvisi),
      tarifKoperasiTabungan: angkaAtauNull(p.tarifKoperasiTabungan),
      sumberAcuan: typeof p.sumberAcuan === 'string' ? p.sumberAcuan : null,
      diperbaruiPada: typeof p.diperbaruiPada === 'string' ? p.diperbaruiPada : null,
    };
  } catch {
    // Konfigurasi rusak diperlakukan seperti BELUM DIISI — laporan akan
    // menyatakan komponennya belum dapat dihitung, bukan memakai angka
    // setengah terbaca.
    return null;
  }
}

function angkaAtauNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function simpanParameterLpea(
  db: SQLite.SQLiteDatabase,
  parameter: ParameterLpea,
  sekarangIso: string
): Promise<void> {
  const isi: ParameterLpea = { ...parameter, diperbaruiPada: sekarangIso };
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    kunciKonfigLpea(parameter.tahunBuku),
    JSON.stringify(isi),
    sekarangIso
  );
}

// ===========================================================================
// BASIS (a) DARI DATA AKTUAL
// ===========================================================================

export interface BasisPerKomponen {
  baris: BarisPea[];
  /** Tarif koperasi seragam bila berasal dari parameter; null bila per transaksi. */
  tarifKoperasiSeragam: number | null;
}

/**
 * BASIS PINJAMAN (buku pembantu A).
 *
 * `a` = SISA POKOK pinjaman anggota pada akhir periode, yaitu
 * `SUM(pokok − pokok_terbayar)` atas jadwal yang BUKAN obsolete —
 * memakai `sqlJadwalBukanObsolete()` yang sudah dipakai laporan lain,
 * sehingga jadwal yang digantikan akad ulang tidak terhitung dua kali.
 *
 * `b` = `persentase_jasa` per pinjaman, dikonversi ke per bulan sesuai
 * `satuan_tenor` (lihat `tarifPinjamanKePerBulan`). Tarif ini DIBACA dari
 * data, bukan diminta ke pengguna.
 *
 * Hanya pinjaman yang dicairkan pada atau sebelum `tanggalSelesai` yang
 * ikut: laporan adalah keadaan sampai akhir periode, bukan seluruh
 * riwayat koperasi.
 */
export async function basisPinjaman(
  db: SQLite.SQLiteDatabase,
  tanggalSelesai: string
): Promise<BasisPerKomponen> {
  const rows = await db.getAllAsync<{
    nomor_pinjaman: string;
    nama_lengkap: string;
    persentase_jasa: number;
    satuan_tenor: SatuanTenor;
    sisa_pokok: number;
  }>(
    `SELECT p.nomor_pinjaman, a.nama_lengkap, p.persentase_jasa, p.satuan_tenor,
            COALESCE(SUM(aj.pokok - aj.pokok_terbayar), 0) AS sisa_pokok
       FROM pinjaman p
       JOIN anggota a ON a.id = p.anggota_id
       LEFT JOIN angsuran_jadwal aj
              ON aj.pinjaman_id = p.id AND ${sqlJadwalBukanObsolete('aj')}
      WHERE p.tanggal <= ?
        AND p.status NOT IN ('DIAJUKAN','DITOLAK','DIBATALKAN')
      GROUP BY p.id
      HAVING sisa_pokok > 0
      ORDER BY p.nomor_pinjaman`,
    tanggalSelesai
  );

  return {
    baris: rows.map((r) => ({
      basis: Number(r.sisa_pokok),
      tarifKoperasiPersenPerBulan: tarifPinjamanKePerBulan(
        Number(r.persentase_jasa),
        r.satuan_tenor
      ),
      tarifLuarPersenPerBulan: 0, // diisi pemanggil dari parameter
      keterangan: `${r.nomor_pinjaman} — ${r.nama_lengkap}`,
    })),
    tarifKoperasiSeragam: null,
  };
}

/**
 * BASIS TABUNGAN (buku pembantu C).
 *
 * `a` = saldo SIMPANAN SUKARELA per anggota sampai `tanggalSelesai`.
 *
 * Dipilih sukarela SAJA, bukan seluruh simpanan: pokok & wajib adalah
 * setoran MODAL keanggotaan yang imbalannya adalah jasa modal di dalam
 * pembagian SHU — memasukkannya ke sini akan menghitung manfaat yang
 * sama dua kali (sekali sebagai "bunga tabungan", sekali lagi di dalam
 * bagian SHU). Sukarela adalah satu-satunya simpanan yang berperilaku
 * seperti tabungan.
 *
 * KETERBATASAN yang dinyatakan di laporan: naskah memakai metode SALDO
 * TERENDAH dalam periode, sedangkan di sini dipakai saldo pada akhir
 * periode karena aplikasi tidak menyimpan register saldo harian.
 */
export async function basisTabungan(
  db: SQLite.SQLiteDatabase,
  tanggalSelesai: string,
  tarifKoperasi: number | null
): Promise<BasisPerKomponen> {
  const rows = await db.getAllAsync<{ nomor_anggota: string; nama_lengkap: string; saldo: number }>(
    `SELECT a.nomor_anggota, a.nama_lengkap,
            COALESCE(SUM(CASE WHEN st.tipe = 'SETOR' THEN st.nominal
                              WHEN st.tipe = 'TARIK' THEN -st.nominal
                              ELSE 0 END), 0) AS saldo
       FROM anggota a
       JOIN simpanan_transaksi st ON st.anggota_id = a.id
      WHERE st.jenis = 'SUKARELA' AND st.tanggal <= ?
      GROUP BY a.id
      HAVING saldo > 0
      ORDER BY a.nomor_anggota`,
    tanggalSelesai
  );

  return {
    baris: rows.map((r) => ({
      basis: Number(r.saldo),
      tarifKoperasiPersenPerBulan: tarifKoperasi ?? 0,
      tarifLuarPersenPerBulan: 0,
      keterangan: `${r.nomor_anggota} — ${r.nama_lengkap}`,
    })),
    tarifKoperasiSeragam: tarifKoperasi,
  };
}

/**
 * BASIS SIMPANAN BERJANGKA (buku pembantu D).
 *
 * `a` = nominal simpanan berjangka yang masih AKTIF pada akhir periode.
 * `b` = `suku_bunga` per tahun pada tiap simpanan, dikonversi ke per
 * bulan. Dibaca dari data, bukan diminta ke pengguna.
 *
 * `hariProrata` diisi HANYA bila simpanan belum berumur genap sebulan
 * pada akhir periode — perlakuan yang sama dengan baris kedua buku
 * pembantu huruf D pada naskah (x/30).
 */
export async function basisSimpananBerjangka(
  db: SQLite.SQLiteDatabase,
  tanggalSelesai: string
): Promise<BasisPerKomponen> {
  const rows = await db.getAllAsync<{
    nomor_transaksi: string;
    nama_lengkap: string;
    nominal: number;
    suku_bunga: number;
    tanggal_mulai: string;
  }>(
    `SELECT sb.nomor_transaksi, a.nama_lengkap, sb.nominal, sb.suku_bunga, sb.tanggal_mulai
       FROM simpanan_berjangka sb
       JOIN anggota a ON a.id = sb.anggota_id
      WHERE sb.tanggal_mulai <= ?
        AND sb.status = 'AKTIF'
      ORDER BY sb.nomor_transaksi`,
    tanggalSelesai
  );

  return {
    baris: rows.map((r) => {
      const umurHari = selisihHari(r.tanggal_mulai, tanggalSelesai);
      return {
        basis: Number(r.nominal),
        tarifKoperasiPersenPerBulan: tarifTahunanKePerBulan(Number(r.suku_bunga)),
        tarifLuarPersenPerBulan: 0,
        // Genap sebulan atau lebih -> penuh; kurang -> prorata hari.
        hariProrata: umurHari < 30 ? Math.max(0, umurHari) : undefined,
        keterangan: `${r.nomor_transaksi} — ${r.nama_lengkap}`,
      };
    }),
    tarifKoperasiSeragam: null,
  };
}

/** Selisih hari antara dua tanggal ISO (YYYY-MM-DD), dihitung sebagai kalender murni. */
export function selisihHari(dariIso: string, keIso: string): number {
  const a = Date.parse(`${dariIso}T00:00:00Z`);
  const b = Date.parse(`${keIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

// ===========================================================================
// BAGIAN SHU — HANYA YANG SUDAH DIBAGIKAN
// ===========================================================================

/**
 * Bagian SHU anggota, dibaca HANYA bila `shu_konfigurasi.status` sudah
 * `'DIBAGIKAN'` — yaitu status yang hanya bisa dicapai lewat
 * `bagikanSHU()` (lihat ShuService). SHU yang baru DIHITUNG,
 * DIAJUKAN_RAT, atau DISAHKAN_RAT dengan sengaja TIDAK dihitung sebagai
 * manfaat ekonomi anggota: pada tahap itu belum ada manfaat yang
 * benar-benar diterima anggota, dan melaporkannya akan melebih-lebihkan
 * kinerja koperasi.
 *
 * `shu_disahkan_rat` dibawa keluar HANYA untuk rekonsiliasi (agar
 * pembaca dapat mencocokkan total bagian anggota terhadap nominal yang
 * disahkan RAT), bukan untuk dijumlahkan.
 */
export async function bagianShuAnggota(
  db: SQLite.SQLiteDatabase,
  tahunBuku: number
): Promise<BagianShuLpea> {
  const konfigurasi = await db.getFirstAsync<{
    id: string;
    status: string;
    shu_disahkan_rat: number | null;
  }>(`SELECT id, status, shu_disahkan_rat FROM shu_konfigurasi WHERE tahun_buku = ?`, tahunBuku);

  if (!konfigurasi || konfigurasi.status !== 'DIBAGIKAN') {
    return {
      tahunBuku,
      sudahDibagikan: false,
      totalBagianAnggota: 0,
      jumlahAnggotaPenerima: 0,
      shuDisahkanRat: konfigurasi?.shu_disahkan_rat ?? null,
    };
  }

  const agregat = await db.getFirstAsync<{ total: number; jumlah: number }>(
    `SELECT COALESCE(SUM(total_shu_anggota), 0) AS total, COUNT(*) AS jumlah
       FROM shu_anggota WHERE shu_konfigurasi_id = ?`,
    konfigurasi.id
  );

  return {
    tahunBuku,
    sudahDibagikan: true,
    totalBagianAnggota: Number(agregat?.total ?? 0),
    jumlahAnggotaPenerima: Number(agregat?.jumlah ?? 0),
    shuDisahkanRat: konfigurasi.shu_disahkan_rat ?? null,
  };
}

/** Rincian per anggota — jasa modal & jasa usaha dipisah seperti tersimpan. */
export interface RincianShuAnggotaLpea {
  nomorAnggota: string;
  namaLengkap: string;
  jasaModal: Rupiah;
  jasaUsaha: Rupiah;
  totalShuAnggota: Rupiah;
}

export async function rincianBagianShuAnggota(
  db: SQLite.SQLiteDatabase,
  tahunBuku: number
): Promise<RincianShuAnggotaLpea[]> {
  const konfigurasi = await db.getFirstAsync<{ id: string; status: string }>(
    `SELECT id, status FROM shu_konfigurasi WHERE tahun_buku = ?`,
    tahunBuku
  );
  if (!konfigurasi || konfigurasi.status !== 'DIBAGIKAN') return [];

  const rows = await db.getAllAsync<{
    nomor_anggota: string;
    nama_lengkap: string;
    jasa_modal: number;
    jasa_usaha: number;
    total_shu_anggota: number;
  }>(
    `SELECT a.nomor_anggota, a.nama_lengkap, sa.jasa_modal, sa.jasa_usaha, sa.total_shu_anggota
       FROM shu_anggota sa
       JOIN anggota a ON a.id = sa.anggota_id
      WHERE sa.shu_konfigurasi_id = ?
      ORDER BY a.nomor_anggota`,
    konfigurasi.id
  );

  return rows.map((r) => ({
    nomorAnggota: r.nomor_anggota,
    namaLengkap: r.nama_lengkap,
    jasaModal: Number(r.jasa_modal),
    jasaUsaha: Number(r.jasa_usaha),
    totalShuAnggota: Number(r.total_shu_anggota),
  }));
}

// ===========================================================================
// PERAKITAN KOMPONEN
// ===========================================================================

/**
 * Susun keempat komponen dari data aktual + parameter. Tarif luar (c)
 * ditempelkan ke setiap baris di sini — satu-satunya tempat parameter
 * bertemu data — lalu seluruh perhitungannya diserahkan ke `LpeaPlan`.
 */
export async function susunKomponenLpea(
  db: SQLite.SQLiteDatabase,
  tanggalSelesai: string,
  parameter: ParameterLpea
): Promise<HasilKomponenPea[]> {
  const pinjaman = await basisPinjaman(db, tanggalSelesai);
  const tabungan = await basisTabungan(db, tanggalSelesai, parameter.tarifKoperasiTabungan);
  const berjangka = await basisSimpananBerjangka(db, tanggalSelesai);

  /** Provisi memakai BASIS YANG SAMA dengan pinjaman (naskah huruf B juga saldo pokok pinjaman). */
  const provisi: BasisPerKomponen = {
    baris: pinjaman.baris.map((b) => ({
      ...b,
      tarifKoperasiPersenPerBulan: parameter.tarifKoperasiJasaProvisi ?? 0,
    })),
    tarifKoperasiSeragam: parameter.tarifKoperasiJasaProvisi,
  };

  const denganTarifLuar = (basis: BasisPerKomponen, tarifLuar: number | null): BarisPea[] =>
    basis.baris.map((b) => ({ ...b, tarifLuarPersenPerBulan: tarifLuar ?? 0 }));

  const peta: Record<KomponenPea, { basis: BasisPerKomponen; tarifLuar: number | null }> = {
    JASA_PINJAMAN: { basis: pinjaman, tarifLuar: parameter.tarifLuarJasaPinjaman },
    JASA_PROVISI: { basis: provisi, tarifLuar: parameter.tarifLuarJasaProvisi },
    TABUNGAN: { basis: tabungan, tarifLuar: parameter.tarifLuarTabungan },
    SIMPANAN_BERJANGKA: { basis: berjangka, tarifLuar: parameter.tarifLuarSimpananBerjangka },
  };

  return (Object.keys(peta) as KomponenPea[]).map((komponen) =>
    susunHasilKomponen(
      komponen,
      denganTarifLuar(peta[komponen].basis, peta[komponen].tarifLuar),
      parameter,
      peta[komponen].basis.tarifKoperasiSeragam
    )
  );
}
