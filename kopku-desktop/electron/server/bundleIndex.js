'use strict';
/**
 * KOPKU LAN SERVER — INDEKS MODUL BUNDLE RENDERER.
 *
 * Seluruh service KOPKU (anggota, pinjaman, angsuran, simpanan, izin, ...)
 * hidup di bundle renderer hasil `expo export` (Metro). Server LAN TIDAK
 * menyalin atau menulis ulang service tersebut; ia memanggil service yang
 * SAMA di jendela desktop yang sedang berjalan lewat registry modul Metro
 * (`globalThis.__r(id)`).
 *
 * Nomor modul Metro bisa berubah setiap kali renderer dibangun ulang, jadi
 * indeks ini dibangun ulang setiap start dengan memindai teks bundle:
 *   __d(function(g,r,i,a,m,e,d){ ... e.namaEkspor=... },ID,[dep...]);
 * Nama parameter ke-6 adalah objek `exports` modul itu.
 *
 * Indeks hanya membaca teks; tidak ada kode bundle yang dieksekusi di sini.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Cari berkas bundle entry-*.js di renderer/_expo/static/js/web. */
function cariBerkasBundle(rendererDir) {
  const dir = path.join(rendererDir, '_expo', 'static', 'js', 'web');
  const daftar = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^entry-.*\.js$/.test(f)) : [];
  if (daftar.length !== 1) {
    throw new Error(`Bundle renderer tidak ditemukan atau ganda di ${dir} (${daftar.length} berkas).`);
  }
  return path.join(dir, daftar[0]);
}

/**
 * @param {string} teks isi bundle
 * @returns {Map<string, number[]>} namaEkspor -> daftar id modul yang mengekspornya
 */
function indeksEkspor(teks) {
  const peta = new Map();
  const reAwal = /__d\(function\(([^)]*)\)\{/g;
  const posisi = [];
  let m;
  while ((m = reAwal.exec(teks))) posisi.push({ at: m.index, params: m[1].split(',') });
  for (let k = 0; k < posisi.length; k++) {
    const { at, params } = posisi[k];
    const akhir = k + 1 < posisi.length ? posisi[k + 1].at : teks.length;
    const badan = teks.slice(at, akhir);
    const idM = /\},(\d+),\[[0-9,]*\]\);?\s*$/.exec(badan.trimEnd().replace(/__r\(\d+\);?\s*/g, '').trimEnd());
    if (!idM) continue;
    const id = Number(idM[1]);
    const ex = (params[5] || '').trim();
    if (!ex || !/^[A-Za-z_$][\w$]*$/.test(ex)) continue;
    const esc = ex.replace(/\$/g, '\\$');
    const nama = new Set();
    for (const r of [new RegExp(`(?:^|[^\\w$.])${esc}\\.([A-Za-z_$][\\w$]*)=(?!=)`, 'g'), new RegExp(`defineProperty\\(${esc},"([A-Za-z_$][\\w$]*)"`, 'g')]) {
      let x;
      while ((x = r.exec(badan))) nama.add(x[1]);
    }
    nama.delete('__esModule');
    for (const n of nama) {
      if (!peta.has(n)) peta.set(n, []);
      peta.get(n).push(id);
    }
  }
  return peta;
}

/**
 * Kebutuhan service: setiap kunci dipetakan ke satu modul yang mengekspor
 * SEMUA nama yang diminta (mencegah salah pilih modul bila sebuah nama
 * kebetulan dipakai lebih dari satu modul).
 */
