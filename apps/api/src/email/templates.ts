import { BRAND_COLOR, type MailLogo } from './brand.js';

export type EmailContent = { subject: string; text: string; html: string };

const BRAND = 'BeSo';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * One plain layout for every message, readable in any client: the only picture is the logo,
 * served by the web app (see brand.ts), on its own tile so a client's dark mode cannot hide it.
 */
function layout(
  logo: MailLogo,
  title: string,
  paragraphs: string[],
  link?: { label: string; href: string },
) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  const button = link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link.href)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${escapeHtml(link.label)}</a></p>`
    : '';
  const fallback = link
    ? `<p style="margin:0 0 16px;color:#5b6472;font-size:13px">If the button does not work, copy this address into your browser:<br><a href="${escapeHtml(link.href)}" style="color:${BRAND_COLOR};word-break:break-all">${escapeHtml(link.href)}</a></p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2330;font-size:16px;line-height:1.5"><div style="max-width:520px;margin:0 auto;padding:32px 20px"><p style="margin:0 0 24px"><img src="${escapeHtml(logo.url)}" width="${logo.width}" height="${logo.height}" alt="${BRAND}" style="display:block;width:${logo.width}px;height:${logo.height}px;border:0"></p><div style="background:#ffffff;border-radius:14px;padding:28px 24px;border:1px solid #e3e7ee"><h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>${body}${button}${fallback}</div><p style="margin:24px 0 0;color:#8a93a1;font-size:12px">You received this email because an account on ${BRAND} uses this address. If that was not you, you can ignore it.</p></div></body></html>`;
}

