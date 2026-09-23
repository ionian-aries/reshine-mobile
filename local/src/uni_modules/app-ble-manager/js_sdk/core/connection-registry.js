function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}

export default class ConnectionRegistry {
  constructor() {
    this.sessions = new Map();
  }

  ensure(deviceId, owner, deviceType) {
    let session = this.sessions.get(deviceId);
    if (!session) {
      session = {
        deviceId,
        owner,
        owners: new Set(owner ? [owner] : []),
        deviceType,
        connected: false,
        state: 'disconnected',
        subscriptions: new Map(),
        manuallyDisconnected: false,
        lastError: undefined,
        generation: 0,
        enqueue: createQueue(),
      };
      this.sessions.set(deviceId, session);
    } else {
      if (!session.owners) session.owners = new Set(session.owner ? [session.owner] : []);
      if (owner) {
        session.owners.add(owner);
        if (!session.owner) session.owner = owner;
      }
      if (deviceType && !session.deviceType) session.deviceType = deviceType;
    }
    return session;
  }

  get(deviceId) { return this.sessions.get(deviceId); }
  hasActiveConnections() { return Array.from(this.sessions.values()).some((item) => item.connected); }
  active() { return Array.from(this.sessions.values()).filter((item) => item.connected); }
  remove(deviceId) { this.sessions.delete(deviceId); }
  clear() { this.sessions.clear(); }

  updateConnection(event) {
    if (!event || !event.deviceId) return undefined;
    const session = this.ensure(event.deviceId);
    session.connected = !!event.connected;
    session.state = event.connected ? 'connected' : 'disconnected';
    return session;
  }

  toPublic(session) {
    if (!session) return undefined;
    return {
      deviceId: session.deviceId,
      deviceType: session.deviceType,
      owner: session.owner,
      owners: Array.from(session.owners || (session.owner ? [session.owner] : [])),
      connected: session.connected,
      state: session.state,
      manuallyDisconnected: session.manuallyDisconnected,
      lastError: session.lastError,
    };
  }

  listPublic() { return Array.from(this.sessions.values()).map((item) => this.toPublic(item)); }
}