const KEBUTUHAN = {
  db: ['getDb', 'withTransaction', 'runMigrations'],
  sqliteShim: ['openDatabaseAsync', 'SQLiteDatabase', 'deleteDatabaseAsync'],
  izin: ['hasPermission', 'requirePermission', 'getPermissionMatrix'],
  izinKonstanta: ['ROLES', 'RESOURCES', 'DEFAULT_ROLE_PERMISSIONS'],
  pinHash: ['verifikasiPinAsync', 'VERSI_HASH_PIN_SEKARANG'],
  lisensi: ['hasValidLocalLicense', 'getLicenseStatus'],
  koperasi: ['getActiveKoperasi', 'isSetupComplete'],
  anggota: ['listAnggota', 'getAnggotaById', 'createAnggota', 'updateAnggota'],
  pinjaman: ['listPinjaman', 'getPinjamanDetail', 'getJadwalAngsuran', 'bayarAngsuran', 'hitungTotalPelunasan', 'lunasiPinjaman', 'listTunggakan', 'ajukanPinjaman', 'cairkanPinjaman', 'batalkanPinjaman'],
  statusJadwal: ['sqlJadwalCurrent', 'sqlJadwalMasihTertagih', 'CURRENT_SCHEDULE_STATUSES'],
  simpanan: ['setorSimpanan', 'getRingkasanSaldoSimpananAnggota', 'tarikSimpananSukarela', 'listSimpananHistori', 'listSaldoSimpananSemuaAnggota', 'listAnggotaSaldoSukarelaTersedia', 'getSimpananDetailById'],
  kasBank: ['listRekening', 'catatPengeluaran', 'transferAntarRekening', 'listRiwayatTransaksi'],
  laporan: ['getPosisiKeuangan', 'getLHU', 'getLabaRugi', 'getArusKas', 'getPerubahanEkuitas', 'getTrialBalance', 'getLedger'],
  userAdmin: ['listUsers', 'createUser'],
  // ---- menu LAN lengkap (LAN-WhatsApp3)
  berjangka: ['listSimpananBerjangkaDaftar', 'getRingkasanSimpananBerjangka'],
  pendapatanLain: ['listAkunPendapatanLainnya', 'tambahTransaksiPendapatan'],
  kategoriBeban: ['susunOpsiKategoriBeban', 'KATEGORI_BEBAN_TETAP'],
  dataReferensi: ['listDataReferensi', 'hapusDataReferensi'],
  akun: ['listAllAccounts', 'listAccounts', 'getAccountsForPenerimaanPenghasilanLain'],
  kolektibilitas: ['getKlasifikasiPinjamanAktif', 'getRingkasanAging'],
  history: ['listHistoryTransaksi', 'getHistoryDetail', 'listJenisTransaksiTersedia'],
  shu: ['getRiwayatSHU', 'getShuAnggotaList'],
  jadwalHitung: ['hitungJadwalAngsuran', 'hitungDenda'],
  personel: ['listPersonel', 'getSusunanPengurusInti'],
  labelIzin: ['ROLE_LABEL', 'RESOURCE_LABEL', 'AKSI_LABEL'],
  // ---- ekspor PDF/Excel/CSV dari browser LAN (Windows 1.0.21) — builder & layanan yang sama dengan aplikasi
  eksporBuilder: ['buildNeracaSaldoExport', 'buildPosisiKeuanganExport', 'buildLHUExport', 'buildBukuBesarExport', 'buildKolektibilitasExport'],
  eksporLayanan: ['exportLaporan', 'exportToCsv', 'exportToExcel'],
  kebijakanAkun: ['ACCOUNTING_POLICY'],
  kolFiskal: ['getKlasifikasiFiskalPinjamanAktif', 'PERSENTASE_CADANGAN_FISKAL'],
  akunMapping: ['resolveAccountId'],
  saldoAkun: ['getAccountBalance', 'createJournal'],
};

function resolusi(peta, kebutuhan = KEBUTUHAN) {
  const hasil = {};
  const hilang = [];
  for (const [kunci, nama] of Object.entries(kebutuhan)) {
    let kandidat = null;
    for (const n of nama) {
      const ids = new Set(peta.get(n) || []);
      kandidat = kandidat === null ? ids : new Set([...kandidat].filter((x) => ids.has(x)));
    }
    const daftar = [...(kandidat || [])];
    if (daftar.length === 1) hasil[kunci] = daftar[0];
    else hilang.push({ kunci, kandidat: daftar.length, nama });
  }
  return { modul: hasil, hilang };
}

function bangunIndeks(rendererDir) {
  const file = cariBerkasBundle(rendererDir);
  const teks = fs.readFileSync(file, 'utf8');
  const peta = indeksEkspor(teks);
  return Object.assign({ berkas: path.basename(file) }, resolusi(peta));
}

module.exports = { cariBerkasBundle, indeksEkspor, resolusi, bangunIndeks, KEBUTUHAN };
