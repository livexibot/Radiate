export interface ChipItem {
  id: string;
  label: string;
}

export function Chips({ items, value, onChange, label }: { items: ChipItem[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="chips" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={it.id === value}
          className={it.id === value ? "chip on" : "chip"}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
