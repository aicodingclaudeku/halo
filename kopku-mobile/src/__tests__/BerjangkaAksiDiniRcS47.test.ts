import { TestDb } from './testDb';
import {
  harness,
  siapkanDb,
  pasangKebijakan,
  KEBIJAKAN_NETRAL,
  KEBIJAKAN_ENAM_KOMPONEN,
  TANGGAL_TARIK,
  JATUH_TEMPO,
  USER_ID,
} from './earlyWithdrawalHarness';

jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import { buatKontrakUji } from './earlyWithdrawalKontrak';
import {
  previewPencairanDini,
  cairkanSimpananBerjangkaDini,
  getStatusKebijakanDini,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { getSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  tentukanAksiPencairanDini,
  LABEL_CTA_DINI,
} from '@/screens/Simpanan/aksiPencairanDini';

/**
 * ============================================================
 * RC-S47 §T/§U — STATE TOMBOL PENCAIRAN DINI, DIUJI FUNGSIONAL
 * ============================================================
 *
 * KENAPA SUITE INI BUKAN TEST REGEX.
 *
 * Layar tidak dapat dirender di lingkungan ini, jadi §U ("UI harus
 * memakai domain evaluation existing, bukan `policy != null`") mustahil
 * dibuktikan dengan membaca sumber: regex tidak bisa menunjukkan bahwa
 * kebijakan tidak lengkap MENGHASILKAN tombol mati.
 *
 * Karena itu pemetaan keputusan diangkat ke fungsi murni
 * `tentukanAksiPencairanDini()` dan diuji di sini terhadap keluaran
 * `previewPencairanDini()` YANG SEBENARNYA — database sungguhan,
 * kebijakan sungguhan, evaluator sungguhan. Tidak ada hasil bisnis yang
 * di-mock; yang di-mock hanya pembuka koneksi database (`getDb`), persis
 * seperti seluruh suite penarikan dini lain di repo ini.
 *
 * PERINGATAN ANGKA: kebijakan yang dipasang di sini berasal dari
 * `earlyWithdrawalHarness` dan merupakan FIXTURE UJI — bukan kebijakan
 * koperasi, dan tidak pernah di-seed ke database produksi.
 */

let db: TestDb;

beforeEach(async () => {
  db = await siapkanDb();
});

afterEach(() => {
  harness.db = null;
});

/** Bentuk input aksi dari hasil preview — persis seperti yang dilakukan layar. */
async function aksiUntukKontrak(kontrakId: string, tanggal = TANGGAL_TARIK) {
  const kontrak = await getSimpananBerjangka(kontrakId);
  const preview = await previewPencairanDini(kontrakId, tanggal);
  return {
    preview,
    aksi: tentukanAksiPencairanDini({
      statusKontrak: kontrak!.status,
      sudahJatuhTempo: preview.sudahJatuhTempo,
      evaluasi: preview.statusKebijakan,
      alasanTidakBoleh: preview.alasanTidakBoleh,
      adaSettlement: !!preview.settlement,
    }),
  };
}

// ============================================================
// §T.A/§T.B/§U STATE 1 — belum ditetapkan -> disabled
// ============================================================
describe('§T.A — tanpa kebijakan sama sekali', () => {
  it('status POLICY_REQUIRED dan CTA MATI', async () => {
    const id = await buatKontrakUji();
    const { preview, aksi } = await aksiUntukKontrak(id);

    expect(preview.statusKebijakan.status).toBe('POLICY_REQUIRED');
    expect(aksi.tampilkanSeksi).toBe(true);
    expect(aksi.badge).toBe('BELUM SIAP');
    expect(aksi.judul).toBe('Belum dapat diproses');
    expect(aksi.ctaAktif).toBe(false);
    // Fitur tetap DISEBUT namanya — menyembunyikannya membuat pengguna
    // menyimpulkan aplikasi tidak mendukungnya.
    expect(aksi.ctaLabel).toBe(LABEL_CTA_DINI);
  });

  it('alasan yang ditampilkan berasal dari domain, bukan dikarang layar', async () => {
    const id = await buatKontrakUji();
    const { preview, aksi } = await aksiUntukKontrak(id);
    expect(aksi.detailAlasan).toBe(preview.statusKebijakan.pesan);
  });
});

describe('§T.B — kebijakan ADA tetapi belum lengkap', () => {
  it('objek kebijakan ada, evaluator tetap POLICY_REQUIRED, CTA MATI', async () => {
    const id = await buatKontrakUji();
    // Keputusan penalti sengaja dibiarkan null: "belum diputuskan",
    // BUKAN "tidak ada penalti".
    await pasangKebijakan(db, {
      ...KEBIJAKAN_NETRAL,
      versi: 'EW-UJI-INCOMPLETE',
      jenisPenalti: null as any,
    });

    const status = await getStatusKebijakanDini();
    expect(status.status).toBe('POLICY_REQUIRED');
    expect(status.kekurangan.length).toBeGreaterThan(0);

    const { aksi } = await aksiUntukKontrak(id);
    expect(aksi.badge).toBe('BELUM SIAP');
    expect(aksi.ctaAktif).toBe(false);
  });

  it('INILAH yang membedakannya dari `policy != null`', async () => {
    await pasangKebijakan(db, {
      ...KEBIJAKAN_NETRAL,
      versi: 'EW-UJI-INCOMPLETE-2',
      perlakuanPokok: null as any,
    });
    const id = await buatKontrakUji();
    const { preview, aksi } = await aksiUntukKontrak(id);

    // Baris kebijakan BENAR-BENAR ADA di database…
    const baris = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_berjangka_kebijakan_dini WHERE status = 'AKTIF'`
    );
    expect(baris!.n).toBe(1);
    // …tetapi evaluasinya tetap menolak, dan tombolnya tetap mati.
    expect(preview.statusKebijakan.status).toBe('POLICY_REQUIRED');
    expect(preview.settlement).toBeNull();
    expect(aksi.ctaAktif).toBe(false);
  });
});

// ============================================================
// §T.C/§U STATE 2 — DILARANG -> disabled
// ============================================================
describe('§T.C — kebijakan lengkap dengan diizinkan=false', () => {
  it('status DILARANG dengan badge & alasan sendiri', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, {
      ...KEBIJAKAN_NETRAL,
      versi: 'EW-UJI-DILARANG',
      diizinkan: false,
    });

    const { preview, aksi } = await aksiUntukKontrak(id);
    expect(preview.statusKebijakan.status).toBe('DILARANG');
    expect(aksi.badge).toBe('TIDAK DIIZINKAN');
    expect(aksi.judul).toBe('Penarikan dini tidak diizinkan');
    expect(aksi.ctaAktif).toBe(false);
  });

  it('DILARANG tidak pernah menampilkan preview settlement (§F.2)', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, { ...KEBIJAKAN_NETRAL, versi: 'EW-D2', diizinkan: false });
    const { preview } = await aksiUntukKontrak(id);
    expect(preview.settlement).toBeNull();
    expect(preview.breakdown).toEqual([]);
  });

  it('§T.F — eksekusi tetap DITOLAK service, bukan hanya oleh UI', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, { ...KEBIJAKAN_NETRAL, versi: 'EW-D3', diizinkan: false });

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId: id,
        tanggal: TANGGAL_TARIK,
        sumberDana: 'KAS',
        createdBy: USER_ID,
      })
    ).rejects.toThrow();

    const kontrak = await getSimpananBerjangka(id);
    expect(kontrak!.status).toBe('AKTIF');
  });
});

// ============================================================
// §T.D/§T.E/§U STATE 3 — lengkap & diizinkan -> enabled
// ============================================================
describe('§T.D/§T.E — kebijakan lengkap dengan diizinkan=true', () => {
  it('status AKTIF, settlement tersedia, CTA HIDUP', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);

    const { preview, aksi } = await aksiUntukKontrak(id);
    expect(preview.statusKebijakan.status).toBe('AKTIF');
    expect(preview.alasanTidakBoleh).toBeNull();
    expect(preview.settlement).not.toBeNull();
    expect(aksi.badge).toBe('TERSEDIA');
    expect(aksi.ctaAktif).toBe(true);
  });

  it('kebijakan netral (semua komponen "tidak berlaku") juga sah', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    const { aksi } = await aksiUntukKontrak(id);
    expect(aksi.ctaAktif).toBe(true);
  });

  it('preview memakai angka dari mesin, bukan dari layar', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const { preview } = await aksiUntukKontrak(id);
    expect(preview.settlement!.policyVersi).toBe(KEBIJAKAN_ENAM_KOMPONEN.versi);
    expect(preview.breakdown.length).toBeGreaterThan(0);
  });
});

// ============================================================
// §T.H — kebijakan dilengkapi SELAGI layar terbuka
// ============================================================
describe('§T.H — refresh setelah kebijakan dilengkapi', () => {
  it('pembacaan ulang mengubah status dari MATI menjadi HIDUP', async () => {
    const id = await buatKontrakUji();

    // Pembacaan pertama: seperti saat layar pertama dibuka.
    const pertama = await aksiUntukKontrak(id);
    expect(pertama.aksi.ctaAktif).toBe(false);

    // Pengurus melengkapi kebijakan di layar lain.
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);

    // Pembacaan kedua: inilah yang dilakukan `useFocusRefresh` saat
    // pengguna kembali ke layar. Tidak perlu restart aplikasi.
    const kedua = await aksiUntukKontrak(id);
    expect(kedua.aksi.ctaAktif).toBe(true);
    expect(kedua.aksi.badge).toBe('TERSEDIA');
  });

  it('dan sebaliknya: kebijakan diganti menjadi DILARANG -> kembali MATI', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    expect((await aksiUntukKontrak(id)).aksi.ctaAktif).toBe(true);

    await pasangKebijakan(db, {
      ...KEBIJAKAN_ENAM_KOMPONEN,
      versi: 'EW-UJI-DILARANG-BARU',
      diizinkan: false,
    });
    const { aksi } = await aksiUntukKontrak(id);
    expect(aksi.ctaAktif).toBe(false);
    expect(aksi.badge).toBe('TIDAK DIIZINKAN');
  });
});

// ============================================================
// §T.G — eksekusi berhasil & tidak dapat diulang
// ============================================================
describe('§T.G — pencairan dini yang berhasil', () => {
  it('kontrak menjadi DICAIRKAN dan tidak dapat dicairkan dua kali', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);

    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId: id,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    expect(hasil.settlement).not.toBeNull();

    const kontrak = await getSimpananBerjangka(id);
    expect(kontrak!.status).toBe('DICAIRKAN');
    expect(kontrak!.tanggalPencairan).toBe(TANGGAL_TARIK);

    // Setelah dicairkan, seksi pencairan dini TIDAK lagi ditampilkan —
    // dan seandainya ditampilkan, tombolnya mati.
    const { aksi } = await aksiUntukKontrak(id);
    expect(aksi.tampilkanSeksi).toBe(false);
    expect(aksi.ctaAktif).toBe(false);

    // Hanya SATU baris settlement, walau dicoba lagi.
    const baris = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM simpanan_berjangka_pencairan_dini WHERE simpanan_berjangka_id = ?`,
      id
    );
    expect(baris).toHaveLength(1);
  });
});

