#!/usr/bin/env python3
"""Everything that touches the ElevenLabs agent, from one place.

    marie.py status            what the live agent is running
    marie.py tools             ensure the five webhook tools exist, print ids
    marie.py tests             ensure the three scenarios exist, print ids
    marie.py run [--llm X] [--temp T]
                               run the scenarios against the INTENDED config,
                               without writing anything to the agent
    marie.py export INV...     write full transcripts of past runs to
                               scripts/elevenlabs/transcripts/
    marie.py apply             write the intended config onto the agent
                               (asks first; keeps a backup)

The intended configuration is read from ../elevenlabs-agent.md — the prompt
between the fences under "## Prompt système" — so the document stays the only
place the prompt is written. The key comes from api/.dev.vars and never
appears on the command line.
"""
import argparse, json, pathlib, re, sys, time, urllib.request, urllib.error

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
AGENT = 'agent_3201m2jt9ec5ejkv1c4ycg2nqsdc'
API = 'https://api.elevenlabs.io/v1/convai'
BASE = 'https://diag-api.soscumulus.fr'
TRANSFER_TO = '+33684780721'

def dev_var(name):
    m = re.search(rf'^{name}=(\S+)', (ROOT / 'api/.dev.vars').read_text(), re.M)
    if not m or not m.group(1).strip('"'): sys.exit(f'{name} manquant dans api/.dev.vars')
    return m.group(1).strip('"')

KEY = dev_var('ELEVENLABS_API_KEY')

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{API}{path}', data=data, method=method,
        headers={'xi-api-key': KEY, 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw.decode(errors='replace')}

def prompt_text():
    doc = (HERE.parent / 'elevenlabs-agent.md').read_text()
    return re.search(r'## Prompt système\n\n```\n(.*?)\n```', doc, re.S).group(1)

# ── the five tools ─────────────────────────────────────────────────────
def tool(name, desc, method, url, body=None, assignments=None, secret_id=None):
    header = {'secret_id': secret_id} if secret_id else 'UNSET'
    t = {'type': 'webhook', 'name': name, 'description': desc,
         'api_schema': {'url': url, 'method': method,
                        'request_headers': {'x-voice-secret': header},
                        'response_timeout_secs': 20}}
    if '{case_token}' in url:
        t['api_schema']['path_params_schema'] = {'case_token': {'type': 'string', 'dynamic_variable': 'case_token'}}
    if body:
        t['api_schema']['request_body_schema'] = {'type': 'object', 'properties': body, 'required': list(body)}
    elif method == 'POST':
        t['api_schema']['request_body_schema'] = {'type': 'object', 'properties': {}, 'required': []}
    if assignments:
        t['assignments'] = [{'source': 'response', 'dynamic_variable': dv, 'value_path': vp} for dv, vp in assignments]
    return t

def tool_defs(secret_id=None):
    return [
        tool('open_case',
             "Crée le dossier de diagnostic. À appeler une seule fois, et seulement après avoir répété le numéro de téléphone au client un chiffre à la fois et obtenu sa confirmation — jamais avant. N'envoie rien au client : le SMS dépend de la réponse à la question de sécurité, posée juste après.",
             'POST', f'{BASE}/api/voice/case',
             {'firstName': {'type': 'string', 'description': 'Prénom'},
              'lastName': {'type': 'string', 'description': 'Nom'},
              'phone': {'type': 'string', 'description': 'Numéro au format +33…'},
              'reportedIssue': {'type': 'string', 'description': 'Le problème avec les mots du client, sans traduction technique'}},
             [('case_token', 'token'), ('case_ref', 'ref')], secret_id),
        tool('triage',
             "Enregistre la réponse à la question de sécurité. Renvoie transfer : vrai s'il faut passer l'appel à un technicien. N'envoie aucun SMS. leak vaut vrai si le client voit de l'eau couler, powerCut vaut vrai si son disjoncteur a sauté.",
             'POST', f'{BASE}/api/voice/case/{{case_token}}/triage',
             {'leak': {'type': 'boolean', 'description': "De l'eau coule"},
              'powerCut': {'type': 'boolean', 'description': 'Le disjoncteur a sauté'}},
             [('handover', 'handover')], secret_id),
        tool('send_link',
             "Envoie au client le SMS avec son lien de diagnostic. À appeler une seule fois, juste après que le client a dit s'il reste en ligne pendant les photos (stayOnLine vrai) ou s'il raccroche (stayOnLine faux) — jamais avant sa réponse. Si transfer est vrai, le SMS n'a pas pu partir : transférer.",
             'POST', f'{BASE}/api/voice/case/{{case_token}}/link',
             {'stayOnLine': {'type': 'boolean', 'description': 'Vrai si le client reste en ligne pendant les photos, faux s’il raccroche'}},
             [('handover', 'handover')], secret_id),
        tool('check_photos',
             "Indique quelles photos sont arrivées et ce qui a été lu sur l'étiquette. À appeler pendant que le client prend ses photos, toutes les vingt à trente secondes, jamais plus souvent.",
             'GET', f'{BASE}/api/voice/case/{{case_token}}/progress', secret_id=secret_id),
        tool('get_quote',
             "Produit le devis une fois les photos reçues. Si ready vaut faux, le calcul est en cours : patienter une trentaine de secondes et rappeler l'outil.",
             'POST', f'{BASE}/api/case/{{case_token}}/quote', secret_id=secret_id),
        tool('accept_quote', "Enregistre l'acceptation du devis par le client.",
             'POST', f'{BASE}/api/case/{{case_token}}/quote/accept', secret_id=secret_id),
    ]

