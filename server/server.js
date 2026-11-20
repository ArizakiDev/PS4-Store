'use strict';


const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = '1.0.0';
const SESSION_DAYS = 7;
const MAX_SCREENSHOTS = 12;

const FIRMWARES = ['5.05', '6.72', '9.00', '11.00'];
const CATEGORIES = ['Jeux', 'Utilitaires', 'Démos'];
const ROLES = ['superadmin', 'admin'];

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline: pipelineAsync } = require('stream/promises');

(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !m[1].startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (_) {  }
})();
const dns = require('dns');
const net = require('net');
const { Readable, pipeline } = require('stream');
const express = require('express');
const cookieSession = require('cookie-session');

const GAMES_FILE = path.join(__dirname, 'games.json');
const SECRET_FILE = path.join(__dirname, '.session-secret');
const STORE_PKG = path.join(__dirname, 'public', 'store', 'PS4Store.pkg');

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_) {  }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

function createStore(file) {
  const tmp = file + '.tmp';
  let queue = Promise.resolve();
  return {
    file,
    loadSync() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('le fichier doit contenir un tableau');
        return parsed;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.error(`[PS4Store] ${path.basename(file)} est illisible :`, err.message);
        process.exit(1);
      }
    },
    save(data) {
      const snapshot = JSON.stringify(data, null, 2) + '\n';
      const job = queue.then(async () => {
        const handle = await fsp.open(tmp, 'w');
        try {
          await handle.writeFile(snapshot, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fsp.rename(tmp, file);
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}

const gamesStore = createStore(GAMES_FILE);
let games = [];

const FW_VOTE_KEYS = ['9.00', '11.00', 'issue'];
function ensureCommunity(g) {
  let changed = false;
  if (!Number.isFinite(g.downloads_count) || g.downloads_count < 0) { g.downloads_count = 0; changed = true; }
  if (!g.firmware_votes || typeof g.firmware_votes !== 'object' || Array.isArray(g.firmware_votes)) { g.firmware_votes = {}; changed = true; }
  FW_VOTE_KEYS.forEach((k) => { if (!Array.isArray(g.firmware_votes[k])) { g.firmware_votes[k] = []; changed = true; } });
  if (!Array.isArray(g.comments)) { g.comments = []; changed = true; }
  if (!Array.isArray(g.broken_reports)) { g.broken_reports = []; changed = true; }
  return changed;
}
const saveGamesRaw = gamesStore.save.bind(gamesStore);
gamesStore.save = (data) => { if (Array.isArray(data)) data.forEach(ensureCommunity); return saveGamesRaw(data); };
let dlSaveTimer = null;
function scheduleGamesSave() {
  if (dlSaveTimer) return;
  dlSaveTimer = setTimeout(() => { dlSaveTimer = null; gamesStore.save(games).catch((e) => console.warn('[PS4Store] games.json :', e.message)); }, 5000);
  if (dlSaveTimer.unref) dlSaveTimer.unref();
}
const dlSeen = new Map();
function countDownload(game, who) {
  const key = `${who}|${game.id}`, now = Date.now();
  if ((dlSeen.get(key) || 0) > now) return;
  dlSeen.set(key, now + 30 * 60 * 1000);
  if (dlSeen.size > 5000) for (const [k, exp] of dlSeen) if (exp <= now) dlSeen.delete(k);
  game.downloads_count = (game.downloads_count || 0) + 1;
  scheduleGamesSave();
}

function loadData() {
  const loadedGames = gamesStore.loadSync();
  games = loadedGames || [];
  let changed = loadedGames === null;
  games.forEach((g, i) => {
    if (typeof g.author_id !== 'string') { g.author_id = ''; changed = true; }
    if (typeof g.author_name !== 'string' || !g.author_name) { g.author_name = 'PS4Store'; changed = true; }
    if (typeof g.youtube_url !== 'string') { g.youtube_url = ''; changed = true; }
    if (!Array.isArray(g.screenshots)) { g.screenshots = []; changed = true; }
    if (typeof g.force_proxy !== 'boolean') { g.force_proxy = false; changed = true; }
    if (!RESOURCE_TYPES.includes(g.resource_type)) { g.resource_type = 'pkg'; changed = true; }
    if (typeof g.parent_title_id !== 'string') { g.parent_title_id = ''; changed = true; }
    if (!g.plugin_config || typeof g.plugin_config !== 'object') { g.plugin_config = defaultPluginConfig(); changed = true; }
    if (!Array.isArray(g.changelog)) { g.changelog = []; changed = true; }
    if (typeof g.author_username !== 'string') { g.author_username = ''; changed = true; }
    if (!g.created_at) {
      g.created_at = new Date(Date.now() - (games.length - i) * 60000).toISOString();
      changed = true;
    }
    if (!g.updated_at) { g.updated_at = g.created_at; changed = true; }
    if (ensureCommunity(g)) changed = true;
  });
  if (changed) gamesStore.save(games).catch((e) => console.error('[PS4Store] migration games.json :', e));
}

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be',
  'youtube-nocookie.com', 'www.youtube-nocookie.com']);

function extractYoutubeId(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  let id = null;
  if (host.endsWith('youtu.be')) id = u.pathname.split('/')[1];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m) id = m[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const ALLOW_PRIVATE_UPSTREAM = process.env.ALLOW_PRIVATE_UPSTREAM === '1';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_HOPS = 6;
const TARGET_TTL_MS = 10 * 60 * 1000;
const GOFILE_WT = '4fd6sg89d7s6';

class LinkError extends Error {
  constructor(message, status) { super(message); this.name = 'LinkError'; this.status = status || 422; }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return net.isIPv4(v4) ? isPrivateIp(v4) : true; }
    return /^(fc|fd|fe[89ab])/.test(l);
  }
  return true;
}

const PRIVATE_MSG = "Adresse privée ou locale : le serveur ne la relaie pas. Utilisez un lien public (la PS4 pourra en revanche télécharger directement un lien .pkg de votre réseau).";

async function assertPublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new LinkError('Lien invalide.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LinkError('Seuls les liens http(s) sont pris en charge.');
  if (ALLOW_PRIVATE_UPSTREAM) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new LinkError(PRIVATE_MSG);
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new LinkError(PRIVATE_MSG);
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch (_) { throw new LinkError(`Nom d'hôte introuvable : ${host}`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new LinkError(PRIVATE_MSG);
  return u;
}

const decodeEntities = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function tagAttr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
}

function extractDriveId(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch (_) { return null; }
  let id = null;
  const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/);
  if (m) id = m[1];
  else if (!/\/folders\//.test(u.pathname)) id = u.searchParams.get('id');
  return id && /^[\w-]{10,}$/.test(id) ? id : null;
}
function parseDriveForm(html) {
  const form = /<form\b[^>]*\baction\s*=\s*("[^"]*download[^"]*"|'[^']*download[^']*')[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = decodeEntities(form[1].slice(1, -1));
  let url;
  try { url = new URL(action, 'https://drive.usercontent.google.com/'); } catch (_) { return null; }
  const inputs = form[2].match(/<input\b[^>]*>/gi) || [];
  for (const tag of inputs) {
    const name = tagAttr(tag, 'name');
    if (name) url.searchParams.set(name, tagAttr(tag, 'value') || '');
  }
  return url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com') ? url.href : null;
}

function parseMediafire(html) {
  const tag = /<a\b[^>]*\bid\s*=\s*["']downloadButton["'][^>]*>/i.exec(html);
  if (!tag) return null;
  const href = tagAttr(tag[0], 'href');
  if (href && /^https?:\/\//i.test(href)) return href;
  const scrambled = tagAttr(tag[0], 'data-scrambled-url');
  if (scrambled) {
    const decoded = Buffer.from(scrambled, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  return null;
}

let gofileToken = { value: '', exp: 0 };
async function gofileGuestToken() {
  if (gofileToken.value && Date.now() < gofileToken.exp) return gofileToken.value;
  const r = await fetch('https://api.gofile.io/accounts', { method: 'POST', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  const token = j && j.data && j.data.token;
  if (!r.ok || j.status !== 'ok' || !token) throw new LinkError("Gofile n'a pas délivré de jeton d'accès (leur API a peut-être changé).", 502);
  gofileToken = { value: token, exp: Date.now() + 45 * 60 * 1000 };
  return token;
}
function collectGofileFiles(node, out) {
  if (!node) return out;
  if (node.type === 'file' && node.link) out.push(node);
  const kids = node.children ? Object.values(node.children) : [];
  kids.forEach((k) => collectGofileFiles(k, out));
  return out;
}
async function resolveGofile(u) {
  const m = u.pathname.match(/^\/d\/([A-Za-z0-9]+)/);
  if (!m) throw new LinkError('Lien Gofile non reconnu : utilisez un lien du type https://gofile.io/d/XXXXXX.');
  const token = await gofileGuestToken();
  const r = await fetch(`https://api.gofile.io/contents/${m[1]}?wt=${GOFILE_WT}&cache=true`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Website-Token': GOFILE_WT, 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'ok') {
    gofileToken = { value: '', exp: 0 };
    throw new LinkError(`Gofile a refusé la requête (${(j && j.status) || 'HTTP ' + r.status}). Leur API change souvent : utilisez un autre hébergeur ou un lien direct.`, 502);
  }
  const files = collectGofileFiles(j.data, []);
  if (!files.length) throw new LinkError("Aucun fichier dans ce lien Gofile (dossier vide, protégé par mot de passe ou expiré).");
  const pkgs = files.filter((f) => /\.pkg$/i.test(f.name || ''));
  const pick = (pkgs.length ? pkgs : files).sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
  return { url: pick.link, headers: { Cookie: `accountToken=${token}` } };
}

const HOSTS = [
  {
    name: 'Google Drive',
    test: (h) => h === 'drive.google.com' || h === 'docs.google.com' || h === 'drive.usercontent.google.com',
    resolve: (u) => {
      const id = extractDriveId(u.href);
      if (!id) throw new LinkError("Lien Google Drive non reconnu. Partagez un fichier (pas un dossier) en « Tous les utilisateurs disposant du lien » et collez ce lien.");
      return { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, interstitial: 'drive' };
    },
  },
  {
    name: 'Dropbox',
    test: (h) => h === 'dropbox.com' || h.endsWith('.dropbox.com') || h === 'dl.dropboxusercontent.com',
    resolve: (u) => { const v = new URL(u.href); v.searchParams.set('dl', '1'); return { url: v.href }; },
  },
  {
    name: 'Pixeldrain',
    test: (h) => /(^|\.)pixeldrain\.(com|net|dev)$/.test(h),
    resolve: (u) => {
      const m = u.pathname.match(/^\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/);
      if (!m) throw new LinkError('Lien Pixeldrain non reconnu : utilisez un lien du type https://pixeldrain.com/u/XXXXXXXX.');
      return { url: `https://pixeldrain.com/api/file/${m[1]}?download` };
    },
  },
  {
    name: 'OneDrive',
    test: (h) => h === '1drv.ms' || h === 'onedrive.live.com',
    resolve: (u) => {
      const b64 = Buffer.from(u.href).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      return { url: `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content` };
    },
  },
  {
    name: 'MediaFire',
    test: (h) => h === 'mediafire.com' || h === 'www.mediafire.com',
    resolve: async (u) => {
      const html = await fetchText(u.href);
      const direct = parseMediafire(html);
      if (!direct) throw new LinkError("Impossible de trouver le lien de téléchargement sur cette page MediaFire (fichier supprimé ou page modifiée).");
      return { url: direct };
    },
  },
  { name: 'Gofile', test: (h) => h === 'gofile.io', resolve: resolveGofile },
  {
    name: 'Mega',
    test: (h) => h === 'mega.nz' || h === 'mega.io' || h === 'mega.co.nz',
    resolve: () => { throw new LinkError("Mega chiffre ses fichiers côté navigateur : impossible de les relayer. Utilisez un autre hébergeur."); },
  },
];

function hostEntry(rawUrl) {
  let h;
  try { h = new URL(rawUrl).hostname.toLowerCase(); } catch (_) { return null; }
  return HOSTS.find((e) => e.test(h)) || null;
}
function isPlainPkgUrl(rawUrl) {
  try { return !hostEntry(rawUrl) && /\.pkg$/i.test(new URL(rawUrl).pathname); } catch (_) { return false; }
}
function resourceExt(game) {
  const t = game.resource_type || 'pkg';
  if (t === 'payload') return '.bin';
  if (t === 'plugin') return (GOLDHEN[(game.plugin_config || {}).target_type] || GOLDHEN.plugin).ext;
  return '.pkg';
}
function isPlainFileUrl(rawUrl, ext) {
  try { return !hostEntry(rawUrl) && new URL(rawUrl).pathname.toLowerCase().endsWith(ext); } catch (_) { return false; }
}
function consolePkgUrl(game, origin) {
  const ext = resourceExt(game);
  if (!game.force_proxy && isPlainFileUrl(game.pkg_url, ext)) return game.pkg_url;
  return `${origin}/dl/${encodeURIComponent(game.id)}/${encodeURIComponent(game.title_id)}${ext}`;
}

async function resolveLink(rawUrl) {
  const u = await assertPublicUrl(rawUrl);
  const entry = hostEntry(rawUrl);
  if (!entry) return { url: u.href, headers: {}, via: null };
  const t = await entry.resolve(u);
  return { headers: {}, ...t, via: entry.name };
}

async function upstreamFetch(target, { range, signal } = {}) {
  let url = target.url;
  const headers = { 'User-Agent': BROWSER_UA, 'Accept-Encoding': 'identity', ...(target.headers || {}) };
  if (range) headers.Range = range;
  const firstHost = new URL(url).host;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublicUrl(url);
    let res;
    try { res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal }); }
    catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
      throw new LinkError("Impossible de joindre l'hébergeur.", 502);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (res.body) res.body.cancel().catch(() => {});
      url = new URL(loc, url).href;
      if (new URL(url).host !== firstHost) delete headers.Cookie;
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new LinkError('Trop de redirections.');
}

const isHtml = (res) => /^text\/html/i.test(res.headers.get('content-type') || '');
async function readLimited(res, limit) {
  const chunks = []; let n = 0;
  for await (const c of Readable.fromWeb(res.body)) {
    chunks.push(c); n += c.length;
    if (n >= limit) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchText(url) {
  const { res } = await upstreamFetch({ url }, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) { if (res.body) res.body.cancel().catch(() => {}); throw new LinkError(`La page a répondu HTTP ${res.status}.`, 502); }
  return readLimited(res, 2 * 1024 * 1024);
}

async function openUpstream(target, opts) {
  let out = await upstreamFetch(target, opts);
  if (isHtml(out.res)) {
    if (target.interstitial === 'drive') {
      const html = await readLimited(out.res, 2 * 1024 * 1024);
      const next = parseDriveForm(html);
      if (!next) throw new LinkError("Google Drive refuse le téléchargement : fichier non partagé publiquement, ou quota de téléchargement dépassé.");
      out = await upstreamFetch({ url: next, headers: {} }, opts);
    }
    if (isHtml(out.res)) {
      if (out.res.body) out.res.body.cancel().catch(() => {});
      throw new LinkError("Ce lien renvoie une page web et non un fichier : utilisez un lien de téléchargement direct ou de partage reconnu.");
    }
  }
  return out;
}

const targetCache = new Map();
async function getTarget(rawUrl, fresh) {
  const hit = targetCache.get(rawUrl);
  if (!fresh && hit && hit.exp > Date.now()) return hit.target;
  const target = await resolveLink(rawUrl);
  targetCache.set(rawUrl, { target, exp: Date.now() + TARGET_TTL_MS });
  if (targetCache.size > 200) targetCache.delete(targetCache.keys().next().value);
  return target;
}

const PKG_TYPES = { 0x1A: 'Jeu / application', 0x1B: 'Contenu additionnel', 0x1C: 'Contenu additionnel', 0x1E: 'Mise à jour' };
function parsePkgHeader(buf) {
  if (!buf || buf.length < 0x440 || buf.readUInt32BE(0) !== 0x7F434E54) return null;
  const contentId = buf.toString('ascii', 0x40, 0x40 + 36);
  if (!/^[\x20-\x7E]{36}$/.test(contentId)) return null;
  const size = Number(buf.readBigUInt64BE(0x430));
  return {
    content_id: contentId,
    title_id: contentId.slice(7, 16),
    type: PKG_TYPES[buf.readUInt32BE(0x74)] || 'Type inconnu',
    type_code: buf.readUInt32BE(0x74),
    package_size: size,
  };
}
function formatSize(bytes) {
  if (!(bytes > 0)) return '';
  const go = bytes / (1024 ** 3);
  if (go >= 1) return go.toFixed(1).replace('.', ',') + ' Go';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' Ko';
  return Math.round(bytes / (1024 ** 2)) + ' Mo';
}
function totalFromResponse(res) {
  const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  if (cr) return Number(cr[1]);
  const cl = Number(res.headers.get('content-length'));
  return res.status === 200 && cl > 0 ? cl : null;
}

async function probeLink(rawUrl, opts = {}) {
  const resourceType = RESOURCE_TYPES.includes(opts.resource_type) ? opts.resource_type : 'pkg';
  const ext = resourceExt({ resource_type: resourceType, plugin_config: { target_type: opts.target_type } });
  const expectPkg = resourceType === 'pkg' || resourceType === 'update' || resourceType === 'dlc';
  const entry = hostEntry(rawUrl);
  const plain = isPlainFileUrl(rawUrl, ext);
  const info = { host: entry ? entry.name : (plain ? `Lien ${ext} direct` : 'Lien direct'), mode: plain ? 'direct' : 'relais', kind: expectPkg ? 'pkg' : 'file' };
  if (plain) {
    try { await assertPublicUrl(rawUrl); } catch (err) {
      if (err instanceof LinkError) return { ...info, checked: false, message: "Adresse privée : la console la téléchargera directement, mais ce serveur ne peut pas la vérifier." };
      throw err;
    }
  }
  const target = await getTarget(rawUrl, true);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    let opened;
    try { opened = await openUpstream(target, { range: 'bytes=0-4095', signal: ctrl.signal }); }
    catch (err) { if (err && err.name === 'AbortError') throw new LinkError("L'hébergeur ne répond pas (délai dépassé).", 504); throw err; }
    const res = opened.res;
    if (res.status !== 200 && res.status !== 206) {
      if (res.body) res.body.cancel().catch(() => {});
      throw new LinkError(`L'hébergeur a répondu HTTP ${res.status} (fichier introuvable, privé ou supprimé).`);
    }
    const acceptsRange = res.status === 206;
    const total = totalFromResponse(res);
    const chunks = []; let n = 0;
    for await (const c of Readable.fromWeb(res.body)) { chunks.push(c); n += c.length; if (n >= 4096) break; }
    const head = Buffer.concat(chunks);
    if (!expectPkg) {
      return { ...info, checked: true, accepts_range: acceptsRange, total_bytes: total || head.length || null, size_label: formatSize(total || head.length), pkg_valid: null, pkg: null };
    }
    const pkg = parsePkgHeader(head);
    const expected = { pkg: [0x1A], update: [0x1E], dlc: [0x1B, 0x1C] }[resourceType];
    const typeOk = pkg ? expected.includes(pkg.type_code) : null;
    return {
      ...info, checked: true, accepts_range: acceptsRange, total_bytes: total, size_label: formatSize(total),
      pkg_valid: !!pkg, pkg, type_ok: typeOk,
    };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  return { raw: header.trim(), start: m[1] === '' ? null : Number(m[1]), end: m[2] === '' ? null : Number(m[2]), suffix: m[1] === '' ? Number(m[2]) : null };
}

async function* sliceBody(webBody, start, length) {
  const reader = webBody.getReader();
  let skipped = 0; let sent = 0;
  try {
    while (sent < length) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value);
      if (skipped < start) {
        const need = start - skipped;
        if (chunk.length <= need) { skipped += chunk.length; continue; }
        chunk = chunk.subarray(need); skipped = start;
      }
      if (chunk.length > length - sent) chunk = chunk.subarray(0, length - sent);
      sent += chunk.length;
      yield chunk;
    }
  } finally { try { await reader.cancel(); } catch (_) {  } }
}

const RESOURCE_TYPES = ['pkg', 'update', 'dlc', 'plugin', 'payload'];
const TARGET_TYPES = ['plugin', 'cheat', 'patch', 'payload'];
const REGIONS = ['EU', 'US', 'BOTH'];
const MAX_CHANGELOG = 50;

const GOLDHEN = {
  plugin: { dir: '/data/GoldHEN/plugins', ext: '.prx', ini: '/data/GoldHEN/plugins.ini' },
  cheat: { dir: '/data/GoldHEN/cheats/json', ext: '.json' },
  patch: { dir: '/data/GoldHEN/patches/xml', ext: '.xml' },
  payload: { dir: '/data/GoldHEN/payloads', ext: '.bin' },
};
const emptyRegion = () => ({ title_id: '', install_dir: '', filename: '', ini_section: '', ini_line: '' });
function defaultPluginConfig() {
  return { supported_regions: 'BOTH', eu: emptyRegion(), us: emptyRegion(), target_type: 'plugin' };
}
const targetsFor = (resourceType) => (resourceType === 'payload' ? ['payload'] : ['plugin', 'cheat', 'patch']);
const isModType = (resourceType) => resourceType === 'plugin' || resourceType === 'payload';

function suggestFilename(target, titleId, baseName, gameVersion) {
  const base = String(baseName || 'mod').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/\.(prx|json|xml|bin)$/i, '').slice(0, 48) || 'mod';
  if (target === 'cheat') return `${titleId || 'CUSA00000'}_${gameVersion || '01.00'}.json`;
  if (target === 'patch') return `${titleId || 'CUSA00000'}.xml`;
  if (target === 'payload') return `${base}.bin`;
  return `${base}.prx`;
}
function buildRegion(target, titleId, filename) {
  const spec = GOLDHEN[target];
  const r = { title_id: titleId || '', install_dir: spec.dir, filename, ini_section: '', ini_line: '' };
  if (target === 'plugin') {
    r.ini_section = `[${titleId || 'default'}]`;
    r.ini_line = `${spec.dir}/${filename}`;
  }
  return r;
}

function normalizePluginConfig(raw, resourceType) {
  const errors = [];
  if (!isModType(resourceType)) return { config: defaultPluginConfig(), errors };
  const src = raw && typeof raw === 'object' ? raw : {};
  const target = String(src.target_type || '');
  const regions = String(src.supported_regions || '');
  if (!targetsFor(resourceType).includes(target)) errors.push(`Type de cible invalide (${targetsFor(resourceType).join(', ')}).`);
  if (!REGIONS.includes(regions)) errors.push('Compatibilité régionale invalide (EU, US ou les deux).');
  const config = { supported_regions: REGIONS.includes(regions) ? regions : 'BOTH', eu: emptyRegion(), us: emptyRegion(), target_type: targetsFor(resourceType).includes(target) ? target : targetsFor(resourceType)[0] };
  const spec = GOLDHEN[config.target_type];

  for (const key of ['eu', 'us']) {
    const active = config.supported_regions === 'BOTH' || config.supported_regions === key.toUpperCase();
    if (!active) continue;
    const label = key.toUpperCase();
    const r = src[key] && typeof src[key] === 'object' ? src[key] : {};
    const s = (k) => (typeof r[k] === 'string' ? r[k].trim() : '');
    const titleId = s('title_id').toUpperCase();
    const filename = s('filename');
    const idOk = /^CUSA\d{5}$/.test(titleId);
    if (config.target_type === 'payload' ? (titleId && !idOk) : !idOk) errors.push(`${label} : Title ID invalide (format CUSA12345).`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(filename) || filename.includes('..') || !filename.toLowerCase().endsWith(spec.ext)) {
      errors.push(`${label} : nom de fichier invalide (lettres, chiffres, . _ - ; extension ${spec.ext}).`);
    }
    if (s('install_dir') && s('install_dir') !== spec.dir) errors.push(`${label} : dossier non autorisé (attendu ${spec.dir}).`);
    const built = buildRegion(config.target_type, titleId, filename);
    if (config.target_type === 'plugin') {
      const sec = s('ini_section');
      if (sec && sec !== built.ini_section) errors.push(`${label} : section plugins.ini attendue ${built.ini_section}.`);
      if (s('ini_line') && s('ini_line') !== built.ini_line) errors.push(`${label} : ligne plugins.ini attendue ${built.ini_line}.`);
    }
    config[key] = built;
  }
  return { config, errors };
}

function sanitizeChangelog(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === 'object').map((e) => ({
    version: String(e.version || '').slice(0, 16),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) ? e.date : String(e.date || '').slice(0, 10),
    notes: String(e.notes || '').slice(0, 600),
  })).slice(0, MAX_CHANGELOG);
}
function withChangelogEntry(existing, body, fallbackVersion) {
  const list = sanitizeChangelog(existing);
  const notes = typeof body.changelog_notes === 'string' ? body.changelog_notes.trim() : '';
  const errors = [];
  if (!notes) return { list, errors };
  if (notes.length > 600) errors.push("La note de mise à jour est limitée à 600 caractères.");
  const version = (typeof body.changelog_version === 'string' && body.changelog_version.trim()) || fallbackVersion;
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-_]{0,15}$/.test(version || '')) errors.push('Version de la note invalide.');
  const date = (typeof body.changelog_date === 'string' && body.changelog_date.trim()) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Date de la note invalide (AAAA-MM-JJ).');
  if (!errors.length) list.unshift({ version, date, notes });
  return { list: list.slice(0, MAX_CHANGELOG), errors };
}

const KNOWN_TITLES_FILE = path.join(__dirname, 'known_titles.json');
const KNOWN_TITLES_DEFAULT = [
  { name: 'Grand Theft Auto V', aliases: ['gta v', 'gta 5', 'gtav', 'gta5', 'grand theft auto v', 'grand theft auto 5'], eu: 'CUSA00411', us: 'CUSA00419' },
  { name: 'Red Dead Redemption 2', aliases: ['rdr2', 'rdr 2', 'red dead redemption 2', 'red dead 2'], eu: 'CUSA08519', us: 'CUSA03041' },
  { name: 'Bloodborne', aliases: ['bloodborne'], eu: 'CUSA00207', us: 'CUSA00900' },
  { name: 'Call of Duty: Black Ops III', aliases: ['black ops 3', 'black ops iii', 'bo3', 'cod bo3', 'call of duty black ops 3', 'call of duty black ops iii'], eu: 'CUSA02624', us: 'CUSA02290' },
];
function loadKnownTitles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KNOWN_TITLES_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      return parsed.filter((t) => t && t.name && /^CUSA\d{5}$/.test(t.eu || '') && /^CUSA\d{5}$/.test(t.us || ''))
        .map((t) => ({ name: String(t.name), aliases: Array.isArray(t.aliases) ? t.aliases.map((a) => String(a).toLowerCase()) : [], eu: t.eu, us: t.us }));
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      try { fs.writeFileSync(KNOWN_TITLES_FILE, JSON.stringify(KNOWN_TITLES_DEFAULT, null, 2) + '\n'); } catch (_) {  }
    } else console.warn('[PS4Store] known_titles.json illisible, table par défaut utilisée :', err.message);
  }
  return KNOWN_TITLES_DEFAULT;
}
const KNOWN_TITLES = loadKnownTitles();

