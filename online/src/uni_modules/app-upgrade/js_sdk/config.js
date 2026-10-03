import { validateCheckUrl } from './contract.js'

const DEFAULTS = Object.freeze({ timeout: 10000 })

export function resolveOptions(options = {}) {
  const merged = { ...DEFAULTS, ...options }
  const configuredUrl = typeof process.env.VUE_APP_UPGRADE_CHECK_URL === 'string'
    ? process.env.VUE_APP_UPGRADE_CHECK_URL.trim()
    : ''
  merged.enabled = Boolean(configuredUrl)
  merged.checkUrl = configuredUrl ? validateCheckUrl(configuredUrl) : ''
  return merged
}