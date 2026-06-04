import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

export default function SiteHeader({
  breadcrumb,
  actions,
}: {
  breadcrumb?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="h-12 flex items-center px-4 sm:px-6 justify-between border-b-2 border-[var(--copper)]">
      <div className="flex items-center font-mono text-sm">
        <Link
          href="/"
          className="font-semibold tracking-wide text-[#113768] dark:text-[#5b9bd5] hover:text-[var(--copper)] dark:hover:text-[var(--copper)] transition-colors"
        >
          stripboard_editor
        </Link>
        {breadcrumb && (
          <>
            <span className="mx-2 text-[var(--copper)]">/</span>
            <span className="text-neutral-500 dark:text-neutral-400">{breadcrumb}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 sm:gap-3 text-sm">
        {actions}
        <ThemeToggle className="px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors" />
      </div>
    </header>
  );
}
