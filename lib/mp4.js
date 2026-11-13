'use strict';
// Minimal MP4 tooling (no ffmpeg needed):
//  - parseFrame(): pull the H.264 keyframe sample + sample description out of go2rtc's /api/frame.mp4 (fMP4)
//  - buildMp4(): write a progressive (moov-first) MP4 from a list of keyframes. Every sample is an IDR, so
//    a timelapse is just a remux: no decoding/encoding, near-zero CPU.
const fs = require('fs');
const { fixInit } = require('../public/mp4init.js');

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o, end: o + size, data: o + hdr });
    o += size;
  }
  return out;
}

function find(buf, pathStr, start = 0, end = buf.length) {
  let box = null;
  for (const t of pathStr.split('/')) {
    box = boxes(buf, start, end).find((b) => b.type === t);
    if (!box) return null;
    start = box.data; end = box.end;
  }
  return box;
}

function parseFrame(buf) {
  const moov = find(buf, 'moov');
  if (!moov) throw new Error('no moov');
  // first video track
  let trak = null;
  for (const b of boxes(buf, moov.data, moov.end)) {
    if (b.type !== 'trak') continue;
    const hdlr = find(buf, 'mdia/hdlr', b.data, b.end);
    if (hdlr && buf.toString('latin1', hdlr.data + 8, hdlr.data + 12) === 'vide') { trak = b; break; }
  }
  if (!trak) throw new Error('no video track');
  const tkhd = find(buf, 'tkhd', trak.data, trak.end);
  const trackId = buf.readUInt32BE(tkhd.data + (buf[tkhd.data] === 1 ? 20 : 12));
  const mdhd = find(buf, 'mdia/mdhd', trak.data, trak.end);
  const timescale = buf.readUInt32BE(mdhd.data + (buf[mdhd.data] === 1 ? 20 : 12));
  const stsd = find(buf, 'mdia/minf/stbl/stsd', trak.data, trak.end);
  const entry = boxes(buf, stsd.data + 8, stsd.end)[0];
  if (!entry) throw new Error('empty stsd');
  const codec = entry.type;
  const width = buf.readUInt16BE(entry.data + 24);
  const height = buf.readUInt16BE(entry.data + 26);

  const samples = [];
  const top = boxes(buf);
  for (let i = 0; i < top.length; i++) {
    const moof = top[i];
    if (moof.type !== 'moof') continue;
    const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
    for (const traf of boxes(buf, moof.data, moof.end).filter((b) => b.type === 'traf')) {
      const tfhd = find(buf, 'tfhd', traf.data, traf.end);
      const tfFlags = buf.readUInt32BE(tfhd.data) & 0xffffff;
      if (buf.readUInt32BE(tfhd.data + 4) !== trackId) continue;
      let p = tfhd.data + 8;
      let base = moof.start;
      if (tfFlags & 0x1) { base = Number(buf.readBigUInt64BE(p)); p += 8; }
      if (tfFlags & 0x2) p += 4;
      if (tfFlags & 0x8) p += 4;
      const defSize = tfFlags & 0x10 ? buf.readUInt32BE(p) : 0;
      for (const trun of boxes(buf, traf.data, traf.end).filter((b) => b.type === 'trun')) {
        const fl = buf.readUInt32BE(trun.data) & 0xffffff;
        const count = buf.readUInt32BE(trun.data + 4);
        let q = trun.data + 8;
        let off = mdat ? mdat.data : 0;
        if (fl & 0x1) { off = base + buf.readInt32BE(q); q += 4; }
        if (fl & 0x4) q += 4;
        for (let k = 0; k < count; k++) {
          if (fl & 0x100) q += 4;
          let size = defSize;
          if (fl & 0x200) { size = buf.readUInt32BE(q); q += 4; }
          if (fl & 0x400) q += 4;
          if (fl & 0x800) q += 4;
          if (!size && count === 1 && mdat) size = mdat.end - off;
          samples.push(buf.subarray(off, off + size));
          off += size;
        }
      }
    }
  }
  if (!samples.length) { // progressive MP4 (e.g. our own output): stsz + stco
    const stsz = find(buf, 'mdia/minf/stbl/stsz', trak.data, trak.end);
    const stco = find(buf, 'mdia/minf/stbl/stco', trak.data, trak.end);
    if (stsz && stco) {
      const fixed = buf.readUInt32BE(stsz.data + 4); const n = buf.readUInt32BE(stsz.data + 8);
      let off = buf.readUInt32BE(stco.data + 8);
      for (let k = 0; k < n; k++) {
        const size = fixed || buf.readUInt32BE(stsz.data + 12 + 4 * k);
        samples.push(buf.subarray(off, off + size)); off += size;
      }
    }
  }
  if (!samples.length) throw new Error('no samples');
  return { codec, width, height, timescale, stsd: buf.subarray(stsd.start, stsd.end), sample: samples[0] };
}

