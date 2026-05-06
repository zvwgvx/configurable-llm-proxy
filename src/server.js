import http from 'node:http';
import { countTokens, countChatCompletionTokens } from './tokenizer.js';
import fs from 'node:fs';

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

function buildTokenPrefix(requestTokens, tokenLimit) {
  const remaining = Math.max(tokenLimit - requestTokens, 0);
  return `Token used: ${requestTokens}/${tokenLimit} | remaining: ${remaining}\n\n`;
}

function parseOpenAIContent(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (typeof message?.content === 'string') return message.content;
  const delta = choice?.delta;
  if (typeof delta?.content === 'string') return delta.content;
  return '';
}

function prefixOpenAIResponse(jsonText, prefix) {
  try {
    const payload = JSON.parse(jsonText);
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (typeof message?.content === 'string') {
      const content = message.content;
      message.content = prefix + content;
      return { body: JSON.stringify(payload), content, prefixed: true };
    }

    const delta = choice?.delta;
    if (typeof delta?.content === 'string') {
      const content = delta.content;
      delta.content = prefix + content;
      return { body: JSON.stringify(payload), content, prefixed: true };
    }

    return { body: jsonText, content: '', prefixed: false };
  } catch {
    return { body: jsonText, content: '', prefixed: false };
  }
}

function prefixOpenAIStream(streamText, prefix) {
  const blocks = streamText.split(/\r?\n\r?\n/);
  let prefixed = false;
  let content = '';
  const out = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    const passthroughLines = [];

    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''));
      } else {
        passthroughLines.push(line);
      }
    }

    if (!dataLines.length) {
      out.push(block);
      continue;
    }

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      out.push(block);
      continue;
    }

    try {
      const payload = JSON.parse(data);
      const choice = payload?.choices?.[0];
      const delta = choice?.delta;
      const message = choice?.message;

      if (typeof delta?.content === 'string') {
        content += delta.content;
        if (!prefixed) {
          delta.content = prefix + delta.content;
          prefixed = true;
        }
      } else if (typeof message?.content === 'string') {
        content += message.content;
        if (!prefixed) {
          message.content = prefix + message.content;
          prefixed = true;
        }
      }

      const rebuilt = JSON.stringify(payload);
      out.push([...passthroughLines, `data: ${rebuilt}`].join('\n'));
    } catch {
      out.push(block);
    }
  }

  return { body: out.join('\n\n') + (out.length ? '\n\n' : ''), content, prefixed };
}

function addCors(headers, cors) {
  for (const [key, value] of Object.entries(cors)) headers[key] = value;
  return headers;
}

function logTokenUsage({ requestTokens, responseTokens, prefixTokens, tokenLimit, route }) {
  const used = requestTokens + responseTokens + prefixTokens;
  const remaining = tokenLimit - used;
  console.log(`[proxy] ${route} request=${requestTokens} response=${responseTokens} prefix=${prefixTokens} used=${used}/${tokenLimit} remaining=${remaining}`);
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
    }

    const requestTokens = countChatCompletionTokens(body);
    const prefix = buildTokenPrefix(requestTokens, config.tokenLimit);
    const prefixTokens = countTokens(prefix);
    const maxResponseTokens = config.tokenLimit - requestTokens - prefixTokens;

    if (maxResponseTokens <= 0) {
      console.warn(`[proxy] blocked request over token budget: request=${requestTokens} prefix=${prefixTokens} limit=${config.tokenLimit}`);
      return json(res, 400, {
        error: {
          message: `Token limit exceeded: ${requestTokens + prefixTokens} > ${config.tokenLimit}`,
          type: 'token_limit_exceeded'
        }
      }, cors);
    }

    body.max_tokens = typeof body.max_tokens === 'number' ? Math.min(body.max_tokens, maxResponseTokens) : maxResponseTokens;
    rawBody = JSON.stringify(body);

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

    const upstreamText = await upstreamResponse.text();
    const upstreamContentType = upstreamResponse.headers.get('content-type') || '';
    const isStream = upstreamContentType.includes('text/event-stream') || body.stream === true;
    let responseText = upstreamText;
    let assistantContent = '';
    let prefixApplied = false;

    if (upstreamResponse.ok) {
      if (isStream) {
        const transformed = prefixOpenAIStream(upstreamText, prefix);
        responseText = transformed.body;
        assistantContent = transformed.content;
        prefixApplied = transformed.prefixed;
      } else {
        const transformed = prefixOpenAIResponse(upstreamText, prefix);
        responseText = transformed.body;
        assistantContent = transformed.content;
        prefixApplied = transformed.prefixed;
      }
    }

    const responseTokens = countTokens(assistantContent);
    const totalUsed = requestTokens + prefixTokens + responseTokens;
    if (upstreamResponse.ok && totalUsed > config.tokenLimit) {
      console.warn(`[proxy] blocked response over token budget: request=${requestTokens} response=${responseTokens} prefix=${prefixTokens} limit=${config.tokenLimit}`);
      return json(res, 400, {
        error: {
          message: `Token limit exceeded: ${totalUsed} > ${config.tokenLimit}`,
          type: 'token_limit_exceeded'
        }
      }, cors);
    }

    logTokenUsage({
      requestTokens,
      responseTokens,
      prefixTokens,
      tokenLimit: config.tokenLimit,
      route: url.pathname
    });

    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
    delete responseHeaders['content-length'];
    addCors(responseHeaders, cors);
    responseHeaders['x-token-request'] = String(requestTokens);
    responseHeaders['x-token-response'] = String(responseTokens);
    responseHeaders['x-token-used'] = String(totalUsed);
    responseHeaders['x-token-remaining'] = String(config.tokenLimit - totalUsed);
    responseHeaders['x-token-prefix-applied'] = String(prefixApplied);

    res.writeHead(upstreamResponse.status, responseHeaders);
    return res.end(responseText);
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

export {
  createServer,
  createHandler,
  makeConfig,
  isAuthorized,
  countChatCompletionTokens,
  start,
  loadDotEnv,
  buildTokenPrefix,
  prefixOpenAIResponse,
  prefixOpenAIStream
};
