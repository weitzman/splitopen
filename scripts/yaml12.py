"""Reads and writes YAML the way the player does.

The player parses YAML in the browser with js-yaml's core schema, which is
YAML 1.2: 0:30 and 1998-07-26 are strings, and only true/false are booleans.
PyYAML follows YAML 1.1, where 1:53.8 is the number 113.8, 1998-07-26 a
date, and yes a boolean, so the scripts would otherwise read the same file
differently from the player. This Loader and Dumper swap in the 1.2 rules
for the plain scalars that differ.

    import yaml12
    songs = yaml12.load(open('songs.yaml').read())
    open('songs.yaml', 'w').write(yaml12.dump(songs))
"""
import re

import yaml

CORE = [
    ('tag:yaml.org,2002:null', r'^(?:~|null|Null|NULL|)$', ['~', 'n', 'N', '']),
    ('tag:yaml.org,2002:bool', r'^(?:true|True|TRUE|false|False|FALSE)$', list('tTfF')),
    ('tag:yaml.org,2002:int', r'^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$', list('-+0123456789')),
    ('tag:yaml.org,2002:float',
     r'^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$',
     list('-+0123456789.')),
]


class Loader(yaml.SafeLoader):
    pass


class Dumper(yaml.SafeDumper):
    def increase_indent(self, flow=False, indentless=False):
        # Indent list items under their key, as js-yaml does.
        return super().increase_indent(flow, False)


for cls in (Loader, Dumper):
    cls.yaml_implicit_resolvers = {}
    for tag, rx, first in CORE:
        cls.add_implicit_resolver(tag, re.compile(rx), first)


def load(text):
    return yaml.load(text, Loader=Loader)


def dump(data):
    return yaml.dump(data, Dumper=Dumper, sort_keys=False, allow_unicode=True, width=1000)
