/**
 * Video pipeline.
 *
 * Frame flow:
 *   <video> --drawImage--> output canvas (+ last patch pasted over the badge)
 *                                |
 *                                +--> VideoEncoder (H.264) --+
 *                                                            +--> mp4-muxer --> .mp4
 *   file --decodeAudioData--> PCM --AudioEncoder (AAC) ------+
 *
 * Two decisions worth knowing about:
 *
 *  - The patch is tiny and refreshed asynchronously. The badge is ~1.7% of the
 *    frame, but a CPU inpainter needs about a second per run. So the frame is
 *    always presented live and the newest patch is pasted over the badge; only
 *    that box lags behind, never the whole picture, and only on slow backends.
 *
 *  - Export is frame-timestamped, not wall-clock. MediaRecorder's canvas capture
 *    silently produced audio-only (or 0-byte) files with an MP4 mime type, so
 *    the primary path encodes with WebCodecs and muxes with mp4-muxer. Every
 *    chunk carries the source presentation time, so the output keeps the clip's
 *    real duration and audio offset even when inference stalls.
 *
 * MediaRecorder/WebM remains as a fallback for browsers without VideoEncoder.
 */

import { drawMask, badgeRect, INTRO_END_SECONDS } from './geometry.js';
import * as inpainter from './inpainter.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs';
const TARGET_FPS = 30;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Cut the mask down to the crop window (cached — the mask never moves). */
const maskCropCache = new Map();
function maskCrop(maskData, crop, variant) {
  const key = `${variant}:${maskData.width}:${crop.x},${crop.y},${crop.size}`;
  const hit = maskCropCache.get(key);
  if (hit) return hit;

  const src = new OffscreenCanvas(maskData.width, maskData.height);
  src.getContext('2d').putImageData(maskData, 0, 0);
  const dst = new OffscreenCanvas(crop.size, crop.size);
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.drawImage(src, crop.x, crop.y, crop.size, crop.size, 0, 0, crop.size, crop.size);
  const data = dctx.getImageData(0, 0, crop.size, crop.size);
  maskCropCache.set(key, data);
  return data;
}

/**
 * @param {object} o
 * @param {File} o.file
 * @param {HTMLCanvasElement} [o.canvas]  reuse an existing preview canvas
 * @param {boolean} [o.intro]             clip shows the vertical intro state
 * @param {(p:{phase:string, value:number}) => void} [o.onProgress]
 * @param {(i:{backend:string}) => void} [o.onInfo]
 * @param {boolean} [o.temporal]
 * @param {number} [o.passes]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob:Blob, mimeType:string, width:number, height:number, frames:number, patches:number, backend:string}>}
 */
