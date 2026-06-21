import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ─── Directory Setup ─────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'temp');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `audio-${Date.now()}${path.extname(file.originalname) || '.webm'}`)
});
const upload = multer({ storage });

// ─── In-Memory Session Store ──────────────────────────────────────────────────
// Each session tracks all state server-side so the frontend cannot manipulate
// question progression directly.
//
// InterviewSession shape:
// {
//   sessionId: string,
//   currentQuestionIndex: number,
//   followUpCount: number,           // resets per question
//   activeQuestions: Question[],
//   transcript: {role, content}[],   // dialogue only (no grading metadata)
//   perQuestionScores: {             // accumulated during the interview
//     [questionId]: { score, coveredConcepts, missingConcepts }
//   },
//   startedAt: string (ISO)
// }
const sessions = new Map();

/** Auto-expire sessions after 2 hours to prevent memory leaks */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getOpenAIClient = (req) => {
  const authHeader = req.headers.authorization;
  let apiKey = process.env.OPENAI_API_KEY;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const clientKey = authHeader.substring(7).trim();
    if (clientKey && clientKey !== 'undefined' && clientKey !== 'null') {
      apiKey = clientKey;
    }
  }
  if (!apiKey) throw new Error('OpenAI API Key is missing. Please provide it in Settings or the server .env file.');
  return new OpenAI({ apiKey });
};

const readQuestions = () => {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading questions:', err);
    return [];
  }
};

const writeQuestions = (questions) => {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing questions:', err);
    return false;
  }
};

/** Fisher-Yates shuffle */
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Detect give-up phrases so backend can force-transition */
const GIVE_UP_PHRASES = [
  "i don't know", "i dont know", "skip", "pass", "no idea",
  "not sure", "i give up", "i'm not sure", "i am not sure", "next question"
];
const isGivingUp = (text) =>
  GIVE_UP_PHRASES.some(p => text.toLowerCase().includes(p));

// ─── Sandbox Evaluator (no API key) ──────────────────────────────────────────
// Uses the question's keyConcepts array for deterministic concept-level scoring.
const performSandboxEvaluation = (candidateAnswer, question, nextQuestion, followUpCount) => {
  const answerLower = (candidateAnswer || '').toLowerCase();

  // Prefer structured keyConcepts; fall back to topic-based heuristic keywords
  const keywords = (question.keyConcepts && question.keyConcepts.length > 0)
    ? question.keyConcepts.map(k => k.toLowerCase())
    : question.idealAnswer
        .toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 5)
        .slice(0, 8);

  const coveredConcepts = keywords.filter(w => answerLower.includes(w));
  const missingConcepts = keywords.filter(w => !answerLower.includes(w));

  // Score: each covered concept is worth an equal share of 100
  const score = keywords.length > 0
    ? Math.round((coveredConcepts.length / keywords.length) * 100)
    : 0;

  // Backend determines transition — LLM has no authority in sandbox mode
  const MAX_FOLLOW_UPS = 2;
  const giving_up = isGivingUp(candidateAnswer);
  const shouldTransition =
    score >= 60 ||
    followUpCount >= MAX_FOLLOW_UPS ||
    giving_up;

  let replyText;
  if (giving_up) {
    const hint = missingConcepts.slice(0, 2).join(' and ');
    replyText = nextQuestion
      ? `No worries. The key ideas here are ${hint || 'the core concepts'}. Let's move on: ${nextQuestion.question}`
      : `No worries. The key ideas were ${hint || 'the core concepts'}. That wraps up our session — click "Complete & Evaluate" to see your report!`;
  } else if (shouldTransition) {
    replyText = nextQuestion
      ? `Good. You covered ${coveredConcepts.slice(0, 3).join(', ') || 'the main points'}. Let's move on: ${nextQuestion.question}`
      : `Good work. That covers all our questions. Click "Complete & Evaluate" to see your feedback report!`;
  } else {
    const nudge = missingConcepts.slice(0, 2).join(' or ');
    replyText = `Interesting. Could you expand on ${nudge || 'that concept'} a bit more?`;
  }

  return {
    reply: replyText,
    evaluation: `[SANDBOX] Covered: ${coveredConcepts.join(', ') || 'none'}. Missing: ${missingConcepts.join(', ') || 'none'}. Score: ${score}/100.`,
    decision: shouldTransition ? 'transition' : 'follow_up',
    score,
    coveredConcepts,
    missingConcepts
  };
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// 1. Get reference questions
app.get('/api/questions', (req, res) => {
  res.json(readQuestions());
});

