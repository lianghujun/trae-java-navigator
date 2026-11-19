'use strict';

const { spawn } = require('child_process');

class LspClient {
  constructor(options) {
    this.command = options.command || 'java';
    this.args = options.args || [];
    this.cwd = options.cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderrTail = [];
    this.closed = false;
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  setConfigProvider(provider) {
    this.configProvider = provider;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      process.stderr.write('[jdtls] ' + text);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(`JDT LS 已退出 (code=${code}, signal=${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    this.proc.on('error', (err) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // 非法 header，丢弃这一个包
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + length);

      let msg;
      try { msg = JSON.parse(body); } catch (_) { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const handler = this.notificationHandlers.get(msg.method);
        if (handler) {
          try { handler(msg.params); } catch (e) { process.stderr.write('[handler] ' + e.message + '\n'); }
        } else if (msg.id !== undefined) {
          // 服务端请求（如 workspace/configuration、client/registerCapability）
          this._handleServerRequest(msg);
        }
      }
    }
  }

  _handleServerRequest(msg) {
    const { method, id, params } = msg;
    let result = null;
    if (method === 'workspace/configuration') {
      const provider = this.configProvider;
      result = (params.items || []).map((item) => (
        provider ? provider(item.section) : {}
      ));
    } else if (method === 'client/registerCapability'
      || method === 'client/unregisterCapability'
      || method === 'window/workDoneProgress/create'
      || method === 'workspace/workspaceFolders') {
      if (method === 'workspace/workspaceFolders') result = null;
    } else if (method === 'workspace/applyEdit') {
      result = { applied: false };
    }
    this._send({ jsonrpc: '2.0', id, result });
  }

  _send(obj) {
    if (!this.proc || this.closed) throw new Error('JDT LS 未运行');
    const body = JSON.stringify(obj);
    const payload = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    this.proc.stdin.write(payload, 'utf8');
  }

  request(method, params, timeoutMs = 30000) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.start();
    this._send({ jsonrpc: '2.0', method, params });
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.kill(); } catch (_) { /* ignore */ }
    this.closed = true;
    this.proc = null;
  }
}

module.exports = { LspClient };