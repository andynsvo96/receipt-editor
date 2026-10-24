# Receipt Studio / Receipt Editor

A local receipt editor for HTML, HTM, MHTML, and MHT documents. Open a receipt, review its detected fields, edit the document beside a live preview, and export the result in the same format.

This repository preserves the current application source, dependency lockfile, desktop packaging scripts, build workflow, and rebuilding instructions. Downloaded source still needs dependencies installed and a build step to produce the portable app.

## Features

- Open receipt files through drag and drop, a browser file picker, or native desktop dialogs; files are limited to 20 MB.
- Detect common receipt labels and line-item tables, with a dedicated scanner for Stripe receipt layouts and clear import-status messages for other layouts.
- Edit detected fields, line items, payment details, and ordinary receipt text directly in the preview.
- Recalculate receipt totals after item changes and review payment allocations before exporting. Payment amounts remain a separate, intentional edit.
- Reorder compatible receipt sections using drag handles or keyboard arrows, and add notes, address blocks, amounts, or custom properties.
- Undo and redo up to 60 editing steps, restore removed properties, and download a JSON change log.
- Download the untouched original or export the edited receipt after review and balance checks.
- Preserve embedded MHTML resources and common MIME transfer encodings. The preview blocks external resources; exported receipts retain their original resource references.
- Share the React editor across the web application, an Electron desktop app, and a self-contained offline HTML edition.

Some editing operations depend on the imported receipt structure. Review the preview and import status for unfamiliar layouts. The native Mac build and the offline HTML edition are different deliverables.

## Restore after deleting the local source

1. Sign in to GitHub and open this repository.
2. Choose **Code > Download ZIP**, then extract it into a new folder. Alternatively, copy the repository's clone URL from **Code** and clone it with Git.
3. Install Node.js 22.13 or newer, including npm.
4. Open a terminal in the extracted project folder and run:

   ```sh
   npm ci
   ```

5. Choose a development or build command below.

Dependency installation and the first native packaging run require internet access. The finished desktop and single-file HTML editions run without a development server. On Windows, if PowerShell blocks `npm.ps1`, use `npm.cmd` in place of `npm`.

The source backup does not include receipt documents, exported receipts, installed dependencies, or compiled app binaries. Keep any documents or finished apps you want separately before deleting a local folder. The original local Git history is intentionally omitted from this privacy-reviewed source snapshot.

## Run and build

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the web editor through Vinext/Vite. |
| `npm run build` | Build the web application. |
| `npm run start` | Serve a built web application locally. |
| `npm run desktop:dev` | Start the Electron app and its renderer development server. |
| `npm run desktop:standalone` | Build `release/Receipt-Studio-Portable-Mac.html`, a single-file browser edition that also works on Windows. |
| `npm run desktop:build:win` | Build the native Windows portable EXE on Windows. |
| `npm run desktop:portable` | On Windows, build both the portable EXE and the single-file HTML edition. |
| `npm run desktop:build:mac` | On macOS, build the native universal DMG for Intel and Apple Silicon. |

See [DESKTOP.md](DESKTOP.md) for distribution details, platform requirements, unsigned-app behavior, and optional native Mac packaging. Generated deliverables are written to `release/` and are excluded from source control.

The [desktop build workflow](.github/workflows/desktop-build.yml) can be started manually in GitHub Actions or by pushing a `v*` version tag. It builds on Windows and macOS and uploads workflow artifacts; it does not automatically create a GitHub Release. Workflow artifacts have limited retention and should not be treated as the permanent source backup.

## Checks

```sh
npm run lint
npx tsc --noEmit --incremental false
npm run desktop:standalone
npm run build
```

[TESTING.md](TESTING.md) describes manual compatibility, export, payment reconciliation, inline editing, section reordering, and source-fidelity checks. Use synthetic or anonymized documents for testing.

## Source layout

| Path | Responsibility |
| --- | --- |
| `app/page.tsx` | Upload flow, editor controls, preview overlays, undo/redo, and exports. |
| `app/lib/receipt.ts` | HTML/MHTML parsing, field and section detection, edits, totals, embedded-resource previews, and serialization. |
| `app/globals.css` | Shared interface styles. |
| `app/layout.tsx` | Web document layout and application metadata. |
| `desktop/main.cjs` | Electron window, native dialogs, file handling, menu, and single-instance behavior. |
| `desktop/preload.cjs` | Restricted bridge between the renderer and native file dialogs. |
| `desktop/renderer.tsx` | Desktop entry point for the shared editor. |
| `desktop/build*.cjs` | Native packaging and single-file HTML generation. |
| `vite.config.ts` | Vinext web build with Cloudflare/Sites integration. |
| `vite.desktop.config.ts` | Desktop renderer build. |
| `.github/workflows/desktop-build.yml` | Optional Windows and macOS build automation. |

## Privacy and backup contents

Receipt contents are processed locally in the editor. The preview uses a restrictive content policy and blocks external resources. Embedded images and styles in MHTML can be displayed offline; assets that were never embedded are not downloaded or bundled by the editor. Editing history lives in the current session and is not a document backup.

The initial repository snapshot contains reviewed source and documentation only. Personal receipts, customer records, exports, screenshots, credentials, environment files, machine-specific tooling folders, build outputs, and local caches are excluded. Third-party contact details in optional funding and deprecation metadata are removed from the dependency lockfile; dependency versions, integrity hashes, resolution URLs, and deprecation warnings are preserved. The initial commit uses a generic project name and email rather than a personal author identity.

`.openai/hosting.json` is a neutral configuration with no original deployment project identifier or service bindings. Local development and desktop builds do not require that identifier. A future Sites deployment needs its own project configuration.

The ignore rules help prevent accidental inclusion of receipt documents and credentials. Review future changes before committing: ignore rules cannot detect sensitive information pasted into an existing source file or remove a file that is already tracked.
