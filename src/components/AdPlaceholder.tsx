interface AdPlaceholderProps {
  label?: string;
  className?: string;
}

export default function AdPlaceholder({
  label = "広告",
  className = "",
}: AdPlaceholderProps) {
  return (
    <div
      className={`flex items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-gray-300 text-xs py-6 ${className}`}
      aria-label="広告枠"
    >
      {label}
    </div>
  );
}
