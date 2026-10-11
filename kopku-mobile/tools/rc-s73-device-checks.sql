-- RC-S73 — PEMERIKSAAN INTEGRITAS DATABASE DI PERANGKAT (read-only, tanpa UPDATE/DELETE)
--
-- Target: koperasi.db milik build DEBUGGABLE (profil EAS `development`), karena
-- `run-as` tidak dapat membaca data APK release (`preview`).
--
-- Ambil database:
--   adb shell run-as id.koperasi.finance cat files/SQLite/koperasi.db > koperasi.db
--   (bila gagal: adb shell run-as id.koperasi.finance ls -R files  — cari koperasi.db)
-- Jalankan:
--   sqlite3 koperasi.db < tools/rc-s73-device-checks.sql
--
-- Setiap blok berlabel [HARUS KOSONG] wajib mengembalikan 0 baris.

.headers on
.mode column

SELECT '== C1 versi skema (HARUS 69)' AS cek;
SELECT version FROM schema_meta;

SELECT '== C2 [HARUS KOSONG] akrual ganda per utang+periode (subledger)' AS cek;
SELECT utang_id, periode, tipe_akrual, COUNT(*) AS n
  FROM utang_bunga_akrual GROUP BY utang_id, periode, tipe_akrual HAVING COUNT(*) > 1;

SELECT '== C3 [HARUS KOSONG] jurnal akrual UTANG_BUNGA ganda per utang+bulan (bukan pembalik)' AS cek;
SELECT sumber_id AS utang_id, substr(tanggal,1,7) AS periode, COUNT(*) AS n
  FROM journal
 WHERE sumber_transaksi = 'UTANG_BUNGA' AND reversal_of_id IS NULL
 GROUP BY sumber_id, substr(tanggal,1,7) HAVING COUNT(*) > 1;

SELECT '== C4 [HARUS KOSONG] jurnal akrual yang BUKAN Dr 5-1950 / Cr 2-1700' AS cek;
SELECT j.id, j.tanggal, a.kode, je.debit, je.kredit
  FROM journal j
  JOIN journal_entry je ON je.journal_id = j.id
  JOIN account a ON a.id = je.account_id
 WHERE j.sumber_transaksi = 'UTANG_BUNGA' AND j.reversal_of_id IS NULL
   AND NOT ((a.kode = '5-1950' AND je.debit > 0 AND je.kredit = 0)
         OR (a.kode = '2-1700' AND je.kredit > 0 AND je.debit = 0));

SELECT '== C5 [HARUS KOSONG] subledger AUTO vs jurnal: nominal tidak sama' AS cek;
SELECT s.utang_id, s.periode, s.nominal_dibukukan, je.kredit AS kredit_2_1700
  FROM utang_bunga_akrual s
  JOIN journal_entry je ON je.journal_id = s.journal_id
  JOIN account a ON a.id = je.account_id AND a.kode = '2-1700'
 WHERE s.mode = 'AUTO' AND s.journal_id IS NOT NULL AND s.nominal_dibukukan <> je.kredit;

SELECT '== C6 ringkasan akrual per utang (untuk dicocokkan dengan kontrak)' AS cek;
SELECT utang_id, COUNT(*) AS periode, SUM(nominal_dibukukan) AS total, MIN(periode) AS dari, MAX(periode) AS sampai
  FROM utang_bunga_akrual GROUP BY utang_id;

SELECT '== C7 [HARUS KOSONG] jurnal tidak seimbang (semua sumber)' AS cek;
SELECT j.id, j.sumber_transaksi, j.tanggal, SUM(je.debit) AS d, SUM(je.kredit) AS k
  FROM journal j JOIN journal_entry je ON je.journal_id = j.id
 GROUP BY j.id HAVING SUM(je.debit) <> SUM(je.kredit);

SELECT '== C8 [HARUS KOSONG] jurnal POSTED di periode CLOSED yang dibuat sesudah periode ditutup' AS cek;
SELECT j.id, j.tanggal, j.sumber_transaksi, j.created_at, p.tahun_buku
  FROM journal j JOIN accounting_period p ON j.tanggal BETWEEN p.periode_mulai AND p.periode_selesai
 WHERE p.status = 'CLOSED' AND p.closed_at IS NOT NULL AND j.created_at > p.closed_at
   AND j.reversal_of_id IS NULL;

SELECT '== C9 [HARUS KOSONG] agunan ganda pada pinjaman belum cair (pasca uji edit)' AS cek;
SELECT pa.pinjaman_id, COUNT(*) AS n
  FROM pinjaman_agunan pa JOIN pinjaman p ON p.id = pa.pinjaman_id
 WHERE p.status IN ('DIAJUKAN','DISETUJUI')
 GROUP BY pa.pinjaman_id HAVING COUNT(*) > 1;

SELECT '== C10 [HARUS KOSONG] jurnal yang merujuk pinjaman belum cair (edit tidak boleh menjurnal)' AS cek;
SELECT j.id, j.sumber_transaksi, j.sumber_id
  FROM journal j JOIN pinjaman p ON p.id = j.sumber_id
 WHERE p.status IN ('DIAJUKAN','DISETUJUI');

SELECT '== C11 foreign key (HARUS KOSONG)' AS cek;
PRAGMA foreign_key_check;

SELECT '== C12 integrity_check (HARUS "ok")' AS cek;
PRAGMA integrity_check;
