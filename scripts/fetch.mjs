// Reads every station feed and writes data/stories.json for the map. Runs every 20 minutes.
// Uses data/feeds-found.json from discover.mjs; markets are re-read each run, so
// updating data/station-markets.json takes effect without finding feeds again.
import { get, pool, loadStations, writeJSON, parseFeed, ownership, onStationSite } from './lib.mjs';
import { readFile } from 'node:fs/promises';

const PER_SITE = 12;

let found;
try { found = JSON.parse(await readFile('data/feeds-found.json', 'utf8')).stations; }
catch { console.error('No data/feeds-found.json yet. Run the workflow once with "Find feeds" ticked.'); process.exit(1); }
const { markets } = await loadStations();

// Stations sharing a website share one feed read
const sites = new Map();
for (const s of found) {
  if (!sites.has(s.site)) sites.set(s.site, { site: s.site, feeds: s.feeds, aliases: s.aliases, stations: [] });
  sites.get(s.site).stations.push(s);
}

const siteResults = await pool([...sites.values()], 10, async g => {
  const lead = g.stations[0];
  const feeds = g.feeds.filter(f => onStationSite(f, { ...lead, site: new URL(lead.site).origin }));  // station-hosted only
  if (!feeds.length) return { site: g.site, ok: false, error: 'no station feed', items: [] };
  const seen = new Set(), items = [], errors = [];
  for (const url of feeds) {
    const r = await get(url, 12000);
    const feed = r.ok ? parseFeed(r.text) : null;
    if (!feed) { errors.push(`${url}: ${r.error || (r.ok ? 'not a feed' : 'HTTP ' + r.status)}`); continue; }
    for (const it of feed.items) {
      if (!it.title || !it.link || seen.has(it.link)) continue;
      seen.add(it.link);
      const own = ownership(it, lead);
      const d = Date.parse(it.published);
      items.push({
        title: it.title,
        link: it.link,
        published: Number.isNaN(d) ? null : new Date(d).toISOString(),
        own: own.own,
        ...(own.why ? { why: own.why } : {})
      });
    }
  }
  return { site: g.site, ok: items.length > 0, ...(errors.length ? { error: errors.join('; ') } : {}), items: items.slice(0, PER_SITE) };
});

const bySite = Object.fromEntries(siteResults.map(r => [r.site.replace(/^https?:\/\//, ''), r]));
const stations = Object.fromEntries(found.map(s => {
  const m = markets[s.call] || {};
  return [s.call, {
    market: m.market || '',
    rank: m.rank ?? null,
    networks: m.networks || [],
    tier: m.tier || '',
    owner: m.owner || '',
    site: s.site.replace(/^https?:\/\//, '')
  }];
}));
const okSites = siteResults.filter(r => r.ok);
const all = okSites.flatMap(r => r.items);
const okCalls = found.filter(s => bySite[s.site.replace(/^https?:\/\//, '')]?.ok);

await writeJSON('data/stories.json', {
  generated: new Date().toISOString(),
  counts: {
    stations: found.length,
    stationsWorking: okCalls.length,
    sites: siteResults.length,
    sitesWorking: okSites.length,
    markets: new Set(okCalls.map(s => stations[s.call].market).filter(Boolean)).size,
    stories: all.length,
    sharedMarked: all.filter(i => !i.own).length
  },
  stations,      // call -> { market, rank, networks, tier, owner, site }
  sites: bySite  // site -> { ok, items }  (each story: title, link, published, own, why)
});
console.log(`${okSites.length}/${siteResults.length} sites read for ${okCalls.length}/${found.length} stations, ${all.length} stories, ${all.filter(i => !i.own).length} marked shared or wire.`);
