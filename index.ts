// 2026-09-06 适配 openclaw 2026.9.1：根入口 plugin-sdk 已移除，改从聚焦子路径 core 导入
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { channelMeta, dlChannel, LOG_TAG } from "./src/channel.js";
import { setDLLogger, setDLRuntime, isRunStopped } from "./src/runtime.js";
import { loadPersonaBlock, currentPersonaAgent } from "./src/persona.js";

const meta = channelMeta;
// 2026-10-19：调试开关改为环境变量控制，不再依赖 package.json 的 isDebug（发布时容易忘改）。
// 开发环境设置 DLINKCLAW_DEBUG=1（或 true）即启用；生产/其他用户无此变量时自动关闭。
const isDebug = meta.isDebug; //process.env.DLINKCLAW_DEBUG === "1" || process.env.DLINKCLAW_DEBUG === "true";
if(isDebug){
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    process.env.NODE_ENV = 'dev';
}
const plugin = {
    id: meta.id,
    name: meta.label,
    description: meta.blurb,
    configSchema: emptyPluginConfigSchema(),
    register(api: OpenClawPluginApi) {
        setDLRuntime(api.runtime);
        setDLLogger(api.logger, LOG_TAG);
        api.registerChannel({
            plugin: dlChannel
        });
        // 2026-08-24 立即终止：客户端点“停止”（chat.abort）后，
        // services.ts 的 handlChatAbout 会标记该 runId 已停止，
        // 这里在每次工具调用前检查，命中则 block 后续工具调用，避免 agent 继续死钻牛角尖。
        // 注意：chat.abort 是协作式取消，无法打断正在执行的工具；此钩子确保“下一个”工具调用也被拦截。
        api.on('before_tool_call', (event, ctx) => {
            const channelId = meta.id;
            // 注：PluginHookToolContext 只有 channelId 字段（无 channel），与 before_prompt_build 的 ctx 不同
            if (ctx.channelId !== channelId) {
                return;
            }
            if (event.runId && isRunStopped(event.runId)) {
                return {
                    block: true,
                    blockReason: '用户已点击停止，任务终止执行'
                };
            }
            return;
        });

        // 2026-08-24 三条铁律：通过 before_prompt_build 钩子每轮强制注入系统提示（英文），
        // 对所有走 dlink 通道的 agent 生效，不依赖各 agent 的记忆/人工约定。
        // 铁律：1.歧义先问 2.失败即停 3.完成必报（发媒体后必须补文字确认，客户端靠它停止转圈）。
        // 只对 dlink 通道注入，避免影响其他通道的 agent。
        // 注：用 api.on 注册类型化钩子（registerHook 是单参数内部签名，无法返回提示注入）。
        api.on('before_prompt_build', async (_event, ctx) => {
            const channelId = meta.id;
            if (ctx.channel !== channelId && ctx.channelId !== channelId) {
                return;
            }
            const parts = [
                    '[AGENT CODE OF CONDUCT - ALWAYS FOLLOW]',
                    '1. ASK BEFORE GUESSING: If the task is incomplete or has multiple reasonable interpretations, send a one-line confirmation first. Never guess.',
                    '2. STOP ON FAILURE: If the same problem fails 2-3 times in a row, stop and report: "I am stuck: <reason>. Please advise." Never retry endlessly.',
                    '3. ALWAYS REPORT COMPLETION: Every task must end with a completion signal. After sending media/files, always follow up with a short text confirmation (e.g. "✅ Sent 3 files: a.png / b.pdf / c.txt"). The client shows a spinner until it receives the final text reply.',
                    // 2026-10-27 语言跟随：回复、过程文本、推理思考都使用用户当前消息的语言，不写死英文
                    '4. LANGUAGE: write your reply, any intermediate/progress text (tool narration, status lines, preamble), AND your reasoning/thinking in the same language as the user\'s latest message. Never default to English when the user writes in another language.',
            ];
            // 2026-10-26 人设注入：按 sessionKey 拉取该 agent 的人格与生效约定，失败则不注入
            const personaAgentId = currentPersonaAgent(ctx.sessionKey);
            if (!personaAgentId && String(ctx.sessionKey ?? '').includes(':group:')) {
                api.logger.warn(`persona group scope missing: session=${ctx.sessionKey}`);
            }
            const personaBlock = await loadPersonaBlock(ctx.sessionKey, personaAgentId);
            if (personaBlock) {
                parts.push(personaBlock);
            }
            return { prependSystemContext: parts.join('\n\n') };
        });
    }
};
export default plugin;