import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  ANGGOTA_ID,
  USER_ID,
  POKOK,
  RATE_KONTRAK,
  TENOR,
  PLACEMENT,
} from './earlyWithdrawalHarness';

/**
 * Pembuat kontrak uji. SENGAJA berada di berkas terpisah dari
 * `earlyWithdrawalHarness.ts`: harness itu di-`require` dari dalam
 * factory `jest.mock('@/database/db', ...)`, sehingga apa pun yang
 * diimpornya akan dimuat saat factory sedang berjalan. Menaruh import
 * service di sana menciptakan siklus pemuatan modul. Berkas ini
 * diimpor secara normal oleh suite, jadi aman.
 */
export async function buatKontrakUji(opsi?: {
  tanggal?: string;
  rate?: number;
  pokok?: number;
}): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId: ANGGOTA_ID,
    nominal: opsi?.pokok ?? POKOK,
    tanggal: opsi?.tanggal ?? PLACEMENT,
    tenorBulan: TENOR,
    sukuBungaPerTahun: opsi?.rate ?? RATE_KONTRAK,
    sumberDana: 'KAS',
    createdBy: USER_ID,
  });
  return hasil.id;
}
