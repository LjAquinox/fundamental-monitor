# Fundamental Monitor

Financial PDF extraction, company review and forecasting.

## Run (Windows)

Requires Node.js 24.19+ (24.x). From the project folder:

```powershell
npm ci
npm run build
.\Start-Windows.cmd
```

Set your API key in **API settings**. Keys and local research are excluded from Git.

## Workflow

Stop the app with Ctrl+C, then run:

```powershell
.\Run-Company-Workflow.cmd -Fresh -Concurrency 4
```

Omit `-Fresh` to resume. Restart the app to view results.

Coded mainly using AI; designed and reviewed by me.
