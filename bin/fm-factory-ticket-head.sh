#!/usr/bin/env bash
# Read the exact source and destination of a Factory ticket pull request.
# Usage: fm-factory-ticket-head.sh <canonical-pr-url>
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_HOME="${FM_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"

if [ "$#" -ne 1 ] || ! fm_pr_url_parse "$1"; then
  echo 'error: expected a canonical pull request URL' >&2
  exit 2
fi
case "$FM_PR_PROVIDER" in
  github)
    # gh-axi emits TOON even for a JSON-shaped --jq result. A base64 string
    # carries the selected JSON losslessly in its raw-response envelope.
    record=$(GH_HOST="$FM_PR_HOST" gh-axi api "/repos/$FM_PR_PATH/pulls/$FM_PR_NUMBER" --full --jq '
      {url: .html_url, head: .head.sha, base: .base.sha, sourceBranch: .head.ref, sourceRepository: .head.repo.html_url} | @base64')
    encoded=$(awk '
      NR == 1 && $0 == "api_response:" { header = 1 }
      NR == 2 && /^  body: [A-Za-z0-9+\/=]+$/ { body = $2 }
      NR == 3 && $0 == "  truncated: false" { complete = 1 }
      END { if (NR == 3 && header && body && complete) print body; else exit 1 }
    ' <<<"$record")
    jq -Rce '@base64d | fromjson' <<<"$encoded"
    ;;
  gitlab)
    record=$(GITLAB_HOST="$FM_PR_HOST" glab mr view "$FM_PR_NUMBER" -R "https://$FM_PR_HOST/$FM_PR_PATH" -F json)
    # The same source/target project ID proves that the named branch is not a fork.
    jq -ce --arg repository "https://$FM_PR_HOST/$FM_PR_PATH" '
      select((.source_project_id | type) == "number" and .source_project_id == .target_project_id and .diff_refs.head_sha == .sha)
      | {url: .web_url, head: .sha, base: .diff_refs.base_sha, sourceBranch: .source_branch, sourceRepository: $repository}' <<<"$record"
    ;;
  forgejo)
    login=$(fm_pr_forgejo_login "$FM_PR_HOST")
    record=$(tea api --login "$login" --repo "$FM_PR_PATH" "/repos/{owner}/{repo}/pulls/$FM_PR_NUMBER")
    jq -ce '{url: .html_url, head: .head.sha, base: .base.sha, sourceBranch: .head.ref, sourceRepository: .head.repo.html_url}' <<<"$record"
    ;;
  *)
    echo 'error: unsupported Factory ticket pull request forge' >&2
    exit 2
    ;;
esac
