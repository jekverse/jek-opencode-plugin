# jek-opencode-plugin

This repository contains two OpenCode plugins. Each plugin is loaded separately from the same checkout.

| Plugin shown in OpenCode | What it does | Entry point |
| --- | --- | --- |
| `jek-exploler` | Adds a workspace file explorer, editor tabs, and image, audio, and video previews. | `index.ts` at the repository root |
| `jek-savefromclipboard` | Keeps chat image attachments visible, saves their original bytes locally, and provides `save_attached_image` to copy an attached image to a requested folder. | `jek-savefromclipboard/index.ts` |

The image storage directory on Windows is `%USERPROFILE%\.local\share\opencode\pasted-images`. See [EXPLORER.md](EXPLORER.md) for the Explorer feature guide and credits to the original file editor project.

## Install on Windows

In PowerShell, clone the repository and build the Explorer GUI.

```powershell
git clone https://github.com/jekverse/jek-opencode-plugin.git "$env:USERPROFILE\.config\opencode\plugins\jek-opencode-plugin"
npm --prefix "$env:USERPROFILE\.config\opencode\plugins\jek-opencode-plugin" ci
npm --prefix "$env:USERPROFILE\.config\opencode\plugins\jek-opencode-plugin" run build
```

Add both directory paths to the `plugins` array in `%USERPROFILE%\.config\opencode\opencode.json`. Replace `<user>` with your Windows username and preserve any other plugins already in the array.

```json
{
  "plugins": [
    "C:\\Users\\<user>\\.config\\opencode\\plugins\\jek-opencode-plugin",
    "C:\\Users\\<user>\\.config\\opencode\\plugins\\jek-opencode-plugin\\jek-savefromclipboard"
  ]
}
```

Restart OpenCode. The Extensions → Plugins menu should list `jek-exploler` and `jek-savefromclipboard`.

If you previously installed this repository, replace the old `image-clipboard` path in `opencode.json` with `jek-savefromclipboard`. The `save_attached_image` tool name stays the same.

## Add another plugin

Create a directory with its own `index.ts`, add that directory to the `plugins` array, and document it here. The Explorer entry point and build files live at the repository root.