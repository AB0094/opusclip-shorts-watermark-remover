import * as inpainter from './inpainter.js';
import * as video from './video.js';
import { MODELS } from './model-cache.js';
import { createDetector } from './watermark.js';
import { badgeRect } from './geometry.js';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  file: $('file'),
  pick: $('pick'),
  studio: $('studio'),
  name: $('file-name'),
  info: $('file-info'),
  preview: $('preview'),
  wrap: $('canvas-wrap'),
  outline: $('badge-outline'),
  showMask: $('show-mask'),
  temporal: $('temporal'),
  speed: $('speed'),
  model: $('model'),
  modelNote: $('model-note'),
  run: $('run'),
  cancel: $('cancel'),
  download: $('download'),
  downloadAll: $('download-all'),
  queueWrap: $('queue-wrap'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  reset: $('reset'),
  progressWrap: $('progress-wrap'),
  bar: $('bar'),
  progressText: $('progress-text'),
  status: $('status'),
  backend: $('backend-pill'),
  detectDot: $('detect-dot'),
  detectText: $('detect-text'),
};

const state = {
  file: null,
  kind: null,          // 'video' | 'image'
  image: null,         // ImageData of the still
  resultURL: null,
  controller: null,
  loadToken: 0,
  queue: [],           // batch: [{ file, li, url, filename }]
};

const ctx = els.preview.getContext('2d');

/* ---------------------------- model picker ---------------------------- */

for (const spec of Object.values(MODELS)) {
  const opt = document.createElement('option');
  opt.value = spec.id;
  opt.textContent = `${spec.label} (${Math.round(spec.bytes / 1048576)} MB)`;
  els.model.appendChild(opt);
}
try { els.model.value = localStorage.getItem('opusclip-model') || 'migan'; } catch { /* storage blocked */ }
if (!els.model.value) els.model.value = 'migan';

const MODEL_NOTES = {
  migan: 'Quick, a little soft on fine detail such as glasses frames.',
  lama: 'Reconstructs thin structures (glasses, hair strands) much better. One-time 208 MB download; several times slower per frame, so clips take minutes.',
};
function showModelNote() {
  els.modelNote.textContent = MODEL_NOTES[els.model.value] || '';
  try { localStorage.setItem('opusclip-model', els.model.value); } catch { /* storage blocked */ }
}
els.model.addEventListener('change', showModelNote);

try { els.speed.value = localStorage.getItem('opusclip-speed') || 'balanced'; } catch { /* storage blocked */ }
if (!els.speed.value) els.speed.value = 'balanced';
els.speed.addEventListener('change', () => {
  try { localStorage.setItem('opusclip-speed', els.speed.value); } catch { /* storage blocked */ }
});
showModelNote();

/* ---------------------------- file intake ---------------------------- */

function onPick() { els.file.click(); }

els.pick.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
els.dropzone.addEventListener('click', onPick);
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
});
els.file.addEventListener('change', () => {
  if (els.file.files?.length) loadMany([...els.file.files]);
});

for (const evt of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('over');
  });
}
for (const evt of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('over');
  });
}
els.dropzone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|png|jpe?g)$/i.test(f.name));
  if (files.length) loadMany(files);
});

els.reset.addEventListener('click', reset);
els.showMask.addEventListener('change', paintOutline);

/* ------------------------------ loading ------------------------------ */

/** One file: the usual single flow. Several: preview the first, list them all, run them in turn. */
async function loadMany(files) {
  const first = load(files[0]);   // load() resets synchronously, so the queue is set after it
  if (files.length > 1) setQueue(files);
  await first;
  if (files.length > 1) {
    els.run.textContent = `Remove watermark from all ${files.length}`;
    setStatus(`${files.length} files queued. They run one after another; the model loads once.`);
  }
}

function setQueue(files) {
  els.queue.textContent = '';
  state.queue = files.map((file) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'q-name';
    name.textContent = file.name;
    name.title = file.name;
    const st = document.createElement('span');
    st.className = 'q-state';
    st.textContent = 'waiting';
    li.append(name, st);
    els.queue.appendChild(li);
    return { file, li, st, url: null, filename: null };
  });
  els.queueCount.textContent = `${files.length} files`;
  els.queueWrap.hidden = false;
}

