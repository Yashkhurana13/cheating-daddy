const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, incrementCharUsage, getConfig, getPreferences } = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');
const { createAudioMixer } = require('./audioMixer');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';
let groqRequestStartedForTurn = false;

// Keep segmentation and resampling independent for simultaneous capture sources.
let groqAudioStates = {};
let geminiAudioMixer = null;
let sessionAudioMode = 'speaker_only';

function getGroqAudioState(source) {
    if (source !== 'system' && source !== 'mic') throw new Error('Unknown audio source');
    return (groqAudioStates[source] ||= {
        isSpeaking: false,
        speechBuffers: [],
        silenceFrameCount: 0,
        speechFrameCount: 0,
        resampleRemainder: Buffer.alloc(0),
    });
}

function resetSessionAudio() {
    groqAudioStates = {};
    geminiAudioMixer?.close();
    geminiAudioMixer = null;
}

const GROQ_VAD_CONFIG = {
    energyThreshold: 0.005, // Lowered threshold to trigger reliably for speaker/system audio
    speechFramesRequired: 2, // Number of consecutive speech frames to trigger start
    silenceFramesRequired: 20, // Number of consecutive silence frames to trigger end
};

function groqResample24kTo16k(inputBuffer, state) {
    const combined = Buffer.concat([state.resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    state.resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function groqCalculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function createWavBuffer(pcm16Buffer, sampleRate = 16000) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

async function transcribeAudioWithGroq(pcm16kBuffer, language = 'en') {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        throw new Error('No Groq API key configured');
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    if (language) {
        const langCode = language.split('-')[0];
        formData.append('language', langCode);
    }

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${groqApiKey}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq Whisper API returned HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result.text?.trim() || '';
}

async function handleGroqSpeechEnd(audioData) {
    if (audioData.length < 16000) {
        console.log('[Groq VAD] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const language = sessionParams?.language || 'en-US';
        const transcription = await transcribeAudioWithGroq(audioData, language);

        if (!transcription || transcription.length < 2) {
            console.log('[Groq VAD] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        console.log('[Groq VAD] Transcription:', transcription);
        sendToRenderer('update-status', 'Generating response...');
        await sendToGroq(transcription);
    } catch (error) {
        console.error('[Groq VAD] Transcription/Response error:', error);
        sendToRenderer('update-status', 'Error: ' + error.message);
    }
}

async function processAudioForGroq(monoChunk24k, source = 'system') {
    const state = getGroqAudioState(source);
    const pcm16k = groqResample24kTo16k(monoChunk24k, state);
    const rms = groqCalculateRms(pcm16k);
    const isVoice = rms > GROQ_VAD_CONFIG.energyThreshold;

    if (isVoice) {
        state.speechFrameCount += 1;
        state.silenceFrameCount = 0;

        if (!state.isSpeaking && state.speechFrameCount >= GROQ_VAD_CONFIG.speechFramesRequired) {
            state.isSpeaking = true;
            state.speechBuffers = [];
            console.log('[Groq VAD] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        state.silenceFrameCount += 1;
        state.speechFrameCount = 0;

        if (state.isSpeaking && state.silenceFrameCount >= GROQ_VAD_CONFIG.silenceFramesRequired) {
            state.isSpeaking = false;
            const audioData = Buffer.concat(state.speechBuffers);
            state.speechBuffers = [];
            console.log('[Groq VAD] Speech ended, accumulated', audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing (Groq)...');
            handleGroqSpeechEnd(audioData);
            return;
        }
    }

    if (state.isSpeaking) {
        state.speechBuffers.push(Buffer.from(pcm16k));
    }
}

const GROQ_MAX_COMPLETION_TOKENS = 1024;
const GROQ_MAX_SYSTEM_PROMPT_CHARS = 8000;
const GROQ_MAX_HISTORY_CHARS = 8000;
const GROQ_MAX_IMAGE_BASE64_CHARS = 3_500_000;
const GROQ_EMPTY_RESPONSE_MESSAGE =
    'Groq reached the maximum completion-token limit before returning a final answer. Disable thinking in Home → AI responses and try again.';
const GROQ_PAYLOAD_TOO_LARGE_MESSAGE =
    'Groq rejected this request because it exceeds your plan token limit (free tier is often 8,000 tokens per request for vision). Use screenshot quality Low, upgrade at console.groq.com/settings/billing, or leave the Groq key empty to use Gemini for screenshots.';
const GROQ_VISION_SCREENSHOT_PROMPT =
    'Analyze this screenshot. Give a direct, complete answer: bullet approach then full code for coding questions; exact MCQ choice with brief why otherwise.';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
let sessionGeneration = 0;
let reconnectRun = null;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    isUserClosing = false;
    reconnectAttempts = 0;
    resetSessionAudio();
    sessionAudioMode = getPreferences().audioMode;
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    currentTranscription = '';
    groqRequestStartedForTurn = false;
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}

function sendFinalTranscriptionToGroq() {
    if (!hasGroqKey() || groqRequestStartedForTurn) {
        return;
    }

    const transcription = currentTranscription.trim();
    if (transcription === '') {
        return;
    }

    groqRequestStartedForTurn = true;
    sendToGroq(transcription);
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function trimSystemPromptForGroq(systemPrompt, maxChars = GROQ_MAX_SYSTEM_PROMPT_CHARS) {
    const text = systemPrompt || 'You are a helpful assistant.';
    if (text.length <= maxChars) {
        return text;
    }

    const marker = '\nUser-provided context\n-----\n';
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
        return text.slice(0, maxChars - 80) + '\n\n[Context trimmed to fit Groq request limits.]';
    }

    const head = text.slice(0, markerIndex + marker.length);
    const tail = text.slice(markerIndex + marker.length);
    const closing = '\n-----\n';
    const closingIndex = tail.lastIndexOf(closing);
    const customContext = closingIndex === -1 ? tail : tail.slice(0, closingIndex);
    const footer = closingIndex === -1 ? '' : tail.slice(closingIndex);

    const budgetForCustom = Math.max(2000, maxChars - head.length - footer.length - 120);
    if (customContext.length <= budgetForCustom) {
        return text.slice(0, maxChars - 80) + '\n\n[Context trimmed to fit Groq request limits.]';
    }

    const trimmedCustom =
        customContext.slice(0, Math.floor(budgetForCustom / 2)) +
        '\n\n[... user context truncated for Groq size limits ...]\n\n' +
        customContext.slice(-Math.floor(budgetForCustom / 2));

    return head + trimmedCustom + footer;
}

function prepareGroqChatMessages(history) {
    const systemContent = trimSystemPromptForGroq(currentSystemPrompt || 'You are a helpful assistant.');
    const trimmedHistory = trimConversationHistoryForGemma(history, GROQ_MAX_HISTORY_CHARS);
    return [{ role: 'system', content: systemContent }, ...trimmedHistory];
}

function parseGroqErrorBody(errorText) {
    if (!errorText || typeof errorText !== 'string') {
        return null;
    }
    try {
        const parsed = JSON.parse(errorText);
        return parsed?.error?.message || null;
    } catch {
        return null;
    }
}

function isGroqTokenLimitError(status, errorText) {
    const apiMessage = parseGroqErrorBody(errorText) || errorText || '';
    return (
        status === 413 ||
        status === 429 ||
        /tokens per minute|\bTPM\b|rate_limit_exceeded|too large for model|reduce your message size/i.test(apiMessage)
    );
}

function groqHttpErrorMessage(status, errorText) {
    const apiMessage = parseGroqErrorBody(errorText);
    if (isGroqTokenLimitError(status, errorText)) {
        if (apiMessage && /Requested\s+(\d+).*Limit\s+(\d+)/i.test(apiMessage)) {
            const match = apiMessage.match(/Requested\s+([\d,]+).*Limit\s+([\d,]+)/i);
            if (match) {
                const requested = match[1].replace(/,/g, '');
                const limit = match[2].replace(/,/g, '');
                return `Groq token limit: this request needs ~${requested} tokens but your plan allows ~${limit} per request. Use screenshot quality Low, shrink profile context, or upgrade at console.groq.com/settings/billing.`;
            }
        }
        return GROQ_PAYLOAD_TOO_LARGE_MESSAGE;
    }
    if (apiMessage) {
        return `Groq error: ${apiMessage}`;
    }
    if (errorText && /context|too long|payload|entity too large/i.test(errorText)) {
        return GROQ_PAYLOAD_TOO_LARGE_MESSAGE;
    }
    return `Groq error: ${status}`;
}

function shouldFallbackGroqImageToGemini(result) {
    if (!result || result.success) {
        return false;
    }
    // Fall back to Gemini on any Groq image request failure (e.g. rate limit, over capacity, etc.)
    return true;
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

function splitSseLines(pendingText, chunk, flush = false) {
    const lines = (pendingText + chunk).split('\n');
    const remainder = lines.pop();
    if (flush && remainder) lines.push(remainder);
    return { lines: lines.map(line => line.replace(/\r$/, '')), pendingText: flush ? '' : remainder };
}

async function* readSseData(body, onChunk = () => {}) {
    const decoder = new TextDecoder();
    let pendingText = '';
    // Flush both the UTF-8 decoder and the final line when the stream ends.
    async function* chunks() {
        for await (const value of body) yield { text: decoder.decode(value, { stream: true }), flush: false };
        yield { text: decoder.decode(), flush: true };
    }
    for await (const { text, flush } of chunks()) {
        if (text) onChunk(text);
        const result = splitSseLines(pendingText, text, flush);
        pendingText = result.pendingText;
        for (const line of result.lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            if (data) yield data;
        }
    }
}

async function sendToGroq(transcription) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        console.log('No Groq API key configured, skipping Groq response');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Groq');
        return;
    }

    const config = getConfig();
    const modelToUse = config.groqModel;

    console.log(`Sending to Groq (${modelToUse}):`, transcription.substring(0, 100) + '...');
    logTransportEvent('groq.text.request', {
        model: modelToUse,
        transcription,
    });

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    const groqMessages = prepareGroqChatMessages(groqConversationHistory);

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: groqMessages,
                stream: true,
                temperature: 0.7,
                max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
                ...getGroqReasoningOptions(modelToUse, config.disableGroqThinking),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Groq API error:', response.status, errorText);
            logTransportEvent('groq.text.http_error', {
                status: response.status,
                body: errorText,
            });
            groqConversationHistory.pop();
            groqRequestStartedForTurn = false;
            const statusMessage = groqHttpErrorMessage(response.status, errorText);
            if (getApiKey()) {
                console.log('Groq text request failed; falling back to Gemini HTTP');
                sendToRenderer('update-status', 'Groq error — falling back to Gemini...');
                await sendToGemma(transcription);
            } else {
                sendToRenderer('update-status', statusMessage);
                if (response.status === 413) {
                    sendToRenderer('new-response', statusMessage);
                }
            }
            return;
        }

        logTransportEvent('groq.text.http_response', {
            status: response.status,
        });

        let fullText = '';
        let isFirst = true;
        let finishReason = null;

        for await (const data of readSseData(response.body, chunk => logTransportEvent('groq.text.stream_chunk', { chunk }))) {
            try {
                const json = JSON.parse(data);
                logTransportEvent('groq.text.stream_event', json);
                finishReason = json.choices?.[0]?.finish_reason || finishReason;
                const token = json.choices?.[0]?.delta?.content || '';
                if (token) {
                    fullText += token;
                    const displayText = stripThinkingTags(fullText);
                    if (displayText) {
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                        isFirst = false;
                    }
                }
            } catch (parseError) {
                logTransportEvent('groq.text.stream_parse_error', {
                    data,
                    error: parseError.message,
                });
            }
        }

        const cleanedResponse = stripThinkingTags(fullText);
        const modelKey = modelToUse.split('/').pop();

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = cleanedResponse.length;

        incrementCharUsage('groq', modelKey, inputChars + outputChars);

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        } else {
            console.warn(`Groq returned no final answer (${modelToUse})`);
            logTransportEvent('groq.text.empty_response', {
                model: modelToUse,
                fullText,
                finishReason,
            });
            sendToRenderer('new-response', GROQ_EMPTY_RESPONSE_MESSAGE);
            sendToRenderer('update-status', 'Groq reached the completion-token limit');
            return;
        }

        logTransportEvent('groq.text.completed', {
            model: modelToUse,
            response: cleanedResponse,
        });
        console.log(`Groq response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Groq API:', error);
        groqConversationHistory.pop();
        groqRequestStartedForTurn = false;
        logTransportEvent('groq.text.error', {
            error: error.message,
            stack: error.stack,
        });
        sendToRenderer('update-status', 'Groq error: ' + error.message);
    }
}

async function sendImageToGroq(base64Data, prompt) {
    const groqApiKey = getGroqApiKey();
    const config = getConfig();
    const model = config.groqImageModel;
    const userPrompt = GROQ_VISION_SCREENSHOT_PROMPT;

    if (base64Data.length > GROQ_MAX_IMAGE_BASE64_CHARS) {
        const error = GROQ_PAYLOAD_TOO_LARGE_MESSAGE;
        sendToRenderer('update-status', error);
        return { success: false, error };
    }

    logTransportEvent('groq.image.request', {
        model,
        prompt: userPrompt,
        originalPromptLength: (prompt || '').length,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    const imageSystemPrompt = 'You analyze screenshots and answer concisely. Follow the user message for format and depth.';

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: imageSystemPrompt },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userPrompt },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`,
                                },
                            },
                        ],
                    },
                ],
                stream: true,
                temperature: 0.7,
                max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
                ...getGroqReasoningOptions(model, config.disableGroqThinking),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Groq image API error:', response.status, errorText);
            logTransportEvent('groq.image.http_error', {
                status: response.status,
                body: errorText,
            });
            const error = groqHttpErrorMessage(response.status, errorText);
            sendToRenderer('update-status', error);
            return { success: false, error, groqStatus: response.status, groqBody: errorText };
        }

        logTransportEvent('groq.image.http_response', {
            status: response.status,
        });

        let fullText = '';
        let isFirst = true;
        let finishReason = null;

        for await (const data of readSseData(response.body, chunk => logTransportEvent('groq.image.stream_chunk', { chunk }))) {
            try {
                const json = JSON.parse(data);
                logTransportEvent('groq.image.stream_event', json);
                finishReason = json.choices?.[0]?.finish_reason || finishReason;
                const token = json.choices?.[0]?.delta?.content || '';
                if (!token) continue;

                fullText += token;
                const displayText = stripThinkingTags(fullText);
                if (displayText) {
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                    isFirst = false;
                }
            } catch (parseError) {
                logTransportEvent('groq.image.stream_parse_error', {
                    data,
                    error: parseError.message,
                });
            }
        }

        const cleanedResponse = stripThinkingTags(fullText);
        if (!cleanedResponse) {
            logTransportEvent('groq.image.empty_response', {
                model,
                fullText,
                finishReason,
            });
            return { success: false, error: GROQ_EMPTY_RESPONSE_MESSAGE };
        }

        saveScreenAnalysis(userPrompt, cleanedResponse, model);
        logTransportEvent('groq.image.completed', {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error('Error calling Groq image API:', error);
        logTransportEvent('groq.image.error', {
            error: error.message,
            stack: error.stack,
        });
        return { success: false, error: error.message };
    }
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const model = getAvailableModel();
        const response = await ai.models.generateContentStream({
            model: model,
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', model, inputChars + outputChars);
        incrementLimitCount(model);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // A fresh session invalidates pending reconnects from the previous session.
    if (!isReconnect) {
        sessionGeneration++;
        initializeNewSession(profile, customPrompt);
        sessionParams = { apiKey, customPrompt, profile, language };
    }
    const generation = sessionGeneration;
    let connectionClosed = false;

    try {
        const client = new GoogleGenAI({
            vertexai: false,
            apiKey: apiKey,
            httpOptions: { apiVersion: 'v1alpha' },
        });

        // Get enabled tools first to determine Google Search status
        const enabledTools = await getEnabledTools();
        if (isUserClosing || generation !== sessionGeneration) return null;
        const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

        const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
        currentSystemPrompt = systemPrompt; // Store for Groq

        const session = await client.live.connect({
            model: getConfig().geminiLiveModel,
            callbacks: {
                onopen: function () {
                    if (isUserClosing || generation !== sessionGeneration || connectionClosed) return;
                    logTransportEvent('gemini.live.opened', {});
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    if (isUserClosing || generation !== sessionGeneration || connectionClosed) return;
                    logTransportEvent('gemini.live.message', message);

                    // Handle input transcription (what was spoken)
                    if (message.serverContent?.inputTranscription?.results) {
                        currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                    } else if (message.serverContent?.inputTranscription?.text) {
                        const text = message.serverContent.inputTranscription.text;
                        if (text.trim() !== '') {
                            currentTranscription += text;
                        }
                    }

                    if (!hasGroqKey() && message.serverContent?.outputTranscription?.text) {
                        const isFirstChunk = messageBuffer === '';
                        messageBuffer += message.serverContent.outputTranscription.text;
                        sendToRenderer(isFirstChunk ? 'new-response' : 'update-response', messageBuffer);
                    }

                    if (message.serverContent?.generationComplete) {
                        if (currentTranscription.trim() !== '') {
                            if (!hasGroqKey() && messageBuffer.trim() !== '') {
                                saveConversationTurn(currentTranscription, messageBuffer);
                            }
                            if (!hasGroqKey()) {
                                currentTranscription = '';
                            }
                        }
                        messageBuffer = '';
                    }

                    if (message.serverContent?.turnComplete) {
                        sendFinalTranscriptionToGroq();
                        currentTranscription = '';
                        messageBuffer = '';
                        groqRequestStartedForTurn = false;
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    if (isUserClosing || generation !== sessionGeneration || connectionClosed) return;
                    console.log('Session error:', e.message);
                    logTransportEvent('gemini.live.error', {
                        error: e.message,
                    });
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    if (isUserClosing || generation !== sessionGeneration || connectionClosed) return;
                    connectionClosed = true;
                    if (global.geminiSessionRef) global.geminiSessionRef.current = null;
                    console.log('Session closed:', e.reason);
                    logTransportEvent('gemini.live.closed', { reason: e.reason });
                    resetSessionAudio();
                    if (sessionParams) {
                        void attemptReconnect();
                    } else {
                        closeTransportLog();
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
                responseModalities: [Modality.AUDIO],
                proactivity: { proactiveAudio: true },
                outputAudioTranscription: {},
                tools: enabledTools,
                // Enable speaker diarization
                inputAudioTranscription: {
                    enableSpeakerDiarization: true,
                    minSpeakerCount: 2,
                    maxSpeakerCount: 2,
                },
                contextWindowCompression: { slidingWindow: {} },
                speechConfig: { languageCode: language },
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
            },
        });

        if (isUserClosing || generation !== sessionGeneration || connectionClosed) {
            await session.close();
            return null;
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        return null;
    } finally {
        if (generation === sessionGeneration) {
            isInitializingSession = false;
            if (!isReconnect) sendToRenderer('session-initializing', false);
        }
    }
}

async function attemptReconnect() {
    const generation = sessionGeneration;
    if (isUserClosing || !sessionParams || reconnectRun?.generation === generation) return false;
    const run = { generation };
    reconnectRun = run;
    const params = sessionParams;
    const isCurrent = () => !isUserClosing && generation === sessionGeneration && sessionParams === params;

    try {
        while (isCurrent() && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            messageBuffer = '';
            currentTranscription = '';
            sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
            if (!isCurrent()) return false;

            const session = await initializeGeminiSession(params.apiKey, params.customPrompt, params.profile, params.language, true);
            if (!isCurrent()) {
                if (session) await session.close();
                return false;
            }
            if (session === false) {
                reconnectAttempts--;
                return false;
            }
            if (!session) continue;

            if (global.geminiSessionRef) global.geminiSessionRef.current = session;
            // Only consecutive failures count against the retry cap.
            reconnectAttempts = 0;
            // The new transport may close while context restoration is awaiting I/O.
            // Release this run so its onclose can schedule another reconnect.
            if (reconnectRun === run) reconnectRun = null;
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (error) {
                    console.error('Failed to restore context:', error);
                }
            }
            if (!isCurrent() || (global.geminiSessionRef && global.geminiSessionRef.current !== session)) return false;
            sendToRenderer('update-status', 'Reconnected! Listening...');
            return true;
        }

        if (isCurrent()) {
            const message = 'Reconnection failed after 3 attempts. Check your connection and start a new session.';
            sendToRenderer('update-status', message);
            sendToRenderer('reconnect-failed', { message });
            sessionParams = null;
            if (global.geminiSessionRef) global.geminiSessionRef.current = null;
            resetSessionAudio();
            closeTransportLog();
        }
        return false;
    } finally {
        if (reconnectRun === run) reconnectRun = null;
    }
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    try {
        systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

        systemAudioProc.on('error', err => {
            console.error('SystemAudioDump process error event:', err.message);
        });
    } catch (err) {
        console.error('SystemAudioDump spawn exception:', err.message);
        return false;
    }

    if (!systemAudioProc || !systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump (missing pid)');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk, 'system');
            } else if (hasGroqKey()) {
                processAudioForGroq(monoChunk, 'system');
            } else {
                const base64Data = monoChunk.toString('base64');
                if (sessionAudioMode === 'both') {
                    queueGeminiAudio(base64Data, 'audio/pcm;rate=24000', geminiSessionRef, 'system').catch(error => {
                        console.error('Error mixing system audio:', error);
                    });
                } else {
                    sendAudioToGemini(base64Data, geminiSessionRef);
                }
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function queueGeminiAudio(data, mimeType, geminiSessionRef, source) {
    if (!geminiSessionRef.current || isUserClosing) return;
    if (sessionAudioMode !== 'both') {
        return geminiSessionRef.current?.sendRealtimeInput({ audio: { data, mimeType } });
    }
    if (!geminiAudioMixer) {
        geminiAudioMixer = createAudioMixer(chunk => sendAudioToGemini(chunk.toString('base64'), geminiSessionRef));
    }
    geminiAudioMixer.push(source, Buffer.from(data, 'base64'));
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    // Get available model based on rate limits
    const model = getAvailableModel();

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Increment count after successful call
        incrementLimitCount(model);

        // Stream the response
        let fullText = '';
        let isFirst = true;
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                // Send to renderer - new response for first chunk, update for subsequent
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            sessionGeneration++;
            sessionParams = null;
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';

        if (hasGroqKey()) {
            console.log('Groq key is present. Initializing directly in Groq VAD mode (bypassing Gemini Live to avoid quota limits).');
            const generation = ++sessionGeneration;
            initializeNewSession(profile, customPrompt);
            sessionParams = { apiKey, customPrompt, profile, language };
            const enabledTools = await getEnabledTools();
            if (isUserClosing || generation !== sessionGeneration) return false;
            const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);
            currentSystemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
            sendToRenderer('update-status', 'Listening...');
            geminiSessionRef.current = null;
            return true;
        }

        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt) => {
        const generation = ++sessionGeneration;
        sessionParams = null;
        resetSessionAudio();
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt);
        if (!success && generation === sessionGeneration) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const generation = sessionGeneration;
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled && generation === sessionGeneration) {
            currentProviderMode = 'byok';
        }
        return cancelled;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer, 'system');
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (hasGroqKey()) {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                processAudioForGroq(pcmBuffer, 'system');
                return { success: true };
            } catch (error) {
                console.error('Error sending system audio to Groq VAD:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await queueGeminiAudio(data, mimeType, geminiSessionRef, 'system');
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer, 'mic');
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (hasGroqKey()) {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                processAudioForGroq(pcmBuffer, 'mic');
                return { success: true };
            } catch (error) {
                console.error('Error sending mic audio to Groq VAD:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await queueGeminiAudio(data, mimeType, geminiSessionRef, 'mic');
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            if (hasGroqKey()) {
                let result = await sendImageToGroq(data, prompt);
                if (shouldFallbackGroqImageToGemini(result) && getApiKey()) {
                    console.log('Groq image request over token limit; falling back to Gemini HTTP');
                    sendToRenderer('update-status', 'Groq token limit — analyzing screenshot with Gemini instead…');
                    result = await sendImageToGeminiHttp(data, prompt);
                }
                return result;
            }

            const result = await sendImageToGeminiHttp(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Llama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (!geminiSessionRef.current) {
            if (hasGroqKey()) {
                console.log('No active live session. Falling back to Groq for text message.');
                groqRequestStartedForTurn = true;
                sendToGroq(text.trim());
                return { success: true };
            } else if (getApiKey()) {
                console.log('No active live session. Falling back to Gemma for text message.');
                sendToGemma(text.trim());
                return { success: true };
            }
            return { success: false, error: 'No active Gemini session' };
        }

        try {
            console.log('Sending text message:', text);

            if (hasGroqKey()) {
                groqRequestStartedForTurn = true;
                sendToGroq(text.trim());
            }

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        isUserClosing = true;
        const generation = ++sessionGeneration;
        isInitializingSession = false;
        sessionParams = null;
        resetSessionAudio();
        closeTransportLog();
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                return { success: true };
            }

            // Cleanup session
            if (geminiSessionRef.current) {
                const session = geminiSessionRef.current;
                geminiSessionRef.current = null;
                await session.close();
            }

            if (generation === sessionGeneration) sendToRenderer('update-status', 'Session closed');
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    splitSseLines,
    readSseData,
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
