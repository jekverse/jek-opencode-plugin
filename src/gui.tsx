import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  ErrorBoundary,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  on,
  type JSX,
} from "solid-js";
import { Schema } from "effect";
import { EditorView, lineNumbers as cmLineNumbers, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import {
  Command,
  Ipc,
  LinkHandler,
  MenuItem,
  Panel,
  Plugin,
  usePanel,
  type Files,
  type PanelFrame,
  type PanelTab,
  type SessionRef,
  type Ui,
  type UiMenuEntry,
} from "@opencode/plugin/gui";
import {
  isTextFile,
  MAX_IMPORT_BYTES,
  createFile,
  createFolder,
  copyEntry,
  deleteEntry,
  importFile,
  moveEntry,
  readMediaFile,
  readTextFile,
  resolvePath,
  resolveWorkspacePath,
  writeTextFile,
  type MediaResult,
  type ReadResult,
  type WriteResult,
} from "./fs-core";
import { canonicalPath, relativeTo } from "./paths";
import {
  formatMediaSize,
  mediaKind,
  mediaMime,
  type MediaKind,
} from "./media";
import {
  canDrag,
  imageScale,
  isMoved,
  panBy,
  resetImageView,
  wheelZoomFactor,
  zoomAt,
  zoomLabel,
  type ImageSize,
  type ImageView,
} from "./image-view";
import {
  basenameOf,
  extension,
  folderOf,
  hrefPath,
  isFileLink,
  isMarkdown,
  isTextPath,
  linkBase,
} from "./links";
import {
  LAUNCHER,
  BROWSER,
  keyFor,
  pathFromId,
  pickShown,
  tabId,
  tabKey,
} from "./tabs";
import { explain, isExternalChange } from "./status";
import {
  crumbTrail,
  delimiterFor,
  gutterText,
  isTablePath,
  parseTable,
} from "./view";
import { parseRecent, pushRecent, serializeRecent } from "./recent";
import { freeEntryName, limitEntries, parentOf, sortEntries, type Entry } from "./browse";
import {
  childEntry,
  flattenTree,
  folderOfTreePath,
  isInsideTreePath,
  nextItem,
  sameTreePath,
  treeShortcut,
  type TreeEntry,
  type TreeRow,
} from "./tree";
import { revealCommand } from "./reveal";

// The window cannot touch the filesystem, so every read and write crosses IPC.
// `write` takes the content the panel believes is on disk and refuses when it
// no longer matches: the agent edits these same files while the panel is open.
const Fs = Ipc.define({
  // Bumped when methods are added: the host keeps the contract registered under
  // an id across plugin reloads, so an old id would answer with the old methods.
  id: "jek-exploler.fs.v8",
  methods: {
    read: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Struct({
        text: Schema.String,
        eol: Schema.String,
        bom: Schema.Boolean,
        mtimeMs: Schema.Number,
        size: Schema.Number,
      }),
    },
    readMedia: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Struct({
        data: Schema.Uint8Array,
        size: Schema.Number,
      }),
    },
    write: {
      input: Schema.Struct({
        path: Schema.String,
        base: Schema.String,
        text: Schema.String,
        expected: Schema.String,
      }),
      output: Schema.Struct({
        message: Schema.String,
        mtimeMs: Schema.Number,
        size: Schema.Number,
      }),
    },
    forceWrite: {
      input: Schema.Struct({
        path: Schema.String,
        base: Schema.String,
        text: Schema.String,
      }),
      output: Schema.Struct({
        message: Schema.String,
        mtimeMs: Schema.Number,
        size: Schema.Number,
      }),
    },
    resolve: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.String,
    },
    reveal: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    list: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({ name: Schema.String, dir: Schema.Boolean }),
        ),
        total: Schema.Number,
      }),
    },
    exists: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    createFile: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    createFolder: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    copyEntry: {
      input: Schema.Struct({ path: Schema.String, target: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    moveEntry: {
      input: Schema.Struct({ path: Schema.String, target: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    deleteEntry: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    isText: {
      input: Schema.Struct({ path: Schema.String, base: Schema.String }),
      output: Schema.Boolean,
    },
    importFile: {
      input: Schema.Struct({
        folder: Schema.String,
        base: Schema.String,
        name: Schema.String,
        data: Schema.Uint8Array,
      }),
      output: Schema.Struct({
        path: Schema.String,
        name: Schema.String,
        size: Schema.Number,
      }),
    },
  },
});

type FsClient = {
  read(input: { path: string; base: string }): Promise<ReadResult>;
  readMedia(input: { path: string; base: string }): Promise<MediaResult>;
  write(input: {
    path: string;
    base: string;
    text: string;
    expected: string;
  }): Promise<WriteResult>;
  forceWrite(input: {
    path: string;
    base: string;
    text: string;
  }): Promise<WriteResult>;
  resolve(input: { path: string; base: string }): Promise<string>;
  reveal(input: { path: string; base: string }): Promise<boolean>;
  list(input: {
    path: string;
    base: string;
  }): Promise<{ entries: readonly Entry[]; total: number }>;
  exists(input: { path: string; base: string }): Promise<boolean>;
  createFile(input: { path: string; base: string }): Promise<boolean>;
  createFolder(input: { path: string; base: string }): Promise<boolean>;
  copyEntry(input: { path: string; target: string; base: string }): Promise<boolean>;
  moveEntry(input: { path: string; target: string; base: string }): Promise<boolean>;
  deleteEntry(input: { path: string; base: string }): Promise<boolean>;
  isText(input: { path: string; base: string }): Promise<boolean>;
  importFile(input: {
    folder: string;
    base: string;
    name: string;
    data: Uint8Array;
  }): Promise<{ path: string; name: string; size: number }>;
};

// One buffer per path, so switching tabs does not throw away unsaved text.
// The host owns which tabs exist and their order; this only caches their state.
type Buffer = { text: string; baseline: string; dirty: boolean };

const buffers = new Map<string, Buffer>();
const [tick, setTick] = createSignal(0);

// Directories the rail has listed, kept outside the component so opening a tab
// (which remounts the panel render) cannot drop back to the host's partial
// tree cache and make a child row disappear.
const directoryListings = new Map<string, readonly TreeEntry[]>();
const loadingDirectories = new Set<string>();
const [directoriesTick, setDirectoriesTick] = createSignal(0);

function storeDirectoryListing(folder: string, entries: readonly TreeEntry[]) {
  directoryListings.set(folder, entries);
  setDirectoriesTick((value) => value + 1);
}

/** The folder row under a point, or undefined when the point is not on one. */
function folderAtPoint(x: number, y: number) {
  const element = document.elementFromPoint(x, y) as HTMLElement | null;
  return element?.closest<HTMLElement>("[data-tree-row='folder']")?.dataset
    .treePath;
}

/** True when the drag carries files from outside the window. */
function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * The host's prompt overlay appears from a `dragover` listener on `document`
 * and clears on its own `drop`, Escape, or a `dragleave` that reports no
 * `relatedTarget` (the pointer left the window). This panel stops those events
 * so a desktop drop is copied into the workspace instead of attached to the
 * prompt, which also means the host never learns the drag ended and leaves its
 * overlay up. Dispatch the exact `dragleave` the host waits for.
 */
function clearHostDrop() {
  document.dispatchEvent(
    new DragEvent("dragleave", { bubbles: true, cancelable: true }),
  );
}

/**
 * The files in a drop, split from folders. A folder arrives as a zero-byte
 * File, so copying it as a file would leave an empty stub with its name.
 */
function droppedFiles(event: DragEvent) {
  const transfer = event.dataTransfer;
  const files: File[] = [];
  const folders: string[] = [];
  const items = Array.from(transfer?.items ?? []);
  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (entry?.isDirectory) folders.push(file?.name || entry.name);
      else if (file) files.push(file);
    }
    return { files, folders };
  }
  return { files: Array.from(transfer?.files ?? []), folders };
}

// Panel-wide preferences: every tab and the settings dialog read the same ones.
const [lineNumbers, setLineNumbers] = createSignal(true);
const [wordWrap, setWordWrap] = createSignal(false);
const [autoSave, setAutoSave] = createSignal(true);

// The launcher's recent list. Stored in the window so it survives restarts.
const RECENT_KEY = "file-editor:recent";

function readRecent() {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

const [recent, setRecent] = createSignal<string[]>(readRecent());

function rememberRecent(path: string) {
  const next = pushRecent(recent(), path);
  setRecent(next);
  try {
    localStorage.setItem(RECENT_KEY, serializeRecent(next));
  } catch {
    // A blocked or full storage keeps the list for this session only.
  }
}

function forgetRecent() {
  setRecent([]);
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // Nothing to clear.
  }
}

// The folder the single Browse tab shows; navigating inside it does not add tabs.
const [browsePath, setBrowsePath] = createSignal("");

// The rail's filter is shared by every tab, so switching files does not clear it.
// Expansion lives in the host file model and survives on its own.
const [railQuery, setRailQuery] = createSignal("");
// The clicked row must follow the file into the tab's own rail.
const [pendingRailSelection, setPendingRailSelection] = createSignal<{
  sessionKey: string;
  root: string;
  path: string;
}>();
// Fallback for a host that predates the shared panel sidebar.
const [railFallbackOpen, setRailFallbackOpen] = createSignal(true);

function bump() {
  setTick((value) => value + 1);
}

function Browser(props: {
  fs: FsClient;
  ui: Ui;
  start: () => string;
  open: (path: string) => void;
}) {
  const [cwd, setCwd] = createSignal(props.start());
  const [entries, setEntries] = createSignal<readonly Entry[]>([]);
  const [total, setTotal] = createSignal(0);
  const [status, setStatus] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let seq = 0;

  async function read(dir: string) {
    const run = ++seq;
    setBusy(true);
    try {
      const result = await props.fs.list({ path: dir, base: "" });
      if (run !== seq) return;
      setEntries(result.entries);
      setTotal(result.total);
      setCwd(dir);
      setStatus("");
    } catch (error) {
      if (run !== seq) return;
      setEntries([]);
      setTotal(0);
      setStatus(explain(error));
    } finally {
      if (run === seq) setBusy(false);
    }
  }

  function go(dir: string) {
    if (!dir) return;
    setBrowsePath(dir);
    void read(dir);
  }

  onMount(() => void read(props.start()));

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "box-sizing": "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "4px",
          "align-items": "center",
          padding: "4px 8px",
          "border-bottom":
            "1px solid color-mix(in srgb, currentColor 12%, transparent)",
          overflow: "hidden",
          "white-space": "nowrap",
        }}
      >
        <props.ui.IconButton
          icon="arrow-up"
          label="Parent folder"
          size="small"
          disabled={!parentOf(cwd())}
          onClick={() => go(parentOf(cwd()))}
        />
        <For each={crumbTrail(cwd())}>
          {(crumb, index) => (
            <>
              <Show when={index() > 0}>
                <span style={{ opacity: "0.3" }}>›</span>
              </Show>
              <props.ui.Button
                size="small"
                variant="ghost-muted"
                onClick={() => go(crumb.path)}
              >
                {crumb.name}
              </props.ui.Button>
            </>
          )}
        </For>
        <span style={{ flex: "1" }} />
        <Show when={busy()}>
          <props.ui.Loader size="small" />
        </Show>
      </div>

      <div
        style={{
          flex: "1",
          "min-height": "0",
          "overflow-y": "auto",
          padding: "4px",
        }}
      >
        <For each={entries()}>
          {(entry) => {
            const target = () => canonicalPath(entry.name, cwd());
            return (
              <props.ui.Button
                variant="ghost"
                size="small"
                class="w-full"
                onClick={() =>
                  entry.dir ? go(target()) : props.open(target())
                }
              >
                <span
                  style={{
                    display: "flex",
                    gap: "8px",
                    width: "100%",
                    "min-width": "0",
                    "align-items": "center",
                    "text-align": "left",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      // Folders read as amber, files stay neutral: the usual
                      // file-tree colour code, without inventing a palette.
                      color: entry.dir
                        ? "var(--color-folder, #d9a441)"
                        : undefined,
                      opacity: entry.dir ? undefined : "0.65",
                    }}
                  >
                    <props.ui.Icon
                      name={entry.dir ? "folder" : "file-document"}
                      size="small"
                    />
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      "font-weight": entry.dir ? "600" : undefined,
                    }}
                  >
                    {entry.name}
                  </span>
                </span>
              </props.ui.Button>
            );
          }}
        </For>
        <Show when={entries().length > 0 && entries().length < total()}>
          <div
            style={{
              padding: "6px 10px",
              "font-size": "11.5px",
              opacity: "0.6",
            }}
          >
            Showing the first {entries().length} of {total()} entries.
          </div>
        </Show>
        <Show when={entries().length === 0}>
          <div style={{ padding: "10px", "font-size": "12px", opacity: "0.6" }}>
            {busy()
              ? "Loading…"
              : status()
                ? `Could not read this folder: ${status()}`
                : "This folder is empty."}
          </div>
        </Show>
      </div>

      <Show when={status()}>
        <div
          style={{
            padding: "4px 10px",
            "font-size": "11.5px",
            opacity: "0.6",
            "border-top":
              "1px solid color-mix(in srgb, currentColor 10%, transparent)",
          }}
        >
          {status()}
        </div>
      </Show>
    </div>
  );
}

