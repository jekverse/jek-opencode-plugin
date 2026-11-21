import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_BYTES,
  MAX_IMPORT_BYTES,
  createFile,
  createFolder,
  copyEntry,
  deleteEntry,
  droppedFileName,
  importFile,
  moveEntry,
  isTextFile,
  looksLikeText,
  readMediaFile,
  readTextFile,
  resolveWorkspacePath,
  writeTextFile,
} from "./.build/fs-core.mjs";
import { MAX_MEDIA_BYTES } from "./.build/media.mjs";

const dir = await mkdtemp(join(tmpdir(), "fs-core-"));

test("CRLF and BOM survive a round trip", async () => {
  const file = join(dir, "crlf.txt");
  await writeFile(
    file,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]),
  );

  const read = await readTextFile(file);
  assert.equal(read.text, "a\nb\n");
  assert.equal(read.eol, "crlf");
  assert.equal(read.bom, true);

  await writeTextFile(file, "a\nb\nc\n", read.text);
  const raw = await readFile(file);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(raw.includes(Buffer.from("\r\n")), true);
  assert.equal(raw.includes(Buffer.from("b\nc")), false);
});

test("an LF file stays LF", async () => {
  const file = join(dir, "lf.txt");
  await writeFile(file, "one\ntwo\n");
  const read = await readTextFile(file);
  assert.equal(read.eol, "lf");
  assert.equal(read.bom, false);

  await writeTextFile(file, "one\ntwo\nthree\n", read.text);
  assert.equal((await readFile(file)).includes(Buffer.from("\r")), false);
});

test("a stale baseline is refused and the other writer survives", async () => {
  const file = join(dir, "guard.txt");
  await writeFile(file, "original\n");
  const read = await readTextFile(file);
  await writeFile(file, "agent changed this\n");

  await assert.rejects(
    () => writeTextFile(file, "panel wins\n", read.text),
    /EXTERNAL_CHANGE/,
  );
  assert.equal(await readFile(file, "utf8"), "agent changed this\n");
});

test("a forced write replaces whatever is on disk", async () => {
  const file = join(dir, "guard.txt");
  await writeTextFile(file, "panel wins\n", null);
  assert.equal(await readFile(file, "utf8"), "panel wins\n");
});

test("a missing target is a conflict, not a silent recreate", async () => {
  const file = join(dir, "gone.txt");
  await writeFile(file, "here\n");
  const read = await readTextFile(file);
  await assert.rejects(
    () => writeTextFile(join(dir, "missing.txt"), "x", read.text),
    /EXTERNAL_CHANGE/,
  );
});

test("no temporary files are left behind", async () => {
  const leftovers = (await readdir(dir)).filter((name) =>
    name.includes(".file-editor-"),
  );
  assert.deepEqual(leftovers, []);
});

test("oversized files are refused on read and write", async () => {
  const file = join(dir, "big.txt");
  await writeFile(file, Buffer.alloc(MAX_BYTES + 1, 0x61));
  await assert.rejects(() => readTextFile(file), /TOO_LARGE/);
  await assert.rejects(
    () => writeTextFile(join(dir, "lf.txt"), "x".repeat(MAX_BYTES + 1), null),
    /TOO_LARGE/,
  );
});

