import { parseResponse } from '../js_sdk/contract.js'

const current = { appid: '__UNI__TEST', apkVersion: '1', wgtVersion: '1' }

describe('app-upgrade 响应契约', () => {
  test('none 正常结束', () => {
    expect(parseResponse({ code: 200, data: { action: 'none' } }, current)).toEqual({ action: 'none', current })
  })

  test('APK 只要求 type 和 url', () => {
    const result = parseResponse({ code: 200, data: { action: 'update', package: { type: 'apk', url: ' custom://package ' } } }, current)
    expect(result.package).toEqual(expect.objectContaining({ type: 'apk', url: 'custom://package' }))
  })

  test('WGT 必须有 version，versionCode 可选且保留', () => {
    expect(() => parseResponse({ code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x' } } }, current)).toThrow(/version/)
    expect(parseResponse({ code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2', versionCode: 12 } } }, current).package)
      .toEqual(expect.objectContaining({ version: '2', versionCode: 12 }))
  })

  test.each([
    { code: 500, data: { action: 'none' } },
    { code: 200, data: {} },
    { code: 200, data: { action: 'error' } },
    { code: 200, data: { action: 'update', package: { type: 'zip', url: 'x' } } },
    { code: 200, data: { action: 'update', package: { type: 'apk', url: '' } } }
  ])('拒绝不可执行结构 %#', body => expect(() => parseResponse(body, current)).toThrow())
})