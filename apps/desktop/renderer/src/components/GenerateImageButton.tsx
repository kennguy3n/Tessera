/**
 * `GenerateImageButton` — reusable prompt + Generate UI used by the
 * Infographic and LandingPage editors to embed a generated hero
 * image without leaving the editor pane.
 *
 * Responsibilities
 * ----------------
 * 1. Probe `tessera.imagegen.isAvailable()` on mount and gate the
 *    Generate button. The main-process `isAvailable` already factors
 *    in (a) the bridge being loaded, (b) the host's tier + compute
 *    backend satisfying `isCapabilityAvailable("imagegen")`, and (c)
 *    an imagegen model being installed on disk — so the renderer
 *    just trusts the single boolean.
 * 2. Expose a prompt textarea + size dropdown (square / portrait /
 *    landscape) + Generate button + transient error row (the
 *    button renders "Generating…" while in flight; success
 *    status is the parent's job — see below).
 * 3. Call `tessera.imagegen.generate({ artifactId, prompt, width,
 *    height, sectionIndex })` and forward the resulting
 *    `{ assetUrl, seed, durationMs, ... }` to the parent via
 *    `onGenerated`. The parent decides where to persist the URL
 *    (e.g. `data.heroImage.assetUrl` for the Infographic editor).
 *
 * Why we don't render a post-generation "Generated in Xs · seed Y"
 * status here
 * --------------------------------------------------------------
 * Both editors render `<GenerateImageButton>` conditionally
 * (`data.heroImage ? <Preview/> : <GenerateImageButton/>`) and the
 * `onGenerated` callback writes `data.heroImage` synchronously. The
 * next React render flips the ternary and unmounts the button —
 * meaning any status DOM kept in `GenerateImageButton`'s state
 * would never paint. Devin Review PR #38 pass-4 📝 correctly
 * flagged that as dead code; the success-side status (`durationMs`,
 * `seed`) is now the parent's responsibility (the hero preview
 * shows seed in its caption). Errors stay here — they fire when
 * the button is still mounted and there is no parent state to flip.
 *
 * Why this lives as its own component
 * -----------------------------------
 * Both editors need the same UI shape and the same fail-soft
 * behaviour (unavailable → grey out the button; error → surface the
 * message; in-flight → disable the button to honour the IPC
 * single-in-flight contract). Inlining the logic in each editor
 * would duplicate ~80 lines and the two copies would inevitably
 * drift (e.g. one editor swallowing errors, the other surfacing
 * them). The shared component pins one behaviour and one a11y
 * surface — pinned by `GenerateImageButton.test.tsx`.
 *
 * Why no preview here
 * --------------------
 * The preview belongs in the editor (next to the rest of the hero
 * fields) so the user can position / resize / clear the image
 * alongside the headline. This component is intentionally just the
 * generation gateway — the parent decides what to do with the URL.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";

/**
 * Allowed image dimensions. Matches the SDXL-family models' native
 * training resolutions (1024×1024, 1024×1536, 1536×1024) so the
 * sampler doesn't have to upscale a non-native ratio. The strings
 * are stable IPC values — do NOT change the literals without also
 * updating the `IMAGEGEN_DIMENSION_PRESETS` table in
 * `electron/ipc/imagegen.ts`.
 */
export type ImageGenDimension = "square" | "portrait" | "landscape";

interface DimensionPreset {
  id: ImageGenDimension;
  label: string;
  width: number;
  height: number;
}

const DIMENSIONS: readonly DimensionPreset[] = [
  { id: "square", label: "Square (1024×1024)", width: 1024, height: 1024 },
  { id: "portrait", label: "Portrait (1024×1536)", width: 1024, height: 1536 },
  {
    id: "landscape",
    label: "Landscape (1536×1024)",
    width: 1536,
    height: 1024,
  },
] as const;

export interface GenerateImageResult {
  /** Absolute path on disk. The renderer should not read this. */
  path: string;
  /**
   * `tessera-asset://` URL the renderer drops directly into
   * `<img src>`. Always set on success — main-process refuses to
   * return a result whose path is outside `<userData>/generated-
   * images/`.
   */
  assetUrl: string;
  seed: number;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number;
  /** The prompt used; echoed for the caller's persistence. */
  prompt: string;
}

