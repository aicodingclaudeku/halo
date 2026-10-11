/* Menyiapkan database KOPKU berisi data realistis untuk uji tampilan desktop.
 * Dijalankan di Node (node:sqlite) lewat desktop/test/bundle.js — memakai
 * service aplikasi ASLI (setup, anggota, simpanan, pinjaman), bukan baris mentah. */
import { getDb } from '@/database/db';
import { setupKoperasi } from '@/services/SetupService';
import { login } from '@/services/AuthService';
import { createAnggota } from '@/repositories/AnggotaRepository';
import { setorSimpanan } from '@/services/SimpananService';
import { ajukanPinjaman, cairkanPinjaman } from '@/services/PinjamanService';

const NAMA = ['Budi Santoso', 'Siti Aminah', 'Joko Prasetyo', 'Dewi Lestari', 'Agus Salim', 'Rina Marlina', 'Hendra Wijaya', 'Sri Wahyuni', 'Bambang Irawan', 'Lina Kartika', 'Andi Saputra', 'Yuni Rahmawati'];

(async () => {
  await getDb();
  const s = await setupKoperasi({ nama: 'Koperasi Simpan Pinjam Sejahtera Bersama', tahunBuku: 2026, adminNama: 'Rahmat Hidayat', adminUsername: 'admin', adminPassword: 'Admin12345' } as any);
  const u = await login('admin', 'Admin12345');
  const uid = (u as any).id ?? s.adminUserId;
  const ids: string[] = [];
  for (let i = 0; i < NAMA.length; i++) {
    const a = await createAnggota(uid, { namaLengkap: NAMA[i], tanggalBergabung: '2026-01-05', nik: String(3201000000000000 + i), alamat: 'Bandung' } as any);
    ids.push(a.id);
    await setorSimpanan({ anggotaId: a.id, jenis: 'POKOK', tanggal: '2026-01-05', nominal: 500_000, sumberDana: 'KAS', createdBy: uid });
    for (let b = 1; b <= 8; b++) {
      const bl = String(b).padStart(2, '0');
      await setorSimpanan({ anggotaId: a.id, jenis: 'WAJIB', tanggal: `2026-${bl}-10`, periode: `2026-${bl}`, nominal: 100_000, sumberDana: 'KAS', createdBy: uid });
    }
    await setorSimpanan({ anggotaId: a.id, jenis: 'SUKARELA', tanggal: '2026-03-15', nominal: 250_000 * ((i % 4) + 1), sumberDana: 'KAS', createdBy: uid });
  }
  const pinjam = async (idx: number, jumlah: number, tanggal: string, tenor: number) => {
    const p = await ajukanPinjaman({
      anggotaId: ids[idx], tanggal, jumlahPinjaman: jumlah, tenor, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5,
      biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, tujuanPinjaman: 'MODAL_KERJA', createdBy: uid,
    } as any);
    await cairkanPinjaman({ pinjamanId: p.id, sumberDana: 'KAS', approvedBy: uid, tanggalPencairan: tanggal });
  };
  await pinjam(0, 3_000_000, '2026-02-01', 12);
  await pinjam(2, 2_000_000, '2026-03-01', 10);
  await pinjam(4, 1_500_000, '2026-05-01', 6);
  await pinjam(6, 2_500_000, '2026-06-01', 12);
  const db = await getDb();
  await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  const n = await db.getFirstAsync<any>('SELECT (SELECT COUNT(*) FROM anggota) a, (SELECT COUNT(*) FROM simpanan_transaksi) s, (SELECT COUNT(*) FROM pinjaman) p');
  console.log('DATA-SIAP', JSON.stringify(n), 'admin', uid);
  process.exit(0);
})().catch((e) => {
  console.error('GAGAL', e);
  process.exit(1);
});
