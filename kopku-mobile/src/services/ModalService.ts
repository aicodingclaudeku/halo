import { withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { catatAsetTetapDariModalBarang, validasiMasaManfaatDanResidu } from '@/services/AsetService';

/** Sub-fitur "Modal" (Penerimaan) — dua bentuk: Modal Uang & Modal Barang. */

export interface TerimaModalUangInput {
  nilai: Rupiah;
  metodePembayaran: 'TUNAI' | 'TRANSFER';
  bankAccountId?: string; // wajib jika metodePembayaran = TRANSFER
  tanggal: string;
  keterangan?: string;
  createdBy: string;
}

/** Modal Uang: DEBIT Kas/Bank, KREDIT Ekuitas Lainnya. */
export async function terimaModalUang(input: TerimaModalUangInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const sumberDana = input.metodePembayaran === 'TUNAI' ? 'KAS' : 'BANK';
    if (sumberDana === 'BANK' && !input.bankAccountId) {
      throw new Error('Rekening bank wajib dipilih untuk metode transfer.');
    }
    const kasBankAccountId = await resolveKasBankAccountId(db, sumberDana, input.bankAccountId);
    const modalAccountId = await resolveAccountId(db, 'MODAL_LAINNYA', 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'MDL', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'MODAL_UANG',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penerimaan modal uang - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.nilai, kredit: 0 },
        { accountId: modalAccountId, debit: 0, kredit: input.nilai },
      ],
    });

    return { nomorTransaksi, journalId };
  });
}

export interface TerimaModalBarangInput {
  namaBarang: string;
  nilaiPerolehan: Rupiah;
  masaManfaatBulan: number;
  tanggal: string;
  /** PHASE 5 (§F/§I, permintaan pengguna): WAJIB — barang yang diterima sebagai modal SELALU menjadi aset tetap, jadi klasifikasi wajib diisi & divalidasi terhadap master aset_klasifikasi (lihat catatAsetTetapDariModalBarang). */
  kelompokAset: string;
  subKelompokAset: string;
  /**
   * RC-S50 §2 — klasifikasi barang modal: Aset Tetap atau Aset Tak
   * Berwujud. Memakai jalur existing masing-masing:
   *   'TETAP'        -> mapping ASET_TETAP           (akun 1-1500) -> penyusutan
   *   'TAK_BERWUJUD' -> mapping ASET_TAK_BERWUJUD    (akun 1-1700) -> amortisasi
   * Kedua mapping SUDAH ADA dan sudah dipakai `beliAset`; tidak ada
   * akun/COA/mapping baru yang dibuat untuk fitur ini. Default 'TETAP'
   * = perilaku sebelum RC ini.
   */
  jenisAset?: 'TETAP' | 'TAK_BERWUJUD';
  keterangan?: string;
  createdBy: string;
}

/**
 * Modal Barang: aset non-tunai yang disetor sebagai modal, langsung
 * masuk register Aset Tetap (masa manfaat dicatat untuk dasar
 * penyusutan). DEBIT Aset Tetap, KREDIT Ekuitas Lainnya — TIDAK
 * menyentuh kas/bank sama sekali.
 */
export async function terimaModalBarang(input: TerimaModalBarangInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    // Phase 9: sama seperti beliAset — masaManfaatBulan tidak masuk
    // jurnal jadi tidak kena guard AccountingEngine, divalidasi di sini.
    // Modal Barang selalu residu 0 (lihat catatAsetTetapDariModalBarang).
    validasiMasaManfaatDanResidu(input.nilaiPerolehan, 0, input.masaManfaatBulan);
    // PHASE 5 (§F/§I, permintaan pengguna): validasi awal cepat/jelas
    // sebelum jurnal dibuat — validasi SUNGGUHAN (terhadap master
    // aset_klasifikasi, harus ada & aktif) tetap terjadi lagi di
    // catatAsetTetapDariModalBarang (satu sumber kebenaran, TIDAK ADA
    // rumus kedua) — ini murni early-exit UX supaya error jelas
    // sebelum kerja jurnal dimulai.
    if (!input.kelompokAset?.trim() || !input.subKelompokAset?.trim()) {
      throw new Error('Klasifikasi aset (Kelompok & Sub Kelompok) wajib diisi untuk barang yang menjadi aset tetap.');
    }
    // RC-S50 §2 — akun debit mengikuti jenis aset, memakai mapping yang
    // SAMA dengan jalur Pembelian Aset (`AsetService.beliAset`). Tidak
    // ada resolusi akun kedua dan tidak ada hardcode kode akun di sini.
    const jenisAset = input.jenisAset ?? 'TETAP';
    const asetAccountId = await resolveAccountId(
      db,
      jenisAset === 'TAK_BERWUJUD' ? 'ASET_TAK_BERWUJUD' : 'ASET_TETAP',
      'DEBIT_ASET'
    );
    const modalAccountId = await resolveAccountId(db, 'MODAL_LAINNYA', 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'MDL', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'MODAL_BARANG',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penerimaan modal ${
        jenisAset === 'TAK_BERWUJUD' ? 'aset tak berwujud' : 'barang'
      }: ${input.namaBarang} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: asetAccountId, debit: input.nilaiPerolehan, kredit: 0 },
        { accountId: modalAccountId, debit: 0, kredit: input.nilaiPerolehan },
      ],
    });

    const aset = await catatAsetTetapDariModalBarang(db, {
      namaAset: input.namaBarang,
      nilaiPerolehan: input.nilaiPerolehan,
      masaManfaatBulan: input.masaManfaatBulan,
      tanggal: input.tanggal,
      journalId,
      kelompokAset: input.kelompokAset,
      subKelompokAset: input.subKelompokAset,
      jenisAset,
      keterangan: input.keterangan,
      createdBy: input.createdBy,
    });

    return { nomorTransaksi, journalId, asetId: aset.id, nomorAset: aset.nomorAset };
  });
}
