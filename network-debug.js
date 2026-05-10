import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import http from 'http';
import https from 'https';
import { URL } from 'url';

const execFileAsync = promisify(execFile);

const HOST_PATTERN = /^[a-zA-Z0-9.-]+$/;
const SHELL_METACHAR = /[;&|`$(){}[\]<>'"\n\r\\]/;

/** Ping 대상 (도커 컨테이너의 ping 바이너리 인자로만 전달, 셸 미사용) */
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

export async function runPing(host, options = {}) {
  const count = Math.min(Math.max(Number(options.count) || 1, 1), 10);
  const safeHost = assertPingHost(host);
  const platform = process.platform;

  if (platform === 'win32') {
    const { stdout, stderr } = await execFileAsync(
      'ping',
      ['-n', String(count), safeHost],
      { timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    return {
      ok: true,
      platform: 'win32',
      command: `ping -n ${count} ${safeHost}`,
      output: (stdout || stderr || '').trim(),
    };
  }

  let args;
  if (platform === 'darwin') {
    args = ['-c', String(count), '-W', '3000', safeHost];
  } else {
    args = ['-c', String(count), '-W', '3', safeHost];
  }
  try {
    const { stdout, stderr } = await execFileAsync('ping', args, {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      platform,
      command: `ping ${args.join(' ')}`,
      output: (stdout || stderr || '').trim(),
    };
  } catch (err) {
    const stderr = err.stderr?.toString?.() ?? '';
    const stdout = err.stdout?.toString?.() ?? '';
    return {
      ok: false,
      platform,
      command: `ping ${args.join(' ')}`,
      error: err.message || String(err),
      output: (stdout || stderr || '').trim(),
      hint:
        'Linux 컨테이너에서는 ping 바이너리가 필요합니다. 예: Alpine 이미지에 `apk add --no-cache iputils-ping` 또는 `--cap-add=NET_RAW`(icmp)',
    };
  }
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
