import { useState } from 'react';
import { Waypoints } from 'lucide-react';
import { SchematicView } from '../../../viewers';
import { useApp } from '../../store';
import { BoardPicker, EmptyState, useBoard } from '../ui';

export default function SchematicTab() {
  const project = useApp((s) => s.project)!;
  const board = useBoard();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const [net, setNet] = useState<string | undefined>();
  if (!board) return <EmptyState icon={Waypoints} title="No boards yet" text="The schematic appears here as soon as the agent creates a board and places components." />;
  const netName = board.nets.find((n) => n.id === net)?.name;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <BoardPicker project={project} />
        <span className="text-[12px] dim">
          {board.components.length} components · {board.nets.length} nets
        </span>
        <span className="flex-1" />
        {netName && <span className="chip chip-accent">net {netName}</span>}
      </div>
      <div className="relative min-h-0 flex-1 bg-[var(--canvas)]">
        <SchematicView
          project={project}
          boardId={board.id}
          selectedIds={selection?.kind === 'component' ? [selection.componentId] : []}
          highlightNetId={net}
          onSelectComponent={(id: string | null) => select(id ? { kind: 'component', boardId: board.id, componentId: id } : null)}
          onHoverNet={(id: string | null) => setNet(id ?? undefined)}
        />
      </div>
    </div>
  );
}
