# IIE Full-Stack Educational Management Platform — Architecture Showcase

---

## Project Scale at a Glance

| Metric | Value |
|---|---|
| Total user-facing portals / HTML pages | **41 pages** |
| Google Cloud Functions (exported) | **47 functions** |
| Firestore top-level collections | **92 collections** |
| Firestore composite indexes | **14** |
| Storage security rule path matchers | **15** |
| Firestore rule helper/validator functions | **30+** |
| Total Firestore security rules | ~2,500 lines |
| Total backend (functions/index.js) | ~5,200 lines |
| User roles supported | **9 distinct roles** |
| Email types sent automatically | **12+** |
| FCM push notification triggers | **3** |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Hosting & CDN | Firebase Hosting (HSTS, CSP, cleanUrls, security headers) |
| Database | Cloud Firestore (NoSQL, real-time, offline-capable) |
| File Storage | Firebase Cloud Storage |
| Authentication | Firebase Authentication (email/password + email verification) |
| Backend | Google Cloud Functions v5, **Node.js 22, ESM** |
| Push Notifications | **Firebase Cloud Messaging (FCM)** — `sendEachForMulticast` with stale-token cleanup |
| Search | **Algolia** — real-time library book search indexing via `onWrite` trigger |
| Email Transport | **Nodemailer + Gmail** (two separate Gmail accounts: main + library) |
| Image Processing | **`sharp`** — WebP thumbnail generation, SVG→JPEG OG image rasterization |
| QR Codes | **`qrcode`** — event pass generation, embedded as CID inline image in email |
| Scheduled Jobs | **Cloud Scheduler** (pub/sub) — 3 scheduled functions |
| Progressive Web App | Service Worker + Web App Manifest + FCM background SW |
| Secrets Management | **GCP Secret Manager** (`defineSecret`) — all credentials fetched at runtime |
| Security | CSP, HSTS, X-Frame-Options headers; server-side JWT verification; Fisher-Yates secure passwords |

---

## User Roles & Portals (9 Roles)

| Role | Portal File | Key Capabilities |
|---|---|---|
| **Admin** | `admin.html` (874 KB) | Full system control, user management, overrides, broadcasts, exams, inventory |
| **Teacher** | `teacher.html` (506 KB) + `teacher-portal.html` | Attendance, monthly reports, leave requests, student groups, exams |
| **Instructor** | `instructor.html` (816 KB) | Course creation, content management, student progress tracking |
| **Student** | `student.html` (114 KB) + `student-login.html` | Programs, library, courses, exams, profile, notifications |
| **Finance** | `finance.html` (539 KB) + `fee-management.html` | Payments, fee ledger, payment proof review |
| **Program Organizer** | `program-organizer.html` (183 KB) | Events, registrations, waitlists, announcements, writings |
| **Volunteer** | `volunteer.html` (69 KB) | Tasks, feedback, availability, star card leaderboard |
| **Driver** | `driver-portal.html` (39 KB) | Route sessions, carpool, lost & found, transport requests |
| **Library Admin** | `library-admin.html` (109 KB) | Book catalog, Algolia reindex, reservations, loans, checkout, returns |

---

## All Feature Modules (41 Pages)

### 🌐 Public Website
| Page | Purpose |
|---|---|
| `index.html` | Homepage: instructors, testimonials, programs, gallery, newsletter signup, appointment booking |
| `login.html` | Multi-role login (username resolution via Cloud Function) |
| `student-login.html` | Student-specific login portal |
| `forgot-password.html` | Password reset initiation |
| `reset-password.html` | Password reset confirmation |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of service |
| `sitemap.html` | Site map / navigation |
| `404.html` | Custom error page |

### 👤 Profiles
| Page | Purpose |
|---|---|
| `profile.html` | Staff/admin profile |
| `student-profile.html` | Student self-service profile editing |
| `teacher-profile.html` | Teacher profile |
| `recommendation.html` | Recommendations management |

