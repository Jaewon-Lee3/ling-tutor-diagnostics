# Repository Guidelines
## Project Structure & Module Organization
This Next.js 15 app uses the App Router. `app/layout.tsx` defines shared chrome and global providers, while `app/page.tsx` renders the primary `MathTutorDiagnostic` workflow. Client-side UI lives in `app/components/MathTutorDiagnostic.tsx` and should be split into smaller components inside `app/components/` as complexity grows. Serverless handlers belong under `app/api`; the existing `app/api/config/route.ts` exposes configuration derived from env variables. Place static assets in `public/`, and keep styling tokens in `app/globals.css` (Tailwind-ready via PostCSS 4).

## Build, Test, and Development Commands
- `npm run dev`: launches the Turbopack-powered development server on port 3000 with hot refresh.
- `npm run build`: produces an optimized production bundle; run this before cutting release branches.
- `npm run start`: serves the previously built bundle locally, mirroring the Vercel runtime.
- `npm run lint`: runs ESLint with the Next.js config; fix warnings before opening a PR.

## Coding Style & Naming Conventions
Use TypeScript, functional React components, and `use client` only where stateful UI is required. Follow Prettier defaults already reflected in the repo: two-space indentation, single quotes, and trailing semicolons. Component files stay in `app/components/` with `PascalCase` names (e.g., `ProgressBadge.tsx`), hooks use `useSomething` camelCase, and utility modules prefer `camelCase` exports. Keep imports grouped by library → internal paths, and document non-trivial logic with succinct comments.

## Testing Guidelines
We do not yet ship an automated test runner. When adding one, prefer `@testing-library/react` with co-located `*.test.tsx` files under `app/components/`. Stub API responses so conversations stay deterministic. Until the suite exists, validate changes manually by running `npm run dev`, exercising each diagnostic stage, and verifying API requests against the mocked config route. Capture reproduction steps in the PR when fixing bugs.

## Commit & Pull Request Guidelines
Commits follow the short, descriptive sentences already in history (`Update Gemini thinking budget to 1024 tokens`, `프롬프트에 feedback_completed 필드 추가`). Keep messages under 72 characters, use the imperative mood, and group related changes. Pull requests need: a plain-language summary, linked issue or task ID, screenshots or screen recordings for UI changes, and notes on environment variables or migrations. Request at least one review before merging.

## Environment & Security Tips
Store secrets such as `NEXT_PUBLIC_GEMINI_API_KEY` in `.env.local` and never commit them. The config route echoes this value publicly, so rotate the key immediately if it leaks. When adding new providers, gate them behind server-side env checks and document required variables in the PR description.

## Deployment
This project is configured for automated deployment on **Vercel**. Every push to the `main` branch triggers a production build. Ensure that `npm run build` passes locally before pushing, as Vercel will fail the deployment if there are ESLint errors or type mismatches.
