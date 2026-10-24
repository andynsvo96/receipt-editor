'use client';

export type SourceFormat = 'html' | 'mhtml';
export type FieldKind = 'text' | 'multiline' | 'currency' | 'attribute';
export type ChangeKind = 'edited' | 'added' | 'removed' | 'reordered';

export interface ReceiptField {
  id: string;
  label: string;
  section: string;
  value: string;
  kind: FieldKind;
  role?: 'paid' | 'total' | 'tax' | 'shipping' | 'discount' | 'fee';
  attribute?: string;
  removable?: boolean;
}

export interface ReceiptPreviewText {
  id: string;
  hostId: string;
  label: string;
  value: string;
}

export interface ReceiptItem {
  id: string;
  descriptionId: string;
  amountId: string;
  description: string;
  amount: number;
}

export interface PaymentRow {
  id: string;
  methodId?: string;
  referenceId?: string;
  amountId?: string;
  method: string;
  reference: string;
  amount: number;
  removable?: boolean;
}

export interface ReceiptSection {
  id: string;
  label: string;
  fieldIds: string[];
}

export interface ReceiptChange {
  id: string;
  kind: ChangeKind;
  label: string;
  before?: string;
  after?: string;
}

export interface ReceiptDetection {
  level: 'ready' | 'partial' | 'manual';
  message: string;
}

interface MhtmlPart {
  headers: string;
  body: string;
  contentType: string;
  transferEncoding: string;
  contentLocation?: string;
  contentId?: string;
  isHtml: boolean;
}

interface MhtmlContainer {
  header: string;
  boundary: string;
  lineEnding: string;
  parts: MhtmlPart[];
}

export interface ReceiptDocument {
  fileName: string;
  format: SourceFormat;
  template: 'Stripe receipt' | 'Generic receipt';
  originalSource: string;
  html: string;
  previewHtml: string;
  fields: ReceiptField[];
  previewTexts: ReceiptPreviewText[];
  items: ReceiptItem[];
  payments: PaymentRow[];
  sections: ReceiptSection[];
  changes: ReceiptChange[];
  removedFields: ReceiptField[];
  warnings: string[];
  currencySymbol: string;
  detection: ReceiptDetection;
  mhtml?: MhtmlContainer;
}

let idCounter = 0;

function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function normalise(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttribute(value: string) {
  return value.replace(/"/g, '\\"');
}

function parseHeaders(raw: string) {
  const flattened = raw.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of flattened.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  return headers;
}

function splitHeaderAndBody(source: string) {
  const match = /\r?\n\r?\n/.exec(source);
  if (!match || match.index === undefined) {
    throw new Error('The file does not contain a complete MIME header.');
  }
  return {
    header: source.slice(0, match.index),
    body: source.slice(match.index + match[0].length),
  };
}

function decodeQuotedPrintableBytes(input: string) {
  const source = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const encoded = new TextEncoder().encode(source[index]);
    bytes.push(...encoded);
  }
  return new Uint8Array(bytes);
}

function decodeBase64Bytes(input: string) {
  const encoded = input.replace(/\s/g, '');
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function charsetFromContentType(contentType: string) {
  return /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean) ?? 'utf-8';
}

function decodeText(bytes: Uint8Array, contentType: string) {
  try {
    return new TextDecoder(charsetFromContentType(contentType), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function encodeBase64Text(input: string) {
  return encodeBase64(new TextEncoder().encode(input));
}

function decodePartBytes(part: MhtmlPart) {
  if (part.transferEncoding.includes('quoted-printable')) return decodeQuotedPrintableBytes(part.body);
  if (part.transferEncoding.includes('base64')) return decodeBase64Bytes(part.body);
  return new TextEncoder().encode(part.body);
}

function decodePart(part: MhtmlPart) {
  return decodeText(decodePartBytes(part), part.contentType);
}

function encodeQuotedPrintable(input: string) {
  const bytes = new TextEncoder().encode(input);
  const lines: string[] = [];
  let current = '';
  const push = (token: string) => {
    if (current.length + token.length > 72) {
      lines.push(`${current}=`);
      current = '';
    }
    current += token;
  };

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 13 && bytes[index + 1] === 10) {
      lines.push(current);
      current = '';
      index += 1;
    } else if (byte === 10) {
      lines.push(current);
      current = '';
    } else if ((byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126) || byte === 9 || byte === 32) {
      push(String.fromCharCode(byte));
    } else {
      push(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  lines.push(current);
  return lines.join('\r\n');
}

function parseMhtml(source: string): { html: string; container: MhtmlContainer } {
  const { header, body } = splitHeaderAndBody(source);
  const headers = parseHeaders(header);
  const contentType = headers.get('content-type') ?? '';
  const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundaryMatch) throw new Error('This MHTML file is missing its multipart boundary.');
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const marker = new RegExp(`(?:^|\\r?\\n)--${escapeRegex(boundary)}(--)?(?:\\r?\\n|$)`, 'g');
  const markers: Array<{ index: number; end: number; closing: boolean }> = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(body)) !== null) {
    markers.push({ index: match.index, end: marker.lastIndex, closing: Boolean(match[1]) });
  }
  if (markers.length === 0) throw new Error('No MIME parts were found in this MHTML file.');

  const parts: MhtmlPart[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    if (current.closing) break;
    const next = markers[index + 1];
    if (!next) break;
    let rawPart = body.slice(current.end, next.index);
    rawPart = rawPart.replace(/\r?\n$/, '');
    if (!rawPart.trim()) continue;
    const part = splitHeaderAndBody(rawPart);
    const partHeaders = parseHeaders(part.header);
    const partContentType = partHeaders.get('content-type') ?? 'application/octet-stream';
    parts.push({
      headers: part.header,
      body: part.body,
      contentType: partContentType,
      transferEncoding: (partHeaders.get('content-transfer-encoding') ?? '').toLowerCase(),
      contentLocation: partHeaders.get('content-location'),
      contentId: partHeaders.get('content-id'),
      isHtml: /^text\/html\b/i.test(partContentType),
    });
  }
  const htmlPart = parts.find((part) => part.isHtml);
  if (!htmlPart) throw new Error('This MHTML file does not include an editable HTML part.');
  return { html: decodePart(htmlPart), container: { header, boundary, lineEnding, parts } };
}

function serialiseDocument(document: Document) {
  const doctype = document.doctype
    ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC \"${document.doctype.publicId}\"` : ''}${document.doctype.systemId ? ` \"${document.doctype.systemId}\"` : ''}>`
    : '';
  return `${doctype}${document.documentElement.outerHTML}`;
}

function parseHtml(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const unsafe = [
    ...Array.from(document.querySelectorAll('script, iframe, object, embed, applet, base')),
    ...Array.from(document.querySelectorAll('meta[http-equiv="refresh" i]')),
  ];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (Array.from(element.attributes).some((attribute) => attribute.name.toLowerCase().startsWith('on'))) unsafe.push(element);
  }
  if (unsafe.length > 0) {
    throw new Error('This receipt contains active content. Remove scripts, frames, or event handlers before opening it.');
  }
  return document;
}

function textNodeWrap(container: Element, pattern: RegExp, id: string) {
  const ownerDocument = container.ownerDocument;
  const walker = ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? '';
    if (!pattern.test(value) || !node.parentNode) continue;
    const match = pattern.exec(value);
    if (!match || match.index === undefined) continue;
    const before = value.slice(0, match.index);
    const selected = match[0];
    const after = value.slice(match.index + selected.length);
    const span = ownerDocument.createElement('span');
    span.setAttribute('data-rce-id', id);
    span.textContent = selected.trim();
    node.parentNode.insertBefore(ownerDocument.createTextNode(before), node);
    node.parentNode.insertBefore(span, node);
    node.parentNode.insertBefore(ownerDocument.createTextNode(after), node);
    node.parentNode.removeChild(node);
    return span;
  }
  return null;
}

