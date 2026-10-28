"""Checks data against the JSON schemas in schemas/.

The schemas describe the shape of songs.yaml, bands.yaml and a guide file:
which fields there are, which are required, what kind each is. They are
published with the site (https://www.splitopen.org/schemas/) so
an editor can check a file as it is typed, and the check scripts apply the
same rules, keeping only what a schema cannot say (a band that exists, a
segment that is there) in code.

    import schema
    errors = schema.check('songs.schema.json', songs, where='songs.yaml')
    schema.STEMS  # the player's stems, from common.schema.json
"""
import json
import os

from jsonschema import Draft202012Validator  # 4.18 or later, for referencing
from referencing import Registry, Resource

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'schemas')


def _read(name):
    with open(os.path.join(DIR, name), encoding='utf-8') as f:
        return json.load(f)


# Every schema is registered by its $id, so a schema's `common.schema.json#…`
# references resolve from the directory, never over the network.
_schemas = {name: _read(name) for name in sorted(os.listdir(DIR)) if name.endswith('.schema.json')}
_registry = Registry().with_resources((s['$id'], Resource.from_contents(s)) for s in _schemas.values())

STEMS = _schemas['common.schema.json']['$defs']['stem']['enum']


def _narrow(e):
    """For "one of these shapes" (a player or a list of players), the
    sub-error that got furthest into the value says the most ("'foo' is not
    one of ...", not "not of type 'array'"); among equals, the one that is
    not about the type."""
    while e.validator == 'anyOf':
        e = sorted(e.context, key=lambda c: (-len(c.path), c.validator == 'type'))[0]
    return e


def _message(e):
    """What is wrong, in the file's terms where the schema gives examples."""
    if e.validator == 'pattern':
        if e.schema.get('pattern') == '\\S':
            return 'must not be empty'
        if 'examples' in e.schema:
            return f"{e.instance!r} should look like {' or '.join(e.schema['examples'])}"
    return e.message


def check(name, data, where, label=None):
    """Validates `data` against schemas/<name>. Returns one line per problem:
    "<where> <place>: <what is wrong>", where `place` is the path to the
    value ("channels.keys.who", "[3].date"), or what `label(path)` makes of
    the path given as a list."""
    validator = Draft202012Validator(_schemas[name], registry=_registry)
    found = []
    for e in validator.iter_errors(data):
        e = _narrow(e)
        path = list(e.absolute_path)
        found.append((list(map(str, path)), _message(e), path))
    return [f'{where}{label(path) if label else place(path)}: {msg}' for _, msg, path in sorted(found)]


def dotted(path):
    """A path in the data as channels.keys[0]; '' at the top."""
    return ''.join(f'[{p}]' if isinstance(p, int) else f'.{p}' for p in path).lstrip('.')


def place(path, prefix=''):
    """`prefix` (a song id, "tip 3") and the path under it, each with a
    leading space when present, to follow a file name."""
    return ''.join(f' {part}' for part in (prefix, dotted(path)) if part)
