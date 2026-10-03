describe('app-upgrade Android 流程', () => {
  let updater
  let requestBody
  let downloadCallback
  let downloadOptions
  let entries

  function file(name) { return { name, isDirectory: false, remove: jest.fn(resolve => { entries = entries.filter(item => item !== name); resolve() }) } }

  beforeEach(() => {
    jest.resetModules()
    requestBody = null
    entries = ['old.wgt']
    process.env.VUE_APP_UPGRADE_CHECK_URL = 'https://example.com/check'
    global.__uniConfig = { appid: '__UNI__TEST' }
    const updateDirectory = { createReader: () => ({ readEntries(resolve) { resolve(entries.map(file)) } }) }
    const doc = { getDirectory(name, options, resolve) { resolve(updateDirectory) } }
    global.plus = {
      os: { name: 'Android' },
      io: { resolveLocalFileSystemURL: jest.fn((path, resolve) => { path === '_doc/' ? resolve(doc) : resolve(file(path)) }) },
      runtime: {
        appid: '__UNI__TEST', version: '1.0.0', versionCode: 10,
        getProperty: jest.fn((appid, success) => success({ version: '1.0.1', versionCode: 11 })),
        install: jest.fn(), restart: jest.fn(), openURL: jest.fn()
      },
      downloader: { createDownload: jest.fn((url, options, callback) => {
        downloadOptions = options
        downloadCallback = callback
        return { state: 0, start: jest.fn(), abort: jest.fn(), addEventListener: jest.fn() }
      }) }
    }
    const storage = {}
    global.uni = {
      getStorageSync: jest.fn(key => storage[key]), setStorageSync: jest.fn((key, value) => { storage[key] = value }), removeStorageSync: jest.fn(key => { delete storage[key] }),
      request(options) {
        requestBody = options.data
        options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'apk', url: 'https://example.com/app.apk' } } } })
        return { abort: jest.fn() }
      }
    }
    updater = require('../js_sdk/index.js').default
  })

  afterEach(() => {
    updater.dispose()
    delete process.env.VUE_APP_UPGRADE_CHECK_URL
    delete global.__uniConfig
    delete global.plus
    delete global.uni
  })

  test('读取 runtime/property 两套版本并仅上报三个接口字段', async () => {
    await updater.check()
    expect(plus.runtime.getProperty).toHaveBeenCalledWith('__UNI__TEST', expect.any(Function))
    expect(requestBody).toEqual({ appid: '__UNI__TEST', apkVersion: '1.0.0', wgtVersion: '1.0.1' })
  })

  test('APK 确认后仅 openURL，不下载和安装', async () => {
    await updater.check()
    await expect(updater.confirmUpdate()).resolves.toEqual({ opened: true })
    expect(plus.runtime.openURL).toHaveBeenCalledWith('https://example.com/app.apk', expect.any(Function))
    expect(plus.downloader.createDownload).not.toHaveBeenCalled()
    expect(plus.runtime.install).not.toHaveBeenCalled()
  })

  test('WGT 分阶段持久化，保留源包并立即请求重启', async () => {
    uni.request = options => options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2.0.0', versionCode: 20 } } } })
    await updater.check()
    plus.runtime.install = jest.fn((path, options, success) => success({ appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 }))
    const pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: downloadOptions.filename === '_doc/update/' ? '_doc/update/server-package.wgt' : downloadOptions.filename }, 200)
    await expect(pending).resolves.toEqual(expect.objectContaining({ restartRequired: true, attemptId: expect.any(String) }))
    expect(plus.downloader.createDownload).toHaveBeenCalledWith('x', { filename: '_doc/update/' }, expect.any(Function))
    expect(plus.runtime.install).toHaveBeenCalledWith('_doc/update/server-package.wgt', { force: false }, expect.any(Function), expect.any(Function))
    const pendingCalls = uni.setStorageSync.mock.calls.filter(call => call[0] === 'app-upgrade:pending-wgt')
    const stages = pendingCalls.map(call => call[1].stage)
    expect(stages).toEqual(['downloaded', 'install-requested', 'installed', 'restart-requested'])
    expect(pendingCalls[0][1]).toEqual(expect.objectContaining({ url: 'x', sourcePath: '_doc/update/server-package.wgt', expected: { appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 } }))
    expect(pendingCalls[1][1]).toEqual(expect.objectContaining({ stage: 'install-requested', installAttempts: 1, fileInfo: expect.objectContaining({ sourcePath: '_doc/update/server-package.wgt', isFile: true }) }))
    expect(pendingCalls[2][1]).toEqual(expect.objectContaining({ installedWidgetInfo: { appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 }, processId: null, startupTime: null }))
    expect(plus.io.resolveLocalFileSystemURL).toHaveBeenCalledWith('_doc/update/server-package.wgt', expect.any(Function), expect.any(Function))
    expect(plus.runtime.restart).toHaveBeenCalledTimes(1)
  })

  test('pending WGT 成功时先删源包再清记录，失败时保留并展示遮罩', async () => {
    uni.getStorageSync.mockReturnValue({ stage: 'restart-requested', expected: { appid: '__UNI__TEST', version: '1.0.1', versionCode: 11 }, sourcePath: '_doc/update/update.wgt' })
    await updater.check()
    expect(plus.io.resolveLocalFileSystemURL).toHaveBeenCalledWith('_doc/update/update.wgt', expect.any(Function), expect.any(Function))
    expect(uni.removeStorageSync).toHaveBeenCalledWith('app-upgrade:pending-wgt')

    updater.dispose()
    const failedPending = { stage: 'restart-requested', restartAttempts: 2, expected: { appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 }, sourcePath: '_doc/update/update.wgt', installedWidgetInfo: { version: '2.0.0' } }
    uni.getStorageSync.mockReturnValue(failedPending)
    await expect(updater.check()).rejects.toMatchObject({ code: 'WGT_ACTIVATION_FAILED', phase: 'verifying-wgt', retryable: true })
    expect(updater.getState()).toEqual(expect.objectContaining({ phase: 'failed', mandatoryConfirmed: true, packageInfo: expect.objectContaining({ version: '2.0.0', installedWidgetInfo: { version: '2.0.0' } }) }))
    expect(uni.removeStorageSync).toHaveBeenCalledTimes(1)
    expect(plus.runtime.restart).not.toHaveBeenCalled()
  })

  test('WGT 安装成功但原包清理失败时仍重启', async () => {
    uni.request = options => options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2.0.0' } } } })
    await updater.check()
    plus.runtime.install = jest.fn((path, options, success) => success())
    plus.io.resolveLocalFileSystemURL = jest.fn((path, resolve, reject) => {
      if (path === '_doc/') {
        resolve({ getDirectory(name, options, done) { done({ createReader: () => ({ readEntries(read) { read([]) } }) }) } })
        return
      }
      if (path === '_doc/update/server-package.wgt') {
        resolve(file(path))
        return
      }
      reject(new Error('missing'))
    })
    const pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: downloadOptions.filename === '_doc/update/' ? '_doc/update/server-package.wgt' : downloadOptions.filename }, 200)
    await expect(pending).resolves.toEqual(expect.objectContaining({ restartRequired: true, attemptId: expect.any(String) }))
    expect(plus.runtime.restart).toHaveBeenCalledTimes(1)
  })

  test('WGT 安装回调字段缺失不阻断，明确版本不匹配则失败', async () => {
    uni.request = options => options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2.0.0', versionCode: 20 } } } })
    await updater.check()
    plus.runtime.install = jest.fn((path, options, success) => success({}))
    let pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: downloadOptions.filename === '_doc/update/' ? '_doc/update/server-package.wgt' : downloadOptions.filename }, 200)
    await expect(pending).resolves.toEqual(expect.objectContaining({ restartRequired: true, attemptId: expect.any(String) }))

    uni.removeStorageSync('app-upgrade:pending-wgt')
    updater.dispose()
    await updater.check()
    plus.runtime.restart.mockClear()
    plus.runtime.install = jest.fn((path, options, success) => success({ appid: '__UNI__TEST', version: '9.9.9', versionCode: 20 }))
    pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: downloadOptions.filename === '_doc/update/' ? '_doc/update/server-package.wgt' : downloadOptions.filename }, 200)
    await expect(pending).rejects.toMatchObject({ code: 'WGT_INFO_MISMATCH', phase: 'installing' })
    expect(plus.runtime.restart).not.toHaveBeenCalled()
  })

  test('安装调用中断时只自动恢复一次，随后给出明确失败', async () => {
    const interrupted = {
      attemptId: 'wgt-interrupted', stage: 'install-requested', installAttempts: 1,
      sourcePath: '_doc/update/server-package.wgt', expected: { appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 }
    }
    uni.getStorageSync.mockReturnValue(interrupted)
    plus.runtime.install = jest.fn((path, options, success) => success({ appid: '__UNI__TEST', version: '2.0.0', versionCode: 20 }))
    await expect(updater.check()).resolves.toEqual({ action: 'recovering', status: 'restart-requested' })
    expect(plus.runtime.install).toHaveBeenCalledWith(interrupted.sourcePath, { force: false }, expect.any(Function), expect.any(Function))
    expect(uni.setStorageSync.mock.calls[0][1]).toEqual(expect.objectContaining({ stage: 'install-requested', installAttempts: 2 }))

    updater.dispose()
    uni.getStorageSync.mockReturnValue({ ...interrupted, installAttempts: 2 })
    await expect(updater.check()).rejects.toMatchObject({ code: 'WGT_INSTALL_INTERRUPTED', phase: 'verifying-wgt' })
    expect(updater.getState()).toEqual(expect.objectContaining({ phase: 'failed', mandatoryConfirmed: true }))
  })

  test('安装前本地文件不可访问时不调用原生安装', async () => {
    uni.request = options => options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2.0.0' } } } })
    await updater.check()
    plus.io.resolveLocalFileSystemURL = jest.fn((path, resolve, reject) => path === '_doc/' ? resolve({ getDirectory(name, options, done) { done({ createReader: () => ({ readEntries(read) { read([]) } }) }) } }) : reject(new Error('missing')))
    const pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: '_doc/update/missing.wgt' }, 200)
    await expect(pending).rejects.toMatchObject({ code: 'WGT_FILE_UNAVAILABLE', phase: 'installing' })
    expect(plus.runtime.install).not.toHaveBeenCalled()
  })

  test('WGT 安装失败保留失败状态且不重启', async () => {
    uni.request = options => options.success({ statusCode: 200, data: { code: 200, data: { action: 'update', package: { type: 'wgt', url: 'x', version: '2.0.0' } } } })
    await updater.check()
    plus.runtime.install = jest.fn((path, options, success, error) => error({ message: 'bad wgt' }))
    const pending = updater.confirmUpdate()
    downloadCallback({ state: 4, status: 200, filename: downloadOptions.filename === '_doc/update/' ? '_doc/update/server-package.wgt' : downloadOptions.filename }, 200)
    await expect(pending).rejects.toMatchObject({ code: 'INSTALL_FAILED' })
    expect(plus.runtime.restart).not.toHaveBeenCalled()
  })
})