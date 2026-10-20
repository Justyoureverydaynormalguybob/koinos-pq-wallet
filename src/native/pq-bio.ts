// The in-house biometric keystore plugin (plugins/pq-bio): a 32-byte key kept behind the platform's
// strong biometric. Android: an RSA-2048 key in the AndroidKeyStore with user authentication required
// (class 3 only) and invalidation on enrolment change; the wrapped bytes are decrypted only inside a
// BiometricPrompt CryptoObject, so the OS, not the app, decides whether a finger passed. iOS: a Keychain
// item under kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly + biometryCurrentSet, read with a Face ID /
// Touch ID prompt. Native shells only; the web app never calls it.
import { registerPlugin } from "@capacitor/core";

export interface PqBioPlugin {
  /** a strong biometric is enrolled and the keystore can bind to it */
  available(): Promise<{ available: boolean }>;
  /** stores the key (hex); no prompt. Replaces whatever was there and re-creates the keystore key. */
  set(o: { hex: string }): Promise<void>;
  /** prompts, then returns the key; `hex` is null when nothing is stored. Rejects "cancelled" / "invalidated" / "failed". */
  get(o: { reason: string; title: string; cancel: string }): Promise<{ hex: string | null }>;
  remove(): Promise<void>;
}

export const PqBio = registerPlugin<PqBioPlugin>("PqBio");
