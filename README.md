# Ai-in-the-loop in Software Project Cycle (group22)

## TOPIC - Collaborative Experiment Orchestration for Resource-Constrained AI Research Teams
Keep experiments connected, GPU usage visible, and teammates on the same page—even when everyone is working with their own AI coding agent.

## The Problem
Small research teams often work on several interdependent experiments at once:
- Simulation and data collection: Generate datasets using different environments, scenarios, or collection strategies.
- Model training: Explore datasets, hyperparameters, configurations, and checkpoints.
- Simulation-based evaluation: Test checkpoints, inspect rollouts, and render results.
These tasks depend on one another and may compete for the same limited GPU resources. Meanwhile, teammates—and their individual AI coding agents—modify code and configurations independently.

We are building a tool to make these dependencies and handoffs explicit, rather than requiring teammates to reconstruct them manually.

## Target Users
- Graduate students from our labs.
- Students taking ML related courses and need to conduct model experiments in their final project.

## Project Documents
- [Contributors](CONTRIBUTORS.md)
- [AI Usage Guidelines](docs\‎AI_USAGE_GUIDELINES.md)
- [Decisions Log](docs/DECISIONS.md)
- [Evaluation Plan](docs/‎EVALUATION_PLAN.md)
- [Project Checkpoint 1](docs\Group22_CP1.pdf)

## Running Locally

### 1. Install dependencies (first time)
```powershell
cd backend
pip install -r requirements.txt
cd ..\frontend
npm install
```

### 2. Start the app
- **Dev mode (two terminals, with frontend hot-reload):**
  1. Terminal 1 (`backend/`): `python app.py`
  2. Terminal 2 (`frontend/`): `npm run dev`
  3. Open `http://localhost:5173`
- **Single-server mode (one terminal):**
  1. Build the frontend once (`frontend/`): `npm run build`
  2. Start Flask (`backend/`): `python app.py`
  3. Open `http://127.0.0.1:5000`

### 3. AI Provider & API Key
- Set `AI_PROVIDER` (`groq` or `openrouter`) and `GROQ_API_KEY` / `OPENROUTER_API_KEY` in PowerShell the first time you run `python app.py`; they are saved automatically to the gitignored `backend/.env` for future runs.

## UI & Tests
- **Resizable panels:** Drag the dividers between the **Board / AI Assistant** or **Timeline / Task Pool** (double-click any divider to reset; sizes persist in `localStorage`).
- **Tests:** Run `pytest` in `backend/` and `npm test` in `frontend/`.

