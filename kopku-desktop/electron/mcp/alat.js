'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · IMPLEMENTASI ALAT (proses utama).
 *
 * Setiap alat memanggil operasi BACA adapter renderer yang sama dengan
 * Server LAN (electron/server/rendererAdapter.js) → service KOPKU yang sama
 * dengan layar desktop. Tidak ada rumus pinjaman/jasa/SHU/laporan di sini;
 * berkas ini hanya memilih operasi, menyaring kolom, dan meringkas.
 *
 * Tidak ada operasi tulis yang dapat dicapai dari sini: daftar OPERASI_BACA
 * di bawah adalah satu-satunya operasi adapter yang boleh dipanggil.
 */
const { ALAT } = require('./katalog');
const { saring, samarkanTeks } = require('./privasi');

/** Satu-satunya operasi adapter yang boleh dipakai Asisten AI (semuanya BACA). */
const OPERASI_BACA = new Set([
  'sistem.status',
  'auth.user',
  'izin.cek',
  'dashboard.ringkas',
  'anggota.daftar',
  'anggota.detail',
  'pinjaman.daftar',
  'pinjaman.detail',
  'laporan.tunggakan',
  'laporan.posisi',
  'laporan.lhu',
  'laporan.labaRugi',
  'laporan.arusKas',
  'laporan.ekuitas',
  'laporan.neracaSaldo',
  'laporan.bukuBesar',
  'laporan.kolektibilitas',
  'akun.daftar',
  'kas.rekening',
  'simpanan.saldoSemua',
  'history.daftar',
  'shu.riwayat',
]);

/**
 * Kunci yang TIDAK PERNAH dikirim ke AI, di level mana pun, apa pun pengaturannya:
 * identitas pribadi, kontak, rekening, kredensial, berkas foto.
 */
const KUNCI_PRIBADI = /^(nik|no_?ktp|ktp|alamat\w*|nomor_?hp|no_?hp|hp|telepon\w*|nomor_?telepon|phone\w*|email|tempat_?lahir|tanggal_?lahir|tgl_?lahir|nama_?ibu\w*|foto\w*|nomor_?rekening|no_?rekening|nama_?pemilik|npwp\w*|password\w*|pin|pin_?hash|pin_?salt|hash\w*|password_?salt|salt|token\w*|secret\w*|api_?key|versi)$/i;

function bersihkan(nilai, kedalaman = 0) {
  if (kedalaman > 12 || nilai == null) return nilai;
  if (Array.isArray(nilai)) return nilai.map((v) => bersihkan(v, kedalaman + 1));
  if (typeof nilai === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(nilai)) {
      if (KUNCI_PRIBADI.test(k)) continue;
      out[k] = bersihkan(v, kedalaman + 1);
    }
    return out;
  }
  if (typeof nilai === 'number' && !Number.isFinite(nilai)) return null;
  return nilai;
}

class GalatAlat extends Error {
  constructor(pesan) {
    super(pesan);
    this.galatAlat = true;
  }
}

const RE_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
function tgl(v, nama) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  const d = new Date(s + 'T00:00:00Z');
  if (!RE_TANGGAL.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new GalatAlat(`${nama} harus tanggal yang sah dengan format YYYY-MM-DD.`);
  return s;
}
function bulat(v, bawaan, maks) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return bawaan;
  return Math.max(1, Math.min(maks, Math.floor(n)));
}
function teks(v, maks = 100) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().slice(0, maks);
  return s || undefined;
}