function flatPluginFields(g) {
  const pc = g.plugin_config || defaultPluginConfig();
  const out = { regions: pc.supported_regions || 'BOTH', target_type: pc.target_type || '' };
  for (const key of ['eu', 'us']) {
    const r = pc[key] || emptyRegion();
    out[`${key}_title_id`] = r.title_id || '';
    out[`${key}_install_dir`] = r.install_dir || '';
    out[`${key}_filename`] = r.filename || '';
    out[`${key}_ini_section`] = r.ini_section || '';
    out[`${key}_ini_line`] = r.ini_line || '';
  }
  return out;
}

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 25000;

const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function buildAiSystemPrompt() {
  const table = KNOWN_TITLES.map((t) => `- ${t.name} : EU ${t.eu} / US ${t.us}`).join('\n');
  return [
    "Tu es l'assistant de PS4Store. Tu aides un administrateur à renseigner l'installation d'une ressource homebrew PS4 (GoldHEN).",
    '',
    'ARCHITECTURE DES DOSSIERS SUR LA CONSOLE :',
    `- Plugin GoldHEN : fichier ${GOLDHEN.plugin.dir}/<fichier>.prx, déclaré dans ${GOLDHEN.plugin.ini} sous la section [CUSAXXXXX] (ou [default] si valable pour tous les jeux), avec la ligne ${GOLDHEN.plugin.dir}/<fichier>.prx.`,
    `- Cheat GoldHEN : ${GOLDHEN.cheat.dir}/<CUSAXXXXX>_<VERSION>.json (VERSION = version du jeu, ex. 01.00).`,
    `- Patch GoldHEN : ${GOLDHEN.patch.dir}/<CUSAXXXXX>.xml`,
    `- Payload : ${GOLDHEN.payload.dir}/<fichier>.bin (envoyé au BinLoader ; pas de Title ID).`,
    '',
    'TITLE ID CONNUS (région EU / région US) :',
    table,
    '',
    'RÈGLES : ne jamais inventer un Title ID. Si le jeu n\'est pas dans la liste ci-dessus et que le texte ne donne pas de Title ID CUSA, laisse la valeur vide.',
    'Réponds UNIQUEMENT par un objet JSON strict, sans texte autour, de cette forme :',
    '{"target_type":"plugin|cheat|patch|payload","game":"nom du jeu visé ou chaîne vide","eu_title_id":"CUSAxxxxx ou vide","us_title_id":"CUSAxxxxx ou vide","base_name":"nom de fichier sans extension","game_version":"01.00","explanation":"une phrase"}',
  ].join('\n');
}

function findKnownTitle(text) {
  const hay = ` ${foldText(text).replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null; let bestLen = 0;
  for (const t of KNOWN_TITLES) {
    for (const alias of [t.name, ...t.aliases]) {
      const a = foldText(alias).replace(/[^a-z0-9]+/g, ' ').trim();
      if (a.length > bestLen && hay.includes(` ${a} `)) { best = t; bestLen = a.length; }
    }
  }
  return best;
}

function heuristicAnalysis({ description, titre, pkg_url, resource_type, target_type }) {
  const text = `${titre || ''}\n${description || ''}`;
  const folded = foldText(text);
  let url = '';
  try { url = new URL(pkg_url).pathname.toLowerCase(); } catch (_) {  }
  let target = resource_type === 'payload' ? 'payload' : (targetsFor(resource_type).includes(target_type) ? target_type : '');
  if (!target) {
    if (url.endsWith('.json') || /\b(cheat|cheats|trainer|triche|tricheur)\b/.test(folded)) target = 'cheat';
    else if (url.endsWith('.xml') || /\b(patch|patches|60 ?fps|fps patch|correctif)\b/.test(folded)) target = 'patch';
    else target = 'plugin';
  }
  const known = findKnownTitle(text);
  const explicit = [...new Set((text.toUpperCase().match(/CUSA\d{5}/g) || []))];
  const ver = (text.match(/\b(\d{2}\.\d{2})\b/) || [])[1] || '01.00';
  let base = '';
  try { base = decodeURIComponent(new URL(pkg_url).pathname.split('/').pop() || ''); } catch (_) {  }
  base = base.replace(/\.(prx|json|xml|bin)$/i, '') || foldText(titre).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mod';
  return { target_type: target, known, explicit, game_version: ver, base_name: base };
}

function assembleConfig(target, scope, ids, baseName, gameVersion) {
  const config = { supported_regions: scope, eu: emptyRegion(), us: emptyRegion(), target_type: target };
  for (const key of ['eu', 'us']) {
    if (!(scope === 'BOTH' || scope === key.toUpperCase())) continue;
    const titleId = target === 'payload' ? '' : (ids[key] || '');
    config[key] = buildRegion(target, titleId, suggestFilename(target, titleId, baseName, gameVersion));
  }
  return config;
}

async function askOllama(input) {
  const prompt = [
    `Type de ressource : ${input.resource_type}`,
    `Portée demandée : ${input.scope}`,
    `Titre : ${input.titre || '(vide)'}`,
    `Lien du fichier : ${input.pkg_url || '(vide)'}`,
    `Description :\n${input.description || '(vide)'}`,
  ].join('\n');
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, system: buildAiSystemPrompt(), prompt, stream: false, format: 'json', options: { temperature: 0 } }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Ollama a répondu HTTP ${r.status}`);
  const j = await r.json();
  const parsed = JSON.parse(String(j.response || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Réponse JSON inattendue');
  return parsed;
}

async function aiPluginHelper(input) {
  const warnings = [];
  const h = heuristicAnalysis(input);
  let source = 'fallback';
  let ai = null;
  try {
    ai = await askOllama(input);
    source = 'ollama';
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    warnings.push(timeout ? "Ollama n'a pas répondu à temps : analyse intégrée utilisée." : 'Ollama est éteint ou inaccessible : analyse intégrée utilisée.');
  }

  let target = h.target_type;
  if (ai && targetsFor(input.resource_type).includes(String(ai.target_type)) && !targetsFor(input.resource_type).includes(input.target_type || '')) target = ai.target_type;
  if (input.resource_type === 'payload') target = 'payload';

  let known = h.known;
  if (!known && ai && ai.game) known = findKnownTitle(String(ai.game));

  const ids = { eu: '', us: '' };
  if (known) { ids.eu = known.eu; ids.us = known.us; }
  const typed = new Set(h.explicit);
  if (!known) {
    if (typed.size === 2) { [ids.eu, ids.us] = [...typed]; warnings.push('Deux Title ID trouvés dans le texte : le premier est attribué à EU, le second à US. Vérifiez.'); }
    else if (typed.size === 1) {
      const only = [...typed][0];
      if (input.scope === 'EU') ids.eu = only; else if (input.scope === 'US') ids.us = only;
      else { ids.eu = only; ids.us = only; warnings.push('Un seul Title ID trouvé : il est utilisé pour EU et US. Corrigez celui de la région concernée.'); }
    }
  }
  if (ai) {
    for (const key of ['eu', 'us']) {
      const proposed = String(ai[`${key}_title_id`] || '').toUpperCase();
      if (!/^CUSA\d{5}$/.test(proposed) || ids[key]) continue;
      const verifiable = typed.has(proposed) || KNOWN_TITLES.some((t) => t[key] === proposed);
      if (verifiable) ids[key] = proposed;
      else warnings.push(`Le Title ID ${key.toUpperCase()} proposé par l'IA (${proposed}) n'est pas vérifiable : ignoré.`);
    }
  }

  let base = h.base_name;
  if (ai && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(String(ai.base_name || '')) && !/^(mod|plugin|file|fichier)$/i.test(String(ai.base_name))) base = ai.base_name;
  let version = h.game_version;
  if (ai && /^\d{2}\.\d{2}$/.test(String(ai.game_version || '')) && h.game_version === '01.00') version = ai.game_version;

  const config = assembleConfig(target, input.scope, ids, base, version);
  if (target !== 'payload') {
    for (const key of ['eu', 'us']) {
      if ((input.scope === 'BOTH' || input.scope === key.toUpperCase()) && !config[key].title_id) {
        warnings.push(`Title ID ${key.toUpperCase()} introuvable : renseignez-le (format CUSA12345).`);
      }
    }
  }
  const explanation = ai && typeof ai.explanation === 'string' ? ai.explanation.slice(0, 240)
    : (known ? `Jeu reconnu : ${known.name}.` : 'Configuration déduite du texte et du lien.');
  return { source, model: source === 'ollama' ? OLLAMA_MODEL : null, plugin_config: config, game: known ? known.name : '', explanation, warnings };
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}
function isImageRef(value) {
  if (value.length > 500) return false;
  if (isHttpUrl(value)) return true;
  return /^\/[^/\\][^\\]*$/.test(value) && !value.includes('..');
}

function generateTitleId(prefix) {
  for (let n = 1; n < 100000; n++) {
    const id = prefix + String(n).padStart(5, '0');
    if (!games.some((g) => g.title_id === id) && !(typeof submissions !== 'undefined' && submissions.some((x) => x.status === 'pending' && x.game.title_id === id))) return id;
  }
  return prefix + '99999';
}

function titleConflict(value, currentId) {
  return games.some((g) => {
    if (g.id === currentId) return false;
    if (value.resource_type === 'pkg') return (g.resource_type || 'pkg') === 'pkg' && g.title_id === value.title_id;
    return g.resource_type === value.resource_type && g.title_id === value.title_id && g.version === value.version;
  });
}

function validateGame(body, opts = {}) {
  const str = (k) => (typeof body[k] === 'string' ? body[k].trim() : '');
  const resourceType = RESOURCE_TYPES.includes(str('resource_type')) ? str('resource_type') : 'pkg';
  const mod = isModType(resourceType);
  const rawTid = str('title_id');
  const compactTid = rawTid.replace(/\s+/g, '').toUpperCase();
  const tidLooksLikeId = /^[A-Z]{4}\d+$/.test(compactTid);
  const value = {
    resource_type: resourceType,
    titre: str('titre') || (tidLooksLikeId ? '' : rawTid),
    title_id: tidLooksLikeId ? compactTid : '',
    description: str('description'),
    version: str('version'),
    firmware_min: str('firmware_min') || FIRMWARES[0],
    categorie: str('categorie') || (mod ? 'Utilitaires' : 'Jeux'),
    size: str('size') || 'N/A',
    icon_url: str('icon_url') || '/icons/default.png',
    pkg_url: str('pkg_url'),
    parent_title_id: str('parent_title_id').toUpperCase(),
    plugin_config: defaultPluginConfig(),
    youtube_url: '',
    screenshots: [],
    force_proxy: body.force_proxy === '1' || body.force_proxy === 'on' || body.force_proxy === true,
  };
  const errors = [];

  if (!value.title_id && (mod || resourceType === 'pkg')) value.title_id = generateTitleId(resourceType === 'payload' ? 'PAYL' : mod ? 'PLUG' : 'BREW');
  if (value.titre.length < 1 || value.titre.length > 80) errors.push('Le titre est requis (80 caractères max).');
  if (!/^[A-Z]{4}\d{5}$/.test(value.title_id)) errors.push('Le Title ID doit suivre le format ABCD12345 (ex. BREW00001).');
  if (value.description.length > 2000) errors.push('La description est limitée à 2000 caractères.');
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-_]{0,15}$/.test(value.version)) errors.push('La version est requise (ex. 1.00).');
  if (!FIRMWARES.includes(value.firmware_min)) errors.push('Firmware minimum invalide.');
  if (!CATEGORIES.includes(value.categorie)) errors.push('Catégorie invalide.');
  if (value.size.length < 1 || value.size.length > 20) errors.push('La taille est requise (ex. 420 Mo).');
  if (!isImageRef(value.icon_url)) errors.push("L'URL de l'icône doit être un lien http(s) direct ou un chemin local (/icons/...).");
  if (!isHttpUrl(value.pkg_url) || value.pkg_url.length > 1000) {
    errors.push(mod
      ? "L'URL du fichier doit être un lien http(s) (direct, ou de partage Google Drive, Dropbox, Gofile…)."
      : "L'URL du .pkg doit être un lien http(s) (direct, ou de partage Google Drive, Dropbox, Gofile…).");
  }

  if (value.parent_title_id) {
    if (!/^[A-Z]{4}\d{5}$/.test(value.parent_title_id)) errors.push('Le Title ID du jeu principal est invalide.');
    else if (!games.some((g) => g.id !== opts.currentId && (g.resource_type || 'pkg') === 'pkg' && g.title_id === value.parent_title_id)) {
      errors.push(`Aucun jeu principal du catalogue n'a le Title ID ${value.parent_title_id}.`);
    }
  }

  if (mod) {
    const pc = normalizePluginConfig({
      supported_regions: str('pc_regions'),
      target_type: str('pc_target') || (resourceType === 'payload' ? 'payload' : ''),
      eu: { title_id: str('pc_eu_title_id'), install_dir: str('pc_eu_install_dir'), filename: str('pc_eu_filename'), ini_section: str('pc_eu_ini_section'), ini_line: str('pc_eu_ini_line') },
      us: { title_id: str('pc_us_title_id'), install_dir: str('pc_us_install_dir'), filename: str('pc_us_filename'), ini_section: str('pc_us_ini_section'), ini_line: str('pc_us_ini_line') },
    }, resourceType);
    value.plugin_config = pc.config;
    errors.push(...pc.errors);
  }

  if (errors.length === 0 && titleConflict(value, opts.currentId)) {
    errors.push(value.resource_type === 'pkg' ? 'Ce Title ID est déjà utilisé.' : 'Cette ressource existe déjà (même type, Title ID et version).');
  }

  const yt = str('youtube_url');
  if (yt) {
    const id = extractYoutubeId(yt);
    if (id) value.youtube_url = `https://www.youtube.com/watch?v=${id}`;
    else errors.push("Le lien YouTube n'est pas valide.");
  }

  const shots = str('screenshots').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(shots)];
  if (uniq.length > MAX_SCREENSHOTS) errors.push(`Maximum ${MAX_SCREENSHOTS} captures d'écran.`);
  else if (uniq.some((s) => !isImageRef(s))) errors.push('Chaque capture d\'écran doit être un lien http(s) direct.');
  else value.screenshots = uniq;

  return { value, errors };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function storePackageInfo() {
  try {
    const st = fs.statSync(STORE_PKG);
    if (!st.isFile() || st.size === 0) return { available: false };
    const mo = st.size / (1024 * 1024);
    return { available: true, size: (mo >= 10 ? Math.round(mo) : mo.toFixed(1).replace('.', ',')) + ' Mo' };
  } catch (_) {
    return { available: false };
  }
}

function isRecentlyUpdated(g) {
  const up = Date.parse(g.updated_at), cr = Date.parse(g.created_at);
  return Number.isFinite(up) && Number.isFinite(cr) && up - cr > 60000 && Date.now() - up < 14 * 86400000;
}
function publicGame(g) {
  const { pkg_url, comments, firmware_votes, link_check, broken_reports, ...rest } = g;
  return { ...rest, downloads_count: g.downloads_count || 0, recently_updated: isRecentlyUpdated(g) };
}

function accountById(id) {
  const u = users.find((x) => x.id === id);
  if (u) return { id: u.id, username: u.username, display_name: u.display_name || u.username, avatar_url: avatarUrl(u), bio: u.bio, socials: u.socials, role: u.role === 'user' ? 'creator' : 'admin', role_key: roleKeyOf(u), created_at: u.created_at };
  return null;
}

function publicGameCard(g) {
  const a = accountById(g.author_id);
  return {
    ...publicGame(g),
    author_avatar: a ? a.avatar_url || '' : '',
    author_url: a ? `/membre/${encodeURIComponent(a.username)}` : '',
  };
}

const byNewest = (a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at));

const canManage = (admin, game) => admin.role === 'superadmin' || game.author_id === admin.id;
const adminView = (a) => ({
  id: a.id, username: a.username, display_name: a.display_name || a.username, avatar_url: avatarUrl(a), bio: a.bio || '',
  socials: a.socials || [], role: a.role, role_key: a.role === 'superadmin' ? 'superadmin' : 'admin', created_at: a.created_at,
});

function roleKeyOf(u) {
  if (u.role === 'superadmin' || u.role === 'admin') return u.role;
  return games.some((g) => g.author_id === u.id) ? 'creator' : 'member';
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] || '?';
  const second = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return (first + second).toLocaleUpperCase('fr-FR');
}

function authorOf(game) {
  const a = accountById(game.author_id);
  const creations = a
    ? games.filter((g) => g.author_id === a.id).length
    : games.filter((g) => g.author_name === game.author_name).length;
  if (!a) return { display_name: game.author_name, avatar_url: '', bio: '', socials: [], role: 'admin', known: false, creations, username: game.author_username || '', url: '' };
  return {
    display_name: a.display_name, avatar_url: a.avatar_url || '', bio: a.bio || '', socials: a.socials || [], role: a.role, known: true, creations,
    username: a.username, url: `/membre/${encodeURIComponent(a.username)}`, role_key: a.role_key,
  };
}

function parseSocials(text) {
  const list = []; const errors = [];
  for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const parts = line.includes('|') ? line.split('|') : null;
    const label = parts ? parts[0].trim() : '';
    const url = (parts ? parts.slice(1).join('|') : line).trim();
    if (!isHttpUrl(url) || url.length > 300) { errors.push(`Lien social invalide : ${line.slice(0, 40)}`); continue; }
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {  }
    list.push({ label: (label || host).slice(0, 30), url });
  }
  if (list.length > 6) errors.push('Maximum 6 liens sociaux.');
  return { list: list.slice(0, 6), errors };
}

function validateProfile(body) {
  const str = (k) => (typeof body[k] === 'string' ? body[k].trim() : '');
  const soc = parseSocials(typeof body.socials === 'string' ? body.socials : '');
  const value = { display_name: str('display_name'), avatar_url: str('avatar_url'), bio: str('bio').replace(/\r\n/g, '\n'), socials: soc.list };
  const errors = [...soc.errors];
  if (value.display_name.length < 1 || value.display_name.length > 40) errors.push('Le nom affiché est requis (40 caractères max).');
  if (value.avatar_url && !isImageRef(value.avatar_url)) errors.push("L'URL de la photo doit être un lien http(s) direct.");
  if (value.bio.length > 280) errors.push('La présentation est limitée à 280 caractères.');
  return { value, errors };
}

async function syncAuthorName(adminId, name) {
  let changed = false;
  games.forEach((g) => { if (g.author_id === adminId && g.author_name !== name) { g.author_name = name; changed = true; } });
  if (changed) await gamesStore.save(games);
}

const CLIENT_CHANGELOG_FILE = path.join(__dirname, 'client_changelog.json');
let clientInfoCache = { key: '', info: null };

function parseSfoString(sfo, wanted) {
  if (sfo.length < 20 || sfo.readUInt32LE(0) !== 0x46535000) return null;
  const keyTable = sfo.readUInt32LE(8); const dataTable = sfo.readUInt32LE(12); const count = sfo.readUInt32LE(16);
  for (let i = 0; i < count && 20 + i * 16 + 16 <= sfo.length; i++) {
    const e = 20 + i * 16;
    const keyOff = keyTable + sfo.readUInt16LE(e);
    const fmt = sfo.readUInt16LE(e + 2); const len = sfo.readUInt32LE(e + 4); const dataOff = dataTable + sfo.readUInt32LE(e + 12);
    const keyEnd = sfo.indexOf(0, keyOff);
    if (keyEnd < 0 || sfo.toString('ascii', keyOff, keyEnd) !== wanted) continue;
    if (fmt !== 0x0004 && fmt !== 0x0204) return null;
    const end = Math.min(sfo.length, dataOff + len);
    const zero = sfo.indexOf(0, dataOff);
    return sfo.toString('utf8', dataOff, zero >= 0 && zero < end ? zero : end);
  }
  return null;
}

function readPkgSfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(0x40);
    if (fs.readSync(fd, head, 0, 0x40, 0) < 0x40 || head.readUInt32BE(0) !== 0x7F434E54) return null;
    const count = head.readUInt32BE(0x10); const tableOff = head.readUInt32BE(0x18);
    if (!count || count > 4096) return null;
    const table = Buffer.alloc(count * 32);
    if (fs.readSync(fd, table, 0, table.length, tableOff) < table.length) return null;
    for (let i = 0; i < count; i++) {
      if (table.readUInt32BE(i * 32) !== 0x1000) continue;
      const off = table.readUInt32BE(i * 32 + 16); const size = table.readUInt32BE(i * 32 + 20);
      if (!size || size > 65536) return null;
      const sfo = Buffer.alloc(size);
      if (fs.readSync(fd, sfo, 0, size, off) < size) return null;
      return sfo;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {  } }
  }
}
function readPkgVersion(file) {
  const sfo = readPkgSfo(file);
  return sfo ? (parseSfoString(sfo, 'APP_VER') || parseSfoString(sfo, 'VERSION')) : null;
}

function clientInfo() {
  try {
    const st = fs.statSync(STORE_PKG);
    const key = `${st.size}:${st.mtimeMs}`;
    if (clientInfoCache.key !== key) clientInfoCache = { key, info: { version: readPkgVersion(STORE_PKG), size: st.size, updated_at: st.mtime.toISOString() } };
    return clientInfoCache.info;
  } catch (_) {
    return null;
  }
}
const displayClientVersion = (v) => (v ? String(v).replace(/^0+(?=\d)/, '') : '');

function readClientChangelog() {
  try {
    return sanitizeChangelog(JSON.parse(fs.readFileSync(CLIENT_CHANGELOG_FILE, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        fs.writeFileSync(CLIENT_CHANGELOG_FILE, JSON.stringify([
          { version: '01.10', date: new Date().toISOString().slice(0, 10), notes: "Mise à jour automatique, jeux installés, mise en arrière-plan." },
        ], null, 2) + '\n');
      } catch (_) {  }
    }
    return [];
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const STORE_DIR = path.dirname(STORE_PKG);
const RELEASE_FILE = path.join(DATA_DIR, 'client_release.json');
for (const dir of [DATA_DIR, STORE_DIR]) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {  } }

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} Go`;
  const mo = n / 1024 ** 2;
  return `${mo >= 10 ? Math.round(mo) : mo.toFixed(1).replace('.', ',')} Mo`;
}

function currentRelease() {
  const info = clientInfo();
  try {
    const r = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'));
    if (r && typeof r.version === 'string' && typeof r.pkg_url === 'string' && info && info.size === r.file_size) {
      return {
        version: r.version, pkg_url: r.pkg_url, file_size: r.file_size, changelog: String(r.changelog || ''),
        updated_at: r.updated_at || info.updated_at, history: Array.isArray(r.history) ? r.history : [],
      };
    }
  } catch (_) {  }
  if (!info || !info.version) return null;
  const log = readClientChangelog();
  if (info.version && !log.some((e) => e.version === info.version)) {
    log.unshift({ version: info.version, date: String(info.updated_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10), notes: '' });
    try { fs.writeFileSync(CLIENT_CHANGELOG_FILE, JSON.stringify(log, null, 2) + '\n'); } catch (_) {  }
  }
  const entry = log.find((e) => e.version === info.version) || log[0] || null;
  return {
    version: info.version, pkg_url: '/store/PS4Store.pkg', file_size: info.size, changelog: entry ? entry.notes : '',
    updated_at: info.updated_at,
    history: log.filter((e) => e.version !== info.version).map((e) => ({ version: e.version, pkg_url: '', file_size: 0, changelog: e.notes, updated_at: e.date })),
  };
}
function releaseView() {
  const r = currentRelease();
  if (!r) return null;
  return {
    ...r,
    version_display: displayClientVersion(r.version),
    size_label: fmtBytes(r.file_size),
    history: r.history.map((h) => ({ ...h, version_display: displayClientVersion(h.version), size_label: fmtBytes(h.file_size) })),
  };
}

const LANGS = ['fr', 'en', 'es'];
const LANG_NAMES = { fr: 'Français', en: 'English', es: 'Español' };
const DATE_LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES' };
const LOCALE_DIRS = [path.join(__dirname, '..', 'locales'), path.join(__dirname, 'locales')];
const dictionaries = {};

function loadLocales() {
  for (const lang of LANGS) {
    dictionaries[lang] = {};
    for (const dir of LOCALE_DIRS) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { dictionaries[lang] = parsed; break; }
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[PS4Store] ${lang}.json illisible (${dir}) :`, err.message);
      }
    }
  }
  if (!Object.keys(dictionaries.fr).length) console.warn('[PS4Store] locales/fr.json introuvable : les textes du site seront remplacés par leurs clés.');
}
loadLocales();

