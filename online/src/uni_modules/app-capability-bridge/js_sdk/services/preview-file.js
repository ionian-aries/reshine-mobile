import { ActionValidationError } from './action-validation.js'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function fail(message, code = 'ERROR_GET_IMAGE_DATA') {
  return new ActionValidationError(message, code)
}

function inspectInput(value, allowDownloads) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('预览图片为空')
  if (/^content:\/\//i.test(value) || value[0] === '/') throw fail('预览临时路径不在允许沙箱', 'UNSAFE_TEMP_PATH')
  let decoded
  try {
    decoded = value
    for (let i = 0; i < 3; i += 1) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next }
  } catch (_) { throw fail('预览临时路径编码无效', 'UNSAFE_TEMP_PATH') }
  if (decoded.includes('\0') || decoded.split(/[\\/]+/).includes('..')) throw fail('预览临时路径包含越界片段', 'UNSAFE_TEMP_PATH')
  if (/^_doc\//i.test(decoded)) return { kind: 'doc', reference: value }
  if (/^_downloads\//i.test(decoded)) {
    if (!allowDownloads) throw fail('下载目录预览未启用', 'UNSAFE_TEMP_PATH')
    return { kind: 'downloads', reference: value }
  }
  if (/^file:\/\/[^/]/i.test(decoded)) throw fail('file URL 必须是本机绝对路径', 'UNSAFE_TEMP_PATH')
  if (/^file:\/\//i.test(decoded)) return { kind: 'file', reference: value }
  throw fail('预览临时路径格式不受支持', 'UNSAFE_TEMP_PATH')
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value) return ''
  let path = value
  try { path = decodeURIComponent(path) } catch (_) { return '' }
  path = path.replace(/^file:\/\//i, '').replace(/\\/g, '/')
  if (path[0] !== '/' || path.includes('\0')) return ''
  const parts = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return ''; parts.pop() } else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function entryPath(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const candidates = [entry.fullPath]
  try { if (typeof entry.toLocalURL === 'function') candidates.push(entry.toLocalURL()) } catch (_) {}
  for (const candidate of candidates) { const path = absolutePath(candidate); if (path) return path }
  return ''
}

function inside(path, root) {
  return !!path && !!root && path !== root && path.startsWith(`${root}/`)
}

function requestRoot(io, type) {
  return new Promise((resolve, reject) => {
    if (type === undefined || typeof io.requestFileSystem !== 'function') return reject(fail('无法确认预览文件沙箱', 'UNSAFE_TEMP_PATH'))
    try { io.requestFileSystem(type, fs => resolve(fs && fs.root), () => reject(fail('无法确认预览文件沙箱', 'UNSAFE_TEMP_PATH'))) } catch (_) { reject(fail('无法确认预览文件沙箱', 'UNSAFE_TEMP_PATH')) }
  })
}

function resolveEntry(io, reference) {
  return new Promise((resolve, reject) => {
    if (typeof io.resolveLocalFileSystemURL !== 'function') return reject(fail('临时文件读取能力不可用'))
    try { io.resolveLocalFileSystemURL(reference, resolve, () => reject(fail('读取预览临时文件失败'))) } catch (_) { reject(fail('读取预览临时文件失败')) }
  })
}

function getFile(entry) {
  return new Promise((resolve, reject) => {
    if (!entry || typeof entry.file !== 'function') return reject(fail('预览临时文件不存在'))
    try { entry.file(resolve, () => reject(fail('读取预览临时文件失败'))) } catch (_) { reject(fail('读取预览临时文件失败')) }
  })
}

function readDataUrl(file, Reader) {
  return new Promise((resolve, reject) => {
    let reader
    try { reader = new Reader() } catch (_) { return reject(fail('临时文件读取能力不可用')) }
    reader.onerror = () => reject(fail('读取预览临时文件失败'))
    reader.onloadend = event => resolve(event && event.target && event.target.result)
    try { reader.readAsDataURL(file) } catch (_) { reject(fail('读取预览临时文件失败')) }
  })
}

function decodedSize(base64) {
  if (!base64 || base64.length % 4 || !BASE64.test(base64)) return -1
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0)
  if (base64.slice(0, -padding || undefined).includes('=')) return -1
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (padding === 2 && (chars.indexOf(base64[base64.length - 3]) & 15) !== 0) return -1
  if (padding === 1 && (chars.indexOf(base64[base64.length - 2]) & 3) !== 0) return -1
  return (base64.length / 4) * 3 - padding
}

function firstBytes(base64, count = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const output = []
  for (let i = 0; i < base64.length && output.length < count; i += 4) {
    const a = chars.indexOf(base64[i]); const b = chars.indexOf(base64[i + 1])
    const c = base64[i + 2] === '=' ? 0 : chars.indexOf(base64[i + 2])
    const d = base64[i + 3] === '=' ? 0 : chars.indexOf(base64[i + 3])
    if (a < 0 || b < 0 || c < 0 || d < 0) return []
    output.push((a << 2) | (b >> 4))
    if (base64[i + 2] !== '=' && output.length < count) output.push(((b & 15) << 4) | (c >> 2))
    if (base64[i + 3] !== '=' && output.length < count) output.push(((c & 3) << 6) | d)
  }
  return output
}

