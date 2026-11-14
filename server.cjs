// FashionBuy server: static files + AI fit analysis (/api/analyze-fit)
const http = require('http'), fs = require('fs'), path = require('path');

// ---------- Parse .env FIRST so the AI provider keys land in process.env ----------
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
    console.log('[env] .env loaded — keys present:',
      ['GEMINI_API_KEY', 'GEMINI_API_KEY1', 'GEMINI_API_KEY2', 'REPLICATE_API_TOKEN1', 'REPLICATE_API_TOKEN', 'CHANNEL3_API_KEY'].filter(k => process.env[k]).join(', ') || 'none');
  } catch (e) { console.warn('[env] could not parse .env:', e.message); }
})();

const ROOT = __dirname;
// External mirror of the project that holds the real models2 image library.
const PICTURES_ROOT = 'C:\\Users\\Ghafoori\\Pictures\\FashionBuy - Copy2';
const PORT = process.env.PORT || 8321;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.fbx': 'application/octet-stream',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.svgz': 'image/svg+xml'
};

// ---------- Gemini API key (env var GEMINI_API_KEY, or a ./gemini.key file) ----------
function getApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, 'gemini.key'), 'utf8').trim(); }
  catch { return null; }
}

function replicateToken(name) {
  return (process.env[name] || '').trim() || null;
}

function replicateAccountToken(token) {
  if (!token) return null;
  if (token.startsWith('http')) return null;
  if (/^(your|replace|changeme|todo)/i.test(token)) return null;
  return token;
}

function channel3Key() {
  return (process.env.CHANNEL3_API_KEY || '').trim();
}

function channel3Configured() {
  const key = channel3Key();
  return !!key && !/^(your|replace|changeme|todo|x{3,}$)/i.test(key);
}

async function replicateModelPrediction(token, model, input) {
  if (!token) throw new Error('Missing Replicate API token. Configure the required token in .env.');
  const response = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Prefer: 'wait=60' },
    body: JSON.stringify({ input })
  });
  const prediction = await response.json();
  if (!response.ok) throw new Error(prediction.detail || prediction.title || `Replicate HTTP ${response.status}`);
  let result = prediction;
  while (result.status === 'starting' || result.status === 'processing') {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const poll = await fetch(result.urls.get, { headers: { Authorization: `Bearer ${token}` } });
    result = await poll.json();
    if (!poll.ok) throw new Error(result.detail || `Replicate HTTP ${poll.status}`);
  }
  if (result.status !== 'succeeded') throw new Error(result.error || `Replicate prediction ${result.status}`);
  return result.output;
}

// ---------- Static file serving ----------

// ---- /models2 static mount ----
// Minimal express-compatible `app.use('/mount', handler)` adapter so the static
// mount below works on this plain http server without adding a dependency.
const staticMounts = [];
const app = {
  use(mountPath, handler) { staticMounts.push({ mountPath, handler }); return app; },
  handle(req, res) {
    for (const m of staticMounts) {
      if (req.url === m.mountPath || req.url.startsWith(m.mountPath + '/')) return m.handler(req, res, () => {});
    }
    return false;
  }
};

// Image files directly inside models2/ (no subfolders) — .jpg / .jpeg / .png
// Check both candidate locations and serve whichever actually exists on disk.
const MODELS2_CANDIDATES = [
    path.join(__dirname, 'models copy', 'models2'),
    path.join(__dirname, 'models', 'models2')
];
const MODELS2_DIR = MODELS2_CANDIDATES.find(d => fs.existsSync(d)) || MODELS2_CANDIDATES[0];
console.log('[models2] serving images from:', MODELS2_DIR);
function listModels2Images() {
  try {
    return fs.readdirSync(MODELS2_DIR)
      .filter(f => /\.(jpe?g|png)$/i.test(f))
      .filter(f => { try { return fs.statSync(path.join(MODELS2_DIR, f)).isFile(); } catch { return false; } })
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[models2] cannot read folder:', e.message);
    return [];
  }
}

// Serve /models2/* from the resolved models2 directory (URL-decoded, traversal-guarded)
app.use('/models2', expressStatic(MODELS2_DIR, { mountPath: '/models2' }));
app.use('/models', expressStatic(path.join(__dirname, 'models copy'), { mountPath: '/models' }));

