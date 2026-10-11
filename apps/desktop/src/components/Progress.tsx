export function Progress({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <span className={`bar ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <b style={{ width: `${v * 100}%` }} />
    </span>
  );
}
