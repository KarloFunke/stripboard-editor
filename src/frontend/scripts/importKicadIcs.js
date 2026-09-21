// Builds data/icLibrary.ts, the built-in IC list, from the KiCad symbol
// library (CC-BY-SA 4.0, https://gitlab.com/kicad/libraries/kicad-symbols).
// KiCad supplies pin numbers, pin names and descriptions; this script picks
// the parts, names the pins KiCad leaves unnamed (gates, op amp halves) and
// shortens the long ones so they fit a generic IC body.
//
//   node scripts/importKicadIcs.js [path/to/kicad/symbols]
//   node scripts/importKicadIcs.js --show Amplifier_Operational:TL072
//
// Parts are added or changed in PARTS below, never in the generated file. A
// part's id is derived from its name and is stored in projects, so a name
// must not change once published.
const fs = require("fs");
const path = require("path");

const OPAMPS = "Op amps & comparators";
const TIMERS = "Timers";
const AUDIO = "Audio";
const LOGIC = "Logic";
const REGULATORS = "Regulators & references";
const OPTO = "Optocouplers";
const DRIVERS = "Drivers & sensors";
const MCU = "Microcontrollers & modules";

// Single op amps with the 741 pinout (2 −, 3 +, 4 V−, 6 out, 7 V+) are drawn
// as the op amp triangle; importing checks the pinout really is that.
const TRIANGLE = { symbol: "opamp" };

