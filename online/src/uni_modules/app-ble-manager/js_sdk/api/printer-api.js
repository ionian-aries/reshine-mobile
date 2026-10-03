const EVENT_MAP = {
  discoveryStateChanged: 'printer:discoveryStateChanged',
  deviceFound: 'printer:deviceFound',
  stateChanged: 'printer:stateChanged',
  error: 'printer:error',
};

export default function createPrinterApi(service) {
  return Object.freeze({
    startDiscovery: (options) => service.startDiscovery(options),
    stopDiscovery: (scanId) => service.stopDiscovery(scanId),
    connect: (options) => service.connect(options),
    disconnect: () => service.disconnect(),
    getState: () => service.getState(),
    preview: (job) => service.preview(job),
    print: (job) => service.print(job),
    on(eventName, handler) {
      const internalName = EVENT_MAP[eventName];
      if (!internalName) throw new Error(`不支持的打印机事件：${eventName}`);
      if (typeof handler !== 'function') throw new TypeError(`打印机事件 ${eventName} 的 handler 必须是函数`);
      return service.dispatcher.on(internalName, handler);
    },
    off(eventName, handler) {
      const internalName = EVENT_MAP[eventName];
      if (!internalName) throw new Error(`不支持的打印机事件：${eventName}`);
      if (typeof handler !== 'function') return;
      service.dispatcher.off(internalName, handler);
    },
  });
}
