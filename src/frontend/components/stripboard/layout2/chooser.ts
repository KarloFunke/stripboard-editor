import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { CompletionPlan, deriveCompletion } from "../autoFinish";
import { DimLimits } from "./tileModel";

// A routed board candidate: virtual component set, board size, and the
// completion plan (cuts + wires) the router derived for it.
export interface Candidate {
  virtual: Component[];
  rows: number;
  cols: number;
  movedIds: Set<string>;
  plan: CompletionPlan;
  bad: number;
}

/**
 * Routes candidates and keeps the best one seen so far. Every phase of the
 * stage-2 search (ladder, polish, channel insertions, slant repairs) offers
 * its layouts through route(); a candidate is adopted only when it beats the
 * current holder on (bad, cost), so no phase can make the result worse.
 *
 * Among clean candidates, a cell of board, a hole of wire, and a hole of
 * wire mess (length over parts / off axis) weigh the same — density must
 * not buy ugly OR long wires. Humans spend board area freely to keep link
 * wires short; without the length term the densest candidate always won
 * and tidier floorplans were discarded.
 * Locked dimensions are paid in full either way.
 */
export class Chooser {
  chosen: Candidate | null = null;

  constructor(
    private board: Board,
    private componentDefs: ComponentDef[],
    private nets: Net[],
    private netAssignments: NetAssignment[],
    // Pin-joint sharing is a locked-layout rescue; see deriveCompletion
    private allowSharedJoints: boolean,
    private limits: DimLimits
  ) {}

  // Ribbon boards read badly even at equal area: beyond maxDim = 2·minDim,
  // each extra length unit is priced like a row of cells. A user-locked
  // dimension is the user's own shape choice and exempts the board.
  private aspectOver(rows: number, cols: number): number {
    if (this.limits.maxRows !== undefined || this.limits.maxCols !== undefined) return 0;
    const mx = Math.max(rows, cols);
    const mn = Math.min(rows, cols);
    return Math.max(0, mx - 2 * mn) * mn;
  }

  private wireLenOf(p: CompletionPlan): number {
    return p.wires.reduce((s, w) => s + Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col), 0);
  }

  // A non-vertical wire is worth a whole board line: that is the exchange
  // rate users reveal when they hand-fix layouts (one inserted blank column
  // to straighten a single wire), and it is what lets a channel insertion
  // or repair move pay for itself in this cost.
  private slantsOf(p: CompletionPlan): number {
    return p.wires.reduce((n, w) => n + (w.from.col !== w.to.col ? 1 : 0), 0);
  }

  private cost(c: Candidate): number {
    return (
      (this.limits.maxRows ? Math.max(this.limits.maxRows, c.rows) : c.rows) *
        (this.limits.maxCols ? Math.max(this.limits.maxCols, c.cols) : c.cols) +
      c.plan.wireMess + this.wireLenOf(c.plan) + this.aspectOver(c.rows, c.cols) +
      Math.max(c.rows, c.cols) * this.slantsOf(c.plan)
    );
  }

  route(virtual: Component[], rows: number, cols: number, movedIds: Set<string>, repair = false): Candidate {
    const tryBoard: Board = { ...this.board, rows, cols, cuts: [], wires: [] };
    const plan = deriveCompletion(tryBoard, virtual, this.componentDefs, this.nets, this.netAssignments, {
      allowSharedJoints: this.allowSharedJoints,
      ...(repair ? { repairSlants: true } : {}),
    });
    const overCap =
      (this.limits.maxRows ? Math.max(0, rows - this.limits.maxRows) : 0) +
      (this.limits.maxCols ? Math.max(0, cols - this.limits.maxCols) : 0);
    const bad = plan.unresolvedConflicts * 100 + 40 * overCap + plan.starvedNetIds.length;
    const cand: Candidate = { virtual, rows, cols, movedIds, plan, bad };
    if (!this.chosen || bad < this.chosen.bad || (bad === this.chosen.bad && this.cost(cand) < this.cost(this.chosen))) {
      this.chosen = cand;
    }
    return cand;
  }
}
