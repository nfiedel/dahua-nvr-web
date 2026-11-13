#!/usr/bin/env node
'use strict';
// NVR Viewer — LAN web app for a Dahua-based NVR (live + recorded playback), no browser plugins.
//
//  Browser ──HTTP/WS──> this server (:8080) ──WS pipe──> go2rtc (127.0.0.1 only) ──RTSP──> NVR
//
// Design rules (see README):
//  * Every NVR RTSP session is counted against a hard budget (nvr.maxSessions, default 4).
//    Streams are shared: N viewers of the same stream = 1 NVR session (go2rtc fan-out).
//  * Nothing touches the NVR unless a browser asked for it (no background polling / prefetch).
//  * Read-only: RTSP DESCRIBE/PLAY, HTTP GET (snapshot, mediaFileFind), RPC login + getters.
//  * Credentials live only in config.json and go2rtc's generated config (mode 0600); never sent to clients.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const T = require('./public/time.js');
const { NvrClient } = require('./lib/nvr');
const mp4 = require('./lib/mp4');
const { sunTimes } = require('./lib/sun');

// ---------------------------------------------------------------- config
const ROOT = __dirname;
const CFG_PATH = process.env.NVR_VIEWER_CONFIG || path.join(ROOT, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const NVRC = CFG.nvr;
const MAX = Math.max(1, NVRC.maxSessions || 4);
if (!Number.isFinite(NVRC.utcOffsetMinutes)) {
  console.error('config: set nvr.utcOffsetMinutes to the NVR clock\'s fixed UTC offset in minutes (e.g. -360 for UTC-6)');
  process.exit(1);
}
const OFF = NVRC.utcOffsetMinutes;
const TZ = CFG.displayTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const G2_PORT = (CFG.go2rtc && CFG.go2rtc.apiPort) || 1984;
const G2_BIN = path.resolve(ROOT, (CFG.go2rtc && CFG.go2rtc.bin) || './bin/go2rtc');
const DATA = path.resolve(ROOT, CFG.dataDir || './data');
const DIRS = { run: path.join(DATA, 'run'), frames: path.join(DATA, 'frames'), events: path.join(DATA, 'events'), tl: path.join(DATA, 'timelapse') };
for (const d of [DATA, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });
const CAMS = CFG.cameras;
const camBy = (ch) => CAMS.find((c) => c.ch === Number(ch));
const PB_MAX_MIN = (CFG.playback && CFG.playback.maxMinutes) || 30;
const FRAME_WORKERS = Math.min(Math.max(1, (CFG.frames && CFG.frames.workers) || 2), 4, Math.max(1, MAX - 1));
const FRAME_RETENTION_DAYS = (CFG.frames && CFG.frames.retentionDays) || 21;
const TLC = Object.assign({ channel: 1, marginMinutes: 30, intervalSeconds: 120, fps: 12 }, CFG.timelapse || {});
const LOC = CFG.location && Number.isFinite(CFG.location.lat) && Number.isFinite(CFG.location.lon) ? CFG.location : null; // { lat, lon }
const GRACE_MS = 1500;

const nvr = new NvrClient(NVRC);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const redact = (s) => String(s).split(NVRC.password).join('***').split(enc(NVRC.password)).join('***');

// ---------------------------------------------------------------- go2rtc
const rtspBase = `rtsp://${enc(NVRC.user)}:${enc(NVRC.password)}@${NVRC.host}:${NVRC.rtspPort || 554}`;
const liveUrl = (ch, sub) => `${rtspBase}/cam/realmonitor?channel=${ch}&subtype=${sub ? 1 : 0}#backchannel=0`;
const pbPathQ = (ch, s, e) => `/cam/playback?channel=${ch}&starttime=${s}&endtime=${e}`;
const pbUrl = (ch, s, e) => `${rtspBase}${pbPathQ(ch, s, e)}#backchannel=0`;

let g2proc = null; let g2gen = 0; let stopping = false; let g2up = false;
function startGo2rtc() {
  const streams = {};
  for (const c of CAMS) { streams[`live_${c.ch}_sub`] = liveUrl(c.ch, 1); streams[`live_${c.ch}_main`] = liveUrl(c.ch, 0); }
  // Block-style YAML (go2rtc patches this file when streams are added/removed via its API, and its
  // patcher can't edit flow/JSON style). Regenerated from scratch on every start.
  const q = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars
  const yaml = [
    'api:', `  listen: ${q(`127.0.0.1:${G2_PORT}`)}`, // never exposed to the LAN (its API can add arbitrary sources)
    'rtsp:', '  listen: ""', 'webrtc:', '  listen: ""', 'srtp:', '  listen: ""', 'rtmp:', '  listen: ""',
    'log:', '  level: info', '  format: text',
    'streams:', ...Object.entries(streams).map(([k, v]) => `  ${k}: ${q(v)}`), '',
  ].join('\n');
  const file = path.join(DIRS.run, 'go2rtc.yaml');
  fs.writeFileSync(file, yaml, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  g2gen++;
  const proc = spawn(G2_BIN, ['-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  g2proc = proc;
  const out = (d) => { for (const l of redact(d.toString()).split('\n')) if (l.trim()) console.log('[go2rtc]', l); };
  proc.stdout.on('data', out); proc.stderr.on('data', out);
  proc.on('exit', (code) => {
    g2up = false; if (g2proc === proc) g2proc = null;
    log('go2rtc exited', code);
    if (!stopping) setTimeout(startGo2rtc, 2000);
  });
}

function g2req(method, p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: G2_PORT, path: p, method, timeout: timeoutMs }, (x) => {
      const ch = []; x.on('data', (c) => ch.push(c));
      x.on('end', () => resolve({ status: x.statusCode, body: Buffer.concat(ch) }));
      x.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('go2rtc timeout')));
    r.on('error', reject);
    r.end();
  });
}

