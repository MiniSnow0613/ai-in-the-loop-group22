# Deploying a Shared Board URL (Render + Turso — No Credit Card Required)

This guide deploys the Experiment Coordination Board to a single shared URL so teammates can collaborate in real time without running local terminals. Both **Render** (web host) and **Turso** (cloud SQLite database) offer free tiers that do not require a credit card.

---

## 1. Create a Free Turso Cloud SQLite Database

Render's free web service wipes its container disk whenever it sleeps (~15 min idle) or redeploys. Connecting Turso keeps your SQLite board persistent.

1. Sign up at [turso.tech](https://turso.tech) (Starter free tier — no credit card required).
2. Create a database (e.g., `group22-board`) and generate a read/write auth token.
3. Copy two values:
   - `TURSO_DATABASE_URL` (looks like `libsql://group22-board-....turso.io`)
   - `TURSO_AUTH_TOKEN` (the JWT token)

---

## 2. Deploy on Render (Free Tier)

1. Sign up at [render.com](https://render.com) (Hobby free tier — no credit card required) and connect your GitHub repo.
2. Click **New → Blueprint** (or **New → Web Service** using `Dockerfile`).
   - Using **Blueprint** automatically reads `render.yaml` and prompts you for the required environment variables:
     - **`BOARD_PASSCODE`** *(required)* — shared team password. On Render (`RENDER=true` / `REQUIRE_PASSCODE=1`), the board stays locked with a setup warning until the host sets this.
     - **`TURSO_DATABASE_URL`** and **`TURSO_AUTH_TOKEN`** — from Step 1.
     - **`AI_PROVIDER`** — `groq` (default in `render.yaml`) or `openrouter`.
     - **`GROQ_API_KEY`** (or **`OPENROUTER_API_KEY`** if using OpenRouter) — the host's default AI key.
3. Click **Apply / Deploy**. Once live, share the `https://<your-service>.onrender.com` URL and `BOARD_PASSCODE` with your teammates.

---

## 3. Using Your Own AI Key in the Browser

At the top of the **AI Assistant** panel on the right, each teammate can optionally select a provider (`Groq` / `OpenRouter`) and enter their own API key:
- Saved only in that user's browser (`localStorage`), never stored on the server or visible to teammates.
- Applies to both AI task suggestions and AI GPU hour estimates.
- Leaving it blank (or clicking **Reset**) automatically falls back to the host's provider and key.

---

## 4. Running Locally Alongside the Shared URL

Deploying to Render does not affect local development:
- Run `python app.py` in `backend/` and `npm run dev` in `frontend/` as usual.
- When `TURSO_DATABASE_URL` is unset locally, the local server uses its own `backend/data/board.db` (separate from the live team board), and no password is required unless you set `BOARD_PASSCODE`.
- If you want your local server to connect to the shared Turso board, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to `backend/.env` (gitignored).
