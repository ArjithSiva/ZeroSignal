/**
 * Pluggable mail. Transports:
 *   console — prints the message (links included) to the server log. Development default.
 *   smtp    — real delivery through nodemailer (SMTP_URL).
 *   memory  — keeps messages in `outbox` (tests).
 */
import nodemailer from 'nodemailer';

export function createMailer(mail = { transport: 'console', from: 'ZeroSignal <no-reply@localhost>' }, { log = console.log } = {}) {
  const outbox = [];
  let smtp = null;
  const getSmtp = () => (smtp ??= nodemailer.createTransport(mail.smtpUrl));

  return {
    transport: mail.transport,
    outbox,
    /** @param {{ to: string, subject: string, text: string }} msg */
    async send(msg) {
      const full = { from: mail.from, ...msg };
      if (mail.transport === 'memory') {
        outbox.push(full);
        return { delivered: true };
      }
      if (mail.transport === 'smtp') {
        await getSmtp().sendMail(full);
        return { delivered: true };
      }
      log(`\n✉  [mail:console] to=${full.to}\n   subject: ${full.subject}\n${full.text.split('\n').map((l) => `   ${l}`).join('\n')}\n`);
      return { delivered: false, note: 'console transport: not actually sent' };
    },
  };
}
