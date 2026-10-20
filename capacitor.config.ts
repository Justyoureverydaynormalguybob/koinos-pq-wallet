import type { CapacitorConfig } from "@capacitor/cli";

// The web wallet (dist/) packaged as a native app. Same code, same keys-never-leave-the-device rule;
// the WebView's storage holds the encrypted vault exactly as a browser's localStorage would.
const config: CapacitorConfig = {
  appId: "ie.rawbyte.koinospq",
  appName: "Sparán",
  webDir: "dist",
  android: { allowMixedContent: false },
  ios: { contentInset: "automatic" },
  server: { androidScheme: "https" },
};

export default config;
