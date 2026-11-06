// Time helpers shared by the browser UI and the Node server (UMD).
//
// Clock model:
//   - Everything is converted through UTC epoch milliseconds.
//   - The NVR clock is a FIXED offset from UTC (config nvr.utcOffsetMinutes, -360 = UTC-6, no DST).
//   - The display zone (e.g. America/Los_Angeles) is handled by Intl, so DST is never hardcoded.
(function (root) {
  'use strict';
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const cache = {};

  function dtf(tz) {
    if (!cache[tz]) {
      cache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
    return cache[tz];
  }

  // Wall-clock fields of an instant in a named zone.
  function zoneParts(ms, tz) {
    const o = {};
    for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }

  // Offset (minutes, east positive) of a named zone at an instant. PST = -480, PDT = -420.
  function zoneOffsetMin(ms, tz) {
    const p = zoneParts(ms, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }

  // Wall-clock time in a named zone -> UTC ms.
  // Returns { utc, alt, ambiguous, gap }: during the fall-back hour two instants match
  // (utc = first occurrence, alt = second); during the spring-forward gap none do.
  function wallToUtc(y, mo, d, h, mi, s, tz) {
    const wall = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    const offs = new Set([-14, -2, 0, 2, 14].map((k) => zoneOffsetMin(wall + k * 3600e3, tz)));
    const hits = [];
    for (const o of offs) {
      const u = wall - o * 60000;
      if (zoneOffsetMin(u, tz) === o && !hits.includes(u)) hits.push(u);
    }
    hits.sort((a, b) => a - b);
    return { utc: hits.length ? hits[0] : null, alt: hits.length > 1 ? hits[1] : null, ambiguous: hits.length > 1, gap: hits.length === 0 };
  }

  function nvrFields(ms, offMin) {
    const d = new Date(ms + offMin * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  // UTC ms -> NVR RTSP token YYYY_MM_DD_HH_MM_SS
  function nvrToken(ms, offMin) {
    const f = nvrFields(ms, offMin);
    return `${f.y}_${pad(f.mo)}_${pad(f.d)}_${pad(f.h)}_${pad(f.mi)}_${pad(f.s)}`;
  }
  // UTC ms -> "YYYY-MM-DD HH:MM:SS" on the NVR clock (matches the OSD overlay)
  function nvrText(ms, offMin) {
    const f = nvrFields(ms, offMin);
    return `${f.y}-${pad(f.mo)}-${pad(f.d)} ${pad(f.h)}:${pad(f.mi)}:${pad(f.s)}`;
  }
  // "2026-11-06 13:35:32" (NVR clock) -> UTC ms
  function nvrTextToUtc(text, offMin) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
    if (!m) return null;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offMin * 60000;
  }
  function utcText(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
  const longFmt = {};
  function zoneText(ms, tz) {
    if (!longFmt[tz]) {
      longFmt[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
      });
    }
    return longFmt[tz].format(new Date(ms));
  }
  function offsetLabel(offMin) {
    const sign = offMin < 0 ? '−' : '+';
    const a = Math.abs(offMin);
    return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + pad(a % 60) : ''}`;
  }

  const api = { pad, zoneParts, zoneOffsetMin, wallToUtc, nvrToken, nvrText, nvrTextToUtc, utcText, zoneText, offsetLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimeUtil = api;
})(typeof self !== 'undefined' ? self : this);
