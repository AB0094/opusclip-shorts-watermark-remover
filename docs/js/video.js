/**
 * Video pipeline: decode every frame -> remove the badge -> encode.
 *
 *   MP4 --mp4box--> samples --VideoDecoder--> frame ──┐
 *                                                      ├─ detect badge pixels
 *                                   512x512 window ◄───┘   inpaint (MI-GAN / LaMa)
 *                                         │
 *                    output canvas  ◄─────┘ (fill composited over the frame)
 *                         │
 *                  VideoEncoder (H.264) --> mp4-muxer --> .mp4
 *   AAC audio samples are copied through untouched.
 *
 * Nothing is real-time. Each frame is fully processed before the next one is
 * decoded, so the fill always belongs to the frame it is painted on, no frames
 * are dropped, and timestamps are the source's own. That is the difference from
 * playing the clip and capturing it, which pastes late fills onto moving faces.
 *
 * Inputs that cannot be demuxed (WebM, rotated phone video, ...) fall back to
 * stepping a <video> element frame by frame at an assumed 30 fps.
 */

import { createDetector, dilate } from './watermark.js';
import * as inpainter from './inpainter.js';
import { demux } from './demux.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* ------------------------------------------------------------------ *
 * Frame sources
 * ------------------------------------------------------------------ */

/** Frame-exact source: mp4box + WebCodecs. */
function webcodecsFrames(src, cfg, signal) {
  const fallbackDur = Math.round(1e6 / src.fps);
  return (async function* () {
    const queue = [];
    let error = null;
    let fedAll = false;
    let stopped = false;

    const decoder = new VideoDecoder({
      output: (f) => queue.push(f),
      error: (e) => { error = e; },
    });
    decoder.configure(cfg);

    const feeder = (async () => {
      for (const s of src.video.samples) {
        while (!stopped && !error && (decoder.decodeQueueSize > 12 || queue.length > 6)) await sleep(2);
        if (stopped || error) return;
        decoder.decode(new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data: s.data,
        }));
      }
      try { await decoder.flush(); } catch (e) { error = error || e; }
      fedAll = true;
    })();

    try {
      for (;;) {
        if (error) throw error;
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (queue.length) {
          const f = queue.shift();
          yield { draw: f, ts: f.timestamp, dur: f.duration || fallbackDur, close: () => f.close() };
          continue;
        }
        if (fedAll) break;
        await sleep(1);
      }
    } finally {
      stopped = true;
      for (const f of queue) f.close();
      queue.length = 0;
      await feeder.catch(() => {});
      try { decoder.close(); } catch { /* already closed */ }
    }
  })();
}

/** Fallback source: step a <video> element. Slower and only frame-accurate to ~1/30 s. */
async function seekFrames(file, signal) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('Could not decode this video. Try MP4/H.264.'));
  });

  const fps = 30;
  const total = Math.max(1, Math.floor(video.duration * fps));
  const dur = Math.round(1e6 / fps);
  const seekTo = (t) => new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });

  return {
    width: video.videoWidth,
    height: video.videoHeight,
    fps,
    total,
    frames: (async function* () {
      try {
        for (let i = 0; i < total; i++) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          await seekTo((i + 0.5) / fps);
          yield { draw: video, ts: Math.round((i * 1e6) / fps), dur, close() {} };
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    })(),
    audio: null,
  };
}

async function openSource(file, signal) {
  try {
    const src = await demux(file);
    if (typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined') {
      const cfg = {
        codec: src.video.codec,
        codedWidth: src.width,
        codedHeight: src.height,
        description: src.video.description,
      };
      const support = await VideoDecoder.isConfigSupported(cfg).catch(() => null);
      if (support?.supported) {
        return {
          width: src.width,
          height: src.height,
          fps: src.fps,
          total: src.video.samples.length,
          frames: webcodecsFrames(src, cfg, signal),
          pipelined: true,
          audio: src.audio,
        };
      }
      console.info('[video] decoder does not support', src.video.codec, '- falling back');
    }
  } catch (e) {
    console.info('[video] demux path unavailable, falling back to <video> stepping:', e?.message || e);
  }
  return seekFrames(file, signal);
}

/* ------------------------------------------------------------------ *
 * Main entry
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {File} o.file
 * @param {string} [o.modelId]                model id the caller already init()ed
 * @param {HTMLCanvasElement} [o.canvas]      reuse the preview canvas as the output surface
 * @param {boolean} [o.temporal]              median-smooth the fill while the badge is static
 * @param {'quality'|'balanced'|'turbo'} [o.speed]  reuse the last fill while the picture around the badge is still
 * @param {(p:{phase:string, value:number, fps:number}) => void} [o.onProgress]
 * @param {(i:{backend:string}) => void} [o.onInfo]
 * @param {AbortSignal} [o.signal]
 */
