import type { Item } from "./api";

// Keep local acquisition edits visible only while their task remains accessible.
// A selection from another login, server or deleted task is never a fallback.
export function workspaceTask(tasks: Item[], selected?: Item): Item | undefined {
  return selected && tasks.some(task => task.id === selected.id) ? selected : tasks[0];
}
