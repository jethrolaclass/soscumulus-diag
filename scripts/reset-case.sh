#!/usr/bin/env bash
#
# Reset a diagnosis case so the journey can be walked again from the start.
#
#   ./scripts/reset-case.sh <token> [--local]
#
# Setting `status` alone is not enough: the front end resumes from the actual
# state — recorded answers, uploaded photos, captured panel — not from the
# status column. All three have to be cleared or the client lands mid-journey.
#
# R2 objects are left in place. They carry no meaning once the rows no longer
# reference them, and the daily purge removes them with the case at seven days.
set -euo pipefail

TOKEN="${1:-}"
REMOTE="${2:---remote}"

if [ -z "$TOKEN" ]; then
  echo "usage: $0 <token> [--local]" >&2
  exit 1
fi

cd "$(dirname "$0")/../api"

npx wrangler d1 execute soscumulus-diag "$REMOTE" -y --command "
  UPDATE cases
     SET status = 'open',
         answers = '{}',
         diagnosis = NULL,
         panel_frames = 0,
         panel_analysis = NULL,
         panel_status = 'idle',
         panel_video_key = NULL,
         updated_at = datetime('now')
   WHERE token = '$TOKEN';

  UPDATE photos
     SET r2_key = NULL,
         skipped = 0,
         attempts = 0,
         analysis = NULL,
         analysis_status = 'idle',
         local_verdict = NULL,
         updated_at = datetime('now')
   WHERE case_token = '$TOKEN';
"

echo "Case $TOKEN reset."
