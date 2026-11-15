# dahua-nvr-web

A small self-hosted web app for Dahua-based NVRs (developed against an Amcrest `AMDV10818-S5`; other Dahua/Amcrest
NVRs with the standard RTSP and CGI APIs should work). It covers live view, recorded playback, a motion-event timeline
with keyframe scanning, and daily sunrise→sunset timelapses, all in any modern browser. It needs no NPAPI plugin, no
IE, no cloud, and no npm dependencies.

```
Browser ──HTTP / WebSocket──▶ server.js (:8080, LAN) ──WS pipe──▶ go2rtc (127.0.0.1:1984) ──RTSP──▶ NVR :554
                                     └── HTTP digest GET (snapshots, mediaFileFind) / JSON-RPC (status) ──▶ NVR :80
```

## URLs

| URL | What |
|---|---|
| `http://<this-box>:8080/` | **Camera 1 only** (the home page; also `/front`), live main stream: one NVR session. Add `?kiosk=1` for a chrome-less wall display. |
| `http://<this-box>:8080/all` | **All cameras**, live substreams (also `/live`). Click one for its main stream. |
| `/cam/1` … `/cam/4` | One camera, main stream |
| `/playback` | Recorded playback: camera + local date/time + length. Shareable: `/playback?ch=1&utc=<ms>&min=2` |
| `/events` | Motion-event timeline for a camera/day, with keyframe thumbnails; ←/→ to step, Enter to play |
| `/timelapse` | One-click sunrise→sunset timelapse of one camera (`timelapse.channel`) |

## Setup

