import manager from '../../../app-ble-manager/js_sdk/index.js'

// This is the only app-capability-bridge module allowed to import app-ble-manager.
export function createBleManagerAdapter(source = manager) {
  if (!source || !source.ble || !source.scale || !source.printer) throw new Error('app-ble-manager APIs are unavailable')
  return Object.freeze({ ble: source.ble, scale: source.scale, printer: source.printer })
}

export default createBleManagerAdapter()