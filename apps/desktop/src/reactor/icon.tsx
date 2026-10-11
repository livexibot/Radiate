/** A face in a box on the left of the frame: the reactor overlay. */
export function ReactorIcon({ size }: { size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <circle cx="8" cy="10.5" r="2" />
      <path d="M4.5 16.5a3.5 3.5 0 0 1 7 0" />
    </svg>
  );
}
