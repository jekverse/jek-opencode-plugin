import { Plugin } from "@opencode/plugin"
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const STORAGE_DIR = join(homedir(), ".local/share/opencode/pasted-images")

const DATA_URL_REGEX = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
])

const NUDGE = `The user has attached one or more images. Each image is represented by a marker like [Image: /path/to/file.png]. When asked to copy the attached image to a folder, call save_attached_image directly. The original attachment is still present.`

type FileAttachment = {
  uri?: string
  mime?: string
  name?: string
  [key: string]: unknown
}

function extensionFromMime(mimeType: string): string {
  const lowered = mimeType.toLowerCase()
  if (lowered === "image/jpeg") return "jpg"
  if (lowered === "image/svg+xml") return "svg"
  const slash = lowered.indexOf("/")
  if (slash === -1) return "bin"
  return lowered.slice(slash + 1).replace(/[^a-z0-9.+-]/gi, "") || "bin"
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/")
}

function extFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return filePath.slice(dot + 1).toLowerCase()
}

function isImageUri(uri: string): boolean {
  if (uri.startsWith("data:")) {
    const match = DATA_URL_REGEX.exec(uri)
    if (match) {
      const mime = (match[1] || "").toLowerCase()
      return mime.startsWith("image/")
    }
    return false
  }
  if (uri.startsWith("file:")) {
    try {
      const path = fileURLToPath(uri)
      return IMAGE_EXTENSIONS.has(extFromPath(path))
    } catch {
      return false
    }
  }
  return IMAGE_EXTENSIONS.has(extFromPath(uri))
}

function parseDataUrl(uri: string): { mimeType: string; bytes: Buffer } | null {
  const match = DATA_URL_REGEX.exec(uri)
  if (!match) return null
  const mimeType = (match[1] || "application/octet-stream").toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ""
  if (!mimeType.startsWith("image/")) return null
  try {
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8")
    return { mimeType, bytes }
  } catch {
    return null
  }
}

async function uriToPath(uri: string, storageDir: string): Promise<string | null> {
  // data: URL → save to storage
  if (uri.startsWith("data:")) {
    const parsed = parseDataUrl(uri)
    if (!parsed) return null
    await mkdir(storageDir, { recursive: true })
    const ts = Date.now()
    const rand = Math.random().toString(36).slice(2, 8)
    const ext = extensionFromMime(parsed.mimeType)
    const filePath = join(storageDir, `paste-${ts}-${rand}.${ext}`)
    await writeFile(filePath, parsed.bytes)
    return filePath
  }

  // file: URL → resolve path
  if (uri.startsWith("file:")) {
    try {
      const sourcePath = fileURLToPath(uri)
      if (!existsSync(sourcePath)) return null
      if (dirname(sourcePath) === resolve(storageDir)) return sourcePath
      // Copy temp / dragged files into persistent storage so they are not lost.
      await mkdir(storageDir, { recursive: true })
      const bytes = await readFile(sourcePath)
      const ext = extFromPath(sourcePath) || "bin"
      const ts = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      const filePath = join(storageDir, `paste-${ts}-${rand}.${ext}`)
      await writeFile(filePath, bytes)
      return filePath
    } catch {
      return null
    }
  }

  // Plain path
  if (existsSync(uri)) {
    if (dirname(uri) === resolve(storageDir)) return uri
    try {
      await mkdir(storageDir, { recursive: true })
      const bytes = await readFile(uri)
      const ext = extFromPath(uri) || "bin"
      const ts = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      const filePath = join(storageDir, `paste-${ts}-${rand}.${ext}`)
      await writeFile(filePath, bytes)
      return filePath
    } catch {
      return null
    }
  }

  return null
}

export default Plugin.define({
  id: "jek-savefromclipboard",
  async setup(ctx) {
    const sessionsWithImages = new Set<string>()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "save_attached_image",
        description: "Save an image from the latest user message to the requested absolute folder. Use directly for image copy requests without loading a skill or running shell commands.",
        input: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Existing absolute destination folder requested by the user" },
            imageIndex: { type: "integer", minimum: 1, description: "One-based attachment index when the user identifies one of several images" },
          },
          required: ["directory"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { directory, imageIndex } = input as { directory: string; imageIndex?: number }
          if (typeof directory !== "string" || !isAbsolute(directory)) {
            return { content: "Provide an absolute destination folder." }
          }
          const messages = await ctx.session.context({ sessionID: context.sessionID })
          const message = messages.findLast((entry) => entry.type === "user")
          const paths = message?.metadata?.["image-clipboard.paths"]
          if (!Array.isArray(paths) || paths.length === 0) {
            return { content: "No image file was captured for the latest user message. Ask the user to attach the image again." }
          }
          if (paths.length > 1 && imageIndex === undefined) {
            return { content: "Several images are attached. Ask which image to save if the user has not identified it." }
          }
          const source = paths[(imageIndex ?? 1) - 1]
          if (typeof source !== "string" || dirname(source) !== resolve(STORAGE_DIR)) {
            return { content: "No captured image matches the requested attachment." }
          }
          const destination = resolve(directory, basename(source))
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "edit",
            resources: [destination],
            save: [destination],
          })
          if (!(await stat(directory).catch(() => null))?.isDirectory()) {
            return { content: "The destination folder does not exist or cannot be accessed." }
          }
          try {
            await copyFile(source, destination, constants.COPYFILE_EXCL)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              return { content: "Destination already exists. Existing file was left intact: " + destination }
            }
            throw error
          }
          return { content: "Image saved to " + destination }
        },
      })
    })

    await ctx.session.hook("prompt", async (event) => {
      const files = (event.prompt.files ?? []) as FileAttachment[]
      if (files.length === 0) return

      const markers: string[] = []
      const paths: (string | null)[] = []

      for (const file of files) {
        const uri = file.uri
        if (!uri || !isImageUri(uri)) {
          continue
        }

        const path = await uriToPath(uri, STORAGE_DIR)
        paths.push(path)
        if (!path) {
          continue
        }

        markers.push(`[Image: ${path}]`)
      }

      if (markers.length === 0) return
      event.metadata = { ...event.metadata, "image-clipboard.paths": paths }

      event.prompt.text = `${event.prompt.text}\n\n${markers.join("\n")}`.trim()
      sessionsWithImages.add(event.sessionID)
    })

    await ctx.session.hook("context", async (event) => {
      if (!sessionsWithImages.has(event.sessionID)) return
      event.system.push({ type: "text", text: NUDGE })
      sessionsWithImages.delete(event.sessionID)
    })
  },
})
