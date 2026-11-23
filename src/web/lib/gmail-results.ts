/** What came back from Google, in words (the callback adds ?gmail=… to this page). */
export const GMAIL_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Gmail is connected. Huddle sends email from it now.' },
  denied: { ok: false, text: 'Google wasn’t given permission, so nothing changed.' },
  scope: {
    ok: false,
    text: 'Huddle needs permission to send email. Connect again and tick “Send email on your behalf”.',
  },
  'wrong-account': {
    ok: false,
    text: 'That Google account can’t be used here. Use the owner’s account, or the one that was connected before.',
  },
  expired: { ok: false, text: 'That took too long or was started elsewhere. Try connecting again.' },
  forbidden: { ok: false, text: 'Only owners and admins can change how Huddle sends email.' },
  failed: { ok: false, text: 'Google didn’t complete the connection. Try again.' },
};
