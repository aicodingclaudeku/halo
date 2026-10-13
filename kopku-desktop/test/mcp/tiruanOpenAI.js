'use strict';
/**
 * Tiruan control plane OpenAI Secure MCP Tunnel — HANYA untuk uji (1.0.31).
 *
 * Mengikuti kontrak resmi github.com/openai/tunnel-client docs/protocol.md:
 *   GET  /v1/tunnels/{id}           metadata
 *   GET  /v1/tunnels/{id}/poll      long-poll perintah (204 = kosong)
 *   POST /v1/tunnels/{id}/response  jawaban per perintah (X-Tunnel-Shard-Token)
 * `kirim(jsonrpc)` berperan sebagai ChatGPT: menaruh perintah MCP di antrean tunnel lalu menunggu jawabannya
 * yang dikirim tunnel-client-runtime ASLI setelah meneruskannya ke server MCP KOPKU.
 */
const http = require('node:http');

function buatTiruanOpenAI({ apiKey, tunnelId }) {
  const antre = [];
  const tunggu = new Map();
  const catatan = { auth: [], shardOk: true };
  let n = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    catatan.auth.push(req.headers.authorization || '');
    const json = (status, isi) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isi));
    };
    if (req.headers.authorization !== `Bearer ${srv.apiKey}`) return json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    const m = /^\/v1\/tunnels\/([^/]+)(\/poll|\/response)?$/.exec(u.pathname);
    if (!m || m[1] !== tunnelId) return json(404, { error: { message: 'Tunnel not found', code: 'not_found' } });
    if (!m[2]) return json(200, { id: tunnelId, name: 'KOPKU uji' });
    if (m[2] === '/poll') {
      const kirimAntre = () => {
        const c = antre.splice(0);
        if (!c.length) {
          res.writeHead(204);
          return res.end();
        }
        return json(200, { commands: c });
      };
      if (antre.length) return kirimAntre();
      setTimeout(kirimAntre, 200);
      return undefined;
    }
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b);
      const t = tunggu.get(j.request_id);
      if (t) {
        if (req.headers['x-tunnel-shard-token'] !== t.shard) catatan.shardOk = false;
        if (j.resp_type !== 'jsonrpc_notify') {
          tunggu.delete(j.request_id);
          t.selesai(j);
        }
      }
      json(200, { status: 'ok' });
    });
    return undefined;
  });
  srv.apiKey = apiKey;
  /** Seperti ChatGPT: kirim satu pesan MCP lewat tunnel. */
  const kirim = (jsonrpc, batasMs = 15000) => {
    const id = `req_${++n}`;
    const shard = `shard_${n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        tunggu.delete(id);
        reject(new Error(`tidak ada jawaban lewat tunnel untuk ${jsonrpc.method}`));
      }, batasMs);
      tunggu.set(id, { shard, selesai: (j) => (clearTimeout(t), resolve(j)) });
      antre.push({ request_id: id, shard_token: shard, command_type: 'jsonrpc', channel: 'main', created_at: new Date().toISOString(), response_timeout: '60s', headers: {}, jsonrpc });
    });
  };
  const mulai = (port = 0) => new Promise((r) => srv.listen(port, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
  const tutup = () => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); });
  return { srv, kirim, mulai, tutup, catatan };
}

module.exports = { buatTiruanOpenAI };
