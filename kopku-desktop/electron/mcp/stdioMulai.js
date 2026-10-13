'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · TITIK MASUK paket ekstensi `.mcpb` (server/index.js), 1.0.30.
 *
 * Node.js bawaan Claude Desktop tidak menjalankan berkas server secara langsung: berkas dimuat lewat
 * pembungkus milik Claude Desktop, sehingga `require.main !== module` dan penjaga di stdio.js
 * (`if (require.main === module)`) tidak pernah menyalakan server. Akibatnya (log Claude, 13 Okt 2026):
 * proses hidup, `initialize` diterima tetapi tidak pernah dijawab → "Request timed out".
 * Berkas ini SELALU menyalakan server, apa pun cara memuatnya.
 */
require('./stdio.js').jalankanStdio().then(() => process.exit(0));
