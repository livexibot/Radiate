import { useState } from "react";
import { monogram, tone } from "../lib/monogram";

/** Channel or title tile: provider logo when it loads, otherwise a monogram on a gradient. */
export function Logo({ name, src, className = "" }: { name: string; src?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const showImg = !!src && !broken;
  return (
    <span className={`logo ${tone(name)} ${className}`} aria-hidden="true">
      {showImg ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : monogram(name)}
    </span>
  );
}
