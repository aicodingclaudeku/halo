import { readFileSync } from 'fs';
import { join } from 'path';
import { bagiPembayaranBunga } from '@/services/UtangService';

/**
 * RC-S53 TRANCHE 2 — §E (kandidat anggota berjangka) & §Z (bunga utang).
 *
 * Dua jenis assertion, dan perbedaannya penting:
 *
 *   - §Z.1 menguji PERILAKU fungsi murni `bagiPembayaranBunga()`. Ini
 *     satu aturan yang menentukan beban terhitung sekali atau dua kali,
 *     jadi ia sengaja dipisah dari database agar dapat dieksekusi
 *     sungguhan, bukan sekadar dibaca.
 *
 *   - sisanya membaca SOURCE. Jurnal dan kueri SQL hanya dapat diuji
 *     end-to-end lewat `testDb.ts` (sql.js), dan sql.js adalah
 *     devDependency yang tidak terpasang di lingkungan ini. Test
 *     end-to-end-nya ada di berkas terpisah dan JUJUR ditandai belum
 *     dieksekusi — lihat laporan.
 */

function read(relatif: string): string {
  return readFileSync(join(__dirname, '..', '..', relatif), 'utf8');
}

function tanpaKomentar(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ===========================================================================
// §Z.1 — aturan pembagian pembayaran bunga (PERILAKU, dieksekusi)
// ===========================================================================

describe('§Z.1 bagiPembayaranBunga — beban tidak pernah dobel', () => {
  it('seluruh bunga menutup akrual bila outstanding mencukupi', () => {
    expect(bagiPembayaranBunga(1_000_000, 1_000_000)).toEqual({
      keUtangBunga: 1_000_000,
      keBeban: 0,
    });
  });

  it('pembayaran parsial hanya mengurangi liabilitas sebesar yang dibayar', () => {
    expect(bagiPembayaranBunga(300_000, 1_000_000)).toEqual({
      keUtangBunga: 300_000,
      keBeban: 0,
    });
  });

  it('bunga yang belum pernah diakru menjadi beban, bukan liabilitas negatif', () => {
    // Inilah yang mencegah "tukar satu bug dengan bug lain": koperasi
    // yang membayar bunga tanpa memakai form akrual tidak boleh
    // menghasilkan saldo 2-1700 negatif.
    expect(bagiPembayaranBunga(1_000_000, 0)).toEqual({
      keUtangBunga: 0,
      keBeban: 1_000_000,
    });
  });

  it('sebagian sudah diakru — sisanya menjadi beban periode berjalan', () => {
    expect(bagiPembayaranBunga(1_000_000, 700_000)).toEqual({
      keUtangBunga: 700_000,
      keBeban: 300_000,
    });
  });

  it('outstanding lebih besar dari yang dibayar tidak menyeret beban negatif', () => {
    expect(bagiPembayaranBunga(200_000, 5_000_000)).toEqual({
      keUtangBunga: 200_000,
      keBeban: 0,
    });
  });

  it('pembayaran nol tidak menghasilkan baris apa pun', () => {
    expect(bagiPembayaranBunga(0, 1_000_000)).toEqual({ keUtangBunga: 0, keBeban: 0 });
  });

  it('nilai negatif diperlakukan sebagai nol — tidak pernah membalik arah jurnal', () => {
    expect(bagiPembayaranBunga(-500, 1_000)).toEqual({ keUtangBunga: 0, keBeban: 0 });
    expect(bagiPembayaranBunga(1_000, -500)).toEqual({ keUtangBunga: 0, keBeban: 1_000 });
  });

  it('INVARIAN: tidak ada rupiah yang hilang atau diciptakan', () => {
    const kasus: [number, number][] = [
      [1_000_000, 1_000_000],
      [1_000_000, 700_000],
      [1_000_000, 0],
      [300_000, 1_000_000],
      [1, 0],
      [999_999, 500_000],
    ];
    for (const [dibayar, outstanding] of kasus) {
      const { keUtangBunga, keBeban } = bagiPembayaranBunga(dibayar, outstanding);
      expect(keUtangBunga + keBeban).toBe(dibayar);
      expect(keUtangBunga >= 0).toBe(true);
      expect(keBeban >= 0).toBe(true);
      expect(keUtangBunga <= Math.max(outstanding, 0)).toBe(true);
    }
  });
});

// ===========================================================================
// §Z.2 — jurnal pembayaran tidak lagi men-debit beban tanpa syarat
// ===========================================================================

describe('§Z.2 jurnal pembayaran utang', () => {
  const utang = tanpaKomentar(read('src/services/UtangService.ts'));

  it('debit Utang Bunga (KREDIT_AKRUAL) muncul di jalur pembayaran', () => {
    expect(utang).toMatch(
      /const utangBungaAccountId = await resolveAccountId\(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL'\);\s*lines\.push\(\{ accountId: utangBungaAccountId, debit: keUtangBunga, kredit: 0 \}\)/
    );
  });

  it('debit Beban Bunga hanya terjadi bila ada bagian yang belum diakru', () => {
    expect(utang).toMatch(/if \(keBeban > 0\) \{[\s\S]{0,240}debit: keBeban/);
  });

  it('tidak ada lagi debit beban sebesar seluruh input.bunga', () => {
    expect(utang).not.toMatch(/accountId: bebanBungaAccountId, debit: input\.bunga/);
  });

  it('akrual TETAP Dr Beban / Cr Utang Bunga — arahnya tidak diubah', () => {
    // RC-S53 Tranche 4: nominalnya kini `nominalDibukukan` (selisih gap
    // control), BUKAN `input.nominal` mentah. ARAH jurnalnya — yang
    // dijaga assertion ini — tidak berubah sedikit pun, dan kedua sisi
    // tetap memakai nominal yang SAMA sehingga jurnal tetap balanced.
    expect(utang).toMatch(/\{ accountId: bebanBungaAccountId, debit: nominalDibukukan, kredit: 0 \}/);
    expect(utang).toMatch(/\{ accountId: utangBungaAccountId, debit: 0, kredit: nominalDibukukan \}/);
  });

  it('seluruh jurnal tetap lewat AccountingEngine.createJournal', () => {
    expect(utang).toMatch(/await createJournal\(db, \{/);
    expect(utang).not.toMatch(/INSERT INTO journal\b/);
    expect(utang).not.toMatch(/INSERT INTO journal_entry\b/);
  });
});

// ===========================================================================
// §Z.3 — rekonsiliasi & guard double-submit
// ===========================================================================

describe('§Z.3 rekonsiliasi bunga & double-submit', () => {
  const utang = tanpaKomentar(read('src/services/UtangService.ts'));

  it('rekonsiliasi membaca akrual dari ledger dan pembayaran dari utang_pembayaran', () => {
    expect(utang).toMatch(/FROM journal_entry je[\s\S]{0,200}sumber_transaksi = 'UTANG_BUNGA'/);
    // RC-S54 TAHAP 10 — pola teks diperbarui, sumbernya TIDAK berubah.
    // Pembayaran tetap dibaca dari `utang_pembayaran`, tetapi per baris
    // (bukan SUM) supaya aturan `bagiPembayaranBunga` dapat diputar ulang:
    // SUM lama ikut mengurangkan bagian yang dibebankan saat bayar dari
    // outstanding -> beban ganda setelah kelebihan bayar (bukti:
    // UtangBungaGapControlRcS54 "7b").
    expect(utang).toMatch(/FROM utang_pembayaran WHERE utang_id = \? AND bunga > 0/);
    expect(utang).toMatch(/bagiPembayaranBunga\(k\.bayar\.bunga, outstanding\)/);
  });

  it('total akrual memakai basis status yang SAMA dengan buku besar', () => {
    // ASSERTION LAMA MENGUNCI SEBUAH BUG. Ia mensyaratkan
    // `NOT IN ('VOID','REVERSED')`, padahal `reverseJournal()` menandai
    // jurnal ASAL sebagai REVERSED dan menerbitkan pembalik ber-status
    // POSTED dengan sumber_id yang sama. Membuang yang asal sambil
    // menahan pembaliknya membuat akrual bersih NEGATIF, bukan nol.
    //
    // Yang benar adalah basis yang dipakai `getAccountBalance()`:
    // IN ('POSTED','REVERSED'). Perlindungannya tidak hilang — VOID
    // (draft yang tak pernah diposting) tetap dibuang — dan §Z.4 di
    // suite Tranche 4 membuktikan reversal benar-benar menetralkan
    // akrual dengan database sungguhan.
    expect(utang).toMatch(/j\.status IN \('POSTED','REVERSED'\)/);
    expect(utang).not.toMatch(/j\.status NOT IN \('VOID','REVERSED'\)/);
  });

  it('outstanding tidak pernah negatif; kelebihan bayar dilaporkan terpisah', () => {
    // RC-S54 TAHAP 10 — invarian sama, rumus sumber diganti replay (Fix D):
    // outstanding tetap di-clamp HANYA untuk penyajian ke `bayarUtang`, dan
    // kelebihan bayar tetap dilaporkan terpisah (= bagian dibebankan saat bayar).
    expect(utang).toMatch(/outstanding: replay\.outstanding > 0 \? replay\.outstanding : 0/);
    expect(utang).toMatch(/kelebihanDibayar: replay\.dibebankanSaatBayar/);
  });

  it('akrual berulang untuk periode yang sama tidak menambah beban', () => {
    // Guard Tranche 2 (tanggal + nominal identik) DIGANTI gap control
    // per periode, bukan dilonggarkan. Guard lama lolos untuk akrual
    // 1.000.000 dua kali dengan tanggal BERBEDA di bulan yang sama —
    // justru kasus yang paling mungkin terjadi. Gap control menutup
    // keduanya, jadi guard lama dihapus alih-alih ditumpuk.
    expect(utang).toMatch(/getGapAkrualBungaUtangPadaDb\(db, input\.utangId, periodeKey, input\.nominal\)/);
    expect(utang).toMatch(/if \(gap\.sisaGap <= 0\)/);
    // RC-S54 TAHAP 10 — ASSERTION LAMA MENGUNCI SEBUAH BUG (Fix A). Periode
    // jurnal pembalik diambil dari jurnal ASAL; `reverseJournal()` memberi
    // pembalik tanggal hari reversal, sehingga `substr(j.tanggal...)` membuat
    // gap periode asal tidak pernah terbuka lagi bila reversal dilakukan di
    // bulan berikutnya (bukti: GapControlBungaUtangRcS53 #14-16 gagal dengan
    // jam 2026-10; UtangBungaGapControlRcS54 #13).
    expect(utang).toMatch(/substr\(COALESCE\(asal\.tanggal, j\.tanggal\), 1, 7\) = \?/);
  });

  it('saldo yang tidak cocok TIDAK diperbaiki diam-diam', () => {
    // Tidak ada UPDATE saldo/ledger di mana pun di service ini.
    expect(utang).not.toMatch(/UPDATE account SET/);
    expect(utang).not.toMatch(/UPDATE journal_entry/);
  });
});

// ===========================================================================
// §E — kandidat anggota mode BERJANGKA
// ===========================================================================

describe('§E kandidat anggota Simpanan Berjangka', () => {
  const service = tanpaKomentar(read('src/services/SimpananBerjangkaService.ts'));
  const picker = tanpaKomentar(read('src/components/AnggotaPicker.tsx'));
  const layar = tanpaKomentar(read('src/screens/Transaksi/TarikSimpananFormScreen.tsx'));

  it('layar meneruskan mode BERJANGKA ke picker', () => {
    expect(layar).toMatch(/onlyWithBerjangkaEligible=\{jenis === 'BERJANGKA'\}/);
  });

  it('mode SUKARELA tetap memakai perilaku lama', () => {
    expect(layar).toMatch(/onlyWithSaldoSukarela=\{jenis === 'SUKARELA'\}/);
  });

  it('picker punya cabang berjangka yang memanggil service, bukan listAnggota', () => {
    expect(picker).toMatch(
      /if \(onlyWithBerjangkaEligible\) \{[\s\S]{0,200}listAnggotaDenganBerjangkaEligible\(/
    );
  });

  it('cabang berjangka diperiksa SEBELUM cabang sukarela dan sebelum fallback', () => {
    const iBerjangka = picker.indexOf('onlyWithBerjangkaEligible) {');
    const iSukarela = picker.indexOf('else if (onlyWithSaldoSukarela)');
    const iFallback = picker.indexOf("listAnggota({ search: query, status: 'AKTIF'");
    expect(iBerjangka).toBeGreaterThan(-1);
    expect(iBerjangka).toBeLessThan(iSukarela);
    expect(iSukarela).toBeLessThan(iFallback);
  });

  it('eligibility memakai status yang SUDAH dipakai ringkasan — bukan aturan baru', () => {
    expect(service).toMatch(
      /STATUS_BERJANGKA_DAPAT_DIPROSES: readonly StatusSimpananBerjangka\[\] = \[\s*'AKTIF',\s*'JATUH_TEMPO',\s*\]/
    );
  });

  it('DICAIRKAN & DIBATALKAN tidak membuat anggota muncul', () => {
    const awal = service.indexOf('STATUS_BERJANGKA_DAPAT_DIPROSES: readonly');
    const blok = service.slice(awal, service.indexOf('];', awal));
    expect(blok).not.toContain('DICAIRKAN');
    expect(blok).not.toContain('DIBATALKAN');
  });

  it('anggota dengan beberapa kontrak muncul SATU kali (GROUP BY a.id)', () => {
    expect(service).toMatch(/INNER JOIN simpanan_berjangka sb/);
    expect(service).toMatch(/GROUP BY a\.id, a\.nomor_anggota/);
  });

  it('penyaringan dilakukan di SQL, bukan setelah data diambil', () => {
    // Menyaring di UI membuat LIMIT dihitung dari himpunan yang salah.
    expect(service).toMatch(/AND sb\.status IN \(\$\{statusPlaceholder\}\)/);
  });

  it('placeholder dibangun dari panjang konstanta, bukan ditulis tangan', () => {
    expect(service).toMatch(
      /STATUS_BERJANGKA_DAPAT_DIPROSES\.map\(\(\) => '\?'\)\.join\(','\)/
    );
  });

  it('berpindah mode mengosongkan anggota terpilih', () => {
    const cocok = layar.match(/setAnggota\(null\);\s*setJenis\('(SUKARELA|BERJANGKA)'\);/g) ?? [];
    expect(cocok.length).toBe(2);
  });

  it('reset TIDAK dipasang sebagai useEffect atas `jenis` (merusak prefill param)', () => {
    expect(layar).not.toMatch(/useEffect\(\(\) => \{\s*setAnggota\(null\)/);
  });

  it('daftar kontrak tetap dibatasi milik anggota terpilih', () => {
    expect(layar).toMatch(/listSimpananBerjangka\(anggota\.id\)/);
  });
});
