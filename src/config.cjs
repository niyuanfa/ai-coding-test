function readInteger(env, name, defaultValue, min, max) {
  const raw = env[name]
  if (raw === undefined) return defaultValue

  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value
}

function loadConfig(env = process.env) {
  return {
    port: readInteger(env, 'PORT', 3000, 0, 65535),
    timeoutMs: readInteger(env, 'DEFAULT_TIMEOUT_MS', 5000, 1, 2147483647),
  }
}

module.exports = { loadConfig }
