import type { DeviceKind } from "./types.ts";
export function DeviceIcon({
  kind,
  size = 42,
}: {
  kind: DeviceKind;
  size?: number;
}) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      {...common}
    >
      {kind === "router" ? (
        <>
          <ellipse cx="24" cy="15" rx="19" ry="8" />
          <path d="M5 15v15c0 5 8 9 19 9s19-4 19-9V15M15 14h18m-4-4 4 4-4 4m-10 6H10m4-4-4 4 4 4m11 2h10m-4-4 4 4-4 4" />
        </>
      ) : kind === "switch" ? (
        <>
          <path d="m4 17 9-7h25l7 7v20H4Z" />
          <path d="M4 20h41" />
          {[10, 18, 26, 34].map((x) => (
            <rect key={x} x={x} y="27" width="5" height="5" rx=".5" />
          ))}
        </>
      ) : kind === "ap" ? (
        <>
          <rect x="6" y="25" width="36" height="13" rx="4" />
          <path d="M12 25V10m24 15V10M12 32h3m5 0h3m-5-14q6-6 12 0m-9 3q3-3 6 0" />
        </>
      ) : kind === "laptop" ? (
        <>
          <rect x="8" y="8" width="32" height="24" rx="2" />
          <path d="m8 32-5 6h42l-5-6m-23 3h14" />
        </>
      ) : kind === "phone" ? (
        <>
          <rect x="5" y="8" width="38" height="31" rx="4" />
          <rect x="9" y="5" width="8" height="37" rx="4" />
          <path d="M22 13h16v8H22zM22 27h4m5 0h4m-13 5h4m5 0h4" />
        </>
      ) : kind === "server" ? (
        <>
          <rect x="11" y="4" width="26" height="40" rx="4" />
          <path d="M11 17h26M11 30h26M17 10h9M17 23h9M17 36h9" />
          <circle cx="31" cy="10" r="1" />
          <circle cx="31" cy="23" r="1" />
          <circle cx="31" cy="36" r="1" />
        </>
      ) : (
        <>
          <rect x="5" y="6" width="38" height="27" rx="3" />
          <path d="M5 27h38M19 33v7m10-7v7M12 42h24" />
        </>
      )}
    </svg>
  );
}
