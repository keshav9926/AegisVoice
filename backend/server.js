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

// Middleware
app.use(cors());
app.use(express.json());

// Set up directories
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'temp');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `audio-${Date.now()}${path.extname(file.originalname) || '.webm'}`);
  }
});
const upload = multer({ storage });

// Helper to get OpenAI client
const getOpenAIClient = (req) => {
  // Check authorization header first
  const authHeader = req.headers.authorization;
  let apiKey = process.env.OPENAI_API_KEY;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const clientKey = authHeader.substring(7).trim();
    if (clientKey && clientKey !== 'undefined' && clientKey !== 'null') {
      apiKey = clientKey;
    }
  }

  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please provide it in settings or the server .env file.');
  }

  return new OpenAI({ apiKey });
};

// Helper to read questions
const readQuestions = () => {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) {
      return [];
    }
    const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading questions:', error);
    return [];
  }
};

// Helper to write questions
const writeQuestions = (questions) => {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing questions:', error);
    return false;
  }
};

// Endpoints

// 1. Get reference questions
app.get('/api/questions', (req, res) => {
  const questions = readQuestions();
  res.json(questions);
});

// 2. Save reference questions (updates questions.json)
app.post('/api/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }
  const success = writeQuestions(questions);
  if (success) {
    res.json({ message: 'Questions updated successfully.', questions });
  } else {
    res.status(500).json({ error: 'Failed to save questions.' });
  }
});

