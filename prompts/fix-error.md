A Salesforce production error email has arrived. Your job is to diagnose the root cause, fix the code, write or update unit tests, verify the fix, and create a pull request.

## Raw Error Email

**Subject:** {{EMAIL_SUBJECT}}

**Body:**
```
{{RAW_BODY}}
```

---

## Pre-parsed Fields (auto-extracted — verify against the raw email above)

- **Org:** {{ORG_NAME}}
- **Exception type:** {{EXCEPTION_TYPE}}
- **Message:** {{ERROR_MESSAGE}}
- **Entry trigger:** {{TRIGGER_NAME}} ({{TRIGGER_OPERATION}})
- **Root cause class:** {{APEX_CLASS}} line {{LINE_NUMBER}}
- **Stack trace:**
```
{{STACK_TRACE}}
```

If any pre-parsed field looks wrong, trust the raw email over these values.

---

## Instructions

Work through these steps in order.

1. **Diagnose**: Read `{{APEX_CLASS}}.cls` (or the flow/trigger identified above) and its test file. Understand the root cause from the raw email.

2. **Fix**: Make the minimal code change to fix the root cause. Do not refactor unrelated code.

   Before creating any new Salesforce metadata (custom objects, custom fields, Apex classes):

   a. **Check naming conventions** — if `CLAUDE.md` exists at the repo root, it has the conventions already. Otherwise detect the suffix/prefix from existing class names (e.g. `AccountHandlerMVN.cls` → suffix `MVN`). Apply the same pattern to anything you create.

   b. **Search the org by label**, not just by API name — the object may exist under a different name than expected:
   ```bash
   sf data query \
     --query "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE (Label LIKE '%<keyword>%' OR QualifiedApiName LIKE '%<keyword>%') AND QualifiedApiName LIKE '%__c'" \
     --target-org {{SF_TARGET_ORG}} --use-tooling-api
   ```
   An "Error Log" object could be `Error_Log_MVN__c`, `ApexLog__c`, `Exception_Log__c` — use judgment.

   c. **If found in the org**, retrieve it before modifying — do not recreate from scratch:
   ```bash
   sf project retrieve start --metadata "CustomObject:<ApiName>" --target-org {{SF_TARGET_ORG}}
   ```

3. **Test**: Check if a test file for `{{APEX_CLASS}}` already exists. If yes, update it. If no, create one. Read at most one other test file for style reference if needed.

4. **Verify**: Deploy and run tests:
   ```bash
   sf project deploy start --source-dir force-app --target-org {{SF_TARGET_ORG}} --wait 10
   sf apex run test --target-org {{SF_TARGET_ORG}} --code-coverage --result-format human --wait 10
   ```
   If tests fail, fix and retry (max 3 attempts).

5. **Create PR**: Once tests pass, run these commands in sequence:
   ```bash
   git checkout -b fix/{{APEX_CLASS}}-{{EXCEPTION_TYPE}}
   git add -A
   git commit -m "fix: {{EXCEPTION_TYPE}} in {{APEX_CLASS}}"
   git push -u origin HEAD
   gh pr create --title "fix: {{EXCEPTION_TYPE}} in {{APEX_CLASS}}" --body "## Root Cause\n<explain>\n\n## Fix\n<explain>\n\n## Test Coverage\n<explain>\n\nAutomated fix by Claude from production exception email."
   ```

**Important**: Do not explore the codebase beyond what is needed for steps 1–3. Every file read costs a turn.
