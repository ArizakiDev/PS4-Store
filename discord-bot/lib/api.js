'use strict';
const base = () => String(process.env.PS4STORE_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(base() + path, {
      method,
      headers: { 'X-Bot-Secret': process.env.BOT_API_SECRET || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) {
    const e = new Error('Le serveur PS4Store est injoignable pour le moment.'); e.status = 0; throw e;
  }
  let json = null;
  try { json = await r.json(); } catch (_) {  }
  if (!r.ok) {
    const e = new Error((json && json.erreur) || `Erreur HTTP ${r.status}`);
    e.status = r.status; e.code = json && json.code; throw e;
  }
  return json;
}
const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''))).toString();

module.exports = {
  catalogue: (search, type, limit) => call('GET', `/api/bot/catalogue?${qs({ q: search, type, limit })}`),
  game: (search) => call('GET', `/api/bot/game?${qs({ q: search })}`),
  download: (discordId, search) => call('POST', '/api/bot/download', { discord_id: discordId, q: search }),
  console: (discordId) => call('GET', `/api/bot/console/${encodeURIComponent(discordId)}`),
  version: () => call('GET', '/api/bot/version'),
  stats: () => call('GET', '/api/bot/stats'),
  submissions: () => call('GET', '/api/bot/submissions'),
  user: (discordId) => call('GET', `/api/bot/user/${encodeURIComponent(discordId)}`),
  collections: () => call('GET', '/api/bot/collections'),
  requests: (limit) => call('GET', `/api/bot/requests?limit=${limit || 5}`),
  status: () => call('GET', '/api/bot/status'),
  recap: () => call('GET', '/api/bot/recap'),
  createRequest: (discordId, authorName, body) => call('POST', '/api/requests', { discord_id: discordId, author_name: authorName, ...body }),
  voteRequest: (discordId, authorName, id) => call('POST', `/api/requests/${encodeURIComponent(id)}/vote`, { discord_id: discordId, author_name: authorName }),
  approve: (id, moderatorId) => call('POST', `/api/bot/submissions/${encodeURIComponent(id)}/approve`, { moderator_id: moderatorId }),
};
