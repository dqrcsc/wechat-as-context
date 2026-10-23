import { mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
const originalExists = fs.existsSync;
mock.module("node:fs", () => ({ ...fs, existsSync: (p: any) => String(p) === "/usr/bin/google-chrome" || originalExists(p) }));
const { ensureMultiFormatDeliverables } = await import("../../src/agent/doc_exporter.ts");
const root = fs.mkdtempSync(join(tmpdir(), "wx-pdf-render-"));
const md = join(root,"guide.md"), oldPdf = join(root,"guide_export_1111111111111111.pdf");
fs.writeFileSync(md,"# Current\nNEW_BODY"); fs.writeFileSync(oldPdf,"%PDF-OLD");
let rendered = false;
spyOn(Bun,"spawn").mockImplementation(((args: string[]) => {
  const target = args.find(arg => arg.startsWith("--print-to-pdf="))!.slice("--print-to-pdf=".length);
  fs.writeFileSync(target, "%PDF-1.7\n" + "fixture".repeat(100)); rendered = true;
  return {exited:Promise.resolve(0),kill(){}};
}) as any);
const files = await ensureMultiFormatDeliverables({markdownPath:md,outputDir:root,baseFileStem:"guide",existingFiles:[oldPdf],requestedFormats:["html","pdf"]});
console.log(JSON.stringify({rendered,names:files.map(path => basename(path)),oldPreserved:fs.readFileSync(oldPdf,"utf8")==="%PDF-OLD",body:fs.readFileSync(files[0],"utf8").includes("NEW_BODY")}));
