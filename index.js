import os from 'os';
import net from 'net';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPing, tcpConnect, httpProbe, assertTcpTarget } from './network-debug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.WEB_PORT) || 8888;
const ALL_PORTS = Array.from({ length: 65535 }, (_, i) => i + 1);

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function intToIp(num) {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

function getConnectedInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal && addr.address) {
        result.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac || '-',
        });
      }
    }
  }
  return result;
}

function getHostRange(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  const network = ip & mask;
  const wildcard = ~mask >>> 0;
  const broadcast = network | wildcard;
  return { first: network + 1, last: broadcast - 1, network, broadcast };
}

function checkPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ host, port, open: false });
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ host, port, open: true });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve({ host, port, open: false });
    });
    socket.connect(port, host);
  });
}

async function scanPortsOnHost(host, ports, onProgress, isCancelled, concurrency = 400) {
  const open = [];
  for (let i = 0; i < ports.length; i += concurrency) {
    if (isCancelled && isCancelled()) break;
    const chunk = ports.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((p) => checkPort(host, p)));
    for (const r of results) {
      if (r.open) open.push(r.port);
    }
    if (onProgress) onProgress(i + chunk.length, ports.length);
  }
  return open.sort((a, b) => a - b);
}

const scanState = {
  running: false,
  cancelRequested: false,
  results: [],        // { host, ports: number[] }
  progress: null,     // { currentHost, totalHosts, hostProgress, hostTotal }
  startTime: null,
  endedAt: null,
  finishReason: null, // 'done' | 'stopped' | 'error'
  listeners: [],      // SSE res objects
};

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  scanState.listeners = scanState.listeners.filter((res) => {
    try {
      res.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

async function runScan(interfaceIndex = 0) {
  const ifaces = getConnectedInterfaces();
  if (ifaces.length === 0 || interfaceIndex >= ifaces.length) {
    scanState.running = false;
    broadcast({ type: 'error', message: '유효한 NIC가 없습니다.' });
    return;
  }

  const iface = ifaces[interfaceIndex];
  const { first, last } = getHostRange(iface.address, iface.netmask);
  const hosts = [];
  for (let n = first; n <= last; n++) hosts.push(intToIp(n));

  scanState.running = true;
  scanState.cancelRequested = false;
  scanState.results = [];
  scanState.startTime = Date.now();
  scanState.endedAt = null;
  scanState.finishReason = null;
  scanState.progress = { currentHost: 0, totalHosts: hosts.length, hostProgress: 0, hostTotal: ALL_PORTS.length };
  broadcast({ type: 'start', totalHosts: hosts.length, portsTotal: ALL_PORTS.length });

  const isCancelled = () => scanState.cancelRequested || !scanState.running;

  const hostConcurrency = 5;
  for (let i = 0; i < hosts.length; i += hostConcurrency) {
    if (isCancelled()) break;
    const chunk = hosts.slice(i, i + hostConcurrency);
    const chunkResults = await Promise.all(
      chunk.map((host, hostIndex) =>
        scanPortsOnHost(
          host,
          ALL_PORTS,
          (done, total) => {
            const completedHosts = i;
            scanState.progress = {
              completedHosts,
              totalHosts: hosts.length,
              scanningHostFrom: i + 1,
              scanningHostTo: i + chunk.length,
              hostProgress: done,
              hostTotal: total,
              currentHostIp: host,
            };
            broadcast({ type: 'progress', ...scanState.progress });
          },
          isCancelled
        )
      )
    );
    chunk.forEach((host, idx) => {
      const ports = chunkResults[idx];
      if (ports.length > 0) {
        scanState.results.push({ host, ports });
        broadcast({ type: 'result', host, ports });
      }
    });
    if (isCancelled()) break;
    const completedHosts = i + chunk.length;
    scanState.progress = {
      completedHosts,
      totalHosts: hosts.length,
      scanningHostFrom: completedHosts + 1,
      scanningHostTo: Math.min(completedHosts + hostConcurrency, hosts.length),
      hostProgress: ALL_PORTS.length,
      hostTotal: ALL_PORTS.length,
    };
    broadcast({ type: 'progress', ...scanState.progress });
  }

  const wasCancelled = scanState.cancelRequested;
  scanState.running = false;
  scanState.endedAt = Date.now();
  scanState.finishReason = wasCancelled ? 'stopped' : 'done';
  const elapsed = ((scanState.endedAt - scanState.startTime) / 1000).toFixed(1);
  broadcast({
    type: wasCancelled ? 'stopped' : 'done',
    results: scanState.results,
    elapsed,
    progress: scanState.progress,
  });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/interfaces', (req, res) => {
  const ifaces = getConnectedInterfaces();
  res.json(ifaces.map((iface, i) => {
    const range = getHostRange(iface.address, iface.netmask);
    return {
      index: i,
      name: iface.name,
      address: iface.address,
      netmask: iface.netmask,
      mac: iface.mac,
      ...range,
      hostRange: `${intToIp(range.first)} ~ ${intToIp(range.last)}`,
    };
  }));
});

app.post('/api/scan', (req, res) => {
  if (scanState.running) {
    return res.status(409).json({ error: '이미 스캔이 실행 중입니다.' });
  }
  const interfaceIndex = Number(req.body?.interfaceIndex) ?? 0;
  runScan(interfaceIndex).catch((err) => {
    scanState.running = false;
    scanState.finishReason = 'error';
    broadcast({ type: 'error', message: err.message });
  });
  res.json({ started: true, interfaceIndex });
});

app.post('/api/scan/stop', (req, res) => {
  if (!scanState.running) {
    return res.status(409).json({ error: '실행 중인 스캔이 없습니다.' });
  }
  scanState.cancelRequested = true;
  broadcast({ type: 'stopping' });
  res.json({ stopping: true });
});

app.get('/api/scan/status', (req, res) => {
  res.json({
    running: scanState.running,
    cancelRequested: scanState.cancelRequested,
    finishReason: scanState.finishReason,
    results: scanState.results,
    progress: scanState.progress,
    startTime: scanState.startTime,
    endedAt: scanState.endedAt,
  });
});

app.get('/api/scan/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  scanState.listeners.push(res);
  const sync = {
    type: 'sync',
    running: scanState.running,
    cancelRequested: scanState.cancelRequested,
    finishReason: scanState.finishReason,
    results: scanState.results,
    progress: scanState.progress,
    startTime: scanState.startTime,
  };
  if (scanState.running) {
    sync.elapsed = scanState.startTime ? ((Date.now() - scanState.startTime) / 1000).toFixed(1) : 0;
  } else if (scanState.finishReason === 'stopped') {
    sync.type = 'stopped';
    sync.results = scanState.results;
    sync.elapsed = scanState.startTime && scanState.endedAt ? ((scanState.endedAt - scanState.startTime) / 1000).toFixed(1) : 0;
  } else if (scanState.results.length > 0) {
    sync.type = 'done';
    sync.results = scanState.results;
    sync.elapsed = scanState.startTime && scanState.endedAt ? ((scanState.endedAt - scanState.startTime) / 1000).toFixed(1) : 0;
  }
  res.write(`data: ${JSON.stringify(sync)}\n\n`);
  req.on('close', () => {
    scanState.listeners = scanState.listeners.filter((r) => r !== res);
  });
});

app.post('/api/debug/http', async (req, res) => {
  try {
    const result = await httpProbe(req.body?.url, {
      timeoutMs: req.body?.timeoutMs,
      method: req.body?.method,
      insecure: req.body?.insecure,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/debug/ping', async (req, res) => {
  try {
    const result = await runPing(req.body?.host, { count: req.body?.count });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/debug/tcp', async (req, res) => {
  try {
    const { host, port } = assertTcpTarget(req.body?.host, req.body?.port);
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 5000, 500), 60000);
    const result = await tcpConnect(host, port, timeoutMs);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(`WAS Security 포트 스캐너: http://0.0.0.0:${WEB_PORT} (모든 인터페이스, WEB_PORT=${WEB_PORT})`);
});
