import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileSearch, FileVideo, Folder, GripVertical, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  // Local display/relocate order — drag to prioritize which clips are matched first during bulk relocate.
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    setOrderedIds((current) => {
      const known = current.filter((id) => missingClips.some((clip) => clip.id === id));
      const added = missingClips.filter((clip) => !known.includes(clip.id)).map((clip) => clip.id);
      return [...known, ...added];
    });
  }, [missingClips]);

  const orderedClips = useMemo(() => {
    const byId = new Map(missingClips.map((clip) => [clip.id, clip]));
    return orderedIds.map((id) => byId.get(id)).filter((clip): clip is SessionClip => Boolean(clip));
  }, [missingClips, orderedIds]);

  const handleReorder = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    setOrderedIds((current) => {
      const oldIndex = current.indexOf(String(active.id));
      const newIndex = current.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) {
        return current;
      }
      return arrayMove(current, oldIndex, newIndex);
    });
  };

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
      // Match files against clips in the user's preferred (reordered) sequence.
      const rank = new Map(orderedIds.map((id, index) => [id, index]));
      const nameRank = new Map(orderedClips.map((clip) => [clip.name, rank.get(clip.id) ?? 0]));
      const sorted = [...files].sort((a, b) => (nameRank.get(a.name) ?? 999) - (nameRank.get(b.name) ?? 999));
      onLocateBulk(sorted);
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

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleReorder}>
          <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
            <ul className="missing-list">
              {orderedClips.map((clip) => (
                <SortableMissingRow key={clip.id} clip={clip} onLocate={handleLocate}>
                  <input
                    ref={(node) => {
                      inputRefs.current.set(clip.id, node);
                    }}
                    type="file"
                    accept="video/mp4,.mp4"
                    hidden
                    onChange={(event) => handleFilePicked(clip, event)}
                  />
                </SortableMissingRow>
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        <div className="trim-footer">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

function SortableMissingRow({
  clip,
  onLocate,
  children
}: {
  clip: SessionClip;
  onLocate: (clip: SessionClip) => void;
  children?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.id });

  return (
    <li
      ref={setNodeRef}
      className={`missing-row ${isDragging ? "is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="drag-handle"
        title="Reorder"
        aria-label={`Reorder ${clip.name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" size={16} />
      </button>
      <FileVideo aria-hidden="true" size={18} />
      <div className="missing-row-info">
        <strong>{clip.name}</strong>
        <span className="missing-row-path" title={clip.path}>
          {clip.path}
        </span>
      </div>
      <button type="button" className="secondary-button" onClick={() => onLocate(clip)}>
        Locate…
      </button>
      {children}
    </li>
  );
}
