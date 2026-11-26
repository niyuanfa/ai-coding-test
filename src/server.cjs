const { createServer } = require('node:http');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { TextDecoder } = require('node:util');
const {
  ApiError, canonical, integer, invalid, mediaType, object, parseJson, trimHeader, versionConfig,
} = require('./config.cjs');
const { activate, etag, findVersion, openStore } = require('./store.cjs');

const namespacePattern = /^[A-Za-z0-9_-]+$/;
const roles = new Set(['admin', 'observer', 'invoke']);
const maxBodyBytes = 1024 * 1024;
const decodeUtf8 = new TextDecoder('utf-8', { fatal: true });
const missing = Symbol('missing');
const hash = (token) => createHash('sha256').update(token).digest();

function queryParams(raw) {
  const values = new Map();
  const decode = (part) => decodeURIComponent(part.replaceAll('+', ' '));
  try {
    for (const part of raw.split('&')) {
      if (!part) continue;
      const split = part.indexOf('=');
      const key = decode(split === -1 ? part : part.slice(0, split));
      const value = decode(split === -1 ? '' : part.slice(split + 1));
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(value);
    }
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', '查询串编码无效');
  }
  return values;
}

function requestHeaders(req) {
  const headers = new Map();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index].toLowerCase();
    if (!headers.has(key)) headers.set(key, []);
    headers.get(key).push(trimHeader(req.rawHeaders[index + 1]));
  }
  return headers;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    function receive(chunk) {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        req.off('data', receive);
        chunks.length = 0;
        reject(new ApiError(413, 'REQUEST_TOO_LARGE', '请求体超过 1 MiB'));
        return;
      }
      chunks.push(chunk);
    }
    req.on('data', receive);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', () => reject(new ApiError(400, 'INVALID_REQUEST', '读取请求体失败')));
  });
}

async function managementJson(req) {
  if (mediaType(req.headers['content-type']) !== 'application/json') {
    invalid('', '管理请求需要 application/json');
  }
  const body = await readBody(req);
  try {
    const value = parseJson(decodeUtf8.decode(body));
    // 提前拒绝超出序列化能力的嵌套输入。
    canonical(value);
    return value;
  } catch {
    invalid('', '需要合法 JSON，且字段名不能重复');
  }
}

function pointerValue(value, pointer) {
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' ||
        (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) || !Object.hasOwn(value, key)) {
      return missing;
    }
    value = value[key];
  }
  return value;
}

function storedCandidate(entry, trace) {
  try {
    const version = findVersion(entry, entry.rule.activeVersion);
    const { ruleId, version: number, createdAt, ...config } = version;
    if (ruleId !== entry.rule.id || !Number.isSafeInteger(number) || number < 1 || typeof createdAt !== 'string') {
      throw new Error('Invalid stored version metadata');
    }
    const validated = versionConfig(object(config, '', ['description', 'match', 'response', 'priority']));
    return { ...validated, ruleId, version: number };
  } catch {
    trace.ruleId = entry.rule.id;
    trace.version = entry.rule.activeVersion;
    throw new ApiError(500, 'INVALID_RESPONSE_CONFIG', '生效规则配置无效');
  }
}

