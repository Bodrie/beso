import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { type MailLogo, mailLogo } from './brand.js';
import { MAILER, type Mailer } from './mailer.js';
import {
  type EmailContent,
  accountDeletedEmail,
  emailChangeConfirmEmail,
  emailChangeNoticeEmail,
  emailChangedEmail,
  passwordChangedEmail,
  passwordResetEmail,
  unverifiedExpiryEmail,
  verificationEmail,
} from './templates.js';

export const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const CHANGE_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

type Recipient = { email: string; name: string };

/** Composes the messages we send; links and the logo point at the web app (`WEB_URL`). */
@Injectable()
export class EmailService {
  private readonly webUrl: string;
  private readonly logo: MailLogo;

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    config: ConfigService<Env, true>,
  ) {
    this.webUrl = config.get('WEB_URL', { infer: true }).replace(/\/+$/, '');
    this.logo = mailLogo(this.webUrl);
  }

  sendVerification(to: Recipient, token: string): Promise<void> {
    return this.send(
      to,
      verificationEmail(
        {
          name: to.name,
          link: this.link('/verify-email', token),
          hours: VERIFY_EMAIL_TTL_MS / 3_600_000,
        },
        this.logo,
      ),
    );
  }

  sendPasswordReset(to: Recipient, token: string): Promise<void> {
    return this.send(
      to,
      passwordResetEmail(
        {
          name: to.name,
          link: this.link('/reset-password', token),
          minutes: PASSWORD_RESET_TTL_MS / 60_000,
        },
        this.logo,
      ),
    );
  }

  /** Sent after every password change or reset, so one the owner did not make is noticed. */
  sendPasswordChanged(to: Recipient): Promise<void> {
    return this.send(
      to,
      passwordChangedEmail({ name: to.name, link: `${this.webUrl}/forgot-password` }, this.logo),
    );
  }

  /** To the new address: the link that makes it the account's (ADR 0010 amendment). */
  sendEmailChangeConfirm(to: Recipient, token: string): Promise<void> {
    return this.send(
      to,
      emailChangeConfirmEmail(
        {
          name: to.name,
          link: this.link('/confirm-email', token),
          hours: CHANGE_EMAIL_TTL_MS / 3_600_000,
        },
        this.logo,
      ),
    );
  }

  /** To the old address, when the change is asked for: a heads-up in case it was not the owner. */
  sendEmailChangeNotice(to: Recipient, newEmail: string): Promise<void> {
    return this.send(
      to,
      emailChangeNoticeEmail(
        {
          name: to.name,
          newEmail,
          link: `${this.webUrl}/forgot-password`,
        },
        this.logo,
      ),
    );
  }

  /** To the old address, once the new one is confirmed: the account now answers to another. */
  sendEmailChanged(to: Recipient, newEmail: string): Promise<void> {
    return this.send(
      to,
      emailChangedEmail(
        { name: to.name, newEmail, link: `${this.webUrl}/forgot-password` },
        this.logo,
      ),
    );
  }

  /** Sent after the account is gone; the address is the only thing we still know. */
  sendAccountDeleted(to: Recipient): Promise<void> {
    return this.send(to, accountDeletedEmail({ name: to.name }, this.logo));
  }

  /**
   * The one warning an unconfirmed account gets before it is removed: a fresh confirmation
   * link and the date after which the account goes (JobsService).
   */
  sendUnverifiedExpiry(
    to: Recipient,
    token: string,
    removal: { afterDays: number; on: Date },
  ): Promise<void> {
    return this.send(
      to,
      unverifiedExpiryEmail(
        {
          name: to.name,
          link: this.link('/verify-email', token),
          hours: VERIFY_EMAIL_TTL_MS / 3_600_000,
          afterDays: removal.afterDays,
          removalDate: removal.on.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }),
        },
        this.logo,
      ),
    );
  }

  private send(to: Recipient, content: EmailContent): Promise<void> {
    return this.mailer.send({ to: to.email, ...content });
  }

  private link(path: string, token: string): string {
    return `${this.webUrl}${path}?token=${encodeURIComponent(token)}`;
  }
}
