import { FileSearch, FileVideo, Folder, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { getDirectoryFromPath } from "../shared/mediaUtils";
import type { SessionClip } from "../shared/types";

interface MissingClipsDialogProps {
  missingClips: SessionClip[];
  onCancel: () => void;
  onLocate: (clip: SessionClip, file: File) => void;
  onLocateBulk: (files: File[]) => void;
}

export function MissingClipsDialog({ missingClips, onCancel, onLocate, onLocateBulk }: MissingClipsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const bulkInputRef = useRef<HTMLInputElement | null>(null);

  const commonDirectory = useMemo(() => {
    if (missingClips.length === 0) {
      return null;
    }
    const directories = new Set<string>();
    for (const clip of missingClips) {
      const dir = getDirectoryFromPath(clip.path);
      if (dir) {
        directories.add(dir);
      }
    }
    if (directories.size === 1) {
      return Array.from(directories)[0] ?? null;
    }
    return null;
  }, [missingClips]);

  useEffect(() => {
    if (missingClips.length === 0) {
      return;
    }
    dialogRef.current?.focus();
  }, [missingClips]);

  if (missingClips.length === 0) {
    return null;
  }

  const handleLocate = (clip: SessionClip) => {
    inputRefs.current.get(clip.id)?.click();
  };

  const handleBulkLocate = () => {
    bulkInputRef.current?.click();
  };

  const handleFilePicked = (clip: SessionClip, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      onLocate(clip, file);
    }
  };

  const handleBulkPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length > 0) {
      onLocateBulk(files);
    }
  };

  return (
    <div className="preview-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onCancel();
      }
    }}>
      <div
        ref={dialogRef}
        className="preview-modal missing-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-clips-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="preview-modal-close icon-button"
          onClick={onCancel}
          aria-label="Close missing clips dialog"
          title="Close"
        >
          <X aria-hidden="true" size={18} />
        </button>

        <h2 id="missing-clips-title" className="preview-modal-title">
          Locate missing clips
        </h2>
        {commonDirectory ? (
          <p className="missing-dialog-folder">
            <Folder aria-hidden="true" size={14} />
            <span>Look in this folder:</span>
            <code title={commonDirectory}>{commonDirectory}</code>
          </p>
        ) : (
          <p className="missing-dialog-help">
            These clips reference files that the app could not find automatically. Use “Locate all” to pick the whole
            folder in one go (files are matched by name) or pick each one individually.
          </p>
        )}

        <div className="missing-dialog-actions">
          <button type="button" className="secondary-button" onClick={handleBulkLocate}>
            <FileSearch aria-hidden="true" size={16} />
            Locate all…
          </button>
          <input
            ref={bulkInputRef}
            type="file"
            accept="video/mp4,.mp4"
            multiple
            hidden
            onChange={handleBulkPicked}
          />
        </div>

        <ul className="missing-list">
          {missingClips.map((clip) => (
            <li key={clip.id} className="missing-row">
              <FileVideo aria-hidden="true" size={18} />
              <div className="missing-row-info">
                <strong>{clip.name}</strong>
                <span className="missing-row-path" title={clip.path}>
                  {clip.path}
                </span>
              </div>
              <button type="button" className="secondary-button" onClick={() => handleLocate(clip)}>
                Locate…
              </button>
              <input
                ref={(node) => {
                  inputRefs.current.set(clip.id, node);
                }}
                type="file"
                accept="video/mp4,.mp4"
                hidden
                onChange={(event) => handleFilePicked(clip, event)}
              />
            </li>
          ))}
        </ul>

        <div className="trim-footer">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
