import { getAppInfo } from '../../../app-upgrade/js_sdk/runtime.js'

// This is the only app-capability-bridge module allowed to import app-upgrade runtime information.
export function createAppInfoAdapter(read = getAppInfo) {
  return Object.freeze({ getAppInfo: () => read() })
}

export default createAppInfoAdapter()