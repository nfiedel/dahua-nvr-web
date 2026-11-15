'use strict';
/* NVR Viewer UI — vanilla JS, no build step. */
const TU = window.TimeUtil;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let CFG, TZ, OFF, CAMS;
const camBy = (ch) => CAMS.find((c) => c.ch === Number(ch));
const pad = TU.pad;
const shortTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(ms);
const tzAbbr = (ms) => (new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName') || {}).value || '';
const localDate = (ms) => { const p = TU.zoneParts(ms, TZ); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const localHM = (ms) => { const p = TU.zoneParts(ms, TZ); return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; };
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };
const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${pad(Math.round(s % 60))}s` : `${Math.round(s)}s`);

// ===================================================================== MSE player (go2rtc websocket)
// Players whose play() was refused (iOS Low Power Mode blocks even muted autoplay). Any tap resumes them all.
const blockedPlayers = new Set();
let shownAt = 0; // when the page last became visible again (see onShown)
document.addEventListener('click', () => { for (const p of [...blockedPlayers]) p.resume(); }, true);
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'avc1.4D401F', 'avc1.42E01E', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
class MsePlayer {
  constructor(video, { live = true, onState = () => {} } = {}) {
    Object.assign(this, { video, live, onState });
    this.active = false; this.ws = null; this.retry = 0;
  }
  start(src) {
    this.stop(true);
    this.src = src; this.active = true; this.retry = 0; this.userPaused = false;
    this._open();
    if (this.live) this.watch = setInterval(() => this._watchdog(), 5000);
  }
  stop(silent) {
    this.active = false;
    clearTimeout(this.timer); this.timer = null; clearInterval(this.watch); clearTimeout(this.wakeCheck);
    this.blocked = false; blockedPlayers.delete(this);
    this._teardown();
    if (!silent) this.onState('idle');
  }
  _play() {
    const p = this.video.play();
    if (!p || !p.then) return;
    p.then(() => { if (this.blocked) { this.blocked = false; blockedPlayers.delete(this); } },
      (e) => { if (e && e.name === 'NotAllowedError' && this.active) { this.blocked = true; blockedPlayers.add(this); } });
  }
  resume() { // from a user gesture: jump to the live edge (live) and play
    const v = this.video; const b = v.buffered;
    if (this.live && b.length) v.currentTime = Math.max(b.start(0), b.end(b.length - 1) - 0.4);
    this._play();
  }
  // Page visible again. iOS closes our sockets on screen lock / app switch, and timers were frozen meanwhile:
  // reconnect now instead of after the backoff. At most one reconnect per player per wake, no polling.
  wake() {
    if (!this.active) return;
    const v = this.video;
    if (!this.live) { if (!this.userPaused && !this.streamDone && v.paused && this.base != null) this._play(); return; }
    if (!this.ws) { if (this.timer) this._reopen(); return; } // was waiting out a backoff
    if (v.paused && this.base != null) this._play();
    clearTimeout(this.wakeCheck); // socket looks open; if nothing arrives once queued messages have drained, it's dead
    this.wakeCheck = setTimeout(() => { if (this.active && this.ws && this.base != null && Date.now() - this.lastData > 3000) this._reopen(); }, 1500);
  }
  _reopen() { clearTimeout(this.timer); this.timer = null; this._teardown(); this.retry = 0; this.onState('connecting'); this._open(); }
  get elapsed() { return this.base == null ? 0 : Math.max(0, this.video.currentTime - this.base); }
  get bufferedAhead() { const b = this.video.buffered; return b.length ? b.end(b.length - 1) - this.video.currentTime : 0; }
  _teardown() {
    if (this.ws) { const w = this.ws; this.ws = null; w.onclose = w.onmessage = w.onopen = null; try { w.close(); } catch (_) { /* */ } }
    this.sb = null; this.queue = []; this.ms = null; this.base = null; this.streamDone = false;
    const v = this.video;
    try { v.pause(); } catch (_) { /* */ }
    v.removeAttribute('src');
    try { v.srcObject = null; } catch (_) { /* */ }
    v.load();
  }
  _open() {
    const MS = window.MediaSource || window.ManagedMediaSource;
    if (!MS) { this.onState('error', 'This browser lacks Media Source Extensions.'); return; }
    const ms = new MS(); this.ms = ms; this.queue = []; this.sb = null; this.base = null; this.err = null; this.lastData = Date.now(); this.streamDone = false; this.initSeen = false;
    const v = this.video;
    v.muted = true; v.playsInline = true;
    if (MS === window.ManagedMediaSource && !window.MediaSource) { v.disableRemotePlayback = true; v.srcObject = ms; } else v.src = URL.createObjectURL(ms);
    this.onState('connecting');
    ms.addEventListener('sourceopen', () => {
      if (this.ms !== ms) return;
      if (v.src && v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
      this._ws(ms, MS);
    }, { once: true });
  }
  _ws(ms, MS) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?src=${encodeURIComponent(this.src)}`);
    ws.binaryType = 'arraybuffer'; this.ws = ws;
    ws.onopen = () => {
      const c = CODECS.filter((x) => MS.isTypeSupported(`video/mp4; codecs="${x}"`)).join(',');
      ws.send(JSON.stringify({ type: 'mse', value: c }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.type === 'mse') {
          try {
            const sb = ms.addSourceBuffer(m.value); sb.mode = 'segments';
            sb.addEventListener('updateend', () => this._pump());
            this.sb = sb; this._pump();
          } catch (e) { this.err = 'Codec not supported by this browser: ' + m.value; ws.close(); }
        } else if (m.type === 'error') this.err = m.value;
        return;
      }
      this.lastData = Date.now();
      const chunk = new Uint8Array(ev.data);
      if (!this.initSeen) { // first binary message is the init segment: fix go2rtc's bogus picture size (see mp4init.js)
        this.initSeen = true;
        const fx = window.Mp4Init && window.Mp4Init.fixInit(chunk);
        if (fx && fx.length) console.debug('mp4 init size fixed', this.src, fx);
      }
      this.queue.push(chunk);
      this._pump();
    };
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; this._closed(); };
  }
  _pump() {
    const sb = this.sb; const v = this.video;
    if (!sb || sb.updating || !this.ms || this.ms.readyState !== 'open') return;
    const b = sb.buffered;
    if (b.length) {
      const start = b.start(0); const end = b.end(b.length - 1);
      if (this.base == null) { this.base = start; v.currentTime = start; this._play(); this.retry = 0; this.onState('playing'); }
      if (this.live && !v.paused && end - v.currentTime > 2.5) v.currentTime = end - 0.4; // stay at the live edge
      else if (this.live && v.paused && end - v.currentTime > 30) v.currentTime = end - 0.4; // not playing (autoplay blocked): keep the trim below working
      if (v.currentTime - start > 60) { try { sb.remove(start, v.currentTime - 20); return; } catch (_) { /* */ } }
    }
    if (!this.queue.length) return;
    let data;
    if (this.queue.length === 1) data = this.queue.shift();
    else {
      const n = this.queue.reduce((a, c) => a + c.length, 0); data = new Uint8Array(n);
      let o = 0; for (const c of this.queue) { data.set(c, o); o += c.length; } this.queue = [];
    }
    try { sb.appendBuffer(data); this.evicting = false; } catch (e) {
      if (e.name !== 'QuotaExceededError') { this.err = 'Playback error: ' + e.message; if (this.ws) this.ws.close(); return; }
      // Buffer full (ManagedMediaSource on iOS has a small quota): free what's behind the playhead and retry
      // this chunk once on updateend instead of dropping it (a dropped fragment corrupts video until the next keyframe).
      const b = sb.buffered;
      if (!this.evicting && b.length && v.currentTime - b.start(0) > 2) {
        this.evicting = true; this.queue.unshift(data);
        try { sb.remove(b.start(0), v.currentTime - 1); } catch (_) { this.queue.shift(); this.evicting = false; }
      } else this.evicting = false; // nothing to free: drop it, as before
    }
  }
  _watchdog() {
    if (this.ws && this.base != null && Date.now() - this.lastData > 15000) { this.err = 'Stream stalled — reconnecting…'; this.ws.close(); }
    else if (this.ws && this.base == null && Date.now() - this.lastData > 25000) { this.err = 'No video from NVR — retrying…'; this.ws.close(); }
  }
  _closed() {
    if (!this.active) return;
    if (!this.live) { // never auto-reconnect playback: it would restart the clip from the beginning
      this.streamDone = true;
      this.onState(this.err && this.base == null ? 'error' : 'streamdone', this.err);
      return;
    }
    const busy = !!(this.err && /^busy/i.test(this.err));
    const msg = this.err || 'Connection lost — reconnecting…';
    // closed by the lock / app switch we just came back from: reconnect at once, once per wake
    const woke = !busy && Date.now() - shownAt < 3000 && this.wokeAt !== shownAt;
    if (woke) this.wokeAt = shownAt;
    const delay = busy ? 10000 : woke ? 0 : Math.min(30000, 2000 * 2 ** this.retry++);
    this._teardown();
    if (woke) this.onState('connecting'); else this.onState(busy ? 'busy' : 'error', msg);
    this.timer = setTimeout(() => { this.timer = null; if (this.active) this._open(); }, delay);
  }
}

