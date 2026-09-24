export const PROTOCOL = 'app-capability-bridge' as const;
export const VERSION = 1 as const;
export const RECEIVER_NAME = '__APP_CAPABILITY_BRIDGE_RECEIVE__' as const;
export const DEFAULT_LIMITS = Object.freeze({
  maxMessageUtf8Bytes: 128 * 1024,
  maxPending: 200,
  maxQueue: 100,
  maxInbound: 32,
});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type BridgeRole = 'h5' | 'app';
export type BridgeState = 'idle' | 'starting' | 'listening' | 'connecting' | 'ready' | 'failed' | 'destroying' | 'destroyed';
export type MessageType = 'ready' | 'ready-ack' | 'request' | 'response' | 'disconnect';

export interface BridgeMessage {
  protocol: typeof PROTOCOL;
  version: typeof VERSION;
  type: MessageType;
  sender: BridgeRole;
  sessionId: string;
  generation: number;
  messageId: string;
  sentAt: number;
  [key: string]: unknown;
}

export interface BridgeTransport {
  start?(receiver: (message: unknown) => void): void | Promise<void>;
  send(message: BridgeMessage): void | Promise<void>;
  destroy(): void | Promise<void>;
}

export class BridgeError extends Error {
  readonly code: string;
  readonly data?: JsonValue;
  constructor(code: string, message: string, data?: JsonValue) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }
}

export function safeError(error: unknown, fallback = 'Bridge operation failed'): { code: string; message: string; data?: JsonValue } {
  if (error instanceof BridgeError) return error.data === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, data: error.data };
  return { code: 'HANDLER_ERROR', message: fallback };
}