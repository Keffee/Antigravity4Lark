import { spawn } from 'node:child_process';

/**
 * Mask email-like strings so Feishu DLP (error 230028) does not block bot messages.
 */
export function sanitizeForFeishu(text) {
  return String(text || '').replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1[@]$2');
}

/**
 * Split long markdown into chunks bounded by maxLength, preferring newline boundaries.
 */
export function splitMarkdown(text, maxLength = 4000) {
  const value = String(text || '');
  const limit = Math.max(200, Number(maxLength) || 4000);
  if (value.length <= limit) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.4)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Wrapper around `lark-cli` for sending/replying markdown messages and consuming bot events.
 */
export class LarkClient {
  constructor(config, { spawnFn = spawn, logger = console } = {}) {
    this.config = config;
    this.spawnFn = spawnFn;
    this.logger = logger;
    this.cliEnv = {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    };
    this.consumer = null;
    this.keepAlive = null;
    this.reconnectTimer = null;
    this.closing = false;
    this.dryRunSeq = 0;
  }

  runLark(args) {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.config.larkCli, args, {
        env: this.cliEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `lark-cli exited ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.ok === false) {
            reject(new Error(parsed.msg || 'lark-cli returned ok=false'));
            return;
          }
          resolve(parsed.data || {});
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async sendChunk(args, safeText) {
    try {
      const data = await this.runLark(args);
      return data.message_id || null;
    } catch (err) {
      if (!/230028|sensitive data/i.test(err.message)) throw err;
      const fallbackArgs = [...args.slice(0, -1), safeText.replace(/@/g, ' [at] ')];
      const data = await this.runLark(fallbackArgs);
      return data.message_id || null;
    }
  }

  async sendMarkdown(text, { openId = this.config.feishuOpenId, onMessageId = null } = {}) {
    if (!openId) throw new Error('未配置 FEISHU_OPEN_ID，无法主动推送飞书消息');
    const chunks = splitMarkdown(text, this.config.maxPushLength);
    let firstId = null;
    for (const chunk of chunks) {
      const safeText = sanitizeForFeishu(chunk);
      let msgId;
      if (this.config.dryRun) {
        msgId = `dry-${Date.now()}-${++this.dryRunSeq}`;
        this.logger.log?.(`[干跑发送 ${msgId}] ${safeText}`);
      } else {
        const args = ['im', '+messages-send', '--as', 'bot', '--user-id', openId, '--markdown', safeText];
        msgId = await this.sendChunk(args, safeText);
      }
      if (!firstId && msgId) firstId = msgId;
      if (msgId && onMessageId) await onMessageId(msgId);
    }
    return firstId;
  }

  async replyMarkdown(replyToMsgId, text, { onMessageId = null } = {}) {
    if (!replyToMsgId) {
      return this.sendMarkdown(text, { onMessageId });
    }
    const chunks = splitMarkdown(text, this.config.maxPushLength);
    let firstId = null;
    for (const chunk of chunks) {
      const safeText = sanitizeForFeishu(chunk);
      let msgId;
      if (this.config.dryRun) {
        msgId = `dry-${Date.now()}-${++this.dryRunSeq}`;
        this.logger.log?.(`[干跑回复 ${msgId} -> ${replyToMsgId}] ${safeText}`);
      } else {
        const args = ['im', '+messages-reply', '--as', 'bot', '--message-id', replyToMsgId, '--markdown', safeText];
        msgId = await this.sendChunk(args, safeText);
      }
      if (!firstId && msgId) firstId = msgId;
      if (msgId && onMessageId) await onMessageId(msgId);
    }
    return firstId;
  }

  startConsumer(onEvent) {
    this.closing = false;
    const launch = () => {
      if (this.closing) return;
      this.keepAlive = this.spawnFn('tail', ['-f', '/dev/null'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.consumer = this.spawnFn(
        this.config.larkCli,
        ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
        {
          env: this.cliEnv,
          stdio: [this.keepAlive.stdout, 'pipe', 'pipe'],
        },
      );

      let buf = '';
      this.consumer.stdout?.on('data', chunk => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            Promise.resolve(onEvent(event)).catch(err => {
              this.logger.error?.('[飞书事件处理错误]', err.message);
            });
          } catch (err) {
            this.logger.error?.('[飞书事件 JSON 解析失败]', err.message);
          }
        }
      });

      this.consumer.stderr?.on('data', chunk => {
        const msg = chunk.toString('utf8').trim();
        if (msg) this.logger.log?.(msg);
      });

      this.consumer.on('error', err => {
        this.logger.error?.('[lark-cli 进程错误]', err.message);
      });

      this.consumer.on('close', code => {
        try { this.keepAlive?.kill(); } catch {}
        this.keepAlive = null;
        this.consumer = null;
        if (!this.closing) {
          this.logger.log?.(`飞书长连接断开 (code=${code})，3 秒后重连…`);
          this.reconnectTimer = setTimeout(launch, 3000);
        }
      });
    };

    launch();
  }

  stopConsumer() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.keepAlive?.kill(); } catch {}
    try { this.consumer?.kill('SIGTERM'); } catch {}
    this.keepAlive = null;
    this.consumer = null;
  }
}