export async function processVideo(o) {
  const { file, onProgress, onInfo, signal } = o;
  const temporal = o.temporal !== false;
  const preset = inpainter.SPEED_PRESETS[o.speed] || inpainter.SPEED_PRESETS.balanced;

  const muxerMod = await import(MUXER_URL).catch((e) => { throw new Error(`Could not load the MP4 muxer: ${e?.message || e}`); });
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs video encoder. Use a recent Chrome, Edge or Safari.');
  }

  const source = await openSource(file, signal);
  const width = source.width & ~1;
  const height = source.height & ~1;
  if (!width || !height) throw new Error('Video has no usable dimensions.');

  const out = o.canvas || makeCanvas(width, height);
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d', { alpha: false });
  outCtx.fillStyle = '#000';
  outCtx.fillRect(0, 0, width, height);

  const detector = await createDetector(width, height);
  const { plan } = detector;
  outCtx.imageSmoothingEnabled = plan.win !== inpainter.SIZE;

  const winCanvas = new OffscreenCanvas(inpainter.SIZE, inpainter.SIZE);
  const winCtx = winCanvas.getContext('2d', { willReadFrequently: true });
  const overlay = new OffscreenCanvas(inpainter.SIZE, inpainter.SIZE);
  const overlayCtx = overlay.getContext('2d');

  // Band of pixels just outside the settled mask: if it has not changed since
  // the last model run, the last fill is still valid and the model is skipped.
  const band = inpainter.bandIndices(detector.maskSettled, dilate(detector.maskSettled, Math.max(6, Math.round(8 * plan.m))));

  /* ---- encoder + muxer ---- */
  const fps = Math.max(1, Math.round(source.fps));
  const bitrate = Math.round(Math.min(18_000_000, Math.max(6_000_000, width * height * fps * 0.09)));
  const candidates = ['avc1.640033', 'avc1.64002a', 'avc1.4d002a', 'avc1.4d0033', 'avc1.42002a'];
  let videoConfig = null;
  // Hardware encoders are several times faster than the software fallback at 1080x1920.
  search: for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    for (const codec of candidates) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration };
      try {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (support.supported) { videoConfig = support.config || cfg; break search; }
      } catch { /* try the next profile */ }
    }
  }
  if (!videoConfig) throw new Error('This browser has no H.264 encoder available (WebCodecs).');

  // Audio: copy AAC samples through untouched when we can; otherwise decode to
  // PCM and re-encode AAC; otherwise ship video only.
  const audioPlan = await planAudio(file, source.audio);
  const { Muxer, ArrayBufferTarget } = muxerMod;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(audioPlan ? { audio: { codec: 'aac', sampleRate: audioPlan.sampleRate, numberOfChannels: audioPlan.channels } } : {}),
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory',
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; console.error('[video] encoder error:', e); },
  });
  encoder.configure(videoConfig);
  onInfo?.({ backend: `${inpainter.getModelId()} · ${inpainter.getBackend()} · ${videoConfig.codec}` });

  /* ---- per-frame work ---- */
  const stats = { frames: 0, settled: 0, anim: 0, none: 0, inferred: 0, reused: 0 };
  let ref = null;        // window pixels at the last settled model run
  let reuseAge = 0;      // frames since that run
  const ring = [];
  let lastKey = -Infinity;
  const t0 = performance.now();

  // The model runs one job at a time, but the CPU work around it (decode, read
  // the window, detect, composite, encode) overlaps with it: while the GPU fills
  // frame N, frame N+1 is already read and detected and its job is queued, so
  // the GPU goes straight on to it. Frames are still composited and encoded
  // strictly in order, and every fill belongs to its own frame.
  let gpuChain = Promise.resolve();
  const runModel = (rgba, mask) => {
    const job = gpuChain.then(() => inpainter.fill(rgba, mask));
    gpuChain = job.catch(() => {});
    return job;
  };

  /** Stage 1 (in order): read the badge window, detect, decide infer / reuse / skip. */
  function prepare(item) {
    winCtx.drawImage(item.draw, plan.x, plan.y, plan.win, plan.win, 0, 0, inpainter.SIZE, inpainter.SIZE);
    const win = winCtx.getImageData(0, 0, inpainter.SIZE, inpainter.SIZE);
    const verdict = detector.analyze(win.data);
    stats[verdict.state]++;

    let job = null;               // 'reuse' | Promise<filled> | null
    if (verdict.mask) {
      const settled = verdict.state === 'settled';
      if (settled && ref && inpainter.canReuse(inpainter.bandChange(win.data, ref, band), reuseAge, preset)) {
        reuseAge++;
        stats.reused++;
        job = 'reuse';
      } else {
        job = runModel(win.data, verdict.mask);
        job.catch(() => {});      // surfaced in finish(); avoid an unhandled-rejection warning meanwhile
        stats.inferred++;
        ref = settled ? win.data : null;
        reuseAge = 0;
      }
    } else {
      ref = null;
    }
    return { item, verdict, job };
  }

  /** Stage 2 (in order): composite the fill over the frame and encode it. */
  async function finish({ item, verdict, job }) {
    let filled = null;
    if (job && job !== 'reuse') filled = await job;

    outCtx.drawImage(item.draw, 0, 0, width, height);
    if (verdict.mask) {
      if (filled) {
        if (verdict.state === 'settled' && temporal) {
          ring.push(filled);
          if (ring.length > 3) ring.shift();
          if (ring.length === 3 && inpainter.patchMotion(ring[1], ring[2], verdict.mask) < 4) {
            filled = inpainter.temporalMedian(ring, verdict.mask);
          }
        } else if (verdict.state !== 'settled') {
          ring.length = 0;
        }
        const box = inpainter.maskBox(verdict.mask);
        overlayCtx.clearRect(0, 0, inpainter.SIZE, inpainter.SIZE);
        overlayCtx.putImageData(new ImageData(inpainter.buildOverlay(filled, verdict.mask, box), inpainter.SIZE, inpainter.SIZE),
          0, 0, box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1);
      }
      // 'reuse': the overlay canvas still holds the last fill, which is still right.
      outCtx.drawImage(overlay, 0, 0, inpainter.SIZE, inpainter.SIZE, plan.x, plan.y, plan.win, plan.win);
    } else {
      ring.length = 0;
    }

    while (encoder.encodeQueueSize > 8 && !encoderError) await sleep(2);
    if (encoderError) throw encoderError;

    const frame = new VideoFrame(out, { timestamp: item.ts, duration: item.dur });
    const keyFrame = item.ts - lastKey >= 2e6;
    if (keyFrame) lastKey = item.ts;
    encoder.encode(frame, { keyFrame });
    frame.close();
    stats.frames++;
    if (stats.frames % 4 === 0 || stats.frames === source.total) {
      const secs = (performance.now() - t0) / 1000;
      onProgress?.({ phase: 'encoding', value: stats.frames / (source.total || 1), fps: stats.frames / Math.max(secs, 0.001) });
    }
  }

  // Frames from the <video> fallback share one element, so they cannot be held
  // while the next one is read: that path stays one frame at a time.
  const depth = source.pipelined ? 2 : 0;
  const pending = [];
  try {
    for await (const item of source.frames) {
      try {
        pending.push(prepare(item));
      } catch (e) {
        item.close();
        throw e;
      }
      while (pending.length > depth) {
        const p = pending.shift();
        try { await finish(p); } finally { p.item.close(); }
      }
    }
    while (pending.length) {
      const p = pending.shift();
      try { await finish(p); } finally { p.item.close(); }
    }
    if (encoderError) throw encoderError;
    await encoder.flush();
  } finally {
    for (const p of pending) p.item.close();
    pending.length = 0;
    try { if (encoder.state !== 'closed') encoder.close(); } catch { /* noop */ }
  }

  /* ---- audio ---- */
  let audioNote = 'video only';
  if (audioPlan?.mode === 'copy') {
    const a = source.audio;
    a.samples.forEach((s, i) => {
      muxer.addAudioChunkRaw(s.data, 'key', s.ts, s.dur, i === 0
        ? { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: a.channels, sampleRate: a.sampleRate, description: a.description } }
        : undefined);
    });
    audioNote = 'audio copied untouched';
  } else if (audioPlan?.mode === 'encode') {
    await encodeAudio(audioPlan, muxer);
    audioNote = 'audio re-encoded';
  }

  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  console.log(`[video] ${videoConfig.codec}, ${(blob.size / 1048576).toFixed(1)} MB, ${audioNote}`, stats);
  return { blob, mimeType: 'video/mp4', width, height, fps, stats, audioNote };
}

