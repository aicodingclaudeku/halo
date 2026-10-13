'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · ALAT UBAH DATA (proses utama, 1.0.27).
 *
 * Pengaman berlapis (semua gagal tertutup):
 *   1. Sakelar "Izinkan Claude mengubah data" (bawaan MATI, hanya Admin) — tanpa itu alat tidak terdaftar.
 *   2. Izin Permission Matrix pengguna yang menyalakan untuk resource/aksi alat (+ service memeriksa ulang).
 *   3. DUA LANGKAH: panggilan pertama hanya PRATINJAU (tidak menulis) + kode konfirmasi sekali pakai
 *      (10 menit). Eksekusi hanya dengan kode itu, argumen yang sama, dan pratinjau yang masih sama —
 *      bila data berubah sejak pratinjau, pratinjau baru dikirim dan kode lama tidak berlaku.
 *   4. Backup otomatis (terenkripsi, sama dengan menu Backup) sebelum perubahan pertama tiap 30 menit;
 *      backup gagal → perubahan dibatalkan.
 *   5. Hanya service KOPKU (operasi Server LAN yang sudah teruji + adapter tulis): aturan bisnis, jurnal,
 *      periode tutup buku, SHU, saldo tetap berlaku. Koreksi = jurnal pembalik, tidak ada penghapusan.
 *   6. Setiap perubahan dicatat di log pemakaian (alat, ringkasan, hasil) — juga di audit KOPKU oleh service.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const V = require('../server/validasi');
const { ALAT_TULIS } = require('./katalog');
const { saring, samarkanTeks } = require('./privasi');

class GalatTulis extends Error {
  constructor(pesan) {
    super(pesan);
    this.galatAlat = true;
  }
}
const tolak = (p) => {
  throw new GalatTulis(p);
};
const rp = (n) => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const BERLAKU_MS = 10 * 60 * 1000;

