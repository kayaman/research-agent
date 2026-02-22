# Research Agent

A Vite + React application that runs a multi-agent research pipeline powered by the Anthropic API.

## Features

- **Collect** — add sources via URL fetch, text paste, or knowledge base notes
- **Pipeline** — three agents in sequence: Research Analyst → Writing Strategist → Senior Writer
- **Refine** — chat with an editorial agent to iterate on the draft
- **Library** — persistent storage of sources, drafts, and notes via `localStorage`

## Setup

```bash
cp .env.example .env
# Edit .env and set your Anthropic API key
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Environment

| Variable | Description |
|---|---|
| `VITE_ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`) |

> **Note:** The API key is embedded in the browser bundle. This app is intended for local/personal use only.
