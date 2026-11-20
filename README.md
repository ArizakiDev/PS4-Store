# PS4Store

Boutique communautaire de ressources PS4 : site (Express/EJS), bot Discord, client PS4 et client compagnon Rich Presence.

| Dossier | Contenu |
|---|---|
| `server/` | Site web et API. `npm install` puis `node server.js` (ou `start.bat`). Copier `.env.example` en `.env`. |
| `discord-bot/` | Bot Discord (discord.js v14). `npm install`, copier `.env.example` en `.env`, puis `node index.js` (ou `start-bot.bat`). |
| `ps4-client/` | Client PS4 (C++/SDL2, OpenOrbis). Voir son README et `setup-deps.bat` / `build.bat`. Adapter `DEFAULT_SERVER_URL` dans `src/config.h`. |
| `companion-rpc/` | Rich Presence Discord pour PC. |
| `locales/` | Traductions fr/en/es partagées par le site. |

Le dossier `data/` du serveur et du bot est créé automatiquement au premier lancement.
