import net from 'net';
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import { URL } from 'url';
import netPing from 'net-ping';

const HOST_PATTERN = /^[a-zA-Z0-9.-]+$/;
const SHELL_METACHAR = /[;&|`$(){}[\]<>'"\n\r\\]/;

export function assertPingHost(host) {
  const h = String(host || '').trim();
  if (!h || h.length > 253) throw new Error('유효하지 않은 호스트입니다.');
  if (SHELL_METACHAR.test(h)) throw new Error('허용되지 않는 문자가 포함되어 있습니다.');
  if (/^[0-9.]+$/.test(h)) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) throw new Error('유효하지 않은 IPv4입니다.');
    return h;
  }
  if (/^[0-9a-fA-F:]+$/.test(h) && h.includes(':')) return h;
  if (!HOST_PATTERN.test(h)) throw new Error('유효하지 않은 호스트명입니다.');
  return h;
}

export function assertTcpHost(host) {
  const h = String(host || '').trim();
  if (!h || h.length > 253) throw new Error('유효하지 않은 호스트입니다.');
  if (SHELL_METACHAR.test(h)) throw new Error('허용되지 않는 문자가 포함되어 있습니다.');
  return h;
}

let v4Session = null;
let v6Session = null;

function getSession(family) {
  if (family === 6) {
    if (!v6Session) {
      v6Session = netPing.createSession({
        networkProtocol: netPing.NetworkProtocol.IPv6,
        packetSize: 16,
        retries: 0,
        timeout: 3000,
      });
      v6Session.on('error', () => {});
    }
    return v6Session;
  }
  if (!v4Session) {
    v4Session = netPing.createSession({
      networkProtocol: netPing.NetworkProtocol.IPv4,
      packetSize: 16,
      retries: 0,
      timeout: 3000,
    });
    v4Session.on('error', () => {});
  }
  return v4Session;
}

async function resolveTarget(host) {
  if (net.isIP(host)) return { address: host, family: net.isIP(host) };
  try {
    const result = await dns.lookup(host, { verbatim: true });
    return { address: result.address, family: result.family };
  } catch (err) {
    const e = new Error(`DNS 조회 실패: ${err.code || err.message}`);
    e.code = 'EDNS';
    throw e;
  }
}

function pingOnce(session, address) {
  return new Promise((resolve) => {
    session.pingHost(address, (error, target, sent, rcvd) => {
      const latencyMs = sent && rcvd ? rcvd - sent : null;
      if (error) {
        resolve({
          ok: false,
          target,
          latencyMs,
          error: error.code || error.constructor?.name || error.toString(),
        });
        return;
      }
      resolve({ ok: true, target, latencyMs });
    });
  });
}

export async function runPing(host, options = {}) {
  const count = Math.min(Math.max(Number(options.count) || 1, 1), 10);
  const safeHost = assertPingHost(host);

  let target;
  try {
    target = await resolveTarget(safeHost);
  } catch (err) {
    return {
      ok: false,
      method: 'icmp-raw',
      host: safeHost,
      error: err.message,
    };
  }

  let session;
  try {
    session = getSession(target.family);
  } catch (err) {
    return {
      ok: false,
      method: 'icmp-raw',
      host: safeHost,
      address: target.address,
      error: err.code || err.message,
      hint:
        'raw 소켓 생성 실패. 컨테이너에 NET_RAW 권한이 필요합니다. 예: docker run --cap-add=NET_RAW ...',
    };
  }

  const attempts = [];
  for (let i = 0; i < count; i++) {
    const r = await pingOnce(session, target.address);
    attempts.push({
      seq: i + 1,
      ok: r.ok,
      latencyMs: r.latencyMs,
      error: r.ok ? undefined : r.error,
    });
  }

  const succeeded = attempts.filter((a) => a.ok);
  const latencies = succeeded.map((a) => a.latencyMs).filter((n) => typeof n === 'number');
  const summary = {
    sent: count,
    received: succeeded.length,
    lossPct: Math.round(((count - succeeded.length) / count) * 1000) / 10,
    minMs: latencies.length ? Math.min(...latencies) : null,
    avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
  };

  return {
    ok: succeeded.length > 0,
    method: 'icmp-raw',
    host: safeHost,
    address: target.address,
    family: target.family,
    attempts,
    ...summary,
  };
}

export function assertTcpTarget(host, port) {
  const h = assertTcpHost(host);
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('포트는 1–65535입니다.');
  return { host: h, port: p };
}

export function tcpConnect(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        ok: false,
        host,
        port,
        latencyMs: null,
        error: 'timeout',
      });
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      socket.destroy();
      resolve({ ok: true, host, port, latencyMs });
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        host,
        port,
        latencyMs: null,
        error: err.code || err.message,
      });
    });

    socket.connect(port, host);
  });
}

export function assertHttpUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error('유효한 URL이 아닙니다.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('http 또는 https만 허용됩니다.');
  }
  if (!u.hostname) throw new Error('호스트명이 필요합니다.');
  return u.toString();
}

function httpRequest(urlString, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 15000, 1000), 120000);
  const method = (options.method || 'GET').toUpperCase();
  const insecure = Boolean(options.insecure);
  const u = new URL(urlString);
  const lib = u.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const started = Date.now();
    const req = lib.request(
      urlString,
      {
        method,
        timeout: timeoutMs,
        rejectUnauthorized: !insecure,
        headers: {
          'User-Agent': 'was-security-outbound/1.0',
          Accept: '*/*',
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const maxBody = 8192;
        res.on('data', (buf) => {
          size += buf.length;
          if (size <= maxBody) chunks.push(buf);
        });
        res.on('end', () => {
          const bodyPreview = Buffer.concat(chunks).toString('utf8', 0, maxBody);
          resolve({
            ok: true,
            url: urlString,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            latencyMs: Date.now() - started,
            headers: res.headers,
            bodyPreview,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        url: urlString,
        error: 'timeout',
        latencyMs: Date.now() - started,
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        url: urlString,
        error: err.code || err.message,
        latencyMs: Date.now() - started,
      });
    });

    req.end();
  });
}

export async function httpProbe(urlString, options = {}) {
  const url = assertHttpUrl(urlString);
  return httpRequest(url, options);
}
