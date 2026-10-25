# Tim & Myles Booking — web app

This repository only serves the app page at https://timandmylesthompson.github.io/booking/.

- No data lives here. Venues, notes, gigs and photos are in a Supabase project, protected by a team-only login.
- The key in `supabase-shim.js` is Supabase's public (publishable) key, which is meant to be in web pages; team-only security rules in the database decide who can read or change anything.
- Source, research data and build scripts are in the private repository `timandmylesthompson/tim-myles-booking`. Edit there and run `scripts/build_web.py`, then copy `web/index.html` and `web/supabase-shim.js` here.
