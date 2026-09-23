const PREFIX = '[app-upgrade]'

const EVENT_DETAILS = {
  'plugin.install-complete': ['插件初始化', '升级插件已注册，可以监听应用启动并执行更新检查'],
  'plugin.install-skipped': ['插件初始化', '插件已注册，本次跳过重复安装'],
  'plugin.auto-check-start': ['自动检查', '应用启动后开始自动检查并处理可用更新'],
  'plugin.auto-check-skipped': ['自动检查', '自动检查已启动，本次跳过重复执行'],
  'plugin.auto-check-complete': ['自动检查', '自动更新流程已正常结束'],
  'plugin.auto-check-failed': ['自动检查', '自动更新流程执行失败，记录错误以便定位'],
  'component.mounted': ['界面接入', '更新提示组件已挂载并开始监听更新状态'],
  'component.destroy': ['界面接入', '更新提示组件即将销毁并解除状态监听'],
  'component.start-failed': ['界面接入', '组件发起的更新流程失败'],
  'component.retry-failed': ['界面重试', '组件发起的更新重试失败'],
  'flow.start': ['更新检查', '开始执行更新检查主流程'],
  'flow.failed': ['流程失败', '更新流程失败并进入失败状态'],
  'flow.retry': ['流程重试', '重新执行最近一次可重试的更新操作'],
  'flow.dispose': ['流程清理', '终止下载并清理更新状态监听资源'],
  'config.resolved': ['解析配置', '合并并校验更新配置，确认检查地址和执行策略'],
  'runtime.inspect': ['检查运行环境', '检查原生运行时和操作系统是否支持客户端更新'],
  'runtime.check-passed': ['检查运行环境', '当前环境已确认支持 Android App 更新'],
  'runtime.wgt-restart': ['重启应用', 'WGT 资源包安装完成，准备重启以加载新资源'],
  'runtime.install-failed': ['安装更新', '原生运行时安装更新包失败'],
  'version.collected': ['读取当前版本', '已取得应用标识、APK 版本和 WGT 资源版本'],
  'request.start': ['请求更新信息', '向配置的检查服务提交当前版本信息'],
  'request.timeout': ['请求更新信息', '更新检查请求在限定时间内未完成'],
  'request.response': ['接收检查响应', '已收到服务端响应并提取状态和更新动作'],
  'contract.validated': ['校验更新响应', '服务端响应已通过协议及更新包安全校验'],
  'response.decision': ['确定更新决策', '根据服务端动作和自动下载配置决定后续处理'],
  'state.transition': ['更新状态变化', '更新流程已切换到新的阶段'],
  'download.start': ['下载更新包', '开始从已校验的地址下载目标版本更新包'],
  'download.progress': ['下载更新包', '记录更新包下载进度和传输字节数'],
  'download.complete': ['下载更新包', '更新包已下载到本地并可进入安装阶段'],
  'install.start': ['安装更新', '开始安装已下载的更新包'],
  'install.success': ['安装更新', '更新包安装成功，确认是否需要重启应用'],
  'overlay.unavailable': ['原生更新提示', '原生遮罩能力不可用，无法展示强制更新提示'],
  'overlay.created': ['原生更新提示', '已创建阻止退出的原生强制更新提示层'],
  'overlay.retry-failed': ['原生界面重试', '用户通过原生提示层发起的重试失败'],
  'logger.serialization-failed': ['记录升级日志', '日志字段无法序列化，已输出安全降级日志']
}

const UNKNOWN_EVENT = ['升级流程', '记录未登记的升级事件，保留原始事件名用于排查']

function redactUrl(value) {
  return value.replace(/([?&](?:authorization|access_token|token|secret|password|signature|sign)=)[^&#]*/gi, '$1[redacted]')
}

function safeValue(value, depth = 0, key = '') {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return /url$/i.test(key) ? redactUrl(value) : value
  if (depth >= 2) return '[omitted]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1, key))
  if (typeof value === 'object') {
    const output = {}
    Object.keys(value).slice(0, 30).forEach(fieldName => {
      if (/authorization|cookie|token|secret|password|requestData|body|packageContent/i.test(fieldName)) {
        output[fieldName] = '[redacted]'
      } else {
        output[fieldName] = safeValue(value[fieldName], depth + 1, fieldName)
      }
    })
    return output
  }
  return String(value)
}

export function log(event, fields = {}) {
  const eventName = typeof event === 'string' && event ? event : 'unknown'
  const details = EVENT_DETAILS[eventName] || UNKNOWN_EVENT
  const entry = { ...safeValue(fields), event: eventName, step: details[0], description: details[1] }
  try {
    console.log(`${PREFIX} ${JSON.stringify(entry)}`)
  } catch (error) {
    console.log(`${PREFIX} {"event":"logger.serialization-failed","step":"记录升级日志","description":"日志字段无法序列化，已输出安全降级日志"}`)
  }
}

export function logError(event, error, fields = {}) {
  log(event, {
    ...fields,
    code: (error && error.code) || 'UNKNOWN',
    phase: (error && error.phase) || 'idle',
    retryable: Boolean(error && error.retryable),
    message: (error && error.message) || String(error || '未知错误')
  })
}