test("invalid UTF-8 and NUL bytes are refused", async () => {
  const latin = join(dir, "latin1.txt");
  await writeFile(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await assert.rejects(() => readTextFile(latin), /INVALID_UTF8/);

  const binary = join(dir, "binary.txt");
  await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
  await assert.rejects(() => readTextFile(binary), /BINARY/);
});

test("readMediaFile returns the bytes and refuses non-files and oversized media", async () => {
  const file = join(dir, "photo.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const media = await readMediaFile(file);
  assert.equal(media.size, 4);
  assert.deepEqual([...media.data], [0xff, 0xd8, 0xff, 0xe0]);
  assert.ok(media.data instanceof Uint8Array);

  const folder = join(dir, "media-folder");
  await createFolder(folder);
  await assert.rejects(() => readMediaFile(folder), /NOT_FILE/);

  const big = join(dir, "big.mp4");
  await writeFile(big, "");
  await truncate(big, MAX_MEDIA_BYTES + 1);
  await assert.rejects(() => readMediaFile(big), /MEDIA_TOO_LARGE/);
  await rm(big, { force: true });
});

test("looksLikeText sniffs the first block", () => {
  assert.equal(looksLikeText(Buffer.from("hello\n")), true);
  assert.equal(looksLikeText(Buffer.from([0x61, 0x00])), false);
  assert.equal(looksLikeText(Buffer.from([0x01, 0x02])), false);
});

test("isTextFile answers false instead of throwing", async () => {
  const text = join(dir, "sniff.txt");
  await writeFile(text, "hello\n");
  assert.equal(await isTextFile(text), true);

  const binary = join(dir, "sniff.bin");
  await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
  assert.equal(await isTextFile(binary), false);

  // A rail click on a file that has since been deleted must not throw out of the
  // Ipc handler; that was the crash path when the path itself was wrong.
  assert.equal(await isTextFile(join(dir, "does-not-exist.txt")), false);
  assert.equal(await isTextFile(join(dir, "no-such-folder", "x.txt")), false);
});

test("expected null creates a file", async () => {
  const file = join(dir, "new.txt");
  await writeTextFile(file, "created\n", null);
  assert.equal(await readFile(file, "utf8"), "created\n");
});

test("creates files and folders without replacing existing entries", async () => {
  const file = join(dir, "created.txt");
  await createFile(file);
  assert.equal(await readFile(file, "utf8"), "");
  await assert.rejects(() => createFile(file), { code: "EEXIST" });

  const folder = join(dir, "created-folder");
  await createFolder(folder);
  assert.equal((await stat(folder)).isDirectory(), true);
  await assert.rejects(() => createFolder(folder), { code: "EEXIST" });
});

test("workspace creation paths cannot escape or target the workspace root", () => {
  assert.equal(resolveWorkspacePath("new.ts", dir), join(dir, "new.ts"));
  assert.throws(() => resolveWorkspacePath("..\\outside.txt", dir), /OUTSIDE_WORKSPACE/);
  assert.throws(() => resolveWorkspacePath(".", dir), /OUTSIDE_WORKSPACE/);
  assert.equal(resolveWorkspacePath("subdir/file.txt", dir), join(dir, "subdir", "file.txt"));
});

test("copy, move and delete operate on entries without clobbering targets", async () => {
  const source = join(dir, "source.txt");
  const copy = join(dir, "copy.txt");
  const moved = join(dir, "moved.txt");
  await writeFile(source, "content");
  await copyEntry(source, copy);
  assert.equal(await readFile(copy, "utf8"), "content");
  await assert.rejects(() => copyEntry(source, copy));
  await moveEntry(copy, moved);
  assert.equal(await readFile(moved, "utf8"), "content");
  await assert.rejects(() => moveEntry(source, moved), /TARGET_EXISTS/);
  await deleteEntry(moved);
  await assert.rejects(() => stat(moved), { code: "ENOENT" });
  await rm(source, { force: true });
});

test("a dropped file keeps its name or takes the next free one", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fs-import-"));
  const first = await importFile(workspace, "", "app.py", Buffer.from("print(1)\n"));
  assert.deepEqual(first, { path: "app.py", name: "app.py", size: 9 });
  assert.equal(await readFile(join(workspace, "app.py"), "utf8"), "print(1)\n");

  const second = await importFile(workspace, "", "app.py", Buffer.from("print(2)\n"));
  assert.equal(second.name, "app (2).py");
  assert.equal(second.path, "app (2).py");
  assert.equal(await readFile(join(workspace, "app (2).py"), "utf8"), "print(2)\n");

  await mkdir(join(workspace, "cock"));
  const nested = await importFile(workspace, "cock", "nine.py", new Uint8Array([0x61]));
  assert.deepEqual(nested, { path: "cock/nine.py", name: "nine.py", size: 1 });
  assert.equal(await readFile(join(workspace, "cock", "nine.py"), "utf8"), "a");
  await rm(workspace, { recursive: true, force: true });
});

test("a dropped name stays one segment and stays inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fs-import-"));
  await assert.rejects(
    () => importFile(workspace, "..", "x.txt", new Uint8Array()),
    /OUTSIDE_WORKSPACE/,
  );
  await assert.rejects(
    () => importFile(workspace, "", "../x.txt", new Uint8Array()),
    /INVALID_NAME/,
  );
  await assert.rejects(
    () => importFile(workspace, "", "cock/x.txt", new Uint8Array()),
    /INVALID_NAME/,
  );
  await assert.rejects(
    () => importFile(workspace, "missing", "x.txt", new Uint8Array()),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () => importFile(workspace, "", "big.bin", new Uint8Array(MAX_IMPORT_BYTES + 1)),
    /IMPORT_TOO_LARGE/,
  );
  await rm(workspace, { recursive: true, force: true });
});

test("droppedFileName trims and refuses path syntax", () => {
  assert.equal(droppedFileName("  app.py "), "app.py");
  assert.throws(() => droppedFileName(""), /INVALID_NAME/);
  assert.throws(() => droppedFileName("."), /INVALID_NAME/);
  assert.throws(() => droppedFileName(".."), /INVALID_NAME/);
  assert.throws(() => droppedFileName("a/b"), /INVALID_NAME/);
  assert.throws(() => droppedFileName("a\\b"), /INVALID_NAME/);
});