def ensure_tools(secret_id=None):
    """Creates missing tools, updates existing ones by name, returns name → id."""
    st, out = call('GET', '/tools')
    have = {t['tool_config']['name']: t['id'] for t in out.get('tools', []) if t.get('tool_config', {}).get('name')}
    ids = {}
    for d in tool_defs(secret_id):
        if d['name'] in have:
            st, out = call('PATCH', f"/tools/{have[d['name']]}", {'tool_config': d})
            ids[d['name']] = have[d['name']]
            print(f"  {st} {d['name']} mis à jour → {ids[d['name']]}")
        else:
            st, out = call('POST', '/tools', {'tool_config': d})
            if st != 200: sys.exit(f"création {d['name']} : {st} {json.dumps(out, ensure_ascii=False)[:400]}")
            ids[d['name']] = out['id']
            print(f"  {st} {d['name']} créé → {ids[d['name']]}")
    return ids

# ── the intended agent configuration ─────────────────────────────────
# The initiation webhook only runs for inbound Twilio calls: a widget — ours or
# the test button in the ElevenLabs dashboard — never calls it, and an empty
# greeting stops the conversation before it starts. This default is what
# those conversations open with; phone calls get the webhook's random pick.
DEFAULT_GREETING = 'SOS Cumulus bonjour ! Marie à votre écoute, comment puis-je vous aider ?'
DYN = {'greeting': DEFAULT_GREETING, 'case_token': '', 'case_ref': '', 'handover': ''}

def intended(llm, temp, tool_ids):
    return {
        'agent': {
            'first_message': '{{greeting}}',
            'language': 'fr',
            'dynamic_variables': {'dynamic_variable_placeholders': DYN},
            'prompt': {
                'prompt': prompt_text(), 'llm': llm, 'temperature': temp,
                'tool_ids': list(tool_ids.values()), 'tools': [],
                'ignore_default_personality': True,
                'built_in_tools': {'transfer_to_number': {
                    'name': 'transfer_to_number', 'description': '',
                    'params': {'system_tool_type': 'transfer_to_number', 'transfers': [{
                        'phone_number': TRANSFER_TO, 'transfer_type': 'conference',
                        'condition': "Fuite d'eau ou disjoncteur (transfer = true) ; le client demande quelqu'un ; le SMS n'est pas parti ; le devis est accepté.",
                        'client_message': 'Je vous passe un technicien tout de suite, ne raccrochez pas.',
                        'agent_message': '{{handover}}'}]}}}}},
        'turn': {'turn_eagerness': 'patient', 'turn_timeout': 10,
                 # Off: the filler glued itself to the front of the next reply
                 # ("Un instant, je note. C'est noté…"), on every tool call.
                 'soft_timeout_config': {'timeout_seconds': -1, 'message': '…', 'use_llm_generated_message': False}},
    }

