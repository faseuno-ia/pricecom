import { describe, it, expect } from "vitest";
import { diffJobIds } from "../../worker/src/job-set-diff";

describe("2G-R9-PR2 · diffJobIds (M · determinista, sin relojes)", () => {
  it("iguales → added=[], removed=[]", () => {
    expect(diffJobIds(["a", "b"], ["a", "b"])).toEqual({ added: [], removed: [] });
  });
  it("uno agregado (caso canary) → added=[nuevo], removed=[]", () => {
    expect(diffJobIds(["a", "b"], ["a", "b", "c"])).toEqual({ added: ["c"], removed: [] });
  });
  it("varios agregados → orden determinista (sorted)", () => {
    expect(diffJobIds(["a"], ["a", "z", "m", "b"])).toEqual({ added: ["b", "m", "z"], removed: [] });
  });
  it("uno removido → removed=[x]", () => {
    expect(diffJobIds(["a", "b"], ["a"])).toEqual({ added: [], removed: ["b"] });
  });
  it("agregado + removido simultáneos", () => {
    expect(diffJobIds(["a", "b"], ["a", "c"])).toEqual({ added: ["c"], removed: ["b"] });
  });
  it("orden de entrada distinto → mismo resultado (determinista)", () => {
    expect(diffJobIds(["b", "a"], ["c", "a", "b"])).toEqual(diffJobIds(["a", "b"], ["a", "b", "c"]));
  });
});
