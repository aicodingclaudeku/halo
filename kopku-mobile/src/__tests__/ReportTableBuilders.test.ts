import {
  buildDaftarAnggotaExport,
  buildSimpananExport,
  buildPinjamanExport,
  buildAngsuranExport,
  buildBukuBesarExport,
  buildNeracaSaldoExport,
  buildPosisiKeuanganExport,
  buildLabaRugiExport,
  buildPerubahanEkuitasExport,
  buildArusKasExport,
  buildCalkExport,
  buildShuAnggotaExport,
  buildDataBankExport,
  buildKolektibilitasExport,
  buildDaftarAsetExport,
  buildDaftarInvestasiExport,
  buildUtangExport,
  buildBuktiBayarUtangExport,
  buildAnggotaDetailExport,
  InfoKoperasiExport,
} from '@/export/ReportTableBuilders';
import type { Anggota } from '@/repositories/AnggotaRepository';
import type { SimpananHistoriRow } from '@/services/SimpananService';
import type { PinjamanListItem, JadwalAngsuranItem } from '@/services/PinjamanService';
import type { LedgerLine, TrialBalanceResult } from '@/accounting/Ledger';
import type {
  PosisiKeuanganResult,
  LabaRugiResult,
  PerubahanEkuitasResult,
  ArusKasResult,
  CalkResult,
} from '@/reports/FinancialReports';
import type { ShuAnggotaRow, ShuKonfigurasiRow } from '@/services/ShuService';

const INFO: InfoKoperasiExport = { namaKoperasi: 'Koperasi Sejahtera', standarAkuntansi: 'SAK_EP' };

