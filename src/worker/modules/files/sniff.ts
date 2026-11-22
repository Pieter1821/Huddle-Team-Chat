// Works out a file's real type from its first bytes ("magic bytes"), never from its name or the
// browser's claim. Renaming malware.exe to photo.jpg does not make it an image.

type Detected = { mime: string; inline: boolean };

const SIGNATURES: { mime: string; inline: boolean; bytes: (number | null)[]; offset?: number }[] = [
  { mime: 'image/png', inline: true, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', inline: true, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', inline: true, bytes: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP
  {
    mime: 'image/webp',
    inline: true,
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  { mime: 'application/pdf', inline: true, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // ZIP containers: .docx, .xlsx, .pptx and plain .zip all start with PK\x03\x04.
  { mime: 'application/zip', inline: false, bytes: [0x50, 0x4b, 0x03, 0x04] },
];

const OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const matches = (head: Uint8Array, bytes: (number | null)[]) =>
  bytes.every((b, i) => b === null || head[i] === b);

/** Plain text (CSV, .txt, .md): valid UTF-8 with no control characters other than whitespace. */
function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      head.subarray(0, Math.min(head.length, 4096)),
    );
    // eslint-disable-next-line no-control-regex -- detecting control characters is the point here
    return !/[\u0000-\u0008\u000e-\u001f]/.test(text) && !/^\s*</.test(text); // no HTML/SVG/XML as "text"
  } catch {
    return false;
  }
}

export function detectType(head: Uint8Array, fileName: string): Detected {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  for (const sig of SIGNATURES) {
    if (matches(head, sig.bytes)) {
      // A ZIP named .docx/.xlsx/.pptx is the Office format; the content check already passed.
      if (sig.mime === 'application/zip' && OFFICE[ext]) return { mime: OFFICE[ext], inline: false };
      return { mime: sig.mime, inline: sig.inline };
    }
  }
  if (looksLikeText(head)) return { mime: ext === 'csv' ? 'text/csv' : 'text/plain', inline: false };
  // Anything else is stored but only ever offered as a download, never shown in the browser.
  return { mime: 'application/octet-stream', inline: false };
}

/** Keeps a readable name but strips paths, control characters and anything that could break headers. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point here
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

export const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
