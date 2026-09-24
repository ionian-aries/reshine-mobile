import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL, RECEIVER_NAME, VERSION, type BridgeMessage } from '../../src/bridge/contract';
import { destroyH5Bridge, getH5Bridge, initH5Bridge } from '../../src/bridge/h5-lifecycle';

function installApp() {
  const sent: BridgeMessage[] = [];
  (window as any).uni = { webView: { postMessage: vi.fn(({ data }: { data: BridgeMessage }) => {
    sent.push(data);
    if (data.type === 'ready') queueMicrotask(() => (window as any)[RECEIVER_NAME]?.({
      protocol: PROTOCOL, version: VERSION, type: 'ready-ack', sender: 'app',
      sessionId: data.sessionId, generation: 1, messageId: `ack-${data.messageId}`,
      sentAt: Date.now(), accepted: true, capabilities: [], limits: {},
    }));
  }) } };
  return sent;
}

async function init() { return initH5Bridge({ ownerToken: 'legacy-owner', connectTimeoutMs: 50 }); }

async function cleanup() {
  await destroyH5Bridge('legacy-owner');
  delete (window as any).uni;
  delete (window as any)[RECEIVER_NAME];
}
afterEach(cleanup);

describe('H5 bridge lifecycle', () => {
  it('fully cleans a failed candidate so init can succeed again', async () => {
    installApp();
    Object.defineProperty(window, RECEIVER_NAME, { value: () => undefined, configurable: true });
    expect(await init()).toMatchObject({ ready: false });
    delete (window as any)[RECEIVER_NAME];
    expect(await init()).toMatchObject({ ready: true });
  });

  it('sends one-way disconnect for the current session and generation before destroy', async () => {
    const sent = installApp();
    expect(await init()).toMatchObject({ ready: true });
    const snapshot = getH5Bridge()!.getSnapshot();
    await destroyH5Bridge('legacy-owner');
    expect(sent.at(-1)).toMatchObject({ type: 'disconnect', sender: 'h5', sessionId: snapshot.sessionId, generation: snapshot.generation });
  });

  it('supports repeated init/destroy cycles and isolates stale messages', async () => {
    const sent = installApp();
    expect(await init()).toMatchObject({ ready: true });
    const old = getH5Bridge()!.getSnapshot();
    await destroyH5Bridge('legacy-owner');
    expect(await init()).toMatchObject({ ready: true });
    const current = getH5Bridge()!;
    const now = current.getSnapshot();
    expect(now.sessionId).not.toBe(old.sessionId);
    (window as any)[RECEIVER_NAME]({
      protocol: PROTOCOL, version: VERSION, type: 'disconnect', sender: 'app', sessionId: old.sessionId,
      generation: old.generation, messageId: 'stale-disconnect', sentAt: Date.now(), reason: 'stale',
    });
    expect(current.getSnapshot()).toMatchObject({ state: 'ready', sessionId: now.sessionId, generation: now.generation });
    await destroyH5Bridge('legacy-owner');
    expect(sent.filter((message) => message.type === 'disconnect')).toHaveLength(2);
  });
});