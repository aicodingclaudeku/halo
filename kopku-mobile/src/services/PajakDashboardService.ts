/**
 * RC-S87.4 — Dashboard hub Pajak: status, daftar tugas, dan posisi pajak.
 *
 * Dipisah dari PajakBadanService supaya engine PPh Badan tetap bersih dari
 * pajak yang dipotong dari anggota (PPh 4(2) bunga simpanan). Dashboard
 * hanya MEMBACA; tidak ada pencatatan di sini.
 */
import { getDb } from '@/database/db';
import { getAccountBalance } from '@/accounting/AccountingEngine';
import { Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  evaluasiRezimPajakPadaDb,
  getDaftarMasaPphFinal,
  getOmzetTahunPajakPadaDb,
  getRingkasanPajak,
  listRiwayatPajak,
  MasaPphFinal,
  RiwayatPajakItem,
  SaldoAkunPajak,
} from '@/services/PajakService';
import { getDasarPph25, getJadwalPph25, hitungPphBadanTahun, JadwalMasaPph25, PerhitunganPphBadan } from '@/services/PajakBadanService';
import {
  HasilRezimPajak,
  KODE_PAJAK_DIBAYAR_DIMUKA_LAIN,
  KODE_UTANG_PPH_29,
  KODE_UTANG_PPH_BUNGA_SIMPANAN,
  KODE_UTANG_PPH_FINAL,
} from '@/config/pajakPolicy';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** RC-S87.4 — tugas yang perlu dikerjakan, disusun service (bukan UI). */
export type NadaTugas = 'MENDESAK' | 'PERLU' | 'INFO';
export interface TugasPajak {
  kunci: string;
  judul: string;
  deskripsi: string;
  nada: NadaTugas;
  nominal: Rupiah | null;
  route: string;
  params?: Record<string, unknown>;
}

/**
 * Posisi pajak dikelompokkan menurut SIFATNYA — penting bagi pengawas:
 *  - pajakKoperasi: pajak atas penghasilan koperasi sendiri (utang).
 *  - dipotongAnggota: pajak milik anggota yang ditahan koperasi (utang titipan).
 *  - kreditPajak: pembayaran di muka yang nanti mengurangi PPh Badan (aset).
 */
export interface PosisiPajak {
  pajakKoperasi: SaldoAkunPajak[];
  dipotongAnggota: SaldoAkunPajak[];
  lainnya: SaldoAkunPajak[];
  kreditPph25: Rupiah;
  kreditPphLain: Rupiah;
  totalUtang: Rupiah;
}

export interface DashboardPajak {
  tahun: number;
  masaBerjalan: string;
  rezim: HasilRezimPajak;
  omzetTahunBerjalan: Rupiah;
  utangPajak: Awaited<ReturnType<typeof getRingkasanPajak>>;
  pph25BulanIni: JadwalMasaPph25 | null;
  pph25JatuhTempo: JadwalMasaPph25[];
  perhitunganTahunLalu: PerhitunganPphBadan | null;
  setoranTerakhir: RiwayatPajakItem[];
  /** RC-S87.4 */
  pphFinalPerluDicatat: MasaPphFinal[];
  adaDasarPph25TahunIni: boolean;
  posisi: PosisiPajak;
  tugas: TugasPajak[];
}

