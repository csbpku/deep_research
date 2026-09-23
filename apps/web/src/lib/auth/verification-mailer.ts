import nodemailer from 'nodemailer';
import type { WebEnv } from '@/lib/env';

type MailEnv = Pick<WebEnv, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM'>;

export async function sendRegistrationVerificationEmail(
  email: string,
  code: string,
  env: MailEnv,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE && Boolean(env.SMTP_USER),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });

  await transport.sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject: '注册验证码',
    text: `你的注册验证码是 ${code}。验证码 10 分钟内有效，请勿转发。`,
    html: `<p>你的注册验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码 10 分钟内有效，请勿转发。</p>`,
  });
}
