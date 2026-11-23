// One design for every email Huddle sends: a centred white card on a warm grey page, the team's
// logo and name at the top, and their accent colour on the button. Built from tables with inline
// styles, because that is what renders the same in Gmail, Outlook and Apple Mail.
import type { Config } from '../config';
import type { Db } from '../db/client';
import { DEFAULT_ACCENT } from '../../shared/color';

export type EmailBrand = { name: string; accent: string; logoUrl: string; appUrl: string };

/** The team's name, accent colour and logo (Huddle's mark when they haven't uploaded one). */
export async function emailBrand(db: Db, config: Config): Promise<EmailBrand> {
  const ws = await db.query.workspace.findFirst({ columns: { name: true, accent: true, logoFileId: true } });
  return {
    name: ws?.name ?? 'Huddle',
    accent: ws?.accent ?? DEFAULT_ACCENT,
    logoUrl: ws?.logoFileId
      ? `${config.appUrl}/api/branding/logo?v=${encodeURIComponent(ws.logoFileId)}`
      : `${config.appUrl}/brand/huddle-mark-64.png`,
    appUrl: config.appUrl,
  };
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const INK = '#1f1f1c';
const MUTED = '#5f5e59'; // 6.4:1 on white
const PAGE = '#f4f3ef';
const EDGE = '#e6e3da';

/** Pieces an email is made of; every string is plain text and is escaped here. */
export type Block =
  | { type: 'text'; text: string; muted?: boolean }
  | { type: 'code'; code: string }
  | { type: 'button'; label: string; url: string }
  | { type: 'link'; label: string; url: string }
  | { type: 'item'; title: string; meta: string; text: string; url: string }
  | { type: 'divider' };

const p = (html: string, color = INK, size = 15) =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color}">${html}</p>`;

function block(b: Block, brand: EmailBrand): string {
  switch (b.type) {
    case 'text':
      return p(escapeHtml(b.text), b.muted ? MUTED : INK, b.muted ? 13 : 15);
    case 'code':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="background:${PAGE};border:1px solid ${EDGE};border-radius:10px;padding:14px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${INK}">${escapeHtml(b.code)}</td></tr></table>`;
    case 'button':
      // A "bulletproof" button: the padded cell is the button, so it works without images or CSS.
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="border-radius:999px;background:${brand.accent}"><a href="${escapeHtml(b.url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:#151515;text-decoration:none;border-radius:999px">${escapeHtml(b.label)}</a></td></tr></table>`;
    case 'link':
      return p(
        `${escapeHtml(b.label)}<br><a href="${escapeHtml(b.url)}" style="color:${MUTED};word-break:break-all">${escapeHtml(b.url)}</a>`,
        MUTED,
        13,
      );
    case 'item':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td style="border:1px solid ${EDGE};border-radius:10px;padding:14px 16px"><p style="margin:0 0 4px;font-family:${FONT};font-size:14px;line-height:1.4;color:${INK}"><strong>${escapeHtml(b.title)}</strong> <span style="color:${MUTED}">${escapeHtml(b.meta)}</span></p><p style="margin:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK}">${escapeHtml(b.text)}</p><a href="${escapeHtml(b.url)}" style="font-family:${FONT};font-size:13px;font-weight:600;color:#00664c;text-decoration:none">Open in ${escapeHtml(brand.name)} →</a></td></tr></table>`;
    case 'divider':
      return `<div style="height:1px;background:${EDGE};margin:8px 0 20px;line-height:1px;font-size:1px">&nbsp;</div>`;
  }
}

export type Layout = {
  /** The line mail apps show next to the subject in the inbox. */
  preheader: string;
  heading: string;
  blocks: Block[];
  /** Small print at the bottom: why this email was sent. */
  footer: string;
  /** An unsubscribe link for the footer (summary emails). */
  unsubscribeUrl?: string;
};

export function renderEmail(brand: EmailBrand, l: Layout): string {
  const footerLinks = [
    `<a href="${escapeHtml(brand.appUrl)}" style="color:${MUTED}">Open ${escapeHtml(brand.name)}</a>`,
    ...(l.unsubscribeUrl
      ? [
          `<a href="${escapeHtml(`${brand.appUrl}/settings`)}" style="color:${MUTED}">Email settings</a>`,
          `<a href="${escapeHtml(l.unsubscribeUrl)}" style="color:${MUTED}">Unsubscribe</a>`,
        ]
      : []),
  ].join(' &nbsp;·&nbsp; ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(l.heading)}</title></head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE}">${escapeHtml(l.preheader)}${'&#8199;&#847;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px;vertical-align:middle"><img src="${escapeHtml(brand.logoUrl)}" width="28" height="28" alt="" style="display:block;border:0;border-radius:6px"></td>
<td style="vertical-align:middle;font-family:${FONT};font-size:15px;font-weight:600;color:${INK}">${escapeHtml(brand.name)}</td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${EDGE};border-radius:12px;padding:32px 32px 16px">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${INK}">${escapeHtml(l.heading)}</h1>
${l.blocks.map((b) => block(b, brand)).join('\n')}
</td></tr>
<tr><td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">
<p style="margin:0 0 8px">${escapeHtml(l.footer)}</p>
<p style="margin:0">${footerLinks}</p>
<p style="margin:12px 0 0">Sent by Huddle, ${escapeHtml(brand.name)}’s team chat.</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
