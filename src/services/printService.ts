/**
 * Browser printing for thermal receipts.
 *
 * Drives the browser's own print pipeline (window.print). This is genuinely
 * different from speaking ESC/POS to a printer directly:
 *
 *   - Browser printing renders the receipt as a PAGE and hands it to the OS
 *     print system, which rasterises it for the printer driver. It depends on
 *     the user picking the right printer and paper size in the OS dialog, and
 *     the browser may still apply its own scaling or margins.
 *   - ESC/POS (see escpos.ts) sends command BYTES straight to the device with
 *     no dialog, no driver rasterisation and no scaling.
 *
 * Both are supported. Neither is a substitute for the other.
 */

import type { ReceiptWidth } from './receiptService';

const PAGE_STYLE_ID = 'thermal-page-size';

/** Millimetres per CSS pixel at 96dpi. */
const MM_PER_PX = 25.4 / 96;

/**
 * Feed left after the last line of content, in millimetres.
 *
 * The page is rounded to 0.1mm, so this is the whole of the tail: enough that
 * no rasteriser rounding can shave the final line, small enough that the roll
 * visibly ends just below the footer.
 */
const FEED_TAIL_MM = 0.6;

/**
 * Measured height of the receipt in millimetres, rounded UP to 0.1mm.
 *
 * Rounding up is what makes the page never shorter than its content, so the
 * tail can stay as small as it is. No minimum receipt length is imposed: a
 * one-line order prints a one-line-length slip, and a twenty-line order grows
 * on its own. There is no fixed height anywhere in the receipt layout.
 */
export function measureHeightMm(element: HTMLElement | null): number {
  if (!element) return 1;
  const px = Math.max(element.scrollHeight, element.getBoundingClientRect().height);
  const contentMm = Math.ceil(px * MM_PER_PX * 10) / 10;
  return Math.max(1, Math.round((contentMm + FEED_TAIL_MM) * 10) / 10);
}

/**
 * Inject an `@page` rule matching the paper.
 *
 * Both page dimensions must be explicit lengths. `size: <width> auto` looks
 * reasonable but is INVALID CSS: browsers silently drop the whole descriptor,
 * leaving the print job on the default Letter/A4 sheet with the receipt
 * stranded in a corner. Verified against Chromium's CSSOM, which reports
 * `@page { margin: 0px }` for the `auto` form and keeps `size` only when two
 * lengths are given.
 *
 * The height is therefore measured from the rendered receipt, which also
 * keeps the roll exactly as long as the content: no trailing blank page.
 */
export function applyPageSize(width: ReceiptWidth, heightMm: number): void {
  const existing = document.getElementById(PAGE_STYLE_ID);
  if (existing) existing.remove();

  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.media = 'print';
  style.textContent = `@page { size: ${width} ${heightMm}mm; margin: 0; }`;
  document.head.appendChild(style);
}

export function clearPageSize(): void {
  document.getElementById(PAGE_STYLE_ID)?.remove();
}

export interface PrintOptions {
  width: ReceiptWidth;
  /** Element containing the receipt(s) to print. */
  container: HTMLElement | null;
  /**
   * Print the container's children as separate pages instead of one sheet.
   *
   * Used by "Print Both": the page height is then the tallest single
   * receipt (each `[data-receipt-width]` child), not the whole stack, so
   * the browser places the first receipt on page 1 and the second — after
   * an explicit `break-after: page` set by the caller — on page 2, with no
   * squashing onto one physical page and no third page.
   */
  paginate?: boolean;
}

/**
 * Print the receipt.
 *
 * The container is marked `print-root`, which the print stylesheet uses to
 * strip every other top-level subtree from the printed flow. The element is
 * temporarily moved to be a direct child of <body> so that no scrollable or
 * clipping ancestor can truncate a long receipt to one screen height.
 */
export function printReceipt({ width, container, paginate }: PrintOptions): void {
  if (!container) {
    window.print();
    return;
  }

  const parent = container.parentElement;
  const marker = document.createComment('receipt-print-placeholder');

  // Remember where it came from so the UI is restored exactly.
  if (parent) parent.insertBefore(marker, container);

  container.classList.add('print-root');
  document.body.appendChild(container);

  // Measure AFTER re-parenting: the container is now free of any scrollable
  // ancestor, so scrollHeight reflects the full receipt rather than one
  // screenful. With `paginate`, every receipt child is measured on its own
  // and the tallest one sizes the page.
  let heightMm = measureHeightMm(container);
  if (paginate) {
    const receipts = Array.from(
      container.querySelectorAll<HTMLElement>('[data-receipt-width]'),
    );
    if (receipts.length > 0) {
      heightMm = Math.max(...receipts.map((receipt) => measureHeightMm(receipt)));
    }
  }
  applyPageSize(width, heightMm);

  const restore = () => {
    container.classList.remove('print-root');
    if (parent && marker.parentNode) {
      parent.insertBefore(container, marker);
      marker.remove();
    }
    clearPageSize();
    window.removeEventListener('afterprint', restore);
  };

  window.addEventListener('afterprint', restore);

  try {
    window.print();
  } finally {
    // Chrome fires afterprint reliably; this covers browsers that do not.
    window.setTimeout(() => {
      if (container.classList.contains('print-root')) restore();
    }, 1000);
  }
}
