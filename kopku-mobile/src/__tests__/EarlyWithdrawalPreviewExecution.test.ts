jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, snapshotBuku,
  KEBIJAKAN_NETRAL, KEBIJAKAN_ENAM_KOMPONEN, USER_ID,
  POKOK, PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import {
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  previewPencairanDini,
  cairkanSimpananBerjangkaDini,
  getStatusKebijakanDini,
  PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-20/EW-21 §AI + §W — PREVIEW vs EXECUTION & MATRIKS TANGGAL. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  kontrakId = await buatKontrakUji();
});

describe('EW-21 §AI — preview = eksekusi', () => {
  it('angka preview sama persis dengan angka yang dibukukan', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);

    const preview = await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(hasil.settlement).toEqual(preview.settlement);
  });

  it('preview TIDAK mengubah apa pun', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const sebelum = await snapshotBuku(db);
    await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('preview tetap sama meski akrual belum dijalankan — eksekusi menyusul angkanya', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    // Tanpa akrual sama sekali.
    const preview = await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    expect(preview.bungaBelumDiakru).toBe(360_000);

    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(hasil.settlement).toEqual(preview.settlement);
  });

  it('preview pada beberapa tanggal berbeda: masing-masing cocok dengan eksekusinya', async () => {
    for (const tanggal of ['2026-07-20', '2026-08-20', '2026-10-01']) {
      const database = await siapkanDb();
      await pasangKebijakan(database, KEBIJAKAN_ENAM_KOMPONEN);
      const id = await buatKontrakUji();
      const preview = await previewPencairanDini(id, tanggal);
      const hasil = await cairkanSimpananBerjangkaDini({
        kontrakId: id, tanggal, sumberDana: 'KAS', createdBy: USER_ID,
      });
      expect(hasil.settlement).toEqual(preview.settlement);
    }
  });

  it('tanpa kebijakan: preview tidak menawarkan angka apa pun', async () => {
    const preview = await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    expect(preview.settlement).toBeNull();
    expect(preview.breakdown).toEqual([]);
    expect(preview.statusKebijakan.status).toBe('POLICY_REQUIRED');
    expect(preview.alasanTidakBoleh).toContain('belum ditetapkan');
  });

  it('status kebijakan bawaan aplikasi = POLICY_REQUIRED', async () => {
    expect((await getStatusKebijakanDini()).status).toBe('POLICY_REQUIRED');
  });

  it('preview memberi tahu tanggal jatuh tempo & bahwa kontrak belum jatuh tempo (§AH)', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    const preview = await previewPencairanDini(kontrakId, TANGGAL_TARIK);
    expect(preview.tanggalJatuhTempo).toBe(JATUH_TEMPO);
    expect(preview.sudahJatuhTempo).toBe(false);
    expect(preview.tanggalMulai).toBe(PLACEMENT);
  });
});

describe('EW-20 §W — matriks tanggal: dini vs jatuh tempo normal', () => {
  beforeEach(async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
  });

  const bolehDini = async (tanggal: string) =>
    (await previewPencairanDini(kontrakId, tanggal)).alasanTidakBoleh;

  it('tanggal penempatan: penarikan dini berlaku, bunga 0', async () => {
    expect(await bolehDini(PLACEMENT)).toBeNull();
    const p = await previewPencairanDini(kontrakId, PLACEMENT);
    expect(p.settlement!.bungaBruto).toBe(0);
    expect(p.settlement!.totalPayout).toBe(POKOK);
  });

  it('penempatan + 1 hari: penarikan dini berlaku', async () => {
    expect(await bolehDini('2026-06-13')).toBeNull();
  });

  it('tengah tenor: penarikan dini berlaku', async () => {
    expect(await bolehDini('2026-09-12')).toBeNull();
  });

  it('sehari sebelum jatuh tempo: penarikan dini berlaku', async () => {
    expect(await bolehDini('2026-12-11')).toBeNull();
  });

  it('tepat pada tanggal jatuh tempo: DITOLAK, diarahkan ke pencairan normal', async () => {
    expect(await bolehDini(JATUH_TEMPO)).toBe(PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL);
  });

  it('setelah jatuh tempo: DITOLAK, diarahkan ke pencairan normal', async () => {
    expect(await bolehDini('2026-12-20')).toBe(PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL);
  });

  it('sebelum tanggal penempatan: DITOLAK', async () => {
    expect(await bolehDini('2026-06-01')).toContain('mendahului tanggal penempatan');
  });

  it('eksekusi pada tanggal jatuh tempo pun ditolak, bukan hanya preview', async () => {
    await prosesAkrualBungaKontrak(kontrakId, JATUH_TEMPO, USER_ID);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow(PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL);
  });
});

describe('EW-20 §W/§AM — penarikan dini tidak mengalahkan jatuh tempo normal', () => {
  it('kontrak berstatus JATUH_TEMPO ditolak jalur dini', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(JATUH_TEMPO, USER_ID);

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow(PESAN_SUDAH_JATUH_TEMPO_PAKAI_NORMAL);
  });

  it('pencairan NORMAL tetap membayar pokok & bunga penuh walau kebijakan dini aktif', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await prosesAkrualBungaKontrak(kontrakId, JATUH_TEMPO, USER_ID);
    await prosesJatuhTempoSimpananBerjangka(JATUH_TEMPO, USER_ID);

    const hasil = await cairkanSimpananBerjangka({
      kontrakId, tanggal: JATUH_TEMPO, sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(hasil.pokok).toBe(POKOK);
    // RC-S128 — bunga kontrak penuh tanpa potongan, dikreditkan ke Simpanan
    // Sukarela di dalam pencairan; kas hanya membayar pokok.
    expect(hasil.bunga).toBe(0);
    expect(hasil.bungaDipindahkanSaatPencairan).toBe(720_000);
    expect(hasil.total).toBe(POKOK);

    const n = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini`
    );
    expect(n!.n).toBe(0); // jalur dini tidak tersentuh
  });
});