// ---------------------------------------------------------------- session budget
// streams: every stream a browser may attach to. Live ones are static; playback ones are created on request.
const streams = new Map();
for (const c of CAMS) {
  for (const q of ['sub', 'main']) streams.set(`live_${c.ch}_${q}`, { name: `live_${c.ch}_${q}`, kind: 'live', ch: c.ch, quality: q, viewers: new Set(), releasedAt: 0 });
}
const reserved = new Map(); // key -> count (sessions being opened right now)
let g2Active = new Set(); // streams go2rtc reports as connected to the NVR (ground truth)
const probeReleases = []; // recent raw-RTSP DESCRIBE probes (not visible in go2rtc)
let interactiveWaiting = 0;

function inUse() {
  const now = Date.now();
  const s = new Set(g2Active);
  for (const st of streams.values()) if (st.viewers.size || now - st.releasedAt < GRACE_MS) s.add(st.name);
  for (const k of reserved.keys()) s.add(k);
  probeReleases.forEach((t, i) => { if (now - t < GRACE_MS) s.add('probe-grace#' + i); });
  return s;
}

// priority 'interactive' (viewers) always beats 'bg' (keyframes/timelapse workers)
async function acquire(key, prio = 'interactive', timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  if (prio === 'interactive') interactiveWaiting++;
  try {
    for (;;) {
      const s = inUse();
      const ok = s.has(key) || (s.size < MAX && (prio === 'interactive' || interactiveWaiting === 0));
      if (ok) { reserved.set(key, (reserved.get(key) || 0) + 1); return true; }
      if (Date.now() > deadline) return false;
      await sleep(prio === 'bg' ? 500 : 250);
    }
  } finally { if (prio === 'interactive') interactiveWaiting--; }
}
function unreserve(key) {
  const c = (reserved.get(key) || 1) - 1;
  if (c > 0) reserved.set(key, c); else reserved.delete(key);
}

async function pollGo2rtc() {
  try {
    const r = await g2req('GET', '/api/streams', 3000);
    const j = JSON.parse(r.body.toString() || '{}');
    const s = new Set();
    for (const [n, v] of Object.entries(j || {})) if ((v.producers || []).some((p) => p.remote_addr)) s.add(n);
    g2Active = s; g2up = true;
  } catch (_) { g2up = false; }
  const now = Date.now();
  while (probeReleases.length && now - probeReleases[0] > GRACE_MS) probeReleases.shift();
}
setInterval(pollGo2rtc, 1000); // localhost only — never touches the NVR

function describeUse() {
  return [...inUse()].map(labelFor).join(', ');
}
function labelFor(name) {
  const st = streams.get(name);
  if (!st) {
    if (name.startsWith('fr_') || name.startsWith('frame:')) return 'keyframe fetch';
    if (name.startsWith('probe')) return 'playback check';
    return name;
  }
  const cam = camBy(st.ch);
  if (st.kind === 'live') return `${cam.name} live (${st.quality === 'main' ? 'main' : 'sub'})`;
  return `${cam.name} playback ${T.nvrText(st.utcStart, OFF).slice(5, 16)} NVR`;
}