### 🎓 Programs & Events
| Page | Purpose |
|---|---|
| `institute-programs.html` | Student-facing program listing and registration |
| `program-organizer.html` | Organizer dashboard: event lifecycle, registrations, waitlists, announcements |
| `checkin.html` | QR-code event check-in scanner portal (134 KB) |

### 📚 Library System
| Page | Purpose |
|---|---|
| `library.html` | Student library: Algolia search, book details, reservation, loan tracking |
| `library-admin.html` | Librarian admin: catalog, reservations, checkout, loans, returns, Algolia reindex |

### 📝 Exams & Courses
| Page | Purpose |
|---|---|
| `exams.html` | Student exam-taking interface (198 KB) |
| `teacher-exams.html` | Teacher exam creation and marking |
| `admin-exams.html` | Admin exam management |
| `student-courses.html` | Student course listing |
| `student-course-player.html` | Course content player |
| `admin-courses.html` | Admin course management |
| `course-details.html` | Course detail view |

### 💰 Finance
| Page | Purpose |
|---|---|
| `finance.html` | Finance staff dashboard: ledger, payment history |
| `fee-management.html` | Student fee assignment and tracking |

### 🏫 Administration
| Page | Purpose |
|---|---|
| `admin.html` | Super admin portal: users, exams, attendance overrides, broadcasts, star cards |
| `teacher-accounts-admin.html` | Teacher account management |
| `institute-students.html` | Physical institute student roster (form-teacher scoped) |
| `inventory.html` | Inventory item tracking |
| `thamara.html` | Star Card / reward point system |
| `notifications.html` | Notification center |

### 🚗 Community & Transport
| Page | Purpose |
|---|---|
| `driver-portal.html` | Route sessions, carpool, lost & found, transport requests |
| `volunteer.html` | Volunteer tasks, feedback, availability |
| `volunteer-feedback.html` | Volunteer feedback collection |

### ✍️ Writings
| Page | Purpose |
|---|---|
| `writing-reader.html` | Student blog/article reader |
| `track.html` | Library loan tracking by tracking ID |

---

## Messaging System — Emails, FCM & In-App Notifications

### 📧 Email System (Nodemailer + Gmail, 2 accounts)

**Main account** (`GMAIL_EMAIL` secret) — for all student/staff communications:

| Trigger | Subject | Recipients |
|---|---|---|
| Student profile creation | `Welcome to [Institute]!` | New student |
| Student profile approved | `Your Student Account is Approved! 🎉` | Student |
| Program registration approved | `✅ Registration Approved – [Program Name]` | Student |
| Add-on registration approved | `✅ Add-on Registration Approved – [Name]` | Parent student |
| Event pass ready (48h before event) | `🎫 Your Event Pass is Ready – [Program]` | Student |
| Add-on event pass ready | `🎫 Add-on Event Pass Ready – [Name]` | Parent student |
| New program published | `New Program Announced: [Title]! 🎉` | All students |
| Newsletter welcome (Al-Tarbiyah) | `✨ Welcome to Al-Tarbiyah – [Institute]` | Subscriber |
| Incomplete profile reminder | `Action Required: Complete Your Student Profile` | Pending students |
| Teacher password reset | Contains new generated password | Admin-only output |

**Library account** (`LIBRARY_GMAIL_EMAIL` secret) — for library-specific communications:

| Trigger | Subject | Recipients |
|---|---|---|
| Book reservation request created | `Reservation Received - IIE Library` | Borrower + **admin** |
| Book reservation rejected | `Reservation Request Update - IIE Library` | Borrower |
| Book loan checkout | Loan confirmation with due date | Borrower |

### 📱 FCM Push Notifications (Firebase Cloud Messaging)

| Trigger Function | When it fires | Audience |
|---|---|---|
| `onNewAnnouncement` | New doc in `announcements/` | All students, or filtered by status/gender/UIDs |
| `onNewStudentNotification` | New doc in `student_notifications/` | Single specific student |
| `onProgramPublished` | `programs/{id}` visibility → `Published` | All enrolled students |

