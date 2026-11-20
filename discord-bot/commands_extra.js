'use strict';
const crypto = require('crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits: P, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const config = require('./lib/config');
const api = require('./lib/api');
const ui = require('./lib/ui');
const { chan, logStaff, store, nl } = require('./lib/util');

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const err = (msg) => ({ content: `❌ ${msg}`, ephemeral: true });
const linkBtn = (label, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
const isLocal = (u) => /^https?:\/\/(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(u);
const publicSite = (u) => { const s = ui.siteOf(u); return s && !isLocal(s) ? s : ''; };
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const isText = (c) => c && TEXT_TYPES.includes(c.type);

const PUBLIC_EXTRA = new Set(['collections', 'status', 'profil', 'demandes', 'demander']);
const STAFF_EXTRA = new Set(['say', 'embed', 'giveaway', 'add-role', 'remove-role', 'recap-hebdo']);

const definitions = [
  new SlashCommandBuilder().setName('help').setDescription('Aide interactive : toutes les commandes par catégorie')
    .addStringOption((o) => o.setName('commande').setDescription('Détail d\'une commande').setAutocomplete(true)),
  new SlashCommandBuilder().setName('profil').setDescription('Carte de profil PS4Store d\'un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Membre (vous par défaut)')),
  new SlashCommandBuilder().setName('collections').setDescription('Collections et packs mis en avant sur le site'),
  new SlashCommandBuilder().setName('demandes').setDescription('Top 5 des demandes de la communauté (votez avec les boutons)'),
  new SlashCommandBuilder().setName('demander').setDescription('Demander un jeu, un mod ou un payload')
    .addStringOption((o) => o.setName('titre').setDescription('Nom de la ressource').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('type').setDescription('Type de ressource').addChoices({ name: 'Jeu / App', value: 'pkg' }, { name: 'Mod / Plugin', value: 'plugin' }, { name: 'Payload', value: 'payload' }))
    .addStringOption((o) => o.setName('title_id').setDescription('Title ID (ex. CUSA12345)').setMaxLength(9))
    .addStringOption((o) => o.setName('notes').setDescription('Précisions').setMaxLength(300)),
  new SlashCommandBuilder().setName('status').setDescription('État des services PS4Store sur 30 jours'),
  new SlashCommandBuilder().setName('notifier').setDescription('Activer / désactiver les notifications de nouveautés (rôle annonces)'),
  new SlashCommandBuilder().setName('suggestions').setDescription('Proposer une idée pour PS4Store ou le serveur')
    .addStringOption((o) => o.setName('idee').setDescription('Votre suggestion').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('userinfo').setDescription('Informations sur un membre Discord')
    .addUserOption((o) => o.setName('membre').setDescription('Membre (vous par défaut)')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Informations sur le serveur'),
  new SlashCommandBuilder().setName('say').setDescription('Faire parler le bot dans un salon').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('message').setDescription('Message (\\n pour un retour à la ligne)').setRequired(true).setMaxLength(1900))
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...TEXT_TYPES)),
  new SlashCommandBuilder().setName('embed').setDescription('Envoyer un embed personnalisé').setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true).setMaxLength(250))
    .addStringOption((o) => o.setName('description').setDescription('Description (\\n pour un retour à la ligne)').setRequired(true).setMaxLength(3500))
    .addStringOption((o) => o.setName('couleur').setDescription('Couleur hexadécimale (ex. 0070D1)').setMaxLength(7))
    .addStringOption((o) => o.setName('image_url').setDescription('Image (https://…)').setMaxLength(500))
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...TEXT_TYPES)),
  new SlashCommandBuilder().setName('giveaway').setDescription('Lancer un concours avec tirage au sort automatique').setDefaultMemberPermissions(P.ModerateMembers)
    .addIntegerOption((o) => o.setName('duree_minutes').setDescription('Durée en minutes (max 10080 = 7 jours)').setRequired(true).setMinValue(1).setMaxValue(10080))
    .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de gagnants').setRequired(true).setMinValue(1).setMaxValue(20))
    .addStringOption((o) => o.setName('lot').setDescription('Lot à gagner').setRequired(true).setMaxLength(200))
    .addChannelOption((o) => o.setName('salon').setDescription('Salon (celui-ci par défaut)').addChannelTypes(...TEXT_TYPES)),
  new SlashCommandBuilder().setName('add-role').setDescription('Ajouter un rôle à un membre').setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle à ajouter').setRequired(true)),
  new SlashCommandBuilder().setName('remove-role').setDescription('Retirer un rôle à un membre').setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle à retirer').setRequired(true)),
  new SlashCommandBuilder().setName('recap-hebdo').setDescription('Publier le récapitulatif de la semaine dans le salon annonces').setDefaultMemberPermissions(P.ModerateMembers),
].map((c) => c.toJSON());

