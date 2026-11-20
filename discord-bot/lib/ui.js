'use strict';
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const BLUE = 0x0070D1, GREEN = 0x2ECC71, RED = 0xE74C3C, ORANGE = 0xF39C12, GREY = 0x2B2D31;
const TYPE_LABELS = { pkg: 'Jeu / App (.pkg)', update: 'Mise à jour', dlc: 'DLC', plugin: 'Mod / Plugin', payload: 'Payload' };

function bytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const cut = (s, n) => { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const ts = (d, style = 'R') => { const t = Date.parse(d); return Number.isFinite(t) ? `<t:${Math.floor(t / 1000)}:${style}>` : '—'; };
const channelLink = (guildId, id) => `https://discord.com/channels/${guildId}/${id}`;
const chanMention = (id, fallback) => (id ? `<#${id}>` : fallback);
const siteOf = (fromApi) => config.publicUrl() || String(fromApi || '').replace(/\/+$/, '');
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

function gameEmbed(g) {
  const e = new EmbedBuilder().setColor(BLUE).setTitle(cut(g.titre, 250)).setDescription(cut(g.description, 400) || null)
    .addFields(
      { name: 'Title ID', value: `\`${g.title_id}\``, inline: true },
      { name: 'Version', value: g.version || '—', inline: true },
      { name: 'Taille', value: g.size || '—', inline: true },
      { name: 'Firmware min.', value: g.firmware_min || '—', inline: true },
      { name: 'Type', value: TYPE_LABELS[g.resource_type] || g.resource_type, inline: true },
      { name: 'Auteur', value: g.author_name || '—', inline: true },
    ).setFooter({ text: 'PS4Store' });
  if (isHttp(g.icon_url)) e.setThumbnail(g.icon_url);
  if (isHttp(g.url)) e.setURL(g.url);
  return e;
}

module.exports = { BLUE, GREEN, RED, ORANGE, GREY, TYPE_LABELS, bytes, cut, ts, channelLink, chanMention, siteOf, isHttp, gameEmbed };
