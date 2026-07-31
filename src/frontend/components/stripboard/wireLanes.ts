import { Wire } from "@/types";

// Overlapping straight wires on one column (or row) get perpendicular lane
// offsets so parallel runs stay individually visible. Wires that only touch
// at a shared endpoint keep the same lane. `gap` is the per-lane shift in
// the caller's SVG units. Every wire that is part of a multi-wire line gets
// an entry (lane 0 with a zero shift), so callers can also tell laned wires
// apart from solitary ones.
export function computeWireLaneOffsets(wires: Wire[], gap: number): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>();
  const laneShift = (lane: number) => (lane === 0 ? 0 : Math.ceil(lane / 2) * gap * (lane % 2 === 1 ? 1 : -1));
  const assign = (group: Wire[], vertical: boolean) => {
    const byLine = new Map<number, { id: string; lo: number; hi: number }[]>();
    for (const w of group) {
      const line = vertical ? w.from.col : w.from.row;
      const a = vertical ? w.from.row : w.from.col;
      const b = vertical ? w.to.row : w.to.col;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push({ id: w.id, lo: Math.min(a, b), hi: Math.max(a, b) });
    }
    for (const lineGroup of byLine.values()) {
      if (lineGroup.length < 2) continue;
      lineGroup.sort((x, y) => x.lo - y.lo || x.hi - y.hi);
      const laneEnds: number[] = [];
      for (const seg of lineGroup) {
        let lane = laneEnds.findIndex((end) => end <= seg.lo);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(seg.hi);
        } else {
          laneEnds[lane] = seg.hi;
        }
        const shift = laneShift(lane);
        offsets.set(seg.id, vertical ? { dx: shift, dy: 0 } : { dx: 0, dy: shift });
      }
    }
  };
  assign(wires.filter((w) => w.from.col === w.to.col && w.from.row !== w.to.row), true);
  assign(wires.filter((w) => w.from.row === w.to.row && w.from.col !== w.to.col), false);
  return offsets;
}
