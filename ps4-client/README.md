# PS4Store — client PS4 (C++ / SDL2 / OpenOrbis)

Application homebrew qui lit le catalogue du serveur (`GET /api/games`), affiche les jaquettes et
envoie les installations au **gestionnaire de téléchargements du système (BGFT)**. Elle bloque aussi,
tant qu'elle tourne, les domaines PlayStation / Sony pour éviter toute mise à jour firmware accidentelle.

## État de ce code

Écrit **sans accès à une console ni au toolchain** : il n'a pas été compilé avec OpenOrbis ni exécuté.
Vérifié : compilation + édition de liens + `.pkg` avec les outils officiels OpenOrbis v0.5.4 (LLVM 18, SDL2 inclus)
(non exécuté sur console ; `build.bat` lui-même n'a pas été lancé sous Windows). Auparavant : g++ avec de faux en-têtes, et tests unitaires de l'analyseur JSON, de l'analyse d'en-tête `.pkg` / réécriture d'URL,
et de la logique du répondeur DNS. Attendez-vous à quelques corrections à la première compilation.

Points fragiles (non vérifiables sans console), tous isolés :

| Fichier | Point à vérifier |
|---|---|
| `src/installer.cpp` | Disposition des structures `libSceBgft` (`BgftParam`, `BgftProgress`) et codes d'erreur ; icône passée comme chemin de fichier local. |
| `src/dns_block.cpp` | `sceNetSetDnsInfoToKernel`, sockets `libSceNet`, option `SO_RCVTIMEO`. |
| `src/platform.cpp` | Syscall GoldHEN 500 (commande 2), noms de l'API libjbc, initialisation `libSceNet/Ssl/Http`. |
| `src/input.cpp` | Lecture de la manette via `scePadReadState`. |
| `build.bat` | Validé en shell sur le toolchain Linux v0.5.4 ; à confirmer sous Windows. |
| `src/http.cpp` | Client libSceHttp (remplace libcurl) : redirections manuelles, Range, SSL sans vérification. |

## Fonctionnement

### Installation via BGFT (`installer.*`, `downloader.*`)

Touche **Croix** sur la fiche d'un titre :

1. lecture des 4 premiers Ko du `.pkg` par requête HTTP **Range** (jamais de fichier complet en mémoire) ;
2. analyse de l'en-tête : content id, type (jeu, contenu additionnel, mise à jour) et taille ;
3. `sceBgftServiceIntDownloadRegisterTask` avec l'URL externe (`pkg_url`), le titre, l'identifiant de contenu
   et l'icône (la jaquette déjà en cache, issue de `icon_url`), puis `sceBgftServiceDownloadStartTask` ;
4. une notification confirme l'envoi. La console télécharge et installe en arrière-plan
   (Notifications › Téléchargements) : on peut continuer à naviguer, ou quitter la boutique.

Un thread de suivi affiche discrètement l'avancement dans la barre du bas, arrête une tâche qui
télécharge un autre paquet que celui du lien, et signale les erreurs.

Contraintes à connaître :

- **Le serveur qui héberge les `.pkg` doit gérer les requêtes Range** (HTTP 206). Sinon l'envoi est refusé
  avec un message explicite. (Un `python -m http.server` ne convient pas ; nginx, Caddy, GitHub Releases, oui.)
- BGFT exige une URL finissant par `.pkg` : sinon `?f=<content_id>.pkg` est ajouté (ignoré par les serveurs).
- `RegisterTaskByStorageEx` refuse les URL ; c'est l'enregistrement `IntDownloadRegisterTask` qui est utilisé.
- Le `title_id` saisi dans le tableau de bord n'est pas bloquant : l'identifiant de contenu du `.pkg` fait foi.

## Interface PlayStation Blue (PS4 Flow)

- **Fond** (`background.*`) : dégradé #030B1C → #0A2B6E → #00439C, rubans lumineux animés (#0070D1 / #2E9BFF),
  particules, et la jaquette du jeu sélectionné (vignette floue 32x32 fournie par `ImageCache::getTiny`) en fondu sous
  un voile bleu sombre. Le fond est composé sur le CPU en 480x270 seulement au changement de sélection, puis étiré en
  blit opaque.
- **Qualité adaptative** (0..3) : si l'image moyenne dépasse 21 ms sur 90 images, un effet est coupé (fondu de
  jaquette, particules, rubans, ombres) et ce niveau est plafonné ; chaque changement est écrit dans `boot.log`
  (« ui: image moyenne ... qualite des effets »). Le moteur SDL est logiciel : le 60 images/s n'est pas garanti.