// ===================================================================== live tile
function makeTile(cam, quality, { onclick, big } = {}) {
  const video = h('video', { muted: true, playsinline: true, autoplay: true });
  const snap = h('img', { class: 'snap', alt: '' }); snap.hidden = true;
  const status = h('div', { class: 'status' });
  const label = h('div', { class: 'label' }, h('b', {}, cam.name), h('span', {}, ` · ${cam.desc} · ${quality === 'main' ? cam.main : cam.sub}`));
  let player = null;
  const el = h('div', { class: 'tile' + (big ? ' big' : ''), onclick: onclick && ((e) => { if (!player.blocked) onclick(e); }) }, video, snap, status, label);
  let snapTimer = null;
  const showSnap = (on) => {
    clearInterval(snapTimer); snap.hidden = !on;
    if (on) { const load = () => { snap.src = `/api/snapshot?ch=${cam.ch}&t=${Date.now()}`; }; load(); snapTimer = setInterval(load, 10000); }
  };
  const setStatus = (text, cls) => { status.textContent = text || ''; status.className = 'status' + (cls ? ' ' + cls : ''); };
  player = new MsePlayer(video, {
    live: true,
    onState: (s, msg) => {
      if (s === 'playing') { setStatus(''); showSnap(false); }
      else if (s === 'connecting') setStatus('Connecting…');
      else if (s === 'busy') { setStatus('All NVR sessions in use — showing snapshot, retrying…', 'busy'); showSnap(true); }
      else if (s === 'error') setStatus(msg || 'Error', 'err');
      else if (s === 'idle') { setStatus(''); showSnap(false); }
    },
  });
  return { el, start() { player.start(`live_${cam.ch}_${quality}`); }, stop() { player.stop(); showSnap(false); }, wake() { player.wake(); } };
}

