import {
  cariBarisHeader,
  normalkanHeader,
  parseBerkasDataAwal,
  parseRupiah,
  parseSheetAnggota,
  parseSheetBerjangka,
  parseSheetAset,
  parseSheetJasa,
  parseSheetPinjaman,
  parseSheetSimpanan,
  parseTanggal,
  URUTAN_PROSES,
} from '@/import/ExcelDataAwalParser';

describe('parseRupiah — angka gaya Indonesia & Excel', () => {
  test('angka Excel asli dipakai apa adanya (dibulatkan ke rupiah)', () => {
    expect(parseRupiah(1_500_000)).toBe(1_500_000);
    expect(parseRupiah(1500.4)).toBe(1500);
    expect(parseRupiah(1500.6)).toBe(1501);
  });

  test('titik sebagai pemisah ribuan TIDAK dibaca sebagai desimal', () => {
    // Ini kesalahan paling merusak kalau salah: 1.500.000 menjadi 1,5.
    expect(parseRupiah('1.500.000')).toBe(1_500_000);
    expect(parseRupiah('250.000')).toBe(250_000);
    expect(parseRupiah('1,500,000')).toBe(1_500_000);
  });

  test('awalan Rp, spasi, dan tanda kurung negatif', () => {
    expect(parseRupiah('Rp 1.500.000')).toBe(1_500_000);
    expect(parseRupiah('rp1.500.000')).toBe(1_500_000);
    expect(parseRupiah(' 2.000.000 ')).toBe(2_000_000);
    expect(parseRupiah('(500.000)')).toBe(-500_000);
    expect(parseRupiah('-500.000')).toBe(-500_000);
  });

  test('desimal dikenali dari posisi, bukan dari jenis tandanya', () => {
    expect(parseRupiah('1.500,50')).toBe(1501);
    expect(parseRupiah('1,500.50')).toBe(1501);
  });

  test('kosong / bukan angka -> null (pemanggil yang memutuskan)', () => {
    expect(parseRupiah('')).toBeNull();
    expect(parseRupiah('   ')).toBeNull();
    expect(parseRupiah(null)).toBeNull();
    expect(parseRupiah(undefined)).toBeNull();
    expect(parseRupiah('seratus ribu')).toBeNull();
  });
});

describe('parseTanggal — serial Excel & beberapa format teks', () => {
  test('angka serial Excel (kasus tersering) dibaca tanpa geser sehari', () => {
    expect(parseTanggal(45000)).toBe('2023-03-15');
    expect(parseTanggal(46023)).toBe('2026-01-01');
  });

  test('angka kecil / tahun saja di kolom tanggal DITOLAK, bukan jadi tanggal 1900-an', () => {
    // Tanpa batas kewajaran: 12 -> 1900-01-12 dan 2026 -> 1905-07-18,
    // keduanya tersimpan diam-diam sebagai tanggal koperasi yang mustahil.
    expect(parseTanggal(1)).toBeNull();
    expect(parseTanggal(12)).toBeNull();
    expect(parseTanggal(2026)).toBeNull();
    expect(parseTanggal(-5)).toBeNull();
  });

  test('batas kewajaran TIDAK berlaku untuk tanggal berbentuk teks (tanggal lahir tua tetap bisa)', () => {
    expect(parseTanggal('1948-05-01')).toBe('1948-05-01');
    expect(parseTanggal('01/05/1948')).toBe('1948-05-01');
  });

  test('objek Date dan teks ISO', () => {
    expect(parseTanggal(new Date(2026, 0, 31))).toBe('2026-01-31');
    expect(parseTanggal('2026-01-31')).toBe('2026-01-31');
    expect(parseTanggal('2026-1-5')).toBe('2026-01-05');
  });

  test('format Indonesia hari/bulan/tahun', () => {
    expect(parseTanggal('31/01/2026')).toBe('2026-01-31');
    expect(parseTanggal('31-01-2026')).toBe('2026-01-31');
    expect(parseTanggal('5/3/2026')).toBe('2026-03-05');
  });

  test('tanggal yang tidak ada DITOLAK, bukan digeser diam-diam', () => {
    // `new Date(2026,1,31)` akan menggeser ke 3 Maret — perilaku itu
    // justru berbahaya untuk data awal koperasi.
    expect(parseTanggal('31/02/2026')).toBeNull();
    expect(parseTanggal('2026-02-30')).toBeNull();
    expect(parseTanggal('2026-13-01')).toBeNull();
  });

  test('kosong / tidak dikenali -> null', () => {
    expect(parseTanggal('')).toBeNull();
    expect(parseTanggal(null)).toBeNull();
    expect(parseTanggal('Januari 2026')).toBeNull();
  });
});

