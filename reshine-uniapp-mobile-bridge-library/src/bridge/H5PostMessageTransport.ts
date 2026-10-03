import { BridgeError, BridgeMessage, BridgeTransport, RECEIVER_NAME } from './contract';

export const RECEIVER_OWNER = Symbol.for('app-capability-bridge.receiver-owner');

type BridgeWindow = Window & typeof globalThis & {
  uni?: { webView?: { postMessage?: (options: { data: unknown }) => void } };
  [RECEIVER_NAME]?: ((message: unknown) => void) & { [RECEIVER_OWNER]?: symbol };
};

export class H5PostMessageTransport implements BridgeTransport {
  private receiver?: ((message: unknown) => void) & { [RECEIVER_OWNER]?: symbol };
  private readonly owner = Symbol('h5-transport-owner');
  constructor(private readonly target: BridgeWindow = window as BridgeWindow) {}

  start(receiver: (message: unknown) => void): void {
    const existing = this.target[RECEIVER_NAME];
    if (existing && existing !== this.receiver) throw new BridgeError('INITIALIZATION_FAILED', 'Bridge receiver is already owned');
    const owned = ((message: unknown) => receiver(message)) as typeof this.receiver;
    Object.defineProperty(owned!, RECEIVER_OWNER, { value: this.owner });
    Object.defineProperty(this.target, RECEIVER_NAME, { value: owned, configurable: true, enumerable: false, writable: false });
    this.receiver = owned;
  }

  send(message: BridgeMessage): void {
    const postMessage = this.target.uni?.webView?.postMessage;
    if (typeof postMessage !== 'function') throw new BridgeError('SDK_UNAVAILABLE', 'uni.webView.postMessage is unavailable');
    postMessage.call(this.target.uni!.webView, { data: message });
  }

  destroy(): void {
    if (this.receiver && this.target[RECEIVER_NAME] === this.receiver) delete this.target[RECEIVER_NAME];
    this.receiver = undefined;
  }
}