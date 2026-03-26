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

1. **Understand the feedback**: Read the new feedback carefully in light of the conversation history above. Do not re-open issues that were already resolved.

2. **Check out the PR branch**:
   ```bash
   gh pr checkout {{PR_NUMBER}}
   ```

3. **Read the current code**: Look at the files changed in this PR to understand the current state.
   ```bash
   gh pr diff {{PR_NUMBER}}
   ```

4. **Address the feedback**: Make the requested changes. If the feedback is unclear, make your best judgment and explain your reasoning in the commit message.

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

Do NOT create a new PR — push to the existing branch.
