import { InputHTMLAttributes } from "react";

interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  onSearch?: (value: string) => void;
}

export default function SearchInput({
  onSearch,
  onChange,
  ...props
}: SearchInputProps) {
  return (
    <div className="search-input-wrapper">
      <span className="search-icon" aria-hidden="true">
        &#x1F50D;
      </span>
      <input
        type="search"
        className="input"
        onChange={(e) => {
          onChange?.(e);
          onSearch?.(e.target.value);
        }}
        {...props}
      />
    </div>
  );
}
