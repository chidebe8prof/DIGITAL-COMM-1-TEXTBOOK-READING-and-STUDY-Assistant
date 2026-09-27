// ============================================================
// Foundational Principles ECS — AI Study Assistant Proxy Server
// ============================================================
// This server holds the real Anthropic API key so it never has to be
// shipped inside the distributed offline app. Deploy this separately
// (see README.md) and put its public URL into the app's Settings screen.
//
// Endpoints:
//   POST /ask            { question, section: {chapterNum, chapterTitle} | null, history, accessCode }
//   POST /quiz           { chapterNum, chapterTitle, accessCode }
//   POST /analyze-paper  multipart: file=<one file>, accessCode
//   POST /predict-exam   multipart: files=<two or more files>, accessCode
//   POST /mock-exam      { demand, chapterNum?, accessCode }
//   GET  /health

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mammoth = require("mammoth");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = require("docx");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const PORT = process.env.PORT || 3000;

// Comma-separated list of allowed access codes, e.g. "ECS2026,FPO-EEE-101"
// Leave ALLOWED_ACCESS_CODES unset in the environment to allow anyone (not recommended for production).
const ALLOWED_CODES = (process.env.ALLOWED_ACCESS_CODES || "").split(",").map(s => s.trim()).filter(Boolean);

// Simple per-identity daily request cap (resets when the server restarts; swap for a real
// database/Redis store if you need it to persist across restarts or scale to multiple instances).
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "40", 10);
const usage = new Map(); // key -> { count, day }

const BOOK = JSON.parse(fs.readFileSync(path.join(__dirname, "book_text.json"), "utf-8"));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// File-upload handling: kept in memory (not written to disk), capped per file and per request
// so a single upload can't blow past reasonable size or cost.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 }, // 15MB per file, up to 10 files per request
});

// ---------- Access control ----------
function checkAccess(req, res) {
  const code = (req.body && req.body.accessCode) || "";
  if (ALLOWED_CODES.length > 0 && !ALLOWED_CODES.includes(code)) {
    res.status(403).json({ error: "Invalid or missing access code. Ask your instructor for the correct code in Settings." });
    return null;
  }
  const identity = code || req.ip;
  const today = new Date().toISOString().slice(0, 10);
  const rec = usage.get(identity);
  if (!rec || rec.day !== today) {
    usage.set(identity, { count: 1, day: today });
    return identity;
  }
  if (rec.count >= DAILY_LIMIT) {
    res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} AI requests reached for today. Try again tomorrow, or keep using the app's fully offline features.` });
    return null;
  }
  rec.count += 1;
  return identity;
}

// ---------- Anthropic call helper ----------
async function callClaude(messages, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === "text");
  return textBlock ? textBlock.text : "";
}

// ---------- Simple whole-book keyword search (fallback when section context isn't enough) ----------
function keywordSearch(query, topN = 2) {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const scored = BOOK.map(ch => {
    const lower = ch.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const matches = lower.split(t).length - 1;
      score += matches;
    }
    return { ch, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).filter(s => s.score > 0).map(s => s.ch);
}

function chapterByNum(num) {
  return BOOK.find(c => c.number === num);
}

function truncate(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
}

// ---------- Converting an uploaded file into something Claude can read ----------
// Images and PDFs go to Claude directly (it reads them natively, including handwriting,
// diagrams, and scanned pages). Word documents need their text pulled out first, since the
// API doesn't accept .docx directly.
async function fileToContentBlock(file) {
  const mime = file.mimetype;
  if (mime.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: mime, data: file.buffer.toString("base64") } };
  }
  if (mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") } };
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.originalname.toLowerCase().endsWith(".docx")) {
    const { value: text } = await mammoth.extractRawText({ buffer: file.buffer });
    return { type: "text", text: `[Content extracted from uploaded Word document "${file.originalname}"]\n\n${text}` };
  }
  if (mime === "application/msword" || file.originalname.toLowerCase().endsWith(".doc")) {
    throw new Error(`"${file.originalname}" is an old-format .doc file, which can't be read directly. Please save it as .docx or a PDF and try again.`);
  }
  throw new Error(`"${file.originalname}" is not a supported file type. Please upload an image, a PDF, or a .docx Word document.`);
}

// ---------- Building a downloadable, editable Word document from the AI's answer ----------
const DOC_NAVY = "1F3864";
const DOC_GOLD = "B8860B";

