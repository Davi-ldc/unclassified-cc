import { loadConfig } from './config.js'
import { setLogLevel, log } from './logger.js'
import { startProxy } from './proxy.js'

try {
  const config = loadConfig(process.argv[2])
  setLogLevel(config.logging.level)
  const server = startProxy(config)
  server.on('error', () => {
    log('error', 'Gateway could not listen on the configured address')
    process.exitCode = 1
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close()
      const timer = setTimeout(() => server.closeAllConnections(), 5_000)
      timer.unref()
    })
  }
} catch (error) {
  console.error(`Fatal: ${error instanceof Error ? error.message : 'Gateway startup failed'}`)
  process.exitCode = 1
}
