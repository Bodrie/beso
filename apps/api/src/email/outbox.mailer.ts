import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { Mailer, OutgoingEmail } from './mailer.js';

/** What lands in the outbox directory, one JSON file per message. */
export type OutboxEntry = OutgoingEmail & { from: string; sentAt: string };

/**
 * Development and test transport: every message becomes a JSON file in `EMAIL_OUTBOX_DIR`.
 * That is the local inbox: open the file (or let Playwright read it) to follow the link.
 * Production refuses this transport (see config/env.ts).
 */
@Injectable()
export class OutboxMailer implements Mailer {
  private readonly logger = new Logger(OutboxMailer.name);
  private readonly dir: string;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    this.dir = path.resolve(config.get('EMAIL_OUTBOX_DIR', { infer: true }));
    this.from = config.get('EMAIL_FROM', { infer: true });
  }

  async send(email: OutgoingEmail): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: OutboxEntry = { from: this.from, ...email, sentAt: new Date().toISOString() };
    const file = path.join(this.dir, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(entry, null, 2));
    this.logger.log({ to: email.to, subject: email.subject, file }, 'Email written to the outbox');
  }
}
