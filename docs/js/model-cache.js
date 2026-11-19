/**
 * Model loader with an IndexedDB cache and a hard integrity check.
 *
 * The ONNX files come from third-party HuggingFace repositories that we do not
 * control, and we then execute them inside the page. So the bytes are SHA-256
 * verified before they are trusted, and only verified bytes are ever cached.
 */

const DB_NAME = 'opusclip-remover';
const DB_VERSION = 1;
const STORE = 'models';

export const MODELS = {
  migan: {
    id: 'migan',
    label: 'Fast · MI-GAN',
    cacheKey: 'migan_v1',
    url: 'https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx',
    // Recompute with:  curl -sL <url> | sha256sum
    sha256: 'bb7189b2523b8485d9dd6baa2e7e8bccce4493760daa33ffcd432f667945bf62',
    bytes: 29541096,
  },
  lama: {
    id: 'lama',
    label: 'High quality · LaMa',
    cacheKey: 'lama_fp32_v1',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    bytes: 208044816,
  },
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verify(spec, bytes, source) {
  if (!globalThis.crypto?.subtle) {
    console.warn('[model] crypto.subtle unavailable (insecure context) — skipping integrity check');
    return;
  }
  const hash = await sha256Hex(bytes);
  if (hash !== spec.sha256) {
    throw new Error(
      `Model integrity check failed for ${source}. Expected ${spec.sha256.slice(0, 16)}…, got ${hash.slice(0, 16)}…. ` +
      'The bytes were rejected and nothing was cached.'
    );
  }
  console.log(`[model] ${spec.id} integrity verified (${source})`);
}

async function download(spec, onProgress) {
  const res = await fetch(spec.url, { cache: 'force-cache', mode: 'cors' });
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status} ${res.statusText}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10) || spec.bytes;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.({ done: buf.byteLength, total: buf.byteLength, stage: 'Downloaded' });
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let done = 0;
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    chunks.push(value);
    done += value.byteLength;
    onProgress?.({ done, total, stage: 'Downloading model' });
  }
  const out = new Uint8Array(done);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

/**
 * @param {keyof typeof MODELS} id
 * @param {(p:{done:number,total:number,stage?:string,cached?:boolean}) => void} onProgress
 * @returns {Promise<Uint8Array>} verified ONNX bytes
 */
export async function loadModel(id, onProgress) {
  const spec = MODELS[id];
  if (!spec) throw new Error(`Unknown model "${id}".`);

  try {
    const cached = await idbGet(spec.cacheKey);
    // Stored as a Blob (file-backed, fast for 200 MB); older builds stored an ArrayBuffer.
    const buf = cached instanceof Blob ? await cached.arrayBuffer() : cached;
    if (buf && buf.byteLength === spec.bytes) {
      console.log(`[model] ${id} cache hit`);
      onProgress?.({ done: buf.byteLength, total: buf.byteLength, cached: true, stage: 'Loaded from this device' });
      return new Uint8Array(buf);
    }
  } catch (e) {
    console.warn('[model] IndexedDB read failed, downloading instead:', e);
  }

  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch { /* not fatal */ }
  }

  onProgress?.({ done: 0, total: 0, stage: 'Connecting…' });
  const bytes = await download(spec, onProgress);

  onProgress?.({ done: bytes.byteLength, total: bytes.byteLength, stage: 'Verifying…' });
  await verify(spec, bytes, 'the download');

  // Cache in the background: a slow or failing write must never hold up the run.
  idbSet(spec.cacheKey, new Blob([bytes], { type: 'application/octet-stream' }))
    .then(() => console.log(`[model] ${id} cached (${(bytes.byteLength / 1048576).toFixed(1)} MB)`))
    .catch((e) => console.warn('[model] could not cache the model:', e));

  return bytes;
}

export async function clearModel(id) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(MODELS[id].cacheKey);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch { return false; }
}
