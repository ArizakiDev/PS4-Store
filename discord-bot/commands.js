'use strict';
const crypto = require('crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, AttachmentBuilder,
} = require('discord.js');
const config = require('./lib/config');
const api = require('./lib/api');
const ui = require('./lib/ui');
const { isAdmin, isStaff, chan, logStaff, store, nl } = require('./lib/util');
const extra = require('./commands_extra');

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const TYPE_CHOICES = [
  { name: 'Jeux / Apps (.pkg)', value: 'pkg' }, { name: 'Mises à jour', value: 'update' }, { name: 'DLC', value: 'dlc' },
  { name: 'Mods / Plugins', value: 'plugin' }, { name: 'Payloads', value: 'payload' },
];
const PUBLIC = new Set(['catalogue', 'jeu', 'telecharger', 'ma-ps4', 'version', 'report', 'stats', ...extra.PUBLIC_EXTRA]);
extra.setPublicAll(PUBLIC);

const setupCmd = new SlashCommandBuilder().setName('setup').setDescription('Configurer les salons et le rôle automatique du bot')
  .setDefaultMemberPermissions(P.Administrator);
const SETUP_LABELS = {
  bienvenue: 'Salon bienvenue', regles: 'Salon règles', annonces: 'Salon annonces', boost: 'Salon boost', tickets: 'Salon tickets',
  changelogs: 'Salon changelogs', website: 'Salon website', sondages: 'Salon sondages', ajouts: 'Salon ajouts', suggestions: 'Salon suggestions', cmd: 'Salon commandes (cmd)',
  report: 'Salon report', logs_staff: 'Salon logs Staff',
};
for (const [k, label] of Object.entries(SETUP_LABELS)) setupCmd.addChannelOption((o) => o.setName(k).setDescription(label).addChannelTypes(...TEXT_TYPES));
setupCmd.addRoleOption((o) => o.setName('auto_role').setDescription("Rôle attribué automatiquement à l'arrivée"));