export async function processVideo(o) {
  const { file, onProgress, signal } = o;
  const temporal = o.temporal !== false;
  const passes = o.passes ?? 1;
  // Only clips that actually show the vertical intro state get the tall mask.
  // Applying it to a clip that is already settled wipes a strip of real content.
  const hasIntro = o.intro !== false;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('Could not decode this video. Try MP4/H.264.'));
  });

  const width = video.videoWidth & ~1;
  const height = video.videoHeight & ~1;
  if (!width || !height) throw new Error('Video has no usable dimensions.');

  const out = o.canvas || makeCanvas(width, height);
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d', { alpha: false });
  outCtx.fillStyle = '#000';
  outCtx.fillRect(0, 0, width, height);

  // ---- fixed mask geometry, scaled to this video ----
  const maskCanvas = makeCanvas(width, height);
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  maskCtx.clearRect(0, 0, width, height);
  drawMask(maskCtx, width, height, { includeIntro: false });
  const basePixels = maskCtx.getImageData(0, 0, width, height);

  let introPixels = basePixels;
  if (hasIntro) {
    maskCtx.clearRect(0, 0, width, height);
    drawMask(maskCtx, width, height, { includeIntro: true });
    introPixels = maskCtx.getImageData(0, 0, width, height);
  }

  const plan = inpainter.createPlan(hasIntro ? introPixels : basePixels, { context: 1.15 });
  if (!plan) throw new Error('Mask is empty — nothing to remove.');
  const crop = { x: plan.x, y: plan.y, size: plan.size };

  const cropMaskBase = maskCrop(basePixels, crop, 'badge');
  const cropMaskIntro = hasIntro ? maskCrop(introPixels, crop, 'intro') : cropMaskBase;
  const runnerBase = inpainter.createCropRunner(cropMaskBase, plan.size);
  const runnerIntro = hasIntro ? inpainter.createCropRunner(cropMaskIntro, plan.size) : runnerBase;
  if (!runnerBase) throw new Error('Mask is empty — nothing to remove.');

  const cropCanvas = makeCanvas(plan.size, plan.size);
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

  // ---- patch state shared by both export paths ----
  let patches = 0;
  let frames = 0;
  let busy = false;
  let lastPatch = null;
  let lastRunner = null;
  const ring = [];

  const currentRunner = () =>
    hasIntro && video.currentTime < INTRO_END_SECONDS ? runnerIntro : runnerBase;

  async function repaint() {
    if (busy || signal?.aborted) return;
    busy = true;
    const runner = currentRunner();
    try {
      cropCtx.drawImage(video, crop.x, crop.y, crop.size, crop.size, 0, 0, crop.size, crop.size);
      const frame = cropCtx.getImageData(0, 0, crop.size, crop.size);
      const filled = await runner.run(frame, { passes });

      if (runner !== lastRunner) {
        ring.length = 0;          // mask changed; old fills would smear
        lastRunner = runner;
      }

      let result = filled;
      if (temporal) {
        ring.push(filled);
        if (ring.length > 3) ring.shift();
        if (ring.length === 3) {
          // Only smooth when the patch is nearly still; otherwise the median
          // lags a moving face by a full patch interval.
          const motion = inpainter.patchMotion(ring[1], ring[2], runner.bbox);
          if (motion < 4) result = inpainter.temporalMedian(ring, runner.mask, runner.bbox);
        }
      }
      lastPatch = inpainter.extractPatch(result, runner.bbox, crop);
      if (lastPatch) paintPatch(lastPatch);
      patches++;
    } catch (err) {
      console.error('[video] repaint failed:', err);
    } finally {
      busy = false;
    }
  }

  // ---- patch compositor: feathered border so the fill fades into the live
  // frame instead of stamping a hard rectangle over moving content ----
  let patchCanvas = null;
  let patchCtx = null;
  let patchFeather = null;

  function ensurePatchCanvas(w, h) {
    if (patchCanvas && patchCanvas.width === w && patchCanvas.height === h) return;
    patchCanvas = makeCanvas(w, h);
    patchCtx = patchCanvas.getContext('2d');

    const solid = makeCanvas(w, h);
    const sc = solid.getContext('2d');
    sc.fillStyle = '#fff';
    const inset = 4;
    sc.fillRect(inset, inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2));

    patchFeather = makeCanvas(w, h);
    const fc = patchFeather.getContext('2d');
    fc.filter = `blur(${inset}px)`;
    fc.drawImage(solid, 0, 0);
    fc.filter = 'none';
  }

  function paintPatch(patch) {
    if (!patch) return;
    ensurePatchCanvas(patch.w, patch.h);
    patchCtx.putImageData(patch.data, 0, 0);
    patchCtx.globalCompositeOperation = 'destination-in';
    patchCtx.drawImage(patchFeather, 0, 0);
    patchCtx.globalCompositeOperation = 'source-over';
  }

  function present() {
    outCtx.drawImage(video, 0, 0, width, height);
    if (lastPatch) outCtx.drawImage(patchCanvas, lastPatch.x, lastPatch.y);
    frames++;
  }

  // Prime the patch before the first encoded frame so the export never opens
  // on a badge.
  video.currentTime = 0.02;
  await new Promise((r) => { video.onseeked = r; });
  await repaint();

  const muxerMod = await import(MUXER_URL).catch((e) => {
    console.warn('[video] mp4-muxer unavailable, falling back to MediaRecorder:', e?.message);
    return null;
  });

  let result;
  if (muxerMod && typeof VideoEncoder !== 'undefined') {
    result = await encodeWebCodecs({
      ...o, muxerMod, video, out, outCtx, present, repaint, crop, width, height,
      repaintBusy: () => busy,
    });
  } else {
    result = await recordWebM({ ...o, video, out, present, repaint });
  }

  URL.revokeObjectURL(url);
  maskCropCache.clear();
  return { ...result, width, height, frames, patches };
}

