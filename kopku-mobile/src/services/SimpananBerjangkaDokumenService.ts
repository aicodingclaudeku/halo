import { getDb } from '@/database/db';
import { getSusunanPengurusInti } from '@/services/KoperasiMasterService';
import { bacaKasBankPencairan } from '@/services/BuktiTransaksiService';
import { getRincianBungaKontrakPadaDb, TRANSAKSI_BUNGA_TRANSFER } from '@/services/SimpananBerjangkaLifecycleService';
import { hitungTotalBungaKontrak, periodePascaJatuhTempoBerikutnya } from '@/accounting/SimpananBerjangkaBunga';
import type { TenorSimpananBerjangka } from '@/accounting/SimpananBerjangkaTenor';
import type {
  DataBuktiPencairan,
  DataBuktiPenempatan,
  IdentitasAnggotaDokumen,
  IdentitasKoperasiDokumen,
  SnapshotKebijakanDokumen,
} from '@/export/SimpananBerjangkaDokumenBuilder';
import { tanggalPanjang } from '@/export/SimpananBerjangkaDokumenBuilder';

/**
 * ============================================================
 * DATA DOKUMEN SIMPANAN BERJANGKA (RC-S128) — HANYA MEMBACA
 * ============================================================
 * Seluruh isi PDF bukti penempatan/pencairan berasal dari data yang
 * TERSIMPAN: baris kontrak (termasuk snapshot kebijakan), baris kebijakan
 * berversi yang append-only, jurnal, dan bukti potong PPh. Tidak ada
 * nilai yang diambil dari state layar. Nama Ketua dari resolver pengurus
 * yang sama dengan dokumen pinjaman (`getSusunanPengurusInti`) pada
 * tanggal dokumen.
 */

async function bacaKontrak(kontrakId: string) {
  const db = await getDb();
  const k = await db.getFirstAsync<any>(
    `SELECT sb.*, a.nama_lengkap, a.nomor_anggota, a.nik, a.alamat AS alamat_anggota, j.nomor_jurnal AS nomor_jurnal_penempatan,
            kp.dasar_penetapan, kp.berlaku_mulai AS policy_berlaku_mulai
       FROM simpanan_berjangka sb
       JOIN anggota a ON a.id = sb.anggota_id
       LEFT JOIN journal j ON j.id = sb.journal_id
       LEFT JOIN simpanan_berjangka_kebijakan_produk kp ON kp.id = sb.policy_id
      WHERE sb.id = ?`,
    kontrakId
  );
  if (!k) throw new Error('Kontrak simpanan berjangka tidak ditemukan.');
  const kop = await db.getFirstAsync<any>(`SELECT nama, alamat, nomor_badan_hukum, npwp FROM koperasi LIMIT 1`);
  const koperasi: IdentitasKoperasiDokumen = {
    nama: kop?.nama ?? '-',
    alamat: kop?.alamat ?? null,
    nomorBadanHukum: kop?.nomor_badan_hukum ?? null,
    npwp: kop?.npwp ?? null,
  };
  const anggota: IdentitasAnggotaDokumen = {
    nama: k.nama_lengkap,
    nomorAnggota: k.nomor_anggota,
    nik: k.nik ?? null,
    alamat: k.alamat_anggota ?? null,
  };
  const kebijakan: SnapshotKebijakanDokumen = {
    statusPolicy: k.status_policy ?? 'LEGACY_POLICY_REVIEW_REQUIRED',
    policyVersi: k.policy_versi ?? null,
    autoRenewal: k.policy_auto_renewal == null ? null : k.policy_auto_renewal === 1,
    bungaPascaAktif: k.policy_bunga_pasca_aktif == null ? null : k.policy_bunga_pasca_aktif === 1,
    ratePascaJatuhTempo: k.policy_rate_pasca_jatuh_tempo ?? null,
    dasarPenetapan: k.dasar_penetapan ?? null,
    berlakuMulai: k.policy_berlaku_mulai ?? null,
    pascaMulaiEfektif: k.policy_pasca_mulai_efektif ?? null,
  };
  return { db, k, koperasi, anggota, kebijakan };
}

export async function getDataBuktiPenempatan(kontrakId: string): Promise<DataBuktiPenempatan> {
  const { k, koperasi, anggota, kebijakan } = await bacaKontrak(kontrakId);
  if (k.status === 'DIBATALKAN') throw new Error('Kontrak yang dibatalkan tidak memiliki bukti penempatan.');
  return {
    koperasi,
    pengurus: await getSusunanPengurusInti(k.tanggal_mulai),
    anggota,
    kontrak: {
      nomorTransaksi: k.nomor_transaksi,
      tanggalMulai: k.tanggal_mulai,
      tanggalJatuhTempo: k.tanggal_jatuh_tempo,
      nominal: k.nominal,
      tenorBulan: k.tenor_bulan,
      rateKontrak: k.suku_bunga,
      totalBungaKontrak: hitungTotalBungaKontrak(k.nominal, k.suku_bunga, k.tenor_bulan as TenorSimpananBerjangka),
      sumberDana: k.sumber_dana === 'BANK' ? 'Bank' : 'Kas',
      nomorJurnal: k.nomor_jurnal_penempatan ?? null,
      status: k.status,
    },
    kebijakan,
  };
}

