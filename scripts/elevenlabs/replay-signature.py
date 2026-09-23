#!/usr/bin/env python3
"""Replays a signature on our own webhook, exactly as Youtrust would send it.

Resets the quote to 'sent' (the webhook ignores a quote already signed), then
posts a `signature_request.done` event signed with YOUTRUST_WEBHOOK_SECRET.
Sends a real intervention email and files a second copy of the signed PDF in
Drive — run it only when that is the point.

    replay-signature.py SC-0050
"""
import hashlib, hmac, json, pathlib, re, subprocess, sys, time, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[2]
ref = sys.argv[1]
dv = (ROOT / 'api/.dev.vars').read_text()
secret = re.search(r'^YOUTRUST_WEBHOOK_SECRET=(\S+)', dv, re.M).group(1).strip('"')

def d1(sql):
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'soscumulus-diag', '--remote', '--json', '--command', sql],
                       cwd=ROOT / 'api', capture_output=True, text=True)
    return json.loads(r.stdout)[0]['results']

row = d1(f"SELECT q.case_token, q.youtrust_request_id FROM quotes q JOIN cases c ON c.token = q.case_token WHERE c.ref = '{ref}'")
if not row: sys.exit(f'aucun devis pour {ref}')
token, request_id = row[0]['case_token'], row[0]['youtrust_request_id']
# Only events after this point count: the first signature already logged one.
since = d1(f"SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE case_token = '{token}'")[0]['m']
d1(f"UPDATE quotes SET status = 'sent' WHERE case_token = '{token}'")

body = json.dumps({'event_id': f'replay-{int(time.time())}', 'event_name': 'signature_request.done',
                   'event_time': str(int(time.time())), 'sandbox': True,
                   'data': {'signature_request': {'id': request_id, 'status': 'done', 'external_id': token}}}).encode()
sig = 'sha256=' + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
req = urllib.request.Request('https://diag-api.soscumulus.fr/api/youtrust/webhook', data=body, method='POST',
    headers={'content-type': 'application/json', 'x-yousign-signature-256': sig, 'User-Agent': 'soscumulus-replay/1.0'})
with urllib.request.urlopen(req) as r: print('webhook :', r.status, r.read().decode())

for _ in range(20):
    time.sleep(3)
    ev = d1(f"SELECT kind, detail FROM events WHERE case_token = '{token}' AND kind LIKE 'intervention%' AND id > {since} ORDER BY id DESC LIMIT 1")
    if ev and ev[0]['kind'] in ('intervention_requested', 'intervention_request_failed'):
        print('résultat :', ev[0]['kind'], '—', ev[0]['detail']); break