// ===================================================================== views
const views = {};
let current = null; let currentKey = '';

views.grid = {
  el: $('#view-grid'),
  init() { this.tiles = CAMS.map((c) => makeTile(c, 'sub', { onclick: () => go(`/cam/${c.ch}`) })); $('#grid').append(...this.tiles.map((t) => t.el)); },
  enter() { document.title = 'All cameras · NVR'; this.tiles.forEach((t) => t.start()); },
  leave() { this.tiles.forEach((t) => t.stop()); },
  wake() { this.tiles.forEach((t) => t.wake()); },
};

views.single = {
  el: $('#view-single'),
  enter(r) {
    const cam = camBy(r.ch) || CAMS[0];
    document.title = `${cam.name} · NVR`;
    $('#single-title').textContent = cam.name;
    $('#single-meta').textContent = `${cam.desc} · main stream ${cam.main}`;
    $('#single-pb').href = `/playback?ch=${cam.ch}`; $('#single-ev').href = `/events?ch=${cam.ch}`;
    this.tile = makeTile(cam, 'main', { big: true });
    $('#single-stage').replaceChildren(this.tile.el);
    this.tile.start();
    // other cameras as cheap HTTP snapshots (no RTSP session), refreshed while this view is open
    const others = CAMS.filter((c) => c.ch !== cam.ch);
    const imgs = others.map((c) => { const img = h('img', { alt: c.name }); return { c, img, el: h('div', { class: 'thumb', onclick: () => go(`/cam/${c.ch}`) }, img, h('span', {}, c.name)) }; });
    $('#thumbs').replaceChildren(...imgs.map((x) => x.el));
    const load = () => imgs.forEach((x, i) => setTimeout(() => { x.img.src = `/api/snapshot?ch=${x.c.ch}&t=${Date.now()}`; }, i * 400));
    if (!document.body.classList.contains('kiosk')) { load(); this.timer = setInterval(load, 15000); }
  },
  leave() { if (this.tile) this.tile.stop(); clearInterval(this.timer); $('#thumbs').replaceChildren(); },
  wake() { if (this.tile) this.tile.wake(); },
};

