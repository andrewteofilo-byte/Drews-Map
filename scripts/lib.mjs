// Shared helpers for the station feed scripts.
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';

export const UA = 'Mozilla/5.0 (compatible; DrewsSecretMap/1.0; RSS reader)';

/* Fetch with a timeout. Never throws; failures come back as { ok:false, error }.
   Each address is fetched once per run, so sites shared by several calls cost one request. */
const cache = new Map();
export function get(url, timeout = 15000) {
  if (!cache.has(url)) cache.set(url, fetchOnce(url, timeout));
  return cache.get(url);
}
async function fetchOnce(url, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5'
      }
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, url: r.url || url, text };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', error: e.name === 'AbortError' ? 'timed out' : (e.cause?.code || e.message) };
  } finally {
    clearTimeout(t);
  }
}

/* Run fn over items with a fixed number running at once. */
export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

/* "https://www.texomashomepage.com/news" -> "texomashomepage.com". Good enough for station sites. */
export function baseDomain(u) {
  try {
    return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.toLowerCase().split('.').slice(-2).join('.');
  } catch { return ''; }
}

const readJSON = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};
const noNotes = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')));

const TIER_ORDER = ['big4', 'ranks_with_big4', 'has_newsroom'];
/* Station markets from Drew's Secret ({ stations: [{ base_callsign, dma, dma_rank, owner, network, tier }] })
   or a plain { "KFDX": "Wichita Falls-Lawton" } lookup. Returns call -> { market, rank, owner, networks, tier }. */
function readMarkets(raw) {
  const out = {};
  if (Array.isArray(raw?.stations)) {
    for (const r of raw.stations) {
      for (const call of new Set([r.base_callsign, r.callsign].filter(Boolean).map(c => String(c).toUpperCase()))) {
        const m = out[call] ||= { market: r.dma, rank: r.dma_rank ?? null, owner: r.owner || '', networks: [], tier: r.tier || '' };
        if (r.network && !m.networks.includes(r.network)) m.networks.push(r.network);
        if (TIER_ORDER.indexOf(r.tier) > -1 && (TIER_ORDER.indexOf(m.tier) === -1 || TIER_ORDER.indexOf(r.tier) < TIER_ORDER.indexOf(m.tier))) m.tier = r.tier;
        if (!m.owner && r.owner) m.owner = r.owner;
      }
    }
  } else {
    for (const [call, market] of Object.entries(noNotes(raw))) out[call.toUpperCase()] = { market, rank: null, owner: '', networks: [], tier: '' };
  }
  return out;
}

/* Builds the station list from the Hyperlocal register (data/station-feeds.json), plus:
   data/site-overrides.json   call -> site with a path, where a station's news lives under a section
   data/station-markets.json  call -> DMA name (from Drew's Secret), so stories land on the map
   Only station websites are used: the register's newspaper, world and network lists are ignored. */
export async function loadStations() {
  const reg = await readJSON('data/station-feeds.json', null);
  if (!reg || !reg.station_sites) throw new Error('data/station-feeds.json is missing or has no station_sites');
  const overrides = noNotes(await readJSON('data/site-overrides.json', {}));
  const markets = readMarkets(await readJSON('data/station-markets.json', {}));
  const sites = reg.station_sites;

  // Duplicate slots like WSMV2 point at the same site as WSMV; keep the real call only
  const calls = Object.keys(sites).filter(c => !(/2$/.test(c) && sites[c.slice(0, -1)] === sites[c]));

  // Other domains the register knows for each call (old addresses that redirect)
  const aliases = {};
  for (const [dom, call] of Object.entries(reg.domain_to_call || {})) {
    const d = dom.trim().toLowerCase(), c = String(call).trim().toUpperCase();
    (aliases[c] ||= new Set()).add(d);
  }

  // An override is either a site with a path, or { "site": ..., "feeds": [...] }
  const ov = c => (typeof overrides[c] === 'string' ? { site: overrides[c] } : overrides[c] || {});
  const siteOf = c => String(ov(c).site || sites[c]).trim().replace(/\/+$/, '');
  const byDomain = {};
  for (const c of calls) (byDomain[siteOf(c)] ||= []).push(c);

  const stations = calls.map(c => {
    const site = siteOf(c);
    return {
      call: c,
      market: markets[c]?.market || '',
      owner: markets[c]?.owner || '',
      site: /^https?:\/\//.test(site) ? site : 'https://' + site,
      aliases: [...(aliases[c] || [])].filter(d => baseDomain(d) !== baseDomain(site)),
      siblings: byDomain[site].filter(x => x !== c),
      feeds: [].concat(ov(c).feeds || [])
    };
  });

  // Feed addresses to try: every owner group's paths, most common first, then the generic ones
  const count = {};
  for (const paths of Object.values(reg.owner_feed_paths || {})) for (const p of paths) count[p] = (count[p] || 0) + 1;
  const paths = [...Object.keys(count).sort((a, b) => count[b] - count[a]), ...(reg.generic_feed_paths || [])]
    .filter((p, i, a) => a.indexOf(p) === i);

  // Owner groups' own paths, matched loosely ("Tegna (Nexstar subsidiary)" uses the Tegna paths)
  const ownerKeys = Object.keys(reg.owner_feed_paths || {}).sort((a, b) => b.length - a.length);
  for (const st of stations) {
    const key = st.owner && ownerKeys.find(k => st.owner.toLowerCase().includes(k.toLowerCase()));
    st.ownerPaths = key ? reg.owner_feed_paths[key] : [];
  }
  return { stations, paths, markets };
}