**FCM Details:**
- Uses `sendEachForMulticast` in chunks of 500 tokens
- Supports both `fcmToken` (legacy single) and `fcmTokens[]` (multi-device) per student
- Gender filtering: `audienceGenders` field on announcement document
- Status filtering: all students / verified / pending / waitlisted
- **Automatic stale token cleanup**: invalid/unregistered tokens removed from Firestore after each broadcast
- Android: `priority: 'high'`, custom `channelId`, sound, `PRIORITY_HIGH`
- Web: `requireInteraction: true`, `renotify: true`, custom `vibrate` pattern, badge icon

### 🔔 In-App Notifications (Firestore subcollection)

Written to `students/{uid}/notifications/{notifId}` for:
- Registration approved
- Add-on approved
- Event pass ready
- New program published
- Admin broadcast

---

## Roll Number & QR Code System

### Roll Number Format
```
{PREFIX}{PROGRAM_CODE}{SEQUENCE}       → e.g., IIECOURSE001
{PREFIX}{PROGRAM_CODE}{SEQUENCE}-AO   → e.g., IIECOURSE001-AO  (add-on)
```

- `PREFIX` = `IIE` (added if program code doesn't already start with `IIE`)
- `PROGRAM_CODE` = alphanumeric, max 12 chars, uppercase
- `SEQUENCE` = 3-digit zero-padded (padStart 3, '0')
- `-AO` suffix = add-on registration

### Roll Number Assignment Flow
1. **Firestore transaction** reads `programs/{id}.nextRollNumber` counter
2. Increments atomically → prevents race conditions
3. Formats string → stores back to registration document
4. Triggers QR code generation immediately after transaction

### QR Code Generation
```js
QRCode.toDataURL(JSON.stringify({
  t: 'event-pass',
  programId,
  registrationId,
  studentUid,
  rollNumber,
  ts: Date.now()
}), { errorCorrectionLevel: 'M', margin: 1, scale: 4 })
```
- Stored as `data:image/png;base64,...` on the registration document
- Embedded as **CID inline attachment** in email (no external URL needed)
- Downloaded and displayed in Student Portal (`student.html`)
- Scanned at event check-in via `checkin.html`

### Enrollment ID Format
```
IIE-{MM}-{YY}-R-{COUNT}   →   e.g., IIE-08-26-R-42
```
- Generated via Firestore transaction on `metadata/enrollmentCounter`
- Sequential, globally unique, assigned on profile approval

### Library Tracking ID Format
```
IIEZL{NAME3}{MONTH2}{RANDOM3}   →   e.g., IIEZLMOH08A3F
```
- `NAME3` = first 3 letters of borrower name, uppercase
- `MONTH2` = 2-digit month
- `RANDOM3` = `crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase()`

---

## Event Pass Email Design

HTML emails are generated server-side with:
- **SVG-composed OG images** (1200×630 px) rasterized to JPEG via `sharp`
- Responsive table-based layout (email client compatible)
- Arabic greeting (`السَّلَامُ عَلَيْكُمْ`) with right-to-left rendering
- QR code embedded as CID inline (`cid:eventqr`) — no broken images in email clients
- Pass card with: Roll Number (monospace, large), Date, Time, Venue, Fee
- Walk-in variant (no student portal CTA)
- Add-on variant (purple accent, add-on note)
- Approval-only variant (pass not shown until 48h before event)

---

## Cloud Functions — All 47 (Complete List)

### 🌐 HTTPS HTTP Endpoints
| Function | Auth | Purpose |
|---|---|---|
| `writingShare` | None | Server-side OG meta tags + JS redirect for social bots |
| `ogWritingImage` | None | SVG→JPEG 1200×630 OG image for writing share pages |
| `sponsorShare` | None | Server-side OG meta tags for sponsorship pages |
| `ogSponsorImage` | None | SVG→JPEG OG image for sponsor share pages |
| `resolveUsernameToEmail` | None (CORS) | Username/ID → email lookup with legacy schema self-healing |
| `createStudentProfile` | Bearer JWT | Student signup, referral, enrollment ID, welcome email |
| `updateStudentContact` | Bearer JWT | Contact update with history archiving + auto-approve |
| `recomputeRollNumbersForProgram` | Bearer JWT (Admin) | Batch roll number + QR regeneration for a program |
| `importProgramRegistrations` | Bearer JWT (Admin/Organizer) | Bulk CSV import of registrations |
| `migrateStripEmailsFromUsernames` | Bearer JWT (Admin) | One-time data migration |
| `backfillRecalculateWaitlists` | Bearer JWT (Admin) | Recalculate all waitlist flags + registeredCount |
| `newsletterUnsubscribe` | Query param email | One-click unsubscribe with styled confirmation page |

### 📞 Callable Functions (Firebase SDK)
| Function | Permission | Purpose |
|---|---|---|
| `adminResetTeacherPassword` | Admin only | Password reset with cryptographically secure generation |
| `reindexAllLibraryBooks` | Admin / Library Manager | Bulk Algolia reindex |
| `reservePhysicalBook` | Student | Atomic book reservation (Firestore transaction, stock check) |
| `cancelPhysicalReservation` | Student (own) / Library Manager | Cancel reservation + decrement counter |
| `requestPhysicalBook` | Student | Join waitlist when all copies are out |
| `checkoutPhysicalReservation` | Library Manager | Convert reservation/request → active loan + email |
| `returnPhysicalLoan` | Library Manager | Mark loan returned, decrement activeLoans |
| `requestReturnLoan` | Student (self) | Self-service return request |
| `claimStudentId` | Student | Claim a student ID mapping |
| `trackLibraryRequest` | Public | Track reservation/loan by tracking ID |
| `respondToLibraryRequest` | Borrower | Submit response to librarian's message |
| `generateEventPass` | Student (own) | On-demand QR pass generation (enforces 48h release window) |
| `generateAddonEventPass` | Student (via parent) | Same for add-on pass |
| `backfillRecalculateWaitlists` | Admin | Callable version of waitlist recalculation |
| `importProgramRegistrationsCallable` | Admin / Organizer | Callable bulk registration import |
| `syncBookPendingStatus` | System | Sync book pending request counter |
| `notifyReservationRejection` | N/A (callable) | Trigger rejection notification |
| `notifyReservationRequest` | N/A (callable) | Trigger reservation confirmation |
| `adminBroadcastNotification` | Admin | FCM push to all users or specific user |

### 🔥 Firestore Triggers
| Function | Collection/Document | Event | Purpose |
|---|---|---|---|
| `generateProgramCoverThumbOnWrite` | `programs/{id}` | onWrite | Auto-generate WebP thumbnail via sharp, write URL back |
| `indexLibraryBookOnWrite` | `libraryBooks/{id}` | onWrite | Sync to Algolia index (upsert or delete) |
| `maintainLibraryActiveReservations` | `libraryReservations/{id}` | onWrite | Keep `activeReservations` counter in sync via delta |
| `onProgramRegistrationCreate` | `programs/{id}/registrations/{id}` | onCreate | Capacity check, waitlist/reject, roll number + QR assignment |
| `onProgramAddonRegistrationCreate` | `programs/{id}/addon_registrations/{id}` | onCreate | Same for add-on registrations |
| `onProgramRegistrationUpdate` | `programs/{id}/registrations/{id}` | onUpdate | Approve → roll number, QR, approval email, in-app notification |
| `onProgramAddonRegistrationUpdate` | `programs/{id}/addon_registrations/{id}` | onUpdate | Same for add-ons |
| `generateEventPass` | `programs/{id}/registrations/{id}` | onUpdate | Fallback pass generation callable |
| `generateAddonEventPass` | `programs/{id}/addon_registrations/{id}` | onUpdate | Fallback add-on pass callable |
| `onProgramRegistrationDelete` | `programs/{id}/registrations/{id}` | onDelete | Decrement count + promote next waitlisted student |
| `onProgramAddonRegistrationDelete` | `programs/{id}/addon_registrations/{id}` | onDelete | Same for add-ons |
| `syncBookPendingStatus` | `libraryReservationRequests/{id}` | onWrite | Sync `pendingRequestCount` on book document |
| `notifyReservationRejection` | `libraryReservationRequests/{id}` | onUpdate | Send rejection email when status → rejected |
| `notifyReservationRequest` | `libraryReservationRequests/{id}` | onCreate | Generate `IIEZL` tracking ID, send email to borrower + admin |
| `onNewsletterSubscriberCreate` | `newsletterSubscribers/{id}` | onCreate | Send styled Al-Tarbiyah welcome email with feature cards |
| `onNewAnnouncement` | `announcements/{id}` | onCreate | FCM push to students with audience filtering + stale token cleanup |
| `onNewStudentNotification` | `student_notifications/{id}` | onCreate | FCM push to a single student's devices |
| `onStudentProfileApproved` | `students/{id}` | onUpdate | Generate enrollment ID (Firestore transaction), send approval email |
| `onProgramPublished` | `programs/{id}` | onWrite | Notify all students via email + in-app + FCM when program goes live |

### ⏰ Scheduled Functions (Cloud Scheduler)
| Function | Schedule | Timezone | Purpose |
|---|---|---|---|
| `deleteStaleUnverifiedUsers` | Every 15 minutes | UTC | Delete unverified Auth accounts >30 min old with no Firestore profile |
| `sendIncompleteProfileReminders` | Every 24 hours | UTC | Email students with `status=Pending` profiles aged 48–72 hours |
| `releaseEventPassesHourly` | Every 60 minutes | Asia/Kolkata | Send QR pass emails for events starting within 48h (rate-limited 3 concurrent) |

---

## Waitlist System

- **Capacity enforcement**: registration count checked atomically in Firestore transaction
- **FIFO promotion**: on cancellation/rejection, `promoteNextWaitlistedStudent()` queries the oldest waitlisted registration across both primary and add-on collections and promotes automatically
- **Backfill endpoint**: `backfillRecalculateWaitlists` re-evaluates all registrations for all programs by `createdAt` order

---

## Security Architecture

### Firestore Security Rules (2,500+ lines, 30+ helpers)
- **Multi-role RBAC**: `role` (primary string) + `roles[]` (list, multi-role support)
- **30+ helper predicates**: `isEmail`, `isPhoneDigits`, `isIsoDateYmd`, `isTimeHm`, `nowIst()`, `isWithinFirst5DaysIst()`, `hasRole`, `hasAnyRole`, `hasActiveDelegation`, `assistantHasPermFor`
- **Time-windowed writes**: monthly submissions locked to days 1–5 IST; 24-hour admin override stored on user profile document
- **Write-once with override**: teacher attendance records (admin grants per-date time-limited override)
- **Atomic payload validation**: attendance records (leave↔present↔class times mutual exclusivity enforced in rules)
- **Self-service whitelisted profile editing**: `changedKeys().hasOnly([...])`, 30-day username lock, reserved-word list, regex validation
- **Cross-document reads**: assistant permission lookup, form-teacher group check
- **Time-limited delegation**: `tempPermissions.expiresAt` timestamp checked in rules

### Storage Rules (15 path matchers)
- **Cross-service Firestore lookups**: `firestore.get(...)` reads user roles from Firestore directly in Storage rules
- **Owner isolation**: `request.auth.uid == userUid` enforced per path
- **Content-type + size**: every writable path constrains `contentType` and `size` with extension fallback
- **Form-teacher scoping**: institute student photos restricted to assigned form teacher by `farmTeacherGroup` field match

### Application Security (Cloud Functions)
- **GCP Secret Manager**: `defineSecret(...)` for all credentials (Gmail passwords, Algolia keys); never hardcoded
- **JWT verification**: `admin.auth().verifyIdToken(...)` on every protected HTTP endpoint
- **Double role check**: role re-verified server-side even if client claims a role
- **CORS allowlist**: explicit origin allowlist + localhost passthrough for development
- **Secure passwords**: `crypto.randomInt` + Fisher-Yates shuffle for teacher password generation
- **XSS prevention**: `escapeHtml()` / `escapeXml()` applied to all dynamic output in email HTML and OG images
- **Idempotency guards**: `approvalEmailSent`, `passEmailSent`, `counted` flags prevent duplicate emails/operations

### Firebase Hosting Security Headers
```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: [configured per page type]
```

---

## Database Design — 92 Firestore Collections

**Auth & Users**: `users`, `students`, `usernames`, `studentIds`, `assistants`, `assistants_by_user`

**Programs & Events**: `programs`, `registrations`, `addon_registrations`, `enrollments`, `referralLeaderboard`

**Library**: `libraryBooks`, `libraryReservations`, `libraryReservationRequests`, `libraryLoans`, `libraryCategories`, `libraryFeedback`, `libraryPageVisits`, `libraryReturnReports`, `libraryBookPrivate`, `libraryBookAdminNotes`, `newsletterSubscribers`, `sponsorshipOpportunities`, `sponsorshipRequests`, `sponsorshipIntents`

**Attendance & Academic**: `teacher_attendance`, `form_teacher_attendance`, `form_teacher_student_attendance`, `attendance`, `weeklyGroupReports`, `months`, `holidays`, `calendarDays`

**Exams**: `exams`, `exam_submissions`, `exam_attempts_meta`, `exam_feedback`, `exam_reattempt_grants`, `reattempt_claims`, `term_exams`, `term_exam_submissions`, `term_exam_publish_status`

**Courses**: `courses`, `instructorCourses`, `sessions`

**Finance**: `finance`, `finance_records`, `finance_archive`, `fee_payments`, `payment_proofs`, `student_fees`, `donation_requests`

**Communications**: `notifications`, `sent_notifications`, `admin_broadcasts`, `announcements`, `notices`, `feedback`, `feedbackEvents`, `student_notifications`

**Community & Transport**: `communityCarpoolPosts`, `communityLostFoundPosts`, `communitySuggestions`, `communityTransportRequests`, `rideshares`, `routeSessions`, `meetings`

**Institute Management**: `instituteStudents`, `groups`, `student_groups`, `inventoryItems`, `items`, `certificates`, `tasks`

**Public Site**: `instructors`, `student_testimonials`, `appointment_requests`, `gallery`, `settings`, `systemSettings`

**Rewards & Analytics**: `starCards`, `starCardHistory`, `page_analytics`, `audit_logs`, `performance`

**Writings**: `writings`, `writing_engagement`

**Other**: `programmeFeedback`, `volunteerFeedback`, `forum`, `teacherNotes`

---

## Progressive Web App (PWA)

| File | Purpose |
|---|---|
| `sw.js` | Service worker — offline caching, background sync |
| `firebase-messaging-sw.js` | FCM background message handler |
| `manifest.webmanifest` | App manifest — installable on Android/iOS |
| `pwa.js` | Install prompt, update detection, push subscription registration |
| `student-core.js` | Shared student portal logic, FCM token registration |
| `exams-engine.js` | Full offline-capable exam engine (104 KB) |

---

## Files in This Showcase Repository

| File | Lines | What it demonstrates |
|---|---|---|
| `firestore.rules` | 2,523 | Full production RBAC security model |
| `storage.rules` | 352 | Storage security with cross-service Firestore lookups |
| `functions/index.js` | 5,175 | All 47 Cloud Functions (sanitized) |
| `functions/package.json` | 19 | Backend dependency manifest |
| `README.md` | This file | Complete architecture documentation |

> **Sanitization**: All sensitive values replaced with `[YOUR_XXX_HERE]` placeholders.
> A Python leak-detection script was run after sanitization and confirmed zero sensitive patterns remain.
