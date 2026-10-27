# Student Planner — Timetable and exam clash detector

Student Planner lets students choose units, view their personal lecture and exam timetable, review schedule clashes, and export their calendar. Class reps can upload a master timetable; administrators can review timetable changes, configure email reminders, and suggest alternate session groups.

## Run in VS Code

### Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer, or Docker Desktop for the included PostgreSQL container
- VS Code with a terminal

### Start the app

1. Open this project folder in VS Code.
2. Open **Terminal → New Terminal**.
3. Copy `.env.example` to `.env`. In PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Start PostgreSQL. With Docker Desktop installed:

   ```powershell
   docker compose up -d
   ```

   If you use a local PostgreSQL installation instead, create a database named `classday` and update `DATABASE_URL` in `.env`.

5. Install JavaScript dependencies:

   ```powershell
   npm install
   ```

6. Create the database tables and load the sample timetable:

   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

7. Start the API and React development server:

   ```powershell
   npm run dev
   ```

8. Open `http://localhost:5173` in your browser. Register a student account. The admin email and password come from `.env` (`ADMIN_EMAIL` and `ADMIN_PASSWORD`).
9. To give a class representative upload access, promote a registered account in PostgreSQL: `UPDATE students SET role='class_rep' WHERE email='rep@example.edu';`.

### Deploy to Render (free demo)

The included `render.yaml` configures a free web service and PostgreSQL database. Render's free PostgreSQL databases expire after 30 days, so use this setup for a demo rather than long-term storage.

1. Push this project to a GitHub repository. Do not commit `.env`; it contains local configuration and is ignored by Git.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the `render.yaml` configuration.
3. When prompted, enter the admin email and a strong admin password. Render generates the JWT secret, and the database URL is connected automatically.
4. Wait for the service deployment to complete, then open its `onrender.com` URL.
5. Sign in with the admin credentials and upload `sample-timetable.csv` under **Master timetable** to load the demo schedule.

The service runs database migrations at startup. Free services may spin down when idle, so the first request after inactivity can take a little while.

## Master timetable file format

Upload `.csv`, `.xlsx`, or `.xls` from **Administration → Master timetable**. The first sheet is read for Excel files. Required column names are:

| Column | Meaning |
| --- | --- |
| `course_code` | Unit code, such as `CSC 204` |
| `unit_name` | Unit title |
| `program_code`, `program_name` | Optional program/course identifiers, such as `BSC-CS` and `BSc Computer Science` |
| `year` | Study year (1–8) |
| `semester` | Semester (1–3) |
| `type` | `lecture` or `exam` |
| `day` | Lecture weekday (Monday–Sunday); blank for exams |
| `date` | Exam date (`YYYY-MM-DD`); blank for lectures |
| `start_time`, `end_time` | 24-hour (`09:00`) or AM/PM time |
| `venue` | Room or venue name |
| `group` | Optional session/group label; defaults to `A` |
| `building` | Optional building name |

The included `sample-timetable.csv` demonstrates the format. Each row represents one session. Re-uploading a master timetable replaces the active sessions and records added, changed, and removed rows for students who selected the affected units.

## Clash rules

- Intervals use half-open `[start, end)` semantics, so sessions that meet exactly at the boundary do not overlap.
- Overlapping sessions are flagged, including intervals that cross midnight.
- Two exams on the same date are flagged for review, even when their times do not overlap.
- Back-to-back sessions at different venues receive a travel warning.
- When multiple groups are published for a unit, the timetable shows alternate group labels for a clash. Select a group under **My units** to schedule only that group.

## Email reminders

Students can set reminder timing under **Reminders**. To send mail, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` in `.env`, then restart the API. Without SMTP settings, reminder preferences still save but the mail job remains disabled.

## Build and test

```powershell
npm test
npm run build
```

The clash-engine tests cover adjacent intervals, overlaps, back-to-back venues, and overnight sessions. The frontend PDF action opens the browser print dialog; choose **Save as PDF**.

## Project layout

```text
client/                 React app (Vite)
server/domain/          Interval expansion and clash detection
server/routes/          Authentication and planner API
server/services/        Timetable import and reminder scheduler
server/db/schema.sql    PostgreSQL models and constraints
sample-timetable.csv    Demo import data
```
