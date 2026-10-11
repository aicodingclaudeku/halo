// Pasang ikon KOPKU + info versi ke KOPKU Desktop.exe tanpa Wine (resedit, JS murni).
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import fs from 'node:fs';
const versi = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [ma, mi, pa] = versi.split('.').map(Number);
const [exe, ico] = process.argv.slice(2);
const data = fs.readFileSync(exe);
const e = PELibrary.NtExecutable.from(data, { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(e);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
const grup = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const idGrup = grup.length ? grup[0].id : 1;
const bahasa = grup.length ? grup[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, idGrup, bahasa, iconFile.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const lang = { lang: 1033, codepage: 1200 };
vi.setStringValues(lang, {
  CompanyName: 'KOPKU', FileDescription: 'KOPKU Desktop — Keuangan Koperasi Simpan Pinjam', ProductName: 'KOPKU Desktop',
  InternalName: 'KOPKU Desktop', OriginalFilename: 'KOPKU Desktop.exe', LegalCopyright: '© KOPKU',
  FileVersion: `${versi}.0`, ProductVersion: versi,
});
vi.setFileVersion(ma, mi, pa, 0, 1033); vi.setProductVersion(ma, mi, pa, 0, 1033);
vi.outputToResourceEntries(res.entries);
res.outputResource(e);
fs.writeFileSync(exe, Buffer.from(e.generate()));
console.log('ikon & versi terpasang:', exe, 'grup ikon', idGrup);
