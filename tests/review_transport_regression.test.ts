import "./support/isolation.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadMediaStream } from "../src/extractor/asr.ts";
import { CdpSession } from "../src/extractor/cdp.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("media downloader rejects private redirects before contacting the target", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "media-test-")), "stream.mp4");
  for (const location of ["http://127.0.0.1/secret", "http://192.168.1.8/media", "http://[::1]/media", "file:///etc/passwd"]) {
    const requests: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location } });
    }) as unknown as typeof fetch;
    await expect(downloadMediaStream("https://cdn.example.test/media", target)).rejects.toThrow();
    expect(requests).toEqual(["https://cdn.example.test/media"]);
    expect(existsSync(target)).toBe(false);
  }
});

test("media downloader follows public relative redirects and writes streamed bytes", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "media-test-")), "stream.mp4");
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    if (requests.length === 1) return new Response(null, { status: 307, headers: { location: "/final" } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(200).fill(1));
      controller.enqueue(new Uint8Array(200).fill(2));
      controller.close();
    } }));
  }) as unknown as typeof fetch;
  await downloadMediaStream("https://cdn.example.test/media", target);
  expect(requests).toEqual(["https://cdn.example.test/media", "https://cdn.example.test/final"]);
  expect(readFileSync(target)).toEqual(Buffer.concat([Buffer.alloc(200, 1), Buffer.alloc(200, 2)]));
});

test("media downloader bounds streamed size and rejects HTTP errors, loops and partial streams", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "media-test-")), "stream.mp4");
  const cases = [
    () => new Response(new Uint8Array(600)),
    () => new Response("error", { status: 403 }),
    () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(300)); controller.error(new Error("connection lost"));
    } })),
  ];
  for (const response of cases) {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
    await expect(downloadMediaStream("https://cdn.example.test/media", target, {}, { maxBytes: 500 })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  }
});

class FakeSocket extends EventTarget {
  sent: Array<{ id: number; method: string }> = [];
  closed = false;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  reply(id: number, result: unknown, error?: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result, error }) })); }
}

test("CDP routes concurrent responses and rejects protocol errors", async () => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, { signal: new AbortController().signal });
  socket.dispatchEvent(new Event("open"));
  const first = session.call("Network.enable"), second = session.call("Page.navigate");
  await Promise.resolve();
  socket.reply(socket.sent[1].id, { ok: true });
  socket.reply(socket.sent[0].id, null, { message: "invalid command" });
  expect(await second).toEqual({ ok: true });
  await expect(first).rejects.toThrow("invalid command");
  session.dispose();
  expect(socket.closed).toBe(true);
});

for (const event of ["close", "error"]) {
  test(`CDP ${event} rejects all in-flight and subsequent calls`, async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket, { signal: new AbortController().signal });
    socket.dispatchEvent(new Event("open"));
    const calls = [session.call("Network.enable"), session.call("Runtime.evaluate")];
    const settled = Promise.allSettled(calls);
    await Promise.resolve();
    socket.dispatchEvent(new Event(event));
    expect((await settled).map(item => item.status)).toEqual(["rejected", "rejected"]);
    await expect(session.call("Page.navigate")).rejects.toThrow("closed");
    expect(socket.closed).toBe(true);
  });
}

test("CDP missing responses and unopened sockets have deadlines", async () => {
  const unopened = new FakeSocket();
  const opening = new CdpSession(unopened, { signal: new AbortController().signal, openTimeoutMs: 10 });
  await expect(opening.ready).rejects.toThrow("open timeout");
  expect(unopened.closed).toBe(true);
  const socket = new FakeSocket();
  const session = new CdpSession(socket, { signal: new AbortController().signal, requestTimeoutMs: 10 });
  socket.dispatchEvent(new Event("open"));
  await expect(session.call("Page.navigate")).rejects.toThrow("request timeout");
  expect(socket.closed).toBe(true);
});

test("CDP overall deadline terminates an otherwise open connection", async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const session = new CdpSession(socket, { signal: controller.signal });
  socket.dispatchEvent(new Event("open"));
  const pending = session.call("Runtime.evaluate");
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow("deadline");
  expect(socket.closed).toBe(true);
});
