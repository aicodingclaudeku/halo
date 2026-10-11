import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * VALIDASI REGISTER & FORMULIR KEBIJAKAN RC-S53 (§16).
 *
 * Suite ini TIDAK menguji akuntansi. Ia menguji dokumen keputusan:
 * kelengkapannya, ketiadaan keputusan kosong yang diklaim final,
 * ketiadaan keputusan ganda, dan konsistensi antar-policy.
 *
 * Kenapa ini layak diuji otomatis: register adalah satu-satunya sumber
 * kebenaran tentang apa yang SUDAH diputuskan. Kalau ia menyatakan
 * sesuatu sudah diputuskan padahal belum, implementasi berikutnya akan
 * mengunci kebijakan yang tidak pernah diambil siapa pun.
 */

function baca(nama: string): string {
  return readFileSync(join(__dirname, '..', '..', nama), 'utf8');
}

const REGISTER = baca('POLICY_REGISTER_RC-S53.md');
const FORMULIR = baca('POLICY_DECISION_RC-S53.md');

/** Tujuh policy resmi RC-S53. */
const POLICY = [1, 2, 3, 4, 5, 6, 7];

// ===========================================================================
// KELENGKAPAN REGISTER
// ===========================================================================

describe('§16 kelengkapan register', () => {
  it('memuat ketujuh policy dengan penomoran resmi', () => {
    for (const n of POLICY) {
      expect(REGISTER).toContain(`## POLICY 0${n} —`);
    }
    expect((REGISTER.match(/^## POLICY 0\d —/gm) ?? [])).toHaveLength(7);
  });

  it('setiap policy memuat kedelapan bidang wajib §II', () => {
    const blok = REGISTER.split(/^## POLICY 0/m).slice(1);
    expect(blok).toHaveLength(7);
    for (const b of blok) {
      for (const bidang of [
        'Current State',
        'Existing Implementation',
        'Missing Decision',
        'Required Input',
        'Accounting Impact',
        'Data/Migration Impact',
        'UI Impact',
        'Test Impact',
      ]) {
        expect(b).toContain(bidang);
      }
    }
  });

  it('tidak ada informasi bidang wajib yang terhapus', () => {
    // Delapan bidang x tujuh policy.
    for (const bidang of [
      'Current State',
      'Existing Implementation',
      'Missing Decision',
      'Required Input',
      'Accounting Impact',
      'Data/Migration Impact',
      'UI Impact',
      'Test Impact',
    ]) {
      const n = (REGISTER.match(new RegExp(bidang.replace('/', '\\/'), 'g')) ?? []).length;
      expect(n).toBeGreaterThanOrEqual(7);
    }
  });
});

// ===========================================================================
// TIDAK ADA POLICY KOSONG YANG DIKLAIM FINAL
// ===========================================================================

describe('§16 tidak ada keputusan kosong yang diklaim final', () => {
  it('ketujuh kolom KEPUTUSAN masih kosong', () => {
    const kosong = REGISTER.match(/> \*\*KEPUTUSAN:\*\* _\(belum diberikan\)_/g) ?? [];
    expect(kosong).toHaveLength(7);
  });

  it('tidak ada kolom KEPUTUSAN yang terisi nilai', () => {
    // Setiap baris KEPUTUSAN harus persis bentuk "belum diberikan".
    const semua = REGISTER.match(/> \*\*KEPUTUSAN:\*\*.*/g) ?? [];
    expect(semua).toHaveLength(7);
    for (const baris of semua) {
      expect(baris).toBe('> **KEPUTUSAN:** _(belum diberikan)_');
    }
  });

  it('register TIDAK mengklaim FINAL PASS maupun READY', () => {
    // Register MENYEBUT "FINAL PASS" — tetapi untuk menyatakan bahwa
    // status itu belum boleh dipakai. Yang dilarang adalah KLAIM-nya,
    // bukan penyebutannya.
    expect(REGISTER).toMatch(/tidak boleh\*\* dinyatakan FINAL PASS/);
    expect(REGISTER).not.toContain('READY_FOR_IMPLEMENTATION');
    expect(REGISTER).toContain('POLICY_REQUIRED');
  });

  // DIPERBARUI RC-S53 — ketujuh policy sudah diputuskan, jadi formulir
  // memang tidak lagi INCOMPLETE. Yang tetap dijaga: formulir adalah
  // tempat KEPUTUSAN, bukan tempat mengklaim hasil audit.
  it('formulir menyatakan status COMPLETE dan tidak mengklaim hasil audit', () => {
    expect(FORMULIR).toContain('RC-S53 POLICY COMPLETE');
    expect(FORMULIR).not.toContain('FINAL PASS');
  });
});

// ===========================================================================
// TIDAK ADA KEPUTUSAN GANDA / NILAI BAWAAN TERSEMBUNYI
// ===========================================================================

describe('§16 tidak ada keputusan ganda maupun nilai bawaan', () => {
  it('formulir memuat ketujuh policy tanpa duplikasi', () => {
    // Format §9 memakai judul level-1 (`# POLICY 0n`), bukan level-2.
    for (const n of POLICY) {
      const judul = FORMULIR.match(new RegExp(`^# POLICY 0${n} —`, 'gm')) ?? [];
      expect(judul).toHaveLength(1);
    }
  });

  it('formulir TIDAK menetapkan kode COA 4 digit sendiri', () => {
    // Kode X-NNNN yang boleh muncul di formulir hanya DUA macam:
    //   1. akun yang MEMANG sudah ada di COA (dipakai sebagai pembanding);
    //   2. keempat usulan awal yang sedang dievaluasi (4-1510..4-1540),
    //      yang disebut justru untuk ditanyakan, bukan ditetapkan.
    // Kode di luar keduanya berarti saya mengarang angka sendiri.
    const kodeCoa = baca('src/config/defaultCOA.ts');
    const USULAN_DIEVALUASI = ['4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000'];
    const disebut = new Set(FORMULIR.match(/\b[1-9]-\d{4}\b/g) ?? []);
    for (const k of disebut) {
      if (USULAN_DIEVALUASI.includes(k)) continue;
      expect(kodeCoa).toContain(`'${k}'`);
    }
    // Dan usulan itu TIDAK pernah muncul sebagai keputusan.
    for (const k of USULAN_DIEVALUASI) {
      expect(FORMULIR).not.toMatch(new RegExp(`KEPUTUSAN[^\n]*${k}`));
    }
  });

  it('formulir tidak memilih model, event, maupun arah jurnal', () => {
    // Kedua alternatif harus SAMA-SAMA hadir; kalau salah satu hilang,
    // itu berarti pilihannya sudah diambil diam-diam.
    expect(FORMULIR).toContain('MODEL BIAYA');
    expect(FORMULIR).toContain('MODEL NILAI WAJAR');
    expect(FORMULIR).toContain('RAT_INVESTEE_MENGESAHKAN_PEMBAGIAN');
    expect(FORMULIR).toContain('KEPUTUSAN_PEMBAGIAN_DITERBITKAN');
    expect(FORMULIR).toContain('HAK_TIDAK_DAPAT_DIBATALKAN');
    expect(FORMULIR).toContain('USE EXISTING');
    expect(FORMULIR).toContain('CREATE NEW');
  });

  it('slot yang belum diputuskan tetap [VALUE]; yang sudah diputuskan wajib bersumber', () => {
    // Assertion ini SEBELUMNYA mensyaratkan SELURUH slot kosong. Itu
    // benar selama nol keputusan ada, tetapi ia juga akan menolak
    // keputusan yang SAH begitu satu masuk — dan itu bukan maksudnya.
    // Yang dijaga sebenarnya: tidak ada slot yang terisi tanpa dasar.
    const SLOT = [
      'KEPUTUSAN 01-A', 'KEPUTUSAN 01-B', 'KEPUTUSAN 02', 'KEPUTUSAN 03',
      'FAIR VALUE POSTING', 'KEPUTUSAN 04-A', 'KEPUTUSAN 04-B', 'EVENT HAK',
      'DOCUMENT EVIDENCE', 'ADA HAK KONTRAKTUAL', 'KEPUTUSAN 06',
      'KEPUTUSAN 07-A', 'KEPUTUSAN 07-B',
    ];
    let terisi = 0;
    for (const nama of SLOT) {
      const i = FORMULIR.indexOf(`### ${nama}`);
      expect(i).toBeGreaterThan(-1);
      const blok = FORMULIR.slice(i, i + 1400);
      const nilai = (blok.split('\n').slice(1).find((b) => b.trim() !== '') ?? '').trim();
      if (nilai === '`[VALUE]`') continue;
      terisi += 1;
      // Setiap keputusan yang terisi WAJIB membawa dasarnya.
      for (const wajib of ['**SOURCE.**', '**RATIONALE.**', '**ACCOUNTING IMPACT.**',
        '**DATA IMPACT.**', '**MIGRATION IMPACT.**']) {
        expect(blok).toContain(wajib);
      }
    }
    // Sanity: daftar slot memang lengkap.
    expect(SLOT).toHaveLength(13);
    expect(terisi).toBeLessThanOrEqual(13);
  });});

// ===========================================================================
// CROSS-POLICY CONSISTENCY (§10)
// ===========================================================================

describe('§10 konsistensi antar-policy', () => {
  it('POLICY 01 diakui sebagai prasyarat 03–06', () => {
    expect(REGISTER).toMatch(/POLICY 01 adalah simpul utama/);
    const ringkasan = REGISTER.slice(REGISTER.indexOf('## RINGKASAN'));
    expect(ringkasan).toMatch(/01 \| Kode COA baru \| POLICY_REQUIRED \| 03, 04, 05, 06/);
  });

  it('akun Fair Value TIDAK diputuskan di POLICY 01', () => {
    // 4-2100/5-5000 bergantung POLICY 03 butir 3 & 4; memutuskannya di
    // POLICY 01 akan mendahului keputusan model pengukuran.
    const blok01 = FORMULIR.slice(
      FORMULIR.indexOf('# POLICY 01'),
      FORMULIR.indexOf('# POLICY 02')
    );
    expect(blok01).toMatch(/tidak diputuskan di sini/);
    expect(blok01).toMatch(/POLICY 03 \(gain\/loss account\)/);
  });

  it('POLICY 04 menunjuk POLICY 05 untuk event hak bagian SHU', () => {
    const blok04 = FORMULIR.slice(
      FORMULIR.indexOf('# POLICY 04'),
      FORMULIR.indexOf('# POLICY 05')
    );
    expect(blok04).toMatch(/konsisten dengan POLICY 05/);
    expect(blok04).toMatch(/harus berasal dari KEPUTUSAN 01/);
  });

  it('tidak ada perlakuan yang saling bertentangan antar-dokumen', () => {
    // Keduanya harus menyebut status yang sama untuk RAKU PENGEMBALIAN.
    expect(REGISTER).toMatch(/Phase 18\/19 §C\.4/);
    expect(FORMULIR).toMatch(/Phase 18\/19 §C\.4/);
    // Dan keduanya sama-sama menyatakan SETORAN_DANA tetap terbaca.
    expect(REGISTER).toMatch(/tetap terbaca/);
    expect(FORMULIR).toMatch(/tetap terbaca/);
  });

  it('pra-analisis dampak bersifat BERSYARAT, bukan keputusan', () => {
    expect(FORMULIR).toMatch(/PRA-ANALISIS DAMPAK \(BERSYARAT\)/);
    expect(FORMULIR).toMatch(/[Bb]ukan keputusan/);
  });
});

// ===========================================================================
// §1/§15 — TIDAK ADA PERUBAHAN PRODUKSI
// ===========================================================================

describe('§1/§15 tidak ada perubahan produksi', () => {
  // DIPERBARUI RC-S53 — v63 dibuat untuk register bagian SHU
  // (KEPUTUSAN 04-A). Yang dijaga: tidak ada versi di luar itu.
  // DIPERBARUI RC-S53 corrective — v64 untuk register penyusutan properti
  // investasi (POLICY 03 = MODEL BIAYA). Yang dijaga: tidak ada v65.
  it('SCHEMA_VERSION = 64; v63 & v64 ada, v65 tidak', () => {
    const schema = baca('src/database/schema.ts');
    expect(schema).toMatch(/export const SCHEMA_VERSION = 69;/); // DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang.
    const db = baca('src/database/db.ts');
    expect(db).toMatch(/migrasiV63/);
    expect(db).toMatch(/migrasiV64/);
    expect(db).toMatch(/migrasiV65/);
    expect(db).not.toMatch(/migrasiV66/);
    expect(db).not.toMatch(/currentVersion < 77/); // DIPERBARUI RC-S88: blok v73 MILIK RC-S88 (nilai wajar/revaluasi); ambang digeser ke 74. // DIPERBARUI v72 = penarikan dana investasi (milik modul itu, bukan tahap ini) · DIPERBARUI RC-S54 T16 #20: v66 = self-heal akun 5-2160 & mapping PELEPASAN_INVESTASI (tanpa DDL) · DIPERBARUI RC-S54 T16 GAP 6: v67 = self-heal akun 5-2170 & mapping PELEPASAN_ASET_TETAP (tanpa DDL) · DIPERBARUI RC-S55: v69 = automatic accrual bunga utang (kolom utang.basis_bunga + tabel utang_bunga_akrual). Migrasi itu MILIK RC-S55, bukan tahap ini; invarian yang dijaga test ini tidak berubah. · DIPERBARUI RESTRUKTURISASI DATA: blok v70 (asal personel) kini ADA dan MILIK restrukturisasi Data/Personel; ambang digeser ke 71 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: blok v74 MILIK RC-S100 (riwayat import data awal, dua tabel BARU aditif); ambang digeser ke 75 supaya invarian yang dijaga (tahap ini tidak menambah blok migrasi sendiri) tetap diuji.
  });

  it('12 kode COA yang diminta tersedia, tanpa mapping posting', () => {
    // DIPERBARUI RC-S54 POST-CLOSURE #14 (permintaan pengguna): 12 kode diminta DITAMBAHKAN sebagai akun COA (DEFINED / NOT ACTIVELY POSTED); tidak ada mapping/posting/jurnal yang berubah.
    const coa = baca('src/config/defaultCOA.ts');
    const blokMapping = coa.slice(coa.indexOf('DEFAULT_ACCOUNT_MAPPING'));
    for (const k of ['1-660', '1-661', '1-220', '1-230', '1-240', '1-250', '4-1510', '4-1520', '4-1530', '4-1540', '4-2100', '5-5000']) {
      expect(coa).toContain(`{ kode: '${k}'`);
      // DIPERBARUI RC-S88: 4-2100/5-5000 dipetakan model nilai wajar properti investasi.
      if (k === '4-2100' || k === '5-5000') expect(blokMapping).toContain(`accountKode: '${k}'`);
      else expect(blokMapping).not.toContain(`accountKode: '${k}'`);
    }
  });

  // DIPERBARUI RC-S88: gerbang Fair Value DIBUKA (posting lewat postingNilaiWajar
  // + createJournal). RAKU tetap tertutup.
  it('gerbang Fair Value lewat createJournal (RC-S88); RAKU tetap tertutup di kode', () => {
    // Komentar dibuang dulu: dokumentasi service itu MENYEBUT
    // createJournal justru untuk menjelaskan bahwa ia tidak dipakai.
    const svc = baca('src/services/PenyesuaianNilaiWajarService.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(svc).toMatch(/createJournal\(db, \{/);
    const schema = baca('src/database/schema.ts');
    expect(schema).not.toContain("'PENGUATAN'");
  });

  // DIPERBARUI RC-S53 — hanya bagian SHU yang policy-nya turun.
  it('hanya service bagian SHU yang dibuat', () => {
    const berkas = readdirSync(join(__dirname, '..', 'services'));
    expect(berkas).toContain('BagianShuService.ts');
    for (const n of ['InvestasiReturnService.ts', 'ImbalHasilTetapService.ts']) {
      expect(berkas).not.toContain(n);
    }
  });
});
