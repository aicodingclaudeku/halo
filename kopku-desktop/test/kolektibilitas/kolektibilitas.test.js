'use strict';
/**
 * KOPKU Desktop 1.0.33 — uji modul KOLEKTIBILITAS piutang pinjaman & penyisihan piutang tak tertagih.
 *
 * Memakai kode KOPKU ASLI dari bundle renderer (service, SQLite, jurnal) — bukan salinan logika.
 * Ambang & persentase TIDAK diuji terhadap angka buatan uji ini: diambil dari konstanta modul itu sendiri
 * (AMBANG_SOM, PERSENTASE_PENYISIHAN_SOM, PERSENTASE_CADANGAN_FISKAL) sehingga uji ini menguji PENERAPAN
 * aturan, sedangkan nilai aturannya dicatat di laporan audit (docs/AUDIT-1.0.33_KOLEKTIBILITAS.md).
 *
 * Cakupan: usia tunggakan kalender; setiap kategori (Lancar, Kurang Lancar, Diragukan, Macet) untuk setiap
 * kelompok masa angsuran & pinjaman tanpa angsuran; batas tepat-N-bulan vs N-bulan-lewat-sehari; kriteria
 * Diragukan (75% angsuran / 100% agunan), Macet 21 bulan & pengadilan/asuransi; angsuran lunas; pembayaran
 * sebagian; penyisihan SOM & batas fiskal; skenario data 14-10-2026 (lima pinjaman 86–101 hari); konsistensi
 * dengan saldo piutang buku besar, laporan posisi keuangan, dan jurnal penyesuaian penyisihan.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { muatKopku, seed, ROOT } = require('../lan/kopkuHeadless');
const { indeksEkspor, resolusi, cariBerkasBundle } = require(path.join(ROOT, 'electron/server/bundleIndex'));

let k;
let s;
let SOM;
let KOL;
let FIS;
let db;
const TGL = '2026-10-14';

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  const teks = fs.readFileSync(cariBerkasBundle(path.join(ROOT, 'renderer')), 'utf8');
  const r = resolusi(indeksEkspor(teks), {
    som: ['klasifikasikanSom', 'bulanTunggakanTepat', 'hitungPenyisihanSom', 'AMBANG_SOM'],
    kol: ['getKlasifikasiPinjamanAktif', 'sesuaikanPenyisihanPiutang', 'getTotalPenyisihanTarget'],
    fis: ['hitungCadanganFiskal', 'PERSENTASE_CADANGAN_FISKAL', 'getKlasifikasiFiskalPinjamanAktif'],
  });
  SOM = globalThis.__r(r.modul.som);
  KOL = globalThis.__r(r.modul.kol);
  FIS = globalThis.__r(r.modul.fis);
  db = await k.R('db').getDb();
});

// ---------------------------------------------------------------- unit: usia tunggakan kalender
test('usia tunggakan kalender: tepat N bulan = N; lewat sehari > N; akhir bulan; kabisat; sebelum/sama = 0', () => {
  const b = SOM.bulanTunggakanTepat;
  assert.equal(b('2026-07-14', '2026-10-14'), 3, '92 hari = tepat 3 bulan');
  assert.ok(b('2026-07-14', '2026-10-15') > 3 && b('2026-07-14', '2026-10-15') < 3.1, 'lewat sehari');
  assert.ok(b('2026-07-05', '2026-10-14') > 3, '101 hari melampaui 3 bulan');
  assert.ok(b('2026-07-20', '2026-10-14') < 3, '86 hari belum 3 bulan');
  assert.equal(b('2026-01-31', '2026-02-28'), 1, '31 Jan + 1 bulan = 28 Feb (akhir bulan)');
  assert.ok(b('2026-01-31', '2026-03-01') > 1);
  assert.equal(b('2028-01-31', '2028-02-29'), 1, 'kabisat');
  assert.equal(b('2026-10-14', '2026-10-14'), 0);
  assert.equal(b('2026-10-15', '2026-10-14'), 0);
  assert.equal(b('bukan-tanggal', '2026-10-14'), 0);
  // tidak pernah lebih kecil dari bulan penuh lama (perbaikan hanya menambah pecahan)
  for (const [a, z] of [['2026-07-05', '2026-10-14'], ['2025-01-31', '2026-10-14'], ['2026-02-28', '2026-03-31']]) {
    assert.ok(b(a, z) >= SOM.bulanPenuhAntara(a, z) && b(a, z) < SOM.bulanPenuhAntara(a, z) + 1);
  }
});

// ---------------------------------------------------------------- unit: penggolongan per kelompok & batas
const dasar = { polaPengembalian: 'ANGSURAN', bulanTunggakanPokok: 0, bulanTunggakanJasa: 0, sudahJatuhTempo: false, bulanSejakJatuhTempo: 0, angsuranTerbayar: 0, totalKewajibanKontraktual: 1000, nilaiAgunan: 0, sisaUtang: 1000, diserahkanKePengadilanAtauAsuransi: false };
const kat = (o) => SOM.klasifikasikanSom(Object.assign({}, dasar, o)).kategori;

test('setiap kelompok masa angsuran: Lancar ≤ batas bawah < Kurang Lancar ≤ batas atas < Diragukan/Macet (pokok & bunga)', () => {
  const kelompok = { KURANG_DARI_1_BULAN: 7 / 30, SATU_SAMPAI_3_BULAN: 1, ENAM_BULAN_ATAU_LEBIH: 6 };
  for (const [nama, masa] of Object.entries(kelompok)) {
    const am = SOM.AMBANG_SOM[nama];
    for (const [dim, lewat, atas] of [['bulanTunggakanPokok', am.pokokLewatBulan, am.pokokBatasAtasBulan], ['bulanTunggakanJasa', am.jasaLewatBulan, am.jasaBatasAtasBulan]]) {
      const c = (bulan, ekstra = {}) => kat(Object.assign({ masaAngsuranBulan: masa, [dim]: bulan }, ekstra));
      assert.equal(c(0), 'LANCAR', `${nama} ${dim} 0`);
      assert.equal(c(lewat), 'LANCAR', `${nama} ${dim} tepat ${lewat} bulan = belum melampaui`);
      assert.equal(c(lewat + 0.01), 'KURANG_LANCAR', `${nama} ${dim} lewat ${lewat} bulan`);
      assert.equal(c(atas), 'KURANG_LANCAR', `${nama} ${dim} tepat ${atas} bulan`);
      assert.equal(c(atas + 0.01), 'MACET', `${nama} ${dim} lewat ${atas} bulan, tanpa angsuran/agunan memadai`);
      assert.equal(c(atas + 0.01, { angsuranTerbayar: 750 }), 'DIRAGUKAN', `${nama} ${dim} rasio angsuran 75%`);
      assert.equal(c(atas + 0.01, { angsuranTerbayar: 749 }), 'MACET', `${nama} ${dim} rasio angsuran 74,9%`);
      assert.equal(c(atas + 0.01, { nilaiAgunan: 1000 }), 'DIRAGUKAN', `${nama} ${dim} agunan 100%`);
      assert.equal(c(atas + 0.01, { nilaiAgunan: 999 }), 'MACET', `${nama} ${dim} agunan 99,9%`);
    }
  }
});

test('dimensi terburuk menentukan; Diragukan ≥ 21 bulan → Macet; pengadilan/asuransi → Macet', () => {
  assert.equal(kat({ masaAngsuranBulan: 1, bulanTunggakanPokok: 1, bulanTunggakanJasa: 3.2 }), 'KURANG_LANCAR', 'bunga lebih buruk dari pokok');
  const atas = SOM.AMBANG_SOM.SATU_SAMPAI_3_BULAN.pokokBatasAtasBulan;
  const d = (b) => SOM.klasifikasikanSom(Object.assign({}, dasar, { masaAngsuranBulan: 1, bulanTunggakanPokok: b, angsuranTerbayar: 900 }));
  assert.equal(d(atas + 20.9).kategori, 'DIRAGUKAN');
  assert.equal(d(atas + 20.9).bulanSejakDiragukan, 20);
  assert.equal(d(atas + 21).kategori, 'MACET', '21 bulan penuh sejak Diragukan');
  assert.equal(kat({ masaAngsuranBulan: 1, diserahkanKePengadilanAtauAsuransi: true }), 'MACET');
});

test('pinjaman tanpa angsuran: belum jatuh tempo (bunga) & sudah jatuh tempo (≤3 bulan Kurang Lancar)', () => {
  const t = (o) => kat(Object.assign({ polaPengembalian: 'TANPA_ANGSURAN', masaAngsuranBulan: 12 }, o));
  assert.equal(t({ bulanTunggakanJasa: 3 }), 'LANCAR');
  assert.equal(t({ bulanTunggakanJasa: 3.01 }), 'KURANG_LANCAR');
  assert.equal(t({ bulanTunggakanJasa: 6 }), 'KURANG_LANCAR');
  assert.equal(t({ bulanTunggakanJasa: 6.01 }), 'MACET');
  assert.equal(t({ sudahJatuhTempo: true, bulanSejakJatuhTempo: 0.03 }), 'KURANG_LANCAR', 'lewat jatuh tempo sehari');
  assert.equal(t({ sudahJatuhTempo: true, bulanSejakJatuhTempo: 3 }), 'KURANG_LANCAR', 'tepat 3 bulan');
  assert.equal(t({ sudahJatuhTempo: true, bulanSejakJatuhTempo: 3.01 }), 'MACET', 'melampaui 3 bulan');
  assert.equal(t({ sudahJatuhTempo: true, bulanSejakJatuhTempo: 3.01, nilaiAgunan: 1000 }), 'DIRAGUKAN');
});

test('teks dasar penggolongan memakai "N bulan lebih" bila melampaui N', () => {
  const r = SOM.klasifikasikanSom(Object.assign({}, dasar, { masaAngsuranBulan: 1, bulanTunggakanPokok: SOM.bulanTunggakanTepat('2026-07-05', TGL) }));
  assert.equal(r.kategori, 'KURANG_LANCAR');
  assert.match(r.dasarPenggolongan, /tunggakan pokok 3 bulan lebih/);
});

// ---------------------------------------------------------------- unit: penyisihan
test('penyisihan SOM = saldo pokok × persentase kategori (dibulatkan rupiah); fiskal: agunan dikurangkan kecuali Lancar', () => {
  const P = SOM.PERSENTASE_PENYISIHAN_SOM;
  for (const kt of ['LANCAR', 'KURANG_LANCAR', 'DIRAGUKAN', 'MACET']) {
    assert.equal(SOM.hitungPenyisihanSom(6000000, kt), Math.round((6000000 * P[kt]) / 100));
    assert.equal(SOM.hitungPenyisihanSom(-5, kt), 0);
  }
  assert.equal(SOM.hitungPenyisihanSom(1000001, 'DIRAGUKAN'), Math.round(1000001 * 0.75));
  const F = FIS.PERSENTASE_CADANGAN_FISKAL;
  assert.deepEqual(FIS.hitungCadanganFiskal(6000000, 2000000, 'LANCAR'), { dasarPencadanganFiskal: 6000000, cadanganFiskal: (6000000 * F.LANCAR) / 100 });
  assert.deepEqual(FIS.hitungCadanganFiskal(6000000, 2000000, 'KURANG_LANCAR'), { dasarPencadanganFiskal: 4000000, cadanganFiskal: (4000000 * F.KURANG_LANCAR) / 100 });
  assert.deepEqual(FIS.hitungCadanganFiskal(6000000, 9000000, 'MACET'), { dasarPencadanganFiskal: 0, cadanganFiskal: 0 });
});

// ---------------------------------------------------------------- integrasi: data & jurnal sungguhan
const pinjamanUji = {};
async function buatPinjaman(nama, tanggalCair, opsi = {}) {
  const admin = s.users.admin;
  const a = (await k.R('anggota').createAnggota(admin, { namaLengkap: nama, tanggalBergabung: '2025-01-10', status: 'AKTIF' })).id;
  const simp = k.R('simpanan');
  await simp.setorSimpanan({ anggotaId: a, jenis: 'POKOK', tanggal: '2026-01-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin });
  await simp.setorSimpanan({ anggotaId: a, jenis: 'WAJIB', tanggal: '2026-01-15', periode: '2026-01', nominal: 50000, sumberDana: 'KAS', createdBy: admin });
  const pj = k.R('pinjaman');
  const p = await pj.ajukanPinjaman(Object.assign({ anggotaId: a, jumlahPinjaman: 6000000, tanggal: tanggalCair, tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin }, opsi));
  await pj.cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin, tanggalPencairan: tanggalCair, sumberDana: 'KAS' });
  pinjamanUji[nama] = p.id;
  return p.id;
}
const klasifikasi = async (tgl = TGL) => KOL.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: tgl, statusAnggota: 'SEMUA' });
const satu = async (nama, tgl = TGL) => (await klasifikasi(tgl)).find((x) => x.pinjamanId === pinjamanUji[nama]);

test('data 14-10-2026: lima pinjaman bulanan tunggakan 86–101 hari → yang melampaui 3 bulan kalender = Kurang Lancar, penyisihan > 0', async () => {
  // jatuh tempo angsuran pertama = tanggal cair + 1 bulan
  const kasus = [['T86', '2026-06-20', 86, 'LANCAR'], ['T90', '2026-06-16', 90, 'LANCAR'], ['T92', '2026-06-14', 92, 'LANCAR'], ['T95', '2026-06-11', 95, 'KURANG_LANCAR'], ['T101', '2026-06-05', 101, 'KURANG_LANCAR']];
  for (const [nama, cair] of kasus) await buatPinjaman(nama, cair);
  for (const [nama, , hari, harap] of kasus) {
    const x = await satu(nama);
    assert.equal(x.hariTunggakan, hari, `${nama} hari tunggakan`);
    assert.equal(x.kolektibilitas, harap, `${nama}: ${x.dasarPenggolongan}`);
    assert.equal(x.nilaiCadangan, SOM.hitungPenyisihanSom(x.saldoPokok, harap));
    assert.equal(Number.isInteger(x.bulanTunggakanPokok), true, 'kolom tampilan tetap bilangan bulat');
  }
  assert.equal((await satu('T95')).nilaiCadangan, 3000000);
  // batas tepat: T92 (jatuh tempo 14 Jul) Lancar pada 14 Okt, Kurang Lancar pada 15 Okt
  assert.equal((await satu('T92', '2026-10-15')).kolektibilitas, 'KURANG_LANCAR');
  const total = (await klasifikasi()).reduce((a, x) => a + x.nilaiCadangan, 0);
  assert.equal(total, 6000000, 'total penyisihan SOM tidak lagi Rp0');
  assert.equal(await KOL.getTotalPenyisihanTarget(db, TGL), total);
  // fiskal mengikuti kategori yang sama
  const fis = await FIS.getKlasifikasiFiskalPinjamanAktif(db, { tanggalLaporan: TGL, statusAnggota: 'SEMUA' });
  for (const f of fis) assert.equal(f.kolektibilitasFiskal, f.kolektibilitas);
});

test('angsuran LUNAS: melunasi angsuran tertua memundurkan usia tunggakan (T101 → Lancar)', async () => {
  const pj = k.R('pinjaman');
  const id = pinjamanUji.T101;
  const j = (await pj.getJadwalAngsuran(id)).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
  await pj.bayarAngsuran({ pinjamanId: id, jadwalId: j[0].id, tanggal: TGL, nominal: j[0].total, sumberDana: 'KAS', createdBy: s.users.admin });
  const x = await satu('T101');
  assert.equal(x.tanggalJatuhTempoTertunggak, j[1].tanggalJatuhTempo, 'tertua kini angsuran ke-2');
  assert.equal(x.kolektibilitas, 'LANCAR', x.dasarPenggolongan);
});

test('pembayaran SEBAGIAN: angsuran tertua yang belum lunas tetap dihitung (T95 tetap Kurang Lancar)', async () => {
  const pj = k.R('pinjaman');
  const id = pinjamanUji.T95;
  const j = (await pj.getJadwalAngsuran(id)).sort((a, b) => a.nomorAngsuran - b.nomorAngsuran);
  await pj.bayarAngsuran({ pinjamanId: id, jadwalId: j[0].id, tanggal: TGL, nominal: Math.round(j[0].total / 2), sumberDana: 'KAS', createdBy: s.users.admin });
  const sesudah = (await pj.getJadwalAngsuran(id)).find((r) => r.id === j[0].id);
  assert.ok(sesudah.pokokTerbayar + sesudah.jasaTerbayar > 0 && sesudah.pokokTerbayar < sesudah.pokok, 'terbayar sebagian');
  const x = await satu('T95');
  assert.equal(x.tanggalJatuhTempoTertunggak, j[0].tanggalJatuhTempo);
  assert.equal(x.kolektibilitas, 'KURANG_LANCAR');
  assert.equal(x.saldoPokok, 6000000 - sesudah.pokokTerbayar, 'saldo pokok berkurang sebesar pokok terbayar');
  assert.equal(x.nilaiCadangan, SOM.hitungPenyisihanSom(x.saldoPokok, 'KURANG_LANCAR'));
});

test('konsistensi: Σ saldo pokok = Piutang Pinjaman di buku besar; jurnal penyesuaian penyisihan resmi = target; neraca seimbang; jurnal lama tidak berubah', async () => {
  const lap = k.R('laporan');
  const tb = await lap.getTrialBalance(db, TGL);
  const piutang = tb.rows.find((r) => r.kode === '1-1200');
  const kl = await klasifikasi();
  assert.equal(kl.reduce((a, x) => a + x.saldoPokok, 0), piutang.debit - piutang.kredit, 'saldo piutang klasifikasi = buku besar');
  const jurnalHeaderSebelum = await db.getAllAsync('SELECT * FROM journal ORDER BY id');
  const jurnalSebelum = await db.getAllAsync('SELECT * FROM journal_entry ORDER BY id');
  const target = await KOL.getTotalPenyisihanTarget(db, TGL);
  const h = await KOL.sesuaikanPenyisihanPiutang({ tanggal: TGL, createdBy: s.users.admin });
  assert.equal(h.targetPenyisihan, target);
  assert.equal(h.saldoPenyisihanSebelumnya, 0, 'sebelumnya tercatat Rp0');
  assert.equal(h.delta, target);
  assert.ok(h.journalId);
  const saldo = await k.R('saldoAkun').getAccountBalance(db, await k.R('akunMapping').resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN'), TGL);
  assert.equal(saldo, target, 'saldo akun penyisihan = target');
  const ulang = await KOL.sesuaikanPenyisihanPiutang({ tanggal: TGL, createdBy: s.users.admin });
  assert.equal(ulang.delta, 0, 'idempoten: tidak ada jurnal ganda');
  const jurnalSesudah = await db.getAllAsync('SELECT * FROM journal_entry ORDER BY id');
  const lama = new Map(jurnalSebelum.map((r) => [r.id, JSON.stringify(r)]));
  for (const r of jurnalSesudah) if (lama.has(r.id)) assert.equal(JSON.stringify(r), lama.get(r.id), 'baris jurnal lama tidak berubah');
  assert.equal(jurnalSesudah.length, jurnalSebelum.length + 2, 'hanya 2 baris jurnal penyesuaian baru');
  const headerLama = new Map(jurnalHeaderSebelum.map((r) => [r.id, JSON.stringify(r)]));
  const jurnalHeaderSesudah = await db.getAllAsync('SELECT * FROM journal ORDER BY id');
  for (const r of jurnalHeaderSesudah) if (headerLama.has(r.id)) assert.equal(JSON.stringify(r), headerLama.get(r.id), 'jurnal lama tidak berubah');
  assert.equal(jurnalHeaderSesudah.length, jurnalHeaderSebelum.length + 1, 'satu jurnal penyesuaian PSH baru');
  const pos = await lap.getPosisiKeuangan(db, TGL);
  assert.equal(pos.isBalanced, true);
});

// ---------------------------------------------------------------- 1.0.34 (audit menyeluruh, RC-S133.6.11)
test('1.0.34 F2: rincian tunggakan — jumlah angsuran, pokok & jasa jatuh tempo, jasa belum jatuh tempo; tidak mengubah kategori/cadangan', async () => {
  const kl = await klasifikasi();
  for (const x of kl) {
    assert.equal(typeof x.angsuranTertunggak, 'number', `${x.nomorPinjaman} angsuranTertunggak`);
    assert.equal(x.jasaTertunggak + x.jasaBelumJatuhTempo, x.saldoJasa, `${x.nomorPinjaman} jasa jatuh tempo + belum = saldo jasa`);
    assert.ok(x.pokokTertunggak <= x.saldoPokok);
    assert.equal(x.nilaiCadangan, SOM.hitungPenyisihanSom(x.saldoPokok, x.kolektibilitas), 'cadangan tetap dari saldo pokok');
  }
  // T95: jatuh tempo 11-07, 11-08, 11-09, 11-10 sudah tiba per 14-10 (angsuran ke-1 dibayar sebagian) → 4 angsuran
  const t95 = await satu('T95');
  const j = (await k.R('pinjaman').getJadwalAngsuran(pinjamanUji.T95)).filter((r) => r.tanggalJatuhTempo <= TGL);
  assert.equal(j.length, 4);
  assert.equal(t95.angsuranTertunggak, 4);
  assert.equal(t95.pokokTertunggak, j.reduce((a, r) => a + r.pokok - r.pokokTerbayar, 0));
  assert.equal(t95.jasaTertunggak, j.reduce((a, r) => a + r.jasa - r.jasaTerbayar, 0));
  // T86: belum ada angsuran yang melewati 3 bulan, tetapi 3 angsuran (20-07, 20-08, 20-09) sudah jatuh tempo
  assert.equal((await satu('T86')).angsuranTertunggak, 3);
});

test('1.0.34 F1: lingkup layar AKTIF ≠ target jurnal (SEMUA) — ekspor menyatakan penyesuaian = jurnal yang benar-benar dibuat', async () => {
  const teks = fs.readFileSync(cariBerkasBundle(path.join(ROOT, 'renderer')), 'utf8');
  const EXP = globalThis.__r(resolusi(indeksEkspor(teks), { exp: ['buildKolektibilitasExport'] }).modul.exp);
  const penyisihanId = await k.R('akunMapping').resolveAccountId(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN');
  const tercatat = await k.R('saldoAkun').getAccountBalance(db, penyisihanId, TGL);
  const target = await KOL.getTotalPenyisihanTarget(db, TGL);
  assert.equal(tercatat, target, 'prasyarat: buku besar sudah disesuaikan pada uji sebelumnya');
  // Anggota peminjam T95 (Kurang Lancar) menjadi nonaktif — DB uji, bukan data pengguna.
  const t95 = await satu('T95');
  await db.runAsync(`UPDATE anggota SET status = 'TIDAK_AKTIF' WHERE id = ?`, t95.anggotaId);
  const aktif = await KOL.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: TGL, statusAnggota: 'AKTIF' });
  const totalAktif = aktif.reduce((a, x) => a + x.nilaiCadangan, 0);
  assert.equal(totalAktif, target - t95.nilaiCadangan, 'lingkup AKTIF tidak memuat cadangan T95');
  assert.equal(await KOL.getTotalPenyisihanTarget(db, TGL), target, 'target jurnal tetap SEMUA anggota');
  const info = { namaKoperasi: 'Uji' };
  const kv = (ex) => Object.fromEntries(ex.seksi[0].baris.map((b) => [b.label, b.nilai]));
  const sesudah = kv(EXP.buildKolektibilitasExport(info, 'P', aktif, { lingkupAnggota: 'Anggota aktif', penyisihanTercatat: tercatat, targetPenyisihanBukuBesar: target }));
  assert.equal(sesudah['Penyesuaian penyisihan yang diperlukan'], 'Tidak ada (sudah sesuai)');
  assert.ok(sesudah['Target penyisihan buku besar (semua anggota)'], 'target SEMUA anggota ditampilkan saat berbeda dari lingkup');
  // Perilaku 1.0.33 (tanpa target): ekspor menyuruh "Kurangi" padahal jurnal tidak akan dibuat.
  const lama = kv(EXP.buildKolektibilitasExport(info, 'P', aktif, { penyisihanTercatat: tercatat }));
  assert.match(lama['Penyesuaian penyisihan yang diperlukan'], /^Kurangi /);
  const h = await KOL.sesuaikanPenyisihanPiutang({ tanggal: TGL, createdBy: s.users.admin });
  assert.equal(h.delta, 0, 'jurnal sungguhan: tidak ada penyesuaian — sama dengan ekspor 1.0.34');
  await db.runAsync(`UPDATE anggota SET status = 'AKTIF' WHERE id = ?`, t95.anggotaId);
});

test('1.0.34: layar Kolektibilitas Piutang di bundle memakai target jurnal (getTotalPenyisihanTarget) untuk selisih & konfirmasi', () => {
  const teks = fs.readFileSync(cariBerkasBundle(path.join(ROOT, 'renderer')), 'utf8');
  assert.ok(teks.includes('KOPKU 1.0.34 kolektibilitas audit'));
  assert.ok(teks.includes('const target = await (0, LoanImpairmentService_1.getTotalPenyisihanTarget)(db, tanggalLaporan);'));
  assert.ok(teks.includes('const selisihPenyisihan = saldoTercatat !== null ? targetPenyisihan - saldoTercatat : 0;'));
  assert.ok(teks.includes('menjadi ${(0, money_1.formatRupiah)(targetPenyisihan)} (selisih'));
  assert.ok(teks.includes('targetPenyisihanBukuBesar: targetBukuBesar,'));
  assert.ok(!teks.includes('ringkasan.totalCadangan - saldoTercatat'), 'tidak ada lagi selisih terhadap total lingkup');
});
