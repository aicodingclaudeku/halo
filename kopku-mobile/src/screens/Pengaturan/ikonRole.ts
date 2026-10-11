import type { Role } from '@/config/defaultPermissions';

/**
 * RC-S122 — ikon per role untuk layar User Management & form user.
 *
 * Pembeda TAMBAHAN di samping label teks role (label tetap tampil, jadi
 * ikon bukan satu-satunya penanda). Nama ikon dari set Ionicons yang
 * sudah dipakai aplikasi; tidak memengaruhi izin apa pun.
 */
export const IKON_ROLE: Record<Role, string> = {
  ADMIN: 'shield-checkmark-outline',
  PENGURUS: 'ribbon-outline',
  BENDAHARA: 'wallet-outline',
  PETUGAS: 'id-card-outline',
  ANGGOTA: 'person-outline',
};
