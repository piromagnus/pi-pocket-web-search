// DonSeTch provider tests: adapter errors, and search/extract/crawl through a fake binary.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { DonsetchError, runDonsetch } from "../web-search/donsetch.ts";
import { WebAccessManager } from "../web-search/manager.ts";

const root = mkdtempSync(join(tmpdir(), "web-search-donsetch-"));
const cleanUp = () => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.DONSETCH_BINARY;
};

after(cleanUp);

/** A fake donsetch binary: emits the 4.10.x --json envelope shapes. */
function shim(name: string, script: string): string {
    const path = join(root, name);
    const body = `#!/usr/bin/env node\n${script}\n`;
    writeFileSync(path, body);
    chmodSync(path, 0o755);

    return path;
}

const okShim = shim(
    "donsetch-ok",
    `const [cmd, ...rest] = process.argv.slice(2);
     if (cmd === "version") process.exit(0);
     if (cmd === "search") {
         console.log(JSON.stringify({ ok: true, content: "# Search results", meta: {
             provider: null, degraded: false,
             results: [{ title: "Result for " + rest[0], url: "https://example.com/a", snippet: "snippet", score: 1.2, engines: ["ddg"] }],
         } }));
         process.exit(0);
     }
     if (cmd === "fetch") {
         console.log(JSON.stringify({ ok: true, content: "# Page\\n\\nBody text", meta: { content_ok: true, url: rest[0] } }));
         process.exit(0);
     }
     if (cmd === "crawl") {
         console.log(JSON.stringify({ ok: true, content: "# Crawl\\n\\n## Page", meta: { mode: "content", pages: 1 } }));
         process.exit(0);
     }
     process.exit(1);`,
);

const walledShim = shim(
    "donsetch-walled",
    `console.log(JSON.stringify({ ok: false, error: { kind: "walled", message: "challenge required" } }));
     process.exit(3);`,
);

const transport = {
    fetchPublic: async () => {
        throw new Error("No provider requests in donsetch tests");
    },
};

test("missing binary fails with a clear install hint, not a crash", async () => {
    process.env.DONSETCH_BINARY = join(root, "does-not-exist");

    await assert.rejects(
        runDonsetch(["version"]),
        (error: unknown) =>
            error instanceof DonsetchError &&
            error.kind === "missing" &&
            error.message.includes("npm install -g donsetch"),
    );
});

test("walled exit code maps to a walled kind with the binary's message", async () => {
    process.env.DONSETCH_BINARY = walledShim;

    await assert.rejects(
        runDonsetch(["fetch", "https://example.com"]),
        (error: unknown) =>
            error instanceof DonsetchError &&
            error.kind === "walled" &&
            error.message.includes("challenge"),
    );
});

test("search through the binary maps results and counts usage", async () => {
    process.env.DONSETCH_BINARY = okShim;
    const directory = await mkdir(join(root, "search"), { recursive: true }).then(() =>
        join(root, "search"),
    );
    const manager = new WebAccessManager(directory, transport);
    const response = await manager.search("rust async", "donsetch");

    assert.equal(response.provider, "donsetch");
    assert.equal(response.results.length, 1);

    const [first] = response.results;

    assert.equal(first!.title, "Result for rust async");
    assert.equal(first!.url, "https://example.com/a");
    assert.equal(first!.content, "snippet");

    const usage = await manager.getState().then((state) => state.usage);
    const today = new Date().toISOString().slice(0, 10);
    const counter = usage.days[today]?.["donsetch:search:keyless:tool"];

    assert.ok(counter, "usage ledger has a donsetch search entry");
    assert.equal(counter!.requests, 1);
    assert.equal(counter!.successes, 1);
    assert.equal(counter!.fallback, 0);
});

test("fetchContent with the donsetch provider returns the binary's markdown", async () => {
    process.env.DONSETCH_BINARY = okShim;
    const directory = join(root, "extract");
    await mkdir(directory, { recursive: true });
    const manager = new WebAccessManager(directory, transport);
    const result = await manager.fetchContent("https://example.com/page", 5000, "donsetch");

    assert.equal(result.provider, "donsetch");
    assert.ok(result.text.startsWith("# Page"));
});

test("crawl delegates to the binary in donsetch mode and refuses other providers", async () => {
    process.env.DONSETCH_BINARY = okShim;
    const directory = join(root, "crawl");
    await mkdir(directory, { recursive: true });
    const manager = new WebAccessManager(directory, transport);
    const data = (await manager.crawl("https://example.com", "async topic", "donsetch")) as any;

    assert.equal(data.ok, true);
    assert.equal(data.meta.mode, "content");

    await assert.rejects(
        manager.crawl("https://example.com", undefined, "exa"),
        /Unsupported crawl/,
    );
});
