/**
 * first-run onboarding wizard.
 *
 * Shows a 3-step modal to fresh installs: (1) "Add your first source"
 * with an inline folder picker CTA, (2) "Pick a template" surfacing
 * the three most-used templates, (3) "Your workspace is ready" with
 * links to documentation. The wizard mounts only when ALL three
 * conditions hold: `settings.onboardingCompleted === false`, the
 * source list is empty, and the artifact list is empty. This three-way
 * gate prevents the wizard from popping up against an existing user
 * whose `onboardingCompleted` flag was reset by a corrupted config
 * file (their DB still contains sources / artifacts and the wizard
 * has nothing useful to offer them).
 *
 * Once any of "Get Started", "Skip", or the final step's "Finish"
 * button is clicked, the wizard calls `settings:update` with
 * `{ onboardingCompleted: true }` so it never re-appears on this
 * install — even if the user later deletes every source. Manual
 * "Add Source" / "Browse Templates" CTAs remain available on the
 * Home page for that case.
 *
 * Keyboard semantics: focus moves to the modal on mount (via
 * `autoFocus` on the primary CTA), `Escape` triggers the same
 * "dismiss + persist" path as the explicit Skip button so the user
 * can never get stuck.
 */
import { useEffect, useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderPlus, LayoutTemplate, Rocket } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { useCspNonce } from "../utils/cspNonce";

type Step = 0 | 1 | 2;

interface OnboardingWizardProps {
  /**
   * Called once the user has explicitly dismissed the wizard (Skip,
   * Finish, Escape) AND `settings:update` has acknowledged the
   * persisted change. The caller is responsible for refreshing its
   * `useSettings` state so the wizard does not remount.
   *
   * Note: this is intentionally synchronous (`void`). The Promise
   * returned by `settings:update` is awaited inside the wizard so
   * the caller's `onDismiss` only fires after the persist has
   * succeeded — preventing the "user dismissed, closed the app,
   * relaunched, wizard re-appeared" race.
   */
  onDismiss: () => void;
}

interface StepCopy {
  title: string;
  message: string;
  icon: React.ReactNode;
  primaryLabel: string;
  primaryHref?: string;
}

const STEP_COPY: Record<Step, StepCopy> = {
  0: {
    title: "Add your first source",
    message:
      "Tessera indexes folders and files you trust. Point it at a local folder to extract searchable chunks, then create artifacts that cite that content.",
    icon: <FolderPlus size={48} strokeWidth={1.5} aria-hidden="true" />,
    primaryLabel: "Add a folder",
    primaryHref: "/sources",
  },
  1: {
    title: "Pick a template",
    message:
      "Templates jump-start documents, slides, sheets, and bases with the right shape. Browse the gallery to see what's available.",
    icon: <LayoutTemplate size={48} strokeWidth={1.5} aria-hidden="true" />,
    primaryLabel: "Browse templates",
    primaryHref: "/templates",
  },
  2: {
    title: "Your workspace is ready",
    message:
      "Search across every source, draft new artifacts, and share results. The README walks through Tessera's data flow if you want a deeper tour.",
    icon: <Rocket size={48} strokeWidth={1.5} aria-hidden="true" />,
    primaryLabel: "Finish",
  },
};

/**
 * Top 3 built-in templates surfaced in step 2. The list intentionally
 * mirrors the most-clicked templates on the existing `TemplatesPage`
 * (PRD, QBR, Budget) — the wizard does not call `templates:list`
 * because we want the same three to appear deterministically even
 * before the templates IPC has finished warming up.
 */
const FEATURED_TEMPLATES: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
}> = [
  {
    id: "prd-v1",
    name: "PRD",
    description: "Product Requirements Document",
  },
  {
    id: "qbr-v1",
    name: "QBR",
    description: "Quarterly Business Review deck",
  },
  {
    id: "budget-v1",
    name: "Budget",
    description: "Budget spreadsheet with variance analysis",
  },
];