// 2. Save reference questions
app.post('/api/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions))
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  const success = writeQuestions(questions);
  if (success) res.json({ message: 'Questions updated successfully.', questions });
  else res.status(500).json({ error: 'Failed to save questions.' });
});

// 3. Start a new interview session (frontend calls this once on "Begin Interview")
// The backend shuffles questions, stores the session, and returns the first question.
app.post('/api/session/start', (req, res) => {
  try {
    const { interviewLength = 3 } = req.body;
    const allQuestions = readQuestions();
    if (allQuestions.length === 0)
      return res.status(400).json({ error: 'No reference questions available. Please add questions first.' });

    const selected = shuffle(allQuestions).slice(0, Math.min(interviewLength, allQuestions.length));

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const session = {
      sessionId,
      currentQuestionIndex: 0,
      followUpCount: 0,
      activeQuestions: selected,
      transcript: [],
      perQuestionScores: {},
      startedAt: new Date().toISOString()
    };
    sessions.set(sessionId, session);

    // Auto-expire session
    setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);

    const firstQuestion = selected[0];
    const openingMessage = `Hello! Welcome to your mock interview. I am your practice agent today, and we'll be reviewing some core software engineering concepts. Let's begin with our first question. ${firstQuestion.question}`;

    res.json({
      sessionId,
      currentQuestionIndex: 0,
      totalQuestions: selected.length,
      activeQuestions: selected,
      currentQuestion: firstQuestion,
      openingMessage
    });
  } catch (err) {
    console.error('Session start error:', err);
    res.status(500).json({ error: err.message || 'Failed to start interview session.' });
  }
});

// 4. Orchestrate a single interview turn (Chat)
// Frontend sends only { sessionId, candidateAnswer }.
// Backend owns all state: question index, follow-up count, scoring.
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, candidateAnswer } = req.body;

    if (!sessionId || !sessions.has(sessionId))
      return res.status(400).json({ error: 'Invalid or expired session. Please restart the interview.' });

    if (!candidateAnswer || !candidateAnswer.trim())
      return res.status(400).json({ error: 'Candidate answer cannot be empty.' });

    const session = sessions.get(sessionId);
    const { currentQuestionIndex, followUpCount, activeQuestions } = session;

    if (currentQuestionIndex >= activeQuestions.length)
      return res.status(400).json({ error: 'Interview already completed.' });

    const currentQuestion = activeQuestions[currentQuestionIndex];
    const nextQuestion = currentQuestionIndex + 1 < activeQuestions.length
      ? activeQuestions[currentQuestionIndex + 1]
      : null;

    // Append candidate turn to dialogue transcript
    session.transcript.push({ role: 'user', content: candidateAnswer });

    // ── Sandbox Mode (no API key) ──
    let openai, sandboxMode = false;
    try { openai = getOpenAIClient(req); } catch { sandboxMode = true; }

    if (sandboxMode) {
      const result = performSandboxEvaluation(candidateAnswer, currentQuestion, nextQuestion, followUpCount);

      // Accumulate score for this question
      session.perQuestionScores[currentQuestion.id] = {
        score: result.score,
        coveredConcepts: result.coveredConcepts,
        missingConcepts: result.missingConcepts
      };

      // Advance state on transition
      if (result.decision === 'transition') {
        session.currentQuestionIndex += 1;
        session.followUpCount = 0;
      } else {
        session.followUpCount += 1;
      }

      session.transcript.push({ role: 'assistant', content: result.reply });

      return res.json({
        reply: result.reply,
        evaluation: result.evaluation,
        decision: result.decision,
        score: result.score,
        coveredConcepts: result.coveredConcepts,
        missingConcepts: result.missingConcepts,
        currentQuestionIndex: session.currentQuestionIndex,
        followUpCount: session.followUpCount,
        groundedQuestion: currentQuestion
      });
    }

    // ── LLM Mode ──
    // Detect give-up so backend can force a transition regardless of LLM decision
    const candidateGaveUp = isGivingUp(candidateAnswer);

    // MAX follow-ups per question — backend enforces this ceiling
    const MAX_FOLLOW_UPS = 2;
    const forceTransition = followUpCount >= MAX_FOLLOW_UPS || candidateGaveUp;

    // Build a clean dialogue excerpt (last 6 turns only to keep prompt lean)
    const historyText = session.transcript
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'Candidate' : 'Interviewer'}: ${m.content}`)
      .join('\n');

    // Key concepts are injected as the primary grounding signal.
    // The full idealAnswer is intentionally withheld from the prompt to prevent leakage.
    const keyConcepts = (currentQuestion.keyConcepts || []).join(', ');
    const systemPrompt = `You are a professional, friendly technical interviewer conducting a mock Software Engineer screen.