function paragraphsFromPlainText(text) {
  const paragraphs = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Treat a short, numbered, all-on-one-line block as a sub-heading-ish lead-in (e.g. "Question 1")
    const isLikelyHeading = /^(Question\s*\d+|Q\d+|Part\s+[A-Z0-9]+|Section\s+[A-Z0-9]+)\b/i.test(trimmed) && trimmed.length < 60 && !trimmed.includes("\n");
    if (isLikelyHeading) {
      paragraphs.push(new Paragraph({
        spacing: { before: 240, after: 100 },
        children: [new TextRun({ text: trimmed, bold: true, color: DOC_NAVY, size: 24 })],
      }));
      continue;
    }
    const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
    paragraphs.push(new Paragraph({
      spacing: { after: 160, line: 276 },
      children: lines.flatMap((l, i) => i === 0 ? [new TextRun({ text: l, size: 22 })] : [new TextRun({ text: l, size: 22, break: 1 })]),
    }));
  }
  return paragraphs;
}

async function generateDocx(title, subtitle, bodyText) {
  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children: [
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: "Foundational Principles of Electronic Communication Systems", bold: true, color: DOC_NAVY, size: 20 })],
        }),
        new Paragraph({
          spacing: { after: 240 },
          border: { bottom: { color: DOC_GOLD, space: 4, style: BorderStyle.SINGLE, size: 12 } },
          children: [new TextRun({ text: subtitle, italics: true, color: DOC_GOLD, size: 18 })],
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 240 },
          children: [new TextRun({ text: title, bold: true, color: DOC_NAVY, size: 30 })],
        }),
        ...paragraphsFromPlainText(bodyText),
        new Paragraph({
          spacing: { before: 400 },
          border: { top: { color: "CCCCCC", space: 4, style: BorderStyle.SINGLE, size: 6 } },
          children: [new TextRun({ text: `Generated by the AI Study Assistant on ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Please review all content for accuracy.`, italics: true, size: 16, color: "666666" })],
        }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  return buffer.toString("base64");
}

// This chat window is plain text with no Markdown or LaTeX rendering, so equations must be
// written out the same plain-character way the textbook itself writes them.
const FORMATTING_RULES =
  "IMPORTANT FORMATTING RULES: This is a plain-text chat window with NO Markdown and NO LaTeX rendering. " +
  "Never use LaTeX syntax (no dollar signs, no \\frac, \\cos, \\times, \\sqrt, or any backslash commands, no $$ blocks). " +
  "Never use Markdown formatting (no **bold**, no ## headings, no bullet asterisks). " +
  "Write all equations as plain readable text exactly the way the textbook itself does, for example: " +
  "'Vc = Vcc + Vm cos 2\u03c0fmt', 'm = Vm / Vcc', or 'fo = 1 / (2\u03c0\u221a(LC))'. " +
  "Use \u221a for square roots, standard keyboard operators (+, -, \u00d7 or *, /, =), Greek letters written directly " +
  "(\u03c0, \u03b8, \u03bc) and subscripts attached directly to the variable name (Vcc, fm, fc) rather than underscore or LaTeX subscript notation. " +
  "Use plain numbered lists (1. 2. 3.) and line breaks for structure, never headings or bold markup.\n\n";

// ============================================================
// POST /ask
// ============================================================
app.post("/ask", async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;

    const { question, section, history } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing question." });
    }

    let contextChapters = [];
    let usedFallback = false;

    if (section && section.chapterNum) {
      const ch = chapterByNum(section.chapterNum);
      if (ch) contextChapters = [ch];
    }

    // Step 1: if we have a specific section, try answering from it alone first,
    // asking the model to flag if it genuinely can't from that context.
    if (contextChapters.length > 0) {
      const ctx = truncate(contextChapters[0].text, 60000);
      const probeMessages = [{
        role: "user",
        content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
          `A student is currently reading Chapter ${contextChapters[0].number}: ${contextChapters[0].title}. ` +
          `Answer their question using ONLY the chapter text below. If the question truly cannot be answered from this chapter ` +
          `(it's about a different topic covered elsewhere in the book), reply with exactly: NEEDS_WIDER_SEARCH\n\n` +
          FORMATTING_RULES +
          `--- CHAPTER TEXT ---\n${ctx}\n--- END CHAPTER TEXT ---\n\n` +
          `Student's question: ${question}`
      }];
      const answer = await callClaude(probeMessages, 700);
      if (!answer.trim().startsWith("NEEDS_WIDER_SEARCH")) {
        return res.json({ answer: answer.trim(), scope: `Chapter ${contextChapters[0].number}` });
      }
      usedFallback = true;
    }

    // Step 2: whole-book keyword search fallback (or default when no section was open)
    const matches = keywordSearch(question, 2);
    if (matches.length === 0) {
      // last resort: no strong keyword match, just use the currently open chapter if any, else the whole TOC
      const fallbackCtx = contextChapters.length
        ? contextChapters[0].text
        : BOOK.map(c => `Chapter ${c.number}: ${c.title}`).join("\n");
      const messages = [{
        role: "user",
        content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
          `Answer the student's question as well as you can. If you're not confident the book covers this, say so honestly.\n\n` +
          FORMATTING_RULES +
          `Available context:\n${truncate(fallbackCtx, 20000)}\n\nStudent's question: ${question}`
      }];
      const answer = await callClaude(messages, 700);
      return res.json({ answer: answer.trim(), scope: "best effort (no strong match found)" });
    }

    const combinedCtx = matches.map(ch => `### Chapter ${ch.number}: ${ch.title}\n${truncate(ch.text, 40000)}`).join("\n\n");
    const messages = [{
      role: "user",
      content: `You are a study assistant for the textbook "Foundational Principles of Electronic Communication Systems". ` +
        `Answer the student's question using the most relevant chapter(s) below. Mention which chapter your answer draws from.\n\n` +
        FORMATTING_RULES +
        `${combinedCtx}\n\nStudent's question: ${question}`
    }];
    const answer = await callClaude(messages, 800);
    return res.json({ answer: answer.trim(), scope: `whole-book search: ${matches.map(m => `Ch.${m.number}`).join(", ")}`, usedFallback });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong answering that question. Please try again." });
  }
});

