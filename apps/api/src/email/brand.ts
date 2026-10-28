import { MAIL_LOGO } from './mail-logo.js';

/** The accent of the mark; the mails' buttons and links use the same blue. */
export const BRAND_COLOR = '#006aaf';

/** The picture the layout's header shows: where it is and how large (CSS pixels). */
export type MailLogo = { url: string; width: number; height: number };

/**
 * The logo (the wordmark on a white tile, written to `apps/web/public` by `pnpm brand`) as the
 * web app serves it. Hosted rather than attached (an inline `cid:` picture, as before
 * 2026-10-28): some webmail and Resend's own preview drop inline pictures, and the attachment
 * rode in every mail although it never changes. The file is ours and its address carries
 * nothing about the reader, so nothing is tracked through it; a client that blocks remote
 * pictures shows the name instead (`alt`).
 */
export function mailLogo(webUrl: string): MailLogo {
  return { url: `${webUrl}${MAIL_LOGO.path}`, width: MAIL_LOGO.width, height: MAIL_LOGO.height };
}
