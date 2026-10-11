'use strict';
/**
 * KOPKU LAN SERVER — ADAPTER SERVICE DI RENDERER.
 *
 * Fungsi `pasangAdapter` di bawah ini DISUNTIKKAN (sebagai teks) ke dunia
 * utama jendela KOPKU Desktop oleh main process SAAT Server LAN atau WhatsApp Reminder ON.
 * Di Desktop Mode adapter ini tidak pernah dipasang.
 *
 * Tugasnya hanya MENERJEMAHKAN operasi API yang sudah divalidasi server
 * menjadi pemanggilan service KOPKU EXISTING (modul Metro yang sama yang
 * dipakai layar desktop). Tidak ada rumus pinjaman, angsuran, jasa, denda,
 * pelunasan, jurnal, SHU atau laporan di sini.
 *
 * Perlindungan konkurensi yang dipasang adapter:
 *   1. ANTRIAN TUNGGAL: semua operasi LAN dieksekusi satu per satu (FIFO).
 *   2. MUTEX TRANSAKSI: `SQLiteDatabase.prototype.withTransactionAsync`
 *      (shim desktop expo-sqlite) dibungkus mutex global, sehingga
 *      transaksi dari layar desktop dan dari LAN tidak pernah saling
 *      menyisip pada koneksi SQLite yang sama. Isi transaksi (BEGIN →
 *      tugas → COMMIT/ROLLBACK) tetap implementasi asli.
 *   3. CEK VERSI (optimistic concurrency) sebelum bayar angsuran,
 *      pelunasan dan ubah anggota: data yang dilihat klien harus sama
 *      dengan data authoritative saat ini, jika tidak → KONFLIK.
 *
 * Fungsi ini harus mandiri (tanpa closure ke modul Node), karena dikirim
 * sebagai teks lewat `webContents.executeJavaScript`.
 */