/** Seluruh angka dashboard dibaca dari data — operator tidak perlu membuat transaksi agar dashboard terisi. */
export async function getDashboardPajak(hariIni: string = getTanggalLokalHariIni()): Promise<DashboardPajak> {
  const db = await getDb();
  const tahun = Number(hariIni.slice(0, 4));
  const masaBerjalan = hariIni.slice(0, 7);
  const rezim = await evaluasiRezimPajakPadaDb(db, tahun);
  const utangPajak = await getRingkasanPajak();
  let pph25BulanIni: JadwalMasaPph25 | null = null;
  const pph25JatuhTempo: JadwalMasaPph25[] = [];
  if (rezim.rezim === 'BADAN_31E' || rezim.rezim === 'BADAN_UMUM') {
    for (const t of [tahun - 1, tahun]) {
      const j = await getJadwalPph25(t, hariIni);
      for (const m of j.masa) {
        if (m.masa === masaBerjalan) pph25BulanIni = m;
        if (m.status === 'JATUH_TEMPO' || m.status === 'TERLAMBAT') pph25JatuhTempo.push(m);
      }
    }
  }
  const lalu = await hitungPphBadanTahun(tahun - 1, hariIni).catch(() => null);
  const setoranTerakhir = (await listRiwayatPajak(tahun))
    .filter((r) => r.jenis === 'SETORAN' || r.jenis === 'ANGSURAN_PPH25')
    .slice(0, 5);
  const badan = rezim.rezim === 'BADAN_31E' || rezim.rezim === 'BADAN_UMUM';
  const pphFinalPerluDicatat =
    rezim.rezim === 'FINAL_UMKM' ? (await getDaftarMasaPphFinal(hariIni)).filter((m) => m.status === 'PERLU_DICATAT') : [];
  const adaDasarPph25TahunIni = badan ? !!(await getDasarPph25(tahun)) : false;
  const perhitunganTahunLalu = lalu && lalu.status !== 'BUKAN_REZIM_BADAN' ? lalu : null;

  const utangAktif = utangPajak.utang.filter((u) => u.saldo > 0);
  const idLain = (await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, KODE_PAJAK_DIBAYAR_DIMUKA_LAIN))?.id ?? null;
  const posisi: PosisiPajak = {
    pajakKoperasi: utangAktif.filter((u) => u.kode === KODE_UTANG_PPH_FINAL || u.kode === KODE_UTANG_PPH_29),
    dipotongAnggota: utangAktif.filter((u) => u.kode === KODE_UTANG_PPH_BUNGA_SIMPANAN),
    lainnya: utangAktif.filter((u) => ![KODE_UTANG_PPH_FINAL, KODE_UTANG_PPH_29, KODE_UTANG_PPH_BUNGA_SIMPANAN].includes(u.kode)),
    kreditPph25: utangPajak.pajakDibayarDimuka,
    kreditPphLain: idLain ? await getAccountBalance(db, idLain) : 0,
    totalUtang: utangPajak.totalUtang,
  };

  const tugas = susunTugasPajak({
    tahun, adaPengaturan: !!utangPajak.pengaturan, badan, pphFinalPerluDicatat, utangAktif,
    pph25JatuhTempo, adaDasarPph25TahunIni, perhitunganTahunLalu,
  });

  return {
    tahun,
    masaBerjalan,
    rezim,
    omzetTahunBerjalan: await getOmzetTahunPajakPadaDb(db, tahun),
    utangPajak,
    pph25BulanIni,
    pph25JatuhTempo,
    perhitunganTahunLalu,
    setoranTerakhir,
    pphFinalPerluDicatat,
    adaDasarPph25TahunIni,
    posisi,
    tugas,
  };
}

