# Overlay RL — by SourOneee

Prototype Windows pour suivre automatiquement les victoires, défaites, séries et MMR d'une session Rocket League.

## Suivi automatique

- Configure les Stats API de Rocket League au démarrage en cherchant l'installation du jeu.
- Reconnaît le compte local dans les événements de match à partir des comptes Epic ou Steam enregistrés sur ce PC. Quand Steam est ouvert, Overlay RL privilégie le compte Steam actuellement actif.
- Démarre le suivi à la première partie classée détectée et choisit automatiquement le mode 1v1, 2v2 ou 3v3.
- Affiche l'overlay au lancement et détecte les résultats depuis le Stats API local.
- Récupère le MMR via le relais communautaire fourni, puis réessaie automatiquement après les matchs.
- Affiche, pour le mode choisi, l'emblème du rang et la progression vers le rang suivant à partir des données Tracker.
- Permet de choisir un objectif de session de +25, +50 ou +100 MMR et affiche la progression dans Overlay RL et l'overlay.
- Permet de choisir parmi trois styles d'overlay, de régler sa taille et de décaler sa position horizontalement et verticalement.
- Affiche en option un overlay de manette compatible DualSense : sticks animés, croix directionnelle, boutons, gâchettes et clics de stick.
- Laisse déplacer l'overlay manette à la souris depuis sa barre supérieure ; une fois verrouillé, il laisse passer les clics vers Rocket League.

Au premier lancement, ferme puis relance Rocket League pour que le jeu relise son fichier Stats API. Après ça, Overlay RL n'a pas besoin d'un pseudo ou d'un MMR saisi à la main. Pour la détection automatique du compte, l'identifiant Rocket League doit correspondre à un compte Epic ou Steam enregistré localement sur ce PC.

La connexion au jeu reste locale, sur 127.0.0.1:49124, via le WebSocket Stats API. La [documentation officielle Rocket League](https://www.rocketleague.com/developer/stats-api?lang=en) décrit les réglages et événements.

## MMR et confidentialité

Le Stats API officiel donne les résultats et identifiants des joueurs, mais pas leur MMR. Tracker indique ne pas proposer d'API Rocket League aux développeurs ([documentation développeur](https://tracker.gg/developers/docs/), [réponse du support Tracker](https://feedback.tracker.gg/t/is-there-anyway-to-get-api-access/21648)).

Pour Steam, Overlay RL lit le MMR depuis l'endpoint web public utilisé par Tracker, en se basant sur le SteamID64 détecté dans les événements du jeu. Il s'agit d'un endpoint non officiel, susceptible de changer. Si cette lecture échoue, Overlay RL essaie le relais communautaire de secours. Les deux services reçoivent l'identifiant du joueur et son pseudo. Une mise à jour Tracker peut être retardée ou bloquée ; Overlay RL réessaie automatiquement. Si un seul match est couvert par un relevé mis à jour, sa variation est observée. Si plusieurs matchs sont couverts, Overlay RL estime leur répartition tout en conservant le total lu sur Tracker. Si aucun changement n'est visible après 15 minutes, une valeur de 0 est explicitement marquée comme estimation pour un seul match ; dans les autres cas Overlay RL continue d'attendre un relevé exploitable.

La connexion locale au Stats API est vérifiée, mais une vraie partie reste nécessaire pour confirmer la détection du compte et des résultats sur cette installation. Le relais Tracker est non officiel et peut changer ou cesser de répondre.

Pour afficher la manette, ouvre **Overlay**, active l'overlay manette, puis appuie une fois sur un bouton de la manette si elle reste en attente. Clique sur **Déplacer l'overlay**, glisse la barre supérieure, puis verrouille le placement avec ✓. Le widget est transparent, toujours au-dessus du jeu et ignore la souris hors du mode déplacement.

## Commandes développeur

    npm install
    npm start
    npm run dist

`npm run dist` crée l'installateur Windows dans le dossier parent `outputs`, puis le prépare dans le dossier de mise à jour locale d'Overlay RL.

Pour publier une nouvelle version de l'application sur ce PC, utilise plutôt :

    npm run release

Cette commande augmente automatiquement le numéro de version (`patch`), crée l'installateur et prépare la mise à jour locale. Au prochain lancement d'Overlay RL, l'application proposera **Mettre à jour** et redémarrera après l'installation. Les réglages et les données de session restent dans le dossier utilisateur de l'application.

### Mises à jour en ligne

Overlay RL vérifie la dernière **GitHub Release** de `t9752709-ux/RL` et peut télécharger l'installateur correspondant. Le dépôt est public. Chaque release stable doit inclure ces deux fichiers : `Overlay-RL-Setup-vX.Y.Z.exe` et `Overlay-RL-Setup-vX.Y.Z.exe.sha256`.

`npm run release` crée ces fichiers dans le dossier parent `outputs` et augmente le numéro de version. Publie les deux fichiers comme assets d'une GitHub Release dans `t9752709-ux/RL`, avec un tag correspondant (`vX.Y.Z`). Les installations configurées vérifieront la release au démarrage et proposeront le téléchargement si sa version est plus récente.
