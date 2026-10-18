# Odometer Pace

A small self-hosted page that tracks a car lease's mileage. It shows every day of the lease as a calendar, crosses off the days that have passed, and compares your odometer with where it should be. Readings are saved on your server, so your phone and your computer always match.

> **Beta.** Expect rough edges while it is still being tested.

- Day-by-day calendar for the whole lease, today marked, past days crossed off
- Odometer log: over or under pace, miles remaining, miles per day, projected odometer at lease end
- Chart of your readings against the allowed line
- One container, one small JSON file in a volume, no database server
- Dark theme with six accent colors (purple by default) and an OLED black option, set in Settings, works on phones
- Admin and user logins: the admin sets up the lease, everyone else can add readings
- API keys so an AI or script can add readings and read your status, one set per person
- Your lease details are typed in the app on first run. Nothing about your lease is in the code.

## Setup

1. Copy `docker-compose.yml` into a new stack (Dockhand, Portainer, plain Docker, anything that reads Compose files).
2. Fill in the variables. Either put them in a `.env` file next to the compose file, or paste them in Dockhand's Environment tab. Do not add `:-` defaults, some tools choke on them.
3. Start the stack.
4. Open `http://your-server:8461`. The first screen creates the admin login (a username and a password).
5. Enter your lease: start date, number of years, total miles allowed, and the odometer reading on the day you got the car.

### Variables

| Variable | What to put | Example |
| --- | --- | --- |
| `PORT` | Port to listen on (host and container use the same number) | `8461` |
| `TZ` | Your time zone, so "today" is right | `America/New_York` |
| `AUTH_MODE` | `app` for the built-in login, `proxy` if your reverse proxy handles login | `app` |
| `COOKIE_SECURE` | `true` when you reach it over https, `false` on plain http | `true` |
| `TRUST_PROXY` | `1` when it sits behind a reverse proxy, otherwise `0` | `1` |
| `DATA_PATH` | Folder on your server where readings are stored | `/DATA/AppData/odometer-pace` |

A filled-out example is in `.env.example`.

### Compose file

```yaml
services:
  odometer-pace:
    container_name: odometer-pace
    build: https://github.com/dhrandy/odometer-pace.git#main
    restart: unless-stopped
    ports:
      - "${PORT}:${PORT}"
    environment:
      PORT: ${PORT}
      TZ: ${TZ}
      AUTH_MODE: ${AUTH_MODE}
      COOKIE_SECURE: ${COOKIE_SECURE}
      TRUST_PROXY: ${TRUST_PROXY}
    volumes:
      - ${DATA_PATH}:/data
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:$${PORT}/api/session >/dev/null || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

The container builds from this repository, so the Dockerfile is only used by the build and you never run it yourself. To update: stop, rebuild or pull, start. Your readings live in `DATA_PATH` and are kept.

## Reverse proxy

Any reverse proxy works: point it at the container port and turn on https. The app has its own password login (`AUTH_MODE=app`), so the proxy does not need one. Set `COOKIE_SECURE=true` and `TRUST_PROXY=1` when you use https behind a proxy.

If you would rather put your own login in front (Authentik, Authelia and similar), set `AUTH_MODE=proxy`. The app then trusts everything that reaches it, so make sure the page can only be reached through the login. Keep `/api/v1/` open past that login: those routes are protected by API keys instead, which is how an AI or script gets in.

The app sends `noindex` headers and a `robots.txt` that disallows everything. Your server settings, readings and keys are never reachable without logging in.

## Admin and users

The first login you create is the admin. The admin adds logins for the rest of the household in Settings, under Logins.

| | Admin | User |
| --- | --- | --- |
| See the calendar, stats and chart | yes | yes |
| Add odometer readings | yes | yes |
| Delete readings | yes | no |
| Change lease settings | yes | no |
| Pick own accent color and OLED black | yes | yes |
| Add, remove and reset logins | yes | no |
| Create and revoke their own API keys | yes | yes |
| See and revoke everyone's API keys | yes | no |
| Change their own password | yes | yes |

Each reading shows who entered it. Removing a user also removes their API keys. The admin login itself cannot be removed, and there is no password reset by email, so the admin sets a new password for a user from Settings. If the admin forgets their own password, stop the container, delete the `users` list from `odometer-pace.json` in your data folder, and start it again to create a new admin.

With `AUTH_MODE=proxy` there are no logins in the app. Everyone who gets through your proxy counts as the admin.

## API keys for AI and scripts

Everyone with a login (admin or user) can open Settings, then API keys, give a key a name and create it. The key is shown once, so copy it then. Only a hash is stored. A key belongs to the person who made it, and the admin can see and revoke all keys.

A key can add odometer readings and read the status and readings. It cannot see settings, logins, or other keys. The full docs, with examples, are at `/api/docs` after you log in.

```
curl -H "Authorization: Bearer $KEY" https://your-host/api/v1/status

