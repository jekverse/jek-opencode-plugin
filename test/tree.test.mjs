import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorsOf,
  childEntry,
  flattenTree,
  folderOfTreePath,
  isInsideTreePath,
  nextItem,
  normalizeTreePath,
  sameTreePath,
  sortTreeEntries,
  treeShortcut,
} from "./.build/tree.mjs";

const entry = (path, dir = false, ignored = false) => ({
  name: path.split("/").at(-1),
  path,
  dir,
  ignored,
});

test("normalizes separators and edge slashes", () => {
  assert.equal(normalizeTreePath("src\\gui.tsx"), "src/gui.tsx");
  assert.equal(normalizeTreePath("/src//gui.tsx/"), "src/gui.tsx");
  assert.equal(normalizeTreePath("src///a/b"), "src/a/b");
  assert.equal(normalizeTreePath(""), "");
});

test("sorts folders first, then names in human order", () => {
  const sorted = sortTreeEntries([
    { name: "file10.ts", dir: false },
    { name: "src", dir: true },
    { name: "file2.ts", dir: false },
    { name: "docs", dir: true },
  ]).map((item) => item.name);

  assert.deepEqual(sorted, ["docs", "src", "file2.ts", "file10.ts"]);
});

test("shows only the expanded branches", () => {
  const children = (path) =>
    ({
      "": [entry("src", true), entry("README.md"), entry(".env", false, true)],
      src: [entry("src/gui.tsx"), entry("src/tree.ts")],
      "src/nested": [],
    })[path] ?? [];

  const collapsed = flattenTree(children, () => false, () => undefined);
  assert.deepEqual(
    collapsed.rows.map((row) => [row.path, row.depth]),
    [
      ["src", 0],
      [".env", 0],
      ["README.md", 0],
    ],
  );
  assert.equal(collapsed.rows[0].expanded, false);

  const opened = flattenTree(
    children,
    (path) => path === "src",
    () => undefined,
  );
  assert.deepEqual(
    opened.rows.map((row) => [row.path, row.depth]),
    [
      ["src", 0],
      ["src/gui.tsx", 1],
      ["src/tree.ts", 1],
      [".env", 0],
      ["README.md", 0],
    ],
  );
  assert.equal(opened.rows[0].expanded, true);
  assert.equal(opened.rows[0].ignored, false);
  assert.equal(
    opened.rows.find((row) => row.path === ".env").ignored,
    true,
  );
});

test("childEntry composes the path from the folder, not a same-named sibling", () => {
  const root = childEntry("", { name: "app.py", dir: false });
  const nested = childEntry("cock", { name: "app.py", dir: false });
  assert.equal(root.path, "app.py");
  assert.equal(nested.path, "cock/app.py");
  assert.notEqual(root.path, nested.path);
  assert.equal(childEntry("a/b\\", { name: "x", dir: true }).path, "a/b/x");
});

test("nested paths normalize to the same child entries regardless of separator", () => {
  const children = (path) => ({ "": [entry("cock", true)], cock: [entry("cock/app.py")] })[path] ?? [];
  const opened = flattenTree(children, (path) => path === "cock", () => undefined);
  assert.deepEqual(opened.rows.map((row) => row.path), ["cock", "cock/app.py"]);
});

test("reports a folder that is still loading", () => {
  const children = () => [entry("src", true)];
  const { rows } = flattenTree(
    children,
    () => true,
    () => ({ loading: true }),
  );

  assert.equal(rows[0].loading, true);
});

test("caps the rows and says it truncated", () => {
  const children = () => [
    entry("a"),
    entry("b"),
    entry("c"),
  ];
  const { rows, truncated } = flattenTree(children, () => false, () => undefined, 2);

  assert.equal(rows.length, 2);
  assert.equal(truncated, true);

  const all = flattenTree(children, () => false, () => undefined, 5);
  assert.equal(all.rows.length, 3);
  assert.equal(all.truncated, false);
});

test("ignores an entry that claims to be its own parent", () => {
  const children = () => [entry("src", true)];
  const { rows } = flattenTree(
    (path) => (path === "src" ? [entry("src", true)] : children()),
    () => true,
    () => undefined,
  );

  assert.deepEqual(
    rows.map((row) => row.path),
    ["src"],
  );
});

test("lists the directories above a file", () => {
  assert.deepEqual(ancestorsOf("src/gui.tsx"), ["src"]);
  assert.deepEqual(ancestorsOf("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestorsOf("README.md"), []);
  assert.deepEqual(ancestorsOf(""), []);
});

test("finds the folder of a tree path", () => {
  assert.equal(folderOfTreePath("a/b/c.ts"), "a/b");
  assert.equal(folderOfTreePath("c.ts"), "");
});

test("moves a keyboard highlight and clamps at both ends", () => {
  const items = ["a", "b", "c"];
  assert.equal(nextItem(items, undefined, 1), "a");
  assert.equal(nextItem(items, undefined, -1), "c");
  assert.equal(nextItem(items, "a", 1), "b");
  assert.equal(nextItem(items, "a", -1), "a");
  assert.equal(nextItem(items, "c", 1), "c");
  assert.equal(nextItem(items, "missing", 1), "a");
  assert.equal(nextItem([], undefined, 1), undefined);
});

test("compares workspace paths without separator noise", () => {
  assert.equal(sameTreePath("src/gui.tsx", "src\\gui.tsx"), true);
  assert.equal(sameTreePath("src/gui.tsx", "src/other.tsx"), false);
  assert.equal(sameTreePath("", ""), false);
});

test("maps F2 to rename and Delete to delete, and nothing else", () => {
  assert.equal(treeShortcut("F2"), "rename");
  assert.equal(treeShortcut("Delete"), "delete");
  assert.equal(treeShortcut("f2"), undefined);
  assert.equal(treeShortcut("Backspace"), undefined);
  assert.equal(treeShortcut("Enter"), undefined);
});

test("maps Shift+Alt+C to copy-path and ignores C without both modifiers", () => {
  assert.equal(treeShortcut("c", { shift: true, alt: true }), "copy-path");
  assert.equal(treeShortcut("C", { shift: true, alt: true }), "copy-path");
  assert.equal(treeShortcut("c", { shift: true }), undefined);
  assert.equal(treeShortcut("c", { alt: true }), undefined);
  assert.equal(treeShortcut("c"), undefined);
  assert.equal(treeShortcut("F2", { shift: true, alt: true }), "rename");
});

test("tells a folder's children from the folder itself", () => {
  assert.equal(isInsideTreePath("src/gui.tsx", "src"), true);
  assert.equal(isInsideTreePath("src/deep/file.ts", "src"), true);
  assert.equal(isInsideTreePath("src\\gui.tsx", "src"), true);
  assert.equal(isInsideTreePath("src", "src"), false);
  assert.equal(isInsideTreePath("src-other/file.ts", "src"), false);
  assert.equal(isInsideTreePath("file.ts", ""), false);
});
