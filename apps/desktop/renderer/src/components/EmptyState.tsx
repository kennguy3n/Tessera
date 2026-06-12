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
      <h3 className="empty-state-title">{title}</h3>
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
        }
        .empty-state-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 4rem;
          height: 4rem;
          margin-bottom: var(--spacing-md);
          border-radius: var(--radius-full);
          background-color: var(--color-primary-light);
          color: var(--color-primary);
          font-size: 1.75rem;
        }
        .empty-state-title {
          color: var(--color-text-headline);
          font-size: var(--font-size-lg);
          margin-bottom: var(--spacing-sm);
        }
        .empty-state-message {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          line-height: var(--line-height-relaxed);
          max-width: 400px;
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
