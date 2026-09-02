export async function sendMagicLinkEmail(env: Env, to: string, verifyUrl: string): Promise<{ delivered: boolean; logged: boolean }> {
  const from = env.EMAIL_FROM || "Cairn <hello@example.com>";
  const subject = "Your Cairn login link";
  const text = `Sign in to Cairn (expires in 15 minutes):\n\n${verifyUrl}\n\nIf you did not request this, ignore the email.`;
  const html = `<p>Sign in to Cairn. This link expires in 15 minutes.</p><p><a href="${escapeHtml(verifyUrl)}">Open login link</a></p><p style="color:#888;font-size:13px">If you did not request this, ignore the email.</p>`;
  if (!env.EMAIL) {
    console.log(`[cairn] EMAIL binding missing. Magic link for ${to}: ${verifyUrl}`);
    return { delivered: false, logged: true };
  }
  try {
    await env.EMAIL.send({ to, from, subject, html, text });
    return { delivered: true, logged: false };
  } catch (err) {
    console.log(`[cairn] EMAIL.send failed (${String(err)}). Magic link for ${to}: ${verifyUrl}`);
    return { delivered: false, logged: true };
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