function directTextNodeWrap(container: Element, id: string) {
  const ownerDocument = container.ownerDocument;
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const value = normalise(node.textContent ?? '');
    if (value.length < 3) continue;
    const span = ownerDocument.createElement('span');
    span.setAttribute('data-rce-id', id);
    span.textContent = value;
    node.parentNode?.replaceChild(span, node);
    return span;
  }
  return null;
}

function labelElement(document: Document, label: string) {
  return Array.from(document.querySelectorAll('td, th, div, p, span, strong')).find(
    (element) => normalise(element.textContent ?? '').toLowerCase() === label.toLowerCase(),
  );
}

function smallestMatchingElement(document: Document, predicate: (value: string) => boolean) {
  return Array.from(document.querySelectorAll('td, div, p, span'))
    .map((element) => ({ element, value: normalise(element.textContent ?? '') }))
    .filter(({ value }) => predicate(value))
    .sort((left, right) => left.value.length - right.value.length || left.element.children.length - right.element.children.length)[0]?.element;
}

function valueBelowLabel(label: Element | undefined) {
  const row = label?.closest('tr');
  let next = row?.nextElementSibling;
  while (next) {
    const candidate = next.querySelector('td, div, p, span');
    if (candidate && normalise(candidate.textContent ?? '')) return candidate;
    next = next.nextElementSibling;
  }
  return undefined;
}