describe('normalkanHeader & cariBarisHeader — bentuk kolom yang longgar', () => {
  test('perbedaan penulisan nama kolom dianggap sama', () => {
    const sama = ['Nama Lengkap', 'nama_lengkap', 'NAMA  LENGKAP', 'Nama Lengkap *', 'nama-lengkap'];
    for (const v of sama) expect(normalkanHeader(v)).toBe('namalengkap');
    expect(normalkanHeader('Bunga Persen Per Tahun (%)')).toBe('bungapersenpertahun');
  });

  test('baris judul & catatan di atas tabel dilewati', () => {
    const sheet = [
      ['DATA ANGGOTA KOPERASI'],
      ['Isi mulai baris di bawah ini'],
      [],
      ['Kode Anggota', 'Nama Lengkap'],
      ['A1', 'Budi'],
    ];
    expect(cariBarisHeader(sheet, ['kodeanggota', 'namalengkap'])).toBe(3);
  });

  test('header tidak lengkap -> tidak ditemukan', () => {
    expect(cariBarisHeader([['Kode Anggota']], ['kodeanggota', 'namalengkap'])).toBe(-1);
  });
});

describe('parseSheetAnggota', () => {
  const header = ['Kode Anggota', 'Nama Lengkap', 'NIK', 'Jenis Kelamin', 'Tanggal Bergabung'];

  test('baris sah terbaca; urutan kolom bebas', () => {
    const s = parseSheetAnggota([
      ['Nama Lengkap', 'Tanggal Bergabung', 'Kode Anggota'],
      ['Budi Santoso', '31/01/2026', 'A1'],
    ]);
    expect(s.terbaca).toBe(true);
    expect(s.galat).toEqual([]);
    expect(s.baris[0]).toMatchObject({ kode: 'A1', namaLengkap: 'Budi Santoso', tanggalBergabung: '2026-01-31' });
  });

  test('baris kosong diabaikan, bukan dianggap galat', () => {
    const s = parseSheetAnggota([header, ['A1', 'Budi', '', '', '2026-01-01'], [], ['', '', '', '', ''], ['A2', 'Sari', '', '', '2026-01-02']]);
    expect(s.baris).toHaveLength(2);
    expect(s.galat).toEqual([]);
  });

  test('kolom wajib kosong dilaporkan dengan NOMOR BARIS Excel', () => {
    const s = parseSheetAnggota([header, ['', 'Budi', '', '', '2026-01-01'], ['A2', '', '', '', '2026-01-01']]);
    expect(s.baris).toHaveLength(0);
    expect(s.galat).toEqual([
      { baris: 2, pesan: 'Kode Anggota wajib diisi.' },
      { baris: 3, pesan: 'Nama Lengkap wajib diisi.' },
    ]);
  });

  test('jenis kelamin: pengguna mengetik L/P, parser mengembalikan nilai DOMAIN aplikasi', () => {
    // Kolom `anggota.jenis_kelamin` punya CHECK constraint
    // IN ('LAKI_LAKI','PEREMPUAN'). Mengembalikan 'L'/'P' apa adanya
    // membuat SELURUH baris anggota ditolak database — dan karena baris
    // simpanan/pinjaman menunjuk anggota itu, seluruh import ikut gagal.
    const s = parseSheetAnggota([
      header,
      ['A1', 'Budi', '', 'L', '2026-01-01'],
      ['A2', 'Sari', '', 'Perempuan', '2026-01-01'],
      ['A3', 'Tini', '', 'p', '2026-01-01'],
      ['A4', 'Tono', '', 'X', '2026-01-01'],
    ]);
    expect(s.baris.map((b) => b.jenisKelamin)).toEqual(['LAKI_LAKI', 'PEREMPUAN', 'PEREMPUAN']);
    expect(s.galat[0].pesan).toContain('Jenis Kelamin');
  });

  test('NIK wajib 16 digit bila diisi, tetapi boleh kosong', () => {
    const s = parseSheetAnggota([
      header,
      ['A1', 'Budi', '1234567890123456', '', '2026-01-01'],
      ['A2', 'Sari', '', '', '2026-01-01'],
      ['A3', 'Tono', '123', '', '2026-01-01'],
    ]);
    expect(s.baris).toHaveLength(2);
    expect(s.baris[0].nik).toBe('1234567890123456');
    expect(s.baris[1].nik).toBeNull();
    expect(s.galat[0]).toMatchObject({ baris: 4 });
    expect(s.galat[0].pesan).toContain('16 digit');
  });

  test('sheet tidak ada -> terbaca false dengan alasan', () => {
    const s = parseSheetAnggota(undefined);
    expect(s.terbaca).toBe(false);
    expect(s.galatSheet).toContain('tidak ditemukan');
  });
});