curl -X POST https://your-host/api/v1/readings \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"odometer": 1150, "date": "2030-04-05"}'
```

`date` is optional and defaults to today. One reading per date, and the odometer cannot go lower than an earlier reading.

### Instructions to give your AI assistant

Paste this into your assistant's instructions or memory. Replace the two placeholders first. Keep the real key out of anything that gets shared or saved to a public place.

````
You can keep my car lease mileage up to date through a small API called Odometer Pace.

Base URL: https://YOUR-HOST
API key: YOUR-KEY

Send the key on every request as a header:
Authorization: Bearer YOUR-KEY
For POST requests also send: Content-Type: application/json

What you can do:

1. Check where I stand: GET /api/v1/status
   Useful fields in the reply:
   - latest.odometer and latest.date: the last reading on file
   - latest.pace_status: "over", "under" or "on_pace"
   - latest.miles_over_pace: positive means over pace, negative means under
   - latest.miles_remaining: miles left before the limit
   - latest.miles_per_day_to_stay_under: what I can drive per day from now on
   - latest.projected_end_odometer and latest.projected_vs_limit: where I end up at this pace
   - allowed_odometer_today: the on-pace odometer for today
   - lease.state: "not_started", "active" or "complete"
   If latest is null, there are no readings yet. If configured is false, the lease is not set up and I need to do that in the app.

2. List readings: GET /api/v1/readings
   Returns {"readings": [{"date", "odometer", "source"}]}, oldest first.

3. Add a reading: POST /api/v1/readings
   Body: {"odometer": 12345}
   Or with a date: {"odometer": 12345, "date": "2030-04-05"}
   The date is optional (YYYY-MM-DD) and defaults to today. Only one reading is kept per date, so a second one for the same date replaces the first.
   Success is HTTP 200 with {"saved": {...}, "status": {...}}, and the status is the same shape as GET /api/v1/status.
   A rejected reading is HTTP 400 with {"error": "plain reason"}, for example if the odometer is lower than an earlier reading or the date is before the lease starts. Tell me the reason. Do not retry with a changed number to get around it.
   HTTP 401 means the key is wrong or revoked. HTTP 429 means too many failed attempts, so wait and tell me.

Rules:
- Never print, repeat or save the API key anywhere except where I put it for you.
- Only add a reading when I give you the odometer number or you read it from a photo or screen I showed you. Never guess, estimate or calculate one.
- Odometer readings are whole miles. If I say "about 12.3k", ask me for the exact number.
- Before adding, tell me the number and date you are about to save if there is any doubt. After adding, tell me the new pace in one or two sentences: miles over or under pace, and how many miles I have left.
- You cannot delete readings or change settings. If something needs fixing, tell me to do it in the app.
````

## How the allowance is counted

Each lease year gets an equal share of the total (36,000 miles over 3 years is 12,000 per year). That share is spread evenly over that lease year's own days, so a leap day does not skew the pace. The "on pace" odometer is your starting odometer plus the miles allowed through the end of the day of your reading. The odometer limit is the starting odometer plus the total allowed.

## Development

```
npm test
PORT=8461 DATA_DIR=./data node server.js
```

Node 22, no dependencies, no build step. Tests live in `tests/`.

## Fonts

The app serves its own fonts from `public/fonts/`, so nothing is fetched from Google or a CDN and every device draws the same letters. The body font is Inter and the headings use Source Serif 4. Both are under the SIL Open Font License 1.1, which allows bundling with an MIT project. The license texts sit next to the font files.

## License

MIT, see `LICENSE`.