/* ------------------------------------------------------------------ *
 * Primary path: WebCodecs
 * ------------------------------------------------------------------ */

async function encodeWebCodecs(ctx) {
  const {
    video, out, outCtx, present, repaint, file, signal, onProgress, onInfo, muxerMod,
    width, height,
  } = ctx;
  const { Muxer, ArrayBufferTarget } = muxerMod;

  const bitrate = Math.min(Math.round(width * height * 4.5), 14_000_000);

  const candidates = ['avc1.64002a', 'avc1.4d002a', 'avc1.640033', 'avc1.4d0033'];
  let videoConfig = null;
  for (const codec of candidates) {
    const cfg = {
      codec,
      width,
      height,
      bitrate,
      framerate: TARGET_FPS,
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) { videoConfig = support.config || cfg; break; }
    } catch { /* try the next profile */ }
  }
  if (!videoConfig) throw new Error('This browser has no H.264 encoder available (WebCodecs).');

  // ---- audio: decode the whole track to PCM, then re-encode to AAC ----
  let audioBuffer = null;
  try {
    const bytes = await file.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer = await ac.decodeAudioData(bytes);
    ac.close().catch(() => {});
  } catch (e) {
    console.warn('[video] audio decode failed; exporting video only:', e?.message);
  }

  let audioConfig = null;
  let audioEngine = null;
  if (audioBuffer && typeof AudioEncoder !== 'undefined') {
    const channels = Math.min(2, audioBuffer.numberOfChannels);
    const cfg = {
      codec: 'mp4a.40.2',
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: channels,
      bitrate: 160_000,
    };
    try {
      const support = await AudioEncoder.isConfigSupported(cfg);
      if (support.supported) {
        audioConfig = cfg;
        audioEngine = { buffer: audioBuffer, channels };
      }
    } catch { /* no AAC encoder */ }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: TARGET_FPS },
    ...(audioConfig ? { audio: { codec: 'aac', sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.numberOfChannels } } : {}),
    // The first sampled frame lands a few milliseconds after zero (we prime the
    // patch by seeking to 0.02 s), which mp4-muxer refuses by default.
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory',
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; console.error('[video] encoder error:', e); },
  });
  encoder.configure(videoConfig);
  onInfo?.({ backend: `WebCodecs ${videoConfig.codec}` });

  const step = 1 / TARGET_FPS;
  let lastTs = -1;
  let keyframes = 0;

  const encodeIfDue = (mediaTime) => {
    if (mediaTime < lastTs + step * 0.9) return;
    const ts = Math.round(mediaTime * 1e6);
    const frame = new VideoFrame(out, {
      timestamp: ts,
      duration: Math.round(1e6 / TARGET_FPS),
    });
    const keyFrame = keyframes === 0 || mediaTime - lastKeyTime >= 2;
    if (keyFrame) lastKeyTime = mediaTime;
    encoder.encode(frame, { keyFrame });
    frame.close();
    lastTs = mediaTime;
    keyframes++;
  };
  let lastKeyTime = -Infinity;

  const wasPlaying = () => !video.paused && !video.ended;

  try {
    await new Promise((resolve, reject) => {
      let rafId = 0;
      let done = false;

      const stop = () => {
        done = true;
        signal?.removeEventListener('abort', onAbort);
        video.removeEventListener('ended', onEnded);
        if (rafId) cancelAnimationFrame(rafId);
        video.pause();
      };
      const onEnded = () => { stop(); resolve(); };
      const onAbort = () => { stop(); reject(new DOMException('Aborted', 'AbortError')); };

      const tick = () => {
        if (done) return;
        if (wasPlaying()) {
          present();
          encodeIfDue(video.currentTime);
          onProgress?.({ phase: 'encoding', value: video.currentTime / (video.duration || 1) });
        }
        if (!ctx.repaintBusy()) repaint();
        rafId = requestAnimationFrame(tick);
      };

      video.addEventListener('ended', onEnded, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });

      video.play().then(() => {
        present();
        encodeIfDue(video.currentTime);
        rafId = requestAnimationFrame(tick);
      }).catch(reject);
    });
  } finally {
    try { if (encoder.state !== 'closed') { await encoder.flush(); encoder.close(); } } catch { /* noop */ }
  }

  if (encoderError) throw encoderError;

  // ---- encode audio after the video pass so it cannot steal CPU mid-capture ----
  if (audioEngine) {
    const { buffer, channels } = audioEngine;
    let audioError = null;
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { audioError = e; console.error('[video] audio encoder error:', e); },
    });
    aenc.configure(audioConfig);

    const SR = buffer.sampleRate;
    const CHUNK = 1024;
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(buffer.getChannelData(c));

    for (let i = 0; i < buffer.length; i += CHUNK) {
      const n = Math.min(CHUNK, buffer.length - i);
      const interleaved = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) {
        const src = planes[c];
        for (let k = 0; k < n; k++) interleaved[k * channels + c] = src[i + k];
      }
      const data = new AudioData({
        format: 'f32',
        sampleRate: SR,
        numberOfFrames: n,
        numberOfChannels: channels,
        timestamp: Math.round((i / SR) * 1e6),
        data: interleaved,
      });
      aenc.encode(data);
      data.close();
    }

    await aenc.flush().catch(() => {});
    aenc.close();
    if (audioError) console.warn('[video] audio track dropped:', audioError.message);
  }

  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  console.log(`[video] ${videoConfig.codec}, ${(blob.size / 1048576).toFixed(1)} MB, ${audioConfig ? 'with audio' : 'video only'}`);
  return { blob, mimeType: 'video/mp4', backend: 'webcodecs' };
}

