'use strict';
const { PermissionFlagsBits: P } = require('discord.js');
const path = require('path');
const config = require('./config');

const isAdmin = (m) => !!m && m.permissions.has(P.Administrator);
const isStaff = (m) => !!m && (m.permissions.has(P.Administrator) || m.permissions.has(P.ManageGuild) || m.permissions.has(P.ModerateMembers)
  || config.staffRoleIds().some((id) => m.roles.cache.has(id)));

async function chan(guild, key) {
  const id = config.channelId(key);
  if (!id) return null;
  try { const c = await guild.channels.fetch(id); return c && c.isTextBased() ? c : null; } catch (_) { return null; }
}
async function logStaff(guild, embed, files) {
  const c = await chan(guild, 'logs_staff');
  if (c) await c.send({ embeds: [embed], files: files || [] }).catch((e) => console.warn('[Bot] log staff :', e.message));
}

const store = (name) => {
  const file = path.join(config.DATA_DIR, `${name}.json`);
  return { load: () => config.readJson(file, {}), save: (obj) => config.writeJsonAtomic(file, obj) };
};

const nl = (s) => String(s || '').replace(/\\n/g, '\n');

module.exports = { isAdmin, isStaff, chan, logStaff, store, nl };
