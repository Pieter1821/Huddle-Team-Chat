import type { Email } from '../../lib/email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const layout = (body: string) =>
  `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#151515;max-width:480px">${body}<p style="color:#5f5e59;font-size:13px">If you didn't ask for this, you can ignore this email.</p></div>`;

export const signInCodeEmail = (to: string, code: string, workspaceName: string): Email => ({
  to,
  subject: `${code} is your ${workspaceName} sign-in code`,
  text: `Your sign-in code for ${workspaceName} is ${code}.\nIt works once and expires in 5 minutes.`,
  html: layout(
    `<p>Your sign-in code for ${escapeHtml(workspaceName)}:</p><p style="font-size:32px;font-weight:600;letter-spacing:4px;margin:16px 0">${code}</p><p>It works once and expires in 5 minutes.</p>`,
  ),
});

export const magicLinkEmail = (to: string, url: string, workspaceName: string): Email => ({
  to,
  subject: `Sign in to ${workspaceName}`,
  text: `Open this link to sign in to ${workspaceName}:\n${url}\nIt works once and expires in 5 minutes.`,
  html: layout(
    `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#00b18c;color:#151515;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Sign in to ${escapeHtml(workspaceName)}</a></p><p>It works once and expires in 5 minutes.</p>`,
  ),
});

export const invitationEmail = (
  to: string,
  url: string,
  workspaceName: string,
  inviterName: string,
  asGuest: boolean,
): Email => ({
  to,
  subject: `${inviterName} invited you to ${workspaceName} on Huddle`,
  text: `${inviterName} invited you to join ${workspaceName}${asGuest ? ' as a guest' : ''}.\nAccept here: ${url}\nThe link expires in 7 days.`,
  html: layout(
    `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(workspaceName)}</strong>${asGuest ? ' as a guest' : ''}.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#00b18c;color:#151515;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Accept invitation</a></p><p>The link expires in 7 days.</p>`,
  ),
});