function money(value: string) {
  const normalized = value.replace(/[^0-9,.-]/g, '').replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(value: number, symbol = '$') {
  return `${symbol}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function fieldFromElement(
  fields: ReceiptField[],
  element: Element,
  label: string,
  section: string,
  kind: FieldKind = 'text',
  role?: ReceiptField['role'],
  attribute?: string,
) {
  const id = element.getAttribute('data-rce-id') ?? nextId('field');
  element.setAttribute('data-rce-id', id);
  fields.push({
    id,
    label,
    section,
    value: attribute ? element.getAttribute(attribute) ?? '' : normalise(element.textContent ?? ''),
    kind,
    role,
    attribute,
    removable: true,
  });
  return id;
}

function discoverPreviewTexts(document: Document) {
  const previewTexts: ReceiptPreviewText[] = [];
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (element.children.length > 0 || element.closest('style, script, noscript, textarea, [data-rce-id]')) continue;
    const value = normalise(element.textContent ?? '');
    if (!value) continue;
    const hostId = element.getAttribute('data-rce-text-host-id') ?? nextId('text-host');
    element.setAttribute('data-rce-text-host-id', hostId);
    const id = nextId('preview-text');
    previewTexts.push({
      id,
      hostId,
      label: value.length > 34 ? `${value.slice(0, 31)}…` : value,
      value,
    });
  }
  return previewTexts;
}

function findAmountCell(row: Element) {
  return row.querySelector('td.Table-amount, td[class*="amount" i]') ?? row.querySelector('td:last-child');
}

function scanStripe(document: Document) {
  const fields: ReceiptField[] = [];
  const items: ReceiptItem[] = [];
  const payments: PaymentRow[] = [];
  const sections: ReceiptSection[] = [];
  const isStripe = Boolean(document.querySelector('.st-Email, .st-Wrapper, .DataBlocks-item, .Table-description'));
  if (!isStripe) return { fields, items, payments, sections, matched: false };

  const title = smallestMatchingElement(document, (value) => /^Receipt from /i.test(value) && !/Receipt #/i.test(value));
  if (title) fieldFromElement(fields, title, 'Receipt title', 'Receipt details');
  const number = smallestMatchingElement(document, (value) => /^Receipt #[^\s]+$/i.test(value));
  if (number) fieldFromElement(fields, number, 'Receipt number', 'Receipt details');

  const amountLabel = labelElement(document, 'Amount paid');
  const amountValue = valueBelowLabel(amountLabel);
  const amountPaidId = amountValue
    ? fieldFromElement(fields, amountValue, 'Amount paid', 'Payment overview', 'currency', 'paid')
    : undefined;
  const dateLabel = labelElement(document, 'Date paid');
  const dateValue = valueBelowLabel(dateLabel);
  if (dateValue) fieldFromElement(fields, dateValue, 'Date paid', 'Payment overview');

  const paymentLabel = labelElement(document, 'Payment method');
  const paymentValue = valueBelowLabel(paymentLabel);
  if (paymentValue) {
    paymentValue.setAttribute('data-rce-anchor', 'payment-host');
    const cardImage = paymentValue.querySelector('img');
    const reference = Array.from(paymentValue.querySelectorAll('span')).at(-1);
    const methodId = cardImage
      ? fieldFromElement(fields, cardImage, 'Payment method', 'Payment overview', 'attribute', undefined, 'alt')
      : undefined;
    const referenceId = reference
      ? fieldFromElement(fields, reference, 'Payment reference', 'Payment overview')
      : undefined;
    payments.push({
      id: nextId('payment'),
      methodId,
      referenceId,
      amountId: amountPaidId,
      method: cardImage?.getAttribute('alt') ?? 'Payment',
      reference: normalise(reference?.textContent ?? '').replace(/^-\s*/, ''),
      amount: amountValue ? money(amountValue.textContent ?? '') : 0,
    });
  }

  const summaryLabel = labelElement(document, 'Summary');
  const summaryContainer = summaryLabel?.closest('table')?.parentElement ?? summaryLabel?.closest('td');
  if (summaryContainer) {
    const id = nextId('summary');
    const wrapped = directTextNodeWrap(summaryContainer, id);
    if (wrapped) {
      fields.push({ id, label: 'Summary', section: 'Summary', value: normalise(wrapped.textContent ?? ''), kind: 'multiline', removable: true });
    }
  }

  const billingLabel = labelElement(document, 'Billing details');
  const billingCell = billingLabel?.closest('td');
  if (billingCell) {
    billingCell.setAttribute('data-rce-section-id', 'billing-section');
    const billingValue = Array.from(billingCell.children)
      .filter((element) => element !== billingLabel)
      .map((element) => normalise(element.textContent ?? ''))
      .filter(Boolean)
      .join('\n');
    const id = nextId('billing');
    billingCell.setAttribute('data-rce-id', id);
    fields.push({ id, label: 'Billing details', section: 'Billing details', value: billingValue, kind: 'multiline', removable: true });
    sections.push({ id: 'billing-section', label: 'Billing details', fieldIds: [id] });
  }

  const tableDescriptions = Array.from(document.querySelectorAll('td.Table-description'));
  const itemRows = tableDescriptions
    .map((description) => ({ description, row: description.closest('tr') }))
    .filter(({ row, description }) => row && !/^Amount paid$/i.test(normalise(description.textContent ?? '')));
  const firstItemRow = itemRows[0]?.row;
  if (firstItemRow) {
    const itemTable = firstItemRow.closest('table');
    itemTable?.setAttribute('data-rce-anchor', 'items-host');
    itemTable?.setAttribute('data-rce-section-id', 'items-section');
  }
  for (const { description, row } of itemRows) {
    if (!row) continue;
    const amountCell = findAmountCell(row);
    if (!amountCell) continue;
    const descriptionId = fieldFromElement(fields, description, 'Item description', 'Items ordered');
    const amountId = fieldFromElement(fields, amountCell, 'Item amount', 'Items ordered', 'currency');
    const itemId = nextId('item');
    row.setAttribute('data-rce-item-id', itemId);
    items.push({
      id: itemId,
      descriptionId,
      amountId,
      description: normalise(description.textContent ?? ''),
      amount: money(amountCell.textContent ?? ''),
    });
  }
  if (items.length) sections.push({ id: 'items-section', label: 'Items ordered', fieldIds: items.flatMap((item) => [item.descriptionId, item.amountId]) });

  const totalRow = tableDescriptions.find((element) => /^Amount paid$/i.test(normalise(element.textContent ?? '')))?.closest('tr');
  const totalValue = totalRow ? findAmountCell(totalRow) : undefined;
  if (totalValue) fieldFromElement(fields, totalValue, 'Receipt total', 'Totals', 'currency', 'total');

  const contact = Array.from(document.querySelectorAll('td, p, div')).find((element) =>
    /^If you have any questions/i.test(normalise(element.textContent ?? '')),
  );
  if (contact) fieldFromElement(fields, contact, 'Contact message', 'Footer', 'multiline');
  const footer = Array.from(document.querySelectorAll('td, p, div')).find((element) =>
    /^Something wrong with the email\?/i.test(normalise(element.textContent ?? '')),
  );
  if (footer) fieldFromElement(fields, footer, 'Footer text', 'Footer', 'multiline');

  return { fields, items, payments, sections, matched: true };
}

function scanGeneric(document: Document) {
  const fields: ReceiptField[] = [];
  const items: ReceiptItem[] = [];
  const payments: PaymentRow[] = [];
  const sections: ReceiptSection[] = [];
  const known = new Map([
    ['receipt number', { section: 'Receipt details' }],
    ['order number', { section: 'Receipt details' }],
    ['invoice number', { section: 'Receipt details' }],
    ['transaction id', { section: 'Receipt details' }],
    ['confirmation number', { section: 'Receipt details' }],
    ['order date', { section: 'Receipt details' }],
    ['receipt date', { section: 'Receipt details' }],
    ['amount paid', { section: 'Payment overview', role: 'paid' as const }],
    ['payment total', { section: 'Payment overview', role: 'paid' as const }],
    ['total paid', { section: 'Payment overview', role: 'paid' as const }],
    ['date paid', { section: 'Payment overview' }],
    ['payment method', { section: 'Payment overview' }],
    ['payment reference', { section: 'Payment overview' }],
    ['billing details', { section: 'Billing details' }],
    ['billing address', { section: 'Billing details' }],
    ['shipping details', { section: 'Shipping details' }],
    ['shipping address', { section: 'Shipping details' }],
    ['subtotal', { section: 'Totals' }],
    ['tax', { section: 'Totals', role: 'tax' as const }],
    ['sales tax', { section: 'Totals', role: 'tax' as const }],
    ['shipping', { section: 'Totals', role: 'shipping' as const }],
    ['shipping & handling', { section: 'Totals', role: 'shipping' as const }],
    ['handling', { section: 'Totals', role: 'shipping' as const }],
    ['discount', { section: 'Totals', role: 'discount' as const }],
    ['promo discount', { section: 'Totals', role: 'discount' as const }],
    ['total', { section: 'Totals', role: 'total' as const }],
    ['order total', { section: 'Totals', role: 'total' as const }],
    ['grand total', { section: 'Totals', role: 'total' as const }],
  ]);

  for (const row of Array.from(document.querySelectorAll('tr'))) {
    const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th'));
    if (cells.length < 2) continue;
    const key = normalise(cells[0].textContent ?? '').replace(/:$/, '').toLowerCase();
    const definition = known.get(key);
    if (!definition) continue;
    const value = cells.at(-1);
    if (!value) continue;
    fieldFromElement(fields, value, cells[0].textContent ?? key, definition.section, /[\$€£¥]\s*\d/.test(value.textContent ?? '') ? 'currency' : 'text', definition.role);
  }
  if (fields.length === 0) {
    for (const element of Array.from(document.querySelectorAll('p, div, li'))) {
      const match = /^\s*([^:]{2,42}):\s*(.+?)\s*$/.exec(normalise(element.textContent ?? ''));
      if (!match) continue;
      const definition = known.get(match[1].toLowerCase());
      if (!definition) continue;
      const id = nextId('field');
      const wrapped = textNodeWrap(element, new RegExp(escapeRegex(match[2])), id);
      if (wrapped) {
        fields.push({ id, label: match[1], section: definition.section, value: match[2], kind: /[\$\u20AC\u00A3\u00A5]\s*\d/.test(match[2]) ? 'currency' : 'text', role: definition.role, removable: true });
      }
    }
  }
  const isItemHeader = (value: string) => /^(item|description|product|service)(?:\s+description)?$/i.test(value);
  const isAmountHeader = (value: string) => /^(amount|line total|total|price)$/i.test(value);
  const isSummaryLabel = (value: string) => /^(subtotal|tax|sales tax|shipping|handling|discount|total|order total|grand total|amount paid)$/i.test(value);
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
    const headerIndex = rows.findIndex((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > th, :scope > td'));
      return cells.some((cell) => isItemHeader(normalise(cell.textContent ?? ''))) && cells.some((cell) => isAmountHeader(normalise(cell.textContent ?? '')));
    });
    if (headerIndex < 0) continue;
    const headerCells = Array.from(rows[headerIndex].querySelectorAll(':scope > th, :scope > td'));
    const descriptionColumn = headerCells.findIndex((cell) => isItemHeader(normalise(cell.textContent ?? '')));
    const amountColumn = headerCells.findIndex((cell) => isAmountHeader(normalise(cell.textContent ?? '')));
    if (descriptionColumn < 0 || amountColumn < 0) continue;
    const foundItems: ReceiptItem[] = [];
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th'));
      const description = cells[descriptionColumn];
      const amountCell = cells[amountColumn];
      const descriptionText = normalise(description?.textContent ?? '');
      const amountText = normalise(amountCell?.textContent ?? '');
      if (!description || !amountCell || !descriptionText || isSummaryLabel(descriptionText) || !/\$?\s*-?\d[\d,]*(?:\.\d{2})?/.test(amountText)) continue;
      const descriptionId = fieldFromElement(fields, description, 'Item description', 'Items ordered');
      const amountId = fieldFromElement(fields, amountCell, 'Item amount', 'Items ordered', 'currency');
      const itemId = nextId('item');
      row.setAttribute('data-rce-item-id', itemId);
      foundItems.push({ id: itemId, descriptionId, amountId, description: descriptionText, amount: money(amountText) });
    }
    if (foundItems.length > 0) {
      table.setAttribute('data-rce-anchor', 'items-host');
      items.push(...foundItems);
      sections.push({ id: 'items-section', label: 'Items ordered', fieldIds: foundItems.flatMap((item) => [item.descriptionId, item.amountId]) });
      break;
    }
  }

  const paidField = fields.find((field) => field.role === 'paid');
  if (paidField) {
    const methodField = fields.find((field) => /^payment method$/i.test(field.label));
    const referenceField = fields.find((field) => /^payment reference$/i.test(field.label));
    payments.push({
      id: nextId('payment'),
      methodId: methodField?.id,
      referenceId: referenceField?.id,
      amountId: paidField.id,
      method: methodField?.value ?? 'Payment',
      reference: referenceField?.value ?? '',
      amount: money(paidField.value),
    });
  }
  return { fields, items, payments, sections, matched: fields.length > 0 };
}

function resourceKey(value: string) {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function resourceDataUri(part: MhtmlPart) {
  const bytes = part.transferEncoding.includes('base64')
    ? part.body.replace(/\s/g, '')
    : encodeBase64(decodePartBytes(part));
  return `data:${part.contentType.split(';')[0]};base64,${bytes}`;
}

function findResource(resources: Map<string, MhtmlPart>, reference: string, base?: string) {
  const direct = resources.get(resourceKey(reference));
  if (direct) return direct;
  if (base && /^https?:/i.test(base)) {
    try {
      return resources.get(resourceKey(new URL(reference, base).href));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rewriteCssResources(css: string, resources: Map<string, MhtmlPart>, warnings: Set<string>, base?: string) {
  return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (original, _quote: string, rawReference: string) => {
    const reference = rawReference.trim();
    if (!reference || /^(?:data:|blob:|#)/i.test(reference)) return original;
    const part = findResource(resources, reference, base);
    if (part) return `url("${resourceDataUri(part)}")`;
    if (/^https?:/i.test(reference)) warnings.add('Some remote artwork was not included in the file and is hidden in the private preview.');
    return original;
  });
}

function buildPreview(html: string, mhtml?: MhtmlContainer) {
  const document = parseHtml(html);
  const resources = new Map<string, MhtmlPart>();
  for (const part of mhtml?.parts ?? []) {
    if (part.contentLocation) resources.set(resourceKey(part.contentLocation), part);
    if (part.contentId) {
      const contentId = part.contentId.trim().replace(/^<|>$/g, '');
      resources.set(resourceKey(contentId), part);
      resources.set(resourceKey(`cid:${contentId}`), part);
    }
  }
  const warnings = new Set<string>();
  for (const link of Array.from(document.querySelectorAll('link[rel~="stylesheet" i][href]'))) {
    const href = link.getAttribute('href') ?? '';
    const part = findResource(resources, href);
    if (part && /^text\/css/i.test(part.contentType)) {
      const style = document.createElement('style');
      style.textContent = rewriteCssResources(decodePart(part), resources, warnings, part.contentLocation);
      link.replaceWith(style);
    } else if (/^https?:/i.test(href)) warnings.add('External styles are preserved for export but blocked in the local preview.');
  }
  for (const style of Array.from(document.querySelectorAll('style'))) {
    style.textContent = rewriteCssResources(style.textContent ?? '', resources, warnings);
  }
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[style]'))) {
    const inlineStyle = element.getAttribute('style');
    if (inlineStyle) element.setAttribute('style', rewriteCssResources(inlineStyle, resources, warnings));
  }
  for (const image of Array.from(document.querySelectorAll('img[src]'))) {
    const source = image.getAttribute('src') ?? '';
    const part = findResource(resources, source);
    if (part && /^image\//i.test(part.contentType)) {
      image.setAttribute('src', resourceDataUri(part));
    } else if (/^https?:/i.test(source)) warnings.add('External images are preserved for export but blocked in the local preview.');
  }
  const csp = document.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:");
  document.head.prepend(csp);
  return { html: serialiseDocument(document), warnings: Array.from(warnings) };
}

function sectionLabel(fields: ReceiptField[]) {
  if (fields.length === 1) return fields[0].label;
  const labels = Array.from(new Set(fields.map((field) => field.section)));
  return labels.length <= 2 ? labels.join(' & ') : `${labels[0]} + ${labels.length - 1} more`;
}

function sectionBranches(host: Element, targets: Element[]) {
  return Array.from(host.children).filter((child) => targets.some((target) => child === target || child.contains(target)));
}

function commonAncestor(targets: Element[]) {
  let candidate: Element | null = targets[0]?.parentElement ?? null;
  while (candidate && !targets.every((target) => candidate?.contains(target))) candidate = candidate.parentElement;
  return candidate;
}

function discoverSections(document: Document, fields: ReceiptField[]) {
  const targets = fields
    .map((field) => document.querySelector(`[data-rce-id="${escapeAttribute(field.id)}"]`))
    .filter((target): target is Element => Boolean(target));
  if (targets.length === 0) return [];

  let host = commonAncestor(targets);
  if (!host) return [];
  let branches = sectionBranches(host, targets);
  while (branches.length < 2 && host.parentElement) {
    host = host.parentElement;
    branches = sectionBranches(host, targets);
  }

  const sections: ReceiptSection[] = [];
  for (const branch of branches) {
    const branchFields = fields.filter((field) => {
      const target = document.querySelector(`[data-rce-id="${escapeAttribute(field.id)}"]`);
      return Boolean(target && (branch === target || branch.contains(target)));
    });
    if (branchFields.length === 0) continue;
    const id = branch.getAttribute('data-rce-layout-section-id') ?? nextId('section');
    branch.setAttribute('data-rce-layout-section-id', id);
    sections.push({ id, label: sectionLabel(branchFields), fieldIds: branchFields.map((field) => field.id) });
  }
  return sections;
}

function syncSections(document: Document, fields: ReceiptField[], supplied: ReceiptSection[]) {
  const previous = new Map(supplied.map((section) => [section.id, section]));
  const sections: ReceiptSection[] = [];
  for (const branch of Array.from(document.querySelectorAll('[data-rce-layout-section-id]'))) {
    const id = branch.getAttribute('data-rce-layout-section-id');
    if (!id) continue;
    const branchFields = fields.filter((field) => {
      const target = document.querySelector(`[data-rce-id="${escapeAttribute(field.id)}"]`);
      return Boolean(target && (branch === target || branch.contains(target)));
    });
    if (branchFields.length === 0) continue;
    sections.push({ id, label: previous.get(id)?.label ?? sectionLabel(branchFields), fieldIds: branchFields.map((field) => field.id) });
  }
  return sections;
}

function detectionFor(stripeMatched: boolean, fields: ReceiptField[], items: ReceiptItem[], payments: PaymentRow[]): ReceiptDetection {
  if (stripeMatched) {
    return { level: 'ready', message: 'Recognized Stripe receipt fields, items, and payment details. Review the preview before exporting.' };
  }
  if (fields.length === 0) {
    return { level: 'manual', message: 'No common receipt labels were found. The original is safe to preview or download; add only the properties you need.' };
  }
  if (items.length === 0 || payments.length === 0) {
    const missing = [items.length === 0 ? 'line items' : '', payments.length === 0 ? 'payment allocation' : ''].filter(Boolean).join(' and ');
    return { level: 'partial', message: `Detected common receipt details, but could not safely identify ${missing}. Confirm the preview and add any missing details manually.` };
  }
  return { level: 'ready', message: 'Detected common receipt details, line items, and payment allocation. Confirm the preview before exporting.' };
}

export function openReceipt(fileName: string, source: string): ReceiptDocument {
  const isMhtml = /\.(mhtml|mht)$/i.test(fileName) || /^content-type:\s*multipart\/related/im.test(source);
  const parsed = isMhtml ? parseMhtml(source) : { html: source, container: undefined };
  const document = parseHtml(parsed.html);
  const stripe = scanStripe(document);
  const generic = stripe.matched ? stripe : scanGeneric(document);
  const detection = detectionFor(stripe.matched, generic.fields, generic.items, generic.payments);
  const previewTexts = discoverPreviewTexts(document);
  const sections = discoverSections(document, generic.fields);
  const html = serialiseDocument(document);
  const preview = buildPreview(html, parsed.container);
  return {
    fileName,
    format: isMhtml ? 'mhtml' : 'html',
    template: stripe.matched ? 'Stripe receipt' : 'Generic receipt',
    originalSource: source,
    html,
    previewHtml: preview.html,
    fields: generic.fields,
    previewTexts,
    items: generic.items,
    payments: generic.payments,
    sections,
    changes: [],
    removedFields: [],
    warnings: preview.warnings,
    currencySymbol: '$',
    detection,
    mhtml: parsed.container,
  };
}

function refresh(document: ReceiptDocument, html: string, changes = document.changes, fields = document.fields) {
  const dom = parseHtml(html);
  const normalizedHtml = serialiseDocument(dom);
  const preview = buildPreview(normalizedHtml, document.mhtml);
  return {
    ...document,
    html: normalizedHtml,
    fields,
    sections: syncSections(dom, fields, document.sections),
    changes,
    previewHtml: preview.html,
    warnings: preview.warnings,
  };
}

function recordChange(changes: ReceiptChange[], change: ReceiptChange) {
  if (change.kind === 'edited') {
    const existingIndex = changes.findIndex((entry) => entry.kind === 'edited' && entry.id === change.id);
    if (existingIndex >= 0) {
      return changes.map((entry, index) => (index === existingIndex ? { ...change, before: entry.before ?? change.before } : entry));
    }
  }
  return [...changes, change];
}

export function updateField(document: ReceiptDocument, id: string, value: string) {
  const field = document.fields.find((entry) => entry.id === id);
  if (!field || field.value === value) return document;
  const dom = parseHtml(document.html);
  const target = dom.querySelector(`[data-rce-id="${escapeAttribute(id)}"]`);
  if (!target) return document;
  if (field.kind === 'attribute') {
    target.setAttribute(field.attribute ?? 'alt', value);
  } else if (field.kind === 'multiline' && field.label === 'Billing details') {
    const label = target.querySelector('div');
    const labelCopy = label?.cloneNode(true);
    target.replaceChildren();
    if (labelCopy) target.append(labelCopy);
    for (const line of value.split(/\r?\n/).filter(Boolean)) {
      const row = dom.createElement('div');
      row.textContent = line;
      target.append(row);
    }
  } else {
    target.textContent = value;
  }
  const fields = document.fields.map((entry) => (entry.id === id ? { ...entry, value } : entry));
  return refresh(document, serialiseDocument(dom), recordChange(document.changes, { id, kind: 'edited', label: field.label, before: field.value, after: value }), fields);
}

export function updatePreviewText(document: ReceiptDocument, id: string, value: string) {
  const previewText = document.previewTexts.find((entry) => entry.id === id);
  if (!previewText || previewText.value === value) return document;
  const dom = parseHtml(document.html);
  const host = dom.querySelector(`[data-rce-text-host-id="${escapeAttribute(previewText.hostId)}"]`);
  if (!host) return document;
  const original = host.textContent ?? '';
  const leading = /^\s*/.exec(original)?.[0] ?? '';
  const trailing = /\s*$/.exec(original)?.[0] ?? '';
  host.textContent = `${leading}${value}${trailing}`;
  const previewTexts = document.previewTexts.map((entry) => (entry.id === id ? { ...entry, value } : entry));
  return refresh(
    { ...document, previewTexts },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'edited', label: previewText.label, before: previewText.value, after: value }),
  );
}

function replaceMany(document: ReceiptDocument, replacements: Array<{ id: string; value: string }>, label: string) {
  if (replacements.length === 0) return document;
  const dom = parseHtml(document.html);
  const changed = new Set(replacements.map((replacement) => replacement.id));
  for (const replacement of replacements) {
    const target = dom.querySelector(`[data-rce-id="${escapeAttribute(replacement.id)}"]`);
    if (target) target.textContent = replacement.value;
  }
  const fields = document.fields.map((field) => {
    const replacement = replacements.find((entry) => entry.id === field.id);
    return replacement ? { ...field, value: replacement.value } : field;
  });
  let changes = document.changes;
  for (const id of changed) {
    const previous = document.fields.find((field) => field.id === id)?.value;
    const next = replacements.find((replacement) => replacement.id === id)?.value;
    changes = recordChange(changes, { id, kind: 'edited', label, before: previous, after: next });
  }
  return refresh(document, serialiseDocument(dom), changes, fields);
}

function calculatedTotal(document: ReceiptDocument, items = document.items, fields = document.fields) {
  const itemTotal = items.reduce((sum, item) => sum + item.amount, 0);
  const adjustments = fields.reduce((sum, field) => {
    const value = money(field.value);
    if (field.role === 'discount') return sum - Math.abs(value);
    if (field.role === 'tax' || field.role === 'shipping' || field.role === 'fee') return sum + value;
    return sum;
  }, 0);
  if (items.length === 0) {
    const displayedTotal = fields.find((field) => field.role === 'total') ?? fields.find((field) => field.role === 'paid');
    return displayedTotal ? money(displayedTotal.value) : adjustments;
  }
  return itemTotal + adjustments;
}

export function updateItem(document: ReceiptDocument, id: string, patch: Partial<Pick<ReceiptItem, 'description' | 'amount'>>) {
  const item = document.items.find((entry) => entry.id === id);
  if (!item) return document;
  const items = document.items.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  let updated = document;
  if (patch.description !== undefined) updated = updateField(updated, item.descriptionId, patch.description);
  if (patch.amount !== undefined) updated = updateField(updated, item.amountId, formatMoney(patch.amount, document.currencySymbol));
  const total = calculatedTotal({ ...updated, items });
  const totalIds = updated.fields.filter((field) => field.role === 'total').map((field) => field.id);
  updated = replaceMany(updated, totalIds.map((targetId) => ({ id: targetId, value: formatMoney(total, document.currencySymbol) })), 'Recalculated total');
  return { ...updated, items };
}

export function updatePayment(document: ReceiptDocument, id: string, patch: Partial<Pick<PaymentRow, 'method' | 'reference' | 'amount'>>) {
  const payment = document.payments.find((entry) => entry.id === id);
  if (!payment) return document;
  let updated = document;
  if (patch.method !== undefined && payment.methodId) updated = updateField(updated, payment.methodId, patch.method);
  if (patch.reference !== undefined && payment.referenceId) updated = updateField(updated, payment.referenceId, patch.reference);
  if (patch.amount !== undefined && payment.amountId) updated = updateField(updated, payment.amountId, formatMoney(patch.amount, document.currencySymbol));
  const payments = updated.payments.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  const paid = payments.reduce((sum, entry) => sum + entry.amount, 0);
  const paidIds = updated.fields.filter((field) => field.role === 'paid').map((field) => field.id);
  updated = replaceMany(updated, paidIds.map((targetId) => ({ id: targetId, value: formatMoney(paid, document.currencySymbol) })), 'Updated payment allocation');
  return { ...updated, payments };
}

export function addItem(document: ReceiptDocument) {
  const dom = parseHtml(document.html);
  const host = dom.querySelector('[data-rce-anchor="items-host"]');
  if (!host) throw new Error('This receipt does not have a safe item table to extend.');
  const itemId = nextId('item');
  const descriptionId = nextId('item-description');
  const amountId = nextId('item-amount');
  const row = dom.createElement('tr');
  row.setAttribute('data-rce-item-id', itemId);
  row.innerHTML = `<td class="Table-description Font Font--body" data-rce-id="${descriptionId}" style="padding: 6px 0; color: #525f7f; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; font-size: 15px; line-height: 24px;">New item</td><td width="8">&nbsp;</td><td class="Table-amount Font Font--body" data-rce-id="${amountId}" align="right" style="padding: 6px 0; color: #525f7f; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; font-size: 15px;">${formatMoney(0, document.currencySymbol)}</td>`;
  const amountPaidLabel = Array.from(host.querySelectorAll('td.Table-description')).find((element) => /^Amount paid$/i.test(normalise(element.textContent ?? '')));
  host.querySelector('tbody')?.insertBefore(row, amountPaidLabel?.closest('tr') ?? null);
  const item: ReceiptItem = { id: itemId, descriptionId, amountId, description: 'New item', amount: 0 };
  const fields: ReceiptField[] = [
    ...document.fields,
    { id: descriptionId, label: 'Item description', section: 'Items ordered', value: item.description, kind: 'text', removable: true },
    { id: amountId, label: 'Item amount', section: 'Items ordered', value: formatMoney(0, document.currencySymbol), kind: 'currency', removable: true },
  ];
  return refresh(
    { ...document, fields, items: [...document.items, item] },
    serialiseDocument(dom),
    recordChange(document.changes, { id: itemId, kind: 'added', label: 'Item row' }),
    fields,
  );
}

export function addPayment(document: ReceiptDocument) {
  const dom = parseHtml(document.html);
  const host = dom.querySelector('[data-rce-anchor="payment-host"]');
  if (!host) throw new Error('This receipt does not have a payment area to extend.');
  const id = nextId('payment');
  const methodId = nextId('payment-method');
  const referenceId = nextId('payment-reference');
  const amountId = nextId('payment-amount');
  const row = dom.createElement('div');
  row.setAttribute('data-rce-payment-id', id);
  row.style.marginTop = '4px';
  row.innerHTML = `<span data-rce-id="${methodId}">Payment</span><span data-rce-id="${referenceId}"> - ref</span><span data-rce-id="${amountId}"> ${formatMoney(0, document.currencySymbol)}</span>`;
  host.append(row);
  const payment: PaymentRow = { id, methodId, referenceId, amountId, method: 'Payment', reference: 'ref', amount: 0, removable: true };
  const fields: ReceiptField[] = [
    ...document.fields,
    { id: methodId, label: 'Payment method', section: 'Payment overview', value: payment.method, kind: 'text', removable: true },
    { id: referenceId, label: 'Payment reference', section: 'Payment overview', value: payment.reference, kind: 'text', removable: true },
    { id: amountId, label: 'Payment amount', section: 'Payment overview', value: formatMoney(0, document.currencySymbol), kind: 'currency', removable: true },
  ];
  return refresh(
    { ...document, fields, payments: [...document.payments, payment] },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'added', label: 'Payment row' }),
    fields,
  );
}

export function removeItem(document: ReceiptDocument, id: string) {
  const dom = parseHtml(document.html);
  dom.querySelector(`[data-rce-item-id="${escapeAttribute(id)}"]`)?.remove();
  const item = document.items.find((entry) => entry.id === id);
  if (!item) return document;
  const items = document.items.filter((entry) => entry.id !== id);
  const fields = document.fields.filter((field) => field.id !== item.descriptionId && field.id !== item.amountId);
  const total = calculatedTotal({ ...document, fields, items });
  let updated = refresh(
    { ...document, fields, items },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'removed', label: item.description || 'Item row' }),
    fields,
  );
  const totalIds = updated.fields.filter((field) => field.role === 'total').map((field) => field.id);
  updated = replaceMany(updated, totalIds.map((targetId) => ({ id: targetId, value: formatMoney(total, document.currencySymbol) })), 'Recalculated total');
  return updated;
}

export function removePayment(document: ReceiptDocument, id: string) {
  if (document.payments.length <= 1) throw new Error('A paid receipt needs at least one payment row.');
  const dom = parseHtml(document.html);
  const payment = document.payments.find((entry) => entry.id === id);
  if (!payment) return document;
  if (!payment.removable) throw new Error('Only payment rows added in this session can be removed.');
  if (payment.amountId) dom.querySelector(`[data-rce-payment-id="${escapeAttribute(id)}"]`)?.remove();
  const fields = document.fields.filter((field) => ![payment.methodId, payment.referenceId, payment.amountId].includes(field.id));
  const payments = document.payments
    .filter((entry) => entry.id !== id)
    .map((entry, index, entries) => (index === entries.length - 1 ? { ...entry, amount: entry.amount + payment.amount } : entry));
  return refresh(
    { ...document, fields, payments },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'removed', label: 'Payment row' }),
    fields,
  );
}

export function removeField(document: ReceiptDocument, id: string) {
  const field = document.fields.find((entry) => entry.id === id);
  if (!field) return document;
  const dom = parseHtml(document.html);
  const target = dom.querySelector(`[data-rce-id="${escapeAttribute(id)}"]`);
  const removalTarget = target?.closest('tr') ?? target;
  if (!removalTarget) return document;
  removalTarget.setAttribute('data-rce-removed-id', id);
  removalTarget.setAttribute('style', `${removalTarget.getAttribute('style') ?? ''}; display: none !important;`);
  const fields = document.fields.filter((entry) => entry.id !== id);
  return refresh(
    { ...document, fields, removedFields: [...document.removedFields, field] },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'removed', label: field.label }),
  );
}

export function restoreField(document: ReceiptDocument, id: string) {
  const field = document.removedFields.find((entry) => entry.id === id);
  if (!field) return document;
  const dom = parseHtml(document.html);
  const target = dom.querySelector<HTMLElement>(`[data-rce-removed-id="${escapeAttribute(id)}"]`);
  if (!target) return document;
  target.removeAttribute('data-rce-removed-id');
  target.style.removeProperty('display');
  const fields = [...document.fields, field];
  return refresh(
    { ...document, fields, removedFields: document.removedFields.filter((entry) => entry.id !== id) },
    serialiseDocument(dom),
    recordChange(document.changes, { id, kind: 'added', label: `Restored ${field.label}` }),
    fields,
  );
}

export function reorderSections(document: ReceiptDocument, sourceId: string, targetId: string, placement: 'before' | 'after') {
  if (sourceId === targetId) return document;
  const sourceSection = document.sections.find((section) => section.id === sourceId);
  const targetSection = document.sections.find((section) => section.id === targetId);
  if (!sourceSection || !targetSection) return document;
  const sourceIndex = document.sections.findIndex((section) => section.id === sourceId);
  const targetIndex = document.sections.findIndex((section) => section.id === targetId);
  if ((placement === 'before' && sourceIndex === targetIndex - 1) || (placement === 'after' && sourceIndex === targetIndex + 1)) return document;

  const dom = parseHtml(document.html);
  const source = dom.querySelector(`[data-rce-layout-section-id="${escapeAttribute(sourceId)}"]`);
  const target = dom.querySelector(`[data-rce-layout-section-id="${escapeAttribute(targetId)}"]`);
  if (!source || !target || !source.parentNode || source.parentNode !== target.parentNode) {
    throw new Error('These receipt sections cannot be moved relative to one another.');
  }

  const parent = source.parentNode;
  const isSectionStart = (node: Node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-rce-layout-section-id');
  const sourceGroup: Node[] = [source];
  let next = source.nextSibling;
  while (next && !isSectionStart(next)) {
    sourceGroup.push(next);
    next = next.nextSibling;
  }
  const fragment = dom.createDocumentFragment();
  for (const node of sourceGroup) fragment.append(node);

  if (placement === 'before') {
    parent.insertBefore(fragment, target);
  } else {
    let insertionPoint = target.nextSibling;
    while (insertionPoint && !isSectionStart(insertionPoint)) insertionPoint = insertionPoint.nextSibling;
    parent.insertBefore(fragment, insertionPoint);
  }

  return refresh(
    document,
    serialiseDocument(dom),
    recordChange(document.changes, {
      id: sourceId,
      kind: 'reordered',
      label: sourceSection.label,
      after: `${placement} ${targetSection.label}`,
    }),
  );
}

export function addBlock(document: ReceiptDocument, type: 'note' | 'address' | 'amount' | 'property') {
  const dom = parseHtml(document.html);
  const blockId = nextId('block');
  const labelId = nextId('block-label');
  const valueId = nextId('block-value');
  const sectionId = nextId('section');
  const label = type === 'note' ? 'Note' : type === 'address' ? 'Shipping details' : type === 'amount' ? 'Additional amount' : 'New property';
  const value = type === 'note' ? 'Add a helpful note for the customer.' : type === 'address' ? 'Name\nStreet address\nCity, State ZIP' : type === 'amount' ? formatMoney(0, document.currencySymbol) : 'Add a value';
  const table = dom.createElement('table');
  table.setAttribute('data-rce-block-id', blockId);
  table.setAttribute('data-rce-layout-section-id', sectionId);
  table.setAttribute('role', 'presentation');
  table.setAttribute('width', '100%');
  table.style.cssText = 'max-width: 504px; margin: 20px auto; border: 1px solid #e6ebf1; border-radius: 8px; border-collapse: separate; background: #fff;';
  table.innerHTML = `<tbody><tr><td style="padding: 14px 16px; color: #525f7f; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; font-size: 15px; line-height: 22px;"><div data-rce-id="${labelId}" style="margin-bottom: 6px; color: #687385; font-size: 12px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;">${label}</div><div data-rce-id="${valueId}" style="white-space: pre-line;">${value}</div></td></tr></tbody>`;
  const footer = Array.from(dom.querySelectorAll('td, p, div')).find((element) => /^If you have any questions/i.test(normalise(element.textContent ?? '')))?.closest('table');
  footer?.parentNode?.insertBefore(table, footer);
  if (!footer) dom.body.append(table);
  const fields: ReceiptField[] = [
    ...document.fields,
    { id: labelId, label: `${label} label`, section: 'Added content', value: label, kind: 'text', removable: true },
    { id: valueId, label, section: 'Added content', value, kind: type === 'amount' ? 'currency' : 'multiline', removable: true },
  ];
  return refresh(
    { ...document, fields },
    serialiseDocument(dom),
    recordChange(document.changes, { id: blockId, kind: 'added', label }),
    fields,
  );
}

export function getTotals(document: ReceiptDocument) {
  const total = calculatedTotal(document);
  const paid = document.payments.length ? document.payments.reduce((sum, payment) => sum + payment.amount, 0) : total;
  return { total, paid, balance: paid - total };
}

function cleanEditorAttributes(html: string) {
  const dom = parseHtml(html);
  for (const element of Array.from(dom.querySelectorAll('[data-rce-removed-id]'))) element.remove();
  for (const wrapper of Array.from(dom.querySelectorAll('[data-rce-inline-wrap]'))) wrapper.replaceWith(...Array.from(wrapper.childNodes));
  for (const element of Array.from(dom.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith('data-rce-')) element.removeAttribute(attribute.name);
    }
  }
  return serialiseDocument(dom);
}

export function exportReceipt(document: ReceiptDocument) {
  const html = cleanEditorAttributes(document.html);
  if (document.format === 'html') return html;
  const container = document.mhtml;
  if (!container) return html;
  const parts = container.parts.map((part) => {
    const body = part.isHtml
      ? part.transferEncoding.includes('base64')
        ? encodeBase64Text(html)
        : encodeQuotedPrintable(html)
      : part.body;
    return `--${container.boundary}${container.lineEnding}${part.headers}${container.lineEnding}${container.lineEnding}${body}${container.lineEnding}`;
  });
  return `${container.header}${container.lineEnding}${container.lineEnding}${parts.join('')}--${container.boundary}--${container.lineEnding}`;
}
