const http = require('node:http')
const { performance } = require('node:perf_hooks')

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function route(request, response, path) {
  if (request.method === 'GET' && path === '/health') {
    sendJson(response, 200, { status: 'ok' })
    return
  }

  sendJson(response, 404, { error: 'Not Found' })
}

function createServer({ timeoutMs }) {
  const server = http.createServer({ requestTimeout: timeoutMs }, (request, response) => {
    const path = request.url.split('?', 1)[0]
    const startedAt = performance.now()

    response.once('finish', () => {
      console.log(JSON.stringify({
        event: 'request',
        method: request.method,
        path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      }))
    })

    try {
      route(request, response, path)
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', message: error.message }))
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendJson(response, 500, { error: 'Internal Server Error' })
    }
  })

  server.setTimeout(timeoutMs)
  return server
}

module.exports = { createServer }
