# Setting up the system for another school

One copy of the app serves one school. Kuwait English School and RGS Guildford
Muscat each get their own Railway service, their own database, their own
address, their own Microsoft sign-in and their own look — but all three run the
same code from the same GitHub repository, so one `deploy.bat` updates all of
them at once.

Nothing here touches ACA. Its service, volume and data are separate.

## What you need before you start

For each school:

- A logo, ideally a **white (or light) version on a transparent background**,
  PNG or SVG. It sits on the coloured header bar, so a dark logo disappears.
- The two brand colours as hex codes (from the school website or the logo).
- The address parents will use, e.g. `appointments.kes.edu.kw` /
  `appointments.rgsgm.edu.om`, and someone who can add a DNS record for it.
- An admin account in **that school's Microsoft 365 tenant** (for SSO) — or, if
  the school is not on Microsoft 365, staff simply use passwords.
- A mailbox the confirmations will come from (e.g. `appointments@kes.edu.kw`).
- Optionally the school's WATI account for WhatsApp.

## 1. Create the Railway service (10 minutes)

1. In Railway, **New Project → Deploy from GitHub repo**, pick
   `abb-zuhair/School-Conference`, branch `main`. Name the project after the
   school (e.g. `kes-appointments`). A separate *project* per school keeps
   billing, volumes and variables apart and is the least confusing later.
2. **Add a Volume** mounted at `/data`. Do this before the first deploy — it
   is what keeps the database across updates.
3. **Variables** — set these (Raw Editor is quickest):

```
DATABASE_PATH=/data/app.db
NODE_ENV=production
BASE_URL=https://appointments.kes.edu.kw
SESSION_SECRET=<new 64-character random string — never reuse ACA's>
SCHOOL_TIMEZONE=Asia/Kuwait                  # Asia/Muscat for RGS
SCHOOL_NAME=Kuwait English School
SCHOOL_SHORT=KES
BRAND_PRIMARY=#1d3f8a                        # main colour — header, buttons
BRAND_ACCENT=#d7262c                         # accent — small highlights
SUPPORT_EMAIL=it@kes.edu.kw
SCHOOL_DOMAIN=kes.edu.kw
ADMIN_EMAIL=<your address at that school, or any address you will sign in with>
ADMIN_PASSWORD=<temporary — you are made to change it at first sign-in>
ADMIN_NAME=Zuhair
NIXPACKS_NODE_VERSION=22
```

   Generate the secret with
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   or any password generator; it just has to be long and random.

   Leave the `ENTRA_*`, `GRAPH_*` and `WATI_*` variables out for now — they
   come in steps 3 and 4. Without `ENTRA_*` the Microsoft button is hidden
   and staff use passwords, which is fine to begin with.

4. **Settings → Networking → Custom Domain**: add
   `appointments.kes.edu.kw`. Railway shows a CNAME target; the school's DNS
   admin adds that record. Until it resolves, the `*.up.railway.app` address
   works for testing. If you test on that address first, set `BASE_URL` to it,
   then change `BASE_URL` to the real domain once DNS is done — the links in
   emails come from `BASE_URL`.
5. Deploy. The first boot creates the admin account from `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`. **Do not run `npm run seed`** on a school's service — the
   seed is ACA demo data.

RGS: the same, with `SCHOOL_TIMEZONE=Asia/Muscat`, `SCHOOL_DOMAIN=rgsgm.edu.om`
and the Oman address. Reminders go out at 6 pm *school* time, so the timezone
matters.

## 2. Make it look like the school (5 minutes, in the browser)

Sign in at `https://appointments.kes.edu.kw/staff/login` with the admin
address and temporary password, set a real password, then **Admin →
Branding**:

- upload the logo (white version), or leave it and the short mark is used;
- check the two colours — the preview at the top shows the header as parents
  will see it; the picker lets you fine-tune against the school website;
- Arabic name if the school wants one on bilingual pages;
- support email and staff domain.