const interpolate = (str, vars) => (vars ? str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : str);
function translate(lang, key, vars) {
  let str = (dictionaries[lang] || {})[key];
  if (str === undefined) str = (dictionaries.fr || {})[key];
  if (str === undefined) str = key;
  return interpolate(str, vars);
}
function translatePlural(lang, key, n, vars) {
  const one = lang === 'fr' ? n < 2 : n === 1;
  return translate(lang, `${key}_${one ? 'one' : 'other'}`, { n, ...(vars || {}) });
}
function negotiateLang(header) {
  const wanted = String(header || '').split(',').map((part) => {
    const [tag, q] = part.trim().split(';q=');
    return { base: String(tag || '').toLowerCase().split('-')[0], q: q ? Number(q) : 1 };
  }).filter((w) => w.base).sort((a, b) => b.q - a.q);
  const hit = wanted.find((w) => LANGS.includes(w.base));
  return hit ? hit.base : 'fr';
}
function readCookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '');
  try { return m ? decodeURIComponent(m[1]) : ''; } catch (_) { return ''; }
}
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function formatDate(lang, iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(DATE_LOCALES[lang] || 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const safeNext = (value) => (typeof value === 'string' && /^\/(?!\/)[^\\\r\n]*$/.test(value) ? value : '/');

loadData();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.initials = initials;
app.locals.assetV = (file) => { try { return Math.round(fs.statSync(path.join(__dirname, 'public', file)).mtimeMs); } catch (_) { return 0; } };

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
const jsonSmall = express.json({ limit: '16kb' });
const jsonBig = express.json({ limit: '512kb' });
app.use((req, res, next) => (req.path === '/api/me/heartbeat' || req.path.startsWith('/dashboard/homepage') ? next() : jsonSmall(req, res, next)));
app.use(cookieSession({
  name: 'ps4store.sid',
  keys: [loadSessionSecret()],
  maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '5m' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use((req, res, next) => {
  let lang = readCookie(req, 'lang');
  if (!LANGS.includes(lang)) lang = negotiateLang(req.headers['accept-language']);
  req.lang = lang;
  Object.assign(res.locals, {
    lang,
    LANGS,
    langNames: LANG_NAMES,
    currentPath: safeNext(req.originalUrl),
    t: (key, vars) => translate(lang, key, vars),
    tn: (key, n, vars) => translatePlural(lang, key, n, vars),
    tPrefix: (prefix) => { const o = {}; Object.keys(dictionaries.fr || {}).filter((k) => k.startsWith(prefix)).forEach((k) => { o[k] = translate(lang, k); }); return o; },
    fmtDate: (iso) => formatDate(lang, iso),
    catLabel: (c) => { const k = `cat.${c}`; const v = translate(lang, k); return v === k ? c : v; },
    escapeHtml,
    resourceTypes: RESOURCE_TYPES,
  });
  next();
});

app.get('/lang/:code', (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  if (LANGS.includes(code)) res.cookie('lang', code, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', path: '/' });
  res.redirect(safeNext(req.query.next));
});

function notFound(res, titleKey, backHref, backKey) {
  res.status(404).render('notfound', { titleKey, backHref, backKey });
}

app.use((req, res, next) => { req.admin = null; next(); });

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  if (req.get('X-CSRF-Token') !== undefined || req.is('application/json')) {
    return res.status(401).json({ erreur: 'Session expirée. Reconnectez-vous.' });
  }
  res.redirect('/dashboard');
}
function requireSuper(req, res, next) {
  if (req.admin && req.admin.role === 'superadmin') return next();
  setFlash(req, 'error', 'Action réservée au super-administrateur.');
  res.redirect('/dashboard');
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function requireCsrf(req, res, next) {
  const sent = (req.body && typeof req.body._csrf === 'string' && req.body._csrf) || req.get('X-CSRF-Token') || '';
  if (req.session.csrf && sent && safeEqual(sent, req.session.csrf)) return next();
  if (req.is('application/json')) return res.status(403).json({ erreur: 'Jeton de sécurité invalide. Rechargez la page.' });
  res.status(403).send('Requête refusée (jeton de sécurité invalide). Rechargez la page.');
}

function setFlash(req, type, message, extra) {
  req.session.flash = Object.assign({ type, message }, extra || {});
}
function takeFlash(req) {
  const flash = req.session.flash || null;
  if (flash) delete req.session.flash;
  return flash;
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAX_REMOTE_QUEUE = 60;
const strList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string'))] : []);

function normalizeUser(u) {
  return {
    id: String(u.id),
    username: String(u.username || ''),
    created_at: String(u.created_at || new Date().toISOString()),
    likes: strList(u.likes),
    library: strList(u.library),
    role: u.role === 'admin' || u.role === 'superadmin' ? u.role : 'user',
    display_name: String(u.display_name || '').slice(0, 60),
    bio: String(u.bio || '').slice(0, 280),
    socials: (Array.isArray(u.socials) ? u.socials : []).filter((x) => x && isHttpUrl(String(x.url || ''))).slice(0, 6).map((x) => ({ label: String(x.label || '').slice(0, 30), url: String(x.url).slice(0, 300) })),
    avatar_url: typeof u.avatar_url === 'string' && (isHttpUrl(u.avatar_url) || u.avatar_url.startsWith('/')) ? u.avatar_url.slice(0, 500) : '',
    public_library: u.public_library === true,
    public_activity: u.public_activity === true,
    following: strList(u.following), followers: strList(u.followers),
    discord_tag: String(u.discord_tag || '').slice(0, 40),
    avatar_source: u.avatar_source === 'upload' || u.avatar_source === 'discord' ? u.avatar_source : '',
    avatar_at: Number(u.avatar_at) || 0,
    discord_id: String(u.discord_id || ''), discord_username: String(u.discord_username || '').slice(0, 64), discord_avatar: String(u.discord_avatar || '').slice(0, 64),
    rpc_token: /^[0-9a-f]{48}$/.test(String(u.rpc_token || '')) ? u.rpc_token : '',
    remote_commands: (Array.isArray(u.remote_commands) ? u.remote_commands : []).filter((c) => c && c.command_id && /^[A-Z]{4}\d{5}$/.test(String(c.title_id || ''))).map((c) => ({
      command_id: String(c.command_id), console_id: String(c.console_id || ''), action: c.action === 'uninstall' ? 'uninstall' : 'launch', title_id: String(c.title_id),
      name: String(c.name || '').slice(0, 80), status: c.status === 'sent' ? 'sent' : 'pending', created_at: String(c.created_at || ''),
    })),
    paired_consoles: (Array.isArray(u.paired_consoles) ? u.paired_consoles : []).filter((c) => c && typeof c.device_token === 'string').map((c) => ({
      id: String(c.id || crypto.randomUUID()), device_token: c.device_token, name: String(c.name || 'PS4').slice(0, 40),
      linked_at: String(c.linked_at || ''), last_seen: String(c.last_seen || ''),
    })),
    remote_queue: (Array.isArray(u.remote_queue) ? u.remote_queue : []).filter((q) => q && q.queue_id && q.game_id).map((q) => ({
      queue_id: String(q.queue_id), game_id: String(q.game_id), status: q.status === 'sent' ? 'sent' : 'pending',
      created_at: String(q.created_at || ''), ...(q.sent_at ? { sent_at: String(q.sent_at) } : {}),
    })),
  };
}
function loadUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((u) => u && u.id && u.username && /^\d{5,25}$/.test(String(u.discord_id || ''))).map(normalizeUser) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[PS4Store] users.json illisible :', err.message);
    return [];
  }
}
let users = loadUsers();

function saveUsers() {
  const limit = Date.now() - 7 * 86400000;
  users.forEach((u) => { u.remote_queue = u.remote_queue.filter((q) => q.status === 'pending' || !q.sent_at || Date.parse(q.sent_at) > limit).slice(-MAX_REMOTE_QUEUE); });
  writeJsonAtomic(USERS_FILE, users);
}

const avatarUrl = (u) => (u.avatar_at ? `/uploads/avatars/${u.id}.png?v=${u.avatar_at}` : (u.avatar_url || ''));
const AVATAR_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (_) {  }
function ensureRpcToken(user) {
  if (!user.rpc_token) { user.rpc_token = crypto.randomBytes(24).toString('hex'); saveUsers(); }
  return user.rpc_token;
}

function ensureSuperadmin() {
  let changed = false;
  for (const u of users) if (!['user', 'admin', 'superadmin'].includes(u.role)) { u.role = 'user'; changed = true; }
  const ownerDiscord = String(process.env.ADMIN_DISCORD_ID || '').trim();
  if (ownerDiscord) {
    for (const u of users) if (u.discord_id === ownerDiscord && u.role !== 'superadmin') { u.role = 'superadmin'; changed = true; console.log(`[PS4Store] « ${u.username} » est super-administrateur (ADMIN_DISCORD_ID).`); }
  }
  if (users.length && !users.some((u) => u.role === 'superadmin')) {
    const first = users.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    const owner = first;
    owner.role = 'superadmin'; changed = true;
    console.log(`[PS4Store] aucun super-administrateur : « ${owner.username} » est promu.`);
  }
  if (changed) saveUsers();
}
ensureSuperadmin();
function repairGameAuthors() {
  const owner = users.find((u) => u.role === 'superadmin');
  if (!owner) return;
  let changed = false;
  games.forEach((g) => {
    if (users.some((u) => u.id === g.author_id)) return;
    Object.assign(g, { author_id: owner.id, author_name: owner.display_name || owner.username, author_username: owner.username });
    changed = true;
  });
  if (changed) gamesStore.save(games).catch((e) => console.error('[PS4Store] réattribution des auteurs :', e));
}
repairGameAuthors();

app.use((req, res, next) => {
  req.user = null;
  if (req.session && req.session.userId) {
    req.user = users.find((u) => u.id === req.session.userId) || null;
    if (!req.user) req.session.userId = null;
  }
  let counts = null;
  Object.assign(res.locals, {
    me: req.user ? { username: req.user.username, role: req.user.role, roleKey: roleKeyOf(req.user), hasConsole: req.user.paired_consoles.length > 0, avatar: avatarUrl(req.user) } : null,
    csrfFor: () => csrfToken(req),
    likeCount: (id) => {
      if (!counts) { counts = new Map(); users.forEach((u) => u.likes.forEach((g) => counts.set(g, (counts.get(g) || 0) + 1))); }
      return counts.get(id) || 0;
    },
    isLiked: (id) => !!req.user && req.user.likes.includes(id),
    inLibrary: (id) => !!req.user && req.user.library.includes(id),
  });
  next();
});

app.use((req, res, next) => {
  req.admin = req.user && (req.user.role === 'admin' || req.user.role === 'superadmin') ? req.user : null;
  next();
});

const widgetCache = new Map();
function discordWidget(id) {
  const hit = widgetCache.get(id);
  if (!hit || Date.now() - hit.at > 5 * 60 * 1000) {
    widgetCache.set(id, { at: Date.now(), data: hit ? hit.data : null });
    fetch(`https://discord.com/api/guilds/${id}/widget.json`, { signal: AbortSignal.timeout(6000) })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) widgetCache.set(id, { at: Date.now(), data: d }); }).catch(() => {});
  }
  return (widgetCache.get(id) || {}).data || null;
}
const MK0 = '\uE000', MK1 = '\uE001', MK2 = '\uE002';
const mkDigits = (n) => String(n).replace(/\d/g, (d) => String.fromCharCode(0xE010 + Number(d)));
function applyMarkers(html, table, edit) {
  if (html.indexOf(MK0) === -1) return html;
  const RAW = new Set(['script', 'style', 'title', 'textarea', 'option']);
  const MARK = /\uE000([\uE010-\uE019]+)\uE001([\s\S]*?)\uE002/g;
  const strip = (v) => v.replace(MARK, (m, d, inner) => inner);
  let raw = '';
  const out = html.replace(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g, (tok, close, name) => {
    if (name) {
      const n = name.toLowerCase();
      if (raw) { if (close && n === raw) raw = ''; return strip(tok); }
      if (!close && RAW.has(n) && !/\/>$/.test(tok)) raw = n;
      return strip(tok);
    }
    if (tok.charAt(0) === '<') return strip(tok);
    if (raw) return strip(tok);
    return tok.replace(MARK, (m, d, inner) => {
      const e = table[parseInt(d.replace(/[\uE010-\uE019]/g, (c) => String(c.charCodeAt(0) - 0xE010)), 10)];
      if (!e) return inner;
      if (edit) return `<span data-edit-key="${e.key}">${e.html != null ? e.html : inner}</span>`;
      return e.html != null ? e.html : inner;
    });
  });
  return out.replace(/[\uE000-\uE0FF]/g, '');
}
app.use((req, res, next) => {
  const draft = req.query.preview === '1' && req.admin ? homepageDrafts.get(req.admin.id) : null;
  const hp = draft ? draft.hp : homepage;
  const lang = res.locals.lang;
  res.locals.siteTheme = hp.site_theme;
  res.locals.editMode = !!draft && req.query.edit === '1';
  res.locals.vitrineOf = (which) => vitrineView(hp, which);
  const hiddenSet = new Set(hp.hidden_elements || []);
  res.locals.isHidden = (id) => hiddenSet.has(id);
  res.locals.tg = (id) => (res.locals.editMode ? ` data-toggleable="${id}"` : '');
  const ov = hp.text_overrides || {}, edit = res.locals.editMode;
  if (req.path.startsWith('/dashboard') || req.path.startsWith('/api/')) return next();
  if (!edit && !Object.keys(ov).length) return next();
  const table = [];
  const baseT = res.locals.t;
  res.locals.t = (key, vars) => {
    const has = Object.prototype.hasOwnProperty.call(ov, key);
    const def = ((dictionaries[lang] || {})[key] !== undefined ? dictionaries[lang][key] : (dictionaries.fr || {})[key]);
    if (!has && !(edit && typeof def === 'string' && !/\{\w+\}/.test(def))) return baseT(key, vars);
    const plain = has ? htmlToText(ov[key]) : baseT(key, vars);
    table.push({ key, html: has ? ov[key] : null });
    return `${MK0}${mkDigits(table.length - 1)}${MK1}${plain}${MK2}`;
  };
  const render = res.render.bind(res);
  res.render = (view, options, cb) => {
    if (typeof options === 'function') { cb = options; options = undefined; }
    render(view, options, (err, html) => {
      if (err) return cb ? cb(err) : next(err);
      html = applyMarkers(html, table, edit);
      return cb ? cb(null, html) : res.send(html);
    });
  };
  next();
});

function requireUserApi(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ erreur: 'Connectez-vous pour utiliser cette fonction.' });
}
const LOGIN_ERRORS = { discord: 'auth.err.discord_failed', denied: 'auth.err.discord_denied', config: 'auth.err.discord_off' };
app.get('/login', (req, res) => {
  const next = safeNext(req.query.next || '/');
  if (req.user) return res.redirect(next);
  res.render('login', { error: LOGIN_ERRORS[String(req.query.error || '')] || '', next, discordEnabled: discordConfigured() });
});
app.get('/register', (req, res) => res.redirect(302, '/login'));

app.post('/logout', requireCsrf, (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.get('/mon-compte', (req, res) => {
  if (!req.user) return res.redirect('/login?next=%2Fmon-compte');
  const origin = `${req.protocol}://${req.get('host')}`;
  const byId = (id) => games.find((g) => g.id === id);
  const queue = req.user.remote_queue.slice().reverse().map((q) => ({ ...q, game: byId(q.game_id) ? publicGame(byId(q.game_id)) : null }));
  res.render('account', {
    user: { username: req.user.username, discord: req.user.discord_username, created_at: req.user.created_at, role: req.user.role, badges: badgesOf(req.user) },
    consoles: req.user.paired_consoles.map((c) => ({ id: c.id, name: c.name, linked_at: c.linked_at, last_seen: c.last_seen })),
    library: req.user.library.map(byId).filter(Boolean).map(publicGameCard),
    liked: req.user.likes.map(byId).filter(Boolean).map(publicGameCard),
    queue, origin, csrf: csrfToken(req),
    submissions: submissions.filter((x) => x.submitted_by === req.user.id).slice().reverse().map((x) => ({
      id: x.id, status: x.status, reason: x.reject_reason || '', created_at: x.created_at, titre: x.game.titre, version: x.game.version, type: x.game.resource_type || 'pkg', game_id: x.game_id || '',
    })),
    profileForm: (() => {
      const pick = (label) => { const x = req.user.socials.find((y) => y.label === label); return x ? x.url : ''; };
      return { display_name: req.user.display_name, bio: req.user.bio, discord_tag: req.user.discord_tag || req.user.discord_username || '', youtube: pick('YouTube'), github: pick('GitHub'), twitter: pick('X / Twitter'), public_library: req.user.public_library, public_activity: req.user.public_activity };
    })(),
    profileFlash: String(req.query.profile || ''),
    profile: {
      avatar: avatarUrl(req.user), discord: req.user.discord_id ? { id: req.user.discord_id, username: req.user.discord_username, avatar: !!req.user.discord_avatar } : null,
      discordEnabled: discordConfigured(), rpcToken: ensureRpcToken(req.user), flash: String(req.query.discord || ''),
    },
    libraryList: req.user.library.map(byId).filter(Boolean).map((g) => ({ id: g.id, titre: g.titre, title_id: g.title_id, type: g.resource_type || 'pkg' })),
  });
});
app.post('/mon-compte/profile', requireCsrf, async (req, res, next) => {
  try {
    if (!req.user) return res.redirect('/login');
    const str = (k) => (typeof req.body[k] === 'string' ? req.body[k].replace(/[\u0000-\u001f]/g, ' ').trim() : '');
    const socials = [];
    let bad = false;
    for (const [field, label] of [['youtube', 'YouTube'], ['github', 'GitHub'], ['twitter', 'X / Twitter']]) {
      const url = str(field);
      if (!url) continue;
      if (!isHttpUrl(url) || url.length > 300) { bad = true; continue; }
      socials.push({ label, url });
    }
    if (bad) return res.redirect('/mon-compte?profile=error#profil');
    Object.assign(req.user, {
      display_name: str('display_name').slice(0, 60), bio: str('bio').slice(0, 280), discord_tag: str('discord_tag').slice(0, 40), socials,
      public_library: req.body.public_library === '1' || req.body.public_library === 'on',
      public_activity: req.body.public_activity === '1' || req.body.public_activity === 'on',
    });
    saveUsers();
    await syncAuthorName(req.user.id, req.user.display_name || req.user.username);
    res.redirect('/mon-compte?profile=ok#profil');
  } catch (err) { next(err); }
});

app.post('/mon-compte/consoles/:id/delete', requireCsrf, (req, res) => {
  if (!req.user) return res.redirect('/login');
  req.user.paired_consoles = req.user.paired_consoles.filter((c) => c.id !== req.params.id);
  saveUsers();
  res.redirect('/mon-compte');
});

app.post('/api/games/:id/like', requireUserApi, requireCsrf, (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) return res.status(404).json({ erreur: 'Jeu introuvable.' });
  const i = req.user.likes.indexOf(game.id);
  if (i === -1) req.user.likes.push(game.id); else req.user.likes.splice(i, 1);
  saveUsers();
  res.json({ liked: i === -1, count: users.filter((u) => u.likes.includes(game.id)).length });
});
app.post('/api/games/:id/library', requireUserApi, requireCsrf, (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) return res.status(404).json({ erreur: 'Jeu introuvable.' });
  const i = req.user.library.indexOf(game.id);
  if (i === -1) req.user.library.push(game.id); else req.user.library.splice(i, 1);
  saveUsers();
  res.json({ in_library: i === -1 });
});
app.post('/api/remote-download/:gameId', requireUserApi, requireCsrf, (req, res) => {
  const game = games.find((g) => g.id === req.params.gameId);
  if (!game) return res.status(404).json({ erreur: 'Jeu introuvable.' });
  if (!req.user.paired_consoles.length) return res.status(409).json({ erreur: "Aucune PS4 n'est liée à votre compte." });
  if (!req.user.remote_queue.some((q) => q.game_id === game.id && q.status === 'pending')) {
    req.user.remote_queue.push({ queue_id: crypto.randomUUID(), game_id: game.id, status: 'pending', created_at: new Date().toISOString() });
    saveUsers();
  }
  res.json({ ok: true });
});

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pairCodes = new Map();
function purgePairCodes() { const now = Date.now(); for (const [c, e] of pairCodes) if (e.expires <= now) pairCodes.delete(c); }
function activePairFor(userId) { purgePairCodes(); for (const [c, e] of pairCodes) if (e.userId === userId) return { code: c, expires: e.expires }; return null; }