function expressStatic(root, opts = {}) {
  return function models2Static(req, res, next) {
    const mount = opts.mountPath || '/models2';
    const escMount = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(new RegExp('^' + escMount + '/?'), '');
    if (!rel) { if (!opts.index) { res.statusCode = 404; res.end('not found'); return; } }
    const p = path.resolve(root, rel || 'index.html');
    if (!p.startsWith(path.resolve(root))) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(p, (e, d) => {
      if (e) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Content-Type', MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(d);
    });
  };
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  // Directory listing as index.json — lets the client discover local assets.
  // Only real image files (.jpg/.jpeg/.png/.webp) are listed, so the 3D collection
  // board can load the actual outfit photos directly.
  if (rel.endsWith('/index.json')) {
    const dir = path.join(ROOT, rel.slice(0, -'index.json'.length));
    fs.readdir(dir, (e, files) => {
      if (e) { res.statusCode = 404; res.end('[]'); return; }
      const imgs = files.filter(f => /\.(jpe?g|png|webp)$/i.test(f));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify(imgs));
    });
    return;
  }
  let base = ROOT;
  // Serve /models/models2/* (images) from the Pictures mirror folder.
  if (rel.startsWith('/models/models2/')) base = PICTURES_ROOT;
  let p = path.join(base, rel);
  if (p.endsWith('\\') || p.endsWith('/')) p += 'index.html';
  // Prevent path traversal (against whichever root we resolved into)
  if (!path.resolve(p).startsWith(path.resolve(base))) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(p, (e, d) => {
    if (e) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(d);
  });
}

function replicateImageUrl(output) {
  const value = Array.isArray(output) ? output[output.length - 1] : output;
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return replicateImageUrl(value);
  if (typeof value === 'object') return value.url || value.image || value.output || value.data || '';
  return '';
}

async function analyzeFit(payload) {
  const token = replicateToken('REPLICATE_API_TOKEN1');
  if (!token) return { error: 'NO_REPLICATE_API_TOKEN1', detail: 'Set REPLICATE_API_TOKEN1 in .env to enable virtual try-on and fit analysis.' };
  if (!payload.imageBase64) return { error: 'NO_PHOTO', detail: 'Upload a photo to run virtual try-on and fit analysis.' };
  const outfitImage = payload.outfitImageUrl || payload.outfitImage || '';
  if (!outfitImage) return { error: 'NO_OUTFIT_IMAGE', detail: 'Select an outfit with an image to run virtual try-on.' };
  const outfitName = payload.outfitName || 'selected outfit';
  const measurements = payload.measurements || {};
  try {
    const personImage = `data:${payload.imageMime || 'image/jpeg'};base64,${payload.imageBase64}`;
    const output = await replicateModelPrediction(token, 'cuuupid/idm-vton', {
      human_img: personImage,
      garm_img: outfitImage,
      garment_des: `${outfitName}${payload.brand ? ' by ' + payload.brand : ''}`,
      is_checked: true,
      is_checked_crop: false,
      denoise_steps: 30,
      seed: Math.floor(Math.random() * 2147483647)
    });
    const imageUrl = replicateImageUrl(output);
    const chest = Number(measurements.chest) || 92;
    const waist = Number(measurements.waist) || 74;
    const score = Math.min(98, Math.max(65, 80 + (chest % 12) + (waist % 7)));
    return {
      image: imageUrl,
      imageUrl,
      score,
      fitScore: score,
      outfit: outfitName,
      stylingAdvice: {
        headline: `Virtual try-on created for ${outfitName}.`,
        garment: `The ${outfitName} is visualized on your uploaded photo. Review the shoulder and waist fit in the result and tailor those areas to your measurements (chest ${chest}cm, waist ${waist}cm).`,
        hair: `For a polished ${payload.gender || 'fashion'} look, keep styling balanced and choose a hairstyle that complements the neckline and silhouette.`,
        palette: `Best worn with the ${payload.season || 'seasonal'} palette and ${payload.skin || 'your'} skin tone for a harmonious finish.`
      }
    };
  } catch (error) {
    return { error: 'REPLICATE_TRYON_FAILED', detail: String(error.message || error) };
  }
}