export default function OnboardingWizard({ onDismiss }: OnboardingWizardProps) {
  const cspNonce = useCspNonce();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  // Re-entrancy guard MUST be a ref, not a useState value
  // Review PR #70. The risk is a fast Escape press while
  // a Finish click's `await api.settings.update(...)` is still
  // resolving: the Modal's Escape handler closes over the
  // `dismiss` reference captured when the modal opened, which in
  // turn closes over the OLD `persisting === false` value (React
  // closures capture state at creation time). With a useState
  // guard the second `dismiss()` would proceed in parallel,
  // fire `settings.update` twice, and call `onDismiss()` twice
  // from two separate `finally` blocks. With a ref, every reader
  // sees the live current value regardless of which closure they
  // came from, so the second call short-circuits cleanly.
  //
  // We keep a separate `disabled` useState for the button visual:
  // refs do not trigger re-renders, but the button's `disabled`
  // prop must reflect the in-flight state so the user gets visual
  // feedback and screen-reader announcements. The ref drives
  // correctness; the state drives presentation, set in lock-step.
  const persistingRef = useRef(false);
  const [disabled, setDisabled] = useState(false);

  /**
   * Persist `onboardingCompleted: true` and dismiss. Centralised so
   * Skip / Finish / Escape all flow through the same code path —
   * meaning we cannot regress one of them and leave the user able to
   * see the wizard again on next launch.
   *
   * On IPC failure we still dismiss the modal (so the user is not
   * trapped behind a broken settings handler) but we leave the
   * persisted flag alone so the wizard re-appears on next launch
   * for them to try again. The renderer logs the error via
   * `console.warn` — there is no toast surface available this early
   * in the bootstrap path and silently swallowing would mask a real
   * IPC regression.
   */
  const dismiss = useCallback(async () => {
    if (persistingRef.current) return;
    persistingRef.current = true;
    setDisabled(true);
    try {
      const api = window.tessera;
      if (api?.settings) {
        await api.settings.update({ onboardingCompleted: true });
      }
    } catch (err) {
      console.warn(
        "OnboardingWizard: failed to persist onboardingCompleted",
        err,
      );
    } finally {
      // We intentionally do NOT release `persistingRef` here. The
      // function dismisses the modal as its terminal step, and the
      // wizard is single-shot — re-arming the guard would invite a
      // race where the unmount runs concurrently with a stale
      // post-`finally` Escape press from a still-focused element.
      // The component leaves the DOM moments later and the ref is
      // garbage-collected with it.
      setDisabled(false);
      onDismiss();
    }
  }, [onDismiss]);

  // Escape == Skip. The Modal component already calls `onClose` on
  // Escape; we route that through `dismiss()` so the persist path is
  // hit even when the user dismissed via the keyboard rather than a
  // click.
  const handleClose = useCallback(() => {
    void dismiss();
  }, [dismiss]);

  // Centralised primary-CTA dispatch so step 0 and step 1 can route
  // the user to the appropriate page (and then continue the wizard
  // when they navigate back), while step 2 finalises the dismissal.
  const onPrimary = useCallback(() => {
    const copy = STEP_COPY[step];
    if (copy.primaryHref) {
      navigate(copy.primaryHref);
      // Advance the wizard so a return navigation lands the user on
      // the next step rather than re-opening the same page. We
      // intentionally do NOT persist `onboardingCompleted: true`
      // here — if the user navigates away mid-wizard and force-quits
      // the app, we want them to see step 0 again on next launch.
      setStep((s) => (s === 2 ? 2 : ((s + 1) as Step)));
      return;
    }
    void dismiss();
  }, [step, navigate, dismiss]);

  // Step 0's "Open templates" secondary link doubles as the
  // "browse templates" CTA inside the featured-template card list
  // on step 1. Centralising the navigation here keeps the routes
  // consistent and avoids hard-coding URLs into the JSX twice.
  const goToTemplate = useCallback(
    (id: string) => {
      navigate(`/create?template=${id}`);
      setStep(2);
    },
    [navigate],
  );

  // Mount-time effect: capture the body's scroll position so a long
  // body of artifacts behind the modal doesn't jitter when the modal
  // opens. The native Modal component handles focus trapping, so we
  // only need to lock scroll.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const copy = STEP_COPY[step];

  return (
    <Modal
      isOpen={true}
      onClose={handleClose}
      title={`Welcome to Tessera — step ${step + 1} of 3`}
    >
      <div className="onboarding-wizard" data-step={step}>
        <div className="onboarding-icon" aria-hidden="true">
          {copy.icon}
        </div>
        <h2 className="onboarding-title">{copy.title}</h2>
        <p className="onboarding-message">{copy.message}</p>

        {step === 1 && (
          <ul className="onboarding-template-list">
            {FEATURED_TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="onboarding-template-item"
                  onClick={() => goToTemplate(t.id)}
                >
                  <span className="onboarding-template-name">{t.name}</span>
                  <span className="onboarding-template-description">
                    {t.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="onboarding-actions">
          <Button onClick={onPrimary} autoFocus disabled={disabled}>
            {copy.primaryLabel}
          </Button>
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={disabled}
          >
            {step === 2 ? "Close" : "Skip"}
          </Button>
        </div>

        <div className="onboarding-progress" aria-hidden="true">
          {([0, 1, 2] as const).map((s) => (
            <span
              key={s}
              className={`onboarding-dot ${s === step ? "active" : ""}`}
            />
          ))}
        </div>
      </div>

      <style nonce={cspNonce}>{`
        .onboarding-wizard {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: var(--spacing-md) var(--spacing-sm);
          gap: var(--spacing-sm);
        }
        .onboarding-icon {
          color: var(--color-primary, #7c3aed);
          margin-bottom: var(--spacing-sm);
        }
        .onboarding-title {
          margin: 0;
          font-size: var(--font-size-lg);
          color: var(--color-text-headline);
        }
        .onboarding-message {
          color: var(--color-text-secondary);
          max-width: 480px;
          margin: 0;
        }
        .onboarding-template-list {
          list-style: none;
          padding: 0;
          margin: var(--spacing-md) 0 0;
          width: 100%;
          max-width: 480px;
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .onboarding-template-item {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border, #d9d9d9);
          border-radius: var(--radius-md, 6px);
          background: var(--color-surface, #fff);
          color: inherit;
          cursor: pointer;
          text-align: left;
        }
        .onboarding-template-item:hover,
        .onboarding-template-item:focus-visible {
          border-color: var(--color-primary, #7c3aed);
          outline: none;
        }
        .onboarding-template-name {
          font-weight: 600;
          color: var(--color-text-headline);
        }
        .onboarding-template-description {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .onboarding-actions {
          display: flex;
          gap: var(--spacing-sm);
          margin-top: var(--spacing-md);
        }
        .onboarding-progress {
          display: flex;
          gap: 6px;
          margin-top: var(--spacing-md);
        }
        .onboarding-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--color-border, #d9d9d9);
        }
        .onboarding-dot.active {
          background: var(--color-primary, #7c3aed);
        }
      `}</style>
    </Modal>
  );
}