/** Tanggal lokal komputer (YYYY-MM-DD). */
function hariIniLokal(now = Date.now()) {
  const d = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function periode(a, hariIni) {
  const selesai = tgl(a.selesai, 'selesai') || hariIni;
  const mulai = tgl(a.mulai, 'mulai') || `${selesai.slice(0, 4)}-01-01`;
  if (mulai > selesai) throw new GalatAlat('Tanggal mulai tidak boleh setelah tanggal selesai.');
  return { mulai, selesai };
}

function potong(daftar, n) {
  const arr = Array.isArray(daftar) ? daftar : [];
  return { baris: arr.slice(0, n), jumlahTotal: arr.length, terpotong: arr.length > n };
}

const jumlah = (arr, k) => (arr || []).reduce((s, x) => s + (Number(x && x[k]) || 0), 0);

/**
 * @typedef {object} KonteksAlat
 * @property {(op:string, args?:object) => Promise<any>} panggil operasi adapter atas nama pengguna
 * @property {(resource:string) => Promise<boolean>} boleh izin `view` pengguna
 * @property {boolean} perAnggota sakelar "Izinkan data per anggota"
 * @property {string} hariIni YYYY-MM-DD
 * @property {object} info { koperasi, tahunBuku, pengguna, versi }
 */

/** @type {Record<string, (a:object, k:KonteksAlat) => Promise<any>>} */
const JALANKAN = {
  async status_kopku(_a, k) {
    return {
      terhubung: true,
      koperasi: k.info.koperasi,
      tahunBukuAktif: k.info.tahunBuku,
      hariIni: k.hariIni,
      aksesAtasNama: k.info.pengguna,
      dataPerAnggota: k.perAnggota ? 'diizinkan' : 'tidak diizinkan (hanya angka total)',
      versiKopkuDesktop: k.info.versi,
      mataUang: 'IDR (Rupiah)',
      catatan: 'Akses baca saja. Data pribadi (NIK, alamat, nomor HP, tanggal lahir, nomor rekening) tidak pernah dikirim.',
    };
  },

  async ringkasan_koperasi(_a, k) {
    const bagian = {
      anggota: await k.boleh('anggota'),
      simpanan: await k.boleh('simpanan'),
      pinjaman: await k.boleh('pinjaman'),
      kas: await k.boleh('kas_bank'),
      history: k.perAnggota && (await k.boleh('history_transaksi')),
    };
    const d = await k.panggil('dashboard.ringkas', { bagian });
    const out = { perTanggal: k.hariIni, koperasi: k.info.koperasi, tahunBuku: k.info.tahunBuku };
    if (d.anggotaAktif !== undefined) out.anggotaAktif = d.anggotaAktif;
    if (d.simpanan) out.totalSimpanan = d.simpanan;
    if (d.pinjaman) {
      out.pinjaman = {
        jumlahPinjamanAktif: d.pinjaman.aktif,
        sisaPiutang: d.pinjaman.sisaPiutang,
        keteranganSisaPiutang: 'pokok + jasa terjadwal yang belum dibayar dari pinjaman aktif',
        menungguPencairan: d.pinjaman.menungguPencairan,
        jumlahAngsuranMenunggak: d.pinjaman.jumlahTunggakan,
        nilaiTunggakan: d.pinjaman.nilaiTunggakan,
      };
      if (k.perAnggota) out.pinjaman.tunggakanTerlama = (d.pinjaman.tunggakanTeratas || []).map((x) => ({ nomorPinjaman: x.nomorPinjaman, namaAnggota: x.namaAnggota, hariTerlambat: x.hariTerlambat, sisaTagihan: x.sisaTagihan }));
    }
    if (d.kolektibilitas) out.kolektibilitas = d.kolektibilitas;
    if (d.rekening) out.kasBank = { rekening: d.rekening.map((r) => ({ jenis: r.jenis, nama: r.nama, saldo: r.saldo })), total: jumlah(d.rekening, 'saldo') };
    if (d.transaksiTerakhir) out.transaksiTerakhir = d.transaksiTerakhir.map((x) => ({ tanggal: x.tanggal, nomor: x.nomorTransaksi, jenis: x.jenisLabel, deskripsi: x.deskripsi, nominal: x.nominal, status: x.status }));
    const tanpaIzin = Object.entries(bagian).filter(([n, v]) => !v && n !== 'history').map(([n]) => n);
    if (tanpaIzin.length) out.tidakDitampilkan = `Pengguna tidak punya izin melihat: ${tanpaIzin.join(', ')}.`;
    return out;
  },

  async laporan_keuangan(a, k) {
    const jenis = String(a.jenis || '');
    if (jenis === 'posisi_keuangan' || jenis === 'neraca_saldo') {
      const tanggal = tgl(a.tanggal, 'tanggal') || k.hariIni;
      const r = await k.panggil(jenis === 'posisi_keuangan' ? 'laporan.posisi' : 'laporan.neracaSaldo', { tanggal });
      if (jenis === 'neraca_saldo' && r && Array.isArray(r.rows)) r.rows = r.rows.map(({ accountId, ...x }) => x);
      return { laporan: jenis, perTanggal: tanggal, data: r };
    }
    const op = { hasil_usaha: 'laporan.lhu', laba_rugi: 'laporan.labaRugi', arus_kas: 'laporan.arusKas', perubahan_ekuitas: 'laporan.ekuitas' }[jenis];
    if (!op) throw new GalatAlat('jenis harus salah satu: posisi_keuangan, hasil_usaha, laba_rugi, arus_kas, perubahan_ekuitas, neraca_saldo.');
    const p = periode(a, k.hariIni);
    const r = await k.panggil(op, p);
    // Rincian arus kas per transaksi menyebut nama/nomor transaksi anggota → hanya bila per anggota ON.
    if (jenis === 'arus_kas' && r && Array.isArray(r.rincian)) {
      const per = {};
      for (const x of r.rincian) {
        const kunci = `${x.aktivitas}|${x.sumberTransaksi}`;
        per[kunci] = per[kunci] || { aktivitas: x.aktivitas, sumber: x.sumberTransaksi, jumlah: 0, banyakTransaksi: 0 };
        per[kunci].jumlah += Number(x.jumlah) || 0;
        per[kunci].banyakTransaksi++;
      }
      r.rekapPerSumber = Object.values(per);
      if (!k.perAnggota) delete r.rincian;
      else if (r.rincian.length > 200) r.rincian = r.rincian.slice(0, 200);
    }
    return { laporan: jenis, periode: p, data: r };
  },

  async buku_besar(a, k) {
    const cari = teks(a.akun, 80);
    if (!cari) throw new GalatAlat('Isi kode atau nama akun.');
    const akun = await k.panggil('akun.daftar', {});
    const kecil = cari.toLowerCase();
    let cocok = akun.filter((x) => String(x.kode).toLowerCase() === kecil);
    if (!cocok.length) cocok = akun.filter((x) => `${x.kode} ${x.nama}`.toLowerCase().includes(kecil));
    if (!cocok.length) throw new GalatAlat(`Akun "${cari}" tidak ditemukan. Gunakan kode akun (mis. 1-1000) atau sebagian nama akun.`);
    if (cocok.length > 1) return { pesan: 'Lebih dari satu akun cocok — ulangi dengan kode akun yang tepat.', kandidat: cocok.slice(0, 30).map((x) => ({ kode: x.kode, nama: x.nama, kategori: x.kategori })) };
    const p = periode(a, k.hariIni);
    const r = await k.panggil('laporan.bukuBesar', { accountId: cocok[0].id, mulai: p.mulai, selesai: p.selesai });
    const n = bulat(a.batas, 100, 500);
    const baris = potong(r.baris, n);
    return { akun: { kode: r.akun.kode, nama: r.akun.nama, kategori: r.akun.kategori, saldoNormal: r.akun.normalBalance }, periode: p, saldoAwal: r.saldoAwal, mutasi: baris.baris, jumlahBaris: baris.jumlahTotal, terpotong: baris.terpotong };
  },

  async kolektibilitas_pinjaman(a, k) {
    const r = await k.panggil('laporan.kolektibilitas', {});
    const out = { perTanggal: k.hariIni, ringkasan: r.ringkasan, totalOutstanding: jumlah(r.ringkasan, 'totalOutstanding'), totalCadangan: jumlah(r.ringkasan, 'totalCadangan') };
    if (a.rinci) {
      if (!k.perAnggota) out.rincian = 'Rincian per pinjaman tidak tersedia: data per anggota tidak diizinkan di KOPKU Desktop (Pengaturan › Asisten AI).';
      else
        out.rincian = (r.rincian || []).map((x) => ({
          nomorPinjaman: x.nomorPinjaman,
          nomorAnggota: x.nomorAnggota,
          namaAnggota: x.namaAnggota,
          kolektibilitas: x.kolektibilitas,
          saldoPiutang: x.saldoPiutang,
          saldoPokok: x.saldoPokok,
          saldoJasa: x.saldoJasa,
          hariTunggakan: x.hariTunggakan,
          jatuhTempoTertunggak: x.tanggalJatuhTempoTertunggak,
          nilaiAgunan: x.nilaiAgunan,
          persentaseCadangan: x.persentaseCadangan,
          nilaiCadangan: x.nilaiCadangan,
          dasarPenggolongan: x.dasarPenggolongan,
        }));
    }
    return out;
  },

  async riwayat_shu(_a, k) {
    return { riwayat: await k.panggil('shu.riwayat', {}) };
  },

  async saldo_kas_bank(_a, k) {
    const r = await k.panggil('kas.rekening', {});
    const aktif = (r || []).filter((x) => x.aktif !== false).map((x) => ({ jenis: x.jenis, nama: x.nama, saldo: x.saldo }));
    return { perTanggal: k.hariIni, rekening: aktif, total: jumlah(aktif, 'saldo') };
  },

  async daftar_tunggakan(a, k) {
    const min = Math.max(0, Number(a.minimal_hari) || 0);
    const r = (await k.panggil('laporan.tunggakan', {})).filter((x) => (Number(x.hariTerlambat) || 0) >= min).sort((x, y) => (y.hariTerlambat || 0) - (x.hariTerlambat || 0));
    const b = potong(r, bulat(a.batas, 50, 500));
    return {
      perTanggal: k.hariIni,
      jumlahAngsuranMenunggak: r.length,
      jumlahPinjaman: new Set(r.map((x) => x.pinjamanId)).size,
      totalSisaTagihan: jumlah(r, 'sisaTagihan'),
      tunggakan: b.baris.map((x) => ({ nomorPinjaman: x.nomorPinjaman, namaAnggota: x.namaAnggota, angsuranKe: x.nomorAngsuran, jatuhTempo: x.tanggalJatuhTempo, hariTerlambat: x.hariTerlambat, sisaTagihan: x.sisaTagihan })),
      terpotong: b.terpotong,
    };
  },

  async cari_anggota(a, k) {
    const n = bulat(a.batas, 50, 500);
    const r = await k.panggil('anggota.daftar', { search: teks(a.cari), status: teks(a.status, 20), limit: n + 1, offset: 0 });
    return {
      anggota: r.slice(0, n).map((x) => ({ id: x.id, nomorAnggota: x.nomorAnggota, nama: x.namaLengkap, status: x.status, tanggalBergabung: x.tanggalBergabung, pekerjaan: x.pekerjaan || undefined, jenisKelamin: x.jenisKelamin || undefined })),
      adaLagi: r.length > n,
    };
  },

  async detail_anggota(a, k) {
    const cari = teks(a.anggota);
    if (!cari) throw new GalatAlat('Isi nomor anggota, ID, atau nama.');
    const kandidat = await k.panggil('anggota.daftar', { search: cari, limit: 20, offset: 0 });
    const kecil = cari.toLowerCase();
    let pilih = kandidat.filter((x) => x.id === cari || String(x.nomorAnggota).toLowerCase() === kecil || String(x.namaLengkap).toLowerCase() === kecil);
    if (!pilih.length && kandidat.length === 1) pilih = kandidat;
    if (!pilih.length) {
      if (!kandidat.length) throw new GalatAlat(`Anggota "${cari}" tidak ditemukan.`);
      return { pesan: 'Lebih dari satu anggota cocok — ulangi dengan nomor anggota.', kandidat: kandidat.map((x) => ({ nomorAnggota: x.nomorAnggota, nama: x.namaLengkap, status: x.status })) };
    }
    if (pilih.length > 1) return { pesan: 'Lebih dari satu anggota bernama sama — ulangi dengan nomor anggota.', kandidat: pilih.map((x) => ({ nomorAnggota: x.nomorAnggota, nama: x.namaLengkap, status: x.status })) };
    const d = await k.panggil('anggota.detail', { id: pilih[0].id });
    const ag = d.anggota;
    return {
      anggota: { id: ag.id, nomorAnggota: ag.nomorAnggota, nama: ag.namaLengkap, status: ag.status, tanggalBergabung: ag.tanggalBergabung, pekerjaan: ag.pekerjaan || undefined, jenisKelamin: ag.jenisKelamin || undefined },
      saldoSimpanan: (await k.boleh('simpanan')) ? d.saldoSimpanan : 'tidak ditampilkan (tidak ada izin Simpanan)',
      pinjaman: (await k.boleh('pinjaman'))
        ? (d.pinjaman || []).map((p) => ({ nomorPinjaman: p.nomorPinjaman, pokok: p.jumlahPinjaman, sisaPiutang: p.sisaPiutang, tenor: `${p.tenor} ${String(p.satuanTenor || '').toLowerCase()}`, status: p.status, jatuhTempo: p.tanggalJatuhTempo }))
        : 'tidak ditampilkan (tidak ada izin Pinjaman)',
    };
  },

  async saldo_simpanan(a, k) {
    const r = await k.panggil('simpanan.saldoSemua', { search: teks(a.cari) });
    const b = potong(r, bulat(a.batas, 100, 1000));
    return {
      total: { pokok: jumlah(r, 'pokok'), wajib: jumlah(r, 'wajib'), sukarela: jumlah(r, 'sukarela'), total: jumlah(r, 'total') },
      jumlahAnggota: r.length,
      perAnggota: b.baris.map((x) => ({ nomorAnggota: x.nomorAnggota, nama: x.namaAnggota, pokok: x.pokok, wajib: x.wajib, sukarela: x.sukarela, total: x.total })),
      terpotong: b.terpotong,
    };
  },

  async daftar_pinjaman(a, k) {
    const n = bulat(a.batas, 50, 500);
    const kategori = teks(a.kategori, 20);
    const args = { search: teks(a.cari), limit: n + 1, offset: 0 };
    if (kategori === 'LUNAS') args.status = 'LUNAS';
    else if (kategori) args.statusKategori = kategori;
    const r = await k.panggil('pinjaman.daftar', args);
    return {
      pinjaman: r.slice(0, n).map((p) => ({ id: p.id, nomorPinjaman: p.nomorPinjaman, namaAnggota: p.namaAnggota, pokok: p.jumlahPinjaman, sisaPiutang: p.sisaPiutang, tenor: `${p.tenor} ${String(p.satuanTenor || '').toLowerCase()}`, status: p.status, jatuhTempo: p.tanggalJatuhTempo })),
      adaLagi: r.length > n,
    };
  },

  async detail_pinjaman(a, k) {
    const cari = teks(a.pinjaman);
    if (!cari) throw new GalatAlat('Isi nomor pinjaman atau ID.');
    let id = null;
    const kandidat = await k.panggil('pinjaman.daftar', { search: cari, limit: 20, offset: 0 });
    const tepat = kandidat.find((p) => p.id === cari || String(p.nomorPinjaman).toLowerCase() === cari.toLowerCase());
    if (tepat) id = tepat.id;
    else if (kandidat.length === 1) id = kandidat[0].id;
    else if (!kandidat.length) throw new GalatAlat(`Pinjaman "${cari}" tidak ditemukan.`);
    else return { pesan: 'Lebih dari satu pinjaman cocok — ulangi dengan nomor pinjaman.', kandidat: kandidat.map((p) => ({ nomorPinjaman: p.nomorPinjaman, namaAnggota: p.namaAnggota, status: p.status })) };
    const d = await k.panggil('pinjaman.detail', { id });
    const p = d.pinjaman;
    const jadwal = (d.jadwal || []).map((j) => ({
      angsuranKe: j.nomorAngsuran,
      jatuhTempo: j.tanggalJatuhTempo,
      pokok: j.pokok,
      jasa: j.jasa,
      denda: j.denda,
      total: j.total,
      pokokTerbayar: j.pokokTerbayar,
      jasaTerbayar: j.jasaTerbayar,
      dendaTerbayar: j.dendaTerbayar,
      status: j.status,
    }));
    const belum = jadwal.filter((j) => !/LUNAS|DIGANTI|BATAL/i.test(j.status));
    return {
      pinjaman: {
        id: p.id,
        nomorPinjaman: p.nomorPinjaman,
        nomorAnggota: p.nomorAnggota,
        namaAnggota: p.namaAnggota,
        tanggalAkad: p.tanggal,
        pokok: p.jumlahPinjaman,
        tenor: `${p.tenor} ${String(p.satuanTenor || '').toLowerCase()}`,
        metodeJasa: p.metodeJasa,
        persentaseJasaPerPeriode: p.persentaseJasa,
        biayaAdmin: p.biayaAdminTipe === 'TIDAK_ADA' ? 'tidak ada' : `${p.biayaAdminTipe} ${p.biayaAdminNilai}`,
        denda: p.dendaAktif ? `${p.dendaTipe} ${p.dendaNilai}` : 'tidak aktif',
        jatuhTempoAkhir: p.tanggalJatuhTempo,
        status: p.status,
        tujuan: p.tujuanPinjaman || undefined,
        jumlahAgunan: Array.isArray(p.agunan) ? p.agunan.length : 0,
      },
      ringkasanJadwal: {
        jumlahAngsuran: jadwal.length,
        belumLunas: belum.length,
        sisaTagihanTerjadwal: belum.reduce((s, j) => s + (j.total - j.pokokTerbayar - j.jasaTerbayar), 0),
      },
      jadwal,
    };
  },

  async riwayat_transaksi(a, k) {
    const n = bulat(a.batas, 30, 200);
    const mulai = tgl(a.mulai, 'mulai');
    const selesai = tgl(a.selesai, 'selesai');
    const r = await k.panggil('history.daftar', { search: teks(a.cari), tanggalMulai: mulai, tanggalSelesai: selesai, limit: n + 1, offset: 0 });
    return {
      transaksi: r.slice(0, n).map((x) => ({ tanggal: x.tanggal, nomor: x.nomorTransaksi, jenis: x.jenisLabel, deskripsi: x.deskripsi, nominal: x.nominal, status: x.status, dicatatOleh: x.createdByNama })),
      adaLagi: r.length > n,
    };
  },
};

const PETA = new Map(ALAT.map((a) => [a.name, a]));

/** Alat yang boleh dipakai pada pengaturan & izin saat ini. */
async function alatTersedia({ perAnggota, boleh }) {
  const out = [];
  for (const a of ALAT) {
    if (a.perAnggota && !perAnggota) continue;
    if (a.resource && !(await boleh(a.resource))) continue;
    out.push(a);
  }
  return out;
}

const BATAS_TEKS = 200000;

/**
 * Jalankan satu alat. Selalu mengembalikan hasil MCP `{content, isError}`.
 * @param {string} nama
 * @param {object} args
 * @param {KonteksAlat} k
 */
async function jalankanAlat(nama, args, k) {
  const def = PETA.get(nama);
  if (!def || !JALANKAN[nama]) return { content: [{ type: 'text', text: `Alat tidak dikenal: ${nama}` }], isError: true };
  if (def.perAnggota && !k.perAnggota) return { content: [{ type: 'text', text: 'Alat ini menampilkan data per anggota, yang TIDAK diizinkan di KOPKU Desktop (Pengaturan › Asisten AI › "Izinkan data per anggota"). Gunakan alat ringkasan/laporan, atau minta admin KOPKU menyalakan sakelar itu.' }], isError: true };
  if (def.resource && !(await k.boleh(def.resource))) return { content: [{ type: 'text', text: `Pengguna KOPKU "${k.info.pengguna}" tidak punya izin melihat ${def.resource}. Ubah di Pengaturan › Permission Matrix, atau nyalakan Asisten AI dengan pengguna lain.` }], isError: true };
  const panggilAman = (op, a) => {
    if (!OPERASI_BACA.has(op)) throw new Error(`Operasi ${op} tidak diizinkan untuk Asisten AI.`);
    return k.panggil(op, a);
  };
  try {
    const data = await JALANKAN[nama](args && typeof args === 'object' ? args : {}, Object.assign({}, k, { panggil: panggilAman }));
    // 1.0.28 — penyaring terpusat: data pribadi + ID teknis, jalur, URI, jejak stack (privasi.js).
    let t = JSON.stringify(saring(bersihkan(data)));
    if (t.length > BATAS_TEKS) t = t.slice(0, BATAS_TEKS) + '… [dipotong: hasil terlalu besar, persempit filter atau kecilkan batas]';
    return { content: [{ type: 'text', text: t }], isError: false };
  } catch (e) {
    const pesan = e && (e.galatAlat || e.kode) ? samarkanTeks(String(e.message)) : 'Terjadi kesalahan saat membaca data KOPKU.';
    return { content: [{ type: 'text', text: pesan }], isError: true, _galat: e };
  }
}

module.exports = { jalankanAlat, alatTersedia, bersihkan, hariIniLokal, OPERASI_BACA, KUNCI_PRIBADI, GalatAlat };