# The site's own colours, read off its favicon.
WIDGET = {'bg_color': '#ffffff', 'text_color': '#1b2430', 'btn_color': '#FF5B29', 'btn_text_color': '#ffffff',
          'border_color': '#e3e9f2', 'focus_color': '#1B3A5C',
          'avatar': {'type': 'orb', 'color_1': '#1B3A5C', 'color_2': '#FF5B29'},
          'start_call_text': 'Parler à Marie', 'end_call_text': 'Raccrocher', 'action_text': 'Besoin d’aide ?'}

def deep_merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out

def agent():
    st, a = call('GET', f'/agents/{AGENT}')
    if st != 200: sys.exit(f'lecture agent : {st} {a}')
    return a

# ── commands ───────────────────────────────────────────────────────────
def cmd_status(_):
    a = agent(); p = a['conversation_config']['agent']['prompt']; ps = a.get('platform_settings', {})
    print('nom          :', a.get('name'))
    print('llm          :', p.get('llm'), '| température', p.get('temperature'))
    print('prompt       :', len(p.get('prompt', '').split()), 'mots')
    print('first_message:', repr(a['conversation_config']['agent'].get('first_message')))
    print('tool_ids     :', p.get('tool_ids') or 'AUCUN')
    print('transfert    :', json.dumps((p.get('built_in_tools') or {}).get('transfer_to_number'), ensure_ascii=False)[:160])
    print('turn         :', {k: a['conversation_config']['turn'].get(k) for k in ['turn_eagerness', 'turn_timeout']})
    print('webhook      :', (ps.get('workspace_overrides') or {}).get('conversation_initiation_client_data_webhook') or 'aucun')
    print('widget       :', {k: (ps.get('widget') or {}).get(k) for k in ['btn_color', 'focus_color', 'start_call_text']})

SECRET_NAME = 'sos-voice-secret'

def voice_secret_id():
    """The workspace secret holding VOICE_SECRET, created once and reused.

    Every tool header points at it. Creating one per `apply` left six copies
    behind; running `tools` without it rewrote every header to a placeholder
    and would have cut the live agent off from the API.
    """
    st, out = call('GET', '/secrets')
    mine = [x for x in out.get('secrets', []) if x.get('name') == SECRET_NAME]
    # The one the tools already point at, if any: the others are leftovers.
    in_use = [x for x in mine if (x.get('used_by') or {}).get('tools')]
    if in_use or mine:
        return (in_use or mine)[0]['secret_id']
    st, out = call('POST', '/secrets', {'type': 'new', 'name': SECRET_NAME, 'value': dev_var('VOICE_SECRET')})
    if st != 200: sys.exit(f'secret : {st} {out}')
    return out['secret_id']

def cmd_tools(_):
    ids = ensure_tools(voice_secret_id()); (HERE / 'tool-ids.json').write_text(json.dumps(ids, indent=1))

# ── scenarios ──────────────────────────────────────────────────────────
ANY = {'type': 'anything'}
PARAMS = {'open_case': ['firstName', 'lastName', 'phone', 'reportedIssue'], 'triage': ['leak', 'powerCut'], 'send_link': ['stayOnLine'],
          'check_photos': [], 'get_quote': [], 'accept_quote': []}
def mock(obj, tool_name, conds=None):
    return {'mock_result': json.dumps(obj, ensure_ascii=False), 'is_error': False,
            'parameter_conditions': conds or [{'path': p, 'eval': ANY} for p in PARAMS[tool_name]]}