// ---------------------------------------------------------------- credentials check / status (on demand only)
const status = { checkedAt: 0, ok: null, error: null, device: null, clock: null };
let statusP = null;
function refreshStatus() {
  if (statusP) return statusP;
  statusP = (async () => {
    if (nvr.breaker.tripped) { status.ok = false; status.error = nvr.breaker.reason; return; }
    let sess = null;
    try {
      sess = await nvr.rpcLogin();
      const t0 = Date.now();
      const tm = await nvr.rpcCall(sess, 'global.getCurrentTime');
      const t1 = Date.now();
      const dt = await nvr.rpcCall(sess, 'magicBox.getDeviceType');
      const sw = await nvr.rpcCall(sess, 'magicBox.getSoftwareVersion');
      const nvrTime = tm.params && tm.params.time;
      const nvrUtc = T.nvrTextToUtc(nvrTime, OFF);
      status.clock = nvrTime ? { nvrTime, driftSec: nvrUtc == null ? null : Math.round((nvrUtc - (t0 + t1) / 2) / 1000), at: t1 } : null;
      status.device = {
        serial: sess.serial,
        type: dt.params && dt.params.type,
        version: sw.params && sw.params.version ? `${sw.params.version.Version} (${sw.params.version.BuildDate})` : null,
      };
      status.ok = true; status.error = null;
    } catch (e) {
      status.ok = nvr.breaker.tripped ? false : null; // null = unknown (network), false = credentials bad
      status.error = e.message;
    } finally {
      status.checkedAt = Date.now();
      if (sess) await nvr.rpcLogout(sess);
      statusP = null;
    }
  })();
  return statusP;
}
// Before the first NVR contact (stream, snapshot...), verify credentials once via RPC so a bad
// password trips the breaker after ONE attempt instead of go2rtc hammering RTSP into a lockout.
async function ensureCreds() {
  if (nvr.breaker.tripped) throw new Error('NVR login disabled: ' + nvr.breaker.reason + ' — fix config.json and restart');
  if (status.ok === true) return;
  if (Date.now() - status.checkedAt > 30000) await refreshStatus();
  if (nvr.breaker.tripped) throw new Error('NVR login disabled: ' + nvr.breaker.reason + ' — fix config.json and restart');
}

// ---------------------------------------------------------------- websocket proxy (browser <-> go2rtc MSE)
function wsAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }
function wsReject(sock, key, msg) {
  try {
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
    const payload = Buffer.from(JSON.stringify({ type: 'error', value: msg }));
    const hdr = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    sock.write(Buffer.concat([hdr, payload, Buffer.from([0x88, 0x00])]));
    sock.end();
  } catch (_) { sock.destroy(); }
}