// Helper to perform local evaluation in Sandbox Mode (without API Key)
const performSandboxEvaluation = (candidateAnswer, currentQuestion, nextQuestion) => {
  const answerLower = (candidateAnswer || '').toLowerCase();
  const topic = (currentQuestion.topic || '').toLowerCase();
  
  // Extract key terms based on common topics
  let keywords = [];
  if (topic.includes('state') || topic.includes('redux') || topic.includes('context')) {
    keywords = ['redux', 'context', 'prop', 'render', 'performance', 'store', 'state', 're-render', 'middleware'];
  } else if (topic.includes('rest') || topic.includes('graphql')) {
    keywords = ['endpoint', 'graphql', 'query', 'over-fetching', 'under-fetching', 'cache', 'schema', 'rest'];
  } else if (topic.includes('index') || topic.includes('database')) {
    keywords = ['index', 'b-tree', 'write', 'read', 'scan', 'performance', 'storage', 'table', 'seek'];
  } else if (topic.includes('security') || topic.includes('xss') || topic.includes('csrf')) {
    keywords = ['xss', 'csrf', 'script', 'injection', 'cookie', 'token', 'samesite', 'sanitize'];
  } else if (topic.includes('loop') || topic.includes('event')) {
    keywords = ['event', 'loop', 'stack', 'microtask', 'macrotask', 'promise', 'callback', 'queue', 'thread'];
  } else if (topic.includes('cors')) {
    keywords = ['cors', 'origin', 'preflight', 'options', 'header', 'browser', 'security'];
  } else if (topic.includes('virtual dom') || topic.includes('reconciliation') || topic.includes('react')) {
    keywords = ['virtual', 'dom', 'diffing', 'reconciliation', 'key', 'render', 'list', 'patch'];
  } else if (topic.includes('idempotent') || topic.includes('status')) {
    keywords = ['idempotent', 'get', 'put', 'post', 'delete', '201', '400', '500', 'status', 'code'];
  } else if (topic.includes('flexbox') || topic.includes('grid') || topic.includes('css')) {
    keywords = ['flexbox', 'grid', 'dimension', 'navbar', 'layout', 'align', 'overlap'];
  } else if (topic.includes('cache') || topic.includes('system')) {
    keywords = ['cache', 'redis', 'aside', 'through', 'invalidation', 'ttl', 'database', 'eviction'];
  } else {
    keywords = currentQuestion.idealAnswer
      .toLowerCase()
      .replace(/[^a-zA-Z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 5);
  }

  // Count matches
  const matches = keywords.filter(word => answerLower.includes(word));
  
  // Calculate a score (base 40% + 15% per matched keyword, capped at 100)
  const score = Math.min(40 + (matches.length * 15), 100);

  // Transition if score is >= 60 (at least 2 matching key terms) or user answered thoroughly
  const isTransition = score >= 60 || answerLower.length > 110;

  let replyText = "";
  if (isTransition) {
    if (nextQuestion) {
      replyText = `Understood. You touched on key concepts like ${matches.length > 0 ? matches.slice(0, 3).join(', ') : 'the core mechanisms'}. Let's move on to the next question: ${nextQuestion.question}`;
    } else {
      replyText = `Perfect. That wraps up all the questions in our screening list. Thank you for your time. You can now click "Complete & Evaluate" to view your feedback report!`;
    }
  } else {
    replyText = `I see. Could you expand a bit more on this topic? Specifically, how does it relate to ${keywords.slice(0, 2).join(' or ')}?`;
  }

  return {
    reply: replyText,
    evaluation: `[SANDBOX MODE - FREE TRIAL] Candidate answer analyzed for keyword overlap. Matches found: ${matches.length > 0 ? matches.join(', ') : 'none'}. Calculated score: ${score}/100.`,
    decision: isTransition ? 'transition' : 'follow_up',
    score: score
  };
};

// 3. Orchestrate Interview Turn (Chat)
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, currentQuestionIndex, interviewLength } = req.body;
    const questions = readQuestions();
    const len = Math.min(interviewLength || 3, questions.length);

    if (questions.length === 0) {
      return res.status(400).json({ error: 'No reference questions available. Please add questions first.' });
    }

    if (currentQuestionIndex < 0 || currentQuestionIndex >= len) {
      return res.status(400).json({ error: 'Invalid question index.' });
    }

    const currentQuestion = questions[currentQuestionIndex];
    const nextQuestion = currentQuestionIndex + 1 < len ? questions[currentQuestionIndex + 1] : null;

    // Check for OpenAI API Key, fallback to local sandbox mode if not configured
    let openai;
    let sandboxMode = false;
    try {
      openai = getOpenAIClient(req);
    } catch (err) {
      sandboxMode = true;
    }

    // Get the latest candidate message text
    const latestUserMessage = messages
      .filter(m => m.role === 'user')
      .slice(-1)[0]?.content || '';

    if (sandboxMode) {
      const result = performSandboxEvaluation(latestUserMessage, currentQuestion, nextQuestion);
      return res.json({
        reply: result.reply,
        evaluation: result.evaluation,
        decision: result.decision,
        groundedQuestion: currentQuestion
      });
    }

    // Format conversation history for prompt
    const historyText = messages
      .slice(-6) // Only look at last few messages to stay fast and direct
      .map(m => `${m.role === 'user' ? 'Candidate' : 'Interviewer'}: ${m.content}`)
      .join('\n');

    const systemPrompt = `You are a professional, friendly, and seasoned technical interviewer conducting a mock screen for a Software Engineer position.
You are interacting with the candidate via VOICE, so your replies MUST be natural, conversational, and concise (2-4 sentences max). Avoid lists, bullet points, or markdown formatting, as they are hard to read aloud.
Do NOT read the ideal reference answer to the candidate verbatim. You must never leak or quote it directly.

You are grounded in a reference Q&A set.
Active Question: "${currentQuestion.question}"
Ideal Reference Answer: "${currentQuestion.idealAnswer}"
${nextQuestion ? `Next Question (if transitioning): "${nextQuestion.question}"` : 'This is the final question of the interview.'}

Your task:
1. Evaluate the candidate's last answer against the Ideal Reference Answer.
2. Decide on the next step:
   - "follow_up": If the candidate missed key concepts or has minor errors, ask a natural, conversational follow-up to nudge or guide them without giving the answer away directly. Keep them on track.
   - "transition": If they answered well, OR if they are completely stuck/wrong (in which case, briefly explain the correct concept yourself), OR if you have already asked a follow-up and want to move on.
3. If you decide to "transition":
   - Your reply must acknowledge their previous answer, briefly state the key takeaway if necessary, and then transition naturally to the Next Question (if one is available).
   - If no questions remain, warmly conclude the interview and tell them they can view their feedback dashboard now.

Provide your response in strict JSON format:
{
  "reply": "Your spoken reply to the candidate (2-4 sentences max, clean conversational text)",
  "evaluation": "Internal evaluation of their response against the ideal answer. Note what was correct and what was missing.",
  "decision": "follow_up" or "transition"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the interview flow so far:\n${historyText}\nPlease evaluate the latest candidate turn and reply.` }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    
    // Send back the response, evaluation, and which question it was grounded on
    res.json({
      reply: result.reply,
      evaluation: result.evaluation,
      decision: result.decision,
      groundedQuestion: currentQuestion
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// 4. Speech-to-Text (STT) using Whisper
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  try {
    let openai;
    try {
      openai = getOpenAIClient(req);
    } catch (err) {
      fs.unlinkSync(filePath); // clean up
      return res.status(401).json({ error: err.message });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
    });

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json({ text: transcription.text });
  } catch (error) {
    console.error('STT error:', error);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: error.message || 'Speech-to-Text transcription failed.' });
  }
});

