"use client";

import Link from "next/link";
import { track } from "@/lib/track";

/** An internal link that records where the reader was sent from. */
export default function TrackedLink({
  from,
  to,
  href,
  className,
  children,
}: {
  from: string;
  to: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={className} onClick={() => track("content-cta", { from, to })}>
      {children}
    </Link>
  );
}
