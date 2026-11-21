import { randomBytes } from "node:crypto"
import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename as renamePath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { freeEntryName } from "./browse"
import { MAX_MEDIA_BYTES } from "./media"

// Anything above this is not something a textarea should try to hold.
export const MAX_BYTES = 2 * 1024 * 1024

/**
 * A dropped file crosses IPC as one base64 string, so a huge one would spend
 * more time copying than the user expects. Refuse before the transfer.
 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

export function resolvePath(path: string, base: string) {
  let p = path.trim()
  if (p === "~") p = homedir()
  else if (p.startsWith("~/") || p.startsWith("~\\"))
    p = resolve(homedir(), p.slice(2))

  return isAbsolute(p) ? p : resolve(base || homedir(), p)
}

export type ReadResult = {
  text: string
  eol: string
  bom: boolean
  mtimeMs: number
  size: number
}

export type WriteResult = { message: string; mtimeMs: number; size: number }

export type MediaResult = { data: Uint8Array; size: number }

export async function createFile(path: string) {
  const handle = await open(path, "wx", 0o600)
  await handle.close()
}

export async function createFolder(path: string) {
  await mkdir(path)
}

export async function moveEntry(from: string, to: string) {
  try {
    await stat(to)
    throw new Error("TARGET_EXISTS")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await renamePath(from, to)
}

export async function copyEntry(from: string, to: string) {
  await cp(from, to, { recursive: true, errorOnExist: true, force: false })
}

/**
 * A dropped file keeps its own name unless that name is taken in the target
 * folder; then it becomes "name (2).ext", so a drop never overwrites work.
 */
export function droppedFileName(name: string) {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error("INVALID_NAME")
  }
  return trimmed
}

/**
 * Copies one dropped file into `folder` (relative to the workspace `base`, or
 * the root when empty) and answers the path the tree can select. `wx` makes the
 * write fail instead of truncating a file that appeared after the name check.
 */
export async function importFile(
  base: string,
  folder: string,
  name: string,
  data: Uint8Array,
): Promise<{ path: string; name: string; size: number }> {
  const wanted = droppedFileName(name)
  if (data.byteLength > MAX_IMPORT_BYTES) throw new Error("IMPORT_TOO_LARGE")

  const root = resolve(base)
  const directory = folder.trim() ? resolveWorkspacePath(folder, base) : root
  if (!(await stat(directory)).isDirectory()) throw new Error("NOT_FOLDER")

  const final = freeEntryName(await readdir(directory), wanted)
  const target = join(directory, final)
  await writeFile(target, data, { flag: "wx", mode: 0o600 })
  return {
    path: relative(root, target).split(sep).join("/"),
    name: final,
    size: data.byteLength,
  }
}

export async function deleteEntry(path: string) {
  await rm(path, { recursive: true, force: false })
}

export function resolveWorkspacePath(path: string, base: string) {
  if (!path.trim() || isAbsolute(path)) {
    throw new Error("INVALID_NAME")
  }
  const root = resolve(base)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("OUTSIDE_WORKSPACE")
  }
  return target
}

// A text file has no NUL or stray control bytes in its first block.
export function looksLikeText(buffer: Buffer) {
  if (buffer.length === 0) return true
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    return true
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
    return true
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  )
    return true

  for (const byte of buffer) {
    if (byte === 0) return false
    if (byte < 0x09) return false
    // Allow tab, newline, vertical tab, form feed, carriage return and ESC.
    if (byte > 0x0d && byte < 0x20 && byte !== 0x1b) return false
  }
  return true
}

// Decode once, everywhere: strip a BOM, remember the line ending, and hand the
// panel LF text so the textarea and its history work on one shape.
export function decodeText(raw: Buffer) {
  let bom = false
  let start = 0
  if (
    raw.length >= 3 &&
    raw[0] === 0xef &&
    raw[1] === 0xbb &&
    raw[2] === 0xbf
  ) {
    bom = true
    start = 3
  }

  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      raw.subarray(start),
    )
  } catch {
    throw new Error("INVALID_UTF8")
  }
  if (decoded.includes("\0")) throw new Error("BINARY")

  const eol = decoded.includes("\r\n") ? "crlf" : "lf"
  return { text: decoded.replace(/\r\n?/g, "\n"), eol, bom }
}

export async function readTextFile(path: string): Promise<ReadResult> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error("NOT_FILE")
  if (info.size > MAX_BYTES) throw new Error("TOO_LARGE")
  const decoded = decodeText(await readFile(path))
  return {
    text: decoded.text,
    eol: decoded.eol,
    bom: decoded.bom,
    mtimeMs: info.mtimeMs,
    size: info.size,
  }
}

/**
 * Reads one image, audio or video file for the panel's preview. The bytes cross
 * IPC and become a Blob URL in the window, so the size cap keeps the transfer
 * and the retained memory predictable. The caller decides whether the path is
 * a media kind; this only enforces "a real file, under the cap".
 */
export async function readMediaFile(path: string): Promise<MediaResult> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error("NOT_FILE")
  if (info.size > MAX_MEDIA_BYTES) throw new Error("MEDIA_TOO_LARGE")
  return { data: new Uint8Array(await readFile(path)), size: info.size }
}

/**
 * Sniffs a file's first block for text. A path that cannot be opened is not text:
 * this answer feeds a click on a file that may have been deleted, so it must never
 * throw out of the Ipc handler.
 */
export async function isTextFile(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    return false
  }

  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return looksLikeText(buffer.subarray(0, bytesRead))
  } catch {
    return false
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Writes through a temporary file in the same directory, so a crash or a full
 * disk leaves the original intact instead of a half-written file.
 *
 * `expected` is the content the caller believes is on disk. A mismatch, or a
 * file that vanished, raises EXTERNAL_CHANGE; pass null to overwrite on purpose.
 */
export async function writeTextFile(
  path: string,
  text: string,
  expected: string | null,
): Promise<WriteResult> {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("TOO_LARGE")

  let existing: ReadResult | undefined
  try {
    existing = await readTextFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" && expected !== null)
      throw new Error("EXTERNAL_CHANGE")
    if (code !== "ENOENT" && !String(error).includes("TOO_LARGE")) throw error
  }

  if (expected !== null && existing && existing.text !== expected) {
    throw new Error("EXTERNAL_CHANGE")
  }

  // Keep the file's own convention rather than rewriting every line ending.
  const eol = existing?.eol ?? "lf"
  const bom = existing?.bom ?? false
  const body = eol === "crlf" ? text.replace(/\n/g, "\r\n") : text
  const bytes = Buffer.from(body, "utf8")
  const buffer = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : bytes

  let mode = 0o600
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    // New file: 600 is the safer default.
  }

  const temporary = join(
    dirname(path),
    `.${basename(path)}.file-editor-${randomBytes(6).toString("hex")}.tmp`,
  )
  await writeFile(temporary, buffer, { mode })
  try {
    await chmod(temporary, mode).catch(() => undefined)
    await renamePath(temporary, path)
  } catch (error) {
    // Windows refuses to replace a file another process holds open.
    const code = (error as NodeJS.ErrnoException).code
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EBUSY" || code === "EACCES")
    ) {
      await writeFile(path, buffer, { mode })
    } else {
      throw error
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }

  const info = await stat(path)
  return { message: `Saved ${path}`, mtimeMs: info.mtimeMs, size: info.size }
}
