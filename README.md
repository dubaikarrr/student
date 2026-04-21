# SPOM Seat Checker

This project is now set up for a fully free student-friendly deployment model:

1. `GitHub Actions` runs the scanner every hour.
2. `GitHub Pages` hosts the frontend.
3. The scanner writes static JSON into `public/data/`.
4. The frontend reads those JSON files directly.
5. Optional email alerts can be sent using a free provider such as Resend.

## Why this architecture

For a free project, this is the best balance of cost and simplicity:

- `GitHub Pages` is good for static websites.
- `GitHub Actions` is free on public repositories.
- The site does not need a paid always-on backend.
- Students can access a public URL and filter by state and city on mobile or desktop.

## GitHub Student Pack

Your GitHub Student Developer Pack helps, but it does not change the core hosting choice.

What it helps with:

- GitHub Pro while you are a student.
- Useful partner offers and developer tools.
- Easier development tooling and private-repo flexibility if needed.

What it does not change:

- GitHub Pages is still static hosting.
- The recommended free hosting approach is still `GitHub Actions + GitHub Pages`.

## Project structure

- `spom_seat_checker.py`: scans ICAI seat availability and writes reports plus static frontend JSON.
- `public/index.html`: student-facing mobile-friendly dashboard.
- `public/data/latest.json`: latest seat snapshot for the frontend.
- `public/data/summary.json`: summary data for filters.
- `.github/workflows/hourly-update.yml`: hourly automation and Pages deployment.
- `send_alerts.py`: optional email alert sender for new availability.
- `subscribers.example.json`: sample subscriber format.
- `local_preview_server.py`: local preview server for testing before deployment.

## Run locally

Generate fresh data:

```powershell
python .\spom_seat_checker.py --stdout
```

Run the local preview:

```powershell
python .\local_preview_server.py
```

Then open:

```text
http://127.0.0.1:8000
```

## How GitHub hosting works

The hourly workflow does this:

1. checks out the repo,
2. preserves the previous snapshot,
3. runs the scanner,
4. optionally sends email alerts if email secrets are configured,
5. commits updated JSON and report files,
6. deploys the `public/` folder to GitHub Pages.

The workflow runs hourly at minute `7`:

```text
7 * * * *
```

That offset avoids the busiest top-of-hour window.

## Set up on GitHub step by step

1. Create a new public GitHub repository.
2. Push this project to the repository.
3. In GitHub, go to `Settings -> Pages`.
4. Under `Build and deployment`, choose `GitHub Actions`.
5. In GitHub, go to `Settings -> Actions -> General`.
6. Make sure workflow permissions allow read and write access to repository contents.
7. The included workflow file `.github/workflows/hourly-update.yml` will handle updates and deployment.
8. After the first workflow run, GitHub Pages will give you a public site URL.

## Optional email alerts

The workflow can send alert emails when new availability appears compared to the previous snapshot.

To enable alerts:

1. Create a `subscribers.json` file based on `subscribers.example.json`.
2. Add these GitHub repository secrets:
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
3. Commit `subscribers.json` if you are okay keeping subscriber addresses in the repo.

Example subscriber file:

```json
[
  {
    "email": "student@example.com",
    "states": ["Maharashtra"],
    "cities": ["Mumbai"]
  }
]
```

Notes:

- `states: []` means all states.
- `cities: []` means all cities within the chosen states.
- Right now alerts are sent only for newly appeared rows.

## Mobile support

The frontend is designed to work on mobile:

- compact layout,
- touch-friendly filters,
- table turns into stacked cards on small screens.

## Important limitations

- GitHub scheduled workflows can sometimes be delayed.
- Inactive public repositories can have scheduled workflows automatically disabled after 60 days without activity.
- Email sending depends on your email provider limits.
- If ICAI changes the endpoint format, the scanner may need an update.

## Useful commands

Run scanner:

```powershell
python .\spom_seat_checker.py --stdout
```

Run preview:

```powershell
python .\local_preview_server.py
```

Run alerts locally:

```powershell
python .\send_alerts.py
```