describe('ReportTableBuilders (PRD §36 / fase 6 - 12 jenis laporan)', () => {
  test('buildDaftarAnggotaExport: satu baris per anggota, ringkasan total anggota', () => {
    const anggota: Anggota[] = [
      { id: '1', nomorAnggota: 'A001', nik: '1234567890123456', namaLengkap: 'Budi', tanggalBergabung: '2020-01-01', status: 'AKTIF' },
      { id: '2', nomorAnggota: 'A002', nik: '1234567890123457', namaLengkap: 'Sari', tanggalBergabung: '2021-01-01', status: 'AKTIF' },
    ];
    const hasil = buildDaftarAnggotaExport(INFO, anggota, '2026-08-11');
    expect(hasil.baris.length).toBe(2);
    expect(hasil.baris[0][2]).toBe('Budi');
    expect(hasil.ringkasan?.[0].nilai).toBe('2');
    expect(hasil.kolomAngka).toEqual([]);
  });

  test('buildDaftarAnggotaExport (bug fix): kolom "Jenis Kelamin" ada & terisi label yang benar, "-" kalau belum diisi (anggota lama)', () => {
    const anggota: Anggota[] = [
      { id: '1', nomorAnggota: 'A001', namaLengkap: 'Budi', jenisKelamin: 'LAKI_LAKI', tanggalBergabung: '2020-01-01', status: 'AKTIF' },
      { id: '2', nomorAnggota: 'A002', namaLengkap: 'Sari', jenisKelamin: 'PEREMPUAN', tanggalBergabung: '2021-01-01', status: 'AKTIF' },
      { id: '3', nomorAnggota: 'A003', namaLengkap: 'Anggota Lama', tanggalBergabung: '2019-01-01', status: 'AKTIF' },
    ];
    const hasil = buildDaftarAnggotaExport(INFO, anggota, '2026-08-11');
    expect(hasil.kolom).toContain('Jenis Kelamin');
    const idxJenisKelamin = hasil.kolom.indexOf('Jenis Kelamin');
    expect(hasil.baris[0][idxJenisKelamin]).toBe('Laki-laki');
    expect(hasil.baris[1][idxJenisKelamin]).toBe('Perempuan');
    expect(hasil.baris[2][idxJenisKelamin]).toBe('-');
  });

  test('buildSimpananExport: total setoran & penarikan dihitung terpisah', () => {
    const daftar: SimpananHistoriRow[] = [
      { id: '1', anggotaId: 'a1', namaAnggota: 'Budi', jenis: 'POKOK', tipe: 'SETOR', tanggal: '2026-01-01', nominal: 100000, nomorTransaksi: 'SP-1', keterangan: null },
      { id: '2', anggotaId: 'a1', namaAnggota: 'Budi', jenis: 'SUKARELA', tipe: 'TARIK', tanggal: '2026-02-01', nominal: 30000, nomorTransaksi: 'ST-1', keterangan: null },
    ];
    const hasil = buildSimpananExport(INFO, daftar, 'Per 2026-08-11');
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Setoran')?.nilai).toBe('Rp100.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Penarikan')?.nilai).toBe('Rp30.000');
    expect(hasil.kolomAngka).toEqual([5]);
  });

  test('buildPinjamanExport: total pinjaman dijumlahkan dari seluruh baris', () => {
    const daftar: PinjamanListItem[] = [
      { id: '1', nomorPinjaman: 'PJ-1', anggotaId: 'a1', namaAnggota: 'Budi', jumlahPinjaman: 1000000, sisaPiutang: 1000000, tenor: 6, satuanTenor: 'BULAN', status: 'AKTIF', tanggalJatuhTempo: '2026-12-01' },
      { id: '2', nomorPinjaman: 'PJ-2', anggotaId: 'a2', namaAnggota: 'Sari', jumlahPinjaman: 2000000, sisaPiutang: 2000000, tenor: 12, satuanTenor: 'BULAN', status: 'AKTIF', tanggalJatuhTempo: '2027-06-01' },
    ];
    const hasil = buildPinjamanExport(INFO, daftar, '2026-08-11');
    expect(hasil.ringkasan?.[0].nilai).toBe('Rp3.000.000');
  });

  test('buildAngsuranExport: total tagihan & terbayar dari jadwal satu pinjaman', () => {
    const jadwal: JadwalAngsuranItem[] = [
      { id: '1', nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 100000, jasa: 20000, denda: 0, total: 120000, pokokTerbayar: 100000, jasaTerbayar: 20000, dendaTerbayar: 0, status: 'LUNAS', dibuatDariAkadUlangId: null, digantikanOlehAkadUlangId: null },
      { id: '2', nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 100000, jasa: 20000, denda: 0, total: 120000, pokokTerbayar: 0, jasaTerbayar: 0, dendaTerbayar: 0, status: 'BELUM_BAYAR', dibuatDariAkadUlangId: null, digantikanOlehAkadUlangId: null },
    ];
    const hasil = buildAngsuranExport(INFO, 'PJ-1', 'Budi', jadwal);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Tagihan')?.nilai).toBe('Rp240.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Terbayar')?.nilai).toBe('Rp120.000');
    expect(hasil.judulLaporan).toContain('PJ-1');
  });

  /**
   * REQUIREMENT 6 (permintaan pengguna) — export jadwal angsuran kini
   * PER BAGIAN. Judul & nama file wajib menyatakan bagian mana yang
   * di-export supaya file "Angsuran Aktif" tidak pernah tertukar dengan
   * histori restrukturisasi/akad ulang.
   *
   * CATATAN PERUBAHAN PERILAKU YANG DISENGAJA: judul default berubah
   * dari "Jadwal Angsuran — X" menjadi "Angsuran Aktif — X". Assertion
   * lama (`toContain('PJ-1')`) tetap lulus; test ini menambahkan
   * pengecekan eksplisit atas judul barunya.
   */
  test('buildAngsuranExport: judul & nama file mengikuti bagian yang di-export', () => {
    const baris: JadwalAngsuranItem[] = [
      { id: '1', nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 100000, jasa: 20000, denda: 0, total: 120000, pokokTerbayar: 0, jasaTerbayar: 0, dendaTerbayar: 0, status: 'BELUM_BAYAR', dibuatDariAkadUlangId: null, digantikanOlehAkadUlangId: null },
    ];

    const aktif = buildAngsuranExport(INFO, 'PJ-1', 'Budi', baris);
    expect(aktif.judulLaporan).toBe('Angsuran Aktif — PJ-1');
    expect(aktif.namaFileDasar).toBe('angsuran-aktif-PJ-1');
    expect(aktif.ringkasan?.find((r) => r.label === 'Bagian')?.nilai).toBe('Angsuran Aktif');

    const restrukturisasi = buildAngsuranExport(INFO, 'PJ-1', 'Budi', baris, 'RESTRUKTURISASI');
    expect(restrukturisasi.judulLaporan).toContain('Restrukturisasi');
    expect(restrukturisasi.namaFileDasar).toContain('restrukturisasi');

    const akadUlang = buildAngsuranExport(INFO, 'PJ-1', 'Budi', baris, 'AKAD_ULANG');
    expect(akadUlang.judulLaporan).toContain('Akad Ulang');
    expect(akadUlang.namaFileDasar).toContain('akad-ulang');
  });

  test('buildBukuBesarExport: saldo akhir diambil dari baris terakhir ledger', () => {
    const ledger: LedgerLine[] = [
      { tanggal: '2026-01-01', nomorJurnal: 'JRN-1', keterangan: 'Setoran', debit: 100000, kredit: 0, saldoBerjalan: 100000 },
      { tanggal: '2026-01-05', nomorJurnal: 'JRN-2', keterangan: 'Penarikan', debit: 0, kredit: 30000, saldoBerjalan: 70000 },
    ];
    const hasil = buildBukuBesarExport(INFO, 'Kas', ledger, '2026-01-01 s.d. 2026-01-31');
    expect(hasil.ringkasan?.find((r) => r.label === 'Saldo Akhir')?.nilai).toBe('Rp70.000');
    expect(hasil.baris.length).toBe(2);
  });

  test('buildNeracaSaldoExport: status "Seimbang" ikut hasil isBalanced', () => {
    const trial: TrialBalanceResult = {
      rows: [{ accountId: 'a', kode: '1-1000', nama: 'Kas', debit: 100000, kredit: 0 }],
      totalDebit: 100000,
      totalKredit: 100000,
      isBalanced: true,
    };
    const hasil = buildNeracaSaldoExport(INFO, trial, '2026-12-31');
    expect(hasil.ringkasan?.find((r) => r.label === 'Status')?.nilai).toBe('Seimbang');

    const trialTidakSeimbang: TrialBalanceResult = { ...trial, totalKredit: 90000, isBalanced: false };
    const hasilTidakSeimbang = buildNeracaSaldoExport(INFO, trialTidakSeimbang, '2026-12-31');
    expect(hasilTidakSeimbang.ringkasan?.find((r) => r.label === 'Status')?.nilai).toBe('TIDAK SEIMBANG');
  });

  test('buildPosisiKeuanganExport: seluruh baris (ASET/LIABILITAS/EKUITAS) + subtotal masuk ke tabel', () => {
    const data: PosisiKeuanganResult = {
      asOfDate: '2026-12-31',
      aset: [{ kode: '1-1000', nama: 'Kas', saldo: 500000 }],
      liabilitas: [],
      ekuitas: [{ kode: '3-1000', nama: 'Simpanan Pokok', saldo: 500000 }],
      labaBerjalan: 0,
      totalAset: 500000,
      totalLiabilitas: 0,
      totalEkuitas: 500000,
      isBalanced: true,
      selisih: 0,
      labaBerjalanLabel: 'SHU/Laba Tahun Berjalan (belum dihitung, belum dibagikan)',
      shuStatus: null,
      tahunBuku: null,
      termasukSaldoAwalDraft: false,
    };
    const hasil = buildPosisiKeuanganExport(INFO, data);
    expect(hasil.baris.some((b) => b[0] === 'ASET')).toBe(true);
    expect(hasil.baris.some((b) => b[0] === 'Kas' && b[1] === 500000)).toBe(true);
    expect(hasil.baris.some((b) => b[0] === 'Total Aset')).toBe(true);
    expect(hasil.ringkasan?.find((r) => r.label === 'Status')?.nilai).toBe('Seimbang');
  });

  test('buildLabaRugiExport: hasil usaha diambil dari data.hasilUsaha', () => {
    const data: LabaRugiResult = {
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      pendapatan: [{ kode: '4-1000', nama: 'Pendapatan Jasa', jumlah: 500000 }],
      beban: [{ kode: '5-1000', nama: 'Beban Operasional', jumlah: 200000 }],
      totalPendapatan: 500000,
      totalBeban: 200000,
      hasilUsaha: 300000,
      penghasilanKomprehensifLain: 0,
      penghasilanKomprehensifLainRows: [],
      totalPenghasilanKomprehensif: 300000,
    };
    const hasil = buildLabaRugiExport(INFO, data, 'Laporan Hasil Usaha');
    expect(hasil.ringkasan?.[0].nilai).toBe('Rp300.000');
    expect(hasil.judulLaporan).toBe('Laporan Hasil Usaha');
  });

  test('buildLabaRugiExport (RC-S88): pos OCI dirinci & total penghasilan komprehensif', () => {
    const data: LabaRugiResult = {
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      pendapatan: [{ kode: '4-1000', nama: 'Pendapatan Jasa', jumlah: 500000 }],
      beban: [],
      totalPendapatan: 500000,
      totalBeban: 0,
      hasilUsaha: 500000,
      penghasilanKomprehensifLain: 250000,
      penghasilanKomprehensifLainRows: [
        { kode: '3-6000', nama: 'Surplus revaluasi aset tetap', kelompok: 'TIDAK_DIREKLASIFIKASI', jumlah: 250000 },
      ],
      totalPenghasilanKomprehensif: 750000,
    };
    const hasil = buildLabaRugiExport(INFO, data, 'Laporan Hasil Usaha');
    expect(hasil.baris).toContainEqual(['Surplus revaluasi aset tetap', 250000]);
    expect(hasil.baris).toContainEqual(['TOTAL PENGHASILAN KOMPREHENSIF', 750000]);
    expect(hasil.ringkasan?.[1].nilai).toBe('Rp750.000');
  });

  test('buildPerubahanEkuitasExport: baris SHU periode ditambahkan sebagai baris terakhir', () => {
    const data: PerubahanEkuitasResult = {
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      rows: [{ kode: '3-1000', nama: 'Simpanan Pokok', saldoAwal: 0, mutasi: 500000, saldoAkhir: 500000 }],
      totalSaldoAwal: 0,
      totalMutasi: 500000,
      hasilUsahaPeriode: 100000,
      hasilUsahaPeriodeLabel: 'SHU/Laba Tahun Berjalan (belum dihitung, belum dibagikan)',
      totalSaldoAkhir: 600000,
    };
    const hasil = buildPerubahanEkuitasExport(INFO, data);
    const barisShu = hasil.baris.find((b) => b[0] === data.hasilUsahaPeriodeLabel);
    expect(barisShu).toBeDefined();
    expect(barisShu?.[2]).toBe(100000);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Saldo Akhir')?.nilai).toBe('Rp600.000');
  });

  test('buildArusKasExport: label rekonsiliasi berbeda sesuai status terekonsiliasi', () => {
    const dataSesuai: ArusKasResult = {
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      operasi: 100000,
      investasi: 0,
      pendanaan: 0,
      kasAwal: 0,
      perubahanKas: 100000,
      kasAkhirDihitung: 100000,
      kasAkhirAktual: 100000,
      terekonsiliasi: true,
      selisihRekonsiliasi: 0,
      rincian: [],
    };
    // DIPERBARUI RC-S104: ringkasan kini memuat dua baris ("Metode
    // penyusunan" lebih dulu), jadi barisnya DICARI berdasarkan label,
    // bukan diambil dari indeks 0. Indeks tetap adalah asumsi rapuh yang
    // memang sudah patah sekali di sini.
    const rekonsiliasi = (h: ReturnType<typeof buildArusKasExport>) =>
      h.ringkasan?.find((r) => r.label === 'Rekonsiliasi')?.nilai;

    const hasil = buildArusKasExport(INFO, dataSesuai);
    expect(rekonsiliasi(hasil)).toBe('Sesuai dengan saldo kas/bank');

    const dataTidakSesuai: ArusKasResult = { ...dataSesuai, kasAkhirAktual: 90000, terekonsiliasi: false, selisihRekonsiliasi: -10000 };
    const hasilTidakSesuai = buildArusKasExport(INFO, dataTidakSesuai);
    expect(rekonsiliasi(hasilTidakSesuai)).toContain('Selisih');
  });

  test('buildCalkExport: setiap section jadi satu baris (Judul, Konten)', () => {
    const data: CalkResult = {
      tanggalMulai: '2026-01-01',
      tanggalSelesai: '2026-12-31',
      sections: [
        { sectionKey: 'informasi_umum', judul: 'Informasi Umum', konten: 'Koperasi Sejahtera didirikan tahun 2020.' },
        { sectionKey: 'kas', judul: 'Kas dan Bank', konten: 'Kas: Rp500.000.' },
      ],
    };
    const hasil = buildCalkExport(INFO, data);
    expect(hasil.baris.length).toBe(2);
    expect(hasil.baris[0]).toEqual(['Informasi Umum', 'Koperasi Sejahtera didirikan tahun 2020.']);
    expect(hasil.kolom).toEqual(['Bagian', 'Isi']);
  });

  test('buildShuAnggotaExport: total SHU dibagikan = jumlah seluruh totalShuAnggota', () => {
    const konfigurasi: ShuKonfigurasiRow = {
      id: 'k1',
      tahunBuku: 2026,
      persenCadangan: 30,
      persenJasaModal: 20,
      persenJasaUsaha: 20,
      persenPendidikan: 10,
      persenSosial: 10,
      persenPengurus: 5,
      persenPengawas: 5,
      persenKaryawan: 0,
      persenPembangunanDaerahKerja: 0,
      persenCadanganRisiko: 0,
      totalShu: 70000,
      status: 'DIBAGIKAN',
      shuInformasiRat: null,
      shuDiajukanRat: null,
      shuDisahkanRat: null,
      ratId: null,
      catatanKeputusanRat: null,
    };
    const daftar: ShuAnggotaRow[] = [
      { id: '1', anggotaId: 'a1', namaAnggota: 'Budi', nomorAnggota: 'A001', basisSimpanan: 150000, basisPartisipasiUsaha: 20000, jasaModal: 5250, jasaUsaha: 2800, totalShuAnggota: 8050 },
      { id: '2', anggotaId: 'a2', namaAnggota: 'Sari', nomorAnggota: 'A002', basisSimpanan: 250000, basisPartisipasiUsaha: 80000, jasaModal: 8750, jasaUsaha: 11200, totalShuAnggota: 19950 },
    ];
    const hasil = buildShuAnggotaExport(INFO, konfigurasi, daftar);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total SHU Dibagikan ke Anggota')?.nilai).toBe('Rp28.000');
    expect(hasil.judulLaporan).toContain('2026');
  });

  test('semua builder menyertakan namaKoperasi & periodeLabel (fase 6: info koperasi & periode wajib ada)', () => {
    const hasilAnggota = buildDaftarAnggotaExport(INFO, [], '2026-08-11');
    expect(hasilAnggota.namaKoperasi).toBe('Koperasi Sejahtera');
    expect(hasilAnggota.periodeLabel.length).toBeGreaterThan(0);
  });

  test('buildDataBankExport (Phase 17 §P; audit ulang request baru §4: kolom Nama Pemilik/Rekening ditambahkan): hanya kolom bank, total saldo benar, TIDAK ada baris Kas Tunai/Kas Kecil karena caller sudah memfilter', () => {
    const daftar = [
      { nama: 'BCA — 1234567890', nomorRekening: '1234567890', namaPemilik: 'Koperasi Sejahtera', saldo: 5_000_000, aktif: true },
      { nama: 'Mandiri — 9999999999', nomorRekening: '9999999999', saldo: 2_000_000, aktif: false },
    ];
    const hasil = buildDataBankExport(INFO, daftar);
    expect(hasil.kolom).toEqual(['Nama Bank', 'Nomor Rekening', 'Nama Pemilik/Rekening', 'Saldo', 'Status']);
    expect(hasil.baris).toEqual([
      ['BCA', '1234567890', 'Koperasi Sejahtera', 5_000_000, 'Aktif'],
      ['Mandiri', '9999999999', '-', 2_000_000, 'Nonaktif'],
    ]);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Saldo Bank')?.nilai).toBe('Rp7.000.000');
  });

  test('buildKolektibilitasExport (§4G, audit ulang §23-25): kolom lengkap (termasuk Saldo Pokok Outstanding), ringkasan per kategori, total OUTSTANDING (pokok saja, bukan pokok+jasa) & cadangan benar', () => {
    const daftar = [
      {
        pinjamanId: 'p1',
        nomorPinjaman: 'PJ-p1',
        anggotaId: 'a1',
        nomorAnggota: 'A001',
        namaAnggota: 'Budi',
        statusAnggota: 'AKTIF',
        saldoPiutang: 12_000_000, // pokok 10jt + jasa 2jt belum terbayar
        saldoPokok: 10_000_000,
        saldoJasa: 2_000_000,
        tanggalJatuhTempoTertunggak: '2026-01-01',
        hariTunggakan: 200,
        polaPengembalian: 'ANGSURAN' as const,
        masaAngsuranBulan: 1,
        bulanTunggakanPokok: 6,
        bulanTunggakanJasa: 6,
        nilaiAgunan: 0,
        angsuranTerbayar: 0,
        kewajibanKontraktual: 12_000_000,
        rasioAngsuranPersen: 0,
        rasioAgunanPersen: 0,
        bulanSejakDiragukan: 0,
        kolektibilitas: 'MACET' as const,
        dasarPenggolongan: 'Macet — tunggakan pokok 6 bulan, tidak memenuhi kriteria Diragukan.',
        bermasalah: true,
        persentaseCadangan: 100,
        nilaiCadangan: 10_000_000,
      },
      {
        pinjamanId: 'p2',
        nomorPinjaman: 'PJ-p2',
        anggotaId: 'a2',
        nomorAnggota: 'A002',
        namaAnggota: 'Sari',
        statusAnggota: 'AKTIF',
        saldoPiutang: 4_500_000, // pokok 4jt + jasa 500rb belum terbayar
        saldoPokok: 4_000_000,
        saldoJasa: 500_000,
        tanggalJatuhTempoTertunggak: null,
        hariTunggakan: 0,
        polaPengembalian: 'ANGSURAN' as const,
        masaAngsuranBulan: 1,
        bulanTunggakanPokok: 0,
        bulanTunggakanJasa: 0,
        nilaiAgunan: 5_000_000,
        angsuranTerbayar: 1_500_000,
        kewajibanKontraktual: 6_000_000,
        rasioAngsuranPersen: 25,
        rasioAgunanPersen: 111.1,
        bulanSejakDiragukan: 0,
        kolektibilitas: 'LANCAR' as const,
        dasarPenggolongan: 'Lancar — tunggakan pokok 0 bulan, belum melampaui ambang Kurang Lancar.',
        bermasalah: false,
        // DIPERBARUI RC-S133.6.3 (temuan audit P2): fixture dulu memberi
        // Lancar 0,5% / Rp20.000 — itu persentase FISKAL PMK 74, bukan
        // cadangan buku SOM (Lancar 0%, PERSENTASE_PENYISIHAN_SOM.LANCAR).
        // Fixture diselaraskan dengan aturan SOM; total ikut menjadi Rp10.000.000.
        persentaseCadangan: 0,
        nilaiCadangan: 0,
      },
    ];
    const hasil = buildKolektibilitasExport(INFO, 'Tahun Buku 2026', daftar);
    expect(hasil.judulLaporan).toBe('Kolektibilitas Piutang Pinjaman Anggota');
    // Kolom SOM (pola pengembalian, bulan tunggakan pokok/jasa, agunan,
    // dasar penggolongan) ikut diekspor supaya hasil penggolongan bisa
    // ditelusuri pemeriksa tanpa membuka aplikasi.
    expect(hasil.kolom).toEqual([
      'No Anggota', 'Nama Anggota', 'No Pinjaman', 'Saldo Piutang (Pokok+Jasa)', 'Saldo Pokok (Outstanding)',
      'Tanggal Jatuh Tempo', 'Hari Tunggakan', 'Pola Pengembalian', 'Tunggakan Pokok (bulan)',
      'Tunggakan Jasa (bulan)', 'Angsuran Terbayar', 'Angsuran / Kewajiban (%)',
      'Nilai Agunan', 'Agunan / Sisa Utang (%)', 'Kolektibilitas (SOM)',
      'Dasar Penggolongan', '% Penyisihan', 'Nilai Penyisihan', 'Status Anggota',
    ]);
    expect(hasil.baris).toHaveLength(2);
    expect(hasil.baris[0]).toEqual([
      'A001', 'Budi', 'PJ-p1', 12_000_000, 10_000_000, '2026-01-01', 200, 'Dengan Angsuran', 6, 6,
      0, '0.0', 0, '0.0',
      'Macet', 'Macet — tunggakan pokok 6 bulan, tidak memenuhi kriteria Diragukan.', '100%', 10_000_000, 'AKTIF',
    ]);
    // Total HARUS berbasis saldoPokok (10jt + 4jt = 14jt) — BUKAN
    // saldoPiutang (12jt + 4,5jt = 16,5jt).
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Outstanding')?.nilai).toBe('Rp14.000.000');
    expect(
      hasil.ringkasan?.find((r) => r.label === 'Taksiran Piutang Tak Tertagih (SOM angka 15)')?.nilai
    ).toBe('Rp10.000.000'); // DIPERBARUI RC-S133.6.3 — lihat koreksi fixture di atas (sebelumnya Rp10.020.000).
    // Rasio pinjaman bermasalah: hanya p1 (Macet) yang bermasalah ->
    // 10jt / 14jt = 71,43%.
    expect(
      hasil.ringkasan?.find((r) => r.label?.startsWith('Pinjaman Bermasalah'))?.nilai
    ).toBe('Rp10.000.000 — 71.43% dari outstanding');
    // Kategori SOM yang ditampilkan ringkasan PERSIS 4, tanpa kategori
    // perbankan "Dalam Perhatian".
    const labelRingkasan = (hasil.ringkasan ?? []).map((r) => r.label);
    expect(labelRingkasan.some((l) => l?.includes('Dalam Perhatian'))).toBe(false);
    expect(labelRingkasan.some((l) => l?.startsWith('Kurang Lancar'))).toBe(true);
  });

  test('buildDaftarAsetExport (§10, diaudit ulang §12): kolom lengkap termasuk Jenis Aset & akumulasi penyusutan/amortisasi & nilai buku, total benar', () => {
    const daftar = [
      {
        nomorAset: 'AST-1',
        namaAset: 'Mesin Fotokopi',
        kelompokAset: 'Kelompok 1',
        subKelompokAset: 'Mesin Kantor',
        masaManfaatBulan: 48,
        nilaiPerolehan: 10_000_000,
        tanggalPerolehan: '2026-01-01',
        akumulasiPenyusutan: 1_000_000,
        nilaiBuku: 9_000_000,
        status: 'AKTIF' as const,
        jenisAset: 'TETAP' as const,
      },
      {
        nomorAset: 'AST-2',
        namaAset: 'Aset Lama',
        kelompokAset: null,
        subKelompokAset: null,
        masaManfaatBulan: 36,
        nilaiPerolehan: 3_000_000,
        tanggalPerolehan: '2025-06-01',
        akumulasiPenyusutan: 3_000_000,
        nilaiBuku: 0,
        status: 'DIHAPUS' as const,
        jenisAset: 'TETAP' as const,
      },
      {
        nomorAset: 'AST-3',
        namaAset: 'Hak Cipta Software',
        kelompokAset: null,
        subKelompokAset: null,
        masaManfaatBulan: 60,
        nilaiPerolehan: 20_000_000,
        tanggalPerolehan: '2026-01-01',
        akumulasiPenyusutan: 2_000_000,
        nilaiBuku: 18_000_000,
        status: 'AKTIF' as const,
        jenisAset: 'TAK_BERWUJUD' as const,
      },
    ];
    const hasil = buildDaftarAsetExport(INFO, daftar);
    expect(hasil.judulLaporan).toBe('Daftar Aset Tetap');
    expect(hasil.kolom).toContain('Jenis Aset');
    expect(hasil.kolom).toContain('Akumulasi Penyusutan/Amortisasi');
    expect(hasil.baris[0]).toEqual(['AST-1', 'Mesin Fotokopi', 'Kelompok 1', 'Mesin Kantor', 'Aset Tetap', '48 bulan', 10_000_000, '2026-01-01', 1_000_000, 9_000_000, 'Aktif']);
    expect(hasil.baris[1]).toEqual(['AST-2', 'Aset Lama', 'Belum Diklasifikasikan', '-', 'Aset Tetap', '36 bulan', 3_000_000, '2025-06-01', 3_000_000, 0, 'Nonaktif']);
    expect(hasil.baris[2]).toEqual(['AST-3', 'Hak Cipta Software', 'Belum Diklasifikasikan', '-', 'Aset Tak Berwujud', '60 bulan', 20_000_000, '2026-01-01', 2_000_000, 18_000_000, 'Aktif']);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Nilai Perolehan')?.nilai).toBe('Rp33.000.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Nilai Buku')?.nilai).toBe('Rp27.000.000');
  });

  test('buildDaftarInvestasiExport (§11, audit ulang §2/§3): kolom sesuai spesifikasi baru (termasuk Nomor Rekening Investasi & Lokasi Properti), label jenis baru benar, total hanya dari status AKTIF', () => {
    const daftar = [
      { nomorInvestasi: 'INV-1', jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'Koperasi Sejahtera', jumlah: 5_000_000, tanggal: '2026-01-01', sumberDana: 'KAS', keterangan: null, status: 'AKTIF', nomorRekeningInvestasi: null, lokasiProperti: null },
      { nomorInvestasi: 'INV-2', jenisInvestasi: 'UNIT_USAHA', namaTujuan: 'Unit Usaha Toko', jumlah: 2_000_000, tanggal: '2025-01-01', sumberDana: 'BANK', keterangan: 'Lama', status: 'DIBATALKAN', nomorRekeningInvestasi: null, lokasiProperti: null },
      { nomorInvestasi: 'INV-3', jenisInvestasi: 'DEPOSITO_BANK_UMUM', namaTujuan: 'Bank Mandiri', jumlah: 10_000_000, tanggal: '2026-02-01', sumberDana: 'BANK', keterangan: null, status: 'AKTIF', nomorRekeningInvestasi: '1234567890', lokasiProperti: null },
      { nomorInvestasi: 'INV-4', jenisInvestasi: 'PROPERTI_INVESTASI', namaTujuan: 'Ruko 2 Lantai', jumlah: 500_000_000, tanggal: '2026-03-01', sumberDana: 'BANK', keterangan: null, status: 'AKTIF', nomorRekeningInvestasi: null, lokasiProperti: 'Jl. Sudirman No. 10' },
    ];
    const hasil = buildDaftarInvestasiExport(INFO, daftar);
    expect(hasil.judulLaporan).toBe('Daftar Investasi');
    expect(hasil.kolom).toEqual([
      'Tanggal', 'Jenis Investasi', 'Nama Tujuan', 'Nominal', 'Rekening',
      'Nomor Rekening Investasi', 'Lokasi Properti', 'Keterangan', 'Status',
    ]);
    expect(hasil.baris[0]).toEqual(['2026-01-01', 'Penyertaan pada Koperasi Lain', 'Koperasi Sejahtera', 5_000_000, 'Kas', '-', '-', '-', 'Aktif']);
    expect(hasil.baris[1]).toEqual(['2025-01-01', 'Unit Usaha Internal', 'Unit Usaha Toko', 2_000_000, 'Bank', '-', '-', 'Lama', 'Dibatalkan']);
    expect(hasil.baris[2]).toEqual(['2026-02-01', 'Deposito', 'Bank Mandiri', 10_000_000, 'Bank', '1234567890', '-', '-', 'Aktif']);
    expect(hasil.baris[3]).toEqual(['2026-03-01', 'Properti Investasi', 'Ruko 2 Lantai', 500_000_000, 'Bank', '-', 'Jl. Sudirman No. 10', '-', 'Aktif']);
    // Total AKTIF: 5jt + 10jt + 500jt = 515jt (2jt DIBATALKAN tidak dihitung).
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Investasi Aktif')?.nilai).toBe('Rp515.000.000');
  });

  test('buildUtangExport (§E): kolom sesuai spesifikasi, total pokok & sisa kewajiban benar', () => {
    const daftar = [
      {
        nomorUtang: 'UTG-1',
        tanggal: '2026-01-01',
        namaPemberi: 'Bank BRI',
        jenisPemberi: 'BANK',
        pokokPinjaman: 10_000_000,
        persenBunga: 1.5, basisBunga: 'BULANAN',
        status: 'AKTIF',
        sisaPokok: 8_000_000,
        sumber: 'LANGSUNG',
        keterangan: 'Modal kerja',
      },
      {
        nomorUtang: 'UTG-2',
        tanggal: '2025-06-01',
        namaPemberi: 'Toko ABC',
        jenisPemberi: 'UTANG_USAHA',
        pokokPinjaman: 3_000_000,
        persenBunga: 0,
        status: 'LUNAS',
        sisaPokok: 0,
        sumber: 'PEMBELIAN_ASET',
        keterangan: null,
      },
    ];
    const hasil = buildUtangExport(INFO, daftar);
    expect(hasil.judulLaporan).toBe('Daftar Utang Koperasi');
    expect(hasil.kolom).toEqual(['Nomor Utang', 'Tanggal', 'Nama Pemberi', 'Jenis Pemberi', 'Pokok Pinjaman', 'Bunga (%)', 'Sisa Kewajiban', 'Sumber', 'Status', 'Keterangan']);
    expect(hasil.baris[0]).toEqual(['UTG-1', '2026-01-01', 'Bank BRI', 'Bank', 10_000_000, 1.5, 8_000_000, 'Langsung', 'Aktif', 'Modal kerja']);
    expect(hasil.baris[1]).toEqual(['UTG-2', '2025-06-01', 'Toko ABC', 'Utang Usaha (Pembelian Aset)', 3_000_000, 0, 0, 'Pembelian Aset', 'Lunas', '-']);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Pokok Pinjaman')?.nilai).toBe('Rp13.000.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Sisa Kewajiban (Aktif)')?.nilai).toBe('Rp8.000.000');
  });
});

