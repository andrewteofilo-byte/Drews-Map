// Finds a working RSS feed for every station, keeping only feeds on the station's own website.
// Run occasionally (it's slow): Actions tab > Station feeds > Run workflow > tick "Find feeds".
// Reads  data/station-feeds.json (Hyperlocal register) and the optional override/market files
// Writes data/feeds-found.json (what fetch.mjs reads) and data/feed-report.md (what failed and why)
import { get, pool, baseDomain, loadStations, writeJSON, parseFeed, onStationSite } from './lib.mjs';
import { writeFile } from 'node:fs/promises';

const MAX_FEEDS = 2;   // per station
const NOT_STATION = /(news\.google\.|feedburner\.|feedblitz|rss\.app|fetchrss|politefeed|newsbreak|msn\.com|yahoo\.com)/i;

function feedLinksFromHTML(html, pageUrl) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) { try { out.push(new URL(href.replace(/&amp;/g, '&'), pageUrl).href); } catch {} }
  }
  return out;
}

async function checkFeed(url, station) {
  if (NOT_STATION.test(url)) return { ok: false, why: 'not a station source' };
  const allowed = [station.site, ...station.aliases].map(baseDomain);
  if (!allowed.includes(baseDomain(url))) return { ok: false, why: `hosted on ${baseDomain(url)}` };
  const r = await get(url);
  if (!r.ok) return { ok: false, why: r.error || `HTTP ${r.status}` };
  const feed = parseFeed(r.text);
  if (!feed) return { ok: false, why: 'not a feed' };
  if (!feed.items.length) return { ok: false, why: 'feed is empty' };
  const onSite = feed.items.filter(i => onStationSite(i.link, station)).length;
  if (onSite < Math.ceil(feed.items.length / 2)) return { ok: false, why: 'most stories are outside the station\'s site or section' };
  return { ok: true, url: r.url };
}

async function findFeeds(station, paths) {
  const tried = new Set(), found = [], notes = [];
  const tryUrl = async url => {
    if (found.length >= MAX_FEEDS || tried.has(url)) return;
    tried.add(url);
    const c = await checkFeed(url, station);
    if (c.ok) { if (!found.includes(c.url)) found.push(c.url); }
    else notes.push(`${url}: ${c.why}`);
  };

  // 1. Feeds given in site-overrides.json
  for (const f of station.feeds) await tryUrl(f);
  if (found.length) return { found, notes: [] };

  // 2. Feeds the homepage advertises (trying www. if the bare address doesn't answer)
  let home = await get(station.site);
  let base = station.site;
  if (home.status === 0 && !/\/\/www\./.test(station.site)) {
    const www = station.site.replace('://', '://www.');
    const h2 = await get(www);
    if (h2.status !== 0) { home = h2; base = www; }
  }
  if (home.ok) for (const f of feedLinksFromHTML(home.text, home.url)) await tryUrl(f);
  else notes.push(`${station.site}: homepage ${home.error || 'HTTP ' + home.status}`);

  // 3. The register's feed paths, only if the site answered at all
  if (!found.length && home.status !== 0) {
    const root = (() => { const u = new URL(home.url || base); const sec = new URL(station.site).pathname.replace(/\/+$/, ''); return u.origin + sec; })();
    for (const p of [...station.ownerPaths, ...paths]) { await tryUrl(root + p); if (found.length) break; }
  }
  return { found, notes: found.length ? [] : notes };
}

const { stations, paths } = await loadStations();
console.log(`Finding feeds for ${stations.length} stations (${new Set(stations.map(s => s.site)).size} websites)…`);
const results = await pool(stations, 8, async (s, n) => {
  const { found, notes } = await findFeeds(s, paths);
  console.log(`${String(n + 1).padStart(4)} ${s.call.padEnd(6)} ${found.length ? found.length + ' feed(s)' : 'none found'}`);
  return { ...s, feeds: found, notes };
});

await writeJSON('data/feeds-found.json', {
  generated: new Date().toISOString(),
  stations: results.map(({ notes, ownerPaths, ...s }) => s)
});

const missing = results.filter(r => !r.feeds.length);
const withMarket = results.filter(r => r.market);
const covered = new Set(withMarket.filter(r => r.feeds.length).map(r => r.market));
const allMarkets = new Set(withMarket.map(r => r.market));
const uncovered = [...allMarkets].filter(m => !covered.has(m)).sort();
await writeFile('data/feed-report.md', [
  '# Station feed report', '',
  `Run ${new Date().toISOString()}. ${results.length - missing.length} of ${results.length} stations have a station feed.`,
  allMarkets.size
    ? `They cover ${covered.size} of ${allMarkets.size} markets. ${results.length - withMarket.length} stations have no market yet.`
    : 'No markets are assigned yet, so market coverage can\'t be counted. Add data/station-markets.json.',
  '',
  ...(allMarkets.size ? [`## Markets with no station feed (${uncovered.length})`, ...uncovered.map(m => `- ${m}`), ''] : []),
  `## Stations with no market (${results.length - withMarket.length})`,
  'These are in the Hyperlocal register but not in station-markets.json, so their stories can\'t be placed on the map.',
  ...results.filter(r => !r.market).map(r => `- ${r.call} (${r.site.replace(/^https?:\/\//, '')})`),
  '',
  `## Stations with no feed (${missing.length})`,
  ...missing.flatMap(r => [`### ${r.call} (${r.site.replace(/^https?:\/\//, '')})`, ...r.notes.slice(0, 5).map(n => `- ${n}`), ''])
].join('\n'));
console.log(`Done: ${results.length - missing.length}/${results.length} stations. Details in data/feed-report.md`);
