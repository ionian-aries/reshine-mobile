jest.mock('../js_sdk/index.js', () => ({
  __esModule: true,
  default: {
    confirmUpdate: jest.fn(() => Promise.resolve()),
    retry: jest.fn(() => Promise.resolve()),
    getState: jest.fn()
  }
}))

const updater = require('../js_sdk/index.js').default
const { updateNativeOverlay, disposeNativeOverlay } = require('../js_sdk/native-overlay.js')

describe('app-upgrade 原生确认按钮', () => {
  let clickHandler
  let runtimeHandlers
  let view
  const state = {
    mandatoryConfirmed: true,
    phase: 'update-available',
    current: { apkVersion: '1.0.0', wgtVersion: '1.0.0' },
    packageInfo: { title: '更新', contents: '内容'.repeat(500), type: 'apk', version: '1.1.0' },
    error: null,
    progress: null
  }

  beforeEach(() => {
    jest.clearAllMocks()
    updater.getState.mockReturnValue(state)
    view = {
      drawRect: jest.fn(), drawText: jest.fn(), show: jest.fn(), hide: jest.fn(), close: jest.fn(),
      setStyle: jest.fn(), setTouchEventRect: jest.fn(), addEventListener: jest.fn((name, handler) => { clickHandler = handler })
    }
    global.uni = { setClipboardData: jest.fn(options => options.success()) }
    runtimeHandlers = {}
    global.plus = {
      screen: { resolutionWidth: 360, resolutionHeight: 720 },
      globalEvent: {
        addEventListener: jest.fn((name, handler) => { runtimeHandlers[name] = handler }),
        removeEventListener: jest.fn()
      },
      nativeObj: { View: jest.fn(() => view) }
    }
  })

  afterEach(() => {
    disposeNativeOverlay()
    delete global.plus
    delete global.uni
  })

  test('全屏其他位置不触发，绘制按钮位置才确认下载', async () => {
    updateNativeOverlay(state)
    clickHandler({ clientX: 10, clientY: 10 })
    expect(updater.confirmUpdate).not.toHaveBeenCalled()
    clickHandler({ clientX: 100, clientY: 510 })
    expect(updater.confirmUpdate).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })

  test('方向变化后按新屏幕尺寸重绘并保持触摸区域一致', () => {
    updateNativeOverlay(state)
    const initialDraws = view.drawRect.mock.calls.length
    plus.screen.resolutionWidth = 720
    plus.screen.resolutionHeight = 360
    runtimeHandlers.orientationchange()
    expect(view.setStyle).toHaveBeenLastCalledWith({ top: '0px', left: '0px', width: '100%', height: '100%' })
    expect(view.setTouchEventRect).toHaveBeenLastCalledWith({ top: '0px', left: '0px', width: '100%', height: '100%' })
    expect(view.drawRect.mock.calls.length).toBeGreaterThan(initialDraws)
    clickHandler({ clientX: 200, clientY: 310 })
    expect(updater.confirmUpdate).toHaveBeenCalledTimes(1)
  })

  test('背景完全不透明并覆盖整个屏幕', () => {
    updateNativeOverlay(state)
    expect(view.drawRect).toHaveBeenCalledWith(
      { color: '#F3F6FA' },
      { top: '0px', left: '0px', width: '100%', height: '100%' },
      'upgrade-background'
    )
  })

  test('进度更新复用同一个 View、固定绘制节点且不 reset/重复 show', () => {
    updateNativeOverlay({ ...state, phase: 'downloading', progress: { progress: 1 } })
    updateNativeOverlay({ ...state, phase: 'downloading', progress: { progress: 2 } })
    expect(plus.nativeObj.View).toHaveBeenCalledTimes(1)
    expect(view.show).toHaveBeenCalledTimes(1)
    expect(view.reset).toBeUndefined()
    expect(view.drawText.mock.calls.filter(call => call[3] === 'upgrade-content')).toHaveLength(2)
  })

  test('失败详情可复制且敏感 URL 查询参数被隐藏', () => {
    const failed = {
      ...state,
      phase: 'failed',
      error: {
        code: 'INSTALL_FAILED', message: '安装 https://example.com/app.apk?token=secret 失败', phase: 'installing', retryable: true,
        data: { runtimeInstall: { code: -1229, message: 'denied', details: { url: 'https://x/a?key=secret', reason: 'policy' } } }
      }
    }
    updater.getState.mockReturnValue(failed)
    updateNativeOverlay(failed)
    const texts = view.drawText.mock.calls.map(call => call[0]).join('\n')
    expect(texts).toContain('code: INSTALL_FAILED')
    expect(texts).toContain('phase: installing')
    expect(texts).toContain('plus.runtime.install.code: -1229')
    expect(texts).not.toContain('token=secret')
    clickHandler({ clientX: 100, clientY: 590 })
    expect(uni.setClipboardData).toHaveBeenCalledTimes(1)
    expect(uni.setClipboardData.mock.calls[0][0].data).toContain('plus.runtime.install.details:')
    expect(view.drawText.mock.calls.map(call => call[0])).toContain('已复制错误信息')
  })

  test('恢复前台时重绘并重新置顶同一个 View', () => {
    updateNativeOverlay(state)
    view.show.mockClear()
    runtimeHandlers.resume()
    expect(plus.nativeObj.View).toHaveBeenCalledTimes(1)
    expect(view.show).toHaveBeenCalledTimes(1)
    expect(view.setStyle).toHaveBeenLastCalledWith({ top: '0px', left: '0px', width: '100%', height: '100%' })
  })

  test('销毁会关闭 View、释放尺寸与前台监听并可重新创建', () => {
    updateNativeOverlay(state)
    const handlers = { ...runtimeHandlers }
    disposeNativeOverlay()
    expect(view.close).toHaveBeenCalledTimes(1)
    expect(plus.globalEvent.removeEventListener).toHaveBeenCalledWith('orientationchange', handlers.orientationchange)
    expect(plus.globalEvent.removeEventListener).toHaveBeenCalledWith('resize', handlers.resize)
    expect(plus.globalEvent.removeEventListener).toHaveBeenCalledWith('resume', handlers.resume)
    updateNativeOverlay(state)
    expect(plus.nativeObj.View).toHaveBeenCalledTimes(2)
  })
})