function sourceLanguage(path: string) {
  switch (extension(path)) {
    case "js":
    case "jsx":
      return javascript({ jsx: extension(path) === "jsx" });
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: extension(path) === "tsx" });
    case "py":
      return python();
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    default:
      return [];
  }
}

const sourceHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "light-dark(#52604f, #a1b39b)" },
  { tag: [tags.keyword, tags.operatorKeyword], color: "light-dark(#722b87, #dca8f0)" },
  { tag: [tags.literal, tags.bool, tags.atom], color: "light-dark(#20603b, #b8dda4)" },
  { tag: tags.string, color: "light-dark(#963b23, #f1b597)" },
  { tag: [tags.regexp, tags.escape], color: "light-dark(#8a4917, #efcb92)" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "light-dark(#185689, #a9d4ff)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "light-dark(#79530e, #f2de9d)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "light-dark(#116561, #8edbd0)" },
  { tag: tags.invalid, color: "light-dark(#a72838, #ffa6af)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: [tags.heading, tags.strong], fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]);

function SourceEditor(props: {
  colorScheme: "light" | "dark";
  path: string;
  value: () => string;
  wordWrap: () => boolean;
  lineNumbers: () => boolean;
  edit(value: string): void;
  save(): void;
  undo(): void;
  redo(): void;
}) {
  let host!: HTMLDivElement;
  let editor: EditorView | undefined;
  const wrap = new Compartment();
  const gutter = new Compartment();

  onMount(() => {
    editor = new EditorView({
      state: EditorState.create({
        doc: props.value(),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          bracketMatching(),
          indentOnInput(),
          sourceLanguage(props.path),
          syntaxHighlighting(sourceHighlightStyle),
          wrap.of(props.wordWrap() ? EditorView.lineWrapping : []),
          gutter.of(props.lineNumbers() ? cmLineNumbers() : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) props.edit(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)", lineHeight: "1.65" },
            ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "inherit", opacity: "0.45" },
            ".cm-content": { padding: "10px 12px" },
            ".cm-line": { padding: "0" },
          }),
          EditorView.domEventHandlers({
            keydown(event) {
              if (
                event.altKey && !event.ctrlKey && !event.metaKey &&
                !event.shiftKey && !event.isComposing && event.code === "KeyZ"
              ) {
                event.preventDefault();
                if (!event.repeat) setWordWrap((enabled) => !enabled);
                return true;
              }
              if (!(event.ctrlKey || event.metaKey)) return false;
              const key = event.key.toLowerCase();
              if (key === "s") { event.preventDefault(); props.save(); return true; }
              if (key === "z") { event.preventDefault(); event.shiftKey ? props.redo() : props.undo(); return true; }
              if (key === "y") { event.preventDefault(); props.redo(); return true; }
              return false;
            },
          }),
        ],
      }),
      parent: host,
    });
  });

  createEffect(() => {
    const value = props.value();
    const current = editor;
    if (current && value !== current.state.doc.toString()) {
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
    }
  });

  createEffect(() => {
    const current = editor;
    const enabled = props.lineNumbers();
    if (current) current.dispatch({ effects: gutter.reconfigure(enabled ? cmLineNumbers() : []) });
  });

  createEffect(() => {
    const current = editor;
    const enabled = props.wordWrap();
    if (current) current.dispatch({ effects: wrap.reconfigure(enabled ? EditorView.lineWrapping : []) });
  });

  onCleanup(() => editor?.destroy());

  return <div ref={host} style={{ flex: "1", "min-width": "0", "min-height": "0", overflow: "hidden", "color-scheme": props.colorScheme }} />;
}

