/**
 * CMD 消息处理器
 * 集成到 duolian 的消息处理流程中
 */

import { DLClient } from "../client/dl-client.js";
import { AskAgentReply, ClawServiceOptions, CmdMessage, CmdResponse, ReadlineType } from "./types.js";
import ClawServices from "./services.js";
import { PluginLogger } from "openclaw/plugin-sdk";

const AGENT_RELAY_MAP: Map<string, string> = new Map();
//const BATCH_COUNT = 10;
//const BATCH_TRAJECTORY_MAP: Map<string, Array<any>> = new Map();


/**
 * CMD 消息处理器
 */
export class CmdHandler {
  private readonly dlClient: DLClient;
  private services: ClawServices;
  private isInitialized = false;
  constructor(config: ClawServiceOptions, dlClient: DLClient, logger: PluginLogger) {
    this.dlClient = dlClient;
    this.services = new ClawServices(config, logger);
  }

  private log(msg: string, type: 'info' | 'warn' | 'error' | 'debug') {
    this.services.log(msg, type);
  }

  /**
   * 初始化处理器
   */
  async initialize(): Promise<boolean> {
    try {
      this.services.on('onTick', (payload) => {
        this.dlClient.publishEventToDLClient(payload, 'onTick', '0');
        //this.dlClient.publishEventToServer({ "connected": true }, "onConnectState")
      })

      this.services.on('onHeartbeat', (_payload) => {
        this.dlClient.publishEventToServer({ "connected": true }, "onConnectState")
      })

      this.services.on('onHealth', (payload) => {
        this.dlClient.publishEventToDLClient(payload, 'onHealth', '0')
      })

      this.services.on('onHandshaked', (payload) => {
        this.dlClient.publishEventToServer(payload, 'onHandshaked', '0')
      })

      this.services.on('onAgentReply', (payload) => {
        const message = payload as AskAgentReply;
        if (message.stream === 'lifecycle') {
          if (message.data.phase && message.data.phase === 'start') {
            AGENT_RELAY_MAP.set(message.runId, '');
          } else if (message.data.phase === 'end') {
            const content = AGENT_RELAY_MAP.get(message.runId);
            if (content && content.length > 0) {
              setTimeout(() => this.dlClient.publishEventToServer({
                runId: message.runId,
                sessionKey: message.sessionKey,   //运行的agent SessionKey
                content,
                spawnedBy: message.spawnedBy      //指派任务的agent SessionKey(通过消息协议入站执行agent.ask接口的该值为空)
              }, 'onAgentReply', '0'), 1000);
            }
            AGENT_RELAY_MAP.delete(message.runId);
          }
        } else if (message.stream === 'assistant') {
          if (AGENT_RELAY_MAP.has(message.runId)) {
            if (message.data.text && message.data.text.length > 0) {
              AGENT_RELAY_MAP.set(message.runId, message.data.text)
            }
          }
        }
      })

      // this.services.on('onAgentChat', (payload) => { 这个不需要了，会与onAgentReply上面重复
      //   if (!payload) return;
      //   if (payload.state === 'final') {
      //     setTimeout(() => this.dlClient.publishEventToServer({
      //       runId: payload.runId,
      //       sessionKey: payload.sessionKey,
      //       message: payload.message
      //     }, 'onAgentChat', '0'), 1000);
      //   }
      // });

      this.services.on('onSessionsChanged', (payload) => {
        // 2026-08-28 会话变更推送（直接推客户端）：
        // 原方案 publishEventToServer 走服务端 MQTT 转发，但服务端未定义 onSessionsChanged 接收端，事件会丢；
        // 且网关 sessions.changed 是全量快照(payload 大、每条消息都触发)，不宜走服务端转发。
        // 改为 publishEventToDLClient 直接推给 openUserTopics(客户端订阅的 chatTopic 集合，onTick/onHealth 同款通道)，
        // 并精简 payload 只保留会话上下文占用所需字段，避免快照体积。
        if (!payload) {
          return;
        }
        // 精简：丢弃全量快照，只保留客户端显示上下文占用百分比所需字段
        const slimPayload = {
          sessionKey: payload.sessionKey,
          totalTokens: payload.totalTokens,
          contextTokens: payload.contextTokens,
          totalTokensFresh: payload.totalTokensFresh,
          model: payload.model,
        };
        this.dlClient.publishEventToDLClient(slimPayload, 'onSessionsChanged', '0');
      })
      this.services.on('onSessionMessage', (payload) => {
        if (!payload) {
          return;
        }
        try {
          const sessionKey = payload.sessionKey;
          const message = payload.message;
          const role = message.role;
          if (role !== 'assistant') {
            return;
          }

          //this.log(`onSessionMessage >>> ${JSON.stringify(payload)}`, 'warn');

          const stopReason = message.stopReason;
          const content: any[] = message.content ?? [];
          const result_contents: Array<string> = content.map(item => {
            if (item.type === 'thinking') {
              return item.thinking;
            } else if (item.type === 'text' && stopReason != 'stop') { //stop应该是最终回复了，被免重复推送这里过滤掉(最终回复已在别处处理)
              return item.text
            }
            return ''
          })
          if (result_contents.length > 0) {
            const content = result_contents.join('').trim();
            if(content.length === 0){
              return;
            }
            const label: string | undefined = payload.origin.label || undefined;
            if (!label) {
              this.log(`不能StreamId...${label}`, 'error');
              this.dlClient.publishEventToServer({
                sessionKey,
                content,
              }, 'onAgentReply', '0')
              return;
            }
            if (label.includes('_')) {
              const streamId = label.split('_')[1]
              this.dlClient.publishProcessingState({
                streamId,
                content,
                kind: 'plan',
                status: 'read'
              })
            }
          }
        } catch (e) {
          this.log(`onSessionMessage 发生错误 >>> ${String(e)}`, 'info')
        }
      })

      this.services.on('onCron', (payload) => {
        this.dlClient.publishEventToServer(payload, 'onCron', '0')
      });

      this.services.on('onShutdown', (_payload) => {
        //TODO
      });

      this.services.on('onConnectState', (connected) => {
        this.dlClient.publishEventToServer({ "connected": connected }, "onConnectState")
      })

      this.services.on('onError', (error) => {
        this.dlClient.publishEventToServer({ "error": error }, "onError")
      })

      this.services.on('onPairingResult', data => this.dlClient.publishEventToServer(data, 'onPairingResult', '0'))

      await this.services.initialize();
      this.isInitialized = true;
      this.log('CMD 处理器初始化成功!', 'info');
      return true;
    } catch (error) {
      this.log('CMD 处理器初始化失败:' + String(error), 'error');
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 处理 CMD 消息
   */
  async handleCmdMessage(rawMessage: CmdMessage): Promise<CmdResponse> {
    if (!this.isInitialized || !this.services?.isReady()) {
      this.log('CMD 处理器未初始化，尝试重新初始化...', 'warn');
      const initialized = await this.initialize();
      if (!initialized) {
        return {
          success: false,
          error: 'CMD 处理器未初始化',
          timestamp: Date.now()
        };
      }
    }

    if (rawMessage.params?.message) {
      const logMessage = {
        ...rawMessage,
        params: {
          ...rawMessage.params,
          message: '...'
        }
      }
      this.log(`🔄CMD 指令:${rawMessage.cmd}, params=${JSON.stringify(logMessage)}`, 'info')
    } else {
      this.log(`🔄CMD 指令:${rawMessage.cmd}, params=${JSON.stringify(rawMessage)}`, 'info')
    }
    try {
      // 调用服务层处理
      return await this.services!.handleCmdMessage(rawMessage);
    } catch (error) {
      return {
        success: false,
        error: `cmd:[${rawMessage.cmd}]${error instanceof Error ? error.message : '处理失败'}`,
        timestamp: Date.now()
      };
    }
  }

  /**
   * 生成 CMD 响应消息（用于MQTT回复）
   */
  createCmdResponse(response: CmdResponse): any {
    return {
      type: 'cmd_response',
      requestId: response.requestId,
      success: response.success,
      data: response.data,
      error: response.error,
      timestamp: response.timestamp
    };
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.services.cleanup();
    this.isInitialized = false;
  }

  /**
   * 检查处理器是否就绪
   */
  isReady(): boolean {
    return this.isInitialized && (this.services?.isReady() || false);
  }
}

/**
 * 创建 CMD 处理器
 */
export function createCmdHandler(config: ClawServiceOptions, dlClient: DLClient, logger: PluginLogger): CmdHandler {
  return new CmdHandler(config, dlClient, logger);
}

