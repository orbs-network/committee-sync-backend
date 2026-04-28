import { createHash } from 'crypto';

const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 min

class Notifier {
  private botToken: string | null = null;
  private chatId: string | null = null;
  private recentMessages = new Map<string, number>();

  init(botToken?: string, chatId?: string): void {
    this.botToken = botToken && botToken.trim() ? botToken : null;
    this.chatId = chatId && chatId.trim() ? chatId : null;
    if (this.botToken && this.chatId) {
      console.log('[notifier] Telegram notifications enabled');
    } else {
      console.log('[notifier] Telegram not configured — notifications will only log to console');
    }
  }

  async error(type: string, message: string, context?: { chain?: string }): Promise<void> {
    const dedupeKey = this.hash(`${type}:${message}`);
    if (this.isRecent(dedupeKey)) return;
    this.recentMessages.set(dedupeKey, Date.now());

    const lines = [
      `🔴 [committee-sync] ${type}`,
      ...(context?.chain ? [context.chain] : []),
      message,
      this.timestamp(),
    ];
    await this.send(lines.join('\n'));
  }

  async success(title: string, body: string, links: string[] = []): Promise<void> {
    const lines = [
      `✅ [committee-sync] ${title}`,
      body,
      ...links,
      this.timestamp(),
    ];
    await this.send(lines.join('\n'));
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  }

  private isRecent(key: string): boolean {
    const now = Date.now();
    // Clean up old entries
    for (const [k, ts] of this.recentMessages) {
      if (now - ts > DEDUPE_WINDOW_MS) this.recentMessages.delete(k);
    }
    const ts = this.recentMessages.get(key);
    return ts !== undefined && now - ts < DEDUPE_WINDOW_MS;
  }

  private timestamp(): string {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }

  private async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      console.log(`[notifier] (no-op) ${text.replace(/\n/g, ' | ')}`);
      return;
    }
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error(`[notifier] Telegram API error: HTTP ${response.status} — ${errText}`);
      }
    } catch (err) {
      console.error(`[notifier] Send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const notifier = new Notifier();
