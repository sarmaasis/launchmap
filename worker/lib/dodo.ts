export function dodoApiBase(envName: string | undefined): string {
  const value = (envName ?? "test").toLowerCase();
  if (value === "live" || value === "live_mode") return "https://live.dodopayments.com";
  return "https://test.dodopayments.com";
}

export function monthlyProductId(env: Env): string | undefined {
  return env.DODO_PRO_PRODUCT_ID || env.DODO_MONTHLY_PRODUCT_ID || env.DODO_PRICE || undefined;
}

export function productIdForPlan(env: Env, plan: string): string | undefined {
  if (plan === "business") return env.DODO_BUSINESS_PRODUCT_ID || env.DODO_PRODUCT_ID || undefined;
  return monthlyProductId(env);
}

export async function createDodoCheckoutSession(opts: {
  apiKey: string;
  environment: string;
  productId: string;
  email?: string;
  returnUrl: string;
  metadata?: Record<string, string>;
}): Promise<{ checkout_url: string; session_id: string }> {
  const res = await fetch(`${dodoApiBase(opts.environment)}/checkouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      product_cart: [{ product_id: opts.productId, quantity: 1 }],
      customer: opts.email ? { email: opts.email } : undefined,
      return_url: opts.returnUrl,
      metadata: opts.metadata ?? {},
      customization: { theme: "dark" },
      feature_flags: { redirect_immediately: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dodo checkout failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return (await res.json()) as { checkout_url: string; session_id: string };
}

export function customerEmailFromDodoPayload(data: Record<string, unknown>): string | null {
  const customer = data.customer as { email?: string } | undefined;
  if (customer?.email) return customer.email.toLowerCase();
  if (typeof data.email === "string") return data.email.toLowerCase();
  const metadata = data.metadata as { email?: string } | undefined;
  if (metadata?.email) return metadata.email.toLowerCase();
  return null;
}