// ----------------------------------------------------------------- playback
views.playback = {
  el: $('#view-playback'),
  init() {
    const sel = $('#pb-ch');
    for (const c of CAMS) sel.append(h('option', { value: c.ch }, `${c.name} — ${c.desc}`));
    $('#pb-len').replaceChildren(...[1, 2, 5, 10, 15, 30].filter((m) => m <= CFG.playbackMaxMinutes).map((m) => h('option', { value: m, selected: m === 2 }, `${m} min`)));
    $('#pb-local-label').textContent = `Local (${TZ.split('/').pop().replace('_', ' ')})`;
    this.tile = h('div', { class: 'tile' }, this.video = h('video', { muted: true, playsinline: true }), this.status = h('div', { class: 'status' }));
    $('#pb-stage').append(this.tile);
    this.player = new MsePlayer(this.video, { live: false, onState: (s, msg) => this.onState(s, msg) });
    $('#pb-form').addEventListener('submit', (e) => { e.preventDefault(); this.play(); });
    for (const id of ['pb-date', 'pb-time']) $('#' + id).addEventListener('input', () => this.preview());
    $('#pb-form').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]'); if (!b) return;
      const now = Date.now();
      if (b.dataset.preset === 'y15') { $('#pb-date').value = addDays(localDate(now), -1); $('#pb-time').value = '15:00:00'; }
      else { const t = now - (b.dataset.preset === 'h1' ? 3600e3 : 600e3); $('#pb-date').value = localDate(t); $('#pb-time').value = localHM(t).slice(0, 5) + ':00'; }
      this.preview();
    });
    $('#pb-prev').onclick = () => this.step(-1);
    $('#pb-next').onclick = () => this.step(1);
    $('#pb-stop').onclick = () => { this.player.stop(); this.setButtons(); $('#pb-state').textContent = 'Stopped.'; };
    $('#pb-pause').onclick = () => {
      if (this.video.paused) { this.player.userPaused = false; this.player.resume(); $('#pb-pause').textContent = 'Pause'; }
      else { this.player.userPaused = true; this.video.pause(); $('#pb-pause').textContent = 'Resume'; }
    };
  },
  enter(r) {
    document.title = 'Playback · NVR';
    const q = r.query;
    if (q.get('ch')) $('#pb-ch').value = q.get('ch');
    if (q.get('min') && $(`#pb-len option[value="${q.get('min')}"]`)) $('#pb-len').value = q.get('min');
    else if (q.get('min')) { $('#pb-len').append(h('option', { value: q.get('min') }, `${q.get('min')} min`)); $('#pb-len').value = q.get('min'); }
    if (q.get('utc')) { const t = +q.get('utc'); $('#pb-date').value = localDate(t); $('#pb-time').value = localHM(t); }
    else if (q.get('date')) { $('#pb-date').value = q.get('date'); $('#pb-time').value = q.get('time') || '12:00:00'; }
    if (!$('#pb-date').value) { $('#pb-date').value = addDays(localDate(Date.now()), -1); $('#pb-time').value = '15:00:00'; }
    this.preview();
    this.tick = setInterval(() => this.update(), 250);
    if (q.get('autoplay') === '1') this.play(q.get('utc') ? +q.get('utc') : null);
  },
  leave() { this.player.stop(); clearInterval(this.tick); },
  wake() { this.player.wake(); },
  resolveInput() {
    const [y, mo, d] = ($('#pb-date').value || '').split('-').map(Number);
    const [hh, mi, ss] = ($('#pb-time').value || '').split(':').map(Number);
    if (!y || hh == null || isNaN(hh)) return null;
    return TU.wallToUtc(y, mo, d, hh, mi || 0, ss || 0, TZ);
  },
  preview() {
    const r = this.resolveInput(); const el = $('#pb-conv');
    if (!r) { el.textContent = ''; return; }
    if (r.gap) { el.innerHTML = '<span class="note">That local time does not exist (DST spring-forward).</span>'; return; }
    el.replaceChildren(
      'Local ', h('b', {}, TU.zoneText(r.utc, TZ)), '  →  UTC ', h('b', {}, TU.utcText(r.utc)),
      '  →  NVR clock ', h('b', {}, TU.nvrText(r.utc, OFF)), ` (${TU.offsetLabel(OFF)}, no DST)`,
      r.ambiguous ? h('span', { class: 'note' }, '  · ambiguous hour (DST fall-back): using the first occurrence') : null);
  },
  async play(utcStart, minutesOverride) {
    const minutes = minutesOverride || Number($('#pb-len').value);
    const ch = Number($('#pb-ch').value);
    const body = { ch, minutes };
    if (utcStart != null) body.utcStart = utcStart;
    else { body.date = $('#pb-date').value; body.time = $('#pb-time').value; }
    this.player.stop(true);
    $('#pb-go').disabled = true;
    this.status.className = 'status'; this.status.textContent = 'Checking the recording on the NVR…';
    $('#pb-state').textContent = 'Requesting…';
    try {
      const pb = await post('/api/playback', body);
      this.pb = pb;
      $('#pb-date').value = localDate(pb.utcStart); $('#pb-time').value = localHM(pb.utcStart); this.preview();
      history.replaceState(null, '', `/playback?ch=${pb.ch}&utc=${pb.utcStart}&min=${minutes}`);
      currentKey = routeKey(route());
      this.player.start(pb.name);
      $('#pb-state').textContent = `${pb.camName}: NVR ${pb.nvrStart} → ${pb.nvrEnd.slice(11)} (${fmtDur(pb.durationSec)})` + (pb.note ? ' — ' + pb.note : '');
    } catch (e) {
      this.status.className = 'status err'; this.status.textContent = e.message;
      $('#pb-state').textContent = e.message;
    } finally { $('#pb-go').disabled = false; this.setButtons(); }
  },
  step(dir) {
    if (!this.pb) return;
    this.play(this.pb.utcStart + dir * this.pb.durationSec * 1000);
  },
  setButtons() {
    const has = !!this.pb; const on = this.player.active;
    $('#pb-prev').disabled = !has; $('#pb-next').disabled = !has || (this.pb && this.pb.utcEnd > Date.now() - 60e3);
    $('#pb-stop').disabled = !on; $('#pb-pause').disabled = !on; $('#pb-pause').textContent = 'Pause';
  },
  onState(s, msg) {
    if (s === 'connecting') { this.status.className = 'status'; this.status.textContent = 'Opening recording (disk seek)…'; }
    else if (s === 'playing') { this.status.textContent = ''; }
    else if (s === 'error') { this.status.className = 'status err'; this.status.textContent = msg || 'Playback failed'; }
    else if (s === 'streamdone' && msg) { this.status.className = 'status err'; this.status.textContent = msg; }
    this.setButtons();
  },
  update() {
    const pb = this.pb; if (!pb || !this.player.active) return;
    const el = this.player.elapsed;
    const t = pb.utcStart + el * 1000;
    $('#pb-nvr').textContent = TU.nvrText(t, OFF);
    $('#pb-local').textContent = TU.zoneText(t, TZ);
    $('#pb-bar').style.width = Math.min(100, (100 * el) / pb.durationSec) + '%';
    if (this.player.streamDone && this.player.bufferedAhead < 0.3 && this.player.base != null) {
      // Ended well short of what the NVR said it has (e.g. iOS closed the socket on screen lock): offer to
      // continue from here. Never automatic: reconnecting the same stream would restart the clip.
      const expected = Math.min(pb.durationSec, pb.recordedSec || pb.durationSec);
      if (el < expected - 5) {
        const at = pb.utcStart + Math.floor(el) * 1000;
        const min = Math.min(CFG.playbackMaxMinutes, Math.max(1, Math.ceil((pb.durationSec - el) / 60)));
        $('#pb-state').replaceChildren(`Stream interrupted at ${shortTime(at)}. `,
          h('button', { class: 'primary', onclick: () => { $('#pb-ch').value = pb.ch; this.play(at, min); } }, '▶ Resume'));
      } else $('#pb-state').textContent = `Window finished (${fmtDur(pb.durationSec)}). Use Next ▶ to continue.`;
      this.player.active = false; this.setButtons();
    }
  },
};

