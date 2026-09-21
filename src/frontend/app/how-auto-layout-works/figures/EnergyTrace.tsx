// ── A real run, traced ──
// One anneal of a 27-component corpus board (project 61), one sample per 1% of the
// run: progress %, temperature, price of a slanted or crossing wire, current
// score, best score so far, worse moves kept and worse moves offered in that
// window. Captured through the engine's trace hook.
const TRACE: [number, number, number, number, number, number, number][] = [[0,150,25,5270,10145,0,0],[1,139.99,26,1728,787,1022,4629],[2,130.64,26,1199,764,1048,4591],[3,121.92,27,972,673,956,4690],[4,113.79,28,1104,673,1052,4677],[5,106.19,29,940,593,1115,4511],[6,99.1,30,828,593,985,4488],[7,92.49,30,1187,593,944,4704],[8,86.32,31,1042,593,1084,4553],[9,80.55,32,834,583,832,4845],[10,75.18,33,750,583,883,4868],[11,70.16,34,888,583,780,4898],[12,65.48,35,933,583,889,4736],[13,61.11,36,947,583,811,4920],[14,57.03,37,761,578,677,5005],[15,53.22,38,846,578,726,4845],[16,49.67,39,678,542,717,4888],[17,46.35,40,807,542,769,4845],[18,43.26,41,503,503,646,4911],[19,40.37,42,697,495,582,5134],[20,37.68,44,550,446,494,5079],[21,35.16,45,631,443,637,5084],[22,32.82,46,653,443,510,5164],[23,30.63,47,658,443,562,5090],[24,28.58,49,664,443,483,5201],[25,26.67,50,627,397,483,5173],[26,24.89,51,387,387,435,5172],[27,23.23,53,613,387,434,5167],[28,21.68,54,647,387,371,5155],[29,20.23,56,574,387,366,5338],[30,18.88,57,605,387,311,5301],[31,17.62,59,421,362,319,5273],[32,16.45,61,464,335,314,5272],[33,15.35,62,468,335,260,5480],[34,14.32,64,481,335,224,5345],[35,13.37,66,526,303,234,5345],[36,12.48,68,543,303,292,5326],[37,11.64,70,453,303,207,5355],[38,10.87,72,436,303,127,5399],[39,10.14,74,327,303,158,5310],[40,9.46,76,480,303,172,5556],[41,8.83,78,362,303,147,5435],[42,8.24,80,448,285,112,5608],[43,7.69,82,311,285,164,5443],[44,7.18,85,304,247,137,5368],[45,6.7,87,291,247,93,5350],[46,6.25,90,349,247,89,5398],[47,5.84,92,328,247,85,5354],[48,5.45,95,260,247,86,5337],[49,5.08,97,270,244,58,5415],[50,4.74,100,251,238,67,5473],[51,4.43,103,224,224,72,5306],[52,4.13,106,254,223,80,5411],[53,3.86,109,260,223,43,5457],[54,3.6,112,223,221,30,5432],[55,3.36,115,218,206,40,5465],[56,3.13,118,248,206,58,5335],[57,2.92,121,222,206,27,5338],[58,2.73,125,222,206,11,5395],[59,2.55,128,236,206,20,5571],[60,2.38,132,232,206,37,5502],[61,2.22,136,209,206,12,5526],[62,2.07,139,210,206,6,5601],[63,1.93,143,206,206,5,5544],[64,1.8,147,201,201,12,5439],[65,1.68,152,184,180,3,5547],[66,1.57,156,180,179,4,5603],[67,1.47,160,175,175,0,5549],[68,1.37,165,181,175,2,5514],[69,1.28,169,175,175,1,5482],[70,1.19,174,175,175,1,5606],[71,1.11,179,175,175,2,5687],[72,1.04,184,175,173,2,5679],[73,0.97,189,162,162,4,5608],[74,0.9,195,160,160,2,5510],[75,0.84,200,160,160,0,5436],[76,0.79,206,162,160,1,5413],[77,0.73,211,160,159,2,5642],[78,0.69,217,160,159,1,5601],[79,0.64,223,159,159,3,5542],[80,0.6,230,160,159,2,5570],[81,0.56,236,160,159,0,5510],[82,0.52,243,159,159,2,5390],[83,0.49,250,155,155,5,5547],[84,0.45,257,149,149,7,5504],[85,0.42,264,149,149,1,5572],[86,0.39,271,149,149,1,5498],[87,0.37,279,150,149,6,5602],[88,0.34,287,150,149,2,5532],[89,0.32,295,150,149,4,5471],[90,0.3,303,150,149,1,5597],[91,0.28,312,149,149,1,5529],[92,0.26,320,150,149,2,5595],[93,0.24,329,149,149,2,5490],[94,0.23,339,149,149,2,5470],[95,0.21,348,149,149,0,5575],[96,0.2,358,149,149,1,5392],[97,0.18,368,149,149,1,5519],[98,0.17,378,149,149,1,5462],[99,0.16,389,150,149,2,5502]];

