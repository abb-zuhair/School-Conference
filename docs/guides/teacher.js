'use strict';
/**
 * Teacher guide, with a chapter for department heads at the end.
 */
const L = require('./lib');

const c = [];

c.push(...L.title('American Creativity Academy', 'Teacher Guide',
  'Setting up your conference schedule and running the evening'));

c.push(L.p('Parents book their own slots with you online. Your job is to say when you are free, and then work from the list on the night. Everything below takes about five minutes the first time.', { after: 200 }));

/* ---------------- signing in ---------------- */
c.push(L.h1('Signing in'));
c.push(...L.numbered([
  'Go to **appointments.aca.edu.kw/staff/login**.',
  'Click **Sign in with Microsoft** and use your school account. There is no separate password to set or remember — your Microsoft sign-in is enough.',
  'If your account has no Microsoft mailbox, use the email and password the IT office gave you. You will be asked to choose your own password the first time.',
]));
c.push(...L.shot('t01-login.png', 'Microsoft first; the password form is there for accounts without a mailbox.', { maxWidth: 520 }));
c.push(L.note('If Microsoft says you are not registered',
  'Your account has not been added to the appointment system yet. Email the IT office and they will add you in a minute — then sign in again.'));

/* ---------------- dashboard ---------------- */
c.push(L.h1('Your schedules'));
c.push(L.p('After signing in you land on **My schedules**. Each card is one class in one event — a teacher with three classes has three cards. The card shows how many slots are booked and how many are still free.'));
c.push(L.p('Below that, **Next appointments** lists your upcoming bookings with the student, the parent\'s phone and any note they left.'));
c.push(...L.shot('t02-dashboard.png', 'One card per class. Next appointments shows who is coming and what they want to discuss.', { maxWidth: 560 }));

/* ---------------- opening times ---------------- */
c.push(L.h1('Opening your times'));
c.push(L.p('Open a schedule card. The top of the page shows how it is going — booked, still free, total slots, and whether sign-ups are open.'));
c.push(...L.shot('t03a-schedule-header.png', 'The summary at the top of every sheet.', { maxWidth: 560 }));
c.push(L.p('Then fill in **Add time slots**:', { keepNext: true }));
c.push(L.table(['Field', 'What to put'], [
  ['Date(s)', 'One or more dates as YYYY-MM-DD, separated by commas — for example *2026-10-05, 2026-10-06*.'],
  ['Start / End', 'The window you are available, e.g. 15:00 to 18:00.'],
  ['Minutes each', 'Length of one meeting. Ten minutes is usual for a conference evening.'],
  ['Gap (min)', 'Breathing space between meetings. Leave at 0 unless you need it.'],
  ['Parents per slot', 'Keep at 1 for conferences. Higher numbers are for walk-up counters.'],
  ['Break (optional)', 'From and To — prayer time or a rest. Those slots are created but closed to parents, and show as *Break* in your list.'],
], [2400, 7238]));
c.push(L.p('', { after: 40 }));
c.push(L.p('Press **Generate slots**. The list appears below. Running it again with different dates adds to what is there — duplicate times are skipped, so you cannot create the same slot twice by accident.'));
c.push(...L.shot('t03b-add-slots.png', 'Add time slots on the left; what parents see about the meeting on the right.'));
c.push(L.note('Changed your mind about the pattern?',
  'Use **Remove empty slots** above the list to clear everything nobody has booked, then generate again. Slots that already have a parent in them are never removed this way.'));

/* ---------------- meeting details ---------------- */
c.push(L.h1('Meeting details'));
c.push(L.p('The **Meeting details** panel beside the slot generator controls what parents see in their confirmation:'));
c.push(...L.bullets([
  '**Display name** — overrides the class name, if you would rather show something else.',
  '**How the meeting happens** — In person, Phone call or Video call.',
  '**Room / location** — printed in the confirmation and on your sheet.',
  '**Video link** — your Teams or Zoom link. It is included in the confirmation email when the mode is a video call.',
  '**Note for parents** — anything they should know beforehand, shown on your booking page.',
]));
c.push(L.p('Press **Save details**. Changes appear immediately; parents who have already booked keep their appointment.'));