describe('buildBuktiBayarUtangExport (update pasca-6-perbaikan §2)', () => {
  test('kolom & nilai sesuai spesifikasi, total pembayaran benar', () => {
    const item = {
      id: 'up-1',
      nomorBukti: 'KWJ-2026-000001',
      tanggal: '2026-02-01',
      nomorUtang: 'UTG-2026-000001',
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      jumlahPembayaran: 2_100_000,
      porsiPokok: 2_000_000,
      porsiBunga: 100_000,
      sumberDana: 'KAS',
      keterangan: 'Pembayaran utang UTG-2026-000001',
      dibuatOleh: 'User Admin Uji',
    };
    const hasil = buildBuktiBayarUtangExport(INFO, item);
    expect(hasil.judulLaporan).toBe('Bukti Bayar Utang');
    expect(hasil.namaFileDasar).toBe('bukti-bayar-utang-KWJ-2026-000001');
    expect(hasil.baris).toContainEqual(['Porsi Pokok', 2_000_000]);
    expect(hasil.baris).toContainEqual(['Porsi Bunga/Jasa', 100_000]);
    expect(hasil.baris).toContainEqual(['Pihak Pemberi', 'Bank BRI']);
    expect(hasil.baris).toContainEqual(['Jenis Pemberi', 'Bank']);
    expect(hasil.baris).toContainEqual(['Dibuat Oleh', 'User Admin Uji']);
    expect(hasil.ringkasan?.find((r) => r.label === 'Total Pembayaran')?.nilai).toBe('Rp2.100.000');
  });
});

