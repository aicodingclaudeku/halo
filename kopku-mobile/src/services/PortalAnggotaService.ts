import { getDb } from '@/database/db';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { getAnggotaById, getHistoriTransaksiAnggota, type HistoriTransaksiRow } from '@/repositories/AnggotaRepository';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { listSimpananBerjangka, type SimpananBerjangkaRow } from '@/services/SimpananBerjangkaService';
import { listPinjaman, getJadwalAngsuran, type PinjamanListItem, type JadwalAngsuranItem } from '@/services/PinjamanService';
import { getKolektibilitasAnggota, KOLEKTIBILITAS_LABEL } from '@/services/LoanImpairmentService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * RC-S133.5 — PORTAL ANGGOTA ("Data Saya").
 *
 * Akun ber-role ANGGOTA hanya boleh melihat data anggota yang DITAUTKAN
 * ke akunnya (`app_user.anggota_id`, RC-S132). Cakupan itu ditegakkan DI
 * SINI, di service — bukan oleh layar:
 *  - pemanggil hanya memberi `userId` sesi; `anggota_id` dibaca dari
 *    database, tidak pernah diterima dari parameter layar/rute;
 *  - akun nonaktif, bukan ANGGOTA, atau belum ditautkan → ditolak (gagal
 *    tertutup);
 *  - setiap kueri difilter `anggota_id` milik akun itu.
 * Layar portal (screens/PortalAnggota) tidak me-mount navigator koperasi
 * sama sekali, sehingga daftar seluruh anggota, laporan koperasi, dan
 * Dashboard koperasi tidak dapat dijangkau dari akun Anggota.
 */

export class BukanAkunAnggotaError extends Error {
  constructor(pesan = 'Akun ini tidak terhubung dengan data anggota. Hubungi Admin koperasi.') {
    super(pesan);
    this.name = 'BukanAkunAnggotaError';
  }
}

export interface PinjamanSaya extends PinjamanListItem {
  sisaPokok: number;
  sisaJasa: number;
  jadwal: JadwalAngsuranItem[];
  /** Angsuran berikutnya yang belum lunas (null bila tidak ada). */
  angsuranBerikutnya: JadwalAngsuranItem | null;
}

export interface ShuSaya {
  tahunBuku: number;
  status: string;
  jasaModal: number;
  jasaUsaha: number;
  total: number;
}

export interface DataSaya {
  anggota: {
    id: string;
    nomorAnggota: string;
    namaLengkap: string;
    status: string;
    tanggalBergabung: string;
  };
  simpanan: { pokok: number; wajib: number; sukarela: number; total: number };
  simpananBerjangka: SimpananBerjangkaRow[];
  pinjaman: PinjamanSaya[];
  ringkasanPinjaman: {
    jumlahAktif: number;
    sisaPokok: number;
    sisaJasa: number;
    kolektibilitas: string | null;
    hariTunggakan: number;
  };
  shu: ShuSaya[];
  transaksi: HistoriTransaksiRow[];
}

/** anggota_id milik akun sesi — satu-satunya sumber cakupan data portal. */
export async function anggotaIdMilikAkun(userId: string): Promise<string> {
  const db = await getDb();
  const u = await db.getFirstAsync<{ role: string; aktif: number; anggota_id: string | null }>(
    `SELECT role, aktif, anggota_id FROM app_user WHERE id = ?`,
    userId
  );
  if (!u || !u.aktif) throw new BukanAkunAnggotaError('Akun tidak aktif. Silakan masuk kembali.');
  if (u.role !== 'ANGGOTA') throw new BukanAkunAnggotaError('Portal anggota hanya untuk akun ber-role Anggota.');
  if (!u.anggota_id) throw new BukanAkunAnggotaError();
  return u.anggota_id;
}

