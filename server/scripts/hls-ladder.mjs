#!/usr/bin/env node
/**
 * Verify the HLS ladder end to end with the real FFmpeg on this machine:
 *   npm run media:hls            (about 12 seconds)
 * Encodes a generated test pattern into 720p / 480p / 240p / audio-only, then checks the master playlist,
 * each rendition's resolution and codecs with ffprobe, and prints a table. Exit code 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createHlsProvider } from '../src/services/media/hls.js';

const cfg = loadConfig(process.env);
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-hls-'));
const ffprobe = (cfg.media.hls.ffmpegPath || 'ffmpeg').replace(/ffmpeg$/, 'ffprobe');
const room = 'zs-verify';
const hls = createHlsProvider({ ...cfg.media.hls, outputDir, baseUrl: '' }, { salt: 'verify' });
const fail = (m) => { console.error(`✖ ${m}`); process.exitCode = 1; };

try {
  execFileSync(cfg.media.hls.ffmpegPath, ['-version'], { stdio: 'ignore' });
} catch {
  console.error(`✖ FFmpeg not found at "${cfg.media.hls.ffmpegPath}". Install it or set FFMPEG_PATH.`);
  process.exit(1);
}

await hls.start(room, { kind: 'pattern' });
await new Promise((r) => setTimeout(r, 11_000));
const job = hls.status(room);
if (job?.status !== 'running') fail(`FFmpeg is ${job?.status}: ${job?.error ?? ''}`);

const dir = path.join(outputDir, room);
const master = path.join(dir, 'master.m3u8');
if (!fs.existsSync(master)) fail('master.m3u8 was not produced');
else {
  const text = fs.readFileSync(master, 'utf8');
  console.log(`master.m3u8: ${(text.match(/#EXT-X-STREAM-INF/g) ?? []).length} renditions`);
}

const want = { '720p': 720, '480p': 480, '240p': 240, AUDIO: 0 };
console.log('\nrendition  height  video   audio   segments');
for (const [name, height] of Object.entries(want)) {
  const segs = fs.existsSync(path.join(dir, name)) ? fs.readdirSync(path.join(dir, name)).filter((f) => f.endsWith('.ts')) : [];
  if (!segs.length) { fail(`${name}: no segments`); continue; }
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(dir, name, segs[0])]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  console.log(`${name.padEnd(10)} ${String(v?.height ?? 0).padEnd(7)} ${(v?.codec_name ?? '-').padEnd(7)} ${(a?.codec_name ?? '-').padEnd(7)} ${segs.length}`);
  if ((v?.height ?? 0) !== height) fail(`${name}: expected height ${height}, got ${v?.height ?? 0}`);
  if (!a) fail(`${name}: no audio stream`);
}

await hls.stopAll();
fs.rmSync(outputDir, { recursive: true, force: true });
console.log(process.exitCode ? '\nLadder check FAILED' : '\n✔ HLS ladder verified (real FFmpeg, test pattern)');
