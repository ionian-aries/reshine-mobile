import { attachRuntimeLifecycle, configureStatusBar, createShellLifecycle, createStartupReadyBuffer, getNativeWebViewUrl, getOwnedWebViewCandidates, getPageWebView, normalizeWebViewUrl, parseBridgeSource, resolveStatusBarHeight, resolveWebViewCandidate, waitForWebView } from '../js_sdk/shell-runtime.js'
import fs from 'fs'
import path from 'path'

describe('bridge plugin registration', () => {
  test('exports an idempotent global component plugin', () => {
    const entry = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8')
    expect(entry).toMatch(/Vue\.component\('app-capability-bridge-shell'/)
    expect(entry).toMatch(/install\.installed/)
    expect(entry).toMatch(/export default \{ install \}/)
  })

  test('pages contain no import or local components registration', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../pages/index/index.vue'), 'utf8')
    expect(page).not.toMatch(/\bimport\s/)
    expect(page).not.toMatch(/\bcomponents\s*:/)
  })

  test('template handlers exist and avoid reserved lifecycle names', () => {
    const component = fs.readFileSync(path.resolve(__dirname, '../components/app-capability-bridge-shell/app-capability-bridge-shell.vue'), 'utf8')
    const handlers = [...component.matchAll(/@(load|message|error)="([^"]+)"/g)].map(match => match[2])
    expect(handlers).toEqual(['handleWebViewLoaded', 'handleWebViewMessage', 'handleWebViewError'])
    handlers.forEach(handler => expect(component).toMatch(new RegExp(`${handler}\\s*\\(`)))
    expect(handlers).not.toEqual(expect.arrayContaining(['onLoad', 'onError']))
  })

  test('offsets the native webview and renders one transparent status bar spacer', () => {
    const component = fs.readFileSync(path.resolve(__dirname, '../components/app-capability-bridge-shell/app-capability-bridge-shell.vue'), 'utf8')
    expect(component).toMatch(/class="bridge-status-bar" :style="statusBarStyle"/)
    expect(component).toMatch(/\.bridge-status-bar \{ width: 100%; background-color: transparent; \}/)
    expect(component).toMatch(/:webview-styles="webviewStyles"/)
    expect(component).toMatch(/webviewStyles\(\) \{ return \{ top: this\.statusBarHeight, bottom: 0 \} \}/)
    const app = fs.readFileSync(path.resolve(__dirname, '../../../App.vue'), 'utf8')
    expect(app).not.toMatch(/padding-top:\s*var\(--status-bar-height\)/)
  })
})

describe('bridge shell source', () => {
  test('resolves status bar height from plus first and uni as a safe fallback', () => {
    const plusRuntime = { navigator: { isImmersedStatusbar: () => true, getStatusbarHeight: () => 24 } }
    expect(resolveStatusBarHeight(plusRuntime, { getSystemInfoSync: () => ({ statusBarHeight: 20 }) })).toBe(24)
    expect(resolveStatusBarHeight({ navigator: { isImmersedStatusbar: () => false } }, { getSystemInfoSync: () => ({ statusBarHeight: 20 }) })).toBe(0)
    expect(resolveStatusBarHeight({ navigator: { isImmersedStatusbar: () => { throw new Error('unavailable') } } }, { getSystemInfoSync: () => ({ statusBarHeight: 20 }) })).toBe(20)
    expect(resolveStatusBarHeight(null, { getSystemInfoSync: () => { throw new Error('unavailable') } })).toBe(0)
  })

  test('configures a transparent status bar with dark content without throwing on partial runtimes', () => {
    const navigator = { setStatusBarBackground: jest.fn(), setStatusBarStyle: jest.fn() }
    expect(configureStatusBar({ navigator })).toBe(true)
    expect(navigator.setStatusBarBackground).toHaveBeenCalledWith('#00000000')
    expect(navigator.setStatusBarStyle).toHaveBeenCalledWith('dark')
    expect(configureStatusBar(null)).toBe(false)
  })

  test('parses online HTTP(S) source and keeps its origin', () => {
    expect(parseBridgeSource(' https://example.test/a?x=1#hash ')).toEqual({ src: 'https://example.test/a?x=1#hash', kind: 'remote', origin: 'https://example.test' })
  })
  test('keeps local hybrid source without applying web origin rules', () => {
    expect(parseBridgeSource('/hybrid/html/index.html#/index')).toEqual({ src: '/hybrid/html/index.html#/index', kind: 'local', origin: null })
  })
  test('rejects an empty source', () => {
    expect(() => parseBridgeSource('  ')).toThrow(/src/)
  })
})

