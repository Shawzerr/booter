# Discord Name Scanner

Scanne les pseudos Discord courts (2, 3, 4 lettres…) et envoie chaque nom
disponible sur un webhook Discord.

## Installation

Node 18+ requis, aucune dépendance.

## Webhook

Crée un webhook (Paramètres du salon → Intégrations → Webhooks), puis :

```bash
# option 1 : fichier .env (ignoré par git)
echo 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/ID/TOKEN' > .env

# option 2 : en argument
node scanner.js --webhook "https://discord.com/api/webhooks/ID/TOKEN"
```

Ne partage jamais l'URL du webhook : quiconque la possède peut poster dans ton salon.

## Utilisation

Par défaut (`--style mix`), le scanner ignore les noms qui ressemblent à des mots (`sova`, `nova`…)
et cherche des mélanges comme `_tr`, `k7f`, `x.q`, `qzk` (1 symbole `_` ou `.` maximum), bien plus souvent libres.

```bash
node scanner.js                    # 3 et 4 caractères, toutes combinaisons (a-z 0-9 _ .)
node scanner.js --len 3             # seulement 3 caractères (le plus rapide)
node scanner.js --charset letters  # seulement a-z
node scanner.js --charset alnum    # lettres + chiffres
node scanner.js --style any        # inclut aussi les noms prononçables (nova, kiro…)
node scanner.js --order smart      # défaut : apprend quelles formes de pseudos sont les plus souvent libres
node scanner.js --order random     # ordre aléatoire uniforme
node scanner.js --order seq        # ordre alphabétique aaa, aab, aac…
node scanner.js --help             # toutes les options
```

Les résultats sont dans `results/` (`available.txt`, `checked.txt`).
Ctrl+C arrête proprement ; relancer la commande reprend là où le scan s'était arrêté.

## Rate limit de Discord

Si Discord te limite (attente de plusieurs minutes), le scanner affiche un compte à rebours et ralentit son rythme.
Pendant l'attente :
- **change de connexion** (Wi-Fi, partage de connexion, coupure puis retour…) : il le détecte, envoie une requête de test et affiche « toujours limité » ou « plus limité » ;
- **Entrée** : réessaie tout de suite ;
- **Ctrl+C** : arrête proprement. Ta progression est sauvegardée dans `results/`.
