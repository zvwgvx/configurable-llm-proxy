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

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function text(res, statusCode, message, extraHeaders = {}) {
  const payload = message + '\n';
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
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
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
    defaultModel: env.DEFAULT_MODEL || 'ollama/gpt-oss:120b-cloud'
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
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      return text(res, 204, '', cors);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true }, cors);
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [
          {
            id: config.defaultModel,
            object: 'model',
            created: 0,
            owned_by: 'proxy'
          }
        ]
      }, cors);
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return text(res, 404, 'Not found', cors);
    }

    if (!config.proxyApiKey || !config.upstreamBaseUrl || !config.upstreamApiKey) {
      return json(res, 500, { error: 'Proxy is not configured' }, cors);
    }

    if (!isAuthorized(req, config.proxyApiKey)) {
      return json(res, 401, { error: { message: 'Invalid proxy API key' } }, cors);
    }

    let rawBody = '';
    try {
      rawBody = await readBody(req);
    } catch {
      return json(res, 400, { error: { message: 'Invalid request body' } }, cors);
    }

    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json(res, 400, { error: { message: 'Request body must be JSON' } }, cors);
    }

    if (!body.model) {
      body.model = config.defaultModel;
      rawBody = JSON.stringify(body);
    }

    const tokens = countChatCompletionTokens(body);
    if (tokens > config.tokenLimit) {
      return json(res, 400, {
        error: {
          message: `Token limit exceeded: ${tokens} > ${config.tokenLimit}`,
          type: 'token_limit_exceeded'
        }
      }, cors);
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

    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
    for (const [key, value] of Object.entries(cors)) {
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamResponse.status, responseHeaders);
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
      const cors = corsHeaders(req);
      if (!res.headersSent) {
        json(res, 500, { error: { message: error?.message || 'Internal server error' } }, cors);
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