/* Is this link on the station's own website? If the site has a section path
   (cbsnews.com/pittsburgh), the link has to be inside that section too. */
export function onStationSite(link, station) {
  let u, s;
  try { u = new URL(link); s = new URL(station.site); } catch { return false; }
  const b = baseDomain(link);
  if (station.aliases?.some(a => baseDomain(a) === b)) return true;
  if (b !== baseDomain(station.site)) return false;
  return s.pathname === '/' || s.pathname === '' || u.pathname.startsWith(s.pathname);
}

export async function writeJSON(path, data) {
  await writeFile(path, JSON.stringify(data, null, 1) + '\n');
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true
});
const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = x => (x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x));
export const stripTags = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/* Parse RSS 2.0, RSS 1.0 (RDF) or Atom. Returns null if it isn't a feed. */
export function parseFeed(xml) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(String(xml).slice(0, 3000))) return null;
  let doc;
  try { doc = parser.parse(xml); } catch { return null; }

  const rssItem = i => ({
    title: stripTags(txt(i.title)),
    link: txt(i.link).trim() || (/^https?:/.test(txt(i.guid)) ? txt(i.guid).trim() : ''),
    published: txt(i.pubDate) || txt(i['dc:date']) || '',
    author: stripTags(txt(i['dc:creator']) || txt(i.author)),
    text: stripTags(txt(i['content:encoded']) + ' ' + txt(i.description))
  });

  if (doc.rss) {
    const ch = arr(doc.rss.channel)[0] || {};
    return { title: stripTags(txt(ch.title)), items: arr(ch.item).map(rssItem) };
  }
  if (doc['rdf:RDF']) {
    const r = doc['rdf:RDF'];
    return { title: stripTags(txt(arr(r.channel)[0]?.title)), items: arr(r.item).map(rssItem) };
  }
  if (doc.feed) {
    const f = doc.feed;
    return {
      title: stripTags(txt(f.title)),
      items: arr(f.entry).map(e => {
        const links = arr(e.link);
        const alt = links.find(l => !l['@rel'] || l['@rel'] === 'alternate') || links[0] || {};
        return {
          title: stripTags(txt(e.title)),
          link: String(alt['@href'] || '').trim(),
          published: txt(e.published) || txt(e.updated) || '',
          author: stripTags(txt(arr(e.author)[0]?.name)),
          text: stripTags(txt(e.content) + ' ' + txt(e.summary))
        };
      })
    };
  }
  return null;
}

/* Is this story the station's own reporting?
   1. The link must be on the station's own website.
   2. Gray stories end with "Copyright 2026 WXXX. All rights reserved." naming the station that
      wrote it, so a different call sign, Gray's national desk or a wire service means shared.
   3. Bylines from shared desks and wires (Nexstar Media Wire, AP, CNN and so on) are shared. */
const SHARED = /\b(Nexstar Media Wire|Associated Press|CNN|Gray News|Gray Media|Gray Television|InvestigateTV|The Hill|NewsNation|Stacker)\b/i;
const CALL = /^[KW][A-Z]{2,3}$/;
export function ownership(item, station) {
  if (item.link && !onStationSite(item.link, station))
    return { own: false, why: `link is off the station's site (${baseDomain(item.link)})` };

  const m = /Copyright\s*(?:©|\(c\))?\s*(?:\d{4}\s+)?([A-Z][A-Za-z0-9 .,&'-]{1,60}?)\.?\s+All rights reserved/i.exec(item.text);
  if (m) {
    const holder = m[1].trim();
    const strip = c => c.toUpperCase().replace(/-(TV|DT|CD|LD)$/, '');
    const holderCall = strip(holder);
    const ours = [station.call, ...(station.siblings || [])].map(strip);   // duopolies share a newsroom
    if (CALL.test(holderCall) && !ours.includes(holderCall)) return { own: false, why: `copyright ${holder}` };
    if (!CALL.test(holderCall) && SHARED.test(holder)) return { own: false, why: `copyright ${holder}` };
  }
  if (item.author && SHARED.test(item.author)) return { own: false, why: `byline ${item.author}` };
  return { own: true, why: '' };
}
