import { formatRupiah, Rupiah } from '@/utils/money';
import { terbilangRupiah } from '@/utils/terbilang';
import type { SusunanPengurusInti } from '@/services/PengurusInti';
import { formatPersen, ringkasanPerlakuanPascaJatuhTempo } from '@/accounting/SimpananBerjangkaKebijakanProduk';
import { escapeHtmlDokumen as esc, htmlDokumenKontrak, htmlKop, htmlKv, BarisKv } from './DokumenKontrakHtml';
import { KETERANGAN_APLIKASI_CETAK, NAMA_APLIKASI_CETAK } from './IdentitasCetak';

/**
 * ============================================================
 * DOKUMEN SIMPANAN BERJANGKA (RC-S128) — BUILDER MURNI
 * ============================================================
 * "BUKTI PENEMPATAN SIMPANAN BERJANGKA" dan "BUKTI PENCAIRAN SIMPANAN
 * BERJANGKA". Murni: menerima data yang SUDAH dibaca dari database oleh
 * `SimpananBerjangkaDokumenService` (kontrak tersimpan, snapshot
 * kebijakan, jurnal, bukti potong) dan menghasilkan HTML untuk
 * `expo-print`. Tidak menghitung bunga dan tidak membaca state UI.
 *
 * Tampilan memakai template bersama dokumen kontrak (`DokumenKontrakHtml`):
 * kop, CSS A4, nomor dokumen + halaman di setiap halaman. Blok tanda
 * tangan dibuat khusus (ANGGOTA / PENYIMPAN dan KETUA KOPERASI) karena
 * blok pinjaman yang ada memuat label "Peminjam" dan meterai.
 */

export interface IdentitasKoperasiDokumen {
  nama: string;
  alamat: string | null;
  nomorBadanHukum: string | null;
  npwp: string | null;
}

export interface IdentitasAnggotaDokumen {
  nama: string;
  nomorAnggota: string;
  nik: string | null;
  alamat: string | null;
}

export interface SnapshotKebijakanDokumen {
  /** POLICY_SNAPSHOT | LEGACY_POLICY_REVIEW_REQUIRED | LEGACY_POLICY_DITERAPKAN */
  statusPolicy: string;
  policyVersi: string | null;
  autoRenewal: boolean | null;
  bungaPascaAktif: boolean | null;
  ratePascaJatuhTempo: number | null;
  /** Dari baris kebijakan berversi (append-only) — informasi dasar penetapan. */
  dasarPenetapan: string | null;
  berlakuMulai: string | null;
  pascaMulaiEfektif: string | null;
}

export interface DataBuktiPenempatan {
  koperasi: IdentitasKoperasiDokumen;
  pengurus: SusunanPengurusInti;
  anggota: IdentitasAnggotaDokumen;
  kontrak: {
    nomorTransaksi: string;
    tanggalMulai: string;
    tanggalJatuhTempo: string;
    nominal: Rupiah;
    tenorBulan: number;
    rateKontrak: number;
    totalBungaKontrak: Rupiah;
    sumberDana: string;
    nomorJurnal: string | null;
    status: string;
  };
  kebijakan: SnapshotKebijakanDokumen;
}

