'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · PAKET EKSTENSI CLAUDE (`.mcpb`).
 *
 * Cara kedua memasang konektor: berkas `.mcpb` (MCP Bundle, dulu `.dxt`) dibuka
 * dengan Claude Desktop → dialog "Install". Claude Desktop menjalankan server
 * dengan Node.js BAWAANNYA sendiri, jadi tidak perlu Node.js terpasang dan tidak
 * bergantung pada `KOPKU Desktop.exe --kopku-mcp-stdio`.
 *
 * Isi paket: manifest.json, server/stdio.js, server/katalog.js, icon.png.
 * Server di dalam paket identik dengan electron/mcp/stdio.js: hanya meneruskan
 * pemanggilan ke KOPKU Desktop yang sedang terbuka (127.0.0.1 + token).
 *
 * ZIP ditulis tanpa dependensi (deflate dari node:zlib).
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ALAT } = require('./katalog');
const { untukDikirim } = require('./serverLokal');

const TABEL_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABEL_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function waktuDos(d) {
  const waktu = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const tanggal = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { waktu, tanggal };
}

/**
 * @param {{nama:string, isi:Buffer}[]} berkas
 * @returns {Buffer} arsip ZIP
 */
function buatZip(berkas, now = new Date()) {
  const lokal = [];
  const pusat = [];
  let offset = 0;
  const { waktu, tanggal } = waktuDos(now);
  for (const b of berkas) {
    const nama = Buffer.from(b.nama.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(b.isi) ? b.isi : Buffer.from(String(b.isi), 'utf8');
    const kempa = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const kepala = Buffer.alloc(30);
    kepala.writeUInt32LE(0x04034b50, 0);
    kepala.writeUInt16LE(20, 4);
    kepala.writeUInt16LE(0x0800, 6); // nama UTF-8
    kepala.writeUInt16LE(8, 8); // deflate
    kepala.writeUInt16LE(waktu, 10);
    kepala.writeUInt16LE(tanggal, 12);
    kepala.writeUInt32LE(crc, 14);
    kepala.writeUInt32LE(kempa.length, 18);
    kepala.writeUInt32LE(data.length, 22);
    kepala.writeUInt16LE(nama.length, 26);
    kepala.writeUInt16LE(0, 28);
    lokal.push(kepala, nama, kempa);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(waktu, 12);
    c.writeUInt16LE(tanggal, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(kempa.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nama.length, 28);
    c.writeUInt32LE(0, 30); // extra, komentar
    c.writeUInt32LE(0, 34); // disk, atribut internal
    c.writeUInt32LE(0, 38); // atribut eksternal
    c.writeUInt32LE(offset, 42);
    pusat.push(c, nama);
    offset += kepala.length + nama.length + kempa.length;
  }
  const bufPusat = Buffer.concat(pusat);
  const akhir = Buffer.alloc(22);
  akhir.writeUInt32LE(0x06054b50, 0);
  akhir.writeUInt16LE(0, 4);
  akhir.writeUInt16LE(0, 6);
  akhir.writeUInt16LE(berkas.length, 8);
  akhir.writeUInt16LE(berkas.length, 10);
  akhir.writeUInt32LE(bufPusat.length, 12);
  akhir.writeUInt32LE(offset, 16);
  akhir.writeUInt16LE(0, 20);
  return Buffer.concat([...lokal, bufPusat, akhir]);
}

/** Versi semver untuk manifest (Claude menolak versi tidak sah). */
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '1.0.0';
}

/**
 * Manifest MCPB (manifest_version 0.2).
 * @param {{ versi:string, dataDir:string }} o
 */
function manifest({ versi, dataDir }) {
  return {
    manifest_version: '0.2',
    name: 'kopku',
    display_name: 'KOPKU — Asisten AI Koperasi',
    version: semver(versi),
    description: 'Tanya data koperasi dari KOPKU Desktop di komputer ini: ringkasan, laporan keuangan, kolektibilitas, tunggakan, simpanan, pinjaman, SHU. Baca saja.',
    long_description:
      'Menghubungkan Claude dengan KOPKU Desktop yang sedang terbuka di komputer ini (127.0.0.1, tanpa internet tambahan). Semua alat hanya membaca; data pribadi anggota (NIK, alamat, nomor HP, tanggal lahir, nomor rekening) tidak pernah dikirim. Akses mengikuti izin pengguna KOPKU yang menyalakan Asisten AI dan dapat dimatikan kapan saja di KOPKU Desktop › Pengaturan › Asisten AI.',
    author: { name: 'KOPKU', url: 'https://koperasikufinanace.my.id' },
    homepage: 'https://koperasikufinanace.my.id',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server/stdio.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/stdio.js', '--data', dataDir] },
    },
    tools: ALAT.map((a) => ({ name: a.name, description: a.description })),
    keywords: ['koperasi', 'kopku', 'akuntansi', 'simpan pinjam'],
    compatibility: { platforms: ['win32', 'darwin'], runtimes: { node: '>=18.0.0' } },
  };
}

/**
 * Tulis paket `.mcpb`.
 * @param {{ tujuan:string, versi:string, dataDir:string, ikon?:string|null, sumberDir?:string }} o
 * @returns {string} jalur berkas
 */
function buatMcpb({ tujuan, versi, dataDir, ikon = null, sumberDir = __dirname }) {
  const berkas = [
    { nama: 'manifest.json', isi: JSON.stringify(manifest({ versi, dataDir }), null, 2) },
    // 1.0.28 — tanpa komentar (tidak memuat keterangan struktur internal KOPKU).
    { nama: 'server/stdio.js', isi: untukDikirim(fs.readFileSync(path.join(sumberDir, 'stdio.js'), 'utf8')) },
    { nama: 'server/katalog.js', isi: untukDikirim(fs.readFileSync(path.join(sumberDir, 'katalog.js'), 'utf8')) },
  ];
  if (ikon && fs.existsSync(ikon)) berkas.push({ nama: 'icon.png', isi: fs.readFileSync(ikon) });
  else berkas[0].isi = JSON.stringify(Object.assign(manifest({ versi, dataDir }), { icon: undefined }), null, 2);
  fs.mkdirSync(path.dirname(tujuan), { recursive: true });
  const tmp = `${tujuan}.tmp`;
  fs.writeFileSync(tmp, buatZip(berkas));
  fs.renameSync(tmp, tujuan);
  return tujuan;
}

module.exports = { buatMcpb, buatZip, manifest, crc32 };
