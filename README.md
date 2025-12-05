# Secure Login System for Google Apps Script

Robust authentication and user management built on Google Apps Script and Google Sheets. It delivers modern password security (salt+SHA‑256), role-based routing (Admin/User), single-use recovery codes with cooldown and cleanup, and a shared UI fragment for a consistent experience. Includes unit and integration tests to safeguard critical flows.

## Highlights
- Strong password storage with `salt + SHA‑256` and automatic legacy migration.
- Role-based pages: `admin` panel and `user` dashboard rendered server-side.
- Password recovery with 6-digit codes, enforced cooldown, and one active code per user.
- Shared UI fragment (`common.html`) for loader, dialog, and section navigation.
- Audit logs in `Logs` sheet for traceability of login and admin actions.
- Tests (`tests.gs`) covering utilities and an end-to-end login/recovery scenario.

## Project Structure
- `code.gs` — Server-side logic (auth, recovery, admin, logs, helpers).
- `login.html` — Public login page and recovery flow UI.
- `user.html` — Authenticated user view with "Change Password" and "Sign out".
- `admin.html` — Admin panel for viewing users, creating accounts, and changing roles.
- `common.html` — Shared UI fragment (loader, dialog, navigation helpers).
- `tests.gs` — Unit tests and an integration test for login/recovery.

## Setup
1. Create a new Apps Script project (standalone or bound to a Google Sheet).
2. Copy the repository files into the Apps Script project (matching filenames).
3. In `code.gs`, set your Spreadsheet ID in `CONFIG.SPREADSHEET_ID`:
   ```js
   const CONFIG = {
     SPREADSHEET_ID: 'YOUR-SPREADSHEET-ID-HERE',
     // ...
   };
   ```
4. Ensure your target Spreadsheet exists; the app will create the required sheets and headers on first run.
5. Optional: Configure a time-driven trigger for cleanup (see "Maintenance").

## Deployment (Web App)
1. In the Apps Script editor: Deploy → New deployment.
2. Choose "Web app".
3. Set "Execute as": Me.
4. Set "Who has access": Anyone (or your preferred audience).
5. Copy the deployment URL and open it in your browser.

## Usage
- Default admin account is created automatically on first run:
  - Username: `admin`
  - Password: `Admin123!`
- Admin Panel (`admin.html`):
  - View users table.
  - Create users (validated email, strong password required).
  - Change roles (`User`/`Admin`).
- User Dashboard (`user.html`):
  - View profile.
  - Change password (current password verification + strength checks).
  - Sign out (server renders `login` page).
- Password Recovery (`login.html`):
  - Request a 6-digit code via email using username or email.
  - Cooldown enforced; previous active codes are invalidated.
  - Reset password using the code; strong password required.

## Configuration
- `CONFIG.SPREADSHEET_ID` — ID of the Google Sheet used as datastore.
- Sheet names and headers are defined in `CONFIG` and normalized on creation:
  - Users: `Username, Password, Salt, Status, Role, Name, Last Name, Email`
  - Logs: `Record ID, Username, Log Event, Date, Time, Details, Status`
  - Password Recovery: `Record ID, Username, Email, Code, Expires, Used`

## Security Notes
- Passwords are hashed with `SHA‑256` and a unique `salt` per user; legacy plaintext passwords are upgraded on first successful login.
- Password strength is enforced on change/reset (min 8 chars, letters and numbers).
- Recovery codes are single-use and expire; cooldown prevents spamming.
- All sensitive actions (login attempts, resets, role changes) are logged.

## Testing
- Open `tests.gs` and run `runUnitTests()` from the Apps Script editor.
- Suite includes:
  - Utilities: `normalizeIdentifier`, `isNotExpired`, `generateRecoveryCode`.
  - Integration: login, send recovery code, and reset password for `admin`.

## Maintenance
- Expired recovery codes can be cleaned automatically via a time-driven trigger:
  - Apps Script: Triggers → "Add Trigger".
  - Function: `cleanupRecoveryCodes`
  - Event source: Time-driven → Daily (or hourly, as desired).

## Limitations & Notes
- Email sending uses `MailApp`; ensure your account/domain policies allow outbound mail to the stored email addresses.

- This sample focuses on server-side rendering and sheet-backed auth; for session management or multi-tenant setups, extend with tokens and additional policies.
