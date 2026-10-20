// The in-house dapp browser plugin (plugins/pq-browser): a second WebView laid over the app's between
// two insets, a script injected at document start, JSON messages both ways. Native shells only; there
// is no web implementation, and the web app never calls it.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NavigationEvent {
  url: string;
  title: string;
  canGoBack: boolean;
}

export interface PqBrowserPlugin {
  /** Opens `url` between `top` and `bottom` (CSS px from the app viewport's edges), injecting `script` at document start. */
  open(o: { url: string; script: string; top: number; bottom: number }): Promise<void>;
  navigate(o: { url: string }): Promise<void>;
  back(): Promise<{ canGoBack: boolean }>;
  close(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  setFrame(o: { top: number; bottom: number }): Promise<void>;
  /** Desktop layout (a wide viewport, a desktop user agent) and a reload; the way out of a page whose phone layout cannot be used. */
  setDesktop(o: { on: boolean }): Promise<void>;
  /** Android FLAG_SECURE on the whole app window (no screenshots, recording, casting or recents thumbnail). A no-op on iOS, which cannot refuse a screenshot. */
  setSecure(o: { on: boolean }): Promise<void>;
  /** Hands an answer to the page (window.__pqDeliver). */
  reply(o: { json: string }): Promise<void>;
  /** `origin` and `mainFrame` come from the WebView itself (WebMessageListener / WKFrameInfo), never from the page. */
  addListener(event: "message", fn: (e: { json: string; origin: string; mainFrame: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: "navigation", fn: (e: NavigationEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "closed", fn: () => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const PqBrowser = registerPlugin<PqBrowserPlugin>("PqBrowser");