app.post('/api/pair/generate', requireUserApi, requireCsrf, (req, res) => {
  purgePairCodes();
  for (const [c, e] of pairCodes) if (e.userId === req.user.id) pairCodes.delete(c);
  let code;
  do { code = Array.from({ length: 6 }, () => PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]).join(''); } while (pairCodes.has(code));
  pairCodes.set(code, { userId: req.user.id, expires: Date.now() + PAIR_TTL_MS });
  res.json({ code: `${code.slice(0, 3)}-${code.slice(3)}`, raw: code, expires_in: PAIR_TTL_MS / 1000 });
});
app.get('/api/pair/status', requireUserApi, (req, res) => {
  const a = activePairFor(req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ consoles: req.user.paired_consoles.length, active: !!a, expires_in: a ? Math.max(0, Math.round((a.expires - Date.now()) / 1000)) : 0 });
});
const pairFails = new Map();
app.post('/api/pair/verify', (req, res) => {
  const now = Date.now();
  const rec = pairFails.get(req.ip);
  if (rec && now - rec.since > 10 * 60000) pairFails.delete(req.ip);
  const cur = pairFails.get(req.ip) || { n: 0, since: now };
  if (cur.n >= 10) return res.status(429).json({ ok: false, erreur: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  const code = String(req.body && req.body.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  purgePairCodes();
  const entry = code.length === 6 ? pairCodes.get(code) : null;
  const owner = entry ? users.find((u) => u.id === entry.userId) : null;
  if (!entry || !owner) {
    cur.n += 1; pairFails.set(req.ip, cur);
    return res.status(400).json({ ok: false, erreur: 'Code invalide ou expiré.' });
  }
  pairCodes.delete(code);
  const name = String(req.body.console_name || 'PS4').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'PS4';
  const nowIso = new Date().toISOString();
  const consoleEntry = { id: crypto.randomUUID(), device_token: crypto.randomBytes(32).toString('hex'), name, linked_at: nowIso, last_seen: nowIso };
  owner.paired_consoles.push(consoleEntry);
  saveUsers();
  res.json({ ok: true, device_token: consoleEntry.device_token, username: owner.username });
});


function readBodyLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => { total += c.length; if (total > limit) { reject(Object.assign(new Error('trop volumineux'), { code: 'TOO_BIG' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function validPng(buf) {
  if (buf.length < 33 || buf.length > 700 * 1024 || buf.readUInt32BE(0) !== 0x89504E47 || buf.readUInt32BE(4) !== 0x0D0A1A0A || buf.toString('ascii', 12, 16) !== 'IHDR') return false;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w >= 32 && h >= 32 && w <= 1024 && h <= 1024;
}
function saveAvatar(user, buf, source) {
  writeFileAtomic(path.join(AVATAR_DIR, `${user.id}.png`), buf);
  user.avatar_at = Date.now();
  user.avatar_source = source || 'upload';
  saveUsers();
}
app.post('/mon-compte/avatar', requireUserApi, requireCsrf, async (req, res) => {
  try {
    const buf = await readBodyLimited(req, 700 * 1024);
    if (!validPng(buf)) return res.status(400).json({ erreur: "Image invalide : un PNG de 32 à 1024 px est attendu." });
    saveAvatar(req.user, buf);
    res.json({ ok: true, url: avatarUrl(req.user) });
  } catch (err) {
    res.status(err && err.code === 'TOO_BIG' ? 413 : 400).json({ erreur: 'Image trop volumineuse ou envoi interrompu.' });
  }
});
app.post('/mon-compte/avatar/delete', requireUserApi, requireCsrf, (req, res) => {
  try { fs.unlinkSync(path.join(AVATAR_DIR, `${req.user.id}.png`)); } catch (_) {  }
  req.user.avatar_at = 0;
  saveUsers();
  res.json({ ok: true });
});
app.post('/mon-compte/avatar/discord', requireUserApi, requireCsrf, async (req, res) => {
  const u = req.user;
  if (!u.discord_id || !u.discord_avatar) return res.status(404).json({ erreur: "Aucune photo Discord disponible sur ce compte." });
  if (!/^\d{5,25}$/.test(u.discord_id) || !/^[A-Za-z0-9_]{5,64}$/.test(u.discord_avatar)) return res.status(400).json({ erreur: 'Données Discord invalides.' });
  try {
    const r = await fetch(`https://cdn.discordapp.com/avatars/${u.discord_id}/${u.discord_avatar}.png?size=256`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) return res.status(502).json({ erreur: 'Discord a refusé la requête.' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!validPng(buf)) return res.status(502).json({ erreur: 'Image Discord invalide.' });
    saveAvatar(u, buf, 'discord');
    res.json({ ok: true, url: avatarUrl(u) });
  } catch (_) { res.status(502).json({ erreur: 'Impossible de joindre Discord.' }); }
});

const discordConfigured = () => !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI);
const adminDiscordId = () => String(process.env.ADMIN_DISCORD_ID || '').trim();
const discordLabel = (me) => String(me.global_name || me.username || '').replace(/[\u0000-\u001f]/g, '').slice(0, 64);

function uniqueUsername(base) {
  let b = String(base || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 26);
  if (b.length < 3) b = `${b}membre`.slice(0, 26);
  let name = b, i = 1;
  while (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) name = `${b}${++i}`;
  return name;
}
async function downloadDiscordAvatar(id, hash) {
  if (!/^\d{5,25}$/.test(id) || !/^[A-Za-z0-9_]{5,64}$/.test(hash)) return null;
  try {
    const r = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=256`, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return validPng(buf) ? buf : null;
  } catch (_) { return null; }
}

app.get('/auth/discord', (req, res) => {
  if (!discordConfigured()) return res.redirect(req.user ? '/mon-compte?discord=off' : '/login?error=config');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.discordState = state;
  req.session.discordNext = safeNext(req.query.next || '/');
  const qs = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: process.env.DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify', state, prompt: 'none' });
  res.redirect(`https://discord.com/oauth2/authorize?${qs}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  const expected = req.session.discordState;
  const next = req.session.discordNext || '/';
  req.session.discordState = null;
  req.session.discordNext = null;
  const fail = () => res.redirect(req.user ? '/mon-compte?discord=error' : '/login?error=discord');
  if (typeof req.query.error === 'string') return res.redirect(req.user ? '/mon-compte' : '/login?error=denied');
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!discordConfigured() || !expected || !code || typeof req.query.state !== 'string' || !safeEqual(req.query.state, expected)) return fail();
  try {
    const tok = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': BROWSER_UA },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI }),
    });
    if (!tok.ok) throw new Error(`token ${tok.status}`);
    const { access_token: access } = await tok.json();
    const me = await fetchJson('https://discord.com/api/v10/users/@me', { Authorization: `Bearer ${access}` });
    if (!me || !/^\d{5,25}$/.test(String(me.id))) throw new Error('profil invalide');
    const id = String(me.id), label = discordLabel(me), hash = String(me.avatar || '');
    const ownerId = adminDiscordId();

    let u = users.find((x) => x.discord_id === id);
    if (req.user && u && u.id !== req.user.id) return res.redirect('/mon-compte?discord=taken');
    if (!u && req.user && !req.user.discord_id) u = req.user;
    const created = !u;
    if (!u) {
      u = normalizeUser({ id: crypto.randomUUID(), username: uniqueUsername(me.username || label), created_at: new Date().toISOString(), display_name: label, discord_id: id });
      users.push(u);
    }
    const previousHash = u.discord_avatar;
    Object.assign(u, { discord_id: id, discord_username: label, discord_avatar: hash });
    if (!u.display_name) u.display_name = label;
    ensureRpcToken(u);
    if (ownerId && id === ownerId) u.role = 'superadmin';
    else if (!users.some((x) => x.role === 'superadmin')) u.role = 'superadmin';
    if (hash && u.avatar_source !== 'upload' && (created || !u.avatar_at || previousHash !== hash)) {
      const buf = await downloadDiscordAvatar(id, hash);
      if (buf) saveAvatar(u, buf, 'discord');
    }
    saveUsers();
    req.session.userId = u.id;
    res.redirect(req.user ? '/mon-compte?discord=ok' : safeNext(next));
  } catch (err) {
    console.error('[PS4Store] discord oauth :', err.message);
    fail();
  }
});

const consoleStatus = new Map();
const ONLINE_MS = 45 * 1000;
const PLAYING_MAX_MS = 8 * 3600 * 1000;
const TITLE_RE = /^[A-Z]{4}\d{5}$/;
const short = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, n);

app.post('/api/me/heartbeat', requireDevice, jsonBig, (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const now = Date.now();
  const prev = consoleStatus.get(req.device.id) || {};
  let state = ['store', 'launch', 'away'].includes(b.state) ? b.state : 'store';
  let playing = prev.playing || null;
  if (state === 'store') playing = null;
  const activeId = String(b.active_title_id || '');
  if (TITLE_RE.test(activeId)) {
    if (activeId === APP_TITLE_ID) playing = null;
    else { playing = playing && playing.title_id === activeId ? playing : { title_id: activeId, name: resolveTitleName(activeId), started_at: now }; state = 'launch'; }
  }
  if (state === 'launch' && b.playing && TITLE_RE.test(String(b.playing.title_id || ''))) {
    const tid = String(b.playing.title_id);
    playing = playing && playing.title_id === tid ? playing : { title_id: tid, name: short(b.playing.name, 80), started_at: now };
  }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  const installed = Array.isArray(b.installed) ? b.installed.slice(0, 600).filter((i) => i && TITLE_RE.test(String(i.title_id || ''))).map((i) => ({
    title_id: String(i.title_id), name: short(i.name, 80), version: short(i.version, 16), size: short(i.size, 20), type: short(i.type || 'pkg', 10),
  })) : (prev.installed || []);
  consoleStatus.set(req.device.id, { at: now, state, playing, app_version: short(b.app_version, 16) || prev.app_version || '', disk_free: b.disk_free !== undefined ? num(b.disk_free) : (prev.disk_free || 0), disk_total: b.disk_total !== undefined ? num(b.disk_total) : (prev.disk_total || 0), installed });
  res.json({ ok: true });
});
const APP_TITLE_ID = 'PSTR00001';
function resolveTitleName(tid) {
  const g = games.find((x) => x.title_id === tid && (x.resource_type || 'pkg') === 'pkg') || games.find((x) => x.title_id === tid);
  if (g) return g.titre;
  const k = KNOWN_TITLES.find((x) => x.eu === tid || x.us === tid);
  return k ? k.name : tid;
}
const playingActive = (st) => !!(st && st.playing && Date.now() - st.playing.started_at < PLAYING_MAX_MS);
app.get('/api/me/console-status', requireUserApi, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  res.json({
    consoles: req.user.paired_consoles.map((c) => {
      const st = consoleStatus.get(c.id) || null;
      return {
        id: c.id, name: c.name, linked_at: c.linked_at, last_seen: st ? new Date(st.at).toISOString() : c.last_seen,
        online: !!st && now - st.at < ONLINE_MS, app_version: st ? st.app_version : '', disk_free: st ? st.disk_free : 0, disk_total: st ? st.disk_total : 0,
        installed: st ? st.installed : [], playing: playingActive(st) ? st.playing : null,
      };
    }),
  });
});
app.post('/api/me/remote-command', requireUserApi, requireCsrf, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  const target = b.console_id ? req.user.paired_consoles.find((c) => c.id === String(b.console_id)) : req.user.paired_consoles[0];
  if (!target) return res.status(409).json({ erreur: "Aucune PS4 n'est liée à votre compte." });
  if (action === 'install') {
    const game = games.find((g) => g.id === String(b.game_id || ''));
    if (!game) return res.status(404).json({ erreur: 'Jeu introuvable.' });
    if (!req.user.remote_queue.some((q) => q.game_id === game.id && q.status === 'pending')) {
      req.user.remote_queue.push({ queue_id: crypto.randomUUID(), game_id: game.id, status: 'pending', created_at: new Date().toISOString() });
      saveUsers();
    }
    return res.json({ ok: true });
  }
  if (action !== 'launch' && action !== 'uninstall') return res.status(400).json({ erreur: 'Commande inconnue.' });
  const titleId = String(b.title_id || '').toUpperCase();
  if (!TITLE_RE.test(titleId)) return res.status(400).json({ erreur: 'Title ID invalide.' });
  if (action === 'uninstall' && titleId === 'PSTR00001') return res.status(400).json({ erreur: "PS4Store ne peut pas se désinstaller lui-même à distance." });
  if (!req.user.remote_commands.some((c) => c.status === 'pending' && c.action === action && c.title_id === titleId && c.console_id === target.id)) {
    req.user.remote_commands.push({ command_id: crypto.randomUUID(), console_id: target.id, action, title_id: titleId, name: short(b.name, 80), status: 'pending', created_at: new Date().toISOString() });
    req.user.remote_commands = req.user.remote_commands.slice(-MAX_REMOTE_QUEUE);
    saveUsers();
  }
  res.json({ ok: true });
});
app.post('/api/me/commands/:commandId/ack', requireDevice, (req, res) => {
  const c = req.deviceUser.remote_commands.find((x) => x.command_id === req.params.commandId);
  if (!c) return res.status(404).json({ ok: false, erreur: 'Commande introuvable.' });
  c.status = 'sent';
  saveUsers();
  res.json({ ok: true });
});

app.get('/api/rpc/:rpcToken', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const tok = String(req.params.rpcToken || '');
  const user = /^[0-9a-f]{48}$/.test(tok) ? users.find((u) => u.rpc_token && safeEqual(u.rpc_token, tok)) : null;
  if (!user) return res.status(404).json({ erreur: 'Jeton inconnu.' });
  const now = Date.now();
  let online = false, act = null;
  for (const c of user.paired_consoles) {
    const st = consoleStatus.get(c.id);
    if (!st) continue;
    if (now - st.at < ONLINE_MS) online = true;
    if (playingActive(st)) act = st.playing;
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  const game = act ? games.find((g) => (g.resource_type || 'pkg') === 'pkg' && g.title_id === act.title_id) : null;
  res.json({
    online: online || !!act,
    game_title: act ? (game ? game.titre : resolveTitleName(act.title_id) || act.name) : '',
    title_id: act ? act.title_id : '',
    cover_url: game ? (game.icon_url.startsWith('/') ? origin + game.icon_url : game.icon_url) : '',
    started_at: act ? Math.floor(act.started_at / 1000) : 0,
  });
});

let lastDeviceSave = 0;
function requireDevice(req, res, next) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.get('Authorization') || '');
  if (m) {
    for (const u of users) {
      const c = u.paired_consoles.find((x) => safeEqual(x.device_token, m[1].toLowerCase()));
      if (c) {
        req.deviceUser = u; req.device = c;
        c.last_seen = new Date().toISOString();
        if (Date.now() - lastDeviceSave > 60000) { lastDeviceSave = Date.now(); saveUsers(); }
        return next();
      }
    }
  }
  res.status(401).json({ erreur: 'Console non liée ou jeton révoqué.' });
}
app.get('/api/me/sync', requireDevice, (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const u = req.deviceUser;
  const pending = u.remote_queue.filter((q) => q.status === 'pending').map((q) => {
    const g = games.find((x) => x.id === q.game_id);
    return g ? { ...apiGame(g, origin), queue_id: q.queue_id, game_id: q.game_id, status: q.status, created_at: q.created_at } : null;
  }).filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  const commands = u.remote_commands.filter((c) => c.status === 'pending' && (!c.console_id || c.console_id === req.device.id))
    .map((c) => ({ command_id: c.command_id, action: c.action, title_id: c.title_id, name: c.name }));
  res.json({ username: u.username, library: u.library, likes: u.likes, pending, commands });
});
app.post('/api/me/remote-queue/:queueId/ack', requireDevice, (req, res) => {
  const q = req.deviceUser.remote_queue.find((x) => x.queue_id === req.params.queueId);
  if (!q) return res.status(404).json({ ok: false, erreur: 'Demande introuvable.' });
  if (q.status !== 'sent') {
    q.status = 'sent'; q.sent_at = new Date().toISOString(); saveUsers();
    const sentGame = games.find((x) => x.id === q.game_id);
    if (sentGame) { sentGame.downloads_count = (sentGame.downloads_count || 0) + 1; scheduleGamesSave(); }
  }
  res.json({ ok: true });
});
app.post('/api/me/unlink', requireDevice, (req, res) => {
  req.deviceUser.paired_consoles = req.deviceUser.paired_consoles.filter((c) => c.id !== req.device.id);
  saveUsers();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  const sorted = [...games].sort(byNewest);
  const latest = sorted.slice(0, 8).map(publicGameCard);
  const contributors = new Set(games.map((g) => g.author_id || g.author_name)).size;
  const client = clientInfo();
  const draft = req.query.preview === '1' && req.admin ? homepageDrafts.get(req.admin.id) : null;
  res.render('index', {
    latest, collections: featuredCollections(), discordInvite: /^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(String(process.env.DISCORD_INVITE_URL || '')) ? String(process.env.DISCORD_INVITE_URL) : '',
    vitrine: vitrineView(draft ? draft.hp : homepage, 'sections'), isPreview: !!draft, isEdit: !!draft && req.query.edit === '1',
    stats: { total: games.length, version: displayClientVersion(client && client.version) || APP_VERSION, contributors },
    storePkg: storePackageInfo(),
    release: releaseView(),
  });
});

app.get('/catalogue', (req, res) => {
  res.render('catalogue', {
    games: [...games].sort(byNewest).map(publicGameCard),
    firmwares: FIRMWARES,
    categories: CATEGORIES,
    collections: featuredCollections(),
    vitrine: vitrineView(req.query.preview === '1' && req.admin && homepageDrafts.get(req.admin.id) ? homepageDrafts.get(req.admin.id).hp : homepage, 'catalogue_sections'),
    isPreview: req.query.preview === '1' && !!req.admin && homepageDrafts.has(req.admin.id), isEdit: req.query.preview === '1' && req.query.edit === '1' && !!req.admin && homepageDrafts.has(req.admin.id),
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '',
    initial: ['fw', 'cat', 'type', 'sort', 'collection'].reduce((o, k) => { o[k] = typeof req.query[k] === 'string' ? req.query[k].slice(0, 60) : ''; return o; }, {}),
  });
});

app.get('/jeu/:id', (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) return notFound(res, 'notfound.game', '/catalogue', 'notfound.back.catalogue');
  const ytId = game.youtube_url ? extractYoutubeId(game.youtube_url) : null;
  const typeOrder = { update: 0, dlc: 1, plugin: 2, payload: 3 };
  const related = (game.resource_type || 'pkg') === 'pkg'
    ? games.filter((g) => g.id !== game.id && g.parent_title_id && g.parent_title_id === game.title_id)
      .sort((a, b) => (typeOrder[a.resource_type] - typeOrder[b.resource_type]) || String(b.updated_at).localeCompare(String(a.updated_at))).map(publicGame)
    : [];
  const parent = game.parent_title_id ? games.find((g) => (g.resource_type || 'pkg') === 'pkg' && g.title_id === game.parent_title_id) : null;
  const downloadUrl = game.pkg_url ? consolePkgUrl(game, `${req.protocol}://${req.get('host')}`) : '';
  res.render('game', {
    game: publicGame(game), ytId, downloadUrl, author: authorOf(game), related, parent: parent ? publicGame(parent) : null,
    changelog: sanitizeChangelog(game.changelog),
    community: communityView(game, req),
  });
});

app.get('/createur/:username', (req, res) => res.redirect(301, `/membre/${encodeURIComponent(String(req.params.username || ''))}`));

app.get('/membre/:username', (req, res) => {
  const uname = String(req.params.username || '').toLowerCase();
  const member = users.find((x) => x.username.toLowerCase() === uname);
  if (!member) return notFound(res, 'notfound.creator', '/catalogue', 'notfound.back.catalogue');
  const account = accountById(member.id);
  const isSelf = !!(member && req.user && req.user.id === member.id);
  const byId = (id) => games.find((g) => g.id === id);
  const resources = games.filter((g) => g.author_id === account.id).sort(byNewest).map(publicGameCard);
  const favorites = member ? member.likes.map(byId).filter(Boolean).map(publicGameCard) : [];
  const libraryShown = !!member && (member.public_library || isSelf);
  const library = libraryShown ? member.library.map(byId).filter(Boolean).map(publicGameCard) : [];
  const byType = {};
  RESOURCE_TYPES.forEach((t) => { byType[t] = resources.filter((g) => (g.resource_type || 'pkg') === t).length; });
  let common = [];
  if (req.user && !isSelf && member.public_library) {
    common = req.user.library.filter((id) => member.library.includes(id)).map(byId).filter(Boolean).map((g) => ({ id: g.id, titre: g.titre }));
  }
  const playing = member.public_activity || isSelf ? activeGameOf(member) : null;
  res.render('member', {
    profile: { ...account, discord_tag: member ? (member.discord_tag || '') : '' },
    isSelf, resources, favorites, library, libraryShown, libraryPublic: !!(member && member.public_library), byType,
    stats: { resources: resources.length, likes: favorites.length, library: libraryShown ? library.length : null, followers: member.followers.length, following: member.following.length },
    badges: badgesOf(member), activity: activityOf(member), common, playing, memberRole: member.role,
    memberId: member.id, canFollow: !!req.user && !isSelf, isFollowing: !!req.user && req.user.following.includes(member.id),
  });
});

app.get(['/api/client-version', '/api/client/latest'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = currentRelease();
  if (!r) return res.status(404).json({ erreur: "PS4Store.pkg est absent de ce serveur ou sa version est illisible." });
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    version: r.version,
    pkg_url: `${origin}${r.pkg_url}`,
    pkg_path: r.pkg_url,
    file_size: r.file_size,
    size: r.file_size,
    changelog: r.changelog,
    notes: r.changelog,
    updated_at: r.updated_at,
    history: r.history.map((h) => ({ version: h.version, pkg_url: h.pkg_url ? `${origin}${h.pkg_url}` : '', file_size: h.file_size, changelog: h.changelog, updated_at: h.updated_at })),
  });
});

app.get('/api/games', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  res.json(games.map((g) => apiGame(g, origin)));
});

function apiGame(g, origin) {
  const log = sanitizeChangelog(g.changelog);
  return {
    id: g.id,
    title_id: g.title_id,
    titre: g.titre,
    description: g.description,
    version: g.version,
    firmware_min: g.firmware_min,
    categorie: g.categorie,
    icon_url: g.icon_url.startsWith('/') ? origin + g.icon_url : g.icon_url,
    pkg_url: consolePkgUrl(g, origin),
    size: g.size,
    author_name: g.author_name,
    resource_type: g.resource_type || 'pkg',
    parent_title_id: g.parent_title_id || '',
    author_username: g.author_username || '',
    updated_at: g.updated_at || g.created_at,
    changelog_latest: log.length ? `${log[0].version} — ${log[0].notes}` : '',
    youtube_url: g.youtube_url || '',
    screenshots: (Array.isArray(g.screenshots) ? g.screenshots : []).map((u) => (u.startsWith('/') ? origin + u : u)),
    ...flatPluginFields(g),
    plugin_config: g.plugin_config || defaultPluginConfig(),
    featured_rank: (featuredMap().get(g.id) || {}).rank || 0,
    featured_label: (featuredMap().get(g.id) || {}).label || '',
    likes: likeTotal(g.id),
    downloads_count: g.downloads_count || 0,
    fw_reliability: fwReliability(g),
    changelog: log,
  };
}

app.get('/dl/:id/:file', async (req, res) => {
  const game = games.find((g) => g.id === req.params.id);
  if (!game) return res.status(404).type('text/plain').send('Introuvable');
  const isHead = req.method === 'HEAD';
  const range = isHead ? null : parseRange(req.headers.range);
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  const cancelBody = (r) => { if (r && r.body) r.body.cancel().catch(() => {}); };

  const open = async (fresh) => {
    const target = await getTarget(game.pkg_url, fresh);
    return openUpstream(target, { range: isHead ? 'bytes=0-0' : (range ? range.raw : null), signal: ctrl.signal });
  };

  try {
    let opened = await open(false);
    if ([401, 403, 404, 410].includes(opened.res.status)) {
      cancelBody(opened.res);
      opened = await open(true);
    }
    const up = opened.res;
    const common = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${game.title_id}${resourceExt(game)}"`,
    };

    if (up.status === 416) {
      cancelBody(up);
      return res.status(416).set({ ...common, 'Content-Range': up.headers.get('content-range') || 'bytes */0' }).end();
    }
    if (up.status !== 200 && up.status !== 206) {
      cancelBody(up);
      throw new LinkError(`L'hébergeur a répondu HTTP ${up.status}.`, 502);
    }

    if (!isHead && (!range || range.start === 0)) countDownload(game, req.ip);

    if (isHead) {
      const total = totalFromResponse(up);
      cancelBody(up);
      res.status(200).set(common);
      if (total) res.set('Content-Length', String(total));
      return res.end();
    }

    let status = 200; let length = null; let stream;
    if (up.status === 206) {
      status = 206;
      res.set('Content-Range', up.headers.get('content-range') || '');
      length = Number(up.headers.get('content-length')) || null;
      stream = Readable.fromWeb(up.body);
    } else {
      const total = totalFromResponse(up);
      if (range && total) {
        let start; let end;
        if (range.suffix !== null) { start = Math.max(0, total - range.suffix); end = total - 1; }
        else { start = range.start; end = range.end === null ? total - 1 : Math.min(range.end, total - 1); }
        if (start >= total || start > end) {
          cancelBody(up);
          return res.status(416).set({ ...common, 'Content-Range': `bytes */${total}` }).end();
        }
        status = 206;
        res.set('Content-Range', `bytes ${start}-${end}/${total}`);
        length = end - start + 1;
        stream = Readable.from(sliceBody(up.body, start, length));
      } else {
        length = total;
        stream = Readable.fromWeb(up.body);
      }
    }
    res.status(status).set(common);
    if (length) res.set('Content-Length', String(length));
    pipeline(stream, res, () => ctrl.abort());
  } catch (err) {
    if (ctrl.signal.aborted) return;
    if (res.headersSent) return res.destroy();
    const message = err instanceof LinkError ? err.message : 'Erreur interne du relais.';
    if (!(err instanceof LinkError)) console.error('[PS4Store] Relais /dl :', err);
    res.status(502).type('text/plain').send(message);
  }
});

