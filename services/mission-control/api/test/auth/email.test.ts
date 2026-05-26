import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sendEmail,
  deliverVerificationEmail,
  deliverResetPasswordEmail,
  deliverMagicLinkEmail,
} from '../../src/auth/email.ts'

describe('email adapter', () => {
  describe('sendEmail', () => {
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
    })

    it('no-ops + logs when EMAIL_FROM is unset (dev/test mode)', async () => {
      await sendEmail({}, { to: 'a@b.c', subject: 'hi', html: '<p>x</p>', text: 'x' })
      expect(warn).toHaveBeenCalledWith(
        '[email] EMAIL_FROM not set — skipping send.',
        expect.objectContaining({ to: 'a@b.c', subject: 'hi' }),
      )
    })

    it('throws when EMAIL_FROM is set but the EMAIL binding is missing', async () => {
      await expect(
        sendEmail(
          { EMAIL_FROM: 'x@y' },
          { to: 'a@b.c', subject: 'hi', html: '<p>x</p>', text: 'x' },
        ),
      ).rejects.toThrow(/EMAIL binding is missing/)
    })

    it('calls env.EMAIL.send with from/to/subject/html/text when both env vars present', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'msg_1' })
      await sendEmail(
        { EMAIL_FROM: 'sender@example.com', EMAIL: { send } },
        { to: 'a@b.c', subject: 'hi', html: '<p>x</p>', text: 'x' },
      )
      expect(send).toHaveBeenCalledWith({
        to: 'a@b.c',
        from: 'sender@example.com',
        subject: 'hi',
        html: '<p>x</p>',
        text: 'x',
      })
    })

    it('throws when CES returns no messageId', async () => {
      const send = vi.fn().mockResolvedValue({})
      await expect(
        sendEmail(
          { EMAIL_FROM: 'sender@example.com', EMAIL: { send } },
          { to: 'a@b.c', subject: 'hi', html: '<p>x</p>', text: 'x' },
        ),
      ).rejects.toThrow(/no messageId/)
    })
  })

  describe('deliverVerificationEmail', () => {
    it('renders + sends with the verification subject and embeds the URL', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'msg_2' })
      await deliverVerificationEmail(
        { EMAIL_FROM: 'sender@example.com', EMAIL: { send } },
        { user: { email: 'a@b.c', name: 'Alice' }, url: 'https://app/verify?token=xyz' },
      )
      const call: any = send.mock.calls[0]![0]
      expect(call.subject).toMatch(/Verify your MissionControl email/)
      expect(call.html).toContain('https://app/verify?token=xyz')
      expect(call.html).toContain('Alice')
      expect(call.text).toContain('https://app/verify?token=xyz')
    })

    it('falls back to email when user name missing', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'm' })
      await deliverVerificationEmail(
        { EMAIL_FROM: 'sender@example.com', EMAIL: { send } },
        { user: { email: 'a@b.c' }, url: 'https://x' },
      )
      expect(send.mock.calls[0]![0].html).toContain('a@b.c')
    })

    it('escapes HTML in user-supplied strings (XSS guard)', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'm' })
      await deliverVerificationEmail(
        { EMAIL_FROM: 'sender@example.com', EMAIL: { send } },
        { user: { email: 'a@b.c', name: '<script>alert(1)</script>' }, url: 'https://x' },
      )
      const html = send.mock.calls[0]![0].html
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })
  })

  describe('deliverResetPasswordEmail', () => {
    it('sends with reset subject', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'm' })
      await deliverResetPasswordEmail(
        { EMAIL_FROM: 'x@y', EMAIL: { send } },
        { user: { email: 'a@b.c' }, url: 'https://reset' },
      )
      expect(send.mock.calls[0]![0].subject).toMatch(/Reset your MissionControl password/)
    })
  })

  describe('deliverMagicLinkEmail', () => {
    it('sends with sign-in subject', async () => {
      const send = vi.fn().mockResolvedValue({ messageId: 'm' })
      await deliverMagicLinkEmail(
        { EMAIL_FROM: 'x@y', EMAIL: { send } },
        { email: 'a@b.c', url: 'https://link' },
      )
      expect(send.mock.calls[0]![0].subject).toMatch(/Sign in to MissionControl/)
      expect(send.mock.calls[0]![0].html).toContain('https://link')
    })
  })
})
