'use strict';
/**
 * Parent guide - English and Arabic side by side, with the screens a parent
 * actually sees. Built from the seeded demo, so names are invented.
 */
const L = require('./lib');

const c = [];

c.push(...L.title('American Creativity Academy', 'Booking an Appointment',
  'A step-by-step guide for parents', 'دليل خطوة بخطوة لأولياء الأمور'));

c.push(L.bilingual(
  ['How it works',
   'The school books parent–teacher conferences, uniform fittings and registration appointments online. You do not need an account or a password — just the link the school sends you.',
   'If you have more than one child at the school, you can book for all of them in one visit.'],
  ['كيف يعمل النظام',
   'تحجز المدرسة مواعيد لقاءات أولياء الأمور مع المعلّمين، وقياس الزي المدرسي، ومواعيد التسجيل عبر الإنترنت. لا تحتاج إلى حساب أو كلمة مرور — يكفي الرابط الذي ترسله المدرسة.',
   'وإذا كان لديك أكثر من طفل في المدرسة، يمكنك الحجز لهم جميعاً في زيارة واحدة.'],
  { fill: 'FFFFFF' }
));

c.push(L.h1('Before you start'));
c.push(L.bilingual(
  ['Have these ready',
   "Each child's full name and grade.",
   'Your email address — the confirmation and the cancellation link are sent there.',
   'Your mobile number — you also receive a WhatsApp message. Kuwaiti numbers can be typed without the country code.'],
  ['جهّز ما يلي',
   'الاسم الكامل لكل طفل والصف الدراسي.',
   'بريدك الإلكتروني — يُرسل إليه التأكيد ورابط الإلغاء.',
   'رقم هاتفك المحمول — ستصلك رسالة واتساب أيضاً. يمكن كتابة الأرقام الكويتية بدون رمز الدولة.']
));

c.push(L.h1('Booking, step by step'));

/* ---- 1 ---- */
c.push(L.bilingual(
  ['1 · Open the booking page',
   'Go to **appointments.aca.edu.kw** and choose your campus — ACA Hawally or ACA Salmiya.',
   'Each campus lists what is open right now. An event marked **Open now** can be booked; one marked **Opens …** shows the date sign-ups begin.'],
  ['١ · افتح صفحة الحجز',
   'ادخل إلى **appointments.aca.edu.kw** واختر الحرم المدرسي — حولي أو السالمية.',
   'يعرض كل حرم ما هو متاح الآن. الفعالية التي تحمل علامة «Open now» يمكن الحجز فيها، أما «Opens …» فتوضّح تاريخ بدء التسجيل.']
));
c.push(...L.shot('p01-home.png', 'The front page lists each campus and what is open.', { arCaption: 'الصفحة الرئيسية تعرض كل حرم وما هو متاح.', maxWidth: 560 }));

/* ---- 2 ---- */
c.push(L.bilingual(
  ['2 · Choose the department, then find the teacher',
   'For a parent–teacher conference you pick a **department** first (for example Elementary — English), then the teacher, then your child\'s class.',
   'A department with many teachers has a **search box**. Type the teacher\'s name, or the class — “Grade 5A” works if you know the class but not the teacher. The list narrows as you type. Arabic names can be typed too.',
   'For uniform fitting or registration you go straight to the counter list.'],
  ['٢ · اختر القسم ثم ابحث عن المعلّم',
   'في لقاءات أولياء الأمور، اختر «القسم» أولاً (مثل: الابتدائي — اللغة الإنجليزية)، ثم المعلّم، ثم صف طفلك.',
   'القسم الذي يضم معلّمين كثيرين فيه **مربّع بحث**. اكتب اسم المعلّم أو الصف — «Grade 5A» يكفي إن كنت تعرف الصف دون المعلّم. تضيق القائمة أثناء الكتابة. ويمكن كتابة الأسماء بالعربية أيضاً.',
   'أما لقياس الزي المدرسي أو التسجيل، فستنتقل مباشرة إلى قائمة المكاتب.']
));
c.push(...L.shot('p03-department-search.png', 'Typing “Sara” leaves only that teacher on the page.', { arCaption: 'كتابة «Sara» تُبقي تلك المعلّمة وحدها في الصفحة.' }));

/* ---- 3 ---- */
c.push(L.bilingual(
  ['3 · Say who the appointment is for',
   'The first time you pick a time, you are asked **which child it is for** — their full name and grade. You only do this once per child.',
   'If you have one child, that is all. If you have more, you add the next child when you get to their teacher.'],
  ['٣ · حدّد لمن هذا الموعد',
   'عند اختيار أول وقت، سيُطلب منك تحديد **الطفل الذي يخصّه الموعد** — الاسم الكامل والصف. تفعل ذلك مرة واحدة فقط لكل طفل.',
   'إن كان لديك طفل واحد فهذا كل شيء. وإن كان لديك أكثر، فستضيف الطفل التالي عند الوصول إلى معلّمه.']
));
c.push(...L.shot('p04-who-is-this-for.png', 'Asked once, the first time you pick a time.', { arCaption: 'يُسأل مرة واحدة عند اختيار أول وقت.', maxWidth: 520 }));

