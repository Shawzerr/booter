#!/usr/bin/env node
/**
 * Discord username scanner (3 / 4 caractères)
 *
 * Vérifie la disponibilité de pseudos Discord via l'endpoint public
 * d'inscription (aucun token requis) :
 *   POST /api/v9/unique-username/username-attempt-unauthed  { username }
 *   -> { "taken": true | false }
 *
 * Usage : node scanner.js [options]   (voir --help)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ───────────────────────── .env (optionnel) ─────────────────────────
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de .env */ }

const WEBHOOK_RE = /^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|(ptb\.|canary\.)?discord(app)?\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

// ───────────────────────── Options ─────────────────────────
const HELP = `
Discord username scanner

  node scanner.js [options]

Options
  --len <3|4|3,4>      Longueurs à scanner                (défaut : 2,3)
  --charset <set>      letters  = a-z
                       alnum    = a-z + 0-9
                       all      = a-z 0-9 _ .  (toutes les combinaisons Discord)             (défaut : all)
  --delay <ms>         Pause entre deux requêtes          (défaut : 1500)
  --jitter <ms>        Aléa ajouté à la pause             (défaut : 500)
  --order <mode>       smart  = apprend où se trouvent les noms libres (défaut)
                       random = ordre aléatoire uniforme
                       seq    = ordre alphabétique aaa, aab, aac…
  --shuffle            Alias de --order random
  --list <fichier>     Scanner uniquement les noms d'un fichier (1 par ligne)
  --webhook <url>      Webhook Discord qui reçoit chaque nom libre
                       (ou variable DISCORD_WEBHOOK_URL / fichier .env)
  --out <dossier>      Dossier des résultats              (défaut : ./results)
  --limit <n>          S'arrêter après n requêtes
  --fresh              Ignorer la sauvegarde et tout recommencer
  --help               Afficher cette aide

Résultats (dans le dossier --out)
  available.txt        noms libres
  checked.txt          tous les noms déjà testés (permet la reprise)

Ctrl+C arrête proprement ; relancez la même commande pour reprendre.
`;

