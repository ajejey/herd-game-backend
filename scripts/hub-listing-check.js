#!/usr/bin/env node
/**
 * Every game in the registry must be reachable from the pages that list games.
 *
 *   node scripts/hub-listing-check.js
 *
 * Caveman Clues shipped complete — built, tested, routed, prerendered, in the
 * sitemap, in the nav — and was invisible on the homepage, which is the page
 * with by far the most traffic. Nothing failed. The game simply was not there.
 *
 * The cause is a mismatch between what `data/games.js` promises and what
 * `Home.js` does. The registry's own header says:
 *
 *     "Adding a game = adding ONE entry here. It then appears automatically on
 *      the homepage row for its mode..."
 *
 * That is true for `solo` and `work`, which render through <GameSection
 * games={byMode(...)} />. It is NOT true for `party`: the "Pick your game" grid
 * is ~400 lines of hand-written cards, one per game, written before the
 * registry existed and never migrated. So a party game gets a nav entry and an
 * /all-games entry for free, and needs a hand-written card for the homepage.
 *
 * Migrating that grid is a real design decision — the hand-written cards carry
 * ribbons, player pills and per-game accent borders that the shared GameCard
 * does not — so until someone makes it, this check is the safety net. It reads
 * source, not a browser, so it costs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(here, '..', '..', 'frontend', 'src');
const REGISTRY = path.join(FE, 'data', 'games.js');

if (!fs.existsSync(REGISTRY)) {
  console.log('  (frontend not present, skipping)');
  process.exit(0);
}

const registry = fs.readFileSync(REGISTRY, 'utf8');

/* Pull id + slug + mode straight from the registry entries. */
const games = [...registry.matchAll(
  /id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*slug:\s*'([^']+)',\s*mode:\s*'([^']+)'/g,
)].map(([, id, name, slug, mode]) => ({ id, name, slug, mode }));

const problems = [];
const check = (pass, msg) => { if (!pass) problems.push(msg); };

check(games.length >= 40, `only parsed ${games.length} games out of the registry — the entry shape may have changed`);

/*
  Where each mode is expected to appear. `party` needs a hand-written card on
  the homepage; the others are rendered from the registry and so are covered by
  simply being in it.
*/
const SURFACES = [
  { file: path.join(FE, 'components', 'Home.js'), label: 'the homepage', modes: ['party'] },
  { file: path.join(FE, 'components', 'Navigation.js'), label: 'the nav', modes: [], registryDriven: true },
];

for (const surface of SURFACES) {
  if (!fs.existsSync(surface.file)) { problems.push(`${surface.label}: ${surface.file} is missing`); continue; }
  if (surface.registryDriven) continue;   // renders byMode(), so nothing to miss

  const src = fs.readFileSync(surface.file, 'utf8');
  for (const g of games.filter((x) => surface.modes.includes(x.mode))) {
    check(src.includes(`"${g.slug}"`) || src.includes(`'${g.slug}'`) || src.includes(`to=${g.slug}`),
      `${g.name} (${g.slug}) is in the registry as a ${g.mode} game but has no card on ${surface.label}`);
  }
}

/* Routes and the sitemap, which are separate lists that also drift. */
const pkg = JSON.parse(fs.readFileSync(path.join(FE, '..', 'package.json'), 'utf8'));
const routes = (pkg.prerender && pkg.prerender.routes) || [];
const sitemap = fs.existsSync(path.join(FE, '..', 'public', 'sitemap.xml'))
  ? fs.readFileSync(path.join(FE, '..', 'public', 'sitemap.xml'), 'utf8')
  : '';
const app = fs.readFileSync(path.join(FE, 'App.js'), 'utf8');

for (const g of games) {
  check(app.includes(`path="${g.slug}"`), `${g.name}: no route in App.js for ${g.slug}`);
  check(routes.includes(g.slug), `${g.name}: ${g.slug} missing from prerender.routes`);
  check(!sitemap || sitemap.includes(`${g.slug}</loc>`), `${g.name}: ${g.slug} missing from sitemap.xml`);
}

console.log(`hub listing — ${games.length} games checked across the homepage, routes, prerender and sitemap\n`);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  console.error('\nA party game needs a hand-written card in the "Pick your game" grid in Home.js.');
  console.error('See the header of this file for why that is not automatic yet.');
  process.exit(1);
}
console.log('  every party game has a card on the homepage');
console.log('  every game has a route, a prerender entry and a sitemap entry');
