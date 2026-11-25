import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Start a local Unix Domain Socket JSON-RPC-like IPC server for ag-ctl.mjs.
 */
export function startIpcServer(sockPath, handler, logger = console) {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  try {
    fs.unlinkSync(sockPath);
  } catch {}

  const server = net.createServer({ allowHalfOpen: true }, conn => {
    let raw = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => { raw += chunk; });
    conn.on('end', async () => {
      try {
        const req = JSON.parse(raw || '{}');
        const res = await handler(req);
        if (!conn.destroyed && conn.writable) {
          conn.end(`${JSON.stringify({ ok: true, data: res })}\n`);
        }
      } catch (err) {
        if (!conn.destroyed && conn.writable) {
          conn.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
        }
      }
    });
    conn.on('error', err => {
      logger.error?.('[IPC 连接错误]', err.message);
    });
  });

  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {}
  });

  return {
    server,
    close() {
      try { server.close(); } catch {}
      try { fs.unlinkSync(sockPath); } catch {}
    },
  };
}

/**
 * Send a single JSON request to the running daemon over Unix Domain Socket.
 */
export function sendIpcRequest(sockPath, payload, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath);
    let output = '';
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      try { client.destroy(); } catch {}
      finish(new Error('IPC 请求超时'));
    }, timeoutMs);

    client.setEncoding('utf8');
    client.on('connect', () => {
      client.end(`${JSON.stringify(payload)}\n`);
    });
    client.on('data', chunk => { output += chunk; });
    client.on('error', err => finish(err));
    client.on('end', () => {
      try {
        const parsed = JSON.parse(output.trim());
        if (parsed.ok) finish(null, parsed.data);
        else finish(new Error(parsed.error || 'IPC 执行失败'));
      } catch (err) {
        finish(new Error(`IPC 返回无效响应: ${err.message}`));
      }
    });
  });
}
