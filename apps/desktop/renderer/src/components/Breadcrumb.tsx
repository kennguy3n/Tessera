/**
 * Phase 18 Task 18: breadcrumb navigation.
 *
 * Renders a horizontal trail of links ending with the current
 * page label. Each non-terminal segment is clickable and navigates
 * to its `to` route; the terminal segment is rendered as plain
 * text to communicate "you are here".
 *
 * The component is intentionally dumb — pages own the trail
 * because only they know the deepest crumb (e.g. an artifact title
 * that has to be fetched from the API). Pages pass the full
 * trail; this component does not infer it from the route.
 */

import { Link } from "react-router-dom";
import { useCspNonce } from "../utils/cspNonce";

export interface BreadcrumbItem {
  /** Label shown to the user. */
  label: string;
  /**
   * Route to navigate to when this crumb is clicked. The terminal
   * (current) crumb should be created without `to` — it renders
   * as plain text.
   */
  to?: string;
}

interface BreadcrumbProps {
  items: ReadonlyArray<BreadcrumbItem>;
  /** ARIA label for the nav landmark. Defaults to "Breadcrumb". */
  ariaLabel?: string;
}

export default function Breadcrumb({
  items,
  ariaLabel = "Breadcrumb",
}: BreadcrumbProps) {
  const cspNonce = useCspNonce();
  if (items.length === 0) return null;
  return (
    <nav aria-label={ariaLabel} className="breadcrumb-nav">
      <ol className="breadcrumb-list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="breadcrumb-item">
              {isLast || !item.to ? (
                <span
                  className="breadcrumb-current"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link className="breadcrumb-link" to={item.to}>
                  {item.label}
                </Link>
              )}
              {!isLast && (
                <span aria-hidden="true" className="breadcrumb-sep">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <style nonce={cspNonce}>{`
        .breadcrumb-nav {
          margin-bottom: var(--spacing-md);
        }
        .breadcrumb-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: var(--spacing-xs);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .breadcrumb-item {
          display: inline-flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .breadcrumb-link {
          color: var(--color-text-secondary);
          text-decoration: none;
        }
        .breadcrumb-link:hover {
          color: var(--color-text-body);
          text-decoration: underline;
        }
        .breadcrumb-current {
          color: var(--color-text-body);
          font-weight: var(--font-weight-medium);
        }
        .breadcrumb-sep {
          color: var(--color-text-tertiary, var(--color-text-secondary));
          user-select: none;
        }
      `}</style>
    </nav>
  );
}