// [kicad "Library:Symbol", group, options]
// options: name (shown name, default the KiCad symbol), aliases (extra search
// words), description (replaces KiCad's), symbol (a drawn symbol instead of
// the generic body; its pin ids must match), pins (names replacing KiCad's,
// by pin number, where KiCad leaves them unnamed; each list gives the
// datasheet it was checked against), footprint (where KiCad names none).
const PARTS = [
  ["Amplifier_Operational:TL071", OPAMPS, TRIANGLE],
  ["Amplifier_Operational:TL072", OPAMPS],
  ["Amplifier_Operational:TL074", OPAMPS],
  ["Amplifier_Operational:TL081", OPAMPS, TRIANGLE],
  ["Amplifier_Operational:TL082", OPAMPS],
  ["Amplifier_Operational:TL062", OPAMPS],
  ["Amplifier_Operational:TL064", OPAMPS],
  ["Amplifier_Operational:NE5532", OPAMPS],
  ["Amplifier_Operational:NE5534", OPAMPS],
  ["Amplifier_Operational:LM358", OPAMPS],
  ["Amplifier_Operational:LM324", OPAMPS],
  ["Amplifier_Operational:LM741", OPAMPS, TRIANGLE],
  ["Amplifier_Operational:CA3140", OPAMPS, { ...TRIANGLE, description: "BiMOS op amp with MOSFET input" }],
  ["Amplifier_Operational:OPA2134", OPAMPS],
  ["Amplifier_Operational:RC4558", OPAMPS],
  ["Amplifier_Operational:NJM4558", OPAMPS, { aliases: ["jrc4558"] }],
  ["Comparator:LM393", OPAMPS],
  ["Comparator:LM311", OPAMPS],

  ["Timer:NE556", TIMERS],

  ["Amplifier_Audio:LM386", AUDIO],
  ["Amplifier_Operational:LM13700", AUDIO, {
    // https://www.ti.com/lit/ds/symlink/lm13700.pdf
    pins: ["1IABC", "1DIODE", "1IN+", "1IN−", "1OUT", "V−", "1BUFIN", "1BUFOUT", "2BUFOUT", "2BUFIN", "V+", "2OUT", "2IN−", "2IN+", "2DIODE", "2IABC"],
  }],
  ["Audio:PT2399", AUDIO],
  ["Audio:MN3007", AUDIO, { description: "1024-stage low noise bucket brigade delay" }],
  ["Audio:MN3207", AUDIO, { description: "1024-stage low voltage bucket brigade delay" }],

  ["4xxx:4001", LOGIC, { name: "CD4001" }],
  ["4xxx:4011", LOGIC, { name: "CD4011" }],
  ["4xxx:4013", LOGIC, { name: "CD4013" }],
  ["4xxx:4016", LOGIC, { name: "CD4016" }],
  ["4xxx:4017", LOGIC, { name: "CD4017" }],
  ["4xxx:4021", LOGIC, { name: "CD4021" }],
  ["4xxx:4027", LOGIC, { name: "CD4027" }],
  ["4xxx:4029", LOGIC, { name: "CD4029" }],
  ["4xxx:4040", LOGIC, { name: "CD4040" }],
  ["4xxx:4046", LOGIC, { name: "CD4046" }],
  ["4xxx:4049", LOGIC, { name: "CD4049" }],
  ["4xxx:4050", LOGIC, { name: "CD4050" }],
  ["4xxx:4051", LOGIC, { name: "CD4051" }],
  ["4xxx:4052", LOGIC, { name: "CD4052" }],
  ["4xxx:4053", LOGIC, { name: "CD4053" }],
  ["4xxx:4060", LOGIC, { name: "CD4060" }],
  ["4xxx:4066", LOGIC, { name: "CD4066" }],
  ["4xxx:4069", LOGIC, { name: "CD4069" }],
  ["4xxx:4070", LOGIC, { name: "CD4070" }],
  ["4xxx:4071", LOGIC, { name: "CD4071" }],
  ["4xxx:4081", LOGIC, { name: "CD4081" }],
  ["4xxx_IEEE:4093", LOGIC, { name: "CD4093", description: "Quad 2-input NAND Schmitt trigger", footprint: { kind: "dip", pins: 14 } }],
  ["4xxx:40106", LOGIC, { name: "CD40106" }],
  ["4xxx:4510", LOGIC, { name: "CD4510" }],
  ["4xxx:4518", LOGIC, { name: "CD4518" }],
  ["4xxx:4538", LOGIC, { name: "CD4538" }],
  ["74xx:74HC00", LOGIC],
  ["74xx:74HC02", LOGIC],
  ["74xx:74HC04", LOGIC],
  ["74xx:74LS08", LOGIC, { aliases: ["74hc08"] }],
  ["74xx:74HC14", LOGIC],
  ["74xx:74LS32", LOGIC, { aliases: ["74hc32"] }],
  ["74xx:74HC74", LOGIC],
  ["74xx:74HC86", LOGIC],
  ["74xx:74HC123", LOGIC],
  ["74xx:74HC138", LOGIC],
  ["74xx:74HC165", LOGIC],
  ["74xx:74HC245", LOGIC],
  ["74xx:74HC595", LOGIC],
  ["74xx:74HC4051", LOGIC],
  ["74xx:74HC4060", LOGIC],

  ["Regulator_Linear:L7805", REGULATORS, { name: "7805", aliases: ["l7805", "lm7805"] }],
  ["Regulator_Linear:L7812", REGULATORS, { name: "7812", aliases: ["l7812", "lm7812"] }],
  ["Regulator_Linear:L7905", REGULATORS, { name: "7905", aliases: ["l7905", "lm7905"] }],
  ["Regulator_Linear:L78L05_TO92", REGULATORS, { name: "78L05" }],
  ["Regulator_Linear:LM317_TO-220", REGULATORS, { name: "LM317" }],
  ["Regulator_Linear:LM317L_TO92", REGULATORS, { name: "LM317L" }],
  ["Regulator_Linear:LM337_TO220", REGULATORS, { name: "LM337" }],
  ["Reference_Voltage:TL431LP", REGULATORS, { name: "TL431" }],
  ["Reference_Voltage:LM385Z-1.2", REGULATORS, { name: "LM385-1.2" }],
  ["Regulator_SwitchedCapacitor:ICL7660", REGULATORS, { aliases: ["charge pump", "voltage inverter", "voltage doubler"] }],

  // https://www.soselectronic.com/cz-cz/a_info/resource/d/pc817.pdf (Sharp)
  ["Isolator:PC817", OPTO, { pins: ["A", "K", "E", "C"] }],
  // https://www.vishay.com/docs/81181/4n35.pdf, https://www.vishay.com/docs/83725/4n25.pdf
  ["Isolator:4N35", OPTO, { pins: ["A", "K", "NC", "E", "C", "B"] }],
  ["Isolator:4N25", OPTO, { pins: ["A", "K", "NC", "E", "C", "B"] }],
  // https://www.onsemi.com/pub/Collateral/H11L3M-D.PDF
  ["Isolator:H11L1", OPTO, { pins: ["A", "K", "NC", "VO", "GND", "VCC"] }],
  ["Isolator:6N137", OPTO],
  ["Isolator:6N138", OPTO],

  ["Transistor_Array:ULN2003A", DRIVERS],
  ["Transistor_Array:ULN2803A", DRIVERS],
  ["Driver_Motor:L293D", DRIVERS],
  ["Interface_UART:MAX232", DRIVERS],
  ["Memory_EEPROM:24LC256", DRIVERS],
  ["Sensor_Temperature:LM35-LP", DRIVERS, { name: "LM35" }],
  ["Sensor_Temperature:DS18B20", DRIVERS, { description: "1-Wire digital thermometer" }],

  ["MCU_Microchip_ATtiny:ATtiny85-20P", MCU, { name: "ATtiny85" }],
  ["MCU_Microchip_ATtiny:ATtiny84A-P", MCU, { name: "ATtiny84A" }],
  ["MCU_Microchip_ATtiny:ATtiny2313-20P", MCU, { name: "ATtiny2313" }],
  ["MCU_Microchip_ATmega:ATmega328P-P", MCU, { name: "ATmega328P" }],
  ["MCU_Microchip_ATmega:ATmega8A-P", MCU, { name: "ATmega8A" }],
  ["MCU_Microchip_PIC16:PIC16F628A-IP", MCU, { name: "PIC16F628A" }],
];