app.get('/dashboard', (req, res) => {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent('/dashboard')}`);
  if (!req.admin) return res.status(403).render('notfound', { titleKey: 'dash.forbidden', textKey: 'dash.forbidden.text', backHref: '/', backKey: 'notfound.back.home' });
  const admin = req.admin;
  res.setHeader('Cache-Control', 'no-store');
  const dsc = discordSettings();
  res.render('dashboard', {
    release: releaseView(),
    discord: { configured: !!dsc.url, fromEnv: dsc.fromEnv, role: dsc.role, site: readSettings().site_url || '' },
    authed: !!admin,
    admin: admin ? adminView(admin) : null,
    games: admin ? [...games].sort(byNewest).map(({ comments, firmware_votes, ...g }) => ({ ...g, comments_count: (comments || []).length, reports_count: (g.broken_reports || []).length, canEdit: canManage(admin, g) })) : [],
    collections: admin ? collections : [],
    homepage: admin ? homepage : null,
    creatorChoices: admin ? users.map((u) => ({ username: u.username, name: u.display_name || u.username })).sort((a, b) => a.name.localeCompare(b.name)) : [],
    requestsOpen: admin ? requests.filter((r) => r.status === 'open').sort((a, b) => b.votes.length - a.votes.length).map((r) => requestView(r, '')) : [],
    gameChoices: admin ? [...games].sort((a, b) => a.titre.localeCompare(b.titre)).map((g) => ({ id: g.id, titre: g.titre, title_id: g.title_id, resource_type: g.resource_type || 'pkg', desc: String(g.description || '').slice(0, 200), img: (Array.isArray(g.screenshots) && g.screenshots[0]) || g.icon_url || '' })) : [],
    linkRun: lastLinkRun, linkRunning: linkCheckRunning,
    firmwares: FIRMWARES,
    categories: CATEGORIES,
    parentOptions: games.filter((g) => (g.resource_type || 'pkg') === 'pkg').map((g) => ({ title_id: g.title_id, titre: g.titre })),
    csrf: csrfToken(req),
    flash: takeFlash(req),
    pending: admin ? submissions.filter((x) => x.status === 'pending').slice().reverse().map((x) => ({
      id: x.id, created_at: x.created_at, by: x.submitted_by_name, game: x.game,
    })) : [],
    members: admin && admin.role === 'superadmin' ? users.slice().sort((a, b) => ['superadmin', 'admin', 'user'].indexOf(a.role) - ['superadmin', 'admin', 'user'].indexOf(b.role) || a.username.localeCompare(b.username)).map((u) => ({ id: u.id, username: u.username, discord: u.discord_username, avatar: avatarUrl(u), role: u.role, self: req.user.id === u.id, created_at: u.created_at })) : [],
  });
});

app.post('/dashboard/games', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const { value, errors } = validateGame(req.body);
    const log = withChangelogEntry([], req.body, value.version);
    errors.push(...log.errors);
    if (errors.length) {
      setFlash(req, 'error', errors.join(' '), { form: value, editId: '' });
      return res.redirect('/dashboard');
    }
    const now = new Date().toISOString();
    games.push({
      id: crypto.randomUUID(),
      ...value,
      changelog: log.list,
      author_id: req.admin.id,
      author_name: req.admin.display_name || req.admin.username,
      author_username: req.admin.username,
      created_at: now,
      updated_at: now,
    });
    await gamesStore.save(games);
    notifyDiscordGame(games[games.length - 1], originOf(req));
    setFlash(req, 'success', `« ${value.titre} » a été ajouté.`);
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});

app.post('/dashboard/games/:id', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const index = games.findIndex((g) => g.id === req.params.id);
    if (index === -1) {
      setFlash(req, 'error', "Cette fiche n'existe plus.");
      return res.redirect('/dashboard');
    }
    const current = games[index];
    if (!canManage(req.admin, current)) {
      setFlash(req, 'error', 'Vous ne pouvez modifier que vos propres jeux.');
      return res.redirect('/dashboard');
    }
    const { value, errors } = validateGame(req.body, { currentId: current.id });
    const log = withChangelogEntry(current.changelog, req.body, value.version);
    errors.push(...log.errors);
    if (errors.length) {
      setFlash(req, 'error', errors.join(' '), { form: value, editId: req.params.id });
      return res.redirect('/dashboard');
    }
    games[index] = {
      id: current.id, ...value, changelog: log.list,
      author_id: current.author_id, author_name: current.author_name, author_username: current.author_username || '',
      created_at: current.created_at, updated_at: new Date().toISOString(),
      downloads_count: current.downloads_count, firmware_votes: current.firmware_votes, comments: current.comments, ...(current.link_check ? { link_check: current.link_check } : {}),
      broken_reports: value.pkg_url !== current.pkg_url ? [] : (current.broken_reports || []),
    };
    await gamesStore.save(games);
    setFlash(req, 'success', `« ${value.titre} » a été mis à jour.`);
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});

app.post('/dashboard/games/:id/publish-update', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const index = games.findIndex((g) => g.id === req.params.id);
    if (index === -1) { setFlash(req, 'error', "Cette fiche n'existe plus."); return res.redirect('/dashboard'); }
    const current = games[index];
    if (!canManage(req.admin, current)) { setFlash(req, 'error', 'Vous ne pouvez modifier que vos propres jeux.'); return res.redirect('/dashboard'); }
    const str = (k) => (typeof req.body[k] === 'string' ? req.body[k].trim() : '');
    const version = str('version'), pkgUrl = str('pkg_url');
    const notes = str('notes') || `Version ${str('version')}.`;
    const errors = [];
    if (!/^[0-9A-Za-z][0-9A-Za-z.\-_]{0,15}$/.test(version)) errors.push('La nouvelle version est requise (ex. 1.05).');
    if (!isHttpUrl(pkgUrl) || pkgUrl.length > 1000) errors.push('Le lien doit être une adresse http(s) valide.');
    if (notes.length > 600) errors.push('Les notes sont limitées à 600 caractères.');
    const type = current.resource_type || 'pkg';
    const asPatch = type === 'pkg' && (req.body.as_patch === '1' || req.body.as_patch === 'on');
    const now = new Date().toISOString();
    const entry = { version, date: now.slice(0, 10), notes };
    let created = null;
    if (asPatch) {
      created = {
        ...current,
        id: crypto.randomUUID(),
        resource_type: 'update',
        parent_title_id: current.title_id,
        titre: `${current.titre} — ${version}`.slice(0, 80),
        version, pkg_url: pkgUrl, size: 'N/A', force_proxy: false,
        youtube_url: '', screenshots: [], plugin_config: defaultPluginConfig(),
        changelog: [entry], created_at: now, updated_at: now,
        downloads_count: 0, firmware_votes: { '9.00': [], '11.00': [], issue: [] }, comments: [], link_check: undefined, broken_reports: [],
      };
      if (titleConflict(created, '')) errors.push('Cette mise à jour existe déjà (même version).');
    }
    if (errors.length) { setFlash(req, 'error', errors.join(' ')); return res.redirect('/dashboard'); }
    const sizeLabel = await probeSizeLabel(pkgUrl, asPatch ? 'update' : type, current.plugin_config && current.plugin_config.target_type);
    if (created && sizeLabel) created.size = sizeLabel;

    if (created) {
      games.push(created);
      games[index] = { ...current, changelog: [{ ...entry, notes: `[PS4DP] ${notes}`.slice(0, 600) }, ...sanitizeChangelog(current.changelog)].slice(0, MAX_CHANGELOG), updated_at: now };
    } else {
      games[index] = { ...current, broken_reports: [], version, pkg_url: pkgUrl, size: sizeLabel || current.size, changelog: [entry, ...sanitizeChangelog(current.changelog)].slice(0, MAX_CHANGELOG), updated_at: now };
    }
    await gamesStore.save(games);
    notifyDiscordUpdate(games[index], entry, created ? created.size : games[index].size, originOf(req));
    setFlash(req, 'success', `Mise à jour ${version} publiée pour « ${current.titre} ».`);
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});

app.post('/dashboard/games/:id/delete', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const index = games.findIndex((g) => g.id === req.params.id);
    if (index !== -1) {
      if (!canManage(req.admin, games[index])) {
        setFlash(req, 'error', 'Vous ne pouvez supprimer que vos propres jeux.');
        return res.redirect('/dashboard');
      }
      const [removed] = games.splice(index, 1);
      await gamesStore.save(games);
      setFlash(req, 'success', `« ${removed.titre} » a été supprimé.`);
    }
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});

let releaseBusy = false;
async function removeQuiet(file) { try { await fsp.unlink(file); } catch (_) {  } }
app.post('/dashboard/client-release', requireAdmin, requireCsrf, async (req, res) => {
  if (releaseBusy) return res.status(409).json({ erreur: 'Un envoi est déjà en cours.' });
  const version = String(req.query.version || '').trim();
  const notes = String(req.query.notes || '').trim().slice(0, 600);
  const filename = String(req.query.filename || '');
  if (!/\.pkg$/i.test(filename)) return res.status(400).json({ erreur: 'Le fichier doit être un .pkg.' });
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-_]{0,15}$/.test(version)) return res.status(400).json({ erreur: 'Numéro de version invalide (ex. 01.01).' });
  releaseBusy = true;
  const tmp = path.join(STORE_DIR, `.upload-${process.pid}-${Date.now()}.tmp`);
  try {
    await pipelineAsync(req, fs.createWriteStream(tmp));
    const size = (await fsp.stat(tmp)).size;
    const real = readPkgVersion(tmp);
    if (!size || !real) { await removeQuiet(tmp); return res.status(400).json({ erreur: "Ce fichier n'est pas un .pkg PS4 valide (en-tête ou version illisible)." }); }
    if (real !== version) {
      await removeQuiet(tmp);
      return res.status(400).json({ erreur: `La version du paquet (${real}) ne correspond pas au numéro saisi (${version}) : la console réinstallerait la mise à jour en boucle.` });
    }

    const prev = currentRelease();
    const history = prev ? prev.history.slice() : [];
    if (prev && prev.version !== version) {
      let prevUrl = prev.pkg_url;
      if (prevUrl === '/store/PS4Store.pkg') {
        const archived = `PS4Store-v${prev.version}.pkg`;
        const dest = path.join(STORE_DIR, archived);
        if (!fs.existsSync(dest)) { try { fs.linkSync(STORE_PKG, dest); } catch (_) { try { fs.copyFileSync(STORE_PKG, dest); } catch (__) {  } } }
        prevUrl = fs.existsSync(dest) ? `/store/${archived}` : '';
      }
      history.unshift({ version: prev.version, pkg_url: prevUrl, file_size: prev.file_size, changelog: prev.changelog, updated_at: prev.updated_at });
    }

    const archiveName = `PS4Store-v${version}.pkg`;
    const archivePath = path.join(STORE_DIR, archiveName);
    await removeQuiet(archivePath);
    await fsp.rename(tmp, archivePath);
    const live = `${STORE_PKG}.${process.pid}.tmp`;
    await removeQuiet(live);
    try { fs.linkSync(archivePath, live); } catch (_) { fs.copyFileSync(archivePath, live); }
    fs.renameSync(live, STORE_PKG);

    const st = fs.statSync(STORE_PKG);
    const release = {
      version, pkg_url: '/store/PS4Store.pkg', file_size: st.size, changelog: notes || `Version ${version}.`,
      updated_at: new Date().toISOString(), history: history.filter((h) => h.version !== version).slice(0, MAX_CHANGELOG),
    };
    writeJsonAtomic(RELEASE_FILE, release);
    clientInfoCache = { key: '', info: null };
    notifyDiscordClient(release, originOf(req));
    res.json({ ok: true, version, file_size: st.size });
  } catch (err) {
    await removeQuiet(tmp);
    if (!res.headersSent) res.status(err && err.code === 'ECONNRESET' ? 400 : 500).json({ erreur: "L'envoi a échoué ou a été interrompu." });
  } finally {
    releaseBusy = false;
  }
});

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_ROLE_ID = '';
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const isWebhookUrl = (u) => WEBHOOK_RE.test(u) || (process.env.PS4STORE_TEST_WEBHOOK === '1' && /^http:\/\/127\.0\.0\.1:\d+\/.*$/.test(u));
function readSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (_) { return {}; }
}
function discordSettings() {
  const f = readSettings();
  const url = String(process.env.DISCORD_WEBHOOK_URL || f.discord_webhook_url || '').trim();
  const role = String(process.env.DISCORD_ROLE_ID || f.discord_role_id || DEFAULT_ROLE_ID).trim();
  return {
    url: isWebhookUrl(url) ? url : '', role: /^\d{5,25}$/.test(role) ? role : DEFAULT_ROLE_ID,
    site: String(process.env.PUBLIC_URL || f.site_url || '').trim().replace(/\/+$/, ''), fromEnv: !!process.env.DISCORD_WEBHOOK_URL,
  };
}
const originOf = (req) => discordSettings().site || `${req.protocol}://${req.get('host')}`;

async function postDiscord(embed, origin, opts) {
  const cfg = discordSettings();
  if (!cfg.url) return { ok: false, reason: 'webhook non configuré' };
  const ping = !(opts && opts.ping === false) && !!cfg.role;
  const body = ping ? { content: `<@&${cfg.role}>`, allowed_mentions: { roles: [cfg.role] }, embeds: [embed], username: 'PS4Store' }
    : { content: '', allowed_mentions: { parse: [] }, embeds: [embed], username: 'PS4Store' };
  try {
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.warn(`[PS4Store] webhook Discord : HTTP ${r.status}`); return { ok: false, reason: `HTTP ${r.status}` }; }
    return { ok: true };
  } catch (err) {
    console.warn('[PS4Store] webhook Discord :', err.message);
    return { ok: false, reason: err.message };
  }
}
const absUrl = (origin, u) => (!u ? '' : /^https?:\/\//i.test(u) ? u : `${origin}${u.startsWith('/') ? '' : '/'}${u}`);
const clip = (t, n) => { const x = String(t || '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const TYPE_LABEL = { pkg: 'Jeu / App', update: 'Mise à jour', dlc: 'DLC', plugin: 'Mod / Plugin', payload: 'Payload' };

function notifyDiscordGame(game, origin) {
  const type = game.resource_type || 'pkg';
  const pc = game.plugin_config && game.plugin_config.supported_regions;
  const region = type === 'plugin' || type === 'payload' ? ({ EU: 'EU', US: 'US', BOTH: 'EU + US' }[pc] || 'EU + US') : 'EU + US';
  const embed = {
    title: clip(`Nouveau : ${game.titre}`, 250), url: `${origin}/jeu/${game.id}`, color: 0x0070D1,
    description: clip(game.description || (game.changelog && game.changelog[0] && game.changelog[0].notes) || 'Disponible sur PS4Store.', 1000),
    fields: [
      { name: 'Type', value: TYPE_LABEL[type] || type, inline: true }, { name: 'Version', value: clip(game.version, 30) || '—', inline: true },
      { name: 'Taille', value: clip(game.size, 30) || '—', inline: true }, { name: 'Région', value: region, inline: true },
      { name: 'Title ID', value: game.title_id || '—', inline: true },
    ],
    footer: { text: `PS4Store · par ${clip(game.author_name, 40) || '—'}` }, timestamp: new Date().toISOString(),
  };
  if (game.icon_url) embed.thumbnail = { url: absUrl(origin, game.icon_url) };
  if (Array.isArray(game.screenshots) && game.screenshots[0]) embed.image = { url: absUrl(origin, game.screenshots[0]) };
  return postDiscord(embed, origin);
}
function notifyDiscordUpdate(game, entry, size, origin) {
  const type = game.resource_type || 'pkg';
  const embed = {
    title: clip(`🔄 Mise à jour • ${game.titre} (v${entry.version})`, 250), url: `${origin}/jeu/${game.id}`, color: 0xFF9F0A,
    description: clip(entry.notes, 1000) || `Nouvelle version ${entry.version}.`,
    fields: [
      { name: 'Version', value: clip(entry.version, 30), inline: true }, { name: 'Taille', value: clip(size, 30) || '—', inline: true },
      { name: 'Type', value: TYPE_LABEL[type] || type, inline: true }, { name: 'Title ID', value: game.title_id || '—', inline: true },
    ],
    footer: { text: `PS4Store · par ${clip(game.author_name, 40) || '—'}` }, timestamp: new Date().toISOString(),
  };
  if (game.icon_url) embed.thumbnail = { url: absUrl(origin, game.icon_url) };
  return postDiscord(embed, origin);
}
async function probeSizeLabel(url, type, target) {
  try {
    const r = await Promise.race([probeLink(url, { resource_type: type, target_type: target }), new Promise((_, rej) => setTimeout(() => rej(new Error('délai')), 12000))]);
    return r && r.checked && r.size_label ? r.size_label : '';
  } catch (_) { return ''; }
}

function notifyDiscordClient(release, origin) {
  return postDiscord({
    title: clip(`Mise à jour de PS4Store ${release.version}`, 250), url: `${origin}/#installation`, color: 0x30D158,
    description: clip(release.changelog, 1000) || 'Nouvelle version de l’application PS4Store.',
    fields: [
      { name: 'Version', value: release.version, inline: true }, { name: 'Taille', value: fmtBytes(release.file_size) || '—', inline: true },
      { name: 'Région', value: 'EU + US', inline: true }, { name: 'Téléchargement', value: `${origin}${release.pkg_url}`.slice(0, 1000) },
    ],
    footer: { text: 'PS4Store' }, timestamp: new Date().toISOString(),
  }, origin);
}

app.post('/dashboard/settings', requireAdmin, requireSuper, requireCsrf, (req, res) => {
  const str = (k) => (typeof req.body[k] === 'string' ? req.body[k].trim() : '');
  const cur = readSettings();
  const next = { ...cur };
  const errors = [];
  const url = str('discord_webhook_url');
  if (url) { if (isWebhookUrl(url)) next.discord_webhook_url = url; else errors.push("L'adresse du webhook doit être de la forme https://discord.com/api/webhooks/<id>/<jeton>."); }
  else if (req.body.clear_webhook === '1') next.discord_webhook_url = '';
  const role = str('discord_role_id') || DEFAULT_ROLE_ID;
  if (!role || /^\d{5,25}$/.test(role)) next.discord_role_id = role; else errors.push("L'identifiant du rôle doit être numérique.");
  const site = str('site_url');
  if (!site || /^https?:\/\/[^\s/]+$/i.test(site.replace(/\/+$/, ''))) next.site_url = site.replace(/\/+$/, ''); else errors.push("L'adresse publique doit ressembler à https://mon-site.example.");
  if (errors.length) { setFlash(req, 'error', errors.join(' ')); return res.redirect('/dashboard'); }
  writeJsonAtomic(SETTINGS_FILE, next);
  setFlash(req, 'success', 'Réglages Discord enregistrés.');
  res.redirect('/dashboard');
});
app.post('/dashboard/discord-test', requireAdmin, requireSuper, requireCsrf, async (req, res) => {
  const origin = originOf(req);
  const r = await postDiscord({ title: 'Test PS4Store', description: 'Le webhook fonctionne : le rôle sera mentionné à chaque nouveau jeu ou mise à jour du client.', color: 0x0070D1,
    footer: { text: 'PS4Store' }, timestamp: new Date().toISOString() }, origin);
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { erreur: `Envoi impossible : ${r.reason}` });
});

const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
function loadSubmissions() {
  try {
    const j = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
    return Array.isArray(j) ? j.filter((x) => x && x.id && x.game) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[PS4Store] submissions.json illisible :', err.message);
    return [];
  }
}
let submissions = loadSubmissions();
const saveSubmissions = () => writeJsonAtomic(SUBMISSIONS_FILE, submissions);
const MAX_PENDING_PER_USER = 10;

function renderSubmit(req, res, status, errors, values) {
  res.status(status).render('submit', {
    errors, values: values || {}, csrf: csrfToken(req),
    firmwares: FIRMWARES, categories: CATEGORIES, parentOptions: games.filter((g) => (g.resource_type || 'pkg') === 'pkg').map((g) => ({ title_id: g.title_id, titre: g.titre })),
  });
}
app.get('/proposer', (req, res) => {
  if (!req.user) return res.redirect('/login?next=%2Fproposer');
  renderSubmit(req, res, 200, [], {});
});
app.post('/proposer', requireCsrf, (req, res) => {
  if (!req.user) return res.redirect('/login?next=%2Fproposer');
  const { value, errors } = validateGame(req.body);
  if (submissions.filter((x) => x.submitted_by === req.user.id && x.status === 'pending').length >= MAX_PENDING_PER_USER) errors.push(`Vous avez déjà ${MAX_PENDING_PER_USER} propositions en attente.`);
  if (!errors.length && submissions.some((x) => x.status === 'pending' && x.submitted_by === req.user.id && x.game.title_id === value.title_id && x.game.version === value.version && x.game.resource_type === value.resource_type)) {
    errors.push('Cette proposition est déjà en attente de validation.');
  }
  if (errors.length) return renderSubmit(req, res, 400, errors, req.body);
  submissions.push({
    id: crypto.randomUUID(), status: 'pending', submitted_by: req.user.id, submitted_by_name: req.user.username, created_at: new Date().toISOString(),
    game: { ...value, changelog: [{ version: value.version, date: new Date().toISOString().slice(0, 10), notes: 'Première publication' }] },
  });
  saveSubmissions();
  res.redirect('/mon-compte?sub=1');
});

app.post('/dashboard/submissions/:id/approve', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const sub = submissions.find((x) => x.id === req.params.id && x.status === 'pending');
    if (!sub) { setFlash(req, 'error', "Cette proposition n'existe plus ou a déjà été traitée."); return res.redirect('/dashboard'); }
    const value = { ...sub.game };
    if (titleConflict(value, '')) {
      if (/^(BREW|PLUG|PAYL)\d{5}$/.test(value.title_id)) value.title_id = generateTitleId(value.title_id.slice(0, 4));
      if (titleConflict(value, '')) { setFlash(req, 'error', 'Ce Title ID ou cette version existe déjà dans le catalogue.'); return res.redirect('/dashboard'); }
    }
    const member = users.find((u) => u.id === sub.submitted_by);
    const now = new Date().toISOString();
    const game = {
      id: crypto.randomUUID(), ...value, changelog: sanitizeChangelog(value.changelog),
      author_id: member ? member.id : req.admin.id, author_name: member ? (member.display_name || member.username) : sub.submitted_by_name,
      author_username: member ? member.username : '', created_at: now, updated_at: now,
    };
    games.push(game);
    await gamesStore.save(games);
    Object.assign(sub, { status: 'approved', reviewed_at: now, reviewed_by: req.admin.id, game_id: game.id });
    saveSubmissions();
    notifyDiscordGame(game, originOf(req));
    setFlash(req, 'success', `« ${game.titre} » est publié au nom de ${game.author_name}.`);
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});
app.post('/dashboard/submissions/:id/reject', requireAdmin, requireCsrf, (req, res) => {
  const sub = submissions.find((x) => x.id === req.params.id && x.status === 'pending');
  if (!sub) { setFlash(req, 'error', "Cette proposition n'existe plus ou a déjà été traitée."); return res.redirect('/dashboard'); }
  const reason = (typeof req.body.reason === 'string' ? req.body.reason.trim() : '').slice(0, 200) || 'Aucun motif précisé.';
  Object.assign(sub, { status: 'rejected', reject_reason: reason, reviewed_at: new Date().toISOString(), reviewed_by: req.admin.id });
  saveSubmissions();
  setFlash(req, 'success', `Proposition « ${sub.game.titre} » refusée.`);
  res.redirect('/dashboard');
});

function setMemberRole(u, role) {
  if (!['user', 'admin', 'superadmin'].includes(role)) return 'Rôle invalide.';
  if (u.role === 'superadmin' && role !== 'superadmin' && users.filter((x) => x.role === 'superadmin').length <= 1) return 'Impossible de retirer le dernier super-administrateur.';
  u.role = role;
  return '';
}

app.post('/dashboard/users/:id/role', requireAdmin, requireSuper, requireCsrf, async (req, res, next) => {
  try {
    const u = users.find((x) => x.id === req.params.id);
    const role = typeof req.body.role === 'string' ? req.body.role : '';
    if (!u) { setFlash(req, 'error', 'Membre introuvable.'); return res.redirect('/dashboard#comptes'); }
    const err = setMemberRole(u, role);
    if (err) { setFlash(req, 'error', err); return res.redirect('/dashboard#comptes'); }
    saveUsers();
    setFlash(req, 'success', `Rôle de @${u.username} : ${role}.`);
    res.redirect('/dashboard#comptes');
  } catch (err) { next(err); }
});

const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads');
const COVER_DIR = path.join(UPLOAD_ROOT, 'covers');
const SHOT_DIR = path.join(UPLOAD_ROOT, 'screenshots');
for (const dir of [COVER_DIR, SHOT_DIR]) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {  } }

const TMDB_HMAC_KEY = Buffer.from('F5DE66D2680E255B2DF79E74F890EBF349262F618BCAE2A9ACCDEE5156CE8DF2CDF2D48C71173CDC2594465B87405D197CF1AED3B7E9671EEB56CA6753C2E6B0', 'hex');
const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_HOSTS = [/(^|\.)playstation\.net$/i, /(^|\.)playstation\.com$/i, /(^|\.)steamstatic\.com$/i, /^steamcdn-a\.akamaihd\.net$/i];
const allowedMediaHost = (host) => MEDIA_HOSTS.some((re) => re.test(host));
const mediaSlug = (text) => foldText(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const normName = (text) => foldText(text).replace(/[^a-z0-9]+/g, ' ').trim();

async function fetchJson(url, headers) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...(headers || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function downloadImage(rawUrl) {
  let url = String(rawUrl || '');
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol) || !allowedMediaHost(u.hostname)) return null;
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    if (!r.ok || !/^image\//i.test(r.headers.get('content-type') || '')) return null;
    const chunks = [];
    let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > MEDIA_MAX_BYTES) return null;
      chunks.push(chunk);
    }
    return total > 0 ? Buffer.concat(chunks) : null;
  }
  return null;
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

async function steamLookup(title) {
  const wanted = normName(title);
  if (!wanted) return null;
  const search = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=french&cc=FR`);
  const items = Array.isArray(search && search.items) ? search.items : [];
  const item = items.find((i) => normName(i.name) === wanted)
    || items.find((i) => { const n = normName(i.name); return n && (n.includes(wanted) || wanted.includes(n)); });
  if (!item || !Number.isInteger(item.id)) return null;
  const details = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${item.id}&l=french`);
  const data = details && details[item.id] && details[item.id].success ? details[item.id].data : null;
  if (!data) return null;
  return {
    appid: item.id,
    name: String(data.name || item.name || ''),
    header: typeof data.header_image === 'string' ? data.header_image : '',
    description: shortDescription(cleanText(data.short_description || '')),
    screenshots: (Array.isArray(data.screenshots) ? data.screenshots : []).map((x) => x && x.path_full).filter((x) => typeof x === 'string'),
  };
}

async function tmdbMeta(titleId) {
  const id = `${titleId}_00`;
  const hmac = crypto.createHmac('sha1', TMDB_HMAC_KEY).update(id).digest('hex').toUpperCase();
  return fetchJson(`https://tmdb.np.dl.playstation.net/tmdb2/${id}_${hmac}/${id}.json`);
}
function tmdbName(meta) {
  const names = meta && Array.isArray(meta.names) ? meta.names : [];
  const hit = names.find((n) => n && typeof n.name === 'string' && n.name.trim());
  const name = hit ? hit.name : (meta && typeof meta.name === 'string' ? meta.name : '');
  return String(name).replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&hellip;': '…' };
function cleanText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp|rsquo|hellip);/g, (m) => HTML_ENTITIES[m] || m).replace(/\s+/g, ' ').trim();
}
function shortDescription(text) {
  if (text.length <= 480) return text;
  const cut = text.slice(0, 480);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 200 ? cut.slice(0, end + 1) : `${cut.slice(0, 470).trim()}…`;
}

async function wikiSummary(title) {
  const wanted = normName(title);
  if (!wanted) return null;
  const found = await fetchJson(`https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${title} jeu vidéo`)}&srlimit=3&format=json`);
  const hits = found && found.query && Array.isArray(found.query.search) ? found.query.search : [];
  const hit = hits.find((h) => { const n = normName(String(h.title || '').replace(/\(.*?\)/g, '')); return n && (n === wanted || n.includes(wanted) || wanted.includes(n)); });
  if (!hit) return null;
  const sum = await fetchJson(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(hit.title).replace(/ /g, '_'))}`);
  return sum && sum.type === 'standard' && sum.extract ? shortDescription(cleanText(sum.extract)) : null;
}