const definitions = [
  setupCmd,
  new SlashCommandBuilder().setName('panneaux').setDescription('Poster un panneau permanent (règles, website, tickets)')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('type').setDescription('Panneau à poster').setRequired(true)
      .addChoices({ name: 'Règlement', value: 'regles' }, { name: 'Website PS4Store', value: 'website' }, { name: 'Tickets / Support', value: 'tickets' })),
  new SlashCommandBuilder().setName('annonce').setDescription('Publier une annonce officielle').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('message').setDescription('Message (\\n pour un retour à la ligne)').setRequired(true).setMaxLength(3500))
    .addStringOption((o) => o.setName('ping_role').setDescription('Mention éventuelle')
      .addChoices({ name: 'Rôle annonces', value: 'role' }, { name: '@everyone', value: 'everyone' }, { name: 'Aucune', value: 'none' })),
  new SlashCommandBuilder().setName('changelog').setDescription('Publier une note de mise à jour').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('version').setDescription('Version (ex. 01.12)').setRequired(true).setMaxLength(40))
    .addStringOption((o) => o.setName('nouveautes').setDescription('Nouveautés (\\n pour un retour à la ligne)').setRequired(true).setMaxLength(3500)),
  new SlashCommandBuilder().setName('sondage').setDescription('Créer un sondage').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(250))
    .addStringOption((o) => o.setName('choix1').setDescription('Choix 1').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('choix2').setDescription('Choix 2').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('choix3').setDescription('Choix 3').setMaxLength(80))
    .addStringOption((o) => o.setName('choix4').setDescription('Choix 4').setMaxLength(80)),
  new SlashCommandBuilder().setName('clear').setDescription('Supprimer des messages du salon').setDefaultMemberPermissions(P.ManageMessages)
    .addIntegerOption((o) => o.setName('nombre').setDescription('1 à 100').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('membre').setDescription('Ne supprimer que les messages de ce membre'))
    .addStringOption((o) => o.setName('contenant').setDescription('Ne supprimer que les messages contenant ce mot').setMaxLength(100)),
  new SlashCommandBuilder().setName('nuke').setDescription('Recréer le salon à l\'identique pour le vider entièrement').setDefaultMemberPermissions(P.ManageChannels),
  new SlashCommandBuilder().setName('lock').setDescription('Verrouiller le salon (plus d\'envoi de messages pour @everyone)').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('raison').setDescription('Raison affichée dans le salon').setMaxLength(300)),
  new SlashCommandBuilder().setName('unlock').setDescription('Déverrouiller le salon').setDefaultMemberPermissions(P.ModerateMembers),
  new SlashCommandBuilder().setName('slowmode').setDescription('Définir le mode lent du salon').setDefaultMemberPermissions(P.ModerateMembers)
    .addIntegerOption((o) => o.setName('secondes').setDescription('0 pour désactiver, 21600 au maximum').setRequired(true).setMinValue(0).setMaxValue(21600)),
  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre').setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('timeout').setDescription('Exclure temporairement un membre').setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addIntegerOption((o) => o.setName('duree_minutes').setDescription('Durée en minutes (max 40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre').setDefaultMemberPermissions(P.KickMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre').setDefaultMemberPermissions(P.BanMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('valider-ressource').setDescription('Approuver une proposition communautaire en attente')
    .setDefaultMemberPermissions(P.Administrator)
    .addStringOption((o) => o.setName('id_proposition').setDescription('Proposition en attente').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('catalogue').setDescription('Rechercher dans le catalogue PS4Store')
    .addStringOption((o) => o.setName('recherche').setDescription('Nom ou Title ID').setMaxLength(60))
    .addStringOption((o) => o.setName('type').setDescription('Type de ressource').addChoices(...TYPE_CHOICES)),
  new SlashCommandBuilder().setName('jeu').setDescription("Fiche complète d'un jeu / mod")
    .addStringOption((o) => o.setName('nom_ou_title_id').setDescription('Nom ou Title ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('telecharger').setDescription('Envoyer un jeu sur votre PS4 liée')
    .addStringOption((o) => o.setName('nom_ou_title_id').setDescription('Nom ou Title ID').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('ma-ps4').setDescription("État en direct de votre PS4 liée"),
  new SlashCommandBuilder().setName('version').setDescription('Dernière version de PS4Store.pkg'),
  new SlashCommandBuilder().setName('report').setDescription('Signaler un lien mort, une erreur de région ou un bug')
    .addStringOption((o) => o.setName('jeu_ou_sujet').setDescription('Jeu ou sujet concerné').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('description').setDescription('Description du problème').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('stats').setDescription('Statistiques PS4Store et du serveur Discord'),
].map((c) => c.toJSON()).concat(extra.definitions);
extra.setDefinitions(definitions);

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const err = (i, msg) => ({ content: `❌ ${msg}`, ephemeral: true });
const linkBtn = (label, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
const isLocal = (u) => /^https?:\/\/(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(u);

function accountHint(code) {
  if (code === 'not_linked') return "Ton compte Discord n'est lié à aucun compte PS4Store : connecte-toi sur le site avec Discord (page **Mon compte**).";
  if (code === 'no_console') return "Aucune PS4 n'est appairée à ton compte : génère un code dans **Mon compte** puis saisis-le dans l'app PS4Store.";
  return null;
}

async function setup(i) {
  const lines = [];
  for (const key of Object.keys(SETUP_LABELS)) {
    const c = i.options.getChannel(key);
    if (c) { config.setChannel(key, c.id); lines.push(`✅ **${SETUP_LABELS[key]}** → <#${c.id}>`); }
  }
  const role = i.options.getRole('auto_role');
  if (role) { config.setAutoRole(role.id); lines.push(`✅ **Rôle automatique** → <@&${role.id}>`); }
  const current = Object.keys(SETUP_LABELS).map((k) => { const id = config.channelId(k); return `${SETUP_LABELS[k]} : ${id ? `<#${id}>` : '*non défini*'}`; });
  const ar = config.autoRoleId();
  current.push(`Rôle automatique : ${ar ? `<@&${ar}>` : '*non défini*'}`);
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('⚙️ Configuration du bot')
    .setDescription(`${lines.length ? `${lines.join('\n')}\n\n` : ''}**Configuration actuelle**\n${current.join('\n')}`)
    .setFooter({ text: 'Sauvegardé dans discord-bot/config.json' });
  return i.reply({ embeds: [e], ephemeral: true, allowedMentions: { parse: [] } });
}

const RULES = [
  '**1. Respect** — Aucune insulte, harcèlement, discrimination ou propos haineux.',
  '**2. Pas de spam** — Pas de flood, de pub, ni de mention abusive du Staff ou des membres.',
  '**3. Contenu autorisé** — PS4Store partage des **ressources homebrew** : aucune demande ni partage de jeux commerciaux piratés.',
  '**4. Bon salon** — Les commandes du bot se font dans le salon dédié ; `🍻・général` reste pour discuter.',
  '**5. Support** — Un problème ? Ouvre un **ticket** plutôt que de solliciter le Staff en message privé.',
  '**6. Sécurité** — Ne partage jamais tes identifiants, ton code d\'appairage ou des liens suspects.',
  '**7. Discord** — Les [Conditions d\'utilisation](https://discord.com/terms) et les consignes du Staff s\'appliquent en permanence.',
].join('\n\n');

async function panneaux(i) {
  const type = i.options.getString('type');
  const key = { regles: 'regles', website: 'website', tickets: 'tickets' }[type];
  const target = await chan(i.guild, key);
  if (!target) return i.reply(err(i, `Salon « ${key} » non configuré (ou inaccessible) : utilise d'abord \`/setup\`.`));
  await i.deferReply({ ephemeral: true });
  let payload;
  if (type === 'regles') {
    payload = {
      embeds: [new EmbedBuilder().setColor(ui.BLUE).setTitle('📜 Règlement du serveur').setDescription(RULES).setFooter({ text: 'En cliquant sur le bouton, tu confirmes avoir lu et accepté le règlement.' })],
      components: [row(new ButtonBuilder().setCustomId('rules_accept').setStyle(ButtonStyle.Success).setLabel('J\'accepte le règlement').setEmoji('✅'))],
    };
  } else if (type === 'website') {
    let v = null;
    try { v = await api.version(); } catch (_) {  }
    const site = ui.siteOf(v && v.site);
    const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('🌐 PS4Store — la boutique homebrew de ta PS4')
      .setDescription('Catalogue de jeux, mods, plugins et payloads pour PS4 (GoldHEN), avec installation à distance depuis le site.')
      .addFields(
        { name: 'Version actuelle', value: v ? `\`PS4Store.pkg ${v.version}\` (${ui.bytes(v.size)})` : '*indisponible*', inline: true },
        { name: 'Site', value: site && !isLocal(site) ? site : '*adresse publique non configurée*', inline: true },
        { name: '🔗 Appairer ta console', value: [
          '1. Installe **PS4Store.pkg** sur ta PS4.',
          '2. Connecte-toi sur le site avec Discord → **Mon compte**.',
          '3. Clique sur **Lier une PS4** pour obtenir un code à 6 caractères.',
          `4. Saisis-le dans l'app PS4Store, puis utilise ${ui.chanMention(config.channelId('cmd'), '`/telecharger`')} pour envoyer des jeux à ta console.`,
        ].join('\n') },
      ).setFooter({ text: 'PS4Store' });
    const btns = [];
    if (site && !isLocal(site)) {
      btns.push(linkBtn('Ouvrir le site', site));
      if (v && v.pkg_url) btns.push(linkBtn('Télécharger PS4Store.pkg', ui.siteOf(v.site) + new URL(v.pkg_url).pathname));
    }
    payload = { embeds: [e], components: btns.length ? [row(...btns)] : [] };
  } else {
    payload = {
      embeds: [new EmbedBuilder().setColor(ui.BLUE).setTitle('🎫 Support PS4Store')
        .setDescription('Besoin d\'aide ? Choisis une catégorie dans le menu ci-dessous : un salon privé sera créé avec le Staff.')],
      components: [row(new StringSelectMenuBuilder().setCustomId('ticket_select').setPlaceholder('Ouvrir un ticket / Support…').addOptions(
        { label: 'Aide installation PS4', value: 'install', emoji: '🎮' },
        { label: 'Problème compte / appairage', value: 'account', emoji: '🔗' },
        { label: 'Devenir créateur', value: 'creator', emoji: '🛠️' },
        { label: 'Autre', value: 'other', emoji: '❓' },
      ))],
    };
  }
  await target.send(payload);
  return i.editReply({ content: `✅ Panneau posté dans <#${target.id}>.` });
}

async function annonce(i) {
  const target = await chan(i.guild, 'annonces');
  if (!target) return i.reply(err(i, "Salon annonces non configuré : utilise `/setup`."));
  const roleId = config.announceRoleId();
  const ping = (i.options.getString('ping_role') || 'none') === 'role' && !roleId ? 'none' : (i.options.getString('ping_role') || 'none');
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(`📢 ${i.options.getString('titre')}`).setDescription(nl(i.options.getString('message')))
    .setFooter({ text: `Annonce par ${i.user.username}` }).setTimestamp();
  const content = ping === 'everyone' ? '@everyone' : ping === 'role' ? `<@&${roleId}>` : undefined;
  await target.send({ content, embeds: [e], allowedMentions: ping === 'everyone' ? { parse: ['everyone'] } : ping === 'role' ? { roles: [roleId] } : { parse: [] } });
  return i.reply({ content: `✅ Annonce publiée dans <#${target.id}>.`, ephemeral: true });
}
async function changelog(i) {
  const target = await chan(i.guild, 'changelogs');
  if (!target) return i.reply(err(i, "Salon changelogs non configuré : utilise `/setup`."));
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(`🆕 Mise à jour — ${i.options.getString('version')}`)
    .setDescription(nl(i.options.getString('nouveautes'))).setFooter({ text: 'PS4Store' }).setTimestamp();
  await target.send({ embeds: [e] });
  return i.reply({ content: `✅ Changelog publié dans <#${target.id}>.`, ephemeral: true });
}

const polls = store('polls');
function pollMessage(p) {
  const counts = p.choices.map((_, idx) => Object.values(p.votes).filter((v) => v === idx).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = p.choices.map((c, idx) => {
    const pct = total ? Math.round((counts[idx] / total) * 100) : 0;
    const fill = Math.round(pct / 10);
    return `**${idx + 1}. ${c}**\n${'█'.repeat(fill)}${'░'.repeat(10 - fill)} ${pct}% (${counts[idx]})`;
  });
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(`📊 ${p.question}`).setDescription(lines.join('\n\n'))
    .setFooter({ text: `${total} vote${total > 1 ? 's' : ''} • Clique pour voter ou changer ton vote` });
  const btns = p.choices.map((c, idx) => new ButtonBuilder().setCustomId(`poll|${p.id}|${idx}`).setStyle(ButtonStyle.Primary).setLabel(ui.cut(`${idx + 1}. ${c}`, 80)));
  return { embeds: [e], components: [row(...btns)] };
}
async function sondage(i) {
  const target = await chan(i.guild, 'sondages');
  if (!target) return i.reply(err(i, "Salon sondages non configuré : utilise `/setup`."));
  const choices = ['choix1', 'choix2', 'choix3', 'choix4'].map((k) => i.options.getString(k)).filter(Boolean);
  const p = { id: crypto.randomBytes(5).toString('hex'), question: i.options.getString('question'), choices, votes: {}, by: i.user.id };
  const msg = await target.send(pollMessage(p));
  const all = polls.load(); all[p.id] = p; polls.save(all);
  return i.reply({ content: `✅ Sondage publié : ${msg.url}`, ephemeral: true });
}
async function pollVote(i, id, idx) {
  const all = polls.load(); const p = all[id];
  if (!p || !p.choices[idx]) return i.reply(err(i, 'Ce sondage est introuvable.'));
  if (p.votes[i.user.id] === idx) delete p.votes[i.user.id]; else p.votes[i.user.id] = idx;
  polls.save(all);
  return i.update(pollMessage(p));
}

const warns = store('warns');
async function dm(user, embed) { try { await user.send({ embeds: [embed] }); return true; } catch (_) { return false; } }
function hierarchyError(i, member) {
  if (member.id === i.user.id) return 'Tu ne peux pas te sanctionner toi-même.';
  if (member.id === i.guild.ownerId || member.id === i.client.user.id) return 'Ce membre ne peut pas être sanctionné.';
  if (i.user.id !== i.guild.ownerId && i.member.roles.highest.comparePositionTo(member.roles.highest) <= 0) return 'Ce membre a un rôle égal ou supérieur au tien.';
  return null;
}
async function sanction(i, kind) {
  const user = i.options.getUser('membre'), reason = i.options.getString('raison');
  const member = i.options.getMember('membre');
  const labels = { warn: ['⚠️ Avertissement', ui.ORANGE], timeout: ['🔇 Exclusion temporaire', ui.ORANGE], kick: ['👢 Expulsion', ui.RED], ban: ['🔨 Bannissement', ui.RED] };
  const [title, color] = labels[kind];
  if (!member && kind !== 'ban') return i.reply(err(i, "Ce membre n'est pas sur le serveur."));
  if (member) { const h = hierarchyError(i, member); if (h) return i.reply(err(i, h)); }
  const minutes = kind === 'timeout' ? i.options.getInteger('duree_minutes') : 0;
  if (kind === 'kick' && !member.kickable) return i.reply(err(i, "Je ne peux pas expulser ce membre (hiérarchie des rôles)."));
  if (kind === 'ban' && member && !member.bannable) return i.reply(err(i, "Je ne peux pas bannir ce membre (hiérarchie des rôles)."));
  if (kind === 'timeout' && !member.moderatable) return i.reply(err(i, "Je ne peux pas exclure ce membre (hiérarchie des rôles)."));
  await i.deferReply({ ephemeral: true });
  const notice = new EmbedBuilder().setColor(color).setTitle(`${title} — ${i.guild.name}`)
    .setDescription(`**Raison :** ${reason}${minutes ? `\n**Durée :** ${minutes} min` : ''}`).setTimestamp();
  const dmSent = await dm(user, notice);
  const audit = `${i.user.username} : ${reason}`.slice(0, 500);
  let count = 0;
  try {
    if (kind === 'warn') {
      const all = warns.load(); (all[user.id] = all[user.id] || []).push({ reason, by: i.user.id, at: new Date().toISOString() }); warns.save(all); count = all[user.id].length;
    } else if (kind === 'timeout') await member.timeout(minutes * 60000, audit);
    else if (kind === 'kick') await member.kick(audit);
    else await i.guild.members.ban(user.id, { reason: audit });
  } catch (e) { return i.editReply({ content: `❌ Échec : ${e.message}` }); }
  const log = new EmbedBuilder().setColor(color).setTitle(title)
    .addFields(
      { name: 'Membre', value: `${user.username} (<@${user.id}>)\n\`${user.id}\``, inline: true },
      { name: 'Modérateur', value: `<@${i.user.id}>`, inline: true },
      { name: 'Raison', value: ui.cut(reason, 1000) },
      ...(minutes ? [{ name: 'Durée', value: `${minutes} min`, inline: true }] : []),
      ...(kind === 'warn' ? [{ name: 'Total avertissements', value: String(count), inline: true }] : []),
      { name: 'MP au membre', value: dmSent ? 'Envoyé' : 'Impossible (MP fermés)', inline: true },
    ).setTimestamp();
  await logStaff(i.guild, log);
  return i.editReply({ content: `✅ ${title} appliqué à **${user.username}**.${dmSent ? '' : ' (MP non délivré)'}` });
}
async function clear(i) {
  const n = i.options.getInteger('nombre'), user = i.options.getUser('membre'), word = (i.options.getString('contenant') || '').trim().toLowerCase();
  await i.deferReply({ ephemeral: true });
  try {
    let deleted;
    if (user || word) {
      const batch = await i.channel.messages.fetch({ limit: 100 });
      const list = [...batch.filter((m) => (!user || m.author.id === user.id) && (!word || String(m.content).toLowerCase().includes(word))).values()].slice(0, n);
      deleted = list.length ? await i.channel.bulkDelete(list, true) : new Map();
    } else deleted = await i.channel.bulkDelete(n, true);
    const filters = [user ? `de <@${user.id}>` : '', word ? `contenant « ${word} »` : ''].filter(Boolean).join(' ');
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('🧹 Messages supprimés')
      .setDescription(`<@${i.user.id}> a supprimé **${deleted.size}** message(s) dans <#${i.channelId}>${filters ? ` ${filters}` : ''}.`).setTimestamp());
    return i.editReply({ content: `🧹 ${deleted.size} message${deleted.size > 1 ? 's' : ''} supprimé${deleted.size > 1 ? 's' : ''}` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}

const isTextChan = (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
async function nuke(i) {
  const ch = i.channel;
  if (!isTextChan(ch)) return i.reply(err(i, 'Cette commande ne fonctionne que dans un salon textuel.'));
  if (!ch.manageable && !ch.deletable) return i.reply(err(i, "Je n'ai pas la permission de gérer ce salon."));
  await i.deferReply({ ephemeral: true });
  try {
    const reason = `Nuke par ${i.user.username}`;
    const position = ch.rawPosition;
    const clone = await ch.clone({ reason });
    await clone.setPosition(position, { reason }).catch(() => {});
    const moved = Object.keys(config.CHANNEL_KEYS).filter((k) => config.channelId(k) === ch.id);
    moved.forEach((k) => config.setChannel(k, clone.id));
    await ch.delete(reason);
    await clone.send({ content: `💥 Salon réinitialisé par <@${i.user.id}>`, allowedMentions: { parse: [] } });
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.RED).setTitle('💥 Salon réinitialisé')
      .setDescription(`<@${i.user.id}> a réinitialisé **#${clone.name}** (<#${clone.id}>).${moved.length ? `\nConfiguration mise à jour : ${moved.join(', ')}.` : ''}`).setTimestamp());
    return i.editReply({ content: `💥 Salon réinitialisé : <#${clone.id}>` }).catch(() => {});
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }).catch(() => {}); }
}
async function setLock(i, locked) {
  const ch = i.channel;
  if (!isTextChan(ch)) return i.reply(err(i, 'Cette commande ne fonctionne que dans un salon textuel.'));
  const reason = i.options.getString('raison') || '';
  await i.deferReply({ ephemeral: true });
  try {
    await ch.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: locked ? false : null }, { reason: `${locked ? 'Lock' : 'Unlock'} par ${i.user.username}${reason ? ` : ${reason}` : ''}` });
    const e = new EmbedBuilder().setColor(locked ? ui.ORANGE : ui.GREEN).setTitle(locked ? '🔒 Salon verrouillé' : '🔓 Salon déverrouillé')
      .setDescription(locked ? `Ce salon est verrouillé par <@${i.user.id}>.${reason ? `\n**Raison :** ${reason}` : ''}` : `Ce salon est de nouveau ouvert (par <@${i.user.id}>).`).setTimestamp();
    await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
    await logStaff(i.guild, new EmbedBuilder().setColor(locked ? ui.ORANGE : ui.GREEN).setTitle(locked ? '🔒 Lock' : '🔓 Unlock')
      .setDescription(`<@${i.user.id}> dans <#${ch.id}>${reason ? ` — ${reason}` : ''}`).setTimestamp());
    return i.editReply({ content: locked ? '🔒 Salon verrouillé.' : '🔓 Salon déverrouillé.' });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}
async function slowmode(i) {
  const ch = i.channel, sec = i.options.getInteger('secondes');
  if (!isTextChan(ch)) return i.reply(err(i, 'Cette commande ne fonctionne que dans un salon textuel.'));
  await i.deferReply({ ephemeral: true });
  try {
    await ch.setRateLimitPerUser(sec, `Slowmode par ${i.user.username}`);
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('🐢 Mode lent')
      .setDescription(`<@${i.user.id}> : ${sec ? `**${sec} s**` : 'désactivé'} dans <#${ch.id}>`).setTimestamp());
    return i.editReply({ content: sec ? `🐢 Mode lent : ${sec} seconde(s).` : '🐢 Mode lent désactivé.' });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}

async function valider(i) {
  await i.deferReply({ ephemeral: true });
  try {
    const r = await api.approve(i.options.getString('id_proposition'), i.user.id);
    const g = r.game;
    if (!r.announced_by_webhook) {
      const c = await chan(i.guild, 'ajouts');
      if (c) await c.send({ embeds: [ui.gameEmbed(g).setTitle(`📬 Nouveau : ${g.titre}`)] }).catch(() => {});
    }
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREEN).setTitle('✅ Ressource validée')
      .setDescription(`<@${i.user.id}> a publié **${g.titre}** (${g.version}) depuis Discord.`).setTimestamp());
    return i.editReply({ content: `✅ « ${g.titre} » est publié dans le catalogue.` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}

const PER_PAGE = 5;
async function catalogPage(search, type, page) {
  const r = await api.catalogue(search, type, 200);
  const pages = Math.max(1, Math.ceil(r.games.length / PER_PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = r.games.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const desc = slice.length
    ? slice.map((g, n) => `**${page * PER_PAGE + n + 1}.** [${ui.cut(g.titre, 60)}](${g.url}) — \`${g.title_id}\`\nv${g.version} · ${ui.TYPE_LABELS[g.resource_type] || g.resource_type} · ${g.size || '—'}`).join('\n\n')
    : '*Aucun résultat.*';
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('📚 Catalogue PS4Store')
    .setDescription(desc).setFooter({ text: `Page ${page + 1}/${pages} • ${r.total} résultat(s) • /jeu pour la fiche complète` });
  const tail = `${type || '-'}|${String(search || '').slice(0, 55)}`;
  const nav = row(
    new ButtonBuilder().setCustomId(`cat|${page - 1}|${tail}`).setStyle(ButtonStyle.Secondary).setLabel('◀ Précédent').setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`cat|${page + 1}|${tail}`).setStyle(ButtonStyle.Secondary).setLabel('Suivant ▶').setDisabled(page >= pages - 1),
  );
  return { embeds: [e], components: [nav] };
}
async function catalogue(i) {
  await i.deferReply();
  return i.editReply(await catalogPage(i.options.getString('recherche') || '', i.options.getString('type') || '', 0));
}
async function catalogueButton(i, parts) {
  const [, page, type, ...rest] = parts;
  return i.update(await catalogPage(rest.join('|'), type === '-' ? '' : type, Number(page) || 0));
}

async function jeu(i) {
  await i.deferReply();
  const g = await api.game(i.options.getString('nom_ou_title_id'));
  const btns = [];
  if (ui.isHttp(g.url) && !isLocal(g.url)) btns.push(linkBtn('Voir sur le site', g.url));
  btns.push(new ButtonBuilder().setCustomId(`dl|${g.id}`).setStyle(ButtonStyle.Primary).setLabel('Télécharger sur ma PS4').setEmoji('📥'));
  return i.editReply({ embeds: [ui.gameEmbed(g)], components: [row(...btns)] });
}
async function queueDownload(i, query) {
  try {
    const r = await api.download(i.user.id, query);
    const e = new EmbedBuilder().setColor(ui.GREEN).setTitle('📥 Ajouté à la file de ta PS4')
      .setDescription(`**${r.game.titre}** (${r.game.version}) sera installé dès que ta PS4 se synchronisera avec PS4Store.`).setThumbnail(ui.isHttp(r.game.icon_url) ? r.game.icon_url : null);
    return { embeds: [e], ephemeral: true };
  } catch (e) { return err(i, accountHint(e.code) || e.message); }
}
async function telecharger(i) {
  await i.deferReply({ ephemeral: true });
  const { ephemeral, ...payload } = await queueDownload(i, i.options.getString('nom_ou_title_id'));
  return i.editReply(payload);
}
async function downloadButton(i, id) {
  await i.deferReply({ ephemeral: true });
  const { ephemeral, ...payload } = await queueDownload(i, id);
  return i.editReply(payload);
}
async function maPs4(i) {
  await i.deferReply({ ephemeral: true });
  try {
    const r = await api.console(i.user.id);
    if (!r.consoles.length) return i.editReply({ content: `❌ ${accountHint('no_console')}` });
    const embeds = r.consoles.map((c) => {
      const used = c.disk_total ? c.disk_total - c.disk_free : 0;
      return new EmbedBuilder().setColor(c.online ? ui.GREEN : ui.GREY).setTitle(`🎮 ${c.name}`)
        .addFields(
          { name: 'État', value: c.online ? '🟢 En ligne' : `🔴 Hors ligne${c.last_seen ? ` (vue ${ui.ts(c.last_seen)})` : ''}`, inline: true },
          { name: 'Espace libre', value: c.disk_total ? `${ui.bytes(c.disk_free)} / ${ui.bytes(c.disk_total)} (${Math.round((used / c.disk_total) * 100)}% utilisé)` : '—', inline: true },
          { name: 'Jeux installés', value: String(c.installed_count), inline: true },
          { name: 'En cours', value: c.playing ? c.playing.name || c.playing.title_id : '—', inline: true },
          { name: 'App PS4Store', value: c.app_version || '—', inline: true },
        );
    });
    embeds[embeds.length - 1].setFooter({ text: `${r.pending} installation(s) en attente • compte ${r.username}` });
    return i.editReply({ embeds: embeds.slice(0, 10) });
  } catch (e) { return i.editReply({ content: `❌ ${accountHint(e.code) || e.message}` }); }
}
async function version(i) {
  await i.deferReply();
  const v = await api.version();
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(`📦 PS4Store.pkg — ${v.version}`)
    .setDescription(ui.cut(v.changelog, 1500) || '*Pas de notes de version.*')
    .addFields({ name: 'Taille', value: ui.bytes(v.size), inline: true }, { name: 'Mise à jour', value: ui.ts(v.updated_at), inline: true });
  const site = ui.siteOf(v.site);
  const btns = [];
  if (site && !isLocal(site)) btns.push(linkBtn('Télécharger', site + new URL(v.pkg_url).pathname));
  return i.editReply({ embeds: [e], components: btns.length ? [row(...btns)] : [] });
}
async function report(i) {
  const target = await chan(i.guild, 'report');
  if (!target) return i.reply(err(i, "Le salon des signalements n'est pas configuré."));
  const e = new EmbedBuilder().setColor(ui.ORANGE).setTitle(`🎯 Signalement : ${ui.cut(i.options.getString('jeu_ou_sujet'), 200)}`)
    .setDescription(i.options.getString('description'))
    .addFields({ name: 'Signalé par', value: `<@${i.user.id}> (\`${i.user.id}\`)`, inline: true }).setTimestamp();
  await target.send({ embeds: [e], components: [row(new ButtonBuilder().setCustomId('report_resolve').setStyle(ButtonStyle.Success).setLabel('Marquer comme résolu').setEmoji('✅'))], allowedMentions: { parse: [] } });
  return i.reply({ content: '✅ Merci, ton signalement a été transmis au Staff.', ephemeral: true });
}
async function reportResolve(i) {
  if (!isStaff(i.member)) return i.reply(err(i, 'Réservé au Staff.'));
  const e = EmbedBuilder.from(i.message.embeds[0]).setColor(ui.GREEN)
    .setTitle(`✅ ${String(i.message.embeds[0].title || '').replace(/^🎯\s*/, '')}`)
    .addFields({ name: 'Résolu par', value: `<@${i.user.id}>`, inline: true });
  await i.update({ embeds: [e], components: [], allowedMentions: { parse: [] } });
  await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREEN).setTitle('Signalement résolu').setDescription(`<@${i.user.id}> : ${i.message.url}`).setTimestamp());
}
async function stats(i) {
  await i.deferReply();
  const s = await api.stats();
  const g = i.guild;
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('📈 Statistiques')
    .addFields(
      { name: 'PS4Store', value: [`Ressources : **${s.games}** (${s.pkg} pkg · ${s.plugin || 0} plugins · ${s.payloads} payloads)`, `Membres inscrits : **${s.members}**`, `PS4 liées : **${s.consoles}** (🟢 ${s.online} en ligne)`, `Client : **${s.client_version || '—'}**`, `Propositions en attente : **${s.pending_submissions}**`].join('\n') },
      { name: g.name, value: [`Membres : **${g.memberCount}**`, `Boosts : **${g.premiumSubscriptionCount || 0}** (niveau ${g.premiumTier})`, `Salons : **${g.channels.cache.size}** · Rôles : **${g.roles.cache.size}**`].join('\n') },
    ).setTimestamp();
  return i.editReply({ embeds: [e] });
}

async function rulesAccept(i) {
  const roleId = config.autoRoleId();
  let extra = '';
  if (roleId && !i.member.roles.cache.has(roleId)) { try { await i.member.roles.add(roleId, 'Règlement accepté'); extra = ' Ton rôle a été ajouté.'; } catch (_) {  } }
  return i.reply({ content: `✅ Merci d'avoir accepté le règlement !${extra}`, ephemeral: true });
}
const TICKET_LABELS = { install: 'Aide installation PS4', account: 'Problème compte / appairage', creator: 'Devenir créateur', other: 'Autre' };
const ownerOf = (c) => /^ticket:(\d+)$/.exec(c.topic || '');
async function ticketOpen(i) {
  const kind = TICKET_LABELS[i.values[0]] ? i.values[0] : 'other';
  const existing = i.guild.channels.cache.find((c) => c.topic === `ticket:${i.user.id}`);
  if (existing) return i.reply(err(i, `Tu as déjà un ticket ouvert : <#${existing.id}>.`));
  await i.deferReply({ ephemeral: true });
  let parent = config.staffCategoryId();
  if (!parent) { const logs = await chan(i.guild, 'logs_staff'); parent = logs && logs.parentId; }
  const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles];
  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: i.user.id, allow },
    { id: i.client.user.id, allow: [...allow, P.ManageChannels] },
    ...config.staffRoleIds().filter((id) => i.guild.roles.cache.has(id)).map((id) => ({ id, allow: [...allow, P.ManageMessages] })),
  ];
  const safe = i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || i.user.id;
  try {
    const ch = await i.guild.channels.create({ name: `ticket-${safe}`, type: ChannelType.GuildText, parent: parent || undefined, topic: `ticket:${i.user.id}`, permissionOverwrites: overwrites });
    const staffPing = config.staffRoleIds().map((id) => `<@&${id}>`).join(' ');
    await ch.send({
      content: `<@${i.user.id}> ${staffPing}`.trim(),
      embeds: [new EmbedBuilder().setColor(ui.BLUE).setTitle(`🎫 ${TICKET_LABELS[kind]}`).setDescription('Décris ton problème en détail : un membre du Staff va te répondre. Quand c\'est réglé, clique sur **Fermer le ticket**.')],
      components: [row(new ButtonBuilder().setCustomId('ticket_close').setStyle(ButtonStyle.Danger).setLabel('Fermer le ticket').setEmoji('🔒'))],
      allowedMentions: { users: [i.user.id], roles: config.staffRoleIds() },
    });
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.BLUE).setTitle('🎫 Ticket ouvert').setDescription(`<@${i.user.id}> — ${TICKET_LABELS[kind]} → <#${ch.id}>`).setTimestamp());
    return i.editReply({ content: `✅ Ticket créé : <#${ch.id}>` });
  } catch (e) { return i.editReply({ content: `❌ Impossible de créer le ticket : ${e.message}` }); }
}
async function transcript(channel) {
  const all = []; let before;
  for (let n = 0; n < 10; n++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values()); before = batch.last().id;
  }
  return all.reverse().map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.username}: ${m.content}${m.attachments.size ? ` ${[...m.attachments.values()].map((a) => a.url).join(' ')}` : ''}${!m.content && m.embeds.length ? ' [embed]' : ''}`).join('\n');
}
async function ticketClose(i) {
  const o = ownerOf(i.channel);
  if (!o) return i.reply(err(i, "Ce salon n'est pas un ticket."));
  if (!isStaff(i.member) && o[1] !== i.user.id) return i.reply(err(i, 'Seul le Staff ou le créateur du ticket peut le fermer.'));
  await i.reply({ content: '🔒 Fermeture du ticket dans 5 secondes…' });
  const text = await transcript(i.channel).catch(() => '(transcription indisponible)');
  await logStaff(i.guild,
    new EmbedBuilder().setColor(ui.GREY).setTitle('🔒 Ticket fermé').setDescription(`${i.channel.name} — ouvert par <@${o[1]}>, fermé par <@${i.user.id}>`).setTimestamp(),
    [new AttachmentBuilder(Buffer.from(text || '(vide)', 'utf8'), { name: `${i.channel.name}.txt` })]);
  setTimeout(() => i.channel.delete('Ticket fermé').catch(() => {}), 5000);
}

async function autocomplete(i) {
  if (await extra.autocomplete(i)) return;
  const f = i.options.getFocused(true);
  let out = [];
  try {
    if (i.commandName === 'valider-ressource') {
      const q = String(f.value).toLowerCase();
      out = (await api.submissions()).filter((s) => !q || s.titre.toLowerCase().includes(q)).slice(0, 25)
        .map((s) => ({ name: ui.cut(`${s.titre} ${s.version} — par ${s.by} [${s.resource_type}]`, 100), value: s.id }));
    } else {
      out = (await api.catalogue(f.value, '', 25)).games.map((g) => ({ name: ui.cut(`${g.titre} (${g.title_id}) v${g.version}`, 100), value: g.id }));
    }
  } catch (_) {  }
  return i.respond(out.slice(0, 25));
}

const handlers = {
  setup, panneaux, annonce, changelog, sondage, clear, catalogue, jeu, telecharger, 'ma-ps4': maPs4, version, report, stats,
  'valider-ressource': valider, nuke, slowmode, lock: (i) => setLock(i, true), unlock: (i) => setLock(i, false),
  warn: (i) => sanction(i, 'warn'), timeout: (i) => sanction(i, 'timeout'), kick: (i) => sanction(i, 'kick'), ban: (i) => sanction(i, 'ban'),
};
const ADMIN_ONLY = new Set(['setup', 'valider-ressource']);
const STAFF_ONLY = new Set(['panneaux', 'annonce', 'changelog', 'sondage', 'clear', 'nuke', 'lock', 'unlock', 'slowmode', 'warn', 'timeout', 'kick', 'ban', ...extra.STAFF_EXTRA]);
Object.assign(handlers, extra.handlers);

async function onCommand(i) {
  const name = i.commandName;
  if (!i.inGuild()) return i.reply(err(i, 'Utilise cette commande sur le serveur.'));
  if (ADMIN_ONLY.has(name) && !isAdmin(i.member)) return i.reply(err(i, 'Réservé aux administrateurs.'));
  if (STAFF_ONLY.has(name) && !isStaff(i.member)) return i.reply(err(i, 'Réservé au Staff.'));
  if (PUBLIC.has(name)) {
    const cmd = config.channelId('cmd');
    if (cmd && i.channelId !== cmd && !isStaff(i.member)) return i.reply(err(i, `Utilise cette commande dans <#${cmd}> pour garder les autres salons propres.`));
  }
  return handlers[name](i);
}
async function onButton(i) {
  if (await extra.onButton(i)) return;
  const id = i.customId;
  if (id === 'rules_accept') return rulesAccept(i);
  if (id === 'ticket_close') return ticketClose(i);
  if (id === 'report_resolve') return reportResolve(i);
  if (id.startsWith('cat|')) return catalogueButton(i, id.split('|'));
  if (id.startsWith('dl|')) return downloadButton(i, id.slice(3));
  if (id.startsWith('poll|')) { const [, pid, idx] = id.split('|'); return pollVote(i, pid, Number(idx)); }
}
async function onSelect(i) {
  if (await extra.onSelect(i)) return;
  if (i.customId === 'ticket_select') return ticketOpen(i);
}

module.exports = { definitions, onCommand, onButton, onSelect, autocomplete, onReady: extra.onReady };
