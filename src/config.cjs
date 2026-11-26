const { validateHeaderName, validateHeaderValue } = require('node:http');

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const reservedHeaders = new Set([
  'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'x-request-id',
]);

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalid(field, reason) {
  throw new ApiError(400, 'INVALID_CONFIG', '规则配置无效', {
    fields: [{ field, reason }],
  });
}

function pointerSegment(key) {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function object(value, field, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, '必须是对象');
  }
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(field, '包含未知字段');
  }
  return value;
}

function integer(value, low, high, field) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    invalid(field, `必须是 ${low} 到 ${high} 之间的整数`);
  }
  return value;
}

function parseJson(text) {
  const parsed = JSON.parse(text, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new SyntaxError('JSON number out of range');
    }
    return value;
  });

  // JSON.parse 已检查语法。此处只跟踪容器和字段名，保留重复键信息。
  const containers = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"\s*:?|[{}\[\]]/g;
  for (const [token] of text.matchAll(tokens)) {
    if (token === '{') containers.push(new Set());
    else if (token === '[') containers.push(null);
    else if (token === '}' || token === ']') containers.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1));
      const keys = containers.at(-1);
      if (keys.has(key)) throw new SyntaxError('Duplicate JSON key');
      keys.add(key);
    }
  }
  return parsed;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function mediaType(value) {
  return value?.split(';', 1)[0].trim().toLowerCase();
}

function trimHeader(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

function headerMap(value, field, matching) {
  const headers = Object.create(null);
  if (value === undefined) return headers;
  for (const [name, raw] of Object.entries(object(value, field))) {
    const key = name.toLowerCase();
    if (Object.hasOwn(headers, key) || (matching ? key === 'authorization' : reservedHeaders.has(key))) {
      invalid(field, '包含重复或禁止配置的头');
    }
    if (typeof raw !== 'string') invalid(field, '头值必须是字符串');
    try {
      validateHeaderName(name);
      validateHeaderValue(name, raw);
    } catch {
      invalid(field, '包含非法 HTTP 头');
    }
    headers[key] = matching ? trimHeader(raw) : raw;
  }
  return headers;
}

function versionConfig(input, defaultDescription = '') {
  const description = Object.hasOwn(input, 'description') ? input.description : defaultDescription;
  if (typeof description !== 'string') invalid('/description', '必须是字符串');
  const match = object(input.match, '/match', ['method', 'path', 'query', 'headers', 'jsonBody']);
  const { method, path } = match;
  if (!methods.has(method)) invalid('/match/method', '不支持的 HTTP 方法');
  if (typeof path !== 'string' || !/^\/[\x21-\x7e]*$/.test(path) || /[?#*{}]/.test(path)) {
    invalid('/match/path', '必须是无查询串、片段或模板的绝对 URL 路径');
  }
  const query = Object.hasOwn(match, 'query') ? object(match.query, '/match/query') : {};
  if (Object.values(query).some((value) => typeof value !== 'string')) {
    invalid('/match/query', '参数值必须是字符串');
  }
  const jsonBody = Object.hasOwn(match, 'jsonBody') ? object(match.jsonBody, '/match/jsonBody') : {};
  for (const [key, value] of Object.entries(jsonBody)) {
    if (!key.startsWith('/') || /~(?![01])/.test(key) || (value !== null && typeof value === 'object')) {
      invalid(`/match/jsonBody/${pointerSegment(key)}`, '必须使用 JSON Pointer 和 JSON 标量');
    }
  }
  const response = object(input.response, '/response', ['status', 'headers', 'body', 'delayMs', 'format']);
  const status = integer(response.status, 200, 599, '/response/status');
  const headers = headerMap(response.headers, '/response/headers', false);
  const delayMs = response.delayMs === undefined ? 0 : integer(response.delayMs, 0, 5000, '/response/delayMs');
  const { format = 'json' } = response;
  if (format !== 'json' && format !== 'text') invalid('/response/format', '必须是 json 或 text');
  const normalizedResponse = { status, headers, delayMs };
  if (format === 'text') normalizedResponse.format = format;
  if (Object.hasOwn(response, 'body')) {
    if (method === 'HEAD' || [204, 205, 304].includes(status)) {
      invalid('/response/body', '此方法或状态码禁止响应体');
    }
    if (format === 'text' && typeof response.body !== 'string') {
      invalid('/response/body', '文本响应体必须是字符串');
    }
    const expectedType = format === 'text' ? 'text/plain' : 'application/json';
    const contentType = headers['content-type'];
    if (contentType !== undefined && (
      mediaType(contentType) !== expectedType ||
      contentType.split(';').slice(1).some((parameter) => (
        /^\s*charset\b/i.test(parameter) && !/^\s*charset\s*=\s*(utf-8|"utf-8")\s*$/i.test(parameter)
      ))
    )) {
      invalid('/response/headers', `带响应体时需要 UTF-8 ${expectedType}`);
    }
    normalizedResponse.body = response.body;
  }
  return {
    description,
    match: { method, path, query, headers: headerMap(match.headers, '/match/headers', true), jsonBody },
    response: normalizedResponse,
    priority: input.priority === undefined ? 0 : integer(input.priority, 0, 1000, '/priority'),
  };
}

module.exports = { ApiError, canonical, integer, invalid, mediaType, object, parseJson, trimHeader, versionConfig };