// ----------------------------------------------------------------- events
// client-side keyframe loader: ≤2 in flight (matches the server's worker pool), abortable
const kf = {
  q: [], active: 0, LIMIT: 2, cache: new Map(),
  get(ch, t, prio) { // -> { promise (objectURL of 1-frame mp4), cancel }
    const key = `${ch}_${t}`;
    if (this.cache.has(key)) return { promise: Promise.resolve(this.cache.get(key)), cancel() {} };
    let job = this.q.find((j) => j.key === key) || (this._running || []).find((j) => j.key === key);
    if (!job) {
      job = { key, ch, t, ctrl: new AbortController(), refs: 0 };
      job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
      job.promise.catch(() => {});
      if (prio) this.q.unshift(job); else this.q.push(job);
      this.pump();
    } else if (prio) { this.q = this.q.filter((j) => j !== job); if (!job.started) this.q.unshift(job); }
    job.refs++;
    let done = false;
    return {
      promise: job.promise,
      cancel: () => { if (done) return; done = true; if (--job.refs <= 0 && !job.started) { this.q = this.q.filter((j) => j !== job); job.rej(new Error('canceled')); } },
    };
  },
  pump() {
    this._running = this._running || [];
    while (this.active < this.LIMIT && this.q.length) {
      const job = this.q.shift(); job.started = true; this.active++; this._running.push(job);
      fetch(`/api/keyframe?ch=${job.ch}&t=${job.t}&v=2`, { signal: job.ctrl.signal })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status); return r.blob(); })
        .then((b) => { const u = URL.createObjectURL(b); this.cache.set(job.key, u); job.res(u); }, (e) => job.rej(e))
        .finally(() => { this.active--; this._running = this._running.filter((j) => j !== job); this.pump(); });
    }
  },
  clear() { for (const j of this.q) j.rej(new Error('canceled')); this.q = []; },
};
function frameToJpeg(url, w = 400) {
  return new Promise((res, rej) => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
    let fin = false;
    const done = (ok, x) => { if (fin) return; fin = true; clearTimeout(to); v.removeAttribute('src'); v.load(); ok ? res(x) : rej(x); };
    const draw = () => {
      try {
        const c = document.createElement('canvas'); c.width = w; c.height = Math.round((w * v.videoHeight) / v.videoWidth) || Math.round(w * 9 / 16);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); done(true, c.toDataURL('image/jpeg', 0.78));
      } catch (e) { done(false, e); }
    };
    v.onloadeddata = () => { v.onseeked = draw; v.currentTime = 0; setTimeout(draw, 600); };
    v.onerror = () => done(false, new Error('cannot decode'));
    const to = setTimeout(() => done(false, new Error('decode timeout')), 15000);
    v.src = url;
  });
}