// ============================================================
// POST /quiz
// ============================================================
app.post("/quiz", async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;

    const { chapterNum } = req.body;
    const ch = chapterByNum(chapterNum);
    if (!ch) return res.status(400).json({ error: "Unknown chapter." });

    const prompt = `You are creating a 5-question multiple-choice practice quiz for engineering students, based ONLY on the ` +
      `textbook chapter below (Chapter ${ch.number}: ${ch.title}, from "Foundational Principles of Electronic Communication Systems"). ` +
      `Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:\n` +
      `{"questions":[{"prompt":"...","options":[{"text":"...","correct":true},{"text":"...","correct":false},{"text":"...","correct":false},{"text":"...","correct":false}],"explanation":"..."}]}\n` +
      `Requirements: exactly 5 questions, exactly 4 options each with exactly one marked correct:true, questions should cover ` +
      `distinct parts of the chapter, explanations should be 1-2 sentences citing the relevant concept. ` +
      `Within the "prompt" and "explanation" text values, any equations must be written in plain readable characters only ` +
      `(no LaTeX, no dollar signs, no backslash commands) exactly the way the textbook itself writes them, e.g. 'Vc = Vcc + Vm cos 2\u03c0fmt' ` +
      `or 'fo = 1 / (2\u03c0\u221a(LC))', using \u221a for square roots and subscripts attached directly to variable names.\n\n` +
      `--- CHAPTER TEXT ---\n${truncate(ch.text, 80000)}\n--- END CHAPTER TEXT ---`;

    const raw = await callClaude([{ role: "user", content: prompt }], 2000);
    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: "The quiz generator returned an unexpected format. Please try again." });
    }
    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the quiz. Please try again." });
  }
});

// Shared instructions for exam-style outputs: same no-LaTeX/no-Markdown rule as chat,
// plus structure guidance since this text becomes a downloadable Word document.
const EXAM_FORMATTING_RULES = FORMATTING_RULES +
  "Structure your response with clear question labels (Question 1, Question 2, ...), each followed by its full worked " +
  "answer, and where marks are relevant, an explicit line 'Marking scheme: ...' breaking down how marks would be awarded " +
  "(e.g. '2 marks for correct formula, 3 marks for correct substitution and working, 1 mark for correct final answer with units'). " +
  "For mathematical questions, show full working step by step, not just the final answer.\n\n";

