import { cn } from "../lib/cn.js";

// Loading skeletons built from the .sheen running-strip — so a fetching panel carries the exact same "something is
// working" amber shimmer as a running worker (loading and working speak one motion language). aria-hidden: the panel's
// own live region / surrounding text announces state to SR; these are decorative.
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div className={cn("sheen relative overflow-hidden rounded bg-raised/40", className)} aria-hidden />;
}

const ROW_WIDTHS = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-4/5", "w-1/2", "w-3/5"];

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-2.5 px-3 py-3", className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3.5", ROW_WIDTHS[i % ROW_WIDTHS.length])} />
      ))}
    </div>
  );
}
