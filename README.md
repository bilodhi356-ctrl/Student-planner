# Student Planner — Timetable and exam clash detector

Student Planner lets students choose units, view their personal lecture and exam timetable, review schedule clashes, and export their calendar. Class reps can upload a master timetable; administrators can review timetable changes, configure email reminders, and suggest alternate session groups.

## Run in VS Code

### Requirements

- Node.js 20 or newer
- MongoDB 7 or newer, or Docker Desktop for the included MongoDB container
- VS Code with a terminal

### Start the app

1. Open this project folder in VS Code.
2. Open **Terminal → New Terminal**.
3. Copy `.env.example` to `.env`. In PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Start MongoDB. With Docker Desktop installed:

   ```powershell
   docker compose up -d
   ```

   If you use a local MongoDB installation instead, set `MONGODB_URI` in `.env` (for example, `mongodb://localhost:27017`). The app uses the database named by `MONGODB_DB`.

5. Install JavaScript dependencies:

   ```powershell
   npm install
   ```

6. Create the MongoDB indexes and initial program records, then load the sample timetable:

   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

7. Start the API and React development server:

   ```powershell
   npm run dev
   ```

8. Open `http://localhost:5173` in your browser. Register a student account with a university email and registration number, such as `CCT/00002/2023` for BSc Computer Technology or `CCS/00023/2023` for BSc Computer Science. The final four digits are the admission year. Students can sign in with their registration number or email. The admin email and password come from `.env` (`ADMIN_EMAIL` and `ADMIN_PASSWORD`).
9. To give a class representative upload access, promote a registered account in MongoDB: `db.students.updateOne({ email: 'rep@example.edu' }, { $set: { role: 'class_rep' } })`.

### Deploy to Render (free demo)

The included `render.yaml` configures a free web service. Provide a MongoDB connection string in Render's `MONGODB_URI` environment variable (for example, from MongoDB Atlas); the database is not hosted by Render.

1. Push this project to a GitHub repository. Do not commit `.env`; it contains local configuration and is ignored by Git.
2. In Render, choose **New → Blueprint**, connect the repository, and apply the `render.yaml` configuration.
3. When prompted, enter the MongoDB connection string, admin email, and a strong admin password. Render generates the JWT secret.
4. Wait for the service deployment to complete, then open its `onrender.com` URL.
5. Sign in with the admin credentials and upload `sample-timetable.csv` under **Master timetable** to load the demo schedule.

The service runs database migrations at startup. Free services may spin down when idle, so the first request after inactivity can take a little while.

The Render build command installs development dependencies explicitly so Vite remains available during the production build.

## Master timetable file format

Upload `.csv`, `.xlsx`, `.xls`, or a PDF from **Administration → Master timetable**. The first sheet is read for Excel files. PDFs may contain either a structured table with the required column headings below or a selectable-text weekly timetable arranged by weekday, cohort/group, and hourly columns (such as the Maseno University teaching timetable layout). Image-only scanned timetables are not supported. The weekly-grid importer reads the semester from the PDF heading and maps each timetable cell to a lecture session; unit names default to their codes unless an offered-units list has already supplied names. Required column names for a timetable are:

| Column | Meaning |
| --- | --- |
| `course_code` | Unit code, such as `CSC 204` |
| `unit_name` | Unit title |
| `program_code`, `program_name` | Optional program/course identifiers, such as `BSC-CS` / `BSc Computer Science` or `BSC-CT` / `BSc Computer Technology` |
| `year` | Study year (1–8) |
| `semester` | Semester (1–3) |
| `type` | `lecture` or `exam` |
| `day` | Lecture weekday (Monday–Sunday); blank for exams |
| `date` | Exam date (`YYYY-MM-DD`); blank for lectures |
| `start_time`, `end_time` | 24-hour (`09:00`) or AM/PM time |
| `venue` | Room or venue name |
| `group` | Optional session/group label; defaults to `A` |
| `building` | Optional building name |
| `lecturer_name` | Optional lecturer/instructor name for a lecture |

The included `sample-timetable.csv` demonstrates the format. Each row represents one session. Re-uploading a master timetable replaces the active sessions and records added, changed, and removed rows for students who selected the affected units.

Administrators can also upload a separate units-offered list in CSV, Excel, or text-based PDF format. It requires `course_code`, `unit_name`, `year`, and `semester`; `program_code`, `program_name`, and `lecturer_name` are optional. Allocation PDFs with Computer Science and Computer Technology sections are imported as separate programs, with units shared by both linked to both programs. Lecturer assignments in allocation PDFs (or a `lecturer_name` CSV column) are applied to matching lecture sessions. Repeated unit codes within a program are merged, category suffixes are removed from titles, and the cleanest title is kept. A program-section PDF refreshes those programs' unit links to match the file, while keeping unit records, sessions, and other programs unchanged. CSV imports add or update units without removing program links.

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
server/db/              MongoDB connection, indexes, and seed scripts
sample-timetable.csv    Demo import data
```
