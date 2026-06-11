import fs from 'fs';

const BASE_URL = 'https://showroom.ebaymotorspro.co.uk/lucky-motors';

async function fetchPage(page) {
  const url = page > 1 ? `${BASE_URL}?page=${page}` : BASE_URL;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
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

const output = {
  updatedAt: new Date().toISOString(),
  total: allItems.length,
  vehicles: allItems,
};

fs.writeFileSync('stock.json', JSON.stringify(output, null, 2));
console.log(`Scraped ${allItems.length} vehicles (expected ${total}). Wrote stock.json`);
