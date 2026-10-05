import clsx from "clsx";

/** A small on/off switch for a row in a list, named by its label alone. */
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-60",
        checked ? "bg-pink" : "bg-line",
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