function magicMatches(mime, bytes) {
  if (mime === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  return false
}

function validateDataUrl(value) {
  if (typeof value !== 'string') throw fail('读取预览临时文件失败')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value)
  if (!match) throw fail('预览图片 Data URL 无效')
  const mime = match[1].toLowerCase(); const base64 = match[2]; const bytes = decodedSize(base64)
  if (!ALLOWED_MIME.has(mime) || bytes < 0) throw fail('预览图片 Data URL 无效')
  if (bytes > MAX_BYTES) throw fail('预览图片超过 5 MiB', 'PAYLOAD_TOO_LARGE')
  if (!magicMatches(mime, firstBytes(base64))) throw fail('预览图片 MIME 与内容不一致')
  return { value, mime, bytes }
}

function recognizableTemporary(path) {
  const name = path.split('/').pop() || ''
  return /\.(?:png|jpe?g|webp)$/i.test(name) && (/(?:^|\/)(?:uniapp_temp|temp|tmp)(?:\/|$)/i.test(path) || /^(?:canvas|temp|tmp|uniapp)[-_]/i.test(name))
}

function removeEntry(entry) {
  return new Promise(resolve => {
    if (!entry || typeof entry.remove !== 'function') return resolve(false)
    try { entry.remove(() => resolve(true), () => resolve(false)) } catch (_) { resolve(false) }
  })
}

export async function readPreviewDataUrl(value, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const direct = typeof value === 'string' && /^data:/i.test(value)
  if (direct) {
    const result = validateDataUrl(value)
    log('PreviewFile', 'read.complete', { inputKind: 'data-url', resolveSuccess: false, rootCheck: 'not-needed', fileBytes: result.bytes, readSuccess: true, mime: result.mime, dataBytes: result.bytes, cleanup: 'not-needed' })
    return result.value
  }

  const allowDownloads = options.allowDownloads !== false
  let input
  try { input = inspectInput(value, allowDownloads) } catch (error) { log('PreviewFile', 'read.rejected', { inputKind: 'rejected', resolveSuccess: false, rootCheck: 'not-run', readSuccess: false, cleanup: 'not-run', code: error.code }); throw error }
  const io = options.io || (globalThis.plus && globalThis.plus.io)
  if (!io) throw fail('临时文件读取能力不可用')
  let entry; let approved = false; let path = ''; let cleanup = 'skipped-unverified'; let readSuccess = false; let fileBytes
  try {
    entry = await resolveEntry(io, input.reference)
    path = entryPath(entry)
    if (!path || entry.isDirectory === true) throw fail('临时路径规范化失败', 'UNSAFE_TEMP_PATH')
    const rootTypes = input.kind === 'doc' ? [io.PRIVATE_DOC] : (input.kind === 'downloads' ? [io.PUBLIC_DOWNLOADS] : [io.PRIVATE_DOC, ...(allowDownloads ? [io.PUBLIC_DOWNLOADS] : [])])
    const roots = []
    for (const type of rootTypes) {
      try { const root = await requestRoot(io, type); const rootPath = entryPath(root); if (rootPath) roots.push(rootPath) } catch (_) { /* Other candidate roots may still be available. */ }
    }
    approved = roots.some(root => inside(path, root))
    if (!approved) throw fail('预览临时路径规范化后越界', 'UNSAFE_TEMP_PATH')
    const file = await getFile(entry)
    fileBytes = Number(file && file.size)
    if (!Number.isFinite(fileBytes) || fileBytes < 0) throw fail('无法确认预览文件大小')
    if (fileBytes > MAX_BYTES) throw fail('预览图片超过 5 MiB', 'PAYLOAD_TOO_LARGE')
    const Reader = options.FileReader || (globalThis.plus && globalThis.plus.io && globalThis.plus.io.FileReader)
    if (typeof Reader !== 'function') throw fail('临时文件读取能力不可用')
    const parsed = validateDataUrl(await readDataUrl(file, Reader))
    readSuccess = true
    log('PreviewFile', 'read.complete', { inputKind: input.kind, resolveSuccess: true, rootCheck: 'approved', fileBytes, readSuccess, mime: parsed.mime, dataBytes: parsed.bytes, cleanup: recognizableTemporary(path) ? 'pending' : 'skipped-unrecognized' })
    return parsed.value
  } finally {
    if (entry && approved && recognizableTemporary(path)) cleanup = await removeEntry(entry) ? 'removed' : 'remove-failed'
    else cleanup = approved ? 'skipped-unrecognized' : 'skipped-unverified'
    log('PreviewFile', 'cleanup', { inputKind: input.kind, resolveSuccess: !!entry, rootCheck: approved ? 'approved' : 'rejected', fileBytes, readSuccess, cleanup })
  }
}

export { MAX_BYTES }