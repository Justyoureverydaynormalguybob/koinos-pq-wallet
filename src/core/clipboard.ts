// Copy with a timed wipe: an address or a seed left on the clipboard is read by the next app that
// looks. After `seconds` the clipboard is cleared if it still holds what we put there; where the
// browser will not let us read it back, it is cleared regardless (documented in Settings).
export const CLIPBOARD_WIPE_SECONDS = 60;

let pending: number | undefined;

export async function copyWithWipe(text: string, seconds = CLIPBOARD_WIPE_SECONDS, clip: Clipboard | undefined = globalThis.navigator?.clipboard): Promise<void> {
  if (!clip) throw new Error("clipboard unavailable");
  await clip.writeText(text);
  if (pending !== undefined) globalThis.clearTimeout(pending);
  if (seconds <= 0) return;
  pending = globalThis.setTimeout(() => {
    pending = undefined;
    void wipeIfOurs(text, clip);
  }, seconds * 1000) as unknown as number;
}

export async function wipeIfOurs(text: string, clip: Clipboard | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  if (!clip) return false;
  let stillOurs = true;
  try {
    if (typeof clip.readText === "function") stillOurs = (await clip.readText()) === text;
  } catch {
    stillOurs = true; // cannot read: assume it is still ours and clear
  }
  if (!stillOurs) return false;
  try {
    await clip.writeText("");
    return true;
  } catch {
    return false;
  }
}
