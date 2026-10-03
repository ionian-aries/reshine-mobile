const ACTION_CLAIM = 'com.honeywell.aidc.action.ACTION_CLAIM_SCANNER'
const ACTION_RELEASE = 'com.honeywell.aidc.action.ACTION_RELEASE_SCANNER'
const ACTION_CONTROL = 'com.honeywell.aidc.action.ACTION_CONTROL_SCANNER'
const EXTRA_SCANNER = 'com.honeywell.aidc.extra.EXTRA_SCANNER'
const EXTRA_PROFILE = 'com.honeywell.aidc.extra.EXTRA_PROFILE'
const EXTRA_PROPERTIES = 'com.honeywell.aidc.extra.EXTRA_PROPERTIES'
const EXTRA_SCAN = 'com.honeywell.aidc.extra.EXTRA_SCAN'
const EXTRA_AIM = 'com.honeywell.aidc.extra.EXTRA_AIM'
const EXTRA_LIGHT = 'com.honeywell.aidc.extra.EXTRA_LIGHT'
const EXTRA_DECODE = 'com.honeywell.aidc.extra.EXTRA_DECODE'
const PROP_DATA_INTENT = 'DPR_DATA_INTENT'
const PROP_DATA_INTENT_ACTION = 'DPR_DATA_INTENT_ACTION'
const SVC_PACKAGE = 'com.intermec.datacollectionservice'
const SCANNERS = { internal: 'dcs.scanner.imager', external: 'dcs.scanner.ring' }
const emptyData = () => ({ data: '', codeId: '', aimId: '', charset: '' })
const result = (status, code, message = '', data = emptyData()) => ({ status, code, message, data })
const text = error => String(error && (error.message || error) || 'unknown')
let sequence = 0

export function createHoneywellScanService(options = {}) {
  const android = options.android || (() => typeof plus !== 'undefined' && plus.android)()
  let session = null
  const bundle = entries => { const value = android.newObject('android.os.Bundle'); entries.forEach(([method, key, item]) => android.invoke(value, method, key, item)); return value }
  const broadcast = (main, action, extras) => { const intent = android.newObject('android.content.Intent', action); android.invoke(intent, 'setPackage', SVC_PACKAGE); if (extras) android.invoke(intent, 'putExtras', extras); android.invoke(main, 'sendBroadcast', intent) }
  const cleanup = current => {
    if (current.cleaned) return
    current.cleaned = true
    if (session === current) session = null
    if (current.timer) clearTimeout(current.timer)
    current.timer = null
    if (current.soft && current.claimed) { try { broadcast(current.main, ACTION_CONTROL, bundle([['putBoolean', EXTRA_SCAN, false]])) } catch (_) {} }
    if (current.claimed) { try { broadcast(current.main, ACTION_RELEASE) } catch (_) {} }
    if (current.registered && current.receiver) { try { android.invoke(current.main, 'unregisterReceiver', current.receiver) } catch (_) {} }
    current.registered = false; current.receiver = null; current.claimed = false
  }
  const settle = (current, value) => { if (current.settled) return; current.settled = true; cleanup(current); current.resolve(value) }
  const failUnavailable = message => result('unsupported', 'SCAN_RECEIVER_UNAVAILABLE', message)
  function start(params = {}) {
    return new Promise(resolve => {
      if (!android) return resolve(result('unsupported', 'UNSUPPORTED', 'plus.android unavailable'))
      if (session && !session.settled) return resolve(result('error', 'SCAN_BUSY', '已有扫码会话正在进行'))
      const main = android.runtimeMainActivity()
      let target = 0
      try { target = Number(android.getAttribute(android.invoke(main, 'getApplicationInfo'), 'targetSdkVersion')) || 0 } catch (_) {}
      if (target >= 34) return resolve(failUnavailable(`targetSdkVersion=${target} 无法安全注册动态广播接收器`))
      const soft = params.softTrigger !== false
      const timeout = params.timeout > 0 ? params.timeout : (soft ? 15000 : 120000)
      const action = `io.dcloud.uniplugin.honeyscan.action.BARCODE_DATA.${++sequence}`
      const current = { resolve, main, soft, timer: null, receiver: null, registered: false, claimed: false, settled: false, cleaned: false }
      session = current
      try {
        current.receiver = android.implements('io.dcloud.android.content.BroadcastReceiver', { onReceive: (_context, intent) => {
          try {
            if (android.invoke(intent, 'getAction') !== action) return
            const get = key => android.invoke(intent, 'getStringExtra', key) || ''
            settle(current, result('success', 'OK', '', { data: get('data'), codeId: get('codeId'), aimId: get('aimId'), charset: get('charset') }))
          } catch (error) { settle(current, result('error', 'SCAN_ERROR', `read barcode failed: ${text(error)}`)) }
        } })
        android.invoke(main, 'registerReceiver', current.receiver, android.newObject('android.content.IntentFilter', action))
        current.registered = true
      } catch (error) { settle(current, failUnavailable(`registerReceiver failed: ${text(error)}`)); return }
      try {
        const properties = bundle([['putBoolean', PROP_DATA_INTENT, true], ['putString', PROP_DATA_INTENT_ACTION, action]])
        const claim = [['putBundle', EXTRA_PROPERTIES, properties]]
        if (SCANNERS[params.scanner]) claim.push(['putString', EXTRA_SCANNER, SCANNERS[params.scanner]])
        if (params.profile) claim.push(['putString', EXTRA_PROFILE, params.profile])
        broadcast(main, ACTION_CLAIM, bundle(claim)); current.claimed = true
      } catch (error) { settle(current, result('error', 'SCAN_ERROR', `claim broadcast failed: ${text(error)}`)); return }
      if (soft) { try { broadcast(main, ACTION_CONTROL, bundle([['putBoolean', EXTRA_SCAN, true], ['putBoolean', EXTRA_AIM, true], ['putBoolean', EXTRA_LIGHT, true], ['putBoolean', EXTRA_DECODE, true]])) } catch (_) {} }
      current.timer = setTimeout(() => settle(current, result('error', 'SCAN_TIMEOUT', 'scan timeout')), timeout)
    })
  }
  function cancel(reason = '') {
    const current = session
    if (!current || current.settled) return Promise.resolve(result('error', 'SCAN_ERROR', 'no active scan', {}))
    settle(current, result('error', 'SCAN_CANCELLED', reason, emptyData()))
    return Promise.resolve(result('success', 'OK', '', {}))
  }
  async function destroy(reason = 'destroyed') { if (session && !session.settled) await cancel(reason) }
  return { start, cancel, destroy, get active() { return !!(session && !session.settled) } }
}