import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEDIA_LAYERS } from '@zerosignal/shared';
import { signHls } from './rooms.js';

/**
 * Pure: build the FFmpeg argument list for an adaptive HLS ladder (720p / 480p / 240p + audio-only).
 * kind: 'pattern' (generated test pattern + tone, always available), 'file' (looped), 'url' (any URL FFmpeg can read).
 */
export function ffmpegArgs({ kind, source, outDir, segmentSec = 2 }) {
  const L = [MEDIA_LAYERS['720p'], MEDIA_LAYERS['480p'], MEDIA_LAYERS['240p']];
  const input =
    kind === 'pattern'
      ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
      : kind === 'file'
        ? ['-re', '-stream_loop', '-1', '-i', source]
        : ['-re', '-i', source];
  const audio = kind === 'pattern' ? '1:a' : '0:a';
  const filter = `[0:v]split=3[a][b][c];[a]scale=-2:${L[0].height},fps=${L[0].fps}[v0];[b]scale=-2:${L[1].height},fps=${L[1].fps}[v1];[c]scale=-2:${L[2].height},fps=${L[2].fps}[v2]`;
  const maps = ['-map', '[v0]', '-map', audio, '-map', '[v1]', '-map', audio, '-map', '[v2]', '-map', audio, '-map', audio];
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-force_key_frames', `expr:gte(t,n_forced*${segmentSec})`, '-sc_threshold', '0', '-c:a', 'aac', '-ar', '48000', '-ac', '2'];
  L.forEach((l, i) => enc.push(`-b:v:${i}`, `${l.videoKbps}k`, `-maxrate:v:${i}`, `${Math.round(l.videoKbps * 1.2)}k`, `-bufsize:v:${i}`, `${l.videoKbps * 2}k`, `-b:a:${i}`, `${l.audioKbps}k`));
  enc.push('-b:a:3', `${MEDIA_LAYERS.AUDIO.audioKbps}k`);
  const hls = [
    '-f', 'hls', '-hls_time', String(segmentSec), '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments', '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,a:0,name:720p v:1,a:1,name:480p v:2,a:2,name:240p a:3,name:AUDIO',
    '-hls_segment_filename', path.join(outDir, '%v', 'seg_%05d.ts'), path.join(outDir, '%v', 'index.m3u8'),
  ];
  return ['-hide_banner', '-loglevel', 'warning', '-y', ...input, '-filter_complex', filter, ...maps, ...enc, ...hls];
}

/** Order of renditions inside master.m3u8, which is what hls.js level indexes refer to (best first). */
export const HLS_LEVEL_ORDER = Object.freeze(['720p', '480p', '240p', 'AUDIO']);

/**
 * HLS provider: server-side FFmpeg produces the ladder. Segments are served either from a CDN/object store
 * (HLS_BASE_URL) or, for local/demo use only, from this API behind a short-lived signed path prefix.
 */
export function createHlsProvider(cfg, { salt, spawn = nodeSpawn, now = () => Date.now(), log = console } = {}) {
  const outputDir = cfg.outputDir || path.join(os.tmpdir(), 'zerosignal-hls');
  const jobs = new Map(); // room → { proc, kind, startedAt, status, error }
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  const localServing = !baseUrl;

  const stop = async (room) => {
    const j = jobs.get(room);
    if (j?.proc && !j.proc.killed) j.proc.kill('SIGTERM');
    jobs.delete(room);
    await fs.promises.rm(path.join(outputDir, room), { recursive: true, force: true }).catch(() => {});
  };

  return {
    id: 'hls',
    label: 'HLS (FFmpeg ladder)',
    available: true,
    reason: null,
    layers: [...HLS_LEVEL_ORDER],
    localServing,
    outputDir,
    /** Which sources this server can run: the test pattern always; a file or URL when configured. */
    sources() {
      return { pattern: true, file: Boolean(cfg.sourceFile), url: true };
    },
    status: (room) => jobs.get(room) ?? null,
    async start(room, { kind = 'pattern', source = '' } = {}) {
      if (jobs.get(room)?.status === 'running') return jobs.get(room);
      if (kind === 'file' && !(source = cfg.sourceFile)) throw new Error('HLS_SOURCE_FILE is not set');
      if (kind !== 'pattern' && !source) throw new Error('A source is required');
      const dir = path.join(outputDir, room);
      for (const l of ['720p', '480p', '240p', 'AUDIO']) fs.mkdirSync(path.join(dir, l), { recursive: true });
      const proc = spawn(cfg.ffmpegPath, ffmpegArgs({ kind, source, outDir: dir }), { stdio: ['ignore', 'ignore', 'pipe'] });
      const job = { proc, kind, startedAt: now(), status: 'running', error: null };
      jobs.set(room, job);
      let tail = '';
      proc.stderr?.on('data', (d) => { tail = (tail + d).slice(-600); });
      proc.on('error', (e) => { job.status = 'error'; job.error = e.code === 'ENOENT' ? `FFmpeg not found at "${cfg.ffmpegPath}"` : e.message; log.error?.(`[hls] ${job.error}`); });
      proc.on('exit', (code) => { if (job.status === 'running') { job.status = code === 0 || code === null ? 'stopped' : 'error'; if (job.status === 'error') job.error = `FFmpeg exited ${code}: ${tail.trim().slice(-200)}`; } });
      return job;
    },
    stop,
    async stopAll() { await Promise.all([...jobs.keys()].map(stop)); },
    async publishCredentials() {
      return { mode: 'server-side', note: 'HLS is produced by the server from a configured source (test pattern, file or URL); browsers do not publish to it.' };
    },
    async viewerCredentials({ room, ttlSec = 3600 }) {
      const exp = Math.floor(now() / 1000) + ttlSec;
      const base = localServing ? `/media/hls/${signHls(salt, room, exp)}/${room}` : `${baseUrl}/${room}`;
      return { playlistUrl: `${base}/master.m3u8`, levelOrder: HLS_LEVEL_ORDER, local: localServing, ttlSec };
    },
    health() {
      return { status: 'configured', note: localServing ? 'Segments served from this API: local/demo use only. Set HLS_BASE_URL to a CDN for real use.' : `Segments expected at ${cfg.baseUrl}` };
    },
  };
}
