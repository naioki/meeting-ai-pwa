/*
 * 音響だけで会議の「温度」を見る計測器。
 *
 * 通信しない / APIキーを持たない / 話者分離をしない。
 * マイクの音量と発話の間隔だけを見るので、料金はかからない。
 *
 * なぜ即時でなければならないか:
 *   Gottman の研究では、修復の試み(repair attempt)は否定的感情が拡大する前に
 *   入れる必要があり、拒絶された修復は修復しないより damage が大きい。
 *   数十秒遅れて出す指摘は、拒絶されて逆効果になる。だから LLM を待たない。
 *
 * 何を測るか（話者分離はしない = できない）:
 *   - 発話の密度: 発話が時間を占める割合（口論では被せ気味になり上がる）
 *   - 声量の上昇: その会議自身の平常値からどれだけ上がったか
 *   - 長い沈黙:   高温のあとの沈黙は「逃避」の兆候
 */
window.HeatMonitor = (() => {
    'use strict';

    const FRAME_MS = 50;
    const SPEECH_ON_DB = 12;          // ノイズフロア + これで発話とみなす
    const SPEECH_OFF_DB = 8;          // ヒステリシス
    // 400ms では一人の発話中の句の切れ目まで拾う。話者交代に近づけるため長く取る
    const TURN_GAP_MS = 700;   // 記録用。判定には使わない（下の metrics 参照）
    const WINDOW_MS = 90000;
    const RECENT_MS = 30000;
    const BASELINE_MIN_SAMPLES = 200;
    const WARMUP_MS = 60000;          // 平常値が取れるまでは判定しない
    const LONG_SILENCE_MS = 12000;

    /*
     * しきい値は絶対値では決められない。声量も話す速さも人と会議で違い、
     * 手元に実データが一度もないため根拠のある絶対値が存在しない。
     * そこで「その会議自身の平常値から、どれだけ上がったか」だけで判定する。
     */
    const WARM_DENSITY_RATIO = 1.25;
    const HOT_DENSITY_RATIO = 1.5;
    const WARM_LEVEL_DELTA = 3.0;     // dB
    const HOT_LEVEL_DELTA = 5.5;

    // 発話密度の履歴は 0.5 秒ごとに1つ。90秒ぶん揃うまで平常値と見なさない
    const DENSITY_SLOT_MS = 500;
    const DENSITY_WINDOW = WINDOW_MS / DENSITY_SLOT_MS;

    // 続けて出すと「小言」になり、拒絶されて逆効果になる
    const ALERT_COOLDOWN_MS = 180000;

    /*
     * 表示する言葉は生成しない。Gottman の修復カテゴリ
     * (止める / 聞く / 引き受ける / 送る) に沿った固定文から選ぶだけ。
     */
    const REPAIRS = {
        pace: {
            title: '応酬が詰まってきた',
            lines: ['今の、もう一度言ってもらえる？', 'ちょっと待って、そこ確認させて']
        },
        volume: {
            title: '声が大きくなってきた',
            lines: ['言い方がきつくなった、ごめん', '一回落ち着こう。お茶にしない？']
        },
        hot: {
            title: '止めどきかもしれない',
            lines: ['今日はここまでにして、次回に回そう', '一回止めよう。続きは日を改めて']
        },
        silence: {
            title: '沈黙が長い',
            lines: ['その心配、もう少し詳しく聞かせて', '今どう思ってる？']
        }
    };

    let stream = null, audioCtx = null, analyser = null, buf = null, timer = null;
    let running = false, startedAt = 0;
    let samples = [], turns = [], events = [], suppressed = [], speechLevels = [], densityHistory = [], windowHistory = [];
    let frameSpeech = 0, frameTotal = 0;
    let inSpeech = false, speechStart = 0, lastAboveAt = 0, lastSpeechEndAt = 0;
    let currentPeak = -Infinity, lastAlertAt = 0, lastAlertKind = null;
    let cachedFloor = -70, cachedBaseline = null, heavyCounter = 0;
    let cb = {};

    const percentile = (arr, p) => {
        if (!arr.length) return null;
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };

    // パーセンタイルはソートを伴うので毎フレームは回さない。
    // ノイズフロアも平常値もゆっくりしか動かないため 0.5 秒ごとで足りる。
    function recomputeSlow() {
        cachedFloor = samples.length > 40 ? percentile(samples.map(s => s.db), 0.1) : -70;
        cachedBaseline = speechLevels.length > BASELINE_MIN_SAMPLES
            ? percentile(speechLevels, 0.5) : null;
    }

    function tick() {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-8));
        const now = Date.now();

        const onTh = cachedFloor + SPEECH_ON_DB;
        const offTh = cachedFloor + SPEECH_OFF_DB;

        if (!inSpeech && db > onTh) {
            inSpeech = true;
            speechStart = now;
            lastAboveAt = now;
            currentPeak = db;
        } else if (inSpeech) {
            if (db > currentPeak) currentPeak = db;
            if (db > offTh) {
                lastAboveAt = now;
            } else if (now - lastAboveAt > TURN_GAP_MS) {
                inSpeech = false;
                turns.push({ start: speechStart, end: lastAboveAt, peakDb: currentPeak });
                lastSpeechEndAt = lastAboveAt;
                if (turns.length > 600) turns.shift();
            }
        }

        frameTotal++;
        if (inSpeech) { frameSpeech++; speechLevels.push(db); }
        if (speechLevels.length > 4000) speechLevels.shift();

        // 保持は直近60秒だけ。書き出しに使うのは turns / events なので全履歴は要らない
        samples.push({ t: now, db, speech: inSpeech });
        while (samples.length && now - samples[0].t > 60000) samples.shift();

        if (cb.onFrame) {
            cb.onFrame(Math.max(0, Math.min(100, ((db - cachedFloor) / 40) * 100)));
        }

        if (++heavyCounter >= 10) {
            heavyCounter = 0;
            recomputeSlow();
            evaluate(now);
        }
    }

    function metrics(now) {
        /*
         * 「応酬の密度」をターン数で数えるのは誤りだった。
         * 激しい応酬では発話の間が短くなり、TURN_GAP_MS を下回った時点で
         * 隣り合う発話が1つに融合するため、ターン数はかえって減る。
         * 実測で 10回 → 8回 と逆方向に動いた。
         *
         * 代わりに「発話が時間を占める割合」を見る。被せ気味の応酬でも
         * 一方的な長広舌でも増え、沈黙で減る。融合の影響を受けない。
         */
        const slotRatio = frameTotal > 0 ? frameSpeech / frameTotal : 0;
        frameSpeech = frameTotal = 0;
        densityHistory.push(slotRatio);
        if (densityHistory.length > 7200) densityHistory.shift();   // 60分ぶん

        const win = densityHistory.slice(-DENSITY_WINDOW);
        const recentDensity = win.reduce((a, b) => a + b, 0) / (win.length || 1);

        /*
         * 平常値は「窓平均の中央値」で取る。
         * 0.5秒スロットの生値は 0 か 1 に偏る（発話中の秒は丸ごと1、間は丸ごと0）ため、
         * 生値の中央値は 1.0 に張り付き、比が実測で 0.73 倍と逆を向いた。
         * 比べる対象を窓平均どうしに揃える。
         */
        if (densityHistory.length >= DENSITY_WINDOW) {
            windowHistory.push(recentDensity);
            if (windowHistory.length > 7200) windowHistory.shift();
        }
        const baseDensity = windowHistory.length >= 120 ? percentile(windowHistory, 0.5) : null;
        const densityRatio = (baseDensity && baseDensity > 0.05)
            ? recentDensity / baseDensity : 1;

        const recent = [];
        for (let i = samples.length - 1; i >= 0 && now - samples[i].t < RECENT_MS; i--) {
            if (samples[i].speech) recent.push(samples[i].db);
        }
        const recentLevel = recent.length > 20 ? percentile(recent, 0.5) : null;
        const levelDelta = (recentLevel != null && cachedBaseline != null)
            ? recentLevel - cachedBaseline : 0;

        return {
            density: recentDensity,
            densityRatio,
            levelDelta,
            silence: inSpeech ? 0 : (lastSpeechEndAt ? now - lastSpeechEndAt : 0),
            // 声量と発話密度は必要な助走期間が違うので、別々に判定可否を持つ
            levelReady: cachedBaseline != null && now - startedAt > WARMUP_MS,
            densityReady: baseDensity != null
        };
    }

    function evaluate(now) {
        const m = metrics(now);
        const stats = '発話密度 ' + (m.density * 100).toFixed(0) + '%（平常比 ' +
            m.densityRatio.toFixed(2) + '倍）　声量 ' +
            (m.levelDelta >= 0 ? '+' : '') + m.levelDelta.toFixed(1) + 'dB';

        // 平常値が固まるまで判定しない。根拠のない警告を出すと信用を失い、
        // 以後の指摘ごと無視されるようになる（アラート疲れ）
        if (!m.levelReady && !m.densityReady) {
            if (cb.onState) cb.onState('calm', '平常値を測定中', stats);
            return;
        }

        const denHot = m.densityReady && m.densityRatio >= HOT_DENSITY_RATIO;
        const denWarm = m.densityReady && m.densityRatio >= WARM_DENSITY_RATIO;
        const lvHot = m.levelReady && m.levelDelta >= HOT_LEVEL_DELTA;
        const lvWarm = m.levelReady && m.levelDelta >= WARM_LEVEL_DELTA;

        let kind = null, level = 'calm';
        if (denHot && lvHot) { kind = 'hot'; level = 'hot'; }
        else if (lvHot) { kind = 'volume'; level = 'hot'; }
        else if (denWarm && lvWarm) { kind = 'pace'; level = 'warm'; }
        else if (lvWarm) { kind = 'volume'; level = 'warm'; }
        else if (denWarm) { kind = 'pace'; level = 'warm'; }
        else if (m.silence > LONG_SILENCE_MS && lastAlertKind && now - lastAlertAt < 300000) {
            // 温度が上がった後の長い沈黙だけを拾う（ただの熟考は拾わない）
            kind = 'silence'; level = 'warm';
        }

        if (cb.onState) {
            cb.onState(level,
                level === 'calm' ? '穏やか' : (level === 'warm' ? '温度が上がってきた' : '高い'),
                stats);
        }

        if (!kind) return;

        // 抑制したものも必ず残す。
        // 会議中に出さなかったからといって、起きなかったことにはしない。
        if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
            suppressed.push({ t: now, kind, level, levelDelta: +m.levelDelta.toFixed(1) });
            return;
        }

        lastAlertAt = now;
        lastAlertKind = kind;
        const r = REPAIRS[kind];
        events.push({
            t: now, kind, level,
            density: +m.density.toFixed(2),
            densityRatio: +m.densityRatio.toFixed(2),
            levelDelta: +m.levelDelta.toFixed(1)
        });
        if (cb.onAlert) {
            cb.onAlert(r.title, r.lines[Math.floor(Math.random() * r.lines.length)]);
        }
    }

    async function start(callbacks) {
        cb = callbacks || {};
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                // 自動ゲイン調整が入ると音量が平坦化され、声量の変化を測れなくなる
                autoGainControl: false,
                noiseSuppression: false,
                echoCancellation: false
            }
        });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        buf = new Float32Array(analyser.fftSize);
        audioCtx.createMediaStreamSource(stream).connect(analyser);

        startedAt = Date.now();
        samples = []; turns = []; events = []; suppressed = []; speechLevels = []; densityHistory = []; windowHistory = [];
        frameSpeech = 0; frameTotal = 0;
        inSpeech = false; lastSpeechEndAt = 0; lastAlertAt = 0; lastAlertKind = null;
        cachedFloor = -70; cachedBaseline = null; heavyCounter = 0;

        running = true;
        timer = setInterval(tick, FRAME_MS);
    }

    function stop() {
        running = false;
        clearInterval(timer);
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (audioCtx) audioCtx.close().catch(() => {});
        stream = null; audioCtx = null;
    }

    return {
        start,
        stop,
        isRunning: () => running,
        snapshot: () => ({
            startedAt,
            events: events.slice(),
            suppressed: suppressed.slice(),
            turnCount: turns.length,
            turns: turns.map(t => ({ start: t.start, end: t.end, peakDb: +t.peakDb.toFixed(1) }))
        })
    };
})();
