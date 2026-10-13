'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · ADAPTER TULIS di renderer (1.0.27).
 *
 * Operasi yang TIDAK ada di adapter Server LAN (electron/server/rendererAdapter.js) tetapi
 * dibutuhkan Asisten AI untuk mengubah data — semuanya memanggil service KOPKU yang SAMA
 * dengan layar desktop, tanpa jalur pintas SQL:
 *
 *   koreksi.pratinjau / koreksi.jalankan
 *       Koreksi transaksi = JURNAL PEMBALIK (transaksi asal tidak dihapus/diedit), opsional
 *       dicatat ulang dengan data yang benar:
 *         - pencairan pinjaman, pembayaran angsuran, setoran data awal → KoreksiTransaksiService
 *           (periksaKoreksiTransaksi + koreksi*; aturan periode, SHU, subledger tetap berlaku);
 *         - setoran/penarikan simpanan biasa → koreksiSimpanan (SimpananService);
 *         - transaksi kas/bank (pendapatan, beban, transfer) → koreksiTransaksiKasBank.
 *   import.pratinjau / import.jalankan
 *       Import Data Awal dari berkas Excel, persis alur layar Import Data Awal:
 *       pratinjauBerkasDataAwal → periksaSebelumImport (BLOKIR/PERINGATAN/INFO) →
 *       jalankanImportDataAwal atas pratinjau YANG SAMA (disimpan di memori dengan kunci).
 *   backup.buat
 *       Backup database terenkripsi (BackupService.createBackup) — sama dengan menu Backup.
 *
 * Fungsi ini DISUNTIKKAN sebagai teks ke jendela KOPKU (webContents.executeJavaScript),
 * jadi harus mandiri (tanpa closure ke modul Node).
 */
