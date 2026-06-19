# AegisVoice: Grounded Voice Mock Interview Practice Agent

AegisVoice is a professional voice-based technical interview agent that conducts structured mock interviews, listens to responses, provides guided follow-ups, and produces detailed evaluation feedback. The system is strictly grounded in a configurable reference Q&A set, ensuring consistent and rigorous grading.

---

## 🚀 Key Features

*   **🎙️ True Voice-to-Voice Pipeline**: Seamless Speech-to-Text (STT) and Text-to-Speech (TTS) integration.
*   **🧠 Grounded LLM Evaluator**: Grounded in a set of 10 core software engineering questions. The LLM evaluates responses against the reference key, keeping the interviewer consistent and targeted.
*   **🔄 Adaptive Conversational Flow**: The agent asks follow-up questions to probe technical gaps without giving away the ideal answer, transitioning to the next topic only when criteria are met.
*   **🛠️ Q&A Reference Manager**: An in-app UI to view, edit, add, or delete reference questions. All changes persist directly to the server's database (`questions.json`) without touching any code.
*   **⚙️ Dual-Engine Architecture (Zero-Setup Option)**:
    *   **Browser Built-in Engine**: Uses the browser's Web Speech API (`webkitSpeechRecognition` & `speechSynthesis`) for **zero latency and zero cost**, running entirely client-side without API keys.
    *   **OpenAI Cloud Engine**: Uses Whisper-1, GPT-4o-mini, and TTS-1 for premium human-like voices and high-accuracy speech processing (requires API key).
*   **📊 Performance Feedback Dashboard**: Evaluates the full transcript to generate an overall score, strengths, targeted improvements, and a question-by-question comparative analysis against the ideal key.
*   **🖥️ Grounding Logs Sidebar**: A real-time debug pane showing the active grounding topic, reference question, ideal answers, and the LLM's live assessment thoughts.

---

## 📁 Repository Structure

```text
├── backend/
│   ├── data/ 
│   │   └── questions.json     # Grounded Q&A Reference Database
│   ├── temp/                  # Temp storage for STT audio processing
│   ├── package.json
│   ├── server.js              # Express API Server (Chat, STT, TTS, Feedback)
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # React frontend state and views
│   │   ├── index.css          # Core CSS stylesheet (glassmorphism UI)
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── artifacts/
│   └── demo_recording.webp    # Browser interaction recording
├── architecture_note.md       # Technical design breakdown
└── README.md                  # This file
```

---

## 🛠️ How to Run Locally

### 1. Prerequisites
Ensure you have **Node.js** (v18 or higher) and **npm** installed on your system.

### 2. Configure Environment Variables (Optional)
If you want to use the cloud-based **OpenAI Engine** (Whisper and realistic TTS voices), create a `.env` file inside the `backend` folder:

```bash
# Create backend/.env
PORT=5000
OPENAI_API_KEY=your_actual_openai_api_key_here
```

*Note: If you do not want to hardcode the API key in the server, you can input it securely inside the web application's **Settings Modal** (cog icon in the top right), which saves it locally in your browser's `localStorage`.*

### 3. Alternative: Run as a Unified Single-Port Application (Recommended for Production)
Rather than launching two servers locally, you can compile the React frontend and let the Node.js server host both the frontend files and the backend API on the same port (`5000`):

```bash
# From the root directory:
npm run build
npm run start
```
Now, open your browser and navigate directly to **[http://localhost:5000](http://localhost:5000)**. 

---

## ☁️ Production Deployment Guide

AegisVoice is pre-configured to be deployed as a **single Node.js service** on platforms like **Render**, **Railway**, or **Heroku**. This is enabled by our root-level `package.json` coordinating building both packages, and the backend Express server serving the resulting static files.

### Deploying to Render (Free Web Service)
1.  Sign in to **[Render](https://render.com/)** and click **New > Web Service**.
2.  Connect your GitHub repository: `https://github.com/keshav9926/AegisVoice.git`.
3.  Configure the service with these settings:
    *   **Runtime**: `Node`
    *   **Build Command**: `npm run build`
    *   **Start Command**: `npm run start`
4.  Add your environment variables under the **Environment** tab:
    *   `PORT`: `10000` (Render's default port, or leave blank)
    *   `OPENAI_API_KEY`: *[Your OpenAI API Key]* (Optional: You can also leave this blank and let candidates input their keys directly in the frontend Settings cog, saving you API costs!).
5.  Click **Deploy Web Service**. Render will automatically run the build script, compile the React assets, and host the fully functioning voice agent under a free SSL-secured URL.

---

## 💡 How to Test the Agent

1.  **Launch the UI**: Open [http://localhost:5173/](http://localhost:5173/) (local Vite dev) or [http://localhost:5000](http://localhost:5000) (local unified) in your web browser (Google Chrome or Microsoft Edge recommended for built-in speech recognition support).
2.  **No API Key Mode (Quick Start)**:
    *   Set the **Interviewer Voice Engine** to **Web Speech API** on the Welcome screen.
    *   Click **Start Interview Practice**.
    *   The browser will speak the first question. Click the **Microphone** button, grant permission, and start speaking. Click it again to submit.
3.  **OpenAI Premium Mode**:
    *   Click the **Settings** cog in the top-right corner.
    *   Paste your **OpenAI API Key** (`sk-proj-...`).
    *   Select **OpenAI Whisper** and your favorite voice avatar (e.g., `Onyx` or `Nova`). Save and close.
    *   On the Welcome screen, choose **OpenAI TTS & Whisper** and click **Start**.
4.  **Edit the Grounding Q&A Set**:
    *   Click **Q&A Manager** in the header.
    *   Add a new question or modify an existing one (e.g., change the question text or ideal answer).
    *   Click **Save Changes** and notice how they are instantly written to `backend/data/questions.json` on the filesystem. Return to the dashboard and start the interview to see the agent ask your new question immediately!
5.  **Review Grounding Logs**:
    *   During the interview, watch the **Grounding Engine Logs** sidebar. It displays the exact question, ideal criteria, and live evaluation keywords the LLM is utilizing to assess your voice answer.
6.  **Get Feedback**:
    *   Answer the questions. Once you finish (or click **Complete & Evaluate**), you will see the **Feedback Dashboard** displaying your scores, summaries, strengths, and accordion dropdowns comparing your transcribed speech with the target answer sheet.

