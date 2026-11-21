#!/usr/bin/env python3
"""Keep FetchX's Cloudflare zone rules in step with ops/cloudflare/zone-rules.json.

Run on porttrack as root, from a checkout of main (the token file is root-only):

    sudo python3 -I ops/cloudflare/zone_rules.py plan     # show what would change; changes nothing
    sudo python3 -I ops/cloudflare/zone_rules.py apply    # add or update the rules in the file
    sudo python3 -I ops/cloudflare/zone_rules.py remove   # take those rules out again (rollback)

Only rules whose `ref` appears in the file are touched. Every other rule in the same phase,
including ones made in the dashboard, is kept as it is and in its order; new rules go last,
so they win over earlier rules that set the same thing.

Token: /opt/crawling-platform/secrets/cloudflare/api-token (or FX_CLOUDFLARE_TOKEN_FILE).
It needs Zone > Zone > Read and Zone > Config Rules > Edit on the zone, on top of the
account permissions fx-cloudflare uses.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://api.cloudflare.com/client/v4'
TOKEN_FILE = os.environ.get('FX_CLOUDFLARE_TOKEN_FILE', '/opt/crawling-platform/secrets/cloudflare/api-token')
RULES_FILE = Path(__file__).resolve().with_name('zone-rules.json')
COMPARED = ('description', 'expression', 'action', 'action_parameters', 'enabled')
READ_ONLY = ('version', 'last_updated', 'categories')


class CloudflareError(Exception):
    def __init__(self, status, body):
        self.status = status
        try:
            errors = json.loads(body).get('errors') or []
            detail = '; '.join(f"{e.get('code')}: {e.get('message')}" for e in errors) or body[:300]
        except ValueError:
            detail = body[:300]
        super().__init__(f'HTTP {status}: {detail}')


def load_rules(path=RULES_FILE):
    config = json.loads(Path(path).read_text())
    if not isinstance(config.get('zone'), str) or not isinstance(config.get('phases'), dict):
        raise ValueError(f'{path}: needs "zone" and "phases"')
    for phase, rules in config['phases'].items():
        refs = [rule.get('ref') for rule in rules]
        if not all(isinstance(ref, str) and ref for ref in refs) or len(set(refs)) != len(refs):
            raise ValueError(f'{path}: every rule in {phase} needs its own "ref"')
        for rule in rules:
            missing = [key for key in ('expression', 'action') if not rule.get(key)]
            if missing:
                raise ValueError(f'{path}: rule {rule["ref"]} has no {", ".join(missing)}')
    return config


def clean(rule):
    """A rule as it can be sent back to Cloudflare: without the fields only Cloudflare sets."""
    return {key: value for key, value in rule.items() if key not in READ_ONLY}


def same_rule(current, target):
    defaults = {'enabled': True}
    return all(current.get(key, defaults.get(key)) == target.get(key, defaults.get(key)) for key in COMPARED)


def merge(existing, desired):
    """Rules for the phase with `desired` added or updated by ref; everything else unchanged and in order."""
    wanted = {rule['ref']: rule for rule in desired}
    rules, changes, seen = [], [], set()
    for rule in existing:
        ref = rule.get('ref')
        if ref in wanted and ref not in seen:
            seen.add(ref)
            if same_rule(rule, wanted[ref]):
                rules.append(clean(rule))
                changes.append(('unchanged', ref))
            else:
                rules.append({**clean(wanted[ref]), **({'id': rule['id']} if rule.get('id') else {})})
                changes.append(('update', ref))
        else:
            rules.append(clean(rule))
    for rule in desired:
        if rule['ref'] not in seen:
            rules.append(clean(rule))
            changes.append(('add', rule['ref']))
    return rules, changes


def remove(existing, refs):
    """Rules for the phase without the ones whose ref is in `refs`."""
    refs = set(refs)
    rules = [clean(rule) for rule in existing if rule.get('ref') not in refs]
    changes = [('remove', rule['ref']) for rule in existing if rule.get('ref') in refs]
    changes += [('absent', ref) for ref in sorted(refs - {rule.get('ref') for rule in existing})]
    return rules, changes


def cf(token, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method, headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'fetchx-zone-rules/1'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)['result']
    except urllib.error.HTTPError as error:
        raise CloudflareError(error.code, error.read().decode(errors='replace')) from None


def zone_id(token, name):
    zones = cf(token, 'GET', '/zones?' + urllib.parse.urlencode({'name': name}))
    if len(zones) != 1:
        raise SystemExit(f'zone_rules: the token sees no zone named {name}; it needs Zone > Zone > Read on it')
    return zones[0]['id']


def entrypoint(token, zone, phase):
    try:
        return cf(token, 'GET', f'/zones/{zone}/rulesets/phases/{phase}/entrypoint').get('rules') or []
    except CloudflareError as error:
        if error.status == 404:
            return []
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('command', choices=('plan', 'apply', 'remove'))
    parser.add_argument('--rules', default=str(RULES_FILE), help='rules file (default: zone-rules.json next to this script)')
    args = parser.parse_args(argv)
    config = load_rules(args.rules)
    token = Path(TOKEN_FILE).read_text().strip()
    try:
        zone = zone_id(token, config['zone'])
        for phase, desired in config['phases'].items():
            existing = entrypoint(token, zone, phase)
            if args.command == 'remove':
                rules, changes = remove(existing, [rule['ref'] for rule in desired])
            else:
                rules, changes = merge(existing, desired)
            others = len(existing) - sum(1 for action, _ in changes if action in ('update', 'unchanged', 'remove'))
            for action, ref in changes:
                print(f'{config["zone"]} {phase}: {action} {ref}')
            print(f'{config["zone"]} {phase}: {others} other rule(s) kept as they are')
            if args.command != 'plan' and any(action in ('add', 'update', 'remove') for action, _ in changes):
                result = cf(token, 'PUT', f'/zones/{zone}/rulesets/phases/{phase}/entrypoint', {'rules': rules})
                print(f'{config["zone"]} {phase}: saved, ruleset version {result.get("version")}')
    except CloudflareError as error:
        hint = f' (the token needs Zone > Zone > Read and Zone > Config Rules > Edit on {config["zone"]})' if error.status in (401, 403) else ''
        raise SystemExit(f'zone_rules: Cloudflare refused: {error}{hint}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
