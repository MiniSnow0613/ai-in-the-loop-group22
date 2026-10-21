# AI Usage Guidelines

## Section 1 — AI Tools and Usage

- ChatGPT: We will use ChatGPT for brainstorming, explaining code, debugging, and comparing technical approaches. Important decisions resulting from these discussions will be documented in DECISIONS.md. We will not use ChatGPT to make final technical decisions without team discussion.
- Claude: We will use Claude to generate initial code structures and help resolve problems encountered during development. We will not merge Claude-generated code into main without human review and testing.
- GitHub Copilot: We will use GitHub Copilot for simple inline code completion while programming. We will not accept suggested code without reviewing and understanding it.

## Section 2 — Documentation of AI Interactions

- Prompt Engineering Log: We will document AI interactions that contribute to our project, such as AI-generated code structures, adopted code, and other important outputs. Each entry will include the AI model used, the prompt, the generated output, and what the team kept or modified. Simple syntax questions, one-off debugging, and code autocompletion do not need to be logged individually.

- PR Description: If a PR contains AI-generated code, we will briefly describe which AI tool was used, what the AI generated, and what the developer subsequently modified and tested.

- DECISIONS.md: If AI suggestions influence important technical or design decisions, we will record the team's final decision, the reasoning behind it, and the alternatives considered.

## Section 3 — Handling Disagreements About AI Output Quality

- If team members disagree about whether AI-generated code is good enough to merge, we will evaluate it based on whether it passes the existing tests, passes the PR review checklist, can be understood and explained by another team member, and does not introduce known security or functionality issues.
- If the disagreement is about coding style or personal preference, we will follow the team's agreed coding style and linter rules.
- If the disagreement still cannot be resolved using these criteria, the current code steward will make the final decision based on the available evidence, and the reasoning will be briefly documented in DECISIONS.md.
