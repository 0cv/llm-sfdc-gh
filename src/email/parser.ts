/**
 * Parses Salesforce exception emails into structured error info.
 *
 * Salesforce exception emails typically contain:
 * - Subject: "Sandbox: Developer script exception from <OrgName>"
 *   or "Developer script exception from <OrgName>"
 * - Body: Apex class/trigger name, line number, exception type, stack trace
 */

export interface SalesforceError {
  orgName: string;
  exceptionType: string;
  message: string;
  stackTrace: string;
  apexClass: string | null;
  lineNumber: number | null;
  /** Raw email body for full context */
  rawBody: string;
  /** Hash for deduplication */
  fingerprint: string;
}

export function parseSalesforceExceptionEmail(
  subject: string,
  body: string
): SalesforceError | null {
  // Check if this is a Salesforce exception email
  if (!subject.includes("script exception")) {
    return null;
  }

  // Extract org name from subject
  const orgMatch = subject.match(/exception from\s+(.+)/i);
  const orgName = orgMatch?.[1]?.trim() ?? "Unknown";

  // Extract exception type (e.g., System.NullPointerException)
  const exTypeMatch = body.match(/(System\.\w+Exception|[\w.]+Exception):\s*(.+)/);
  const exceptionType = exTypeMatch?.[1] ?? "Unknown";
  const message = exTypeMatch?.[2]?.trim() ?? body.slice(0, 200);

  // Extract Apex class/trigger name
  const classMatch = body.match(/Class\.(\S+)\.|Trigger\.(\S+)\./);
  const apexClass = classMatch?.[1] ?? classMatch?.[2] ?? null;

  // Extract line number
  const lineMatch = body.match(/line\s+(\d+)/i);
  const lineNumber = lineMatch ? parseInt(lineMatch[1]) : null;

  // Extract stack trace (everything after "Apex script unhandled exception")
  const traceMatch = body.match(/(?:Apex script unhandled exception|caused by:)([\s\S]+)/i);
  const stackTrace = traceMatch?.[1]?.trim() ?? body;

  // Fingerprint for dedup: hash exception type + class + line
  const fingerprint = createFingerprint(exceptionType, apexClass, lineNumber);

  return {
    orgName,
    exceptionType,
    message,
    stackTrace,
    apexClass,
    lineNumber,
    rawBody: body,
    fingerprint,
  };
}

function createFingerprint(
  exceptionType: string,
  apexClass: string | null,
  lineNumber: number | null
): string {
  const raw = `${exceptionType}:${apexClass ?? ""}:${lineNumber ?? ""}`;
  // Simple hash — good enough for dedup
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
