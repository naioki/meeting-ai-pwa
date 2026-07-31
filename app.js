/*
 * 議題タイマー式ファシリテーター。
 *
 * Microsoft Teams の Facilitator Agent を参考にした。あちらの中核である
 *   「招待から議題を取り出す / 議題ごとに時間配分とタイマーを出す /
 *     中間と終盤で促す / 1つの論点に時間をかけすぎたら指摘する」
 * は、そのほとんどが AI を必要としない。議題リストとタイマーだけで動く。
 *
 * この方式を採る理由:
 *   - 料金がかからない（API を一切呼ばない）
 *   - 話者分離が要らない（誰が話しているか知る必要がない）
 *   - 誤検知しない（時間は事実であり、推論ではない）
 *
 * 「1つの論点に時間をかけすぎ」は、話の逸脱の代理指標になる。
 * LLM に「今ズレていますか」と尋ねなくても、時間で測れる。
 *
 * Teams との違いは1点だけ。あちらは全員に見せるが、これは手元だけに出す。
 * AI に議事進行される感覚が反発を生むため、軌道修正は必ず本人が発話する。
 */
(() => {
    'use strict';

    const STORE = 'facilitator.v1';
    const DEFAULT_MINUTES = 10;
    const MIDPOINT = 0.5;
    const WRAPUP = 0.8;
    const OVERRUN_REPEAT_MS = 180000;   // 超過後の再通知間隔

    let meeting = null;
    let ticker = null;
    let heatOn = false;

    const $ = (id) => document.getElementById(id);
    const views = { setup: $('setup'), running: $('running'), done: $('done') };

    // ------------------------------------------------------------------
    // 議題の入力
    //
    // 会議は不定期で、開始前の手間は限りなく小さくないと使われない。
    // 1行1議題、末尾の数字があれば配分（分）として読む。
    // ------------------------------------------------------------------
    function parseAgenda(text) {
        return text.split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(line => {
                const m = line.match(/^(.*?)[\s　]+(\d+)$/);
                return m
                    ? { title: m[1].trim(), minutes: Math.max(1, parseInt(m[2], 10)) }
                    : { title: line, minutes: DEFAULT_MINUTES };
            });
    }

    function show(name) {
        Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });
    }

    function fmtClock(ms) {
        const neg = ms < 0;
        const s = Math.floor(Math.abs(ms) / 1000);
        return (neg ? '-' : '') +
            String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }

    // ------------------------------------------------------------------
    // 会議の進行
    // ------------------------------------------------------------------
    async function startMeeting() {
        const topics = parseAgenda($('agendaInput').value);
        if (!topics.length) {
            $('setupError').textContent = '議題を1行以上入力してください。';
            $('setupError').hidden = false;
            return;
        }

        meeting = {
            startedAt: Date.now(),
            endedAt: null,
            current: 0,
            topics: topics.map(t => Object.assign({
                startedAt: null, endedAt: null, outcome: null, nudged: {}
            }, t)),
            markers: [],
            notices: []
        };
        meeting.topics[0].startedAt = Date.now();

        // 音響の監視は任意。拒否されても議題タイマーは動く
        if ($('useHeat').checked) {
            try {
                await window.HeatMonitor.start({
                    onFrame: (pct) => { $('meterFill').style.width = pct.toFixed(0) + '%'; },
                    onState: (level, text, stats) => {
                        $('heatState').textContent = text;
                        $('heatState').className = 'heat-state ' + level;
                        $('heatStats').textContent = stats;
                    },
                    onAlert: (title, line) => notice('heat', title, line)
                });
                heatOn = true;
            } catch (e) {
                $('heatState').textContent = 'マイク不可（' + e.name + '）';
                $('heatStats').textContent = '議題タイマーは動きます';
            }
        }
        $('heatPanel').hidden = !heatOn;

        show('running');
        save();
        ticker = setInterval(tick, 1000);
        tick();
    }

    function currentTopic() {
        return meeting.topics[meeting.current] || null;
    }

    function tick() {
        const t = currentTopic();
        const now = Date.now();
        if (!t) return;

        const budget = t.minutes * 60000;
        const spent = now - t.startedAt;
        const left = budget - spent;
        const ratio = spent / budget;

        $('topicTitle').textContent = t.title;
        $('topicIndex').textContent = (meeting.current + 1) + ' / ' + meeting.topics.length;
        $('topicClock').textContent = fmtClock(left);
        $('topicClock').className = 'clock' + (left < 0 ? ' over' : (ratio >= WRAPUP ? ' warn' : ''));
        $('topicBar').style.width = Math.min(100, ratio * 100).toFixed(1) + '%';
        $('topicBar').className = 'bar-fill' + (left < 0 ? ' over' : (ratio >= WRAPUP ? ' warn' : ''));
        $('totalClock').textContent = '全体 ' + fmtClock(now - meeting.startedAt);

        // 時間による促し。推論ではないので誤検知しない
        if (!t.nudged.mid && ratio >= MIDPOINT && ratio < WRAPUP) {
            t.nudged.mid = true;
            notice('time', '半分経過', '「' + t.title + '」— ここまでで何が決まった？');
        } else if (!t.nudged.wrap && ratio >= WRAPUP && left > 0) {
            t.nudged.wrap = true;
            notice('time', '残り ' + Math.ceil(left / 60000) + '分',
                '結論を出すか、持ち越すかを決めよう');
        } else if (left <= 0) {
            const lastOver = t.nudged.overAt || 0;
            if (now - lastOver > OVERRUN_REPEAT_MS) {
                t.nudged.overAt = now;
                const overMin = Math.floor(-left / 60000);
                notice('time', '予定を' + (overMin > 0 ? overMin + '分' : '') + '超過',
                    overMin >= 5
                        ? 'この論点はいったん持ち越そう'
                        : '延長するか、次に移るかを決めよう');
            }
        }
    }

    // ------------------------------------------------------------------
    // 促しの表示
    //
    // 相手には見せない。読むのは自分だけで、口に出すのも自分。
    // 積み上げず、常に最新の1件だけを出す。
    // ------------------------------------------------------------------
    function notice(kind, title, line) {
        meeting.notices.push({ t: Date.now(), kind, title, line });
        $('noticeTitle').textContent = title;
        $('noticeLine').textContent = line;
        $('notice').className = 'notice ' + kind;
        $('notice').hidden = false;
        save();
    }

    $('dismissBtn').addEventListener('click', () => { $('notice').hidden = true; });

    // ------------------------------------------------------------------
    // 議題の決着
    // ------------------------------------------------------------------
    function closeTopic(outcome) {
        const t = currentTopic();
        if (!t) return;
        t.outcome = outcome;
        t.endedAt = Date.now();
        $('notice').hidden = true;

        if (meeting.current + 1 < meeting.topics.length) {
            meeting.current++;
            meeting.topics[meeting.current].startedAt = Date.now();
            save();
            tick();
        } else {
            endMeeting();
        }
    }

    $('agreedBtn').addEventListener('click', () => closeTopic('決まった'));
    $('deferBtn').addEventListener('click', () => closeTopic('持ち越し'));

    $('markBtn').addEventListener('click', () => {
        meeting.markers.push({ t: Date.now(), topic: meeting.current });
        save();
        const b = $('markBtn');
        b.textContent = '記録しました';
        setTimeout(() => { b.textContent = 'ここをマーク'; }, 1200);
    });

    $('endBtn').addEventListener('click', () => {
        if (confirm('会議を終了しますか？')) endMeeting();
    });

    function endMeeting() {
        clearInterval(ticker);
        if (heatOn) window.HeatMonitor.stop();
        meeting.endedAt = Date.now();
        const t = currentTopic();
        if (t && !t.endedAt) { t.endedAt = Date.now(); t.outcome = t.outcome || '未決'; }
        save();
        renderDone();
        show('done');
    }

    // ------------------------------------------------------------------
    // 事後
    //
    // 文字起こしと議事録は既存サービス(Granola / Notta / Otter 等)に任せる前提。
    // ここが出すのは「どの議題に何分かけ、何が決まらなかったか」と、
    // 壁時計の時刻つきの出来事だけ。向こうの文字起こしと突き合わせて使う。
    // ------------------------------------------------------------------
    function buildReport() {
        const heat = heatOn ? window.HeatMonitor.snapshot() : { events: [], turnCount: 0 };
        const lines = [];
        const d = new Date(meeting.startedAt);

        lines.push('会議記録  ' + d.toLocaleString('ja-JP'));
        lines.push('所要 ' + Math.round((meeting.endedAt - meeting.startedAt) / 60000) + '分');
        lines.push('');
        lines.push('## 議題');
        meeting.topics.forEach((t, i) => {
            const spent = t.endedAt && t.startedAt ? Math.round((t.endedAt - t.startedAt) / 60000) : 0;
            lines.push('- [' + (t.outcome || '未着手') + '] ' + t.title +
                '（予定' + t.minutes + '分 / 実績' + spent + '分）');
        });

        const deferred = meeting.topics.filter(t => t.outcome !== '決まった');
        lines.push('');
        lines.push('## 次回に持ち越し');
        if (deferred.length) deferred.forEach(t => lines.push('- ' + t.title));
        else lines.push('- なし');

        const rows = [
            ...meeting.notices.map(n => ({ t: n.t, s: '[' + n.kind + '] ' + n.title })),
            ...meeting.markers.map(m => ({ t: m.t, s: '[マーク] 手動' })),
            ...heat.events.map(e => ({
                t: e.t,
                s: '[温度:' + e.level + '] ' + e.kind +
                   '（応酬' + e.turnCount + '回 平常比' + e.rateRatio + '倍 ' + e.levelDelta + 'dB）'
            }))
        ].sort((a, b) => a.t - b.t);

        lines.push('');
        lines.push('## 出来事（文字起こしとの突き合わせ用）');
        rows.forEach(r => lines.push(
            fmtClock(r.t - meeting.startedAt) + '  ' +
            new Date(r.t).toLocaleTimeString('ja-JP') + '  ' + r.s
        ));

        // 会議中に出さなかったからといって、起きなかったことにはしない。
        // 画面に出す回数は絞る一方で、記録には必ず残す。
        const sup = heat.suppressed || [];
        if (sup.length) {
            lines.push('');
            lines.push('## 会議中は出さなかったもの（' + sup.length + '件）');
            sup.forEach(s => lines.push(
                fmtClock(s.t - meeting.startedAt) + '  ' + s.kind + '（' + s.levelDelta + 'dB）'
            ));
        }

        lines.push('');
        lines.push('--- 生データ ---');
        lines.push(JSON.stringify({ meeting, heat }));
        return lines.join('\n');
    }

    function renderDone() {
        const ul = $('doneTopics');
        ul.innerHTML = '';
        meeting.topics.forEach(t => {
            const spent = t.endedAt && t.startedAt ? Math.round((t.endedAt - t.startedAt) / 60000) : 0;
            const li = document.createElement('li');
            li.className = t.outcome === '決まった' ? 'ok' : 'pending';
            li.textContent = t.title + ' — ' + (t.outcome || '未着手') +
                '（' + spent + '分 / 予定' + t.minutes + '分）';
            ul.appendChild(li);
        });
    }

    $('exportBtn').addEventListener('click', () => {
        const d = new Date(meeting.startedAt);
        const p = (n) => String(n).padStart(2, '0');
        // 日本語ファイル名は環境により download 属性ごと無視されるため ASCII
        const name = 'meeting-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
            '-' + p(d.getHours()) + p(d.getMinutes()) + '.md';
        const blob = new Blob([buildReport()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    });

    $('copyBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(buildReport()).then(() => {
            $('copyBtn').textContent = 'コピーしました';
            setTimeout(() => { $('copyBtn').textContent = 'コピー'; }, 2000);
        });
    });

    $('newBtn').addEventListener('click', () => {
        localStorage.removeItem(STORE);
        location.reload();
    });

    // ------------------------------------------------------------------
    // 保存と復元（落ちても失わない）
    // ------------------------------------------------------------------
    function save() {
        try { localStorage.setItem(STORE, JSON.stringify(meeting)); } catch (e) { /* 満杯 */ }
    }

    function restore() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return; }
        if (!saved || !saved.topics || !saved.topics.length) return;

        const when = new Date(saved.startedAt).toLocaleString('ja-JP',
            { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        $('restoreLabel').textContent = when + ' の会議が途中のままです';
        $('restoreBanner').hidden = false;

        $('restoreBtn').addEventListener('click', () => {
            meeting = saved;
            if (saved.endedAt) {
                renderDone();
                show('done');
            } else {
                $('heatPanel').hidden = true;   // 音響は復元できない（マイクが切れている）
                show('running');
                ticker = setInterval(tick, 1000);
                tick();
            }
        });
        $('discardBtn').addEventListener('click', () => {
            localStorage.removeItem(STORE);
            $('restoreBanner').hidden = true;
        });
    }

    $('startBtn').addEventListener('click', startMeeting);

    window.addEventListener('beforeunload', (e) => {
        if (meeting && !meeting.endedAt) { save(); e.preventDefault(); e.returnValue = ''; }
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    restore();
})();
