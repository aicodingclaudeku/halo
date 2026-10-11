/**
 * RC-S87.1 — Teks penjelasan (ikon tanda seru) Pengaturan Pajak.
 *
 * Bahasa awam untuk pengurus/operator koperasi. SEMUA angka (batas omzet,
 * tarif, contoh hitung) dibangun dari `pajakPolicy.ts` — tidak ada tarif
 * yang ditulis ulang di sini, jadi penjelasan otomatis ikut bila kebijakan
 * berganti versi.
 */
import { formatRupiah } from '@/utils/money';
import {
  BATAS_BUNGA_SIMPANAN_PPH_BEBAS,
  hitungPphBadanNonFinal,
  hitungPphBungaSimpanan,
  hitungPphFinal,
  kebijakanUntukTahun,
  LABEL_REZIM,
  TARIF_PPH_BUNGA_SIMPANAN_PERSEN,
} from '@/config/pajakPolicy';

export interface IsiInfo {
  judul: string;
  ringkas: string;
  poin?: string[];
  contoh?: { judul: string; baris: { label: string; nilai: string; tebal?: boolean }[] };
  dasar?: string;
}

export type KunciInfo =
  | 'rezim'
  | 'FINAL_UMKM'
  | 'BADAN_31E'
  | 'BADAN_UMUM'
  | 'penetapan'
  | 'deklarasi'
  | 'tahunTerdaftar'
  | 'peredaranBruto'
  | 'batasFinal'
  | 'batas31E'
  | 'masaFasilitas'
  | 'penetapanManual'
  | 'versiKebijakan'
  | 'jenisUtangPajak'
  | 'masaSetor'
  | 'setorSebagian'
  | 'ntpn'
  | 'caraKerja'
  | 'tugas'
  | 'posisiPajak'
  | 'utangKoperasi'
  | 'utangAnggota'
  | 'kreditPajak'
  | 'pphBadanTahunLalu'
  | 'menuPphFinal'
  | 'menuPph25'
  | 'menuPphBadan'
  | 'menuKoreksiFiskal'
  | 'menuSetor'
  | 'menuRiwayat'
  | 'menuBuktiPotong'
  | 'menuPengaturan';

function rp(n: number): string {
  return formatRupiah(n);
}