/** Aturan penyusunan daftar tugas — murni, diuji terpisah. Urutan: mendesak → perlu → info. */
export function susunTugasPajak(i: {
  tahun: number;
  adaPengaturan: boolean;
  badan: boolean;
  pphFinalPerluDicatat: MasaPphFinal[];
  utangAktif: SaldoAkunPajak[];
  pph25JatuhTempo: JadwalMasaPph25[];
  adaDasarPph25TahunIni: boolean;
  perhitunganTahunLalu: PerhitunganPphBadan | null;
}): TugasPajak[] {
  const t: TugasPajak[] = [];
  if (!i.adaPengaturan) {
    t.push({ kunci: 'pengaturan', judul: 'Lengkapi Pengaturan Pajak', deskripsi: 'Isi data koperasi agar aplikasi dapat menentukan rezim pajak.', nada: 'MENDESAK', nominal: null, route: 'PengaturanPajak' });
    return t;
  }
  if (i.pphFinalPerluDicatat.length > 0) {
    const total = i.pphFinalPerluDicatat.reduce((s, m) => s + m.pajak, 0);
    const telat = i.pphFinalPerluDicatat.some((m) => m.terlambat);
    t.push({
      kunci: 'pph-final',
      judul: `Catat PPh Final ${i.pphFinalPerluDicatat.length} masa`,
      deskripsi: `${i.pphFinalPerluDicatat.map((m) => m.label).join(', ')} — sudah dihitung otomatis, tinggal dicatat${telat ? '. Ada yang lewat jatuh tempo.' : '.'}`,
      nada: telat ? 'MENDESAK' : 'PERLU',
      nominal: total,
      route: 'PphFinalForm',
    });
  }
  for (const m of i.pph25JatuhTempo) {
    t.push({
      kunci: `pph25-${m.masa}`,
      judul: `Bayar angsuran PPh 25 ${m.label}`,
      deskripsi: m.status === 'TERLAMBAT' ? `Terlambat — jatuh tempo ${m.jatuhTempo}.` : `Jatuh tempo ${m.jatuhTempo}.`,
      nada: m.status === 'TERLAMBAT' ? 'MENDESAK' : 'PERLU',
      nominal: m.nominal,
      route: 'AngsuranPph25Form',
    });
  }
  if (i.badan && !i.adaDasarPph25TahunIni) {
    t.push({
      kunci: 'dasar-pph25',
      judul: `Tetapkan dasar angsuran PPh 25 ${i.tahun}`,
      deskripsi: 'Tanpa dasar angsuran, jadwal PPh 25 bulanan belum dapat dibentuk.',
      nada: 'PERLU',
      nominal: null,
      route: 'AngsuranPph25Form',
    });
  }
  const p = i.perhitunganTahunLalu;
  if (p) {
    const th = i.tahun - 1;
    if (p.status === 'REKONSILIASI_BELUM_LENGKAP') {
      t.push({ kunci: 'koreksi', judul: `Lengkapi koreksi fiskal ${th}`, deskripsi: 'PPh Badan belum bisa dikunci sebelum rekonsiliasi fiskal dinyatakan lengkap.', nada: 'PERLU', nominal: null, route: 'KoreksiFiskal', params: { tahun: th } });
    } else if (p.status === 'SIAP_DIKUNCI') {
      t.push({ kunci: 'kunci-badan', judul: `Kunci PPh Badan ${th}`, deskripsi: 'Perhitungan sudah lengkap. Periksa rinciannya lalu kunci agar PPh 29 terbentuk.', nada: 'PERLU', nominal: p.hasil?.pph29 ?? null, route: 'PphBadanForm' });
    } else if (p.status === 'LEBIH_BAYAR_BELUM_ADA_KEBIJAKAN' || p.status === 'KREDIT_TIDAK_SESUAI_BUKU') {
      t.push({ kunci: 'periksa-badan', judul: `Periksa PPh Badan ${th}`, deskripsi: p.pesan[0] ?? 'Perhitungan perlu diperiksa.', nada: 'MENDESAK', nominal: null, route: 'PphBadanForm' });
    }
  }
  for (const u of i.utangAktif) {
    t.push({
      kunci: `setor-${u.kode}`,
      judul: `Setor ${u.jenis}`,
      deskripsi: u.kode === KODE_UTANG_PPH_BUNGA_SIMPANAN ? 'Pajak anggota yang sudah dipotong — wajib diteruskan ke negara.' : 'Utang pajak yang belum disetor ke kas negara.',
      nada: 'PERLU',
      nominal: u.saldo,
      route: 'SetorPajakForm',
      params: { kodeAkun: u.kode },
    });
  }
  const urut: Record<NadaTugas, number> = { MENDESAK: 0, PERLU: 1, INFO: 2 };
  return t.sort((a, b) => urut[a.nada] - urut[b.nada]);
}