/** Decide how audio gets into the output. Returns null for "no audio". */
async function planAudio(file, audio) {
  if (audio && audio.codec.startsWith('mp4a.40.2') && audio.description) {
    return { mode: 'copy', sampleRate: audio.sampleRate, channels: audio.channels };
  }
  if (typeof AudioEncoder === 'undefined') return null;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await ac.decodeAudioData(await file.arrayBuffer());
    ac.close().catch(() => {});
    const channels = Math.min(2, buffer.numberOfChannels);
    const cfg = { codec: 'mp4a.40.2', sampleRate: buffer.sampleRate, numberOfChannels: channels, bitrate: 160_000 };
    const support = await AudioEncoder.isConfigSupported(cfg);
    if (!support.supported) return null;
    return { mode: 'encode', sampleRate: buffer.sampleRate, channels, buffer, cfg };
  } catch (e) {
    console.warn('[video] no usable audio track, exporting video only:', e?.message);
    return null;
  }
}

async function encodeAudio({ buffer, channels, cfg }, muxer) {
  let audioError = null;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { audioError = e; },
  });
  aenc.configure(cfg);

  const SR = buffer.sampleRate;
  const CHUNK = 1024;
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(buffer.getChannelData(c));

  for (let i = 0; i < buffer.length; i += CHUNK) {
    const n = Math.min(CHUNK, buffer.length - i);
    const interleaved = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) {
      for (let k = 0; k < n; k++) interleaved[k * channels + c] = planes[c][i + k];
    }
    const data = new AudioData({
      format: 'f32', sampleRate: SR, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((i / SR) * 1e6), data: interleaved,
    });
    aenc.encode(data);
    data.close();
  }
  await aenc.flush().catch(() => {});
  aenc.close();
  if (audioError) throw audioError;
}

/** Suggested output filename. */
export function outputName(name) {
  return `${name.replace(/\.[^.]+$/, '')} - clean.mp4`;
}
