'use strict';
const {
  Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType,
} = require('discord.js');
const config = require('./lib/config');
const api = require('./lib/api');
const ui = require('./lib/ui');
const { chan } = require('./lib/util');
const commands = require('./commands');

const { DISCORD_BOT_TOKEN: TOKEN, DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_GUILD_ID: GUILD_ID } = process.env;
if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('[Bot] DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID et DISCORD_GUILD_ID sont obligatoires : renseignez discord-bot/.env');
  process.exit(1);
}
if (String(process.env.BOT_API_SECRET || '').length < 8) console.warn('[Bot] BOT_API_SECRET absent ou trop court : les commandes liées au site échoueront.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember],
});

client.once('ready', async () => {
  console.log(`[Bot] Connecté en tant que ${client.user.tag}`);
  try {
    await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.definitions });
    console.log(`[Bot] ${commands.definitions.length} commandes slash enregistrées.`);
  } catch (e) { console.error('[Bot] Enregistrement des commandes impossible :', e.message); }
  commands.onReady(client);
  refreshStatus();
  setInterval(refreshStatus, 60 * 1000);
});

let flip = 0;
async function refreshStatus() {
  let name = '/catalogue';
  try {
    const s = await api.stats();
    const msgs = [`${s.games} ressources • ${s.members} membres`, `PS4Store ${s.client_version || ''} • ${s.online} PS4 en ligne`, '/catalogue • /jeu'];
    name = msgs[flip++ % msgs.length];
  } catch (_) {  }
  client.user.setPresence({ activities: [{ name, type: ActivityType.Watching }], status: 'online' });
}

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const roleId = config.autoRoleId();
  if (roleId) await member.roles.add(roleId, 'Rôle automatique').catch((e) => console.warn('[Bot] rôle auto :', e.message));
  const c = await chan(member.guild, 'bienvenue');
  if (!c) return;
  const g = member.guild;
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(`Bienvenue sur ${g.name} !`)
    .setDescription(`Bienvenue <@${member.id}> ! 🎮\nTu es notre **${g.memberCount}ᵉ** membre.\n\n`
      + `📜 Lis le règlement : ${ui.chanMention(config.channelId('regles'), '*règles*')}\n`
      + `🌐 Découvre le site : ${ui.chanMention(config.channelId('website'), '*website*')}\n`
      + `🤖 Commandes du bot : ${ui.chanMention(config.channelId('cmd'), '*cmd*')}`)
    .setThumbnail(member.displayAvatarURL({ size: 256 })).setFooter({ text: `${g.memberCount} membres` }).setTimestamp();
  const btns = [['regles', '📜 Règles'], ['website', '🌐 Website'], ['cmd', '🤖 Commandes']]
    .map(([k, label]) => [config.channelId(k), label]).filter(([id]) => id)
    .map(([id, label]) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(ui.channelLink(g.id, id)));
  await c.send({
    content: `<@${member.id}>`, embeds: [e], components: btns.length ? [new ActionRowBuilder().addComponents(...btns)] : [],
    allowedMentions: { users: [member.id] },
  }).catch((err) => console.warn('[Bot] bienvenue :', err.message));
});

client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const c = (await chan(member.guild, 'logs_staff')) || (await chan(member.guild, 'bienvenue'));
  if (!c) return;
  const user = member.user;
  const e = new EmbedBuilder().setColor(ui.GREY).setTitle('👋 Départ d\'un membre')
    .addFields(
      { name: 'Pseudo', value: user ? user.username : 'inconnu', inline: true },
      { name: 'ID', value: `\`${member.id}\``, inline: true },
      { name: 'Arrivé', value: member.joinedAt ? ui.ts(member.joinedAt, 'F') : 'inconnu', inline: true },
      { name: 'Membres restants', value: String(member.guild.memberCount), inline: true },
    ).setTimestamp();
  if (user) e.setThumbnail(user.displayAvatarURL({ size: 128 }));
  await c.send({ embeds: [e], allowedMentions: { parse: [] } }).catch((err) => console.warn('[Bot] départ :', err.message));
});

client.on('guildMemberUpdate', async (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID || oldM.partial || oldM.premiumSince || !newM.premiumSince) return;
  const c = await chan(newM.guild, 'boost');
  if (!c) return;
  const e = new EmbedBuilder().setColor(0xF47FFF).setTitle('🔮 Merci pour le boost !')
    .setDescription(`Un immense merci à <@${newM.id}> d'avoir boosté **${newM.guild.name}** ! 💜\nLe serveur compte maintenant **${newM.guild.premiumSubscriptionCount || 0}** boost(s) (niveau ${newM.guild.premiumTier}).`)
    .setThumbnail(newM.displayAvatarURL({ size: 256 })).setTimestamp();
  await c.send({ content: `<@${newM.id}>`, embeds: [e], allowedMentions: { users: [newM.id] } }).catch((err) => console.warn('[Bot] boost :', err.message));
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.guildId && i.guildId !== GUILD_ID) return;
    if (i.isAutocomplete()) return await commands.autocomplete(i);
    if (i.isChatInputCommand()) return await commands.onCommand(i);
    if (i.isButton()) return await commands.onButton(i);
    if (i.isStringSelectMenu()) return await commands.onSelect(i);
  } catch (e) {
    console.error('[Bot] interaction :', e);
    if (i.isAutocomplete()) return;
    const msg = { content: `❌ ${e.status !== undefined ? e.message : 'Une erreur est survenue.'}`, ephemeral: true };
    try { if (i.deferred || i.replied) await i.editReply({ content: msg.content, embeds: [], components: [] }); else await i.reply(msg); } catch (_) {  }
  }
});

client.on('error', (e) => console.error('[Bot] client :', e));
process.on('unhandledRejection', (e) => console.error('[Bot] rejet non géré :', e));

client.login(TOKEN).catch((e) => { console.error('[Bot] Connexion refusée :', e.message); process.exit(1); });