// ── KiCad file reading ──────────────────────────────────

function parseSexpr(text) {
  let i = 0;
  const n = text.length;
  function skip() {
    while (i < n && /\s/.test(text[i])) i++;
  }
  function node() {
    skip();
    if (text[i] === "(") {
      i++;
      const out = [];
      for (;;) {
        skip();
        if (text[i] === ")") { i++; return out; }
        out.push(node());
      }
    }
    if (text[i] === '"') {
      i++;
      let s = "";
      while (text[i] !== '"') {
        if (text[i] === "\\") i++;
        s += text[i++];
      }
      i++;
      return { str: s };
    }
    const start = i;
    while (i < n && !/[\s()]/.test(text[i])) i++;
    return text.slice(start, i);
  }
  return node();
}

const str = (v) => (v && typeof v === "object" && "str" in v ? v.str : v);
const children = (node, head) => node.filter((c) => Array.isArray(c) && c[0] === head);
const child = (node, head) => children(node, head)[0];

const libs = new Map();
function library(dir, lib) {
  if (!libs.has(lib)) {
    const root = parseSexpr(fs.readFileSync(path.join(dir, `${lib}.kicad_sym`), "utf8"));
    libs.set(lib, new Map(children(root, "symbol").map((s) => [str(s[1]), s])));
  }
  return libs.get(lib);
}

function property(sym, key) {
  const p = children(sym, "property").find((q) => str(q[1]) === key);
  return p ? str(p[2]) : "";
}

/** Pins of every unit, from the symbol or the one it extends. */
function kicadPart(dir, ref) {
  const [lib, name] = ref.split(":");
  const symbols = library(dir, lib);
  const sym = symbols.get(name);
  if (!sym) throw new Error(`${ref}: not in the KiCad library`);
  const baseName = child(sym, "extends") ? str(child(sym, "extends")[1]) : name;
  const base = symbols.get(baseName);
  const pins = new Map();
  let units = 0;
  for (const unit of children(base, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(unit[1]));
    // style 2 is the De Morgan drawing of the same pins
    if (!m || m[2] === "2") continue;
    const u = Number(m[1]);
    units = Math.max(units, u);
    for (const pin of children(unit, "pin")) {
      const num = str(child(pin, "number")[1]);
      if (pins.has(num)) continue;
      pins.set(num, { num, name: str(child(pin, "name")[1]), type: pin[1], unit: u });
    }
  }
  return {
    description: property(sym, "Description") || property(base, "Description"),
    keywords: property(sym, "ki_keywords") || property(base, "ki_keywords"),
    footprint: property(sym, "Footprint") || property(base, "Footprint"),
    filters: property(sym, "ki_fp_filters") || property(base, "ki_fp_filters"),
    units,
    pins: [...pins.values()],
  };
}