describe('buildAnggotaDetailExport (permintaan pengguna §5): Pinjaman Pokok & Jasa Pinjaman', () => {
  test('menampilkan Pinjaman Pokok (Sisa) & Jasa Pinjaman (Sisa) TANPA double count — keduanya menjumlah PERSIS ke Sisa Pinjaman', () => {
    const anggota: Anggota = {
      id: 'a1',
      nomorAnggota: 'A001',
      nik: '1234567890123456',
      namaLengkap: 'Budi Santoso',
      tanggalBergabung: '2020-01-01',
      status: 'AKTIF',
    };
    const hasil = buildAnggotaDetailExport(
      INFO,
      anggota,
      {
        simpananPokok: 500_000,
        simpananWajib: 1_000_000,
        simpananSukarela: 2_000_000,
        totalPinjaman: 10_000_000,
        totalAngsuran: 3_000_000,
        sisaPinjaman: 7_500_000,
        sisaPinjamanPokok: 6_000_000,
        sisaJasaPinjaman: 1_500_000,
      },
      [],
      '2026-06-01'
    );
    expect(hasil.ringkasan?.find((r) => r.label === 'Sisa Pinjaman')?.nilai).toBe('Rp7.500.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Pinjaman Pokok (Sisa)')?.nilai).toBe('Rp6.000.000');
    expect(hasil.ringkasan?.find((r) => r.label === 'Jasa Pinjaman (Sisa)')?.nilai).toBe('Rp1.500.000');
    // 6.000.000 + 1.500.000 = 7.500.000 — tidak ada double count.
  });
});