let ALL = [];
const setDefinitions = (defs) => { ALL = defs; };
const HELP_CATS = {
  ps4: { label: '🎮 PS4Store & Catalogue', desc: 'Chercher, installer et suivre vos jeux', cmds: ['catalogue', 'jeu', 'telecharger', 'ma-ps4', 'version', 'collections', 'status', 'stats'] },
  community: { label: '🤝 Communauté & Profils', desc: 'Profils, demandes, signalements et idées', cmds: ['profil', 'demander', 'demandes', 'report', 'notifier', 'suggestions'] },
  admin: { label: '🛡️ Administration & Modération', desc: 'Réservé au Staff', cmds: ['setup', 'panneaux', 'annonce', 'changelog', 'sondage', 'valider-ressource', 'recap-hebdo', 'clear', 'nuke', 'lock', 'unlock', 'slowmode', 'warn', 'timeout', 'kick', 'ban', 'say', 'embed', 'giveaway', 'add-role', 'remove-role'] },
  utils: { label: 'ℹ️ Utilitaires', desc: 'Informations et aide', cmds: ['help', 'userinfo', 'serverinfo'] },
};
const OPT_TYPES = { 3: 'texte', 4: 'nombre', 5: 'oui/non', 6: 'membre', 7: 'salon', 8: 'rôle', 10: 'décimal' };
const defOf = (name) => ALL.find((d) => d.name === name);
const usage = (d) => `/${d.name}${(d.options || []).map((o) => (o.required ? ` <${o.name}>` : ` [${o.name}]`)).join('')}`;

