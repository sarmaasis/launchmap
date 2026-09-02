export function isBot(ua: string): boolean { return !ua || ua.length < 12 || /bot|crawler|spider|preview|headless|gptbot/i.test(ua); }