async function fetchCover(titleId, title, steamP, meta) {
  const file = `${/^[A-Z]{4}\d{5}$/.test(titleId) ? titleId : (mediaSlug(title) || 'cover')}.png`;
  let buf = null, source = '';
  try {
    const icon = meta && Array.isArray(meta.icons) && meta.icons[0] && meta.icons[0].icon;
    if (icon) { buf = await downloadImage(icon); if (buf) source = 'playstation'; }
    if (!buf && meta && meta.background_image) { buf = await downloadImage(meta.background_image); if (buf) source = 'playstation'; }
  } catch (_) {  }
  if (!buf) {
    try {
      const steam = await steamP;
      if (steam && steam.header) { buf = await downloadImage(steam.header); if (buf) source = 'steam'; }
    } catch (_) {  }
  }
  if (!buf) return { cover: null };
  writeFileAtomic(path.join(COVER_DIR, file), buf);
  return { cover: { path: `/uploads/covers/${file}`, source } };
}

async function searchTrailer(title) {
  const q = `${title} PS4 official trailer`;
  const idOk = (v) => (typeof v === 'string' && /^[\w-]{11}$/.test(v) ? v : null);
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
      let id = null;
      if (m) { const hit = m[1].match(/"videoRenderer":\{"videoId":"([\w-]{11})"/); id = hit && idOk(hit[1]); }
      if (!id) { const hit = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/); id = hit && idOk(hit[1]); }
      if (id) return id;
    }
  } catch (_) {  }
  for (const base of ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de']) {
    try {
      const j = await fetchJson(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`);
      const it = Array.isArray(j && j.items) ? j.items.find((x) => x && typeof x.url === 'string' && x.url.includes('v=')) : null;
      const id = it && idOk(new URL(it.url, 'https://x.invalid').searchParams.get('v'));
      if (id) return id;
    } catch (_) {  }
  }
  for (const base of ['https://yewtu.be', 'https://inv.nadeko.net']) {
    try {
      const j = await fetchJson(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
      const id = Array.isArray(j) && j[0] && idOk(j[0].videoId);
      if (id) return id;
    } catch (_) {  }
  }
  return null;
}

async function fetchScreenshots(titleId, title, steamP) {
  const steam = await steamP;
  if (!steam || !steam.screenshots.length) return [];
  const slug = mediaSlug(title) || titleId.toLowerCase() || 'capture';
  const out = [];
  for (const url of steam.screenshots) {
    if (out.length >= 4) break;
    try {
      const buf = await downloadImage(url);
      if (!buf) continue;
      const name = `${slug}-${out.length + 1}.jpg`;
      writeFileAtomic(path.join(SHOT_DIR, name), buf);
      out.push(`/uploads/screenshots/${name}`);
    } catch (_) {  }
  }
  return out;
}

function findKnownTitle(titleId, title) {
  if (titleId) return KNOWN_TITLES.find((k) => k.eu === titleId || k.us === titleId) || null;
  const wanted = normName(title);
  return wanted ? KNOWN_TITLES.find((k) => normName(k.name) === wanted || k.aliases.some((a) => normName(a) === wanted)) || null : null;
}

const mediaBusy = new Set();
async function autoFetchMedia(req, res) {
  const rawId = String(req.body.title_id || '').trim();
  const compact = rawId.replace(/\s+/g, '').toUpperCase();
  let titleId = /^[A-Z]{4}\d{5}$/.test(compact) ? compact : '';
  let title = String(req.body.title || '').trim().slice(0, 80);
  if (!titleId && rawId) {
    if (/^[A-Z]{4}\d+$/.test(compact)) return res.status(400).json({ erreur: 'Title ID incomplet (4 lettres + 5 chiffres, ex. CUSA00411).' });
    if (!title) title = rawId.slice(0, 80);
  }
  if (!titleId && !title) return res.status(400).json({ erreur: 'Saisissez un Title ID ou le nom du jeu.' });
  const who = req.admin && req.admin.id ? String(req.admin.id) : (req.user ? req.user.id : req.ip);
  if (mediaBusy.has(who)) return res.status(429).json({ erreur: 'Une recherche est déjà en cours.' });
  mediaBusy.add(who);
  try {
    const known = findKnownTitle(titleId, title);
    const metaId = titleId || (known ? known.eu : '');
    const meta = /^(CUSA|PPSA)\d{5}$/.test(metaId) ? await tmdbMeta(metaId).catch(() => null) : null;
    const official = tmdbName(meta) || (titleId && !title && known ? known.name : '');
    const exactTitle = official || (known && !titleId ? known.name : '') || title;
    const lookup = exactTitle;
    const suggestedId = !titleId && known ? known.eu : '';

    const steamP = lookup ? steamLookup(lookup).catch(() => null) : Promise.resolve(null);
    const descP = steamP.then((st) => (st && st.description) || (lookup ? wikiSummary(lookup).catch(() => null) : null));
    const [cover, trailer, shots, desc] = await Promise.allSettled([
      fetchCover(metaId, lookup, steamP, meta),
      lookup ? searchTrailer(lookup) : Promise.resolve(null),
      fetchScreenshots(titleId, lookup, steamP),
      descP,
    ]);
    const coverRes = cover.status === 'fulfilled' ? cover.value.cover : null;
    const videoId = trailer.status === 'fulfilled' ? trailer.value : null;
    res.json({
      title: exactTitle,
      title_id: suggestedId,
      description: desc.status === 'fulfilled' && desc.value ? desc.value : '',
      cover: coverRes ? coverRes.path : '',
      cover_source: coverRes ? coverRes.source : '',
      video_id: videoId || '',
      youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
      embed_url: videoId ? `https://www.youtube.com/embed/${videoId}` : '',
      screenshots: shots.status === 'fulfilled' ? shots.value : [],
    });
  } catch (err) {
    console.error('[PS4Store] fetch-media :', err);
    res.status(500).json({ erreur: "La récupération des médias a échoué." });
  } finally {
    mediaBusy.delete(who);
  }
}

app.post('/dashboard/fetch-media', requireAdmin, requireCsrf, async (req, res) => {
  if (!req.body || typeof req.body.url !== 'string') return autoFetchMedia(req, res);
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url : '';
  const id = extractYoutubeId(raw);
  if (!id) return res.status(400).json({ erreur: "Ce n'est pas un lien YouTube valide." });

  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  try {
    const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'PS4Store/1.0', Accept: 'application/json' },
    });
    if (oembed.status === 401 || oembed.status === 403 || oembed.status === 404) {
      return res.status(404).json({ erreur: 'Vidéo introuvable, privée ou non intégrable.' });
    }
    if (!oembed.ok) return res.status(502).json({ erreur: `YouTube a répondu ${oembed.status}. Réessayez plus tard.` });
    const meta = await oembed.json();

    let thumbnail = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
    let hd = true;
    try {
      const head = await fetch(thumbnail, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      if (!head.ok) { thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; hd = false; }
    } catch (_) { thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; hd = false; }

    res.json({
      video_id: id,
      youtube_url: watchUrl,
      title: String(meta.title || '').slice(0, 80),
      channel: String(meta.author_name || ''),
      thumbnail,
      thumbnail_hd: hd,
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    res.status(502).json({ erreur: timeout ? 'YouTube ne répond pas (délai dépassé).' : 'Impossible de joindre YouTube depuis le serveur.' });
  }
});

app.post('/api/submit/fetch-media', requireUserApi, requireCsrf, (req, res) => autoFetchMedia(req, res));

app.post('/dashboard/check-link', requireAdmin, requireCsrf, async (req, res) => {
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!isHttpUrl(raw) || raw.length > 1000) return res.status(400).json({ erreur: 'Collez un lien http(s) valide.' });
  try {
    res.json(await probeLink(raw, {
      resource_type: typeof req.body.resource_type === 'string' ? req.body.resource_type : 'pkg',
      target_type: typeof req.body.target_type === 'string' ? req.body.target_type : '',
    }));
  } catch (err) {
    if (err instanceof LinkError) return res.status(err.status === 504 ? 504 : 422).json({ erreur: err.message });
    console.error('[PS4Store] check-link :', err);
    res.status(502).json({ erreur: "Impossible de vérifier ce lien depuis le serveur." });
  }
});

const aiBusy = new Set();
app.post('/dashboard/ai-plugin-helper', requireAdmin, requireCsrf, async (req, res) => {
  const b = req.body || {};
  const str = (k, max) => (typeof b[k] === 'string' ? b[k].trim().slice(0, max) : '');
  const resourceType = str('resource_type', 12);
  if (resourceType !== 'plugin' && resourceType !== 'payload') return res.status(400).json({ erreur: "L'assistant ne sert que pour les plugins et les payloads." });
  const scope = REGIONS.includes(str('scope', 6)) ? str('scope', 6) : 'BOTH';
  const link = str('pkg_url', 1000);
  const input = {
    resource_type: resourceType, scope, titre: str('titre', 80), description: str('description', 2000),
    pkg_url: isHttpUrl(link) ? link : '', target_type: str('target_type', 10),
  };
  if (!input.titre && !input.description && !input.pkg_url) return res.status(400).json({ erreur: 'Décrivez la ressource (titre, description ou lien du fichier).' });
  if (aiBusy.has(req.admin.id)) return res.status(429).json({ erreur: "Une analyse est déjà en cours, patientez quelques secondes." });
  aiBusy.add(req.admin.id);
  try {
    res.json(await aiPluginHelper(input));
  } catch (err) {
    console.error('[PS4Store] ai-plugin-helper :', err);
    res.status(500).json({ erreur: "L'assistant a rencontré une erreur interne." });
  } finally {
    aiBusy.delete(req.admin.id);
  }
});

let testerMemo = { at: 0, map: new Map() };
function fwVoteCount(uid) {
  if (Date.now() - testerMemo.at > 30000) {
    const m = new Map();
    games.forEach((g) => FW_VOTE_KEYS.forEach((k) => ((g.firmware_votes || {})[k] || []).forEach((id) => m.set(id, (m.get(id) || 0) + 1))));
    testerMemo = { at: Date.now(), map: m };
  }
  return testerMemo.map.get(uid) || 0;
}
function badgesOf(u) {
  if (!u) return [];
  const b = [];
  if (u.role === 'superadmin') b.push('founder'); else if (u.role === 'admin') b.push('staff');
  if (games.some((g) => g.author_id === u.id)) b.push('creator');
  if (fwVoteCount(u.id) >= 5) b.push('tester');
  if ((u.library || []).length >= 10) b.push('collector');
  return b;
}
app.locals.badgesOf = (id) => badgesOf(users.find((u) => u.id === id));

app.post('/api/users/:id/follow', requireUserApi, requireCsrf, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ erreur: 'Membre introuvable.' });
  if (target.id === req.user.id) return res.status(400).json({ erreur: 'Vous ne pouvez pas vous suivre vous-même.' });
  const me = req.user, already = me.following.includes(target.id);
  if (already) { me.following = me.following.filter((id) => id !== target.id); target.followers = target.followers.filter((id) => id !== me.id); }
  else { me.following.push(target.id); if (!target.followers.includes(me.id)) target.followers.push(me.id); }
  saveUsers();
  res.json({ ok: true, following: !already, followers: target.followers.length });
});

function activeGameOf(user) {
  for (const c of user.paired_consoles) {
    const st = consoleStatus.get(c.id);
    if (st && Date.now() - st.at < ONLINE_MS && playingActive(st)) return { name: resolveTitleName(st.playing.title_id) || st.playing.name, title_id: st.playing.title_id, since: st.playing.started_at };
  }
  return null;
}
function activityOf(member) {
  const items = [];
  games.forEach((g) => {
    if (g.author_id === member.id) items.push({ type: 'resource', date: g.created_at, title: g.titre, href: `/jeu/${g.id}` });
    (g.comments || []).forEach((c) => { if (c.user_id === member.id) items.push({ type: 'review', date: c.created_at, title: g.titre, text: String(c.content).slice(0, 160), href: `/jeu/${g.id}#c-${c.id}` }); });
  });
  collections.forEach((c) => { if (c.author_id === member.id) items.push({ type: 'collection', date: c.created_at, title: c.title, href: c.featured ? `/catalogue?collection=${c.id}` : '' }); });
  const dated = items.filter((i) => i.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 15);
  const votes = games.filter((g) => FW_VOTE_KEYS.some((k) => ((g.firmware_votes || {})[k] || []).includes(member.id))).slice(0, 5)
    .map((g) => ({ type: 'vote', date: '', title: g.titre, href: `/jeu/${g.id}#compat` }));
  return dated.concat(votes);
}

app.get('/api/stats', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const by = {};
  RESOURCE_TYPES.forEach((t) => { by[t] = games.filter((g) => (g.resource_type || 'pkg') === t).length; });
  const r = currentRelease();
  res.json({
    resources: games.length, by_type: by, members: users.length, consoles: users.reduce((n, u) => n + u.paired_consoles.length, 0),
    downloads: games.reduce((n, g) => n + (g.downloads_count || 0), 0), open_requests: requests.filter((x) => x.status === 'open').length,
    client_version: r ? r.version : '', generated_at: new Date().toISOString(),
  });
});
app.get('/api-docs', (req, res) => res.render('apidocs', { origin: `${req.protocol}://${req.get('host')}` }));

const REPORT_REASONS = { dead: 'Lien 404 / expiré', corrupt: 'Fichier corrompu', region: 'Mauvaise région' };
const reportHits = new Map();
function reporterOf(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.get('Authorization') || '');
  if (m) {
    for (const u of users) if (u.paired_consoles.some((c) => safeEqual(c.device_token, m[1].toLowerCase()))) return { id: u.id, kind: 'console', name: u.username };
    return { error: 401 };
  }
  if (req.user) {
    const sent = req.get('X-CSRF-Token') || '';
    if (!(req.session.csrf && sent && safeEqual(sent, req.session.csrf))) return { error: 403 };
    return { id: req.user.id, kind: 'member', name: req.user.username };
  }
  return { error: 401 };
}
app.post('/api/games/:id/report-link', async (req, res, next) => {
  try {
    const g = gameById(req.params.id);
    if (!g) return res.status(404).json({ erreur: 'Ressource introuvable.' });
    const who = reporterOf(req);
    if (who.error) return res.status(who.error).json({ code: who.error === 401 ? 'auth_required' : 'csrf', erreur: who.error === 401 ? 'Connectez-vous (ou liez votre console) pour signaler un lien.' : 'Jeton de sécurité invalide. Rechargez la page.' });
    const reason = REPORT_REASONS[(req.body || {}).reason] ? req.body.reason : 'dead';
    const now = Date.now();
    const hits = (reportHits.get(req.ip) || []).filter((t) => now - t < 3600000);
    if (hits.length >= 10) return res.status(429).json({ erreur: 'Trop de signalements : réessayez plus tard.' });
    ensureCommunity(g);
    if (g.broken_reports.some((r) => r.user_id === who.id)) return res.status(409).json({ code: 'duplicate', erreur: 'Vous avez déjà signalé cette ressource : un administrateur doit traiter les signalements.' });
    hits.push(now); reportHits.set(req.ip, hits);
    g.broken_reports.push({ user_id: who.id, reason, created_at: new Date(now).toISOString() });
    if (g.broken_reports.length > 100) g.broken_reports.splice(0, g.broken_reports.length - 100);
    await gamesStore.save(games);
    const site = discordSettings().site || originOf(req);
    postDiscord({
      title: '🔗 Lien signalé comme défectueux', color: 0xF39C12, url: `${site}/jeu/${g.id}`,
      description: `**${clip(g.titre, 80)}** (\`${g.title_id}\`) — ${REPORT_REASONS[reason]}\n[Voir la fiche](${site}/jeu/${g.id}) · [Tableau de bord](${site}/dashboard) pour corriger puis réinitialiser les signalements.`,
      fields: [{ name: 'Signalements', value: String(g.broken_reports.length), inline: true }, { name: 'Source', value: who.kind, inline: true }],
      footer: { text: 'Staff : vérifiez le lien dans le salon de report' },
    }, site, { ping: false });
    res.status(201).json({ ok: true, count: g.broken_reports.length });
  } catch (err) { next(err); }
});
app.post('/dashboard/games/:id/reset-reports', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const g = gameById(req.params.id);
    if (!g) setFlash(req, 'error', "Cette fiche n'existe plus.");
    else { g.broken_reports = []; await gamesStore.save(games); setFlash(req, 'success', `Signalements de « ${g.titre} » réinitialisés.`); }
    res.redirect('/dashboard#jeux');
  } catch (err) { next(err); }
});

let likeMemo = { at: 0, map: new Map() };
function likeTotal(id) {
  if (Date.now() - likeMemo.at > 30000) {
    const m = new Map();
    users.forEach((u) => u.likes.forEach((gid) => m.set(gid, (m.get(gid) || 0) + 1)));
    likeMemo = { at: Date.now(), map: m };
  }
  return likeMemo.map.get(id) || 0;
}
function fwReliability(g) {
  const v = g.firmware_votes || {};
  const ok = (v['9.00'] || []).length + (v['11.00'] || []).length, bad = (v.issue || []).length;
  return ok + bad ? Math.round((ok / (ok + bad)) * 100) : -1;
}

