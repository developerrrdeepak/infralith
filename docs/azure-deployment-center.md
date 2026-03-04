# Azure App Service Deployment (No GitHub Actions)

This project is prepared for direct deployment from GitHub to **Azure App Service** using **Deployment Center** with App Service build automation.

Last verified for no-GitHub-Actions deployment flow: 2026-03-04.

## 1. Local build/run checks

```bash
npm install
npm run build
npm run start
```

Environment variables are read from `.env` by Next.js.  
Use `.env.example` as the template:

```bash
cp .env.example .env
```

## 2. Azure App Service prerequisites

1. Create an **Azure App Service (Linux)**.
2. Set Runtime Stack to a Node.js version compatible with this repo (`>=20.10 <24`).
3. In App Service `Configuration > Application settings`, add all required variables from your local `.env`.

Recommended build/runtime settings:

- `SCM_DO_BUILD_DURING_DEPLOYMENT=true`
- `ENABLE_ORYX_BUILD=true`

Optional startup command (App Service `Configuration > General settings > Startup Command`):

```bash
bash startup.sh
```

## 3. Connect GitHub repo in Deployment Center

1. Open your App Service in Azure Portal.
2. Go to **Deployment Center**.
3. Source: **GitHub**.
4. Choose your organization, repository, and branch.
5. Build provider: **App Service Build Service** (not GitHub Actions).
6. Save.

After saving, each push to the selected branch triggers App Service to pull, build (`npm install` + `npm run build`), and deploy.

## 4. Verify deployment

1. Check **Deployment Center > Logs** for successful Oryx build.
2. Open the site URL and verify application health.
3. Use **Log stream** for runtime diagnostics if needed.
