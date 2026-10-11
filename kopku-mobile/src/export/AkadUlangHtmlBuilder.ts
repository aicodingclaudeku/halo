import { DokumenAkadUlang } from './AkadUlangDocumentBuilder';
import { formatRupiah } from '@/utils/money';
import {
  escapeHtmlDokumen as esc,
  htmlDokumenKontrak,
  htmlJadwal,
  htmlKop,
  htmlKv,
  htmlPengesahanDanFooter,
  htmlTeksBebas,
} from './DokumenKontrakHtml';

/**
 * RC-S82 — RENDERER "DOKUMEN AKAD ULANG PINJAMAN" (MURNI).
 * Memakai template bersama `DokumenKontrakHtml` (sama dengan Dokumen Akad
 * Awal) — lihat modul itu untuk keputusan tata letak A4. TIDAK memakai
 * `buildReportHtml()` generik.
 */
export function buildAkadUlangHtml(doc: DokumenAkadUlang): string {
  const perubahanRows = doc.perubahan
    .map((p) => `<tr><td class="komponen">${esc(p.komponen)}</td><td>${esc(p.sebelum)}</td><td>${esc(p.sesudah)}</td></tr>`)
    .join('');

  const body = `
      ${htmlKop(doc.koperasi)}

      <h1>${esc(doc.judul)}</h1>
      <div class="subjudul">Nomor: ${esc(doc.nomorDokumen)}</div>
      <div class="info">
        Dokumen ini merupakan perubahan atas Perjanjian Pinjaman Nomor ${esc(doc.nomorAkadAwal)} dan menjadi bagian
        yang tidak terpisahkan darinya. Ketentuan yang tidak diubah dalam dokumen ini tetap berlaku.
      </div>

      <div class="identitas-dokumen blok">
        ${htmlKv(doc.identitasDokumen)}
      </div>

      <div class="blok">
        <h2>I. IDENTITAS ANGGOTA</h2>
        ${htmlKv(doc.identitasAnggota)}
      </div>

      <div class="blok">
        <h2>II. REFERENSI AKAD AWAL</h2>
        ${htmlKv(doc.referensiAkadAwal)}
      </div>

      <div class="blok">
        <h2>III. PERUBAHAN AKAD</h2>
        <table class="grid">
          <thead><tr><th>Komponen</th><th>Sebelum</th><th>Sesudah</th></tr></thead>
          <tbody>${perubahanRows}</tbody>
        </table>
      </div>

      <div class="blok">
        <h2>IV. NILAI AKAD ULANG</h2>
        <div class="nilai-utama">
          <div class="label">Sisa Pokok sebagai Dasar Akad</div>
          <div class="angka">${esc(formatRupiah(doc.sisaPokok))}</div>
        </div>
        <table class="nilai-info"><tr>
          <td class="label">Piutang Jasa Telah Diakui Sebelum Akad Ulang</td>
          <td class="angka">${esc(formatRupiah(doc.piutangJasaDiakui))}</td>
        </tr></table>
        <div class="catatan">${esc(doc.catatanPiutangJasa)}</div>
      </div>

      <h2>V. JADWAL ANGSURAN AKAD ULANG</h2>
      ${htmlJadwal(
        doc.jadwal.map((j) => ({ ...j, sub: `No. internal ${j.nomorInternal}` })),
        doc.totalJadwal,
        'Jadwal hasil akad ulang ini tidak ditemukan.'
      )}

      <div class="blok">
        <h2>VI. KETERANGAN</h2>
        ${doc.keterangan ? `<div class="keterangan">${htmlTeksBebas(doc.keterangan)}</div>` : `<div class="kosong">Tidak ada keterangan.</div>`}
      </div>

      ${htmlPengesahanDanFooter({
        nomorBab: 'VII',
        pernyataan:
          'Para pihak menyatakan telah membaca dan menyetujui perubahan syarat pinjaman sebagaimana tercantum dalam dokumen ini.',
        anggota: { peran: 'ANGGOTA / PEMINJAM', nama: doc.namaAnggota },
        koperasi: { peran: 'KOPERASI', namaKoperasi: doc.namaKoperasi, pengurus: doc.pengurus },
        footer: {
          nomorPinjaman: doc.footer.nomorPinjaman,
          labelNomorDokumen: 'No. Akad Ulang',
          nomorDokumen: doc.footer.nomorDokumen,
          tanggalCetak: doc.footer.tanggalCetak,
          catatan: doc.footer.catatan,
        },
      })}`;

  return htmlDokumenKontrak({ judulTab: `${doc.judul} — ${doc.nomorDokumen}`, nomorDokumen: doc.nomorDokumen, body });
}
