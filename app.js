document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & Defaults ---
    const DEFAULT_REALTIME_PROMPT = `あなたは会議の観察者です。直近の会話を読み、次のどちらかだけを返してください。

1) 議論が感情的になりかけている、または同じ主張が繰り返されて前に進んでいない場合
   → その状況を30字以内で1行だけ指摘する
2) それ以外の場合
   → 「―」の1文字だけを返す

説明・前置き・提案・要約は不要です。必ず1行のみ。`;

    const DEFAULT_MINUTES_PROMPT = "以下の会議ログを、決まったこと / 決まらなかったこと / 次のアクション（担当と期限） の3見出しでMarkdownにまとめてください。憶測で補わず、ログにない内容は書かないでください。前置きは不要です。";

    const ADVICE_THRESHOLD_CHARS = 200;   // これだけ新規文字が溜まったら判定を検討する
    const ADVICE_COOLDOWN_MS = 45000;     // 429対策: API呼び出しの下限間隔
    const MAX_CONTEXT_CHARS = 3000;       // 毎回全文を送らない（会議が長引くほど膨らむのを防ぐ）
    const STORAGE_KEY = 'meetingSession.v1';
    const SAVE_DEBOUNCE_MS = 800;
    const WATCHDOG_INTERVAL_MS = 3000;    // 認識エンジンの死活監視

    // --- State ---
    let isRecording = false;      // ユーザーの意図（記録したいか）
    let engineRunning = false;    // 実際の認識エンジンの状態
    let recognition = null;
    let fullTranscript = "";
    let segments = [];            // { t: epochMs, text }
    let markers = [];             // { t: epochMs, kind }
    let sessionStartedAt = null;
    let lastAdviceIndex = 0;
    let lastAdviceAt = 0;
    let isFetchingAdvice = false;
    let restartTimeout = null;
    let restartAttempts = 0;
    let watchdogTimer = null;
    let saveTimer = null;
    let finalEl = null;
    let interimEl = null;

    // --- DOM Elements ---
    const startBtn = document.getElementById('startBtn');
    const endBtn = document.getElementById('endBtn');
    const midwaySummaryBtn = document.getElementById('midwaySummaryBtn');
    const markBtn = document.getElementById('markBtn');
    const recordingStatusIndicator = document.getElementById('recordingStatusIndicator');
    const savedIndicator = document.getElementById('savedIndicator');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingsForm = document.getElementById('settingsForm');

    const restoreBanner = document.getElementById('restoreBanner');
    const restoreLabel = document.getElementById('restoreLabel');
    const restoreBtn = document.getElementById('restoreBtn');
    const discardBtn = document.getElementById('discardBtn');

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
    const downloadMinutesBtn = document.getElementById('downloadMinutesBtn');
    const downloadTranscriptBtn = document.getElementById('downloadTranscriptBtn');

    // --- Initialization ---
    initSettings();
    initTranscriptView();
    initSpeechRecognition();
    initPWA();
    offerRestore();

    // ------------------------------------------------------------------
    // Status / UI
    // ------------------------------------------------------------------
    function setStatus(text, type = 'idle') {
        if (!recordingStatusIndicator) return;
        recordingStatusIndicator.className =
            'ml-3 text-xs font-bold px-3 py-1 rounded-full transition-colors';
        const styles = {
            idle: 'bg-gray-200 text-gray-600',
            recording: 'bg-red-100 text-red-700',
            warn: 'bg-yellow-100 text-yellow-700',
            error: 'bg-red-600 text-white'
        };
        recordingStatusIndicator.classList.add(...styles[type].split(' '));
        recordingStatusIndicator.textContent = text;
        if (type === 'idle' && (text === '待機中' || text === '')) {
            recordingStatusIndicator.classList.add('hidden');
        }
    }

    function setSaved(text) {
        if (!savedIndicator) return;
        savedIndicator.textContent = text;
        savedIndicator.classList.toggle('hidden', !text);
    }

    // ------------------------------------------------------------------
    // Persistence（落ちても失わない）
    // ------------------------------------------------------------------
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveSession, SAVE_DEBOUNCE_MS);
    }

    function saveSession() {
        clearTimeout(saveTimer);
        if (!segments.length && !markers.length) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                startedAt: sessionStartedAt,
                updatedAt: Date.now(),
                segments,
                markers
            }));
            setSaved('自動保存 ' + new Date().toLocaleTimeString('ja-JP', {
                hour: '2-digit', minute: '2-digit'
            }));
        } catch (e) {
            // 容量超過など。記録は続行させ、書き出しを促す
            console.error('Save failed:', e);
            setSaved('⚠️ 自動保存できません');
        }
    }

    function loadSession() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || !Array.isArray(data.segments) || !data.segments.length) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    function clearSession() {
        clearTimeout(saveTimer);
        localStorage.removeItem(STORAGE_KEY);
        setSaved('');
    }

    function offerRestore() {
        const data = loadSession();
        if (!data || !restoreBanner) return;
        const when = new Date(data.updatedAt).toLocaleString('ja-JP', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        const chars = data.segments.reduce((n, s) => n + s.text.length, 0);
        restoreLabel.textContent = `${when} の記録が残っています（約${chars}文字）`;
        restoreBanner.classList.remove('hidden');

        restoreBtn.addEventListener('click', () => {
            segments = data.segments;
            markers = Array.isArray(data.markers) ? data.markers : [];
            sessionStartedAt = data.startedAt || (segments[0] && segments[0].t) || Date.now();
            fullTranscript = segments.map(s => s.text).join(' ') + ' ';
            lastAdviceIndex = fullTranscript.length;
            renderTranscriptFromScratch();
            restoreBanner.classList.add('hidden');
            midwaySummaryBtn.classList.remove('hidden');
            downloadTranscriptBtn.disabled = false;
            setSaved('復元しました');
        });

        discardBtn.addEventListener('click', () => {
            clearSession();
            restoreBanner.classList.add('hidden');
        });
    }

    // ------------------------------------------------------------------
    // Transcript view（毎回作り直さない・勝手にスクロールしない）
    // ------------------------------------------------------------------
    function initTranscriptView() {
        transcriptContent.textContent = '';
        finalEl = document.createElement('span');
        finalEl.className = 'font-medium text-gray-700';
        interimEl = document.createElement('span');
        interimEl.className = 'text-gray-400';
        transcriptContent.appendChild(finalEl);
        transcriptContent.appendChild(interimEl);
    }

    function renderTranscriptFromScratch() {
        initTranscriptView();
        finalEl.textContent = segments.map(s => s.text).join(' ') + ' ';
        scrollTranscriptIfAtBottom(true);
    }

    function appendFinal(text) {
        // textNode追加なのでO(1)。innerHTMLの全再構築をやめる（重くなる原因）
        finalEl.appendChild(document.createTextNode(text + ' '));
    }

    function scrollTranscriptIfAtBottom(force) {
        const box = transcriptContent.parentElement;
        if (!box) return;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        if (force || atBottom) box.scrollTop = box.scrollHeight;
    }

    // ------------------------------------------------------------------
    // Speech recognition（止まったら必ず戻る）
    // ------------------------------------------------------------------
    function initSpeechRecognition() {
        window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!window.SpeechRecognition) {
            setStatus('音声認識に非対応', 'error');
            addAdvice('このブラウザは音声認識に対応していません。PCのChromeまたはEdgeで開いてください。', 'system');
            startBtn.disabled = true;
            startBtn.classList.add('opacity-50', 'cursor-not-allowed');
            return;
        }

        recognition = new window.SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'ja-JP';

        recognition.onstart = () => {
            engineRunning = true;
            restartAttempts = 0;
            setStatus('🔴 記録中', 'recording');
        };

        recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const text = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    const clean = text.trim();
                    if (!clean) continue;
                    segments.push({ t: Date.now(), text: clean });
                    fullTranscript += clean + ' ';
                    appendFinal(clean);
                    scheduleSave();
                    maybeFetchAdvice();
                } else {
                    interim += text;
                }
            }
            interimEl.textContent = interim;
            scrollTranscriptIfAtBottom(false);
        };

        recognition.onerror = (event) => {
            switch (event.error) {
                case 'no-speech':
                case 'aborted':
                    // 沈黙や stop() による正常終了。UIは触らない（チカチカの原因だった）
                    break;
                case 'not-allowed':
                case 'service-not-allowed':
                    isRecording = false;
                    setStatus('マイク不可', 'error');
                    addAdvice('マイクへのアクセスが許可されていません。ブラウザのアドレスバー左のアイコンからマイクを許可し、再読み込みしてください。', 'system');
                    stopRecording();
                    break;
                case 'audio-capture':
                    isRecording = false;
                    setStatus('マイクなし', 'error');
                    addAdvice('マイクが見つかりません。接続と入力デバイスの設定を確認してください。', 'system');
                    stopRecording();
                    break;
                default:
                    console.warn('Speech recognition error:', event.error);
            }
        };

        recognition.onend = () => {
            engineRunning = false;
            if (isRecording) {
                // 沈黙のたびに終了するのは正常。即座に戻す（発話の頭切れを防ぐ）
                scheduleRestart(0);
            } else {
                setStatus('待機中', 'idle');
            }
        };
    }

    function scheduleRestart(delay) {
        clearTimeout(restartTimeout);
        restartTimeout = setTimeout(() => {
            if (!isRecording || engineRunning) return;
            try {
                recognition.start();
            } catch (e) {
                // InvalidStateError 等。握り潰すと二度と復帰しなかったので必ず再試行する
                restartAttempts++;
                if (restartAttempts >= 2) setStatus('再接続中…', 'warn');
                scheduleRestart(Math.min(500 * restartAttempts, 4000));
            }
        }, delay);
    }

    function startWatchdog() {
        clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
            // onend が来ない / start が黙って失敗した場合の最後の砦
            if (isRecording && !engineRunning) scheduleRestart(0);
        }, WATCHDOG_INTERVAL_MS);
    }

    function stopRecording() {
        isRecording = false;
        clearInterval(watchdogTimer);
        clearTimeout(restartTimeout);
        if (recognition) {
            try { recognition.stop(); } catch (e) { /* 未起動なら無視 */ }
        }
        endBtn.classList.add('hidden');
        midwaySummaryBtn.classList.remove('hidden');
        markBtn.classList.add('hidden');
        startBtn.classList.remove('hidden');
        setStatus('待機中', 'idle');
        saveSession();
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------
    startBtn.addEventListener('click', () => {
        if (!localStorage.getItem('geminiApiKey')) {
            settingsModal.classList.remove('hidden');
            return;
        }
        if (segments.length && !confirm('現在の記録を破棄して新しい会議を始めますか？')) return;

        clearSession();
        fullTranscript = "";
        segments = [];
        markers = [];
        sessionStartedAt = Date.now();
        lastAdviceIndex = 0;
        lastAdviceAt = 0;
        aiAdviceContent.innerHTML = "";
        initTranscriptView();
        if (restoreBanner) restoreBanner.classList.add('hidden');
        downloadTranscriptBtn.disabled = false;

        isRecording = true;
        startBtn.classList.add('hidden');
        endBtn.classList.remove('hidden');
        midwaySummaryBtn.classList.remove('hidden');
        markBtn.classList.remove('hidden');

        setStatus('起動中…', 'warn');
        startWatchdog();
        scheduleRestart(0);
    });

    markBtn.addEventListener('click', () => {
        markers.push({ t: Date.now(), kind: 'mark' });
        saveSession();
        const label = markBtn.querySelector('span');
        if (label) {
            const original = label.textContent;
            label.textContent = '記録しました';
            setTimeout(() => { label.textContent = original; }, 1200);
        }
    });

    midwaySummaryBtn.addEventListener('click', () => {
        if (!fullTranscript.trim()) return alert('文字起こしがまだありません。');
        generateSummary(false);
    });

    endBtn.addEventListener('click', () => {
        stopRecording();
        if (fullTranscript.trim()) generateSummary(true);
    });

    // ------------------------------------------------------------------
    // AI advice（積み上げない・全文を送らない・連射しない）
    // ------------------------------------------------------------------
    function addAdvice(text, type = 'ai') {
        // 直前までの表示を小さくして、最新の1件だけを大きく残す
        Array.from(aiAdviceContent.children).forEach((el) => {
            el.classList.remove('text-2xl');
            el.classList.add('text-sm', 'opacity-50');
        });

        const div = document.createElement('div');
        div.className = 'p-4 rounded-xl advice-item text-2xl ' + (type === 'system'
            ? 'bg-gray-100 text-gray-600'
            : 'bg-blue-50 border border-blue-200 text-blue-900 shadow-sm');
        div.textContent = text;
        aiAdviceContent.prepend(div);

        while (aiAdviceContent.children.length > 8) {
            aiAdviceContent.lastChild.remove();
        }
        return div;
    }

    function maybeFetchAdvice() {
        if (isFetchingAdvice) return;
        if (Date.now() - lastAdviceAt < ADVICE_COOLDOWN_MS) return;
        if (fullTranscript.length - lastAdviceIndex < ADVICE_THRESHOLD_CHARS) return;

        lastAdviceIndex = fullTranscript.length;
        lastAdviceAt = Date.now();
        isFetchingAdvice = true;
        // 直近のみ送る。全文を毎回送ると会議が長引くほど膨らみ429を招いていた
        const context = fullTranscript.slice(-MAX_CONTEXT_CHARS);
        callGeminiForAdvice(context).finally(() => { isFetchingAdvice = false; });
    }

    async function callGeminiForAdvice(transcript) {
        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        try {
            const res = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + encodeURIComponent(apiKey),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt + '\n\n【直近の会話】\n' + transcript }] }],
                        generationConfig: { temperature: 0.4, maxOutputTokens: 120 }
                    })
                }
            );
            if (!res.ok) {
                if (res.status === 429) return; // クォータ。次の周期まで黙って待つ
                throw new Error('API ' + res.status);
            }
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            // 「―」= 指摘なし。会議中の画面は静かなままにする
            if (!text || text === '―' || text === '-' || text === 'ー') return;
            addAdvice(text);
        } catch (e) {
            console.error('Advice error:', e);
        }
    }

    // ------------------------------------------------------------------
    // Summary / export
    // ------------------------------------------------------------------
    function pad2(n) { return String(n).padStart(2, '0'); }

    function fmtElapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
    }

    function buildTranscriptText() {
        const all = [
            ...segments.map(s => ({ t: s.t, line: s.text })),
            ...markers.map(m => ({ t: m.t, line: '>>> マーカー' }))
        ].sort((a, b) => a.t - b.t);
        if (!all.length) return '';
        const t0 = sessionStartedAt || all[0].t;
        const header = '会議記録 ' + new Date(t0).toLocaleString('ja-JP') + '\n\n';
        return header + all.map(r => '[' + fmtElapsed(r.t - t0) + '] ' + r.line).join('\n') + '\n';
    }

    function downloadFile(filename, text) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        // 即 remove するとダウンロードが始まる前に download 属性を失い、
        // 「download」という拡張子なしのファイルになる。破棄は遅らせる。
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
        }, 2000);
    }

    function stamp() {
        const d = new Date(sessionStartedAt || Date.now());
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    }

    async function generateSummary(isFinal) {
        const loadingText = loadingOverlay.querySelector('p');
        if (loadingText) loadingText.textContent = isFinal ? '議事録を生成しています…' : '途中要約を生成しています…';
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('flex');

        const apiKey = localStorage.getItem('geminiApiKey');
        const prompt = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;
        const webhookUrl = localStorage.getItem('webhookUrl');

        try {
            const res = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + encodeURIComponent(apiKey),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt + '\n\n【会議ログ】\n' + buildTranscriptText() }] }],
                        generationConfig: { temperature: 0.2 }
                    })
                }
            );
            if (!res.ok) throw new Error('API ' + res.status);
            const data = await res.json();
            const markdown = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!markdown) throw new Error('空の応答');

            minutesModalTitle.textContent = isFinal ? '生成された議事録' : '途中要約';
            minutesOutput.textContent = markdown;
            minutesModal.classList.remove('hidden');
            downloadMinutesBtn.disabled = false;

            if (isFinal && webhookUrl) {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: markdown })
                }).catch(err => console.error('Webhook POST error', err));
            }
        } catch (e) {
            console.error(e);
            // 生成に失敗しても記録は残っている。書き出し導線を必ず案内する
            alert('議事録の生成に失敗しました（' + e.message + '）。\n文字起こしは保存されています。「文字起こしを保存」から書き出せます。');
        } finally {
            loadingOverlay.classList.add('hidden');
            loadingOverlay.classList.remove('flex');
        }
    }

    // ------------------------------------------------------------------
    // Modals / settings
    // ------------------------------------------------------------------
    function initSettings() {
        apiKeyInput.value = localStorage.getItem('geminiApiKey') || '';
        webhookUrlInput.value = localStorage.getItem('webhookUrl') || '';
        realtimePromptInput.value = localStorage.getItem('realtimePrompt') || DEFAULT_REALTIME_PROMPT;
        minutesPromptInput.value = localStorage.getItem('minutesPrompt') || DEFAULT_MINUTES_PROMPT;
        if (!apiKeyInput.value) settingsModal.classList.remove('hidden');
    }

    settingsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        localStorage.setItem('geminiApiKey', apiKeyInput.value.trim());
        localStorage.setItem('webhookUrl', webhookUrlInput.value.trim());
        localStorage.setItem('realtimePrompt', realtimePromptInput.value.trim());
        localStorage.setItem('minutesPrompt', minutesPromptInput.value.trim());
        settingsModal.classList.add('hidden');
    });

    settingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

    closeMinutesBtn.addEventListener('click', () => {
        // 記録は消さない。消えるのは「新しい会議を始める」時だけ
        minutesModal.classList.add('hidden');
    });

    copyMinutesBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(minutesOutput.textContent).then(() => {
            const original = copyMinutesBtn.textContent;
            copyMinutesBtn.textContent = 'コピーしました';
            setTimeout(() => { copyMinutesBtn.textContent = original; }, 2000);
        });
    });

    downloadMinutesBtn.addEventListener('click', () => {
        // 日本語ファイル名は環境により download 属性ごと無視され、拡張子なしの
        // 「download」になる。ASCII に固定する。
        downloadFile('minutes-' + stamp() + '.md', minutesOutput.textContent);
    });

    downloadTranscriptBtn.addEventListener('click', () => {
        const text = buildTranscriptText();
        if (!text) return alert('文字起こしがまだありません。');
        downloadFile('transcript-' + stamp() + '.txt', text);
    });

    // 記録中の離脱で消えないよう、離れる直前に必ず書き込む
    window.addEventListener('beforeunload', (e) => {
        saveSession();
        if (isRecording) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    function initPWA() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(err => console.error('SW error', err));
        }
    }
});
