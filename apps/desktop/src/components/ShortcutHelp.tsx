// F1 (or ?) shows every keyboard shortcut.
import { useEffect, useState } from "react";
import { Modal } from "./Modal";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      ["H", "Home"],
      ["/", "Search"],
      ["F", "Favorites"],
      ["L", "Live TV"],
      ["G", "Guide"],
      ["B", "Library"],
      ["M", "Movies"],
      ["S", "Series"],
      ["Ctrl + ,", "Settings"],
      ["Esc / Backspace", "Back"],
      ["Arrows, Enter", "Move and pick"],
      ["F1 or ?", "This list"],
    ],
  },
  {
    title: "Watching TV",
    keys: [
      ["Up / Down, Page Up / Down", "Next or previous channel"],
      ["0–9", "Go to a channel number"],
      ["Backspace twice", "Last channel"],
      ["Enter", "Channel list"],
      ["Hold Enter", "Channel menu"],
      ["Left / Right", "Back or forward 10 s"],
      ["Space or K", "Pause"],
      ["Home / End", "Oldest kept / live"],
      ["C", "Record"],
      ["T", "Watch from the start"],
      ["R", "Reactors"],
      ["M", "Mute"],
      ["F", "Full screen"],
      ["I", "Stream stats"],
    ],
  },
];

function isTyping(el: Element | null) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1" || (e.key === "?" && !isTyping(document.activeElement))) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!open) return null;
  return (
    <Modal title="Keyboard" onClose={() => setOpen(false)} wide>
      <div className="keys-help">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, what]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
