import { ComponentDef } from "@/types";
import { getSymbolBounds } from "./SymbolRenderer";

/** Get the visual size of a component on the schematic canvas */
export function getBlockSize(def: ComponentDef, rotation: 0 | 90 | 180 | 270 = 0) {
  const bounds = getSymbolBounds(def.symbol, rotation);
  return { blockWidth: bounds.width, blockHeight: bounds.height, bounds };
}