views.events = {
  el: $('#view-events'),
  init() {
    for (const c of CAMS) $('#ev-ch').append(h('option', { value: c.ch }, c.name));
    const reload = () => this.load();
    $('#ev-ch').onchange = reload; $('#ev-date').onchange = reload;
    $('#ev-merge').onchange = () => this.render(); $('#ev-hours').onchange = () => this.render();
    $('#ev-prevday').onclick = () => { $('#ev-date').value = addDays($('#ev-date').value, -1); reload(); };
    $('#ev-nextday').onclick = () => { $('#ev-date').value = addDays($('#ev-date').value, 1); reload(); };
    $('#ev-prev').onclick = () => this.select(this.sel - 1);
    $('#ev-next').onclick = () => this.select(this.sel + 1);
    $('#ev-close').onclick = () => this.select(-1);
    $('#ev-play').onclick = () => this.playSel();
    $('#ev-timeline').addEventListener('click', (e) => {
      if (!this.data || !this.list.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = this.data.from + ((e.clientX - r.left) / r.width) * (this.data.to - this.data.from);
      let best = 0; let bd = Infinity;
      this.list.forEach((ev, i) => { const d = Math.abs(ev.start - t); if (d < bd) { bd = d; best = i; } });
      this.select(best);
    });
    this.io = new IntersectionObserver((ents) => {
      for (const en of ents) { const c = en.target._card; if (!c) continue; if (en.isIntersecting) c.want(); else c.unwant(); }
    }, { rootMargin: '300px' });
  },
  enter(r) {
    document.title = 'Events · NVR';
    const q = r.query;
    $('#ev-ch').value = q.get('ch') || $('#ev-ch').value || 1;
    $('#ev-date').value = q.get('date') || $('#ev-date').value || localDate(Date.now());
    this.load();
  },
  leave() { kf.clear(); this.io.disconnect(); this.select(-1); },
  async load() {
    const ch = $('#ev-ch').value; const date = $('#ev-date').value;
    history.replaceState(null, '', `/events?ch=${ch}&date=${date}`); currentKey = routeKey(route());
    $('#ev-summary').textContent = 'Searching NVR recordings…';
    $('#ev-cards').replaceChildren(); $('#ev-timeline').replaceChildren(); this.select(-1); kf.clear();
    try {
      const d = await api(`/api/events?ch=${ch}&date=${date}`);
      if ($('#ev-ch').value !== ch || $('#ev-date').value !== date) return;
      this.data = d;
      try { this.sun = CFG.timelapse.location ? await api(`/api/sun?date=${date}`) : null; } catch (_) { this.sun = null; }
      this.render();
    } catch (e) { $('#ev-summary').textContent = 'Error: ' + e.message; }
  },
  groups() {
    const gap = Number($('#ev-merge').value) * 1000; const out = [];
    for (const e of this.data.events) {
      const l = out[out.length - 1];
      if (l && gap && e.start <= l.end + gap) { l.end = Math.max(l.end, e.end); l.count++; } else out.push({ start: e.start, end: e.end, count: 1 });
    }
    const hrs = $('#ev-hours').value;
    if (hrs === 'all') return out;
    return out.filter((e) => { const hr = TU.zoneParts(e.start, TZ).h; return hrs === 'day' ? hr >= 6 && hr < 20 : hr < 6 || hr >= 20; });
  },
  render() {
    const d = this.data; if (!d) return;
    this.list = this.groups();
    const span = d.to - d.from; const pct = (t) => (((t - d.from) / span) * 100).toFixed(3) + '%';
    const tl = $('#ev-timeline'); const parts = [];
    for (let i = 0; i <= 24; i += 2) { const t = d.from + i * 3600e3; if (t <= d.to) parts.push(h('div', { class: 'tick', style: `left:${pct(t)}` }, String(TU.zoneParts(t, TZ).h).padStart(2, '0'))); }
    if (this.sun) parts.push(h('div', { class: 'sun', style: `left:${pct(this.sun.sunrise)};width:${(((this.sun.sunset - this.sun.sunrise) / span) * 100).toFixed(3)}%`, title: 'daylight' }));
    for (const [a, b] of d.recordings) parts.push(h('div', { class: 'rec', style: `left:${pct(a)};width:${(((b - a) / span) * 100).toFixed(3)}%` }));
    this.marks = this.list.map((e) => h('div', { class: 'ev', style: `left:${pct(e.start)};width:${Math.max(0.05, ((e.end - e.start) / span) * 100).toFixed(3)}%` }));
    parts.push(...this.marks);
    if (Date.now() < d.to) parts.push(h('div', { class: 'now', style: `left:${pct(Date.now())}` }));
    tl.replaceChildren(...parts);
    const covered = d.recordings.reduce((a, [x, y]) => a + (y - x), 0) / 1000;
    $('#ev-summary').textContent = `${this.list.length} motion event${this.list.length === 1 ? '' : 's'}` +
      (this.list.length !== d.events.length ? ` (${d.events.length} raw triggers)` : '') + ` · recorded ${fmtDur(covered)} of ${fmtDur(span / 1000)} · times in ${tzAbbr(d.from + 43200e3)}`;
    // cards
    this.io.disconnect(); kf.clear();
    const ch = d.ch;
    this.cards = this.list.map((e, i) => {
      const img = h('div', { class: 'img' }, h('div', { class: 'st' }, '…'));
      const card = h('div', { class: 'card', onclick: () => this.select(i) }, img,
        h('div', { class: 'meta' }, h('span', {}, shortTime(e.start)), h('span', { class: 'n' }, (e.count > 1 ? `${e.count}× · ` : '') + fmtDur((e.end - e.start) / 1000))));
      const t = this.frameTime(e);
      let handle = null; let loaded = false;
      card._card = {
        want: () => {
          if (loaded || handle) return;
          handle = kf.get(ch, t);
          handle.promise.then((u) => frameToJpeg(u)).then((jpg) => { loaded = true; img.style.backgroundImage = `url(${jpg})`; img.firstChild.textContent = ''; },
            (err) => { if (err.message !== 'canceled') { loaded = true; img.firstChild.textContent = err.message; } handle = null; });
        },
        unwant: () => { if (handle && !loaded) { handle.cancel(); handle = null; } },
      };
      this.io.observe(card);
      return card;
    });
    $('#ev-cards').replaceChildren(...this.cards);
    if (!this.list.length) $('#ev-cards').append(h('p', { class: 'muted' }, 'No motion events recorded for this day.'));
  },
  frameTime(e) { return Math.floor(Math.min(e.start + 2000, e.end) / 1000) * 1000; },
  async select(i) {
    if (this.marks) this.marks.forEach((m) => m.classList.remove('sel'));
    if (this.cards) this.cards.forEach((c) => c.classList.remove('sel'));
    if (i < 0 || !this.list || i >= this.list.length) { this.sel = -1; $('#ev-viewer').hidden = true; return; }
    this.sel = i;
    const e = this.list[i]; const ch = this.data.ch;
    $('#ev-viewer').hidden = false;
    this.marks[i].classList.add('sel'); this.cards[i].classList.add('sel');
    this.cards[i].scrollIntoView({ block: 'nearest' });
    $('#ev-big-title').textContent = `${camBy(ch).name} · ${TU.zoneText(e.start, TZ)}`;
    $('#ev-big-meta').textContent = `Event ${i + 1} of ${this.list.length} · ${fmtDur((e.end - e.start) / 1000)}${e.count > 1 ? ` · ${e.count} triggers` : ''} · NVR clock ${TU.nvrText(e.start, OFF)}`;
    $('#ev-prev').disabled = i === 0; $('#ev-next').disabled = i === this.list.length - 1;
    const st = $('#ev-big-status'); st.className = 'status'; st.textContent = 'Fetching keyframe…';
    const big = $('#ev-big');
    const want = this.frameTime(e);
    try {
      const u = await kf.get(ch, want, true).promise;
      if (this.sel !== i) return;
      big.src = u; big.currentTime = 0; st.textContent = '';
    } catch (err) { if (this.sel === i) { st.className = 'status err'; st.textContent = err.message; } }
    // prefetch the next two so arrow-key scanning is instant
    for (const k of [i + 1, i + 2]) if (this.list[k]) kf.get(ch, this.frameTime(this.list[k]), true);
  },
  playSel() {
    const e = this.list && this.list[this.sel]; if (!e) return;
    const start = e.start - 5000; const min = Math.min(CFG.playbackMaxMinutes, Math.max(1, Math.ceil((e.end - e.start + 15000) / 60000)));
    go(`/playback?ch=${this.data.ch}&utc=${start}&min=${min}&autoplay=1`);
  },
};

// ----------------------------------------------------------------- timelapse
views.timelapse = {
  el: $('#view-timelapse'),
  init() {
    $('#tl-int').value = String(CFG.timelapse.intervalSeconds); $('#tl-fps').value = String(CFG.timelapse.fps);
    $('#tl-form').addEventListener('submit', (e) => { e.preventDefault(); this.render(); });
    for (const id of ['tl-date', 'tl-int', 'tl-fps']) $('#' + id).addEventListener('change', () => this.sunInfo());
  },
  enter() {
    document.title = 'Timelapse · NVR';
    if (!$('#tl-date').value) $('#tl-date').value = addDays(localDate(Date.now()), -1);
    this.sunInfo(); this.refresh();
    this.timer = setInterval(() => this.refresh(), 2000);
  },
  leave() { clearInterval(this.timer); },
  async sunInfo() {
    const el = $('#tl-sun'); const cam = camBy(CFG.timelapse.channel);
    if (!CFG.timelapse.location) { el.innerHTML = '<span class="note">Set "location": {"lat": …, "lon": …} in config.json so sunrise/sunset can be computed.</span>'; return; }
    try {
      const s = await api(`/api/sun?date=${$('#tl-date').value}`);
      const iv = Number($('#tl-int').value); const fps = Number($('#tl-fps').value);
      const n = Math.floor((Math.min(s.end, Date.now()) - s.start) / (iv * 1000)) + 1;
      el.replaceChildren(`${cam.name} (main stream ${cam.main}) · sunrise `, h('b', {}, shortTime(s.sunrise)), ' · sunset ', h('b', {}, shortTime(s.sunset)),
        ` → frames ${shortTime(s.start)}–${shortTime(s.end)} (${CFG.timelapse.marginMinutes} min margin): ≈${Math.max(0, n)} frames, ` +
        `≈${fmtDur(Math.max(0, n) * 0.9 / 2)} to fetch from the NVR, ${fmtDur(Math.max(0, n) / fps)} video.`,
        CFG.timelapse.location.approximate ? h('span', { class: 'note' }, ' · location in config.json is approximate — set your lat/lon for exact sun times') : null);
    } catch (e) { el.textContent = e.message; }
  },
  async render() {
    $('#tl-go').disabled = true;
    try { await post('/api/timelapse', { date: $('#tl-date').value, intervalSeconds: Number($('#tl-int').value), fps: Number($('#tl-fps').value) }); this.refresh(); }
    catch (e) { alert(e.message); } finally { $('#tl-go').disabled = false; }
  },
  async refresh() {
    let d; try { d = await api('/api/timelapse'); } catch (_) { return; }
    const jobs = d.jobs.filter((j) => j.state !== 'done' || Date.now() - (j.finishedAt || 0) < 60e3);
    $('#tl-jobs').replaceChildren(...jobs.map((j) => {
      const pctv = j.total ? Math.round((100 * (j.done + j.failed)) / j.total) : 100;
      const running = ['queued', 'running', 'assembling'].includes(j.state);
      return h('div', { class: 'panel job' },
        h('div', { class: 'row' }, h('b', {}, `${j.date} · every ${j.interval}s`),
          h('span', { class: 'muted' }, `${j.state}${j.total ? ` · ${j.done}/${j.total} frames` : ''}${j.failed ? ` · ${j.failed} missing` : ''}${j.msg ? ' · ' + j.msg : ''}`),
          running ? h('button', { onclick: () => post('/api/timelapse/cancel', { id: j.id }).then(() => this.refresh()) }, 'Cancel') : null),
        h('div', { class: 'progress' }, h('div', { style: `width:${pctv}%` })));
    }));
    const sig = d.files.map((f) => f.file + f.bytes).join('|');
    if (sig === this.sig) return; this.sig = sig;
    $('#tl-files').replaceChildren(...(d.files.length ? d.files.map((f) => h('div', { class: 'panel' },
      h('div', { class: 'row' }, h('b', {}, `${f.date || f.file}`), ' ',
        h('span', { class: 'muted' }, f.frames ? `${f.frames} frames · every ${f.interval}s · ${f.fps} fps · ${f.width}×${f.height} · ${(f.bytes / 1e6).toFixed(0)} MB${f.truncated ? ' · partial day' : ''}` : '')),
      f.start ? h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, `${shortTime(f.start)} → ${shortTime(f.end)} (sunrise ${shortTime(f.sunrise)}, sunset ${shortTime(f.sunset)})`) : null,
      h('video', { controls: true, preload: 'metadata', muted: true, playsinline: true, src: f.url }),
      h('div', { style: 'margin-top:6px' }, h('a', { href: f.url, download: f.file }, 'Download MP4')))) : [h('p', { class: 'muted' }, 'None yet.')]));
  },
};

