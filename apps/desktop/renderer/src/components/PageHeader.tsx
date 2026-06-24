import { ReactNode } from "react";
import { useCspNonce } from "../utils/cspNonce";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export default function PageHeader({
  title,
  description,
  actions,
}: PageHeaderProps) {
  const cspNonce = useCspNonce();
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description && (
          <p className="page-header-description">{description}</p>
        )}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
      <style nonce={cspNonce}>{`
        .page-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--spacing-md);
          margin-bottom: var(--spacing-xl);
          padding: var(--spacing-lg);
          background: var(--color-bg-surface);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-card);
          box-shadow: var(--shadow-xs);
        }
        .page-header-description {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          margin-top: var(--spacing-xs);
        }
        .page-header-actions {
          display: flex;
          gap: var(--spacing-sm);
          flex-shrink: 0;
          align-items: center;
        }
      `}</style>
    </div>
  );
}
