import { DokumenAkadAwal, PasalPerjanjian } from './AkadAwalDocumentBuilder';
import {
  escapeHtmlDokumen as esc,
  htmlDokumenKontrak,
  htmlJadwal,
  htmlKop,
  htmlKv,
  htmlPengesahanDanFooter,
  BarisKv,
} from './DokumenKontrakHtml';

/**
 * RC-S82 — RENDERER "PERJANJIAN PINJAMAN" (AKAD AWAL), MURNI.
 * Isi pasal disusun di `AkadAwalDocumentBuilder`; modul ini hanya tata
 * letak A4 (template bersama `DokumenKontrakHtml`). Lampiran jadwal selalu
 * mulai di halaman baru.
 */

function htmlPihak(nomor: string, rincian: BarisKv[], peran: string): string {
  const baris = rincian
    .map(
      (r, i) =>
        `<tr><td class="no">${i === 0 ? esc(nomor) : ''}</td><td class="kv-label">${esc(r.label)}</td><td class="kv-sep">:</td><td class="kv-nilai">${esc(r.nilai)}</td></tr>`
    )
    .join('');
  return `<table class="pihak">${baris}</table><div class="pihak-peran">${esc(peran)}</div>`;
}

function htmlPasal(p: PasalPerjanjian): string {
  const isi =
    p.ayat.length === 1 ? `<p>${esc(p.ayat[0])}</p>` : `<ol>${p.ayat.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`;
  return `<div class="pasal">
        <div class="nomor">Pasal ${p.nomor}</div>
        <div class="judul">${esc(p.judul)}</div>
        ${isi}
      </div>`;
}

export function buildAkadAwalHtml(doc: DokumenAkadAwal): string {
  const body = `
      ${htmlKop(doc.koperasi)}

      <h1>${esc(doc.judul)}</h1>
      <div class="subjudul">Nomor: ${esc(doc.nomorDokumen)}</div>

      ${doc.pemberitahuanPenggantian ? `<div class="info">${esc(doc.pemberitahuanPenggantian)}</div>` : ''}

      <p class="pembukaan">${esc(doc.kalimatPembukaan)}</p>
      <div class="blok">${htmlPihak('I.', doc.pihakPertama.rincian, doc.pihakPertama.peran)}</div>
      <div class="blok">${htmlPihak('II.', doc.pihakKedua.rincian, doc.pihakKedua.peran)}</div>

      <p class="pembukaan">${esc(doc.kalimatKesepakatan)}</p>
      <ol class="dasar" type="a">${doc.dasarHukum.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>
      <p class="pembukaan">dengan ketentuan sebagai berikut:</p>

      ${doc.pasal.map(htmlPasal).join('')}

      <p class="pembukaan" style="margin-top:14px">Demikian Perjanjian ini dibuat dan ditandatangani oleh PARA PIHAK dalam keadaan sadar, sehat jasmani dan rohani, tanpa paksaan dari pihak mana pun.</p>

      ${htmlPengesahanDanFooter({
        nomorBab: null,
        pernyataan: null,
        anggota: { peran: 'PIHAK KEDUA', nama: doc.namaAnggota },
        koperasi: { peran: 'PIHAK PERTAMA', namaKoperasi: doc.koperasi.nama, pengurus: doc.pengurus },
        footer: {
          nomorPinjaman: doc.footer.nomorPinjaman,
          labelNomorDokumen: 'No. Perjanjian',
          nomorDokumen: doc.footer.nomorDokumen,
          tanggalCetak: doc.footer.tanggalCetak,
          catatan: doc.footer.catatan,
        },
      })}

      <div class="lampiran-judul">LAMPIRAN — JADWAL ANGSURAN</div>
      <div class="lampiran-sub">Lampiran Perjanjian Pinjaman Nomor ${esc(doc.nomorDokumen)} · ${esc(doc.statusAkadLabel)}</div>
      <div class="blok">
        <h2>Ringkasan Ketentuan Pinjaman</h2>
        ${htmlKv(doc.ketentuan)}
      </div>
      <h2>Jadwal Angsuran</h2>
      ${htmlJadwal(doc.jadwal, doc.totalJadwal, 'Jadwal angsuran tidak ditemukan.')}
      <div class="catatan">Jumlah pada jadwal adalah kewajiban pokok dan jasa sesuai Perjanjian. Denda keterlambatan (bila ada) tidak termasuk.</div>`;

  return htmlDokumenKontrak({ judulTab: `${doc.judul} — ${doc.nomorDokumen}`, nomorDokumen: doc.nomorDokumen, body });
}