function stabil(v) {
  if (Array.isArray(v)) return '[' + v.map(stabil).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stabil(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const sidikDari = (nama, args, ringkasan) => crypto.createHash('sha256').update(nama + '\n' + stabil(args) + '\n' + stabil(ringkasan)).digest('hex');

// ---------------------------------------------------------------- pencari
async function cariAnggota(k, ref) {
  const cari = String(ref || '').trim();
  if (!cari) tolak('Isi nomor anggota, ID, atau nama.');
  const daftar = await k.panggil('anggota.daftar', { search: cari, limit: 20, offset: 0 });
  const kecil = cari.toLowerCase();
  let pilih = daftar.filter((x) => x.id === cari || String(x.nomorAnggota).toLowerCase() === kecil);
  if (!pilih.length) pilih = daftar.filter((x) => String(x.namaLengkap).toLowerCase() === kecil);
  if (!pilih.length && daftar.length === 1) pilih = daftar;
  if (!pilih.length) tolak(daftar.length ? `Lebih dari satu anggota cocok dengan "${cari}": ${daftar.slice(0, 8).map((x) => `${x.nomorAnggota} ${x.namaLengkap}`).join('; ')}. Gunakan nomor anggota.` : `Anggota "${cari}" tidak ditemukan.`);
  if (pilih.length > 1) tolak(`Lebih dari satu anggota bernama "${cari}": ${pilih.map((x) => x.nomorAnggota).join(', ')}. Gunakan nomor anggota.`);
  return pilih[0];
}

async function cariPinjaman(k, ref) {
  const cari = String(ref || '').trim();
  if (!cari) tolak('Isi nomor pinjaman atau ID.');
  const daftar = await k.panggil('pinjaman.daftar', { search: cari, limit: 20, offset: 0 });
  let p = daftar.find((x) => x.id === cari || String(x.nomorPinjaman).toLowerCase() === cari.toLowerCase());
  if (!p && daftar.length === 1) p = daftar[0];
  if (!p) tolak(daftar.length ? `Lebih dari satu pinjaman cocok: ${daftar.slice(0, 8).map((x) => `${x.nomorPinjaman} (${x.namaAnggota}, ${x.status})`).join('; ')}.` : `Pinjaman "${cari}" tidak ditemukan.`);
  return k.panggil('pinjaman.detail', { id: p.id });
}

/** Rekening untuk sumber dana. jenis KAS/KAS_KECIL/BANK; BANK → bankAccountId dari nama/ID. */
async function rekening(k, jenis, refBank) {
  const j = jenis || 'KAS';
  if (j !== 'BANK') return { jenis: j, bankAccountId: undefined, label: j === 'KAS_KECIL' ? 'Kas Kecil' : 'Kas' };
  const daftar = (await k.panggil('rekening.daftar', {})).filter((r) => r.jenis === 'BANK');
  if (!daftar.length) tolak('Belum ada rekening bank aktif. Tambahkan di menu Data Bank, atau pakai KAS.');
  const ref = String(refBank || '').trim().toLowerCase();
  let r = ref ? daftar.find((x) => x.id === refBank || String(x.nama).toLowerCase() === ref) || null : null;
  if (!r && ref) {
    const mirip = daftar.filter((x) => String(x.nama).toLowerCase().includes(ref));
    if (mirip.length === 1) r = mirip[0];
  }
  if (!r && !ref && daftar.length === 1) r = daftar[0];
  if (!r) tolak(`Pilih rekening bank (rekening_bank): ${daftar.map((x) => x.nama).join('; ')}.`);
  return { jenis: 'BANK', bankAccountId: r.id, label: `Bank — ${r.nama}` };
}

function dataAnggotaDari(a) {
  const peta = { nama_lengkap: 'namaLengkap', nik: 'nik', jenis_kelamin: 'jenisKelamin', tempat_lahir: 'tempatLahir', tanggal_lahir: 'tanggalLahir', alamat: 'alamat', nomor_hp: 'nomorHp', pekerjaan: 'pekerjaan', catatan: 'catatan', tanggal_bergabung: 'tanggalBergabung' };
  const out = {};
  for (const [k, v] of Object.entries(a || {})) if (peta[k] && v !== undefined) out[peta[k]] = v;
  return out;
}
const PRIBADI = new Set(['nik', 'alamat', 'nomorHp', 'tempatLahir', 'tanggalLahir', 'catatan']);
const LABEL_KOLOM = { namaLengkap: 'Nama lengkap', nik: 'NIK', jenisKelamin: 'Jenis kelamin', tempatLahir: 'Tempat lahir', tanggalLahir: 'Tanggal lahir', alamat: 'Alamat', nomorHp: 'Nomor HP', pekerjaan: 'Pekerjaan', catatan: 'Catatan', tanggalBergabung: 'Tanggal bergabung' };

// ---------------------------------------------------------------- definisi
/** Setiap alat: siapkan(args, k) → { ringkasan, eksekusi?: () => Promise<any>, tidakSiap?: boolean } */
const SIAPKAN = {
  async opsi_transaksi(_a, k) {
    const [rek, opsi] = await Promise.all([k.panggil('rekening.daftar', {}), k.panggil('kas.opsi', {})]);
    return {
      langsung: {
        rekening: rek.map((r) => ({ jenis: r.jenis, nama: r.nama, id: r.id })),
        akunPendapatan: (opsi.pendapatan || []).map((x) => ({ kode: x.kode, nama: x.nama })),
        kategoriBeban: (opsi.beban || []).map((x) => ({ kategori: x.label, kunci: x.key })),
      },
    };
  },

  async anggota_tambah(a, k) {
    const data = V.dataAnggota(dataAnggotaDari(a), { buat: true });
    const sama = (await k.panggil('anggota.daftar', { search: data.namaLengkap, limit: 20, offset: 0 })).filter((x) => String(x.namaLengkap).toLowerCase() === data.namaLengkap.toLowerCase());
    return {
      ringkasan: {
        aksi: 'Tambah anggota baru (status AKTIF, nomor anggota otomatis)',
        nama: data.namaLengkap,
        tanggalBergabung: data.tanggalBergabung,
        jenisKelamin: data.jenisKelamin || undefined,
        pekerjaan: data.pekerjaan || undefined,
        dataPribadiDiisi: Object.keys(data).filter((x) => PRIBADI.has(x) && data[x]).map((x) => LABEL_KOLOM[x]),
        peringatan: sama.length ? `Sudah ada anggota bernama sama: ${sama.map((x) => `${x.nomorAnggota} (${x.status})`).join(', ')}. Pastikan bukan data ganda.` : undefined,
      },
      eksekusi: async () => {
        const h = await k.panggil('anggota.buat', { data });
        return { anggotaId: h.id, nomorAnggota: h.nomorAnggota };
      },
    };
  },

  async anggota_ubah(a, k) {
    const ag = await cariAnggota(k, a.anggota);
    const d = await k.panggil('anggota.detail', { id: ag.id });
    const lama = d.anggota;
    const diminta = dataAnggotaDari(a.perubahan);
    if (!Object.keys(diminta).length) tolak('Tidak ada kolom yang diubah.');
    // Validator LAN mewajibkan nama; kolom lain yang tidak diminta diambil dari data tersimpan oleh adapter.
    const data = V.dataAnggota(Object.assign({ namaLengkap: lama.namaLengkap }, diminta), { buat: false });
    const perubahan = Object.keys(diminta).map((kol) => (PRIBADI.has(kol) ? { kolom: LABEL_KOLOM[kol], keterangan: 'diubah (nilai tidak ditampilkan)' } : { kolom: LABEL_KOLOM[kol], sebelum: lama[kol] == null ? '' : lama[kol], sesudah: data[kol] == null ? '' : data[kol] }));
    return {
      ringkasan: { aksi: 'Ubah data anggota', anggota: `${lama.nomorAnggota} — ${lama.namaLengkap}`, perubahan },
      eksekusi: async () => {
        await k.panggil('anggota.ubah', { id: ag.id, versi: d.versi, data });
        return { anggota: lama.nomorAnggota };
      },
    };
  },

  async simpanan_setor(a, k) {
    const ag = await cariAnggota(k, a.anggota);
    const rek = await rekening(k, V.pilihan(a.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), a.rekening_bank);
    const args = {
      anggotaId: ag.id,
      jenis: V.pilihan(a.jenis, 'Jenis simpanan', V.JENIS_SIMPANAN),
      tanggal: V.tanggal(a.tanggal, 'Tanggal'),
      nominal: V.rupiah(a.nominal, 'Nominal'),
      sumberDana: rek.jenis,
      bankAccountId: rek.bankAccountId,
      periode: V.teks(a.periode, 'Periode', { maks: 7, pola: /^\d{4}-\d{2}$/ }) || undefined,
      keterangan: V.teks(a.keterangan, 'Keterangan', { maks: 200 }) || undefined,
    };
    const d = await k.panggil('anggota.detail', { id: ag.id });
    const kunci = { POKOK: 'pokok', WAJIB: 'wajib', SUKARELA: 'sukarela' }[args.jenis];
    const sebelum = Number((d.saldoSimpanan || {})[kunci]) || 0;
    return {
      ringkasan: { aksi: `Setor simpanan ${args.jenis.toLowerCase()}`, anggota: `${ag.nomorAnggota} — ${ag.namaLengkap}`, nominal: rp(args.nominal), tanggal: args.tanggal, periode: args.periode, ke: rek.label, saldoSebelum: rp(sebelum), saldoSesudah: rp(sebelum + args.nominal), keterangan: args.keterangan },
      eksekusi: async () => k.panggil('simpanan.setor', args),
    };
  },

  async simpanan_tarik(a, k) {
    const ag = await cariAnggota(k, a.anggota);
    const rek = await rekening(k, V.pilihan(a.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), a.rekening_bank);
    const args = { anggotaId: ag.id, tanggal: V.tanggal(a.tanggal, 'Tanggal'), nominal: V.rupiah(a.nominal, 'Nominal'), sumberDana: rek.jenis, bankAccountId: rek.bankAccountId, keterangan: V.teks(a.keterangan, 'Keterangan', { maks: 200 }) || undefined };
    const d = await k.panggil('anggota.detail', { id: ag.id });
    const saldo = Number((d.saldoSimpanan || {}).sukarela) || 0;
    if (args.nominal > saldo) tolak(`Saldo simpanan sukarela ${ag.nomorAnggota} hanya ${rp(saldo)}.`);
    return {
      ringkasan: { aksi: 'Tarik simpanan sukarela', anggota: `${ag.nomorAnggota} — ${ag.namaLengkap}`, nominal: rp(args.nominal), tanggal: args.tanggal, dari: rek.label, saldoSebelum: rp(saldo), saldoSesudah: rp(saldo - args.nominal) },
      eksekusi: async () => k.panggil('simpanan.tarik', args),
    };
  },

  async pinjaman_ajukan(a, k) {
    const ag = await cariAnggota(k, a.anggota);
    const data = V.dataPinjaman({
      anggotaId: ag.id,
      tanggal: a.tanggal,
      jumlahPinjaman: a.jumlah,
      tenor: a.tenor,
      satuanTenor: a.satuan_tenor || 'BULAN',
      metodeJasa: a.metode_jasa,
      persentaseJasa: a.persentase_jasa,
      biayaAdminTipe: a.biaya_admin_tipe || 'TIDAK_ADA',
      biayaAdminNilai: a.biaya_admin_nilai,
      dendaAktif: Number(a.denda_per_hari) > 0,
      dendaNilai: a.denda_per_hari,
      tujuanPinjaman: a.tujuan,
      tujuanDetail: a.tujuan_detail,
      keterangan: a.keterangan,
    });
    let simulasi = null;
    try {
      const baris = await k.panggil('pinjaman.simulasi', { jumlahPinjaman: data.jumlahPinjaman, tenor: data.tenor, persentaseJasa: data.persentaseJasa, metodeJasa: data.metodeJasa });
      if (Array.isArray(baris) && baris.length) simulasi = { angsuranPertama: rp(baris[0].total), totalJasa: rp(baris.reduce((s, x) => s + (Number(x.jasa) || 0), 0)), totalDibayar: rp(baris.reduce((s, x) => s + (Number(x.total) || 0), 0)) };
    } catch {
      simulasi = null;
    }
    return {
      ringkasan: { aksi: 'Ajukan pinjaman (belum dicairkan)', anggota: `${ag.nomorAnggota} — ${ag.namaLengkap}`, jumlah: rp(data.jumlahPinjaman), tenor: `${data.tenor} ${data.satuanTenor.toLowerCase()}`, jasa: `${data.persentaseJasa}% per periode (${data.metodeJasa})`, biayaAdmin: data.biayaAdminTipe === 'TIDAK_ADA' ? 'tidak ada' : `${data.biayaAdminTipe} ${data.biayaAdminNilai}`, denda: data.dendaAktif ? `${rp(data.dendaNilai)}/hari` : 'tidak ada', tanggal: data.tanggal, simulasi },
      eksekusi: async () => {
        const h = await k.panggil('pinjaman.ajukan', { data });
        const det = await k.panggil('pinjaman.detail', { id: h.id }).catch(() => null);
        return { nomorPinjaman: (det && det.pinjaman && det.pinjaman.nomorPinjaman) || h.nomorPinjaman || null, status: (det && det.pinjaman && det.pinjaman.status) || 'DIAJUKAN' };
      },
    };
  },

  async pinjaman_cairkan(a, k) {
    const d = await cariPinjaman(k, a.pinjaman);
    const p = d.pinjaman;
    if (!['DIAJUKAN', 'DISETUJUI'].includes(p.status)) tolak(`Pinjaman ${p.nomorPinjaman} berstatus ${p.status}; hanya pengajuan yang belum cair yang dapat dicairkan.`);
    const rek = await rekening(k, V.pilihan(a.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), a.rekening_bank);
    const args = { pinjamanId: p.id, tanggalPencairan: V.tanggal(a.tanggal, 'Tanggal pencairan'), sumberDana: rek.jenis, bankAccountId: rek.bankAccountId, versi: d.versi || undefined };
    return {
      ringkasan: { aksi: 'Cairkan pinjaman', pinjaman: p.nomorPinjaman, anggota: `${p.nomorAnggota} — ${p.namaAnggota}`, jumlah: rp(p.jumlahPinjaman), tenor: `${p.tenor} ${String(p.satuanTenor).toLowerCase()}`, tanggalPencairan: args.tanggalPencairan, dari: rek.label },
      eksekusi: async () => k.panggil('pinjaman.cairkan', args),
    };
  },

  async pinjaman_batalkan(a, k) {
    const d = await cariPinjaman(k, a.pinjaman);
    const p = d.pinjaman;
    if (!['DIAJUKAN', 'DISETUJUI'].includes(p.status)) tolak(`Pinjaman ${p.nomorPinjaman} berstatus ${p.status}. Pinjaman yang sudah cair dikoreksi dengan koreksi_transaksi (jurnal pencairan).`);
    const alasan = V.teks(a.alasan, 'Alasan pembatalan', { wajib: true, maks: 200 });
    return {
      ringkasan: { aksi: 'Batalkan pengajuan pinjaman', pinjaman: p.nomorPinjaman, anggota: `${p.nomorAnggota} — ${p.namaAnggota}`, jumlah: rp(p.jumlahPinjaman), alasan },
      eksekusi: async () => k.panggil('pinjaman.batalkan', { pinjamanId: p.id, alasan }),
    };
  },

  async angsuran_bayar(a, k) {
    const d = await cariPinjaman(k, a.pinjaman);
    const p = d.pinjaman;
    if (p.status !== 'AKTIF') tolak(`Pinjaman ${p.nomorPinjaman} berstatus ${p.status}; angsuran hanya untuk pinjaman AKTIF.`);
    const bisa = (d.jadwal || []).filter((j) => j.bisaDibayar);
    const j = a.angsuran_ke ? bisa.find((x) => x.nomorAngsuran === Number(a.angsuran_ke)) : bisa[0];
    if (!j) tolak(a.angsuran_ke ? `Angsuran ke-${a.angsuran_ke} tidak tertagih/sudah lunas.` : 'Tidak ada angsuran yang tertagih.');
    const rek = await rekening(k, V.pilihan(a.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), a.rekening_bank);
    const args = { pinjamanId: p.id, jadwalId: j.id, tanggal: V.tanggal(a.tanggal, 'Tanggal bayar'), nominal: V.rupiah(a.nominal, 'Nominal'), sumberDana: rek.jenis, bankAccountId: rek.bankAccountId, versiJadwal: j.versi };
    const sisa = Number(j.total) - Number(j.pokokTerbayar) - Number(j.jasaTerbayar);
    return {
      ringkasan: { aksi: 'Bayar angsuran', pinjaman: p.nomorPinjaman, anggota: `${p.nomorAnggota} — ${p.namaAnggota}`, angsuranKe: j.nomorAngsuran, jatuhTempo: j.tanggalJatuhTempo, sisaTagihanAngsuran: rp(sisa), dendaTerjadwal: rp(j.denda), dibayar: rp(args.nominal), tanggal: args.tanggal, ke: rek.label, catatan: 'Alokasi denda/jasa/pokok dihitung KOPKU saat disimpan.' },
      eksekusi: async () => k.panggil('angsuran.bayar', args),
    };
  },

  async pinjaman_lunasi(a, k) {
    const d = await cariPinjaman(k, a.pinjaman);
    const p = d.pinjaman;
    if (p.status !== 'AKTIF') tolak(`Pinjaman ${p.nomorPinjaman} berstatus ${p.status}.`);
    const tanggal = V.tanggal(a.tanggal, 'Tanggal pelunasan');
    const metode = a.metode_jasa ? V.pilihan(a.metode_jasa, 'Metode jasa pelunasan', V.METODE_PELUNASAN) : undefined;
    const rek = await rekening(k, V.pilihan(a.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), a.rekening_bank);
    const h = await k.panggil('pelunasan.hitung', { pinjamanId: p.id, tanggal, metodeJasaPelunasan: metode });
    const rinci = {};
    for (const [kk, v] of Object.entries(h || {})) if (typeof v === 'number') rinci[kk] = rp(v);
    return {
      ringkasan: { aksi: 'Pelunasan pinjaman', pinjaman: p.nomorPinjaman, anggota: `${p.nomorAnggota} — ${p.namaAnggota}`, tanggal, metode: metode || 'bawaan kebijakan', totalPelunasan: rp(h.totalPelunasan), rincian: rinci, ke: rek.label },
      eksekusi: async () => k.panggil('pelunasan.proses', { pinjamanId: p.id, tanggal, metodeJasaPelunasan: metode, sumberDana: rek.jenis, bankAccountId: rek.bankAccountId, totalDilihat: h.totalPelunasan }),
    };
  },

  async kas_masuk(a, k) {
    const opsi = await k.panggil('kas.opsi', {});
    const ref = String(a.akun_pendapatan || '').trim().toLowerCase();
    const cocok = (opsi.pendapatan || []).filter((x) => String(x.kode).toLowerCase() === ref || String(x.nama).toLowerCase() === ref);
    const akun = cocok[0] || ((opsi.pendapatan || []).filter((x) => String(x.nama).toLowerCase().includes(ref)).length === 1 ? (opsi.pendapatan || []).find((x) => String(x.nama).toLowerCase().includes(ref)) : null);
    if (!akun) tolak(`Akun pendapatan "${a.akun_pendapatan}" tidak dikenal. Pilihan: ${(opsi.pendapatan || []).map((x) => `${x.kode} ${x.nama}`).join('; ')}.`);
    const rek = await rekening(k, V.pilihan(a.rekening || 'KAS', 'Rekening', V.JENIS_REKENING), a.rekening_bank);
    const args = { jenis: rek.jenis, bankAccountId: rek.bankAccountId, accountId: akun.accountId, tanggal: V.tanggal(a.tanggal, 'Tanggal'), nominal: V.rupiah(a.nominal, 'Nominal'), keterangan: V.teks(a.keterangan, 'Keterangan', { maks: 200 }) || undefined };
    return {
      ringkasan: { aksi: 'Kas/bank masuk — pendapatan lain', akun: `${akun.kode} ${akun.nama}`, nominal: rp(args.nominal), tanggal: args.tanggal, ke: rek.label, keterangan: args.keterangan },
      eksekusi: async () => k.panggil('kas.masuk', args),
    };
  },

  async kas_keluar(a, k) {
    const opsi = await k.panggil('kas.opsi', {});
    const ref = String(a.kategori_beban || '').trim().toLowerCase();
    const beban = opsi.beban || [];
    let o = beban.find((x) => x.key === a.kategori_beban || String(x.label).toLowerCase() === ref);
    if (!o) {
      const mirip = beban.filter((x) => String(x.label).toLowerCase().includes(ref));
      if (mirip.length === 1) o = mirip[0];
    }
    if (!o) tolak(`Kategori beban "${a.kategori_beban}" tidak dikenal. Pilihan: ${beban.map((x) => x.label).join('; ')}.`);
    const rek = await rekening(k, V.pilihan(a.rekening || 'KAS', 'Rekening', V.JENIS_REKENING), a.rekening_bank);
    const args = { jenis: rek.jenis, bankAccountId: rek.bankAccountId, kategoriKey: o.key, tanggal: V.tanggal(a.tanggal, 'Tanggal'), nominal: V.rupiah(a.nominal, 'Nominal'), keterangan: V.teks(a.keterangan, 'Keterangan', { maks: 200 }) || undefined };
    return {
      ringkasan: { aksi: 'Kas/bank keluar — beban', kategori: o.label, nominal: rp(args.nominal), tanggal: args.tanggal, dari: rek.label, keterangan: args.keterangan },
      eksekusi: async () => k.panggil('kas.keluar', args),
    };
  },

  async kas_transfer(a, k) {
    const dari = await rekening(k, V.pilihan(a.dari, 'Rekening sumber', V.JENIS_REKENING), a.dari_bank);
    const ke = await rekening(k, V.pilihan(a.ke, 'Rekening tujuan', V.JENIS_REKENING), a.ke_bank);
    if (dari.jenis === ke.jenis && dari.bankAccountId === ke.bankAccountId) tolak('Rekening sumber dan tujuan sama.');
    const args = { sumberJenis: dari.jenis, sumberBankAccountId: dari.bankAccountId, tujuanJenis: ke.jenis, tujuanBankAccountId: ke.bankAccountId, tanggal: V.tanggal(a.tanggal, 'Tanggal'), nominal: V.rupiah(a.nominal, 'Nominal'), keterangan: V.teks(a.keterangan, 'Keterangan', { maks: 200 }) || undefined };
    return {
      ringkasan: { aksi: 'Transfer antar rekening', dari: dari.label, ke: ke.label, nominal: rp(args.nominal), tanggal: args.tanggal, keterangan: args.keterangan },
      eksekusi: async () => k.panggil('kas.transfer', args),
    };
  },

  async koreksi_transaksi(a, k) {
    const ref = String(a.transaksi || '').trim();
    if (!ref) tolak('Isi nomor transaksi atau ID jurnal.');
    let journalId = null;
    const cand = await k.panggil('history.daftar', { search: ref, limit: 30, offset: 0 });
    const tepat = cand.filter((x) => x.journalId === ref || String(x.nomorTransaksi).toLowerCase() === ref.toLowerCase());
    if (tepat.length === 1) journalId = tepat[0].journalId;
    else if (!tepat.length && cand.length === 1) journalId = cand[0].journalId;
    else if (/^[0-9a-f-]{36}$/i.test(ref)) journalId = ref;
    if (!journalId) tolak(cand.length ? `Lebih dari satu transaksi cocok dengan "${ref}": ${cand.slice(0, 10).map((x) => `${x.nomorTransaksi} ${x.tanggal} ${x.jenisLabel} ${rp(x.nominal)}`).join('; ')}. Sebutkan nomor transaksi yang tepat.` : `Transaksi "${ref}" tidak ditemukan.`);
    const pr = await k.tulis('koreksi.pratinjau', { journalId });
    if (!pr.boleh) tolak(`Transaksi ${pr.nomorReferensi || pr.nomorJurnal} tidak dapat dikoreksi: ${pr.alasanTolak.join(' ')}`);
    const alasan = String(a.alasan || '').trim();
    if (alasan.length < 5) tolak('Alasan koreksi wajib diisi (minimal 5 karakter).');
    let catatUlang = null;
    if (a.catat_ulang) {
      if (!pr.bisaCatatUlang) tolak('catat_ulang hanya untuk pencairan pinjaman, angsuran, dan setoran data awal. Setelah koreksi, catat transaksi yang benar dengan alat biasa (mis. simpanan_setor).');
      const u = a.catat_ulang;
      const rek = await rekening(k, V.pilihan(u.sumber_dana || 'KAS', 'Sumber dana', V.SUMBER_DANA), u.rekening_bank);
      catatUlang = { tanggal: V.tanggal(u.tanggal, 'Tanggal catat ulang'), sumberDana: rek.jenis, bankAccountId: rek.bankAccountId };
      if (pr.jenis === 'ANGSURAN_PINJAMAN') catatUlang.nominal = V.rupiah(u.nominal, 'Nominal angsuran');
      if (pr.jenis === 'SETORAN_SIMPANAN') Object.assign(catatUlang, { pokok: Number(u.pokok) || 0, wajib: Number(u.wajib) || 0, sukarela: Number(u.sukarela) || 0 });
    }
    const asal = cand.find((x) => x.journalId === journalId) || {};
    return {
      ringkasan: {
        aksi: catatUlang ? 'Koreksi: balik transaksi lalu catat ulang' : 'Koreksi: balik transaksi (jurnal pembalik)',
        transaksi: { nomor: asal.nomorTransaksi || pr.nomorReferensi || pr.nomorJurnal, jenis: asal.jenisLabel || pr.jenis, tanggal: pr.tanggal, nominal: asal.nominal != null ? rp(asal.nominal) : undefined, deskripsi: pr.deskripsi },
        caraKoreksi: 'Transaksi asal TETAP tercatat; dibuat jurnal pembalik bertanggal hari ini sehingga pengaruhnya ke saldo, buku besar, dan laporan dinetralkan. Jejak koreksi tersimpan.',
        catatUlang: catatUlang ? Object.assign({}, catatUlang, { bankAccountId: undefined, nominal: catatUlang.nominal != null ? rp(catatUlang.nominal) : undefined }) : undefined,
        catatan: pr.catatan && pr.catatan.length ? pr.catatan : undefined,
        alasan,
      },
      eksekusi: async () => k.tulis('koreksi.jalankan', { journalId, alasan, catatUlang }),
    };
  },

  async import_data_awal(a, k) {
    const berkas = String(a.berkas || '').trim().replace(/^"|"$/g, '');
    if (!path.isAbsolute(berkas)) tolak('Isi jalur LENGKAP berkas Excel, mis. C:\\Users\\Nama\\Downloads\\data.xlsx.');
    if (!/\.(xlsx|xls)$/i.test(berkas)) tolak('Berkas harus Excel (.xlsx).');
    let st;
    try {
      st = fs.statSync(berkas);
    } catch {
      tolak(`Berkas tidak ditemukan: ${berkas}`);
    }
    if (!st.isFile()) tolak('Jalur itu bukan berkas.');
    if (st.size > 20 * 1024 * 1024) tolak('Berkas terlalu besar (maks 20 MB).');
    const sifat = a.sifat === 'TRANSAKSI_BARU' ? 'TRANSAKSI_BARU' : 'SALDO_AWAL';
    const cutOff = sifat === 'SALDO_AWAL' ? V.tanggal(a.cut_off, 'Tanggal cut-off') : undefined;
    const uri = k.salinKeCache(berkas);
    const pr = await k.tulis('import.pratinjau', { uri, sifat, cutOff });
    const { kunci, ...isi } = pr;
    const ringkasan = Object.assign({ aksi: sifat === 'SALDO_AWAL' ? `Import Data Awal — SALDO LAMA, cut-off ${cutOff}` : 'Import Data Awal — TRANSAKSI BARU (kas/bank ikut bergerak)', berkas: path.basename(berkas), ukuran: `${Math.round(st.size / 1024)} KB` }, isi);
    if (!pr.siapDiimpor) return { tidakSiap: true, ringkasan: Object.assign(ringkasan, { petunjuk: 'Berkas BELUM dapat diimpor. Perbaiki galat/peringatan BLOKIR di atas pada berkas Excel, simpan, lalu panggil import_data_awal lagi.' }) };
    return {
      ringkasan,
      eksekusi: async () => k.tulis('import.jalankan', { kunci, namaBerkas: path.basename(berkas) }),
    };
  },

  async buat_backup(_a, k) {
    return { langsung: await k.tulis('backup.buat', {}) };
  },
};

const PETA = new Map(ALAT_TULIS.map((a) => [a.name, a]));

/**
 * Jalankan alat ubah data. `toko` = Map kode konfirmasi milik host.
 * @returns {Promise<{content:any[], isError:boolean, _ringkasLog?:string}>}
 */
async function jalankanAlatTulis(nama, args, k, toko, now = Date.now()) {
  const def = PETA.get(nama);
  // 1.0.28 — semua keluaran disaring (data pribadi, ID teknis, jalur berkas, pesan internal).
  const teks = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? samarkanTeks(obj) : JSON.stringify(saring(obj)) }], isError });
  if (!def) return teks(`Alat tidak dikenal: ${nama}`, true);
  if (!(await k.bolehAksi(def.resource, def.aksi))) return teks(`Pengguna KOPKU "${k.info.pengguna}" tidak punya izin ${def.aksi} pada ${def.resource} (Permission Matrix).`, true);
  const a = Object.assign({}, args && typeof args === 'object' ? args : {});
  const konfirmasi = typeof a.konfirmasi === 'string' ? a.konfirmasi.trim().toUpperCase() : '';
  delete a.konfirmasi;
  for (const [kk, v] of toko) if (v.kedaluwarsa < now) toko.delete(kk);
  try {
    const siap = await SIAPKAN[nama](a, k);
    if (siap.langsung !== undefined) {
      if (nama === 'buat_backup') k.catatBackup();
      return teks({ status: 'BERHASIL', hasil: siap.langsung });
    }
    if (siap.tidakSiap) return teks({ status: 'TIDAK_DAPAT_DIPROSES', pratinjau: siap.ringkasan });
    const sidik = sidikDari(nama, a, siap.ringkasan);
    const terbitkan = (status, petunjuk) => {
      const kode = 'K-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      toko.set(kode, { nama, sidik, kedaluwarsa: now + BERLAKU_MS });
      return teks({ status, belumDisimpan: true, pratinjau: siap.ringkasan, konfirmasi: kode, berlakuMenit: BERLAKU_MS / 60000, petunjuk });
    };
    if (!konfirmasi) return terbitkan('MENUNGGU_KONFIRMASI', 'BELUM ADA YANG DISIMPAN. Tunjukkan pratinjau ini kepada pengguna dan minta persetujuan eksplisit. Bila setuju, panggil alat yang sama dengan argumen yang sama ditambah "konfirmasi": "<kode>".');
    const t = toko.get(konfirmasi);
    if (!t || t.nama !== nama) return teks('Kode konfirmasi tidak dikenal, sudah dipakai, atau kedaluwarsa (10 menit). Panggil alat tanpa `konfirmasi` untuk pratinjau baru.', true);
    toko.delete(konfirmasi);
    if (t.sidik !== sidik) return terbitkan('PRATINJAU_BERUBAH', 'Argumen atau data KOPKU berubah sejak pratinjau sebelumnya — TIDAK ada yang disimpan. Tunjukkan pratinjau baru ini kepada pengguna; kirim kode baru hanya bila pengguna setuju.');
    await k.backupOtomatis();
    const hasil = await siap.eksekusi();
    return Object.assign(teks({ status: 'BERHASIL', disimpan: true, ringkasan: siap.ringkasan, hasil }), { _ringkasLog: `${siap.ringkasan.aksi}${siap.ringkasan.nominal ? ' ' + siap.ringkasan.nominal : ''}${siap.ringkasan.anggota ? ' · ' + String(siap.ringkasan.anggota).split(' — ')[0] : ''}${siap.ringkasan.pinjaman ? ' · ' + siap.ringkasan.pinjaman : ''}` });
  } catch (e) {
    const pesan = e && (e.galatAlat || e.kode || e.name === 'GalatValidasi') ? String(e.message) : 'Terjadi kesalahan saat memproses perubahan di KOPKU.';
    return Object.assign(teks(pesan, true), { _galat: e });
  }
}

module.exports = { jalankanAlatTulis, SIAPKAN, sidikDari, GalatTulis };
