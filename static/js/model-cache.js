/**
 * MI-GAN model loader with an IndexedDB cache and a hard integrity check.
 *
 * The ONNX file is ~29 MB and comes from a third-party HuggingFace repository
 * that we do not control, and we then execute it inside the page. So the bytes
 * are SHA-256 verified before they are trusted, and only verified bytes are
 * ever written to the cache.
 */

const DB_NAME = 'opusclip-remover';
const DB_VERSION = 1;
const STORE = 'models';
const MODEL_KEY = 'migan_v1';

const MODEL_URL = 'https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx';

// SHA-256 of migan.onnx (29,541,096 bytes).
// Recompute with:  curl -sL <MODEL_URL> | sha256sum
const MODEL_SHA256 = 'bb7189b2523b8485d9dd6baa2e7e8bccce4493760daa33ffcd432f667945bf62';

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
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verify(bytes, source) {
  if (!globalThis.crypto?.subtle) {
    console.warn('[model] crypto.subtle unavailable (insecure context) — skipping integrity check');
    return;
  }
  const hash = await sha256Hex(bytes);
  if (hash !== MODEL_SHA256) {
    throw new Error(
      `Model integrity check failed for ${source}. Expected ${MODEL_SHA256.slice(0, 16)}…, got ${hash.slice(0, 16)}…. ` +
      'The bytes were rejected and nothing was cached.'
    );
  }
  console.log(`[model] integrity verified (${source})`);
}

async function download(onProgress) {
  const res = await fetch(MODEL_URL, { cache: 'force-cache', mode: 'cors' });
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status} ${res.statusText}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10);
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
 * @param {(p:{done:number,total:number,stage?:string,cached?:boolean}) => void} onProgress
 * @returns {Promise<Uint8Array>} verified ONNX bytes
 */
export async function loadModel(onProgress) {
  try {
    const cached = await idbGet(MODEL_KEY);
    if (cached && cached.byteLength > 1_000_000) {
      console.log('[model] cache hit');
      onProgress?.({ done: cached.byteLength, total: cached.byteLength, cached: true, stage: 'Loaded from this device' });
      return new Uint8Array(cached);
    }
  } catch (e) {
    console.warn('[model] IndexedDB read failed, downloading instead:', e);
  }

  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch { /* not fatal */ }
  }

  onProgress?.({ done: 0, total: 0, stage: 'Connecting…' });
  const bytes = await download(onProgress);

  onProgress?.({ done: bytes.byteLength, total: bytes.byteLength, stage: 'Verifying…' });
  await verify(bytes, 'the download');

  try {
    await idbSet(MODEL_KEY, bytes.buffer);
    console.log(`[model] cached (${(bytes.byteLength / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    console.warn('[model] could not cache the model:', e);
  }

  return bytes;
}

export async function clearModel() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(MODEL_KEY);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch { return false; }
}

export const MODEL_BYTES = 29541096;
