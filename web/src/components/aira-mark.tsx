type Props = { size?: number; strokeWidth?: number };

export function AiraMark({ size = 14, strokeWidth = 1.6 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 20 L12 4 L19.5 20" />
      <circle cx="12" cy="15.2" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
