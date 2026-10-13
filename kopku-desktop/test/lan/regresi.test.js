'use strict';
/**
 * REGRESI: modul LAN/WhatsApp tidak mengubah perhitungan & data KOPKU.
 *
 * Skenario yang sama (bayar angsuran tepat waktu / terlambat ber-denda /
 * sebelum jatuh tempo (jasa dimuka) / sebagian, pelunasan JASA_TERUTANG &
 * JASA_KONTRAKTUAL, anggota baru, ubah anggota, setor simpanan pokok/wajib/
 * sukarela) dijalankan di DUA proses terpisah:
 *   A. service KOPKU dipanggil langsung (perilaku desktop),
 *   B. lewat API LAN (HTTP → adapter → service yang sama).
 * Seluruh hasil harus IDENTIK: jadwal, pembayaran (porsi pokok/jasa/denda),
 * jurnal per baris & kode akun, saldo akun, Laporan Posisi Keuangan, LHU,
 * tunggakan, saldo simpanan, anggota, audit bisnis, nomor urut, schema & tabel.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function jalankan(mode) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'skenario-regresi.js'), mode], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 240000 });
  return JSON.parse(out.split('@@SNAPSHOT@@')[1]);
}

let A;
let B;
test('skenario langsung (desktop) vs lewat API LAN: seluruh hasil identik', () => {
  A = jalankan('langsung');
  B = jalankan('lan');
  for (const k of Object.keys(A)) assert.deepEqual(B[k], A[k], `bagian "${k}" berbeda`);
});

test('skenario mencakup jalur perhitungan penting (bukan uji kosong)', () => {
  const op = A.hasilOp;
  assert.ok(op[0].porsiDenda > 0, 'pembayaran terlambat berdenda');
  assert.ok(A.jadwal.some((j) => j.jasa_dimuka > 0) || A.jurnal.some((j) => /belum diakui/.test(j.deskripsi || '')) || A.jurnal.some((j) => j.kode === '2-1300'), 'jalur jasa dimuka (bayar sebelum jatuh tempo)');
  assert.ok(op.some((o) => o.rabatJasa > 0), 'pelunasan JASA_TERUTANG dengan rabat');
  assert.ok(A.pinjaman.filter((p) => p.status === 'LUNAS').length >= 2);
  assert.ok(A.jurnal.length > 40);
  assert.equal(A.posisi.selisih, 0, 'neraca seimbang');
  // menu LAN lengkap: tarik sukarela, kas masuk/keluar (kas & bank), transfer, pengajuan+pencairan, pembatalan
  assert.ok(A.simpanan.some((x) => x.tipe === 'TARIK' && x.nominal === 250000), 'tarik simpanan sukarela');
  assert.ok(A.kas.some((x) => x.tipe === 'PENERIMAAN' && x.nominal === 175000), 'kas masuk (pendapatan lain)');
  assert.ok(A.kas.some((x) => x.tipe === 'PENGELUARAN' && x.kategori === 'Beban Listrik'), 'kas keluar (beban)');
  assert.ok(A.bank.some((x) => x.tipe === 'PENGELUARAN' && x.kategori === 'Beban Sewa'), 'bank keluar (beban)');
  assert.ok(A.bank.some((x) => x.tipe === 'TRANSFER' && x.nominal === 5000000), 'transfer kas → bank');
  assert.deepEqual(A.pinjamanBaru.map((p) => p.status), ['AKTIF', 'DITOLAK'], 'pengajuan dicairkan & pengajuan dibatalkan');
  assert.equal(A.agunan.length, 1);
  assert.ok(A.labaRugi.totalBeban > 0 && A.arusKas.terekonsiliasi, 'laba rugi & arus kas terisi dan arus kas terekonsiliasi');
});

test('koperasi.db tetap schema v82, tanpa tabel baru dari modul LAN', () => {
  // DIPERBARUI 1.0.17 / RC-S133.6.2: skema aplikasi v81 (sidik import & koreksi_transaksi, migrasi milik
  // source KOPKU, bukan modul LAN) — invarian "modul LAN tidak menambah tabel ke koperasi.db" TIDAK berubah.
  // DIPERBARUI 1.0.19 / RC-S133.6.4: skema aplikasi v82 (enam kolom pinjaman.penyelesaian_*, migrasi milik
  // source KOPKU) — invarian "modul LAN tidak menambah tabel ke koperasi.db" TIDAK berubah.
  assert.equal(A.schema, 82);
  assert.deepEqual(B.tabel, A.tabel);
  for (const t of ['sesi', 'lan_akses', 'audit_lan', 'whatsapp_notifications', 'idempotensi', 'login_gagal', 'server_meta']) assert.ok(!B.tabel.includes(t), t);
});

test('berkas yang tidak boleh berubah identik dengan sumber asli (renderer, host, shim, installer, skrip, smoke test)', (t) => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline-manifest.json'), 'utf8')).berkas;
  const beda = [];
  // DIPERBARUI 1.0.20 (audit T-15): aset renderer/assets/node_modules/** SENGAJA tidak ikut ZIP sumber
  // (lihat scripts/lengkapi-aset-renderer.js). Bila belum dilengkapi, yang HILANG dilaporkan sebagai
  // diagnostik — bukan "berubah" — karena build dijaga scripts/cek-aset-renderer.js (predist:win/mac
  // gagal sampai `npm run lengkapi:aset`). Aset yang ADA tetap wajib identik dengan manifest.
  const asetHilang = [];
  // Bundle renderer: satu-satunya perubahan yang diizinkan adalah menu
  // "Pengaturan › LAN & WhatsApp" (scripts/pasang-menu-lan-wa.js). Setelah
  // sisipan itu dilepas, isinya harus byte-identik dengan bundle hasil `expo export` source KOPKU (RC-S133.4.5) + tambalan RC-S133.4.6 s.d. RC-S133.4.9 (lihat docs/RC-S133.4.6_*.md … docs/RC-S133.4.9_*.md).
  // DIPERBARUI 1.0.14 / RC-S133.5: hash bundle, kopku-setup.nsi (versi 1.0.14) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.5.js (Claude dihapus, sinkron manual,
  // portal anggota, hapus user & akun anggota massal) — lihat docs/laporan-tambal-rc-s133.5.json.
  // DIPERBARUI 1.0.15 / RC-S133.6: hash bundle, kopku-setup.nsi (versi 1.0.15) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.js (tindak lanjut audit rekonsiliasi:
  // impor Sumber Dana BANK, Arus Kas sukarela, Perubahan Ekuitas antar-tahun, sel persen, tenor pecahan)
  // — lihat docs/laporan-tambal-rc-s133.6.json.
  // DIPERBARUI 1.0.16 / RC-S133.6.1: hash bundle, kopku-setup.nsi (versi 1.0.16) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.1.js (kolom Rekening Bank, pratinjau BANK/NIK,
  // notifikasi di atas modal, rincian SHU Perubahan Ekuitas) — lihat docs/laporan-tambal-rc-s133.6.1.json.
  // DIPERBARUI 1.0.17 / RC-S133.6.2: hash bundle, kopku-setup.nsi (versi 1.0.17) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.2.js (sidik import v81 + salinan pra-migrasi,
  // label/rincian SHU Posisi Keuangan, koreksi transaksi dari History) — lihat docs/laporan-tambal-rc-s133.6.2.json.
  // DIPERBARUI 1.0.18 / RC-S133.6.3: hash bundle, kopku-setup.nsi (versi 1.0.18) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.3.js (export Kolektibilitas Piutang: indeks
  // kolom Rupiah, data fiskal, dokumen berseksi, Excel teks dibungkus) — lihat docs/laporan-tambal-rc-s133.6.3.json.
  // Skema TETAP v81 (tanpa migrasi).
  // DIPERBARUI 1.0.19 / RC-S133.6.4: hash bundle, kopku-setup.nsi (versi 1.0.19) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.4.js (syarat pinjaman per tanggal pengajuan,
  // pencatatan penyelesaian Pengadilan/asuransi) — lihat docs/laporan-tambal-rc-s133.6.4.json. Skema v82.
  // DIPERBARUI 1.0.20 / RC-S133.6.5: hash bundle, kopku-setup.nsi (versi 1.0.20) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.5.js (perbaikan temuan audit
  // KOPKU-AUDIT-TEST-DAMY T-01…T-16) — lihat docs/laporan-tambal-rc-s133.6.5.json. Skema TETAP v82.
  // DIPERBARUI 1.0.21 / RC-S133.6.6: hash bundle, kopku-setup.nsi (versi 1.0.21) dan package-lock.json
  // diperbarui setelah tambalan scripts/tambal-renderer-rc-s133.6.6.js (dialog notifikasi & <Modal> bergaya
  // dialog desktop) — lihat docs/laporan-tambal-rc-s133.6.6.json. Skema TETAP v82.
  // DIPERBARUI pasca-audit KOPKU-AUDIT-TEST-DAMY (versi tetap 1.0.21): hash bundle diperbarui setelah
  // scripts/tambal-renderer-rc-s133.6.6-perbaikan-audit.js — lihat docs/laporan-tambal-perbaikan-audit.json. Skema TETAP v82.
  // DIPERBARUI 1.0.22 / RC-S133.6.7: hash bundle, kopku-setup.nsi (versi 1.0.22) dan package-lock.json diperbarui
  // setelah scripts/tambal-renderer-rc-s133.6.7.js (temuan terbuka audit DAMY F2/F6/F16b/F22/F23/F29 + audit ulang N1)
  // — lihat docs/laporan-tambal-rc-s133.6.7.json. Skema TETAP v82.
  // DIPERBARUI 1.0.23 / RC-S133.6.8: hash bundle, kopku-setup.nsi (versi 1.0.23) dan package-lock.json diperbarui
  // setelah scripts/tambal-renderer-rc-s133.6.8.js (temuan uji import Saldo Lama "Manaz": CALK berjangka, Arus Kas,
  // pratinjau import, cut-off wajib, peringatan Saldo Awal Belum Sesuai) — lihat docs/laporan-tambal-rc-s133.6.8.json. Skema TETAP v82.
  // DIPERBARUI 1.0.24 / RC-S133.6.9: hash bundle, kopku-setup.nsi (versi 1.0.24) dan package-lock.json diperbarui
  // setelah scripts/tambal-renderer-rc-s133.6.9.js (menu Penurunan Nilai Jasa Pinjaman, akun 1-1215/5-2110)
  // — lihat docs/laporan-tambal-rc-s133.6.9.json. Skema TETAP v82.
  // DIPERBARUI 1.0.25: menu "Pengaturan › Asisten AI" (scripts/pasang-menu-asisten-ai.js) juga disisipkan;
  // dilepas lebih dulu, lalu menu LAN & WhatsApp — sisanya harus byte-identik dengan bundle 1.0.24 (hash tidak berubah).
  // Hash kopku-setup.nsi & package-lock.json diperbarui hanya karena nomor versi (1.0.25, 1.0.26). Skema TETAP v82.
  const { lepas } = require(path.join(ROOT, 'scripts', 'pasang-menu-lan-wa.js'));
  const asistenAi = require(path.join(ROOT, 'scripts', 'pasang-menu-asisten-ai.js'));
  for (const [p, h] of Object.entries(m)) {
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) {
      if (p.startsWith('renderer/assets/node_modules/')) asetHilang.push(p);
      else beda.push(`${p} hilang`);
      continue;
    }
    let isi = fs.readFileSync(f);
    if (/^renderer\/_expo\/static\/js\/web\/entry-.*\.js$/.test(p)) {
      const teks = isi.toString('utf8');
      assert.ok(teks.includes('name:"LanWhatsApp"'), 'menu LAN & WhatsApp terpasang di bundle');
      assert.ok(teks.includes('name:"AsistenAi"'), 'menu Asisten AI terpasang di bundle');
      isi = Buffer.from(lepas(asistenAi.lepas(teks)), 'utf8');
    }
    if (crypto.createHash('sha256').update(isi).digest('hex') !== h) beda.push(`${p} berubah`);
  }
  assert.deepEqual(beda, []);
  if (asetHilang.length) {
    t.diagnostic(`${asetHilang.length} aset renderer/assets/node_modules belum dilengkapi (tidak ikut ZIP sumber) — jalankan \`npm run lengkapi:aset\` sebelum build.`);
  }
  // tidak ada berkas baru di renderer/ (UI bisnis tidak disentuh)
  const semua = [];
  const jalan = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? jalan(path.join(d, e.name)) : semua.push(path.relative(ROOT, path.join(d, e.name)))));
  jalan(path.join(ROOT, 'renderer'));
  assert.deepEqual(semua.filter((p) => !m[p]), []);
});
