export type PaneBox = { id: string; left: number; top: number; width: number; height: number };

/** Moves `sourceId` into `targetId`'s slot, shifting the panes in between by one. */
export function moveToSlotOf(ids: string[], sourceId: string, targetId: string): string[] {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, sourceId);
  return next;
}

/** The pane (other than the dragged one) whose box contains the point, if any. */
export function paneAtPoint(boxes: PaneBox[], x: number, y: number, sourceId: string) {
  return (
    boxes.find(
      (box) =>
        box.id !== sourceId &&
        x >= box.left &&
        x < box.left + box.width &&
        y >= box.top &&
        y < box.top + box.height,
    )?.id ?? null
  );
}
