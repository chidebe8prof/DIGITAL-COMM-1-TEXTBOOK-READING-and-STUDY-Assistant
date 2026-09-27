# Deploying the AI Study-Assistant Server

This is the small server that holds your real Anthropic API key so it never has
to be shipped inside the offline app that goes out to students. It answers two
requests: "ask a question" and "generate a quiz." Everything else in the app
(reading, search, the offline review quiz) works without this server at all.

You only need to do this once. After it's deployed, you get a URL — paste that
into the app's Settings screen (yours and your students') and the AI features
switch on.

## Recommended: Render.com (free tier, ~10 minutes, no credit card needed to start)

1. **Get an Anthropic API key** (if you don't have one already):
   Go to https://console.anthropic.com/settings/keys → Create Key. Copy it
   somewhere safe — you won't be able to see it again after you leave the page.

2. **Create a Render account**: https://render.com → Sign up (GitHub or email
   both work).

3. **Get this `server/` folder onto GitHub** (Render deploys from a Git
   repository):
   - Easiest path: create a new repository on GitHub (github.com/new), then
     upload the contents of this `server/` folder to it directly through
     GitHub's web "Add file → Upload files" button — no command line needed.
   - Do **not** upload the `.env` file if you make one locally — only
     `.env.example` should go in the repository. Your real key never goes into
     any file that gets uploaded anywhere.

4. **In Render**: New → Web Service → connect the repository you just made.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free is fine to start.

5. **Add your environment variables** (Render calls this "Environment" in the
   service's dashboard — this is where the real key lives, safely, on Render's
   servers, never in your code):
   - `ANTHROPIC_API_KEY` = the key you copied in step 1
   - `ALLOWED_ACCESS_CODES` = a code you make up and share with your class,
     e.g. `ECS2026` (you can list several separated by commas)
   - `DAILY_LIMIT` = how many AI requests each access code can make per day
     (40 is a reasonable starting point for a class; raise or lower later)

6. **Deploy.** Render will build and start the server, and give you a URL like
   `https://ecs-study-assistant.onrender.com`.

7. **Test it**: visit `https://your-url.onrender.com/health` in a browser —
   you should see `{"status":"ok","model":"claude-sonnet-5","chapters":10}`.
   If you see that, it's working.

8. **Put the URL into the app**: open the offline app, click the ⚙ Settings
   icon, paste the URL into "Study-assistant server URL", and the access code
   into "Access code." Save. The AI Assistant panel should now say
   "AI: server configured."

That URL and access code are what you share with your students (alongside the
app itself) so their copies can use the AI features too — they just enter the
same two values in their own Settings screen once.

### A note on Render's free tier
Free services on Render "sleep" after periods of inactivity and take a few
seconds to wake up on the next request — the first AI question after a quiet
period may feel slow, then it's normal speed. If that's a problem for your
class size, Render's paid tier removes this; it isn't necessary to get started.

## Alternative: Railway.app
Very similar process to Render (connect a GitHub repo, set the same three
environment variables, deploy). Slightly different free-tier limits — worth
comparing if Render's sleep behavior is inconvenient for you.

## Alternative: Your own server / VPS
If Fed Poly Oko already has a server you can use: install Node.js 18+, copy
this `server/` folder onto it, create a real `.env` file from `.env.example`
with your actual key, run `npm install` then `npm start` (or better, run it
under a process manager like `pm2` so it restarts automatically). You'll need
to handle HTTPS yourself (e.g. via a reverse proxy like Caddy or Nginx) —
browsers will refuse to let the app (served over HTTPS or opened as a local
file) talk to a plain `http://` server in some configurations, so HTTPS is
worth setting up from the start.

## Changing or rotating the API key or access codes later
Go back into your hosting platform's dashboard (Render/Railway's "Environment"
tab), update the value, and redeploy — no changes to the app itself are
needed, since the app never contains the key.

## Cost
You pay Anthropic directly for API usage (not Render/Railway, which are free
at this scale). Cost depends on how many questions get asked and how long the
book-chapter context is per request; the `DAILY_LIMIT` setting is your primary
lever for keeping this predictable. Check current usage and set a spending
alert at https://console.anthropic.com/settings/billing.
