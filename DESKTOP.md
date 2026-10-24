# Receipt Studio portable app

The files to share are in `release/`. Transfer just the file for the recipient's platform. Recipients do not need the project folder, Node.js, npm, or a running server.

| Platform | File | How to use it |
| --- | --- | --- |
| Windows, 64-bit | `Receipt-Studio-Portable-Windows.exe` | Double-click to open the native desktop app. No installer or administrator access is required. |
| Mac, Intel or Apple Silicon | `Receipt-Studio-Portable-Mac.html` | Double-click, or use **Open With** to open it in a current desktop browser such as Chrome, Edge, or Safari. This is the offline browser edition. |

Both editions open HTML, HTM, MHTML, and MHT receipts; edit details and preview changes; and export the edited receipt in the same format. Choose **Browse files** to start. The Windows app uses native Open and Save dialogs. The HTML edition uses the browser's file picker and downloads folder. Neither edition uploads receipts.

The app itself works offline. Receipt images or styles that exist only on a remote website are not bundled with a receipt; use MHTML receipts with embedded resources when those assets must be available offline.

The Windows EXE temporarily extracts its bundled runtime when opened. It can be kept on a USB drive, and may leave normal application preferences and cache files in the Windows user profile. It is unsigned, so Windows may show an unknown-publisher or SmartScreen prompt.

## Rebuild the portable files

Install build dependencies with `npm ci` using Node.js 22.13 or newer. On Windows, run:

```sh
npm run desktop:portable
```

This rebuilds both the Windows EXE and the single-file HTML edition from the current editor. Build-tool caches stay in `.cache/` inside the project unless the corresponding Electron cache environment variables are already set. The first build needs internet access to download packaging tools; using the finished app does not.

Individual builds:

```sh
npm run desktop:build:win
npm run desktop:standalone
```

`desktop:standalone` works on Windows, macOS, and Linux, and produces the same self-contained HTML file. Despite its Mac filename, that file also works in a Windows desktop browser.

## Optional native Mac app

The native Mac edition is separate from the HTML edition. Build it **on a Mac**:

```sh
npm ci
npm run desktop:build:mac
```

This produces `release/Receipt-Studio-Portable-Mac.dmg` containing a universal **Receipt Studio.app** for Intel and Apple Silicon. Transfer the DMG, open it on the recipient's Mac, and open Receipt Studio. The app can also be copied to a writable folder or Applications for repeated use.

Windows cannot produce this native DMG with the included Electron build tools. The included `.github/workflows/desktop-build.yml` uses Windows and macOS runners to build the native editions when manually started or when a `v*` version tag is pushed to a connected GitHub repository. Local builds do not publish automatically.

Native Mac builds are unsigned by default. Signing and notarization require an Apple Developer ID on macOS; unsigned Mac apps may require approval in **System Settings > Privacy & Security**. The single-file HTML edition does not require Mac app signing.

## Development

```sh
npm run desktop:dev
```

The desktop edition shares the editor's React interface and adds native file dialogs, an application menu, and single-instance behavior.
