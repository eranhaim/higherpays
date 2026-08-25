/**
 * Which forms currently hold edits nobody has saved.
 *
 * Forms register themselves by key; the app shell reads the registry before
 * it lets a nav link change the page. Module-level rather than context so a
 * deeply nested card can flag itself without threading props through.
 */

const dirtyKeys = new Set<string>();

export function markDirty(key: string, isDirty: boolean): void {
  if (isDirty) dirtyKeys.add(key);
  else dirtyKeys.delete(key);
}

export function hasUnsavedChanges(): boolean {
  return dirtyKeys.size > 0;
}

/** Called once the user has chosen to abandon their edits. */
export function clearUnsavedChanges(): void {
  dirtyKeys.clear();
}