Requirements: Linux (any x86-64/ARM box on the same LAN as the NVR), Node.js 18+, and the
[go2rtc](https://github.com/AlexxIT/go2rtc) binary (MIT, tested with v1.9.9). Nothing else: no npm install, no
ffmpeg, no database.

```bash
git clone <this repo> nvr-viewer && cd nvr-viewer
mkdir -p bin && curl -L -o bin/go2rtc \
  https://github.com/AlexxIT/go2rtc/releases/download/v1.9.9/go2rtc_linux_amd64   # or _arm64
chmod +x bin/go2rtc
cp config.example.json config.json && chmod 600 config.json
$EDITOR config.json       # NVR host, user/password, utcOffsetMinutes, cameras, location
./nvrctl.sh start         # or: stop | restart | status | log
```

Then open `http://<this-box>:8080/`. To run it at boot, adapt `nvr-viewer.service.example` (paths, user, node
location), copy it to `/etc/systemd/system/nvr-viewer.service`, and `systemctl enable --now nvr-viewer`. Use one or
the other: `./nvrctl.sh stop` before enabling the service.

`config.json`, `data/` (camera frames, timelapses, logs) and `bin/` are git-ignored.

## Files

- `server.js`: HTTP/WS server, session budget, playback, events, keyframes, timelapse. It spawns and supervises go2rtc.
- `lib/nvr.js`: read-only NVR client (digest auth, RTSP DESCRIBE probe, the quirky RPC login, auth circuit breaker).
- `lib/mp4.js`: pulls keyframes out of go2rtc's `frame.mp4` and writes progressive MP4s. This is why no ffmpeg is needed.
- `lib/sun.js`: sunrise/sunset.
- `public/`: the UI (vanilla JS). `public/time.js` holds the time conversions, shared by browser and server.
- `config.json` (mode 0600, git-ignored): credentials and settings. `config.example.json` is a template.
- `bin/go2rtc`: go2rtc static binary (download it; see Setup).
- `data/`: generated go2rtc config, cached keyframes, event lists, rendered timelapses, `server.log`.

## How the NVR's constraints are handled

**Session cap (≈4 RTSP sessions on this model).** Every RTSP session is counted against `nvr.maxSessions` (4). The count combines
the server's own bookkeeping with go2rtc's live producer list as ground truth. Streams are shared: ten browsers on
the grid still use 4 NVR sessions. If the budget is full, a new stream gets a clear "busy" message and the NVR is
never contacted. Grid tiles then fall back to snapshots (HTTP CGI, no RTSP) and retry every 10 s. Viewers always beat
background work (keyframes/timelapse), which waits for a free slot. If you also use the Amcrest phone app or another
client, set `maxSessions` to 3.

**Tab reloads and kills.** Each browser WebSocket is piped to go2rtc. When the socket closes, the viewer is dropped,
and go2rtc closes the NVR session when the last viewer leaves. A reload re-attaches to the still-warm stream. Live
views in a background tab disconnect after 20 s.

**No traffic without a browser.** Nothing polls the NVR on its own. go2rtc only connects while a viewer is attached.
Snapshots, event searches, keyframes and the status/clock check (≤ once per 10 min) only run when an open page asks
for them. Queued keyframe requests are dropped if the browser leaves first. The one exception is a timelapse you
started: it runs to completion (or until you press Cancel), then stops.

**Playback is 1× realtime.** The UI streams the chosen window live and steps with Previous/Next; it never pretends to
scrub. A finished window makes the NVR stall the stream, and go2rtc would then reconnect and restart the clip, so
the server ends each playback stream itself after its duration. Before streaming, an RTSP DESCRIBE (no PLAY)
confirms a recording exists, so you get "No recording found" instead of a black box.

**Clock quirk.** These NVRs often run a fixed UTC offset with no DST (`nvr.utcOffsetMinutes`, e.g. −360 for UTC−6).
Everything converts *local wall time → UTC (via the IANA zone in `displayTimeZone`) → NVR clock*, so DST is handled by the zone database
and nothing is hardcoded between local and NVR time. The UI shows both NVR and local times. The DST fall-back hour
is flagged as ambiguous, and the spring-forward gap is rejected. The status check reads the NVR's actual clock over
RPC and warns if it drifts more than 2 min (it read 0 s drift on 2026-11-06).

**Read-only.** The app only sends RTSP OPTIONS/DESCRIBE/SETUP/PLAY/TEARDOWN, HTTP GETs (`snapshot.cgi`,
`mediaFileFind.cgi` search objects that are always closed and destroyed), and RPC login, getters and logout. go2rtc
streams use `#backchannel=0`, so no two-way-audio channel is requested.

**Lockout protection.** Before the first NVR contact, one RPC login verifies the credentials. A rejected password (or
two rejected digest auths) trips a breaker that stops all NVR auth until restart, so the app never walks into the
10-tries-then-20-minute lockout. The UI shows a red banner if that happens.

**Security.** go2rtc's API (which can add arbitrary sources) listens on 127.0.0.1 only. Its own RTSP, WebRTC, SRTP
and RTMP servers are disabled. Browsers can only attach to stream names the server created. Credentials never reach
the browser and are redacted from logs. Requests from outside `allowedNetworks` (RFC1918 + loopback by default) are
refused. There is no login on the web app itself: anyone on the LAN can view.

## Motion events

The RPC event log (`log.startFind`) doesn't work on this firmware, but the standard Dahua file search does:
`/cgi-bin/mediaFileFind.cgi`. With 24/7 recording, the NVR splits files at every motion trigger and flags those with
`Events[0]=VideoMotion` (file names `[M]` vs `[R]`). That list is the event timeline, and it reaches back over the
whole retention period. Finished days are cached in `data/events/`. The server ignores the `Flags` filter, so
filtering happens in code.

Keyframes come from one short playback session per event (≈0.6 s), at most `frames.workers` (2) at a time, backing
off on errors. They are cached on disk (`data/frames/`, pruned after 21 days), so every frame is fetched from the
NVR once. The browser turns them into JPEG thumbnails.

## Timelapse

Pick a day and press Render. Frames run from sunrise − 30 min to sunset + 30 min. At one frame every 2 min that's
≈345 frames, ≈3–4 min to fetch, and a ≈30 s video at 12 fps. Each frame is an H.264 keyframe from the 1080p main
stream; they are concatenated into an all-intra MP4 with no re-encoding, so CPU use is near zero. Files land in
`data/timelapse/`.

**Location:** set `config.json` → `"location": {"lat": …, "lon": …}` (west longitudes are negative). Without it
the timelapse page asks you to set it.

## Config reference (`config.json`)

| Key | Meaning |
|---|---|
| `listen.host/port` | Where the web app listens (default `0.0.0.0:8080`) |
| `allowedNetworks` | Client CIDRs allowed to connect |
| `nvr.*` | Host, ports, user/password, `utcOffsetMinutes` (required), `maxSessions` (4) |
| `displayTimeZone` | IANA zone for the UI (defaults to the server's zone) |
| `cameras` | `ch`, `name`, `desc`, main/sub resolutions per channel |
| `playback.maxMinutes` | Longest playback window (30) |
| `frames.workers` | Parallel keyframe fetches (default 2, capped at min(4, maxSessions−1)) |
| `frames.retentionDays` | Keyframe cache retention |
| `timelapse.*` | `channel` (1), `marginMinutes` (30), default `intervalSeconds` (120), `fps` (12) |
| `location` | `{lat, lon}` for sunrise/sunset |

## Browser support

The app uses MSE (Media Source Extensions): Chrome, Edge, Firefox and desktop Safari. iPhone Safari works via
ManagedMediaSource (iOS 17.1+). The cameras send H.264, so nothing is transcoded.

## License

MIT; see `LICENSE`. go2rtc (downloaded separately) is MIT-licensed by its authors.
