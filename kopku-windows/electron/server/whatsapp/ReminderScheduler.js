'use strict';
/**
 * KOPKU LAN SERVER — PENJADWAL WHATSAPP REMINDER (H-3, H-1, H, H+1, H+7).
 *
 * BERJALAN HANYA DI SERVER (main process KOPKU Desktop), satu instance:
 *   - satu proses KOPKU per komputer (requestSingleInstanceLock existing);
 *   - lease `scheduler_lease` di kopku-server.db (pemilik + kedaluwarsa);
 *   - flag re-entrancy di proses (tick tidak pernah tumpang tindih).
 * Browser/klien tidak pernah menjalankan penjadwal.
 *
 * Idempotensi: UNIQUE(pinjaman_id, jenis_notifikasi, tanggal_jadwal) +
 * INSERT OR IGNORE, sehingga restart/eksekusi ganda tidak membuat pesan
 * ganda. Status: pending → sending → sent | failed | skipped.
 *
 * Data authoritative: kandidat & pengecekan ulang tepat sebelum kirim
 * diambil dari koperasi.db lewat adapter (fragmen SQL status jadwal &
 * rumus sisa tagihan milik service existing). Angsuran yang sudah dibayar
 * (LUNAS) atau pinjaman yang sudah lunas/tidak aktif → skipped.
 */
const crypto = require('node:crypto');
const { normalisasiNomor, samarkanNomor } = require('./nomor');

const JENIS = {
  H_MIN_3: { offsetHari: -3, label: 'H-3', keterangan: 'akan jatuh tempo 3 hari lagi' },
  H_MIN_1: { offsetHari: -1, label: 'H-1', keterangan: 'akan jatuh tempo besok' },
  H: { offsetHari: 0, label: 'H', keterangan: 'jatuh tempo hari ini' },
  H_PLUS_1: { offsetHari: 1, label: 'H+1', keterangan: 'telah lewat jatuh tempo 1 hari' },
  H_PLUS_7: { offsetHari: 7, label: 'H+7', keterangan: 'telah lewat jatuh tempo 7 hari' },
};
const MAKS_PERCOBAAN = 3;
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const JEDA_JARINGAN_MS = 5 * 60 * 1000;
const JEDA_KONFIGURASI_MS = 30 * 60 * 1000;
const LEASE_MS = 3 * 60 * 1000;
const NAMA_LEASE = 'wa-reminder';