SAY = {
  'open': "C'est noté, je m'occupe de vous. Votre dossier, c'est le S C - 0 0 9 9.",
  'transfer': 'Dans ce cas je ne vous fais pas attendre : je vous passe tout de suite un technicien, il prend le relais.',
  'triage_ok': 'Très bien, ce n’est pas une urgence immédiate, on va pouvoir faire ça posément. Je vais vous envoyer un SMS avec un lien pour prendre trois photos de votre chauffe-eau : ça ne vous prendra que deux ou trois minutes. Avec ces photos, on comprend exactement votre panne, et on vous envoie ensuite votre devis par SMS, à signer si vous acceptez l’intervention. Préférez-vous rester en ligne pendant que vous les prenez, ou raccrocher et les prendre tranquillement ?',
  'link_stay': 'C’est parti, je viens de vous envoyer le SMS. Ouvrez le lien quand vous l’avez, je reste en ligne avec vous.',
  'link_bye': 'C’est parti, je viens de vous envoyer le SMS. Prenez les photos quand vous voulez : dès qu’on les a, vous recevez votre devis par SMS, à signer si vous acceptez l’intervention. Bonne journée, au revoir !',
  'photos': "J'ai bien reçu vos trois photos, et je lis 150 VMI, 150 litres. C'est tout bon, on a ce qu'il faut pour comprendre la panne.",
  'quote': "Votre devis est de 317 euros tout compris. Je viens de vous l'envoyer par SMS. Ouvrez le lien, signez le devis en ligne, et un technicien vous rappelle pour le rendez-vous.",
}
MOCKS = {
  'open_case': [mock({'sayExactly': SAY['open'], 'token': 'TESTTOKEN', 'ref': 'SC-0099'}, 'open_case')],
  'triage': [
    mock({'sayExactly': SAY['transfer'], 'transfer': True, 'smsSent': False,
          'handover': 'Jean Dupont, + 3 3 6 1 2 3 4 5 6 7 8, dossier S C - 0 0 9 9. Fuite d’eau déclarée. '}, 'triage',
         [{'path': 'leak', 'eval': {'type': 'exact', 'expected_value': 'true'}}, {'path': 'powerCut', 'eval': ANY}]),
    mock({'sayExactly': SAY['triage_ok'], 'transfer': False, 'handover': ''}, 'triage'),
  ],
  'send_link': [
    mock({'sayExactly': SAY['link_stay'], 'smsSent': True, 'smsBlocked': False, 'stayOnLine': True, 'transfer': False}, 'send_link',
         [{'path': 'stayOnLine', 'eval': {'type': 'exact', 'expected_value': 'true'}}]),
    mock({'sayExactly': SAY['link_bye'], 'smsSent': True, 'smsBlocked': False, 'stayOnLine': False, 'transfer': False}, 'send_link'),
  ],
  'check_photos': [mock({'sayExactly': SAY['photos'], 'complete': True, 'received': 3, 'settled': 3, 'read': ['150 VMI', '150 litres']}, 'check_photos')],
  'get_quote': [mock({'sayExactly': SAY['quote'], 'ready': True, 'sent': True, 'quote': {'needsHumanPricing': False, 'total': 317, 'demo': True}}, 'get_quote')],
  'accept_quote': [mock({'ok': True, 'ref': 'SC-0099'}, 'accept_quote')],
}
RULES = [
  "L'agent n'a jamais dit « je comprends », « je vois que », « pas de souci », « n'hésitez pas » ni « c'est quoi ».",
  "Chaque réponse de l'agent tient en une ou deux phrases, jamais trois — sans compter le texte d'un sayExactly recopié, qui peut être plus long et être suivi d'une phrase ou d'une question.",
  "L'agent a demandé le nom, puis le numéro de téléphone, puis a répété le numéro un chiffre à la fois (jamais par paires comme « douze » ou « quatre-vingt-dix-neuf ») pour le faire confirmer, avant d'appeler open_case.",
  "L'agent n'a jamais annoncé un prix, un montant, un délai d'intervention ni un modèle d'appareil qui ne venait pas d'une réponse d'outil.",
  "Après chaque appel d'outil, la réponse de l'agent a commencé par le texte du champ sayExactly, copié tel quel, sans le reformuler ni l'abréger.",
  "Si send_link a été appelé, il l'a été seulement après que le client a dit s'il restait en ligne ou raccrochait, jamais avant.",
]
SCENARIOS = [
  {'name': 'A — plus d’eau chaude, stressé', 'simulation_max_turns': 16,
   'simulation_scenario': "Vous êtes Jean Dupont, un particulier lyonnais stressé : plus d'eau chaude depuis ce matin, vous avez des enfants à doucher ce soir. Vous répondez aux questions de l'agent, vous donnez votre nom et le 06 12 34 56 78 quand on vous les demande, vous confirmez le numéro. Il n'y a pas d'eau par terre et le disjoncteur n'a pas sauté. Vous restez en ligne, vous dites que vous avez pris les trois photos, vous attendez le devis. Vous parlez comme au téléphone, phrases courtes, un peu inquiet.",
   'success_conditions': RULES + ["L'agent a rassuré le client en disant ce qu'on allait faire (s'occuper de lui, comprendre la panne, apporter une solution), sans jamais commenter ce qu'il ressent."]},
  {'name': 'B — fuite, affolé', 'simulation_max_turns': 10,
   'simulation_scenario': "Vous êtes Sophie Martin, affolée : il y a de l'eau qui coule sous le chauffe-eau et une flaque qui grandit. Vous le dites dès votre première phrase. Vous donnez votre nom et le 07 81 22 33 44 quand on vous les demande. Vous voulez que quelqu'un vienne vite.",
   'success_conditions': RULES + ["Après le triage, l'agent a transféré vers un technicien sans demander de photo ni parler de devis ni de SMS.",
                                  "L'agent n'a pas reposé la question de la fuite comme si le client ne l'avait pas dite : il a fait confirmer."]},
  {'name': 'C — demande le prix d’entrée', 'simulation_max_turns': 12,
   'simulation_scenario': "Vous êtes Karim Benali. Votre ballon fait un bruit bizarre et l'eau est tiède. Dès le début vous demandez combien ça va coûter, et vous insistez une fois. Ensuite vous coopérez : nom, numéro 06 99 87 24 14, pas de fuite, pas de disjoncteur. Vous préférez raccrocher et recevoir le devis par SMS.",
   'success_conditions': RULES + ["Quand le client a demandé le prix avant les photos, l'agent a répondu que ça dépendait de ce que les photos montreraient, sans donner de chiffre ni d'ordre de grandeur.",
                                  "L'agent a laissé le client choisir entre rester en ligne et raccrocher, sans orienter — ou, si le client a exprimé sa préférence de lui-même avant que l'agent propose, l'agent l'a respectée sans discuter."]},
]

