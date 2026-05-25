/**
 * Single email-sending adapter for MissionControl.
 *
 * Provider: Cloudflare Email Service (Task 0.1 decision).
 *   Docs: https://developers.cloudflare.com/email-service/get-started/send-emails/
 *   Binding declared in wrangler.jsonc as `send_email` with name "EMAIL".
 *
 * All call sites (better-auth's sendVerificationEmail / sendResetPassword /
 * sendMagicLink hooks) go through `sendEmail()` below. To swap providers
 * (MailChannels, Resend, SES, etc.) edit ONLY that function.
 *
 * Dev/test mode: when EMAIL_FROM is unset, sendEmail() logs and returns
 * without dispatching. This lets the test environment exercise the full
 * sign-up → verify-email flow without configuring real outbound email.
 *
 * Templates: inline HTML (transactional minimums — verify, reset, magic link,
 * password-changed). If/when we need richer styling, swap in React Email.
 */

export type SendEmailArgs = { to: string; subject: string; html: string; text: string };

/** Cloudflare Email Service binding shape (subset we use). */
type EmailBinding = {
  send: (m: { to: string; from: string; subject: string; html: string; text?: string }) => Promise<{ messageId: string }>;
};

type EmailEnv = { EMAIL_FROM?: string; EMAIL?: EmailBinding };

export async function sendEmail(env: EmailEnv, args: SendEmailArgs): Promise<void> {
  if (!env.EMAIL_FROM) {
    // Dev/test: no provider configured. Log-only.
    console.warn('[email] EMAIL_FROM not set — skipping send.', { to: args.to, subject: args.subject });
    return;
  }
  if (!env.EMAIL) {
    throw new Error('[email] EMAIL_FROM is set but the EMAIL binding is missing — check wrangler.jsonc');
  }
  const result = await env.EMAIL.send({
    to: args.to,
    from: env.EMAIL_FROM,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
  if (!result?.messageId) {
    throw new Error(`[email] CES send returned no messageId: ${JSON.stringify(result)}`);
  }
}

// ---------------------------------------------------------------------------
// Templates (inline HTML — keep transactional minimums)
// ---------------------------------------------------------------------------

const BUTTON_STYLE =
  'display:inline-block;background:#000;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;';
const BODY_STYLE =
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.5;color:#222;max-width:560px;margin:0 auto;padding:32px 24px;';

function shell(body: string): string {
  return `<!doctype html><html><body style="${BODY_STYLE}">${body}</body></html>`;
}

function verifyEmailHtml(url: string, userName: string): string {
  return shell(`
    <h1 style="font-size:24px;margin:0 0 16px;">Verify your MissionControl email</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>Click the button below to confirm your email and finish signing in.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(url)}" style="${BUTTON_STYLE}">Verify email</a>
    </p>
    <p style="font-size:12px;color:#666;">If the button doesn't work, paste this URL into your browser:<br/>
    <code>${escapeHtml(url)}</code></p>
  `);
}

function resetPasswordHtml(url: string, userName: string): string {
  return shell(`
    <h1 style="font-size:24px;margin:0 0 16px;">Reset your MissionControl password</h1>
    <p>Hi ${escapeHtml(userName)},</p>
    <p>Click the button below to set a new password. This link expires soon.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(url)}" style="${BUTTON_STYLE}">Reset password</a>
    </p>
    <p style="font-size:12px;color:#666;">If you didn't request this, you can ignore this email.</p>
    <p style="font-size:12px;color:#666;">URL: <code>${escapeHtml(url)}</code></p>
  `);
}

function magicLinkHtml(url: string): string {
  return shell(`
    <h1 style="font-size:24px;margin:0 0 16px;">Sign in to MissionControl</h1>
    <p>Click the button below to sign in. This link expires soon.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(url)}" style="${BUTTON_STYLE}">Sign in</a>
    </p>
    <p style="font-size:12px;color:#666;">If you didn't request this, you can ignore this email.</p>
    <p style="font-size:12px;color:#666;">URL: <code>${escapeHtml(url)}</code></p>
  `);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// better-auth hook callees — each `delivers` one email via sendEmail() above.
//
// Helper names are `deliverXEmail` rather than `sendXEmail` so the function
// names never collide with better-auth's hook names (`sendVerificationEmail`,
// `sendResetPassword`, `sendMagicLink`). Avoids self-referential shadowing
// pitfalls when wiring into the config.
// ---------------------------------------------------------------------------

export async function deliverVerificationEmail(
  env: EmailEnv,
  params: { user: { email: string; name?: string }; url: string },
): Promise<void> {
  const userName = params.user.name ?? params.user.email;
  await sendEmail(env, {
    to: params.user.email,
    subject: 'Verify your MissionControl email',
    html: verifyEmailHtml(params.url, userName),
    text: `Verify your email: ${params.url}`,
  });
}

export async function deliverResetPasswordEmail(
  env: EmailEnv,
  params: { user: { email: string; name?: string }; url: string },
): Promise<void> {
  const userName = params.user.name ?? params.user.email;
  await sendEmail(env, {
    to: params.user.email,
    subject: 'Reset your MissionControl password',
    html: resetPasswordHtml(params.url, userName),
    text: `Reset your password: ${params.url}`,
  });
}

export async function deliverMagicLinkEmail(
  env: EmailEnv,
  params: { email: string; url: string },
): Promise<void> {
  await sendEmail(env, {
    to: params.email,
    subject: 'Sign in to MissionControl',
    html: magicLinkHtml(params.url),
    text: `Sign in: ${params.url}`,
  });
}
