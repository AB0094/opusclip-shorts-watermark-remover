/**
 * MP4 demuxing with mp4box.js, so frames can be decoded with WebCodecs.
 *
 * Why not just play the <video> and capture it? Playback is wall-clock: frames
 * get dropped when the tab is busy or backgrounded, audio plays out loud, and
 * any inference that takes longer than a frame is pasted onto a later, different
 * frame. Demuxing gives every frame, in order, with its exact timestamp, and lets
 * the pipeline take as long as it needs per frame.
 */

const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';

let mp4boxPromise = null;
function loadMP4Box() {
  if (globalThis.MP4Box) return Promise.resolve(globalThis.MP4Box);
  if (!mp4boxPromise) {
    mp4boxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MP4BOX_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => (globalThis.MP4Box ? resolve(globalThis.MP4Box) : reject(new Error('mp4box did not initialise')));
      s.onerror = () => reject(new Error('Could not load mp4box.js'));
      document.head.appendChild(s);
    });
  }
  return mp4boxPromise;
}

function codecDescription(trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);   // skip the 8-byte box header
    }
  }
  return undefined;
}

function aacConfig(trak) {
  try {
    const esds = trak.mdia.minf.stbl.stsd.entries[0].esds;
    const data = esds.esd.descs[0].descs[0].data;
    return data && data.length ? new Uint8Array(data) : undefined;
  } catch { return undefined; }
}

const toUs = (t, scale) => Math.round((t * 1e6) / scale);

/**
 * @param {File} file
 * @returns {Promise<{
 *   width:number, height:number, fps:number, duration:number,
 *   video:{codec:string, description:Uint8Array|undefined, samples:{key:boolean, ts:number, dur:number, data:Uint8Array}[]},
 *   audio:null|{codec:string, sampleRate:number, channels:number, description:Uint8Array|undefined, samples:{ts:number, dur:number, data:Uint8Array}[]}
 * }>}
 * Rejects when the file is not a demuxable MP4/MOV, or is rotated by metadata
 * (a <video> element applies rotation, raw decoded frames do not).
 */
export async function demux(file) {
  const MP4Box = await loadMP4Box();
  const buffer = await file.arrayBuffer();

  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    const videoSamples = [];
    const audioSamples = [];
    let info = null;
    let vTrack = null;
    let aTrack = null;
    let failed = false;

    const fail = (e) => { if (!failed) { failed = true; reject(e instanceof Error ? e : new Error(String(e))); } };

    mp4.onError = fail;
    mp4.onReady = (i) => {
      info = i;
      vTrack = i.videoTracks[0];
      aTrack = i.audioTracks[0] || null;
      if (!vTrack) return fail(new Error('No video track in this file.'));
      const m = vTrack.matrix;
      if (m && (m[1] !== 0 || m[3] !== 0)) return fail(new Error('Rotated video: handled by the fallback path.'));

      mp4.setExtractionOptions(vTrack.id, 'v', { nbSamples: 500 });
      if (aTrack) mp4.setExtractionOptions(aTrack.id, 'a', { nbSamples: 500 });
      mp4.start();
    };
    mp4.onSamples = (id, user, samples) => {
      for (const s of samples) {
        if (user === 'v') {
          videoSamples.push({ key: !!s.is_sync, ts: toUs(s.cts, s.timescale), dur: toUs(s.duration, s.timescale), data: s.data });
        } else {
          audioSamples.push({ ts: toUs(s.cts, s.timescale), dur: toUs(s.duration, s.timescale), data: s.data });
        }
      }
    };

    buffer.fileStart = 0;
    try {
      mp4.appendBuffer(buffer);
      mp4.flush();
    } catch (e) { return fail(e); }
    if (failed) return;
    if (!info || !videoSamples.length) return fail(new Error('Could not read any video frames from this file.'));

    const vtrak = mp4.getTrackById(vTrack.id);
    const seconds = vTrack.duration / vTrack.timescale;
    const fps = Math.min(120, Math.max(1, videoSamples.length / (seconds || 1)));

    let audio = null;
    if (aTrack && audioSamples.length) {
      audio = {
        codec: aTrack.codec,
        sampleRate: aTrack.audio.sample_rate,
        channels: aTrack.audio.channel_count,
        description: aTrack.codec.startsWith('mp4a.40') ? aacConfig(mp4.getTrackById(aTrack.id)) : undefined,
        samples: audioSamples,
      };
    }

    resolve({
      width: vTrack.video.width,
      height: vTrack.video.height,
      fps,
      duration: seconds,
      video: { codec: vTrack.codec, description: codecDescription(vtrak), samples: videoSamples },
      audio,
    });
  });
}
