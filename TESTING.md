# Receipt compatibility test matrix

## Portable app checks

1. Run `npm run desktop:portable` on Windows, then copy only the EXE or HTML artifact from `release/` into an otherwise empty folder.
2. Disconnect from the network. Launch the copied Windows EXE, or open the copied HTML edition in a desktop browser, without starting a development server.
3. Import an HTML receipt and an MHTML receipt with embedded images. Confirm the preview, edit an item, undo and redo, and export the receipt.
4. Reopen each edited export and verify that the changes and embedded resources survived. Confirm **Download original** preserves the source exactly.
5. In the native Windows edition, check both the Browse/Open and Save dialogs, cancel each dialog once, and confirm editing can continue.
6. On a Mac, repeat the browser-edition checks in the recipient's browser. Build and check the optional universal DMG on macOS separately; a Windows smoke test does not validate a native Mac app.

## Receipt fixtures

Use anonymized copies only. For every fixture, confirm that the live preview is readable, the detected details are correct, the original download is byte-for-byte the source file, and the edited export can be reopened.

| Fixture | Variations to cover | Expected result |
| --- | --- | --- |
| Stripe HTML | One item; multiple items; discount; tax; shipping | Items, total, payment, and common receipt details are detected. |
| Generic HTML table | `Item`/`Description` plus `Amount`/`Line total`; totals in a second table | Common labels and line items are detected; import state explains any gaps. |
| MHTML quoted-printable | Embedded CSS and images; customer names with accents | Preview preserves embedded assets; export reopens successfully. |
| MHTML base64 | Dollar amounts; non-ASCII text and symbols | Export uses Unicode-safe encoding and reopens successfully. |
| Partial receipt | No item table or payment details | Import status is `Partial import`; manual properties are available; no unsafe edit is implied. |
| Unsupported layout | Receipt with no familiar labels | Import status is `Manual review needed`; preview and original download remain available. |
| Safety case | Script tags, event handlers, frames, malformed MIME headers | Active content and malformed files are rejected with a clear message. |

## Reconciliation checks

1. Change a line-item amount and confirm that the receipt total changes while the payment remains unchanged.
2. Update the payment amount intentionally and confirm the balance becomes zero before export is enabled.
3. Add and remove a session-created payment row; confirm that source payment rows cannot be removed.
4. Open the downloaded edited file again and verify its totals, preview, and change log.

## Section reordering checks

1. Hover a detected section in the live preview and drag its small overlay grip above or below another section.
2. Confirm the receipt moves immediately and the matching controls in the editor follow the new layout order.
3. Focus the blue handle and use the Up and Down arrow keys to confirm keyboard reordering.
4. Drag the matching row in the left-side Layout sections list and confirm both surfaces stay synchronized.
5. Undo and redo the move, then export and reopen the edited receipt to confirm the new order is preserved.

## Inline preview editing checks

1. Click a detected value and ordinary receipt copy in the preview, edit it in the overlay control, then save.
2. Confirm the matching left-side field updates when one exists and that item/payment amounts still recalculate correctly.
3. Press Escape or Cancel to dismiss an edit and confirm the source text is unchanged.
4. Export and reopen the receipt to confirm preview edits remain while overlay controls are never included in the file.
5. Compare the untouched preview with the source receipt and confirm the overlay does not change spacing, columns, or block dimensions.

## Source fidelity checks

1. Open the source receipt directly in a desktop browser window wider than 600 px and capture a reference image.
2. Open the same receipt in Receipt Studio and confirm the 600 px email body uses the same desktop layout, spacing, typography, colors, and embedded artwork.
3. Confirm the preview grows to the receipt's full height without introducing an internal vertical scrollbar.
4. For MHTML fixtures, verify that both `Content-Location` and `Content-ID` (`cid:`) styles and images render locally.
5. Hover, click, and cancel an edit without saving; confirm the receipt pixels return to the untouched reference state.