function setItem(item, cls, text) {
  item.li.className = cls;
  item.st.textContent = text;
}

async function load(file) {
  reset();
  const token = ++state.loadToken;
  state.file = file;
  els.name.textContent = file.name;
  els.studio.hidden = false;
  els.dropzone.hidden = true;
  setStatus(`Reading ${file.type.startsWith('image/') ? 'image' : 'video'}…`);

  try {
    if (file.type.startsWith('image/')) {
      await loadImage(file);
    } else {
      await loadVideo(file, token);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Could not read that file.', true);
  }
}

/** Window of the frame the detector looks at, as RGBA on the 512 model grid. */
function windowPixels(source, detector) {
  const { plan } = detector;
  const c = new OffscreenCanvas(inpainter.SIZE, inpainter.SIZE);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, plan.x, plan.y, plan.win, plan.win, 0, 0, inpainter.SIZE, inpainter.SIZE);
  return g.getImageData(0, 0, inpainter.SIZE, inpainter.SIZE);
}

async function loadImage(file) {
  const bmp = await createImageBitmap(file);
  const w = bmp.width & ~1;
  const h = bmp.height & ~1;

  els.preview.width = w;
  els.preview.height = h;
  ctx.drawImage(bmp, 0, 0, w, h);
  state.kind = 'image';
  state.image = ctx.getImageData(0, 0, w, h);
  els.info.textContent = `${w} × ${h} · still image`;

  const detector = await createDetector(w, h);
  const verdict = detector.analyze(windowPixels(els.preview, detector).data, { still: true });
  reportDetection(verdict.state);
  els.run.textContent = 'Remove watermark';
  paintOutline();
  setStatus('Ready.');
}

async function loadVideo(file, token) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';

  try {
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error('Could not decode this video. Try MP4/H.264.'));
    });

    const w = v.videoWidth & ~1;
    const h = v.videoHeight & ~1;
    state.kind = 'video';
    els.preview.width = w;
    els.preview.height = h;
    els.info.textContent = `${w} × ${h} · ${fmtTime(v.duration)}`;

    // Sample a handful of frames: the badge may not be there yet at t=0, and
    // once it has appeared it stays to the end.
    const detector = await createDetector(w, h);
    const times = [0.05, 0.25, 0.45, 0.65, 0.85, 0.97].map((f) => Math.min(v.duration - 0.1, f * v.duration));
    let best = 'none';
    let previewAt = times[times.length - 1];
    for (const t of times) {
      if (token !== state.loadToken) return;
      await seek(v, Math.max(0.05, t));
      const verdict = detector.analyze(windowPixels(v, detector).data, { still: true });
      if (verdict.state === 'settled') { best = 'settled'; previewAt = t; break; }
      if (verdict.state === 'anim') { best = 'anim'; previewAt = t; }
    }
    if (token !== state.loadToken) return;

    await seek(v, Math.max(0.05, previewAt));
    ctx.drawImage(v, 0, 0, w, h);
    reportDetection(best);
    els.run.textContent = 'Remove watermark';
    paintOutline();
    setStatus('Ready. Everything runs locally; the model downloads once and is then cached.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function seek(v, t) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };
    v.addEventListener('seeked', () => setTimeout(finish, 60), { once: true });
    setTimeout(finish, 2500);
    v.currentTime = t;
  });
}

function reportDetection(kind) {
  const found = kind !== 'none';
  els.detectDot.className = `dot ${found ? 'ok' : 'warn'}`;
  els.detectText.textContent =
    kind === 'settled' ? 'OpusClip badge found in the top-left corner.'
      : kind === 'anim' ? 'OpusClip intro animation found in the top-left corner.'
        : 'No OpusClip badge found in the sampled frames. It may already be clean, or use a different layout.';
}

/* ------------------------------ preview ------------------------------ */