async function onUpgrade(req, sock, head) {
  sock.on('error', () => {});
  if (!allowed(req.socket.remoteAddress)) return sock.destroy();
  const u = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !key) return sock.destroy();
  const name = u.searchParams.get('src') || '';
  const st = streams.get(name);
  if (!st) return wsReject(sock, key, 'unknown or expired stream');
  if (st.kind === 'playback' && st.ended && st.viewers.size === 0) st.ended = false;
  try { await ensureCreds(); } catch (e) { return wsReject(sock, key, e.message); }
  if (sock.destroyed) return;
  const ok = await acquire(name, 'interactive', 6000);
  if (sock.destroyed) { if (ok) unreserve(name); return; }
  if (!ok) return wsReject(sock, key, `busy: NVR session limit (${MAX}) reached — in use: ${describeUse()}`);
  if (st.kind === 'playback') {
    try { await ensureInG2(st); } catch (e) { unreserve(name); return wsReject(sock, key, 'playback error: ' + e.message); }
  }
  let attached = false; let done = false;
  const up = net.connect(G2_PORT, '127.0.0.1');
  const cleanup = () => {
    if (done) return; done = true;
    if (attached) {
      st.viewers.delete(sock);
      log(`viewer -  ${name} (${st.viewers.size} left)`);
      if (st.viewers.size === 0) { st.releasedAt = Date.now(); onViewersEmpty(st); }
    } else unreserve(name);
    up.destroy(); sock.destroy();
  };
  up.on('connect', () => {
    if (done) return;
    up.write(`GET /api/ws?src=${enc(name)} HTTP/1.1\r\nHost: 127.0.0.1:${G2_PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
    attached = true; unreserve(name);
    st.viewers.add(sock); st.lastUsed = Date.now();
    log(`viewer +  ${name} (${st.viewers.size}) from ${req.socket.remoteAddress}`);
    if (st.kind === 'playback' && st.viewers.size === 1) startPlaybackTimer(st);
  });
  up.on('error', cleanup); up.on('close', cleanup);
  sock.on('close', cleanup); sock.on('error', cleanup);
}

// ---------------------------------------------------------------- playback
// The NVR streams playback at 1x and, at the end of the window, just stalls; go2rtc would then time
// out and RECONNECT (restarting the clip). So we end each playback stream ourselves after its duration.
async function ensureInG2(st) {
  if (st.g2gen === g2gen) return;
  const r = await g2req('PUT', `/api/streams?name=${enc(st.name)}&src=${enc(st.url)}`);
  if (r.status >= 300) throw new Error('go2rtc refused stream (' + r.status + ')');
  st.g2gen = g2gen;
}
async function removeFromG2(name) {
  try { await g2req('DELETE', `/api/streams?src=${enc(name)}`); } catch (_) { /* ignore */ }
}
function startPlaybackTimer(st) {
  clearTimeout(st.endTimer);
  st.ended = false;
  st.startedAt = Date.now();
  st.endTimer = setTimeout(() => endPlayback(st), (st.durationSec + 6) * 1000);
}
function endPlayback(st) {
  log(`playback window finished: ${st.name}`);
  st.ended = true;
  for (const s of st.viewers) s.destroy();
  st.g2gen = -1;
  removeFromG2(st.name);
}
function onViewersEmpty(st) {
  if (st.kind !== 'playback') return;
  clearTimeout(st.endTimer);
  setTimeout(() => { if (st.viewers.size === 0 && st.g2gen !== -1) { st.g2gen = -1; removeFromG2(st.name); } }, 1000);
}
setInterval(() => {
  const now = Date.now();
  for (const [n, st] of streams) if (st.kind === 'playback' && !st.viewers.size && now - st.lastUsed > 30 * 60e3) streams.delete(n);
}, 60e3);

async function createPlayback(b) {
  const cam = camBy(b.ch);
  if (!cam) throw httpErr(400, 'unknown camera');
  const minutes = Number(b.minutes);
  if (!(minutes > 0) || minutes > PB_MAX_MIN) throw httpErr(400, `window must be 0–${PB_MAX_MIN} minutes`);
  let utcStart; let note = '';
  if (Number.isFinite(Number(b.utcStart)) && b.utcStart !== '' && b.utcStart != null) {
    utcStart = Math.floor(Number(b.utcStart) / 1000) * 1000;
  } else {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.date || '');
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(b.time || '');
    if (!dm || !tm) throw httpErr(400, 'date (YYYY-MM-DD) and time (HH:MM) required');
    const r = T.wallToUtc(+dm[1], +dm[2], +dm[3], +tm[1], +tm[2], +(tm[3] || 0), TZ);
    if (r.gap) throw httpErr(400, 'that local time does not exist (DST spring-forward gap)');
    utcStart = b.occurrence === 'second' && r.alt ? r.alt : r.utc;
    if (r.ambiguous) note = 'This local time happens twice (DST fall-back); using the ' + (utcStart === r.alt ? 'second (standard time)' : 'first (daylight time)') + ' occurrence.';
  }
  const now = Date.now();
  if (utcStart > now - 15000) throw httpErr(400, 'start time is in the future');
  let utcEnd = utcStart + Math.round(minutes * 60) * 1000;
  if (utcEnd > now - 5000) { utcEnd = now - 5000; note += (note ? ' ' : '') + 'Window clipped at the present.'; }
  const durationSec = Math.round((utcEnd - utcStart) / 1000);
  if (durationSec < 5) throw httpErr(400, 'window too short');
  const sTok = T.nvrToken(utcStart, OFF); const eTok = T.nvrToken(utcEnd, OFF);
  const name = `pb_${cam.ch}_${sTok}_${eTok}`;

  // Existence check: DESCRIBE only (no PLAY). Costs one short NVR session, counted in the budget.
  await ensureCreds();
  let recordedSec = null;
  if (!streams.has(name)) {
    const probeKey = 'probe:' + crypto.randomBytes(4).toString('hex');
    if (!(await acquire(probeKey, 'interactive', 8000))) throw httpErr(503, `busy: NVR session limit (${MAX}) reached — in use: ${describeUse()}`);
    let d;
    try { d = await nvr.rtspDescribe(pbPathQ(cam.ch, sTok, eTok)); } catch (e) { throw httpErr(502, 'NVR did not answer: ' + e.message); } finally { unreserve(probeKey); probeReleases.push(Date.now()); }
    if (d.status === 401) throw httpErr(503, 'NVR refused the session (401) — it may be at its connection limit; try again shortly');
    if (d.status !== 200) throw httpErr(404, `No recording found for that window (NVR answered RTSP ${d.status})`);
    const rm = /a=range:npt=([\d.]+)-([\d.]+)/.exec(d.body);
    recordedSec = rm ? Math.round(+rm[2] - +rm[1]) : null;
    if (recordedSec === 0) throw httpErr(404, 'No recording found for that window');
    streams.set(name, { name, kind: 'playback', ch: cam.ch, utcStart, utcEnd, durationSec, recordedSec, url: pbUrl(cam.ch, sTok, eTok), viewers: new Set(), releasedAt: 0, g2gen: -1, lastUsed: Date.now(), endTimer: null });
  } else recordedSec = streams.get(name).recordedSec;
  streams.get(name).lastUsed = Date.now();
  return {
    name, ch: cam.ch, camName: cam.name, utcStart, utcEnd, durationSec, recordedSec, note,
    nvrStart: T.nvrText(utcStart, OFF), nvrEnd: T.nvrText(utcEnd, OFF),
    localStart: T.zoneText(utcStart, TZ), localEnd: T.zoneText(utcEnd, TZ),
  };
}

// ---------------------------------------------------------------- snapshots (HTTP CGI, 352x240, no RTSP session)
const snapCache = new Map(); let snapChain = Promise.resolve();
function getSnapshot(ch) {
  const c = snapCache.get(ch);
  if (c && (c.buf && Date.now() - c.t < 5000)) return Promise.resolve(c.buf);
  if (c && c.p) return c.p;
  const p = (snapChain = snapChain.catch(() => {}).then(async () => { // one at a time, gentle on the NVR
    await ensureCreds();
    const r = await nvr.digestGet(`/cgi-bin/snapshot.cgi?channel=${ch}`, 8000);
    if (r.status !== 200 || r.body.length < 500) throw new Error('snapshot HTTP ' + r.status);
    snapCache.set(ch, { buf: r.body, t: Date.now() });
    return r.body;
  }));
  snapCache.set(ch, { ...(c || {}), p });
  p.catch(() => {}).finally(() => { const x = snapCache.get(ch); if (x && x.p === p) delete x.p; });
  return p;
}

// ---------------------------------------------------------------- motion events (mediaFileFind.cgi, read-only search)
let findChain = Promise.resolve();
const eventMem = new Map();
function localDayBounds(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw httpErr(400, 'date must be YYYY-MM-DD');
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const a = T.wallToUtc(y, mo, d, 0, 0, 0, TZ).utc;
  const b = T.wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, TZ).utc;
  return { from: a, to: b, y, mo, d };
}
async function findFiles(ch, fromUtc, toUtc) {
  const r0 = await nvr.digestGet('/cgi-bin/mediaFileFind.cgi?action=factory.create');
  const obj = (/result=(\d+)/.exec(r0.body.toString()) || [])[1];
  if (!obj) throw new Error('mediaFileFind create failed (HTTP ' + r0.status + ')');
  const items = [];
  try {
    const st = enc(T.nvrText(fromUtc, OFF)); const et = enc(T.nvrText(toUtc, OFF));
    const r1 = await nvr.digestGet(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${obj}&condition.Channel=${ch}&condition.StartTime=${st}&condition.EndTime=${et}&condition.Types[0]=dav`);
    if (!/OK/.test(r1.body.toString())) return items; // nothing recorded in range
    for (let page = 0; page < 60; page++) {
      const r = await nvr.digestGet(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${obj}&count=100`);
      const text = r.body.toString();
      const found = +((/found=(\d+)/.exec(text) || [])[1] || 0);
      const byIdx = new Map();
      for (const line of text.split(/\r?\n/)) {
        const m = /^items\[(\d+)\]\.([^=]+)=(.*)$/.exec(line.trim());
        if (!m) continue;
        if (!byIdx.has(m[1])) byIdx.set(m[1], { flags: [], events: [] });
        const it = byIdx.get(m[1]);
        if (m[2].startsWith('Flags[')) it.flags.push(m[3]);
        else if (m[2].startsWith('Events[')) it.events.push(m[3]);
        else it[m[2]] = m[3];
      }
      for (const it of byIdx.values()) items.push(it);
      if (found < 100) break;
    }
  } finally {
    await nvr.digestGet(`/cgi-bin/mediaFileFind.cgi?action=close&object=${obj}`).catch(() => {});
    await nvr.digestGet(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${obj}`).catch(() => {});
  }
  return items;
}
function getEvents(ch, dateStr) {
  const cam = camBy(ch);
  if (!cam) return Promise.reject(httpErr(400, 'unknown camera'));
  const { from, to } = localDayBounds(dateStr);
  const key = `${cam.ch}_${dateStr}`;
  const file = path.join(DIRS.events, key + '.json');
  const complete = to < Date.now() - 3600e3; // finished days never change -> disk cache forever
  if (complete && fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  const m = eventMem.get(key);
  if (m && Date.now() - m.t < 60000) return Promise.resolve(m.v);
  if (from > Date.now()) return Promise.resolve({ ch: cam.ch, date: dateStr, from, to, events: [], recordings: [] });
  const p = (findChain = findChain.catch(() => {}).then(async () => {
    await ensureCreds();
    const items = await findFiles(cam.ch, from, Math.min(to, Date.now()));
    const events = []; const recs = [];
    for (const it of items) {
      const s = T.nvrTextToUtc(it.StartTime, OFF); const e = T.nvrTextToUtc(it.EndTime, OFF);
      if (s == null || e == null || e <= from || s >= to) continue;
      if (it.flags.includes('Event') || it.events.length) events.push({ start: s, end: e, types: it.events.length ? it.events : ['Event'] });
      else recs.push([Math.max(s, from), Math.min(e, to)]);
    }
    events.sort((a, b) => a.start - b.start);
    recs.sort((a, b) => a[0] - b[0]);
    const v = { ch: cam.ch, date: dateStr, from, to, events, recordings: mergeRanges(recs.concat(events.map((x) => [Math.max(x.start, from), Math.min(x.end, to)]))), fetchedAt: Date.now() };
    if (complete) fs.writeFileSync(file, JSON.stringify(v)); else eventMem.set(key, { t: Date.now(), v });
    return v;
  }));
  return p;
}
function mergeRanges(r) {
  r.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of r) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + 5000) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
}

