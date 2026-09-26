import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TranscriptPages, type PageSource } from "../../../src/claude/native/pages.js";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import { readTranscriptRecords, type TranscriptRecord } from "../../../src/claude/native/records.js";
import { summarizeTranscript } from "../../../src/claude/native/summary.js";
import { NO_PEERS } from "../../../src/claude/peers.js";
import type { Turn } from "../../../src/protocol/codex.js";

/** Opens of a transcript: each read of it. */
const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => { opens.count += 1; return actual.open(...args); } };
});

const PROJECT = new URL("../../fixtures/nativeClaudeHome/projects/-home-user-project/", import.meta.url).pathname;
const PAGE = 5;

async function load(path: string) {
  const records: TranscriptRecord[] = [];
  for await (const record of readTranscriptRecords(path)) records.push(record);
  const header = summarizeTranscript(records);
  const full = await projectTranscript({ sessionId: "s", path, records, header, peers: NO_PEERS.directory });
  const source: PageSource = { sessionId: "s", path, header, peers: NO_PEERS.directory, peersVersion: "" };
  return { full, source };
}

/** Desktop's scroll back: the newest page, then each page before the oldest turn seen; each page's turns' items. */
async function scroll(pages: TranscriptPages, source: PageSource): Promise<{ turns: Turn[]; items: Turn[] }> {
  let window = await pages.newest(source, PAGE);
  let seen = window.turns.slice(-PAGE);
  const items: Turn[] = [];
  const itemsOf = async (turns: readonly Turn[]) => {
    for (const turn of turns) items.unshift((await pages.around(source, turn.id, 0)).turns.find((candidate) => candidate.id === turn.id)!);
  };
  await itemsOf(seen.slice(0, -1).reverse());
  let older = window.older || window.turns.length > PAGE;
  while (older) {
    const anchor = seen[0]!.id;
    window = await pages.around(source, anchor, PAGE);
    const before = window.turns.slice(0, window.turns.findIndex((turn) => turn.id === anchor));
    seen = [...before.slice(-PAGE), ...seen];
    await itemsOf(before.slice(-PAGE).reverse());
    older = window.older || before.length > PAGE;
  }
  return { turns: seen, items };
}

describe("paged transcript reads", () => {
  const fixtures = readdirSync(PROJECT).filter((name) => name.endsWith(".jsonl"));
  it.each(fixtures.flatMap((name) => [16 << 10, 256 << 10].map((chunk) => [name, chunk] as const)))(
    "pages %s (chunk %i) into the turns, items and boundaries of the whole transcript",
    async (name, chunk) => {
      const { full, source } = await load(join(PROJECT, name));
      const pages = new TranscriptPages(chunk);
      const { turns, items } = await scroll(pages, source);
      expect(turns).toEqual(full.turns);
      expect(items).toEqual(full.turns.slice(0, -1));
      // A turn read on its own (`thread/items/list`) and its rollback anchor, from a fresh reader (a cursor after a restart).
      const fresh = new TranscriptPages(chunk);
      for (const [index, turn] of full.turns.entries()) {
        const { turns } = await fresh.around(source, turn.id, 0);
        expect(turns.find((candidate) => candidate.id === turn.id)).toEqual(turn);
        expect(await fresh.boundary(source, turn.id, true)).toBe(full.turnBoundaries[index]!.messageUuid);
      }
    },
    60_000,
  );

  it("serves the items of a page's turns from the page's read (Desktop asks each right after the page)", async () => {
    const name = fixtures.map((fixture) => join(PROJECT, fixture)).sort((left, right) => statSync(right).size - statSync(left).size)[0]!;
    const { full, source } = await load(name);
    const pages = new TranscriptPages(16 << 10);
    const newest = await pages.newest(source, PAGE + 1);
    const page = await pages.around(source, newest.turns.at(-PAGE)!.id, PAGE);
    const before = page.turns.slice(0, page.turns.findIndex((turn) => turn.id === newest.turns.at(-PAGE)!.id)).slice(-PAGE);
    expect(before.length).toBeGreaterThan(1);
    const reads = opens.count;
    for (const turn of before) expect((await pages.around(source, turn.id, 0)).turns.find((candidate) => candidate.id === turn.id)).toEqual(full.turns.find((candidate) => candidate.id === turn.id));
    expect(opens.count).toBe(reads);
  });

  it("keeps each prompt with its answers when 0.4's restored turns share one message id across steers", async () => {
    const record = (uuid: string, parentUuid: string | null, type: "user" | "assistant", text: string, second: number) => type === "user"
      ? { type, uuid, parentUuid, sessionId: "s", timestamp: new Date(second * 1000).toISOString(), message: { role: "user", content: text } }
      : { type, uuid, parentUuid, sessionId: "s", timestamp: new Date(second * 1000).toISOString(),
        message: { id: "msg_shared", role: "assistant", model: "claude-fable-5", content: [{ type: "text", text }], stop_reason: "end_turn" } };
    const lines = [
      record("p1", null, "user", "first", 1), record("a1", "p1", "assistant", "one", 2), record("a2", "a1", "assistant", "two", 3),
      record("p2", "a2", "user", "second", 4), record("a3", "p2", "assistant", "three", 5),
      record("p3", "a3", "user", "third", 6), record("a4", "p3", "assistant", "four", 7), record("a5", "a4", "assistant", "five", 8),
    ];
    const path = join(mkdtempSync(join(tmpdir(), "ccodex-pages-")), "s.jsonl");
    writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    const { full, source } = await load(path);
    expect(full.turns.map((turn) => turn.items.map((item) => item.id))).toEqual([
      ["p1", "a1:0", "a2:0"], ["p2", "a3:0"], ["p3", "a4:0", "a5:0"],
    ]);
    const { turns, items } = await scroll(new TranscriptPages(128), source);
    expect(turns).toEqual(full.turns);
    expect(items).toEqual(full.turns.slice(0, -1));
  });
});