// ===================================================================== router
function route() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(location.search);
  let m;
  if (p === '/' || p === '/front') return { view: 'single', ch: 1, nav: 'front', query }; // home = front camera
  if (p === '/all' || p === '/live') return { view: 'grid', nav: 'grid', query };
  if ((m = /^\/cam\/(\d+)$/.exec(p))) return { view: 'single', ch: +m[1], nav: +m[1] === 1 ? 'front' : 'grid', query };
  if (['/playback', '/events', '/timelapse'].includes(p)) return { view: p.slice(1), nav: p.slice(1), query };
  return { view: 'single', ch: 1, nav: 'front', query };
}
const routeKey = (r) => r.view + ':' + (r.ch || '') + ':' + r.query.toString();
function go(url) { history.pushState(null, '', url); render(); }
function render(force) {
  const r = route(); const key = routeKey(r);
  if (!force && key === currentKey) return;
  if (current) { current.leave(); current.el.hidden = true; }
  currentKey = key; current = views[r.view];
  current.el.hidden = false;
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.nav));
  current.enter(r);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); go(a.getAttribute('href')); }
});
window.addEventListener('popstate', () => render());
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea')) return;
  const r = route();
  if (r.view === 'events' && views.events.sel >= 0) {
    if (e.key === 'ArrowRight') { e.preventDefault(); views.events.select(views.events.sel + 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); views.events.select(views.events.sel - 1); return; }
    if (e.key === 'Enter') { views.events.playSel(); return; }
    if (e.key === 'Escape') { views.events.select(-1); return; }
  }
  if (r.view === 'events' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && views.events.list && views.events.list.length) { views.events.select(0); return; }
  if (/^[1-9]$/.test(e.key) && camBy(e.key) && (r.view === 'grid' || r.view === 'single')) go(`/cam/${e.key}`);
  if (e.key === 'Escape' && r.view === 'single') go('/all');
});