/* ---- 4 ---- */
c.push(L.bilingual(
  ['4 · Pick a time',
   'Times are shown by day. Tap a time to select it — it turns dark blue and says **✓ selected**.',
   'A time with a line through it is already taken by another family. A time shown in **red** is one you already hold with another teacher — you cannot be in two rooms at once.',
   'The bar at the top says which child you are choosing for. **Another child** switches to the next one.'],
  ['٤ · اختر الوقت',
   'تُعرض المواعيد حسب اليوم. اضغط على الوقت لاختياره — سيتحوّل إلى اللون الأزرق الداكن مع علامة «✓ selected».',
   'الوقت المشطوب يعني أنّ عائلة أخرى قد حجزته. والوقت الظاهر **بالأحمر** هو وقت تحمله بالفعل مع معلّم آخر — فلا يمكنك أن تكون في قاعتين في الوقت نفسه.',
   'الشريط في الأعلى يوضّح الطفل الذي تختار له. وزر «Another child» ينقلك إلى الطفل التالي.']
));
c.push(...L.shot('p05a-pick-a-time.png', 'One time selected for Ahmed. The bar shows who you are choosing for.', { arCaption: 'وقت واحد مختار لأحمد. الشريط يوضّح لمن تختار.' }));
c.push(...L.shot('p05b-selected-bar.png', 'The bar at the bottom follows you: add another teacher, or go to review.', { arCaption: 'الشريط السفلي يرافقك: أضف معلّماً آخر أو انتقل إلى المراجعة.', maxWidth: 520 }));

/* ---- 5 ---- */
c.push(L.bilingual(
  ['5 · Add the next child, and more teachers',
   'Press **Another child**, enter the next name and grade, and carry on picking times. Everything you choose is held together until you confirm.',
   'To come back to the first child, press **Switch child** and tick their name.',
   'Where the school has enabled it, **Compare selected schedules** puts several teachers on one grid so you can line up an evening without gaps.'],
  ['٥ · أضف الطفل التالي ومعلّمين آخرين',
   'اضغط «Another child»، وأدخل الاسم والصف التاليين، وتابع اختيار الأوقات. تبقى جميع اختياراتك محفوظة معاً حتى تؤكّدها.',
   'وللعودة إلى الطفل الأول، اضغط «Switch child» وحدّد اسمه.',
   'وعند تفعيل المدرسة لهذه الميزة، يعرض «Compare selected schedules» عدة معلّمين في جدول واحد لتنظيم أوقاتك في الأمسية دون فجوات.']
));
c.push(...L.shot('p06-switch-child.png', 'Children you have named are listed; tick one, or add another.', { arCaption: 'الأطفال الذين سمّيتهم مدرجون؛ حدّد أحدهم أو أضف آخر.', maxWidth: 500 }));

/* ---- 6 ---- */
c.push(L.bilingual(
  ['6 · Review and confirm',
   'Choose **Review & confirm**. Your times are grouped by child. If one is under the wrong name, use the **For** box beside it to move it.',
   'Enter your name, email and mobile **once** — they cover every appointment. You may add a note saying what you would like to discuss; the teacher sees it before the meeting.',
   'Press **Confirm**. That is the moment the times are reserved for you.'],
  ['٦ · راجع وأكّد',
   'اضغط «Review & confirm». تُجمَّع أوقاتك حسب الطفل. وإذا ظهر وقت تحت الاسم الخطأ، استخدم مربّع «For» المجاور له لنقله.',
   'أدخل اسمك وبريدك ورقم هاتفك **مرة واحدة** — فهي تشمل جميع المواعيد. ويمكنك إضافة ملاحظة بما ترغب في مناقشته؛ سيطّلع عليها المعلّم قبل اللقاء.',
   'اضغط «Confirm». عند هذه اللحظة تُحجز المواعيد باسمك.']
));
c.push(...L.shot('p07-review.png', 'Two children, one form, one confirm.', { arCaption: 'طفلان، نموذج واحد، تأكيد واحد.' }));

c.push(L.h1('After you book'));

c.push(L.bilingual(
  ['Your confirmation',
   'You receive an **email for each appointment** and **one WhatsApp message** listing them all, with the child\'s name, date, time, teacher and room.',
   'Each email contains a private link. **Keep it** — it is how you view or cancel that appointment. You can also add the appointment to your phone\'s calendar from that page.'],
  ['رسالة التأكيد',
   'ستصلك **رسالة بريد إلكتروني لكل موعد** و**رسالة واتساب واحدة** تضمّها جميعاً، مع اسم الطفل والتاريخ والوقت واسم المعلّم والقاعة.',
   'تحتوي كل رسالة بريد على رابط خاص بك. **احتفظ به** — فهو وسيلتك لعرض الموعد أو إلغائه. ويمكنك أيضاً إضافة الموعد إلى تقويم هاتفك من تلك الصفحة.']
));
c.push(...L.shot('p08-confirmation.png', 'The confirmation page, grouped by child, with a link for each appointment.', { arCaption: 'صفحة التأكيد، مجمّعة حسب الطفل، مع رابط لكل موعد.', maxWidth: 470 }));