describe('parseSheetSimpanan', () => {
  const header = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela', 'Sumber Dana'];

  test('angka 0 diterima; Sumber Dana default KAS', () => {
    const s = parseSheetSimpanan([header, ['A1', '2026-01-01', '100.000', '0', '0', '']]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0]).toMatchObject({ pokok: 100_000, wajib: 0, sukarela: 0, sumberDana: 'KAS' });
  });

  test('RC-S124: sel Pokok/Wajib/Sukarela yang KOSONG ditolak — harus ditulis 0', () => {
    const s = parseSheetSimpanan([
      header,
      ['A1', '2026-01-01', '', '50000', '0', 'KAS'],
      ['A2', '2026-01-01', '100000', '', '0', 'KAS'],
      ['A3', '2026-01-01', '100000', '50000', '', 'KAS'],
    ]);
    expect(s.baris).toHaveLength(0);
    expect(s.galat.map((g) => g.pesan)).toEqual([
      'Simpanan Pokok wajib diisi — tulis 0 bila tidak ada.',
      'Simpanan Wajib wajib diisi — tulis 0 bila tidak ada.',
      'Simpanan Sukarela wajib diisi — tulis 0 bila tidak ada.',
    ]);
  });

  test('RC-S124: sheet tanpa kolom Simpanan Wajib/Sukarela ditolak di tingkat sheet', () => {
    const s = parseSheetSimpanan([['Kode Anggota', 'Tanggal', 'Simpanan Pokok'], ['A1', '2026-01-01', '100000']]);
    expect(s.terbaca).toBe(false);
    expect(s.galatSheet).toContain('simpananwajib');
  });

  test('semua nominal 0 ditolak — tidak ada yang bisa dicatat', () => {
    const s = parseSheetSimpanan([header, ['A1', '2026-01-01', '0', '0', '0', 'KAS']]);
    expect(s.baris).toHaveLength(0);
    expect(s.galat[0].pesan).toContain('minimal salah satu');
  });

  test('nominal negatif & Sumber Dana asing ditolak', () => {
    const s = parseSheetSimpanan([
      header,
      ['A1', '2026-01-01', '-100', '0', '0', 'KAS'],
      ['A2', '2026-01-01', '100000', '0', '0', 'DOMPET'],
    ]);
    expect(s.galat.map((g) => g.baris)).toEqual([2, 3]);
    expect(s.galat[1].pesan).toContain('KAS atau BANK');
  });

  test('TUNAI diterima sebagai KAS', () => {
    const s = parseSheetSimpanan([header, ['A1', '2026-01-01', '100000', '0', '0', 'Tunai']]);
    expect(s.baris[0].sumberDana).toBe('KAS');
  });
});