/* ---------------- while open ---------------- */
c.push(L.h1('While bookings are open'));
c.push(L.h2('Closing your list early'));
c.push(L.p('**Lock schedule** (top right of the sheet) stops new sign-ups without touching anyone who has already booked. Useful the evening before, so nobody appears on your sheet after you have printed it. **Unlock** reopens it.'));
c.push(L.h2('Holding a particular time'));
c.push(L.p('Any slot with nobody in it has **Block** and **Delete** beside it. Block keeps the row visible but closed (and **Open** reverses it); Delete removes it. Neither is offered once a parent has booked that time — cancel the booking first.'));
c.push(L.h2('Cancelling a booking'));
c.push(L.p('Press **Cancel** on the row. The parent is emailed and sent a WhatsApp message automatically, and the time is released for someone else. Use this sparingly — it is better than a no-show, but parents notice.'));
c.push(L.h2('Brothers and sisters'));
c.push(L.p('A parent with more than one child at the school books for all of them in one go, and each booking carries the child\'s name. If you teach two siblings you will see both on your sheet, each under their own name, at different times — the system does not let one parent hold two appointments at the same clock time.'));
c.push(L.h2('If your evening has to move'));
c.push(L.p('Only the office can move booked slots to another date or time. When they do, every parent affected is told automatically, with the old time and the new one, and their existing links keep working. You do not need to contact anyone — just check your sheet afterwards.'));

/* ---------------- on the day ---------------- */
c.push(L.h1('On the day'));
c.push(...L.numbered([
  'Open the schedule and press **Print sheet**. You get a signature sheet per day, with time, student, parent, phone and a signature column. Open slots are marked “(open)”.',
  'As each family arrives, mark **Attended**. If they do not appear, mark **No-show** once the slot has passed.',
  '**Export CSV** gives you the same list as a spreadsheet, if you would rather keep it on a laptop.',
]));
c.push(...L.shot('t03d-attendance.png', 'Each booked row: the student and grade, the parent and phone, their note, and the three buttons.'));
c.push(...L.shot('t04-print.png', 'The printed sheet — one page per day.', { maxWidth: 520 }));
c.push(L.note('Print the sheet on the day, not the week before',
  'Parents cancel and rebook right up to the cutoff. A sheet printed on Sunday for a Wednesday evening will be out of date.'));

/* ---------------- FAQ ---------------- */
c.push(L.h1('Questions teachers ask'));
c.push(L.table(['Question', 'Answer'], [
  ['Can I see who booked before the day?', 'Yes — your dashboard and each schedule show every booking as it arrives, with the parent\'s note.'],
  ['A parent wants a different time.', 'Ask them to cancel from the link in their confirmation and book again, or ask the office to move it.'],
  ['Two of my classes clash for one family.', 'They cannot book two appointments at the same clock time, even for two children, so this sorts itself out. If it still happens, the office can cancel one.'],
  ['I need more slots at the last minute.', 'Generate more on the same date with a later start time. New slots appear for parents immediately.'],
  ['I forgot my password.', 'Use **Sign in with Microsoft** instead — no password is needed with it. Otherwise ask the IT office for a reset; there is no self-service reset.'],
  ['Can I change a parent\'s note or details?', 'No. Contact the office if something needs correcting.'],
], [3400, 6238]));

/* ---------------- department heads ---------------- */
c.push(L.pageBreak());
c.push(L.h1('For department heads'));
c.push(L.p('If the IT office has made you a **department head**, you see everything above for your own classes, plus a **My department** link in the top bar. That page lists every teacher in your department, every schedule they hold, and how full each one is.'));
c.push(...L.shot('h01-department.png', 'My department: every teacher, every sheet, booked and free at a glance.', { maxWidth: 580 }));
c.push(L.h2('What you can do'));
c.push(...L.bullets([
  '**Open any sheet** in your department and work it exactly as its teacher would — generate slots, block or delete a time, lock the schedule, mark attended or no-show, cancel a booking, print the sheet or export it. Useful when a colleague is away or new.',
  '**Export CSV** on the department page gives you every appointment in the department in one file, with the teacher\'s name on each row.',
  '**Print** any teacher\'s sheet from the list, without opening it.',
]));
c.push(L.h2('What you cannot do'));
c.push(...L.bullets([
  'Reach another department, or the other campus.',
  'Create events, change who is in your department, or import staff. Those stay with the office — ask them.',
  'Move a whole evening to another date. The office does that, and the parents are told automatically.',
]));
c.push(L.note('Which sheets count as yours',
  'A schedule is in your department when it was set up under your department, or when the teacher who owns it belongs to it. If a sheet you expect is missing, the teacher is probably recorded under a different department — the office can fix that in a minute.'));

c.push(L.p('', { after: 200 }));
c.push(L.p('Anything not covered here — contact the IT office.', { color: L.MUTED }));

L.build(c, { file: require('path').join(__dirname, 'out', 'ACA-Appointments-Teacher-Guide.docx'), titleText: 'Teacher Guide — Appointments' })
  .then((f) => console.log('wrote', f));