c.push(L.bilingual(
  ['Changing or cancelling',
   'Open the link in your confirmation and choose **Cancel appointment**. The time is released immediately for another family.',
   'To move to a different time, cancel first and then book the new one.',
   'Cancellation closes shortly before the appointment — after that, please call the school office.'],
  ['التعديل أو الإلغاء',
   'افتح الرابط الموجود في رسالة التأكيد واختر «Cancel appointment». يُتاح الوقت فوراً لعائلة أخرى.',
   'للانتقال إلى وقت آخر، ألغِ الموعد أولاً ثم احجز الموعد الجديد.',
   'يُغلق الإلغاء قبل الموعد بفترة قصيرة — بعدها يُرجى الاتصال بمكتب المدرسة.']
));
c.push(...L.shot('p09-manage.png', 'The private page for one appointment.', { arCaption: 'الصفحة الخاصة بموعد واحد.', maxWidth: 480 }));

c.push(L.bilingual(
  ['If the school moves your time',
   'Occasionally a teacher\'s evening has to move. You will get an email showing the **old time crossed out and the new one below it**. You do not need to book again. Your original link still works and shows the new time; if it no longer suits you, cancel from there and pick another.'],
  ['إذا غيّرت المدرسة موعدك',
   'قد تضطر المدرسة أحياناً إلى تغيير أمسية معلّم. ستصلك رسالة بريد تُظهر **الوقت القديم مشطوباً والوقت الجديد تحته**. لا تحتاج إلى الحجز من جديد. رابطك الأصلي ما زال يعمل ويعرض الوقت الجديد؛ وإن لم يناسبك، ألغِ من هناك واختر وقتاً آخر.']
));

c.push(L.bilingual(
  ['Lost the confirmation?',
   'Choose **My appointments** at the top of the page, enter the email address you booked with, and every appointment — for every child — appears with its link.'],
  ['فقدت رسالة التأكيد؟',
   'اختر «My appointments» أعلى الصفحة، وأدخل البريد الإلكتروني الذي حجزت به، فتظهر جميع مواعيدك — لجميع أطفالك — مع روابطها.']
));
c.push(...L.shot('p10-lookup.png', 'Everything booked with one email address, in one place.', { arCaption: 'كل ما حُجز ببريد إلكتروني واحد، في مكان واحد.' }));

c.push(L.h1('Rules worth knowing'));
c.push(L.table(['What you may notice', 'Why'], [
  ['You cannot book the same teacher twice for one child', 'One meeting per teacher per child, so every family gets a turn. Two children who share a teacher can each have a time.'],
  ['Two appointments at the same clock time are refused', 'You cannot be in two rooms at once — even if they are for different children. Pick a different time for one of them.'],
  ['A limit on how many appointments you can book', 'Some events cap the number per child so slots are shared fairly.'],
  ['A time disappears while you are choosing', 'Another family confirmed it first. Slots are only held once you press Confirm.'],
  ['A teacher shows “Sign-ups closed”', 'That teacher has closed their list. Existing bookings are unaffected.'],
], [3600, 6038]));

c.push(L.p('', { after: 60 }));
c.push(L.note('On the day',
  'Arrive a few minutes early, bring your civil ID if the campus asks for it at the gate, and note that meetings are short — often ten minutes — so the schedule stays on time for everyone.',
  { arTitle: 'في يوم الموعد', arBody: 'احضر قبل الموعد بدقائق، وأحضر بطاقتك المدنية إن طلبها الحرم عند البوابة، وتذكّر أن اللقاءات قصيرة — عشر دقائق غالباً — حتى يبقى الجدول في وقته للجميع.' }));

c.push(L.h1('If something goes wrong'));
c.push(...L.bullets([
  '**No confirmation arrived** — check your junk or spam folder first, then use **My appointments** to confirm the booking exists.',
  '**The link says the appointment was not found** — the link may have been cut short by your email app. Use **My appointments** instead.',
  '**No times are shown** — that teacher may be fully booked, or sign-ups have not opened yet. Try another class, or check the opening date on the event page.',
  '**A time is red and will not select** — you already hold that clock time with another teacher. Choose a different one, or remove the first from the review page.',
  '**Anything else** — contact the school office; they can see and change every booking.',
]));

c.push(L.bilingual(
  ['Questions?',
   'Contact the school office — they can view, move or cancel any appointment for you.'],
  ['هل لديك استفسار؟',
   'تواصل مع مكتب المدرسة — بإمكانهم عرض أي موعد أو تعديله أو إلغاؤه نيابةً عنك.'],
  { fill: 'FFFFFF' }
));

L.build(c, { file: require('path').join(__dirname, 'out', 'ACA-Appointments-Parent-Guide.docx'), titleText: 'Booking an Appointment — Parent Guide' })
  .then((f) => console.log('wrote', f));
