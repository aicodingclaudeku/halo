#!/usr/bin/env node
/**
 * AUDIT DATABASE PRODUKSI — RELEASE GATE KOPKU
 * ============================================================
 *
 * Skrip ini menjalankan gate §2–§15 Master Command Sesi 7 terhadap
 * database SUNGGUHAN. Ia TIDAK dapat dijalankan dari fixture test:
 * pertanyaan yang dijawab di sini adalah "apa yang benar-benar ada di
 * database yang sudah berjalan", bukan "apa yang ditulis kode saat ini".
 *
 * SIFATNYA READ-ONLY. File database dibuka sebagai salinan di memori;
 * tidak ada satu pun perintah tulis. Aman dijalankan pada salinan
 * backup produksi. Tetap disarankan memakai CLONE, bukan file aktif
 * (§24).
 *
 * CARA PAKAI
 * ----------
 *   npm install sql.js          # sekali saja, kalau belum ada
 *   node tools/audit-produksi.js /path/ke/koperasi.db
 *
 * Keluar dengan kode 1 bila ada RELEASE BLOCKER, 0 bila bersih.
 */

const fs = require('fs');
const path = require('path');

const AKAR = path.resolve(__dirname, '..');
let initSqlJs;
try {
  initSqlJs = require('sql.js');
} catch {
  console.error('Modul "sql.js" belum terpasang. Jalankan: npm install sql.js');
  process.exit(2);
}

const berkasDb = process.argv[2];
if (!berkasDb) {
  console.error('Pemakaian: node tools/audit-produksi.js <path-database.db>');
  process.exit(2);
}
if (!fs.existsSync(berkasDb)) {
  console.error(`Database tidak ditemukan: ${berkasDb}`);
  process.exit(2);
}

/**
 * Kunci klasifikasi arus kas dibaca LANGSUNG dari source, bukan
 * disalin ke sini. Menyalinnya berarti daftar ini akan basi begitu
 * seseorang menambah jenis transaksi baru — persis cara GAP-CASHFLOW
 * lahir pertama kali.
 */
function bacaKlasifikasiKanonik() {
  const berkas = path.join(AKAR, 'src', 'accounting', 'CashFlowClassification.ts');
  const isi = fs.readFileSync(berkas, 'utf8');
  const mulai = isi.indexOf('CASH_FLOW_CLASSIFICATION: Record<string, KlasifikasiArusKas> = {');
  if (mulai < 0) throw new Error('Struktur CashFlowClassification.ts tidak dikenali.');
  const potongan = isi.slice(mulai, isi.indexOf('\n};', mulai));
  const peta = new Map();
  for (const m of potongan.matchAll(/^\s{2}([A-Z_]+):\s*'(OPERASI|INVESTASI|PENDANAAN|NON_KAS)'/gm)) {
    peta.set(m[1], m[2]);
  }
  if (peta.size === 0) throw new Error('Tidak ada klasifikasi yang terbaca.');
  return peta;
}

const blocker = [];
const peringatan = [];