function paintOutline() {
  const on = els.showMask.checked;
  els.outline.hidden = !on;
  if (!on) return;

  const w = els.preview.width, h = els.preview.height;
  if (!w || !h) return;

  const cr = els.preview.getBoundingClientRect();
  const wr = els.wrap.getBoundingClientRect();
  if (!cr.width || !cr.height) return;

  const r = badgeRect(w);
  const sx = cr.width / w;
  const sy = cr.height / h;

  const box = els.outline;
  box.style.left = `${cr.left - wr.left + r.x * sx}px`;
  box.style.top = `${cr.top - wr.top + r.y * sy}px`;
  box.style.width = `${r.w * sx}px`;
  box.style.height = `${r.h * sy}px`;
  box.dataset.label = `${Math.round(r.w)} × ${Math.round(r.h)} px`;
}

window.addEventListener('resize', paintOutline);
if ('ResizeObserver' in window) new ResizeObserver(paintOutline).observe(els.wrap);

/* ------------------------------- run -------------------------------- */

async function ensureModel() {
  const id = els.model.value;
  if (inpainter.isReady() && inpainter.getModelId() === id) return;
  els.backend.textContent = 'loading model…';
  els.backend.classList.add('busy');
  try {
    await inpainter.init(id, (p) => {
      if (p.stage) {
        els.backend.textContent = p.stage;
        if (p.total) {
          els.progressWrap.hidden = false;
          const pct = (p.done / p.total) * 100;
          els.bar.style.width = `${pct}%`;
          els.progressText.textContent = `${p.stage} — ${Math.round(pct)}%`;
        }
      }
    });
  } finally {
    els.backend.classList.remove('busy');
  }
  els.backend.textContent = `${id} · ${inpainter.getBackend()}`;
}

els.run.addEventListener('click', async () => {
  if (!state.file) return;
  els.run.disabled = true;
  els.model.disabled = true;
  els.speed.disabled = true;
  els.download.hidden = true;
  els.downloadAll.hidden = true;
  els.cancel.hidden = false;
  els.progressWrap.hidden = false;
  state.controller = new AbortController();

  try {
    setStatus('Starting the model…');
    await ensureModel();

    if (state.queue.length > 1) {
      await runBatch();
    } else {
      const r = state.kind === 'image' ? await runImage() : await runVideo();
      if (r) offerDownload(r.blob, r.filename);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      setStatus('Cancelled.');
    } else {
      console.error(err);
      setStatus(err.message || 'Something went wrong.', true);
    }
  } finally {
    els.run.disabled = state.queue.length > 1 && state.queue.every((it) => it.url || it.skipped);
    els.model.disabled = false;
    els.speed.disabled = false;
    els.cancel.hidden = true;
    state.controller = null;
  }
});

