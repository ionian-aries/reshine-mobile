export class MemoryTransport {
  constructor() { this.peer = null; this.receiver = null; this.destroyed = false; this.delay = 0 }
  connect(peer) { this.peer = peer; peer.peer = this; return this }
  start(receiver) { this.receiver = receiver; this.destroyed = false }
  async send(message) { if (this.destroyed) throw new Error('destroyed'); if (this.delay) await new Promise(resolve => setTimeout(resolve, Math.random() * this.delay)); if (this.peer && this.peer.receiver) this.peer.receiver(message) }
  destroy() { this.receiver = null; this.destroyed = true }
}