/** Seluruh data milik anggota yang ditautkan ke akun `userId`. */
export async function muatDataSaya(userId: string, opsi: { batasTransaksi?: number } = {}): Promise<DataSaya> {
  const anggotaId = await anggotaIdMilikAkun(userId);
  const a = await getAnggotaById(anggotaId);
  if (!a) throw new BukanAkunAnggotaError('Data anggota yang ditautkan tidak ditemukan. Hubungi Admin koperasi.');
  const db = await getDb();

  const [pokok, wajib, sukarela] = await Promise.all([
    getSaldoSimpanan(db, anggotaId, 'POKOK'),
    getSaldoSimpanan(db, anggotaId, 'WAJIB'),
    getSaldoSimpanan(db, anggotaId, 'SUKARELA'),
  ]);

  const berjangka = await listSimpananBerjangka(anggotaId);

  // Hanya pinjaman milik anggota ini (filter anggota_id di service).
  const daftar = (await listPinjaman({ anggotaId, limit: 1000 })).filter((p) => p.anggotaId === anggotaId);
  const pinjaman: PinjamanSaya[] = [];
  for (const p of daftar) {
    const jadwal = (await getJadwalAngsuran(p.id)).filter((j) => !j.digantikanOlehAkadUlangId);
    const sisa = await db.getFirstAsync<{ pokok: number; jasa: number }>(
      `SELECT COALESCE(SUM(aj.pokok - aj.pokok_terbayar),0) AS pokok,
              COALESCE(SUM(aj.jasa - aj.jasa_terbayar),0) AS jasa
         FROM angsuran_jadwal aj JOIN pinjaman pj ON pj.id = aj.pinjaman_id
        WHERE aj.pinjaman_id = ? AND pj.anggota_id = ? AND ${sqlJadwalBukanObsolete('aj')}`,
      p.id,
      anggotaId
    );
    const berikut = jadwal.find((j) => j.status !== 'LUNAS' && j.pokokTerbayar + j.jasaTerbayar < j.total) ?? null;
    pinjaman.push({
      ...p,
      sisaPokok: p.status === 'AKTIF' ? sisa?.pokok ?? 0 : 0,
      sisaJasa: p.status === 'AKTIF' ? sisa?.jasa ?? 0 : 0,
      jadwal,
      angsuranBerikutnya: p.status === 'AKTIF' ? berikut : null,
    });
  }
  const aktif = pinjaman.filter((p) => p.status === 'AKTIF');
  const kolek = await getKolektibilitasAnggota(db, anggotaId, getTanggalLokalHariIni());

  // SHU hanya dari tahun buku yang sudah disahkan/dibagikan.
  const shuRows = await db.getAllAsync<any>(
    `SELECT k.tahun_buku, k.status, sa.jasa_modal, sa.jasa_usaha, sa.total_shu_anggota
       FROM shu_anggota sa JOIN shu_konfigurasi k ON k.id = sa.shu_konfigurasi_id
      WHERE sa.anggota_id = ? AND k.status IN ('DISAHKAN_RAT','DIBAGIKAN')
      ORDER BY k.tahun_buku DESC`,
    anggotaId
  );

  const transaksi = await getHistoriTransaksiAnggota(anggotaId, { limit: opsi.batasTransaksi ?? 50 });

  return {
    anggota: {
      id: a.id,
      nomorAnggota: a.nomorAnggota,
      namaLengkap: a.namaLengkap,
      status: a.status,
      tanggalBergabung: a.tanggalBergabung,
    },
    simpanan: { pokok, wajib, sukarela, total: pokok + wajib + sukarela },
    simpananBerjangka: berjangka,
    pinjaman,
    ringkasanPinjaman: {
      jumlahAktif: aktif.length,
      sisaPokok: aktif.reduce((t, p) => t + p.sisaPokok, 0),
      sisaJasa: aktif.reduce((t, p) => t + p.sisaJasa, 0),
      kolektibilitas: kolek.tanpaPinjamanAktif || !kolek.kolektibilitas ? null : KOLEKTIBILITAS_LABEL[kolek.kolektibilitas],
      hariTunggakan: kolek.hariTunggakan ?? 0,
    },
    shu: shuRows.map((r) => ({
      tahunBuku: r.tahun_buku,
      status: r.status,
      jasaModal: r.jasa_modal ?? 0,
      jasaUsaha: r.jasa_usaha ?? 0,
      total: r.total_shu_anggota ?? 0,
    })),
    transaksi,
  };
}
