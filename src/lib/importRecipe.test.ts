import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractRecipe, parseIsoDuration, parseServings } from "./importRecipe";

describe("extractRecipe, page without schema.org data", () => {
  const html = readFileSync(join(__dirname, "__fixtures__", "gaz-lasagne.html"), "utf8");
  const r = extractRecipe(html, "https://www.gazoakleychef.com/recipes/lasagne/");

  it("reads metadata", () => {
    expect(r.method).toBe("html");
    expect(r.title).toBe("My Lasagne");
    expect(r.servings).toBe(6);
    expect(r.totalMinutes).toBe(90);
  });

  it("reads ingredients with their sections", () => {
    expect(r.ingredients).toHaveLength(24);
    expect(new Set(r.ingredients.map((i) => i.section))).toEqual(new Set(["Ragu", "Béchamel Sauce", "Pasta"]));
    expect(r.ingredients.at(-1)).toMatchObject({ quantity: 1, unit: "pack", name: "Dried Lasagna Sheets" });
  });

  it("reads the steps and stops before the footer", () => {
    expect(r.instructions).toHaveLength(13);
    expect(r.instructions.at(-1)).toMatch(/^Bake the lasagne/);
  });
});

describe("helpers", () => {
  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H30M")).toBe(90);
    expect(parseIsoDuration("PT45M")).toBe(45);
  });
  it("parses servings", () => {
    expect(parseServings("Serves: 6-8")).toBe(6);
    expect(parseServings("4 portions")).toBe(4);
    expect(parseServings("Rendement : 8")).toBe(8);
  });
});
