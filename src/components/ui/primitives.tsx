import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { hueFor, initials } from "@/lib/format";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Button({
  variant = "default",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const variantClass =
    variant === "primary"
      ? "btn--primary"
      : variant === "ghost"
        ? "btn--ghost"
        : variant === "danger"
          ? "btn--danger"
          : "";
  return (
    <button className={cn("btn", variantClass, size === "sm" && "btn--sm", className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: "default" | "gold";
  large?: boolean;
}

export function IconButton({
  label,
  active,
  tone = "default",
  large,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "icon-btn",
        active && (tone === "gold" ? "is-gold" : "is-on"),
        large && "icon-btn--lg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind?: "group" | "friend" | "warn" | "danger";
  children: ReactNode;
}) {
  return <span className={cn("badge", kind && `badge--${kind}`)}>{children}</span>;
}

export function Avatar({
  name,
  src,
  size = "md",
}: {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  const sizeClass = size === "sm" ? "avatar--sm" : size === "lg" ? "avatar--lg" : "";
  const hue = hueFor(name || "?");

  if (src && !broken) {
    return (
      <div className={cn("avatar", sizeClass)}>
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div
      className={cn("avatar", sizeClass)}
      style={{ background: `hsl(${hue} 36% 45%)` }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn("switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={cn(value === option.value && "is-on")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  children,
  align = "center",
  label = "对话框",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "center" | "top";
  label?: string;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overlay = overlayRef.current;
    const focusables = () =>
      [
        ...(overlay?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
    requestAnimationFrame(() => {
      overlay?.focus();
    });
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={overlayRef}
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={align === "top" ? { alignItems: "flex-start" } : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
}) {
  return (
    <div className="modal__head">
      <div>
        <div className="modal__title">{title}</div>
        {subtitle ? <div className="form-hint" style={{ marginTop: 2 }}>{subtitle}</div> : null}
      </div>
      {onClose ? (
        <IconButton label="关闭" style={{ marginLeft: "auto" }} onClick={onClose}>
          <X size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      {children}
      {hint ? <div className="form-hint">{hint}</div> : null}
    </div>
  );
}