export interface DataBuktiPencairan {
  koperasi: IdentitasKoperasiDokumen;
  pengurus: SusunanPengurusInti;
  anggota: IdentitasAnggotaDokumen;
  kontrak: {
    nomorTransaksi: string;
    tanggalMulai: string;
    tanggalJatuhTempo: string;
    tanggalPencairan: string;
    tenorBulan: number;
    rateKontrak: number;
  };
  kebijakan: SnapshotKebijakanDokumen;
  pencairan: {
    nomorReferensi: string;
    nomorJurnal: string | null;
    pokokDicairkan: Rupiah;
    bungaSelamaTenor: Rupiah;
    bungaPascaJatuhTempo: Rupiah;
    bungaKeSukarelaBruto: Rupiah;
    pphAtasPemindahan: Rupiah;
    bungaKeSukarelaNeto: Rupiah;
    jumlahJurnalPemindahan: number;
    bungaDibayarTunai: Rupiah;
    pphSaatPencairan: Rupiah;
    /** Bunga periode berjalan yang belum earned (tidak dibayar) — informasi. */
    bungaTidakDibayarkan: Rupiah;
    alasanTidakDibayarkan: string | null;
    totalKeluarKasBank: Rupiah;
    sumberDana: string;
  };
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

export function tanggalPanjang(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '-';
  return `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

const rp = (n: Rupiah) => formatRupiah(n);

const CSS_TAMBAHAN = `
  .ttd2 { width: 100%; border-collapse: collapse; margin-top: 10px; table-layout: fixed; }
  .ttd2 td { width: 50%; vertical-align: top; padding: 0 10px; text-align: center; }
  .ttd2 .peran { font-weight: 700; letter-spacing: .3px; }
  .ttd2 .sub { font-size: 8.5pt; color: #5b6670; margin-top: 2px; }
  .ttd2 .tgl { font-size: 9pt; margin-top: 6px; }
  .ttd2 .ruang { height: 74px; position: relative; }
  .ttd2 .stempel { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); width: 92px; height: 58px;
    border: 0.8px dashed #b8c0c8; border-radius: 6px; font-size: 7pt; color: #9aa4ad; display: flex; align-items: center; justify-content: center; }
  .ttd2 .garis { border-bottom: 0.8px solid #1f2328; margin: 0 18px; }
  .ttd2 .nama { margin-top: 4px; font-weight: 700; }
  .ttd2 .jabatan { font-size: 9pt; color: #3d4650; }
  ol.kesepakatan { margin: 4px 0 0 18px; padding: 0; }
  ol.kesepakatan li { margin: 3px 0; text-align: justify; }
  .sorot { background: #f3f7f4; border-left: 3px solid #1B5E20; padding: 6px 9px; margin: 8px 0; }
`;

const GARIS_KOSONG = '(.............................................)';

function kolomTtd(opts: { peran: string; sub: string; nama: string | null; jabatan: string; stempel?: boolean }): string {
  return `<td>
      <div class="peran">${esc(opts.peran)}</div>
      <div class="sub">${esc(opts.sub)}</div>
      <div class="tgl">Tanggal: ........................................</div>
      <div class="ruang">${opts.stempel ? '<div class="stempel">Stempel koperasi</div>' : ''}</div>
      <div class="garis"></div>
      <div class="nama">${opts.nama && opts.nama.trim() ? esc(opts.nama) : GARIS_KOSONG}</div>
      <div class="jabatan">${esc(opts.jabatan)}</div>
    </td>`;
}

/**
 * Dua blok tanda tangan. Nama Ketua dari susunan pengurus yang menjabat
 * pada tanggal dokumen (resolver pengurus yang sama dengan dokumen
 * pinjaman); bila belum ditetapkan dicetak garis titik-titik — tidak
 * pernah nama karangan.
 */
function htmlTandaTangan(namaAnggota: string, koperasi: IdentitasKoperasiDokumen, pengurus: SusunanPengurusInti): string {
  return `<table class="ttd2"><tr>
      ${kolomTtd({ peran: 'ANGGOTA / PENYIMPAN', sub: 'Pemilik simpanan berjangka', nama: namaAnggota, jabatan: 'Anggota' })}
      ${kolomTtd({ peran: 'KETUA KOPERASI', sub: koperasi.nama, nama: pengurus.KETUA?.nama ?? null, jabatan: 'Ketua', stempel: true })}
    </tr></table>`;
}

function htmlFooter(nomorDokumen: string, tanggalCetak: string, catatan: string): string {
  return `<div class="footer">
      <table><tr>
        <td class="kiri">No. Dokumen ${esc(nomorDokumen)}<br />${esc(catatan)}</td>
        <td class="kanan">Dicetak ${esc(tanggalCetak)}</td>
      </tr></table>
      <div class="identitas">Dicetak dengan <b>${esc(NAMA_APLIKASI_CETAK)}</b> · ${esc(KETERANGAN_APLIKASI_CETAK)}</div>
    </div>`;
}

function barisIdentitasAnggota(a: IdentitasAnggotaDokumen): BarisKv[] {
  const b: BarisKv[] = [
    { label: 'Nama anggota', nilai: a.nama },
    { label: 'Nomor anggota', nilai: a.nomorAnggota },
  ];
  if (a.nik) b.push({ label: 'NIK', nilai: a.nik });
  if (a.alamat) b.push({ label: 'Alamat', nilai: a.alamat });
  return b;
}

/** Baris ketentuan produk dari SNAPSHOT kontrak (bukan master kebijakan terkini). */
export function barisKetentuanProduk(k: SnapshotKebijakanDokumen): BarisKv[] {
  if (k.statusPolicy === 'LEGACY_POLICY_REVIEW_REQUIRED' || !k.policyVersi) {
    return [
      { label: 'Kebijakan produk', nilai: 'Belum ditetapkan — kontrak dibuat sebelum kebijakan produk tersedia (perlu peninjauan pengurus)' },
      { label: 'Setelah jatuh tempo', nilai: 'Tidak diperpanjang otomatis; pokok tetap disimpan sampai dicairkan; tanpa bunga pasca jatuh tempo sampai pengurus menetapkan kebijakan' },
    ];
  }
  const b: BarisKv[] = [
    { label: 'Versi kebijakan produk', nilai: `${k.policyVersi}${k.berlakuMulai ? ` (berlaku mulai ${tanggalPanjang(k.berlakuMulai)})` : ''}` },
  ];
  if (k.dasarPenetapan) b.push({ label: 'Dasar penetapan', nilai: k.dasarPenetapan });
  b.push(
    { label: 'Perpanjangan otomatis', nilai: k.autoRenewal ? 'Ya' : 'Tidak' },
    {
      label: 'Bunga pasca jatuh tempo',
      nilai:
        k.bungaPascaAktif && k.ratePascaJatuhTempo
          ? `Ya — ${formatPersen(k.ratePascaJatuhTempo)} per tahun atas pokok, per bulan kalender penuh, selama belum dicairkan`
          : 'Tidak',
    },
    { label: 'Pemindahan bunga', nilai: 'Bunga yang sudah menjadi hak anggota dikreditkan ke Simpanan Sukarela setelah dipotong PPh Pasal 4 ayat (2)' },
    { label: 'Kapitalisasi bunga ke pokok', nilai: 'Tidak' },
    { label: 'Ketentuan pencairan', nilai: 'Pokok dicairkan kepada anggota pada atau setelah tanggal jatuh tempo atas permintaan anggota' }
  );
  if (k.statusPolicy === 'LEGACY_POLICY_DITERAPKAN' && k.pascaMulaiEfektif) {
    b.push({ label: 'Diterapkan pada kontrak lama', nilai: `Efektif ${tanggalPanjang(k.pascaMulaiEfektif)} (tanpa perhitungan surut)` });
  }
  return b;
}

/** Butir pernyataan/kesepakatan — mencerminkan snapshot kontrak. */
export function butirKesepakatan(k: SnapshotKebijakanDokumen): string[] {
  const s: string[] = [];
  if (!k.autoRenewal) {
    s.push('Status jatuh tempo tidak berarti pokok dicairkan secara otomatis dan kontrak tidak diperpanjang secara otomatis; pokok tetap tersimpan sebagai Simpanan Berjangka sampai Anggota/Penyimpan mengajukan pencairan.');
  }
  s.push(
    k.policyVersi
      ? `Perlakuan setelah jatuh tempo mengikuti kebijakan produk versi ${k.policyVersi} yang berlaku pada kontrak ini: ${ringkasanPerlakuanPascaJatuhTempo({ autoRenewal: !!k.autoRenewal, bungaPascaAktif: !!k.bungaPascaAktif, ratePascaJatuhTempo: k.ratePascaJatuhTempo })}`
      : 'Perlakuan setelah jatuh tempo mengikuti kebijakan produk yang ditetapkan pengurus koperasi untuk kontrak ini.'
  );
  s.push('Bunga yang telah menjadi hak Anggota/Penyimpan dapat dikreditkan ke Simpanan Sukarela atas nama Anggota/Penyimpan setelah dipotong Pajak Penghasilan sesuai ketentuan yang berlaku.');
  s.push('Bunga tidak ditambahkan ke pokok Simpanan Berjangka kecuali terdapat kebijakan tertulis koperasi yang secara tegas menyatakan demikian.');
  s.push('Dokumen ini mencerminkan ketentuan kebijakan produk (snapshot) yang dipakai saat kontrak dibuat; perubahan kebijakan koperasi di kemudian hari tidak mengubah ketentuan kontrak ini.');
  return s;
}

export function buildBuktiPenempatanHtml(d: DataBuktiPenempatan, opts: { tanggalCetak: string }): string {
  const judul = 'BUKTI PENEMPATAN SIMPANAN BERJANGKA';
  const nomor = d.kontrak.nomorTransaksi;
  const rincian: BarisKv[] = [
    { label: 'Nomor kontrak', nilai: nomor },
    { label: 'Tanggal penempatan', nilai: tanggalPanjang(d.kontrak.tanggalMulai) },
    { label: 'Tenor', nilai: `${d.kontrak.tenorBulan} bulan` },
    { label: 'Tanggal jatuh tempo', nilai: tanggalPanjang(d.kontrak.tanggalJatuhTempo) },
    { label: 'Nominal pokok', nilai: rp(d.kontrak.nominal) },
    { label: 'Terbilang', nilai: terbilangRupiah(d.kontrak.nominal) },
    { label: 'Suku bunga kontrak', nilai: d.kontrak.rateKontrak > 0 ? `${formatPersen(d.kontrak.rateKontrak)} per tahun` : 'Tanpa bunga' },
    { label: 'Bunga selama tenor (bruto)', nilai: `${rp(d.kontrak.totalBungaKontrak)} (pokok × suku bunga × tenor/12)` },
    { label: 'Sumber dana', nilai: d.kontrak.sumberDana },
  ];
  if (d.kontrak.nomorJurnal) rincian.push({ label: 'Referensi jurnal', nilai: d.kontrak.nomorJurnal });

  const body = `
    ${htmlKop(d.koperasi)}
    <h1>${esc(judul)}</h1>
    <div class="subjudul">Nomor: ${esc(nomor)}</div>
    <div class="blok"><h2>A. Identitas Anggota / Penyimpan</h2>${htmlKv(barisIdentitasAnggota(d.anggota))}</div>
    <div class="blok"><h2>B. Rincian Penempatan</h2>${htmlKv(rincian)}</div>
    <div class="blok"><h2>C. Ketentuan Produk</h2>${htmlKv(barisKetentuanProduk(d.kebijakan))}</div>
    <div class="blok">
      <h2>D. Pernyataan dan Kesepakatan</h2>
      <p class="pembukaan">Dengan menandatangani bukti ini, Anggota/Penyimpan dan Koperasi menyatakan dan menyepakati bahwa:</p>
      <ol class="kesepakatan">${butirKesepakatan(d.kebijakan).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    </div>
    <div class="blok">
      ${htmlTandaTangan(d.anggota.nama, d.koperasi, d.pengurus)}
      ${htmlFooter(nomor, opts.tanggalCetak, 'Bukti ini dicetak dari data kontrak yang tersimpan di KOPKU.')}
    </div>`;
  return sisipkanCss(htmlDokumenKontrak({ judulTab: `${judul} — ${nomor}`, nomorDokumen: nomor, body }));
}

export function buildBuktiPencairanHtml(d: DataBuktiPencairan, opts: { tanggalCetak: string }): string {
  const judul = 'BUKTI PENCAIRAN SIMPANAN BERJANGKA';
  const p = d.pencairan;
  const nomor = p.nomorReferensi;
  const kontrak: BarisKv[] = [
    { label: 'Nomor kontrak', nilai: d.kontrak.nomorTransaksi },
    { label: 'Tanggal penempatan', nilai: tanggalPanjang(d.kontrak.tanggalMulai) },
    { label: 'Tanggal jatuh tempo', nilai: tanggalPanjang(d.kontrak.tanggalJatuhTempo) },
    { label: 'Tanggal pencairan', nilai: tanggalPanjang(d.kontrak.tanggalPencairan) },
    { label: 'Suku bunga kontrak', nilai: d.kontrak.rateKontrak > 0 ? `${formatPersen(d.kontrak.rateKontrak)} per tahun` : 'Tanpa bunga' },
    { label: 'Versi kebijakan produk', nilai: d.kebijakan.policyVersi ?? 'Belum ditetapkan (kontrak lama)' },
  ];
  const rincian: BarisKv[] = [
    { label: 'Pokok dicairkan kepada anggota', nilai: rp(p.pokokDicairkan) },
    { label: 'Bunga selama tenor (bruto)', nilai: rp(p.bungaSelamaTenor) },
    { label: 'Bunga pasca jatuh tempo (bruto)', nilai: rp(p.bungaPascaJatuhTempo) },
    { label: 'Bunga dikreditkan ke Simpanan Sukarela (bruto)', nilai: `${rp(p.bungaKeSukarelaBruto)} (${p.jumlahJurnalPemindahan} jurnal pemindahan)` },
    { label: 'PPh Pasal 4 ayat (2) atas bunga tersebut', nilai: rp(p.pphAtasPemindahan) },
    { label: 'Bunga neto masuk Simpanan Sukarela', nilai: rp(p.bungaKeSukarelaNeto) },
  ];
  if (p.bungaDibayarTunai > 0 || p.pphSaatPencairan !== 0) {
    rincian.push(
      { label: 'Bunga dibayar tunai saat pencairan (bruto)', nilai: rp(p.bungaDibayarTunai) },
      { label: 'PPh Pasal 4 ayat (2) saat pencairan', nilai: rp(p.pphSaatPencairan) }
    );
  }
  rincian.push(
    { label: 'Bunga belum dibayarkan', nilai: p.bungaTidakDibayarkan > 0 ? rp(p.bungaTidakDibayarkan) : 'Tidak ada' },
    { label: 'TOTAL UANG KELUAR DARI KAS/BANK', nilai: rp(p.totalKeluarKasBank) },
    { label: 'Terbilang', nilai: terbilangRupiah(p.totalKeluarKasBank) },
    { label: 'Sumber dana', nilai: p.sumberDana }
  );
  if (p.nomorJurnal) rincian.push({ label: 'Referensi jurnal pencairan', nilai: p.nomorJurnal });

  const body = `
    ${htmlKop(d.koperasi)}
    <h1>${esc(judul)}</h1>
    <div class="subjudul">Nomor: ${esc(nomor)}</div>
    <div class="blok"><h2>A. Identitas Anggota / Penyimpan</h2>${htmlKv(barisIdentitasAnggota(d.anggota))}</div>
    <div class="blok"><h2>B. Kontrak</h2>${htmlKv(kontrak)}</div>
    <div class="blok"><h2>C. Rincian Pencairan</h2>${htmlKv(rincian)}
      <div class="sorot">Pokok Simpanan Berjangka dibayarkan kepada anggota. Bunga yang telah menjadi hak anggota dikreditkan ke Simpanan Sukarela
      setelah dipotong PPh, sehingga tidak dibayarkan lagi pada pencairan ini.</div>
      ${p.alasanTidakDibayarkan ? `<div class="catatan">${esc(p.alasanTidakDibayarkan)}</div>` : ''}
    </div>
    <div class="blok">
      ${htmlTandaTangan(d.anggota.nama, d.koperasi, d.pengurus)}
      ${htmlFooter(nomor, opts.tanggalCetak, `Pencairan kontrak ${d.kontrak.nomorTransaksi}. Angka dibaca dari jurnal & bukti potong yang tersimpan.`)}
    </div>`;
  return sisipkanCss(htmlDokumenKontrak({ judulTab: `${judul} — ${nomor}`, nomorDokumen: nomor, body }));
}

function sisipkanCss(html: string): string {
  return html.replace('</style>', `${CSS_TAMBAHAN}</style>`);
}