// ============================================================
// POST /analyze-paper — upload ONE question paper (image/PDF/Word), get full answers
// ============================================================
app.post("/analyze-paper", upload.single("file"), async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;
    if (!req.file) return res.status(400).json({ error: "No file was uploaded." });

    let block;
    try {
      block = await fileToContentBlock(req.file);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const instruction = `You are a study assistant for engineering students. The attached file is a question paper. ` +
      `Read every question on it and answer each one fully and correctly — theoretical questions with a clear, well-explained ` +
      `answer; mathematical/calculation questions with complete step-by-step working and a final answer with correct units. ` +
      `Number your answers to match the question numbers on the paper. If a question is unclear or partially cut off in the ` +
      `image/scan, say so plainly rather than guessing silently.\n\n` + EXAM_FORMATTING_RULES;

    const content = block.type === "text"
      ? [{ type: "text", text: instruction + block.text }]
      : [{ type: "text", text: instruction }, block];

    const answer = await callClaude([{ role: "user", content }], 3000);
    const docxBase64 = await generateDocx("Question Paper — Answers", `Analyzed from: ${req.file.originalname}`, answer.trim());
    res.json({ answer: answer.trim(), docx: docxBase64, filename: "Question_Paper_Answers.docx" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong analyzing that paper. Please try again." });
  }
});

// ============================================================
// POST /predict-exam — upload MULTIPLE years of past papers, get predicted questions
// ============================================================
app.post("/predict-exam", upload.array("files", 10), async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "Please upload at least two years of past question papers for a meaningful prediction." });
    }

    const blocks = [];
    for (const file of req.files) {
      try {
        blocks.push(await fileToContentBlock(file));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    const instruction = `You are a study assistant for engineering students. The attached files are ${req.files.length} years of past ` +
      `question papers for the same course. Study them for recurring topics, question patterns, and how often each topic reappears. ` +
      `Based on that pattern, produce a predicted set of 8-10 likely questions for the upcoming exam, covering the topics that ` +
      `recur most often across the years provided. For each predicted question, give: the question itself, a short note on why ` +
      `you predict it (e.g. "appeared in 3 of the 4 years provided"), a full worked answer, and a marking scheme. ` +
      `Be honest that this is a prediction based on patterns, not a guarantee of the actual exam content.\n\n` + EXAM_FORMATTING_RULES;

    const textBlocks = blocks.filter(b => b.type === "text");
    const mediaBlocks = blocks.filter(b => b.type !== "text");
    const combinedText = instruction + textBlocks.map(b => b.text).join("\n\n---\n\n");
    const content = [{ type: "text", text: combinedText }, ...mediaBlocks];

    const answer = await callClaude([{ role: "user", content }], 4000);
    const docxBase64 = await generateDocx("Predicted Exam Questions", `Based on ${req.files.length} years of past question papers`, answer.trim());
    res.json({ answer: answer.trim(), docx: docxBase64, filename: "Predicted_Exam_Questions.docx" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong analyzing those papers. Please try again, perhaps with fewer or smaller files." });
  }
});

// ============================================================
// POST /mock-exam — student types a topic/demand, gets a fresh practice exam
// ============================================================
app.post("/mock-exam", async (req, res) => {
  try {
    const identity = checkAccess(req, res);
    if (!identity) return;

    const { demand, chapterNum, numQuestions } = req.body;
    if (!demand || typeof demand !== "string" || !demand.trim()) {
      return res.status(400).json({ error: "Please describe what you'd like the mock exam to cover." });
    }
    const n = Math.min(Math.max(parseInt(numQuestions, 10) || 6, 3), 15);

    let contextText = "";
    if (chapterNum) {
      const ch = chapterByNum(parseInt(chapterNum, 10));
      if (ch) contextText = `Ground the questions in this chapter's content where relevant:\n\n${truncate(ch.text, 60000)}\n\n`;
    }
    if (!contextText) {
      const matches = keywordSearch(demand, 2);
      if (matches.length) {
        contextText = matches.map(ch => `### Chapter ${ch.number}: ${ch.title}\n${truncate(ch.text, 30000)}`).join("\n\n") + "\n\n";
      }
    }

    const prompt = `You are creating a mock exam for engineering students, in the style of "Foundational Principles of Electronic ` +
      `Communication Systems". The student's request for what to cover is: "${demand.trim()}". ` +
      `Produce ${n} exam-style questions matching that request — a realistic mix of theory questions and calculation/worked-example ` +
      `questions where the topic allows for it, not just multiple choice. For each question, give a full correct answer with complete ` +
      `working for any calculations, and a marking scheme breaking down how marks would be awarded.\n\n` +
      EXAM_FORMATTING_RULES +
      (contextText ? `Relevant textbook content to ground your questions in:\n\n${contextText}` : "No specific textbook chapter matched this request — use your own subject knowledge, staying consistent with standard electronic communication engineering curricula.");

    const answer = await callClaude([{ role: "user", content: prompt }], 4000);
    const docxBase64 = await generateDocx("Mock Exam", `Topic: ${demand.trim()}`, answer.trim());
    res.json({ answer: answer.trim(), docx: docxBase64, filename: "Mock_Exam.docx" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the mock exam. Please try again." });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", model: ANTHROPIC_MODEL, chapters: BOOK.length }));

// Friendly handling for multer errors (oversized file, too many files) instead of a raw crash/stack trace
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "That file is too large (15MB limit per file). Try a smaller scan or a lower-resolution photo." });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(413).json({ error: "Too many files at once (10 file limit). Try uploading fewer papers per request." });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => console.log(`Study-assistant server running on port ${PORT}`));
