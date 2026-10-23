/**
 * DonSeTch adapter: keyless multi-engine search, stealth fetch and same-domain crawl,
 * through the local `donsetch` binary (npm install -g donsetch). Absent binary degrades:
 * every call fails with a clear "missing" error the fallback chain records as an attempt.
 *
 * CLI JSON interface validated against DonSeTch 4.10.x: `--json` prints
 * { ok, content, meta } on stdout; exit codes 0 ok, 1 permanent, 2 transient, 3 walled.
 * shortcut: DonSeTch V5 may change this envelope; keep this file the only place that parses it.
 */
import { spawn } from "node:child_process";
import { env } from "node:process";

export type DonsetchErrorKind = "missing" | "permanent" | "transient" | "walled";

export class DonsetchError extends Error {
    kind: DonsetchErrorKind;

    constructor(kind: DonsetchErrorKind, message: string) {
        super(message);

        this.kind = kind;
        this.name = "DonsetchError";
    }
}

export interface DonsetchSearchResult {
    title: string;
    url: string;
    content: string;
}

export interface DonsetchEnvelope {
    ok: boolean;
    content: string;
    meta: any;
    error?: { kind?: string; message?: string };
}

const EXIT_KINDS: Record<number, DonsetchErrorKind> = {
    1: "permanent",
    2: "transient",
    3: "walled",
};

// The binary needs a PATH and a HOME; proxies and DONSETCH_* knobs pass through.
// Everything else (provider keys included) stays with the server process.
const ENV_KEYS = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
];
const ENV_PREFIXES = ["DONSETCH_", "LC_"];

function childEnv(): NodeJS.ProcessEnv {
    const filtered: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
            continue;
        }

        if (ENV_KEYS.includes(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            filtered[key] = value;
        }
    }

    return filtered;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

export function donsetchCommand(): string {
    return env.DONSETCH_BINARY?.trim() || "donsetch";
}

export function isDonsetchMissing(error: unknown): boolean {
    return error instanceof DonsetchError && error.kind === "missing";
}

export async function runDonsetch(
    args: string[],
    { timeoutMs = 30_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DonsetchEnvelope> {
    const command = donsetchCommand();
    const child = spawn(command, args, {
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
            stdout += chunk.toString();
        } else {
            child.kill("SIGKILL");
        }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2048);
    });

    return await new Promise<DonsetchEnvelope>((resolve, reject) => {
        let settled = false;

        const fail = (error: DonsetchError | Error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(killTimer);
            signal?.removeEventListener("abort", onAbort);
            child.removeAllListeners("close");

            try {
                child.kill("SIGKILL");
            } catch {}
            reject(error);
        };

        const killTimer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            } catch {}
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {}
            }, KILL_GRACE_MS);
            fail(new DonsetchError("transient", `DonSeTch timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const onAbort = () => {
            fail(Object.assign(new Error("DonSeTch call aborted"), { name: "AbortError" }));
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();

                return;
            }

            signal.addEventListener("abort", onAbort, { once: true });
        }

        child.on("error", (error: NodeJS.ErrnoException) => {
            fail(
                error.code === "ENOENT" || error.code === "EACCES"
                    ? new DonsetchError(
                          "missing",
                          "DonSeTch binary not found. Install it with `npm install -g donsetch` or set DONSETCH_BINARY.",
                      )
                    : new DonsetchError("permanent", `DonSeTch failed to start: ${error.message}`),
            );
        });

        child.on("close", (code) => {
            if (settled) {
                return;
            }

            clearTimeout(killTimer);
            signal?.removeEventListener("abort", onAbort);

            let envelope: DonsetchEnvelope | null = null;

            try {
                envelope = JSON.parse(stdout.trim()) as DonsetchEnvelope;
            } catch {}

            if (code === 0) {
                if (!envelope || typeof envelope.content !== "string") {
                    fail(new DonsetchError("permanent", "DonSeTch returned invalid JSON"));

                    return;
                }

                resolve(envelope);

                return;
            }

            const kind = EXIT_KINDS[code ?? 1] ?? "permanent";
            const message =
                envelope && envelope.ok === false
                    ? String(envelope.error?.message ?? envelope.error?.kind ?? "DonSeTch error")
                    : stderr.trim() || `DonSeTch exited with code ${code}`;

            fail(new DonsetchError(kind, message));
        });
    });
}

export async function donsetchSearch(
    query: string,
    maxResults: number,
    { signal }: { signal?: AbortSignal } = {},
): Promise<DonsetchSearchResult[]> {
    const envelope = await runDonsetch(
        [
            "search",
            query,
            "--max-results",
            // donsetch caps --max-results at 12.
            String(Math.max(1, Math.min(maxResults, 12))),
            "--deadline-ms",
            "25000",
            "--json",
            "-q",
        ],
        { timeoutMs: 30_000, signal },
    );

    const results = Array.isArray(envelope.meta?.results) ? envelope.meta.results : [];

    return results
        .filter((r: any) => typeof r?.url === "string" && r.url)
        .map((r: any) => ({
            title: String(r.title ?? "Untitled"),
            url: r.url,
            content: String(r.snippet ?? ""),
        }));
}

export async function donsetchFetch(
    url: string,
    maxChars: number,
    { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
    const envelope = await runDonsetch(
        ["fetch", url, "--max-chars", String(maxChars), "--json", "-q"],
        { timeoutMs: 60_000, signal },
    );

    if (envelope.meta?.content_ok === false) {
        throw new DonsetchError(
            "walled",
            String(
                envelope.meta?.next_action ??
                    envelope.meta?.read_status ??
                    "DonSeTch could not read the page",
            ),
        );
    }

    return envelope.content;
}

export async function donsetchCrawl(
    url: string,
    {
        topic,
        maxPages = 10,
        signal,
    }: { topic?: string; maxPages?: number; signal?: AbortSignal } = {},
): Promise<DonsetchEnvelope> {
    return runDonsetch(
        [
            "crawl",
            url,
            "--mode",
            "content",
            "--max-pages",
            String(Math.max(1, Math.min(maxPages, 100))),
            ...(topic ? ["--topic", topic] : []),
            "--json",
            "-q",
        ],
        { timeoutMs: 120_000, signal },
    );
}
