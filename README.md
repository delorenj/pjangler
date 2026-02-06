# pjangler

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts list
```

Quick onboarding helpers:

```bash
# one-time: install pjangler agent skill + pjangler:bootstrap command
bun run src/index.ts init

# scaffold misebase (manifest + dispatcher + base tasks)
bun run src/index.ts init misebase

# validate current repo scaffolding
bun run src/index.ts run doctor

# generate copy/paste onboarding artifact for this repo
bun run src/index.ts run onboarding-prompt --force
```

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
