A developer has left feedback on a pull request that was created by Claude. Your job is to address their feedback, update the code, and push the changes.

## PR #{{PR_NUMBER}}: {{PR_TITLE}}

---

## Context & History

The following is the full conversation history for this PR, including any linked issue, prior reviews, and discussion. Use it to understand what has already been tried and discussed — do not re-do work already done.

{{PR_CONTEXT}}

---

## ⚡ New Feedback to Address

**Reviewer:** {{COMMENT_AUTHOR}}

{{COMMENT_BODY}}

---

## Instructions

1. **Understand the feedback**: Read the new feedback carefully in light of the conversation history above. Do not re-open issues that were already resolved, and do not treat automated workflow status/update comments as reviewer feedback.

2. **Check out the PR branch**:
   ```bash
   gh pr checkout {{PR_NUMBER}}
   ```

3. **Read the current code**: Look at the files changed in this PR to understand the current state.
   ```bash
   gh pr diff {{PR_NUMBER}}
   ```

   If the feedback is from `ci-validation` or mentions a failed check, inspect the failed GitHub Actions job log first. The workflow sets `GH_TOKEN` to an Actions-token with log access, so commands like `gh run view <run-id> --log-failed --repo {{REPO_FULL_NAME}}` should work. Normal `git push` still uses the checkout credentials.

4. **Address the feedback**: Make the requested changes. If the feedback is unclear, make your best judgment and explain your reasoning in the commit message.

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

5. **Test**: Run the tests to make sure everything still passes:
   ```bash
   sf project deploy start --source-dir force-app --target-org {{SF_TARGET_ORG}} --wait 10
   sf apex run test --target-org {{SF_TARGET_ORG}} --code-coverage --result-format human --wait 10
   ```

6. **Push the update**:
   ```bash
   git add -A
   git commit -m "address review: {{COMMENT_AUTHOR}}'s feedback on PR #{{PR_NUMBER}}"
   git push
   ```

7. **Do not post PR comments directly**: Do not call `gh pr comment`, `gh issue comment`, or the GitHub comments API. The workflow runner will post the final update comment after your session ends.

8. **Summarize the update**: End your response with exactly one concise line in this format. Summarize only the validation you directly ran; the workflow will verify the PR validation check after your session finishes.
   ```text
   ITERATION_SUMMARY: <what changed and what validation you ran>
   ```

Do NOT create a new PR — push to the existing branch.
