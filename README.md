# Jek OpenCode Plugins

This repository collects OpenCode plugins maintained for Jekverse. Each plugin has its own entry point and can be loaded independently.

## Plugins

### Explorer

The repository root is the Explorer plugin. It adds a workspace file tree, editor tabs, media previews, and file management tools to OpenCode Desktop.

Entry point: `index.ts` and `gui-experimental.cjs`

Guide: [EXPLORER.md](EXPLORER.md)

### Image Clipboard

The `image-clipboard` plugin saves images attached to chat to a persistent local folder, preserves the image attachment in the conversation, and exposes `save_attached_image` for copying the current attachment to a requested folder.

Entry point: `image-clipboard/index.ts`

Storage: `%USERPROFILE%\.local\share\opencode\pasted-images`

## Install locally

Add both plugin paths to `%USERPROFILE%\.config\opencode\opencode.json`:

```json
{
  "plugins": [
    "C:\\Users\\<user>\\.config\\opencode\\plugins\\jek-opencode-plugin",
    "C:\\Users\\<user>\\.config\\opencode\\plugins\\jek-opencode-plugin\\image-clipboard"
  ]
}
```

Restart OpenCode after changing plugin files or configuration.

## Adding a plugin

Create a new subdirectory with its own entry point, add it to the `plugins` array, and document it here. Keep Explorer's root entry point and build files at the repository root.