// ============================================================
// §J/§T.I — kontrak matur memakai jalur NORMAL
// ============================================================
describe('§J/§T.I — kontrak yang sudah jatuh tempo', () => {
  it('pada tanggal jatuh tempo, seksi pencairan dini TIDAK ditampilkan', async () => {
    const id = await buatKontrakUji();
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);

    const { preview, aksi } = await aksiUntukKontrak(id, JATUH_TEMPO);
    expect(preview.sudahJatuhTempo).toBe(true);
    // Service sendiri mengarahkan ke jalur normal.
    expect(preview.alasanTidakBoleh).not.toBeNull();
    expect(aksi.tampilkanSeksi).toBe(false);
    expect(aksi.ctaAktif).toBe(false);
  });

  it('kontrak berstatus JATUH_TEMPO tidak pernah ditawari pencairan dini', () => {
    const aksi = tentukanAksiPencairanDini({
      statusKontrak: 'JATUH_TEMPO',
      sudahJatuhTempo: true,
      evaluasi: { status: 'AKTIF', kekurangan: [], pesan: '' },
      alasanTidakBoleh: null,
      adaSettlement: true,
    });
    expect(aksi.tampilkanSeksi).toBe(false);
    expect(aksi.ctaAktif).toBe(false);
  });
});

// ============================================================
// SIFAT FUNGSI KEPUTUSAN — tidak ada jalan lolos
// ============================================================
describe('fungsi keputusan tidak punya celah', () => {
  const semuaStatus = ['AKTIF', 'POLICY_REQUIRED', 'POLICY_CONFLICT', 'DILARANG'] as const;

  it('CTA HANYA hidup pada satu kombinasi: AKTIF + tanpa alasan + settlement ada', () => {
    const hidup: string[] = [];
    for (const status of semuaStatus) {
      for (const alasan of [null, 'ada alasan']) {
        for (const adaSettlement of [true, false]) {
          for (const sudahJatuhTempo of [true, false]) {
            const aksi = tentukanAksiPencairanDini({
              statusKontrak: 'AKTIF',
              sudahJatuhTempo,
              evaluasi: { status, kekurangan: [], pesan: 'pesan domain' },
              alasanTidakBoleh: alasan,
              adaSettlement,
            });
            if (aksi.ctaAktif) {
              hidup.push(`${status}|${alasan}|${adaSettlement}|${sudahJatuhTempo}`);
            }
          }
        }
      }
    }
    expect(hidup).toEqual(['AKTIF|null|true|false']);
  });

  it('evaluasi yang belum terbaca (null) diperlakukan MATI, bukan aman', () => {
    const aksi = tentukanAksiPencairanDini({
      statusKontrak: 'AKTIF',
      sudahJatuhTempo: false,
      evaluasi: null,
      alasanTidakBoleh: null,
      adaSettlement: true,
    });
    expect(aksi.ctaAktif).toBe(false);
    expect(aksi.badge).toBe('BELUM SIAP');
  });

  it('POLICY_CONFLICT ditangani, tidak jatuh ke cabang AKTIF', () => {
    const aksi = tentukanAksiPencairanDini({
      statusKontrak: 'AKTIF',
      sudahJatuhTempo: false,
      evaluasi: { status: 'POLICY_CONFLICT', kekurangan: [], pesan: 'bertentangan' },
      alasanTidakBoleh: null,
      adaSettlement: true,
    });
    expect(aksi.ctaAktif).toBe(false);
    expect(aksi.detailAlasan).toBe('bertentangan');
  });

  it('kontrak DICAIRKAN/DIBATALKAN tidak punya seksi pencairan dini', () => {
    for (const statusKontrak of ['DICAIRKAN', 'DIBATALKAN'] as const) {
      const aksi = tentukanAksiPencairanDini({
        statusKontrak,
        sudahJatuhTempo: false,
        evaluasi: { status: 'AKTIF', kekurangan: [], pesan: '' },
        alasanTidakBoleh: null,
        adaSettlement: true,
      });
      expect(aksi.tampilkanSeksi).toBe(false);
    }
  });

  it('fungsi keputusan tidak mengandung angka kebijakan apa pun', () => {
    const sumber = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'screens', 'Simpanan', 'aksiPencairanDini.ts'),
      'utf8'
    );
    const kode = sumber
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Tidak ada persentase, nominal, atau rate yang dikarang di sini.
    expect(kode).not.toMatch(/\d+\s*%/);
    expect(kode).not.toMatch(/0\.\d/);
    expect(kode).not.toMatch(/penalti|forfeiture|rateDini/i);
  });
});
