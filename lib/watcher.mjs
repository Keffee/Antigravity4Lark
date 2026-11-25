const DECISION_PROMPT_PATTERNS = [
  /请确认|需要你确认|需要您确认|需要你决策|需要您决策|请拍板|请决定|请指示|请选择/,
  /请告诉我.{0,24}(?:方案|选择|是否|哪|怎么|要不要)/,
  /请回复.{0,24}(?:方案|确认|选择|继续|允许)/,
  /方案\s*[A1](?:\b|[\s（(：:])[\s\S]{0,500}方案\s*[B2](?:\b|[\s（(：:])/i,
  /option\s*[A1](?:\b|[\s(:])[\s\S]{0,500}option\s*[B2](?:\b|[\s(:])/i,
  /是否(?:继续|执行|切换|采用|确认|同意|批准|允许|需要我|改为|保留)/,
  /\b(?:please confirm|which option|would you like me to|do you want me to|awaiting your (?:decision|confirmation|approval))\b/i,
];

export function needsUserDecision(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return DECISION_PROMPT_PATTERNS.some(re => re.test(s));
}

export function formatAskQuestionText(pendingToolCall) {
  const qs = Array.isArray(pendingToolCall?.questions) ? pendingToolCall.questions : [];
  if (qs.length === 0) {
    return `智能体正在向你提问（\`${pendingToolCall?.name || 'ask_question'}\`）`;
  }
  const blocks = qs.map((q, idx) => {
    const title = qs.length > 1 ? `**问题 ${idx + 1}**${q.isMultiSelect ? '（可多选）' : ''}：${q.question}` : `**提问**${q.isMultiSelect ? '（可多选）' : ''}：${q.question}`;
    const opts = (q.options || []).map((opt, i) => `${i + 1}. ${opt}`);
    return opts.length > 0 ? `${title}\n${opts.join('\n')}` : title;
  });
  return `智能体正在向你提问：\n\n${blocks.join('\n\n')}`;
}

export class AntigravityWatcher {
  constructor({ client, cdp = null, state, config = {}, onEvent, logger = console }) {
    this.client = client;
    this.cdp = cdp;
    this.state = state;
    this.config = config;
    this.onEvent = onEvent;
    this.logger = logger;

    this.pollIntervalMs = Number(config.pollIntervalMs || 2000);
    this.waitingThresholdMs =
      config.waitingThresholdMs !== undefined ? Number(config.waitingThresholdMs) : 15000;

    this._timer = null;
    this._polling = false;
    this._initialized = false;
    this._pendingSince = new Map();
    this._waitingNotified = new Set();
  }

  start() {
    if (this._timer) return;
    void this.pollOnce();
    this._timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _getPushMode() {
    if (typeof this.state?.getPushMode === 'function') {
      return this.state.getPushMode() || 'bound';
    }
    return this.config.pushMode || 'bound';
  }

  _isWatched(conversationId) {
    const mode = this._getPushMode();
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    const defaultId =
      typeof this.state?.getDefaultConversationId === 'function'
        ? this.state.getDefaultConversationId()
        : this.config.defaultConversationId;
    if (defaultId && conversationId === defaultId) return true;
    if (typeof this.state?.isBound === 'function' && this.state.isBound(conversationId)) return true;
    return false;
  }

  _hasPushed(conversationId, stepIndex) {
    return typeof this.state?.hasPushedStep === 'function'
      ? this.state.hasPushedStep(conversationId, stepIndex)
      : false;
  }

  _markPushed(conversationId, stepIndex) {
    if (typeof this.state?.markPushedStep === 'function') {
      this.state.markPushedStep(conversationId, stepIndex);
      return true;
    }
    return false;
  }

  _clearPending(conversationId) {
    for (const key of this._pendingSince.keys()) {
      if (key.startsWith(`${conversationId}:`)) this._pendingSince.delete(key);
    }
  }

  async pollOnce() {
    if (this._polling) return;
    this._polling = true;
    let stateDirty = false;

    try {
      const conversations = this.client.listConversations({ includeSubagents: false, limit: 30 }) || [];
      const now = Date.now();

      if (!this._initialized) {
        for (const conv of conversations) {
          if (typeof this.state?.assignSeq === 'function') {
            this.state.assignSeq(conv.id);
            stateDirty = true;
          }
          const tr = this.client.readTranscript(conv.id, { maxTurns: 2 });
          if (tr?.exists) {
            if (tr.lastAssistantReply) {
              if (this._markPushed(conv.id, tr.lastAssistantReply.stepIndex)) stateDirty = true;
            }
            if (tr.lastError) {
              if (this._markPushed(conv.id, tr.lastError.stepIndex)) stateDirty = true;
            }
          }
        }
        this._initialized = true;
        if (stateDirty && typeof this.state?.save === 'function') {
          this.state.save();
        }
        return;
      }

      let cachedUi = null;
      let uiFetched = false;
      const getUiOnce = async () => {
        if (uiFetched) return cachedUi;
        uiFetched = true;
        if (!this.cdp || typeof this.cdp.getUiState !== 'function') return null;
        try {
          cachedUi = await this.cdp.getUiState();
        } catch {
          cachedUi = null;
        }
        return cachedUi;
      };

      for (const conv of conversations) {
        if (typeof this.state?.assignSeq === 'function') {
          const prevSeq = typeof this.state?.getSeq === 'function' ? this.state.getSeq(conv.id) : null;
          this.state.assignSeq(conv.id);
          if (!prevSeq) stateDirty = true;
        }

        if (!this._isWatched(conv.id)) continue;

        const tr = this.client.readTranscript(conv.id, { maxTurns: 6 });
        if (!tr?.exists) continue;

        const isTurnRunning =
          conv.isTurnRunning !== undefined
            ? Boolean(conv.isTurnRunning)
            : Boolean(conv.isRunning && !conv.notFullyIdle);

        const isDecisionPrompt = Boolean(
          tr.lastAssistantReply?.content && needsUserDecision(tr.lastAssistantReply.content),
        );

        const turnRepliesForCheck =
          Array.isArray(tr.currentTurnReplies) && tr.currentTurnReplies.length > 0
            ? tr.currentTurnReplies
            : tr.lastAssistantReply
              ? [tr.lastAssistantReply]
              : [];
        const hasAlreadyRepliedToCurrentUserInput = turnRepliesForCheck.some(
          r => r && this._hasPushed(conv.id, r.stepIndex),
        );

        // Suppress:
        // 1) Short interim blurbs right after a backgrounded run_command while still notFullyIdle;
        // 2) Subsequent automated schedule-timer patrol summaries when the user's latest prompt
        //    has ALREADY been answered (unless the patrol asks a decision question).
        // NEVER suppress the direct answer to a user's explicit USER_INPUT just because it also set a schedule timer!
        const isSuppressedBgCommand =
          Boolean(tr.lastAssistantReply?.afterBackgroundCommand) &&
          Boolean(conv.notFullyIdle) &&
          !isDecisionPrompt;
        const isSuppressedSchedulePatrol =
          Boolean(tr.lastAssistantReply?.afterScheduleTimer) &&
          Boolean(conv.notFullyIdle) &&
          hasAlreadyRepliedToCurrentUserInput &&
          !isDecisionPrompt;
        const isWaitingOnBgCommand = isSuppressedBgCommand || isSuppressedSchedulePatrol;

        // 1. Final assistant reply — emit when the current turn is IDLE (!isTurnRunning),
        // suppressing routine background-task/schedule patrol blurbs UNLESS the reply asks for a user decision.
        // Also merge any earlier unpushed substantive replies from the same turn (e.g. when a background
        // SYSTEM_MESSAGE woke the model for a short follow-up footnote right after a long answer).
        if (
          !isTurnRunning &&
          !isWaitingOnBgCommand &&
          tr.lastAssistantReply &&
          !this._hasPushed(conv.id, tr.lastAssistantReply.stepIndex)
        ) {
          this._clearPending(conv.id);
          const turnReplies = Array.isArray(tr.currentTurnReplies) && tr.currentTurnReplies.length > 0
            ? tr.currentTurnReplies
            : [tr.lastAssistantReply];
          const unpushedSubstantive = turnReplies.filter(
            r =>
              r &&
              r.content &&
              !this._hasPushed(conv.id, r.stepIndex) &&
              (!r.afterBackgroundCommand || r.stepIndex === tr.lastAssistantReply.stepIndex || needsUserDecision(r.content)),
          );
          const mergedText =
            unpushedSubstantive.length > 1
              ? unpushedSubstantive.map(r => r.content.trim()).filter(Boolean).join('\n\n')
              : tr.lastAssistantReply.content;

          if (Array.isArray(tr.recentTurns)) {
            for (const turn of tr.recentTurns) {
              if (turn.role === 'assistant' && turn.stepIndex < tr.lastAssistantReply.stepIndex) {
                this._markPushed(conv.id, turn.stepIndex);
              }
            }
          }
          for (const r of turnReplies) {
            if (r && r.stepIndex < tr.lastAssistantReply.stepIndex) {
              this._markPushed(conv.id, r.stepIndex);
            }
          }
          if (typeof this.onEvent === 'function') {
            await this.onEvent({
              type: 'reply',
              conversation: conv,
              stepIndex: tr.lastAssistantReply.stepIndex,
              text: mergedText,
              buttons: [],
            });
          }
          if (this._markPushed(conv.id, tr.lastAssistantReply.stepIndex)) stateDirty = true;
          continue;
        }

        // 2. Error step — only notify when the turn actually stopped (!isTurnRunning),
        // never spam transient mid-turn tool errors (e.g. edit_file mismatch) that the agent retries automatically.
        if (
          !isTurnRunning &&
          tr.lastError &&
          !this._hasPushed(conv.id, tr.lastError.stepIndex)
        ) {
          this._clearPending(conv.id);
          if (typeof this.onEvent === 'function') {
            await this.onEvent({
              type: 'error',
              conversation: conv,
              stepIndex: tr.lastError.stepIndex,
              text: tr.lastError.message,
              buttons: [],
            });
          }
          if (this._markPushed(conv.id, tr.lastError.stepIndex)) stateDirty = true;
          continue;
        }

        // 3. Pending tool / explicit approval or question wait (never guess by timeout!)
        if ((isTurnRunning || conv.isRunning) && tr.pendingToolCall) {
          const pendingKey = `${conv.id}:${tr.pendingToolCall.stepIndex}`;
          const isExplicitQuestion = /^ask_question$/i.test(tr.pendingToolCall.name);

          const ui = await getUiOnce();
          const cdpButtons = ui?.available && Array.isArray(ui.approvalButtons) ? ui.approvalButtons : [];
          const shouldNotify =
            !this._waitingNotified.has(pendingKey) &&
            (cdpButtons.length > 0 || isExplicitQuestion);

          if (shouldNotify) {
            this._waitingNotified.add(pendingKey);
            if (typeof this.onEvent === 'function') {
              await this.onEvent({
                type: 'waiting',
                conversation: conv,
                stepIndex: tr.pendingToolCall.stepIndex,
                text: isExplicitQuestion
                  ? formatAskQuestionText(tr.pendingToolCall)
                  : `工具 \`${tr.pendingToolCall.name}\` 等待确认（${cdpButtons.join(' / ')}）`,
                buttons: cdpButtons,
              });
            }
          }
        } else {
          this._clearPending(conv.id);
        }
      }

      if (stateDirty && typeof this.state?.save === 'function') {
        this.state.save();
      }
    } catch (error) {
      this.logger?.error?.('[AntigravityWatcher] pollOnce error:', error?.message || error);
    } finally {
      this._polling = false;
    }
  }
}