export async function getDataBuktiPencairan(kontrakId: string): Promise<DataBuktiPencairan> {
  const { db, k, koperasi, anggota, kebijakan } = await bacaKontrak(kontrakId);
  if (k.status !== 'DICAIRKAN' || !k.journal_pencairan_id) {
    throw new Error('Bukti pencairan hanya tersedia untuk kontrak yang sudah dicairkan.');
  }
  const dini = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM simpanan_berjangka_pencairan_dini WHERE simpanan_berjangka_id = ?`,
    kontrakId
  );
  if (dini) throw new Error('Kontrak ini dicairkan sebelum jatuh tempo; gunakan Bukti Tarik Simpanan (penarikan dini).');

  const tanggalCair: string = k.tanggal_pencairan;
  const rincian = await getRincianBungaKontrakPadaDb(db, kontrakId, tanggalCair);
  const jurnal = await db.getFirstAsync<{ nomor_jurnal: string; nomor_referensi: string | null }>(
    `SELECT nomor_jurnal, nomor_referensi FROM journal WHERE id = ?`,
    k.journal_pencairan_id
  );
  const jumlahPemindahan = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal j JOIN simpanan_berjangka_bunga b ON b.id = j.sumber_id
      WHERE j.sumber_transaksi = ? AND j.status NOT IN ('VOID','REVERSED') AND b.simpanan_berjangka_id = ?`,
    TRANSAKSI_BUNGA_TRANSFER,
    kontrakId
  );
  const kasBank = await bacaKasBankPencairan(k.journal_pencairan_id);

  // Bunga periode pasca jatuh tempo yang sedang berjalan pada tanggal
  // pencairan TIDAK earned (tanpa prorata) — dijelaskan, tidak dihitung.
  let alasan: string | null = null;
  const ratePasca = k.policy_bunga_pasca_aktif === 1 ? k.policy_rate_pasca_jatuh_tempo ?? 0 : 0;
  if (ratePasca > 0) {
    const berjalan = periodePascaJatuhTempoBerikutnya({
      pokok: k.nominal,
      tenorBulan: k.tenor_bulan as TenorSimpananBerjangka,
      tanggalMulai: k.tanggal_mulai,
      ratePascaPerTahun: ratePasca,
      sampaiTanggal: tanggalCair,
      mulaiEfektif: k.policy_pasca_mulai_efektif,
    });
    if (berjalan && berjalan.tanggalAwalPeriode < tanggalCair) {
      alasan =
        `Periode bunga pasca jatuh tempo ${tanggalPanjang(berjalan.tanggalAwalPeriode)} – ${tanggalPanjang(berjalan.tanggalAkhirPeriode)} ` +
        'belum genap satu bulan kalender pada tanggal pencairan. Kebijakan produk tidak mengatur bunga prorata, sehingga periode itu tidak menimbulkan bunga.';
    }
  }

  return {
    koperasi,
    pengurus: await getSusunanPengurusInti(tanggalCair),
    anggota,
    kontrak: {
      nomorTransaksi: k.nomor_transaksi,
      tanggalMulai: k.tanggal_mulai,
      tanggalJatuhTempo: k.tanggal_jatuh_tempo,
      tanggalPencairan: tanggalCair,
      tenorBulan: k.tenor_bulan,
      rateKontrak: k.suku_bunga,
    },
    kebijakan,
    pencairan: {
      nomorReferensi: jurnal?.nomor_referensi ?? jurnal?.nomor_jurnal ?? k.nomor_transaksi,
      nomorJurnal: jurnal?.nomor_jurnal ?? null,
      pokokDicairkan: k.nominal,
      bungaSelamaTenor: rincian.bungaSelamaTenor,
      bungaPascaJatuhTempo: rincian.bungaPascaJatuhTempo,
      bungaKeSukarelaBruto: rincian.bungaSudahKeSukarela,
      pphAtasPemindahan: rincian.pphAtasPemindahan,
      bungaKeSukarelaNeto: rincian.netoKeSukarela,
      jumlahJurnalPemindahan: jumlahPemindahan?.n ?? 0,
      bungaDibayarTunai: rincian.bungaDibayarTunaiSaatPencairan,
      pphSaatPencairan: rincian.pphSaatPencairan,
      bungaTidakDibayarkan: 0,
      alasanTidakDibayarkan: alasan,
      totalKeluarKasBank: kasBank?.kredit ?? 0,
      sumberDana: kasBank?.label ?? '-',
    },
  };
}
