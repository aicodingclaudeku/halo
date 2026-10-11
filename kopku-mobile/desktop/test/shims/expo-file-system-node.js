'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const root = process.env.KOPKU_TEST_ROOT || path.join(os.tmpdir(), 'kopku-test');
const toPath = (u) => u.replace(/^file:\/\//, '');
const documentDirectory = 'file://' + path.join(root, 'documents') + '/';
const cacheDirectory = 'file://' + path.join(root, 'cache') + '/';
const EncodingType = { UTF8: 'utf8', Base64: 'base64' };
async function getInfoAsync(u) { try { const s = fs.statSync(toPath(u)); return { exists: true, isDirectory: s.isDirectory(), size: s.size, uri: u, modificationTime: s.mtimeMs / 1000 }; } catch { return { exists: false, isDirectory: false, uri: u }; } }
async function readAsStringAsync(u, o) { return fs.readFileSync(toPath(u)).toString(o?.encoding === 'base64' ? 'base64' : 'utf8'); }
async function writeAsStringAsync(u, c, o) { fs.mkdirSync(path.dirname(toPath(u)), { recursive: true }); fs.writeFileSync(toPath(u), Buffer.from(c, o?.encoding === 'base64' ? 'base64' : 'utf8')); }
async function deleteAsync(u) { fs.rmSync(toPath(u), { recursive: true, force: true }); }
async function moveAsync({ from, to }) { fs.renameSync(toPath(from), toPath(to)); }
async function copyAsync({ from, to }) { fs.cpSync(toPath(from), toPath(to), { recursive: true }); }
async function makeDirectoryAsync(u) { fs.mkdirSync(toPath(u), { recursive: true }); }
async function readDirectoryAsync(u) { return fs.readdirSync(toPath(u)); }
module.exports = { documentDirectory, cacheDirectory, EncodingType, getInfoAsync, readAsStringAsync, writeAsStringAsync, deleteAsync, moveAsync, copyAsync, makeDirectoryAsync, readDirectoryAsync };
