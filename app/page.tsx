'use client';

import { ChangeEvent, DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addBlock,
  addItem,
  addPayment,
  exportReceipt,
  formatMoney,
  getTotals,
  openReceipt,
  ReceiptDocument,
  ReceiptField,
  removeField,
  removeItem,
  removePayment,
  reorderSections,
  restoreField,
  updateField,
  updateItem,
  updatePayment,
  updatePreviewText,
} from './lib/receipt';

const acceptedTypes = '.html,.htm,.mhtml,.mht,text/html,message/rfc822';
const previewViewportWidth = 640;

function asNumber(value: string) {
  const normalized = value.trim().replace(/[$,\s]/g, '');
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return 0;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nameWithoutExtension(name: string) {
  return name.replace(/\.(mhtml|mht|html?)$/i, '');
}

async function downloadFile(body: string, fileName: string, type: string) {
  if (window.receiptDesktop) {
    return window.receiptDesktop.saveFile({ defaultName: fileName, contents: body });
  }
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true };
}

function describeChange(change: ReceiptDocument['changes'][number]) {
  if (change.kind === 'reordered') return `Moved ${change.after ?? ''}`.trim();
  if (change.before !== undefined && change.after !== undefined) return `${change.before || '(blank)'} to ${change.after || '(blank)'}`;
  if (change.before !== undefined) return `Removed ${change.before || '(blank)'}`;
  if (change.after !== undefined) return `Added ${change.after || '(blank)'}`;
  return 'Structure changed';
}

type PreviewBox = { left: number; top: number; width: number; height: number; right: number; bottom: number };
type PreviewEditor = PreviewBox & { kind: 'field' | 'text'; id: string; label: string; value: string; multiline: boolean };
type PreviewDrag = { sourceId: string; targetId: string; placement: 'before' | 'after'; startY: number; moved: boolean };

function boxFor(element: Element): PreviewBox {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
}

