import type { CSSProperties } from "react";

export function Skeleton({ w, h, r, className = "" }: { w?: number | string; h?: number | string; r?: number; className?: string }) {
  const style: CSSProperties = { width: w, height: h, borderRadius: r };
  return <span className={`skel ${className}`} style={style} aria-hidden="true" />;
}

export function CardRowSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="cards" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="card card-skel" key={i}>
          <Skeleton className="card-thumb" />
          <div className="card-text">
            <Skeleton w="70%" h="0.9rem" />
            <Skeleton w="45%" h="0.75rem" />
          </div>
        </div>
      ))}
    </div>
  );
}