Everything you set here overrides the variables from step 1, so the variables
are only the starting point; the school's office can adjust later without you.

Then **Campuses & departments**: add the campus(es) — a single-site school
still needs one campus, with its departments. Then **Import CSV** for staff
and classes (the template is on that page), and **New event** for the first
conference. The parent and teacher guides in `docs/guides` describe the rest;
they currently say "ACA" in places and can be regenerated per school later.

## 3. Microsoft sign-in for that school's staff

Each school has its own Microsoft 365 tenant, so each needs its own app
registration — ACA's cannot sign in KES staff.

In the school tenant's Entra admin centre: **App registrations → New
registration**, name `Appointments`, single-tenant, platform **Web**, redirect
URI `https://appointments.kes.edu.kw/auth/microsoft/callback`. Under
**Certificates & secrets** create a client secret (note the *value* at once).
Then set on Railway:

```
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<the secret value>
```

Redeploy; the **Sign in with Microsoft** button appears. The README's SSO
section covers the rest (auto-create, the sign-in check page). As with ACA,
anyone in the tenant without a staff record is refused unless
`ENTRA_AUTO_CREATE=true`.

If you would rather not ask the school for tenant access, skip this step —
passwords work, and each account gets a temporary one when created.

## 4. Email and WhatsApp

**Email** is set from **Admin → Email**, not from variables. Microsoft 365:
grant the same app registration the *application* permission `Mail.Send`
(admin consent) and enter the sending mailbox on the Email page. Or SMTP with
the school's own relay. Press **Send a test** — it tells you exactly what is
wrong if anything is. Railway blocks outbound SMTP on the Hobby plan, so a
school on SMTP needs the Pro plan or the Graph route.

**WhatsApp** is set from **Admin → WhatsApp** with that school's WATI token
and template names. Set the **country code** there — `965` for Kuwait, `968`
for Oman — so numbers parents type without a code still go through.

## 5. Updating all schools at once

Because every service deploys from the same repository and branch, a push
updates all of them. `deploy.bat` already backs up ACA before pushing; add the
other schools to the `SITES` line near the top of the file so it opens one
backup tab per school:

```
set "SITES=https://appointments.aca.edu.kw https://appointments.kes.edu.kw https://appointments.rgsgm.edu.om"
```

(Each school's admin page downloads that school's own database; nothing is
shared between them.)

If one school ever needs to stay on an older version, give it its own branch
in Railway's service settings — but that doubles the work from then on, so
avoid it unless there is a real reason.

## 6. Things to know

- **Data is per school.** Separate databases, separate volumes, separate
  backups. An admin at KES cannot see ACA, and vice versa. If you want one
  sign-in for yourself at all three, create your account at each.
- **Costs.** Each Railway service is billed on its own usage; the app is light
  (a few dollars a month each), but the Pro-plan requirement for SMTP applies
  per workspace, not per service.
- **The guides and the video** are branded ACA. The scripts in `docs/guides`
  regenerate them; re-running them against a KES-branded instance produces KES
  screenshots. Ask when you are ready for that.
- **Arabic.** Everything bilingual works the same; RGS may not want Arabic on
  the parent pages at all — that is a per-event choice (leave the Arabic
  instructions empty).

## Quick checklist

```
[ ] Railway project, repo + main branch, volume at /data
[ ] variables (DATABASE_PATH, BASE_URL, SESSION_SECRET, SCHOOL_*, BRAND_*, ADMIN_*)
[ ] custom domain + DNS CNAME
[ ] first sign-in, password changed
[ ] Admin → Branding: logo, colours, support email, domain
[ ] Campuses & departments, staff CSV, first event
[ ] Entra app in the school tenant (optional), ENTRA_* set
[ ] Admin → Email: mailbox + test
[ ] Admin → WhatsApp: WATI + country code (optional)
[ ] add the site to SITES in deploy.bat
```
