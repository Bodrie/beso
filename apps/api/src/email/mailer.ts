/** Injection token for the transport; `EmailService` is the only place that composes messages. */
export const MAILER = Symbol('MAILER');

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}
