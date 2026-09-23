import { validateCheckUrl } from './contract.js'

const DEFAULTS = Object.freeze({
  timeout: 10000,
  autoDownload: false,
  allowHttp: process.env.NODE_ENV !== 'production',
  allowedDownloadHosts: []
})

export function resolveOptions(options = {}) {
  const merged = {
    ...DEFAULTS,
    ...options,
    allowedDownloadHosts: Array.isArray(options.allowedDownloadHosts) ? options.allowedDownloadHosts.slice() : []
  }
  merged.checkUrl = validateCheckUrl(process.env.VUE_APP_UPGRADE_CHECK_URL, merged.allowHttp)
  return merged
}