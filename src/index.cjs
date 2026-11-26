const { loadConfig } = require('./config.cjs')
const { createServer } = require('./server.cjs')

function reportError(error) {
  console.error(JSON.stringify({ event: 'server_error', message: error.message }))
  process.exitCode = 1
}

function start() {
  const config = loadConfig()
  const server = createServer(config)
  let stopping = false

  function shutdown() {
    if (stopping) return
    stopping = true
    server.close((error) => {
      if (error) {
        reportError(error)
        return
      }
      console.log(JSON.stringify({ event: 'stopped' }))
    })
  }

  server.on('error', reportError)
  server.listen(config.port, () => {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    console.log(JSON.stringify({ event: 'listening', port: server.address().port }))
  })
}

try {
  start()
} catch (error) {
  reportError(error)
}
