# Evaluation Plan

## Problem Grounding

### 1. Who specifically has the collaboration problem?

Our primary users are small research and software development teams (2–5 members) who use ai-agent to work on GPU-intensive projects, such as machine learning, computer graphics, and scientific computing in a shared codebase and with limited computational resources.

### 2. What do they currently do instead of our tool?

Teams typically rely on:
- LINE, Discord, or informal discussions to coordinate tasks.
- Git and shared directories to manage code changes.
- Terminal commands (e.g., nvidia-smi) to check GPU availability.
- Manual scheduling or informal agreements to share computing resources.

### 3. What would be observably different if our tool worked?

Team members would be able to:
- Identify who is responsible for each task and its current status.
- Understand AI-assisted code changes and their potential impact on dependent tasks.
- View GPU usage requests and ongoing jobs in a shared workspace.
- Coordinate schedule adjustments when tasks are delayed or dependencies change.

## Evaluation Plan

### Success Definition

We will know our tool works if teams can coordinate dependent tasks and respond to GPU scheduling disruptions more efficiently than with their existing workflow.

Our metrics includes
- Scheduling Errors: Number of conflicting GPU assignments or attempts to execute jobs before their dependencies are ready.

- Task Awareness Accuracy: Whether members correctly identify teammates' responsibilities, task dependencies, and GPU job statuses.

- Coordination Overhead: Number of clarification requests and manual status checks.

- AI Suggestion Usefulness: Percentage of AI-generated summaries or dependency warnings accepted by users without major corrections, and time spent reviewing them.

### Target Users

We will recruit at least two external research or development teams, each containing 2–3 members, and aim for three teams if possible.

Potential participants include graduate students from our labs or students taking ML related courses and need to conduct model experiments in their final project.

### Method

We will conduct a **within-team crossover study** with at least two external research teams, each consisting of 2–3 members. Each team will complete two comparable robot policy experiment coordination scenarios: one using its existing workflow (e.g., Git, messaging apps, and manual GPU checks) and one using our tool. The order of conditions will be counterbalanced across teams to reduce learning and order effects.

The scenarios will represent realistic collaborative ML workflows involving simulator-based data collection, policy training, checkpoint evaluation, experiment configuration changes, and shared GPU constraints.

Each scenario will contain predefined disruptions, such as an upstream dataset change, an outdated checkpoint reference, or a GPU scheduling conflict. Participants must coordinate task ownership, resolve dependencies, and establish a valid execution plan.

We will evaluate the tool through:

1. **Structured observation:** Measure the time needed to resolve coordination disruptions, the number of scheduling/dependency errors, and the frequency of clarification requests or manual status checks.
2. **Task awareness assessment:** After each scenario, independently ask participants to identify task owners, current experiment configurations, dependencies, and GPU job statuses.
3. **Brief post-task interviews:** Collect qualitative feedback on usability, missing information, and misleading AI suggestions.
4. **AI suggestion review:** Record whether AI-generated summaries and dependency warnings are accurate, actionable, and accepted without major correction, including the time required for review.

Both conditions will use the same underlying development tools and comparable initial information. Only access to our collaboration tool will differ. 


### Minimum Evidence Threshold

We will consider the evaluation promising if:

- At least two external teams complete both experimental conditions.
- Both teams demonstrate faster coordination with the tool, with at least a **25% reduction in median coordination resolution time** across teams.
- Task awareness accuracy reaches at least **80%** in the tool-assisted condition.
- No critical GPU scheduling or experiment dependency conflict remains unresolved in the tool-assisted condition.


We will report per-team results, raw observations, and failure cases. Given the small sample, we will treat these findings as preliminary evidence of practical usefulness rather than statistically conclusive proof.

### Human–AI Boundary

The AI will summarize experiment updates, identify potential cross-task impacts, and propose coordination actions based on available project records.

Deterministic logic will handle resource conflict checks, dependency validation, and experiment metadata tracking.

Human team members will remain responsible for assigning tasks, approving suggested dependency changes, choosing experimental configurations, deciding GPU allocation priorities, and authorizing job execution.

AI suggestions will be distinguishable from verified system states and will require human confirmation before modifying shared plans.

We will separately evaluate the AI component through the correctness and review cost of its summaries and warnings.