async function runBatch() {
  const todo = state.queue.filter((it) => !it.url && !it.skipped);
  let done = state.queue.length - todo.length, failed = 0;
  for (const item of todo) {
    if (state.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const n = state.queue.indexOf(item) + 1;
    setItem(item, 'active', 'working…');
    item.li.scrollIntoView({ block: 'nearest' });
    els.name.textContent = item.file.name;
    try {
      state.file = item.file;
      if (item.file.type.startsWith('image/')) {
        await loadImage(item.file);
      } else {
        state.kind = 'video';
        els.info.textContent = `file ${n} of ${state.queue.length}`;
      }
      const r = state.kind === 'image'
        ? await runImage()
        : await runVideo((pct) => { item.st.textContent = `${pct}%`; });
      if (!r) { item.skipped = true; setItem(item, 'done', 'no badge'); done++; continue; }
      item.url = URL.createObjectURL(r.blob);
      item.filename = r.filename;
      const a = document.createElement('a');
      a.href = item.url;
      a.download = r.filename;
      a.textContent = 'download';
      setItem(item, 'done', '');
      item.st.appendChild(a);
      done++;
    } catch (err) {
      if (err?.name === 'AbortError') { setItem(item, '', 'cancelled'); throw err; }
      console.error(item.file.name, err);
      setItem(item, 'failed', 'failed');
      item.st.title = err?.message || String(err);
      failed++;
    }
  }
  els.bar.style.width = '100%';
  els.progressText.textContent = 'Batch done';
  setStatus(`Batch done · ${done} of ${state.queue.length} cleaned${failed ? ` · ${failed} failed (hover for the reason)` : ''}.`, failed > 0 && !done);
  els.downloadAll.hidden = !state.queue.some((it) => it.url);
  const left = state.queue.filter((it) => !it.url && !it.skipped).length;
  els.run.textContent = left ? `Retry ${left} remaining` : 'All done';
  els.run.disabled = !left;
}

els.downloadAll.addEventListener('click', async () => {
  // One click per file; the browser may ask once to allow multiple downloads.
  for (const it of state.queue) {
    if (!it.url) continue;
    const a = document.createElement('a');
    a.href = it.url;
    a.download = it.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
});

els.cancel.addEventListener('click', () => state.controller?.abort());

async function runImage() {
  const w = els.preview.width, h = els.preview.height;
  const detector = await createDetector(w, h);
  const { plan } = detector;

  ctx.putImageData(state.image, 0, 0);
  const win = windowPixels(els.preview, detector);
  const verdict = detector.analyze(win.data, { still: true });
  if (!verdict.mask) {
    els.bar.style.width = '100%';
    els.progressText.textContent = 'Nothing to remove';
    setStatus('No badge pixels found in the expected corner, so the image was left unchanged.');
    return null;
  }

  setStatus('Inpainting…');
  els.bar.style.width = '35%';
  const filled = await inpainter.fill(win.data, verdict.mask);

  const overlay = new OffscreenCanvas(inpainter.SIZE, inpainter.SIZE);
  overlay.getContext('2d').putImageData(
    new ImageData(inpainter.buildOverlay(filled, verdict.mask), inpainter.SIZE, inpainter.SIZE), 0, 0);
  ctx.imageSmoothingEnabled = plan.win !== inpainter.SIZE;
  ctx.drawImage(overlay, 0, 0, inpainter.SIZE, inpainter.SIZE, plan.x, plan.y, plan.win, plan.win);

  els.bar.style.width = '100%';
  els.progressText.textContent = 'Done';
  setStatus('Done — download the result.');
  const blob = await new Promise((r) => els.preview.toBlob(r, 'image/png'));
  return { blob, filename: `clean-${state.file.name.replace(/\.[^.]+$/, '')}.png` };
}

async function runVideo(onPct) {
  setStatus('Processing every frame…');
  els.progressText.textContent = 'Preparing…';
  els.bar.style.width = '0%';

  const result = await video.processVideo({
    file: state.file,
    canvas: els.preview,
    temporal: els.temporal.checked,
    speed: els.speed.value,
    signal: state.controller.signal,
    onInfo: ({ backend }) => { els.backend.textContent = backend; },
    onProgress: ({ value, fps }) => {
      const pct = Math.min(99, Math.round(value * 100));
      els.bar.style.width = `${pct}%`;
      els.progressText.textContent = `Frame by frame — ${pct}% · ${fps.toFixed(1)} fps`;
      onPct?.(pct);
    },
  });

  const { blob, stats, audioNote } = result;
  els.bar.style.width = '100%';
  els.progressText.textContent = 'Done';
  const cleaned = stats.settled + stats.anim;
  setStatus(`Done · ${(blob.size / 1048576).toFixed(1)} MB MP4 · badge removed on ${cleaned} of ${stats.frames} frames (model ran ${stats.inferred}×, reused ${stats.reused}×) · ${audioNote}`);
  return { blob, filename: video.outputName(state.file.name) };
}

function offerDownload(blob, filename) {
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = URL.createObjectURL(blob);
  els.download.href = state.resultURL;
  els.download.download = filename;
  els.download.hidden = false;
}

/* ------------------------------ helpers ------------------------------ */

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', !!isError);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function reset() {
  state.loadToken++;
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.controller?.abort();
  state.file = null;
  state.kind = null;
  state.image = null;
  state.resultURL = null;
  for (const it of state.queue) if (it.url) URL.revokeObjectURL(it.url);
  state.queue = [];
  els.queue.textContent = '';
  els.queueWrap.hidden = true;
  els.downloadAll.hidden = true;

  els.studio.hidden = true;
  els.dropzone.hidden = false;
  els.download.hidden = true;
  els.cancel.hidden = true;
  els.progressWrap.hidden = true;
  els.bar.style.width = '0%';
  els.status.textContent = '';
  els.status.classList.remove('error');
  els.detectDot.className = 'dot';
  els.detectText.textContent = 'Checking a few frames for the badge…';
  els.file.value = '';
}
