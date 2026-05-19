import { ReactNode, CSSProperties } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
}

export default function Card({ children, className, style, onClick }: CardProps) {
  return (
    <div
      className={`card ${onClick ? "card-clickable" : ""} ${className ?? ""}`}
      style={style}
      onClick={onClick}
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
      <style>{`
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
