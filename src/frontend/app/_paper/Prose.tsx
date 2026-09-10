import katex from "katex";

/**
 * Paper furniture: numbered sections, display and inline formulas, figure
 * and table frames. KaTeX runs here on the server, so the browser receives
 * finished markup and no maths JavaScript.
 */

export function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section id={`s${n}`} className="mb-11 scroll-mt-16">
      <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-4">
        {n}. {title}
      </h2>
      {children}
    </section>
  );
}

export function Sub({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div id={`s${n}`} className="mb-7 scroll-mt-16">
      <h3 className="font-serif text-[15px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
        {n} {title}
      </h3>
      {children}
    </div>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="font-serif text-[15px] leading-[1.75] text-neutral-700 dark:text-neutral-300 mb-3">{children}</p>;
}

export function Eq({ tex, n }: { tex: string; n?: number }) {
  const html = katex.renderToString(tex, { displayMode: true, throwOnError: false });
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="flex-1 overflow-x-auto py-1" dangerouslySetInnerHTML={{ __html: html }} />
      {n !== undefined && <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500 shrink-0">({n})</span>}
    </div>
  );
}

export function M({ tex }: { tex: string }) {
  const html = katex.renderToString(tex, { throwOnError: false });
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Figure({ n, caption, children }: { n: number; caption: string; children?: React.ReactNode }) {
  return (
    <figure className="my-6">
      {children ?? (
        <div className="rounded border border-dashed border-neutral-300 dark:border-neutral-700 py-10 text-center font-mono text-[11px] text-neutral-400 dark:text-neutral-600">
          figure {n}
        </div>
      )}
      <figcaption className="font-serif text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400 mt-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--copper)] mr-2">Fig. {n}</span>
        {caption}
      </figcaption>
    </figure>
  );
}

export function Table({ n, caption, children }: { n: number; caption: string; children: React.ReactNode }) {
  return (
    <figure className="my-6">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] font-mono border-collapse">{children}</table>
      </div>
      <figcaption className="font-serif text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400 mt-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--copper)] mr-2">Table {n}</span>
        {caption}
      </figcaption>
    </figure>
  );
}

export function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`border-b border-neutral-300 dark:border-neutral-600 pb-1.5 px-2 font-normal text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400 ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, right, strong }: { children?: React.ReactNode; right?: boolean; strong?: boolean }) {
  return (
    <td
      className={`border-b border-neutral-100 dark:border-neutral-800 py-1.5 px-2 ${right ? "text-right tabular-nums" : ""} ${
        strong ? "text-neutral-900 dark:text-neutral-100" : "text-neutral-600 dark:text-neutral-400"
      }`}
    >
      {children}
    </td>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-5 border-l-2 border-[var(--copper)] pl-4 font-serif text-[14px] leading-relaxed text-neutral-600 dark:text-neutral-400">
      {children}
    </div>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12.5px] text-neutral-800 dark:text-neutral-200">{children}</code>;
}
