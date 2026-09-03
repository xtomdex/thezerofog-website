// Tell Bing (and every IndexNow engine: Bing, Yandex, Seznam, Naver, Yep) that pages changed.
//
//   node scripts/indexnow.mjs                    -> every sitemap URL whose <lastmod> is within 3 days
//   node scripts/indexnow.mjs --days 30          -> widen the window
//   node scripts/indexnow.mjs https://thezerofog.com/afternoon-crash/ [...more]  -> exactly these
//   node scripts/indexnow.mjs --dry              -> print what would be sent, send nothing
//
// The key is public by design: IndexNow proves ownership by fetching https://<host>/<key>.txt,
// so the key lives in src/indexnow-key.njk (built to /<key>.txt) and is read from there - no env
// var to forget. Runs locally against dist/sitemap.xml, or in the Netlify build plugin
// (plugins/indexnow) right after a production deploy succeeds.
//
// IndexNow returns 200 (submitted) or 202 (accepted, key will be checked later). 422 = the key
// file is not live at keyLocation; 429 = too many requests. Nothing here retries: a missed ping
// costs a day of Bing latency, a retry loop could cost the key's standing.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'thezerofog.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

export function readKey() {
  const src = join(root, 'src');
  const file = readdirSync(src).find((f) => /^indexnow-key\.njk$/.test(f));
  if (!file) throw new Error('src/indexnow-key.njk not found');
  const text = readFileSync(join(src, file), 'utf8');
  const m = text.match(/^key:\s*"?([a-f0-9]{8,128})"?\s*$/m);
  if (!m) throw new Error('no `key:` line in src/indexnow-key.njk');
  return m[1];
}

export function urlsFromSitemap(xml, days) {
  const out = [];
  const cutoff = Date.now() - days * 86400 * 1000;
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) || []) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    if (!loc || !lastmod) continue; // pages without lastmod never change in a way Bing must hear about
    if (new Date(lastmod).getTime() >= cutoff) out.push(loc.trim());
  }
  return out;
}

export async function submit(urlList, { key, dry = false, log = console.log } = {}) {
  key = key || readKey();
  if (!urlList.length) {
    log('indexnow: nothing changed inside the window, nothing sent');
    return { status: 0, sent: [] };
  }
  const body = { host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList };
  log(`indexnow: ${dry ? 'would send' : 'sending'} ${urlList.length} url(s):\n  ` + urlList.join('\n  '));
  if (dry) return { status: 0, sent: urlList };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  log(`indexnow: HTTP ${res.status}${text ? ' ' + text.slice(0, 200) : ''}`);
  return { status: res.status, sent: urlList };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const di = args.indexOf('--days');
  const days = di >= 0 ? Number(args[di + 1]) : 3;
  const explicit = args.filter((a) => /^https?:\/\//.test(a));
  let urls = explicit;
  if (!urls.length) {
    const sm = join(root, 'dist', 'sitemap.xml');
    if (!existsSync(sm)) {
      console.error('indexnow: dist/sitemap.xml missing - run `npm run build` first, or pass URLs');
      process.exit(2);
    }
    urls = urlsFromSitemap(readFileSync(sm, 'utf8'), days);
  }
  const r = await submit(urls, { dry });
  process.exit(r.status === 0 || r.status === 200 || r.status === 202 ? 0 : 1);
}
