# Decision 0004: Push to GitHub deploys, via Actions rather than Git-connected Pages

Date: 2026-07-25
Status: Accepted. Fred's ruling. IMPLEMENTED BUT NOT YET FUNCTIONAL, see
"Current blocker".

## Fred's ruling

Asked how the site should ship, Fred said: always push to GitHub, which
pushes to Cloudflare Pages, where Cloudflare DNS points
tools.nixfred.com at the Pages project.

So the intended developer experience is: commit, push, the site updates.
No manual deploy step.

## Why not Git-connected Pages, which is the obvious answer

Cloudflare Pages supports connecting a GitHub repository directly, and
that is exactly the behavior Fred described. It was rejected for a
mechanical reason, not a stylistic one.

Connecting a repository to a Pages project requires an interactive
GitHub OAuth grant performed in the Cloudflare dashboard. There is no
API and no wrangler command that performs that handshake. It cannot be
done from a terminal, which means it cannot be done by the factory.

## Why not the factory default, Direct Upload

The seed ships deploy.sh, which runs `wrangler pages deploy dist`. That
is Direct Upload: the build happens on the operator's machine and the
output is pushed to Cloudflare from there.

It works, and it is retained as a manual escape hatch. But it is not
what Fred asked for, because deploys then originate from whichever
machine happens to run the script rather than from the repository. A
push would not ship anything.

## The decision: GitHub Actions

.github/workflows/deploy.yml runs on push to main and on manual
dispatch. It checks out, installs with a frozen lockfile, builds, runs
the link and safety gates, and then deploys with
cloudflare/wrangler-action.

This reproduces the behavior Fred asked for, a push ships the site, and
every part of it is configurable from a terminal.

Three details worth keeping:

1. The gates run BEFORE the deploy step. A red gate cannot ship. That is
   the release contract, and it is why the gates live in the workflow
   rather than only in a local script.
2. A concurrency group prevents two deploys racing. Pages applies
   whichever upload finishes last, which is not necessarily the newest
   commit.
3. The Cloudflare account id is inlined. It is an identifier, not a
   secret. Only the API token is a secret.

## Current blocker

THE WORKFLOW IS WRITTEN AND VALIDATED BUT CANNOT SUCCEED YET.

No credential on the build machine holds Cloudflare Pages permission.
This was diagnosed rather than guessed:

1. The CLOUDFLARE_API_TOKEN in ~/.env.local verifies as active against
   Cloudflare's own /user/tokens/verify endpoint, and returns API error
   10000 against the Pages endpoint specifically. That is a valid token
   without Pages permission, not an invalid token.
2. CF_API_TOKEN, scoped for Tunnel and DNS work, also returns 10000 on
   Pages.
3. The wrangler OAuth credential exists at
   ~/Library/Preferences/.wrangler/config/default.toml with an access
   token that expired 2026-07-18. The refresh also failed, and the build
   shell is non interactive, so wrangler cannot open a browser to
   re-authenticate itself.

Note for the next session: the SiteFactory SKILL.md currently claims the
environment token works for Pages and should not be unset. As of
2026-07-26 that note is WRONG, and memory from the mac.nixfred.com build
was right. Trust the endpoint, not the note.

## What unblocks it

One API token, created at dash.cloudflare.com/profile/api-tokens with:

1. Account, Cloudflare Pages, Edit
2. Zone, DNS, Edit, on nixfred.com

That single token unblocks both halves of the problem, because Actions
cannot use an OAuth credential either. It needs an API token regardless.

Then, in order:

1. Create the Pages project, `tools-nixfred-com`.
2. First deploy.
3. Attach the custom domain tools.nixfred.com.
4. Create the proxied CNAME on the nixfred.com zone.
5. `gh secret set CLOUDFLARE_API_TOKEN` on the repository.

After step 5, Fred's ruling is fully in force and a push ships the site.

## Until then

Every push runs the workflow, passes the build and both gates, and fails
at the final deploy step. That failure is expected and is not a code
defect. It will go green the moment the secret exists.
