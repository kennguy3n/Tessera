import { ReactNode, isValidElement } from "react";
import { Inbox } from "lucide-react";
import { useCspNonce } from "../utils/cspNonce";

interface EmptyStateProps {
  /**
   * Either a string (legacy emoji/text icon, rendered as-is for
   * backwards compatibility) or a React node (preferred — a Lucide or
   * Phosphor icon component). When omitted, a default `Inbox` icon is
   * shown so empty pages always feel intentional rather than blank.
   */
  icon?: string | ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}

export default function EmptyState({
  icon,
  title,
  message,
  action,
}: EmptyStateProps) {
  const cspNonce = useCspNonce();
  let iconNode: ReactNode;
  if (icon === undefined || icon === null) {
    iconNode = <Inbox size={48} strokeWidth={1.5} aria-hidden="true" />;
  } else if (typeof icon === "string") {
    iconNode = <span aria-hidden="true">{icon}</span>;
  } else if (isValidElement(icon)) {
    iconNode = icon;
  } else {
    iconNode = null;
  }
  return (
    <div className="empty-state">
      {iconNode && <span className="empty-state-icon">{iconNode}</span>}
      {/*
        Empty states are always the primary content of a page or a
        top-level section that sits directly beneath the page `<h1>`
        (rendered by `PageHeader`), so the title is an `<h2>`: it is the
        first outline level under the page heading. Using `<h3>` here
        skipped a level (h1 → h3), which `heading-order` correctly flags
        and which makes the document outline misleading for screen-reader
        users navigating by heading.
      */}
      <h2 className="empty-state-title">{title}</h2>
      <p className="empty-state-message">{message}</p>
      {action && <div className="empty-state-action">{action}</div>}
      <style nonce={cspNonce}>{`
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: var(--spacing-2xl);
          text-align: center;
          animation: empty-state-in var(--duration-normal) var(--ease-out);
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-card);
          box-shadow: var(--shadow-xs);
        }
        .empty-state-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 5rem;
          height: 5rem;
          margin-bottom: var(--spacing-md);
          border-radius: var(--radius-full);
          background: linear-gradient(
            135deg,
            var(--color-primary-light) 0%,
            var(--color-bg-page) 100%
          );
          color: var(--color-primary);
          font-size: 2rem;
        }
        .empty-state-title {
          color: var(--color-text-headline);
          font-size: var(--font-size-xl);
          margin-bottom: var(--spacing-sm);
        }
        .empty-state-message {
          color: var(--color-text-secondary);
          font-size: var(--font-size-base);
          line-height: var(--line-height-relaxed);
          max-width: 440px;
          margin-bottom: var(--spacing-lg);
        }
        @keyframes empty-state-in {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .empty-state {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
