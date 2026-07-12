/**
 * Terminal-style history for the Type ribbon's prompt box: the last few dispatched prompts, kept in
 * this browser's localStorage so ArrowUp/ArrowDown can bring them back (like a shell). LAN-only
 * concept — it never touches the cloud. Storage is best-effort: private mode / blocked storage just
 * degrades to an in-memory list that lasts the session (never throws).
 */
export class PromptHistory {
  private mem: string[] = [];

  constructor(
    private readonly key = "wd:type-history",
    private readonly max = 25,
  ) {
    this.mem = this.read();
  }

  /** Oldest-first, so index 0 is the least recent and the last entry is what you just sent. */
  list(): string[] {
    return this.mem;
  }

  /** Record a dispatched prompt. Blanks and immediate repeats are ignored (like a shell's dedup). */
  add(text: string): void {
    const value = text.trim();
    if (!value) return;
    if (this.mem[this.mem.length - 1] === value) return;
    this.mem.push(value);
    if (this.mem.length > this.max) this.mem = this.mem.slice(this.mem.length - this.max);
    this.write();
  }

  private read(): string[] {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.mem));
    } catch {
      /* storage blocked — keep the in-memory copy for this session */
    }
  }
}
