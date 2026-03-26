/**
 * Parses Salesforce exception emails into structured error info.
 *
 * Subject format:
 *   [Sandbox: ]Developer script exception from <OrgName> : <Trigger> : <Trigger>:
 *   execution of <Op> caused by: <ExType>: <message>
 *
 * Body format:
 *   Apex script unhandled trigger exception by user/organization: <userId>/<orgId>
 *
 *   Organization: <OrgName> (<url>).
 *
 *   <Trigger>: execution of <BeforeInsert|AfterUpdate|...>
 *
 *   caused by: <ExType>: <message>
 *   [caused by: <ExType>: <message>]   ← may repeat for nested exceptions
 *
 *   Class.<ClassName>.<method>: line N, column 1
 *   Trigger.<TriggerName>: line N, column 1
 */

export interface SalesforceError {
  /** Original email subject line */
  subject: string;
  orgName: string;
  /** Entry-point trigger (e.g. "PJN_Case") */
  triggerName: string | null;
  /** Trigger DML operation (e.g. "AfterUpdate") */
  triggerOperation: string | null;
  /** Root-cause exception type (from the deepest "caused by:" block) */
  exceptionType: string;
  /** Root-cause error message */
  message: string;
  /** Full stack trace (Class./Trigger. lines) */
  stackTrace: string;
  /** Class or trigger where the error originated (first frame in stack) */
  apexClass: string | null;
  /** Line number in apexClass where the error originated */
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
  if (subject.toLowerCase().includes("script exception")) {
    return parseApexError(subject, body);
  }
  if (subject.toLowerCase().includes("an error occurred with your") && subject.includes("flow")) {
    return parseFlowError(subject, body);
  }
  return null;
}

function parseFlowError(subject: string, body: string): SalesforceError | null {
  // Subject: An error occurred with your "Contact Attempt - Create or Update" flow

  // Flow API name: "Flow API Name: MVN_Contact_Attempt_Create_or_Update"
  const flowApiMatch = body.match(/Flow API Name:\s*(\S+)/);
  const flowApiName = flowApiMatch?.[1] ?? null;

  // Flow label from subject: between the quotes
  const flowLabelMatch = subject.match(/"([^"]+)"/);
  const flowLabel = flowLabelMatch?.[1] ?? flowApiName ?? "Unknown Flow";

  // Org name: "Org: Kiniksa Pharmaceuticals (00D...)"
  const orgMatch = body.match(/^Org:\s*(.+?)\s*\(/m);
  const orgName = orgMatch?.[1]?.trim() ?? "Unknown";

  // Error element: "Error element Update_Case_with_Call_Back (FlowRecordUpdate)."
  const elementMatch = body.match(/Error element\s+(\S+)\s+\((\w+)\)/);
  const errorElement = elementMatch?.[1] ?? null;
  const elementType = elementMatch?.[2] ?? null;

  // Error message: after "This error occurred:" or "Error Occurred:"
  const errorMatch = body.match(/This error occurred:\s*([^\n.]+(?:\.[^\n]+)*?)(?:\.\s*You can look up|$)/im);
  const message = errorMatch?.[1]?.trim() ?? body.slice(0, 300);

  // Exception type from error code e.g. FIELD_CUSTOM_VALIDATION_EXCEPTION
  const errorCodeMatch = message.match(/^([A-Z_]+(?:_EXCEPTION|_ERROR)?)/);
  const exceptionType = errorCodeMatch?.[1] ?? "FlowError";

  // apexClass = flow API name (that's what needs fixing)
  const apexClass = flowApiName;

  // No stack trace for flows — use the decision/element trail from the body
  const stackTrace = `Flow: ${flowLabel} (${flowApiName})\nFailed element: ${errorElement} (${elementType})\n${message}`;

  const fingerprint = createFingerprint(exceptionType, apexClass, null);

  return {
    subject,
    orgName,
    triggerName: flowApiName,
    triggerOperation: elementType ?? "Flow",
    exceptionType,
    message,
    stackTrace,
    apexClass,
    lineNumber: null,
    rawBody: body,
    fingerprint,
  };
}

function parseApexError(subject: string, body: string): SalesforceError | null {

  // ── Org name ────────────────────────────────────────────────────────────────
  // Body: "Organization: Dropbox Custom (customchris-dev-ed.my.salesforce.com)."
  // Subject fallback: "...exception from Dropbox Custom : ..."
  const orgBodyMatch = body.match(/^Organization:\s*(.+?)\s*\(/m);
  const orgSubjectMatch = subject.match(/exception from\s+(.+?)\s*:/i);
  const orgName = orgBodyMatch?.[1]?.trim() ?? orgSubjectMatch?.[1]?.trim() ?? "Unknown";

  // ── Entry trigger and operation ──────────────────────────────────────────────
  // Body line: "onCase: execution of BeforeInsert"
  const TRIGGER_OPS =
    "BeforeInsert|BeforeUpdate|BeforeDelete|AfterInsert|AfterUpdate|AfterDelete|BeforeUndelete|AfterUndelete";
  const triggerMatch = body.match(new RegExp(`^(\\w+):\\s*execution of\\s+(${TRIGGER_OPS})`, "m"));
  const triggerName = triggerMatch?.[1] ?? null;
  const triggerOperation = triggerMatch?.[2] ?? null;

  // ── Root-cause exception: use the LAST "caused by:" block ───────────────────
  // Nested exceptions chain from outer → inner; the last block is the deepest root cause.
  const causedByRe = /caused by:\s*([\w.]+):\s*([^\n]+)/gi;
  let lastCausedBy: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = causedByRe.exec(body)) !== null) {
    lastCausedBy = m;
  }
  const exceptionType = lastCausedBy?.[1]?.trim() ?? "Unknown";
  const message = lastCausedBy?.[2]?.trim() ?? body.slice(0, 200);

  // ── Stack trace: all Class./Trigger. frame lines ─────────────────────────────
  const frameRe = /(?:Class|Trigger)\.\S+: line \d+, column \d+[^\n]*/g;
  const frames = body.match(frameRe) ?? [];
  const stackTrace = frames.join("\n") || body;

  // ── Root-cause apex class: first frame in the stack ──────────────────────────
  // Stack is ordered deepest-first: the first frame is where the exception originated.
  // "Class.MVN_ProgramEventHdlr.handleProblems: line 75" → "MVN_ProgramEventHdlr"
  // "Trigger.onCase: line 3"                             → "onCase"
  const firstFrame = frames[0] ?? "";
  const frameClassMatch = firstFrame.match(/^(?:Class|Trigger)\.(\w+)/);
  const apexClass = frameClassMatch?.[1] ?? triggerName;

  // ── Line number: from the first stack frame ───────────────────────────────────
  const lineMatch = firstFrame.match(/line (\d+)/);
  const lineNumber = lineMatch ? parseInt(lineMatch[1]) : null;

  const fingerprint = createFingerprint(exceptionType, apexClass, lineNumber);

  return {
    subject,
    orgName,
    triggerName,
    triggerOperation,
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
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
