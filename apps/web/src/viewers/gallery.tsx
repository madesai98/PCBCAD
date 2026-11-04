import { useMemo, useState } from 'react';
import { PcbView } from './pcb/PcbView';
import { demoBoards } from './demo/project';

export function Gallery() {
  const demo = useMemo(() => demoBoards(), []);
  const [sel, setSel] = useState<string[]>([]);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="h-[560px] overflow-hidden rounded-xl border border-(--border)">
        <PcbView board={demo.main} parts={demo.parts} selectedIds={sel} onSelectComponent={(id) => setSel(id ? [id] : [])} />
      </div>
      <div className="h-[560px] overflow-hidden rounded-xl border border-(--border)">
        <PcbView board={demo.main} parts={demo.parts} mode="layers" />
      </div>
    </div>
  );
}
