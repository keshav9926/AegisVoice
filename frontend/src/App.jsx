import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, MicOff, Settings, Play, Square, Volume2, VolumeX, FileText, 
  CheckCircle, AlertCircle, Trash2, Plus, ChevronDown, ChevronUp, 
  ArrowLeft, Edit3, Save, RefreshCw, Eye, EyeOff, BookOpen, Sparkles
} from 'lucide-react';

const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:5000'
  : window.location.origin;


function App() {
  // --- STATE VARIABLES ---
  const [currentScreen, setCurrentScreen] = useState('welcome'); // welcome | interview | feedback | qa_manager
  const [questions, setQuestions] = useState([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [interviewLength, setInterviewLength] = useState(3);
  const [messages, setMessages] = useState([]);
  const [activeQuestions, setActiveQuestions] = useState([]);
  
  // API settings
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('openai_api_key') || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState('browser'); // openai | browser
  const [sttEngine, setSttEngine] = useState('browser'); // whisper | browser
  const [voiceName, setVoiceName] = useState('alloy'); // alloy, echo, fable, onyx, nova, shimmer for OpenAI
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedBrowserVoice, setSelectedBrowserVoice] = useState(() => localStorage.getItem('selected_browser_voice') || '');
  
  // Status states
  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isPlayingVoice, setIsPlayingVoice] = useState(false);
  const [statusText, setStatusText] = useState('Idle'); // Idle, Listening, Speaking, Thinking
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  
  // Text-input fallback
  const [showTextFallback, setShowTextFallback] = useState(false);
  const [textAnswer, setTextAnswer] = useState('');

  // Debug Panel / Grounding view
  const [showDebugPanel, setShowDebugPanel] = useState(true);

  // Q&A Editor states
  const [editingQuestionId, setEditingQuestionId] = useState(null);
  const [editTopic, setEditTopic] = useState('');
  const [editQuestionText, setEditQuestionText] = useState('');
  const [editIdealAnswer, setEditIdealAnswer] = useState('');
  const [newQuestionTopic, setNewQuestionTopic] = useState('');
  const [newQuestionText, setNewQuestionText] = useState('');
  const [newQuestionIdealAnswer, setNewQuestionIdealAnswer] = useState('');

  // Feedback states
  const [feedbackReport, setFeedbackReport] = useState(null);
  const [expandedFeedbackQuestion, setExpandedFeedbackQuestion] = useState(null);

  // Modals
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // --- REFS ---
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const canvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const animationFrameRef = useRef(null);
  const currentAudioRef = useRef(null);
  const chatBottomRef = useRef(null);
  const micStreamRef = useRef(null);
  
  // Browser SpeechSynthesis / SpeechRecognition
  const recognitionRef = useRef(null);
  const activeUtteranceRef = useRef(null);
  const latestSpeechTextRef = useRef('');
  const isRecordingRef = useRef(false);
  const accumulatedSpeechTextRef = useRef('');
  const speechRestartCountRef = useRef(0);
  const lastSpeechRestartTimeRef = useRef(0);
  const synthesisIntervalRef = useRef(null);

  // --- INITIALIZATION ---
  useEffect(() => {
    fetchQuestions();
    
    // Just verify if SpeechRecognition is supported in browser
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition is not supported in this browser.');
    }

    // Load available voices for Browser Synthesis
    const updateVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
      if (voices.length > 0 && !localStorage.getItem('selected_browser_voice')) {
        const defaultVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
                             voices.find(v => v.lang.startsWith('en')) || 
                             voices[0];
        if (defaultVoice) {
          setSelectedBrowserVoice(defaultVoice.name);
          localStorage.setItem('selected_browser_voice', defaultVoice.name);
        }
      }
    };

    updateVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  // Save API key to localStorage when changed
  useEffect(() => {
    localStorage.setItem('openai_api_key', apiKey);
  }, [apiKey]);

  // Scroll chat to bottom when messages update
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isThinking]);

  // Cleanup audio on screen changes
  useEffect(() => {
    return () => {
      stopVoicePlayback();
    };
  }, [currentScreen]);

  // --- API CALLS ---

  const fetchQuestions = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/questions`);
      if (!res.ok) throw new Error('Failed to fetch reference questions.');
      const data = await res.json();
      setQuestions(data);
    } catch (err) {
      setErrorMessage(err.message);
    }
  };

  const saveQuestions = async (updatedQuestions) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedQuestions)
      });
      if (!res.ok) throw new Error('Failed to update questions on server.');
      const data = await res.json();
      setQuestions(data.questions);
      setSuccessMessage('Questions database updated successfully.');
      setTimeout(() => setSuccessMessage(''), 3000);
      return true;
    } catch (err) {
      setErrorMessage(err.message);
      return false;
    }
  };

  // --- AUDIO UTILITIES ---

  const playVoice = async (text) => {
    stopVoicePlayback();
    setIsPlayingVoice(true);
    setStatusText('Speaking');

    if (voiceEngine === 'browser') {
      // Browser SpeechSynthesis
      // Chrome speech engine fixes:
      // 1. Cancel previous speech
      window.speechSynthesis.cancel();
      
      // 2. Create utterance
      const utterance = new SpeechSynthesisUtterance(text);
      activeUtteranceRef.current = utterance; // Prevent garbage collection (Chromium bug)
      
      // 3. Find selected or preferred voice
      const preferredVoice = availableVoices.find(v => v.name === selectedBrowserVoice) ||
                            availableVoices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
                            availableVoices.find(v => v.lang.startsWith('en')) || 
                            availableVoices[0];
      if (preferredVoice) utterance.voice = preferredVoice;

      // Keep-alive timer to prevent Chrome SpeechSynthesis boundary bugs (sudden pausing after 15s)
      synthesisIntervalRef.current = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 10000);

      // 4. Setup safety timeout in case browser never fires onend
      const safetyDuration = Math.max(8000, text.length * 80); 
      const safetyTimeout = setTimeout(() => {
        console.warn('SpeechSynthesis safety timeout triggered.');
        if (synthesisIntervalRef.current) {
          clearInterval(synthesisIntervalRef.current);
          synthesisIntervalRef.current = null;
        }
        setIsPlayingVoice(false);
        setStatusText(curr => curr === 'Speaking' ? 'Idle' : curr);
      }, safetyDuration);
      
      utterance.onend = () => {
        clearTimeout(safetyTimeout);
        if (synthesisIntervalRef.current) {
          clearInterval(synthesisIntervalRef.current);
          synthesisIntervalRef.current = null;
        }
        setIsPlayingVoice(false);
        setStatusText(curr => curr === 'Speaking' ? 'Idle' : curr);
      };
      
      utterance.onerror = (e) => {
        console.error('SpeechSynthesis error:', e);
        clearTimeout(safetyTimeout);
        if (synthesisIntervalRef.current) {
          clearInterval(synthesisIntervalRef.current);
          synthesisIntervalRef.current = null;
        }
        setIsPlayingVoice(false);
        setStatusText(curr => curr === 'Speaking' ? 'Idle' : curr);
      };
      
      // 5. Speak with a small 100ms delay to let the cancel instruction flush the audio stack
      setTimeout(() => {
        window.speechSynthesis.speak(utterance);
      }, 100);
    } else {
      // OpenAI TTS Cloud
      if (!apiKey) {
        setErrorMessage('OpenAI API Key is required for Cloud TTS. Falling back to Browser TTS.');
        setVoiceEngine('browser');
        playVoice(text);
        return;
      }

      try {
        const res = await fetch(`${API_BASE_URL}/api/tts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({ text, voice: voiceName })
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'TTS synthesis failed.');
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioRef.current = audio;

        audio.onended = () => {
          setIsPlayingVoice(false);
          setStatusText(curr => curr === 'Speaking' ? 'Idle' : curr);
          URL.revokeObjectURL(url);
        };

        audio.onerror = () => {
          setIsPlayingVoice(false);
          setStatusText(curr => curr === 'Speaking' ? 'Idle' : curr);
          URL.revokeObjectURL(url);
        };

        await audio.play();
      } catch (err) {
        setErrorMessage(`TTS Error: ${err.message}. Falling back to Browser TTS.`);
        setVoiceEngine('browser');
        playVoice(text);
      }
    }
  };

  const stopVoicePlayback = () => {
    if (synthesisIntervalRef.current) {
      clearInterval(synthesisIntervalRef.current);
      synthesisIntervalRef.current = null;
    }
    if (voiceEngine === 'browser') {
      window.speechSynthesis.cancel();
    } else if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    setIsPlayingVoice(false);
    setStatusText('Idle');
  };

  // --- MIC / AUDIO RECORDING ---

  const startRecording = async () => {
    setErrorMessage('');
    stopVoicePlayback();
    setIsRecording(true);
    isRecordingRef.current = true;
    setStatusText('Initializing...');
    setTextAnswer('');
    latestSpeechTextRef.current = '';
    accumulatedSpeechTextRef.current = '';
    speechRestartCountRef.current = 0;
    lastSpeechRestartTimeRef.current = 0;
    audioChunksRef.current = [];

    if (sttEngine === 'browser') {
      try {
        const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
        if (!SpeechRecognition) {
          throw new Error('Browser Speech Recognition is not supported by your browser. Please use Google Chrome or Microsoft Edge.');
        }

        const rec = new SpeechRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';

        rec.onstart = () => {
          console.log('Speech recognition service started listening.');
          setStatusText('Listening');
        };

        rec.onresult = (event) => {
          let currentTurnTranscript = '';
          for (let i = 0; i < event.results.length; ++i) {
            currentTurnTranscript += event.results[i][0].transcript;
          }
          const fullTranscript = (accumulatedSpeechTextRef.current + ' ' + currentTurnTranscript).trim();
          if (fullTranscript) {
            setTextAnswer(fullTranscript);
            latestSpeechTextRef.current = fullTranscript;
          }
        };

        rec.onerror = (err) => {
          console.error('Speech recognition error:', err);
          if (err.error === 'network') {
            console.warn('SpeechRecognition network glitch. Auto-recovery active.');
          } else if (err.error !== 'no-speech') {
            setErrorMessage(`Speech recognition error: ${err.error}`);
          }
        };

        rec.onend = () => {
          console.log('Speech recognition service disconnected.');
          // Auto-restart if we are still supposed to be recording
          if (isRecordingRef.current) {
            const now = Date.now();
            // Reset counter if last restart was more than 10s ago
            if (now - lastSpeechRestartTimeRef.current > 10000) {
              speechRestartCountRef.current = 0;
            }

            if (speechRestartCountRef.current < 3) {
              speechRestartCountRef.current += 1;
              lastSpeechRestartTimeRef.current = now;
              console.log(`Auto-restarting speech recognition (Retry ${speechRestartCountRef.current}/3)...`);
              setStatusText('Reconnecting...');
              accumulatedSpeechTextRef.current = latestSpeechTextRef.current;
              try {
                rec.start();
              } catch (e) {
                console.error('SpeechRecognition auto-restart failed:', e);
              }
            } else {
              console.warn('Max speech recognition auto-restarts reached due to persistent errors.');
              setErrorMessage('Continuous speech recognition issues detected. Please check your network connection, refresh, or use the "Type Instead" fallback.');
              setIsRecording(false);
              isRecordingRef.current = false;
              setStatusText('Idle');
            }
          } else {
            // User stopped recording: submit the final collected transcript
            const finalAnswer = latestSpeechTextRef.current;
            if (finalAnswer.trim()) {
              submitCandidateAnswer(finalAnswer);
            } else {
              setErrorMessage('No speech detected. Please try again or type your answer.');
              setStatusText('Idle');
            }
          }
        };

        recognitionRef.current = rec;
        rec.start();

        // Access microphone stream for live canvas visualizer
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        visualize(stream);
      } catch (err) {
        console.error('Mic permission or initialization denied:', err);
        setErrorMessage(err.message || 'Microphone access is required to record speech.');
        setIsRecording(false);
        isRecordingRef.current = false;
        setStatusText('Idle');
      }
    } else {
      // Whisper Audio Recording via MediaRecorder
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        visualize(stream);

        const options = { mimeType: 'audio/webm' };
        let mediaRecorder;
        try {
          mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
          mediaRecorder = new MediaRecorder(stream);
        }

        mediaRecorderRef.current = mediaRecorder;
        
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          // Stop stream tracks
          stream.getTracks().forEach(track => track.stop());
          cleanupVisualizer();

          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          if (audioBlob.size > 0) {
            await handleAudioSubmit(audioBlob);
          }
        };

        mediaRecorder.start(250); // get chunks every 250ms
      } catch (err) {
        setErrorMessage(`Microphone error: ${err.message}`);
        setIsRecording(false);
        setStatusText('Idle');
      }
    }
  };

  const stopRecording = () => {
    if (!isRecordingRef.current) return;
    setIsRecording(false);
    isRecordingRef.current = false;
    setStatusText('Thinking');

    if (sttEngine === 'browser' && recognitionRef.current) {
      recognitionRef.current.stop();
      cleanupVisualizer();
    } else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // Upload webm audio to Whisper API
  const handleAudioSubmit = async (audioBlob) => {
    if (!apiKey) {
      setErrorMessage('OpenAI API Key is required for Whisper STT. Please enter a key in Settings, or use Browser Speech.');
      setStatusText('Idle');
      return;
    }

    try {
      setIsThinking(true);
      const formData = new FormData();
      formData.append('audio', audioBlob, 'interview-answer.webm');

      const res = await fetch(`${API_BASE_URL}/api/stt`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Speech transcription failed.');
      }

      const data = await res.json();
      if (data.text && data.text.trim()) {
        await submitCandidateAnswer(data.text);
      } else {
        throw new Error('No speech detected. Please speak louder or adjust your mic.');
      }
    } catch (err) {
      setErrorMessage(err.message);
      setStatusText('Idle');
      setIsThinking(false);
    }
  };

  // Canvas visualizer loop
  const visualize = (stream) => {
    if (!canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Handle high DPI screens
    const dpi = window.devicePixelRatio || 1;
    canvas.width = canvas.parentElement.clientWidth * dpi;
    canvas.height = 60 * dpi;
    ctx.scale(dpi, dpi);
    
    const width = canvas.width / dpi;
    const height = 60;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, width, height);

      // Draw bouncing glowing waves
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#06b6d4'; // Cyan color
      ctx.beginPath();

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0; // scale
        // Center the wave vertically, bounce relative to volume
        const offset = ((v - 1.0) * height * 0.85);
        const y = (height / 2) + offset;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Add a second subtle background wave
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)'; // Indigo opacity
      ctx.beginPath();
      x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const offset = ((v - 1.0) * height * 0.4);
        const y = (height / 2) - offset; // inverse offset
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
    };

    draw();
  };

  const cleanupVisualizer = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    // Release the microphone hardware so the next question gets a fresh stream
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
  };

  // --- INTERVIEW FLOW AND EVALUATION ---

  const startInterview = () => {
    if (questions.length === 0) {
      setErrorMessage('Reference Q&A set is empty. Please add questions first.');
      return;
    }
    
    setErrorMessage('');
    
    // Shuffle helper (Fisher-Yates)
    const shuffled = [...questions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const selectedQuestions = shuffled.slice(0, Math.min(interviewLength, questions.length));
    setActiveQuestions(selectedQuestions);
    
    setCurrentQuestionIndex(0);
    setMessages([
      { 
        role: 'assistant', 
        content: `Hello! Welcome to your mock interview. I am your practice agent today, and we'll be reviewing some core software engineering concepts. Let's begin with our first question. ${selectedQuestions[0].question}` 
      }
    ]);
    
    setCurrentScreen('interview');
    
    // Wait a brief moment for layout/screen to render then play audio
    setTimeout(() => {
      playVoice(`Hello! Welcome to your mock interview. I am your practice agent today, and we'll be reviewing some core software engineering concepts. Let's begin with our first question. ${selectedQuestions[0].question}`);
    }, 400);
  };

  const submitCandidateAnswer = async (answerText) => {
    if (!answerText.trim()) return;

    // 1. Add user answer to chat
    const updatedMessages = [...messages, { role: 'user', content: answerText }];
    setMessages(updatedMessages);
    setIsThinking(true);
    setStatusText('Thinking');
    setTextAnswer('');

    try {
      // 2. Query chat endpoint
      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          messages: updatedMessages,
          currentQuestionIndex,
          interviewLength,
          activeQuestions
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Server rejected evaluation request.');
      }

      const result = await res.json();

      // 3. Update messages with evaluation insights and reply
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: result.reply,
          evaluation: result.evaluation,
          groundedQuestion: result.groundedQuestion
        }
      ]);

      setIsThinking(false);

      // Play the interviewer's reply
      playVoice(result.reply);

      // 4. Handle State Transition
      if (result.decision === 'transition') {
        const nextIndex = currentQuestionIndex + 1;
        const totalQuestionsToAsk = activeQuestions.length;

        if (nextIndex < totalQuestionsToAsk) {
          // Transition to next question
          setCurrentQuestionIndex(nextIndex);
        } else {
          // Interview is completed
          setStatusText('Idle');
        }
      }
    } catch (err) {
      setErrorMessage(err.message);
      setIsThinking(false);
      setStatusText('Idle');
    }
  };

  const handleTextFallbackSubmit = (e) => {
    e.preventDefault();
    if (!textAnswer.trim()) return;
    submitCandidateAnswer(textAnswer);
  };

  const generateFeedback = async () => {
    stopVoicePlayback();
    setCurrentScreen('feedback');
    setIsThinking(true);
    setErrorMessage('');
    setFeedbackReport(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          messages,
          interviewLength,
          activeQuestions
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to generate feedback report.');
      }

      const report = await res.json();
      setFeedbackReport(report);
    } catch (err) {
      setErrorMessage(`Feedback Generation Error: ${err.message}`);
    } finally {
      setIsThinking(false);
    }
  };

  // --- Q&A DATABASE MANAGEMENT ---

  const handleEditQuestion = (q) => {
    setEditingQuestionId(q.id);
    setEditTopic(q.topic);
    setEditQuestionText(q.question);
    setEditIdealAnswer(q.idealAnswer);
  };

  const saveEditedQuestion = async (id) => {
    if (!editTopic || !editQuestionText || !editIdealAnswer) {
      setErrorMessage('All fields are required.');
      return;
    }
    const updated = questions.map(q => {
      if (q.id === id) {
        return { ...q, topic: editTopic, question: editQuestionText, idealAnswer: editIdealAnswer };
      }
      return q;
    });
    const success = await saveQuestions(updated);
    if (success) setEditingQuestionId(null);
  };

  const handleAddQuestion = async (e) => {
    e.preventDefault();
    if (!newQuestionTopic || !newQuestionText || !newQuestionIdealAnswer) {
      setErrorMessage('All fields are required.');
      return;
    }
    const newQ = {
      id: `q-${Date.now()}`,
      topic: newQuestionTopic,
      question: newQuestionText,
      idealAnswer: newQuestionIdealAnswer
    };
    const updated = [...questions, newQ];
    const success = await saveQuestions(updated);
    if (success) {
      setNewQuestionTopic('');
      setNewQuestionText('');
      setNewQuestionIdealAnswer('');
    }
  };

  const handleDeleteQuestion = async (id) => {
    if (window.confirm('Are you sure you want to delete this reference question?')) {
      const updated = questions.filter(q => q.id !== id);
      await saveQuestions(updated);
    }
  };

  const resetToDefaultQuestions = async () => {
    if (window.confirm('Are you sure you want to restore the default Software Engineering Q&A set?')) {
      // Recreate default set
      try {
        const res = await fetch('/data/questions.json'); // if public copy exists
        // Since we are running on developer machine, we can hit a reset API, or we can just send the hardcoded questions.
        // Let's build the default dataset directly in client memory to keep it simple.
        const defaultQuestions = [
          {
            "id": "q1",
            "topic": "React State Management",
            "question": "Can you explain the main differences between using the React Context API and a dedicated state management library like Redux? In what scenarios would you choose one over the other?",
            "idealAnswer": "A strong answer should highlight: 1. React Context is a dependency injection tool, not a full state management solution. It passes data down the component tree to avoid prop-drilling. 2. Redux is a full state management system featuring a centralized store, actions, reducers, and middleware (like Thunk or Saga). 3. Performance: Context API triggers a re-render of all consumer components when its value changes, which can lead to performance bottlenecks for highly dynamic or frequent state updates. Redux allows components to select specific slices of state and only re-render when those specific slices change. 4. DevTools: Redux provides time-travel debugging and powerful state tracking. 5. Choice: Choose Context for static or low-frequency updates (themes, user auth info). Choose Redux (or Zustand/Recoil) for complex, high-frequency, or globally distributed application state."
          },
          {
            "id": "q2",
            "topic": "REST vs GraphQL",
            "question": "What are the primary differences between REST and GraphQL? How do they handle issues like over-fetching and under-fetching of data?",
            "idealAnswer": "A strong answer should highlight: 1. REST uses fixed endpoints (e.g., /api/users) where the server determines the shape of the response. GraphQL uses a single endpoint (typically /graphql) where the client specifies the exact fields it needs in a query. 2. Over-fetching (getting more data than needed) and Under-fetching (not getting enough, requiring multiple sequential API calls) are common problems in REST because of its fixed payloads. GraphQL solves this by allowing clients to request exactly what they need in a single round-trip. 3. Schema & Type Safety: GraphQL utilizes a strongly-typed schema (SDL) that serves as a contract between frontend and backend. 4. Caching: REST leverages standard HTTP caching mechanisms (like ETags, Cache-Control) at the protocol level. GraphQL caching is more complex because it uses POST requests and a single endpoint, requiring client-side normalization libraries (like Apollo Client cache)."
          },
          {
            "id": "q3",
            "topic": "Database Indexing",
            "question": "How does database indexing work under the hood, and what are the trade-offs associated with creating multiple indexes on a table?",
            "idealAnswer": "A strong answer should highlight: 1. Under the hood: Indexes are data structures (typically B-Trees or B+ Trees, and sometimes Hash indexes) that store pointers to the physical rows in a table. They allow the database engine to find records in logarithmic time O(log N) instead of performing a full table scan O(N). 2. Read Performance: Indexes drastically speed up read queries (SELECT statements with WHERE, JOIN, or ORDER BY clauses). 3. Write Performance Trade-off: Every index must be updated whenever a write operation (INSERT, UPDATE, DELETE) occurs. Consequently, too many indexes slow down write performance. 4. Storage Trade-off: Indexes consume disk space and memory (buffer pool). 5. Strategy: Indexes should be created selectively on columns frequently used in filtering, joining, or sorting, rather than indexing every column."
          },
          {
            "id": "q4",
            "topic": "Web Security: XSS vs CSRF",
            "question": "What is the difference between Cross-Site Scripting (XSS) and Cross-Site Request Forgery (CSRF)? How can developer mitigate these vulnerabilities in a modern web application?",
            "idealAnswer": "A strong answer should highlight: 1. XSS (Cross-Site Scripting): Involves injecting malicious client-side scripts (usually JavaScript) into a trusted website, which then execute in the victim's browser. Mitigation: Sanitize and escape all user inputs, use Content Security Policy (CSP) headers, and use HttpOnly cookies for session tokens so JS cannot access them. 2. CSRF (Cross-Site Request Forgery): Tricks a victim's authenticated browser into executing unwanted actions on a web app where they are currently logged in. The attacker exploits the browser's automatic inclusion of cookies. Mitigation: Use anti-CSRF tokens (unique, stateful tokens verified by the server), or set the SameSite attribute on cookies to 'Strict' or 'Lax' to prevent cross-site transmission. 3. Core Difference: XSS exploits the trust a user has in a website; CSRF exploits the trust a website has in a user's browser/session."
          },
          {
            "id": "q5",
            "topic": "JavaScript Event Loop",
            "question": "Explain how the JavaScript event loop works. What is the difference between the microtask queue and the macrotask queue (task queue), and how do Promises fit in?",
            "idealAnswer": "A strong answer should highlight: 1. Single Threaded: JavaScript is single-threaded (executes one thing at a time) and non-blocking, managed by the Event Loop. 2. Execution Stack: Synchronous code runs first in the call stack. 3. Queues: Asynchronous operations (like setTimeouts, network requests, Promises) are handled by Web APIs and their callbacks are placed in queues. 4. Microtask Queue: Includes Promise callbacks (.then, .catch, .finally) and process.nextTick (in Node). 5. Macrotask Queue: Includes setTimeout, setInterval, setImmediate, and I/O tasks. 6. Event Loop execution order: The event loop checks the Call Stack. If the stack is empty, it first processes *all* available microtasks in the microtask queue before moving to the next macrotask in the macrotask queue. Each macrotask run is followed by flushing the entire microtask queue again."
          },
          {
            "id": "q6",
            "topic": "CORS (Cross-Origin Resource Sharing)",
            "question": "What is CORS (Cross-Origin Resource Sharing)? Explain what a 'preflight request' is and why the browser sends it.",
            "idealAnswer": "A strong answer should highlight: 1. CORS is a browser security mechanism that restricts web pages from making requests to a different domain than the one that served the page. 2. Same-Origin Policy: By default, browsers block cross-origin HTTP requests for security. CORS headers (like Access-Control-Allow-Origin) allow servers to declare which origins are permitted. 3. Preflight Request: An HTTP OPTIONS request sent automatically by the browser prior to the actual request. 4. Purpose: It checks if the server understands and permits the incoming cross-origin request method, headers, and credentials, preventing potentially unsafe operations on the server. 5. Trigger: Preflight is triggered for 'non-simple' requests (e.g., requests with Content-Type 'application/json', custom headers, or methods other than GET, HEAD, or POST)."
          },
          {
            "id": "q7",
            "topic": "React Virtual DOM & Reconciliation",
            "question": "How does React's Virtual DOM work? Can you describe the reconciliation process and why the 'key' prop is important when rendering lists?",
            "idealAnswer": "A strong answer should highlight: 1. Virtual DOM: A lightweight, in-memory representation of the real DOM. 2. Reconciliation: When state or props change, React builds a new Virtual DOM tree and compares it with the previous one (a process called 'diffing'). 3. Efficient Diffing: React uses a heuristic O(N) algorithm (instead of O(N^3)) based on assumptions like different element types produce different trees. 4. Batching & Patching: React calculates the minimum set of changes needed and updates only those specific parts in the real DOM (batching modifications). 5. Key Prop: The 'key' prop helps React identify which list items have changed, been added, or been removed. Without unique keys, React might re-render or recreate elements unnecessarily, causing bugs like losing input focus or resetting local component state."
          },
          {
            "id": "q8",
            "topic": "REST API Design & HTTP Status Codes",
            "question": "What makes an HTTP method 'idempotent'? Give examples of idempotent vs non-idempotent methods, and state the appropriate HTTP status codes to return when a resource is successfully created, when validation fails, and when a server error occurs.",
            "idealAnswer": "A strong answer should highlight: 1. Idempotency: An HTTP method is idempotent if making multiple identical requests has the same effect on the server state as making a single request. 2. Idempotent Methods: GET (read only), PUT (replaces resource entirely), DELETE (removes resource), OPTIONS. 3. Non-idempotent Methods: POST (submitting multiple times creates multiple records), PATCH (can be non-idempotent, e.g., if it appends value to an array). 4. Status Codes: Created successfully: 201 Created. Validation/Client error: 400 Bad Request. Unauthenticated: 401 Unauthorized. Forbidden: 403 Forbidden. Server error: 500 Internal Server Error. Success (no content): 204 No Content."
          },
          {
            "id": "q9",
            "topic": "CSS Layouts: Flexbox vs Grid",
            "question": "Compare CSS Flexbox and CSS Grid. When would you design a layout using Flexbox, and when would you choose CSS Grid?",
            "idealAnswer": "A strong answer should highlight: 1. Dimensionality: Flexbox is primarily one-dimensional (handles layouts along either a single row OR a single column). Grid is two-dimensional (handles rows AND columns simultaneously). 2. Layout-First vs Content-First: Flexbox is content-first (items size themselves and the layout adjusts). Grid is layout-first (you define the grid structure first, then place items inside cells). 3. Overlap: Grid makes it easy to overlap elements using grid-area, which is harder in Flexbox. 4. Alignment: Flexbox is great for aligning items along an axis (e.g., a navigation bar with spaced items). 5. Choice: Use Flexbox for linear layouts like navbars, lists, card content, or small components. Use Grid for page-level layouts, dashboard layouts, image galleries, or anywhere you need precise alignment in both rows and columns."
          },
          {
            "id": "q10",
            "topic": "System Design: Caching Strategies",
            "question": "What is caching in system design? Describe the difference between Cache-Aside and Write-Through caching strategies, and mention one strategy to handle cache invalidation.",
            "idealAnswer": "A strong answer should highlight: 1. Caching: Storing copy of data in a high-speed data access layer (like Redis, Memcached, or browser cache) to serve requests faster and reduce load on databases. 2. Cache-Aside: The application checks the cache first. If a cache miss occurs, it queries the database, writes the result to the cache, and returns it. Easy to implement, but cache can become stale if database is updated directly. 3. Write-Through: The application writes data to the cache first, and the cache immediately writes it to the database. Ensures data is always fresh, but introduces write latency and writes unused data. 4. Cache Invalidation: Crucial because 'there are only two hard things in Computer Science: cache invalidation and naming things.' Strategies include Time-to-Live (TTL) expiration, Cache Eviction policies (e.g., LRU - Least Recently Used), or explicit Purging/Invalidating the cache key when a write happens."
          }
        ];
        await saveQuestions(defaultQuestions);
      } catch (err) {

        setErrorMessage('Failed to restore defaults.');
      }
    }
  };

  // --- UI RENDER HELPERS ---

  const renderStatusBadge = () => {
    switch (statusText) {
      case 'Listening':
        return <span className="status-badge listening"><span className="flex-row-gap-2"><span className="mic-pulse-dot"></span>Listening</span></span>;
      case 'Speaking':
        return <span className="status-badge speaking"><Volume2 size={12} /> Speaking</span>;
      case 'Thinking':
        return <span className="status-badge thinking"><Sparkles size={12} className="spin-animation" /> Evaluating</span>;
      default:
        return <span className="status-badge idle">Idle</span>;
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section" onClick={() => setCurrentScreen('welcome')} style={{ cursor: 'pointer' }}>
          <div className="logo-icon">
            <Mic size={20} />
          </div>
          <div>
            <h1 className="logo-text">AegisVoice</h1>
            <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 'bold' }}>AI Mock Interview practice</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={() => setCurrentScreen(currentScreen === 'qa_manager' ? 'welcome' : 'qa_manager')}>
            <BookOpen size={16} /> {currentScreen === 'qa_manager' ? 'Main Dashboard' : 'Q&A Manager'}
          </button>
          <button className="btn btn-outline" onClick={() => setShowSettingsModal(true)}>
            <Settings size={16} /> Settings
          </button>
        </div>
      </header>

      {/* Global Alerts */}
      {errorMessage && (
        <div className="card mb-4 flex-row-gap-2 justify-between" style={{ borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.05)', padding: '1rem' }}>
          <div className="flex-row-gap-2">
            <AlertCircle color="var(--danger)" size={18} />
            <span style={{ fontSize: '0.9rem', color: '#fca5a5' }}>{errorMessage}</span>
          </div>
          <button className="btn btn-outline" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setErrorMessage('')}>Dismiss</button>
        </div>
      )}

      {successMessage && (
        <div className="card mb-4 flex-row-gap-2" style={{ borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.05)', padding: '1rem', color: '#a7f3d0' }}>
          <CheckCircle size={18} />
          <span style={{ fontSize: '0.9rem' }}>{successMessage}</span>
        </div>
      )}

      {/* --- WELCOME SCREEN --- */}
      {currentScreen === 'welcome' && (
        <div className="welcome-screen card">
          <div style={{ marginBottom: '2.5rem' }}>
            <span className="status-badge" style={{ color: 'var(--color-secondary)', background: 'rgba(6, 182, 212, 0.08)', marginBottom: '1rem' }}>
              Grounded AI Engine v1.0
            </span>
            <h2 className="hero-title">Mock Interviews,<br />Mastered by Voice.</h2>
            <p className="hero-subtitle">
              Speak naturally with our grounded AI interviewer. It evaluates your answers in real-time against custom reference keys, offering organic follow-ups, mentoring, and rigorous feedback.
            </p>
          </div>

          <div className="setup-grid">
            <div className="setup-item">
              <label className="setup-label">Interview Length</label>
              <select className="setup-select" value={interviewLength} onChange={(e) => setInterviewLength(Number(e.target.value))}>
                <option value={1}>Short Screening (1 Question - Quick Test)</option>
                <option value={3}>Standard Screen (3 Questions - Demo Recommended)</option>
                <option value={5}>Full Mock (5 Questions - Comprehensive)</option>
                <option value={10}>Deep Technical (All 10 Questions)</option>
              </select>
            </div>
            
            <div className="setup-item">
              <label className="setup-label">Interviewer Voice Engine</label>
              <select className="setup-select" value={voiceEngine} onChange={(e) => {
                setVoiceEngine(e.target.value);
                // Pair default STT engine for seamless experience
                setSttEngine(e.target.value === 'openai' ? 'whisper' : 'browser');
              }}>
                <option value="browser">Web Speech API (Zero Latency, Free)</option>
                <option value="openai">OpenAI TTS & Whisper (Realistic, requires API Key)</option>
              </select>
            </div>
          </div>

          <button className="btn btn-primary start-btn-large" onClick={startInterview}>
            Start Interview Practice <Play size={18} />
          </button>
        </div>
      )}

      {/* --- INTERVIEW SCREEN --- */}
      {currentScreen === 'interview' && (
        <div className="interview-layout">
          {/* Main Panel */}
          <div className="interview-main">
            {/* Visualizer card ( breathing circle or bouncing wave) */}
            <div className="card visualizer-card">
              <div className={`avatar-outer ${isPlayingVoice ? 'speaking' : ''}`}>
                <div className="avatar-inner">
                  {isPlayingVoice ? <Volume2 size={36} /> : isThinking ? <RefreshCw className="spin-animation" size={36} /> : <Mic size={36} />}
                </div>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                {renderStatusBadge()}
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {isPlayingVoice ? 'Interviewer is speaking...' : isRecording ? 'Listening to your response...' : isThinking ? 'Analyzing response...' : 'Ready'}
                </p>
              </div>

              {/* Bouncing spectrum only visible when recording */}
              <canvas 
                ref={canvasRef} 
                className="canvas-visualizer" 
                style={{ display: isRecording ? 'block' : 'none' }}
              />
            </div>

            {/* Chat Transcript log */}
            <div className="card transcript-card">
              <div className="transcript-header">
                <span className="transcript-title">Interview Transcript</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Question {Math.min(currentQuestionIndex + 1, activeQuestions.length)} of {activeQuestions.length}
                </span>
              </div>
              
              <div className="chat-messages">
                {messages.map((m, idx) => (
                  <div key={idx} className={`message ${m.role === 'user' ? 'candidate' : 'interviewer'}`}>
                    <span className="message-sender">{m.role === 'user' ? 'You' : 'Aegis Agent'}</span>
                    <div className="message-bubble">{m.content}</div>
                  </div>
                ))}
                {isThinking && (
                  <div className="message interviewer">
                    <span className="message-sender">Aegis Agent</span>
                    <div className="message-bubble" style={{ display: 'flex', gap: '4px', padding: '0.75rem 1rem' }}>
                      <span className="typing-dot"></span>
                      <span className="typing-dot"></span>
                      <span className="typing-dot"></span>
                    </div>
                  </div>
                )}
                <div ref={chatBottomRef} />
              </div>
            </div>

            {/* Microphone and Submission Controls */}
            <div className="card controls-card" style={{ position: 'relative' }}>
              <div>
                <button className="btn btn-secondary" onClick={() => setShowTextFallback(!showTextFallback)}>
                  {showTextFallback ? 'Hide Text Fallback' : 'Type Instead'}
                </button>
              </div>

              <div className="mic-button-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button 
                  className={`mic-button ${isRecording ? 'recording' : ''}`} 
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={isThinking}
                >
                  {isRecording ? <Square size={24} /> : <Mic size={24} />}
                </button>
                {isThinking && (
                  <button 
                    className="btn btn-outline" 
                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem', marginTop: '0.5rem', border: '1px dashed var(--border-color)' }}
                    onClick={() => {
                      setIsThinking(false);
                      setStatusText('Idle');
                    }}
                  >
                    Cancel Request
                  </button>
                )}
              </div>

              <div>
                <button 
                  className="btn btn-danger" 
                  onClick={generateFeedback}
                  disabled={isThinking || messages.length < 2}
                >
                  <FileText size={16} /> Complete & Evaluate
                </button>
              </div>
            </div>

            {/* Text Input Fallback Panel */}
            {showTextFallback && (
              <form onSubmit={handleTextFallbackSubmit} className="card flex-row-gap-2" style={{ padding: '1rem' }}>
                <input 
                  type="text" 
                  className="setup-input w-full" 
                  placeholder="Type your answer here..."
                  value={textAnswer}
                  onChange={(e) => setTextAnswer(e.target.value)}
                  disabled={isThinking || isRecording}
                />
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={isThinking || !textAnswer.trim()}
                >
                  Submit
                </button>
              </form>
            )}
          </div>

          {/* Right Panel (Debug / Grounding) */}
          {showDebugPanel && (
            <div className="card grounding-panel">
              <div className="grounding-header">
                <Sparkles size={18} />
                <span>Grounding Engine Logs</span>
              </div>
              <div className="grounding-content">
                <div className="grounding-section">
                  <div className="grounding-section-title">Active Grounding Node</div>
                  <div className="grounding-section-body" style={{ fontWeight: '600', color: 'var(--color-secondary)', fontSize: '0.85rem' }}>
                    Q{currentQuestionIndex + 1}: {activeQuestions[currentQuestionIndex]?.topic || 'Loading...'}
                  </div>
                </div>

                <div className="grounding-section">
                  <div className="grounding-section-title">Reference Question</div>
                  <div className="grounding-section-body">
                    "{activeQuestions[currentQuestionIndex]?.question}"
                  </div>
                </div>

                <div className="grounding-section">
                  <div className="grounding-section-title">Ideal Reference Answer (Target Keywords)</div>
                  <div className="grounding-section-body" style={{ fontSize: '0.825rem', color: 'var(--text-muted)' }}>
                    {activeQuestions[currentQuestionIndex]?.idealAnswer}
                  </div>
                </div>

                {/* Latest Evaluation from backend */}
                {messages.length > 0 && messages[messages.length - 1].evaluation && (
                  <div className="grounding-section" style={{ borderLeft: '3px solid var(--color-accent)' }}>
                    <div className="grounding-section-title" style={{ color: 'var(--color-accent)' }}>Real-Time Assessment</div>
                    <div className="grounding-section-body" style={{ fontSize: '0.85rem' }}>
                      {messages[messages.length - 1].evaluation}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- FEEDBACK DASHBOARD SCREEN --- */}
      {currentScreen === 'feedback' && (
        <div className="feedback-screen">
          <div className="flex-row-gap-2">
            <button className="btn btn-secondary" onClick={() => setCurrentScreen('welcome')}>
              <ArrowLeft size={16} /> Return Home
            </button>
            <h2 className="feedback-title" style={{ marginLeft: '1rem' }}>Interview Feedback Dashboard</h2>
          </div>

          {isThinking ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '300px', gap: '1rem' }}>
              <RefreshCw className="spin-animation" size={48} color="var(--color-primary)" />
              <p>Analyzing conversation history against grounding reference sets...</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Generating comprehensive technical performance breakdown...</p>
            </div>
          ) : feedbackReport ? (
            <>
              {/* Score and Summary Card */}
              <div className="card feedback-overview-card">
                <div className="score-circle-container">
                  <div className="score-circle">
                    <span className="score-number">{feedbackReport.overallScore}%</span>
                    <span className="score-label">Overall Match</span>
                  </div>
                </div>
                <div className="feedback-summary-text">
                  <span className="status-badge" style={{ color: 'var(--success)', background: 'rgba(16, 185, 129, 0.08)', width: 'fit-content' }}>
                    Evaluation Completed
                  </span>
                  <h3 style={{ fontSize: '1.5rem', fontWeight: '600' }}>Evaluation Executive Summary</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', lineHeight: '1.6' }}>
                    {feedbackReport.summary}
                  </p>
                </div>
              </div>

              {/* Strengths and Improvements Cards */}
              <div className="strengths-improvements">
                <div className="card list-card">
                  <h4 className="list-card-title strengths">
                    <CheckCircle size={18} /> Highlighted Strengths
                  </h4>
                  <ul className="feedback-list">
                    {feedbackReport.strengths.map((str, idx) => (
                      <li key={idx} className="feedback-list-item">{str}</li>
                    ))}
                  </ul>
                </div>

                <div className="card list-card">
                  <h4 className="list-card-title improvements">
                    <AlertCircle size={18} /> Targeted Areas to Improve
                  </h4>
                  <ul className="feedback-list">
                    {feedbackReport.improvements.map((imp, idx) => (
                      <li key={idx} className="feedback-list-item">{imp}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Question breakdown */}
              <div>
                <h3 className="breakdown-title mb-4">Question-by-Question Assessment</h3>
                <div className="accordion">
                  {feedbackReport.questionBreakdown.map((q, idx) => {
                    const isExpanded = expandedFeedbackQuestion === idx;
                    const getScoreClass = (score) => {
                      if (score >= 80) return 'high';
                      if (score >= 50) return 'mid';
                      return 'low';
                    };

                    return (
                      <div key={idx} className="accordion-item">
                        <div 
                          className="accordion-header" 
                          onClick={() => setExpandedFeedbackQuestion(isExpanded ? null : idx)}
                        >
                          <div className="accordion-header-left">
                            <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--color-secondary)' }}>
                              TOPIC: {q.topic}
                            </span>
                            <span className="accordion-question">{q.question}</span>
                          </div>
                          <div className="flex-row-gap-2">
                            <span className={`accordion-score-badge ${getScoreClass(q.score)}`}>
                              {q.score}%
                            </span>
                            {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                          </div>
                        </div>
                        
                        {isExpanded && (
                          <div className="accordion-content">
                            <div className="accordion-section">
                              <span className="accordion-section-label">Your Response</span>
                              <p className="accordion-section-text" style={{ fontStyle: 'italic', color: '#e5e7eb' }}>
                                "{q.candidateAnswer || '[No response provided]'}"
                              </p>
                            </div>

                            <div className="accordion-section">
                              <span className="accordion-section-label" style={{ color: 'var(--color-secondary)' }}>Ideal Evaluation Criteria</span>
                              <p className="accordion-section-text" style={{ color: 'var(--text-muted)' }}>
                                {q.referenceAnswer}
                              </p>
                            </div>

                            <div className="accordion-section" style={{ borderLeft: '3px solid var(--color-primary)', paddingLeft: '1rem' }}>
                              <span className="accordion-section-label" style={{ color: 'var(--color-primary)' }}>Assessor Feedback</span>
                              <p className="accordion-section-text">
                                {q.feedback}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              No feedback report could be loaded. Please ensure you answered some questions first.
            </div>
          )}
        </div>
      )}

      {/* --- Q&A DATABASE MANAGER SCREEN --- */}
      {currentScreen === 'qa_manager' && (
        <div className="qa-manager">
          <div className="qa-header">
            <div>
              <h2 className="feedback-title">Grounded Reference Q&A Set</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                Add, edit, or remove questions directly. The core LLM interviewer stays grounded in this live set.
              </p>
            </div>
            <div className="flex-row-gap-2">
              <button className="btn btn-secondary" onClick={resetToDefaultQuestions}>
                <RefreshCw size={16} /> Restore Defaults
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
            {/* Add New Question Form */}
            <div className="card">
              <h3 style={{ fontSize: '1.2rem', fontWeight: '600', marginBottom: '1.25rem' }}>Add New Reference Question</h3>
              <form onSubmit={handleAddQuestion} className="qa-edit-form">
                <div className="setup-item">
                  <label className="setup-label">Topic / Area</label>
                  <input 
                    type="text" 
                    placeholder="e.g. React Hooks, Database Indexing" 
                    className="setup-input" 
                    value={newQuestionTopic}
                    onChange={(e) => setNewQuestionTopic(e.target.value)}
                  />
                </div>
                <div className="setup-item">
                  <label className="setup-label">Question Text</label>
                  <input 
                    type="text" 
                    placeholder="What question should the interviewer ask?" 
                    className="setup-input" 
                    value={newQuestionText}
                    onChange={(e) => setNewQuestionText(e.target.value)}
                  />
                </div>
                <div className="setup-item">
                  <label className="setup-label">Ideal Reference Answer Criteria</label>
                  <textarea 
                    placeholder="Write down details, keywords, and criteria that constitute a perfect answer. The LLM will assess responses using this key." 
                    className="setup-input" 
                    rows={4}
                    style={{ resize: 'vertical', fontFamily: 'var(--font-sans)' }}
                    value={newQuestionIdealAnswer}
                    onChange={(e) => setNewQuestionIdealAnswer(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                  <Plus size={16} /> Add to Database
                </button>
              </form>
            </div>

            {/* List of current questions */}
            <div className="qa-grid">
              {questions.map((q, idx) => (
                <div key={q.id} className="card qa-card">
                  {editingQuestionId === q.id ? (
                    /* Edit mode */
                    <div className="qa-edit-form">
                      <div className="setup-item">
                        <label className="setup-label">Topic</label>
                        <input 
                          type="text" 
                          className="setup-input" 
                          value={editTopic} 
                          onChange={(e) => setEditTopic(e.target.value)}
                        />
                      </div>
                      <div className="setup-item">
                        <label className="setup-label">Question</label>
                        <input 
                          type="text" 
                          className="setup-input" 
                          value={editQuestionText} 
                          onChange={(e) => setEditQuestionText(e.target.value)}
                        />
                      </div>
                      <div className="setup-item">
                        <label className="setup-label">Ideal Reference Answer</label>
                        <textarea 
                          className="setup-input" 
                          rows={4}
                          value={editIdealAnswer} 
                          onChange={(e) => setEditIdealAnswer(e.target.value)}
                        />
                      </div>
                      <div className="qa-actions">
                        <button className="btn btn-secondary" onClick={() => setEditingQuestionId(null)}>Cancel</button>
                        <button className="btn btn-primary" onClick={() => saveEditedQuestion(q.id)}>
                          <Save size={14} /> Save Changes
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Read mode */
                    <>
                      <div className="justify-between" style={{ display: 'flex', alignItems: 'center' }}>
                        <span className="qa-topic-badge">{q.topic}</span>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)', fontWeight: 'bold' }}>Q{idx + 1}</span>
                      </div>
                      <div>
                        <h4 style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '0.5rem' }}>{q.question}</h4>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                          <span style={{ fontWeight: 'bold', color: 'var(--text-main)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.25rem' }}>Ideal Answer Blueprint:</span>
                          {q.idealAnswer}
                        </p>
                      </div>
                      <div className="qa-actions" style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                        <button className="btn btn-outline" style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }} onClick={() => handleEditQuestion(q)}>
                          <Edit3 size={12} /> Edit
                        </button>
                        <button className="btn btn-danger" style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }} onClick={() => handleDeleteQuestion(q.id)}>
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* --- SETTINGS CONFIGURATION MODAL --- */}
      {showSettingsModal && (
        <div className="modal-overlay">
          <div className="card modal-content">
            <div className="modal-header">
              <h3 className="modal-title flex-row-gap-2">
                <Settings size={18} /> Settings Panel
              </h3>
              <button className="btn btn-outline" style={{ padding: '0.25rem 0.5rem' }} onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>
            
            <div className="modal-body">
              <div className="setup-item">
                <label className="setup-label flex-row-gap-2">
                  OpenAI API Key
                </label>
                <div style={{ position: 'relative' }}>
                  <input 
                    type={showApiKey ? 'text' : 'password'} 
                    className="setup-input w-full" 
                    placeholder="sk-proj-..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    style={{ paddingRight: '2.5rem' }}
                  />
                  <button 
                    type="button" 
                    onClick={() => setShowApiKey(!showApiKey)}
                    style={{
                      position: 'absolute',
                      right: '0.75rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                  This key is stored securely in your browser's localStorage and is only sent to the local server node to call OpenAI.
                </span>
              </div>

              <div className="setup-item">
                <label className="setup-label">Text-To-Speech Engine</label>
                <select className="setup-select" value={voiceEngine} onChange={(e) => setVoiceEngine(e.target.value)}>
                  <option value="browser">Browser Native Speech (Zero cost, offline support)</option>
                  <option value="openai">OpenAI Cloud TTS (Premium human quality, requires key)</option>
                </select>
              </div>

              {voiceEngine === 'openai' ? (
                <div className="setup-item">
                  <label className="setup-label">OpenAI Voice</label>
                  <select className="setup-select" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
                    <option value="alloy">Alloy (Warm Neutral)</option>
                    <option value="echo">Echo (Crisp Male)</option>
                    <option value="fable">Fable (Expressive British)</option>
                    <option value="onyx">Onyx (Deep Professional)</option>
                    <option value="nova">Nova (Energetic Female)</option>
                    <option value="shimmer">Shimmer (Friendly Female)</option>
                  </select>
                </div>
              ) : (
                <div className="setup-item">
                  <label className="setup-label">Browser Native Voice</label>
                  <select 
                    className="setup-select" 
                    value={selectedBrowserVoice} 
                    onChange={(e) => {
                      setSelectedBrowserVoice(e.target.value);
                      localStorage.setItem('selected_browser_voice', e.target.value);
                    }}
                  >
                    {availableVoices.length > 0 ? (
                      availableVoices.map((voice, index) => (
                        <option key={index} value={voice.name}>
                          {voice.name} ({voice.lang})
                        </option>
                      ))
                    ) : (
                      <option value="">Default System Voice</option>
                    )}
                  </select>
                </div>
              )}

              <div className="setup-item">
                <label className="setup-label">Speech-To-Text Model</label>
                <select className="setup-select" value={sttEngine} onChange={(e) => setSttEngine(e.target.value)}>
                  <option value="browser">Browser SpeechRecognition (Zero cost, Real-time)</option>
                  <option value="whisper">OpenAI Whisper (Premium accuracy, requires API Key)</option>
                </select>
              </div>

              <div className="setup-item" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input 
                  type="checkbox" 
                  id="chk-debug" 
                  checked={showDebugPanel}
                  onChange={(e) => setShowDebugPanel(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--color-primary)' }}
                />
                <label htmlFor="chk-debug" style={{ fontSize: '0.85rem', cursor: 'pointer', userSelect: 'none' }}>
                  Show Grounding Logs Sidebar during interview
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setShowSettingsModal(false)}>Save & Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
