// QR scanning for the Send screen (native shells only). The plugin is loaded on demand so the web and
// extension bundles never carry the camera code. A scan yields a `koinos:<address>` URI or a bare
// address; anything that is not a checksum-valid Koinos address is refused, never pasted into the form.
import { isValidAddress } from "../core/addressbook";

/** "koinos:1ABC…", "koinos://1ABC…", "1ABC…" (with surrounding whitespace) -> the address, or null. */
export function parseScannedAddress(text: string): string | null {
  const t = text.trim();
  const m = /^(?:koinos:(?:\/\/)?)?([1-9A-HJ-NP-Za-km-z]{25,36})(?:[?#].*)?$/.exec(t);
  if (!m) return null;
  const a = m[1]!;
  return isValidAddress(a) ? a : null;
}

export type Scanner = () => Promise<string | null>;

/** Opens the device camera and returns the scanned text, or null if the user cancelled. */
export const nativeScanner: Scanner = async () => {
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import("@capacitor/barcode-scanner");
  try {
    const r = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: "Point the camera at the recipient's QR code",
      cancelButtonAccessibilityLabel: "Cancel scanning",
    });
    return r?.ScanResult ?? null;
  } catch (e) {
    // the plugin rejects on cancel as well as on a missing camera permission; cancel is not an error
    if (/cancel/i.test((e as Error).message ?? "")) return null;
    throw e;
  }
};

/** Scans and validates. Returns the address, null when cancelled; throws with a readable message otherwise. */
export async function scanAddress(scanner: Scanner = nativeScanner): Promise<string | null> {
  const text = await scanner();
  if (text === null) return null;
  const address = parseScannedAddress(text);
  if (!address) throw new Error("The code scanned is not a Koinos address.");
  return address;
}
