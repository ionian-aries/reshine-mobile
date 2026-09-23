import { createHoneywellScanService } from '../js_sdk/services/honeywell-scan.js'

function mockAndroid(target = 33, registerError) {
  const calls = []; let receiver
  const android = {
    runtimeMainActivity: () => ({ type: 'main' }),
    getAttribute: (_o, key) => key === 'targetSdkVersion' ? target : undefined,
    newObject: (type, action) => ({ type, action, extras: {} }),
    implements: (_type, implementation) => { receiver = implementation; return implementation },
    invoke: (object, method, ...args) => {
      calls.push([object, method, ...args])
      if (method === 'getApplicationInfo') return {}
      if (method === 'registerReceiver' && registerError) throw registerError
      if (method === 'getAction') return object.action
      if (method === 'getStringExtra') return object.extras[args[0]]
      if (method.startsWith('put')) object.extras[args[0]] = args[1]
    },
  }
  return { android, calls, deliver(action, extras) { receiver.onReceive(null, { action, extras }) } }
}
const actionFrom = calls => calls.find(call => call[1] === 'registerReceiver')[3].action

describe('Honeywell scan service', () => {
  jest.useFakeTimers()
  test('normalizes success and cleans receiver', async () => {
    const mock = mockAndroid(); const service = createHoneywellScanService({ android: mock.android }); const pending = service.start({ softTrigger: true, timeout: 1000 })
    mock.deliver(actionFrom(mock.calls), { data: 'ABC', codeId: 'q', aimId: ']Q', charset: 'UTF-8' })
    await expect(pending).resolves.toMatchObject({ status: 'success', data: { data: 'ABC' } })
    expect(mock.calls.filter(call => call[1] === 'unregisterReceiver')).toHaveLength(1)
  })
  test('times out, cancels, rejects duplicate and cleans idempotently', async () => {
    const mock = mockAndroid(); const service = createHoneywellScanService({ android: mock.android }); const first = service.start({ timeout: 10 })
    await expect(service.start()).resolves.toMatchObject({ code: 'SCAN_BUSY' }); jest.advanceTimersByTime(10)
    await expect(first).resolves.toMatchObject({ code: 'SCAN_TIMEOUT' })
    const second = service.start({ timeout: 100 }); await expect(service.cancel('bye')).resolves.toMatchObject({ status: 'success' }); await expect(second).resolves.toMatchObject({ code: 'SCAN_CANCELLED' })
    await service.destroy(); expect(mock.calls.filter(call => call[1] === 'unregisterReceiver')).toHaveLength(2)
  })
  test('reports targetSdk and receiver registration as unavailable without leaks', async () => {
    await expect(createHoneywellScanService({ android: mockAndroid(34).android }).start()).resolves.toMatchObject({ status: 'unsupported', code: 'SCAN_RECEIVER_UNAVAILABLE' })
    const broken = mockAndroid(33, new Error('denied')); const service = createHoneywellScanService({ android: broken.android })
    await expect(service.start()).resolves.toMatchObject({ status: 'unsupported', code: 'SCAN_RECEIVER_UNAVAILABLE' })
    expect(service.active).toBe(false); expect(broken.calls.filter(call => call[1] === 'unregisterReceiver')).toHaveLength(0)
  })
})