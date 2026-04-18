document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & Defaults ---
    const DEFAULT_REALTIME_PROMPT = "あなたは優秀なビジネスコンサルタントです。送られた会話の内容から、次に深掘りすべき質問や、議論のズレに対する指摘を、簡潔に2〜3行のテキストで提示してください。";
    const DEFAULT_MINUTES_PROMPT = "以下の会議ログを、B2BコーポレートサイトやヘッドレスCMSにそのまま流し込めるように、厳密に構造化されたMarkdown形式（## や - を使用）で議事録として要約してください。余計な挨拶や前置きは不要です。";
    const ADVICE_THRESHOLD_CHARS = 100;

    // --- State ---
    let isRecording = false;
    let recognition = null;
    let fullTranscript = "";
    let lastAdviceIndex = 0; // The index in fullTranscript where we last sent to AI

    // --- DOM Elements ---
    const startBtn = document.getElementById('startBtn');
    const endBtn = document.getElementById('endBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingsForm = document.getElementById('settingsForm');
    
    // Settings inputs
    const apiKeyInput = document.getElementById('apiKeyInput');
    const webhookUrlInput = document.getElementById('webhookUrlInput');
    const realtimePromptInput = document.getElementById('realtimePromptInput');
    const minutesPromptInput = document.getElementById('minutesPromptInput');

    const transcriptContent = document.getElementById('transcriptContent');
    const aiAdviceContent = document.getElementById('aiAdviceContent');
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    const minutesModal = document.getElementById('minutesModal');
    const closeMinutesBtn = document.getElementById('closeMinutesBtn');
    const minutesOutput = document.getElementById('minutesOutput');
    const copyMinutesBtn = document.getElementById('copyMinutesBtn');

    // --- Initialization ---
    initSettings();
    initSpeechRecognition();
    initPWA();

    // --- Functions ---
    function initPWA() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('Service Worker Registered'))
                .catch(err => console.error('Service Worker Error', err));
        }
    }

    function initSettings() {
        // Load from LocalStorage
        apiKeyInput.value = localStorage.getItem('geminiApiKey') || '';
        webhookUrlInput.value = localStorage.getItem('webhookUrl') || '';
        realtimePromptInput.value = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        minutesPromptInput.value = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;

        if (!apiKeyInput.value) {
            // Show settings if API key is missing
            settingsModal.classList.remove('hidden');
        }
    }

    // Save Settings
    settingsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        localStorage.setItem('geminiApiKey', apiKeyInput.value.trim());
        localStorage.setItem('webhookUrl', webhookUrlInput.value.trim());
        localStorage.setItem('realtimePrompt', realtimePromptInput.value.trim());
        localStorage.setItem('minutesPrompt', minutesPromptInput.value.trim());
        settingsModal.classList.add('hidden');
    });

    // Modal toggles
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
               checkAndFetchAdvice();
            }

            // Update UI with bold text for visibility
            transcriptContent.innerHTML = '<span class="font-bold">' + fullTranscript + '</span>' + '<span class="text-gray-400">' + interimTranscript + '</span>';
            scrollToBottom(transcriptContent.parentElement);
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error', event.error);
        };

        recognition.onend = () => {
            // Auto-restart if we are supposed to be recording
            if (isRecording) {
                console.log('Restarting speech recognition...');
                try {
                    recognition.start();
                } catch(e) {
                    console.error("Failed to restart recognition:", e);
                }
            }
        };
    }

    startBtn.addEventListener('click', () => {
        if (!localStorage.getItem('geminiApiKey')) {
            alert("最初に設定（右上の歯車アイコン）からGemini APIキーを入力してください。");
            settingsModal.classList.remove('hidden');
            return;
        }

        fullTranscript = "";
        aiAdviceContent.innerHTML = "";
        lastAdviceIndex = 0;
        transcriptContent.innerHTML = "";
        
        isRecording = true;
        startBtn.classList.add('hidden');
        endBtn.classList.remove('hidden');
        
        try {
            recognition.start();
            addAdviceToUI("会議を開始しました。文字起こしが一定量溜まると、自動でアドバイスが表示されます...", "system");
        } catch(e) {
            console.error(e);
        }
    });

    endBtn.addEventListener('click', async () => {
        isRecording = false;
        recognition.stop();
        
        endBtn.classList.add('hidden');
        startBtn.classList.remove('hidden');

        if (fullTranscript.trim().length > 0) {
            await finishMeeting();
        } else {
            alert("文字起こしされたテキストが存在しないため、議事録は生成されません。");
        }
    });

    function scrollToBottom(container) {
        container.scrollTop = container.scrollHeight;
    }

    function addAdviceToUI(text, type="ai") {
        const div = document.createElement('div');
        div.className = `p-4 rounded-xl advice-item ${type === 'system' ? 'bg-gray-100 text-gray-500 text-base' : 'bg-blue-50 border border-blue-200 text-blue-900 shadow-sm'}`;
        
        if (type === 'ai') {
             div.innerHTML = `<div class="font-bold text-sm text-blue-600 mb-2 flex items-center">
                 <svg class="w-5 h-5 mr-1" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd" /></svg>
                 AI Assistant
             </div>${text.replace(/\n/g, '<br>')}`;
        } else {
             div.innerText = text;
        }

        aiAdviceContent.prepend(div);
    }

    async function checkAndFetchAdvice() {
        const newText = fullTranscript.substring(lastAdviceIndex);
        if (newText.length >= ADVICE_THRESHOLD_CHARS) {
            // Include a chunk of recent transcript instead of the entire thing to avoid gigantic prompt tokens over time?
            // Actually, for better context, full transcript is usually fine until it hits the model limits.
            const contextToSend = fullTranscript;
            lastAdviceIndex = fullTranscript.length;
            await callGeminiForAdvice(contextToSend);
        }
    }

    async function callGeminiForAdvice(transcript) {
        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        
        try {
            // Using flash for faster real-time response
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt + "\n\n【ここまでの会話ログ】\n" + transcript }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 250
                    }
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            
            const data = await response.json();
            const textResponse = data.candidates[0].content.parts[0].text;
            addAdviceToUI(textResponse);
        } catch(e) {
            console.error("Gemini API Error for advice:", e);
        }
    }

    async function finishMeeting() {
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('flex');
        
        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;
        const webhookUrl = localStorage.getItem('webhookUrl');

        try {
            // Using pro for better reasoning and structuring
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt + "\n\n【会議ログ全体】\n" + fullTranscript }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.2
                    }
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await response.json();
            const minutesMarkdown = data.candidates[0].content.parts[0].text;

            // Show minutes modal
            minutesOutput.textContent = minutesMarkdown;
            minutesModal.classList.remove('hidden');

            // Send to Webhook if configured
            if (webhookUrl) {
                await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: minutesMarkdown })
                }).catch(err => console.error("Webhook POST Error", err));
            }
            
        } catch(e) {
            console.error(e);
            alert("議事録の生成に失敗しました: " + e.message);
        } finally {
            loadingOverlay.classList.add('hidden');
            loadingOverlay.classList.remove('flex');
        }
    }

    // Minutes Modal actions
    closeMinutesBtn.addEventListener('click', () => {
        minutesModal.classList.add('hidden');
        // Reset state for next meeting
        transcriptContent.innerHTML = "";
        aiAdviceContent.innerHTML = "";
        fullTranscript = "";
    });

    copyMinutesBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(minutesOutput.textContent).then(() => {
            const originalText = copyMinutesBtn.innerText;
            copyMinutesBtn.innerText = "コピーしました！";
            setTimeout(() => { copyMinutesBtn.innerText = originalText; }, 2000);
        });
    });

});
