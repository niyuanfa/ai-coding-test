const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const { test } = require('node:test')
const { loadConfig } = require('../src/config.cjs')

async function startService(t, port) {
  const child = spawn(process.execPath, [join(__dirname, '../src/index.cjs')], {
    env: { ...process.env, PORT: String(port), DEFAULT_TIMEOUT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })

  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code, signal]) => {
        throw new Error(`服务在监听前退出（${code ?? signal}）: ${stderr}`)
      }),
    ])
    const record = JSON.parse(line)
    assert.equal(record.event, 'listening')
    assert.ok(record.port > 0)

    return {
      port: record.port,
      async stop(signal) {
        assert.equal(child.kill(signal), true)
        assert.deepEqual(await closed, [0, null])
        assert.equal(stderr, '')
      },
    }
  } finally {
    lines.close()
    child.stdout.resume()
  }
}

async function assertHealthy(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3000),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json\b/)
  assert.deepEqual(await response.json(), { status: 'ok' })
}

test('读取默认配置和环境变量覆盖值', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, timeoutMs: 5000 })
  assert.deepEqual(loadConfig({ PORT: '0', DEFAULT_TIMEOUT_MS: '250' }), {
    port: 0,
    timeoutMs: 250,
  })
})

test('拒绝非法端口和超时', () => {
  for (const port of ['', '-1', '1.5', '65536', 'abc']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/)
  }
  for (const timeout of ['0', 'NaN', '2147483648']) {
    assert.throws(() => loadConfig({ DEFAULT_TIMEOUT_MS: timeout }), /DEFAULT_TIMEOUT_MS/)
  }
})

test('健康检查、404、信号退出及同端口重启', { timeout: 15000 }, async (t) => {
  const first = await startService(t, 0)
  await assertHealthy(first.port)

  const missing = await fetch(`http://127.0.0.1:${first.port}/missing`, {
    signal: AbortSignal.timeout(3000),
  })
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'Not Found' })
  await first.stop('SIGTERM')

  const second = await startService(t, first.port)
  assert.equal(second.port, first.port)
  await assertHealthy(second.port)
  await second.stop('SIGINT')
})
