#!/usr/bin/env bash
# Stamp a fresh build id into index.html + version.json, then push.
# Run this instead of pushing index.html by hand — otherwise phones keep the old copy.
set -euo pipefail

REPO="ParbtaniA/cardscan"
: "${GH_TOKEN:?Set GH_TOKEN first:  export GH_TOKEN=ghp_...}"

BUILD=$(date -u +%Y%m%d-%H%M%S)
echo "{\"build\":\"$BUILD\"}" > version.json

# Replace the BUILD constant inside index.html
python3 - "$BUILD" <<'PY'
import re, sys
build = sys.argv[1]
p = 'index.html'
c = open(p).read()
new = re.sub(r'const BUILD = "[^"]*";', f'const BUILD = "{build}";', c, count=1)
if new == c:
    raise SystemExit('BUILD constant not found in index.html')
open(p, 'w').write(new)
print('stamped', build)
PY

push() {
  local f="$1"
  local sha
  sha=$(curl -s "https://api.github.com/repos/$REPO/contents/$f" \
        -H "Authorization: token $GH_TOKEN" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha',''))" 2>/dev/null || true)
  local b payload
  b=$(base64 -w 0 "$f" 2>/dev/null || base64 -i "$f" | tr -d '\n')
  if [ -n "$sha" ]; then
    payload=$(python3 -c "import json,sys; print(json.dumps({'message':'Deploy $BUILD','content':sys.argv[1],'sha':sys.argv[2]}))" "$b" "$sha")
  else
    payload=$(python3 -c "import json,sys; print(json.dumps({'message':'Deploy $BUILD','content':sys.argv[1]}))" "$b")
  fi
  curl -s -X PUT "https://api.github.com/repos/$REPO/contents/$f" \
    -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ', d.get('content',{}).get('name','ERROR: '+str(d)[:120]))"
}

echo "Pushing build $BUILD"
push index.html
push version.json

echo
echo "Done. Phones pick this up within ~2 minutes of Pages redeploying."
echo "If the Worker changed too, also run:  npx wrangler deploy"