export function isiInfoPajak(kunci: KunciInfo, tahun: number): IsiInfo {
  const k = kebijakanUntukTahun(tahun);
  const tarifFinal = `${(k.tarifPphFinalPermil / 10).toLocaleString('id-ID')}%`;
  const tarifFasilitas = (k.tarifPphBadanPersen * (100 - k.persenPenguranganTarif31E)) / 100;
  const nol = { pph25: 0, pph22: 0, pph23: 0, pph24: 0 };

  switch (kunci) {
    case 'rezim':
      return {
        judul: 'Apa itu rezim pajak?',
        ringkas: 'Rezim pajak adalah cara koperasi menghitung dan membayar Pajak Penghasilan (PPh) atas usahanya dalam satu tahun pajak.',
        poin: [
          `${LABEL_REZIM.FINAL_UMKM}: pajak dihitung dari omzet (peredaran bruto) setiap bulan, tidak melihat untung atau rugi.`,
          `${LABEL_REZIM.BADAN_31E}: pajak dihitung dari laba kena pajak setahun, dengan potongan tarif untuk koperasi beromzet sampai ${rp(k.batasPeredaranBrutoPenerima31E)}.`,
          `${LABEL_REZIM.BADAN_UMUM}: pajak dihitung dari laba kena pajak setahun tanpa potongan tarif.`,
          'Aplikasi menentukan rezim secara otomatis dari data Anda. Anda tidak perlu — dan tidak bisa — memilih tarif sendiri.',
        ],
      };
    case 'FINAL_UMKM': {
      const omzet = 100_000_000;
      return {
        judul: LABEL_REZIM.FINAL_UMKM,
        ringkas: `Pajak sebesar ${tarifFinal} dari omzet bulanan. Sederhana, tetapi tetap terutang walaupun koperasi sedang rugi.`,
        poin: [
          `Berlaku selama omzet tahun sebelumnya tidak lebih dari ${rp(k.batasOmzetFinal)} dan masa fasilitas belum habis.`,
          'Dihitung setiap masa (bulan) dari pendapatan yang tercatat di buku besar.',
          'Tidak ada angsuran PPh 25 dan tidak ada perhitungan PPh Badan akhir tahun.',
        ],
        contoh: {
          judul: 'Contoh satu bulan',
          baris: [
            { label: 'Omzet bulan ini', nilai: rp(omzet) },
            { label: `PPh Final ${tarifFinal}`, nilai: rp(hitungPphFinal(omzet)), tebal: true },
          ],
        },
        dasar: 'PP 55/2022 jo. PP 20/2026',
      };
    }
    case 'BADAN_31E': {
      const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 10_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: nol, kebijakan: k });
      return {
        judul: LABEL_REZIM.BADAN_31E,
        ringkas: `PPh Badan non-final (bukan pajak final). Bagian laba yang mendapat fasilitas dikenai tarif efektif ${tarifFasilitas}%, sisanya ${k.tarifPphBadanPersen}%.`,
        poin: [
          `Berlaku untuk koperasi dengan omzet setahun sampai ${rp(k.batasPeredaranBrutoPenerima31E)}.`,
          `Bila omzet sampai ${rp(k.batasPeredaranBrutoBagianFasilitas31E)}, seluruh laba kena pajak mendapat tarif ${tarifFasilitas}%.`,
          `Bila omzet di atas ${rp(k.batasPeredaranBrutoBagianFasilitas31E)}, laba dibagi proporsional: bagian fasilitas ${tarifFasilitas}%, sisanya ${k.tarifPphBadanPersen}%.`,
          'Setiap bulan dibayar angsuran PPh 25; kekurangannya dilunasi sebagai PPh 29 setelah tahun pajak berakhir.',
        ],
        contoh: {
          judul: 'Contoh: omzet Rp10 miliar, laba kena pajak Rp1 miliar',
          baris: [
            { label: 'Laba fasilitas (4,8 M ÷ 10 M × 1 M)', nilai: rp(h.pkpFasilitas) },
            { label: `× ${tarifFasilitas}%`, nilai: rp(h.pphFasilitas) },
            { label: 'Laba non-fasilitas', nilai: rp(h.pkpNonFasilitas) },
            { label: `× ${k.tarifPphBadanPersen}%`, nilai: rp(h.pphNonFasilitas) },
            { label: 'Total PPh Badan', nilai: rp(h.totalPphBadan), tebal: true },
          ],
        },
        dasar: 'UU PPh Pasal 31E jo. Pasal 17 ayat (1) huruf b',
      };
    }
    case 'BADAN_UMUM': {
      const h = hitungPphBadanNonFinal({ rezim: 'BADAN_UMUM', peredaranBruto: 60_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: nol, kebijakan: k });
      return {
        judul: LABEL_REZIM.BADAN_UMUM,
        ringkas: `PPh Badan non-final dengan tarif ${k.tarifPphBadanPersen}% atas seluruh laba kena pajak, tanpa potongan tarif.`,
        poin: [
          `Berlaku bila omzet setahun lebih dari ${rp(k.batasPeredaranBrutoPenerima31E)}, atau ditetapkan demikian oleh dokumen resmi.`,
          'Tetap dibayar lewat angsuran PPh 25 dan pelunasan PPh 29.',
        ],
        contoh: {
          judul: 'Contoh: laba kena pajak Rp1 miliar',
          baris: [{ label: `Rp1.000.000.000 × ${k.tarifPphBadanPersen}%`, nilai: rp(h.totalPphBadan), tebal: true }],
        },
        dasar: 'UU PPh Pasal 17 ayat (1) huruf b',
      };
    }
    case 'penetapan':
      return {
        judul: 'Otomatis atau manual?',
        ringkas: 'Menunjukkan dari mana rezim tahun ini berasal.',
        poin: [
          'Otomatis: dihitung aplikasi dari deklarasi, tahun terdaftar, dan omzet di buku besar. Ini yang dianjurkan.',
          'Manual (berdokumen): ditetapkan pengguna karena ada surat/keputusan pajak resmi. Hasil otomatis tetap ditampilkan sebagai pembanding.',
        ],
      };
    case 'deklarasi':
      return {
        judul: 'Deklarasi PPh Final UMKM',
        ringkas: 'Pernyataan apakah koperasi memakai fasilitas PPh Final UMKM. Ini bukan pilihan tarif.',
        poin: [
          '"Memakai PPh Final": aplikasi memakai PPh Final selama syaratnya terpenuhi, lalu otomatis memindahkan ke PPh Badan bila tidak lagi memenuhi.',
          '"Tidak memakai": koperasi langsung dihitung dengan PPh Badan (fasilitas Pasal 31E atau tarif umum, ditentukan dari omzet).',
          'Koperasi yang sudah keluar dari PPh Final karena omzetnya melewati batas tidak dapat kembali memakainya.',
        ],
      };
    case 'tahunTerdaftar':
      return {
        judul: 'Tahun terdaftar NPWP',
        ringkas: 'Tahun koperasi pertama kali terdaftar sebagai wajib pajak badan (lihat kartu/surat keterangan terdaftar NPWP).',
        poin: ['Dipakai untuk menghitung sampai kapan fasilitas PPh Final UMKM boleh digunakan.', 'Isi sesuai dokumen; salah isi membuat masa fasilitas terhitung keliru.'],
      };
    case 'peredaranBruto':
      return {
        judul: 'Peredaran bruto (omzet)',
        ringkas: 'Jumlah seluruh pendapatan usaha sebelum dikurangi biaya, diambil otomatis dari buku besar.',
        poin: [
          'Tidak diketik manual — angka selalu dapat ditelusuri ke jurnal.',
          'Pendapatan yang bukan objek (mis. bunga deposito yang sudah dipotong pajak final) dapat dikecualikan dengan alasan dan dasar aturan yang tercatat.',
          'Untuk tahun yang masih berjalan, angkanya terus bertambah sampai akhir tahun.',
        ],
      };
    case 'batasFinal':
      return {
        judul: `Batas ${rp(k.batasOmzetFinal)}`,
        ringkas: 'Batas omzet setahun untuk PPh Final UMKM, dan juga batas bagian omzet yang mendapat fasilitas Pasal 31E.',
        poin: [
          'Bila omzet TAHUN LALU melebihi batas ini, mulai tahun ini koperasi dikenai PPh Badan.',
          'Bila omzet TAHUN INI yang melebihi, PPh Final tetap berlaku sampai akhir tahun; perubahan baru berlaku tahun depan.',
        ],
      };
    case 'batas31E':
      return {
        judul: `Batas ${rp(k.batasPeredaranBrutoPenerima31E)}`,
        ringkas: 'Batas omzet setahun untuk mendapat fasilitas Pasal 31E.',
        poin: [`Omzet sampai batas ini: ${LABEL_REZIM.BADAN_31E}.`, `Omzet di atas batas ini: ${LABEL_REZIM.BADAN_UMUM}.`],
      };
    case 'masaFasilitas':
      return {
        judul: 'Masa fasilitas PPh Final',
        ringkas: 'PPh Final UMKM hanya boleh dipakai dalam jangka waktu tertentu sejak koperasi terdaftar.',
        poin: [
          'Dihitung otomatis dari tahun terdaftar NPWP, termasuk ketentuan peralihan yang berlaku.',
          'Setelah masa ini berakhir, koperasi otomatis dihitung dengan PPh Badan mulai tahun pajak berikutnya.',
        ],
        dasar: 'PP 55/2022 jo. PP 20/2026',
      };
    case 'penetapanManual':
      return {
        judul: 'Penetapan manual',
        ringkas: 'Jalan pengecualian untuk rezim yang ditetapkan dokumen resmi, misalnya surat dari Direktorat Jenderal Pajak.',
        poin: [
          'Wajib mengisi alasan, nomor dokumen, dan tanggal dokumen.',
          'Nama pengguna dan waktu penetapan tercatat untuk pemeriksaan.',
          'Hasil perhitungan otomatis tetap ditampilkan; bila berbeda, aplikasi memberi peringatan.',
          'Jangan gunakan hanya karena ingin tarif yang berbeda — gunakan hanya bila ada dokumen.',
        ],
      };
    case 'jenisUtangPajak':
      return {
        judul: 'Jenis utang pajak',
        ringkas: 'Utang pajak adalah pajak yang sudah dihitung atau dipotong tetapi belum disetor ke kas negara.',
        poin: [
          'Pajak koperasi: PPh Final UMKM dan PPh Pasal 29 — pajak atas penghasilan koperasi sendiri.',
          'Dipotong dari anggota: PPh Pasal 4(2) bunga simpanan — uang anggota yang ditahan koperasi dan wajib diteruskan ke negara. Bukan beban koperasi.',
          'Lainnya: utang pajak umum yang tercatat di buku besar.',
          'Setiap jenis disetor dengan kode billing sendiri, jadi pilih satu per setoran.',
        ],
      };
    case 'masaSetor':
      return {
        judul: 'Masa pajak',
        ringkas: 'Bulan pajak yang dilunasi — bukan tanggal Anda membayar.',
        poin: [
          'Contoh: PPh Final bulan Agustus yang disetor tanggal 12 September dicatat dengan masa Agustus.',
          'Samakan dengan masa yang tertera pada kode billing / bukti setor.',
        ],
      };
    case 'setorSebagian':
      return {
        judul: 'Nominal setoran',
        ringkas: 'Nominal otomatis diisi sebesar seluruh saldo utang pajak yang dipilih.',
        poin: [
          'Boleh disetor sebagian; sisanya tetap tercatat sebagai utang pajak.',
          'Tidak bisa melebihi saldo utang — aplikasi menolak setoran yang lebih besar.',
          'Samakan dengan nominal pada kode billing.',
        ],
      };
    case 'ntpn':
      return {
        judul: 'NTPN',
        ringkas: 'Nomor Transaksi Penerimaan Negara — 16 huruf/angka pada Bukti Penerimaan Negara (BPN) setelah setoran berhasil.',
        poin: [
          'NTPN adalah bukti sah bahwa pajak sudah diterima negara dan dipakai saat pelaporan SPT.',
          'Tertera pada BPN dari bank, kantor pos, atau kanal pembayaran kode billing.',
          'Spasi dirapikan dan huruf dijadikan kapital otomatis; aplikasi memeriksa formatnya.',
          'Kosongkan hanya bila bukti setor belum terbit, dan simpan BPN sebagai arsip.',
        ],
      };
    case 'caraKerja':
      return {
        judul: 'Cara kerja menu Pajak',
        ringkas: 'Sebagian besar pajak dihitung otomatis dari transaksi yang sudah dicatat. Pengguna cukup mencatat, menyetor, dan menyimpan bukti setor.',
        poin: [
          '1. Transaksi harian (pendapatan, bunga simpanan, dll.) dicatat seperti biasa.',
          '2. Aplikasi menghitung pajaknya otomatis dan menampilkan apa yang perlu dikerjakan.',
          '3. Pajak yang dicatat menjadi utang pajak di buku besar.',
          '4. Utang pajak disetor ke kas negara lewat bank/pos; NTPN dari bukti setor dicatat di Setor Pajak.',
          '5. Semua langkah tercatat di Riwayat Pajak untuk diperiksa pengawas.',
        ],
      };
    case 'tugas':
      return {
        judul: 'Yang perlu dilakukan',
        ringkas: 'Daftar pekerjaan pajak yang disusun otomatis dari data — urut dari yang paling mendesak.',
        poin: [
          'Merah (mendesak): sudah lewat jatuh tempo atau perlu diperiksa.',
          'Kuning (perlu): harus dikerjakan sebelum jatuh tempo.',
          'Ketuk salah satu tugas untuk langsung membuka layarnya.',
          'Bila daftar kosong, seluruh kewajiban pajak yang tercatat sudah beres.',
        ],
      };
    case 'posisiPajak':
      return {
        judul: 'Posisi pajak',
        ringkas: 'Saldo pajak di buku besar, dikelompokkan menurut siapa pemilik pajaknya.',
        poin: [
          'Pajak koperasi: pajak atas penghasilan koperasi sendiri.',
          'Dipotong dari anggota: uang anggota yang ditahan koperasi dan wajib diteruskan ke negara.',
          'Kredit pajak: pajak yang sudah dibayar di muka; bukan utang, melainkan pengurang PPh Badan akhir tahun.',
        ],
      };
    case 'utangKoperasi':
      return {
        judul: 'Utang pajak koperasi',
        ringkas: 'Pajak atas penghasilan koperasi sendiri yang sudah dihitung tetapi belum disetor.',
        poin: ['PPh Final UMKM 0,5% per masa.', 'PPh Pasal 29 (kekurangan PPh Badan akhir tahun).', 'Tercatat sebagai beban pajak koperasi.'],
      };
    case 'utangAnggota':
      return {
        judul: 'Pajak dipotong dari anggota',
        ringkas: 'PPh Pasal 4(2) atas bunga simpanan anggota yang dipotong koperasi saat bunga dibayarkan.',
        poin: [
          'Uang ini milik anggota, bukan biaya koperasi — koperasi hanya meneruskannya ke negara.',
          'Tiap pemotongan punya bukti potong per anggota, termasuk yang tarifnya 0%.',
          'Tidak ikut dihitung dalam PPh Badan koperasi.',
        ],
      };
    case 'kreditPajak':
      return {
        judul: 'Kredit pajak (dibayar di muka)',
        ringkas: 'Pajak yang sudah dibayar atau dipotong pihak lain sepanjang tahun — mengurangi PPh Badan akhir tahun.',
        poin: ['Angsuran PPh 25 bulanan.', 'PPh 22/23/24 yang dipotong/dipungut pihak lain.', 'Dicatat sebagai aset sampai dikreditkan saat PPh Badan dikunci.'],
      };
    case 'pphBadanTahunLalu':
      return {
        judul: 'PPh Badan tahun lalu',
        ringkas: 'Hasil perhitungan PPh Badan tahun pajak sebelumnya beserta rinciannya.',
        poin: [
          '"Terkunci": angka final, jurnal sudah dibuat, tidak berubah walau aturan berganti.',
          '"Belum dikunci": angka sementara; lengkapi koreksi fiskal lalu kunci.',
          'PPh 29 yang terbentuk muncul di utang pajak koperasi untuk disetor.',
        ],
      };
    case 'menuPphFinal':
      return {
        judul: 'PPh Final UMKM 0,5%',
        ringkas: 'Menghitung dan mencatat PPh Final per bulan dari omzet di buku besar.',
        poin: ['Semua masa yang belum dicatat tampil otomatis beserta jumlahnya.', 'Tombol "Catat Otomatis" mencatat semuanya sekaligus.', 'Rincian tiap masa dapat dibuka untuk diperiksa.'],
      };
    case 'menuPph25':
      return {
        judul: 'Angsuran PPh Pasal 25',
        ringkas: 'Cicilan bulanan PPh Badan tahun berjalan, dibayar sebelum tanggal jatuh tempo.',
        poin: [
          'Dasar angsuran diusulkan otomatis dari PPh Badan tahun lalu yang sudah dikunci.',
          'Jadwal 12 bulan dan statusnya tampil otomatis.',
          'Saat membayar cukup pilih rekening, tanggal, dan isi NTPN.',
        ],
      };
    case 'menuPphBadan':
      return {
        judul: 'PPh Badan akhir tahun',
        ringkas: 'Menghitung pajak atas laba setahun (fasilitas Pasal 31E atau tarif umum) setelah tahun pajak berakhir.',
        poin: ['Laba diambil dari Laporan Hasil Usaha, ditambah/dikurangi koreksi fiskal.', 'Angsuran PPh 25 dikreditkan otomatis.', 'Setelah dikunci, kekurangannya menjadi PPh 29 yang harus disetor.'],
      };
    case 'menuKoreksiFiskal':
      return {
        judul: 'Koreksi fiskal',
        ringkas: 'Penyesuaian laba menurut akuntansi menjadi laba menurut aturan pajak.',
        poin: [
          'Contoh koreksi positif: sumbangan, biaya yang tidak boleh dikurangkan.',
          'Contoh koreksi negatif: penghasilan yang sudah dikenai pajak final.',
          'Setiap koreksi wajib beralasan dan menyebut dasar aturannya.',
          'Bila tidak ada koreksi, cukup nyatakan rekonsiliasi lengkap.',
        ],
      };
    case 'menuSetor':
      return {
        judul: 'Setor Pajak',
        ringkas: 'Mencatat pembayaran utang pajak ke kas negara beserta NTPN-nya.',
        poin: ['Nominal otomatis sebesar saldo utang; tidak bisa melebihi saldo.', 'Juga dapat dibuka dari menu Bayar Kewajiban.', 'Setoran langsung tampil di Riwayat Pajak.'],
      };
    case 'menuRiwayat':
      return {
        judul: 'Riwayat Pajak',
        ringkas: 'Jejak audit semua transaksi pajak per tahun: pengakuan, pemotongan, angsuran, dan setoran.',
        poin: ['Setiap baris dapat ditelusuri ke jurnalnya.', 'Pembatalan tercatat sebagai jurnal pembalik, bukan dihapus.', 'Cocok untuk pemeriksaan pengawas.'],
      };
    case 'menuBuktiPotong': {
      // RC-S127 — contoh hitung dari mesin pajak, bukan angka tulis tangan.
      const contohBruto = 300_000;
      const contohSukarela = 150_000; // tiap produk di bawah batas, totalnya di atas
      const contohPph = hitungPphBungaSimpanan(contohBruto);
      return {
        judul: 'Bukti potong PPh bunga simpanan',
        ringkas: 'PPh Pasal 4(2) yang dipotong koperasi dari bunga simpanan anggota — Sukarela maupun Berjangka. Dipotong otomatis saat bunga dibukukan ke anggota.',
        poin: [
          `Batas dihitung dari TOTAL bunga satu anggota dalam sebulan, Sukarela dan Berjangka digabung.`,
          `Total tidak lebih dari ${rp(BATAS_BUNGA_SIMPANAN_PPH_BEBAS)}: tarif 0% (bukti potong tetap terbit).`,
          `Total di atas ${rp(BATAS_BUNGA_SIMPANAN_PPH_BEBAS)}: ${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas seluruh bunga bulan itu — bagian yang tadinya 0% dipotong susulan pada pembayaran berikutnya di bulan yang sama.`,
          'Bunga Sukarela dipotong saat akrual akhir bulan; bunga Berjangka saat dipindah ke Sukarela atau dicairkan.',
          'PPh yang dipotong menjadi utang pajak "Dipotong dari anggota" dan disetor lewat Setor Pajak.',
          'Tiap bukti potong bisa dicetak untuk diserahkan kepada anggota.',
        ],
        contoh: {
          judul: 'Contoh satu anggota, satu bulan',
          baris: [
            { label: 'Bunga Sukarela', nilai: rp(contohSukarela) },
            { label: 'Bunga Berjangka', nilai: rp(contohBruto - contohSukarela) },
            { label: 'Total bunga bulan ini', nilai: rp(contohBruto) },
            { label: `PPh ${TARIF_PPH_BUNGA_SIMPANAN_PERSEN}% atas total`, nilai: rp(contohPph), tebal: true },
          ],
        },
        dasar: 'PP 15/2009 tentang PPh atas bunga simpanan yang dibayarkan koperasi kepada anggota orang pribadi.',
      };
    }
    case 'menuPengaturan':
      return {
        judul: 'Pengaturan Pajak',
        ringkas: 'Data koperasi yang menentukan rezim pajak, beserta alasan penetapannya.',
        poin: ['Rezim dihitung otomatis — tidak ada pilihan tarif.', 'Setiap istilah dilengkapi penjelasan.'],
      };
    case 'versiKebijakan':
      return {
        judul: 'Versi kebijakan pajak',
        ringkas: 'Kumpulan tarif dan batas yang dipakai aplikasi untuk tahun pajak ini.',
        poin: [
          'Bila aturan pajak berubah, aplikasi memakai versi baru tanpa mengubah perhitungan yang sudah dikunci.',
          'Tarif, batas, dan aturan peralihan perlu dikonfirmasi dengan konsultan pajak koperasi.',
        ],
      };
  }
}
