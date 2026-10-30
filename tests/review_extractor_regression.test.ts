import "./support/isolation.ts";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractXiaohongshuNote } from "../src/extractor/social_media.ts";
import { saveRawWebArticleToVault } from "../src/extractor/web.ts";

import { setAsrTestRunner } from "../src/extractor/asr.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setAsrTestRunner(null); });

test("requested XHS note must not use first unrelated detailMap entry", async () => {
  const state = { note: { noteDetailMap: {
    unrelated: { note: { noteId: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "Unrelated note A", desc: "Body and author belong to A", user: { nickname: "Author A" }, imageList: [{urlDefault:"https://images.example.test/a.png"}] } },
    bbbbbbbbbbbbbbbbbbbbbbbb: { note: { noteId: "bbbbbbbbbbbbbbbbbbbbbbbb", title: "Requested note B", desc: "Body and author belong to B", user: { nickname: "Author B" }, imageList: [{urlDefault:"https://images.example.test/b.png"}] } },
  } } };
  globalThis.fetch = (async () => new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`, { status: 200 })) as unknown as typeof fetch;
  const result = await extractXiaohongshuNote("https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb");
  console.log(JSON.stringify({ case: "xhs_note_identity", requested: "B", title: result.title, author: result.author, url: result.url }));
  expect(result.title).toBe("Requested note B");
  expect(result.author).toBe("Author B");
  expect(result.imageUrls).toEqual(["https://images.example.test/b.png"]);
  expect(result.markdownBody).not.toContain("Body and author belong to A");
});

test("reextracted existing source keeps resolvable image paths after video directory selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-assets-"));
  const oldDir = join(root, "articles", "web"), videoDir = join(root, "video");
  mkdirSync(oldDir, { recursive: true });
  const oldPath = join(oldDir, "previous-source.md");
  writeFileSync(oldPath, "---\ntranscript_engine: metadata_only\n---\nPrevious metadata");
  globalThis.fetch = (async () => new Response(new Uint8Array(300), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  const saved = await saveRawWebArticleToVault({ articlesDir: videoDir, existingPath: oldPath, overwriteExisting: true, slug: "video_review", article: {
    url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Video", author: "Author", publishDate: "2026-10-30",
    digest: "Transcript", markdownBody: "![cover](https://images.example.test/cover.png)\nTranscript", imageUrls: ["https://images.example.test/cover.png"],
    extractorUsed: "native_http", mediaKind: "video", sourceType: "youtube_video", transcriptEngine: "fixture_asr",
  } });
  const relative = readFileSync(saved, "utf8").match(/!\[cover\]\(([^)]+)\)/)![1];
  console.log(JSON.stringify({ case: "reextract_image_link", inNewVideoDir: existsSync(join(videoDir, relative)), resolvesFromSource: existsSync(join(dirname(saved), relative)) }));
  expect(saved).toBe(oldPath);
  expect(existsSync(join(dirname(saved), relative))).toBe(true);
});

for (const useMobile of [false, true]) {
  test(`XHS refuses unrelated ${useMobile ? 'mobile' : 'desktop'} state even with plausible metadata`, async () => {
    const wrongNote = { noteId: 'notea', title: 'Wrong note', desc: 'Unrelated body' };
    const state = useMobile ? { noteData: { data: { noteData: wrongNote } } } : { note: { noteDetailMap: { noteb: { note: wrongNote } } } };
    globalThis.fetch = (async () => new Response(`<meta property="og:title" content="Misleading title"><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`)) as unknown as typeof fetch;
    await expect(extractXiaohongshuNote('https://www.xiaohongshu.com/explore/noteb')).rejects.toThrow('identity');
  });
}

test('XHS identity follows resolved short URL, including mobile note paths', async () => {
  const finalUrl = 'https://www.xiaohongshu.com/discovery/item/noteb?xsec_token=fixture';
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('xhslink.com')) return new Response(null, { status: 302, headers: { location: finalUrl } });
    const state = { noteData: { data: { noteData: { noteId: 'noteb', title: 'Resolved B', desc: 'B body', user: { nickname: 'B author' } } } } };
    const response = new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`);
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  }) as unknown as typeof fetch;
  const result = await extractXiaohongshuNote('https://xhslink.com/fixture');
  expect(result.title).toBe('Resolved B');
  expect(result.author).toBe('B author');
  expect(result.url).toBe(finalUrl);
});

test('selected XHS note cannot inherit unrelated page media', async () => {
 const state={note:{noteDetailMap:{aaaa:{note:{noteId:'aaaa',title:'A',desc:'A body'}},bbbb:{note:{noteId:'bbbb',title:'B',type:'normal',desc:'B body'}}}}};
 let media='';
 setAsrTestRunner(async req => { media=req.mediaUrl || ''; return {transcript:'Transcript from unrelated A video',engineUsed:'fixture'}; });
 globalThis.fetch=(async()=>new Response(`<meta property="og:image" content="https://cdn.example.test/a.png"><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script><video src="https://cdn.example.test/a.mp4"></video>`)) as unknown as typeof fetch;
 const result=await extractXiaohongshuNote('https://www.xiaohongshu.com/explore/bbbb');
 console.log(JSON.stringify({title:result.title,kind:result.mediaKind,images:result.imageUrls,media,body:result.markdownBody}));
 expect(result.mediaKind).toBe('article');
 expect(result.imageUrls).toEqual([]);
 expect(media).toBe('');
});