// ── Into our format ─────────────────────────────────────

// "~{RESET}" is KiCad's overbar.
function cleanName(name) {
  let s = name.replace(/~\{([^}]*)\}/g, "/$1").replace(/[_^]\{([^}]*)\}/g, "$1");
  if (s === "~") return "";
  // "PB5/~{RESET}/ADC0/dW" is too long to read beside a pin: keep the first
  // function. Short pairs such as "I/O" stay.
  if (s.length > 9 && s.slice(1).includes("/")) s = s.startsWith("/") ? "/" + s.slice(1).split("/")[0] : s.split("/")[0];
  return s.replace(/-$/, "−").replace(/^-$/, "−");
}

/**
 * Pin names by pin number. Gates and op amp halves are unnamed in KiCad and
 * get datasheet names: 1A 1B 1Y, 1IN+ 1IN− 1OUT. A name that repeats in more
 * than one unit gets its unit number in front.
 */
function pinNames(part) {
  const count = Math.max(...part.pins.map((p) => Number(p.num)));
  const byUnit = new Map();
  for (const p of part.pins) {
    if (!byUnit.has(p.unit)) byUnit.set(p.unit, []);
    byUnit.get(p.unit).push(p);
  }
  const seen = new Map();
  for (const p of part.pins) {
    const n = cleanName(p.name);
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const names = Array.from({ length: count }, () => "NC");
  for (const [unit, pins] of byUnit) {
    const multi = part.units > 1 && !pins.every((p) => p.type === "power_in");
    const pre = multi ? String(unit) : "";
    // An analog switch: two unnamed terminals and the input that closes them
    const terminals = pins.filter((p) => p.type === "passive" && !cleanName(p.name)).length;
    let input = 0;
    let output = 0;
    for (const p of [...pins].sort((a, b) => Number(a.num) - Number(b.num))) {
      let n = cleanName(p.name);
      const drives = /output|open_|tri_state/.test(p.type);
      if (n === "+" || n === "−") n = `${pre}IN${n}`;
      else if (!n && drives && pins.some((q) => ["+", "-"].includes(q.name))) n = `${pre}OUT`;
      else if (!n && terminals && p.type === "passive") n = `${pre}IO`;
      else if (!n && terminals && p.type.startsWith("input")) n = `${pre}CTL`;
      else if (!n && drives) n = `${pre}Y${output++ ? output : ""}`;
      else if (!n && p.type.startsWith("input")) n = `${pre}${"ABCDEFGH"[input++]}`;
      else if (!n) n = p.num;
      else if (multi && seen.get(n) > 1) n = `${pre}${n}`;
      names[Number(p.num) - 1] = n;
    }
  }
  return names;
}

/** "Dual Operational Amplifiers, DIP-8/SOIC-8" → "Dual operational amplifiers" */
function cleanDescription(text) {
  const parts = text.split(/,\s*/).filter((s) => !/\b(P?DIP|SOIC|SO|TSSOP|MSOP|VSSOP|SSOP|TO|SOT|QFN|DFN|SOP)[-\d]/.test(s));
  // Keep the gist: electrical fine print past the first few words is for the
  // datasheet
  let s = "";
  for (const p of parts.length ? parts : [text]) {
    if (s.length >= 24 && s.length + p.length > 48) break;
    s = s ? `${s}, ${p}` : p;
  }
  s = s.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function footprintOf(ref, part, count) {
  const text = `${part.footprint} ${part.filters}`;
  if (/DIP/.test(text)) return { kind: "dip", pins: count + (count % 2) };
  if (/TO.?(92|220)/.test(text) && count === 3) return { kind: "to" };
  throw new Error(`${ref}: no DIP, TO-92 or TO-220 package (${text.trim()})`);
}

// Three-leg parts number their legs in no common order (a 7805 is IN GND
// OUT, a 78L05 OUT GND IN), so their pin box puts each pin on the side its
// role belongs: supply in on the left, out on the right, ground or adjust
// below, a sensor's supply on top. A reference is drawn like the diode it
// acts as, cathode up, anode down.
const SIDES = {
  l: ["IN", "VI", "VIN", "REF"],
  r: ["OUT", "VO", "VOUT", "DQ"],
  t: ["+VS", "VS", "VDD", "VCC", "K"],
  b: ["GND", "ADJ", "A"],
};

function pinBoxSymbol(ref, names) {
  const used = new Set();
  const tokens = [];
  names.forEach((n, i) => {
    if (n === "NC") return;
    const side = Object.keys(SIDES).find((k) => SIDES[k].includes(n));
    if (!side || used.has(side)) throw new Error(`${ref}: no free side for pin ${i + 1} (${n})`);
    used.add(side);
    tokens.push(`${side}${i + 1}`);
  });
  return `box-${tokens.join("-")}`;
}

function spec(dir, [ref, group, opts = {}]) {
  const part = kicadPart(dir, ref);
  const names = [...(opts.pins ?? pinNames(part))];
  const name = opts.name ?? ref.split(":")[1];
  const words = [...(opts.aliases ?? []), ...part.keywords.split(/\s+/).filter(Boolean)];
  const footprint = opts.footprint ?? footprintOf(ref, part, names.length);
  const symbol = opts.symbol ?? (footprint.kind === "to" ? pinBoxSymbol(ref, names) : undefined);
  // A package pin KiCad leaves out, such as pin 16 of a 4049, is unconnected
  while (footprint.pins && names.length < footprint.pins) names.push("NC");
  if (symbol === "opamp") {
    const want = { 2: "IN−", 3: "IN+", 4: "V−", 6: "OUT", 7: "V+" };
    for (const [num, n] of Object.entries(want)) {
      if (names[num - 1] !== n) throw new Error(`${ref}: pin ${num} is ${names[num - 1]}, the op amp triangle needs ${n}`);
    }
  }
  return {
    id: `def-ic-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    group,
    description: opts.description ?? cleanDescription(part.description),
    aliases: [...new Set(words.map((w) => w.toLowerCase()))],
    footprint,
    ...(symbol ? { symbol } : {}),
    pins: names,
    kicad: ref,
  };
}

function main() {
  const args = process.argv.slice(2);
  const show = args.indexOf("--show");
  const dir = args.find((a, i) => !a.startsWith("--") && i !== show + 1) ?? "/usr/share/kicad/symbols";
  if (show >= 0) {
    const refs = args[show + 1] === "all" ? PARTS.map((p) => p[0]) : args[show + 1].split(",");
    for (const ref of refs) {
      try {
        const part = kicadPart(dir, ref);
        const s = spec(dir, PARTS.find((p) => p[0] === ref) ?? [ref, "?"]);
        console.log(`${ref}  ${s.footprint.kind}${s.footprint.pins ?? ""}  "${s.description}"  [${s.aliases.join(" ")}]`);
        console.log("   ", s.pins.map((n, i) => `${i + 1}:${n}`).join(" "), `  (kicad: ${part.pins.map((p) => `${p.num}=${p.name}`).join(" ")})`);
      } catch (e) {
        console.log(`${ref}  ERROR ${e.message}`);
      }
    }
    return;
  }
  const specs = PARTS.map((p) => spec(dir, p));
  const ids = new Set();
  for (const s of specs) {
    if (ids.has(s.id)) throw new Error(`duplicate id ${s.id}`);
    ids.add(s.id);
  }
  const out = path.resolve(__dirname, "../data/icLibrary.ts");
  const body = specs.map((s) => `  ${JSON.stringify(s)},`).join("\n");
  fs.writeFileSync(out, `// Generated by scripts/importKicadIcs.js from the KiCad symbol library. Do
// not edit: change PARTS in the script and run it again.
//
// Pin numbers, pin names and descriptions come from the KiCad symbol library
// by the KiCad Library Team, https://gitlab.com/kicad/libraries/kicad-symbols,
// licensed under CC-BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
// They were selected, renamed and shortened for this editor. This file is
// licensed under CC-BY-SA 4.0 as well.
import type { PartSpec } from "@/types";

export const IC_LIBRARY: PartSpec[] = [
${body}
];
`);
  console.log(`wrote ${specs.length} parts to ${path.relative(process.cwd(), out)}`);
}

main();
