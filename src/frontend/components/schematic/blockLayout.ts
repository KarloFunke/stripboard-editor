import { ComponentDef } from "@/types";

const PIN_SPACING = 24;
const PIN_LABEL_HEIGHT = 14;
const PADDING_X = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = PADDING_TOP + PIN_LABEL_HEIGHT;

export function getBlockSize(def: ComponentDef) {
  const allRows = def.pins.map((p) => p.offsetRow);
  const allCols = def.pins.map((p) => p.offsetCol);
  if (def.bodyCells) {
    allRows.push(...def.bodyCells.map((c) => c.row));
    allCols.push(...def.bodyCells.map((c) => c.col));
  }

  const maxCol = Math.max(...allCols);
  const maxRow = Math.max(...allRows);

  const blockWidth = maxCol * PIN_SPACING + PADDING_X * 2;
  const blockHeight = maxRow * PIN_SPACING + PADDING_TOP + PADDING_BOTTOM;

  return { blockWidth, blockHeight };
}
