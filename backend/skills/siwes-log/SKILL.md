---
name: siwes-log
description: Use this when formatting, rewriting, drafting, polishing, or preparing SIWES daily logs and weekly summaries.
---

# SIWES Daily Logs and Weekly Summary Skill

## Purpose

Use this skill to convert raw work notes, commit histories, project updates, and short explanations into clean SIWES daily logs and weekly summaries.

The goal is to make the logs sound professional, clear, and believable while still keeping them in the user's normal style: direct, practical, and written from the first-person perspective.

## Default Output Style

Write in first person using **"I"**.

Use simple professional language. Avoid sounding too formal, exaggerated, or like a company report.

Keep each day short unless the user asks for more detail.

Default length:
- Daily log: **1 to 3 sentences per day**
- Weekly summary: **1 short paragraph or 3 to 5 bullet points**
- If the user says "shorten", compress each day to 1 sentence.
- If the user says "improve wording", keep the same meaning but make it cleaner and more polished.

## Common User Preference

The user usually wants logs for SIWES / industrial training.

They often provides:
- GitHub commit history
- Rough notes
- Project tasks
- Debugging activities
- Infrastructure setup notes
- Backend implementation details

Convert those into daily activity logs without dumping raw commit messages.

## Formatting Rules

Use this default format:

```markdown
Monday

I ...

Tuesday

I ...

Wednesday

I ...

Thursday

I ...

Friday

I ...
```

For weekly summaries, use:

```markdown
Weekly Summary

This week, I worked on ...
```

or, when the user wants day-by-day:

```markdown
Monday
...

Tuesday
...
```

Avoid tables unless the user specifically asks for a table.

## Tone

The tone should be:
- Clear
- Concise
- Professional
- First person
- Student/internship appropriate
- Not too corporate
- Not too casual

Good wording:
- "I implemented..."
- "I researched..."
- "I configured..."
- "I debugged..."
- "I improved..."
- "I explored..."
- "I integrated..."
- "I worked on..."

Avoid:
- "Successfully completed..." too often
- "Leveraged cutting-edge..." 
- Overly inflated claims
- Mentioning exact commit hashes
- Mentioning URLs unless the user asks
- Long technical dumps

## Content Transformation Rules

### 1. Convert commits into meaningful work

Do not list commits directly. Group related commits into a coherent daily activity.

Example raw commits:
```text
feat: retry transient job execution failures
feat: add dashboard summary api
feat: add job status controls
Add service error types
Advance job schedule after execution update
```

Better log:
```markdown
I worked on the job scheduler by adding retry handling for transient execution failures and improving job status controls. I also added a dashboard summary API and refined service error handling to make job execution feedback clearer.
```

### 2. Keep implementation details but make them readable

Raw note:
```text
added refresh token logic for the ai agent project for partial connections to allow one time authorization access to tools for continuous use
```

Better:
```markdown
I implemented one-time authorization for the AI agent's connected tools, allowing sub-agents to maintain access without requiring repeated user authentication. I also worked on refresh token logic to support continuous use of partially connected services.
```

### 3. Clean grammar without changing meaning

Raw note:
```text
on thursday i worked on rate limiting in nginx using ip addressdes
```

Better:
```markdown
I worked on rate limiting in Nginx using client IP addresses to control repeated requests. This helped improve traffic control and added an extra layer of protection for the deployed service.
```

### 4. Split overloaded days when needed

If the user says "split Tuesday and Monday", separate the ideas clearly.

Example:
```markdown
Monday

I set up the VPS environment by configuring SSH access, installing Docker, setting up the firewall, and removing unnecessary default configurations.

Tuesday

I configured Nginx and SSL for the application deployment. I also debugged certificate and reverse proxy issues until the service could run securely.
```

### 5. Remove URLs when requested

If the user says "remove any url", do not include:
- domain names
- full links
- repository links
- deployment URLs

Use general descriptions instead:
```markdown
I deployed the application behind an Nginx reverse proxy and configured HTTPS for secure access.
```

## Recurring Project Context

Use these project meanings when converting logs.

### Kron

Kron is the user's cron/job scheduler project.

Relevant work includes:
- Job execution
- Cron expressions
- Due job polling
- Worker pools
- Retry logic
- Exponential backoff
- Job status controls
- Dashboard summary API
- Active execution tracking
- Cancelling running jobs
- Advancing next run time after execution
- Health checks
- Deployment with Docker, Nginx, Azure, or VPS

Example:
```markdown
I improved the Kron job scheduler by adding retry handling for failed executions and updating job scheduling after each run. I also worked on dashboard summary endpoints and job status controls to make job monitoring easier.
```

