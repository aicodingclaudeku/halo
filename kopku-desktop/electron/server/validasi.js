'use strict';
/**
 * KOPKU LAN SERVER — VALIDASI INPUT SISI SERVER.
 * Semua data klien dianggap tidak tepercaya. Validator ini hanya memeriksa
 * BENTUK data (tipe, format, panjang, enum). Aturan bisnis (saldo cukup,
 * pembayaran ≤ tunggakan, periode terbuka, anggota aktif, dst.) tetap
 * diputuskan oleh service KOPKU existing.
 */

class GalatValidasi extends Error {
  constructor(pesan, field) {
    super(pesan);
    this.kode = 'VALIDASI';
    this.field = field;
  }
}

function tanggal(v, field, { wajib = true } = {}) {
  if (v == null || v === '') {
    if (wajib) throw new GalatValidasi(`${field} wajib diisi.`, field);
    return null;
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new GalatValidasi(`${field} harus berformat YYYY-MM-DD.`, field);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2200) {
    throw new GalatValidasi(`${field} bukan tanggal yang sah.`, field);
  }
  return v;
}

function rupiah(v, field, { wajib = true, bolehNol = false } = {}) {
  if (v == null || v === '') {
    if (wajib) throw new GalatValidasi(`${field} wajib diisi.`, field);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new GalatValidasi(`${field} harus berupa nilai Rupiah bulat.`, field);
  if (v < 0 || (!bolehNol && v === 0)) throw new GalatValidasi(`${field} harus lebih besar dari 0.`, field);
  if (v > 1e13) throw new GalatValidasi(`${field} terlalu besar.`, field);
  return v;
}

function pilihan(v, field, daftar, { wajib = true } = {}) {
  if (v == null || v === '') {
    if (wajib) throw new GalatValidasi(`${field} wajib dipilih.`, field);
    return undefined;
  }
  if (!daftar.includes(v)) throw new GalatValidasi(`${field} tidak valid.`, field);
  return v;
}

function teks(v, field, { wajib = false, maks = 200, pola = null } = {}) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) {
    if (wajib) throw new GalatValidasi(`${field} wajib diisi.`, field);
    return null;
  }
  if (typeof v !== 'string') throw new GalatValidasi(`${field} harus berupa teks.`, field);
  const t = v.trim();
  if (t.length > maks) throw new GalatValidasi(`${field} maksimal ${maks} karakter.`, field);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)) throw new GalatValidasi(`${field} berisi karakter tidak sah.`, field);
  if (pola && !pola.test(t)) throw new GalatValidasi(`${field} tidak valid.`, field);
  return t;
}

function id(v, field) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_\-]{1,64}$/.test(v)) throw new GalatValidasi(`${field} tidak valid.`, field);
  return v;
}

function bool(v, field) {
  if (typeof v !== 'boolean') throw new GalatValidasi(`${field} harus true/false.`, field);
  return v;
}

function halaman(q) {
  const p = Math.max(1, Math.min(10000, parseInt(q.halaman || '1', 10) || 1));
  return { limit: 50, offset: (p - 1) * 50, halaman: p };
}

const STATUS_ANGGOTA = ['AKTIF', 'TIDAK_AKTIF', 'KELUAR', 'MENINGGAL'];
const JENIS_KELAMIN = ['LAKI_LAKI', 'PEREMPUAN'];
const SUMBER_DANA = ['KAS', 'BANK'];
const JENIS_SIMPANAN = ['POKOK', 'WAJIB', 'SUKARELA'];
const METODE_PELUNASAN = ['JASA_KONTRAKTUAL', 'JASA_TERUTANG'];

/** Data anggota dari klien → objek untuk createAnggota/updateAnggota existing. */
function dataAnggota(b, { buat }) {
  if (!b || typeof b !== 'object') throw new GalatValidasi('Data anggota tidak valid.');
  const out = {
    namaLengkap: teks(b.namaLengkap, 'Nama lengkap', { wajib: true, maks: 150 }),
    nik: teks(b.nik, 'NIK', { maks: 32, pola: /^[0-9A-Za-z.\-]+$/ }),
    jenisKelamin: b.jenisKelamin == null || b.jenisKelamin === '' ? null : pilihan(b.jenisKelamin, 'Jenis kelamin', JENIS_KELAMIN),
    tempatLahir: teks(b.tempatLahir, 'Tempat lahir', { maks: 100 }),
    tanggalLahir: tanggal(b.tanggalLahir, 'Tanggal lahir', { wajib: false }),
    alamat: teks(b.alamat, 'Alamat', { maks: 300 }),
    nomorHp: teks(b.nomorHp, 'Nomor HP', { maks: 20, pola: /^[0-9+()\-.\s]{6,20}$/ }),
    pekerjaan: teks(b.pekerjaan, 'Pekerjaan', { maks: 100 }),
    catatan: teks(b.catatan, 'Catatan', { maks: 500 }),
  };
  if (buat) {
    out.tanggalBergabung = tanggal(b.tanggalBergabung, 'Tanggal bergabung');
    out.status = 'AKTIF';
  } else {
    if (b.tanggalBergabung != null) out.tanggalBergabung = tanggal(b.tanggalBergabung, 'Tanggal bergabung');
    // Ubah: hanya kolom yang DIKIRIM yang diubah; sisanya diambil dari data
    // authoritative oleh adapter. Status anggota tidak diubah lewat LAN
    // (perubahan status keluar/meninggal punya alur bisnis sendiri di desktop).
    for (const k of Object.keys(out)) if (!(k in b)) delete out[k];
  }
  return out;
}


