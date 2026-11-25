'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.CLOUD_MODEL || 'openai';
const MAX_BODY = 24 * 1024;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 8000;
const MAX_TOTAL_CHARS = 18000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 20;
const MAX_CONCURRENT = 8;
const REQUEST_TIMEOUT_MS = 100000;
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'knowledge.js']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const buckets = new Map();
let activeRequests = 0;

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function getClientIp(req) {
  // 仅信任由部署平台明确提供的转发地址，不直接信任访客伪造的请求头。
  return process.env.TRUST_PROXY === '1'
    ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    : req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (buckets.size > 10000) {
    for (const [key, bucket] of buckets) if (now - bucket.startedAt > WINDOW_MS) buckets.delete(key);
  }
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.startedAt > WINDOW_MS) {
    buckets.set(ip, { startedAt: now, count: 1 });
    return { allowed: true };
  }
  bucket.count++;
  return { allowed: bucket.count <= MAX_REQUESTS_PER_IP, retryAfter: Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1000) };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('请求内容过大。');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const err = new Error('请求格式不正确。'); err.status = 400; throw err; }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return false;
  let total = 0;
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return false;
    if (!message.content.trim() || message.content.length > MAX_MESSAGE_CHARS) return false;
    total += message.content.length;
  }
  return total <= MAX_TOTAL_CHARS;
}

async function handleChat(req, res) {
  const limit = checkRateLimit(getClientIp(req));
  if (!limit.allowed) return json(res, 429, { error: '当前访问较频繁，请稍后再试。' }, { 'Retry-After': String(limit.retryAfter) });
  if (activeRequests >= MAX_CONCURRENT) return json(res, 503, { error: '云端当前繁忙，请稍后重试。' }, { 'Retry-After': '15' });

  const body = await readJson(req);
  if (!validateMessages(body.messages)) return json(res, 400, { error: '对话内容为空、过长或格式不正确。' });
  const endpoint = process.env.CLOUD_API_URL || 'https://text.pollinations.ai/openai';
  let upstream;
  try { upstream = new URL(endpoint); }
  catch { return json(res, 503, { error: '服务端接口地址配置不正确。' }); }
  if (upstream.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(upstream.hostname)) {
    return json(res, 503, { error: '云端接口必须使用 HTTPS。' });
  }

  activeRequests++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': 'xiyou-digital-avatar/1.0' };
    if (process.env.CLOUD_API_KEY) headers.Authorization = `Bearer ${process.env.CLOUD_API_KEY}`;
    const response = await fetch(upstream, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model: MODEL, messages: body.messages, stream: true, temperature: 0.7 })
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      console.error('云端接口返回错误：', response.status, detail.slice(0, 300));
      const retryAfter = response.headers.get('retry-after');
      return json(res, response.status === 429 ? 429 : 502, { error: response.status === 429 ? '云端当前繁忙，请稍后重试。' : '云端暂时未能生成回答。' }, retryAfter ? { 'Retry-After': retryAfter } : {});
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) json(res, err.name === 'AbortError' ? 504 : 502, { error: err.name === 'AbortError' ? '云端响应超时，请重试。' : '云端连接失败，请稍后重试。' });
    else if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
    activeRequests--;
  }
}

async function serveStatic(req, res, pathname) {
  const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(name)) return json(res, 404, { error: '页面不存在。' });
  const content = await fs.readFile(path.join(ROOT, name));
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name)], 'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://esm.run https://cdn.jsdelivr.net; connect-src 'self' https://esm.run https://cdn.jsdelivr.net https://huggingface.co; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(content);
}

function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, cloudConfigured: true });
      if (url.pathname === '/api/chat') {
        if (req.method !== 'POST') return json(res, 405, { error: '请求方法不支持。' }, { Allow: 'POST' });
        return await handleChat(req, res);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '请求方法不支持。' });
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error('请求处理失败：', err.message);
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : '服务暂时不可用。' });
      else if (!res.writableEnded) res.end();
    }
  });
}

if (require.main === module) {
  createApp().listen(PORT, HOST, () => console.log(`西游数字分身已启动：http://localhost:${PORT}`));
}

module.exports = { createApp, validateMessages };