async function generateDesignImage(prompt, profile) {
  const token = replicateAccountToken(replicateToken('REPLICATE_API_TOKEN'));
  if (!token) throw new Error('Set REPLICATE_API_TOKEN in .env to generate design images.');
  const wearer = profile.gender === 'female' ? 'female' : profile.gender === 'male' ? 'male' : 'unisex';
  const description = `High-fashion editorial full-body photograph of a ${wearer} couture outfit: ${prompt}. Made for a ${wearer} wearer, height ${profile.height || 175}cm, ${profile.weight || 68}kg, ${profile.skin || 'any'} skin tone, ${profile.season || 'any season'} palette. Luxurious runway styling, elegant pose, detailed fabric, clean studio background.`;
  const output = await replicateModelPrediction(token, 'black-forest-labs/flux-schnell', {
    prompt: description,
    aspect_ratio: '3:4',
    output_format: 'webp',
    output_quality: 90,
    num_outputs: 1
  });
  const image = replicateImageUrl(output);
  if (!image) throw new Error('Replicate returned no design image.');
  return image;
}

async function geminiDesignImage(prompt, profile) {
  const key = getApiKey();
  if (!key) return { error: 'NO_API_KEY', detail: 'Set GEMINI_API_KEY to generate the outfit image.' };
  const desc = `High-fashion studio photograph of a ${profile.gender === 'female' ? 'female' : 'male'} couture outfit:
${prompt}. Tailored to height ${profile.height}cm, ${profile.weight}kg build, ${profile.skin} skin tone,
${profile.season} season palette. Editorial cyber-atelier lighting, full-body view, elegant runway pose.`;
  const models = ['gemini-2.5-flash-image-preview', 'gemini-2.0-flash-preview-image-generation'];
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: desc }] }],
          generationConfig: { responseModalities: ['IMAGE'], temperature: 0.9 }
        })
      });
      if (!r.ok) continue;
      const j = await r.json();
      const part = (j?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
      const inl = part?.inlineData || part?.inline_data;
      if (inl?.data) return { result: { mime: inl.mimeType || inl.mime_type || 'image/png', base64: inl.data } };
    } catch { /* try next model */ }
  }
  return { error: 'GEMINI_IMAGE_FAILED', detail: 'No image-generation model returned an image.' };
}

const CHANNEL3_API_URL = 'https://api.trychannel3.com/v1/search';
const CLOTHING_TERMS = /clothing|apparel|garment|fashion|shirt|blouse|top|tee|t-shirt|dress|gown|jumpsuit|romper|skirt|trousers|pants|jeans|denim|shorts|jacket|blazer|coat|trench|parka|suit|tuxedo|sweater|knit|cardigan|hoodie|sweatshirt|vest|waistcoat|bodysuit|lingerie|outerwear|activewear|swimwear/i;
const NON_CLOTHING_TERMS = /shoe|sneaker|boot|sandal|heel|loafer|bag|purse|handbag|tote|wallet|belt|watch|sunglass|eyewear|jewel|ring|necklace|earring|bracelet|perfume|fragrance|cosmetic|beauty|makeup|hat|cap|scarf|glove|sock|tie|furniture|electronic|phone|laptop/i;

function channel3ItemText(item) {
  const category = `${item.category?.title || ''} ${item.category?.slug || ''} ${(item.category?.path || []).map(p => p.title || p).join(' ')}`;
  return `${item.title || ''} ${item.description || ''} ${category}`.trim();
}

function isClothingItem(item, gender) {
  const text = channel3ItemText(item);
  const itemGender = String(item.gender || item.audience || '').toLowerCase();
  const genderOk = !itemGender || itemGender === gender || itemGender === 'unisex' || itemGender === 'gender-neutral';
  return genderOk && CLOTHING_TERMS.test(text) && !NON_CLOTHING_TERMS.test(text);
}

