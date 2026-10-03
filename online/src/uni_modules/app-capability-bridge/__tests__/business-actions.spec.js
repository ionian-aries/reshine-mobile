import { businessFailureData, createBusinessActions, registerBusinessActions } from '../js_sdk/services/business-actions.js'
import { ActionValidationError, objectParams, validateActionParams, validateImage } from '../js_sdk/services/action-validation.js'
const validateLargeImage = () => validateImage(`data:image/png;base64,${'A'.repeat(128 * 1024)}`)

function adapter(overrides = {}) {
  return {
    ble: { getBluetoothState: jest.fn(async () => ({ systemEnabled: true })), requestEnableSystemBluetooth: jest.fn(async () => ({ systemEnabled: true })), requestDisableSystemBluetooth: jest.fn(async () => ({ systemEnabled: false })), on: jest.fn(() => jest.fn()), startScan: jest.fn(async () => ({ scanId: 'scan-1', devices: [] })), stopScan: jest.fn(async () => undefined), ...(overrides.ble || {}) },
    scale: { connect: jest.fn(), disconnect: jest.fn(), getState: jest.fn(async () => ({ state: 'disconnected', connected: false })), readWeight: jest.fn(), ...(overrides.scale || {}) },
    printer: { connect: jest.fn(), disconnect: jest.fn(), getState: jest.fn(async () => ({ state: 'disconnected', connected: false })), print: jest.fn(), preview: jest.fn(), ...(overrides.printer || {}) },
  }
}

