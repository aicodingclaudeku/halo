/**
 * RC-S128 — FIXTURE TEST: kebijakan produk Simpanan Berjangka.
 *
 * Sejak RC-S128 penempatan simpanan berjangka mewajibkan kebijakan produk
 * yang berlaku pada tanggal penempatan. Fixture test yang membuat kontrak
 * lewat `setorSimpananBerjangka()` menanam satu versi kebijakan lewat
 * helper ini. Default-nya `bungaPasca = false` — perilaku kontrak setelah
 * jatuh tempo SAMA dengan sebelum RC-S128 (tanpa bunga pasca jatuh tempo),
 * sehingga test lama tetap menguji hal yang sama.
 *
 * Ditulis langsung ke tabel (tanpa izin/role) karena ini data uji, bukan
 * jalur aplikasi. Jalur aplikasi (`simpanKebijakanProduk`) diuji sendiri.
 */
export interface OpsiKebijakanUji {
  id?: string;
  versi?: string;
  berlakuMulai?: string;
  bungaPasca?: boolean;
  ratePasca?: number | null;
}

interface DbMinimal {
  runAsync(sql: string, ...params: any[]): Promise<unknown>;
}

export async function seedKebijakanProdukUji(db: DbMinimal, opsi: OpsiKebijakanUji = {}): Promise<string> {
  const id = opsi.id ?? `kbp-${opsi.versi ?? 'UJI-1'}`;
  const pasca = opsi.bungaPasca ?? false;
  await db.runAsync(
    `INSERT INTO simpanan_berjangka_kebijakan_produk
      (id, versi, berlaku_mulai, status, auto_renewal, bunga_pasca_jatuh_tempo_aktif, rate_pasca_jatuh_tempo,
       basis_rate, metode_periode, bunga_dikreditkan_ke, kapitalisasi_bunga, pokok_tetap_di_berjangka,
       dasar_penetapan, ditetapkan_oleh, ditetapkan_pada, created_by, created_at)
     VALUES (?,?,?,'AKTIF',0,?,?,'TAHUNAN','BULAN_KALENDER','SIMPANAN_SUKARELA',0,1,
             'Keputusan pengurus (data uji)','Pengurus (uji)','2000-01-01','user-1',?)`,
    id,
    opsi.versi ?? 'UJI-1',
    opsi.berlakuMulai ?? '2000-01-01',
    pasca ? 1 : 0,
    pasca ? opsi.ratePasca ?? null : null,
    new Date().toISOString()
  );
  return id;
}
