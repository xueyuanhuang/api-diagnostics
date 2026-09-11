# Navigation regression checks

Checked in the in-app browser on 2026-09-07 using the actual app components
and `navigation-harness.tsx`. All API responses were simulated locally;
no provider traffic or real keys were used.

Run `pnpm exec vite --config tests/navigation.vite.config.ts` and open
`http://127.0.0.1:4175/tests/navigation.html` to repeat.

- Start a normal check with Fixture connection, browse Saved runs, open
  Archived normal, switch to RPM, then View live test. The normal request
  remains pending, with one request and zero aborts. RPM Start is disabled.
- Stop after returning. Exactly one normal abort; no later questions start.
- Start again, open Archived normal, click Finish pending normal responses.
  All 12 live questions finish and save once. The archived result remains
  visible. View latest results restores all 12 live-model results, not the
  archived-model snapshot.
- Start RPM with target 100. Browse Saved runs and open Archived RPM, switch
  to Normal Token Check, then View live test. The same stream remains open;
  verified dispatch progress advances from 35 to 37. One run creation,
  one stream, zero stream aborts/cancels while browsing. Normal Start is
  disabled. Archived RPM exposes no Start or Cancel controls.
- Stop the live RPM test. Exactly one cancellation and one stream abort;
  the visible state changes to Run cancelled.

The fixture also counts unmocked requests; this stayed at zero throughout.
These checks verify navigation, state ownership, and cancellation only, not
provider capacity or a real 1,000-RPM load.

## Shared website navigation (2026-09-11)

The fixture now renders SiteWorkspace and simulates animation responses too.
The production build previously threw from the framework Link navigation helper;
workspace links now update browser history and the persistent workspace directly.

Verified in the in-app browser:

- Click the Pelican card: the URL and visible section change to `/pelican`.
- Choose Fixture connection and start an animation. Open All tests, then
  Connections: one mock request, zero aborts, zero unmocked requests.
- Finish the pending response while on Connections and return to Pelican:
  the completed HTML preview and account-save confirmation are preserved.
- The Browser Back and Browser Forward fixture buttons restore the matching
  Pelican and Connections sections using real browser history events.
- On the deployed build, the Pelican card opens the animation form and loads all
  nine saved connections, with no new navigation errors and no paid requests.
