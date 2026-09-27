import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingSections } from "../../src/management/commands.js";

const sections = readFileSync(new URL("../../claude/chat-formatting.md", import.meta.url), "utf8");
const [formulas, plots] = sections.split(/^(?=# )/mu);

describe("the CLAUDE.md sections setup offers", () => {
  it("are Formulas and Plots, all of them for an empty CLAUDE.md", () => {
    expect([formulas!.split("\n")[0], plots!.split("\n")[0]]).toEqual(["# Formulas", "# Plots (check before giving me)"]);
    expect(missingSections("", sections).join("")).toBe(sections);
  });

  it("skip a section whose heading is there at any level", () => {
    expect(missingSections("# Style\n\n## Formulas\nUse LaTeX.\n", sections)).toEqual([plots]);
    expect(missingSections("## Formulas\n# Plots (check before giving me)\n", sections)).toEqual([]);
    expect(missingSections("Formulas and plots, no headings\n", sections)).toEqual([formulas, plots]);
  });
});
