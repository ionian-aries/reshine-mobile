import { BridgeCore } from './BridgeCore';
import { H5PostMessageTransport } from './H5PostMessageTransport';
import { disposeUniWebViewSdk, loadUniWebViewSdk } from './sdk-loader';
import { diagnostic } from './diagnostics';
import { TransferManager } from './transfer';

export interface H5BridgeInitOptions { ownerToken?: string; sdkUrl?: string; sdkTimeoutMs?: number; connectTimeoutMs?: number; callTimeoutMs?: number }
export interface H5BridgeState { ready: boolean; state: string; env: string; isApp: boolean; source: string; owners: number }

const owners = new Set<string>();
let core: BridgeCore | null = null;
let initPromise: Promise<H5BridgeState> | null = null;
let lifecycleTransfers: TransferManager | null = null;
let lifecycleEpoch = 0;

function token(value?: string): string { return value && value.trim() ? value : 'legacy-owner'; }
function browserState(): H5BridgeState { return { ready: false, state: 'browser', env: 'browser', isApp: false, source: 'browser-timeout', owners: owners.size }; }

export function getH5Bridge(): BridgeCore | null { return core; }
export function getH5TransferManager(): TransferManager | null { return lifecycleTransfers; }
export async function ensureH5Bridge(options: H5BridgeInitOptions = {}): Promise<BridgeCore | null> {
  await initH5Bridge(options);
  return core;
}

export function initH5Bridge(options: H5BridgeInitOptions = {}): Promise<H5BridgeState> {
  const owner = token(options.ownerToken);
  owners.add(owner);
  diagnostic('Lifecycle', 'init.start', { ownerId: owner, owners: owners.size });
  if (core?.isReady()) return Promise.resolve({ ready: true, state: 'ready', env: 'app', isApp: true, source: 'app-handshake', owners: owners.size });
  if (initPromise) return initPromise.then((state) => ({ ...state, owners: owners.size }));
  const epoch = lifecycleEpoch;
  initPromise = (async () => {
    let candidate: BridgeCore | null = null;
    let transfers: TransferManager | null = null;
    try {
      await loadUniWebViewSdk(options.sdkTimeoutMs ?? 5000, options.sdkUrl);
      if (epoch !== lifecycleEpoch) return browserState();
      candidate = new BridgeCore({ role: 'h5', transport: new H5PostMessageTransport(), connectTimeoutMs: options.connectTimeoutMs, defaultTimeoutMs: options.callTimeoutMs });
      transfers = new TransferManager(candidate);
      core = candidate;
      lifecycleTransfers = transfers;
      await candidate.start();
      await candidate.waitUntilReady({ timeoutMs: options.connectTimeoutMs ?? 15000 });
      if (epoch !== lifecycleEpoch) throw new Error('Initialization superseded');
      diagnostic('Lifecycle', 'init.success', { owners: owners.size });
      return { ready: true, state: 'ready', env: 'app', isApp: true, source: 'app-handshake', owners: owners.size };
    } catch (error) {
      diagnostic('Lifecycle', candidate ? 'init.timeout' : 'init.failure', { code: (error as any)?.code || 'INITIALIZATION_FAILED' }, candidate ? 'warn' : 'error');
      transfers?.destroy();
      if (lifecycleTransfers === transfers) lifecycleTransfers = null;
      if (core === candidate) core = null;
      if (candidate) await candidate.destroy('Browser or App bridge unavailable').catch(() => undefined);
      disposeUniWebViewSdk();
      return browserState();
    } finally {
      if (epoch === lifecycleEpoch) initPromise = null;
    }
  })();
  return initPromise;
}

export async function destroyH5Bridge(ownerToken?: string): Promise<{ destroyed: boolean; remainingOwners: number }> {
  const owner = token(ownerToken);
  owners.delete(owner);
  diagnostic('Lifecycle', 'destroy.start', { ownerId: owner, owners: owners.size });
  if (owners.size) return { destroyed: false, remainingOwners: owners.size };
  const active = core;
  lifecycleEpoch += 1;
  core = null; initPromise = null;
  if (active) await Promise.race([
    active.disconnect('Last owner released'),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]).catch(() => undefined);
  lifecycleTransfers?.destroy(); lifecycleTransfers = null;
  if (active) await active.destroy('Last owner released');
  disposeUniWebViewSdk();
  diagnostic('Lifecycle', 'destroy.success', { destroyed: !!active, owners: 0 });
  return { destroyed: !!active, remainingOwners: 0 };
}

export function getOwnersCount(): number { return owners.size; }