describe('business action adapter', () => {
  test.each([null, undefined, [], ''])('strictly rejects non-object action params: %p', value => {
    expect(() => objectParams(value)).toThrow(ActionValidationError)
    try { objectParams(value) } catch (error) { expect(error.code).toBe('INVALID_ARGUMENT') }
  })
  test.each([null, [], ''])('public no-argument actions reject supplied non-object params: %p', async value => {
    const service = createBusinessActions({ adapter: adapter(), canvasId: 'canvas-1' })
    await expect(service.actions.bluetooth_getState(value)).resolves.toMatchObject({ status: 'error', code: 'INVALID_ARGUMENT' })
  })
  test.each([null, [], '', {}])('no-argument action rejects supplied params: %p', value => {
    expect(() => validateActionParams('bluetooth_enable', value)).toThrow(ActionValidationError)
  })
  test.each([null, [], ''])('parameterized action rejects non-object params: %p', value => {
    expect(() => validateActionParams('bluetooth_search', value)).toThrow(ActionValidationError)
  })
  test.each(['bluetooth_getState', 'bluetooth_enable', 'bluetooth_disable', 'scale_disconnect', 'scale_status', 'printer_disconnect', 'printer_status', 'scan_cancel'])('no-argument action %s accepts omitted params', async name => {
    const source = adapter({ scale: { disconnect: jest.fn(async () => undefined) }, printer: { disconnect: jest.fn(async () => undefined) } })
    const service = createBusinessActions({ adapter: source, canvasId: 'canvas-1', scanService: { cancel: jest.fn(async () => ({ status: 'success', code: 'OK', message: '', data: {} })), destroy: jest.fn() } })
    await expect(service.actions[name]()).resolves.not.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
  test('maps bluetooth state and normalizes errors', async () => {
    const service = createBusinessActions({ adapter: adapter(), canvasId: 'canvas-1' })
    await expect(service.actions.bluetooth_getState()).resolves.toEqual({ status: 'success', code: 'OK', message: '', data: { enabled: true } })
    await expect(service.actions.bluetooth_getState({})).resolves.toMatchObject({ status: 'error', code: 'INVALID_ARGUMENT' })
  })
  test('collects, filters, deduplicates and always cleans search', async () => {
    let found
    const unsubscribe = jest.fn(); const stopScan = jest.fn(async () => undefined)
    const source = adapter({ ble: { on: jest.fn((name, cb) => { found = cb; return unsubscribe }), startScan: jest.fn(async () => { found({ deviceId: 'a', name: 'Scale', RSSI: -45 }); found({ deviceId: 'a', name: 'Scale', RSSI: -40 }); return { scanId: 's1', devices: [] } }), stopScan } })
    const service = createBusinessActions({ adapter: source, canvasId: 'canvas-1' })
    const result = await service.actions.bluetooth_search({ name: 'sca', timeout: 100, excludeUnnamed: true })
    expect(result.data.devices).toEqual([{ deviceId: 'a', name: 'Scale', localName: '', rssi: -40, connected: false, paired: false }])
    expect(stopScan).toHaveBeenCalledWith('s1'); expect(unsubscribe).toHaveBeenCalled()
  })
  test('cleans subscription when scan start fails', async () => {
    const unsubscribe = jest.fn(); const source = adapter({ ble: { on: jest.fn(() => unsubscribe), startScan: jest.fn(async () => { const error = new Error('denied'); error.code = 'PERMISSION_DENIED'; throw error }) } })
    const result = await createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions.bluetooth_search({ timeout: 100 })
    expect(result).toMatchObject({ status: 'error', code: 'PERMISSION_DENIED' }); expect(unsubscribe).toHaveBeenCalled()
  })
  test('maps scale reading and prevents concurrent reads', async () => {
    let release; const pending = new Promise(resolve => { release = resolve }); const source = adapter({ scale: { readWeight: jest.fn(() => pending) } })
    const action = createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions.scale_readWeight
    const first = action({ timeout: 100 }); await expect(action({ timeout: 100 })).resolves.toMatchObject({ code: 'REQUEST_IN_PROGRESS' })
    release({ overloaded: false, stable: true, rawWeight: '12.30', unit: 'kg', weightTypeMeaning: 'net', rawFrame: 'raw' })
    await expect(first).resolves.toMatchObject({ data: { overload: false, stable: true, weight: '12.30', unit: 'kg', weightType: 'net', raw: 'raw' } })
  })
  test.each([
    [{ rawWeight: '-1.25' }, '-1.25'],
    [{ rawWeight: -1.25 }, '-1.25'],
    [{ rawWeight: '1.25', sign: '-' }, '-1.25'],
    [{ rawWeight: '1.25', negative: true }, '-1.25'],
    [{ rawWeight: '1.25', rawFrame: 'ST,NT,-1.25kg' }, '-1.25'],
    [{ rawWeight: '1.25', sign: '+', rawFrame: 'ST,NT,+1.25kg' }, '1.25'],
    [{ rawWeight: '-0', sign: '-' }, '0'],
    [{ rawWeight: -0, sign: '-' }, '0'],
  ])('preserves scale sign without changing the legacy string shape: %p', async (reading, expected) => {
    const result = await createBusinessActions({ adapter: adapter({ scale: { readWeight: jest.fn(async () => ({ overloaded: false, stable: true, unit: 'kg', weightTypeMeaning: 'net', ...reading })) } }), canvasId: 'canvas-1' }).actions.scale_readWeight({ timeout: 100 })
    expect(result.data.weight).toBe(expected)
    expect(typeof result.data.weight).toBe('string')
    expect(typeof result.data.raw).toBe('string')
    expect(result.data.weight).not.toMatch(/[eE]/)
  })
  test('keeps invalid and contradictory fields observable without guessing or leaking raw frames', async () => {
    const calls = []
    const log = (...args) => calls.push(args)
    const result = await createBusinessActions({ adapter: adapter({ scale: { readWeight: jest.fn(async () => ({ overloaded: false, stable: false, rawWeight: '-1.25', sign: '+', unit: 'kg', weightType: 'NT', status: 'unstable', rawFrame: 'ST,NT,-123456789.00kg' })) } }), canvasId: 'canvas-1', log }).actions.scale_readWeight({ timeout: 100 })
    expect(result.data.weight).toBe('-1.25')
    const text = JSON.stringify(calls)
    expect(text).toContain('signConflict')
    expect(text).toContain('rawLength')
    expect(text).toContain('rawHash')
    expect(text).not.toContain('ST,NT,-123456789.00kg')
    const invalid = await createBusinessActions({ adapter: adapter({ scale: { readWeight: jest.fn(async () => ({ rawWeight: 'invalid', sign: '-', rawFrame: 'US,NT,-invalidkg' })) } }), canvasId: 'canvas-1' }).actions.scale_readWeight({ timeout: 100 })
    expect(invalid.data.weight).toBe('invalid')
  })
  test('maps one 80x40/90/180 request to one manager print call', async () => {
    const print = jest.fn(async () => ({ submitted: true })); const source = adapter({ printer: { print } })
    const result = await createBusinessActions({ adapter: source, canvasId: 'hidden-canvas' }).actions.printer_print({ image: 'https://example.com/a.png', width: 80, height: 40, orientation: 90, copies: 1, gapType: 255, printDarkness: 8, printSpeed: 3, threshold: 180 }, { sessionId: 'session-1', generation: 1, operationId: 'print-1' })
    expect(result.status).toBe('success')
    expect(print).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledWith({ image: 'https://example.com/a.png', width: 80, height: 40, orientation: 90, threshold: 180, canvasId: 'hidden-canvas', copies: 1, gapType: 255, darkness: 8, speed: 3 })
  })
  test('accepts large input for transfer and omits printer_cancel', async () => {
    const service = createBusinessActions({ adapter: adapter(), canvasId: 'canvas-1' })
    await expect(service.actions.printer_print({ image: 'https://example.com/a.png', width: '80', height: 40 })).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(() => validateLargeImage()).not.toThrow()
    expect(service.actions.printer_cancel).toBeUndefined()
  })
  test.each([
    ['bluetooth_getState', 'ble', 'getBluetoothState', undefined],
    ['bluetooth_enable', 'ble', 'requestEnableSystemBluetooth', undefined],
    ['bluetooth_disable', 'ble', 'requestDisableSystemBluetooth', undefined],
    ['bluetooth_search', 'ble', 'startScan', { timeout: 100 }],
    ['scale_connect', 'scale', 'connect', { deviceId: 'scale-1' }],
    ['scale_disconnect', 'scale', 'getState', undefined],
    ['scale_status', 'scale', 'getState', undefined],
    ['scale_readWeight', 'scale', 'readWeight', { timeout: 100 }],
    ['printer_connect', 'printer', 'getState', { deviceId: 'printer-1' }],
    ['printer_disconnect', 'printer', 'getState', undefined],
    ['printer_status', 'printer', 'getState', undefined],
    ['printer_print', 'printer', 'print', { image: 'https://example.com/a.png', width: 80, height: 40 }],
  ])('%s converts bottom-layer rejection to its legacy envelope', async (name, domain, method, params) => {
    const rejected = { errCode: 'USER_CANCEL', errMsg: 'user cancel' }
    const source = adapter({ [domain]: { [method]: jest.fn(async () => { throw rejected }) } })
    const result = await createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions[name](params)
    const expectedData = businessFailureData(name)
    if (name === 'bluetooth_enable' || name === 'bluetooth_disable') expectedData.enabled = true
    expect(result).toEqual({ status: 'error', code: 'USER_CANCEL', message: 'user cancel', data: expectedData })
  })
  test('scan start throw is resolved as its legacy envelope', async () => {
    const scanService = { start: jest.fn(async () => { throw new Error('scanner failed') }), cancel: jest.fn(), destroy: jest.fn() }
    await expect(createBusinessActions({ adapter: adapter(), canvasId: 'canvas-1', scanService }).actions.scan_start({})).resolves.toEqual({ status: 'error', code: 'OPERATION_FAILED', message: 'scanner failed', data: businessFailureData('scan_start') })
  })
  test.each(['bluetooth_getState', 'bluetooth_enable', 'bluetooth_disable', 'bluetooth_search', 'scale_connect', 'scale_disconnect', 'scale_status', 'scale_readWeight', 'printer_connect', 'printer_disconnect', 'printer_status', 'printer_print', 'scan_start', 'scan_cancel'])('%s has an action-specific failure data shape', name => {
    expect(businessFailureData(name)).toEqual(expect.any(Object))
  })
  test('preserves scanner business cancellation and unsupported envelopes with declared data', async () => {
    const scanService = {
      start: jest.fn(async () => ({ status: 'unsupported', code: 'SCAN_RECEIVER_UNAVAILABLE', message: 'not supported', data: {} })),
      cancel: jest.fn(async () => ({ status: 'error', code: 'SCAN_CANCELLED', message: 'cancelled', data: {} })),
      destroy: jest.fn(),
    }
    const service = createBusinessActions({ adapter: adapter(), canvasId: 'canvas-1', scanService })
    await expect(service.actions.scan_start({})).resolves.toEqual({ status: 'unsupported', code: 'SCAN_RECEIVER_UNAVAILABLE', message: 'not supported', data: businessFailureData('scan_start') })
    await expect(service.actions.scan_cancel()).resolves.toEqual({ status: 'error', code: 'SCAN_CANCELLED', message: 'cancelled', data: businessFailureData('scan_cancel') })
  })
  test('maps callback-style rejection objects without losing code or message', async () => {
    const source = adapter({ ble: {
      getBluetoothState: jest.fn(async () => ({ systemEnabled: true })),
      requestDisableSystemBluetooth: jest.fn(async () => { throw { errCode: 12, errMsg: '用户拒绝关闭蓝牙' } }),
    } })
    await expect(createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions.bluetooth_disable()).resolves.toEqual({ status: 'error', code: '12', message: '用户拒绝关闭蓝牙', data: { enabled: true, pending: false } })
  })
  test.each([
    ['bluetooth_enable', 'requestEnableSystemBluetooth', false, { code: 'SYSTEM_BLUETOOTH_ENABLE_DENIED', message: '用户未允许打开系统蓝牙' }],
    ['bluetooth_disable', 'requestDisableSystemBluetooth', true, '用户取消关闭蓝牙'],
    ['bluetooth_disable', 'requestDisableSystemBluetooth', true, { errCode: 'USER_CANCEL', errMsg: 'user cancel' }],
  ])('%s resolves user refusal, queries actual state and remains retryable', async (name, method, enabled, refusal) => {
    let calls = 0
    const toggle = jest.fn(() => {
      calls += 1
      if (calls === 1) return { then: (resolve, reject) => reject(refusal) }
      return Promise.resolve({ systemEnabled: !enabled })
    })
    const source = adapter({ ble: { getBluetoothState: jest.fn(async () => ({ systemEnabled: enabled })), [method]: toggle } })
    const action = createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions[name]
    const first = await action()
    expect(first).toMatchObject({ status: 'error', data: { enabled, pending: false } })
    await expect(action()).resolves.toEqual({ status: 'success', code: 'OK', message: '', data: { enabled: !enabled, pending: false } })
    expect(toggle).toHaveBeenCalledTimes(2)
  })
  test.each([
    ['bluetooth_enable', 'requestEnableSystemBluetooth', false],
    ['bluetooth_disable', 'requestDisableSystemBluetooth', true],
  ])('%s handles synchronous refusal and safely defaults if state lookup also fails', async (name, method, enabled) => {
    const refusal = Object.assign(new Error('用户拒绝操作'), { code: name === 'bluetooth_enable' ? 'SYSTEM_BLUETOOTH_ENABLE_DENIED' : 'SYSTEM_BLUETOOTH_DISABLE_DENIED' })
    const source = adapter({ ble: { getBluetoothState: jest.fn(() => { throw new Error('state unavailable') }), [method]: jest.fn(() => { throw refusal }) } })
    await expect(createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions[name]()).resolves.toEqual({ status: 'error', code: refusal.code, message: '用户拒绝操作', data: { enabled, pending: false } })
  })
  test('does not classify an unknown bluetooth program error as user cancellation', async () => {
    const source = adapter({ ble: { requestEnableSystemBluetooth: jest.fn(() => { throw new TypeError('broken implementation') }) } })
    await expect(createBusinessActions({ adapter: source, canvasId: 'canvas-1' }).actions.bluetooth_enable()).rejects.toThrow('broken implementation')
    expect(source.ble.getBluetoothState).not.toHaveBeenCalled()
  })
  test('does not register or expose printer_preview', async () => {
    const source = adapter()
    const service = createBusinessActions({ adapter: source, canvasId: 'canvas-1' })
    expect(service.actions.printer_preview).toBeUndefined()
    const registered = new Map()
    const bridge = { register: jest.fn((name, action) => { registered.set(name, action); return () => registered.delete(name) }) }
    const registration = registerBusinessActions(bridge, { adapter: source, canvasId: 'canvas-1' })
    expect(registered.has('printer_preview')).toBe(false)
    expect(source.printer.preview).not.toHaveBeenCalled()
    await registration.dispose()
  })
  test('deduplicates print only inside the same session generation', async () => {
    const print = jest.fn(async () => undefined); const service = createBusinessActions({ adapter: adapter({ printer: { print } }), canvasId: 'canvas-1' })
    const params = { image: 'https://example.com/a.png', width: 80, height: 40 }
    await service.actions.printer_print(params, { sessionId: 'one', generation: 1, operationId: 'same' })
    await service.actions.printer_print(params, { sessionId: 'two', generation: 2, operationId: 'same' })
    expect(print).toHaveBeenCalledTimes(2)
  })
  test('deduplicates print operation and expires bounded cache', async () => {
    const print = jest.fn(async () => undefined); const service = createBusinessActions({ adapter: adapter({ printer: { print } }), canvasId: 'canvas-1', operationLimit: 2 })
    const params = { image: 'https://example.com/a.png', width: 80, height: 40 }
    await Promise.all([service.actions.printer_print(params, { operationId: 'same' }), service.actions.printer_print(params, { operationId: 'same' })])
    expect(print).toHaveBeenCalledTimes(1)
    await service.actions.printer_print(params, { operationId: 'second' }); await service.actions.printer_print(params, { operationId: 'third' }); await service.actions.printer_print(params, { operationId: 'same' })
    expect(print).toHaveBeenCalledTimes(4)
  })
})