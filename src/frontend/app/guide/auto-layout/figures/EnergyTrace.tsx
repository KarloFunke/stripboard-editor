// ── A real run, traced ──
// One anneal of a 27-part corpus board (project 61), one sample per 1% of the
// run: progress %, temperature, price of a slanted or crossing wire, current
// score, best score so far, worse moves kept and worse moves offered in that
// window. Captured through the engine's trace hook.
const TRACE: [number, number, number, number, number, number, number][] = [[0,149.99,25,6171,11046,0,0],[1,139.98,26,1267,853,84,560],[2,130.63,26,1434,841,141,542],[3,121.91,27,810,810,90,576],[4,113.78,28,1158,676,110,553],[5,106.18,29,904,676,113,515],[6,99.1,30,1081,676,119,535],[7,92.48,30,1110,676,75,541],[8,86.31,31,833,676,98,559],[9,80.55,32,914,634,105,561],[10,75.17,33,792,558,91,564],[11,70.15,34,954,558,103,544],[12,65.47,35,853,558,77,566],[13,61.1,36,960,558,95,589],[14,57.02,37,1001,558,87,608],[15,53.22,38,845,558,82,540],[16,49.67,39,686,558,100,545],[17,46.35,40,752,541,77,576],[18,43.26,41,841,541,67,586],[19,40.37,42,785,541,77,589],[20,37.68,44,645,468,66,578],[21,35.16,45,855,468,55,594],[22,32.81,46,694,468,65,565],[23,30.62,47,677,468,60,601],[24,28.58,49,716,468,55,587],[25,26.67,50,634,468,42,621],[26,24.89,51,675,468,49,601],[27,23.23,53,579,468,67,581],[28,21.68,54,591,468,42,583],[29,20.23,56,631,468,43,618],[30,18.88,57,525,458,53,588],[31,17.62,59,408,407,14,634],[32,16.45,61,413,345,17,610],[33,15.35,62,454,345,35,624],[34,14.32,64,340,334,20,616],[35,13.37,66,345,334,9,628],[36,12.48,68,442,317,21,592],[37,11.64,70,313,296,15,642],[38,10.87,72,334,292,14,632],[39,10.14,74,433,292,15,651],[40,9.46,76,493,292,21,640],[41,8.83,78,476,292,18,627],[42,8.24,80,393,292,18,609],[43,7.69,82,384,292,19,617],[44,7.18,85,372,292,14,662],[45,6.7,87,377,292,10,636],[46,6.25,90,403,292,16,621],[47,5.84,92,392,292,9,627],[48,5.45,95,375,292,13,609],[49,5.08,97,327,292,11,618],[50,4.74,100,343,292,11,620],[51,4.43,103,316,292,9,612],[52,4.13,106,307,292,8,621],[53,3.86,109,289,289,1,617],[54,3.6,112,296,289,4,633],[55,3.36,115,293,289,2,632],[56,3.13,118,283,283,2,622],[57,2.92,121,283,283,0,626],[58,2.73,125,292,281,4,617],[59,2.55,128,284,281,4,662],[60,2.38,132,284,281,1,622],[61,2.22,136,284,281,1,609],[62,2.07,139,268,268,0,657],[63,1.93,143,270,268,1,668],[64,1.8,147,268,268,0,623],[65,1.68,152,266,265,1,643],[66,1.57,156,256,256,2,658],[67,1.47,160,242,242,2,634],[68,1.37,165,242,242,0,644],[69,1.28,169,242,242,0,659],[70,1.19,174,242,242,0,613],[71,1.11,179,237,237,0,646],[72,1.04,184,237,237,0,645],[73,0.97,189,237,237,0,644],[74,0.9,195,237,237,0,633],[75,0.84,200,237,237,1,640],[76,0.79,206,237,237,0,608],[77,0.73,211,237,237,0,630],[78,0.69,217,237,237,0,658],[79,0.64,223,237,237,0,628],[80,0.6,230,237,237,0,670],[81,0.56,236,237,237,3,634],[82,0.52,243,237,237,2,653],[83,0.49,250,237,237,0,639],[84,0.45,257,237,237,0,644],[85,0.42,264,235,235,0,642],[86,0.39,271,235,235,0,667],[87,0.37,279,233,233,0,644],[88,0.34,287,233,233,0,658],[89,0.32,295,233,233,0,636],[90,0.3,303,233,233,0,673],[91,0.28,312,233,233,0,665],[92,0.26,320,233,233,0,680],[93,0.24,329,233,233,0,652],[94,0.23,339,233,233,0,647],[95,0.21,348,233,233,0,640],[96,0.2,358,233,233,0,610],[97,0.18,368,228,228,0,654],[98,0.17,378,228,228,0,627],[99,0.16,389,228,228,0,638]];

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
  const eTicks = [500, 1000, 2000, 5000, 10000].filter((v) => v >= eMin && v <= eMax);
  const tTicks = [0.15, 1, 10, 100];
  const AH = 40;
  return (
    <figure className="my-6">
      <svg viewBox={`0 0 ${W} ${H + AH + 8}`} className="w-full h-auto text-neutral-600 dark:text-neutral-300">
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
        <text x={L + 4} y={T + 10} fontSize={9} fill="#113768" className="dark:[fill:#5b9bd5]">score of the current board</text>
        <text x={L + 4} y={T + 22} fontSize={9} fill="#16a34a">best score so far</text>
        <text x={L + 4} y={T + 34} fontSize={9} fill="#f59e0b">temperature (right axis)</text>
        <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={9} fill="currentColor">progress through the run</text>
        {TRACE.map((r, i) => {
          if (r[6] === 0) return null;
          const frac = r[5] / r[6];
          return <rect key={i} x={x(i) - (W - L - R) / (2 * n)} y={H + 8 + (1 - frac) * AH} width={(W - L - R) / n} height={frac * AH} fill="#f59e0b" fillOpacity={0.6} />;
        })}
        <line x1={L} y1={H + 8 + AH} x2={W - R} y2={H + 8 + AH} stroke="currentColor" strokeOpacity={0.5} />
        <text x={L - 6} y={H + 8 + AH} textAnchor="end" fontSize={9} fill="currentColor">0</text>
        <text x={L - 6} y={H + 8 + 8} textAnchor="end" fontSize={9} fill="currentColor">all</text>
        <text x={L + 4} y={H + 8 + 10} fontSize={9} fill="currentColor">share of worse moves that were kept</text>
      </svg>
      <figcaption className="text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        A real run on a 27-part board, sampled once per percent. Scores are on a logarithmic axis. In the first few percent
        the board is still a random heap scored in the thousands; the structure forms while the temperature falls from 150
        to about 10, and by the halfway mark almost no worse move is kept any more. The last half is patient polishing:
        moves that cost nothing shuffle the board across plateaus until a rare improvement appears.
      </figcaption>
    </figure>
  );
}