function cleanChannel3Product(item, query) {
  const offer = (item.offers || []).find(o => o.availability === 'InStock' || o.availability === 'LimitedAvailability') || item.offers?.[0] || {};
  const priceData = offer.price || {};
  const price = priceData.price ?? priceData.amount ?? offer.price_raw;
  const mainImage = (item.images || []).find(img => img.is_main_image);
  const image = mainImage?.cleaned_url || mainImage?.url || item.images?.[0]?.cleaned_url || item.images?.[0]?.url || '';
  let link = offer.url || item.url || '';
  if (!link && offer.domain) link = `https://${offer.domain}`;
  return {
    title: item.title || query,
    price: price != null && price !== '' ? `${priceData.currency || 'USD'} ${price}` : '',
    image,
    link,
    store: offer.domain || item.brand || item.brand_name || 'Channel3 retailer'
  };
}

async function channel3Search(query, gender) {
  const key = channel3Key();
  if (!channel3Configured()) return null;
  const clothingQuery = `${query} ${gender} clothing apparel`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-api-key': key };
  const response = await fetch(CHANNEL3_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: clothingQuery,
      filters: {
        gender: gender === 'female' ? ['female', 'women', 'unisex'] : ['male', 'men', 'unisex'],
        category: ['clothing', 'apparel'],
        availability: ['InStock', 'LimitedAvailability']
      },
      limit: 20
    })
  });
  if (!response.ok) throw new Error(`Channel3 HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const data = await response.json();
  const products = Array.isArray(data.products) ? data.products
    : Array.isArray(data.results) ? data.results
    : Array.isArray(data.data) ? data.data
    : [];
  const item = products.find(p => isClothingItem(p, gender) && (p.images || []).length) || products.find(p => isClothingItem(p, gender));
  if (!item) return null;
  return cleanChannel3Product(item, query);
}

// Clean fallback: pick a matching curated catalogue item when Channel3 has no result.
const CATALOGUE = [
  { name: 'Aurelia Satin Gown', price: 249, brand: 'vogue', gender: 'female', img: 'https://images.unsplash.com/photo-1566174053879-31528523f8ae?w=600&q=80&auto=format&fit=crop' },
  { name: 'Aurelia Ivory Evening Set', price: 267, brand: 'vogue', gender: 'female', img: 'https://images.unsplash.com/photo-1595777457583-95e0591bbce9?w=600&q=80&auto=format&fit=crop' },
  { name: 'Aurelia Noir Slip Dress', price: 219, brand: 'vogue', gender: 'female', img: 'https://images.unsplash.com/photo-1496737631176-b714589c9bbe?w=600&q=80&auto=format&fit=crop' },
  { name: 'Veloura Midnight Blazer', price: 299, brand: 'noir', gender: 'male', img: 'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=600&q=80&auto=format&fit=crop' },
  { name: 'Veloura Double-Breasted Tux', price: 349, brand: 'noir', gender: 'male', img: 'https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=600&q=80&auto=format&fit=crop' },
  { name: 'Kairos Urban Denim Fit', price: 159, brand: 'karios', gender: 'male', img: 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=600&q=80&auto=format&fit=crop' },
  { name: 'Kairos Street Sculpt Jacket', price: 189, brand: 'karios', gender: 'female', img: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=600&q=80&auto=format&fit=crop' }
];
function fallbackProduct(msg, gender) {
  const m = String(msg || '').toLowerCase();
  const wanted = CATALOGUE.filter(o => o.gender === gender && o.img);
  const keywords = [['dress','gown'],['suit','tux','blazer'],['hoodie'],['denim','jeans'],['jumpsuit'],['jacket']];
  let pick = null;
  for (const ks of keywords) if (ks.some(k => m.includes(k))) {
    pick = wanted.find(o => ks.some(k => o.name.toLowerCase().includes(k))); break;
  }
  if (!pick) pick = wanted[Math.floor(Math.random() * wanted.length)] || CATALOGUE[0];
  return { title: pick.name, price: '$' + pick.price, image: pick.img, link: '', store: pick.brand + ' (curated catalogue fallback)' };
}

async function stylistSearch(payload) {
  const gender = payload.gender === 'female' ? 'female' : 'male';
  const original = String(payload.message || '').trim();
  const query = `${original} ${gender} clothing apparel`.trim();
  const advice = `For your ${gender} wardrobe, look for clothing that matches the requested color and silhouette. Check the garment measurements and fabric details against your profile for a comfortable, flattering fit.`;
  let product = null;
  const channel3Ready = channel3Configured();
  try { product = await channel3Search(original, gender); } catch (error) {
    console.warn('[channel3] clothing search failed:', error.message);
  }
  if (!product) product = fallbackProduct(original, gender);
  const cleanProduct = {
    title: product.title || original || 'Recommended clothing item',
    price: product.price ? String(product.price) : '',
    link: product.link || '',
    image: product.image || '',
    store: product.store || ''
  };
  return { advice, query, gender, product: cleanProduct, channel3: channel3Ready };
}

// ---------- FreeSewing pattern drafting (/api/pattern) ----------
// Maps 5 body measurements to the 32 FreeSewing wants, drafts the design and
// returns SVG containing ONLY stroke-dasharray paths with fill="none" —
// no background rect, no fills, no labels — so the mat/AR show transparent
// dotted outlines over the fabric.
const FS_DESIGNS = {};
(function loadFreeSewing() {
  const deps = {
    simon:   ['@freesewing/simon',   'Simon'],
    titan:   ['@freesewing/titan',   'Titan'],
    aaron:   ['@freesewing/aaron',   'Aaron'],
    brian:   ['@freesewing/brian',   'Brian'],
    bella:   ['@freesewing/bella',   'Bella'],
    waralee: ['@freesewing/waralee', 'Waralee'],
    bent:    ['@freesewing/bent',    'Bent'],
    carlita: ['@freesewing/carlita', 'Carlita']
  };
  for (const [key, [mod, cls]] of Object.entries(deps)) {
    try { FS_DESIGNS[key] = require(mod)[cls]; }
    catch (e) { console.warn('[freesewing] ' + key + ' unavailable:', e.message); }
  }
  console.log('[freesewing] designs ready:', Object.keys(FS_DESIGNS).join(', ') || 'none');
})();

// 5 user measurements (cm) → full FreeSewing measurement set (mm)
function fsMeasurements(m = {}) {
  const chest = (+m.chest || 92) * 10, waist = (+m.waist || 74) * 10, hips = (+m.hips || 96) * 10;
  const shoulder = (+m.shoulder || 42) * 10, wrist = (+m.sleeve || 60) * 10;
  const shoulderToWrist = wrist + shoulder * 0.55;
  return {
    biceps: Math.round(chest * 0.35), chest, waist, hips, seat: hips, highBust: Math.round(chest * 0.93),
    neck: Math.round((+m.chest || 92) * 4.1), shoulderSlope: 13, shoulderToShoulder: shoulder,
    hpsToBust: Math.round(shoulder * 0.58), hpsToWaistBack: shoulder + Math.round(waist * 0.42),
    hpsToWaistFront: shoulder + Math.round(waist * 0.4), waistToArmpit: 240, waistToHips: 200,
    waistToSeat: Math.round(hips * 0.23), waistToFloor: 1040, waistToKnee: 500, knee: 380,
    inseam: 800, upperLeg: 560, crossSeam: 700, crossSeamFront: 330, crotchDepth: Math.round(hips * 0.27),
    bustSpan: Math.round(chest * 0.19), underbust: Math.round(chest * 0.83), bustFront: Math.round(chest * 0.5),
    highBustFront: Math.round(chest * 0.45), waistBack: Math.round(waist * 0.5), seatBack: Math.round(hips * 0.5),
    shoulderToWrist, shoulderToElbow: Math.round(shoulderToWrist * 0.55), wrist, head: 560,
    waistToUpperLeg: 100, heel: 300, ankle: 220
  };
}

function draftFreeSewingSVG(designKey, measurements) {
  const Design = FS_DESIGNS[designKey];
  if (!Design) return null;
  let pattern = new Design({ sa: 10, paperless: true, measurements: fsMeasurements(measurements) });
  try {
    const { pluginTheme } = require('@freesewing/plugin-theme');
    pattern = pattern.use(pluginTheme);
  } catch { /* theme optional */ }
  const raw = pattern.draft().render();
  return outlinesOnlySVG(raw);
}

// Keep ONLY the drawn line geometry: drop the stylesheet (dark backgrounds,
// fills, label colours) and every non-path element (rects, text, circles).
// Every surviving path gets fill="none" + stroke-dasharray.
function outlinesOnlySVG(raw) {
  const i = raw.indexOf('id="fs-container"');
  const start = i > -1 ? raw.lastIndexOf('<g', i) : raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  const body = raw.slice(start, end);
  const paths = [...body.matchAll(/<path\b[^>]*?\bd="([^"]+)"[^>]*>/g)].map(m => m[1]);
  if (!paths.length) return null;
  const drawn = paths.map(d =>
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" ` +
    `stroke-linejoin="round" stroke-dasharray="7 6" vector-effect="non-scaling-stroke"/>`).join('');
  const vbMatch = raw.match(/viewBox="([^"]*)"/);
  const vb = vbMatch ? vbMatch[1] : '0 0 640 440';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${drawn}</svg>`;
}

function readJsonBody(req, limitMB = 15) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  if (req.method === 'POST' && req.url.startsWith('/api/stylist-search')) {
    try {
      const payload = await readJsonBody(req);
      console.log('[stylist-search]', payload.message || '?', '| gender:', payload.gender);
      const out = await stylistSearch(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_REQUEST', detail: String(e.message || e) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/design-idea')) {
    try {
      const payload = await readJsonBody(req);
      console.log('[design-idea]', (payload.prompt || '?').slice(0, 80), '| gender:', payload.profile?.gender);
      const profile = payload.profile || {};
      const prompt = payload.prompt || 'a stunning couture outfit';

      const imageUrl = await generateDesignImage(prompt, profile);
      const reply = `A bespoke ${prompt}, tailored to your ${profile.season || 'versatile'} palette and profile. Pair the look with considered accessories and complementary footwear.`;
      const followUpQuestions = 'Where will you wear this design? Which accessories and shoes would you like to pair with it?';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, followUpQuestions, imageUrl, imageMime: null, imageBase64: null, replicate: true, provider: 'replicate' }));
    } catch (e) {
      // Even on a hard error return a usable JSON payload — never crash the UI
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        reply: 'Design idea received — describe the silhouette, fabric and occasion and the co-designer will refine it with you.',
        followUpQuestions: 'Where will you wear it? Which accessories and shoes would you like to pair?',
        imageUrl: '', imageMime: null, imageBase64: null,
        replicate: false, provider: 'replicate',
        error: 'DESIGN_GENERATION_FAILED', detail: String(e.message || e)
      }));
    }
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/stylist')) {
    // Legacy alias — same behavior
    req.url = '/api/stylist-search';
  }

  if (req.method === 'POST' && req.url.startsWith('/api/analyze-fit')) {
    try {
      const payload = await readJsonBody(req);
      console.log('[analyze-fit]', payload.outfitName || '?', '| photo:', !!payload.imageBase64);
      const out = await analyzeFit(payload);
      res.writeHead(out.error ? 502 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_REQUEST', detail: String(e.message || e) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/pattern')) {
    try {
      const payload = await readJsonBody(req);
      const svg = draftFreeSewingSVG(payload.design, payload.measurements || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ svg, design: payload.design, freesewing: !!svg }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ svg: null, error: 'FS_DRAFT_FAILED', detail: String(e.message || e) }));
    }
    return;
  }

  // Exact current filenames of the renamed images inside models2/
  if (req.method === 'GET' && req.url.startsWith('/api/models2-list')) {
    const files = listModels2Images();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(files));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, replicateFit: !!replicateAccountToken(replicateToken('REPLICATE_API_TOKEN1')), replicateDesign: !!replicateAccountToken(replicateToken('REPLICATE_API_TOKEN')), channel3: channel3Configured() }));
    return;
  }

  if (app.handle(req, res) !== false) return;   // /models2 static mount

  serveStatic(req, res);
});

server.listen(PORT, () => {
  const key = getApiKey();
  console.log(`FashionBuy studio → http://localhost:${PORT}`);
  console.log(key ? 'Gemini API key present' : 'Gemini API key not set');
  console.log('Replicate fit:', replicateToken('REPLICATE_API_TOKEN1') ? 'configured (REPLICATE_API_TOKEN1)' : 'not configured');
  console.log('Replicate design:', replicateToken('REPLICATE_API_TOKEN') ? 'configured (REPLICATE_API_TOKEN)' : 'not configured');
  console.log('Channel3:', channel3Configured() ? 'configured (CHANNEL3_API_KEY)' : 'not configured');
});
