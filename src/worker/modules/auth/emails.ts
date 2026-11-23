import type { Email } from '../../lib/email';
import { renderEmail, type EmailBrand } from '../../lib/email-layout';

export const signInCodeEmail = (to: string, code: string, brand: EmailBrand): Email => ({
  to,
  subject: `${code} is your ${brand.name} sign-in code`,
  text: [
    `Your sign-in code for ${brand.name} is ${code}.`,
    '',
    'Enter it in Huddle to sign in. It works once and expires in 5 minutes.',
    '',
    'If you didn’t try to sign in, you can ignore this email: nobody can sign in without the code.',
  ].join('\n'),
  html: renderEmail(brand, {
    preheader: `${code} is your code. It expires in 5 minutes.`,
    heading: 'Your sign-in code',
    blocks: [
      { type: 'text', text: `Enter this code to sign in to ${brand.name}:` },
      { type: 'code', code },
      { type: 'text', text: 'It works once and expires in 5 minutes.', muted: true },
    ],
    footer: 'If you didn’t try to sign in, you can ignore this email: nobody can sign in without the code.',
  }),
});

export const magicLinkEmail = (to: string, url: string, brand: EmailBrand): Email => ({
  to,
  subject: `Sign in to ${brand.name}`,
  text: `Open this link to sign in to ${brand.name}:\n${url}\n\nIt works once and expires in 5 minutes.\nIf you didn’t ask for it, you can ignore this email.`,
  html: renderEmail(brand, {
    preheader: 'Your sign-in link. It expires in 5 minutes.',
    heading: `Sign in to ${brand.name}`,
    blocks: [
      { type: 'text', text: 'Use the button to sign in. It works once and expires in 5 minutes.' },
      { type: 'button', label: `Sign in to ${brand.name}`, url },
      { type: 'link', label: 'Or open this link:', url },
    ],
    footer: 'If you didn’t ask to sign in, you can ignore this email.',
  }),
});

export const invitationEmail = (
  to: string,
  url: string,
  brand: EmailBrand,
  inviterName: string,
  asGuest: boolean,
): Email => ({
  to,
  subject: `${inviterName} invited you to ${brand.name} on Huddle`,
  text: [
    `${inviterName} invited you to join ${brand.name}${asGuest ? ' as a guest' : ''} on Huddle, the team’s chat.`,
    '',
    `Accept the invitation: ${url}`,
    '',
    'The link expires in 7 days. No password needed: you sign in with a code sent to this address.',
  ].join('\n'),
  html: renderEmail(brand, {
    preheader: `Join ${brand.name} on Huddle.`,
    heading: `${inviterName} invited you to ${brand.name}`,
    blocks: [
      {
        type: 'text',
        text: asGuest
          ? `You’re invited as a guest: you’ll see only the conversations you’re added to.`
          : `Join the team’s conversations, threads and files in one place.`,
      },
      { type: 'button', label: 'Accept invitation', url },
      {
        type: 'text',
        text: 'No password needed: you sign in with a code sent to this address. The invitation expires in 7 days.',
        muted: true,
      },
      { type: 'link', label: 'Or open this link:', url },
    ],
    footer: `You got this because ${inviterName} invited ${to}. If you weren’t expecting it, you can ignore it.`,
  }),
});

export const testEmail = (to: string, brand: EmailBrand, from: string): Email => ({
  to,
  subject: `Email from ${brand.name} is working`,
  text: `This is a test from ${brand.name}. Sign-in codes and email summaries will be sent from ${from}.`,
  html: renderEmail(brand, {
    preheader: 'Your workspace can send email.',
    heading: 'Email is working',
    blocks: [
      { type: 'text', text: `Sign-in codes, invitations and email summaries will be sent from ${from}.` },
      { type: 'button', label: `Open ${brand.name}`, url: brand.appUrl },
    ],
    footer: 'You got this because you asked for a test email in Admin › Email.',
  }),
});
