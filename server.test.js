'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createApp, validateMessages } = require('./server');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('公开静态页面与健康检查可访问，服务端文件不公开', async () => {
  const app = createApp();
  const base = await listen(app);
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /西游数字分身/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
  } finally { await close(app); }
});

test('拒绝空内容、过长对话和非法角色', () => {
  assert.equal(validateMessages([]), false);
  assert.equal(validateMessages([{ role: 'user', content: '' }]), false);
  assert.equal(validateMessages([{ role: 'root', content: '你好' }]), false);
  assert.equal(validateMessages([{ role: 'user', content: '好'.repeat(8001) }]), false);
  assert.equal(validateMessages([{ role: 'user', content: '孙悟空是谁？' }]), true);
});

test('云端代理转发 SSE，密钥仅发送到服务端上游', async () => {
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-secret');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).messages[0].content, '你好');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"云端"}}]}\n\n');
    res.end('data: {"choices":[{"delta":{"content":"成功"}}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamBase = await listen(upstream);
  const oldUrl = process.env.CLOUD_API_URL;
  const oldKey = process.env.CLOUD_API_KEY;
  process.env.CLOUD_API_URL = `${upstreamBase}/v1/chat/completions`;
  process.env.CLOUD_API_KEY = 'test-only-secret';
  const app = createApp();
  const base = await listen(app);
  try {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(await response.text(), /云端/);
  } finally {
    await close(app);
    await close(upstream);
    if (oldUrl === undefined) delete process.env.CLOUD_API_URL; else process.env.CLOUD_API_URL = oldUrl;
    if (oldKey === undefined) delete process.env.CLOUD_API_KEY; else process.env.CLOUD_API_KEY = oldKey;
  }
});

test('非法请求返回有界错误，不暴露密钥或内部堆栈', async () => {
  const app = createApp();
  const base = await listen(app);
  try {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '' }] })
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, /test-only-secret|at\s+.*server\.js/);
  } finally { await close(app); }
});
