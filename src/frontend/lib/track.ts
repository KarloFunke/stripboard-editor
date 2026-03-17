/** Safe wrapper for Umami event tracking */
export function track(event: string, data?: Record<string, string | number>) {
  try {
    const umami = (window as unknown as { umami?: { track: (event: string, data?: Record<string, string | number>) => void } }).umami;
    umami?.track(event, data);
  } catch {
    // Tracking should never break the app
  }
}
