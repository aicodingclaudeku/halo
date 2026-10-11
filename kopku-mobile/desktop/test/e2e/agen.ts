/* Agen uji e2e: satu proses = satu perangkat (DESKTOP atau HP). */
import * as http from 'node:http';
import * as nodeCrypto from 'node:crypto';
import { getDb } from '@/database/db';
import { useSyncStore } from '@/sync/SyncStore';

const PERAN = process.env.KOPKU_PERAN as 'DESKTOP' | 'HP';
// Uji lisensi: arahkan server lisensi produksi ke server PHP lokal (web KOPKU asli).
if (process.env.KOPKU_LICENSE_BASE) {
  const asliFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((u: any, i?: any) =>
    asliFetch(typeof u === 'string' ? u.replace('https://koperasikufinanace.my.id/api', process.env.KOPKU_LICENSE_BASE as string) : u, i)) as typeof fetch;
}
let jeda503Sampai = 0;
let handler: ((r: { path: string; body: string }) => Promise<{ status: number; body: string }>) | null = null;
const PORT = Number(process.env.KOPKU_PORT || 0);

if (PERAN === 'DESKTOP') {
  (globalThis as any).kopkuDesktop = {
    info: { platform: 'linux', platformLabel: 'Uji', hostname: 'pc-uji', version: 'uji' },
    fs: { uriToPath: (u: string) => decodeURI(u.replace(/^file:\/\//, '')) },
    lan: {
      info: async () => ({ port: PORT, addresses: ['127.0.0.1'], running: true }),
      start: async () => ({ port: PORT, addresses: ['127.0.0.1'] }),
      onRequest: (h: any) => { handler = h; },
    },
    qr: { toDataUrl: async (t: string) => 'data:text/plain,' + t },
  };
  http.createServer((req, res) => {
    const c: Buffer[] = [];
    req.on('data', (d) => c.push(d));
    req.on('end', async () => {
      if (Date.now() < jeda503Sampai) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end('{"kode":"BELUM_SIAP"}');
      }
      if (req.method === 'GET' && req.url === '/kopku/v1/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"kopku":1}');
      }
      const r = handler ? await handler({ path: req.url || '', body: Buffer.concat(c).toString('utf8') }) : { status: 503, body: '{}' };
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.body);
    });
  }).listen(PORT, '127.0.0.1');
}

