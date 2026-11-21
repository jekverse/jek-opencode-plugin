// Workspace tree rows for the editor's file rail. Pure: the window bundle cannot
// call Node, so the host's file model supplies entries and this file only shapes
// them for rendering.

export type TreeEntry = {
  name: string;
  path: string;
  dir: boolean;
  ignored?: boolean;
};

export type TreeRow = {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  ignored: boolean;
  expanded: boolean;
  loading: boolean;
};

/** Rows kept at once, so a workspace with tens of thousands of files cannot freeze the rail. */
export const MAX_TREE_ROWS = 3000;

/** Workspace-relative with forward slashes and no leading or trailing slash. */
export function normalizeTreePath(value: string) {
  return value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * One directory entry with its path composed from the folder it was listed in.
 * The name is authoritative: a host entry that reports a bare or stale path
 * cannot collide with a same-named file elsewhere in the tree.
 */
export function childEntry(
  folder: string,
  entry: { name: string; dir: boolean; ignored?: boolean },
): TreeEntry {
  const parent = normalizeTreePath(folder);
  return {
    name: entry.name,
    path: parent ? `${parent}/${entry.name}` : entry.name,
    dir: entry.dir,
    ignored: entry.ignored === true,
  };
}

/** Folders first, then files, both in human order (2 before 10). */
export function sortTreeEntries<T extends { name: string; dir: boolean }>(
  entries: readonly T[],
) {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * Flattens the directories the host says are expanded. `children` and `expanded`
 * are read reactively by the caller, so a folder toggle re-renders the rows.
 */
export function flattenTree(
  children: (path: string) => readonly TreeEntry[],
  expanded: (path: string) => boolean,
  state: (path: string) => { loading?: boolean } | undefined,
  max = MAX_TREE_ROWS,
) {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const walk = (dir: string, depth: number) => {
    for (const entry of sortTreeEntries(children(dir))) {
      if (rows.length >= max) {
        truncated = true;
        return;
      }

      const path = normalizeTreePath(entry.path || entry.name);
      // A symlinked directory can report its own path as a child.
      if (!path || path === dir || seen.has(path)) continue;
      seen.add(path);

      const open = entry.dir && expanded(path);
      rows.push({
        path,
        name: entry.name,
        dir: entry.dir,
        depth,
        ignored: entry.ignored === true,
        expanded: open,
        loading: open && state(path)?.loading === true,
      });

      if (open) walk(path, depth + 1);
    }
  };

  walk("", 0);
  return { rows, truncated };
}

/** The directories above a file, outermost first: "a/b/c.ts" has "a" then "a/b". */
export function ancestorsOf(path: string) {
  const parts = normalizeTreePath(path).split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1)
    ancestors.push(parts.slice(0, index).join("/"));
  return ancestors;
}

/** The folder part of a workspace-relative path, or "" at the root. */
export function folderOfTreePath(path: string) {
  const normalized = normalizeTreePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

/**
 * The item a keyboard pick moves to. It clamps like the app's own file list:
 * ArrowDown on the last result stays there instead of wrapping.
 */
export function nextItem(
  items: readonly string[],
  current: string | undefined,
  delta: number,
) {
  if (items.length === 0) return undefined;
  const at = current ? items.indexOf(current) : -1;
  const start =
    at === -1 ? (delta > 0 ? 0 : items.length - 1) : at + delta;
  return items[Math.max(0, Math.min(items.length - 1, start))]!;
}

/** The action a key asks for in the file tree: F2 renames, Delete deletes, Shift+Alt+C copies the path. */
export function treeShortcut(
  key: string,
  modifiers: { shift?: boolean; alt?: boolean } = {},
): "rename" | "delete" | "copy-path" | undefined {
  if (key === "F2") return "rename";
  if (key === "Delete") return "delete";
  if (
    (key === "c" || key === "C") &&
    modifiers.shift === true &&
    modifiers.alt === true
  ) {
    return "copy-path";
  }
  return undefined;
}

/** True when `path` sits inside `folder`, not on the folder itself. */
export function isInsideTreePath(path: string, folder: string) {
  const parent = normalizeTreePath(folder);
  return !!parent && normalizeTreePath(path).startsWith(`${parent}/`);
}

/** Same workspace path, ignoring separator and trailing-slash differences. */
export function sameTreePath(a: string, b: string) {
  return (
    !!a &&
    !!b &&
    normalizeTreePath(a) === normalizeTreePath(b)
  );
}
