'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · KATALOG ALAT.
 *
 * Berkas ini SENGAJA tanpa dependensi (hanya data) karena dipakai di tiga tempat:
 *   1. host MCP di proses utama KOPKU Desktop (electron/mcp/host.js),
 *   2. server stdio yang dijalankan Claude Desktop (electron/mcp/stdio.js),
 *   3. paket ekstensi Claude `.mcpb` (disalin apa adanya oleh electron/mcp/mcpb.js).
 *
 * SEMUA alat hanya MEMBACA. Tidak ada alat yang mencatat transaksi, mengubah
 * anggota, pinjaman, simpanan, kas, maupun pengaturan.
 *
 * `resource` = resource Permission Matrix KOPKU yang wajib boleh `view` oleh
 * pengguna KOPKU yang menyalakan Asisten AI. `perAnggota` = alat menampilkan
 * data per anggota (nama, nomor anggota, saldo) — hanya tersedia bila sakelar
 * "Izinkan data per anggota" ON.
 */

const NAMA_SERVER = 'kopku';
const VERSI_PROTOKOL = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const tanggal = (ket) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${ket} (format YYYY-MM-DD).` });
const batas = (bawaan, maks) => ({ type: 'integer', minimum: 1, maximum: maks, default: bawaan, description: `Jumlah baris maksimum (bawaan ${bawaan}, maks ${maks}).` });

const PETUNJUK = [
  'Server "kopku" membaca data koperasi simpan pinjam dari aplikasi KOPKU Desktop di komputer ini (baca saja).',
  'Semua nominal dalam Rupiah (IDR) tanpa desimal. Tanggal memakai format YYYY-MM-DD.',
  'Mulai dengan ringkasan_koperasi untuk gambaran umum, lalu gunakan alat yang lebih rinci.',
  'Data pribadi (NIK, alamat, nomor HP, tanggal lahir, nomor rekening) tidak pernah dikirim.',
  'Alat tidak dapat mencatat atau mengubah transaksi; arahkan pengguna ke aplikasi KOPKU Desktop untuk itu.',
  'Jawab dalam Bahasa Indonesia kecuali pengguna meminta bahasa lain.',
].join(' ');

/** @type {Array<{name:string,title:string,description:string,inputSchema:object,resource:string|null,perAnggota:boolean}>} */
const ALAT = [
  {
    name: 'status_kopku',
    title: 'Status KOPKU Desktop',
    description: 'Memeriksa koneksi ke KOPKU Desktop: nama koperasi, tahun buku aktif, pengguna yang memberi akses, versi aplikasi, tanggal hari ini, dan apakah data per anggota diizinkan.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resource: null,
    perAnggota: false,
  },
  {
    name: 'ringkasan_koperasi',
    title: 'Ringkasan koperasi',
    description: 'Angka utama koperasi saat ini: jumlah anggota aktif, total simpanan per jenis (pokok/wajib/sukarela), pinjaman aktif & sisa piutang, tunggakan, kolektibilitas, saldo kas/bank, dan transaksi terakhir.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resource: null,
    perAnggota: false,
  },
  {
    name: 'laporan_keuangan',
    title: 'Laporan keuangan',
    description:
      'Laporan keuangan resmi KOPKU (perhitungan sama dengan menu Laporan): posisi_keuangan (neraca, per tanggal), hasil_usaha (LHU/SHU, per periode), laba_rugi (per periode), arus_kas (per periode), perubahan_ekuitas (per periode), neraca_saldo (per tanggal). Tanpa tanggal: per hari ini / periode 1 Januari tahun ini s.d. hari ini.',
    inputSchema: {
      type: 'object',
      properties: {
        jenis: { type: 'string', enum: ['posisi_keuangan', 'hasil_usaha', 'laba_rugi', 'arus_kas', 'perubahan_ekuitas', 'neraca_saldo'], description: 'Jenis laporan.' },
        tanggal: tanggal('Tanggal laporan untuk posisi_keuangan & neraca_saldo'),
        mulai: tanggal('Awal periode untuk laporan periode'),
        selesai: tanggal('Akhir periode untuk laporan periode'),
      },
      required: ['jenis'],
      additionalProperties: false,
    },
    resource: 'laporan',
    perAnggota: false,
  },
  {
    name: 'buku_besar',
    title: 'Buku besar per akun',
    description: 'Mutasi & saldo berjalan satu akun (COA) dalam periode, termasuk saldo awal. Isi kode akun (mis. "1-1000" Kas) atau sebagian nama akun.',
    inputSchema: {
      type: 'object',
      properties: {
        akun: { type: 'string', minLength: 1, maxLength: 80, description: 'Kode akun (mis. 1-1000) atau nama akun.' },
        mulai: tanggal('Awal periode (bawaan 1 Januari tahun ini)'),
        selesai: tanggal('Akhir periode (bawaan hari ini)'),
        batas: batas(100, 500),
      },
      required: ['akun'],
      additionalProperties: false,
    },
    resource: 'laporan',
    perAnggota: false,
  },
  {
    name: 'kolektibilitas_pinjaman',
    title: 'Kolektibilitas pinjaman',
    description: 'Penggolongan kolektibilitas piutang pinjaman (Lancar, Kurang Lancar, Diragukan, Macet) beserta saldo & penyisihan. Rincian per pinjaman hanya bila data per anggota diizinkan.',
    inputSchema: { type: 'object', properties: { rinci: { type: 'boolean', default: false, description: 'Sertakan rincian per pinjaman.' } }, additionalProperties: false },
    resource: 'pinjaman',
    perAnggota: false,
  },
  {
    name: 'riwayat_shu',
    title: 'Riwayat SHU',
    description: 'Riwayat perhitungan & pembagian Sisa Hasil Usaha (SHU) per tahun buku.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resource: 'shu',
    perAnggota: false,
  },
  {
    name: 'saldo_kas_bank',
    title: 'Saldo kas & bank',
    description: 'Saldo setiap rekening kas dan bank yang aktif (tanpa nomor rekening).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resource: 'kas_bank',
    perAnggota: false,
  },
  {
    name: 'daftar_tunggakan',
    title: 'Daftar tunggakan',
    description: 'Angsuran pinjaman yang sudah lewat jatuh tempo dan belum lunas, diurutkan dari yang paling lama terlambat.',
    inputSchema: { type: 'object', properties: { minimal_hari: { type: 'integer', minimum: 0, maximum: 3650, description: 'Hanya tunggakan dengan keterlambatan minimal N hari.' }, batas: batas(50, 500) }, additionalProperties: false },
    resource: 'pinjaman',
    perAnggota: true,
  },
  {
    name: 'cari_anggota',
    title: 'Cari anggota',
    description: 'Cari anggota menurut nama atau nomor anggota. Menampilkan nomor, nama, status, tanggal bergabung.',
    inputSchema: {
      type: 'object',
      properties: {
        cari: { type: 'string', maxLength: 100, description: 'Nama atau nomor anggota (kosong = semua).' },
        status: { type: 'string', enum: ['AKTIF', 'TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'] },
        batas: batas(50, 500),
      },
      additionalProperties: false,
    },
    resource: 'anggota',
    perAnggota: true,
  },
  {
    name: 'detail_anggota',
    title: 'Detail anggota',
    description: 'Detail seorang anggota: status, saldo simpanan pokok/wajib/sukarela, dan daftar pinjamannya.',
    inputSchema: { type: 'object', properties: { anggota: { type: 'string', minLength: 1, maxLength: 100, description: 'Nomor anggota (mis. A00012), ID, atau nama lengkap.' } }, required: ['anggota'], additionalProperties: false },
    resource: 'anggota',
    perAnggota: true,
  },
  {
    name: 'saldo_simpanan',
    title: 'Saldo simpanan anggota',
    description: 'Saldo simpanan pokok, wajib, sukarela, dan total per anggota, beserta totalnya.',
    inputSchema: { type: 'object', properties: { cari: { type: 'string', maxLength: 100, description: 'Filter nama/nomor anggota.' }, batas: batas(100, 1000) }, additionalProperties: false },
    resource: 'simpanan',
    perAnggota: true,
  },
  {
    name: 'daftar_pinjaman',
    title: 'Daftar pinjaman',
    description: 'Daftar pinjaman: nomor, anggota, pokok, sisa piutang, tenor, status, jatuh tempo.',
    inputSchema: {
      type: 'object',
      properties: {
        cari: { type: 'string', maxLength: 100, description: 'Nomor pinjaman atau nama anggota.' },
        kategori: { type: 'string', enum: ['AKTIF', 'BELUM_AKTIF', 'LUNAS', 'DIBATALKAN'], description: 'AKTIF = sudah cair & berjalan, BELUM_AKTIF = diajukan/menunggu pencairan, LUNAS = sudah lunas, DIBATALKAN = ditolak/dibatalkan. Kosong = semua.' },
        batas: batas(50, 500),
      },
      additionalProperties: false,
    },
    resource: 'pinjaman',
    perAnggota: true,
  },
  {
    name: 'detail_pinjaman',
    title: 'Detail pinjaman',
    description: 'Detail satu pinjaman beserta jadwal angsuran (pokok, jasa, denda, terbayar, status per angsuran).',
    inputSchema: { type: 'object', properties: { pinjaman: { type: 'string', minLength: 1, maxLength: 100, description: 'Nomor pinjaman (mis. PJ-2026-000012) atau ID.' } }, required: ['pinjaman'], additionalProperties: false },
    resource: 'pinjaman',
    perAnggota: true,
  },
  {
    name: 'riwayat_transaksi',
    title: 'Riwayat transaksi',
    description: 'Jurnal/transaksi terbaru (setoran, penarikan, pencairan, angsuran, kas, dsb.) dengan filter teks dan tanggal.',
    inputSchema: {
      type: 'object',
      properties: { cari: { type: 'string', maxLength: 100 }, mulai: tanggal('Dari tanggal'), selesai: tanggal('Sampai tanggal'), batas: batas(30, 200) },
      additionalProperties: false,
    },
    resource: 'history_transaksi',
    perAnggota: true,
  },
];

/** Daftar alat untuk `tools/list` (tanpa kolom internal). */
function untukMcp(daftar = ALAT) {
  return daftar.map((a) => ({ name: a.name, title: a.title, description: a.description, inputSchema: a.inputSchema, annotations: { title: a.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
}

module.exports = { NAMA_SERVER, VERSI_PROTOKOL, PETUNJUK, ALAT, untukMcp };