/** Tanggal lokal (zona waktu komputer server) → 'YYYY-MM-DD'. */
function tanggalLokal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function geserHari(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function tanggalPanjang(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${BULAN[m - 1]} ${y}`;
}
function rupiah(n) {
  return 'Rp ' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

class PengaturanWa {
  constructor(db) {
    this.db = db;
  }
  baca() {
    const p = this.db.getPengaturan('whatsapp.reminder', null) || {};
    const jenis = {};
    for (const k of Object.keys(JENIS)) jenis[k] = p.jenis && typeof p.jenis[k] === 'boolean' ? p.jenis[k] : true;
    return {
      aktif: p.aktif === true,
      jamKirim: typeof p.jamKirim === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.jamKirim) ? p.jamKirim : '08:00',
      jenis,
      nomorTest: typeof p.nomorTest === 'string' ? p.nomorTest : '',
    };
  }
  simpan(input, oleh) {
    if (!input || typeof input !== 'object') throw Object.assign(new Error('Pengaturan tidak valid.'), { kode: 'VALIDASI' });
    const lama = this.baca();
    const baru = Object.assign({}, lama);
    if ('aktif' in input) {
      if (typeof input.aktif !== 'boolean') throw Object.assign(new Error('Status aktif harus true/false.'), { kode: 'VALIDASI' });
      baru.aktif = input.aktif;
    }
    if ('jamKirim' in input) {
      if (typeof input.jamKirim !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.jamKirim)) throw Object.assign(new Error('Waktu pengiriman harus HH:MM (00:00–23:59).'), { kode: 'VALIDASI' });
      baru.jamKirim = input.jamKirim;
    }
    if ('jenis' in input) {
      if (!input.jenis || typeof input.jenis !== 'object') throw Object.assign(new Error('Pilihan jenis reminder tidak valid.'), { kode: 'VALIDASI' });
      for (const k of Object.keys(JENIS)) if (k in input.jenis) {
        if (typeof input.jenis[k] !== 'boolean') throw Object.assign(new Error(`Pilihan ${JENIS[k].label} tidak valid.`), { kode: 'VALIDASI' });
        baru.jenis[k] = input.jenis[k];
      }
    }
    if ('nomorTest' in input) {
      if (input.nomorTest === '' || input.nomorTest == null) baru.nomorTest = '';
      else {
        const n = normalisasiNomor(input.nomorTest);
        if (!n.valid) throw Object.assign(new Error('Nomor test administrator tidak sah (contoh: 081234567890).'), { kode: 'VALIDASI' });
        baru.nomorTest = n.nomor;
      }
    }
    this.db.setPengaturan('whatsapp.reminder', baru, oleh);
    return baru;
  }
}

class ReminderScheduler {
  /**
   * @param {object} o
   * @param {import('../serverDb').ServerDb} o.db
   * @param {{ panggil(op,args,ctx):Promise<any> }} o.bridge
   * @param {import('./WhatsAppService').WhatsAppService} o.service
   * @param {PengaturanWa} o.pengaturan
   * @param {any} [o.logger]
   * @param {() => number} [o.now]
   * @param {number} [o.tickMs]
   */
  constructor(o) {
    this.db = o.db;
    this.bridge = o.bridge;
    this.service = o.service;
    this.pengaturan = o.pengaturan;
    this.logger = o.logger || null;
    this.now = o.now || (() => Date.now());
    this.tickMs = o.tickMs || 60 * 1000;
    this.pemilik = o.pemilik || crypto.randomUUID();
    this.berjalan = false;
    this.timer = null;
    this.jedaSampai = 0;
    this.galatTerakhir = null;
    this.tickTerakhir = null;
  }

  start() {
    if (this.timer) return;
    this.pulihkanSending();
    this.timer = setInterval(() => this.tick().catch(() => undefined), this.tickMs);
    if (this.timer.unref) this.timer.unref();
    setTimeout(() => this.tick().catch(() => undefined), 5000).unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.db.run('DELETE FROM scheduler_lease WHERE nama = ? AND pemilik = ?', NAMA_LEASE, this.pemilik);
    } catch {
      /* db sudah ditutup */
    }
  }

  /** Baris yang tertinggal di 'sending' (aplikasi berhenti saat mengirim) → failed, TIDAK dikirim ulang (hindari pesan ganda). */
  pulihkanSending() {
    const t = new Date(this.now()).toISOString();
    this.db.run(
      "UPDATE whatsapp_notifications SET status = 'failed', error_kode = 'STATUS_TIDAK_PASTI', error_message = 'Aplikasi berhenti saat pesan sedang dikirim; status pengiriman tidak pasti sehingga tidak dikirim ulang otomatis.', updated_at = ? WHERE status = 'sending'",
      t
    );
  }

  ambilLease() {
    const t = this.now();
    return this.db.tx(() => {
      const r = this.db.get('SELECT * FROM scheduler_lease WHERE nama = ?', NAMA_LEASE);
      if (r && r.pemilik !== this.pemilik && Date.parse(r.sampai) > t) return false;
      this.db.run(
        'INSERT INTO scheduler_lease (nama, pemilik, sampai) VALUES (?,?,?) ON CONFLICT(nama) DO UPDATE SET pemilik = excluded.pemilik, sampai = excluded.sampai',
        NAMA_LEASE,
        this.pemilik,
        new Date(t + LEASE_MS).toISOString()
      );
      return true;
    });
  }

  async tick() {
    if (this.berjalan) return { dilewati: 'SEDANG_BERJALAN' };
    this.berjalan = true;
    try {
      if (!this.ambilLease()) return { dilewati: 'LEASE_DIPEGANG_INSTANCE_LAIN' };
      this.tickTerakhir = new Date(this.now()).toISOString();
      const p = this.pengaturan.baca();
      if (!p.aktif) return { dilewati: 'NONAKTIF' };
      const hariIni = tanggalLokal(this.now());
      const d = new Date(this.now());
      const menitSekarang = d.getHours() * 60 + d.getMinutes();
      const [jj, mm] = p.jamKirim.split(':').map(Number);
      let dibuat = null;
      if (menitSekarang >= jj * 60 + mm) {
        const sudah = this.db.get('SELECT selesai_at FROM scheduler_run WHERE tanggal = ?', hariIni);
        if (!sudah || !sudah.selesai_at) dibuat = await this.buatReminder(hariIni, p);
      }
      const kirim = await this.prosesAntrean(hariIni);
      return { dibuat, kirim };
    } catch (e) {
      this.galatTerakhir = { waktu: new Date(this.now()).toISOString(), pesan: String((e && e.message) || e).slice(0, 200) };
      if (this.logger) this.logger.warn('scheduler WhatsApp gagal', { pesan: e && e.message });
      return { galat: this.galatTerakhir.pesan };
    } finally {
      this.berjalan = false;
    }
  }

  /** Dipanggil manual oleh Admin: tetap idempoten (tidak menggandakan pesan). */
  async jalankanSekarang() {
    if (this.berjalan) return { dilewati: 'SEDANG_BERJALAN' };
    this.berjalan = true;
    try {
      if (!this.ambilLease()) return { dilewati: 'LEASE_DIPEGANG_INSTANCE_LAIN' };
      const p = this.pengaturan.baca();
      if (!p.aktif) return { dilewati: 'NONAKTIF', pesan: 'WhatsApp Reminder sedang nonaktif.' };
      // Admin menjalankan manual (mis. setelah memperbaiki token): cabut jeda konfigurasi.
      this.jedaSampai = 0;
      this.db.run(
        "UPDATE whatsapp_notifications SET berikutnya_at = NULL WHERE status = 'pending' AND error_kode IN ('TOKEN_DITOLAK','IZIN_DITOLAK','BELUM_DIKONFIGURASI','JARINGAN','LAYANAN_BELUM_SIAP')"
      );
      const hariIni = tanggalLokal(this.now());
      const dibuat = await this.buatReminder(hariIni, p);
      const kirim = await this.prosesAntrean(hariIni);
      return { dibuat, kirim };
    } finally {
      this.berjalan = false;
    }
  }

  /** Membuat baris reminder untuk HARI INI (setiap jenis yang aktif). */
  async buatReminder(hariIni, p) {
    const mulai = new Date(this.now()).toISOString();
    this.db.run('INSERT INTO scheduler_run (tanggal, mulai_at) VALUES (?,?) ON CONFLICT(tanggal) DO UPDATE SET mulai_at = excluded.mulai_at', hariIni, mulai);
    const ringkas = { pending: 0, skipped: 0, sudahAda: 0 };
    for (const [jenis, def] of Object.entries(JENIS)) {
      if (!p.jenis[jenis]) continue;
      const jatuhTempo = geserHari(hariIni, -def.offsetHari); // H-3: jatuh tempo = hari ini + 3
      const kandidat = await this.bridge.panggil('reminder.kandidat', { dari: jatuhTempo, sampai: jatuhTempo }, {});
      for (const k of kandidat) {
        const n = normalisasiNomor(k.nomorHp);
        let status = 'pending';
        let errKode = null;
        let errPesan = null;
        if (!n.valid) {
          status = 'skipped';
          errKode = 'NOMOR_TIDAK_SAH';
          errPesan = k.nomorHp ? `Nomor HP anggota tidak sah (${n.alasan}).` : 'Nomor HP anggota kosong.';
        } else if (k.statusAnggota === 'MENINGGAL') {
          status = 'skipped';
          errKode = 'ANGGOTA_MENINGGAL';
          errPesan = 'Status anggota MENINGGAL — reminder tidak dikirim.';
        }
        const t = new Date(this.now()).toISOString();
        const r = this.db.run(
          `INSERT OR IGNORE INTO whatsapp_notifications
             (id, anggota_id, pinjaman_id, jadwal_id, nama_anggota, nomor_pinjaman, angsuran_ke, tanggal_jatuh_tempo,
              jenis_notifikasi, tanggal_jadwal, nomor_tujuan, nomor_masked, sisa_tagihan, status, percobaan,
              error_kode, error_message, dibuat_oleh, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
          crypto.randomUUID(),
          k.anggotaId,
          k.pinjamanId,
          k.jadwalId,
          k.namaAnggota,
          k.nomorPinjaman,
          k.angsuranKe,
          k.tanggalJatuhTempo,
          jenis,
          hariIni,
          n.valid ? n.nomor : null,
          n.valid ? samarkanNomor(n.nomor) : null,
          k.sisaTagihan,
          status,
          errKode,
          errPesan,
          'SCHEDULER',
          t,
          t
        );
        if (Number(r.changes) === 0) ringkas.sudahAda++;
        else ringkas[status]++;
      }
    }
    this.db.run('UPDATE scheduler_run SET selesai_at = ?, ringkasan = ? WHERE tanggal = ?', new Date(this.now()).toISOString(), JSON.stringify(ringkas), hariIni);
    return ringkas;
  }

  async prosesAntrean(hariIni) {
    const ringkas = { sent: 0, failed: 0, skipped: 0, ditunda: 0 };
    if (this.now() < this.jedaSampai) return Object.assign(ringkas, { dijeda: true });
    const nowIso = new Date(this.now()).toISOString();
    // Kedaluwarsa: reminder hanya relevan pada tanggal jadwalnya (+1 hari toleransi offline).
    const batas = geserHari(hariIni, -1);
    const kd = this.db.run(
      "UPDATE whatsapp_notifications SET status = 'skipped', error_kode = 'KEDALUWARSA', error_message = 'Tidak terkirim sampai batas tanggal reminder (tanggal jadwal + 1 hari).', updated_at = ? WHERE status = 'pending' AND jenis_notifikasi <> 'TEST' AND tanggal_jadwal < ?",
      nowIso,
      batas
    );
    ringkas.skipped += Number(kd.changes || 0);
    const antre = this.db.all(
      "SELECT * FROM whatsapp_notifications WHERE status = 'pending' AND jenis_notifikasi <> 'TEST' AND (berikutnya_at IS NULL OR berikutnya_at <= ?) ORDER BY created_at ASC LIMIT 50",
      nowIso
    );
    for (const row of antre) {
      const hasil = await this.kirimBaris(row);
      if (hasil === 'JEDA') {
        ringkas.ditunda++;
        break;
      }
      ringkas[hasil] = (ringkas[hasil] || 0) + 1;
    }
    return ringkas;
  }

  _update(id, kolom) {
    const set = Object.keys(kolom).map((k) => `${k} = ?`);
    this.db.run(`UPDATE whatsapp_notifications SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(kolom), new Date(this.now()).toISOString(), id);
  }

  /** @returns {Promise<'sent'|'failed'|'skipped'|'ditunda'|'JEDA'>} */
  async kirimBaris(row) {
    // Klaim atomik: hanya satu pengirim yang dapat memindahkan pending → sending.
    const klaim = this.db.run("UPDATE whatsapp_notifications SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'", new Date(this.now()).toISOString(), row.id);
    if (Number(klaim.changes) !== 1) return 'ditunda';
    let tujuan = row.nomor_tujuan;
    let sisa = row.sisa_tagihan;
    if (row.jenis_notifikasi !== 'TEST') {
      let cek;
      try {
        cek = await this.bridge.panggil('reminder.cekJadwal', { jadwalId: row.jadwal_id }, {});
      } catch (e) {
        // KOPKU Desktop belum siap: kembalikan ke pending, coba lagi nanti (bukan kegagalan kirim).
        this._update(row.id, { status: 'pending', berikutnya_at: new Date(this.now() + JEDA_JARINGAN_MS).toISOString(), error_kode: 'LAYANAN_BELUM_SIAP', error_message: 'Data KOPKU belum dapat dibaca; akan dicoba lagi.' });
        return 'JEDA';
      }
      if (!cek.masihTertagih) {
        this._update(row.id, { status: 'skipped', error_kode: cek.alasan, error_message: `Tidak dikirim: ${cek.alasan.replace(/_/g, ' ').toLowerCase()} (sudah dibayar/lunas/tidak aktif).` });
        return 'skipped';
      }
      const n = normalisasiNomor(cek.nomorHp);
      if (!n.valid) {
        this._update(row.id, { status: 'skipped', error_kode: 'NOMOR_TIDAK_SAH', error_message: 'Nomor HP anggota saat ini tidak sah.' });
        return 'skipped';
      }
      tujuan = n.nomor;
      sisa = cek.sisaTagihan;
      if (tujuan !== row.nomor_tujuan || sisa !== row.sisa_tagihan) this._update(row.id, { nomor_tujuan: tujuan, nomor_masked: samarkanNomor(tujuan), sisa_tagihan: sisa });
    }
    const parameter =
      row.jenis_notifikasi === 'TEST'
        ? ['Administrator KOPKU', 'TEST', '0', tanggalPanjang(row.tanggal_jadwal), rupiah(0), 'pesan uji dari KOPKU (abaikan)']
        : [row.nama_anggota, row.nomor_pinjaman, String(row.angsuran_ke), tanggalPanjang(row.tanggal_jatuh_tempo), rupiah(sisa), JENIS[row.jenis_notifikasi].keterangan];
    const r = await this.service.sendTemplateMessage({ to: tujuan, parameters: parameter });
    const t = new Date(this.now()).toISOString();
    if (r.ok) {
      this._update(row.id, { status: 'sent', provider_message_id: r.messageId, sent_at: t, percobaan: row.percobaan + 1, error_kode: null, error_message: null, berikutnya_at: null });
      this.galatTerakhir = null;
      return 'sent';
    }
    if (r.kategori === 'KONFIGURASI') {
      this._update(row.id, { status: 'pending', berikutnya_at: new Date(this.now() + JEDA_KONFIGURASI_MS).toISOString(), error_kode: r.kode, error_message: r.pesan });
      this.jedaSampai = this.now() + JEDA_KONFIGURASI_MS;
      this.galatTerakhir = { waktu: t, kode: r.kode, pesan: r.pesan };
      return 'JEDA';
    }
    if (r.kategori === 'JARINGAN') {
      this._update(row.id, { status: 'pending', berikutnya_at: new Date(this.now() + JEDA_JARINGAN_MS).toISOString(), error_kode: r.kode, error_message: r.pesan });
      this.galatTerakhir = { waktu: t, kode: r.kode, pesan: r.pesan };
      return 'JEDA';
    }
    if (r.kategori === 'SEMENTARA') {
      const p = row.percobaan + 1;
      if (p >= MAKS_PERCOBAAN) {
        this._update(row.id, { status: 'failed', percobaan: p, error_kode: r.kode, error_message: `${r.pesan} (gagal setelah ${p} percobaan)`, berikutnya_at: null });
        return 'failed';
      }
      this._update(row.id, { status: 'pending', percobaan: p, berikutnya_at: new Date(this.now() + BACKOFF_MS[p - 1]).toISOString(), error_kode: r.kode, error_message: r.pesan });
      return 'ditunda';
    }
    // PERMANEN: nomor/template tidak sah → gagal tanpa diulang.
    this._update(row.id, { status: 'failed', percobaan: row.percobaan + 1, error_kode: r.kode, error_message: r.pesan, berikutnya_at: null });
    return 'failed';
  }

  /** Pesan uji HANYA ke nomor test administrator (bukan broadcast). */
  async kirimTest(nomor, oleh) {
    const n = normalisasiNomor(nomor);
    if (!n.valid) return { status: 'skipped', pesan: 'Nomor test tidak sah.' };
    const id = crypto.randomUUID();
    const t = new Date(this.now()).toISOString();
    this.db.run(
      `INSERT INTO whatsapp_notifications (id, jenis_notifikasi, tanggal_jadwal, nama_anggota, nomor_tujuan, nomor_masked, status, percobaan, dibuat_oleh, created_at, updated_at)
       VALUES (?, 'TEST', ?, 'Pesan Uji Administrator', ?, ?, 'pending', 0, ?, ?, ?)`,
      id,
      tanggalLokal(this.now()),
      n.nomor,
      samarkanNomor(n.nomor),
      oleh || null,
      t,
      t
    );
    const row = this.db.get('SELECT * FROM whatsapp_notifications WHERE id = ?', id);
    const h = await this.kirimBaris(row);
    const akhir = this.db.get('SELECT status, error_kode, error_message, provider_message_id FROM whatsapp_notifications WHERE id = ?', id);
    if (akhir.status === 'pending') {
      // Pesan uji tidak diantrikan ulang.
      this._update(id, { status: 'failed', berikutnya_at: null });
      akhir.status = 'failed';
    }
    return { status: akhir.status, hasil: h, kode: akhir.error_kode, pesan: akhir.error_message || (akhir.status === 'sent' ? 'Pesan uji terkirim ke Cloud API.' : null) };
  }

  daftarLog({ status = null, limit = 50, offset = 0 } = {}) {
    const where = status ? 'WHERE status = ?' : '';
    const p = status ? [status] : [];
    return this.db
      .all(
        `SELECT id, created_at, tanggal_jadwal, tanggal_jatuh_tempo, nama_anggota, nomor_pinjaman, angsuran_ke, jenis_notifikasi,
                nomor_masked, status, percobaan, sent_at, provider_message_id, error_kode, error_message
           FROM whatsapp_notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ...p,
        Math.min(200, limit),
        offset
      )
      .map((r) => Object.assign(r, { labelJenis: r.jenis_notifikasi === 'TEST' ? 'Uji' : JENIS[r.jenis_notifikasi].label }));
  }
  ringkasanStatus() {
    const o = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of this.db.all('SELECT status, COUNT(*) AS n FROM whatsapp_notifications GROUP BY status')) o[r.status] = r.n;
    return o;
  }
  status() {
    const lease = this.db.get('SELECT * FROM scheduler_lease WHERE nama = ?', NAMA_LEASE);
    return {
      berjalan: !!this.timer,
      pemilikLease: lease ? (lease.pemilik === this.pemilik ? 'INSTANCE_INI' : 'INSTANCE_LAIN') : null,
      tickTerakhir: this.tickTerakhir,
      dijedaSampai: this.jedaSampai > this.now() ? new Date(this.jedaSampai).toISOString() : null,
      galatTerakhir: this.galatTerakhir,
      runTerakhir: this.db.get('SELECT * FROM scheduler_run ORDER BY tanggal DESC LIMIT 1'),
    };
  }
}

module.exports = { ReminderScheduler, PengaturanWa, JENIS, tanggalLokal, geserHari, MAKS_PERCOBAAN };