function ReceiptPreview({ receipt, commit }: { receipt: ReceiptDocument; commit: ReceiptCommit }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(0);
  const [frameHeight, setFrameHeight] = useState(500);
  const [sectionRects, setSectionRects] = useState<Record<string, PreviewBox>>({});
  const [hoverSectionId, setHoverSectionId] = useState('');
  const [hoverEditBox, setHoverEditBox] = useState<PreviewBox | null>(null);
  const [editor, setEditor] = useState<PreviewEditor | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<PreviewDrag | null>(null);

  useEffect(() => {
    if (!frameReady) return;
    const frame = iframeRef.current;
    const document = frame?.contentDocument;
    const view = frame?.contentWindow;
    if (!frame || !document || !view) return;

    const measure = () => {
      const body = document.body;
      const root = document.documentElement;
      const nextHeight = Math.max(500, Math.ceil(Math.max(body?.scrollHeight ?? 0, body?.offsetHeight ?? 0, root.scrollHeight, root.offsetHeight)));
      setFrameHeight(nextHeight);
      const nextRects: Record<string, PreviewBox> = {};
      for (const section of receipt.sections) {
        const element = document.querySelector(`[data-rce-layout-section-id="${section.id}"]`);
        if (element) nextRects[section.id] = boxFor(element);
      }
      setSectionRects(nextRects);
    };

    const openEditor = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('a')) event.preventDefault();
      const fieldElement = target.closest('[data-rce-id]');
      const fieldId = fieldElement?.getAttribute('data-rce-id');
      const field = receipt.fields.find((entry) => entry.id === fieldId && entry.kind !== 'attribute');
      if (field && fieldElement) {
        event.preventDefault();
        setDraft(field.value);
        setEditor({ ...boxFor(fieldElement), kind: 'field', id: field.id, label: field.label, value: field.value, multiline: field.kind === 'multiline' });
        return;
      }
      const textElement = target.closest('[data-rce-text-host-id]');
      const hostId = textElement?.getAttribute('data-rce-text-host-id');
      const previewText = receipt.previewTexts.find((entry) => entry.hostId === hostId);
      if (previewText && textElement) {
        event.preventDefault();
        setDraft(previewText.value);
        setEditor({ ...boxFor(textElement), kind: 'text', id: previewText.id, label: previewText.label, value: previewText.value, multiline: false });
      }
    };

    const trackPointer = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const editable = target?.closest('[data-rce-id], [data-rce-text-host-id]');
      setHoverEditBox(editable ? boxFor(editable) : null);
      const section = target?.closest('[data-rce-layout-section-id]');
      const sectionId = section?.getAttribute('data-rce-layout-section-id') ?? '';
      if (sectionId) setHoverSectionId(sectionId);
    };

    document.addEventListener('click', openEditor, true);
    document.addEventListener('mousemove', trackPointer, { passive: true });
    view.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    for (const image of Array.from(document.images)) image.addEventListener('load', measure);
    document.fonts?.ready.then(measure).catch(() => undefined);
    measure();

    return () => {
      document.removeEventListener('click', openEditor, true);
      document.removeEventListener('mousemove', trackPointer);
      view.removeEventListener('resize', measure);
      observer.disconnect();
      for (const image of Array.from(document.images)) image.removeEventListener('load', measure);
    };
  }, [frameReady, receipt.fields, receipt.previewTexts, receipt.sections]);

  const activeSectionId = drag?.sourceId || hoverSectionId;
  const activeSection = receipt.sections.find((section) => section.id === activeSectionId);
  const activeSectionRect = activeSectionId ? sectionRects[activeSectionId] : undefined;
  const dropRect = drag?.targetId ? sectionRects[drag.targetId] : undefined;
  const popoverLeft = editor ? Math.max(8, Math.min(previewViewportWidth - 288, editor.left)) : 0;
  const popoverTop = editor ? Math.max(8, Math.min(frameHeight - 136, editor.bottom + 8)) : 0;

  const moveSectionWithKeyboard = (sectionId: string, direction: 'up' | 'down') => {
    const index = receipt.sections.findIndex((section) => section.id === sectionId);
    const target = receipt.sections[direction === 'up' ? index - 1 : index + 1];
    if (!target) return;
    commit((current) => reorderSections(current, sectionId, target.id, direction === 'up' ? 'before' : 'after'));
  };

  return (
    <div className="receipt-frame-wrap">
      <div className="receipt-canvas" style={{ height: frameHeight }}>
        <iframe
          ref={iframeRef}
          title="Live receipt preview"
          srcDoc={receipt.previewHtml}
          sandbox="allow-same-origin"
          className="receipt-frame"
          style={{ height: frameHeight }}
          onLoad={() => {
            setEditor(null);
            setDrag(null);
            setFrameReady((value) => value + 1);
          }}
        />
        <div className="preview-overlay">
          {hoverEditBox && !editor && (
            <span className="preview-edit-outline" style={{ left: hoverEditBox.left, top: hoverEditBox.top, width: hoverEditBox.width, height: hoverEditBox.height }} />
          )}
          {activeSection && activeSectionRect && receipt.sections.length > 1 && (
            <button
              className={`preview-section-grip ${drag ? 'is-dragging' : ''}`}
              type="button"
              title={`Move ${activeSection.label}`}
              aria-label={`Move ${activeSection.label}. Drag or use the arrow keys.`}
              style={{ left: Math.max(6, Math.min(previewViewportWidth - 26, activeSectionRect.right - 24)), top: Math.max(6, activeSectionRect.top + 6) }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({ sourceId: activeSection.id, targetId: '', placement: 'before', startY: event.clientY, moved: false });
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                const frameTop = iframeRef.current?.getBoundingClientRect().top ?? 0;
                const pointerY = event.clientY - frameTop;
                const target = receipt.sections
                  .map((section) => ({ section, rect: sectionRects[section.id] }))
                  .filter((entry) => entry.rect && entry.section.id !== drag.sourceId)
                  .find((entry) => pointerY >= entry.rect.top && pointerY <= entry.rect.bottom);
                setDrag({
                  ...drag,
                  moved: drag.moved || Math.abs(event.clientY - drag.startY) > 4,
                  targetId: target?.section.id ?? '',
                  placement: target && pointerY > target.rect.top + target.rect.height / 2 ? 'after' : 'before',
                });
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                if (drag?.moved && drag.targetId) {
                  commit((current) => reorderSections(current, drag.sourceId, drag.targetId, drag.placement));
                }
                setDrag(null);
              }}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                moveSectionWithKeyboard(activeSection.id, event.key === 'ArrowUp' ? 'up' : 'down');
              }}
            >
              ⠿
            </button>
          )}
          {dropRect && drag && (
            <span className="preview-drop-line" style={{ left: dropRect.left, top: drag.placement === 'before' ? dropRect.top : dropRect.bottom, width: dropRect.width }} />
          )}
          {editor && (
            <form
              className="preview-text-editor"
              style={{ left: popoverLeft, top: popoverTop }}
              onSubmit={(event) => {
                event.preventDefault();
                if (editor.kind === 'field') commit((current) => updatePreviewField(current, editor.id, draft));
                else commit((current) => updatePreviewText(current, editor.id, draft));
                setEditor(null);
              }}
            >
              <label htmlFor="preview-text-value">{editor.label}</label>
              {editor.multiline ? (
                <textarea id="preview-text-value" value={draft} rows={3} autoFocus onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditor(null); }} />
              ) : (
                <input id="preview-text-value" value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditor(null); }} />
              )}
              <div>
                <button type="button" onClick={() => setEditor(null)}>Cancel</button>
                <button type="submit">Save</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldEditor({
  field,
  onChange,
  onRemove,
}: {
  field: ReceiptField;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const multiline = field.kind === 'multiline';
  return (
    <div className="field-control">
      <div className="field-label-row">
        <label htmlFor={field.id}>{field.label}</label>
        {field.removable && (
          <button className="remove-text" type="button" onClick={onRemove} aria-label={`Remove ${field.label}`}>
            Remove
          </button>
        )}
      </div>
      {multiline ? (
        <textarea id={field.id} value={field.value} rows={field.label === 'Contact message' ? 3 : 2} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input id={field.id} value={field.value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

function UploadPanel({ onFile, onBrowse, error }: { onFile: (file: File) => void; onBrowse?: () => void; error?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => event.preventDefault(),
    onDragLeave: () => setDragging(false),
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files.item(0);
      if (file) onFile(file);
    },
  };
  return (
    <main className="welcome-shell">
      <section className="welcome-card">
        <div className="eyebrow">Private receipt workspace</div>
        <h1>Make a receipt clear, accurate, and ready to share.</h1>
        <p className="welcome-copy">
          Open an HTML or MHTML receipt, edit the detected details, and watch the result update as you work. Your receipt stays on this device.
        </p>
        <div className={`drop-zone ${dragging ? 'is-dragging' : ''}`} {...dragHandlers}>
          <div className="drop-icon" aria-hidden="true">⇩</div>
          <strong>Drop a receipt here</strong>
          <span>HTML, HTM, MHTML, or MHT</span>
          <button className="button primary" type="button" onClick={() => onBrowse ? onBrowse() : inputRef.current?.click()}>
            Browse files
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept={acceptedTypes}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              event.currentTarget.value = '';
            }}
          />
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="feature-strip">
          <span><b>01</b> Scan structure</span>
          <span><b>02</b> Edit safely</span>
          <span><b>03</b> Download same format</span>
        </div>
      </section>
    </main>
  );
}

type ReceiptCommit = (apply: (current: ReceiptDocument) => ReceiptDocument) => void;
type EditorBlock =
  | { kind: 'fields'; key: string; fieldIds: string[]; section: string; fields: ReceiptField[]; sequence: number }
  | { kind: 'items'; key: string; fieldIds: string[]; sequence: number }
  | { kind: 'payments'; key: string; fieldIds: string[]; sequence: number };

function updatePreviewField(document: ReceiptDocument, fieldId: string, value: string) {
  const item = document.items.find((entry) => entry.descriptionId === fieldId || entry.amountId === fieldId);
  if (item) {
    return item.descriptionId === fieldId
      ? updateItem(document, item.id, { description: value })
      : updateItem(document, item.id, { amount: asNumber(value) });
  }
  const payment = document.payments.find((entry) => [entry.methodId, entry.referenceId, entry.amountId].includes(fieldId));
  if (payment) {
    if (payment.methodId === fieldId) return updatePayment(document, payment.id, { method: value });
    if (payment.referenceId === fieldId) return updatePayment(document, payment.id, { reference: value });
    return updatePayment(document, payment.id, { amount: asNumber(value) });
  }
  return updateField(document, fieldId, value);
}

function LayoutSectionList({ receipt, commit }: { receipt: ReceiptDocument; commit: ReceiptCommit }) {
  const [draggedId, setDraggedId] = useState('');
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null);
  if (receipt.sections.length < 2) return null;

  const clearDrag = () => {
    setDraggedId('');
    setDropTarget(null);
  };
  const moveWithKeyboard = (sectionId: string, direction: 'up' | 'down') => {
    const index = receipt.sections.findIndex((section) => section.id === sectionId);
    const target = receipt.sections[direction === 'up' ? index - 1 : index + 1];
    if (!target) return;
    commit((current) => reorderSections(current, sectionId, target.id, direction === 'up' ? 'before' : 'after'));
  };

  return (
    <details className="layout-order-card">
      <summary className="layout-order-summary">
        <span>Layout order</span>
        <b>{receipt.sections.length} sections</b>
      </summary>
      <div className="layout-order-body">
        <p>Drag a small grip here or directly in the preview.</p>
        <div className="layout-order-list" aria-label="Receipt layout order">
          {receipt.sections.map((section, index) => (
            <div
              className={`layout-order-row ${draggedId === section.id ? 'is-dragging' : ''} ${dropTarget?.id === section.id ? `drop-${dropTarget.placement}` : ''}`}
              key={section.id}
              onDragOver={(event) => {
                if (!draggedId || draggedId === section.id) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setDropTarget({ id: section.id, placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedId && dropTarget && draggedId !== dropTarget.id) {
                  commit((current) => reorderSections(current, draggedId, dropTarget.id, dropTarget.placement));
                }
                clearDrag();
              }}
            >
              <button
                className="layout-row-grip"
                type="button"
                draggable
                aria-label={`Move ${section.label}. Section ${index + 1} of ${receipt.sections.length}.`}
                title={`Drag ${section.label}`}
                onDragStart={(event) => {
                  setDraggedId(section.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', section.id);
                }}
                onDragEnd={clearDrag}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  moveWithKeyboard(section.id, event.key === 'ArrowUp' ? 'up' : 'down');
                }}
              >
                ⠿
              </button>
              <span className="layout-row-number">{String(index + 1).padStart(2, '0')}</span>
              <strong>{section.label}</strong>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function ItemsEditor({ receipt, commit }: { receipt: ReceiptDocument; commit: ReceiptCommit }) {
  return (
    <section className="edit-section">
      <div className="section-title-row">
        <h2>Items ordered</h2>
        <button className="mini-button" type="button" onClick={() => commit(addItem)} disabled={receipt.items.length === 0}>+ Add item</button>
      </div>
      {receipt.items.length === 0 ? (
        <p className="muted-copy">No safe item table was found in this receipt.</p>
      ) : (
        <div className="item-list">
          {receipt.items.map((item, index) => (
            <div className="item-card" key={item.id}>
              <div className="item-card-top">
                <span>Item {index + 1}</span>
                <button className="remove-text" type="button" onClick={() => commit((current) => removeItem(current, item.id))}>Remove</button>
              </div>
              <label>
                Description
                <input value={item.description} onChange={(event) => commit((current) => updateItem(current, item.id, { description: event.target.value }))} />
              </label>
              <label>
                Line total
                <input inputMode="decimal" value={formatMoney(item.amount, receipt.currencySymbol)} onChange={(event) => commit((current) => updateItem(current, item.id, { amount: asNumber(event.target.value) }))} />
              </label>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PaymentsEditor({ receipt, totals, isBalanced, commit }: { receipt: ReceiptDocument; totals: ReturnType<typeof getTotals> | null; isBalanced: boolean; commit: ReceiptCommit }) {
  return (
    <section className="edit-section">
      <div className="section-title-row">
        <h2>Payment allocation</h2>
        <button className="mini-button" type="button" onClick={() => commit(addPayment)} disabled={receipt.template !== 'Stripe receipt'}>+ Add payment</button>
      </div>
      <div className="item-list">
        {receipt.payments.map((payment, index) => (
          <div className="payment-card" key={payment.id}>
            <div className="item-card-top">
              <span>Payment {index + 1}</span>
              {receipt.payments.length > 1 && payment.removable && <button className="remove-text" type="button" onClick={() => commit((current) => removePayment(current, payment.id))}>Remove</button>}
            </div>
            <div className="two-inputs">
              <label>
                Method
                <input value={payment.method} disabled={!payment.methodId} onChange={(event) => commit((current) => updatePayment(current, payment.id, { method: event.target.value }))} />
              </label>
              <label>
                Reference
                <input value={payment.reference} disabled={!payment.referenceId} onChange={(event) => commit((current) => updatePayment(current, payment.id, { reference: event.target.value }))} />
              </label>
            </div>
            <label>
              Amount
              <input inputMode="decimal" value={formatMoney(payment.amount, receipt.currencySymbol)} onChange={(event) => commit((current) => updatePayment(current, payment.id, { amount: asNumber(event.target.value) }))} />
            </label>
          </div>
        ))}
      </div>
      {totals && (
        <div className={`balance-card ${isBalanced ? 'balanced' : 'unbalanced'}`}>
          <span>{isBalanced ? 'Payments match receipt total' : 'Payment allocation needs attention'}</span>
          <strong>{isBalanced ? 'Balanced' : `${formatMoney(Math.abs(totals.balance), receipt.currencySymbol)} difference`}</strong>
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const [receipt, setReceipt] = useState<ReceiptDocument | null>(null);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [history, setHistory] = useState<ReceiptDocument[]>([]);
  const [future, setFuture] = useState<ReceiptDocument[]>([]);

  useEffect(() => {
    if (!receipt || !receipt.fields.some((field) => Boolean((field as ReceiptField & { previewOnly?: boolean }).previewOnly))) return;
    const timer = window.setTimeout(() => {
      try {
        const migrated = openReceipt(receipt.fileName, exportReceipt(receipt));
        setReceipt({ ...migrated, originalSource: receipt.originalSource, changes: receipt.changes });
        setHistory([]);
        setFuture([]);
        setReviewed(false);
      } catch {
        // Keep the current receipt available if a hot-update migration cannot be completed.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  const totals = useMemo(() => (receipt ? getTotals(receipt) : null), [receipt]);
  const itemFieldIds = useMemo(() => new Set(receipt?.items.flatMap((item) => [item.descriptionId, item.amountId]) ?? []), [receipt]);
  const paymentFieldIds = useMemo(
    () => new Set(receipt?.payments.flatMap((payment) => [payment.methodId, payment.referenceId, payment.amountId].filter(Boolean) as string[]) ?? []),
    [receipt],
  );
  const editableFields = useMemo(
    () => receipt?.fields.filter((field) => !itemFieldIds.has(field.id) && !paymentFieldIds.has(field.id)) ?? [],
    [receipt, itemFieldIds, paymentFieldIds],
  );
  const groupedFields = useMemo(() => {
    const groups = new Map<string, ReceiptField[]>();
    for (const field of editableFields) groups.set(field.section, [...(groups.get(field.section) ?? []), field]);
    return Array.from(groups.entries());
  }, [editableFields]);
  const editorBlocks = useMemo<EditorBlock[]>(() => {
    if (!receipt) return [];
    const rankByField = new Map<string, number>();
    receipt.sections.forEach((section, index) => section.fieldIds.forEach((fieldId) => rankByField.set(fieldId, index)));
    const blocks: EditorBlock[] = groupedFields.map(([section, fields], sequence) => ({
      kind: 'fields',
      key: `fields-${section}`,
      fieldIds: fields.map((field) => field.id),
      section,
      fields,
      sequence,
    }));
    blocks.push({
      kind: 'items',
      key: 'items',
      fieldIds: receipt.items.flatMap((item) => [item.descriptionId, item.amountId]),
      sequence: blocks.length,
    });
    blocks.push({
      kind: 'payments',
      key: 'payments',
      fieldIds: receipt.payments.flatMap((payment) => [payment.methodId, payment.referenceId, payment.amountId].filter(Boolean) as string[]),
      sequence: blocks.length,
    });
    const rank = (block: EditorBlock) => Math.min(...block.fieldIds.map((id) => rankByField.get(id) ?? Number.MAX_SAFE_INTEGER));
    return blocks.sort((left, right) => rank(left) - rank(right) || left.sequence - right.sequence);
  }, [groupedFields, receipt]);

  const loadSource = useCallback((name: string, source: string, size: number) => {
    const lowerName = name.toLowerCase();
    if (!/\.(html?|mhtml|mht)$/.test(lowerName)) {
      setError('Choose an HTML, HTM, MHTML, or MHT receipt file.');
      return;
    }
    if (size > 20 * 1024 * 1024) {
      setError('This file is larger than 20 MB. Choose a smaller receipt file.');
      return;
    }
    setError('');
    setIsScanning(true);
    try {
      const opened = openReceipt(name, source);
      setReceipt(opened);
      setReviewed(false);
      setHistory([]);
      setFuture([]);
    } catch (reason) {
      setReceipt(null);
      setError(reason instanceof Error ? reason.message : 'This receipt could not be opened.');
    } finally {
      setIsScanning(false);
    }
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try {
      loadSource(file.name, await file.text(), file.size);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This receipt could not be opened.');
    }
  }, [loadSource]);

  const browseForFile = useCallback(async () => {
    if (!window.receiptDesktop) return;
    try {
      const file = await window.receiptDesktop.openFile();
      if (file) loadSource(file.name, file.source, file.size);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This receipt could not be opened.');
    }
  }, [loadSource]);

  useEffect(() => {
    return window.receiptDesktop?.onOpenFile((file) => loadSource(file.name, file.source, file.size));
  }, [loadSource]);

  const commit = (apply: (current: ReceiptDocument) => ReceiptDocument) => {
    if (!receipt) return;
    try {
      const next = apply(receipt);
      if (next === receipt) return;
      setHistory((previous) => [...previous, receipt].slice(-60));
      setFuture([]);
      setReviewed(false);
      setReceipt(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That change could not be applied.');
    }
  };

  const undo = () => {
    if (!receipt || history.length === 0) return;
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [receipt, ...entries].slice(0, 60));
    setReviewed(false);
    setReceipt(previous);
  };

  const redo = () => {
    if (!receipt || future.length === 0) return;
    const next = future[0];
    if (!next) return;
    setFuture((entries) => entries.slice(1));
    setHistory((entries) => [...entries, receipt].slice(-60));
    setReviewed(false);
    setReceipt(next);
  };

  const download = async () => {
    if (!receipt || !reviewed || (totals && Math.abs(totals.balance) > 0.01)) return;
    try {
      const body = exportReceipt(receipt);
      openReceipt(receipt.fileName, body);
      const extension = receipt.format === 'mhtml' ? 'mhtml' : 'html';
      await downloadFile(body, `${nameWithoutExtension(receipt.fileName)}-edited.${extension}`, receipt.format === 'mhtml' ? 'multipart/related' : 'text/html;charset=utf-8');
    } catch (reason) {
      setError(reason instanceof Error ? `Export check failed: ${reason.message}` : 'Export check failed. The receipt was not downloaded.');
    }
  };

  const downloadOriginal = async () => {
    if (!receipt) return;
    try {
      await downloadFile(receipt.originalSource, receipt.fileName, receipt.format === 'mhtml' ? 'multipart/related' : 'text/html;charset=utf-8');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The original receipt could not be saved.');
    }
  };

  const downloadChangeLog = async () => {
    if (!receipt) return;
    const report = {
      sourceFile: receipt.fileName,
      format: receipt.format.toUpperCase(),
      currency: 'USD',
      generatedAt: new Date().toISOString(),
      totals,
      changes: receipt.changes,
    };
    try {
      await downloadFile(JSON.stringify(report, null, 2), `${nameWithoutExtension(receipt.fileName)}-change-log.json`, 'application/json;charset=utf-8');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The change log could not be saved.');
    }
  };

  if (!receipt) {
    return (
      <>
        {isScanning && <div className="scan-banner">Scanning receipt structure…</div>}
        <UploadPanel onFile={loadFile} onBrowse={typeof window !== 'undefined' && window.receiptDesktop ? browseForFile : undefined} error={error} />
      </>
    );
  }

  const isBalanced = !totals || Math.abs(totals.balance) < 0.01;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">R</span>
          <div>
            <strong>Receipt Studio</strong>
            <span>Local editing session</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="file-pill" title={receipt.fileName}>{receipt.fileName}</span>
          <button className="button quiet" type="button" onClick={undo} disabled={history.length === 0} aria-label="Undo last change">
            Undo
          </button>
          <button className="button quiet" type="button" onClick={redo} disabled={future.length === 0} aria-label="Redo last change">
            Redo
          </button>
          <button className="button quiet" type="button" onClick={() => { setReceipt(null); setError(''); setReviewed(false); setHistory([]); setFuture([]); }}>
            New receipt
          </button>
          <button className="button primary" type="button" onClick={download} disabled={!reviewed || !isBalanced}>
            Download {receipt.format.toUpperCase()}
          </button>
        </div>
      </header>

      {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

      <div className="workspace">
        <aside className="editor-panel" aria-label="Receipt editor">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Detected layout</div>
              <h1>{receipt.template}</h1>
            </div>
            <span className="format-badge">.{receipt.format}</span>
          </div>

          <div className="scan-summary">
            <span>{receipt.fields.length} fields</span>
            <span>{receipt.items.length} item{receipt.items.length === 1 ? '' : 's'}</span>
            <span>{receipt.payments.length} payment{receipt.payments.length === 1 ? '' : 's'}</span>
          </div>
          <div className={`detection-card ${receipt.detection.level}`}>
            <strong>{receipt.detection.level === 'ready' ? 'Import check complete' : receipt.detection.level === 'partial' ? 'Partial import' : 'Manual review needed'}</strong>
            <p>{receipt.detection.message}</p>
          </div>

          <div className="editor-scroll">
            <LayoutSectionList receipt={receipt} commit={commit} />

            {editorBlocks.map((block) => {
              if (block.kind === 'items') return <ItemsEditor key={block.key} receipt={receipt} commit={commit} />;
              if (block.kind === 'payments') return <PaymentsEditor key={block.key} receipt={receipt} totals={totals} isBalanced={isBalanced} commit={commit} />;
              return (
                <section className="edit-section" key={block.key}>
                  <h2>{block.section}</h2>
                  {block.fields.map((field) => (
                    <FieldEditor
                      key={field.id}
                      field={field}
                      onChange={(value) => commit((current) => updateField(current, field.id, value))}
                      onRemove={() => commit((current) => removeField(current, field.id))}
                    />
                  ))}
                </section>
              );
            })}

            <section className="edit-section add-section">
              <h2>Add or restore a property</h2>
              <p className="muted-copy">Add a labeled property, or restore anything removed during this session.</p>
              <div className="add-grid">
                <button type="button" onClick={() => commit((current) => addBlock(current, 'property'))}><b>Property</b><span>Custom label and value</span></button>
                <button type="button" onClick={() => commit((current) => addBlock(current, 'note'))}><b>Note</b><span>Short customer message</span></button>
                <button type="button" onClick={() => commit((current) => addBlock(current, 'address'))}><b>Address</b><span>Shipping or pickup details</span></button>
                <button type="button" onClick={() => commit((current) => addBlock(current, 'amount'))}><b>Amount</b><span>Extra labeled amount</span></button>
              </div>
              {receipt.removedFields.length > 0 && (
                <div className="restore-box">
                  <strong>Restore removed properties</strong>
                  <div>
                    {receipt.removedFields.map((field) => (
                      <button type="button" key={field.id} onClick={() => commit((current) => restoreField(current, field.id))}>
                        Restore {field.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </aside>

        <section className="preview-panel" aria-label="Live receipt preview">
          <div className="preview-head">
            <div>
              <div className="eyebrow live"><span /> Source-faithful preview</div>
              <h2>Edit without changing the receipt layout</h2>
              <p className="preview-hint">Click text to edit it. Hover a section to reveal its small corner grip.</p>
            </div>
            <div className="preview-total">
              <span>Receipt total</span>
              <strong>{totals ? formatMoney(totals.total, receipt.currencySymbol) : '—'}</strong>
            </div>
          </div>
          {receipt.warnings.length > 0 && (
            <div className="warning-box">
              <b>Offline preview</b>
              {receipt.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          )}
          <ReceiptPreview receipt={receipt} commit={commit} />
          <div className="review-bar">
            <div className="review-overview">
              <span className="review-count">{receipt.changes.length}</span>
              <div>
                <strong>Review changes</strong>
                <p>{receipt.changes.length === 0 ? 'No edits yet. The original receipt is shown.' : receipt.changes.slice(-3).map((change) => `${change.kind}: ${change.label}`).join(' · ')}</p>
              </div>
            </div>
            <div className="review-actions">
              <button className="text-action" type="button" onClick={downloadOriginal}>Download original</button>
              <button className="text-action" type="button" onClick={downloadChangeLog} disabled={receipt.changes.length === 0}>Change log</button>
              <label className="review-check">
                <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
                <span>I reviewed the live preview</span>
              </label>
            </div>
          </div>
          {receipt.changes.length > 0 && (
            <details className="change-details">
              <summary>View exact changes</summary>
              <ol>
                {receipt.changes.map((change, index) => (
                  <li key={`${change.kind}-${change.id}-${index}`}>
                    <strong>{change.label}</strong>
                    <span>{describeChange(change)}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      </div>
    </main>
  );
}