// 5. Text-to-Speech (TTS) using OpenAI TTS
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'alloy' } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided for TTS.' });
    }

    let openai;
    try {
      openai = getOpenAIClient(req);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice, // alloy, echo, fable, onyx, nova, shimmer
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error.message || 'Text-to-Speech synthesis failed.' });
  }
});

// 6. Generate Interview Feedback Report
app.post('/api/feedback', async (req, res) => {
  try {
    const { messages, interviewLength } = req.body;
    const questions = readQuestions();
    const len = Math.min(interviewLength || 3, questions.length);

    // Check for OpenAI API Key, fallback to local sandbox mode if not configured
    let openai;
    let sandboxMode = false;
    try {
      openai = getOpenAIClient(req);
    } catch (err) {
      sandboxMode = true;
    }

    if (sandboxMode) {
      // Generate a mock report based on keyword matching
      const questionBreakdown = [];
      let totalScore = 0;

      // Extract user messages
      const userAnswers = messages
        .filter(m => m.role === 'user')
        .map(m => m.content);

      for (let i = 0; i < len; i++) {
        const question = questions[i];
        const candidateAnswer = userAnswers[i] || "No response recorded.";
        
        // Evaluate candidate answer using sandbox engine
        const evalResult = performSandboxEvaluation(candidateAnswer, question, null);
        
        // Ensure passing grades feel constructive
        const finalScore = evalResult.decision === 'transition' ? Math.max(75, evalResult.score) : evalResult.score;

        questionBreakdown.push({
          question: question.question,
          topic: question.topic,
          candidateAnswer: candidateAnswer,
          referenceAnswer: question.idealAnswer,
          score: finalScore,
          feedback: `[SANDBOX MODE] Evaluated without an API key. Your answer matched terms related to ${question.topic}. Match feedback: ${evalResult.evaluation}`
        });

        totalScore += finalScore;
      }

      const overallScore = Math.round(totalScore / len);
      
      const strengths = [];
      const improvements = [];

      questionBreakdown.forEach(item => {
        if (item.score >= 70) {
          strengths.push(`Showed solid keyword coverage for ${item.topic}.`);
        } else {
          improvements.push(`Provide more terminology and details on ${item.topic}.`);
        }
      });

      if (strengths.length === 0) strengths.push("Completed the evaluation sequence.");
      if (improvements.length === 0) improvements.push("Ensure you cover more technical terminology in mock replies.");

      const report = {
        overallScore,
        summary: `[SANDBOX EVALUATION] You completed the interview in Sandbox Mode (without a configured API key). The agent graded your answers dynamically based on keyword matches against our reference database. Your keyword coverage score was ${overallScore}%.`,
        strengths,
        improvements,
        questionBreakdown
      };

      return res.json(report);
    }

    const conversationText = messages
      .map(m => `${m.role === 'user' ? 'Candidate' : 'Interviewer'}: ${m.content}`)
      .join('\n');

    const feedbackPrompt = `You are a principal engineer and hiring manager. Review the following transcript of a technical mock interview.
The interview was grounded in a subset of these questions:
${JSON.stringify(questions.slice(0, len), null, 2)}

Please analyze the candidate's performance across the entire interview. Focus on:
1. Core technical accuracy (against the reference answers).
2. Communication clarity and structure.
3. How they handled follow-up questions (adaptability).

Return a structured JSON report matching this schema:
{
  "overallScore": 82, // Score out of 100
  "summary": "Warm, constructive summary of the candidate's performance. (3-4 sentences)",
  "strengths": [
    "List 2-3 specific areas where the candidate demonstrated strong understanding or skills."
  ],
  "improvements": [
    "List 2-3 specific areas/topics where the candidate was weak or missed important details."
  ],
  "questionBreakdown": [
    {
      "question": "The question text",
      "topic": "The topic name",
      "candidateAnswer": "Summary of the candidate's answer",
      "referenceAnswer": "The reference answer criteria",
      "score": 85, // Score out of 100 for this question
      "feedback": "Specific feedback for this answer, noting what they did well and what they missed."
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // Use a stronger model for rich evaluation feedback
      messages: [
        { role: 'system', content: feedbackPrompt },
        { role: 'user', content: `Here is the interview transcript:\n${conversationText}\n\nGenerate the feedback report.` }
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

// Serve static files from the React app build folder if it exists
const frontendBuildPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
  
  // Handle SPA routing - return index.html for all other non-API routes
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    } else {
      next();
    }
  });
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

