import React, { useEffect, useState } from 'react';
import { getRingkasanBungaAnggota, type RingkasanBungaAnggota } from '@/services/BungaSukarelaService';
import { inisialNama, labelStatusAnggota, nadaStatusAnggota } from '@/reports/TampilanAnggotaPlan';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getAnggotaById,
  Anggota,
  getHistoriTransaksiAnggota,
  HistoriTransaksiRow,
} from '@/repositories/AnggotaRepository';
import { getDb } from '@/database/db';
import { getSaldoSimpanan } from '@/services/SimpananService';
import {
  getRingkasanSimpananBerjangka,
  listSimpananBerjangka,
  RingkasanSimpananBerjangka,
  SimpananBerjangkaRow,
} from '@/services/SimpananBerjangkaService';
import {
  getKolektibilitasAnggota,
  KolektibilitasAnggotaResult,
  KOLEKTIBILITAS_LABEL,
  Kolektibilitas,
} from '@/services/LoanImpairmentService';
import StatusBadge from '@/components/StatusBadge';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildAnggotaDetailExport, RingkasanAnggotaExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import {
  OPSI_RENTANG_HISTORI,
  periodeRentangHistori,
  saringHistoriPerRentang,
  type RentangHistori,
} from '@/utils/rentangHistori';
import { colors, radius, spacing } from '@/theme/colors';
import { kolektibilitasBadge, kolektibilitasBadgeKosong } from '@/theme/kolektibilitas';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { jalankanCatchUpAkrualSimpananBerjangka } from '@/services/SimpananBerjangkaCatchUpService';
import {
  getStatusPeriodeBungaAnggota,
  type BarisStatusPeriodeBunga,
} from '@/services/SimpananBerjangkaLifecycleService';

/**
 * Menampilkan ringkasan wajib per PRD §7:
 * simpanan pokok/wajib/sukarela, total simpanan, total pinjaman,
 * total angsuran, sisa pinjaman, total jasa, SHU.
 */