function judul(teks) {
  console.log('\n' + '='.repeat(70));
  console.log(teks);
  console.log('='.repeat(70));
}

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(berkasDb));

  const semua = (sql, params = []) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  const satu = (sql, params = []) => semua(sql, params)[0] ?? null;
  const angka = (sql, params = []) => {
    const r = satu(sql, params);
    return r ? Number(Object.values(r)[0] ?? 0) : 0;
  };

  console.log(`Database  : ${berkasDb}`);
  const meta = satu(`SELECT version FROM schema_meta WHERE id = 1`);
  console.log(`Schema    : v${meta ? meta.version : '(tidak ada schema_meta)'}`);

  // ---------------------------------------------------------------
  // §2/§3/§7 — AUDIT SUMBER TRANSAKSI
  // ---------------------------------------------------------------
  judul('§2/§3/§7 — SUMBER TRANSAKSI PRODUKSI vs KLASIFIKASI KANONIK');
  const kanonik = bacaKlasifikasiKanonik();
  const distribusi = semua(
    `SELECT sumber_transaksi AS sumber, COUNT(*) AS jumlah
     FROM journal GROUP BY sumber_transaksi ORDER BY jumlah DESC`
  );
  console.log(`Distinct sumber_transaksi di produksi : ${distribusi.length}`);
  console.log(`Kunci klasifikasi kanonik            : ${kanonik.size}\n`);

  console.log('sumber_transaksi'.padEnd(34) + 'jumlah'.padStart(8) + '  klasifikasi');
  console.log('-'.repeat(70));
  const takTerpetakan = [];
  for (const r of distribusi) {
    const sumber = r.sumber;
    const kelas = sumber == null ? '(NULL)' : kanonik.get(sumber) || '*** TIDAK TERPETAKAN ***';
    if (sumber == null || String(sumber).trim() === '' || !kanonik.has(sumber)) {
      takTerpetakan.push({ sumber, jumlah: r.jumlah });
    }
    console.log(String(sumber ?? '(NULL)').padEnd(34) + String(r.jumlah).padStart(8) + '  ' + kelas);
  }

  const tidakDipakai = [...kanonik.keys()].filter(
    (k) => !distribusi.some((r) => r.sumber === k)
  );
  console.log(
    `\nTerpetakan tapi belum pernah dipakai di produksi: ${tidakDipakai.length}` +
      (tidakDipakai.length ? ` (${tidakDipakai.join(', ')})` : '')
  );

  if (takTerpetakan.length > 0) {
    blocker.push(
      `${takTerpetakan.length} sumber_transaksi produksi TIDAK terpetakan: ` +
        takTerpetakan.map((t) => `${t.sumber ?? '(NULL)'} (${t.jumlah}x)`).join(', ')
    );
    console.log(
      '\n>>> Untuk SETIAP nilai di atas, tentukan dulu (§4): arti transaksi, periode\n' +
        '    pemakaian, akun debit, akun kredit, versi aplikasi. JANGAN menebak\n' +
        '    klasifikasinya, dan JANGAN mengembalikan fallback OPERASI.'
    );
  }

  // ---------------------------------------------------------------
  // §6 — SUMBER NULL / KOSONG
  // ---------------------------------------------------------------
  judul('§6 — sumber_transaksi NULL / KOSONG');
  const kosong = angka(
    `SELECT COUNT(*) FROM journal WHERE sumber_transaksi IS NULL OR TRIM(sumber_transaksi) = ''`
  );
  console.log(`Jurnal tanpa sumber_transaksi: ${kosong}`);
  if (kosong > 0) blocker.push(`${kosong} jurnal memiliki sumber_transaksi NULL/kosong.`);

  // ---------------------------------------------------------------
  // §8 — SUMBER NON_KAS PADA BARIS KAS/BANK
  // ---------------------------------------------------------------
  judul('§8 — KONSISTENSI BARIS KAS/BANK');
  const akunKasBank = semua(
    `SELECT DISTINCT a.id, a.kode, a.nama FROM account a
     WHERE a.id IN (
       SELECT account_id FROM account_mapping WHERE transaction_type = 'KAS_UMUM'
       UNION SELECT account_id FROM bank_account
     )`
  );
  console.log(`Akun kas/bank (termasuk rekening nonaktif): ${akunKasBank.length}`);
  if (akunKasBank.length > 0) {
    const ids = akunKasBank.map((a) => `'${a.id}'`).join(',');
    const nonKas = [...kanonik.entries()].filter(([, v]) => v === 'NON_KAS').map(([k]) => `'${k}'`);
    if (nonKas.length > 0) {
      const pelanggar = semua(
        `SELECT j.sumber_transaksi AS sumber, COUNT(*) AS jumlah
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
         WHERE je.account_id IN (${ids})
           AND j.sumber_transaksi IN (${nonKas.join(',')})
           AND j.status IN ('POSTED','REVERSED')
         GROUP BY j.sumber_transaksi`
      );
      if (pelanggar.length === 0) {
        console.log('Tidak ada sumber NON_KAS yang menyentuh akun kas/bank. OK.');
      } else {
        for (const p of pelanggar) {
          console.log(`*** ${p.sumber} diklasifikasi NON_KAS tetapi menyentuh kas/bank ${p.jumlah}x`);
        }
        blocker.push(
          'Sumber NON_KAS ditemukan pada baris jurnal kas/bank: ' +
            pelanggar.map((p) => `${p.sumber} (${p.jumlah}x)`).join(', ') +
            '. Salah satu dari klasifikasi atau jurnalnya keliru — periksa manual.'
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // §11 — INTEGRITAS DATABASE
  // ---------------------------------------------------------------
  judul('§11 — INTEGRITAS DATABASE');
  const integrity = satu(`PRAGMA integrity_check`);
  const nilaiIntegrity = integrity ? Object.values(integrity)[0] : '(gagal dibaca)';
  console.log(`integrity_check  : ${nilaiIntegrity}`);
  if (nilaiIntegrity !== 'ok') blocker.push(`PRAGMA integrity_check = ${nilaiIntegrity}`);

  const fkRusak = semua(`PRAGMA foreign_key_check`);
  console.log(`foreign_key_check: ${fkRusak.length} pelanggaran`);
  if (fkRusak.length > 0) {
    blocker.push(`${fkRusak.length} pelanggaran foreign key.`);
    for (const f of fkRusak.slice(0, 10)) console.log(`  ${JSON.stringify(f)}`);
  }

  const orphanScans = [
    ['jurnal tanpa entry', `SELECT COUNT(*) FROM journal j WHERE NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.journal_id = j.id)`],
    ['entry tanpa jurnal', `SELECT COUNT(*) FROM journal_entry e WHERE NOT EXISTS (SELECT 1 FROM journal j WHERE j.id = e.journal_id)`],
    ['entry tanpa account', `SELECT COUNT(*) FROM journal_entry e WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.id = e.account_id)`],
    ['jadwal tanpa pinjaman', `SELECT COUNT(*) FROM angsuran_jadwal x WHERE NOT EXISTS (SELECT 1 FROM pinjaman p WHERE p.id = x.pinjaman_id)`],
    ['pembayaran tanpa pinjaman', `SELECT COUNT(*) FROM angsuran_pembayaran x WHERE NOT EXISTS (SELECT 1 FROM pinjaman p WHERE p.id = x.pinjaman_id)`],
    ['penyusutan tanpa aset', `SELECT COUNT(*) FROM aset_penyusutan x WHERE NOT EXISTS (SELECT 1 FROM aset_tetap a WHERE a.id = x.aset_id)`],
    ['mapping tanpa account', `SELECT COUNT(*) FROM account_mapping m WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.id = m.account_id)`],
    ['simpanan tanpa anggota', `SELECT COUNT(*) FROM simpanan_transaksi s WHERE NOT EXISTS (SELECT 1 FROM anggota a WHERE a.id = s.anggota_id)`],
  ];
  console.log('\nOrphan scan:');
  for (const [nama, sql] of orphanScans) {
    let n;
    try {
      n = angka(sql);
    } catch (e) {
      console.log(`  ${nama.padEnd(28)}: (tabel tidak ada) — dilewati`);
      continue;
    }
    console.log(`  ${nama.padEnd(28)}: ${n}`);
    if (n > 0) blocker.push(`Orphan "${nama}": ${n} baris.`);
  }

  // ---------------------------------------------------------------
  // §12 — KESEIMBANGAN AKUNTANSI
  // ---------------------------------------------------------------
  judul('§12 — KESEIMBANGAN AKUNTANSI');
  const tot = satu(
    `SELECT COALESCE(SUM(je.debit),0) AS d, COALESCE(SUM(je.kredit),0) AS k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE j.status IN ('POSTED','REVERSED')`
  );
  console.log(`Total debit  : ${tot.d}`);
  console.log(`Total kredit : ${tot.k}`);
  console.log(`Variance     : ${tot.d - tot.k}`);
  if (tot.d !== tot.k) blocker.push(`Jurnal tidak balance: selisih ${tot.d - tot.k}.`);

  // Tanda ditentukan KATEGORI, bukan normal_balance — akun kontra
  // (akumulasi penyusutan, penyisihan) berkategori ASET tetapi
  // bersaldo normal KREDIT dan harus MENGURANGI total aset.
  const perKategori = (kategori) => {
    const arahDebit = kategori === 'ASET' || kategori === 'BEBAN';
    return angka(
      `SELECT COALESCE(SUM(${arahDebit ? 'je.debit - je.kredit' : 'je.kredit - je.debit'}),0)
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       JOIN account a ON a.id = je.account_id
       WHERE a.kategori = ? AND j.status IN ('POSTED','REVERSED')`,
      [kategori]
    );
  };
  const aset = perKategori('ASET');
  const liab = perKategori('LIABILITAS');
  const ekuitas = perKategori('EKUITAS');
  const pendapatan = perKategori('PENDAPATAN');
  const beban = perKategori('BEBAN');
  const shuBerjalan = pendapatan - beban;
  const selisihNeraca = aset - (liab + ekuitas + shuBerjalan);
  console.log(`\nAset                 : ${aset}`);
  console.log(`Liabilitas           : ${liab}`);
  console.log(`Ekuitas              : ${ekuitas}`);
  console.log(`SHU berjalan (P-B)   : ${shuBerjalan}`);
  console.log(`Aset - (L + E + SHU) : ${selisihNeraca}`);
  if (selisihNeraca !== 0) {
    blocker.push(`Persamaan akuntansi tidak seimbang: selisih ${selisihNeraca}.`);
  }

  // ---------------------------------------------------------------
  // §14 — SANITY EIR
  // ---------------------------------------------------------------
  judul('§14 — SANITY FEE INTEGRAL (EIR)');
  let barisEir = [];
  try {
    barisEir = semua(
      `SELECT fi.pinjaman_id AS pid,
              COALESCE(fi.saldo_akhir_carrying,0) AS fee_awal,
              COALESCE((SELECT SUM(m.pendapatan_akuntansi) FROM pinjaman_akuntansi_jasa m
                        WHERE m.pinjaman_id = fi.pinjaman_id
                          AND m.tipe_pengakuan = 'EIR_MONTHLY' AND m.status = 'DIAKUI'),0) AS diakui
       FROM pinjaman_akuntansi_jasa fi
       WHERE fi.tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`
    );
  } catch {
    console.log('Tabel pinjaman_akuntansi_jasa tidak tersedia — dilewati.');
  }
  console.log(`Pinjaman ber-fee integral: ${barisEir.length}`);
  const eirNegatif = barisEir.filter((r) => r.fee_awal - r.diakui < 0);
  const eirLebih = barisEir.filter((r) => r.diakui > r.fee_awal);
  console.log(`  sisaFee < 0        : ${eirNegatif.length}`);
  console.log(`  totalDiakui > fee  : ${eirLebih.length}`);
  if (eirNegatif.length > 0) {
    blocker.push(`${eirNegatif.length} pinjaman memiliki sisa fee EIR NEGATIF.`);
    for (const r of eirNegatif.slice(0, 10)) console.log(`  *** ${r.pid}: fee=${r.fee_awal} diakui=${r.diakui}`);
  }
  if (eirLebih.length > 0) {
    blocker.push(`${eirLebih.length} pinjaman mengakui fee MELEBIHI fee awal.`);
  }

  // ---------------------------------------------------------------
  // §15 — SANITY DEFERRED INCOME
  // ---------------------------------------------------------------
  judul('§15 — SANITY PENDAPATAN DITERIMA DIMUKA (2-1300)');
  const dimukaNegatif = angka(`SELECT COUNT(*) FROM angsuran_jadwal WHERE jasa_dimuka < 0`);
  const dimukaLebih = angka(
    `SELECT COUNT(*) FROM angsuran_jadwal WHERE jasa_dimuka > jasa_terbayar`
  );
  console.log(`jasa_dimuka < 0                 : ${dimukaNegatif}`);
  console.log(`jasa_dimuka > jasa_terbayar     : ${dimukaLebih}`);
  if (dimukaNegatif > 0) blocker.push(`${dimukaNegatif} jadwal memiliki jasa_dimuka negatif.`);
  if (dimukaLebih > 0) {
    blocker.push(`${dimukaLebih} jadwal memiliki jasa_dimuka melebihi jasa_terbayar.`);
  }

  const akunDimuka = satu(
    `SELECT account_id FROM account_mapping
     WHERE transaction_type = 'AKRUAL_JASA_PINJAMAN' AND role = 'DEBIT_DIMUKA'`
  );
  if (!akunDimuka) {
    peringatan.push(
      'Mapping AKRUAL_JASA_PINJAMAN/DEBIT_DIMUKA tidak ada — bridge 2-1300 tidak dapat diperiksa.'
    );
  } else {
    const glDimuka = angka(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0)
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      [akunDimuka.account_id]
    );
    const subKontraktual = angka(
      `SELECT COALESCE(SUM(jasa_dimuka),0) FROM angsuran_jadwal
       WHERE status NOT IN ('DIRESTRUKTURISASI','DIHAPUSBUKU')`
    );
    const subFee = barisEir.reduce((t, r) => t + Math.max(0, r.fee_awal - r.diakui), 0);
    const varianceBridge = glDimuka - (subKontraktual + subFee);
    console.log(`\nGL 2-1300                       : ${glDimuka}`);
    console.log(`Subledger jasa kontraktual      : ${subKontraktual}`);
    console.log(`Subledger fee integral (EIR)    : ${subFee}`);
    console.log(`Variance bridge                 : ${varianceBridge}`);
    if (varianceBridge !== 0) {
      blocker.push(
        `Bridge 2-1300 tidak seimbang: GL ${glDimuka} vs subledger ${subKontraktual + subFee} ` +
          `(selisih ${varianceBridge}).`
      );
    }
  }

  // ---------------------------------------------------------------
  // RINGKASAN
  // ---------------------------------------------------------------
  judul('RINGKASAN RELEASE GATE');
  if (peringatan.length > 0) {
    console.log('PERINGATAN (bukan blocker):');
    for (const p of peringatan) console.log(`  - ${p}`);
    console.log('');
  }
  if (blocker.length === 0) {
    console.log('HASIL: PASS — tidak ada release blocker pada database ini.');
    console.log('\nCatatan: gate ini TIDAK mencakup verifikasi migrasi native');
    console.log('expo-sqlite (§20-§23). Itu harus dijalankan terpisah di perangkat.');
    db.close();
    process.exit(0);
  } else {
    console.log(`HASIL: RELEASE BLOCKER — ${blocker.length} temuan:\n`);
    blocker.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
    console.log('\nJangan rilis sampai seluruh temuan di atas ditutup.');
    console.log('Jangan menutupnya dengan menambah fallback klasifikasi.');
    db.close();
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nAudit gagal dijalankan:', e.message);
  process.exit(2);
});
