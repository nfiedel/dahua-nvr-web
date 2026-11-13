// Fix the stored picture size in a fragmented-MP4 init segment (UMD: browser UI + Node tests).
//
// go2rtc 1.9.9 writes 1920x1080 into the avc1 sample entry of every H.264 stream, whatever the SPS
// says (here: 352x240 substreams, 960x480 main streams). Chrome/Firefox take the real size from the
// SPS and the display size from tkhd, so they don't care. iOS Safari sizes its video surface from the
// sample entry and draws the real picture into its top-left corner on a green (empty YUV) background.
//
// fixInit() rewrites, in place and without changing any box size:
//   - avc1 width/height  -> the cropped picture size decoded from the SPS in avcC
//   - pasp (if present)  -> the pixel aspect that maps that size back onto tkhd's display size, so a
//                           browser that derives display size from avc1 x pasp shows the same shape
//                           as one that uses tkhd (i.e. what desktop browsers show today).
// Anything unexpected (not an init segment, other codec, parse error) returns null and leaves the
// bytes untouched.
(function (root) {
  'use strict';

  function boxes(u8, start, end) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, end: o + size, data: o + hdr });
      o += size;
    }
    return out;
  }
  const child = (u8, b, type) => boxes(u8, b.data, b.end).find((x) => x.type === type);

  // H.264 SPS (NAL incl. 1-byte header) -> { width, height } after frame cropping.
  function parseSps(nal) {
    const b = [];
    for (let i = 0; i < nal.length; i++) { // strip emulation-prevention bytes (00 00 03)
      if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      b.push(nal[i]);
    }
    let pos = 8;
    const bit = () => { if (pos >> 3 >= b.length) throw new Error('SPS truncated'); return (b[pos >> 3] >> (7 - (pos++ & 7))) & 1; };
    const u = (n) => { let v = 0; while (n--) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit()) { if (++z > 31) throw new Error('bad exp-golomb'); } return 2 ** z - 1 + u(z); };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    const profile = u(8); u(16); ue(); // profile_idc, constraint flags + level_idc, sps id
    let chroma = 1; let separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma === 3) separate = u(1);
      ue(); ue(); u(1); // bit depths, qpprime_y_zero_transform_bypass
      if (u(1)) { // seq_scaling_matrix_present
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (!u(1)) continue;
          let last = 8; let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
        }
      }
    }
    ue(); // log2_max_frame_num
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); u(1); // max_num_ref_frames, gaps_in_frame_num_allowed
    const wMbs = ue() + 1; const hMapUnits = ue() + 1;
    const frameMbsOnly = u(1); if (!frameMbsOnly) u(1);
    u(1); // direct_8x8_inference
    let cl = 0; let cr = 0; let ct = 0; let cb = 0;
    if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
    const arrayType = separate ? 0 : chroma;
    const cx = arrayType === 1 || arrayType === 2 ? 2 : 1;
    const cy = (arrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = wMbs * 16 - cx * (cl + cr);
    const height = (2 - frameMbsOnly) * hMapUnits * 16 - cy * (ct + cb);
    if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) throw new Error('implausible SPS size');
    return { width, height };
  }

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  // Patches u8 in place. Returns [{ from: [w,h], to: [w,h], pasp }] for each changed track, [] if
  // nothing needed changing, or null if this isn't an init segment we understand.
  function fixInit(u8) {
    try {
      const moov = boxes(u8, 0, u8.length).find((b) => b.type === 'moov');
      if (!moov) return null;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const changes = [];
      for (const trak of boxes(u8, moov.data, moov.end).filter((b) => b.type === 'trak')) {
        const tkhd = child(u8, trak, 'tkhd');
        const mdia = child(u8, trak, 'mdia'); const minf = mdia && child(u8, mdia, 'minf');
        const stbl = minf && child(u8, minf, 'stbl'); const stsd = stbl && child(u8, stbl, 'stsd');
        if (!stsd) continue;
        for (const e of boxes(u8, stsd.data + 8, stsd.end)) {
          if (e.type !== 'avc1' && e.type !== 'avc3') continue;
          const kids = boxes(u8, e.data + 78, e.end); // VisualSampleEntry fields are 78 bytes
          const avcC = kids.find((k) => k.type === 'avcC');
          if (!avcC || (u8[avcC.data + 5] & 0x1f) < 1) continue;
          const spsLen = dv.getUint16(avcC.data + 6);
          const sps = parseSps(u8.subarray(avcC.data + 8, avcC.data + 8 + spsLen));
          const ow = dv.getUint16(e.data + 24); const oh = dv.getUint16(e.data + 26);
          if (ow === sps.width && oh === sps.height) continue;
          dv.setUint16(e.data + 24, sps.width); dv.setUint16(e.data + 26, sps.height);
          const ch = { from: [ow, oh], to: [sps.width, sps.height], pasp: null };
          const pasp = kids.find((k) => k.type === 'pasp');
          if (pasp && tkhd && pasp.end - pasp.data >= 8) {
            const o = tkhd.data + (u8[tkhd.data] === 1 ? 88 : 76);
            const dw = dv.getUint32(o) / 65536; const dh = dv.getUint32(o + 4) / 65536;
            if (dw > 0 && dh > 0) { // pixel aspect h:v such that width*h/v : height == dw : dh
              let h = Math.round(dw * sps.height); let v = Math.round(dh * sps.width);
              const g = gcd(h, v); h /= g; v /= g;
              if (h > 0 && v > 0 && h < 2 ** 32 && v < 2 ** 32) { dv.setUint32(pasp.data, h); dv.setUint32(pasp.data + 4, v); ch.pasp = [h, v]; }
            }
          }
          changes.push(ch);
        }
      }
      return changes;
    } catch (_) { return null; }
  }

  const api = { fixInit, parseSps };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Mp4Init = api;
})(typeof self !== 'undefined' ? self : this);
