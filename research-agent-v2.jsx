import { useState, useEffect, useRef, useCallback } from "react";

const FONTS = "https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&family=Overpass:wght@300;400;500;600;700&family=Overpass+Mono:wght@400;500;600&display=swap";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ─── AGENT PROMPTS ───
const RESEARCH_AGENT = `You are a Research Analyst agent. Your job is to analyze raw research material (articles, notes, excerpts) and extract:
1. KEY INSIGHTS — the most important ideas, claims, and findings
2. PATTERNS — recurring themes, contradictions, or emerging trends across sources  
3. DATA POINTS — specific stats, quotes, or evidence worth citing
4. CONTRARIAN ANGLES — surprising takes or underexplored perspectives
5. KNOWLEDGE GAPS — what's missing or what questions remain unanswered

Be thorough but concise. Structure your analysis with clear headers. Focus on signal over noise.
If a topic/angle is specified, bias your analysis toward that angle.`;

const OUTLINE_AGENT = `You are a Writing Strategist agent. Given a research analysis, produce a detailed content outline that includes:
1. TITLE OPTIONS — 3 compelling title candidates  
2. HOOK — a strong opening paragraph or lede concept
3. STRUCTURE — ordered sections with:
   - Section header
   - Key argument for this section
   - Supporting evidence to use (from the research)
   - Transition to next section
4. CONCLUSION — the main takeaway and call to action
5. METADATA — suggested word count, tone, target audience

Make the outline actionable — a writer should be able to draft from this alone.`;

const WRITING_AGENT = `You are a Senior Writer agent. Given a research analysis and outline, produce a publication-ready draft.

Guidelines:
- Write with clarity and conviction. No filler.
- Every paragraph earns its place — high insight density.
- Use concrete examples and data from the research.
- Voice: thoughtful practitioner, not generic content creator.
- Strong opening that hooks immediately.
- Clean transitions between sections.
- Ending that resonates — not a bland summary.

Produce the FULL draft. Do not abbreviate or skip sections.`;

const CHAT_REFINE = `You are an editorial assistant helping refine a draft. The user will ask for changes — tone shifts, structural edits, expanding sections, cutting fluff, adding examples, etc.

Rules:
- When asked to edit, output the FULL revised version (not just the changed parts).
- Maintain the original voice unless asked to change it.
- Be opinionated — suggest improvements proactively.
- If the user's request is vague, ask a clarifying question.`;

// ─── STORAGE ADAPTER ───
const storage = {
  get: (key) => Promise.resolve({ value: localStorage.getItem(key) }),
  set: (key, val) => Promise.resolve(localStorage.setItem(key, val)),
};

const API_HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

// ─── API HELPER ───
async function callAgent(systemPrompt, userMessage, tools = []) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (tools.length > 0) body.tools = tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || "").filter(Boolean).join("\n") || "";
}

async function callAgentChat(systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || "").filter(Boolean).join("\n") || "";
}

async function fetchUrlContent(url) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      system: "You extract and summarize web content. Given a URL, use web search to find the content and provide: 1) The article title, 2) A comprehensive summary preserving key facts, data points, arguments and quotes, 3) Key takeaways. Be thorough — this will be used as research material.",
      messages: [{ role: "user", content: `Please fetch and summarize the content at: ${url}` }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || "").filter(Boolean).join("\n") || "";
}

// ─── STORAGE HELPER ───
const STORAGE_KEY = "ra:library-v2";

async function loadLibrary() {
  try {
    const result = await storage.get(STORAGE_KEY);
    return result?.value ? JSON.parse(result.value) : { sources: [], drafts: [], notes: [] };
  } catch {
    return { sources: [], drafts: [], notes: [] };
  }
}

async function saveLibrary(lib) {
  try {
    await storage.set(STORAGE_KEY, JSON.stringify(lib));
  } catch (e) {
    console.error("Storage save failed:", e);
  }
}

