#!/bin/bash
# PreToolUse hook (Bash matcher): blocks release-cutting commands while any
# owner-walkthrough issue is open. The walkthrough is the owner's informed
# sign-off gate (see .claude/skills/walkthrough/SKILL.md); releases must not
# outrun it. Crude on purpose: it only inspects commands that look like they
# cut a release, and fails open if gh is unavailable.

input=$(cat)

if printf '%s' "$input" | grep -qE 'gh release create|git tag'; then
  open=$(gh issue list --label owner-walkthrough --state open \
    --json number,title --jq '.[] | "#\(.number) \(.title)"' 2>/dev/null)
  if [ -n "$open" ]; then
    {
      echo "BLOCKED: an owner-walkthrough issue is open. Tagging or releasing"
      echo "is not allowed until the owner completes the walkthrough and"
      echo "closes it themselves:"
      echo "$open"
      echo "Ask the owner to run /walkthrough. Do not close the issue for them."
    } >&2
    exit 2
  fi
fi

exit 0