async function matchRule(store, namespace, req, path, query, headers, trace) {
  const candidates = store.active(namespace)
    .map((entry) => storedCandidate(entry, trace))
    .filter(({ match }) => match.method === req.method && match.path === path)
    .sort((left, right) => right.priority - left.priority || left.ruleId.localeCompare(right.ruleId));
  trace.candidates = candidates.length;
  let parsedBody = missing;
  let checkedBody = false;
  for (const version of candidates) {
    const { match } = version;
    if (!Object.entries(match.query).every(([key, expected]) => {
      const values = query.get(key);
      return values?.length === 1 && values[0] === expected;
    })) continue;
    if (!Object.entries(match.headers).every(([key, expected]) => headers.get(key)?.join(', ') === expected)) continue;
    const conditions = Object.entries(match.jsonBody);
    if (conditions.length) {
      if (!checkedBody) {
        checkedBody = true;
        const contentTypes = headers.get('content-type');
        if (contentTypes?.length === 1 && mediaType(contentTypes[0]) === 'application/json') {
          const body = await readBody(req);
          try {
            parsedBody = parseJson(decodeUtf8.decode(body));
          } catch {
            // 无效 JSON 只影响依赖 JSON 条件的候选规则。
          }
        }
      }
      if (parsedBody === missing || !conditions.every(([key, expected]) => pointerValue(parsedBody, key) === expected)) continue;
    }
    return version;
  }
  throw new ApiError(404, 'MOCK_RULE_NOT_FOUND', '没有匹配的 mock 规则');
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function routeMissing() {
  throw new ApiError(404, 'ROUTE_NOT_FOUND', '接口不存在');
}

function requireAccess(req, credentials, namespace, acceptedRoles) {
  const header = req.headersDistinct.authorization;
  const bearer = header?.length === 1 && /^Bearer ([^\s,]+)$/i.exec(header[0]);
  const digest = bearer ? hash(bearer[1]) : null;
  const credential = digest && credentials.find((item) => timingSafeEqual(item.digest, digest));
  if (!credential) throw new ApiError(401, 'UNAUTHENTICATED', '需要有效的 Bearer 凭据');
  if (!acceptedRoles.some((role) => credential.grants.get(namespace)?.has(role))) {
    throw new ApiError(403, 'FORBIDDEN', '凭据无权访问此接口或命名空间');
  }
  return credential.subject;
}

async function manage(req, res, store, namespace, route, query, subject, trace) {
  const { method } = req;
  const [, id, resource, versionNumber] = route;
  const base = `/api/v1/namespaces/${namespace}/rules`;
  if (!id && method === 'POST') {
    const keys = req.headersDistinct['idempotency-key'];
    const key = keys?.length === 1 && keys[0].trim();
    if (!key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要非空 Idempotency-Key');
    const input = object(await managementJson(req), '', ['id', 'name', 'description', 'match', 'response', 'priority']);
    if (Object.hasOwn(input, 'id') && (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id))) {
      invalid('/id', '必须是 1 到 128 个 ASCII 字母、数字、下划线或连字符');
    }
    if (typeof input.name !== 'string' || !input.name.trim()) invalid('/name', '必须是非空字符串');
    const result = store.create(namespace, subject, key, input, versionConfig(input));
    Object.assign(trace, { action: 'create', ruleId: result.rule.id, revision: result.rule.revision, changed: result.changed });
    return json(res, 201, result.rule, { location: `${base}/${result.rule.id}`, etag: etag(result.rule) });
  }
  if (method === 'GET') {
    if (!id) {
      const state = query.get('state');
      const name = query.get('name');
      if (state && (state.length !== 1 || !['enabled', 'disabled'].includes(state[0]))) {
        invalid('/state', '必须指定单个 enabled 或 disabled');
      }
      if (name && name.length !== 1) invalid('/name', '只能指定一个名称');
      return json(res, 200, { items: store.list(namespace, { state: state?.[0], name: name?.[0] }) });
    }
    if (resource === 'state') return routeMissing();
    const entry = store.get(namespace, id);
    if (!resource) return json(res, 200, entry.rule, { etag: etag(entry.rule) });
    if (!versionNumber) return json(res, 200, { items: entry.versions.slice().reverse() });
    return json(res, 200, findVersion(entry, Number(versionNumber)));
  }
  if (!id || (resource && resource !== 'state') ||
      (method !== 'PUT' && !(method === 'DELETE' && !resource))) return routeMissing();

  const input = method === 'PUT' ? await managementJson(req) : undefined;
  const action = method === 'DELETE' ? 'delete' : resource === 'state' ? 'state' : 'update';
  const result = store.change(namespace, id, subject, req.headers['if-match'], action, (entry, data, at) => {
    if (action === 'delete') return activate(entry, data, 'deleted', null);
    if (action === 'state') {
      object(input, '', ['state', 'version']);
      if (input.state === 'enabled') {
        return activate(entry, data, 'enabled', integer(input.version, 1, Number.MAX_SAFE_INTEGER, '/version'));
      }
      if (input.state === 'disabled' && !Object.hasOwn(input, 'version')) {
        return activate(entry, data, 'disabled', null);
      }
      invalid('/state', '使用 enabled 并指定版本，或使用 disabled 并省略版本');
    }
    const { ruleId, version, createdAt, ...previous } = entry.versions.at(-1);
    const config = versionConfig(object(input, '', ['description', 'match', 'response', 'priority']), previous.description);
    if (canonical(config) === canonical(previous)) return false;
    entry.rule.latestVersion = version + 1;
    entry.rule.description = config.description;
    entry.versions.push({ ruleId, version: version + 1, createdAt: at, ...config });
    return true;
  });
  Object.assign(trace, { action, ruleId: result.rule.id, revision: result.rule.revision, changed: result.changed });
  if (method === 'DELETE') {
    res.writeHead(204, { etag: etag(result.rule) });
    return res.end();
  }
  return json(res, 200, result.rule, { etag: etag(result.rule) });
}

function createMockServer({ database = ':memory:', namespaces, tokens, log = (record) => console.log(JSON.stringify(record)) }) {
  if (!Array.isArray(namespaces) || !namespaces.length || new Set(namespaces).size !== namespaces.length ||
      namespaces.some((key) => typeof key !== 'string' || !namespacePattern.test(key)) ||
      !Array.isArray(tokens) || !tokens.length) {
    throw new Error('命名空间或凭据配置无效');
  }
  const metrics = new Map(namespaces.map((key) => [key, { calls: 0, hits: 0, misses: 0, errors: 0 }]));
  const seenTokens = new Set();
  const credentials = tokens.map(({ token, subject, grants }) => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || seenTokens.has(token) ||
        typeof subject !== 'string' || !subject.trim() || !grants || typeof grants !== 'object' || Array.isArray(grants)) {
      throw new Error('凭据配置无效');
    }
    seenTokens.add(token);
    const entries = Object.entries(grants);
    if (entries.some(([key, values]) => !metrics.has(key) || !Array.isArray(values) || values.some((role) => !roles.has(role)))) {
      throw new Error('凭据权限配置无效');
    }
    const grantedRoles = entries.flatMap(([, values]) => values);
    if (grantedRoles.includes('invoke') && grantedRoles.some((role) => role !== 'invoke')) {
      throw new Error('调用权限和管理权限需要不同凭据');
    }
    return { digest: hash(token), subject, grants: new Map(entries.map(([key, values]) => [key, new Set(values)])) };
  });
  const store = openStore(database);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const trace = { requestId, outcome: 'success' };
    const started = performance.now();
    res.setHeader('x-request-id', requestId);
    let counters;
    try {
      const separator = req.url.indexOf('?');
      const pathname = separator === -1 ? req.url : req.url.slice(0, separator);
      const rawQuery = separator === -1 ? '' : req.url.slice(separator + 1);
      const mock = /^\/mock\/([A-Za-z0-9_-]+)(\/[^#]*)$/.exec(pathname);
      const api = /^\/api\/v1\/namespaces\/([A-Za-z0-9_-]+)\/(.*)$/.exec(pathname);
      if (pathname.startsWith('/mock/')) {
        trace.event = 'mock_call';
        if (!mock) throw new ApiError(400, 'INVALID_REQUEST', '调用路径无效');
        const [, namespace, path] = mock;
        requireAccess(req, credentials, namespace, ['invoke']);
        trace.namespace = namespace;
        counters = metrics.get(namespace);
        counters.calls += 1;
        const version = await matchRule(store, namespace, req, path, queryParams(rawQuery), requestHeaders(req), trace);
        const { response, ruleId } = version;
        counters.hits += 1;
        Object.assign(trace, { ruleId, version: version.version, priority: version.priority, outcome: 'hit' });
        let body;
        let headers = response.headers;
        if (Object.hasOwn(response, 'body')) {
          const text = response.format === 'text';
          body = text ? response.body : JSON.stringify(response.body);
          headers = {
            'content-type': text ? 'text/plain; charset=utf-8' : 'application/json',
            ...headers,
          };
          if (text && !headers['content-type'].split(';').slice(1).some((parameter) => /^\s*charset\s*=/i.test(parameter))) {
            headers['content-type'] += '; charset=utf-8';
          }
        }
        if (response.delayMs) await wait(response.delayMs);
        if (res.destroyed) {
          trace.outcome = 'aborted';
          return;
        }
        res.writeHead(response.status, headers);
        res.end(body);
        return;
      }
      if (api) {
        trace.event = 'management_request';
        const [, namespace, endpoint] = api;
        const subject = requireAccess(req, credentials, namespace, req.method === 'GET' ? ['admin', 'observer'] : ['admin']);
        trace.namespace = namespace;
        if (endpoint === 'metrics' && req.method === 'GET') return json(res, 200, metrics.get(namespace));
        const route = /^rules(?:\/?|\/([A-Za-z0-9_-]+)(?:\/(state|versions)(?:\/([1-9][0-9]*))?)?)$/.exec(endpoint);
        if (!route || (route[3] && route[2] !== 'versions')) return routeMissing();
        return await manage(req, res, store, namespace, route, queryParams(rawQuery), subject, trace);
      }
      return routeMissing();
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', '服务内部错误');
      const missed = failure.code === 'MOCK_RULE_NOT_FOUND';
      trace.outcome = missed ? 'miss' : 'error';
      trace.code = failure.code;
      trace.status = failure.status;
      if (counters) counters[missed ? 'misses' : 'errors'] += 1;
      if (!res.headersSent && !res.destroyed) {
        json(res, failure.status, { error: { code: failure.code, message: failure.message, ...failure.details } },
          failure.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      } else if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      req.resume();
      if (trace.event) {
        trace.status ??= res.headersSent ? res.statusCode : null;
        trace.durationMs = Math.round(performance.now() - started);
        try {
          log(trace);
        } catch {
          // 日志接收器故障不改变请求结果。
        }
      }
    }
  });
  server.once('close', () => store.close());
  return server;
}

if (require.main === module) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
    const server = createMockServer({
      database: process.env.MOCK_DB ?? 'mock.sqlite',
      namespaces: parseJson(process.env.MOCK_NAMESPACES ?? '[]'),
      tokens: parseJson(process.env.MOCK_TOKENS ?? '[]'),
    });
    server.on('error', () => {
      console.error('监听失败');
      process.exitCode = 1;
    });
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Mock 服务已启动，端口 ${port}`));
  } catch {
    console.error('启动失败，请检查端口、SQLite 文件、MOCK_NAMESPACES 和 MOCK_TOKENS');
    process.exitCode = 1;
  }
}

module.exports = { createMockServer };
