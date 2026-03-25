A GitHub issue has been created requesting a code fix. Your job is to understand the issue, implement the fix, write tests, and create a pull request.

## Issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

## Instructions

1. **Understand**: Read the issue carefully. Identify which files and Apex classes are involved.

2. **Investigate**: Search the codebase to find the relevant code. Understand the current behavior and what needs to change.

3. **Fix**: Implement the change described in the issue. Keep the change minimal and focused.

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