def cmd_tests(_):
    # Overrides are keyed by the tool's id, never its name — keyed by name, no
    # mock ever matched and every tool errored out, run after run.
    tool_ids = json.loads((HERE / 'tool-ids.json').read_text())
    overrides = {tool_ids[name]: mocks for name, mocks in MOCKS.items()}
    st, out = call('GET', '/agent-testing')
    have = {t.get('name'): t.get('id') for t in (out.get('tests', []) if st == 200 else [])}
    ids = {}
    for sc in SCENARIOS:
        body = {**sc, 'type': 'simulation', 'agent_id': AGENT,
                'tool_mock_config': {'mocking_strategy': 'all', 'fallback_strategy': 'raise_error',
                                     'mocked_tool_ids': list(tool_ids.values())},
                'tool_mock_overrides': overrides,
                'dynamic_variables': {'greeting': 'SOS Cumulus bonjour ! Marie à votre écoute, comment puis-je vous aider ?'}}
        if sc['name'] in have:
            st, out = call('PUT', f"/agent-testing/{have[sc['name']]}", body)
            ids[sc['name']] = have[sc['name']]; print(f"  {st} {sc['name']} mis à jour")
        else:
            st, out = call('POST', '/agent-testing/create', body)
            if st != 200: sys.exit(f"test {sc['name']} : {st} {json.dumps(out, ensure_ascii=False)[:400]}")
            ids[sc['name']] = out['id']; print(f"  {st} {sc['name']} créé")
    (HERE / 'test-ids.json').write_text(json.dumps(ids, ensure_ascii=False, indent=1))

def cmd_run(a):
    tool_ids = json.loads((HERE / 'tool-ids.json').read_text())
    test_ids = json.loads((HERE / 'test-ids.json').read_text())
    live = agent()
    cfg = intended(a.llm, a.temp, tool_ids)
    # The simulator has no latency to cover: the filler only glues itself to
    # the front of the reply and trips every text criterion.
    cfg['turn']['soft_timeout_config'] = {'timeout_seconds': -1, 'message': '…', 'use_llm_generated_message': False}
    over = {'platform_settings': live.get('platform_settings', {}),
            'conversation_config': deep_merge(live['conversation_config'], cfg)}
    chosen = {n: i for n, i in test_ids.items() if not a.only or n.startswith(a.only)}
    body = {'tests': [{'test_id': i} for i in chosen.values()], 'agent_config_override': over}
    if a.repeat > 1: body['repeat_count'] = a.repeat
    st, out = call('POST', f'/agents/{AGENT}/run-tests', body)
    if st != 200: sys.exit(f'run-tests {st} {json.dumps(out, ensure_ascii=False)[:1200]}')
    inv = out.get('id') or out.get('test_invocation_id'); print('invocation', inv)
    for _ in range(80):
        st, res = call('GET', f'/test-invocations/{inv}')
        runs = res.get('test_runs', [])
        if runs and all(r.get('status') in ('passed', 'failed', 'error', 'completed') for r in runs): break
        time.sleep(5)
    write_transcript(inv, f'{a.llm} · {a.temp}', res)
    from collections import Counter
    tally = {}
    for r in runs: tally.setdefault(r.get('test_name'), Counter())[r.get('status')] += 1
    for name, c in tally.items(): print(f"  {name} — {c.get('passed', 0)}/{sum(c.values())} passées")