/* ------------------------------------------------------------------ *
 * Fallback: MediaRecorder (WebM only — MP4 canvas capture is unreliable)
 * ------------------------------------------------------------------ */

async function recordWebM(ctx) {
  const { video, out, present, repaint, signal, onProgress } = ctx;

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('This browser cannot encode video (no WebCodecs, no MediaRecorder).');

  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0];

  let audioCtx = null;
  let mediaSource = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mediaSource = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    mediaSource.connect(dest);
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  } catch { /* silent export */ }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });

  const startFrame = () => {
    present();
    track.requestFrame?.();
    onProgress?.({ phase: 'recording', value: video.currentTime / (video.duration || 1) });
  };

  recorder.start(500);
  startFrame();

  try {
    await new Promise((resolve, reject) => {
      let rafId = 0;
      let done = false;
      const stop = () => {
        done = true;
        signal?.removeEventListener('abort', onAbort);
        video.removeEventListener('ended', onEnded);
        if (rafId) cancelAnimationFrame(rafId);
        video.pause();
      };
      const onEnded = () => { stop(); resolve(); };
      const onAbort = () => { stop(); reject(new DOMException('Aborted', 'AbortError')); };

      const tick = () => {
        if (done) return;
        if (!video.paused && !video.ended) startFrame();
        repaint();                 // no-ops while a repaint is already in flight
        rafId = requestAnimationFrame(tick);
      };

      video.addEventListener('ended', onEnded, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      video.play().then(() => { rafId = requestAnimationFrame(tick); }).catch(reject);
    });
  } finally {
    try { recorder.stop(); } catch { /* noop */ }
    await stopped;
    try { mediaSource?.disconnect(); } catch { /* noop */ }
    try { await audioCtx?.close(); } catch { /* noop */ }
    for (const t of stream.getTracks()) t.stop();
  }

  return {
    blob: new Blob(chunks, { type: mimeType.split(';')[0] }),
    mimeType: mimeType.split(';')[0],
    backend: 'mediarecorder',
  };
}

/** Suggested output filename. */
export function outputName(name, mimeType) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base} - clean.${/mp4|h264|avc/.test(mimeType) ? 'mp4' : 'webm'}`;
}

export { badgeRect };
