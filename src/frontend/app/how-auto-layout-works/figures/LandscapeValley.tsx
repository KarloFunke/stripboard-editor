// ── Sections 2 and 10: the landscape most real problems offer at best ──
// Canyon country: branching canyons cut into a plateau, their floors stepping
// down over waterfalls. Built and rendered by hand in Cities: Skylines; the
// runs version draws four walks on top. Transparent, so one picture serves
// both themes.

export default function LandscapeValley({ runs, caption }: { runs?: boolean; caption?: string }) {
  const alt = runs
    ? "The canyon landscape with four runs drawn on it, each from a random start on the plateau down into a canyon; three end in shallow canyons, the red one in the deepest"
    : "Canyon country as a block model, seen from above: branching canyons cut into a plateau, some of them splitting, their floors stepping down over waterfalls";
  return (
    <figure className="my-6">
      <img src={runs ? "/canyon-landscape-runs.webp" : "/canyon-landscape.webp"} alt={alt} width={3000} height={2209} className="w-full h-auto" />
      {caption && <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