function helpHome() {
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('📘 Aide de PS4Store')
    .setDescription([
      'Je relie ce serveur à **PS4Store** : catalogue homebrew, installation à distance sur ta PS4, demandes de la communauté et outils de modération.',
      '',
      '**Raccourcis**',
      '• `/catalogue` — chercher un jeu, un mod ou un payload',
      '• `/telecharger` — envoyer un jeu directement sur ta PS4',
      '• `/ma-ps4` — l\'état de ta console',
      '• `/demandes` — voter pour les prochaines ressources',
      '',
      '👇 Choisis une catégorie dans le menu, ou tape `/help commande:<nom>` pour le détail d\'une commande.',
    ].join('\n'))
    .addFields(Object.values(HELP_CATS).map((c) => ({ name: c.label, value: `${c.desc} · **${c.cmds.filter(defOf).length}** commandes`, inline: true })))
    .setFooter({ text: 'PS4Store' });
  return { embeds: [e], components: [helpMenu('home')] };
}
function helpMenu(current) {
  const opts = [{ label: 'Accueil', value: 'home', emoji: '🏠', default: current === 'home' }]
    .concat(Object.entries(HELP_CATS).map(([k, c]) => ({ label: c.label.replace(/^\S+\s/, ''), value: k, emoji: c.label.split(' ')[0], description: c.desc.slice(0, 100), default: current === k })));
  return row(new StringSelectMenuBuilder().setCustomId('help_cat').setPlaceholder('Choisir une catégorie…').addOptions(opts));
}
function helpCategory(key) {
  const c = HELP_CATS[key];
  const lines = c.cmds.map(defOf).filter(Boolean).map((d) => `**/${d.name}** — ${d.description}`);
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(c.label).setDescription(`${c.desc}\n\n${lines.join('\n')}`).setFooter({ text: '/help commande:<nom> pour le détail' });
  return { embeds: [e], components: [helpMenu(key)] };
}
function helpDetail(name) {
  const d = defOf(String(name).replace(/^\//, '').toLowerCase());
  if (!d) return null;
  const opts = (d.options || []).map((o) => `• \`${o.name}\` *(${OPT_TYPES[o.type] || 'valeur'}, ${o.required ? 'obligatoire' : 'optionnel'})* — ${o.description}`);
  const perms = d.default_member_permissions ? new PermissionsBitField(BigInt(d.default_member_permissions)).toArray().join(', ') : 'Aucune (tout le monde)';
  const cmdChan = config.channelId('cmd');
  const where = PUBLIC_ALL.has(d.name) ? (cmdChan ? `<#${cmdChan}> (le Staff peut l'utiliser partout)` : 'Salon des commandes (non configuré : partout)') : 'Tous les salons';
  return new EmbedBuilder().setColor(ui.BLUE).setTitle(`/${d.name}`).setDescription(d.description)
    .addFields(
      { name: 'Utilisation', value: `\`${usage(d)}\`` },
      { name: 'Paramètres', value: opts.length ? opts.join('\n') : 'Aucun' },
      { name: 'Salon autorisé', value: where, inline: true },
      { name: 'Permissions requises', value: perms, inline: true },
    );
}
let PUBLIC_ALL = new Set();
const setPublicAll = (s) => { PUBLIC_ALL = s; };
async function help(i) {
  const name = i.options.getString('commande');
  if (name) {
    const e = helpDetail(name);
    return i.reply(e ? { embeds: [e], ephemeral: true } : err(`Commande inconnue : \`${name}\`. Tape \`/help\` pour la liste.`));
  }
  return i.reply({ ...helpHome(), ephemeral: true });
}

const BADGES = { founder: '👑 Fondateur', staff: '🛡️ Staff', creator: '🛠️ Créateur vérifié', tester: '🧪 Testeur firmware', collector: '📚 Collectionneur' };
const ROLES = { superadmin: 'Superadmin', admin: 'Admin', user: 'Membre' };
async function profil(i) {
  const member = i.options.getMember('membre') || i.member, user = member ? member.user : i.options.getUser('membre') || i.user;
  await i.deferReply();
  try {
    const p = await api.user(user.id);
    const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(p.display_name).setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setDescription(`@${p.username} · membre depuis ${ui.ts(p.created_at, 'D')}`)
      .addFields(
        { name: 'Rôle', value: ROLES[p.role] || 'Membre', inline: true },
        { name: 'Ressources publiées', value: String(p.resources), inline: true },
        { name: 'Bibliothèque', value: p.library == null ? '🔒 Privée' : `${p.library} jeu(x)`, inline: true },
        { name: 'Badges', value: p.badges.length ? p.badges.map((b) => BADGES[b] || b).join('\n') : '—' },
        ...(p.playing ? [{ name: 'En ce moment', value: `🎮 En train de jouer à **${p.playing.name}**` }] : []),
      ).setFooter({ text: `${p.followers} abonné(s)` });
    const site = publicSite(p.site);
    return i.editReply({ embeds: [e], components: site ? [row(linkBtn('Voir le profil', p.url.replace(/^https?:\/\/[^/]+/, site)))] : [] });
  } catch (e) {
    if (e.code === 'not_linked') return i.editReply({ content: `ℹ️ **${user.username}** n'a pas lié son compte PS4Store (connexion avec Discord sur le site).` });
    throw e;
  }
}
async function collectionsCmd(i) {
  await i.deferReply();
  const r = await api.collections();
  if (!r.collections.length) return i.editReply({ content: 'Aucune collection mise en avant pour le moment.' });
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('🗂️ Collections & packs')
    .addFields(r.collections.slice(0, 10).map((c) => ({
      name: `${c.title}${c.badge ? ` · ${c.badge}` : ''} (${c.count})`,
      value: ui.cut(`${c.description ? `${c.description}\n` : ''}${c.games.slice(0, 6).join(' · ')}${c.games.length > 6 ? ` · +${c.games.length - 6}` : ''}`, 1000),
    })));
  const site = publicSite(r.site);
  const btns = site ? r.collections.slice(0, 5).map((c) => linkBtn(ui.cut(c.title, 80), `${site}/catalogue?collection=${c.id}`)) : [];
  return i.editReply({ embeds: [e], components: btns.length ? [row(...btns)] : [] });
}
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const TYPE_SHORT = { pkg: 'Jeu', plugin: 'Mod', payload: 'Payload' };
async function requestsMessage() {
  const list = (await api.requests(5)).slice(0, 5);
  if (!list.length) return { embeds: [new EmbedBuilder().setColor(ui.BLUE).setTitle('📮 Demandes de la communauté').setDescription('Aucune demande ouverte. Utilisez `/demander` pour en proposer une !')], components: [] };
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('📮 Top des demandes de la communauté')
    .setDescription(list.map((r, n) => `${NUM[n]} **${ui.cut(r.title, 70)}** — 👍 **${r.votes}** · ${TYPE_SHORT[r.resource_type] || r.resource_type}${r.title_id ? ` · \`${r.title_id}\`` : ''}`).join('\n'))
    .setFooter({ text: 'Cliquez sur un numéro pour voter (+1) ou retirer votre vote' });
  return { embeds: [e], components: [row(...list.map((r, n) => new ButtonBuilder().setCustomId(`rv|${r.id}`).setStyle(ButtonStyle.Secondary).setEmoji(NUM[n])))] };
}
async function demandes(i) { await i.deferReply(); return i.editReply(await requestsMessage()); }
async function voteButton(i, id) {
  try {
    const r = await api.voteRequest(i.user.id, i.user.username, id);
    await i.update(await requestsMessage());
    return i.followUp({ content: r.voted ? '👍 Vote ajouté !' : 'Vote retiré.', ephemeral: true });
  } catch (e) { return i.reply(err(e.message)); }
}
async function demander(i) {
  await i.deferReply({ ephemeral: true });
  try {
    const r = await api.createRequest(i.user.id, i.user.username, {
      title: i.options.getString('titre'), resource_type: i.options.getString('type') || 'pkg', title_id: i.options.getString('title_id') || '', notes: i.options.getString('notes') || '',
    });
    return i.editReply({ content: `✅ Demande « **${r.request.title}** » enregistrée. Votez et suivez-la avec \`/demandes\`.` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}
const SVC = { web: 'Site Web & Catalogue', console_api: 'API Console & Appairage', dl_proxy: 'Relais .pkg', discord_oauth: 'Discord OAuth2', discord_bot: 'Bot Discord & Webhooks' };
const ST = { operational: ['🟢', 'Opérationnel'], degraded: ['🟠', 'Dégradé'], outage: ['🔴', 'Panne'], unconfigured: ['⚪', 'Non configuré'], checking: ['⚪', 'Vérification…'] };
async function statusCmd(i) {
  await i.deferReply();
  const r = await api.status();
  const color = r.overall === 'outage' ? ui.RED : r.overall === 'degraded' ? ui.ORANGE : r.overall === 'operational' ? ui.GREEN : ui.GREY;
  const title = { operational: 'Tous les systèmes sont opérationnels', degraded: 'Performances dégradées', outage: 'Incident en cours', checking: 'Vérification en cours' }[r.overall] || 'Statut';
  const e = new EmbedBuilder().setColor(color).setTitle(`📡 ${title}`)
    .setDescription(r.services.map((s) => {
      const [em, label] = ST[s.state] || ST.checking;
      const avail = s.avail == null ? '—' : `${String(s.avail).replace('.', ',')} %`;
      return `${em} **${SVC[s.key] || s.key}** — ${label}${s.ms != null && s.state !== 'outage' ? ` · ${s.ms} ms` : ''} · ${avail} sur 30 j`;
    }).join('\n'))
    .setFooter({ text: r.checked_at ? 'Dernière vérification' : 'PS4Store' });
  if (r.checked_at) e.setTimestamp(new Date(r.checked_at));
  const site = publicSite(r.site);
  return i.editReply({ embeds: [e], components: site ? [row(linkBtn('Page de statut', `${site}/status`))] : [] });
}

async function notifier(i) {
  const role = i.guild.roles.cache.get(config.announceRoleId());
  if (!role) return i.reply(err("Le rôle d'annonces est introuvable (ANNOUNCE_ROLE_ID)."));
  try {
    if (i.member.roles.cache.has(role.id)) { await i.member.roles.remove(role, 'Notifications désactivées'); return i.reply({ content: '🔕 Notifications désactivées.', ephemeral: true }); }
    await i.member.roles.add(role, 'Notifications activées');
    return i.reply({ content: `🔔 Notifications activées : tu auras le rôle <@&${role.id}>.`, ephemeral: true, allowedMentions: { parse: [] } });
  } catch (e) { return i.reply(err(`Impossible de modifier le rôle : ${e.message}`)); }
}
async function suggestions(i) {
  const target = await chan(i.guild, 'suggestions');
  if (!target) return i.reply(err("Le salon des suggestions n'est pas configuré : un administrateur doit utiliser `/setup`."));
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('💡 Suggestion').setDescription(i.options.getString('idee'))
    .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() }).setTimestamp();
  const msg = await target.send({ embeds: [e] });
  await msg.react('👍').catch(() => {}); await msg.react('👎').catch(() => {});
  return i.reply({ content: `✅ Merci ! Ta suggestion est publiée : ${msg.url}`, ephemeral: true });
}
async function recap(i) {
  const target = await chan(i.guild, 'annonces');
  if (!target) return i.reply(err("Salon annonces non configuré : utilise `/setup`."));
  await i.deferReply({ ephemeral: true });
  const r = await api.recap();
  const lines = r.new_resources.slice(0, 8).map((g) => `• [${ui.cut(g.titre, 60)}](${g.url}) — v${g.version}`);
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle('📅 Récapitulatif de la semaine')
    .addFields(
      { name: 'Nouveautés', value: `**${r.new_count}** nouvelle(s) ressource(s) · **${r.updated_count}** mise(s) à jour`, inline: false },
      ...(lines.length ? [{ name: 'Derniers ajouts', value: lines.join('\n') }] : []),
      { name: 'Communauté', value: `**${r.new_members}** nouveau(x) membre(s) · ${r.members_total} au total\n${r.resources_total} ressources · ${r.downloads_total} téléchargements`, inline: false },
      ...(r.top_requests.length ? [{ name: 'Demandes en tête', value: r.top_requests.map((q) => `👍 ${q.votes} — ${ui.cut(q.title, 60)}`).join('\n') }] : []),
    ).setTimestamp();
  await target.send({ embeds: [e], allowedMentions: { parse: [] } });
  await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('📅 Récap hebdomadaire publié').setDescription(`<@${i.user.id}> → <#${target.id}>`).setTimestamp());
  return i.editReply({ content: `✅ Récapitulatif publié dans <#${target.id}>.` });
}

