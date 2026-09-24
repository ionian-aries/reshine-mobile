import SDK_SOURCE from '../static/uni.webview.1.5.8.js?raw';
import { BridgeError } from './contract';

type Loader = { promise: Promise<void> | null; node: HTMLScriptElement | null; created: boolean };
const loader: Loader = { promise: null, node: null, created: false };

function available(): boolean { return typeof window !== 'undefined' && typeof (window as any).uni?.webView?.postMessage === 'function'; }

export function loadUniWebViewSdk(timeoutMs = 5000, sdkUrl?: string): Promise<void> {
  if (available()) return Promise.resolve();
  if (loader.promise) return loader.promise;
  loader.promise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new BridgeError('SDK_UNAVAILABLE', 'Document is unavailable'));
    const script = document.createElement('script');
    loader.node = script; loader.created = true; script.async = true;
    let settled = false; let url = ''; let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: BridgeError) => {
      if (settled) return; settled = true; clearTimeout(timer);
      script.removeEventListener('load', onLoad); script.removeEventListener('error', onError);
      if (url) URL.revokeObjectURL(url);
      if (error || !available()) {
        script.remove(); loader.node = null; loader.promise = null; loader.created = false;
        reject(error || new BridgeError('SDK_UNAVAILABLE', 'uni.webView SDK did not initialize'));
      } else resolve();
    };
    const onLoad = () => finish();
    const onError = () => finish(new BridgeError('SDK_UNAVAILABLE', 'uni.webView SDK failed to load'));
    script.addEventListener('load', onLoad, { once: true }); script.addEventListener('error', onError, { once: true });
    try {
      if (sdkUrl) script.src = sdkUrl;
      else { url = URL.createObjectURL(new Blob([SDK_SOURCE], { type: 'application/javascript' })); script.src = url; }
      (document.head || document.body).appendChild(script);
    }
    catch { finish(new BridgeError('SDK_UNAVAILABLE', 'uni.webView SDK could not be created')); }
    timer = setTimeout(() => finish(new BridgeError('SDK_UNAVAILABLE', 'uni.webView SDK load timed out')), timeoutMs);
  });
  return loader.promise;
}

export function disposeUniWebViewSdk(): void {
  if (loader.created) loader.node?.remove();
  loader.node = null; loader.promise = null; loader.created = false;
}