export default function AnggotaDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { anggotaId } = route.params ?? {};
  const koperasi = useAppStore((s) => s.koperasi);
  // RC-S50 §3 — dipakai sebagai `createdBy` jurnal akrual (service
  // existing menuntut user yang tercatat & punya izin `simpanan:create`).
  const currentUser = useAppStore((s) => s.currentUser);

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [ringkasan, setRingkasan] = useState<RingkasanAnggotaExport | null>(null);
  const [histori, setHistori] = useState<HistoriTransaksiRow[]>([]);
  // Histori LENGKAP (tanpa limit tampilan 20) khusus untuk export —
  // supaya "Detail Anggota" yang di-export selalu mencakup SELURUH
  // transaksi, bukan cuma 20 yang tampil di layar (fase 6, sama seperti
  // pola di AnggotaListScreen/SimpananHistoriScreen).
  const [historiLengkap, setHistoriLengkap] = useState<HistoriTransaksiRow[]>([]);
  // Rentang histori yang diekspor; default Semua (perilaku sebelumnya).
  const [rentangHistori, setRentangHistori] = useState<RentangHistori>('SEMUA');
  // REQUIREMENT 2 (permintaan pengguna): Kolektibilitas Piutang Anggota.
  const [kolektibilitas, setKolektibilitas] = useState<KolektibilitasAnggotaResult | null>(null);
  const [loading, setLoading] = useState(true);
  // §22 — DOMAIN TERPISAH, bukan pengganti Pokok/Wajib/Sukarela.
  // Simpanan berjangka punya subledger sendiri (`simpanan_berjangka`)
  // dan TIDAK PERNAH ikut terhitung oleh `getSaldoSimpanan()`, jadi
  // saldonya diambil lewat servicenya sendiri dan ditampilkan di kartu
  // terpisah — mencampurnya ke "Total Simpanan" di kartu Simpanan akan
  // membuat angka itu tidak lagi cocok dengan akun ekuitas/liabilitas
  // yang selama ini menjadi pasangannya.
  const [berjangka, setBerjangka] = useState<RingkasanSimpananBerjangka | null>(null);
  // §B — status pemindahan bunga per periode. SELALU dibaca ulang dari
  // database setelah catch-up berjalan; tidak ada nilai optimistis.
  const [periodeBunga, setPeriodeBunga] = useState<BarisStatusPeriodeBunga[]>([]);
  // RC-S83 — SELURUH kontrak simpanan berjangka anggota (termasuk yang
  // sudah dicairkan/dibatalkan), khusus untuk export Detail Anggota.
  const [kontrakBerjangka, setKontrakBerjangka] = useState<SimpananBerjangkaRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bunga harian simpanan sukarela (kebijakan, default OFF) — hanya dibaca.
  const [bungaSukarela, setBungaSukarela] = useState<RingkasanBungaAnggota | null>(null);

  const loadDetail = async () => {
      if (!anggotaId) {
        // Bug fix: kalau anggotaId tidak dikirim, jangan panggil service
        // dengan id undefined — tampilkan pesan jelas langsung.
        setError('Anggota tidak ditemukan (ID tidak valid).');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const a = await getAnggotaById(anggotaId);
        if (!a) {
          // Bug fix: sebelumnya kalau anggota tidak ditemukan (return
          // null tanpa error), layar jatuh ke spinner selamanya karena
          // kondisi render memeriksa `loading || !anggota` — keduanya
          // dianggap "masih loading". Sekarang pesan jelas ditampilkan.
          setAnggota(null);
          setError('Anggota tidak ditemukan. Data mungkin sudah dihapus atau ID tidak valid.');
          setLoading(false);
          return;
        }
        setAnggota(a);
        getRingkasanBungaAnggota(anggotaId)
          .then(setBungaSukarela)
          .catch(() => setBungaSukarela(null));

        const db = await getDb();
        const [pokok, wajib, sukarela] = await Promise.all([
          getSaldoSimpanan(db, anggotaId, 'POKOK'),
          getSaldoSimpanan(db, anggotaId, 'WAJIB'),
          getSaldoSimpanan(db, anggotaId, 'SUKARELA'),
        ]);

        const pinjamanRow = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(jumlah_pinjaman),0) as total FROM pinjaman WHERE anggota_id = ? AND status IN ('AKTIF','LUNAS')`,
          anggotaId
        );
        const angsuranRow = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(ap.nominal),0) as total
           FROM angsuran_pembayaran ap JOIN pinjaman p ON p.id = ap.pinjaman_id
           WHERE p.anggota_id = ?`,
          anggotaId
        );
        const sisaRow = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar),0) as total
           FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
           WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`,
          anggotaId
        );
        // Permintaan pengguna §5: pecah "Sisa Pinjaman" di atas menjadi
        // Pinjaman Pokok (sisa pokok belum terbayar) & Jasa Pinjaman
        // (sisa jasa belum terbayar) — sumber & filter query PERSIS sama
        // dengan sisaRow di atas (pinjaman AKTIF anggota ini), hanya
        // kolom yang dijumlah berbeda, supaya
        // sisaPinjamanPokok + sisaJasaPinjaman === sisaPinjaman (tidak
        // ada double count). Pola SAMA dengan `saldo_pokok` di
        // LoanImpairmentService.getKlasifikasiPinjamanAktif.
        const sisaPokokRow = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(aj.pokok - aj.pokok_terbayar),0) as total
           FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
           WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`,
          anggotaId
        );
        const sisaJasaRow = await db.getFirstAsync<{ total: number }>(
          `SELECT COALESCE(SUM(aj.jasa - aj.jasa_terbayar),0) as total
           FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
           WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`,
          anggotaId
        );

        // REQUIREMENT 2 — kolektibilitas diambil dari mesin klasifikasi
        // existing (LoanImpairmentService), BUKAN dihitung ulang di
        // layar ini. Tanggal aging = hari ini (tanggal lokal), memakai
        // util tanggal aplikasi, bukan `new Date()` mentah.
        const kolek = await getKolektibilitasAnggota(db, anggotaId, getTanggalLokalHariIni());
        setKolektibilitas(kolek);

        setBerjangka(await getRingkasanSimpananBerjangka(anggotaId));
        setKontrakBerjangka(await listSimpananBerjangka(anggotaId));
        // Dibaca SETELAH catch-up selesai (lihat `jalankanCatchUpDanMuat`),
        // sehingga periode yang baru saja dipindahkan langsung terlihat.
        setPeriodeBunga(await getStatusPeriodeBungaAnggota(anggotaId, getTanggalLokalHariIni()));

        setRingkasan({
          simpananPokok: pokok,
          simpananWajib: wajib,
          simpananSukarela: sukarela,
          totalPinjaman: pinjamanRow?.total ?? 0,
          totalAngsuran: angsuranRow?.total ?? 0,
          sisaPinjaman: sisaRow?.total ?? 0,
          sisaPinjamanPokok: sisaPokokRow?.total ?? 0,
          sisaJasaPinjaman: sisaJasaRow?.total ?? 0,
          // Export memakai OBJEK YANG SAMA dengan yang dirender di layar
          // — satu sumber, mustahil beda angka.
          kolektibilitas: kolek.tanpaPinjamanAktif
            ? undefined
            : {
                kategoriLabel: kolek.kolektibilitas ? KOLEKTIBILITAS_LABEL[kolek.kolektibilitas] : '-',
                hariTunggakan: kolek.hariTunggakan,
                jumlahPinjamanAktif: kolek.jumlahPinjamanAktif,
                totalOutstanding: kolek.totalOutstanding,
                totalPokok: kolek.totalPokok,
                totalCadangan: kolek.totalCadangan,
              },
        });

        const [historiRows, historiSemua] = await Promise.all([
          getHistoriTransaksiAnggota(anggotaId, { limit: 20 }),
          getHistoriTransaksiAnggota(anggotaId, { limit: 100000 }),
        ]);
        setHistori(historiRows);
        setHistoriLengkap(historiSemua);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat detail anggota.');
      } finally {
        setLoading(false);
      }
  };

  /**
   * ============================================================
   * RC-S50 §3 — MEMICU CATCH-UP AKRUAL BUNGA SIMPANAN BERJANGKA
   * ============================================================
   *
   * LAYAR INI TIDAK MENGHITUNG DAN TIDAK MENJURNAL APA PUN.
   *
   * Yang dipanggil adalah `jalankanCatchUpAkrualSimpananBerjangka()`,
   * service orkestrasi yang SUDAH ADA dan SUDAH dipakai dua pemicu
   * lain (background task OS & catch-up saat startup). Mesin bunganya
   * tetap `SimpananBerjangkaBunga.ts`, penjurnalannya tetap
   * `AccountingEngine` lewat `SimpananBerjangkaLifecycleService`.
   * Tidak ada formula, akun, atau jalur akuntansi kedua.
   *
   * MEMBUKA LAYAR BUKAN PEMICU AKUNTANSINYA. Kelayakan akrual
   * ditentukan SEPENUHNYA oleh tanggal: `periodeYangSudahEarned()`
   * membandingkan tanggal berjalan dengan jadwal bunga kontrak
   * (tanggal mulai, tenor, tanggal akhir tiap periode), dan periode
   * yang belum earned tidak akan pernah diakru sebanyak apa pun layar
   * ini dibuka. Fokus layar hanya memberi KESEMPATAN eksekusi —
   * penting justru karena OS boleh menunda background task dan
   * aplikasi bisa tidak dibuka berbulan-bulan.
   *
   * TIDAK ADA DOUBLE POSTING, tiga lapis (lihat
   * SimpananBerjangkaCatchUpService):
   *   1. penjaga in-process: pemicu yang datang bersamaan MENUNGGU
   *      batch yang sedang jalan, bukan memulai batch kedua;
   *   2. cek event per periode: `simpanan_berjangka_bunga` diperiksa
   *      sebelum menjurnal;
   *   3. UNIQUE(simpanan_berjangka_id, nomor_periode) di database —
   *      perlindungan terakhir yang tidak bisa ditembus race apa pun.
   * Karena itu membuka layar ini berkali-kali dalam satu hari, atau
   * bersamaan dengan background task, tetap menghasilkan tepat satu
   * jurnal akrual per periode.
   *
   * KEGAGALANNYA TIDAK PERNAH MEMBLOKIR LAYAR: catch-up dijalankan
   * lebih dulu lalu detail dimuat apa pun hasilnya, jadi kontrak yang
   * periodenya tertutup (mis. periode sudah di-close) tidak membuat
   * Detail Anggota gagal dibuka.
   */
  const jalankanCatchUpDanMuat = async () => {
    if (currentUser?.id) {
      try {
        await jalankanCatchUpAkrualSimpananBerjangka(currentUser.id);
      } catch {
        // Diamkan di sini: service sudah mengumpulkan kegagalan per
        // kontrak di `hasil.gagal`, dan layar ini bukan tempat untuk
        // melaporkan kesehatan batch akuntansi.
      }
    }
    await loadDetail();
  };

  useEffect(() => {
    void jalankanCatchUpDanMuat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anggotaId, currentUser?.id]);

  // Bug fix: setelah Edit Anggota -> Simpan -> navigation.goBack(), layar
  // Detail Anggota ini TIDAK di-unmount (tetap instance yang sama di
  // navigation stack), jadi useEffect di atas (dependency [anggotaId])
  // tidak jalan ulang dan data yang tampil jadi basi (stale) walaupun
  // update ke database sudah berhasil tersimpan. Perbaikannya: refetch
  // ulang setiap kali layar ini mendapat fokus kembali, sama seperti
  // pola yang sudah dipakai di AnggotaListScreen (navigation.addListener
  // 'focus').
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      void jalankanCatchUpDanMuat();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, anggotaId, currentUser?.id]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (loading || !anggota || !ringkasan) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const totalSimpanan = ringkasan.simpananPokok + ringkasan.simpananWajib + ringkasan.simpananSukarela;

  return (
    <ScrollView style={styles.container}>
      {/* KARTU IDENTITAS — menggantikan baris judul polos. Status
          ditampilkan sebagai lencana berlabel manusiawi, bukan nilai
          enum mentah ("TIDAK_AKTIF") yang dulu ikut dirangkai ke
          dalam satu baris teks bersama nomor anggota dan jenis
          kelamin. */}
      <View style={styles.identitas}>
        <View style={styles.headerRow}>
          <View style={[styles.avatar, styles[`avatar_${nadaStatusAnggota(anggota.status)}`]]}>
            <Text style={styles.avatarTeks}>{inisialNama(anggota.namaLengkap)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.nama} numberOfLines={2}>
              {anggota.namaLengkap}
            </Text>
            <Text style={styles.sub}>
              {anggota.nomorAnggota}
              {anggota.jenisKelamin ? ` · ${anggota.jenisKelamin === 'LAKI_LAKI' ? 'Laki-laki' : 'Perempuan'}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.editButton}
            onPress={() => navigation.navigate('AnggotaForm', { anggotaId: anggota.id })}
            accessibilityRole="button"
          >
            <Ionicons name="create-outline" size={14} color={colors.primary} />
            <Text style={styles.editButtonText}>Edit</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.lencana, styles[`lencana_${nadaStatusAnggota(anggota.status)}`]]}>
          <Text style={[styles.lencanaTeks, styles[`lencanaTeks_${nadaStatusAnggota(anggota.status)}`]]}>
            {labelStatusAnggota(anggota.status)}
          </Text>
        </View>
      </View>

      <ExportButton
        label="Export Detail Anggota"
        data={
          koperasi
            ? buildAnggotaDetailExport(
                { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                anggota,
                ringkasan,
                historiLengkap,
                getTanggalLokalHariIni(),
                // RC-S83 — Simpanan Berjangka ikut ter-export, memakai
                // objek yang SAMA dengan yang dirender di layar.
                berjangka ? { ringkasan: berjangka, kontrak: kontrakBerjangka, periodeBunga } : undefined,
                rentangHistori
              )
            : null
        }
        pilihan={{
          judul: 'Histori Transaksi',
          opsi: OPSI_RENTANG_HISTORI,
          nilai: rentangHistori,
          onPilih: (k) => setRentangHistori(k as RentangHistori),
          keterangan: `${periodeRentangHistori(rentangHistori, getTanggalLokalHariIni())} · ${
            saringHistoriPerRentang(historiLengkap, rentangHistori, getTanggalLokalHariIni()).length
          } transaksi. Saldo simpanan & pinjaman tetap posisi per hari ini.`,
        }}
      />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Simpanan</Text>
        <Row label="Simpanan Pokok" value={ringkasan.simpananPokok} />
        <Row label="Simpanan Wajib" value={ringkasan.simpananWajib} />
        <Row label="Simpanan Sukarela" value={ringkasan.simpananSukarela} />
        <Row label="Total Simpanan" value={totalSimpanan} bold />
      </View>

      {/* Bunga harian simpanan sukarela — kartu TERPISAH, hanya tampil bila
          kebijakan aktif atau sudah pernah ada bunga. Kartu "Simpanan" di
          atas tidak diubah. Bunga hari ini & bulan berjalan = perkiraan
          (belum dibukukan); yang sudah masuk saldo dari akrual bulanan. */}
      {bungaSukarela && (bungaSukarela.aktifBulanIni || bungaSukarela.totalBungaMasukSaldo !== 0) && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Bunga Simpanan Sukarela</Text>
          <Row label="Saldo Simpanan Sukarela" value={bungaSukarela.saldoSukarela} />
          {bungaSukarela.aktifBulanIni ? (
            <>
              <RowTeks
                label={`Bunga hari ini (${String(bungaSukarela.tarifBulanIni).replace('.', ',')}%/th)`}
                value={rupiahDesimal(bungaSukarela.bungaHariIni)}
              />
              <RowTeks label="Bunga bulan berjalan (perkiraan)" value={rupiahDesimal(bungaSukarela.bungaBerjalan)} />
            </>
          ) : null}
          <Row label="Bunga diakru tahun ini (bruto)" value={bungaSukarela.bungaDiakruTahunIni} />
          <Row label="PPh bunga dipotong" value={bungaSukarela.totalPphDipotong} />
          <Row label="Total bunga masuk saldo (neto)" value={bungaSukarela.totalBungaMasukSaldo} bold />
        </View>
      )}

      {/* §22 — kartu TERPISAH. Kartu "Simpanan" di atas TIDAK diubah:
          Pokok/Wajib/Sukarela beserta totalnya tetap persis seperti
          sebelumnya. */}
      {berjangka && berjangka.jumlahKontrakAktif > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Simpanan Berjangka</Text>
          <Row label="Saldo Pokok" value={berjangka.saldoPokok} bold />
          <View style={styles.rowPlain}>
            <Text style={styles.rowLabel}>Kontrak Aktif</Text>
            <Text style={styles.rowValueText}>{berjangka.jumlahKontrakAktif} kontrak</Text>
          </View>
          <View style={styles.rowPlain}>
            <Text style={styles.rowLabel}>Jatuh Tempo Terdekat</Text>
            <Text style={styles.rowValueText}>{berjangka.jatuhTempoTerdekat ?? '-'}</Text>
          </View>
          <View style={styles.rowPlain}>
            <Text style={styles.rowLabel}>Suku Bunga</Text>
            <Text style={styles.rowValueText}>
              {berjangka.rentangSukuBunga ?? 'Tanpa bunga'}
            </Text>
          </View>
          {berjangka.bungaTerakru > 0 && <Row label="Bunga Terakru" value={berjangka.bungaTerakru} />}
          <Text style={styles.cardNote}>
            Saldo pokok TIDAK termasuk bunga — pokok tercatat pada akun Simpanan Anggota
            (Berjangka), bunga terakru pada akun Utang Bunga Simpanan Berjangka.
          </Text>

          {/*
            §B — STATUS PEMINDAHAN BUNGA PER PERIODE.

            Seluruh baris berasal dari `getStatusPeriodeBungaAnggota()`.
            Layar ini TIDAK menghitung kelayakan, TIDAK menjurnal, dan
            TIDAK menyimpulkan sendiri bahwa sesuatu sudah diposting:
            "Sudah Dipindahkan" ditampilkan HANYA ketika jurnal
            pemindahannya benar-benar ada di database.

            Seluruh periode ditampilkan — termasuk yang tertinggal
            beberapa bulan — bukan hanya periode terbaru.
          */}
          {periodeBunga.length > 0 && (
            <View style={styles.periodeWrap}>
              <Text style={styles.periodeJudul}>Bunga per Periode</Text>
              {periodeBunga.map((p) => (
                <View key={`${p.kontrakId}-${p.nomorPeriode}`} style={styles.periodeItem}>
                  <View style={styles.periodeBaris}>
                    <Text style={styles.periodeNomor}>
                      Periode {p.nomorPeriode} · {p.nomorKontrak}
                    </Text>
                    <Text style={styles.periodeNominal}>{formatRupiah(p.bunga)}</Text>
                  </View>
                  <View style={styles.periodeBaris}>
                    <Text style={styles.periodeTanggal}>{p.tanggalAkhirPeriode}</Text>
                    <Text
                      style={[
                        styles.periodeStatus,
                        p.status === 'SUDAH_DIPINDAHKAN'
                          ? styles.periodeStatusSelesai
                          : p.status === 'SIAP_DIPINDAHKAN'
                            ? styles.periodeStatusSiap
                            : styles.periodeStatusMenunggu,
                      ]}
                    >
                      {p.status === 'SUDAH_DIPINDAHKAN'
                        ? 'Sudah Dipindahkan'
                        : p.status === 'SIAP_DIPINDAHKAN'
                          ? 'Siap Dipindahkan'
                          : 'Belum Jatuh Tempo'}
                    </Text>
                  </View>
                  {p.journalTransferId !== null && (
                    <Text style={styles.periodeJurnal} selectable>
                      Jurnal: {p.journalTransferId}
                    </Text>
                  )}
                </View>
              ))}
              <Text style={styles.cardNote}>
                Bunga yang sudah dipindahkan menambah Simpanan Sukarela anggota dan tidak
                dibayarkan lagi saat pencairan kontrak.
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pinjaman</Text>

        {/* ============================================================
            REQUIREMENT 2 (permintaan pengguna): "Kolektibilitas Piutang
            Anggota" — WAJIB berada DI ATAS "Pinjaman Pokok". Blok ini
            sengaja diletakkan sebagai baris pertama di dalam kartu
            Pinjaman (bukan kartu terpisah di atasnya) supaya urutan
            bacanya persis seperti yang diminta:
              Kolektibilitas -> Pinjaman Pokok -> detail pinjaman lain.
            Seluruh nilainya berasal dari
            LoanImpairmentService.getKolektibilitasAnggota() — TIDAK ADA
            angka yang dihitung/di-hardcode di layar ini.
            ============================================================ */}
        {kolektibilitas && (
          <View style={styles.kolektibilitasBlok}>
            <View style={styles.kolektibilitasHeader}>
              <Text style={styles.kolektibilitasLabel}>Kolektibilitas Piutang Anggota</Text>
              {kolektibilitas.tanpaPinjamanAktif ? (
                <StatusBadge label="TIDAK ADA PIUTANG" bg={colors.background} fg={colors.textMuted} />
              ) : (
                <StatusBadge
                  label={kolektibilitas.kolektibilitas ? KOLEKTIBILITAS_LABEL[kolektibilitas.kolektibilitas] : '-'}
                  bg={warnaKolektibilitas(kolektibilitas.kolektibilitas).bg}
                  fg={warnaKolektibilitas(kolektibilitas.kolektibilitas).fg}
                />
              )}
            </View>

            {kolektibilitas.tanpaPinjamanAktif ? (
              /* Empty state — bukan "Rp0" yang menyesatkan. */
              <Text style={styles.kolektibilitasEmpty}>
                Anggota ini tidak memiliki pinjaman aktif dengan sisa piutang.
              </Text>
            ) : (
              <>
                <View style={styles.kolektibilitasMetaRow}>
                  <Text style={styles.kolektibilitasMeta}>
                    Tunggakan terlama {kolektibilitas.hariTunggakan} hari
                    {kolektibilitas.tanggalJatuhTempoTertunggak
                      ? ` · sejak jatuh tempo ${kolektibilitas.tanggalJatuhTempoTertunggak}`
                      : ''}
                  </Text>
                  <Text style={styles.kolektibilitasMeta}>
                    {kolektibilitas.jumlahPinjamanAktif} pinjaman aktif · penyisihan{' '}
                    {formatRupiah(kolektibilitas.totalCadangan)}
                  </Text>
                </View>

                {/* Rincian per pinjaman kalau anggota punya lebih dari
                    satu — status agregat di atas adalah kategori
                    TERBURUK, jadi rinciannya perlu terlihat supaya tidak
                    menyesatkan. */}
                {kolektibilitas.jumlahPinjamanAktif > 1 &&
                  kolektibilitas.rincian.map((r) => (
                    <View key={r.pinjamanId} style={styles.kolektibilitasRincianRow}>
                      <Text style={styles.kolektibilitasRincianKiri} numberOfLines={1}>
                        {r.nomorPinjaman} · {KOLEKTIBILITAS_LABEL[r.kolektibilitas]} ({r.hariTunggakan} hr)
                      </Text>
                      <Text style={styles.kolektibilitasRincianKanan}>{formatRupiah(r.saldoPiutang)}</Text>
                    </View>
                  ))}
              </>
            )}
          </View>
        )}

        {/* Permintaan pengguna: Pinjaman Pokok & Jasa Pinjaman ditampilkan
            di bagian atas, sebelum rekap Total Angsuran/Sisa Pinjaman.
            "Total Pinjaman" dihapus dari tampilan (field/kolom database
            & perhitungan `totalPinjaman` tetap dipertahankan untuk
            kebutuhan export/perhitungan lain, hanya baris tampilan yang
            dihapus). Sumber data sama dengan pinjaman/angsuran AKTIF di
            bawah, tidak dijumlah dobel (lihat komentar service). */}
        <Row label="Pinjaman Pokok" value={ringkasan.sisaPinjamanPokok} />
        <Row label="Jasa Pinjaman" value={ringkasan.sisaJasaPinjaman} />
        <Row label="Total Angsuran Dibayar" value={ringkasan.totalAngsuran} />
        <Row label="Sisa Pinjaman" value={ringkasan.sisaPinjaman} bold />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Histori Transaksi</Text>
        {histori.length === 0 && <Text style={styles.emptyText}>Belum ada transaksi.</Text>}
        {histori.map((h) => (
          <View key={h.id} style={styles.historiRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.historiJenis}>{h.jenis}</Text>
              <Text style={styles.historiSub}>{h.tipe} · {h.tanggal} · {h.nomorReferensi}</Text>
            </View>
            <Text style={styles.historiNominal}>{formatRupiah(h.nominal)}</Text>
          </View>
        ))}
        {historiLengkap.length > histori.length && (
          <Text style={styles.moreHint}>
            Menampilkan {histori.length} dari {historiLengkap.length} transaksi. Export untuk melihat semuanya.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * REQUIREMENT 2 — warna indikator status kolektibilitas. Peta warnanya
 * TIDAK lagi ditulis di layar ini: ia diambil dari `theme/kolektibilitas`,
 * satu-satunya sumber warna kategori di aplikasi, supaya kategori yang
 * sama tidak tampil berbeda antara layar ini dan layar Kolektibilitas
 * Piutang (dulu begitu — lihat komentar di berkas theme itu).
 */
function warnaKolektibilitas(kategori: Kolektibilitas | null): { bg: string; fg: string } {
  return kategori ? kolektibilitasBadge[kategori] : kolektibilitasBadgeKosong;
}

/** Rupiah dengan dua desimal (bunga harian bisa pecahan rupiah). */
function rupiahDesimal(n: number): string {
  const [utuh, sen] = (Math.round(n * 100) / 100).toFixed(2).split('.');
  return `Rp${utuh.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${sen}`;
}

function RowTeks({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{formatRupiah(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rowPlain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  rowValueText: { fontSize: 13, fontWeight: '600', color: colors.text },
  cardNote: { fontSize: 11, color: colors.textMuted, marginTop: 8, lineHeight: 15 },
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.danger, textAlign: 'center', padding: 24 },
  identitas: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: spacing.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatar_aktif: { backgroundColor: colors.primary },
  avatar_netral: { backgroundColor: colors.textMuted },
  avatar_peringatan: { backgroundColor: colors.warning },
  avatar_berhenti: { backgroundColor: colors.danger },
  avatarTeks: { fontSize: 16, fontWeight: '800', color: colors.white },
  lencana: { alignSelf: 'flex-start', marginTop: spacing.md, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  lencana_aktif: { backgroundColor: colors.primaryLight },
  lencana_netral: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  lencana_peringatan: { backgroundColor: colors.warningBg },
  lencana_berhenti: { backgroundColor: colors.dangerBg },
  lencanaTeks: { fontSize: 10.5, fontWeight: '800' },
  lencanaTeks_aktif: { color: colors.primary },
  lencanaTeks_netral: { color: colors.textMuted },
  lencanaTeks_peringatan: { color: colors.warning },
  lencanaTeks_berhenti: { color: colors.danger },
  nama: { fontSize: 20, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  editButtonText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, marginBottom: spacing.md },
  cardTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.sm, color: colors.primary },
  periodeWrap: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  periodeJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  periodeItem: { marginBottom: spacing.md },
  periodeBaris: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  periodeNomor: { fontSize: 13, fontWeight: '600', color: colors.text, flex: 1 },
  periodeNominal: { fontSize: 13, fontWeight: '700', color: colors.text },
  periodeTanggal: { fontSize: 12, color: colors.textMuted },
  periodeStatus: { fontSize: 12, fontWeight: '600' },
  periodeStatusSelesai: { color: colors.success },
  periodeStatusSiap: { color: colors.warning },
  periodeStatusMenunggu: { color: colors.textMuted },
  periodeJurnal: { fontSize: 10, color: colors.textFaint, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { color: colors.textMuted },
  kolektibilitasBlok: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kolektibilitasHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  kolektibilitasLabel: { fontSize: 13, fontWeight: '700', color: colors.text, flexShrink: 1 },
  kolektibilitasMetaRow: { marginTop: spacing.sm, gap: 2 },
  kolektibilitasMeta: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  kolektibilitasEmpty: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 17 },
  kolektibilitasRincianRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  kolektibilitasRincianKiri: { fontSize: 11, color: colors.textMuted, flex: 1 },
  kolektibilitasRincianKanan: { fontSize: 11, color: colors.text, fontWeight: '600' },
  rowValue: { color: colors.text },
  bold: { fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  historiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  historiJenis: { fontSize: 13, fontWeight: '600', color: colors.text },
  historiSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  historiNominal: { fontSize: 13, fontWeight: '700', color: colors.primary },
  moreHint: { fontSize: 11, color: colors.textFaint, marginTop: spacing.sm, fontStyle: 'italic' },
});
