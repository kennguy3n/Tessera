import { describe, it, expect } from "vitest";
import { sanitizeHeroImage } from "../utils/heroImage";

describe("sanitizeHeroImage", () => {
  // The shape that `imagegen:generate` IPC + the editor persistence
  // layer agree on. Every test below mutates one field and verifies
  // the sanitizer either accepts the result (positive control) or
  // returns `undefined` (rejection).
  const valid = {
    assetUrl: "tessera-asset://abcd1234.png",
    prompt: "a serene mountain landscape at dawn",
    seed: 42,
    width: 1024,
    height: 768,
  };

  it("accepts a well-formed payload (positive control)", () => {
    expect(sanitizeHeroImage(valid)).toEqual(valid);
  });

  describe("assetUrl scheme guard", () => {
    it("rejects http URLs (a CSP-bypass attempt via on-disk JSON)", () => {
      expect(
        sanitizeHeroImage({
          ...valid,
          assetUrl: "http://evil.example.com/x.png",
        }),
      ).toBeUndefined();
    });

    it("rejects https URLs (same reason)", () => {
      expect(
        sanitizeHeroImage({
          ...valid,
          assetUrl: "https://example.com/x.png",
        }),
      ).toBeUndefined();
    });

    it("rejects file:// URLs", () => {
      expect(
        sanitizeHeroImage({ ...valid, assetUrl: "file:///etc/passwd" }),
      ).toBeUndefined();
    });

    it("rejects data: URLs", () => {
      expect(
        sanitizeHeroImage({
          ...valid,
          assetUrl: "data:image/png;base64,iVBORw0KGgo=",
        }),
      ).toBeUndefined();
    });

    it("rejects empty assetUrl", () => {
      expect(sanitizeHeroImage({ ...valid, assetUrl: "" })).toBeUndefined();
    });

    it("rejects non-string assetUrl", () => {
      expect(sanitizeHeroImage({ ...valid, assetUrl: 42 })).toBeUndefined();
    });
  });

  describe("non-finite-number guards (Block C pass-N regression)", () => {
    // Devin Review pass-N flagged `typeof === 'number'` as passing
    // `NaN`, `Infinity`, and `-Infinity`. A hand-edited artifact
    // JSON with `"width": 1e999` parses to `Infinity` and reached
    // downstream rendering before this hardening landed.
    it("rejects NaN seed", () => {
      expect(sanitizeHeroImage({ ...valid, seed: NaN })).toBeUndefined();
    });

    it("rejects +Infinity width", () => {
      expect(
        sanitizeHeroImage({ ...valid, width: Number.POSITIVE_INFINITY }),
      ).toBeUndefined();
    });

    it("rejects -Infinity height", () => {
      expect(
        sanitizeHeroImage({ ...valid, height: Number.NEGATIVE_INFINITY }),
      ).toBeUndefined();
    });

    it("rejects NaN height", () => {
      expect(sanitizeHeroImage({ ...valid, height: NaN })).toBeUndefined();
    });

    it("rejects NaN width", () => {
      expect(sanitizeHeroImage({ ...valid, width: NaN })).toBeUndefined();
    });
  });

  describe("seed range guards", () => {
    it("rejects negative seed", () => {
      expect(sanitizeHeroImage({ ...valid, seed: -1 })).toBeUndefined();
    });

    it("rejects non-integer seed", () => {
      expect(sanitizeHeroImage({ ...valid, seed: 1.5 })).toBeUndefined();
    });

    it("accepts seed === 0 (a valid u64 minimum)", () => {
      expect(sanitizeHeroImage({ ...valid, seed: 0 })).toEqual({
        ...valid,
        seed: 0,
      });
    });

    it("accepts seed === Number.MAX_SAFE_INTEGER (the IPC truncation ceiling)", () => {
      expect(
        sanitizeHeroImage({ ...valid, seed: Number.MAX_SAFE_INTEGER }),
      ).toEqual({ ...valid, seed: Number.MAX_SAFE_INTEGER });
    });

    it("rejects seed === Number.MAX_SAFE_INTEGER + 1 (= 2^53, above the IPC truncation ceiling)", () => {
      // Regression guard: `Number.isInteger(Number.MAX_SAFE_INTEGER + 1)`
      // returns `true` because 2^53 is exactly representable as a
      // double and is mathematically an integer. The previous sanitizer
      // used `Number.isInteger` and would have accepted this — letting
      // a hand-edited artifact JSON with `"seed": 9007199254740992`
      // past the seed-range check even though the upstream
      // `imagegen:generate` IPC truncates seeds AT MAX_SAFE_INTEGER.
      // The fix uses `Number.isSafeInteger`, which rejects 2^53 (and
      // every larger double) on top of NaN/Infinity/non-integers.
      expect(
        sanitizeHeroImage({ ...valid, seed: Number.MAX_SAFE_INTEGER + 1 }),
      ).toBeUndefined();
    });

    it("rejects seed === Number.MAX_VALUE (a representable double well past safe-int)", () => {
      expect(
        sanitizeHeroImage({ ...valid, seed: Number.MAX_VALUE }),
      ).toBeUndefined();
    });
  });

  describe("dimension positivity guards", () => {
    it("rejects width === 0", () => {
      expect(sanitizeHeroImage({ ...valid, width: 0 })).toBeUndefined();
    });

    it("rejects height === 0", () => {
      expect(sanitizeHeroImage({ ...valid, height: 0 })).toBeUndefined();
    });

    it("rejects negative width", () => {
      expect(sanitizeHeroImage({ ...valid, width: -1024 })).toBeUndefined();
    });

    it("rejects negative height", () => {
      expect(sanitizeHeroImage({ ...valid, height: -768 })).toBeUndefined();
    });

    it("rejects non-integer width (e.g. half a pixel)", () => {
      expect(sanitizeHeroImage({ ...valid, width: 1024.5 })).toBeUndefined();
    });

    it("rejects width === Number.MAX_SAFE_INTEGER + 1 (= 2^53)", () => {
      // Regression guard for the consistency gap Devin Review flagged
      // between seed (uses isSafeInteger) and width/height (used
      // isInteger). `Number.isInteger(Number.MAX_SAFE_INTEGER + 1)`
      // returns `true` because 2^53 is exactly representable as a
      // double and is mathematically integer — letting a hand-edited
      // artifact JSON with `"width": 9007199254740992` past the
      // sanitizer. No display can render that, but the defence-in-
      // depth argument that justifies the seed safe-int gate applies
      // symmetrically here, so width/height now use the same
      // isSafeInteger predicate.
      expect(
        sanitizeHeroImage({
          ...valid,
          width: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toBeUndefined();
    });

    it("rejects height === Number.MAX_SAFE_INTEGER + 1 (= 2^53)", () => {
      expect(
        sanitizeHeroImage({
          ...valid,
          height: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toBeUndefined();
    });

    it("rejects width === Number.MAX_VALUE", () => {
      expect(
        sanitizeHeroImage({ ...valid, width: Number.MAX_VALUE }),
      ).toBeUndefined();
    });

    it("rejects height === Number.MAX_VALUE", () => {
      expect(
        sanitizeHeroImage({ ...valid, height: Number.MAX_VALUE }),
      ).toBeUndefined();
    });

    it("accepts width === Number.MAX_SAFE_INTEGER (boundary positive control)", () => {
      // Confirms the upper bound is inclusive, mirroring the seed
      // boundary test above. Realistically no UI will ever render
      // this, but the contract is "anything inside the safe-int range
      // is accepted, anything outside is rejected" — locking the
      // boundary in both directions.
      expect(
        sanitizeHeroImage({ ...valid, width: Number.MAX_SAFE_INTEGER }),
      ).toEqual({ ...valid, width: Number.MAX_SAFE_INTEGER });
    });
  });

  describe("missing / wrong-type fields", () => {
    it("rejects undefined / null", () => {
      expect(sanitizeHeroImage(undefined)).toBeUndefined();
      expect(sanitizeHeroImage(null)).toBeUndefined();
    });

    it("rejects a non-object (string, number, array)", () => {
      expect(sanitizeHeroImage("hello")).toBeUndefined();
      expect(sanitizeHeroImage(42)).toBeUndefined();
      expect(sanitizeHeroImage([1, 2, 3])).toBeUndefined();
    });

    it("rejects a missing prompt", () => {
      const { prompt: _prompt, ...withoutPrompt } = valid;
      void _prompt;
      expect(sanitizeHeroImage(withoutPrompt)).toBeUndefined();
    });

    it("rejects a non-string prompt", () => {
      expect(sanitizeHeroImage({ ...valid, prompt: 42 })).toBeUndefined();
    });

    it("does not propagate extra fields", () => {
      // The sanitizer builds a fresh object with exactly the five
      // known fields, so a malicious payload with extra properties
      // (e.g. `__proto__` injection attempts) cannot smuggle them
      // through. This is also a defence against prototype-pollution
      // on parse.
      const result = sanitizeHeroImage({
        ...valid,
        extra: "hostile",
        __proto__: { polluted: true },
      });
      expect(result).toEqual(valid);
      // `extra` is not a known key of `HeroImage`, so it must not
      // appear in the returned object.
      expect(Object.keys(result ?? {}).sort()).toEqual([
        "assetUrl",
        "height",
        "prompt",
        "seed",
        "width",
      ]);
    });
  });
});