// ---------------------------------------------------------------- keyframes (shared by event scanner + timelapse)
// One playback session per frame (~0.7 s), at most FRAME_WORKERS in parallel, always yielding to viewers,
// adaptive back-off on errors. Results are cached on disk, so a frame is fetched from the NVR once.
const fq = { kf: [], tl: [] }; const inflight = new Map();
let fqActive = 0; let fqLimit = FRAME_WORKERS; let fqStreak = 0;
const framePath = (ch, utc) => path.join(DIRS.frames, `ch${ch}`, T.nvrToken(utc, OFF) + '.mp4');

function requestFrame(ch, utc, prio) {
  utc = Math.floor(utc / 1000) * 1000;
  const file = framePath(ch, utc);
  if (fs.existsSync(file)) return { promise: Promise.resolve(file), cancel() {} };
  const key = `${ch}_${utc}`;
  let t = inflight.get(key);
  if (!t) {
    t = { key, ch, utc, file, prio, waiters: 0, started: false, canceled: false };
    t.promise = new Promise((res, rej) => { t.resolve = res; t.reject = rej; });
    t.promise.catch(() => {});
    inflight.set(key, t);
    fq[prio].push(t);
    pumpFrames();
  } else if (prio === 'kf' && t.prio === 'tl' && !t.started) { // promote
    fq.tl = fq.tl.filter((x) => x !== t); t.prio = 'kf'; fq.kf.unshift(t);
  }
  t.waiters++;
  let canceled = false;
  return {
    promise: t.promise,
    cancel() { // browser went away before we started -> don't touch the NVR for it
      if (canceled) return; canceled = true;
      if (--t.waiters <= 0 && !t.started) {
        t.canceled = true; inflight.delete(key);
        fq[t.prio] = fq[t.prio].filter((x) => x !== t);
        t.reject(new Error('canceled'));
      }
    },
  };
}
function pumpFrames() {
  while (fqActive < fqLimit) {
    const t = fq.kf.shift() || fq.tl.shift();
    if (!t) return;
    if (t.canceled) continue;
    t.started = true; fqActive++;
    runFrame(t).finally(() => { fqActive--; pumpFrames(); });
  }
}
async function runFrame(t) {
  const name = `fr_${t.ch}_${T.nvrToken(t.utc, OFF)}`;
  const rkey = name; // same key go2rtc reports, so one fetch counts as exactly one session
  try {
    await ensureCreds();
    if (!(await acquire(rkey, 'bg', 120000))) throw new Error('NVR busy (session limit)');
    try {
      const put = await g2req('PUT', `/api/streams?name=${enc(name)}&src=${enc(pbUrl(t.ch, T.nvrToken(t.utc, OFF), T.nvrToken(t.utc + 20000, OFF)))}`);
      if (put.status >= 300) throw new Error('go2rtc refused frame stream');
      const r = await g2req('GET', `/api/frame.mp4?src=${enc(name)}`, 20000);
      if (r.status !== 200 || r.body.length < 1000) throw new Error('no recording at that time');
      mp4.parseFrame(r.body); // validate
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      fs.writeFileSync(t.file + '.tmp', r.body); fs.renameSync(t.file + '.tmp', t.file);
    } finally {
      await removeFromG2(name);
      unreserve(rkey);
    }
    if (++fqStreak >= 10 && fqLimit < FRAME_WORKERS) { fqLimit++; fqStreak = 0; }
    t.resolve(t.file);
  } catch (e) {
    fqStreak = 0;
    if (fqLimit > 1) { fqLimit--; log('keyframe error, workers ->', fqLimit, e.message); }
    await sleep(1000);
    t.reject(e);
  } finally { inflight.delete(t.key); }
}
setInterval(() => { // prune old cached frames
  const cutoff = Date.now() - FRAME_RETENTION_DAYS * 86400e3;
  for (const d of fs.readdirSync(DIRS.frames)) {
    const dir = path.join(DIRS.frames, d);
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) { /* ignore */ } }
  }
}, 6 * 3600e3);