function parseArgs(argv) {
  const o = {
    len: [2, 3], charset: 'all', delay: 1500, jitter: 500,
    order: 'smart', list: null, out: path.join(__dirname, 'results'),
    limit: Infinity, fresh: false,
    webhook: process.env.DISCORD_WEBHOOK_URL || null,
  };
  const need = (i, name) => {
    if (argv[i + 1] === undefined) die(`Valeur manquante pour ${name}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      case '--len': o.len = need(i++, a).split(',').map(Number); break;
      case '--charset': o.charset = need(i++, a); break;
      case '--delay': o.delay = Number(need(i++, a)); break;
      case '--jitter': o.jitter = Number(need(i++, a)); break;
      case '--order': o.order = need(i++, a); break;
      case '--shuffle': o.order = 'random'; break;
      case '--list': o.list = need(i++, a); break;
      case '--webhook': o.webhook = need(i++, a); break;
      case '--out': o.out = path.resolve(need(i++, a)); break;
      case '--limit': o.limit = Number(need(i++, a)); break;
      case '--fresh': o.fresh = true; break;
      default: die(`Option inconnue : ${a}\n${HELP}`);
    }
  }
  if (o.len.some((n) => !Number.isInteger(n) || n < 2 || n > 6)) die('--len : entiers entre 2 et 6');
  if (!['smart', 'random', 'seq'].includes(o.order)) die('--order : smart | random | seq');
  if (![ 'letters', 'alnum', 'all' ].includes(o.charset)) die('--charset : letters | alnum | all');
  if (o.webhook && !WEBHOOK_RE.test(o.webhook)) die('Webhook invalide (attendu : https://discord.com/api/webhooks/<id>/<token>)');
  if (!(o.delay >= 0) || !(o.jitter >= 0)) die('--delay / --jitter doivent être >= 0');
  return o;
}

function die(msg) { console.error(msg); process.exit(1); }

// ───────────────────────── Génération des noms ─────────────────────────
const SETS = {
  letters: 'abcdefghijklmnopqrstuvwxyz',
  alnum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  all: 'abcdefghijklmnopqrstuvwxyz0123456789_.',
};

// Règles Discord : a-z 0-9 _ . uniquement, pas deux "." consécutifs.
const isValid = (n) => /^[a-z0-9_.]+$/.test(n) && !n.includes('..');

function* generate(lengths, chars) {
  for (const len of lengths) {
    const idx = new Array(len).fill(0);
    for (;;) {
      const name = idx.map((k) => chars[k]).join('');
      if (isValid(name)) yield name;
      let p = len - 1;
      while (p >= 0 && ++idx[p] === chars.length) idx[p--] = 0;
      if (p < 0) break;
    }
  }
}

// ───────────────────────── Sélection intelligente ─────────────────────────
// Chaque nom a une "forme" : L = lettre, D = chiffre, S = symbole (_ .), ex. "abc" -> LLL,
// "a_7" -> LSD. Le sélecteur ne reteste jamais un nom déjà testé, et apprend en continu
// quelles formes donnent le plus de noms libres pour y concentrer ses requêtes
// (bandit epsilon-greedy), tout en continuant d'explorer les autres.
const CLASSES = { L: 'abcdefghijklmnopqrstuvwxyz', D: '0123456789', S: '_.' };
const CLASSES_FOR = { letters: ['L'], alnum: ['L', 'D'], all: ['L', 'D', 'S'] };
const classOf = (ch) => (ch >= 'a' && ch <= 'z' ? 'L' : ch >= '0' && ch <= '9' ? 'D' : 'S');
const shapeOf = (name) => [...name].map(classOf).join('');

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function makeSmartPicker({ lengths, charset, order, done, availableSet, epsilon = 0.2 }) {
  // Une entrée par forme. Les noms d'une forme sont parcourus dans un ordre pseudo-aléatoire
  // (permutation affine i -> (a*i + b) mod N) : aucune liste en mémoire, aucun doublon.
  const shapes = new Map();
  const build = (prefix, len) => {
    if (prefix.length === len) {
      const sets = [...prefix].map((c) => CLASSES[c]);
      const N = sets.reduce((t, st) => t * st.length, 1);
      let a; do { a = 1 + Math.floor(Math.random() * (N - 1 || 1)); } while (gcd(a, N) !== 1);
      shapes.set(prefix, { pattern: prefix, sets, N, a: BigInt(a), b: BigInt(Math.floor(Math.random() * N)), i: 0, tried: 0, free: 0 });
      return;
    }
    for (const c of CLASSES_FOR[charset]) build(prefix + c, len);
  };
  for (const len of lengths) build('', len);

  const decode = (sh, idx) => {
    let out = '';
    for (let k = sh.sets.length - 1; k >= 0; k--) {
      const st = sh.sets[k];
      out = st[idx % st.length] + out;
      idx = Math.floor(idx / st.length);
    }
    return out;
  };

  const nextIn = (sh) => {
    const N = BigInt(sh.N);
    while (sh.i < sh.N) {
      const name = decode(sh, Number((sh.a * BigInt(sh.i++) + sh.b) % N));
      if (isValid(name) && !done.has(name)) return name;
    }
    return null;
  };

  // Rejoue l'historique pour retrouver ce qui a été appris lors des scans précédents.
  for (const name of done) {
    const sh = shapes.get(shapeOf(name));
    if (!sh) continue;
    sh.tried++;
    if (availableSet.has(name)) sh.free++;
  }

  const score = (sh) => (sh.free + 1) / (sh.tried + 20); // taux de réussite lissé
  let active = [...shapes.values()];

  return {
    shapes,
    next() {
      while (active.length) {
        let sh;
        if (order === 'random') {
          // uniforme sur tous les noms restants : pondéré par la taille de chaque forme
          let r = Math.random() * active.reduce((t, x) => t + (x.N - x.i), 0);
          sh = active.find((x) => (r -= x.N - x.i) < 0) || active[active.length - 1];
        } else if (Math.random() < epsilon) {
          sh = active[Math.floor(Math.random() * active.length)]; // exploration
        } else {
          const best = Math.max(...active.map(score)); // exploitation (égalités -> hasard)
          const top = active.filter((x) => score(x) >= best - 1e-12);
          sh = top[Math.floor(Math.random() * top.length)];
        }
        const name = nextIn(sh);
        if (name !== null) return { name, shape: sh.pattern };
        active = active.filter((x) => x !== sh); // forme épuisée
      }
      return null;
    },
    record(shape, taken) {
      const sh = shapes.get(shape);
      sh.tried++;
      if (!taken) sh.free++;
    },
    stats() {
      return [...shapes.values()].filter((x) => x.tried).sort((x, y) => y.free / y.tried - x.free / x.tried || y.tried - x.tried);
    },
  };
}

/** Sélecteur simple (--order seq ou --list) : parcourt un itérateur en sautant les noms déjà testés. */
function makeSequentialPicker(iterable, done) {
  const it = iterable[Symbol.iterator](); // itération manuelle : un `for…of` + return fermerait le générateur
  return {
    next() {
      for (let r = it.next(); !r.done; r = it.next()) if (!done.has(r.value)) return { name: r.value, shape: null };
      return null;
    },
    record() {},
    stats: () => [],
  };
}

// ───────────────────────── Requête Discord ─────────────────────────
const API = process.env.SCANNER_API_URL
  || 'https://discord.com/api/v9/unique-username/username-attempt-unauthed';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retourne true (pris) / false (libre). Gère le rate limit (429). */
async function isTaken(username, stop) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (stop.requested) return null;
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        body: JSON.stringify({ username }),
      });
    } catch (e) {
      log(`réseau : ${e.message} — nouvel essai dans 5 s`);
      await sleep(5000);
      continue;
    }

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.ceil(((body.retry_after ?? Number(res.headers.get('retry-after'))) || 10) * 1000) + 500;
      log(`rate limit — pause ${(wait / 1000).toFixed(1)} s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      log(`HTTP ${res.status} pour "${username}" — nouvel essai dans 5 s`);
      await sleep(5000);
      continue;
    }
    const data = await res.json();
    if (typeof data.taken !== 'boolean') throw new Error(`Réponse inattendue : ${JSON.stringify(data)}`);
    return data.taken;
  }
  throw new Error(`Trop d'échecs consécutifs sur "${username}"`);
}

