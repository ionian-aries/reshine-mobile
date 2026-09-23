const DIRECT_LIMIT_BYTES = 128 * 1024
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
const HTTP_URL = /^https?:\/\/[^\s]+$/i
const GAP_TYPES = [0, 1, 2, 3, 4, 255]
const NO_PARAM_ACTIONS = new Set(['bluetooth_getState', 'bluetooth_enable', 'bluetooth_disable', 'scale_disconnect', 'scale_status', 'printer_disconnect', 'printer_status', 'scan_cancel'])
const OBJECT_PARAM_ACTIONS = new Set(['scan_start', 'bluetooth_search', 'scale_connect', 'scale_readWeight', 'printer_connect', 'printer_print', 'printer_preview'])

export class ActionValidationError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') { super(message); this.code = code }
}

export function objectParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionValidationError('参数必须是普通对象')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ActionValidationError('参数必须是普通对象')
  return value
}
export function noParams(value) {
  if (value !== undefined) throw new ActionValidationError('此操作不接受参数')
}
export function validateActionParams(action, value) {
  if (NO_PARAM_ACTIONS.has(action)) return noParams(value)
  if (OBJECT_PARAM_ACTIONS.has(action)) return objectParams(value)
}
export function exact(value, keys) {
  const params = objectParams(value)
  const allowed = new Set(keys)
  Object.keys(params).forEach(key => { if (!allowed.has(key)) throw new ActionValidationError(`未知参数: ${key}`) })
  return params
}
export function requiredString(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ActionValidationError(`${name} 必须是非空字符串`)
  return value.trim()
}
export function optionalString(value, name, max = 256) {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) throw new ActionValidationError(`${name} 必须是字符串`)
  return value.trim()
}
export function integer(value, name, min, max, fallback, allowed) {
  const result = value === undefined ? fallback : value
  if (!Number.isInteger(result) || result < min || result > max || (allowed && !allowed.includes(result))) throw new ActionValidationError(`${name} 参数无效`)
  return result
}
export function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= min || value > max) throw new ActionValidationError(`${name} 参数无效`)
  return value
}
export function boolean(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ActionValidationError(`${name} 必须是布尔值`)
  return value
}
export function validateImage(image, directLimitBytes = Number.POSITIVE_INFINITY) {
  const value = requiredString(image, 'image', 8 * 1024 * 1024)
  if (HTTP_URL.test(value)) {
    if (value.length > 8192) throw new ActionValidationError('图片 URL 过长')
  } else {
    const match = value.match(DATA_URL)
    if (!match) throw new ActionValidationError('image 必须是 PNG/JPEG/WebP Data URL 或 HTTP(S) URL')
    if (match[2].length % 4 !== 0) throw new ActionValidationError('Data URL Base64 无效')
  }
  if (utf8Bytes(value) > directLimitBytes) throw new ActionValidationError('本阶段不支持大图片传输', 'LARGE_PAYLOAD_UNSUPPORTED')
  return value
}
export function printJob(params, canvasId, preview) {
  const keys = preview
    ? ['image', 'imageAttachment', 'width', 'height', 'orientation', 'threshold']
    : ['image', 'imageAttachment', 'width', 'height', 'orientation', 'copies', 'gapType', 'printDarkness', 'printSpeed', 'threshold']
  const value = exact(params, keys)
  const result = {
    image: value.imageAttachment ? '' : validateImage(value.image), width: finite(value.width, 'width', 0, 1000), height: finite(value.height, 'height', 0, 5000),
    orientation: integer(value.orientation, 'orientation', 0, 270, 0, [0, 90, 180, 270]),
    threshold: integer(value.threshold, 'threshold', 0, 255, 128), canvasId,
  }
  if (!preview) Object.assign(result, {
    copies: integer(value.copies, 'copies', 1, 1000, 1), gapType: integer(value.gapType, 'gapType', 0, 255, 255, GAP_TYPES),
    darkness: integer(value.printDarkness, 'printDarkness', 1, 255, 255, [...Array(15)].map((_, i) => i + 1).concat(255)),
    speed: integer(value.printSpeed, 'printSpeed', 1, 255, 255, [1, 2, 3, 4, 5, 255]),
  })
  return result
}
function utf8Bytes(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
  return unescape(encodeURIComponent(value)).length
}
export { DIRECT_LIMIT_BYTES }