import { env } from '../config/env';

/**
 * EmailService interface (PLAN OQ2). MVP-1 default provider = 'console' → logs tokens/links
 * instead of sending. Swap to Resend/SMTP in MVP-2 by implementing sendEmail for that provider.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === 'console') {
    // eslint-disable-next-line no-console
    console.log(
      `\n[email:console] To: ${msg.to}\n  Subject: ${msg.subject}\n  ${msg.body}\n`,
    );
    return;
  }
  // MVP-2: implement Resend/SMTP here behind this same interface.
  // eslint-disable-next-line no-console
  console.warn(`[email] provider '${env.EMAIL_PROVIDER}' not implemented; message dropped.`);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'KosManager — Reset your password',
    body: `Use this token to reset your password (valid 1h): ${token}`,
  });
}

export async function sendInviteEmail(to: string, token: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'KosManager — You have been invited',
    body: `Accept your team invite with this token (valid 7d): ${token}`,
  });
}

export async function sendVerificationEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'KosManager — Verify your email',
    body: `Welcome to KosManager! (soft verification — account already usable in MVP-1)`,
  });
}
