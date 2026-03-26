Your job is to analyse this Salesforce repository and org, then write a `CLAUDE.md` file at the repo root that captures all project conventions. This file will be loaded automatically in every future Claude session, so it must be complete and accurate.

## Target org alias: {{SF_TARGET_ORG}}

---

## Step 1 — Detect naming conventions from existing code

```bash
ls force-app/main/default/classes/*.cls 2>/dev/null | head -30
ls force-app/main/default/triggers/*.trigger 2>/dev/null | head -10
ls force-app/main/default/objects/ 2>/dev/null | head -30
```

From the file names, determine:
- **Suffix** (e.g. `MVN`, `KH`) or **prefix** (e.g. `MVN_`) applied to Apex classes and objects
- **Test class pattern**: is it `<Class>Test<Suffix>.cls` or `<Class><Suffix>Test.cls` or something else?
- **Custom object pattern**: `<Name>_<Suffix>__c` or `<Name>__c` (no suffix)?
- **Custom field pattern**: same logic

If there is no consistent suffix/prefix, note that explicitly.

## Step 2 — Query the org for metadata

```bash
# Namespace prefix (if managed package)
sf org display --target-org {{SF_TARGET_ORG}} --json | jq -r '.result.namespacePrefix // "none"'

# All custom objects in the org
sf data query \
  --query "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName LIKE '%__c' ORDER BY QualifiedApiName" \
  --target-org {{SF_TARGET_ORG}} --use-tooling-api

# All Apex classes in the org
sf data query \
  --query "SELECT Name FROM ApexClass ORDER BY Name" \
  --target-org {{SF_TARGET_ORG}} --use-tooling-api
```

## Step 3 — Read a few representative files

Pick 2–3 Apex class + test class pairs to confirm patterns. Read them briefly — just enough to understand style, not every line.

## Step 4 — Write CLAUDE.md

Write a `CLAUDE.md` at the repo root with the following structure. Fill in every section based on what you discovered. Be specific and concrete — no placeholders.

```markdown
# Salesforce Project Conventions

This file is read automatically by Claude before every session. Keep it up to date when conventions change.

## Naming Conventions

**Suffix/Prefix**: <suffix or prefix, e.g. "Suffix: MVN" — or "None">

**Apex Classes**: <pattern, e.g. "AccountHandlerMVN.cls — entity + action + suffix, PascalCase">
**Test Classes**: <pattern, e.g. "AccountHandlerTestMVN.cls — insert 'Test' before the suffix">
**Custom Objects**: <pattern, e.g. "Error_Log_MVN__c — snake_case + underscore suffix + __c">
**Custom Fields**: <pattern, e.g. "Class_Name_MVN__c — snake_case + underscore suffix + __c">
**Triggers**: <pattern, e.g. "ContactMVN.trigger">

## Metadata Lookup Rules

Before creating any new metadata, always check whether it already exists in the org — it may not be in the repo yet.

Search by **label** using the Tooling API (not just by API name), because the same concept may have a different API name than expected:
\`\`\`bash
sf data query \
  --query "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE (Label LIKE '%<keyword>%' OR QualifiedApiName LIKE '%<keyword>%') AND QualifiedApiName LIKE '%__c'" \
  --target-org <org-alias> --use-tooling-api
\`\`\`

If found, retrieve before modifying:
\`\`\`bash
sf project retrieve start --metadata "CustomObject:<ApiName>" --target-org <org-alias>
\`\`\`

## Org Info

**Namespace prefix**: <value or "none">
**Known custom objects** (from org query above): <list the most relevant ones, e.g. error/log/audit objects>
**Known utility/base classes**: <list handler base classes, trigger frameworks, etc.>

## Code Style

<Note any patterns observed: error handling style, DML patterns, test data factory usage, etc.>
```

## Step 5 — Commit

```bash
git add CLAUDE.md
git commit -m "chore: add CLAUDE.md with project conventions"
git push
```
