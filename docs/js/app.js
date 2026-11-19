import * as inpainter from './inpainter.js';
import * as video from './video.js';
import { drawMask, badgeRect, badgeCoverage, INTRO_END_SECONDS } from './geometry.js';

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
  refine: $('refine'),
  run: $('run'),
  cancel: $('cancel'),
  download: $('download'),
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
  video: null,
  image: null,         // ImageData of the still
  maskIntro: null,     // ImageData, includes intro state
  maskBadge: null,     // ImageData, badge only
  useIntro: false,
  resultURL: null,
  controller: null,
  modelReady: false,
};

// Deliberately not willReadFrequently: the preview canvas is also the frame
// source for VideoEncoder, which needs a normal (GPU-backed) 2D context.
const ctx = els.preview.getContext('2d');

/* ---------------------------- file intake ---------------------------- */

function onPick() { els.file.click(); }

els.pick.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
els.dropzone.addEventListener('click', onPick);
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
});
els.file.addEventListener('change', () => {
  if (els.file.files?.[0]) load(els.file.files[0]);
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
  const f = e.dataTransfer?.files?.[0];
  if (f) load(f);
});

els.reset.addEventListener('click', reset);
els.showMask.addEventListener('change', paintOutline);

/* ------------------------------ loading ------------------------------ */

async function load(file) {
  reset();
  state.file = file;
  els.name.textContent = file.name;
  els.studio.hidden = false;
  els.dropzone.hidden = true;
  setStatus(`Reading ${file.type.startsWith('image/') ? 'image' : 'video'}…`);

  try {
    if (file.type.startsWith('image/')) {
      await loadImage(file);
    } else {
      await loadVideo(file);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Could not read that file.', true);
  }
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

  prepareMasks(w, h);
  const badgeCov = badgeCoverage(state.image.data, w, h, INTRO_END_SECONDS + 1);
  const introCov = badgeCoverage(state.image.data, w, h, 0);
  state.useIntro = introCov > badgeCov;
  reportDetection(Math.max(badgeCov, introCov), badgeCov >= introCov ? 'badge' : 'intro state');
  els.run.textContent = 'Remove watermark';
  paintOutline();
  setStatus('Ready. The model downloads once (~29 MB) and is then cached.');
}

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';

  await new Promise((resolve, reject) => {
    v.onloadedmetadata = resolve;
    v.onerror = () => reject(new Error('Could not decode this video. Try MP4/H.264.'));
  });

  const w = v.videoWidth & ~1;
  const h = v.videoHeight & ~1;
  state.video = v;
  state.kind = 'video';

  els.preview.width = w;
  els.preview.height = h;
  els.info.textContent = `${w} × ${h} · ${fmtTime(v.duration)}`;

  // Look for the badge mid-clip, and for the tall intro state near the start.
  const mid = await seek(v, Math.min(v.duration * 0.6, v.duration - 0.1));
  ctx.drawImage(mid, 0, 0, w, h);
  const badgeCov = badgeCoverage(ctx.getImageData(0, 0, w, h).data, w, h, INTRO_END_SECONDS + 1);

  const early = await seek(v, Math.min(0.8, v.duration - 0.1));
  ctx.drawImage(early, 0, 0, w, h);
  const introCov = badgeCoverage(ctx.getImageData(0, 0, w, h).data, w, h, 0);

  prepareMasks(w, h);
  state.useIntro = introCov > badgeCov;
  reportDetection(Math.max(badgeCov, introCov), badgeCov >= introCov ? 'badge' : 'intro state');

  await seek(v, 0.05);
  ctx.drawImage(v, 0, 0, w, h);
  state.video.currentTime = 0;
  els.run.textContent = 'Remove watermark';
  paintOutline();
  setStatus('Ready. The model downloads once (~29 MB) and is then cached.');
}

function seek(v, t) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };
    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback(() => finish());
    }
    v.addEventListener('seeked', () => {
      setTimeout(finish, 80);
    }, { once: true });
    v.currentTime = t;
    if (Math.abs(v.currentTime - t) < 0.001) setTimeout(finish, 80);
  });
}

function prepareMasks(w, h) {
  const make = (includeIntro) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cctx = c.getContext('2d', { willReadFrequently: true });
    drawMask(cctx, w, h, { includeIntro });
    return cctx.getImageData(0, 0, w, h);
  };
  state.maskBadge = make(false);
  state.maskIntro = make(true);
}

