A GitHub issue has been created requesting a code fix. Your job is to understand the issue, implement the fix, write tests, and create a pull request.

**Repository:** {{REPO_FULL_NAME}}

## Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

## Instructions

1. **Understand**: Read the issue carefully. Identify which files and Apex classes are involved.

2. **Investigate**: Search the codebase to find the relevant code. Understand the current behavior and what needs to change.

3. **Fix**: Implement the change described in the issue. Keep the change minimal and focused.

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

4. **Test**: Write or update Apex unit tests. Run them:
   ```bash
   sf project deploy start --source-dir force-app --target-org {{SF_TARGET_ORG}} --wait 10
   sf apex run test --target-org {{SF_TARGET_ORG}} --code-coverage --result-format human --wait 10
   ```
   Iterate until tests pass.

5. **Create PR**:
   ```bash
   git checkout -b fix/issue-{{ISSUE_NUMBER}}
   git add -A
   git commit -m "fix: {{ISSUE_TITLE}} (closes #{{ISSUE_NUMBER}})"
   git push -u origin HEAD
   gh pr create --title "fix: {{ISSUE_TITLE}}" --body "Closes #{{ISSUE_NUMBER}}\n\n## Summary\n<explain what was changed and why>\n\n## Test Coverage\n<explain>\n\nAutomated fix by Claude from GitHub issue."
   ```