// ─── MAIN APP ───
export default function ResearchAgentV2() {
  // Navigation
  const [view, setView] = useState("collect"); // collect | pipeline | refine | library
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Research collection
  const [sources, setSources] = useState([]); // [{id, type:'url'|'text'|'note', title, content, date}]
  const [urlInput, setUrlInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [topicAngle, setTopicAngle] = useState("");

  // Pipeline
  const [pipelineStage, setPipelineStage] = useState(0); // 0=idle, 1=research, 2=outline, 3=writing, 4=done
  const [researchAnalysis, setResearchAnalysis] = useState("");
  const [outline, setOutline] = useState("");
  const [draft, setDraft] = useState("");
  const [selectedFormat, setSelectedFormat] = useState("blog");

  // Chat refinement
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // Library (persistent)
  const [library, setLibrary] = useState({ sources: [], drafts: [], notes: [] });
  const [libLoaded, setLibLoaded] = useState(false);

  // Knowledge base note input
  const [noteInput, setNoteInput] = useState("");
  const [noteTitle, setNoteTitle] = useState("");

  // Error
  const [error, setError] = useState("");

  // Load library on mount
  useEffect(() => {
    loadLibrary().then((lib) => {
      setLibrary(lib);
      setLibLoaded(true);
    });
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ─── ACTIONS ───
  const addUrl = async () => {
    if (!urlInput.trim()) return;
    setFetchingUrl(true);
    setError("");
    try {
      const content = await fetchUrlContent(urlInput.trim());
      const src = { id: uid(), type: "url", title: urlInput.trim(), content, date: new Date().toISOString() };
      setSources((p) => [...p, src]);
      setUrlInput("");
    } catch (e) {
      setError(`URL fetch failed: ${e.message}`);
    }
    setFetchingUrl(false);
  };

  const addText = () => {
    if (!textInput.trim()) return;
    const src = { id: uid(), type: "text", title: textTitle || "Untitled paste", content: textInput, date: new Date().toISOString() };
    setSources((p) => [...p, src]);
    setTextInput("");
    setTextTitle("");
  };

  const addNote = () => {
    if (!noteInput.trim()) return;
    const note = { id: uid(), type: "note", title: noteTitle || "Note", content: noteInput, date: new Date().toISOString() };
    setSources((p) => [...p, note]);
    // Also save to KB
    const newLib = { ...library, notes: [...library.notes, note] };
    setLibrary(newLib);
    saveLibrary(newLib);
    setNoteInput("");
    setNoteTitle("");
  };

  const removeSource = (id) => setSources((p) => p.filter((s) => s.id !== id));

  const loadFromLibrary = (item) => {
    if (!sources.find((s) => s.id === item.id)) {
      setSources((p) => [...p, item]);
    }
  };

  const runPipeline = async () => {
    if (sources.length === 0) { setError("Add at least one source first."); return; }
    setError("");
    setView("pipeline");
    setPipelineStage(1);
    setResearchAnalysis("");
    setOutline("");
    setDraft("");

    const allContent = sources.map((s, i) => `--- SOURCE ${i + 1}: ${s.title} ---\n${s.content}`).join("\n\n");
    const angleStr = topicAngle ? `\n\nTOPIC/ANGLE: ${topicAngle}` : "";

    try {
      // Stage 1: Research
      const analysis = await callAgent(RESEARCH_AGENT, allContent + angleStr);
      setResearchAnalysis(analysis);
      setPipelineStage(2);

      // Stage 2: Outline
      const formatNote = `Output format requested: ${selectedFormat}`;
      const outlineResult = await callAgent(OUTLINE_AGENT, `RESEARCH ANALYSIS:\n${analysis}\n\n${formatNote}${angleStr}`);
      setOutline(outlineResult);
      setPipelineStage(3);

      // Stage 3: Writing
      const draftResult = await callAgent(WRITING_AGENT, `RESEARCH ANALYSIS:\n${analysis}\n\nOUTLINE:\n${outlineResult}\n\n${formatNote}${angleStr}`);
      setDraft(draftResult);
      setPipelineStage(4);
    } catch (e) {
      setError(`Pipeline failed at stage ${pipelineStage}: ${e.message}`);
      setPipelineStage(0);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const d = { id: uid(), title: topicAngle || "Untitled draft", content: draft, outline, analysis: researchAnalysis, date: new Date().toISOString(), format: selectedFormat };
    const newLib = { ...library, drafts: [...library.drafts, d] };
    setLibrary(newLib);
    saveLibrary(newLib);
  };

  const saveSourcesAll = () => {
    const newSources = sources.filter((s) => !library.sources.find((ls) => ls.id === s.id));
    if (newSources.length === 0) return;
    const newLib = { ...library, sources: [...library.sources, ...newSources] };
    setLibrary(newLib);
    saveLibrary(newLib);
  };

  const startRefine = () => {
    if (!draft) return;
    setChatMessages([{ role: "assistant", content: "I have your draft ready. What would you like to change? I can adjust tone, restructure sections, expand arguments, cut fluff, add examples, or rewrite specific parts." }]);
    setView("refine");
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    const newMessages = [...chatMessages, { role: "user", content: userMsg }];
    setChatMessages(newMessages);
    setChatLoading(true);

    try {
      const apiMessages = [
        { role: "user", content: `Here is the current draft:\n\n${draft}\n\n---\nThe user will now ask for edits.` },
        { role: "assistant", content: "I have the draft. What changes would you like?" },
        ...newMessages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const response = await callAgentChat(CHAT_REFINE, apiMessages);
      setChatMessages((p) => [...p, { role: "assistant", content: response }]);
      // If it looks like a full revision, update draft
      if (response.length > draft.length * 0.5) setDraft(response);
    } catch (e) {
      setChatMessages((p) => [...p, { role: "assistant", content: `Error: ${e.message}` }]);
    }
    setChatLoading(false);
  };

  const deleteLibItem = (category, id) => {
    const newLib = { ...library, [category]: library[category].filter((i) => i.id !== id) };
    setLibrary(newLib);
    saveLibrary(newLib);
  };

  const FORMATS = [
    { id: "blog", label: "Blog Post" },
    { id: "thread", label: "Thread" },
    { id: "newsletter", label: "Newsletter" },
    { id: "outline", label: "Outline Only" },
  ];

  const STAGES = [
    { n: 1, label: "Analyze", desc: "Extracting insights" },
    { n: 2, label: "Outline", desc: "Structuring arguments" },
    { n: 3, label: "Write", desc: "Drafting content" },
    { n: 4, label: "Done", desc: "Ready to refine" },
  ];

  const NAV = [
    { id: "collect", label: "Collect", icon: "◈" },
    { id: "pipeline", label: "Pipeline", icon: "◇" },
    { id: "refine", label: "Refine", icon: "◆" },
    { id: "library", label: "Library", icon: "▣" },
  ];

  return (
    <>
      <link href={FONTS} rel="stylesheet" />
      <style>{`
        * { margin:0; padding:0; box-sizing:border-box; }
        :root {
          --bg: #0A0A0C; --s1: #111114; --s2: #18181C; --s3: #1F1F25;
          --b1: #2A2A33; --b2: #3A3A47; --b3: #4A4A57;
          --t1: #EEEDF2; --t2: #B0ADB8; --t3: #7A7784; --t4: #4E4C56;
          --acc: #D4A853; --acc2: rgba(212,168,83,0.12); --acc3: rgba(212,168,83,0.06);
          --green: #6BCB8B; --red: #E87272; --blue: #72A8E8;
          --font: 'Overpass', sans-serif; --serif: 'Newsreader', serif; --mono: 'Overpass Mono', monospace;
        }
        body { background: var(--bg); color: var(--t1); font-family: var(--font); -webkit-font-smoothing: antialiased; }

        .shell { display: flex; height: 100vh; overflow: hidden; }

        /* ─ NAV ─ */
        .nav { width: 56px; background: var(--s1); border-right: 1px solid var(--b1); display: flex; flex-direction: column; align-items: center; padding: 16px 0; gap: 4px; flex-shrink: 0; }
        .nav-logo { font-family: var(--serif); font-size: 20px; color: var(--acc); margin-bottom: 20px; font-style: italic; }
        .nav-btn { width: 40px; height: 40px; border: none; background: none; color: var(--t3); font-size: 16px; border-radius: 8px; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; }
        .nav-btn:hover { background: var(--s2); color: var(--t2); }
        .nav-btn.active { background: var(--acc2); color: var(--acc); }
        .nav-label { font-size: 9px; letter-spacing: 0.5px; margin-top: -2px; }

        /* ─ SIDEBAR ─ */
        .sidebar { width: ${sidebarOpen ? 280 : 0}px; background: var(--s1); border-right: 1px solid var(--b1); overflow-y: auto; transition: width 0.2s; flex-shrink: 0; }
        .sidebar::-webkit-scrollbar { width: 4px; } .sidebar::-webkit-scrollbar-thumb { background: var(--b1); border-radius: 2px; }
        .sb-header { padding: 20px 16px 12px; display: flex; justify-content: space-between; align-items: center; }
        .sb-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--t4); font-weight: 600; }
        .sb-count { font-family: var(--mono); font-size: 11px; color: var(--t4); }
        .sb-item { padding: 10px 16px; border-bottom: 1px solid var(--b1); cursor: pointer; transition: background 0.15s; }
        .sb-item:hover { background: var(--s2); }
        .sb-item-title { font-size: 13px; color: var(--t2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
        .sb-item-meta { font-size: 10px; color: var(--t4); font-family: var(--mono); }
        .sb-item-type { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-family: var(--mono); text-transform: uppercase; margin-right: 6px; }
        .type-url { background: rgba(114,168,232,0.12); color: var(--blue); }
        .type-text { background: rgba(212,168,83,0.12); color: var(--acc); }
        .type-note { background: rgba(107,203,139,0.12); color: var(--green); }
        .sb-empty { padding: 24px 16px; text-align: center; color: var(--t4); font-size: 12px; }
        .sb-rm { opacity:0; float:right; background:none; border:none; color:var(--red); cursor:pointer; font-size:14px; }
        .sb-item:hover .sb-rm { opacity:1; }

        /* ─ MAIN ─ */
        .main { flex: 1; overflow-y: auto; padding: 32px 40px 80px; }
        .main::-webkit-scrollbar { width: 6px; } .main::-webkit-scrollbar-thumb { background: var(--b1); border-radius: 3px; }
        .page-title { font-family: var(--serif); font-size: 28px; color: var(--t1); margin-bottom: 4px; }
        .page-desc { font-size: 13px; color: var(--t3); margin-bottom: 28px; }

        .card { background: var(--s1); border: 1px solid var(--b1); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
        .card-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--t4); font-weight: 600; margin-bottom: 12px; }

        .input-row { display: flex; gap: 8px; margin-bottom: 12px; }
        .input { flex:1; background: var(--s2); border: 1px solid var(--b1); border-radius: 6px; padding: 10px 14px; color: var(--t1); font-family: var(--font); font-size: 13px; outline: none; transition: border-color 0.15s; }
        .input:focus { border-color: var(--b2); }
        .input::placeholder { color: var(--t4); }
        textarea.input { min-height: 120px; resize: vertical; line-height: 1.7; }

        .btn { padding: 10px 18px; border-radius: 6px; border: none; font-family: var(--font); font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; letter-spacing: 0.3px; }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-primary { background: var(--acc); color: var(--bg); }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
        .btn-secondary { background: var(--s3); color: var(--t2); border: 1px solid var(--b1); }
        .btn-secondary:hover:not(:disabled) { border-color: var(--b2); }
        .btn-ghost { background: none; color: var(--t3); border: 1px solid var(--b1); }
        .btn-ghost:hover { border-color: var(--b2); color: var(--t2); }
        .btn-sm { padding: 6px 12px; font-size: 11px; }
        .btn-green { background: rgba(107,203,139,0.15); color: var(--green); border: 1px solid rgba(107,203,139,0.2); }

        .format-row { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
        .format-chip { padding: 8px 16px; border-radius: 20px; border: 1px solid var(--b1); background: none; color: var(--t3); font-family: var(--font); font-size: 12px; cursor: pointer; transition: all 0.15s; }
        .format-chip:hover { border-color: var(--b2); color: var(--t2); }
        .format-chip.active { border-color: var(--acc); color: var(--acc); background: var(--acc2); }

        .error-box { padding: 10px 14px; background: rgba(232,114,114,0.08); border: 1px solid rgba(232,114,114,0.2); border-radius: 6px; color: var(--red); font-size: 12px; margin-bottom: 16px; }

        /* ─ PIPELINE ─ */
        .pipeline-stages { display: flex; gap: 0; margin-bottom: 24px; }
        .stage { flex: 1; padding: 16px; border: 1px solid var(--b1); background: var(--s1); position: relative; }
        .stage:first-child { border-radius: 10px 0 0 10px; }
        .stage:last-child { border-radius: 0 10px 10px 0; }
        .stage.active { border-color: var(--acc); background: var(--acc3); }
        .stage.done { border-color: rgba(107,203,139,0.3); background: rgba(107,203,139,0.04); }
        .stage-n { font-family: var(--mono); font-size: 10px; color: var(--t4); margin-bottom: 4px; }
        .stage.active .stage-n { color: var(--acc); }
        .stage.done .stage-n { color: var(--green); }
        .stage-label { font-size: 14px; font-weight: 600; color: var(--t3); }
        .stage.active .stage-label { color: var(--acc); }
        .stage.done .stage-label { color: var(--green); }
        .stage-desc { font-size: 10px; color: var(--t4); margin-top: 2px; }

        .stage-output { background: var(--s1); border: 1px solid var(--b1); border-radius: 10px; padding: 24px; white-space: pre-wrap; font-size: 13px; line-height: 1.8; max-height: 400px; overflow-y: auto; color: var(--t2); margin-bottom: 16px; }
        .stage-output::-webkit-scrollbar { width: 4px; } .stage-output::-webkit-scrollbar-thumb { background: var(--b1); border-radius: 2px; }
        .stage-output-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--t4); font-weight: 600; margin-bottom: 8px; }

        .spinner { display: inline-flex; gap: 6px; align-items: center; padding: 24px 0; }
        .dot { width: 5px; height: 5px; background: var(--acc); border-radius: 50%; animation: bounce 1.2s infinite; }
        .dot:nth-child(2) { animation-delay: 0.15s; }
        .dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes bounce { 0%,80%,100%{opacity:0.2;transform:scale(0.8)} 40%{opacity:1;transform:scale(1.3)} }

        /* ─ CHAT ─ */
        .chat-container { display: flex; flex-direction: column; height: calc(100vh - 140px); }
        .chat-messages { flex: 1; overflow-y: auto; padding-bottom: 16px; }
        .chat-messages::-webkit-scrollbar { width: 4px; } .chat-messages::-webkit-scrollbar-thumb { background: var(--b1); border-radius: 2px; }
        .chat-msg { margin-bottom: 16px; max-width: 85%; }
        .chat-msg.user { margin-left: auto; }
        .chat-bubble { padding: 12px 16px; border-radius: 12px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
        .chat-msg.user .chat-bubble { background: var(--acc2); color: var(--t1); border-bottom-right-radius: 4px; }
        .chat-msg.assistant .chat-bubble { background: var(--s2); color: var(--t2); border-bottom-left-radius: 4px; }
        .chat-role { font-size: 10px; color: var(--t4); margin-bottom: 4px; font-family: var(--mono); text-transform: uppercase; }
        .chat-msg.user .chat-role { text-align: right; }
        .chat-input-row { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--b1); }
        .chat-input { flex: 1; background: var(--s2); border: 1px solid var(--b1); border-radius: 8px; padding: 12px 16px; color: var(--t1); font-family: var(--font); font-size: 13px; outline: none; resize: none; }
        .chat-input:focus { border-color: var(--b2); }

        /* ─ LIBRARY ─ */
        .lib-section { margin-bottom: 32px; }
        .lib-section-title { font-family: var(--serif); font-size: 20px; color: var(--t2); margin-bottom: 12px; }
        .lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
        .lib-card { background: var(--s1); border: 1px solid var(--b1); border-radius: 10px; padding: 16px; cursor: pointer; transition: all 0.15s; position: relative; }
        .lib-card:hover { border-color: var(--b2); background: var(--s2); }
        .lib-card-title { font-size: 14px; font-weight: 500; color: var(--t1); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lib-card-preview { font-size: 12px; color: var(--t3); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .lib-card-date { font-size: 10px; color: var(--t4); font-family: var(--mono); margin-top: 8px; }
        .lib-del { position: absolute; top: 10px; right: 10px; background: none; border: none; color: var(--t4); cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.15s; }
        .lib-card:hover .lib-del { opacity: 1; }
        .lib-del:hover { color: var(--red); }
        .lib-empty { color: var(--t4); font-size: 13px; padding: 20px 0; }

        .action-bar { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

        @media (max-width: 768px) {
          .sidebar { display: none; }
          .main { padding: 20px 16px 60px; }
          .pipeline-stages { flex-direction: column; }
          .stage:first-child { border-radius: 10px 10px 0 0; }
          .stage:last-child { border-radius: 0 0 10px 10px; }
        }
      `}</style>

      <div className="shell">
        {/* NAV */}
        <nav className="nav">
          <div className="nav-logo">R</div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-btn ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)} title={n.label}>
              <div style={{ textAlign: "center" }}>
                <div>{n.icon}</div>
                <div className="nav-label">{n.label}</div>
              </div>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="nav-btn" onClick={() => setSidebarOpen((p) => !p)} title="Toggle sidebar" style={{ fontSize: 13 }}>
            {sidebarOpen ? "◁" : "▷"}
          </button>
        </nav>

        {/* SIDEBAR — active sources */}
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sb-header">
              <span className="sb-title">Active Sources</span>
              <span className="sb-count">{sources.length}</span>
            </div>
            {sources.length === 0 && <div className="sb-empty">No sources yet.<br />Add URLs, text, or notes.</div>}
            {sources.map((s) => (
              <div className="sb-item" key={s.id}>
                <button className="sb-rm" onClick={() => removeSource(s.id)}>×</button>
                <div><span className={`sb-item-type type-${s.type}`}>{s.type}</span></div>
                <div className="sb-item-title">{s.title}</div>
                <div className="sb-item-meta">{s.content.length.toLocaleString()} chars</div>
              </div>
            ))}
            {sources.length > 0 && (
              <div style={{ padding: "12px 16px" }}>
                <button className="btn btn-ghost btn-sm" style={{ width: "100%" }} onClick={saveSourcesAll}>
                  Save All to Library
                </button>
              </div>
            )}
          </aside>
        )}

        {/* MAIN */}
        <main className="main">
          {error && <div className="error-box">{error} <button style={{ float: "right", background: "none", border: "none", color: "var(--red)", cursor: "pointer" }} onClick={() => setError("")}>×</button></div>}

          {/* ═══ COLLECT VIEW ═══ */}
          {view === "collect" && (
            <>
              <h1 className="page-title">Collect Research</h1>
              <p className="page-desc">Add sources via URL, paste text, or write knowledge base notes.</p>

              {/* URL */}
              <div className="card">
                <div className="card-title">Fetch from URL</div>
                <div className="input-row">
                  <input className="input" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://..." onKeyDown={(e) => e.key === "Enter" && addUrl()} />
                  <button className="btn btn-primary" onClick={addUrl} disabled={fetchingUrl || !urlInput.trim()}>
                    {fetchingUrl ? "Fetching..." : "Fetch"}
                  </button>
                </div>
              </div>

              {/* Paste */}
              <div className="card">
                <div className="card-title">Paste Text</div>
                <input className="input" value={textTitle} onChange={(e) => setTextTitle(e.target.value)} placeholder="Title (optional)" style={{ marginBottom: 8, width: "100%" }} />
                <textarea className="input" value={textInput} onChange={(e) => setTextInput(e.target.value)} placeholder="Paste article text, excerpts, or notes..." style={{ width: "100%" }} />
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={addText} disabled={!textInput.trim()}>Add to Sources</button>
                </div>
              </div>

              {/* Knowledge Base Note */}
              <div className="card">
                <div className="card-title">Knowledge Base Note</div>
                <input className="input" value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Note title" style={{ marginBottom: 8, width: "100%" }} />
                <textarea className="input" value={noteInput} onChange={(e) => setNoteInput(e.target.value)} placeholder="Capture a personal insight, observation, or thesis..." style={{ width: "100%", minHeight: 80 }} />
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-green btn-sm" onClick={addNote} disabled={!noteInput.trim()}>Save to KB & Sources</button>
                </div>
              </div>

              {/* Topic & Format */}
              <div className="card">
                <div className="card-title">Topic / Angle</div>
                <input className="input" value={topicAngle} onChange={(e) => setTopicAngle(e.target.value)} placeholder='e.g. "Why most RAG implementations fail in production"' style={{ width: "100%", marginBottom: 16 }} />
                <div className="card-title">Output Format</div>
                <div className="format-row">
                  {FORMATS.map((f) => (
                    <button key={f.id} className={`format-chip ${selectedFormat === f.id ? "active" : ""}`} onClick={() => setSelectedFormat(f.id)}>{f.label}</button>
                  ))}
                </div>
              </div>

              <button className="btn btn-primary" style={{ width: "100%", padding: "14px" }} onClick={runPipeline} disabled={sources.length === 0}>
                Run Pipeline →
              </button>
            </>
          )}

          {/* ═══ PIPELINE VIEW ═══ */}
          {view === "pipeline" && (
            <>
              <h1 className="page-title">Agent Pipeline</h1>
              <p className="page-desc">Three agents work in sequence to transform research into a draft.</p>

              <div className="pipeline-stages">
                {STAGES.map((s) => (
                  <div key={s.n} className={`stage ${pipelineStage === s.n ? "active" : ""} ${pipelineStage > s.n ? "done" : ""}`}>
                    <div className="stage-n">{pipelineStage > s.n ? "✓" : `0${s.n}`}</div>
                    <div className="stage-label">{s.label}</div>
                    <div className="stage-desc">{pipelineStage === s.n ? s.desc + "..." : s.desc}</div>
                  </div>
                ))}
              </div>

              {pipelineStage > 0 && pipelineStage < 4 && (
                <div className="spinner"><div className="dot" /><div className="dot" /><div className="dot" /><span style={{ marginLeft: 8, color: "var(--t3)", fontSize: 13 }}>Agent {pipelineStage} working...</span></div>
              )}

              {researchAnalysis && (
                <>
                  <div className="stage-output-label">Research Analysis</div>
                  <div className="stage-output">{researchAnalysis}</div>
                </>
              )}

              {outline && (
                <>
                  <div className="stage-output-label">Content Outline</div>
                  <div className="stage-output">{outline}</div>
                </>
              )}

              {draft && (
                <>
                  <div className="stage-output-label">Final Draft</div>
                  <div className="stage-output" style={{ maxHeight: 500 }}>{draft}</div>
                  <div className="action-bar">
                    <button className="btn btn-primary" onClick={startRefine}>Refine in Chat →</button>
                    <button className="btn btn-green" onClick={saveDraft}>Save to Library</button>
                    <button className="btn btn-ghost" onClick={() => { navigator.clipboard.writeText(draft); }}>Copy Draft</button>
                  </div>
                </>
              )}

              {pipelineStage === 0 && !draft && (
                <div style={{ textAlign: "center", padding: 40, color: "var(--t4)" }}>
                  <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>◇</div>
                  <div>Go to Collect to add sources and run the pipeline.</div>
                </div>
              )}
            </>
          )}

          {/* ═══ REFINE VIEW ═══ */}
          {view === "refine" && (
            <>
              <h1 className="page-title">Refine Draft</h1>
              <p className="page-desc">Chat with the editor agent to iterate on your draft.</p>

              {!draft ? (
                <div style={{ textAlign: "center", padding: 40, color: "var(--t4)" }}>
                  <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>◆</div>
                  <div>Generate a draft first via the Pipeline.</div>
                </div>
              ) : (
                <div className="chat-container">
                  <div className="chat-messages">
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`chat-msg ${m.role}`}>
                        <div className="chat-role">{m.role === "user" ? "You" : "Editor"}</div>
                        <div className="chat-bubble">{m.content}</div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="chat-msg assistant">
                        <div className="chat-role">Editor</div>
                        <div className="chat-bubble"><div className="spinner" style={{ padding: 4 }}><div className="dot" /><div className="dot" /><div className="dot" /></div></div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                  <div className="chat-input-row">
                    <textarea className="chat-input" rows={2} value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Ask for changes... (e.g. make the opening more provocative)" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
                    <button className="btn btn-primary" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}>Send</button>
                  </div>
                  <div className="action-bar" style={{ marginTop: 8 }}>
                    <button className="btn btn-green btn-sm" onClick={saveDraft}>Save Draft</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(draft)}>Copy Latest</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ═══ LIBRARY VIEW ═══ */}
          {view === "library" && (
            <>
              <h1 className="page-title">Library</h1>
              <p className="page-desc">Your persistent collection of research, drafts, and knowledge base notes.</p>

              {!libLoaded ? (
                <div className="spinner"><div className="dot" /><div className="dot" /><div className="dot" /><span style={{ marginLeft: 8, color: "var(--t3)", fontSize: 13 }}>Loading library...</span></div>
              ) : (
                <>
                  <div className="lib-section">
                    <div className="lib-section-title">Drafts</div>
                    {library.drafts.length === 0 ? <div className="lib-empty">No saved drafts yet.</div> : (
                      <div className="lib-grid">
                        {library.drafts.map((d) => (
                          <div className="lib-card" key={d.id} onClick={() => { setDraft(d.content); setOutline(d.outline || ""); setResearchAnalysis(d.analysis || ""); setView("pipeline"); setPipelineStage(4); }}>
                            <button className="lib-del" onClick={(e) => { e.stopPropagation(); deleteLibItem("drafts", d.id); }}>×</button>
                            <div className="lib-card-title">{d.title}</div>
                            <div className="lib-card-preview">{d.content?.slice(0, 150)}</div>
                            <div className="lib-card-date">{new Date(d.date).toLocaleDateString()}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="lib-section">
                    <div className="lib-section-title">Research Sources</div>
                    {library.sources.length === 0 ? <div className="lib-empty">No saved sources.</div> : (
                      <div className="lib-grid">
                        {library.sources.map((s) => (
                          <div className="lib-card" key={s.id} onClick={() => loadFromLibrary(s)}>
                            <button className="lib-del" onClick={(e) => { e.stopPropagation(); deleteLibItem("sources", s.id); }}>×</button>
                            <span className={`sb-item-type type-${s.type}`}>{s.type}</span>
                            <div className="lib-card-title">{s.title}</div>
                            <div className="lib-card-preview">{s.content?.slice(0, 120)}</div>
                            <div className="lib-card-date">{new Date(s.date).toLocaleDateString()}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="lib-section">
                    <div className="lib-section-title">Knowledge Base</div>
                    {library.notes.length === 0 ? <div className="lib-empty">No knowledge base notes yet.</div> : (
                      <div className="lib-grid">
                        {library.notes.map((n) => (
                          <div className="lib-card" key={n.id} onClick={() => loadFromLibrary(n)}>
                            <button className="lib-del" onClick={(e) => { e.stopPropagation(); deleteLibItem("notes", n.id); }}>×</button>
                            <span className="sb-item-type type-note">note</span>
                            <div className="lib-card-title">{n.title}</div>
                            <div className="lib-card-preview">{n.content?.slice(0, 120)}</div>
                            <div className="lib-card-date">{new Date(n.date).toLocaleDateString()}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}
