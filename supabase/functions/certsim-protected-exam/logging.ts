export interface SafeLog {
  correlationId: string;
  route: string;
  method: string;
  outcome: string;
  status: number;
  durationMs: number;
  replay?: boolean;
}
export function logSafe(
  event: SafeLog,
  sink: (line: string) => void = console.log,
): void {
  sink(JSON.stringify(event));
}