// halo stroke in the article card's background colour, so the legend stays
// readable where a line runs behind it
const HALO = "dark:[stroke:#171717]";
const halo = { stroke: "#fff", strokeWidth: 3, paintOrder: "stroke" as const, strokeLinejoin: "round" as const };

export default function EnergyTrace() {
  const W = 560, H = 230, L = 44, R = 44, T = 12, B = 30;
  const n = TRACE.length;
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const eMin = Math.min(...TRACE.map((r) => r[4])) * 0.8;
  const eMax = Math.max(...TRACE.map((r) => r[3]));
  const yE = (e: number) => T + (1 - Math.log(e / eMin) / Math.log(eMax / eMin)) * (H - T - B);
  const tMin = 0.15, tMax = 150;
  const yT = (t: number) => T + (1 - Math.log(Math.max(t, tMin) / tMin) / Math.log(tMax / tMin)) * (H - T - B);
  const path = (f: (r: (typeof TRACE)[number]) => number) => TRACE.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${f(r).toFixed(1)}`).join(" ");
  const eTicks = [200, 500, 1000, 2000, 5000, 10000].filter((v) => v >= eMin && v <= eMax);
  const tTicks = [0.15, 1, 10, 100];
  const AH = 40;
  return (
    <figure className="my-6">
      <svg viewBox={`0 0 ${W} ${H + AH + 20}`} className="w-full h-auto text-neutral-600 dark:text-neutral-300">
        {[0, 25, 50, 75, 100].map((p) => (
          <g key={p}>
            <line x1={x(p)} y1={T} x2={x(p)} y2={H - B} stroke="currentColor" strokeOpacity={0.08} />
            <text x={x(p)} y={H - B + 12} textAnchor="middle" fontSize={9} fill="currentColor">{p}%</text>
          </g>
        ))}
        {eTicks.map((v) => (
          <g key={v}>
            <line x1={L - 3} y1={yE(v)} x2={L} y2={yE(v)} stroke="currentColor" strokeOpacity={0.5} />
            <text x={L - 6} y={yE(v) + 3} textAnchor="end" fontSize={9} fill="currentColor">{v}</text>
          </g>
        ))}
        {tTicks.map((v) => (
          <g key={v}>
            <line x1={W - R} y1={yT(v)} x2={W - R + 3} y2={yT(v)} stroke="#f59e0b" strokeOpacity={0.7} />
            <text x={W - R + 6} y={yT(v) + 3} fontSize={9} fill="#f59e0b">{v}</text>
          </g>
        ))}
        <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="currentColor" strokeOpacity={0.5} />
        <path d={path((r) => yT(r[1]))} fill="none" stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="4 3" />
        <path d={path((r) => yE(r[3]))} fill="none" stroke="#113768" strokeWidth={1.2} className="dark:[stroke:#5b9bd5]" />
        <path d={path((r) => yE(r[4]))} fill="none" stroke="#16a34a" strokeWidth={1.8} />
        <text x={L + 4} y={T + 10} fontSize={9} fill="#113768" className={`dark:[fill:#5b9bd5] ${HALO}`} {...halo}>score of the current board</text>
        <text x={L + 4} y={T + 22} fontSize={9} fill="#16a34a" className={HALO} {...halo}>best score so far</text>
        <text x={L + 4} y={T + 34} fontSize={9} fill="#f59e0b" className={HALO} {...halo}>temperature (right axis)</text>
        <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={9} fill="currentColor">progress through the run</text>
        {TRACE.map((r, i) => {
          if (r[6] === 0) return null;
          const frac = r[5] / r[6];
          return <rect key={i} x={x(i) - (W - L - R) / (2 * n)} y={H + 8 + (1 - frac) * AH} width={(W - L - R) / n} height={frac * AH} fill="#f59e0b" fillOpacity={0.6} />;
        })}
        <line x1={L} y1={H + 8 + AH} x2={W - R} y2={H + 8 + AH} stroke="currentColor" strokeOpacity={0.5} />
        <text x={L - 6} y={H + 8 + AH} textAnchor="end" fontSize={9} fill="currentColor">0</text>
        <text x={L - 6} y={H + 8 + 8} textAnchor="end" fontSize={9} fill="currentColor">all</text>
        <text x={L + 4} y={H + 8 + 10} fontSize={9} fill="currentColor" className={HALO} {...halo}>share of worse moves that were kept</text>
      </svg>
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        A real run on a 27-component board, sampled once per percent. Scores are on a logarithmic axis. In the first few percent
        the board is still a random heap scored in the thousands; the structure forms while the temperature falls from 150
        to about 10, and by the halfway mark almost no worse move is kept any more. The last half is patient polishing:
        moves that only try to find the rare moves that still improve the board.
      </figcaption>
    </figure>
  );
}