async function userinfo(i) {
  const user = i.options.getUser('membre') || i.user;
  const member = i.options.getMember('membre') || (user.id === i.user.id ? i.member : null);
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(user.username).setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'ID', value: `\`${user.id}\``, inline: true },
      { name: 'Compte créé', value: ui.ts(user.createdAt, 'D'), inline: true },
      { name: 'Arrivé sur le serveur', value: member && member.joinedAt ? ui.ts(member.joinedAt, 'D') : '—', inline: true },
      { name: 'Boost', value: member && member.premiumSince ? `Depuis ${ui.ts(member.premiumSince, 'D')}` : 'Non', inline: true },
      { name: `Rôles (${member ? member.roles.cache.size - 1 : 0})`, value: member ? ui.cut([...member.roles.cache.filter((r) => r.id !== i.guild.id).sort((a, b) => b.position - a.position).values()].map((r) => `<@&${r.id}>`).join(' ') || '—', 1000) : '—' },
    );
  return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
}
async function serverinfo(i) {
  const g = i.guild;
  const e = new EmbedBuilder().setColor(ui.BLUE).setTitle(g.name).setThumbnail(g.iconURL({ size: 256 }))
    .addFields(
      { name: 'Propriétaire', value: `<@${g.ownerId}>`, inline: true },
      { name: 'Créé', value: ui.ts(g.createdAt, 'D'), inline: true },
      { name: 'Membres', value: String(g.memberCount), inline: true },
      { name: 'Boost', value: `Niveau ${g.premiumTier} · ${g.premiumSubscriptionCount || 0} boost(s)`, inline: true },
      { name: 'Salons', value: String(g.channels.cache.size), inline: true },
      { name: 'Rôles', value: String(g.roles.cache.size), inline: true },
    ).setFooter({ text: `ID ${g.id}` });
  return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
}