const HTML_BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote']);
const HTML_INLINE_TAGS = new Set(['strong', 'em', 'u', 's', 'code', 'a', 'br', 'span']);
const HTML_TAG_MAP = { b: 'strong', i: 'em', strike: 's', del: 's', div: 'p', font: 'span' };
const hexOf = (v) => {
  v = String(v || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v); if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}` : '';
};
const safeHref = (u) => { u = String(u || '').trim(); return /^(https?:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*|mailto:[^\s"'<>]+)$/i.test(u) ? u : ''; };
function cleanStyle(raw) {
  const out = [];
  String(raw || '').split(';').forEach((d) => {
    const i = d.indexOf(':'); if (i < 0) return;
    const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
    if (k === 'color' || k === 'background-color') { const h = hexOf(v); if (h) out.push(`${k}:${h}`); }
    else if (k === 'text-align' && ['left', 'center', 'right', 'justify'].includes(v.toLowerCase())) out.push(`text-align:${v.toLowerCase()}`);
  });
  return out.join(';');
}
function sanitizeHtml(input, inlineOnly) {
  let src = String(input == null ? '' : input).slice(0, 20000).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  const allowed = (n) => HTML_INLINE_TAGS.has(n) || (!inlineOnly && HTML_BLOCK_TAGS.has(n));
  const open = [];
  const out = src.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[<>]/g, (tok, close, rawName, attrs) => {
    if (!rawName) return tok === '<' ? '&lt;' : '&gt;';
    let name = rawName.toLowerCase(); const orig = name; name = HTML_TAG_MAP[name] || name;
    if (!allowed(name)) return '';
    if (close) { const i = open.lastIndexOf(name); if (i < 0) return ''; open.length = i; return `</${name}>`; }
    if (name === 'br') return '<br>';
    const a = {};
    String(attrs || '').replace(/([a-zA-Z-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (m, k, v1, v2, v3) => { a[k.toLowerCase()] = v1 !== undefined ? v1 : v2 !== undefined ? v2 : v3; return ''; });
    let out = `<${name}`;
    let style = cleanStyle(a.style);
    if (orig === 'font' && a.color) { const h = hexOf(a.color); if (h) style = `color:${h}${style ? `;${style}` : ''}`; }
    if (name === 'a') {
      const href = safeHref(String(a.href || '').replace(/&amp;/g, '&'));
      if (!href) return '';
      out += ` href="${escapeHtml(href)}"`;
      if (/^https?:/i.test(href)) out += ' target="_blank" rel="noopener noreferrer nofollow"';
      if (/(^|\s)btn(\s|$)/.test(a.class || '')) out += ' class="btn"';
    }
    if (style && (name === 'span' || name === 'a' || HTML_BLOCK_TAGS.has(name))) out += ` style="${style}"`;
    open.push(name);
    return `${out}>`;
  });
  return out + open.slice().reverse().map((n) => `</${n}>`).join('');
}
const htmlToText = (h) => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const HOMEPAGE_FILE = path.join(DATA_DIR, 'homepage.json');
const SECTION_TYPES = ['carousel', 'collab_banner', 'spotlight_game', 'cta_banner', 'rich_text', 'features_grid', 'video', 'faq', 'discord_invite', 'counters', 'gallery', 'top_creators', 'button_bar', 'spacer', 'latest_grid'];
const TOGGLEABLE_IDS = ['hero_status_pill', 'hero_subtitle', 'hero_download_btn', 'hero_explore_btn', 'hero_changelog_btn', 'hero_client_card', 'hero_client_screen', 'hero_client_features', 'hero_client_status',
  'hero_stats_bar', 'home_collections', 'home_install_steps', 'home_cta', 'latest_filter_tabs', 'latest_more_link', 'catalogue_head', 'catalogue_collections', 'requests_head', 'requests_form',
  'status_head', 'status_banner', 'status_services', 'status_download', 'status_guides', 'footer_line1', 'footer_line2', 'footer_help_link', 'footer_api_link'];
const DEFAULT_HIDDEN = ['hero_status_pill', 'hero_client_status'];
const hitems = (arr, max, fn) => (Array.isArray(arr) ? arr : []).slice(0, max).map(fn).filter(Boolean);
const hid = () => crypto.randomBytes(5).toString('hex');
const hstr = (v, n) => short(v, n).trim();
const hcolor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '#0070D1');
const hcolorOpt = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '');
const hnum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : def; };
const hurl = (u) => { const x = hstr(u, 500); return x === '' || /^\/(?!\/)[^\s]*$/.test(x) || /^https?:\/\/[^\s]+$/i.test(x) ? x : ''; };
const hdate = (d) => { const t = Date.parse(String(d || '')); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const hid2 = (v) => (/^[\w-]{4,40}$/.test(String(v || '')) ? String(v) : hid());
function sanitizeSlide(x) {
  x = x && typeof x === 'object' ? x : {};
  return {
    id: hid2(x.id), badge: hstr(x.badge, 30), title: hstr(x.title, 80), subtitle: hstr(x.subtitle, 220), image_url: hurl(x.image_url),
    cta_label: hstr(x.cta_label, 30) || 'Découvrir', cta_url: hurl(x.cta_url), game_id: gameById(String(x.game_id || '')) ? String(x.game_id) : '',
    accent_color: hcolor(x.accent_color), sponsored_by: hstr(x.sponsored_by, 60), expires_at: hdate(x.expires_at), active: x.active !== false,
  };
}
function sanitizeStyle(x) {
  x = x && typeof x === 'object' ? x : {};
  return {
    bg_color: hcolorOpt(x.bg_color), bg_color2: hcolorOpt(x.bg_color2), gradient: x.gradient === true, accent: hcolorOpt(x.accent), text_color: hcolorOpt(x.text_color),
    bg_image: hurl(x.bg_image), overlay: hnum(x.overlay, 0, 100, 60), blur: hnum(x.blur, 0, 20, 0), radius: hnum(x.radius, 0, 24, 24), glow: x.glow === true,
    align: ['left', 'center', 'right'].includes(x.align) ? x.align : 'left',
  };
}
function sanitizeSpace(x) {
  x = x && typeof x === 'object' ? x : {};
  const opt = (v) => (v === '' || v == null ? null : hnum(v, 0, 160, null));
  return { pad_top: opt(x.pad_top), pad_bottom: opt(x.pad_bottom), margin_top: opt(x.margin_top), margin_bottom: opt(x.margin_bottom), visibility: ['both', 'desktop', 'mobile'].includes(x.visibility) ? x.visibility : 'both' };
}
function sanitizeSection(x) {
  x = x && typeof x === 'object' ? x : {};
  const type = SECTION_TYPES.includes(x.type) ? x.type : null;
  if (!type) return null;
  const o = { id: hid2(x.id), type, active: x.active !== false, style: sanitizeStyle(x.style), space: sanitizeSpace(x.space) };
  if (type === 'carousel') {
    Object.assign(o, {
      autoplay_s: hnum(x.autoplay_s, 0, 30, 6), mode: ['auto', 'custom', 'hybrid'].includes(x.mode) ? x.mode : 'custom',
      auto_count: hnum(x.auto_count, 1, 8, 4), auto_filter: ['all', 'games', 'mods'].includes(x.auto_filter) ? x.auto_filter : 'all',
    });
  } else if (type === 'collab_banner') {
    Object.assign(o, {
      badge: hstr(x.badge, 30), title: hstr(x.title, 90), description: hstr(x.description, 300), image_url: hurl(x.image_url), accent_color: hcolor(x.accent_color),
      creators: (Array.isArray(x.creators) ? x.creators : []).map((c) => hstr(c, 40).replace(/^@/, '')).filter(Boolean).slice(0, 4),
      cta_label: hstr(x.cta_label, 30), cta_url: hurl(x.cta_url),
    });
  } else if (type === 'spotlight_game') {
    Object.assign(o, {
      game_id: gameById(String(x.game_id || '')) ? String(x.game_id) : '', badge: hstr(x.badge, 30) || 'Mise en avant', title: hstr(x.title, 80), description: hstr(x.description, 300),
      image_url: hurl(x.image_url), note: hstr(x.note, 80), accent_color: hcolor(x.accent_color),
    });
  } else if (type === 'cta_banner') {
    Object.assign(o, { badge: hstr(x.badge, 30), icon: hstr(x.icon, 4), title: hstr(x.title, 90), text: hstr(x.text, 300), cta_label: hstr(x.cta_label, 30), cta_url: hurl(x.cta_url), accent_color: hcolor(x.accent_color) });
  } else if (type === 'rich_text') {
    Object.assign(o, { html: sanitizeHtml(x.html), width: ['narrow', 'normal', 'wide'].includes(x.width) ? x.width : 'normal' });
  } else if (type === 'features_grid') {
    Object.assign(o, { title: hstr(x.title, 90), cols: hnum(x.cols, 2, 4, 3), items: hitems(x.items, 8, (i) => (i && hstr(i.title, 60) ? { icon: hstr(i.icon, 4), title: hstr(i.title, 60), text: hstr(i.text, 200) } : null)) });
  } else if (type === 'video') {
    Object.assign(o, { title: hstr(x.title, 90), url: hstr(x.url, 300), caption: hstr(x.caption, 200) });
  } else if (type === 'faq') {
    Object.assign(o, { title: hstr(x.title, 90), items: hitems(x.items, 20, (i) => (i && hstr(i.q, 160) ? { q: hstr(i.q, 160), a: hstr(i.a, 1000) } : null)) });
  } else if (type === 'discord_invite') {
    Object.assign(o, { title: hstr(x.title, 90), text: hstr(x.text, 240), invite_url: /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/i.test(hstr(x.invite_url, 200)) ? hstr(x.invite_url, 200) : '',
      guild_id: /^\d{5,25}$/.test(hstr(x.guild_id, 25)) ? hstr(x.guild_id, 25) : '', channels: hitems(x.channels, 5, (c) => hstr(c, 40).replace(/^#/, '') || null), button_label: hstr(x.button_label, 30) || 'Rejoindre le Discord' });
  } else if (type === 'counters') {
    Object.assign(o, { items: hitems(x.items, 4, (i) => (i && (hstr(i.value, 20) || hstr(i.label, 40)) ? { value: hstr(i.value, 20), label: hstr(i.label, 40), sub: hstr(i.sub, 60) } : null)) });
  } else if (type === 'gallery') {
    Object.assign(o, { title: hstr(x.title, 90), layout: x.layout === 'mosaic' ? 'mosaic' : 'grid', images: hitems(x.images, 24, (i) => { const u = hurl(i && i.url); return u ? { url: u, caption: hstr(i.caption, 120) } : null; }) });
  } else if (type === 'top_creators') {
    Object.assign(o, { title: hstr(x.title, 90), mode: x.mode === 'manual' ? 'manual' : 'auto', count: hnum(x.count, 2, 4, 3), creators: hitems(x.creators, 4, (c) => hstr(c, 40).replace(/^@/, '') || null) });
  } else if (type === 'button_bar') {
    Object.assign(o, { align: x.align === 'center' ? 'center' : 'left', buttons: hitems(x.buttons, 3, (b) => (b && hstr(b.label, 40) ? { label: hstr(b.label, 40), url: hurl(b.url), color: hcolorOpt(b.color), icon: hstr(b.icon, 4), size: ['small', 'medium', 'large'].includes(b.size) ? b.size : 'medium' } : null)) });
  } else if (type === 'spacer') Object.assign(o, { height: [24, 48, 80].includes(Number(x.height)) ? Number(x.height) : 48, line: x.line === true, title: hstr(x.title, 80) });
  else Object.assign(o, { title: hstr(x.title, 80), count: hnum(x.count, 1, 24, 8), filter: ['all', 'games', 'mods', 'payloads'].includes(x.filter) ? x.filter : 'all' });
  return o;
}
function sanitizeTheme(x) {
  x = x && typeof x === 'object' ? x : {};
  const a = x.announce && typeof x.announce === 'object' ? x.announce : {};
  return {
    accent: hcolorOpt(x.accent), bg_color: hcolorOpt(x.bg_color), radius: x.radius === '' || x.radius == null ? null : hnum(x.radius, 0, 32, null),
    nav_style: ['default', 'solid', 'transparent', 'blur'].includes(x.nav_style) ? x.nav_style : 'default',
    card_style: ['glass', 'flat', 'outline'].includes(x.card_style) ? x.card_style : 'glass',
    announce: { active: a.active === true, text: hstr(a.text, 200), link_label: hstr(a.link_label, 30), link_url: hurl(a.link_url), color: hcolor(a.color) },
  };
}
function sanitizeHomepage(x) {
  x = x && typeof x === 'object' ? x : {};
  const list = (v) => (Array.isArray(v) ? v : []).slice(0, 30).map(sanitizeSection).filter(Boolean);
  const ov = {};
  const src = x.text_overrides && typeof x.text_overrides === 'object' ? x.text_overrides : {};
  Object.keys(src).slice(0, 400).forEach((k) => {
    const def = dictionaries.fr ? dictionaries.fr[k] : undefined;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(k) || typeof def !== 'string' || /\{\w+\}/.test(def)) return;
    const v = sanitizeHtml(src[k], true).slice(0, 2000);
    if (htmlToText(v).trim()) ov[k] = v;
  });
  return {
    hero_carousel: (Array.isArray(x.hero_carousel) ? x.hero_carousel : []).slice(0, 12).map(sanitizeSlide),
    sections: list(x.sections), catalogue_sections: list(x.catalogue_sections), demandes_sections: list(x.demandes_sections), status_sections: list(x.status_sections),
    site_theme: sanitizeTheme(x.site_theme), text_overrides: ov,
    hidden_elements: Array.isArray(x.hidden_elements) ? [...new Set(x.hidden_elements.filter((i) => TOGGLEABLE_IDS.includes(i)))] : DEFAULT_HIDDEN.slice(),
  };
}
const DEFAULT_HOMEPAGE = () => sanitizeHomepage({ sections: [{ type: 'carousel', mode: 'hybrid', autoplay_s: 6 }, { type: 'latest_grid', count: 8, filter: 'all' }] });
function loadHomepage() {
  try { return sanitizeHomepage(JSON.parse(fs.readFileSync(HOMEPAGE_FILE, 'utf8'))); }
  catch (err) {
    if (err.code !== 'ENOENT') console.warn('[PS4Store] homepage.json illisible, vitrine par défaut :', err.message);
    const d = DEFAULT_HOMEPAGE();
    try { writeJsonAtomic(HOMEPAGE_FILE, d); } catch (_) {  }
    return d;
  }
}
let homepage = loadHomepage();
const homepageDrafts = new Map();
const slideLive = (sl) => sl.active && (!sl.expires_at || Date.parse(sl.expires_at) > Date.now());
const typeIn = (g, f) => { const t = g.resource_type || 'pkg'; return f === 'all' || (f === 'games' && ['pkg', 'update', 'dlc'].includes(t)) || (f === 'mods' && t === 'plugin') || (f === 'payloads' && t === 'payload'); };
const autoGames = (sec) => [...games].sort(byNewest).filter((g) => typeIn(g, sec.auto_filter)).slice(0, sec.auto_count);

let featuredCache = null;
function featuredMap() {
  if (featuredCache) return featuredCache;
  const m = new Map();
  const add = (id, label) => { if (id && !m.has(id)) m.set(id, { rank: m.size + 1, label }); };
  homepage.sections.filter((x) => x.active).forEach((sec) => {
    if (sec.type === 'carousel') {
      if (sec.mode !== 'auto') homepage.hero_carousel.filter(slideLive).forEach((sl) => add(sl.game_id, sl.badge || 'À la une'));
      if (sec.mode !== 'custom') autoGames(sec).forEach((g) => add(g.id, 'Nouveauté'));
    }
    if (sec.type === 'spotlight_game') add(sec.game_id, sec.badge || 'À la une');
  });
  featuredCache = m;
  return m;
}
const heroText = (g) => String(g.description || '').slice(0, 200);
const heroImage = (g) => (Array.isArray(g.screenshots) && g.screenshots[0]) || g.icon_url || '';
const autoSlide = (g) => ({ id: `auto-${g.id}`, auto: true, badge: 'Nouveauté', title: g.titre, subtitle: heroText(g), image_url: heroImage(g), icon_url: g.icon_url, cta_label: 'Découvrir', cta_url: `/jeu/${g.id}`, accent_color: '#0070D1', sponsored_by: '', game_id: g.id });
function blockWrap(sec) {
  const st = sec.style, sp = sec.space, css = [];
  if (st.bg_color) css.push(`--b-bg:${st.gradient && st.bg_color2 ? `linear-gradient(135deg, ${st.bg_color}, ${st.bg_color2})` : st.bg_color}`);
  if (st.text_color) css.push(`--b-text:${st.text_color}`);
  css.push(`--b-radius:${st.radius}px`, `--b-overlay:${st.overlay / 100}`, `--b-blur:${st.blur}px`);
  [['padding-top', sp.pad_top], ['padding-bottom', sp.pad_bottom], ['margin-top', sp.margin_top], ['margin-bottom', sp.margin_bottom]].forEach(([k, v]) => { if (v != null) css.push(`${k}:${v}px`); });
  return { wrapStyle: css.join(';'), wrapClass: `vt-block al-${st.align} vis-${sp.visibility}${st.glow ? ' glow' : ''}${st.bg_color ? ' has-bg' : ''}` };
}
function vitrineView(hp, which) {
  const sorted = [...games].sort(byNewest);
  const typeGroup = (g) => { const t = g.resource_type || 'pkg'; return t === 'plugin' ? 'mods' : t === 'payload' ? 'payloads' : 'games'; };
  return (hp[which || 'sections'] || []).filter((s) => s.active).map((sec) => {
    const out = { ...sec, ...blockWrap(sec) };
    if (sec.style.accent) out.accent_color = sec.style.accent;
    if (sec.type === 'carousel') {
      const custom = hp.hero_carousel.filter(slideLive).map((sl) => {
        const g = sl.game_id ? gameById(sl.game_id) : null;
        return { ...sl, custom: true, title: sl.title || (g ? g.titre : ''), subtitle: sl.subtitle || (g ? heroText(g) : ''), image_url: sl.image_url || (g ? heroImage(g) : ''),
          cta_url: sl.cta_url || (g ? `/jeu/${g.id}` : '/catalogue'), icon_url: g ? g.icon_url : '' };
      }).filter((sl) => sl.title);
      let slides = sec.mode === 'auto' ? [] : custom;
      if (sec.mode !== 'custom') {
        const used = new Set(slides.map((sl) => sl.game_id).filter(Boolean));
        slides = slides.concat(autoGames(sec).filter((g) => !used.has(g.id)).map(autoSlide));
      }
      out.slides = slides;
    } else if (sec.type === 'collab_banner') {
      out.members = sec.creators.map((name) => {
        const u = users.find((x) => x.username.toLowerCase() === name.toLowerCase());
        return u ? { username: u.username, name: u.display_name || u.username, avatar: avatarUrl(u), url: `/membre/${encodeURIComponent(u.username)}` } : null;
      }).filter(Boolean);
      out.image_url = sec.image_url || sec.style.bg_image;
    } else if (sec.type === 'spotlight_game') {
      const g = sec.game_id ? gameById(sec.game_id) : null;
      if (!g && !sec.title) return null;
      out.game = g ? publicGameCard(g) : null;
      out.title = sec.title || (g ? g.titre : '');
      out.description = sec.description || (g ? heroText(g) : '');
      out.image_url = sec.image_url || sec.style.bg_image || (g ? heroImage(g) : '');
    } else if (sec.type === 'cta_banner') {
      out.image_url = sec.style.bg_image;
    } else if (sec.type === 'video') {
      out.yt = sec.url ? extractYoutubeId(sec.url) : null;
    } else if (sec.type === 'discord_invite') {
      const w = sec.guild_id ? discordWidget(sec.guild_id) : null;
      out.online = w && Number.isFinite(w.presence_count) ? w.presence_count : null;
      out.channelNames = sec.channels.length ? sec.channels : (w && Array.isArray(w.channels) ? w.channels.slice(0, 5).map((c) => c.name) : []);
      out.invite = sec.invite_url || (w && w.instant_invite) || '';
    } else if (sec.type === 'top_creators') {
      const counts = new Map(); games.forEach((g) => counts.set(g.author_id, (counts.get(g.author_id) || 0) + 1));
      const view = (u) => ({ username: u.username, name: u.display_name || u.username, avatar: avatarUrl(u), bio: u.bio || '', resources: counts.get(u.id) || 0, url: `/membre/${encodeURIComponent(u.username)}` });
      out.members = sec.mode === 'manual'
        ? sec.creators.map((n) => users.find((u) => u.username.toLowerCase() === n.toLowerCase())).filter(Boolean).map(view)
        : users.filter((u) => counts.get(u.id)).sort((a, b) => (counts.get(b.id) - counts.get(a.id)) || (b.followers.length - a.followers.length) || String(a.created_at).localeCompare(String(b.created_at))).slice(0, sec.count).map(view);
    } else if (sec.type === 'latest_grid') {
      const keep = new Set();
      if (sec.filter === 'all') { sorted.slice(0, sec.count).forEach((g) => keep.add(g.id)); ['games', 'mods', 'payloads'].forEach((k) => sorted.filter((g) => typeGroup(g) === k).slice(0, sec.count).forEach((g) => keep.add(g.id))); }
      else sorted.filter((g) => typeGroup(g) === sec.filter).slice(0, sec.count).forEach((g) => keep.add(g.id));
      out.games = sorted.filter((g) => keep.has(g.id)).map(publicGameCard);
    }
    return out;
  }).filter(Boolean);
}
app.post('/dashboard/homepage/preview', requireAdmin, requireCsrf, jsonBig, (req, res) => {
  homepageDrafts.set(req.admin.id, { hp: sanitizeHomepage(req.body), at: Date.now() });
  if (homepageDrafts.size > 50) homepageDrafts.delete(homepageDrafts.keys().next().value);
  res.json({ ok: true });
});
app.post('/dashboard/homepage', requireAdmin, requireCsrf, jsonBig, (req, res) => {
  try {
    const hp = sanitizeHomepage(req.body);
    writeJsonAtomic(HOMEPAGE_FILE, hp);
    homepage = hp; featuredCache = null;
    homepageDrafts.delete(req.admin.id);
    res.json({ ok: true, homepage: hp });
  } catch (err) { res.status(500).json({ erreur: "Impossible d'enregistrer la vitrine." }); }
});
const BANNER_DIR = path.join(__dirname, 'public', 'uploads', 'banners');
try { fs.mkdirSync(BANNER_DIR, { recursive: true }); } catch (_) {  }
app.post('/dashboard/homepage/banner', requireAdmin, requireCsrf, async (req, res) => {
  try {
    const buf = await readBodyLimited(req, 2.5 * 1024 * 1024);
    const png = buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const jpg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (!png && !jpg) return res.status(400).json({ erreur: 'Image invalide : JPEG ou PNG attendu.' });
    const name = `${hid()}${hid()}.${png ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(BANNER_DIR, name), buf);
    res.json({ ok: true, url: `/uploads/banners/${name}` });
  } catch (err) { res.status(err && err.code === 'TOO_BIG' ? 413 : 400).json({ erreur: 'Image trop volumineuse ou envoi interrompu.' }); }
});

const requireBot = (req, res, next) => {
  const secret = String(process.env.BOT_API_SECRET || '');
  if (secret.length < 8) return res.status(503).json({ erreur: 'BOT_API_SECRET non configuré sur le serveur (8 caractères minimum).' });
  const given = req.get('X-Bot-Secret');
  if (typeof given !== 'string' || !safeEqual(given, secret)) return res.status(401).json({ erreur: 'Secret du bot invalide.' });
  res.setHeader('Cache-Control', 'no-store');
  botSeenAt = Date.now();
  next();
};
let botSeenAt = 0;
const botGame = (g) => ({
  id: g.id, title_id: g.title_id, titre: g.titre, version: g.version, size: g.size, firmware_min: g.firmware_min, categorie: g.categorie,
  resource_type: g.resource_type || 'pkg', icon_url: g.icon_url && g.icon_url.startsWith('/') ? `${discordSettings().site || `http://127.0.0.1:${PORT}`}${g.icon_url}` : (g.icon_url || ''),
  description: String(g.description || '').slice(0, 400), author_name: g.author_name || '', updated_at: g.updated_at || g.created_at,
  url: `${discordSettings().site || `http://127.0.0.1:${PORT}`}/jeu/${g.id}`,
});
const botNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function botFind(q) {
  const n = botNorm(q).trim();
  if (!n) return null;
  return games.find((g) => g.id === q || botNorm(g.title_id) === n) || games.find((g) => botNorm(g.titre) === n) || games.find((g) => botNorm(g.titre).includes(n)) || null;
}
const botUser = (discordId) => (/^\d{5,25}$/.test(String(discordId || '')) ? users.find((u) => u.discord_id === String(discordId)) : null);

app.get('/api/bot/catalogue', requireBot, (req, res) => {
  const q = botNorm(req.query.q).trim(), type = String(req.query.type || '');
  let list = games.filter((g) => (!type || (g.resource_type || 'pkg') === type) && (!q || botNorm(g.titre).includes(q) || botNorm(g.title_id).includes(q)));
  list = list.slice().sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
  res.json({ total: list.length, games: list.slice(0, limit).map(botGame) });
});
app.get('/api/bot/game', requireBot, (req, res) => {
  const g = botFind(String(req.query.q || ''));
  if (!g) return res.status(404).json({ erreur: 'Aucune ressource trouvée.' });
  res.json(botGame(g));
});
app.post('/api/bot/download', requireBot, jsonSmall, (req, res) => {
  const b = req.body || {};
  const u = botUser(b.discord_id);
  if (!u) return res.status(404).json({ code: 'not_linked', erreur: "Ce compte Discord n'est lié à aucun compte PS4Store." });
  if (!u.paired_consoles.length) return res.status(409).json({ code: 'no_console', erreur: "Aucune PS4 n'est liée à ce compte." });
  const g = botFind(String(b.q || ''));
  if (!g) return res.status(404).json({ code: 'not_found', erreur: 'Ressource introuvable.' });
  if (!u.remote_queue.some((x) => x.game_id === g.id && x.status === 'pending')) {
    u.remote_queue.push({ queue_id: crypto.randomUUID(), game_id: g.id, status: 'pending', created_at: new Date().toISOString() });
    saveUsers();
  }
  res.json({ ok: true, game: botGame(g) });
});
app.get('/api/bot/console/:discordId', requireBot, (req, res) => {
  const u = botUser(req.params.discordId);
  if (!u) return res.status(404).json({ code: 'not_linked', erreur: "Ce compte Discord n'est lié à aucun compte PS4Store." });
  const now = Date.now();
  res.json({
    username: u.username, pending: u.remote_queue.filter((q) => q.status === 'pending').length,
    consoles: u.paired_consoles.map((c) => {
      const st = consoleStatus.get(c.id) || null;
      return {
        name: c.name, online: !!st && now - st.at < ONLINE_MS, last_seen: st ? new Date(st.at).toISOString() : c.last_seen,
        app_version: st ? st.app_version : '', disk_free: st ? st.disk_free : 0, disk_total: st ? st.disk_total : 0,
        installed_count: st ? st.installed.length : 0, playing: playingActive(st) ? st.playing : null,
      };
    }),
  });
});
app.get('/api/bot/version', requireBot, (req, res) => {
  const r = currentRelease();
  if (!r) return res.status(404).json({ erreur: 'PS4Store.pkg est absent du serveur.' });
  const site = discordSettings().site || `http://127.0.0.1:${PORT}`;
  res.json({ version: r.version, size: r.file_size, changelog: r.changelog, updated_at: r.updated_at, site, pkg_url: `${site}${r.pkg_url}` });
});
app.get('/api/bot/stats', requireBot, (req, res) => {
  const count = (t) => games.filter((g) => (g.resource_type || 'pkg') === t).length;
  const r = currentRelease();
  const now = Date.now();
  res.json({
    games: games.length, pkg: count('pkg'), mods: count('plugin'), payloads: count('payload'), members: users.length,
    consoles: users.reduce((n, u) => n + u.paired_consoles.length, 0),
    online: [...consoleStatus.values()].filter((s) => now - s.at < ONLINE_MS).length,
    pending_submissions: submissions.filter((x) => x.status === 'pending').length, client_version: r ? r.version : '', site: discordSettings().site || '',
  });
});
const botSite = () => discordSettings().site || `http://127.0.0.1:${PORT}`;
app.get('/api/bot/user/:discordId', requireBot, (req, res) => {
  const u = botUser(req.params.discordId);
  if (!u) return res.status(404).json({ code: 'not_linked', erreur: "Ce compte Discord n'est lié à aucun compte PS4Store." });
  res.json({
    username: u.username, display_name: u.display_name || u.username, role: u.role, badges: badgesOf(u),
    resources: games.filter((g) => g.author_id === u.id).length,
    library: u.public_library ? u.library.length : null,
    playing: u.public_activity ? activeGameOf(u) : null,
    followers: u.followers.length, created_at: u.created_at, site: botSite(), url: `${botSite()}/membre/${encodeURIComponent(u.username)}`,
  });
});
app.get('/api/bot/collections', requireBot, (req, res) => {
  res.json({
    site: botSite(),
    collections: collections.filter((c) => c.featured).map((c) => {
      const items = c.game_ids.map(gameById).filter(Boolean);
      return { id: c.id, title: c.title, badge: c.badge, description: c.description, games: items.map((g) => g.titre), count: items.length };
    }).filter((c) => c.count > 0),
  });
});
app.get('/api/bot/requests', requireBot, (req, res) => {
  const n = Math.min(Math.max(Number(req.query.limit) || 5, 1), 10);
  res.json(sortRequests(requests.filter((r) => r.status === 'open')).slice(0, n).map((r) => requestView(r, '')));
});
app.get('/api/bot/status', requireBot, (req, res) => {
  const v = statusView('fr', (k) => k);
  res.json({ overall: v.overall, checked_at: v.checkedAt, site: botSite(), services: v.services.map((x) => ({ key: x.key, state: x.last, ms: x.ms, avail: x.avail })) });
});
app.get('/api/bot/recap', requireBot, (req, res) => {
  const cutoff = Date.now() - 7 * 86400000, after = (d) => Date.parse(d) >= cutoff;
  const fresh = games.filter((g) => after(g.created_at));
  res.json({
    site: botSite(),
    new_resources: fresh.slice(-10).reverse().map((g) => ({ titre: g.titre, version: g.version, type: g.resource_type || 'pkg', url: `${botSite()}/jeu/${g.id}` })),
    new_count: fresh.length, updated_count: games.filter((g) => !after(g.created_at) && after(g.updated_at)).length,
    downloads_total: games.reduce((n, g) => n + (g.downloads_count || 0), 0), resources_total: games.length,
    new_members: users.filter((u) => after(u.created_at)).length, members_total: users.length,
    top_requests: sortRequests(requests.filter((r) => r.status === 'open')).slice(0, 3).map((r) => requestView(r, '')),
  });
});
app.get('/api/bot/submissions', requireBot, (req, res) => {
  res.json(submissions.filter((x) => x.status === 'pending').slice(-25).reverse().map((x) => ({
    id: x.id, titre: x.game.titre, version: x.game.version, resource_type: x.game.resource_type || 'pkg', by: x.submitted_by_name, created_at: x.created_at,
  })));
});
app.post('/api/bot/submissions/:id/approve', requireBot, jsonSmall, async (req, res, next) => {
  try {
    const sub = submissions.find((x) => x.id === req.params.id && x.status === 'pending');
    if (!sub) return res.status(404).json({ erreur: "Cette proposition n'existe plus ou a déjà été traitée." });
    const value = { ...sub.game };
    if (titleConflict(value, '')) {
      if (/^(BREW|PLUG|PAYL)\d{5}$/.test(value.title_id)) value.title_id = generateTitleId(value.title_id.slice(0, 4));
      if (titleConflict(value, '')) return res.status(409).json({ erreur: 'Ce Title ID ou cette version existe déjà dans le catalogue.' });
    }
    const member = users.find((u) => u.id === sub.submitted_by);
    const fallbackAdmin = users.find((u) => u.role === 'superadmin') || users.find((u) => u.role === 'admin') || {};
    const now = new Date().toISOString();
    const game = {
      id: crypto.randomUUID(), ...value, changelog: sanitizeChangelog(value.changelog),
      author_id: member ? member.id : (fallbackAdmin.id || ''), author_name: member ? (member.display_name || member.username) : sub.submitted_by_name,
      author_username: member ? member.username : '', created_at: now, updated_at: now,
    };
    games.push(game);
    await gamesStore.save(games);
    Object.assign(sub, { status: 'approved', reviewed_at: now, reviewed_by: `discord:${String((req.body && req.body.moderator_id) || '').replace(/\D/g, '').slice(0, 25)}`, game_id: game.id });
    saveSubmissions();
    const webhook = !!discordSettings().url;
    if (webhook) notifyDiscordGame(game, discordSettings().site || `http://127.0.0.1:${PORT}`);
    res.json({ ok: true, game: botGame(game), announced_by_webhook: webhook });
  } catch (err) { next(err); }
});

