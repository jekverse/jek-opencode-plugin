// Directory browsing helpers: pure sorting and parent math, no app APIs.

export type Entry = { name: string; dir: boolean };

/** A folder with more entries than this is truncated before it reaches the UI. */
export const MAX_ENTRIES = 2000;

/** Folders first, then files, both in human order (2 before 10). */
export function sortEntries(entries: readonly Entry[]) {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/** Caps a listing so a directory with 50k entries cannot freeze the panel. */
export function limitEntries(
  entries: readonly Entry[],
  max = MAX_ENTRIES,
): { entries: Entry[]; total: number } {
  return { entries: entries.slice(0, max), total: entries.length };
}

/**
 * A name that is unused among `names`, so a move or copy never overwrites an
 * existing entry: "app.py" becomes "app (2).py", then "app (3).py", and so on.
 */
export function freeEntryName(names: readonly string[], name: string) {
  const taken = new Set(names.map((value) => value.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** The directory above `path`, or "" at a drive or filesystem root. */
export function parentOf(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index === -1) return "";
  if (index === 0) return "/";
  const parent = normalized.slice(0, index);
  // "C:" alone is a drive, not a folder: keep the slash so it resolves.
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
}
