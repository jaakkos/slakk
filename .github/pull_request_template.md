## What and why

<!-- What does this change, and what problem does it solve? -->

## Output changes

<!-- Do the GPX, PNG, HTML or report change for the same inputs? If yes, say how, and whether it is behind a flag. -->

- [ ] No output changes
- [ ] Outputs change (explained above)

## Checks

- [ ] `python -m unittest -v` and `python scripts/smoke_test.py` pass
- [ ] Unknown hazard colours and missing data still fail closed; no constraint is relaxed silently
- [ ] No tracks, Strava ids, tokens or terrain caches are included
