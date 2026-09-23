import defaultAdapter from '../adapters/ble-manager-adapter.js'
import { ActionValidationError, boolean, exact, integer, noParams, optionalString, printJob, requiredString, validateImage } from './action-validation.js'
import { isLargeDataUrl } from './transfer-manager.js'
import { readPreviewDataUrl } from './preview-file.js'
import { createHoneywellScanService } from './honeywell-scan.js'

const ok = (data = {}, message = '') => ({ status: 'success', code: 'OK', message, data })
const DATA_DEFAULTS = Object.freeze({
  scan_start: () => ({ data: '', codeId: '', aimId: '', charset: '' }), scan_cancel: () => ({}),
  bluetooth_getState: () => ({ enabled: false }), bluetooth_enable: () => ({ enabled: false, pending: false }), bluetooth_disable: () => ({ enabled: false, pending: false }), bluetooth_search: () => ({ devices: [] }),
  scale_connect: () => ({ deviceId: '', serviceId: '' }), scale_disconnect: () => ({ disconnected: false, alreadyDisconnected: false, deviceId: '' }), scale_status: () => ({ connected: false, busy: false, activeOperation: '', deviceId: '', deviceName: '', serviceId: '', hasStableWeight: false }), scale_readWeight: () => ({ overload: false, stable: false, weight: '', unit: '', weightType: '', raw: '' }),
  printer_connect: () => ({ printer: { deviceId: '', deviceName: '', name: '' } }), printer_disconnect: () => ({ disconnected: false, alreadyDisconnected: false, deviceId: '' }), printer_status: () => ({ connected: false, busy: false, activeJob: '', deviceId: '', deviceName: '' }), printer_print: () => ({}), printer_preview: () => ({ image: '' }),
})
export const businessFailureData = action => (DATA_DEFAULTS[action] || (() => ({})))()
function errorText(error) {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return ''
  for (const key of ['message', 'errMsg', 'errorMessage', 'reason']) if (typeof error[key] === 'string' && error[key].trim()) return error[key].trim()
  return ''
}
function errorCode(error, message) {
  const supplied = error && typeof error === 'object' && (error.code ?? error.errCode)
  if ((typeof supplied === 'string' || typeof supplied === 'number') && String(supplied).trim()) return String(supplied).trim()
  if (/cancel|取消|拒绝关闭/.test(message.toLowerCase())) return 'OPERATION_CANCELLED'
  if (/denied|permission|reject|拒绝|权限/.test(message.toLowerCase())) return 'PERMISSION_DENIED'
  if (/unsupported|not support|unavailable|不支持/.test(message.toLowerCase())) return 'UNSUPPORTED'
  return 'OPERATION_FAILED'
}
function failure(action, error) {
  const rawMessage = errorText(error)
  const code = errorCode(error, rawMessage)
  const message = rawMessage || (code === 'UNSUPPORTED' ? '当前环境不支持此操作' : '操作失败')
  const unsupported = /UNSUPPORTED|UNAVAILABLE|NOT_SUPPORTED/.test(code)
  return { status: unsupported ? 'unsupported' : 'error', code, message, data: businessFailureData(action) }
}
function normalizeEnvelope(action, value) {
  if (!value || typeof value !== 'object' || !['success', 'error', 'unsupported'].includes(value.status)) return value
  if (value.status === 'success') return value
  const normalized = failure(action, value)
  const suppliedData = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : {}
  return Object.assign({}, normalized, { status: value.status === 'unsupported' ? 'unsupported' : 'error', data: Object.assign({}, normalized.data, suppliedData) })
}
function handler(actionName, action) { return async params => { try { return normalizeEnvelope(actionName, await action(params)) } catch (error) { return failure(actionName, error) } } }
function stateDevice(state, key) { return state && state[key] && typeof state[key] === 'object' ? state[key] : {} }
const BLUETOOTH_USER_DECISION_CODES = new Set([
  'OPERATION_CANCELLED', 'PERMISSION_DENIED', 'USER_CANCEL', 'USER_CANCELLED', 'CANCEL', 'CANCELLED',
  'SYSTEM_BLUETOOTH_ENABLE_DENIED', 'SYSTEM_BLUETOOTH_DISABLE_DENIED',
])
function isBluetoothUserDecision(error) {
  const message = errorText(error).toLowerCase()
  const supplied = error && typeof error === 'object' && (error.code ?? error.errCode)
  const code = supplied === undefined || supplied === null ? '' : String(supplied).trim().toUpperCase()
  return BLUETOOTH_USER_DECISION_CODES.has(code) || /user\s*(cancel|denied|reject)|cancelled|canceled|denied|拒绝|取消|未允许/.test(message)
}
async function invokeBluetoothToggle(action, invoke, getState, safeEnabled) {
  try {
    // Start from an already-observed Promise so synchronous throws, native thenables and
    // ordinary Promise rejections all acquire a rejection handler in this turn.
    const state = await Promise.resolve().then(invoke)
    return ok({ enabled: !!(state && state.systemEnabled), pending: false })
  } catch (error) {
    if (!isBluetoothUserDecision(error)) throw error
    let enabled = safeEnabled
    try {
      const state = await Promise.resolve().then(getState)
      if (state && typeof state.systemEnabled === 'boolean') enabled = state.systemEnabled
    } catch (_) { /* The original user-decision error remains the business result. */ }
    const result = failure(action, error)
    result.data = { enabled: !!enabled, pending: false }
    return result
  }
}