describe('parseSheetPinjaman', () => {
  const header = [
    'Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor',
    'Metode Jasa', 'Jasa Persen', 'Sumber Dana', 'Angsuran Sudah Dibayar',
  ];

  test('baris sah; satuan & metode default BULAN/FLAT bila kosong', () => {
    const s = parseSheetPinjaman([header, ['A1', '01/02/2026', 'Rp 12.000.000', '12', '', '', '1', '', '']]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0]).toMatchObject({
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      sumberDana: 'KAS',
      angsuranSudahDibayar: 0,
    });
  });

  test('jasa persen menerima tanda % dan koma desimal', () => {
    const s = parseSheetPinjaman([header, ['A1', '2026-02-01', '12000000', '12', 'BULAN', 'FLAT', '1,5%', 'KAS', '0']]);
    expect(s.baris[0].persentaseJasa).toBe(1.5);
  });

  test('angsuran sudah dibayar tidak boleh melebihi tenor', () => {
    const s = parseSheetPinjaman([header, ['A1', '2026-02-01', '12000000', '12', 'BULAN', 'FLAT', '1', 'KAS', '13']]);
    expect(s.baris).toHaveLength(0);
    expect(s.galat[0].pesan).toContain('melebihi Tenor');
  });

  test('jumlah 0 / tenor bukan bilangan bulat ditolak', () => {
    const s = parseSheetPinjaman([
      header,
      ['A1', '2026-02-01', '0', '12', 'BULAN', 'FLAT', '1', 'KAS', '0'],
      ['A1', '2026-02-01', '12000000', '0', 'BULAN', 'FLAT', '1', 'KAS', '0'],
    ]);
    expect(s.baris).toHaveLength(0);
    expect(s.galat).toHaveLength(2);
  });

  test('satuan tenor / metode jasa asing ditolak dengan pesan jelas', () => {
    const s = parseSheetPinjaman([
      header,
      ['A1', '2026-02-01', '12000000', '12', 'TAHUN', 'FLAT', '1', 'KAS', '0'],
      ['A1', '2026-02-01', '12000000', '12', 'BULAN', 'ANUITAS', '1', 'KAS', '0'],
    ]);
    expect(s.galat[0].pesan).toContain('HARI, MINGGU, atau BULAN');
    expect(s.galat[1].pesan).toContain('FLAT, MENURUN, atau EFEKTIF');
  });
});

describe('parseSheetBerjangka', () => {
  const header = ['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan', 'Bunga Persen Per Tahun', 'Sumber Dana'];

  test('baris sah; bunga boleh kosong (tanpa bunga)', () => {
    const s = parseSheetBerjangka([header, ['A1', '2026-01-01', '10.000.000', '12', '', 'BANK']]);
    expect(s.baris[0]).toMatchObject({ nominal: 10_000_000, tenorBulan: 12, sukuBungaPerTahun: null, sumberDana: 'BANK' });
  });

  test('hanya tenor 3, 6, 12 yang sah', () => {
    const s = parseSheetBerjangka([
      header,
      ['A1', '2026-01-01', '10000000', '3', '6', 'KAS'],
      ['A2', '2026-01-01', '10000000', '6', '6', 'KAS'],
      ['A3', '2026-01-01', '10000000', '9', '6', 'KAS'],
    ]);
    expect(s.baris.map((b) => b.tenorBulan)).toEqual([3, 6]);
    expect(s.galat[0].pesan).toContain('hanya 3, 6, atau 12');
  });
});

