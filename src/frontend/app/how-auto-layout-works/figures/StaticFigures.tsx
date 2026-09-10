// Static SVG figures for the auto-layout explainer (server components).

const AXIS = "currentColor";

// P(keep) = exp(-dE / T) against how much worse a move is, at three temperatures
export function AcceptanceChart() {
  const W = 360, H = 170, L = 36, B = 28, R = 10, Tp = 10;
  const temps = [{ T: 10, color: "#dc2626", label: "T = 10 (hot)" }, { T: 3, color: "#f59e0b", label: "T = 3" }, { T: 0.5, color: "#1d4ed8", label: "T = 0.5 (cold)" }];
  const x = (d: number) => L + (d / 20) * (W - L - R);
  const y = (p: number) => Tp + (1 - p) * (H - Tp - B);
  return (
    <figure className="my-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md h-auto text-neutral-600 dark:text-neutral-300">
        <line x1={L} y1={y(0)} x2={W - R} y2={y(0)} stroke={AXIS} strokeOpacity={0.5} />
        <line x1={L} y1={y(0)} x2={L} y2={y(1)} stroke={AXIS} strokeOpacity={0.5} />
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line x1={L - 3} y1={y(p)} x2={L} y2={y(p)} stroke={AXIS} strokeOpacity={0.5} />
            <text x={L - 6} y={y(p) + 3} textAnchor="end" fontSize={9} fill="currentColor">{p}</text>
          </g>
        ))}
        {[0, 5, 10, 15, 20].map((d) => (
          <g key={d}>
            <line x1={x(d)} y1={y(0)} x2={x(d)} y2={y(0) + 3} stroke={AXIS} strokeOpacity={0.5} />
            <text x={x(d)} y={y(0) + 13} textAnchor="middle" fontSize={9} fill="currentColor">{d}</text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize={9} fill="currentColor">how much worse the move makes the score</text>
        <text x={8} y={Tp + 4} fontSize={9} fill="currentColor" transform={`rotate(-90 8 ${Tp + 4})`} textAnchor="end">chance of keeping it</text>
        {temps.map(({ T, color, label }, k) => {
          const pts = Array.from({ length: 81 }, (_, i) => {
            const d = (i / 80) * 20;
            return `${i === 0 ? "M" : "L"}${x(d).toFixed(1)},${y(Math.exp(-d / T)).toFixed(1)}`;
          }).join(" ");
          return (
            <g key={T}>
              <path d={pts} fill="none" stroke={color} strokeWidth={1.8} />
              <text x={W - R - 2} y={Tp + 12 + k * 12} textAnchor="end" fontSize={9} fill={color}>{label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        The acceptance rule. A move that improves the score is always kept. A move that makes it worse by some amount is kept
        with probability e<sup>-worse/T</sup>: at a high temperature almost anything passes, at a low one only the smallest
        setbacks do, and at T near zero the rule becomes "improvements only".
      </figcaption>
    </figure>
  );
}

// Two landscapes over a row of neighbouring states, one bar per state.
// Left: a broad valley with one side dip. Right: neighbours with unrelated
// scores, every dip a trap.
export function LandscapeSketch() {
  const W = 360, H = 130, N = 32, B = 18;
  const bw = W / N;
  const good = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const main = 1 - Math.exp(-((t - 0.68) ** 2) / 0.05);
    const dip = -0.28 * Math.exp(-((t - 0.22) ** 2) / 0.006);
    return 0.22 + 0.7 * main + dip;
  });
  // fixed pseudo-random heights, so the figure is the same for everyone;
  // as jagged as before but sitting higher, with one state (bar 20) as
  // good as the smooth valley's floor and nothing around it hinting at it
  const bad = [0.75, 0.96, 0.58, 0.9, 0.7, 0.98, 0.5, 0.86, 0.62, 0.94, 0.78, 0.46, 0.88, 0.66, 0.97, 0.6, 0.84, 0.52, 0.92, 0.72, 0.22, 0.87, 0.64, 0.99, 0.55, 0.82, 0.6, 0.9, 0.48, 0.85, 0.68, 0.95];
  const ballGood = 7; // the side dip
  const ballBad = 11;
  const Bars = ({ v, ball, label }: { v: number[]; ball: number; label: string }) => (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-neutral-600 dark:text-neutral-300">
      {v.map((h, i) => (
        <rect key={i} x={i * bw + 1} y={(H - B) * (1 - h) + 6} width={bw - 2} height={(H - B) * h - 6 + 2} fill={i === ball ? "#f59e0b" : "#113768"} fillOpacity={i === ball ? 0.9 : 0.75} className={i === ball ? "" : "dark:[fill:#5b9bd5]"} />
      ))}
      <circle cx={ball * bw + bw / 2} cy={(H - B) * (1 - v[ball]) + 1} r={5} fill="#f59e0b" stroke="#fff" strokeWidth={1.5} />
      <text x={W / 2} y={H - 5} textAnchor="middle" fontSize={10} fill="currentColor">{label}</text>
    </svg>
  );
  return (
    <figure className="my-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Bars v={good} ball={ballGood} label="neighbours score alike: a walk finds the valley" />
      <Bars v={bad} ball={ballBad} label="neighbours score at random: every dip is a trap" />
      <figcaption className="sm:col-span-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        Two landscapes over a row of neighbouring states, one bar per state, lower is better. Left, a small change mostly
        changes the score a little, so the walk can feel its way downhill; the dip the ball sits in is a local minimum,
        and a warm run steps out of it because the climb is short. Right, the state next door is as likely to be terrible
        as excellent, no step carries information about where to go, and every dip holds the ball equally well. One state
        on the right is as good as the valley floor on the left, but nothing around it gives it away. How the problem is
        encoded decides which landscape the annealer sees.
      </figcaption>
    </figure>
  );
}