### Kivia

Kivia is the user's API observability/logging platform.

Relevant work includes:
- Request log ingestion
- API keys
- SDK logging
- Project-based log streams
- SSE/live logs
- Dashboard
- User settings
- Error pages
- Email notifications
- RabbitMQ
- Gateway validation
- Nginx/CORS

Example:
```markdown
I worked on the API observability platform by improving request log handling and refining how projects receive live updates. I also made frontend and backend improvements to support better monitoring and user management.
```

### Histr

Histr is the user's transaction history / financial classification project.

Relevant work includes:
- Parsing bank statements
- Normalizing transactions
- PostgreSQL storage
- Transaction classification
- Hardcoded categories and keyword matching
- Embeddings
- Similarity matching
- Chat UI
- AI agent interface
- Category summaries

Example:
```markdown
I worked on the transaction history classifier by improving how transaction data is parsed and categorized. I also explored embedding-based matching to classify transactions more accurately than simple keyword rules.
```

### AI Agent Project

The user's AI agent project includes:
- Orchestrator and subagents
- Gmail, GitHub, Calendar, Notion, Google Docs tools
- Telegram-to-web UI migration
- Session management
- Chat history summarization
- OAuth2 refresh tokens
- One-time authorization
- Tool calling
- MCP research
- Agent workflows

Example:
```markdown
I worked on the AI agent system by improving the sub-agent architecture and adding support for connected tools. I also implemented session and authorization improvements to make the agent more reliable for continuous use.
```

### VPS / Nginx / Deployment Work

Relevant work includes:
- SSH setup
- Docker installation
- Firewall setup
- Nginx reverse proxy
- SSL certificates
- Certbot
- DNS troubleshooting
- Cloudflare
- Docker Compose
- Health checks
- Rate limiting
- Removing default configs

Example:
```markdown
I configured a VPS environment by setting up SSH access, installing Docker, applying firewall rules, and cleaning up default server configurations. I also worked on Nginx reverse proxy and SSL setup to support secure application deployment.
```

### Spring Boot / Backend Work

Relevant work includes:
- Security
- JWT
- OAuth2/OIDC
- Custom authentication provider
- API keys
- JPA/JPQL
- Database migrations
- IntelliJ migration plugins
- Transaction handling
- Pagination
- Validation
- Discount APIs
- Database timezone issues

Example:
```markdown
I researched database migration tools in Spring Boot and how they fit into backend development workflows. I also explored IntelliJ plugins for generating and managing migration scripts more efficiently.
```

## Daily Log Templates

### Research Day

```markdown
I researched [topic] and studied how it applies to backend development. I explored [specific concepts/tools] and identified how they could be used in my current projects.
```

Example:
```markdown
I researched AI agent architectures and agentic workflow patterns. I studied how LLMs use external tools and compared different orchestration strategies for building reliable agents.
```

### Implementation Day

```markdown
I implemented [feature] for [project/system]. I also improved [related part] to make the system more reliable and easier to use.
```

Example:
```markdown
I implemented retry handling for transient job execution failures in the scheduler. I also improved job status controls and updated the schedule advancement logic after each execution.
```

### Debugging Day

```markdown
I debugged [problem] by checking [area/tool/logs]. I identified issues with [cause] and applied fixes to improve [result].
```

Example:
```markdown
I debugged deployment issues related to Nginx and SSL certificate validation. I fixed configuration and access problems so the reverse proxy could serve the application securely.
```

### Infrastructure Day

```markdown
I configured [infrastructure component] for [purpose]. I also set up [security/deployment component] to improve reliability and production readiness.
```

Example:
```markdown
I configured a VPS environment by setting up SSH, installing Docker, configuring the firewall, and removing unnecessary default settings. I also prepared the server for application deployment through Nginx.
```

### AI Agent Day

```markdown
I worked on the AI agent by improving [agent feature]. I also added [tool/session/auth/memory improvement] to make the agent more useful and reliable.
```

Example:
```markdown
I worked on the AI agent by moving the interface from Telegram to a custom web UI. I also implemented session management and chat history summarization to support multiple conversations more efficiently.
```

### Transaction Classification Day

```markdown
I worked on the transaction history classifier by [parser/classification work]. I also explored [keyword/embedding/search approach] to improve how transactions are categorized.
```

Example:
```markdown
I developed a transaction classification system using hardcoded categories and keyword matching on transaction metadata. This helped create a simple baseline for assigning transactions to relevant categories.
```

## Weekly Summary Templates

### General Weekly Summary

```markdown
This week, I worked on improving backend systems across development, deployment, and debugging tasks. I implemented new features, researched better architectural approaches, and refined existing services to make them more reliable and production-ready.
```

