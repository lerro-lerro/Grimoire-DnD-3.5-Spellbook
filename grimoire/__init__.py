"""Grimoire: the modules behind server.py.

    dndtools    download and parsing of the dndtools.net spell pages
    search      dndtools search with its filters
    units       imperial measurements to metric
    conditions  the SRD conditions (web/conditions.json), downloaded when missing
    metamagic   the dndtools metamagic feats (web/metamagic.json), downloaded when missing
    updater     updates from GitHub with git (no lxml needed: python3 server.py --update works without it)
"""
