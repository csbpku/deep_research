import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransport },
}));

import { sendRegistrationVerificationEmail } from './verification-mailer';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  mocks.sendMail.mockResolvedValue({ messageId: 'test' });
});

describe('sendRegistrationVerificationEmail', () => {
  it('requires STARTTLS for authenticated SMTP and sends the one-time code', async () => {
    await sendRegistrationVerificationEmail('alice@example.com', '123456', {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      SMTP_FROM: 'Research <noreply@example.com>',
    });

    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer', pass: 'secret' },
    }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alice@example.com',
      subject: '注册验证码',
      text: expect.stringContaining('123456'),
    }));
  });
});
