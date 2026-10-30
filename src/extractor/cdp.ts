/** Small CDP transport with deadlines and deterministic pending-request cleanup. */
export class CdpSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped: Error | null = null;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private openTimer: ReturnType<typeof setTimeout>;
  readonly ready: Promise<void>;

  constructor(private socket: Pick<WebSocket, "send" | "close" | "addEventListener" | "removeEventListener">,
    private options: { signal: AbortSignal; openTimeoutMs?: number; requestTimeoutMs?: number }) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.openTimer = setTimeout(() => this.dispose(new Error("CDP open timeout")), options.openTimeoutMs ?? 5000);
    socket.addEventListener("open", this.onOpen);
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onClose);
    options.signal.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal.aborted) this.onAbort();
  }

  private onOpen = () => { clearTimeout(this.openTimer); this.readyResolve(); };
  private onClose = () => this.dispose(new Error("CDP connection closed or failed"));
  private onAbort = () => this.dispose(new Error("CDP extraction deadline exceeded"));
  private onMessage = (event: Event) => {
    let data: any;
    try { data = JSON.parse(String((event as MessageEvent).data)); } catch { return; }
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(`CDP error: ${data.error.message || JSON.stringify(data.error)}`));
    else request.resolve(data.result);
  };

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ready;
    if (this.stopped) throw this.stopped;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.dispose(new Error(`CDP request timeout: ${method}`)), this.options.requestTimeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  dispose(error = new Error("CDP session disposed")): void {
    if (this.stopped) return;
    this.stopped = error;
    clearTimeout(this.openTimer);
    this.readyReject(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.options.signal.removeEventListener("abort", this.onAbort);
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onClose);
    try { this.socket.close(); } catch {}
  }
}
