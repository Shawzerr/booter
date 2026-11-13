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

// ───────────────────────── Options ─────────────────────────
const HELP = `
Discord username scanner

  node scanner.js [options]

Options
  --len <3|4|3,4>      Longueurs à scanner                (défaut : 3,4)
  --charset <set>      letters  = a-z
                       alnum    = a-z + 0-9
                       all      = a-z 0-9 _ .             (défaut : letters)
  --delay <ms>         Pause entre deux requêtes          (défaut : 1500)
  --jitter <ms>        Aléa ajouté à la pause             (défaut : 500)
  --shuffle            Ordre aléatoire au lieu de a, b, c…
  --list <fichier>     Scanner uniquement les noms d'un fichier (1 par ligne)
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
    len: [3, 4], charset: 'letters', delay: 1500, jitter: 500,
    shuffle: false, list: null, out: path.join(__dirname, 'results'),
    limit: Infinity, fresh: false,
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
      case '--shuffle': o.shuffle = true; break;
      case '--list': o.list = need(i++, a); break;
      case '--out': o.out = path.resolve(need(i++, a)); break;
      case '--limit': o.limit = Number(need(i++, a)); break;
      case '--fresh': o.fresh = true; break;
      default: die(`Option inconnue : ${a}\n${HELP}`);
    }
  }
  if (o.len.some((n) => !Number.isInteger(n) || n < 2 || n > 6)) die('--len : entiers entre 2 et 6');
  if (![ 'letters', 'alnum', 'all' ].includes(o.charset)) die('--charset : letters | alnum | all');
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

function shuffled(iter) {
  const arr = [...iter];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

  // Source des noms
  let source;
  if (opt.list) {
    const lines = fs.readFileSync(opt.list, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = lines.filter((n) => !isValid(n) || n.length < 2 || n.length > 32);
    if (bad.length) die(`Noms invalides dans ${opt.list} : ${bad.slice(0, 5).join(', ')}…`);
    source = lines;
  } else {
    const gen = generate(opt.len, SETS[opt.charset]);
    source = opt.shuffle ? shuffled(gen) : gen;
  }

  const total = opt.list
    ? source.length
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

  const checkedFd = fs.openSync(checkedFile, 'a');
  const availFd = fs.openSync(availableFile, 'a');
  let n = 0, free = 0;
  const t0 = Date.now();

  try {
    for (const name of source) {
      if (stop.requested || n >= opt.limit) break;
      if (done.has(name)) continue;

      const taken = await isTaken(name, stop);
      if (taken === null) break; // arrêt pendant la requête
      n++;
      fs.writeSync(checkedFd, name + '\n');
      if (!taken) {
        free++;
        fs.writeSync(availFd, name + '\n');
        process.stdout.write(`\r\x1b[K${C.g}✔ ${name} est DISPONIBLE${C.x}\n`);
      }
      const rate = n / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r\x1b[K${C.d}[${done.size + n}/${total}] ${name} ${taken ? C.r + 'pris' : C.g + 'libre'}${C.d}` +
        `  | ${free} dispo  | ${rate.toFixed(2)} req/s${C.x}`
      );
      await sleep(opt.delay + Math.random() * opt.jitter);
    }
  } finally {
    fs.closeSync(checkedFd);
    fs.closeSync(availFd);
  }
  console.log(`\n\nTerminé : ${n} testés, ${free} disponibles → ${availableFile}`);
}

function fmtDuration(s) {
  if (!isFinite(s)) return '∞';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d} j`, h && `${h} h`, `${m} min`].filter(Boolean).join(' ');
}

main().catch((e) => { console.error(`\nErreur : ${e.message}`); process.exit(1); });