function pasangAdapterTulis(ids) {
  'use strict';
  const g = globalThis;
  const kunciIds = JSON.stringify(ids);
  if (g.__kopkuAiTulis && g.__kopkuAiTulis.idsKey === kunciIds) return g.__kopkuAiTulis;

  function galat(kode, pesan) {
    const e = new Error(pesan || kode);
    e.kode = kode;
    return e;
  }
  function R(k) {
    const id = ids[k];
    if (typeof id !== 'number' || typeof g.__r !== 'function') throw galat('LAYANAN_TIDAK_TERSEDIA', 'Fitur ini tidak tersedia pada versi KOPKU ini.');
    return g.__r(id);
  }
  const db = () => R('db').getDb();
  const pratinjauImport = new Map(); // kunci → { r, sifat, cutOff, dibuat }

  async function jurnal(d, journalId) {
    return d.getFirstAsync(
      `SELECT j.id, j.nomor_jurnal, j.nomor_referensi, j.tanggal, j.sumber_transaksi, j.status, j.reversal_of_id, j.deskripsi, ap.status AS periode_status
         FROM journal j LEFT JOIN accounting_period ap ON ap.id = j.period_id WHERE j.id = ?`,
      journalId
    );
  }

  /** Tentukan jalur koreksi sebuah jurnal (tanpa menulis apa pun). */
  async function jalurKoreksi(d, journalId) {
    const j = await jurnal(d, journalId);
    if (!j) throw galat('TIDAK_DITEMUKAN', 'Transaksi (jurnal) tidak ditemukan.');
    const info = { journalId: j.id, nomorJurnal: j.nomor_jurnal, nomorReferensi: j.nomor_referensi, tanggal: j.tanggal, sumber: j.sumber_transaksi, deskripsi: j.deskripsi };
    const khusus = await R('koreksi').periksaKoreksiTransaksi(d, journalId);
    if (khusus) {
      return Object.assign(info, {
        jalur: 'KHUSUS',
        jenis: khusus.jenis,
        boleh: !!khusus.boleh,
        alasanTolak: khusus.alasanTolak || [],
        catatan: khusus.catatan || [],
        asal: khusus.setoran || khusus.pencairan || khusus.angsuran || null,
        bisaCatatUlang: true,
      });
    }
    const tolak = [];
    if (j.reversal_of_id) tolak.push('Jurnal ini adalah jurnal pembalik (hasil koreksi) dan tidak dikoreksi lagi.');
    if (j.status !== 'POSTED') tolak.push('Hanya transaksi berstatus aktif (POSTED) yang dapat dikoreksi; transaksi ini sudah dikoreksi/dibatalkan.');
    if (j.periode_status === 'CLOSED') tolak.push('Transaksi ini berada pada periode akuntansi yang sudah ditutup (CLOSED).');
    const simp = await d.getAllAsync('SELECT * FROM simpanan_transaksi WHERE journal_id = ?', journalId);
    if (simp.length) {
      if (simp.length > 1) tolak.push('Jurnal ini memuat lebih dari satu baris simpanan; koreksi lewat menu History Transaksi › Koreksi di aplikasi.');
      const s0 = simp[0];
      return Object.assign(info, { jalur: 'SIMPANAN', jenis: 'SIMPANAN', boleh: tolak.length === 0, alasanTolak: tolak, catatan: [], asal: { simpananTransaksiId: s0.id, anggotaId: s0.anggota_id, jenis: s0.jenis, tipe: s0.tipe || null, nominal: s0.nominal, tanggal: s0.tanggal }, bisaCatatUlang: false });
    }
    for (const [jenisRek, tabel] of [['KAS', 'kas_transaksi'], ['BANK', 'bank_transaksi']]) {
      const t = await d.getFirstAsync(`SELECT * FROM ${tabel} WHERE journal_id = ?`, journalId);
      if (t) {
        if (t.tipe === 'KOREKSI') tolak.push('Transaksi koreksi tidak bisa dikoreksi lagi.');
        return Object.assign(info, { jalur: 'KASBANK', jenis: jenisRek, boleh: tolak.length === 0, alasanTolak: tolak, catatan: [], asal: { transaksiId: t.id, tipe: t.tipe, nominal: t.nominal, tanggal: t.tanggal, kategori: t.kategori || null }, bisaCatatUlang: false });
      }
    }
    return Object.assign(info, {
      jalur: 'TIDAK_DIDUKUNG',
      boleh: false,
      alasanTolak: ['Jenis transaksi ini belum dapat dikoreksi lewat Asisten AI. Yang didukung: setoran/penarikan simpanan, pencairan pinjaman, pembayaran angsuran, transaksi kas/bank. Untuk jenis lain gunakan menu terkait di aplikasi KOPKU.'],
      catatan: [],
      asal: null,
      bisaCatatUlang: false,
    });
  }

  function wajibAlasan(a) {
    const s = String(a || '').trim();
    if (s.length < 5) throw galat('VALIDASI', 'Alasan koreksi wajib diisi (minimal 5 karakter).');
    return s;
  }

  function ringkasPratinjau(r, peringatan, blokir, lunas) {
    const sheet = {};
    for (const [k, v] of Object.entries(r.hasil || {})) {
      sheet[k] = {
        terbaca: !!v.terbaca,
        jumlahBarisSah: Array.isArray(v.baris) ? v.baris.length : 0,
        galatSheet: v.galatSheet || null,
        galat: (v.galat || []).slice(0, 40),
        jumlahGalat: (v.galat || []).length,
      };
    }
    return {
      totalBarisSah: r.totalBarisSah,
      totalGalat: r.totalGalat,
      galatUmum: (r.galatUmum || []).slice(0, 20),
      siapDiimpor: !!r.siapDiimpor && !blokir,
      adaBlokir: !!blokir,
      pinjamanLunasDilewati: lunas,
      sheet,
      peringatan: peringatan.map((p) => ({ tingkat: p.tingkat, judul: p.judul, pesan: String(p.pesan || '').slice(0, 1200) })),
    };
  }

  const OPS = {
    async 'koreksi.pratinjau'(a) {
      return jalurKoreksi(await db(), String(a.journalId));
    },

    async 'koreksi.jalankan'(a, ctx) {
      const alasan = wajibAlasan(a.alasan);
      const d = await db();
      const p = await jalurKoreksi(d, String(a.journalId));
      if (!p.boleh) throw galat('VALIDASI', `Koreksi ditolak: ${p.alasanTolak.join(' ')}`);
      const ulang = a.catatUlang || null;
      if (ulang && !p.bisaCatatUlang) throw galat('VALIDASI', 'Pencatatan ulang otomatis hanya untuk pencairan pinjaman, angsuran, dan setoran data awal. Catat transaksi pengganti dengan alat transaksi biasa setelah koreksi.');
      if (p.jalur === 'KHUSUS') {
        const K = R('koreksi');
        if (p.jenis === 'SETORAN_SIMPANAN') {
          return K.koreksiSetoranSimpanan({ journalId: p.journalId, alasan, userId: ctx.userId, catatUlang: ulang ? { tanggal: ulang.tanggal, pokok: Number(ulang.pokok || 0), wajib: Number(ulang.wajib || 0), sukarela: Number(ulang.sukarela || 0), sumberDana: ulang.sumberDana, bankAccountId: ulang.bankAccountId, keterangan: ulang.keterangan } : null });
        }
        if (p.jenis === 'PENCAIRAN_PINJAMAN') {
          return K.koreksiPencairanPinjaman({ journalId: p.journalId, alasan, userId: ctx.userId, cairkanUlang: ulang ? { tanggal: ulang.tanggal, sumberDana: ulang.sumberDana, bankAccountId: ulang.bankAccountId } : null });
        }
        if (p.jenis === 'ANGSURAN_PINJAMAN') {
          return K.koreksiAngsuran({ journalId: p.journalId, alasan, userId: ctx.userId, bayarUlang: ulang ? { tanggal: ulang.tanggal, nominal: Number(ulang.nominal || 0), sumberDana: ulang.sumberDana, bankAccountId: ulang.bankAccountId } : null });
        }
        throw galat('VALIDASI', 'Jenis koreksi tidak dikenal.');
      }
      if (p.jalur === 'SIMPANAN') {
        await R('simpananKoreksi').koreksiSimpanan(p.asal.simpananTransaksiId, ctx.userId, alasan);
        return { journalAsalId: p.journalId };
      }
      if (p.jalur === 'KASBANK') {
        await R('kasKoreksi').koreksiTransaksiKasBank(p.jenis, p.asal.transaksiId, ctx.userId, alasan);
        return { journalAsalId: p.journalId };
      }
      throw galat('VALIDASI', p.alasanTolak.join(' '));
    },

    async 'import.pratinjau'(a) {
      const I = R('importBerkas');
      const P = R('panduanImport');
      const sifat = a.sifat === 'TRANSAKSI_BARU' ? 'TRANSAKSI_BARU' : 'SALDO_AWAL';
      const cutOff = sifat === 'SALDO_AWAL' ? String(a.cutOff || '') : undefined;
      if (sifat === 'SALDO_AWAL' && !/^\d{4}-\d{2}-\d{2}$/.test(cutOff)) throw galat('VALIDASI', 'Import Saldo Lama wajib memakai tanggal cut-off (YYYY-MM-DD), mis. saldo per 30 Juni → cut-off 2026-07-01.');
      const r = await I.pratinjauBerkasDataAwal(String(a.uri));
      const peringatan = P.periksaSebelumImport(r, {
        sifat,
        cutOff,
        rekeningBank: (await I.ambilRekeningBankAktif()) || undefined,
        nikTerdaftar: (await I.ambilNikTerdaftar()) || undefined,
        sidikTercatat: (await I.ambilSidikTercatat(r)) || undefined,
        anggotaTerdaftar: (await I.ambilAnggotaTerdaftar()) || undefined,
        kebijakanSyaratPinjaman: (await I.ambilKebijakanSyaratPinjaman()) || undefined,
        kebijakanBerjangka: (await I.ambilKebijakanBerjangka()) || undefined,
      });
      const blokir = !!P.adaBlokir(peringatan);
      const lunas = P.barisPinjamanSudahLunas(r.hasil.pinjaman.baris, sifat, cutOff).length;
      const kunci = 'imp-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      for (const [k, v] of pratinjauImport) if (Date.now() - v.dibuat > 30 * 60 * 1000) pratinjauImport.delete(k);
      pratinjauImport.set(kunci, { r, sifat, cutOff, dibuat: Date.now(), siap: !!r.siapDiimpor && !blokir });
      return Object.assign({ kunci, sifat, cutOff: cutOff || null }, ringkasPratinjau(r, peringatan, blokir, lunas));
    },

    async 'import.jalankan'(a, ctx) {
      const s = pratinjauImport.get(String(a.kunci));
      if (!s) throw galat('VALIDASI', 'Pratinjau import tidak ditemukan atau kedaluwarsa (30 menit). Jalankan pratinjau lagi.');
      if (!s.siap) throw galat('VALIDASI', 'Berkas belum siap diimpor (ada galat atau peringatan BLOKIR). Perbaiki berkas lalu pratinjau ulang.');
      pratinjauImport.delete(String(a.kunci)); // satu pratinjau = satu import (cegah ganda)
      const h = await R('importBerkas').jalankanImportDataAwal(s.r, { createdBy: ctx.userId, namaBerkas: a.namaBerkas || 'Asisten AI', tanggalCutOff: s.sifat === 'SALDO_AWAL' ? s.cutOff : undefined });
      return {
        totalBerhasil: h.totalBerhasil,
        totalGagal: h.totalGagal,
        totalDilewati: h.totalDilewati || 0,
        hitung: h.hitung || null,
        gagal: (h.gagal || []).slice(0, 40),
        dilewati: (h.dilewati || []).slice(0, 40),
        saldoAwalBelumSesuai: h.saldoAwalBelumSesuai != null ? h.saldoAwalBelumSesuai : undefined,
      };
    },

    async 'backup.buat'(_a, ctx) {
      const b = await R('backup').createBackup(ctx.userId);
      return b && typeof b === 'object' ? { berkas: b.fileName || b.nama || null, ukuran: b.size || b.ukuran || null } : { berkas: String(b || '') };
    },
  };

  let rantai = Promise.resolve();
  function antre(fn) {
    const p = rantai.then(fn, fn);
    rantai = p.then(() => undefined, () => undefined);
    return p;
  }
  function klasifikasi(e) {
    if (e && e.kode) return { kode: e.kode, pesan: String(e.message).slice(0, 600) };
    const nama = (e && e.name) || '';
    const pesan = String((e && e.message) || e || '');
    if (nama === 'UnauthorizedError' || nama === 'UserNonaktifError' || nama === 'HanyaAdminError') return { kode: 'IZIN', pesan: pesan.slice(0, 300) };
    if (/SQLITE|no such|syntax error|is not a function|undefined|null/i.test(pesan)) return { kode: 'INTERNAL', pesan: 'Terjadi kesalahan internal pada KOPKU.' };
    return { kode: 'VALIDASI', pesan: pesan.slice(0, 600) || 'Permintaan ditolak.' };
  }
  async function jalankan(op, args, ctx) {
    const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
    if (!fn) return { ok: false, error: { kode: 'OP_TIDAK_DIKENAL', pesan: 'Operasi tidak dikenal.' } };
    if (!ctx || typeof ctx.userId !== 'string') return { ok: false, error: { kode: 'IZIN', pesan: 'Pengguna tidak dikenal.' } };
    try {
      const v = await antre(() => fn(args || {}, ctx));
      return { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
    } catch (e) {
      return { ok: false, error: klasifikasi(e) };
    }
  }
  const api = { idsKey: kunciIds, jalankan, operasi: Object.keys(OPS) };
  Object.defineProperty(g, '__kopkuAiTulis', { value: api, configurable: true, writable: false, enumerable: false });
  return api;
}

/** Modul bundle yang dibutuhkan adapter tulis (dicari dari nama ekspor; lihat bundleIndex.js). */
const KEBUTUHAN_TULIS = {
  db: ['getDb', 'withTransaction', 'runMigrations'],
  koreksi: ['periksaKoreksiTransaksi', 'koreksiSetoranSimpanan', 'koreksiPencairanPinjaman', 'koreksiAngsuran'],
  simpananKoreksi: ['koreksiSimpanan'],
  kasKoreksi: ['koreksiTransaksiKasBank'],
  importBerkas: ['pratinjauBerkasDataAwal', 'ambilNikTerdaftar', 'ambilSidikTercatat', 'ambilAnggotaTerdaftar', 'ambilKebijakanSyaratPinjaman', 'ambilKebijakanBerjangka', 'ambilRekeningBankAktif', 'jalankanImportDataAwal'],
  panduanImport: ['periksaSebelumImport', 'adaBlokir', 'barisPinjamanSudahLunas'],
  backup: ['createBackup', 'listBackups'],
};

/** Bangun indeks modul untuk adapter tulis dari bundle renderer. */
function indeksTulis(rendererDir) {
  const fs = require('node:fs');
  const { indeksEkspor, resolusi, cariBerkasBundle } = require('../server/bundleIndex');
  const r = resolusi(indeksEkspor(fs.readFileSync(cariBerkasBundle(rendererDir), 'utf8')), KEBUTUHAN_TULIS);
  if (r.hilang.length) throw new Error(`Layanan KOPKU untuk perubahan data tidak ditemukan: ${r.hilang.map((h) => h.kunci).join(', ')}`);
  return r.modul;
}

module.exports = { pasangAdapterTulis, KEBUTUHAN_TULIS, indeksTulis };
