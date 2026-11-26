const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createMockServer } = require('../src/server.cjs');

const tokens = [
  { token: 'admin-test', subject: 'admin', grants: { qa: ['admin'] } },
  { token: 'observer-test', subject: 'observer', grants: { qa: ['observer'] } },
  { token: 'invoke-test', subject: 'client', grants: { qa: ['invoke'] } },
];
const base = '/api/v1/namespaces/qa/rules';
const sample = { name: 'example', match: { method: 'GET', path: '/item' }, response: { status: 200, body: 'first' } };

async function start(t, database = ':memory:') {
  const logs = [];
  const server = createMockServer({ database, namespaces: ['qa', 'other'], tokens, log: (entry) => logs.push(entry) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  function close() {
    return new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    }));
  }
  t.after(close);
  function request(method, path, { token = 'admin-test', body, raw, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = { ...headers };
      if (token) outgoing.authorization = `Bearer ${token}`;
      const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      if (payload !== undefined) {
        outgoing['content-type'] ??= 'application/json';
        outgoing['content-length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: outgoing }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const type = res.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
            const body = text && type === 'application/json' ? JSON.parse(text) : text || undefined;
            resolve({ status: res.statusCode, headers: res.headers, text, body });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const create = (body = sample, key = 'sample') => request('POST', base, { body, headers: { 'idempotency-key': key } });
  const change = (path, body, revision) => request('PUT', path, { body, headers: { 'if-match': `"${revision}"` } });
  const enable = (path, version, revision) => change(`${path}/state`, { state: 'enabled', version }, revision);
  const call = (path = '/item', options = {}) => request(options.method ?? 'GET', `/mock/qa${path}`, { token: 'invoke-test', ...options });
  return { call, change, close, create, enable, logs, request, server };
}

function error(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.error.code, code);
}

async function databaseFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mock-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'test.sqlite');
}