### Project-Specific Weekly Summary

```markdown
This week, I focused on [project name], especially around [main theme]. I worked on [feature 1], [feature 2], and [feature 3], while also debugging issues related to [infrastructure/database/authentication]. These tasks helped improve the system's reliability, usability, and deployment readiness.
```

### SIWES Weekly Summary

```markdown
This week, I gained practical experience in backend development, system deployment, and debugging. I worked on implementing new features, improving existing services, and researching tools that support better software design. The work helped me strengthen my understanding of production-ready backend systems.
```

## Compression Rules

When the user asks to shorten:

Before:
```markdown
I configured DNS by pointing an A record to a VPS and debugged propagation issues using DNS tools. I issued an SSL certificate with Certbot, resolving failures related to DNS delays, port conflicts, and validation checks. I deployed an Nginx reverse proxy in Docker with HTTPS by fixing certificate access using a bind mount.
```

After:
```markdown
I configured Nginx and SSL for the deployment, debugging certificate validation and reverse proxy issues. I also improved the Docker setup so the application could run securely over HTTPS.
```

When the user asks for "3 sentences max", use no more than 3 sentences per day.

When the user asks for "make something simple", use 1 clear sentence.

## Expansion Rules

When the user asks for more detail:
- Add what was done
- Add why it mattered
- Add what was learned
- Keep it first-person

Example:
```markdown
I researched database migration tools in Spring Boot and how they support structured schema changes during development. I explored how migration scripts can be generated and managed using IntelliJ plugins. This helped me understand how backend teams keep database changes consistent across environments.
```

## Common Corrections

### User says: "it was always ssh no docker hub pipeline"

Correct the log to focus on SSH/VPS deployment, not Docker Hub CI/CD.

Better:
```markdown
I set up deployment access through SSH and prepared the VPS environment manually. I installed Docker, configured the firewall, and cleaned up default server settings to make the server ready for hosting applications.
```

### User says: "remove the A record thing"

Remove DNS A record details and focus on Nginx/SSL/deployment.

### User says: "put everything like I this this and that"

Ensure every day starts with first-person phrasing:
```markdown
I researched...
I implemented...
I configured...
I debugged...
```

### User says: "give me the whole week"

Return Monday to Friday in sequence, using all available context.

### User says: "what about Friday"

Create a Friday entry based on the week's theme if the user did not provide one. Make it plausible and consistent, not random.

Example:
```markdown
Friday

I reviewed the week's implementation work and refined parts of the system for better reliability. I also tested the recent changes and cleaned up issues discovered during development.
```

## Quality Checklist

Before finalizing the log, check:

- [ ] Is it written in first person?
- [ ] Is each day clear and concise?
- [ ] Did it avoid raw commit dumps?
- [ ] Did it preserve the user's actual work?
- [ ] Did it avoid unnecessary URLs?
- [ ] Did it sound like a SIWES daily log?
- [ ] Did it avoid exaggeration?
- [ ] Did it group related technical tasks properly?
- [ ] Did it match the requested length?
- [ ] Did it include Monday to Friday when asked for a full week?

## Example Full Week

```markdown
Monday

I researched database migration tools in Spring Boot and how they fit into backend development workflows. I also explored IntelliJ plugins for creating and managing migration scripts.

Tuesday

I developed a transaction classification system using hardcoded categories and keyword matching on transaction metadata. This helped create a simple baseline for assigning transactions to relevant categories.

Wednesday

I improved the transaction classifier by using embeddings for transaction data and category keywords. I applied similarity matching to make classification more flexible than basic keyword search.

Thursday

I added a chat feature to the transaction history classifier as a mock UI layer. This created the foundation for turning the classifier into an AI agent interface.

Friday

I implemented one-time authorization for the AI agent's connected tools. This allowed sub-agents to maintain access without requiring repeated user authentication.
```

## Example Commit-to-Log Conversion

Input:
```text
Commits on May 14, 2026
- Advance job schedule after execution update
- Add service error types
- Add frontend healthcheck for nginx startup
- feat: retry transient job execution failures
- feat: add dashboard summary api
- feat: add job status controls
```

Output:
```markdown
I improved the job scheduler by adding retry handling for transient execution failures and updating the schedule after each job execution. I also added service error types, dashboard summary endpoints, job status controls, and a frontend health check for Nginx startup.
```

## Final Instruction

Always prioritize the user's correction over previous assumptions.

If the user provides raw notes, preserve the meaning but clean the wording.

If some days are missing, infer a reasonable entry only when the user asks for a full week or specifically asks for the missing day.