Your replies MUST be natural, conversational, and concise (2-4 sentences max). No bullet points or markdown — this is spoken aloud.
Never reveal, quote, or paraphrase the stored reference answer or evaluation data to the candidate.
Behave like a professional interviewer: probe with natural questions, do not tutor.

ACTIVE QUESTION: "${currentQuestion.question}"
TOPIC: ${currentQuestion.topic}
KEY CONCEPTS TO ASSESS: ${keyConcepts}
FOLLOW-UPS USED SO FAR: ${followUpCount} of ${MAX_FOLLOW_UPS}
${nextQuestion ? `NEXT QUESTION (use only when transitioning): "${nextQuestion.question}"` : 'This is the FINAL question.'}
${forceTransition ? 'INSTRUCTION: The follow-up limit has been reached or the candidate gave up. You MUST set decision to "transition". Briefly acknowledge their answer, state the key concept they missed (without reading the reference), and move on.' : ''}

Evaluate the candidate's answer against the key concepts. Return STRICT JSON:
{
  "reply": "Your spoken reply (2-4 sentences, no markdown)",
  "evaluation": "Internal notes: which key concepts were covered and which were missed.",
  "decision": "follow_up" or "transition",
  "score": <integer 0-100 reflecting concept coverage>,
  "coveredConcepts": ["concept1", "concept2"],
  "missingConcepts": ["concept3", "concept4"]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Interview so far:\n${historyText}\n\nEvaluate the latest candidate turn and respond.` }
      ],
      response_format: { type: 'json_object' }
    });

    const llmResult = JSON.parse(response.choices[0].message.content);

    // ── Backend transition authority ──
    // The LLM recommends, but the backend decides based on hard rules.
    const llmScore = Math.max(0, Math.min(100, Number(llmResult.score) || 0));
    let finalDecision;
    if (forceTransition) {
      finalDecision = 'transition';
    } else if (llmScore >= 80) {
      finalDecision = 'transition'; // Strong answer → move on
    } else {
      finalDecision = llmResult.decision === 'transition' ? 'transition' : 'follow_up';
    }

    const coveredConcepts = Array.isArray(llmResult.coveredConcepts) ? llmResult.coveredConcepts : [];
    const missingConcepts = Array.isArray(llmResult.missingConcepts) ? llmResult.missingConcepts : [];

    // Accumulate per-question score (take best score seen across follow-ups)
    const existing = session.perQuestionScores[currentQuestion.id];
    if (!existing || llmScore > existing.score) {
      session.perQuestionScores[currentQuestion.id] = {
        score: llmScore,
        coveredConcepts,
        missingConcepts
      };
    }

    // Advance session state
    if (finalDecision === 'transition') {
      session.currentQuestionIndex += 1;
      session.followUpCount = 0;
    } else {
      session.followUpCount += 1;
    }

    session.transcript.push({ role: 'assistant', content: llmResult.reply });

    return res.json({
      reply: llmResult.reply,
      evaluation: llmResult.evaluation,
      decision: finalDecision,
      score: llmScore,
      coveredConcepts,
      missingConcepts,
      currentQuestionIndex: session.currentQuestionIndex,
      followUpCount: session.followUpCount,
      groundedQuestion: currentQuestion
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// 5. Speech-to-Text (STT) — unchanged
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: 'No audio file uploaded.' });
  try {
    let openai;
    try { openai = getOpenAIClient(req); } catch (err) {
      fs.unlinkSync(filePath);
      return res.status(401).json({ error: err.message });
    }
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1'
    });
    fs.unlinkSync(filePath);
    res.json({ text: transcription.text });
  } catch (error) {
    console.error('STT error:', error);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: error.message || 'Speech-to-Text transcription failed.' });
  }
});

// 6. Text-to-Speech (TTS) — unchanged
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'alloy' } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided for TTS.' });
    let openai;
    try { openai = getOpenAIClient(req); } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice, input: text });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error.message || 'Text-to-Speech synthesis failed.' });
  }
});

// 7. Generate Interview Feedback Report
// Uses accumulated per-question scores from the session when available.
app.post('/api/feedback', async (req, res) => {
  try {
    const { sessionId, messages, activeQuestions } = req.body;

    // Prefer session data for accumulated scores; fall back to legacy payload
    const session = sessionId ? sessions.get(sessionId) : null;
    const questions = (session?.activeQuestions) || activeQuestions || readQuestions();
    const len = questions.length;

    let openai, sandboxMode = false;
    try { openai = getOpenAIClient(req); } catch { sandboxMode = true; }

    if (sandboxMode) {
      const questionBreakdown = [];
      let totalScore = 0;

      // Use transcript from session if available, fall back to messages from body
      const dialogueMessages = session?.transcript || messages || [];
      const userAnswers = dialogueMessages.filter(m => m.role === 'user').map(m => m.content);

      for (let i = 0; i < len; i++) {
        const question = questions[i];
        const candidateAnswer = userAnswers[i] || 'No response recorded.';

        // Use accumulated session score if available, otherwise re-evaluate
        const accumulated = session?.perQuestionScores?.[question.id];
        let finalScore, coveredConcepts, missingConcepts;

        if (accumulated) {
          finalScore = accumulated.score;
          coveredConcepts = accumulated.coveredConcepts;
          missingConcepts = accumulated.missingConcepts;
        } else {
          const evalResult = performSandboxEvaluation(candidateAnswer, question, null, 0);
          finalScore = evalResult.score;
          coveredConcepts = evalResult.coveredConcepts;
          missingConcepts = evalResult.missingConcepts;
        }

        questionBreakdown.push({
          questionId: question.id,
          question: question.question,
          topic: question.topic,
          candidateAnswer,
          score: finalScore,
          coveredConcepts,
          missingConcepts,
          feedback: finalScore === 0
            ? `[SANDBOX] No relevant technical concepts detected for ${question.topic}. Review the key concepts: ${(question.keyConcepts || []).join(', ')}.`
            : `[SANDBOX] Covered: ${coveredConcepts.join(', ') || 'none'}. Missing: ${missingConcepts.join(', ') || 'none'}.`
        });

        totalScore += finalScore;
      }

      const overallScore = len > 0 ? Math.round(totalScore / len) : 0;
      const strengths = [];
      const improvements = [];

      questionBreakdown.forEach(item => {
        if (item.score >= 60) {
          strengths.push(`Solid coverage of ${item.topic} — hit ${item.coveredConcepts.length} key concept(s).`);
        } else if (item.score >= 24) {
          improvements.push(`Partial coverage of ${item.topic}. Missing: ${item.missingConcepts.slice(0, 3).join(', ')}.`);
        } else {
          improvements.push(`Needs study on ${item.topic} — missed most key concepts.`);
        }
      });

      if (strengths.length === 0) strengths.push('Completed the full evaluation sequence.');
      if (improvements.length === 0) improvements.push('Ensure answers include more domain-specific terminology.');

      return res.json({
        overallScore,
        summary: `[SANDBOX EVALUATION] Completed without an API key. Graded on concept coverage across ${len} question(s). Overall concept coverage score: ${overallScore}%.`,
        strengths,
        improvements,
        questionBreakdown
      });
    }

    // ── LLM Feedback Mode ──
    // Build transcript. Prefer session transcript; fall back to messages body.
    const dialogue = (session?.transcript || messages || [])
      .map(m => `${m.role === 'user' ? 'Candidate' : 'Interviewer'}: ${m.content}`)
      .join('\n');

    // Build per-question score context for the LLM
    const scoreContext = questions.map(q => {
      const s = session?.perQuestionScores?.[q.id];
      return {
        id: q.id,
        topic: q.topic,
        question: q.question,
        keyConcepts: q.keyConcepts || [],
        accumulatedScore: s?.score ?? null,
        coveredConcepts: s?.coveredConcepts ?? [],
        missingConcepts: s?.missingConcepts ?? []
      };
    });

    const feedbackPrompt = `You are a principal engineer and hiring manager reviewing a technical mock interview transcript.
The interview was grounded in these key concepts per question:
${JSON.stringify(scoreContext, null, 2)}

Analyze the candidate's performance. Where per-question scores are provided, use them as a strong signal.
Focus on: technical accuracy against key concepts, communication clarity, and adaptability to follow-ups.

Return STRICT JSON matching this schema:
{
  "overallScore": <0-100>,
  "summary": "Warm, constructive 3-4 sentence summary.",
  "strengths": ["2-3 specific strengths"],
  "improvements": ["2-3 specific areas to improve"],
  "questionBreakdown": [
    {
      "questionId": "q1",
      "question": "...",
      "topic": "...",
      "candidateAnswer": "Brief summary of what they said",
      "score": <0-100>,
      "coveredConcepts": ["concept1"],
      "missingConcepts": ["concept2"],
      "feedback": "Specific, constructive feedback."
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: feedbackPrompt },
        { role: 'user', content: `Interview transcript:\n${dialogue}\n\nGenerate the feedback report.` }
      ],
      response_format: { type: 'json_object' }
    });

    const report = JSON.parse(response.choices[0].message.content);
    res.json(report);

  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate feedback report.' });
  }
});

// ─── Static File Serving ──────────────────────────────────────────────────────
const frontendBuildPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    } else {
      next();
    }
  });
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AegisVoice backend running on http://localhost:${PORT}`);
});

// ─── Periodic Cleanup ─────────────────────────────────────────────────────────
setInterval(() => {
  try {
    if (fs.existsSync(UPLOAD_DIR)) {
      const now = Date.now();
      fs.readdirSync(UPLOAD_DIR).forEach(file => {
        const filePath = path.join(UPLOAD_DIR, file);
        if (now - fs.statSync(filePath).mtimeMs > 3600000) {
          fs.unlinkSync(filePath);
          console.log(`[CLEANUP] Deleted stale upload: ${file}`);
        }
      });
    }
  } catch (err) {
    console.error('[CLEANUP] Error:', err);
  }
}, 600000);