test('创建、筛选、写入前置条件、版本切换、停用和软删除', async (t) => {
  const filename = await databaseFile(t);
  const service = await start(t, filename);
  const { call, change, create, enable, request } = service;
  const first = await create({ ...sample, description: '版本一' });
  const location = first.headers.location;
  assert.equal(first.status, 201);
  assert.equal(first.headers.etag, '"1"');
  assert.deepEqual([first.body.state, first.body.activeVersion, first.body.latestVersion], ['disabled', null, 1]);
  assert.equal((await request('GET', `${base}?name=example&state=disabled`)).body.items.length, 1);
  assert.equal((await request('GET', `${base}?name=other`)).body.items.length, 0);
  assert.deepEqual((await request('GET', location)).body, first.body);
  error(await call(), 404, 'MOCK_RULE_NOT_FOUND');
  error(await request('PUT', `${location}/state`, { body: { state: 'disabled' } }), 428, 'PRECONDITION_REQUIRED');
  error(await enable(location, 2, 1), 404, 'VERSION_NOT_FOUND');
  error(await change(`${location}/state`, { state: 'deleted' }, 1), 400, 'INVALID_CONFIG');
  error(await request('GET', `${base}/missing`), 404, 'RULE_NOT_FOUND');
  const active = await enable(location, 1, 1);
  assert.equal(active.headers.etag, '"2"');
  assert.equal((await enable(location, 1, 2)).headers.etag, '"2"');
  assert.equal((await call()).body, 'first');
  const update = { match: sample.match, response: { status: 200, body: 'second' } };
  const changed = await change(location, update, 2);
  assert.deepEqual([changed.body.latestVersion, changed.body.activeVersion, changed.body.description], [2, 1, '版本一']);
  assert.equal((await change(location, { ...update, priority: 0 }, 3)).headers.etag, '"3"');
  assert.equal((await request('GET', `${location}/versions/1`)).body.response.body, 'first');
  assert.equal((await request('GET', `${location}/versions/2`)).body.response.body, 'second');
  assert.deepEqual((await request('GET', `${location}/versions`)).body.items.map((item) => item.version), [2, 1]);
  assert.equal((await call()).body, 'first');
  assert.equal((await enable(location, 2, 3)).headers.etag, '"4"');
  assert.equal((await call()).body, 'second');
  error(await change(`${location}/state`, { state: 'disabled' }, 3), 412, 'REVISION_MISMATCH');
  assert.equal((await enable(location, 1, 4)).headers.etag, '"5"');
  assert.equal((await request('GET', location)).body.activeVersion, 1);
  assert.equal((await call()).body, 'first');
  assert.equal((await change(`${location}/state`, { state: 'disabled' }, 5)).headers.etag, '"6"');
  error(await call(), 404, 'MOCK_RULE_NOT_FOUND');
  assert.equal((await enable(location, 1, 6)).headers.etag, '"7"');
  assert.equal((await request('DELETE', location, { headers: { 'if-match': '"7"' } })).status, 204);
  error(await call(), 404, 'MOCK_RULE_NOT_FOUND');
  error(await request('GET', `${location}/versions`), 404, 'RULE_NOT_FOUND');
  await service.close();
  const restarted = await start(t, filename);
  error(await restarted.request('GET', location), 404, 'RULE_NOT_FOUND');
  const replay = await restarted.create({ description: '版本一', ...sample });
  assert.equal(replay.headers.etag, '"1"');
  assert.equal(replay.body.id, first.body.id);
  const db = new DatabaseSync(filename);
  try {
    const entry = JSON.parse(db.prepare('SELECT data FROM mock_state').get().data).rules[first.body.id];
    assert.equal(entry.rule.state, 'deleted');
    assert.equal(entry.versions.length, 2);
    assert.deepEqual(entry.audit.map(({ revision }) => revision), [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    db.close();
  }
});

test('拒绝非法配置，幂等键重放按主体和命名空间隔离', async (t) => {
  const { create, request } = await start(t);
  error(await request('POST', base, { body: sample }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const invalid = await create({ ...sample, response: {} });
  error(invalid, 400, 'INVALID_CONFIG');
  assert.equal(invalid.body.error.fields[0].field, '/response/status');
  for (const input of [
    { ...sample, id: 'invalid/id' },
    { ...sample, name: '' },
    { ...sample, response: { status: 200, headers: { 'X-Test': 'a', 'x-test': 'b' } } },
    { ...sample, response: { status: 200, headers: { 'X-Test': 'a\rb' } } },
    { ...sample, response: { status: 200, headers: { 'Transfer-Encoding': 'chunked' } } },
    { ...sample, response: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'hi' } },
    { ...sample, response: { status: 204, body: null } },
    { ...sample, response: { status: 200, delayMs: 5001 } },
    { ...sample, match: { ...sample.match, method: 'HEAD' } },
    { ...sample, match: { ...sample.match, headers: { Authorization: 'secret' } } },
    { ...sample, match: { ...sample.match, jsonBody: { '/bad~2pointer': 1 } } },
  ]) error(await create(input), 400, 'INVALID_CONFIG');
  error(await request('POST', base, { raw: '{"x":1,"\\u0078":2}', headers: { 'idempotency-key': 'sample' } }), 400, 'INVALID_CONFIG');
  assert.equal((await request('GET', base)).body.items.length, 0);
  const [left, right] = await Promise.all([create(), create()]);
  assert.equal(left.status, 201);
  assert.equal(right.status, 201);
  assert.equal(left.body.id, right.body.id);
  assert.equal((await request('GET', base)).body.items.length, 1);
  error(await create({ ...sample, name: 'different' }), 409, 'IDEMPOTENCY_KEY_REUSED');
});

test('显式 ID 创建、并发冲突、幂等重放与软删除后保留', async (t) => {
  const { change, create, request } = await start(t);
  const input = { ...sample, id: 'item_42' };
  const keys = ['item-create', 'item-conflict'];
  const results = await Promise.all(keys.map((key) => create(input, key)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
  const winner = results.findIndex(({ status }) => status === 201);
  const first = results[winner];
  error(results[1 - winner], 409, 'DUPLICATE_RULE_ID');
  assert.equal(first.body.id, input.id);
  assert.equal(first.headers.location, `${base}/${input.id}`);
  assert.deepEqual((await request('GET', first.headers.location)).body, first.body);
  const replay = await create(input, keys[winner]);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.etag, first.headers.etag);
  assert.deepEqual(replay.body, first.body);
  error(await create({ ...input, name: 'other' }, keys[winner]), 409, 'IDEMPOTENCY_KEY_REUSED');
  const invalid = await create({ ...input, id: null }, 'invalid-id');
  error(invalid, 400, 'INVALID_CONFIG');
  assert.equal(invalid.body.error.fields[0].field, '/id');
  error(await change(first.headers.location, { id: 'other', match: input.match, response: input.response }, 1), 400, 'INVALID_CONFIG');
  assert.equal((await request('DELETE', first.headers.location, { headers: { 'if-match': '"1"' } })).status, 204);
  error(await create(input, 'item-after-delete'), 409, 'DUPLICATE_RULE_ID');
  error(await request('GET', first.headers.location), 404, 'RULE_NOT_FOUND');
});

test('UTF-8 纯文本响应保留原始内容，JSON 字符串继续序列化', async (t) => {
  const { call, change, create, enable, request } = await start(t);
  const text = '你好 "mock"\n第二行';
  const response = { status: 503, format: 'text', body: text, headers: { 'X-Scenario': 'maintenance' } };
  const first = await create({ ...sample, response });
  assert.equal(first.status, 201);
  const rule = first.headers.location;
  assert.equal((await request('GET', `${rule}/versions/1`)).body.response.format, 'text');
  assert.equal((await enable(rule, 1, 1)).status, 200);
  const hit = await call();
  assert.equal(hit.status, 503);
  assert.equal(hit.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(hit.headers['x-scenario'], 'maintenance');
  assert.equal(hit.text, text);

  for (const [override, field] of [
    [{ format: 'xml' }, '/response/format'],
    [{ body: null }, '/response/body'],
    [{ status: 204 }, '/response/body'],
    [{ headers: { 'Content-Type': 'application/json' } }, '/response/headers'],
    [{ headers: { 'Content-Type': 'text/plain; charset=iso-8859-1' } }, '/response/headers'],
  ]) {
    const invalid = await change(rule, { match: sample.match, response: { ...response, ...override } }, 2);
    error(invalid, 400, 'INVALID_CONFIG');
    assert.equal(invalid.body.error.fields[0].field, field);
  }

  const jsonResponse = { status: 200, format: 'json', body: text };
  assert.equal((await change(rule, { match: sample.match, response: jsonResponse }, 2)).headers.etag, '"3"');
  assert.equal((await enable(rule, 2, 3)).status, 200);
  const jsonHit = await call();
  assert.equal(jsonHit.headers['content-type'], 'application/json');
  assert.equal(jsonHit.text, JSON.stringify(text));
  assert.equal(jsonHit.body, text);
});

test('全部匹配条件、优先级、冲突及原始路径和 JSON 边界', async (t) => {
  const { call, create, enable } = await start(t);
  const path = '/pay/%2F';
  const match = { method: 'POST', path, query: { key: '中 +/' }, headers: { 'X-Mode': ' one, two ' }, jsonBody: { '/a~1b/0/~0': null, '/count': 1 } };
  const conditional = await create({ name: 'conditional', match, response: { status: 422, body: { code: 'DECLINED' } }, priority: 10 });
  const conflict = await create({ name: 'conflict', match: { method: 'POST', path }, response: { status: 200 }, priority: 10 }, 'conflict');
  assert.equal((await enable(conditional.headers.location, 1, 1)).status, 200);
  const rejected = await enable(conflict.headers.location, 1, 1);
  error(rejected, 409, 'RULE_CONFLICT');
  assert.equal(rejected.body.error.conflictingRuleId, conditional.body.id);
  const options = { method: 'POST', headers: { 'X-MODE': [' one ', 'two'] }, body: { 'a/b': [{ '~': null }], count: 1 } };
  const query = '?key=%E4%B8%AD+%2B%2F';
  const url = path + query;
  const hit = await call(url, options);
  assert.equal(hit.status, 422);
  assert.deepEqual(hit.body, { code: 'DECLINED' });
  for (const [target, overrides] of [
    [url, { method: 'GET' }], [path + '/' + query, {}], ['/pay/%2f' + query, {}],
    [path, {}], [url + '&key=extra', {}], [url, { headers: {} }],
    [url, { raw: '' }], [url, { raw: '{' }],
    [url, { raw: '{"a/b":[{"~":null}],"count":1,"count":1}' }],
    [url, { body: { 'a/b': [{}], count: 1 } }],
    [url, { body: { 'a/b': [{ '~': null }], count: '1' } }],
  ]) error(await call(target, { ...options, ...overrides }), 404, 'MOCK_RULE_NOT_FOUND');
  error(await call(path + '?key=%FF', options), 400, 'INVALID_REQUEST');
  error(await call(path + '?key=%G0', options), 400, 'INVALID_REQUEST');
  const fallback = await create({ name: 'fallback', match: { method: 'POST', path }, response: { status: 204 } }, 'fallback');
  assert.equal((await enable(fallback.headers.location, 1, 1)).status, 200);
  assert.equal((await call(url, { ...options, raw: '{' })).status, 204);
  assert.equal((await call(url, options)).status, 422);
});

test('延迟响应使用匹配开始时的版本，后续请求使用新版本', async (t) => {
  const { call, change, create, enable, server } = await start(t);
  const original = await create({ ...sample, response: { status: 503, headers: { 'Retry-After': '2' }, body: { code: 'OFFLINE' }, delayMs: 300 } });
  const rule = original.headers.location;
  await enable(rule, 1, 1);
  await change(rule, { match: sample.match, response: { status: 200, body: null } }, 2);
  const received = new Promise((resolve) => {
    function onRequest(req) {
      if (req.url !== '/mock/qa/item') return;
      server.off('request', onRequest);
      resolve();
    }
    server.on('request', onRequest);
  });
  const started = performance.now();
  const pending = call();
  await received;
  assert.equal((await enable(rule, 2, 3)).status, 200);
  const fresh = await call();
  assert.equal(fresh.status, 200);
  assert.equal(fresh.text, 'null');
  assert.equal(fresh.headers['content-type'], 'application/json');
  const previous = await pending;
  assert.equal(previous.status, 503);
  assert.equal(previous.headers['retry-after'], '2');
  assert.deepEqual(previous.body, { code: 'OFFLINE' });
  assert.ok(performance.now() - started >= 290);
});

test('鉴权隔离、日志脱敏、请求关联、指标和内部故障', async (t) => {
  const filename = await databaseFile(t);
  const { call, create, enable, logs, request } = await start(t, filename);
  const created = await create();
  const rule = created.headers.location;
  await enable(rule, 1, 1);
  error(await call('/item', { token: null }), 401, 'UNAUTHENTICATED');
  error(await call('/item', { token: 'unknown-secret' }), 401, 'UNAUTHENTICATED');
  error(await call('/item', { token: 'admin-test' }), 403, 'FORBIDDEN');
  error(await request('GET', '/mock/other/item', { token: 'invoke-test' }), 403, 'FORBIDDEN');
  error(await request('POST', base, { token: 'invoke-test', body: sample }), 403, 'FORBIDDEN');
  error(await request('DELETE', rule, { token: 'observer-test' }), 403, 'FORBIDDEN');
  assert.equal((await request('GET', rule, { token: 'observer-test' })).status, 200);
  const hit = await call('/item', { headers: { cookie: 'password=hidden-cookie' } });
  assert.equal(hit.text, '"first"');
  await call('/item');
  const miss = await call('/missing?password=hidden-query', { method: 'POST', body: { password: 'hidden-body' } });
  error(miss, 404, 'MOCK_RULE_NOT_FOUND');
  error(await call('/item?key=%FF'), 400, 'INVALID_REQUEST');
  const db = new DatabaseSync(filename);
  let corrupted;
  let internal;
  try {
    const data = JSON.parse(db.prepare('SELECT data FROM mock_state').get().data);
    const save = db.prepare('UPDATE mock_state SET data = ?');
    data.rules[created.body.id].versions[0].response.status = 'hidden-config';
    save.run(JSON.stringify(data));
    corrupted = await call();
    save.run('hidden-storage-error');
    internal = await call();
  } finally {
    db.close();
  }
  error(corrupted, 500, 'INVALID_RESPONSE_CONFIG');
  error(internal, 500, 'INTERNAL_ERROR');
  for (const [result, outcome] of [[hit, 'hit'], [miss, 'miss'], [corrupted, 'error'], [internal, 'error']]) {
    const log = logs.find(({ requestId }) => requestId === result.headers['x-request-id']);
    assert.equal(log.outcome, outcome);
    assert.equal(log.status, result.status);
    assert.equal(log.event, 'mock_call');
  }
  assert.equal(logs.find(({ requestId }) => requestId === hit.headers['x-request-id']).ruleId, created.body.id);
  assert.ok(logs.some(({ action, changed }) => action === 'create' && changed));
  assert.doesNotMatch(JSON.stringify(logs) + miss.text + corrupted.text + internal.text, /hidden-|invoke-test|admin-test|unknown-secret|SyntaxError/);
  const metrics = await request('GET', '/api/v1/namespaces/qa/metrics', { token: 'observer-test' });
  assert.deepEqual(metrics.body, { calls: 6, hits: 2, misses: 1, errors: 3 });
});