describe('bridge shell lifecycle', () => {
  test('hide and destroy are idempotent', async () => {
    const hide = jest.fn(); const destroy = jest.fn(() => Promise.resolve())
    const lifecycle = createShellLifecycle({ hide, destroy })
    expect(lifecycle.hide()).toBe(true); expect(lifecycle.hide()).toBe(false)
    lifecycle.show(); lifecycle.hide()
    await Promise.all([lifecycle.destroy('close'), lifecycle.destroy('component')])
    expect(hide).toHaveBeenCalledTimes(2); expect(destroy).toHaveBeenCalledTimes(1)
    expect(lifecycle.isDestroyed()).toBe(true)
  })
  test('recovers the page webview when a global child component scope has no page API', () => {
    const pageWebview = { id: 'page' }
    const page = { $getAppWebview: jest.fn(() => pageWebview) }
    expect(getPageWebView({}, () => [page], null)).toBe(pageWebview)
    expect(page.$getAppWebview).toHaveBeenCalledTimes(1)
  })

  test('falls back to current native page after scope becomes available later', () => {
    const current = { id: 'current-page' }
    const runtime = { webview: { currentWebview: jest.fn(() => current) } }
    expect(getPageWebView(null, () => [], runtime)).toBe(current)
    const scoped = { id: 'scoped-page' }
    expect(getPageWebView({ $getAppWebview: () => scoped }, () => [], runtime)).toBe(scoped)
  })

  test('uses direct children or strict parent ownership from plus.webview.all', () => {
    const page = { id: 'page', children: jest.fn(() => []) }
    const owned = { id: 'owned', evalJS: jest.fn(), parent: () => page }
    const unrelatedPage = { id: 'other-page' }
    const unrelated = { id: 'other', evalJS: jest.fn(), parent: () => unrelatedPage }
    expect(getOwnedWebViewCandidates(page, { webview: { all: () => [page, unrelated, owned] } })).toEqual([owned])
    const direct = { id: 'direct', evalJS: jest.fn() }
    page.children.mockReturnValue([direct])
    expect(getOwnedWebViewCandidates(page, { webview: { all: jest.fn() } })).toEqual([direct])
  })

  test('reads getURL only once and accepts URL object string formats', () => {
    const getURL = jest.fn(() => new String('https://example.test/a'))
    expect(getNativeWebViewUrl({ getURL })).toBe('')
    expect(getURL).toHaveBeenCalledTimes(1)
    const url = jest.fn(() => 'https://example.test/a')
    expect(getNativeWebViewUrl({ getURL: url })).toBe('https://example.test/a')
    expect(url).toHaveBeenCalledTimes(1)
  })

  test('waits for a delayed native webview and matches URL even when ids differ', async () => {
    jest.useFakeTimers()
    const expected = { id: 'native-random-id', getURL: () => 'https://example.test/a', evalJS: jest.fn() }
    const unrelated = { id: 'acb-webview-1', getURL: () => 'https://other.test/', evalJS: jest.fn() }
    let calls = 0
    const pending = waitForWebView(() => {
      calls += 1
      if (calls < 3) return resolveWebViewCandidate([], 'https://example.test/a')
      return resolveWebViewCandidate([unrelated, expected], 'https://example.test/a')
    }, { timeoutMs: 30, delayMs: 10 })
    jest.advanceTimersByTime(20)
    await expect(pending).resolves.toMatchObject({ webview: expected, strategy: 'url', candidateCount: 2 })
    jest.useRealTimers()
  })

  test('normalizes remote and hybrid paths and only falls back for one candidate', () => {
    expect(normalizeWebViewUrl('HTTPS://Example.Test:443/a/')).toBe('https://example.test/a')
    expect(normalizeWebViewUrl('file:///data/apps/id/www/hybrid/html/index.html#/index')).toBe('/hybrid/html/index.html#/index')
    const only = { id: 'x', evalJS: jest.fn() }
    expect(resolveWebViewCandidate([only], '/hybrid/missing.html')).toMatchObject({ webview: only, strategy: 'unique-fallback' })
    expect(() => resolveWebViewCandidate([only, { id: 'y', evalJS: jest.fn() }], '/hybrid/missing.html')).toThrow(/候选数量: 2/)
  })

  test('times out and destroy cancellation stops delayed retries', async () => {
    const timed = waitForWebView(() => resolveWebViewCandidate([], '/x'), { timeoutMs: 20, delayMs: 10 })
    await expect(timed).rejects.toMatchObject({ code: 'WEBVIEW_BIND_TIMEOUT' })
    const signal = { cancelled: false }
    const cancelled = waitForWebView(() => resolveWebViewCandidate([], '/x'), { timeoutMs: 100, delayMs: 10, signal })
    signal.cancelled = true
    await expect(cancelled).rejects.toMatchObject({ code: 'WEBVIEW_BIND_CANCELLED' })
  })

  test('buffers only valid ready, caps at four, flushes in order and clears', () => {
    const dropped = []; const received = []
    const buffer = createStartupReadyBuffer({ limit: 4, onDrop: item => dropped.push(item.reason) })
    const ready = sessionId => ({ protocol: 'app-capability-bridge', version: 1, type: 'ready', sender: 'h5', sessionId, generation: 0, messageId: `m-${sessionId}`, sentAt: 1, capabilitiesRequested: [] })
    expect(buffer.push({ type: 'request' })).toBe(false)
    ;['a', 'b', 'c', 'd', 'e'].forEach(id => buffer.push(ready(id)))
    expect(buffer.size()).toBe(4); expect(dropped).toEqual(['invalid', 'overflow'])
    expect(buffer.flush(message => received.push(message.sessionId))).toBe(4)
    expect(received).toEqual(['b', 'c', 'd', 'e']); expect(buffer.size()).toBe(0)
    buffer.push(ready('f')); expect(buffer.clear('reload')).toBe(1)
  })

  test('hidden pages keep routing protocol messages while hide still cancels scan', () => {
    const component = fs.readFileSync(path.resolve(__dirname, '../components/app-capability-bridge-shell/app-capability-bridge-shell.vue'), 'utf8')
    expect(component).toMatch(/createShellLifecycle\(\{ hide: reason => \{ if \(this\.bridge\) this\.bridge\.cancelScan/)
    expect(component).not.toMatch(/handleWebViewMessage\(event\) \{[\s\S]{0,180}isVisible\(\)/)
  })

  test('component mounts without load, shares mounted/load start, ignores late first load, reloads on real navigation, and cancels destroy', () => {
    const component = fs.readFileSync(path.resolve(__dirname, '../components/app-capability-bridge-shell/app-capability-bridge-shell.vue'), 'utf8')
    expect(component).toMatch(/mounted\.start\.schedule/)
    expect(component).toMatch(/this\.\$nextTick\([\s\S]*this\.start\('mounted'\)/)
    expect(component).toMatch(/singleflight\.reuse/)
    expect(component).toMatch(/firstForSource[\s\S]*load\.supplemental[\s\S]*load\.reload/)
    expect(component).toMatch(/addEventListener\('loaded'/)
    expect(component).toMatch(/removeEventListener\('loaded'/)
    expect(component).toMatch(/bindCancellation\.cancelled = true/)
    expect(component).toMatch(/startupReady\.flush\(message => bridge\.receive\(message\)\)/)
  })

  test('uses page webview and app runtime events and detaches them idempotently', () => {
    const target = () => ({ addEventListener: jest.fn(), removeEventListener: jest.fn() })
    const pageWebview = target(); const globalEvent = target()
    const detach = attachRuntimeLifecycle({ pageWebview, globalEvent, show: jest.fn(), hide: jest.fn(), close: jest.fn() })
    expect(pageWebview.addEventListener.mock.calls.map(call => call[0])).toEqual(['show', 'hide', 'close'])
    expect(globalEvent.addEventListener.mock.calls.map(call => call[0])).toEqual(['resume', 'pause'])
    detach()
    detach()
    expect(pageWebview.removeEventListener).toHaveBeenCalledTimes(3)
    expect(globalEvent.removeEventListener).toHaveBeenCalledTimes(2)
  })
})