export interface GenerateImageButtonProps {
  /**
   * Owning artifact's id. Routed into `<userData>/generated-images/
   * <artifactId>/` by the main-process handler so the same artifact
   * gets all of its generations grouped together for easy cleanup
   * on artifact delete.
   */
  artifactId: string;
  /**
   * Optional section index — embedded in the on-disk filename so
   * the user can correlate generations to their target slot in a
   * future "regenerate this section's image" feature.
   */
  sectionIndex?: number;
  /**
   * Default prompt the textarea opens with. Empty string by default.
   * Both editors seed this with a synthetic prompt derived from the
   * hero headline so the user gets a useful starting point on a
   * fresh artifact.
   */
  initialPrompt?: string;
  /** Triggered on a successful generation. */
  onGenerated: (result: GenerateImageResult) => void;
}

export default function GenerateImageButton({
  artifactId,
  sectionIndex,
  initialPrompt = "",
  onGenerated,
}: GenerateImageButtonProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [dimension, setDimension] = useState<ImageGenDimension>("square");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resolve availability lazily so the editor pane doesn't pay
    // the IPC roundtrip for users on hosts where imagegen will
    // never light up (no GPU, no model installed).
    void window.tessera.imagegen
      .isAvailable()
      .then((ok) => {
        if (!cancelled) setAvailable(ok);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          // Treat IPC failures as "not available" — the user
          // doesn't need to see the underlying error; the Generate
          // button stays disabled.
          console.warn("imagegen.isAvailable failed:", e);
          setAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const preset = useMemo(
    () => DIMENSIONS.find((d) => d.id === dimension) ?? DIMENSIONS[0],
    [dimension],
  );

  const onClickGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Prompt is required");
      return;
    }
    setError(null);
    setInFlight(true);
    try {
      const out = await window.tessera.imagegen.generate({
        prompt: trimmed,
        width: preset.width,
        height: preset.height,
        artifactId,
        sectionIndex,
      });
      const result: GenerateImageResult = {
        path: out.path,
        assetUrl: out.assetUrl,
        seed: out.seed,
        width: out.width,
        height: out.height,
        durationMs: out.durationMs,
        sizeBytes: out.sizeBytes,
        prompt: trimmed,
      };
      onGenerated(result);
    } catch (e: unknown) {
      // Surface the underlying error message — the IPC handler
      // already maps native errors to user-readable strings (e.g.
      // "Rate limit exceeded", "already in flight", "no imagegen
      // model installed"). Pass them straight through; the schema
      // validator strips anything sensitive.
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setInFlight(false);
    }
  }, [artifactId, sectionIndex, prompt, preset, onGenerated]);

  if (available === null) {
    // Pending the first `isAvailable` IPC resolution. Render
    // nothing rather than the full form-with-disabled-button so
    // a host where imagegen is permanently unavailable (no GPU)
    // doesn't flash a textarea + Generate button only to
    // immediately replace it with the unavailable banner on
    // every editor open. The IPC roundtrip is single-digit ms
    // in practice (cheap stat on the active-model-imagegen.json
    // record), so the empty interval is imperceptible — much
    // less jarring than the flash. Devin Review PR #38 pass-8
    // 📝 finding.
    return (
      <div
        className="imagegen-pending"
        data-testid="imagegen-pending"
        aria-hidden="true"
      />
    );
  }

  if (available === false) {
    // Render a brief explanation rather than just hiding the
    // affordance so the user can see WHY the button is missing —
    // and we can link to the Settings → Models tab in a future
    // block (a deep link UI isn't wired yet).
    return (
      <div
        className="imagegen-unavailable"
        data-testid="imagegen-unavailable"
        role="status"
      >
        Image generation is not available on this device. Install an image
        model in Settings → Models, or run on a host with a supported GPU /
        Apple-Silicon backend.
      </div>
    );
  }

  return (
    <div className="imagegen-button" data-testid="imagegen-button">
      <label className="imagegen-prompt-label">
        Image prompt
        <textarea
          aria-label="Image prompt"
          className="imagegen-prompt-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A vibrant abstract hero image, soft gradients, …"
          rows={3}
          disabled={inFlight}
        />
      </label>
      <div className="imagegen-button-row">
        <label>
          Dimensions:
          <select
            aria-label="Image dimensions"
            value={dimension}
            onChange={(e) =>
              setDimension(e.target.value as ImageGenDimension)
            }
            disabled={inFlight}
          >
            {DIMENSIONS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="imagegen-generate-button"
          onClick={() => {
            void onClickGenerate();
          }}
          disabled={inFlight || available === null}
          aria-label="Generate image"
        >
          {inFlight ? (
            <>
              <Loader2 size={16} className="imagegen-spinner" /> Generating…
            </>
          ) : (
            <>
              <ImagePlus size={16} /> Generate
            </>
          )}
        </button>
      </div>
      {error && (
        <div
          className="imagegen-error"
          data-testid="imagegen-error"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
}
