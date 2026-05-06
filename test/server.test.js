import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, countChatCompletionTokens } from '../src/server.js';

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

test('counts chat completion tokens', () => {
  const tokens = countChatCompletionTokens({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ]
  });
  assert.equal(typeof tokens, 'number');
  assert.ok(tokens > 0);
});

test('blocks unauthorized requests', async (t) => {
  const env = {
    PROXY_API_KEY: 'secret',
    UPSTREAM_BASE_URL: 'http://127.0.0.1:9999',
    UPSTREAM_API_KEY: 'upstream',
    TOKEN_LIMIT: '4000'
  };
  const server = createServer(env);
  const port = await listen(server);
  t.after(() => server.close());

  const res = await request(port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' }
  }, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));

  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Invalid proxy API key/);
});

test('blocks over-limit requests', async (t) => {
  const env = {
    PROXY_API_KEY: 'secret',
    UPSTREAM_BASE_URL: 'http://127.0.0.1:9999',
    UPSTREAM_API_KEY: 'upstream',
    TOKEN_LIMIT: '1'
  };
  const server = createServer(env);
  const port = await listen(server);
  t.after(() => server.close());

  const res = await request(port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret'
    }
  }, JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] }));

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Token limit exceeded/);
});

test('passes through valid requests and injects a default model', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' });
      res.end(JSON.stringify({ seenAuth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });

  const upstreamPort = await listen(upstream);
  const env = {
    PROXY_API_KEY: 'secret',
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    UPSTREAM_API_KEY: 'upstream-secret',
    TOKEN_LIMIT: '4000'
  };
  const server = createServer(env);
  const port = await listen(server);
  t.after(() => {
    server.close();
    upstream.close();
  });

  const payload = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const res = await request(port, {
    method: 'POST',
    path: '/v1/chat/completions?foo=bar',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret'
    }
  }, payload);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-upstream'], 'ok');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.seenAuth, 'Bearer upstream-secret');
  assert.deepEqual(JSON.parse(parsed.body), {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'ollama/gpt-oss:120b-cloud'
  });
});
