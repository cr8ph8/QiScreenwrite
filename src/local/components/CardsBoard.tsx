import { useMemo, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { paginate } from "@/lib/fountain/paginate";
import { sceneReport, type SceneRow } from "@/lib/fountain/reports";
import { reorderScenes, setSceneSynopsis } from "@/lib/fountain/serialize";
import { parseScreenplay } from "@/lib/fountain/spec";

interface Props { text: string; onChange: (next: string) => void; onOpenScene: (offset: number) => void }

function Card({ row, start, onOpen, onSynopsis }: { row: SceneRow; start: number; onOpen: () => void; onSynopsis: (value: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.index });
  const [draft, setDraft] = useState<string | null>(null);
  void start;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }} className="lw-card">
      <div className="flex items-start gap-1">
        <button type="button" className="lw-card-grip" aria-label={`Drag scene ${row.index}`} {...attributes} {...listeners}><GripVertical className="h-4 w-4" /></button>
        <button type="button" className="text-left flex-1 min-w-0" onClick={onOpen}>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Scene {row.sceneNumber ?? row.index} · {row.eighths}/8 pg{row.page ? ` · p.${row.page}` : ""}</div>
          <div className="font-semibold text-sm leading-tight truncate">{row.heading}</div>
        </button>
      </div>
      <textarea
        className="lw-card-synopsis"
        placeholder="Synopsis (stored as = line under the heading)"
        value={draft ?? row.synopsis}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { if (draft !== null && draft !== row.synopsis) onSynopsis(draft); setDraft(null); }}
      />
      {row.characters.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{row.characters.map((name) => <span key={name} className="lw-card-chip">{name}</span>)}</div>}
    </div>
  );
}

/** Index cards, one per scene. Drag to reorder the screenplay; edit the synopsis in place. */
export function CardsBoard({ text, onChange, onOpenScene }: Props) {
  const screenplay = useMemo(() => parseScreenplay(text), [text]);
  const rows = useMemo(() => sceneReport(screenplay, paginate(screenplay)), [screenplay]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = rows.findIndex((row) => row.index === active.id), to = rows.findIndex((row) => row.index === over.id);
    if (from < 0 || to < 0) return;
    void arrayMove; // order is derived from the rewritten text, not local state
    onChange(reorderScenes(text, from, to));
  };
  if (!rows.length) return <p className="text-sm text-muted-foreground p-3">Add a scene heading (INT. or EXT.) to see index cards.</p>;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((row) => row.index)} strategy={rectSortingStrategy}>
        <div className="lw-cards">
          {rows.map((row, position) => (
            <Card key={row.index} row={row} start={screenplay.scenes[position]?.start ?? 0} onOpen={() => onOpenScene(screenplay.scenes[position]?.start ?? 0)} onSynopsis={(value) => onChange(setSceneSynopsis(text, position, value))} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
