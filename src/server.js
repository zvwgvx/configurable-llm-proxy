import http from 'node:http';
import fs from 'node:fs';
import { countChatCompletionTokens } from './tokenizer.js';

function loadDotEnv(envPath = '.env') {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function text(res, statusCode, message) {
  const payload = message + '\n';
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeConfig(env = process.env) {
  return {
    port: Number(env.PORT || 2026),
    proxyApiKey: env.PROXY_API_KEY || '',
    tokenLimit: Number(env.TOKEN_LIMIT || 4000),
    upstreamBaseUrl: env.UPSTREAM_BASE_URL || '',
    upstreamApiKey: env.UPSTREAM_API_KEY || ''
  };
}

function isAuthorized(req, proxyApiKey) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  return auth.slice(7) === proxyApiKey;
}

function upstreamUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl).toString();
}

function createHandler(env = process.env) {
  return async function handler(req, res) {
    const config = makeConfig(env);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return text(res, 404, 'Not found');
    }

    if (!config.proxyApiKey || !config.upstreamBaseUrl || !config.upstreamApiKey) {
      return json(res, 500, { error: 'Proxy is not configured' });
    }

    if (!isAuthorized(req, config.proxyApiKey)) {
      return json(res, 401, { error: { message: 'Invalid proxy API key' } });
    }

    let rawBody = '';
    try {
      rawBody = await readBody(req);
    } catch {
      return json(res, 400, { error: { message: 'Invalid request body' } });
    }

    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json(res, 400, { error: { message: 'Request body must be JSON' } });
    }

    const tokens = countChatCompletionTokens(body);
    if (tokens > config.tokenLimit) {
      return json(res, 400, {
        error: {
          message: `Token limit exceeded: ${tokens} > ${config.tokenLimit}`,
          type: 'token_limit_exceeded'
        }
      });
    }

    const headers = new Headers();
    const contentType = req.headers['content-type'];
    if (contentType) headers.set('content-type', contentType);
    headers.set('authorization', `Bearer ${config.upstreamApiKey}`);
    headers.set('accept', req.headers.accept || 'application/json');

    const upstreamResponse = await fetch(upstreamUrl(config.upstreamBaseUrl, url.pathname + url.search), {
      method: 'POST',
      headers,
      body: rawBody
    });

    res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));
    if (!upstreamResponse.body) {
      return res.end();
    }

    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  };
}

function createServer(env = process.env) {
  const handler = createHandler(env);
  return http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) {
        json(res, 500, { error: { message: error?.message || 'Internal server error' } });
        return;
      }
      res.destroy(error);
    });
  });
}

function start(env = process.env) {
  const server = createServer(env);
  const { port } = makeConfig(env);
  server.listen(port, () => {
    console.log(`Proxy listening on ${port}`);
  });
  return server;
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { createServer, createHandler, makeConfig, isAuthorized, countChatCompletionTokens, start, loadDotEnv };
