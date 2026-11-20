'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const POLL_MS = 15000;
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (_) {  }
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([\w-]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, true]; }));
  const cfg = {
    server_url: String(args.server || process.env.PS4STORE_URL || file.server_url || '').replace(/\/+$/, ''),
    rpc_token: String(args.token || process.env.PS4STORE_RPC_TOKEN || file.rpc_token || '').trim(),
    discord_client_id: String(args.client || process.env.DISCORD_CLIENT_ID || file.discord_client_id || '').trim(),
  };
  const missing = Object.keys(cfg).filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`[PS4Store RPC] Configuration incomplète : ${missing.join(', ')}. Lancez start-rpc.bat ou renseignez config.json.`);
    process.exit(1);
  }
  return cfg;
}

function ipcPaths() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    else {
      const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
      out.push(path.join(base, `discord-ipc-${i}`), path.join(base, 'app', 'com.discordapp.Discord', `discord-ipc-${i}`), path.join(base, 'snap.discord', `discord-ipc-${i}`));
    }
  }
  return out;
}
const encode = (op, data) => {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

class DiscordIpc {
  constructor(clientId) { this.clientId = clientId; this.sock = null; this.ready = false; this.buf = Buffer.alloc(0); this.onClose = () => {}; }
  connect() {
    return new Promise((resolve, reject) => {
      const paths = ipcPaths();
      const tryNext = () => {
        const p = paths.shift();
        if (!p) return reject(new Error('Discord introuvable (est-il lancé sur cet ordinateur ?)'));
        const sock = net.createConnection(p);
        let settled = false;
        sock.once('error', () => { if (!settled) tryNext(); });
        sock.once('connect', () => {
          settled = true;
          this.sock = sock;
          sock.on('data', (d) => this.read(d, resolve));
          sock.on('close', () => { this.ready = false; this.sock = null; this.onClose(); });
          sock.on('error', () => {});
          sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
        });
      };
      tryNext();
    });
  }
  read(chunk, resolveReady) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0), len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(this.buf.toString('utf8', 8, 8 + len)); } catch (_) {  }
      this.buf = this.buf.subarray(8 + len);
      if (op === OP.PING) this.sock && this.sock.write(encode(OP.PONG, msg || {}));
      else if (op === OP.CLOSE) { console.error('[PS4Store RPC] Discord a fermé la connexion :', msg && msg.message); this.sock && this.sock.destroy(); }
      else if (msg && msg.evt === 'READY') { this.ready = true; resolveReady(msg.data && msg.data.user); }
      else if (msg && msg.evt === 'ERROR') console.error('[PS4Store RPC] Erreur Discord :', msg.data && msg.data.message);
    }
  }
  setActivity(activity) {
    if (!this.sock || !this.ready) return;
    this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity || null }, nonce: crypto.randomUUID() }));
  }
  close() { try { this.sock && this.sock.destroy(); } catch (_) {  } }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: 10000, headers: { 'User-Agent': 'PS4Store-RPC/1.0', Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

async function main() {
  const cfg = loadConfig();
  const rpc = new DiscordIpc(cfg.discord_client_id);
  let lastKey = '';
  let connecting = false;
  rpc.onClose = () => { lastKey = ''; };

  async function ensureConnected() {
    if (rpc.ready || connecting) return rpc.ready;
    connecting = true;
    try {
      const user = await rpc.connect();
      console.log(`[PS4Store RPC] Connecté à Discord${user && user.username ? ` (${user.username})` : ''}.`);
    } catch (err) {
      console.error(`[PS4Store RPC] ${err.message}`);
    } finally { connecting = false; }
    return rpc.ready;
  }

  async function tick() {
    let state = null;
    try { state = await getJson(`${cfg.server_url}/api/rpc/${encodeURIComponent(cfg.rpc_token)}`); }
    catch (err) {
      console.error(`[PS4Store RPC] Serveur : ${err.status === 404 ? 'jeton inconnu (vérifiez rpc_token)' : err.message}`);
      return;
    }
    const playing = state.online && state.game_title;
    const key = playing ? `${state.title_id}:${state.started_at}` : '';
    if (key === lastKey) return;
    if (!(await ensureConnected())) return;
    if (!playing) { rpc.setActivity(null); console.log('[PS4Store RPC] Plus de jeu en cours : présence effacée.'); }
    else {
      const activity = {
        details: `Joue à ${state.game_title}`,
        state: 'sur PS4',
        timestamps: state.started_at ? { start: state.started_at } : undefined,
        assets: { large_image: state.cover_url || undefined, large_text: state.game_title, small_text: 'PS4Store' },
      };
      rpc.setActivity(activity);
      console.log(`[PS4Store RPC] Joue à ${state.game_title} sur PS4.`);
    }
    lastKey = key;
  }

  console.log(`[PS4Store RPC] Serveur : ${cfg.server_url} — interrogation toutes les ${POLL_MS / 1000} s. Ctrl+C pour arrêter.`);
  await tick();
  const timer = setInterval(() => { tick().catch((e) => console.error('[PS4Store RPC]', e.message)); }, POLL_MS);
  const stop = () => { clearInterval(timer); rpc.setActivity(null); setTimeout(() => { rpc.close(); process.exit(0); }, 300); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { console.error('[PS4Store RPC]', err); process.exit(1); });
