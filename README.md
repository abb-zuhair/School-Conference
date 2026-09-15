# ACA Appointments

Parent-facing appointment and parent–teacher conference scheduling for Sama Education / American Creativity Academy — a self-hosted equivalent of MyConferenceTime, shaped around ACA's structure.

**Campus → Department → Teacher → Class → time slots.** Parents browse without an account, pick times with several teachers in one go, and get confirmations by email (Microsoft Graph) and WhatsApp (WATI). The same engine also runs uniform-fitting and re-registration desks.

Node.js · Express · SQLite (better-sqlite3) · EJS — the stack already running the payment-workflow and QMS apps, so it deploys to Railway the same way.

---

## Quick start

```bash
npm install
cp .env.example .env        # then edit SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run seed                # demo campuses, teachers, classes, events and slots
npm start                   # http://localhost:3000
```

Sign in at `/staff/login` with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. You will be forced to set a real password before the admin area opens.

Seeded teachers use the password `Welcome123!` (e.g. `sara.mutairi@example.aca.edu.kw`).

To start from nothing instead of the demo data:

```bash
npm run reset -- --yes && npm run migrate
```

Run the end-to-end test suite against a running server. It books and cancels real
appointments, so start it from a freshly seeded database:

```bash
npm run reset -- --yes && npm run seed && npm start   # in one terminal
npm run smoke                                          # in another — 45 checks
```

It covers the booking rules (overlap, per-student cap, one-teacher-once, double-booking,
locked schedules), cancellation and slot release, counter capacity, the teacher portal,
the admin exports, and access control.

```bash
npm run features   # CSV upload, compare toggle, department slot generation, back-ups
npm run sso        # Entra sign-in against a mock login host — starts its own instance
```

`npm run sso` needs no Microsoft credentials: it runs a fake authority on port 3101 and
walks the real redirect flow, including the rejections that matter — unknown account,
deactivated account, foreign tenant, wrong audience, expired token, replayed nonce and
forged `state`.

---

## What it does

### Parents (no account)

