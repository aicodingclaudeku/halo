'use strict';
/**
 * Titik masuk KOPKU Desktop (package.json "main") — sejak 1.0.13.
 *
 * 1.0.14: konektor Claude Desktop DIHAPUS. Claude Desktop yang masih memuat
 * entri lama (`KOPKU Desktop.exe --kopku-mcp-stdio`) sebelum KOPKU sempat
 * membersihkannya tidak boleh membuka aplikasi lengkap: proses itu langsung
 * keluar tanpa jendela, tanpa database.
 */
if (process.argv.includes('--kopku-mcp-stdio')) {
  const { app } = require('electron');
  app.exit(0);
} else {
  require('./main');
}