// Background tabs release their NVR sessions (live only; playback keeps going so the clip isn't restarted).
let hiddenTimer = null; let pausedByHide = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenTimer = setTimeout(() => { if (current && (current === views.grid || current === views.single)) { current.leave(); pausedByHide = true; } }, 20000);
  } else onShown();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) onShown(); }); // restored from the back/forward cache
function onShown() {
  shownAt = Date.now();
  clearTimeout(hiddenTimer);
  if (pausedByHide) { pausedByHide = false; current.enter(route()); } else if (current && current.wake) current.wake();
  pollSessions(); pollStatus();
}

// ===================================================================== header: clocks, sessions, status
let skew = 0;
function tickClocks() {
  const now = Date.now() + skew;
  $('#clk-local').textContent = TU.zoneText(now, TZ).replace(/^\w+, /, '');
  $('#clk-nvr').textContent = `NVR ${TU.nvrText(now, OFF).slice(11)} (${TU.offsetLabel(OFF)})`;
}
async function pollSessions() {
  if (document.hidden) return;
  try {
    const s = await api('/api/sessions');
    const el = $('#sessions');
    el.textContent = `NVR ${s.used}/${s.max}`;
    el.classList.toggle('full', s.used >= s.max);
    el.title = 'RTSP sessions open to the NVR (shared by all viewers)\n' +
      (s.streams.map((x) => `• ${x.label} — ${x.viewers} viewer${x.viewers > 1 ? 's' : ''}`).concat(s.other.map((x) => `• ${x}`)).join('\n') || '• none');
  } catch (_) { /* */ }
}
async function pollStatus() {
  if (document.hidden) return;
  const b = $('#banner');
  try {
    const s = await api('/api/status');
    if (s.breaker) { b.className = 'banner'; b.textContent = `NVR login disabled to avoid an account lockout: ${s.breaker}. Fix config.json and restart the service.`; b.hidden = false; }
    else if (!s.go2rtc) { b.className = 'banner warn'; b.textContent = 'Streaming gateway (go2rtc) is not running — restarting…'; b.hidden = false; }
    else if (s.ok === null && s.error) { b.className = 'banner warn'; b.textContent = `NVR not reachable: ${s.error}`; b.hidden = false; }
    else if (s.clock && s.clock.driftSec != null && Math.abs(s.clock.driftSec) > 120) {
      b.className = 'banner warn'; b.hidden = false;
      b.textContent = `NVR clock reads ${s.clock.nvrTime}, which is ${s.clock.driftSec}s off the configured ${TU.offsetLabel(OFF)} — playback times may be shifted.`;
    } else b.hidden = true;
    if (s.device) $('#clk-nvr').title = `${s.device.type} · serial ${s.device.serial} · fw ${s.device.version}\nNVR clock at last check: ${s.clock ? s.clock.nvrTime + ` (drift ${s.clock.driftSec}s)` : '?'}`;
  } catch (_) { /* */ }
}

// ===================================================================== boot
(async function boot() {
  CFG = await api('/api/config');
  TZ = CFG.timeZone; OFF = CFG.nvrUtcOffsetMinutes; CAMS = CFG.cameras;
  skew = CFG.serverNow - Date.now(); if (Math.abs(skew) < 2000) skew = 0;
  if (new URLSearchParams(location.search).get('kiosk') === '1') document.body.classList.add('kiosk');
  for (const v of Object.values(views)) if (v.init) v.init();
  tickClocks(); setInterval(tickClocks, 1000);
  pollSessions(); setInterval(pollSessions, 3000);
  pollStatus(); setInterval(pollStatus, 5 * 60e3);
  render(true);
})().catch((e) => { document.body.prepend(h('div', { class: 'banner' }, 'Failed to start: ' + e.message)); });