async function say(i) {
  const target = i.options.getChannel('salon') || i.channel;
  if (!isText(target)) return i.reply(err('Choisis un salon textuel.'));
  await i.deferReply({ ephemeral: true });
  try {
    await target.send({ content: nl(i.options.getString('message')), allowedMentions: { parse: [] } });
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('🗣️ /say').setDescription(`<@${i.user.id}> dans <#${target.id}> :\n${ui.cut(nl(i.options.getString('message')), 900)}`).setTimestamp());
    return i.editReply({ content: `✅ Message envoyé dans <#${target.id}>.` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}
async function embedCmd(i) {
  const target = i.options.getChannel('salon') || i.channel;
  if (!isText(target)) return i.reply(err('Choisis un salon textuel.'));
  const colorIn = (i.options.getString('couleur') || '0070D1').replace(/^#/, '');
  const image = i.options.getString('image_url');
  if (!/^[0-9a-f]{6}$/i.test(colorIn)) return i.reply(err('Couleur invalide : 6 caractères hexadécimaux (ex. 0070D1).'));
  if (image && !/^https:\/\/\S+$/i.test(image)) return i.reply(err("L'image doit être une adresse https://…"));
  await i.deferReply({ ephemeral: true });
  try {
    const e = new EmbedBuilder().setColor(parseInt(colorIn, 16)).setTitle(i.options.getString('titre')).setDescription(nl(i.options.getString('description')));
    if (image) e.setImage(image);
    await target.send({ embeds: [e], allowedMentions: { parse: [] } });
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('📝 /embed').setDescription(`<@${i.user.id}> dans <#${target.id}> : **${ui.cut(i.options.getString('titre'), 100)}**`).setTimestamp());
    return i.editReply({ content: `✅ Embed envoyé dans <#${target.id}>.` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}

const giveaways = store('giveaways');
const timers = new Map();
const gwMessage = (g, ended, winnersText) => {
  const e = new EmbedBuilder().setColor(ended ? ui.GREY : 0xF1C40F).setTitle(`🎉 ${g.prize}`)
    .setDescription(ended ? (winnersText || 'Aucun participant.') : `Clique sur **Participer** pour tenter ta chance !\nFin ${ui.ts(new Date(g.end).toISOString(), 'R')}`)
    .addFields({ name: 'Gagnants', value: String(g.winners), inline: true }, { name: 'Participants', value: String(g.participants.length), inline: true }, { name: 'Organisé par', value: `<@${g.host}>`, inline: true })
    .setFooter({ text: ended ? 'Concours terminé' : 'Fin du concours' }).setTimestamp(new Date(g.end));
  return { embeds: [e], components: [row(new ButtonBuilder().setCustomId(`gw|${g.id}`).setStyle(ButtonStyle.Success).setLabel('🎉 Participer').setDisabled(!!ended))] };
};
function schedule(client, id) {
  const g = giveaways.load()[id];
  if (!g || g.ended) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => endGiveaway(client, id).catch((e) => console.error('[Bot] giveaway :', e)), Math.min(Math.max(0, g.end - Date.now()), 2 ** 31 - 1)));
}
async function endGiveaway(client, id) {
  const all = giveaways.load(), g = all[id];
  if (!g || g.ended) return;
  if (Date.now() < g.end - 1000) return schedule(client, id);
  g.ended = true;
  const pool = g.participants.slice(), won = [];
  while (pool.length && won.length < g.winners) won.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  g.won = won; giveaways.save(all); timers.delete(id);
  const channel = await client.channels.fetch(g.channel).catch(() => null);
  if (!channel) return;
  const text = won.length ? `🏆 ${won.map((u) => `<@${u}>`).join(', ')}` : null;
  const msg = await channel.messages.fetch(g.message).catch(() => null);
  if (msg) await msg.edit(gwMessage(g, true, text)).catch(() => {});
  await channel.send({
    content: won.length ? `🎉 Félicitations ${won.map((u) => `<@${u}>`).join(', ')} ! Vous avez gagné **${g.prize}**.` : `😕 Concours « ${g.prize} » terminé : aucun participant.`,
    allowedMentions: { users: won }, reply: msg ? { messageReference: msg.id, failIfNotFound: false } : undefined,
  }).catch(() => {});
}
async function giveaway(i) {
  const target = i.options.getChannel('salon') || i.channel;
  if (!isText(target)) return i.reply(err('Choisis un salon textuel.'));
  await i.deferReply({ ephemeral: true });
  try {
    const g = { id: crypto.randomBytes(4).toString('hex'), channel: target.id, prize: i.options.getString('lot'), winners: i.options.getInteger('gagnants'), end: Date.now() + i.options.getInteger('duree_minutes') * 60000, host: i.user.id, participants: [], ended: false };
    const msg = await target.send(gwMessage(g, false));
    g.message = msg.id;
    const all = giveaways.load(); all[g.id] = g; giveaways.save(all);
    schedule(i.client, g.id);
    await logStaff(i.guild, new EmbedBuilder().setColor(ui.GREY).setTitle('🎉 Giveaway lancé').setDescription(`<@${i.user.id}> : **${g.prize}** (${g.winners} gagnant(s)) dans <#${target.id}>`).setTimestamp());
    return i.editReply({ content: `✅ Concours lancé : ${msg.url}` });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}
async function joinGiveaway(i, id) {
  const all = giveaways.load(), g = all[id];
  if (!g || g.ended || Date.now() >= g.end) return i.reply(err('Ce concours est terminé.'));
  const at = g.participants.indexOf(i.user.id);
  if (at === -1) g.participants.push(i.user.id); else g.participants.splice(at, 1);
  giveaways.save(all);
  await i.update(gwMessage(g, false));
  return i.followUp({ content: at === -1 ? '🎉 Participation enregistrée, bonne chance !' : 'Participation retirée.', ephemeral: true });
}

async function setRole(i, add) {
  const member = i.options.getMember('membre'), role = i.options.getRole('role');
  if (!member) return i.reply(err("Ce membre n'est pas sur le serveur."));
  const me = i.guild.members.me;
  if (role.id === i.guild.id || role.managed) return i.reply(err('Ce rôle ne peut pas être attribué manuellement.'));
  if (role.position >= me.roles.highest.position) return i.reply(err('Ce rôle est au-dessus (ou au niveau) du mien.'));
  if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) return i.reply(err('Ce rôle est au-dessus (ou au niveau) du tien.'));
  await i.deferReply({ ephemeral: true });
  try {
    if (add) await member.roles.add(role, `Par ${i.user.username}`); else await member.roles.remove(role, `Par ${i.user.username}`);
    await logStaff(i.guild, new EmbedBuilder().setColor(add ? ui.GREEN : ui.ORANGE).setTitle(add ? '➕ Rôle ajouté' : '➖ Rôle retiré')
      .setDescription(`<@${i.user.id}> : <@&${role.id}> ${add ? 'ajouté à' : 'retiré de'} <@${member.id}>`).setTimestamp());
    return i.editReply({ content: `✅ Rôle **${role.name}** ${add ? 'ajouté à' : 'retiré de'} **${member.user.username}**.`, allowedMentions: { parse: [] } });
  } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
}

const handlers = {
  help, profil, collections: collectionsCmd, demandes, demander, status: statusCmd, notifier, suggestions, userinfo, serverinfo, say, embed: embedCmd, giveaway,
  'add-role': (i) => setRole(i, true), 'remove-role': (i) => setRole(i, false), 'recap-hebdo': recap,
};
async function onButton(i) {
  const id = i.customId;
  if (id.startsWith('rv|')) { await voteButton(i, id.slice(3)); return true; }
  if (id.startsWith('gw|')) { await joinGiveaway(i, id.slice(3)); return true; }
  return false;
}
async function onSelect(i) {
  if (i.customId !== 'help_cat') return false;
  const v = i.values[0];
  await i.update(HELP_CATS[v] ? helpCategory(v) : helpHome());
  return true;
}
async function autocomplete(i) {
  if (i.commandName !== 'help') return false;
  const q = String(i.options.getFocused()).toLowerCase().replace(/^\//, '');
  await i.respond(ALL.filter((d) => d.name.includes(q)).slice(0, 25).map((d) => ({ name: `/${d.name} — ${d.description}`.slice(0, 100), value: d.name })));
  return true;
}
function onReady(client) { Object.values(giveaways.load()).filter((g) => !g.ended).forEach((g) => schedule(client, g.id)); }

module.exports = { definitions, handlers, PUBLIC_EXTRA, STAFF_EXTRA, setDefinitions, setPublicAll, onButton, onSelect, autocomplete, onReady };
