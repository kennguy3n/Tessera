import { ReactNode } from "react";

interface EmptyStateProps {
  icon?: string;
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
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-icon">{icon}</span>}
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-message">{message}</p>
      {action && <div className="empty-state-action">{action}</div>}
      <style>{`
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: var(--spacing-2xl);
          text-align: center;
        }
        .empty-state-icon {
          font-size: 3rem;
          margin-bottom: var(--spacing-md);
        }
        .empty-state-title {
          color: var(--color-text-headline);
          margin-bottom: var(--spacing-sm);
        }
        .empty-state-message {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          max-width: 400px;
          margin-bottom: var(--spacing-lg);
        }
      `}</style>
    </div>
  );
}