function Editor(props: {
  colorScheme: "light" | "dark";
  fs: FsClient;
  base: () => string;
  path: string;
  open: (path: string) => void;
  browseFolder: (path: string) => void;
  openSettings: () => void;
  ui: Ui;
}) {
  const launcher = !props.path;

  const [pathInput, setPathInput] = createSignal(props.path);
  const [text, setText] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [conflict, setConflict] = createSignal(false);
  const [canUndo, setCanUndo] = createSignal(false);
  const [canRedo, setCanRedo] = createSignal(false);
  const [view, setView] = createSignal<"source" | "preview" | "table">(
    isTablePath(props.path)
      ? "table"
      : isMarkdown(props.path)
        ? "preview"
        : "source",
  );

  const autosaveMs = 900;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let queued = false;
  let version = 0;
  let fileSeq = 0;
  let baseline = "";
  let history: string[] = [""];
  let historyIndex = 0;
  let lastChangeAt = 0;

  // A preview holds one Blob URL at a time. Switching files, reloading, or
  // closing the tab revokes it so the media bytes are not kept for the session.
  const [media, setMedia] = createSignal<
    { kind: MediaKind; url: string; size: number } | undefined
  >();
  let mediaUrl: string | undefined;

  // One zoom/pan transform per image preview. Reset whenever another file (or
  // a reload of the same one) replaces it.
  const [imageView, setImageView] = createSignal(resetImageView());
  const [imageStage, setImageStage] = createSignal<HTMLDivElement>();
  const [imageStageSize, setImageStageSize] = createSignal<ImageSize>();
  const [imageSourceSize, setImageSourceSize] = createSignal<ImageSize>();
  const imageDimensions = createMemo(() => {
    const stage = imageStageSize();
    const source = imageSourceSize();
    if (!stage?.width || !stage.height || !source?.width || !source.height) return;
    const scale = imageScale(source, stage, imageView().zoom);
    return { width: source.width * scale, height: source.height * scale, scale };
  });

  createEffect(() => {
    const stage = imageStage();
    if (!stage || media()?.kind !== "image") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setImageStageSize({ width, height });
    });
    observer.observe(stage);
    stage.addEventListener("wheel", scrollImage, { passive: false });
    onCleanup(() => {
      observer.disconnect();
      stage.removeEventListener("wheel", scrollImage);
    });
  });

  // A pointer drag remembers the view it started from, so the image follows
  // the cursor without accumulating rounding drift.
  let imageDrag:
    | { pointerId: number; x: number; y: number; view: ImageView }
    | undefined;
  const [imageDragging, setImageDragging] = createSignal(false);

  function clearMedia() {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = undefined;
    setMedia(undefined);
    setImageSourceSize(undefined);
    imageDrag = undefined;
    setImageDragging(false);
    setImageView(resetImageView());
  }

  /**
   * Wheel navigation while an image is previewed: Ctrl zooms around the cursor,
   * Shift moves sideways, and a plain wheel moves up and down. The listener is
   * native and non-passive so `preventDefault` keeps the panel from scrolling.
   */
  function scrollImage(event: WheelEvent) {
    if (!media() || media()?.kind !== "image") return;
    event.preventDefault();

    const scale = (value: number) =>
      event.deltaMode === 1
        ? value * 16
        : event.deltaMode === 2
          ? value * 400
          : value;
    const dx = scale(event.deltaX);
    const dy = scale(event.deltaY);

    if (event.ctrlKey || event.metaKey) {
      const stage = event.currentTarget as HTMLElement;
      const rect = stage.getBoundingClientRect();
      setImageView((view) =>
        zoomAt(
          view,
          {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2,
          },
          wheelZoomFactor(dy || dx),
        ),
      );
      return;
    }

    // A trackpad may report Shift+wheel as deltaX; take whichever axis moved.
    const amount = event.shiftKey
      ? Math.abs(dx) > Math.abs(dy)
        ? dx
        : dy
      : dy;
    setImageView((view) =>
      event.shiftKey ? panBy(view, -amount, 0) : panBy(view, 0, -amount),
    );
  }

  // Middle-drag at any zoom, or left-drag after zooming or panning.
  // Capture the pointer so the drag works outside the stage as well.
  function beginImageDrag(
    event: PointerEvent & { currentTarget: HTMLElement },
  ) {
    if (media()?.kind !== "image" || imageDrag) return;
    const middle = event.button === 1;
    if (!middle && (event.button !== 0 || !canDrag(imageView()))) return;
    // The zoom badge is its own control, not the start of a pan.
    if ((event.target as Element | null)?.closest("button")) return;

    imageDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: imageView(),
    };
    setImageDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveImageDrag(event: PointerEvent) {
    const drag = imageDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setImageView(
      panBy(drag.view, event.clientX - drag.x, event.clientY - drag.y),
    );
    event.preventDefault();
  }

  function endImageDrag(
    event: PointerEvent & { currentTarget: HTMLElement },
  ) {
    const drag = imageDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    imageDrag = undefined;
    setImageDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const stamp = () =>
    new Date().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

  function cancelAutosave() {
    clearTimeout(timer);
    timer = undefined;
  }

  function scheduleAutosave() {
    cancelAutosave();
    // A conflict is a decision for the user, not something to retry on a timer.
    if (!dirty() || conflict()) return;
    if (!autoSave()) return;
    timer = setTimeout(() => void save(true), autosaveMs);
  }

  // Keep the shared buffer in step so a tab switch does not lose the draft.
  function persist() {
    if (!props.path) return;
    const next = text();
    const nextDirty = next !== baseline;
    const previous = buffers.get(props.path);
    buffers.set(props.path, { text: next, baseline, dirty: nextDirty });
    if (!previous || previous.dirty !== nextDirty) bump();
  }

  function syncHistory() {
    setCanUndo(historyIndex > 0);
    setCanRedo(historyIndex < history.length - 1);
  }

  function resetHistory(value: string) {
    history = [value];
    historyIndex = 0;
    lastChangeAt = 0;
    syncHistory();
  }

  function recordHistory(value: string, big: boolean) {
    const now = Date.now();
    const coalesce =
      !big && now - lastChangeAt < 500 && historyIndex === history.length - 1;

    if (coalesce) {
      history[historyIndex] = value;
    } else {
      history = history.slice(0, historyIndex + 1);
      history.push(value);
      historyIndex = history.length - 1;
      if (history.length > 100) {
        history.shift();
        historyIndex -= 1;
      }
    }

    lastChangeAt = now;
    syncHistory();
  }

  function applyHistory(value: string) {
    version += 1;
    setText(value);
    lastChangeAt = 0;
    const changed = value !== baseline;
    setDirty(changed);
    setStatus(changed ? "Unsaved changes…" : "Saved state");
    persist();
    if (changed) scheduleAutosave();
    syncHistory();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applyHistory(history[historyIndex] ?? "");
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applyHistory(history[historyIndex] ?? "");
  }

  function edit(value: string) {
    if (value === text()) return;
    const big = Math.abs(value.length - text().length) > 20;
    version += 1;
    setText(value);
    recordHistory(value, big);
    setDirty(true);
    setStatus("Unsaved changes…");
    persist();
    scheduleAutosave();
  }

  // Best effort: keep the file being left before switching to another one.
  async function flushCurrent() {
    const target = props.path;
    const content = text();
    if (!target || !dirty()) return;
    // Never flush an empty buffer over a file that had content.
    if (content.length === 0 && baseline.length > 0) return;
    // An unresolved conflict stays unresolved; the user decides.
    if (conflict()) return;

    cancelAutosave();
    try {
      await props.fs.write({
        path: target,
        base: props.base(),
        text: content,
        expected: baseline,
      });
      baseline = content;
      if (text() === content) setDirty(false);
      persist();
    } catch (error) {
      if (isExternalChange(error)) {
        setConflict(true);
        setStatus("The file changed on disk. Reload or Overwrite.");
        return;
      }
      // A failed flush must not block opening another file.
    }
  }

  async function load(target = props.path, base = props.base(), force = false) {
    if (!target) {
      setStatus("Enter a file path first.");
      return;
    }

    // Opening a different file would discard the edits the conflict is about.
    if (conflict() && !force) {
      setStatus("Resolve the change to this file first — Reload or Overwrite.");
      return;
    }

    await flushCurrent();

    // Abandon any pending autosave and stop reporting results for the previous file.
    cancelAutosave();
    const seq = ++fileSeq;
    setBusy(true);
    try {
      // Images, audio and video never enter the textarea: the main process
      // streams the bytes once and the window shows them through a Blob URL.
      const kind = mediaKind(target);
      if (kind) {
        clearMedia();
        const result = await props.fs.readMedia({ path: target, base });
        if (seq !== fileSeq) return;
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(result.data)], { type: mediaMime(target) }),
        );
        mediaUrl = url;
        setMedia({ kind, url, size: result.size });
        setText("");
        baseline = "";
        resetHistory("");
        setDirty(false);
        setConflict(false);
        setPathInput(target);
        version = 0;
        persist();
        rememberRecent(target);
        setStatus(
          `Loaded ${target} — ${kind} preview, ${formatMediaSize(result.size)}`,
        );
        return;
      }

      clearMedia();
      if (
        !isTextPath(target) ||
        !(await props.fs.isText({ path: target, base }))
      ) {
        if (seq === fileSeq)
          setStatus("Not a text file — open it through the normal preview.");
        return;
      }
      const result = await props.fs.read({ path: target, base });
      if (seq !== fileSeq) return;
      setText(result.text);
      setPathInput(target);
      baseline = result.text;
      resetHistory(result.text);
      setDirty(false);
      setConflict(false);
      version = 0;
      persist();
      rememberRecent(target);
      const shape = result.eol === "crlf" ? "CRLF" : "LF";
      setStatus(`Loaded ${target} — ${shape}${result.bom ? " + BOM" : ""}`);
    } catch (error) {
      if (seq === fileSeq) setStatus(`Load failed: ${explain(error)}`);
    } finally {
      if (seq === fileSeq) setBusy(false);
    }
  }

  async function save(auto = false, force = false) {
    if (auto && (!dirty() || conflict())) return;
    // A media preview has no text buffer to write back.
    if (media()) {
      if (!auto) setStatus("This is a media preview; the file is not edited here.");
      return;
    }

    const target = props.path;
    if (!target) {
      if (!auto) setStatus("Enter a file path first.");
      return;
    }

    if (saving) {
      queued = true;
      return;
    }

    const seq = fileSeq;
    const content = text();
    const changed = version;

    // A paste that inserted nothing, then a save, must not erase the file.
    if (auto && content.length === 0 && baseline.length > 0) {
      setStatus("Autosave paused: the file is empty. Ctrl+S saves anyway.");
      return;
    }

    saving = true;
    setBusy(true);
    try {
      const result = force
        ? await props.fs.forceWrite({
            path: target,
            base: props.base(),
            text: content,
          })
        : await props.fs.write({
            path: target,
            base: props.base(),
            text: content,
            expected: baseline,
          });
      if (seq !== fileSeq) return;

      baseline = content;
      setConflict(false);
      persist();
      if (version === changed) {
        setDirty(false);
        cancelAutosave();
        setStatus(auto ? `Autosaved ${stamp()}` : result.message);
      } else {
        setStatus("Unsaved changes…");
        scheduleAutosave();
      }
    } catch (error) {
      if (seq === fileSeq) {
        if (!force && isExternalChange(error)) {
          setConflict(true);
          cancelAutosave();
          setStatus("The file changed on disk. Reload or Overwrite.");
        } else {
          setStatus(`${auto ? "Autosave" : "Save"} failed: ${explain(error)}`);
        }
      }
    } finally {
      saving = false;
      if (seq === fileSeq) setBusy(false);
      if (queued) {
        queued = false;
        scheduleAutosave();
      }
    }
  }

  async function submitPath() {
    const target = pathInput().trim();
    if (!target) return;
    setBusy(true);
    try {
      // `~` and Windows drive rules need the main process; the window has no
      // path module of its own.
      const absolute = await props.fs.resolve({
        path: target,
        base: props.base(),
      });
      props.open(absolute);
    } catch (error) {
      setStatus(`Cannot resolve path: ${explain(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revealFile() {
    try {
      const opened = await props.fs.reveal({
        path: props.path,
        base: props.base(),
      });
      setStatus(
        opened
          ? "Opened the file manager."
          : "Could not open the file manager.",
      );
    } catch (error) {
      setStatus(`Could not open the file manager: ${explain(error)}`);
    }
  }

  // A clean buffer is re-read so changes made while the tab was closed show up;
  // a dirty one is restored so switching tabs never costs typing.
  onMount(() => {
    if (launcher) return;
    const cached = buffers.get(props.path);
    if (cached?.dirty) {
      setText(cached.text);
      baseline = cached.baseline;
      resetHistory(cached.text);
      setDirty(true);
      setStatus("Restored unsaved changes.");
      return;
    }
    void load(props.path, props.base(), true);
  });

  // Closing the panel between a keystroke and the autosave timer must not drop it.
  onCleanup(() => {
    cancelAutosave();
    void flushCurrent();
    clearMedia();
  });

  const primaryView = () => (isTablePath(props.path) ? "table" : "preview");
  const table = createMemo(() =>
    isTablePath(props.path)
      ? parseTable(text(), delimiterFor(props.path))
      : undefined,
  );
  const trail = () => {
    const all = crumbTrail(props.path);
    if (all.length <= 4) return all;
    return [
      all[0]!,
      all[1]!,
      { name: "…", path: "" },
      all[all.length - 2]!,
      all[all.length - 1]!,
    ];
  };
  const menuItems = (): UiMenuEntry[] => [
    { label: "Save file", disabled: !!media(), onSelect: () => void save() },
    {
      label: "Discard changes",
      disabled: !dirty(),
      onSelect: () => void load(props.path, props.base(), true),
    },
    {
      label: "Reload from disk",
      disabled: busy(),
      onSelect: () => void load(props.path, props.base(), true),
    },
    { type: "separator" },
    {
      label: "Copy relative path",
      onSelect: () => {
        void navigator.clipboard.writeText(
          relativeTo(props.base(), props.path),
        );
        setStatus("Copied path.");
      },
    },
    {
      label: "Browse this folder",
      onSelect: () => props.browseFolder(folderOf(props.path)),
    },
    {
      label: "Reveal in file manager",
      onSelect: () => void revealFile(),
    },
    { type: "separator" },
    { label: "Settings…", onSelect: props.openSettings },
  ];

  const cell = {
    padding: "4px 10px",
    "border-bottom":
      "1px solid color-mix(in srgb, currentColor 10%, transparent)",
    "white-space": "nowrap" as const,
  };
  const head = {
    ...cell,
    "text-align": "left" as const,
    "font-weight": "600" as const,
    "font-size": "11.5px",
    "letter-spacing": "0.02em",
    "border-bottom":
      "1px solid color-mix(in srgb, currentColor 20%, transparent)",
  };
  const num = {
    ...cell,
    width: "1%",
    "text-align": "right" as const,
    opacity: "0.45",
    "font-variant-numeric": "tabular-nums" as const,
  };

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "box-sizing": "border-box",
      }}
    >
      <Show
        when={!launcher}
        fallback={
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "10px",
              padding: "10px",
            }}
          >
            <div
              style={{ display: "flex", gap: "6px", "align-items": "center" }}
            >
              <div style={{ flex: "1", "min-width": "0" }}>
                <props.ui.TextInput
                  value={pathInput()}
                  onInput={(value) => setPathInput(value)}
                  label="File path"
                  placeholder="Path, ~/…, or relative to this session"
                  onSubmit={submitPath}
                  class="w-full"
                />
              </div>
              <props.ui.IconButton
                icon="open-file"
                label="Open file"
                onClick={submitPath}
                disabled={busy()}
              />
            </div>
            <div style={{ display: "flex", "align-items": "center" }}>
              <props.ui.Button
                size="small"
                variant="ghost-muted"
                icon="folder"
                onClick={() => props.browseFolder(props.base())}
              >
                Browse files
              </props.ui.Button>
            </div>
            <Show
              when={recent().length > 0}
              fallback={
                <div
                  style={{
                    flex: "1",
                    display: "flex",
                    "flex-direction": "column",
                    "align-items": "center",
                    "justify-content": "center",
                    gap: "10px",
                    "text-align": "center",
                    opacity: "0.7",
                  }}
                >
                  <props.ui.Icon name="open-file" size="large" />
                  <div style={{ "font-size": "13px" }}>
                    Open a file to start editing
                  </div>
                  <div
                    style={{
                      "font-size": "12px",
                      "max-width": "34ch",
                      "line-height": "1.6",
                    }}
                  >
                    Click a file path in chat, or paste one above. Each file
                    opens in its own tab.
                  </div>
                </div>
              }
            >
              <div
                style={{
                  flex: "1",
                  "min-height": "0",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "2px",
                  "overflow-y": "auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "font-size": "11px",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.06em",
                    opacity: "0.5",
                    padding: "2px 4px",
                  }}
                >
                  <span style={{ flex: "1" }}>Recent</span>
                  <props.ui.Button
                    size="small"
                    variant="ghost-muted"
                    onClick={forgetRecent}
                  >
                    Clear
                  </props.ui.Button>
                </div>
                <For each={recent()}>
                  {(path) => (
                    <props.ui.Button
                      variant="ghost"
                      size="small"
                      class="w-full"
                      onClick={() => props.open(path)}
                    >
                      <span
                        style={{
                          display: "flex",
                          gap: "10px",
                          width: "100%",
                          "min-width": "0",
                          "text-align": "left",
                          "align-items": "baseline",
                        }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {basenameOf(path)}
                        </span>
                        <span
                          style={{
                            flex: "1",
                            "min-width": "0",
                            opacity: "0.45",
                            "font-size": "11px",
                            "text-align": "right",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {folderOf(path)}
                        </span>
                      </span>
                    </props.ui.Button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        }
      >
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
            padding: "6px 10px",
            "border-bottom":
              "1px solid color-mix(in srgb, currentColor 12%, transparent)",
          }}
        >
          <div
            style={{
              flex: "1",
              "min-width": "0",
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "font-size": "12px",
              "white-space": "nowrap",
              overflow: "hidden",
            }}
          >
            <For each={trail()}>
              {(crumb, index) => (
                <>
                  <Show when={index() > 0}>
                    <span style={{ opacity: "0.3" }}>›</span>
                  </Show>
                  <Show
                    when={crumb.path !== "" && crumb.path !== props.path}
                    fallback={
                      <span
                        style={{
                          opacity:
                            index() === trail().length - 1 ? "1" : "0.55",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                      >
                        {crumb.name}
                      </span>
                    }
                  >
                    <props.ui.Button
                      size="small"
                      variant="ghost-muted"
                      onClick={() => props.browseFolder(crumb.path)}
                    >
                      {crumb.name}
                    </props.ui.Button>
                  </Show>
                </>
              )}
            </For>
          </div>

          <Show when={isMarkdown(props.path) || isTablePath(props.path)}>
            <div style={{ display: "flex", gap: "2px" }}>
              <props.ui.Button
                size="small"
                variant={view() === primaryView() ? "neutral" : "ghost"}
                onClick={() => setView(primaryView())}
              >
                {primaryView() === "table" ? "Table" : "Preview"}
              </props.ui.Button>
              <props.ui.Button
                size="small"
                variant={view() === "source" ? "neutral" : "ghost"}
                onClick={() => setView("source")}
              >
                Source
              </props.ui.Button>
            </div>
          </Show>

          <Show when={busy()}>
            <props.ui.Loader size="small" />
          </Show>

          <props.ui.Menu label="File actions" items={menuItems()} />
        </div>

        <Show when={conflict()}>
          <div
            style={{
              display: "flex",
              gap: "8px",
              "align-items": "center",
              padding: "8px 10px",
              "border-bottom":
                "1px solid color-mix(in srgb, currentColor 20%, transparent)",
              background: "color-mix(in srgb, currentColor 6%, transparent)",
              "font-size": "12px",
            }}
          >
            <props.ui.Icon name="warning" size="small" />
            <span style={{ flex: "1" }}>
              Changed on disk since you opened it.
            </span>
            <props.ui.Button
              size="small"
              variant="ghost"
              onClick={() => void load(props.path, props.base(), true)}
            >
              Reload
            </props.ui.Button>
            <props.ui.Button
              size="small"
              variant="danger"
              onClick={() => void save(false, true)}
            >
              Overwrite
            </props.ui.Button>
          </div>
        </Show>

        <div
          style={{
            flex: "1",
            display: "flex",
            "min-height": "0",
            position: "relative",
          }}
        >
          <Show when={media()}>
            {(item) => (
              <div
                style={{
                  flex: "1",
                  "min-width": "0",
                  "min-height": "0",
                  display: "flex",
                  "flex-direction": "column",
                  background:
                    "color-mix(in srgb, currentColor 4%, transparent)",
                }}
              >
                <div
                  ref={setImageStage}
                  onDblClick={() => {
                    if (item().kind === "image") setImageView(resetImageView());
                  }}
                  onPointerDown={beginImageDrag}
                  onPointerMove={moveImageDrag}
                  onPointerUp={endImageDrag}
                  onPointerCancel={endImageDrag}
                  onLostPointerCapture={endImageDrag}
                  onAuxClick={(event) => {
                    if (item().kind === "image" && event.button === 1) {
                      event.preventDefault();
                    }
                  }}
                  style={{
                    flex: "1",
                    "min-width": "0",
                    "min-height": "0",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    padding: "14px",
                    position: "relative",
                    overflow: "hidden",
                    cursor: imageDragging()
                      ? "grabbing"
                      : canDrag(imageView())
                        ? "grab"
                        : "default",
                  }}
                >
                  <Show when={item().kind === "image"}>
                    <img
                      src={item().url}
                      alt={basenameOf(props.path)}
                      draggable={false}
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        if (image.src !== media()?.url) return;
                        setImageSourceSize({
                          width: image.naturalWidth,
                          height: image.naturalHeight,
                        });
                      }}
                      style={{
                        // Size the image itself so the browser samples the source
                        // at each zoom, instead of scaling a composited layer.
                        width: imageDimensions() ? `${imageDimensions()!.width}px` : "auto",
                        height: imageDimensions() ? `${imageDimensions()!.height}px` : "auto",
                        "max-width": imageDimensions() ? "none" : "100%",
                        "max-height": imageDimensions() ? "none" : "100%",
                        "flex-shrink": "0",
                        "object-fit": "contain",
                        "image-rendering":
                          (imageDimensions()?.scale ?? 1) >= 2 &&
                          mediaMime(props.path) !== "image/svg+xml" ? "pixelated" : "auto",
                        "border-radius": "4px",
                        "box-shadow": "0 6px 22px #0006",
                        transform: `translate(${imageView().x}px, ${imageView().y}px)`,
                        "user-select": "none",
                      }}
                    />
                    <button
                      type="button"
                      title="Reset zoom and position (double-click the image)"
                      onClick={() => setImageView(resetImageView())}
                      style={{
                        position: "absolute",
                        top: "8px",
                        right: "8px",
                        padding: "2px 8px",
                        "border-radius": "999px",
                        border:
                          "1px solid color-mix(in srgb, currentColor 18%, transparent)",
                        background:
                          "color-mix(in srgb, currentColor 8%, transparent)",
                        color: "inherit",
                        "font-size": "11px",
                        "font-variant-numeric": "tabular-nums",
                        cursor: isMoved(imageView()) ? "pointer" : "default",
                        opacity: isMoved(imageView()) ? "1" : "0.6",
                      }}
                    >
                      {zoomLabel(imageView().zoom)}
                    </button>
                  </Show>
                  <Show when={item().kind === "audio"}>
                    <audio
                      controls
                      autoplay={false}
                      src={item().url}
                      style={{ width: "min(520px, 100%)" }}
                    />
                  </Show>
                  <Show when={item().kind === "video"}>
                    <video
                      controls
                      src={item().url}
                      style={{
                        "max-width": "100%",
                        "max-height": "100%",
                        "border-radius": "4px",
                        "box-shadow": "0 6px 22px #0006",
                      }}
                    />
                  </Show>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    "align-items": "center",
                    padding: "4px 10px",
                    "border-top":
                      "1px solid color-mix(in srgb, currentColor 10%, transparent)",
                    "font-size": "11.5px",
                    opacity: "0.65",
                  }}
                >
                  <span
                    style={{
                      "font-weight": "600",
                      "text-transform": "capitalize",
                    }}
                  >
                    {item().kind}
                  </span>
                  <span
                    style={{
                      flex: "1",
                      "min-width": "0",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {basenameOf(props.path)}
                  </span>
                  <Show when={item().kind === "image"}>
                    <span
                      style={{
                        "flex-shrink": "1",
                        "min-width": "0",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                        opacity: "0.8",
                      }}
                    >
                      Ctrl+scroll zoom · middle-drag to pan · Shift+scroll sideways ·
                      scroll up/down
                    </span>
                  </Show>
                  <span style={{ "flex-shrink": "0" }}>
                    {formatMediaSize(item().size)}
                  </span>
                </div>
              </div>
            )}
          </Show>

          <Show when={!media() && view() === "source"}>
            <SourceEditor
              colorScheme={props.colorScheme}
              path={props.path}
              value={text}
              wordWrap={wordWrap}
              lineNumbers={lineNumbers}
              edit={edit}
              save={() => void save()}
              undo={undo}
              redo={redo}
            />
          </Show>

          <Show when={!media() && view() === "preview"}>
            <div
              style={{
                flex: "1",
                "min-height": "0",
                "overflow-y": "auto",
                padding: "10px 12px",
              }}
            >
              {props.ui.Markdown({ text: text() })}
            </div>
          </Show>

          <Show when={!media() && view() === "table" && table()}>
            <div style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
              <table
                style={{
                  "border-collapse": "collapse",
                  width: "100%",
                  "font-size": "12.5px",
                }}
              >
                <thead>
                  <tr>
                    <th style={num}>#</th>
                    <For each={table()!.header}>
                      {(value) => <th style={head}>{value}</th>}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={table()!.rows}>
                    {(row, index) => (
                      <tr
                        style={{
                          background:
                            index() % 2 === 0
                              ? undefined
                              : "color-mix(in srgb, currentColor 3%, transparent)",
                        }}
                      >
                        <td style={num}>{index() + 1}</td>
                        <For each={row}>
                          {(value) => <td style={cell}>{value}</td>}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={table()!.truncated}>
                <div
                  style={{
                    padding: "8px 10px",
                    "font-size": "11.5px",
                    opacity: "0.6",
                  }}
                >
                  Showing the first {table()!.rows.length} rows.
                </div>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={status()}>
          <div
            style={{
              display: "flex",
              gap: "6px",
              "align-items": "center",
              padding: "4px 10px",
              "border-top":
                "1px solid color-mix(in srgb, currentColor 10%, transparent)",
              "font-size": "11.5px",
              opacity: "0.6",
            }}
          >
            <Show when={dirty()}>
              <span style={{ color: "var(--color-warning, #d19a3f)" }}>●</span>
            </Show>
            <span
              style={{
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {status()}
            </span>
          </div>
        </Show>
      </Show>
    </div>
  );
}

const RAIL_MIN = 150;
const RAIL_MAX = 520;
const RAIL_WIDTH_KEY = "file-editor:tree-rail-width";

function clampRailWidth(width: number) {
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(width)));
}

function readRailWidth() {
  try {
    const width = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(width) && width > 0) return clampRailWidth(width);
  } catch {
    // The host width can still seed the rail when storage is unavailable.
  }
}

const [railWidth, setRailWidth] = createSignal(readRailWidth());

/**
 * The workspace rail sits beside every tab, so the tree stays while files switch.
 * Use the host's open state and initial width. After resizing, keep the tree's
 * own width so the host's sidebar minimum does not limit the tree.
 */
function Workspace(props: {
  ui: Ui;
  panel: PanelFrame;
  sessionKey: string;
  file: Files;
  active: string;
  open: (path: string) => void;
  create: (path: string, kind: "file" | "folder") => Promise<void>;
  listDirectory: (path: string) => Promise<readonly Entry[]>;
  createName: (kind: "file" | "folder") => Promise<string | undefined>;
  confirmDelete: (path: string) => Promise<boolean>;
  copy: (path: string, target: string) => Promise<void>;
  move: (path: string, target: string) => Promise<void>;
  rename: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** Reads one dropped file in the window and writes it through the main process. */
  importFile: (folder: string, file: File) => Promise<{ path: string; name: string }>;
  children: JSX.Element;
}) {
  const sidebar = () => (props.panel as Partial<PanelFrame>).sidebar;
  const opened = () => sidebar()?.opened?.() ?? railFallbackOpen();
  const width = () =>
    railWidth() ?? clampRailWidth(sidebar()?.width?.() ?? 240);
  const toggle = () => {
    const shared = sidebar();
    if (shared?.toggle) shared.toggle();
    else setRailFallbackOpen((value) => !value);
  };

  let drag: { x: number; width: number } | undefined;

  function finishRailResize() {
    if (!drag) return;
    const changed = width() !== drag.width;
    drag = undefined;
    if (!changed) return;
    try {
      localStorage.setItem(RAIL_WIDTH_KEY, String(width()));
    } catch {
      // The chosen width still applies across tabs until the app reloads.
    }
  }

  // Files dragged in from Explorer/Finder land here. The host listens for
  // `drop` on `document` and would otherwise attach them to the AI prompt, so
  // every handler below stops propagation before the event reaches it.
  const [dropActive, setDropActive] = createSignal(false);
  const [dropFolder, setDropFolder] = createSignal<string | undefined>();
  const [dropNote, setDropNote] = createSignal("");
  const [dropError, setDropError] = createSignal(false);
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function announce(text: string, error = false) {
    clearTimeout(noteTimer);
    setDropNote(text);
    setDropError(error);
    noteTimer = setTimeout(() => setDropNote(""), error ? 9000 : 5000);
  }

  async function copyDropped(
    folder: string,
    files: readonly File[],
    folders: readonly string[] = [],
  ) {
    let copied = 0;
    const failed: string[] = [];
    if (folders.length) {
      failed.push(
        `Folders cannot be copied by drop yet (${folders.join(", ")}).`,
      );
    }
    for (const file of files) {
      try {
        await props.importFile(folder, file);
        copied += 1;
      } catch (error) {
        failed.push(`${file.name}: ${explain(error)}`);
      }
    }

    try {
      const entries = await props.listDirectory(folder);
      storeDirectoryListing(
        folder,
        entries.map((entry) => childEntry(folder, entry)),
      );
      await props.file.tree.sync(folder, { force: true });
      if (folder) props.file.tree.expand(folder, { list: false });
    } catch (error) {
      failed.push(
        `Could not refresh ${folder || "the workspace"}: ${explain(error)}`,
      );
    }

    if (failed.length) {
      const lead = copied
        ? `Copied ${copied} file${copied === 1 ? "" : "s"}. `
        : "";
      announce(`${lead}${failed.join("; ")}`, true);
    } else if (copied) {
      announce(
        `Copied ${copied} file${copied === 1 ? "" : "s"} to ${
          folder || "the workspace root"
        }.`,
      );
    }
  }

  onCleanup(() => clearTimeout(noteTimer));

  // A drag that ends outside the panel (Escape, leaving the window) never
  // reaches our drop handler; clear the overlay from the window instead.
  onMount(() => {
    const clear = () => {
      setDropActive(false);
      setDropFolder(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape);
    onCleanup(() => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
    });
  });

  return (
    <div
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        // Hiding the prompt's overlay here is what keeps it from sitting over
        // the chat while the files are actually headed for the workspace.
        if (!dropActive()) clearHostDrop();
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        if (!dropActive()) clearHostDrop();
        setDropActive(true);
        setDropFolder(folderAtPoint(event.clientX, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!dropActive()) return;
        event.preventDefault();
        event.stopPropagation();
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        // A file drag often reports no relatedTarget; the point still tells us
        // whether the pointer merely crossed into a child.
        const under = document.elementFromPoint(event.clientX, event.clientY);
        if (under && event.currentTarget.contains(under)) return;
        setDropActive(false);
        setDropFolder(undefined);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        // Stop here: the host also listens on `document` and would attach the
        // same files to the AI prompt. Stopping it also skips the host's own
        // cleanup, so tell it the drag is over.
        event.preventDefault();
        event.stopPropagation();
        clearHostDrop();
        const folder = folderAtPoint(event.clientX, event.clientY) ?? "";
        const { files, folders } = droppedFiles(event);
        setDropActive(false);
        setDropFolder(undefined);
        if (files.length || folders.length) void copyDropped(folder, files, folders);
      }}
      style={{
        position: "relative",
        display: "flex",
        height: "100%",
        "min-height": "0",
        "box-sizing": "border-box",
      }}
    >
      <div
        style={{
          flex: "1",
          "min-width": "0",
          "min-height": "0",
          display: "flex",
          "flex-direction": "column",
        }}
      >
        {props.children}
      </div>

      <Show when={props.panel.placement?.() !== "mobile"}>
        <Show
          when={opened()}
          fallback={
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                "align-items": "center",
                gap: "6px",
                padding: "4px 3px",
                "flex-shrink": "0",
                "border-left":
                  "1px solid color-mix(in srgb, currentColor 10%, transparent)",
              }}
            >
              <props.ui.IconButton
                icon="file-tree"
                label="Show files"
                size="small"
                onClick={toggle}
              />
            </div>
          }
        >
          <div
            role="separator"
            aria-orientation="vertical"
            title="Resize file tree"
            style={{
              width: "5px",
              "flex-shrink": "0",
              cursor: "col-resize",
              "user-select": "none",
              "touch-action": "none",
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              drag = { x: event.clientX, width: width() };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              setRailWidth(clampRailWidth(drag.width + drag.x - event.clientX));
            }}
            onPointerUp={(event) => {
              finishRailResize();
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={finishRailResize}
          />
          <div
            style={{
              width: `${width()}px`,
              "flex-shrink": "0",
              display: "flex",
              "flex-direction": "column",
              "min-height": "0",
              "border-left":
                "1px solid color-mix(in srgb, currentColor 10%, transparent)",
            }}
          >
            <TreeRail
              ui={props.ui}
              sessionKey={props.sessionKey}
              file={props.file}
              active={props.active}
              open={props.open}
              create={props.create}
              listDirectory={props.listDirectory}
              createName={props.createName}
              confirmDelete={props.confirmDelete}
              copy={props.copy}
              move={props.move}
              rename={props.rename}
              remove={props.remove}
              toggle={toggle}
              dropTarget={() => dropFolder()}
              visible={() => props.panel.visible()}
            />
          </div>
        </Show>
      </Show>

      <Show when={dropActive()}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            "z-index": "40",
            "pointer-events": "none",
            display: "flex",
            "align-items": "flex-end",
            "justify-content": "flex-start",
            padding: "10px",
            // Light enough that the highlighted folder row underneath stays
            // readable; the dashed frame still marks the drop area.
            background:
              "color-mix(in srgb, var(--background-strong, #111) 22%, transparent)",
            border:
              "2px dashed color-mix(in srgb, currentColor 35%, transparent)",
          }}
        >
          <span
            style={{
              padding: "5px 10px",
              "border-radius": "8px",
              background: "var(--background-strong, #252525)",
              border:
                "1px solid color-mix(in srgb, currentColor 22%, transparent)",
              "box-shadow": "0 8px 22px #0008",
              "font-size": "11.5px",
            }}
          >
            {dropFolder()
              ? `Copy into ${dropFolder()}`
              : "Copy into the workspace root"}
          </span>
        </div>
      </Show>

      <Show when={dropNote()}>
        <div
          role={dropError() ? "alert" : "status"}
          style={{
            position: "absolute",
            right: "10px",
            bottom: "10px",
            "z-index": "41",
            "max-width": "min(420px, 80%)",
            padding: "7px 11px",
            "border-radius": "8px",
            background: "var(--background-strong, #252525)",
            border:
              "1px solid color-mix(in srgb, currentColor 22%, transparent)",
            "box-shadow": "0 8px 22px #0008",
            "font-size": "11.5px",
            "overflow-wrap": "anywhere",
          }}
        >
          {dropNote()}
        </div>
      </Show>
    </div>
  );
}

function TreeRail(props: {
  ui: Ui;
  sessionKey: string;
  file: Files;
  active: string;
  open: (relative: string) => void;
  toggle: () => void;
  /** Folder a file drag from outside the window is currently over, if any. */
  dropTarget?: () => string | undefined;
  /** False while another tab is selected; only the visible rail searches. */
  visible: () => boolean;
  create: (path: string, kind: "file" | "folder") => Promise<void>;
  listDirectory: (path: string) => Promise<readonly Entry[]>;
  createName: (kind: "file" | "folder") => Promise<string | undefined>;
  confirmDelete: (path: string) => Promise<boolean>;
  copy: (path: string, target: string) => Promise<void>;
  move: (path: string, target: string) => Promise<void>;
  rename: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}) {
  const [results, setResults] = createSignal<readonly string[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchError, setSearchError] = createSignal("");
  const [rootError, setRootError] = createSignal("");
  const [rootBusy, setRootBusy] = createSignal(false);
  const [rootLoaded, setRootLoaded] = createSignal(false);
  const [highlight, setHighlight] = createSignal<string>();
  const [creating, setCreating] = createSignal(false);
  const [clipboard, setClipboard] = createSignal<{ path: string; cut: boolean }>();
  const [context, setContext] = createSignal<{ path: string; anchor: DOMRect }>();
  // The row a click or right-click selected, which F2 and Delete act on.
  const [selectedPath, setSelectedPath] = createSignal<string>();
  // Pointer drag state: the item being carried, the pointer offset inside the
  // rail, and the folder under the pointer (if any).
  const [dragging, setDragging] = createSignal<{
    path: string;
    name: string;
    x: number;
    y: number;
    over?: string;
  }>();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let seq = 0;
  let press: { path: string; name: string; x: number; y: number } | undefined;
  let suppressClickUntil = 0;
  let listElement: HTMLDivElement | undefined;
  // The query this rail last asked the server about. Hidden tabs keep their
  // results; a tab that becomes visible catches up on the shared filter.
  let built = "";

  const activeRelative = () =>
    props.active ? relativeTo(props.file.root, props.active) : "";
  const searchingNow = () => railQuery().trim().length > 0;
  // The first result is ready to open before the pointer moves.
  const picked = () => {
    const value = highlight();
    return value && results().includes(value) ? value : results()[0];
  };

  // Read the listed folders and their expansion on every render, so a toggle, a
  // finished load or a filesystem change updates the rows. The listing store is
  // module-level, so a remount keeps every child in place.
  const tree = createMemo(() => {
    directoriesTick();
    return flattenTree(
      (path) => {
        const listed = directoryListings.get(path);
        if (listed) return listed;
        return (props.file.tree.list(path) ?? []).map((node) =>
          childEntry(path, {
            name: node.name,
            dir: node.type === "directory",
            ignored: node.ignored,
          }),
        );
      },
      (path) => props.file.tree.state(path)?.expanded === true,
      (path) => props.file.tree.state(path),
    );
  });

  async function loadDirectory(folder: string) {
    const entries = await props.listDirectory(folder);
    storeDirectoryListing(
      folder,
      entries.map((entry) => childEntry(folder, entry)),
    );
  }

  // A folder the host reopened or a remount after opening a tab can leave an
  // expanded folder without our listing; fill it from the filesystem instead of
  // trusting the host's partial tree cache.
  createEffect(() => {
    directoriesTick();
    const expanded = tree().rows
      .filter((row) => row.dir && row.expanded)
      .map((row) => row.path);
    for (const folder of ["", ...expanded]) {
      if (directoryListings.has(folder) || loadingDirectories.has(folder)) continue;
      loadingDirectories.add(folder);
      void loadDirectory(folder)
        .catch(() => undefined)
        .finally(() => loadingDirectories.delete(folder));
    }
  });

  async function loadRoot(force = false) {
    setRootBusy(true);
    try {
      await loadDirectory("");
      await props.file.tree.sync("", force ? { force: true } : undefined);
      setRootError("");
      setRootLoaded(true);
    } catch (error) {
      setRootError(explain(error));
    } finally {
      setRootBusy(false);
    }
  }

  function searchFor(text: string) {
    clearTimeout(timer);
    controller?.abort();
    seq += 1;
    setHighlight(undefined);
    setSearchError("");
    setResults([]);
    if (!text) {
      setSearching(false);
      return;
    }

    setSearching(true);
    const run = seq;
    timer = setTimeout(() => {
      const request = new AbortController();
      controller = request;
      void props.file
        .search(text, { kind: "file", limit: 200, signal: request.signal })
        .then((paths) => {
          if (run !== seq) return;
          setResults(paths);
          setSearching(false);
        })
        .catch((error) => {
          if (run !== seq || request.signal.aborted) return;
          setResults([]);
          setSearching(false);
          setSearchError(explain(error));
        });
    }, 120);
  }

  function changeQuery(value: string) {
    setRailQuery(value);
  }

  // Every open tab keeps its render mounted; only the selected one searches.
  createEffect(() => {
    const key = `${props.file.root}\n${railQuery().trim()}`;
    if (!props.visible()) return;
    if (key === built) return;
    built = key;
    searchFor(railQuery().trim());
  });

  async function toggleFolder(row: TreeRow) {
    if (row.expanded) {
      props.file.tree.collapse(row.path);
      const path = selectedPath();
      if (path && isInsideTreePath(path, row.path)) setSelectedPath(undefined);
      return;
    }

    // List the folder ourselves before expanding: the host's tree cache has
    // been observed to miss children, and the filesystem is authoritative.
    try {
      await loadDirectory(row.path);
      props.file.tree.expand(row.path, { list: false });
      setRootError("");
    } catch (error) {
      setRootError(`Could not open folder ${row.path}: ${explain(error)}`);
    }
  }

  function choose(path: string | undefined) {
    if (path) props.open(path);
  }

  function focusList() {
    queueMicrotask(() => {
      if (props.visible()) listElement?.focus({ preventScroll: true });
    });
  }

  async function createEntry(kind: "file" | "folder") {
    const label = kind === "file" ? "file" : "folder";
    let name: string | undefined;
    try {
      name = await props.createName(kind);
    } catch (error) {
      setRootError(`Could not open create dialog: ${explain(error)}`);
      return;
    }
    if (name === undefined) return;
    const clean = name.trim();
    if (!clean || clean === "." || clean === "..") {
      setRootError(`Enter a valid ${label} name.`);
      return;
    }
    setCreating(true);
    try {
      await props.create(clean, kind);
      setRootError("");
      await refreshTree(clean);
      setRootLoaded(true);
    } catch (error) {
      setRootError(`Could not create ${label}: ${explain(error)}`);
    } finally {
      setCreating(false);
    }
  }

  // The tree stores workspace-relative paths; the clipboard wants the full one,
  // with the separator the platform already uses for the workspace root.
  function absoluteTreePath(path: string) {
    const full = canonicalPath(path, props.file.root);
    return props.file.root.includes("\\") ? full.replace(/\//g, "\\") : full;
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(absoluteTreePath(path));
      setRootError("");
    } catch (error) {
      setRootError(`Could not copy path: ${explain(error)}`);
    }
  }

  async function itemAction(
    action: "cut" | "copy" | "rename" | "delete" | "copy-path",
    path: string,
  ) {
    try {
      if (action === "copy-path") {
        await copyPath(path);
        return;
      }
      if (action === "cut" || action === "copy") {
        setClipboard({ path, cut: action === "cut" });
        return;
      }
      if (action === "rename") await props.rename(path);
      else if (await props.confirmDelete(path)) await props.remove(path);
      else return;
      setSelectedPath(undefined);
      await refreshTree(path);
    } catch (error) {
      setRootError(`Could not ${action}: ${explain(error)}`);
    }
  }

  async function refreshFolder(folder: string) {
    await loadDirectory(folder);
    await props.file.tree.sync(folder, { force: true });
  }

  async function refreshTree(path: string) {
    const folders = new Set<string>([""]);
    const parts = path.split(/[\\/]/).slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    }
    await Promise.all([...folders].map((folder) => refreshFolder(folder)));
  }

  async function refreshExpanded() {
    const expanded = tree().rows.filter((row) => row.dir && row.expanded).map((row) => row.path);
    await Promise.all(["", ...expanded].map((folder) => refreshFolder(folder)));
  }

  async function pasteEntry(source: string, destination = "") {
    const pending = clipboard();
    if (!pending) return;
    const name = pending.path.split(/[\\/]/).at(-1) ?? pending.path;
    const target = destination ? `${destination}/${name}` : name;
    try {
      if (pending.cut) await props.move(pending.path, target);
      else await props.copy(pending.path, target);
      if (pending.cut) setClipboard(undefined);
      await refreshTree(source);
      if (destination) await refreshTree(destination);
      setRootError("");
    } catch (error) {
      setRootError(`Could not paste: ${explain(error)}`);
    }
  }

  function clearPress() {
    press = undefined;
    window.removeEventListener("pointermove", onWindowPointerMove, true);
    window.removeEventListener("pointerup", onWindowPointerUp, true);
    window.removeEventListener("pointercancel", onWindowPointerUp, true);
  }

  function onWindowPointerMove(event: PointerEvent) {
    if (!press) return;
    if (
      !dragging() &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6
    ) {
      return;
    }
    const rect = listElement?.getBoundingClientRect();
    const over = folderAtPoint(event.clientX, event.clientY);
    setDragging({
      path: press.path,
      name: press.name,
      x: rect ? event.clientX - rect.left : event.clientX,
      y: rect ? event.clientY - rect.top : event.clientY,
      over:
        over && over !== press.path && !over.startsWith(`${press.path}/`)
          ? over
          : undefined,
    });
    event.preventDefault();
  }

  function onWindowPointerUp(event: PointerEvent) {
    const started = press;
    const moved = dragging();
    clearPress();
    setDragging(undefined);
    // A press without movement is a click: let it open the file or toggle.
    if (!started || !moved) return;
    // The row's click fires right after pointerup; a drag must not also open it.
    suppressClickUntil = Date.now() + 500;
    const folder = folderAtPoint(event.clientX, event.clientY);
    if (!folder || folder === started.path || folder.startsWith(`${started.path}/`)) {
      return;
    }
    void moveInto(started.path, folder);
  }

  function beginPress(event: PointerEvent, row: TreeRow) {
    if (event.button !== 0) return;
    // Drop listeners left behind by a press that ended outside the window.
    clearPress();
    // Do not update reactive selection or focus the list during pointerdown:
    // either can replace the row/button before its click event fires.
    press = { path: row.path, name: row.name, x: event.clientX, y: event.clientY };
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("pointercancel", onWindowPointerUp, true);
  }

  async function moveInto(source: string, folder: string) {
    const name = source.split(/[\\/]/).at(-1) ?? source;
    setRootBusy(true);
    try {
      // Read the destination first so a name collision is resolved against the
      // real contents, not a stale or missing listing.
      await loadDirectory(folder).catch(() => undefined);
      const target = `${folder}/${freeEntryName(
        (directoryListings.get(folder) ?? []).map((entry) => entry.name),
        name,
      )}`;
      await props.move(source, target);
      await refreshTree(source);
      await refreshTree(target);
      props.file.tree.expand(folder, { list: false });
      setRootError("");
    } catch (error) {
      setRootError(`Could not move ${name}: ${explain(error)}`);
    } finally {
      setRootBusy(false);
    }
  }

  function contextItems(path: string): UiMenuEntry[] {
    const pending = clipboard();
    if (!path) {
      return pending
        ? [{ label: "Paste here", icon: "download", onSelect: () => void pasteEntry("", "") }]
        : [{ label: "Create file", icon: "file-document", onSelect: () => void createEntry("file") }, { label: "Create folder", icon: "folder-add-left", onSelect: () => void createEntry("folder") }];
    }
    return [
      { label: "Cut", icon: "edit", onSelect: () => void itemAction("cut", path) },
      { label: "Copy", icon: "copy", onSelect: () => void itemAction("copy", path) },
      ...(pending
        ? [{ label: "Paste here", icon: "download" as const, onSelect: () => void pasteEntry(path, path) }]
        : []),
      { type: "separator" },
      { label: "Copy path", icon: "copy", onSelect: () => void itemAction("copy-path", path) },
      { label: "Rename", icon: "edit-small-2", onSelect: () => void itemAction("rename", path) },
      { label: "Delete", icon: "close", onSelect: () => void itemAction("delete", path) },
    ];
  }

  function onFilterKeyDown(event: KeyboardEvent) {
    if (!searchingNow()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      changeQuery("");
      return;
    }
    const files = results();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(
        nextItem(
          files,
          highlight(),
          event.key === "ArrowDown" ? 1 : -1,
        ),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(picked());
    }
  }

  // Each mounted tab listens on window. Only the visible rail can act on keys.
  function onTreeShortcutKeyDown(event: KeyboardEvent) {
    if (!props.visible() || searchingNow() || context()) return;
    const action = treeShortcut(event.key, {
      shift: event.shiftKey,
      alt: event.altKey,
    });
    if (!action) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "input, textarea, [contenteditable='true'], [data-tree-shortcuts='ignore']",
      )
    ) {
      return;
    }
    const path = selectedPath();
    if (!path) return;
    if (!tree().rows.some((row) => row.path === path)) {
      setSelectedPath(undefined);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void itemAction(action, path);
  }

  // The workspace root changes when a session moves; reload its first level.
  createEffect(
    on(
      () => props.file.root,
      () => {
        setSelectedPath(undefined);
        void loadRoot();
      },
    ),
  );

  createEffect(() => {
    const selection = pendingRailSelection();
    if (
      !selection ||
      !props.visible() ||
      selection.sessionKey !== props.sessionKey ||
      selection.root !== props.file.root ||
      !sameTreePath(selection.path, activeRelative())
    ) {
      return;
    }
    setSelectedPath(selection.path);
    setPendingRailSelection(undefined);
    focusList();
  });

  // Escape closes the context menu wherever focus sits. Capture runs before
  // the host can treat Escape as "close the panel".
  onMount(() => {
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !props.visible() || !context()) return;
      event.preventDefault();
      event.stopPropagation();
      setContext(undefined);
    };
    const shortcuts = (event: KeyboardEvent) =>
      onTreeShortcutKeyDown(event);
    window.addEventListener("keydown", closeMenu, true);
    window.addEventListener("keydown", shortcuts);
    onCleanup(() => {
      window.removeEventListener("keydown", closeMenu, true);
      window.removeEventListener("keydown", shortcuts);
    });
  });

  onCleanup(() => {
    clearTimeout(timer);
    controller?.abort();
    clearPress();
  });

  const note = (text: string, error = false) => (
    <div
      role={error ? "alert" : "status"}
      style={{
        padding: "8px 10px",
        "font-size": "11.5px",
        opacity: error ? "0.9" : "0.6",
      }}
    >
      {text}
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "min-height": "0",
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "4px",
          "align-items": "center",
          padding: "4px 6px",
          "border-bottom":
            "1px solid color-mix(in srgb, currentColor 10%, transparent)",
        }}
      >
        <span
          title={props.file.root}
          style={{
            flex: "1",
            "min-width": "0",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
            "font-size": "12px",
            "font-weight": "600",
          }}
        >
          {basenameOf(props.file.root) || props.file.root}
        </span>
        <props.ui.IconButton
          icon="outline-rotate-clockwise"
          label="Refresh files"
          size="small"
          busy={rootBusy()}
          onClick={() => {
            setRootBusy(true);
            void refreshExpanded()
              .then(() => setRootError(""))
              .catch((error) => setRootError(explain(error)))
              .finally(() => setRootBusy(false));
          }}
        />
        <props.ui.IconButton
          icon="file-document"
          label="Create file"
          size="small"
          busy={creating()}
          disabled={creating() || searchingNow()}
          onClick={() => void createEntry("file")}
        />
        <props.ui.IconButton
          icon="folder-add-left"
          label="Create folder"
          size="small"
          busy={creating()}
          disabled={creating() || searchingNow()}
          onClick={() => void createEntry("folder")}
        />
        <props.ui.IconButton
          icon="chevron-right"
          label="Hide file tree"
          size="small"
          onClick={props.toggle}
        />
      </div>

      <div style={{ padding: "6px" }} onKeyDown={onFilterKeyDown}>
        <props.ui.TextInput
          value={railQuery()}
          onInput={changeQuery}
          onSubmit={() => choose(picked())}
          label="Filter files in this workspace"
          placeholder="Filter files"
          type="search"
          class="w-full"
        />
      </div>

      <div
        data-tree-list="true"
        tabindex={0}
        ref={(element) => {
          listElement = element;
        }}
        style={{
          position: "relative",
          flex: "1",
          "min-height": "0",
          "overflow-y": "auto",
          padding: "2px 4px 8px",
          outline: "none",
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setContext(undefined);
            setSelectedPath(undefined);
          }
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            setSelectedPath(undefined);
            setContext({ path: "", anchor: new DOMRect(event.clientX, event.clientY) });
          }
        }}
      >
        <Show
          when={searchingNow()}
          fallback={
            <>
              <Show when={rootBusy() && tree().rows.length === 0}>
                {note("Loading…")}
              </Show>
              <Show when={rootError()}>
                {note(`Could not read this workspace: ${rootError()}`, true)}
              </Show>
              <Show
                when={rootLoaded() && !rootError() && tree().rows.length === 0}
              >
                {note("This workspace has no files.")}
              </Show>
              <For each={tree().rows}>
                {(row) => {
                  const selected = () =>
                    !row.dir && sameTreePath(row.path, activeRelative());
                  const chosen = () => selectedPath() === row.path;
                  const cut = () => clipboard()?.cut && clipboard()?.path === row.path;
                  // A folder that a desktop file drag is hovering. Kept apart
                  // from `dragging()` (which is this panel's own pointer drag)
                  // so the two highlights cannot overwrite each other.
                  const externalTarget = () =>
                    row.dir && props.dropTarget?.() === row.path;
                  return (
                    <div
                      data-tree-row={row.dir ? "folder" : "file"}
                      data-tree-path={row.path}
                      ref={(element) => {
                        // Capture phase: the button inside may call
                        // preventDefault on pointerdown, which would cancel a
                        // native drag before dragstart ever fires. Owning the
                        // pointer here keeps dragging available regardless.
                        element.addEventListener(
                          "pointerdown",
                          (event) => beginPress(event, row),
                          true,
                        );
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedPath(row.path);
                        focusList();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setContext({ path: row.path, anchor: bounds });
                      }}
                      style={{
                        // A folder receiving a desktop drop is lifted above the
                        // dimming overlay so the destination stays crisp.
                        position: externalTarget() ? "relative" : undefined,
                        "z-index": externalTarget() ? "41" : undefined,
                        background: externalTarget()
                          ? "color-mix(in srgb, var(--color-folder, #d9a441) 20%, transparent)"
                          : dragging()?.over === row.path
                            ? "color-mix(in srgb, currentColor 18%, transparent)"
                            : chosen()
                              ? "color-mix(in srgb, currentColor 15%, transparent)"
                              : selected()
                                ? "color-mix(in srgb, currentColor 9%, transparent)"
                                : undefined,
                        "box-shadow": chosen()
                          ? "inset 2px 0 0 color-mix(in srgb, currentColor 45%, transparent)"
                          : undefined,
                        outline: externalTarget()
                          ? "1px solid color-mix(in srgb, var(--color-folder, #d9a441) 70%, transparent)"
                          : dragging()?.over === row.path
                            ? "1px dashed color-mix(in srgb, currentColor 45%, transparent)"
                            : undefined,
                        "border-radius": "6px",
                        "transition":
                          "background 90ms ease, outline-color 90ms ease",
                        opacity:
                          cut() || dragging()?.path === row.path ? "0.38" : undefined,
                        "filter": cut() ? "grayscale(0.65)" : undefined,
                        "user-select": "none",
                      }}
                    >
                      <props.ui.Button
                        variant="ghost"
                        size="small"
                        class="w-full"
                        onClick={() => {
                          if (Date.now() < suppressClickUntil) return;
                          if (row.dir) {
                            setSelectedPath(row.path);
                            focusList();
                            void toggleFolder(row);
                            return;
                          }
                          setPendingRailSelection({
                            sessionKey: props.sessionKey,
                            root: props.file.root,
                            path: row.path,
                          });
                          choose(row.path);
                        }}
                      >
                        <span
                          style={{
                            display: "flex",
                            gap: "6px",
                            width: "100%",
                            "min-width": "0",
                            "align-items": "center",
                            "text-align": "left",
                            "padding-left": `${row.depth * 12}px`,
                            opacity: row.ignored ? "0.45" : undefined,
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              width: "14px",
                              "flex-shrink": "0",
                              opacity: "0.6",
                            }}
                          >
                            <Show when={row.dir}>
                              <props.ui.Icon
                                name={
                                  row.expanded
                                    ? "chevron-down"
                                    : "chevron-right"
                                }
                                size="small"
                              />
                            </Show>
                          </span>
                          <span
                            style={{
                              display: "flex",
                              "flex-shrink": "0",
                              // Folders read as amber, files stay neutral.
                              color: row.dir
                                ? "var(--color-folder, #d9a441)"
                                : undefined,
                            }}
                          >
                            <props.ui.Icon
                              name={row.dir ? "folder" : "file-document"}
                              size="small"
                            />
                          </span>
                          <span
                            style={{
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                              "font-weight": row.dir ? "600" : undefined,
                            }}
                          >
                            {row.name}
                          </span>
                          <Show when={externalTarget()}>
                            <span
                              style={{
                                "margin-left": "auto",
                                "flex-shrink": "0",
                                padding: "1px 6px",
                                "border-radius": "999px",
                                "font-size": "10px",
                                "line-height": "1.5",
                                "white-space": "nowrap",
                                color: "var(--color-folder, #d9a441)",
                                background:
                                  "color-mix(in srgb, var(--color-folder, #d9a441) 18%, transparent)",
                                border:
                                  "1px solid color-mix(in srgb, var(--color-folder, #d9a441) 50%, transparent)",
                              }}
                            >
                              Drop here
                            </span>
                          </Show>
                          <Show when={row.loading}>
                            <span style={{ "font-size": "11px", opacity: "0.5" }}>
                              …
                            </span>
                          </Show>
                        </span>
                      </props.ui.Button>
                    </div>
                  );
                }}
              </For>
              <Show when={tree().truncated}>
                {note(`Showing the first ${tree().rows.length} entries.`)}
              </Show>
            </>
          }
        >
          <Show when={searching()}>{note("Searching…")}</Show>
          <Show when={searchError()}>
            {note(`Search failed: ${searchError()}`, true)}
          </Show>
          <Show when={!searching() && !searchError() && results().length === 0}>
            {note(`No files match “${railQuery().trim()}”.`)}
          </Show>
          <For each={results()}>
            {(path) => {
              const selected = () => picked() === path;
              return (
                <div
                  style={{
                    background: selected()
                      ? "color-mix(in srgb, currentColor 10%, transparent)"
                      : undefined,
                    "border-radius": "6px",
                  }}
                  onMouseEnter={() => setHighlight(path)}
                >
                  <props.ui.Button
                    variant="ghost"
                    size="small"
                    class="w-full"
                    onClick={() => choose(path)}
                  >
                    <span
                      style={{
                        display: "flex",
                        gap: "8px",
                        width: "100%",
                        "min-width": "0",
                        "align-items": "baseline",
                        "text-align": "left",
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {basenameOf(path)}
                      </span>
                      <span
                        style={{
                          flex: "1",
                          "min-width": "0",
                          opacity: "0.45",
                          "font-size": "11px",
                          "text-align": "right",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {folderOfTreePath(path)}
                      </span>
                    </span>
                  </props.ui.Button>
                </div>
              );
            }}
          </For>
        </Show>
        <Show when={dragging()}>
          {(item) => (
            <div
              style={{
                position: "absolute",
                left: `${item().x + 12}px`,
                top: `${item().y + 6}px`,
                "z-index": "30",
                "pointer-events": "none",
                padding: "3px 8px",
                "border-radius": "6px",
                background: "var(--background-strong, #252525)",
                border:
                  "1px solid color-mix(in srgb, currentColor 22%, transparent)",
                "box-shadow": "0 6px 18px #0008",
                "font-size": "12px",
                "white-space": "nowrap",
                "max-width": "220px",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {item().name}
              <Show when={item().over}>
                <span style={{ opacity: "0.6" }}>{` → ${item().over}`}</span>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <Show when={context()} keyed>
        {(menu) => (
          <>
            <div
              style={{ position: "absolute", inset: "0", "z-index": "1000" }}
              onClick={(event) => {
                if (event.target === event.currentTarget) setContext(undefined);
              }}
              onContextMenu={(event) => { event.preventDefault(); setContext(undefined); }}
            />
            <div
              ref={(element) => {
                queueMicrotask(() => {
                  const layer = element.offsetParent;
                  if (!element.isConnected || !(layer instanceof HTMLElement)) return;
                  // Measure in viewport coordinates, then convert to the workspace
                  // layer's coordinates. The desktop host can offset or scale it.
                  const bounds = layer.getBoundingClientRect();
                  const origin = element.getBoundingClientRect();
                  const scaleX = bounds.width / layer.offsetWidth;
                  const scaleY = bounds.height / layer.offsetHeight;
                  if (!scaleX || !scaleY) return;

                  const { anchor, path } = menu;
                  const { width, height } = origin;
                  const gap = path ? 4 : 0;
                  const minX = Math.max(0, bounds.left) + 4;
                  const minY = Math.max(0, bounds.top) + 4;
                  const maxX = Math.min(window.innerWidth, bounds.right) - width - 4;
                  const maxY = Math.min(window.innerHeight, bounds.bottom) - height - 4;
                  let x = anchor.right + gap;
                  let y = anchor.top;
                  if (x > maxX) {
                    const left = anchor.left - width - gap;
                    if (left >= minX) {
                      x = left;
                    } else {
                      x = anchor.left;
                      y = anchor.bottom + gap;
                      if (y > maxY) y = anchor.top - height - gap;
                    }
                  }
                  x = Math.max(minX, Math.min(x, maxX));
                  y = Math.max(minY, Math.min(y, maxY));
                  element.style.left = `${(x - origin.left) / scaleX}px`;
                  element.style.top = `${(y - origin.top) / scaleY}px`;
                  element.style.visibility = "visible";
                });
              }}
              style={{
                position: "absolute",
                left: "0",
                top: "0",
                visibility: "hidden",
                "z-index": "1001",
                padding: "4px",
                background: "var(--background-strong, #252525)",
                border: "1px solid color-mix(in srgb, currentColor 15%, transparent)",
                "border-radius": "8px",
                "box-shadow": "0 8px 24px #0008",
                width: "max-content",
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <For each={contextItems(menu.path)}>
                {(item) => item.type === "separator" ? (
                  <div style={{ height: "1px", margin: "4px 2px", background: "currentColor", opacity: "0.15" }} />
                ) : (
                  <button
                    type="button"
                    style={{ display: "block", width: "100%", padding: "5px 12px", border: "0", "border-radius": "4px", background: "transparent", color: "inherit", "font": "inherit", "font-size": "12px", "text-align": "left", "white-space": "nowrap", cursor: "pointer" }}
                    onPointerEnter={(event) => { event.currentTarget.style.background = "color-mix(in srgb, currentColor 10%, transparent)"; }}
                    onPointerLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                    onClick={() => {
                      if (item.label === "Paste here") {
                        const targetRow = tree().rows.find((row) => row.path === menu.path);
                        const destination = targetRow?.dir
                          ? menu.path
                          : menu.path.includes("/")
                            ? menu.path.slice(0, menu.path.lastIndexOf("/"))
                            : "";
                        void pasteEntry(menu.path, destination);
                      }
                      else if (item.label === "Create file") void createEntry("file");
                      else if (item.label === "Create folder") void createEntry("folder");
                      else if (item.label === "Cut") void itemAction("cut", menu.path);
                      else if (item.label === "Copy") void itemAction("copy", menu.path);
                      else if (item.label === "Copy path") void itemAction("copy-path", menu.path);
                      else if (item.label === "Rename") void itemAction("rename", menu.path);
                      else if (item.label === "Delete") void itemAction("delete", menu.path);
                      setContext(undefined);
                    }}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

export default Plugin.define({
  i18n: {
    en: {
      title: "Workspace",
      command: "Open workspace",
      menu: "Workspace",
    },
  },
  setup(ctx) {
    console.log("[file-editor] gui v64");
    const fs = ctx.main(Fs);

    ctx.add(Panel, {
      id: "editor",
      region: "side",
      // `wide` is the supported ask for the wider session minimum; `width` was
      // never part of Panel and was silently ignored.
      wide: true,
      // Relative and absolute ids are the same file; rewrite them to one form.
      normalize: ({ id, session }) => {
        if (!id.startsWith("file:")) return id;
        return tabId(
          canonicalPath(id.slice("file:".length), session.directory),
        );
      },
      list: (input) => {
        // Subscribed so a dirty dot appears without reopening the panel.
        tick();

        const tabs: PanelTab[] = [
          {
            id: LAUNCHER,
            title: "Open file",
            closable: false,
            transient: true,
            pinned: true,
          },
        ];

        try {
          for (const id of input.open) {
            if (!id.startsWith("file:")) continue;
            const path = pathFromId(id, input.session.directory);
            const dirty = buffers.get(path)?.dirty ?? false;
            tabs.push({
              id,
              title: dirty ? `${basenameOf(path)} ●` : basenameOf(path),
              file: relativeTo(input.session.directory, path),
              closable: "compact",
            });
          }

          if (input.open.includes(BROWSER)) {
            tabs.push({
              id: BROWSER,
              title: basenameOf(browsePath()) || "Browse",
              closable: "compact",
            });
          }
        } catch (error) {
          // One unreadable id from stored state must not take the strip with it;
          // the panel would stop rendering and the app would look hung.
          console.error("[file-editor] could not list tabs", error);
          return [tabs[0]!];
        }

        return tabs;
      },
      render: (props) => {
        const panel = usePanel();
        const active = props.tab.id.startsWith("file:")
          ? pathFromId(props.tab.id, props.session.directory)
          : "";
        const openFile = (target: string) => {
          // The rail names workspace-relative paths; a tab is keyed by the
          // absolute file so the same file is one tab from every entry point.
          const absolute = canonicalPath(target, props.screen.file.root);
          rememberRecent(absolute);
          ctx.layout.open(tabKey(absolute), props.session, { tab: "select" });
        };

        // A render error must stay inside the panel. Without a boundary it
        // reaches the host and takes the window with it, which is what a crash
        // report looks like from the outside: no message, nothing to send.
        return (
          <ErrorBoundary
            fallback={(error, reset) => (
              <div
                role="alert"
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "8px",
                  padding: "14px",
                  "font-size": "12px",
                  "overflow-wrap": "anywhere",
                }}
              >
                <span style={{ "font-weight": "600" }}>
                  The file editor hit an error.
                </span>
                <span style={{ opacity: "0.7", "white-space": "pre-wrap" }}>
                  {String(error)}
                </span>
                <ctx.ui.Button size="small" onClick={() => reset()}>
                  Try again
                </ctx.ui.Button>
              </div>
            )}
          >
            <Workspace
              ui={ctx.ui}
              panel={panel}
              sessionKey={props.session.key}
              file={props.screen.file}
              active={active}
              open={openFile}
              create={async (path, kind) => {
                const input = { path, base: props.screen.file.root };
                if (kind === "file") await fs.createFile(input);
                else await fs.createFolder(input);
              }}
              listDirectory={async (path) => {
                const result = await fs.list({ path, base: props.screen.file.root });
                return result.entries;
              }}
              importFile={async (folder, file) => {
                if (file.size > MAX_IMPORT_BYTES) throw new Error("IMPORT_TOO_LARGE");
                const data = new Uint8Array(await file.arrayBuffer());
                return fs.importFile({
                  folder,
                  base: props.screen.file.root,
                  name: file.name || "dropped-file",
                  data,
                });
              }}
              createName={(kind) => ctx.dialogs.prompt({
                title: kind === "file" ? "Create file" : "Create folder",
                description: "The item will be created in the workspace root.",
                placeholder: kind === "file" ? "filename.ext" : "folder-name",
                submit: "Create",
              })}
              confirmDelete={(path) => ctx.dialogs.confirm({
                title: "Delete this item?",
                description: `${path} will be permanently deleted.`,
                confirm: "Delete",
                danger: true,
              })}
              copy={async (path, target) => {
                await fs.copyEntry({ path, target, base: props.screen.file.root });
              }}
              move={async (path, target) => {
                await fs.moveEntry({ path, target, base: props.screen.file.root });
              }}
              rename={async (path) => {
                const name = await ctx.dialogs.prompt({
                  title: "Rename",
                  description: path,
                  value: path.split(/[\\/]/).at(-1) ?? path,
                  submit: "Rename",
                });
                if (!name) return;
                const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                const target = parent ? `${parent}/${name}` : name;
                await fs.moveEntry({ path, target, base: props.screen.file.root });
              }}
              remove={async (path) => {
                await fs.deleteEntry({ path, base: props.screen.file.root });
              }}
            >
        {props.tab.id === BROWSER ? (
                <Browser
                  fs={fs}
                  ui={ctx.ui}
                  start={() => browsePath() || props.session.directory}
                  open={openFile}
                />
              ) : (
                <Editor
                  colorScheme={ctx.appearance.mode()}
                  fs={fs}
                  base={() => props.session.directory}
                  path={pathFromId(props.tab.id, props.session.directory)}
                  open={openFile}
                  browseFolder={(target) => {
                    setBrowsePath(target);
                    ctx.layout.open(keyFor(BROWSER), props.session, {
                      tab: "select",
                    });
                  }}
                  openSettings={() =>
                    ctx.dialogs.open((dialog) => (
                      <ctx.ui.Dialog
                        title="Editor settings"
                        description="Applies to every open file."
                        footer={
                          <ctx.ui.Button onClick={() => dialog.close()}>
                            Done
                          </ctx.ui.Button>
                        }
                      >
                        <div
                          style={{
                            display: "flex",
                            "flex-direction": "column",
                            gap: "14px",
                          }}
                        >
                          <ctx.ui.Switch
                            label="Line numbers"
                            checked={lineNumbers()}
                            onChange={setLineNumbers}
                          />
                          <ctx.ui.Switch
                            label="Word wrap"
                            checked={wordWrap()}
                            onChange={setWordWrap}
                          />
                          <ctx.ui.Switch
                            label="Auto save"
                            description="Saves after a pause. Ctrl+S always saves."
                            checked={autoSave()}
                            onChange={setAutoSave}
                          />
                        </div>
                      </ctx.ui.Dialog>
                    ))
                  }
                  ui={ctx.ui}
                />
              )}
            </Workspace>
          </ErrorBoundary>
        );
      },
    });

    // `side.toggle` flips the region, and the + menu lives inside the region, so
    // toggling from there closed the pane instead of showing the panel. Both
    // entries now select a tab; only the keybind still closes what it shows.
    const stateOf = (session: SessionRef, id: string) =>
      ctx.layout.state(keyFor(id), session);

    const editorVisible = (session: SessionRef) =>
      ctx.layout.stored(session).some((id) => stateOf(session, id) === "visible");

    const showEditor = (session: SessionRef) => {
      const stored = ctx.layout.stored(session);
      if (stored.length === 0) {
        // Nothing stored yet: the launcher tab is transient, so it is never
        // stored itself and must be opened explicitly.
        ctx.layout.open(keyFor(LAUNCHER), session, { tab: "select" });
        return;
      }
      const shown = pickShown(stored, (id) => stateOf(session, id));
      if (!shown) return;
      ctx.layout.open(keyFor(shown), session, { tab: "select" });
    };

    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();

      return {
        menu: "session.panel",
        id: "editor",
        title: ctx.t("menu"),
        icon: "file-tree",
        opened:
          !!session &&
          ctx.layout
            .stored(session)
            .some((id) => ctx.layout.state(keyFor(id), session) !== "closed"),
        run: () => {
          const current = ctx.sessions.current();
          // The menu asks for the panel; closing it here is what the click
          // appeared to do. Leave it on screen once it is there.
          if (!current || editorVisible(current)) return;
          showEditor(current);
        },
      };
    });

    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("command"),
      bind: "mod+shift+e",
      slash: { name: "workspace" },
      run: () => {
        const session = ctx.sessions.current();
        if (!session) return;
        // A keybind is a toggle, so it may close the panel. It must not close a
        // region that is showing another panel, which is what it did before.
        if (editorVisible(session)) {
          ctx.layout.side.toggle(session);
          return;
        }
        showEditor(session);
      },
    }));

    // Clicking a file path in chat opens it in its own tab.
    ctx.add(LinkHandler, {
      priority: 1000,
      match: (link) =>
        isFileLink(link) &&
        (isTextPath(link.href) || mediaKind(link.href) !== undefined),
      exists: async (link) => {
        try {
          return await fs.exists({
            path: hrefPath(link.href),
            base: linkBase(link, ctx.sessions.current()?.directory ?? ""),
          });
        } catch {
          // An older main process may not provide `exists`; still offer the link.
          return true;
        }
      },
      open: (link) => {
        const session = ctx.sessions.current();
        if (!session) return;
        const path = canonicalPath(
          hrefPath(link.href),
          linkBase(link, session.directory),
        );
        ctx.layout.open(tabKey(path), session, { tab: "select" });
      },
    });
  },
  main(ctx) {
    ctx.log.write("info", "file-editor main process ready");

    ctx.provide(Fs, {
      read: async ({ path, base }) => readTextFile(resolvePath(path, base)),
      readMedia: async ({ path, base }) =>
        readMediaFile(resolvePath(path, base)),
      write: async ({ path, base, text, expected }) =>
        writeTextFile(resolvePath(path, base), text, expected),
      forceWrite: async ({ path, base, text }) =>
        writeTextFile(resolvePath(path, base), text, null),
      resolve: async ({ path, base }) => resolvePath(path, base),
      reveal: async ({ path, base }) => {
        const target = resolvePath(path, base);
        try {
          const [command, args] = revealCommand(process.platform, target);
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return true;
        } catch {
          return false;
        }
      },
      list: async ({ path, base }) => {
        const folder = resolvePath(path, base);
        const entries = await readdir(folder, { withFileTypes: true });
        return limitEntries(
          sortEntries(
            entries.map((entry) => ({
              name: entry.name,
              dir: entry.isDirectory(),
            })),
          ),
        );
      },
      exists: async ({ path, base }) => {
        try {
          await stat(resolvePath(path, base));
          return true;
        } catch {
          return false;
        }
      },
      createFile: async ({ path, base }) => {
        await createFile(resolveWorkspacePath(path, base));
        return true;
      },
      createFolder: async ({ path, base }) => {
        await createFolder(resolveWorkspacePath(path, base));
        return true;
      },
      copyEntry: async ({ path, target, base }) => {
        await copyEntry(resolveWorkspacePath(path, base), resolveWorkspacePath(target, base));
        return true;
      },
      moveEntry: async ({ path, target, base }) => {
        await moveEntry(resolveWorkspacePath(path, base), resolveWorkspacePath(target, base));
        return true;
      },
      deleteEntry: async ({ path, base }) => {
        await deleteEntry(resolveWorkspacePath(path, base));
        return true;
      },
      isText: async ({ path, base }) =>
        isTextFile(resolvePath(path, base)),
      importFile: async ({ folder, base, name, data }) =>
        importFile(base, folder, name, data),
    });
  },
});