describe('parseBerkasDataAwal — pemeriksaan lintas sheet', () => {
  const anggota = [
    ['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'],
    ['A1', 'Budi', '2026-01-01'],
    ['A2', 'Sari', '2026-01-01'],
  ];

  // DIPERBARUI RC-S107: sheet ASET ditambahkan di URUTAN TERAKHIR.
  // Bukan sekadar menambah nama: aset diproses paling akhir karena
  // periode penyusutan masa lalunya merujuk jurnal saldo awal
  // Akumulasi Penyusutan, yang baru ada setelah seluruh buku pembantu
  // lain selesai dihitung.
  // DIPERBARUI RC-S133.4.3: sheet JASA (6. Jasa Dibayar) PALING AKHIR —
  // ia menunjuk anggota yang baru dibuat di tahap pertama.
  test('urutan proses: anggota, simpanan, berjangka, pinjaman, aset, lalu jasa dibayar', () => {
    expect(URUTAN_PROSES).toEqual(['ANGGOTA', 'SIMPANAN', 'BERJANGKA', 'PINJAMAN', 'ASET', 'JASA']);
  });

  test('berkas bersih -> siapDiimpor true dengan jumlah baris benar', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: anggota,
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'], ['A1', '2026-01-02', '100000', '0', '0']],
      PINJAMAN: [['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor'], ['A2', '2026-02-01', '5000000', '6']],
      BERJANGKA: [['Kode Anggota', 'Tanggal Penempatan', 'Nominal', 'Tenor Bulan'], ['A1', '2026-01-03', '1000000', '6']],
    });
    expect(r.totalGalat).toBe(0);
    expect(r.totalBarisSah).toBe(5);
    expect(r.siapDiimpor).toBe(true);
  });

  test('kode anggota ganda dilaporkan sebagai galat umum', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [...anggota, ['A1', 'Budi Kedua', '2026-01-01']],
    });
    expect(r.galatUmum.join(' ')).toContain('"A1" dipakai lebih dari satu kali');
    expect(r.siapDiimpor).toBe(false);
  });

  test('kode salah ketik di sheet lain: dilaporkan DAN barisnya tidak ikut diimpor', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: anggota,
      SIMPANAN: [
        ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'],
        ['A1', '2026-01-02', '100000', '0', '0'],
        ['A9', '2026-01-02', '100000', '0', '0'],
      ],
    });
    expect(r.hasil.simpanan.baris).toHaveLength(1);
    expect(r.hasil.simpanan.galat[0]).toMatchObject({ baris: 3 });
    expect(r.hasil.simpanan.galat[0].pesan).toContain('tidak ada di sheet');
    expect(r.siapDiimpor).toBe(false);
  });

  test('kode dicocokkan tanpa membedakan huruf besar/kecil', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: anggota,
      SIMPANAN: [['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'], ['a1', '2026-01-02', '100000', '0', '0']],
    });
    expect(r.hasil.simpanan.baris).toHaveLength(1);
    expect(r.totalGalat).toBe(0);
  });

  test('berkas tanpa baris sama sekali -> tidak siap diimpor', () => {
    const r = parseBerkasDataAwal({});
    expect(r.siapDiimpor).toBe(false);
    expect(r.totalBarisSah).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TEMPLATE <-> PARSER: tidak boleh berjalan beda arah
// ---------------------------------------------------------------------------

import {
  ATURAN_UMUM,
  KODE_CONTOH,
  SHEET_TEMPLATE,
  judulKolomExcel,
  sheetTemplateUrutTampilan,
  BARIS_PETUNJUK,
} from '@/import/TemplateDataAwal';

describe('TemplateDataAwal — setiap kolom template DIKENALI parser', () => {
  /**
   * Inilah pengaman terpenting template: kalau judul kolom di template
   * diubah tanpa mengubah parser (atau sebaliknya), berkas yang diunduh
   * pengguna akan ditolak aplikasinya sendiri. Test ini membuat template
   * benar-benar dibaca oleh parser yang sungguhan — bukan dicocokkan
   * dengan daftar nama yang ditulis ulang di sini.
   */
  const parserPerJenis = {
    ANGGOTA: parseSheetAnggota,
    SIMPANAN: parseSheetSimpanan,
    PINJAMAN: parseSheetPinjaman,
    BERJANGKA: parseSheetBerjangka,
    // DIPERBARUI RC-S107: sheet Aset Tetap.
    ASET: parseSheetAset,
    // DIPERBARUI RC-S133.4.3: sheet Jasa Dibayar.
    JASA: parseSheetJasa,
  } as const;

  test.each(SHEET_TEMPLATE.map((s) => [s.jenis, s] as const))(
    'sheet %s: baris contoh template lolos parser tanpa galat',
    (jenis, sheet) => {
      const aoa = [
        [sheet.keterangan],
        [],
        sheet.kolom.map(judulKolomExcel),
        sheet.kolom.map((k) => k.contoh),
      ];
      const hasil = (parserPerJenis[jenis] as (s: unknown[][]) => { terbaca: boolean; galat: unknown[]; baris: unknown[] })(aoa);
      expect(hasil.terbaca).toBe(true);
      expect(hasil.galat).toEqual([]);
      expect(hasil.baris).toHaveLength(1);
    }
  );

  test('kolom WAJIB memang ditolak parser bila dikosongkan', () => {
    // Menjaga metadata `wajib` tetap jujur: kalau suatu kolom ditandai
    // wajib tetapi parser membolehkannya kosong, tanda `*` di Excel dan
    // lencana "Wajib" di aplikasi sama-sama menyesatkan.
    for (const sheet of SHEET_TEMPLATE) {
      const wajib = sheet.kolom.filter((k) => k.wajib);
      expect(wajib.length).toBeGreaterThan(0);
      for (const kolom of wajib) {
        const aoa = [
          sheet.kolom.map(judulKolomExcel),
          sheet.kolom.map((k) => (k === kolom ? '' : k.contoh)),
        ];
        const hasil = (parserPerJenis[sheet.jenis] as (s: unknown[][]) => { galat: unknown[] })(aoa);
        expect(hasil.galat.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('kolom TIDAK wajib memang boleh dikosongkan tanpa galat', () => {
    // Sisi sebaliknya: kolom tanpa tanda `*` harus benar-benar opsional.
    // Tanpa test ini, lencana "Wajib" di aplikasi bisa benar sementara
    // kolom opsionalnya justru ditolak parser.
    for (const sheet of SHEET_TEMPLATE) {
      const opsional = sheet.kolom.filter((k) => !k.wajib);
      const aoa = [
        sheet.kolom.map(judulKolomExcel),
        sheet.kolom.map((k) => (k.wajib ? k.contoh : '')),
      ];
      const hasil = (parserPerJenis[sheet.jenis] as (s: unknown[][]) => { galat: unknown[]; baris: unknown[] })(aoa);
      if (opsional.length > 0) {
        // RC-S124: pengecualian sheet Simpanan dihapus — kolom nominalnya
        // kini wajib, sehingga kolom opsionalnya (Sumber Dana) harus
        // benar-benar boleh kosong seperti sheet lain.
        expect(hasil.galat).toEqual([]);
        expect(hasil.baris).toHaveLength(1);
      }
    }
  });

  test('judul Excel diturunkan dari metadata: tanda * mengikuti `wajib`, pilihan ikut ditulis', () => {
    const kodeAnggota = SHEET_TEMPLATE[0].kolom[0];
    expect(judulKolomExcel(kodeAnggota)).toBe('Kode Anggota *');
    const sumberDana = SHEET_TEMPLATE[1].kolom.find((k) => k.label === 'Sumber Dana')!;
    expect(judulKolomExcel(sumberDana)).toBe('Sumber Dana (KAS/BANK)');
    const tenor = SHEET_TEMPLATE.find((s) => s.jenis === 'PINJAMAN')!.kolom.find((k) => k.label === 'Tenor')!;
    expect(judulKolomExcel(tenor)).toBe('Tenor * (jumlah angsuran)');
    // Dan nama yang dicocokkan parser tetap labelnya, bukan judul lengkapnya.
    expect(normalkanHeader(judulKolomExcel(tenor))).toBe(normalkanHeader(tenor.label));
  });

  test('baris contoh memakai kode CONTOH di setiap sheet yang menunjuk anggota', () => {
    // DIPERBARUI RC-S107: sheet Aset Tetap TIDAK menunjuk anggota, jadi
    // tidak punya kolom Kode Anggota. Penandanya di sana adalah nama
    // aset contoh yang memuat "hapus baris ini" — diuji terpisah di
    // bawah, bukan dilonggarkan dengan melewati sheet begitu saja.
    let diperiksa = 0;
    for (const sheet of SHEET_TEMPLATE) {
      const kodeKolom = sheet.kolom.find((k) => normalkanHeader(k.label) === 'kodeanggota');
      if (!kodeKolom) continue;
      expect(kodeKolom.contoh).toBe(KODE_CONTOH);
      diperiksa += 1;
    }
    expect(diperiksa).toBe(SHEET_TEMPLATE.length - 1);
  });

  test('sheet Aset Tetap menandai baris contohnya dengan kalimat "hapus baris ini"', () => {
    const aset = SHEET_TEMPLATE.find((s) => s.jenis === 'ASET')!;
    const nama = aset.kolom.find((k) => normalkanHeader(k.label) === 'namaaset')!;
    expect(String(nama.contoh).toLowerCase()).toContain('hapus baris ini');
  });

  test('aturan umum tersedia untuk ditampilkan di aplikasi', () => {
    expect(ATURAN_UMUM.length).toBeGreaterThanOrEqual(5);
    for (const a of ATURAN_UMUM) {
      expect(a.judul.length).toBeGreaterThan(0);
      expect(a.isi.length).toBeGreaterThan(20);
    }
  });

  test('tab Excel urut sesuai NOMOR sheetnya, bukan urutan pemrosesan', () => {
    // Kalau tab mengikuti urutan proses, pengguna melihat 1, 2, 4, 3.
    expect(sheetTemplateUrutTampilan().map((s) => s.jenis)).toEqual([
      'ANGGOTA',
      'SIMPANAN',
      'PINJAMAN',
      'BERJANGKA',
      // DIPERBARUI RC-S107: tab "5. Aset Tetap".
      'ASET',
      'JASA', // DIPERBARUI RC-S133.4.3
    ]);
    // Sifat keamanannya tetap dijaga di urutan PROSES: kas harus terisi
    // dari simpanan sebelum pinjaman dicairkan.
    expect(URUTAN_PROSES.indexOf('SIMPANAN')).toBeLessThan(URUTAN_PROSES.indexOf('PINJAMAN'));
    expect(URUTAN_PROSES.indexOf('BERJANGKA')).toBeLessThan(URUTAN_PROSES.indexOf('PINJAMAN'));
    expect(URUTAN_PROSES[0]).toBe('ANGGOTA');
  });

  test('petunjuk menyebut langkah & lokasi menu, bukan sheet kosong', () => {
    const teks = BARIS_PETUNJUK.flat().join(' ');
    expect(teks).toContain('Import Data Awal');
    expect(teks).toContain('Kode Anggota');
    expect(teks).toContain('Backup');
  });
});

// ---------------------------------------------------------------------------
// LAYAR "STRUKTUR TEMPLATE": harus merender dari sumber template, bukan
// mengetik ulang daftar kolomnya sendiri.
// ---------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { join } from 'path';

describe('StrukturTemplateScreen — satu sumber dengan berkas Excel', () => {
  const src = readFileSync(
    join(__dirname, '..', 'screens', 'Pengaturan', 'StrukturTemplateScreen.tsx'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('merender dari SHEET_TEMPLATE & judulKolomExcel, bukan daftar sendiri', () => {
    expect(src).toMatch(/sheetTemplateUrutTampilan\(\)/);
    expect(src).toMatch(/judulKolomExcel\(k\)/);
    expect(src).toMatch(/sheetAktif\.kolom\.map/);
    expect(src).toMatch(/ATURAN_UMUM\.map/);
  });

  it('lencana Wajib diturunkan dari metadata `wajib`, bukan dari tanda bintang pada string', () => {
    // Kalau layar membaca `judul.includes('*')`, tanda wajib di aplikasi
    // bisa berbeda dari yang benar-benar diperiksa parser.
    expect(src).toMatch(/k\.wajib \? 'Wajib' : 'Opsional'/);
    expect(src).not.toMatch(/includes\('\*'\)/);
  });

  it('tidak menuliskan nama kolom template apa pun sebagai teks harfiah', () => {
    // Setiap label kolom harus datang dari SHEET_TEMPLATE. Menemukan
    // label yang diketik langsung di layar berarti daftar kolomnya mulai
    // diduplikasi dan bisa menyimpang dari berkas Excel-nya.
    const labelUnik = [...new Set(SHEET_TEMPLATE.flatMap((s) => s.kolom.map((k) => k.label)))];
    const diketikUlang = labelUnik.filter((l) => src.includes(`'${l}'`) || src.includes(`>${l}<`));
    expect(diketikUlang).toEqual([]);
  });
});
