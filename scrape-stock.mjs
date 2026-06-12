import fs from 'fs';
import path from 'path';
import { Jimp, JimpMime } from 'jimp';

const BASE_URL = 'https://showroom.ebaymotorspro.co.uk/lucky-motors';
const IMAGES_DIR = 'stock-images';

async function withRetries(fn, attempts = 3, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function fetchPage(page) {
  const url = page > 1 ? `${BASE_URL}?page=${page}` : BASE_URL;
  return withRetries(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
  });
}

function parseItems(html) {
  const items = [];
  const chunks = html.split('<div class="item">').slice(1);
  for (const chunk of chunks) {
    const imgMatch = chunk.match(/<img src="([^"]+)"/);
    const priceMatch = chunk.match(/item__price">\s*([^<\n]+)/);
    const titleMatch = chunk.match(/<h3 class="item__title"><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/h3>/);
    const subtitleMatch = chunk.match(/<h4 class="item__subtitle ellipsis">([^<]*)<\/h4>/);
    const descMatch = chunk.match(/<span class="item__description">\s*([\s\S]*?)\s*<\/span>/);
    const detailsMatch = chunk.match(/<div class="item__details">([\s\S]*?)<\/div>/);

    if (!titleMatch) continue;

    const details = detailsMatch
      ? detailsMatch[1].split('|').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
      : [];

    items.push({
      title: titleMatch[2].trim(),
      link: titleMatch[1].trim(),
      price: priceMatch ? priceMatch[1].replace(/\s+/g, ' ').trim() : '',
      image: imgMatch ? imgMatch[1] : '',
      subtitle: subtitleMatch ? subtitleMatch[1].trim() : '',
      description: descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '',
      details,
    });
  }
  return items;
}

function parseTotalCount(html) {
  const m = html.match(/summary__value">\s*(\d+)\s*of\s*(\d+)\s*ads/);
  if (!m) return { perPage: 0, total: 0 };
  return { perPage: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

function getItemId(link) {
  const m = link.match(/\/itm\/(\d+)/);
  return m ? m[1] : null;
}

// Download a self-hosted copy of each listing photo so the site doesn't
// depend on eBay's image CDN (which some browsers/extensions block).
async function downloadImage(url, id) {
  const largeUrl = url.replace(/\$_\d+\.JPG$/i, '$_12.JPG');
  return withRetries(async () => {
    const res = await fetch(largeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Failed to fetch image ${largeUrl}: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const image = await Jimp.read(buffer);
    const outPath = path.join(IMAGES_DIR, `${id}.jpg`);
    fs.writeFileSync(outPath, await image.getBuffer(JimpMime.jpeg, { quality: 80 }));
    return outPath.replace(/\\/g, '/');
  });
}

const firstPageHtml = await fetchPage(1);
const { perPage, total } = parseTotalCount(firstPageHtml);
let allItems = parseItems(firstPageHtml);

const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 1;
for (let p = 2; p <= totalPages; p++) {
  const html = await fetchPage(p);
  allItems = allItems.concat(parseItems(html));
}

if (allItems.length === 0) {
  console.error('Scraped 0 vehicles — the showroom page layout may have changed. Leaving stock.json untouched.');
  process.exit(1);
}

// Guard against partial scrapes (e.g. a mid-pagination fetch failure) wiping
// out listings that are actually still live on eBay.
if (total > 0 && allItems.length < total * 0.5) {
  console.error(`Scraped only ${allItems.length} of ${total} expected vehicles — likely a partial failure. Leaving stock.json untouched.`);
  process.exit(1);
}

fs.mkdirSync(IMAGES_DIR, { recursive: true });

const keepFiles = new Set();
for (const item of allItems) {
  const id = getItemId(item.link);
  if (!id || !item.image) continue;
  try {
    item.image = await downloadImage(item.image, id);
    keepFiles.add(path.basename(item.image));
  } catch (err) {
    console.error(`Image download failed for ${id}: ${err.message}`);
    // Fall back to a previously cached copy rather than showing a broken image
    const cached = path.join(IMAGES_DIR, `${id}.jpg`);
    if (fs.existsSync(cached)) {
      item.image = cached.replace(/\\/g, '/');
      keepFiles.add(path.basename(item.image));
    } else {
      item.image = '';
    }
  }
}

// Remove cached images for vehicles that are no longer in stock
for (const file of fs.readdirSync(IMAGES_DIR)) {
  if (!keepFiles.has(file)) fs.unlinkSync(path.join(IMAGES_DIR, file));
}

const output = {
  updatedAt: new Date().toISOString(),
  total: allItems.length,
  vehicles: allItems,
};

fs.writeFileSync('stock.json', JSON.stringify(output, null, 2));
console.log(`Scraped ${allItems.length} vehicles (expected ${total}). Wrote stock.json`);
