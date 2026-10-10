import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'
import { HttpsProxyAgent } from 'https-proxy-agent'

export function bypassProxy(target: URL, noProxy: string): boolean {
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')

  return noProxy.split(/[,\s]+/).some((entry) => {
    entry = entry.toLowerCase()
    if (!entry) return false
    if (entry === '*') return true
    if (entry === hostname || entry === `[${hostname}]`) return true

    const withPort = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
    if (withPort) {
      if (withPort[2] !== port) return false
      entry = withPort[1]
    }
    entry = entry.replace(/^\[|\]$/g, '')
    if (entry.startsWith('*.')) entry = entry.slice(1)
    if (entry.startsWith('.')) {
      return hostname === entry.slice(1) || hostname.endsWith(entry)
    }
    return hostname === entry
  })
}

export function createUpstreamAgent(target: URL, env: NodeJS.ProcessEnv = process.env): HttpAgent {
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? ''
  const proxyUrl = target.protocol === 'https:'
    ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
    : env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY

  if (proxyUrl && !bypassProxy(target, noProxy)) {
    const proxy = new URL(proxyUrl)
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      throw new Error('Outbound proxy must use HTTP or HTTPS')
    }
    return new HttpsProxyAgent(proxy, { keepAlive: true })
  }
  return target.protocol === 'https:'
    ? new HttpsAgent({ keepAlive: true })
    : new HttpAgent({ keepAlive: true })
}
