import { randomUUID } from "node:crypto";
import type { NotificationLevel, NotificationMessage } from "@whipdesk/protocol";

export type NotificationListener = (n: NotificationMessage) => void;

export interface NotificationInput {
  title: string;
  body?: string;
  level?: NotificationLevel;
  source?: string;
}

/**
 * Fan-out for generic events. Sources (HTTP webhook, file watchers, ...) call `emit`;
 * connected controllers subscribe. Keeps a small ring buffer so freshly connected
 * clients receive recent context in their `welcome`.
 */
export class NotificationHub {
  private readonly listeners = new Set<NotificationListener>();
  private readonly recent: NotificationMessage[] = [];
  private readonly maxRecent = 20;

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRecent(): NotificationMessage[] {
    return [...this.recent];
  }

  emit(input: NotificationInput): NotificationMessage {
    const notification: NotificationMessage = {
      type: "notification",
      id: randomUUID(),
      title: input.title,
      body: input.body,
      level: input.level ?? "info",
      source: input.source ?? "manual",
      t: Date.now(),
    };

    this.recent.push(notification);
    if (this.recent.length > this.maxRecent) this.recent.shift();

    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        /* a bad listener must not break the fan-out */
      }
    }
    return notification;
  }
}
