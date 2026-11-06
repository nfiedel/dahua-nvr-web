'use strict';
// Read-only NVR client: HTTP digest GET, RTSP DESCRIBE probe, JSON-RPC (login quirks), media file search.
// Nothing here ever sends a config write to the NVR.
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const MD5 = (s) => md5(s).toUpperCase();

class AuthBreaker {
  // Trips after an unambiguous wrong-password result so we never walk into the ~10-try lockout.
  constructor() { this.tripped = false; this.reason = ''; this.httpFails = 0; }
  trip(reason) { if (!this.tripped) { this.tripped = true; this.reason = reason; console.error('[nvr] AUTH BREAKER TRIPPED:', reason); } }
}

function parseDigest(value) {
  const vals = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  for (const v of vals) {
    const m = /digest\s+(.*)$/i.exec(v);
    if (!m) continue;
    const o = {};
    m[1].replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, a, b) => { o[k.toLowerCase()] = a !== undefined ? a : b; });
    if (o.nonce) return o;
  }
  return null;
}

class NvrClient {
  constructor(cfg) {
    this.host = cfg.host;
    this.httpPort = cfg.httpPort || 80;
    this.rtspPort = cfg.rtspPort || 554;
    this.user = cfg.user;
    this.password = cfg.password;
    this.breaker = new AuthBreaker();
    this.nc = 0;
  }

  digestHeader(method, uri, ch) {
    const ha1 = md5(`${this.user}:${ch.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    let resp; let extra = '';
    if (ch.qop && /\bauth\b/.test(ch.qop)) {
      const nc = (++this.nc).toString(16).padStart(8, '0');
      const cn = crypto.randomBytes(8).toString('hex');
      resp = md5(`${ha1}:${ch.nonce}:${nc}:${cn}:auth:${ha2}`);
      extra = `, qop=auth, nc=${nc}, cnonce="${cn}"`;
    } else {
      resp = md5(`${ha1}:${ch.nonce}:${ha2}`);
    }
    return `Digest username="${this.user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${resp}"` +
      (ch.opaque ? `, opaque="${ch.opaque}"` : '') + extra;
  }

  _get(path, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: this.host, port: this.httpPort, path, method: 'GET', headers, timeout: timeoutMs || 10000 }, (x) => {
        const chunks = [];
        x.on('data', (c) => chunks.push(c));
        x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, body: Buffer.concat(chunks) }));
        x.on('error', reject);
      });
      r.on('timeout', () => r.destroy(new Error('NVR HTTP timeout')));
      r.on('error', reject);
      r.end();
    });
  }

  // GET with HTTP digest auth (Basic is rejected by this firmware).
  async digestGet(path, timeoutMs) {
    if (this.breaker.tripped) throw new Error('NVR auth disabled: ' + this.breaker.reason);
    let r = await this._get(path, {}, timeoutMs);
    if (r.status !== 401) return r;
    const ch = parseDigest(r.headers['www-authenticate']);
    if (!ch) return r;
    r = await this._get(path, { Authorization: this.digestHeader('GET', path, ch) }, timeoutMs);
    if (r.status === 401) {
      if (++this.breaker.httpFails >= 2) this.breaker.trip('HTTP digest rejected twice (wrong user/password?)');
    } else this.breaker.httpFails = 0;
    return r;
  }

  // RTSP DESCRIBE only (no SETUP/PLAY): checks a playback window exists, returns SDP.
  rtspDescribe(pathQuery, timeoutMs = 12000) {
    if (this.breaker.tripped) return Promise.reject(new Error('NVR auth disabled: ' + this.breaker.reason));
    return new Promise((resolve, reject) => {
      const url = `rtsp://${this.host}:${this.rtspPort}${pathQuery}`;
      const s = net.connect(this.rtspPort, this.host);
      let buf = Buffer.alloc(0); let cseq = 0; let authTried = false; let done = false;
      const finish = (err, val) => {
        if (done) return; done = true; clearTimeout(timer); s.destroy();
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => finish(new Error('NVR RTSP timeout')), timeoutMs);
      const send = (auth) => {
        cseq++;
        s.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: nvr-viewer\r\n` +
          (auth ? `Authorization: ${auth}\r\n` : '') + '\r\n');
      };
      s.on('connect', () => send());
      s.on('error', (e) => finish(e));
      s.on('close', () => finish(new Error('NVR closed RTSP connection')));
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          const head = buf.slice(0, i).toString();
          const m = /content-length:\s*(\d+)/i.exec(head);
          const len = m ? +m[1] : 0;
          if (buf.length < i + 4 + len) return;
          const body = buf.slice(i + 4, i + 4 + len).toString();
          buf = buf.slice(i + 4 + len);
          const status = +(head.split(' ')[1] || 0);
          if (status === 401 && !authTried) {
            authTried = true;
            const ch = parseDigest(head.split('\r\n').filter((l) => /^www-authenticate:/i.test(l)));
            if (!ch) return finish(null, { status, head, body });
            send(this.digestHeader('DESCRIBE', url, ch));
            continue;
          }
          return finish(null, { status, head, body });
        }
      });
    });
  }

  // ---------------- JSON-RPC ----------------
  _rpcPost(path, obj, cookie) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(obj);
      const r = http.request({
        host: this.host, port: this.httpPort, path, method: 'POST', timeout: 10000,
        headers: { 'X-Request': 'JSON', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}) },
      }, (x) => {
        let b = '';
        x.on('data', (c) => (b += c));
        x.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('RPC bad JSON: ' + b.slice(0, 120))); } });
      });
      r.on('timeout', () => r.destroy(new Error('RPC timeout')));
      r.on('error', reject);
      r.end(data);
    });
  }

  // Exactly the quirky legacy login. One attempt; a password rejection trips the breaker.
  async rpcLogin() {
    if (this.breaker.tripped) throw new Error('NVR auth disabled: ' + this.breaker.reason);
    const clientType = 'Dahua3.0-Web3.0';
    const r1 = await this._rpcPost('/RPC2_Login', { method: 'global.login', params: { userName: this.user, password: '', clientType }, id: 1 });
    const p = r1.params || {};
    if (!p.random || !p.realm) throw new Error('RPC login step 1 unexpected: ' + JSON.stringify(r1).slice(0, 200));
    const g = MD5(`${this.user}:${p.realm}:${this.password}`);
    const auth = MD5(`${this.user}:${p.random}:${g}`);
    const r2 = await this._rpcPost('/RPC2_Login', {
      method: 'global.login', session: r1.session,
      params: { userName: this.user, password: auth, clientType, authorityType: 'Default', passwordType: 'Default' }, id: 2,
    });
    if (r2.result !== true) {
      this.breaker.trip('RPC login rejected: ' + JSON.stringify(r2.error || r2).slice(0, 160));
      throw new Error('RPC login rejected');
    }
    const session = r2.session || r1.session;
    const serial = String(p.realm).replace(/^Login to\s*/, '');
    return { session, serial, cookie: 'DhWebClientSessionID=' + session };
  }

  async rpcCall(sess, method, params = null) {
    return this._rpcPost('/RPC2', { method, params, session: sess.session, id: Math.floor(Math.random() * 1e6) }, sess.cookie);
  }

  async rpcLogout(sess) {
    try { await this.rpcCall(sess, 'global.logout'); } catch (_) { /* ignore */ }
  }
}

module.exports = { NvrClient, parseDigest };
