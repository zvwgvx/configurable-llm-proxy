import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, countChatCompletionTokens, buildTokenPrefix } from '../src/server.js';

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

test('passes through valid non-stream requests and prefixes assistant text', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }));
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
  assert.ok(parsed.choices[0].message.content.startsWith('Token used: '));
  assert.ok(parsed.choices[0].message.content.endsWith('Hello!'));
  assert.equal(res.headers['x-token-prefix-applied'], 'true');
});

test('passes through valid stream requests and prefixes first delta', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer upstream-secret');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
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

  const payload = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const res = await request(port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret'
    }
  }, payload);

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Token used:/);
  assert.match(res.body, /data: .*Token used:/);
});

test('builds a readable token prefix', () => {
  const prefix = buildTokenPrefix(12, 4000);
  assert.match(prefix, /Token used: 12\/4000/);
  assert.match(prefix, /remaining: 3988/);
});