// ───────────────────────── Webhook Discord ─────────────────────────
/** Envoie un message sur le webhook. Ne fait jamais planter le scan. */
async function sendWebhook(url, payload) {
  if (!url) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        await sleep(Math.ceil((body.retry_after ?? 2) * 1000) + 250);
        continue;
      }
      if (!res.ok) { log(`webhook : HTTP ${res.status}`); return; }
      return;
    } catch (e) {
      log(`webhook : ${e.message}`);
      await sleep(2000);
    }
  }
}

const notifyFree = (url, name) => sendWebhook(url, {
  username: 'Name Scanner',
  embeds: [{
    title: `✅ \`${name}\` est disponible`,
    description: `Pseudo de **${name.length} caractères** libre sur Discord.`,
    color: 0x57f287,
    timestamp: new Date().toISOString(),
  }],
});

// ───────────────────────── Affichage ─────────────────────────
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
const log = (m) => process.stdout.write(`\r\x1b[K${C.y}! ${m}${C.x}\n`);

// ───────────────────────── Programme principal ─────────────────────────
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opt.out, { recursive: true });
  const availableFile = path.join(opt.out, 'available.txt');
  const checkedFile = path.join(opt.out, 'checked.txt');

  if (opt.fresh) for (const f of [availableFile, checkedFile]) fs.rmSync(f, { force: true });

  // Reprise : noms déjà testés
  const done = new Set(
    fs.existsSync(checkedFile)
      ? fs.readFileSync(checkedFile, 'utf8').split('\n').filter(Boolean)
      : []
  );

  const availableSet = new Set(
    fs.existsSync(availableFile)
      ? fs.readFileSync(availableFile, 'utf8').split('\n').filter(Boolean)
      : []
  );

  // Source des noms
  let picker, listCount = 0;
  if (opt.list) {
    const lines = fs.readFileSync(opt.list, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = lines.filter((n) => !isValid(n) || n.length < 2 || n.length > 32);
    if (bad.length) die(`Noms invalides dans ${opt.list} : ${bad.slice(0, 5).join(', ')}…`);
    listCount = lines.length;
    picker = makeSequentialPicker(lines, done);
  } else if (opt.order === 'seq') {
    picker = makeSequentialPicker(generate(opt.len, SETS[opt.charset]), done);
  } else {
    picker = makeSmartPicker({ lengths: opt.len, charset: opt.charset, order: opt.order, done, availableSet });
  }

  const total = opt.list
    ? listCount
    : opt.len.reduce((s, n) => s + Math.pow(SETS[opt.charset].length, n), 0);
  const remaining = Math.max(0, total - done.size);
  const eta = (remaining * (opt.delay + opt.jitter / 2)) / 1000;
  console.log(`${C.d}${total} noms au total, ${done.size} déjà testés, ~${fmtDuration(eta)} restant (hors rate limit)${C.x}`);
  console.log(`${C.d}Résultats : ${opt.out}   |   Ctrl+C pour arrêter${C.x}\n`);

  const stop = { requested: false };
  process.on('SIGINT', () => {
    if (stop.requested) process.exit(1);
    stop.requested = true;
    console.log(`\n${C.y}Arrêt demandé… sauvegarde en cours (Ctrl+C à nouveau pour forcer)${C.x}`);
  });

  await sendWebhook(opt.webhook, {
    username: 'Name Scanner',
    content: `🔎 Scan démarré — ${remaining} noms à tester (${opt.list ? 'liste' : `longueurs ${opt.len.join('/')}, ${opt.charset}`}).`,
  });

  const checkedFd = fs.openSync(checkedFile, 'a');
  const availFd = fs.openSync(availableFile, 'a');
  let n = 0, free = 0;
  const t0 = Date.now();

  try {
    for (;;) {
      if (stop.requested || n >= opt.limit) break;
      const pick = picker.next();
      if (pick === null) break; // plus aucun nom à tester
      const { name, shape } = pick;

      const taken = await isTaken(name, stop);
      if (taken === null) break; // arrêt pendant la requête
      n++;
      done.add(name);
      if (shape) picker.record(shape, taken);
      fs.writeSync(checkedFd, name + '\n');
      if (!taken) {
        free++;
        fs.writeSync(availFd, name + '\n');
        process.stdout.write(`\r\x1b[K${C.g}✔ ${name} est DISPONIBLE${C.x}\n`);
        await notifyFree(opt.webhook, name);
      }
      const rate = n / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r\x1b[K${C.d}[${done.size}/${total}] ${name} ${taken ? C.r + 'pris' : C.g + 'libre'}${C.d}` +
        `  | ${free} dispo  | ${rate.toFixed(2)} req/s${shape ? `  | forme ${shape}` : ''}${C.x}`
      );
      await sleep(opt.delay + Math.random() * opt.jitter);
    }
  } finally {
    fs.closeSync(checkedFd);
    fs.closeSync(availFd);
  }
  console.log(`\n\nTerminé : ${n} testés, ${free} disponibles → ${availableFile}`);
  const best = picker.stats().filter((x) => x.free).slice(0, 5);
  if (best.length) {
    console.log('Formes les plus rentables : ' + best.map((x) => `${x.pattern} ${x.free}/${x.tried}`).join(' · ') + '  (L=lettre D=chiffre S=_ .)');
  }
  await sendWebhook(opt.webhook, {
    username: 'Name Scanner',
    content: `🏁 Scan ${stop.requested ? 'interrompu' : 'terminé'} — ${n} testés, **${free}** disponibles.`,
  });
}

function fmtDuration(s) {
  if (!isFinite(s)) return '∞';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d} j`, h && `${h} h`, `${m} min`].filter(Boolean).join(' ');
}

main().catch((e) => { console.error(`\nErreur : ${e.message}`); process.exit(1); });
