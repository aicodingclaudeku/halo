/** Shim desktop `expo-print` — PDF via printToPDF Chromium; cetak via dialog cetak sistem. */
import { b } from './_bridge';
export const Orientation = { portrait: 'portrait', landscape: 'landscape' };
export async function printToFileAsync(options = {}) {
  const r = await b().print.toPdf(options.html || '', { width: options.width, height: options.height, margins: options.margins });
  const out = { uri: r.uri, numberOfPages: r.numberOfPages };
  if (options.base64) out.base64 = await b().fs.readString(r.uri, 'base64');
  return out;
}
export async function printAsync(options = {}) {
  if (options.html) return void (await b().print.printHtml(options.html));
  if (options.uri) return void (await b().print.printFile(options.uri));
}
export async function selectPrinterAsync() { return { name: 'Dialog cetak sistem', url: '' }; }
export default { printToFileAsync, printAsync, selectPrinterAsync, Orientation };
