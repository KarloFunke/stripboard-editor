// Reading the value field of a passive as a physical quantity: how big the
// part actually is, and what its colour bands say. Values are freeform text
// typed by users, so every parser here returns null rather than guessing.

const R_MULT: Record<string, number> = { r: 1, k: 1e3, m: 1e6, g: 1e9 };
const C_MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3 };

/**
 * Resistance in ohms from "10k", "4k7", "4.7 kΩ", "100R", "150", "1Meg".
 * A bare number is ohms. Lowercase m is megohms, not milliohms: nobody
 * writes a milliohm resistor on a stripboard.
 */
export function parseResistance(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/\s+/g, "")
    .replace(/meg/g, "m")
    .replace(/ohms?|[ΩωΩ]/g, "");
  const m = /^(\d*\.?\d+)([rkmg])?(\d*)$/.exec(s);
  if (!m) return null;
  const [, head, unit, tail] = m;
  const value = tail ? parseFloat(`${head}.${tail}`) : parseFloat(head);
  if (!isFinite(value)) return null;
  return value * (unit ? R_MULT[unit] : 1);
}

/**
 * Capacitance in farads from "100n", "10uF", "0.1 uF", "4u7", "100 mü".
 * A bare number is rejected: on a capacitor it could mean pF, nF or µF.
 * Anything after the unit ("47 uF x 16V") is ignored.
 */
export function parseCapacitance(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/,/g, ".").replace(/\s+/g, "");
  const m = /^(\d*\.?\d+)(mü|mu|[µμ]|[unpm])(\d*)/.exec(s);
  if (!m) return null;
  const [, head, rawUnit, tail] = m;
  const unit = rawUnit === "mü" || rawUnit === "mu" || rawUnit === "µ" || rawUnit === "μ" ? "u" : rawUnit;
  const value = tail ? parseFloat(`${head}.${tail}`) : parseFloat(head);
  if (!isFinite(value)) return null;
  return value * C_MULT[unit];
}

const DIGIT_COLOR = ["#1a1a1a", "#6b3f18", "#c62828", "#e2711d", "#e5c100", "#2e7d32", "#1565c0", "#7b2fa0", "#9e9e9e", "#f2f2f2"];
const GOLD = "#c9a227";
const SILVER = "#c0c0c0";

/**
 * The colour bands for a resistance: four bands when two significant digits
 * are enough (gold tolerance), five when three are needed (brown, 1%), as on
 * the E96 parts those values come from. `fiveBand` always gives five, the way
 * 1% metal film parts are marked whatever their value. Null when no standard
 * band set can express the value, e.g. a multiplier outside silver..white.
 */
export function resistorBands(ohms: number, fiveBand = false): string[] | null {
  if (!(ohms > 0) || !isFinite(ohms)) return null;
  for (const sig of fiveBand ? [3] : [2, 3]) {
    const exp = Math.floor(Math.log10(ohms)) - (sig - 1);
    const digits = Math.round(ohms / Math.pow(10, exp));
    if (digits < Math.pow(10, sig - 1) || digits >= Math.pow(10, sig)) continue;
    if (Math.abs(digits * Math.pow(10, exp) - ohms) > ohms * 1e-6) continue;
    if (exp < -2 || exp > 9) return null;
    const multiplier = exp === -2 ? SILVER : exp === -1 ? GOLD : DIGIT_COLOR[exp];
    return [
      ...String(digits).split("").map((d) => DIGIT_COLOR[Number(d)]),
      multiplier,
      sig === 2 ? GOLD : DIGIT_COLOR[1],
    ];
  }
  return null;
}

// LEDs are told apart by colour, not by a quantity, so their value field
// carries one: a name or a hex code.
const LED_COLORS: Record<string, string> = {
  red: "#d93025", rot: "#d93025",
  green: "#1e8e3e", grün: "#1e8e3e", gruen: "#1e8e3e",
  blue: "#1a73e8", blau: "#1a73e8",
  yellow: "#f2c200", gelb: "#f2c200",
  orange: "#f57c00",
  amber: "#ffb300",
  white: "#f1f3f4", weiss: "#f1f3f4", weiß: "#f1f3f4",
  pink: "#e91e8c",
  purple: "#8e24aa", violet: "#8e24aa", lila: "#8e24aa",
  uv: "#7c4dff",
  ir: "#5b2c6f", infrared: "#5b2c6f",
};

/** The colour an LED is drawn in, from "red", "grün" or "#ff8800". Null keeps it clear. */
export function parseLedColor(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s);
  if (hex) {
    const h = hex[1];
    return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h);
  }
  return LED_COLORS[s] ?? null;
}

/** Mix a colour toward black, for the shaded parts of a body. */
export function darken(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const channels = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - amount)));
  return "#" + channels.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
}
