'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config.json');

(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (_) {  }
})();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const CHANNEL_KEYS = {
  bienvenue: 'WELCOME_CHANNEL_ID', regles: 'RULES_CHANNEL_ID', annonces: 'ANNOUNCEMENTS_CHANNEL_ID', boost: 'BOOST_CHANNEL_ID',
  tickets: 'TICKETS_CHANNEL_ID', changelogs: 'CHANGELOGS_CHANNEL_ID', website: 'WEBSITE_CHANNEL_ID', sondages: 'POLLS_CHANNEL_ID',
  ajouts: 'ADDITIONS_CHANNEL_ID', cmd: 'CMD_CHANNEL_ID', report: 'REPORT_CHANNEL_ID', logs_staff: 'STAFF_LOGS_CHANNEL_ID',
  suggestions: 'SUGGESTIONS_CHANNEL_ID',
};
const ID_RE = /^\d{5,25}$/;

let cfg = readJson(CONFIG_FILE, {});
if (!cfg || typeof cfg !== 'object') cfg = {};
cfg.channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
cfg.auto_role = typeof cfg.auto_role === 'string' ? cfg.auto_role : '';

const clean = (v) => (ID_RE.test(String(v || '').trim()) ? String(v).trim() : '');
const channelId = (key) => clean(cfg.channels[key]) || clean(process.env[CHANNEL_KEYS[key]]);
const autoRoleId = () => clean(cfg.auto_role) || clean(process.env.AUTO_ROLE_ID);
function setChannel(key, id) { cfg.channels[key] = id; writeJsonAtomic(CONFIG_FILE, cfg); }
function setAutoRole(id) { cfg.auto_role = id; writeJsonAtomic(CONFIG_FILE, cfg); }
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter((s) => ID_RE.test(s));

module.exports = {
  ROOT, DATA_DIR, CHANNEL_KEYS, readJson, writeJsonAtomic, channelId, autoRoleId, setChannel, setAutoRole,
  staffRoleIds: () => list(process.env.STAFF_ROLE_IDS),
  staffCategoryId: () => clean(process.env.STAFF_CATEGORY_ID),
  announceRoleId: () => clean(process.env.ANNOUNCE_ROLE_ID) || '',
  publicUrl: () => String(process.env.PS4STORE_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
};
