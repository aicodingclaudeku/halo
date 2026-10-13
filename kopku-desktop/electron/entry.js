'use strict';
/**
 * Titik masuk KOPKU Desktop (package.json "main") — sejak 1.0.13.
 *
 * `KOPKU Desktop.exe --kopku-mcp-stdio --data <folder>` dijalankan oleh Claude Desktop
 * untuk Pengaturan › Asisten AI (1.0.25): server MCP stdio tanpa jendela & tanpa database
 * (electron/mcp/modeStdio.js). Selain itu aplikasi lengkap dimuat seperti biasa.
 */
if (process.argv.includes('--kopku-mcp-stdio')) {
  require('./mcp/modeStdio');
} else {
  require('./main');
}