- **Cartes** : zoom 1.06, halo blanc/cyan pulsant, reflet, ombre portée. **Icônes** DualShock 4 vectorielles
  (`drawPsButtonIcon`), pilules L1/R1/OPTIONS. **Panneaux** : verre bleu nuit rgba(8,24,58,.92), liseré #0072CE.
- L'en-tête (onglets, pastille DNS) n'a pas bougé.

## Multitâche (suspension) et jeux installés

### Mise en arrière-plan (`main.cpp`, `platform.*`, `http.*`, `image_cache.*`)

La boucle principale vide à chaque image les événements du service système (`sceSystemServiceReceiveEvent`) et
interroge l'état « arrière-plan » (`sceSystemServiceGetStatus`, toutes les 0,5 s, deux relevés consécutifs requis).

- **Pause** : plus de rendu ni de lecture de manette (`SDL_Delay(200)`), requêtes HTTP actives interrompues
  (`sceHttpAbortRequest`) et refusées tant que l'app est en arrière-plan, envoi en préparation annulé, **toutes** les
  textures (jaquettes, grands formats) et images décodées en attente libérées. Les téléchargements BGFT déjà envoyés
  continuent : ils appartiennent au système.
- **Reprise** : rendu normal, jaquettes rechargées depuis le cache disque, état des jeux installés relu, catalogue
  rafraîchi s'il était hors ligne.
- Filet de sécurité : un saut d'horloge > 3 s (processus gelé par la console) est traité comme une reprise.
- **Point à vérifier sur console** : le SDK public ne définit que `ON_RESUME` (0x10000000). Il n'y a pas
  d'événement `ON_PAUSE` connu : la pause est donc détectée par l'état du service système. Si vous trouvez le code
  d'un événement de pause, compilez avec `-DPS4STORE_EVT_ON_PAUSE=0x...`. Les codes d'événements inconnus sont écrits
  dans `boot.log` (« evenement systeme non gere »), ainsi que chaque PAUSE / REPRISE (« cycle de vie »).
- `build.bat` : `CATEGORY=gd` et `APP_TYPE=1` sont explicites ; `ATTRIBUTE` vaut 0 par défaut et se surcharge avec
  `set SFO_ATTRIBUTE=...` avant de lancer `build.bat`.

### Jeux installés (`installed.*`, `ui.cpp`)

Un titre est « installé » si `/user/app/<TITLE_ID>/app.pkg` existe ; sa version vient de la clé `VERSION` du
`param.sfo` (essais : `/system_data/priv/app/<ID>/sce_sys/param.sfo`, `/user/appmeta/<ID>/param.sfo`, puis deux
emplacements de repli). Comparée à la `version` du serveur :

| État | Badge | Boutons |
|---|---|---|
| Non installé | — | Croix : **Installer** (BGFT) |
| À jour | vert « Installé (vX.XX) » | Croix : **Lancer** · Carré : **Désinstaller** |
| Version inférieure | orange « Mise à jour dispo (vX.XX → vY.YY) » | Croix : **Mettre à jour** (BGFT) · Carré : **Désinstaller** |

Le dernier onglet **Installés** (L1/R1) ne liste que les jeux du catalogue présents sur la console. La
désinstallation demande une confirmation (Croix / Rond). L'état est relu au démarrage, à chaque actualisation
(Triangle), à la reprise, et toutes les 8 s pendant et 90 s après un téléchargement système.

À vérifier sur console : emplacement réel du `param.sfo`, comportement de BGFT pour une mise à jour d'un titre déjà
installé, et signature de `sceSystemServiceLaunchApp` (déclarée localement : l'en-tête OpenOrbis v0.5.4 la déclare
sans paramètres).

### Protection DNS (`dns_block.*`)

