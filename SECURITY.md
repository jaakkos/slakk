# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/jaakkos/slakk/security/advisories/new),
not in a public issue. Include the slakk version, your platform and the steps
to reproduce. Don't include real tokens or private tracks; synthetic examples
are enough.

You should get a reply within two weeks. slakk is maintained in spare time,
so there is no formal service level.

## Supported versions

Only the latest release gets fixes.

## Scope

In scope: anything that could leak Strava tokens or client secrets, run code
or write outside the chosen output and cache folders from crafted GPX,
GeoJSON or terrain files, or accept a modified cache as valid.

Out of scope: route quality or safety. Candidates are unverified planning
aids, not safe routes; see the Disclaimer in the README. Please open a normal
issue for wrong or surprising routes.

## How slakk handles credentials

- `strava-login` saves only the access token, refresh token and expiry to
  `~/.config/slakk/strava-token.json` (or `$XDG_CONFIG_HOME`), with mode 0600
  on Linux and macOS. On Windows the file has your user profile's
  permissions.
- Tokens are sent in the `Authorization` header, never in URLs.
- The client id and secret come from environment variables and are never
  written to disk.

Dependencies are pinned with hashes and checked weekly with pip-audit.
