document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & Defaults ---
    const DEFAULT_REALTIME_PROMPT = "あなたは優秀なビジネスコンサルタントです。送られた会話の内容から、次に深掘りすべき質問や、議論のズレに対する指摘を、簡潔に2〜3行のテキストで提示してください。";
    const DEFAULT_MINUTES_PROMPT = "以下の会議ログを、B2BコーポレートサイトやヘッドレスCMSにそのまま流し込めるように、厳密に構造化されたMarkdown形式（## や - を使用）で議事録として要約してください。余計な挨拶や前置きは不要です。";
    const ADVICE_THRESHOLD_CHARS = 50; // より頻繁にアドバイスを出すために50文字に短縮

    // --- State ---
    let isRecording = false;
    let recognition = null;
    let fullTranscript = "";
    let lastAdviceIndex = 0; // The index in fullTranscript where we last sent to AI
    let isFetchingAdvice = false;
    let restartTimeout = null;

    // --- DOM Elements ---
    const startBtn = document.getElementById('startBtn');
    const endBtn = document.getElementById('endBtn');
    const midwaySummaryBtn = document.getElementById('midwaySummaryBtn');
    const recordingStatusIndicator = document.getElementById('recordingStatusIndicator');
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
    const minutesModalTitle = document.getElementById('minutesModalTitle');
    const closeMinutesBtn = document.getElementById('closeMinutesBtn');
    const minutesOutput = document.getElementById('minutesOutput');
    const copyMinutesBtn = document.getElementById('copyMinutesBtn');

    // --- Initialization ---
    initSettings();
    initSpeechRecognition();
    initPWA();

    // --- Functions ---
    function updateStatus(status, type = 'normal') {
        if (!recordingStatusIndicator) return;
        recordingStatusIndicator.classList.remove('hidden', 'bg-gray-200', 'text-gray-600', 'bg-red-100', 'text-red-700', 'bg-blue-100', 'text-blue-700', 'bg-yellow-100', 'text-yellow-700');
        
        recordingStatusIndicator.textContent = status;
        
        switch(type) {
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

    function endMeetingUI() {
        isRecording = false;
        clearTimeout(restartTimeout);
        endBtn.classList.add('hidden');
        midwaySummaryBtn.classList.add('hidden');
        startBtn.classList.remove('hidden');
        updateStatus('待機中', 'normal');
    }

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

        recognition.onstart = () => {
            updateStatus('🔴 録音中', 'recording');
        };

        recognition.onaudiostart = () => {
            updateStatus('🎙️ 音声検知中...', 'active');
        };

        recognition.onsoundend = () => {
            updateStatus('🔴 録音中', 'recording');
        };

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
            console.error('Speech recognition error:', event.error);
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                updateStatus('マイクアクセス拒否', 'error');
                isRecording = false; // Stop auto-restarting permanently
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
            // Auto-restart if we are supposed to be recording
            if (isRecording) {
                console.log('Restarting speech recognition...');
                updateStatus('再接続中...', 'error');
                clearTimeout(restartTimeout);
                restartTimeout = setTimeout(() => {
                    try {
                        recognition.start();
                    } catch(e) {
                        console.error("Failed to restart recognition:", e);
                        // Make sure we update UI if it permanently fails
                    }
                }, 1000); // 1秒おいてから再起動（無限ループクラッシュ防止）
            } else {
                updateStatus('待機中', 'normal');
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
        midwaySummaryBtn.classList.remove('hidden');
        
        try {
            recognition.start();
            addAdviceToUI("会議を開始しました。文字起こしが一定量溜まると、自動でアドバイスが表示されます...", "system");
        } catch(e) {
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
            try {
                recognition.stop();
            } catch(e) {}
        }
        
        if (fullTranscript.trim().length > 0) {
            await generateSummary(true);
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
        return div;
    }

    async function checkAndFetchAdvice() {
        // すでにAPIを叩いている最中なら重複して送らない
        if (isFetchingAdvice) return;

        const newText = fullTranscript.substring(lastAdviceIndex);
        if (newText.length >= ADVICE_THRESHOLD_CHARS) {
            isFetchingAdvice = true;
            const contextToSend = fullTranscript;
            lastAdviceIndex = fullTranscript.length;
            
            const loadingIndicator = addAdviceToUI("✨ AIがアドバイスを検討中...", "system");
            await callGeminiForAdvice(contextToSend, loadingIndicator);
            
            isFetchingAdvice = false;
            // もしAPI通信中にさらに50文字以上溜まっていたら再帰的に処理する
            checkAndFetchAdvice();
        }
    }

    async function callGeminiForAdvice(transcript, loadingIndicator) {
        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        
        try {
            // Using flash for faster real-time response
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error("API Response Error:", errorData);
                throw new Error(`API通信エラー (${response.status}): APIキー設定等が正しいかご確認ください。`);
            }
            
            const data = await response.json();
            if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content) {
                throw new Error("AIから有効な回答が得られませんでした。");
            }
            
            if (loadingIndicator && loadingIndicator.parentNode) {
                loadingIndicator.parentNode.removeChild(loadingIndicator);
            }

            const textResponse = data.candidates[0].content.parts[0].text;
            addAdviceToUI(textResponse);
        } catch(e) {
            console.error("Gemini API Error for advice:", e);
            if (loadingIndicator && loadingIndicator.parentNode) {
                loadingIndicator.parentNode.removeChild(loadingIndicator);
            }
            addAdviceToUI(`⚠️ AIアドバイス取得エラー:\n${e.message}`, "system");
        }
    }

    async function generateSummary(isFinal) {
        let loadingText = loadingOverlay.querySelector('p');
        if(loadingText) {
            loadingText.textContent = isFinal ? "議事録を生成・送信しています..." : "途中要約を生成しています...";
        }
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('flex');
        
        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;
        const webhookUrl = localStorage.getItem('webhookUrl');

        try {
            // Using flash for high capacity and fast response
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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
            minutesModalTitle.textContent = isFinal ? "生成された議事録" : "途中要約";
            minutesOutput.textContent = minutesMarkdown;
            minutesModal.classList.remove('hidden');

            // Send to Webhook if configured and it is the final meeting summary
            if (isFinal && webhookUrl) {
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
        
        // Reset state only if recording has stopped (i.e. final minutes)
        if (!isRecording) {
            transcriptContent.innerHTML = "";
            aiAdviceContent.innerHTML = "";
            fullTranscript = "";
            lastAdviceIndex = 0;
            updateStatus('待機中', 'normal');
        }
    });

    copyMinutesBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(minutesOutput.textContent).then(() => {
            const originalText = copyMinutesBtn.innerText;
            copyMinutesBtn.innerText = "コピーしました！";
            setTimeout(() => { copyMinutesBtn.innerText = originalText; }, 2000);
        });
    });

});