async function isiBaris(tabel: string, nilai: Record<string, unknown>) {
  const db = await getDb();
  const kolom = await db.getAllAsync<any>(`PRAGMA table_info("${tabel}")`);
  const v: Record<string, unknown> = {};
  for (const k of kolom) {
    if (k.name in nilai) v[k.name] = nilai[k.name];
    else if (k.notnull && k.dflt_value === null) v[k.name] = /INT|REAL|NUM/i.test(k.type) ? 0 : k.name.endsWith('_at') || k.name.startsWith('tanggal') ? '2026-01-01' : 'x';
  }
  const ks = Object.keys(v);
  return db.runAsync(`INSERT INTO "${tabel}" (${ks.map((k) => `"${k}"`).join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ...ks.map((k) => v[k] as any));
}

const perintah: Record<string, (a: any) => Promise<any>> = {
  init: async () => { await getDb(); return true; },
  isi: async (a) => isiBaris(a.tabel, a.nilai),
  sql: async (a) => { const db = await getDb(); await db.execAsync(a.sql); return true; },
  run: async (a) => { const db = await getDb(); return db.runAsync(a.sql, ...(a.params || [])); },
  all: async (a) => { const db = await getDb(); return db.getAllAsync(a.sql, ...(a.params || [])); },
  status: async () => { const s = useSyncStore.getState(); return { status: s.status, pesan: s.pesan, konflik: s.konflik.length, versi: s.versiData }; },
  qr: async () => (await import('@/sync/SyncServer')).mulaiPemasanganBaru().then((r) => r.teksQr),
  mulaiServer: async () => (await import('@/sync/SyncServer')).mulaiServerSinkron(),
  setujui: async () => { const k = useSyncStore.getState().konfirmasi; if (!k) return false; await k.setujui(); return true; },
  keputusan: async (a) => (await import('@/sync/SyncServer')).setKeputusan(a.k),
  pasang: async (a) => (await import('@/sync/SyncKlien')).pasangDenganKode(a.teks),
  pasangCadangan: async (a) => (await import('@/sync/SyncKlien')).pasangSebagaiCadangan(a.teks),
  putusDesktop: async () => (await import('@/sync/SyncServer')).putuskanPemasanganDesktop(),
  putusHp: async () => (await import('@/sync/SyncKlien')).putuskanPemasanganHp(),
  pasanganHp: async () => (await import('@/sync/SyncIdentitas')).bacaPasangan(),
  segarkanHp: async () => (await import('@/sync/SyncKlien')).segarkanStatusHp(),
  kirimDataHp: async (a) => (await import('@/sync/SyncKlien')).kirimDataHp(a.alasan),
  ambilDataDesktop: async (a) => (await import('@/sync/SyncKlien')).ambilDataDesktop(a.alasan),
  sync: async () => (await import('@/sync/SyncKlien')).sinkronkanSekarang(),
  bolehTugas: async () => (await import('@/sync/SyncKebijakan')).bolehMenjalankanTugasOtomatis(),
  tunda: async (a) => new Promise((r) => setTimeout(r, a.ms)),
  // Lisensi uji bertanda tangan kunci uji (format identik dengan server PHP).
  lisensiUji: async (a) => {
    const { getDeviceId } = await import('@/security/deviceId');
    const { persistLicense } = await import('@/security/licenseStore');
    const deviceId = await getDeviceId();
    const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const kini = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const payload = {
      license_id: a.id,
      license_type: 'PERMANENT',
      cooperative_name: a.nama ?? 'Koperasi Uji',
      device_hash: nodeCrypto.createHash('sha256').update(deviceId.trim()).digest('hex'),
      device_class: PERAN === 'DESKTOP' ? 'desktop' : 'mobile',
      activated_at: kini,
      expires_at: null,
      nonce: nodeCrypto.randomBytes(8).toString('hex'),
      iat: kini,
    };
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = nodeCrypto.sign(null, Buffer.from(body), nodeCrypto.createPrivateKey(process.env.KOPKU_TEST_PRIVKEY as string));
    await persistLicense({ activationToken: `${body}.${b64url(sig)}`, deviceId, licenseType: 'PERMANENT', expiresAt: null, activatedAt: kini, cooperativeName: payload.cooperative_name });
    return true;
  },
  jumlahRo: async () => (await import('@/sync/SyncModeBacaSaja')).jumlahTriggerBacaSaja(await getDb()),
  maskerUji: async () => {
    const { maskerIzinBacaSaja } = await import('@/sync/SyncModeBacaSaja');
    const penuh = { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true };
    return maskerIzinBacaSaja({ anggota: penuh, simpanan: penuh, backup: penuh } as any);
  },
  aktivasiLisensi: async (a) => {
    const r = await (await import('@/services/LicenseService')).activateLicense({ licenseKey: a.key, cooperativeName: a.nama });
    return r.ok ? 'OK' : `${r.code}: ${r.message}`;
  },
  lisensiValid: async () => (await import('@/services/LicenseService')).hasValidLocalLicense(),
  sponsor: async () => (await import('@/sync/SyncKlien')).sponsoriLisensiDesktop(true),
  infoDesktop: async () => (await import('@/sync/SyncKlien')).infoDesktop(),
  // Menirukan renderer desktop dimuat ulang: sesi unggah hilang + 503 sesaat.
  simulasiMuatUlang: async (a) => {
    (await import('@/sync/SyncServer'))._lupakanSesiUnggahUntukUji();
    jeda503Sampai = Date.now() + (a.ms ?? 3000);
    return true;
  },
  kirimDataHpLatar: async (a) => {
    const g: any = globalThis;
    g.__kirim = (await import('@/sync/SyncKlien')).kirimDataHp(a.alasan).then(() => 'OK', (e: any) => 'GAGAL: ' + (e?.message ?? e));
    return true;
  },
  tungguKirim: async () => (globalThis as any).__kirim,
  // RC-S133.5 — sinkron manual
  cekPermintaan: async () => (await import('@/sync/SyncKlien')).cekPermintaanDesktop(),
  tolakPermintaan: async () => (await import('@/sync/SyncKlien')).tolakPermintaanDesktop(),
  jalankanPermintaan: async (a) => (await import('@/sync/SyncKlien')).jalankanPermintaanDesktop(a.k),
  modeManual: async () => (await import('@/sync/SyncKlien')).pastikanModeManual(),
  pasangRoLama: async () => (await import('@/sync/SyncModeBacaSaja')).pasangModeBacaSaja(await getDb()),
  segarkanDesktop: async () => (await import('@/sync/SyncServer')).segarkanStatusDesktop(),
};

process.on('message', async (m: any) => {
  try {
    const hasil = await perintah[m.cmd](m.args || {});
    process.send!({ id: m.id, ok: true, hasil });
  } catch (e: any) {
    process.send!({ id: m.id, ok: false, galat: e?.message || String(e), kode: e?.kode });
  }
});
process.send!({ siap: true });
