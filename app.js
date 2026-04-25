document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & Defaults ---
    const DEFAULT_REALTIME_PROMPT = "あなたは優秀なビジネスコンサルタントです。送られた会話の内容から、次に深掘りすべき質問や、議論のズレに対する指摘を、簡潔に2〜3行のテキストで提示してください。";
    const DEFAULT_MINUTES_PROMPT = "以下の会議ログを、B2BコーポレートサイトやヘッドレスCMSにそのまま流し込めるように、厳密に構造化されたMarkdown形式（## や - を使用）で議事録として要約してください。余計な挨拶や前置きは不要です。";
    const ADVICE_THRESHOLD_CHARS = 200;
    const GEMINI_MODEL = 'gemini-2.5-flash-lite';
    const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const API_TIMEOUT_MS = 30000;
    const MAX_RESTART_ATTEMPTS = 10;

    // --- State ---
    let isRecording = false;
    let recognition = null;
    let fullTranscript = "";
    let lastAdviceIndex = 0;
    let isFetchingAdvice = false;
    let restartTimeout = null;
    let restartCount = 0;

    // --- DOM Elements ---
    const startBtn = document.getElementById('startBtn');
    const endBtn = document.getElementById('endBtn');
    const midwaySummaryBtn = document.getElementById('midwaySummaryBtn');
    const recordingStatusIndicator = document.getElementById('recordingStatusIndicator');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingsForm = document.getElementById('settingsForm');

    const apiKeyInput = document.getElementById('apiKeyInput');
    const webhookUrlInput = document.getElementById('webhookUrlInput');
    const realtimePromptInput = document.getElementById('realtimePromptInput');
    const minutesPromptInput = document.getElementById('minutesPromptInput');

    const transcriptContent = document.getElementById('transcriptContent');
    const aiAdviceContent = document.getElementById('aiAdviceContent');

    const loadingOverlay = document.getElementById('loadingOverlay');
    const minutesModal = document.getElementById('minutesModal');
    const minutesModalTitle = document.getElementById('minutesModalTitle');
    const closeMinutesBtn = document.getElementById('closeMinutesBtn');
    const minutesOutput = document.getElementById('minutesOutput');
    const copyMinutesBtn = document.getElementById('copyMinutesBtn');
    const downloadMinutesBtn = document.getElementById('downloadMinutesBtn');

    // --- Initialization ---
    initSettings();
    initSpeechRecognition();
    initPWA();

    // --- Utility ---

    function updateStatus(status, type = 'normal') {
        if (!recordingStatusIndicator) return;
        recordingStatusIndicator.classList.remove(
            'hidden', 'bg-gray-200', 'text-gray-600',
            'bg-red-100', 'text-red-700',
            'bg-blue-100', 'text-blue-700',
            'bg-yellow-100', 'text-yellow-700'
        );
        recordingStatusIndicator.textContent = status;
        switch (type) {
            case 'recording':
                recordingStatusIndicator.classList.add('bg-red-100', 'text-red-700');
                break;
            case 'active':
                recordingStatusIndicator.classList.add('bg-blue-100', 'text-blue-700');
                break;
            case 'error':
                recordingStatusIndicator.classList.add('bg-yellow-100', 'text-yellow-700');
                break;
            default:
                recordingStatusIndicator.classList.add('bg-gray-200', 'text-gray-600');
                if (status === '待機中' || status === '') recordingStatusIndicator.classList.add('hidden');
        }
    }

    function showToast(message, duration = 4000) {
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-[100] text-sm pointer-events-none';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    function endMeetingUI() {
        isRecording = false;
        restartCount = 0;
        clearTimeout(restartTimeout);
        endBtn.classList.add('hidden');
        midwaySummaryBtn.classList.add('hidden');
        startBtn.classList.remove('hidden');
        updateStatus('待機中', 'normal');
    }

    function scrollToBottom(container) {
        container.scrollTop = container.scrollHeight;
    }

    function addAdviceToUI(text, type = "ai") {
        const div = document.createElement('div');
        div.className = `p-4 rounded-xl advice-item ${type === 'system' ? 'bg-gray-100 text-gray-500 text-base' : 'bg-blue-50 border border-blue-200 text-blue-900 shadow-sm'}`;

        if (type === 'ai') {
            const header = document.createElement('div');
            header.className = 'font-bold text-sm text-blue-600 mb-2 flex items-center';
            // Static hardcoded SVG — safe to use innerHTML here
            header.innerHTML = `<svg class="w-5 h-5 mr-1" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd" /></svg>AI Assistant`;
            const content = document.createElement('div');
            content.style.whiteSpace = 'pre-wrap';
            content.textContent = text; // Safe: never use innerHTML for AI/user text
            div.append(header, content);
        } else {
            div.textContent = text;
        }

        aiAdviceContent.prepend(div);
        return div;
    }

    // --- Gemini API ---

    function getApiErrorMessage(status, errorData) {
        const detail = errorData?.error?.message ? ` (${errorData.error.message})` : '';
        if (status === 400) return `リクエストエラー${detail}`;
        if (status === 401 || status === 403) return 'APIキーが無効または権限がありません。設定を確認してください。';
        if (status === 429) return 'APIのレート制限に達しました。しばらく待ってから再試行してください。';
        if (status === 404) return 'APIエンドポイントが見つかりません。モデル名またはAPIバージョンを確認してください。';
        if (status >= 500) return `Gemini APIサーバーエラー (${status})。時間をおいて再試行してください。`;
        return `APIエラー (${status})`;
    }

    async function callGeminiAPI(prompt, { temperature = 0.7, maxOutputTokens = 500 } = {}) {
        const apiKey = localStorage.getItem('geminiApiKey');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const response = await fetch(
                `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature, maxOutputTokens }
                    })
                }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(getApiErrorMessage(response.status, errorData));
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('AIから有効な回答が得られませんでした。');
            return text;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('APIリクエストがタイムアウトしました（30秒）。');
            throw e;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // --- Setup ---

    function initPWA() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js')
                .then(() => console.log('Service Worker Registered'))
                .catch((err) => console.error('Service Worker Error', err));
        }
    }

    function initSettings() {
        apiKeyInput.value = localStorage.getItem('geminiApiKey') || '';
        webhookUrlInput.value = localStorage.getItem('webhookUrl') || '';
        realtimePromptInput.value = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        minutesPromptInput.value = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;

        if (!apiKeyInput.value) {
            settingsModal.classList.remove('hidden');
        }
    }

    settingsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        localStorage.setItem('geminiApiKey', apiKeyInput.value.trim());
        localStorage.setItem('webhookUrl', webhookUrlInput.value.trim());
        localStorage.setItem('realtimePrompt', realtimePromptInput.value.trim());
        localStorage.setItem('minutesPrompt', minutesPromptInput.value.trim());
        settingsModal.classList.add('hidden');
        showToast('設定を保存しました。');
    });

    settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

    function initSpeechRecognition() {
        window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!window.SpeechRecognition) {
            alert('お使いのブラウザは音声認識をサポートしていません。ChromeまたはEdge等をご利用ください。');
            return;
        }

        recognition = new window.SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'ja-JP';

        recognition.onstart = () => updateStatus('🔴 録音中', 'recording');
        recognition.onaudiostart = () => updateStatus('🎙️ 音声検知中...', 'active');
        recognition.onsoundend = () => updateStatus('🔴 録音中', 'recording');

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscriptSegment = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscriptSegment += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            if (finalTranscriptSegment) {
                fullTranscript += finalTranscriptSegment + " ";
                restartCount = 0; // Reset on successful recognition
                checkAndFetchAdvice();
            }

            // Safe DOM rendering — never inject transcript text via innerHTML
            const finalSpan = document.createElement('span');
            finalSpan.className = 'font-bold';
            finalSpan.textContent = fullTranscript;
            const interimSpan = document.createElement('span');
            interimSpan.className = 'text-gray-400';
            interimSpan.textContent = interimTranscript;
            transcriptContent.replaceChildren(finalSpan, interimSpan);
            scrollToBottom(transcriptContent.parentElement);
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                updateStatus('マイクアクセス拒否', 'error');
                isRecording = false;
                addAdviceToUI('⚠️ マイクへのアクセスが許可されていません。ブラウザの設定からマイクの権限をオンにし、ページを更新して再試行してください。', 'system');
                endMeetingUI();
            } else if (event.error === 'network') {
                updateStatus('ネットワークエラー', 'error');
            } else if (event.error === 'no-speech') {
                updateStatus('無音...再接続中', 'error');
            } else {
                updateStatus(`エラー: ${event.error}`, 'error');
            }
        };

        recognition.onend = () => {
            if (isRecording) {
                if (restartCount >= MAX_RESTART_ATTEMPTS) {
                    addAdviceToUI('⚠️ 音声認識が繰り返し失敗したため停止しました。ページを更新して再試行してください。', 'system');
                    endMeetingUI();
                    return;
                }
                restartCount++;
                updateStatus('再接続中...', 'error');
                clearTimeout(restartTimeout);
                restartTimeout = setTimeout(() => {
                    try {
                        recognition.start();
                    } catch (e) {
                        console.error("Failed to restart recognition:", e);
                    }
                }, 1000);
            } else {
                updateStatus('待機中', 'normal');
            }
        };
    }

    // --- Event Handlers ---

    startBtn.addEventListener('click', () => {
        if (!localStorage.getItem('geminiApiKey')) {
            alert("最初に設定（右上の歯車アイコン）からGemini APIキーを入力してください。");
            settingsModal.classList.remove('hidden');
            return;
        }

        fullTranscript = "";
        aiAdviceContent.innerHTML = "";
        lastAdviceIndex = 0;
        restartCount = 0;
        transcriptContent.replaceChildren();

        isRecording = true;
        startBtn.classList.add('hidden');
        endBtn.classList.remove('hidden');
        midwaySummaryBtn.classList.remove('hidden');

        try {
            recognition.start();
            addAdviceToUI("会議を開始しました。文字起こしが一定量溜まると、自動でアドバイスが表示されます...", "system");
        } catch (e) {
            console.error(e);
        }
    });

    midwaySummaryBtn.addEventListener('click', async () => {
        if (fullTranscript.trim().length > 0) {
            await generateSummary(false);
        } else {
            alert("文字起こしされたテキストが存在しないため、要約は生成されません。");
        }
    });

    endBtn.addEventListener('click', async () => {
        endMeetingUI();
        if (recognition) {
            try { recognition.stop(); } catch (e) { /* already stopped */ }
        }

        if (fullTranscript.trim().length > 0) {
            await generateSummary(true);
        } else {
            alert("文字起こしされたテキストが存在しないため、議事録は生成されません。");
        }
    });

    closeMinutesBtn.addEventListener('click', () => {
        minutesModal.classList.add('hidden');
        if (!isRecording) {
            transcriptContent.replaceChildren();
            aiAdviceContent.innerHTML = "";
            fullTranscript = "";
            lastAdviceIndex = 0;
            updateStatus('待機中', 'normal');
        }
    });

    copyMinutesBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(minutesOutput.textContent).then(() => {
            const originalText = copyMinutesBtn.textContent;
            copyMinutesBtn.textContent = "コピーしました！";
            setTimeout(() => { copyMinutesBtn.textContent = originalText; }, 2000);
        });
    });

    downloadMinutesBtn.addEventListener('click', () => {
        const text = minutesOutput.textContent;
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `minutes-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // --- Core Logic ---

    async function checkAndFetchAdvice() {
        if (isFetchingAdvice) return;

        const newText = fullTranscript.substring(lastAdviceIndex);
        if (newText.length >= ADVICE_THRESHOLD_CHARS) {
            isFetchingAdvice = true;
            const contextToSend = fullTranscript;
            lastAdviceIndex = fullTranscript.length;

            const loadingIndicator = addAdviceToUI("✨ AIがアドバイスを検討中...", "system");
            await callGeminiForAdvice(contextToSend, loadingIndicator);

            isFetchingAdvice = false;
            checkAndFetchAdvice(); // Process any backlog that accumulated during the API call
        }
    }

    async function callGeminiForAdvice(transcript, loadingIndicator) {
        const systemPrompt = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        const prompt = `${systemPrompt}\n\n【ここまでの会話ログ】\n${transcript}`;

        try {
            const text = await callGeminiAPI(prompt, { temperature: 0.7, maxOutputTokens: 250 });
            if (loadingIndicator?.parentNode) loadingIndicator.remove();
            addAdviceToUI(text);
        } catch (e) {
            console.error("Gemini API Error for advice:", e);
            if (loadingIndicator?.parentNode) loadingIndicator.remove();
            addAdviceToUI(`⚠️ AIアドバイス取得エラー:\n${e.message}`, "system");
        }
    }

    async function generateSummary(isFinal) {
        const loadingText = loadingOverlay.querySelector('p');
        if (loadingText) {
            loadingText.textContent = isFinal ? "議事録を生成・送信しています..." : "途中要約を生成しています...";
        }
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('flex');

        const systemPrompt = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;
        const prompt = `${systemPrompt}\n\n【会議ログ全体】\n${fullTranscript}`;
        const webhookUrl = localStorage.getItem('webhookUrl');

        try {
            const minutesMarkdown = await callGeminiAPI(prompt, { temperature: 0.2, maxOutputTokens: 2000 });

            minutesModalTitle.textContent = isFinal ? "生成された議事録" : "途中要約";
            minutesOutput.textContent = minutesMarkdown;
            minutesModal.classList.remove('hidden');

            if (isFinal && webhookUrl) {
                try {
                    const webhookResponse = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: minutesMarkdown })
                    });
                    if (!webhookResponse.ok) {
                        showToast(`⚠️ Webhook送信失敗 (${webhookResponse.status})`);
                    }
                } catch (err) {
                    console.error("Webhook POST Error", err);
                    showToast('⚠️ Webhookへの送信に失敗しました。');
                }
            }
        } catch (e) {
            console.error(e);
            alert("議事録の生成に失敗しました: " + e.message);
        } finally {
            loadingOverlay.classList.add('hidden');
            loadingOverlay.classList.remove('flex');
        }
    }
});
