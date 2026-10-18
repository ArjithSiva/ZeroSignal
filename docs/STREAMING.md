# Streaming: providers, setup, limits and test plan

ZeroSignal can move **real** media, but it never depends on it. Alerts travel over Socket.IO as compact signed text whatever the video is doing.

## How it fits together

```
Broadcaster ──publish (one simulcast stream)──► LiveKit SFU ──┐
FFmpeg (server) ──720/480/240/audio ladder──► HLS segments ───┤──► Receiver
                                                               │
Adaptive engine (server) ── "layer" for this receiver ────────►┘  (player follows, never chooses)
```

- The **server-side adaptive engine** decides each receiver's tier. `shared/src/media.js` maps tier to layer: `720p`, `480p`, `240p`, `AUDIO` (audio only), or `null` for `TEXT`/`CACHED` (no media at all, the signed text alert is the experience).
- The receiver gets the layer in its `receiver:state` event and the player applies it: LiveKit simulcast quality (HIGH/MEDIUM/LOW, video unsubscribed for audio-only), or a pinned hls.js level. Player ABR is switched off.
- **Fallback chain** (client): `livekit → hls → simulated`. A provider that fails to connect (8 s), drops, or sits in "waiting"/"buffering" for 12 s is replaced by the next. `simulated` cannot fail and is always labelled "Simulated".
- **Measured vs simulated.** While a real WebRTC stream is active, its receive stats (bitrate, loss, jitter, RTT) feed the engine, and the receiver shows "Measured (real WebRTC stats)". Otherwise the engine runs on the simulator ("Simulated") or the HTTP probe of Live Mode ("Probe-estimated").

## Security model

| What | How |
|---|---|
| Publish vs subscribe | Separate tokens. Publisher: `canPublish`, no subscribe. Viewer: `canSubscribe`, no publish, no data channel. |
| Who can publish | Only the broadcast's owner or an admin (`POST /api/media/:id/publish-token`). |
| Rooms | Named `zs-` + HMAC of the broadcast id (`MEDIA_ROOM_SALT`), so they cannot be guessed from an id. |
| Secrets | `LIVEKIT_API_SECRET` never leaves the server. The browser only ever gets a short-lived signed JWT (`LIVEKIT_TOKEN_TTL_SEC`, default 1 h). |
| Local HLS | Links carry a signed, expiring prefix (`/media/hls/<exp>.<sig>/<room>/...`) checked on every request. |
| Server-side sources | Clients cannot choose a file; URL sources are limited to `http(s)`, `rtmp(s)`, `rtsp`, `srt`. |

## Provider 1: LiveKit (WebRTC, real-time)

1. Create a free project at <https://cloud.livekit.io> (or self-host LiveKit).
2. Settings → Keys → create a key. Set on the server: `LIVEKIT_URL` (`wss://<project>.livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
3. Restart. Admin → System health → **Streaming** shows "up" only after a real reachability probe succeeds.
4. As broadcaster: Broadcast control → select a broadcast → Go live → **Media ingest** → camera / microphone / screen / looping video file → Start publishing. The panel shows per-layer sender health.

**Free-tier limits** (LiveKit Cloud Build plan, from the [quotas page](https://docs.livekit.io/deploy/admin/quotas-and-limits/), check it for changes): 100 concurrent participants, 5,000 WebRTC participant-minutes per month (hard cap), 50 GB downstream per month. That is roughly 83 viewer-hours a month: fine for a demo, not for a real incident. Past the cap, connections fail and viewers fall back to HLS or the simulated feed.

## Provider 2: HLS (FFmpeg ladder)

Needs `ffmpeg` on the API host (`FFMPEG_PATH`). Render's free Node runtime does not guarantee FFmpeg; use a Docker deploy or a host that has it.

- Broadcaster → Media ingest → **Start test-pattern ladder** encodes a generated test pattern (labelled "Test pattern": it is not a camera).
- `HLS_SOURCE_FILE` lets the operator loop a real video; a URL source (for example an RTMP stream you push from OBS to a media server) is read by FFmpeg.
- **Local serving is for development/demo only.** In production set `HLS_BASE_URL` to a CDN / object-storage URL that serves `HLS_OUTPUT_DIR`. On Vercel, `/media/*` is not proxied to the API, so local serving only works when the browser can reach the API origin directly (the client builds `VITE_API_URL + /media/...`; set it if you rely on this).
- Verify the ladder on any machine: `npm run media:hls` (about 12 s). It runs the real FFmpeg and checks heights and codecs with ffprobe.

HLS latency is typically 6-12 s; the player shows "N s behind live" when it is more than 4 s behind. Only WebRTC stats feed the engine (segment timings are not link statistics).

## Provider 3: Simulated

The labelled canvas feed (`QualityPlayer`). Always available. Nothing real is streamed; the badge says so.

## Honest limits

- The receive bitrate is capped by the layer being received. Browsers that report `availableIncomingBitrate` give the engine real headroom; others only let it **demote**, not promote, from measured stats. Live Mode's probe can still promote.
- Recording / replay of the video is **not implemented** (LiveKit egress needs a paid or self-hosted service). Incident replay of tiers, metrics and alerts is.
- Real-media paths are verified here with mocked LiveKit/hls.js (grants, layers, fallback) and a real FFmpeg ladder. A live LiveKit server and real browsers over a throttled network were **not** available in the build sandbox: use the manual plan below.

## Manual test plan (do this once with real credentials)

1. **Baseline.** No LiveKit vars: receiver shows "Simulated" pill; Admin → Streaming "Degraded: no real provider". Alerts still arrive.
2. **LiveKit publish.** Set the three vars, go live, publish camera. Open `/receiver/<id>` in another browser/profile: pill reads "Live (WebRTC)", a real video plays, the "Real stream" badge shows.
3. **Layers follow the engine.** On the receiver, Network tab → pick a preset (GOOD → POOR → CRITICAL). Note: presets are simulation controls and switch the engine back to simulated input; to test real stats instead leave the controls alone and throttle the receiver tab in Chrome DevTools → Network: *Fast 3G*, then a custom ~150 kbit/s profile. Expect 720p → 480p → 240p → audio-only (video disappears, "Audio only") → no media ("No media: text alert only") as the measured bandwidth drops, with the "Why" panel citing measured numbers and the "Measured (real WebRTC stats)" pill.
4. **Recovery.** Remove the throttle: on browsers that report incoming bandwidth the tier climbs back (hysteresis: four good readings).
5. **Alert independence.** While at "No media", send a CRITICAL alert: the takeover appears with signed text.
6. **Fallback.** Wrong `LIVEKIT_URL` or stop publishing for 12 s: the receiver says "Fell back from livekit"; with an HLS ladder running it continues on HLS, otherwise on "Simulated".
7. **HLS.** Start the test-pattern ladder, receiver on HLS: levels switch as the engine changes tier; `npm run media:hls` passes.
8. **Permissions.** A receiver account calling `POST /api/media/<id>/publish-token` gets 403; another broadcaster gets 403; an expired HLS link gets 403.