function reportDetection(coverage, which) {
  const pct = Math.round(coverage * 100);
  const found = coverage > 0.22;
  els.detectDot.className = `dot ${found ? 'ok' : 'warn'}`;
  els.detectText.textContent = found
    ? `OpusClip ${which} found in the top-left corner (${pct}% of the mask box is white).`
    : `No clear badge in the expected corner (${pct}% coverage). It may already be clean, or use a different layout — check “Show mask”.`;
}

/* ------------------------------ preview ------------------------------ */

function paintOutline() {
  const on = els.showMask.checked;
  els.outline.hidden = !on;
  if (!on) return;

  const w = els.preview.width, h = els.preview.height;
  if (!w || !h) return;

  // The canvas is letterboxed inside its stage, so position in pixels relative
  // to the stage rather than in percentages of the wrapper.
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
  if (state.modelReady) return;
  els.backend.textContent = 'loading model…';
  els.backend.classList.add('busy');
  await inpainter.init((p) => {
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
  state.modelReady = true;
  els.backend.classList.remove('busy');
  els.backend.textContent = `model ready · ${inpainter.getBackend()}`;
}

els.run.addEventListener('click', async () => {
  if (!state.file) return;
  els.run.disabled = true;
  els.download.hidden = true;
  els.cancel.hidden = false;
  els.progressWrap.hidden = false;
  state.controller = new AbortController();

  try {
    setStatus('Starting the model…');
    await ensureModel();

    if (state.kind === 'image') {
      await runImage();
    } else {
      await runVideo();
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      setStatus('Cancelled.');
    } else {
      console.error(err);
      setStatus(err.message || 'Something went wrong.', true);
    }
  } finally {
    els.run.disabled = false;
    els.cancel.hidden = true;
    state.controller = null;
  }
});

els.cancel.addEventListener('click', () => state.controller?.abort());

async function runImage() {
  const w = els.preview.width, h = els.preview.height;
  const mask = state.useIntro ? state.maskIntro : state.maskBadge;
  const src = new ImageData(new Uint8ClampedArray(state.image.data), w, h);

  setStatus('Inpainting…');
  els.bar.style.width = '35%';
  const result = await inpainter.inpaint(src, mask, { passes: els.refine.checked ? 2 : 1 });

  ctx.putImageData(result, 0, 0);
  els.bar.style.width = '100%';
  els.progressText.textContent = 'Done';
  setStatus('Done — download or adjust the settings and run again.');

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(result, 0, 0);
  c.toBlob((blob) => offerDownload(blob, `clean-${state.file.name.replace(/\.[^.]+$/, '')}.png`), 'image/png');
}

async function runVideo() {
  const v = state.video;
  v.currentTime = 0;

  setStatus('Recording and inpainting in real time…');
  els.progressText.textContent = 'Preparing…';
  els.bar.style.width = '0%';

  const { blob, mimeType } = await video.processVideo({
    file: state.file,
    canvas: els.preview,
    intro: state.useIntro,
    temporal: els.temporal.checked,
    passes: els.refine.checked ? 2 : 1,
    signal: state.controller.signal,
    onProgress: ({ value }) => {
      const pct = Math.min(99, Math.round(value * 100));
      els.bar.style.width = `${pct}%`;
      els.progressText.textContent = `Inpainting — ${pct}%`;
    },
  });

  els.bar.style.width = '100%';
  els.progressText.textContent = 'Done';
  setStatus(`Done · ${(blob.size / 1048576).toFixed(1)} MB ${/mp4/.test(mimeType) ? 'MP4' : 'WebM'}`);
  offerDownload(blob, video.outputName(state.file.name, mimeType));
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
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.controller?.abort();
  state.video?.pause?.();
  state.file = null;
  state.kind = null;
  state.video = null;
  state.image = null;
  state.resultURL = null;
  state.useIntro = false;

  els.studio.hidden = true;
  els.dropzone.hidden = false;
  els.download.hidden = true;
  els.cancel.hidden = true;
  els.progressWrap.hidden = true;
  els.bar.style.width = '0%';
  els.status.textContent = '';
  els.status.classList.remove('error');
  els.detectDot.className = 'dot';
  els.detectText.textContent = 'Read the first frame to check for the badge…';
  els.file.value = '';
}
