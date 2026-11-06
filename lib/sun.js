'use strict';
// Sunrise/sunset (standard "sunrise equation", ±1-2 min accuracy — plenty for a timelapse window).
const rad = Math.PI / 180;
const sin = (d) => Math.sin(d * rad);
const cos = (d) => Math.cos(d * rad);

// y/mo/d = local calendar date; lat/lon in degrees (lon east positive, so California is negative).
// Returns { sunrise, sunset, noon } as UTC ms, or null fields for polar day/night.
function sunTimes(y, mo, d, lat, lon) {
  const J = Date.UTC(y, mo - 1, d, 12) / 86400000 + 2440587.5;
  const n = Math.round(J - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const decl = Math.asin(sin(L) * sin(23.4397)) / rad;
  const cosw = (sin(-0.833) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl));
  const toMs = (jd) => Math.round((jd - 2440587.5) * 86400000);
  if (cosw < -1 || cosw > 1) return { sunrise: null, sunset: null, noon: toMs(Jtransit) };
  const w = Math.acos(cosw) / rad;
  return { sunrise: toMs(Jtransit - w / 360), sunset: toMs(Jtransit + w / 360), noon: toMs(Jtransit) };
}

module.exports = { sunTimes };