const gameById = (id) => games.find((g) => g.id === id);
function fwStats(g) {
  const v = g.firmware_votes || {};
  const issue = (v.issue || []).length;
  const one = (k) => { const ok = (v[k] || []).length; const total = ok + issue; return { key: k, votes: ok, pct: total ? Math.round((ok / total) * 100) : null }; };
  return { fw: [one('9.00'), one('11.00')], issue, total: (v['9.00'] || []).length + (v['11.00'] || []).length + issue };
}
const myFwVote = (g, uid) => FW_VOTE_KEYS.find((k) => ((g.firmware_votes || {})[k] || []).includes(uid)) || '';
function userHasInstalled(user, titleId) {
  if (!user || !titleId) return false;
  return user.paired_consoles.some((c) => { const st = consoleStatus.get(c.id); return !!st && st.installed.some((i) => i.title_id === titleId); });
}
function communityView(g, req) {
  const me = req.user, isAdmin = !!req.admin;
  const list = (g.comments || []).slice().reverse().slice(0, 100).map((c) => {
    const author = users.find((u) => u.id === c.user_id);
    return {
      id: c.id, username: c.username, avatar_url: author ? avatarUrl(author) : c.avatar_url, content: c.content, created_at: c.created_at,
      badges: badgesOf(author), verified: !!c.verified_ps4 || userHasInstalled(author, g.title_id), profile: author ? `/membre/${encodeURIComponent(author.username)}` : '',
      canDelete: isAdmin || (!!me && me.id === c.user_id),
    };
  });
  return { downloads: g.downloads_count || 0, fw: fwStats(g), mine: me ? myFwVote(g, me.id) : '', comments: list, count: (g.comments || []).length };
}

app.post('/api/games/:id/fw-vote', requireUserApi, requireCsrf, async (req, res, next) => {
  try {
    const g = gameById(req.params.id);
    if (!g) return res.status(404).json({ erreur: 'Jeu introuvable.' });
    const value = String((req.body || {}).value || '');
    if (!FW_VOTE_KEYS.includes(value)) return res.status(400).json({ erreur: 'Vote invalide.' });
    ensureCommunity(g);
    const uid = req.user.id, previous = myFwVote(g, uid);
    FW_VOTE_KEYS.forEach((k) => { g.firmware_votes[k] = g.firmware_votes[k].filter((id) => id !== uid); });
    if (previous !== value) g.firmware_votes[value].push(uid);
    await gamesStore.save(games);
    res.json({ ok: true, mine: previous === value ? '' : value, stats: fwStats(g) });
  } catch (err) { next(err); }
});

const COMMENT_MAX = 600, MAX_COMMENTS_PER_GAME = 300;
const lastCommentAt = new Map();
app.post('/api/games/:id/comments', requireUserApi, requireCsrf, async (req, res, next) => {
  try {
    const g = gameById(req.params.id);
    if (!g) return res.status(404).json({ erreur: 'Jeu introuvable.' });
    const content = String((req.body || {}).content || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (content.length < 2 || content.length > COMMENT_MAX) return res.status(400).json({ erreur: `Le commentaire doit faire entre 2 et ${COMMENT_MAX} caractères.` });
    if (Date.now() - (lastCommentAt.get(req.user.id) || 0) < 15000) return res.status(429).json({ erreur: 'Patientez quelques secondes avant de commenter à nouveau.' });
    lastCommentAt.set(req.user.id, Date.now());
    ensureCommunity(g);
    g.comments.push({
      id: crypto.randomUUID(), user_id: req.user.id, username: req.user.username, avatar_url: avatarUrl(req.user),
      verified_ps4: userHasInstalled(req.user, g.title_id), content, created_at: new Date().toISOString(),
    });
    if (g.comments.length > MAX_COMMENTS_PER_GAME) g.comments.splice(0, g.comments.length - MAX_COMMENTS_PER_GAME);
    await gamesStore.save(games);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});
app.delete('/api/games/:id/comments/:commentId', requireCsrf, async (req, res, next) => {
  try {
    if (!req.user && !req.admin) return res.status(401).json({ erreur: 'Connectez-vous pour utiliser cette fonction.' });
    const g = gameById(req.params.id);
    if (!g) return res.status(404).json({ erreur: 'Jeu introuvable.' });
    const i = (g.comments || []).findIndex((c) => c.id === req.params.commentId);
    if (i === -1) return res.status(404).json({ erreur: 'Commentaire introuvable.' });
    if (!req.admin && g.comments[i].user_id !== req.user.id) return res.status(403).json({ erreur: 'Vous ne pouvez supprimer que vos commentaires.' });
    g.comments.splice(i, 1);
    await gamesStore.save(games);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
const collectionsStore = createStore(COLLECTIONS_FILE);
let collections = (collectionsStore.loadSync() || []).filter((c) => c && c.id && c.title).map((c) => ({
  id: String(c.id), title: String(c.title).slice(0, 60), description: String(c.description || '').slice(0, 200), badge: String(c.badge || '').slice(0, 20),
  game_ids: strList(c.game_ids), featured: c.featured === true, author_id: String(c.author_id || ''), created_at: String(c.created_at || new Date().toISOString()),
}));
const saveCollections = () => collectionsStore.save(collections);
function featuredCollections() {
  return collections.filter((c) => c.featured).map((c) => {
    const items = c.game_ids.map(gameById).filter(Boolean);
    return { id: c.id, title: c.title, description: c.description, badge: c.badge, count: items.length, ids: items.map((g) => g.id), covers: items.slice(0, 4).map((g) => g.icon_url) };
  }).filter((c) => c.count > 0);
}
function parseCollection(body) {
  const str = (k) => (typeof body[k] === 'string' ? body[k].trim() : '');
  let ids = body.game_ids;
  ids = Array.isArray(ids) ? ids : (typeof ids === 'string' && ids ? [ids] : []);
  const value = {
    title: str('title'), description: str('description'), badge: str('badge'),
    game_ids: [...new Set(ids.filter((id) => typeof id === 'string' && gameById(id)))].slice(0, 60),
    featured: body.featured === '1' || body.featured === 'on',
  };
  const errors = [];
  if (value.title.length < 2 || value.title.length > 60) errors.push('Le titre de la collection doit faire entre 2 et 60 caractères.');
  if (value.description.length > 200) errors.push('La description est limitée à 200 caractères.');
  if (value.badge.length > 20) errors.push('Le badge est limité à 20 caractères.');
  if (!value.game_ids.length) errors.push('Sélectionnez au moins une ressource.');
  return { value, errors };
}
app.post('/dashboard/collections', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const { value, errors } = parseCollection(req.body);
    if (errors.length) { setFlash(req, 'error', errors.join(' ')); return res.redirect('/dashboard#collections'); }
    collections.push({ id: crypto.randomUUID(), ...value, author_id: req.admin.id, created_at: new Date().toISOString() });
    await saveCollections();
    setFlash(req, 'success', `Collection « ${value.title} » créée.`);
    res.redirect('/dashboard#collections');
  } catch (err) { next(err); }
});
app.post('/dashboard/collections/:id', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const c = collections.find((x) => x.id === req.params.id);
    if (!c) { setFlash(req, 'error', "Cette collection n'existe plus."); return res.redirect('/dashboard#collections'); }
    const { value, errors } = parseCollection(req.body);
    if (errors.length) { setFlash(req, 'error', errors.join(' ')); return res.redirect('/dashboard#collections'); }
    Object.assign(c, value);
    await saveCollections();
    setFlash(req, 'success', `Collection « ${value.title} » mise à jour.`);
    res.redirect('/dashboard#collections');
  } catch (err) { next(err); }
});
app.post('/dashboard/collections/:id/delete', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const before = collections.length;
    collections = collections.filter((x) => x.id !== req.params.id);
    if (collections.length !== before) await saveCollections();
    setFlash(req, 'success', 'Collection supprimée.');
    res.redirect('/dashboard#collections');
  } catch (err) { next(err); }
});

const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const requestsStore = createStore(REQUESTS_FILE);
const REQUEST_TYPES = ['pkg', 'plugin', 'payload'];
let requests = (requestsStore.loadSync() || []).filter((r) => r && r.id && r.title).map((r) => ({
  id: String(r.id), title: String(r.title).slice(0, 80), title_id: /^[A-Z]{4}\d{5}$/.test(String(r.title_id || '')) ? r.title_id : '',
  resource_type: REQUEST_TYPES.includes(r.resource_type) ? r.resource_type : 'pkg', notes: String(r.notes || '').slice(0, 300),
  author_id: String(r.author_id || ''), author_name: String(r.author_name || '').slice(0, 40), votes: strList(r.votes),
  status: ['open', 'fulfilled', 'rejected'].includes(r.status) ? r.status : 'open', linked_game_id: r.linked_game_id ? String(r.linked_game_id) : null,
  created_at: String(r.created_at || new Date().toISOString()),
}));
const saveRequests = () => requestsStore.save(requests);
const MAX_OPEN_REQUESTS_PER_USER = 5;
function requestView(r, voterId) {
  const g = r.linked_game_id ? gameById(r.linked_game_id) : null;
  return {
    id: r.id, title: r.title, title_id: r.title_id, resource_type: r.resource_type, notes: r.notes, author_name: r.author_name,
    votes: r.votes.length, voted: !!voterId && r.votes.includes(voterId), status: r.status, created_at: r.created_at,
    linked: g ? { id: g.id, titre: g.titre } : null,
  };
}
function requestActor(req, res, next) {
  const given = req.get('X-Bot-Secret');
  if (given !== undefined) {
    const secret = String(process.env.BOT_API_SECRET || '');
    if (secret.length < 8) return res.status(503).json({ erreur: 'BOT_API_SECRET non configuré sur le serveur.' });
    if (!safeEqual(given, secret)) return res.status(401).json({ erreur: 'Secret du bot invalide.' });
    const did = String((req.body || {}).discord_id || '').replace(/\D/g, '');
    if (!/^\d{5,25}$/.test(did)) return res.status(400).json({ erreur: 'discord_id requis.' });
    const u = users.find((x) => x.discord_id === did);
    req.actor = u ? { id: u.id, name: u.username } : { id: `discord:${did}`, name: short((req.body || {}).author_name || 'Discord', 40) || 'Discord' };
    return next();
  }
  if (!req.user) return res.status(401).json({ erreur: 'Connectez-vous pour utiliser cette fonction.' });
  requireCsrf(req, res, () => { req.actor = { id: req.user.id, name: req.user.username }; next(); });
}
const reqFold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sortRequests = (list) => list.slice().sort((a, b) => (b.votes.length - a.votes.length) || String(b.created_at).localeCompare(String(a.created_at)));

app.get('/demandes', (req, res) => {
  const uid = req.user ? req.user.id : '';
  res.render('requests', {
    open: sortRequests(requests.filter((r) => r.status === 'open')).map((r) => requestView(r, uid)),
    done: requests.filter((r) => r.status === 'fulfilled').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12).map((r) => requestView(r, uid)),
    mine: req.user ? requests.filter((r) => r.status === 'open' && r.author_id === req.user.id).length : 0, maxOpen: MAX_OPEN_REQUESTS_PER_USER,
  });
});
app.get('/api/requests', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const status = ['open', 'fulfilled', 'rejected'].includes(req.query.status) ? req.query.status : 'open';
  res.json(sortRequests(requests.filter((r) => r.status === status)).slice(0, 100).map((r) => requestView(r, req.user ? req.user.id : '')));
});
app.post('/api/requests', requestActor, async (req, res, next) => {
  try {
    const b = req.body || {}, str = (k, n) => short(b[k], n).trim();
    const title = str('title', 80), notes = str('notes', 300), titleId = str('title_id', 9).toUpperCase();
    const type = REQUEST_TYPES.includes(b.resource_type) ? b.resource_type : 'pkg';
    if (title.length < 2) return res.status(400).json({ erreur: 'Indiquez le nom de la ressource demandée.' });
    if (titleId && !/^[A-Z]{4}\d{5}$/.test(titleId)) return res.status(400).json({ erreur: 'Title ID invalide (ex. CUSA12345).' });
    const dup = requests.find((r) => r.status === 'open' && (reqFold(r.title) === reqFold(title) || (titleId && r.title_id === titleId)));
    if (dup) return res.status(409).json({ erreur: 'Cette demande existe déjà : votez pour elle.', request: requestView(dup, req.actor.id) });
    if (requests.filter((r) => r.status === 'open' && r.author_id === req.actor.id).length >= MAX_OPEN_REQUESTS_PER_USER) {
      return res.status(429).json({ erreur: `Vous avez déjà ${MAX_OPEN_REQUESTS_PER_USER} demandes ouvertes.` });
    }
    const r = {
      id: crypto.randomUUID(), title, title_id: titleId, resource_type: type, notes, author_id: req.actor.id, author_name: req.actor.name,
      votes: [req.actor.id], status: 'open', linked_game_id: null, created_at: new Date().toISOString(),
    };
    requests.push(r);
    await saveRequests();
    res.status(201).json({ ok: true, request: requestView(r, req.actor.id) });
  } catch (err) { next(err); }
});
app.post('/api/requests/:id/vote', requestActor, async (req, res, next) => {
  try {
    const r = requests.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ erreur: 'Demande introuvable.' });
    if (r.status !== 'open') return res.status(409).json({ erreur: "Cette demande n'est plus ouverte." });
    const i = r.votes.indexOf(req.actor.id);
    if (i === -1) r.votes.push(req.actor.id); else r.votes.splice(i, 1);
    await saveRequests();
    res.json({ ok: true, votes: r.votes.length, voted: i === -1 });
  } catch (err) { next(err); }
});
app.post('/dashboard/requests/:id/fulfill', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const r = requests.find((x) => x.id === req.params.id && x.status === 'open');
    const g = gameById(String(req.body.game_id || ''));
    if (!r) setFlash(req, 'error', "Cette demande n'existe plus ou est déjà traitée.");
    else if (!g) setFlash(req, 'error', 'Choisissez la ressource publiée qui répond à la demande.');
    else {
      Object.assign(r, { status: 'fulfilled', linked_game_id: g.id });
      await saveRequests();
      setFlash(req, 'success', `Demande « ${r.title} » associée à « ${g.titre} ».`);
    }
    res.redirect('/dashboard#demandes');
  } catch (err) { next(err); }
});
app.post('/dashboard/requests/:id/reject', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const r = requests.find((x) => x.id === req.params.id && x.status === 'open');
    if (r) { r.status = 'rejected'; await saveRequests(); setFlash(req, 'success', `Demande « ${r.title} » fermée.`); }
    else setFlash(req, 'error', "Cette demande n'existe plus ou est déjà traitée.");
    res.redirect('/dashboard#demandes');
  } catch (err) { next(err); }
});

const LINK_CHECK_TIMEOUT_MS = 5000;
let linkCheckRunning = false;
let lastLinkRun = null;
const brokenLink = (g) => !!(g.link_check && g.link_check.url === g.pkg_url && g.link_check.ok === false);

async function headStatus(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const opts = (method, extra) => ({ method, redirect: 'manual', signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS), headers: { 'User-Agent': BROWSER_UA, ...extra } });
    let r = await fetch(u, opts('HEAD'));
    if (r.status === 405 || r.status === 501) { r.body && r.body.cancel().catch(() => {}); r = await fetch(u, opts('GET', { Range: 'bytes=0-0' })); }
    if (r.body) r.body.cancel().catch(() => {});
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) return r.status;
      current = new URL(loc, u).href;
      continue;
    }
    return r.status;
  }
  return 310;
}
async function checkGameLink(g) {
  const base = { url: g.pkg_url, checked_at: new Date().toISOString() };
  try {
    const status = await headStatus(g.pkg_url);
    const ok = status >= 200 && status < 300;
    return { ...base, ok, status, error: ok ? '' : `HTTP ${status}` };
  } catch (err) {
    if (err instanceof LinkError && err.message === PRIVATE_MSG) return { ...base, ok: true, status: 0, error: '', skipped: true };
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { ...base, ok: false, status: 0, error: 'Délai dépassé (5 s)' };
    return { ...base, ok: false, status: 0, error: err instanceof LinkError ? err.message : 'Hébergeur injoignable' };
  }
}
async function runLinkCheck() {
  if (linkCheckRunning) return null;
  linkCheckRunning = true;
  try {
    const list = games.slice(), fresh = [];
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const g = list[next++];
        if (!g.pkg_url) continue;
        const prev = g.link_check, result = await checkGameLink(g);
        const cur = games.find((x) => x.id === g.id);
        if (!cur || cur.pkg_url !== g.pkg_url) continue;
        cur.link_check = result;
        if (!result.ok && !(prev && prev.url === result.url && prev.ok === false)) fresh.push(cur);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await gamesStore.save(games);
    lastLinkRun = { at: new Date().toISOString(), checked: list.length, broken: games.filter(brokenLink).length };
    if (fresh.length) {
      const site = discordSettings().site || '';
      postDiscord({
        title: '⚠️ Lien(s) de téléchargement hors service', color: 0xE74C3C,
        description: fresh.slice(0, 15).map((g) => `• **${clip(g.titre, 60)}** (\`${g.title_id}\`) — ${g.link_check.error}`).join('\n') + (fresh.length > 15 ? `\n… et ${fresh.length - 15} autre(s)` : ''),
        footer: { text: 'Vérification automatique des liens' }, ...(site ? { url: `${site}/dashboard` } : {}),
      }, site);
    }
    return lastLinkRun;
  } finally { linkCheckRunning = false; }
}
function startLinkChecker() {
  const run = () => runLinkCheck().catch((e) => console.warn('[PS4Store] vérification des liens :', e.message));
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, 6 * 3600 * 1000).unref();
}
app.post('/dashboard/check-all-links', requireAdmin, requireCsrf, (req, res) => {
  if (linkCheckRunning) setFlash(req, 'success', 'Une vérification est déjà en cours : rechargez la page dans un instant.');
  else {
    runLinkCheck().catch((e) => console.warn('[PS4Store] vérification des liens :', e.message));
    setFlash(req, 'success', 'Vérification des liens lancée. Les résultats apparaissent dans la liste dans quelques instants.');
  }
  res.redirect('/dashboard#jeux');
});

app.get('/api/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = currentRelease();
  res.json({ ok: true, uptime: Math.round(process.uptime()), games: games.length, client_version: r ? r.version : '', time: new Date().toISOString() });
});
const UPTIME_FILE = path.join(DATA_DIR, 'uptime.json');
const UPTIME_DAYS = 30;
const UPTIME_SERVICES = ['web', 'console_api', 'dl_proxy', 'discord_oauth', 'discord_bot'];
let uptime = (() => {
  try { const j = JSON.parse(fs.readFileSync(UPTIME_FILE, 'utf8')); if (j && typeof j === 'object') return { days: j.days && typeof j.days === 'object' ? j.days : {}, last: j.last && typeof j.last === 'object' ? j.last : {} }; } catch (_) {  }
  return { days: {}, last: {} };
})();
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
function recordUptime(service, state, ms) {
  const now = Date.now(), day = (uptime.days[dayKey(now)] = uptime.days[dayKey(now)] || {});
  const c = (day[service] = day[service] || { ok: 0, deg: 0, out: 0, ms: 0, n: 0 });
  if (state === 'operational') c.ok++; else if (state === 'degraded') c.deg++; else c.out++;
  if (ms != null && state !== 'outage') { c.ms += ms; c.n++; }
  uptime.last[service] = { state, ms: ms == null ? null : ms, at: new Date(now).toISOString() };
}
async function uptimeCheckAll(base) {
  const timed = async (fn) => { const t = Date.now(); try { return { ...(await fn()), ms: Date.now() - t }; } catch (_) { return { state: 'outage', ms: Date.now() - t }; } };
  const get = (p, o) => fetch(base + p, { signal: AbortSignal.timeout(8000), redirect: 'manual', ...(o || {}) });
  const slow = (ms, lim) => (ms > lim ? 'degraded' : 'operational');
  const web = await timed(async () => { const r = await get('/api/status'); return { state: r.ok ? 'ok' : 'outage' }; });
  recordUptime('web', web.state === 'ok' ? slow(web.ms, 1500) : 'outage', web.ms);
  const api = await timed(async () => { const r = await get('/api/games'); await r.arrayBuffer(); return { state: r.ok ? 'ok' : 'outage' }; });
  recordUptime('console_api', api.state === 'ok' ? slow(api.ms, 2000) : 'outage', api.ms);
  const g = games.find((x) => x.pkg_url && isPlainPkgUrl(x.pkg_url)) || games.find((x) => x.pkg_url);
  if (g) {
    const dl = await timed(async () => { const r = await get(`/dl/${encodeURIComponent(g.id)}/${encodeURIComponent(g.title_id)}${resourceExt(g)}`, { method: 'HEAD' }); return { state: r.status < 400 ? 'ok' : r.status >= 500 ? 'degraded' : 'outage' }; });
    recordUptime('dl_proxy', dl.state === 'ok' ? slow(dl.ms, 4000) : dl.state, dl.ms);
  } else uptime.last.dl_proxy = { state: 'unconfigured', ms: null, at: new Date().toISOString() };
  if (discordConfigured()) {
    const d = await timed(async () => { const r = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(6000) }); await r.arrayBuffer(); return { state: r.ok ? 'ok' : 'outage' }; });
    recordUptime('discord_oauth', d.state === 'ok' ? slow(d.ms, 2500) : 'outage', d.ms);
  } else uptime.last.discord_oauth = { state: 'unconfigured', ms: null, at: new Date().toISOString() };
  if (String(process.env.BOT_API_SECRET || '').length >= 8) {
    const age = botSeenAt ? Date.now() - botSeenAt : Infinity;
    if (botSeenAt || process.uptime() > 240) recordUptime('discord_bot', age < 180000 ? 'operational' : age < 600000 ? 'degraded' : 'outage', null);
  } else uptime.last.discord_bot = { state: 'unconfigured', ms: null, at: new Date().toISOString() };
  const keep = new Set(); for (let i = 0; i < UPTIME_DAYS; i++) keep.add(dayKey(Date.now() - i * 86400000));
  Object.keys(uptime.days).forEach((k) => { if (!keep.has(k)) delete uptime.days[k]; });
  uptime.checked_at = new Date().toISOString();
  try { writeJsonAtomic(UPTIME_FILE, uptime); } catch (e) { console.warn('[PS4Store] uptime.json :', e.message); }
}
function startUptimeChecker(base) {
  const run = () => uptimeCheckAll(base).catch((e) => console.warn('[PS4Store] vérification des services :', e.message));
  setTimeout(run, 3000).unref();
  setInterval(run, 5 * 60 * 1000).unref();
}
function statusView(lang, t) {
  const services = UPTIME_SERVICES.map((key) => {
    const days = [];
    let total = 0, down = 0;
    for (let i = UPTIME_DAYS - 1; i >= 0; i--) {
      const date = dayKey(Date.now() - i * 86400000), c = (uptime.days[date] || {})[key];
      if (!c) { days.push({ date, state: 'none', tip: `${formatDate(lang, date)} · ${t('status.nodata')}` }); continue; }
      const n = c.ok + c.deg + c.out, dn = c.out / n, dg = c.deg / n;
      const state = dn >= 0.05 ? 'outage' : (dn > 0 || dg >= 0.05) ? 'degraded' : 'operational';
      const pct = Math.round((1 - dn) * 1000) / 10, ms = c.n ? Math.round(c.ms / c.n) : null;
      total += n; down += c.out;
      days.push({ date, state, tip: `${formatDate(lang, date)} · ${t('status.' + state)} · ${String(pct).replace('.', lang === 'en' ? '.' : ',')} %${ms != null ? ` · ${ms} ms` : ''}` });
    }
    const last = uptime.last[key] || null;
    return { key, last: last ? last.state : 'checking', ms: last ? last.ms : null, days, avail: total ? Math.round((1 - down / total) * 10000) / 100 : null };
  });
  const live = services.filter((x) => x.last !== 'unconfigured' && x.last !== 'checking');
  const overall = !live.length ? 'checking' : live.some((x) => x.last === 'outage') ? 'outage' : live.some((x) => x.last === 'degraded') ? 'degraded' : 'operational';
  return { services, overall, checkedAt: uptime.checked_at || '' };
}
app.get(['/aide', '/status'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.render('help', { release: releaseView(), storePkg: storePackageInfo(), status: statusView(req.lang, (k) => translate(req.lang, k)) });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path === '/dashboard/fetch-media') return res.status(404).json({ erreur: 'Introuvable' });
  notFound(res, 'notfound.page', '/', 'notfound.back.home');
});

app.use((err, req, res, _next) => {
  console.error('[PS4Store] Erreur :', err);
  if (req.path.startsWith('/api/') || req.is('application/json')) return res.status(500).json({ erreur: 'Erreur interne' });
  res.status(500).send('Erreur interne du serveur.');
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[PS4Store] Serveur démarré sur http://localhost:${PORT}`);
    startLinkChecker();
    startUptimeChecker(`http://127.0.0.1:${PORT}`);
    console.log(`[PS4Store] ${games.length} jeu(x), ${users.length} membre(s) Discord dont ${users.filter((u) => u.role !== 'user').length} administrateur(s) — administration : /dashboard`);
  });
  server.requestTimeout = 0;
}

module.exports = {
  uptimeCheckAll, app, LinkError, isPrivateIp, extractDriveId, parseDriveForm, parseMediafire, parsePkgHeader, formatSize,
  translate, translatePlural, negotiateLang, formatDate, safeNext, dictionaries, LANGS,
  parseRange, sliceBody, isPlainPkgUrl, consolePkgUrl, resolveLink, hostEntry, assertPublicUrl,
  normalizePluginConfig, validateGame, sanitizeChangelog, withChangelogEntry, readPkgVersion, parseSfoString, parseSocials,
  suggestFilename, buildRegion, KNOWN_TITLES, aiPluginHelper, heuristicAnalysis, findKnownTitle, probeLink, resourceExt, isPlainFileUrl, readClientChangelog,
};
