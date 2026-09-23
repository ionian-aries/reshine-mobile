const EVENT_MAP = {
  discoveryStateChanged: 'scale:discoveryStateChanged',
  deviceFound: 'scale:deviceFound',
  stateChanged: 'scale:stateChanged',
  rawFrame: 'scale:rawFrame',
  gattDiscovered: 'scale:gattDiscovered',
  probeLog: 'scale:probeLog',
  error: 'scale:error',
};

export default function createScaleApi(service) {
  return Object.freeze({
    startDiscovery: (options) => service.startDiscovery(options),
    stopDiscovery: () => service.stopDiscovery(),
    connect: (deviceId) => service.connect(deviceId),
    disconnect: () => service.disconnect(),
    getState: () => service.getState(),
    readWeight: (timeout) => service.readWeight(timeout),
    on(eventName, handler) {
      const internalName = EVENT_MAP[eventName];
      if (!internalName) throw new Error(`不支持的电子秤事件：${eventName}`);
      return service.dispatcher.on(internalName, handler);
    },
    off(eventName, handler) {
      const internalName = EVENT_MAP[eventName];
      if (internalName) service.dispatcher.off(internalName, handler);
    },
  });
}