// ---------------------------------------------------------------- timelapse (one camera, sunrise..sunset)
const jobs = new Map();
function sunWindow(dateStr) {
  if (!LOC || !Number.isFinite(LOC.lat) || !Number.isFinite(LOC.lon)) throw httpErr(400, 'Set "location": {"lat":..,"lon":..} in config.json for sunrise/sunset');
  const { y, mo, d } = localDayBounds(dateStr);
  const s = sunTimes(y, mo, d, LOC.lat, LOC.lon);
  if (s.sunrise == null) throw httpErr(400, 'no sunrise/sunset at this latitude on that day');
  return { sunrise: s.sunrise, sunset: s.sunset, start: s.sunrise - TLC.marginMinutes * 60e3, end: s.sunset + TLC.marginMinutes * 60e3 };
}
function tlFileName(ch, dateStr, interval) { return `timelapse_ch${ch}_${dateStr}_${interval}s.mp4`; }
function jobView(j) {
  return { id: j.id, ch: j.ch, date: j.date, interval: j.interval, fps: j.fps, state: j.state, total: j.total, done: j.done, failed: j.failed, msg: j.msg,
    start: j.start, end: j.end, sunrise: j.sunrise, sunset: j.sunset, url: j.state === 'done' ? '/media/timelapse/' + j.file : null, createdAt: j.createdAt, finishedAt: j.finishedAt, truncated: j.truncated };
}
function listTimelapses() {
  return fs.readdirSync(DIRS.tl).filter((f) => f.endsWith('.mp4')).sort().reverse().map((f) => {
    const st = fs.statSync(path.join(DIRS.tl, f));
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(DIRS.tl, f + '.json'), 'utf8')); } catch (_) { /* ignore */ }
    return { file: f, url: '/media/timelapse/' + f, bytes: st.size, ...meta };
  });
}
function startTimelapse(b) {
  const ch = TLC.channel;
  const dateStr = b.date;
  const interval = Math.max(15, Math.min(900, Math.round(Number(b.intervalSeconds) || TLC.intervalSeconds)));
  const fps = Math.max(2, Math.min(30, Math.round(Number(b.fps) || TLC.fps)));
  const w = sunWindow(dateStr);
  const now = Date.now();
  if (w.start > now - 60e3) throw httpErr(400, 'that day has not started yet (before sunrise)');
  const end = Math.min(w.end, now - 60e3);
  const truncated = end < w.end;
  const file = tlFileName(ch, dateStr, interval);
  const id = `${ch}_${dateStr}_${interval}`;
  const existing = jobs.get(id);
  if (existing && ['queued', 'running', 'assembling'].includes(existing.state)) return existing;
  if (!truncated && !b.force && fs.existsSync(path.join(DIRS.tl, file))) {
    const j = { id, ch, date: dateStr, interval, fps, state: 'done', total: 0, done: 0, failed: 0, file, msg: 'already rendered', ...w, createdAt: now, finishedAt: now };
    jobs.set(id, j); return j;
  }
  const times = [];
  for (let t = Math.ceil(w.start / (interval * 1000)) * interval * 1000; t <= end; t += interval * 1000) times.push(t);
  const j = { id, ch, date: dateStr, interval, fps, state: 'queued', total: times.length, done: 0, failed: 0, file, msg: '', truncated, ...w, createdAt: now, handles: [] };
  jobs.set(id, j);
  (async () => {
    j.state = 'running';
    const results = await Promise.all(times.map((t) => {
      const h = requestFrame(ch, t, 'tl'); j.handles.push(h);
      return h.promise.then((p) => { j.done++; return p; }, (e) => { j.failed++; j.lastError = e.message; return null; });
    }));
    j.handles = [];
    if (j.state === 'canceled') return;
    const paths = results.filter(Boolean);
    if (paths.length < 2) { j.state = 'error'; j.msg = 'too few frames (' + (j.lastError || 'no recordings') + ')'; return; }
    j.state = 'assembling';
    try {
      const out = path.join(DIRS.tl, truncated ? file.replace('.mp4', '_partial.mp4') : file);
      if (truncated) j.file = path.basename(out);
      const r = mp4.writeTimelapse(paths, out, fps);
      fs.writeFileSync(out + '.json', JSON.stringify({ ch, date: dateStr, interval, fps, frames: r.frames, start: w.start, end, sunrise: w.sunrise, sunset: w.sunset, width: r.width, height: r.height, createdAt: Date.now(), truncated }));
      j.state = 'done'; j.finishedAt = Date.now();
      j.msg = `${r.frames} frames${j.failed ? `, ${j.failed} missing` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`;
      log('timelapse done', j.file, j.msg);
    } catch (e) { j.state = 'error'; j.msg = e.message; }
  })();
  return j;
}

