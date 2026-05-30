import { ReactNode, CSSProperties } from "react";
import { useCspNonce } from "../utils/cspNonce";

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /**
   * Forwarded as `data-testid` on the root `<div>` so callers can
   * target the whole card from vitest / RTL without having to add
   * a wrapper element. Kept narrow rather than spreading arbitrary
   * `data-*` props so the type signature stays readable.
   */
  "data-testid"?: string;
}

export default function Card({
  children,
  className,
  style,
  onClick,
  "data-testid": dataTestId,
}: CardProps) {
  const cspNonce = useCspNonce();
  return (
    <div
      className={`card ${onClick ? "card-clickable" : ""} ${className ?? ""}`}
      style={style}
      onClick={onClick}
      data-testid={dataTestId}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
      <style nonce={cspNonce}>{`
        .card-clickable {
          cursor: pointer;
        }
        .card-clickable:focus-visible {
          outline: 2px solid var(--color-primary);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
