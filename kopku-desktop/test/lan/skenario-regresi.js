'use strict';
/**
 * Skenario regresi kembar. Dijalankan sebagai proses anak:
 *   node skenario-regresi.js langsung   → service KOPKU dipanggil langsung (perilaku desktop)
 *   node skenario-regresi.js lan        → operasi yang SAMA lewat API LAN (HTTP)
 * Mencetak snapshot hasil (tanpa id/timestamp) dalam JSON ke stdout.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const mode = process.argv[2];

const OPS = [
  { op: 'bayar', pinjaman: 0, ke: 1, tanggal: '2026-08-20', nominal: 500000, sumberDana: 'KAS' }, // terlambat 5 hari (denda)
  { op: 'bayar', pinjaman: 0, ke: 1, tanggal: '2026-08-25', nominal: 590000, sumberDana: 'KAS' },
  { op: 'bayar', pinjaman: 1, ke: 1, tanggal: '2026-08-15', nominal: 1090000, sumberDana: 'KAS' }, // tepat jatuh tempo
  { op: 'bayar', pinjaman: 2, ke: 1, tanggal: '2026-08-01', nominal: 1090000, sumberDana: 'KAS' }, // sebelum jatuh tempo (jasa dimuka)
  { op: 'bayar', pinjaman: 2, ke: 2, tanggal: '2026-08-02', nominal: 300000, sumberDana: 'KAS' }, // sebagian, sebelum jatuh tempo
  { op: 'lunas', pinjaman: 3, tanggal: '2026-09-20', metode: 'JASA_TERUTANG', sumberDana: 'KAS' },
  { op: 'lunas', pinjaman: 1, tanggal: '2026-10-01', metode: 'JASA_KONTRAKTUAL', sumberDana: 'KAS' },
  { op: 'anggota', data: { namaLengkap: 'Regresi Baru', nik: '3201010101010001', jenisKelamin: 'PEREMPUAN', alamat: 'Jl. Uji 1', nomorHp: '081311112222', pekerjaan: 'Pedagang', tanggalBergabung: '2026-09-01' } },
  { op: 'setor', anggotaBaru: true, jenis: 'POKOK', tanggal: '2026-09-01', nominal: 100000, sumberDana: 'KAS' },
  { op: 'setor', anggotaBaru: true, jenis: 'WAJIB', tanggal: '2026-09-01', periode: '2026-09', nominal: 50000, sumberDana: 'KAS' },
  { op: 'setor', anggota: 1, jenis: 'SUKARELA', tanggal: '2026-09-02', nominal: 750000, sumberDana: 'KAS' },
  { op: 'ubahAnggota', anggota: 2, data: { namaLengkap: 'Anggota Uji 3 (ubah)', pekerjaan: 'Guru' } },
  // ---- menu LAN lengkap (LAN-WhatsApp3)
  { op: 'tarik', anggota: 1, tanggal: '2026-09-03', nominal: 250000, sumberDana: 'KAS', keterangan: 'Tarik regresi' },
  { op: 'kasMasuk', kodeAkun: '4-2000', jenis: 'KAS', tanggal: '2026-09-04', nominal: 175000, kategori: 'Lain-lain', keterangan: 'Pendapatan regresi' },
  { op: 'kasKeluar', kategoriKey: 'kat:Beban Listrik', jenis: 'KAS', tanggal: '2026-09-05', nominal: 85000, keterangan: 'Listrik September' },
  { op: 'transfer', sumberJenis: 'KAS', tujuanJenis: 'BANK', tanggal: '2026-09-06', nominal: 5000000, keterangan: 'Setor ke bank' },
  { op: 'kasKeluar', kategoriKey: 'kat:Beban Sewa', jenis: 'BANK', tanggal: '2026-09-07', nominal: 300000 },
  { op: 'ajukan', data: { tanggal: '2026-09-08', jumlahPinjaman: 3000000, tenor: 3, satuanTenor: 'BULAN', metodeJasa: 'EFEKTIF', persentaseJasa: 1.25, biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 25000, biayaAdminKlasifikasi: 'SEPARATE_SERVICE', tujuanPinjaman: 'MODAL_KERJA', dendaAktif: true, dendaTipe: 'PER_HARI', dendaNilai: 1000, agunan: { jenisAgunan: 'KENDARAAN', pemilik: 'Regresi Baru', nomorDokumen: 'BPKB-001', nilaiAgunan: 5000000 } } },
  { op: 'cairkan', tanggal: '2026-09-09', sumberDana: 'BANK' },
  { op: 'ajukan', data: { tanggal: '2026-09-10', jumlahPinjaman: 1000000, tenor: 2, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 2, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, biayaAdminKlasifikasi: 'SEPARATE_SERVICE', dendaAktif: false, dendaNilai: 0 } },
  { op: 'batalkan', alasan: 'Anggota membatalkan' },
];

async function main() {
  const { muatKopku, seed, PASSWORD } = require('./kopkuHeadless');
  const k = muatKopku({ lisensiValid: true });
  const s = await seed(k);
  const R = k.R;
  const admin = s.users.admin;
  const jadwalKe = async (pid, ke) => (await R('pinjaman').getJadwalAngsuran(pid)).find((j) => j.nomorAngsuran === ke);
  let anggotaBaru = null;
  let pinjamanBaru = null;
  // Rekening bank dibuat langsung lewat service (menu Data Bank tetap di desktop).
  const bankId = (await R('kasBank').tambahRekeningBank({ namaBank: 'Bank Regresi', nomorRekening: '0001', namaPemilik: 'Koperasi', saldoAwal: 0, createdBy: admin })).id;
  let jalankan;
  let tutup = async () => undefined;

  if (mode === 'langsung') {
    jalankan = async (o) => {
      const pid = s.pinjaman[o.pinjaman];
      if (o.op === 'bayar') {
        const j = await jadwalKe(pid, o.ke);
        return R('pinjaman').bayarAngsuran({ pinjamanId: pid, jadwalId: j.id, tanggal: o.tanggal, nominal: o.nominal, sumberDana: o.sumberDana, createdBy: admin });
      }
      if (o.op === 'lunas') return R('pinjaman').lunasiPinjaman({ pinjamanId: pid, tanggal: o.tanggal, metodeJasaPelunasan: o.metode, sumberDana: o.sumberDana, createdBy: admin });
      if (o.op === 'anggota') return (anggotaBaru = (await R('anggota').createAnggota(admin, Object.assign({ status: 'AKTIF' }, o.data))).id);
      if (o.op === 'setor') return R('simpanan').setorSimpanan({ anggotaId: o.anggotaBaru ? anggotaBaru : s.anggota[o.anggota], jenis: o.jenis, tanggal: o.tanggal, periode: o.periode, nominal: o.nominal, sumberDana: o.sumberDana, createdBy: admin });
      if (o.op === 'tarik') return R('simpanan').tarikSimpananSukarela({ anggotaId: s.anggota[o.anggota], tanggal: o.tanggal, nominal: o.nominal, sumberDana: o.sumberDana, keterangan: o.keterangan, createdBy: admin });
      if (o.op === 'kasMasuk') {
        const ak = (await R('pendapatanLain').listAkunPendapatanLainnya()).find((x) => x.kode === o.kodeAkun);
        return R('pendapatanLain').tambahTransaksiPendapatan({ jenis: o.jenis, tanggal: o.tanggal, nominal: o.nominal, accountId: ak.accountId, kategori: o.kategori, keterangan: o.keterangan, createdBy: admin });
      }
      if (o.op === 'kasKeluar') {
        const opsi = R('kategoriBeban').susunOpsiKategoriBeban(await R('dataReferensi').listDataReferensi('BEBAN_LAIN')).find((x) => x.key === o.kategoriKey);
        const ak = (await R('akun').listAccounts({ search: opsi.akunNama })).find((x) => x.nama === opsi.akunNama);
        return R('kasBank').catatPengeluaran({ jenis: o.jenis, bankAccountId: o.jenis === 'BANK' ? bankId : undefined, tanggal: o.tanggal, nominal: o.nominal, akunLawanId: ak.id, kategori: opsi.label, keterangan: o.keterangan, createdBy: admin });
      }
      if (o.op === 'transfer') return R('kasBank').transferAntarRekening({ sumberJenis: o.sumberJenis, tujuanJenis: o.tujuanJenis, tujuanBankAccountId: bankId, tanggal: o.tanggal, nominal: o.nominal, keterangan: o.keterangan, createdBy: admin });
      if (o.op === 'ajukan') return (pinjamanBaru = await R('pinjaman').ajukanPinjaman(Object.assign({ anggotaId: anggotaBaru, createdBy: admin }, o.data)));
      if (o.op === 'cairkan') return R('pinjaman').cairkanPinjaman({ pinjamanId: pinjamanBaru.id, sumberDana: o.sumberDana, bankAccountId: o.sumberDana === 'BANK' ? bankId : undefined, tanggalPencairan: o.tanggal, approvedBy: admin });
      if (o.op === 'batalkan') return R('pinjaman').batalkanPinjaman({ pinjamanId: pinjamanBaru.id, alasan: o.alasan, actingUserId: admin });
      if (o.op === 'ubahAnggota') {
        const id = s.anggota[o.anggota];
        const lama = await R('anggota').getAnggotaById(id);
        const data = Object.assign({}, lama, o.data);
        delete data.id;
        delete data.nomorAnggota;
        return R('anggota').updateAnggota(admin, id, data);
      }
      throw new Error('op?');
    };
  } else if (mode === 'lan') {
    const { pasangAdapter } = require('../../electron/server/rendererAdapter');
    const { DirectServiceBridge } = require('../../electron/server/serviceBridge');
    const { KopkuLanServer } = require('../../electron/server');
    const { Klien, portAcak } = require('./kit');
    const bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-reg-'));
    const port = portAcak();
    fs.writeFileSync(path.join(dataDir, 'kopku-server.json'), JSON.stringify({ mode: 'LAN_SERVER', host: '127.0.0.1', port }));
    const srv = new KopkuLanServer({ dataDir, rendererDir: path.join(__dirname, '..', '..', 'renderer'), bridge, logFile: null, tickMs: 3600000 });
    const st = await srv.mulai();
    if (st.server !== 'ONLINE') throw new Error(st.galat);
    tutup = () => srv.henti();
    const c = new Klien(`http://127.0.0.1:${port}`);
    const l = await c.login('admin', PASSWORD.admin);
    if (l.status !== 200) throw new Error('login');
    const ok = (r) => {
      if (r.status !== 200) throw new Error(`API ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.data;
    };
    jalankan = async (o) => {
      const pid = s.pinjaman[o.pinjaman];
      if (o.op === 'bayar') {
        const d = ok(await c.req('GET', `/api/pinjaman/${pid}`));
        const j = d.jadwal.find((x) => x.nomorAngsuran === o.ke);
        return ok(await c.req('POST', `/api/pinjaman/${pid}/angsuran/${j.id}/bayar`, { tanggal: o.tanggal, nominal: o.nominal, sumberDana: o.sumberDana, versiJadwal: j.versi }));
      }
      if (o.op === 'lunas') {
        const h = ok(await c.req('GET', `/api/pinjaman/${pid}/pelunasan?tanggal=${o.tanggal}&metode=${o.metode}`));
        return ok(await c.req('POST', `/api/pinjaman/${pid}/pelunasan`, { tanggal: o.tanggal, metode: o.metode, sumberDana: o.sumberDana, totalDilihat: h.totalPelunasan }));
      }
      if (o.op === 'anggota') return (anggotaBaru = ok(await c.req('POST', '/api/anggota', o.data)).id);
      if (o.op === 'setor') return ok(await c.req('POST', '/api/simpanan/setor', { anggotaId: o.anggotaBaru ? anggotaBaru : s.anggota[o.anggota], jenis: o.jenis, tanggal: o.tanggal, periode: o.periode, nominal: o.nominal, sumberDana: o.sumberDana }));
      if (o.op === 'tarik') return ok(await c.req('POST', '/api/simpanan/tarik', { anggotaId: s.anggota[o.anggota], tanggal: o.tanggal, nominal: o.nominal, sumberDana: o.sumberDana, keterangan: o.keterangan }));
      if (o.op === 'kasMasuk') {
        const opsi = ok(await c.req('GET', '/api/kas/opsi'));
        const ak = opsi.pendapatan.find((x) => x.kode === o.kodeAkun);
        return ok(await c.req('POST', '/api/kas/masuk', { jenis: o.jenis, tanggal: o.tanggal, nominal: o.nominal, accountId: ak.accountId, kategori: o.kategori, keterangan: o.keterangan }));
      }
      if (o.op === 'kasKeluar') return ok(await c.req('POST', '/api/kas/keluar', { jenis: o.jenis, bankAccountId: o.jenis === 'BANK' ? bankId : undefined, kategoriKey: o.kategoriKey, tanggal: o.tanggal, nominal: o.nominal, keterangan: o.keterangan }));
      if (o.op === 'transfer') return ok(await c.req('POST', '/api/kas/transfer', { sumberJenis: o.sumberJenis, tujuanJenis: o.tujuanJenis, tujuanBankAccountId: bankId, tanggal: o.tanggal, nominal: o.nominal, keterangan: o.keterangan }));
      if (o.op === 'ajukan') return (pinjamanBaru = ok(await c.req('POST', '/api/pinjaman', Object.assign({ anggotaId: anggotaBaru }, o.data))));
      if (o.op === 'cairkan') return ok(await c.req('POST', `/api/pinjaman/${pinjamanBaru.id}/cairkan`, { tanggalPencairan: o.tanggal, sumberDana: o.sumberDana, bankAccountId: o.sumberDana === 'BANK' ? bankId : undefined }));
      if (o.op === 'batalkan') return ok(await c.req('POST', `/api/pinjaman/${pinjamanBaru.id}/batalkan`, { alasan: o.alasan }));
      if (o.op === 'ubahAnggota') {
        const id = s.anggota[o.anggota];
        const d = ok(await c.req('GET', `/api/anggota/${id}`));
        return ok(await c.req('PUT', `/api/anggota/${id}`, { versi: d.versi, data: o.data }));
      }
      throw new Error('op?');
    };
  } else throw new Error('mode: langsung | lan');

  const hasilOp = [];
  for (const o of OPS) {
    const r = await jalankan(o);
    if (['tarik', 'kasMasuk', 'kasKeluar', 'transfer', 'ajukan', 'cairkan', 'batalkan'].includes(o.op)) {
      hasilOp.push(o.op);
      continue;
    }
    hasilOp.push(o.op === 'bayar' ? { porsiPokok: r.porsiPokok, porsiJasa: r.porsiJasa, porsiDenda: r.porsiDenda } : o.op === 'lunas' ? { totalPelunasan: r.totalPelunasan, porsiPokok: r.porsiPokok, porsiJasa: r.porsiJasa, porsiDenda: r.porsiDenda, rabatJasa: r.rabatJasa } : o.op);
  }
  await tutup();

  // ------------------------------------------------ snapshot (tanpa id/timestamp)
  const d = await R('db').getDb();
  const q = (sql, ...p) => d.getAllAsync(sql, ...p);
  const snap = { hasilOp };
  snap.schema = (await d.getFirstAsync('SELECT version FROM schema_meta')).version;
  snap.tabel = (await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
  snap.pinjaman = await q('SELECT nomor_pinjaman, status, jumlah_pinjaman, tenor, metode_jasa, persentase_jasa FROM pinjaman ORDER BY nomor_pinjaman');
  snap.jadwal = await q(
    'SELECT p.nomor_pinjaman, aj.nomor_angsuran, aj.tanggal_jatuh_tempo, aj.pokok, aj.jasa, aj.denda, aj.total, aj.pokok_terbayar, aj.jasa_terbayar, aj.denda_terbayar, aj.jasa_dimuka, aj.status FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id ORDER BY 1, 2'
  );
  snap.pembayaran = await q(
    'SELECT p.nomor_pinjaman, aj.nomor_angsuran, ap.tanggal, ap.nominal, ap.porsi_pokok, ap.porsi_jasa, ap.porsi_denda, ap.sumber_dana, ap.metode_jasa_pelunasan, ap.rabat_jasa_pelunasan FROM angsuran_pembayaran ap JOIN pinjaman p ON p.id = ap.pinjaman_id LEFT JOIN angsuran_jadwal aj ON aj.id = ap.jadwal_id ORDER BY 1, 3, 2'
  );
  snap.jurnal = await q(
    "SELECT j.tanggal, j.sumber_transaksi, j.nomor_referensi, j.deskripsi, j.status, a.kode, je.debit, je.kredit FROM journal j JOIN journal_entry je ON je.journal_id = j.id JOIN account a ON a.id = je.account_id ORDER BY j.tanggal, j.sumber_transaksi, j.nomor_referensi, a.kode, je.debit, je.kredit"
  );
  snap.saldoAkun = await q("SELECT a.kode, SUM(je.debit) d, SUM(je.kredit) k FROM journal_entry je JOIN account a ON a.id = je.account_id JOIN journal j ON j.id = je.journal_id WHERE j.status = 'POSTED' GROUP BY a.kode ORDER BY a.kode");
  snap.simpanan = await q('SELECT a.nomor_anggota, st.jenis, st.tipe, st.tanggal, st.periode, st.nominal, st.nomor_transaksi, st.sumber_dana FROM simpanan_transaksi st JOIN anggota a ON a.id = st.anggota_id ORDER BY 1, 4, 2, 7');
  snap.anggota = await q('SELECT nomor_anggota, nik, nama_lengkap, jenis_kelamin, tempat_lahir, tanggal_lahir, alamat, nomor_hp, pekerjaan, tanggal_bergabung, status, catatan FROM anggota ORDER BY nomor_anggota');
  snap.posisi = await R('laporan').getPosisiKeuangan(d, '2026-12-31');
  snap.lhu = await R('laporan').getLHU(d, '2026-01-01', '2026-12-31');
  snap.tunggakan = (await R('pinjaman').listTunggakan()).map((t) => Object.assign({}, t, { pinjamanId: undefined }));
  snap.saldoSimpanan = [];
  for (const a of await q('SELECT id, nomor_anggota FROM anggota ORDER BY nomor_anggota')) snap.saldoSimpanan.push([a.nomor_anggota, await R('simpanan').getRingkasanSaldoSimpananAnggota(a.id)]);
  snap.kas = await q('SELECT jenis_kas, tipe, tanggal, nominal, kategori, keterangan, nomor_transaksi FROM kas_transaksi ORDER BY tanggal, nomor_transaksi');
  snap.bank = await q('SELECT tipe, tanggal, nominal, kategori, keterangan, nomor_transaksi FROM bank_transaksi ORDER BY tanggal, nomor_transaksi');
  snap.pinjamanBaru = await q("SELECT nomor_pinjaman, status, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_tipe, denda_nilai, tujuan_pinjaman, keterangan FROM pinjaman WHERE tanggal >= '2026-09-01' ORDER BY nomor_pinjaman");
  snap.agunan = await q('SELECT jenis_agunan, pemilik, nomor_dokumen, nilai_agunan FROM pinjaman_agunan ORDER BY nomor_dokumen');
  snap.labaRugi = await R('laporan').getLabaRugi(d, '2026-01-01', '2026-12-31');
  snap.arusKas = await R('laporan').getArusKas(d, '2026-01-01', '2026-12-31');
  // Urutan dua kaki transfer dalam satu jurnal tidak deterministik (id acak) → bandingkan sebagai himpunan.
  snap.arusKas.rincian = snap.arusKas.rincian.slice().sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  snap.auditBisnis = await q('SELECT action, entity, COUNT(*) n FROM audit_log GROUP BY action, entity ORDER BY action, entity');
  snap.sequence = await q('SELECT seq_key, last_value FROM sequence_counter ORDER BY seq_key');
  process.stdout.write('\n@@SNAPSHOT@@' + JSON.stringify(snap));
}

main().catch((e) => {
  console.error('GAGAL', e && e.stack);
  process.exit(1);
});