- Pick a campus, then an open event.
- Conference events: browse **department → teacher → class**. Service events (uniform, registration) list the counters directly.
- **Side-by-side compare** — tick two or more teachers and see their evenings on one grid, so a family can line up back-to-back slots. Optional per event (**Offer the side-by-side comparison grid**); turn it off for single-desk events and both the button and the URL disappear.
- Build a basket of times across several teachers and confirm once.
- Confirmation by email + WhatsApp, each with a private manage link.
- Cancel online (subject to the event's cutoff), download an `.ics`, or find bookings again at `/lookup` with the email used.

### Booking rules, enforced server-side

| Rule | Where it is set |
|---|---|
| Max appointments per student | Event setting (`0` = unlimited) |
| No two appointments at the same clock time for one family | Event setting `prevent_overlap` |
| One appointment per teacher per student | Always on |
| No double-booking a full slot | Enforced inside a SQL transaction — two parents clicking at once cannot both win |
| No booking a locked schedule or a past time | Always on |
| Cancellation cutoff | Event setting, in hours before the start |
| Side-by-side compare grid offered | Event setting `allow_compare` |
| Slot capacity > 1 | Per slot — used for walk-up counters where three families fit in one 20-minute window |

### Teachers

- Sign in with their school Microsoft 365 account (or a password — see [Staff sign-in](#staff-sign-in-with-microsoft-365-entra-id-sso)), see every schedule they own and their next appointments.
- Generate slots: dates, start/end, minutes each, gap, capacity, and an optional break (prayer time, for instance) that is punched out automatically.
- Set mode (in person / phone / video), room, Teams or Zoom link, and a note that rides along in the confirmation email.
- **Lock the schedule** — freezes new sign-ups without touching existing bookings.
- Block or delete individual slots, mark attended / no-show, cancel a booking (parent is notified).
- Print a signature sheet, export bookings to CSV.

### Administrators

- Campuses and departments; `campus_admin` accounts are scoped to their own campus, `admin` sees everything.
- Staff and classes, with **CSV import** — upload the file straight from Excel (or paste rows), with a downloadable template. It creates missing departments, adds classes, prints one-time passwords, and updates rather than duplicates an email that already exists, so the same file can be re-imported after an edit.
- **Download the database** as a single file from the admin dashboard — a consistent copy, safe to take while parents are booking.
- Events of four types — conference, uniform, registration, other — each with its own instructions, open/close window and rules.
- **Create schedules from classes**: tick departments, get one slot sheet per class in one click.
- **Bulk slot generation** — tick whole **departments** and every teacher in them gets the same pattern, or open a department and pick individual schedules. Safe to re-run after adding a teacher: duplicate times are skipped, and a department tick picks up schedules created since.
- Reports: fill rate per teacher, all bookings, bookings CSV, open-slots CSV, resend a confirmation.
- **Deleting.** A schedule with no bookings deletes outright; one with live bookings needs an explicit tick to cancel them, and parents are notified by default. Deleting a whole **event** is admin-only and behind a confirmation page that shows how many schedules, slots and bookings go with it and makes you type the event's name. Closing or archiving is offered first — that stops new sign-ups while keeping the history and parents' existing links working.
- Message log showing every email and WhatsApp attempt with its result.

---

## Configuration

Everything lives in `.env` — see `.env.example` for the full annotated list.

### Staff sign-in with Microsoft 365 (Entra ID SSO)

Teachers click **Sign in with Microsoft** and never get a password. Parents are unaffected — they still book without any account.

**Create the app registration**

1. Entra admin centre → **App registrations** → **New registration**.
   - Name: *ACA Appointments*
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Web**, value `https://appointments.aca.edu.kw/auth/microsoft/callback`
2. **Certificates & secrets** → **New client secret**. Copy the *Value* immediately — it is shown once. Note the expiry and put a reminder in your calendar; an expired secret breaks sign-in for everyone.
3. **API permissions** → the default `User.Read` (Delegated) is enough. `openid`, `profile` and `email` are included automatically. No admin consent needed for these.
4. **Overview** → copy the *Application (client) ID* and *Directory (tenant) ID*.

**Set the variables**

```
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<the secret Value>
```

Redeploy. The boot log confirms it:

```
sso : Microsoft Entra enabled (https://appointments.aca.edu.kw/auth/microsoft/callback)
```

**How accounts are matched.** The signed-in Microsoft identity is matched to an existing staff row — first by Entra object id, then by email. **Someone with no staff record is refused**, with a message telling them to contact the IT office. So the CSV import is still how people get in; SSO only replaces the password. Set `ENTRA_AUTO_CREATE=true` to create a teacher account on first sign-in instead, if you would rather let the whole tenant in.

Once someone has signed in, their Entra object id is stored, so changing their email in Microsoft 365 does not orphan the account.

**Password sign-in stays available** below the Microsoft button. Keep it: the uniform counter and front-desk accounts may have no mailbox, and it is your way back in if the client secret expires. Accounts that only ever use Microsoft never get a password and are never prompted for one.

**Things that commonly go wrong**

| Symptom | Cause |
|---|---|
| `AADSTS50011: redirect URI mismatch` | The URI in Entra must match `BASE_URL` + `/auth/microsoft/callback` exactly — scheme, host, no trailing slash. Add the Railway URL too if you test on it. |
| "not registered in the appointment system" | Working as intended — add the staff record first. |
| Sign-in worked, then stopped months later | The client secret expired. Create a new one and update `ENTRA_CLIENT_SECRET`. |
| `AADSTS700016: application not found in the directory` | `ENTRA_TENANT_ID` or `ENTRA_CLIENT_ID` is wrong, or the app was registered in a different tenant. |

### Email — Microsoft Graph (app-only)

1. Entra admin centre → **App registrations** → New registration.
2. **API permissions** → Microsoft Graph → *Application* permissions → `Mail.Send` → **Grant admin consent**.
3. **Certificates & secrets** → new client secret.
4. Fill in `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, and `GRAPH_SENDER` (a real mailbox, e.g. `noreply@aca.edu.kw`).

`Mail.Send` as an application permission lets the app send as *any* mailbox in the tenant. Narrow it with an **application access policy** in Exchange Online so it can only send as the noreply mailbox:

```powershell
New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId noreply@aca.edu.kw `
  -AccessRight RestrictAccess -Description "ACA Appointments sender"
```

Leave the Graph variables blank and email is skipped cleanly — the booking still works and the message log records it as `skipped`.

### WhatsApp — WATI

Set `WATI_API_ENDPOINT` (your `https://live-server-XXXX.wati.io` URL) and `WATI_ACCESS_TOKEN`.

Outside the 24-hour service window WATI only sends **approved templates**, so submit three templates and put their names in `WATI_TEMPLATE_CONFIRM`, `WATI_TEMPLATE_CANCEL`, `WATI_TEMPLATE_REMINDER`. The app always passes the same seven positional parameters:

| Parameter | Value |
|---|---|
| `{{1}}` | Parent name |
| `{{2}}` | Event name |
| `{{3}}` | Who the appointment is with |
| `{{4}}` | Date |
| `{{5}}` | Time |
| `{{6}}` | Location or meeting link |
| `{{7}}` | Manage-booking URL |

Suggested body for the confirmation template:

> Hello {{1}}, your booking for *{{2}}* with {{3}} is confirmed for {{4}} at {{5}}. Location: {{6}}. To view or cancel: {{7}}

Kuwaiti numbers typed as 8 digits get `DEFAULT_COUNTRY_CODE` (965) prepended automatically.

### Reminders

`REMINDER_CRON` (in `SCHOOL_TIMEZONE`) runs a job that messages every parent whose appointment starts within `REMINDER_HOURS_BEFORE`. Each booking is reminded once — the send is recorded in the notifications table and never repeated. Admins can trigger a run by hand from the message log.

---

## Deploying to Railway

1. Push this repo to GitHub, then **New Project → Deploy from GitHub repo**.
2. Add a **Volume** mounted at `/data`. **This is what keeps your data across deploys.** Without it the database lives inside the app folder, which the platform rebuilds on every deploy — campuses, teachers, bookings and your admin account all vanish. The app prints a warning at boot and shows a red banner on the admin dashboard whenever it detects this, so you will not find out the hard way.
3. Set the variables:

```
DATABASE_PATH=/data/app.db
SESSION_SECRET=<64 random hex chars>
BASE_URL=https://appointments.aca.edu.kw
NODE_ENV=production
ADMIN_EMAIL=zuhair@sama.com.kw
ADMIN_PASSWORD=<temporary, you change it at first sign-in>
SCHOOL_TIMEZONE=Asia/Kuwait
```
   plus the `GRAPH_*` and `WATI_*` values.

4. Add your custom domain. `railway.json` already points the healthcheck at `/healthz`.

The volume is what makes the database survive a redeploy — without it, every deploy starts empty.

**Node version matters.** `better-sqlite3` ships prebuilt binaries for Node 20 and 22 but not for Node 24, and Nixpacks has no C toolchain to compile it from source — so on Node 24 the build dies with `node-gyp ERR! not ok`. `engines` is pinned to `22.x` and `.nvmrc` says `22`, which is enough for Nixpacks. If Railway still picks a newer Node, set the variable `NIXPACKS_NODE_VERSION=22` and redeploy.

**Locked out of the admin account?** The bootstrap admin is only created when no
admin exists, so changing `ADMIN_PASSWORD` afterwards does nothing. Open the service's
**Console** tab on Railway (or any shell on the host) and run:

```bash
npm run set-password -- zuhair@sama.com.kw "a-new-password"
```

It resets the password on an existing account, or creates the account as an admin if
the email isn't there. Requires the same `DATABASE_PATH` the app uses, so the volume
must be mounted.

**Back-ups.** SQLite is one file. A nightly copy is enough:

```bash
sqlite3 /data/app.db ".backup /data/backup-$(date +%F).db"
```

---

## Project layout

```
src/
  server.js              app wiring, sessions, error handling
  config.js              all env parsing in one place
  db/
    schema.sql           tables — campuses → departments → staff → classes
                         → events → schedules → slots → bookings
    seed.js              demo data for ACA Hawally / Salmiya
    session-store.js     express-session store on the same SQLite file
  lib/
    scheduling.js        slot generation, availability, booking rules, cancel
    auth.js              roles, bcrypt, campus scoping, audit log
    helpers.js           timezone-aware dates, CSV, phone normalisation
    csv.js               RFC-4180 parser for the staff import
  routes/
    public.js            parent flow
    staff.js             teacher portal
    admin.js             admin console
  services/
    graph-mail.js        Microsoft Graph sendMail
    wati.js              WATI template messages
    notify.js            dispatcher + HTML email templates + delivery log
    reminders.js         cron reminder job
views/                   EJS templates
public/                  css + a little JS
test/smoke.js            end-to-end checks
```

### Data model in one line

An **event** is a booking window. A **schedule** is one bookable calendar inside it — for a conference that is a class (owned by its teacher); for a uniform or registration event it is a counter. A **slot** is a time on a schedule with a capacity. A **booking** is a parent against a slot.

That indirection is what lets the same engine serve a 40-teacher conference and a two-counter uniform shop without special cases.

---

## Notes, limits, and what would come next

- Parents are identified by the email they type. This was a deliberate choice for v1 — nothing stops a wrong name being entered, so the teacher's roster is the source of truth on the night. If sign-ups need to be tied to real students, the next step is importing a student list and asking for student ID + surname before the slot picker.
- Arabic fields (`name_ar`, `instructions_ar`) exist in the schema and the admin forms but the parent pages render English. Adding an `?lang=ar` toggle with `dir="rtl"` is a contained change — the data is already there.
- Sessions, bookings and the message log all live in the one SQLite file. That is comfortable well past ACA's volume; it is a single-writer database, so keep it on one Railway instance rather than scaling horizontally.
- Notifications are fire-and-forget with a delivery log. If WATI or Graph is down the booking still succeeds and the failure is visible in the message log — but there is no automatic retry yet.
