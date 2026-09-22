/** Safe wrapper for Umami event tracking */

// Logged-in state, sent as a dimension on every event. Set from the auth
// chokepoints in lib/api.ts; null until the first of them resolves.
let signedIn: boolean | null = null;

export function setSignedIn(value: boolean) {
  signedIn = value;
}

export function track(event: string, data?: Record<string, string | number>) {
  try {
    const umami = (window as unknown as { umami?: { track: (event: string, data?: Record<string, string | number>) => void } }).umami;
    umami?.track(event, signedIn === null ? data : { ...data, signedIn: signedIn ? "yes" : "no" });
  } catch {
    // Tracking should never break the app
  }
}
