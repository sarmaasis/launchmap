interface SendEmail {
  send(message: {
    to: string | { email: string; name?: string };
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL?: SendEmail;
  SESSION_SECRET: string;
  APP_URL: string;
  EMAIL_FROM: string;
  APP_NAME: string;
  DODO_PAYMENTS_API_KEY: string;
  DODO_PAYMENTS_WEBHOOK_KEY: string;
  DODO_PAYMENTS_ENVIRONMENT: string;
  DODO_PRODUCT_ID: string;
  DODO_MONTHLY_PRODUCT_ID?: string;
  DODO_PRICE?: string;
}