// ---- writer ----
const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const zeros = (n) => Buffer.alloc(n);
function box(type, ...parts) {
  const body = Buffer.concat(parts.flat());
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const full = (type, ver, flags, ...parts) => box(type, u32(((ver & 0xff) << 24) | (flags & 0xffffff)), ...parts);
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

// frames: [{ size, stsd(Buffer), width, height }] in order; returns header Buffer (ftyp+moov+mdat header)
function buildHeader({ stsd, width, height, sizes, fps }) {
  const timescale = 90000;
  const dur = Math.round(timescale / fps);
  const n = sizes.length;
  const totalDur = dur * n;
  const durMs = Math.round((totalDur / timescale) * 1000);
  const mk = (chunkOffset) => {
    const stbl = box('stbl', stsd,
      full('stts', 0, 0, u32(1), u32(n), u32(dur)),
      full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), sizes.map(u32)),
      full('stco', 0, 0, u32(1), u32(chunkOffset)));
    const minf = box('minf', full('vmhd', 0, 1, zeros(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(totalDur), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), Buffer.from('vide'), zeros(12), Buffer.from('VideoHandler\0')),
      minf);
    const trak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
      mdia);
    const moov = box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)),
      trak);
    return moov;
  };
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
  const mdatSize = 8 + sizes.reduce((a, b) => a + b, 0);
  const moov0 = mk(0);
  const offset = ftyp.length + moov0.length + 8;
  const moov = mk(offset);
  const out = Buffer.concat([ftyp, moov, u32(mdatSize), Buffer.from('mdat')]);
  fixInit(out); // go2rtc's stsd says 1920x1080 whatever the SPS says; iOS sizes its surface from it
  return out;
}

// Single keyframe -> tiny progressive MP4 any browser <video> can show.
function singleFrameMp4(frameBuf) {
  const f = parseFrame(frameBuf);
  const head = buildHeader({ stsd: f.stsd, width: f.width, height: f.height, sizes: [f.sample.length], fps: 1 });
  return Buffer.concat([head, f.sample]);
}

// Many cached keyframe files -> timelapse MP4 at `outPath`. Frames whose sample description differs
// from the first (e.g. resolution change) are skipped. Returns { frames, skipped }.
function writeTimelapse(framePaths, outPath, fps) {
  let ref = null; const keep = []; let skipped = 0;
  for (const p of framePaths) {
    try {
      const f = parseFrame(fs.readFileSync(p));
      if (!ref) ref = f;
      if (f.stsd.equals(ref.stsd)) keep.push({ p, size: f.sample.length }); else skipped++;
    } catch (_) { skipped++; }
  }
  if (!keep.length) throw new Error('no usable frames');
  const head = buildHeader({ stsd: ref.stsd, width: ref.width, height: ref.height, sizes: keep.map((k) => k.size), fps });
  const tmp = outPath + '.part';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, head);
    for (const k of keep) fs.writeSync(fd, parseFrame(fs.readFileSync(k.p)).sample);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, outPath);
  return { frames: keep.length, skipped, width: ref.width, height: ref.height };
}

module.exports = { parseFrame, singleFrameMp4, writeTimelapse, boxes, find };