def write_transcript(inv, label, res):
    out = HERE / 'transcripts'; out.mkdir(exist_ok=True)
    L = [f'# {label}', '', f'Invocation `{inv}`', '']
    for r in res.get('test_runs', []):
        L += [f"## {r.get('test_name')} — **{r.get('status')}**", '']
        cr = r.get('condition_result') or {}
        if cr:
            L += [f"Verdict : {cr.get('result')}", '']
            rat = cr.get('rationale') or {}
            msgs = rat.get('messages') if isinstance(rat, dict) else None
            if msgs: L += ['Évaluateur :'] + [f'- {m}' for m in msgs] + ['']
        for t in (r.get('agent_responses') or []):
            who = 'MARIE' if t.get('role') == 'agent' else 'CLIENT'; msg = (t.get('message') or '').strip()
            if msg: L.append(f'**{who}** › {msg}  ')
            for c in (t.get('tool_calls') or []):
                L.append(f"  - ⚙️ appel `{c.get('tool_name')}` `{c.get('params_as_json') or ''}`  ")
            for x in (t.get('tool_results') or []):
                v = x.get('result_value') or x.get('result') or ''
                L.append(f"  - ↩️ réponse `{x.get('tool_name')}`{' **ERREUR**' if x.get('is_error') else ''} : `{str(v)[:400]}`  ")
        L.append('')
    p = out / f'{inv}.md'; p.write_text('\n'.join(L)); print('transcript →', p.relative_to(ROOT))

def cmd_export(a):
    for inv in a.invocations:
        st, res = call('GET', f'/test-invocations/{inv}')
        if st == 200: write_transcript(inv, inv, res)
        else: print(inv, st, res)

def cmd_apply(a):
    live = agent()
    backup = HERE / f'backup-{time.strftime("%Y%m%d-%H%M%S")}.json'
    backup.write_text(json.dumps(live, ensure_ascii=False, indent=1)); print('sauvegarde →', backup.relative_to(ROOT))
    if not a.yes and input('Écrire la configuration sur l’agent ? (oui/non) ').strip().lower() != 'oui': sys.exit('abandon')
    # The shared secret goes to ElevenLabs as a workspace secret, never in clear.
    secret_id = voice_secret_id(); print('secret →', secret_id)
    tool_ids = ensure_tools(secret_id); (HERE / 'tool-ids.json').write_text(json.dumps(tool_ids, indent=1))
    body = {'conversation_config': deep_merge(live['conversation_config'], intended(a.llm, a.temp, tool_ids)),
            'platform_settings': deep_merge(live.get('platform_settings', {}), {
                'widget': WIDGET,
                # Declaring the webhook URL is not enough: without this flag the
                # agent never calls it, even on a Twilio call.
                'overrides': {'enable_conversation_initiation_client_data_from_webhook': True},
                'workspace_overrides': {'conversation_initiation_client_data_webhook': {'url': f'{BASE}/api/voice/greeting', 'request_headers': {}}}})}
    st, out = call('PATCH', f'/agents/{AGENT}', body)
    if st != 200: sys.exit(f'PATCH agent : {st} {json.dumps(out, ensure_ascii=False)[:1500]}')
    print('agent mis à jour ✓'); cmd_status(None)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    for n in ['status', 'tools', 'tests']: sub.add_parser(n)
    for n in ['run', 'apply']:
        s = sub.add_parser(n); s.add_argument('--llm', default='claude-sonnet-4-6'); s.add_argument('--temp', type=float, default=0.45); s.add_argument('--repeat', type=int, default=1); s.add_argument('--yes', action='store_true'); s.add_argument('--only', default='')
    sub.add_parser('export').add_argument('invocations', nargs='+')
    a = ap.parse_args(); globals()[f'cmd_{a.cmd}'](a)