export function verificationEmail(
  input: {
    name: string;
    link: string;
    hours: number;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  return {
    subject: `Confirm your email address for ${BRAND}`,
    text: [
      `Hi ${input.name},`,
      '',
      `Welcome to ${BRAND}. Confirm your email address to start using your account:`,
      input.link,
      '',
      `The link works for ${input.hours} hours. If you did not create an account, ignore this email.`,
    ].join('\n'),
    html: layout(
      logo,
      'Confirm your email address',
      [
        `Hi ${name},`,
        `Welcome to ${BRAND}. One click and your account is ready.`,
        `The link works for ${input.hours} hours. If you did not create an account, ignore this email.`,
      ],
      { label: 'Confirm email address', href: input.link },
    ),
  };
}

export function passwordResetEmail(
  input: {
    name: string;
    link: string;
    minutes: number;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  return {
    subject: `Reset your ${BRAND} password`,
    text: [
      `Hi ${input.name},`,
      '',
      `Someone asked to reset the password of your ${BRAND} account. If that was you, choose a new one here:`,
      input.link,
      '',
      `The link works for ${input.minutes} minutes and only once. If you did not ask for this, ignore this email; your password stays as it is.`,
    ].join('\n'),
    html: layout(
      logo,
      'Reset your password',
      [
        `Hi ${name},`,
        `Someone asked to reset the password of your ${BRAND} account. If that was you, choose a new one with the button below.`,
        `The link works for ${input.minutes} minutes and only once. If you did not ask for this, ignore this email; your password stays as it is.`,
      ],
      { label: 'Choose a new password', href: input.link },
    ),
  };
}

/** A notice, not a link to act on unless the change was not the owner's own. */
export function passwordChangedEmail(
  input: { name: string; link: string },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  return {
    subject: `Your ${BRAND} password was changed`,
    text: [
      `Hi ${input.name},`,
      '',
      `The password of your ${BRAND} account was just changed. If that was you, there is nothing to do.`,
      '',
      `If it was not you, choose a new password right away; that also signs out every other device:`,
      input.link,
    ].join('\n'),
    html: layout(
      logo,
      'Your password was changed',
      [
        `Hi ${name},`,
        `The password of your ${BRAND} account was just changed. If that was you, there is nothing to do.`,
        `If it was not you, choose a new password right away; that also signs out every other device.`,
      ],
      { label: 'Choose a new password', href: input.link },
    ),
  };
}

/** To the new address: the link that makes it the account's (ADR 0010 amendment). */
export function emailChangeConfirmEmail(
  input: {
    name: string;
    link: string;
    hours: number;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  return {
    subject: `Confirm your new email address for ${BRAND}`,
    text: [
      `Hi ${input.name},`,
      '',
      `You asked to use this address for your ${BRAND} account. Confirm it and it replaces the old one:`,
      input.link,
      '',
      `The link works for ${input.hours} hours and only once. If you did not ask for this, ignore this email; the account keeps its current address.`,
    ].join('\n'),
    html: layout(
      logo,
      'Confirm your new email address',
      [
        `Hi ${name},`,
        `You asked to use this address for your ${BRAND} account. One click and it replaces the old one.`,
        `The link works for ${input.hours} hours and only once. If you did not ask for this, ignore this email; the account keeps its current address.`,
      ],
      { label: 'Confirm new address', href: input.link },
    ),
  };
}

/** To the old address, when the change is asked for: the owner must hear about it there. */
export function emailChangeNoticeEmail(
  input: {
    name: string;
    newEmail: string;
    link: string;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  const newEmail = escapeHtml(input.newEmail);
  return {
    subject: `Someone asked to change the email address of your ${BRAND} account`,
    text: [
      `Hi ${input.name},`,
      '',
      `A request was made to move your ${BRAND} account to ${input.newEmail}. Nothing changes until a link sent to that address is opened.`,
      '',
      `If that was you, there is nothing to do here. If it was not, change your password right away; that also cancels the request and signs out every other device:`,
      input.link,
    ].join('\n'),
    html: layout(
      logo,
      'A change of email address was requested',
      [
        `Hi ${name},`,
        `A request was made to move your ${BRAND} account to <strong>${newEmail}</strong>. Nothing changes until a link sent to that address is opened.`,
        `If that was you, there is nothing to do here. If it was not, change your password right away; that also cancels the request and signs out every other device.`,
      ],
      { label: 'Change my password', href: input.link },
    ),
  };
}

/** To the old address, once the new one is confirmed. */
export function emailChangedEmail(
  input: {
    name: string;
    newEmail: string;
    link: string;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  const newEmail = escapeHtml(input.newEmail);
  return {
    subject: `The email address of your ${BRAND} account was changed`,
    text: [
      `Hi ${input.name},`,
      '',
      `Your ${BRAND} account now uses ${input.newEmail}. This address no longer signs you in.`,
      '',
      `If that was not you, reset the password from the new address right away or reply to this email:`,
      input.link,
    ].join('\n'),
    html: layout(
      logo,
      'Your email address was changed',
      [
        `Hi ${name},`,
        `Your ${BRAND} account now uses <strong>${newEmail}</strong>. This address no longer signs you in.`,
        `If that was not you, reply to this email right away.`,
      ],
      { label: 'Reset the password', href: input.link },
    ),
  };
}

/** The one warning before an account that never confirmed its address is removed (JobsService). */
export function unverifiedExpiryEmail(
  input: {
    name: string;
    link: string;
    hours: number;
    afterDays: number;
    removalDate: string;
  },
  logo: MailLogo,
): EmailContent {
  const name = escapeHtml(input.name);
  const situation = `You created a ${BRAND} account with this address but never confirmed it, so it has stayed closed. Accounts that are not confirmed are removed after ${input.afterDays} days: yours will be removed after ${input.removalDate}, with everything in it.`;
  const validity = `The link works for ${input.hours} hours; after that, sign in and ask for a new one. If you do not want the account, there is nothing to do.`;
  return {
    subject: `Confirm your email address or your ${BRAND} account will be removed`,
    text: [
      `Hi ${input.name},`,
      '',
      situation,
      '',
      'To keep it, confirm the address now:',
      input.link,
      '',
      validity,
    ].join('\n'),
    html: layout(
      logo,
      'Confirm your email address to keep your account',
      [`Hi ${name},`, escapeHtml(situation), escapeHtml(validity)],
      { label: 'Confirm email address', href: input.link },
    ),
  };
}

/** The last mail an account gets: confirmation that it, and everything it published, is gone. */
export function accountDeletedEmail(input: { name: string }, logo: MailLogo): EmailContent {
  const name = escapeHtml(input.name);
  return {
    subject: `Your ${BRAND} account was deleted`,
    text: [
      `Hi ${input.name},`,
      '',
      `Your ${BRAND} account was deleted, as you asked. Your posts, comments, messages and pictures are gone with it; backups are kept for 14 days and then it is gone from them too.`,
      '',
      `If this was not you, reply to this email right away. Otherwise there is nothing to do, and thank you for having been part of ${BRAND}.`,
    ].join('\n'),
    html: layout(logo, 'Your account was deleted', [
      `Hi ${name},`,
      `Your ${BRAND} account was deleted, as you asked. Your posts, comments, messages and pictures are gone with it; backups are kept for 14 days and then it is gone from them too.`,
      `If this was not you, reply to this email right away. Otherwise there is nothing to do, and thank you for having been part of ${BRAND}.`,
    ]),
  };
}