function bulat(v, field, { min = 0, maks = 1e9, wajib = true } = {}) {
  if (v == null || v === '') {
    if (wajib) throw new GalatValidasi(`${field} wajib diisi.`, field);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > maks) throw new GalatValidasi(`${field} harus bilangan bulat ${min}–${maks}.`, field);
  return v;
}

function desimal(v, field, { min = 0, maks = 100, digit = 4 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > maks) throw new GalatValidasi(`${field} harus angka ${min}–${maks}.`, field);
  if (Math.round(v * 10 ** digit) / 10 ** digit !== v) throw new GalatValidasi(`${field} maksimal ${digit} angka di belakang koma.`, field);
  return v;
}

const JENIS_REKENING = ['KAS', 'KAS_KECIL', 'BANK'];
const METODE_JASA = ['EFEKTIF', 'FLAT', 'MENURUN'];
const SATUAN_TENOR = ['HARI', 'MINGGU', 'BULAN'];
const BIAYA_ADMIN_TIPE = ['TIDAK_ADA', 'NOMINAL', 'PERSENTASE'];
const BIAYA_ADMIN_KLASIFIKASI = ['SEPARATE_SERVICE', 'INTEGRAL_FINANCIAL_INSTRUMENT'];
const TUJUAN_PINJAMAN = ['MODAL_KERJA', 'INVESTASI', 'KONSUMTIF', 'LAINNYA'];
const JENIS_AGUNAN = ['TANAH', 'TANAH_DAN_BANGUNAN', 'KENDARAAN', 'DEPOSITO', 'TABUNGAN', 'BARANG_BERGERAK_LAINNYA'];
const JENIS_PERSONEL = ['PENGURUS', 'PENGAWAS', 'PENGELOLA', 'KARYAWAN', 'PEKERJA'];

/** Pengajuan pinjaman (bentuk sama dengan layar Pinjaman desktop; metode CUSTOM hanya di desktop). */
function dataPinjaman(b) {
  if (!b || typeof b !== 'object') throw new GalatValidasi('Data pinjaman tidak valid.');
  const out = {
    anggotaId: id(b.anggotaId, 'Anggota'),
    tanggal: tanggal(b.tanggal, 'Tanggal pengajuan'),
    jumlahPinjaman: rupiah(b.jumlahPinjaman, 'Jumlah pinjaman'),
    tenor: bulat(b.tenor, 'Tenor', { min: 1, maks: 600 }),
    satuanTenor: pilihan(b.satuanTenor, 'Satuan tenor', SATUAN_TENOR),
    metodeJasa: pilihan(b.metodeJasa, 'Metode jasa', METODE_JASA),
    persentaseJasa: desimal(b.persentaseJasa, 'Persentase jasa', { min: 0, maks: 100 }),
    biayaAdminTipe: pilihan(b.biayaAdminTipe || 'TIDAK_ADA', 'Biaya administrasi', BIAYA_ADMIN_TIPE),
    biayaAdminNilai: 0,
    biayaAdminKlasifikasi: 'SEPARATE_SERVICE',
    dendaAktif: b.dendaAktif === true,
    dendaNilai: 0,
    keterangan: teks(b.keterangan, 'Keterangan', { maks: 300 }) || undefined,
  };
  if (out.biayaAdminTipe !== 'TIDAK_ADA') {
    out.biayaAdminNilai = bulat(b.biayaAdminNilai, out.biayaAdminTipe === 'PERSENTASE' ? 'Persentase biaya admin' : 'Nominal biaya admin', { min: 0, maks: out.biayaAdminTipe === 'PERSENTASE' ? 100 : 1e13 });
    out.biayaAdminKlasifikasi = pilihan(b.biayaAdminKlasifikasi || 'SEPARATE_SERVICE', 'Klasifikasi biaya admin', BIAYA_ADMIN_KLASIFIKASI);
  }
  if (out.dendaAktif) {
    out.dendaTipe = 'PER_HARI';
    out.dendaNilai = bulat(b.dendaNilai, 'Denda per hari', { min: 0, maks: 1e9 });
  }
  if (b.tujuanPinjaman) {
    out.tujuanPinjaman = pilihan(b.tujuanPinjaman, 'Tujuan pinjaman', TUJUAN_PINJAMAN);
    if (out.tujuanPinjaman === 'LAINNYA') out.tujuanDetail = teks(b.tujuanDetail, 'Detail tujuan', { wajib: true, maks: 200 });
  }
  if (b.agunan) {
    const a = b.agunan;
    if (typeof a !== 'object') throw new GalatValidasi('Data agunan tidak valid.');
    out.agunan = {
      jenisAgunan: pilihan(a.jenisAgunan, 'Jenis agunan', JENIS_AGUNAN),
      pemilik: teks(a.pemilik, 'Pemilik agunan', { wajib: true, maks: 150 }),
      nomorDokumen: teks(a.nomorDokumen, 'Nomor dokumen agunan', { wajib: true, maks: 100 }),
      nilaiAgunan: rupiah(a.nilaiAgunan, 'Nilai agunan', { bolehNol: true }),
    };
  }
  return out;
}

module.exports = {
  GalatValidasi,
  tanggal,
  rupiah,
  pilihan,
  teks,
  id,
  bool,
  halaman,
  dataAnggota,
  STATUS_ANGGOTA,
  SUMBER_DANA,
  JENIS_SIMPANAN,
  METODE_PELUNASAN,
  bulat,
  desimal,
  dataPinjaman,
  JENIS_REKENING,
  METODE_JASA,
  SATUAN_TENOR,
  JENIS_PERSONEL,
};