Au démarrage (après le jailbreak et l'initialisation réseau), un petit répondeur DNS local (127.0.0.1:53)
est lancé et le DNS du noyau est redirigé vers lui. Les noms contenant `playstation`, `.sony` ou
`sonyentertainmentnetwork` reçoivent `0.0.0.0` (mises à jour firmware, télémétrie, PSN) ; tout le reste
est relayé vers votre vrai DNS. L'indicateur **« Protection DNS active »** (vert) apparaît en haut à droite ;
sinon « Protection DNS inactive ».

- Le DNS d'origine est restauré à la fermeture normale de l'application.
- Il est aussi sauvegardé dans `/data/PS4Store/dns_backup.txt` : si l'application est tuée sans nettoyage
  (le réseau de la console semble alors mort), **relancez PS4Store** — le DNS est restauré au démarrage —
  ou redémarrez la console. La redirection n'est de toute façon pas persistante.
- Tant que la protection est active, **le PSN ne fonctionne pas** (c'est voulu).
- Les téléchargements BGFT passent aussi par ce DNS : si votre hébergeur de `.pkg` a un nom contenant
  `playstation` ou `.sony`, il sera bloqué.

### Jailbreak

`platform::jailbreak()` utilise d'abord l'appel système de **GoldHEN** (syscall 500, commande 2), puis
**libjbc** si `external/libjbc/jbc.h` est présent. Sans l'un des deux, ni l'installation ni la protection DNS
ne sont possibles (le catalogue reste consultable).

## Prérequis

1. **OpenOrbis PS4 Toolchain**, variable `OO_PS4_TOOLCHAIN` définie.
2. **SDL2** : fourni par le toolchain (`lib\libSDL2.a`). Aucune libcurl requise (HTTP via `libSceHttp`).
   Si besoin d'autres bibliothèques : `set EXTRA_LIBS=-lSceFreeType ...`.
3. **stb** : `setup-deps.bat` télécharge `stb_image.h` et `stb_truetype.h`.
4. **Police** : une police TTF libre (ex. Inter, licence OFL) dans `assets/fonts/font.ttf`.
5. *(optionnel)* **libjbc** dans `external/libjbc/` comme repli du syscall GoldHEN.

Bibliothèques liées par `build.bat` : `c`, `kernel`, `c++`, `SDL2`, `SceUserService`, `ScePad`,
`SceNet`, `SceSsl`, `SceHttp`, `SceSystemService`, `SceAppInstUtil`, `SceBgft`, `SceVideoOut`, `SceAudioOut`, `SceSysmodule`.

Important : compiler en `-std=gnu++17` (pas `c++17`) — le mode ISO strict masque `nanosleep`, `locale_t`, etc. dans la libc musl d'OpenOrbis.

## Configuration

Dans `src/config.h`, modifiez `DEFAULT_SERVER_URL` avant de compiler. Au premier lancement,
`/data/PS4Store/config.json` est créé ; vous pourrez ensuite y changer `server_url` sans recompiler.

## Compilation

```bat
setup-deps.bat
build.bat
```

Produit `PS4Store.pkg` (copié aussi dans `server/public/store/`). `param.sfo` déclare
`SYSTEM_VER = 0x05050000` (5.05).

## Commandes

| Touche | Action |
|---|---|
| L1 / R1 | Onglet firmware précédent / suivant |
| Croix directionnelle / stick gauche | Parcourir les jeux |
| Croix | Ouvrir la fiche ; dans la fiche, envoyer l'installation à la console |
| Rond | Fermer la fiche / annuler l'envoi en cours de préparation |
| Triangle | Actualiser le catalogue et les jaquettes |

## Fichiers

- `src/main.cpp` — initialisation, boucle 60 FPS
- `src/ui.*`, `src/text.*`, `src/anim.h` — interface, texte (stb_truetype), interpolation exponentielle
- `src/installer.*`, `src/downloader.*` — BGFT : en-tête `.pkg`, enregistrement, suivi
- `src/dns_block.*` — protection DNS
- `src/catalog.*`, `src/json.*`, `src/image_cache.*`, `src/http.*` — catalogue, cache, client HTTP libSceHttp
- `src/platform.*`, `src/config.*`, `src/input.*` — système, configuration, manette

## Crédits et licence

L'approche BGFT (lecture de l'en-tête, paramètres d'enregistrement, garde-fou sur la taille) et le principe
du blocage DNS s'inspirent du lanceur `Launcher` du dépôt orbiskate (git.lbxmb.fr/interverti/orbiskate),
lui-même placé sous **GPL-3.0-or-later**. Le code ici est une réécriture indépendante (pas de copie de
fichier) ; si vous y reprenez un jour du code de ce dépôt tel quel, la GPL s'appliquera à ce que vous
distribuez.