function pasangAdapter(ids, opsi) {
  'use strict';
  const g = globalThis;
  opsi = opsi || {};
  if (g.__kopkuServerAdapter && g.__kopkuServerAdapter.idsKey === JSON.stringify(ids)) return g.__kopkuServerAdapter;

  const TX_TUNGGU_MS = opsi.txTungguMs || 30000;
  const OP_BATAS_MS = opsi.opBatasMs || 60000;

  function galat(kode, pesan) {
    const e = new Error(pesan || kode);
    e.kode = kode;
    return e;
  }
  function R(k) {
    const id = ids[k];
    if (typeof id !== 'number' || typeof g.__r !== 'function') throw galat('LAYANAN_TIDAK_TERSEDIA', `Layanan ${k} tidak tersedia pada versi KOPKU ini.`);
    return g.__r(id);
  }
  async function db() {
    return R('db').getDb();
  }

  // ---------------------------------------------------------------- mutex
  const mutex = { aktif: false, antre: [] };
  function ambilKunci() {
    return new Promise((resolve, reject) => {
      const masuk = () => {
        mutex.aktif = true;
        resolve(lepas);
      };
      let selesai = false;
      const lepas = () => {
        if (selesai) return;
        selesai = true;
        const berikut = mutex.antre.shift();
        if (berikut) berikut.masuk();
        else mutex.aktif = false;
      };
      if (!mutex.aktif) return masuk();
      const entri = {
        masuk: () => {
          clearTimeout(entri.t);
          masuk();
        },
      };
      entri.t = setTimeout(() => {
        const i = mutex.antre.indexOf(entri);
        if (i >= 0) mutex.antre.splice(i, 1);
        reject(galat('DB_SIBUK', 'Database sedang dipakai transaksi lain terlalu lama. Silakan coba lagi.'));
      }, TX_TUNGGU_MS);
      mutex.antre.push(entri);
    });
  }
  const Proto = R('sqliteShim').SQLiteDatabase.prototype;
  if (!Proto.__kopkuMutexTerpasang) {
    const asli = Proto.withTransactionAsync;
    Proto.withTransactionAsync = async function (task) {
      const lepas = await ambilKunci();
      try {
        return await asli.call(this, task);
      } finally {
        lepas();
      }
    };
    Object.defineProperty(Proto, '__kopkuMutexTerpasang', { value: true });
    Object.defineProperty(Proto, '__kopkuWithTransactionAsli', { value: asli });
  }

  // ---------------------------------------------------------------- antrian
  let rantai = Promise.resolve();
  let jumlahAntre = 0;
  function antre(fn) {
    jumlahAntre++;
    const p = rantai.then(() => {
      let t;
      return Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, rej) => {
          t = setTimeout(() => rej(galat('TIMEOUT', 'Operasi melebihi batas waktu.')), OP_BATAS_MS);
        }),
      ]).finally(() => clearTimeout(t));
    });
    rantai = p.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      jumlahAntre--;
    });
    return p;
  }

  // ---------------------------------------------------------------- util
  const versiJadwal = (r) => [r.pokok_terbayar, r.jasa_terbayar, r.denda_terbayar, r.status].join('|');
  function userAman(u) {
    return u ? { id: u.id, nama: u.nama, username: u.username, role: u.role, aktif: !!u.aktif } : null;
  }

  // ---------------------------------------------------------------- operasi
  const OPS = {
    async 'sistem.status'() {
      const out = { adapter: true, siap: false, setupSelesai: false, lisensiValid: false, schemaVersion: null, koperasi: null };
      const d = await db();
      const v = await d.getFirstAsync('SELECT version FROM schema_meta WHERE id = 1');
      out.schemaVersion = v ? Number(v.version) : null;
      out.setupSelesai = !!(await R('koperasi').isSetupComplete());
      try {
        out.lisensiValid = !!(await R('lisensi').hasValidLocalLicense());
      } catch {
        out.lisensiValid = false;
      }
      const k = out.setupSelesai ? await R('koperasi').getActiveKoperasi() : null;
      out.koperasi = k ? { nama: k.nama, tahunBuku: k.tahun_buku_aktif } : null;
      out.siap = true;
      out.antrian = jumlahAntre;
      return out;
    },

    async 'auth.verifikasi'(a) {
      const ph = R('pinHash');
      const d = await db();
      const u = await d.getFirstAsync(
        'SELECT id, nama, username, role, aktif, password_hash, password_salt, password_hash_versi FROM app_user WHERE username = ? AND aktif = 1',
        String(a.username)
      );
      if (!u || !u.password_hash || !u.password_salt) {
        // Samakan waktu respons untuk username tak dikenal (anti enumerasi).
        await ph.verifikasiPinAsync({ pin: String(a.password), salt: 'kopku-lan-dummy', hashTersimpan: '0'.repeat(64), versiTersimpan: 2 });
        return { ok: false, alasan: 'KREDENSIAL' };
      }
      const versi = Number(u.password_hash_versi) === 2 ? 2 : 1;
      const h = await ph.verifikasiPinAsync({ pin: String(a.password), salt: u.password_salt, hashTersimpan: u.password_hash, versiTersimpan: versi });
      if (!h.cocok) return { ok: false, alasan: 'KREDENSIAL' };
      // Hash warisan (SHA-256 satu putaran) TIDAK diterima lewat LAN dan
      // TIDAK diperbarui dari LAN: user cukup masuk sekali di KOPKU Desktop
      // (desktop menaikkannya otomatis ke scrypt).
      if (versi !== 2) return { ok: false, alasan: 'HASH_LAMA' };
      return { ok: true, user: userAman(u) };
    },

    async 'auth.user'(a) {
      const d = await db();
      return userAman(await d.getFirstAsync('SELECT id, nama, username, role, aktif FROM app_user WHERE id = ?', String(a.userId)));
    },

    async 'izin.cek'(a) {
      return !!(await R('izin').hasPermission(String(a.userId), String(a.resource), String(a.action)));
    },

    /** Peta izin lengkap user (12 resource × 5 aksi) dalam satu panggilan — sumber: hasPermission existing. */
    async 'izin.peta'(a) {
      const K = R('izinKonstanta');
      const out = {};
      for (const res of K.RESOURCES) {
        out[res] = {};
        for (const act of ['view', 'create', 'edit', 'approve', 'export']) out[res][act] = !!(await R('izin').hasPermission(String(a.userId), res, act));
      }
      return out;
    },

    async 'izin.matriks'() {
      return R('izin').getPermissionMatrix();
    },

    async 'user.daftar'(_a, ctx) {
      const list = await R('userAdmin').listUsers(ctx.userId);
      return list.map((u) => ({ id: u.id, nama: u.nama, username: u.username, role: u.role, aktif: !!u.aktif }));
    },

    async dashboard() {
      const ang = R('anggota');
      const pj = R('pinjaman');
      const aktif = await ang.listAnggota({ status: 'AKTIF', semuaData: true });
      const pinjamanAktif = await pj.listPinjaman({ statusKategori: 'AKTIF', limit: 1000000, offset: 0 });
      const tunggakan = await pj.listTunggakan();
      return {
        anggotaAktif: aktif.length,
        pinjamanAktif: pinjamanAktif.length,
        sisaPiutang: pinjamanAktif.reduce((s, p) => s + (Number(p.sisaPiutang) || 0), 0),
        jumlahTunggakan: tunggakan.length,
        nilaiTunggakan: tunggakan.reduce((s, t) => s + (Number(t.sisaTagihan) || 0), 0),
      };
    },

    async 'anggota.daftar'(a) {
      return R('anggota').listAnggota({ search: a.search || undefined, status: a.status || undefined, limit: a.limit, offset: a.offset });
    },
    async 'anggota.detail'(a) {
      const ang = await R('anggota').getAnggotaById(a.id);
      if (!ang) throw galat('TIDAK_DITEMUKAN', 'Anggota tidak ditemukan.');
      const d = await db();
      const v = await d.getFirstAsync('SELECT updated_at FROM anggota WHERE id = ?', a.id);
      const saldo = await R('simpanan').getRingkasanSaldoSimpananAnggota(a.id);
      const pinjaman = await R('pinjaman').listPinjaman({ anggotaId: a.id, limit: 200, offset: 0 });
      return { anggota: ang, versi: v ? v.updated_at : null, saldoSimpanan: saldo, pinjaman };
    },
    async 'anggota.buat'(a, ctx) {
      return R('anggota').createAnggota(ctx.userId, a.data);
    },
    async 'anggota.ubah'(a, ctx) {
      const svc = R('anggota');
      const d = await db();
      const v = await d.getFirstAsync('SELECT updated_at FROM anggota WHERE id = ?', a.id);
      if (!v) throw galat('TIDAK_DITEMUKAN', 'Anggota tidak ditemukan.');
      if (v.updated_at !== a.versi) throw galat('KONFLIK', 'Data anggota sudah diubah pengguna lain. Muat ulang lalu ulangi perubahan.');
      const lama = await svc.getAnggotaById(a.id);
      // updateAnggota existing menulis SEMUA kolom: gabungkan dengan data
      // authoritative agar kolom yang tidak dikirim klien tidak terhapus.
      const data = Object.assign({}, lama, a.data);
      delete data.id;
      delete data.nomorAnggota;
      await svc.updateAnggota(ctx.userId, a.id, data);
      return { id: a.id };
    },

    async 'pinjaman.daftar'(a) {
      return R('pinjaman').listPinjaman({
        search: a.search || undefined,
        status: a.status || undefined,
        statusKategori: a.statusKategori || undefined,
        anggotaId: a.anggotaId || undefined,
        limit: a.limit,
        offset: a.offset,
      });
    },
    async 'pinjaman.detail'(a) {
      const pj = R('pinjaman');
      const detail = await pj.getPinjamanDetail(a.id);
      if (!detail) throw galat('TIDAK_DITEMUKAN', 'Pinjaman tidak ditemukan.');
      const jadwal = await pj.getJadwalAngsuran(a.id);
      const d = await db();
      const rows = await d.getAllAsync('SELECT id, pokok_terbayar, jasa_terbayar, denda_terbayar, status FROM angsuran_jadwal WHERE pinjaman_id = ?', a.id);
      const versi = new Map(rows.map((r) => [r.id, versiJadwal(r)]));
      const tertagih = new Set(R('statusJadwal').CURRENT_SCHEDULE_STATUSES);
      const v = await d.getFirstAsync('SELECT updated_at FROM pinjaman WHERE id = ?', a.id);
      return {
        versi: v ? v.updated_at : null,
        pinjaman: detail,
        jadwal: jadwal.map((j) => Object.assign({}, j, { versi: versi.get(j.id), bisaDibayar: tertagih.has(j.status) && detail.status === 'AKTIF' })),
      };
    },

    async 'angsuran.bayar'(a, ctx) {
      const d = await db();
      const j = await d.getFirstAsync('SELECT id, pinjaman_id, pokok_terbayar, jasa_terbayar, denda_terbayar, status FROM angsuran_jadwal WHERE id = ?', a.jadwalId);
      if (!j || j.pinjaman_id !== a.pinjamanId) throw galat('TIDAK_DITEMUKAN', 'Jadwal angsuran tidak ditemukan pada pinjaman ini.');
      if (versiJadwal(j) !== a.versiJadwal) throw galat('KONFLIK', 'Angsuran ini baru saja berubah (mungkin sudah dibayar pengguna lain). Muat ulang data sebelum membayar.');
      return R('pinjaman').bayarAngsuran({
        pinjamanId: a.pinjamanId,
        jadwalId: a.jadwalId,
        tanggal: a.tanggal,
        nominal: a.nominal,
        sumberDana: a.sumberDana,
        bankAccountId: a.bankAccountId || undefined,
        createdBy: ctx.userId,
      });
    },

    async 'pelunasan.hitung'(a) {
      const d = await db();
      return R('pinjaman').hitungTotalPelunasan(d, a.pinjamanId, a.tanggal, {
        metodeJasaPelunasan: a.metodeJasaPelunasan || undefined,
        penaltiPelunasan: a.penaltiPelunasan,
        administrasiPelunasan: a.administrasiPelunasan,
      });
    },
    async 'pelunasan.proses'(a, ctx) {
      const pj = R('pinjaman');
      const d = await db();
      const hitung = await pj.hitungTotalPelunasan(d, a.pinjamanId, a.tanggal, {
        metodeJasaPelunasan: a.metodeJasaPelunasan || undefined,
        penaltiPelunasan: a.penaltiPelunasan,
        administrasiPelunasan: a.administrasiPelunasan,
      });
      if (hitung.totalPelunasan !== a.totalDilihat) {
        throw galat('KONFLIK', 'Total pelunasan berubah sejak dihitung (ada transaksi lain). Hitung ulang sebelum memproses.');
      }
      return pj.lunasiPinjaman({
        pinjamanId: a.pinjamanId,
        tanggal: a.tanggal,
        metodeJasaPelunasan: a.metodeJasaPelunasan || undefined,
        penaltiPelunasan: a.penaltiPelunasan,
        administrasiPelunasan: a.administrasiPelunasan,
        sumberDana: a.sumberDana,
        bankAccountId: a.bankAccountId || undefined,
        createdBy: ctx.userId,
      });
    },

    async 'simpanan.setor'(a, ctx) {
      return R('simpanan').setorSimpanan({
        anggotaId: a.anggotaId,
        jenis: a.jenis,
        tanggal: a.tanggal,
        periode: a.periode || undefined,
        nominal: a.nominal,
        sumberDana: a.sumberDana,
        bankAccountId: a.bankAccountId || undefined,
        keterangan: a.keterangan || undefined,
        createdBy: ctx.userId,
      });
    },

    async 'rekening.daftar'() {
      const list = await R('kasBank').listRekening();
      return list.filter((r) => r.aktif).map((r) => ({ jenis: r.jenis, id: r.id, nama: r.nama }));
    },

    async 'laporan.tunggakan'() {
      return R('pinjaman').listTunggakan();
    },
    async 'laporan.posisi'(a) {
      return R('laporan').getPosisiKeuangan(await db(), a.tanggal);
    },
    async 'laporan.lhu'(a) {
      return R('laporan').getLHU(await db(), a.mulai, a.selesai);
    },

    // ================================================================
    // MENU LAN LENGKAP (LAN-WhatsApp3). Setiap operasi memanggil service
    // KOPKU yang SAMA dengan layar desktop. Service tetap memeriksa izin
    // sendiri (requirePermission) atas nama user LAN (ctx.userId).
    // ================================================================
    async 'dashboard.ringkas'(a) {
      const b = a.bagian || {};
      const out = {};
      if (b.anggota) {
        const aktif = await R('anggota').listAnggota({ status: 'AKTIF', semuaData: true });
        out.anggotaAktif = aktif.length;
      }
      if (b.simpanan) {
        const saldo = await R('simpanan').listSaldoSimpananSemuaAnggota();
        out.simpanan = saldo.reduce(
          (t, x) => ({ pokok: t.pokok + x.pokok, wajib: t.wajib + x.wajib, sukarela: t.sukarela + x.sukarela, total: t.total + x.total }),
          { pokok: 0, wajib: 0, sukarela: 0, total: 0 }
        );
      }
      if (b.pinjaman) {
        const pj = R('pinjaman');
        const aktif = await pj.listPinjaman({ statusKategori: 'AKTIF', limit: 1000000, offset: 0 });
        const pengajuan = await pj.listPinjaman({ statusKategori: 'BELUM_AKTIF', limit: 1000000, offset: 0 });
        const tunggakan = await pj.listTunggakan();
        out.pinjaman = {
          aktif: aktif.length,
          sisaPiutang: aktif.reduce((t, p) => t + (Number(p.sisaPiutang) || 0), 0),
          menungguPencairan: pengajuan.length,
          jumlahTunggakan: tunggakan.length,
          nilaiTunggakan: tunggakan.reduce((t, x) => t + (Number(x.sisaTagihan) || 0), 0),
          tunggakanTeratas: tunggakan
            .slice()
            .sort((x, y) => (y.hariTerlambat || 0) - (x.hariTerlambat || 0))
            .slice(0, 5)
            .map((x) => ({ pinjamanId: x.pinjamanId, nomorPinjaman: x.nomorPinjaman, namaAnggota: x.namaAnggota, hariTerlambat: x.hariTerlambat, sisaTagihan: x.sisaTagihan })),
        };
        out.kolektibilitas = await R('kolektibilitas').getRingkasanAging({});
      }
      if (b.kas) {
        const rek = await R('kasBank').listRekening();
        out.rekening = rek.filter((r) => r.aktif).map((r) => ({ jenis: r.jenis, id: r.id, nama: r.nama, saldo: r.saldo }));
      }
      if (b.history) {
        out.transaksiTerakhir = (await R('history').listHistoryTransaksi({ limit: 8, offset: 0 })).map((x) => ({
          journalId: x.journalId,
          nomorTransaksi: x.nomorTransaksi,
          tanggal: x.tanggal,
          jenisLabel: x.jenisLabel,
          deskripsi: x.deskripsi,
          nominal: x.nominal,
          status: x.status,
          createdByNama: x.createdByNama,
        }));
      }
      return out;
    },

    // ---- simpanan
    async 'simpanan.histori'(a) {
      return R('simpanan').listSimpananHistori({ anggotaId: a.anggotaId || undefined, jenis: a.jenis || undefined, limit: a.limit, offset: a.offset });
    },
    async 'simpanan.detail'(a) {
      const x = await R('simpanan').getSimpananDetailById(a.id);
      if (!x) throw galat('TIDAK_DITEMUKAN', 'Transaksi simpanan tidak ditemukan.');
      return x;
    },
    async 'simpanan.saldoSemua'(a) {
      const list = await R('simpanan').listSaldoSimpananSemuaAnggota();
      const q = String(a.search || '').toLowerCase();
      return q ? list.filter((x) => `${x.nomorAnggota} ${x.namaAnggota}`.toLowerCase().includes(q)) : list;
    },
    async 'simpanan.sukarelaTersedia'(a) {
      const list = await R('simpanan').listAnggotaSaldoSukarelaTersedia();
      const q = String(a.search || '').toLowerCase();
      return (q ? list.filter((x) => `${x.nomorAnggota} ${x.namaLengkap}`.toLowerCase().includes(q)) : list).slice(0, 50);
    },
    async 'simpanan.tarik'(a, ctx) {
      return R('simpanan').tarikSimpananSukarela({
        anggotaId: a.anggotaId,
        tanggal: a.tanggal,
        nominal: a.nominal,
        sumberDana: a.sumberDana,
        bankAccountId: a.bankAccountId || undefined,
        keterangan: a.keterangan || undefined,
        createdBy: ctx.userId,
      });
    },
    async 'berjangka.daftar'(a) {
      const list = await R('berjangka').listSimpananBerjangkaDaftar(a.anggotaId || undefined);
      return list.map((x) => ({
        id: x.id,
        nomorTransaksi: x.nomorTransaksi,
        anggotaId: x.anggotaId,
        namaAnggota: x.namaAnggota || x.anggotaNama || null,
        nomorAnggota: x.nomorAnggota || x.anggotaNomor || null,
        tanggalMulai: x.tanggalMulai,
        tanggalJatuhTempo: x.tanggalJatuhTempo,
        nominal: x.nominal,
        tenorBulan: x.tenorBulan,
        sukuBungaPerTahun: x.sukuBungaPerTahun,
        status: x.status,
        bungaTerakru: x.bungaTerakru,
        bungaDibayar: x.bungaDibayar,
        tanggalPencairan: x.tanggalPencairan,
      }));
    },

    // ---- pinjaman: pengajuan, simulasi, pencairan, pembatalan
    async 'pinjaman.simulasi'(a) {
      const baris = R('jadwalHitung').hitungJadwalAngsuran({ jumlahPinjaman: a.jumlahPinjaman, tenor: a.tenor, persentaseJasaPerPeriode: a.persentaseJasa, metode: a.metodeJasa });
      return baris;
    },
    async 'pinjaman.ajukan'(a, ctx) {
      return R('pinjaman').ajukanPinjaman(Object.assign({}, a.data, { createdBy: ctx.userId }));
    },
    async 'pinjaman.cairkan'(a, ctx) {
      const d = await db();
      const p = await d.getFirstAsync('SELECT status, updated_at FROM pinjaman WHERE id = ?', a.pinjamanId);
      if (!p) throw galat('TIDAK_DITEMUKAN', 'Pinjaman tidak ditemukan.');
      if (a.versi && p.updated_at !== a.versi) throw galat('KONFLIK', 'Data pinjaman baru saja berubah. Muat ulang sebelum mencairkan.');
      await R('pinjaman').cairkanPinjaman({
        pinjamanId: a.pinjamanId,
        sumberDana: a.sumberDana,
        bankAccountId: a.bankAccountId || undefined,
        tanggalPencairan: a.tanggalPencairan,
        approvedBy: ctx.userId,
      });
      return { id: a.pinjamanId };
    },
    async 'pinjaman.batalkan'(a, ctx) {
      await R('pinjaman').batalkanPinjaman({ pinjamanId: a.pinjamanId, alasan: a.alasan, actingUserId: ctx.userId });
      return { id: a.pinjamanId };
    },
    async 'pinjaman.versi'(a) {
      const d = await db();
      const p = await d.getFirstAsync('SELECT updated_at FROM pinjaman WHERE id = ?', a.id);
      return p ? p.updated_at : null;
    },

    // ---- kas & bank
    async 'kas.rekening'() {
      return (await R('kasBank').listRekening()).map((r) => ({ jenis: r.jenis, id: r.id, nama: r.nama, saldo: r.saldo, aktif: r.aktif, nomorRekening: r.nomorRekening || null, namaPemilik: r.namaPemilik || null }));
    },
    async 'kas.riwayat'(a) {
      const list = await R('kasBank').listRiwayatTransaksi({
        jenis: a.jenis || undefined,
        bankAccountId: a.bankAccountId || undefined,
        tanggalMulai: a.tanggalMulai || undefined,
        tanggalSelesai: a.tanggalSelesai || undefined,
        limit: a.limit,
        offset: a.offset,
      });
      return list;
    },
    async 'kas.opsi'() {
      const pendapatan = await R('pendapatanLain').listAkunPendapatanLainnya();
      const ref = await R('dataReferensi').listDataReferensi('BEBAN_LAIN');
      const beban = R('kategoriBeban').susunOpsiKategoriBeban(ref);
      return { pendapatan, beban: beban.map((o) => ({ key: o.key, label: o.label, sumber: o.sumber, keterangan: o.keterangan || null })) };
    },
    async 'kas.masuk'(a, ctx) {
      const opsi = await R('pendapatanLain').listAkunPendapatanLainnya();
      if (!opsi.some((o) => o.accountId === a.accountId)) throw galat('VALIDASI', 'Akun pendapatan tidak dapat dipakai lewat menu ini.');
      return R('pendapatanLain').tambahTransaksiPendapatan({
        jenis: a.jenis,
        bankAccountId: a.jenis === 'BANK' ? a.bankAccountId : undefined,
        tanggal: a.tanggal,
        nominal: a.nominal,
        accountId: a.accountId,
        kategori: a.kategori || undefined,
        keterangan: a.keterangan || undefined,
        createdBy: ctx.userId,
      });
    },
    async 'kas.keluar'(a, ctx) {
      const ref = await R('dataReferensi').listDataReferensi('BEBAN_LAIN');
      const o = R('kategoriBeban').susunOpsiKategoriBeban(ref).find((x) => x.key === a.kategoriKey);
      if (!o) throw galat('VALIDASI', 'Kategori beban tidak dikenal. Muat ulang halaman.');
      // Resolusi akun SAMA dengan layar Beban di desktop.
      const akun = R('akun');
      const e = o.sumber === 'KATEGORI' ? (await akun.listAccounts({ search: o.akunNama })).find((x) => x.nama === o.akunNama) : (await akun.listAccounts({ search: o.akunKode })).find((x) => x.kode === o.akunKode);
      if (!e) throw galat('VALIDASI', o.sumber === 'KATEGORI' ? `Akun "${o.akunNama}" tidak ditemukan di Chart of Accounts.` : `Akun beban lain-lain (${o.akunKode}) tidak ditemukan di Chart of Accounts.`);
      return R('kasBank').catatPengeluaran({
        jenis: a.jenis,
        bankAccountId: a.jenis === 'BANK' ? a.bankAccountId : undefined,
        tanggal: a.tanggal,
        nominal: a.nominal,
        akunLawanId: e.id,
        kategori: o.label,
        keterangan: a.keterangan || undefined,
        createdBy: ctx.userId,
      });
    },
    async 'kas.transfer'(a, ctx) {
      return R('kasBank').transferAntarRekening({
        sumberJenis: a.sumberJenis,
        sumberBankAccountId: a.sumberJenis === 'BANK' ? a.sumberBankAccountId : undefined,
        tujuanJenis: a.tujuanJenis,
        tujuanBankAccountId: a.tujuanJenis === 'BANK' ? a.tujuanBankAccountId : undefined,
        tanggal: a.tanggal,
        nominal: a.nominal,
        keterangan: a.keterangan || undefined,
        createdBy: ctx.userId,
      });
    },

    // ---- data
    async 'akun.daftar'(a) {
      return R('akun').listAllAccounts({ search: a.search || undefined, status: a.status || undefined });
    },
    async 'personel.daftar'(a) {
      return (await R('personel').listPersonel({ jenisPersonel: a.jenisPersonel || undefined })).map((x) => ({
        id: x.id,
        nama: x.nama,
        jabatan: x.jabatan || null,
        jenisPersonel: x.jenisPersonel,
        statusAktif: x.statusAktif,
        tanggalMulaiJabatan: x.tanggalMulaiJabatan || null,
        tanggalBerakhirJabatan: x.tanggalBerakhirJabatan || null,
        nomorTelepon: x.nomorTelepon || null,
      }));
    },

    // ---- laporan lengkap (BACA SAJA)
    async 'laporan.labaRugi'(a) {
      return R('laporan').getLabaRugi(await db(), a.mulai, a.selesai);
    },
    async 'laporan.arusKas'(a) {
      return R('laporan').getArusKas(await db(), a.mulai, a.selesai);
    },
    async 'laporan.ekuitas'(a) {
      return R('laporan').getPerubahanEkuitas(await db(), a.mulai, a.selesai);
    },
    async 'laporan.neracaSaldo'(a) {
      return R('laporan').getTrialBalance(await db(), a.tanggal);
    },
    async 'laporan.bukuBesar'(a) {
      const d = await db();
      const ak = await d.getFirstAsync('SELECT id, kode, nama, kategori, normal_balance FROM account WHERE id = ?', a.accountId);
      if (!ak) throw galat('TIDAK_DITEMUKAN', 'Akun tidak ditemukan.');
      const baris = await R('laporan').getLedger(d, a.accountId, { tanggalMulai: a.mulai, tanggalSelesai: a.selesai });
      return { akun: { id: ak.id, kode: ak.kode, nama: ak.nama, kategori: ak.kategori, normalBalance: ak.normal_balance }, baris };
    },
    async 'laporan.kolektibilitas'() {
      const d = await db();
      return { ringkasan: await R('kolektibilitas').getRingkasanAging({}), rincian: await R('kolektibilitas').getKlasifikasiPinjamanAktif(d, {}) };
    },
    async 'history.daftar'(a) {
      // listHistoryTransaksi hanya mengenal LIMIT → ambil sampai halaman ini lalu potong.
      const offset = a.offset || 0;
      const list = await R('history').listHistoryTransaksi({
        search: a.search || undefined,
        tanggalMulai: a.tanggalMulai || undefined,
        tanggalSelesai: a.tanggalSelesai || undefined,
        jenis: a.jenis ? [a.jenis] : undefined,
        limit: offset + (a.limit || 50),
      });
      return list.slice(offset);
    },
    async 'history.detail'(a) {
      const x = await R('history').getHistoryDetail(a.id);
      if (!x) throw galat('TIDAK_DITEMUKAN', 'Transaksi tidak ditemukan.');
      return x;
    },
    async 'history.jenis'() {
      return R('history').listJenisTransaksiTersedia();
    },
    async 'shu.riwayat'() {
      return R('shu').getRiwayatSHU();
    },
    async 'shu.anggota'(a) {
      return R('shu').getShuAnggotaList(a.id);
    },

    // ---- pengaturan (BACA SAJA)
    async 'izin.lengkap'() {
      const L = R('labelIzin');
      return { matriks: await R('izin').getPermissionMatrix(), roleLabel: L.ROLE_LABEL, resourceLabel: L.RESOURCE_LABEL, aksiLabel: L.AKSI_LABEL, resourceKeterangan: L.RESOURCE_KETERANGAN || null };
    },

    // ---- data reminder WhatsApp (BACA SAJA; definisi status & sisa tagihan
    //      memakai fragmen SQL dan rumus listTunggakan() existing)
    async 'reminder.kandidat'(a) {
      const d = await db();
      const sj = R('statusJadwal');
      const rows = await d.getAllAsync(
        `SELECT aj.id AS jadwal_id, aj.pinjaman_id, aj.nomor_angsuran, aj.tanggal_jatuh_tempo,
                aj.total, aj.pokok_terbayar, aj.jasa_terbayar, aj.status AS status_jadwal,
                p.nomor_pinjaman, p.status AS status_pinjaman,
                a.id AS anggota_id, a.nama_lengkap, a.nomor_hp, a.status AS status_anggota
           FROM angsuran_jadwal aj
           JOIN pinjaman p ON p.id = aj.pinjaman_id
           JOIN anggota a ON a.id = p.anggota_id
          WHERE p.status = 'AKTIF' AND ${sj.sqlJadwalCurrent('aj')}
            AND aj.tanggal_jatuh_tempo >= ? AND aj.tanggal_jatuh_tempo <= ?
          ORDER BY aj.tanggal_jatuh_tempo ASC`,
        a.dari,
        a.sampai
      );
      return rows.map((r) => ({
        jadwalId: r.jadwal_id,
        pinjamanId: r.pinjaman_id,
        nomorPinjaman: r.nomor_pinjaman,
        angsuranKe: r.nomor_angsuran,
        tanggalJatuhTempo: String(r.tanggal_jatuh_tempo).slice(0, 10),
        sisaTagihan: r.total - r.pokok_terbayar - r.jasa_terbayar,
        anggotaId: r.anggota_id,
        namaAnggota: r.nama_lengkap,
        nomorHp: r.nomor_hp,
        statusAnggota: r.status_anggota,
      }));
    },
    async 'reminder.cekJadwal'(a) {
      const d = await db();
      const sj = R('statusJadwal');
      const r = await d.getFirstAsync(
        `SELECT aj.status AS status_jadwal, aj.total, aj.pokok_terbayar, aj.jasa_terbayar, p.status AS status_pinjaman, a.nomor_hp
           FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id JOIN anggota a ON a.id = p.anggota_id
          WHERE aj.id = ?`,
        a.jadwalId
      );
      if (!r) return { masihTertagih: false, alasan: 'JADWAL_TIDAK_ADA' };
      if (r.status_pinjaman !== 'AKTIF') return { masihTertagih: false, alasan: `PINJAMAN_${r.status_pinjaman}` };
      if (!sj.CURRENT_SCHEDULE_STATUSES.includes(r.status_jadwal)) return { masihTertagih: false, alasan: `ANGSURAN_${r.status_jadwal}` };
      return { masihTertagih: true, sisaTagihan: r.total - r.pokok_terbayar - r.jasa_terbayar, nomorHp: r.nomor_hp };
    },
  };

  // Operasi yang hanya membaca tetap lewat antrian agar tidak membaca
  // keadaan setengah-jadi di tengah transaksi LAN lain pada koneksi yang sama.
  function klasifikasi(e) {
    if (!e) return { kode: 'INTERNAL', pesan: 'Terjadi kesalahan.' };
    if (e.kode) return { kode: e.kode, pesan: String(e.message).slice(0, 300) };
    const nama = e.name || '';
    const pesan = String(e.message || '');
    if (nama === 'UnauthorizedError' || nama === 'UserNonaktifError' || nama === 'HanyaAdminError') return { kode: 'IZIN', pesan: pesan.slice(0, 300) };
    if (/database is locked|SQLITE_BUSY|database table is locked/i.test(pesan)) return { kode: 'DB_SIBUK', pesan: 'Database sedang dikunci proses lain. Silakan coba lagi.' };
    if (/SQLITE|constraint|no such|syntax error|database|AccessClosed|\[DatabaseIntegrity\]|\[DeferredIncome\]|undefined|null|is not a function/i.test(pesan)) {
      return { kode: 'INTERNAL', pesan: 'Terjadi kesalahan internal pada server KOPKU.' };
    }
    if (/cannot start a transaction|within a transaction/i.test(pesan)) return { kode: 'DB_SIBUK', pesan: 'Database sedang sibuk. Silakan coba lagi.' };
    return { kode: 'VALIDASI', pesan: pesan.slice(0, 300) || 'Permintaan ditolak.' };
  }

  async function jalankan(op, args, ctx) {
    const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
    if (!fn) return { ok: false, error: { kode: 'OP_TIDAK_DIKENAL', pesan: 'Operasi tidak dikenal.' } };
    try {
      const value = await antre(() => fn(args || {}, ctx || {}));
      return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (e) {
      return { ok: false, error: klasifikasi(e), detailInternal: opsi.sertakanDetail ? String((e && e.stack) || e) : undefined };
    }
  }

  // Verifikasi seluruh layanan yang dibutuhkan ada SEBELUM mendaftar.
  const hilang = [];
  const butuh = {
    db: ['getDb'],
    sqliteShim: ['SQLiteDatabase'],
    izin: ['hasPermission', 'getPermissionMatrix'],
    pinHash: ['verifikasiPinAsync'],
    lisensi: ['hasValidLocalLicense'],
    koperasi: ['getActiveKoperasi', 'isSetupComplete'],
    anggota: ['listAnggota', 'getAnggotaById', 'createAnggota', 'updateAnggota'],
    pinjaman: ['listPinjaman', 'getPinjamanDetail', 'getJadwalAngsuran', 'bayarAngsuran', 'hitungTotalPelunasan', 'lunasiPinjaman', 'listTunggakan', 'ajukanPinjaman', 'cairkanPinjaman', 'batalkanPinjaman'],
    statusJadwal: ['sqlJadwalCurrent', 'CURRENT_SCHEDULE_STATUSES'],
    simpanan: ['setorSimpanan', 'getRingkasanSaldoSimpananAnggota', 'tarikSimpananSukarela', 'listSimpananHistori', 'listSaldoSimpananSemuaAnggota', 'listAnggotaSaldoSukarelaTersedia', 'getSimpananDetailById'],
    kasBank: ['listRekening', 'catatPengeluaran', 'transferAntarRekening', 'listRiwayatTransaksi'],
    laporan: ['getPosisiKeuangan', 'getLHU', 'getLabaRugi', 'getArusKas', 'getPerubahanEkuitas', 'getTrialBalance', 'getLedger'],
    userAdmin: ['listUsers'],
    berjangka: ['listSimpananBerjangkaDaftar'],
    pendapatanLain: ['listAkunPendapatanLainnya', 'tambahTransaksiPendapatan'],
    kategoriBeban: ['susunOpsiKategoriBeban'],
    dataReferensi: ['listDataReferensi'],
    akun: ['listAllAccounts', 'listAccounts'],
    kolektibilitas: ['getKlasifikasiPinjamanAktif', 'getRingkasanAging'],
    history: ['listHistoryTransaksi', 'getHistoryDetail', 'listJenisTransaksiTersedia'],
    shu: ['getRiwayatSHU', 'getShuAnggotaList'],
    jadwalHitung: ['hitungJadwalAngsuran'],
    personel: ['listPersonel'],
    labelIzin: ['ROLE_LABEL', 'RESOURCE_LABEL', 'AKSI_LABEL'],
  };
  for (const [k, names] of Object.entries(butuh)) {
    let m = null;
    try {
      m = R(k);
    } catch {
      m = null;
    }
    for (const n of names) if (!m || m[n] == null) hilang.push(`${k}.${n}`);
  }
  if (hilang.length) throw galat('LAYANAN_TIDAK_LENGKAP', `Layanan KOPKU tidak lengkap: ${hilang.join(', ')}`);

  const api = { idsKey: JSON.stringify(ids), jalankan, operasi: Object.keys(OPS), versi: 2 };
  Object.defineProperty(g, '__kopkuServerAdapter', { value: api, configurable: true, writable: false, enumerable: false });
  if (!opsi.tanpaRegistrasi && g.kopkuDesktop && g.kopkuDesktop.server && typeof g.kopkuDesktop.server.onCall === 'function') {
    g.kopkuDesktop.server.onCall(jalankan);
  }
  return api;
}

module.exports = { pasangAdapter };
