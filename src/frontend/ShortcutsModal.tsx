import { X } from "lucide-react";

interface ShortcutsModalProps {
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Focus next clip"],
  ["Space", "Pick up / drop clip while focused on drag handle"],
  ["Arrow keys", "Move a picked-up clip"],
  ["Escape", "Cancel drag / close dialog"],
  ["Enter", "Open the focused clip's editor"],
  ["? ", "Toggle this shortcuts cheat sheet"],
  ["Space (in preview)", "Play / pause"],
  ["Left / Right (in preview)", "Seek 5s back / forward"]
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <div className="preview-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="preview-modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <button type="button" className="preview-modal-close icon-button" onClick={onClose} aria-label="Close shortcuts">
          <X aria-hidden="true" size={18} />
        </button>
        <h2 id="shortcuts-title" className="preview-modal-title">
          Keyboard shortcuts
        </h2>
        <ul className="shortcuts-list">
          {SHORTCUTS.map(([key, description]) => (
            <li key={key}>
              <kbd>{key}</kbd>
              <span>{description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
