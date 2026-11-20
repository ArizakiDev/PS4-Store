# PS4Store — Discord Rich Presence

Affiche sur votre profil Discord **« Joue à <jeu> sur PS4 »** (jaquette + chronomètre) quand vous lancez un jeu depuis PS4Store.

## Mise en route

1. Sur le site : **Mon compte** → copiez votre **jeton Discord Rich Presence**.
2. Sur [discord.com/developers/applications](https://discord.com/developers/applications), créez une application (son nom apparaît dans « Joue à … ») et copiez son **Application ID**.
3. Lancez `start-rpc.bat` (Windows) et collez l'adresse du serveur, le jeton et l'Application ID. Ils sont mémorisés dans `config.json`.
   Ailleurs : `node index.js --server=http://… --token=… --client=…` (ou variables `PS4STORE_URL`, `PS4STORE_RPC_TOKEN`, `DISCORD_CLIENT_ID`).

Aucune dépendance npm : Node.js 18+ suffit. Discord doit tourner sur le même ordinateur.

## Limites à connaître

- L'activité vient de PS4Store : seul un jeu **lancé depuis PS4Store** (bouton « Lancer » de la console ou du site) est détecté. Elle s'arrête quand PS4Store est rouvert sur la console (ou après 8 h).
- Discord télécharge la jaquette depuis l'adresse publique du serveur : si le serveur n'est joignable que sur votre réseau local, la jaquette peut ne pas s'afficher (le texte, lui, s'affiche toujours).
