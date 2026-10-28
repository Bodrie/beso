import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transporter, createTransport } from 'nodemailer';
import type { Env } from '../config/env.js';
import type { Mailer, OutgoingEmail } from './mailer.js';

/**
 * Authenticated SMTP submission to a transactional provider (Resend in production; the
 * box itself never sends mail). Provider-agnostic: only `SMTP_URL` and `EMAIL_FROM` change.
 */
@Injectable()
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('SMTP_URL', { infer: true });
    if (!url) throw new Error('SMTP_URL is required when EMAIL_TRANSPORT is "smtp"');
    this.transport = createTransport(url);
    this.from = config.get('EMAIL_FROM', { infer: true });
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }
}