export function createBusinessActions(options = {}) {
  const adapter = options.adapter || defaultAdapter
  const scanner = options.scanService || createHoneywellScanService(options.scanOptions)
  const canvasId = requiredString(options.canvasId, 'canvasId')
  let hasStableWeight = false
  let reading = false
  const activeScans = new Set()
  const transfers = options.transfers
  const printOperations = new Map()
  const operationTtl = options.operationTtlMs || 10 * 60 * 1000
  const operationLimit = options.operationLimit || 100
  const pruneOperations = now => {
    for (const [key, value] of printOperations) if (now - value.created >= operationTtl) printOperations.delete(key)
    while (printOperations.size >= operationLimit) printOperations.delete(printOperations.keys().next().value)
  }
  const resolvePrintJob = (params, ctx, preview) => {
    const value = params && params.imageAttachment ? Object.assign({}, params, { image: transfers ? transfers.consume(params.imageAttachment, ctx, preview ? 'printer_preview' : 'printer_print') : '' }) : params
    if (value && value.imageAttachment) delete value.imageAttachment
    return printJob(value, canvasId, preview)
  }

  const actions = {
    scan_start: handler('scan_start', async params => {
      const value = exact(params, ['softTrigger', 'timeout', 'profile', 'scanner'])
      const softTrigger = boolean(value.softTrigger, 'softTrigger', true)
      const timeout = integer(value.timeout, 'timeout', 1, 300000, softTrigger ? 15000 : 120000)
      const profile = optionalString(value.profile, 'profile')
      const scannerName = optionalString(value.scanner, 'scanner') || 'internal'
      if (!['internal', 'external', 'auto'].includes(scannerName)) throw new ActionValidationError('scanner 参数无效', 'INVALID_ARGUMENT')
      return scanner.start({ softTrigger, timeout, profile, scanner: scannerName })
    }),
    scan_cancel: handler('scan_cancel', async params => { noParams(params); return scanner.cancel('') }),
    bluetooth_getState: handler('bluetooth_getState', async params => {
      noParams(params); const state = await adapter.ble.getBluetoothState(); return ok({ enabled: !!state.systemEnabled })
    }),
    bluetooth_enable: async params => {
      try { noParams(params) } catch (error) { return failure('bluetooth_enable', error) }
      return invokeBluetoothToggle('bluetooth_enable', () => adapter.ble.requestEnableSystemBluetooth(), () => adapter.ble.getBluetoothState(), false)
    },
    bluetooth_disable: async params => {
      try { noParams(params) } catch (error) { return failure('bluetooth_disable', error) }
      return invokeBluetoothToggle('bluetooth_disable', () => adapter.ble.requestDisableSystemBluetooth(), () => adapter.ble.getBluetoothState(), true)
    },
    bluetooth_search: handler('bluetooth_search', async params => {
      const value = exact(params, ['name', 'timeout', 'excludeUnnamed'])
      const name = optionalString(value.name, 'name')
      const timeout = integer(value.timeout, 'timeout', 100, 60000, 5000)
      const excludeUnnamed = boolean(value.excludeUnnamed, 'excludeUnnamed', true)
      const devices = new Map(); let scanId = ''
      const collect = device => {
        if (!device || typeof device.deviceId !== 'string' || !device.deviceId) return
        const deviceName = typeof device.name === 'string' ? device.name : ''
        const localName = typeof device.localName === 'string' ? device.localName : ''
        if (excludeUnnamed && !deviceName && !localName) return
        if (name && !`${deviceName} ${localName}`.toLowerCase().includes(name.toLowerCase())) return
        devices.set(device.deviceId, { deviceId: device.deviceId, name: deviceName, localName, rssi: Number.isFinite(device.RSSI) ? device.RSSI : (Number.isFinite(device.rssi) ? device.rssi : 0), connected: !!device.connected, paired: false })
      }
      const unsubscribe = adapter.ble.on('deviceFound', collect)
      try {
        const started = await adapter.ble.startScan({ timeout, allowDuplicatesKey: false })
        scanId = started && typeof started.scanId === 'string' ? started.scanId : ''
        if (!scanId) throw new ActionValidationError('BLE 搜索未返回 scanId', 'SCAN_START_FAILED')
        activeScans.add(scanId); (Array.isArray(started.devices) ? started.devices : []).forEach(collect)
        await new Promise(resolve => setTimeout(resolve, timeout))
        return ok({ devices: Array.from(devices.values()) })
      } finally {
        if (scanId) { activeScans.delete(scanId); await adapter.ble.stopScan(scanId).catch(() => undefined) }
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }),
    scale_connect: handler('scale_connect', async params => {
      const value = exact(params, ['deviceId']); const state = await adapter.scale.connect(requiredString(value.deviceId, 'deviceId')); hasStableWeight = false
      const device = stateDevice(state, 'device'); return ok({ deviceId: device.deviceId || value.deviceId, serviceId: state.serviceId || '' })
    }),
    scale_disconnect: handler('scale_disconnect', async params => {
      noParams(params); const before = await adapter.scale.getState(); const device = stateDevice(before, 'device'); await adapter.scale.disconnect(); hasStableWeight = false
      return ok({ disconnected: true, alreadyDisconnected: !before.connected, deviceId: device.deviceId || '' })
    }),
    scale_status: handler('scale_status', async params => {
      noParams(params); const state = await adapter.scale.getState(); const device = stateDevice(state, 'device')
      return ok({ connected: !!state.connected, busy: !!state.occupied || ['connecting', 'discovering', 'disconnecting'].includes(state.state), activeOperation: state.state || '', deviceId: device.deviceId || '', deviceName: device.name || device.localName || '', serviceId: state.serviceId || '', hasStableWeight })
    }),
    scale_readWeight: handler('scale_readWeight', async params => {
      const value = exact(params, ['timeout']); const timeout = integer(value.timeout, 'timeout', 100, 60000, 5000)
      if (reading) throw new ActionValidationError('称重请求正在执行', 'REQUEST_IN_PROGRESS')
      reading = true
      try {
        const result = await adapter.scale.readWeight(timeout); hasStableWeight = !!result.stable
        return ok({ overload: !!result.overloaded, stable: !!result.stable, weight: String(result.rawWeight ?? result.weight ?? ''), unit: result.unit || '', weightType: result.weightTypeMeaning || result.weightType || '', raw: result.rawFrame || result.raw || '' })
      } finally { reading = false }
    }),
    printer_connect: handler('printer_connect', async params => {
      const value = exact(params, ['deviceId', 'name', 'timeout']); const deviceId = requiredString(value.deviceId, 'deviceId'); const name = optionalString(value.name, 'name'); const timeout = integer(value.timeout, 'timeout', 100, 60000, 12000)
      let state = await adapter.printer.getState(); const current = stateDevice(state, 'printer')
      if (state.ready && current.deviceId === deviceId) return ok({ printer: { deviceId, deviceName: current.name || '', name: current.name || '' } })
      if (current.deviceId && current.deviceId !== deviceId) await adapter.printer.disconnect()
      state = await adapter.printer.connect({ deviceId, name, timeout, canvasId }); const printer = stateDevice(state, 'printer')
      return ok({ printer: { deviceId: printer.deviceId || deviceId, deviceName: printer.name || name, name: printer.name || name } })
    }),
    printer_disconnect: handler('printer_disconnect', async params => {
      noParams(params); const before = await adapter.printer.getState(); const printer = stateDevice(before, 'printer'); await adapter.printer.disconnect()
      return ok({ disconnected: true, alreadyDisconnected: !before.connected, deviceId: printer.deviceId || '' })
    }),
    printer_status: handler('printer_status', async params => {
      noParams(params); const state = await adapter.printer.getState(); const printer = stateDevice(state, 'printer'); const busy = !!state.printing || (state.operation && state.operation !== 'idle') || ['connecting', 'disconnecting'].includes(state.state)
      return ok({ connected: !!state.connected, busy, activeJob: busy ? (state.operation || state.state || 'printing') : '', deviceId: printer.deviceId || '', deviceName: printer.name || '' })
    }),
    printer_print: async (params, ctx = {}) => {
      const operationId = ctx.operationId || `legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const now = Date.now(); pruneOperations(now)
      if (printOperations.has(operationId)) return printOperations.get(operationId).promise
      const task = (async () => { try { await adapter.printer.print(resolvePrintJob(params, ctx, false)); return ok({}, '打印任务已提交') } catch (e) { return failure('printer_print', e) } })()
      printOperations.set(operationId, { created: now, promise: task })
      return task
    },
    printer_preview: async (params, ctx = {}) => {
      try {
        const result = await adapter.printer.preview(resolvePrintJob(params, ctx, true))
        const image = await readPreviewDataUrl(result && result.dataUrl, options.previewFileOptions)
        if (isLargeDataUrl(image)) return ok({ image: await transfers.send(image, 'printer_preview', 'image', ctx.sessionId) })
        return ok({ image: validateImage(image) })
      } catch (e) { return failure('printer_preview', e) }
    },
  }
  return {
    actions,
    async dispose() {
      const scans = Array.from(activeScans); activeScans.clear(); hasStableWeight = false; printOperations.clear()
      await Promise.all(scans.map(scanId => adapter.ble.stopScan(scanId).catch(() => undefined)))
      await scanner.destroy('bridge-destroyed')
    },
  }
}

export function registerBusinessActions(bridge, options) {
  const service = createBusinessActions(options); const unregister = Object.keys(service.actions).map(name => bridge.register(name, service.actions[name]))
  return { actions: service.actions, async dispose() { unregister.forEach(fn => fn()); await service.dispose() } }
}