// ---------------------------------------------------------------- HTTP
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > limit) { reject(httpErr(413, 'too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { reject(httpErr(400, 'bad JSON')); } });
    req.on('error', reject);
  });
}

const nets = (CFG.allowedNetworks || ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']).map((c) => {
  const [ip, bits] = c.split('/'); const n = ipInt(ip); const m = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0; return [n & m, m];
});
function ipInt(ip) { return ip.split('.').reduce((a, o) => ((a << 8) | (+o & 255)) >>> 0, 0); }
function allowed(addr) {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const n = ipInt(v4);
  return nets.some(([net, m]) => ((n & m) >>> 0) === net);
}

const STATIC = { '/index.html': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/time.js': 'text/javascript; charset=utf-8', '/mp4init.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/favicon.svg': 'image/svg+xml' };
const SPA = /^\/(?:|all|front|live|cam\/\d+|playback|events|timelapse)\/?$/;

function sendFile(req, res, file, type) {
  let st; try { st = fs.statSync(file); } catch (_) { return json(res, 404, { error: 'not found' }); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range && (range[1] || range[2])) {
    let a = range[1] ? +range[1] : st.size - +range[2]; let b = range[1] && range[2] ? +range[2] : st.size - 1;
    if (a > b || b >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  if (!allowed(req.socket.remoteAddress)) { res.writeHead(403); return res.end('forbidden'); }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;

  if (req.method === 'GET' && (SPA.test(p) || STATIC[p])) {
    const f = SPA.test(p) ? '/index.html' : p;
    const body = fs.readFileSync(path.join(ROOT, 'public', f));
    res.writeHead(200, { 'Content-Type': STATIC[f], 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    return res.end(body);
  }

  if (p === '/api/config') {
    return json(res, 200, {
      cameras: CAMS, timeZone: TZ, nvrUtcOffsetMinutes: OFF, maxSessions: MAX, playbackMaxMinutes: PB_MAX_MIN,
      serverNow: Date.now(), timelapse: { channel: TLC.channel, intervalSeconds: TLC.intervalSeconds, fps: TLC.fps, marginMinutes: TLC.marginMinutes, location: LOC },
    });
  }
  if (p === '/api/sessions') {
    const used = inUse();
    const list = [...streams.values()].filter((s) => s.viewers.size).map((s) => ({ label: labelFor(s.name), viewers: s.viewers.size, kind: s.kind }));
    const other = [...used].filter((n) => !streams.has(n) || !streams.get(n).viewers.size).map(labelFor);
    return json(res, 200, { max: MAX, used: used.size, streams: list, other, frameQueue: fq.kf.length + fq.tl.length + fqActive });
  }
  if (p === '/api/status') {
    if (!nvr.breaker.tripped && Date.now() - status.checkedAt > 10 * 60e3) await refreshStatus(); // on demand, ≤ once / 10 min
    return json(res, 200, { ...status, breaker: nvr.breaker.tripped ? nvr.breaker.reason : null, go2rtc: g2up, nvrUtcOffsetMinutes: OFF });
  }
  if (p === '/api/playback' && req.method === 'POST') {
    return json(res, 200, await createPlayback(await readJson(req)));
  }
  if (p === '/api/snapshot') {
    const cam = camBy(q.get('ch'));
    if (!cam) return json(res, 400, { error: 'unknown camera' });
    const buf = await getSnapshot(cam.ch);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    return res.end(buf);
  }
  if (p === '/api/events') {
    return json(res, 200, await getEvents(q.get('ch'), q.get('date')));
  }
  if (p === '/api/keyframe') {
    const cam = camBy(q.get('ch'));
    const t = Number(q.get('t'));
    if (!cam || !Number.isFinite(t)) return json(res, 400, { error: 'ch and t (UTC ms) required' });
    if (t > Date.now() - 20000) return json(res, 400, { error: 'time is too recent' });
    const h = requestFrame(cam.ch, t, 'kf');
    res.on('close', () => { if (!res.writableEnded) h.cancel(); });
    let file;
    try { file = await h.promise; } catch (e) { if (e.message === 'canceled') return; throw httpErr(404, e.message); }
    const out = mp4.singleFrameMp4(fs.readFileSync(file));
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': out.length, 'Cache-Control': 'private, max-age=604800' });
    return res.end(out);
  }
  if (p === '/api/sun') {
    return json(res, 200, sunWindow(q.get('date')));
  }
  if (p === '/api/timelapse' && req.method === 'POST') {
    return json(res, 200, jobView(startTimelapse(await readJson(req))));
  }
  if (p === '/api/timelapse/cancel' && req.method === 'POST') {
    const b = await readJson(req); const j = jobs.get(b.id);
    if (j && ['queued', 'running'].includes(j.state)) { j.state = 'canceled'; j.msg = 'canceled'; for (const h of j.handles) h.cancel(); }
    return json(res, 200, j ? jobView(j) : { error: 'no such job' });
  }
  if (p === '/api/timelapse') {
    return json(res, 200, { jobs: [...jobs.values()].map(jobView).reverse(), files: listTimelapses() });
  }
  const mm = /^\/media\/timelapse\/([\w.-]+\.mp4)$/.exec(p);
  if (mm) return sendFile(req, res, path.join(DIRS.tl, mm[1]), 'video/mp4');

  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.code || e.code >= 500) log('error', req.method, req.url, e.message);
    if (!res.headersSent) json(res, typeof e.code === 'number' ? e.code : 500, { error: redact(e.message) });
    else res.destroy();
  });
});
server.on('upgrade', (req, sock, head) => { onUpgrade(req, sock, head).catch((e) => { log('ws error', e.message); sock.destroy(); }); });

startGo2rtc();
const L = CFG.listen || {};
server.listen(L.port || 8080, L.host || '0.0.0.0', () => log(`NVR viewer on http://${L.host || '0.0.0.0'}:${L.port || 8080}  (NVR ${NVRC.host}, max ${MAX} RTSP sessions)`));

function shutdown() { stopping = true; if (g2proc) g2proc.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
