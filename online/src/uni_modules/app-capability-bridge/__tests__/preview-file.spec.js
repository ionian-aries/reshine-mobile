import { MAX_BYTES, readPreviewDataUrl } from '../js_sdk/services/preview-file.js'

const PNG = 'iVBORw0KGgo='
const JPEG = '/9j/AA=='
const data = (mime = 'image/png', base64 = PNG) => `data:${mime};base64,${base64}`

function runtime({ entryPath = '/storage/emulated/0/Android/data/app/doc/uniapp_temp/canvas-a.png', rootPath = '/storage/emulated/0/Android/data/app/doc', fileSize = 8, result = data(), remove = jest.fn(success => success()) } = {}) {
  const entry = { fullPath: entryPath, isDirectory: false, remove, file: success => success({ size: fileSize }) }
  const io = {
    PRIVATE_DOC: 1, PUBLIC_DOWNLOADS: 2,
    resolveLocalFileSystemURL: jest.fn((value, success, failure) => value.includes('missing') ? failure() : success(entry)),
    requestFileSystem: jest.fn((type, success) => success({ root: { fullPath: type === 1 ? rootPath : '/storage/emulated/0/Download' } })),
  }
  class FileReader { readAsDataURL() { this.onloadend({ target: { result } }) } }
  return { io, FileReader, entry, remove }
}

async function codeOf(promise) { try { await promise } catch (error) { return error.code } throw new Error('expected rejection') }

describe('preview file security', () => {
  test.each(['content://media/1', '/storage/emulated/0/a.png', '_doc/a/../b.png', '_doc/a/%2e%2e/b.png', '_doc/a/%252e%252e/b.png'])('rejects unsafe input %s', async value => {
    expect(await codeOf(readPreviewDataUrl(value, runtime()))).toBe('UNSAFE_TEMP_PATH')
  })
  test('resolves _doc input to an absolute storage path and cleans recognizable temp file', async () => {
    const env = runtime(); await expect(readPreviewDataUrl('_doc/uniapp_temp/canvas-a.png', env)).resolves.toBe(data()); expect(env.remove).toHaveBeenCalled()
  })
  test('accepts file URL only after approved root comparison', async () => {
    await expect(readPreviewDataUrl('file:///storage/emulated/0/Android/data/app/doc/uniapp_temp/canvas-a.png', runtime())).resolves.toBe(data())
  })
  test('enforces downloads policy', async () => {
    const env = runtime({ entryPath: '/storage/emulated/0/Download/temp/canvas-a.png' })
    await expect(readPreviewDataUrl('_downloads/temp/canvas-a.png', env)).resolves.toBe(data())
    expect(await codeOf(readPreviewDataUrl('_downloads/temp/canvas-a.png', Object.assign({}, env, { allowDownloads: false })))).toBe('UNSAFE_TEMP_PATH')
  })
  test('rejects root prefix collision', async () => {
    const env = runtime({ entryPath: '/storage/emulated/0/Android/data/app/document/canvas-a.png' })
    expect(await codeOf(readPreviewDataUrl('_doc/canvas-a.png', env))).toBe('UNSAFE_TEMP_PATH'); expect(env.remove).not.toHaveBeenCalled()
  })
  test('rejects missing files', async () => { expect(await codeOf(readPreviewDataUrl('_doc/missing.png', runtime()))).toBe('ERROR_GET_IMAGE_DATA') })
  test('rejects pre-read oversize', async () => { expect(await codeOf(readPreviewDataUrl('_doc/uniapp_temp/canvas-a.png', runtime({ fileSize: MAX_BYTES + 1 })))).toBe('PAYLOAD_TOO_LARGE') })
  test('rejects post-read oversize while accepting exact 5 MiB', async () => {
    const bytes = new Uint8Array(MAX_BYTES); bytes.set([137,80,78,71,13,10,26,10]); const base64 = Buffer.from(bytes).toString('base64')
    await expect(readPreviewDataUrl(data('image/png', base64))).resolves.toBe(data('image/png', base64))
    const larger = Buffer.concat([Buffer.from(bytes), Buffer.from([0])]).toString('base64')
    expect(await codeOf(readPreviewDataUrl('_doc/uniapp_temp/canvas-a.png', runtime({ fileSize: MAX_BYTES, result: data('image/png', larger) })))).toBe('PAYLOAD_TOO_LARGE')
  })
  test.each([
    ['invalid base64', 'data:image/png;base64,@@@@'],
    ['non-canonical base64', 'data:image/png;base64,iVB='],
    ['mime magic mismatch', data('image/jpeg', PNG)],
  ])('rejects %s', async (_, value) => { expect(await codeOf(readPreviewDataUrl(value))).toBe('ERROR_GET_IMAGE_DATA') })
  test('accepts JPEG magic', async () => { await expect(readPreviewDataUrl(data('image/jpeg', JPEG))).resolves.toBe(data('image/jpeg', JPEG)) })
  test('does not delete approved but unrecognized files and logs cleanup decision without paths', async () => {
    const logs = []; const env = runtime({ entryPath: '/storage/emulated/0/Android/data/app/doc/report.png' }); env.log = (...args) => logs.push(args)
    await readPreviewDataUrl('_doc/report.png', env); expect(env.remove).not.toHaveBeenCalled(); expect(logs).toEqual(expect.arrayContaining([expect.arrayContaining(['PreviewFile', 'cleanup', expect.objectContaining({ cleanup: 'skipped-unrecognized' })])]))
    expect(JSON.stringify(logs)).not.toContain('/storage/')
  })
})