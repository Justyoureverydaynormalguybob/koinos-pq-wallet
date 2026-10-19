// Where the wallet is running: a native shell (Capacitor on Android/iOS), the browser extension, or a plain web page.
import { Capacitor } from "@capacitor/core";

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function isExtension(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}
